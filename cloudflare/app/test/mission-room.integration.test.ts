import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MissionRoom } from "../src/mission-room";
import type { MissionCodingRpc, MissionInput, MissionRecord } from "../src/mission-types";
import { nextBudgetDay } from "../src/mission-types";
import type { CodingRecord } from "../src/coding-types";

let now: number;
beforeEach(() => { now = Date.now() + 86_400_000; vi.spyOn(Date, "now").mockImplementation(() => now); });
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const organizationId = crypto.randomUUID(), userId = crypto.randomUUID(), memberId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  await env.DB.batch([
    ...[userId, memberId].map(id => env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, "Mission fixture", `${id}@example.test`, now, now)),
    env.DB.prepare("INSERT INTO organizations VALUES (?,?,?)").bind(organizationId, "Mission fixture", now),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,'owner'),(?,?,'member')").bind(organizationId, userId, organizationId, memberId),
    env.DB.prepare("INSERT INTO workspaces VALUES (?,?,?)").bind(workspaceId, organizationId, "Fixture"),
  ]);
  const scope = { organizationId, workspaceId, userId };
  const runs = new Map<string, CodingRecord>(), tombstones = new Set<string>();
  const create = vi.fn<MissionCodingRpc["createFromMission"]>();
  const get = vi.fn<MissionCodingRpc["getFromMission"]>(async input => ({ run: runs.has(input.runId) ? structuredClone(runs.get(input.runId)!) : null }));
  const cancel = vi.fn<MissionCodingRpc["cancelFromMission"]>(async input => {
    tombstones.add(input.runId);
    const run = runs.get(input.runId);
    if (run && !["completed", "failed", "canceled", "interrupted"].includes(run.status)) { run.status = "canceled"; run.generation++; run.updatedAt = now; run.finishedAt = now; }
    return { run: run ? structuredClone(run) : null };
  });
  const accept: MissionCodingRpc["createFromMission"] = async input => {
    if (tombstones.has(input.input.requestId)) throw new Error("coding_canceled");
    let run = runs.get(input.input.requestId);
    if (!run) {
      run = { ...input.input, ...scope, createdBy: userId, missionId: input.missionId, runId: input.input.requestId, generation: 1, deadlineAt: now + 1800000, createdAt: now, updatedAt: now, status: "running", repositoryName: "fixture/project", credentialVersion: 1, modelCalls: 0, tokens: 0, events: [] };
      runs.set(run.runId, run);
    }
    return { run: structuredClone(run) };
  };
  create.mockImplementation(accept);
  const ns = (env as unknown as { MISSIONS: DurableObjectNamespace<MissionRoom> }).MISSIONS;
  const stub = ns.get(ns.newUniqueId());
  const use = <T>(action: (room: MissionRoom, state: DurableObjectState) => Promise<T>) => runInDurableObject(stub, (_room, state) => action(new MissionRoom(state, { DB: env.DB, CODING_RUNS: { getByName: () => ({ createFromMission: create, getFromMission: get, cancelFromMission: cancel }) } }), state));
  const input = (overrides: Partial<MissionInput> = {}): MissionInput => ({ requestId: crypto.randomUUID(), goal: "Correct the fixture calculation", acceptanceCriteria: ["The declared fixture test passes"], repositoryConnectionId: "repo_fixture", baseRef: "main", provider: "openrouter", model: "fixture/model", setupCommand: "", testCommand: "npm test", delivery: "pull_request", tasks: [{ title: "Correct sum", instructions: "Repair the fixture sum function and add the regression test." }], ...overrides });
  const call = async (action: string, body: unknown = {}, missionId?: string, override = {}) => use(async room => {
    const response = await room.fetch(new Request("https://fixture/mission", { method: "POST", body: JSON.stringify({ ...scope, action, body, missionId, ...override }) }));
    return { status: response.status, body: await response.json() as { mission: MissionRecord; missions: MissionRecord[]; error?: string; nextCursor?: string } };
  });
  const read = async (id: string) => (await call("get", {}, id)).body.mission;
  const tick = async (at = now + 30_001) => { now = at; await use(room => room.alarm()); };
  const complete = (id: string, changes: Partial<CodingRecord> = {}) => {
    const run = runs.get(id)!;
    Object.assign(run, { status: "completed", updatedAt: now, finishedAt: now, verification: { command: run.testCommand, exitCode: 0, treeDigest: "a".repeat(64), output: "fixture passed", finishedAt: now, truncated: false }, review: { approved: true, summary: "Fixture reviewed", at: now }, result: { branch: `veltram/${id}`, commitSha: "a".repeat(40), prNumber: 7, prUrl: "https://github.com/fixture/project/pull/7", changedFiles: 1 }, ...changes });
  };
  return { scope, memberId, runs, tombstones, create, get, cancel, accept, use, input, call, read, tick, complete };
}

it("validates admin, tenant and workspace boundaries, canonical replay and optimistic controls", async () => {
  const f = await fixture(), input = f.input();
  expect((await f.call("create", input, undefined, { userId: f.memberId })).status).toBe(403);
  const created = await f.call("create", { ...input, userId: "ignored", budgetMode: "disabled" });
  expect(created.status).toBe(201);
  expect((await f.call("create", input)).body.mission).toEqual(created.body.mission);
  expect((await f.call("create", { ...input, goal: "Changed" })).status).toBe(409);
  expect((await f.call("pause", { expectedVersion: 0 }, input.requestId)).body.error).toBe("mission_state_changed");
  const other = await fixture();
  expect((await f.call("get", {}, input.requestId, other.scope)).status).toBe(404);
  expect((await f.call("list", {}, undefined, { userId: f.memberId })).body.missions).toHaveLength(1);
  expect(f.create).not.toHaveBeenCalled();
});

it("runs a declared queue across restarts and completes only with actual test, review and PR receipts", async () => {
  const f = await fixture(), input = f.input({ tasks: [{ title: "One", instructions: "First fixture change" }, { title: "Two", instructions: "Second independent fixture change" }] });
  await f.call("create", input); await f.tick();
  let mission = await f.read(input.requestId);
  expect(mission.tasks[0].status).toBe("running"); expect(f.create).toHaveBeenCalledTimes(1);
  f.complete(mission.tasks[0].runId); await f.tick(); await f.tick();
  mission = await f.read(input.requestId); expect(f.create).toHaveBeenCalledTimes(2);
  f.complete(mission.tasks[1].runId); await f.tick(); await f.tick();
  mission = await f.read(input.requestId);
  expect(mission.status).toBe("completed"); expect(mission.deliveryEvidence).toBe("pull_requests_verified");
  expect(mission.tasks.every(task => task.evidence?.test?.exitCode === 0 && task.evidence.pullRequest?.url)).toBe(true);
  expect(f.create.mock.calls[0][0].input.task).toContain(input.acceptanceCriteria[0]);
  expect((await f.call("list")).body.missions).toHaveLength(1);
  expect(await f.use((_room, state) => state.storage.get("active"))).toEqual([]);
});

it.each([{ delivery: "pull_request" as const, missing: true }, { delivery: "merge_and_deploy" as const, missing: false }])("does not confuse PRs with sufficient evidence or a production publication: $delivery/$missing", async ({ delivery, missing }) => {
  const f = await fixture(), input = f.input({ delivery }); await f.call("create", input); await f.tick();
  const mission = await f.read(input.requestId); f.complete(mission.tasks[0].runId, missing ? { review: undefined } : {}); await f.tick(); await f.tick();
  const after = await f.read(input.requestId);
  expect(after.status).toBe(missing ? "interrupted" : "awaiting_delivery");
  if (!missing) expect(after.deliveryEvidence).toBe("project_adapter_required");
  expect(f.create).toHaveBeenCalledTimes(1);
});

it("reconciles an accepted create after a lost response without a second dispatch", async () => {
  const f = await fixture(), input = f.input();
  f.create.mockImplementationOnce(async value => { await f.accept(value); throw new Error("response lost"); });
  await f.call("create", input); await f.tick();
  expect((await f.read(input.requestId)).status).toBe("reconciling");
  await f.tick();
  expect((await f.read(input.requestId)).tasks[0].status).toBe("running");
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.get).toHaveBeenCalledTimes(1);
});

it("replays the same deterministic ID only after read-only reconciliation confirms absence", async () => {
  const f = await fixture(), input = f.input();
  f.create.mockRejectedValueOnce(new Error("transport failed before response"));
  await f.call("create", input); await f.tick(); await f.tick();
  expect(f.create).toHaveBeenCalledTimes(2); expect(f.get).toHaveBeenCalledTimes(1);
  expect(f.create.mock.calls[0][0].input.requestId).toBe(f.create.mock.calls[1][0].input.requestId);
  expect(f.runs.size).toBe(1);
});

it("cancels an in-flight create, retains a late known PR and does not start the next task", async () => {
  const f = await fixture(), input = f.input({ tasks: [{ title: "One", instructions: "First" }, { title: "Two", instructions: "Second" }] });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  f.create.mockImplementationOnce(async value => { await f.accept(value); f.complete(value.input.requestId); await hold; return { run: structuredClone(f.runs.get(value.input.requestId)!) }; });
  await f.call("create", input);
  const pending = f.tick();
  while (!f.create.mock.calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  const current = await f.read(input.requestId);
  await f.call("cancel", { expectedVersion: current.version }, input.requestId);
  release(); await pending; await f.tick();
  const after = await f.read(input.requestId);
  expect(after.status).toBe("canceled"); expect(after.tasks[0].evidence?.pullRequest?.number).toBe(7);
  expect(f.tombstones.has(current.tasks[0].runId)).toBe(true); expect(f.create).toHaveBeenCalledTimes(1);
});

it("pauses a known budget failure until next BRT day, preserves the failed attempt and changes its ID once", async () => {
  const f = await fixture(), input = f.input(); await f.call("create", input); await f.tick();
  const first = (await f.read(input.requestId)).tasks[0].runId;
  Object.assign(f.runs.get(first)!, { status: "failed", error: "budget_exhausted", finishedAt: now, updatedAt: now });
  await f.tick();
  const paused = await f.read(input.requestId); expect(paused.status).toBe("paused_budget"); expect(paused.nextWakeAt).toBe(nextBudgetDay(now));
  await f.tick(paused.nextWakeAt! - 1); expect(f.create).toHaveBeenCalledTimes(1);
  await f.tick(paused.nextWakeAt!);
  const resumed = await f.read(input.requestId);
  expect(resumed.tasks[0].attempt).toBe(2); expect(resumed.tasks[0].runId).not.toBe(first);
  expect(resumed.tasks[0].previousAttempts?.[0].error).toBe("budget_exhausted");
  expect(f.create).toHaveBeenCalledTimes(2);
});

it("subscription reconnection requires explicit resume and never switches to a paid API", async () => {
  const f = await fixture(), input = f.input({ provider: "anthropic", model: "claude-sonnet-4-6", modelSource: { kind: "claude-code", connectionVersion: 1 } });
  await f.call("create", input); await f.tick();
  const first = (await f.read(input.requestId)).tasks[0].runId;
  Object.assign(f.runs.get(first)!, { status: "failed", error: "claude_reconnect_required", finishedAt: now, updatedAt: now });
  await f.tick(); const paused = await f.read(input.requestId); expect(paused.status).toBe("paused_subscription");
  await f.tick(now + 2 * 86_400_000); expect(f.create).toHaveBeenCalledTimes(1);
  await f.call("resume", { expectedVersion: paused.version, modelSource: { kind: "claude-code", connectionVersion: 2 } }, input.requestId); await f.tick();
  expect(f.create.mock.calls[1][0].input).toMatchObject({ provider: "anthropic", modelSource: { kind: "claude-code", connectionVersion: 2 } });
});

it("revocation before dispatch stops execution and a stale pending-approval response cannot bypass manual pause", async () => {
  const f = await fixture(), input = f.input(); await f.call("create", input);
  await env.DB.prepare("DELETE FROM memberships WHERE user_id=?").bind(f.scope.userId).run(); await f.tick();
  expect(f.create).not.toHaveBeenCalled();
  expect((await f.use((_room, state) => state.storage.get<{ mission: MissionRecord }>(`mission:${input.requestId}`)))?.mission.status).toBe("paused_authorization");
  const g = await fixture(), second = g.input(); await g.call("create", second); await g.tick();
  const id = (await g.read(second.requestId)).tasks[0].runId; g.runs.get(id)!.status = "pending_approval";
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  g.get.mockImplementationOnce(async () => { await hold; return { run: structuredClone(g.runs.get(id)!) }; });
  const pending = g.tick(); while (!g.get.mock.calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  const current = await g.read(second.requestId); await g.call("pause", { expectedVersion: current.version }, second.requestId);
  release(); await pending;
  expect(g.create).toHaveBeenCalledTimes(1); expect((await g.read(second.requestId)).status).toBe("paused");
});

it("a publication uncertainty remains interrupted and never obtains a new run ID on resume", async () => {
  const f = await fixture(), input = f.input(); await f.call("create", input); await f.tick();
  const first = (await f.read(input.requestId)).tasks[0].runId;
  Object.assign(f.runs.get(first)!, { status: "interrupted", error: "coding_publication_uncertain", finishedAt: now, updatedAt: now });
  await f.tick(); const stopped = await f.read(input.requestId);
  expect(stopped.status).toBe("interrupted");
  await f.call("resume", { expectedVersion: stopped.version }, input.requestId); await f.tick();
  expect((await f.read(input.requestId)).tasks[0].runId).toBe(first); expect(f.create).toHaveBeenCalledTimes(1);
});
