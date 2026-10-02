// The productivity report's numbers (lot V): a pure function over what the
// collector gathered — GitHub (PRs, issues, gate, tag, deployments, release
// ranges), the release log's runs and refusals, and the bots' local data.
// Every boundary is São Paulo's (shared/productivity.ts). Nothing here reads
// a file or the network, so tests drive it with fixtures.
import {
  bucketKey, bucketStarts, distribution, ISSUE_PRIORITIES, ISSUE_TYPES, nextBucket, previousPeriod, PRODUCTION_REPO, REPORT_TZ,
  type Granularity, type IssuePriority, type IssueType, type ProductivityReport, type ReportBacklog, type ReportBotEffort,
  type ReportBucket, type ReportCoverage, type ReportKpis, type ReportPeriod, type ReportRelease, type ReportReleaseItem, type ReportSyncState,
} from "../shared/productivity.ts";
import { branchIssueNumbers, isCarrier, issuePriority, issueType, type GhCache, type GhIssue, type GhPr } from "./productivity-github.ts";
import type { DeclineEvent, ReleaseRun } from "./productivity-release-log.ts";
import { ownerResponseMs, type NeedsYouRecord } from "./productivity-local.ts";

const DAY_MS = 24 * 3_600_000;

export interface UsageLike {
  at: string;
  botId: string;
  botName: string;
  input: number;
  output: number;
  cachedInput?: number;
  costUsd: number | null;
}

export interface ReportInputs {
  granularity: Granularity;
  period: ReportPeriod;
  now: number;
  github: GhCache;
  runs: readonly ReleaseRun[];
  declines: readonly DeclineEvent[];
  logCoverage: { from: number | null; to: number | null };
  usage: readonly UsageLike[];
  digests: ReadonlyArray<{ botId: string; at: number; durationMs: number | null }>;
  needsYou: readonly NeedsYouRecord[];
  botNames: ReadonlyMap<string, string>;
  local: { usageFrom: number | null; digestsFrom: number | null; needsYouFrom: number | null };
  sync: ReportSyncState;
}

/** A successful release, from the log or from a GitHub deployment. */
export interface ReleaseEvent {
  sha: string;
  at: number;
  timeSource: ReportRelease["timeSource"];
  carrierPr?: number;
  baseSha?: string;
  prs: GhPr[];
  issues: GhIssue[];
  contentUnknown: boolean;
}

export interface Timeline {
  releases: ReleaseEvent[];
  /** PR number → when it first reached production. */
  prDelivered: Map<number, number>;
  /** Issue number → when it first reached production, and through which PR. */
  issueDelivered: Map<number, { at: number; pr: GhPr }>;
  /** Intervals production was blocked (first failure after a success → next success). */
  blocked: Array<{ from: number; to: number }>;
}

/** The issues a merged PR delivers: what GitHub says it closes, plus the
 * issue numbers its branch names, when those are issues of the repo. */
export function issuesOfPr(pr: GhPr, issues: Record<string, GhIssue>): GhIssue[] {
  const numbers = new Set([...pr.closes, ...branchIssueNumbers(pr.head)]);
  return [...numbers].map((number) => issues[String(number)]).filter((issue): issue is GhIssue => Boolean(issue));
}

/** The log's runs plus the production deployments GitHub recorded before
 * the local release existed, as runs of the same shape. */
export function allRuns(input: Pick<ReportInputs, "runs" | "github">): ReleaseRun[] {
  const fromGithub: ReleaseRun[] = input.github.deployments.flatMap((deployment): ReleaseRun[] => {
    const at = deployment.successAt ?? deployment.failedAt ?? null;
    if (at === null) return [];
    return [{
      key: `deployment:${deployment.id}`, sha: deployment.sha, pid: 0,
      outcome: deployment.successAt !== null ? "released" : "failed",
      startedAt: deployment.createdAt, endedAt: at, timeSource: "log", origin: "github-deployment",
      ...(deployment.successAt === null ? { cause: "GitHub deployment failed" } : {}),
    }];
  });
  return [...input.runs, ...fromGithub];
}

/** Two releases are compared only when one source covers the whole time
 * between them: across a gap, other deploys may have shipped part of it. */
function contiguous(spans: ReadonlyArray<{ from: number; to: number }>, from: number, to: number): boolean {
  return spans.some((span) => span.from <= from && span.to >= to);
}

/** Release ranges (base...head) the timeline needs, for the collector to read. */
export function releasePairs(input: Pick<ReportInputs, "runs" | "github" | "logCoverage" | "now">): Array<{ base: string; head: string }> {
  const events = successfulReleases(allRuns(input));
  const spans = releaseSourceSpans(input);
  const pairs: Array<{ base: string; head: string }> = [];
  for (let i = 1; i < events.length; i += 1) {
    const [base, head] = [events[i - 1]!, events[i]!];
    if (base.sha !== head.sha && contiguous(spans, base.at, head.at)) pairs.push({ base: base.sha, head: head.sha });
  }
  return pairs.reverse(); // newest first: the recent releases matter most
}

function successfulReleases(runs: readonly ReleaseRun[]): Array<{ sha: string; at: number; timeSource: ReleaseEvent["timeSource"]; carrierPr?: number }> {
  const bySha = new Map<string, { sha: string; at: number; timeSource: ReleaseEvent["timeSource"]; carrierPr?: number }>();
  for (const run of runs) {
    if (run.outcome !== "released" || run.endedAt === null) continue;
    const known = bySha.get(run.sha);
    const knownFromGithub = known?.timeSource === "github-deployment";
    // the log wins over GitHub for the same commit; within one source the earliest success counts
    const better = !known || (knownFromGithub && !run.origin) || (knownFromGithub === Boolean(run.origin) && run.endedAt < known.at);
    if (!better) continue;
    const timeSource: ReleaseEvent["timeSource"] = run.origin ? "github-deployment" : run.timeSource === "log" ? "log" : "log-clock";
    bySha.set(run.sha, { sha: run.sha, at: run.endedAt, timeSource, ...(run.carrierPr ? { carrierPr: run.carrierPr } : {}) });
  }
  return [...bySha.values()].sort((a, b) => a.at - b.at);
}

export function buildTimeline(input: Pick<ReportInputs, "runs" | "github" | "now" | "logCoverage">): Timeline {
  const { github } = input;
  const byMergeSha = new Map<string, GhPr>();
  for (const pr of Object.values(github.prs)) if (pr.mergeSha && pr.mergedAt !== null) byMergeSha.set(pr.mergeSha, pr);
  const releases: ReleaseEvent[] = [];
  const prDelivered = new Map<number, number>();
  const issueDelivered = new Map<number, { at: number; pr: GhPr }>();
  const runs = allRuns(input);
  const events = successfulReleases(runs);
  const spans = releaseSourceSpans(input);
  events.forEach((event, index) => {
    const previous = index > 0 ? events[index - 1]! : undefined;
    const base = previous && contiguous(spans, previous.at, event.at) ? previous.sha : undefined;
    const commits = base ? github.compares[`${base}...${event.sha}`] : undefined;
    const prs = (commits ?? []).map((sha) => byMergeSha.get(sha)).filter((pr): pr is GhPr => Boolean(pr)).sort((a, b) => a.number - b.number);
    const issueMap = new Map<number, GhIssue>();
    for (const pr of prs) {
      if (!prDelivered.has(pr.number)) prDelivered.set(pr.number, event.at);
      if (isCarrier(pr)) continue;
      for (const issue of issuesOfPr(pr, github.issues)) {
        issueMap.set(issue.number, issue);
        if (!issueDelivered.has(issue.number)) issueDelivered.set(issue.number, { at: event.at, pr });
      }
    }
    releases.push({ ...event, ...(base ? { baseSha: base } : {}), prs, issues: [...issueMap.values()].sort((a, b) => a.number - b.number), contentUnknown: !commits });
  });
  // production blocked: from the first failure after a success to the next success
  const attempts = runs
    .filter((run) => (run.outcome === "released" || run.outcome === "failed") && run.endedAt !== null)
    .map((run) => ({ at: run.endedAt!, ok: run.outcome === "released" }))
    .sort((a, b) => a.at - b.at);
  const blocked: Array<{ from: number; to: number }> = [];
  let since: number | null = null;
  for (const attempt of attempts) {
    if (!attempt.ok && since === null) since = attempt.at;
    if (attempt.ok && since !== null) { blocked.push({ from: since, to: attempt.at }); since = null; }
  }
  if (since !== null) blocked.push({ from: since, to: input.now });
  return { releases, prDelivered, issueDelivered, blocked };
}

const overlap = (a: { from: number; to: number }, from: number, to: number) => Math.max(0, Math.min(a.to, to) - Math.max(a.from, from));
const within = (at: number | null | undefined, from: number, to: number): at is number => typeof at === "number" && at >= from && at < to;
const zeroByType = (): Record<IssueType, number> => Object.fromEntries(ISSUE_TYPES.map((type) => [type, 0])) as Record<IssueType, number>;
const zeroByPriority = (): Record<IssuePriority, number> => Object.fromEntries(ISSUE_PRIORITIES.map((priority) => [priority, 0])) as Record<IssuePriority, number>;
const isMainMerge = (pr: GhPr) => pr.mergedAt !== null && pr.base === "main";
const isOpenAt = (issue: GhIssue, at: number) => issue.createdAt < at && (issue.closedAt === null || issue.closedAt >= at);
const notPlanned = (issue: GhIssue) => issue.stateReason === "NOT_PLANNED" || issue.stateReason === "DUPLICATE";

export function kpisFor(input: ReportInputs, timeline: Timeline, from: number, to: number): ReportKpis {
  const { github } = input;
  const issues = Object.values(github.issues);
  const prs = Object.values(github.prs);
  const releases = timeline.releases.filter((release) => within(release.at, from, to));
  const deliveredPrs = new Set<number>();
  for (const [number, at] of timeline.prDelivered) {
    const pr = github.prs[String(number)];
    if (pr && !isCarrier(pr) && within(at, from, to)) deliveredPrs.add(number);
  }
  const deliveredIssues = [...timeline.issueDelivered].filter(([, delivery]) => within(delivery.at, from, to));
  const merged = prs.filter((pr) => isMainMerge(pr) && within(pr.mergedAt, from, to));
  const closed = issues.filter((issue) => within(issue.closedAt, from, to));
  const closedByType = zeroByType();
  const closedByPriority = zeroByPriority();
  for (const issue of closed) {
    if (notPlanned(issue)) continue;
    closedByType[issueType(issue.labels)] += 1;
    closedByPriority[issuePriority(issue.labels)] += 1;
  }
  const leadIssueToProd: number[] = [];
  const leadIssueToMerge: number[] = [];
  for (const [number, delivery] of deliveredIssues) {
    const issue = github.issues[String(number)]!;
    leadIssueToProd.push(Math.max(0, delivery.at - issue.createdAt));
    if (delivery.pr.mergedAt !== null) leadIssueToMerge.push(Math.max(0, delivery.pr.mergedAt - issue.createdAt));
  }
  const leadMergeToProd = [...deliveredPrs].map((number) => {
    const pr = github.prs[String(number)]!;
    return Math.max(0, timeline.prDelivered.get(number)! - (pr.mergedAt ?? 0));
  });
  const failed = allRuns(input).filter((run) => run.outcome === "failed" && within(run.endedAt, from, to)).length;
  const declined = new Set(input.declines.filter((decline) => within(decline.at, from, to)).map((decline) => decline.sha)).size;
  const blockedMs = timeline.blocked.reduce((sum, interval) => sum + overlap(interval, from, Math.min(to, input.now)), 0);
  const end = Math.min(to, input.now);
  const openAtEnd = issues.filter((issue) => isOpenAt(issue, end));
  // bots
  const usage = input.usage.filter((row) => within(Date.parse(row.at), from, to));
  const priced = usage.filter((row) => row.costUsd !== null);
  const digests = input.digests.filter((digest) => within(digest.at, from, to));
  const opened = input.needsYou.filter((item) => within(item.createdAt, from, to));
  const responses = opened.map(ownerResponseMs).filter((value): value is number => value !== null);
  return {
    deliveries: releases.length,
    deliveredPrs: deliveredPrs.size,
    deliveredIssues: deliveredIssues.length,
    mergedPrs: merged.filter((pr) => !isCarrier(pr)).length,
    carrierPrs: merged.filter(isCarrier).length,
    closedIssues: closed.length,
    closedNotPlanned: closed.filter(notPlanned).length,
    closedByType,
    closedByPriority,
    leadIssueToProd: distribution(leadIssueToProd),
    leadIssueToMerge: distribution(leadIssueToMerge),
    leadMergeToProd: distribution(leadMergeToProd),
    failedReleases: failed,
    declinedReleases: declined,
    blockedMs,
    openIssuesAtEnd: openAtEnd.length,
    openP1AtEnd: openAtEnd.filter((issue) => ["p0", "p1"].includes(issuePriority(issue.labels))).length,
    turns: usage.length,
    activeMs: digests.reduce((sum, digest) => sum + (digest.durationMs ?? 0), 0),
    timedTurns: digests.filter((digest) => digest.durationMs !== null).length,
    inputTokens: usage.reduce((sum, row) => sum + row.input, 0),
    outputTokens: usage.reduce((sum, row) => sum + row.output, 0),
    cachedTokens: usage.reduce((sum, row) => sum + (row.cachedInput ?? 0), 0),
    costUsd: priced.length ? Math.round(priced.reduce((sum, row) => sum + row.costUsd!, 0) * 100) / 100 : null,
    needsYouOpened: opened.length,
    needsYouResolved: input.needsYou.filter((item) => within(item.resolvedAt, from, to)).length,
    ownerResponse: distribution(responses),
  };
}

const deploymentTimes = (github: GhCache): number[] =>
  github.deployments.map((deployment) => deployment.successAt ?? deployment.failedAt ?? null).filter((at): at is number => at !== null);

/** Where a release source exists: the GitHub deployments' span and the log's
 * (live up to now). Everything else in the period is a gap. */
export function releaseSourceSpans(input: Pick<ReportInputs, "github" | "logCoverage" | "now">): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = [];
  const deployed = deploymentTimes(input.github);
  if (deployed.length) spans.push({ from: Math.min(...deployed), to: Math.max(...deployed) });
  if (input.logCoverage.from !== null) spans.push({ from: input.logCoverage.from, to: input.now });
  return spans.sort((a, b) => a.from - b.from);
}

function gapsIn(spans: Array<{ from: number; to: number }>, from: number, to: number, minimum: number): Array<{ from: number; to: number }> {
  const gaps: Array<{ from: number; to: number }> = [];
  let cursor = from;
  for (const span of spans) {
    if (span.to <= cursor) continue;
    if (span.from > cursor && Math.min(span.from, to) - cursor >= minimum) gaps.push({ from: cursor, to: Math.min(span.from, to) });
    cursor = Math.max(cursor, span.to);
    if (cursor >= to) break;
  }
  if (cursor < to && to - cursor >= minimum) gaps.push({ from: cursor, to });
  return gaps;
}

function coverageOf(spans: Array<{ from: number; to: number }>, from: number, to: number): ReportBucket["releaseCoverage"] {
  const length = to - from;
  if (length <= 0) return "none";
  const covered = spans.reduce((sum, span) => sum + overlap(span, from, to), 0);
  if (covered >= length * 0.999) return "full";
  return covered > 0 ? "partial" : "none";
}

function releaseRows(input: ReportInputs, timeline: Timeline, from: number, to: number): ReportRelease[] {
  const item = (issue: GhIssue): ReportReleaseItem => ({ number: issue.number, title: issue.title, kind: "issue", type: issueType(issue.labels), priority: issuePriority(issue.labels) });
  const rows: ReportRelease[] = timeline.releases.filter((release) => within(release.at, from, to)).map((release) => ({
    sha: release.sha,
    at: release.at,
    timeSource: release.timeSource,
    outcome: "released" as const,
    ...(release.baseSha ? { baseSha: release.baseSha } : {}),
    ...(release.carrierPr ? { carrierPr: release.carrierPr } : {}),
    prs: release.prs.map((pr) => ({ number: pr.number, title: pr.title, kind: "pr" as const, ...(isCarrier(pr) ? { carrier: true } : {}) })),
    issues: release.issues.map(item),
    ...(release.contentUnknown ? { contentUnknown: true } : {}),
  }));
  // failures of the same commit in a row are one row
  const failures = allRuns(input).filter((run) => run.outcome === "failed" && run.endedAt !== null).sort((a, b) => a.endedAt! - b.endedAt!);
  let group: { sha: string; first: number; last: number; attempts: number; cause?: string; carrierPr?: number; timeSource: ReportRelease["timeSource"] } | null = null;
  const flush = () => {
    if (group && within(group.last, from, to)) {
      rows.push({ sha: group.sha, at: group.last, firstAt: group.first, attempts: group.attempts, timeSource: group.timeSource, outcome: "failed", ...(group.cause ? { cause: group.cause } : {}), ...(group.carrierPr ? { carrierPr: group.carrierPr } : {}), prs: [], issues: [] });
    }
    group = null;
  };
  const sourceOf = (run: ReleaseRun): ReportRelease["timeSource"] => run.origin ? "github-deployment" : run.timeSource === "log" ? "log" : "log-clock";
  for (const run of failures) {
    if (group && group.sha === run.sha) {
      group.last = run.endedAt!;
      group.attempts += 1;
      if (run.cause) group.cause = run.cause;
      if (sourceOf(run) === "log-clock") group.timeSource = "log-clock";
      continue;
    }
    flush();
    group = { sha: run.sha, first: run.endedAt!, last: run.endedAt!, attempts: 1, ...(run.cause ? { cause: run.cause } : {}), ...(run.carrierPr ? { carrierPr: run.carrierPr } : {}), timeSource: sourceOf(run) };
  }
  flush();
  const seen = new Set<string>();
  for (const decline of input.declines) {
    if (decline.at === null || !within(decline.at, from, to) || seen.has(decline.sha)) continue;
    seen.add(decline.sha);
    const full = input.runs.find((run) => run.sha.startsWith(decline.sha))?.sha ?? decline.sha;
    rows.push({ sha: full, at: decline.at, timeSource: "log-clock", outcome: "declined", prs: [], issues: [] });
  }
  // newest first; at the same instant a refusal follows the failure it answers
  const rank = { released: 0, failed: 1, declined: 2 } as const;
  return rows.sort((a, b) => b.at - a.at || rank[b.outcome] - rank[a.outcome]);
}

function backlogOf(input: ReportInputs): ReportBacklog {
  const open = Object.values(input.github.issues).filter((issue) => issue.state === "OPEN");
  const oldest = open.slice().sort((a, b) => a.createdAt - b.createdAt)[0];
  const p1 = open.filter((issue) => issuePriority(issue.labels) === "p1");
  const p0 = open.filter((issue) => issuePriority(issue.labels) === "p0");
  const oldestP1 = [...p0, ...p1].sort((a, b) => a.createdAt - b.createdAt)[0];
  const waiting = input.github.openPrs.filter((pr) => !pr.draft && pr.base === "main" && pr.gate !== "success").sort((a, b) => a.createdAt - b.createdAt);
  return {
    openIssues: open.length,
    openP1: p1.length,
    openP0: p0.length,
    oldestOpen: oldest ? { number: oldest.number, createdAt: oldest.createdAt, priority: issuePriority(oldest.labels) } : null,
    oldestOpenP1: oldestP1 ? { number: oldestP1.number, createdAt: oldestP1.createdAt } : null,
    prsAwaitingGate: waiting.length,
    prsAwaitingGateList: waiting.slice(0, 50).map((pr) => ({ number: pr.number, title: pr.title, gate: pr.gate === "success" ? "pending" : pr.gate, since: pr.gateAt ?? pr.createdAt })),
    openPrs: input.github.openPrs.length,
    at: input.github.syncedAt,
  };
}

function botsOf(input: ReportInputs, from: number, to: number): ReportBotEffort[] {
  const bots = new Map<string, ReportBotEffort>();
  const of = (botId: string, fallback?: string): ReportBotEffort => {
    let bot = bots.get(botId);
    if (!bot) {
      bot = { botId, name: input.botNames.get(botId) ?? fallback ?? botId.slice(0, 8), turns: 0, activeMs: 0, timedTurns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null, needsYouOpened: 0, needsYouResolved: 0, needsYouOpenNow: 0 };
      bots.set(botId, bot);
    }
    return bot;
  };
  for (const row of input.usage) {
    if (!within(Date.parse(row.at), from, to)) continue;
    const bot = of(row.botId, row.botName);
    bot.turns += 1;
    bot.inputTokens += row.input;
    bot.outputTokens += row.output;
    bot.cachedTokens += row.cachedInput ?? 0;
    if (row.costUsd !== null) bot.costUsd = Math.round(((bot.costUsd ?? 0) + row.costUsd) * 10_000) / 10_000;
  }
  for (const digest of input.digests) {
    if (!within(digest.at, from, to)) continue;
    const bot = of(digest.botId);
    if (digest.durationMs !== null) { bot.activeMs += digest.durationMs; bot.timedTurns += 1; }
  }
  for (const item of input.needsYou) {
    if (within(item.createdAt, from, to)) of(item.botId).needsYouOpened += 1;
    if (within(item.resolvedAt, from, to)) of(item.botId).needsYouResolved += 1;
    if (item.resolvedAt === null) of(item.botId).needsYouOpenNow += 1;
  }
  return [...bots.values()].sort((a, b) => b.turns - a.turns || b.activeMs - a.activeMs || a.name.localeCompare(b.name));
}

export function buildProductivityReport(input: ReportInputs): ProductivityReport {
  const { granularity, period, now } = input;
  const timeline = buildTimeline(input);
  const previous = previousPeriod(period, granularity);
  const spans = releaseSourceSpans(input);
  const starts = bucketStarts(period.from, period.to, granularity);
  const buckets: ReportBucket[] = starts.map((start) => {
    const end = nextBucket(start, granularity);
    const kpis = kpisFor(input, timeline, start, end);
    return {
      key: bucketKey(start, granularity),
      start,
      end,
      deliveries: kpis.deliveries,
      deliveredPrs: kpis.deliveredPrs,
      mergedPrs: kpis.mergedPrs,
      closedIssues: kpis.closedIssues,
      closedBugs: kpis.closedByType.bug,
      failedReleases: kpis.failedReleases,
      blockedMs: kpis.blockedMs,
      openIssuesAtEnd: kpis.openIssuesAtEnd,
      turns: kpis.turns,
      activeMs: kpis.activeMs,
      costUsd: kpis.costUsd,
      needsYouOpened: kpis.needsYouOpened,
      needsYouResolved: kpis.needsYouResolved,
      releaseCoverage: start >= now ? "none" : coverageOf(spans, start, Math.min(end, now)),
    };
  });
  const logged = input.runs.filter((run) => run.outcome === "released");
  const latest = timeline.releases.at(-1);
  const deployed = deploymentTimes(input.github);
  const coverage: ReportCoverage = {
    releaseLog: { from: input.logCoverage.from, to: input.logCoverage.to },
    githubDeployments: { from: deployed.length ? Math.min(...deployed) : null, to: deployed.length ? Math.max(...deployed) : null },
    releaseGaps: gapsIn(spans, period.from, Math.min(period.to, now), DAY_MS),
    releaseCoverage: { period: coverageOf(spans, period.from, Math.min(period.to, now)), previous: coverageOf(spans, previous.from, Math.min(previous.to, now)) },
    github: { syncedAt: input.github.syncedAt, complete: input.github.prWalk.complete && input.github.issueWalk.complete, issues: Object.keys(input.github.issues).length, prs: Object.keys(input.github.prs).length },
    usage: { from: input.local.usageFrom },
    digests: { from: input.local.digestsFrom },
    needsYou: { from: input.local.needsYouFrom },
    tag: {
      sha: input.github.tag.sha,
      matchesHistory: input.github.tag.sha && latest ? input.github.tag.sha === latest.sha : input.github.tag.sha && logged.length === 0 ? null : input.github.tag.sha ? false : null,
      checkedAt: input.github.tag.checkedAt,
    },
  };
  return {
    version: 1,
    generatedAt: now,
    timezone: REPORT_TZ,
    repo: PRODUCTION_REPO,
    granularity,
    period,
    previous,
    kpis: kpisFor(input, timeline, period.from, period.to),
    previousKpis: kpisFor(input, timeline, previous.from, previous.to),
    buckets,
    releases: releaseRows(input, timeline, period.from, period.to),
    backlog: backlogOf(input),
    bots: botsOf(input, period.from, period.to),
    coverage,
    sync: input.sync,
  };
}
