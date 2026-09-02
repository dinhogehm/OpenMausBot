import { describe, expect, it } from "vitest";
import {
  parseWorkflowOutcome,
  validateWorkflow,
  WORKFLOW_FAIL_OUTCOME,
  type Workflow,
} from "./workflow.ts";

const wf = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: "wf1",
  name: "Pipeline",
  entryNodeId: "code",
  nodes: [
    { kind: "agent", id: "code", botId: "b1", instructions: "codifique", outcomes: ["done"] },
    { kind: "agent", id: "review", botId: "b2", instructions: "revise", outcomes: ["approved", "rejected"] },
  ],
  edges: [
    { from: "code", outcome: "done", to: "review" },
    { from: "review", outcome: "approved", to: "code" }, // cycles are allowed
    { from: "review", outcome: "rejected", to: "code" },
  ],
  layout: {},
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe("parseWorkflowOutcome", () => {
  const allowed = ["approved", "rejected"];

  it("extracts the last complete envelope after ordinary prose", () => {
    const parsed = parseWorkflowOutcome(
      'The review is done, details below.\n<openmaus-workflow>{"outcome":"approved","summary":"LGTM, 2 nits"}</openmaus-workflow>',
      allowed,
    );
    expect(parsed).toEqual({ outcome: "approved", summary: "LGTM, 2 nits" });
  });

  it("rejects an outcome outside the allowed list", () => {
    const parsed = parseWorkflowOutcome(
      '<openmaus-workflow>{"outcome":"shipped","summary":"pushed to prod"}</openmaus-workflow>',
      allowed,
    );
    expect(parsed).toBeNull();
  });

  it("lets the last complete envelope win over an earlier quoted example", () => {
    const parsed = parseWorkflowOutcome(
      'An example would be <openmaus-workflow>{"outcome":"rejected","summary":"example only"}</openmaus-workflow>'
        + ' but my actual result is\n<openmaus-workflow>{"outcome":"approved","summary":"real verdict"}</openmaus-workflow>',
      allowed,
    );
    expect(parsed).toEqual({ outcome: "approved", summary: "real verdict" });
  });

  it("fails closed on malformed JSON, a missing envelope, or an empty summary", () => {
    expect(
      parseWorkflowOutcome('<openmaus-workflow>{"outcome":"approved",</openmaus-workflow>', allowed),
    ).toBeNull();
    expect(parseWorkflowOutcome("I think it looks approved to me.", allowed)).toBeNull();
    expect(
      parseWorkflowOutcome('<openmaus-workflow>{"outcome":"approved","summary":"  "}</openmaus-workflow>', allowed),
    ).toBeNull();
  });

  it("truncates the summary at 2000 chars", () => {
    const parsed = parseWorkflowOutcome(
      `<openmaus-workflow>{"outcome":"approved","summary":"${"x".repeat(2500)}"}</openmaus-workflow>`,
      allowed,
    );
    expect(parsed?.summary).toHaveLength(2000);
  });
});

describe("validateWorkflow", () => {
  it("reports no error-severity issues for a valid graph", () => {
    const errors = validateWorkflow(wf()).filter((issue) => issue.severity === "error");
    expect(errors).toEqual([]);
  });

  it("flags a declared outcome left unwired while sibling outcomes are wired", () => {
    const issues = validateWorkflow(
      wf({
        edges: [
          { from: "code", outcome: "done", to: "review" },
          { from: "review", outcome: "approved", to: "code" },
        ],
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "unwired-outcome", nodeId: "review" }),
    );
  });

  it("treats a node with no wired outcomes as a valid terminal sink", () => {
    const errors = validateWorkflow(
      wf({ edges: [{ from: "code", outcome: "done", to: "review" }] }),
    ).filter((issue) => issue.severity === "error");
    expect(errors).toEqual([]);
  });

  it("flags nodes unreachable from the entry", () => {
    const issues = validateWorkflow(
      wf({
        nodes: [
          ...wf().nodes,
          { kind: "agent", id: "orphan", botId: "b3", instructions: "espere", outcomes: ["done"] },
        ],
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "unreachable", nodeId: "orphan" }),
    );
  });

  it("flags edges pointing at missing nodes", () => {
    const errors = validateWorkflow(
      wf({
        edges: [
          { from: "code", outcome: "done", to: "review" },
          { from: "review", outcome: "approved", to: "ghost" },
          { from: "review", outcome: "rejected", to: "code" },
        ],
      }),
    ).filter((issue) => issue.severity === "error");
    expect(errors).toEqual([expect.objectContaining({ code: "dangling-edge", nodeId: "review" })]);
  });

  it("flags a bad entry node id and skips reachability", () => {
    const issues = validateWorkflow(wf({ entryNodeId: "nope" }));
    expect(issues).toContainEqual(expect.objectContaining({ severity: "error", code: "bad-entry" }));
    expect(issues.filter((issue) => issue.code === "unreachable")).toEqual([]);
  });

  it("flags duplicate node ids", () => {
    const issues = validateWorkflow(
      wf({
        nodes: [
          ...wf().nodes,
          { kind: "agent", id: "code", botId: "b9", instructions: "de novo", outcomes: ["done"] },
        ],
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "duplicate-node-id", nodeId: "code" }),
    );
  });

  it("warns per agent node missing a failed edge, silenced once wired", () => {
    const warnings = validateWorkflow(wf()).filter((issue) => issue.code === "unwired-failure");
    expect(warnings).toEqual([
      expect.objectContaining({ severity: "warning", nodeId: "code" }),
      expect.objectContaining({ severity: "warning", nodeId: "review" }),
    ]);

    const wired = validateWorkflow(
      wf({
        edges: [...wf().edges, { from: "code", outcome: WORKFLOW_FAIL_OUTCOME, to: "review" }],
      }),
    ).filter((issue) => issue.code === "unwired-failure");
    expect(wired).toEqual([expect.objectContaining({ severity: "warning", nodeId: "review" })]);
  });

  it("rejects declaring the reserved failed outcome manually", () => {
    const issues = validateWorkflow(
      wf({
        nodes: [
          { kind: "agent", id: "code", botId: "b1", instructions: "codifique", outcomes: ["done", WORKFLOW_FAIL_OUTCOME] },
          { kind: "agent", id: "review", botId: "b2", instructions: "revise", outcomes: ["approved", "rejected"] },
        ],
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "reserved-outcome", nodeId: "code" }),
    );
  });

  it("flags two edges competing for the same outcome of one node", () => {
    const issues = validateWorkflow(
      wf({ edges: [...wf().edges, { from: "code", outcome: "done", to: "code" }] }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "duplicate-edge", nodeId: "code" }),
    );
  });

  it("flags an edge whose outcome the source node can never produce", () => {
    const issues = validateWorkflow(
      wf({ edges: [...wf().edges, { from: "code", outcome: "deployed", to: "review" }] }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "unknown-outcome", nodeId: "code" }),
    );
  });

  it("does not count a node reached only through a dead edge as reachable", () => {
    const issues = validateWorkflow(wf({ edges: [{ from: "code", outcome: "typo", to: "review" }] }));
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "unknown-outcome", nodeId: "code" }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "unreachable", nodeId: "review" }),
    );
  });

  it("rejects a failed edge on an approval node", () => {
    const issues = validateWorkflow(
      wf({
        nodes: [wf().nodes[0]!, { kind: "approval", id: "review", prompt: "ship it?" }],
        edges: [...wf().edges, { from: "review", outcome: WORKFLOW_FAIL_OUTCOME, to: "code" }],
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "unknown-outcome", nodeId: "review" }),
    );
  });

  it("flags an agent node declaring no outcomes", () => {
    const issues = validateWorkflow(
      wf({
        nodes: [
          { kind: "agent", id: "code", botId: "b1", instructions: "codifique", outcomes: [] },
          ...wf().nodes.slice(1),
        ],
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "bad-outcomes", nodeId: "code" }),
    );
  });

  it("flags an agent node declaring the same outcome twice", () => {
    const issues = validateWorkflow(
      wf({
        nodes: [
          { kind: "agent", id: "code", botId: "b1", instructions: "codifique", outcomes: ["done", "done"] },
          ...wf().nodes.slice(1),
        ],
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "bad-outcomes", nodeId: "code" }),
    );
  });

  it("flags an outcome name the parser could never emit", () => {
    const issues = validateWorkflow(
      wf({
        nodes: [
          { kind: "agent", id: "code", botId: "b1", instructions: "codifique", outcomes: ["done", "x".repeat(101)] },
          ...wf().nodes.slice(1),
        ],
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "bad-outcomes", nodeId: "code" }),
    );
  });

  it("flags a whitespace-padded outcome name the parser would trim past", () => {
    const issues = validateWorkflow(
      wf({
        nodes: [
          { kind: "agent", id: "code", botId: "b1", instructions: "codifique", outcomes: [" done "] },
          ...wf().nodes.slice(1),
        ],
        edges: [
          { from: "code", outcome: " done ", to: "review" },
          ...wf().edges.slice(1),
        ],
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "bad-outcomes", nodeId: "code" }),
    );
  });

  it("flags an approval node with only approved wired", () => {
    const issues = validateWorkflow(
      wf({
        nodes: [wf().nodes[0]!, { kind: "approval", id: "review", prompt: "ship it?" }],
        edges: [
          { from: "code", outcome: "done", to: "review" },
          { from: "review", outcome: "approved", to: "code" },
        ],
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "unwired-outcome", nodeId: "review" }),
    );
  });

  it("treats a notify node as a valid pure sink", () => {
    const errors = validateWorkflow(
      wf({
        nodes: [wf().nodes[0]!, { kind: "notify", id: "review", targetGroupId: "g1", template: "shipped" }],
        edges: [{ from: "code", outcome: "done", to: "review" }],
      }),
    ).filter((issue) => issue.severity === "error");
    expect(errors).toEqual([]);
  });

  it("anchors a dangling edge to whichever endpoint exists", () => {
    const fromMissing = validateWorkflow(
      wf({ edges: [...wf().edges, { from: "ghost", outcome: "done", to: "code" }] }),
    );
    expect(fromMissing).toContainEqual(expect.objectContaining({ code: "dangling-edge", nodeId: "code" }));

    const bothMissing = validateWorkflow(
      wf({ edges: [...wf().edges, { from: "ghost", outcome: "done", to: "phantom" }] }),
    ).find((issue) => issue.code === "dangling-edge");
    expect(bothMissing).toBeDefined();
    expect(bothMissing?.nodeId).toBeUndefined();
  });

  it("flags timing knobs that are not positive numbers and counts that are not whole numbers", () => {
    const bad = (workflow: Workflow) => validateWorkflow(workflow).filter((issue) => issue.code === "bad-numbers");
    const withCode = (extra: Record<string, unknown>): Workflow["nodes"] =>
      wf().nodes.map((node) => (node.id === "code" ? { ...node, ...extra } : node)) as unknown as Workflow["nodes"];
    for (const timeoutMinutes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "5"]) {
      expect(bad(wf({ nodes: withCode({ timeoutMinutes }) }))).toEqual([
        expect.objectContaining({ severity: "error", code: "bad-numbers", nodeId: "code" }),
      ]);
    }
    for (const retries of [-1, 1.5, Number.NaN, "2"]) {
      expect(bad(wf({ nodes: withCode({ retries }) }))).toEqual([
        expect.objectContaining({ severity: "error", code: "bad-numbers", nodeId: "code" }),
      ]);
    }
    for (const maxNodeExecutions of [0, 2.5, Number.NaN, -1]) {
      expect(bad(wf({ maxNodeExecutions }))).toEqual([expect.objectContaining({ severity: "error", code: "bad-numbers" })]);
    }
    expect(bad(wf({ nodes: withCode({ timeoutMinutes: 0.5, retries: 0 }), maxNodeExecutions: 1 }))).toEqual([]);
  });

  it("flags an approval window that is not a positive number of hours", () => {
    const gated = (expiresHours: unknown): Workflow =>
      wf({
        entryNodeId: "gate",
        nodes: [{ kind: "approval", id: "gate", prompt: "ok?", expiresHours } as unknown as Workflow["nodes"][number]],
        edges: [],
      });
    const bad = (workflow: Workflow) => validateWorkflow(workflow).filter((issue) => issue.code === "bad-numbers");
    for (const value of [0, -1, Number.NaN, "24"]) {
      expect(bad(gated(value))).toEqual([expect.objectContaining({ severity: "error", code: "bad-numbers", nodeId: "gate" })]);
    }
    expect(bad(gated(0.5))).toEqual([]);
    expect(bad(gated(undefined))).toEqual([]);
  });
});
