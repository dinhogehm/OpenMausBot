import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";

import { api, useStore } from "@/state/store";
import {
  isMissedWorkflowRun,
  latestRunsByWorkflow,
  validationSummary,
  type WorkflowListItem,
} from "@/lib/workflow-state";
import { nextRename } from "@/lib/rename";
import type { WorkflowRun, WorkflowRunStatus } from "../../shared/workflow";
import { cn } from "@/lib/cn";

/** "New workflow" posts an empty canvas. The server saves it as a draft and
 * reports the missing entry node as an issue until the canvas adds one. */
const EMPTY_DRAFT = { name: "Untitled workflow", entryNodeId: "", nodes: [], edges: [], layout: {} };

const RUN_TONE: Record<WorkflowRunStatus, string> = {
  queued: "bg-warning/15 text-warning",
  running: "bg-success/15 text-success",
  "waiting-approval": "bg-accent/15 text-accent",
  completed: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-control text-ink-secondary",
};

const RUN_LABEL: Record<WorkflowRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  "waiting-approval": "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

type RowBusy = "rename" | "run" | "delete";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** Date + time, short: a run from three days ago must not read like today. */
function formatWhen(at: number): string {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** `nextRunAt` is engine state: null right after a schedule edit and after a
 * one-time schedule fires, with the real instant arriving on a later frame.
 * "Pending" is the honest word for that gap — "not scheduled" would be a lie. */
export function scheduleLabel(workflow: WorkflowListItem): string {
  if (!workflow.triggers?.schedule) return "Not scheduled";
  if (typeof workflow.nextRunAt !== "number") return "Scheduled · next run pending";
  return `Next run: ${formatWhen(workflow.nextRunAt)}`;
}

/** Errors and warnings are counted, never merged: only errors block a run.
 * The messages sit in a `details` so a keyboard or screen-reader user can
 * open them — a `title` tooltip is mouse-only and invisible on touch. */
export function ValidationBadge({ issues }: { issues: WorkflowListItem["issues"] }) {
  const { errors, warnings } = validationSummary(issues);
  const label =
    errors > 0
      ? `${errors} ${errors === 1 ? "error" : "errors"}`
      : `${warnings} ${warnings === 1 ? "warning" : "warnings"}`;

  if (issues.length === 0) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10.5px] font-medium text-success">
        <CheckCircle2 size={11} aria-hidden /> Valid
      </span>
    );
  }

  return (
    <details className="group min-w-0">
      <summary
        className={cn(
          "inline-flex cursor-pointer list-none items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium [&::-webkit-details-marker]:hidden",
          errors > 0 ? "bg-danger/15 text-danger" : "bg-warning/15 text-warning",
        )}
      >
        <AlertTriangle size={11} aria-hidden />
        {label}
        <span className="sr-only">— show details</span>
      </summary>
      <ul className="mt-1.5 space-y-1 rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[11.5px] leading-relaxed">
        {issues.map((issue, index) => (
          <li key={`${issue.code}:${issue.nodeId ?? ""}:${index}`} className="flex gap-1.5">
            <span className={cn("shrink-0 font-medium", issue.severity === "error" ? "text-danger" : "text-warning")}>
              {issue.severity === "error" ? "Error" : "Warning"}
            </span>
            <span className="min-w-0 text-ink-secondary">{issue.message}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The status and time stay real text: `aria-label` on a role-less span is
 * dropped by every browser, so a named wrapper would be silent. The failure
 * reason rides along in an `sr-only` span rather than a mouse-only tooltip. */
export function RunPill({ run }: { run: WorkflowRun | null }) {
  if (!run) return <span className="text-[11px] text-ink-secondary">No runs yet</span>;
  const missed = isMissedWorkflowRun(run);
  const label = missed ? "Missed" : RUN_LABEL[run.status];
  const when = formatWhen(run.startedAt);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
        missed ? "bg-warning/15 text-warning" : RUN_TONE[run.status],
      )}
    >
      {run.status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      <span className="sr-only">Last run: </span>
      <span>{label}</span>
      <span className="font-normal tabular-nums opacity-80">{when}</span>
      {run.error && <span className="sr-only">. {run.error}</span>}
    </span>
  );
}

export interface WorkflowRowProps {
  workflow: WorkflowListItem;
  latestRun: WorkflowRun | null;
  selected: boolean;
  busy: RowBusy | null;
  error: string | null;
  onSelect: () => void;
  onRename: (name: string) => void;
  onRun: () => void;
  onDelete: () => void;
  onDismissError: () => void;
}

export function WorkflowRow({
  workflow,
  latestRun,
  selected,
  busy,
  error,
  onSelect,
  onRename,
  onRun,
  onDelete,
  onDismissError,
}: WorkflowRowProps) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(workflow.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  // Enter and Escape settle the edit themselves; the blur that follows the
  // input unmounting (or a click elsewhere) goes through the same one-shot
  // gate, so a rename can never PATCH twice and a blur the browser defers
  // cannot leave the row stuck in edit mode.
  const settledRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const { errors } = validationSummary(workflow.issues);
  // Never a bare `disabled`: that drops the button out of the tab order AND
  // suppresses its tooltip, so nobody ever learns why running is refused.
  const runBlockedReason =
    errors > 0
      ? `Fix ${errors} ${errors === 1 ? "error" : "errors"} before running`
      : busy !== null
        ? "Another action is still running"
        : null;

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  // A rename leaves the button disabled while its PATCH is in flight, so the
  // focus can only land once editing is over AND the row is idle again.
  useEffect(() => {
    if (editing || busy !== null || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    renameButtonRef.current?.focus();
  }, [editing, busy]);

  const startEditing = () => {
    settledRef.current = false;
    setDraftName(workflow.name);
    setEditing(true);
  };

  const finishEditing = (commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    setEditing(false);
    // focus is restored in an effect: this button is still disabled during
    // this render, and a disabled button cannot take focus
    restoreFocusRef.current = true;
    if (!commit) return;
    const name = nextRename(workflow.name, draftName);
    if (name) onRename(name);
  };

  return (
    <li
      className={cn(
        "rounded-xl border bg-card transition",
        selected ? "border-accent/40" : "border-hairline/40 hover:border-hairline/70",
      )}
      aria-current={selected ? "true" : undefined}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <WorkflowIcon size={18} className={cn("shrink-0", selected ? "text-accent" : "text-ink-secondary")} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {editing ? (
              <input
                ref={inputRef}
                value={draftName}
                maxLength={120}
                aria-label="Workflow name"
                onChange={(event) => setDraftName(event.target.value)}
                // clicking Delete must not also commit a half-typed rename
                onBlur={(event) => finishEditing(event.relatedTarget !== deleteButtonRef.current)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    finishEditing(true);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    finishEditing(false);
                  }
                }}
                className="min-w-0 flex-1 rounded-md border border-accent/50 bg-inset px-2 py-0.5 text-[13.5px] font-semibold text-ink outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={onSelect}
                onDoubleClick={startEditing}
                title={workflow.description || undefined}
                className="min-w-0 truncate text-left text-[13.5px] font-semibold text-ink hover:text-accent"
              >
                {workflow.name}
              </button>
            )}
            <ValidationBadge issues={workflow.issues} />
            {runBlockedReason && (
              <span id={`${workflow.id}-run-blocked`} className={cn("text-[11px]", errors > 0 ? "text-danger" : "text-ink-secondary")}>
                {runBlockedReason}
              </span>
            )}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-secondary">
            <RunPill run={latestRun} />
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <CalendarClock size={11} aria-hidden /> {scheduleLabel(workflow)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            ref={renameButtonRef}
            type="button"
            onClick={startEditing}
            disabled={busy !== null || editing}
            aria-label={`Rename ${workflow.name}`}
            title="Rename"
            className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            {busy === "rename" ? <Loader2 size={15} className="animate-spin" /> : <Pencil size={15} />}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!runBlockedReason) onRun();
            }}
            aria-disabled={runBlockedReason ? true : undefined}
            aria-describedby={runBlockedReason ? `${workflow.id}-run-blocked` : undefined}
            aria-label={`Run ${workflow.name}`}
            title={runBlockedReason ?? "Run now"}
            className={cn(
              "rounded-lg p-2 text-ink-secondary",
              runBlockedReason ? "cursor-not-allowed opacity-40" : "hover:bg-raised hover:text-success",
            )}
          >
            {busy === "run" ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
          </button>
          <button
            ref={deleteButtonRef}
            type="button"
            onClick={onDelete}
            disabled={busy !== null}
            aria-label={`Delete ${workflow.name}`}
            title="Delete"
            className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-40"
          >
            {busy === "delete" ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
          </button>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-t border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Dismiss error"
            className="shrink-0 rounded p-0.5 hover:bg-danger/15"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </li>
  );
}

export function WorkflowsPage() {
  const { state, dispatch } = useStore();
  const [creating, setCreating] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, RowBusy>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // one pass over the runs instead of a scan per row
  const latestRuns = useMemo(() => latestRunsByWorkflow(state.workflowRuns), [state.workflowRuns]);

  // One in-flight action per row. A failure lands inline on that row and
  // leaves local state untouched: the SSE fold (and the echoed response) is
  // the only thing that changes what a row shows.
  const withRow = useCallback(async (id: string, kind: RowBusy, task: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [id]: kind }));
    setRowErrors((current) => omit(current, id));
    try {
      await task();
    } catch (cause) {
      setRowErrors((current) => ({ ...current, [id]: errorText(cause) }));
    } finally {
      setBusy((current) => omit(current, id));
    }
  }, []);

  const create = async () => {
    setCreating(true);
    setPageError(null);
    try {
      const { workflow } = await api("/api/workflows", { method: "POST", body: JSON.stringify(EMPTY_DRAFT) });
      if (workflow) {
        // the SSE frame carries the same row; upsert is idempotent
        dispatch({ type: "workflowPatched", workflow });
        dispatch({ type: "selectWorkflow", workflowId: workflow.id });
      }
    } catch (cause) {
      setPageError(errorText(cause));
    } finally {
      setCreating(false);
    }
  };

  const rename = (id: string, name: string) =>
    void withRow(id, "rename", async () => {
      // the response carries the saved definition AND its issues, so the
      // badge updates from the same round trip that renamed the row
      const { workflow } = await api(`/api/workflows/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      if (workflow) dispatch({ type: "workflowPatched", workflow });
    });

  const run = (id: string) =>
    void withRow(id, "run", async () => {
      const { run: started } = await api(`/api/workflows/${id}/runs`, { method: "POST", body: "{}" });
      if (started) dispatch({ type: "workflowRunPatched", run: started });
    });

  const remove = (workflow: WorkflowListItem) => {
    if (!window.confirm(`Delete “${workflow.name}”? Its run history stays visible until the next reload.`)) return;
    void withRow(workflow.id, "delete", async () => {
      await api(`/api/workflows/${workflow.id}`, { method: "DELETE" });
      dispatch({ type: "workflowDeleted", workflowId: workflow.id });
    });
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline/40 px-7 py-5 max-md:pl-12">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <WorkflowIcon size={20} className="text-accent" />
            <h1 className="text-[18px] font-semibold">Workflows</h1>
          </div>
          <p className="mt-1 text-[12.5px] text-ink-secondary">
            Deterministic multi-agent pipelines: draw the graph, wire every outcome, then run it by hand, on a
            schedule or from a webhook.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void create()}
          disabled={creating}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
        >
          {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          New workflow
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        {pageError && (
          <div
            role="alert"
            className="mb-4 flex max-w-[900px] items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            <span className="min-w-0 flex-1 break-words">{pageError}</span>
            <button
              type="button"
              onClick={() => setPageError(null)}
              aria-label="Dismiss error"
              className="shrink-0 rounded p-0.5 hover:bg-danger/15"
            >
              <X size={12} />
            </button>
          </div>
        )}
        {state.workflows.length === 0 ? (
          <div className="max-w-[720px] rounded-xl border border-dashed border-hairline bg-panel px-4 py-8 text-center text-[12.5px] text-ink-secondary">
            No workflows yet. Create one to start designing a pipeline your bots run without you watching.
          </div>
        ) : (
          <ul className="max-w-[900px] space-y-2">
            {state.workflows.map((workflow) => (
              <WorkflowRow
                key={workflow.id}
                workflow={workflow}
                latestRun={latestRuns.get(workflow.id) ?? null}
                selected={workflow.id === state.selectedWorkflowId}
                busy={busy[workflow.id] ?? null}
                error={rowErrors[workflow.id] ?? null}
                onSelect={() => dispatch({ type: "selectWorkflow", workflowId: workflow.id })}
                onRename={(name) => rename(workflow.id, name)}
                onRun={() => run(workflow.id)}
                onDelete={() => remove(workflow)}
                onDismissError={() => setRowErrors((current) => omit(current, workflow.id))}
              />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
