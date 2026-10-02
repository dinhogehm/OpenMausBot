import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { digestTooltip } from "@/lib/digest-text";
import { CodeBlock } from "./ChatMarkdown";

// R10-visual N8 and N11: what the owner sees on 02/10 (pt-BR app) — a code
// block's header said "1 line", "Wrap", "Save", "Copy"; and the server's
// "no tool activity observed in this turn" (server/digest.ts) must never be
// the words on screen: the stored digest stays English for the model and the
// index, and the chip reads it in the reader's language.
describe("a code block and a turn's digest, in pt-BR", () => {
  afterEach(() => setLocale("en"));

  it("the code block header is all pt-BR: count, wrap, save, copy", () => {
    setLocale("pt-br");
    const one = renderToStaticMarkup(createElement(CodeBlock, { code: "echo d5bb1f70b > ~/.nuria/declined-production-release.sha", lang: "sh", streaming: false }));
    expect(one).toMatch(/>1 linha<\/span>/);
    expect(one).toContain('aria-label="Quebrar linhas longas"');
    expect(one).toContain(">Quebrar</span>");
    expect(one).toContain('title="Baixar o trecho como arquivo"');
    expect(one).toContain(">Salvar</span>");
    expect(one).toContain('aria-label="Copiar o código para a área de transferência"');
    expect(one).toContain(">Copiar</span>");
    for (const english of [">1 line<", ">Wrap<", ">Save<", ">Copy<", "Wrap long lines", "Download snippet", "Copy code"]) expect(one).not.toContain(english);
    const many = renderToStaticMarkup(createElement(CodeBlock, { code: "a\nb\nc", lang: "ts", streaming: false }));
    expect(many).toMatch(/>3 linhas<\/span>/);
  });

  it("English stays English", () => {
    setLocale("en");
    const html = renderToStaticMarkup(createElement(CodeBlock, { code: "a\nb", lang: "ts", streaming: false }));
    expect(html).toMatch(/>2 lines<\/span>/);
    expect(html).toContain('aria-label="Wrap long lines"');
  });

  it("the digest the owner sees for a turn with no tool activity is pt-BR", () => {
    setLocale("pt-br");
    const tooltip = digestTooltip({ tools: [], toolsDropped: 0, files: null, memory: [], memoryDropped: 0, reply: "", hookCoverage: "none" } as unknown as Parameters<typeof digestTooltip>[0]);
    expect(tooltip).toBe("Nenhuma atividade de ferramenta observada neste turno");
  });
});
