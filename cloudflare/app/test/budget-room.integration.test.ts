import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BudgetRoom } from "../src/budget-room";
import type { BudgetReserveInput, BudgetRpc } from "../src/budget-types";

let now: number;
const sources = vi.fn<typeof fetch>();
beforeEach(() => {
  now = Date.parse("2026-10-13T18:00:00Z"); vi.spyOn(Date, "now").mockImplementation(() => now);
  sources.mockReset(); sources.mockImplementation(async (url) => {
    if (String(url).startsWith("https://openrouter.ai/api/v1/models/")) return Response.json({ data: { id: "fixture/model", architecture: { output_modalities: ["text"] }, endpoints: [{ tag: "fixture", context_length: 10000, max_completion_tokens: 1000, supported_parameters: ["max_tokens"], pricing: { prompt: "0.000001", completion: "0.000002" } }] } });
    if (String(url).startsWith("https://olinda.bcb.gov.br/")) return Response.json({ value: [{ cotacaoVenda: 5, dataHoraCotacao: "2026-10-13 13:00:00.000000" }] });
    throw new Error("Unexpected external request");
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(sources);
});
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const organizationId = crypto.randomUUID(), userId = crypto.randomUUID(), memberId = crypto.randomUUID();
  await env.DB.batch([
    ...[userId, memberId].map(id => env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, "Budget fixture", `${id}@example.test`, now, now)),
    env.DB.prepare("INSERT INTO organizations VALUES (?,?,?)").bind(organizationId, "Budget fixture", now),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,'owner'),(?,?,'member')").bind(organizationId, userId, organizationId, memberId),
  ]);
  // Fresh durable storage per fixture; constructing a fresh instance exercises restart persistence.
  const stub = env.ADMISSION.getByName(`budget-${organizationId}`);
  const rpc = <T>(call: (room: BudgetRpc) => Promise<T>) => runInDurableObject(stub, (_instance, state) => call(new BudgetRoom(state, { DB: env.DB })));
  const scope = { organizationId, userId };
  const input = (changes: Partial<BudgetReserveInput> = {}): BudgetReserveInput => ({ ...scope, reservationId: crypto.randomUUID(), operationId: crypto.randomUUID(), provider: "openrouter", model: "fixture/model", maxOutputTokens: 1000, requestHash: "a".repeat(64), ...changes });
  return { scope, memberId, rpc, input };
}
const response = (id = "gen-fixture", cost = .001) => ({ id, model: "fixture/model", provider: "Fixture", choices: "invalid", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost } });

it("enforces membership, admin configuration, optimistic versions, and an immutable tenant", async () => {
  const f = await fixture();
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ configuration: { limitBrlMicros: 1_000_000_000, version: 0 }, canEdit: true });
  await expect(f.rpc(r => r.configure({ ...f.scope, userId: f.memberId, expectedVersion: 0, limitBrlMicros: 100000 }))).rejects.toThrow("admin_required");
  await f.rpc(r => r.configure({ ...f.scope, expectedVersion: 0, limitBrlMicros: 100000 }));
  await expect(f.rpc(r => r.configure({ ...f.scope, expectedVersion: 0, limitBrlMicros: 1 }))).rejects.toThrow("budget_state_changed");
  const other = await fixture(); await expect(f.rpc(r => r.get(other.scope))).rejects.toThrow("budget_tenant_mismatch");
});

it("atomically admits only one of two competing reservations and binds replay to payload and operation", async () => {
  const f = await fixture(); await f.rpc(r => r.configure({ ...f.scope, expectedVersion: 0, limitBrlMicros: 100000 }));
  const a = f.input(), b = f.input();
  const results = await Promise.allSettled([f.rpc(r => r.reserve(a)), f.rpc(r => r.reserve(b))]);
  expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
  const chosen = results[0].status === "fulfilled" ? a : b;
  const replay = await f.rpc(r => r.reserve(chosen)); expect(replay.maxBrlMicros).toBe(60000);
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ reservedBrlMicros: 60000, availableBrlMicros: 40000 });
  await expect(f.rpc(r => r.reserve({ ...chosen, requestHash: "b".repeat(64) }))).rejects.toThrow("budget_request_reused");
  await expect(f.rpc(r => r.reserve({ ...chosen, reservationId: crypto.randomUUID() }))).rejects.toThrow("budget_operation_reused");
  expect(sources).toHaveBeenCalledTimes(2);
});

it("persists one dispatch permission and rejects membership revoked before dispatch", async () => {
  const f = await fixture(), request = f.input(); await f.rpc(r => r.reserve(request));
  const key = { organizationId: f.scope.organizationId, reservationId: request.reservationId };
  const results = await Promise.all([f.rpc(r => r.dispatch(key)), f.rpc(r => r.dispatch(key))]);
  expect(results.map(r => r.dispatchAllowed).sort()).toEqual([false, true]);
  expect((await f.rpc(r => r.dispatch(key))).dispatchAllowed).toBe(false);
  const second = f.input({ userId: f.memberId }); await f.rpc(r => r.reserve(second));
  await env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(f.memberId).run();
  await expect(f.rpc(r => r.dispatch({ ...key, reservationId: second.reservationId }))).rejects.toThrow("not_found");
});

it("only releases undispatched holds; uncertainty survives restart and day rollover", async () => {
  const f = await fixture(), request = f.input(); const key = { organizationId: f.scope.organizationId, reservationId: request.reservationId };
  await f.rpc(r => r.reserve(request)); await f.rpc(r => r.dispatch(key));
  await f.rpc(r => r.uncertain(key)); await expect(f.rpc(r => r.releaseUndispatched(key))).rejects.toThrow("budget_already_dispatched");
  now = Date.parse("2026-10-15T18:00:00Z");
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ day: "2026-10-15", carryoverBrlMicros: 60000, reservedBrlMicros: 0, availableBrlMicros: 999940000 });
  expect((await f.rpc(r => r.dispatch(key))).dispatchAllowed).toBe(false);
  const pending = f.input(); await f.rpc(r => r.reserve(pending)); await f.rpc(r => r.releaseUndispatched({ ...key, reservationId: pending.reservationId }));
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ carryoverBrlMicros: 60000, reservedBrlMicros: 0 });
});

it("retains incomplete observations and settles known usage before parsing choices, exactly once", async () => {
  const f = await fixture(), request = f.input(), key = { organizationId: f.scope.organizationId, reservationId: request.reservationId };
  await f.rpc(r => r.reserve(request)); await f.rpc(r => r.dispatch(key));
  expect(await f.rpc(r => r.observe({ ...key, response: { id: "gen-fixture", usage: { total_tokens: 15 } } }))).toMatchObject({ status: "uncertain", usage: { providerRequestId: "gen-fixture", priced: false } });
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ reservedBrlMicros: 60000 });
  const receipt = await f.rpc(r => r.observe({ ...key, response: response() }));
  expect(receipt).toMatchObject({ status: "settled", actualBrlMicros: 5000, usage: { promptTokens: 10, completionTokens: 5 } });
  await f.rpc(r => r.observe({ ...key, response: response() }));
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ reservedBrlMicros: 0, settledBrlMicros: 5000, availableBrlMicros: 999995000 });
  const second = f.input(); await f.rpc(r => r.reserve(second)); const secondKey = { ...key, reservationId: second.reservationId }; await f.rpc(r => r.dispatch(secondKey));
  await expect(f.rpc(r => r.observe({ ...secondKey, response: response() }))).rejects.toThrow("budget_receipt_reused");
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ reservedBrlMicros: 60000, settledBrlMicros: 5000 });
});

it("charges late confirmed usage to the dispatch day without releasing unknown prior-day holds", async () => {
  const f = await fixture(), a = f.input(), b = f.input();
  for (const request of [a, b]) { await f.rpc(r => r.reserve(request)); await f.rpc(r => r.dispatch({ organizationId: f.scope.organizationId, reservationId: request.reservationId })); }
  now = Date.parse("2026-10-14T03:01:00Z");
  await f.rpc(r => r.observe({ organizationId: f.scope.organizationId, reservationId: a.reservationId, response: response() }));
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ settledBrlMicros: 0, carryoverBrlMicros: 60000, availableBrlMicros: 999940000 });
  now = Date.parse("2026-10-13T23:59:00Z"); expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ settledBrlMicros: 5000, reservedBrlMicros: 60000 });
});

it("retains actual overruns, blocks future spend, and ceiling edits cannot erase the pricing breach", async () => {
  const f = await fixture(), request = f.input(), key = { organizationId: f.scope.organizationId, reservationId: request.reservationId };
  await f.rpc(r => r.reserve(request)); await f.rpc(r => r.dispatch(key));
  expect(await f.rpc(r => r.observe({ ...key, response: response("gen-expensive", 1) }))).toMatchObject({ status: "settled", actualBrlMicros: 5000000 });
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ overrunBlocked: true, settledBrlMicros: 5000000, availableBrlMicros: 0 });
  await expect(f.rpc(r => r.reserve(f.input()))).rejects.toThrow("budget_overrun_blocked");
  await f.rpc(r => r.configure({ ...f.scope, expectedVersion: 0, limitBrlMicros: 1_000_000_000 }));
  expect((await f.rpc(r => r.get(f.scope))).overrunBlocked).toBe(true);
});

it("fails closed on expired price sources, limit reductions and unqualified nested upstream billing", async () => {
  const f = await fixture(), request = f.input(), key = { organizationId: f.scope.organizationId, reservationId: request.reservationId };
  await f.rpc(r => r.reserve(request)); now += 16 * 60000;
  await expect(f.rpc(r => r.dispatch(key))).rejects.toThrow("budget_quote_expired");
  await f.rpc(r => r.releaseUndispatched(key));
  sources.mockRejectedValue(new Error("source offline")); await expect(f.rpc(r => r.reserve(f.input()))).rejects.toThrow();
  expect((await f.rpc(r => r.get(f.scope))).reservedBrlMicros).toBe(0);
});

it("moves an undispatched reservation to the actual São Paulo dispatch day and honors a lower ceiling", async () => {
  const f = await fixture(); now = Date.parse("2026-10-14T02:59:00Z");
  const request = f.input(), key = { organizationId: f.scope.organizationId, reservationId: request.reservationId };
  await f.rpc(r => r.reserve(request)); now += 120000;
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ carryoverBrlMicros: 60000, reservedBrlMicros: 0 });
  await f.rpc(r => r.configure({ ...f.scope, expectedVersion: 0, limitBrlMicros: 50000 }));
  await expect(f.rpc(r => r.dispatch(key))).rejects.toThrow("budget_exhausted");
  await f.rpc(r => r.configure({ ...f.scope, expectedVersion: 1, limitBrlMicros: 70000 }));
  expect(await f.rpc(r => r.dispatch(key))).toMatchObject({ dispatchAllowed: true, reservation: { day: "2026-10-14" } });
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ carryoverBrlMicros: 0, reservedBrlMicros: 60000 });
});

it("preserves provider IDs across incomplete replies and holds unqualified upstream charges", async () => {
  const f = await fixture(), request = f.input(), key = { organizationId: f.scope.organizationId, reservationId: request.reservationId };
  await f.rpc(r => r.reserve(request)); await f.rpc(r => r.dispatch(key));
  await f.rpc(r => r.observe({ ...key, response: { id: "gen-fixture" } }));
  expect(await f.rpc(r => r.observe({ ...key, response: {} }))).toMatchObject({ status: "uncertain", usage: { providerRequestId: "gen-fixture" } });
  const nested = response(); Object.assign(nested.usage, { cost_details: { upstream_inference_cost: .002 } });
  expect(await f.rpc(r => r.observe({ ...key, response: nested }))).toMatchObject({ status: "uncertain", usage: { upstreamCostUsdNanos: 2000000, costUsdNanos: 1000000 } });
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ reservedBrlMicros: 60000, settledBrlMicros: 0 });
});

it("checks membership again after source reads, before creating a financial reservation", async () => {
  const f = await fixture(), implementation = sources.getMockImplementation()!;
  sources.mockImplementation(async (url, init) => {
    if (String(url).startsWith("https://openrouter.ai/")) await env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(f.memberId).run();
    return implementation(url, init);
  });
  await expect(f.rpc(r => r.reserve(f.input({ userId: f.memberId })))).rejects.toThrow("not_found");
  expect(await f.rpc(r => r.get(f.scope))).toMatchObject({ reservedBrlMicros: 0, carryoverBrlMicros: 0 });
});

it("exposes the same ledger through the registered native Durable Object RPC binding", async () => {
  const f = await fixture(), rpc = env.BUDGETS!.getByName(f.scope.organizationId), request = f.input();
  expect(await rpc.get(f.scope)).toMatchObject({ configuration: { version: 0 }, reservedBrlMicros: 0 });
  const reservation = await rpc.reserve(request); expect(reservation.status).toBe("reserved");
  const key = { organizationId: f.scope.organizationId, reservationId: request.reservationId };
  expect((await rpc.dispatch(key)).dispatchAllowed).toBe(true);
  expect((await rpc.dispatch(key)).dispatchAllowed).toBe(false);
  await rpc.observe({ ...key, response: response("gen-native-binding") });
  expect(await rpc.get(f.scope)).toMatchObject({ settledBrlMicros: 5000, reservedBrlMicros: 0 });
});
