// The card a workflow node is drawn as. Deliberately free of xyflow: the
// handles arrive through render props, so the same card renders in a test
// (and, later, in a run-observation view) without a flow provider, and every
// piece of visual state — selection, entry, tone, footer — is a prop rather
// than something read out of the editor.
import type { ReactNode } from "react";
import { AlertTriangle, CircleUserRound, Flag, MessageSquare, ShieldQuestion } from "lucide-react";

import { BotAvatar, type BotAvatarProps } from "./Avatar";
import { cn } from "@/lib/cn";
import type { WorkflowGraphNodeData, WorkflowOutcomeHandle } from "@/lib/workflow-graph";
import type { WorkflowNodeTone } from "@/lib/workflow-observation";
import type { WorkflowNode } from "../../shared/workflow";

/** How a run decorates a card. `idle` is the editor's only value; the rest
 * are what the observation view asks for, which is why the vocabulary lives
 * in `@/lib/workflow-observation` (a type-only import, so the card still
 * pulls in nothing at runtime) and not in the document ⇄ graph mapping. */
export type { WorkflowNodeTone };

const TONE_RING: Record<WorkflowNodeTone, string> = {
  idle: "",
  current: "ring-2 ring-accent/70",
  done: "ring-1 ring-success/50",
  failed: "ring-2 ring-danger/70",
  waiting: "ring-2 ring-warning/70",
  stopped: "ring-2 ring-ink-secondary/60",
};

/** A ring is a hint; the badge is the sentence. Four of the six tones say
 * something a reader must not have to infer from a colour — which node is in
 * flight, which one is holding a gate open, where a run broke, and where a
 * cancelled one was interrupted — so each is a word in the DOM. `done` needs
 * none: the footer prints the outcome the node actually produced, and `idle`
 * is the editor's own resting state. */
const TONE_BADGE: Partial<Record<WorkflowNodeTone, { label: string; className: string; pulse: boolean }>> = {
  current: { label: "Running", className: "bg-accent/15 text-accent", pulse: true },
  waiting: { label: "Waiting", className: "bg-warning/15 text-warning", pulse: true },
  failed: { label: "Stopped here", className: "bg-danger/15 text-danger", pulse: false },
  stopped: { label: "Cancelled here", className: "bg-control text-ink-secondary", pulse: false },
};

const KIND_LABEL: Record<WorkflowNode["kind"], string> = {
  agent: "Agent",
  approval: "Approval",
  notify: "Notify",
};

/** One line of body copy, cut so a long instruction cannot stretch the card.
 * Exported so the run footer cuts a node summary exactly the same way. */
export function excerpt(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface WorkflowNodeCardProps {
  data: WorkflowGraphNodeData;
  /** The bot an agent node points at, or null when the id no longer resolves. */
  bot?: BotAvatarProps["bot"] | null;
  /** The room a notify node posts into, or null when it no longer resolves. */
  groupName?: string | null;
  selected?: boolean;
  tone?: WorkflowNodeTone;
  /** Rendered once per source handle, inside that outcome's row. */
  renderSourceHandle?: (handle: WorkflowOutcomeHandle) => ReactNode;
  renderTargetHandle?: () => ReactNode;
  /** Slot the observation view fills with run controls (approve / reject /
   * resume). Wrapped in `nodrag nopan` below, or clicking a control inside it
   * would drag the node instead. */
  footer?: ReactNode;
}

export function WorkflowNodeCard({
  data,
  bot,
  groupName,
  selected = false,
  tone = "idle",
  renderSourceHandle,
  renderTargetHandle,
  footer,
}: WorkflowNodeCardProps) {
  const { node, entry, issues, outcomes } = data;
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const badge = TONE_BADGE[tone];

  return (
    <div
      className={cn(
        "relative w-[240px] rounded-xl border bg-card py-2.5 text-ink shadow-sm transition",
        selected ? "border-accent" : "border-hairline/60",
        errors > 0 && !selected && "border-danger/60",
        TONE_RING[tone],
      )}
    >
      {renderTargetHandle?.()}

      <div className="flex items-start gap-2 px-3">
        {node.kind === "agent" ? (
          bot ? (
            <BotAvatar bot={bot} size={28} animated={false} />
          ) : (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger">
              <CircleUserRound size={16} aria-hidden />
            </span>
          )
        ) : (
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full",
              node.kind === "approval" ? "bg-warning/15 text-warning" : "bg-accent/15 text-accent",
            )}
          >
            {node.kind === "approval" ? <ShieldQuestion size={16} aria-hidden /> : <MessageSquare size={16} aria-hidden />}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[12.5px] font-semibold">
              {node.kind === "agent" ? (bot?.name ?? "Bot missing") : KIND_LABEL[node.kind]}
            </span>
            {entry && (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-accent/15 px-1.5 py-px text-[9.5px] font-medium text-accent">
                <Flag size={9} aria-hidden />
                Entry
              </span>
            )}
            {badge && (
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-medium",
                  badge.className,
                )}
              >
                {badge.pulse && <span className="size-1 animate-pulse rounded-full bg-current" aria-hidden />}
                {badge.label}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-ink-secondary">
            <span className="shrink-0 uppercase tracking-wide">{KIND_LABEL[node.kind]}</span>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate font-mono">{node.id}</span>
          </div>
        </div>
      </div>

      <div className="mt-1.5 px-3 text-[11px] leading-snug text-ink-secondary">
        {node.kind === "agent" &&
          (bot ? (
            <p className="break-words">{excerpt(node.instructions) || "No instructions yet"}</p>
          ) : (
            <p className="break-words text-danger">
              Bot <span className="font-mono">{node.botId}</span> no longer exists — pick another in the panel.
            </p>
          ))}
        {node.kind === "approval" && <p className="break-words">{excerpt(node.prompt) || "No prompt yet"}</p>}
        {node.kind === "notify" && (
          <p className="break-words">
            <span className={cn("font-medium", groupName ? "text-ink" : "text-danger")}>
              {groupName ?? `Room ${node.targetGroupId} no longer exists`}
            </span>
            {groupName && excerpt(node.template) ? ` — ${excerpt(node.template, 60)}` : ""}
          </p>
        )}
      </div>

      {issues.length > 0 && (
        <ul className="mx-3 mt-2 space-y-1 rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[10px] leading-snug">
          {issues.map((issue, index) => (
            <li key={`${issue.code}:${index}`} className="flex gap-1">
              <AlertTriangle
                size={10}
                aria-hidden
                className={cn("mt-0.5 shrink-0", issue.severity === "error" ? "text-danger" : "text-warning")}
              />
              <span className="min-w-0 text-ink-secondary">
                <span className="sr-only">{issue.severity === "error" ? "Error: " : "Warning: "}</span>
                {issue.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      <ul className="mt-2 border-t border-hairline/40 pt-1.5">
        {outcomes.map((handle) => (
          <li
            key={handle.outcome}
            className="relative flex items-center justify-end gap-1.5 py-0.5 pr-3 pl-3 text-[10.5px]"
          >
            <span
              className={cn(
                "min-w-0 truncate",
                handle.implicit ? "font-medium text-danger" : "text-ink-secondary",
              )}
            >
              {handle.outcome}
              {handle.implicit && <span className="sr-only"> (implicit failure path)</span>}
            </span>
            {renderSourceHandle?.(handle)}
          </li>
        ))}
      </ul>

      {footer && <div className="nodrag nopan">{footer}</div>}
    </div>
  );
}
