// WorkflowStore — durable CRUD for definitions and run receipts. Every test
// runs against real files in a throwaway temp dir (no fs mocks): round-trips
// construct a NEW store over the same paths so a passing assertion proves the
// bytes on disk, not the in-memory cache.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowRun } from "../shared/workflow.ts";
import { WorkflowStore, type WorkflowInput } from "./workflow-store.ts";

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Error-free two-node loop (it still carries unwired-failure warnings, which
 * is deliberate: a valid save must tolerate warning-severity issues). */
const input = (overrides: Partial<WorkflowInput> = {}): WorkflowInput => ({
  name: "Pipeline",
  entryNodeId: "code",
  nodes: [
    { kind: "agent", id: "code", botId: "b1", instructions: "write it", outcomes: ["done"] },
    { kind: "agent", id: "review", botId: "b2", instructions: "review it", outcomes: ["approved", "rejected"] },
  ],
  edges: [
    { from: "code", outcome: "done", to: "review" },
    { from: "review", outcome: "approved", to: "code" },
    { from: "review", outcome: "rejected", to: "code" },
  ],
  layout: {},
  ...overrides,
});

const runInput = (overrides: Partial<Omit<WorkflowRun, "id">> = {}): Omit<WorkflowRun, "id"> => ({
  workflowId: "wf1",
  status: "queued",
  attempt: 0,
  input: "go",
  nodeResults: [],
  startedAt: 1_000,
  ...overrides,
});

function harness() {
  const dir = tempDir();
  const file = join(dir, "workflows.json");
  const runsFile = join(dir, "workflow-runs.json");
  let now = 1_000;
  const emitted: Array<Record<string, unknown>> = [];
  const open = () =>
    new WorkflowStore({ file, runsFile, now: () => now, emit: (payload) => emitted.push(payload) });
  return { file, runsFile, emitted, open, setNow: (value: number) => (now = value), store: open() };
}

describe("WorkflowStore definitions", () => {
  it("create generates identity, timestamps via now, and round-trips through disk", () => {
    const h = harness();
    h.setNow(1_234);
    const created = h.store.create(input());
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.createdAt).toBe(1_234);
    expect(created.updatedAt).toBe(1_234);

    const reloaded = h.open();
    expect(reloaded.get(created.id)).toEqual(created);
    expect(reloaded.list()).toEqual([created]);

    const raw = readFileSync(h.file, "utf8");
    const disk = JSON.parse(raw) as { version: number; workflows: unknown[] };
    expect(disk.version).toBe(1);
    expect(disk.workflows).toHaveLength(1);
    // Definitions are pretty-printed like routines/bots (hand-inspectable);
    // the runs file stays compact for size.
    expect(raw).toContain("\n");
    expect(statSync(h.file).mode & 0o777).toBe(0o600);
  });

  it("hands out copies, not live references", () => {
    const h = harness();
    const created = h.store.create(input());
    created.name = "mutated";
    created.nodes.pop();
    expect(h.store.get(created.id)?.name).toBe("Pipeline");
    expect(h.store.get(created.id)?.nodes).toHaveLength(2);
  });

  it("create accepts a half-drawn draft without validating", () => {
    const h = harness();
    const draft = h.store.create(input({ entryNodeId: "ghost", edges: [] }));
    expect(h.open().get(draft.id)).toEqual(draft);
  });

  it("update applies a patch, bumps updatedAt, and persists (warnings tolerated)", () => {
    const h = harness();
    h.setNow(1_000);
    const created = h.store.create(input());
    h.setNow(2_000);
    const updated = h.store.update(created.id, { name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    expect(updated.createdAt).toBe(1_000);
    expect(updated.updatedAt).toBe(2_000);
    expect(h.open().get(created.id)?.name).toBe("Renamed");
  });

  it("update throws on an unknown id", () => {
    const h = harness();
    expect(() => h.store.update("nope", { name: "x" })).toThrow(/unknown workflow/);
  });

  it("update rejects a patch with error-severity issues and keeps disk untouched", () => {
    const h = harness();
    const created = h.store.create(input());
    const emittedBefore = h.emitted.length;
    // Dropping the rejected edge leaves review's outcomes partially unwired.
    expect(() =>
      h.store.update(created.id, {
        edges: [
          { from: "code", outcome: "done", to: "review" },
          { from: "review", outcome: "approved", to: "code" },
        ],
      }),
    ).toThrow(/^invalid workflow: Node "review" declares outcome "rejected"/);
    expect(h.store.get(created.id)?.edges).toHaveLength(3);
    expect(h.open().get(created.id)?.edges).toHaveLength(3);
    expect(h.emitted).toHaveLength(emittedBefore);
  });

  it("a failed disk write leaves in-memory state untouched and emits nothing", () => {
    const h = harness();
    const created = h.store.create(input());
    const emittedBefore = h.emitted.length;
    // Turn the target path into a directory so the atomic rename must fail.
    rmSync(h.file);
    mkdirSync(h.file);
    expect(() => h.store.update(created.id, { name: "Phantom" })).toThrow();
    expect(h.store.get(created.id)?.name).toBe("Pipeline");
    expect(() => h.store.remove(created.id)).toThrow();
    expect(h.store.list()).toHaveLength(1);
    expect(() => h.store.create(input())).toThrow();
    expect(h.store.list()).toHaveLength(1);

    mkdirSync(h.runsFile);
    expect(() => h.store.createRun(runInput())).toThrow();
    expect(h.store.listRuns()).toEqual([]);
    expect(h.emitted).toHaveLength(emittedBefore);
  });

  it("remove deletes, persists, and is idempotent", () => {
    const h = harness();
    const created = h.store.create(input());
    h.store.remove(created.id);
    expect(h.store.get(created.id)).toBeNull();
    expect(h.open().list()).toEqual([]);
    expect(() => h.store.remove(created.id)).not.toThrow();
  });
});

describe("WorkflowStore runs", () => {
  it("createRun and patchRun persist and round-trip through disk", () => {
    const h = harness();
    const run = h.store.createRun(runInput({ startedAt: 5 }));
    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);

    const patched = h.store.patchRun(run.id, { status: "completed", endedAt: 9 });
    expect(patched?.status).toBe("completed");
    expect(patched?.endedAt).toBe(9);

    const reloaded = h.open();
    expect(reloaded.getRun(run.id)).toEqual(patched);
    expect(h.store.patchRun("nope", { status: "failed" })).toBeNull();
    // A patch cannot clobber the receipt's identity.
    expect(h.store.patchRun(run.id, { id: "evil" })?.id).toBe(run.id);
    expect(h.store.getRun(run.id)).not.toBeNull();
    // Runs are the high-churn file; it stays compact.
    expect(readFileSync(h.runsFile, "utf8")).not.toContain("\n");
  });

  it("listRuns orders by startedAt desc and filters by workflowId", () => {
    const h = harness();
    h.store.createRun(runInput({ workflowId: "a", startedAt: 10 }));
    h.store.createRun(runInput({ workflowId: "b", startedAt: 30 }));
    h.store.createRun(runInput({ workflowId: "a", startedAt: 20 }));
    expect(h.store.listRuns().map((run) => run.startedAt)).toEqual([30, 20, 10]);
    expect(h.store.listRuns("a").map((run) => run.startedAt)).toEqual([20, 10]);
    expect(h.store.listRuns("ghost")).toEqual([]);
  });

  it("createRun prunes the oldest terminal runs first, keeping live receipts", () => {
    const h = harness();
    // Oldest three are still queued: their receipts are the engine's
    // crash-recovery state and must survive the cap.
    const seeded = Array.from({ length: 2_000 }, (_, i) => ({
      ...runInput({ startedAt: i, status: i < 3 ? ("queued" as const) : ("completed" as const) }),
      id: `run-${i}`,
    }));
    writeFileSync(h.runsFile, JSON.stringify({ version: 1, runs: seeded }));

    const store = h.open();
    const created = store.createRun(runInput({ startedAt: 9_999 }));
    expect(store.listRuns()).toHaveLength(2_000);
    expect(store.getRun("run-0")).not.toBeNull();
    expect(store.getRun("run-1")).not.toBeNull();
    expect(store.getRun("run-2")).not.toBeNull();
    expect(store.getRun("run-3")).toBeNull(); // oldest terminal evicted
    expect(store.getRun(created.id)).not.toBeNull();
    expect(h.open().listRuns()).toHaveLength(2_000);
  });

  it("createRun falls back to evicting the oldest run when none are terminal", () => {
    const h = harness();
    const seeded = Array.from({ length: 2_000 }, (_, i) => ({ ...runInput({ startedAt: i }), id: `run-${i}` }));
    writeFileSync(h.runsFile, JSON.stringify({ version: 1, runs: seeded }));

    const store = h.open();
    const created = store.createRun(runInput({ startedAt: 9_999 }));
    expect(store.listRuns()).toHaveLength(2_000);
    expect(store.getRun("run-0")).toBeNull();
    expect(store.getRun("run-1")).not.toBeNull();
    expect(store.getRun(created.id)).not.toBeNull();
  });
});

describe("WorkflowStore corruption tolerance", () => {
  it("loads empty state from garbage bytes without throwing", () => {
    const dir = tempDir();
    const file = join(dir, "workflows.json");
    const runsFile = join(dir, "workflow-runs.json");
    writeFileSync(file, "{not json at all");
    writeFileSync(runsFile, "\x00\x01garbage");
    const store = new WorkflowStore({ file, runsFile, now: () => 1 });
    expect(store.list()).toEqual([]);
    expect(store.listRuns()).toEqual([]);
  });

  it("loads empty state from valid JSON of the wrong shape", () => {
    const dir = tempDir();
    const file = join(dir, "workflows.json");
    const runsFile = join(dir, "workflow-runs.json");
    writeFileSync(file, JSON.stringify({ version: 1, workflows: "nope" }));
    writeFileSync(runsFile, JSON.stringify([1, 2, 3]));
    const store = new WorkflowStore({ file, runsFile, now: () => 1 });
    expect(store.list()).toEqual([]);
    expect(store.listRuns()).toEqual([]);
  });

  it("drops element-level garbage on load but keeps valid entries", () => {
    const dir = tempDir();
    const file = join(dir, "workflows.json");
    const runsFile = join(dir, "workflow-runs.json");
    const good = { ...input(), id: "wf-ok", createdAt: 1, updatedAt: 1 };
    writeFileSync(file, JSON.stringify({ version: 1, workflows: [null, 42, { name: "no id" }, good] }));
    writeFileSync(runsFile, JSON.stringify({ version: 1, runs: [null, "x", { id: 123 }] }));
    const store = new WorkflowStore({ file, runsFile, now: () => 1 });
    expect(store.list().map((workflow) => workflow.id)).toEqual(["wf-ok"]);
    expect(store.listRuns()).toEqual([]);
  });
});

describe("WorkflowStore emit", () => {
  it("emits a keyed frame for every mutation", () => {
    const h = harness();
    const created = h.store.create(input());
    h.store.update(created.id, { name: "Renamed" });
    h.store.remove(created.id);
    const run = h.store.createRun(runInput());
    h.store.patchRun(run.id, { status: "running" });

    expect(h.emitted.map((payload) => payload.kind)).toEqual([
      "workflow",
      "workflow",
      "workflow.deleted",
      "workflow-run",
      "workflow-run",
    ]);
    expect(h.emitted[0]).toEqual({ kind: "workflow", workflow: created });
    expect(h.emitted[1]).toEqual({
      kind: "workflow",
      workflow: expect.objectContaining({ id: created.id, name: "Renamed" }),
    });
    expect(h.emitted[2]).toEqual({ kind: "workflow.deleted", id: created.id });
    expect(h.emitted[3]).toEqual({ kind: "workflow-run", run });
    expect(h.emitted[4]).toEqual({
      kind: "workflow-run",
      run: expect.objectContaining({ id: run.id, status: "running" }),
    });
  });
});
