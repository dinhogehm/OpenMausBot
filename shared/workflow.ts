/** Pure workflow model shared by the server engine and the renderer canvas.
 * The same validator must refuse persistence and paint inline badges, so it
 * lives here with no I/O and no environment assumptions. */

export const WORKFLOW_CONTROL_OPEN = "<openmaus-workflow>";
export const WORKFLOW_CONTROL_CLOSE = "</openmaus-workflow>";
/** Reserved routing outcome. Every agent node can fail without declaring it,
 * so the engine always has a deterministic path for exhausted retries. */
export const WORKFLOW_FAIL_OUTCOME = "failed";
export const WORKFLOW_APPROVAL_OUTCOMES = ["approved", "rejected"] as const;
export const WORKFLOW_NOTIFY_OUTCOME = "sent";
export const WORKFLOW_NODE_TIMEOUT_DEFAULT_MIN = 30;
export const WORKFLOW_NODE_RETRIES_DEFAULT = 2;
/** Cycles are legal by design (review loops); this cap is what keeps a
 * miswired loop from running a workflow forever. */
export const WORKFLOW_MAX_NODE_EXECUTIONS = 30;
export const WORKFLOW_APPROVAL_EXPIRES_DEFAULT_H = 24;

export type WorkflowNode =
  | {
      kind: "agent";
      id: string;
      botId: string;
      instructions: string;
      outcomes: string[];
      timeoutMinutes?: number;
      retries?: number;
    }
  | { kind: "approval"; id: string; prompt: string; expiresHours?: number; onExpire?: "approved" | "rejected" }
  | { kind: "notify"; id: string; targetGroupId: string; template: string };

export interface WorkflowEdge {
  from: string;
  outcome: string;
  to: string;
}

export interface WorkflowTriggers {
  schedule?: { type: "daily"; time: string; weekdays: number[] } | { type: "once"; at: number };
  webhookId?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  entryNodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout: Record<string, { x: number; y: number }>;
  triggers?: WorkflowTriggers;
  maxNodeExecutions?: number;
  createdAt: number;
  updatedAt: number;
}

export type WorkflowRunStatus = "queued" | "running" | "waiting-approval" | "completed" | "failed" | "cancelled";

export interface WorkflowNodeResult {
  nodeId: string;
  outcome: string;
  summary: string;
  threadId?: string;
  startedAt: number;
  endedAt: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  currentNodeId?: string;
  /** Task thread where the current node is executing (engine bookkeeping). */
  currentThreadId?: string;
  /** When the current node's turn was dispatched (engine bookkeeping). */
  dispatchedAt?: number;
  /** Set once the engine has re-prompted the current node for a missing or
   * invalid outcome envelope; a second miss fails the run. Cleared on every
   * fresh node dispatch, so each node gets exactly one re-prompt. */
  repromptedAt?: number;
  /** Attempt counter for the current node only; resets when the run advances. */
  attempt: number;
  input: string;
  nodeResults: WorkflowNodeResult[];
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** Every outcome the engine may route on for a node — declared ones plus the
 * kind's implicit ones. Agent nodes always carry the reserved failure path. */
export function nodeOutcomes(node: WorkflowNode): string[] {
  switch (node.kind) {
    case "agent":
      return [...node.outcomes, WORKFLOW_FAIL_OUTCOME];
    case "approval":
      return [...WORKFLOW_APPROVAL_OUTCOMES];
    case "notify":
      return [WORKFLOW_NOTIFY_OUTCOME];
  }
}

export interface ParsedWorkflowOutcome {
  outcome: string;
  summary: string;
}

const bounded = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** Keep the routing envelope out of human hands and model prose alike. The
 * last complete envelope wins: a quoted example earlier in the reply cannot
 * accidentally steer the run. */
export function parseWorkflowOutcome(text: string, allowed: string[]): ParsedWorkflowOutcome | null {
  const closeAt = text.lastIndexOf(WORKFLOW_CONTROL_CLOSE);
  const openAt = closeAt < 0 ? -1 : text.lastIndexOf(WORKFLOW_CONTROL_OPEN, closeAt);
  if (openAt < 0) return null;

  const payload = text.slice(openAt + WORKFLOW_CONTROL_OPEN.length, closeAt).trim();
  try {
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const outcome = bounded(raw.outcome, 100);
    const summary = bounded(raw.summary, 2_000);
    if (!outcome || !summary || !allowed.includes(outcome)) return null;
    return { outcome, summary };
  } catch {
    // A malformed control envelope is never a guessable routing decision;
    // the engine treats null as the node's failure path.
  }
  return null;
}

export interface WorkflowIssue {
  severity: "error" | "warning";
  code:
    | "bad-entry"
    | "duplicate-node-id"
    | "duplicate-edge"
    | "dangling-edge"
    | "unknown-outcome"
    | "bad-outcomes"
    | "unwired-outcome"
    | "unwired-failure"
    | "unreachable"
    | "reserved-outcome";
  nodeId?: string;
  message: string;
}

/** Structural validation only — the server refuses to persist on any error,
 * the canvas shows every issue inline. A node with zero wired outcomes is a
 * deliberate terminal sink; wiring some outcomes but not all is a mistake.
 * Determinism is the invariant: every routable outcome has at most one
 * successor, and only edges the engine can actually take count as reachable. */
export function validateWorkflow(workflow: Workflow): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];

  const nodeById = new Map<string, WorkflowNode>();
  for (const node of workflow.nodes) {
    if (nodeById.has(node.id)) {
      issues.push({
        severity: "error",
        code: "duplicate-node-id",
        nodeId: node.id,
        message: `Duplicate node id "${node.id}".`,
      });
      continue;
    }
    nodeById.set(node.id, node);
  }

  for (const node of workflow.nodes) {
    if (node.kind !== "agent") continue;
    if (node.outcomes.includes(WORKFLOW_FAIL_OUTCOME)) {
      issues.push({
        severity: "error",
        code: "reserved-outcome",
        nodeId: node.id,
        message: `Outcome "${WORKFLOW_FAIL_OUTCOME}" is reserved; every agent node already has it implicitly.`,
      });
    }
    if (node.outcomes.length === 0) {
      issues.push({
        severity: "error",
        code: "bad-outcomes",
        nodeId: node.id,
        message: `Node "${node.id}" declares no outcomes; an agent node needs at least one.`,
      });
    }
    const declared = new Set<string>();
    for (const outcome of node.outcomes) {
      if (!outcome.trim()) {
        issues.push({
          severity: "error",
          code: "bad-outcomes",
          nodeId: node.id,
          message: `Node "${node.id}" declares a blank outcome name.`,
        });
      } else if (outcome !== outcome.trim()) {
        // The outcome parser trims names before matching, so a padded
        // declaration is a route the model could never take.
        issues.push({
          severity: "error",
          code: "bad-outcomes",
          nodeId: node.id,
          message: `Node "${node.id}" outcome "${outcome}" has surrounding whitespace the parser strips; it can never be routed.`,
        });
      } else if (outcome.length > 100) {
        // The outcome parser bounds names at 100 chars, so a longer
        // declaration is a route the model could never take.
        issues.push({
          severity: "error",
          code: "bad-outcomes",
          nodeId: node.id,
          message: `Node "${node.id}" outcome "${outcome.slice(0, 24)}…" is longer than 100 chars and can never be parsed.`,
        });
      }
      if (declared.has(outcome)) {
        issues.push({
          severity: "error",
          code: "bad-outcomes",
          nodeId: node.id,
          message: `Node "${node.id}" declares outcome "${outcome}" more than once.`,
        });
      }
      declared.add(outcome);
    }
  }

  const entryExists = nodeById.has(workflow.entryNodeId);
  if (!entryExists) {
    issues.push({
      severity: "error",
      code: "bad-entry",
      message: `Entry node "${workflow.entryNodeId}" does not exist.`,
    });
  }

  for (const edge of workflow.edges) {
    const fromExists = nodeById.has(edge.from);
    const toExists = nodeById.has(edge.to);
    if (fromExists && toExists) continue;
    const anchor = fromExists ? edge.from : toExists ? edge.to : undefined;
    issues.push({
      severity: "error",
      code: "dangling-edge",
      ...(anchor === undefined ? {} : { nodeId: anchor }),
      message: `Edge "${edge.from}" --${edge.outcome}--> "${edge.to}" references a missing node.`,
    });
  }

  const wiredByNode = new Map<string, Set<string>>();
  for (const edge of workflow.edges) {
    const wired = wiredByNode.get(edge.from) ?? new Set<string>();
    if (wired.has(edge.outcome)) {
      issues.push({
        severity: "error",
        code: "duplicate-edge",
        nodeId: edge.from,
        message: `Node "${edge.from}" has more than one edge for outcome "${edge.outcome}"; the engine needs exactly one successor.`,
      });
    }
    wired.add(edge.outcome);
    wiredByNode.set(edge.from, wired);
  }

  const routableByNode = new Map<string, Set<string>>();
  for (const [id, node] of nodeById) {
    routableByNode.set(id, new Set(nodeOutcomes(node)));
  }

  for (const edge of workflow.edges) {
    const routable = routableByNode.get(edge.from);
    if (!routable) continue; // missing source already reported as dangling
    if (!routable.has(edge.outcome)) {
      issues.push({
        severity: "error",
        code: "unknown-outcome",
        nodeId: edge.from,
        message: `Edge "${edge.from}" --${edge.outcome}--> "${edge.to}" uses an outcome node "${edge.from}" can never produce.`,
      });
    }
  }

  for (const node of workflow.nodes) {
    const wired = wiredByNode.get(node.id);
    if (!wired || wired.size === 0) continue; // terminal sink
    for (const outcome of nodeOutcomes(node)) {
      if (outcome === WORKFLOW_FAIL_OUTCOME) continue; // implicit; warned separately
      if (!wired.has(outcome)) {
        issues.push({
          severity: "error",
          code: "unwired-outcome",
          nodeId: node.id,
          message: `Node "${node.id}" declares outcome "${outcome}" but has no edge for it.`,
        });
      }
    }
  }

  for (const node of workflow.nodes) {
    if (node.kind !== "agent") continue;
    if (!wiredByNode.get(node.id)?.has(WORKFLOW_FAIL_OUTCOME)) {
      issues.push({
        severity: "warning",
        code: "unwired-failure",
        nodeId: node.id,
        message: `Agent node "${node.id}" has no "${WORKFLOW_FAIL_OUTCOME}" edge; a failure there ends the run.`,
      });
    }
  }

  // Reachability only makes sense from a real entry; a bad entry already
  // errored above and must not cascade into one "unreachable" per node.
  if (entryExists) {
    const adjacency = new Map<string, string[]>();
    for (const edge of workflow.edges) {
      if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
      // A dead edge (unknown outcome) can never carry a run, so it must not
      // make its target look reachable.
      if (!routableByNode.get(edge.from)?.has(edge.outcome)) continue;
      const targets = adjacency.get(edge.from);
      if (targets) targets.push(edge.to);
      else adjacency.set(edge.from, [edge.to]);
    }
    const reached = new Set<string>([workflow.entryNodeId]);
    const queue = [workflow.entryNodeId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const next of adjacency.get(current) ?? []) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    for (const node of workflow.nodes) {
      if (!reached.has(node.id)) {
        issues.push({
          severity: "error",
          code: "unreachable",
          nodeId: node.id,
          message: `Node "${node.id}" is unreachable from the entry node.`,
        });
      }
    }
  }

  return issues;
}
