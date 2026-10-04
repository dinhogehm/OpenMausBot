// The "Agora" panel as rendered: one button per line that has somewhere to go
// (a plain row when it has not), the "novo" pill with its spoken meaning, the
// "desde 08:30" line, the header's time, "Copiar resumo" and the switch; ⌘⇧A
// and where each kind of line leads.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { NowLine } from "@/lib/now-status";
import { isNowShortcut, NowPanel, nowPanelPlace, openNowTarget } from "./NowPanel";

const NOW = Date.parse("2026-10-04T13:30:00Z");

const lines: NowLine[] = [
  { id: "production", label: "Produção", text: "f9e7a2350 · no ar há 3 h · 1 entrega hoje", detail: "#9280 fix(helpdesk): rodízio", tone: "ok", target: { kind: "url", url: "https://github.com/dinhogehm/nuria-platform/pull/9280" }, fingerprint: "a", markdown: "" },
  { id: "ci", label: "ci:local", text: "na fila atrás do release: 2", detail: "espera legítima", tone: "info", fingerprint: "b", markdown: "" },
  { id: "needsYou", label: "Precisa de você", text: "2 itens · o mais antigo há 2 h", tone: "warn", target: { kind: "needsYou" }, fingerprint: "c", markdown: "" },
];

const props = (extra: Partial<Parameters<typeof NowPanel>[0]> = {}): Parameters<typeof NowPanel>[0] => ({
  lines, news: new Set(["production"]), since: "Desde 08:30: +1 em produção", firstLook: false, updatedAt: NOW, offline: false, disabled: false,
  notify: true, copied: false, onOpen: () => {}, onCopy: () => {}, onToggleNotify: () => {}, onClose: () => {}, ...extra,
});

beforeEach(() => setLocale("pt-br"));
afterEach(() => setLocale("en"));

describe("the panel", () => {
  it("a button per line with a place to go, a plain row otherwise; the 'novo' pill says what it means", () => {
    const html = renderToStaticMarkup(createElement(NowPanel, props()));
    expect(html).toContain('id="now-panel-title"');
    expect(html).toContain(">Agora<");
    expect(html).toContain("atualizado às 10:30");
    expect(html).toContain("Desde 08:30: +1 em produção");
    expect(html.match(/<button type="button" aria-label="[^"]*\. Abrir/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Produção: f9e7a2350 · no ar há 3 h · 1 entrega hoje · #9280 fix(helpdesk): rodízio. Abrir (mudou desde a última vez)"');
    expect(html).toMatch(/data-now-line="ci" data-now-tone="info"><div/);
    expect(html.match(/data-now-new=""/g)).toHaveLength(1);
    expect(html).toContain('<span class="sr-only"> — mudou desde a última vez</span>');
    expect(html).toContain("Copiar resumo");
    expect(html).toContain("Avisar no macOS");
    expect(html).toMatch(/data-now-notify=""[^>]*checked=""/);
  });

  it("first look, offline and a Mac without the release say so", () => {
    expect(renderToStaticMarkup(createElement(NowPanel, props({ since: null, firstLook: true, news: new Set() })))).toContain("Primeira vista: daqui em diante, o que mudar aparece como novo");
    expect(renderToStaticMarkup(createElement(NowPanel, props({ offline: true })))).toContain("O servidor não responde; dados das 10:30");
    expect(renderToStaticMarkup(createElement(NowPanel, props({ offline: true, updatedAt: null })))).toContain("O servidor não responde");
    expect(renderToStaticMarkup(createElement(NowPanel, props({ updatedAt: null })))).toContain("Lendo a esteira…");
    expect(renderToStaticMarkup(createElement(NowPanel, props({ disabled: true })))).toContain("Este Mac não roda o release da Nuria");
    expect(renderToStaticMarkup(createElement(NowPanel, props({ copied: true })))).toContain("Resumo copiado");
  });
});

describe("where the panel sits", () => {
  it("over the expanded sidebar from its left edge, from the icon rail's button, always inside the window", () => {
    expect(nowPanelPlace({ left: 222, bottom: 52 }, { width: 1440, height: 900 })).toEqual({ left: 12, top: 56, width: 416, maxHeight: 832 });
    expect(nowPanelPlace({ left: 20, bottom: 52 }, { width: 1440, height: 900 }, false)).toEqual({ left: 20, top: 56, width: 416, maxHeight: 832 });
    // a phone: the window less 12 px a side
    expect(nowPanelPlace({ left: 222, bottom: 52 }, { width: 390, height: 844 })).toEqual({ left: 12, top: 56, width: 366, maxHeight: 776 });
    // a button near the right edge never pushes the panel out
    expect(nowPanelPlace({ left: 700, bottom: 52 }, { width: 800, height: 600 }, false).left).toBe(372);
  });
});

describe("⌘⇧A and where lines go", () => {
  it("⌘⇧A or Ctrl+Shift+A, never ⌘A or with ⌥", () => {
    expect(isNowShortcut({ key: "A", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })).toBe(true);
    expect(isNowShortcut({ key: "a", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false })).toBe(true);
    expect(isNowShortcut({ key: "a", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false);
    expect(isNowShortcut({ key: "A", metaKey: true, ctrlKey: false, shiftKey: true, altKey: true })).toBe(false);
  });

  it("a PR to GitHub, a conversation, the resolution screen, the report", () => {
    const actions = { url: vi.fn(), thread: vi.fn(), needsYou: vi.fn(), report: vi.fn() };
    openNowTarget({ kind: "url", url: "https://github.com/dinhogehm/nuria-platform/pull/9280" }, actions);
    openNowTarget({ kind: "thread", botId: "chief", threadId: "desk" }, actions);
    openNowTarget({ kind: "needsYou" }, actions);
    openNowTarget({ kind: "report" }, actions);
    expect(actions.url).toHaveBeenCalledWith("https://github.com/dinhogehm/nuria-platform/pull/9280");
    expect(actions.thread).toHaveBeenCalledWith("chief", "desk");
    expect(actions.needsYou).toHaveBeenCalledOnce();
    expect(actions.report).toHaveBeenCalledOnce();
  });
});
