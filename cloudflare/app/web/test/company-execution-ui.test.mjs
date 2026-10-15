import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
let server, RunDetail, CompanyContext;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false, server: { middlewareMode: true, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom", esbuild: { jsx: "automatic" } });
  ({ RunDetail } = await server.ssrLoadModule("/src/runs.tsx"));
  ({ CompanyContext } = await server.ssrLoadModule("/src/organization.tsx"));
});
after(async () => { await server?.close(); });
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const run = { id: "fixture-run", organizationId: "fixture-company", workspaceId: "fixture-workspace", input: { message: "Verificação sintética", delayMs: 5000 }, generation: 0, status: "waiting_approval", createdAt: 100, updatedAt: 100, leaseExpiresAt: null, canApprove: false, canCancel: false };
const detail = (overrides = {}, extra = {}) => render(RunDetail, { path: "/fixture", run: { ...run, ...overrides }, onChanged() {}, onConflict() {}, onBusy() {}, ...extra });
const company = { id: "fixture-company", name: "Empresa sintética", role: "member" };
const context = (extra) => render(CompanyContext, { organization: company, workspaces: [], loading: false, error: "", onRetry() {}, onNavigate() {}, ...extra });

test("a member cannot approve or cancel a test without explicit permissions", () => {
  const html = detail();
  assert.match(html, /Aguardando um administrador/);
  assert.doesNotMatch(html, /Aprovar e executar|Cancelar teste/);
  assert.match(html, /Nenhuma chave de IA será usada/);
});
test("pending requests lock both approval and cancellation controls", () => {
  const html = detail({ canApprove: true, canCancel: true }, { locked: true });
  assert.match(html, /Aprovar e executar/);
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
});
test("a successful status without receipt does not invent a result", () => {
  const html = detail({ status: "succeeded" });
  assert.match(html, /a saída ainda não está disponível/);
  assert.doesNotMatch(html, /Saída registrada|Código de saída/);
});
test("terminal receipt preserves failure exit code and escapes output", () => {
  const html = detail({ status: "failed", result: { exitCode: 2, stdout: "<script>fixture</script>", artifact: "" } });
  assert.match(html, /Código de saída: 2/);
  assert.match(html, /&lt;script&gt;fixture&lt;\/script&gt;/);
  assert.match(html, /Sem conteúdo no arquivo/);
});
test("company loading and errors remain distinct from a confirmed empty workspace list", () => {
  assert.match(context({ loading: true }), /Carregando espaços/);
  assert.doesNotMatch(context({ loading: true }), /Nenhum espaço disponível/);
  const failed = context({ error: "Consulta indisponível" });
  assert.match(failed, /Não foi possível consultar/);
  assert.match(failed, /Tentar novamente/);
  assert.doesNotMatch(failed, /Nenhum espaço disponível/);
  assert.match(context({}), /Nenhum espaço disponível/);
  assert.match(context({}), /Atualizar espaços/);
});
