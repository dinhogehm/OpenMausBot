import assert from "node:assert/strict";
import { test } from "node:test";
import { filterMarketplace, marketplaceInstallDecision, sourceLink } from "../src/marketplace-state.ts";

const entries = [
  { id: "team", name: "Operações de produto", description: "Pesquisa e revisão", category: "Negócios", source: "omb", installable: true, installed: "not_installed" },
  { id: "custom", name: "Desenvolvimento", description: "Testes de código", category: "Engenharia", source: "omb", installable: true, installed: "modified" },
  { id: "reference", name: "Pesquisa", description: "Referência externa", category: "Negócios", source: "grokbot", installable: false, installed: "not_installed" },
] as const;

test("catalog search ignores accents, outer whitespace and word order", () => {
  assert.deepEqual(filterMarketplace(entries, "  REVISAO   operacoes  ", "all", "all").map((entry) => entry.id), ["team"]);
  assert.equal(filterMarketplace(entries, "   ", "all", "all").length, 3);
});
test("availability and source filters distinguish imports, customized profiles and references", () => {
  assert.deepEqual(filterMarketplace(entries, "", "all", "installed").map((entry) => entry.id), ["custom"]);
  assert.deepEqual(filterMarketplace(entries, "", "grokbot", "importable"), []);
  assert.deepEqual(filterMarketplace(entries, "", "grokbot", "reference").map((entry) => entry.id), ["reference"]);
});
test("external references, installed profiles and non-admins cannot install", () => {
  assert.equal(marketplaceInstallDecision(entries[2], true), "reference");
  assert.equal(marketplaceInstallDecision(entries[1], true), "installed");
  assert.equal(marketplaceInstallDecision(entries[0], false), "admin_required");
  assert.equal(marketplaceInstallDecision(entries[0], true), "ready");
});
test("source links reject insecure and credential-bearing URLs", () => {
  for (const link of [null, "", "javascript:alert(1)", "http://example.com", "https://user:secret@example.com"]) assert.equal(sourceLink(link), undefined);
  assert.equal(sourceLink("https://github.com/example/repo"), "https://github.com/example/repo");
});
