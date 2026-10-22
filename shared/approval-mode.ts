/** The approval levels exposed by the app. Each one is a provider's own
 * permission mode, passed through: OpenMausBot never decides a permission
 * itself (Full access aside, which answers residual prompts because that is
 * what the person granted). The order is the order the selector shows. */
export const APPROVAL_MODES = ["ask", "edits", "auto", "full", "custom"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Only providers with an implemented permission mapping may expose a level.
 * `edits` (auto-accept edits) exists where the engine has such a mode:
 * Claude and Grok `acceptEdits`, Antigravity `auto_edit`, Qwen `auto-edit`,
 * Gemini `auto_edit`. Codex's Ask already runs `workspace-write`, so an edits
 * level would change nothing there. Full access (a stored level, never the
 * default in this fork) runs on every engine: in the engine's own most
 * permissive mode, or, where it has none, with the harness answering the
 * permission requests it leaves (the chat-completions family, ACP agents
 * such as Kimi or Hermes, Pi's computer confirms). */
export function supportsApprovalMode(driverKind: string | undefined, mode: ApprovalMode): boolean {
  if (mode === "custom") return driverKind === "codex";
  if (mode === "edits") return ["claudeAgent", "grokAgent", "antigravityAgent", "qwenAgent", "geminiAgent"].includes(driverKind ?? "");
  return true;
}

/** Whether switching engines must first drop this level to Ask. A Full or
 * Custom grant belongs to one provider's tool semantics, so neither crosses
 * engines: the person granted it, through the desktop's own confirmation, for
 * the engine the bot ran on. fork: upstream (cb00428a6, Oct 12) lets Full
 * carry silently to any engine; this fork keeps the reset to Ask, and Full
 * comes back only through the packaged desktop's private channel. Other
 * levels carry across only when the destination implements them (Auto-accept
 * edits stops at an engine without it). Adapted from tahodev's
 * provider-switch guard (#1120). */
export function modelSwitchNeedsAsk(
  mode: ApprovalMode,
  fromDriver: string | undefined,
  toDriver: string | undefined,
): boolean {
  return !supportsApprovalMode(toDriver, mode) ||
    ((mode === "full" || mode === "custom") && fromDriver !== toDriver);
}

export function hasNativeAutoReview(driverKind: string | undefined): boolean {
  // Qwen Code's `--approval-mode auto` is an LLM classifier that approves
  // safe actions and blocks risky ones — a reviewer, not a rubber stamp.
  return ["codex", "claudeAgent", "cursorAgent", "grokAgent", "qwenAgent"].includes(driverKind ?? "");
}

const APPROVAL_RANK: Record<ApprovalMode, number> = { ask: 0, edits: 1, auto: 2, full: 3, custom: 4 };

export function approvalModeWidens(from: ApprovalMode, to: ApprovalMode): boolean {
  return APPROVAL_RANK[to] > APPROVAL_RANK[from];
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/** The level a bot or conversation runs at until a person picks one.
 *
 * fork: Ask até a pessoa escolher. Upstream 593fd1c5a (v0.1.109) moved this
 * to Full access, as in t3code; this fork keeps Ask. A bot or conversation
 * with no saved level never runs at Full: Full is only ever a stored level,
 * reached through the desktop's own confirmation. So records with no level
 * (the legacy Auto bit off included), Chief-created teammates, team-backup
 * and package imports, presets and organization library items keep asking. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "ask";

let defaultApprovalMode: ApprovalMode = DEFAULT_APPROVAL_MODE;

/** Upstream's startup switch for the no-level default (a shared company
 * workspace sets Ask). fork: it can never make that default Full or Custom,
 * so no flag or policy turns "no level saved" into an elevated level. */
export function setDefaultApprovalMode(mode: ApprovalMode): void {
  defaultApprovalMode = mode === "full" || mode === "custom" ? "ask" : mode;
}

/** Resolve the durable mode. A bot or conversation nobody has set a level on
 * runs at the default, Ask in this fork. The legacy Auto bit, written before
 * approvalMode existed, stays safe Auto, and an unknown persisted value fails
 * closed to Ask. */
export function approvalModeFor(bot: {
  approvalMode?: unknown;
  autoApprove?: unknown;
  /** Server-only two-phase grant marker. Until Electron confirms it, the
   * stored elevated selection is deliberately executable only as Ask. */
  approvalGrant?: unknown;
  threadId?: string;
}): ApprovalMode {
  const grant = bot.approvalGrant;
  const otherThread = grant && typeof grant === "object" && "threadOnly" in grant && grant.threadOnly === true &&
    "threadId" in grant && typeof grant.threadId === "string" && typeof bot.threadId === "string" && grant.threadId !== bot.threadId;
  if (grant && !otherThread) return "ask";
  if (isApprovalMode(bot.approvalMode)) return bot.approvalMode;
  if (bot.autoApprove === true) return "auto";
  return bot.approvalMode === undefined ? defaultApprovalMode : "ask";
}

/** A private late-grant recovery may revoke an elevated mode even after a
 * turn began. It can only move to the fail-closed Ask mode; ordinary changes
 * remain blocked while the bot is working. */
export function isEmergencyApprovalDowngrade(
  current: ApprovalMode,
  next: ApprovalMode,
): boolean {
  return next === "ask" && (current === "full" || current === "custom");
}
