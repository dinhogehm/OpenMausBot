// Everything about the selected node that does not fit on its card. Dumb by
// design: it never touches the store or the API, it just reports edits, so
// the canvas stays the single owner of the document and of when it saves.
import { useEffect, useRef, useState } from "react";
import { Flag, Plus, Trash2, X } from "lucide-react";

import { cn } from "@/lib/cn";
import type { BotAvatarProps } from "./Avatar";
import type { WorkflowOutcomeHandle } from "@/lib/workflow-graph";
import {
  alwaysAllowText,
  grantedCapabilities,
  missingCapabilities,
  parseAlwaysAllowLines,
  toggleRequirement,
} from "@/lib/workflow-capabilities";
import { BotAvatar } from "./Avatar";
import { formatWaitMinutes } from "./WorkflowNodeCard";
import {
  WORKFLOW_APPROVAL_OUTCOMES,
  WORKFLOW_CAPABILITIES,
  WORKFLOW_FAIL_OUTCOME,
  WORKFLOW_NODE_RETRIES_DEFAULT,
  WORKFLOW_NODE_TIMEOUT_DEFAULT_MIN,
  WORKFLOW_APPROVAL_EXPIRES_DEFAULT_H,
  WORKFLOW_WAIT_MINUTES_MAX,
  WORKFLOW_WAIT_MINUTES_MIN,
  type BotCapabilities,
  type WorkflowIssue,
  type WorkflowNode,
} from "../../shared/workflow";

/** The roster as the panel sees it: enough to draw the avatar, the two
 * permission flags (so the picker can tag a bot and the Requires group can
 * say which requirement the chosen one falls short of), and whether the bot
 * is hidden in the sidebar — a node may still be bound to one. */
export type WorkflowPanelBot = BotAvatarProps["bot"] &
  BotCapabilities & {
    id: string;
    name: string;
    hidden?: boolean;
    /** The model engine instance the bot runs on. The fallback picker uses it
     * to say when a choice shares the primary's engine — the engine only
     * switches to a fallback on a DIFFERENT engine, so that choice would
     * never take over. Absent when the roster does not say. */
    engine?: string;
  };
type AgentNode = Extract<WorkflowNode, { kind: "agent" }>;

/** What the picker prints for a bot: its name, then the permissions it
 * holds, then whether it is hidden. A native `<option>` can carry text and
 * nothing else, so the tag IS the text — which is also what a screen reader
 * gets. */
export function botOptionLabel(bot: WorkflowPanelBot): string {
  const label = [bot.name, ...grantedCapabilities(bot)].join(" · ");
  return bot.hidden ? `${label} (hidden)` : label;
}

export interface WorkflowPanelGroup {
  id: string;
  name: string;
}
export interface WorkflowRouteTarget {
  id: string;
  label: string;
}

const PANEL_TITLE: Record<WorkflowNode["kind"], string> = {
  agent: "Agent node",
  approval: "Approval gate",
  notify: "Notify room",
  wait: "Wait",
};

const FIELD =
  "w-full rounded-lg border border-hairline/50 bg-inset px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent";
const LABEL = "block text-[11px] font-medium text-ink-secondary";

/** Number knobs are optional in the model, so the field has to distinguish
 * "empty" from "zero" — a controlled string, parsed on the way out. */
function NumberField({
  id,
  label,
  hint,
  value,
  min,
  step,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number | undefined;
  min: number;
  step: number;
  onChange: (next: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  // adopt a value the document changed underneath us (undo, a server echo)
  const lastValue = useRef(value);
  if (lastValue.current !== value) {
    lastValue.current = value;
    const incoming = value === undefined ? "" : String(value);
    if (incoming !== draft.trim()) setDraft(incoming);
  }

  return (
    <div>
      <label className={LABEL} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        step={step}
        value={draft}
        placeholder={hint}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = Number(next);
          onChange(next.trim() === "" || !Number.isFinite(parsed) ? undefined : parsed);
        }}
        className={cn(FIELD, "mt-1 tabular-nums")}
      />
    </div>
  );
}

/** Outcome names are edited in place. A rename the canvas refuses (blank,
 * reserved, already taken) leaves the document alone, and clearing the draft
 * here snaps the field back to the name that is still real. */
function OutcomeRow({
  nodeId,
  outcome,
  onRename,
  onRemove,
  canRemove,
}: {
  nodeId: string;
  outcome: string;
  onRename: (from: string, to: string) => void;
  onRemove: (outcome: string) => void;
  canRemove: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? outcome;

  return (
    <li className="flex items-center gap-1.5">
      <input
        aria-label={`Outcome "${outcome}" on ${nodeId}`}
        value={value}
        maxLength={100}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== outcome) onRename(outcome, draft);
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
          }
        }}
        className={cn(FIELD, "font-mono text-[12px]")}
      />
      <button
        type="button"
        onClick={() => onRemove(outcome)}
        disabled={!canRemove}
        aria-label={`Remove outcome ${outcome}`}
        title={canRemove ? "Remove outcome" : "An agent node needs at least one outcome"}
        className="shrink-0 rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-40"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

/** What the bot must be allowed to do before the engine will dispatch this
 * node. The document stores the list only when it is non-empty (an absent
 * key, never `[]` or `null` — `toggleRequirement` owns that rule), and the
 * shortfall is printed as a sentence under the boxes: the canvas already
 * lists the `missing-capability` issue above, but "which bot, which
 * permission, where to fix it" belongs next to the control that caused it. */
function RequiresGroup({
  node,
  bot,
  onUpdate,
}: {
  node: AgentNode;
  bot: WorkflowPanelBot | undefined;
  onUpdate: (next: WorkflowNode) => void;
}) {
  const required = node.requires ?? [];
  const lacking = bot ? missingCapabilities(node.requires, bot) : [];

  return (
    <div>
      <span className={LABEL}>Requires</span>
      <p className="mt-0.5 text-[10.5px] text-ink-secondary">
        What the bot must be allowed to do before this step can run. Granted per bot, in its profile.
      </p>
      <div className="mt-1.5 flex items-center gap-4">
        {WORKFLOW_CAPABILITIES.map((capability) => (
          <label key={capability} className="inline-flex items-center gap-1.5 text-[12px] text-ink">
            <input
              type="checkbox"
              checked={required.includes(capability)}
              onChange={(event) => {
                const { requires: _requires, ...rest } = node;
                const requires = toggleRequirement(node.requires, capability, event.target.checked);
                onUpdate(requires ? { ...rest, requires } : rest);
              }}
              className="accent-accent"
            />
            {capability}
          </label>
        ))}
      </div>
      {bot &&
        lacking.map((capability) => (
          <p key={capability} className="mt-1.5 text-[11.5px] leading-snug text-danger">
            {`${bot.name} is not allowed to ${capability} — enable it in the bot's settings`}
          </p>
        ))}
    </div>
  );
}

/** The keys this node's turns may use without a card — one per line, in the
 * same vocabulary as a bot's "always allow". A node runs with nobody at the
 * keyboard, where only a named grant survives; without this the bot would
 * have to carry every node's programs for every chat it ever has. The draft
 * is local: the parser drops blank lines and padding, and pushing that
 * through the document on every keystroke would eat the newline a person
 * just typed. Stored only when non-empty (an absent key, never `[]`). */
function AlwaysAllowField({
  id,
  node,
  onUpdate,
}: {
  id: string;
  node: AgentNode;
  onUpdate: (next: WorkflowNode) => void;
}) {
  const value = alwaysAllowText(node.alwaysAllow);
  const [draft, setDraft] = useState(value);
  // adopt a value the document changed underneath us (undo, a server echo)
  const lastValue = useRef(value);
  if (lastValue.current !== value) {
    lastValue.current = value;
    if (value !== alwaysAllowText(parseAlwaysAllowLines(draft))) setDraft(value);
  }

  return (
    <div>
      <label className={LABEL} htmlFor={id}>
        Pre-approved tools on this node
      </label>
      <p className="mt-0.5 text-[10.5px] text-ink-secondary">
        One key per line, as an approval card names it (<span className="font-mono">Bash:gh</span>,{" "}
        <span className="font-mono">session_search</span>). Joined with the bot&apos;s own always-allow list for this
        node&apos;s turns; anything else is denied at once, and the run receipt names the key it lacked. Never covers
        destructive commands, credentials, or this computer.
      </p>
      <textarea
        id={id}
        value={draft}
        rows={3}
        maxLength={20_000}
        spellCheck={false}
        placeholder={"Bash:gh\nsession_search"}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const { alwaysAllow: _alwaysAllow, ...rest } = node;
          const alwaysAllow = parseAlwaysAllowLines(next);
          onUpdate(alwaysAllow ? { ...rest, alwaysAllow } : rest);
        }}
        className={cn(FIELD, "mt-1 resize-y font-mono text-[12px] leading-relaxed")}
      />
    </div>
  );
}

/** The bot the engine hands this node to when the primary's provider is
 * down — once per outage, only when that bot runs on another engine, is
 * free, and holds every capability the node requires. The document stores
 * the id only when one is chosen (an absent key, never `""` or `null`).
 * Every other bot is offered, hidden ones included while they are the
 * chosen one; the primary itself is not — the validator refuses it, and a
 * picker should not offer what the validator will refuse. */
function FallbackGroup({
  node,
  bot,
  bots,
  onUpdate,
}: {
  node: AgentNode;
  bot: WorkflowPanelBot | undefined;
  bots: WorkflowPanelBot[];
  onUpdate: (next: WorkflowNode) => void;
}) {
  const fallback = node.fallbackBotId === undefined ? undefined : bots.find((candidate) => candidate.id === node.fallbackBotId);
  const known = node.fallbackBotId === undefined || fallback !== undefined;
  const sameEngine = bot?.engine !== undefined && fallback?.engine !== undefined && bot.engine === fallback.engine;
  const lacking = fallback ? missingCapabilities(node.requires, fallback) : [];
  const id = `wf-${node.id}-fallback`;

  return (
    <div>
      <label className={LABEL} htmlFor={id}>
        Fallback bot (other engine)
      </label>
      <p className="mt-0.5 text-[10.5px] text-ink-secondary">
        Takes this step over when the bot&apos;s provider is down, if it runs on a different engine. Otherwise the run
        waits for the provider to come back. The fallback runs with its own standing permissions (always-allow) —
        grant it what this step needs, or it will stop to ask.
      </p>
      <select
        id={id}
        value={known ? (node.fallbackBotId ?? "") : ""}
        onChange={(event) => {
          const { fallbackBotId: _fallbackBotId, ...rest } = node;
          const value = event.target.value;
          onUpdate(value === "" ? rest : { ...rest, fallbackBotId: value });
        }}
        className={cn(FIELD, "mt-1")}
      >
        <option value="">None — wait for the provider</option>
        {!known && (
          <option value="" disabled>
            Missing bot {node.fallbackBotId}
          </option>
        )}
        {bots
          .filter((candidate) => candidate.id !== node.botId && (!candidate.hidden || candidate.id === node.fallbackBotId))
          .map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {botOptionLabel(candidate)}
            </option>
          ))}
      </select>
      {sameEngine && bot && fallback && (
        <p className="mt-1.5 text-[11.5px] leading-snug text-warning">
          {`${fallback.name} runs on the same engine as ${bot.name} — it will not take over during an outage`}
        </p>
      )}
      {fallback &&
        lacking.map((capability) => (
          <p key={capability} className="mt-1.5 text-[11.5px] leading-snug text-warning">
            {`${fallback.name} is not allowed to ${capability} — it will not take over this step`}
          </p>
        ))}
    </div>
  );
}

export interface WorkflowNodePanelProps {
  node: WorkflowNode;
  issues: WorkflowIssue[];
  entry: boolean;
  /** The whole roster, hidden bots included. Only visible bots are OFFERED
   * for a new binding; a hidden one is resolved (avatar, name, permissions)
   * while it is the bound bot, and listed as such, rather than called
   * missing — which would be a lie the author cannot act on. */
  bots: WorkflowPanelBot[];
  groups: WorkflowPanelGroup[];
  /** Every outcome this node can route on, implicit failure path included. */
  outcomes: WorkflowOutcomeHandle[];
  /** Every node an outcome may be routed to, self included — loops are legal. */
  targets: WorkflowRouteTarget[];
  /** outcome -> target node id, for the outcomes that are wired. */
  routes: Record<string, string>;
  /** An empty `to` unwires the outcome. */
  onRoute: (outcome: string, to: string) => void;
  onUpdate: (next: WorkflowNode) => void;
  onAddOutcome: (name: string) => void;
  onRenameOutcome: (from: string, to: string) => void;
  onRemoveOutcome: (name: string) => void;
  onMakeEntry: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function WorkflowNodePanel({
  node,
  issues,
  entry,
  bots,
  groups,
  outcomes,
  targets,
  routes,
  onRoute,
  onUpdate,
  onAddOutcome,
  onRenameOutcome,
  onRemoveOutcome,
  onMakeEntry,
  onDelete,
  onClose,
}: WorkflowNodePanelProps) {
  const [newOutcome, setNewOutcome] = useState("");
  const field = (name: string) => `wf-${node.id}-${name}`;
  const bot = node.kind === "agent" ? bots.find((candidate) => candidate.id === node.botId) : undefined;

  useEffect(() => setNewOutcome(""), [node.id]);

  const addOutcome = () => {
    const name = newOutcome.trim();
    if (!name) return;
    onAddOutcome(name);
    setNewOutcome("");
  };

  return (
    <aside
      aria-label={`Node ${node.id}`}
      className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-hairline/40 bg-panel"
    >
      <div className="flex items-start gap-2 border-b border-hairline/40 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13.5px] font-semibold text-ink">
            {PANEL_TITLE[node.kind]}
          </h2>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-secondary">{node.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close node panel"
          className="shrink-0 rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex flex-col gap-4 px-4 py-4">
        <div className="flex items-center gap-2">
          {entry ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-accent/15 px-2.5 py-1.5 text-[11.5px] font-medium text-accent">
              <Flag size={12} aria-hidden />
              Entry node
            </span>
          ) : (
            <button
              type="button"
              onClick={onMakeEntry}
              className="inline-flex items-center gap-1.5 rounded-lg border border-hairline/50 px-2.5 py-1.5 text-[11.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <Flag size={12} aria-hidden />
              Make entry node
            </button>
          )}
        </div>

        {issues.length > 0 && (
          <ul className="space-y-1.5 rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[11.5px] leading-relaxed">
            {issues.map((issue, index) => (
              <li key={`${issue.code}:${index}`} className="flex gap-1.5">
                <span
                  className={cn("shrink-0 font-medium", issue.severity === "error" ? "text-danger" : "text-warning")}
                >
                  {issue.severity === "error" ? "Error" : "Warning"}
                </span>
                <span className="min-w-0 text-ink-secondary">{issue.message}</span>
              </li>
            ))}
          </ul>
        )}

        {node.kind === "agent" && (
          <>
            <div>
              <label className={LABEL} htmlFor={field("bot")}>
                Bot
              </label>
              <div className="mt-1 flex items-center gap-2">
                {bot ? (
                  <BotAvatar bot={bot} size={26} animated={false} />
                ) : (
                  <span className="size-[26px] shrink-0 rounded-full bg-danger/15" aria-hidden />
                )}
                <select
                  id={field("bot")}
                  value={bots.some((candidate) => candidate.id === node.botId) ? node.botId : ""}
                  onChange={(event) => onUpdate({ ...node, botId: event.target.value })}
                  className={cn(FIELD, "min-w-0 flex-1")}
                >
                  {!bot && (
                    <option value="" disabled>
                      {node.botId ? `Missing bot ${node.botId}` : "Pick a bot"}
                    </option>
                  )}
                  {bots
                    .filter((candidate) => !candidate.hidden || candidate.id === node.botId)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {botOptionLabel(candidate)}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <RequiresGroup node={node} bot={bot} onUpdate={onUpdate} />

            <AlwaysAllowField id={field("always-allow")} node={node} onUpdate={onUpdate} />
            <FallbackGroup node={node} bot={bot} bots={bots} onUpdate={onUpdate} />

            <div>
              <label className={LABEL} htmlFor={field("instructions")}>
                Instructions
              </label>
              <textarea
                id={field("instructions")}
                value={node.instructions}
                rows={5}
                maxLength={20_000}
                placeholder="What this bot should do, and how to decide between the outcomes below."
                onChange={(event) => onUpdate({ ...node, instructions: event.target.value })}
                className={cn(FIELD, "mt-1 resize-y leading-relaxed")}
              />
            </div>

            <div>
              <span className={LABEL}>Outcomes</span>
              <p className="mt-0.5 text-[10.5px] text-ink-secondary">
                One source handle each. Renaming one rewrites the edge that already routed on it;{" "}
                <span className="font-mono">{WORKFLOW_FAIL_OUTCOME}</span> is the engine&apos;s own path and is always
                there.
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {node.outcomes.map((outcome) => (
                  <OutcomeRow
                    key={outcome}
                    nodeId={node.id}
                    outcome={outcome}
                    onRename={onRenameOutcome}
                    onRemove={onRemoveOutcome}
                    canRemove={node.outcomes.length > 1}
                  />
                ))}
              </ul>
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  aria-label="New outcome name"
                  value={newOutcome}
                  maxLength={100}
                  placeholder="Add an outcome…"
                  onChange={(event) => setNewOutcome(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      addOutcome();
                    }
                  }}
                  className={cn(FIELD, "font-mono text-[12px]")}
                />
                <button
                  type="button"
                  onClick={addOutcome}
                  aria-label="Add outcome"
                  className="shrink-0 rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-accent"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <NumberField
                id={field("timeout")}
                label="Timeout (min)"
                hint={String(WORKFLOW_NODE_TIMEOUT_DEFAULT_MIN)}
                value={node.timeoutMinutes}
                min={1}
                step={1}
                onChange={(timeoutMinutes) => onUpdate({ ...node, timeoutMinutes })}
              />
              <NumberField
                id={field("retries")}
                label="Retries"
                hint={String(WORKFLOW_NODE_RETRIES_DEFAULT)}
                value={node.retries}
                min={0}
                step={1}
                onChange={(retries) => onUpdate({ ...node, retries })}
              />
            </div>
          </>
        )}

        {node.kind === "approval" && (
          <>
            <div>
              <label className={LABEL} htmlFor={field("prompt")}>
                Prompt
              </label>
              <textarea
                id={field("prompt")}
                value={node.prompt}
                rows={5}
                maxLength={20_000}
                placeholder="What you are being asked to approve."
                onChange={(event) => onUpdate({ ...node, prompt: event.target.value })}
                className={cn(FIELD, "mt-1 resize-y leading-relaxed")}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                id={field("expires")}
                label="Expires (hours)"
                hint={String(WORKFLOW_APPROVAL_EXPIRES_DEFAULT_H)}
                value={node.expiresHours}
                min={1}
                step={1}
                onChange={(expiresHours) => onUpdate({ ...node, expiresHours })}
              />
              <div>
                <label className={LABEL} htmlFor={field("on-expire")}>
                  On expiry
                </label>
                <select
                  id={field("on-expire")}
                  value={node.onExpire ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    onUpdate({
                      ...node,
                      onExpire: value === "" ? undefined : (value as (typeof WORKFLOW_APPROVAL_OUTCOMES)[number]),
                    });
                  }}
                  className={cn(FIELD, "mt-1")}
                >
                  {/* The engine falls back to `rejected` when onExpire is unset
                      (sweepApprovals: `node.onExpire ?? "rejected"`), so the default
                      must not promise a failure it never produces. */}
                  <option value="">Route to rejected (default)</option>
                  {WORKFLOW_APPROVAL_OUTCOMES.map((outcome) => (
                    <option key={outcome} value={outcome}>
                      Route to {outcome}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </>
        )}

        {node.kind === "notify" && (
          <>
            <div>
              <label className={LABEL} htmlFor={field("room")}>
                Room
              </label>
              <select
                id={field("room")}
                value={groups.some((group) => group.id === node.targetGroupId) ? node.targetGroupId : ""}
                onChange={(event) => onUpdate({ ...node, targetGroupId: event.target.value })}
                className={cn(FIELD, "mt-1")}
              >
                {!groups.some((group) => group.id === node.targetGroupId) && (
                  <option value="" disabled>
                    Missing room {node.targetGroupId}
                  </option>
                )}
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor={field("template")}>
                Message
              </label>
              <textarea
                id={field("template")}
                value={node.template}
                rows={5}
                maxLength={20_000}
                placeholder="What to post in the room when the run reaches this node."
                onChange={(event) => onUpdate({ ...node, template: event.target.value })}
                className={cn(FIELD, "mt-1 resize-y leading-relaxed")}
              />
            </div>
          </>
        )}

        {node.kind === "wait" && (
          <div>
            <NumberField
              id={field("minutes")}
              label="Pause (minutes)"
              hint={String(WORKFLOW_WAIT_MINUTES_MIN)}
              value={node.minutes}
              min={WORKFLOW_WAIT_MINUTES_MIN}
              step={1}
              // The model requires a number; an emptied field keeps the last
              // real value rather than writing a node the validator rejects.
              onChange={(minutes) => onUpdate({ ...node, minutes: minutes ?? node.minutes })}
            />
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink-secondary">
              No bot runs here: the run idles for {formatWaitMinutes(node.minutes)} (
              {WORKFLOW_WAIT_MINUTES_MIN}–{WORKFLOW_WAIT_MINUTES_MAX}), survives a restart, and does not count toward
              the execution cap. Put one on the edge that loops back to the entry so a continuous cycle breathes
              between laps.
            </p>
          </div>
        )}

        {/* Routing is the editor's central action and, on the canvas, a mouse
            drag between two handles. This is the same edit for anyone who
            cannot (or would rather not) drag. */}
        <div>
          <span className={LABEL}>Routing</span>
          <p className="mt-0.5 text-[10.5px] text-ink-secondary">
            Where each outcome sends the run — the keyboard equivalent of dragging from a handle on the card.
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {outcomes.map((handle) => (
              <li key={handle.outcome} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "w-[76px] shrink-0 truncate font-mono text-[11px]",
                    handle.implicit ? "font-medium text-danger" : "text-ink-secondary",
                  )}
                >
                  {handle.outcome}
                </span>
                <span aria-hidden className="shrink-0 text-[11px] text-ink-secondary">
                  →
                </span>
                <select
                  aria-label={`Routes to, for outcome "${handle.outcome}" on ${node.id}`}
                  value={routes[handle.outcome] ?? ""}
                  onChange={(event) => onRoute(handle.outcome, event.target.value)}
                  className={cn(FIELD, "min-w-0 flex-1")}
                >
                  <option value="">Ends the run</option>
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.label}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>

        <button
          type="button"
          onClick={onDelete}
          className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-danger/40 px-2.5 py-1.5 text-[11.5px] font-medium text-danger hover:bg-danger/10"
        >
          <Trash2 size={13} aria-hidden />
          Delete node
        </button>
      </div>
    </aside>
  );
}
