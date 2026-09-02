// Workflow HTTP handlers, exercised as the pure functions index.ts wraps:
// a real WorkflowStore over a temp dir and a real WorkflowEngine with
// capture stubs, no socket. What is under test is the status/body contract
// the React state (Task 8) and the trigger layer (Task 7) build on.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotCapabilities, Workflow, WorkflowIssue, WorkflowRun } from "../shared/workflow.ts";
import {
  handleWorkflowRequest,
  workflowNotificationBotId,
  type NotificationBotLookup,
  type WorkflowApiDeps,
} from "./workflow-api.ts";
import { WorkflowEngine } from "./workflow-run.ts";
import { WorkflowStore, type WorkflowInput } from "./workflow-store.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness({ onWorkflowDeleted }: { onWorkflowDeleted?: (workflowId: string) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-api-"));
  dirs.push(dir);
  let clock = 1_000;
  const now = () => ++clock;
  const store = new WorkflowStore({ file: join(dir, "workflows.json"), runsFile: join(dir, "workflow-runs.json"), now });
  const dispatches: Array<{ botId: string; threadId: string; prompt: string }> = [];
  const interrupts: string[] = [];
  let taskSeq = 0;
  /** Test-settable seam: onInterrupt runs inside the engine's await of
   * interruptTurn — the window in which a trigger could start a fresh run. */
  const hooks: { onInterrupt: (() => void) | null } = { onInterrupt: null };
  /** Per-bot flags a test sets; a bot not listed carries none. */
  const capabilities = new Map<string, BotCapabilities>();
  const botCapabilities = (botId: string): BotCapabilities | null => capabilities.get(botId) ?? {};
  const engine = new WorkflowEngine({
    store,
    now,
    botState: () => "ready",
    botCapabilities,
    createTask: () => ({ threadId: `thread-${++taskSeq}` }),
    startTurn: (botId, threadId, prompt) => {
      dispatches.push({ botId, threadId, prompt });
      return Promise.resolve();
    },
    interruptTurn: async (_botId, threadId) => {
      interrupts.push(threadId);
      hooks.onInterrupt?.();
    },
  });
  const deps: WorkflowApiDeps = { store, engine, botCapabilities, ...(onWorkflowDeleted ? { onWorkflowDeleted } : {}) };
  const call = (method: string, target: string, body?: unknown) => {
    const url = new URL(target, "http://omb.test");
    return handleWorkflowRequest(deps, {
      method,
      path: url.pathname,
      searchParams: url.searchParams,
      readBody: async () => body ?? {},
    });
  };
  return { store, engine, deps, call, dispatches, interrupts, hooks, capabilities };
}

const agentGraph = (): WorkflowInput => ({
  name: "Triage",
  entryNodeId: "triage",
  nodes: [{ kind: "agent", id: "triage", botId: "bot-a", instructions: "Look at the inbox.", outcomes: ["done"] }],
  edges: [],
  layout: { triage: { x: 10, y: 20 } },
});

const gateGraph = (): WorkflowInput => ({
  name: "Gate",
  entryNodeId: "gate",
  nodes: [{ kind: "approval", id: "gate", prompt: "Ship it?" }],
  edges: [],
  layout: {},
});

const draftGraph = (): WorkflowInput => ({ name: "Draft", entryNodeId: "", nodes: [], edges: [], layout: {} });

type Body = Record<string, any>;
const bodyOf = (response: Awaited<ReturnType<ReturnType<typeof harness>["call"]>>): Body => response!.body as Body;
const errors = (issues: WorkflowIssue[]) => issues.filter((issue) => issue.severity === "error");

describe("workflow definitions", () => {
  it("creates a draft and lists it with its issues", async () => {
    const { call } = harness();
    const created = await call("POST", "/api/workflows", draftGraph());
    expect(created?.status).toBe(201);
    const workflow = bodyOf(created).workflow as Workflow & { issues: WorkflowIssue[] };
    expect(workflow.id).toBeTruthy();
    expect(workflow.issues.map((issue) => issue.code)).toContain("bad-entry");

    const listed = await call("GET", "/api/workflows");
    expect(listed?.status).toBe(200);
    const workflows = bodyOf(listed).workflows as Array<Workflow & { issues: WorkflowIssue[] }>;
    expect(workflows).toHaveLength(1);
    expect(workflows[0].id).toBe(workflow.id);
    expect(workflows[0].issues.map((issue) => issue.code)).toContain("bad-entry");
  });

  it("rejects a malformed body with the house first-issue line plus every detail", async () => {
    const { call } = harness();
    const blankName = await call("POST", "/api/workflows", { ...draftGraph(), name: "   " });
    expect(blankName?.status).toBe(400);
    expect(bodyOf(blankName).error).toMatch(/^name /);
    expect(bodyOf(blankName).details.join("\n")).toMatch(/^name:/m);

    const unknownKind = await call("POST", "/api/workflows", {
      ...draftGraph(),
      nodes: [{ kind: "robot", id: "r" }],
    });
    expect(unknownKind?.status).toBe(400);
    expect(bodyOf(unknownKind).error).toMatch(/^nodes\.0/);

    const stringNumber = await call("POST", "/api/workflows", {
      ...agentGraph(),
      nodes: [{ ...agentGraph().nodes[0], retries: "2" }],
    });
    expect(stringNumber?.status).toBe(400);
    expect(bodyOf(stringNumber).error).toMatch(/^nodes\.0\.retries /);
    expect(bodyOf(stringNumber).details.join("\n")).toMatch(/retries/);

    const missing = await call("POST", "/api/workflows", { name: "No graph" });
    expect(missing?.status).toBe(400);
    expect(bodyOf(missing).details.length).toBeGreaterThan(1);
  });

  it("never rewrites identifiers: surrounding whitespace on an id is a 400, not a trim", async () => {
    const { call } = harness();
    const node = agentGraph().nodes[0];
    const cases: Array<[string, WorkflowInput | Record<string, unknown>]> = [
      ["node id", { ...agentGraph(), nodes: [{ ...node, id: " triage " }] }],
      ["botId", { ...agentGraph(), nodes: [{ ...node, botId: " bot-a" }] }],
      ["entryNodeId", { ...agentGraph(), entryNodeId: "triage " }],
      ["layout key", { ...agentGraph(), layout: { " triage": { x: 0, y: 0 } } }],
      ["edge endpoint", { ...agentGraph(), edges: [{ from: "triage", outcome: "done", to: " triage" }] }],
      ["targetGroupId", { ...draftGraph(), nodes: [{ kind: "notify", id: "n", targetGroupId: " g ", template: "x" }] }],
    ];
    for (const [label, body] of cases) {
      const response = await call("POST", "/api/workflows", body);
      expect(response?.status, label).toBe(400);
      // zod words a refused record key as "Invalid key in record"; the point
      // is that the id is refused, never trimmed.
      expect(bodyOf(response).error, label).toMatch(/must not have surrounding whitespace|Invalid key in record/);
    }
    expect(bodyOf(await call("GET", "/api/workflows")).workflows).toEqual([]);
    // Display text is still tidied.
    const created = await call("POST", "/api/workflows", { ...agentGraph(), name: "  Triage  " });
    expect(created?.status).toBe(201);
    expect(bodyOf(created).workflow.name).toBe("Triage");
  });

  it("caps description like the other prose fields", async () => {
    const { call } = harness();
    const long = "d".repeat(20_000);
    expect((await call("POST", "/api/workflows", { ...draftGraph(), description: long }))?.status).toBe(201);
    const over = await call("POST", "/api/workflows", { ...draftGraph(), description: `${long}!` });
    expect(over?.status).toBe(400);
    expect(bodyOf(over).error).toMatch(/^description /);
  });

  it("drops nulls on optional fields instead of handing them to the validator", async () => {
    const { call, store } = harness();
    const created = await call("POST", "/api/workflows", {
      ...agentGraph(),
      description: null,
      maxNodeExecutions: null,
      nodes: [{ ...agentGraph().nodes[0], timeoutMinutes: null, retries: null }],
    });
    expect(created?.status).toBe(201);
    const workflow = bodyOf(created).workflow as Workflow & { issues: WorkflowIssue[] };
    expect(errors(workflow.issues)).toEqual([]);
    const node = workflow.nodes[0] as Record<string, unknown>;
    expect("timeoutMinutes" in node).toBe(false);
    expect("retries" in node).toBe(false);
    expect("description" in workflow).toBe(false);
    expect("maxNodeExecutions" in workflow).toBe(false);

    // The store gate sees no null either: a PATCH round-trip of the same
    // shape persists.
    const patched = await call("PATCH", `/api/workflows/${workflow.id}`, {
      nodes: [{ ...agentGraph().nodes[0], timeoutMinutes: null, retries: 1 }],
    });
    expect(patched?.status).toBe(200);
    expect(store.get(workflow.id)?.nodes[0]).toEqual({ ...agentGraph().nodes[0], retries: 1 });
  });

  it("lets a PATCH clear a top-level optional field with null", async () => {
    const { call, store } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", { ...agentGraph(), maxNodeExecutions: 5, description: "x" })).workflow.id;
    expect(store.get(id)?.maxNodeExecutions).toBe(5);
    const cleared = await call("PATCH", `/api/workflows/${id}`, { maxNodeExecutions: null, description: null, triggers: null });
    expect(cleared?.status).toBe(200);
    expect(store.get(id)?.maxNodeExecutions).toBeUndefined();
    expect(store.get(id)?.description).toBeUndefined();
    expect(store.get(id)?.triggers).toBeUndefined();
    // Absent keys leave fields alone.
    const untouched = await call("PATCH", `/api/workflows/${id}`, { name: "Renamed" });
    expect(untouched?.status).toBe(200);
    expect(store.get(id)?.name).toBe("Renamed");
    expect(store.get(id)?.nodes).toHaveLength(1);
  });

  it("refuses null on a required field instead of turning it into a no-op", async () => {
    const { call, store } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    for (const field of ["name", "nodes", "edges", "entryNodeId", "layout"]) {
      const response = await call("PATCH", `/api/workflows/${id}`, { [field]: null });
      expect(response?.status, field).toBe(400);
      expect(bodyOf(response).error, field).toBe(`${field}: cannot be null`);
      expect(bodyOf(response).details, field).toEqual([`${field}: cannot be null`]);
    }
    expect(store.get(id)).toMatchObject({ ...agentGraph(), id });
    // Unknown keys are zod-stripped; a null in one is not an error either.
    const bogus = await call("PATCH", `/api/workflows/${id}`, { bogus: null, name: "Kept" });
    expect(bogus?.status).toBe(200);
    expect(store.get(id)?.name).toBe("Kept");
    expect("bogus" in (store.get(id) as object)).toBe(false);
    // Same rule on create — a null required field is not "omitted".
    const created = await call("POST", "/api/workflows", { ...agentGraph(), edges: null });
    expect(created?.status).toBe(400);
    expect(bodyOf(created).error).toBe("edges: cannot be null");
    expect(bodyOf(await call("GET", "/api/workflows")).workflows).toHaveLength(1);
  });

  it("refuses a schedule the scheduler could not arm at the door, and strips nextRunAt from clients", async () => {
    const { call, store } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    const schedule = (patch: Record<string, unknown>) =>
      call("PATCH", `/api/workflows/${id}`, { triggers: { schedule: { type: "daily", time: "09:00", weekdays: [1], ...patch } } });
    const badTime = await schedule({ time: "9:00" });
    expect(badTime?.status).toBe(400);
    expect(bodyOf(badTime).error).toBe("triggers.schedule.time must be HH:MM (24-hour)");
    const noDays = await schedule({ weekdays: [] });
    expect(noDays?.status).toBe(400);
    expect(bodyOf(noDays).error).toMatch(/^triggers\.schedule\.weekdays /);
    expect((await schedule({ weekdays: [7] }))?.status).toBe(400);
    expect((await schedule({ weekdays: [1.5] }))?.status).toBe(400);
    expect(store.get(id)?.triggers).toBeUndefined();
    // A valid schedule lands, reset to "not armed yet"; the client's own
    // nextRunAt is engine state and is dropped, not applied.
    const armed = await call("PATCH", `/api/workflows/${id}`, {
      triggers: { schedule: { type: "daily", time: "09:00", weekdays: [1, 5] } },
      nextRunAt: 123,
    });
    expect(armed?.status).toBe(200);
    // Back to "not armed yet": the engine computes the first slot on its
    // next tick, and the client's own value never lands.
    expect(bodyOf(armed).workflow.nextRunAt).toBeUndefined();
    expect(store.get(id)?.nextRunAt).toBeUndefined();
  });

  it("shows the engine's nextRunAt on the workflow as a read-only field", async () => {
    const { call, store } = harness();
    const id = bodyOf(
      await call("POST", "/api/workflows", { ...agentGraph(), triggers: { schedule: { type: "once", at: 5_000 } } }),
    ).workflow.id;
    store.setNextRunAt(id, 5_000);
    const listed = bodyOf(await call("GET", "/api/workflows")).workflows as Workflow[];
    expect(listed.find((workflow) => workflow.id === id)?.nextRunAt).toBe(5_000);
    // Not settable on create either.
    const created = bodyOf(await call("POST", "/api/workflows", { ...agentGraph(), nextRunAt: 1 })).workflow as Workflow;
    expect("nextRunAt" in created).toBe(false);
  });

  it("saves a PATCH that breaks the graph, reporting its issues — running it is what is refused", async () => {
    const { call, store, dispatches } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    const response = await call("PATCH", `/api/workflows/${id}`, { entryNodeId: "ghost" });
    expect(response?.status).toBe(200);
    const workflow = bodyOf(response).workflow as Workflow & { issues: WorkflowIssue[] };
    expect(workflow.entryNodeId).toBe("ghost");
    expect(workflow.issues.map((issue) => issue.code)).toContain("bad-entry");
    expect(store.get(id)?.entryNodeId).toBe("ghost");

    // The gate is execution, not persistence.
    const run = await call("POST", `/api/workflows/${id}/runs`, {});
    expect(run?.status).toBe(400);
    expect(bodyOf(run).error).toMatch(/^invalid workflow:/);
    expect(bodyOf(run).issues.map((issue: WorkflowIssue) => issue.code)).toContain("bad-entry");
    expect(store.listRuns(id)).toEqual([]);
    expect(dispatches).toHaveLength(0);
  });

  it("keeps a work-in-progress draft editable at every stage", async () => {
    const { call, store } = harness();
    // A fresh canvas: no entry, no nodes — exactly what the designer saves
    // seconds after opening it.
    const id = bodyOf(await call("POST", "/api/workflows", draftGraph())).workflow.id;
    const renamed = await call("PATCH", `/api/workflows/${id}`, { name: "Half drawn" });
    expect(renamed?.status).toBe(200);
    expect(bodyOf(renamed).workflow.name).toBe("Half drawn");
    expect(bodyOf(renamed).workflow.issues.map((issue: WorkflowIssue) => issue.code)).toContain("bad-entry");

    // A node dropped on the canvas before any edge is wired: an unreachable
    // node and a dangling edge are still saved, still reported.
    const halfWired = await call("PATCH", `/api/workflows/${id}`, {
      nodes: agentGraph().nodes,
      entryNodeId: "triage",
      edges: [{ from: "triage", outcome: "done", to: "not-drawn-yet" }],
    });
    expect(halfWired?.status).toBe(200);
    expect(bodyOf(halfWired).workflow.issues.map((issue: WorkflowIssue) => issue.code)).toContain("dangling-edge");
    expect(store.get(id)?.edges).toHaveLength(1);
  });

  it("applies a valid PATCH and reports the warnings that remain", async () => {
    const { call } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", draftGraph())).workflow.id;
    const response = await call("PATCH", `/api/workflows/${id}`, agentGraph());
    expect(response?.status).toBe(200);
    const workflow = bodyOf(response).workflow as Workflow & { issues: WorkflowIssue[] };
    expect(workflow.name).toBe("Triage");
    expect(errors(workflow.issues)).toEqual([]);
    expect(workflow.issues.map((issue) => issue.code)).toEqual(["unwired-failure"]);
  });

  it("404s a PATCH on an unknown workflow and 400s a malformed one before touching the store", async () => {
    const { call } = harness();
    expect((await call("PATCH", "/api/workflows/nope", { name: "x" }))?.status).toBe(404);
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    expect((await call("PATCH", `/api/workflows/${id}`, { name: 42 }))?.status).toBe(400);
  });

  it("deletes idempotently with an empty 204", async () => {
    const { call } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", draftGraph())).workflow.id;
    const first = await call("DELETE", `/api/workflows/${id}`);
    expect(first).toEqual({ status: 204 });
    expect(await call("DELETE", `/api/workflows/${id}`)).toEqual({ status: 204 });
    expect(bodyOf(await call("GET", "/api/workflows")).workflows).toEqual([]);
  });

  it("cancels every live run before the definition goes, without dispatching the queue", async () => {
    const { call, store, dispatches, interrupts } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    const running = bodyOf(await call("POST", `/api/workflows/${id}/runs`, { input: "1" })).run as WorkflowRun;
    await call("POST", `/api/workflows/${id}/runs`, { input: "2" });
    await call("POST", `/api/workflows/${id}/runs`, { input: "3" });
    expect(store.listRuns(id).map((run) => run.status).sort()).toEqual(["queued", "queued", "running"]);
    expect(dispatches).toHaveLength(1);

    expect(await call("DELETE", `/api/workflows/${id}`)).toEqual({ status: 204 });
    expect(store.get(id)).toBeNull();
    expect(store.listRuns(id).map((run) => run.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    // The active run was interrupted once; no queued run was ever promoted
    // into a task and a turn just to be cancelled.
    expect(interrupts).toEqual([running.currentThreadId]);
    expect(dispatches).toHaveLength(1);

    // A run parked on an approval gate is live too.
    const gateId = bodyOf(await call("POST", "/api/workflows", gateGraph())).workflow.id;
    const waiting = bodyOf(await call("POST", `/api/workflows/${gateId}/runs`, {})).run as WorkflowRun;
    expect(waiting.status).toBe("waiting-approval");
    expect(await call("DELETE", `/api/workflows/${gateId}`)).toEqual({ status: 204 });
    expect(store.getRun(waiting.id)?.status).toBe("cancelled");
    // Terminal receipts are left as history.
    expect(store.listRuns()).toHaveLength(4);
  });

  it("refuses to remove a definition while runs keep appearing under the cancel sweep", async () => {
    const { call, store, engine, hooks } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    await call("POST", `/api/workflows/${id}/runs`, { input: "first" });
    // A trigger fires inside every interrupt await: each cancelled run is
    // replaced by a fresh one before the sweep can look again.
    let started = 0;
    hooks.onInterrupt = () => {
      engine.startRun(id, `again ${++started}`, "webhook");
    };
    const refused = await call("DELETE", `/api/workflows/${id}`);
    expect(refused?.status).toBe(409);
    expect(bodyOf(refused).error).toBe("workflow still has 1 live run — retry");
    expect(store.get(id)).not.toBeNull();
    expect(started).toBeGreaterThan(0);
    expect(store.listRuns(id).filter((run) => run.status === "running")).toHaveLength(1);
    // Once the triggers stop, the retry the 409 asked for succeeds.
    hooks.onInterrupt = null;
    expect(await call("DELETE", `/api/workflows/${id}`)).toEqual({ status: 204 });
    expect(store.get(id)).toBeNull();
    expect(store.listRuns(id).every((run) => run.status === "cancelled")).toBe(true);
  });

  it("tells the caller once a definition is really gone, so its triggers can be released", async () => {
    const released: string[] = [];
    const { call, engine, hooks } = harness({ onWorkflowDeleted: (workflowId) => released.push(workflowId) });
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    expect(await call("DELETE", `/api/workflows/${id}`)).toEqual({ status: 204 });
    expect(released).toEqual([id]);
    // Idempotent deletes still report: nothing points at it either way.
    expect(await call("DELETE", `/api/workflows/${id}`)).toEqual({ status: 204 });
    expect(released).toEqual([id, id]);

    // A refused delete must NOT release anything — the workflow is still there.
    const busy = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    await call("POST", `/api/workflows/${busy}/runs`, { input: "first" });
    hooks.onInterrupt = () => {
      engine.startRun(busy, "again", "webhook");
    };
    expect((await call("DELETE", `/api/workflows/${busy}`))?.status).toBe(409);
    expect(released).toEqual([id, id]);
  });

  it("keeps the 204 when releasing triggers throws — the definition is already gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { call, store } = harness({
        onWorkflowDeleted: () => {
          throw new Error("webhook file is read-only");
        },
      });
      const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
      expect(await call("DELETE", `/api/workflows/${id}`)).toEqual({ status: 204 });
      expect(store.get(id)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(id), expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves non-workflow routes and unsupported methods to the caller", async () => {
    const { call } = harness();
    expect(await call("GET", "/api/routines")).toBeNull();
    expect(await call("GET", "/api/workflows/some-id")).toBeNull();
    expect(await call("PUT", "/api/workflows")).toBeNull();
    expect(await call("GET", "/api/workflow-runs/x/cancel")).toBeNull();
  });
});

describe("workflow runs", () => {
  it("starts a run: 404 unknown, 400 with issues on a draft, 201 dispatching the entry node", async () => {
    const { call, dispatches } = harness();
    expect((await call("POST", "/api/workflows/nope/runs", { input: "x" }))?.status).toBe(404);

    const draftId = bodyOf(await call("POST", "/api/workflows", draftGraph())).workflow.id;
    const invalid = await call("POST", `/api/workflows/${draftId}/runs`, {});
    expect(invalid?.status).toBe(400);
    expect(bodyOf(invalid).error).toMatch(/^invalid workflow:/);
    expect(bodyOf(invalid).issues.map((issue: WorkflowIssue) => issue.code)).toContain("bad-entry");

    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    const started = await call("POST", `/api/workflows/${id}/runs`, { input: "inbox payload" });
    expect(started?.status).toBe(201);
    const run = bodyOf(started).run as WorkflowRun;
    expect(run.status).toBe("running");
    expect(run.trigger).toBe("manual");
    expect(run.input).toBe("inbox payload");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].botId).toBe("bot-a");
    expect(dispatches[0].prompt).toContain("inbox payload");

    // No body at all is a run with empty input; a non-string input is a 400.
    const bare = await call("POST", `/api/workflows/${id}/runs`);
    expect(bare?.status).toBe(201);
    expect((bodyOf(bare).run as WorkflowRun).input).toBe("");
    expect((await call("POST", `/api/workflows/${id}/runs`, { input: 7 }))?.status).toBe(400);
  });

  it("lists a workflow's runs and the global snapshot newest first with a limit", async () => {
    const { call } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    const other = bodyOf(await call("POST", "/api/workflows", gateGraph())).workflow.id;
    const first = (bodyOf(await call("POST", `/api/workflows/${id}/runs`, { input: "1" })).run as WorkflowRun).id;
    const second = (bodyOf(await call("POST", `/api/workflows/${id}/runs`, { input: "2" })).run as WorkflowRun).id;
    const third = (bodyOf(await call("POST", `/api/workflows/${other}/runs`, { input: "3" })).run as WorkflowRun).id;

    const mine = bodyOf(await call("GET", `/api/workflows/${id}/runs`)).runs as WorkflowRun[];
    expect(mine.map((run) => run.id)).toEqual([second, first]);
    expect(mine[0].status).toBe("queued");
    expect(mine[1].status).toBe("running");

    const all = bodyOf(await call("GET", "/api/workflow-runs")).runs as WorkflowRun[];
    expect(all.map((run) => run.id)).toEqual([third, second, first]);
    const limited = bodyOf(await call("GET", "/api/workflow-runs?limit=2")).runs as WorkflowRun[];
    expect(limited.map((run) => run.id)).toEqual([third, second]);
    // Garbage limits fall back to the default rather than erroring.
    expect((bodyOf(await call("GET", "/api/workflow-runs?limit=zero")).runs as WorkflowRun[])).toHaveLength(3);
    expect((bodyOf(await call("GET", "/api/workflow-runs?limit=-4")).runs as WorkflowRun[])).toHaveLength(3);
    expect(bodyOf(await call("GET", "/api/workflows/unknown/runs")).runs).toEqual([]);
  });

  it("cancels a live run (200), no-ops on a terminal one, 404s an unknown id", async () => {
    const { call, interrupts } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    const run = bodyOf(await call("POST", `/api/workflows/${id}/runs`, {})).run as WorkflowRun;
    const cancelled = await call("POST", `/api/workflow-runs/${run.id}/cancel`);
    expect(cancelled?.status).toBe(200);
    expect((bodyOf(cancelled).run as WorkflowRun).status).toBe("cancelled");
    expect(interrupts).toEqual([run.currentThreadId]);
    const again = await call("POST", `/api/workflow-runs/${run.id}/cancel`);
    expect(again?.status).toBe(200);
    expect((bodyOf(again).run as WorkflowRun).status).toBe("cancelled");
    expect((await call("POST", "/api/workflow-runs/nope/cancel"))?.status).toBe(404);
  });

  it("resumes only failed runs: 409 otherwise, 404 unknown", async () => {
    const { call, store } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    const run = bodyOf(await call("POST", `/api/workflows/${id}/runs`, {})).run as WorkflowRun;
    const running = await call("POST", `/api/workflow-runs/${run.id}/resume`);
    expect(running?.status).toBe(409);
    expect(bodyOf(running).error).toMatch(/only failed runs/);
    expect((await call("POST", "/api/workflow-runs/nope/resume"))?.status).toBe(404);

    // Force the receipt into the failed state the way the engine leaves it.
    store.patchRun(run.id, { status: "failed", error: "boom", endedAt: 5_000 });
    const resumed = await call("POST", `/api/workflow-runs/${run.id}/resume`);
    expect(resumed?.status).toBe(200);
    expect((bodyOf(resumed).run as WorkflowRun).status).toBe("running");
    expect((bodyOf(resumed).run as WorkflowRun).error).toBeUndefined();
  });

  it("resolves approvals: 400 bad decision, 409 not waiting, 404 unknown, 200 on an open gate", async () => {
    const { call } = harness();
    const agentId = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    const running = bodyOf(await call("POST", `/api/workflows/${agentId}/runs`, {})).run as WorkflowRun;
    const bad = await call("POST", `/api/workflow-runs/${running.id}/approval`, { decision: "maybe" });
    expect(bad?.status).toBe(400);
    expect(bodyOf(bad).error).toMatch(/^invalid approval decision/);
    expect((await call("POST", `/api/workflow-runs/${running.id}/approval`, {}))?.status).toBe(400);
    const notWaiting = await call("POST", `/api/workflow-runs/${running.id}/approval`, { decision: "approved" });
    expect(notWaiting?.status).toBe(409);
    expect(bodyOf(notWaiting).error).toMatch(/not waiting for approval/);
    expect((await call("POST", "/api/workflow-runs/nope/approval", { decision: "approved" }))?.status).toBe(404);

    const gateId = bodyOf(await call("POST", "/api/workflows", gateGraph())).workflow.id;
    const waiting = bodyOf(await call("POST", `/api/workflows/${gateId}/runs`, { input: "release 1.2" })).run as WorkflowRun;
    expect(waiting.status).toBe("waiting-approval");
    const decided = await call("POST", `/api/workflow-runs/${waiting.id}/approval`, { decision: "rejected" });
    expect(decided?.status).toBe(200);
    const settled = bodyOf(decided).run as WorkflowRun;
    expect(settled.status).toBe("completed");
    expect(settled.nodeResults.map((result) => result.outcome)).toEqual(["rejected"]);
  });
});

describe("workflowNotificationBotId", () => {
  const run = (
    overrides: Partial<Pick<WorkflowRun, "currentNodeId" | "currentThreadId" | "nodeResults">> = {},
  ): WorkflowRun => ({
    id: "r",
    workflowId: "w",
    status: "failed",
    attempt: 0,
    input: "",
    nodeResults: [],
    startedAt: 1,
    ...overrides,
  });
  const workflow = (nodes: Workflow["nodes"]): Workflow => ({
    id: "w",
    name: "W",
    entryNodeId: nodes[0]?.id ?? "",
    nodes,
    edges: [],
    layout: {},
    createdAt: 1,
    updatedAt: 1,
  });
  const lookup = (bots: string[], threads: Record<string, string> = {}): NotificationBotLookup => ({
    exists: (botId) => bots.includes(botId),
    botByThread: (threadId) => threads[threadId],
  });
  const graph = workflow([
    { kind: "approval", id: "gate", prompt: "?" },
    { kind: "agent", id: "a", botId: "bot-a", instructions: "", outcomes: ["ok"] },
    { kind: "agent", id: "b", botId: "bot-b", instructions: "", outcomes: ["ok"] },
  ]);

  it("prefers the current agent node's bot, then the first agent node", () => {
    const all = lookup(["bot-a", "bot-b"]);
    expect(workflowNotificationBotId(graph, run({ currentNodeId: "b" }), all)).toBe("bot-b");
    expect(workflowNotificationBotId(graph, run({ currentNodeId: "gate" }), all)).toBe("bot-a");
    expect(workflowNotificationBotId(graph, run(), all)).toBe("bot-a");
  });

  it("skips a deleted bot — the failing node's own — for a surviving agent bot", () => {
    const only = lookup(["bot-a"]);
    expect(workflowNotificationBotId(graph, run({ currentNodeId: "b", currentThreadId: "t-b" }), only)).toBe("bot-a");
    expect(workflowNotificationBotId(graph, run({ currentNodeId: "a" }), lookup(["bot-b"]))).toBe("bot-b");
  });

  it("falls back to the owner of the run's threads when the workflow itself is gone", () => {
    // Current thread first: the task thread of the node that just failed.
    expect(
      workflowNotificationBotId(null, run({ currentThreadId: "t-9" }), lookup(["bot-x"], { "t-9": "bot-x" })),
    ).toBe("bot-x");
    // Then the most recent node result's thread.
    const results = run({
      nodeResults: [
        { nodeId: "a", outcome: "ok", summary: "", threadId: "t-1", startedAt: 1, endedAt: 2 },
        { nodeId: "b", outcome: "ok", summary: "", threadId: "t-2", startedAt: 3, endedAt: 4 },
      ],
    });
    expect(workflowNotificationBotId(null, results, lookup(["bot-1", "bot-2"], { "t-1": "bot-1", "t-2": "bot-2" }))).toBe("bot-2");
    // A thread whose owner is gone too is skipped for an older one.
    expect(workflowNotificationBotId(null, results, lookup(["bot-1"], { "t-1": "bot-1", "t-2": "bot-2" }))).toBe("bot-1");
    // The graph's surviving bots still come before thread owners.
    expect(
      workflowNotificationBotId(graph, run({ currentNodeId: "b", currentThreadId: "t-9" }), lookup(["bot-a", "bot-x"], { "t-9": "bot-x" })),
    ).toBe("bot-a");
  });

  it("reports nobody only when no candidate exists", () => {
    expect(workflowNotificationBotId(graph, run({ currentNodeId: "b", currentThreadId: "t-b" }), lookup([]))).toBeUndefined();
    expect(workflowNotificationBotId(null, run(), lookup(["bot-a"]))).toBeUndefined();
    expect(workflowNotificationBotId(workflow([{ kind: "approval", id: "gate", prompt: "?" }]), run({ currentNodeId: "gate" }), lookup(["bot-a"]))).toBeUndefined();
  });
});

describe("workflow capabilities", () => {
  /** agentGraph() whose one node is "merge" and requires the merge flag. */
  const mergeGraph = (): WorkflowInput => ({
    ...agentGraph(),
    entryNodeId: "merge",
    nodes: [
      { kind: "agent", id: "merge", botId: "bot-a", instructions: "Merge the PR.", outcomes: ["done"], requires: ["merge"] },
    ],
    layout: {},
  });
  const codes = (issues: WorkflowIssue[]) => issues.map((issue) => issue.code);

  it("lists a node whose bot lacks the required capability as a missing-capability error, cleared once the bot is flagged", async () => {
    const { call, capabilities } = harness();
    const created = await call("POST", "/api/workflows", mergeGraph());
    expect(created?.status).toBe(201);
    const workflow = bodyOf(created).workflow as Workflow & { issues: WorkflowIssue[] };
    expect(workflow.nodes[0]).toMatchObject({ requires: ["merge"] });
    expect(workflow.issues).toContainEqual({
      severity: "error",
      code: "missing-capability",
      nodeId: "merge",
      message: 'Node "merge" requires "merge" but its bot "bot-a" is not allowed to merge.',
    });
    // The structural issues still ride along: the two lists are merged, not replaced.
    expect(codes(workflow.issues)).toContain("unwired-failure");

    const listed = bodyOf(await call("GET", "/api/workflows")).workflows as Array<Workflow & { issues: WorkflowIssue[] }>;
    expect(codes(listed[0]!.issues)).toContain("missing-capability");

    capabilities.set("bot-a", { canMerge: true });
    const relisted = bodyOf(await call("GET", "/api/workflows")).workflows as Array<Workflow & { issues: WorkflowIssue[] }>;
    expect(codes(relisted[0]!.issues)).not.toContain("missing-capability");
    expect(errors(relisted[0]!.issues)).toEqual([]);
  });

  it("refuses to start a run on a missing capability, answering the combined issues, and starts once granted", async () => {
    const { call, capabilities, dispatches, store } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", mergeGraph())).workflow.id as string;
    const refused = await call("POST", `/api/workflows/${id}/runs`, {});
    expect(refused?.status).toBe(400);
    expect(bodyOf(refused).error).toMatch(/^invalid workflow: Node "merge" requires "merge" but its bot "bot-a" is not allowed to merge/);
    expect(codes(bodyOf(refused).issues)).toContain("missing-capability");
    expect(codes(bodyOf(refused).issues)).toContain("unwired-failure");
    expect(store.listRuns(id)).toEqual([]);
    expect(dispatches).toHaveLength(0);

    capabilities.set("bot-a", { canMerge: true });
    expect((await call("POST", `/api/workflows/${id}/runs`, {}))?.status).toBe(201);
    expect(dispatches).toHaveLength(1);
  });

  it("refuses an unknown capability name at the door and PATCHes known ones through, null clearing the field", async () => {
    const { call, store } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id as string;
    const unknown = await call("PATCH", `/api/workflows/${id}`, {
      nodes: [{ ...agentGraph().nodes[0], requires: ["ship"] }],
    });
    expect(unknown?.status).toBe(400);
    expect(bodyOf(unknown).error).toMatch(/^nodes\.0\.requires/);
    expect(store.get(id)?.nodes[0]).not.toHaveProperty("requires");
    // Longer than the vocabulary can only be padding: refused at the door
    // rather than handed to the validator one entry at a time.
    const padded = await call("PATCH", `/api/workflows/${id}`, {
      nodes: [{ ...agentGraph().nodes[0], requires: ["merge", "deploy", "merge"] }],
    });
    expect(padded?.status).toBe(400);
    expect(bodyOf(padded).error).toMatch(/^nodes\.0\.requires/);

    const known = await call("PATCH", `/api/workflows/${id}`, {
      nodes: [{ ...agentGraph().nodes[0], requires: ["deploy", "merge"] }],
    });
    expect(known?.status).toBe(200);
    expect(store.get(id)?.nodes[0]).toMatchObject({ requires: ["deploy", "merge"] });
    // A duplicate is a shape the validator reports; the draft still saves.
    const doubled = await call("PATCH", `/api/workflows/${id}`, {
      nodes: [{ ...agentGraph().nodes[0], requires: ["merge", "merge"] }],
    });
    expect(doubled?.status).toBe(200);
    expect(codes(bodyOf(doubled).workflow.issues)).toContain("bad-requires");

    const cleared = await call("PATCH", `/api/workflows/${id}`, {
      nodes: [{ ...agentGraph().nodes[0], requires: null }],
    });
    expect(cleared?.status).toBe(200);
    expect(store.get(id)?.nodes[0]).not.toHaveProperty("requires");
  });
});
