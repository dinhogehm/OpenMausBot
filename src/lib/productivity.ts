// The "Relatório" screen's helpers (lot V): the request it makes, how a number
// moved and whether that is good, and São Paulo-calendar formatting in the
// reader's language. The numbers themselves come from the server
// (server/productivity-report.ts); nothing here recomputes them.
import { activeLocale, documentLanguage } from "@/lib/i18n";
import { REPORT_TZ, trend, zonedParts, type Granularity, type ProductivityReport, type ReportBucket } from "../../shared/productivity";

export type { Granularity, ProductivityReport, ReportBucket } from "../../shared/productivity";

/** What the screen asks for: a preset (count) or an explicit São Paulo date range. */
export interface ReportQuery {
  granularity: Granularity;
  count?: number;
  from?: string;
  to?: string;
}

export const DEFAULT_QUERY: ReportQuery = { granularity: "day", count: 30 };

export function reportPath(query: ReportQuery, options: { format?: "json" | "md" | "pdf"; refresh?: boolean } = {}): string {
  const params = new URLSearchParams({ granularity: query.granularity });
  if (query.from && query.to) {
    params.set("from", query.from);
    params.set("to", query.to);
  } else if (query.count) {
    params.set("count", String(query.count));
  }
  if (options.refresh) params.set("refresh", "1");
  const suffix = options.format && options.format !== "json" ? `.${options.format}` : "";
  return `/api/reports/productivity${suffix}?${params.toString()}`;
}

/** Which way is better for a KPI: more deliveries is good, more failures is not. */
export type Polarity = "up" | "down" | "neutral";

export type Tone = "good" | "bad" | "neutral";

export function deltaTone(current: number | null, previous: number | null, polarity: Polarity): Tone {
  const moved = trend(current, previous);
  if (!moved || moved.delta === 0 || polarity === "neutral") return "neutral";
  return (moved.delta > 0) === (polarity === "up") ? "good" : "bad";
}

/** The reader's language as a BCP-47 tag for Intl ("pt-BR", "en"). */
const locale = () => documentLanguage(activeLocale());

export function formatCount(value: number, digits = 0): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(value);
}

/** A duration at a glance: 38 min, 5.2 h, 2.3 d (a decimal only below 10). */
export function formatSpan(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const minutes = ms / 60_000;
  if (minutes < 1) return ms <= 0 ? "0 min" : "< 1 min";
  if (minutes < 60) return `${formatCount(Math.round(minutes))} min`;
  const hours = minutes / 60;
  const short = (value: number) => formatCount(value, value < 10 ? 1 : 0);
  if (hours < 48) return `${short(hours)} h`;
  return `${short(hours / 24)} d`;
}

export function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value);
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat(locale(), { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** "+3 (+150%)" / "−3" / "=" — the delta against the previous period. */
export function formatDelta(current: number | null, previous: number | null, kind: "count" | "span" = "count"): string | null {
  const moved = trend(current, previous);
  if (!moved) return null;
  if (moved.delta === 0) return "=";
  const sign = moved.delta > 0 ? "+" : "−";
  const amount = kind === "span" ? formatSpan(Math.abs(moved.delta)) : formatCount(Math.abs(moved.delta));
  const ratio = moved.ratio === null ? "" : ` (${sign}${formatCount(Math.abs(moved.ratio) * 100)}%)`;
  return `${sign}${amount}${ratio}`;
}

const zoned = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale(), { timeZone: REPORT_TZ, ...options });

/** São Paulo wall clock, in the reader's language: "01/10/2026 10:00". */
export function formatWhen(ms: number, withTime = true): string {
  const date = zoned({ day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(ms));
  return withTime ? `${date} ${zoned({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms))}` : date;
}

/** A bucket's short axis label: 14h, 02/10, out. 26. */
export function bucketTick(start: number, granularity: Granularity): string {
  if (granularity === "hour") return `${String(zonedParts(start).hour).padStart(2, "0")}h`;
  if (granularity === "day") return zoned({ day: "2-digit", month: "2-digit" }).format(new Date(start));
  return zoned({ month: "short", year: "2-digit" }).format(new Date(start));
}

/** A bucket in full, for tooltips and the data tables. */
export function bucketName(bucket: Pick<ReportBucket, "start" | "end">, granularity: Granularity): string {
  if (granularity === "hour") return `${formatWhen(bucket.start)}–${String(zonedParts(bucket.end).hour).padStart(2, "0")}:00`;
  if (granularity === "day") return zoned({ weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(bucket.start));
  return zoned({ month: "long", year: "numeric" }).format(new Date(bucket.start));
}

export function periodLabel(period: { from: number; to: number }, granularity: Granularity): string {
  const last = period.to - 60_000;
  if (granularity === "hour") return `${formatWhen(period.from)} – ${formatWhen(last)}`;
  if (granularity === "day") return `${formatWhen(period.from, false)} – ${formatWhen(last, false)}`;
  return `${zoned({ month: "short", year: "numeric" }).format(new Date(period.from))} – ${zoned({ month: "short", year: "numeric" }).format(new Date(last))}`;
}

/** Today's date in São Paulo as YYYY-MM-DD (the date inputs' default). */
export function zonedToday(now = Date.now()): string {
  const p = zonedParts(now);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** How old the data is: "agora", "há 3 min"… — given by the caller's i18n. */
export function minutesSince(at: number | null, now = Date.now()): number | null {
  return at === null ? null : Math.max(0, Math.round((now - at) / 60_000));
}

/** The summary in the reader's language: pt-BR for Portuguese, English otherwise. */
export function summaryLines(report: ProductivityReport): string[] {
  const lang = locale() === "pt-BR" ? "pt-BR" : "en";
  return report.summary?.[lang] ?? [];
}
