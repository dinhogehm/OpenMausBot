// The "Esteira" screen (lot Z), rendered from the board the real builder
// makes over the real pipeline of 03–04/10: the six columns in order with
// their counts, each card's state and reason in words, the stuck ones said
// with their limit, what waits on the person in evidence with its way to
// "Precisa de você", unknown as "—", the filters, and the phone's tabs —
// in pt-BR and English.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { needsYouKey } from "@/lib/needs-you";
import { boardSummary, DEFAULT_FILTERS, matchesFilters, OPEN_NEEDS_YOU_EVENT, openNeedsYou, reasonText, stageAge, visibleCards, type BoardFilters } from "@/lib/pipeline-board";
import { buildPipelineBoard } from "../../server/pipeline-board";
import { boardInputs, CHIEF, CLIENT_NAMES, MONITOR, NOW } from "../../server/testing/pipeline-board-fixture";
import type { BoardStage, PipelineBoard } from "../../shared/pipeline-board";
import { BoardView } from "./PipelineBoardPage";

const board = buildPipelineBoard(boardInputs());
const actions = { onOpenLink: () => {}, onOpenThread: () => {}, onOpenNeedsYou: () => {} };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/ /g, " ").replace(/\s+/g, " ");

function render(value: PipelineBoard, options: { locale?: string; filters?: BoardFilters; narrow?: boolean; tab?: BoardStage } = {}) {
  setLocale(options.locale ?? "pt-br");
  const html = renderToStaticMarkup(createElement(BoardView, {
    board: value, now: NOW, filters: options.filters ?? DEFAULT_FILTERS, onFilters: () => {}, actions,
    narrow: options.narrow ?? false, tab: options.tab ?? "entry", onTab: () => {},
  }));
  setLocale("en");
  return html;
}

afterEach(() => setLocale("en"));

describe("the board screen (pt-BR)", () => {
  const html = render(board);
  const plain = text(html);

  it("shows the six stages in order, on the map and as columns, with their counts", () => {
    expect([...html.matchAll(/data-stage="(\w+)"/g)].map((match) => match[1])).toEqual(["entry", "session", "pr", "gate", "release", "production"]);
    for (const [name, hint] of [["Entrada", "issue ou linha da planilha"], ["Sessão", "sessão do Claude Code"], ["PR aberta", "esperando o gate"], ["Gate", "ci:local e recibo"], ["Release", "mergeada, a caminho"], ["Produção", "últimos 7 dias"]]) {
      expect(plain).toContain(name);
      expect(plain).toContain(hint);
    }
    expect(html).toContain('aria-label="Etapas da esteira"');
  });

  it("puts what waits on the person, what is stuck and what is blocked above the columns", () => {
    expect(plain).toContain("Esperando você: 2");
    expect(plain).toContain("Parados além do limite: 3");
    expect(plain).toContain("Bloqueados: 1");
    expect(plain).toContain("Em produção (7 dias): 2");
    expect(plain).toContain("Release de produção 3c04d7c3d a caminho neste Mac");
  });

  it("says each card's state and why, from the data: BEHIND, the running release, the stopped session", () => {
    expect(plain).toContain("Bloqueado — BEHIND: atrás da main — atualizar a branch e rodar o gate de novo");
    expect(plain).toContain("Rodando — no release 3c04d7c3d, em curso");
    expect(plain).toContain("Aguardando — a sessão parou: o último turno terminou e nada a retomou");
    expect(plain).toContain("Gate: sem status");
    expect(plain).toContain("recibo de outro commit");
    expect(plain).toContain("pela hora do release (o conteúdo ainda não foi conferido)");
  });

  it("flags the stuck with how long and the limit; the time in the stage is on every card", () => {
    expect(plain).toContain("Parado há 2,3 d (limite 8 h)");
    expect(plain).toContain("Parado há 34 h (limite 8 h)");
    expect(html.match(/data-stale=""/g)).toHaveLength(3);
    expect(plain).toContain("20 min nesta etapa");
  });

  it("puts the person's items in evidence, first in their column, with the way to them", () => {
    expect(html.match(/data-state="owner"/g)).toHaveLength(2);
    expect(html.indexOf('data-card="issue:9355"')).toBeLessThan(html.indexOf('data-card="issue:9354"'));
    expect(html.match(/aria-label="Abrir este item em Precisa de você"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Abrir a PR #9332 no GitHub"');
    expect(html).toContain('aria-label="Abrir a issue #9052 no GitHub"');
    expect(html).toContain('aria-label="Abrir a conversa do bot"');
  });

  it("names who carries each card, or '—' when nobody does", () => {
    expect(plain).toContain("Chief of Staff");
    expect(plain).toContain("Monitor Chat Atendimento");
    expect(plain).toContain("sessão rodando");
    const prCard = html.slice(html.indexOf('data-card="pr:9368"'), html.indexOf("</article>", html.indexOf('data-card="pr:9368"')));
    expect(text(prCard)).toContain("Responsável —");
  });

  it("never shows a requester's or a client's name", () => {
    for (const name of CLIENT_NAMES) expect(plain).not.toContain(name);
  });
});

describe("unknown is '—', never zero", () => {
  it("columns whose source was never read say so, with no count", () => {
    const html = render(buildPipelineBoard(boardInputs({ github: null, live: null })));
    const plain = text(html);
    expect(plain).toContain("Sem dados: o GitHub ainda não foi lido");
    expect(plain).toContain("Produção: —");
    expect(plain).not.toContain("Em produção (7 dias): 0");
    expect(html).toContain('aria-label="desconhecido"');
  });

  it("a card whose time in the stage is unknown shows '—'", () => {
    expect(stageAge({ since: null }, NOW)).toBe("—");
    expect(stageAge({ since: NOW - 3 * 3_600_000 }, NOW)).toBe("3 h");
  });
});

describe("filters", () => {
  const cards = board.columns.flatMap((column) => column.cards);
  const keys = (filters: Partial<BoardFilters>) => cards.filter((card) => matchesFilters(card, { ...DEFAULT_FILTERS, ...filters }, NOW)).map((card) => card.key).sort();

  it("by bot, by none, by priority, by origin, by focus", () => {
    expect(keys({ bot: MONITOR })).toEqual(["issue:9355"]);
    expect(keys({ bot: "none" })).toEqual(["issue:9354", "issue:9365", "pr:9368"]);
    expect(keys({ bot: CHIEF })).toHaveLength(5);
    expect(keys({ priority: "p0" })).toEqual([]);
    expect(keys({ priority: "p1" })).toEqual(["issue:9052", "issue:9058", "issue:9195", "issue:9334", "issue:9354"]);
    expect(keys({ origin: "client" })).toEqual(["issue:8204", "issue:9195", "issue:9334", "issue:9355", "issue:9365"]);
    expect(keys({ focus: "owner" })).toEqual(["issue:9334", "issue:9355"]);
    expect(keys({ focus: "stale" })).toEqual(["issue:9058", "issue:9354", "pr:9368"]);
  });

  it("a filtered column says how many of how many, and why it is empty", () => {
    const plain = text(render(board, { filters: { ...DEFAULT_FILTERS, origin: "client" } }));
    expect(plain).toContain("Entrada 2 de 3");
    expect(plain).toContain("Nada aqui com estes filtros");
    expect(plain).toContain("Limpar filtros");
  });

  it("puts the person's items, then the stuck, first in a column", () => {
    const entry = board.columns.find((column) => column.stage === "entry")!;
    expect(visibleCards(entry.cards, DEFAULT_FILTERS, NOW, "entry").map((card) => card.key)).toEqual(["issue:9355", "issue:9354", "issue:9365"]);
  });

  it("counts the summary over the whole board", () => {
    expect(boardSummary(board, NOW)).toEqual({ owner: 2, stale: 3, blocked: 1, production: 2 });
  });
});

describe("a card's way to 'Precisa de você'", () => {
  it("names the item by the key the sidebar's resolution screen opens on", () => {
    const target = new EventTarget();
    const seen: unknown[] = [];
    target.addEventListener(OPEN_NEEDS_YOU_EVENT, (event) => seen.push((event as CustomEvent).detail));
    vi.stubGlobal("window", target);
    try {
      openNeedsYou({ botId: MONITOR, threadId: "b5306bef", pendingId: "o14" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toEqual([{ key: needsYouKey({ botId: MONITOR, threadId: "b5306bef", pendingId: "o14" }) }]);
  });
});

describe("on a phone, the columns are tabs", () => {
  const html = render(board, { narrow: true, tab: "gate" });

  it("one tab list of six, one panel, labelled by its tab", () => {
    expect(html.match(/role="tab"/g)).toHaveLength(6);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(1);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    const selected = /<button[^>]*role="tab"[^>]*id="([^"]+)"[^>]*aria-selected="true"[^>]*aria-controls="([^"]+)"/.exec(html)!;
    expect(html).toContain(`id="${selected[2]}" role="tabpanel" aria-labelledby="${selected[1]}"`);
    expect(text(html)).toContain("Atendimento: criar configuração de tempo de reabertura do atendimento");
    expect(text(html)).not.toContain("Chats distribuídos mesmo com agentes offline");
  });

  it("folds the filters away", () => {
    expect(text(html)).toContain("Filtros (0)");
  });
});

describe("in English", () => {
  it("says the same in the reader's language, the session's error included", () => {
    const plain = text(render(board, { locale: "en" }));
    expect(plain).toContain("Waiting on you: 2");
    expect(plain).toContain("Blocked — BEHIND: behind main — update the branch and run the gate again");
    expect(plain).toContain("Stuck for 34 h (limit 8 h)");
    setLocale("pt-br");
    expect(reasonText({ code: "session-failed", detail: "the turn ran past 45 minutes and was stopped" }, "pt-BR")).toBe("a sessão falhou: o turno passou de 45 minutos e foi parado");
    setLocale("en");
    expect(reasonText({ code: "session-failed", detail: "the turn ran past 45 minutes and was stopped" }, "en")).toBe("the session failed: the turn ran past 45 minutes and was stopped");
    expect(reasonText({ code: "release-failed", detail: "Local CI failed at script-contracts", count: 2 }, "en")).toBe("the release is failing (2×): Local CI failed at script-contracts");
  });
});
