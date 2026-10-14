import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";
import type { RunRecord } from "../src/execution";
import { approveRun } from "../src/execution";
import { executorName } from "../src/run-room";

const origin = "https://cloud-app.example.test";
async function request(path: string, cookie = "", method = "GET", body?: unknown, overrides?: Partial<AppEnv>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(origin + path, {
    method, headers: { origin, cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function fixture(email = "runs@example.test") {
  let otp = "";
  await request("/api/auth/email-otp/send-verification-otp", "", "POST", { email, type: "sign-in" }, {
    EMAIL: { async send(message) { otp = message.text.match(/\b\d{8}\b/)![0]; } },
  });
  const signed = await request("/api/auth/sign-in/email-otp", "", "POST", { email, otp });
  expect(signed.status).toBe(200);
  const cookie = signed.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const { user } = await (await request("/api/session", cookie)).json() as { user: { id: string } };
  const org = await (await request("/api/organizations", cookie, "POST", { name: "Fixture Veltram" })).json() as { id: string; workspaceId: string };
  const path = `/api/organizations/${org.id}/workspaces/${org.workspaceId}/runs`;
  return { cookie, user, org, path };
}

it("creates durable proof runs idempotently and rejects cross-company access", async () => {
  const a = await fixture();
  const b = await fixture("other@example.test");
  const body = { message: "Arquivo da empresa A", delayMs: 0, requestId: crypto.randomUUID() };
  const created = await request(a.path, a.cookie, "POST", body);
  expect(created.status).toBe(201);
  const first = await created.json() as { run: RunRecord };
  expect(first.run.status).toBe("waiting_approval");
  const repeated = await (await request(a.path, a.cookie, "POST", body)).json() as { run: RunRecord };
  expect(repeated.run.id).toBe(first.run.id);
  expect((await request(a.path, a.cookie, "POST", { ...body, message: "different" })).status).toBe(409);
  expect(await (await request(a.path, a.cookie)).json()).toEqual({ runs: [first.run] });
  expect((await request(a.path, b.cookie)).status).toBe(404);
  expect((await request(`${b.path}/${first.run.id}`, b.cookie)).status).toBe(404);
  expect((await request(a.path, b.cookie, "POST", { ...body, requestId: crypto.randomUUID() })).status).toBe(404);
  expect((await request(a.path)).status).toBe(401);
});

async function fakeExecutor(orgId: string, execute: ReturnType<AppEnv["LINUX_EXECUTORS"]["getByName"]>["execute"], stop = async () => {}) {
  await runInDurableObject(env.RUNS.getByName(orgId), (instance) => {
    (instance as unknown as { env: AppEnv }).env.LINUX_EXECUTORS = { getByName: () => ({ execute, stop }) };
  });
}
async function create(f: Awaited<ReturnType<typeof fixture>>, message = "Proof from Linux") {
  const response = await request(f.path, f.cookie, "POST", { message, delayMs: 0, requestId: crypto.randomUUID() });
  expect(response.status).toBe(201);
  return (await response.json() as { run: RunRecord }).run;
}

it("persists approval and the executor artifact after the caller disconnects", async () => {
  const f = await fixture();
  let calls = 0;
  await fakeExecutor(f.org.id, async (input) => {
    calls++;
    return { stdout: input.message, artifact: input.message, exitCode: 0 };
  });
  const run = await create(f);
  expect((await request(`${f.path}/${run.id}/approve`, f.cookie, "POST", {})).status).toBe(200);
  await runDurableObjectAlarm(env.RUNS.getByName(f.org.id));
  await expect.poll(async () => (await (await request(`${f.path}/${run.id}`, f.cookie)).json() as { run: RunRecord }).run.status).toBe("succeeded");
  const result = (await (await request(`${f.path}/${run.id}`, f.cookie)).json() as { run: RunRecord }).run;
  expect(result.result).toEqual({ stdout: run.input.message, artifact: run.input.message, exitCode: 0 });
  expect((await request(`${f.path}/${run.id}/approve`, f.cookie, "POST", {})).status).toBe(409);
  expect(calls).toBe(1);
});

it("rejects approval by members and access after membership revocation", async () => {
  const f = await fixture();
  const run = await create(f);
  await env.DB.prepare("UPDATE memberships SET role = 'member' WHERE organization_id = ? AND user_id = ?").bind(f.org.id, f.user.id).run();
  expect((await request(`${f.path}/${run.id}/approve`, f.cookie, "POST", {})).status).toBe(403);
  expect((await request(`${f.path}/${run.id}/cancel`, f.cookie, "POST", {})).status).toBe(200);
  await env.DB.prepare("DELETE FROM memberships WHERE organization_id = ? AND user_id = ?").bind(f.org.id, f.user.id).run();
  expect((await request(`${f.path}/${run.id}`, f.cookie)).status).toBe(404);
});

it("fences a delayed executor result after cancellation", async () => {
  const f = await fixture();
  let complete!: (value: NonNullable<RunRecord["result"]>) => void;
  let started = false;
  const pending = new Promise<NonNullable<RunRecord["result"]>>((resolve) => { complete = resolve; });
  await fakeExecutor(f.org.id, async () => { started = true; return pending; });
  const run = await create(f);
  await request(`${f.path}/${run.id}/approve`, f.cookie, "POST", {});
  const alarm = runDurableObjectAlarm(env.RUNS.getByName(f.org.id));
  try {
    await expect.poll(() => started).toBe(true);
    const cancelled = await request(`${f.path}/${run.id}/cancel`, f.cookie, "POST", {});
    expect((await cancelled.json() as { run: RunRecord }).run.status).toBe("cancelled");
  } finally { complete({ stdout: run.input.message, artifact: run.input.message, exitCode: 0 }); await alarm; }
  const result = (await (await request(`${f.path}/${run.id}`, f.cookie)).json() as { run: RunRecord }).run;
  expect(result.status).toBe("cancelled");
  expect(result.result).toBeUndefined();
});

it("marks a lost executor as interrupted without silently running it again", async () => {
  const f = await fixture();
  let calls = 0;
  await fakeExecutor(f.org.id, async () => { calls++; throw new Error("private infrastructure details"); });
  const run = await create(f);
  await request(`${f.path}/${run.id}/approve`, f.cookie, "POST", {});
  await runDurableObjectAlarm(env.RUNS.getByName(f.org.id));
  await expect.poll(async () => (await (await request(`${f.path}/${run.id}`, f.cookie)).json() as { run: RunRecord }).run.status).toBe("interrupted");
  await runDurableObjectAlarm(env.RUNS.getByName(f.org.id));
  expect(calls).toBe(1);
  expect(await (await request(`${f.path}/${run.id}`, f.cookie)).text()).not.toContain("private infrastructure");
});

it("enforces global and organization concurrency ceilings before dispatch", async () => {
  const admission = env.ADMISSION.getByName("global");
  const deadline = Date.now() + 59_000;
  expect(await admission.acquire("one", "a", deadline)).toBe(true);
  expect(await admission.acquire("one", "a", deadline)).toBe(true);
  expect(await admission.acquire("another", "a", deadline)).toBe(false);
  expect(await admission.acquire("two", "b", deadline)).toBe(true);
  expect(await admission.acquire("three", "c", deadline)).toBe(true);
  expect(await admission.acquire("four", "d", deadline)).toBe(true);
  expect(await admission.acquire("five", "e", deadline)).toBe(false);
  await admission.release("one");
  expect(await admission.acquire("five", "e", deadline)).toBe(true);
});

it("does not call an exit-zero result successful when the expected file is missing", async () => {
  const f = await fixture();
  await fakeExecutor(f.org.id, async () => ({ stdout: "ok", artifact: "wrong contents", exitCode: 0 }));
  const run = await create(f);
  await request(`${f.path}/${run.id}/approve`, f.cookie, "POST", {});
  await runDurableObjectAlarm(env.RUNS.getByName(f.org.id));
  await expect.poll(async () => (await (await request(`${f.path}/${run.id}`, f.cookie)).json() as { run: RunRecord }).run.status).toBe("failed");
});

it("retains expired capacity until cleanup is confirmed, including a repeated acquisition", async () => {
  const admission = env.ADMISSION.getByName("global");
  let stopped = false;
  await runInDurableObject(admission, async (instance, state) => {
    await state.storage.put("state", { leases: [{ key: "old-attempt", organizationId: "a", expiresAt: Date.now() - 1 }], starts: [] });
    (instance as unknown as { env: AppEnv }).env.LINUX_EXECUTORS = { getByName: () => ({
      async execute() { throw new Error("must not dispatch"); },
      async stop() { if (!stopped) throw new Error("teardown unknown"); },
    }) };
  });
  expect(await admission.acquire("new-attempt", "a", Date.now() + 59_000)).toBe(false);
  expect(await admission.acquire("old-attempt", "a", Date.now() + 59_000)).toBe(false);
  stopped = true;
  expect(await admission.acquire("new-attempt", "a", Date.now() + 59_000)).toBe(true);
});

it("bounds total starts per hour even when every executor finishes immediately", async () => {
  const admission = env.ADMISSION.getByName("global");
  for (let n = 0; n < 30; n++) {
    expect(await admission.acquire(`attempt-${n}`, "a", Date.now() + 59_000)).toBe(true);
    await admission.release(`attempt-${n}`);
  }
  expect(await admission.acquire("over-quota", "a", Date.now() + 59_000)).toBe(false);
});

for (const scenario of ["already dispatched", "approval revoked"] as const) {
  it(`does not start an executor after recovery when ${scenario}`, async () => {
    const f = await fixture();
    let executions = 0;
    const stopped: string[] = [];
    const initial = await create(f);
    const running = approveRun(initial, Date.now());
    const room = env.RUNS.getByName(f.org.id);
    await runInDurableObject(room, async (instance, state) => {
      (instance as unknown as { env: AppEnv }).env.LINUX_EXECUTORS = { getByName: (name) => ({
        async execute() { executions++; return { stdout: "bad", artifact: "bad", exitCode: 0 }; },
        async stop() { stopped.push(name); },
      }) };
      await state.storage.put({ [`run:${initial.id}`]: { run: running, createdBy: f.user.id, approvedBy: f.user.id, dispatched: scenario === "already dispatched" }, active: initial.id });
      await state.storage.setAlarm(Date.now() + 30_000);
    });
    if (scenario === "approval revoked") await env.DB.prepare("UPDATE memberships SET role = 'member' WHERE organization_id = ?").bind(f.org.id).run();
    await runDurableObjectAlarm(room);
    const result = (await (await request(`${f.path}/${initial.id}`, f.cookie)).json() as { run: RunRecord }).run;
    expect(result.status).toBe(scenario === "already dispatched" ? "interrupted" : "cancelled");
    await expect.poll(() => stopped).toContain(executorName(running));
    expect(executions).toBe(0);
  });
}
