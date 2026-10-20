// Program-level command patterns for the command allowlist.
//
// "Always allow this type of command" saves `<program> *` (or `<program> <sub> *`
// for tools with subcommands, e.g. `git status *`, `gh pr view *`) instead of
// the exact string. A compound command (`;`, `&&`, `||`, `|`, newline) is split
// into parts and each part must be covered by a saved rule or be an implicitly
// allowed read-only program. Anything this parser cannot reason about
// (substitution, subshells, heredocs, redirection to files, env prefixes, or a
// dangerous program) is never covered by a pattern and still asks.

/** One simple command: its words with quotes removed. */
export type CommandPart = string[];

/** Programs whose first (and for some, second) argument is a subcommand. */
const SUBCOMMANDS: Record<string, 1 | 2> = {
  git: 1, npm: 1, pnpm: 1, yarn: 1, bun: 1, cargo: 1, go: 1, docker: 1, kubectl: 1, brew: 1,
  launchctl: 1, wrangler: 1, swift: 1, xcrun: 1, defaults: 1, gh: 2, gcloud: 2, aws: 2,
};

/** Never covered by a pattern or the read-only set; an exact saved string still works. */
const DANGEROUS = new Set([
  "rm", "rmdir", "mv", "chflags", "chmod", "chown", "sudo", "su", "doas", "kill", "killall", "pkill",
  "sh", "bash", "zsh", "fish", "dash", "ksh", "eval", "exec", "source", ".", "xargs", "env", "command",
  "dd", "shred", "truncate", "mkfs", "diskutil", "launchctl-unload", "osascript", "nohup", "time", "nice",
]);

/** Implicitly allowed without any saved rule. */
const READ_ONLY = new Set(["cat", "ls", "echo", "head", "tail", "grep", "rg", "wc", "stat", "find", "pwd", "which", "date"]);

const FIND_UNSAFE = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh"]);

const programName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/**
 * Split a shell command into simple-command parts. Returns null when the
 * command uses anything other than plain words, quotes, the separators
 * `; && || | &` and newline, and redirections to /dev/null or between fds.
 */
export function splitCommand(command: string, depth = 0): CommandPart[] | null {
  const parts: CommandPart[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endPart = () => {
    endWord();
    if (!words.length) return false;
    parts.push(words); words = []; return true;
  };
  let i = 0;
  const s = command;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      word += s.slice(i + 1, end); inWord = true; i = end + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\") { j++; word += s[j] ?? ""; continue; }
        if (s[j] === "$" || s[j] === "`") return null;
        word += s[j];
      }
      if (j >= s.length) return null;
      inWord = true; i = j + 1; continue;
    }
    if (c === "\\") {
      if (s[i + 1] === "\n") { i += 2; continue; }
      if (i + 1 >= s.length) return null;
      word += s[i + 1]; inWord = true; i += 2; continue;
    }
    if (c === "`" || c === "(" || c === ")" || c === "{" || c === "}" || c === "<") return null;
    if (c === "$" && /[({]/.test(s[i + 1] ?? "")) return null;
    if (c === "#" && !inWord) { const nl = s.indexOf("\n", i); i = nl < 0 ? s.length : nl; continue; }
    if (c === ">") {
      // Only `>/dev/null`, `2>/dev/null`, `&>/dev/null`, `2>&1` style redirections; any file target asks.
      const fd = inWord && /^[0-9]$/.test(word) ? word : inWord ? null : "";
      if (fd === null) return null;
      let j = i + 1;
      if (s[j] === ">") j++;
      if (s[j] === "&" && /[0-9]/.test(s[j + 1] ?? "")) { word = ""; inWord = false; i = j + 2; continue; }
      while (s[j] === " " || s[j] === "\t") j++;
      if (!s.startsWith("/dev/null", j) || /[^\s;&|]/.test(s[j + 9] ?? " ")) return null;
      word = ""; inWord = false; i = j + 9; continue;
    }
    if (c === "&" && s[i + 1] === ">") {
      if (inWord) return null;
      let j = i + 2;
      if (s[j] === ">") j++;
      while (s[j] === " " || s[j] === "\t") j++;
      if (!s.startsWith("/dev/null", j) || /[^\s;&|]/.test(s[j + 9] ?? " ")) return null;
      i = j + 9; continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      const hadWords = inWord || words.length > 0;
      if (!endPart() && hadWords) return null;
      if ((c === "|" || c === "&") && s[i + 1] === c) i++;
      i++; continue;
    }
    if (c === " " || c === "\t" || c === "\r") { endWord(); i++; continue; }
    word += c; inWord = true; i++;
  }
  endWord();
  if (words.length) parts.push(words);
  if (!parts.length) return null;
  // `FOO=bar cmd` changes what the program does; never pattern-matched.
  if (parts.some((part) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(part[0]!))) return null;
  // A provider's own shell wrapper (`/bin/zsh -lc '<script>'`, codex.ts) is judged by the script it runs.
  const only = parts.length === 1 ? parts[0]! : null;
  if (only && only.length === 3 && SHELL_WRAPPERS.has(programName(only[0]!)) && /^-l?c$/.test(only[1]!)) {
    if (depth < 1) return splitCommand(only[2]!, depth + 1);
  }
  return parts;
}

/** Dangerous for this part regardless of patterns. */
export function isDangerousPart(part: CommandPart): boolean {
  const program = programName(part[0]!);
  if (DANGEROUS.has(program)) return true;
  if (program === "find" && part.some((arg) => FIND_UNSAFE.has(arg))) return true;
  // `rg --pre cmd` runs an arbitrary preprocessor.
  if (program === "rg" && part.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) return true;
  return false;
}

/**
 * Commands that must always ask: never saved (as a pattern or exact string)
 * and never auto-approved, even by an exact rule saved earlier. Covers
 * dangerous programs anywhere in the command (also inside substitutions or
 * subshells), output redirection to a file, and pipes into a shell.
 */
export function commandAlwaysAsks(command: string): boolean {
  const parts = splitCommand(command);
  if (parts) return parts.some(isDangerousPart);
  const wrapped = /^\s*(?:\S*\/)?(?:sh|bash|zsh) -l?c '([^']*)'\s*$/.exec(command);
  if (wrapped) return commandAlwaysAsks(wrapped[1]!);
  // Unparsable: be conservative. Output redirection to anything but /dev/null or an fd.
  const withoutSafe = command.replace(/(?:[0-9]|&)?>>?\s*(?:\/dev\/null\b|&[0-9])/g, "");
  if (/>/.test(withoutSafe.replace(/'[^']*'/g, ""))) return true;
  // Any segment starting with a dangerous program (after separators, `(`, `{`, `$(`, backtick).
  for (const segment of command.split(/[;&|\n(){}`]|\$\(/)) {
    const words = segment.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const first = words[0]?.replace(/^['"]|['"]$/g, "");
    if (first && isDangerousPart([first, ...words.slice(1)])) return true;
  }
  return false;
}

/** Implicitly allowed read-only program. */
export function isReadOnlyPart(part: CommandPart): boolean {
  if (isDangerousPart(part)) return false;
  const program = part[0]!;
  if (!READ_ONLY.has(program)) return false;
  // `date MMDDhhmm` sets the clock; only formatting/flag forms are read-only.
  if (program === "date") return part.slice(1).every((arg) => (arg.startsWith("+") || arg.startsWith("-")) && arg !== "-s");
  return true;
}

/** The pattern words for a part (without the trailing `*`), or null when it cannot be a pattern. */
export function patternWordsFor(part: CommandPart): string[] | null {
  if (isDangerousPart(part)) return null;
  const depth = SUBCOMMANDS[programName(part[0]!)] ?? 0;
  const words = [part[0]!];
  for (let k = 1; k <= depth; k++) {
    const sub = part[k];
    if (!sub || sub.startsWith("-") || !/^[\w.:-]+$/.test(sub)) {
      // `git -C dir status`: a global flag before the subcommand; keep the pattern at the depth reached only if at least one subcommand was found.
      if (k === 1) return null;
      break;
    }
    words.push(sub);
  }
  if (words.some((w) => /[\s*]/.test(w))) return null;
  return words;
}

export const isCommandPattern = (rule: string) => /^\S+(?: \S+)* \*$/.test(rule) && !rule.slice(0, -2).includes("*");

/**
 * The patterns "Always allow this type of command" saves for a command: one
 * per part that is not already read-only. Null means no safe pattern exists
 * (dangerous program, unparsable syntax); the caller saves the exact string.
 */
export function commandPatterns(command: string): string[] | null {
  const parts = splitCommand(command);
  if (!parts) return null;
  const patterns: string[] = [];
  for (const part of parts) {
    if (isReadOnlyPart(part)) continue;
    const words = patternWordsFor(part);
    if (!words) return null;
    const pattern = `${words.join(" ")} *`;
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns.length ? patterns : null;
}

/** A label for the card: `cat *`, or `git status * · cd *`. */
export function commandPatternLabel(command: string): string | null {
  const parts = splitCommand(command);
  if (!parts) return null;
  const labels: string[] = [];
  for (const part of parts) {
    const words = isReadOnlyPart(part) ? [part[0]!] : patternWordsFor(part);
    if (!words) return null;
    const label = `${words.join(" ")} *`;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join(" · ");
}

const partMatches = (part: CommandPart, pattern: string) => {
  const words = pattern.slice(0, -2).split(" ");
  return words.length <= part.length && words.every((w, k) => part[k] === w);
};

/**
 * Whether every part of a command is covered by a pattern or is read-only.
 * Exact-string rules are checked by the caller; this only widens.
 */
export function commandCoveredByPatterns(command: string, patterns: readonly string[]): boolean {
  const parts = splitCommand(command);
  if (!parts) return false;
  const usable = patterns.filter(isCommandPattern);
  return parts.every((part) => !isDangerousPart(part) && (isReadOnlyPart(part) || usable.some((p) => partMatches(part, p))));
}
