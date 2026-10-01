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
//   - A standing watch (wake_when standing) is never used up: after it fires
//     it re-arms on the output it fired on, whether or not the turn could
//     start. It lives beside the conversation's one ordinary wake, so a
//     wake_me there never replaces it.
//   - A promise (wake_me promise): the bot owes someone an answer by a
//     time ("responder ao cliente até 16h"). It is not a wake: nothing
//     happens while it is kept in time. Past its time and not marked kept
//     (wake_me promise_kept), it is reported to the bot and to its Chief.
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
import { languageReminder } from "./reply-language.ts";
import { lineHash, newestStamp } from "./wake-watch.ts";
import { chatTexts, ECHO_WINDOW_MS, isEcho, normalize, vmChatPostOf, vmSheetNoteOf, watchKindOf, withoutLeadingMentions, type SelfWrite } from "./watch-echo.ts";
/** How long, and how many, message starts a bot keeps as seen in its Chat watches. */
export const SEEN_CHAT_MS = 24 * 3_600_000;
export const SEEN_CHAT_MAX = 2_000;

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
  /** sha256 of the whole baseline output; absent on watches set before it existed. */
  baselineFingerprint?: string;
  lastOutput?: string;
  /** sha256 of the latest successful output; a standing watch compares against it. */
  lastFingerprint?: string;
  /** Fingerprints cover stdout only (older watches fingerprinted stderr too). */
  stdoutFingerprint?: true;
  lastRunAt: number;
  runs: number;
  failures: number;
  trigger?: WatchTrigger;
  /** What made a standing watch fire last time. */
  lastTrigger?: WatchTrigger;
  /** Never used up: re-armed after each firing. */
  standing?: true;
  /** Names one of a conversation's standing watches ("chat", "planilha"); absent = "default". */
  label?: string;
  /** A standing watch's time limit, re-applied on each re-arm. */
  maxMs?: number;
  /** Times it fired; a standing watch keeps counting. */
  fired?: number;
  /** Hashes of the latest stdout's lines, and the lines new since the run
   * before (shown when the output is cut at WATCH_OUTPUT_MAX). */
  lineHashes?: string[];
  newLines?: string[];
  truncated?: boolean;
  /** When its reason was written (a standing watch keeps it across re-arms). */
  reasonAt?: number;
  /** Lines matching this do not count as a change (wake_when ignore). */
  ignore?: string;
  /** When its stdout last changed (or it was set), and when an old,
   * unchanging output was reported. */
  changedAt?: number;
  staleAlertedAt?: number;
  /** The last change it let pass as the bot's own write (server/watch-echo.ts). */
  echoAt?: number;
  /** That change: how many lines, why each was the bot's, the first one. */
  echo?: { at: number; lines: number; reasons: string[]; sample: string };
  /** An unanchored `ignore` was pointed out in its conversation. */
  ignoreWarnedAt?: number;
}

export interface BotWake {
  botId: string;
  threadId: string;
  dueAt: number;
  reason: string;
  createdAt: number;
  watch?: WakeWatch;
  /** Turns for it that failed to start (VM, docker, engine); spaces the retries. */
  dispatchFailures?: number;
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
  /** A turn for them failed to start: not before this, and how many times. */
  notBefore?: number;
  dispatchFailures?: number;
}

/** A wake or reports handed to a turn that has not finished yet. Kept on
 * disk until the turn completes, so a restart in between gives it back
 * instead of losing it. */
export interface InFlight {
  kind: "wake" | "reports";
  botId: string;
  threadId: string;
  startedAt: number;
  wake?: BotWake;
  items?: string[];
}

/** A lease older than this is not given back after a restart. */
export const IN_FLIGHT_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** A lease older than this is not re-run after a restart: the bot is asked
 * whether it still holds (it may already have answered a client). */
export const IN_FLIGHT_STALE_MS = 6 * 3_600_000;
export const STALE_PREFIX = "[Este turno foi interrompido por um restart do servidor há mais de 6 h e NÃO foi repetido automaticamente. Antes de agir, confira se ainda vale — uma resposta a cliente pode já ter sido enviada.]";
/** The longest wait between retries of a turn that failed to start. */
export const DISPATCH_RETRY_MAX_MINUTES = 10;

/** What a restart found cut off, for the resumption report. */
export interface RecoveredLease { botId: string; threadId: string; kind: InFlight["kind"]; startedAt: number; stale: boolean; what: string }
export const INTERRUPTED_PREFIX = "[A execução anterior foi interrompida por um restart do servidor antes de terminar; retome daqui.]";

/** Something the bot owes by a time; see the header. */
export interface BotPromise {
  id: string;
  botId: string;
  threadId: string;
  text: string;
  dueAt: number;
  createdAt: number;
  /** Reported as overdue (once). */
  overdueAt?: number;
}
/** Something that waits on the person (owner_pending): a decision, an
 * approval, a draft left in a field. It stays in "Precisa de você" until
 * the bot, the server or the person resolves it. */
export interface OwnerPending {
  id: string;
  botId: string;
  threadId: string;
  title: string;
  createdAt: number;
  /** By when, as the bot wrote it ("hoje 18h", "2026-10-02"). */
  due?: string;
  /** Where to act on it (a PR, a claude:// session link). */
  link?: string;
  /** Set by the server for its own items, so it can resolve them itself. */
  key?: string;
}
export const OWNER_PENDING_TITLE_MAX = 200;
export const OWNER_PENDING_MAX_PER_THREAD = 10;

export const PROMISE_TEXT_MAX = 300;
export const PROMISE_MAX_MINUTES = 7 * 1_440;
export const PROMISES_MAX_PER_THREAD = 10;

interface Ledger {
  promises?: BotPromise[];
  ownerPending?: OwnerPending[];
  wakes: BotWake[];
  goals: BotGoal[];
  reports?: PendingReports[];
  inFlight?: InFlight[];
  standingLost?: StandingLost[];
}

/** A conversation whose last standing watch was cancelled: a watcher bot
 * left without its watcher. Alerted once if nothing re-arms it in time. */
export interface StandingLost { botId: string; threadId: string; at: number; alerted?: boolean }
export const STANDING_LOST_ALERT_MS = 10 * 60_000;

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

export type PromiseInput = { ok: true; text: string; minutes: number } | { ok: false; error: string };

export function parsePromiseInput(body: { promise?: unknown; promiseMinutes?: unknown }): PromiseInput {
  const text = clip(body.promise, PROMISE_TEXT_MAX);
  if (!text) return { ok: false, error: "promise precisa dizer o que você deve e a quem (ex.: \"resposta ao cliente X no space Y sobre Z\")" };
  const minutes = intIn(body.promiseMinutes, 1, PROMISE_MAX_MINUTES);
  if (minutes === null) return { ok: false, error: `promise_minutes precisa ser um número inteiro de 1 a ${PROMISE_MAX_MINUTES}: o prazo, em minutos a partir de agora` };
  return { ok: true, text, minutes };
}

export type WatchInput =
  | { ok: true; everyMinutes: number; maxMinutes: number; until?: string; reason: string; standing?: true; label?: string; ignore?: string }
  | { ok: false; error: string };

export function parseWatchInput(body: { everyMinutes?: unknown; maxMinutes?: unknown; until?: unknown; reason?: unknown; standing?: unknown; label?: unknown; ignore?: unknown }): WatchInput {
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
  if (body.standing !== undefined && typeof body.standing !== "boolean") return { ok: false, error: "standing must be true or false" };
  const label = parseStandingLabel(body.label);
  if (label === null) return { ok: false, error: "label must be 1-40 letters, digits, spaces or . _ # : -" };
  const ignore = clip(body.ignore, WATCH_UNTIL_MAX) || undefined;
  return { ok: true, everyMinutes, maxMinutes, ...(until ? { until } : {}), ...(ignore ? { ignore } : {}), reason, ...(body.standing === true ? { standing: true as const, ...(label !== STANDING_DEFAULT_LABEL ? { label } : {}) } : {}) };
}

/** A standing watch's label: default when absent, null when malformed. */
export function parseStandingLabel(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return STANDING_DEFAULT_LABEL;
  if (typeof value !== "string") return null;
  const label = value.trim().toLowerCase();
  return /^[\p{L}\p{N} ._#:-]{1,40}$/u.test(label) ? label : null;
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

/** Where a wake is kept: the conversation's one ordinary wake, or its standing watch beside it. */
/** Standing watches: several per conversation, one per label, beside the
 * one ordinary wake. Keys written before labels existed read as "default". */
const STANDING = "\u0000standing";
export const STANDING_DEFAULT_LABEL = "default";
export const STANDING_MAX_PER_THREAD = 5;
const standingKey = (threadId: string, label = STANDING_DEFAULT_LABEL) => `${threadId}${STANDING}\u0000${label}`;
const wakeKey = (wake: Pick<BotWake, "threadId" | "watch">): string => (wake.watch?.standing ? standingKey(wake.threadId, wake.watch.label) : wake.threadId);

export class BotAutonomy {
  private wakes = new Map<string, BotWake>();
  private goals = new Map<string, BotGoal>();
  private reports = new Map<string, PendingReports>();
  private inFlight: InFlight[] = [];
  private standingLost = new Map<string, StandingLost>();
  private promises: BotPromise[] = [];
  private ownerPending: OwnerPending[] = [];
  /** The bot's recent writes to watched sources, per bot (not persisted). */
  private selfWrites = new Map<string, SelfWrite[]>();
  /** Each watch's complete output lines of its last run (not persisted: after a restart nothing is an echo). */
  private lastLines = new Map<string, string[]>();
  /** Per bot, the start of each message its Chat watches showed, and when (insertion order = age). */
  private seenChat = new Map<string, Map<string, number>>();
  /** Leases a restart cut off, as found on load. */
  readonly recoveredOnLoad: RecoveredLease[] = [];
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
          this.wakes.set(wakeKey(wake), wake);
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
      for (const promise of raw.promises ?? []) {
        if (promise && typeof promise.id === "string" && typeof promise.threadId === "string" && typeof promise.botId === "string" && Number.isFinite(promise.dueAt)) this.promises.push(promise);
      }
      for (const pending of raw.ownerPending ?? []) {
        if (pending && typeof pending.id === "string" && typeof pending.threadId === "string" && typeof pending.botId === "string" && typeof pending.title === "string") this.ownerPending.push(pending);
      }
      for (const lost of raw.standingLost ?? []) {
        if (lost && typeof lost.threadId === "string" && typeof lost.botId === "string") this.standingLost.set(lost.threadId, lost);
      }
      // Turns a restart cut off: what woke them is due again, marked as such.
      const at = this.now();
      let recovered = false;
      for (const lease of raw.inFlight ?? []) {
        if (!lease || typeof lease.threadId !== "string" || typeof lease.botId !== "string" || at - lease.startedAt > IN_FLIGHT_MAX_AGE_MS) continue;
        recovered = true;
        const what = (lease.kind === "wake" ? lease.wake?.reason : lease.items?.join(" / ")) ?? "";
        const stale = at - lease.startedAt > IN_FLIGHT_STALE_MS;
        this.recoveredOnLoad.push({ botId: lease.botId, threadId: lease.threadId, kind: lease.kind, startedAt: lease.startedAt, stale, what: what.slice(0, 200) });
        if (stale) {
          // not re-run: handed over as a question, with what it was about
          const items = [STALE_PREFIX, lease.kind === "wake" ? `Wake-up note: ${lease.wake?.reason ?? "(none)"}` : "", ...(lease.kind === "reports" ? lease.items ?? [] : [])].filter(Boolean);
          const current = this.reports.get(lease.threadId);
          this.reports.set(lease.threadId, { botId: lease.botId, threadId: lease.threadId, items: [...items, ...(current?.items ?? [])] });
          continue;
        }
        if (lease.kind === "wake" && lease.wake && !this.wakes.has(lease.threadId)) {
          this.wakes.set(lease.threadId, { ...lease.wake, dueAt: at, reason: `${INTERRUPTED_PREFIX} ${lease.wake.reason}`.slice(0, WAKE_REASON_MAX + INTERRUPTED_PREFIX.length + 1) });
          continue;
        }
        const items = lease.kind === "reports" && lease.items?.length
          ? lease.items
          : [`Wake-up note: ${lease.wake?.reason ?? "(none)"}`];
        const current = this.reports.get(lease.threadId);
        this.reports.set(lease.threadId, { botId: lease.botId, threadId: lease.threadId, items: [INTERRUPTED_PREFIX, ...items, ...(current?.items ?? [])] });
      }
      if (recovered) this.save();
    } catch (error) {
      console.error(`[autonomy] ignoring unreadable ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private save(): void {
    if (!this.path) return;
    const ledger: Ledger = { ...(this.promises.length ? { promises: this.promises } : {}), ...(this.ownerPending.length ? { ownerPending: this.ownerPending } : {}), wakes: [...this.wakes.values()], goals: [...this.goals.values()], reports: [...this.reports.values()], inFlight: this.inFlight, standingLost: [...this.standingLost.values()] };
    writeFileAtomic(this.path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  }

  // ── wakes ──────────────────────────────────────────────────────────────

  setWake(botId: string, threadId: string, minutes: number, reason: string): BotWake {
    const at = this.now();
    const wake: BotWake = { botId, threadId, dueAt: at + minutes * this.minuteMs, reason, createdAt: at };
    // the ordinary wake; a standing watch here is kept beside it
    this.wakes.set(threadId, wake);
    this.lastLines.delete(threadId);
    this.save();
    return wake;
  }

  /** A wake that fires early when a watched command's output moves. The
   * first run already happened (its output is the baseline). */
  setWatch(
    botId: string,
    threadId: string,
    input: { command: string; argv: string[]; everyMinutes: number; maxMinutes: number; until?: string; reason: string; baseline: string; baselineFingerprint?: string; standing?: boolean; label?: string; ignore?: string },
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
        ...(input.ignore ? { ignore: input.ignore } : {}),
        baseline: input.baseline,
        ...(input.baselineFingerprint ? { baselineFingerprint: input.baselineFingerprint, lastFingerprint: input.baselineFingerprint } : {}),
        stdoutFingerprint: true,
        lastRunAt: at,
        runs: 1,
        failures: 0,
        changedAt: at,
        reasonAt: at,
        ...(input.standing ? { standing: true as const, maxMs: input.maxMinutes * this.minuteMs, ...(input.label && input.label !== STANDING_DEFAULT_LABEL ? { label: input.label } : {}) } : {}),
      },
    };
    this.wakes.set(wakeKey(wake), wake);
    // a new watch (or one replacing another) starts with no lines of its own
    this.lastLines.delete(wakeKey(wake));
    if (input.standing) this.standingLost.delete(threadId);
    this.save();
    return wake;
  }

  /** How many watches keep the lines of their last run (for tests). */
  keptLineSets(): number {
    return this.lastLines.size;
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
  recordWatchRun(wake: BotWake, result: { ok: boolean; output: string; matched: boolean; fingerprint?: string; truncated?: boolean; lines?: string[]; linesComplete?: boolean; ownMark?: RegExp }): WatchTrigger | null {
    const watch = wake.watch;
    if (!watch || this.wakes.get(wakeKey(wake)) !== wake || watch.trigger) return null;
    watch.lastRunAt = this.now();
    watch.runs += 1;
    // The whole output of the run before (not lastOutput, cut at 20 000
    // characters): what an echo is judged against. Unknown — after a
    // restart, or a run past WATCH_LINES_MAX — means no echo.
    const previous = this.lastLines.get(wakeKey(wake)) ?? null;
    if (result.ok && result.lines && result.linesComplete !== false) this.lastLines.set(wakeKey(wake), result.lines);
    else if (result.ok) this.lastLines.delete(wakeKey(wake));
    watch.lastOutput = result.output;
    if (result.ok && result.lines && watchKindOf(watch.argv) === "chat") this.noteChatSeen(wake.botId, result.lines);
    let fresh: string[] = [];
    if (result.ok && result.lines) {
      // what is new since the run before, past the cut the bot reads
      const hashes = result.lines.map(lineHash);
      if (watch.lineHashes) {
        const seen = new Set(watch.lineHashes);
        fresh = result.lines.filter((_, i) => !seen.has(hashes[i]!));
        if (fresh.length) watch.newLines = clipLines(fresh, 8_000);
      }
      watch.lineHashes = hashes.slice(0, 5_000);
      watch.truncated = result.truncated === true;
    }
    if (result.ok && result.fingerprint && result.fingerprint !== watch.lastFingerprint) {
      watch.changedAt = this.now();
      delete watch.staleAlertedAt;
    }
    let trigger: WatchTrigger | null = null;
    if (!result.ok) {
      watch.failures += 1;
      if (watch.failures >= WATCH_MAX_FAILURES) trigger = "failing";
    } else {
      watch.failures = 0;
      if (result.fingerprint && !watch.stdoutFingerprint) {
        // Set before fingerprints covered stdout only: take this run as the
        // baseline instead of firing on the change of method.
        watch.stdoutFingerprint = true;
        watch.baselineFingerprint = result.fingerprint;
        watch.lastFingerprint = result.fingerprint;
      }
      // A standing watch compares with the output it last saw, a one-shot with the one it was set on.
      const reference = watch.standing ? watch.lastFingerprint ?? watch.baselineFingerprint : watch.baselineFingerprint;
      const changed = reference && result.fingerprint ? result.fingerprint !== reference : result.output !== watch.baseline;
      // A standing watch fires on a match only when it is a new output, not on every run while it matches.
      if (result.matched && (!watch.standing || changed)) trigger = "matched";
      else if (!watch.until && changed) trigger = "changed";
      // the change is only the bot's own comment, post or note: take it as
      // the new baseline without waking the bot
      const echo = trigger === "changed" && result.lines
        ? isEcho(fresh, watchKindOf(watch.argv), this.selfWrites.get(wake.botId) ?? [], this.now(), { ...(result.ownMark ? { mark: result.ownMark } : {}), previous: result.linesComplete === false ? null : previous, current: result.lines })
        : null;
      if (echo?.echo) {
        trigger = null;
        watch.echoAt = this.now();
        // said where the bot and the person see it (server.log and a chip)
        watch.echo = { at: this.now(), lines: fresh.length, reasons: [...new Set(echo.reasons)], sample: fresh[0]!.trim().slice(0, 120) };
        watch.baseline = result.output;
        if (result.fingerprint) watch.baselineFingerprint = result.fingerprint;
      }
      if (result.fingerprint) watch.lastFingerprint = result.fingerprint;
    }
    if (trigger) {
      watch.trigger = trigger;
      watch.fired = (watch.fired ?? 0) + 1;
      wake.dueAt = this.now();
      // a one-shot watch is used up by firing: nothing more to compare
      if (!watch.standing) this.lastLines.delete(wakeKey(wake));
    }
    this.save();
    return trigger;
  }

  /** A write the bot just made to a source its watches may read. */
  noteSelfWrite(botId: string, write: SelfWrite): void {
    const at = this.now();
    const kept = (this.selfWrites.get(botId) ?? []).filter((item) => at - item.at <= ECHO_WINDOW_MS);
    this.selfWrites.set(botId, [...kept, write].slice(-20));
  }

  /** The start of every message a bot's Chat watches showed (40 characters,
   * @mentions aside): a text pasted later that starts the same is a copy,
   * not a post, even once the message scrolled out of the list. Kept 24 h,
   * at most SEEN_CHAT_MAX per bot, in memory. */
  private noteChatSeen(botId: string, lines: readonly string[]): void {
    const at = this.now();
    const seen = this.seenChat.get(botId) ?? new Map<string, number>();
    for (const text of chatTexts(lines)) {
      const start = normalize(withoutLeadingMentions(text)).slice(0, 40);
      if (!start) continue;
      seen.delete(start);
      seen.set(start, at);
    }
    for (const [start, when] of seen) if (at - when > SEEN_CHAT_MS) seen.delete(start);
    while (seen.size > SEEN_CHAT_MAX) seen.delete(seen.keys().next().value!);
    this.seenChat.set(botId, seen);
  }

  /** How many message starts a bot keeps as seen (for tests). */
  seenChatCount(botId: string): number {
    return this.seenChat.get(botId)?.size ?? 0;
  }

  /** Text the bot put on the VM's clipboard: kept as its Chat post only when
   * it is one (server/watch-echo.ts vmChatPostOf), checked against what its
   * Chat watches last showed. True when kept. */
  noteVmClipboard(botId: string, text: string, mark?: RegExp): boolean {
    // a note for the spreadsheet: it starts with the bot's own mark
    const note = mark ? vmSheetNoteOf(text, this.now(), mark) : null;
    if (note) {
      this.noteSelfWrite(botId, note);
      return true;
    }
    // a Chat post: only when every Chat watch of the bot has its last output
    // to tell it from a copied message (none after a restart: in doubt, not kept)
    const chatWatches = [...this.wakes.entries()].filter(([, wake]) => wake.botId === botId && wake.watch && watchKindOf(wake.watch.argv) === "chat");
    if (!chatWatches.length || chatWatches.some(([key]) => !this.lastLines.has(key))) return false;
    // what its Chat watches show now, and every message they showed in the last 24 h
    const shown = [...chatWatches.flatMap(([key]) => chatTexts(this.lastLines.get(key)!)), ...(this.seenChat.get(botId)?.keys() ?? [])];
    const write = vmChatPostOf(text, this.now(), shown);
    if (write) this.noteSelfWrite(botId, write);
    return write !== null;
  }

  /** Standing watches whose output has not changed for `afterMs` and whose
   * newest time stamp is older than `oldMs`: likely looking at the wrong
   * page (gog's oldest-first list). Each is returned once until it changes. */
  staleWatches(afterMs = 3 * 3_600_000, oldMs = 24 * 3_600_000): BotWake[] {
    const at = this.now();
    return [...this.wakes.values()].filter((wake) => {
      const watch = wake.watch;
      if (!watch?.standing || watch.staleAlertedAt !== undefined || watch.failures > 0) return false;
      if (at - (watch.changedAt ?? wake.createdAt) < afterMs) return false;
      const newest = newestStamp(watch.lastOutput ?? watch.baseline);
      return newest !== null && at - newest > oldMs;
    });
  }

  markWatchStaleAlerted(wake: BotWake): void {
    if (!wake.watch) return;
    wake.watch.staleAlertedAt = this.now();
    this.save();
  }

  /** Other watches of this bot, in other conversations, running the same command. */
  sameWatchElsewhere(botId: string, threadId: string, command: string): BotWake[] {
    const norm = (text: string) => text.trim().replace(/\s+/g, " ");
    return [...this.wakes.values()].filter((wake) => wake.botId === botId && wake.threadId !== threadId && wake.watch && norm(wake.watch.command) === norm(command));
  }

  /** A standing watch fired (its turn started, or could not): arm it again on
   * the output it fired on, with a fresh time limit. */
  rearmStanding(wake: BotWake): BotWake | null {
    const watch = wake.watch;
    if (!watch?.standing || this.wakes.get(wakeKey(wake)) !== wake) return null;
    const at = this.now();
    if (watch.lastOutput !== undefined && watch.failures === 0) watch.baseline = watch.lastOutput;
    if (watch.lastFingerprint) watch.baselineFingerprint = watch.lastFingerprint;
    if (watch.trigger) watch.lastTrigger = watch.trigger;
    else delete watch.lastTrigger;
    delete watch.trigger;
    watch.failures = 0;
    wake.createdAt = at;
    wake.dueAt = at + (watch.maxMs ?? WATCH_DEFAULT_MAX_MINUTES * this.minuteMs);
    this.save();
    return wake;
  }

  /** Every standing watch, of every conversation. */
  standingWatches(): BotWake[] {
    return [...this.wakes.values()].filter((wake) => wake.watch?.standing);
  }

  /** Its `ignore` was pointed out (once). */
  markIgnoreWarned(wake: BotWake): void {
    if (!wake.watch) return;
    wake.watch.ignoreWarnedAt = this.now();
    this.save();
  }

  /** A new note for a standing watch, keeping its baseline and schedule. */
  updateStandingReason(threadId: string, label: string, reason: string): BotWake | null {
    const wake = this.standingFor(threadId, label);
    if (!wake?.watch) return null;
    wake.reason = reason.slice(0, WAKE_REASON_MAX);
    wake.watch.reasonAt = this.now();
    this.save();
    return wake;
  }

  /** Is this still the wake kept for its conversation (not replaced or cancelled)? */
  isCurrent(wake: BotWake): boolean {
    return this.wakes.get(wakeKey(wake)) === wake;
  }

  standingFor(threadId: string, label = STANDING_DEFAULT_LABEL): BotWake | null {
    return this.wakes.get(standingKey(threadId, label)) ?? null;
  }

  /** Every watch (standing or not) of a conversation. */
  watchesFor(threadId: string): BotWake[] {
    return [...this.wakes.values()].filter((wake) => wake.threadId === threadId && wake.watch);
  }

  standingsFor(threadId: string): BotWake[] {
    return [...this.wakes.values()].filter((wake) => wake.threadId === threadId && wake.watch?.standing);
  }

  cancelStanding(threadId: string, label = STANDING_DEFAULT_LABEL): BotWake | null {
    const wake = this.wakes.get(standingKey(threadId, label)) ?? null;
    if (wake) {
      this.wakes.delete(standingKey(threadId, label));
      this.lastLines.delete(standingKey(threadId, label));
      if (!this.standingsFor(threadId).length) this.standingLost.set(threadId, { botId: wake.botId, threadId, at: this.now() });
      this.save();
    }
    return wake;
  }

  /** Conversations that had a standing watch and have had no watch at all
   * (standing or one-shot) for `afterMs`, not yet alerted. A one-shot watch
   * keeps it watched while it lasts; the clock restarts when it is gone. */
  standingLostDue(afterMs = STANDING_LOST_ALERT_MS): StandingLost[] {
    const at = this.now();
    return [...this.standingLost.values()].filter((lost) => {
      if (this.watchesFor(lost.threadId).length) {
        lost.at = at;
        return false;
      }
      return !lost.alerted && at - lost.at >= afterMs;
    });
  }

  markStandingLostAlerted(threadId: string): void {
    const lost = this.standingLost.get(threadId);
    if (!lost) return;
    lost.alerted = true;
    this.save();
  }

  /** It had a standing watch, has none now, and that has lasted. */
  isStandingLost(threadId: string, afterMs = STANDING_LOST_ALERT_MS): boolean {
    const lost = this.standingLost.get(threadId);
    return Boolean(lost && !this.watchesFor(threadId).length && this.now() - lost.at >= afterMs);
  }

  // ── promises ───────────────────────────────────────────────────────────

  addPromise(botId: string, threadId: string, text: string, minutes: number): BotPromise {
    const at = this.now();
    const used = new Set(this.promises.map((promise) => promise.id));
    let n = this.promises.length + 1;
    while (used.has(`p${n}`)) n += 1;
    const promise: BotPromise = { id: `p${n}`, botId, threadId, text, dueAt: at + minutes * this.minuteMs, createdAt: at };
    this.promises = [...this.promises.filter((open) => open.threadId !== threadId || open.text !== text), promise];
    const mine = this.promises.filter((open) => open.threadId === threadId);
    if (mine.length > PROMISES_MAX_PER_THREAD) this.promises = this.promises.filter((open) => open !== mine[0]);
    this.save();
    return promise;
  }

  /** Marks kept (removes) one promise of this conversation by id, or all with "all". */
  keepPromise(threadId: string, id: string): BotPromise[] {
    const kept = this.promises.filter((promise) => promise.threadId === threadId && (id === "all" || promise.id === id));
    if (!kept.length) return [];
    this.promises = this.promises.filter((promise) => !kept.includes(promise));
    this.save();
    return kept;
  }

  promisesFor(threadId: string): BotPromise[] {
    return this.promises.filter((promise) => promise.threadId === threadId);
  }

  // ── what waits on the person ───────────────────────────────────────────

  /** Add (or refresh, same key or title in the conversation) one item. */
  addOwnerPending(botId: string, threadId: string, input: { title: string; due?: string; link?: string; key?: string }): OwnerPending {
    const title = input.title.replace(/\s+/g, " ").trim().slice(0, OWNER_PENDING_TITLE_MAX);
    const same = (open: OwnerPending) => open.threadId === threadId && (input.key ? open.key === input.key : open.title === title);
    const existing = this.ownerPending.find(same);
    const used = new Set(this.ownerPending.map((open) => open.id));
    let n = this.ownerPending.length + 1;
    while (used.has(`o${n}`)) n += 1;
    const pending: OwnerPending = {
      id: existing?.id ?? `o${n}`, botId, threadId, title, createdAt: existing?.createdAt ?? this.now(),
      ...(input.due?.trim() ? { due: input.due.trim().slice(0, 80) } : {}),
      ...(input.link?.trim() ? { link: input.link.trim().slice(0, 500) } : {}),
      ...(input.key ? { key: input.key } : {}),
    };
    this.ownerPending = [...this.ownerPending.filter((open) => !same(open)), pending];
    const mine = this.ownerPending.filter((open) => open.threadId === threadId);
    if (mine.length > OWNER_PENDING_MAX_PER_THREAD) this.ownerPending = this.ownerPending.filter((open) => open !== mine[0]);
    this.save();
    return pending;
  }

  /** Resolve one item of a bot by id, all of a conversation with "all", or a server item by key. */
  resolveOwnerPending(match: { botId?: string; threadId?: string; id?: string; key?: string }): OwnerPending[] {
    const done = this.ownerPending.filter((open) =>
      (match.botId === undefined || open.botId === match.botId)
      && (match.key !== undefined ? open.key === match.key
        : match.id === "all" ? open.threadId === match.threadId
          : open.id === match.id));
    if (!done.length) return [];
    this.ownerPending = this.ownerPending.filter((open) => !done.includes(open));
    this.save();
    return done;
  }

  ownerPendingFor(threadId: string): OwnerPending[] {
    return this.ownerPending.filter((open) => open.threadId === threadId);
  }

  ownerPendingOf(botId: string): OwnerPending[] {
    return this.ownerPending.filter((open) => open.botId === botId);
  }

  /** Past their time, not kept, not yet reported. */
  overduePromises(): BotPromise[] {
    const at = this.now();
    return this.promises.filter((promise) => promise.overdueAt === undefined && promise.dueAt <= at);
  }

  markPromiseOverdue(id: string): void {
    const promise = this.promises.find((open) => open.id === id);
    if (!promise) return;
    promise.overdueAt = this.now();
    this.save();
  }


  /** Put back a wake that was taken but could not start (the thread got
   * busy in between); it stays due and keeps its original note and time. */
  restoreWake(wake: BotWake): void {
    this.inFlight = this.inFlight.filter((lease) => lease.wake !== wake);
    if (!this.wakes.has(wakeKey(wake))) this.wakes.set(wakeKey(wake), wake);
    this.save();
  }

  /** Take a due wake for a turn; it stays on disk until settleInFlight. A
   * standing watch is not taken at all (it re-arms instead). */
  leaseWake(wake: BotWake): void {
    if (wake.watch?.standing) return;
    if (this.wakes.get(wake.threadId) === wake) this.wakes.delete(wake.threadId);
    // a one-shot watch handed to its turn (fired, or out of time): its lines go
    if (wake.watch) this.lastLines.delete(wake.threadId);
    this.inFlight.push({ kind: "wake", botId: wake.botId, threadId: wake.threadId, startedAt: this.now(), wake });
    this.save();
  }

  /** A turn a lease was handed to failed to start after it was dispatched
   * (the VM, docker or the engine gave up; no turn.completed will come).
   * The wake or reports go back, due after a wait that doubles with each
   * failure (1 min … DISPATCH_RETRY_MAX_MINUTES). Returns what went back. */
  returnFailedDispatch(threadId: string, reason: string): Array<{ kind: InFlight["kind"]; failures: number; delayMs: number }> {
    const leases = this.inFlight.filter((lease) => lease.threadId === threadId);
    if (!leases.length) return [];
    this.inFlight = this.inFlight.filter((lease) => lease.threadId !== threadId);
    const at = this.now();
    const delay = (failures: number) => Math.min(this.minuteMs * 2 ** (failures - 1), DISPATCH_RETRY_MAX_MINUTES * this.minuteMs);
    const note = `[O turno anterior não começou (${reason.slice(0, 160)}); tentando de novo.]`;
    const back: Array<{ kind: InFlight["kind"]; failures: number; delayMs: number }> = [];
    for (const lease of leases) {
      if (lease.kind === "wake" && lease.wake) {
        if (this.wakes.has(threadId)) continue; // a newer wake replaced it
        const failures = (lease.wake.dispatchFailures ?? 0) + 1;
        const reasonText = lease.wake.reason.startsWith("[O turno anterior não começou") ? lease.wake.reason.replace(/^\[O turno anterior não começou[^\]]*\] /, "") : lease.wake.reason;
        this.wakes.set(threadId, { ...lease.wake, dueAt: at + delay(failures), dispatchFailures: failures, reason: `${note} ${reasonText}`.slice(0, WAKE_REASON_MAX + 200) });
        back.push({ kind: "wake", failures, delayMs: delay(failures) });
      } else if (lease.kind === "reports" && lease.items?.length) {
        const current = this.reports.get(threadId);
        const failures = (current?.dispatchFailures ?? 0) + 1;
        this.reports.set(threadId, { botId: lease.botId, threadId, items: [...lease.items, ...(current?.items ?? [])], notBefore: at + delay(failures), dispatchFailures: failures });
        back.push({ kind: "reports", failures, delayMs: delay(failures) });
      }
    }
    this.save();
    return back;
  }

  /** The turn a lease was handed to finished (well or not): forget it. */
  settleInFlight(threadId: string): void {
    const before = this.inFlight.length;
    this.inFlight = this.inFlight.filter((lease) => lease.threadId !== threadId);
    this.standingLost.delete(threadId);
    if (this.inFlight.length !== before) this.save();
  }

  inFlightFor(threadId: string): InFlight[] {
    return this.inFlight.filter((lease) => lease.threadId === threadId);
  }

  wakeFor(threadId: string): BotWake | null {
    return this.wakes.get(threadId) ?? null;
  }

  cancelWake(threadId: string): BotWake | null {
    const wake = this.wakes.get(threadId) ?? null;
    if (wake) {
      this.wakes.delete(threadId);
      this.lastLines.delete(threadId);
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
    const at = this.now();
    return [...this.reports.values()].filter((pending) => pending.items.length > 0 && (pending.notBefore ?? 0) <= at);
  }

  takeReports(threadId: string): PendingReports | null {
    const pending = this.reports.get(threadId) ?? null;
    if (!pending) return null;
    this.reports.delete(threadId);
    this.save();
    return pending;
  }

  /** takeReports for a turn: kept on disk until settleInFlight. */
  leaseReports(threadId: string): PendingReports | null {
    const pending = this.reports.get(threadId) ?? null;
    if (!pending) return null;
    this.reports.delete(threadId);
    this.inFlight.push({ kind: "reports", botId: pending.botId, threadId, startedAt: this.now(), items: pending.items });
    this.save();
    return pending;
  }

  /** Put reports back when their turn could not start. */
  restoreReports(pending: PendingReports): void {
    this.inFlight = this.inFlight.filter((lease) => !(lease.kind === "reports" && lease.threadId === pending.threadId && lease.items === pending.items));
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

  /** Goals stopped to ask the person something. */
  needsInputGoals(): BotGoal[] {
    return [...this.goals.values()].filter((goal) => goal.status === "needs-input");
  }

  /** A goal waiting on the person whose question the world already answered
   * (the PR it asked about was merged or closed): closed as completed. */
  resolveNeedsInput(threadId: string, detail: string, status: "completed" | "blocked" = "completed"): BotGoal | null {
    const goal = this.goals.get(threadId);
    if (!goal || goal.status !== "needs-input") return null;
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

  /** Should the Mac stay awake for self-paced work? A goal running, reports
   * or a leased turn in flight, or a wake/watch due within `horizonMs`. */
  wakeHold(horizonMs: number): { hold: boolean; reason?: "running" | "due"; at?: number } {
    if (this.activeGoals().length || this.reportThreads().length || this.inFlight.length) return { hold: true, reason: "running" };
    const at = this.now();
    const due = [
      ...[...this.wakes.values()].map((wake) => wake.watch && !wake.watch.trigger ? Math.min(wake.dueAt, wake.watch.lastRunAt + wake.watch.everyMs) : wake.dueAt),
      ...this.promises.filter((promise) => promise.overdueAt === undefined).map((promise) => promise.dueAt),
    ]
      .filter((when) => when <= at + horizonMs)
      .sort((a, b) => a - b)[0];
    return due === undefined ? { hold: false } : { hold: true, reason: "due", at: due };
  }

  /** Drop everything tied to a conversation that no longer exists. */
  forgetThread(threadId: string): void {
    for (const key of this.lastLines.keys()) if (key === threadId || key.startsWith(`${threadId}${STANDING}`)) this.lastLines.delete(key);
    let hadStanding = false;
    for (const wake of this.standingsFor(threadId)) hadStanding = this.wakes.delete(wakeKey(wake)) || hadStanding;
    const hadWake = this.wakes.delete(threadId) || hadStanding;
    const hadGoal = this.goals.delete(threadId);
    const hadReports = this.reports.delete(threadId);
    const hadPromises = this.promises.some((promise) => promise.threadId === threadId);
    this.promises = this.promises.filter((promise) => promise.threadId !== threadId);
    const hadPending = this.ownerPending.some((open) => open.threadId === threadId);
    this.ownerPending = this.ownerPending.filter((open) => open.threadId !== threadId);
    this.inFlight = this.inFlight.filter((lease) => lease.threadId !== threadId);
    if (hadWake || hadGoal || hadReports || hadPromises || hadPending) this.save();
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
  return [
    `Modo objetivo ligado nesta conversa: até ${goal.maxTurns} turnos ou ${minutesLabel(goal.deadlineAt - goal.startedAt)}. Quando este turno terminar, você recebe o próximo automaticamente.`,
    "Quando estiver esperando algo fora desta conversa (CI, deploy, revisão), use wake_when com um comando só de leitura que mostre o estado — não custa nada até o estado mudar — ou wake_me para um despertador simples, e encerre o turno em vez de ficar consultando.",
    "Quando colegas a quem você delegou ainda estiverem trabalhando, apenas encerre o turno: os resultados deles te acordam aqui.",
    "Chame goal_end com status completed só quando a entrega estiver comprovadamente feita, blocked quando não puder seguir, ou needs_input quando só a pessoa puder decidir. Nunca declare conclusão que você não conferiu.",
  ].join(" ");
}

// Each harness-written turn message ends with the reply-language reminder
// (server/reply-language.ts): it is machine English, and what the model
// reads last sets the language it answers people in.
export function goalContinuationPrompt(goal: BotGoal, now: number, reminder = languageReminder()): string {
  return [
    `[Goal mode — turn ${goal.turnCount} of ${goal.maxTurns}, ${minutesLabel(goal.deadlineAt - now)} left. Nobody typed this; the harness continues your goal.]`,
    `Goal: ${goal.goal}`,
    "Use this conversation as your progress ledger: check what is already done before repeating anything.",
    ...GOAL_RULES,
    reminder,
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
    `Your ${watch.standing ? "standing " : ""}watch \`${watch.command}\` ran ${watch.runs} time(s); you are woken because ${why}.`,
    ...(watch.standing ? ["It stays armed: the server re-arms it on this output after this turn, so do not call wake_when again for it."] : []),
    `${watch.standing ? "Output it last compared against" : "Output when you set it"}:\n${clipOutput(watch.baseline)}`,
    ...(watch.lastOutput !== undefined && watch.lastOutput !== watch.baseline ? [`Latest output:\n${clipOutput(watch.lastOutput)}`] : []),
    // the output is cut: what changed may be past the cut, so say it here
    ...(watch.truncated && watch.newLines?.length ? [`The output is longer than what is shown above. Lines new or changed since the run before (${watch.newLines.length}):\n${watch.newLines.join("\n")}`] : []),
    ...(watch.truncated && !watch.newLines?.length ? ["The output is longer than what is shown above: fetch it again if you need the rest."] : []),
  ];
}

/** Lines, whole, up to `max` characters in all. */
function clipLines(lines: string[], max: number): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > max) break;
    kept.push(line);
    size += line.length + 1;
  }
  return kept;
}

export function wakePrompt(wake: BotWake, goal: BotGoal | null, now: number, reminder = languageReminder()): string {
  return [
    `[${wake.watch ? "Watch" : "Wake-up"} you scheduled ${minutesLabel(now - wake.createdAt)} ago. Nobody typed this.]`,
    ...watchLines(wake),
    // a standing watch's note was written when it was set: it can be stale by now
    wake.watch?.standing && wake.watch.reasonAt !== undefined && now - wake.watch.reasonAt >= 3_600_000
      ? `Your note for this moment, written ${minutesLabel(now - wake.watch.reasonAt)} ago — check it still holds before acting on it; if not, give it a current one with wake_when update_reason (same label): ${wake.reason}`
      : `Your note for this moment: ${wake.reason}`,
    ...(goal && goal.status === "active"
      ? [`You are in goal mode (turn ${goal.turnCount} of ${goal.maxTurns}). Goal: ${goal.goal}`, ...GOAL_RULES]
      : ["Do what the note says. If it still is not ready, call wake_when or wake_me again; if it is, report the result here."]),
    reminder,
  ].join("\n");
}

// Chips are read by people, in the owner's language (pt-BR): short, cut on
// a word, no backticks, and never the raw command a watch runs.

/** `text` on one line, without backticks, cut at a word boundary with "…". */
export function chipText(text: string, max: number): string {
  const clean = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.(—-]+$/, "")}…`;
}

/** A short name for what a watch looks at: "PR #9300", "Chat", a host. */
export function watchLabel(command: string): string {
  const words = command.trim().split(/\s+/).map((word) => word.replace(/^['"]|['"]$/g, ""));
  const [program, group] = words;
  // a number right after a flag is its value (--limit 30, -L 30), not an item
  const number = words.find((word, i) => i > 1 && /^#?\d+$/.test(word) && !words[i - 1]!.startsWith("-"))?.replace("#", "");
  if (program === "gh") {
    if (group === "pr") return number ? `PR #${number}` : "PRs";
    if (group === "issue") return number ? `issue #${number}` : "issues";
    if (group === "run" || group === "workflow") return number ? `execução #${number} do CI` : "execuções do CI";
    if (group === "release") return "releases";
    if (group === "api") {
      const pull = /pulls\/(\d+)/.exec(command) ?? /issues\/(\d+)/.exec(command);
      return pull ? `#${pull[1]} no GitHub` : "GitHub";
    }
    return "GitHub";
  }
  if (program === "gog") return words.includes("sheets") ? "Planilha" : words.includes("chat") ? "Chat" : "Google";
  if (program === "git") {
    const tag = words.find((word) => word.startsWith("refs/tags/"));
    return tag ? `tag ${tag.slice("refs/tags/".length)}` : words.includes("ls-remote") ? "repositório remoto" : "repositório";
  }
  if (program === "curl") {
    const url = words.find((word) => /^https?:\/\//i.test(word));
    try {
      if (url) return new URL(url).host;
    } catch { /* fall through */ }
  }
  return chipText(words.slice(0, 3).join(" "), 40);
}

const hhmm = (ms: number): string => {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

export function wakeChip(wake: BotWake): string {
  const reason = chipText(wake.reason, 100);
  if (wake.watch) {
    const every = Math.round(wake.watch.everyMs / 60_000) || 1;
    const label = watchLabel(wake.watch.command);
    if (wake.watch.standing) return `Vigia permanente${wake.watch.label ? ` "${wake.watch.label}"` : ""} em ${label} a cada ${every} min — ${reason}`;
    return `Vigiando ${label} a cada ${every} min até ${hhmm(wake.dueAt)} — ${reason}`;
  }
  return `Despertador às ${hhmm(wake.dueAt)} — ${chipText(wake.reason, 120)}`;
}

/** The chip for a wake that fires: what woke the bot, in a few words. */
export function wakeFiredChip(wake: BotWake): string {
  if (!wake.watch) return `Acordou — ${chipText(wake.reason, 140)}`;
  const why = { changed: "mudou", matched: "condição atingida", failing: "comando falhando" }[wake.watch.trigger ?? "changed"];
  return `${wake.watch.standing ? `Vigia permanente${wake.watch.label ? ` "${wake.watch.label}"` : ""}` : "Vigia"} disparou (${wake.watch.trigger ? why : "tempo esgotado"}) em ${watchLabel(wake.watch.command)} — ${chipText(wake.reason, 110)}`;
}

export function goalEndChip(goal: BotGoal): string {
  const label = {
    completed: "Objetivo concluído",
    blocked: "Objetivo bloqueado",
    "needs-input": "Objetivo esperando você",
    stopped: "Objetivo parado",
    limit: "Objetivo pausado no limite",
  }[goal.status as Exclude<GoalStatus, "active">];
  return `${label} após ${goal.turnCount} turno${goal.turnCount === 1 ? "" : "s"}${goal.detail ? ` — ${chipText(goal.detail, 160)}` : ""}`;
}

export function reportsPrompt(pending: PendingReports, goal: BotGoal | null, reminder = languageReminder()): string {
  return [
    `[${pending.items.length === 1 ? "A report arrived" : `${pending.items.length} reports arrived`} — from Claude Code sessions you manage or from the harness. Nobody typed this.]`,
    ...pending.items,
    ...(goal && goal.status === "active" ? [`You are in goal mode (turn ${goal.turnCount} of ${goal.maxTurns}). Goal: ${goal.goal}`] : []),
    reminder,
  ].join("\n\n---\n\n");
}

/** For the bot (and its Chief) when a promise passed its time unkept. */
export function promiseOverdueReport(promise: BotPromise, botName: string, now: number): string {
  return [
    `[Promise overdue by ${minutesLabel(now - promise.dueAt)}: ${botName} promised "${promise.text}" (${promise.id}), due ${minutesLabel(now - promise.createdAt)} after it was made, and it was not marked kept.]`,
    "Send what was promised now, or tell the person when it will come and why — then mark it kept with wake_me promise_kept and promise_proof (the sent message's ID). If it was already sent, mark it kept with that message's ID; without an ID it was not sent.",
  ].join("\n");
}

/** The PRs a goal's question cites: links (owner/repo) and "PR #N" / "#N". */
export function prsCited(text: string): Array<{ number: number; slug?: string }> {
  const found = new Map<number, string | undefined>();
  for (const match of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) found.set(Number(match[2]), match[1]);
  for (const match of text.matchAll(/\b(?:PR|pull request)\s*#?(\d{2,6})\b/gi)) if (!found.has(Number(match[1]))) found.set(Number(match[1]), undefined);
  return [...found].map(([number, slug]) => ({ number, ...(slug ? { slug } : {}) }));
}

/** A goal left waiting on the person this long is not "needs you" any more:
 * it is shown as stopped, and the question as unanswered. */
export const NEEDS_INPUT_EXPIRE_MS = 12 * 3_600_000;

/** A bot's own reply that ends by asking the person something ("Posso
 * trocar?"): its time, or null. Only the conversation's last text counts,
 * and only as an answer to the person: a greeting a new bot opens with
 * ("What would you like me to do?") has no message of theirs before it. */
export function lastQuestionAt(messages: ReadonlyArray<{ role: string; kind: string; text?: string; at: number }>, now: number, maxAgeMs = 24 * 3_600_000): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.kind !== "text") continue;
    if (message.role !== "bot") return null;
    const text = (message.text ?? "").replace(/[\s*_`)\]\p{Extended_Pictographic}\uFE0F]+$/u, "");
    const answersPerson = messages.slice(0, i).some((earlier) => earlier.role === "user" && earlier.kind === "text");
    return answersPerson && text.endsWith("?") && now - message.at < maxAgeMs ? message.at : null;
  }
  return null;
}

/** "Preciso de você", "Continuam com você", "Decisão para você"…: the bot
 * asks the person for something in plain words, not only with a "?". */
const OWNER_ASK = /\b(preciso (?:que voc[êe]|de voc[êe]|da sua|do seu|de uma decis[ãa]o)|precisa de voc[êe]|continua(?:m)? com voc[êe]|fica(?:m)? com voc[êe]|decis[ãa]o (?:para voc[êe]|sua)|pend[êe]ncias? (?:com voc[êe]|do dono|suas)|aguardo (?:a sua|o seu|sua|seu)|s[óo] voc[êe] pode|need (?:you|your)|waiting (?:on|for) you)/i;

/** Since when the bot has been waiting on the person: the first of its
 * replies, after the person's last message, that asks them something (a
 * question at its end, or an explicit ask anywhere in it). It holds until the
 * person writes again, however many replies come after. null when none, or
 * older than `maxAgeMs`. */
export function ownerAskAt(messages: ReadonlyArray<{ role: string; kind: string; text?: string; at: number; peerAsk?: unknown; from?: unknown }>, now: number, maxAgeMs = 48 * 3_600_000): number | null {
  const fromPerson = (message: { role: string; kind: string; peerAsk?: unknown; from?: unknown }) => message.role === "user" && message.kind === "text" && !message.peerAsk && !message.from;
  const lastPerson = messages.findLastIndex(fromPerson);
  if (lastPerson < 0) return null; // a greeting nobody answered yet asks nothing of anyone
  for (const message of messages.slice(lastPerson + 1)) {
    // once another bot speaks to it, what it asks is for that bot
    if (message.role === "user" && message.peerAsk) break;
    if (message.role !== "bot" || message.kind !== "text" || message.from) continue;
    const text = (message.text ?? "").replace(/[\s*_`)\]\p{Extended_Pictographic}\uFE0F]+$/u, "");
    if ((text.endsWith("?") || OWNER_ASK.test(text)) && now - message.at < maxAgeMs) return message.at;
  }
  return null;
}
