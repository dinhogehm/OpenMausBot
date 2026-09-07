/** The engine's observability, as pure functions: when a live run counts as
 * STUCK, the sentence that says so, the daily digest of a workflow's runs,
 * and the shape the health endpoint answers with. No I/O, no clock of its
 * own — the engine feeds `now` — so every rule here is table-testable and
 * the engine's tick only wires them to the store. */
import {
  WORKFLOW_APPROVAL_EXPIRES_DEFAULT_H,
  WORKFLOW_APPROVAL_RENOTIFY_DEFAULT,
  WORKFLOW_FAIL_OUTCOME,
  WORKFLOW_NODE_RETRIES_DEFAULT,
  WORKFLOW_STUCK_AFTER_DEFAULT_MIN,
  WORKFLOW_STUCK_ANNOUNCEMENTS_MAX,
  WORKFLOW_STUCK_APPROVAL_FACTOR,
  type Workflow,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowRunStatus,
} from "../shared/workflow.ts";

/** "3d 2h", "2h 6m", "48m", "under a minute" — what a person reads on a
 * phone, never a raw millisecond count. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

/** When the run entered its current node. Receipts written before the
 * engine stamped `nodeEnteredAt` fall back to the moment the previous node
 * finished (its result's end), then to the dispatch, then to the run's own
 * start — the latest honest instant, so an old receipt is never judged
 * stuck for time it spent on earlier nodes. */
export function nodeSince(run: WorkflowRun): number {
  if (run.nodeEnteredAt !== undefined) return run.nodeEnteredAt;
  const last = run.nodeResults[run.nodeResults.length - 1];
  return Math.max(last?.endedAt ?? 0, run.dispatchedAt ?? 0, run.startedAt);
}

/** Whether the run is sitting in an outage backoff RIGHT NOW: the wait's
 * end is recorded on the outage and is the run's pending `nextAttemptAt`.
 * A run parked for a busy bot after an outage still carries the outage
 * record but not this — it is waiting on a bot, which is exactly what the
 * watchdog exists to notice. */
export function inOutageBackoff(run: WorkflowRun): boolean {
  return run.outage?.waitUntil !== undefined && run.nextAttemptAt === run.outage.waitUntil;
}

/** How long a run may sit on `node` before the watchdog speaks, or null
 * when the node is exempt. A wait node's whole purpose is to sit, and its
 * timer is the tick's business; a run in a provider outage's backoff has a
 * horizon and two announcements of its own; a run whose pre-flight is
 * still running (or re-checking a busy bot) answers to the checks' own
 * clock; a human gate is judged
 * against its own expiry — the expiry sweep settles it at the deadline, so
 * a gate still open well past it is one the engine could not close. A gate
 * that asks AGAIN on expiry (`renotify`) is deliberately held open for
 * every round it allows, each one reaching the person on its own, so its
 * expiry is the whole budget: (rounds + 1) windows. */
export function stuckThresholdMs(workflow: Workflow, run: WorkflowRun, node: WorkflowNode | undefined): number | null {
  if (run.status === "waiting-approval") {
    const gate = node?.kind === "approval" ? node : undefined;
    const hours = gate?.expiresHours ?? WORKFLOW_APPROVAL_EXPIRES_DEFAULT_H;
    const windows = gate?.onExpire === "renotify" ? (gate.maxRenotify ?? WORKFLOW_APPROVAL_RENOTIFY_DEFAULT) + 1 : 1;
    return hours * windows * WORKFLOW_STUCK_APPROVAL_FACTOR * 3_600_000;
  }
  if (run.status !== "running") return null;
  if (node?.kind === "wait" || run.waitUntil !== undefined) return null;
  if (inOutageBackoff(run)) return null;
  // A run in pre-flight is waiting on its checks, not on a node: the checks
  // have a deadline of their own, a bounded wait for a busy bot, and a
  // terminal verdict that names the check — the health document lists the
  // run under `preflight`, never as stuck.
  if (run.preflightStartedAt !== undefined) return null;
  return (workflow.stuckAfterMinutes ?? WORKFLOW_STUCK_AFTER_DEFAULT_MIN) * 60_000;
}

export interface StuckVerdict {
  /** When the run entered the node it is stuck on. */
  since: number;
  /** How long it has been there. */
  forMs: number;
  /** The patience that was exceeded — also the re-announcement period. */
  thresholdMs: number;
}

/** Null unless the run has outstayed its threshold on its current node. */
export function stuckVerdict(workflow: Workflow, run: WorkflowRun, node: WorkflowNode | undefined, now: number): StuckVerdict | null {
  const thresholdMs = stuckThresholdMs(workflow, run, node);
  if (thresholdMs === null) return null;
  const since = nodeSince(run);
  const forMs = now - since;
  return forMs > thresholdMs ? { since, forMs, thresholdMs } : null;
}

/** Whether a stuck run is due an announcement: the first one as soon as it
 * is stuck, then at most one per further period — measured from the last
 * announcement, which is persisted, so a restart continues the cadence
 * rather than starting it over — and none at all once the stay has had
 * its cap of them. */
export function stuckAnnouncementDue(run: WorkflowRun, verdict: StuckVerdict, now: number): boolean {
  if ((run.stuckAnnouncements ?? 0) >= WORKFLOW_STUCK_ANNOUNCEMENTS_MAX) return false;
  return run.stuckNotifiedAt === undefined || now - run.stuckNotifiedAt >= verdict.thresholdMs;
}

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The last line of the receipt, as the announcement quotes it. */
function lastReceiptLine(run: WorkflowRun): string {
  const last = run.nodeResults[run.nodeResults.length - 1];
  if (!last) return "no step has finished yet";
  return clip(`last step ${last.nodeId}: ${last.outcome} — ${last.summary}`, 160);
}

/** What the run is doing on the node right now, in the engine's own terms:
 * the state a person would otherwise have to infer from the timeline. */
function nodeActivity(run: WorkflowRun, node: WorkflowNode | undefined, now: number): string {
  if (run.status === "waiting-approval") return "waiting for a decision";
  if (run.currentThreadId !== undefined && run.dispatchedAt !== undefined) {
    return `turn live for ${formatDuration(now - run.dispatchedAt)}`;
  }
  if (run.nextAttemptAt !== undefined) {
    return run.nextAttemptAt > now
      ? `next attempt in ${formatDuration(run.nextAttemptAt - now)}`
      : "waiting for the bot to be free";
  }
  return node === undefined ? "its node is gone from the workflow" : "no turn live";
}

/** The sentence the watchdog sends: node, how long, bot, attempt, what the
 * run is doing, and the last line of the receipt — everything a person
 * needs to decide between "let it be" and "cancel it" without opening the
 * app. Bodies are subject-less (`run stuck …`); the engine prefixes the
 * workflow's name for each channel. */
export function describeStuck(run: WorkflowRun, node: WorkflowNode | undefined, verdict: StuckVerdict, now: number): string {
  const nodeId = run.currentNodeId ?? "?";
  const details: string[] = [];
  if (node?.kind === "agent") {
    details.push(`bot "${run.currentBotId ?? node.botId}"`);
    details.push(`attempt ${run.attempt + 1} of ${(node.retries ?? WORKFLOW_NODE_RETRIES_DEFAULT) + 1}`);
  }
  details.push(nodeActivity(run, node, now));
  return `run stuck at node "${nodeId}" for ${formatDuration(verdict.forMs)} (${details.join(", ")}) — ${lastReceiptLine(run)}`;
}

// ── daily digest ──────────────────────────────────────────────────────

const minutesOfDay = (time: string): number => {
  const [hour, minute] = time.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
};

/** `HH:MM` on the civil day of `at`, shifted by `days` calendar days —
 * through the Date's own calendar (setDate), never by adding 24 hours: on
 * the day a DST clock falls back or springs forward, "yesterday at 18:00"
 * is 25 or 23 hours away, and a 24-hour subtraction would land on 19:00
 * or 17:00 — a different instant than the slot that was sent, which the
 * sweep would then send again. */
function clockOnDay(digestAt: string, at: number, days: number): number {
  const minutes = minutesOfDay(digestAt);
  const day = new Date(at);
  day.setDate(day.getDate() + days);
  day.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return day.getTime();
}

/** The most recent `HH:MM` (local wall clock) at or before `now`: today's
 * slot when it has passed, otherwise yesterday's. The digest fires when
 * this instant is newer than the last one sent, so a computer that slept
 * through a slot sends ONE digest on waking, covering the day up to the
 * slot it missed — never one per day missed. */
export function digestSlotAt(digestAt: string, now: number): number {
  const slot = clockOnDay(digestAt, now, 0);
  return slot <= now ? slot : clockOnDay(digestAt, now, -1);
}

/** The slot one civil day before `slot`: where the digest's window starts.
 * A DST day's window is 23 or 25 hours long, so that no run ended between
 * two digests is counted twice or not at all. */
export function digestWindowStart(digestAt: string, slot: number): number {
  return clockOnDay(digestAt, slot, -1);
}

const pad = (value: number) => String(value).padStart(2, "0");
const localDate = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** Top entries of a tally, most frequent first, ties by name. */
function topOf(tally: Map<string, number>, max: number): string[] {
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([name, count]) => `${name} ×${count}`);
}

/** One paragraph over the runs that ENDED inside [from, to): how many and
 * how they ended, the mean time of the completed ones, the nodes that
 * failed most (a `failed` edge taken, or the node a failed run stopped
 * on), and the denials seen most — the grant a person should add. A day
 * with nothing to report still says so: for a 24/7 pipeline, silence and
 * "nothing happened" are different news. The window is "since the
 * previous digest", which the text calls a day — true to the hour except
 * on a DST day. */
export function buildDigest(runs: readonly WorkflowRun[], from: number, to: number): string {
  const ended = runs.filter((run) => run.endedAt !== undefined && run.endedAt >= from && run.endedAt < to);
  const day = localDate(to);
  if (ended.length === 0) return `daily digest for ${day}: no run ended since the previous digest`;
  const count = (status: WorkflowRunStatus) => ended.filter((run) => run.status === status).length;
  const completed = ended.filter((run) => run.status === "completed");
  const parts: string[] = [
    `${ended.length} run${ended.length === 1 ? "" : "s"} ended since the previous digest — ${count("completed")} completed, ${count("failed")} failed, ${count("cancelled")} cancelled`,
  ];
  if (completed.length > 0) {
    const mean = completed.reduce((sum, run) => sum + ((run.endedAt ?? run.startedAt) - run.startedAt), 0) / completed.length;
    parts.push(`average run time ${formatDuration(mean)}`);
  }
  const failedNodes = new Map<string, number>();
  const denials = new Map<string, number>();
  for (const run of ended) {
    for (const result of run.nodeResults) {
      if (result.outcome === WORKFLOW_FAIL_OUTCOME) failedNodes.set(result.nodeId, (failedNodes.get(result.nodeId) ?? 0) + 1);
      for (const line of result.denials ?? []) {
        const key = clip(line, 80);
        denials.set(key, (denials.get(key) ?? 0) + 1);
      }
    }
    if (run.status === "failed" && run.currentNodeId !== undefined) {
      failedNodes.set(run.currentNodeId, (failedNodes.get(run.currentNodeId) ?? 0) + 1);
    }
  }
  if (failedNodes.size > 0) parts.push(`nodes that failed most: ${topOf(failedNodes, 3).join(", ")}`);
  if (denials.size > 0) parts.push(`denials seen most: ${topOf(denials, 3).join("; ")}`);
  return `daily digest for ${day}: ${parts.join("; ")}`;
}

// ── health ────────────────────────────────────────────────────────────

/** What an external monitor polls. Every field is either a count, an epoch
 * millisecond or a short string, so the shape can be asserted field by
 * field and never carries a transcript or a prompt. */
export interface WorkflowEngineHealth {
  /** False while any run is stuck — the one bit a probe alerts on. */
  ok: boolean;
  version: string;
  now: number;
  engine: {
    startedAt: number;
    uptimeMs: number;
    /** The last completed reconciler pass; null before the first. A probe
     * that sees this fall behind `now` by minutes has found a wedged tick. */
    lastTickAt: number | null;
  };
  runs: {
    live: number;
    queued: number;
    running: number;
    waitingApproval: number;
    stuck: WorkflowStuckRunHealth[];
    /** Runs whose pre-flight checks are running or re-checking a busy bot:
     * live, exempt from the watchdog, and worth a monitor's own column —
     * a pipeline that never gets past its checks is not stuck, it is being
     * refused, and the receipts say by which check. */
    preflight: WorkflowPreflightRunHealth[];
  };
  /** The most recent failed run across every workflow, or null. */
  lastFailure: WorkflowFailureHealth | null;
  workflows: WorkflowHealth[];
}

export interface WorkflowStuckRunHealth {
  runId: string;
  workflowId: string;
  workflowName: string;
  nodeId: string | null;
  status: WorkflowRunStatus;
  since: number;
  stuckForMs: number;
  attempt: number;
  lastNotifiedAt: number | null;
}

export interface WorkflowPreflightRunHealth {
  runId: string;
  workflowId: string;
  workflowName: string;
  /** The node the checks guard. */
  nodeId: string | null;
  /** When the FIRST check started — the clock a busy-bot wait is budgeted
   * against. */
  since: number;
  inPreflightForMs: number;
  /** True once a verdict came back transient (busy bots) and the run is
   * parked for a re-check; false while the checks themselves are running. */
  waitingForBot: boolean;
}

export interface WorkflowFailureHealth {
  runId: string;
  workflowId: string;
  workflowName: string;
  nodeId: string | null;
  at: number;
  error: string | null;
}

export interface WorkflowHealth {
  id: string;
  name: string;
  schedule: "daily" | "once" | "interval" | null;
  /** The armed instant, or null when nothing is armed (no schedule, a
   * spent `once`, or an interval held while a run is live). */
  nextRunAt: number | null;
  liveRunId: string | null;
  liveRunStatus: WorkflowRunStatus | null;
  lastRun: { id: string; status: WorkflowRunStatus; endedAt: number | null } | null;
  lastFailure: WorkflowFailureHealth | null;
  digestAt: string | null;
  lastDigestAt: number | null;
  auditGroupId: string | null;
  /** Consecutive starts the engine refused, or null: the reason the
   * interval trigger is backing off, for a monitor to show. */
  refusalStreak: { count: number; since: number; lastReason: string } | null;
}

const LIVE: ReadonlySet<WorkflowRunStatus> = new Set(["queued", "running", "waiting-approval"]);

function failureOf(workflow: Workflow, run: WorkflowRun): WorkflowFailureHealth {
  return {
    runId: run.id,
    workflowId: run.workflowId,
    workflowName: workflow.name,
    nodeId: run.currentNodeId ?? null,
    at: run.endedAt ?? run.startedAt,
    error: run.error ?? null,
  };
}

export function workflowEngineHealth(input: {
  version: string;
  now: number;
  startedAt: number;
  lastTickAt: number | null;
  workflows: readonly Workflow[];
  runs: readonly WorkflowRun[];
  stuck: ReadonlyArray<{ run: WorkflowRun; verdict: StuckVerdict }>;
}): WorkflowEngineHealth {
  const { version, now, startedAt, lastTickAt, workflows, runs, stuck } = input;
  const byWorkflow = new Map(workflows.map((workflow) => [workflow.id, workflow] as const));
  const nameOf = (workflowId: string) => byWorkflow.get(workflowId)?.name ?? workflowId;
  const count = (status: WorkflowRunStatus) => runs.filter((run) => run.status === status).length;
  let lastFailure: WorkflowFailureHealth | null = null;
  const rows: WorkflowHealth[] = workflows.map((workflow) => {
    const own = runs.filter((run) => run.workflowId === workflow.id);
    const live = own.find((run) => LIVE.has(run.status)) ?? null;
    // Receipts list newest first (by start); the latest END is the honest
    // "last run" for a monitor, and the same for the last failure.
    const ended = own.filter((run) => run.endedAt !== undefined).sort((a, b) => b.endedAt! - a.endedAt!);
    const last = ended[0] ?? null;
    const failed = ended.find((run) => run.status === "failed");
    const failure = failed === undefined ? null : failureOf(workflow, failed);
    if (failure && (lastFailure === null || failure.at > lastFailure.at)) lastFailure = failure;
    return {
      id: workflow.id,
      name: workflow.name,
      schedule: workflow.triggers?.schedule?.type ?? null,
      nextRunAt: typeof workflow.nextRunAt === "number" ? workflow.nextRunAt : null,
      liveRunId: live?.id ?? null,
      liveRunStatus: live?.status ?? null,
      lastRun: last === null ? null : { id: last.id, status: last.status, endedAt: last.endedAt ?? null },
      lastFailure: failure,
      digestAt: workflow.digestAt ?? null,
      lastDigestAt: workflow.lastDigestAt ?? null,
      auditGroupId: workflow.auditGroupId ?? null,
      refusalStreak: workflow.refusalStreak ?? null,
    };
  });
  return {
    ok: stuck.length === 0,
    version,
    now,
    engine: { startedAt, uptimeMs: Math.max(0, now - startedAt), lastTickAt },
    runs: {
      live: runs.filter((run) => LIVE.has(run.status)).length,
      queued: count("queued"),
      running: count("running"),
      waitingApproval: count("waiting-approval"),
      stuck: stuck.map(({ run, verdict }) => ({
        runId: run.id,
        workflowId: run.workflowId,
        workflowName: nameOf(run.workflowId),
        nodeId: run.currentNodeId ?? null,
        status: run.status,
        since: verdict.since,
        stuckForMs: verdict.forMs,
        attempt: run.attempt,
        lastNotifiedAt: run.stuckNotifiedAt ?? null,
      })),
      preflight: runs
        .filter((run) => run.status === "running" && run.preflightStartedAt !== undefined)
        .map((run) => ({
          runId: run.id,
          workflowId: run.workflowId,
          workflowName: nameOf(run.workflowId),
          nodeId: run.currentNodeId ?? null,
          since: run.preflightStartedAt!,
          inPreflightForMs: Math.max(0, now - run.preflightStartedAt!),
          waitingForBot: run.nextAttemptAt !== undefined,
        })),
    },
    lastFailure,
    workflows: rows,
  };
}
