// "Exportar para o board" (lot V): the productivity report as Markdown and as
// a PDF, both opening with a five-line executive summary — numbers and their
// trend, in pt-BR. What leaves the machine names work by its number only
// (PR #N, issue #N): titles, failure causes and bot answers stay in the app,
// so no client's name is ever exported.
//
// The PDF is written by hand (PDF 1.4, the standard Helvetica fonts in
// WinAnsi, one Flate stream per page): no dependency, deterministic output.
import { deflateSync } from "node:zlib";
import {
  REPORT_TZ, trend, zonedParts,
  type Distribution, type Granularity, type ProductivityReport, type ReportBucket, type ReportKpis,
} from "../shared/productivity.ts";

export type SummaryLang = "pt-BR" | "en";

// ── formatting ──────────────────────────────────────────────────────────────

const pad = (value: number) => String(value).padStart(2, "0");

export function formatNumber(value: number, lang: SummaryLang = "pt-BR", digits = 0): string {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

/** A duration a person reads at a glance: "38 min", "5,2 h", "2,3 d". */
export function formatDuration(ms: number | null, lang: SummaryLang = "pt-BR"): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const minutes = ms / 60_000;
  if (minutes < 1) return lang === "pt-BR" ? "< 1 min" : "< 1 min";
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

/** "+3 (+150%)", "−1 (−20%)", "=" or a note that there is nothing to compare. */
export function trendText(current: number | null, previous: number | null, lang: SummaryLang = "pt-BR", kind: "count" | "duration" = "count"): string {
  const moved = trend(current, previous);
  if (!moved) return lang === "pt-BR" ? "sem base de comparação" : "nothing to compare";
  if (moved.delta === 0) return lang === "pt-BR" ? "= período anterior" : "= previous period";
  const sign = moved.delta > 0 ? "+" : "−";
  const amount = kind === "duration" ? formatDuration(Math.abs(moved.delta), lang) : formatNumber(Math.abs(moved.delta), lang);
  const ratio = moved.ratio === null ? "" : ` (${sign}${formatNumber(Math.abs(moved.ratio) * 100, lang)}%)`;
  return `${sign}${amount}${ratio}`;
}

const granularityName = (granularity: Granularity, lang: SummaryLang) =>
  lang === "pt-BR" ? { hour: "hora", day: "dia", month: "mês" }[granularity] : granularity;

// ── executive summary ───────────────────────────────────────────────────────

const lead = (d: Distribution, lang: SummaryLang) => d.n
  ? (lang === "pt-BR" ? `mediana ${formatDuration(d.median, lang)}, p90 ${formatDuration(d.p90, lang)} (n=${d.n})` : `median ${formatDuration(d.median, lang)}, p90 ${formatDuration(d.p90, lang)} (n=${d.n})`)
  : (lang === "pt-BR" ? "sem entregas com issue vinculada" : "no delivered issue linked");

/** Five lines, numbers first, each with its trend against the previous period. */
export function executiveSummary(report: ProductivityReport, lang: SummaryLang = "pt-BR"): string[] {
  const k = report.kpis;
  const p = report.previousKpis;
  const b = report.backlog;
  const pt = lang === "pt-BR";
  const unknown = report.buckets.some((bucket) => bucket.releaseCoverage !== "full" && bucket.start < report.generatedAt);
  const coverageNote = unknown ? (pt ? " — parte do período sem fonte de releases" : " — part of the period has no release source") : "";
  const oldest = b.oldestOpen ? (pt ? `; a mais antiga, #${b.oldestOpen.number}, tem ${formatDuration(report.generatedAt - b.oldestOpen.createdAt, lang)}` : `; the oldest, #${b.oldestOpen.number}, is ${formatDuration(report.generatedAt - b.oldestOpen.createdAt, lang)} old`) : "";
  const n = (value: number, one: string, many: string) => `${formatNumber(value, lang)} ${value === 1 ? one : many}`;
  const blocked = k.blockedMs > 0 ? formatDuration(k.blockedMs, lang) : "0 h";
  const active = k.activeMs > 0 ? formatDuration(k.activeMs, lang) : "0 min";
  const resolved = k.closedIssues - k.closedNotPlanned;
  const previousResolved = p.closedIssues - p.closedNotPlanned;
  const leadTrend = k.leadIssueToProd.n && p.leadIssueToProd.n;
  if (pt) {
    return [
      `Produção: ${n(k.deliveries, "entrega", "entregas")} (${trendText(k.deliveries, p.deliveries)}), com ${n(k.deliveredPrs, "PR", "PRs")} e ${n(k.deliveredIssues, "issue", "issues")} no ar${coverageNote}.`,
      `Vazão: ${n(k.mergedPrs, "PR mergeada", "PRs mergeadas")} (${trendText(k.mergedPrs, p.mergedPrs)}) e ${n(resolved, "issue resolvida", "issues resolvidas")} (${trendText(resolved, previousResolved)}), ${n(k.closedByType.bug, "bug", "bugs")} e ${formatNumber(k.closedByPriority.p0 + k.closedByPriority.p1)} P0/P1.`,
      `Lead time issue → produção: ${lead(k.leadIssueToProd, lang)}${leadTrend ? `; mediana ${trendText(k.leadIssueToProd.median, p.leadIssueToProd.median, lang, "duration")}` : ""}.`,
      `Backlog agora: ${n(b.openIssues, "issue aberta", "issues abertas")}, ${formatNumber(b.openP0 + b.openP1)} P0/P1${oldest}; ${n(b.prsAwaitingGate, "PR esperando", "PRs esperando")} o gate.`,
      `Falhas: ${n(k.failedReleases, "tentativa de release falhou", "tentativas de release falharam")} (${trendText(k.failedReleases, p.failedReleases)}), ${n(k.declinedReleases, "recusada", "recusadas")}; produção travada ${blocked}. Bots: ${n(k.turns, "turno", "turnos")}, ${active} ativos${k.costUsd !== null ? `, ${formatMoney(k.costUsd)}` : ""}.`,
    ];
  }
  return [
    `Production: ${n(k.deliveries, "delivery", "deliveries")} (${trendText(k.deliveries, p.deliveries, lang)}), carrying ${n(k.deliveredPrs, "PR", "PRs")} and ${n(k.deliveredIssues, "issue", "issues")} live${coverageNote}.`,
    `Throughput: ${n(k.mergedPrs, "PR merged", "PRs merged")} (${trendText(k.mergedPrs, p.mergedPrs, lang)}) and ${n(resolved, "issue resolved", "issues resolved")} (${trendText(resolved, previousResolved, lang)}), ${n(k.closedByType.bug, "bug", "bugs")} and ${formatNumber(k.closedByPriority.p0 + k.closedByPriority.p1, lang)} P0/P1.`,
    `Lead time issue → production: ${lead(k.leadIssueToProd, lang)}${leadTrend ? `; median ${trendText(k.leadIssueToProd.median, p.leadIssueToProd.median, lang, "duration")}` : ""}.`,
    `Backlog now: ${n(b.openIssues, "open issue", "open issues")}, ${formatNumber(b.openP0 + b.openP1, lang)} P0/P1${oldest}; ${n(b.prsAwaitingGate, "PR waiting", "PRs waiting")} for the gate.`,
    `Failures: ${n(k.failedReleases, "release attempt failed", "release attempts failed")} (${trendText(k.failedReleases, p.failedReleases, lang)}), ${formatNumber(k.declinedReleases, lang)} declined; production blocked ${blocked}. Bots: ${n(k.turns, "turn", "turns")}, ${active} active${k.costUsd !== null ? `, ${formatMoney(k.costUsd, lang)}` : ""}.`,
  ];
}

// ── definitions (shared by the export; the app has the same in i18n) ────────

export const DEFINITIONS_PT: ReadonlyArray<[string, string]> = [
  ["Entregas em produção", "avanços da tag nuria-production-deployed: releases que terminaram o deploy (log do watcher de produção; antes de 15/09, deployments de produção do GitHub). O horário é o fim do deploy."],
  ["PRs e issues entregues", "PRs mergeadas cujos commits entraram entre a release anterior e esta (compare do GitHub), sem os carriers de release; issues fechadas por elas (\"Closes #N\") ou citadas no nome da branch."],
  ["PRs mergeadas", "PRs mergeadas na main no período, sem os carriers de release (chore/release-carrier-*), que só publicam outras PRs."],
  ["Issues fechadas", "issues fechadas no período; tipo pelos rótulos type:bug/hotfix, type:improvement, type:feature; prioridade por priority:p0..p3 (critical=P0, high=P1, medium=P2, low=P3)."],
  ["Lead time", "issue criada → PR mergeada → em produção, para as issues entregues no período. Mediana e p90 (posto mais próximo)."],
  ["Backlog", "issues abertas e P0/P1 abertas agora; ao fim de cada período, pela data de criação e do último fechamento de cada issue."],
  ["PRs esperando o gate", "PRs abertas na main, fora de rascunho, sem o status nuria/local-merge-gate verde no último commit."],
  ["Falhas", "tentativas de release que terminaram sem avançar a tag (cada tentativa conta); recusadas: commits que o dono recusou publicar."],
  ["Produção travada", "do primeiro release falho após um sucesso até o próximo sucesso."],
  ["Esforço dos bots", "turnos do ledger de uso local; horas ativas = soma da duração dos turnos; \"Precisa de você\": itens abertos e resolvidos; tempo de resposta do dono = do item aberto à primeira resposta (ou resolução) do dono."],
];

// ── Markdown ────────────────────────────────────────────────────────────────

const md = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
const nums = (items: ReadonlyArray<{ number: number }>, max = 30) => items.length
  ? `${items.slice(0, max).map((item) => `#${item.number}`).join(", ")}${items.length > max ? ` +${items.length - max}` : ""}`
  : "—";

function kpiRows(k: ReportKpis, p: ReportKpis): Array<[string, string, string, string]> {
  const row = (name: string, current: number, previous: number): [string, string, string, string] => [name, formatNumber(current), formatNumber(previous), trendText(current, previous)];
  const leadRow = (name: string, current: Distribution, previous: Distribution): [string, string, string, string] =>
    [name, current.n ? `${formatDuration(current.median)} / ${formatDuration(current.p90)}` : "—", previous.n ? `${formatDuration(previous.median)} / ${formatDuration(previous.p90)}` : "—", trendText(current.median, previous.median, "pt-BR", "duration")];
  return [
    row("Entregas em produção", k.deliveries, p.deliveries),
    row("PRs entregues em produção", k.deliveredPrs, p.deliveredPrs),
    row("Issues entregues em produção", k.deliveredIssues, p.deliveredIssues),
    row("PRs mergeadas (sem carriers)", k.mergedPrs, p.mergedPrs),
    row("Issues fechadas", k.closedIssues, p.closedIssues),
    row("· bugs", k.closedByType.bug, p.closedByType.bug),
    row("· melhorias", k.closedByType.improvement, p.closedByType.improvement),
    row("· P0/P1", k.closedByPriority.p0 + k.closedByPriority.p1, p.closedByPriority.p0 + p.closedByPriority.p1),
    row("· P2", k.closedByPriority.p2, p.closedByPriority.p2),
    leadRow("Lead time issue → produção (mediana / p90)", k.leadIssueToProd, p.leadIssueToProd),
    leadRow("Lead time issue → merge (mediana / p90)", k.leadIssueToMerge, p.leadIssueToMerge),
    leadRow("Lead time merge → produção (mediana / p90)", k.leadMergeToProd, p.leadMergeToProd),
    row("Releases falhados (tentativas)", k.failedReleases, p.failedReleases),
    row("Releases recusados", k.declinedReleases, p.declinedReleases),
    [ "Produção travada", formatDuration(k.blockedMs), formatDuration(p.blockedMs), trendText(k.blockedMs, p.blockedMs, "pt-BR", "duration")],
    row("Issues abertas ao fim", k.openIssuesAtEnd, p.openIssuesAtEnd),
    row("Turnos dos bots", k.turns, p.turns),
    [ "Horas ativas dos bots", formatDuration(k.activeMs), formatDuration(p.activeMs), trendText(k.activeMs, p.activeMs, "pt-BR", "duration")],
    [ "Custo dos bots (US$)", formatMoney(k.costUsd), formatMoney(p.costUsd), k.costUsd !== null && p.costUsd !== null ? trendText(Math.round(k.costUsd), Math.round(p.costUsd)) : "—"],
    row("\"Precisa de você\" abertos", k.needsYouOpened, p.needsYouOpened),
    row("\"Precisa de você\" resolvidos", k.needsYouResolved, p.needsYouResolved),
    leadRow("Resposta do dono (mediana / p90)", k.ownerResponse, p.ownerResponse),
  ];
}

const outcomeText = (outcome: string) => ({ released: "em produção", failed: "falhou", declined: "recusado" } as Record<string, string>)[outcome] ?? outcome;

function coverageLines(report: ProductivityReport): string[] {
  const c = report.coverage;
  const lines: string[] = [];
  if (c.releaseLog.from !== null) lines.push(`Log do watcher de produção desde ${formatInstant(c.releaseLog.from)}.`);
  if (c.githubDeployments.from !== null) lines.push(`Deployments de produção do GitHub de ${formatInstant(c.githubDeployments.from)} a ${formatInstant(c.githubDeployments.to!)}.`);
  for (const gap of c.releaseGaps) lines.push(`Sem fonte de releases de ${formatInstant(gap.from)} a ${formatInstant(gap.to)}: entregas e falhas desse trecho não são conhecidas (não são zero).`);
  lines.push(c.github.syncedAt ? `GitHub sincronizado em ${formatInstant(c.github.syncedAt)} (${formatNumber(c.github.prs)} PRs, ${formatNumber(c.github.issues)} issues${c.github.complete ? "" : ", sincronização inicial incompleta"}).` : "GitHub ainda não sincronizado.");
  if (c.tag.sha) lines.push(`Tag de produção no GitHub: ${c.tag.sha.slice(0, 9)}${c.tag.matchesHistory === true ? " (confere com o histórico)" : c.tag.matchesHistory === false ? " (NÃO confere com o último release do histórico)" : ""}.`);
  if (c.usage.from !== null) lines.push(`Ledger de uso dos bots desde ${formatInstant(c.usage.from)}; turnos anteriores não contam.`);
  if (c.digests.from !== null) lines.push(`Durações de turno desde ${formatInstant(c.digests.from)}.`);
  if (c.needsYou.from !== null) lines.push(`"Precisa de você" registrado desde ${formatInstant(c.needsYou.from)}.`);
  return lines;
}

export function reportMarkdown(report: ProductivityReport): string {
  const g = report.granularity;
  const lines: string[] = [];
  lines.push("# Relatório de produtividade — Time Nuria", "");
  lines.push(`**Período:** ${periodText(report.period)} (${REPORT_TZ}) · por ${granularityName(g, "pt-BR")} · comparado a ${periodText(report.previous)}  `);
  lines.push(`**Produto:** ${report.repo} · **gerado em** ${formatInstant(report.generatedAt)}`, "");
  lines.push("## Resumo executivo", "");
  executiveSummary(report).forEach((line, index) => lines.push(`${index + 1}. ${line}`));
  lines.push("", "## Indicadores", "", "| Métrica | Período | Anterior | Variação |", "|---|---:|---:|---|");
  for (const [name, current, previous, change] of kpiRows(report.kpis, report.previousKpis)) lines.push(`| ${md(name)} | ${current} | ${previous} | ${change} |`);
  lines.push("", `## Por ${granularityName(g, "pt-BR")}`, "", "| Período | Entregas | PRs entregues | PRs mergeadas | Issues fechadas | Bugs fechados | Falhas | Turnos dos bots |", "|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const bucket of report.buckets) {
    const known = bucket.releaseCoverage !== "none";
    lines.push(`| ${bucketLabel(bucket.start, g)} | ${known ? bucket.deliveries : "s/ fonte"} | ${known ? bucket.deliveredPrs : "s/ fonte"} | ${bucket.mergedPrs} | ${bucket.closedIssues} | ${bucket.closedBugs} | ${known ? bucket.failedReleases : "s/ fonte"} | ${bucket.turns} |`);
  }
  lines.push("", "## Releases do período", "");
  if (!report.releases.length) lines.push("Nenhum release, falha ou recusa no período.");
  else {
    lines.push("| Quando | Commit | Resultado | PRs | Issues |", "|---|---|---|---|---|");
    for (const release of report.releases) {
      const what = release.outcome === "failed" && (release.attempts ?? 1) > 1 ? `${outcomeText(release.outcome)} (${release.attempts} tentativas)` : outcomeText(release.outcome);
      const prs = release.outcome === "released" ? (release.contentUnknown ? "conteúdo não conhecido" : nums(release.prs.filter((pr) => !pr.carrier))) : release.carrierPr ? `carrier #${release.carrierPr}` : "—";
      lines.push(`| ${formatInstant(release.at)} | \`${release.sha.slice(0, 9)}\` | ${what} | ${prs} | ${release.outcome === "released" ? nums(release.issues) : "—"} |`);
    }
  }
  const b = report.backlog;
  lines.push("", "## Backlog (agora)", "");
  lines.push(`- Issues abertas: ${formatNumber(b.openIssues)} · P0: ${formatNumber(b.openP0)} · P1: ${formatNumber(b.openP1)}`);
  if (b.oldestOpen) lines.push(`- Mais antiga aberta: #${b.oldestOpen.number}, aberta em ${formatInstant(b.oldestOpen.createdAt, "pt-BR", false)} (${formatDuration(report.generatedAt - b.oldestOpen.createdAt)})`);
  if (b.oldestOpenP1) lines.push(`- P0/P1 mais antiga: #${b.oldestOpenP1.number}, aberta em ${formatInstant(b.oldestOpenP1.createdAt, "pt-BR", false)} (${formatDuration(report.generatedAt - b.oldestOpenP1.createdAt)})`);
  lines.push(`- PRs esperando o gate: ${formatNumber(b.prsAwaitingGate)}${b.prsAwaitingGateList.length ? ` (${nums(b.prsAwaitingGateList, 15)})` : ""} de ${formatNumber(b.openPrs)} abertas`);
  lines.push("", "## Esforço dos bots", "");
  if (!report.bots.length) lines.push("Sem atividade registrada dos bots no período.");
  else {
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
const SUBSTITUTE: Record<string, string> = { "→": "->", "←": "<-", "↑": "+", "↓": "-", "−": "-", "≥": ">=", "≤": "<=", "✓": "v" };

/** A string as WinAnsi codes: Latin-1 as is, the few cp1252 extras mapped, the rest spelled out. */
function winAnsi(text: string): number[] {
  const codes: number[] = [];
  for (const char of text) {
    const sub = SUBSTITUTE[char];
    if (sub) { for (const c of sub) codes.push(c.charCodeAt(0)); continue; }
    const code = char.codePointAt(0)!;
    if (code >= 32 && code <= 126) codes.push(code);
    else if (WIN_ANSI_EXTRA[char] !== undefined) codes.push(WIN_ANSI_EXTRA[char]!);
    else if (code >= 0xa0 && code <= 0xff) codes.push(code);
    else codes.push(63); // "?"
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
    const words = text.split(/\s+/);
    let line = "";
    let lines = 0;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, options.bold) > width && line) {
        this.text(x, y + lines * leading, line, options);
        lines += 1;
        line = word;
      } else line = next;
    }
    if (line) { this.text(x, y + lines * leading, line, options); lines += 1; }
    return lines * leading;
  }

  measureLines(text: string, width: number, size: number, bold = false): number {
    let line = "";
    let lines = 0;
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) > width && line) { lines += 1; line = word; } else line = next;
    }
    return lines + (line ? 1 : 0);
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
    const info = add(`<< /Title ${pdfString(meta.title)} /Producer (OpenMausBot) /CreationDate (${stamp}) >>`);
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

function barChart(doc: PdfDoc, input: { title: string; buckets: ReportBucket[]; granularity: Granularity; series: Array<{ label: string; color: Rgb; value: (bucket: ReportBucket) => number; releaseMetric: boolean }> }): void {
  const x0 = doc.margin;
  const width = doc.width - doc.margin * 2;
  const chartHeight = 120;
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
  const values = input.buckets.flatMap((bucket) => input.series.map((series) => series.value(bucket)));
  const max = Math.max(1, ...values);
  const step = max <= 5 ? 1 : Math.ceil(max / 4 / Math.pow(10, Math.floor(Math.log10(max / 4)))) * Math.pow(10, Math.floor(Math.log10(max / 4)));
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
  input.buckets.forEach((bucket, index) => {
    const slotLeft = plotLeft + index * slot;
    const groupWidth = barWidth * input.series.length;
    let left = slotLeft + (slot - groupWidth) / 2;
    for (const series of input.series) {
      if (series.releaseMetric && bucket.releaseCoverage === "none") {
        doc.rect(left, top, barWidth, chartHeight, NOSOURCE);
      } else {
        const value = series.value(bucket);
        const h = (value / ceiling) * chartHeight;
        if (h > 0) doc.rect(left, top + chartHeight - h, barWidth, h, series.color);
      }
      left += barWidth;
    }
    if (index % labelEvery === 0) doc.text(slotLeft + slot / 2, top + chartHeight + 10, bucketLabel(bucket.start, input.granularity), { size: 6.5, color: MUTED, align: "center" });
  });
  doc.line(plotLeft, top + chartHeight, plotLeft + plotWidth, top + chartHeight, MUTED, 0.6);
  doc.y = top + chartHeight + 22;
  if (input.series.some((series) => series.releaseMetric) && input.buckets.some((bucket) => bucket.releaseCoverage === "none")) {
    doc.rect(x0, doc.y - 6.5, 8, 8, NOSOURCE);
    doc.text(x0 + 11, doc.y, "faixa cinza: sem fonte de releases (desconhecido, não zero)", { size: 7.5, color: MUTED });
    doc.y += 12;
  }
}

function table(doc: PdfDoc, input: { columns: Array<{ label: string; width: number; align?: "left" | "right" }>; rows: string[][]; size?: number }): void {
  const size = input.size ?? 8;
  const x0 = doc.margin;
  const rowHeight = size * 1.9;
  const header = () => {
    let x = x0;
    doc.rect(x0, doc.y, doc.width - doc.margin * 2, rowHeight, CARD);
    for (const column of input.columns) {
      doc.text(column.align === "right" ? x + column.width - 4 : x + 4, doc.y + rowHeight * 0.66, column.label, { size, bold: true, align: column.align === "right" ? "right" : "left", maxWidth: column.width - 8 });
      x += column.width;
    }
    doc.y += rowHeight;
  };
  doc.ensure(rowHeight * 2);
  header();
  for (const row of input.rows) {
    if (doc.y + rowHeight > doc.height - doc.margin - 18) { doc.addPage(); header(); }
    let x = x0;
    row.forEach((cell, index) => {
      const column = input.columns[index]!;
      doc.text(column.align === "right" ? x + column.width - 4 : x + 4, doc.y + rowHeight * 0.66, cell, { size, align: column.align === "right" ? "right" : "left", maxWidth: column.width - 8 });
      x += column.width;
    });
    doc.line(x0, doc.y + rowHeight, doc.width - doc.margin, doc.y + rowHeight, HAIRLINE, 0.4);
    doc.y += rowHeight;
  }
  doc.y += 10;
}

function heading(doc: PdfDoc, text: string): void {
  doc.ensure(40);
  doc.y += 6;
  doc.text(doc.margin, doc.y + 12, text, { size: 12.5, bold: true });
  doc.y += 22;
}

export function reportPdf(report: ProductivityReport): Buffer {
  const doc = new PdfDoc();
  const k = report.kpis;
  const p = report.previousKpis;
  const g = report.granularity;
  const contentWidth = doc.width - doc.margin * 2;
  // title
  doc.text(doc.margin, doc.y + 16, "Relatório de produtividade — Time Nuria", { size: 18, bold: true });
  doc.y += 30;
  doc.text(doc.margin, doc.y, `${periodText(report.period)} (${REPORT_TZ}) · por ${granularityName(g, "pt-BR")}`, { size: 9.5, color: MUTED });
  doc.y += 13;
  doc.text(doc.margin, doc.y, `Comparado a ${periodText(report.previous)} · ${report.repo} · gerado em ${formatInstant(report.generatedAt)}`, { size: 9.5, color: MUTED });
  doc.y += 16;
  // executive summary
  const summary = executiveSummary(report);
  const summaryHeight = summary.reduce((sum, line) => sum + doc.measureLines(line, contentWidth - 40, 9.5) * 13, 0) + 34;
  doc.rect(doc.margin, doc.y, contentWidth, summaryHeight, CARD);
  doc.rect(doc.margin, doc.y, 3, summaryHeight, ACCENT);
  doc.text(doc.margin + 14, doc.y + 17, "Resumo executivo", { size: 11, bold: true });
  let y = doc.y + 32;
  summary.forEach((line, index) => {
    doc.text(doc.margin + 14, y, `${index + 1}.`, { size: 9.5, bold: true, color: ACCENT });
    y += doc.paragraph(doc.margin + 28, y, line, contentWidth - 40, { size: 9.5, leading: 13 });
  });
  doc.y += summaryHeight + 14;
  // KPI cards: 4 per row
  const cards: Array<{ label: string; value: string; change: string; good: boolean | null }> = [
    { label: "Entregas em produção", value: formatNumber(k.deliveries), change: trendText(k.deliveries, p.deliveries), good: k.deliveries === p.deliveries ? null : k.deliveries > p.deliveries },
    { label: "PRs entregues", value: formatNumber(k.deliveredPrs), change: trendText(k.deliveredPrs, p.deliveredPrs), good: k.deliveredPrs === p.deliveredPrs ? null : k.deliveredPrs > p.deliveredPrs },
    { label: "PRs mergeadas", value: formatNumber(k.mergedPrs), change: trendText(k.mergedPrs, p.mergedPrs), good: k.mergedPrs === p.mergedPrs ? null : k.mergedPrs > p.mergedPrs },
    { label: "Issues fechadas", value: formatNumber(k.closedIssues), change: trendText(k.closedIssues, p.closedIssues), good: k.closedIssues === p.closedIssues ? null : k.closedIssues > p.closedIssues },
    { label: "Lead time issue → prod. (mediana)", value: formatDuration(k.leadIssueToProd.median), change: trendText(k.leadIssueToProd.median, p.leadIssueToProd.median, "pt-BR", "duration"), good: k.leadIssueToProd.median === null || p.leadIssueToProd.median === null || k.leadIssueToProd.median === p.leadIssueToProd.median ? null : k.leadIssueToProd.median < p.leadIssueToProd.median },
    { label: "Issues abertas / P0-P1", value: `${formatNumber(report.backlog.openIssues)} / ${formatNumber(report.backlog.openP0 + report.backlog.openP1)}`, change: `${formatNumber(report.backlog.prsAwaitingGate)} PRs esperando o gate`, good: null },
    { label: "Releases falhados", value: formatNumber(k.failedReleases), change: trendText(k.failedReleases, p.failedReleases), good: k.failedReleases === p.failedReleases ? null : k.failedReleases < p.failedReleases },
    { label: "Produção travada", value: formatDuration(k.blockedMs) === "—" ? "0 h" : formatDuration(k.blockedMs), change: trendText(k.blockedMs, p.blockedMs, "pt-BR", "duration"), good: k.blockedMs === p.blockedMs ? null : k.blockedMs < p.blockedMs },
  ];
  const gap = 8;
  const cardWidth = (contentWidth - gap * 3) / 4;
  const cardHeight = 58;
  doc.ensure(cardHeight * 2 + gap + 10);
  cards.forEach((card, index) => {
    const x = doc.margin + (index % 4) * (cardWidth + gap);
    const top = doc.y + Math.floor(index / 4) * (cardHeight + gap);
    doc.rect(x, top, cardWidth, cardHeight, CARD);
    doc.text(x + 8, top + 14, card.label, { size: 7.5, color: MUTED, maxWidth: cardWidth - 16 });
    doc.text(x + 8, top + 35, card.value, { size: 16, bold: true, maxWidth: cardWidth - 16 });
    doc.text(x + 8, top + 50, card.change, { size: 7.5, color: card.good === null ? MUTED : card.good ? GOOD : BAD, maxWidth: cardWidth - 16 });
  });
  doc.y += cardHeight * 2 + gap + 16;
  // charts
  barChart(doc, {
    title: `Entregas e falhas por ${granularityName(g, "pt-BR")}`, buckets: report.buckets, granularity: g,
    series: [
      { label: "Entregas em produção", color: ACCENT, value: (bucket) => bucket.deliveries, releaseMetric: true },
      { label: "Releases falhados", color: BAD, value: (bucket) => bucket.failedReleases, releaseMetric: true },
    ],
  });
  barChart(doc, {
    title: `Vazão por ${granularityName(g, "pt-BR")}`, buckets: report.buckets, granularity: g,
    series: [
      { label: "PRs mergeadas", color: ACCENT, value: (bucket) => bucket.mergedPrs, releaseMetric: false },
      { label: "Issues fechadas", color: ACCENT_SOFT, value: (bucket) => bucket.closedIssues, releaseMetric: false },
    ],
  });
  // indicators
  heading(doc, "Indicadores");
  table(doc, {
    columns: [{ label: "Métrica", width: contentWidth * 0.46 }, { label: "Período", width: contentWidth * 0.17, align: "right" }, { label: "Anterior", width: contentWidth * 0.17, align: "right" }, { label: "Variação", width: contentWidth * 0.2 }],
    rows: kpiRows(k, p),
  });
  // releases
  heading(doc, "Releases do período");
  if (!report.releases.length) { doc.text(doc.margin, doc.y + 8, "Nenhum release, falha ou recusa no período.", { size: 9, color: MUTED }); doc.y += 20; }
  else {
    table(doc, {
      columns: [{ label: "Quando", width: contentWidth * 0.17 }, { label: "Commit", width: contentWidth * 0.11 }, { label: "Resultado", width: contentWidth * 0.17 }, { label: "PRs", width: contentWidth * 0.3 }, { label: "Issues", width: contentWidth * 0.25 }],
      rows: report.releases.map((release) => [
        formatInstant(release.at),
        release.sha.slice(0, 9),
        release.outcome === "failed" && (release.attempts ?? 1) > 1 ? `falhou (${release.attempts}x)` : outcomeText(release.outcome),
        release.outcome === "released" ? (release.contentUnknown ? "não conhecido" : nums(release.prs.filter((pr) => !pr.carrier), 12)) : release.carrierPr ? `carrier #${release.carrierPr}` : "—",
        release.outcome === "released" ? nums(release.issues, 10) : "—",
      ]),
      size: 7.5,
    });
  }
  // bots
  heading(doc, "Esforço dos bots");
  if (!report.bots.length) { doc.text(doc.margin, doc.y + 8, "Sem atividade registrada dos bots no período.", { size: 9, color: MUTED }); doc.y += 20; }
  else {
    table(doc, {
      columns: [{ label: "Bot", width: contentWidth * 0.3 }, { label: "Turnos", width: contentWidth * 0.12, align: "right" }, { label: "Horas ativas", width: contentWidth * 0.15, align: "right" }, { label: "Custo", width: contentWidth * 0.15, align: "right" }, { label: "Precisa de você (abertos / resolvidos)", width: contentWidth * 0.28, align: "right" }],
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
  return doc.render({ title: "Relatório de produtividade — Time Nuria", createdAt: report.generatedAt, footer: `Time Nuria · ${report.repo} · ${periodText(report.period)} · OpenMausBot` });
}

/** File name for a download: produtividade-dia-2026-09-03_2026-10-02.pdf */
export function exportFileName(report: ProductivityReport, extension: "pdf" | "md"): string {
  const day = (ms: number) => formatInstant(ms, "en", false);
  return `produtividade-${granularityName(report.granularity, "pt-BR").replace("ê", "e")}-${day(report.period.from)}_${day(report.period.to - 1)}.${extension}`;
}
