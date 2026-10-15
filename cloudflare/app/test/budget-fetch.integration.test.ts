import { afterEach, expect, it, vi } from "vitest";
import { budgetedModelFetch } from "../src/budget-fetch";
import { env } from "cloudflare:workers";
import { callBrowserModel } from "../src/browser-model";
import { recommendAgents, decisionModelRoute } from "../src/decision-model";
import type { BrowserRun } from "../src/browser-types";
import type { BudgetReservation, BudgetReserveInput, BudgetRpc } from "../src/budget-types";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const controls = { model: "fixture/model", max_tokens: 100, stream: false, provider: { only: ["fixture"], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 1, completion: 2, request: 0, image: 0 } } } as const;
  let status = "reserved"; const events: string[] = [];
  const reservation = () => ({ controls, status } as unknown as BudgetReservation);
  const rpc = { reserve: vi.fn(async (_input: BudgetReserveInput) => { events.push("reserve"); return reservation(); }),
    dispatch: vi.fn(async () => { events.push("dispatch"); const allowed = status === "reserved"; if (allowed) status = "dispatched"; return { dispatchAllowed: allowed, reservation: reservation() }; }),
    observe: vi.fn(async () => { events.push("observe"); status = "settled"; return reservation(); }),
    uncertain: vi.fn(async () => { events.push("uncertain"); if (status !== "settled") status = "uncertain"; return reservation(); }),
    releaseUndispatched: vi.fn(async () => { events.push("release"); if (status !== "reserved") throw new Error("dispatched"); status = "released"; return reservation(); }) };
  const binding = { getByName: vi.fn(() => rpc as unknown as BudgetRpc) };
  const budgetEnv = { BUDGETS: binding, AI_BUDGET_REQUIRED: "true" };
  const scope = { organizationId: "fixture-org", userId: "fixture-user", operationId: "fixture-operation", provider: "openrouter", billingMode: "openrouter_credits_qualified" as const };
  const request = { url: "https://openrouter.ai/api/v1/chat/completions", headers: { authorization: "Bearer fixture-key", "content-type": "application/json" }, body: { model: "fixture/model", max_tokens: 100, messages: [{ role: "user", content: "Test" }] } };
  const network = vi.fn<typeof fetch>(async () => { events.push("fetch"); return Response.json({ id: "gen-fixture", model: "fixture/model", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: .0001 }, choices: "invalid" }); });
  return { budgetEnv, scope, request, network, rpc, events };
}

it("persists reservation and dispatch before one fixed-origin fetch, then observes before functional parsing", async () => {
  const f = fixture(); const result = await budgetedModelFetch(f.budgetEnv, f.scope, f.request, undefined, f.network);
  expect(result).toMatchObject({ choices: "invalid" }); expect(f.events).toEqual(["reserve", "dispatch", "fetch", "observe"]);
  const sent = f.network.mock.calls[0]; expect(sent[0]).toBe(f.request.url); expect(sent[1]?.redirect).toBe("manual");
  expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ stream: false, max_tokens: 100, provider: { only: ["fixture"], allow_fallbacks: false, require_parameters: true } });
  const reserve = f.rpc.reserve.mock.calls[0][0] as unknown as Record<string, unknown>;
  expect(reserve.requestHash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(reserve)).not.toContain("fixture-key");
  await expect(budgetedModelFetch(f.budgetEnv, f.scope, f.request, undefined, f.network)).rejects.toThrow("budget_already_dispatched");
  expect(f.network).toHaveBeenCalledTimes(1);
});

it("blocks unqualified billing, providers, media, server tools, plugins and unknown routing before any network", async () => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => ({ scope: { ...f.scope, billingMode: undefined }, request: f.request }),
    (f: ReturnType<typeof fixture>) => ({ scope: { ...f.scope, provider: "anthropic" }, request: f.request }),
    (f: ReturnType<typeof fixture>) => ({ scope: f.scope, request: { ...f.request, url: "https://other.example/" } }),
    (f: ReturnType<typeof fixture>) => ({ scope: f.scope, request: { ...f.request, body: { ...f.request.body, plugins: [{ id: "web" }] } } }),
    (f: ReturnType<typeof fixture>) => ({ scope: f.scope, request: { ...f.request, body: { ...f.request.body, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://image.example/" } }] }] } } }),
    (f: ReturnType<typeof fixture>) => ({ scope: f.scope, request: { ...f.request, body: { ...f.request.body, tools: [{ type: "web_search" }] } } }),
  ]) {
    const f = fixture(), changed = mutation(f);
    await expect(budgetedModelFetch(f.budgetEnv, changed.scope, changed.request, undefined, f.network)).rejects.toThrow(/budget_/);
    expect(f.network).not.toHaveBeenCalled(); expect(f.rpc.reserve).not.toHaveBeenCalled();
  }
});

it("keeps dispatched reservations uncertain on network, decode, truncated response or redirect failures", async () => {
  for (const implementation of [
    async () => { throw new Error("network error with a secret"); },
    async () => new Response("not json"),
    async () => new Response(new Uint8Array([0xff])),
    async () => new Response("x".repeat(1_200_001)),
    async () => new Response(null, { status: 307, headers: { location: "https://other.example/" } }),
  ]) {
    const f = fixture(); f.network.mockImplementation(implementation);
    await expect(budgetedModelFetch(f.budgetEnv, f.scope, f.request, undefined, f.network)).rejects.toThrow();
    expect(f.network).toHaveBeenCalledTimes(1); expect(f.rpc.uncertain).toHaveBeenCalled(); expect(f.rpc.releaseUndispatched).not.toHaveBeenCalled();
  }
});

it("observes a known bill in an HTTP error response and never releases it", async () => {
  const f = fixture(); f.network.mockResolvedValue(Response.json({ id: "gen-error", usage: { cost: .01 } }, { status: 500 }));
  await expect(budgetedModelFetch(f.budgetEnv, f.scope, f.request, undefined, f.network)).rejects.toThrow("model_request_failed");
  expect(f.rpc.observe).toHaveBeenCalledWith(expect.objectContaining({ response: { id: "gen-error", usage: { cost: .01 } } }));
  expect(f.rpc.releaseUndispatched).not.toHaveBeenCalled();
});

it("releases a canceled pre-dispatch reservation but preserves cancellation during a paid call", async () => {
  const first = fixture(), before = new AbortController();
  first.rpc.reserve.mockImplementation(async () => { before.abort(); return { status: "reserved" } as BudgetReservation; });
  await expect(budgetedModelFetch(first.budgetEnv, first.scope, first.request, before.signal, first.network)).rejects.toThrow();
  expect(first.rpc.releaseUndispatched).toHaveBeenCalled(); expect(first.rpc.dispatch).not.toHaveBeenCalled(); expect(first.network).not.toHaveBeenCalled();
  const second = fixture(), during = new AbortController();
  second.network.mockImplementation(async () => { during.abort(); throw new Error("aborted"); });
  await expect(budgetedModelFetch(second.budgetEnv, second.scope, second.request, during.signal, second.network)).rejects.toThrow();
  expect(second.rpc.uncertain).toHaveBeenCalled(); expect(second.rpc.releaseUndispatched).not.toHaveBeenCalled();
});

it("retains known usage if cancellation arrives during durable observation", async () => {
  const f = fixture(), controller = new AbortController();
  f.rpc.observe.mockImplementation(async () => { controller.abort(); return { status: "settled" } as BudgetReservation; });
  await expect(budgetedModelFetch(f.budgetEnv, f.scope, f.request, controller.signal, f.network)).rejects.toThrow();
  expect(f.rpc.observe).toHaveBeenCalledTimes(1); expect(f.rpc.releaseUndispatched).not.toHaveBeenCalled();
});

it("checks execution authority again immediately before dispatch", async () => {
  const f = fixture(), active = vi.fn(async () => {}); active.mockResolvedValueOnce().mockRejectedValueOnce(new Error("membership revoked"));
  await expect(budgetedModelFetch(f.budgetEnv, { ...f.scope, assertActive: active }, f.request, undefined, f.network)).rejects.toThrow();
  expect(f.rpc.releaseUndispatched).toHaveBeenCalled(); expect(f.network).not.toHaveBeenCalled();
});

it("pauses Browser vision and Jev without an unpriced paid request when the company budget is required", async () => {
  const userId = crypto.randomUUID(), organizationId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(userId, "Fixture", `${userId}@example.test`, Date.now(), Date.now()),
    env.DB.prepare("INSERT INTO organizations VALUES (?,?,?)").bind(organizationId, "Budget broker fixture", Date.now()),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,'owner')").bind(organizationId, userId),
  ]);
  const budgetEnv = { ...env, AI_BUDGET_REQUIRED: "true" }, network = vi.fn<typeof fetch>();
  const run = { organizationId, createdBy: userId, approvedBy: userId } as BrowserRun;
  await expect(callBrowserModel(budgetEnv, run, { url: "https://example.com", title: "", text: "", jpeg: new Uint8Array() }, new AbortController().signal, network)).rejects.toThrow("budget_adapter_unqualified");
  await expect(recommendAgents(budgetEnv, organizationId, userId, {}, network)).rejects.toThrow("budget_adapter_unqualified");
  expect(await (await decisionModelRoute(budgetEnv, organizationId, userId, "GET", {})).json()).toMatchObject({ canRecommend: false });
  expect(network).not.toHaveBeenCalled();
});

it("keeps the native financial hold after a failed paid fetch and prevents replay of that operation", async () => {
  const now = Date.parse("2026-10-13T18:00:00Z"); vi.spyOn(Date, "now").mockReturnValue(now);
  const userId = crypto.randomUUID(), organizationId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(userId, "Fixture", `${userId}@example.test`, now, now),
    env.DB.prepare("INSERT INTO organizations VALUES (?,?,?)").bind(organizationId, "Native budget fetch fixture", now),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,'owner')").bind(organizationId, userId),
  ]);
  vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
    if (String(url).startsWith("https://openrouter.ai/api/v1/models/")) return Response.json({ data: { id: "fixture/model", architecture: { output_modalities: ["text"] }, endpoints: [{ tag: "fixture", context_length: 10000, max_completion_tokens: 1000, supported_parameters: ["max_tokens"], pricing: { prompt: "0.000001", completion: "0.000002" } }] } });
    if (String(url).startsWith("https://olinda.bcb.gov.br/")) return Response.json({ value: [{ cotacaoVenda: 5, dataHoraCotacao: "2026-10-13 13:00:00.000000" }] });
    throw new Error("Unexpected URL");
  });
  const f = fixture(), scope = { ...f.scope, userId, organizationId }, budgetEnv = { ...env, AI_BUDGET_REQUIRED: "true" };
  f.network.mockRejectedValue(new Error("lost response"));
  await expect(budgetedModelFetch(budgetEnv, scope, f.request, undefined, f.network)).rejects.toThrow("model_request_failed");
  const ledger = await env.BUDGETS!.getByName(organizationId).get({ userId, organizationId });
  expect(ledger.reservedBrlMicros).toBe(51000); expect(ledger.settledBrlMicros).toBe(0);
  await expect(budgetedModelFetch(budgetEnv, scope, f.request, undefined, f.network)).rejects.toThrow("budget_already_dispatched");
  expect(f.network).toHaveBeenCalledTimes(1);
});

it("bounds a transport that ignores cancellation and keeps its full reservation", async () => {
  const f = fixture(), controller = new AbortController();
  f.network.mockImplementation(async () => { setTimeout(() => controller.abort(), 5); return new Promise<Response>(() => {}); });
  await expect(budgetedModelFetch(f.budgetEnv, f.scope, f.request, controller.signal, f.network)).rejects.toThrow("model_request_canceled");
  expect(f.rpc.uncertain).toHaveBeenCalled(); expect(f.rpc.releaseUndispatched).not.toHaveBeenCalled();
});

it("cannot silently downgrade to an unbudgeted request when configuration is absent", async () => {
  const f = fixture();
  await expect(budgetedModelFetch({ ...f.budgetEnv, AI_BUDGET_REQUIRED: undefined }, f.scope, f.request, undefined, f.network)).rejects.toThrow("budget_not_enabled");
  expect(f.network).not.toHaveBeenCalled(); expect(f.rpc.reserve).not.toHaveBeenCalled();
});

it("does not create an unobserved read promise when cancellation precedes the first body read", async () => {
  const f = fixture(), controller = new AbortController();
  const response = new Response(new ReadableStream<Uint8Array>()); const body = response.body;
  Object.defineProperty(response, "body", { get() { controller.abort(); return body; } });
  f.network.mockResolvedValue(response);
  await expect(budgetedModelFetch(f.budgetEnv, f.scope, f.request, controller.signal, f.network)).rejects.toThrow("model_request_canceled");
  expect(f.rpc.uncertain).toHaveBeenCalled(); expect(f.rpc.observe).not.toHaveBeenCalled();
});
