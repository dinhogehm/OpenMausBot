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
import { lineHash, newestStamp } from "./wake-watch.ts";
import { chatStartHash, chatTexts, ECHO_WINDOW_MS, isEcho, normalize, vmChatPostOf, vmSheetNoteOf, watchKindOf, withoutLeadingMentions, type SelfWrite } from "./watch-echo.ts";
import { clipLines } from "./bot-autonomy-text.ts";
import { SEEN_CHAT_MS, SEEN_CHAT_MAX, ECHO_SEEN_PERSIST_MAX, ECHO_LINES_PERSIST_MAX, type EchoMemory, WAKE_REASON_MAX, GOAL_MIN_TURN_GAP_MS, WATCH_DEFAULT_MAX_MINUTES, WATCH_MAX_FAILURES, type WatchTrigger, type BotWake, type GoalStatus, type BotGoal, type PendingReports, type InFlight, IN_FLIGHT_MAX_AGE_MS, IN_FLIGHT_STALE_MS, STALE_PREFIX, DISPATCH_RETRY_MAX_MINUTES, type RecoveredLease, INTERRUPTED_PREFIX, type BotPromise, type OwnerPending, type OwnerPendingAnswer, OWNER_PENDING_AWAIT_MS, REMIND_REPORT_PREFIX, ownerPendingRemindReport, type ResolvedOwnerPending, type OwnerPendingStep, type OwnerPendingOption, OWNER_PENDING_TITLE_MAX, OWNER_PENDING_HISTORY_MAX, OWNER_PENDING_WHY_MAX, oneLine, slimResolved, keepResolved, missingParts, savedDetails, sameOwnerPending, OWNER_PENDING_MAX_PER_THREAD, PROMISES_MAX_PER_THREAD, type Ledger, type StandingLost, STANDING_LOST_ALERT_MS, STANDING, STANDING_DEFAULT_LABEL, standingKey, wakeKey } from "./bot-autonomy-model.ts";
export { SEEN_CHAT_MS, SEEN_CHAT_MAX, ECHO_SEEN_PERSIST_MAX, ECHO_LINES_PERSIST_MAX, WAKE_MIN_MINUTES, WAKE_MAX_MINUTES, WAKE_REASON_MAX, GOAL_TEXT_MAX, GOAL_DETAIL_MAX, GOAL_DEFAULT_MAX_TURNS, GOAL_MAX_TURNS_LIMIT, GOAL_DEFAULT_MAX_HOURS, GOAL_MAX_HOURS_LIMIT, GOAL_MAX_CONSECUTIVE_FAILURES, GOAL_MIN_TURN_GAP_MS, WATCH_MIN_EVERY_MINUTES, WATCH_MAX_EVERY_MINUTES, WATCH_DEFAULT_EVERY_MINUTES, WATCH_MIN_MAX_MINUTES, WATCH_DEFAULT_MAX_MINUTES, WATCH_UNTIL_MAX, WATCH_MAX_FAILURES, type WatchTrigger, type WakeWatch, type BotWake, type GoalEndStatus, type GoalStatus, type BotGoal, type PendingReports, type InFlight, IN_FLIGHT_MAX_AGE_MS, IN_FLIGHT_STALE_MS, STALE_PREFIX, DISPATCH_RETRY_MAX_MINUTES, type RecoveredLease, INTERRUPTED_PREFIX, type BotPromise, type OwnerPending, type OwnerPendingAnswer, ownerPendingVisible, OWNER_PENDING_AWAIT_MS, REMIND_REPORT_PREFIX, ownerPendingRemindReport, type ResolvedOwnerPending, type OwnerPendingStep, type OwnerPendingOption, OWNER_PENDING_TITLE_MAX, OWNER_PENDING_HISTORY_MAX, RESOLVED_PENDING_MAX, RESOLVED_PER_KEY, OWNER_PENDING_OPTION_WHY_MAX, OWNER_PENDING_WHY_MAX, OWNER_PENDING_STEPS_MAX, OWNER_PENDING_STEP_MAX, OWNER_PENDING_OPTIONS_MAX, OWNER_PENDING_OPTION_LABEL_MAX, OWNER_PENDING_OPTION_REPLY_MAX, parseOwnerPendingDetails, recommendedFirst, practicalMissing, missingParts, STEPS_REPORT_PREFIX, ownerPendingStepsAutoReport, ownerPendingRecommendNote, ownerPendingRecommendText, commitsIn, ownerPendingAction, sameOwnerPending, OWNER_PENDING_MAX_PER_THREAD, PROMISE_TEXT_MAX, PROMISE_MAX_MINUTES, PROMISES_MAX_PER_THREAD, type StandingLost, STANDING_LOST_ALERT_MS, type WakeInput, parseWakeInput, type PromiseInput, parsePromiseInput, type WatchInput, parseWatchInput, parseStandingLabel, type GoalInput, parseGoalInput, type GoalEndInput, parseGoalEndInput, STANDING_DEFAULT_LABEL, STANDING_MAX_PER_THREAD } from "./bot-autonomy-model.ts";
export { goalStartedAck, goalContinuationPrompt, wakePrompt, chipText, watchLabel, wakeChip, wakeFiredChip, goalEndChip, reportsPrompt, promiseOverdueReport, prsCited, NEEDS_INPUT_EXPIRE_MS, lastQuestionAt, ownerAskAt, ownerAskText, ownerAsk, echoAsk, askCoveredByItem, ownerPendingReplyText, ownerPendingAwaitNote, ownerPendingStepsRequestText, ownerPendingStepsRequestNote } from "./bot-autonomy-text.ts";

export class BotAutonomy {
  private wakes = new Map<string, BotWake>();
  private goals = new Map<string, BotGoal>();
  private reports = new Map<string, PendingReports>();
  private inFlight: InFlight[] = [];
  private standingLost = new Map<string, StandingLost>();
  private promises: BotPromise[] = [];
  private ownerPending: OwnerPending[] = [];
  private resolvedOwnerPending: ResolvedOwnerPending[] = [];
  /** The bot's recent writes to watched sources, per bot (kept across restarts: saveEcho). */
  private selfWrites = new Map<string, SelfWrite[]>();
  /** Each watch's complete output lines of its last run (kept across restarts for that very output). */
  private lastLines = new Map<string, string[]>();
  /** The fingerprint of the output each `lastLines` entry came from. */
  private lastLinesPrint = new Map<string, string>();
  /** Per bot, the start of each message its Chat watches showed, and when (insertion order = age). */
  private seenChat = new Map<string, Map<string, number>>();
  /** Per bot, the hashes of message starts seen before the last restart (chatStartHash), and when. */
  private seenChatHashes = new Map<string, Map<string, number>>();
  /** Each watch's run before the last restart, as its lines' hashes, until it runs again. */
  private savedLineHashes = new Map<string, { fingerprint: string; hashes: string[] }>();
  /** Leases a restart cut off, as found on load. */
  readonly recoveredOnLoad: RecoveredLease[] = [];
  private readonly path: string | null;
  /** The echo memory's own file, beside the ledger (null: in memory only). */
  private readonly echoPath: string | null;
  private readonly now: () => number;
  private readonly minuteMs: number;
  private readonly turnGapMs: number;

  // plain field assignments, not parameter properties — the server runs
  // under Node's type-stripping, which cannot transform the latter
  // minuteMs/turnGapMs only shrink time for end-to-end tests.
  constructor(opts: { path: string | null; now?: () => number; minuteMs?: number; turnGapMs?: number }) {
    this.path = opts.path;
    this.echoPath = opts.path ? opts.path.replace(/\.json$/, "") + ".echo.json" : null;
    this.now = opts.now ?? Date.now;
    this.minuteMs = opts.minuteMs ?? 60_000;
    this.turnGapMs = opts.turnGapMs ?? GOAL_MIN_TURN_GAP_MS;
    this.load();
    // after the ledger: a watch's lines come back only while the watch does
    this.loadEcho();
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
        if (pending && typeof pending.id === "string" && typeof pending.threadId === "string" && typeof pending.botId === "string" && typeof pending.title === "string") this.ownerPending.push(savedDetails(pending));
      }
      for (const done of raw.resolvedOwnerPending ?? []) {
        if (done && typeof done.id === "string" && typeof done.botId === "string" && typeof done.title === "string" && typeof done.resolvedAt === "number") this.resolvedOwnerPending.push(done);
      }
      this.resolvedOwnerPending = keepResolved(this.resolvedOwnerPending.map((item) => slimResolved(item, item.resolvedAt, item.resolvedBy)));
      const folded = this.foldEquivalentPending();
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
      // saved once the whole ledger is read: an earlier save would drop what is not loaded yet
      if (recovered || folded) this.save();
    } catch (error) {
      console.error(`[autonomy] ignoring unreadable ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private save(): void {
    if (!this.path) return;
    const ledger: Ledger = { ...(this.promises.length ? { promises: this.promises } : {}), ...(this.ownerPending.length ? { ownerPending: this.ownerPending } : {}), ...(this.resolvedOwnerPending.length ? { resolvedOwnerPending: this.resolvedOwnerPending } : {}), wakes: [...this.wakes.values()], goals: [...this.goals.values()], reports: [...this.reports.values()], inFlight: this.inFlight, standingLost: [...this.standingLost.values()] };
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
    // after a restart, the run before is read back from its hashes against this run's lines
    const previous = this.lastLines.get(wakeKey(wake)) ?? this.savedRun(wakeKey(wake), result.ok ? result.lines : undefined);
    if (result.ok) this.savedLineHashes.delete(wakeKey(wake));
    if (result.ok && result.lines && result.linesComplete !== false) {
      this.lastLines.set(wakeKey(wake), result.lines);
      // which output these lines are: after a restart they count only for that very output
      if (result.fingerprint) this.lastLinesPrint.set(wakeKey(wake), result.fingerprint);
      else this.lastLinesPrint.delete(wakeKey(wake));
    } else if (result.ok) this.lastLines.delete(wakeKey(wake));
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
    this.saveEcho();
    return trigger;
  }

  /** A write the bot just made to a source its watches may read. */
  noteSelfWrite(botId: string, write: SelfWrite): void {
    const at = this.now();
    const kept = (this.selfWrites.get(botId) ?? []).filter((item) => at - item.at <= ECHO_WINDOW_MS);
    this.selfWrites.set(botId, [...kept, write].slice(-20));
    this.saveEcho();
  }

  // ── the echo memory, across restarts (R10-intake: after the restart of
  // 13:38 the bot's first post woke its watch once — the run before, its
  // own writes and the messages seen were gone). Kept apart from the
  // ledger, bounded: writes of the last ECHO_WINDOW_MS (≤ 20 per bot), the
  // ECHO_SEEN_PERSIST_MAX newest message starts of the last 24 h per bot,
  // and each live watch's last run — taken back only for the very output it
  // came from (its fingerprint), so a watch that ran elsewhere meanwhile is
  // never compared with lines it did not see. No client text goes to disk
  // (INSP-J r1 #12): a run is kept as its lines' hashes and a message start
  // as its hash; the run is read back against the next run's own lines (a
  // line still there is known again; one gone stays a hash, never anyone's).

  private loadEcho(): void {
    if (!this.echoPath || !existsSync(this.echoPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.echoPath, "utf8")) as Partial<EchoMemory>;
      const at = this.now();
      for (const [botId, writes] of Object.entries(raw.selfWrites ?? {})) {
        const kept = (Array.isArray(writes) ? writes : []).filter((write) => write && typeof write.at === "number" && typeof write.kind === "string" && Array.isArray(write.marks) && at - write.at <= ECHO_WINDOW_MS);
        if (kept.length) this.selfWrites.set(botId, kept.slice(-20));
      }
      for (const [botId, starts] of Object.entries(raw.seenChatHashes ?? {})) {
        const seen = new Map<string, number>();
        for (const pair of Array.isArray(starts) ? starts : []) {
          if (Array.isArray(pair) && typeof pair[0] === "string" && /^[0-9a-f]{16}$/.test(pair[0]) && typeof pair[1] === "number" && at - pair[1] <= SEEN_CHAT_MS) seen.set(pair[0], pair[1]);
        }
        if (seen.size) this.seenChatHashes.set(botId, seen);
      }
      for (const [key, saved] of Object.entries(raw.lastLineHashes ?? {})) {
        const wake = this.wakes.get(key);
        if (!wake?.watch || !saved || !Array.isArray(saved.hashes) || typeof saved.fingerprint !== "string") continue;
        if (wake.watch.lastFingerprint !== saved.fingerprint) continue;
        this.savedLineHashes.set(key, { fingerprint: saved.fingerprint, hashes: saved.hashes.filter((hash): hash is string => typeof hash === "string") });
      }
    } catch (error) {
      console.error(`[autonomy] ignoring unreadable ${this.echoPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The run before a restart, read back against this run's lines: each
   * hash that is one of them is that line again; one that is not stays an
   * opaque placeholder (it went away, and isEcho accounts for it as such). */
  private savedRun(key: string, current: readonly string[] | undefined): string[] | null {
    const saved = this.savedLineHashes.get(key);
    if (!saved || !current) return null;
    const byHash = new Map<string, string>();
    for (const line of current) byHash.set(lineHash(line), line);
    const savedSet = new Set(saved.hashes);
    // a line that grew (a note appended to a spreadsheet row): its old self is a prefix of a new line
    const changed = current.filter((line) => !savedSet.has(lineHash(line))).slice(0, 50);
    const grownFrom = (hash: string): string | undefined => {
      for (const line of changed) {
        for (let end = line.length - 1; end > 0; end -= 1) if (lineHash(line.slice(0, end)) === hash) return line.slice(0, end);
      }
      return undefined;
    };
    return saved.hashes.map((hash) => byHash.get(hash) ?? grownFrom(hash) ?? `\u0000gone:${hash}`);
  }

  private saveEcho(): void {
    if (!this.echoPath) return;
    const at = this.now();
    const memory: EchoMemory = { selfWrites: {}, seenChatHashes: {}, lastLineHashes: {} };
    for (const [botId, writes] of this.selfWrites) {
      const kept = writes.filter((write) => at - write.at <= ECHO_WINDOW_MS);
      if (kept.length) memory.selfWrites[botId] = kept.slice(-20);
    }
    for (const botId of new Set([...this.seenChat.keys(), ...this.seenChatHashes.keys()])) {
      const pairs = new Map<string, number>(this.seenChatHashes.get(botId) ?? []);
      for (const [start, when] of this.seenChat.get(botId) ?? []) pairs.set(chatStartHash(start), Math.max(when, pairs.get(chatStartHash(start)) ?? 0));
      const kept = [...pairs].filter(([, when]) => at - when <= SEEN_CHAT_MS).sort((a, b) => a[1] - b[1]).slice(-ECHO_SEEN_PERSIST_MAX);
      if (kept.length) memory.seenChatHashes[botId] = kept;
    }
    for (const [key, lines] of this.lastLines) {
      const fingerprint = this.lastLinesPrint.get(key);
      if (!fingerprint || !this.wakes.has(key) || lines.length > ECHO_LINES_PERSIST_MAX) continue;
      memory.lastLineHashes[key] = { fingerprint, hashes: lines.map(lineHash) };
    }
    // read back but not run again since the restart: still the run before
    for (const [key, saved] of this.savedLineHashes) if (!memory.lastLineHashes[key] && this.wakes.has(key)) memory.lastLineHashes[key] = saved;
    try {
      writeFileAtomic(this.echoPath, `${JSON.stringify(memory)}\n`, { mode: 0o600 });
    } catch (error) {
      console.error(`[autonomy] could not save ${this.echoPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    const hashes = new Set(this.seenChatHashes.get(botId)?.keys() ?? []);
    for (const start of this.seenChat.get(botId)?.keys() ?? []) hashes.add(chatStartHash(start));
    return hashes.size;
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
    // (or, right after a restart, its run kept as hashes: the messages it showed are among the starts seen)
    if (!chatWatches.length || chatWatches.some(([key]) => !this.lastLines.has(key) && !this.savedLineHashes.has(key))) return false;
    // what its Chat watches show now, and every message they showed in the last 24 h (as text, or as hashes from before a restart)
    const shown = [...chatWatches.flatMap(([key]) => chatTexts(this.lastLines.get(key) ?? [])), ...(this.seenChat.get(botId)?.keys() ?? [])];
    const write = vmChatPostOf(text, this.now(), shown, this.seenChatHashes.get(botId));
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

  /** Add (or refresh, same key or title in the conversation) one item. An
   * equivalent item of the same bot in ANY conversation (sameOwnerPending)
   * is that one: a server item with the same key is refreshed where it is;
   * for anything else the existing item comes back untouched, flagged
   * `duplicate`, so the bot is told "já existe o5" instead of the person
   * getting a second item for the same action. */
  addOwnerPending(botId: string, threadId: string, input: { title: string; due?: string; link?: string; key?: string; command?: string; why?: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[] }): OwnerPending & { duplicate?: true } {
    const title = input.title.replace(/\s+/g, " ").trim().slice(0, OWNER_PENDING_TITLE_MAX);
    const here = (open: OwnerPending) => open.threadId === threadId && (input.key ? open.key === input.key : open.title === title);
    const elsewhere = this.ownerPending.find((open) => open.botId === botId && !here(open) && sameOwnerPending(open, { ...input, title }));
    // a bot's second ask is that one; a server item takes the equivalent one
    // over (its key, so the server can close it; its title, the exact remedy)
    if (elsewhere && !input.key) return { ...elsewhere, duplicate: true };
    const same = (open: OwnerPending) => here(open) || open === elsewhere;
    const existing = this.ownerPending.find(same);
    // an id still answered as an alias is taken: "resolve o8" must never close two items (INSP-H r1 #3)
    const used = new Set(this.ownerPending.flatMap((open) => [open.id, ...(open.aliases ?? [])]));
    let n = this.ownerPending.length + 1;
    while (used.has(`o${n}`)) n += 1;
    const pending: OwnerPending = {
      id: existing?.id ?? `o${n}`, botId, threadId, title, createdAt: existing?.createdAt ?? this.now(),
      ...(input.due?.trim() ? { due: input.due.trim().slice(0, 80) } : existing?.due ? { due: existing.due } : {}),
      ...(input.link?.trim() ? { link: input.link.trim().slice(0, 500) } : existing?.link ? { link: existing.link } : {}),
      ...(input.command?.trim() ? { command: input.command.trim().slice(0, 500) } : existing?.command ? { command: existing.command } : {}),
      ...(input.key ? { key: input.key } : {}),
      ...(existing?.aliases?.length ? { aliases: existing.aliases } : {}),
      // the practical part: what the bot sent now, else what the item had
      ...(input.why?.trim() ? { why: input.why.trim() } : existing?.why ? { why: existing.why } : {}),
      ...(input.steps?.length ? { steps: input.steps } : existing?.steps?.length ? { steps: existing.steps } : {}),
      ...(input.options?.length ? { options: input.options } : existing?.options?.length ? { options: existing.options } : {}),
      // what the person answered stays with the item when the server refreshes it (J18)
      ...(existing?.history?.length ? { history: existing.history } : {}),
      ...(existing?.awaitingSince ? { awaitingSince: existing.awaitingSince } : {}),
      ...(existing?.stepsAutoAskedAt ? { stepsAutoAskedAt: existing.stepsAutoAskedAt } : {}),
    };
    // a server item (same key) found in another conversation follows the server to where it says it now
    this.ownerPending = [...this.ownerPending.filter((open) => !same(open)), pending];
    const mine = this.ownerPending.filter((open) => open.threadId === threadId);
    if (mine.length > OWNER_PENDING_MAX_PER_THREAD) this.ownerPending = this.ownerPending.filter((open) => open !== mine[0]);
    this.save();
    return pending;
  }

  /** Items saved before the dedupe (or by two conversations at once) that ask
   * for the same thing become one: the oldest stays, with the others' ids as
   * aliases (a bot resolving "o7" resolves it) and a link one of them had.
   * True when any was folded (the caller saves). */
  private foldEquivalentPending(): boolean {
    const kept: OwnerPending[] = [];
    let folded = false;
    for (const item of [...this.ownerPending].sort((a, b) => a.createdAt - b.createdAt)) {
      const into = kept.find((open) => open.botId === item.botId && sameOwnerPending(open, item));
      if (!into) {
        kept.push(item);
        continue;
      }
      into.aliases = [...new Set([...(into.aliases ?? []), item.id, ...(item.aliases ?? [])])];
      if (!into.link && item.link) into.link = item.link;
      // and the practical part one of them had (why, steps, options)
      if (!into.why && item.why) into.why = item.why;
      if (!into.steps?.length && item.steps?.length) into.steps = item.steps;
      if (!into.options?.length && item.options?.length) into.options = item.options;
      // and what the person answered on either, in time order (INSP-J2 #13)
      if (item.history?.length) into.history = [...(into.history ?? []), ...item.history].sort((a, b) => a.at - b.at).slice(-OWNER_PENDING_HISTORY_MAX);
      if (item.awaitingSince && (!into.awaitingSince || item.awaitingSince > into.awaitingSince)) into.awaitingSince = item.awaitingSince;
      // a server item's key (and its exact remedy) survives: else the server could never close it (INSP-H r1 #3)
      if (!into.key && item.key) {
        into.key = item.key;
        into.title = item.title;
      }
      folded = true;
      console.log(`[owner-pending] ${item.id} ("${item.title.slice(0, 80)}") is the same as ${into.id} ("${into.title.slice(0, 80)}"): folded into it`);
    }
    if (folded) this.ownerPending = this.ownerPending.filter((item) => kept.includes(item));
    return folded;
  }

  /** Resolve one item of a bot by id, all of a conversation with "all", or a server item by key. */
  resolveOwnerPending(match: { botId?: string; threadId?: string; id?: string; key?: string; by?: ResolvedOwnerPending["resolvedBy"] }): OwnerPending[] {
    const done = this.ownerPending.filter((open) =>
      (match.botId === undefined || open.botId === match.botId)
      && (match.key !== undefined ? open.key === match.key
        : match.id === "all" ? open.threadId === match.threadId
          : open.id === match.id || Boolean(match.id && open.aliases?.includes(match.id))));
    if (!done.length) return [];
    this.ownerPending = this.ownerPending.filter((open) => !done.includes(open));
    // kept for audit, with what the person answered (J18)
    const at = this.now();
    this.resolvedOwnerPending = keepResolved([...this.resolvedOwnerPending, ...done.map((item) => slimResolved(item, at, match.by ?? "server"))]);
    this.save();
    return done;
  }

  /** Settled items, newest last (audit). */
  resolvedOwnerPendingOf(botId?: string): ResolvedOwnerPending[] {
    return this.resolvedOwnerPending.filter((item) => botId === undefined || item.botId === botId);
  }

  /** The person answered `id` (J18): kept in its history; when it reached
   * the bot, the item waits on the bot until it updates or resolves it. */
  recordOwnerPendingAnswer(botId: string, id: string, answer: Omit<OwnerPendingAnswer, "at" | "by">): OwnerPending | null {
    const item = this.ownerPendingById(botId, id);
    if (!item) return null;
    const at = this.now();
    const entry: OwnerPendingAnswer = { at, by: "owner", ...answer, text: answer.text.slice(0, 500), ...(answer.error ? { error: answer.error.slice(0, 300) } : {}) };
    item.history = [...(item.history ?? []), entry].slice(-OWNER_PENDING_HISTORY_MAX);
    // answered (sent or waiting its turn): the item waits on the bot
    if (answer.delivered || answer.queued) item.awaitingSince = at;
    this.save();
    return item;
  }

  /** Answers that were waiting their turn now reached the bot, or did not
   * (INSP-J2 r2 N9): "na fila" becomes "enviado" when the turn starts with
   * them, "não enviado" when it could not start. The bots touched. */
  settleOwnerPendingQueued(match: (item: OwnerPending, entry: OwnerPendingAnswer) => boolean, outcome: { delivered: true } | { error: string }): string[] {
    const touched = new Set<string>();
    // a decision that closed its item may still be waiting its turn: the audit keeps its outcome too
    for (const item of [...this.ownerPending, ...this.resolvedOwnerPending]) {
      if (!item.history?.some((entry) => entry.queued && match(item, entry))) continue;
      // the answer that put the item in wait is the last one sent or queued
      const last = item.history.findLast((entry) => entry.delivered || entry.queued);
      let settledLast = false;
      item.history = item.history.map((entry) => {
        if (!entry.queued || !match(item, entry)) return entry;
        if (entry === last) settledLast = true;
        const { queued: _queued, queueId: _queueId, ...rest } = entry;
        return "error" in outcome ? { ...rest, delivered: false, error: outcome.error.slice(0, 300) } : { ...rest, delivered: true };
      });
      if (settledLast) {
        // INSP-J2 r3 R2: the bot's 2 h count from delivery, not from the queue; an
        // answer that never arrived gives the item back to the person, with why
        if ("error" in outcome) {
          const earlier = item.history.findLast((entry) => entry.delivered || entry.queued);
          if (earlier?.queued) item.awaitingSince = earlier.at;
          else delete item.awaitingSince;
        } else item.awaitingSince = this.now();
      }
      touched.add(item.botId);
    }
    if (touched.size) this.save();
    return [...touched];
  }

  /** The person reminds the bot of an answered item it let go silent
   * (INSP-J2 r2 N3): one system report, never twice while one waits to be
   * read; the item waits on the bot again. null when it is not silent. */
  remindOwnerPending(botId: string, id: string, threadId: string): { item: OwnerPending; deduped: boolean } | "queued" | null {
    const item = this.ownerPendingById(botId, id);
    if (!item || item.awaitingSince === undefined) return null;
    const waiting = this.reports.get(threadId)?.items.some((text) => text.startsWith(`${REMIND_REPORT_PREFIX} ${item.id} `)) ?? false;
    if (waiting) return { item, deduped: true };
    // the person's answer still waits its turn: the bot has not had it yet, and a
    // reminder would not pass it in the queue — said so (INSP-J2 r3 R2, r4 A4)
    if (item.history?.findLast((entry) => entry.delivered || entry.queued)?.queued) return "queued";
    const now = this.now();
    if (now - item.awaitingSince < OWNER_PENDING_AWAIT_MS) return null;
    this.addReport(botId, threadId, ownerPendingRemindReport(item, now));
    this.recordOwnerPendingAnswer(botId, item.id, { kind: "ask", label: "remind", text: "Lembrete enviado pelo OpenMausBot.", delivered: false, queued: true });
    return { item, deduped: false };
  }

  /** One of a bot's items, by id or by an id folded into it. */
  ownerPendingById(botId: string, id: string): OwnerPending | null {
    return this.ownerPending.find((open) => open.botId === botId && (open.id === id || Boolean(open.aliases?.includes(id)))) ?? null;
  }

  /** The bot rewrites one of its items (owner_pending update): the fields it
   * sends replace the item's, an empty list clears steps or options, and a
   * pending "pedir passo a passo" is answered. The item keeps its id, place
   * and age — it is the same ask, said better. null when it is not the bot's. */
  updateOwnerPending(botId: string, id: string, patch: { title?: string; due?: string; link?: string; why?: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[] }): OwnerPending | null {
    const item = this.ownerPendingById(botId, id);
    if (!item) return null;
    const title = patch.title === undefined ? "" : oneLine(patch.title).slice(0, OWNER_PENDING_TITLE_MAX);
    const next: OwnerPending = { ...item, ...(title ? { title } : {}), updatedAt: this.now() };
    const text = (field: "due" | "link" | "why", value: string | undefined, max: number) => {
      if (value === undefined) return;
      const clean = oneLine(value).slice(0, max);
      if (clean) next[field] = clean;
      else delete next[field];
    };
    text("due", patch.due, 80);
    text("link", patch.link, 500);
    text("why", patch.why, OWNER_PENDING_WHY_MAX);
    if (patch.steps !== undefined) {
      if (patch.steps.length) next.steps = patch.steps;
      else delete next.steps;
    }
    if (patch.options !== undefined) {
      if (patch.options.length) next.options = patch.options;
      else delete next.options;
    }
    delete next.stepsRequestedAt;
    // the bot answered the person by rewriting the item: no longer waiting on it (J18)
    delete next.awaitingSince;
    if (patch.options !== undefined) delete next.recommendRequestedAt;
    this.ownerPending = this.ownerPending.map((open) => (open === item ? next : open));
    this.save();
    return next;
  }

  /** The person asked the bot to rewrite an item with steps: shown on the
   * item ("pedido há 2 min") until the bot updates it. */
  markOwnerPendingStepsRequested(botId: string, id: string): OwnerPending | null {
    const item = this.ownerPendingById(botId, id);
    if (!item) return null;
    item.stepsRequestedAt = this.now();
    this.save();
    return item;
  }

  /** Older items still without steps that the server has not asked about
   * yet (J17): asked once each, oldest first. */
  ownerPendingNeedingSteps(): OwnerPending[] {
    // a bot's own items only: the server completes its keyed ones itself (INSP-J2 #5)
    return this.ownerPending.filter((item) => !item.key && missingParts(item).length > 0 && item.stepsAutoAskedAt === undefined).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The server's own items (keyed) still without why or steps — saved by an older build. */
  serverItemsIncomplete(): OwnerPending[] {
    return this.ownerPending.filter((item) => item.key && missingParts(item).length > 0);
  }

  /** Steps reports for `ids` were dropped before reaching the bot (~/.nuria/stop): they may be asked again later. */
  unmarkOwnerPendingStepsAutoAsked(botId: string, ids: readonly string[]): void {
    let changed = false;
    for (const item of this.ownerPending) {
      if (item.botId !== botId || !ids.includes(item.id) || item.stepsAutoAskedAt === undefined) continue;
      delete item.stepsAutoAskedAt;
      if (item.stepsRequestedAt !== undefined) delete item.stepsRequestedAt;
      changed = true;
    }
    if (changed) this.save();
  }

  /** Takes out of a conversation's waiting reports those matching `drop`; returns them. */
  dropReports(threadId: string, drop: (text: string) => boolean): string[] {
    const pending = this.reports.get(threadId);
    if (!pending) return [];
    const gone = pending.items.filter(drop);
    if (!gone.length) return [];
    pending.items = pending.items.filter((text) => !drop(text));
    if (!pending.items.length) this.reports.delete(threadId);
    this.save();
    return gone;
  }

  /** The server asked the bot for `id`'s steps: the screen shows it asked, and it is never asked again by the server. */
  markOwnerPendingStepsAutoAsked(botId: string, id: string): OwnerPending | null {
    const item = this.ownerPendingById(botId, id);
    if (!item) return null;
    item.stepsAutoAskedAt = this.now();
    item.stepsRequestedAt = item.stepsAutoAskedAt;
    this.save();
    return item;
  }

  markOwnerPendingRecommendRequested(botId: string, id: string): OwnerPending | null {
    const item = this.ownerPendingById(botId, id);
    if (!item) return null;
    item.recommendRequestedAt = this.now();
    this.save();
    return item;
  }

  ownerPendingFor(threadId: string): OwnerPending[] {
    return this.ownerPending.filter((open) => open.threadId === threadId);
  }

  ownerPendingOf(botId: string): OwnerPending[] {
    return this.ownerPending.filter((open) => open.botId === botId);
  }

  /** Every open item, all bots (the productivity report's snapshot, lot V). */
  allOwnerPending(): OwnerPending[] {
    return [...this.ownerPending];
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
    // the same report still waiting to be read is not news: one turn, one reminder (R10-followup #4)
    if (pending.items.includes(text)) return;
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

// Chips are read by people, in the owner's language (pt-BR): short, cut on
// a word, no backticks, and never the raw command a watch runs.

