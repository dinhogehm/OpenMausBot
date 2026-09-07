import { describe, expect, it } from "vitest";
import {
  capabilityIssues,
  countsTowardExecutionCap,
  missingCapabilities,
  nodeOutcomes,
  parseWorkflowOutcome,
  validateWorkflow,
  WORKFLOW_CAPABILITIES,
  WORKFLOW_FAIL_OUTCOME,
  WORKFLOW_MAX_NODE_EXECUTIONS,
  workflowRoutingFingerprint,
  type BotCapabilities,
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

describe("workflowRoutingFingerprint", () => {
  const print = (overrides: Partial<Workflow> = {}) => workflowRoutingFingerprint(wf(overrides));

  it("ignores everything that cannot change where a run goes next", () => {
    const base = print();
    // Presentation and scheduling: a canvas autosaving a node drag, a
    // rename, a schedule change must all be invisible to a run in flight.
    expect(print({ layout: { code: { x: 10, y: 20 } } })).toBe(base);
    expect(print({ name: "Renamed" })).toBe(base);
    expect(print({ description: "explained" })).toBe(base);
    expect(print({ triggers: { schedule: { type: "daily", time: "09:00", weekdays: [1] } } })).toBe(base);
    expect(print({ maxNodeExecutions: 7 })).toBe(base);
    expect(print({ createdAt: 5, updatedAt: 9, id: "other" })).toBe(base);
    // Node instructions and timing knobs steer nothing either.
    expect(
      print({
        nodes: wf().nodes.map((node) =>
          node.id === "code" ? { ...node, instructions: "rewritten", timeoutMinutes: 5, retries: 0 } : node,
        ),
      }),
    ).toBe(base);
  });

  it("is stable under node, edge and outcome ORDER", () => {
    const base = print();
    expect(print({ nodes: [...wf().nodes].reverse() })).toBe(base);
    expect(print({ edges: [...wf().edges].reverse() })).toBe(base);
    expect(
      print({
        nodes: wf().nodes.map((node) =>
          node.id === "review" && node.kind === "agent" ? { ...node, outcomes: ["rejected", "approved"] } : node,
        ),
      }),
    ).toBe(base);
  });

  it("changes for anything that does steer a run", () => {
    const base = print();
    expect(print({ entryNodeId: "review" })).not.toBe(base);
    // An edge removed, retargeted, or added.
    expect(print({ edges: wf().edges.slice(1) })).not.toBe(base);
    expect(print({ edges: [{ from: "code", outcome: "done", to: "code" }, ...wf().edges.slice(1)] })).not.toBe(base);
    expect(print({ edges: [...wf().edges, { from: "code", outcome: "extra", to: "review" }] })).not.toBe(base);
    // A declared outcome deleted, renamed, or added.
    const withOutcomes = (outcomes: string[]) =>
      print({ nodes: wf().nodes.map((node) => (node.id === "review" ? { ...node, outcomes } : node)) });
    expect(withOutcomes(["approved"])).not.toBe(base);
    expect(withOutcomes(["approved", "declined"])).not.toBe(base);
    expect(withOutcomes(["approved", "rejected", "deferred"])).not.toBe(base);
    // A node removed, renamed, or turned into another kind.
    expect(print({ nodes: wf().nodes.slice(0, 1) })).not.toBe(base);
    expect(print({ nodes: [{ kind: "notify", id: "code", targetGroupId: "g", template: "t" }, wf().nodes[1]!] }))
      .not.toBe(base);
  });

  it("is a short, stable digest — it rides on every run receipt", () => {
    expect(print()).toMatch(/^[0-9a-f]{16}$/);
    expect(print()).toBe(print());
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

  it("um nó terminal (sem nenhuma aresta) não recebe o aviso de falha sem destino", () => {
    const w = wf();
    w.nodes.push({ kind: "agent", id: "fim", botId: "b3", instructions: "encerre", outcomes: ["ok"] });
    w.edges.push({ from: "review", outcome: "approved", to: "fim" });
    w.edges = w.edges.filter((e) => !(e.from === "review" && e.outcome === "approved" && e.to === "code"));
    const issues = validateWorkflow(w);
    expect(issues.some((i) => i.code === "unwired-failure" && i.nodeId === "fim")).toBe(false);
    // um nó que liga algumas saídas mas não a falha continua avisando
    expect(issues.some((i) => i.code === "unwired-failure" && i.nodeId === "code")).toBe(true);
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

  it("flags a schedule the scheduler could not arm", () => {
    const bad = (schedule: unknown) =>
      validateWorkflow(wf({ triggers: { schedule } as Workflow["triggers"] })).filter((issue) => issue.code === "bad-schedule");
    const error = expect.objectContaining({ severity: "error", code: "bad-schedule" });
    expect(bad({ type: "daily", time: "09:00", weekdays: [1, 3, 5] })).toEqual([]);
    expect(bad({ type: "daily", time: "00:00", weekdays: [0, 6] })).toEqual([]);
    expect(bad({ type: "once", at: 1_700_000_000_000 })).toEqual([]);
    expect(validateWorkflow(wf({ triggers: {} })).filter((issue) => issue.code === "bad-schedule")).toEqual([]);
    for (const time of ["9:00", "24:00", "09:60", "09:00:00", " 09:00", "", 900]) {
      expect(bad({ type: "daily", time, weekdays: [1] }), String(time)).toEqual([error]);
    }
    expect(bad({ type: "daily", time: "9:00", weekdays: [1] })[0]?.message).toMatch(/HH:MM/);
    for (const weekdays of [[], [7], [-1], [1.5], ["1"], [1, 1]]) {
      expect(bad({ type: "daily", time: "09:00", weekdays }), JSON.stringify(weekdays)).toEqual([error]);
    }
    expect(bad({ type: "daily", time: "09:00", weekdays: [] })[0]?.message).toMatch(/at least one weekday/);
    expect(bad({ type: "daily", time: "09:00", weekdays: [2, 2] })[0]?.message).toMatch(/repeat/);
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, "1700000000000"]) {
      expect(bad({ type: "once", at }), String(at)).toEqual([error]);
    }
    expect(bad({ type: "weekly", time: "09:00" })).toEqual([error]);
  });

  it("flags an interval too short to arm or an active window the scheduler could not honour", () => {
    const bad = (schedule: unknown) =>
      validateWorkflow(wf({ triggers: { schedule } as Workflow["triggers"] })).filter((issue) => issue.code === "bad-schedule");
    const error = expect.objectContaining({ severity: "error", code: "bad-schedule" });
    expect(bad({ type: "interval", minutes: 5 })).toEqual([]);
    expect(bad({ type: "interval", minutes: 60, activeHours: { start: "09:00", end: "18:00" } })).toEqual([]);
    expect(bad({ type: "interval", minutes: 60, activeHours: { start: "22:00", end: "06:00", weekdays: [1, 5] } })).toEqual([]);
    for (const minutes of [4, 0, -5, 7.5, Number.NaN, "60"]) {
      expect(bad({ type: "interval", minutes }), String(minutes)).toEqual([error]);
    }
    expect(bad({ type: "interval", minutes: 1 })[0]?.message).toMatch(/at least 5 minutes/);
    for (const activeHours of [
      null,
      "09:00-18:00",
      [],
      { start: "9:00", end: "18:00" },
      { start: "09:00" },
      { start: "09:00", end: "09:00" },
      { start: "09:00", end: "18:00", weekdays: [] },
      { start: "09:00", end: "18:00", weekdays: [7] },
      { start: "09:00", end: "18:00", weekdays: [1, 1] },
    ]) {
      expect(bad({ type: "interval", minutes: 30, activeHours }), JSON.stringify(activeHours)).toEqual([error]);
    }
    expect(bad({ type: "interval", minutes: 30, activeHours: { start: "09:00", end: "09:00" } })[0]?.message).toMatch(
      /differ/,
    );
  });
});

describe("wait nodes and the execution cap", () => {
  const paced = (minutes: unknown): Workflow =>
    wf({
      entryNodeId: "code",
      nodes: [
        ...wf().nodes,
        { kind: "wait", id: "pause", minutes } as unknown as Workflow["nodes"][number],
      ],
      edges: [
        { from: "code", outcome: "done", to: "review" },
        { from: "review", outcome: "approved", to: "pause" },
        { from: "review", outcome: "rejected", to: "code" },
        { from: "pause", outcome: "elapsed", to: "code" },
      ],
    });
  const errors = (workflow: Workflow) => validateWorkflow(workflow).filter((issue) => issue.severity === "error");

  it("a wait node routes on exactly one outcome, elapsed, and is not bot work", () => {
    expect(nodeOutcomes({ kind: "wait", id: "pause", minutes: 30 })).toEqual(["elapsed"]);
    expect(countsTowardExecutionCap("wait")).toBe(false);
    expect(countsTowardExecutionCap("notify")).toBe(false);
    expect(countsTowardExecutionCap("agent")).toBe(true);
    expect(countsTowardExecutionCap("approval")).toBe(true);
  });

  it("accepts a well-formed wait node and flags a pause outside 1..1440 whole minutes", () => {
    expect(errors(paced(30))).toEqual([]);
    expect(errors(paced(1))).toEqual([]);
    expect(errors(paced(1_440))).toEqual([]);
    for (const minutes of [0, 1_441, 2.5, -1, Number.NaN, "30", undefined]) {
      expect(errors(paced(minutes)), String(minutes)).toEqual([
        expect.objectContaining({ code: "bad-numbers", nodeId: "pause" }),
      ]);
    }
    // An edge on an outcome a wait can never produce is the usual unknown-outcome error.
    const miswired = paced(30);
    miswired.edges = miswired.edges.map((edge) => (edge.from === "pause" ? { ...edge, outcome: "done" } : edge));
    expect(errors(miswired).map((issue) => issue.code)).toEqual(["unknown-outcome", "unwired-outcome"]);
  });

  it("bounds maxNodeExecutions at 1000", () => {
    const bad = (workflow: Workflow) => validateWorkflow(workflow).filter((issue) => issue.code === "bad-numbers");
    expect(bad(wf({ maxNodeExecutions: 1_000 }))).toEqual([]);
    expect(bad(wf({ maxNodeExecutions: 1_001 }))).toEqual([expect.objectContaining({ severity: "error" })]);
    expect(bad(wf({ maxNodeExecutions: 1_001 }))[0]?.message).toMatch(/1 to 1000/);
    expect(WORKFLOW_MAX_NODE_EXECUTIONS).toBe(200);
  });

  it("warns, never errors, about a loop back to the entry with no wait node on it", () => {
    const hot = (workflow: Workflow) => validateWorkflow(workflow).filter((issue) => issue.code === "cycle-without-wait");
    // wf(): review --approved/rejected--> code (the entry), no pause anywhere.
    expect(hot(wf())).toEqual([
      expect.objectContaining({ severity: "warning", nodeId: "code", message: expect.stringMatching(/wait node/) }),
    ]);
    // paced(): the approved lap pauses, but the rejected lap still comes straight back.
    expect(hot(paced(30))).toHaveLength(1);
    // Every lap through the entry pauses: silent.
    const cool = paced(30);
    cool.edges = cool.edges.map((edge) => (edge.outcome === "rejected" ? { ...edge, to: "pause" } : edge));
    expect(hot(cool)).toEqual([]);
    // A cycle that does not pass through the entry is a review loop, not a hot loop.
    const sideLoop = wf({
      entryNodeId: "plan",
      nodes: [{ kind: "agent", id: "plan", botId: "b0", instructions: "plan", outcomes: ["done"] }, ...wf().nodes],
      edges: [
        { from: "plan", outcome: "done", to: "code" },
        { from: "code", outcome: "done", to: "review" },
        { from: "review", outcome: "approved", to: "code" },
        { from: "review", outcome: "rejected", to: "code" },
      ],
    });
    expect(hot(sideLoop)).toEqual([]);
    // The entry itself is a wait: every lap pauses, so never a hot loop.
    const pausedEntry = paced(30);
    pausedEntry.entryNodeId = "pause";
    expect(hot(pausedEntry)).toEqual([]);
    // No cycle at all: silent.
    expect(hot(wf({ edges: [{ from: "code", outcome: "done", to: "review" }] }))).toEqual([]);
    // A dead edge (unknown outcome) cannot carry a run, so it cannot make a hot loop.
    expect(hot(wf({ edges: [{ from: "code", outcome: "done", to: "review" }, { from: "review", outcome: "nope", to: "code" }] }))).toEqual([]);
  });
});

describe("capabilities", () => {
  /** wf() with `requires` set on one node (review runs on bot b2). Typed
   * loosely so the shape checks can be fed what a raw JSON body could carry. */
  const gated = (requires: unknown, nodeId = "review"): Workflow =>
    wf({
      nodes: wf().nodes.map((node) => (node.id === nodeId ? { ...node, requires } : node)) as unknown as Workflow["nodes"],
    });
  const badRequires = (workflow: Workflow) => validateWorkflow(workflow).filter((issue) => issue.code === "bad-requires");

  it("names exactly merge and deploy", () => {
    expect(WORKFLOW_CAPABILITIES).toEqual(["merge", "deploy"]);
  });

  it("validateWorkflow accepts an absent, empty, or well-formed requires list", () => {
    expect(badRequires(wf())).toEqual([]);
    expect(badRequires(gated([]))).toEqual([]);
    expect(badRequires(gated(["merge"]))).toEqual([]);
    expect(badRequires(gated(["deploy", "merge"]))).toEqual([]);
  });

  it("validateWorkflow flags an unknown capability, a duplicate, and a non-list as bad-requires", () => {
    const error = expect.objectContaining({ severity: "error", code: "bad-requires", nodeId: "review" });
    expect(badRequires(gated(["ship"]))).toEqual([error]);
    expect(badRequires(gated(["ship"]))[0]?.message).toMatch(/"ship".*merge, deploy/);
    expect(badRequires(gated(["deploy", "deploy"]))).toEqual([error]);
    expect(badRequires(gated(["deploy", "deploy"]))[0]?.message).toMatch(/more than once/);
    expect(badRequires(gated("merge"))).toEqual([error]);
    expect(badRequires(gated([3]))).toEqual([error]);
    // The shape rule is per node: a clean sibling is not blamed.
    expect(badRequires(gated(["ship"])).map((issue) => issue.nodeId)).toEqual(["review"]);
  });

  it("capabilityIssues flags a node whose bot lacks a required capability, naming node, bot and capability", () => {
    const lookup = (botId: string): BotCapabilities | null =>
      botId === "b2" ? { canMerge: false } : { canMerge: true, canDeploy: true };
    expect(capabilityIssues(gated(["merge", "deploy"]), lookup)).toEqual([
      {
        severity: "error",
        code: "missing-capability",
        nodeId: "review",
        message: 'Node "review" requires "merge" but its bot "b2" is not allowed to merge.',
      },
      {
        severity: "error",
        code: "missing-capability",
        nodeId: "review",
        message: 'Node "review" requires "deploy" but its bot "b2" is not allowed to deploy.',
      },
    ]);
  });

  it("capabilityIssues is silent for a flagged bot, a node that requires nothing, and an unknown bot", () => {
    expect(capabilityIssues(gated(["merge", "deploy"]), () => ({ canMerge: true, canDeploy: true }))).toEqual([]);
    expect(capabilityIssues(wf(), () => ({}))).toEqual([]);
    expect(capabilityIssues(gated([]), () => ({}))).toEqual([]);
    // An unknown bot is reported elsewhere (the engine's missing-bot path).
    expect(capabilityIssues(gated(["deploy"]), () => null)).toEqual([]);
  });

  it("capabilityIssues treats an absent flag as not allowed and leaves shape problems to the validator", () => {
    expect(capabilityIssues(gated(["merge"]), () => ({ canDeploy: true }))).toHaveLength(1);
    // A duplicate reports once; an unknown name is bad-requires, never missing-capability.
    expect(capabilityIssues(gated(["merge", "merge", "ship"]), () => ({}))).toHaveLength(1);
  });

  it("missingCapabilities lists what a bot lacks, in declaration order, once each", () => {
    expect(missingCapabilities(["deploy", "merge"], {})).toEqual(["deploy", "merge"]);
    expect(missingCapabilities(["deploy", "merge"], { canMerge: true })).toEqual(["deploy"]);
    expect(missingCapabilities(["deploy", "merge"], { canMerge: true, canDeploy: true })).toEqual([]);
    expect(missingCapabilities(undefined, {})).toEqual([]);
    expect(missingCapabilities(["merge", "merge"], {})).toEqual(["merge"]);
    expect(missingCapabilities(["merge"], { canMerge: false })).toEqual(["merge"]);
  });

  it("requires never changes the routing fingerprint — it gates a dispatch, it steers nothing", () => {
    expect(workflowRoutingFingerprint(gated(["merge"]))).toBe(workflowRoutingFingerprint(wf()));
  });
});
