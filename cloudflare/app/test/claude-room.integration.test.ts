import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ClaudeNativeRuntime } from "../src/claude-runtime";
import { ClaudeConnectionRoom } from "../src/claude-room";
import type { ClaudeConnectionStub, ClaudeInferenceInput } from "../src/claude-types";

let finishLogin!: (code: number) => void;
let nativeCalls = 0; let snapshots = 0; let destroyed = 0; let running = false;
let inferReply: Promise<{ structuredOutput: unknown; tokens: number; cliVersion: string }>;
beforeEach(() => {
  nativeCalls = snapshots = destroyed = 0; running = false;
  inferReply = Promise.resolve({ structuredOutput: { kind: "done" }, tokens: 17, cliVersion: "2.1.300" });
  vi.spyOn(ClaudeNativeRuntime.prototype, "start").mockImplementation(async () => { running = true; });
  vi.spyOn(ClaudeNativeRuntime.prototype, "authStatus").mockResolvedValue({ authenticated: true, authMethod: "claude.ai" });
  vi.spyOn(ClaudeNativeRuntime.prototype, "login").mockImplementation(async () => ({ url: Promise.resolve("https://claude.ai/oauth/authorize?state=fixture"), done: new Promise<number>(resolve => { finishLogin = resolve; }), submit: async () => { finishLogin(0); } }));
  vi.spyOn(ClaudeNativeRuntime.prototype, "infer").mockImplementation(async () => { nativeCalls++; return inferReply; });
  vi.spyOn(ClaudeNativeRuntime.prototype, "snapshot").mockImplementation(async () => ({ id: `private-snapshot-${++snapshots}`, size: 10 }));
  vi.spyOn(ClaudeNativeRuntime.prototype, "logout").mockResolvedValue();
});
afterEach(() => { vi.restoreAllMocks(); });
async function fixture(enabled = true) {
  const organizationId = crypto.randomUUID(), userId = crypto.randomUUID(), memberId = crypto.randomUUID();
  await env.DB.batch([
    ...[userId, memberId].map(id => env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, "Fixture", `${id}@example.test`, Date.now(), Date.now())),
    env.DB.prepare("INSERT INTO organizations VALUES (?,?,?)").bind(organizationId, "Claude fixture", Date.now()),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,'owner'),(?,?,'member')").bind(organizationId, userId, organizationId, memberId),
  ]);
  const namespace = (env as unknown as { CLAUDE_CONNECTIONS: DurableObjectNamespace<ClaudeConnectionRoom> }).CLAUDE_CONNECTIONS;
  const stub = namespace.getByName(JSON.stringify([organizationId, userId]));
  // Convert RPC thenables to ordinary promises before Vitest installs rejection matchers.
  const client = Object.fromEntries(["status", "startLogin", "completeLogin", "cancelLogin", "logout", "infer", "cancelInference"].map(method =>
    [method, async (input: unknown) => await (stub as unknown as Record<string, (value: unknown) => Promise<unknown>>)[method](input)])) as unknown as ClaudeConnectionStub;
  const attach = () => runInDurableObject(stub, (instance, state) => {
    (instance as unknown as { env: { CLAUDE_CODE_ENABLED: string } }).env.CLAUDE_CODE_ENABLED = enabled ? "true" : "false";
    Object.defineProperty(state, "container", { configurable: true, value: {
      images: { claude: "pinned-image" }, get running() { return running; }, async setInactivityTimeout() {},
      async destroy() { destroyed++; running = false; },
    } });
  });
  await attach();
  return { organizationId, userId, memberId, stub: client, raw: stub, attach, async login() {
    const start = await client.startLogin({ organizationId, userId, requestId: crypto.randomUUID(), expectedVersion: 0 });
    return client.completeLogin({ organizationId, userId, flowId: start.flow!.id, expectedVersion: start.connectionVersion, code: "fixture-code" });
  }, input(version = 1): ClaudeInferenceInput { return { organizationId, userId, connectionVersion: version, runId: "run", stepId: "step", deadlineAt: Date.now() + 60_000, model: "sonnet", instructions: "Supplied data only", prompt: "Synthetic task", schema: { type: "object", properties: { kind: { type: "string" } } } }; } };
}
it("requires activation, membership and fixed user identity before opening native auth", async () => {
  const f = await fixture(false);
  expect((await f.stub.status(f)).enabled).toBe(false);
  await expect(f.login()).rejects.toThrow("claude_not_enabled");
  expect(ClaudeNativeRuntime.prototype.start).not.toHaveBeenCalled();
  await expect(f.stub.status({ ...f, userId: "outsider" })).rejects.toThrow("not_found");
  const other = await fixture(); await other.login();
  await expect(other.stub.status({ ...other, userId: other.memberId })).rejects.toThrow("claude_identity_mismatch");
});
it("checkpoints native login, retains stable connection version and only replays exact known inference", async () => {
  const f = await fixture(); const status = await f.login();
  expect(status).toMatchObject({ state: "connected", connectionVersion: 1 });
  expect(JSON.stringify(status)).not.toContain("private-snapshot"); expect(status.flow).toBeUndefined();
  const input = f.input(); const result = await f.stub.infer(input);
  expect(await f.stub.infer(input)).toEqual(result); expect(nativeCalls).toBe(1);
  expect((await f.stub.status(f)).connectionVersion).toBe(1); expect(snapshots).toBe(2);
  await expect(f.stub.infer({ ...input, prompt: "Changed" })).rejects.toThrow("claude_step_reused");
  await f.stub.logout({ ...f, expectedVersion: 1 });
});
it("restores a clean opaque snapshot after idle sleep but rejects uncertain dispatched work after eviction", async () => {
  const f = await fixture(); await f.login();
  await runInDurableObject(f.raw, async (_instance, state) => { await state.storage.setAlarm(Date.now() + 60_000); });
  await runDurableObjectAlarm(f.raw); expect(running).toBe(false);
  await f.stub.infer(f.input());
  expect(ClaudeNativeRuntime.prototype.start).toHaveBeenLastCalledWith({ id: "private-snapshot-1", size: 10 }, expect.anything());
  await runInDurableObject(f.raw, async (_instance, state) => {
    const data = await state.storage.get<Record<string, unknown>>("connection");
    await state.storage.put("connection", { ...data, dirty: { id: "uncertain", kind: "inference", deadlineAt: Date.now() + 1000 } });
  });
  await evictDurableObject(f.raw); await f.attach();
  const status = await f.stub.status(f); expect(status.state).toBe("reconnect_required"); expect(status.connectionVersion).toBe(2);
  await expect(f.stub.infer(f.input())).rejects.toThrow("claude_connection_changed"); expect(nativeCalls).toBe(1);
});
it("logout tombstone wins over late inference and never permits restoration of the old snapshot", async () => {
  const f = await fixture(); await f.login();
  let reply!: (value: { structuredOutput: unknown; tokens: number; cliVersion: string }) => void;
  inferReply = new Promise(resolve => { reply = resolve; }); const input = f.input();
  const pending = f.stub.infer(input); const rejected = expect(pending).rejects.toThrow();
  while (nativeCalls === 0) await new Promise(resolve => setTimeout(resolve, 1));
  await f.stub.logout({ ...f, expectedVersion: 1 }); reply({ structuredOutput: { kind: "late" }, tokens: 5, cliVersion: "2.1.300" }); await rejected;
  expect(await f.stub.status(f)).toMatchObject({ state: "disconnected", connectionVersion: 2 });
  await runInDurableObject(f.raw, async (_instance, state) => { expect((await state.storage.get<Record<string, unknown>>("connection"))?.checkpoint).toBeUndefined(); });
  expect(snapshots).toBe(1); expect(destroyed).toBeGreaterThan(0);
});
it("membership revocation during native inference discards the result and forbids its replay", async () => {
  const f = await fixture(); await f.login();
  vi.mocked(ClaudeNativeRuntime.prototype.infer).mockImplementation(async () => { await env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(f.userId).run(); return { structuredOutput: { kind: "no" }, tokens: 2, cliVersion: "2.1.300" }; });
  await expect(f.stub.infer(f.input())).rejects.toThrow("not_found");
  expect(snapshots).toBe(1); expect(destroyed).toBeGreaterThan(0);
});
it("a timed-out CLI result requires reconnection, destroys the VM and cannot be retried", async () => {
  const f = await fixture(); await f.login(); inferReply = new Promise(() => {});
  const input = { ...f.input(), deadlineAt: Date.now() + 150 };
  await expect(f.stub.infer(input)).rejects.toThrow("claude_operation_timeout");
  expect(await f.stub.status(f)).toMatchObject({ state: "reconnect_required", connectionVersion: 2, busy: false });
  expect(destroyed).toBeGreaterThan(0); expect(nativeCalls).toBe(1);
});
it("does not leak native diagnostics and retries failed cleanup before allowing a new connection", async () => {
  const f = await fixture(); await f.login();
  vi.mocked(ClaudeNativeRuntime.prototype.infer).mockRejectedValue(new Error("Bearer synthetic-secret-that-must-not-leak"));
  await expect(f.stub.infer(f.input())).rejects.toThrow(/^claude_operation_failed$/);
  expect(JSON.stringify(await f.stub.status(f))).not.toContain("synthetic-secret");
  let attempts = 0;
  await runInDurableObject(f.raw, (_instance, state) => { Object.defineProperty(state, "container", { configurable: true, value: { images: { claude: "pinned-image" }, running: false, async destroy() { if (++attempts === 1) throw new Error("synthetic cleanup failure"); } } }); });
  await expect(f.stub.logout({ ...f, expectedVersion: 2 })).rejects.toThrow("claude_cleanup_failed");
  expect(await f.stub.status(f)).toMatchObject({ state: "disconnecting", busy: true });
  await expect(f.stub.startLogin({ ...f, requestId: crypto.randomUUID(), expectedVersion: 3 })).rejects.toThrow("claude_cleanup_pending");
  await runDurableObjectAlarm(f.raw);
  expect(await f.stub.status(f)).toMatchObject({ state: "disconnected", busy: false }); expect(attempts).toBe(2);
});
it("an old model continuation cannot cancel a newly connected generation", async () => {
  const f = await fixture(); await f.login();
  let release!: (value: { structuredOutput: unknown; tokens: number; cliVersion: string }) => void;
  inferReply = new Promise(resolve => { release = resolve; });
  const old = f.stub.infer(f.input()); const oldRejected = expect(old).rejects.toThrow("claude_operation_canceled");
  while (!nativeCalls) await new Promise(resolve => setTimeout(resolve, 1));
  await f.stub.logout({ ...f, expectedVersion: 1 }); await oldRejected;
  const next = await f.stub.startLogin({ ...f, expectedVersion: 2, requestId: crypto.randomUUID() });
  release({ structuredOutput: { kind: "late" }, tokens: 10, cliVersion: "2.1.300" });
  const connected = await f.stub.completeLogin({ ...f, expectedVersion: 3, flowId: next.flow!.id, code: "new-fixture-code" });
  expect(connected).toMatchObject({ state: "connected", connectionVersion: 3 });
  await f.stub.logout({ ...f, expectedVersion: 3 });
});
it("retains a cancellation received before claim and refuses even a known receipt afterward", async () => {
  const f = await fixture(); await f.login(); const input = f.input();
  await f.stub.cancelInference(input);
  await expect(f.stub.infer(input)).rejects.toThrow("claude_operation_canceled");
  expect(nativeCalls).toBe(0);
  const completed = { ...input, stepId: "completed" }; await f.stub.infer(completed);
  await f.stub.cancelInference(completed);
  await expect(f.stub.infer(completed)).rejects.toThrow("claude_operation_canceled");
  expect(nativeCalls).toBe(1);
  await f.stub.logout({ ...f, expectedVersion: 1 });
});
it("a cancellation during request fingerprinting wins before native dispatch", async () => {
  const f = await fixture(); await f.login(); const input = f.input();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => { entered = true; await gate; return digest(...args); });
  const pending = f.stub.infer(input); const rejection = expect(pending).rejects.toThrow("claude_operation_canceled");
  while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
  await f.stub.cancelInference(input); release(); await rejection;
  expect(nativeCalls).toBe(0); expect((await f.stub.status(f)).connectionVersion).toBe(1);
  await f.stub.logout({ ...f, expectedVersion: 1 });
});
it("preserves original login methods but only permits the subscription auth method for inference", async () => {
  for (const authMethod of ["api_key", "api_key_helper", "third_party", "oauth_token", undefined] as const) {
    const f = await fixture();
    vi.mocked(ClaudeNativeRuntime.prototype.authStatus).mockResolvedValue({ authenticated: true, authMethod });
    const status = await f.login(); expect(status.state).toBe("connected"); expect(status.authMethod).toBe(authMethod);
    await expect(f.stub.infer(f.input())).rejects.toThrow("claude_auth_method_unsupported");
  }
  expect(nativeCalls).toBe(0);
});
