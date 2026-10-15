import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
let server, MissionActionConfirmation, MissionDeliveryNotice;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false, server: { middlewareMode: true, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom", esbuild: { jsx: "automatic" } });
  ({ MissionActionConfirmation, MissionDeliveryNotice } = await server.ssrLoadModule("/src/missions.tsx"));
});
after(async () => { await server?.close(); });
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

test("cancel confirmation identifies the mission and does not promise rollback", () => {
  const html = render(MissionActionConfirmation, { action: "cancel", goal: "Corrigir acesso", busy: false, onConfirm() {}, onDismiss() {} });
  assert.match(html, /Corrigir acesso/);
  assert.match(html, /PRs e alterações já enviados permanecem/);
  assert.match(html, /Manter missão/);
  assert.match(html, /Confirmar cancelamento/);
});
test("pause explains that the dispatched task continues and busy actions cannot repeat", () => {
  const html = render(MissionActionConfirmation, { action: "pause", goal: "Corrigir acesso", busy: true, onConfirm() {}, onDismiss() {} });
  assert.match(html, /tarefa já enviada continua/);
  assert.match(html, /Pausando/);
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
});
test("a PR awaiting delivery is never presented as proof of production", () => {
  const html = render(MissionDeliveryNotice, { status: "awaiting_delivery", delivery: "merge_and_deploy" });
  assert.match(html, /Não há confirmação de produção/);
  assert.match(html, /adaptador autorizado/);
});
test("completed PR delivery distinguishes completion from merge and production", () => {
  const html = render(MissionDeliveryNotice, { status: "completed", delivery: "pull_request" });
  assert.match(html, /PRs verificados/);
  assert.match(html, /Merge e publicação não fazem parte desta entrega/);
});
