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
/** The one outcome a wait node produces: its timer ran out. */
export const WORKFLOW_WAIT_OUTCOME = "elapsed";
export const WORKFLOW_NODE_TIMEOUT_DEFAULT_MIN = 30;
export const WORKFLOW_NODE_RETRIES_DEFAULT = 2;
/** Cycles are legal by design (review loops, and a continuous cycle that
 * loops back to the entry); this cap is what keeps a miswired loop from
 * running a workflow forever. It counts BOT WORK — agent and approval
 * executions — never wait or notify steps, which cost nothing and would
 * otherwise spend the budget of a slow continuous cycle on pauses. The
 * default is sized for a day of cycling rather than one pass. */
export const WORKFLOW_MAX_NODE_EXECUTIONS = 200;
export const WORKFLOW_MAX_NODE_EXECUTIONS_LIMIT = 1_000;
/** Bounds for a wait node: a minute is the shortest pause the 10-second
 * tick can honour meaningfully, a day is the longest a run should sit idle
 * — past that, a schedule is the right tool. */
export const WORKFLOW_WAIT_MINUTES_MIN = 1;
export const WORKFLOW_WAIT_MINUTES_MAX = 1_440;
/** Shortest interval a continuous schedule may fire on: below this the run
 * would be re-armed faster than a single bot turn usually finishes. */
export const WORKFLOW_INTERVAL_MINUTES_MIN = 5;
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
/** Bounds for the pre-flight's global timeout: every check runs inside one
 * deadline, short enough that a hung `gh` never holds a slot for long, long
 * enough for a real network round trip. */
export const WORKFLOW_PREFLIGHT_TIMEOUT_DEFAULT_S = 60;
export const WORKFLOW_PREFLIGHT_TIMEOUT_MIN_S = 5;
export const WORKFLOW_PREFLIGHT_TIMEOUT_MAX_S = 300;
/** How much of a check's output the receipt keeps, per stream. */
export const WORKFLOW_PREFLIGHT_OUTPUT_MAX = 500;
/** How long a `bots-ready` check keeps re-checking a bot that is merely
 * BUSY before the run is refused: contention is what the engine waits out
 * everywhere else, so a bot mid-turn at the trigger is a pause, not a
 * failure. Whole minutes, bounded so a run cannot sit in pre-flight for a
 * day. */
export const WORKFLOW_PREFLIGHT_WAIT_DEFAULT_MIN = 10;
export const WORKFLOW_PREFLIGHT_WAIT_MAX_MIN = 120;
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
      /** Approval keys pre-granted for THIS node's turns, in the same
       * vocabulary as a bot's `alwaysAllow` (`Bash:gh`, `shell:gh`,
       * `session_search`). A node turn runs with nobody watching, where only
       * a grant a person named survives; a node built around one program
       * should not depend on the bot carrying that grant for every chat too.
       * Unioned with the bot's list, under the same unattended rules — never
       * a way past the guards or onto the live desktop. */
      alwaysAllow?: string[];
      /** A second bot the engine may hand this node to — once per provider
       * outage, and only when that bot runs on a DIFFERENT model engine
       * than `botId` (a fallback on the same provider would be down too),
       * is free, and carries every capability in `requires`. */
      fallbackBotId?: string;
    }
  | { kind: "approval"; id: string; prompt: string; expiresHours?: number; onExpire?: "approved" | "rejected" }
  | { kind: "notify"; id: string; targetGroupId: string; template: string }
  /** A pause: no bot, no thread — the run sits on `waitUntil` and the
   * engine's tick moves it on. This is what makes a continuous cycle
   * (`… → wait → entry`) idle between laps instead of spinning. */
  | { kind: "wait"; id: string; minutes: number };

export interface WorkflowEdge {
  from: string;
  outcome: string;
  to: string;
}

/** A daily window of wall-clock time (local timezone) on the given weekdays
 * (0 = Sunday; absent means every day). `start` after `end` wraps past
 * midnight ("22:00" to "06:00"); the weekday tested is the instant's own. */
export interface WorkflowActiveHours {
  start: string;
  end: string;
  weekdays?: number[];
}

/** The calendar shapes are structurally identical to a routine's schedule so
 * the engine can borrow the routine scheduler's occurrence math: local
 * timezone, `daily` at HH:MM on the given weekdays (0 = Sunday), `once` at an
 * epoch-ms instant. */
export type WorkflowCalendarSchedule =
  | { type: "daily"; time: string; weekdays: number[] }
  | { type: "once"; at: number };

/** The continuous shape: the engine is the valve. Whenever the workflow has
 * no live run, the next one is armed `minutes` after the last run ENDED (or
 * after now, if it never ran), and only inside `activeHours` when given —
 * outside the window the arm lands on the next window's start. There is no
 * calendar slot to miss, so a computer that was asleep simply fires once on
 * waking; and a run started by hand or by a webhook pushes the next armed
 * run out, since the clock measures idleness, not the calendar. */
export type WorkflowIntervalSchedule = {
  type: "interval";
  minutes: number;
  activeHours?: WorkflowActiveHours;
};

export type WorkflowSchedule = WorkflowCalendarSchedule | WorkflowIntervalSchedule;

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

/** One pre-flight check: a question about the ENVIRONMENT a run is about
 * to start in, asked before any bot turn is dispatched, so a token that
 * lost a scope, a provider that is already down or a bot that is busy is
 * said out loud before forty-five minutes of bot time are spent finding
 * out. Three kinds:
 *
 * - `command` runs a program through the server's own identity (its user,
 *   its environment, the app's augmented PATH) under `/bin/sh -c` — no
 *   interactive shell, no TTY — and passes when the exit code is the
 *   expected one (0 unless said otherwise) and, when given, stdout matches
 *   `expectStdoutMatch` (a regular expression; an EMPTY stdout is asserted
 *   with `^$`). Nothing from a run's input is ever interpolated into it:
 *   the command is exactly the string the workflow's author saved.
 * - `bots-ready` asks the engine whether every bot the workflow's agent
 *   nodes use (or only `botIds`) exists and is not busy. A bot that is
 *   only BUSY is re-checked every tick for up to `waitMinutes` (default
 *   above) before the run is refused; a missing bot refuses it at once.
 * - `engine-health` asks the driver behind a bot's model engine for its
 *   snapshot — CLI present, signed in — which costs no tokens. */
export type WorkflowPreflightCheck =
  | {
      kind: "command";
      name: string;
      command: string;
      cwd?: string;
      expectExitCode?: number;
      expectStdoutMatch?: string;
    }
  | { kind: "bots-ready"; name: string; botIds?: string[]; waitMinutes?: number }
  | { kind: "engine-health"; name: string; botId: string };

export interface WorkflowPreflight {
  checks: WorkflowPreflightCheck[];
  /** One deadline for the whole set, in seconds (bounds above). */
  timeoutSeconds?: number;
}

/** What one check answered, as the run's receipt and the "Test pre-flight"
 * button both show it. Output is already bounded and scrubbed of secrets
 * by the time it is here — it is persisted and broadcast as is. */
export interface WorkflowPreflightCheckResult {
  name: string;
  kind: WorkflowPreflightCheck["kind"];
  ok: boolean;
  durationMs: number;
  /** Why it failed, or what it found: the exit code, the missing bot, the
   * engine's own reason. One line. */
  detail: string;
  stdout?: string;
  stderr?: string;
  /** A failure the engine may wait out rather than refuse the run on: so
   * far only a `bots-ready` check whose every problem is a BUSY bot. */
  transient?: true;
}

export interface WorkflowPreflightResult {
  at: number;
  ok: boolean;
  checks: WorkflowPreflightCheckResult[];
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
  /** Checks a run must pass before its first node is dispatched. Absent or
   * empty: nothing is checked, exactly as before this existed. */
  preflight?: WorkflowPreflight;
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
 * an approval gate opened, that gate's single reminder, or a continuous
 * cycle that COMPLETED because its execution cap closed the valve — a run
 * that ends after hundreds of bot turns is an event to see even when it is
 * not a failure. */
export type WorkflowNotificationKind = "failed" | "approval" | "reminder" | "cap-reached";

export interface WorkflowNodeResult {
  nodeId: string;
  outcome: string;
  summary: string;
  threadId?: string;
  startedAt: number;
  endedAt: number;
  /** Permission requests the harness denied on the node's behalf because
   * nobody was there to answer (one line each, naming the tool and the
   * grant key that would have covered it). Present only when at least one
   * was denied — a receipt that says WHICH grant the node was missing is
   * what turns "failed again" into a one-line fix on the node panel. */
  denials?: string[];
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
  /** When the current wait node's pause ends (engine bookkeeping). A run
   * carrying this is parked, not stranded: the tick advances it once the
   * instant passes, and a restart changes nothing because it is persisted.
   * Already moved into the interval trigger's active window when there is
   * one, so the instant the UI shows is the one the run will move at. */
  waitUntil?: number;
  /** When the current wait began (engine bookkeeping): the receipt's
   * startedAt for the step, kept apart from `dispatchedAt` so the timeout
   * sweep never sees a wait as a dispatch, and persisted rather than
   * derived from the node's minutes — which may be edited mid-pause. */
  waitStartedAt?: number;
  /** Set while the run's pre-flight is in flight (engine bookkeeping):
   * from the FIRST check to the verdict that dispatches or refuses, across
   * the re-checks a busy bot earns — so it is also the clock those
   * re-checks are budgeted against. The run is "running" with no thread;
   * with no timer either, this is what tells the reconciler after a
   * restart to re-run the checks rather than dispatch the node they were
   * guarding. Cleared by every dispatch and by the terminal verdict. */
  preflightStartedAt?: number;
  /** The pre-flight's verdict, check by check, once it has run — what the
   * timeline shows above the steps. A run refused by it is `failed` with
   * `error` naming the check; a run that passed keeps the receipt too, so
   * "it was fine at 09:00" is on record. Absent on runs of a workflow with
   * no checks and on receipts written before this existed. */
  preflight?: WorkflowPreflightResult;
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
    case "wait":
      return [WORKFLOW_WAIT_OUTCOME];
  }
}

/** Whether a node's execution counts against `maxNodeExecutions`. Only bot
 * work does: an agent turn or a human gate. A wait is idle time and a notify
 * is one synchronous post — neither can run away on its own, and counting
 * them would make the cap bite a slow continuous cycle for pausing. */
export function countsTowardExecutionCap(kind: WorkflowNode["kind"]): boolean {
  return kind === "agent" || kind === "approval";
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
    | "bad-always-allow"
    | "missing-capability"
    | "fallback-same-bot"
    | "fallback-missing-bot"
    | "fallback-missing-capability"
    | "cycle-without-wait"
    | "bad-preflight";
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
    // `alwaysAllow` is matched against approval keys by exact string, so a
    // blank or padded entry is a grant that can never fire, and a repeat is
    // a typo the canvas should show. The vocabulary itself is open (keys are
    // minted per tool and program), so nothing here judges the names.
    if (node.alwaysAllow !== undefined) {
      const badGrant = (message: string) => {
        issues.push({ severity: "error", code: "bad-always-allow", nodeId: node.id, message });
      };
      const grants: unknown = node.alwaysAllow;
      if (!Array.isArray(grants)) {
        badGrant(`Node "${node.id}" alwaysAllow must be a list of approval keys (like "Bash:gh").`);
      } else {
        const seen = new Set<string>();
        for (const grant of grants) {
          if (typeof grant !== "string" || grant.trim() === "") {
            badGrant(`Node "${node.id}" alwaysAllow has a blank entry; every entry must name an approval key.`);
          } else if (grant !== grant.trim()) {
            badGrant(`Node "${node.id}" alwaysAllow entry "${grant}" has surrounding whitespace and can never match.`);
          } else if (seen.has(grant)) {
            badGrant(`Node "${node.id}" alwaysAllow lists "${grant}" more than once.`);
          } else {
            seen.add(grant);
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
  // The cap is bounded above as well: it is the last defence against a hot
  // loop, and a value in the millions is a cap in name only.
  if (
    workflow.maxNodeExecutions !== undefined &&
    (!whole(workflow.maxNodeExecutions, 1) || workflow.maxNodeExecutions > WORKFLOW_MAX_NODE_EXECUTIONS_LIMIT)
  ) {
    badNumber(`maxNodeExecutions must be a whole number from 1 to ${WORKFLOW_MAX_NODE_EXECUTIONS_LIMIT}.`);
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
    } else if (
      node.kind === "wait" &&
      (!whole(node.minutes, WORKFLOW_WAIT_MINUTES_MIN) || node.minutes > WORKFLOW_WAIT_MINUTES_MAX)
    ) {
      // Whole minutes: the tick is coarser than a second anyway, and a
      // fractional pause would only look precise.
      badNumber(
        `Node "${node.id}" minutes must be a whole number from ${WORKFLOW_WAIT_MINUTES_MIN} to ${WORKFLOW_WAIT_MINUTES_MAX}.`,
        node.id,
      );
    }
  }

  issues.push(...preflightIssues(workflow.preflight));

  // A schedule the scheduler could not arm must never be persisted: a
  // malformed time never matches a wall clock, an empty weekday set never
  // fires, a day outside 0..6 is a slot that does not exist.
  const schedule = workflow.triggers?.schedule;
  if (schedule) {
    const badSchedule = (message: string) => {
      issues.push({ severity: "error", code: "bad-schedule", message });
    };
    // Shared by the daily schedule and an interval's active window; an
    // absent list means "every day" only where the caller says so.
    const checkWeekdays = (weekdays: unknown, what: string) => {
      if (!Array.isArray(weekdays) || weekdays.length === 0) {
        badSchedule(`${what} needs at least one weekday.`);
      } else if (!weekdays.every((day) => whole(day, 0) && (day as number) <= 6)) {
        badSchedule(`${what} weekdays must be whole numbers from 0 (Sunday) to 6 (Saturday).`);
      } else if (new Set(weekdays).size !== weekdays.length) {
        badSchedule(`${what} weekdays must not repeat.`);
      }
    };
    const isClockTime = (value: unknown): value is string =>
      typeof value === "string" && WORKFLOW_SCHEDULE_TIME_RE.test(value);
    if (schedule.type === "daily") {
      if (!isClockTime(schedule.time)) badSchedule("Schedule time must be HH:MM (24-hour).");
      checkWeekdays(schedule.weekdays, "Schedule");
    } else if (schedule.type === "once") {
      if (typeof schedule.at !== "number" || !Number.isFinite(schedule.at)) {
        badSchedule("A one-time schedule needs a finite timestamp.");
      }
    } else if (schedule.type === "interval") {
      if (!whole(schedule.minutes, WORKFLOW_INTERVAL_MINUTES_MIN)) {
        badSchedule(`Interval must be a whole number of at least ${WORKFLOW_INTERVAL_MINUTES_MIN} minutes.`);
      }
      const hours: unknown = schedule.activeHours;
      if (hours !== undefined) {
        if (typeof hours !== "object" || hours === null || Array.isArray(hours)) {
          badSchedule("Active hours must be an object with start and end times.");
        } else {
          const window = hours as Partial<WorkflowActiveHours>;
          if (!isClockTime(window.start) || !isClockTime(window.end)) {
            badSchedule("Active hours start and end must be HH:MM (24-hour).");
          } else if (window.start === window.end) {
            // Neither "always" nor "never" is a window; an author who wants
            // no window leaves activeHours out.
            badSchedule("Active hours start and end must differ.");
          }
          if (window.weekdays !== undefined) checkWeekdays(window.weekdays, "Active hours");
        }
      }
    } else {
      badSchedule("Schedule type must be daily, once or interval.");
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

    // A loop back to the entry is how a workflow runs continuously, and it
    // is legal — but a lap with no wait node in it re-dispatches the entry
    // the instant the last node finishes, and the only thing that stops that
    // hot loop is the execution cap. A warning, not an error: a review loop
    // that happens to pass through the entry is a real shape. Walking the
    // graph with every wait node removed is the test: if the entry can still
    // reach itself, some lap has no pause in it.
    const waitless = new Set(workflow.nodes.filter((node) => node.kind === "wait").map((node) => node.id));
    const seen = new Set<string>();
    // An entry that is itself a wait node pauses every lap by definition.
    const stack = waitless.has(workflow.entryNodeId) ? [] : [...(adjacency.get(workflow.entryNodeId) ?? [])];
    let hotLoop = false;
    while (stack.length > 0 && !hotLoop) {
      const current = stack.pop()!;
      if (current === workflow.entryNodeId) {
        hotLoop = true;
        break;
      }
      if (seen.has(current) || waitless.has(current)) continue;
      seen.add(current);
      stack.push(...(adjacency.get(current) ?? []));
    }
    if (hotLoop) {
      issues.push({
        severity: "warning",
        code: "cycle-without-wait",
        nodeId: workflow.entryNodeId,
        message: `The workflow loops back to its entry node "${workflow.entryNodeId}" with no wait node on the way; add one so the cycle idles between laps instead of running hot until the execution cap.`,
      });
    }
  }

  return issues;
}

/** Whether a string is a regular expression the engine could run. Kept
 * apart so the panel can judge a half-typed pattern the same way. */
export function isValidPreflightPattern(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** The pre-flight's shape rules. Every check is named — the receipt and the
 * notification say WHICH check refused the run, so a blank or repeated name
 * would leave that sentence pointing nowhere. A blank command is nothing to
 * run; an invalid regex would throw at the moment of the check; a timeout
 * outside its bounds is either a check that cannot finish or a slot held
 * for minutes. Shapes a raw JSON body may carry (a non-list, a string in a
 * number's place) are refused too, as every other knob's are. */
function preflightIssues(preflight: unknown): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  if (preflight === undefined) return issues;
  const bad = (message: string) => {
    issues.push({ severity: "error", code: "bad-preflight", message });
  };
  if (typeof preflight !== "object" || preflight === null || Array.isArray(preflight)) {
    bad("preflight must be an object with a list of checks.");
    return issues;
  }
  const { checks, timeoutSeconds } = preflight as Partial<WorkflowPreflight>;
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== "number" ||
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < WORKFLOW_PREFLIGHT_TIMEOUT_MIN_S ||
      timeoutSeconds > WORKFLOW_PREFLIGHT_TIMEOUT_MAX_S)
  ) {
    bad(
      `preflight.timeoutSeconds must be a whole number from ${WORKFLOW_PREFLIGHT_TIMEOUT_MIN_S} to ${WORKFLOW_PREFLIGHT_TIMEOUT_MAX_S}.`,
    );
  }
  if (!Array.isArray(checks)) {
    bad("preflight.checks must be a list.");
    return issues;
  }
  const names = new Set<string>();
  checks.forEach((check: unknown, index) => {
    const label = `Pre-flight check ${index + 1}`;
    if (typeof check !== "object" || check === null || Array.isArray(check)) {
      bad(`${label} must be an object.`);
      return;
    }
    const raw = check as Record<string, unknown>;
    const name = raw.name;
    // Compared trimmed: "gh auth" and "gh auth " are the same name to a
    // reader and would be the same name in a receipt.
    if (typeof name !== "string" || name.trim() === "") {
      bad(`${label} needs a name.`);
    } else if (names.has(name.trim())) {
      bad(`${label} repeats the name "${name.trim()}"; every check needs its own.`);
    } else {
      names.add(name.trim());
    }
    const who = typeof name === "string" && name.trim() !== "" ? `Pre-flight check "${name}"` : label;
    const kind = raw.kind;
    if (kind === "command") {
      if (typeof raw.command !== "string" || raw.command.trim() === "") bad(`${who} has no command to run.`);
      if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || raw.cwd.trim() === "")) {
        bad(`${who} cwd must be a directory path.`);
      }
      if (raw.expectExitCode !== undefined && !(typeof raw.expectExitCode === "number" && Number.isInteger(raw.expectExitCode))) {
        bad(`${who} expectExitCode must be a whole number.`);
      }
      if (raw.expectStdoutMatch !== undefined) {
        if (typeof raw.expectStdoutMatch !== "string" || !isValidPreflightPattern(raw.expectStdoutMatch)) {
          bad(`${who} expectStdoutMatch is not a valid regular expression.`);
        }
      }
    } else if (kind === "bots-ready") {
      const botIds = raw.botIds;
      if (botIds !== undefined) {
        if (!Array.isArray(botIds) || botIds.some((id) => typeof id !== "string" || id.trim() === "")) {
          bad(`${who} botIds must be a list of bot ids.`);
        } else if (new Set(botIds).size !== botIds.length) {
          bad(`${who} lists the same bot more than once.`);
        }
      }
      const wait = raw.waitMinutes;
      if (
        wait !== undefined &&
        (typeof wait !== "number" || !Number.isInteger(wait) || wait < 0 || wait > WORKFLOW_PREFLIGHT_WAIT_MAX_MIN)
      ) {
        bad(`${who} waitMinutes must be a whole number from 0 to ${WORKFLOW_PREFLIGHT_WAIT_MAX_MIN}.`);
      }
    } else if (kind === "engine-health") {
      if (typeof raw.botId !== "string" || raw.botId.trim() === "") bad(`${who} needs the bot whose engine to check.`);
    } else {
      bad(`${who} kind must be command, bots-ready or engine-health.`);
    }
  });
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
