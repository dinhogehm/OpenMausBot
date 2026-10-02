// The "Relatório" screen (lot V), rendered from a report the real server code
// builds over the shared fixture: summary, KPI cards with their trend and
// definition, charts with their description and data table, the releases
// with what they carried, backlog, bots, coverage — in pt-BR and English.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { deltaTone, formatDelta, formatSpan, reportPath } from "@/lib/productivity";
import { buildProductivityReport } from "../../server/productivity-report";
import { executiveSummary } from "../../server/productivity-export";
import { brt, CLIENT_NAME, scenario } from "../../server/testing/productivity-fixture";
import type { ProductivityReport } from "../../shared/productivity";
import { KpiCard, ReleasesTable, ReportView } from "./ReportPage";
import { niceScale } from "./ReportCharts";

function report(period = { from: brt("2026-09-28T00:00:00"), to: brt("2026-10-03T00:00:00") }): ProductivityReport {
  const built = buildProductivityReport({ ...scenario(), granularity: "day", period });
  return { ...built, enabled: true, summary: { "pt-BR": executiveSummary(built, "pt-BR"), en: executiveSummary(built, "en") } };
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

afterEach(() => setLocale("en"));

describe("report screen (pt-BR)", () => {
  setLocale("pt-BR");
  const html = renderToStaticMarkup(createElement(ReportView, { report: report() }));
  setLocale("en");
  const plain = text(html);

  it("opens with the five-line executive summary", () => {
    expect(plain).toContain("Resumo executivo");
    expect(html.match(/<ol[^>]*>[\s\S]*?<\/ol>/)![0].match(/<li>/g)).toHaveLength(5);
    expect(plain).toContain("Produção: 3 entregas (sem base de comparação), com 2 PRs e 2 issues no ar");
  });

  it("says where no release source exists, as unknown — not zero", () => {
    expect(html).toContain('role="note"');
    expect(plain).toContain("Nenhuma fonte de releases cobre 28/09/2026 – 29/09/2026: entregas e falhas desse trecho são desconhecidas, não zero.");
    expect(plain).toContain("O período anterior não tem fonte de releases");
  });

  it("shows each KPI with its value, detail, trend and exact definition", () => {
    for (const label of ["Entregas em produção", "PRs mergeadas", "Issues resolvidas", "Lead time issue → produção", "Issues P0/P1 abertas", "PRs esperando o gate", "Releases falhados", "Produção travada"]) {
      expect(plain).toContain(label);
      expect(html).toContain(`aria-label="O que “${label}” conta"`);
    }
    expect(plain).toContain("2 PRs e 2 issues foram ao ar");
    expect(plain).toContain("mais 1 carriers de release");
    expect(plain).toContain("+3 vs. período anterior (melhor)");
    expect(html).toMatch(/role="tooltip" id="[^"]+"[^>]*>Avanços da tag nuria-production-deployed/);
    // a definition is reachable from its button
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${describedBy}"`);
  });

  it("draws four charts, each with a description and its numbers as a table", () => {
    expect(html.match(/<figure/g)).toHaveLength(4);
    expect(html.match(/role="img"/g)).toHaveLength(4);
    expect(plain).toContain("Entregas e falhas");
    expect(plain).toContain("Entregas: 3 no período, o máximo em");
    expect(plain).toContain("Sem fonte de releases (desconhecido, não zero)");
    expect(html.match(/Ver os números/g)).toHaveLength(4);
    expect(html).toContain("<caption");
  });

  it("lists the releases with what they carried, grouped failures and the refusal", () => {
    expect(plain).toContain("Releases do período");
    expect(plain).toContain("3 em produção · 1 falhados · 1 recusados");
    expect(plain).toMatch(/01\/10\/2026, 10:00|01\/10\/2026 10:00/);
    expect(plain).toContain("#3");
    expect(plain).toContain("#102");
    expect(plain).toContain("Falhou");
    expect(plain).toContain("2 tentativas");
    expect(plain).toContain("Recusado");
    expect(plain).toContain("Conteúdo desconhecido (sem release anterior para comparar)");
  });

  it("shows the backlog now, the PRs waiting for the gate and the bots' effort", () => {
    expect(plain).toContain("Backlog agora");
    expect(plain).toContain("#104 · 22 d");
    expect(plain).toContain("1 PRs esperando o gate (de 3 abertas)");
    expect(plain).toContain("sem gate");
    expect(plain).toContain("Esforço dos bots");
    expect(plain).toContain("Chief of Staff");
    expect(plain).toContain("o dono respondeu em 1,3 h (mediana), 2 h (p90), n = 2");
  });

  it("explains how each number is counted and where the data comes from", () => {
    expect(plain).toContain("Como é contado");
    expect(plain).toContain("De onde vêm os dados");
    expect(plain).toContain("Tag de produção no GitHub: ccccccccc, a mesma do último release do histórico.");
  });

  it("keeps the releases' rows to numbers; titles wait behind each row's details", () => {
    const releases = html.slice(html.indexOf('id="report-releases"'), html.indexOf('id="report-backlog"'));
    expect(releases).toContain("#102");
    expect(releases).not.toContain(CLIENT_NAME);
    expect(releases).toContain('aria-expanded="false"');
  });
});

describe("report screen (English)", () => {
  it("speaks the reader's language", () => {
    setLocale("en");
    const plain = text(renderToStaticMarkup(createElement(ReportView, { report: report() })));
    expect(plain).toContain("Executive summary");
    expect(plain).toContain("Production: 3 deliveries (nothing to compare)");
    expect(plain).toContain("Deliveries to production");
    expect(plain).toContain("Releases in the period");
    expect(plain).toContain("The previous period has no release source");
  });
});

describe("pieces", () => {
  it("a KPI's trend says better or worse in words, not only in colour", () => {
    const good = renderToStaticMarkup(createElement(KpiCard, { label: "Entregas", value: "5", definition: "d", current: 5, previous: 2, polarity: "up" }));
    expect(good).toContain("text-success");
    expect(text(good)).toContain("+3 (+150%) vs previous period");
    expect(text(good)).toContain("(better)");
    const bad = renderToStaticMarkup(createElement(KpiCard, { label: "Falhas", value: "5", definition: "d", current: 5, previous: 2, polarity: "down" }));
    expect(bad).toContain("text-danger");
    expect(text(bad)).toContain("(worse)");
    const same = renderToStaticMarkup(createElement(KpiCard, { label: "x", value: "2", definition: "d", current: 2, previous: 2, polarity: "up" }));
    expect(text(same)).toContain("Same as the previous period");
  });

  it("a long list of releases shows 15 and offers the rest", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ sha: `${index}`.padStart(40, "a"), at: index, timeSource: "log" as const, outcome: "released" as const, prs: [], issues: [] }));
    const html = renderToStaticMarkup(createElement(ReleasesTable, { releases: many }));
    expect(html.match(/<tr class="border-t/g)).toHaveLength(15);
    expect(text(html)).toContain("Show all 20");
  });

  it("builds the requests and formats deltas", () => {
    expect(reportPath({ granularity: "day", count: 90 })).toBe("/api/reports/productivity?granularity=day&count=90");
    expect(reportPath({ granularity: "month", from: "2026-01", to: "2026-09" }, { format: "pdf" })).toBe("/api/reports/productivity.pdf?granularity=month&from=2026-01&to=2026-09");
    expect(reportPath({ granularity: "hour", count: 48 }, { refresh: true })).toBe("/api/reports/productivity?granularity=hour&count=48&refresh=1");
    expect(deltaTone(5, 2, "up")).toBe("good");
    expect(deltaTone(5, 2, "down")).toBe("bad");
    expect(deltaTone(5, 2, "neutral")).toBe("neutral");
    expect(deltaTone(null, 2, "up")).toBe("neutral");
    expect(formatDelta(3, 0)).toBe("+3");
    expect(formatDelta(1, 4)).toBe("−3 (−75%)");
    expect(formatSpan(0)).toBe("0 min");
    expect(formatSpan(90 * 60_000)).toBe("1.5 h");
    expect(niceScale(0)).toEqual({ ceiling: 1, step: 1 });
    expect(niceScale(3)).toEqual({ ceiling: 3, step: 1 });
    expect(niceScale(37)).toEqual({ ceiling: 40, step: 10 });
    expect(niceScale(223)).toEqual({ ceiling: 250, step: 50 });
    expect(niceScale(5)).toEqual({ ceiling: 5, step: 1 });
  });
});
