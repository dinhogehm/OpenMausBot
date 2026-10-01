// A watcher bot that writes to what it watches wakes on its own write: its
// comment bumps the issue list, its note changes the spreadsheet row, its
// post is the newest Chat message. A watch run whose every new line is the
// bot's own is that echo: the watch takes the new output as its baseline and
// does not wake the bot. Anything else in a new line — a person's comment on
// the same issue, a "Reprovado" in the row the bot annotated — wakes it.
//
// What makes a line the bot's own, first to last:
// - its mark in the content (`<!-- bot:… -->`, `[<Bot name>]`), whatever
//   wrote it (a shell command, the VM's browser): only the marked part of
//   the line — from the mark to the end of its cell — may have changed;
// - the text of a write the server saw the bot make (item.started of a
//   `gh`/`gog` command) in the last ECHO_WINDOW_MS. An issue number alone
//   never counts: a person's comment on the same issue carries it too.

export type WatchKind = "issues" | "chat" | "sheets";

export interface SelfWrite {
  at: number;
  kind: WatchKind;
  /** What the write leaves in the watched output: its text. */
  marks: string[];
}

/** How long after a write its echo can still show up (the slowest watch runs every 10 min). */
export const ECHO_WINDOW_MS = 15 * 60_000;
/** Shorter text could be in anyone's line ("Publicado", "ok"). */
const MIN_TEXT_MARK = 10;
const TEXT_MARK_MAX = 40;

const GH_WRITES = new Set(["comment", "edit", "close", "reopen", "create", "review", "merge", "lock", "unlock", "pin", "unpin", "transfer", "ready"]);
const GH_API_WRITE = /(?:^|\s)(?:-X|--method)\s*(?:POST|PATCH|PUT|DELETE)\b|(?:^|\s)(?:-f|-F|--field|--raw-field|--input)\s/i;
const GOG_CHAT_WRITES = new Set(["send", "create", "reply", "update", "post"]);
const GOG_SHEETS_WRITES = new Set(["update", "append", "write", "clear", "batch-update", "batchupdate", "set"]);

const words = (command: string): string[] => command.trim().split(/\s+/);
const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Quoted text in the command, and the strings inside quoted JSON values. */
function textMarks(command: string): string[] {
  const quoted = [...command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? "");
  const inner = quoted.flatMap((text) => [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!));
  return [...new Set([...quoted, ...inner]
    .map((text) => normalize(text.replace(/\\(.)/g, "$1")))
    // not JSON itself, not a range ("Clientes!H173")
    .filter((text) => text.length >= MIN_TEXT_MARK && !/^[[{]/.test(text) && !/![a-z]+\d/.test(text))
    .map((text) => text.slice(0, TEXT_MARK_MAX)))];
}

/** The write a shell command makes to something a watch can read, if any.
 * A leading `cd <dir> &&` (or `;`) is the same command. */
export function selfWriteOf(command: string, at: number): SelfWrite | null {
  const bare = command.trim().replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, "");
  const [program, ...args] = words(bare);
  let kind: WatchKind | null = null;
  if (program === "gh") {
    const [group, action] = args;
    const writes = group === "api" ? GH_API_WRITE.test(bare) && /\/(?:issues|pulls)\/\d+/.test(bare)
      : (group === "issue" || group === "pr") && Boolean(action && GH_WRITES.has(action));
    if (writes) kind = "issues";
  } else if (program === "gog") {
    const read = args.includes("chat") ? "chat" : args.includes("sheets") ? "sheets" : null;
    const verbs = read === "chat" ? GOG_CHAT_WRITES : GOG_SHEETS_WRITES;
    if (read && args.some((arg) => verbs.has(arg.toLowerCase()))) kind = read;
  }
  if (!kind) return null;
  const marks = textMarks(bare);
  return marks.length ? { at, kind, marks } : null;
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

/** The marks a bot leaves in what it writes: `<!-- bot:… -->`, and `[<name>]`. */
export function botMarkPattern(botName: string): RegExp {
  return new RegExp(`<!--\\s*bot:[^>]*-->|\\[${escape(botName.trim())}\\]`, "i");
}

/** The line with every cell that holds the bot's mark emptied (cells split
 * by a tab or " | "; a line without them is one cell). */
function unmarked(line: string, mark: RegExp): string {
  return line.split(/(\t| \| )/).map((cell, i) => (i % 2 === 0 && mark.test(cell) ? "" : cell)).join("");
}

/** A row's key: its first cell, to find the same row in the run before. */
const rowKey = (line: string): string => line.trim().split(/\t| {2,}| \| /)[0]!.trim();

/** Only the bot's marked cell of this line is new: the same row before is
 * the same once marked cells are emptied. A line with the mark and no row
 * before is one the bot wrote (its comment, its post, the row it opened). */
function onlyMarkedChanged(line: string, previous: readonly string[], mark: RegExp): boolean {
  const kept = unmarked(line, mark);
  if (kept === line) return false;
  const key = rowKey(line);
  const before = key ? previous.filter((old) => old !== line && rowKey(old) === key) : [];
  if (!before.length) return true;
  return before.length === 1 && normalize(unmarked(before[0]!, mark)) === normalize(kept);
}

function carries(line: string, write: SelfWrite): boolean {
  const text = normalize(line);
  return write.marks.some((mark) => text.includes(mark));
}

/** Every new line is the bot's own: marked by it (and only its marked part
 * changed), or carrying the text of one of its recent writes. */
export function isEcho(
  freshLines: readonly string[],
  kind: WatchKind | null,
  writes: readonly SelfWrite[],
  now: number,
  own: { mark?: RegExp; previous?: readonly string[] } = {},
): boolean {
  if (!freshLines.length) return false;
  const recent = kind ? writes.filter((write) => write.kind === kind && now - write.at <= ECHO_WINDOW_MS) : [];
  return freshLines.every((line) =>
    (own.mark ? onlyMarkedChanged(line, own.previous ?? [], own.mark) : false)
    || recent.some((write) => carries(line, write)));
}
