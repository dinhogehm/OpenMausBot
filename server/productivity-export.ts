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
  beforeRepo, compareKpi, goalStatus, periodTitle, releaseComparable, REPORT_TZ, zonedParts,
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
  return [
    kpi({ key: "deliveries", label: "Entregas em produção", value: formatNumber(k.deliveries), current: k.deliveries, previous: p.deliveries, better: "up", release: true,
      detail: `${lowerBound ? "≥" : ""}${pluralPt(k.deliveredPrs, "PR", "PRs")} e ${lowerBound ? "≥" : ""}${pluralPt(k.deliveredIssues, "issue concluída", "issues concluídas")} no ar${lowerBound ? ` · ${pluralPt(k.unknownContentReleases, "release sem conteúdo lido", "releases sem conteúdo lido")}` : ""}`,
      short: "avanços da tag de produção (fim do deploy)" }),
    kpi({ key: "deployFrequency", label: "Frequência de deploy", value: k.deploysPerBusinessDay === null ? "—" : `${formatNumber(k.deploysPerBusinessDay, "pt-BR", 1)}/dia útil`, current: k.deploysPerBusinessDay, previous: p.deploysPerBusinessDay, better: "up", release: true, base: p.deliveries,
      detail: `${formatNumber(k.deliveries)} em ${formatNumber(k.businessDays, "pt-BR", 1)} dias úteis`, short: "DORA: entregas por dia útil (seg–sex)",
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
      detail: `${pluralPt(k.closedByType.bug, "bug", "bugs")} · ${formatNumber(k.closedByPriority.p0 + k.closedByPriority.p1)} P0/P1 · ${formatNumber(k.closedNotPlanned)} não planejadas à parte`,
      short: "fechadas como concluídas no período" }),
    kpi({ key: "openP1", label: "Issues P0/P1 abertas", value: formatNumber(b.openP0 + b.openP1), current: k.openP1AtEnd, previous: p.openP1AtEnd, better: "down", github: true,
      detail: `P1 ${formatNumber(b.openP1)} = ${formatNumber(p1.current)} priority:p1 + ${formatNumber(p1.legacy)} priority:high (legado) · P0 ${formatNumber(b.openP0)}`,
      short: "agora; P1 = p1 + high, P0 = p0 + critical" }),
    kpi({ key: "blocked", label: "Pipeline de release parado", value: formatDuration(k.blockedMs) === "—" ? "0 h" : formatDuration(k.blockedMs), current: k.blockedMs, previous: p.blockedMs, better: "down", release: true, kind: "duration",
      detail: `produção no ar · ${formatDuration(k.blockedWeekendMs)} em fim de semana`, short: "1ª falha que rodou após um sucesso até o próximo sucesso" }),
  ];
}

/** DORA, as the board knows it. */
export function doraRows(report: ProductivityReport): Array<[string, string, string]> {
  const k = report.kpis;
  const cfr = k.checkedReleases ? k.changeFailures / k.checkedReleases : null;
  return [
    ["Frequência de deploy", k.deploysPerBusinessDay === null ? "—" : `${formatNumber(k.deploysPerBusinessDay, "pt-BR", 1)} por dia útil (${formatNumber(k.deliveries)} em ${formatNumber(k.businessDays, "pt-BR", 1)} dias úteis)`, "entregas em produção ÷ dias úteis decorridos"],
    ["Lead time de mudança", k.leadMergeToProd.n ? `${formatDuration(k.leadMergeToProd.median)} (p90 ${formatDuration(k.leadMergeToProd.p90)}, n=${k.leadMergeToProd.n})` : "—", "merge da PR até o fim do deploy que a levou ao ar (mediana)"],
    ["Taxa de falha de mudança", cfr === null ? "— (nenhum release com verificação pós-release)" : `${formatPercent(cfr)} (${k.changeFailures} de ${k.checkedReleases} releases verificados)`, "releases cuja verificação pós-release reverteu ou achou produção fora do ar ÷ releases com verificação conclusiva"],
    ["Tempo de restauração", k.timeToRestore.n ? `${formatDuration(k.timeToRestore.median)} (n=${k.timeToRestore.n})` : k.changeFailures ? "— (sem release saudável depois da falha)" : "— (nenhuma falha de mudança registrada)", "da falha de mudança ao próximo release com verificação saudável"],
  ];
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
  const usageNote = k.usageDays > 0 ? (pt ? ` em ${formatNumber(k.usageDays, lang, 1)} dias registrados` : ` over ${formatNumber(k.usageDays, lang, 1)} recorded days`) : "";
  const perDelivery = k.costPerDelivery !== null ? (pt ? `; ${formatMoney(k.costPerDelivery, lang)} por entrega` : `; ${formatMoney(k.costPerDelivery, lang)} per delivery`) : "";
  const cost = k.costUsd !== null ? `, ${formatMoney(k.costUsd, lang)}${usageNote}${perDelivery}` : "";
  const bots = k.usageDays > 0 ? (pt ? `Bots: ${n(k.turns, "turno", "turnos")}${cost}.` : `Bots: ${n(k.turns, "turn", "turns")}${cost}.`) : (pt ? "Bots: sem registro de uso no período." : "Bots: no usage recorded in the period.");
  if (pt) {
    return [
      `Produção: ${n(k.deliveries, "entrega", "entregas")} (${cmp(k.deliveries, p.deliveries, { release: true })}), ${formatNumber(k.deploysPerBusinessDay ?? 0, lang, 1)} por dia útil, com ${lower}${n(k.deliveredPrs, "PR", "PRs")} e ${lower}${n(k.deliveredIssues, "issue concluída", "issues concluídas")} no ar${k.unknownContentReleases ? ` (${n(k.unknownContentReleases, "release sem conteúdo lido", "releases sem conteúdo lido")})` : ""}${gaps ? "; parte do período sem fonte de releases" : ""}.`,
      `Vazão: ${n(k.mergedPrs, "PR mergeada", "PRs mergeadas")} (${cmp(k.mergedPrs, p.mergedPrs, { github: true })}) e ${n(resolved, "issue resolvida", "issues resolvidas")} (${cmp(resolved, previousResolved, { github: true })}), ${n(k.closedByType.bug, "bug", "bugs")} e ${formatNumber(k.closedByPriority.p0 + k.closedByPriority.p1)} P0/P1.`,
      `Lead time issue até produção: ${k.leadIssueToProd.n ? `mediana ${formatDuration(k.leadIssueToProd.median, lang)}, p90 ${formatDuration(k.leadIssueToProd.p90, lang)} (n=${k.leadIssueToProd.n}; ${cmp(k.leadIssueToProd.median, p.leadIssueToProd.median, { release: true, kind: "duration", samples: { current: k.leadIssueToProd.n, previous: p.leadIssueToProd.n } })})` : "nenhuma issue concluída entregue"}; merge até produção ${formatDuration(k.leadMergeToProd.median, lang)}.`,
      `Backlog agora: ${n(b.openIssues, "issue aberta", "issues abertas")}; P1 ${formatNumber(b.openP1)} (${formatNumber(b.openP1Split.current)} priority:p1 + ${formatNumber(b.openP1Split.legacy)} priority:high legado) e P0 ${formatNumber(b.openP0)}; a mais antiga ${oldest}; ${n(b.prsAwaitingGate, "PR esperando", "PRs esperando")} o gate.`,
      `Releases: sucesso ${formatPercent(k.releaseSuccessRate, lang)} (${formatNumber(k.deliveries)} de ${formatNumber(tries)} que rodaram; ${n(k.supersededReleases, "substituído", "substituídos")} e ${n(k.abortedReleases, "abortado", "abortados")} fora da taxa), ${n(k.declinedReleases, "recusado", "recusados")}; pipeline parado ${k.blockedMs > 0 ? formatDuration(k.blockedMs, lang) : "0 h"} com produção no ar (${formatDuration(k.blockedWeekendMs, lang)} em fim de semana). ${bots}`,
    ];
  }
  return [
    `Production: ${n(k.deliveries, "delivery", "deliveries")} (${cmp(k.deliveries, p.deliveries, { release: true })}), ${formatNumber(k.deploysPerBusinessDay ?? 0, lang, 1)} per business day, carrying ${lower}${n(k.deliveredPrs, "PR", "PRs")} and ${lower}${n(k.deliveredIssues, "completed issue", "completed issues")} live${k.unknownContentReleases ? ` (${n(k.unknownContentReleases, "release with contents not read", "releases with contents not read")})` : ""}${gaps ? "; part of the period has no release source" : ""}.`,
    `Throughput: ${n(k.mergedPrs, "PR merged", "PRs merged")} (${cmp(k.mergedPrs, p.mergedPrs, { github: true })}) and ${n(resolved, "issue resolved", "issues resolved")} (${cmp(resolved, previousResolved, { github: true })}), ${n(k.closedByType.bug, "bug", "bugs")} and ${formatNumber(k.closedByPriority.p0 + k.closedByPriority.p1, lang)} P0/P1.`,
    `Lead time issue to production: ${k.leadIssueToProd.n ? `median ${formatDuration(k.leadIssueToProd.median, lang)}, p90 ${formatDuration(k.leadIssueToProd.p90, lang)} (n=${k.leadIssueToProd.n}; ${cmp(k.leadIssueToProd.median, p.leadIssueToProd.median, { release: true, kind: "duration", samples: { current: k.leadIssueToProd.n, previous: p.leadIssueToProd.n } })})` : "no completed issue delivered"}; merge to production ${formatDuration(k.leadMergeToProd.median, lang)}.`,
    `Backlog now: ${n(b.openIssues, "open issue", "open issues")}; P1 ${formatNumber(b.openP1, lang)} (${formatNumber(b.openP1Split.current, lang)} priority:p1 + ${formatNumber(b.openP1Split.legacy, lang)} legacy priority:high) and P0 ${formatNumber(b.openP0, lang)}; the oldest ${oldest}; ${n(b.prsAwaitingGate, "PR waiting", "PRs waiting")} for the gate.`,
    `Releases: ${formatPercent(k.releaseSuccessRate, lang)} success (${formatNumber(k.deliveries, lang)} of ${formatNumber(tries, lang)} that ran; ${formatNumber(k.supersededReleases, lang)} superseded and ${formatNumber(k.abortedReleases, lang)} aborted left out), ${formatNumber(k.declinedReleases, lang)} declined; release pipeline stopped ${k.blockedMs > 0 ? formatDuration(k.blockedMs, lang) : "0 h"} with production up (${formatDuration(k.blockedWeekendMs, lang)} on weekends). ${bots}`,
  ];
}

// ── definitions (shared by the export; the app has the same in i18n) ────────

export const DEFINITIONS_PT: ReadonlyArray<[string, string]> = [
  ["Entregas em produção", "avanços da tag nuria-production-deployed: releases que terminaram o deploy (log do watcher de produção; antes de 15/09, deployments de produção do GitHub). O horário é o fim do deploy. Um deploy que foi ao ar sem a tag avançar (push recusado) conta e é marcado."],
  ["PRs e issues entregues", "PRs mergeadas cujos commits entraram entre o release anterior e este (compare do GitHub), sem os carriers de release. Issue entregue: só as citadas explicitamente pela PR (vínculo do GitHub, ou Closes/Fixes/Resolves/Refs #N no corpo ou no commit) e já fechadas como concluídas. Release cujo conteúdo ainda não foi lido torna o total um mínimo (≥)."],
  ["Frequência de deploy (DORA)", "entregas em produção ÷ dias úteis (seg–sex, horário de São Paulo) decorridos no período."],
  ["Sucesso de release", "entregas ÷ (entregas + falhas). Falha é a tentativa que rodou (CI ou deploy) e não avançou a tag. Substituídos (o watcher passou a um commit mais novo, ou o run saiu da fila sem rodar) e abortados (pararam antes de rodar: lock, smart-deploy que não iniciou) ficam fora da taxa."],
  ["Lead time", "criação da issue até o fim do deploy que levou sua PR ao ar, para as issues concluídas entregues no período; mediana e p90 (posto mais próximo). Lead time de mudança (DORA): merge da PR até o fim do deploy."],
  ["Taxa de falha de mudança e tempo de restauração (DORA)", "pela verificação pós-release (POST_RELEASE_RESULT): reverteu ou achou produção fora do ar ÷ releases com verificação conclusiva; restauração = da falha ao próximo release com verificação saudável. Sem verificação ou sem falha, aparece —."],
  ["PRs mergeadas", "PRs mergeadas na main no período, sem os carriers de release (chore/release-carrier-*), que só publicam outras PRs."],
  ["Issues resolvidas", "issues fechadas como concluídas no período (não planejadas e duplicadas à parte); tipo pelos rótulos type:bug/hotfix, type:improvement, type:feature."],
  ["Prioridade", "P0 = priority:p0 + priority:critical; P1 = priority:p1 + priority:high (escala antiga, contada junto e mostrada à parte); P2 = p2 + medium; P3 = p3 + low. A tendência do backlog usa os rótulos de hoje no fim de cada período."],
  ["PRs esperando o gate", "PRs abertas na main, fora de rascunho, sem o status nuria/local-merge-gate verde no último commit (retrato de agora)."],
  ["Pipeline de release parado", "produção continua no ar; conta do primeiro release que rodou e falhou depois de um sucesso até o próximo sucesso. Runs substituídos e abortados não abrem intervalo. A parte em sábado e domingo aparece separada."],
  ["Esforço dos bots", "dados locais do OpenMausBot, só nos dias em que o ledger de uso existe (antes: —). Custo por entrega = custo desses dias ÷ entregas nesses mesmos dias. \"Precisa de você\": itens abertos e resolvidos; resposta do dono = do item aberto à primeira resposta (ou resolução) do dono."],
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

function releaseCounts(report: ProductivityReport): string {
  const rows = report.releases;
  const count = (outcome: string) => rows.filter((row) => row.outcome === outcome);
  const tries = (outcome: string) => count(outcome).reduce((sum, row) => sum + (row.attempts ?? 1), 0);
  return [
    `${count("released").length} em produção`,
    `${pluralPt(count("failed").length, "commit falhou", "commits falharam")} (${pluralPt(tries("failed"), "tentativa", "tentativas")} que rodaram)`,
    pluralPt(tries("superseded"), "substituído", "substituídos"),
    pluralPt(tries("aborted"), "abortado", "abortados"),
    pluralPt(count("declined").length, "recusado", "recusados"),
  ].join(" · ");
}

function coverageLines(report: ProductivityReport): string[] {
  const c = report.coverage;
  const lines: string[] = [];
  if (c.releaseLog.from !== null) lines.push(`Log do watcher de produção desde ${formatInstant(c.releaseLog.from)}.`);
  if (c.githubDeployments.from !== null) lines.push(`Deployments de produção do GitHub de ${formatInstant(c.githubDeployments.from)} a ${formatInstant(c.githubDeployments.to!)}.`);
  for (const gap of c.releaseGaps) lines.push(`Sem fonte de releases de ${formatInstant(gap.from)} a ${formatInstant(gap.to)}: entregas e falhas desse trecho não são conhecidas (não são zero).`);
  lines.push(c.github.syncedAt ? `GitHub sincronizado em ${formatInstant(c.github.syncedAt)} (${formatNumber(c.github.prs)} PRs, ${formatNumber(c.github.issues)} issues${c.github.complete ? "" : ", sincronização ainda em andamento"}).` : "GitHub ainda não sincronizado.");
  if (c.github.repoCreatedAt) lines.push(`Repositório criado em ${formatInstant(c.github.repoCreatedAt, "pt-BR", false)}: nenhum período anterior a isso serve de comparação.`);
  if (c.tag.sha) lines.push(`Tag de produção no GitHub: ${c.tag.sha.slice(0, 9)}${c.tag.matchesHistory === true ? " (confere com o histórico)" : c.tag.matchesHistory === false ? " (NÃO confere com o último release do histórico)" : ""}.`);
  lines.push(c.usage.from !== null ? `Ledger de uso dos bots desde ${formatInstant(c.usage.from)}; antes disso os números dos bots são — (sem registro), não zero.` : "Sem ledger de uso dos bots.");
  if (c.digests.from !== null) lines.push(`Durações de turno desde ${formatInstant(c.digests.from)}.`);
  if (c.needsYou.from !== null) lines.push(`"Precisa de você" registrado desde ${formatInstant(c.needsYou.from)}.`);
  return lines;
}

const goalText = (kpi: BoardKpi) => (kpi.goal ? `${kpi.goal.target} · ${STATUS_TEXT[kpi.goal.status]}` : "—");

export function reportTitle(report: ProductivityReport): string {
  return `Produtividade de engenharia — ${periodTitle(report.period, report.generatedAt)}`;
}

export function reportMarkdown(report: ProductivityReport): string {
  const g = report.granularity;
  const k = report.kpis;
  const lines: string[] = [];
  lines.push(`# ${reportTitle(report)}`, "");
  lines.push(`**Time Nuria · ${PRODUCT_NAME}** · ${periodText(report.period)} (${REPORT_TZ}) · por ${granularityName(g, "pt-BR")} · comparado a ${periodText(report.previous)} · gerado em ${formatInstant(report.generatedAt)}`, "");
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
  if (!report.releases.length) lines.push("Nenhum release, falha ou recusa no período.");
  else {
    lines.push("| Quando | Commit | Resultado | PRs | Issues concluídas |", "|---|---|---|---|---|");
    for (const release of report.releases) {
      const what = (release.attempts ?? 1) > 1 ? `${outcomeText(release.outcome)} (${release.attempts} tentativas)` : release.tagNotAdvanced ? `${outcomeText(release.outcome)} (tag movida à mão)` : outcomeText(release.outcome);
      const prs = release.outcome === "released" ? (release.contentUnknown ? UNKNOWN_REASON[release.contentUnknownReason ?? "pending"]! : nums(release.prs.filter((pr) => !pr.carrier))) : headPrText(release);
      lines.push(`| ${formatInstant(release.at)} | \`${release.sha.slice(0, 9)}\` | ${what} | ${prs} | ${release.outcome === "released" ? nums(release.issues) : "—"} |`);
    }
  }
  const b = report.backlog;
  lines.push("", "## Backlog (agora)", "");
  lines.push(`- Issues abertas: ${formatNumber(b.openIssues)}`);
  lines.push(`- P1: ${formatNumber(b.openP1)} = ${formatNumber(b.openP1Split.current)} priority:p1 + ${formatNumber(b.openP1Split.legacy)} priority:high (escala antiga)`);
  lines.push(`- P0: ${formatNumber(b.openP0)} = ${formatNumber(b.openP0Split.current)} priority:p0 + ${formatNumber(b.openP0Split.legacy)} priority:critical (escala antiga)`);
  if (b.oldestOpen) lines.push(`- Mais antiga aberta: #${b.oldestOpen.number}, aberta em ${formatInstant(b.oldestOpen.createdAt, "pt-BR", false)} (${formatDuration(report.generatedAt - b.oldestOpen.createdAt)})`);
  if (b.oldestOpenP1) lines.push(`- P0/P1 mais antiga: #${b.oldestOpenP1.number}, aberta em ${formatInstant(b.oldestOpenP1.createdAt, "pt-BR", false)} (${formatDuration(report.generatedAt - b.oldestOpenP1.createdAt)})`);
  lines.push(`- PRs esperando o gate: ${formatNumber(b.prsAwaitingGate)}${b.prsAwaitingGateList.length ? ` (${nums(b.prsAwaitingGateList, 15)})` : ""} de ${formatNumber(b.openPrs)} abertas`);
  lines.push("", "## Esforço dos bots", "");
  if (k.usageDays <= 0) lines.push("Sem registro de uso dos bots no período (—, não zero).");
  else {
    lines.push(`Cobre ${formatNumber(k.usageDays, "pt-BR", 1)} dias registrados do período. Custo: ${formatMoney(k.costUsd)}; por entrega: ${formatMoney(k.costPerDelivery)} (${formatNumber(k.deliveriesInUsageDays)} entregas nesses dias).`, "");
    lines.push("| Bot | Turnos | Horas ativas | Tokens (entrada / saída) | Custo | \"Precisa de você\" abertos / resolvidos |", "|---|---:|---:|---:|---:|---:|");
    for (const bot of report.bots) lines.push(`| ${md(bot.name)} | ${formatNumber(bot.turns)} | ${formatDuration(bot.timedTurns ? bot.activeMs : null)} | ${formatNumber(bot.inputTokens)} / ${formatNumber(bot.outputTokens)} | ${formatMoney(bot.costUsd)} | ${bot.needsYouOpened} / ${bot.needsYouResolved} |`);
  }
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
// WinAnsi has no true minus, arrows or ≥/≤: the minus becomes an en dash (not a hyphen)
const SUBSTITUTE: Record<string, string> = { "→": "»", "←": "«", "↑": "+", "↓": "–", "−": "–", "≥": ">=", "≤": "<=", "✓": "v" };

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
  for (const char of text) {
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

function table(doc: PdfDoc, input: { columns: Array<{ label: string; width: number; align?: "left" | "right" }>; rows: string[][]; size?: number; wrapColumn?: number }): void {
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
    const rowHeight = Math.max(size * 1.9, wrapped.length * lineHeight + size * 0.8);
    if (doc.y + rowHeight > doc.height - doc.margin - 18) { doc.addPage(); header(); }
    let x = x0;
    row.forEach((cell, index) => {
      const column = input.columns[index]!;
      if (index === input.wrapColumn) {
        wrapped.forEach((line, at) => doc.text(x + 4, doc.y + size * 1.25 + at * lineHeight, line, { size: size - 0.5, color: MUTED }));
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
  const cards = boardKpis(report);
  const gap = 8;
  const cardWidth = (contentWidth - gap * 3) / 4;
  const cardHeight = 92;
  doc.ensure(cardHeight * 2 + gap + 10);
  cards.forEach((card, index) => {
    const x = doc.margin + (index % 4) * (cardWidth + gap);
    const top = doc.y + Math.floor(index / 4) * (cardHeight + gap);
    const inner = cardWidth - 16;
    doc.rect(x, top, cardWidth, cardHeight, CARD);
    doc.text(x + 8, top + 13, card.label, { size: 7.5, bold: true, color: MUTED, maxWidth: inner });
    doc.text(x + 8, top + 33, card.value, { size: 15, bold: true, maxWidth: inner });
    const lines = [card.comparison];
    doc.text(x + 8, top + 46, lines[0]!, { size: 7.2, color: card.good === null ? MUTED : card.good ? GOOD : BAD, maxWidth: inner });
    let line = top + 56;
    for (const text of doc.wrap(card.detail ?? "", inner, 6.6).slice(0, 2)) { doc.text(x + 8, line, text, { size: 6.6, color: MUTED }); line += 8; }
    for (const text of doc.wrap(card.short, inner, 6.4).slice(0, 2)) { doc.text(x + 8, line, text, { size: 6.4, color: MUTED }); line += 7.6; }
    if (card.goal) doc.text(x + cardWidth - 8, top + 13, `meta ${card.goal.target}`, { size: 6.4, bold: true, color: STATUS_COLOR[card.goal.status], align: "right" });
  });
  doc.y += cardHeight * 2 + gap + 14;
  // DORA
  heading(doc, "DORA");
  table(doc, {
    columns: [{ label: "Métrica", width: contentWidth * 0.27 }, { label: "Valor", width: contentWidth * 0.36 }, { label: "Como é contado", width: contentWidth * 0.37 }],
    rows: doraRows(report), wrapColumn: 2, size: 7.8,
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
  if (!report.releases.length) { doc.text(doc.margin, doc.y + 8, "Nenhum release, falha ou recusa no período.", { size: 9, color: MUTED }); doc.y += 20; }
  else {
    const prsWidth = contentWidth * 0.3 - 8;
    const issuesWidth = contentWidth * 0.25 - 8;
    table(doc, {
      columns: [{ label: "Quando", width: contentWidth * 0.17 }, { label: "Commit", width: contentWidth * 0.11 }, { label: "Resultado", width: contentWidth * 0.17 }, { label: "PRs", width: contentWidth * 0.3 }, { label: "Issues concluídas", width: contentWidth * 0.25 }],
      rows: report.releases.map((row) => [
        formatInstant(row.at),
        row.sha.slice(0, 9),
        (row.attempts ?? 1) > 1 ? `${outcomeText(row.outcome)} (${row.attempts}x)` : row.tagNotAdvanced ? "em produção*" : outcomeText(row.outcome),
        row.outcome === "released" ? (row.contentUnknown ? (row.contentUnknownReason === "pending" ? "ainda não lido" : "desconhecido") : fitNumbers(row.prs.filter((pr) => !pr.carrier), prsWidth, 7.5)) : headPrText(row),
        row.outcome === "released" ? fitNumbers(row.issues, issuesWidth, 7.5) : "—",
      ]),
      size: 7.5,
    });
    if (report.releases.some((row) => row.tagNotAdvanced)) {
      doc.ensure(14);
      doc.text(doc.margin, doc.y, "* no ar, mas o watcher não conseguiu avançar a tag de produção; ela foi movida à mão depois.", { size: 7.5, color: MUTED });
      doc.y += 14;
    }
  }
  // backlog
  heading(doc, "Backlog (agora)");
  const b = report.backlog;
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
    doc.text(doc.margin, doc.y + 6, `Cobre ${formatNumber(k.usageDays, "pt-BR", 1)} dias registrados. Custo ${formatMoney(k.costUsd)}; por entrega ${formatMoney(k.costPerDelivery)} (${formatNumber(k.deliveriesInUsageDays)} entregas nesses dias).`, { size: 8.5, color: MUTED, maxWidth: contentWidth });
    doc.y += 16;
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
