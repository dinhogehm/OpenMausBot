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

/** The wall clock in São Paulo at an instant. */
export function zonedParts(ms: number): ZonedParts {
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

/** São Paulo's offset from UTC at an instant, in ms (−3 h since 2019). */
export function zonedOffsetMs(ms: number): number {
  const p = zonedParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
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
  const p = zonedParts(ms);
  if (granularity === "hour") return zonedToUtc(p.year, p.month, p.day, p.hour);
  if (granularity === "day") return zonedToUtc(p.year, p.month, p.day);
  return zonedToUtc(p.year, p.month, 1);
}

/** The start of the bucket after the one starting at `start`. */
export function nextBucket(start: number, granularity: Granularity): number {
  const p = zonedParts(start);
  if (granularity === "hour") return zonedToUtc(p.year, p.month, p.day, p.hour + 1);
  if (granularity === "day") return zonedToUtc(p.year, p.month, p.day + 1);
  return zonedToUtc(p.year, p.month + 1, 1);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A stable key for a bucket: 2026-10-02T13 / 2026-10-02 / 2026-10 (São Paulo). */
export function bucketKey(ms: number, granularity: Granularity): string {
  const p = zonedParts(ms);
  const day = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  if (granularity === "hour") return `${day}T${pad(p.hour)}`;
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
  const p = zonedParts(start);
  if (granularity === "hour") return zonedToUtc(p.year, p.month, p.day, p.hour - 1);
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
  /** Release runs that ended without advancing the tag. */
  failedReleases: number;
  /** Distinct commits the operator declined to publish. */
  declinedReleases: number;
  /** Time production was blocked: from the first failed release after a
   * success until the next success, clipped to the period (ms). */
  blockedMs: number;
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
  mergedPrs: number;
  closedIssues: number;
  closedBugs: number;
  failedReleases: number;
  blockedMs: number;
  openIssuesAtEnd: number;
  turns: number;
  activeMs: number;
  costUsd: number | null;
  needsYouOpened: number;
  needsYouResolved: number;
  /** How much of the bucket a release source covers: production numbers in
   * a bucket with "none" are unknown, not zero. */
  releaseCoverage: "full" | "partial" | "none";
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
  outcome: "released" | "failed" | "declined";
  /** For a failure: the run's own verdict line, without paths or times. */
  cause?: string;
  /** Previous released sha: the release contains the merges between both. */
  baseSha?: string;
  prs: ReportReleaseItem[];
  issues: ReportReleaseItem[];
  /** The release content could not be read (no base, or GitHub failed). */
  contentUnknown?: boolean;
  /** Failures of one commit in a row are one row: how many tries, since when. */
  attempts?: number;
  firstAt?: number;
  /** The carrier PR that published it. */
  carrierPr?: number;
}

export interface ReportBacklog {
  /** Now (the sync time), whatever the period. */
  openIssues: number;
  openP1: number;
  openP0: number;
  oldestOpen: { number: number; createdAt: number; priority: IssuePriority } | null;
  oldestOpenP1: { number: number; createdAt: number } | null;
  /** Open PRs into main (not drafts) whose head has no green nuria/local-merge-gate. */
  prsAwaitingGate: number;
  prsAwaitingGateList: Array<{ number: number; title: string; gate: "pending" | "failure" | "missing"; since: number }>;
  openPrs: number;
  at: number | null;
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
  github: { syncedAt: number | null; complete: boolean; issues: number; prs: number };
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
  version: 1;
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
}

/** How a KPI moved against the previous period: null when there is nothing to compare. */
export function trend(current: number | null, previous: number | null): { delta: number; ratio: number | null } | null {
  if (current === null || previous === null) return null;
  const delta = current - previous;
  return { delta, ratio: previous === 0 ? null : delta / previous };
}

export const DAY = DAY_MS;
export const HOUR = HOUR_MS;
