// A watcher bot that writes to what it watches wakes on its own write: its
// note in the spreadsheet, its post in the Chat, its comment on an issue. A
// watch run whose every change is the bot's own is that echo: the watch
// takes the new output as its baseline and does not wake the bot.
//
// The rule above all others: IN DOUBT, WAKE. A person's line must never be
// taken for the bot's. So a change is the bot's only when one of these holds,
// line by line, against the complete output of the run before:
// - the new line STARTS with this bot's own mark (`[<Bot name>]`, or
//   `<!-- bot:<its slug> -->`): a note it wrote (a continuation line of the
//   Observações cell, a comment body);
// - the line has the mark further on, and the same line before had the same
//   text up to the mark (only what follows the bot's mark changed). The
//   spreadsheet comes as `gog sheets get --plain`: columns aligned by spaces,
//   no tabs, multi-line cells broken over lines — so nothing is decided by
//   cells, only by what precedes the mark;
// - in a marked row, exactly one field before the mark changed, to a value
//   the bot itself just wrote there (its "Publicado"), each write used once;
// - in the Chat, the message TEXT starts with what the bot just posted (by
//   a `gog chat` command, or typed or pasted through the VM's computer);
// - on an issue, the line holds the start or the end of the body the bot
//   just sent with `gh` (never the issue number alone).
// And every line that disappeared must be accounted for (an old version of
// a line above, the bot's own note, or the oldest lines of a list that
// scrolled off), or it is a change too. Without the complete run before
// (after a restart, or past WATCH_LINES_MAX), nothing is an echo.

export type WatchKind = "issues" | "chat" | "sheets";

export interface SelfWrite {
  at: number;
  kind: WatchKind;
  /** What the write leaves in the output: the start (and for issues the end) of its text. */
  marks: string[];
  /** Short values it set (a spreadsheet's "Publicado"), each good for one line. */
  values?: string[];
  via: "shell" | "vm";
}

/** How long after a write its echo can still show up (the slowest watch runs every 10 min). */
export const ECHO_WINDOW_MS = 15 * 60_000;
/** Shorter text could be anyone's ("ok", "obrigada"). */
const MIN_TEXT_MARK = 10;
const TEXT_MARK_MAX = 40;
const VALUE_MAX = 60;

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

/** Where a text starts (and ends): what a list shows of it. */
function textMarksOf(text: string, withEnd: boolean): string[] {
  const flat = normalize(text);
  if (flat.length < MIN_TEXT_MARK) return [];
  return [...new Set([flat.slice(0, TEXT_MARK_MAX), ...(withEnd ? [flat.slice(-TEXT_MARK_MAX)] : [])])];
}

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
    const marks = body ? textMarksOf(body, true) : [];
    return marks.length ? { at, kind: "issues", marks, via: "shell" } : null;
  }
  if (program === "gog") {
    if (args.includes("chat") && args.some((arg) => GOG_CHAT_WRITES.has(arg.toLowerCase()))) {
      const text = flagValue(bare, ["--text", "-t", "--message"]);
      const marks = text ? textMarksOf(text, false) : [];
      return marks.length ? { at, kind: "chat", marks, via: "shell" } : null;
    }
    if (args.includes("sheets") && args.some((arg) => GOG_SHEETS_WRITES.has(arg.toLowerCase()))) {
      const values = jsonStrings(bare).map(normalize).filter((value) => value && value.length <= VALUE_MAX);
      return values.length ? { at, kind: "sheets", marks: [], values, via: "shell" } : null;
    }
  }
  return null;
}

// ── writes through the VM's computer (typing, pasting) ─────────────────
// The bot posts in the Chat and edits the spreadsheet with the VM's
// browser: the server sees the URL it opened and the text it typed or put
// on the clipboard, and keeps them as its writes.

/** What a URL the VM opened is, for the writes that follow it. */
export function urlKind(url: string): WatchKind | null {
  if (/docs\.google\.com\/spreadsheets/i.test(url)) return "sheets";
  if (/mail\.google\.com\/[^\s"]*chat|chat\.google\.com/i.test(url)) return "chat";
  return null;
}

/** A URL a tool call opens (navigate, open_url, a link in its arguments). */
export function urlOfToolCall(tool: string, input: string | undefined): string | null {
  if (!input || !/navigate|open|goto|url|computer_exec|launch/i.test(tool)) return null;
  return /https?:\/\/[^\s"'<>]+/.exec(input)?.[0] ?? null;
}

const VM_TYPING = /(?:^|__)(?:type|type_text|paste|clipboard_write|fill|browser_type|browser_fill|input_text|send_keys)$/i;

/** Text the bot typed or pasted through the VM, as a write to the page it has open. */
export function vmWriteOf(tool: string, input: string | undefined, openUrl: string | null, at: number): SelfWrite | null {
  if (!input || !openUrl || !VM_TYPING.test(tool)) return null;
  const kind = urlKind(openUrl);
  if (kind !== "chat" && kind !== "sheets") return null;
  let text: string | null = null;
  try {
    const fields = JSON.parse(input) as Record<string, unknown>;
    const value = fields.text ?? fields.value ?? fields.content ?? fields.string;
    if (typeof value === "string") text = value;
  } catch { /* a preview that is not JSON: nothing to keep */ }
  if (!text?.trim()) return null;
  if (kind === "chat") {
    const marks = textMarksOf(text, false);
    return marks.length ? { at, kind, marks, via: "vm" } : null;
  }
  const value = normalize(text);
  return value.length <= VALUE_MAX ? { at, kind, marks: [], values: [value], via: "vm" } : null;
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

const startsWithMark = (line: string, mark: RegExp): boolean => (mark.exec(line)?.index ?? -1) === line.length - line.trimStart().length;
const endsWithMark = (line: string, mark: RegExp): boolean => {
  const end = line.trimEnd().length;
  return [...line.matchAll(new RegExp(mark.source, "gi"))].some((match) => match.index! + match[0].length === end);
};
/** The text before the mark as it is (null without a mark). */
const rawBeforeMark = (line: string, mark: RegExp): string | null => {
  const at = mark.exec(line)?.index;
  return at === undefined || at < 0 ? null : line.slice(0, at);
};
/** The same, spaces collapsed (column widths shift between runs). */
const beforeMark = (line: string, mark: RegExp): string | null => {
  const raw = rawBeforeMark(line, mark);
  return raw === null ? null : normalize(raw);
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
  for (const line of freshLines) {
    const mark = own.mark;
    if (mark && startsWithMark(line, mark)) {
      reasons.push("marca no começo da linha");
      continue;
    }
    // a comment the bot signed: its body ends with its own mark
    if (mark && kind === "issues" && endsWithMark(line, mark)) {
      reasons.push("comentário assinado com a marca do bot");
      continue;
    }
    const prefix = mark ? beforeMark(line, mark) : null;
    if (mark && prefix !== null) {
      const same = removed.find((old) => !old.used && beforeMark(old.line, mark) === prefix);
      if (same) {
        same.used = true;
        reasons.push("só o texto depois da marca mudou");
        continue;
      }
      // one field before the mark changed, to a value the bot just wrote
      const now_ = fields(rawBeforeMark(line, mark)!);
      const value = removed.map((old) => {
        if (old.used) return null;
        const before = rawBeforeMark(old.line, mark);
        if (before === null) return null;
        const then = fields(before);
        if (then.length !== now_.length) return null;
        const changed = now_.filter((field, i) => field !== then[i]);
        if (changed.length !== 1) return null;
        const write = recent.find((each) => each.values?.includes(changed[0]!) && !spent.some((use) => use.write === each && use.value === changed[0]));
        return write ? { old, write, value: changed[0]! } : null;
      }).find(Boolean);
      if (value) {
        value.old.used = true;
        spent.push({ write: value.write, value: value.value });
        reasons.push(`valor "${value.value}" escrito pelo bot`);
        continue;
      }
      return NOT_ECHO;
    }
    // the text the bot just wrote
    const text = kind === "chat" ? normalize(line.split("\t")[3] ?? "") : normalize(line);
    const carried = recent.find((write) => write.marks.some((textMark) => (kind === "chat" ? text.startsWith(textMark) : kind === "issues" && text.includes(textMark))));
    if (!carried) return NOT_ECHO;
    reasons.push(`texto que o bot escreveu ("${carried.marks[0]!.slice(0, 40)}")`);
  }
  // every line that went away: an old version above, the bot's own note, or
  // — in a Chat or issue list that keeps its last N — the oldest lines that
  // scrolled off the end (a spreadsheet's rows never scroll)
  const tail = new Set(kind === "chat" || kind === "issues" ? own.previous.slice(-freshLines.length) : []);
  if (removed.some((old) => !old.used && !(own.mark && startsWithMark(old.line, own.mark)) && !tail.has(old.line))) return NOT_ECHO;
  // the values used are spent: they do not explain another line later
  for (const use of spent) use.write.values = use.write.values?.filter((value, i, all) => !(value === use.value && all.indexOf(value) === i));
  return { echo: true, reasons };
}
