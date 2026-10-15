import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { decisionModelRoute, recommendAgents, parseRecommendations } from "../src/decision-model";
import { agentCatalogRoute, readAgentCatalog } from "../src/agent-catalog";
import type { AgentRecommendation, DecisionModelState } from "../src/decision-model-types";

async function fixture() {
  const owner = crypto.randomUUID(); const member = crypto.randomUUID(); const organization = crypto.randomUUID();
  for (const id of [owner, member]) await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, "Fixture", `${id}@example.test`, Date.now(), Date.now()).run();
  await env.DB.prepare("INSERT INTO organizations VALUES (?, 'Decision fixture', ?)").bind(organization, Date.now()).run();
  await env.DB.prepare("INSERT INTO memberships VALUES (?,?,'owner'),(?,?,'member')").bind(organization, owner, organization, member).run();
  await agentCatalogRoute(env, organization, owner, "POST", { expectedVersion: 0, requestId: crypto.randomUUID(), agents: ["Planner", "Coder"].map((name) => ({ sourceId: crypto.randomUUID(), name, title: name, description: "Profile summary", instructions: "PRIVATE-SOUL-MUST-NOT-BE-SENT" })) }, true);
  const catalogue = await readAgentCatalog(env, organization);
  return { owner, member, organization, catalogue, body: { catalogVersion: catalogue.version, task: "Fix the test" } };
}
const valid = (ids: string[], override = {}) => ({ answers: Object.fromEntries(["coordinator", "programmer", "reviewer"].map((role) => [role, { type: "choice", choice: ids[0], probabilities: { [ids[0]]: .8, [ids[1]]: .2 }, confidence: .42, ...override }])) });
const configure = (f: Awaited<ReturnType<typeof fixture>>, expectedVersion: number | null = null) => decisionModelRoute(env, f.organization, f.owner, "PUT", { expectedVersion, key: "fixture-only-jev-key" });

it("stores company-scoped encrypted Jev keys without treating them as coding providers", async () => {
  const f = await fixture();
  expect(await (await decisionModelRoute(env, f.organization, f.member, "GET", {})).json()).toMatchObject({ status: "missing", canRecommend: false });
  await expect(decisionModelRoute(env, f.organization, f.member, "PUT", { expectedVersion: null, key: "fixture-only-jev-key" })).rejects.toMatchObject({ status: 403 });
  const saved = await (await configure(f)).json() as DecisionModelState;
  expect(saved).toMatchObject({ status: "configured", version: 1, model: "jev-latest", canRecommend: true });
  expect(JSON.stringify(await env.DB.prepare("SELECT * FROM decision_credentials WHERE organization_id=?").bind(f.organization).first())).not.toContain("fixture-only-jev-key");
  expect((await env.DB.prepare("SELECT provider FROM provider_credentials WHERE organization_id=?").bind(f.organization).all()).results).toHaveLength(0);
  await expect(configure(f)).rejects.toMatchObject({ status: 409 });
  await decisionModelRoute(env, f.organization, f.owner, "DELETE", { expectedVersion: 1 });
  expect(await env.DB.prepare("SELECT status,iv,ciphertext FROM decision_credentials WHERE organization_id=?").bind(f.organization).first()).toEqual({ status: "revoked", iv: null, ciphertext: null });
});

it("makes one fixed-origin call for three bounded profile choices and never changes the saved team", async () => {
  const f = await fixture(); await configure(f); let calls = 0;
  const response = await recommendAgents(env, f.organization, f.owner, f.body, async (url, options) => {
    calls++; expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(options?.redirect).toBe("manual"); expect(options?.signal).toBeDefined();
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fixture-only-jev-key");
    const body = JSON.parse(String(options?.body));
    expect(body.model).toBe("jev-latest"); expect(Object.keys(body.questions)).toEqual(["coordinator", "programmer", "reviewer"]);
    expect(String(options?.body)).not.toContain("PRIVATE-SOUL");
    expect(String(options?.body)).not.toContain("fixture-only-jev-key");
    return Response.json(valid(f.catalogue.agents.map((agent) => agent.id)));
  });
  const data = await response.json() as AgentRecommendation;
  expect(calls).toBe(1); expect(data.fallback).toBe(false); expect(data.confidence?.coordinator).toBe(.8);
  expect(data.recommendation?.catalogVersion).toBe(f.catalogue.version);
  expect(await readAgentCatalog(env, f.organization)).toEqual(f.catalogue);
});

it("rejects unoffered, non-top, malformed, incomplete and low-probability choices", () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  expect(parseRecommendations(valid(ids), ids)).not.toBeNull();
  for (const value of [valid(ids, { choice: "foreign" }), valid(ids, { choice: ids[1] }), valid(ids, { probabilities: { [ids[0]]: 2 } }), valid(ids, { probabilities: { [ids[0]]: .8, other: .2 } }), { answers: {} }]) expect(parseRecommendations(value, ids)).toBeNull();
  expect(parseRecommendations(valid(ids, { probabilities: { [ids[0]]: .55, [ids[1]]: .45 } }), ids)?.uncertain).toBe(true);
});

it("does not make calls for missing keys, foreign scopes, stale catalogues or members", async () => {
  const f = await fixture(); let calls = 0;
  const fake: typeof fetch = async () => { calls++; throw new Error("must-not-call"); };
  expect(await (await recommendAgents(env, f.organization, f.owner, f.body, fake)).json()).toMatchObject({ fallback: true, reason: "not_configured" });
  await expect(recommendAgents(env, f.organization, f.member, f.body, fake)).rejects.toMatchObject({ status: 403 });
  await expect(recommendAgents(env, "foreign", f.owner, f.body, fake)).rejects.toMatchObject({ status: 404 });
  await expect(recommendAgents(env, f.organization, f.owner, { ...f.body, catalogVersion: 2 }, fake)).rejects.toMatchObject({ status: 409 });
  expect(calls).toBe(0);
});

it("bounds concurrent recommendations and rejects credential changes while waiting", async () => {
  const f = await fixture(); await configure(f);
  let release!: (response: Response) => void; let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const first = recommendAgents(env, f.organization, f.owner, f.body, async () => { started(); return new Promise<Response>((resolve) => { release = resolve; }); });
  await startedPromise;
  expect(await (await recommendAgents(env, f.organization, f.owner, f.body, async () => { throw new Error("second call must not run"); })).json()).toMatchObject({ fallback: true, reason: "busy_or_limited" });
  await configure(f, 1);
  release(Response.json(valid(f.catalogue.agents.map((agent) => agent.id))));
  expect(await (await first).json()).toMatchObject({ fallback: true, reason: "configuration_changed", recommendation: null });
});

it("falls back on timeout and oversized responses without returning vendor errors", async () => {
  const f = await fixture(); await configure(f);
  const result = await recommendAgents(env, f.organization, f.owner, f.body, async (_url, options) => new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new Error("sensitive vendor response")), { once: true }); }));
  expect(await result.json()).toMatchObject({ fallback: true, reason: "timeout", recommendation: null });
  const large = await recommendAgents(env, f.organization, f.owner, f.body, async () => new Response("a".repeat(65537)));
  expect(await large.json()).toMatchObject({ fallback: true, recommendation: null });
});

it("does not follow a provider redirect or forward its credential to another origin", async () => {
  const f = await fixture(); await configure(f); let calls = 0;
  const result = await recommendAgents(env, f.organization, f.owner, f.body, async (url, options) => {
    calls++; expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone"); expect(options?.redirect).toBe("manual");
    return new Response(null, { status: 302, headers: { location: "https://attacker.com/" } });
  });
  expect(await result.json()).toMatchObject({ fallback: true, recommendation: null }); expect(calls).toBe(1);
});

it("enforces a durable per-company hourly budget and never retries a failed call", async () => {
  const f = await fixture(); await configure(f); let calls = 0;
  const fail: typeof fetch = async () => { calls++; return new Response("never-return-this-provider-error", { status: 429 }); };
  const failed = await (await recommendAgents(env, f.organization, f.owner, f.body, fail)).json();
  expect(failed).toMatchObject({ fallback: true, recommendation: null });
  expect(JSON.stringify(failed)).not.toContain("provider-error"); expect(calls).toBe(1);
  await env.DB.prepare("UPDATE decision_limits SET count=30 WHERE organization_id=?").bind(f.organization).run();
  expect(await (await recommendAgents(env, f.organization, f.owner, f.body, fail)).json()).toMatchObject({ reason: "busy_or_limited" });
  expect(calls).toBe(1);
});

it("discards recommendations when catalogue changes before the answer arrives", async () => {
  const f = await fixture(); await configure(f);
  const result = await recommendAgents(env, f.organization, f.owner, f.body, async () => {
    await agentCatalogRoute(env, f.organization, f.owner, "PUT", { expectedVersion: 1, requestId: crypto.randomUUID(), agents: [{ ...f.catalogue.agents[0], description: "New persona" }] });
    return Response.json(valid(f.catalogue.agents.map((agent) => agent.id)));
  });
  expect(await result.json()).toMatchObject({ fallback: true, reason: "configuration_changed", recommendation: null });
});
