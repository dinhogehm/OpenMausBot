import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { handleMarketplaceRoute } from "../src/marketplace-routes";
import { agentCatalogRoute, readAgentCatalog } from "../src/agent-catalog";
import type { MarketplaceListing, MarketplacePreview, MarketplaceInstallResult } from "../src/marketplace-types";

async function fixture(role = "owner") {
  const organizationId = crypto.randomUUID(), userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(userId, "Marketplace fixture", `${userId}@example.test`, Date.now(), Date.now()),
    env.DB.prepare("INSERT INTO organizations VALUES (?, 'Marketplace fixture', ?)").bind(organizationId, Date.now()),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,?)").bind(organizationId, userId, role),
  ]);
  const url = `https://cloud-app.example.test/api/organizations/${organizationId}/marketplace`;
  return { organizationId, userId, url, async call<T>(suffix = "", method = "GET", body = {}) {
    const response = await handleMarketplaceRoute(new Request(url + suffix, { method }), env, userId, body);
    return response!.json() as Promise<T>;
  } };
}
it("lists pinned MIT teams and public Grok references with explicit coverage and disabled integrations", async () => {
  const f = await fixture(); const result = await f.call<MarketplaceListing>();
  expect(result.items.filter((item) => item.source === "omb")).toHaveLength(6);
  expect(result.items.filter((item) => item.source === "grokbot").length).toBeGreaterThan(30);
  expect(result.items.filter((item) => item.source === "grokbot").every((item) => !item.installable && item.license.id === null)).toBe(true);
  const engineering = await f.call<MarketplacePreview>("/omb-engineering");
  expect(engineering.entry.license).toMatchObject({ id: "MIT", notice: expect.stringContaining("Permission is hereby granted") });
  expect(engineering.profiles).toHaveLength(4);
  expect(engineering.entry.excludedFeatures.length).toBeGreaterThan(0);
  expect(engineering.entry.version).toMatch(/^[0-9a-f]{40}$/);
});
it("requires admin scope, a known entry and the exact reviewed source version for installation", async () => {
  const owner = await fixture(), member = await fixture("member"), foreign = await fixture();
  const preview = await owner.call<MarketplacePreview>("/omb-engineering");
  const body = { entryId: preview.entry.id, version: preview.entry.version, expectedCatalogVersion: 0, requestId: crypto.randomUUID() };
  await expect(handleMarketplaceRoute(new Request(owner.url), env, foreign.userId)).rejects.toMatchObject({ status: 404 });
  await expect(member.call("/install", "POST", body)).rejects.toMatchObject({ status: 403 });
  await expect(owner.call("/install", "POST", { ...body, version: "main" })).rejects.toMatchObject({ status: 409 });
  await expect(owner.call("/install", "POST", { ...body, entryId: "https://internal/private" })).rejects.toMatchObject({ status: 404 });
  const grok = (await owner.call<MarketplaceListing>()).items.find((item) => item.source === "grokbot")!;
  await expect(owner.call("/install", "POST", { ...body, entryId: grok.id, version: grok.version })).rejects.toMatchObject({ status: 409 });
  expect((await readAgentCatalog(env, owner.organizationId)).agents).toEqual([]);
});
it("installs profiles only, replays safely and never overwrites later user customization", async () => {
  const f = await fixture(); const preview = await f.call<MarketplacePreview>("/omb-engineering");
  const body = { entryId: preview.entry.id, version: preview.entry.version, expectedCatalogVersion: 0, requestId: crypto.randomUUID() };
  const [first, simultaneous] = await Promise.all([f.call<MarketplaceInstallResult>("/install", "POST", body), f.call<MarketplaceInstallResult>("/install", "POST", body)]);
  expect(first.catalog.version).toBe(1); expect(simultaneous.catalog.version).toBe(1);
  expect(first.profileIds).toHaveLength(4); expect(first.catalog.selections).toBeNull();
  const changed = { ...preview.profiles[0], description: "Company customized this profile" };
  await agentCatalogRoute(env, f.organizationId, f.userId, "PUT", { expectedVersion: 1, requestId: crypto.randomUUID(), agents: [changed] });
  const replay = await f.call<MarketplaceInstallResult>("/install", "POST", body);
  expect(replay.catalog.version).toBe(2); expect(replay.catalog.agents[0].description).toBe(changed.description);
  expect((await f.call<MarketplacePreview>("/omb-engineering")).entry.installed).toBe("modified");
  await expect(f.call("/install", "POST", { ...body, expectedCatalogVersion: 2, requestId: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
  expect((await readAgentCatalog(env, f.organizationId)).agents[0].description).toBe(changed.description);
  expect(first.catalog.agents.every((agent) => agent.sourceModel === "" && agent.sourceEngine === "" && !Object.hasOwn(agent, "tools"))).toBe(true);
});
