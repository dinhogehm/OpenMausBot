import { errorTranscript } from "../shared/client-cancel.ts";
import { isOutboundTool } from "../shared/outbound.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { buildTurnDigest, digestTools } from "./digest.ts";
import { stopCause } from "./drivers/engine-errors.ts";
import type { TurnEvidence } from "./runtime/types.ts";
import type { Message } from "./store.ts";

const REASON_CHARS = 600;

export interface TurnStop {
  turnId?: string;
  cause?: string;
  error?: string;
  handoffPath?: string;
}

export class TurnStops {
  readonly #byThread = new Map<string, TurnStop>();

  note(event: RuntimeEvent): void {
    if (event.type === "turn.started") {
      this.#byThread.delete(event.threadId);
      return;
    }
    const error = event.type === "runtime.error" ? event.message
      : event.type === "item.completed" && event.itemType === "assistant_text" && event.synthetic ? event.text : undefined;
    if (event.type !== "cap.exhausted" && (error === undefined || errorTranscript(error).kind !== "error")) return;
    const stop = this.#turn(event.threadId, event.turnId);
    if (event.type === "cap.exhausted") stop.handoffPath = event.handoffPath;
    else stop.error = error;
  }

  stopping(threadId: string, turnId: string | undefined, cause: string): void {
    this.#turn(threadId, turnId).cause = cause;
  }

  #turn(threadId: string, turnId: string | undefined): TurnStop {
    const held = this.#byThread.get(threadId);
    const stop: TurnStop = held && held.turnId === turnId ? held : { turnId };
    this.#byThread.set(threadId, stop);
    return stop;
  }

  read(threadId: string, turnId?: string): TurnStop | undefined {
    const stop = this.#byThread.get(threadId);
    return stop && (!turnId || !stop.turnId || stop.turnId === turnId) ? stop : undefined;
  }

  /** The turn's own last error, else the provider's stop reason in words; undefined for a turn that did not fail. */
  failureCause(event: { threadId: string; turnId?: string; ok: boolean; stopReason?: string | null }): string | undefined {
    if (event.ok) return undefined;
    return this.read(event.threadId, event.turnId)?.error ?? stopCause(event.stopReason);
  }

  forget(threadId: string): void {
    this.#byThread.delete(threadId);
  }
}

/** Cause first (a chip shows only the start), then the last message quoted as data, so a teammate's words never pass for the harness's. */
export function stoppedTurnOutcome(input: {
  reason: string;
  activities: readonly Message[];
  turnId?: string;
  said?: string;
}): string {
  const parts = [sentence(clip(input.reason, REASON_CHARS))];
  if (input.turnId) {
    const digest = buildTurnDigest({
      turnId: input.turnId, botId: "", threadId: "", at: 0, durationMs: 0,
      activities: input.activities, memory: [], reply: "", hookCoverage: "preview",
    });
    parts.push(digest.toolCalls
      ? `Before it stopped it made ${digest.toolCalls} tool call${digest.toolCalls === 1 ? "" : "s"}: ${digestTools(digest)}.`
      : "No tool calls were seen before it stopped.");
  }
  const said = input.said?.trim();
  return said ? `${parts.join(" ")}\nIts last message, quoted: ${JSON.stringify(said)}` : parts.join(" ");
}

/** A shell tool, by any engine's name for it: what it ran is in the row's
 * input (the command) or its summary (the command on one line). Codex and
 * the ACP engines name the row for the command itself instead (commandOf). */
const SHELL_TOOL = /^(?:mcp__[\w-]+?__)?(?:bash|shell|exec|run_command|execute_command|run_shell_command|run_terminal_cmd|terminal|COMPOSIO_REMOTE_BASH_TOOL)$/i;
/** A shell command that leaves something outside the working tree: a
 * commit (history others pull) or a push. This fork: git's own options may
 * come first — `git -C <worktree> push`, `git -c user.name=x commit`, the
 * form bots use from a worktree — quoted or not, escaped in a JSON input
 * or not. */
const GIT_OUTWARD = /\bgit(?:\s+(?:-[Cc]\s+(?:\\?"[^"\n]*?\\?"|'[^'\n]*'|\S+)|--[\w-]+(?:=\S+)?))*\s+(commit|push)\b/g;
/** A shell command that moves money, by its words. */
const MONEY_OUTWARD = /\b(pay|payment|charge|refund|transfer)\b/gi;
/** A pattern of a command that acts outward, and the label it is reported
 * by (undefined: this match does not act, e.g. a `gh api` read). */
type Outward = readonly [pattern: RegExp, label: (match: RegExpMatchArray) => string | undefined];
/** This fork: shell commands that act outside this machine in the owner's
 * projects. A turn a restart cut after one of them is not run again: it
 * would merge, post, release or deploy a second time. */
const FORK_OUTWARD: readonly Outward[] = [
  // gh, with or without a repository flag: a PR merged, opened, commented,
  // reviewed, closed, reopened, marked ready or edited; an issue opened,
  // commented, closed, reopened, edited or deleted; a release published.
  [/\bgh(?:\s+(?:-R|--repo)(?:=|\s+)\S+)*\s+(?:(pr)\s+(merge|create|new|comment|review|close|reopen|ready|edit)|(issue)\s+(create|new|comment|close|reopen|edit|delete)|(release)\s+(create|upload|edit|delete))(?![\w-])/gi,
    (m) => `gh ${(m[1] ?? m[3] ?? m[5])!.toLowerCase()} ${(m[2] ?? m[4] ?? m[6])!.toLowerCase()}`],
  // gh api: a merge, a comment or any other write through the API.
  [/\bgh(?:\s+(?:-R|--repo)(?:=|\s+)\S+)*\s+api\b([^\n;&|]*)/gi, (m) => ghApiWrite(m[1] ?? "")],
  // gog (Google), global flags or not: a chat message or reply sent
  // (`gog chat send`, `gog chat messages send`, `gog chat dm send`), a chat
  // space created, a spreadsheet written or made, an email sent.
  [/\bgog(?:\s+--?[\w-]+(?:=\S+|\s+(?!-|chat\b|sheets\b|gmail\b|mail\b|email\b)\S+)?)*\s+(?:chat\s+(?:(?:messages|dm)\s+)?(send|reply)|chat\s+spaces\s+(create)|sheets\s+(update|append|clear|format|create|copy)|(?:gmail|mail|email)\s+(?:drafts\s+)?(send|reply|forward))(?![\w-])/gi,
    (m) => m[1] ? `gog chat ${m[1].toLowerCase()}` : m[2] ? "gog chat spaces create" : m[3] ? `gog sheets ${m[3].toLowerCase()}` : `gog gmail ${m[4]!.toLowerCase()}`],
  // The Nuria gate's merge (`npm run pr:merge`) and its release (`npm run
  // release:local`), whatever npm's own options (`-s`, `--prefix <dir>`).
  [/\bnpm(?:\s+-{1,2}[\w-]+(?:=\S+|\s+(?!-|run\b)\S+)?)*\s+run(?:-script)?(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(pr:merge|release:local)(?![\w:-])/gi,
    (m) => `npm run ${m[1]!.toLowerCase()}`],
  // The same corridor by its scripts: the release carrier merged into main
  // (the release LaunchAgent then publishes it), the gate's status
  // published or its merge, the release itself. Their read-only modes
  // (`--check`, the default; `--dry-run`; `--help`) are not. The release
  // script is named in every process check (`pgrep -fl "…|local-release.sh"`),
  // so it counts only where a command starts, with the `--environment` a
  // run of it requires.
  [/\brelease-carrier\.sh\b[^\n;&|]*?\s--execute(?![\w-])/gi, () => "release-carrier.sh --execute"],
  [/\bpr-merge-gate\.sh\b[^\n;&|]*?\s--(merge|publish)(?![\w-])/gi, (m) => `pr-merge-gate.sh --${m[1]!.toLowerCase()}`],
  [/(?:^|[\n;&|(]|\s-l?c\s+["'])\s*(?:(?:nohup|exec|time|caffeinate(?:\s+-\w+)*|bash|sh|zsh)\s+)*(?:\w+=\S*\s+)*(?:[\w.~/-]*\/)?local-release\.sh\s+[^\n;&|]*?--environment(?![\w-])(?![^\n;&|]*\s(?:--dry-run|--help|-h)(?![\w-]))/gi,
    () => "local-release.sh"],
  // wrangler, outside the sealed release: a deploy, a rollback, a secret, a
  // database, a store or a queue written. A listing, a dry run or a D1 query
  // that only reads (wranglerRead) is not.
  [/\bwrangler(?:@[\w.^~-]+)?\s+(deploy|publish|rollback|delete|secret|kv:key|kv:namespace|kv:bulk|kv|r2|d1|pages|versions|queues|triggers|vectorize|hyperdrive|workflows|containers)(?![\w:.-])(?!(?:\s+[\w:-]+)?\s+(?:list|info|get|view|status|export)(?![\w-]))(?![^\n;&|]*\s--dry-run(?![\w-]))(?=([^\n]*))/gi,
    (m) => wranglerRead(m[1]!, m[2] ?? "") ? undefined : `wrangler ${m[1]!.toLowerCase()}`],
];
/** This fork: a command a script runs as an argv list — Python's
 * `subprocess.run(['gh', 'issue', 'comment', n, '--body', text])` in a
 * heredoc, a JSON array — which the patterns above, written for a command
 * line, do not see. The list starts with a quoted program; argvLines joins
 * its parts into the line it runs. */
const ARGV_LIST = /\[\s*[rRbBfFuU]{0,2}(\\?["'])([\w./-]+)\1\s*,([^\]]*)\]/g;
/** One part of an argv list that is a string literal (an f-string too):
 * its text. Any other part (a variable, a call) reads as `_`. */
const ARGV_LITERAL = /^[rRbBfFuU]{0,2}(\\?["'])([\s\S]*)\1$/;
/** The longest label a command row is reported by when only its words
 * read as a send (commandLabel). */
const COMMAND_LABEL_CHARS = 80;
/** The longest error text evidence keeps, and how many. */
const ERROR_CHARS = 200;
const ERRORS_KEPT = 3;

const toolRows = (rows: readonly Message[]) =>
  rows.filter((row) => row.role === "bot" && row.kind === "activity" && row.tool !== undefined);

type ToolRow = NonNullable<Message["tool"]>;

/** This fork: a `gh api` call's arguments are a write when its method is
 * not a read (`-X PUT`, `--method=PATCH`), or, with no method, when they
 * send fields or a body (`-f`, `-F`, `--input`): gh then POSTs. GraphQL
 * always POSTs, so there the text decides: a query written inline (`-f
 * query='{…}'` or `query { … }`) with no `mutation` reads; a mutation, or a
 * query from a file or a variable, counts. */
function ghApiWrite(args: string): string | undefined {
  if (/^\s*graphql(?![\w-])/i.test(args)) {
    const inlineQuery = /(?:^|\s)(?:-[fF]\s*|--(?:raw-)?field(?:=|\s+))query=\\?["']?\s*(?:\{|query\b)/.test(args);
    return inlineQuery && !/\bmutation\b/i.test(args) ? undefined : "gh api graphql";
  }
  const method = /(?:^|\s)(?:-X\s*|--method(?:=|\s+))["']?([A-Za-z]+)/.exec(args)?.[1]?.toUpperCase();
  if (method) return method === "GET" || method === "HEAD" ? undefined : `gh api ${method}`;
  return /(?:^|\s)(?:-[fF]|--(?:raw-)?field(?![\w-])|--input(?![\w-]))/.test(args) ? "gh api POST" : undefined;
}

/** This fork: a `wrangler d1 execute` whose `--command` only reads (it
 * starts SELECT, PRAGMA or EXPLAIN, and nothing on its line writes) is a
 * query, not a change. Any other wrangler match acts; so does a D1 command
 * from a file or a variable, which nothing here can read. */
function wranglerRead(subcommand: string, rest: string): boolean {
  return subcommand.toLowerCase() === "d1"
    && /^\s+execute(?![\w-])/i.test(rest)
    && /--command(?:=|\s+)\\?["']?\s*(?:SELECT|PRAGMA|EXPLAIN)\b/i.test(rest)
    && !/--file(?![\w-])/.test(rest)
    && !/\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX)\b/i.test(rest);
}

/** A row an engine named with words rather than a tool's identifier: Codex
 * names a shell row for its command (`/bin/zsh -lc '…'`, codex.ts), an ACP
 * engine for the command's first 80 characters or for the agent's own
 * title (acp/core.ts). Only an engine's row, which has an item id: a
 * harness line ("error: …", "Resuming after a restart") is not one. */
const titled = (tool: ToolRow) => tool.itemId !== undefined && /\s/.test(tool.name.trim());

/** The command an input preview carries: toolDetailPreview writes a tool's
 * input as JSON, so its `command` (a line, or the argv an ACP engine
 * passed) reads back unescaped. A preview cut at its limit is no JSON; its
 * text is read as it is. */
function inputCommand(input: string | undefined): string | undefined {
  if (typeof input !== "string" || !/^\s*\{/.test(input)) return undefined;
  try {
    const fields: unknown = JSON.parse(input);
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) return undefined;
    const command = (fields as Record<string, unknown>).command ?? (fields as Record<string, unknown>).cmd;
    if (typeof command === "string") return command;
    if (Array.isArray(command) && command.every((part) => typeof part === "string")) return command.join(" ");
  } catch {
    // no JSON: the caller reads the text itself
  }
  return undefined;
}

/** What a tool row ran, when it ran a command: a shell tool by its name, or
 * any engine's row whose input carried a command — every engine marks one
 * with a summary (tool-summary.ts commandSummary: Claude, Codex, the ACP
 * engines, Pi, Muse) or leaves it in the input. This fork: only a name in
 * SHELL_TOOL was read before, and Codex names its shell rows for the
 * command, so no Codex command was ever seen. Undefined: no command. */
function commandOf(tool: ToolRow): string | undefined {
  const decoded = inputCommand(tool.input);
  const summary = typeof tool.summary === "string" && tool.summary.trim() ? tool.summary : undefined;
  if (!SHELL_TOOL.test(tool.name) && summary === undefined && decoded === undefined) return undefined;
  return [titled(tool) ? tool.name : undefined, decoded, tool.input, summary]
    .filter((text): text is string => typeof text === "string").join("\n");
}

/** This fork: the lines a text runs as argv lists (ARGV_LIST), each list's
 * parts joined by spaces: `['gh', 'pr', 'edit', str(n)]` reads as `gh pr
 * edit _`. A string with a comma in it splits into parts that read as `_`;
 * the program and its subcommands, which the patterns read, are words. */
function argvLines(text: string): string[] {
  const lines: string[] = [];
  for (const list of text.matchAll(ARGV_LIST)) {
    const parts = list[3]!.split(",").map((part) => ARGV_LITERAL.exec(part.trim())?.[2] ?? "_");
    lines.push([list[2]!, ...parts].join(" "));
  }
  return lines;
}

/** This fork: the label of a row named for its command when no pattern
 * names what it did and only its words read as a send (`curl -X POST`,
 * `npm publish`, `./scripts/send-report.sh`): the command itself, out of
 * its shell wrapper (`/bin/zsh -lc '…'`), on one line and cut, so the
 * restart text still reads its verb ("posted (curl -X POST …)"). */
function commandLabel(name: string): string {
  const inner = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(["'])([\s\S]*)\1\s*$/.exec(name)?.[2] ?? name;
  return clip(redactCredentials(inner), COMMAND_LABEL_CHARS);
}

/** This fork: a command's label reaches the conversation and the restart
 * report, so what looks like a credential is dropped from it first: an
 * Authorization header, a Bearer or Basic value, a token/key/secret/password
 * given as a flag or an assignment, and a long opaque run of characters. */
export function redactCredentials(command: string): string {
  return command
    .replace(/\b(authorization\s*:\s*)(?:(?:bearer|basic|token)\s+)?[^\s'"]+/gi, "$1[…]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 […]")
    .replace(/((?:--?|\b)(?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key)[\w-]*)(?:\s*=\s*|\s+))(["']?)[^\s'"]+\2/gi, "$1[…]")
    .replace(/[A-Za-z0-9_\-+=]{32,}/g, "[…]");
}

/** The outward actions one command line shows, as labels. An engine's title
 * with no command beside it is read for the commands only: money words in
 * a title ("Edit payment.ts") are not a payment. This fork: a command run
 * as an argv list is read too (argvLines). */
function commandOutward(command: string, money: boolean): string[] {
  const labels: string[] = [];
  const text = [command, ...argvLines(command)].join("\n");
  for (const git of text.matchAll(GIT_OUTWARD)) labels.push(`git ${git[1]}`);
  if (money) for (const word of command.matchAll(MONEY_OUTWARD)) labels.push(word[1]!.toLowerCase());
  for (const [pattern, label] of FORK_OUTWARD) {
    for (const match of text.matchAll(pattern)) {
      const name = label(match);
      if (name) labels.push(name);
    }
  }
  return labels;
}

/** The outward actions a turn's activity rows show it did — sends, posts,
 * publishes, invites, payments (shared/outbound.ts) and shell commands that
 * committed, pushed or paid (this fork: or merged, posted, released or
 * deployed through gh, gog, npm run, the release scripts and wrangler,
 * FORK_OUTWARD), by any engine's shell — as short labels, each once, in
 * order. The one classifier: the restart policy reads it to decide that a
 * cut turn must not run again (docs/runtime-contract.md §5), and every
 * turn's evidence carries it. An app tool that failed counts nothing: a
 * refused send sent nothing. This fork: a shell command that failed counts,
 * labelled "failed …", since it may have acted before it failed (a release
 * that aborted mid-deploy, a merge whose next step failed); the same
 * command run again and done is reported as done. A row named for its
 * command (Codex) is read as a command first, so a pattern's label names
 * it ("gog chat send", not the whole line); when no pattern names it, its
 * name still counts by its words, as upstream's did (isOutboundTool): a
 * send no pattern knows — gh from a Python argv the patterns missed,
 * `curl -X POST`, `npm publish`, a `send-*` script — must not run twice.
 * The price is upstream's: `rg post src/` counts too, and a cut turn that
 * only read is asked about instead of run again. */
export function outwardActions(rows: readonly Message[]): string[] {
  const labels: string[] = [];
  const add = (label: string, failed = false) => {
    if (labels.includes(label)) return;
    const tried = labels.indexOf(`failed ${label}`);
    if (tried < 0) labels.push(failed ? `failed ${label}` : label);
    else if (!failed) labels[tried] = label;
  };
  for (const row of toolRows(rows)) {
    const tool = row.tool!;
    const failed = tool.ok === false;
    const named = !titled(tool);
    if (named && isOutboundTool(tool.name)) {
      if (!failed) add(tool.name);
      continue;
    }
    const command = commandOf(tool);
    // An engine's title with no command beside it (an ACP agent that sent
    // no raw input) is read for the commands it names, without money words.
    const found = command !== undefined ? commandOutward(command, true) : named ? [] : commandOutward(tool.name, false);
    for (const label of found) add(label, failed);
    if (named || found.length || !isOutboundTool(tool.name)) continue;
    // This fork: a row named for its command or titled by its engine whose
    // words read as a send, and no pattern named it. A command counts as a
    // shell command does, failed or not ("it may have acted"); a title with
    // no command counts as an app tool, only when it did not fail.
    if (command !== undefined) add(commandLabel(tool.name), failed);
    else if (!failed) add(tool.name);
  }
  return labels;
}

/** What the harness observed of one execution, from its activity rows:
 * the tool calls that returned ok, the last few error texts, and the
 * outward actions it did (outwardActions). The runtime reads the first two for its
 * continuation guard and the last for its restart policy. An error row is
 * the harness's own error row or a tool that failed; a failed
 * tool's row is named for the tool, so its output's first line is kept
 * beside the name, or three failed shell calls would read as one error
 * three times. */
export function turnEvidence(rows: readonly Message[]): TurnEvidence {
  const tools = toolRows(rows);
  const errors = tools.filter((row) => row.tool!.ok === false).map((row) => {
    const tool = row.tool!;
    const output = tool.itemId && typeof tool.output === "string" ? tool.output.split("\n").find((line) => line.trim()) : undefined;
    return clip(output ? `${tool.name}: ${output}` : tool.name, ERROR_CHARS);
  }).slice(-ERRORS_KEPT);
  const okToolCalls = tools.filter((row) => row.tool!.ok !== false && row.tool!.itemId !== undefined).length;
  const outward = outwardActions(rows);
  return { toolCalls: tools.filter((row) => row.tool!.itemId !== undefined).length, okToolCalls, errors, ...(outward.length ? { outward } : {}) };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function sentence(text: string): string {
  const capital = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?…"]$/.test(capital) ? capital : `${capital}.`;
}
