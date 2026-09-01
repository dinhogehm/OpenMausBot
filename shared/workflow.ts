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
    | "dangling-edge"
    | "unwired-outcome"
    | "unwired-failure"
    | "unreachable"
    | "reserved-outcome";
  nodeId?: string;
  message: string;
}

/** Structural validation only — the server refuses to persist on any error,
 * the canvas shows every issue inline. A node with zero wired outcomes is a
 * deliberate terminal sink; wiring some outcomes but not all is a mistake. */
export function validateWorkflow(workflow: Workflow): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];

  const seenIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (seenIds.has(node.id)) {
      issues.push({
        severity: "error",
        code: "duplicate-node-id",
        nodeId: node.id,
        message: `Duplicate node id "${node.id}".`,
      });
    }
    seenIds.add(node.id);
  }

  for (const node of workflow.nodes) {
    if (node.kind === "agent" && node.outcomes.includes(WORKFLOW_FAIL_OUTCOME)) {
      issues.push({
        severity: "error",
        code: "reserved-outcome",
        nodeId: node.id,
        message: `Outcome "${WORKFLOW_FAIL_OUTCOME}" is reserved; every agent node already has it implicitly.`,
      });
    }
  }

  const entryExists = seenIds.has(workflow.entryNodeId);
  if (!entryExists) {
    issues.push({
      severity: "error",
      code: "bad-entry",
      message: `Entry node "${workflow.entryNodeId}" does not exist.`,
    });
  }

  for (const edge of workflow.edges) {
    if (!seenIds.has(edge.from) || !seenIds.has(edge.to)) {
      issues.push({
        severity: "error",
        code: "dangling-edge",
        nodeId: edge.from,
        message: `Edge "${edge.from}" --${edge.outcome}--> "${edge.to}" references a missing node.`,
      });
    }
  }

  const wiredByNode = new Map<string, Set<string>>();
  for (const edge of workflow.edges) {
    const wired = wiredByNode.get(edge.from) ?? new Set<string>();
    wired.add(edge.outcome);
    wiredByNode.set(edge.from, wired);
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
      if (!seenIds.has(edge.from) || !seenIds.has(edge.to)) continue;
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
