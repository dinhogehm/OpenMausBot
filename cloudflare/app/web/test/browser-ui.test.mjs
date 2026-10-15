import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
let server, BrowserDetail;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false, server: { middlewareMode: true, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom", esbuild: { jsx: "automatic" } });
  ({ BrowserDetail } = await server.ssrLoadModule("/src/browser.tsx"));
});
after(async () => { await server?.close(); });
const run = { runId: "fixture", status: "pending_approval", task: "Conferir formulário", initialUrl: "https://example.com", allowedHosts: ["example.com"], provider: "openai", model: "fixture-model", canApprove: true, canCancel: true, createdAt: 0, updatedAt: 0, deadlineAt: 300000, cleanupStatus: "pending", organizationId: "fixture-company", workspaceId: "fixture-workspace", createdBy: "fixture-user", credentialVersion: 1, events: [], steps: 0, modelCalls: 0, tokens: 0, generation: 0 };
const render = (blocked) => renderToStaticMarkup(createElement(BrowserDetail, { run, path: "/fixture", blocked, executionAvailable: true, onChanged() {}, onRefresh() {}, onBusyChange() {} }));
test("creating a different browser task disables approval and cancel in the current detail", () => {
  const locked = render(true), available = render(false);
  assert.equal((locked.match(/<button[^>]*disabled=""/g) ?? []).length, 2);
  assert.equal((available.match(/<button[^>]*disabled=""/g) ?? []).length, 0);
});
