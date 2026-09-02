// What a run adds to one node card: the outcome it produced, a cut of its
// summary, and the action the run is waiting for at that node.
//
// It lives apart from `WorkflowNodeCard` (which stays a pure drawing of the
// document) and apart from `WorkflowCanvas` (which drags in xyflow), so the
// controls that decide a run can be rendered — and tested — as plain markup.
//
// Every control here is `aria-disabled` plus a guarded no-op rather than the
// `disabled` attribute: a button that refuses must still be reachable and
// must still be able to say why, and the why is text in the DOM.
import { Check, ExternalLink, Loader2, RotateCcw, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { formatRunDuration, latestNodeResult, stepDurationMs } from "@/lib/workflow-observation";
import type { WorkflowRun } from "../../shared/workflow";
import { excerpt } from "./WorkflowNodeCard";

export interface WorkflowRunNodeFooterProps {
  run: WorkflowRun;
  nodeId: string;
  /** An action on this run is in flight; the controls refuse until it lands. */
  busy?: boolean;
  /** The last action's failure, including the 409 someone else caused by
   * resolving the same gate first. */
  error?: string | null;
  onApprove?: () => void;
  onReject?: () => void;
  onResume?: () => void;
  onOpenThread?: (threadId: string) => void;
}

export function WorkflowRunNodeFooter({
  run,
  nodeId,
  busy = false,
  error = null,
  onApprove,
  onReject,
  onResume,
  onOpenThread,
}: WorkflowRunNodeFooterProps) {
  const last = latestNodeResult(run, nodeId);
  const current = run.currentNodeId === nodeId;
  const gate = current && run.status === "waiting-approval";
  const failed = current && run.status === "failed";
  const busyId = `wf-run-${run.id}-${nodeId}-busy`;
  const threadId = last?.result.threadId;

  if (!last && !gate && !failed && !error) return null;

  const guard = (action?: () => void) => () => {
    if (busy || !action) return;
    action();
  };

  const control = (tone: "accent" | "danger" | "plain") =>
    cn(
      "inline-flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-[10.5px] font-medium",
      busy && "cursor-not-allowed opacity-50",
      tone === "accent" && "bg-accent text-accent-ink",
      tone === "danger" && "border border-danger/50 text-danger",
      tone === "plain" && "border border-hairline/60 text-ink-secondary",
      !busy && tone === "accent" && "hover:brightness-110",
      !busy && tone !== "accent" && "hover:bg-raised",
    );

  return (
    <div className="mt-1.5 space-y-1.5 border-t border-hairline/40 px-3 pt-1.5">
      {last && (
        <div className="text-[10px] leading-snug">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-px font-medium",
                last.result.outcome === "failed" ? "bg-danger/15 text-danger" : "bg-success/15 text-success",
              )}
            >
              <span className="sr-only">Outcome: </span>
              {last.result.outcome}
            </span>
            <span className="shrink-0 tabular-nums text-ink-secondary">
              {formatRunDuration(stepDurationMs(last.result))}
            </span>
            {last.passes > 1 && (
              <span className="shrink-0 tabular-nums text-ink-secondary">
                <span className="sr-only">ran </span>×{last.passes}
              </span>
            )}
          </div>
          {last.result.summary && (
            <p className="mt-0.5 break-words text-ink-secondary">{excerpt(last.result.summary, 80)}</p>
          )}
        </div>
      )}

      {threadId && onOpenThread && (
        <button
          type="button"
          onClick={() => onOpenThread(threadId)}
          className="inline-flex items-center gap-1 rounded-lg border border-hairline/60 px-2 py-1 text-[10.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <ExternalLink size={10} aria-hidden />
          Open transcript
        </button>
      )}

      {failed && run.error && <p className="break-words text-[10px] leading-snug text-danger">{run.error}</p>}

      {(gate || failed) && (
        <div className="flex items-center gap-1.5">
          {gate && (
            <>
              <button
                type="button"
                onClick={guard(onApprove)}
                aria-disabled={busy ? true : undefined}
                aria-describedby={busy ? busyId : undefined}
                className={control("accent")}
              >
                {busy ? <Loader2 size={10} className="animate-spin" aria-hidden /> : <Check size={10} aria-hidden />}
                Approve
              </button>
              <button
                type="button"
                onClick={guard(onReject)}
                aria-disabled={busy ? true : undefined}
                aria-describedby={busy ? busyId : undefined}
                className={control("danger")}
              >
                <X size={10} aria-hidden />
                Reject
              </button>
            </>
          )}
          {failed && (
            <button
              type="button"
              onClick={guard(onResume)}
              aria-disabled={busy ? true : undefined}
              aria-describedby={busy ? busyId : undefined}
              className={control("plain")}
            >
              {busy ? <Loader2 size={10} className="animate-spin" aria-hidden /> : <RotateCcw size={10} aria-hidden />}
              Resume here
            </button>
          )}
        </div>
      )}

      {busy && (
        <p id={busyId} className="text-[10px] text-ink-secondary">
          Working — waiting for the engine to answer
        </p>
      )}

      {error && (
        <p role="alert" className="break-words text-[10px] leading-snug text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
