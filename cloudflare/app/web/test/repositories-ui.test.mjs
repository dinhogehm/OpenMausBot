import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, RepositoryConnections, RepositoryChoices;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false, server: { middlewareMode: true, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom", esbuild: { jsx: "automatic" } });
  ({ RepositoryConnections, RepositoryChoices } = await server.ssrLoadModule("/src/repositories.tsx"));
});
after(async () => { await server?.close(); });
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const organization = { id: "company-a", name: "Empresa A", role: "owner" };
const connection = { id: "connection-a", repositoryId: 1, installationId: 1, fullName: "example/project", defaultBranch: "main", status: "active" };
const props = { organization, connections: [connection], disabled: false, busy: null, removing: null, onRequestRemove() {}, onDismiss() {}, onRemove() {} };

test("members and unknown roles cannot change repository connections", () => {
  for (const role of ["member", "unexpected-role"]) {
    const html = render(RepositoryConnections, { ...props, organization: { ...organization, role } });
    assert.match(html, /example\/project/);
    assert.doesNotMatch(html, /<button/);
  }
});

test("revoked access is distinguished from an available repository", () => {
  const html = render(RepositoryConnections, { ...props, connections: [{ ...connection, status: "revoked" }] });
  assert.match(html, /Acesso removido/);
  assert.match(html, /Nenhum repositório disponível para novas tarefas/);
  assert.doesNotMatch(html, /Desconectar example\/project/);
});

test("disconnect confirmation identifies its company and preserves existing GitHub work", () => {
  const html = render(RepositoryConnections, { ...props, removing: connection.id });
  assert.match(html, /Desconectar example\/project/);
  assert.match(html, /Empresa A/);
  assert.match(html, /branches e os PRs já criados continuam no GitHub/);
  assert.match(html, /Manter conexão/);
});

test("a pending disconnect prevents confirmation and dismissal from being repeated", () => {
  const html = render(RepositoryConnections, { ...props, removing: connection.id, busy: connection.id, disabled: true });
  assert.match(html, /Desconectando/);
  assert.match(html, /aria-busy="true"/);
  assert.equal((html.match(/<button[^>]*disabled=""/g) || []).length, 3);
});

test("a revoked connection can be selected again but active links are not offered twice", () => {
  const installations = [{ id: 1, account: "example", repositories: [{ id: 1, fullName: "example/project", defaultBranch: "main" }] }];
  const active = render(RepositoryChoices, { installations, connections: [connection], disabled: false, busy: null, onSelect() {} });
  assert.match(active, /Já conectado/);
  assert.doesNotMatch(active, /<button/);
  const revoked = render(RepositoryChoices, { installations, connections: [{ ...connection, status: "revoked" }], disabled: false, busy: null, onSelect() {} });
  assert.match(revoked, /Conectar example\/project/);
  assert.doesNotMatch(revoked, /Já conectado/);
});
