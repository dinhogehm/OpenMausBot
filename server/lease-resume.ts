/**
 * This fork: which of the roots the coordinator holds are a cut autonomous
 * turn's own, going on, for leaseRecoveryFor (bot-autonomy.ts). Pure:
 * resumeCutLeases (index.ts) hands it the coordinator's nodes and its
 * isAutonomyRoot; a test hands it rows.
 *
 * A turn a restart cut after it had handed work out keeps its root: the
 * runtime holds it (waiting, cut) and resumes it with its teammates'
 * results, or with the person's answer on its cards. That resume is the
 * turn's one continuation, so its lease gives nothing back.
 *
 * The live roots alone do not show it. From boot, the coordinator's timer
 * (every 250 ms) and the parked-roots reconcile may resume that root, and
 * the resume may end, before the first autonomy tick (~10 s) looks at the
 * lease: the root has left active() by then, and the lease would run the
 * wake or the reports again beside the answer the resume already gave (two
 * final answers, a hand-off made twice). So a root of the conversation
 * begun with or after the lease that ran more than once counts too, in any
 * status: the runtime never runs an autonomous root's cut first turn again
 * (the coordinator's outward hook in index.ts, executions <= 1), so a
 * second execution can only be its continuation.
 */
import { leaseRecoveryFor, type InFlight, type LeaseRecovery } from "./bot-autonomy.ts";
import type { HandoffView } from "./coordinator.ts";

/** What of a coordinator node the decision reads. */
export type CutRootNode = Pick<HandoffView, "id" | "parentId" | "groupId" | "threadId" | "createdAt" | "executions">;

/** The roots that count as the lease's turn going on: every live root of
 * its conversation an autonomous turn opened (leaseRecoveryFor keeps those
 * begun with or after the lease), and every one begun with or after the
 * lease that already ran more than once, whatever its status now. Each once.
 * `isAutonomyRoot` is asked only of the conversation's own roots that could
 * count (it may read the coordinator's row). */
export function cutTurnRoots<T extends CutRootNode>(
  lease: Pick<InFlight, "threadId" | "startedAt">,
  nodes: { live: readonly T[]; all: readonly T[] },
  isAutonomyRoot: (node: T) => boolean,
): T[] {
  const ownRoot = (node: T): boolean => !node.parentId && !node.groupId && node.threadId === lease.threadId;
  const roots = new Map<string, T>();
  for (const node of nodes.live) {
    if (ownRoot(node) && isAutonomyRoot(node)) roots.set(node.id, node);
  }
  for (const node of nodes.all) {
    if (roots.has(node.id) || !ownRoot(node) || node.executions <= 1 || node.createdAt < lease.startedAt) continue;
    if (isAutonomyRoot(node)) roots.set(node.id, node);
  }
  return [...roots.values()];
}

/** leaseRecoveryFor with the roots cutTurnRoots finds: what becomes of a
 * lease a restart cut off, from the coordinator's nodes (`live`: active();
 * `all`: all(), ended ones too) and the outward actions its turn's rows
 * show. */
export function cutLeaseRecovery<T extends CutRootNode>(
  lease: Pick<InFlight, "threadId" | "startedAt">,
  found: { live: readonly T[]; all: readonly T[]; outward: readonly string[] },
  isAutonomyRoot: (node: T) => boolean,
): LeaseRecovery {
  return leaseRecoveryFor(lease, { roots: cutTurnRoots(lease, found, isAutonomyRoot), outward: found.outward });
}
