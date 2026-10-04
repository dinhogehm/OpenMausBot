// "Exportar para o board" (lot V): the productivity report as Markdown and as
// a PDF, both opening with a five-line executive summary — numbers and their
// trend, in pt-BR. What leaves the machine names work by its number only
// (PR #N, issue #N): titles, failure causes and bot answers stay in the app,
// so no client's name is ever exported.
//
// One board model (boardKpis) feeds the summary, the cards, the indicators
// table and the definitions, so the three never disagree. Comparisons follow
// one rule (shared compareKpi): a trend only on a comparable base of at least
// MIN_TREND_BASE (and MIN_TREND_SAMPLES for a median), the previous absolute
// value when the base is small, nothing when there is no comparable source
// or the previous period is older than the repository.
//
// The PDF is written by hand (PDF 1.4, the standard Helvetica fonts in
// WinAnsi, one Flate stream per page): no dependency, deterministic output.
import { deflateSync } from "node:zlib";
import {
  beforeRepo, compareKpi, exportReadiness, goalStatus, MIN_TREND_BASE, periodTitle, releaseComparable, releaseCountParts, REPORT_TZ, zonedParts,
  type Comparison, type GoalKey, type Granularity, type ProductivityReport, type ReportBucket,
} from "../shared/productivity.ts";

export type SummaryLang = "pt-BR" | "en";
export const PRODUCT_NAME = "Nuria Platform";

// ── formatting ──────────────────────────────────────────────────────────────

const pad = (value: number) => String(value).padStart(2, "0");

export function formatNumber(value: number, lang: SummaryLang = "pt-BR", digits = 0): string {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

/** A duration a person reads at a glance: "38 min", "5,2 h", "2,3 d". */
export function formatDuration(ms: number | null, lang: SummaryLang = "pt-BR"): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const minutes = ms / 60_000;
  if (ms <= 0) return "0 min";
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${formatNumber(Math.round(minutes), lang)} min`;
  // one decimal below 10 ("5,2 h"), none when it is whole ("1 h") or the number is big ("43 h")
  const short = (value: number) => new Intl.NumberFormat(lang, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
  const hours = minutes / 60;
  if (hours < 48) return `${short(hours)} h`;
  return `${short(hours / 24)} d`;
}

export function formatMoney(value: number | null, lang: SummaryLang = "pt-BR"): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(lang, { style: "currency", currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value);
}

export const formatPercent = (ratio: number | null, lang: SummaryLang = "pt-BR") => (ratio === null ? "—" : `${formatNumber(ratio * 100, lang)}%`);

/** São Paulo wall clock: 02/10/2026 14:05 (pt-BR) or 2026-10-02 14:05 (en). */
export function formatInstant(ms: number, lang: SummaryLang = "pt-BR", withTime = true): string {
  const p = zonedParts(ms);
  const date = lang === "pt-BR" ? `${pad(p.day)}/${pad(p.month)}/${p.year}` : `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return withTime ? `${date} ${pad(p.hour)}:${pad(p.minute)}` : date;
}

const MONTHS_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A bucket's short label: "14h", "02/10", "out/26". */
export function bucketLabel(start: number, granularity: Granularity, lang: SummaryLang = "pt-BR"): string {
  const p = zonedParts(start);
  if (granularity === "hour") return lang === "pt-BR" ? `${pad(p.hour)}h` : `${pad(p.hour)}:00`;
  if (granularity === "day") return lang === "pt-BR" ? `${pad(p.day)}/${pad(p.month)}` : `${MONTHS_EN[p.month - 1]} ${p.day}`;
  return lang === "pt-BR" ? `${MONTHS_PT[p.month - 1]}/${String(p.year).slice(2)}` : `${MONTHS_EN[p.month - 1]} ${String(p.year).slice(2)}`;
}

/** The period in words: "01/10/2026 00:00 – 02/10/2026 23:59". */
export function periodText(period: { from: number; to: number }, lang: SummaryLang = "pt-BR"): string {
  return `${formatInstant(period.from, lang)} – ${formatInstant(period.to - 60_000, lang)}`;
}

/** A comparison in words, without nested parentheses: "+3, +150%", "anterior: 2",
 * "sem base comparável", "antes do repositório". */
export function comparisonText(comparison: Comparison, lang: SummaryLang = "pt-BR", kind: "count" | "duration" | "percent" = "count"): string {
  const pt = lang === "pt-BR";
  const value = (amount: number) => (kind === "duration" ? formatDuration(amount, lang) : kind === "percent" ? `${formatNumber(amount * 100, lang)} p.p.` : formatNumber(amount, lang));
  if (comparison.kind === "none") {
    if (comparison.reason === "before-repo") return pt ? "anterior ao repositório" : "before the repository";
    return pt ? "sem base comparável" : "no comparable base";
  }
  if (comparison.kind === "absolute") return `${pt ? "anterior" : "previous"}: ${kind === "percent" ? formatPercent(comparison.previous, lang) : value(comparison.previous)}`;
  if (comparison.delta === 0) return pt ? "= período anterior" : "= previous period";
  const sign = comparison.delta > 0 ? "+" : "−";
  if (kind === "percent") return `${sign}${value(Math.abs(comparison.delta))}`;
  return `${sign}${value(Math.abs(comparison.delta))}, ${sign}${formatNumber(Math.abs(comparison.ratio) * 100, lang)}%`;
}

/** Kept for callers that only need "+3, +150%" between two plain numbers. */
export function trendText(current: number | null, previous: number | null, lang: SummaryLang = "pt-BR", kind: "count" | "duration" = "count"): string {
  return comparisonText(compareKpi(current, previous), lang, kind);
}

const granularityName = (granularity: Granularity, lang: SummaryLang) =>
  lang === "pt-BR" ? { hour: "hora", day: "dia", month: "mês" }[granularity] : granularity;

const pluralPt = (value: number, one: string, many: string) => `${formatNumber(value)} ${value === 1 ? one : many}`;
/** Business days: whole ones without a decimal ("21"), partial ones with one ("12,4"). */
const daysText = (value: number, lang: SummaryLang = "pt-BR") => new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(value);

// ── the board model ─────────────────────────────────────────────────────────

export interface BoardKpi {
  key: string;
  label: string;
  value: string;
  /** What the period also says ("≥", the split, the coverage). */
  detail?: string;
  previous: string;
  comparison: string;
  /** Good news (true), bad (false), neither or not comparable (null). */
  good: boolean | null;
  /** One line, beside the number. */
  short: string;
  goal?: { target: string; status: "met" | "close" | "off" };
}

const STATUS_TEXT = { met: "na meta", close: "perto da meta", off: "fora da meta" } as const;

/** The board's indicators, in order, with their comparison, short definition and target. */
export function boardKpis(report: ProductivityReport): BoardKpi[] {
  const k = report.kpis;
  const p = report.previousKpis;
  const b = report.backlog;
  const releaseOk = releaseComparable(report);
  const oldRepo = beforeRepo(report);
  const goals = report.goals ?? {};
  const kpi = (input: { key: string; label: string; value: string; detail?: string; short: string; current: number | null; previous: number | null; better: "up" | "down" | "none"; release?: boolean; github?: boolean; kind?: "count" | "duration" | "percent"; samples?: { current: number; previous: number }; base?: number; previousText?: string; goal?: { key: GoalKey; value: number | null; target: string } }): BoardKpi => {
    const comparison = compareKpi(input.current, input.previous, { comparable: input.release ? releaseOk : true, beforeRepo: input.github ? oldRepo : false, samples: input.samples, base: input.base });
    const good = comparison.kind !== "trend" || comparison.delta === 0 || input.better === "none" ? null : (comparison.delta > 0) === (input.better === "up");
    const status = input.goal ? goalStatus(input.goal.key, input.goal.value, goals) : null;
    const previousText = input.previousText ?? (comparison.kind === "none" ? "—" : input.previous === null ? "—" : input.kind === "duration" ? formatDuration(input.previous) : input.kind === "percent" ? formatPercent(input.previous) : formatNumber(input.previous));
    return {
      key: input.key, label: input.label, value: input.value, ...(input.detail ? { detail: input.detail } : {}),
      previous: previousText, comparison: comparisonText(comparison, "pt-BR", input.kind), good, short: input.short,
      ...(status && input.goal ? { goal: { target: input.goal.target, status } } : {}),
    };
  };
  const resolved = k.closedIssues - k.closedNotPlanned;
  const lowerBound = k.unknownContentReleases > 0;
  const tries = k.deliveries + k.failedReleases;
  const p1 = b.openP1Split;
  const partial = k.releaseCovered !== "full";
  return [
    kpi({ key: "deliveries", label: "Entregas em produção", value: `${partial ? "≥" : ""}${formatNumber(k.deliveries)}`, current: k.deliveries, previous: p.deliveries, better: "up", release: true,
      detail: `${lowerBound ? "≥" : ""}${pluralPt(k.deliveredPrs, "PR", "PRs")} e ${lowerBound ? "≥" : ""}${pluralPt(k.deliveredIssues, "issue concluída", "issues concluídas")} no ar${lowerBound ? ` · ${pluralPt(k.unknownContentReleases, "release sem conteúdo lido", "releases sem conteúdo lido")}` : ""}${partial ? ` · fonte de releases em ${daysText(k.releaseBusinessDays)} de ${daysText(k.businessDays)} dias úteis` : ""}`,
      short: "avanços da tag de produção (fim do deploy)" }),
    kpi({ key: "deployFrequency", label: "Frequência de deploy", value: k.deploysPerBusinessDay === null ? "—" : `${formatNumber(k.deploysPerBusinessDay, "pt-BR", 1)}/dia útil`, current: k.deploysPerBusinessDay, previous: p.deploysPerBusinessDay, better: "up", release: true, base: p.deliveries,
      detail: `${formatNumber(k.deliveries)} em ${daysText(k.releaseBusinessDays)} dias úteis com dados${partial ? ` (de ${daysText(k.businessDays)})` : ""}`, short: "DORA: entregas por dia útil com fonte de releases (seg–sex, sem feriados)",
      goal: goals.deploysPerBusinessDay !== undefined ? { key: "deploysPerBusinessDay", value: k.deploysPerBusinessDay, target: `≥ ${formatNumber(goals.deploysPerBusinessDay, "pt-BR", Number.isInteger(goals.deploysPerBusinessDay) ? 0 : 1)}/dia útil` } : undefined }),
    kpi({ key: "successRate", label: "Sucesso de release", value: formatPercent(k.releaseSuccessRate), current: k.releaseSuccessRate, previous: p.releaseSuccessRate, better: "up", release: true, kind: "percent",
      samples: { current: tries, previous: p.deliveries + p.failedReleases },
      detail: `${formatNumber(k.deliveries)} de ${formatNumber(tries)} que rodaram · ${pluralPt(k.supersededReleases, "substituído", "substituídos")} e ${pluralPt(k.abortedReleases, "abortado", "abortados")} fora da taxa`,
      short: "entregas ÷ (entregas + falhas que rodaram)",
      goal: goals.releaseSuccessRate !== undefined ? { key: "releaseSuccessRate", value: k.releaseSuccessRate === null ? null : k.releaseSuccessRate * 100, target: `≥ ${formatNumber(goals.releaseSuccessRate)}%` } : undefined }),
    kpi({ key: "leadTime", label: "Lead time issue até produção", value: formatDuration(k.leadIssueToProd.median), current: k.leadIssueToProd.median, previous: p.leadIssueToProd.median, better: "down", release: true, kind: "duration",
      samples: { current: k.leadIssueToProd.n, previous: p.leadIssueToProd.n },
      detail: k.leadIssueToProd.n ? `mediana · p90 ${formatDuration(k.leadIssueToProd.p90)} · n=${k.leadIssueToProd.n}` : "nenhuma issue concluída entregue",
      short: "criação da issue até o fim do deploy (mediana)",
      goal: goals.leadTimeHours !== undefined ? { key: "leadTimeHours", value: k.leadIssueToProd.median === null ? null : k.leadIssueToProd.median / 3_600_000, target: `≤ ${formatNumber(goals.leadTimeHours)} h` } : undefined }),
    kpi({ key: "merged", label: "PRs mergeadas", value: formatNumber(k.mergedPrs), current: k.mergedPrs, previous: p.mergedPrs, better: "up", github: true,
      detail: `mais ${pluralPt(k.carrierPrs, "carrier de release", "carriers de release")}`, short: "PRs na main, sem carriers de release" }),
    kpi({ key: "resolved", label: "Issues resolvidas", value: formatNumber(resolved), current: resolved, previous: p.closedIssues - p.closedNotPlanned, better: "up", github: true,
      detail: `${pluralPt(k.closedByType.bug, "bug", "bugs")} · ${formatNumber(k.closedByPriority.p0 + k.closedByPriority.p1)} P0/P1 · ${pluralPt(k.closedNotPlanned, "não planejada", "não planejadas")} à parte`,
      short: "fechadas como concluídas no período" }),
    // the value and its comparison are the same instant: the end of each period (INSP-V r2 #2)
    kpi({ key: "openP1", label: "Issues P0/P1 abertas", value: formatNumber(k.openP1AtEnd), current: k.openP1AtEnd, previous: p.openP1AtEnd, better: "down", github: true,
      detail: `${b.periodEnd ? `ao fim do período · agora ${formatNumber(b.openP0 + b.openP1)}: ` : "agora: "}P1 ${formatNumber(b.openP1)} = ${formatNumber(p1.current)} priority:p1 + ${formatNumber(p1.legacy)} priority:high (legado) · P0 ${formatNumber(b.openP0)}`,
      short: "fim do período contra fim do anterior; P1 = p1 + high, P0 = p0 + critical" }),
    kpi({ key: "blocked", label: "Pipeline de release parado", value: formatDuration(k.blockedMs) === "—" ? "0 h" : formatDuration(k.blockedMs), current: k.blockedMs, previous: p.blockedMs, better: "down", release: true, kind: "duration",
      detail: `produção no ar · ${formatDuration(k.blockedWeekendMs)} em fim de semana`, short: "1ª falha que rodou após um sucesso até o próximo sucesso" }),
  ];
}

/** DORA, as the board knows it. */
export function doraRows(report: ProductivityReport): Array<[string, string, string]> {
  const k = report.kpis;
  const cfr = k.checkedReleases ? k.changeFailures / k.checkedReleases : null;
  return [
    ["Frequência de deploy", k.deploysPerBusinessDay === null ? "— (nenhum dia útil com fonte de releases)" : `${formatNumber(k.deploysPerBusinessDay, "pt-BR", 1)} por dia útil (${formatNumber(k.deliveries)} em ${daysText(k.releaseBusinessDays)} dias úteis com dados${k.releaseCovered !== "full" ? `, de ${daysText(k.businessDays)} no período` : ""})`, "entregas em produção ÷ dias úteis com fonte de releases (seg–sex, sem feriados nacionais); dias sem fonte não contam como zero"],
    ["Lead time de mudança", k.leadMergeToProd.n ? `${formatDuration(k.leadMergeToProd.median)} (p90 ${formatDuration(k.leadMergeToProd.p90)}, n=${k.leadMergeToProd.n})` : "—", "merge da PR até o fim do deploy que a levou ao ar (mediana)"],
    ["Taxa de falha de mudança", cfr === null ? "— (nenhum release com verificação pós-release)" : `${formatPercent(cfr)} (${k.changeFailures} de ${k.checkedReleases} releases verificados)`, "releases cuja verificação pós-release reverteu ou achou produção fora do ar ÷ releases com verificação conclusiva"],
    ["Tempo de restauração", k.timeToRestore.n ? `${formatDuration(k.timeToRestore.median)} (n=${k.timeToRestore.n})` : k.changeFailures ? "— (sem release saudável depois da falha)" : "— (nenhuma falha de mudança registrada)", "da falha de mudança ao próximo release com verificação saudável"],
  ];
}

// ── bots' cost ──────────────────────────────────────────────────────────────

/** The cost per delivery, or why there is none: engineering bots only, and
 * only over at least MIN_TREND_BASE deliveries (INSP-V r2 #4). */
export function costPerDeliveryText(report: ProductivityReport, lang: SummaryLang = "pt-BR"): string {
  const k = report.kpis;
  const pt = lang === "pt-BR";
  if (k.usageDays <= 0) return pt ? "— (sem registro de uso no período)" : "— (no usage recorded in the period)";
  if (k.costPerDelivery !== null) return pt ? `${formatMoney(k.costPerDelivery, lang)} por entrega (${pluralPt(k.deliveriesInUsageDays, "entrega", "entregas")} nos dias registrados)` : `${formatMoney(k.costPerDelivery, lang)} per delivery (${formatNumber(k.deliveriesInUsageDays, lang)} deliveries on the recorded days)`;
  if (k.costEngineeringUsd === null) return pt ? "— (nenhum custo de bot de engenharia registrado)" : "— (no engineering bot cost recorded)";
  const few = k.deliveriesInUsageDays;
  return pt
    ? `— (só ${pluralPt(few, "entrega", "entregas")} nos dias registrados; mínimo ${MIN_TREND_BASE})`
    : `— (only ${formatNumber(few, lang)} ${few === 1 ? "delivery" : "deliveries"} on the recorded days; at least ${MIN_TREND_BASE})`;
}

/** The bots' sentence of the summary: turns, the cost split by role, the cost per delivery. */
function botsLine(report: ProductivityReport, lang: SummaryLang): string {
  const k = report.kpis;
  const pt = lang === "pt-BR";
  if (k.usageDays <= 0) return pt ? "Bots: sem registro de uso no período." : "Bots: no usage recorded in the period.";
  const days = daysText(k.usageDays, lang);
  const split = pt
    ? `engenharia ${formatMoney(k.costEngineeringUsd ?? 0, lang)}, operação ${formatMoney(k.costOperationsUsd ?? 0, lang)}${k.costOtherUsd !== null ? `, outros (bots fora da lista de papéis) ${formatMoney(k.costOtherUsd, lang)}` : ""}`
    : `engineering ${formatMoney(k.costEngineeringUsd ?? 0, lang)}, operations ${formatMoney(k.costOperationsUsd ?? 0, lang)}${k.costOtherUsd !== null ? `, other (bots not in the role list) ${formatMoney(k.costOtherUsd, lang)}` : ""}`;
  const turns = pt ? `${formatNumber(k.turns, lang)} ${k.turns === 1 ? "turno" : "turnos"}` : `${formatNumber(k.turns, lang)} ${k.turns === 1 ? "turn" : "turns"}`;
  return pt
    ? `Bots: ${turns} em ${days} dias registrados; custo ${formatMoney(k.costUsd, lang)} (${split}); custo de engenharia por entrega ${costPerDeliveryText(report, lang)}.`
    : `Bots: ${turns} over ${days} recorded days; cost ${formatMoney(k.costUsd, lang)} (${split}); engineering cost per delivery ${costPerDeliveryText(report, lang)}.`;
}

// ── executive summary ───────────────────────────────────────────────────────

/** Five lines, numbers first, each with its comparison against the previous period. */
export function executiveSummary(report: ProductivityReport, lang: SummaryLang = "pt-BR"): string[] {
  const k = report.kpis;
  const p = report.previousKpis;
  const b = report.backlog;
  const pt = lang === "pt-BR";
  const releaseOk = releaseComparable(report);
  const oldRepo = beforeRepo(report);
  const cmp = (current: number | null, previous: number | null, options: { release?: boolean; github?: boolean; kind?: "count" | "duration" | "percent"; samples?: { current: number; previous: number } } = {}) =>
    comparisonText(compareKpi(current, previous, { comparable: options.release ? releaseOk : true, beforeRepo: options.github ? oldRepo : false, samples: options.samples }), lang, options.kind);
  const n = (value: number, one: string, many: string) => `${formatNumber(value, lang)} ${value === 1 ? one : many}`;
  const gaps = report.coverage.releaseGaps.length > 0;
  const lower = k.unknownContentReleases > 0 ? "≥" : "";
  const resolved = k.closedIssues - k.closedNotPlanned;
  const previousResolved = p.closedIssues - p.closedNotPlanned;
  const tries = k.deliveries + k.failedReleases;
  const oldest = b.oldestOpen ? `#${b.oldestOpen.number}, ${formatDuration(report.generatedAt - b.oldestOpen.createdAt, lang)}` : "—";
  const partial = k.releaseCovered !== "full";
  const atLeast = partial ? "≥" : "";
  const frequency = k.deploysPerBusinessDay === null
    ? (pt ? "frequência — (nenhum dia útil com fonte)" : "frequency — (no business day with a source)")
    : pt ? `${formatNumber(k.deploysPerBusinessDay, lang, 1)} por dia útil com dados (${daysText(k.releaseBusinessDays, lang)} dias úteis)` : `${formatNumber(k.deploysPerBusinessDay, lang, 1)} per business day with data (${daysText(k.releaseBusinessDays, lang)} business days)`;
  const bots = botsLine(report, lang);
  // the backlog line reads the period's own end for a closed period; today apart, labelled
  const end = b.periodEnd;
  const backlogPt = end
    ? `Backlog ao fim do período (${formatInstant(end.at - 60_000, lang, false)}): ${n(end.openIssues, "issue aberta", "issues abertas")}, ${formatNumber(end.openP0P1)} P0/P1. Agora: P1 ${formatNumber(b.openP1)} (${formatNumber(b.openP1Split.current)} priority:p1 + ${formatNumber(b.openP1Split.legacy)} priority:high legado) e P0 ${formatNumber(b.openP0)}; ${n(b.prsAwaitingGate, "PR esperando", "PRs esperando")} o gate.`
    : `Backlog agora: ${n(b.openIssues, "issue aberta", "issues abertas")}; P1 ${formatNumber(b.openP1)} (${formatNumber(b.openP1Split.current)} priority:p1 + ${formatNumber(b.openP1Split.legacy)} priority:high legado) e P0 ${formatNumber(b.openP0)}; a mais antiga ${oldest}; ${n(b.prsAwaitingGate, "PR esperando", "PRs esperando")} o gate.`;
  const backlogEn = end
    ? `Backlog at the end of the period (${formatInstant(end.at - 60_000, lang, false)}): ${n(end.openIssues, "open issue", "open issues")}, ${formatNumber(end.openP0P1, lang)} P0/P1. Now: P1 ${formatNumber(b.openP1, lang)} (${formatNumber(b.openP1Split.current, lang)} priority:p1 + ${formatNumber(b.openP1Split.legacy, lang)} legacy priority:high) and P0 ${formatNumber(b.openP0, lang)}; ${n(b.prsAwaitingGate, "PR waiting", "PRs waiting")} for the gate.`
    : `Backlog now: ${n(b.openIssues, "open issue", "open issues")}; P1 ${formatNumber(b.openP1, lang)} (${formatNumber(b.openP1Split.current, lang)} priority:p1 + ${formatNumber(b.openP1Split.legacy, lang)} legacy priority:high) and P0 ${formatNumber(b.openP0, lang)}; the oldest ${oldest}; ${n(b.prsAwaitingGate, "PR waiting", "PRs waiting")} for the gate.`;
  if (pt) {
    return [
      `Produção: ${atLeast}${n(k.deliveries, "entrega", "entregas")} (${cmp(k.deliveries, p.deliveries, { release: true })}), ${frequency}, com ${lower}${n(k.deliveredPrs, "PR", "PRs")} e ${lower}${n(k.deliveredIssues, "issue concluída", "issues concluídas")} no ar${k.unknownContentReleases ? ` (${n(k.unknownContentReleases, "release sem conteúdo lido", "releases sem conteúdo lido")})` : ""}${gaps ? "; parte do período sem fonte de releases" : ""}.`,
      `Vazão: ${n(k.mergedPrs, "PR mergeada", "PRs mergeadas")} (${cmp(k.mergedPrs, p.mergedPrs, { github: true })}) e ${n(resolved, "issue resolvida", "issues resolvidas")} (${cmp(resolved, previousResolved, { github: true })}), ${n(k.closedByType.bug, "bug", "bugs")} e ${formatNumber(k.closedByPriority.p0 + k.closedByPriority.p1)} P0/P1.`,
      `Lead time issue até produção: ${k.leadIssueToProd.n ? `mediana ${formatDuration(k.leadIssueToProd.median, lang)}, p90 ${formatDuration(k.leadIssueToProd.p90, lang)} (n=${k.leadIssueToProd.n}; ${cmp(k.leadIssueToProd.median, p.leadIssueToProd.median, { release: true, kind: "duration", samples: { current: k.leadIssueToProd.n, previous: p.leadIssueToProd.n } })})` : "nenhuma issue concluída entregue"}; merge até produção ${formatDuration(k.leadMergeToProd.median, lang)}.`,
      backlogPt,
      `Releases: sucesso ${formatPercent(k.releaseSuccessRate, lang)} (${formatNumber(k.deliveries)} de ${formatNumber(tries)} que rodaram; ${n(k.supersededReleases, "substituído", "substituídos")} e ${n(k.abortedReleases, "abortado", "abortados")} fora da taxa), ${n(k.declinedReleases, "recusado", "recusados")}; pipeline parado ${k.blockedMs > 0 ? formatDuration(k.blockedMs, lang) : "0 h"} com produção no ar (${formatDuration(k.blockedWeekendMs, lang)} em fim de semana). ${bots}`,
    ];
  }
  return [
    `Production: ${atLeast}${n(k.deliveries, "delivery", "deliveries")} (${cmp(k.deliveries, p.deliveries, { release: true })}), ${frequency}, carrying ${lower}${n(k.deliveredPrs, "PR", "PRs")} and ${lower}${n(k.deliveredIssues, "completed issue", "completed issues")} live${k.unknownContentReleases ? ` (${n(k.unknownContentReleases, "release with contents not read", "releases with contents not read")})` : ""}${gaps ? "; part of the period has no release source" : ""}.`,
    `Throughput: ${n(k.mergedPrs, "PR merged", "PRs merged")} (${cmp(k.mergedPrs, p.mergedPrs, { github: true })}) and ${n(resolved, "issue resolved", "issues resolved")} (${cmp(resolved, previousResolved, { github: true })}), ${n(k.closedByType.bug, "bug", "bugs")} and ${formatNumber(k.closedByPriority.p0 + k.closedByPriority.p1, lang)} P0/P1.`,
    `Lead time issue to production: ${k.leadIssueToProd.n ? `median ${formatDuration(k.leadIssueToProd.median, lang)}, p90 ${formatDuration(k.leadIssueToProd.p90, lang)} (n=${k.leadIssueToProd.n}; ${cmp(k.leadIssueToProd.median, p.leadIssueToProd.median, { release: true, kind: "duration", samples: { current: k.leadIssueToProd.n, previous: p.leadIssueToProd.n } })})` : "no completed issue delivered"}; merge to production ${formatDuration(k.leadMergeToProd.median, lang)}.`,
    backlogEn,
    `Releases: ${formatPercent(k.releaseSuccessRate, lang)} success (${formatNumber(k.deliveries, lang)} of ${formatNumber(tries, lang)} that ran; ${formatNumber(k.supersededReleases, lang)} superseded and ${formatNumber(k.abortedReleases, lang)} aborted left out), ${formatNumber(k.declinedReleases, lang)} declined; release pipeline stopped ${k.blockedMs > 0 ? formatDuration(k.blockedMs, lang) : "0 h"} with production up (${formatDuration(k.blockedWeekendMs, lang)} on weekends). ${bots}`,
  ];
}

// ── definitions (shared by the export; the app has the same in i18n) ────────

export const DEFINITIONS_PT: ReadonlyArray<[string, string]> = [
  ["Entregas em produção", "avanços da tag nuria-production-deployed: releases que terminaram o deploy (log do watcher de produção; antes de 15/09, deployments de produção do GitHub). O horário é o fim do deploy. Um deploy que foi ao ar sem a tag avançar (push recusado) conta e é marcado."],
  ["PRs e issues entregues", "PRs mergeadas cujos commits entraram entre o release anterior e este (compare do GitHub), sem os carriers de release. Issue entregue: só as citadas explicitamente pela PR (vínculo do GitHub, ou Closes/Fixes/Resolves/Refs #N no corpo ou no commit) e já fechadas como concluídas. Release cujo conteúdo ainda não foi lido torna o total um mínimo (≥)."],
  ["Frequência de deploy (DORA)", "entregas em produção ÷ dias úteis com fonte de releases (seg–sex, horário de São Paulo, sem feriados nacionais). Dias sem fonte não entram no denominador nem contam como zero; quando o período tem trecho sem fonte, o total de entregas é um mínimo (≥)."],
  ["Sucesso de release", "entregas ÷ (entregas + falhas). Falha é a tentativa que rodou (CI ou deploy) e não avançou a tag. Substituídos (o watcher passou a um commit mais novo, ou o run saiu da fila sem rodar) e abortados (pararam antes de rodar: lock, smart-deploy que não iniciou) ficam fora da taxa."],
  ["Lead time", "criação da issue até o fim do deploy que levou sua PR ao ar, para as issues concluídas entregues no período; mediana e p90 (posto mais próximo). Lead time de mudança (DORA): merge da PR até o fim do deploy."],
  ["Taxa de falha de mudança e tempo de restauração (DORA)", "pela verificação pós-release (POST_RELEASE_RESULT): reverteu ou achou produção fora do ar ÷ releases com verificação conclusiva; restauração = da falha ao próximo release com verificação saudável. Sem verificação ou sem falha, aparece —."],
  ["PRs mergeadas", "PRs mergeadas na main no período, sem os carriers de release (chore/release-carrier-*), que só publicam outras PRs."],
  ["Issues resolvidas", "issues fechadas como concluídas no período (não planejadas e duplicadas à parte); tipo pelos rótulos type:bug/hotfix, type:improvement, type:feature."],
  ["Prioridade", "P0 = priority:p0 + priority:critical; P1 = priority:p1 + priority:high (escala antiga, contada junto e mostrada à parte); P2 = p2 + medium; P3 = p3 + low. O cartão P0/P1 compara o fim do período com o fim do anterior (rótulos de hoje); o número de agora aparece à parte, rotulado."],
  ["PRs esperando o gate", "PRs abertas na main, fora de rascunho, sem o status nuria/local-merge-gate verde no último commit (retrato de agora)."],
  ["Pipeline de release parado", "produção continua no ar; conta do primeiro release que rodou e falhou depois de um sucesso até o próximo sucesso. Runs substituídos e abortados não abrem intervalo. A parte em sábado e domingo aparece separada."],
  ["Esforço dos bots", "dados locais do OpenMausBot, só nos dias em que o ledger de uso existe (antes: —). Custo separado por papel: engenharia (Lead, Eng, QA, DBA, SRE, Delivery) e operação (Monitor Chat, Chief of Staff). Custo de engenharia por entrega = custo dos bots de engenharia nesses dias ÷ entregas nesses mesmos dias, só com pelo menos 5 entregas (antes disso: —). \"Precisa de você\": itens abertos e resolvidos; resposta do dono = do item aberto à primeira resposta (ou resolução) do dono."],
  ["Comparações", "só contra um período anterior com fonte comparável e de depois da criação do repositório; com base menor que 5 (ou menos de 10 amostras numa mediana) mostra o valor anterior, sem variação."],
];

// ── Markdown ────────────────────────────────────────────────────────────────

const md = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
const nums = (items: ReadonlyArray<{ number: number }>, max = 30) => items.length
  ? `${items.slice(0, max).map((item) => `#${item.number}`).join(", ")}${items.length > max ? ` +${items.length - max}` : ""}`
  : "—";

const OUTCOME_TEXT: Record<string, string> = { released: "em produção", failed: "falhou", superseded: "substituído", aborted: "abortado", declined: "recusado" };
const outcomeText = (outcome: string) => OUTCOME_TEXT[outcome] ?? outcome;
const UNKNOWN_REASON: Record<string, string> = {
  first: "conteúdo desconhecido (primeiro release conhecido)",
  gap: "conteúdo desconhecido (release anterior fora da cobertura)",
  pending: "conteúdo ainda não lido do GitHub",
};

function headPrText(release: ProductivityReport["releases"][number]): string {
  if (!release.headPr) return "—";
  return release.headPrIsCarrier ? `carrier #${release.headPr}` : `PR #${release.headPr}`;
}

/** The release header, from the same counts as the screen (releaseCountParts). */
export function releaseCounts(report: ProductivityReport): string {
  const c = releaseCountParts(report);
  return [
    `${formatNumber(c.released)} em produção`,
    `${pluralPt(c.failedCommits, "commit falhou", "commits falharam")} (${pluralPt(c.failedTries, "tentativa", "tentativas")} que rodaram)`,
    `${pluralPt(c.superseded, "run substituído", "runs substituídos")}`,
    `${pluralPt(c.aborted, "run abortado", "runs abortados")}`,
    pluralPt(c.declined, "recusado", "recusados"),
  ].join(" · ");
}

/** A failed commit's row, with the runs that never ran folded in. */
function outcomeLabel(row: ProductivityReport["releases"][number]): string {
  if (row.outcome === "released") return row.tagNotAdvanced ? "em produção (tag movida à mão)" : "em produção";
  const tries = row.attempts ?? 1;
  const base = row.outcome === "failed" ? (tries > 1 ? `falhou (${tries} tentativas)` : "falhou")
    : row.outcome === "superseded" ? (tries > 1 ? `substituído (${tries} runs)` : "substituído")
    : row.outcome === "aborted" ? (tries > 1 ? `abortado (${tries} runs)` : "abortado") : outcomeText(row.outcome);
  const folded = [row.supersededRuns ? `${row.supersededRuns} substituído${row.supersededRuns > 1 ? "s" : ""}` : "", row.abortedRuns ? `${row.abortedRuns} abortado${row.abortedRuns > 1 ? "s" : ""}` : ""].filter(Boolean);
  return folded.length ? `${base} · ${folded.join(", ")}` : base;
}

/** The board's release table: deliveries, failures and refusals; commits that
 * only had runs that never ran are counted in the header, not listed. */
function boardReleaseRows(report: ProductivityReport): { rows: ProductivityReport["releases"]; omitted: number } {
  const rows = report.releases.filter((row) => row.outcome === "released" || row.outcome === "failed" || row.outcome === "declined");
  return { rows, omitted: report.releases.length - rows.length };
}

/** Why this export is not the fresh, verified picture — printed first, never buried. */
export function exportWarnings(report: ProductivityReport): string[] {
  const readiness = exportReadiness(report, report.generatedAt);
  const age = readiness.ageMs === null ? null : formatDuration(readiness.ageMs);
  return readiness.blockers.map((blocker) => {
    if (blocker === "never") return "O GitHub ainda não foi sincronizado: PRs, issues e a tag de produção não estão neste relatório.";
    if (blocker === "stale") return `Dados do GitHub de ${age} atrás (sincronizado em ${formatInstant(report.coverage.github.syncedAt ?? report.sync.lastSyncAt ?? 0)}): PRs, issues, backlog e a verificação da tag podem estar desatualizados.`;
    if (blocker === "syncing") return "Uma sincronização com o GitHub estava em andamento: os números do GitHub podem estar incompletos.";
    if (blocker === "incomplete") return "A varredura do histórico do GitHub ainda não terminou: as contagens de PRs e issues são parciais.";
    return report.coverage.tag.matchesHistory === false && readiness.blockers.includes("stale")
      ? "A verificação da tag de produção está desatualizada (ver acima)."
      : `A tag de produção no GitHub (${report.coverage.tag.sha?.slice(0, 9)}) não é o último release do histórico: confira antes de levar ao board.`;
  });
}

function coverageLines(report: ProductivityReport): string[] {
  const c = report.coverage;
  const lines: string[] = [];
  if (c.releaseLog.from !== null) lines.push(`Log do watcher de produção desde ${formatInstant(c.releaseLog.from)}.`);
  if (c.githubDeployments.from !== null) lines.push(`Deployments de produção do GitHub de ${formatInstant(c.githubDeployments.from)} a ${formatInstant(c.githubDeployments.to!)}.`);
  for (const gap of c.releaseGaps) lines.push(`Sem fonte de releases de ${formatInstant(gap.from)} a ${formatInstant(gap.to)}: entregas e falhas desse trecho não são conhecidas (não são zero).`);
  const readiness = exportReadiness(report, report.generatedAt);
  const stale = readiness.blockers.includes("stale");
  lines.push(c.github.syncedAt ? `GitHub sincronizado em ${formatInstant(c.github.syncedAt)} (${formatNumber(c.github.prs)} PRs, ${formatNumber(c.github.issues)} issues${c.github.complete ? "" : "; a varredura do histórico continua nas próximas sincronizações"}).` : "GitHub ainda não sincronizado.");
  if (c.github.repoCreatedAt) lines.push(`Repositório criado em ${formatInstant(c.github.repoCreatedAt, "pt-BR", false)}: nenhum período anterior a isso serve de comparação.`);
  if (c.tag.sha) {
    const verdict = c.tag.matchesHistory === true ? " (confere com o histórico)"
      : c.tag.matchesHistory === false ? (stale ? ` (verificação desatualizada: lida há ${formatDuration(readiness.ageMs)}, antes do último release do histórico)` : " (diferente do último release do histórico; ver o aviso no início)")
      : "";
    lines.push(`Tag de produção no GitHub: ${c.tag.sha.slice(0, 9)}${verdict}.`);
  }
  lines.push(c.usage.from !== null ? `Ledger de uso dos bots desde ${formatInstant(c.usage.from)}; antes disso os números dos bots são — (sem registro), não zero.` : "Sem ledger de uso dos bots.");
  if (c.digests.from !== null) lines.push(`Durações de turno desde ${formatInstant(c.digests.from)}.`);
  if (c.needsYou.from !== null) lines.push(`"Precisa de você" registrado desde ${formatInstant(c.needsYou.from)}.`);
  return lines;
}

const goalText = (kpi: BoardKpi) => (kpi.goal ? `${kpi.goal.target} · ${STATUS_TEXT[kpi.goal.status]}` : "—");

export function reportTitle(report: ProductivityReport): string {
  return `Produtividade de engenharia — ${periodTitle(report.period, report.generatedAt)}`;
}

/** "Worktrees criadas pelo OMB" (lote X): how many, how many got their
 * caches cloned, what that saved in disk and install time, why the others
 * did not, and each seed. Nothing when the report does not carry it. */
export function worktreeLines(report: ProductivityReport): string[] {
  const w = report.worktrees;
  if (!w) return [];
  const size = (kb: number) => (kb >= 1024 * 1024 ? `${formatNumber(kb / 1024 / 1024, "pt-BR", 1)} GB` : `${formatNumber(Math.round(kb / 1024))} MB`);
  const lines = ["", "## Worktrees criadas pelo OMB (clone APFS)", ""];
  if (!w.created && !w.failed) lines.push("Nenhuma worktree criada pelo servidor no período.");
  else {
    lines.push(`- Criadas: ${formatNumber(w.created)}; com dependências clonadas da semente: ${formatNumber(w.cloned)}; a sessão instalou (npm ci): ${formatNumber(w.installed)}${w.failed ? `; não criadas: ${formatNumber(w.failed)}` : ""}`);
    lines.push(`- Economia dos clones: ${size(w.savedKb)} que não foram gravados em disco e ${formatDuration(w.savedMs)} de instalação poupados (o tempo do npm ci da semente, por clone)`);
    for (const each of w.reasons.slice(0, 5)) lines.push(`- Sem clone, ${formatNumber(each.count)}×: ${md(each.reason)}`);
  }
  for (const seed of w.seeds) {
    lines.push(`- Semente de ${md(seed.repo.split("/").pop() ?? seed.repo)}: ${seed.state === "ready" ? "pronta" : md(seed.state)}${seed.head ? ` em \`${seed.head.slice(0, 9)}\`` : ""}${seed.kb ? `, ${size(seed.kb)} de dependências` : ""}${seed.installMs ? `, instalada em ${formatDuration(seed.installMs)}` : ""}${seed.reason ? ` — ${md(seed.reason)}` : ""}`);
  }
  lines.push("- O servidor nunca remove worktrees: só relata.");
  return lines;
}

export function reportMarkdown(report: ProductivityReport): string {
  const g = report.granularity;
  const k = report.kpis;
  const lines: string[] = [];
  lines.push(`# ${reportTitle(report)}`, "");
  lines.push(`**Time Nuria · ${PRODUCT_NAME}** · ${periodText(report.period)} (${REPORT_TZ}) · por ${granularityName(g, "pt-BR")} · comparado a ${periodText(report.previous)} · gerado em ${formatInstant(report.generatedAt)}`, "");
  const warnings = exportWarnings(report);
  if (warnings.length) {
    lines.push("> **⚠ Atenção — este relatório não está com os dados verificados:**");
    for (const warning of warnings) lines.push(`> - ${warning}`);
    lines.push("");
  }
  lines.push("## Resumo executivo", "");
  executiveSummary(report).forEach((line, index) => lines.push(`${index + 1}. ${line}`));
  lines.push("", "## Indicadores", "", "| Indicador | Período | Anterior | Comparação | Meta | Como é contado |", "|---|---:|---:|---|---|---|");
  for (const kpi of boardKpis(report)) lines.push(`| ${md(kpi.label)} | ${md(kpi.value)}${kpi.detail ? `<br>${md(kpi.detail)}` : ""} | ${md(kpi.previous)} | ${md(kpi.comparison)} | ${md(goalText(kpi))} | ${md(kpi.short)} |`);
  lines.push("", "## DORA", "", "| Métrica | Valor | Como é contado |", "|---|---|---|");
  for (const [name, value, how] of doraRows(report)) lines.push(`| ${md(name)} | ${md(value)} | ${md(how)} |`);
  lines.push("", `## Por ${granularityName(g, "pt-BR")}`, "", "| Período | Entregas | PRs entregues | PRs mergeadas | Issues fechadas | Bugs fechados | Falhas que rodaram | Turnos dos bots |", "|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const bucket of report.buckets) {
    const known = bucket.releaseCoverage !== "none";
    const delivered = !known ? "s/ fonte" : `${bucket.unknownContentReleases ? "≥" : ""}${bucket.deliveredPrs}`;
    lines.push(`| ${bucketLabel(bucket.start, g)} | ${known ? bucket.deliveries : "s/ fonte"} | ${delivered} | ${bucket.mergedPrs} | ${bucket.closedIssues} | ${bucket.closedBugs} | ${known ? bucket.failedReleases : "s/ fonte"} | ${bucket.turns === null ? "—" : bucket.turns} |`);
  }
  if (report.buckets.some((bucket) => bucket.unknownContentReleases)) lines.push("", "≥: há release no intervalo cujo conteúdo ainda não é conhecido; o número é um mínimo.");
  lines.push("", "## Releases do período", "", releaseCounts(report), "");
  const board = boardReleaseRows(report);
  if (!board.rows.length && !board.omitted) lines.push("Nenhum release, falha ou recusa no período.");
  else {
    lines.push("| Quando | Commit | Resultado | PRs | Issues concluídas |", "|---|---|---|---|---|");
    for (const release of board.rows) {
      const prs = release.outcome === "released" ? (release.contentUnknown ? UNKNOWN_REASON[release.contentUnknownReason ?? "pending"]! : nums(release.prs.filter((pr) => !pr.carrier))) : headPrText(release);
      lines.push(`| ${formatInstant(release.at)} | \`${release.sha.slice(0, 9)}\` | ${outcomeLabel(release)} | ${prs} | ${release.outcome === "released" ? nums(release.issues) : "—"} |`);
    }
    if (board.omitted) lines.push("", `${pluralPt(board.omitted, "commit só teve", "commits só tiveram")} runs substituídos ou abortados (nenhum rodou): contados no cabeçalho, não listados.`);
  }
  const b = report.backlog;
  if (b.periodEnd) {
    lines.push("", `## Backlog ao fim do período (${formatInstant(b.periodEnd.at - 60_000)})`, "");
    lines.push(`- Issues abertas: ${formatNumber(b.periodEnd.openIssues)}; P0/P1: ${formatNumber(b.periodEnd.openP0P1)} (rótulos de hoje)`);
    if (b.periodEnd.oldestOpen) lines.push(`- Mais antiga aberta: #${b.periodEnd.oldestOpen.number} (${formatDuration(b.periodEnd.at - b.periodEnd.oldestOpen.createdAt)} naquela data)`);
  }
  lines.push("", `## Backlog agora (${b.at ? formatInstant(b.at) : "—"})`, "");
  lines.push(`- Issues abertas: ${formatNumber(b.openIssues)}`);
  lines.push(`- P1: ${formatNumber(b.openP1)} = ${formatNumber(b.openP1Split.current)} priority:p1 + ${formatNumber(b.openP1Split.legacy)} priority:high (escala antiga)`);
  lines.push(`- P0: ${formatNumber(b.openP0)} = ${formatNumber(b.openP0Split.current)} priority:p0 + ${formatNumber(b.openP0Split.legacy)} priority:critical (escala antiga)`);
  if (b.oldestOpen) lines.push(`- Mais antiga aberta: #${b.oldestOpen.number}, aberta em ${formatInstant(b.oldestOpen.createdAt, "pt-BR", false)} (${formatDuration(report.generatedAt - b.oldestOpen.createdAt)})`);
  if (b.oldestOpenP1) lines.push(`- P0/P1 mais antiga: #${b.oldestOpenP1.number}, aberta em ${formatInstant(b.oldestOpenP1.createdAt, "pt-BR", false)} (${formatDuration(report.generatedAt - b.oldestOpenP1.createdAt)})`);
  lines.push(`- PRs esperando o gate: ${formatNumber(b.prsAwaitingGate)}${b.prsAwaitingGateList.length ? ` (${nums(b.prsAwaitingGateList, 15)})` : ""} de ${formatNumber(b.openPrs)} abertas`);
  lines.push("", "## Esforço dos bots", "");
  if (k.usageDays <= 0) lines.push("Sem registro de uso dos bots no período (—, não zero).");
  else {
    lines.push(`Cobre ${daysText(k.usageDays)} dias registrados do período. Custo: ${formatMoney(k.costUsd)} — engenharia (Lead, Eng, QA, DBA, SRE, Delivery) ${formatMoney(k.costEngineeringUsd ?? 0)}, operação (Monitor Chat, Chief of Staff) ${formatMoney(k.costOperationsUsd ?? 0)}${k.costOtherUsd !== null ? `, outros (bots fora da lista de papéis) ${formatMoney(k.costOtherUsd)}` : ""}. Custo de engenharia por entrega: ${costPerDeliveryText(report)}.`, "");
    lines.push("| Bot | Turnos | Horas ativas | Tokens (entrada / saída) | Custo | \"Precisa de você\" abertos / resolvidos |", "|---|---:|---:|---:|---:|---:|");
    for (const bot of report.bots) lines.push(`| ${md(bot.name)} | ${formatNumber(bot.turns)} | ${formatDuration(bot.timedTurns ? bot.activeMs : null)} | ${formatNumber(bot.inputTokens)} / ${formatNumber(bot.outputTokens)} | ${formatMoney(bot.costUsd)} | ${bot.needsYouOpened} / ${bot.needsYouResolved} |`);
  }
  lines.push(...worktreeLines(report));
  lines.push("", "## Definições", "");
  for (const [name, text] of DEFINITIONS_PT) lines.push(`- **${name}:** ${text}`);
  lines.push("", "## Cobertura dos dados", "");
  for (const line of coverageLines(report)) lines.push(`- ${line}`);
  lines.push("");
  return lines.join("\n");
}

// ── PDF ─────────────────────────────────────────────────────────────────────

// Helvetica / Helvetica-Bold advance widths (1/1000 em), ASCII 32..126 (Adobe AFM).
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const WIN_ANSI_EXTRA: Record<string, number> = { "€": 0x80, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97 };
const WIDE: Record<number, number> = { 0x80: 556, 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0xa0: 278, 0xb7: 278, 0xba: 365, 0xaa: 370, 0xd7: 584, 0xb0: 400 };
// WinAnsi has no true minus, arrows or ≥/≤: the minus becomes an en dash (not
// a hyphen), ≥/≤ are written out in words ("no mínimo 22"), arrows become dashes
const SUBSTITUTE: Record<string, string> = { "→": "–", "←": "–", "↑": "+", "↓": "–", "−": "–", "✓": "v", "⚠": "!" };
/** The words a reader expects where the font has no glyph (INSP-V r2 #7). */
export const pdfPlain = (text: string) => text
  // the "(≥)" that explains the sign has nothing to explain once it is spelled out (INSP-V r3 #1)
  .replace(/\s?\(≥\)/g, "")
  .replace(/≥\s?/g, "no mínimo ").replace(/≤\s?/g, "no máximo ");

const winAnsiCode = (char: string): number => {
  const code = char.codePointAt(0)!;
  if (code >= 32 && code <= 126) return code;
  if (WIN_ANSI_EXTRA[char] !== undefined) return WIN_ANSI_EXTRA[char]!;
  if (code >= 0xa0 && code <= 0xff) return code;
  return 63; // "?"
};

/** A string as WinAnsi codes: Latin-1 as is, the few cp1252 extras mapped, the rest spelled out. */
function winAnsi(text: string): number[] {
  const codes: number[] = [];
  for (const char of pdfPlain(text)) {
    const sub = SUBSTITUTE[char];
    if (sub) for (const c of sub) codes.push(winAnsiCode(c));
    else codes.push(winAnsiCode(char));
  }
  return codes;
}

const BASE_LETTER: Record<number, number> = {};
for (const [from, to] of Object.entries({ "ÀÁÂÃÄÅ": "A", "Ç": "C", "ÈÉÊË": "E", "ÌÍÎÏ": "I", "Ñ": "N", "ÒÓÔÕÖ": "O", "ÙÚÛÜ": "U", "àáâãäå": "a", "ç": "c", "èéêë": "e", "ìíîï": "i", "ñ": "n", "òóôõö": "o", "ùúûü": "u" })) {
  for (const char of from) BASE_LETTER[char.charCodeAt(0)] = to.charCodeAt(0);
}

export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let units = 0;
  for (const code of winAnsi(text)) {
    const base = BASE_LETTER[code] ?? code;
    units += base >= 32 && base <= 126 ? table[base - 32]! : WIDE[code] ?? 556;
  }
  return (units * size) / 1000;
}

const pdfString = (text: string) => `(${winAnsi(text).map((code) => {
  if (code === 40 || code === 41 || code === 92) return `\\${String.fromCharCode(code)}`;
  return code < 128 ? String.fromCharCode(code) : `\\${code.toString(8).padStart(3, "0")}`;
}).join("")})`;

/** A text string for the document's metadata: UTF-16BE with its BOM, so the
 * viewer's tab and the attachment list read every accent and dash right. */
export const pdfTextString = (text: string) => {
  let hex = "FEFF";
  for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  return `<${hex}>`;
};

type Rgb = [number, number, number];
const hex = (value: string): Rgb => [parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255];
const INK = hex("#16181d");
const MUTED = hex("#565b66");
const HAIRLINE = hex("#d6d8dd");
const CARD = hex("#f4f5f7");
const ACCENT = hex("#2c5680");
const ACCENT_SOFT = hex("#9fb7d1");
const GOOD = hex("#1d6b45");
const BAD = hex("#a3262a");
const WARN = hex("#8a5a00");
const NOSOURCE = hex("#e4e6ea");
const WARN_SOFT = hex("#fbeeee");

/** A tiny page-layout engine: A4 portrait, points, top-down y. */
class PdfDoc {
  readonly width = 595.28;
  readonly height = 841.89;
  readonly margin = 42;
  private pages: string[][] = [];
  private ops: string[] = [];
  y = 0;

  constructor() { this.addPage(); }

  addPage(): void {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.margin;
  }

  /** Room for `height` more points on this page, else a new page. */
  ensure(height: number): void {
    if (this.y + height > this.height - this.margin - 18) this.addPage();
  }

  private color(rgb: Rgb, stroke = false): string {
    return `${rgb.map((value) => value.toFixed(3)).join(" ")} ${stroke ? "RG" : "rg"}`;
  }

  text(x: number, y: number, text: string, options: { size?: number; bold?: boolean; color?: Rgb; align?: "left" | "right" | "center"; maxWidth?: number } = {}): void {
    const size = options.size ?? 10;
    let value = text;
    if (options.maxWidth) {
      while (value.length > 1 && textWidth(value, size, options.bold) > options.maxWidth) value = `${value.slice(0, -2)}…`;
    }
    const width = textWidth(value, size, options.bold);
    const left = options.align === "right" ? x - width : options.align === "center" ? x - width / 2 : x;
    this.ops.push(`BT ${this.color(options.color ?? INK)} /${options.bold ? "F2" : "F1"} ${size} Tf ${left.toFixed(2)} ${(this.height - y).toFixed(2)} Td ${pdfString(value)} Tj ET`);
  }

  /** Wrapped text; returns the height used. */
  paragraph(x: number, y: number, text: string, width: number, options: { size?: number; bold?: boolean; color?: Rgb; leading?: number } = {}): number {
    const size = options.size ?? 10;
    const leading = options.leading ?? size * 1.35;
    const lines = this.wrap(text, width, size, options.bold);
    lines.forEach((line, index) => this.text(x, y + index * leading, line, options));
    return lines.length * leading;
  }

  wrap(text: string, width: number, size: number, bold = false): string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) > width && line) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  measureLines(text: string, width: number, size: number, bold = false): number {
    return this.wrap(text, width, size, bold).length;
  }

  rect(x: number, y: number, w: number, h: number, fill: Rgb): void {
    this.ops.push(`${this.color(fill)} ${x.toFixed(2)} ${(this.height - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: Rgb = HAIRLINE, width = 0.6): void {
    this.ops.push(`${this.color(stroke, true)} ${width} w ${x1.toFixed(2)} ${(this.height - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.height - y2).toFixed(2)} l S`);
  }

  render(meta: { title: string; createdAt: number; footer: string }): Buffer {
    const total = this.pages.length;
    this.pages.forEach((ops, index) => {
      ops.push(`BT ${this.color(MUTED)} /F1 7.5 Tf ${this.margin.toFixed(2)} 22 Td ${pdfString(meta.footer)} Tj ET`);
      const page = `${index + 1}/${total}`;
      ops.push(`BT ${this.color(MUTED)} /F1 7.5 Tf ${(this.width - this.margin - textWidth(page, 7.5)).toFixed(2)} 22 Td ${pdfString(page)} Tj ET`);
    });
    const objects: Buffer[] = [];
    const add = (body: string | Buffer) => { objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body); return objects.length; };
    const catalog = add("");
    const pagesId = add("");
    const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids: number[] = [];
    for (const ops of this.pages) {
      const content = deflateSync(Buffer.from(ops.join("\n"), "latin1"));
      const stream = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), content, Buffer.from("\nendstream", "latin1")]));
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${stream} 0 R >>`));
    }
    objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R /Lang (pt-BR) >>`, "latin1");
    objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`, "latin1");
    const d = new Date(meta.createdAt);
    const stamp = `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    const info = add(`<< /Title ${pdfTextString(meta.title)} /Producer (OpenMausBot) /CreationDate (${stamp}) >>`);
    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    const offsets: number[] = [];
    let length = chunks[0]!.length;
    objects.forEach((body, index) => {
      offsets.push(length);
      const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
      chunks.push(chunk);
      length += chunk.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)].join("");
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${length}\n%%EOF\n`, "latin1"));
    return Buffer.concat(chunks);
  }
}

/** "#1, #2, #3 +7" that fits `width`: never a bare "…", always how many are left. */
export function fitNumbers(items: ReadonlyArray<{ number: number }>, width: number, size: number): string {
  if (!items.length) return "—";
  for (let shown = items.length; shown >= 1; shown -= 1) {
    const text = `${items.slice(0, shown).map((item) => `#${item.number}`).join(", ")}${shown < items.length ? ` +${items.length - shown}` : ""}`;
    if (textWidth(text, size) <= width) return text;
  }
  return `+${items.length}`;
}

type ChartSeries = { label: string; color: Rgb; value: (bucket: ReportBucket) => number | null; coverage?: (bucket: ReportBucket) => "full" | "partial" | "none" };

function barChart(doc: PdfDoc, input: { title: string; buckets: ReportBucket[]; granularity: Granularity; series: ChartSeries[]; note?: string }): void {
  const x0 = doc.margin;
  const width = doc.width - doc.margin * 2;
  const chartHeight = 110;
  doc.ensure(chartHeight + 60);
  doc.text(x0, doc.y + 10, input.title, { size: 11, bold: true });
  let legendX = x0 + width;
  for (const series of [...input.series].reverse()) {
    const w = textWidth(series.label, 8) + 16;
    legendX -= w;
    doc.rect(legendX, doc.y + 3.5, 8, 8, series.color);
    doc.text(legendX + 11, doc.y + 10, series.label, { size: 8, color: MUTED });
  }
  const top = doc.y + 22;
  const plotLeft = x0 + 26;
  const plotWidth = width - 26;
  const values = input.buckets.flatMap((bucket) => input.series.map((series) => series.value(bucket) ?? 0));
  const max = Math.max(1, ...values);
  const rough = max / 5;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
  const step = max <= 5 ? 1 : [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough)!;
  const ceiling = Math.ceil(max / step) * step;
  for (let tick = 0; tick <= ceiling; tick += step) {
    const y = top + chartHeight - (tick / ceiling) * chartHeight;
    doc.line(plotLeft, y, plotLeft + plotWidth, y, HAIRLINE, 0.4);
    doc.text(plotLeft - 4, y + 2.5, formatNumber(tick), { size: 7, color: MUTED, align: "right" });
  }
  const n = input.buckets.length || 1;
  const slot = plotWidth / n;
  const barWidth = Math.max(1, Math.min(18, (slot * 0.72) / input.series.length));
  const labelEvery = Math.ceil(n / Math.floor(plotWidth / 34));
  let unknownShown = false;
  input.buckets.forEach((bucket, index) => {
    const slotLeft = plotLeft + index * slot;
    const groupWidth = barWidth * input.series.length;
    let left = slotLeft + (slot - groupWidth) / 2;
    for (const series of input.series) {
      const value = series.value(bucket);
      if ((series.coverage && series.coverage(bucket) === "none") || value === null) {
        doc.rect(left, top, barWidth, chartHeight, NOSOURCE);
        unknownShown = true;
      } else {
        const h = (value / ceiling) * chartHeight;
        if (h > 0) doc.rect(left, top + chartHeight - h, barWidth, h, series.color);
      }
      left += barWidth;
    }
    if (index % labelEvery === 0) doc.text(slotLeft + slot / 2, top + chartHeight + 10, bucketLabel(bucket.start, input.granularity), { size: 6.5, color: MUTED, align: "center" });
  });
  doc.line(plotLeft, top + chartHeight, plotLeft + plotWidth, top + chartHeight, MUTED, 0.6);
  doc.y = top + chartHeight + 22;
  if (unknownShown) {
    doc.rect(x0, doc.y - 6.5, 8, 8, NOSOURCE);
    doc.text(x0 + 11, doc.y, input.note ?? "faixa cinza: sem fonte (desconhecido, não zero)", { size: 7.5, color: MUTED });
    doc.y += 12;
  }
}

function table(doc: PdfDoc, input: { columns: Array<{ label: string; width: number; align?: "left" | "right" }>; rows: string[][]; size?: number; wrapColumn?: number; wrapValues?: number[] }): void {
  const size = input.size ?? 8;
  const x0 = doc.margin;
  const lineHeight = size * 1.3;
  const header = () => {
    let x = x0;
    const rowHeight = size * 1.9;
    doc.rect(x0, doc.y, doc.width - doc.margin * 2, rowHeight, CARD);
    for (const column of input.columns) {
      doc.text(column.align === "right" ? x + column.width - 4 : x + 4, doc.y + rowHeight * 0.66, column.label, { size, bold: true, align: column.align === "right" ? "right" : "left", maxWidth: column.width - 8 });
      x += column.width;
    }
    doc.y += rowHeight;
  };
  doc.ensure(size * 1.9 * 2);
  header();
  for (const row of input.rows) {
    // the wrap column (a definition) may take several lines; the others stay on one
    const wrapped = input.wrapColumn !== undefined ? doc.wrap(row[input.wrapColumn] ?? "", input.columns[input.wrapColumn]!.width - 8, size - 0.5) : [];
    // value columns that wrap in full ink instead of ending in "…" (INSP-V r3 #2)
    const values = new Map((input.wrapValues ?? []).map((index) => [index, doc.wrap(row[index] ?? "", input.columns[index]!.width - 8, size)]));
    const tallest = Math.max(wrapped.length, ...[...values.values()].map((lines) => lines.length));
    const rowHeight = Math.max(size * 1.9, tallest * lineHeight + size * 0.8);
    if (doc.y + rowHeight > doc.height - doc.margin - 18) { doc.addPage(); header(); }
    let x = x0;
    row.forEach((cell, index) => {
      const column = input.columns[index]!;
      if (index === input.wrapColumn) {
        wrapped.forEach((line, at) => doc.text(x + 4, doc.y + size * 1.25 + at * lineHeight, line, { size: size - 0.5, color: MUTED }));
      } else if (values.has(index)) {
        values.get(index)!.forEach((line, at) => doc.text(x + 4, doc.y + size * 1.25 + at * lineHeight, line, { size }));
      } else {
        doc.text(column.align === "right" ? x + column.width - 4 : x + 4, doc.y + size * 1.25, cell, { size, align: column.align === "right" ? "right" : "left", maxWidth: column.width - 8 });
      }
      x += column.width;
    });
    doc.line(x0, doc.y + rowHeight, doc.width - doc.margin, doc.y + rowHeight, HAIRLINE, 0.4);
    doc.y += rowHeight;
  }
  doc.y += 10;
}

function heading(doc: PdfDoc, text: string): void {
  // a heading keeps at least its first rows with it (no orphan at a page foot)
  doc.ensure(96);
  doc.y += 6;
  doc.text(doc.margin, doc.y + 12, text, { size: 12.5, bold: true });
  doc.y += 22;
}

const STATUS_COLOR = { met: GOOD, close: WARN, off: BAD } as const;

export function reportPdf(report: ProductivityReport): Buffer {
  const doc = new PdfDoc();
  const k = report.kpis;
  const g = report.granularity;
  const contentWidth = doc.width - doc.margin * 2;
  const title = reportTitle(report);
  // title: the period is part of it
  doc.text(doc.margin, doc.y + 16, title, { size: 17, bold: true, maxWidth: contentWidth });
  doc.y += 30;
  doc.text(doc.margin, doc.y, `Time Nuria · ${PRODUCT_NAME} · ${periodText(report.period)} (${REPORT_TZ}) · por ${granularityName(g, "pt-BR")}`, { size: 9, color: MUTED, maxWidth: contentWidth });
  doc.y += 12;
  doc.text(doc.margin, doc.y, `Comparado a ${periodText(report.previous)} · gerado em ${formatInstant(report.generatedAt)}`, { size: 9, color: MUTED, maxWidth: contentWidth });
  doc.y += 16;
  // a stale or unverified export says so first, in a box the reader cannot miss
  const warnings = exportWarnings(report);
  if (warnings.length) {
    const lines = warnings.flatMap((warning) => doc.wrap(`• ${warning}`, contentWidth - 28, 8.5));
    const boxHeight = 24 + lines.length * 11.5;
    doc.rect(doc.margin, doc.y, contentWidth, boxHeight, WARN_SOFT);
    doc.rect(doc.margin, doc.y, 3, boxHeight, BAD);
    doc.text(doc.margin + 14, doc.y + 15, "Atenção — dados não verificados neste relatório", { size: 10, bold: true, color: BAD });
    lines.forEach((line, index) => doc.text(doc.margin + 14, doc.y + 29 + index * 11.5, line, { size: 8.5 }));
    doc.y += boxHeight + 10;
  }
  // executive summary
  const summary = executiveSummary(report);
  const summaryHeight = summary.reduce((sum, line) => sum + doc.measureLines(line, contentWidth - 40, 9) * 12.5, 0) + 34;
  doc.rect(doc.margin, doc.y, contentWidth, summaryHeight, CARD);
  doc.rect(doc.margin, doc.y, 3, summaryHeight, ACCENT);
  doc.text(doc.margin + 14, doc.y + 17, "Resumo executivo", { size: 11, bold: true });
  let y = doc.y + 32;
  summary.forEach((line, index) => {
    doc.text(doc.margin + 14, y, `${index + 1}.`, { size: 9, bold: true, color: ACCENT });
    y += doc.paragraph(doc.margin + 28, y, line, contentWidth - 40, { size: 9, leading: 12.5 });
  });
  doc.y += summaryHeight + 12;
  // KPI cards, 4 per row, each with its definition beside the number
  // every line of a card is laid out in full: the card grows, the text is never cut (INSP-V r2 #5)
  const cards = boardKpis(report);
  const gap = 8;
  const cardWidth = (contentWidth - gap * 3) / 4;
  const inner = cardWidth - 16;
  const layout = cards.map((card) => ({
    card,
    label: doc.wrap(card.label, inner, 7.5, true),
    value: doc.wrap(card.value, inner, 15, true),
    goal: card.goal ? doc.wrap(`meta ${card.goal.target} · ${STATUS_TEXT[card.goal.status]}`, inner, 6.8, true) : [],
    comparison: doc.wrap(card.comparison, inner, 7.2),
    detail: doc.wrap(card.detail ?? "", inner, 6.6),
    short: doc.wrap(card.short, inner, 6.4),
  }));
  const heightOf = (item: (typeof layout)[number]) => 10 + item.label.length * 9 + item.value.length * 17 + 4 + item.goal.length * 8.5 + item.comparison.length * 8.6 + item.detail.length * 8 + 3 + item.short.length * 7.6 + 6;
  for (let row = 0; row < layout.length; row += 4) {
    const items = layout.slice(row, row + 4);
    const cardHeight = Math.max(...items.map(heightOf));
    doc.ensure(cardHeight + gap);
    items.forEach((item, column) => {
      const x = doc.margin + column * (cardWidth + gap);
      let y = doc.y;
      doc.rect(x, y, cardWidth, cardHeight, CARD);
      y += 13;
      for (const line of item.label) { doc.text(x + 8, y, line, { size: 7.5, bold: true, color: MUTED }); y += 9; }
      y += 8;
      for (const line of item.value) { doc.text(x + 8, y, line, { size: 15, bold: true }); y += 17; }
      y -= 4;
      for (const line of item.goal) { doc.text(x + 8, y, line, { size: 6.8, bold: true, color: STATUS_COLOR[item.card.goal!.status] }); y += 8.5; }
      for (const line of item.comparison) { doc.text(x + 8, y, line, { size: 7.2, color: item.card.good === null ? MUTED : item.card.good ? GOOD : BAD }); y += 8.6; }
      for (const line of item.detail) { doc.text(x + 8, y, line, { size: 6.6, color: MUTED }); y += 8; }
      y += 3;
      for (const line of item.short) { doc.text(x + 8, y, line, { size: 6.4, color: MUTED }); y += 7.6; }
    });
    doc.y += cardHeight + gap;
  }
  doc.y += 6;
  // DORA
  heading(doc, "DORA");
  table(doc, {
    columns: [{ label: "Métrica", width: contentWidth * 0.27 }, { label: "Valor", width: contentWidth * 0.36 }, { label: "Como é contado", width: contentWidth * 0.37 }],
    rows: doraRows(report), wrapColumn: 2, wrapValues: [1], size: 7.8,
  });
  // charts
  const release = (bucket: ReportBucket) => bucket.releaseCoverage;
  barChart(doc, {
    title: `Entregas e falhas que rodaram, por ${granularityName(g, "pt-BR")}`, buckets: report.buckets, granularity: g,
    series: [
      { label: "Entregas em produção", color: ACCENT, value: (bucket) => bucket.deliveries, coverage: release },
      { label: "Falhas que rodaram", color: BAD, value: (bucket) => bucket.failedReleases, coverage: release },
    ],
    note: "faixa cinza: sem fonte de releases (desconhecido, não zero)",
  });
  barChart(doc, {
    title: `Vazão por ${granularityName(g, "pt-BR")}`, buckets: report.buckets, granularity: g,
    series: [
      { label: "PRs mergeadas", color: ACCENT, value: (bucket) => bucket.mergedPrs },
      { label: "Issues fechadas", color: ACCENT_SOFT, value: (bucket) => bucket.closedIssues },
    ],
  });
  // indicators, with the definition beside each one
  heading(doc, "Indicadores");
  table(doc, {
    columns: [{ label: "Indicador", width: contentWidth * 0.24 }, { label: "Período", width: contentWidth * 0.14, align: "right" }, { label: "Anterior", width: contentWidth * 0.12, align: "right" }, { label: "Comparação", width: contentWidth * 0.17 }, { label: "Como é contado", width: contentWidth * 0.33 }],
    rows: cards.map((card) => [card.label, card.value, card.previous, card.goal ? `${card.comparison} · ${STATUS_TEXT[card.goal.status]}` : card.comparison, `${card.short}${card.detail ? `. ${card.detail}` : ""}`]),
    wrapColumn: 4, size: 7.6,
  });
  // releases
  heading(doc, "Releases do período");
  doc.text(doc.margin, doc.y + 4, releaseCounts(report), { size: 8, color: MUTED, maxWidth: contentWidth });
  doc.y += 14;
  const board = boardReleaseRows(report);
  if (!board.rows.length && !board.omitted) { doc.text(doc.margin, doc.y + 8, "Nenhum release, falha ou recusa no período.", { size: 9, color: MUTED }); doc.y += 20; }
  else {
    const prsWidth = contentWidth * 0.25 - 8;
    const issuesWidth = contentWidth * 0.22 - 8;
    table(doc, {
      columns: [{ label: "Quando", width: contentWidth * 0.16 }, { label: "Commit", width: contentWidth * 0.1 }, { label: "Resultado", width: contentWidth * 0.27 }, { label: "PRs", width: contentWidth * 0.25 }, { label: "Issues concluídas", width: contentWidth * 0.22 }],
      rows: board.rows.map((row) => [
        formatInstant(row.at),
        row.sha.slice(0, 9),
        row.tagNotAdvanced ? "em produção*" : outcomeLabel(row),
        row.outcome === "released" ? (row.contentUnknown ? (row.contentUnknownReason === "pending" ? "ainda não lido" : "desconhecido") : fitNumbers(row.prs.filter((pr) => !pr.carrier), prsWidth, 7.5)) : headPrText(row),
        row.outcome === "released" ? fitNumbers(row.issues, issuesWidth, 7.5) : "—",
      ]),
      size: 7.5,
    });
    if (board.omitted) {
      doc.ensure(14);
      doc.text(doc.margin, doc.y, `${pluralPt(board.omitted, "commit só teve", "commits só tiveram")} runs substituídos ou abortados (nenhum rodou): contados acima, não listados.`, { size: 7.5, color: MUTED, maxWidth: contentWidth });
      doc.y += 14;
    }
    if (board.rows.some((row) => row.tagNotAdvanced)) {
      doc.ensure(14);
      doc.text(doc.margin, doc.y, "* no ar, mas o watcher não conseguiu avançar a tag de produção; ela foi movida à mão depois.", { size: 7.5, color: MUTED });
      doc.y += 14;
    }
  }
  // backlog
  const b = report.backlog;
  if (b.periodEnd) {
    heading(doc, `Backlog ao fim do período (${formatInstant(b.periodEnd.at - 60_000, "pt-BR", false)})`);
    const line = `Issues abertas: ${formatNumber(b.periodEnd.openIssues)}. P0/P1: ${formatNumber(b.periodEnd.openP0P1)} (rótulos de hoje).${b.periodEnd.oldestOpen ? ` Mais antiga: #${b.periodEnd.oldestOpen.number} (${formatDuration(b.periodEnd.at - b.periodEnd.oldestOpen.createdAt)} naquela data).` : ""}`;
    doc.y += doc.paragraph(doc.margin, doc.y + 8, line, contentWidth, { size: 8.5, leading: 11.5 }) + 8;
  }
  heading(doc, `Backlog agora${b.at ? ` (${formatInstant(b.at)})` : ""}`);
  for (const line of [
    `Issues abertas: ${formatNumber(b.openIssues)}. P1: ${formatNumber(b.openP1)} (${formatNumber(b.openP1Split.current)} priority:p1 + ${formatNumber(b.openP1Split.legacy)} priority:high, escala antiga). P0: ${formatNumber(b.openP0)} (${formatNumber(b.openP0Split.current)} priority:p0 + ${formatNumber(b.openP0Split.legacy)} priority:critical).`,
    `${b.oldestOpen ? `Mais antiga: #${b.oldestOpen.number} (${formatDuration(report.generatedAt - b.oldestOpen.createdAt)}). ` : ""}${b.oldestOpenP1 ? `P0/P1 mais antiga: #${b.oldestOpenP1.number} (${formatDuration(report.generatedAt - b.oldestOpenP1.createdAt)}). ` : ""}PRs esperando o gate: ${formatNumber(b.prsAwaitingGate)} de ${formatNumber(b.openPrs)} abertas.`,
  ]) {
    doc.ensure(24);
    doc.y += doc.paragraph(doc.margin, doc.y + 8, line, contentWidth, { size: 8.5, leading: 11.5 }) + 2;
  }
  doc.y += 6;
  // bots
  heading(doc, "Esforço dos bots");
  if (k.usageDays <= 0) { doc.text(doc.margin, doc.y + 8, "Sem registro de uso dos bots no período (—, não zero).", { size: 9, color: MUTED }); doc.y += 20; }
  else {
    const line = `Cobre ${daysText(k.usageDays)} dias registrados. Custo ${formatMoney(k.costUsd)}: engenharia ${formatMoney(k.costEngineeringUsd ?? 0)}, operação (Monitor Chat, Chief of Staff) ${formatMoney(k.costOperationsUsd ?? 0)}${k.costOtherUsd !== null ? `, outros (bots fora da lista de papéis) ${formatMoney(k.costOtherUsd)}` : ""}. Custo de engenharia por entrega: ${costPerDeliveryText(report)}.`;
    doc.y += doc.paragraph(doc.margin, doc.y + 6, line, contentWidth, { size: 8.5, color: MUTED, leading: 11.5 }) + 6;
    table(doc, {
      columns: [{ label: "Bot", width: contentWidth * 0.24 }, { label: "Turnos", width: contentWidth * 0.12, align: "right" }, { label: "Horas ativas", width: contentWidth * 0.14, align: "right" }, { label: "Custo", width: contentWidth * 0.14, align: "right" }, { label: "Precisa de você (abertos/resolvidos)", width: contentWidth * 0.36, align: "right" }],
      rows: report.bots.map((bot) => [bot.name, formatNumber(bot.turns), formatDuration(bot.timedTurns ? bot.activeMs : null), formatMoney(bot.costUsd), `${bot.needsYouOpened} / ${bot.needsYouResolved}`]),
    });
  }
  // definitions + coverage
  heading(doc, "Definições");
  for (const [name, text] of DEFINITIONS_PT) {
    const height = doc.measureLines(`${name}: ${text}`, contentWidth, 8) * 11 + 3;
    doc.ensure(height);
    doc.y += doc.paragraph(doc.margin, doc.y + 8, `${name}: ${text}`, contentWidth, { size: 8, color: MUTED, leading: 11 }) + 3;
  }
  heading(doc, "Cobertura dos dados");
  for (const line of coverageLines(report)) {
    const height = doc.measureLines(line, contentWidth, 8) * 11 + 3;
    doc.ensure(height);
    doc.y += doc.paragraph(doc.margin, doc.y + 8, line, contentWidth, { size: 8, color: MUTED, leading: 11 }) + 3;
  }
  return doc.render({ title, createdAt: report.generatedAt, footer: `${title} · Time Nuria · ${PRODUCT_NAME} · OpenMausBot` });
}

/** File name for a download: produtividade-2026-09.pdf, or by day range. */
export function exportFileName(report: ProductivityReport, extension: "pdf" | "md"): string {
  const day = (ms: number) => formatInstant(ms, "en", false);
  return `produtividade-${granularityName(report.granularity, "pt-BR").replace("ê", "e")}-${day(report.period.from)}_${day(report.period.to - 1)}.${extension}`;
}
