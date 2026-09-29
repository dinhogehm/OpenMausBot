// Self-paced work for one bot in one conversation, without a person typing.
//
// Two pieces, one ledger:
//   - A wake: the bot asked (wake_me) to be given a new turn in this
//     conversation after N minutes — to check a CI run, a deploy, another
//     agent's session, or to follow a "check every 2 minutes" rule. One
//     pending wake per conversation; a new one replaces it.
//   - A watch (wake_when) is a wake with a read-only command attached: the
//     server runs it every few minutes, with no model involved, and moves
//     the wake up to "now" once the output changes, matches what the bot
//     waits for, or keeps failing. The time limit still wakes it regardless.
//   - A goal: the bot was told to keep working until something is delivered
//     (goal_start). The harness keeps handing it continuation turns until it
//     calls goal_end, a limit runs out, or the person presses Stop.
//
// This file is state and policy only: it decides what is due and what the
// continuation prompt says. server/index.ts owns the timer, the busy checks
// and startTurn. Persisted to one JSON file so a restart neither drops a
// promised wake nor forgets a running goal.
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";

export const WAKE_MIN_MINUTES = 1;
export const WAKE_MAX_MINUTES = 1_440;
export const WAKE_REASON_MAX = 500;
export const GOAL_TEXT_MAX = 2_000;
export const GOAL_DETAIL_MAX = 500;
export const GOAL_DEFAULT_MAX_TURNS = 60;
export const GOAL_MAX_TURNS_LIMIT = 200;
export const GOAL_DEFAULT_MAX_HOURS = 12;
export const GOAL_MAX_HOURS_LIMIT = 72;
/** Consecutive failed turns before a goal stops as blocked. */
export const GOAL_MAX_CONSECUTIVE_FAILURES = 3;
/** A continuation is never dispatched sooner than this after the previous
 * one, even if the thread already looks idle: startTurn resolves on dispatch,
 * and the busy flag must get a chance to settle before the next check. */
export const GOAL_MIN_TURN_GAP_MS = 15_000;

export const WATCH_MIN_EVERY_MINUTES = 1;
export const WATCH_MAX_EVERY_MINUTES = 60;
export const WATCH_DEFAULT_EVERY_MINUTES = 2;
export const WATCH_MIN_MAX_MINUTES = 5;
export const WATCH_DEFAULT_MAX_MINUTES = 120;
export const WATCH_UNTIL_MAX = 200;
/** Consecutive failed runs before the bot is woken to fix its command. */
export const WATCH_MAX_FAILURES = 3;
const WATCH_PROMPT_OUTPUT_MAX = 1_500;

export type WatchTrigger = "changed" | "matched" | "failing";

export interface WakeWatch {
  command: string;
  argv: string[];
  everyMs: number;
  until?: string;
  baseline: string;
  lastOutput?: string;
  lastRunAt: number;
  runs: number;
  failures: number;
  trigger?: WatchTrigger;
}

export interface BotWake {
  botId: string;
  threadId: string;
  dueAt: number;
  reason: string;
  createdAt: number;
  watch?: WakeWatch;
}

export type GoalEndStatus = "completed" | "blocked" | "needs-input";
export type GoalStatus = "active" | GoalEndStatus | "stopped" | "limit";

export interface BotGoal {
  botId: string;
  threadId: string;
  goal: string;
  status: GoalStatus;
  startedAt: number;
  deadlineAt: number;
  maxTurns: number;
  turnCount: number;
  consecutiveFailures: number;
  lastDispatchAt?: number;
  detail?: string;
  finishedAt?: number;
}

/** Reports waiting to be handed to a conversation (Claude Code sessions the
 * bot manages finished a turn). Kept apart from wakes so a report never
 * replaces a pending wake or watch, and several reports arrive together. */
export interface PendingReports {
  botId: string;
  threadId: string;
  items: string[];
}

interface Ledger {
  wakes: BotWake[];
  goals: BotGoal[];
  reports?: PendingReports[];
}

const clip = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const intIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;

export type WakeInput = { ok: true; minutes: number; reason: string } | { ok: false; error: string };

export function parseWakeInput(body: { minutes?: unknown; reason?: unknown }): WakeInput {
  const minutes = intIn(body.minutes, WAKE_MIN_MINUTES, WAKE_MAX_MINUTES);
  if (minutes === null) return { ok: false, error: `minutes must be a whole number from ${WAKE_MIN_MINUTES} to ${WAKE_MAX_MINUTES}` };
  const reason = clip(body.reason, WAKE_REASON_MAX);
  if (!reason) return { ok: false, error: "reason is required: what to check or do when you wake up" };
  return { ok: true, minutes, reason };
}

export type WatchInput =
  | { ok: true; everyMinutes: number; maxMinutes: number; until?: string; reason: string }
  | { ok: false; error: string };

export function parseWatchInput(body: { everyMinutes?: unknown; maxMinutes?: unknown; until?: unknown; reason?: unknown }): WatchInput {
  const everyMinutes = body.everyMinutes === undefined
    ? WATCH_DEFAULT_EVERY_MINUTES
    : intIn(body.everyMinutes, WATCH_MIN_EVERY_MINUTES, WATCH_MAX_EVERY_MINUTES);
  if (everyMinutes === null) return { ok: false, error: `every_minutes must be a whole number from ${WATCH_MIN_EVERY_MINUTES} to ${WATCH_MAX_EVERY_MINUTES}` };
  const maxMinutes = body.maxMinutes === undefined
    ? WATCH_DEFAULT_MAX_MINUTES
    : intIn(body.maxMinutes, WATCH_MIN_MAX_MINUTES, WAKE_MAX_MINUTES);
  if (maxMinutes === null) return { ok: false, error: `max_minutes must be a whole number from ${WATCH_MIN_MAX_MINUTES} to ${WAKE_MAX_MINUTES}` };
  if (maxMinutes < everyMinutes) return { ok: false, error: "max_minutes must be at least every_minutes" };
  const until = clip(body.until, WATCH_UNTIL_MAX) || undefined;
  const reason = clip(body.reason, WAKE_REASON_MAX);
  if (!reason) return { ok: false, error: "reason is required: what to do when the watch fires" };
  return { ok: true, everyMinutes, maxMinutes, ...(until ? { until } : {}), reason };
}

export type GoalInput =
  | { ok: true; goal: string; maxTurns: number; maxHours: number }
  | { ok: false; error: string };

export function parseGoalInput(body: { goal?: unknown; maxTurns?: unknown; maxHours?: unknown }): GoalInput {
  const goal = clip(body.goal, GOAL_TEXT_MAX);
  if (!goal) return { ok: false, error: "goal is required: the concrete deliverable and how you will know it is done" };
  const maxTurns = body.maxTurns === undefined ? GOAL_DEFAULT_MAX_TURNS : intIn(body.maxTurns, 1, GOAL_MAX_TURNS_LIMIT);
  if (maxTurns === null) return { ok: false, error: `max_turns must be a whole number from 1 to ${GOAL_MAX_TURNS_LIMIT}` };
  const maxHours = body.maxHours === undefined ? GOAL_DEFAULT_MAX_HOURS : intIn(body.maxHours, 1, GOAL_MAX_HOURS_LIMIT);
  if (maxHours === null) return { ok: false, error: `max_hours must be a whole number from 1 to ${GOAL_MAX_HOURS_LIMIT}` };
  return { ok: true, goal, maxTurns, maxHours };
}

export type GoalEndInput = { ok: true; status: GoalEndStatus; detail: string } | { ok: false; error: string };

export function parseGoalEndInput(body: { status?: unknown; detail?: unknown }): GoalEndInput {
  const raw = typeof body.status === "string" ? body.status.trim().replace("_", "-") : "";
  if (raw !== "completed" && raw !== "blocked" && raw !== "needs-input") {
    return { ok: false, error: "status must be completed, blocked or needs_input" };
  }
  const detail = clip(body.detail, GOAL_DETAIL_MAX);
  if (!detail) return { ok: false, error: "detail is required: what was delivered, or exactly what blocks it" };
  return { ok: true, status: raw, detail };
}

export class BotAutonomy {
  private wakes = new Map<string, BotWake>();
  private goals = new Map<string, BotGoal>();
  private reports = new Map<string, PendingReports>();
  private readonly path: string | null;
  private readonly now: () => number;
  private readonly minuteMs: number;
  private readonly turnGapMs: number;

  // plain field assignments, not parameter properties — the server runs
  // under Node's type-stripping, which cannot transform the latter
  // minuteMs/turnGapMs only shrink time for end-to-end tests.
  constructor(opts: { path: string | null; now?: () => number; minuteMs?: number; turnGapMs?: number }) {
    this.path = opts.path;
    this.now = opts.now ?? Date.now;
    this.minuteMs = opts.minuteMs ?? 60_000;
    this.turnGapMs = opts.turnGapMs ?? GOAL_MIN_TURN_GAP_MS;
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Ledger>;
      for (const wake of raw.wakes ?? []) {
        if (wake && typeof wake.threadId === "string" && typeof wake.botId === "string" && Number.isFinite(wake.dueAt)) {
          this.wakes.set(wake.threadId, wake);
        }
      }
      for (const pending of raw.reports ?? []) {
        if (pending && typeof pending.threadId === "string" && Array.isArray(pending.items) && pending.items.length) {
          this.reports.set(pending.threadId, pending);
        }
      }
      for (const goal of raw.goals ?? []) {
        if (goal && typeof goal.threadId === "string" && typeof goal.botId === "string" && typeof goal.goal === "string") {
          this.goals.set(goal.threadId, goal);
        }
      }
    } catch (error) {
      console.error(`[autonomy] ignoring unreadable ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private save(): void {
    if (!this.path) return;
    const ledger: Ledger = { wakes: [...this.wakes.values()], goals: [...this.goals.values()], reports: [...this.reports.values()] };
    writeFileAtomic(this.path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  }

  // ── wakes ──────────────────────────────────────────────────────────────

  setWake(botId: string, threadId: string, minutes: number, reason: string): BotWake {
    const at = this.now();
    const wake: BotWake = { botId, threadId, dueAt: at + minutes * this.minuteMs, reason, createdAt: at };
    this.wakes.set(threadId, wake);
    this.save();
    return wake;
  }

  /** A wake that fires early when a watched command's output moves. The
   * first run already happened (its output is the baseline). */
  setWatch(
    botId: string,
    threadId: string,
    input: { command: string; argv: string[]; everyMinutes: number; maxMinutes: number; until?: string; reason: string; baseline: string },
  ): BotWake {
    const at = this.now();
    const wake: BotWake = {
      botId,
      threadId,
      dueAt: at + input.maxMinutes * this.minuteMs,
      reason: input.reason,
      createdAt: at,
      watch: {
        command: input.command,
        argv: input.argv,
        everyMs: input.everyMinutes * this.minuteMs,
        ...(input.until ? { until: input.until } : {}),
        baseline: input.baseline,
        lastRunAt: at,
        runs: 1,
        failures: 0,
      },
    };
    this.wakes.set(threadId, wake);
    this.save();
    return wake;
  }

  /** Watches whose command is due to run again (not yet triggered). */
  watchesToRun(): BotWake[] {
    const at = this.now();
    return [...this.wakes.values()].filter((wake) =>
      wake.watch && !wake.watch.trigger && wake.dueAt > at && at - wake.watch.lastRunAt >= wake.watch.everyMs,
    );
  }

  /** Record one run; the wake becomes due now if the watch triggered. The
   * caller decides changed/matched (it owns the matching rule). */
  recordWatchRun(wake: BotWake, result: { ok: boolean; output: string; matched: boolean }): WatchTrigger | null {
    const watch = wake.watch;
    if (!watch || this.wakes.get(wake.threadId) !== wake || watch.trigger) return null;
    watch.lastRunAt = this.now();
    watch.runs += 1;
    watch.lastOutput = result.output;
    let trigger: WatchTrigger | null = null;
    if (!result.ok) {
      watch.failures += 1;
      if (watch.failures >= WATCH_MAX_FAILURES) trigger = "failing";
    } else {
      watch.failures = 0;
      if (result.matched) trigger = "matched";
      else if (!watch.until && result.output !== watch.baseline) trigger = "changed";
    }
    if (trigger) {
      watch.trigger = trigger;
      wake.dueAt = this.now();
    }
    this.save();
    return trigger;
  }

  /** Put back a wake that was taken but could not start (the thread got
   * busy in between); it stays due and keeps its original note and time. */
  restoreWake(wake: BotWake): void {
    if (this.wakes.has(wake.threadId)) return;
    this.wakes.set(wake.threadId, wake);
    this.save();
  }

  wakeFor(threadId: string): BotWake | null {
    return this.wakes.get(threadId) ?? null;
  }

  cancelWake(threadId: string): BotWake | null {
    const wake = this.wakes.get(threadId) ?? null;
    if (wake) {
      this.wakes.delete(threadId);
      this.save();
    }
    return wake;
  }

  dueWakes(): BotWake[] {
    const at = this.now();
    return [...this.wakes.values()].filter((wake) => wake.dueAt <= at).sort((a, b) => a.dueAt - b.dueAt);
  }

  // ── reports ────────────────────────────────────────────────────────────

  addReport(botId: string, threadId: string, text: string): void {
    const pending = this.reports.get(threadId) ?? { botId, threadId, items: [] };
    pending.items.push(text);
    this.reports.set(threadId, pending);
    this.save();
  }

  hasReports(threadId: string): boolean {
    return (this.reports.get(threadId)?.items.length ?? 0) > 0;
  }

  reportThreads(): PendingReports[] {
    return [...this.reports.values()].filter((pending) => pending.items.length > 0);
  }

  takeReports(threadId: string): PendingReports | null {
    const pending = this.reports.get(threadId) ?? null;
    if (!pending) return null;
    this.reports.delete(threadId);
    this.save();
    return pending;
  }

  /** Put reports back when their turn could not start. */
  restoreReports(pending: PendingReports): void {
    const current = this.reports.get(pending.threadId);
    this.reports.set(pending.threadId, current ? { ...pending, items: [...pending.items, ...current.items] } : pending);
    this.save();
  }

  // ── goals ──────────────────────────────────────────────────────────────

  startGoal(botId: string, threadId: string, input: { goal: string; maxTurns: number; maxHours: number }): BotGoal {
    const at = this.now();
    const goal: BotGoal = {
      botId,
      threadId,
      goal: input.goal,
      status: "active",
      startedAt: at,
      deadlineAt: at + input.maxHours * 3_600_000,
      maxTurns: input.maxTurns,
      turnCount: 0,
      consecutiveFailures: 0,
    };
    this.goals.set(threadId, goal);
    this.save();
    return goal;
  }

  goalFor(threadId: string): BotGoal | null {
    return this.goals.get(threadId) ?? null;
  }

  activeGoals(): BotGoal[] {
    return [...this.goals.values()].filter((goal) => goal.status === "active");
  }

  finishGoal(threadId: string, status: Exclude<GoalStatus, "active">, detail: string): BotGoal | null {
    const goal = this.goals.get(threadId);
    if (!goal || goal.status !== "active") return null;
    goal.status = status;
    goal.detail = detail;
    goal.finishedAt = this.now();
    this.save();
    return goal;
  }

  /** A person answered a goal that stopped to ask them something: the same
   * goal picks up again, with its limits intact. */
  resumeGoalAfterInput(threadId: string): BotGoal | null {
    const goal = this.goals.get(threadId);
    if (!goal || goal.status !== "needs-input") return null;
    goal.status = "active";
    delete goal.detail;
    delete goal.finishedAt;
    goal.consecutiveFailures = 0;
    this.save();
    return goal;
  }

  /** Why an active goal must stop before its next turn, or null. */
  goalLimitReached(goal: BotGoal): string | null {
    if (goal.turnCount >= goal.maxTurns) return `used all ${goal.maxTurns} turns`;
    if (this.now() >= goal.deadlineAt) return "reached its time limit";
    return null;
  }

  /** Ready for its next continuation (the caller still checks busy state). */
  goalReadyForTurn(goal: BotGoal): boolean {
    return goal.status === "active" && (goal.lastDispatchAt === undefined || this.now() - goal.lastDispatchAt >= this.turnGapMs);
  }

  noteGoalDispatch(threadId: string): BotGoal | null {
    const goal = this.goals.get(threadId);
    if (!goal || goal.status !== "active") return null;
    goal.turnCount += 1;
    goal.lastDispatchAt = this.now();
    this.save();
    return goal;
  }

  /** The continuation lost a race for the thread and never ran. */
  undoGoalDispatch(threadId: string): void {
    const goal = this.goals.get(threadId);
    if (!goal || goal.turnCount === 0) return;
    goal.turnCount -= 1;
    delete goal.lastDispatchAt;
    this.save();
  }

  /** A goal turn settled; returns the new failure streak. */
  noteGoalTurnOutcome(threadId: string, ok: boolean): number {
    const goal = this.goals.get(threadId);
    if (!goal || goal.status !== "active") return 0;
    const next = ok ? 0 : goal.consecutiveFailures + 1;
    if (next !== goal.consecutiveFailures) {
      goal.consecutiveFailures = next;
      this.save();
    }
    return next;
  }

  /** Drop everything tied to a conversation that no longer exists. */
  forgetThread(threadId: string): void {
    const hadWake = this.wakes.delete(threadId);
    const hadGoal = this.goals.delete(threadId);
    const hadReports = this.reports.delete(threadId);
    if (hadWake || hadGoal || hadReports) this.save();
  }
}

const minutesLabel = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

const GOAL_RULES = [
  "Keep going without waiting for the person. Do the next concrete step now: run the command, open the PR, check the deploy, fix what failed.",
  "When you are waiting on something outside this conversation (CI, a deploy, a review), call wake_when with a read-only command that shows its state — it costs nothing until that state changes — or wake_me for a plain timer, and end the turn instead of polling in a loop.",
  "When teammates you delegated to are still working, just end the turn: their results wake you here.",
  "Call goal_end with status completed only when the deliverable is verifiably done, blocked when you cannot proceed, or needs_input when only the person can decide. Never claim completion you have not checked.",
];

export function goalStartedAck(goal: BotGoal): string {
  return `Goal mode is on for this conversation: up to ${goal.maxTurns} turns or ${minutesLabel(goal.deadlineAt - goal.startedAt)}. After this turn ends you will be given the next one automatically. ${GOAL_RULES.slice(1).join(" ")}`;
}

export function goalContinuationPrompt(goal: BotGoal, now: number): string {
  return [
    `[Goal mode — turn ${goal.turnCount} of ${goal.maxTurns}, ${minutesLabel(goal.deadlineAt - now)} left. Nobody typed this; the harness continues your goal.]`,
    `Goal: ${goal.goal}`,
    "Use this conversation as your progress ledger: check what is already done before repeating anything.",
    ...GOAL_RULES,
  ].join("\n");
}

const clipOutput = (text: string | undefined): string => {
  const value = (text ?? "").trim();
  if (!value) return "(empty)";
  return value.length > WATCH_PROMPT_OUTPUT_MAX ? `${value.slice(0, WATCH_PROMPT_OUTPUT_MAX)}\n… (truncated)` : value;
};

function watchLines(wake: BotWake): string[] {
  const watch = wake.watch;
  if (!watch) return [];
  const why = watch.trigger === "matched"
    ? `its output now matches "${watch.until}"`
    : watch.trigger === "changed"
      ? "its output changed"
      : watch.trigger === "failing"
        ? `the command failed ${watch.failures} times in a row — fix or replace it`
        : "the time limit ran out before anything changed";
  return [
    `Your watch \`${watch.command}\` ran ${watch.runs} time(s); you are woken because ${why}.`,
    `Output when you set it:\n${clipOutput(watch.baseline)}`,
    ...(watch.lastOutput !== undefined && watch.lastOutput !== watch.baseline ? [`Latest output:\n${clipOutput(watch.lastOutput)}`] : []),
  ];
}

export function wakePrompt(wake: BotWake, goal: BotGoal | null, now: number): string {
  return [
    `[${wake.watch ? "Watch" : "Wake-up"} you scheduled ${minutesLabel(now - wake.createdAt)} ago. Nobody typed this.]`,
    ...watchLines(wake),
    `Your note for this moment: ${wake.reason}`,
    ...(goal && goal.status === "active"
      ? [`You are in goal mode (turn ${goal.turnCount} of ${goal.maxTurns}). Goal: ${goal.goal}`, ...GOAL_RULES]
      : ["Do what the note says. If it still is not ready, call wake_when or wake_me again; if it is, report the result here."]),
  ].join("\n");
}

export function wakeChip(wake: BotWake): string {
  const at = new Date(wake.dueAt);
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (wake.watch) {
    const every = Math.round(wake.watch.everyMs / 60_000) || 1;
    return `Watching \`${wake.watch.command.slice(0, 80)}\` every ${every} min, until ${hhmm} — ${wake.reason.slice(0, 100)}`;
  }
  return `Wake-up set for ${hhmm} — ${wake.reason.slice(0, 120)}`;
}

export function goalEndChip(goal: BotGoal): string {
  const label = {
    completed: "Goal completed",
    blocked: "Goal blocked",
    "needs-input": "Goal waiting for you",
    stopped: "Goal stopped",
    limit: "Goal paused at its limit",
  }[goal.status as Exclude<GoalStatus, "active">];
  return `${label} after ${goal.turnCount} turn${goal.turnCount === 1 ? "" : "s"}${goal.detail ? ` — ${goal.detail.slice(0, 160)}` : ""}`;
}

export function reportsPrompt(pending: PendingReports, goal: BotGoal | null): string {
  return [
    `[${pending.items.length === 1 ? "A Claude Code session you manage reported" : `${pending.items.length} Claude Code sessions you manage reported`}. Nobody typed this.]`,
    ...pending.items,
    ...(goal && goal.status === "active" ? [`You are in goal mode (turn ${goal.turnCount} of ${goal.maxTurns}). Goal: ${goal.goal}`] : []),
  ].join("\n\n---\n\n");
}
