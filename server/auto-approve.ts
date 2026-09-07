// Auto mode: when a bot may answer its own permission requests.
//
// Safe Auto and remembered grants stop at the destructive/sensitive and
// unattended boundaries below. Full access is a separate, explicitly
// acknowledged mode: it answers every permission request, including those
// guards, while questions remain outside this module and always reach a human.
//
// The guard is deliberately tiny and literal. It is NOT a security
// boundary (an agent set on damage has a thousand spellings for `rm`);
// it is a "you probably didn't mean to hand THIS one over unattended"
// backstop for the obvious catastrophes. Real containment is the
// sandbox and the bot's own computer, not a regex.

import { approvalModeFor, type ApprovalMode } from "../shared/approval-mode.ts";

/** Full access is the person's explicit grant to this receiving bot, including
 * delegated work. It never inherits the sender's mode or elevates another bot.
 * Custom is a provider-config choice rather than an app Full-access grant, so
 * peer-started Custom turns still use Auto and its unattended downgrade.
 * Provider support and grant confirmation are checked by the caller. */
export function approvalModeForOrigin(mode: ApprovalMode, origin: { peerInitiated: boolean }): ApprovalMode {
  if (mode === "custom" && origin.peerInitiated) return "auto";
  return mode;
}

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf, rm -fr, rm -r -f
  /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+[^|]*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb
  /\bgit\s+push\s+[^|]*--force(-with-lease)?\b|\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i,
  /\bsudo\s+rm\b|\bchmod\s+-R\s+777\s+\//i,
];

// Not destructive, but exactly what you don't hand over unattended: a
// bot reading your keys is quiet, permanent, and unrecoverable.
const SENSITIVE = [
  /(^|[\s/"'])\.env(\.|$|["'\s])/i,
  /\.ssh\/|id_rsa|id_ed25519|authorized_keys/i,
  /\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json/i,
  /security\s+find-(generic|internet)-password|\bkeychain\b/i,
  /\bcredentials?\.json\b|\bserviceaccount\b/i,
];

/** First matching pattern's source, so a verdict can NAME the rule that
 * made it — the decision log's whole value is "which rule", and deriving
 * the match a second time at the call site is how the log and the verdict
 * drift apart. */
function matchFirst(rules: RegExp[], text: string): string | null {
  for (const re of rules) if (re.test(text)) return re.source;
  return null;
}

export function looksSensitive(text: string): boolean {
  return matchFirst(SENSITIVE, text) !== null;
}

export function looksDestructive(text: string): boolean {
  return matchFirst(DESTRUCTIVE, text) !== null;
}

/** The key an "Always allow" remembers.
 *
 * A bare tool name is far too coarse for a command runner: remembering
 * "Bash" would hand the bot a permanent unattended shell, which is the
 * opposite of what someone pressing "always allow" on `git status`
 * intends. Command tools are therefore keyed by their program —
 * `Bash:git`, `Bash:npm` — so the grant is as narrow as the thing you
 * actually looked at. Computed once, server-side, and echoed back by the
 * client so the two sides can never disagree about what was granted. */
const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "run_command", "computer_exec", "terminal"]);

/** Shells, which are never the program a person means to grant. Agents run
 * their commands through one — codex sends `/bin/zsh -lc "gh pr merge"` — so
 * without looking past the wrapper every grant would be minted as
 * `shell:zsh`: a permanent unattended shell wearing a program's name, and
 * narrow enough to pass every check that asks whether a grant names one
 * thing. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);

/** File-editing tools whose permission card names no path (Codex sends
 * `edit`; ACP drivers `fileChange`), so the sensitive guard cannot see what
 * they touch. A grant on one is a grant on every file. */
const BLIND_EDIT_TOOLS = new Set(["edit", "filechange", "file_change"]);

/** The program a command line actually runs: past env assignments, past
 * sudo, and past a shell wrapper into the command it was handed. */
function programOf(command: string, depth = 0): string {
  const words = command.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]) || words[i] === "sudo")) i += 1;
  const word = words[i] ?? "";
  const program = word.split("/").pop()?.replace(/[^\w.-]/g, "") ?? "";
  if (depth >= 3 || !SHELLS.has(program)) return program;
  // `-c`, `-lc`, `-lic`: everything after it is the real command, usually
  // quoted. Nesting is bounded so a wrapper chain cannot spin here.
  const flag = words.slice(i + 1).find((candidate) => /^-[a-z]*c$/i.test(candidate));
  if (!flag) return program;
  const at = command.indexOf(flag, command.indexOf(word) + word.length);
  if (at < 0) return program;
  const inner = command.slice(at + flag.length).trim().replace(/^["']/, "");
  return programOf(inner, depth + 1) || program;
}

/** The tool name as the command-tool check sees it: past an MCP server
 * prefix, case-folded — `mcp__box__bash` and `Bash` are both a shell. */
const bareTool = (tool: string): string => tool.replace(/^mcp__[^_]+__/, "").toLowerCase();

export function approvalKey(tool: string, summary: string, scope?: "local-computer"): string {
  if (!COMMAND_TOOLS.has(bareTool(tool))) return scope ? `${scope}:${tool}` : tool;
  const program = programOf(summary);
  // A shell we could not see into is not a program anyone can name, so the
  // key stays the bare tool: honestly broad, and refused wherever a broad
  // grant is refused, rather than narrow-looking and quietly honoured.
  const key = program && !SHELLS.has(program) ? `${tool}:${program}` : tool;
  return scope ? `${scope}:${key}` : key;
}

export interface AutoApprover {
  autoApprove?: boolean;
  approvalMode?: ApprovalMode;
  alwaysAllow?: string[];
}

/** Why a verdict landed the way it did. `unattended-block` exists only in
 * contrast: a grant WOULD have fired, and the only thing that stopped it
 * was that nobody started this turn — the most audit-worthy card of all. */
export type AutoVerdictSource =
  | "always-allow"
  | "auto-mode"
  | "full-access"
  | "native-approval"
  | "explicit-approval-block"
  | "unattended-block"
  | "local-computer-block"
  | "destructive-guard"
  | "sensitive-guard"
  | "no-grant";

/** A durable "Always allow" choice is offered only when that exact grant
 * would be honored on the next identical request. Custom delegates approval
 * semantics to config.toml, while guards and provider-sandbox changes are
 * intentionally never bypassed by remembered app grants. */
export function rememberableApprovalKey(
  bot: AutoApprover | null | undefined,
  tool: string,
  summary: string,
  context: {
    source: AutoVerdictSource | undefined;
    scope?: "local-computer";
    requiresExplicitApproval?: boolean;
  },
): string | undefined {
  if (
    !bot ||
    approvalModeFor(bot) === "custom" ||
    context.source !== "no-grant" ||
    context.scope ||
    context.requiresExplicitApproval
  ) {
    return undefined;
  }
  return approvalKey(tool, summary, context.scope);
}

export interface AutoVerdict {
  /** Chip text when the bot may answer itself, null when a human decides.
   * The string becomes the chip in the transcript, so an auto-approved
   * action is never invisible. */
  approve: string | null;
  source: AutoVerdictSource;
  /** What identifies the rule that decided: the matched regex (guards) or
   * the granted key (always-allow, and unattended-block over one). Auto
   * mode has no narrower identity than the mode itself, so it carries none. */
  rule?: string;
}

/** The one line a card shows above "Allow / Deny" to say why the bot could
 * not answer this itself, or undefined when nothing held it back and the
 * request is an ordinary ask.
 *
 * It reads from the verdict rather than from the bot's mode: a bot in auto
 * mode now has four different ways to reach a card, and telling someone
 * "this looked destructive" about a directory listing that was only held
 * because nobody started the turn is worse than saying nothing — it teaches
 * them to distrust the one sentence that explains their own permissions. */
export function heldReason(source: AutoVerdictSource | undefined): string | undefined {
  switch (source) {
    case "destructive-guard":
      return "This looked destructive, so it stopped to ask.";
    case "sensitive-guard":
      return "This touches credentials or keys, so it stopped to ask.";
    case "unattended-block":
      return "Nobody started this turn, so auto mode does not answer for the bot.";
    case "local-computer-block":
      return "This controls your computer, which is never approved from memory.";
    default:
      return undefined;
  }
}

/** The verdict AND its provenance. The decision itself is unchanged from
 * autoDecision below — this exists so the decision log can record which
 * rule decided without the call site re-deriving (and eventually
 * mis-deriving) the match. */
export function autoVerdict(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** Respect the native reviewer (including a provider with no Auto mode). */
    nativeApproval?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
    /** The provider is asking to widen its configured sandbox rather than
     * perform one ordinary action. Only explicit Full may synthesize this. */
    requiresExplicitApproval?: boolean;
    /** Present only on a WORKFLOW node's turn: the keys the node itself
     * declared (possibly none). Its presence is what lets a grant on an
     * ordinary tool fire unattended — see namedNarrowly. */
    workflowGrants?: string[];
  },
): AutoVerdict {
  const mode = approvalModeFor(bot);
  if (context?.nativeApproval) return { approve: null, source: "native-approval" };
  // This branch intentionally precedes every guard. Entering Full access is
  // separately consent-gated by the bot PATCH endpoint, and its promise is
  // literal: even destructive, sensitive, unattended, and host-computer
  // permission requests are approved. The request.opened caller invokes this
  // function for permissions only, never for provider questions.
  if (mode === "full") {
    return {
      approve: `approved ${tool} (full access)`,
      source: "full-access",
    };
  }
  if (context?.requiresExplicitApproval) {
    return { approve: null, source: "explicit-approval-block" };
  }
  // the guards outrank the grants, so an "always allow" can never widen
  // into them
  const destructive = matchFirst(DESTRUCTIVE, summary) ?? matchFirst(DESTRUCTIVE, tool);
  const sensitive = destructive ? null : matchFirst(SENSITIVE, summary);
  // The grant is computed even when a hard block will refuse it: the row
  // worth auditing is "this WOULD have auto-approved, and only the block
  // stood in the way", which cannot be told apart from an ordinary
  // "nobody granted this" card without knowing both halves.
  const key = approvalKey(tool, summary, context?.scope);
  const grant =
    destructive || sensitive
      ? null
      : mode !== "custom" && bot.alwaysAllow?.includes(key)
        ? { approve: `auto-approved ${key} (always allowed)`, source: "always-allow" as const, rule: key }
        : mode === "auto"
          ? { approve: `auto-approved ${tool}`, source: "auto-mode" as const, rule: undefined }
          : null;
  if (context?.unattended) {
    // Auto mode is something a person switched on for turns they are present
    // for. A webhook turn begins with nobody watching, on a payload someone
    // else wrote, so it does not inherit that decision — the guard above is a
    // pattern list its own comment calls "not a security boundary", and it
    // must not stand in for a human at 3am. An explicit always-allow is the
    // opposite kind of decision: a person named that exact program and said
    // "this one, always" — and a bot that may not run it while nobody is
    // watching can never finish a workflow node, only time out three times.
    // So the named grant stands; only the blanket mode is withheld. Two
    // shapes of "named" are not narrow enough to stand with nobody watching:
    // a grant on the user's live desktop (this branch runs before the
    // local-computer one, and unattended must never be MORE permissive than
    // attended), and a command-tool key with no program segment — "approve
    // the command I could not even name". A guard that would have carded
    // anyway keeps its own name; the block is only the story when it is the
    // thing that changed the outcome.
    //
    // An ordinary tool's key IS its name (`session_search`, `list_bots`),
    // which names one thing exactly — but only a workflow node's turn gets
    // to call that narrow. A webhook turn keeps the older rule (nothing but
    // a program-named command grant fires), because the widening was never
    // asked for there. And a file-editing tool is blind to the guards: the
    // Codex `edit` card carries no path, so "always allow edit" on the bot
    // would let a webhook-fed bot write ~/.ssh/authorized_keys unseen. On a
    // workflow turn that key fires only when the NODE declared it — the
    // operator named it for that step, eyes open — never off the bot's
    // list alone.
    const bare = bareTool(tool);
    const namedNarrowly =
      context?.scope !== "local-computer" &&
      (COMMAND_TOOLS.has(bare)
        ? key !== tool
        : context?.workflowGrants !== undefined && (context.workflowGrants.includes(key) || !BLIND_EDIT_TOOLS.has(bare)));
    if (grant?.source === "always-allow" && namedNarrowly) return grant;
    if (grant) return { approve: null, source: "unattended-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (context?.scope === "local-computer" && mode !== "auto") {
    // Host control is not covered by a remembered always-allow grant.
    // After the Auto-on-this-computer warning, unclassified GUI actions
    // (click/type) may auto-approve; destructive/sensitive still card.
    if (grant) return { approve: null, source: "local-computer-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
  if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
  if (grant) return { approve: grant.approve, source: grant.source, rule: grant.rule };
  return { approve: null, source: "no-grant" };
}

/** The grants a workflow node's turn runs under: the bot's own list plus
 * what the node pre-approves, de-duplicated with the bot's entries first so
 * the decision log's `rule` reads the same whichever list carried it. A
 * union and nothing more — every entry is still judged by autoVerdict's
 * unattended rules, so a node can widen WHICH programs are named but never
 * how broadly (no bare shells, no desktop, no way past the guards). */
export function effectiveAlwaysAllow(
  bot: Pick<AutoApprover, "alwaysAllow"> | null | undefined,
  node: { alwaysAllow?: string[] } | null | undefined,
): string[] | undefined {
  const fromBot = bot?.alwaysAllow ?? [];
  const fromNode = node?.alwaysAllow ?? [];
  if (fromNode.length === 0) return bot?.alwaysAllow;
  return [...new Set([...fromBot, ...fromNode])];
}

/** Of a workflow node's grants (bot's and node's), the keys autoVerdict
 * would actually honour on that node's turn — what the node prompt may
 * promise the bot. Same exclusions as the unattended branch of the verdict,
 * by key alone (the guards judge the command text and cannot be listed):
 * nothing on the live desktop, no command-tool key without a program (or
 * with a shell for one), and a blind file-edit key only when the NODE
 * declared it. A prompt that listed anything else would send the bot
 * straight into a denial it was told could not happen. */
export function unattendedHonoredGrants(
  botKeys: readonly string[] | null | undefined,
  nodeKeys: readonly string[] | null | undefined,
): string[] {
  const fromNode = new Set(nodeKeys ?? []);
  const honored: string[] = [];
  for (const key of new Set([...(botKeys ?? []), ...(nodeKeys ?? [])])) {
    if (key.startsWith("local-computer:")) continue;
    const at = key.indexOf(":");
    const tool = at < 0 ? key : key.slice(0, at);
    const program = at < 0 ? "" : key.slice(at + 1);
    const bare = bareTool(tool);
    if (COMMAND_TOOLS.has(bare)) {
      if (!program || SHELLS.has(program)) continue;
    } else if (BLIND_EDIT_TOOLS.has(bare) && !fromNode.has(key)) {
      continue;
    }
    honored.push(key);
  }
  return honored;
}

/** The one line a fail-fast denial carries — on the card, in the decision
 * log, and in the run receipt — naming the tool, what it asked, and the
 * exact key an "always allow" on the bot or the node would have needed.
 * The key is the actionable half: a receipt reading "denied unattended:
 * shell (key shell:gh)" is a one-line fix on the node panel, where "node
 * timed out" was a guess. `why` is the verdict's own reason, so a guard
 * that would have carded anyway is not blamed on the missing grant. */
export function unattendedDenial(
  tool: string,
  summary: string,
  verdict: Pick<AutoVerdict, "source" | "rule">,
  scope?: "local-computer",
): string {
  const key = approvalKey(tool, summary, scope);
  const what = summary.trim().replace(/\s+/g, " ").slice(0, 80);
  const why =
    verdict.source === "destructive-guard"
      ? "looked destructive"
      : verdict.source === "sensitive-guard"
        ? "touches credentials or keys"
        : verdict.source === "explicit-approval-block"
          ? "widens the provider sandbox"
          : verdict.source === "native-approval"
            ? "the provider requires a person"
            : scope === "local-computer"
              ? "controls the live desktop, which no grant covers unattended"
              : verdict.source === "unattended-block"
                ? verdict.rule === undefined
                  ? "auto mode does not answer with nobody watching"
                  : `the grant "${verdict.rule}" names no program, so it cannot fire unattended`
                : `no always-allow names "${key}"`;
  const where = scope ? `, scope ${scope}` : "";
  return `denied unattended: ${tool}${what ? ` "${what}"` : ""} (key ${key}${where}) — ${why}`;
}

/** Why this request may be answered without the human, or null to ask. */
export function autoDecision(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
    requiresExplicitApproval?: boolean;
  },
): string | null {
  return autoVerdict(bot, tool, summary, context).approve;
}

/** The note a card shows above its buttons, explaining why the bot stopped
 * rather than answering for itself.
 *
 * The unattended case is the one users misread. A turn a webhook or another
 * bot started never runs Auto at all — approvalModeForTurn downgrades it to
 * Ask before the provider spawns — so "this action needs you" would name the
 * wrong cause and imply the next action might pass. It will not: with a fleet
 * delegating between bots, every card looks like this until someone answers.
 * Say that plainly, and name the mode that keeps running. */
export function approvalHeldReason(context: {
  /** Native and sandbox notes outrank any mode explanation, so a provider's
   * own remaining checks are never described as something Full access skips. */
  source?: AutoVerdictSource;
  /** Questions are not permissions and are never held for a mode reason. */
  permission: boolean;
  requiresExplicitApproval?: boolean;
  /** Origin-adjusted mode, before unattended Auto is downgraded to Ask. */
  mode: ApprovalMode;
  unattended: boolean;
  /** Suppress the Full access hint on providers that cannot offer it. */
  fullAccessAvailable: boolean;
}): string | undefined {
  const key = approvalHeldNote(context);
  return key && HELD_NOTE[key];
}

/** Every fixed note a held card can show, by catalog key.
 *
 * The card is the last thing between a bot and someone's filesystem, so the
 * one line explaining why it stopped should not be the one line still in
 * English. The client translates by key and falls back to this text, which
 * the server keeps sending: cards saved before the key existed still render,
 * and so do the free-text apply errors that have no key at all.
 *
 * The unattended hint is a whole second sentence rather than a suffix. A
 * translator needs the sentence, not two halves to reassemble. */
export const HELD_NOTE = {
  "approval.held.native": "The provider requires your approval for this action.",
  "approval.held.sandbox":
    "This changes the provider sandbox, so only Full access can approve it automatically.",
  "approval.held.localComputer":
    "Controlling your computer is never covered by Always allow, so this needs you.",
  "approval.held.unattended":
    "A webhook or another bot started this turn, so Approve for me is paused and every action asks.",
  "approval.held.unattendedFullAccess":
    "A webhook or another bot started this turn, so Approve for me is paused and every action asks. Full access keeps working unattended.",
  "approval.held.destructive": "This looks destructive, so Approve for me stopped to ask.",
  "approval.held.sensitive": "This touches credentials, so Approve for me stopped to ask.",
  "approval.held.needsYou": "This action needs you, so Approve for me stopped to ask.",
  "approval.held.undeliveredFull": "Full access couldn't deliver this approval.",
  "approval.held.undelivered": "Approve for me couldn't answer this one.",
} as const;

export type HeldNoteKey = keyof typeof HELD_NOTE;

/** Which note, as a key. approvalHeldReason is this plus the English text, so
 * the branching that decides the note lives in exactly one place. */
export function approvalHeldNote(context: {
  source?: AutoVerdictSource;
  permission: boolean;
  requiresExplicitApproval?: boolean;
  mode: ApprovalMode;
  unattended: boolean;
  fullAccessAvailable: boolean;
}): HeldNoteKey | undefined {
  if (context.source === "native-approval") return "approval.held.native";
  if (!context.permission) return undefined;
  if (context.requiresExplicitApproval) return "approval.held.sandbox";
  // Host control reaches this only over a grant that would otherwise have
  // fired, in a mode that explains nothing else. "I pressed Always allow and
  // it asked anyway" is the whole confusion, so answer that and not the mode.
  if (context.source === "local-computer-block") return "approval.held.localComputer";
  if (context.mode !== "auto") return undefined;
  if (context.unattended) {
    return context.fullAccessAvailable
      ? "approval.held.unattendedFullAccess"
      : "approval.held.unattended";
  }
  // A guard names itself. Both stop the same mode, but one is about damage
  // and the other about secrets, and a read-only .env card that says
  // "destructive" teaches people to stop reading these.
  if (context.source === "destructive-guard") return "approval.held.destructive";
  if (context.source === "sensitive-guard") return "approval.held.sensitive";
  return "approval.held.needsYou";
}
