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

export const WATCH_COMMAND_MAX = 500;
export const WATCH_OUTPUT_MAX = 20_000;
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
  return { ok: false, error: "wake_when runs only read-only gh, git or curl commands" };
}

export interface WatchRunResult {
  ok: boolean;
  output: string;
}

/** Run once, bounded in time and size. Never throws. */
export function runWatchCommand(argv: string[], opts: { cwd: string; path: string; timeoutMs?: number }): Promise<WatchRunResult> {
  return new Promise((resolve) => {
    execFile(
      argv[0]!,
      argv.slice(1),
      {
        cwd: opts.cwd,
        env: { ...process.env, PATH: opts.path, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
        timeout: opts.timeoutMs ?? WATCH_TIMEOUT_MS,
        maxBuffer: WATCH_OUTPUT_MAX * 4,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const text = `${String(stdout ?? "")}${stderr ? `\n${String(stderr)}` : ""}`.trim().slice(0, WATCH_OUTPUT_MAX);
        if (error) {
          const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? `${argv[0]} was not found on this computer` : error.message.split("\n")[0];
          resolve({ ok: false, output: text ? `${why}\n${text}` : why });
          return;
        }
        resolve({ ok: true, output: text });
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
