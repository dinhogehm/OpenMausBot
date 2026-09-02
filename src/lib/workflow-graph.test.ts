// The canvas is a thin renderer over these functions: every structural edit
// a drag, a connect or a panel keystroke performs is one pure call here, so
// the invariants the shared validator checks (one successor per outcome, no
// orphan layout keys, a reserved failure path nobody can rename) are pinned
// without mounting xyflow.
import { describe, expect, it } from "vitest";

import type { Workflow, WorkflowIssue } from "../../shared/workflow";
import {
  WORKFLOW_NODE_TYPE,
  WORKFLOW_TARGET_HANDLE,
  addOutcome,
  connectEdge,
  connectionToWorkflowEdge,
  createWorkflowNode,
  documentIssues,
  fallbackPosition,
  findEdgeByGraphId,
  graphEdgeId,
  insertNode,
  issuesByNode,
  moveNodes,
  nextFreePosition,
  nextNodeId,
  reconcileGraphNodes,
  outcomeHandles,
  removeEdges,
  removeNodes,
  removeOutcome,
  renameOutcome,
  setEntryNode,
  toGraphEdges,
  toGraphNodes,
  updateNode,
  workflowPatchBody,
} from "./workflow-graph";

const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: "wf-1",
  name: "Triage",
  entryNodeId: "agent-1",
  nodes: [
    { kind: "agent", id: "agent-1", botId: "bot-a", instructions: "look", outcomes: ["ok", "nope"] },
    { kind: "approval", id: "approval-1", prompt: "ship it?" },
    { kind: "notify", id: "notify-1", targetGroupId: "group-1", template: "done" },
  ],
  edges: [
    { from: "agent-1", outcome: "ok", to: "approval-1" },
    { from: "approval-1", outcome: "approved", to: "notify-1" },
  ],
  layout: { "agent-1": { x: 10, y: 20 }, "approval-1": { x: 300, y: 20 } },
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

describe("outcomeHandles", () => {
  it("gives an agent one handle per declared outcome plus the implicit failure path", () => {
    const handles = outcomeHandles(workflow().nodes[0]!);
    expect(handles).toEqual([
      { outcome: "ok", implicit: false },
      { outcome: "nope", implicit: false },
      { outcome: "failed", implicit: true },
    ]);
  });

  it("never emits two handles with the same id when a node wrongly declares the reserved outcome", () => {
    const handles = outcomeHandles({
      kind: "agent",
      id: "a",
      botId: "b",
      instructions: "",
      outcomes: ["failed"],
    });
    expect(handles).toEqual([{ outcome: "failed", implicit: false }]);
  });

  it("uses the kind's fixed outcomes for approval and notify nodes", () => {
    expect(outcomeHandles({ kind: "approval", id: "x", prompt: "" }).map((handle) => handle.outcome)).toEqual([
      "approved",
      "rejected",
    ]);
    expect(
      outcomeHandles({ kind: "notify", id: "x", targetGroupId: "g", template: "" }).map((handle) => handle.outcome),
    ).toEqual(["sent"]);
  });
});

describe("toGraphNodes", () => {
  it("maps every node with its saved position, entry flag, handles and issues", () => {
    const issues: WorkflowIssue[] = [
      { severity: "error", code: "unreachable", nodeId: "notify-1", message: "unreachable" },
      { severity: "warning", code: "unwired-failure", nodeId: "agent-1", message: "no failure edge" },
      { severity: "error", code: "bad-entry", message: "no entry" },
    ];
    const nodes = toGraphNodes(workflow(), issues, "approval-1");

    expect(nodes.map((node) => node.id)).toEqual(["agent-1", "approval-1", "notify-1"]);
    expect(nodes.every((node) => node.type === WORKFLOW_NODE_TYPE)).toBe(true);
    expect(nodes[0]!.position).toEqual({ x: 10, y: 20 });
    expect(nodes[0]!.data.entry).toBe(true);
    expect(nodes[1]!.data.entry).toBe(false);
    expect(nodes[1]!.selected).toBe(true);
    expect(nodes[0]!.selected).toBe(false);
    expect(nodes[0]!.data.issues.map((issue) => issue.code)).toEqual(["unwired-failure"]);
    expect(nodes[2]!.data.issues.map((issue) => issue.code)).toEqual(["unreachable"]);
    // the document-level issue belongs to the header, never to a card
    expect(nodes.flatMap((node) => node.data.issues).some((issue) => issue.code === "bad-entry")).toBe(false);
    expect(nodes[0]!.data.outcomes.map((handle) => handle.outcome)).toEqual(["ok", "nope", "failed"]);
  });

  it("lays a node with no saved position on a deterministic fallback grid", () => {
    const nodes = toGraphNodes(workflow(), []);
    expect(nodes[2]!.position).toEqual(toGraphNodes(workflow(), [])[2]!.position);
    expect(nodes[2]!.position.x).toBeGreaterThan(0);
    expect(nodes[2]!.position).not.toEqual(nodes[0]!.position);
  });
});

describe("reconcileGraphNodes", () => {
  const issues: WorkflowIssue[] = [
    { severity: "warning", code: "unwired-failure", nodeId: "agent-1", message: "no failure edge" },
  ];

  it("keeps the previous object for a node nothing changed about", () => {
    const graph = workflow();
    const first = toGraphNodes(graph, issues);
    // a fresh validator pass builds new issue objects — identity must not matter
    const second = reconcileGraphNodes(first, toGraphNodes(graph, structuredClone(issues)));
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("survives a server echo, which rebuilds every node and layout object", () => {
    const graph = workflow();
    const first = toGraphNodes(graph, issues);
    const echoed = reconcileGraphNodes(first, toGraphNodes(structuredClone(graph), issues));
    expect(echoed[0]).toBe(first[0]);
    expect(echoed[1]).toBe(first[1]);
    expect(echoed[2]).toBe(first[2]);
  });

  it("still notices a value change inside an otherwise identical node", () => {
    const graph = workflow();
    const first = toGraphNodes(graph, issues);
    const edited = updateNode(graph, "agent-1", (node) =>
      node.kind === "agent" ? { ...node, instructions: "look harder" } : node,
    );
    expect(reconcileGraphNodes(first, toGraphNodes(edited, issues))[0]).not.toBe(first[0]);

    // an added optional field changes the key count, not any shared value
    const withTimeout = updateNode(graph, "agent-1", (node) =>
      node.kind === "agent" ? { ...node, timeoutMinutes: 5 } : node,
    );
    expect(reconcileGraphNodes(first, toGraphNodes(withTimeout, issues))[0]).not.toBe(first[0]);
  });

  it("replaces the object when position, selection, entry, issues or the node itself change", () => {
    const graph = workflow();
    const first = toGraphNodes(graph, issues);
    const moved = reconcileGraphNodes(first, toGraphNodes(moveNodes(graph, { "agent-1": { x: 1, y: 1 } }), issues));
    expect(moved[0]).not.toBe(first[0]);
    expect(moved[1]).toBe(first[1]);

    expect(reconcileGraphNodes(first, toGraphNodes(graph, issues, "agent-1"))[0]).not.toBe(first[0]);
    expect(reconcileGraphNodes(first, toGraphNodes(setEntryNode(graph, "notify-1"), issues))[2]).not.toBe(first[2]);
    expect(
      reconcileGraphNodes(first, toGraphNodes(graph, [{ ...issues[0]!, message: "different" }]))[0],
    ).not.toBe(first[0]);
    expect(
      reconcileGraphNodes(first, toGraphNodes(addOutcome(graph, "agent-1", "later"), issues))[0],
    ).not.toBe(first[0]);
  });

  it("passes the first mapping straight through", () => {
    const next = toGraphNodes(workflow(), []);
    expect(reconcileGraphNodes([], next)).toBe(next);
  });
});

describe("toGraphEdges", () => {
  it("carries the outcome as the source handle and as a visible label", () => {
    const edges = toGraphEdges(workflow());
    expect(edges[0]).toMatchObject({
      source: "agent-1",
      target: "approval-1",
      sourceHandle: "ok",
      targetHandle: WORKFLOW_TARGET_HANDLE,
      label: "ok",
    });
    expect(edges[0]!.data).toEqual({ outcome: "ok", implicit: false });
  });

  it("marks the reserved failure path so it can be drawn apart", () => {
    const graph = workflow({ edges: [{ from: "agent-1", outcome: "failed", to: "notify-1" }] });
    expect(toGraphEdges(graph)[0]!.data.implicit).toBe(true);
  });

  it("keeps ids unique even for an illegal duplicate edge", () => {
    const duplicated = workflow({
      edges: [
        { from: "agent-1", outcome: "ok", to: "approval-1" },
        { from: "agent-1", outcome: "ok", to: "approval-1" },
      ],
    });
    const ids = toGraphEdges(duplicated).map((edge) => edge.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("round-trips a graph id back to the workflow edge it came from", () => {
    const graph = workflow();
    const id = graphEdgeId(graph.edges[1]!);
    expect(findEdgeByGraphId(graph, id)).toEqual(graph.edges[1]);
    expect(findEdgeByGraphId(graph, "nope")).toBeNull();
  });
});

describe("connectionToWorkflowEdge", () => {
  it("turns a handle-to-handle connection into a workflow edge", () => {
    expect(
      connectionToWorkflowEdge({ source: "agent-1", sourceHandle: "nope", target: "notify-1", targetHandle: "in" }),
    ).toEqual({ from: "agent-1", outcome: "nope", to: "notify-1" });
  });

  it("refuses a connection with no source handle — an edge needs an outcome to route on", () => {
    expect(connectionToWorkflowEdge({ source: "agent-1", sourceHandle: null, target: "notify-1" })).toBeNull();
    expect(connectionToWorkflowEdge({ source: "", sourceHandle: "ok", target: "notify-1" })).toBeNull();
    expect(connectionToWorkflowEdge({ source: "agent-1", sourceHandle: "ok", target: "" })).toBeNull();
  });
});

describe("connectEdge", () => {
  it("replaces the edge an outcome already had, so a node keeps exactly one successor", () => {
    const next = connectEdge(workflow(), { from: "agent-1", outcome: "ok", to: "notify-1" });
    expect(next.edges).toEqual([
      { from: "agent-1", outcome: "ok", to: "notify-1" },
      { from: "approval-1", outcome: "approved", to: "notify-1" },
    ]);
  });

  it("appends a new outcome's edge and leaves the rest alone", () => {
    const next = connectEdge(workflow(), { from: "agent-1", outcome: "nope", to: "notify-1" });
    expect(next.edges).toHaveLength(3);
    expect(next.edges[2]).toEqual({ from: "agent-1", outcome: "nope", to: "notify-1" });
  });
});

describe("moveNodes", () => {
  it("writes dragged positions into the layout without touching the others", () => {
    const graph = workflow();
    const next = moveNodes(graph, { "agent-1": { x: 99, y: -5 }, "notify-1": { x: 7, y: 7 } });
    expect(next.layout).toEqual({
      "agent-1": { x: 99, y: -5 },
      "approval-1": { x: 300, y: 20 },
      "notify-1": { x: 7, y: 7 },
    });
    // a drag is layout-only: the graph itself must come through untouched
    expect(next.nodes).toBe(graph.nodes);
    expect(next.edges).toBe(graph.edges);
  });

  it("returns the same workflow when nothing actually moved", () => {
    const graph = workflow();
    expect(moveNodes(graph, {})).toBe(graph);
    expect(moveNodes(graph, { "agent-1": { x: 10, y: 20 } })).toBe(graph);
  });
});

describe("removeNodes", () => {
  it("drops the node, every edge that touched it and its layout key", () => {
    const next = removeNodes(workflow(), ["approval-1"]);
    expect(next.nodes.map((node) => node.id)).toEqual(["agent-1", "notify-1"]);
    expect(next.edges).toEqual([]);
    expect(next.layout).toEqual({ "agent-1": { x: 10, y: 20 } });
    expect(next.entryNodeId).toBe("agent-1");
  });

  it("clears the entry when the entry node itself is deleted", () => {
    expect(removeNodes(workflow(), ["agent-1"]).entryNodeId).toBe("");
  });

  it("is a no-op for ids the graph does not have", () => {
    const graph = workflow();
    expect(removeNodes(graph, ["ghost"])).toBe(graph);
  });
});

describe("removeEdges", () => {
  it("drops exactly the edges named", () => {
    const next = removeEdges(workflow(), [{ from: "approval-1", outcome: "approved", to: "notify-1" }]);
    expect(next.edges).toEqual([{ from: "agent-1", outcome: "ok", to: "approval-1" }]);
  });
});

describe("renameOutcome", () => {
  it("rewrites the edges that routed on the old name instead of dropping them", () => {
    const next = renameOutcome(workflow(), "agent-1", "ok", "shipped");
    expect((next.nodes[0] as { outcomes: string[] }).outcomes).toEqual(["shipped", "nope"]);
    expect(next.edges).toEqual([
      { from: "agent-1", outcome: "shipped", to: "approval-1" },
      { from: "approval-1", outcome: "approved", to: "notify-1" },
    ]);
  });

  it("refuses a rename that would collide, blank out or reserve an outcome", () => {
    const graph = workflow();
    expect(renameOutcome(graph, "agent-1", "ok", "nope")).toBe(graph);
    expect(renameOutcome(graph, "agent-1", "ok", "   ")).toBe(graph);
    expect(renameOutcome(graph, "agent-1", "ok", "failed")).toBe(graph);
    expect(renameOutcome(graph, "agent-1", "missing", "x")).toBe(graph);
    expect(renameOutcome(graph, "approval-1", "approved", "yes")).toBe(graph);
  });

  it("trims the new name — the outcome parser trims before matching", () => {
    const next = renameOutcome(workflow(), "agent-1", "ok", "  shipped  ");
    expect((next.nodes[0] as { outcomes: string[] }).outcomes[0]).toBe("shipped");
    expect(next.edges[0]!.outcome).toBe("shipped");
  });
});

describe("addOutcome / removeOutcome", () => {
  it("appends a trimmed outcome and refuses duplicates and the reserved name", () => {
    const graph = workflow();
    expect((addOutcome(graph, "agent-1", " later ").nodes[0] as { outcomes: string[] }).outcomes).toEqual([
      "ok",
      "nope",
      "later",
    ]);
    expect(addOutcome(graph, "agent-1", "ok")).toBe(graph);
    expect(addOutcome(graph, "agent-1", "failed")).toBe(graph);
    expect(addOutcome(graph, "agent-1", " ")).toBe(graph);
    expect(addOutcome(graph, "approval-1", "maybe")).toBe(graph);
  });

  it("drops an outcome together with the edge that routed on it", () => {
    const next = removeOutcome(workflow(), "agent-1", "ok");
    expect((next.nodes[0] as { outcomes: string[] }).outcomes).toEqual(["nope"]);
    expect(next.edges).toEqual([{ from: "approval-1", outcome: "approved", to: "notify-1" }]);
  });
});

describe("insertNode / nextNodeId / createWorkflowNode", () => {
  it("numbers a new id past every id the graph already uses", () => {
    expect(nextNodeId(workflow(), "agent")).toBe("agent-2");
    expect(nextNodeId(workflow(), "approval")).toBe("approval-2");
    expect(nextNodeId(workflow({ nodes: [] }), "notify")).toBe("notify-1");
    const gapped = workflow({
      nodes: [
        { kind: "agent", id: "agent-1", botId: "b", instructions: "", outcomes: ["ok"] },
        { kind: "agent", id: "agent-3", botId: "b", instructions: "", outcomes: ["ok"] },
      ],
    });
    expect(nextNodeId(gapped, "agent")).toBe("agent-2");
  });

  it("needs a bot for an agent node and a room for a notify node", () => {
    expect(createWorkflowNode("agent", "agent-9", {})).toBeNull();
    expect(createWorkflowNode("notify", "notify-9", {})).toBeNull();
    expect(createWorkflowNode("approval", "approval-9", {})).toMatchObject({ kind: "approval", prompt: "" });
    expect(createWorkflowNode("agent", "agent-9", { botId: "bot-a" })).toEqual({
      kind: "agent",
      id: "agent-9",
      botId: "bot-a",
      instructions: "",
      outcomes: ["done"],
    });
  });

  it("never drops a new node on top of one that is already there", () => {
    const graph = workflow();
    // the preferred spot is free — taken verbatim
    expect(nextFreePosition(graph, { x: 900, y: 900 })).toEqual({ x: 900, y: 900 });
    // the preferred spot is agent-1's — pushed onto the next grid slot
    const nudged = nextFreePosition(graph, { x: 12, y: 22 });
    expect(nudged).not.toEqual({ x: 12, y: 22 });
    expect(Math.abs(nudged.x - 10) >= 260 || Math.abs(nudged.y - 20) >= 170).toBe(true);
    // a node with no layout entry still occupies its fallback slot
    expect(nextFreePosition(graph, fallbackPosition(2))).not.toEqual(fallbackPosition(2));
  });

  it("adds the node at the given position without stealing the entry", () => {
    const node = createWorkflowNode("approval", "approval-2", {})!;
    const next = insertNode(workflow(), node, { x: 40, y: 60 });
    expect(next.nodes).toHaveLength(4);
    expect(next.layout["approval-2"]).toEqual({ x: 40, y: 60 });
    expect(next.entryNodeId).toBe("agent-1");
  });
});

describe("updateNode / setEntryNode", () => {
  it("replaces one node in place and leaves its neighbours identical", () => {
    const graph = workflow();
    const next = updateNode(graph, "approval-1", (node) =>
      node.kind === "approval" ? { ...node, prompt: "really?" } : node,
    );
    expect(next.nodes[1]).toMatchObject({ prompt: "really?" });
    expect(next.nodes[0]).toBe(graph.nodes[0]);
    expect(updateNode(graph, "ghost", (node) => node)).toBe(graph);
  });

  it("only points the entry at a node the graph has", () => {
    const graph = workflow();
    expect(setEntryNode(graph, "notify-1").entryNodeId).toBe("notify-1");
    expect(setEntryNode(graph, "ghost")).toBe(graph);
  });
});

describe("issuesByNode / documentIssues", () => {
  it("splits node-anchored issues from the document-level ones", () => {
    const issues: WorkflowIssue[] = [
      { severity: "error", code: "bad-entry", message: "no entry" },
      { severity: "error", code: "unreachable", nodeId: "a", message: "a" },
      { severity: "warning", code: "unwired-failure", nodeId: "a", message: "b" },
      { severity: "error", code: "bad-schedule", message: "bad time" },
    ];
    expect(issuesByNode(issues).get("a")?.map((issue) => issue.message)).toEqual(["a", "b"]);
    expect(issuesByNode(issues).get("nope")).toBeUndefined();
    expect(documentIssues(issues).map((issue) => issue.code)).toEqual(["bad-entry", "bad-schedule"]);
  });
});

describe("workflowPatchBody", () => {
  it("sends the whole document and never the engine-owned fields", () => {
    const body = workflowPatchBody(
      workflow({ nextRunAt: 999, description: "d", maxNodeExecutions: 12, triggers: { schedule: { type: "once", at: 5 } } }),
    );
    expect(Object.keys(body).sort()).toEqual([
      "description",
      "edges",
      "entryNodeId",
      "layout",
      "maxNodeExecutions",
      "name",
      "nodes",
      "triggers",
    ]);
    expect(body.maxNodeExecutions).toBe(12);
    expect(body.triggers).toEqual({ schedule: { type: "once", at: 5 } });
  });

  it("nulls the clearable optionals so removing a schedule actually removes it", () => {
    const body = workflowPatchBody(workflow());
    expect(body.triggers).toBeNull();
    expect(body.description).toBeNull();
    expect(body.maxNodeExecutions).toBeNull();
  });
});
