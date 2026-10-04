// The "Esteira" screen (lot Z), rendered from the board the real builder
// makes over the real pipeline of 03–04/10: the six columns in order with
// their counts, each card's state and reason in words, the stuck ones said
// with their limit, what waits on the person in evidence with its way to
// "Precisa de você", unknown as "—", the filters, the limits, Entrada's fold
// (never a client's or a new demand), and the phone's tabs — in pt-BR and English.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { needsYouKey } from "@/lib/needs-you";
import { boardSummary, DEFAULT_FILTERS, ENTRY_FOLD, foldEntry, matchesFilters, OPEN_NEEDS_YOU_EVENT, openNeedsYou, reasonText, stageAge, visibleCards, type BoardFilters } from "@/lib/pipeline-board";
import { buildPipelineBoard } from "../../server/pipeline-board";
import { boardInputs, boardInputsWithBacklog, CHIEF, CLIENT_NAMES, MONITOR, NOW } from "../../server/testing/pipeline-board-fixture";
import type { BoardStage, PipelineBoard } from "../../shared/pipeline-board";
import { BoardView, foldedText, LimitsBar } from "./PipelineBoardPage";

const board = buildPipelineBoard(boardInputs());
const actions = { onOpenLink: () => {}, onOpenThread: () => {}, onOpenNeedsYou: () => {} };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&gt;/g, ">").replace(/ /g, " ").replace(/\s+/g, " ");

function render(value: PipelineBoard, options: { locale?: string; filters?: BoardFilters; narrow?: boolean; compact?: boolean; tab?: BoardStage } = {}) {
  setLocale(options.locale ?? "pt-br");
  const html = renderToStaticMarkup(createElement(BoardView, {
    board: value, now: NOW, filters: options.filters ?? DEFAULT_FILTERS, onFilters: () => {}, actions,
    narrow: options.narrow ?? false, compact: options.compact ?? false, tab: options.tab ?? "entry", onTab: () => {}, onSaveLimits: async () => {},
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

  it("separates what is stuck in the pipeline from the Entrada backlog past its limit; blocked, cycles to close, production", () => {
    expect(plain).toContain("Esperando você: 2");
    expect(plain).toContain("Parados na esteira: 2");
    expect(plain).toContain("Entrada além do limite: 3");
    expect(plain).toContain("Bloqueados: 1");
    // six shipped whole with "Refs" (validate and close) and two sessions archived without a PR; #9071's phase is not one
    expect(plain).toContain("Ciclos a fechar: 8");
    expect(plain).toContain("Em produção (7 dias): 5");
    expect(plain).toContain("Release de produção 3c04d7c3d a caminho neste Mac");
  });

  it("says each card's state and why, in Portuguese, from the data", () => {
    expect(plain).toContain("Bloqueado — atrás da main — atualizar a branch e rodar o gate de novo");
    expect(plain).not.toContain("BEHIND");
    expect(plain).toContain("Rodando — no release 3c04d7c3d, em curso");
    expect(plain).toContain("Aguardando — a sessão parou: o último turno terminou e nada a retomou");
    // the repository's convention (INSP-Z r3): a whole fix ships with "Refs" and the issue waits for validation
    expect(plain).toContain("Aguardando — entregue em 22/09, aguardando validação e fechamento");
    // only a PR that says it is a phase is a partial delivery (#9071's "Fase 0")
    expect(plain).toContain("Aguardando — entrega parcial: uma fase da issue entrou em produção em 22/09, o resto ainda falta");
    // in Produção with the issue open: validate and close (Refs: #9284, #9334, #9197); close (Fecha: #9185)
    expect(plain.match(/Validar e fechar avisar o solicitante/g)).toHaveLength(3);
    expect(plain).toContain("Issue ainda aberta fechar e avisar o solicitante");
    expect(plain).toContain("Aguardando — a sessão foi arquivada sem PR — reabrir ou fechar a issue");
    expect(plain).not.toMatch(/ainda sem sessão[^#]*sessão arquivada/);
    expect(plain).toContain("Gate: sem status");
    expect(plain).toContain("recibo de outro commit");
    expect(plain).toContain("pela hora do release (o conteúdo ainda não foi conferido)");
    expect(plain).toContain("Fechar o ciclo");
  });

  it("flags the stuck with how long and the limit; the time in the stage is on every card", () => {
    expect(plain).toContain("Parado há 2,3 d (limite 24 h)");
    expect(plain).toContain("Parado há 11 d (limite 7 d)");
    expect(html.match(/data-stale=""/g)).toHaveLength(5);
    expect(plain).toContain("2,4 d nesta etapa");
  });

  it("shows the limits the cards are measured against, editable", () => {
    expect(plain).toContain("Limites Entrada (P0/P1, cliente) 7 d Entrada (demais) 30 d Sessão 24 h PR 24 h Gate 24 h Release 4 h Editar");
    expect(plain).toContain("Salvar limites");
    expect(html.match(/type="number"/g)).toHaveLength(6);
  });

  it("three lines of title on the card, and a button that opens the whole by touch and keyboard (INSP-Z r2 Z2-1)", () => {
    // the real long titles of #9368 and #9308
    expect(html).toContain('title="Fila sem estouro atrás de release, máquina devolvida na fase de rede, release mais curto (lote W)"');
    expect(html).toMatch(/line-clamp-3" title="Fila sem estouro/);
    const card9368 = html.slice(html.indexOf('data-card="pr:9368"'), html.indexOf("</article>", html.indexOf('data-card="pr:9368"')));
    const button = /<button[^>]*aria-expanded="false"[^>]*aria-controls="([^"]+)"[^>]*>Ver título inteiro<\/button>/.exec(card9368);
    expect(button).not.toBeNull();
    expect(card9368).toContain(`<h3 id="${button![1]}"`);
    // a short title has no button
    const card9058 = html.slice(html.indexOf('data-card="issue:9058"'), html.indexOf("</article>", html.indexOf('data-card="issue:9058"')));
    expect(card9058).not.toContain("Ver título inteiro");
  });

  it("puts the person's items in evidence, first in their column, with the way to them", () => {
    expect(html.match(/data-state="owner"/g)).toHaveLength(2);
    expect(html.indexOf('data-card="issue:9355"')).toBeLessThan(html.indexOf('data-card="issue:9365"'));
    expect(html.match(/aria-label="Abrir este item em Precisa de você"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Abrir a PR #9332 no GitHub"');
    expect(html).toContain('aria-label="Abrir a issue #9052 no GitHub"');
    expect(html).toContain('aria-label="Abrir a conversa do bot"');
    expect(html).toContain('aria-label="Abrir a sessão no app Claude"');
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

describe("Entrada's fold (INSP-Z r1 Z-1)", () => {
  const full = buildPipelineBoard(boardInputsWithBacklog());
  const entry = full.columns.find((column) => column.stage === "entry")!.cards;

  it("folds only the old internal backlog: the new clients' demands are in sight", () => {
    const { shown, folded } = foldEntry(entry, NOW, ENTRY_FOLD);
    expect(shown.length + folded.length).toBe(entry.length);
    const visible = shown.map((card) => card.key);
    for (const key of ["issue:9365", "issue:9364", "issue:9358", "issue:9352", "issue:9337", "issue:9363"]) expect(visible).toContain(key);
    expect(folded.length).toBeGreaterThan(0);
    for (const card of folded) {
      expect(card.origin).toBe("internal");
      expect(card.closeout).toBe(false);
      expect(["p0", "p1"]).not.toContain(card.priority);
      expect(NOW - (card.since ?? 0)).toBeGreaterThan(7 * 24 * 3_600_000);
    }
    expect(folded.map((card) => card.key)).toContain("issue:7111");
  });

  it("says what the fold holds, and the summary counts every card", () => {
    const plain = text(render(full));
    // what it holds, as it is (INSP-Z r2 Z2-4): here P2/P3 and unprioritized
    expect(plain).toMatch(/Mostrar mais \d+ issues antigas, internas, P2\/P3 ou sem prioridade/);
    setLocale("pt-br");
    const p2 = foldedText(entry.filter((card) => card.priority === "p2" || card.priority === "p3"));
    const none = foldedText(entry.filter((card) => card.priority === null && card.origin === "internal"));
    setLocale("en");
    expect(p2).toMatch(/^Mostrar mais \d+ issues antigas, internas, P2\/P3$/);
    expect(none).toMatch(/^Mostrar mais \d+ issues antigas, internas, sem prioridade$/);
    expect(boardSummary(full, NOW).entryStale).toBe(full.columns[0]!.cards.filter((card) => card.since !== null && card.limitMs !== null && NOW - card.since > card.limitMs).length);
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
    expect(keys({ bot: "none" })).toEqual(["issue:8829", "issue:8883", "issue:8958", "issue:8961", "issue:9071", "issue:9074", "issue:9172", "issue:9185", "issue:9197", "issue:9284", "issue:9337", "issue:9352", "issue:9354", "issue:9358", "issue:9364", "issue:9365", "pr:9368"]);
    expect(keys({ bot: CHIEF })).toEqual(["issue:8204", "issue:9052", "issue:9058", "issue:9195", "issue:9305", "issue:9308", "issue:9334"]);
    expect(keys({ priority: "p0" })).toEqual([]);
    expect(keys({ priority: "p1" })).toEqual(["issue:8883", "issue:8958", "issue:9052", "issue:9058", "issue:9074", "issue:9185", "issue:9195", "issue:9284", "issue:9334", "issue:9354"]);
    expect(keys({ origin: "client" })).toEqual(["issue:8204", "issue:9195", "issue:9284", "issue:9305", "issue:9308", "issue:9334", "issue:9337", "issue:9352", "issue:9355", "issue:9358", "issue:9364", "issue:9365"]);
    expect(keys({ focus: "owner" })).toEqual(["issue:9334", "issue:9355"]);
    expect(keys({ focus: "stale" })).toEqual(["issue:9052", "issue:9058"]);
    expect(keys({ focus: "entryStale" })).toEqual(["issue:8883", "issue:8958", "issue:9074"]);
    expect(keys({ focus: "closeout" })).toEqual(["issue:8829", "issue:8883", "issue:8958", "issue:8961", "issue:9074", "issue:9172", "issue:9305", "issue:9308"]);
  });

  it("a filtered column says how many of how many, and why it is empty", () => {
    const plain = text(render(board, { filters: { ...DEFAULT_FILTERS, origin: "client" } }));
    expect(plain).toContain("Entrada 8 de 16");
    expect(plain).toContain("Nada aqui com estes filtros");
    expect(plain).toContain("Limpar filtros");
  });

  it("Entrada keeps the board's order; the other columns put the person's items, then the stuck, first", () => {
    const entry = board.columns.find((column) => column.stage === "entry")!;
    expect(visibleCards(entry.cards, DEFAULT_FILTERS, NOW, "entry").map((card) => card.key)).toEqual(entry.cards.map((card) => card.key));
  });

  it("counts the summary over the whole board; blocked includes a blocked card the owner's item also holds", () => {
    expect(boardSummary(board, NOW)).toEqual({ owner: 2, stale: 2, entryStale: 3, blocked: 1, closeout: 8, production: 5 });
    const both = buildPipelineBoard(boardInputs({ ownerPending: [...boardInputs().ownerPending, { id: "o4", botId: CHIEF, threadId: "t4", title: "Decidir a PR #9332", createdAt: NOW - 3_600_000 }] }));
    expect(boardSummary(both, NOW)).toMatchObject({ owner: 3, blocked: 1 });
  });
});

describe("the limits line", () => {
  it("reads the owner's limits in days and hours", () => {
    setLocale("pt-br");
    const html = renderToStaticMarkup(createElement(LimitsBar, { limits: { entryUrgentH: 48, entryOtherH: 720, sessionH: 6, prH: 24, gateH: 30, releaseH: 4 } }));
    setLocale("en");
    expect(text(html)).toContain("Limites Entrada (P0/P1, cliente) 2 d Entrada (demais) 30 d Sessão 6 h PR 24 h Gate 30 h Release 4 h");
    // read-only without a way to save
    expect(html).not.toContain("Editar");
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

describe("on a phone, the columns are tabs; on a narrow window, filters and limits fold", () => {
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

  it("folds the filters and the limits away", () => {
    expect(text(html)).toContain("Filtros (0)");
    const compact = render(board, { compact: true });
    expect(compact.indexOf("Filtros (0)")).toBeGreaterThan(-1);
    expect(compact.indexOf("Filtros (0)")).toBeLessThan(compact.indexOf("Limites"));
  });
});

describe("in English", () => {
  it("says the same in the reader's language, the session's error included", () => {
    const plain = text(render(board, { locale: "en" }));
    expect(plain).toContain("Waiting on you: 2");
    expect(plain).toContain("Stuck in the pipeline: 2");
    expect(plain).toContain("Intake past its limit: 3");
    expect(plain).toContain("Blocked — behind main — update the branch and run the gate again");
    expect(plain).toContain("Stuck for 11 d (limit 7 d)");
    expect(plain).toContain("delivered on 22/09, awaiting validation and closing");
    expect(plain).toContain("partial delivery: a phase of the issue shipped on 22/09, the rest is still to do");
    expect(plain).toContain("Validate and close tell the requester");
    expect(plain).toContain("Issue still open close it and tell the requester");
    setLocale("pt-br");
    expect(reasonText({ code: "session-failed", detail: "the turn ran past 45 minutes and was stopped" }, "pt-BR")).toBe("a sessão falhou: o turno passou de 45 minutos e foi parado");
    setLocale("en");
    expect(reasonText({ code: "session-failed", detail: "the turn ran past 45 minutes and was stopped" }, "en")).toBe("the session failed: the turn ran past 45 minutes and was stopped");
    expect(reasonText({ code: "release-failed", detail: "Local CI failed at script-contracts", count: 2 }, "en")).toBe("the release is failing (2×): Local CI failed at script-contracts");
  });
});
