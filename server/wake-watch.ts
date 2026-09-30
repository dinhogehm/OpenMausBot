// The command behind wake_when: checked here, run by the server on a timer,
// with no model in the loop. A bot names something to watch (a PR's checks,
// a workflow run, a health URL) and is woken only when its output changes,
// matches what it waits for, or keeps failing.
//
// The server runs this outside the bot's engine, so none of the engine's
// approval modes or hooks see it. That is why only a closed list of
// read-only commands is accepted, and why they run without a shell:
// argv goes straight to execFile, so pipes, redirects, globbing and
// substitutions never happen. Quoted text is passed through literally
// (a --jq filter may contain "|"); unquoted shell syntax is refused so
// nobody mistakes this for a shell.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const WATCH_COMMAND_MAX = 500;
/** What is kept and shown of an output; changes are detected on the whole. */
export const WATCH_OUTPUT_MAX = 20_000;
/** Largest output a watch may produce (a 70 KB sheet export fits easily). */
export const WATCH_BUFFER_MAX = 4 * 1024 * 1024;
export const WATCH_TIMEOUT_MS = 30_000;

export type ParsedWatch = { ok: true; argv: string[] } | { ok: false; error: string };

const SHELL_SYNTAX = /[|&;<>`$(){}\\\n\r*?~]/;

/** Split like a POSIX shell does for plain words and '…'/"…" quoting only. */
export function splitWords(command: string): string[] | { error: string } {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      continue;
    }
    if (SHELL_SYNTAX.test(char)) {
      return { error: `"${char}" outside quotes: this is not a shell — no pipes, redirects, variables or globs. Put a jq filter in quotes after --jq.` };
    }
    current += char;
    inWord = true;
  }
  if (quote) return { error: "unclosed quote" };
  if (inWord) words.push(current);
  return words;
}

const GH_READS: Record<string, Set<string>> = {
  pr: new Set(["view", "checks", "list", "status"]),
  run: new Set(["view", "list"]),
  issue: new Set(["view", "list", "status"]),
  release: new Set(["view", "list"]),
  workflow: new Set(["view", "list"]),
};
const GH_API_WRITE_FLAGS = new Set(["-X", "--method", "-f", "--raw-field", "-F", "--field", "--input"]);
const GH_BLOCKED_FLAGS = new Set(["--web", "-w"]);
const GOG_READS: Record<string, Set<string>> = {
  "chat messages": new Set(["list"]),
  "chat spaces": new Set(["list", "get"]),
  "chat threads": new Set(["list", "get"]),
  sheets: new Set(["get", "metadata"]),
};
const GIT_READS = new Set(["ls-remote", "log", "rev-parse", "status", "show-ref"]);
const CURL_BLOCKED_FLAGS = new Set([
  "-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json",
  "-F", "--form", "-T", "--upload-file", "-o", "--output", "-O", "--remote-name", "-K", "--config",
]);

const flagName = (word: string): string => (word.startsWith("--") ? word.split("=")[0]! : word.slice(0, 2));

/** Accept only the read-only commands wake_when is for. */
export function parseWatchCommand(command: unknown): ParsedWatch {
  if (typeof command !== "string" || !command.trim()) return { ok: false, error: "command is required" };
  if (command.length > WATCH_COMMAND_MAX) return { ok: false, error: `command is longer than ${WATCH_COMMAND_MAX} characters` };
  const split = splitWords(command.trim());
  if (!Array.isArray(split)) return { ok: false, error: split.error };
  const [program, ...args] = split;
  if (program === "gh") {
    const [group, action] = args;
    if (args.some((arg) => GH_BLOCKED_FLAGS.has(flagName(arg)))) return { ok: false, error: "gh --web is not a read you can watch" };
    if (group === "api") {
      if (args.some((arg) => GH_API_WRITE_FLAGS.has(flagName(arg)))) {
        return { ok: false, error: "gh api may only read here: no -X/--method, -f/-F fields or --input" };
      }
      return { ok: true, argv: split };
    }
    if (group && action && GH_READS[group]?.has(action)) return { ok: true, argv: split };
    return { ok: false, error: "gh is limited to reads: pr view|checks|list|status, run view|list, issue view|list|status, release view|list, workflow view|list, or api GET" };
  }
  if (program === "gog") {
    // Global flags may come first and take values (--account a@b.c), so read
    // the command from the first "chat" or "sheets" word on.
    const at = args.findIndex((arg) => arg === "chat" || arg === "sheets");
    const words = at < 0 ? [] : args.slice(at).filter((arg) => !arg.startsWith("-"));
    const [group, sub, action] = words;
    if (group === "chat" && sub && action && GOG_READS[`chat ${sub}`]?.has(action)) return { ok: true, argv: split };
    if (group === "sheets" && sub && GOG_READS.sheets!.has(sub)) return { ok: true, argv: split };
    return { ok: false, error: "gog is limited to reads: chat messages list, chat spaces list|get, chat threads list|get, sheets get|metadata" };
  }
  if (program === "git") {
    const sub = args.find((arg) => !arg.startsWith("-"));
    if (args[0] === "-C" && args[1]) {
      const rest = args.slice(2);
      if (rest[0] && GIT_READS.has(rest[0])) return { ok: true, argv: split };
    } else if (sub && GIT_READS.has(sub) && args[0] === sub) return { ok: true, argv: split };
    return { ok: false, error: "git is limited to ls-remote, log, rev-parse, status and show-ref (optionally after -C <dir>)" };
  }
  if (program === "curl") {
    if (args.some((arg) => CURL_BLOCKED_FLAGS.has(flagName(arg)))) {
      return { ok: false, error: "curl may only GET here: no request method, body, form, upload, output file or config" };
    }
    const urls = args.filter((arg) => /^https?:\/\//i.test(arg));
    if (urls.length !== 1) return { ok: false, error: "curl needs exactly one http(s) URL" };
    return { ok: true, argv: split };
  }
  if (program === "cat" || program === "tail") return parseLocalRead(program, args);
  return { ok: false, error: "wake_when runs only read-only gh, gog, git, curl, or cat/tail of a file under ~/.nuria" };
}

/** Folders whose files a watch may read (status files, release logs). */
export const WATCH_READABLE_DIRS = [join(homedir(), ".nuria")];

/** `cat FILE` or `tail -n N FILE`, FILE under an allowed folder (after
 * resolving "~", "..", and symlinks). Runs without a shell like the rest. */
function parseLocalRead(program: "cat" | "tail", args: string[], roots = WATCH_READABLE_DIRS): ParsedWatch {
  const usage = "cat FILE or tail -n N FILE, with FILE under ~/.nuria (quote a path that starts with ~)";
  let lines: string | null = null;
  let file: string | undefined;
  if (program === "cat") {
    if (args.length !== 1) return { ok: false, error: usage };
    file = args[0];
  } else {
    if (args.length !== 3 || args[0] !== "-n" || !/^\d{1,4}$/.test(args[1]!)) return { ok: false, error: usage };
    lines = args[1]!;
    file = args[2];
  }
  if (!file || file.startsWith("-")) return { ok: false, error: usage };
  const expanded = file === "~" || file.startsWith("~/") ? join(homedir(), file.slice(1)) : file;
  if (!expanded.startsWith("/")) return { ok: false, error: `${usage}: use an absolute path` };
  let path = resolve(expanded);
  if (existsSync(path)) path = realpathSync(path);
  const allowed = roots.some((root) => {
    const real = existsSync(root) ? realpathSync(root) : root;
    return path.startsWith(`${real}${sep}`);
  });
  if (!allowed) return { ok: false, error: `${usage}: ${file} is outside the folders a watch may read` };
  return { ok: true, argv: program === "cat" ? ["cat", path] : ["tail", "-n", lines!, path] };
}

export interface WatchRunResult {
  ok: boolean;
  /** The first WATCH_OUTPUT_MAX characters, for the bot to read. */
  output: string;
  /** sha256 of the whole stdout (of the whole output on failure): what "changed" is decided on. */
  fingerprint: string;
  /** The whole stdout was longer than `output`. */
  truncated?: boolean;
  /** stdout's lines (up to WATCH_LINES_MAX), to tell the bot what changed past the cut. */
  lines?: string[];
}

export const WATCH_LINES_MAX = 20_000;

/** A short hash of one output line: what a watch keeps to diff the next run. */
export function lineHash(line: string): string {
  return createHash("sha1").update(line).digest("hex").slice(0, 10);
}

/** What a watch command will not see the way the bot hopes: said in the
 * tool result, the watch is still armed. */
export function watchCommandWarnings(command: string): string[] {
  const warnings: string[] = [];
  // global flags may come first: gog --account x chat messages list …
  if (/^gog\b(?:\s+\S+)*?\s+chat\s+messages\s+list\b/.test(command.trim()) && !/--order[=\s]+["']?createTime desc/i.test(command)) {
    warnings.push('gog lista as mensagens em ordem crescente (as mais antigas primeiro): mensagens novas não mudam a saída e o vigia não as vê. Use --max 10 --order "createTime desc".');
  }
  if (/^gh\s+issue\s+list\b/.test(command.trim()) && !/sort:updated/.test(command)) {
    warnings.push('gh issue list ordena pelas criadas mais recentemente: uma issue antiga que muda fica fora. Para ver atualizações, use --search "sort:updated-desc".');
  }
  return warnings;
}

/** The newest ISO time stamp (2026-09-30T19:21…) in a watch's output, or null. */
export function newestStamp(text: string): number | null {
  let newest: number | null = null;
  for (const match of text.matchAll(/\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g)) {
    const at = Date.parse(`${match[1]}T${match[2]}${match[3] ?? "Z"}`);
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

export function fingerprintOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A watch's `ignore`: lines it matches (case-insensitive regex, else text)
 * are left out of what decides "changed" — a bot's own posts, say. */
export function ignoreMatcher(ignore: string | undefined): ((line: string) => boolean) | null {
  if (!ignore) return null;
  try {
    const pattern = new RegExp(ignore, "i");
    return (line) => pattern.test(line);
  } catch {
    const needle = ignore.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
}

/** Run once, bounded in time and size. Never throws. */
export function runWatchCommand(argv: string[], opts: { cwd: string; path: string; timeoutMs?: number; ignore?: string }): Promise<WatchRunResult> {
  return new Promise((resolve) => {
    execFile(
      argv[0]!,
      argv.slice(1),
      {
        cwd: opts.cwd,
        env: { ...process.env, PATH: opts.path, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
        timeout: opts.timeoutMs ?? WATCH_TIMEOUT_MS,
        maxBuffer: WATCH_BUFFER_MAX,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const full = `${String(stdout ?? "")}${stderr ? `\n${String(stderr)}` : ""}`.trim();
        const text = full.slice(0, WATCH_OUTPUT_MAX);
        if (error) {
          const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? `${argv[0]} was not found on this computer` : error.message.split("\n")[0];
          const output = text ? `${why}\n${text}` : why;
          resolve({ ok: false, output, fingerprint: fingerprintOf(output) });
          return;
        }
        // Only stdout decides "changed": stderr carries noise like a pager's
        // "Next page" token that differs on every run. It is still shown.
        const out = String(stdout ?? "").trim();
        // ignored lines (the bot's own posts) never make it "changed"
        const skip = ignoreMatcher(opts.ignore);
        const counted = skip ? out.split("\n").filter((line) => !skip(line)) : out.split("\n");
        resolve({ ok: true, output: text, fingerprint: fingerprintOf(skip ? counted.join("\n") : out), truncated: full.length > text.length, lines: counted.slice(0, WATCH_LINES_MAX) });
      },
    );
  });
}

/** Does this output satisfy the bot's `until` text? Case-insensitive; a
 * valid regular expression is used as one, anything else as plain text. */
export function watchMatches(output: string, until: string | undefined): boolean {
  if (!until) return false;
  try {
    return new RegExp(until, "i").test(output);
  } catch {
    return output.toLowerCase().includes(until.toLowerCase());
  }
}
