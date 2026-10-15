import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { agentCatalogRoute, readAgentCatalog, validateCatalogDrafts } from "../src/agent-catalog";
import { resolveAgents } from "../src/agent-profiles";
import type { AgentCatalogDraft, AgentCatalogResponse } from "../src/agent-catalog-types";
import type { CodingRunInput } from "../src/coding-types";
import { changeCredential } from "../src/credential-store";
import type { AppEnv } from "../src/env";
import { parseCodingInput } from "../src/coding-state";

async function fixture() {
  const owner = crypto.randomUUID(); const member = crypto.randomUUID(); const organization = crypto.randomUUID();
  for (const id of [owner, member]) await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, "Fixture", `${id}@example.test`, Date.now(), Date.now()).run();
  await env.DB.prepare("INSERT INTO organizations VALUES (?, 'Catalog fixture', ?)").bind(organization, Date.now()).run();
  await env.DB.prepare("INSERT INTO memberships VALUES (?,?,'owner'),(?,?,'member')").bind(organization, owner, organization, member).run();
  return { owner, member, organization };
}
const draft = (overrides: Partial<AgentCatalogDraft> = {}): AgentCatalogDraft => ({ sourceId: crypto.randomUUID(), name: "QA", title: "Quality", description: "Check actual behavior", instructions: "Preserve the project boundaries", section: "Team", sourceEngine: "claude", sourceModel: "claude-opus-5-5", sourceEffort: "medium", ...overrides });
const imported = async (f: Awaited<ReturnType<typeof fixture>>, agents: AgentCatalogDraft[], extra = {}) => (await agentCatalogRoute(env, f.organization, f.owner, "POST", { expectedVersion: 0, requestId: crypto.randomUUID(), agents, ...extra }, true)).json() as Promise<AgentCatalogResponse>;

it("imports long profiles without permissions, credentials, history, or model authorization", async () => {
  const f = await fixture(); const profile = draft({ instructions: "á".repeat(5600) });
  const data = await imported(f, [{ ...profile, key: "must-not-persist", sessions: ["history"], provider: "anthropic", tools: ["deploy"] } as AgentCatalogDraft]);
  expect(data.agents).toHaveLength(1); expect(data.agents[0].instructions).toBe(profile.instructions);
  expect(Object.keys(data.agents[0]).sort()).toEqual([...Object.keys(profile), "id", "revision"].sort());
  expect(data.agents[0].sourceModel).toBe("claude-opus-5-5");
  expect(JSON.stringify(await env.DB.prepare("SELECT profiles FROM agent_catalogs WHERE organization_id=?").bind(f.organization).first())).not.toContain("must-not-persist");
  expect((await agentCatalogRoute(env, f.organization, f.member, "GET", {})).status).toBe(200);
  await expect(agentCatalogRoute(env, f.organization, f.member, "POST", { agents: [profile] }, true)).rejects.toMatchObject({ status: 403 });
  await expect(agentCatalogRoute(env, "other-company", f.owner, "GET", {})).rejects.toMatchObject({ status: 404 });
});

it("replays exact imports, preserves stable identities and rejects stale or changed requests", async () => {
  const f = await fixture(); const profile = draft(); const requestId = crypto.randomUUID();
  const body = { expectedVersion: 0, requestId, agents: [profile] };
  const first = await imported(f, body.agents, body);
  const replay = await imported(f, body.agents, body);
  expect(replay.version).toBe(1); expect(replay.mutation?.replayed).toBe(true); expect(replay.agents).toEqual(first.agents);
  await expect(imported(f, [draft()], { requestId })).rejects.toMatchObject({ status: 409 });
  const second = await imported(f, [profile], { expectedVersion: 1 });
  expect(second.agents).toEqual(first.agents); expect(second.version).toBe(2);
  const edits = { ...profile, description: "Updated description" };
  const results = await Promise.allSettled([imported(f, [edits], { expectedVersion: 2 }), imported(f, [edits], { expectedVersion: 2 })]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const current = await readAgentCatalog(env, f.organization);
  expect(current.agents[0].id).toBe(first.agents[0].id); expect(current.agents[0].revision).toBe(2);
  const oldReplay = await imported(f, body.agents, body);
  expect(oldReplay.version).toBe(3); expect(oldReplay.mutation?.appliedVersion).toBe(1);
  expect(oldReplay.agents[0].description).toBe("Updated description");
});

it("validates UTF8 and catalogue limits, duplicates and empty-soul descriptions", () => {
  expect(validateCatalogDrafts([draft({ instructions: "", description: "The original instructions live here" })])[0].instructions).toBe("");
  for (const profile of [draft({ instructions: "á".repeat(10001) }), draft({ name: "Bad\nname" }), draft({ instructions: "bad\ud800" }), draft({ sourceId: "../../secret" })]) expect(() => validateCatalogDrafts([profile])).toThrow();
  const duplicate = draft(); expect(() => validateCatalogDrafts([duplicate, duplicate])).toThrow();
  expect(() => validateCatalogDrafts(Array.from({ length: 101 }, () => draft()))).toThrow();
  expect(() => validateCatalogDrafts(Array.from({ length: 20 }, () => draft({ instructions: "a".repeat(20000) })))).toThrow();
});

it("keeps selections tenant-bound and freezes persona revisions with task provider inheritance", async () => {
  const f = await fixture(); const other = await fixture();
  const original = draft({ instructions: "", description: "Preserved description", name: "Codex local", sourceEngine: "codex", sourceModel: "gpt-6.1-sol" });
  const state = await imported(f, [original]); const foreign = await imported(other, [draft()]);
  const choices = { coordinator: state.agents[0].id, programmer: state.agents[0].id, reviewer: state.agents[0].id };
  await expect(agentCatalogRoute(env, f.organization, f.owner, "PUT", { expectedVersion: 1, requestId: crypto.randomUUID(), selections: { ...choices, reviewer: foreign.agents[0].id } })).rejects.toMatchObject({ status: 400 });
  const saved = await (await agentCatalogRoute(env, f.organization, f.owner, "PUT", { expectedVersion: 1, requestId: crypto.randomUUID(), selections: choices })).json() as AgentCatalogResponse;
  await changeCredential(env, f.organization, f.owner, "openai", "PUT", { expectedVersion: null, key: "fixture-only-model-key" });
  const input = { provider: "openai", model: "api-model", agentSelections: { catalogVersion: saved.version, ...choices } } as CodingRunInput;
  const agents = await resolveAgents(env, f.organization, input);
  expect(agents.map((agent) => agent.role)).toEqual(["coordinator", "programmer", "reviewer"]);
  expect(agents.every((agent) => agent.provider === "openai" && agent.model === "api-model" && agent.instructions.includes("Preserved description"))).toBe(true);
  expect(agents[0]).toMatchObject({ profileId: state.agents[0].id, profileRevision: 1, catalogVersion: 2 });
  await imported(f, [{ ...original, description: "Later edit" }], { expectedVersion: 2 });
  expect(agents[0].instructions).toContain("Preserved description");
  await expect(resolveAgents(env, f.organization, input)).rejects.toMatchObject({ status: 409 });
  expect((await readAgentCatalog(env, other.organization)).version).toBe(1);
});

it("allows concurrent retries of one import without duplicate agents or mutations", async () => {
  const f = await fixture(); const agents = [draft()]; const requestId = crypto.randomUUID();
  const results = await Promise.all([imported(f, agents, { requestId }), imported(f, agents, { requestId })]);
  expect(results.map((result) => result.version)).toEqual([1, 1]);
  expect(results[0].agents).toEqual(results[1].agents);
  expect(results.filter((result) => result.mutation?.replayed)).toHaveLength(1);
});

it("rechecks administrator authorization in the exact catalogue write", async () => {
  const f = await fixture(); const original = draft(); await imported(f, [original]);
  const database = { prepare(sql: string) {
    const statement = env.DB.prepare(sql);
    if (!sql.startsWith("UPDATE agent_catalogs")) return statement;
    return { bind(...parameters: unknown[]) { return { async run() {
      await env.DB.prepare("UPDATE memberships SET role='member' WHERE organization_id=? AND user_id=?").bind(f.organization, f.owner).run();
      return statement.bind(...parameters).run();
    } }; } };
  } } as D1Database;
  await expect(agentCatalogRoute({ ...env, DB: database } as AppEnv, f.organization, f.owner, "PUT", {
    expectedVersion: 1, requestId: crypto.randomUUID(), agents: [{ ...original, instructions: "Must never persist" }],
  })).rejects.toMatchObject({ status: 403 });
  const after = await readAgentCatalog(env, f.organization);
  expect(after.version).toBe(1); expect(after.agents[0].instructions).toBe(original.instructions);
});

it("canonicalizes selected role IDs and rejects incomplete task selections", () => {
  const id = crypto.randomUUID();
  const input = { requestId: crypto.randomUUID(), repositoryConnectionId: "repo", baseRef: "main", model: "model", provider: "openai", task: "Task", setupCommand: "", testCommand: "npm test" };
  const a = parseCodingInput({ ...input, agentSelections: { reviewer: id, coordinator: id, programmer: id, catalogVersion: 1, tools: ["deploy"] } });
  const b = parseCodingInput({ ...input, agentSelections: { catalogVersion: 1, coordinator: id, programmer: id, reviewer: id } });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  for (const agentSelections of [{ catalogVersion: 1, coordinator: id }, { catalogVersion: 0, coordinator: id, programmer: id, reviewer: id }, null]) {
    expect(() => parseCodingInput({ ...input, agentSelections })).toThrow();
  }
});
