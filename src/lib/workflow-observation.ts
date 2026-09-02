// Reading a run, as pure functions over the receipt the engine writes.
//
// The canvas keeps no copy of run state: `state.workflowRuns` is kept live by
// the `workflow-run` SSE frame, and everything the observation view shows is
// derived from it here. That is the whole point of this file — a run frame
// changes what the drawing says without any of it passing through the
// editor's document, its save queue, or a second store.
//
// Two receipt facts shape almost every rule below, both from
// `server/workflow-run.ts`:
//   * a node that FINISHED leaves a `nodeResults` entry (a loop leaves one
//     per pass), and `advance` records it in the same write that clears the
//     per-dispatch bookkeeping;
//   * a run that FAILED keeps `currentNodeId` pointing at the node that
//     broke and records NO result for it — which is exactly why "failed" is
//     read off the run's status and current node rather than off a result.
import type {
  WorkflowEdge,
  WorkflowNodeResult,
  WorkflowRun,
  WorkflowRunStatus,
} from "../../shared/workflow";
import { isMissedWorkflowRun } from "./workflow-state";
import type { WorkflowGraphEdgeDecoration } from "./workflow-graph";

/** How a run decorates a node card. Lives here rather than in the card
 * because the vocabulary is an observation concept; the card re-exports it. */
export type WorkflowNodeTone = "idle" | "current" | "done" | "failed" | "waiting" | "stopped";

/** A run the engine may still move. Everything else is a receipt. */
const ACTIVE_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>([
  "queued",
  "running",
  "waiting-approval",
]);

export function isActiveWorkflowRun(run: WorkflowRun): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

/** The store keeps `workflowRuns` newest-first across every workflow; this
 * only narrows it, so the order the picker shows is the store's own. */
export function workflowRunsFor(runs: readonly WorkflowRun[], workflowId: string): WorkflowRun[] {
  return runs.filter((run) => run.workflowId === workflowId);
}

/** Which run the canvas is observing: the author's pick when it is still one
 * of this workflow's runs, else the live one, else the most recent. A pick
 * that no longer resolves (another workflow's run, or one evicted by the run
 * cap) falls back rather than blanking the view. */
export function observedRunFor(
  runs: readonly WorkflowRun[],
  workflowId: string,
  pickedId?: string | null,
): WorkflowRun | null {
  const mine = workflowRunsFor(runs, workflowId);
  if (pickedId) {
    const picked = mine.find((run) => run.id === pickedId);
    if (picked) return picked;
  }
  return mine.find(isActiveWorkflowRun) ?? mine[0] ?? null;
}

/** `current` is deliberately narrow: only a run the engine can still move
 * has a node in flight. A completed run's `currentNodeId` is simply where it
 * ended, and that node has a result, so the fallback below calls it `done`.
 *
 * A cancelled run is the case worth stating: its `currentNodeId` is a node
 * that was interrupted mid-flight, and "where did it stop?" is the only
 * question the author has after cancelling. `idle` would assert the run
 * never got there; and in a review loop, where that node ALSO carries an
 * earlier result, the fallback would call it `done` — claiming the pass that
 * was cut short had finished. `stopped` is the honest answer, which is why
 * it is decided here rather than left to the `nodeResults` fallback. */
export function nodeTone(run: WorkflowRun | null | undefined, nodeId: string): WorkflowNodeTone {
  if (!run) return "idle";
  if (run.currentNodeId === nodeId) {
    if (run.status === "failed") return "failed";
    if (run.status === "waiting-approval") return "waiting";
    if (run.status === "running") return "current";
    if (run.status === "cancelled") return "stopped";
  }
  return run.nodeResults.some((result) => result.nodeId === nodeId) ? "done" : "idle";
}

/** The node's most recent pass and how many it has had. A review loop runs
 * the same node repeatedly; the card has room for the latest outcome and a
 * count, not for a transcript. */
export function latestNodeResult(
  run: WorkflowRun | null | undefined,
  nodeId: string,
): { result: WorkflowNodeResult; passes: number } | null {
  if (!run) return null;
  let last: WorkflowNodeResult | null = null;
  let passes = 0;
  for (const result of run.nodeResults) {
    if (result.nodeId !== nodeId) continue;
    last = result;
    passes += 1;
  }
  return last ? { result: last, passes } : null;
}

/** An edge is identified by what a result can actually prove about it: the
 * node that produced the outcome and the outcome itself. The destination is
 * not recorded on the receipt, so a re-routed edge is credited to whatever
 * the document says today — the honest reading, since that is the only edge
 * that outcome could have taken under the current drawing. */
export function traversedEdgeKey(from: string, outcome: string): string {
  return `${from}\0${outcome}`;
}

export function traversedEdgeCounts(run: WorkflowRun | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const result of run?.nodeResults ?? []) {
    const key = traversedEdgeKey(result.nodeId, result.outcome);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The step the run took to get where it is — the one edge worth animating. */
export function lastTraversedEdgeKey(run: WorkflowRun | null | undefined): string | null {
  const last = run?.nodeResults.at(-1);
  return last ? traversedEdgeKey(last.nodeId, last.outcome) : null;
}

const EDGE_TRAVERSED = "wf-edge-traversed";
const EDGE_UNTAKEN = "wf-edge-untaken";

/** The `decorate` callback `toGraphEdges` takes. Keeping it a factory means
 * the mapping never learns what a run is, and the editor keeps passing
 * nothing at all. */
export function runEdgeDecorator(
  run: WorkflowRun | null | undefined,
): (edge: WorkflowEdge) => WorkflowGraphEdgeDecoration {
  const counts = traversedEdgeCounts(run);
  // Only a live run has a step in flight; a receipt's last edge is history.
  const liveKey = run && isActiveWorkflowRun(run) ? lastTraversedEdgeKey(run) : null;
  return (edge) => {
    const key = traversedEdgeKey(edge.from, edge.outcome);
    const walked = counts.get(key) ?? 0;
    if (walked === 0) return { className: EDGE_UNTAKEN, label: edge.outcome, animated: false };
    return {
      className: EDGE_TRAVERSED,
      label: walked > 1 ? `${edge.outcome} ×${walked}` : edge.outcome,
      animated: key === liveKey,
    };
  };
}

const RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  "waiting-approval": "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A scheduled slot the app was closed through is recorded as a failed run
 * whose error starts with "missed:". Calling that "Failed" would send the
 * author hunting for a broken graph that is not broken. */
export function runStatusLabel(run: WorkflowRun): string {
  return isMissedWorkflowRun(run) ? "Missed" : RUN_STATUS_LABEL[run.status];
}

/** The same six states as a PREDICATE, for prose. Lowercasing a label reads
 * "a waiting for approval run"; a phrase map is what turns that into a
 * sentence — "a run that is waiting for approval". Tense carries the rest:
 * a receipt `has`/`was`, a live run `is`. */
const RUN_STATUS_PHRASE: Record<WorkflowRunStatus, string> = {
  queued: "is queued",
  running: "is running",
  "waiting-approval": "is waiting for approval",
  completed: "has completed",
  failed: "has failed",
  cancelled: "was cancelled",
};

export function runStatusPhrase(run: WorkflowRun): string {
  return isMissedWorkflowRun(run) ? "was missed" : RUN_STATUS_PHRASE[run.status];
}

/** Never negative: a receipt written across a clock adjustment (or a live
 * run rendered a tick before its own start) must not read "-3s". */
export function runDurationMs(run: WorkflowRun, now: number): number {
  return Math.max(0, (run.endedAt ?? now) - run.startedAt);
}

export function stepDurationMs(result: WorkflowNodeResult): number {
  return Math.max(0, result.endedAt - result.startedAt);
}

/** Seconds with one decimal up to a minute, then m/s, then h/m. Short enough
 * for a node card, precise enough to tell a stuck node from a quick one. */
export function formatRunDuration(ms: number): string {
  const total = Math.max(0, ms);
  if (total < 60_000) return `${(total / 1_000).toFixed(1)}s`;
  const seconds = Math.round(total / 1_000);
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
