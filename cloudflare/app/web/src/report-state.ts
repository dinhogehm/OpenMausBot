import type { ExecutionReport, ReportComparison, ReportGranularity, ReportPeriod } from "../../src/report-types";

const formatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
export const isReportValue = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const reportNumber = (value: number | null | undefined) => !isReportValue(value) ? "Não acompanhado" : formatter.format(value);
export const reportPercent = (value: number | null | undefined) => !isReportValue(value) ? "Não acompanhado" : `${formatter.format(value * 100)}%`;
export function reportDuration(value: number | null | undefined): string {
  if (!isReportValue(value)) return "Não acompanhado";
  if (value < 60_000) return `${formatter.format(value / 1000)} s`;
  if (value < 3_600_000) return `${formatter.format(value / 60_000)} min`;
  return `${formatter.format(value / 3_600_000)} h`;
}
export function reportDateInput(at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
export function reportPeriodLabel(period: ReportPeriod): string {
  const date = (at: number) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "short", year: "numeric" }).format(at);
  return `${date(period.from)} a ${date(period.to - 1)}`;
}
export function reportBucketLabel(at: number, granularity: ReportGranularity): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", ...(granularity === "month" ? { month: "short", year: "numeric" } : { day: "2-digit", month: "2-digit", ...(granularity === "hour" ? { hour: "2-digit", minute: "2-digit" } : {}) }) }).format(at);
}
export function reportChartMaximum(values: Array<number | null | undefined>): number {
  // Integer counts never need fractional task ticks. Keep a visible zero baseline.
  return Math.max(2, Math.ceil(Math.max(0, ...values.filter(isReportValue)) / 2) * 2);
}
export function isReportMarkdown(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/markdown";
}
export function validReportRange(from: string, to: string, maximumDays = 366): boolean {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  return valid(from) && valid(to) && from >= "2000-01-01" && from <= to && Date.parse(to) - Date.parse(from) < maximumDays * 86400_000;
}
export function reportComparison(value: ReportComparison | undefined, percentage = false): string {
  if (!value || value.kind === "none") return "Comparação indisponível";
  if (value.kind === "absolute") return `Anterior: ${percentage ? reportPercent(value.previous) : reportNumber(value.previous)} · base pequena`;
  if (value.delta === null) return "Comparação indisponível";
  if (value.delta === 0) return "Sem alteração no período anterior";
  if (percentage) return `${value.delta > 0 ? "+" : ""}${formatter.format(value.delta * 100)} p.p. sobre o anterior`;
  if (value.kind === "trend" && value.ratio !== null) return `${value.ratio > 0 ? "+" : ""}${formatter.format(value.ratio * 100)}% sobre o anterior`;
  return `${value.delta > 0 ? "+" : ""}${formatter.format(value.delta)} sobre o anterior`;
}
export function assertReportScope(report: ExecutionReport, organizationId: string, workspaceId: string): ExecutionReport {
  if (report.organizationId !== organizationId || report.workspaceId !== workspaceId) throw new Error("Unexpected report scope");
  return report;
}
export function safeReportPr(url: string, repository: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" && !parsed.port && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname.startsWith(`/${repository}/pull/`) && /^[1-9]\d*$/.test(parsed.pathname.slice(`/${repository}/pull/`.length)) ? parsed.href : null;
  } catch { return null; }
}
