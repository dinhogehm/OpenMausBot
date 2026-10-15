import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogDraft, importCatalogProfiles, instructionBytes } from "../src/agent-catalog-state.ts";

test("OMB import preserves all twelve profiles and projects out credentials, sessions and executable model settings", () => {
  const profiles = Array.from({ length: 12 }, (_, i) => ({ id: `omb-${i}`, name: `Agent ${i}`, title: "Role", description: "Description", soul: i < 2 ? "" : "Instruction\nunchanged", section: "Development", modelSelection: { instanceId: "codex", model: "source-model", effort: "high", apiKey: "secret" }, sessions: ["private"], credentials: { token: "secret" }, provider: "execute-this" }));
  const result = importCatalogProfiles(JSON.stringify({ agents: profiles, token: "secret" }));
  assert.equal(result.length, 12);
  assert.equal(result[0].instructions, "");
  assert.equal(result[3].instructions, profiles[3].soul);
  assert.equal(result[3].sourceId, profiles[3].id);
  assert.equal(result[3].sourceModel, "source-model");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("execute-this"), false);
  assert.deepEqual(Object.keys(result[0]).sort(), ["sourceId", "name", "title", "description", "instructions", "section", "sourceEngine", "sourceModel", "sourceEffort"].sort());
});

test("sanitized export roundtrips without identity changes or server fields", () => {
  const [draft] = importCatalogProfiles(JSON.stringify([{ id: "original", name: "Agente", soul: " Orientação preservada \n" }]));
  const projected = catalogDraft({ ...draft, id: "cloud-id", revision: 7 });
  assert.deepEqual(importCatalogProfiles(JSON.stringify({ agents: [projected] })), [draft]);
  assert.equal("revision" in projected, false);
});

test("import rejects duplicate identities, malformed profiles and overlong UTF8 instructions without truncation", () => {
  const profile = { id: "same", name: "Agent", soul: "á".repeat(10_000) };
  assert.equal(instructionBytes(profile.soul), 20_000);
  assert.equal(importCatalogProfiles(JSON.stringify([profile]))[0].instructions, profile.soul);
  assert.throws(() => importCatalogProfiles(JSON.stringify([{ ...profile, soul: `${profile.soul}a` }])));
  assert.throws(() => importCatalogProfiles(JSON.stringify([profile, profile])));
  assert.throws(() => importCatalogProfiles(JSON.stringify([{ name: "No ID" }])));
  assert.throws(() => importCatalogProfiles(JSON.stringify([{ id: "x", name: "Bad\nname" }])));
  assert.throws(() => importCatalogProfiles(JSON.stringify({ credentials: {} })));
  assert.throws(() => importCatalogProfiles(JSON.stringify([])));
});
