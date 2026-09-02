import { describe, expect, it } from "vitest";

import type { Workflow, WorkflowRun } from "../../shared/workflow";
import {
  isMissedWorkflowRun,
  latestRunsByWorkflow,
  mergeWorkflowSnapshot,
  removeWorkflow,
  upsertWorkflow,
  upsertWorkflowRun,
  validationSummary,
  WORKFLOW_RUNS_KEPT,
  type WorkflowListItem,
} from "./workflow-state";

const draft = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: "wf-1",
  name: "Untitled workflow",
  entryNodeId: "",
  nodes: [],
  edges: [],
  layout: {},
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

/** A single agent node whose only outcome is wired nowhere: a terminal sink
 * with the implicit `failed` edge missing — valid, one warning. */
const validWithWarning = (overrides: Partial<Workflow> = {}): Workflow =>
  draft({
    id: "wf-2",
    entryNodeId: "a",
    nodes: [{ kind: "agent", id: "a", botId: "bot", instructions: "go", outcomes: ["done"] }],
    ...overrides,
  });

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "run-1",
  workflowId: "wf-1",
  status: "queued",
  attempt: 0,
  input: "",
  nodeResults: [],
  startedAt: 5_000,
  ...overrides,
});

describe("upsertWorkflow", () => {
  it("appends an unknown workflow and keeps the issues the frame carries", () => {
    const issues = [{ severity: "warning" as const, code: "unwired-failure" as const, message: "x" }];
    const next = upsertWorkflow([], { ...draft(), issues });
    expect(next).toHaveLength(1);
    expect(next[0]!.issues).toBe(issues);
  });

  it("recomputes issues client-side when the SSE frame lacks them", () => {
    const next = upsertWorkflow([], draft());
    expect(next[0]!.issues.map((issue) => issue.code)).toEqual(["bad-entry"]);
    const fixed = upsertWorkflow(next, validWithWarning({ id: "wf-1" }));
    expect(fixed).toHaveLength(1);
    expect(fixed[0]!.issues.map((issue) => `${issue.severity}:${issue.code}`)).toEqual(["warning:unwired-failure"]);
  });

  it("replaces in place, preserving list order", () => {
    const list: WorkflowListItem[] = [
      { ...draft({ id: "a" }), issues: [] },
      { ...draft({ id: "b" }), issues: [] },
      { ...draft({ id: "c" }), issues: [] },
    ];
    const next = upsertWorkflow(list, draft({ id: "b", name: "Renamed" }));
    expect(next.map((workflow) => workflow.id)).toEqual(["a", "b", "c"]);
    expect(next[1]!.name).toBe("Renamed");
    expect(next[0]).toBe(list[0]);
  });
});

describe("removeWorkflow", () => {
  it("drops the workflow and returns the same array when nothing matched", () => {
    const list: WorkflowListItem[] = [{ ...draft(), issues: [] }];
    expect(removeWorkflow(list, "wf-1")).toEqual([]);
    expect(removeWorkflow(list, "ghost")).toBe(list);
  });
});

describe("upsertWorkflowRun", () => {
  it("inserts newest-first by startedAt and replaces by id", () => {
    const older = run({ id: "r-old", startedAt: 1_000 });
    const newer = run({ id: "r-new", startedAt: 9_000 });
    const middle = run({ id: "r-mid", startedAt: 5_000 });
    let runs = upsertWorkflowRun([], older);
    runs = upsertWorkflowRun(runs, newer);
    runs = upsertWorkflowRun(runs, middle);
    expect(runs.map((item) => item.id)).toEqual(["r-new", "r-mid", "r-old"]);

    const completed = upsertWorkflowRun(runs, { ...middle, status: "completed", endedAt: 6_000 });
    expect(completed).toHaveLength(3);
    expect(completed[1]).toMatchObject({ id: "r-mid", status: "completed" });
  });

  it("caps the slice at WORKFLOW_RUNS_KEPT, dropping the oldest run", () => {
    const full = Array.from({ length: WORKFLOW_RUNS_KEPT }, (_, index) =>
      run({ id: `r-${index}`, startedAt: 1_000 + index }),
    );
    const runs = full.reduce<WorkflowRun[]>((acc, item) => upsertWorkflowRun(acc, item), []);
    expect(runs).toHaveLength(WORKFLOW_RUNS_KEPT);

    const withNewest = upsertWorkflowRun(runs, run({ id: "newest", startedAt: 99_000 }));
    expect(withNewest).toHaveLength(WORKFLOW_RUNS_KEPT);
    expect(withNewest[0]!.id).toBe("newest");
    expect(withNewest.some((item) => item.id === "r-0")).toBe(false);

    // patching an existing run must not evict anything
    const patched = upsertWorkflowRun(withNewest, { ...withNewest[1]!, status: "completed" });
    expect(patched).toHaveLength(WORKFLOW_RUNS_KEPT);
  });

  it("keeps a stable order for runs that started at the same instant", () => {
    const first = run({ id: "r-a", startedAt: 1_000 });
    const second = run({ id: "r-b", startedAt: 1_000 });
    const runs = upsertWorkflowRun(upsertWorkflowRun([], first), second);
    expect(runs.map((item) => item.id)).toEqual(["r-b", "r-a"]);
    // a patch to the older twin must not reorder the pair
    expect(upsertWorkflowRun(runs, { ...first, status: "running" }).map((item) => item.id)).toEqual(["r-b", "r-a"]);
  });
});

describe("mergeWorkflowSnapshot", () => {
  it("adopts server issues verbatim and sorts runs newest-first", () => {
    const merged = mergeWorkflowSnapshot(
      [{ ...draft(), issues: [{ severity: "error", code: "bad-entry", message: "no entry" }] }],
      [run({ id: "old", startedAt: 1 }), run({ id: "new", startedAt: 2 })],
    );
    expect(merged.workflows[0]!.issues[0]!.message).toBe("no entry");
    expect(merged.runs.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("caps the snapshot at WORKFLOW_RUNS_KEPT", () => {
    const many = Array.from({ length: WORKFLOW_RUNS_KEPT + 25 }, (_, index) =>
      run({ id: `r-${index}`, startedAt: index }),
    );
    expect(mergeWorkflowSnapshot([], many).runs).toHaveLength(WORKFLOW_RUNS_KEPT);
  });

  it("fills in issues for a snapshot row that lacks them", () => {
    const merged = mergeWorkflowSnapshot([draft()], []);
    expect(merged.workflows[0]!.issues.map((issue) => issue.code)).toEqual(["bad-entry"]);
  });
});

describe("latestRunsByWorkflow", () => {
  it("keeps the newest run per workflow and omits workflows with none", () => {
    const latest = latestRunsByWorkflow([
      run({ id: "other", workflowId: "wf-9", startedAt: 9_000 }),
      run({ id: "mine-new", startedAt: 8_000 }),
      run({ id: "mine-old", startedAt: 1_000 }),
    ]);
    expect(latest.get("wf-1")?.id).toBe("mine-new");
    expect(latest.get("wf-9")?.id).toBe("other");
    expect(latest.get("nope")).toBeUndefined();
  });
});

describe("isMissedWorkflowRun", () => {
  it("only a scheduled failure whose error starts with missed: counts", () => {
    expect(isMissedWorkflowRun(run({ status: "failed", trigger: "schedule", error: "missed: slot at 09:00" }))).toBe(true);
    expect(isMissedWorkflowRun(run({ status: "failed", trigger: "manual", error: "missed: nope" }))).toBe(false);
    expect(isMissedWorkflowRun(run({ status: "failed", trigger: "schedule", error: "node timed out" }))).toBe(false);
    expect(isMissedWorkflowRun(run({ status: "completed", trigger: "schedule" }))).toBe(false);
    expect(isMissedWorkflowRun(run({ status: "failed", trigger: "schedule" }))).toBe(false);
  });
});

describe("validationSummary", () => {
  it("counts errors and warnings separately", () => {
    expect(validationSummary([])).toEqual({ errors: 0, warnings: 0 });
    expect(
      validationSummary([
        { severity: "error", code: "bad-entry", message: "" },
        { severity: "error", code: "unreachable", message: "" },
        { severity: "warning", code: "unwired-failure", message: "" },
      ]),
    ).toEqual({ errors: 2, warnings: 1 });
  });
});
