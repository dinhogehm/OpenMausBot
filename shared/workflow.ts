/** Pure workflow model shared by the server engine and the renderer canvas.
 * The same validator must refuse persistence and paint inline badges, so it
 * lives here with no I/O and no environment assumptions. */

export const WORKFLOW_CONTROL_OPEN = "<openmaus-workflow>";
export const WORKFLOW_CONTROL_CLOSE = "</openmaus-workflow>";
/** Reserved routing outcome. Every agent node can fail without declaring it,
 * so the engine always has a deterministic path for exhausted retries. */
export const WORKFLOW_FAIL_OUTCOME = "failed";
export const WORKFLOW_APPROVAL_OUTCOMES = ["approved", "rejected"] as const;
export const WORKFLOW_NOTIFY_OUTCOME = "sent";
export const WORKFLOW_NODE_TIMEOUT_DEFAULT_MIN = 30;
export const WORKFLOW_NODE_RETRIES_DEFAULT = 2;
/** Cycles are legal by design (review loops); this cap is what keeps a
 * miswired loop from running a workflow forever. */
export const WORKFLOW_MAX_NODE_EXECUTIONS = 30;
export const WORKFLOW_APPROVAL_EXPIRES_DEFAULT_H = 24;
/** A provider outage (5xx, a 404 from the provider's own backend, rate
 * limiting, a dropped connection, an engine process dying before it
 * answered) is waited out rather than retried: the run parks with a
 * doubling backoff (1, 2, 4, 8 … minutes) that never spends one of the
 * node's attempts, capped per wait at this many minutes by default and
 * given up on — through the ordinary failure path — once the outage has
 * lasted longer than the horizon. Both knobs live on the workflow. */
export const WORKFLOW_OUTAGE_BACKOFF_CAP_DEFAULT_MIN = 60;
export const WORKFLOW_OUTAGE_HORIZON_DEFAULT_H = 6;
/** A scheduled run more than this late (the computer was asleep or the app
 * closed past the slot) is recorded as missed, never executed late — the
 * same 12-hour catch-up window routines use. */
export const WORKFLOW_SCHEDULE_CATCH_UP_MS = 12 * 60 * 60_000;
/** 24-hour wall-clock time for a daily schedule; shared with the API schema
 * so the door and the validator agree on what the scheduler can arm. */
export const WORKFLOW_SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** What a person may allow a bot to do beyond its ordinary tools. A node
 * declares what it `requires`; a run only dispatches it on a bot carrying
 * the matching flag, re-read at every dispatch so a permission revoked
 * mid-run stops the run at the next node that needs it. */
export const WORKFLOW_CAPABILITIES = ["merge", "deploy"] as const;
export type WorkflowCapability = (typeof WORKFLOW_CAPABILITIES)[number];

/** The per-bot flags as the bot record and the wire carry them. Undefined
 * means false: a permission nobody granted is not a permission. */
export interface BotCapabilities {
  canMerge?: boolean;
  canDeploy?: boolean;
}

const CAPABILITY_FLAG: Record<WorkflowCapability, keyof BotCapabilities> = { merge: "canMerge", deploy: "canDeploy" };
const isWorkflowCapability = (value: unknown): value is WorkflowCapability =>
  (WORKFLOW_CAPABILITIES as readonly unknown[]).includes(value);

export type WorkflowNode =
  | {
      kind: "agent";
      id: string;
      botId: string;
      instructions: string;
      outcomes: string[];
      timeoutMinutes?: number;
      retries?: number;
      /** Capabilities the bot must carry for this node to be dispatched. */
      requires?: WorkflowCapability[];
      /** A second bot the engine may hand this node to — once per provider
       * outage, and only when that bot runs on a DIFFERENT model engine
       * than `botId` (a fallback on the same provider would be down too),
       * is free, and carries every capability in `requires`. */
      fallbackBotId?: string;
    }
  | { kind: "approval"; id: string; prompt: string; expiresHours?: number; onExpire?: "approved" | "rejected" }
  | { kind: "notify"; id: string; targetGroupId: string; template: string };

export interface WorkflowEdge {
  from: string;
  outcome: string;
  to: string;
}

/** Structurally identical to a routine's schedule so the engine can borrow
 * the routine scheduler's occurrence math: local timezone, `daily` at HH:MM
 * on the given weekdays (0 = Sunday), `once` at an epoch-ms instant. */
export type WorkflowSchedule = { type: "daily"; time: string; weekdays: number[] } | { type: "once"; at: number };

/** Webhooks are not listed here: a webhook owns its link to a workflow
 * (`workflowId` on the webhook), so a workflow has nothing to keep in sync. */
export interface WorkflowTriggers {
  schedule?: WorkflowSchedule;
}

/** How long a run waits out a provider outage. Both optional; the defaults
 * above apply to an absent field so a definition saved before this existed
 * behaves exactly as one that never set it. */
export interface WorkflowProviderOutage {
  /** The longest single wait between two attempts, in minutes. */
  maxBackoffMinutes?: number;
  /** Give up — through the node's ordinary failure path — once the outage
   * has lasted this long, in hours. */
  horizonHours?: number;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  entryNodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout: Record<string, { x: number; y: number }>;
  triggers?: WorkflowTriggers;
  maxNodeExecutions?: number;
  providerOutage?: WorkflowProviderOutage;
  /** Engine-owned timing state for `triggers.schedule`, in three states:
   * `undefined` — not armed yet, so the engine computes the first slot;
   * a number — the instant the schedule next fires;
   * `null` — deliberately DISARMED (a `once` that already fired, or a clock
   * left behind by a deleted schedule), which the engine never re-arms.
   * Editing the schedule puts the field back to `undefined`, which is what
   * asks for a fresh arm. Never settable by a client — the API strips it. */
  nextRunAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkflowRunStatus = "queued" | "running" | "waiting-approval" | "completed" | "failed" | "cancelled";

export type WorkflowRunTrigger = "manual" | "schedule" | "webhook";

/** Why the engine is calling notifyUser: a run paused on a terminal failure,
 * an approval gate opened, or that gate's single reminder. */
export type WorkflowNotificationKind = "failed" | "approval" | "reminder";

export interface WorkflowNodeResult {
  nodeId: string;
  outcome: string;
  summary: string;
  threadId?: string;
  startedAt: number;
  endedAt: number;
  /** Present when the node's bot was unreachable and the result came from
   * its fallback bot instead: who ran it and the provider error that made
   * the engine switch. A receipt that says "done" must also say by whom. */
  fallback?: WorkflowFallbackRecord;
}

export interface WorkflowFallbackRecord {
  botId: string;
  because: string;
}

/** A run waiting out a provider outage on its current node. `attempts`
 * counts the waits taken so far and `of` how many the horizon allows on
 * the nominal (jitter-free) schedule — what the UI prints as "attempt Y of
 * Z"; the wait itself is the run's ordinary `nextAttemptAt`, so the
 * reconciler's due-dispatch and crash recovery need no special case. */
export interface WorkflowOutage {
  /** When the first outage-class failure of this node was seen. */
  since: number;
  /** since + the workflow's horizon: no attempt is scheduled past it. */
  until: number;
  attempts: number;
  of: number;
  /** The provider error, redacted and bounded, for the UI and the receipt. */
  reason: string;
  /** Set once the node was handed to its fallback bot during THIS outage,
   * so the hand-off happens at most once per outage. */
  fallbackBotId?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  /** What started this run; the UI timeline shows it, so it must survive a
   * restart. Optional so pre-existing receipts load unchanged. */
  trigger?: WorkflowRunTrigger;
  /** workflowRoutingFingerprint of the definition this run was planned
   * against, stamped when the run starts (and re-stamped when a queued run
   * is promoted or a failed one resumed). Definitions persist as drafts, so
   * the graph can change under a live run; this is what lets the engine tell
   * "this node is a deliberate sink" from "the rest of the workflow was
   * deleted while I was running". Optional so pre-existing receipts load
   * unchanged. */
  routingFingerprint?: string;
  /** The webhook (and its delivery) that started a "webhook" run, so the
   * webhook's pending cap and its pause/delete cancellation can find the
   * runs it owns. */
  webhookId?: string;
  deliveryId?: string;
  currentNodeId?: string;
  /** Task thread where the current node is executing (engine bookkeeping). */
  currentThreadId?: string;
  /** The bot the current node's live dispatch is on. Normally the node's own
   * bot, and absent on receipts written before fallbacks existed; set to
   * the fallback bot while it holds the node, so an interrupt, a timeout or
   * a re-prompt reaches the bot actually working and not the one that was
   * unreachable (engine bookkeeping). */
  currentBotId?: string;
  /** Present while the run waits out a provider outage on its current node
   * (engine bookkeeping; cleared when the node advances or fails for a
   * reason that is not the outage). */
  outage?: WorkflowOutage;
  /** When the current node's turn was dispatched (engine bookkeeping). */
  dispatchedAt?: number;
  /** Set once the engine has re-prompted the current node for a missing or
   * invalid outcome envelope; a second miss fails the run. Cleared on every
   * fresh node dispatch, so each node gets exactly one re-prompt. */
  repromptedAt?: number;
  /** Attempt counter for the current node only; resets when the run advances. */
  attempt: number;
  /** When the reconciler should next try dispatching the current node — set
   * both for retry backoff and while waiting for a busy bot to free up. */
  nextAttemptAt?: number;
  /** When the current approval gate opened; the expiry and reminder clocks
   * run from it, so it must survive a restart (engine bookkeeping). */
  approvalRequestedAt?: number;
  /** Set once the gate's single mid-window reminder went out (engine bookkeeping). */
  approvalRemindedAt?: number;
  input: string;
  nodeResults: WorkflowNodeResult[];
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** The line the UI prints while a run waits out a provider outage, and the
 * receipt's wording when the wait ends in a failure. Null when the run is
 * not waiting. Shared so the canvas and the engine say it the same way. */
export function workflowOutageWaitMessage(
  run: Pick<WorkflowRun, "outage" | "nextAttemptAt">,
  formatWhen: (at: number) => string,
): string | null {
  const { outage, nextAttemptAt } = run;
  if (!outage || nextAttemptAt === undefined) return null;
  return `Waiting for the provider: next attempt ${formatWhen(nextAttemptAt)} (attempt ${outage.attempts} of ${outage.of})`;
}

/** Every outcome the engine may route on for a node — declared ones plus the
 * kind's implicit ones. Agent nodes always carry the reserved failure path. */
export function nodeOutcomes(node: WorkflowNode): string[] {
  switch (node.kind) {
    case "agent":
      return [...node.outcomes, WORKFLOW_FAIL_OUTCOME];
    case "approval":
      return [...WORKFLOW_APPROVAL_OUTCOMES];
    case "notify":
      return [WORKFLOW_NOTIFY_OUTCOME];
  }
}

/** Two 32-bit FNV-1a passes with different multipliers, hex-joined: a
 * 64-bit-wide digest with no crypto dependency, so the same function runs in
 * the renderer and the server. */
function hash64(text: string): string {
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193);
    high = Math.imul(high ^ code, 0x85ebca6b);
  }
  return (low >>> 0).toString(16).padStart(8, "0") + (high >>> 0).toString(16).padStart(8, "0");
}

/** Identity of everything that decides WHERE A RUN CAN GO NEXT: the entry,
 * each node's id, kind and routable outcomes, and every edge. Deliberately
 * NOT the layout, name, description, triggers or execution knobs — a canvas
 * that autosaves the whole document on a node drag must be invisible to a
 * run in flight, while an edge or an outcome disappearing under it must not
 * be. Everything is sorted before serializing, so node order, edge order and
 * outcome order cannot produce a false difference; the result is hashed
 * because it is stamped on every run receipt. */
export function workflowRoutingFingerprint(workflow: Workflow): string {
  const nodes = workflow.nodes
    .map((node) => JSON.stringify([node.id, node.kind, [...nodeOutcomes(node)].sort()]))
    .sort();
  const edges = workflow.edges.map((edge) => JSON.stringify([edge.from, edge.outcome, edge.to])).sort();
  return hash64(JSON.stringify([workflow.entryNodeId, nodes, edges]));
}

export interface ParsedWorkflowOutcome {
  outcome: string;
  summary: string;
}

const bounded = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** Keep the routing envelope out of human hands and model prose alike. The
 * last complete envelope wins: a quoted example earlier in the reply cannot
 * accidentally steer the run. */
export function parseWorkflowOutcome(text: string, allowed: string[]): ParsedWorkflowOutcome | null {
  const closeAt = text.lastIndexOf(WORKFLOW_CONTROL_CLOSE);
  const openAt = closeAt < 0 ? -1 : text.lastIndexOf(WORKFLOW_CONTROL_OPEN, closeAt);
  if (openAt < 0) return null;

  const payload = text.slice(openAt + WORKFLOW_CONTROL_OPEN.length, closeAt).trim();
  try {
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const outcome = bounded(raw.outcome, 100);
    const summary = bounded(raw.summary, 2_000);
    if (!outcome || !summary || !allowed.includes(outcome)) return null;
    return { outcome, summary };
  } catch {
    // A malformed control envelope is never a guessable routing decision;
    // the engine treats null as the node's failure path.
  }
  return null;
}

export interface WorkflowIssue {
  severity: "error" | "warning";
  code:
    | "bad-entry"
    | "duplicate-node-id"
    | "duplicate-edge"
    | "dangling-edge"
    | "unknown-outcome"
    | "bad-outcomes"
    | "unwired-outcome"
    | "unwired-failure"
    | "unreachable"
    | "reserved-outcome"
    | "bad-numbers"
    | "bad-schedule"
    | "bad-requires"
    | "missing-capability"
    | "fallback-same-bot"
    | "fallback-missing-bot"
    | "fallback-missing-capability";
  nodeId?: string;
  message: string;
}

/** Structural validation only. Errors gate EXECUTION, not persistence: a
 * half-drawn draft always saves (so work in progress survives a restart) and
 * the canvas shows every issue inline, while the engine refuses to start a
 * run of a workflow carrying any error. A node with zero wired outcomes is a
 * deliberate terminal sink; wiring some outcomes but not all is a mistake.
 * Determinism is the invariant: every routable outcome has at most one
 * successor, and only edges the engine can actually take count as reachable. */
export function validateWorkflow(workflow: Workflow): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];

  const nodeById = new Map<string, WorkflowNode>();
  for (const node of workflow.nodes) {
    if (nodeById.has(node.id)) {
      issues.push({
        severity: "error",
        code: "duplicate-node-id",
        nodeId: node.id,
        message: `Duplicate node id "${node.id}".`,
      });
      continue;
    }
    nodeById.set(node.id, node);
  }

  for (const node of workflow.nodes) {
    if (node.kind !== "agent") continue;
    if (node.outcomes.includes(WORKFLOW_FAIL_OUTCOME)) {
      issues.push({
        severity: "error",
        code: "reserved-outcome",
        nodeId: node.id,
        message: `Outcome "${WORKFLOW_FAIL_OUTCOME}" is reserved; every agent node already has it implicitly.`,
      });
    }
    if (node.outcomes.length === 0) {
      issues.push({
        severity: "error",
        code: "bad-outcomes",
        nodeId: node.id,
        message: `Node "${node.id}" declares no outcomes; an agent node needs at least one.`,
      });
    }
    const declared = new Set<string>();
    for (const outcome of node.outcomes) {
      if (!outcome.trim()) {
        issues.push({
          severity: "error",
          code: "bad-outcomes",
          nodeId: node.id,
          message: `Node "${node.id}" declares a blank outcome name.`,
        });
      } else if (outcome !== outcome.trim()) {
        // The outcome parser trims names before matching, so a padded
        // declaration is a route the model could never take.
        issues.push({
          severity: "error",
          code: "bad-outcomes",
          nodeId: node.id,
          message: `Node "${node.id}" outcome "${outcome}" has surrounding whitespace the parser strips; it can never be routed.`,
        });
      } else if (outcome.length > 100) {
        // The outcome parser bounds names at 100 chars, so a longer
        // declaration is a route the model could never take.
        issues.push({
          severity: "error",
          code: "bad-outcomes",
          nodeId: node.id,
          message: `Node "${node.id}" outcome "${outcome.slice(0, 24)}…" is longer than 100 chars and can never be parsed.`,
        });
      }
      if (declared.has(outcome)) {
        issues.push({
          severity: "error",
          code: "bad-outcomes",
          nodeId: node.id,
          message: `Node "${node.id}" declares outcome "${outcome}" more than once.`,
        });
      }
      declared.add(outcome);
    }
    // `requires` gates a dispatch on the bot's flags: a name outside the
    // known set could never be granted, a repeat is a typo the canvas should
    // show, and a non-list is what a raw JSON body may carry in its place.
    if (node.requires !== undefined) {
      const badRequires = (message: string) => {
        issues.push({ severity: "error", code: "bad-requires", nodeId: node.id, message });
      };
      const requires: unknown = node.requires;
      const known = WORKFLOW_CAPABILITIES.join(", ");
      if (!Array.isArray(requires)) {
        badRequires(`Node "${node.id}" requires must be a list of capabilities (${known}).`);
      } else {
        const seen = new Set<WorkflowCapability>();
        for (const capability of requires) {
          if (!isWorkflowCapability(capability)) {
            badRequires(`Node "${node.id}" requires an unknown capability "${String(capability)}"; known ones are ${known}.`);
          } else if (seen.has(capability)) {
            badRequires(`Node "${node.id}" requires "${capability}" more than once.`);
          } else {
            seen.add(capability);
          }
        }
      }
    }
    // A fallback is only a fallback if it is somebody else: the same bot
    // would be re-dispatched on the same unreachable provider, which is
    // what the outage backoff already does without the pretence. Whether
    // the bot EXISTS is the roster's business (capabilityIssues); a blank
    // id is the same shape mistake as a blank outcome name.
    if (node.fallbackBotId !== undefined) {
      if (typeof node.fallbackBotId !== "string" || !node.fallbackBotId.trim()) {
        issues.push({
          severity: "error",
          code: "fallback-missing-bot",
          nodeId: node.id,
          message: `Node "${node.id}" names a blank fallback bot.`,
        });
      } else if (node.fallbackBotId === node.botId) {
        issues.push({
          severity: "error",
          code: "fallback-same-bot",
          nodeId: node.id,
          message: `Node "${node.id}" names its own bot "${node.botId}" as the fallback; a fallback has to be a different bot.`,
        });
      }
    }
  }

  // Numeric knobs feed timers and counters directly: a zero or negative
  // window is an instant expiry, a NaN never compares, a fractional retry
  // count never reaches its limit. Reject anything the engine could not
  // honour — including the string a raw JSON body may carry in a number's place.
  const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;
  const whole = (value: unknown, min: number) => typeof value === "number" && Number.isInteger(value) && value >= min;
  const badNumber = (message: string, nodeId?: string) => {
    issues.push({ severity: "error", code: "bad-numbers", ...(nodeId === undefined ? {} : { nodeId }), message });
  };
  if (workflow.maxNodeExecutions !== undefined && !whole(workflow.maxNodeExecutions, 1)) {
    badNumber("maxNodeExecutions must be a whole number of at least 1.");
  }
  // The outage knobs feed a backoff clock: a zero cap is a busy loop, a
  // zero horizon gives up on the first hiccup — neither is "waiting".
  const outage: unknown = workflow.providerOutage;
  if (outage !== undefined) {
    if (typeof outage !== "object" || outage === null || Array.isArray(outage)) {
      badNumber("providerOutage must be an object with maxBackoffMinutes and/or horizonHours.");
    } else {
      const { maxBackoffMinutes, horizonHours } = outage as WorkflowProviderOutage;
      if (maxBackoffMinutes !== undefined && !positive(maxBackoffMinutes)) {
        badNumber("providerOutage.maxBackoffMinutes must be a positive number.");
      }
      if (horizonHours !== undefined && !positive(horizonHours)) {
        badNumber("providerOutage.horizonHours must be a positive number.");
      }
    }
  }
  for (const node of workflow.nodes) {
    if (node.kind === "agent") {
      if (node.timeoutMinutes !== undefined && !positive(node.timeoutMinutes)) {
        badNumber(`Node "${node.id}" timeoutMinutes must be a positive number.`, node.id);
      }
      if (node.retries !== undefined && !whole(node.retries, 0)) {
        badNumber(`Node "${node.id}" retries must be a whole number of zero or more.`, node.id);
      }
    } else if (node.kind === "approval" && node.expiresHours !== undefined && !positive(node.expiresHours)) {
      badNumber(`Node "${node.id}" expiresHours must be a positive number.`, node.id);
    }
  }

  // A schedule the scheduler could not arm must never be persisted: a
  // malformed time never matches a wall clock, an empty weekday set never
  // fires, a day outside 0..6 is a slot that does not exist.
  const schedule = workflow.triggers?.schedule;
  if (schedule) {
    const badSchedule = (message: string) => {
      issues.push({ severity: "error", code: "bad-schedule", message });
    };
    if (schedule.type === "daily") {
      if (typeof schedule.time !== "string" || !WORKFLOW_SCHEDULE_TIME_RE.test(schedule.time)) {
        badSchedule("Schedule time must be HH:MM (24-hour).");
      }
      const weekdays: unknown = schedule.weekdays;
      if (!Array.isArray(weekdays) || weekdays.length === 0) {
        badSchedule("Schedule needs at least one weekday.");
      } else if (!weekdays.every((day) => whole(day, 0) && (day as number) <= 6)) {
        badSchedule("Schedule weekdays must be whole numbers from 0 (Sunday) to 6 (Saturday).");
      } else if (new Set(weekdays).size !== weekdays.length) {
        badSchedule("Schedule weekdays must not repeat.");
      }
    } else if (schedule.type === "once") {
      if (typeof schedule.at !== "number" || !Number.isFinite(schedule.at)) {
        badSchedule("A one-time schedule needs a finite timestamp.");
      }
    } else {
      badSchedule("Schedule type must be daily or once.");
    }
  }

  const entryExists = nodeById.has(workflow.entryNodeId);
  if (!entryExists) {
    issues.push({
      severity: "error",
      code: "bad-entry",
      message: `Entry node "${workflow.entryNodeId}" does not exist.`,
    });
  }

  for (const edge of workflow.edges) {
    const fromExists = nodeById.has(edge.from);
    const toExists = nodeById.has(edge.to);
    if (fromExists && toExists) continue;
    const anchor = fromExists ? edge.from : toExists ? edge.to : undefined;
    issues.push({
      severity: "error",
      code: "dangling-edge",
      ...(anchor === undefined ? {} : { nodeId: anchor }),
      message: `Edge "${edge.from}" --${edge.outcome}--> "${edge.to}" references a missing node.`,
    });
  }

  const wiredByNode = new Map<string, Set<string>>();
  for (const edge of workflow.edges) {
    const wired = wiredByNode.get(edge.from) ?? new Set<string>();
    if (wired.has(edge.outcome)) {
      issues.push({
        severity: "error",
        code: "duplicate-edge",
        nodeId: edge.from,
        message: `Node "${edge.from}" has more than one edge for outcome "${edge.outcome}"; the engine needs exactly one successor.`,
      });
    }
    wired.add(edge.outcome);
    wiredByNode.set(edge.from, wired);
  }

  const routableByNode = new Map<string, Set<string>>();
  for (const [id, node] of nodeById) {
    routableByNode.set(id, new Set(nodeOutcomes(node)));
  }

  for (const edge of workflow.edges) {
    const routable = routableByNode.get(edge.from);
    if (!routable) continue; // missing source already reported as dangling
    if (!routable.has(edge.outcome)) {
      issues.push({
        severity: "error",
        code: "unknown-outcome",
        nodeId: edge.from,
        message: `Edge "${edge.from}" --${edge.outcome}--> "${edge.to}" uses an outcome node "${edge.from}" can never produce.`,
      });
    }
  }

  for (const node of workflow.nodes) {
    const wired = wiredByNode.get(node.id);
    if (!wired || wired.size === 0) continue; // terminal sink
    for (const outcome of nodeOutcomes(node)) {
      if (outcome === WORKFLOW_FAIL_OUTCOME) continue; // implicit; warned separately
      if (!wired.has(outcome)) {
        issues.push({
          severity: "error",
          code: "unwired-outcome",
          nodeId: node.id,
          message: `Node "${node.id}" declares outcome "${outcome}" but has no edge for it.`,
        });
      }
    }
  }

  for (const node of workflow.nodes) {
    if (node.kind !== "agent") continue;
    const wired = wiredByNode.get(node.id);
    // A node that wires nothing is a deliberate end of the run: its declared
    // outcomes end it and so does a failure. There is nowhere else a failure
    // could go, so warning about it only teaches people to ignore warnings.
    if (!wired || wired.size === 0) continue;
    if (!wired.has(WORKFLOW_FAIL_OUTCOME)) {
      issues.push({
        severity: "warning",
        code: "unwired-failure",
        nodeId: node.id,
        message: `Agent node "${node.id}" has no "${WORKFLOW_FAIL_OUTCOME}" edge; a failure there ends the run.`,
      });
    }
  }

  // Reachability only makes sense from a real entry; a bad entry already
  // errored above and must not cascade into one "unreachable" per node.
  if (entryExists) {
    const adjacency = new Map<string, string[]>();
    for (const edge of workflow.edges) {
      if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
      // A dead edge (unknown outcome) can never carry a run, so it must not
      // make its target look reachable.
      if (!routableByNode.get(edge.from)?.has(edge.outcome)) continue;
      const targets = adjacency.get(edge.from);
      if (targets) targets.push(edge.to);
      else adjacency.set(edge.from, [edge.to]);
    }
    const reached = new Set<string>([workflow.entryNodeId]);
    const queue = [workflow.entryNodeId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const next of adjacency.get(current) ?? []) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    for (const node of workflow.nodes) {
      if (!reached.has(node.id)) {
        issues.push({
          severity: "error",
          code: "unreachable",
          nodeId: node.id,
          message: `Node "${node.id}" is unreachable from the entry node.`,
        });
      }
    }
  }

  return issues;
}

/** The capabilities `requires` names that `capabilities` does not grant, in
 * declaration order, once each. Names the validator refuses (unknown, or
 * not a list at all) are skipped here: they are a `bad-requires` shape
 * problem, not a missing flag. Pure, and shared by the engine's dispatch
 * check and capabilityIssues so the two can never disagree. */
export function missingCapabilities(
  requires: WorkflowCapability[] | undefined,
  capabilities: BotCapabilities,
): WorkflowCapability[] {
  const missing: WorkflowCapability[] = [];
  if (!Array.isArray(requires)) return missing;
  for (const capability of requires) {
    if (!isWorkflowCapability(capability) || missing.includes(capability)) continue;
    if (capabilities[CAPABILITY_FLAG[capability]] !== true) missing.push(capability);
  }
  return missing;
}

/** One wording for a missing flag, whether the canvas paints it or the
 * engine records it as the reason a run stopped. */
export function missingCapabilityMessage(node: { id: string; botId: string }, capability: WorkflowCapability): string {
  return `Node "${node.id}" requires "${capability}" but its bot "${node.botId}" is not allowed to ${capability}.`;
}

/** Pure: flags nodes whose bot lacks a required capability, and fallback
 * bots the roster does not have or that could never take the node over.
 * `lookup` returns null for an unknown bot — for the node's own bot that
 * case is already reported elsewhere (the dispatch fails it), but a
 * fallback that does not exist is a promise the engine can never keep, so
 * it is an error here; a fallback short of a required flag is a warning,
 * since the engine simply skips it and waits out the outage instead. Kept
 * apart from validateWorkflow because it needs the bot roster — the shared
 * validator judges the graph alone; this judges the graph against the bots
 * it will run on, and both sets gate a run the same way. */
export function capabilityIssues(
  workflow: Workflow,
  lookup: (botId: string) => BotCapabilities | null,
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  for (const node of workflow.nodes) {
    if (node.kind !== "agent") continue;
    const capabilities = node.requires?.length ? lookup(node.botId) : null;
    for (const capability of capabilities === null ? [] : missingCapabilities(node.requires, capabilities)) {
      issues.push({
        severity: "error",
        code: "missing-capability",
        nodeId: node.id,
        message: missingCapabilityMessage(node, capability),
      });
    }
    // A blank or self-referencing fallback is validateWorkflow's finding;
    // repeating it here would paint the same node twice.
    const fallbackBotId = node.fallbackBotId;
    if (typeof fallbackBotId !== "string" || !fallbackBotId.trim() || fallbackBotId === node.botId) continue;
    const fallback = lookup(fallbackBotId);
    if (fallback === null) {
      issues.push({
        severity: "error",
        code: "fallback-missing-bot",
        nodeId: node.id,
        message: `Node "${node.id}" names a fallback bot "${fallbackBotId}" that does not exist.`,
      });
      continue;
    }
    for (const capability of missingCapabilities(node.requires, fallback)) {
      issues.push({
        severity: "warning",
        code: "fallback-missing-capability",
        nodeId: node.id,
        message: `Node "${node.id}" requires "${capability}" but its fallback bot "${fallbackBotId}" is not allowed to ${capability}; it will not take over during an outage.`,
      });
    }
  }
  return issues;
}
