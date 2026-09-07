// Pure mapping between the shared `Workflow` document and the node/edge
// arrays the canvas renders, plus every structural edit the canvas performs.
// Nothing here imports xyflow: the shapes below are structurally assignable
// to its `Node`/`Edge` types, so the mapping stays unit-testable in node and
// a later observation layer can decorate the same objects without a rewrite.
//
// Two rules are enforced here rather than left to the validator, because the
// validator can only complain after the fact:
//   * connecting an outcome that already has an edge REPLACES it — the
//     engine needs exactly one successor per outcome, so a second connect is
//     a re-route, not a fork.
//   * renaming an outcome REWRITES the edges that routed on the old name
//     instead of dropping them; a rename is a spelling change, and silently
//     unwiring a branch is the one outcome nobody wants. Deleting an outcome
//     is the explicit way to drop its edge.
import {
  WORKFLOW_APPROVAL_ON_EXPIRE_DEFAULT_NEW,
  WORKFLOW_FAIL_OUTCOME,
  nodeOutcomes,
  type Workflow,
  type WorkflowEdge,
  type WorkflowIssue,
  type WorkflowNode,
  type WorkflowPreflight,
  type WorkflowTriggers,
} from "../../shared/workflow";

export type WorkflowNodeKind = WorkflowNode["kind"];

export const WORKFLOW_NODE_KINDS: readonly WorkflowNodeKind[] = ["agent", "approval", "notify", "wait"];

/** What a wait node dropped from the palette pauses for: long enough to
 * read as a real pause between laps, short enough to notice on the canvas
 * that it should be tuned. */
export const WORKFLOW_WAIT_DEFAULT_MINUTES = 30;

/** The one custom node type the canvas registers with xyflow. */
export const WORKFLOW_NODE_TYPE = "workflowNode";

/** Every node has exactly one inbound handle; edges never distinguish by it. */
export const WORKFLOW_TARGET_HANDLE = "in";

export interface XY {
  x: number;
  y: number;
}

/** One source handle. `implicit` marks the engine-owned failure path an
 * agent node always has without declaring it: drawn apart, never renamed. */
export interface WorkflowOutcomeHandle {
  outcome: string;
  implicit: boolean;
}

export interface WorkflowGraphNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  entry: boolean;
  issues: WorkflowIssue[];
  outcomes: WorkflowOutcomeHandle[];
}

export interface WorkflowGraphNode {
  id: string;
  type: typeof WORKFLOW_NODE_TYPE;
  position: XY;
  data: WorkflowGraphNodeData;
  selected: boolean;
  /** xyflow's own measurement of the rendered card. `toGraphNodes` never
   * fills it — the canvas stamps back what the library last measured, because
   * a node object that arrives without it is treated as unmeasured and
   * rendered `visibility: hidden` until the resize observer fires again. */
  measured?: { width?: number; height?: number };
}

export interface WorkflowGraphEdgeData extends Record<string, unknown> {
  outcome: string;
  implicit: boolean;
}

/** Presentation an observation layer can add per edge without the mapping
 * knowing what a run is: light a traversed edge, animate the live one. */
export interface WorkflowGraphEdgeDecoration {
  className?: string;
  style?: Record<string, string | number>;
  animated?: boolean;
  label?: string;
}

export interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  label: string;
  selected: boolean;
  data: WorkflowGraphEdgeData;
  className?: string;
  style?: Record<string, string | number>;
  animated?: boolean;
}

/** What a client may PATCH. The engine-owned fields (`id`, `createdAt`,
 * `updatedAt`, `nextRunAt`, `lastDigestAt`) are absent by construction, not
 * by filtering: the server strips them, but a canvas that sent them would
 * still be claiming to own scheduler state. */
export interface WorkflowPatchBody {
  name: string;
  description: string | null;
  entryNodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout: Record<string, XY>;
  triggers: WorkflowTriggers | null;
  maxNodeExecutions: number | null;
  stuckAfterMinutes: number | null;
  auditGroupId: string | null;
  digestAt: string | null;
  preflight: WorkflowPreflight | null;
}

/** Where a node with no saved layout entry lands. Deterministic so two
 * renders of the same document never disagree about a node's position. */
const FALLBACK_ORIGIN = { x: 60, y: 60 };
const FALLBACK_STEP = { x: 330, y: 230 };
const FALLBACK_COLUMNS = 3;

export function fallbackPosition(index: number): XY {
  return {
    x: FALLBACK_ORIGIN.x + (index % FALLBACK_COLUMNS) * FALLBACK_STEP.x,
    y: FALLBACK_ORIGIN.y + Math.floor(index / FALLBACK_COLUMNS) * FALLBACK_STEP.y,
  };
}

/** Every outcome the node can route on, deduplicated so two handles can
 * never share an id — an agent that wrongly declares the reserved name still
 * gets one handle, and the validator is the one that calls it an error. */
export function outcomeHandles(node: WorkflowNode): WorkflowOutcomeHandle[] {
  const declared = node.kind === "agent" ? new Set(node.outcomes) : null;
  const seen = new Set<string>();
  const handles: WorkflowOutcomeHandle[] = [];
  for (const outcome of nodeOutcomes(node)) {
    if (seen.has(outcome)) continue;
    seen.add(outcome);
    handles.push({ outcome, implicit: declared ? !declared.has(outcome) : false });
  }
  return handles;
}

export function issuesByNode(issues: WorkflowIssue[]): Map<string, WorkflowIssue[]> {
  const byNode = new Map<string, WorkflowIssue[]>();
  for (const issue of issues) {
    if (issue.nodeId === undefined) continue;
    const bucket = byNode.get(issue.nodeId);
    if (bucket) bucket.push(issue);
    else byNode.set(issue.nodeId, [issue]);
  }
  return byNode;
}

/** Issues that name no node — a missing entry, a schedule the scheduler
 * could not arm. They belong in the header, never on a card. */
export function documentIssues(issues: WorkflowIssue[]): WorkflowIssue[] {
  return issues.filter((issue) => issue.nodeId === undefined);
}

const NO_ISSUES: WorkflowIssue[] = [];

export function toGraphNodes(
  workflow: Workflow,
  issues: WorkflowIssue[],
  selectedNodeId?: string | null,
): WorkflowGraphNode[] {
  const byNode = issuesByNode(issues);
  return workflow.nodes.map((node, index) => ({
    id: node.id,
    type: WORKFLOW_NODE_TYPE,
    position: workflow.layout[node.id] ?? fallbackPosition(index),
    selected: node.id === selectedNodeId,
    data: {
      node,
      entry: node.id === workflow.entryNodeId,
      issues: byNode.get(node.id) ?? NO_ISSUES,
      outcomes: outcomeHandles(node),
    },
  }));
}

/** By value, not identity: a server echo rebuilds every node object even when
 * the document came back exactly as it was sent. The arrays a node carries
 * (`outcomes`, `requires`, `alwaysAllow`) hold only strings, so one
 * element-wise pass covers them. */
function sameWorkflowNode(a: WorkflowNode, b: WorkflowNode): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  return keys.every((key) => {
    const one = left[key];
    const other = right[key];
    if (Array.isArray(one) && Array.isArray(other)) {
      return one.length === other.length && one.every((item, at) => item === other[at]);
    }
    return one === other;
  });
}

function sameGraphNode(a: WorkflowGraphNode, b: WorkflowGraphNode): boolean {
  if (a.id !== b.id || a.selected !== b.selected) return false;
  if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false;
  if (a.data.entry !== b.data.entry || !sameWorkflowNode(a.data.node, b.data.node)) return false;
  if (a.data.outcomes.length !== b.data.outcomes.length) return false;
  if (a.data.outcomes.some((handle, at) => handle.outcome !== b.data.outcomes[at]!.outcome)) return false;
  if (a.data.outcomes.some((handle, at) => handle.implicit !== b.data.outcomes[at]!.implicit)) return false;
  // The validator builds fresh issue objects on every pass, so these are
  // compared by value or nothing would ever match.
  if (a.data.issues.length !== b.data.issues.length) return false;
  return a.data.issues.every((issue, at) => {
    const other = b.data.issues[at]!;
    return issue.code === other.code && issue.severity === other.severity && issue.message === other.message;
  });
}

/** Hands back the PREVIOUS object for every node that did not actually
 * change. This is not an optimisation: xyflow keys a node's measured size off
 * object identity (`adoptUserNodes` re-reads `measured` from the user node),
 * so a freshly built array on every keystroke makes each node unmeasured —
 * and an unmeasured node is rendered `visibility: hidden` until its resize
 * observer fires. Without this, the whole graph blinks on every edit and on
 * every server echo. A reused entry therefore holds the PREVIOUS (but
 * value-equal) `data.node`; read node identity from the document, never from
 * the graph. */
export function reconcileGraphNodes(
  previous: WorkflowGraphNode[],
  next: WorkflowGraphNode[],
): WorkflowGraphNode[] {
  if (previous.length === 0) return next;
  const byId = new Map(previous.map((node) => [node.id, node]));
  return next.map((node) => {
    const before = byId.get(node.id);
    return before && sameGraphNode(before, node) ? before : node;
  });
}

/** Content-addressed so selection survives a re-render, and so an id can be
 * mapped back to its edge without keeping a side table. */
export function graphEdgeId(edge: WorkflowEdge): string {
  return `${edge.from}\0${edge.outcome}\0${edge.to}`;
}

export function findEdgeByGraphId(workflow: Workflow, id: string): WorkflowEdge | null {
  return workflow.edges.find((edge) => graphEdgeId(edge) === id) ?? null;
}

export function toGraphEdges(
  workflow: Workflow,
  selectedEdgeId?: string | null,
  /** Called once per edge; whatever it returns is merged over the mapping.
   * The editor passes nothing — this exists so a run view can light edges
   * without a second mapping or a fork of this one. */
  decorate?: (edge: WorkflowEdge) => WorkflowGraphEdgeDecoration | undefined,
): WorkflowGraphEdge[] {
  const implicitByNode = new Map<string, Set<string>>();
  for (const node of workflow.nodes) {
    implicitByNode.set(
      node.id,
      new Set(outcomeHandles(node).filter((handle) => handle.implicit).map((handle) => handle.outcome)),
    );
  }
  // A duplicate edge is an error the validator reports, but React still
  // needs unique keys until the author fixes it.
  const used = new Set<string>();
  return workflow.edges.map((edge) => {
    const base = graphEdgeId(edge);
    let id = base;
    for (let copy = 2; used.has(id); copy += 1) id = `${base}#${copy}`;
    used.add(id);
    return {
      id,
      source: edge.from,
      target: edge.to,
      sourceHandle: edge.outcome,
      targetHandle: WORKFLOW_TARGET_HANDLE,
      label: edge.outcome,
      selected: id === selectedEdgeId,
      data: { outcome: edge.outcome, implicit: implicitByNode.get(edge.from)?.has(edge.outcome) ?? false },
      ...decorate?.(edge),
    };
  });
}

/** xyflow hands a connection with nullable endpoints; an edge with no
 * outcome is not routable, so it is refused rather than half-built. */
export function connectionToWorkflowEdge(connection: {
  source?: string | null;
  sourceHandle?: string | null;
  target?: string | null;
  targetHandle?: string | null;
}): WorkflowEdge | null {
  const from = connection.source ?? "";
  const outcome = connection.sourceHandle ?? "";
  const to = connection.target ?? "";
  if (!from || !outcome || !to) return null;
  return { from, outcome, to };
}

export function connectEdge(workflow: Workflow, edge: WorkflowEdge): Workflow {
  const at = workflow.edges.findIndex((candidate) => candidate.from === edge.from && candidate.outcome === edge.outcome);
  if (at === -1) return { ...workflow, edges: [...workflow.edges, edge] };
  if (workflow.edges[at]!.to === edge.to) return workflow;
  const edges = workflow.edges.slice();
  edges[at] = edge;
  return { ...workflow, edges };
}

const sameEdge = (a: WorkflowEdge, b: WorkflowEdge) => a.from === b.from && a.outcome === b.outcome && a.to === b.to;

export function removeEdges(workflow: Workflow, edges: WorkflowEdge[]): Workflow {
  if (edges.length === 0) return workflow;
  const next = workflow.edges.filter((edge) => !edges.some((doomed) => sameEdge(edge, doomed)));
  if (next.length === workflow.edges.length) return workflow;
  return { ...workflow, edges: next };
}

/** Layout-only: the same object comes back when nothing actually moved, so a
 * drag that ends where it started never schedules a save. */
export function moveNodes(workflow: Workflow, positions: Record<string, XY>): Workflow {
  const entries = Object.entries(positions);
  if (entries.length === 0) return workflow;
  const moved = entries.filter(([id, position]) => {
    const current = workflow.layout[id];
    return current === undefined || current.x !== position.x || current.y !== position.y;
  });
  if (moved.length === 0) return workflow;
  return { ...workflow, layout: { ...workflow.layout, ...Object.fromEntries(moved) } };
}

export function removeNodes(workflow: Workflow, ids: string[]): Workflow {
  const doomed = new Set(ids.filter((id) => workflow.nodes.some((node) => node.id === id)));
  if (doomed.size === 0) return workflow;
  const layout: Record<string, XY> = {};
  for (const [id, position] of Object.entries(workflow.layout)) {
    if (!doomed.has(id)) layout[id] = position;
  }
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => !doomed.has(node.id)),
    edges: workflow.edges.filter((edge) => !doomed.has(edge.from) && !doomed.has(edge.to)),
    layout,
    entryNodeId: doomed.has(workflow.entryNodeId) ? "" : workflow.entryNodeId,
  };
}

/** Roughly a card's footprint. Two nodes closer than this overlap enough to
 * hide one another, which is the only thing `nextFreePosition` has to avoid. */
const NODE_FOOTPRINT = { x: 260, y: 170 };

/** Where a node added from the palette actually lands: the caller's preferred
 * spot (the middle of the viewport) unless something is already there, in
 * which case it walks the same grid the fallback layout uses. Adding three
 * nodes in a row must never bury them in one stack. */
export function nextFreePosition(workflow: Workflow, preferred: XY): XY {
  const taken = workflow.nodes.map((node, index) => workflow.layout[node.id] ?? fallbackPosition(index));
  const collides = (candidate: XY) =>
    taken.some(
      (spot) =>
        Math.abs(spot.x - candidate.x) < NODE_FOOTPRINT.x && Math.abs(spot.y - candidate.y) < NODE_FOOTPRINT.y,
    );
  let candidate = preferred;
  for (let step = 1; step <= taken.length && collides(candidate); step += 1) {
    candidate = {
      x: preferred.x + (step % FALLBACK_COLUMNS) * FALLBACK_STEP.x,
      y: preferred.y + Math.floor(step / FALLBACK_COLUMNS) * FALLBACK_STEP.y,
    };
  }
  return candidate;
}

export function insertNode(workflow: Workflow, node: WorkflowNode, position: XY): Workflow {
  return {
    ...workflow,
    nodes: [...workflow.nodes, node],
    layout: { ...workflow.layout, [node.id]: position },
  };
}

export function updateNode(
  workflow: Workflow,
  nodeId: string,
  patch: (node: WorkflowNode) => WorkflowNode,
): Workflow {
  const at = workflow.nodes.findIndex((node) => node.id === nodeId);
  if (at === -1) return workflow;
  const next = patch(workflow.nodes[at]!);
  if (next === workflow.nodes[at]) return workflow;
  const nodes = workflow.nodes.slice();
  nodes[at] = next;
  return { ...workflow, nodes };
}

export function setEntryNode(workflow: Workflow, nodeId: string): Workflow {
  if (!workflow.nodes.some((node) => node.id === nodeId)) return workflow;
  if (workflow.entryNodeId === nodeId) return workflow;
  return { ...workflow, entryNodeId: nodeId };
}

const agentOutcomes = (workflow: Workflow, nodeId: string): string[] | null => {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  return node?.kind === "agent" ? node.outcomes : null;
};

/** Names are trimmed here for the same reason the validator rejects padding:
 * the outcome parser trims before matching, so " ok " is a route no model
 * could ever take. */
export function addOutcome(workflow: Workflow, nodeId: string, outcome: string): Workflow {
  const outcomes = agentOutcomes(workflow, nodeId);
  const name = outcome.trim();
  if (!outcomes || !name || name === WORKFLOW_FAIL_OUTCOME || outcomes.includes(name)) return workflow;
  return updateNode(workflow, nodeId, (node) =>
    node.kind === "agent" ? { ...node, outcomes: [...node.outcomes, name] } : node,
  );
}

export function removeOutcome(workflow: Workflow, nodeId: string, outcome: string): Workflow {
  const outcomes = agentOutcomes(workflow, nodeId);
  if (!outcomes || !outcomes.includes(outcome)) return workflow;
  const withoutOutcome = updateNode(workflow, nodeId, (node) =>
    node.kind === "agent" ? { ...node, outcomes: node.outcomes.filter((name) => name !== outcome) } : node,
  );
  return {
    ...withoutOutcome,
    edges: withoutOutcome.edges.filter((edge) => !(edge.from === nodeId && edge.outcome === outcome)),
  };
}

/** Rewrites the branch rather than unwiring it. Refused — the document comes
 * back untouched — when the new name is blank, reserved, or already declared
 * on the same node, since each of those turns one working branch into a
 * validator error the author did not ask for. */
export function renameOutcome(workflow: Workflow, nodeId: string, from: string, to: string): Workflow {
  const outcomes = agentOutcomes(workflow, nodeId);
  const name = to.trim();
  if (!outcomes || !outcomes.includes(from)) return workflow;
  if (!name || name === WORKFLOW_FAIL_OUTCOME || (name !== from && outcomes.includes(name))) return workflow;
  if (name === from) return workflow;
  const renamed = updateNode(workflow, nodeId, (node) =>
    node.kind === "agent"
      ? { ...node, outcomes: node.outcomes.map((outcome) => (outcome === from ? name : outcome)) }
      : node,
  );
  return {
    ...renamed,
    edges: renamed.edges.map((edge) =>
      edge.from === nodeId && edge.outcome === from ? { ...edge, outcome: name } : edge,
    ),
  };
}

/** `${kind}-${n}` with the smallest free n, so deleting and re-adding a node
 * reuses the gap instead of counting forever. */
export function nextNodeId(workflow: Workflow, kind: WorkflowNodeKind): string {
  const taken = new Set(workflow.nodes.map((node) => node.id));
  for (let n = 1; ; n += 1) {
    const id = `${kind}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** An agent node without a bot and a notify node without a room are foreign
 * keys the API refuses outright, so the palette has to seed them; `null`
 * means "no roster to pick from", which the caller turns into a reason. */
export function createWorkflowNode(
  kind: WorkflowNodeKind,
  id: string,
  seed: { botId?: string; targetGroupId?: string },
): WorkflowNode | null {
  switch (kind) {
    case "agent":
      return seed.botId ? { kind, id, botId: seed.botId, instructions: "", outcomes: ["done"] } : null;
    case "approval":
      // A NEW gate asks again on expiry instead of discarding the work;
      // the engine's fallback for an absent policy stays `rejected`, so
      // gates saved before the choice existed are unchanged.
      return { kind, id, prompt: "", onExpire: WORKFLOW_APPROVAL_ON_EXPIRE_DEFAULT_NEW };
    case "notify":
      return seed.targetGroupId ? { kind, id, targetGroupId: seed.targetGroupId, template: "" } : null;
    case "wait":
      return { kind, id, minutes: WORKFLOW_WAIT_DEFAULT_MINUTES };
  }
}

/** `null` on the clearable fields is how the API is told to drop them;
 * omitting a key means "leave alone", which would make removing a schedule
 * — or turning the audit room off — impossible. */
export function workflowPatchBody(workflow: Workflow): WorkflowPatchBody {
  return {
    name: workflow.name,
    description: workflow.description ?? null,
    entryNodeId: workflow.entryNodeId,
    nodes: workflow.nodes,
    edges: workflow.edges,
    layout: workflow.layout,
    triggers: workflow.triggers ?? null,
    maxNodeExecutions: workflow.maxNodeExecutions ?? null,
    stuckAfterMinutes: workflow.stuckAfterMinutes ?? null,
    auditGroupId: workflow.auditGroupId ?? null,
    digestAt: workflow.digestAt ?? null,
    preflight: workflow.preflight ?? null,
  };
}
