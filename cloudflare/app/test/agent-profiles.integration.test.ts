import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { agentProfilesRoute, defaultAgents, readAgentTeam, validateAgents } from "../src/agent-profiles";

async function fixture() {
  const owner = crypto.randomUUID(); const member = crypto.randomUUID(); const organization = crypto.randomUUID();
  for (const id of [owner, member]) await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, "Fixture", `${id}@example.test`, Date.now(), Date.now()).run();
  await env.DB.prepare("INSERT INTO organizations VALUES (?, 'Team fixture', ?)").bind(organization, Date.now()).run();
  await env.DB.prepare("INSERT INTO memberships VALUES (?,?,'owner'),(?,?,'member')").bind(organization, owner, organization, member).run();
  return { owner, member, organization };
}
it("keeps the preset read-only for members and does not allow profiles to grant tools", async () => {
  const f = await fixture();
  const initial = await (await agentProfilesRoute(env, f.organization, f.member, "GET", {})).json();
  expect(initial).toEqual({ version: 0, agents: defaultAgents });
  await expect(agentProfilesRoute(env, f.organization, f.member, "PUT", { expectedVersion: 0, agents: defaultAgents })).rejects.toMatchObject({ status: 403 });
  await expect(agentProfilesRoute(env, "different-company", f.owner, "GET", {})).rejects.toMatchObject({ status: 404 });
  const profiles = validateAgents(defaultAgents.map((agent) => ({ ...agent, tools: ["github_push", "secrets"] })));
  expect(profiles.every((agent) => !("tools" in agent))).toBe(true);
});
it("stores all three roles atomically, rejects stale saves and isolates companies", async () => {
  const a = await fixture(); const b = await fixture();
  const profiles = defaultAgents.map((agent) => ({ ...agent, name: `${agent.name} da empresa A` }));
  expect((await agentProfilesRoute(env, a.organization, a.owner, "PUT", { expectedVersion: 0, agents: profiles })).status).toBe(200);
  const results = await Promise.allSettled([
    agentProfilesRoute(env, a.organization, a.owner, "PUT", { expectedVersion: 1, agents: profiles }),
    agentProfilesRoute(env, a.organization, a.owner, "PUT", { expectedVersion: 1, agents: profiles }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect((await readAgentTeam(env, a.organization)).version).toBe(2);
  expect(await readAgentTeam(env, b.organization)).toEqual({ version: 0, agents: defaultAgents });
});
it("rejects duplicate roles, unavailable roles and incomplete model overrides", () => {
  expect(() => validateAgents([defaultAgents[0], defaultAgents[0], defaultAgents[2]])).toThrow();
  expect(() => validateAgents(defaultAgents.map((agent) => ({ ...agent, provider: "anthropic", model: "" })))).toThrow();
  expect(() => validateAgents(defaultAgents.map((agent) => ({ ...agent, instructions: "x".repeat(4001) })))).toThrow();
});
