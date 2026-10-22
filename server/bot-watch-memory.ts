// Watch observations and echo memory, sharing the autonomy ledger's wake identities.
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { lineHash } from "./wake-watch.ts";
import { chatStartHash, chatTexts, ECHO_WINDOW_MS, isEcho, normalize, vmChatPostOf, vmSheetNoteOf, watchKindOf, withoutLeadingMentions, type SelfWrite } from "./watch-echo.ts";
import { clipLines } from "./bot-autonomy-text.ts";
import { SEEN_CHAT_MS, SEEN_CHAT_MAX, ECHO_SEEN_PERSIST_MAX, ECHO_LINES_PERSIST_MAX, type EchoMemory, WATCH_MAX_FAILURES, type WatchTrigger, type BotWake, type StandingLost, STANDING, STANDING_DEFAULT_LABEL, standingKey, wakeKey } from "./bot-autonomy-model.ts";

export class BotWatchMemory {
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
  private readonly echoPath: string | null;
  private readonly wakes: Map<string, BotWake>;
  private readonly standingLost: Map<string, StandingLost>;
  private readonly now: () => number;
  private readonly minuteMs: number;
  private readonly save: () => void;

  constructor(opts: { path: string | null; wakes: Map<string, BotWake>; standingLost: Map<string, StandingLost>; now: () => number; minuteMs: number; save: () => void }) {
    this.echoPath = opts.path ? opts.path.replace(/\.json$/, "") + ".echo.json" : null;
    this.wakes = opts.wakes;
    this.standingLost = opts.standingLost;
    this.now = opts.now;
    this.minuteMs = opts.minuteMs;
    this.save = opts.save;
  }

  private standingFor(threadId: string, label = STANDING_DEFAULT_LABEL): BotWake | null {
    return this.wakes.get(standingKey(threadId, label)) ?? null;
  }

  dropLines(key: string): void {
    this.lastLines.delete(key);
  }

  forgetThread(threadId: string): void {
    for (const key of this.lastLines.keys()) if (key === threadId || key.startsWith(`${threadId}${STANDING}`)) this.lastLines.delete(key);
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
    // the same standing watch set again with the same note keeps the note's age
    const before = input.standing ? this.standingFor(threadId, input.label ?? STANDING_DEFAULT_LABEL) : null;
    const sameNote = before?.watch && before.botId === botId && before.reason === input.reason ? before : null;
    const wake: BotWake = {
      botId,
      threadId,
      dueAt: at + input.maxMinutes * this.minuteMs,
      reason: input.reason,
      createdAt: sameNote?.createdAt ?? at,
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
        // a legacy note of unknown age stays unknown ("more than N"), its createdAt kept (INSP-R12F F9)
        ...(sameNote ? (sameNote.watch?.reasonAt !== undefined ? { reasonAt: sameNote.watch.reasonAt } : {}) : { reasonAt: at }),
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

  loadEcho(): void {
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
}
