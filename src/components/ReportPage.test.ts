// The "Relatório" screen (lot V), rendered from a report the real server code
// builds over the shared fixture: the period in the title, the summary, the
// board's KPI cards with their comparison (one rule, the exports' rule), the
// definition beside each and a target light only when set, DORA and cost per
// delivery, charts with their description and data table, the releases with
// what they carried (superseded and aborted apart), backlog, bots, coverage —
// in pt-BR and English.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { formatSpan, formatTrend, reportPath } from "@/lib/productivity";
import { buildProductivityReport } from "../../server/productivity-report";
import { executiveSummary } from "../../server/productivity-export";
import { brt, CLIENT_NAME, scenario } from "../../server/testing/productivity-fixture";
import { compareKpi, type ProductivityReport, type ReportGoals } from "../../shared/productivity";
import { DeltaLine, ExportMenu, KpiCard, ReleasesTable, ReportView } from "./ReportPage";
import { niceScale } from "./ReportCharts";

function report(period = { from: brt("2026-09-28T00:00:00"), to: brt("2026-10-03T00:00:00") }, goals: ReportGoals = {}): ProductivityReport {
  const built = buildProductivityReport({ ...scenario(), goals, granularity: "day", period });
  return { ...built, enabled: true, summary: { "pt-BR": executiveSummary(built, "pt-BR"), en: executiveSummary(built, "en") } };
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/\s+/g, " ");

const render = (value: ProductivityReport, locale: "pt-BR" | "en" = "pt-BR") => {
  setLocale(locale);
  const html = renderToStaticMarkup(createElement(ReportView, { report: value }));
  setLocale("en");
  return html;
};

afterEach(() => setLocale("en"));

describe("report screen (pt-BR)", () => {
  const html = render(report());
  const plain = text(html);

  it("names the period in the title and opens with the six-line summary", () => {
    expect(plain).toContain("Produtividade de engenharia — 28/09 a 02/10/2026");
    expect(plain).toContain("Resumo executivo");
    expect(html.match(/<ol[^>]*>[\s\S]*?<\/ol>/)![0].match(/<li>/g)).toHaveLength(6);
    expect(plain).toContain("Produção: ≥3 entregas (sem base comparável), 0,9 por dia útil com dados (3,5 dias úteis), com ≥4 PRs e ≥2 issues concluídas no ar");
  });

  it("says where no release source exists, as unknown — not zero", () => {
    expect(html).toContain('role="note"');
    // said once, above the cards; each production card only points at it (R13-visual N17)
    expect(plain.split("a fonte de releases não cobre os dois períodos")).toHaveLength(2);
    expect(plain).toContain("Os cartões de produção não trazem comparação com o período anterior: a fonte de releases não cobre os dois períodos.");
    expect(plain).toContain("Sem comparação (veja o aviso acima)");
  });

  it("speaks to the board: no release carriers nor label names (R13-visual N17)", () => {
    // the definitions keep the labels they define (chore/release-carrier-*, priority:p0…p3); the numbers never show them
    expect(plain).not.toMatch(/carriers? de release|carrier #|priority:p1 \+|\(escala antiga\) ·|P1 = p1/);
    expect(plain).toContain("PRs de publicação, à parte: 1");
  });

  it("shows the board's eight KPIs, each with its definition beside it and behind its button", () => {
    for (const label of ["Entregas em produção", "Frequência de deploy", "Sucesso de release", "Lead time issue → produção", "PRs mergeadas", "Issues resolvidas", "Issues P0/P1 abertas", "Pipeline de release parado (produção no ar)"]) {
      expect(plain).toContain(label);
      expect(html).toContain(`aria-label="O que “${label}” conta"`);
    }
    expect(plain).not.toContain("Produção travada");
    // the short definition is on the card, not only in the tooltip
    expect(plain).toContain("avanços da tag de produção (fim do deploy)");
    expect(plain).toContain("DORA: entregas por dia útil com fonte de releases");
    expect(plain).toContain("1ª falha que rodou após um sucesso até o próximo sucesso");
    expect(html).toMatch(/role="tooltip" id="[^"]+"[^>]*>Avanços da tag nuria-production-deployed/);
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${describedBy}"`);
  });

  it("marks lower bounds and counts success over runs that ran, superseded and aborted apart (INSP-V r1 #1, #4)", () => {
    // labels before numbers: no "1 releases" whatever the count (INSP-V r2 #4)
    expect(plain).toContain("no ar: PRs ≥4, issues concluídas ≥2 · releases sem conteúdo lido: 1");
    expect(plain).toContain("60%");
    expect(plain).toContain("3 de 5 que rodaram · não contam como falha: trocados por um commit mais novo 1, abortados antes de rodar 1, recusados 1");
    expect(plain).toContain("produção no ar · 0 min em fim de semana");
  });

  it("shows P1 as p1 + high with the split, in words (INSP-V r1 #5, R13-visual N17)", () => {
    expect(plain).toContain("P1 1 (1 com o rótulo novo, 0 com o antigo) · P0 1");
  });

  it("compares by one rule: no trend on a small base, the previous value instead (INSP-V r1 #7)", () => {
    expect(plain).toContain("Período anterior: 0 (base pequena demais para tendência)");
    expect(plain).not.toMatch(/vs\. período anterior/);
  });

  it("has a DORA section and the bots' cost per delivery over the recorded days (INSP-V r1 #6)", () => {
    expect(plain).toContain("DORA");
    expect(plain).toContain("Taxa de falha de mudança");
    expect(plain).toContain("50% (1 de 2 releases verificados)");
    expect(plain).toContain("Tempo de restauração");
    // 3 deliveries and no engineering cost: no ratio, the reason instead; the cost split by role (INSP-V r2 #4)
    expect(plain).toContain("Custo dos bots de engenharia por entrega");
    expect(plain).toContain("— (nenhum custo de bot de engenharia registrado)");
    expect(plain).toMatch(/US\$\s?0,75 em 4,5 dias registrados: engenharia US\$\s?0,00, operação \(Monitor Chat, Chief of Staff\) US\$\s?0,75/);
  });

  it("counts deliveries and their frequency only where a release source exists, with one decimal like the exports (INSP-V r2 #1, #6)", () => {
    expect(plain).toContain("≥3");
    expect(plain).toContain("0,9/dia útil");
    expect(plain).toContain("3 em 3,5 dias úteis com dados (de 4,5)");
    expect(plain).toContain("fonte de releases em 3,5 de 4,5 dias úteis");
    expect(plain).toContain("0,9 por dia útil (3 em 3,5 dias úteis com dados, de 4,5)");
  });

  it("draws four charts, each with a description and its numbers as a table", () => {
    expect(html.match(/<figure/g)).toHaveLength(4);
    expect(html.match(/role="img"/g)).toHaveLength(4);
    expect(plain).toContain("Entregas e falhas");
    expect(plain).toContain("Entregas: 3 no período, o máximo em");
    expect(plain).toContain("Sem fonte (desconhecido, não zero)");
    expect(html.match(/Ver os números/g)).toHaveLength(4);
    expect(html).toContain("<caption");
  });

  it("lists the releases with what they carried; superseded and aborted runs are not failures (INSP-V r1 #1, #4, #8)", () => {
    expect(plain).toContain("Releases do período");
    // the same counts as the exports: commits for failures, runs for what never ran (INSP-V r2 #6)
    expect(plain).toContain("em produção: 3 · commits que falharam: 1 (tentativas que rodaram: 2) · runs substituídos: 1 · runs abortados: 1 · recusados: 1");
    expect(plain).toContain("Substituído");
    expect(plain).toContain("Abortado");
    expect(plain).toContain("2 tentativas");
    expect(plain).toContain("Recusado");
    // the head PR of a failed run is a PR, called carrier only when it is one
    expect(plain).toContain("PR #6");
    expect(plain).not.toContain("carrier #6");
    expect(plain).toContain("Conteúdo desconhecido (primeiro release conhecido)");
    expect(plain).not.toContain("sem release anterior para comparar");
  });

  it("shows the backlog now, the PRs waiting for the gate and the bots' effort", () => {
    expect(plain).toContain("Backlog agora");
    expect(plain).toContain("#104 · 22 d");
    expect(plain).toContain("PRs esperando o gate: 1 (de 3 abertas)");
    expect(plain).toContain("Esforço dos bots");
    expect(plain).toContain("Chief of Staff");
  });

  it("explains how each number is counted and where the data comes from", () => {
    expect(plain).toContain("Como é contado");
    expect(plain).toContain("De onde vêm os dados");
  });

  it("offers board targets, empty by default, and lights no card without one", () => {
    expect(plain).toContain("Metas do board");
    expect(plain).not.toMatch(/(na meta|perto da meta|fora da meta) ·/);
  });

  it("keeps the releases' rows to numbers; titles wait behind each row's details", () => {
    const releases = html.slice(html.indexOf('id="report-releases"'), html.indexOf('id="report-backlog"'));
    expect(releases).toContain("#102");
    expect(releases).not.toContain(CLIENT_NAME);
    expect(releases).toContain('aria-expanded="false"');
  });
});

describe("targets", () => {
  it("light a card with its word and its target, only where a target is set", () => {
    const plain = text(render(report(undefined, { deploysPerBusinessDay: 1, releaseSuccessRate: 70, leadTimeHours: 48, changeFailureRate: 20 })));
    expect(plain).toContain("perto da meta · ≥ 1/dia útil");
    expect(plain).toContain("perto da meta · ≥ 70%");
    expect(plain).toContain("na meta · ≤ 48 h");
    expect(plain).toContain("fora da meta · ≤ 20%");
  });
});

describe("a closed month and the time before the bots' ledger", () => {
  it("titles a whole month by name and shows the bots' days without a ledger as —, not 0 (INSP-V r1 #6)", () => {
    const september = report({ from: brt("2026-09-01T00:00:00"), to: brt("2026-10-01T00:00:00") });
    const plain = text(render(september));
    expect(plain).toContain("Produtividade de engenharia — setembro/2026");
    // P0/P1 at the end of September against the end of August; today apart, labelled (INSP-V r2 #2)
    expect(plain).toContain("ao fim do período · agora 2: P1 1 (1 com o rótulo novo, 0 com o antigo) · P0 1");
    // the backlog of the closed month, then today's (INSP-V r2 #7)
    expect(plain).toContain("Backlog ao fim do período (30/09/2026)");
    expect(plain).toContain("P0/P1 abertas (rótulos de hoje)");
    expect(plain.indexOf("Backlog ao fim do período")).toBeLessThan(plain.indexOf("Backlog agora"));
    const bots = september.buckets.filter((bucket) => bucket.turns === null);
    expect(bots.length).toBeGreaterThan(0);
  });
});

describe("report screen (English)", () => {
  it("speaks the reader's language", () => {
    const plain = text(render(report(), "en"));
    expect(plain).toContain("Engineering productivity — 2026-09-28 to 2026-10-02");
    expect(plain).toContain("Executive summary");
    expect(plain).toContain("Production: ≥3 deliveries (no comparable base)");
    expect(plain).toContain("Release pipeline stopped (production up)");
    expect(plain).toContain("Releases in the period");
  });
});

describe("pieces", () => {
  it("a KPI's trend says better or worse in words, not only in colour", () => {
    const card = (comparison: ReturnType<typeof compareKpi>, polarity: "up" | "down") =>
      renderToStaticMarkup(createElement(KpiCard, { label: "Entregas", value: "8", definition: "d", short: "s", comparison, polarity }));
    const good = card(compareKpi(8, 5), "up");
    expect(good).toContain("text-success");
    expect(text(good)).toContain("+3, +60% vs previous period");
    expect(text(good)).toContain("(better)");
    const bad = card(compareKpi(8, 5), "down");
    expect(bad).toContain("text-danger");
    expect(text(bad)).toContain("(worse)");
    expect(text(card(compareKpi(6, 6), "up"))).toContain("Same as the previous period");
  });

  it("never draws a trend on a small base or before the repository (INSP-V r1 #7)", () => {
    const line = (comparison: ReturnType<typeof compareKpi>) => text(renderToStaticMarkup(createElement(DeltaLine, { comparison, polarity: "up" })));
    expect(line(compareKpi(2868, 2))).toContain("Previous period: 2");
    expect(line(compareKpi(2868, 0, { beforeRepo: true }))).toContain("before the repository existed");
    // why is said once above the cards (R13-visual N17)
    expect(line(compareKpi(27, 2, { comparable: false }))).toContain("Not compared (see the note above)");
  });

  it("will not hand a stale report to the board: the menu says why and offers \"Atualizar e exportar\" (INSP-V r2 #3)", () => {
    const fresh = report();
    const now = Date.now();
    const at = (lastSyncAt: number, matchesHistory: boolean | null = true) => ({ ...fresh, sync: { ...fresh.sync, lastSyncAt }, coverage: { ...fresh.coverage, github: { ...fresh.coverage.github, syncedAt: lastSyncAt }, tag: { ...fresh.coverage.tag, matchesHistory } } });
    setLocale("pt-BR");
    const ready = text(renderToStaticMarkup(createElement(ExportMenu, { query: { granularity: "day", count: 30 }, report: at(now - 60_000), disabled: false, onRefreshAndExport: () => undefined })));
    const stale = renderToStaticMarkup(createElement(ExportMenu, { query: { granularity: "day", count: 30 }, report: at(now - 16 * 3_600_000, false), disabled: false, onRefreshAndExport: () => undefined }));
    setLocale("en");
    expect(ready).not.toContain("Atualizar e exportar");
    expect(text(stale)).toContain("Ainda não está pronto para o board");
    expect(text(stale)).toContain("Os dados do GitHub têm 16 h (o limite é 1 h).");
    expect(text(stale)).toContain("A tag de produção no GitHub não é o último release do histórico.");
    expect(text(stale)).toContain("Atualizar e exportar PDF");
    // exporting anyway is explicit, and the export then carries the warning
    expect(stale).toContain("force=1");
  });

  it("folds a commit's superseded and aborted runs into its failure row (INSP-V r2 #7)", () => {
    const row = { sha: "9".repeat(40), at: 1, timeSource: "log" as const, outcome: "failed" as const, attempts: 2, supersededRuns: 1, abortedRuns: 0, prs: [], issues: [] };
    const plain = text(renderToStaticMarkup(createElement(ReleasesTable, { releases: [row] })));
    // only the counts that exist: no "aborted runs 0" (INSP-V r3 #5)
    expect(plain).toContain("same commit: superseded runs 1");
    expect(plain).not.toContain("aborted runs 0");
    expect(plain).toContain("failed commits: 1 (tries that ran: 2) · runs superseded: 1 · runs aborted: 0");
  });

  it("a long list of releases shows 15 and offers the rest", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ sha: `${index}`.padStart(40, "a"), at: index, timeSource: "log" as const, outcome: "released" as const, prs: [], issues: [] }));
    const html = renderToStaticMarkup(createElement(ReleasesTable, { releases: many }));
    expect(html.match(/<tr class="border-t/g)).toHaveLength(15);
    expect(text(html)).toContain("Show all 20");
  });

  it("builds the requests and formats trends", () => {
    expect(reportPath({ granularity: "day", count: 90 })).toBe("/api/reports/productivity?granularity=day&count=90");
    expect(reportPath({ granularity: "month", from: "2026-01", to: "2026-09" }, { format: "pdf" })).toBe("/api/reports/productivity.pdf?granularity=month&from=2026-01&to=2026-09");
    expect(reportPath({ granularity: "hour", count: 48 }, { refresh: true })).toBe("/api/reports/productivity?granularity=hour&count=48&refresh=1");
    expect(formatTrend(compareKpi(1, 6), "count")).toBe("−5, −83%");
    expect(formatTrend(compareKpi(0.9, 0.8, { samples: { current: 10, previous: 10 } }), "rate")).toBe("+10 p.p.");
    expect(formatTrend(compareKpi(2, 1), "count")).toBeNull();
    expect(formatSpan(0)).toBe("0 min");
    expect(formatSpan(90 * 60_000)).toBe("1.5 h");
    expect(niceScale(0)).toEqual({ ceiling: 1, step: 1 });
    expect(niceScale(3)).toEqual({ ceiling: 3, step: 1 });
    expect(niceScale(37)).toEqual({ ceiling: 40, step: 10 });
    expect(niceScale(223)).toEqual({ ceiling: 250, step: 50 });
    expect(niceScale(5)).toEqual({ ceiling: 5, step: 1 });
    expect(niceScale(13)).toEqual({ ceiling: 15, step: 5 });
  });
});
