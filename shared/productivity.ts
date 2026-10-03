// The productivity report (lot V): what the Nuria team put IN PRODUCTION per
// hour, day or month, for the owner to report to the board. One contract for
// the server (server/productivity-*.ts builds it) and the app (ReportPage
// reads it); every calendar boundary is São Paulo's, never the machine's.
//
// Pure and dependency-free: the server runs it with --experimental-strip-types
// and the renderer bundles it, so nothing here may import either side.

export const REPORT_TZ = "America/Sao_Paulo";
export const PRODUCTION_REPO = "dinhogehm/nuria-platform";

export type Granularity = "hour" | "day" | "month";
export const GRANULARITIES: readonly Granularity[] = ["hour", "day", "month"];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// ── São Paulo calendar ──────────────────────────────────────────────────────

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: REPORT_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall clock as Intl gives it (the slow, authoritative path). */
function intlParts(ms: number): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of partsFormat.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? "Sun"),
  };
}

// São Paulo's offsets have always changed on whole hours: one Intl lookup per
// absolute hour is exact, and the wall clock follows by arithmetic. A report
// of a year by day touches ~400 hours instead of thousands of formatToParts.
const offsetByHour = new Map<number, number>();

/** São Paulo's offset from UTC at an instant, in ms (−3 h since 2019). */
export function zonedOffsetMs(ms: number): number {
  const hour = Math.floor(ms / HOUR_MS);
  let offset = offsetByHour.get(hour);
  if (offset === undefined) {
    const at = hour * HOUR_MS;
    const p = intlParts(at);
    offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
    if (offsetByHour.size > 100_000) offsetByHour.clear();
    offsetByHour.set(hour, offset);
  }
  return offset;
}

/** The wall clock in São Paulo at an instant. */
export function zonedParts(ms: number): ZonedParts {
  const local = new Date(ms + zonedOffsetMs(ms));
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    weekday: local.getUTCDay(),
  };
}

/** The instant a São Paulo wall clock names. Month and day may overflow
 * (Date.UTC normalizes them), which is how "next month" is computed. A
 * clock skipped by a DST jump resolves to the instant after the jump. */
export function zonedToUtc(year: number, month: number, day: number, hour = 0, minute = 0): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zonedOffsetMs(guess);
  const second = guess - zonedOffsetMs(first);
  return second === first ? first : Math.max(first, second);
}

/** The bucket an instant falls in: the start of its São Paulo hour, day or month. */
export function bucketStart(ms: number, granularity: Granularity): number {
  // São Paulo's offsets have always been whole hours: an hour bucket is an
  // absolute hour, so the hour repeated when daylight saving ended is two buckets
  if (granularity === "hour") return Math.floor(ms / HOUR_MS) * HOUR_MS;
  const p = zonedParts(ms);
  if (granularity === "day") return zonedToUtc(p.year, p.month, p.day);
  return zonedToUtc(p.year, p.month, 1);
}

/** The start of the bucket after the one starting at `start`. */
export function nextBucket(start: number, granularity: Granularity): number {
  if (granularity === "hour") return start + HOUR_MS;
  const p = zonedParts(start);
  if (granularity === "day") return zonedToUtc(p.year, p.month, p.day + 1);
  return zonedToUtc(p.year, p.month + 1, 1);
}

const pad = (value: number) => String(value).padStart(2, "0");
const STANDARD_OFFSET_MS = -3 * HOUR_MS;

/** A stable key for a bucket: 2026-10-02T13 / 2026-10-02 / 2026-10 (São Paulo).
 * An hour under the old daylight-saving offset carries it ("2019-02-16T23-02"),
 * so the repeated hour of the change back never collides with its twin. */
export function bucketKey(ms: number, granularity: Granularity): string {
  const p = zonedParts(ms);
  const day = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  if (granularity === "hour") {
    const offset = zonedOffsetMs(ms);
    return offset === STANDARD_OFFSET_MS ? `${day}T${pad(p.hour)}` : `${day}T${pad(p.hour)}-${pad(Math.abs(offset) / HOUR_MS)}`;
  }
  if (granularity === "day") return day;
  return `${p.year}-${pad(p.month)}`;
}

/** Every bucket start in [from, to). */
export function bucketStarts(from: number, to: number, granularity: Granularity): number[] {
  const starts: number[] = [];
  for (let at = bucketStart(from, granularity); at < to && starts.length < 2_000; at = nextBucket(at, granularity)) starts.push(at);
  return starts;
}

// ── periods ─────────────────────────────────────────────────────────────────

export interface ReportPeriod { from: number; to: number }

/** The preset windows the screen offers: the last 48 h, the last 30 or 90
 * days, the last 12 months — each ending with the current (partial) bucket. */
export const PERIOD_PRESETS: Record<Granularity, readonly number[]> = { hour: [48], day: [30, 90], month: [12] };
export const MAX_BUCKETS: Record<Granularity, number> = { hour: 24 * 14, day: 366, month: 36 };

/** The last `count` buckets up to now, the current one included. */
export function presetPeriod(granularity: Granularity, count: number, now: number): ReportPeriod {
  const current = bucketStart(now, granularity);
  let from = current;
  for (let i = 1; i < count; i += 1) from = previousBucket(from, granularity);
  return { from, to: nextBucket(current, granularity) };
}

export function previousBucket(start: number, granularity: Granularity): number {
  if (granularity === "hour") return start - HOUR_MS;
  const p = zonedParts(start);
  if (granularity === "day") return zonedToUtc(p.year, p.month, p.day - 1);
  return zonedToUtc(p.year, p.month - 1, 1);
}

/** The period right before, with as many buckets: what "vs. período anterior" compares to. */
export function previousPeriod(period: ReportPeriod, granularity: Granularity): ReportPeriod {
  const count = bucketStarts(period.from, period.to, granularity).length;
  let from = bucketStart(period.from, granularity);
  for (let i = 0; i < count; i += 1) from = previousBucket(from, granularity);
  return { from, to: bucketStart(period.from, granularity) };
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_ONLY = /^(\d{4})-(\d{2})$/;

/** A `from`/`to` query value: YYYY-MM-DD or YYYY-MM (São Paulo calendar) or an
 * ISO instant. `end` makes a date mean the END of that day/month (exclusive). */
export function parseReportBound(value: string, end: boolean): number | null {
  const date = DATE_ONLY.exec(value);
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1) return null;
    return zonedToUtc(year, month, day + (end ? 1 : 0));
  }
  const month = MONTH_ONLY.exec(value);
  if (month) {
    const [year, m] = [Number(month[1]), Number(month[2])];
    if (m < 1 || m > 12) return null;
    return zonedToUtc(year, m + (end ? 1 : 0), 1);
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The period a request names, or why not. Without from/to: the default
 * preset (48 h, 30 days, 12 months). `days` picks the 90-day preset. */
export function resolveReportPeriod(input: { granularity: Granularity; from?: string | null; to?: string | null; count?: number | null; now: number }): { period: ReportPeriod } | { error: string } {
  const { granularity, now } = input;
  if (!input.from && !input.to) {
    const presets = PERIOD_PRESETS[granularity];
    const count = input.count && presets.includes(input.count) ? input.count : presets[0]!;
    return { period: presetPeriod(granularity, count, now) };
  }
  if (!input.from || !input.to) return { error: "from and to go together" };
  const from = parseReportBound(input.from, false);
  const to = parseReportBound(input.to, true);
  if (from === null || to === null) return { error: "from and to must be YYYY-MM-DD, YYYY-MM or an ISO instant" };
  if (to <= from) return { error: "from must come before to" };
  const period = { from: bucketStart(from, granularity), to: to === bucketStart(to, granularity) ? to : nextBucket(bucketStart(to, granularity), granularity) };
  if (bucketStarts(period.from, period.to, granularity).length > MAX_BUCKETS[granularity]) {
    return { error: `at most ${MAX_BUCKETS[granularity]} ${granularity === "hour" ? "hours" : granularity === "day" ? "days" : "months"} per report` };
  }
  return { period };
}

// ── statistics ──────────────────────────────────────────────────────────────

export interface Distribution { n: number; median: number | null; p90: number | null }

/** Median (mean of the two middle values when even) and p90 by nearest rank
 * (the smallest value with at least 90% of the sample at or below it). */
export function distribution(values: readonly number[]): Distribution {
  const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { n: 0, median: null, p90: null };
  const middle = Math.floor(n / 2);
  const median = n % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const p90 = sorted[Math.max(0, Math.ceil(0.9 * n) - 1)]!;
  return { n, median, p90 };
}

// ── the report ──────────────────────────────────────────────────────────────

export type IssueType = "bug" | "improvement" | "feature" | "other";
export type IssuePriority = "p0" | "p1" | "p2" | "p3" | "none";
export const ISSUE_TYPES: readonly IssueType[] = ["bug", "improvement", "feature", "other"];
export const ISSUE_PRIORITIES: readonly IssuePriority[] = ["p0", "p1", "p2", "p3", "none"];

export interface ReportKpis {
  /** Advances of the production tag (successful releases) in the period. */
  deliveries: number;
  /** Merged PRs (not release carriers) that reached production in the period. */
  deliveredPrs: number;
  /** Issues closed by the PRs that reached production in the period. */
  deliveredIssues: number;
  /** PRs merged into main in the period, release carriers excluded. */
  mergedPrs: number;
  /** Release-carrier PRs merged in the period (how the code is published, not new work). */
  carrierPrs: number;
  /** Issues closed in the period (any reason). */
  closedIssues: number;
  /** Of those, closed as not planned or duplicate. */
  closedNotPlanned: number;
  closedByType: Record<IssueType, number>;
  closedByPriority: Record<IssuePriority, number>;
  /** Issue created → in production, for issues delivered in the period (ms). */
  leadIssueToProd: Distribution;
  /** Issue created → its PR merged (ms). */
  leadIssueToMerge: Distribution;
  /** PR merged → in production, for PRs delivered in the period (ms). */
  leadMergeToProd: Distribution;
  /** Release runs that RAN (CI or deploy steps) and ended without advancing the tag. */
  failedReleases: number;
  /** Runs the watcher dropped before they ran (a newer tip, the admission queue). Not failures. */
  supersededReleases: number;
  /** Runs that stopped before running anything (stale lock, smart-deploy could not start). Not failures. */
  abortedReleases: number;
  /** deliveries ÷ (deliveries + failures): how often a release that ran reached production; null without attempts. */
  releaseSuccessRate: number | null;
  /** Distinct commits the operator declined to publish. */
  declinedReleases: number;
  /** Release pipeline stopped (production stays up): from the first failure
   * that RAN after a success until the next success, clipped to the period (ms). */
  blockedMs: number;
  /** Of blockedMs, the part on Saturdays and Sundays (São Paulo). */
  blockedWeekendMs: number;
  /** Releases in the period whose contents are not known yet: delivered PRs and
   * issues are then lower bounds ("≥N"). */
  unknownContentReleases: number;
  /** DORA — deliveries per business day WITH A RELEASE SOURCE (Mon–Fri, São
   * Paulo, national holidays off): days no source covers are unknown, not zero. */
  deploysPerBusinessDay: number | null;
  /** Business days elapsed in the period. */
  businessDays: number;
  /** Of those, the business days a release source covers (the denominator above). */
  releaseBusinessDays: number;
  /** How much of the period a release source covers: below "full", deliveries are a lower bound. */
  releaseCovered: "full" | "partial" | "none";
  /** DORA — change failure rate: releases whose post-release check rolled back
   * or found production unhealthy ÷ releases with a conclusive check. */
  changeFailures: number;
  checkedReleases: number;
  /** DORA — time to restore: a failed change → the next release with a healthy check. */
  timeToRestore: Distribution;
  /** Open issues at the END of the period. */
  openIssuesAtEnd: number;
  /** Open P0/P1 issues at the end of the period (by today's labels). */
  openP1AtEnd: number;
  // bots (local OpenMausBot data)
  turns: number;
  activeMs: number;
  /** Turns whose digest carried a duration (activeMs covers only these). */
  timedTurns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null;
  /** Days of the period the usage ledger covers (turns, tokens, cost are for these days only). */
  usageDays: number;
  /** The cost split by who the bots work for (botRole): engineering builds
   * what ships, operations (Monitor Chat, Chief of Staff) does not. */
  costEngineeringUsd: number | null;
  costOperationsUsd: number | null;
  costOtherUsd: number | null;
  /** Engineering bots' cost in the covered days ÷ deliveries in the same days;
   * null without cost or with fewer than MIN_TREND_BASE deliveries (a ratio on 1 is noise). */
  costPerDelivery: number | null;
  deliveriesInUsageDays: number;
  needsYouOpened: number;
  needsYouResolved: number;
  /** Item opened → the owner's first answer (or the owner's resolution). */
  ownerResponse: Distribution;
}

export interface ReportBucket {
  key: string;
  start: number;
  end: number;
  deliveries: number;
  deliveredPrs: number;
  /** Releases in the bucket with unknown contents (deliveredPrs is then a lower bound). */
  unknownContentReleases: number;
  mergedPrs: number;
  closedIssues: number;
  closedBugs: number;
  failedReleases: number;
  blockedMs: number;
  openIssuesAtEnd: number;
  /** Bots' numbers: null where the usage ledger did not exist yet ("—", not 0). */
  turns: number | null;
  activeMs: number | null;
  costUsd: number | null;
  needsYouOpened: number | null;
  needsYouResolved: number | null;
  /** How much of the bucket a release source covers: production numbers in
   * a bucket with "none" are unknown, not zero. */
  releaseCoverage: "full" | "partial" | "none";
  /** How much of the bucket the bots' usage ledger covers. */
  usageCoverage: "full" | "partial" | "none";
}

export interface ReportReleaseItem { number: number; title: string; kind: "pr" | "issue"; type?: IssueType; priority?: IssuePriority; carrier?: boolean }

export interface ReportRelease {
  sha: string;
  /** When it went to production (deploy finished), ms. */
  at: number;
  /** How `at` is known: the deploy report and its durations in the log
   * ("log"), the time of day in the log with the date from its neighbours
   * ("log-clock"), the time the state file was written ("state-file"), or a
   * GitHub deployment ("github-deployment"). */
  timeSource: "log" | "log-clock" | "state-file" | "github-deployment";
  outcome: "released" | "failed" | "superseded" | "aborted" | "declined";
  /** For a failure: the run's own verdict line, without paths or times. */
  cause?: string;
  /** Previous released sha: the release contains the merges between both. */
  baseSha?: string;
  prs: ReportReleaseItem[];
  issues: ReportReleaseItem[];
  /** The release content is not known: why. "first" — no earlier release is
   * known at all; "gap" — the earlier one is across a time no source covers;
   * "pending" — both are known, the commits between them are not read yet. */
  contentUnknown?: boolean;
  contentUnknownReason?: "first" | "gap" | "pending";
  /** Runs of one commit in a row are one row: how many tries, since when. */
  attempts?: number;
  /** Folded into a failed commit's row: its runs that were superseded or aborted. */
  supersededRuns?: number;
  abortedRuns?: number;
  firstAt?: number;
  /** The PR whose merge is the released commit, and whether it is a release carrier. */
  headPr?: number;
  headPrIsCarrier?: boolean;
  /** The post-release health verdict (healthy, rolled_back, …), when checked. */
  postRelease?: string;
  /** Went live, but the watcher could not advance the tag (moved by hand later). */
  tagNotAdvanced?: boolean;
}

export interface ReportBacklog {
  /** Now (the sync time), whatever the period. */
  openIssues: number;
  /** P1 = priority:p1 + priority:high (the old scale); P0 = priority:p0 + priority:critical. */
  openP1: number;
  openP0: number;
  openP1Split: { current: number; legacy: number };
  openP0Split: { current: number; legacy: number };
  oldestOpen: { number: number; createdAt: number; priority: IssuePriority } | null;
  oldestOpenP1: { number: number; createdAt: number } | null;
  /** Open PRs into main (not drafts) whose head has no green nuria/local-merge-gate. */
  prsAwaitingGate: number;
  prsAwaitingGateList: Array<{ number: number; title: string; gate: "pending" | "failure" | "missing"; since: number }>;
  openPrs: number;
  at: number | null;
  /** The snapshot at the END of the period, when it ended before the sync
   * (a closed month): what the board reads for that month. Today's labels. */
  periodEnd: { at: number; openIssues: number; openP0P1: number; oldestOpen: { number: number; createdAt: number } | null } | null;
}

export interface ReportBotEffort {
  botId: string;
  name: string;
  turns: number;
  activeMs: number;
  timedTurns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null;
  needsYouOpened: number;
  needsYouResolved: number;
  needsYouOpenNow: number;
}

export interface ReportCoverage {
  /** First and last instant the release history covers, per source. */
  releaseLog: { from: number | null; to: number | null };
  githubDeployments: { from: number | null; to: number | null };
  /** Instants with no release source at all inside the period (gaps ≥ 1 day). */
  releaseGaps: Array<{ from: number; to: number }>;
  /** How much of the period, and of the previous one, a release source covers:
   * production numbers are compared only when the previous period has one. */
  releaseCoverage: { period: "full" | "partial" | "none"; previous: "full" | "partial" | "none" };
  github: { syncedAt: number | null; complete: boolean; issues: number; prs: number; repoCreatedAt: number | null };
  usage: { from: number | null };
  digests: { from: number | null };
  needsYou: { from: number | null };
  /** The production tag on GitHub right now, and whether the history agrees. */
  tag: { sha: string | null; matchesHistory: boolean | null; checkedAt: number | null };
}

export interface ReportSyncState {
  state: "idle" | "syncing" | "error" | "rate-limited";
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
  nextSyncAt: number | null;
  error: string | null;
  rateLimit: { remaining: number; resetAt: number } | null;
  phase?: string;
}

export interface ProductivityReport {
  version: 2;
  generatedAt: number;
  timezone: typeof REPORT_TZ;
  repo: typeof PRODUCTION_REPO;
  granularity: Granularity;
  period: ReportPeriod;
  previous: ReportPeriod;
  kpis: ReportKpis;
  previousKpis: ReportKpis;
  buckets: ReportBucket[];
  /** Releases, failures and refusals in the period, newest first. */
  releases: ReportRelease[];
  backlog: ReportBacklog;
  bots: ReportBotEffort[];
  coverage: ReportCoverage;
  sync: ReportSyncState;
  /** The five-line executive summary, as exported (pt-BR) and in English. */
  summary?: Record<"pt-BR" | "en", string[]>;
  /** False when this machine does not run the Nuria release (no ~/.nuria): nothing is collected. */
  enabled?: boolean;
  /** The owner's targets; empty by default (no traffic light without a target). */
  goals: ReportGoals;
}

// ── goals ───────────────────────────────────────────────────────────────────

/** Targets the owner sets for the board. Every field optional: no target, no light. */
export interface ReportGoals {
  /** At least this many deliveries per business day. */
  deploysPerBusinessDay?: number;
  /** Lead time issue → production, median, at most this many hours. */
  leadTimeHours?: number;
  /** Release success rate at least this % (0–100). */
  releaseSuccessRate?: number;
  /** Change failure rate at most this % (0–100). */
  changeFailureRate?: number;
}

export const GOAL_KEYS = ["deploysPerBusinessDay", "leadTimeHours", "releaseSuccessRate", "changeFailureRate"] as const;
export type GoalKey = (typeof GOAL_KEYS)[number];
const GOAL_HIGHER_IS_BETTER: Record<GoalKey, boolean> = { deploysPerBusinessDay: true, leadTimeHours: false, releaseSuccessRate: true, changeFailureRate: false };

/** Only finite, non-negative numbers survive; percentages are kept within 0–100. */
export function sanitizeGoals(raw: unknown): ReportGoals {
  const goals: ReportGoals = {};
  if (!raw || typeof raw !== "object") return goals;
  for (const key of GOAL_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    if ((key === "releaseSuccessRate" || key === "changeFailureRate") && value > 100) continue;
    goals[key] = value;
  }
  return goals;
}

/** The light for a value against its target: met, close (within 20% of the
 * target), or off. null when there is no target or no value. */
export function goalStatus(key: GoalKey, value: number | null, goals: ReportGoals): "met" | "close" | "off" | null {
  const target = goals[key];
  if (target === undefined || value === null || !Number.isFinite(value)) return null;
  const higher = GOAL_HIGHER_IS_BETTER[key];
  if (higher ? value >= target : value <= target) return "met";
  const slack = Math.max(Math.abs(target) * 0.2, 1e-9);
  return (higher ? value >= target - slack : value <= target + slack) ? "close" : "off";
}

// ── release counts (one source for the screen, the PDF and the Markdown) ───

/** The period's release header: commits in production, commits that failed and
 * how many tries ran, and the runs that never ran (superseded, aborted) —
 * runs, not rows, so the screen and the exports say the same thing. */
export function releaseCountParts(report: Pick<ProductivityReport, "releases" | "kpis">): { released: number; failedCommits: number; failedTries: number; superseded: number; aborted: number; declined: number } {
  return {
    released: report.releases.filter((row) => row.outcome === "released").length,
    failedCommits: report.releases.filter((row) => row.outcome === "failed").length,
    failedTries: report.kpis.failedReleases,
    superseded: report.kpis.supersededReleases,
    aborted: report.kpis.abortedReleases,
    declined: report.kpis.declinedReleases,
  };
}

// ── export readiness ────────────────────────────────────────────────────────

/** Older than this, GitHub numbers (and the tag check) are not exported without a warning. */
export const EXPORT_MAX_AGE_MS = 3_600_000;

export type ExportBlocker = "never" | "syncing" | "stale" | "tag-mismatch";

/** Whether the report may go to the board as is: synced in the last hour, no
 * sync running, and the production tag agreeing with the history. Otherwise
 * the screen offers "Atualizar e exportar" and the export carries a banner. */
export function exportReadiness(report: Pick<ProductivityReport, "sync" | "coverage">, now: number): { ready: boolean; blockers: ExportBlocker[]; ageMs: number | null } {
  const blockers: ExportBlocker[] = [];
  const synced = report.sync.lastSyncAt ?? report.coverage.github.syncedAt;
  const ageMs = synced === null ? null : Math.max(0, now - synced);
  if (synced === null) blockers.push("never");
  else if (ageMs! > EXPORT_MAX_AGE_MS) blockers.push("stale");
  if (report.sync.state === "syncing") blockers.push("syncing");
  if (report.coverage.tag.matchesHistory === false) blockers.push("tag-mismatch");
  return { ready: blockers.length === 0, blockers, ageMs };
}

// ── calendar: national holidays and who a bot works for ────────────────────

/** Easter Sunday (Gregorian, anonymous algorithm) as [month, day]. */
function easter(year: number): [number, number] {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1];
}

const FIXED_HOLIDAYS = ["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"];

/** A Brazilian national holiday (fixed dates and Good Friday); optional days
 * such as Carnival and Corpus Christi stay business days. */
export function isNationalHoliday(year: number, month: number, day: number): boolean {
  if (FIXED_HOLIDAYS.includes(`${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`)) return year < 2024 && month === 11 && day === 20 ? false : true;
  const [em, ed] = easter(year);
  const goodFriday = new Date(Date.UTC(year, em - 1, ed - 2));
  return goodFriday.getUTCMonth() + 1 === month && goodFriday.getUTCDate() === day;
}

export type BotRole = "engineering" | "operations" | "other";

/** Engineering bots (Lead, Eng, QA, DBA, SRE, Delivery) build what ships;
 * operations bots (Monitor Chat, Chief of Staff) do not, so their cost stays
 * out of the cost per delivery. */
export function botRole(name: string | undefined): BotRole {
  if (!name) return "other";
  if (/monitor|chief of staff|atendimento/i.test(name)) return "operations";
  if (/\b(lead|eng|qa|dba|sre|delivery)\b/i.test(name)) return "engineering";
  return "other";
}

// ── comparisons (one rule for the screen, the PDF and the Markdown) ─────────

/** Below this, a previous value is too small for a percentage or a trend arrow. */
export const MIN_TREND_BASE = 5;
/** Below this many samples, a median does not get a trend. */
export const MIN_TREND_SAMPLES = 10;

export type Comparison =
  | { kind: "trend"; delta: number; ratio: number }
  | { kind: "absolute"; previous: number }
  | { kind: "none"; reason: "no-base" | "before-repo" | "not-comparable" };

/** How a number may be compared with the previous period: a trend (delta and
 * %), only the previous absolute value (base under MIN_TREND_BASE, or fewer
 * than MIN_TREND_SAMPLES samples for a median), or nothing (no comparable
 * source, or a previous period before the repository existed). */
export function compareKpi(current: number | null, previous: number | null, options: { comparable?: boolean; beforeRepo?: boolean; samples?: { current: number; previous: number }; base?: number } = {}): Comparison {
  if (options.beforeRepo) return { kind: "none", reason: "before-repo" };
  if (options.comparable === false) return { kind: "none", reason: "not-comparable" };
  if (current === null || previous === null) return { kind: "none", reason: "no-base" };
  // a median or a rate is judged by how many samples it stands on, not by its own size
  if (options.samples) {
    if (options.samples.current < MIN_TREND_SAMPLES || options.samples.previous < MIN_TREND_SAMPLES) return { kind: "absolute", previous };
  } else if (Math.abs(options.base ?? previous) < MIN_TREND_BASE) {
    // a ratio (deploys per business day) is judged by the count under it
    return { kind: "absolute", previous };
  }
  if (previous === 0) return { kind: "absolute", previous };
  return { kind: "trend", delta: current - previous, ratio: (current - previous) / previous };
}

/** The previous period started before the repository existed: no GitHub trend against it. */
export function beforeRepo(report: Pick<ProductivityReport, "previous" | "coverage">): boolean {
  const created = report.coverage.github.repoCreatedAt;
  return created !== null && created !== undefined && report.previous.from < created;
}

// ── titles ──────────────────────────────────────────────────────────────────

const MONTH_NAMES: Record<"pt-BR" | "en", string[]> = {
  "pt-BR": ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};

/** The period in the title: "setembro/2026" for a whole calendar month (closed,
 * or "até 02/10" when it is the current one), else "03/09 a 02/10/2026". */
export function periodTitle(period: ReportPeriod, now: number, lang: "pt-BR" | "en" = "pt-BR"): string {
  const start = zonedParts(period.from);
  const last = zonedParts(Math.min(period.to, now) - 1);
  const wholeMonths = bucketStart(period.from, "month") === period.from && bucketStart(period.to, "month") === period.to;
  const p2 = (value: number) => String(value).padStart(2, "0");
  const date = (p: ZonedParts, year = true) => (lang === "pt-BR" ? `${p2(p.day)}/${p2(p.month)}${year ? `/${p.year}` : ""}` : `${p.year}-${p2(p.month)}-${p2(p.day)}`);
  if (wholeMonths && nextBucket(period.from, "month") === period.to) {
    const name = `${MONTH_NAMES[lang][start.month - 1]}/${start.year}`;
    if (period.to <= now) return name;
    return lang === "pt-BR" ? `${name} (até ${date(last, false)})` : `${name} (through ${date(last)})`;
  }
  if (wholeMonths) {
    const end = zonedParts(period.to - 1);
    return `${MONTH_NAMES[lang][start.month - 1]}/${start.year} – ${MONTH_NAMES[lang][end.month - 1]}/${end.year}`;
  }
  if (start.year === last.year && start.month === last.month && start.day === last.day) return date(start);
  return lang === "pt-BR" ? `${date(start, start.year !== last.year)} a ${date(last)}` : `${date(start)} to ${date(last)}`;
}

/** The last complete calendar month before `now`, as from/to (YYYY-MM). */
export function closedMonth(now: number): { from: string; to: string } {
  const p = zonedParts(bucketStart(now, "month") - 1);
  const key = `${p.year}-${String(p.month).padStart(2, "0")}`;
  return { from: key, to: key };
}

/** Production numbers (deliveries, failures, lead time, blocked time) are
 * compared only when a release source covers both periods completely: a
 * partial period is a lower bound, and a trend against one is not a trend. */
export function releaseComparable(report: Pick<ProductivityReport, "coverage">): boolean {
  const coverage = report.coverage.releaseCoverage;
  return Boolean(coverage) && coverage.period === "full" && coverage.previous === "full";
}

/** The bots' numbers compare only when this machine recorded them for the
 * whole previous period (the usage ledger and the "Precisa de você" log both
 * start on a day; before it, nothing is not zero). */
export function localComparable(report: Pick<ProductivityReport, "coverage" | "previous">): { usage: boolean; needsYou: boolean } {
  const since = (from: number | null) => from !== null && from <= report.previous.from;
  return { usage: since(report.coverage.usage.from), needsYou: since(report.coverage.needsYou.from) };
}

/** How a KPI moved against the previous period: null when there is nothing to compare. */
export function trend(current: number | null, previous: number | null): { delta: number; ratio: number | null } | null {
  if (current === null || previous === null) return null;
  const delta = current - previous;
  return { delta, ratio: previous === 0 ? null : delta / previous };
}

export const DAY = DAY_MS;
export const HOUR = HOUR_MS;
