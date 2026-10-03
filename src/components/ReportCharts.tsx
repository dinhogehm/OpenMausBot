// The report's charts (lot V): plain SVG bars and a line, sized to their box,
// in the skin's own tokens (text tones on a card clear 4.5:1 in every skin, so
// the marks do too). Each chart is a figure with a caption, a one-sentence
// description for screen readers, a hover read-out for the pointer, and the
// same numbers as a table one click away — the keyboard and screen-reader path.
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { bucketName, bucketTick, formatCount, type Granularity, type ReportBucket } from "@/lib/productivity";

export interface ChartSeries {
  key: string;
  label: string;
  /** A CSS colour, normally a skin token: var(--color-accent-text). */
  color: string;
  value: (bucket: ReportBucket) => number | null;
  /** Where the number comes from: unknown (not zero) where that source does not
   * cover the bucket — the release history for production numbers, this
   * computer's usage ledger for the bots'. */
  source?: "release" | "usage";
  format?: (value: number) => string;
}

/** The series has no source for this bucket: its value is unknown, not zero. */
export function unknownAt(series: ChartSeries, bucket: ReportBucket): boolean {
  if (series.source === "release") return bucket.releaseCoverage === "none";
  if (series.source === "usage") return bucket.usageCoverage === "none" || series.value(bucket) === null;
  return false;
}

const PLOT_HEIGHT = 168;
const AXIS_LEFT = 40;
const AXIS_BOTTOM = 22;
const TOP = 8;

/** A round axis ceiling and step: 0, 5, 10… or 0, 20, 40… */
export function niceScale(max: number): { ceiling: number; step: number } {
  if (!(max > 0)) return { ceiling: 1, step: 1 };
  if (max <= 4) return { ceiling: Math.ceil(max), step: 1 };
  // at most five steps: 223 → 0…250 by 50, not 0…300 by 100
  const rough = max / 5;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  // 1-2-5 steps: counts never get a fractional tick ("2,5" read as "3")
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough)!;
  return { ceiling: Math.ceil(max / step) * step, step };
}

function useWidth(fallback: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? fallback);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width];
}

function Legend({ series, showNoSource }: { series: ChartSeries[]; showNoSource: boolean }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-secondary">
      {series.map((each) => (
        <li key={each.key} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: each.color }} />
          {each.label}
        </li>
      ))}
      {showNoSource && (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="report-nosource inline-block size-2.5 rounded-sm border border-hairline" />
          {t("report.chart.noSource")}
        </li>
      )}
    </ul>
  );
}

function DataTable({ id, buckets, granularity, series, caption }: { id: string; buckets: ReportBucket[]; granularity: Granularity; series: ChartSeries[]; caption: string }) {
  return (
    <details className="mt-2 text-[12px]">
      <summary className="w-fit cursor-pointer rounded text-ink-secondary hover:text-ink">{t("report.chart.showData")}</summary>
      {/* a scrolling region is reachable by keyboard (axe scrollable-region-focusable) */}
      <div tabIndex={0} role="region" aria-label={t("report.table.of", { chart: caption })} className="mt-2 max-h-64 overflow-auto rounded-lg border border-hairline/40">
        <table className="w-full border-collapse text-left" aria-describedby={`${id}-title`}>
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-card">
            <tr>
              <th scope="col" className="px-2 py-1.5 font-medium text-ink-secondary">{t("report.table.period")}</th>
              {series.map((each) => <th key={each.key} scope="col" className="px-2 py-1.5 text-right font-medium text-ink-secondary">{each.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.key} className="border-t border-hairline/30">
                <th scope="row" className="px-2 py-1 font-normal text-ink">{bucketName(bucket, granularity)}</th>
                {series.map((each) => {
                  const unknown = unknownAt(each, bucket);
                  const value = each.value(bucket);
                  return <td key={each.key} className="px-2 py-1 text-right tabular-nums text-ink">{unknown ? t("report.chart.unknown") : value === null ? "—" : (each.format ?? formatCount)(value)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Grouped bars, one group per bucket. */
export function BarChart({ id, title, summary, buckets, granularity, series, now }: {
  id: string; title: string; summary: string; buckets: ReportBucket[]; granularity: Granularity; series: ChartSeries[]; now: number;
}) {
  const [box, width] = useWidth(640);
  const [hover, setHover] = useState<number | null>(null);
  const plotWidth = Math.max(120, width - AXIS_LEFT - 4);
  const max = useMemo(() => Math.max(0, ...buckets.flatMap((bucket) => series.map((each) => (unknownAt(each, bucket) ? 0 : each.value(bucket) ?? 0)))), [buckets, series]);
  const { ceiling, step } = niceScale(max);
  const slot = plotWidth / Math.max(1, buckets.length);
  const barWidth = Math.max(1.5, Math.min(22, (slot * 0.74) / series.length));
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotWidth / 46))));
  const y = (value: number) => TOP + PLOT_HEIGHT - (value / ceiling) * PLOT_HEIGHT;
  const ticks: number[] = [];
  for (let tick = 0; tick <= ceiling + 1e-9; tick += step) ticks.push(Math.round(tick * 1000) / 1000);
  // a bucket is hatched only when every series in it lacks a source
  const allUnknown = (bucket: ReportBucket) => bucket.start < now && series.every((each) => unknownAt(each, bucket));
  const noSource = buckets.some(allUnknown);
  const hovered = hover === null ? null : buckets[hover];
  return (
    <figure aria-labelledby={`${id}-title`} className="min-w-0 rounded-xl border border-hairline/40 bg-card p-4">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${id}-title`} className="text-[14px] font-semibold text-ink">{title}</h3>
        <Legend series={series} showNoSource={noSource} />
      </figcaption>
      <div ref={box} className="relative w-full" onMouseLeave={() => setHover(null)}>
        <svg role="img" aria-labelledby={`${id}-title ${id}-desc`} width={width} height={TOP + PLOT_HEIGHT + AXIS_BOTTOM} className="block overflow-visible">
          <desc id={`${id}-desc`}>{summary}</desc>
          <defs>
            <pattern id={`${id}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--color-card)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-hairline)" strokeWidth="3" />
            </pattern>
          </defs>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={AXIS_LEFT} x2={AXIS_LEFT + plotWidth} y1={y(tick)} y2={y(tick)} stroke="var(--color-hairline)" strokeWidth={tick === 0 ? 1 : 0.6} strokeDasharray={tick === 0 ? undefined : "2 3"} />
              <text x={AXIS_LEFT - 6} y={y(tick) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--color-ink-secondary)">{formatCount(tick)}</text>
            </g>
          ))}
          {buckets.map((bucket, index) => {
            const left = AXIS_LEFT + index * slot;
            const unknown = allUnknown(bucket);
            const groupLeft = left + (slot - barWidth * series.length) / 2;
            return (
              <g key={bucket.key}>
                {hover === index && <rect x={left} y={TOP} width={slot} height={PLOT_HEIGHT} fill="var(--color-control)" opacity={0.6} />}
                {unknown && <rect x={left + slot * 0.08} y={TOP} width={slot * 0.84} height={PLOT_HEIGHT} fill={`url(#${id}-hatch)`} />}
                {series.map((each, position) => {
                  if (unknownAt(each, bucket)) return null;
                  const value = each.value(bucket) ?? 0;
                  if (value <= 0) return null;
                  const top = y(value);
                  return <rect key={each.key} x={groupLeft + position * barWidth} y={top} width={Math.max(1, barWidth - (series.length > 1 ? 1 : 0))} height={TOP + PLOT_HEIGHT - top} rx={Math.min(2, barWidth / 3)} fill={each.color} />;
                })}
                {index % labelEvery === 0 && (
                  <text x={left + slot / 2} y={TOP + PLOT_HEIGHT + 15} textAnchor="middle" fontSize="10.5" fill="var(--color-ink-secondary)">{bucketTick(bucket.start, granularity)}</text>
                )}
                <rect x={left} y={TOP} width={slot} height={PLOT_HEIGHT} fill="transparent" onMouseEnter={() => setHover(index)} />
              </g>
            );
          })}
        </svg>
        {hovered && (
          <div aria-hidden className={cn("pointer-events-none absolute top-1 z-10 min-w-40 rounded-lg border border-hairline/60 bg-menu px-3 py-2 text-[12px] shadow-lg", hover! > buckets.length / 2 ? "-translate-x-full" : "")}
            style={{ left: AXIS_LEFT + hover! * slot + (hover! > buckets.length / 2 ? -6 : slot + 6) }}>
            <p className="mb-1 font-medium text-ink">{bucketName(hovered, granularity)}</p>
            {series.map((each) => {
              const unknown = unknownAt(each, hovered);
              const value = each.value(hovered);
              return (
                <p key={each.key} className="flex items-center justify-between gap-3 text-ink-secondary">
                  <span className="flex items-center gap-1.5"><span className="inline-block size-2 rounded-sm" style={{ background: each.color }} />{each.label}</span>
                  <span className="tabular-nums text-ink">{unknown ? t("report.chart.unknown") : value === null ? "—" : (each.format ?? formatCount)(value)}</span>
                </p>
              );
            })}
          </div>
        )}
      </div>
      <DataTable id={id} buckets={buckets} granularity={granularity} series={series} caption={title} />
    </figure>
  );
}

/** One series as a line with points (the backlog over time). */
export function LineChart({ id, title, summary, buckets, granularity, series, now }: {
  id: string; title: string; summary: string; buckets: ReportBucket[]; granularity: Granularity; series: ChartSeries; now: number;
}) {
  const [box, width] = useWidth(640);
  const [hover, setHover] = useState<number | null>(null);
  const plotWidth = Math.max(120, width - AXIS_LEFT - 4);
  const past = buckets.filter((bucket) => bucket.start < now);
  const values = past.map((bucket) => series.value(bucket) ?? 0);
  const min = Math.min(...values, Infinity);
  const max = Math.max(...values, 0);
  // a backlog of 200 moving by 10 is a line, not a flat bar: the axis starts near the minimum
  const floorScale = niceScale(Math.max(1, max - (Number.isFinite(min) ? min : 0)));
  const base = Number.isFinite(min) ? Math.max(0, Math.floor(min / floorScale.step) * floorScale.step - floorScale.step) : 0;
  const { ceiling, step } = niceScale(max - base);
  const slot = plotWidth / Math.max(1, buckets.length);
  const x = (index: number) => AXIS_LEFT + index * slot + slot / 2;
  const y = (value: number) => TOP + PLOT_HEIGHT - ((value - base) / ceiling) * PLOT_HEIGHT;
  const ticks: number[] = [];
  for (let tick = 0; tick <= ceiling + 1e-9; tick += step) ticks.push(base + Math.round(tick * 1000) / 1000);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotWidth / 46))));
  const points = past.map((bucket, index) => `${x(index).toFixed(1)},${y(series.value(bucket) ?? 0).toFixed(1)}`).join(" ");
  const hovered = hover === null ? null : past[hover];
  return (
    <figure aria-labelledby={`${id}-title`} className="min-w-0 rounded-xl border border-hairline/40 bg-card p-4">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${id}-title`} className="text-[14px] font-semibold text-ink">{title}</h3>
        <Legend series={[series]} showNoSource={false} />
      </figcaption>
      <div ref={box} className="relative w-full" onMouseLeave={() => setHover(null)}>
        <svg role="img" aria-labelledby={`${id}-title ${id}-desc`} width={width} height={TOP + PLOT_HEIGHT + AXIS_BOTTOM} className="block overflow-visible">
          <desc id={`${id}-desc`}>{summary}</desc>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={AXIS_LEFT} x2={AXIS_LEFT + plotWidth} y1={y(tick)} y2={y(tick)} stroke="var(--color-hairline)" strokeWidth={tick === base ? 1 : 0.6} strokeDasharray={tick === base ? undefined : "2 3"} />
              <text x={AXIS_LEFT - 6} y={y(tick) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--color-ink-secondary)">{formatCount(tick)}</text>
            </g>
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={TOP} y2={TOP + PLOT_HEIGHT} stroke="var(--color-hairline)" />}
          {past.length > 1 && <polyline points={points} fill="none" stroke={series.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {past.map((bucket, index) => (
            <circle key={bucket.key} cx={x(index)} cy={y(series.value(bucket) ?? 0)} r={hover === index ? 4 : past.length > 60 ? 0 : 2.5} fill={series.color} />
          ))}
          {buckets.map((bucket, index) => (
            <g key={bucket.key}>
              {index % labelEvery === 0 && <text x={x(index)} y={TOP + PLOT_HEIGHT + 15} textAnchor="middle" fontSize="10.5" fill="var(--color-ink-secondary)">{bucketTick(bucket.start, granularity)}</text>}
              {index < past.length && <rect x={AXIS_LEFT + index * slot} y={TOP} width={slot} height={PLOT_HEIGHT} fill="transparent" onMouseEnter={() => setHover(index)} />}
            </g>
          ))}
        </svg>
        {hovered && (
          <div aria-hidden className={cn("pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg border border-hairline/60 bg-menu px-3 py-2 text-[12px] shadow-lg", hover! > buckets.length / 2 ? "-translate-x-full" : "")}
            style={{ left: x(hover!) + (hover! > buckets.length / 2 ? -10 : 10) }}>
            <p className="mb-1 font-medium text-ink">{bucketName(hovered, granularity)}</p>
            <p className="flex items-center justify-between gap-3 text-ink-secondary"><span>{series.label}</span><span className="tabular-nums text-ink">{formatCount(series.value(hovered) ?? 0)}</span></p>
          </div>
        )}
      </div>
      {base > 0 && <p className="mt-1 text-[11.5px] text-ink-secondary">{t("report.chart.axisFrom", { value: formatCount(base) })}</p>}
      <DataTable id={id} buckets={past} granularity={granularity} series={[series]} caption={title} />
    </figure>
  );
}
