// Everything about the selected node that does not fit on its card. Dumb by
// design: it never touches the store or the API, it just reports edits, so
// the canvas stays the single owner of the document and of when it saves.
import { useEffect, useRef, useState } from "react";
import { Flag, Plus, Trash2, X } from "lucide-react";

import { cn } from "@/lib/cn";
import type { BotAvatarProps } from "./Avatar";
import type { WorkflowOutcomeHandle } from "@/lib/workflow-graph";
import { BotAvatar } from "./Avatar";
import {
  WORKFLOW_APPROVAL_OUTCOMES,
  WORKFLOW_FAIL_OUTCOME,
  WORKFLOW_NODE_RETRIES_DEFAULT,
  WORKFLOW_NODE_TIMEOUT_DEFAULT_MIN,
  WORKFLOW_APPROVAL_EXPIRES_DEFAULT_H,
  type WorkflowIssue,
  type WorkflowNode,
} from "../../shared/workflow";

export type WorkflowPanelBot = BotAvatarProps["bot"] & { id: string; name: string };
export interface WorkflowPanelGroup {
  id: string;
  name: string;
}
export interface WorkflowRouteTarget {
  id: string;
  label: string;
}

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

export interface WorkflowNodePanelProps {
  node: WorkflowNode;
  issues: WorkflowIssue[];
  entry: boolean;
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
            {node.kind === "agent" ? "Agent node" : node.kind === "approval" ? "Approval gate" : "Notify room"}
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
                  {bots.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

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
