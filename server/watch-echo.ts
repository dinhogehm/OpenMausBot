// A watcher bot that writes to what it watches wakes on its own write: its
// comment bumps the issue list, its note changes the spreadsheet row, its
// post is the newest Chat message. The server sees the bot's shell commands
// (item.started summaries), so it remembers each write with the marks it
// left — issue numbers, the text it posted or wrote — and a watch run whose
// every new line carries one of those marks is that echo: the watch takes
// the new output as its baseline and does not wake the bot. A new line
// without a mark (a client's message beside the bot's own) wakes it as
// before, so nothing real is swallowed.

export type WatchKind = "issues" | "chat" | "sheets";

export interface SelfWrite {
  at: number;
  kind: WatchKind;
  /** What the write leaves in the watched output: issue numbers, or text. */
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

/** Numbers that name an issue or PR: "#9307", "9307", ".../issues/9307" —
 * outside quoted text, where a body's dates and counts would be. */
function issueNumbers(command: string): string[] {
  const bare = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ").replace(/(?:^|\s)(?:-[bf]|--body|--title|--raw-field|--field|-F)[= ]\S+/g, " ");
  return [...new Set([...bare.matchAll(/(?:^|[\s#/])(\d{3,7})(?=$|[\s/])/g)].map((m) => m[1]!))];
}

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

/** The write a shell command makes to something a watch can read, if any. */
export function selfWriteOf(command: string, at: number): SelfWrite | null {
  const [program, ...args] = words(command);
  if (program === "gh") {
    const [group, action] = args;
    const writes = group === "api" ? GH_API_WRITE.test(command) && /\/(?:issues|pulls)\/\d+/.test(command)
      : (group === "issue" || group === "pr") && Boolean(action && GH_WRITES.has(action));
    if (!writes) return null;
    const marks = issueNumbers(command);
    return marks.length ? { at, kind: "issues", marks } : null;
  }
  if (program === "gog") {
    const kind = args.includes("chat") ? "chat" : args.includes("sheets") ? "sheets" : null;
    if (!kind) return null;
    const verbs = kind === "chat" ? GOG_CHAT_WRITES : GOG_SHEETS_WRITES;
    if (!args.some((arg) => verbs.has(arg.toLowerCase()))) return null;
    const marks = textMarks(command);
    return marks.length ? { at, kind, marks } : null;
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

function carries(line: string, write: SelfWrite): boolean {
  if (write.kind === "issues") return write.marks.some((number) => new RegExp(`(?:^|\\D)${number}(?:\\D|$)`).test(line));
  const text = normalize(line);
  return write.marks.some((mark) => text.includes(mark));
}

/** Every new line comes from the bot's own recent writes to this kind of source. */
export function isEcho(freshLines: readonly string[], kind: WatchKind | null, writes: readonly SelfWrite[], now: number): boolean {
  if (!kind || !freshLines.length) return false;
  const recent = writes.filter((write) => write.kind === kind && now - write.at <= ECHO_WINDOW_MS);
  return recent.length > 0 && freshLines.every((line) => recent.some((write) => carries(line, write)));
}
