// "Exportar para o board" (lot V, INSP-V r1): the period in the title, a
// five-line summary in pt-BR with numbers and comparisons that follow one rule,
// the board's indicators with their definition beside each, DORA, success rate,
// cost per delivery, targets with a light only when set, lower bounds marked
// "≥", the Markdown and the PDF — which name work only by its number and carry
// a title any viewer reads right.
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  boardKpis, bucketLabel, comparisonText, doraRows, executiveSummary, exportFileName, fitNumbers, formatDuration, formatInstant, pdfTextString,
  reportMarkdown, reportPdf, reportTitle, textWidth,
} from "./productivity-export.ts";
import { buildProductivityReport } from "./productivity-report.ts";
import { brt, CLIENT_NAME, scenario } from "./testing/productivity-fixture.ts";

const report = (goals = {}) => buildProductivityReport({ ...scenario(), goals, granularity: "day", period: { from: brt("2026-09-28T00:00:00"), to: brt("2026-10-03T00:00:00") } });
const CP1252: Record<number, string> = { 0x80: "€", 0x85: "…", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—" };

/** Every page's text as drawn: the Flate streams inflated, the strings' octal escapes read back as WinAnsi. */
function pdfText(pdf: Buffer): string {
  const text: string[] = [];
  const raw = pdf.toString("latin1");
  for (const match of raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    const body = inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1");
    for (const string of body.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)) {
      text.push(string[1]!.replace(/\\([0-7]{3})/g, (_, octal: string) => CP1252[parseInt(octal, 8)] ?? String.fromCharCode(parseInt(octal, 8))).replace(/\\(.)/g, "$1"));
    }
  }
  return text.join("\n");
}

describe("formatting", () => {
  it("durations, instants in São Paulo, bucket labels", () => {
    expect(formatDuration(30_000)).toBe("< 1 min");
    expect(formatDuration(38 * 60_000)).toBe("38 min");
    expect(formatDuration(5.24 * 3_600_000)).toBe("5,2 h");
    expect(formatDuration(55 * 3_600_000)).toBe("2,3 d");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(3_600_000)).toBe("1 h");
    expect(formatInstant(Date.parse("2026-10-01T02:30:00Z"))).toBe("30/09/2026 23:30");
    expect(bucketLabel(brt("2026-10-02T14:00:00"), "hour")).toBe("14h");
    expect(bucketLabel(brt("2026-10-01T00:00:00"), "month")).toBe("out/26");
  });

  it("comparisons without nested parentheses, the absolute value on a small base, nothing before the repository (INSP-V r1 #7, #12)", () => {
    expect(comparisonText({ kind: "trend", delta: -48, ratio: -48 / 275 })).toBe("−48, −17%");
    expect(comparisonText({ kind: "trend", delta: 3_600_000, ratio: 1 }, "pt-BR", "duration")).toBe("+1 h, +100%");
    expect(comparisonText({ kind: "absolute", previous: 2 })).toBe("anterior: 2");
    expect(comparisonText({ kind: "none", reason: "before-repo" })).toBe("anterior ao repositório");
    expect(comparisonText({ kind: "none", reason: "not-comparable" })).toBe("sem base comparável");
  });
});

describe("board model", () => {
  const kpis = boardKpis(report());
  const by = (key: string) => kpis.find((kpi) => kpi.key === key)!;

  it("has the board's eight indicators, each with its definition beside it", () => {
    expect(kpis.map((kpi) => kpi.label)).toEqual([
      "Entregas em produção", "Frequência de deploy", "Sucesso de release", "Lead time issue até produção",
      "PRs mergeadas", "Issues resolvidas", "Issues P0/P1 abertas", "Pipeline de release parado",
    ]);
    for (const kpi of kpis) expect(kpi.short.length).toBeGreaterThan(10);
  });

  it("marks delivered totals as lower bounds when a release's contents are unknown (INSP-V r1 #4)", () => {
    expect(by("deliveries").detail).toBe("≥4 PRs e ≥2 issues concluídas no ar · 1 release sem conteúdo lido");
  });

  it("success rate over the runs that ran; superseded and aborted apart (INSP-V r1 #1)", () => {
    expect(by("successRate")).toMatchObject({ value: "60%", detail: "3 de 5 que rodaram · 1 substituído e 1 abortado fora da taxa" });
  });

  it("the stopped pipeline says production stayed up and shows the weekend (INSP-V r1 #2)", () => {
    expect(by("blocked")).toMatchObject({ label: "Pipeline de release parado", value: "5 h", detail: "produção no ar · 0 min em fim de semana" });
  });

  it("P1 shows p1 + high, the old scale, apart (INSP-V r1 #5)", () => {
    expect(by("openP1").detail).toBe("P1 1 = 1 priority:p1 + 0 priority:high (legado) · P0 1");
    expect(by("openP1").short).toBe("agora; P1 = p1 + high, P0 = p0 + critical");
  });

  it("no trend on a base under 5; production numbers without a comparable source get none (INSP-V r1 #7)", () => {
    expect(by("merged")).toMatchObject({ comparison: "anterior: 0", good: null });
    expect(by("deliveries")).toMatchObject({ comparison: "sem base comparável", previous: "—" });
  });

  it("before the repository existed there is no comparison at all", () => {
    const yearly = buildProductivityReport({ ...scenario(), granularity: "month", period: { from: brt("2026-09-01T00:00:00"), to: brt("2026-11-01T00:00:00") } });
    expect(boardKpis(yearly).find((kpi) => kpi.key === "merged")).toMatchObject({ comparison: "anterior ao repositório", previous: "—" });
  });

  it("lights a target only when one is set (met / close / off)", () => {
    expect(kpis.some((kpi) => kpi.goal)).toBe(false);
    const withGoals = boardKpis(report({ deploysPerBusinessDay: 1, releaseSuccessRate: 70, leadTimeHours: 48 }));
    expect(withGoals.find((kpi) => kpi.key === "deployFrequency")!.goal).toEqual({ target: "≥ 1/dia útil", status: "off" });
    expect(withGoals.find((kpi) => kpi.key === "successRate")!.goal).toEqual({ target: "≥ 70%", status: "close" });
    expect(withGoals.find((kpi) => kpi.key === "leadTime")!.goal).toEqual({ target: "≤ 48 h", status: "met" });
  });

  it("DORA rows: frequency, lead time for changes, change failure rate and time to restore", () => {
    expect(doraRows(report()).map(([name, value]) => [name, value])).toEqual([
      ["Frequência de deploy", "0,7 por dia útil (3 em 4,5 dias úteis)"],
      ["Lead time de mudança", "1,8 h (p90 3,5 h, n=4)"],
      ["Taxa de falha de mudança", "50% (1 de 2 releases verificados)"],
      ["Tempo de restauração", "11 h (n=1)"],
    ]);
    const quiet = scenario();
    quiet.runs = quiet.runs.map(({ postRelease: _p, ...run }) => run);
    const none = buildProductivityReport({ ...quiet, granularity: "day", period: { from: brt("2026-09-28T00:00:00"), to: brt("2026-10-03T00:00:00") } });
    expect(doraRows(none)[2]![1]).toBe("— (nenhum release com verificação pós-release)");
    expect(doraRows(none)[3]![1]).toBe("— (nenhuma falha de mudança registrada)");
  });
});

describe("executive summary", () => {
  it("is five pt-BR lines with the numbers, the rules and the coverage of each", () => {
    const lines = executiveSummary(report());
    expect(lines).toEqual([
      "Produção: 3 entregas (sem base comparável), 0,7 por dia útil, com ≥4 PRs e ≥2 issues concluídas no ar (1 release sem conteúdo lido); parte do período sem fonte de releases.",
      "Vazão: 5 PRs mergeadas (anterior: 0) e 2 issues resolvidas (anterior: 0), 1 bug e 1 P0/P1.",
      "Lead time issue até produção: mediana 43 h, p90 2,6 d (n=2; sem base comparável); merge até produção 1,8 h.",
      "Backlog agora: 2 issues abertas; P1 1 (1 priority:p1 + 0 priority:high legado) e P0 1; a mais antiga #104, 22 d; 1 PR esperando o gate.",
      "Releases: sucesso 60% (3 de 5 que rodaram; 1 substituído e 1 abortado fora da taxa), 1 recusado; pipeline parado 5 h com produção no ar (0 min em fim de semana). Bots: 3 turnos, US$ 0,75 em 4,5 dias registrados; US$ 0,25 por entrega.",
    ]);
  });

  it("says the bots' cost covers only the recorded days (INSP-V r1 #6)", () => {
    const base = scenario();
    const none = buildProductivityReport({ ...base, local: { ...base.local, usageFrom: null }, usage: [], granularity: "day", period: { from: brt("2026-09-28T00:00:00"), to: brt("2026-10-03T00:00:00") } });
    expect(executiveSummary(none)[4]).toMatch(/Bots: sem registro de uso no período\.$/);
  });

  it("has an English version with the same numbers", () => {
    expect(executiveSummary(report(), "en")[0]).toBe("Production: 3 deliveries (no comparable base), 0.7 per business day, carrying ≥4 PRs and ≥2 completed issues live (1 release with contents not read); part of the period has no release source.");
  });
});

describe("Markdown", () => {
  const markdown = reportMarkdown(report());

  it("has the period in the title and the summary on top", () => {
    expect(markdown.startsWith("# Produtividade de engenharia — 28/09 a 02/10/2026\n")).toBe(true);
    const month = buildProductivityReport({ ...scenario(), granularity: "day", period: { from: brt("2026-09-01T00:00:00"), to: brt("2026-10-01T00:00:00") } });
    expect(reportMarkdown(month).split("\n")[0]).toBe("# Produtividade de engenharia — setembro/2026");
    expect(markdown.indexOf("1. Produção: 3 entregas")).toBeLessThan(markdown.indexOf("## Indicadores"));
  });

  it("puts the definition beside each indicator, DORA, lower bounds, release counts that add up, and the head PR as PR or carrier (INSP-V r1 #4, #8, #13)", () => {
    expect(markdown).toContain("| Pipeline de release parado | 5 h<br>produção no ar · 0 min em fim de semana | — | sem base comparável | — | 1ª falha que rodou após um sucesso até o próximo sucesso |");
    expect(markdown).toContain("## DORA");
    expect(markdown).toContain("| 29/09 | 1 | ≥0 |");
    expect(markdown).toContain("3 em produção · 1 commit falhou (2 tentativas que rodaram) · 1 substituído · 1 abortado · 1 recusado");
    expect(markdown).toContain("| 01/10/2026 06:00 | `xxxxxxxxx` | falhou (2 tentativas) | PR #6 | — |");
    expect(markdown).toContain("conteúdo desconhecido (primeiro release conhecido)");
    expect(markdown).not.toContain("sem release anterior para comparar");
    expect(markdown).toContain("P1: 1 = 1 priority:p1 + 0 priority:high (escala antiga)");
  });

  it("shows the bots' days before the ledger as —, not 0 (INSP-V r1 #6)", () => {
    const day = buildProductivityReport({ ...scenario(), granularity: "day", period: { from: brt("2026-09-26T00:00:00"), to: brt("2026-09-29T00:00:00") } });
    expect(reportMarkdown(day)).toContain("| 26/09 | s/ fonte | s/ fonte | 0 | 0 | 0 | s/ fonte | — |");
  });

  it("never carries a title, a failure cause, the client's name or the owner's login", () => {
    expect(markdown).not.toContain(CLIENT_NAME);
    expect(markdown).not.toContain("reprovou");
    expect(markdown).not.toContain("Correção para");
    expect(markdown).not.toContain("dinhogehm");
  });
});

describe("PDF", () => {
  const pdf = reportPdf(report({ deploysPerBusinessDay: 1 }));

  it("is a well-formed PDF 1.4 whose cross-reference table points at every object", () => {
    const raw = pdf.toString("latin1");
    expect(raw.startsWith("%PDF-1.4\n")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(raw)![1]);
    expect(raw.slice(startxref, startxref + 4)).toBe("xref");
    const table = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(raw)!;
    const offsets = table[2]!.trim().split("\n").slice(1).map((line) => Number(line.slice(0, 10)));
    expect(offsets).toHaveLength(Number(table[1]) - 1);
    offsets.forEach((offset, index) => expect(raw.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`));
  });

  it("writes the title in the metadata as UTF-16 so the viewer reads the dash and accents (INSP-V r1 #11)", () => {
    const raw = pdf.toString("latin1");
    const title = reportTitle(report());
    expect(raw).toContain(`/Title ${pdfTextString(title)}`);
    const hex = /\/Title <FEFF([0-9A-F]+)>/.exec(raw)![1]!;
    const decoded = String.fromCharCode(...hex.match(/.{4}/g)!.map((unit) => parseInt(unit, 16)));
    expect(decoded).toBe("Produtividade de engenharia — 28/09 a 02/10/2026");
  });

  it("draws the title, the summary first, the cards with their definition and target, DORA", () => {
    const text = pdfText(pdf);
    expect(text).toContain("Produtividade de engenharia — 28/09 a 02/10/2026");
    expect(text.indexOf("Resumo executivo")).toBeLessThan(text.indexOf("DORA"));
    expect(text).toContain("Pipeline de release parado");
    expect(text).toContain("DORA: entregas por dia útil (seg–sex)");
    expect(text).toContain("meta >= 1/dia útil");
    expect(text).toContain("Taxa de falha de mudança");
    // a true minus is drawn as an en dash, never a hyphen (INSP-V r1 #12)
    expect(text).not.toMatch(/\(-\d/);
  });

  it("never cuts a list without saying how many are left (INSP-V r1 #12)", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ number: 9000 + index }));
    const fitted = fitNumbers(many, 120, 7.5);
    expect(fitted).toMatch(/^#9000, .* \+\d+$/);
    expect(textWidth(fitted, 7.5)).toBeLessThanOrEqual(120);
  });

  it("never carries a title, a failure cause or the client's name", () => {
    const text = pdfText(pdf);
    expect(text).not.toContain("Acme");
    expect(text).not.toContain("reprovou");
    expect(text).not.toContain("Correção para");
    expect(text).not.toContain("dinhogehm");
  });

  it("is deterministic for the same report", () => {
    expect(reportPdf(report({ deploysPerBusinessDay: 1 })).equals(pdf)).toBe(true);
  });

  it("names the download by granularity and period", () => {
    expect(exportFileName(report(), "pdf")).toBe("produtividade-dia-2026-09-28_2026-10-02.pdf");
  });
});
