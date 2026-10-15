import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import type { BrowserAction, BrowserRun, BrowserRunInput } from "../src/browser-types";
import { changeCredential } from "../src/credential-store";
import { BrowserRoom } from "../src/browser-room";
import { CloudBrowserRuntime, type BrowserBinding } from "../src/browser-runtime";

const shot = new Uint8Array([255, 216, 255, 217]);
let reply: BrowserAction;
let usage = 123;
const model = vi.fn<typeof fetch>();
const runtime = { sessionId: "synthetic-session", navigate: vi.fn(async () => {}), observe: vi.fn(async () => ({ url: "https://example.com/", title: "Fixture", text: "Observed fixture", jpeg: shot })), act: vi.fn(async (_action: BrowserAction) => {}), close: vi.fn(async () => true) };
const binding = { fetch: vi.fn(), acquire: vi.fn(), getSession: vi.fn(async () => null), closeSession: vi.fn(async () => ({ status: "closed" })) } as unknown as BrowserBinding;
beforeEach(() => {
  vi.clearAllMocks(); usage = 123; reply = { kind: "finish", completed: true, summary: "Observed the synthetic page." };
  runtime.navigate.mockResolvedValue(); runtime.observe.mockResolvedValue({ url: "https://example.com/", title: "Fixture", text: "Observed fixture", jpeg: shot }); runtime.act.mockResolvedValue(); runtime.close.mockResolvedValue(true);
  vi.spyOn(CloudBrowserRuntime, "acquire").mockImplementation(async (_binding, _hosts, budget, _signal, acquired) => { await budget.assertActive(); await acquired(runtime.sessionId); return runtime as unknown as CloudBrowserRuntime; });
  vi.spyOn(CloudBrowserRuntime, "resume").mockResolvedValue(runtime as unknown as CloudBrowserRuntime);
  model.mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-browser-key");
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(reply) }] }], usage: { total_tokens: usage } });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(model);
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const organizationId = crypto.randomUUID(), workspaceId = crypto.randomUUID(), userId = crypto.randomUUID(), memberId = crypto.randomUUID();
  await env.DB.batch([
    ...[userId, memberId].map((id) => env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, "Fixture", `${id}@example.test`, Date.now(), Date.now())),
    env.DB.prepare("INSERT INTO organizations VALUES (?,?,?)").bind(organizationId, "Browser fixture", Date.now()),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,'owner'),(?,?,'member')").bind(organizationId, userId, organizationId, memberId),
    env.DB.prepare("INSERT INTO workspaces VALUES (?,?,?)").bind(workspaceId, organizationId, "Fixture"),
  ]);
  await changeCredential(env, organizationId, userId, "openai", "PUT", { expectedVersion: null, key: "fixture-browser-key" });
  const stub = env.BROWSER_RUNS!.getByName(organizationId);
  await runInDurableObject(stub, (instance) => { (instance as unknown as { env: AppEnv }).env.BROWSER = binding; });
  return { organizationId, workspaceId, userId, memberId, stub,
    command(action: string, body: Record<string, unknown> = {}, runId?: string, identity: Partial<{ organizationId: string; workspaceId: string; userId: string }> = {}) {
      return stub.fetch(new Request("https://browser-room.internal/", { method: "POST", body: JSON.stringify({ organizationId, workspaceId, userId, ...identity, action, body, runId }) }));
    }, alarm: () => runDurableObjectAlarm(stub) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const input = (): BrowserRunInput => ({ requestId: crypto.randomUUID(), task: "Observe this synthetic page", initialUrl: "https://example.com/", allowedHosts: ["example.com"], provider: "openai", model: "fixture-model" });
async function create(f: Fixture, body = input()) { const response = await f.command("create", { ...body }); expect(response.status, await response.clone().text()).toBe(201); return (await response.json() as { run: BrowserRun }).run; }
async function get(f: Fixture, runId: string) { return (await (await f.command("get", {}, runId)).json() as { run: BrowserRun }).run; }
async function approve(f: Fixture, run: BrowserRun) { const response = await f.command("approve", { generation: run.generation }, run.runId); expect(response.status, await response.clone().text()).toBe(200); }
async function mutate(f: Fixture, run: BrowserRun, changes: Record<string, unknown>, entryChanges: Record<string, unknown> = {}) {
  await runInDurableObject(f.stub, async (_instance, state) => { const entry = await state.storage.get<{ run: BrowserRun }>(`run:${run.runId}`); Object.assign(entry!.run, changes); Object.assign(entry!, entryChanges); await state.storage.put(`run:${run.runId}`, entry); });
}

it("requires tenant membership and admin approval before opening any browser or paying a model", async () => {
  const f = await fixture(); const run = await create(f);
  expect(run.status).toBe("pending_approval"); expect(CloudBrowserRuntime.acquire).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
  expect((await f.command("approve", { generation: 1 }, run.runId, { userId: f.memberId })).status).toBe(403);
  expect((await f.command("get", {}, run.runId, { userId: crypto.randomUUID() })).status).toBe(404);
  expect((await f.command("get", {}, run.runId, { workspaceId: crypto.randomUUID() })).status).toBe(404);
  await approve(f, run); await f.alarm(); await f.alarm();
  expect(await get(f, run.runId)).toMatchObject({ status: "completed", tokens: 123, modelCalls: 1, steps: 0 });
  await f.alarm(); expect((await get(f, run.runId)).cleanupStatus).toBe("closed"); expect(runtime.close).toHaveBeenCalled();
  const image = await f.command("screenshot", {}, run.runId); expect(image.headers.get("cache-control")).toBe("private, no-store"); expect(new Uint8Array(await image.arrayBuffer())).toEqual(shot);
});

it("replays identical creation but rejects changed input and generation, and canceled work never starts", async () => {
  const f = await fixture(), body = input(); const run = await create(f, body);
  expect((await f.command("create", { ...body })).status).toBe(200);
  expect((await f.command("create", { ...body, task: "Different task" })).status).toBe(409);
  expect((await f.command("approve", { generation: 2 }, run.runId)).status).toBe(409);
  expect((await f.command("cancel", { generation: 1 }, run.runId)).status).toBe(200);
  expect((await get(f, run.runId)).generation).toBe(2);
  expect((await f.command("approve", { generation: 2 }, run.runId)).status).toBe(409);
  await f.alarm(); expect(CloudBrowserRuntime.acquire).not.toHaveBeenCalled();
});

it("limits each organization to one active browser and rejects credential rotation before dispatch", async () => {
  const f = await fixture(); const first = await create(f), second = await create(f); await approve(f, first);
  expect((await f.command("approve", { generation: 1 }, second.runId)).status).toBe(429);
  await changeCredential(env, f.organizationId, f.userId, "openai", "PUT", { expectedVersion: 1, key: "fixture-rotated-key" });
  await f.alarm(); expect(await get(f, first.runId)).toMatchObject({ status: "failed", error: "browser_key_changed" });
  expect(CloudBrowserRuntime.acquire).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled(); await f.alarm();
});

it("interrupts persisted uncertain dispatch after restart without replaying browser or model effects", async () => {
  const f = await fixture(); const run = await create(f); await approve(f, run);
  await mutate(f, run, {}, { dispatched: true, launchAttemptAt: Date.now() });
  await runInDurableObject(f.stub, async (instance, state) => { const restarted = new BrowserRoom(state, (instance as unknown as { env: AppEnv }).env); await restarted.alarm(); });
  expect(await get(f, run.runId)).toMatchObject({ status: "interrupted", error: "browser_result_unknown" });
  expect(CloudBrowserRuntime.acquire).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
  await mutate(f, run, { deadlineAt: Date.now() - 130000 }); await f.alarm();
  expect((await get(f, run.runId)).cleanupStatus).toBe("idle_expiry");
});

it("retains observed model usage when the following browser action fails", async () => {
  const f = await fixture(); const run = await create(f); await approve(f, run); await f.alarm();
  reply = { kind: "click", x: 10, y: 10 }; runtime.act.mockRejectedValueOnce(new Error("browser_navigation_failed"));
  await f.alarm(); expect(await get(f, run.runId)).toMatchObject({ status: "failed", tokens: 123, modelCalls: 1, error: "browser_navigation_failed" }); await f.alarm();
});

it("rejects provider redirects without forwarding the company credential", async () => {
  const f = await fixture(); const run = await create(f); await approve(f, run); await f.alarm();
  model.mockImplementationOnce(async (url, options) => {
    expect(String(url)).toBe("https://api.openai.com/v1/responses"); expect(options?.redirect).toBe("manual");
    return new Response(null, { status: 307, headers: { location: "https://attacker.com/" } });
  });
  await f.alarm(); expect(await get(f, run.runId)).toMatchObject({ status: "failed", tokens: 0, modelCalls: 1, error: "browser_model_unavailable" });
  expect(model).toHaveBeenCalledTimes(1); await f.alarm();
});

it("does not dispatch a model when the conservative reservation exceeds the remaining budget", async () => {
  const f = await fixture(); const run = await create(f); await approve(f, run); await f.alarm(); await mutate(f, run, { tokens: 59000 });
  await f.alarm(); expect(await get(f, run.runId)).toMatchObject({ status: "failed", tokens: 59000, modelCalls: 0, error: "browser_budget_exhausted" });
  expect(model).not.toHaveBeenCalled(); await f.alarm();
});

it("cuts off a hanging observation at the run deadline and closes the session", async () => {
  const f = await fixture(); const run = await create(f); await approve(f, run); await f.alarm();
  runtime.observe.mockImplementationOnce(() => new Promise(() => {})); await mutate(f, run, { deadlineAt: Date.now() + 300 });
  await f.alarm(); expect(await get(f, run.runId)).toMatchObject({ status: "failed", error: "browser_operation_timeout" });
  await f.alarm(); expect(runtime.close).toHaveBeenCalled(); expect((await get(f, run.runId)).cleanupStatus).toBe("closed");
});

it("cancels an in-flight model, prevents late actions, and preserves the cancellation generation", async () => {
  const f = await fixture(); const run = await create(f); await approve(f, run); await f.alarm();
  let started = false;
  model.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => { started = true; init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }));
  const step = f.alarm(); await expect.poll(() => started).toBe(true);
  expect((await f.command("cancel", { generation: 1 }, run.runId)).status).toBe(200); await step; await f.alarm();
  expect(await get(f, run.runId)).toMatchObject({ status: "canceled", generation: 2, cleanupStatus: "closed" }); expect(runtime.act).not.toHaveBeenCalled();
});

it("does not let an acquisition resolving after its deadline replace the following run's runtime", async () => {
  const f = await fixture(); const first = await create(f); await approve(f, first);
  let release!: () => void;
  const old = { ...runtime, sessionId: "old-session", navigate: vi.fn(async () => {}), close: vi.fn(async () => true) };
  vi.mocked(CloudBrowserRuntime.acquire).mockImplementationOnce(async (_binding, _hosts, _budget, _signal, acquired) => {
    await acquired(old.sessionId); await new Promise<void>((resolve) => { release = resolve; }); return old as unknown as CloudBrowserRuntime;
  });
  await mutate(f, first, { deadlineAt: Date.now() + 300 }); await f.alarm(); await f.alarm();
  expect((await get(f, first.runId)).status).toBe("failed");
  const second = await create(f); await approve(f, second); await f.alarm();
  expect((await get(f, second.runId)).status).toBe("running");
  release(); await expect.poll(() => old.close.mock.calls.length).toBe(1);
  expect(old.navigate).not.toHaveBeenCalled(); expect(runtime.close).not.toHaveBeenCalled();
  // A stale finish must also leave the newer controller intact.
  await runInDurableObject(f.stub, async (instance, state) => {
    const entry = await state.storage.get(`run:${first.runId}`);
    await (instance as unknown as { finish(entry: unknown, status: string): Promise<void> }).finish(entry, "completed");
  });
  await f.alarm(); expect((await get(f, second.runId)).status).toBe("completed"); await f.alarm();
});
