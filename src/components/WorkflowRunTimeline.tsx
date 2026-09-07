// The observation panel: which run is being watched, and what it did.
//
// It renders only from a `WorkflowRun` — the receipt the engine writes and
// the `workflow-run` SSE frame keeps live — so there is no second copy of
// run state anywhere, and a frame repaints it for free. No xyflow here
// either: the whole panel is static markup a test can render.
import { useEffect, useRef } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  formatRunDuration,
  isActiveWorkflowRun,
  runDurationMs,
  runStatusLabel,
  stepDurationMs,
} from "@/lib/workflow-observation";
import { isMissedWorkflowRun } from "@/lib/workflow-state";
import { excerpt } from "./WorkflowNodeCard";
import {
  workflowOutageWaitMessage,
  type WorkflowNodeResult,
  type WorkflowRun,
  type WorkflowRunStatus,
} from "../../shared/workflow";

const STATUS_TONE: Record<WorkflowRunStatus, string> = {
  queued: "bg-warning/15 text-warning",
  running: "bg-success/15 text-success",
  "waiting-approval": "bg-accent/15 text-accent",
  completed: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-control text-ink-secondary",
};

const TRIGGER_LABEL = { manual: "Manual", schedule: "Schedule", webhook: "Webhook" } as const;

function triggerLabel(run: WorkflowRun): string {
  return run.trigger ? TRIGGER_LABEL[run.trigger] : "Manual";
}

function formatWhen(at: number): string {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusClass(run: WorkflowRun): string {
  return isMissedWorkflowRun(run) ? "bg-warning/15 text-warning" : STATUS_TONE[run.status];
}

/** A missed slot's receipt reads `missed: <why>`; the prefix is the machine's
 * marker, so the panel shows the reason and lets the badge say "Missed". */
function failureText(run: WorkflowRun): string | null {
  if (!run.error) return null;
  return isMissedWorkflowRun(run) ? run.error.replace(/^missed:\s*/, "") : run.error;
}

export interface WorkflowRunTimelineProps {
  /** This workflow's runs, newest-first, exactly as the store keeps them. */
  runs: readonly WorkflowRun[];
  /** The run being observed, already resolved by `observedRunFor`. */
  run: WorkflowRun | null;
  /** null while the panel is following the live (or most recent) run. */
  pickedId: string | null;
  /** Passed in rather than read from the clock, so a live run's elapsed time
   * is a pure function of a render. */
  now: number;
  onPick: (runId: string | null) => void;
  /** Absent when nothing can be opened; a step with no `threadId` never
   * offers navigation even when this is provided. */
  onOpenStep?: (result: WorkflowNodeResult) => void;
  /** A bot's display name, for the step a fallback bot ran; undefined (or
   * the prop absent) falls back to the id, which is still the truth. */
  botName?: (botId: string) => string | undefined;
}

export function WorkflowRunTimeline({ runs, run, pickedId, now, onPick, onOpenStep, botName }: WorkflowRunTimelineProps) {
  const observedRowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    observedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [run?.id]);

  if (runs.length === 0) {
    return (
      <div className="space-y-2">
        <h2 className="text-[13.5px] font-semibold text-ink">No runs yet</h2>
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          Nothing has run this workflow. Switch back to Edit and press Run, or wait for its schedule or webhook to
          fire — this panel then follows the run live.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <section className="min-h-0 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <h2 id="wf-run-picker-heading" className="text-[13.5px] font-semibold text-ink">
            Runs
          </h2>
          {pickedId !== null && (
            <button
              type="button"
              onClick={() => onPick(null)}
              className="rounded-lg border border-hairline/60 px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
            >
              Follow latest
            </button>
          )}
        </div>
        <ul
          aria-labelledby="wf-run-picker-heading"
          className="mt-1.5 max-h-[168px] space-y-1 overflow-y-auto pr-0.5"
        >
          {runs.map((candidate) => {
            const observed = candidate.id === run?.id;
            return (
              <li key={candidate.id}>
                <button
                  type="button"
                  // The list scrolls and the followed run can be anywhere in
                  // it — a live run started days after the one below it, or
                  // an old one the author picked. Keeping the observed row
                  // in view is what makes the panel readable without hunting.
                  ref={observed ? observedRowRef : undefined}
                  onClick={() => onPick(candidate.id)}
                  aria-current={observed ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-[10.5px]",
                    observed ? "border-accent/50 bg-accent/10" : "border-hairline/40 hover:bg-raised",
                  )}
                >
                  <span className={cn("shrink-0 rounded-full px-1.5 py-px font-medium", statusClass(candidate))}>
                    {isActiveWorkflowRun(candidate) && (
                      <span className="mr-1 inline-block size-1 animate-pulse rounded-full bg-current align-middle" aria-hidden />
                    )}
                    {runStatusLabel(candidate)}
                  </span>
                  <span className="shrink-0 text-ink-secondary">{triggerLabel(candidate)}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-ink-secondary">
                    {formatWhen(candidate.startedAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {run && (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* The observed run advances on its own, so its status is the one
                thing here that changes without the reader doing anything.
                Only the LABEL is the live region: the elapsed time beside it
                ticks every few seconds, and announcing that would bury the
                transition that actually matters. */}
            <span
              role="status"
              className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-medium", statusClass(run))}
            >
              {runStatusLabel(run)}
            </span>
            <span className="text-[11px] text-ink-secondary">{triggerLabel(run)}</span>
            <span aria-hidden className="text-[11px] text-ink-secondary">
              ·
            </span>
            <span className="text-[11px] tabular-nums text-ink-secondary">
              {isActiveWorkflowRun(run) ? "Running for " : ""}
              {formatRunDuration(runDurationMs(run, now))}
            </span>
          </div>

          {failureText(run) && (
            <p
              className={cn(
                "mt-2 flex gap-1.5 rounded-lg px-2 py-1.5 text-[11px] leading-relaxed",
                isMissedWorkflowRun(run) ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger",
              )}
            >
              <AlertTriangle size={11} aria-hidden className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">
                <span className="sr-only">{isMissedWorkflowRun(run) ? "Missed: " : "Failed: "}</span>
                {failureText(run)}
              </span>
            </p>
          )}

          <h3 className="mt-3 shrink-0 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">Steps</h3>
          {run.nodeResults.length === 0 ? (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
              {run.status === "queued"
                ? "Queued behind another run of this workflow — no node has started yet."
                : "No node has finished yet."}
            </p>
          ) : (
            <ol className="mt-1.5 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
              {run.nodeResults.map((result, index) => {
                const body = (
                  <>
                    <div className="flex items-center gap-1.5">
                      <span className="shrink-0 tabular-nums text-[10px] text-ink-secondary">{index + 1}</span>
                      <span className="min-w-0 truncate font-mono text-[11px] text-ink">{result.nodeId}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium",
                          result.outcome === "failed" ? "bg-danger/15 text-danger" : "bg-success/15 text-success",
                        )}
                      >
                        {result.outcome}
                      </span>
                      <span className="ml-auto shrink-0 tabular-nums text-[10px] text-ink-secondary">
                        {formatRunDuration(stepDurationMs(result))}
                      </span>
                    </div>
                    {result.summary && (
                      <p className="mt-0.5 break-words text-[10.5px] leading-snug text-ink-secondary">
                        {/* A summary is bounded at 2000 chars by the engine;
                            printed whole it buries every other step in a
                            320px column. The full text is one click away in
                            the transcript. */}
                        {excerpt(result.summary, 200)}
                      </p>
                    )}
                    {result.fallback && (
                      // The receipt names who actually did the work: the
                      // node's own bot was unreachable and its fallback ran
                      // the step. The provider error is the reason, kept
                      // short — the whole of it is in the run frame.
                      <p className="mt-0.5 break-words text-[10.5px] leading-snug text-warning">
                        Ran on fallback bot {botName?.(result.fallback.botId) ?? result.fallback.botId} because:{" "}
                        {excerpt(result.fallback.because, 120)}
                      </p>
                    )}
                  </>
                );
                const openable = result.threadId !== undefined && onOpenStep !== undefined;
                return (
                  <li key={`${result.nodeId}:${index}`}>
                    {openable ? (
                      <button
                        type="button"
                        onClick={() => onOpenStep?.(result)}
                        className="w-full rounded-lg border border-hairline/40 px-2 py-1.5 text-left hover:border-accent/50 hover:bg-raised"
                      >
                        {body}
                        <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-accent">
                          <ExternalLink size={9} aria-hidden />
                          Open transcript
                        </span>
                      </button>
                    ) : (
                      // No thread to open — a notify or approval step never
                      // had one — so it is text, not a control that does
                      // nothing when clicked.
                      <div className="rounded-lg border border-hairline/40 px-2 py-1.5">{body}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          {isActiveWorkflowRun(run) &&
          run.outage?.fallbackBotId !== undefined &&
          run.currentBotId === run.outage.fallbackBotId &&
          run.nextAttemptAt !== undefined ? (
            // Handed to the fallback but the fallback was busy: the run is
            // parked for THAT bot (the engine keeps currentBotId aimed at
            // it), not for the provider — say so, or the count below would
            // read as an outage wait that never advances.
            <p role="status" className="mt-2 flex shrink-0 items-start gap-1.5 text-[10.5px] text-warning">
              <Loader2 size={10} className="mt-0.5 animate-spin" aria-hidden />
              <span className="min-w-0 break-words">
                Waiting for fallback bot {botName?.(run.outage.fallbackBotId) ?? run.outage.fallbackBotId} to be free
                (it is busy) — next try {formatWhen(run.nextAttemptAt)}
              </span>
            </p>
          ) : isActiveWorkflowRun(run) && run.outage && run.nextAttemptAt !== undefined ? (
            // A provider outage is a wait, not a retry: nothing of the
            // node's budget is being spent, so the line must not say
            // "attempt" the way the retry line below does. The count is
            // the outage's own — how many waits so far of how many the
            // horizon allows.
            <p role="status" className="mt-2 flex shrink-0 items-start gap-1.5 text-[10.5px] text-warning">
              <Loader2 size={10} className="mt-0.5 animate-spin" aria-hidden />
              <span className="min-w-0 break-words">
                {workflowOutageWaitMessage(run, formatWhen)}
                {run.outage.fallbackBotId !== undefined && (
                  <> · fallback bot {botName?.(run.outage.fallbackBotId) ?? run.outage.fallbackBotId} was tried</>
                )}
              </span>
            </p>
          ) : isActiveWorkflowRun(run) && run.outage?.fallbackBotId !== undefined && run.currentBotId === run.outage.fallbackBotId ? (
            <p role="status" className="mt-2 flex shrink-0 items-start gap-1.5 text-[10.5px] text-warning">
              <Loader2 size={10} className="mt-0.5 animate-spin" aria-hidden />
              <span className="min-w-0 break-words">
                Running on fallback bot {botName?.(run.outage.fallbackBotId) ?? run.outage.fallbackBotId} because:{" "}
                {excerpt(run.outage.reason, 120)}
              </span>
            </p>
          ) : (
            isActiveWorkflowRun(run) &&
            run.nextAttemptAt !== undefined && (
              <p className="mt-2 flex shrink-0 items-center gap-1.5 text-[10.5px] text-ink-secondary">
                <Loader2 size={10} className="animate-spin" aria-hidden />
                Retrying at {formatWhen(run.nextAttemptAt)}
                {run.attempt > 0 && <span className="tabular-nums">· attempt {run.attempt + 1}</span>}
              </p>
            )
          )}
        </section>
      )}
    </div>
  );
}
