import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
let server, JevAvailability, CodingTeamPicker;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false, server: { middlewareMode: true, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom", esbuild: { jsx: "automatic" } });
  ({ JevAvailability } = await server.ssrLoadModule("/src/jev-settings.tsx"));
  ({ CodingTeamPicker } = await server.ssrLoadModule("/src/coding-team.tsx"));
});
after(async () => { await server?.close(); });
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const state = { provider: "jev", model: "jev-latest", version: 1, status: "configured", updatedAt: null, canRecommend: true };

test("a stored Jev key is never presented as a verified connection", () => {
  const html = render(JevAvailability, { state });
  assert.match(html, /Chave armazenada/);
  assert.match(html, /não confirma sua validade/);
  assert.match(html, /não faz uma chamada de IA/);
  assert.match(html, /Confira a sugestão/);
});
test("configured but unavailable Jev explains the manual next step", () => {
  const html = render(JevAvailability, { state: { ...state, canRecommend: false } });
  assert.match(html, /sugestões estão indisponíveis/);
  assert.match(html, /Escolha os perfis manualmente/);
  assert.doesNotMatch(html, /Sugerir equipe com Jev/);
});
test("revoked Jev key does not present a recommendation action", () => {
  const html = render(JevAvailability, { state: { ...state, status: "revoked", canRecommend: false } });
  assert.match(html, /Chave removida/);
  assert.match(html, /escolha manual/);
  assert.doesNotMatch(html, /Sugerir equipe com Jev/);
});
test("a pending Jev lookup does not incorrectly tell the user to configure a key", () => {
  const html = render(CodingTeamPicker, { catalog: { version: 1, selections: null, agents: [{ id: "a", name: "Agente" }] }, organizationPath: "/fixture", task: "Task", disabled: false, onChange() {}, onBusyChange() {} });
  assert.match(html, /Consultando disponibilidade do Jev/);
  assert.doesNotMatch(html, /precisa armazenar a chave/);
  assert.match(html, /equipe inicial do Veltram/);
});
