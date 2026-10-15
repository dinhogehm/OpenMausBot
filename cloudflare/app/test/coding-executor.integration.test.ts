import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CodingExecutor } from "../src/coding-executor";
import { isAllowedDependencyRequest, proxyDependencyRequest } from "../src/coding-network";
import { CODING_PYTHON, CODING_UNTRUSTED_PREFIX } from "../src/coding-program";

const identity = () => ({ organizationId: "org_fixture", workspaceId: "ws_fixture", runId: "run_fixture", generation: 1, deadlineAt: Date.now() + 60_000 });
const archive = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
const tool = { kind: "run_command", command: "echo done", cwd: ".", timeoutMs: 1000 } as const;
function fixture() {
  let running = false;
  let executions = 0;
  let destroys = 0;
  let paused = false;
  let release: (() => void) | undefined;
  const monitors: (() => void)[] = [];
  let failDestroy = false;
  let graftExitCode = 0;
  const inputs: Record<string, unknown>[] = [];
  const container = {
    images: { coding: "fixture-image@sha256:abc" },
    get running() { return running; },
    start(options: ContainerStartupOptions) { expect(options.enableInternet).toBe(false); expect(options.env).toBeUndefined(); running = true; },
    async interceptOutboundHttp() {}, async interceptOutboundHttps() {}, async setInactivityTimeout() {},
    monitor() { return new Promise<void>(resolve => { monitors.push(resolve); }); },
    async destroy() { destroys++; if (failDestroy) { failDestroy = false; throw new Error("fixture teardown"); } running = false; monitors.forEach(resolve => resolve()); release?.(); },
    async exec(_argv: string[], options: ContainerExecOptions) {
      executions++;
      const body = await new Response(options.stdin as ReadableStream).text();
      const isGraft = body.includes('"kind":"graft_');
      if (isGraft) inputs.push(JSON.parse(body));
      const trusted = _argv.at(-1) === "a".repeat(40) || body.includes('"kind":"snapshot"') || body.includes('"kind":"review_diff"') || isGraft;
      const prefix = trusted ? [] : CODING_UNTRUSTED_PREFIX;
      expect(_argv.slice(0, prefix.length + 3)).toEqual([...prefix, CODING_PYTHON, "-I", "-c"]);
      const wait = paused ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
      const output = _argv.at(-1) === "a".repeat(40) ? JSON.stringify({ baseline: "b".repeat(40) }) : body.includes('"kind":"snapshot"') ? JSON.stringify({ files: [], treeDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" }) : isGraft ? JSON.stringify({ available: false, reason: "graft_unavailable", fallback: "Use read_file" }) : "done";
      return { stdout: new ReadableStream({ async start(c) { await wait; c.enqueue(new TextEncoder().encode(output)); c.close(); } }), exitCode: wait.then(() => isGraft ? graftExitCode : 0) };
    },
  };
  return { container, inputs, pause: () => { paused = true; }, resume: () => { paused = false; release?.(); }, failGraftLauncher: () => { graftExitCode = 1; }, failDestroy: () => { failDestroy = true; }, get executions() { return executions; }, get destroys() { return destroys; } };
}
async function inExecutor(callback: (executor: CodingExecutor, state: DurableObjectState) => Promise<void>) {
  const ns = (env as unknown as { CODING_EXECUTORS: DurableObjectNamespace<CodingExecutor> }).CODING_EXECUTORS;
  return runInDurableObject(ns.get(ns.newUniqueId()), callback);
}

describe("CodingExecutor durable effects", () => {
  it("blocks all egress during structural queries, supplies trusted identity and preserves nonfatal fallback receipts", async () => {
    await inExecutor(async (executor, state) => {
      const f = fixture(); Object.defineProperty(state, "container", { configurable: true, value: f.container });
      const input = identity();
      await executor.init({ ...input, baseSha: "a".repeat(40), archive: archive() });
      f.pause();
      const call = { ...input, stepId: "graft_1", tool: { kind: "graft_map" as const, identity: { organizationId: "other" } } };
      const pending = executor.step(call);
      while (f.executions < 2) await new Promise(resolve => setTimeout(resolve, 1));
      expect(await executor.reserveEgress({ ...input, bytes: 0, newRequest: true })).toBe(false);
      expect(f.inputs[0].identity).toEqual({ ...input, baseSha: "a".repeat(40) });
      f.resume();
      const result = await pending;
      expect(JSON.parse(result.output).available).toBe(false);
      expect(await executor.step(call)).toEqual(result);
      expect(f.executions).toBe(2);
      expect(await executor.reserveEgress({ ...input, bytes: 0, newRequest: true })).toBe(true);
      expect((await executor.step({ ...input, stepId: "read_after_graft", tool: { kind: "read_file", path: "src/main.ts", offset: 0, limit: 100 } })).output).toBe("done");
      expect(f.destroys).toBe(0);
      await executor.stop();
    });
  });
  it("destroys the VM when the trusted Graft launcher cannot establish isolation", async () => {
    await inExecutor(async (executor, state) => {
      const f = fixture(); Object.defineProperty(state, "container", { configurable: true, value: f.container });
      const input = identity(); await executor.init({ ...input, baseSha: "a".repeat(40), archive: archive() });
      f.failGraftLauncher();
      await expect(executor.step({ ...input, stepId: "graft_1", tool: { kind: "graft_map" } })).rejects.toThrow("coding_graft_isolation_failed");
      expect(f.destroys).toBe(1);
      expect(await executor.reserveEgress({ ...input, bytes: 0, newRequest: true })).toBe(false);
    });
  });
  it("replays known receipts and rejects changed input, tenant reuse and stale generations", async () => {
    await inExecutor(async (executor, state) => {
      const f = fixture(); Object.defineProperty(state, "container", { configurable: true, value: f.container });
      const input = identity();
      await executor.init({ ...input, baseSha: "a".repeat(40), archive: archive() });
      const call = { ...input, stepId: "step_1", tool };
      const result = await executor.step(call);
      expect(await executor.step(call)).toEqual(result);
      expect(f.executions).toBe(2);
      await expect(executor.step({ ...call, tool: { ...tool, command: "changed" } })).rejects.toThrow("step_identity_mismatch");
      await expect(executor.step({ ...call, generation: 2 })).rejects.toThrow("executor_identity_mismatch");
      await expect(executor.init({ ...input, organizationId: "other", baseSha: "a".repeat(40), archive: archive() })).rejects.toThrow("executor_identity_mismatch");
      const snapshot = await executor.snapshot({ ...input, stepId: "snapshot_1" });
      expect(snapshot.files).toEqual([]);
      expect(await executor.snapshot({ ...input, stepId: "snapshot_1" })).toEqual(snapshot);
      await executor.stop();
    });
  });
  it("persists cancel before dispatch and discards an in-flight late result", async () => {
    await inExecutor(async (executor, state) => {
      const f = fixture(); Object.defineProperty(state, "container", { configurable: true, value: f.container });
      const input = identity(); await executor.init({ ...input, baseSha: "a".repeat(40), archive: archive() });
      f.pause();
      const pending = executor.step({ ...input, stepId: "step_1", tool });
      const rejection = expect(pending).rejects.toThrow("executor_stopped");
      while (f.executions < 2) await new Promise(resolve => setTimeout(resolve, 1));
      await executor.stop(); await rejection;
      await expect(executor.step({ ...input, stepId: "step_2", tool })).rejects.toThrow("executor_stopped");
      expect(f.destroys).toBe(1);
    });
  });
  it("hard deadline destroys the VM and failed teardown must be retried", async () => {
    await inExecutor(async (executor, state) => {
      const f = fixture(); Object.defineProperty(state, "container", { configurable: true, value: f.container });
      const input = identity(); await executor.init({ ...input, baseSha: "a".repeat(40), archive: archive() });
      f.pause();
      await expect(executor.step({ ...input, stepId: "step_1", tool: { ...tool, timeoutMs: 30 } })).rejects.toThrow("executor_timeout");
      expect(f.destroys).toBe(1);
    });
    await inExecutor(async (executor, state) => {
      const f = fixture(); Object.defineProperty(state, "container", { configurable: true, value: f.container });
      f.failDestroy(); await expect(executor.stop()).rejects.toThrow("executor_cleanup_failed");
      await executor.stop(); expect(f.destroys).toBe(2);
    });
  });
  it("bounds aggregate dependency bytes and requests, fencing revoked generations", async () => {
    await inExecutor(async (executor, state) => {
      const f = fixture(); Object.defineProperty(state, "container", { configurable: true, value: f.container });
      const input = identity(); await executor.init({ ...input, baseSha: "a".repeat(40), archive: archive() });
      await state.storage.put("egress", { bytes: 1024 * 1024 * 1024 - 4, requests: 1999 });
      expect(await executor.reserveEgress({ ...input, bytes: 4, newRequest: true })).toBe(true);
      expect(await executor.reserveEgress({ ...input, bytes: 1, newRequest: false })).toBe(false);
      expect(await executor.reserveEgress({ ...input, bytes: 0, newRequest: true })).toBe(false);
      expect(await executor.reserveEgress({ ...input, generation: 2, bytes: 0, newRequest: false })).toBe(false);
      await executor.stop();
      expect(await executor.reserveEgress({ ...input, bytes: 0, newRequest: false })).toBe(false);
    });
  });
  it("interrupts an unknown dispatched effect after eviction instead of replaying it", async () => {
    const ns = (env as unknown as { CODING_EXECUTORS: DurableObjectNamespace<CodingExecutor> }).CODING_EXECUTORS;
    const stub = ns.get(ns.newUniqueId());
    const input = identity();
    await runInDurableObject(stub, async (executor, state) => {
      const f = fixture(); Object.defineProperty(state, "container", { configurable: true, value: f.container });
      await executor.init({ ...input, baseSha: "a".repeat(40), archive: archive() });
      await state.storage.put("active", "unknown_effect");
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (executor, state) => {
      await expect(executor.step({ ...input, stepId: "unknown_effect", tool })).rejects.toThrow("executor_stopped");
      expect(await state.storage.get("stopped")).toBe(true);
    });
  });
});

describe("dependency egress", () => {
  it("allows only explicit package destinations and drops arbitrary hosts, credentials and methods", () => {
    expect(isAllowedDependencyRequest(new Request("https://registry.npmjs.org/react"))).toBe(true);
    expect(isAllowedDependencyRequest(new Request("https://pypi.org/simple/pytest/"))).toBe(true);
    for (const url of ["https://evil.example/", "http://registry.npmjs.org/react", "https://registry.npmjs.org.evil.example/react", "https://127.0.0.1/", "https://pypi.org/account/login/"]) expect(isAllowedDependencyRequest(new Request(url))).toBe(false);
    expect(isAllowedDependencyRequest(new Request("https://registry.npmjs.org/react", { method: "POST" }))).toBe(false);
  });
  it("does not follow redirects or forward container authorization", async () => {
    let headers: Headers | undefined;
    const response = await proxyDependencyRequest(new Request("https://registry.npmjs.org/react", { headers: { Authorization: "secret", Cookie: "session=secret" } }), Date.now() + 1000, async (request) => {
      headers = new Headers((request as Request).headers);
      return new Response(null, { status: 302, headers: { Location: "https://evil.example/" } });
    });
    expect(headers?.has("authorization")).toBe(false); expect(headers?.has("cookie")).toBe(false);
    expect(response.status).toBe(502);
  });
  it("charges streamed response bytes before forwarding and fails closed when its quota runs out", async () => {
    const debits: [number, boolean][] = [];
    const response = await proxyDependencyRequest(new Request("https://registry.npmjs.org/react"), Date.now() + 1000,
      async () => new Response("dependency data"), async (bytes, first) => { debits.push([bytes, first]); return first; });
    await expect(response.text()).rejects.toThrow("dependency_budget_exhausted");
    expect(debits).toEqual([[0, true], [15, false]]);
  });
});
