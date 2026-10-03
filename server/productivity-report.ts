// The productivity report's numbers (lot V): a pure function over what the
// collector gathered — GitHub (PRs, issues, gate, tag, deployments, release
// ranges), the release log's runs and refusals, and the bots' local data.
// Every boundary is São Paulo's (shared/productivity.ts). Nothing here reads
// a file or the network, so tests drive it with fixtures.
//
// Rules the board relies on (INSP-V r1):
//  - a failure is a run that RAN and did not release; superseded and aborted
//    runs are counted apart and stay out of the success rate;
//  - an issue is delivered only when a PR names it explicitly (GitHub's link,
//    or Closes/Fixes/Resolves/Refs #N in the body or the merge commit) AND it
//    is closed — never by a number in a branch name, never while open;
//  - what is unknown is never summed as zero: releases without contents make
//    the delivered totals lower bounds; buckets before the usage ledger are null.
//
// Performance: everything the buckets need is indexed once (times sorted,
// prefix sums), so a bucket costs two binary searches, not a scan of every
// PR and issue (a year by day over the real cache: a few ms).
import {
  botRole, bucketKey, bucketStart, bucketStarts, distribution, isNationalHoliday, ISSUE_PRIORITIES, ISSUE_TYPES, MIN_TREND_BASE, nextBucket, previousPeriod, PRODUCTION_REPO, REPORT_TZ, zonedParts,
  type Granularity, type IssuePriority, type IssueType, type ProductivityReport, type ReportBacklog, type ReportBotEffort,
  type ReportBucket, type ReportCoverage, type ReportGoals, type ReportKpis, type ReportPeriod, type ReportRelease, type ReportReleaseItem, type ReportSyncState,
} from "../shared/productivity.ts";
import { isCarrier, issuePriority, issueType, type GhCache, type GhIssue, type GhPr } from "./productivity-github.ts";
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
  goals?: ReportGoals;
}

/** A successful release, from the log or from a GitHub deployment. */
export interface ReleaseEvent {
  sha: string;
  at: number;
  timeSource: ReportRelease["timeSource"];
  headPr?: number;
  tagNotAdvanced?: boolean;
  postRelease?: string;
  baseSha?: string;
  prs: GhPr[];
  issues: GhIssue[];
  contentUnknown: boolean;
  contentUnknownReason?: "first" | "gap" | "pending";
}

export interface Timeline {
  releases: ReleaseEvent[];
  /** PR number → when it first reached production. */
  prDelivered: Map<number, number>;
  /** Issue number → when it first reached production, and through which PR. */
  issueDelivered: Map<number, { at: number; pr: GhPr }>;
  /** Release pipeline stopped (first failure that ran after a success → next success). */
  blocked: Array<{ from: number; to: number }>;
}

const notPlanned = (issue: GhIssue) => issue.stateReason === "NOT_PLANNED" || issue.stateReason === "DUPLICATE";

/** The issues a merged PR delivers: those it names explicitly (GitHub's
 * closing link, or Closes/Fixes/Resolves/Refs #N in its body or merge
 * commit) that are closed as done. An open issue is never "delivered". */
export function issuesOfPr(pr: GhPr, issues: Record<string, GhIssue>): GhIssue[] {
  const numbers = new Set([...pr.closes, ...(pr.refs ?? [])]);
  return [...numbers]
    .map((number) => issues[String(number)])
    .filter((issue): issue is GhIssue => Boolean(issue) && issue!.state === "CLOSED" && !notPlanned(issue!));
}

/** The log's runs plus the production deployments GitHub recorded before
 * the local release existed, as runs of the same shape. */
export function allRuns(input: Pick<ReportInputs, "runs" | "github">): ReleaseRun[] {
  const fromGithub: ReleaseRun[] = input.github.deployments.flatMap((deployment): ReleaseRun[] => {
    if (deployment.creator?.endsWith("[bot]")) return [];
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

type Success = { sha: string; at: number; timeSource: ReleaseEvent["timeSource"]; headPr?: number; tagNotAdvanced?: boolean; postRelease?: string };

function successfulReleases(runs: readonly ReleaseRun[]): Success[] {
  const bySha = new Map<string, Success>();
  for (const run of runs) {
    if (run.outcome !== "released" || run.endedAt === null) continue;
    const known = bySha.get(run.sha);
    const knownFromGithub = known?.timeSource === "github-deployment";
    // the log wins over GitHub for the same commit; within one source the earliest success counts
    const better = !known || (knownFromGithub && !run.origin) || (knownFromGithub === Boolean(run.origin) && run.endedAt < known.at);
    if (!better) continue;
    const timeSource: ReleaseEvent["timeSource"] = run.origin ? "github-deployment" : run.timeSource === "log" ? "log" : "log-clock";
    bySha.set(run.sha, {
      sha: run.sha, at: run.endedAt, timeSource,
      ...(run.headPr ? { headPr: run.headPr } : {}),
      ...(run.tagNotAdvanced ? { tagNotAdvanced: true } : {}),
      ...(run.postRelease ? { postRelease: run.postRelease } : {}),
    });
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
    const joined = previous && contiguous(spans, previous.at, event.at);
    const base = joined ? previous!.sha : undefined;
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
    const reason = commits ? undefined : !previous ? "first" : !joined ? "gap" : "pending";
    releases.push({
      ...event, ...(base ? { baseSha: base } : {}), prs,
      issues: [...issueMap.values()].sort((a, b) => a.number - b.number),
      contentUnknown: !commits, ...(reason ? { contentUnknownReason: reason } : {}),
    });
  });
  // pipeline stopped: from the first failure that RAN after a success to the next success
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

// ── the index: every time sorted once, counted by binary search ────────────

/** Sorted times with an optional value each, and prefix sums of the values. */
class Series {
  readonly times: number[];
  private readonly sums: number[];
  constructor(entries: Array<[number, number]>) {
    entries.sort((a, b) => a[0] - b[0]);
    this.times = entries.map((entry) => entry[0]);
    this.sums = [0];
    for (const [, value] of entries) this.sums.push(this.sums.at(-1)! + value);
  }
  private lower(at: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid]! < at) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  count(from: number, to: number): number { return this.lower(to) - this.lower(from); }
  sum(from: number, to: number): number { return this.sums[this.lower(to)]! - this.sums[this.lower(from)]!; }
  /** Index range [a, b) of the entries in [from, to). */
  range(from: number, to: number): [number, number] { return [this.lower(from), this.lower(to)]; }
}

const series = (times: Array<number | null | undefined>) => new Series(times.filter((at): at is number => typeof at === "number").map((at) => [at, 1]));
const isChangeFailure = (verdict: string | undefined) => Boolean(verdict && /rolled_back|rollback|unhealthy/.test(verdict));
const isConclusive = (verdict: string | undefined) => Boolean(verdict && !/inconclusive/.test(verdict));

interface ReportIndex {
  timeline: Timeline;
  /** Where a release source exists (deliveries outside are unknown). */
  spans: Array<{ from: number; to: number }>;
  runs: ReleaseRun[];
  releases: Series; // value: delivered non-carrier PRs first shipped there
  releaseList: ReleaseEvent[];
  unknownContent: Series;
  failures: Series;
  superseded: Series;
  aborted: Series;
  declines: Series;
  merged: Series;
  carriers: Series;
  closed: Series;
  closedBugs: Series;
  created: Series;
  closedAll: Series;
  usage: Series; // value: cost
  usageTurns: Series;
  digests: Series; // value: duration
  timedDigests: Series;
  needsOpened: Series;
  needsResolved: Series;
}

function buildIndex(input: ReportInputs): ReportIndex {
  const { github } = input;
  const timeline = buildTimeline(input);
  const runs = allRuns(input);
  const deliveredNonCarrier = new Map<number, number>(); // release at → count
  for (const [number, at] of timeline.prDelivered) {
    const pr = github.prs[String(number)];
    if (pr && !isCarrier(pr)) deliveredNonCarrier.set(at, (deliveredNonCarrier.get(at) ?? 0) + 1);
  }
  const issues = Object.values(github.issues);
  const prs = Object.values(github.prs).filter((pr) => pr.mergedAt !== null && pr.base === "main");
  const usageTimes = input.usage.map((row) => [Date.parse(row.at), row.costUsd ?? 0] as [number, number]).filter(([at]) => Number.isFinite(at));
  return {
    timeline,
    spans: releaseSourceSpans(input),
    runs,
    releases: new Series(timeline.releases.map((release) => [release.at, deliveredNonCarrier.get(release.at) ?? 0])),
    releaseList: timeline.releases,
    unknownContent: series(timeline.releases.filter((release) => release.contentUnknown).map((release) => release.at)),
    failures: series(runs.filter((run) => run.outcome === "failed").map((run) => run.endedAt)),
    superseded: series(runs.filter((run) => run.outcome === "superseded").map((run) => run.endedAt)),
    aborted: series(runs.filter((run) => run.outcome === "aborted").map((run) => run.endedAt)),
    declines: series([...new Map(input.declines.map((decline) => [decline.sha, decline.at])).values()]),
    merged: series(prs.filter((pr) => !isCarrier(pr)).map((pr) => pr.mergedAt)),
    carriers: series(prs.filter(isCarrier).map((pr) => pr.mergedAt)),
    closed: series(issues.map((issue) => issue.closedAt)),
    closedBugs: series(issues.filter((issue) => !notPlanned(issue) && issueType(issue.labels) === "bug").map((issue) => issue.closedAt)),
    created: series(issues.map((issue) => issue.createdAt)),
    closedAll: series(issues.map((issue) => issue.closedAt)),
    usage: new Series(usageTimes),
    usageTurns: new Series(usageTimes.map(([at]) => [at, 1])),
    digests: new Series(input.digests.filter((digest) => digest.durationMs !== null).map((digest) => [digest.at, digest.durationMs!])),
    timedDigests: series(input.digests.filter((digest) => digest.durationMs !== null).map((digest) => digest.at)),
    needsOpened: series(input.needsYou.map((item) => item.createdAt)),
    needsResolved: series(input.needsYou.map((item) => item.resolvedAt)),
  };
}

const overlap = (a: { from: number; to: number }, from: number, to: number) => Math.max(0, Math.min(a.to, to) - Math.max(a.from, from));
const within = (at: number | null | undefined, from: number, to: number): at is number => typeof at === "number" && at >= from && at < to;
const zeroByType = (): Record<IssueType, number> => Object.fromEntries(ISSUE_TYPES.map((type) => [type, 0])) as Record<IssueType, number>;
const zeroByPriority = (): Record<IssuePriority, number> => Object.fromEntries(ISSUE_PRIORITIES.map((priority) => [priority, 0])) as Record<IssuePriority, number>;
const openAt = (index: ReportIndex, at: number) => index.created.count(-Infinity, at) - index.closedAll.count(-Infinity, at);

/** Milliseconds of [from, to) that fall on a Saturday or Sunday in São Paulo. */
export function weekendMs(from: number, to: number): number {
  let total = 0;
  for (let day = bucketStartDay(from); day < to; day = nextBucket(day, "day")) {
    const weekday = zonedParts(day + 12 * 3_600_000).weekday;
    if (weekday === 0 || weekday === 6) total += overlap({ from: day, to: nextBucket(day, "day") }, from, to);
  }
  return total;
}
const bucketStartDay = (at: number) => bucketStart(at, "day");

/** Business days (Mon–Fri, São Paulo, national holidays off) of [from, to), fractional at the edges. */
export function businessDays(from: number, to: number): number {
  let total = 0;
  for (let day = bucketStartDay(from); day < to; day = nextBucket(day, "day")) {
    const noon = zonedParts(day + 12 * 3_600_000);
    if (noon.weekday === 0 || noon.weekday === 6 || isNationalHoliday(noon.year, noon.month, noon.day)) continue;
    const end = nextBucket(day, "day");
    total += overlap({ from: day, to: end }, from, to) / (end - day);
  }
  return Math.round(total * 100) / 100;
}

/** Merge overlapping spans into disjoint ones, sorted. */
function mergeSpans(spans: ReadonlyArray<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const merged: Array<{ from: number; to: number }> = [];
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

/** Business days of [from, to) that a release source covers: the only days
 * on which a delivery could have been seen. */
export function coveredBusinessDays(from: number, to: number, spans: ReadonlyArray<{ from: number; to: number }>): number {
  const total = mergeSpans(spans).reduce((sum, span) => {
    const a = Math.max(from, span.from);
    const b = Math.min(to, span.to);
    return b > a ? sum + businessDays(a, b) : sum;
  }, 0);
  return Math.round(total * 100) / 100;
}

export function kpisFor(input: ReportInputs, index: ReportIndex, from: number, to: number): ReportKpis {
  const { github } = input;
  const end = Math.min(to, input.now);
  const releases = index.releaseList.filter((release) => within(release.at, from, to));
  const deliveredPrs = [...index.timeline.prDelivered].filter(([number, at]) => within(at, from, to) && !isCarrier(github.prs[String(number)]!));
  const deliveredIssues = [...index.timeline.issueDelivered].filter(([, delivery]) => within(delivery.at, from, to));
  const closedIssues = Object.values(github.issues).filter((issue) => within(issue.closedAt, from, to));
  const closedByType = zeroByType();
  const closedByPriority = zeroByPriority();
  for (const issue of closedIssues) {
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
  const leadMergeToProd = deliveredPrs.map(([number, at]) => Math.max(0, at - (github.prs[String(number)]!.mergedAt ?? 0)));
  const failed = index.failures.count(from, to);
  const blockedMs = index.timeline.blocked.reduce((sum, interval) => sum + overlap(interval, from, end), 0);
  const blockedWeekendMs = index.timeline.blocked.reduce((sum, interval) => {
    const a = Math.max(interval.from, from);
    const b = Math.min(interval.to, end);
    return b > a ? sum + weekendMs(a, b) : sum;
  }, 0);
  // DORA — the denominator is the business days a release source covers
  const days = businessDays(from, end);
  const releaseDays = coveredBusinessDays(from, end, index.spans);
  const checked = releases.filter((release) => isConclusive(release.postRelease));
  const failedChanges = checked.filter((release) => isChangeFailure(release.postRelease));
  const restores = failedChanges.map((release) => {
    const next = index.releaseList.find((later) => later.at > release.at && isConclusive(later.postRelease) && !isChangeFailure(later.postRelease));
    return next ? next.at - release.at : null;
  }).filter((value): value is number => value !== null);
  // bots, only where the usage ledger exists
  const usageFrom = input.local.usageFrom;
  const usageWindow = usageFrom === null ? null : { from: Math.max(from, usageFrom), to: end };
  const usage = input.usage.filter((row) => within(Date.parse(row.at), from, to));
  const priced = usage.filter((row) => row.costUsd !== null);
  const costOf = (rows: readonly UsageLike[]) => (rows.length ? Math.round(rows.reduce((sum, row) => sum + row.costUsd!, 0) * 100) / 100 : null);
  const costUsd = costOf(priced);
  const roleOf = (row: UsageLike) => botRole(input.botNames.get(row.botId) ?? row.botName);
  const costEngineeringUsd = costOf(priced.filter((row) => roleOf(row) === "engineering"));
  const costOperationsUsd = costOf(priced.filter((row) => roleOf(row) === "operations"));
  const costOtherUsd = costOf(priced.filter((row) => roleOf(row) === "other"));
  const deliveriesInUsageDays = usageWindow && usageWindow.to > usageWindow.from ? index.releases.count(usageWindow.from, usageWindow.to) : 0;
  const opened = input.needsYou.filter((item) => within(item.createdAt, from, to));
  const responses = opened.map(ownerResponseMs).filter((value): value is number => value !== null);
  const openAtEnd = Object.values(github.issues).filter((issue) => issue.createdAt < end && (issue.closedAt === null || issue.closedAt >= end));
  return {
    deliveries: releases.length,
    deliveredPrs: deliveredPrs.length,
    deliveredIssues: deliveredIssues.length,
    unknownContentReleases: index.unknownContent.count(from, to),
    mergedPrs: index.merged.count(from, to),
    carrierPrs: index.carriers.count(from, to),
    closedIssues: closedIssues.length,
    closedNotPlanned: closedIssues.filter(notPlanned).length,
    closedByType,
    closedByPriority,
    leadIssueToProd: distribution(leadIssueToProd),
    leadIssueToMerge: distribution(leadIssueToMerge),
    leadMergeToProd: distribution(leadMergeToProd),
    failedReleases: failed,
    supersededReleases: index.superseded.count(from, to),
    abortedReleases: index.aborted.count(from, to),
    releaseSuccessRate: releases.length + failed ? releases.length / (releases.length + failed) : null,
    declinedReleases: index.declines.count(from, to),
    blockedMs,
    blockedWeekendMs,
    deploysPerBusinessDay: releaseDays > 0 ? Math.round((releases.length / releaseDays) * 100) / 100 : null,
    businessDays: days,
    releaseBusinessDays: releaseDays,
    releaseCovered: end > from ? coverageOf(index.spans, from, end) : "none",
    changeFailures: failedChanges.length,
    checkedReleases: checked.length,
    timeToRestore: distribution(restores),
    openIssuesAtEnd: openAtEnd.length,
    openP1AtEnd: openAtEnd.filter((issue) => ["p0", "p1"].includes(issuePriority(issue.labels))).length,
    turns: usage.length,
    activeMs: index.digests.sum(from, to),
    timedTurns: index.timedDigests.count(from, to),
    inputTokens: usage.reduce((sum, row) => sum + row.input, 0),
    outputTokens: usage.reduce((sum, row) => sum + row.output, 0),
    cachedTokens: usage.reduce((sum, row) => sum + (row.cachedInput ?? 0), 0),
    costUsd,
    usageDays: usageWindow && usageWindow.to > usageWindow.from ? Math.round(((usageWindow.to - usageWindow.from) / DAY_MS) * 10) / 10 : 0,
    costEngineeringUsd,
    costOperationsUsd,
    costOtherUsd,
    costPerDelivery: costEngineeringUsd !== null && deliveriesInUsageDays >= MIN_TREND_BASE ? Math.round((costEngineeringUsd / deliveriesInUsageDays) * 100) / 100 : null,
    deliveriesInUsageDays,
    needsYouOpened: opened.length,
    needsYouResolved: input.needsYou.filter((item) => within(item.resolvedAt, from, to)).length,
    ownerResponse: distribution(responses),
  };
}

const deploymentTimes = (github: GhCache): number[] =>
  github.deployments.filter((deployment) => !deployment.creator?.endsWith("[bot]")).map((deployment) => deployment.successAt ?? deployment.failedAt ?? null).filter((at): at is number => at !== null);

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

function releaseRows(input: ReportInputs, index: ReportIndex, from: number, to: number): ReportRelease[] {
  const { github } = input;
  const item = (issue: GhIssue): ReportReleaseItem => ({ number: issue.number, title: issue.title, kind: "issue", type: issueType(issue.labels), priority: issuePriority(issue.labels) });
  const head = (number: number | undefined) => {
    if (!number) return {};
    const pr = github.prs[String(number)];
    return { headPr: number, ...(pr && isCarrier(pr) ? { headPrIsCarrier: true } : {}) };
  };
  const rows: ReportRelease[] = index.releaseList.filter((release) => within(release.at, from, to)).map((release) => ({
    sha: release.sha,
    at: release.at,
    timeSource: release.timeSource,
    outcome: "released" as const,
    ...(release.baseSha ? { baseSha: release.baseSha } : {}),
    ...head(release.headPr),
    ...(release.tagNotAdvanced ? { tagNotAdvanced: true } : {}),
    ...(release.postRelease ? { postRelease: release.postRelease } : {}),
    prs: release.prs.map((pr) => ({ number: pr.number, title: pr.title, kind: "pr" as const, ...(isCarrier(pr) ? { carrier: true } : {}) })),
    issues: release.issues.map(item),
    ...(release.contentUnknown ? { contentUnknown: true, contentUnknownReason: release.contentUnknownReason } : {}),
  }));
  // runs of the same commit in a row are one row: a commit that failed and was
  // also superseded or aborted reads "failed (n tries) · m superseded", not as
  // pairs of rows a minute apart (INSP-V r2 #7)
  const runs = index.runs.filter((run) => ["failed", "superseded", "aborted"].includes(run.outcome) && run.endedAt !== null).sort((a, b) => a.endedAt! - b.endedAt!);
  type Group = { sha: string; first: number; last: number; failed: number; superseded: number; aborted: number; cause?: string; headPr?: number; timeSource: ReportRelease["timeSource"] };
  let group: Group | null = null;
  const sourceOf = (run: ReleaseRun): ReportRelease["timeSource"] => run.origin ? "github-deployment" : run.timeSource === "log" ? "log" : "log-clock";
  const flush = () => {
    if (group && within(group.last, from, to)) {
      const outcome = group.failed ? "failed" : group.superseded ? "superseded" : "aborted";
      const attempts = outcome === "failed" ? group.failed : outcome === "superseded" ? group.superseded : group.aborted;
      rows.push({
        sha: group.sha, at: group.last, firstAt: group.first, attempts, timeSource: group.timeSource, outcome,
        ...(outcome !== "superseded" && group.superseded ? { supersededRuns: group.superseded } : {}),
        ...(outcome !== "aborted" && group.aborted ? { abortedRuns: group.aborted } : {}),
        ...(group.cause ? { cause: group.cause } : {}), ...head(group.headPr), prs: [], issues: [],
      });
    }
    group = null;
  };
  for (const run of runs) {
    const kind = run.outcome as "failed" | "superseded" | "aborted";
    if (!group || group.sha !== run.sha) {
      flush();
      group = { sha: run.sha, first: run.endedAt!, last: run.endedAt!, failed: 0, superseded: 0, aborted: 0, ...(run.headPr ? { headPr: run.headPr } : {}), timeSource: sourceOf(run) };
    }
    group.last = run.endedAt!;
    group[kind] += 1;
    // the row's cause is the failure's own verdict when there is one
    if (run.cause && (kind === "failed" || !group.failed)) group.cause = run.cause;
    if (sourceOf(run) === "log-clock") group.timeSource = "log-clock";
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
  const rank = { released: 0, superseded: 1, aborted: 2, failed: 3, declined: 4 } as const;
  return rows.sort((a, b) => b.at - a.at || rank[b.outcome] - rank[a.outcome]);
}

function backlogOf(input: ReportInputs): ReportBacklog {
  const all = Object.values(input.github.issues);
  const open = all.filter((issue) => issue.state === "OPEN");
  // a period that ended before the sync (a closed month) gets its own end-of-period snapshot
  const synced = input.github.syncedAt;
  const endAt = Math.min(input.period.to, input.now);
  const periodEnd = synced !== null && endAt < synced - 60_000 ? (() => {
    const openThen = all.filter((issue) => issue.createdAt < endAt && (issue.closedAt === null || issue.closedAt >= endAt));
    const oldestThen = openThen.slice().sort((a, b) => a.createdAt - b.createdAt)[0];
    return {
      at: endAt,
      openIssues: openThen.length,
      openP0P1: openThen.filter((issue) => ["p0", "p1"].includes(issuePriority(issue.labels))).length,
      oldestOpen: oldestThen ? { number: oldestThen.number, createdAt: oldestThen.createdAt } : null,
    };
  })() : null;
  const has = (issue: GhIssue, label: string) => issue.labels.some((each) => each.toLowerCase() === label);
  const oldest = open.slice().sort((a, b) => a.createdAt - b.createdAt)[0];
  const p1 = open.filter((issue) => issuePriority(issue.labels) === "p1");
  const p0 = open.filter((issue) => issuePriority(issue.labels) === "p0");
  const oldestP1 = [...p0, ...p1].sort((a, b) => a.createdAt - b.createdAt)[0];
  const waiting = input.github.openPrs.filter((pr) => !pr.draft && pr.base === "main" && pr.gate !== "success").sort((a, b) => a.createdAt - b.createdAt);
  return {
    openIssues: open.length,
    openP1: p1.length,
    openP0: p0.length,
    openP1Split: { current: p1.filter((issue) => has(issue, "priority:p1")).length, legacy: p1.filter((issue) => !has(issue, "priority:p1")).length },
    openP0Split: { current: p0.filter((issue) => has(issue, "priority:p0")).length, legacy: p0.filter((issue) => !has(issue, "priority:p0")).length },
    oldestOpen: oldest ? { number: oldest.number, createdAt: oldest.createdAt, priority: issuePriority(oldest.labels) } : null,
    oldestOpenP1: oldestP1 ? { number: oldestP1.number, createdAt: oldestP1.createdAt } : null,
    prsAwaitingGate: waiting.length,
    prsAwaitingGateList: waiting.slice(0, 50).map((pr) => ({ number: pr.number, title: pr.title, gate: pr.gate === "success" ? "pending" : pr.gate, since: pr.gateAt ?? pr.createdAt })),
    openPrs: input.github.openPrs.length,
    at: input.github.syncedAt,
    periodEnd,
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

const localCoverageOf = (since: number | null, from: number, to: number): ReportBucket["usageCoverage"] =>
  since === null || since >= to ? "none" : since <= from ? "full" : "partial";

export function buildProductivityReport(input: ReportInputs): ProductivityReport {
  const { granularity, period, now } = input;
  const index = buildIndex(input);
  const previous = previousPeriod(period, granularity);
  const spans = releaseSourceSpans(input);
  const starts = bucketStarts(period.from, period.to, granularity);
  const buckets: ReportBucket[] = starts.map((start) => {
    const end = nextBucket(start, granularity);
    const usageCoverage = localCoverageOf(input.local.usageFrom, start, Math.min(end, now));
    const needsCoverage = localCoverageOf(input.local.needsYouFrom, start, Math.min(end, now));
    const local = usageCoverage !== "none" && start < now;
    const cost = index.usage.sum(start, end);
    return {
      key: bucketKey(start, granularity),
      start,
      end,
      deliveries: index.releases.count(start, end),
      deliveredPrs: index.releases.sum(start, end),
      unknownContentReleases: index.unknownContent.count(start, end),
      mergedPrs: index.merged.count(start, end),
      closedIssues: index.closed.count(start, end),
      closedBugs: index.closedBugs.count(start, end),
      failedReleases: index.failures.count(start, end),
      blockedMs: index.timeline.blocked.reduce((sum, interval) => sum + overlap(interval, start, Math.min(end, now)), 0),
      openIssuesAtEnd: openAt(index, Math.min(end, now)),
      turns: local ? index.usageTurns.count(start, end) : null,
      activeMs: local ? index.digests.sum(start, end) : null,
      costUsd: local ? Math.round(cost * 100) / 100 : null,
      needsYouOpened: needsCoverage !== "none" && start < now ? index.needsOpened.count(start, end) : null,
      needsYouResolved: needsCoverage !== "none" && start < now ? index.needsResolved.count(start, end) : null,
      releaseCoverage: start >= now ? "none" : coverageOf(spans, start, Math.min(end, now)),
      usageCoverage,
    };
  });
  const logged = input.runs.filter((run) => run.outcome === "released");
  const latest = index.releaseList.at(-1);
  const deployed = deploymentTimes(input.github);
  const coverage: ReportCoverage = {
    releaseLog: { from: input.logCoverage.from, to: input.logCoverage.to },
    githubDeployments: { from: deployed.length ? Math.min(...deployed) : null, to: deployed.length ? Math.max(...deployed) : null },
    releaseGaps: gapsIn(spans, period.from, Math.min(period.to, now), DAY_MS),
    releaseCoverage: { period: coverageOf(spans, period.from, Math.min(period.to, now)), previous: coverageOf(spans, previous.from, Math.min(previous.to, now)) },
    github: { syncedAt: input.github.syncedAt, complete: input.github.prWalk.complete && input.github.issueWalk.complete, issues: Object.keys(input.github.issues).length, prs: Object.keys(input.github.prs).length, repoCreatedAt: input.github.repoCreatedAt ?? null },
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
    version: 2,
    generatedAt: now,
    timezone: REPORT_TZ,
    repo: PRODUCTION_REPO,
    granularity,
    period,
    previous,
    kpis: kpisFor(input, index, period.from, period.to),
    previousKpis: kpisFor(input, index, previous.from, previous.to),
    buckets,
    releases: releaseRows(input, index, period.from, period.to),
    backlog: backlogOf(input),
    bots: botsOf(input, period.from, period.to),
    coverage,
    sync: input.sync,
    goals: input.goals ?? {},
  };
}
