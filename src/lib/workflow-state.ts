// Pure state helpers for the workflows slice. The store's reducer and the
// SSE fold both call these so the same merge rules are unit-testable
// without a React tree: workflows keep server order and are patched in
// place, runs stay newest-first, and a `workflow` frame that arrives
// without server-computed issues gets them recomputed here — the validator
// is shared with the server, so the badge never disagrees with it.
import { validateWorkflow, type Workflow, type WorkflowIssue, type WorkflowRun } from "../../shared/workflow";

/** One row of GET /api/workflows — a definition plus its validator output. */
export type WorkflowListItem = Workflow & { issues: WorkflowIssue[] };

/** What the SSE `workflow` frame carries: the store emits the bare
 * definition; only the REST routes attach `issues`. */
export type WorkflowFrame = Workflow & { issues?: WorkflowIssue[] };

/** Strip `issues` before validating: the validator only reads the model
 * fields, but keeping the list item shape honest costs nothing. */
function withIssues(workflow: WorkflowFrame): WorkflowListItem {
  const { issues, ...definition } = workflow;
  return { ...definition, issues: issues ?? validateWorkflow(definition) };
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

/** Newest-first by startedAt, the same key the server sorts on. Sorting is
 * stable, so a patch to one of two runs that started at the same instant
 * keeps them where they were. */
function sortRuns(runs: WorkflowRun[]): WorkflowRun[] {
  return runs.slice().sort((a, b) => b.startedAt - a.startedAt);
}

export function upsertWorkflowRun(runs: WorkflowRun[], incoming: WorkflowRun): WorkflowRun[] {
  const at = runs.findIndex((run) => run.id === incoming.id);
  if (at === -1) return sortRuns([incoming, ...runs]);
  const copy = runs.slice();
  copy[at] = incoming;
  return sortRuns(copy);
}

/** Boot snapshot: the REST rows already carry issues; tolerate a row that
 * does not so a partial server never leaves the badge blank. */
export function mergeWorkflowSnapshot(
  workflows: WorkflowFrame[],
  runs: WorkflowRun[],
): { workflows: WorkflowListItem[]; runs: WorkflowRun[] } {
  return { workflows: workflows.map(withIssues), runs: sortRuns(runs) };
}

/** Newest run of one workflow, relying on the slice being newest-first. */
export function latestWorkflowRun(runs: WorkflowRun[], workflowId: string): WorkflowRun | null {
  return runs.find((run) => run.workflowId === workflowId) ?? null;
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
