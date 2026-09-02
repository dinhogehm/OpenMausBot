// Pure state helpers for the workflows slice. The store's reducer and the
// SSE fold both call these so the same merge rules are unit-testable
// without a React tree: workflows keep server order and are patched in
// place, runs stay newest-first under a fixed cap, and a `workflow` frame
// that arrives without server-computed issues gets structural ones
// recomputed here. What a row STORES is only ever a snapshot, though:
// capability issues depend on the bots' flags, which move on their own
// `bot` frames, so the list is drawn from `withLiveIssues` over the current
// roster — the same union the canvas draws — never from the stored value.
import {
  capabilityIssues,
  validateWorkflow,
  type BotCapabilities,
  type Workflow,
  type WorkflowIssue,
  type WorkflowRun,
} from "../../shared/workflow";
import { capabilityLookup, type CapabilityBearer } from "./workflow-capabilities";

/** How many runs the renderer keeps across every workflow. The boot
 * snapshot asks the server for exactly this many; live frames are capped
 * against the same number so a long-lived window cannot grow without
 * bound. The list only ever shows the newest run per workflow. */
export const WORKFLOW_RUNS_KEPT = 200;

/** One row of GET /api/workflows — a definition plus its validator output. */
export type WorkflowListItem = Workflow & { issues: WorkflowIssue[] };

/** What the SSE `workflow` frame carries: the store emits the bare
 * definition; only the REST routes attach `issues`. */
export type WorkflowFrame = Workflow & { issues?: WorkflowIssue[] };

/** Strip `issues` before validating: the validator only reads the model
 * fields, but keeping the list item shape honest costs nothing. Only the
 * structural pass is possible here — the slice knows no bots — which is one
 * more reason the stored list is a snapshot and the rendered one is not. */
function withIssues(workflow: WorkflowFrame): WorkflowListItem {
  const { issues, ...definition } = workflow;
  return { ...definition, issues: issues ?? validateWorkflow(definition) };
}

/** Every issue the server would report for this definition right now: the
 * structural pass plus the capability pass against the given roster. The
 * canvas and the list both draw this union, so a flag flipped in a bot's
 * profile moves the badge and the Run gate without a save or a reload. */
export function liveWorkflowIssues(
  workflow: Workflow,
  lookup: (botId: string) => BotCapabilities | null,
): WorkflowIssue[] {
  return [...validateWorkflow(workflow), ...capabilityIssues(workflow, lookup)];
}

/** The rows as they should be drawn. The stored `issues` snapshot is
 * REPLACED, never merged: it may have been judged against a roster whose
 * flags have since moved. */
export function withLiveIssues(
  workflows: readonly WorkflowListItem[],
  bots: readonly CapabilityBearer[],
): WorkflowListItem[] {
  const lookup = capabilityLookup(bots);
  return workflows.map((workflow) => {
    const { issues: _snapshot, ...definition } = workflow;
    return { ...definition, issues: liveWorkflowIssues(definition, lookup) };
  });
}

export function upsertWorkflow(workflows: WorkflowListItem[], incoming: WorkflowFrame): WorkflowListItem[] {
  const next = withIssues(incoming);
  const at = workflows.findIndex((workflow) => workflow.id === next.id);
  if (at === -1) return [...workflows, next];
  const copy = workflows.slice();
  copy[at] = next;
  return copy;
}

/** Same array back when nothing matched, so a stray delete frame is a
 * no-op render. Runs are deliberately NOT touched: a deleted workflow's
 * history stays readable until the next snapshot drops it. */
export function removeWorkflow(workflows: WorkflowListItem[], id: string): WorkflowListItem[] {
  if (!workflows.some((workflow) => workflow.id === id)) return workflows;
  return workflows.filter((workflow) => workflow.id !== id);
}

/** Newest-first by startedAt, the same key the server sorts on, then cut to
 * the cap. Sorting is stable, so a patch to one of two runs that started at
 * the same instant keeps them where they were. */
function sortAndCapRuns(runs: WorkflowRun[]): WorkflowRun[] {
  return runs.slice().sort((a, b) => b.startedAt - a.startedAt).slice(0, WORKFLOW_RUNS_KEPT);
}

export function upsertWorkflowRun(runs: WorkflowRun[], incoming: WorkflowRun): WorkflowRun[] {
  const at = runs.findIndex((run) => run.id === incoming.id);
  if (at === -1) return sortAndCapRuns([incoming, ...runs]);
  const copy = runs.slice();
  copy[at] = incoming;
  return sortAndCapRuns(copy);
}

/** Boot snapshot: the REST rows already carry issues; tolerate a row that
 * does not so a partial server never leaves the badge blank. */
export function mergeWorkflowSnapshot(
  workflows: WorkflowFrame[],
  runs: WorkflowRun[],
): { workflows: WorkflowListItem[]; runs: WorkflowRun[] } {
  return { workflows: workflows.map(withIssues), runs: sortAndCapRuns(runs) };
}

/** Newest run per workflow in one pass, so a list of rows does not rescan
 * the whole slice for each row. Relies on the slice being newest-first. */
export function latestRunsByWorkflow(runs: WorkflowRun[]): Map<string, WorkflowRun> {
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    if (!latest.has(run.workflowId)) latest.set(run.workflowId, run);
  }
  return latest;
}

/** The engine records a scheduled slot it could not honour (the app was
 * closed past the catch-up window) as a failed run whose error starts with
 * "missed:"; the list shows that as a missed slot, not a broken graph. */
export function isMissedWorkflowRun(run: WorkflowRun): boolean {
  return run.status === "failed" && run.trigger === "schedule" && (run.error?.startsWith("missed:") ?? false);
}

export function validationSummary(issues: WorkflowIssue[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}
