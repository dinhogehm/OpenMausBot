// A watcher bot that writes to what it watches wakes on its own write: its
// note in the spreadsheet, its post in the Chat, its comment on an issue. A
// watch run whose every change is the bot's own is that echo: the watch
// takes the new output as its baseline and does not wake the bot.
//
// The rule above all others: IN DOUBT, WAKE. A person's line must never be
// taken for the bot's. So a change is the bot's only when one of these holds,
// line by line, against the complete output of the run before:
// - a line that was there grew, and what was added starts — after spaces
//   and a separator (" | ", "·", ";", "—") — with this bot's own mark
//   (`[<Bot name>]`, `<!-- bot:<its slug> -->`). That is how its notes are
//   chained in the Observações cell (`… | [Monitor Chat Atendimento] …`).
//   Anything else added, or any edit inside the old text, is a person's;
// - a line that is new and starts with the bot's mark (a continuation line
//   of its note), or — on an issue — a new comment whose body ends with it
//   (the bot signs its comments `<!-- bot:<slug> -->`);
// - in a row whose note grew as above in the same run, exactly one field
//   before the mark changed to a value the bot itself wrote with `gog
//   sheets` (its "Publicado"), never Validado/Reprovado (the requester's);
// - in the Chat, the message TEXT, leading @mentions removed, starts with
//   what the bot posted with `gog chat`;
// - on an issue, the comment's text ends with the end of the body the bot
//   sent with `gh` (words only: no URL, #number or hash; never the issue
//   number alone).
// And every line that disappeared must be the old version of a line that
// grew, or (in a Chat or issue list keeping its last N) the oldest lines
// that scrolled off; else it is a change too. Without the complete run
// before (after a restart, or past WATCH_LINES_MAX), nothing is an echo.
//
// Writes through the VM's computer (typing or pasting into the Chat or the
// spreadsheet in its browser) are NOT recognised: the real calls (a URL put
// on the clipboard then pasted, a mention typed for the autocomplete, the
// body pasted, a search typed with cmd+f) cannot be told apart safely from
// the tool calls alone. Those echoes wake the bot, as before (INSP-E r2 B3).

export type WatchKind = "issues" | "chat" | "sheets";

export interface SelfWrite {
  at: number;
  kind: WatchKind;
  /** What the write leaves in the output: for the Chat the start, for issues the end of its text. */
  marks: string[];
  /** Short values it set (a spreadsheet's "Publicado"), each good for one line. */
  values?: string[];
  via: "shell";
}

/** How long after a write its echo can still show up (the slowest watch runs every 10 min). */
export const ECHO_WINDOW_MS = 15 * 60_000;
/** Shorter text could be anyone's ("ok", "obrigada"). */
const MIN_TEXT_MARK = 10;
/** An issue body's end: at least this much of words (no URL, number or hash). */
const MIN_END_MARK = 20;
const TEXT_MARK_MAX = 40;
const VALUE_MAX = 60;
/** The requester's (or the owner's) column: never a value the bot sets. */
const NEVER_BOT_VALUES = new Set(["validado", "reprovado"]);

const GH_WRITES = new Set(["comment", "edit", "close", "reopen", "create", "review", "merge", "lock", "unlock", "pin", "unpin", "transfer", "ready"]);
const GH_API_WRITE = /(?:^|\s)(?:-X|--method)\s*(?:POST|PATCH|PUT|DELETE)\b|(?:^|\s)(?:-f|-F|--field|--raw-field|--input)\s/i;
const GOG_CHAT_WRITES = new Set(["send", "create", "reply", "update", "post"]);
const GOG_SHEETS_WRITES = new Set(["update", "append", "write", "clear", "batch-update", "batchupdate", "set"]);

const words = (command: string): string[] => command.trim().split(/\s+/);
export const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/** The value of a quoted flag: `--body 'x'`, `--text="y"`. */
function flagValue(command: string, flags: readonly string[]): string | null {
  for (const flag of flags) {
    const match = new RegExp(`(?:^|\\s)${flag}(?:\\s+|=)(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`).exec(command);
    if (match) return (match[1] ?? match[2] ?? "").replace(/\\(.)/g, "$1");
  }
  return null;
}

/** A Chat text without the @mentions it opens with ("@Fulana Tal …"). */
export function withoutLeadingMentions(text: string): string {
  return text.replace(/^(?:\s*@[\p{L}\p{N}._-]+(?:\s+(?:(?:da|de|do|das|dos|e)\s+)?[\p{Lu}][\p{L}.-]*){0,5}[,:]?)+\s*/u, "");
}

/** Only the words of a text: no URL, #number, long number or hash. */
const wordsOnly = (text: string): string => normalize(text.replace(/https?:\/\/\S+/g, " ").replace(/#\d+/g, " ").replace(/\b[0-9a-f]{7,40}\b/gi, " ").replace(/\b\d{3,}\b/g, " "));

/** The strings of a quoted JSON value (`--values-json '[["Publicado"]]'`); none when it is not JSON. */
function jsonStrings(command: string): string[] {
  const found: string[] = [];
  for (const match of command.matchAll(/'(\[[^']*\])'|"(\[(?:[^"\\]|\\.)*\])"/g)) {
    try {
      const parsed = JSON.parse((match[1] ?? match[2]!.replace(/\\"/g, '"'))) as unknown;
      const walk = (value: unknown): void => {
        if (typeof value === "string") found.push(value);
        else if (Array.isArray(value)) value.forEach(walk);
      };
      walk(parsed);
    } catch { /* not JSON: nothing taken from it */ }
  }
  return found;
}

/** The write a shell command makes to something a watch can read, if any.
 * A leading `cd <dir> &&` (or `;`) is the same command. */
export function selfWriteOf(command: string, at: number): SelfWrite | null {
  const bare = command.trim().replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, "");
  const [program, ...args] = words(bare);
  if (program === "gh") {
    const [group, action] = args;
    const writes = group === "api" ? GH_API_WRITE.test(bare) && /\/(?:issues|pulls)\/\d+/.test(bare)
      : (group === "issue" || group === "pr") && Boolean(action && GH_WRITES.has(action));
    const body = writes ? flagValue(bare, ["--body", "-b", "-f body", "--field body", "--raw-field body"]) ?? flagValue(bare, ["-f", "--raw-field", "--field"])?.replace(/^body=/, "") ?? null : null;
    // what a comment list shows is the body's end: its last words
    const end = body ? wordsOnly(body).slice(-TEXT_MARK_MAX).trim() : "";
    return end.length >= MIN_END_MARK ? { at, kind: "issues", marks: [end], via: "shell" } : null;
  }
  if (program === "gog") {
    if (args.includes("chat") && args.some((arg) => GOG_CHAT_WRITES.has(arg.toLowerCase()))) {
      const text = flagValue(bare, ["--text", "-t", "--message"]);
      const start = text ? normalize(withoutLeadingMentions(text)).slice(0, TEXT_MARK_MAX) : "";
      return start.length >= MIN_TEXT_MARK ? { at, kind: "chat", marks: [start], via: "shell" } : null;
    }
    if (args.includes("sheets") && args.some((arg) => GOG_SHEETS_WRITES.has(arg.toLowerCase()))) {
      const values = jsonStrings(bare).map(normalize).filter((value) => value && value.length <= VALUE_MAX && !NEVER_BOT_VALUES.has(value));
      return values.length ? { at, kind: "sheets", marks: [], values, via: "shell" } : null;
    }
  }
  return null;
}

/** What a watch command reads, for matching it with the bot's writes. */
export function watchKindOf(argv: readonly string[]): WatchKind | null {
  const [program, ...args] = argv;
  if (program === "gh") return args[0] === "issue" || args[0] === "pr" || args[0] === "api" ? "issues" : null;
  if (program === "gog") return args.includes("chat") ? "chat" : args.includes("sheets") ? "sheets" : null;
  // a spreadsheet read as CSV, or Chat read through its API
  if (program === "curl") {
    const url = args.join(" ");
    if (/docs\.google\.com\/spreadsheets|sheets\.googleapis\.com/.test(url)) return "sheets";
    if (/chat\.googleapis\.com/.test(url)) return "chat";
  }
  return null;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** This bot's own marks: `[<name>]`, and `<!-- bot:<slug> -->` when it has
 * a slug. Never another bot's `<!-- bot:… -->`. */
export function botMarkPattern(botName: string, slug?: string): RegExp {
  const parts = [`\\[${escape(botName.trim())}\\]`];
  if (slug?.trim()) parts.push(`<!--\\s*bot:${escape(slug.trim())}\\s*-->`);
  return new RegExp(parts.join("|"), "i");
}

/** A slug from a bot's name: "Monitor Chat Atendimento" → "monitor-chat-atendimento". */
export function botSlug(botName: string): string {
  return botName.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const startsWithMark = (text: string, mark: RegExp): boolean => (mark.exec(text)?.index ?? -1) === text.length - text.trimStart().length;
/** What was added after `old` starts with the mark, past spaces and a separator. */
const addedWithMark = (added: string, mark: RegExp): boolean => startsWithMark(added.replace(/^[\s|·;—,-]+/, ""), mark);
const markAt = (line: string, mark: RegExp): number => mark.exec(line)?.index ?? -1;
const endsWithMark = (line: string, mark: RegExp): boolean => {
  const end = line.trimEnd().length;
  return [...line.matchAll(new RegExp(mark.source, "gi"))].some((match) => match.index! + match[0].length === end);
};
/** Fields of the part before the mark: split on runs of 2+ spaces or tabs. */
const fields = (text: string): string[] => text.trim().split(/\t| {2,}/).map(normalize).filter(Boolean);

export interface EchoDecision {
  echo: boolean;
  /** Why each new line was taken for the bot's (only when echo). */
  reasons: string[];
}

const NOT_ECHO: EchoDecision = { echo: false, reasons: [] };

/** Every change between `previous` and the new lines is the bot's own (see
 * the header); else not an echo. `previous` null = the run before is not
 * known in full: never an echo. Values the decision used are spent. */
export function isEcho(
  freshLines: readonly string[],
  kind: WatchKind | null,
  writes: readonly SelfWrite[],
  now: number,
  own: { mark?: RegExp; previous: readonly string[] | null; current: readonly string[] },
): EchoDecision {
  if (!freshLines.length || !own.previous) return NOT_ECHO;
  const recent = kind ? writes.filter((write) => write.kind === kind && now - write.at <= ECHO_WINDOW_MS) : [];
  // what disappeared (multiset): each needs accounting for
  const left = new Map<string, number>();
  for (const line of own.current) left.set(line, (left.get(line) ?? 0) + 1);
  const removed: Array<{ line: string; used: boolean }> = [];
  for (const line of own.previous) {
    const count = left.get(line) ?? 0;
    if (count > 0) left.set(line, count - 1);
    else removed.push({ line, used: false });
  }
  const spent: Array<{ write: SelfWrite; value: string }> = [];
  const reasons: string[] = [];
  const mark = own.mark;
  for (const line of freshLines) {
    // a line that was there and grew
    const grownFrom = removed.find((old) => !old.used && old.line.length < line.length && line.startsWith(old.line));
    if (grownFrom) {
      if (!mark || !addedWithMark(line.slice(grownFrom.line.length), mark)) return NOT_ECHO;
      grownFrom.used = true;
      reasons.push("nota do bot acrescentada com a marca");
      continue;
    }
    if (mark && startsWithMark(line, mark)) {
      reasons.push("linha nova com a marca do bot");
      continue;
    }
    // a new comment the bot signed: its body ends with this bot's own mark
    if (mark && kind === "issues" && endsWithMark(line, mark)) {
      reasons.push("comentário assinado com a marca do bot");
      continue;
    }
    if (mark && markAt(line, mark) > 0) {
      // a Status the bot set, in the same run as its note grew in that row
      const at = markAt(line, mark);
      const set = removed.map((old) => {
        if (old.used) return null;
        const oldAt = markAt(old.line, mark);
        if (oldAt < 0) return null;
        const after = line.slice(at);
        const oldAfter = old.line.slice(oldAt);
        if (!(after.length > oldAfter.length && after.startsWith(oldAfter) && addedWithMark(after.slice(oldAfter.length), mark))) return null;
        const now_ = fields(line.slice(0, at));
        const then = fields(old.line.slice(0, oldAt));
        if (now_.length !== then.length) return null;
        const changed = now_.filter((field, i) => field !== then[i]);
        if (changed.length !== 1 || NEVER_BOT_VALUES.has(changed[0]!)) return null;
        const write = recent.find((each) => each.values?.includes(changed[0]!) && !spent.some((use) => use.write === each && use.value === changed[0]));
        return write ? { old, write, value: changed[0]! } : null;
      }).find(Boolean);
      if (!set) return NOT_ECHO;
      set.old.used = true;
      spent.push({ write: set.write, value: set.value });
      reasons.push(`valor "${set.value}" escrito pelo bot, com a nota dele na mesma linha`);
      continue;
    }
    // the text the bot just wrote
    if (kind === "chat") {
      const text = normalize(withoutLeadingMentions(line.split("\t")[3] ?? ""));
      const carried = recent.find((write) => write.marks.some((textMark) => text.startsWith(textMark)));
      if (!carried) return NOT_ECHO;
      reasons.push(`post do bot ("${carried.marks[0]!.slice(0, 40)}")`);
      continue;
    }
    if (kind === "issues") {
      // the comment list shows "<#N> <login> <id>: <end of the body>"
      const body = wordsOnly(line.slice(line.indexOf(": ") + 2));
      const carried = recent.find((write) => write.marks.some((textMark) => body.endsWith(textMark)));
      if (!carried) return NOT_ECHO;
      reasons.push(`comentário do bot ("${carried.marks[0]!.slice(0, 40)}")`);
      continue;
    }
    return NOT_ECHO;
  }
  // every line that went away: an old version of a line that grew, or — in
  // a Chat or issue list that keeps its last N — the oldest lines that
  // scrolled off the end (a spreadsheet's rows never scroll)
  const tail = new Set(kind === "chat" || kind === "issues" ? own.previous.slice(-freshLines.length) : []);
  if (removed.some((old) => !old.used && !tail.has(old.line))) return NOT_ECHO;
  // the values used are spent: they do not explain another line later
  for (const use of spent) use.write.values = use.write.values?.filter((value, i, all) => !(value === use.value && all.indexOf(value) === i));
  return { echo: true, reasons };
}
