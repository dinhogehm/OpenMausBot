// Workflow HTTP handlers, exercised as the pure functions index.ts wraps:
// a real WorkflowStore over a temp dir and a real WorkflowEngine with
// capture stubs, no socket. What is under test is the status/body contract
// the React state (Task 8) and the trigger layer (Task 7) build on.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Workflow, WorkflowIssue, WorkflowRun } from "../shared/workflow.ts";
import { handleWorkflowRequest, workflowNotificationBotId, type WorkflowApiDeps } from "./workflow-api.ts";
import { WorkflowEngine } from "./workflow-run.ts";
import { WorkflowStore, type WorkflowInput } from "./workflow-store.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-api-"));
  dirs.push(dir);
  let clock = 1_000;
  const now = () => ++clock;
  const store = new WorkflowStore({ file: join(dir, "workflows.json"), runsFile: join(dir, "workflow-runs.json"), now });
  const dispatches: Array<{ botId: string; threadId: string; prompt: string }> = [];
  const interrupts: string[] = [];
  let taskSeq = 0;
  const engine = new WorkflowEngine({
    store,
    now,
    botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++taskSeq}` }),
    startTurn: (botId, threadId, prompt) => {
      dispatches.push({ botId, threadId, prompt });
      return Promise.resolve();
    },
    interruptTurn: async (_botId, threadId) => {
      interrupts.push(threadId);
    },
  });
  const deps: WorkflowApiDeps = { store, engine };
  const call = (method: string, target: string, body?: unknown) => {
    const url = new URL(target, "http://omb.test");
    return handleWorkflowRequest(deps, {
      method,
      path: url.pathname,
      searchParams: url.searchParams,
      readBody: async () => body ?? {},
    });
  };
  return { store, engine, deps, call, dispatches, interrupts };
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

  it("rejects a malformed body with field-level details", async () => {
    const { call } = harness();
    const blankName = await call("POST", "/api/workflows", { ...draftGraph(), name: "   " });
    expect(blankName?.status).toBe(400);
    expect(bodyOf(blankName).details.join("\n")).toMatch(/name/);

    const unknownKind = await call("POST", "/api/workflows", {
      ...draftGraph(),
      nodes: [{ kind: "robot", id: "r" }],
    });
    expect(unknownKind?.status).toBe(400);

    const stringNumber = await call("POST", "/api/workflows", {
      ...agentGraph(),
      nodes: [{ ...agentGraph().nodes[0], retries: "2" }],
    });
    expect(stringNumber?.status).toBe(400);
    expect(bodyOf(stringNumber).details.join("\n")).toMatch(/retries/);

    const missing = await call("POST", "/api/workflows", { name: "No graph" });
    expect(missing?.status).toBe(400);
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
    const cleared = await call("PATCH", `/api/workflows/${id}`, { maxNodeExecutions: null, description: null });
    expect(cleared?.status).toBe(200);
    expect(store.get(id)?.maxNodeExecutions).toBeUndefined();
    expect(store.get(id)?.description).toBeUndefined();
    // Absent keys leave fields alone.
    const untouched = await call("PATCH", `/api/workflows/${id}`, { name: "Renamed" });
    expect(untouched?.status).toBe(200);
    expect(store.get(id)?.name).toBe("Renamed");
    expect(store.get(id)?.nodes).toHaveLength(1);
  });

  it("refuses an invalid PATCH with the merged draft's issues and leaves the store alone", async () => {
    const { call, store } = harness();
    const id = bodyOf(await call("POST", "/api/workflows", agentGraph())).workflow.id;
    const response = await call("PATCH", `/api/workflows/${id}`, { entryNodeId: "ghost" });
    expect(response?.status).toBe(400);
    expect(bodyOf(response).error).toMatch(/^invalid workflow:/);
    expect(bodyOf(response).issues.map((issue: WorkflowIssue) => issue.code)).toContain("bad-entry");
    expect(store.get(id)?.entryNodeId).toBe("triage");
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
  const run = (currentNodeId?: string): WorkflowRun => ({
    id: "r",
    workflowId: "w",
    status: "failed",
    attempt: 0,
    input: "",
    nodeResults: [],
    startedAt: 1,
    ...(currentNodeId === undefined ? {} : { currentNodeId }),
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

  it("prefers the current agent node's bot, then the first agent node, then nothing", () => {
    const graph = workflow([
      { kind: "approval", id: "gate", prompt: "?" },
      { kind: "agent", id: "a", botId: "bot-a", instructions: "", outcomes: ["ok"] },
      { kind: "agent", id: "b", botId: "bot-b", instructions: "", outcomes: ["ok"] },
    ]);
    expect(workflowNotificationBotId(graph, run("b"))).toBe("bot-b");
    expect(workflowNotificationBotId(graph, run("gate"))).toBe("bot-a");
    expect(workflowNotificationBotId(graph, run())).toBe("bot-a");
    expect(workflowNotificationBotId(workflow([{ kind: "approval", id: "gate", prompt: "?" }]), run("gate"))).toBeUndefined();
    expect(workflowNotificationBotId(null, run("a"))).toBeUndefined();
  });
});
