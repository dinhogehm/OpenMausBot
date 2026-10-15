import type { RunRecord as StoredRun, RunStatus } from "../../src/execution.ts";

export type VisibleRun = StoredRun & { canApprove: boolean; canCancel: boolean };

export function mergeRuns(current: VisibleRun[], incoming: VisibleRun[]): VisibleRun[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  const progress = (status: RunStatus) => status === "waiting_approval" ? 0 : status === "running" ? 1 : 2;
  for (const run of incoming) {
    const previous = byId.get(run.id);
    // A read dispatched before an action must not undo its newer receipt.
    const older = previous && (run.generation < previous.generation
      || (run.generation === previous.generation && (run.updatedAt < previous.updatedAt
        || (run.updatedAt === previous.updatedAt && progress(run.status) < progress(previous.status)))));
    byId.set(run.id, older ? { ...previous, canApprove: previous.canApprove && run.canApprove, canCancel: previous.canCancel && run.canCancel } : run);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}

/** Refuse a response from another company or workspace before it enters the UI. */
export function validateRunScope(records: VisibleRun[], organizationId: string, workspaceId: string): VisibleRun[] {
  if (records.some((run) => run.organizationId !== organizationId || run.workspaceId !== workspaceId)) throw new Error("Unexpected response scope");
  return records;
}
