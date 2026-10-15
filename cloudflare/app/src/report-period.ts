import type { ReportComparison, ReportCoverage, ReportGranularity, ReportPeriod, ReportPreset, ReportQuery } from "./report-types";

export const REPORT_TIMEZONE = "America/Sao_Paulo";
const DAY = 86_400_000;
const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function parts(at: number) {
  return Object.fromEntries(formatter.formatToParts(at).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
}
function midnight(year: number, month: number, day: number): number {
  const target = Date.UTC(year, month - 1, day); let at = target + 3 * 3_600_000;
  for (let i = 0; i < 3; i++) { const p = parts(at); at += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); }
  return at;
}
function dayStart(at: number) { const p = parts(at); return midnight(p.year, p.month, p.day); }
function moveDay(at: number, days: number) { const p = parts(at); const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days)); return midnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()); }
function monthStart(at: number, offset = 0) { const p = parts(at); const date = new Date(Date.UTC(p.year, p.month - 1 + offset, 1)); return midnight(date.getUTCFullYear(), date.getUTCMonth() + 1, 1); }
function parseDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("invalid_report_query");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error("invalid_report_query");
  return midnight(year, month, day);
}
export function resolveReportQuery(params: URLSearchParams, now: number) {
  const preset = (params.get("period") ?? "month") as ReportPreset;
  if (!["day", "week", "fortnight", "month", "48h", "90d", "12m", "previous_month", "custom"].includes(preset)) throw new Error("invalid_report_query");
  const query: ReportQuery = { period: preset };
  const requested = params.get("granularity");
  if (requested && !["hour", "day", "month"].includes(requested)) throw new Error("invalid_report_query");
  if (requested) query.granularity = requested as ReportGranularity;
  for (const key of ["repositoryId", "agentId"] as const) { const value = params.get(key); if (value) { if (!/^[A-Za-z0-9_:-]{1,100}$/.test(value)) throw new Error("invalid_report_query"); query[key] = value; } }
  let from: number, to: number; let previous: ReportPeriod | undefined;
  if (preset === "custom") {
    query.from = params.get("from") ?? ""; query.to = params.get("to") ?? "";
    from = parseDate(query.from); const last = parseDate(query.to); to = moveDay(last, 1);
    if (last > dayStart(now) || last < from || Math.round((to - from) / DAY) > (requested === "month" ? 1096 : 366)) throw new Error("invalid_report_query");
  } else if (preset === "48h") {
    to = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000; from = to - 48 * 3_600_000;
    previous = { from: from - 48 * 3_600_000, to: from };
  } else if (preset === "12m") {
    to = monthStart(now, 1); from = monthStart(to, -12); previous = { from: monthStart(from, -12), to: from };
  } else if (preset === "previous_month") {
    to = monthStart(now); from = monthStart(now, -1); previous = { from: monthStart(from, -1), to: from };
  } else {
    const days = { day: 1, week: 7, fortnight: 15, month: 30, "90d": 90 }[preset];
    to = moveDay(dayStart(now), 1); from = moveDay(to, -days);
  }
  const count = Math.round((to - from) / DAY);
  const period: ReportPeriod = { from, to }; previous ??= { from: moveDay(from, -count), to: from };
  const comparedUntil = Math.min(to, now);
  const granularity = query.granularity ?? (preset === "12m" ? "month" : count === 1 || preset === "48h" ? "hour" : "day");
  if (reportBucketPeriods(period, granularity).length > { hour: 336, day: 366, month: 36 }[granularity]) throw new Error("invalid_report_query");
  return { query, period, previous, comparedUntil, previousComparedUntil: comparedUntil >= to ? previous.to : Math.min(previous.to, previous.from + Math.max(0, comparedUntil - from)), granularity };
}
export function reportBucketPeriods(period: ReportPeriod, granularity: ReportGranularity): ReportPeriod[] {
  const result: ReportPeriod[] = [];
  for (let from = period.from; from < period.to; ) { const to = Math.min(period.to, granularity === "hour" ? from + 3_600_000 : granularity === "month" ? monthStart(from, 1) : moveDay(from, 1)); result.push({ from, to }); from = to; }
  return result;
}
export function reportCoverage(startedAt: number | null, from: number, to: number): ReportCoverage {
  return startedAt === null || startedAt >= to || to <= from ? "none" : startedAt <= from ? "full" : "partial";
}
export function compareReportMetric(current: number | null, previous: number | null, coverage: ReportCoverage, previousCoverage: ReportCoverage, samples?: { current: number; previous: number }): ReportComparison {
  if (current === null || previous === null || coverage !== "full" || previousCoverage !== "full") return { kind: "none", previous, delta: null, ratio: null, reason: "Não há cobertura completa nos dois períodos." };
  if (previous === 0 || (samples ? samples.current < 10 || samples.previous < 10 : Math.abs(previous) < 5)) return { kind: "absolute", previous, delta: null, ratio: null, reason: "Base pequena para comparação percentual." };
  return { kind: "trend", previous, delta: current - previous, ratio: (current - previous) / previous };
}
