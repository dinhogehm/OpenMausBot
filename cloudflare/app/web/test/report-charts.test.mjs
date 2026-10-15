import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, ReportTrend, ReportBars;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false, server: { middlewareMode: true, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom", esbuild: { jsx: "automatic" } });
  ({ ReportTrend, ReportBars } = await server.ssrLoadModule("/src/report-charts.tsx"));
});
after(async () => { await server?.close(); });
const render = (Component, props) => renderToStaticMarkup(createElement(Component, { title: "Entregas", description: "Dados sintéticos", ...props }));

test("a series with no coverage has an explicit empty state, never a zero chart", () => {
  const html = render(ReportTrend, { points: [{ label: "14/10", current: null, previous: null }], compare: true });
  assert.match(html, /Sem dados acompanhados/);
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /Não acompanhado/);
});

test("an observed zero still renders the chart and explains what zero means", () => {
  const html = render(ReportTrend, { points: [{ label: "14/10", current: 0 }] });
  assert.match(html, /<svg/);
  assert.match(html, /Nenhuma conclusão/);
  assert.doesNotMatch(html, /Sem dados acompanhados/);
});

test("an isolated previous observation remains visible with its own date", () => {
  const html = render(ReportTrend, { points: [{ label: "14/10", current: null, previous: 3, previousLabel: "07/10" }], compare: true });
  assert.match(html, /chart-dot-previous/);
  assert.match(html, /cx="340"/);
  assert.match(html, /07\/10/);
  assert.match(html, /14\/10: Não acompanhado tarefas; 07\/10: 3/);
});

test("result bars preserve missing categories alongside observed zero", () => {
  const html = render(ReportBars, { items: [{ label: "Concluídas", value: 0 }, { label: "Falhas", value: null }] });
  assert.match(html, /Não acompanhado/);
  assert.match(html, /0<small>/);
  assert.doesNotMatch(html, /width:NaN/);
});
