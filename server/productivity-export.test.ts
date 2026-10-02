// "Exportar para o board" (lot V): a five-line executive summary in pt-BR with
// numbers and trend, the Markdown and the PDF — which name work only by its
// number (no PR/issue title, no failure cause: a client's name never leaves).
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  bucketLabel, executiveSummary, exportFileName, formatDuration, formatInstant, reportMarkdown, reportPdf, textWidth, trendText,
} from "./productivity-export.ts";
import { buildProductivityReport } from "./productivity-report.ts";
import { brt, CLIENT_NAME, scenario } from "./testing/productivity-fixture.ts";

const report = () => buildProductivityReport({ ...scenario(), granularity: "day", period: { from: brt("2026-09-28T00:00:00"), to: brt("2026-10-03T00:00:00") } });

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
  it("durations, instants in São Paulo, bucket labels and trends in pt-BR", () => {
    expect(formatDuration(30_000)).toBe("< 1 min");
    expect(formatDuration(38 * 60_000)).toBe("38 min");
    expect(formatDuration(5.24 * 3_600_000)).toBe("5,2 h");
    expect(formatDuration(55 * 3_600_000)).toBe("2,3 d");
    expect(formatDuration(null)).toBe("—");
    expect(formatInstant(Date.parse("2026-10-01T02:30:00Z"))).toBe("30/09/2026 23:30");
    expect(formatInstant(Date.parse("2026-10-01T02:30:00Z"), "en")).toBe("2026-09-30 23:30");
    expect(bucketLabel(brt("2026-10-02T14:00:00"), "hour")).toBe("14h");
    expect(bucketLabel(brt("2026-10-02T00:00:00"), "day")).toBe("02/10");
    expect(bucketLabel(brt("2026-10-01T00:00:00"), "month")).toBe("out/26");
    expect(trendText(5, 2)).toBe("+3 (+150%)");
    expect(trendText(1, 4)).toBe("−3 (−75%)");
    expect(trendText(3, 0)).toBe("+3");
    expect(trendText(2, 2)).toBe("= período anterior");
    expect(trendText(null, 2)).toBe("sem base de comparação");
    expect(trendText(2 * 3_600_000, 3_600_000, "pt-BR", "duration")).toBe("+1 h (+100%)");
    expect(formatDuration(3_600_000)).toBe("1 h");
    expect(formatDuration(43.25 * 3_600_000)).toBe("43 h");
  });
});

describe("executive summary", () => {
  it("is five pt-BR lines with numbers and their trend", () => {
    const lines = executiveSummary(report());
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("Produção: 3 entregas (+3), com 2 PRs e 2 issues no ar — parte do período sem fonte de releases.");
    expect(lines[1]).toBe("Vazão: 3 PRs mergeadas (+3) e 2 issues resolvidas (+2), 1 bug e 1 P0/P1.");
    expect(lines[2]).toBe("Lead time issue → produção: mediana 43 h, p90 2,6 d (n=2).");
    expect(lines[3]).toBe("Backlog agora: 2 issues abertas, 2 P0/P1; a mais antiga, #104, tem 22 d; 1 PR esperando o gate.");
    expect(lines[4]).toBe("Falhas: 2 tentativas de release falharam (+2), 1 recusada; produção travada 5 h. Bots: 3 turnos, 30 min ativos, US$ 0,75.");
  });

  it("has an English version with the same numbers", () => {
    const lines = executiveSummary(report(), "en");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("Production: 3 deliveries (+3), carrying 2 PRs and 2 issues live — part of the period has no release source.");
  });
});

describe("Markdown", () => {
  const markdown = reportMarkdown(report());

  it("opens with the summary and carries the KPIs, buckets, releases, backlog, bots, definitions and coverage", () => {
    const headings = [...markdown.matchAll(/^#+ (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(["Relatório de produtividade — Time Nuria", "Resumo executivo", "Indicadores", "Por dia", "Releases do período", "Backlog (agora)", "Esforço dos bots", "Definições", "Cobertura dos dados"]);
    expect(markdown.indexOf("1. Produção: 3 entregas")).toBeLessThan(markdown.indexOf("## Indicadores"));
    expect(markdown).toContain("| Entregas em produção | 3 | 0 | +3 |");
    expect(markdown).toContain("| 30/09 | 1 | 1 | 1 | 1 | 1 | 0 | 1 |");
    expect(markdown).toContain("| 28/09 | s/ fonte | s/ fonte | 0 | 0 | 0 | s/ fonte | 0 |");
    expect(markdown).toContain("| 01/10/2026 10:00 | `ccccccccc` | em produção | #3 | #102 |");
    expect(markdown).toContain("falhou (2 tentativas)");
    expect(markdown).toContain("- PRs esperando o gate: 1 (#20) de 3 abertas");
    expect(markdown).toContain("| Chief of Staff | 2 | 30 min |");
  });

  it("never carries a title, a failure cause or the client's name", () => {
    expect(markdown).not.toContain(CLIENT_NAME);
    expect(markdown).not.toContain("Acme");
    expect(markdown).not.toContain("reprovou");
    expect(markdown).not.toContain("Correção para");
  });
});

describe("PDF", () => {
  const pdf = reportPdf(report());

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
    expect(raw).toContain("/BaseFont /Helvetica /Encoding /WinAnsiEncoding");
    expect(raw).toMatch(/\/Type \/Pages \/Kids \[[^\]]+\] \/Count \d+/);
  });

  it("draws the title, the summary first, accents in WinAnsi and the indicators", () => {
    const text = pdfText(pdf);
    expect(text).toContain("Relatório de produtividade — Time Nuria");
    expect(text.indexOf("Resumo executivo")).toBeLessThan(text.indexOf("Indicadores"));
    expect(text).toContain("Produção: 3 entregas (+3), com 2 PRs e 2 issues no ar");
    expect(text).toContain("Entregas e falhas por dia");
    expect(text).toContain("faixa cinza: sem fonte de releases (desconhecido, não zero)");
  });

  it("never carries a title, a failure cause or the client's name", () => {
    const text = pdfText(pdf);
    expect(text).not.toContain("Acme");
    expect(text).not.toContain("reprovou");
    expect(text).not.toContain("Correção para");
  });

  it("is deterministic for the same report", () => {
    expect(reportPdf(report()).equals(pdf)).toBe(true);
  });

  it("measures Helvetica like the AFM (layout of right-aligned numbers)", () => {
    expect(textWidth("0", 10)).toBeCloseTo(5.56);
    expect(textWidth("Produção", 10)).toBeCloseTo(textWidth("Producao", 10));
    expect(textWidth("W", 10, true)).toBeCloseTo(9.44);
  });

  it("names the download by granularity and period", () => {
    expect(exportFileName(report(), "pdf")).toBe("produtividade-dia-2026-09-28_2026-10-02.pdf");
    const monthly = buildProductivityReport({ ...scenario(), granularity: "month", period: { from: brt("2026-09-01T00:00:00"), to: brt("2026-11-01T00:00:00") } });
    expect(exportFileName(monthly, "md")).toBe("produtividade-mes-2026-09-01_2026-10-31.md");
  });
});
