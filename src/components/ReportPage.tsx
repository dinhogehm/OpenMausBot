// "Relatório" (lot V): what the Nuria team put IN PRODUCTION — per hour, day
// or month in São Paulo — for the owner to take to the board. KPI cards with
// their trend against the previous period and their exact definition, charts
// whose numbers are one click away as a table, the releases of the period with
// the PRs and issues each one carried, the backlog now, the bots' effort, and
// where the data comes from (and where it does not exist). "Exportar para o
// board" downloads the same report as PDF or Markdown, numbers only.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle, BarChart3, ChevronDown, ChevronRight, Download, FileText, Info, Loader2, Minus, RefreshCw, TrendingDown, TrendingUp,
} from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import {
  DEFAULT_QUERY, bucketName, deltaTone, formatCount, formatDelta, formatSpan, formatTokens, formatUsd, formatWhen, minutesSince,
  periodLabel, reportPath, summaryLines, zonedToday,
  type Granularity, type Polarity, type ProductivityReport, type ReportBucket, type ReportQuery, type Tone,
} from "@/lib/productivity";
import { releaseComparable, type ReportRelease } from "../../shared/productivity";
import { BarChart, LineChart, type ChartSeries } from "./ReportCharts";

const QUERY_KEY = "omb-report-query";
const POLL_MS = 60_000;
const SYNC_POLL_MS = 3_000;

function loadQuery(): ReportQuery {
  try {
    const raw = JSON.parse(localStorage.getItem(QUERY_KEY) ?? "null");
    if (raw && ["hour", "day", "month"].includes(raw.granularity)) return { granularity: raw.granularity, ...(raw.count ? { count: Number(raw.count) } : {}), ...(raw.from && raw.to ? { from: String(raw.from), to: String(raw.to) } : {}) };
  } catch {
    /* storage blocked or a stale value: the default */
  }
  return DEFAULT_QUERY;
}

function saveQuery(query: ReportQuery): void {
  try {
    localStorage.setItem(QUERY_KEY, JSON.stringify(query));
  } catch {
    /* storage blocked: the choice lasts this visit */
  }
}

// ── period bar ──────────────────────────────────────────────────────────────

const PRESETS: Record<Granularity, Array<{ count: number; label: LocaleKey }>> = {
  hour: [{ count: 48, label: "report.preset.hour48" }],
  day: [{ count: 30, label: "report.preset.day30" }, { count: 90, label: "report.preset.day90" }],
  month: [{ count: 12, label: "report.preset.month12" }],
};

export function PeriodBar({ query, onChange, report }: { query: ReportQuery; onChange: (query: ReportQuery) => void; report: ProductivityReport | null }) {
  const name = useId();
  const custom = Boolean(query.from && query.to);
  const today = zonedToday();
  const [from, setFrom] = useState(query.from ?? today);
  const [to, setTo] = useState(query.to ?? today);
  useEffect(() => { setFrom(query.from ?? today); setTo(query.to ?? today); }, [query.from, query.to, today]);
  const inputType = query.granularity === "month" ? "month" : "date";
  const normalize = (value: string) => (inputType === "month" ? value.slice(0, 7) : value);
  return (
    <section aria-label={t("report.periodBar")} className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-[12px] font-medium text-ink-secondary">{t("report.granularity")}</legend>
        <div className="flex rounded-lg border border-hairline/60 bg-panel p-0.5">
          {(["hour", "day", "month"] as const).map((granularity) => (
            <label key={granularity} className={cn(
              "cursor-pointer rounded-md px-3 py-1.5 text-[13px] transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/70",
              query.granularity === granularity ? "bg-raised font-medium text-ink" : "text-ink-secondary hover:text-ink",
            )}>
              <input type="radio" name={name} value={granularity} checked={query.granularity === granularity} className="sr-only"
                onChange={() => onChange({ granularity, count: PRESETS[granularity][0]!.count })} />
              {t(`report.granularity.${granularity}` as LocaleKey)}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink-secondary">
        {t("report.window")}
        <select value={custom ? "custom" : String(query.count ?? PRESETS[query.granularity][0]!.count)}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "custom") onChange({ granularity: query.granularity, from: normalize(report ? new Date(report.period.from).toISOString().slice(0, 10) : today), to: normalize(today) });
            else onChange({ granularity: query.granularity, count: Number(value) });
          }}
          className="h-9 rounded-lg border border-hairline/60 bg-panel px-2.5 text-[13px] font-normal text-ink">
          {PRESETS[query.granularity].map((preset) => <option key={preset.count} value={preset.count}>{t(preset.label)}</option>)}
          <option value="custom">{t("report.preset.custom")}</option>
        </select>
      </label>
      {custom && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (from && to) onChange({ granularity: query.granularity, from: normalize(from), to: normalize(to) }); }}>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-ink-secondary">
            {t("report.range.from")}
            <input type={inputType} value={normalize(from)} max={normalize(to)} onChange={(event) => setFrom(event.target.value)} required
              className="h-9 rounded-lg border border-hairline/60 bg-panel px-2.5 text-[13px] font-normal text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-ink-secondary">
            {t("report.range.to")}
            <input type={inputType} value={normalize(to)} min={normalize(from)} max={normalize(today)} onChange={(event) => setTo(event.target.value)} required
              className="h-9 rounded-lg border border-hairline/60 bg-panel px-2.5 text-[13px] font-normal text-ink" />
          </label>
          <button type="submit" className="h-9 rounded-lg border border-hairline/60 bg-panel px-3 text-[13px] font-medium text-ink hover:bg-control">{t("report.range.apply")}</button>
        </form>
      )}
      {report && (
        <p className="basis-full text-[12px] text-ink-secondary sm:ml-auto sm:basis-auto sm:text-right">
          <span className="text-ink">{t("report.period", { period: periodLabel(report.period, report.granularity) })}</span>
          <br />
          {t("report.compared", { period: periodLabel(report.previous, report.granularity) })}
        </p>
      )}
    </section>
  );
}

// ── KPI cards ───────────────────────────────────────────────────────────────

function DeltaLine({ current, previous, polarity, kind = "count" }: { current: number | null; previous: number | null; polarity: Polarity; kind?: "count" | "span" }) {
  const text = formatDelta(current, previous, kind);
  const tone: Tone = deltaTone(current, previous, polarity);
  if (text === null) return <p className="text-[12px] text-ink-secondary">{t("report.delta.none")}</p>;
  if (text === "=") return <p className="flex items-center gap-1 text-[12px] text-ink-secondary"><Minus size={13} aria-hidden />{t("report.delta.same")}</p>;
  const up = !text.startsWith("−");
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <p className={cn("flex items-center gap-1 text-[12px]", tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : "text-ink-secondary")}>
      <Icon size={13} aria-hidden />
      <span>{t("report.delta.vsPrevious", { delta: text })}</span>
      {tone !== "neutral" && <span className="sr-only">({t(tone === "good" ? "report.delta.better" : "report.delta.worse")})</span>}
    </p>
  );
}

export function Definition({ label, text }: { label: string; text: string }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <button type="button" aria-label={t("report.definitionOf", { metric: label })} aria-describedby={id}
        className="flex size-5 items-center justify-center rounded-full text-ink-secondary hover:text-ink">
        <Info size={13} aria-hidden />
      </button>
      <span role="tooltip" id={id}
        className="invisible absolute right-0 top-6 z-20 w-64 rounded-lg border border-hairline/60 bg-menu p-2.5 text-[12px] font-normal leading-snug text-ink shadow-lg group-focus-within:visible group-hover:visible">
        {text}
      </span>
    </span>
  );
}

export function KpiCard({ label, value, detail, definition, current, previous, polarity, kind, noBase }: {
  label: string; value: string; detail?: string; definition: string; current: number | null; previous: number | null; polarity: Polarity; kind?: "count" | "span";
  /** No release source covers the previous period: its production numbers are unknown, not zero. */
  noBase?: boolean;
}) {
  return (
    <article className="flex min-w-0 flex-col gap-1 rounded-xl border border-hairline/40 bg-card p-4">
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-[12.5px] font-medium leading-snug text-ink-secondary">{label}</h3>
        <Definition label={label} text={definition} />
      </header>
      <p className="text-[26px] font-semibold leading-tight tabular-nums text-ink">{value}</p>
      {detail && <p className="text-[12px] text-ink-secondary">{detail}</p>}
      {noBase ? <p className="text-[12px] text-ink-secondary">{t("report.delta.noSource")}</p> : <DeltaLine current={current} previous={previous} polarity={polarity} kind={kind} />}
    </article>
  );
}

export function KpiGrid({ report }: { report: ProductivityReport }) {
  const k = report.kpis;
  const p = report.previousKpis;
  const b = report.backlog;
  const noBase = !releaseComparable(report);
  return (
    <section aria-labelledby="report-kpis" className="space-y-2">
      <h2 id="report-kpis" className="sr-only">{t("report.kpis")}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label={t("report.kpi.deliveries")} value={formatCount(k.deliveries)} definition={t("report.kpi.deliveries.def")}
          detail={t("report.kpi.deliveries.detail", { prs: formatCount(k.deliveredPrs), issues: formatCount(k.deliveredIssues) })}
          current={k.deliveries} previous={p.deliveries} polarity="up" noBase={noBase} />
        <KpiCard label={t("report.kpi.mergedPrs")} value={formatCount(k.mergedPrs)} definition={t("report.kpi.mergedPrs.def")}
          detail={t("report.kpi.mergedPrs.detail", { carriers: formatCount(k.carrierPrs) })}
          current={k.mergedPrs} previous={p.mergedPrs} polarity="up" />
        <KpiCard label={t("report.kpi.closedIssues")} value={formatCount(k.closedIssues - k.closedNotPlanned)} definition={t("report.kpi.closedIssues.def")}
          detail={t("report.kpi.closedIssues.detail", { bugs: formatCount(k.closedByType.bug), improvements: formatCount(k.closedByType.improvement), p1: formatCount(k.closedByPriority.p0 + k.closedByPriority.p1), p2: formatCount(k.closedByPriority.p2) })}
          current={k.closedIssues - k.closedNotPlanned} previous={p.closedIssues - p.closedNotPlanned} polarity="up" />
        <KpiCard label={t("report.kpi.lead")} value={formatSpan(k.leadIssueToProd.median)} definition={t("report.kpi.lead.def")}
          detail={k.leadIssueToProd.n ? t("report.kpi.lead.detail", { p90: formatSpan(k.leadIssueToProd.p90), n: formatCount(k.leadIssueToProd.n), merge: formatSpan(k.leadIssueToMerge.median), prod: formatSpan(k.leadMergeToProd.median) }) : t("report.kpi.lead.none")}
          current={k.leadIssueToProd.median} previous={p.leadIssueToProd.median} polarity="down" kind="span" noBase={noBase} />
        <KpiCard label={t("report.kpi.backlog")} value={formatCount(b.openP0 + b.openP1)} definition={t("report.kpi.backlog.def")}
          detail={t("report.kpi.backlog.detail", { open: formatCount(b.openIssues), p0: formatCount(b.openP0), oldest: b.oldestOpenP1 ? `#${b.oldestOpenP1.number} · ${formatSpan(report.generatedAt - b.oldestOpenP1.createdAt)}` : "—" })}
          current={k.openP1AtEnd} previous={p.openP1AtEnd} polarity="down" />
        <KpiCard label={t("report.kpi.gate")} value={formatCount(b.prsAwaitingGate)} definition={t("report.kpi.gate.def")}
          detail={t("report.kpi.gate.detail", { open: formatCount(b.openPrs) })}
          current={null} previous={null} polarity="down" />
        <KpiCard label={t("report.kpi.failures")} value={formatCount(k.failedReleases)} definition={t("report.kpi.failures.def")}
          detail={t("report.kpi.failures.detail", { declined: formatCount(k.declinedReleases) })}
          current={k.failedReleases} previous={p.failedReleases} polarity="down" noBase={noBase} />
        <KpiCard label={t("report.kpi.blocked")} value={formatSpan(k.blockedMs)} definition={t("report.kpi.blocked.def")}
          detail={t("report.kpi.blocked.detail")}
          current={k.blockedMs} previous={p.blockedMs} polarity="down" kind="span" noBase={noBase} />
      </div>
    </section>
  );
}

// ── charts ──────────────────────────────────────────────────────────────────

function chartSummary(buckets: ReportBucket[], granularity: Granularity, series: ChartSeries): string {
  const known = buckets.filter((bucket) => !(series.releaseMetric && bucket.releaseCoverage === "none"));
  const total = known.reduce((sum, bucket) => sum + (series.value(bucket) ?? 0), 0);
  const peak = known.reduce<ReportBucket | null>((best, bucket) => (best === null || (series.value(bucket) ?? 0) > (series.value(best) ?? 0) ? bucket : best), null);
  if (!peak || total === 0) return t("report.chart.summaryNone", { series: series.label });
  return t("report.chart.summary", { series: series.label, total: (series.format ?? formatCount)(total), peak: (series.format ?? formatCount)(series.value(peak) ?? 0), when: bucketName(peak, granularity) });
}

export function ReportCharts({ report }: { report: ProductivityReport }) {
  const g = report.granularity;
  const buckets = report.buckets;
  const deliveries: ChartSeries = { key: "deliveries", label: t("report.series.deliveries"), color: "var(--color-accent-text)", value: (bucket) => bucket.deliveries, releaseMetric: true };
  const failures: ChartSeries = { key: "failures", label: t("report.series.failures"), color: "var(--color-danger)", value: (bucket) => bucket.failedReleases, releaseMetric: true };
  const merged: ChartSeries = { key: "merged", label: t("report.series.mergedPrs"), color: "var(--color-accent-text)", value: (bucket) => bucket.mergedPrs };
  const closed: ChartSeries = { key: "closed", label: t("report.series.closedIssues"), color: "var(--color-ink-secondary)", value: (bucket) => bucket.closedIssues };
  const backlog: ChartSeries = { key: "backlog", label: t("report.series.openIssues"), color: "var(--color-accent-text)", value: (bucket) => bucket.openIssuesAtEnd };
  const turns: ChartSeries = { key: "turns", label: t("report.series.turns"), color: "var(--color-ink-secondary)", value: (bucket) => bucket.turns };
  const active: ChartSeries = { key: "active", label: t("report.series.activeHours"), color: "var(--color-accent-text)", value: (bucket) => Math.round((bucket.activeMs / 3_600_000) * 10) / 10, format: (value) => `${formatCount(value, 1)} h` };
  return (
    <section aria-labelledby="report-charts" className="space-y-2">
      <h2 id="report-charts" className="sr-only">{t("report.charts")}</h2>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <BarChart id="chart-deliveries" title={t("report.chart.deliveries")} summary={`${chartSummary(buckets, g, deliveries)} ${chartSummary(buckets, g, failures)}`} buckets={buckets} granularity={g} series={[deliveries, failures]} now={report.generatedAt} />
        <BarChart id="chart-throughput" title={t("report.chart.throughput")} summary={`${chartSummary(buckets, g, merged)} ${chartSummary(buckets, g, closed)}`} buckets={buckets} granularity={g} series={[merged, closed]} now={report.generatedAt} />
        <LineChart id="chart-backlog" title={t("report.chart.backlog")} summary={t("report.chart.backlogSummary", { end: formatCount(report.kpis.openIssuesAtEnd), start: formatCount(buckets[0]?.openIssuesAtEnd ?? 0) })} buckets={buckets} granularity={g} series={backlog} now={report.generatedAt} />
        <BarChart id="chart-bots" title={t("report.chart.bots")} summary={`${chartSummary(buckets, g, turns)} ${chartSummary(buckets, g, active)}`} buckets={buckets} granularity={g} series={[turns, active]} now={report.generatedAt} />
      </div>
    </section>
  );
}

// ── releases ────────────────────────────────────────────────────────────────

// outlined, never tinted: the status colour stays on the card it was measured on (pnpm check:contrast)
const OUTCOME_STYLE: Record<ReportRelease["outcome"], string> = {
  released: "border border-success/60 text-success",
  failed: "border border-danger/60 text-danger",
  declined: "border border-hairline text-ink-secondary",
};

function ReleaseRow({ release }: { release: ReportRelease }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const approximate = release.timeSource !== "log";
  const prs = release.prs.filter((pr) => !pr.carrier);
  const expandable = release.outcome === "released" ? release.prs.length > 0 || release.issues.length > 0 : Boolean(release.cause);
  const outcome = t(`report.outcome.${release.outcome}` as LocaleKey);
  return (
    <>
      <tr className="border-t border-hairline/30 align-top">
        <td className="whitespace-nowrap px-3 py-2 text-ink">
          {expandable ? (
            <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)}
              aria-label={t("report.releases.details", { sha: release.sha.slice(0, 9) })}
              className="mr-1 inline-flex size-5 items-center justify-center rounded text-ink-secondary hover:bg-control hover:text-ink">
              {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            </button>
          ) : <span className="mr-1 inline-block w-5" />}
          <span title={approximate ? t(`report.timeSource.${release.timeSource}` as LocaleKey) : undefined}>{approximate ? "≈ " : ""}{formatWhen(release.at)}</span>
          {approximate && <span className="sr-only"> ({t(`report.timeSource.${release.timeSource}` as LocaleKey)})</span>}
        </td>
        <td className="px-3 py-2 font-mono text-[12px] text-ink">{release.sha.slice(0, 9)}</td>
        <td className="px-3 py-2">
          <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11.5px] font-medium", OUTCOME_STYLE[release.outcome])}>{outcome}</span>
          {release.outcome === "failed" && (release.attempts ?? 1) > 1 && <span className="ml-1.5 text-[12px] text-ink-secondary">{t("report.releases.attempts", { count: String(release.attempts) })}</span>}
        </td>
        <td className="px-3 py-2 text-ink">
          {release.outcome === "released"
            ? release.contentUnknown ? <span className="text-ink-secondary">{t("report.releases.contentUnknown")}</span>
              : prs.length ? prs.slice(0, 8).map((pr) => `#${pr.number}`).join(", ") + (prs.length > 8 ? ` +${prs.length - 8}` : "") : "—"
            : release.carrierPr ? <span className="text-ink-secondary">{t("report.releases.carrier", { number: String(release.carrierPr) })}</span> : "—"}
        </td>
        <td className="px-3 py-2 text-ink">
          {release.outcome === "released" && release.issues.length ? release.issues.slice(0, 8).map((issue) => `#${issue.number}`).join(", ") + (release.issues.length > 8 ? ` +${release.issues.length - 8}` : "") : "—"}
        </td>
      </tr>
      {expandable && open && (
        <tr id={detailsId} className="bg-inset/40">
          <td colSpan={5} className="px-3 pb-3 pt-1 text-[12.5px]">
            {release.outcome === "released" ? (
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <h4 className="mb-1 text-[12px] font-medium text-ink-secondary">{t("report.releases.prs")}</h4>
                  <ul className="space-y-0.5">{release.prs.map((pr) => <li key={pr.number} className="text-ink"><span className="tabular-nums">#{pr.number}</span> {pr.title}{pr.carrier ? <span className="text-ink-secondary"> · {t("report.releases.carrierTag")}</span> : null}</li>)}</ul>
                </div>
                <div>
                  <h4 className="mb-1 text-[12px] font-medium text-ink-secondary">{t("report.releases.issues")}</h4>
                  {release.issues.length ? <ul className="space-y-0.5">{release.issues.map((issue) => <li key={issue.number} className="text-ink"><span className="tabular-nums">#{issue.number}</span> {issue.title}<span className="text-ink-secondary"> · {t(`report.type.${issue.type ?? "other"}` as LocaleKey)}{issue.priority && issue.priority !== "none" ? ` · ${issue.priority.toUpperCase()}` : ""}</span></li>)}</ul> : <p className="text-ink-secondary">—</p>}
                </div>
              </div>
            ) : (
              <p className="text-ink"><span className="text-ink-secondary">{t("report.releases.cause")}</span> {release.cause}{release.firstAt && release.firstAt !== release.at ? <span className="text-ink-secondary"> · {t("report.releases.since", { when: formatWhen(release.firstAt) })}</span> : null}</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function ReleasesTable({ releases }: { releases: ReportRelease[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? releases : releases.slice(0, 15);
  return (
    <section aria-labelledby="report-releases" className="rounded-xl border border-hairline/40 bg-card">
      <header className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-2 pt-4">
        <h2 id="report-releases" className="text-[14px] font-semibold text-ink">{t("report.releases.title")}</h2>
        <p className="text-[12px] text-ink-secondary">{t("report.releases.count", { released: formatCount(releases.filter((release) => release.outcome === "released").length), failed: formatCount(releases.filter((release) => release.outcome === "failed").length), declined: formatCount(releases.filter((release) => release.outcome === "declined").length) })}</p>
      </header>
      {releases.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-ink-secondary">{t("report.releases.empty")}</p>
      ) : (
        <div tabIndex={0} role="region" aria-label={t("report.releases.table")} className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="text-[12px] text-ink-secondary">
                <th scope="col" className="px-3 py-2 font-medium">{t("report.releases.when")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("report.releases.commit")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("report.releases.outcome")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("report.releases.prs")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("report.releases.issues")}</th>
              </tr>
            </thead>
            <tbody>{shown.map((release) => <ReleaseRow key={`${release.outcome}:${release.sha}:${release.at}`} release={release} />)}</tbody>
          </table>
        </div>
      )}
      {releases.length > 15 && (
        <div className="border-t border-hairline/30 px-4 py-2">
          <button type="button" onClick={() => setAll((value) => !value)} className="text-[12.5px] font-medium text-accent hover:underline">
            {all ? t("report.releases.fewer") : t("report.releases.all", { count: formatCount(releases.length) })}
          </button>
        </div>
      )}
    </section>
  );
}

// ── backlog and bots ────────────────────────────────────────────────────────

export function BacklogPanel({ report }: { report: ProductivityReport }) {
  const b = report.backlog;
  const rows: Array<[string, string]> = [
    [t("report.backlog.open"), formatCount(b.openIssues)],
    [t("report.backlog.p0"), formatCount(b.openP0)],
    [t("report.backlog.p1"), formatCount(b.openP1)],
    [t("report.backlog.oldest"), b.oldestOpen ? t("report.backlog.age", { number: String(b.oldestOpen.number), age: formatSpan(report.generatedAt - b.oldestOpen.createdAt), since: formatWhen(b.oldestOpen.createdAt, false) }) : "—"],
    [t("report.backlog.oldestP1"), b.oldestOpenP1 ? t("report.backlog.age", { number: String(b.oldestOpenP1.number), age: formatSpan(report.generatedAt - b.oldestOpenP1.createdAt), since: formatWhen(b.oldestOpenP1.createdAt, false) }) : "—"],
  ];
  return (
    <section aria-labelledby="report-backlog" className="rounded-xl border border-hairline/40 bg-card p-4">
      <h2 id="report-backlog" className="text-[14px] font-semibold text-ink">{t("report.backlog.title")}</h2>
      <p className="mb-2 text-[12px] text-ink-secondary">{b.at ? t("report.backlog.asOf", { when: formatWhen(b.at) }) : t("report.sync.never")}</p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[13px]">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-ink-secondary">{term}</dt>
            <dd className="text-right tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <h3 className="mb-1 mt-4 text-[12.5px] font-medium text-ink-secondary">{t("report.backlog.gate", { count: formatCount(b.prsAwaitingGate), open: formatCount(b.openPrs) })}</h3>
      {b.prsAwaitingGateList.length ? (
        <ul className="space-y-1 text-[13px]">
          {b.prsAwaitingGateList.slice(0, 8).map((pr) => (
            <li key={pr.number} className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 tabular-nums text-ink">#{pr.number}</span>
              <span className="min-w-0 flex-1 truncate text-ink" title={pr.title}>{pr.title}</span>
              <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", pr.gate === "failure" ? "border-danger/60 text-danger" : "border-hairline text-ink-secondary")}>{t(`report.gate.${pr.gate}` as LocaleKey)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-[13px] text-ink-secondary">{t("report.backlog.gateNone")}</p>}
    </section>
  );
}

export function BotsPanel({ report }: { report: ProductivityReport }) {
  const k = report.kpis;
  return (
    <section aria-labelledby="report-bots" className="min-w-0 rounded-xl border border-hairline/40 bg-card p-4">
      <h2 id="report-bots" className="text-[14px] font-semibold text-ink">{t("report.bots.title")}</h2>
      <p className="mb-2 text-[12px] text-ink-secondary">
        {t("report.bots.totals", { turns: formatCount(k.turns), active: k.timedTurns ? formatSpan(k.activeMs) : "—", cost: formatUsd(k.costUsd), tokens: formatTokens(k.inputTokens + k.outputTokens) })}
      </p>
      <p className="mb-3 text-[12px] text-ink-secondary">
        {k.ownerResponse.n
          ? t("report.bots.owner", { opened: formatCount(k.needsYouOpened), resolved: formatCount(k.needsYouResolved), median: formatSpan(k.ownerResponse.median), p90: formatSpan(k.ownerResponse.p90), n: formatCount(k.ownerResponse.n) })
          : t("report.bots.ownerNone", { opened: formatCount(k.needsYouOpened), resolved: formatCount(k.needsYouResolved) })}
      </p>
      {report.bots.length === 0 ? <p className="text-[13px] text-ink-secondary">{t("report.bots.empty")}</p> : (
        <div tabIndex={0} role="region" aria-label={t("report.bots.table")} className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="text-[12px] text-ink-secondary">
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("report.bots.bot")}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{t("report.bots.turns")}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{t("report.bots.active")}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{t("report.bots.cost")}</th>
                <th scope="col" className="py-1.5 pl-2 text-right font-medium">{t("report.bots.needsYou")}</th>
              </tr>
            </thead>
            <tbody>
              {report.bots.map((bot) => (
                <tr key={bot.botId} className="border-t border-hairline/30">
                  <th scope="row" className="max-w-[180px] truncate py-1.5 pr-3 font-normal text-ink" title={bot.name}>{bot.name}</th>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink">{formatCount(bot.turns)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink">{bot.timedTurns ? formatSpan(bot.activeMs) : "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink">{formatUsd(bot.costUsd)}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums text-ink">{t("report.bots.needsYouCell", { opened: formatCount(bot.needsYouOpened), resolved: formatCount(bot.needsYouResolved), open: formatCount(bot.needsYouOpenNow) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── definitions and coverage ────────────────────────────────────────────────

const DEFINITIONS: Array<[LocaleKey, LocaleKey]> = [
  ["report.kpi.deliveries", "report.kpi.deliveries.def"],
  ["report.kpi.mergedPrs", "report.kpi.mergedPrs.def"],
  ["report.kpi.closedIssues", "report.kpi.closedIssues.def"],
  ["report.kpi.lead", "report.kpi.lead.def"],
  ["report.kpi.backlog", "report.kpi.backlog.def"],
  ["report.kpi.gate", "report.kpi.gate.def"],
  ["report.kpi.failures", "report.kpi.failures.def"],
  ["report.kpi.blocked", "report.kpi.blocked.def"],
  ["report.bots.title", "report.bots.def"],
];

export function CoverageNotes({ report }: { report: ProductivityReport }) {
  const c = report.coverage;
  const lines: string[] = [];
  if (c.releaseLog.from !== null) lines.push(t("report.coverage.log", { since: formatWhen(c.releaseLog.from) }));
  if (c.githubDeployments.from !== null) lines.push(t("report.coverage.deployments", { from: formatWhen(c.githubDeployments.from), to: formatWhen(c.githubDeployments.to!) }));
  lines.push(c.github.syncedAt ? t(c.github.complete ? "report.coverage.github" : "report.coverage.githubPartial", { when: formatWhen(c.github.syncedAt), prs: formatCount(c.github.prs), issues: formatCount(c.github.issues) }) : t("report.sync.never"));
  if (c.tag.sha) lines.push(t(c.tag.matchesHistory === false ? "report.coverage.tagMismatch" : c.tag.matchesHistory ? "report.coverage.tag" : "report.coverage.tagUnknown", { sha: c.tag.sha.slice(0, 9) }));
  if (c.usage.from !== null) lines.push(t("report.coverage.usage", { since: formatWhen(c.usage.from) }));
  if (c.digests.from !== null) lines.push(t("report.coverage.digests", { since: formatWhen(c.digests.from) }));
  if (c.needsYou.from !== null) lines.push(t("report.coverage.needsYou", { since: formatWhen(c.needsYou.from) }));
  return (
    <section aria-labelledby="report-definitions" className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-xl border border-hairline/40 bg-card p-4">
        <h2 id="report-definitions" className="mb-2 text-[14px] font-semibold text-ink">{t("report.definitions")}</h2>
        <dl className="space-y-2 text-[12.5px] leading-snug">
          {DEFINITIONS.map(([term, text]) => (
            <div key={term}><dt className="font-medium text-ink">{t(term)}</dt><dd className="text-ink-secondary">{t(text)}</dd></div>
          ))}
        </dl>
      </div>
      <div className="rounded-xl border border-hairline/40 bg-card p-4">
        <h2 className="mb-2 text-[14px] font-semibold text-ink">{t("report.coverage.title")}</h2>
        <ul className="list-disc space-y-1.5 pl-4 text-[12.5px] leading-snug text-ink-secondary">
          {lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
    </section>
  );
}

// ── the body, given a report (rendered as is by the component tests) ────────

export function ReportView({ report }: { report: ProductivityReport }) {
  const lines = summaryLines(report);
  const gaps = report.coverage.releaseGaps;
  return (
    <div className="space-y-4">
      {gaps.length > 0 && (
        <div role="note" className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] text-ink">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          <p>{t("report.gaps", { gaps: gaps.map((gap) => `${formatWhen(gap.from, false)} – ${formatWhen(gap.to, false)}`).join("; ") })}</p>
        </div>
      )}
      {lines.length > 0 && (
        <section aria-labelledby="report-summary" className="rounded-xl border border-hairline/40 bg-card p-4">
          <h2 id="report-summary" className="mb-2 text-[14px] font-semibold text-ink">{t("report.summary.title")}</h2>
          <ol className="list-decimal space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-ink marker:text-ink-secondary">
            {lines.map((line) => <li key={line}>{line}</li>)}
          </ol>
        </section>
      )}
      <KpiGrid report={report} />
      <ReportCharts report={report} />
      <ReleasesTable releases={report.releases} />
      <div className="grid gap-3 lg:grid-cols-2">
        <BacklogPanel report={report} />
        <BotsPanel report={report} />
      </div>
      <CoverageNotes report={report} />
    </div>
  );
}

function SyncStatus({ report, busy }: { report: ProductivityReport | null; busy: boolean }) {
  if (!report) return null;
  const sync = report.sync;
  if (busy || sync.state === "syncing") return <span role="status" className="flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={13} className="animate-spin" aria-hidden />{t("report.sync.running")}</span>;
  if (sync.state === "error") return <span role="status" className="flex min-w-0 max-w-[420px] items-center gap-1.5 text-[12px] text-ink" title={sync.error ?? ""}><AlertTriangle size={13} className="shrink-0 text-danger" aria-hidden /><span className="truncate">{t("report.sync.error", { error: sync.error ?? "" })}</span></span>;
  if (sync.state === "rate-limited" && sync.rateLimit) return <span role="status" className="flex items-center gap-1.5 text-[12px] text-ink"><AlertTriangle size={13} className="shrink-0 text-warning" aria-hidden />{t("report.sync.rateLimited", { when: formatWhen(sync.rateLimit.resetAt) })}</span>;
  const minutes = minutesSince(sync.lastSyncAt);
  return <span role="status" className="text-[12px] text-ink-secondary">{minutes === null ? t("report.sync.never") : minutes < 1 ? t("report.sync.justNow") : t("report.sync.updated", { minutes: formatCount(minutes) })}</span>;
}

function ExportMenu({ query, disabled }: { query: ReportQuery; disabled: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => { ref.current?.removeAttribute("open"); ref.current?.querySelector("summary")?.focus(); };
  return (
    <details ref={ref} className={cn("relative", disabled && "pointer-events-none opacity-60")}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.removeAttribute("open"); }}
      onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <summary className="flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium hover:opacity-90 [&::-webkit-details-marker]:hidden">
        <Download size={15} aria-hidden />{t("report.export")}
      </summary>
      <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-xl border border-hairline/60 bg-menu p-1.5 shadow-xl">
        <a href={reportPath(query, { format: "pdf" })} download onClick={close} className="flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-[13px] text-ink hover:bg-control">
          <FileText size={16} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden />
          <span><span className="block font-medium">{t("report.export.pdf")}</span><span className="block text-[12px] text-ink-secondary">{t("report.export.pdfHint")}</span></span>
        </a>
        <a href={reportPath(query, { format: "md" })} download onClick={close} className="flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-[13px] text-ink hover:bg-control">
          <FileText size={16} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden />
          <span><span className="block font-medium">{t("report.export.md")}</span><span className="block text-[12px] text-ink-secondary">{t("report.export.mdHint")}</span></span>
        </a>
        <p className="px-3 pb-1.5 pt-1 text-[11.5px] text-ink-secondary">{t("report.export.note")}</p>
      </div>
    </details>
  );
}

function Skeleton() {
  return (
    <div aria-hidden className="space-y-4">
      <div className="h-36 animate-pulse rounded-xl bg-card" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="h-32 animate-pulse rounded-xl bg-card" />)}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-64 animate-pulse rounded-xl bg-card" />)}
      </div>
    </div>
  );
}

export function ReportPage() {
  const [query, setQuery] = useState<ReportQuery>(loadQuery);
  const [report, setReport] = useState<ProductivityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const request = ++requestRef.current;
    try {
      const next = await api<ProductivityReport>(reportPath(query, { refresh }), { timeoutMs: 30_000 });
      if (request !== requestRef.current) return;
      setReport(next);
      setError(null);
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) { setLoading(false); setRefreshing(false); }
    }
  }, [query]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => {
    const every = report?.sync.state === "syncing" || refreshing ? SYNC_POLL_MS : POLL_MS;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, every);
    return () => window.clearInterval(timer);
  }, [load, report?.sync.state, refreshing]);

  const change = (next: ReportQuery) => { saveQuery(next); setQuery(next); };
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink" aria-labelledby="report-title" aria-busy={loading}>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline/40 px-6 py-4 max-md:pl-12">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <BarChart3 size={18} className="text-ink-secondary" aria-hidden />
            <h1 id="report-title" className="text-[17px] font-semibold">{t("report.title")}</h1>
          </div>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("report.subtitle", { repo: report?.repo ?? "dinhogehm/nuria-platform" })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SyncStatus report={report} busy={refreshing} />
          <button type="button" onClick={() => { setRefreshing(true); void load(true); }} disabled={refreshing || report?.enabled === false}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-hairline/60 bg-panel px-3 text-[13px] font-medium text-ink hover:bg-control disabled:opacity-60">
            <RefreshCw size={14} className={cn(refreshing && "animate-spin")} aria-hidden />{t("report.refresh")}
          </button>
          <ExportMenu query={query} disabled={!report || report.enabled === false} />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1280px] space-y-4 px-4 py-5 sm:px-6">
          <PeriodBar query={query} onChange={change} report={report} />
          {error && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-2.5 text-[13px] text-danger">
              {t("report.error", { error })}
              <button type="button" onClick={() => { setLoading(true); void load(); }} className="rounded-md px-2 py-1 font-medium hover:bg-danger/10">{t("report.retry")}</button>
            </div>
          )}
          {loading && !report ? <Skeleton /> : report ? (
            report.enabled === false ? (
              <section className="rounded-xl border border-hairline/40 bg-card p-6 text-center">
                <h2 className="text-[15px] font-semibold text-ink">{t("report.disabled.title")}</h2>
                <p className="mx-auto mt-1 max-w-xl text-[13px] text-ink-secondary">{t("report.disabled.body")}</p>
              </section>
            ) : <ReportView report={report} />
          ) : null}
        </div>
      </div>
    </main>
  );
}
