// "Agora" (lot Y), the server's half: the delivery line's state, gathered from
// what the server already reads and turned into one NowServerStatus, the same
// way every time (shared/now-status.ts). Read-only everywhere: the release
// log, ~/.nuria/admission, `ps`, `git log` in the nuria-platform clone and
// `gh pr list`. Nothing is written but the panel's own files under the data
// directory (what the owner last saw, the release alerts the Chief received).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type NowAlert, type NowCi, type NowCiSession, type NowDelivery, type NowGate, type NowOpenPr, type NowPr, type NowPrs, type NowRelease,
  type NowSeen, type NowServerStatus, type NowThroughput, NOW_TICK_MS, nowFingerprint, prUrl,
} from "../shared/now-status.ts";
import { distribution, PRODUCTION_REPO, type ProductivityReport } from "../shared/productivity.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { PsRow } from "./bg-jobs.ts";
import type { GhRunner } from "./productivity-github.ts";
import { clockNear, type ReleaseRun } from "./productivity-release-log.ts";
import { type AdmissionLease, ciOwner, type DeployLease, type ManagedSessionProcs, type QueuedBehindRelease, releaseLabelSha } from "./release-priority.ts";

/** Open PRs are read from GitHub at most this often (one `gh pr list`). */
export const NOW_PRS_EVERY_MS = 3 * 60_000;
/** Durations of this many recent releases make the estimate. */
export const NOW_ESTIMATE_RUNS = 10;
/** The release log is first read this far back (a run writes MBs; its markers are sparse). */
export const NOW_LOG_FIRST_READ = 8 * 1024 * 1024;
/** Release alerts older than this are not "now" anymore, whatever happened since. */
export const NOW_ALERT_MAX_AGE_MS = 48 * 3_600_000;

// ── open PRs (gh pr list) ─────────────────────────────────────────────────

export const GATE_CONTEXT = "nuria/local-merge-gate";
export const OPEN_PRS_ARGS = ["pr", "list", "--repo", PRODUCTION_REPO, "--state", "open", "--base", "main", "--limit", "100", "--json", "number,title,isDraft,mergeStateStatus,createdAt,statusCheckRollup"];

const isoMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/** The gate on a PR's head, from statusCheckRollup: its status context (the receipt when green). */
export function gateOf(rollup: unknown): NowGate {
  if (!Array.isArray(rollup)) return "missing";
  const entry = rollup.find((each) => each && typeof each === "object" && (each as { context?: unknown }).context === GATE_CONTEXT) as { state?: unknown } | undefined;
  const state = typeof entry?.state === "string" ? entry.state.toUpperCase() : null;
  if (state === "SUCCESS") return "success";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  if (state === "FAILURE" || state === "ERROR") return "failure";
  return "missing";
}

/** `gh pr list --json …` → the open PRs, oldest first. Throws on anything that is not that list. */
export function parseOpenPrs(output: string): NowOpenPr[] {
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) throw new Error("gh pr list did not return a list");
  const prs: NowOpenPr[] = [];
  for (const node of value as Array<Record<string, unknown>>) {
    if (typeof node?.number !== "number") continue;
    prs.push({
      number: node.number,
      title: typeof node.title === "string" ? node.title : null,
      url: prUrl(node.number),
      merge: typeof node.mergeStateStatus === "string" ? node.mergeStateStatus.toUpperCase() : "UNKNOWN",
      gate: gateOf(node.statusCheckRollup),
      draft: node.isDraft === true,
      createdAt: isoMs(node.createdAt) ?? 0,
    });
  }
  return prs.sort((a, b) => a.number - b.number);
}

// ── what a release carries (git log, first parent) ────────────────────────

const MERGE = /^Merge pull request #(\d+) from \S+?\/(\S+)/;
const SQUASH = /^(.*\S)\s+\(#(\d+)\)$/;

/** `git log --first-parent --format=%s <production>..<release>` → the PRs it
 * carries, oldest first; release carriers (a merge of a release-carrier
 * branch) are how the code is published, not new work, and are left out. */
export function releasePrsFromGitLog(output: string, titles: (number: number) => string | null = () => null): NowPr[] {
  const prs: NowPr[] = [];
  const seen = new Set<number>();
  for (const subject of output.split("\n").map((line) => line.trim()).filter(Boolean).reverse()) {
    const merge = MERGE.exec(subject);
    if (merge) {
      if (/release-carrier/.test(merge[2]!)) continue;
      const number = Number(merge[1]);
      if (!seen.has(number)) { seen.add(number); prs.push({ number, title: titles(number), url: prUrl(number) }); }
      continue;
    }
    const squash = SQUASH.exec(subject);
    if (squash) {
      const number = Number(squash[2]);
      if (!seen.has(number)) { seen.add(number); prs.push({ number, title: squash[1]!, url: prUrl(number) }); }
    }
  }
  return prs;
}

// ── the release on its way, read from its log ─────────────────────────────

/** What the log says of the newest release run, fed line by line as the log grows. */
export interface ReleaseTailState {
  sha: string | null;
  pid: number | null;
  phase: string | null;
  /** The phase's start: an ISO stamp, or a UTC clock (seconds of the day) to date. */
  phaseIso: number | null;
  phaseClock: number | null;
  /** The first CI step's UTC clock (the start the history measures durations from). */
  firstClock: number | null;
  /** The run said how it ended: released (tag advanced), failed, or ended (left the admission). */
  ended: "released" | "failed" | "ended" | null;
}

export const emptyReleaseTail = (): ReleaseTailState => ({ sha: null, pid: null, phase: null, phaseIso: null, phaseClock: null, firstClock: null, ended: null });

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const T_INTENT = /^ADMISSION_INTENT kind=release label=release:production:([0-9a-f]{40}) pid=(\d+)/;
const T_RELEASED = /^ADMISSION_RELEASED kind=release pid=(\d+)/;
const T_CLOCK = /^\[(\d{2}):(\d{2}):(\d{2})\] ([a-z][\w:-]*)/;
const T_REVIEW = /\*\*Data:\*\*\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/;
const T_DEPLOYING = /\bDeploying \S+\.\.\./;
const T_PURGE = /\bPurging CDN cache/;
const T_CONCLUDED = /Concluido! \(\d+s\)/;
const T_POST = /^POST_RELEASE_RESULT=/;
const T_CERTIFIED = /^Certification tag nuria-production-deployed advanced to ([0-9a-f]{40})/;
const T_FAILED = /^Release production failed for ([0-9a-f]{7,40})/;

/** Feed one line of the release log. Only the run's markers count; the rest is noise. */
export function pushReleaseTail(state: ReleaseTailState, raw: string): void {
  if (!raw || raw.charCodeAt(0) === 64) return; // '@': a workspace's test output
  const line = raw.includes(ESC) ? raw.replace(ANSI, "") : raw;
  const intent = T_INTENT.exec(line);
  if (intent) {
    Object.assign(state, emptyReleaseTail(), { sha: intent[1]!, pid: Number(intent[2]), phase: "queued" });
    return;
  }
  if (!state.sha) return;
  const set = (phase: string, at: { iso?: number; clock?: number } = {}) => {
    state.phase = phase;
    state.phaseIso = at.iso ?? null;
    state.phaseClock = at.clock ?? null;
  };
  const released = T_RELEASED.exec(line);
  if (released) { if (Number(released[1]) === state.pid && !state.ended) state.ended = "ended"; return; }
  if (state.ended) return;
  const clock = T_CLOCK.exec(line);
  if (clock) {
    const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
    if (state.firstClock === null) state.firstClock = seconds;
    set(clock[4]!, { clock: seconds });
    return;
  }
  const review = T_REVIEW.exec(line);
  if (review) { const at = Date.parse(review[1]!); set("review", Number.isFinite(at) ? { iso: at } : {}); return; }
  if (T_DEPLOYING.test(line)) { if (state.phase !== "deploy") set("deploy"); return; }
  if (T_PURGE.test(line)) { set("purge"); return; }
  if (T_CONCLUDED.test(line)) { set("post-release"); return; }
  if (T_POST.test(line)) { set("tag"); return; }
  const certified = T_CERTIFIED.exec(line);
  if (certified) { if (certified[1] === state.sha) state.ended = "released"; return; }
  const failed = T_FAILED.exec(line);
  if (failed && state.sha.startsWith(failed[1]!)) state.ended = "failed";
}

/** Read the log's new bytes since `offset` (the first time: its last NOW_LOG_FIRST_READ),
 * whole lines only. A shorter file (rotated) starts over. */
export function readLogGrowth(path: string, offset: number | null, firstRead = NOW_LOG_FIRST_READ): { text: string; offset: number; restarted: boolean } | null {
  if (!existsSync(path)) return null;
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const restarted = offset === null || size < offset;
    const from = restarted ? Math.max(0, size - firstRead) : offset!;
    if (size <= from) return { text: "", offset: size, restarted };
    const buffer = Buffer.alloc(size - from);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, buffer.length, from);
    let text = buffer.toString("utf8");
    // a partial last line is read again next time; a partial first line (mid-file start) is dropped
    const lastNewline = text.lastIndexOf("\n");
    const consumed = lastNewline < 0 ? 0 : Buffer.byteLength(text.slice(0, lastNewline + 1));
    text = lastNewline < 0 ? "" : text.slice(0, lastNewline);
    if (restarted && from > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, offset: from + consumed, restarted };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The instant a UTC clock reading names, at or before `now` (a run's clock never runs ahead). */
export function clockBefore(seconds: number, now: number): number {
  const at = clockNear(seconds, now);
  return at > now + 60_000 ? at - 86_400_000 : at;
}

/** Median duration (first CI step → deploy finished) of the last releases that reached production. */
export function releaseEstimate(runs: readonly ReleaseRun[], count = NOW_ESTIMATE_RUNS): { ms: number | null; samples: number } {
  const durations = runs
    .filter((run) => run.outcome === "released" && run.timeSource === "log" && run.startedAt !== null && run.endedAt !== null && !run.tagNotAdvanced)
    .sort((a, b) => b.endedAt! - a.endedAt!)
    .map((run) => run.endedAt! - run.startedAt!)
    .filter((ms) => ms >= 5 * 60_000 && ms <= 12 * 3_600_000)
    .slice(0, count);
  const { median, n } = distribution(durations);
  return { ms: median === null ? null : Math.round(median), samples: n };
}

// ── the local CI (admission lease + process table) ────────────────────────

const LOCAL_CI = /(?:^|\/|\s)scripts\/local-ci\.sh(?:\s|$)/;

/** The ci:local now: the one holding the machine (the admission lease, kind
 * ci-*, its owner alive with the start it recorded) and how many wait for it
 * (local-ci.sh processes outside the holder's tree). `rows` null: the
 * process table could not be read. */
export function ciLocalNow(input: {
  lease: AdmissionLease | null | "unreadable";
  leaseSince: number | null;
  rows: readonly PsRow[] | null;
  release: QueuedBehindRelease | null;
  sessions?: readonly ManagedSessionProcs[];
  sessionInfo?: (sessionId: string) => NowCiSession | null;
}): NowCi {
  if (input.lease === "unreadable") return { state: "unknown", queued: null };
  const rows = input.rows;
  const lease = input.lease;
  const byPid = new Map((rows ?? []).map((row) => [row.pid, row]));
  const ownerPid = Number(lease?.ownerPid.trim());
  const isCiLease = Boolean(lease && (lease.kind.trim().startsWith("ci") || (lease.label?.trim() ?? "").startsWith("local-ci:")));
  const ownerRow = byPid.get(ownerPid);
  const recordedStart = lease?.start?.replace(/\s+/g, " ").trim();
  const ownerAlive = rows === null ? isCiLease : Boolean(ownerRow && (!recordedStart || recordedStart === ownerRow.start));
  const running = isCiLease && ownerAlive;
  let queued: number | null = null;
  if (rows) {
    const underOwner = (row: PsRow): boolean => {
      for (let at: PsRow | undefined = row, hops = 0; at && hops < 128; at = byPid.get(at.ppid), hops += 1) if (running && at.pid === ownerPid) return true;
      return false;
    };
    // one per ci:local: the outermost local-ci.sh of each tree
    const ci = rows.filter((row) => LOCAL_CI.test(row.command) && !LOCAL_CI.test(byPid.get(row.ppid)?.command ?? ""));
    queued = ci.filter((row) => !underOwner(row)).length;
  }
  let session: NowCi["session"] = null;
  if (running && rows && input.sessions) {
    const owner = ciOwner(ownerPid, rows, () => null, input.sessions);
    if (owner.kind === "session") session = input.sessionInfo?.(owner.sessionId) ?? null;
    else if (owner.kind === "owner") session = "owner";
  }
  if (running) return { state: "running", label: lease!.label?.trim() || lease!.kind.trim(), since: input.leaseSince, queued, session };
  // nobody holds the machine for a CI: the ones waiting wait for the release, when one is on its way
  if ((queued ?? 0) > 0) return { state: "queued", queued, ...(input.release && !input.release.overdue ? { behindRelease: true } : {}) };
  return { state: rows === null && !lease ? "unknown" : "idle", queued };
}

// ── the aggregate ─────────────────────────────────────────────────────────

const sameSha = (a: string | null | undefined, b: string | null | undefined): boolean => Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));

export interface NowInputs {
  now: number;
  enabled: boolean;
  /** Today's productivity report (São Paulo day), null when the collector is off. */
  report: ProductivityReport | null;
  /** The release history (all runs the collector knows). */
  runs: readonly ReleaseRun[];
  /** The newest run in the live log, as fed so far. */
  tail: ReleaseTailState;
  /** release-priority's releaseInFlight now; "unknown" when the admission state could not be read. */
  inFlight: QueuedBehindRelease | null | "unknown";
  /** When the release in flight started: the deploy lease's or release-started.json's time. */
  releaseStartedAt: number | null;
  /** The PRs the release in flight carries (git); null unknown. */
  releasePrs: NowPr[] | null;
  prs: NowPrs;
  ci: NowCi;
  /** Release alerts the Chief received (recorded), and the commit failing now, if any. */
  alerts: readonly NowAlert[] | null;
}

/** The production commit: the newest release that went live. */
export function productionNow(runs: readonly ReleaseRun[]): { sha: string; at: number } | null {
  const live = runs.filter((run) => run.outcome === "released" && run.endedAt !== null).sort((a, b) => b.endedAt! - a.endedAt!)[0];
  return live ? { sha: live.sha, at: live.endedAt! } : null;
}

/** Today's deliveries from the report (newest first), carriers left out of their PRs. */
export function deliveriesToday(report: ProductivityReport | null): NowDelivery[] | null {
  if (!report || report.kpis.releaseCovered === "none") return null;
  return report.releases
    .filter((release) => release.outcome === "released")
    .sort((a, b) => b.at - a.at)
    .map((release) => ({
      sha: release.sha,
      at: release.at,
      prs: release.contentUnknown ? null : release.prs.filter((pr) => !pr.carrier).map((pr) => ({ number: pr.number, title: pr.title || null, url: prUrl(pr.number) })),
    }));
}

export function throughputToday(report: ProductivityReport | null): NowThroughput {
  if (!report) return { deliveries: null, mergedPrs: null, closedIssues: null, failedReleases: null, syncedAt: null };
  const releaseKnown = report.kpis.releaseCovered !== "none";
  const githubKnown = report.coverage.github.syncedAt !== null;
  return {
    deliveries: releaseKnown ? report.kpis.deliveries : null,
    mergedPrs: githubKnown ? report.kpis.mergedPrs : null,
    closedIssues: githubKnown ? report.kpis.closedIssues : null,
    failedReleases: releaseKnown ? report.kpis.failedReleases : null,
    syncedAt: report.coverage.github.syncedAt,
  };
}

export function buildNowStatus(input: NowInputs): NowServerStatus {
  const live = productionNow(input.runs);
  // the log just said the tag advanced, and the history has not been re-read yet
  const fresh = input.tail.ended === "released" && input.tail.sha && !input.runs.some((run) => run.sha === input.tail.sha && run.outcome === "released") ? input.tail.sha : null;
  const productionSha = fresh ?? live?.sha ?? null;
  const tag = input.report?.coverage.tag ?? { sha: null, checkedAt: null };
  const production = {
    sha: productionSha,
    at: fresh ? null : live?.at ?? null,
    tag: { sha: tag.sha, checkedAt: tag.checkedAt, agrees: tag.sha && productionSha ? sameSha(tag.sha, productionSha) : null },
    today: deliveriesToday(input.report),
  };

  const estimate = releaseEstimate(input.runs);
  let release: NowRelease;
  if (input.inFlight === "unknown") release = { state: "unknown", estimateMs: estimate.ms, samples: estimate.samples };
  else if (!input.inFlight) release = { state: "idle", estimateMs: estimate.ms, samples: estimate.samples };
  else {
    const sha = releaseLabelSha(input.inFlight.label) ?? undefined;
    const tail = sha && input.tail.sha === sha ? input.tail : null;
    // measured like the history: from the first CI step; before it, from the lease
    const firstStep = tail?.firstClock !== null && tail?.firstClock !== undefined ? clockBefore(tail.firstClock, input.now) : null;
    const phaseAt = tail?.phaseIso ?? (tail?.phaseClock !== null && tail?.phaseClock !== undefined ? clockBefore(tail.phaseClock, input.now) : null);
    release = {
      state: input.inFlight.state === "holding" ? "running" : "queued",
      ...(sha ? { sha } : {}),
      startedAt: firstStep ?? input.releaseStartedAt,
      phase: tail?.phase ?? (input.inFlight.state === "queued" ? "queued" : null),
      phaseAt,
      prs: input.releasePrs,
      estimateMs: estimate.ms,
      samples: estimate.samples,
      ...(input.inFlight.overdue ? { overdue: true } : {}),
    };
  }

  // alerts said since production last moved, and none older than two days
  const since = Math.max(production.at ?? 0, input.now - NOW_ALERT_MAX_AGE_MS);
  const alerts = input.alerts === null ? null : [...input.alerts].filter((alert) => alert.at > since).sort((a, b) => b.at - a.at);

  return {
    version: 1,
    generatedAt: input.now,
    enabled: input.enabled,
    production,
    release,
    prs: input.prs,
    ci: input.ci,
    alerts,
    throughput: throughputToday(input.report),
  };
}

// ── the service ───────────────────────────────────────────────────────────

export interface NowDeps {
  dataDir: string;
  enabled: boolean;
  now?: () => number;
  /** Today's report (the collector's, memoized by the minute). */
  report: () => ProductivityReport | null;
  runs: () => readonly ReleaseRun[];
  /** Re-read the release history (after the log says a release ended). */
  refreshLogs: () => Promise<void>;
  outLog: string;
  /** release-started.json (nuria-platform's watcher): {sha, pid} of the release it started, and when. */
  releaseStartedFile: string;
  readLease: () => AdmissionLease | null;
  readDeployLease: () => DeployLease | null;
  /** When the lease was taken (its owner.pid file's time), ms. */
  leaseSince: () => number | null;
  inFlight: (rows: readonly PsRow[]) => QueuedBehindRelease | null;
  ps: () => Promise<PsRow[]>;
  gh: GhRunner;
  git: (args: string[]) => Promise<string>;
  sessions: () => readonly ManagedSessionProcs[];
  sessionInfo: (sessionId: string) => NowCiSession | null;
  /** The commit failing now (releaseFailures), when it failed at least twice. */
  failing: () => { sha: string; count: number } | null;
  onChange?: (status: NowServerStatus) => void;
  log?: (line: string) => void;
}

interface NowFiles { seen: NowSeen | null; alerts: NowAlert[] }

export class NowStatusService {
  private readonly deps: NowDeps;
  private readonly dir: string;
  private readonly now: () => number;
  private tail: ReleaseTailState = emptyReleaseTail();
  private offset: number | null = null;
  private prs: NowPrs = { list: null, checkedAt: null };
  private prsAt = 0;
  private releasePrs: { key: string; prs: NowPr[] | null } | null = null;
  private failingSince: { key: string; at: number } | null = null;
  private files: NowFiles;
  private last: NowServerStatus | null = null;
  private lastFingerprint: string | null = null;
  private running: Promise<NowServerStatus> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: NowDeps) {
    this.deps = deps;
    this.dir = join(deps.dataDir, "now");
    this.now = deps.now ?? Date.now;
    this.files = { seen: this.readJson<NowSeen | null>("seen.json", null, (value) => typeof value?.at === "number" && typeof value.keys === "object"), alerts: this.readJson<NowAlert[]>("alerts.json", [], Array.isArray) };
  }

  private readJson<T>(name: string, fallback: T, valid: (value: any) => boolean): T {
    try {
      const path = join(this.dir, name);
      if (!existsSync(path)) return fallback;
      const value = JSON.parse(readFileSync(path, "utf8"));
      return valid(value) ? value as T : fallback;
    } catch {
      return fallback;
    }
  }

  private save(name: string, value: unknown): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(join(this.dir, name), JSON.stringify(value), { mode: 0o600 });
    } catch (error) {
      this.deps.log?.(`[now] could not save ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), NOW_TICK_MS);
    this.timer.unref?.();
    const first = setTimeout(() => void this.refresh(), 5_000);
    first.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  seen(): NowSeen | null {
    return this.files.seen;
  }

  /** The owner looked: what each line said then (keys bounded, values short). */
  markSeen(keys: Record<string, unknown>): NowSeen {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(keys ?? {}).slice(0, 32)) {
      if (/^[\w-]{1,32}$/.test(key) && typeof value === "string") clean[key] = value.slice(0, 200);
    }
    this.files.seen = { at: this.now(), keys: clean };
    this.save("seen.json", this.files.seen);
    return this.files.seen;
  }

  /** A release alert the Chief just received (release-watch, lot T): kept for the panel. */
  recordAlert(alert: Omit<NowAlert, "key" | "at"> & { key?: string }): void {
    const at = this.now();
    const key = alert.key ?? `alert:${at}`;
    this.files.alerts = [...this.files.alerts.filter((each) => each.key !== key && at - each.at < NOW_ALERT_MAX_AGE_MS), { ...alert, key, at }].slice(-30);
    this.save("alerts.json", this.files.alerts);
    this.lastFingerprint = null;
    void this.refresh();
  }

  /** The last status, or a fresh one when there is none yet. */
  async current(): Promise<NowServerStatus> {
    return this.last ?? this.refresh();
  }

  /** Recompute (concurrent callers share it); tells onChange when something changed. */
  refresh(): Promise<NowServerStatus> {
    if (!this.running) this.running = this.compute().finally(() => { this.running = null; });
    return this.running;
  }

  private async compute(): Promise<NowServerStatus> {
    const now = this.now();
    const deps = this.deps;
    if (deps.enabled) await this.feedLog();
    let rows: PsRow[] | null = null;
    try { rows = deps.enabled ? await deps.ps() : null; } catch { rows = null; }
    let lease: AdmissionLease | null | "unreadable" = null;
    try { lease = deps.readLease(); } catch { lease = "unreadable"; }
    let inFlight: QueuedBehindRelease | null | "unknown" = null;
    try { inFlight = rows ? deps.inFlight(rows) : deps.enabled ? "unknown" : null; } catch { inFlight = "unknown"; }
    const ci = deps.enabled
      ? ciLocalNow({ lease, leaseSince: deps.leaseSince(), rows, release: inFlight === "unknown" ? null : inFlight, sessions: deps.sessions(), sessionInfo: deps.sessionInfo })
      : { state: "idle" as const, queued: null };
    if (deps.enabled) await this.readPrs(now);
    const runs = deps.runs();
    const production = productionNow(runs);
    const releaseSha = inFlight && inFlight !== "unknown" ? releaseLabelSha(inFlight.label) : null;
    const releasePrs = releaseSha && production ? await this.prsOfRelease(production.sha, releaseSha) : null;
    let report: ProductivityReport | null = null;
    try { report = deps.enabled ? deps.report() : null; } catch (error) { deps.log?.(`[now] report: ${error instanceof Error ? error.message : String(error)}`); }
    const failing = deps.enabled ? deps.failing() : null;
    const alerts = [...this.files.alerts];
    if (failing && !alerts.some((alert) => alert.text.includes(failing.sha.slice(0, 9)))) {
      // dated when this server first read it, so the same failure is the same alert every minute
      const key = `failing:${failing.sha}:${failing.count}`;
      if (this.failingSince?.key !== key) this.failingSince = { key, at: now };
      alerts.push({ key, at: this.failingSince.at, text: `release ${failing.sha.slice(0, 9)} falhou ${failing.count}× e não foi publicado` });
    }
    const status = buildNowStatus({
      now, enabled: deps.enabled, report, runs, tail: this.tail, inFlight,
      releaseStartedAt: inFlight && inFlight !== "unknown" ? this.releaseStartedAt(inFlight, releaseSha) : null,
      releasePrs, prs: this.prs, ci, alerts: deps.enabled ? alerts : null,
    });
    this.last = status;
    const fingerprint = nowFingerprint(status);
    if (fingerprint !== this.lastFingerprint) {
      this.lastFingerprint = fingerprint;
      deps.onChange?.(status);
    }
    return status;
  }

  /** Feed what the release log gained; when a run just ended, re-read the history. */
  private async feedLog(): Promise<void> {
    const growth = readLogGrowth(this.deps.outLog, this.offset);
    if (!growth) return;
    const endedBefore = this.tail.ended;
    const shaBefore = this.tail.sha;
    if (growth.restarted) this.tail = emptyReleaseTail();
    this.offset = growth.offset;
    if (growth.text) for (const line of growth.text.split("\n")) pushReleaseTail(this.tail, line);
    if (this.tail.ended && (this.tail.ended !== endedBefore || this.tail.sha !== shaBefore) && !growth.restarted) {
      try { await this.deps.refreshLogs(); } catch (error) { this.deps.log?.(`[now] release history: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  private async readPrs(now: number): Promise<void> {
    if (now - this.prsAt < NOW_PRS_EVERY_MS) return;
    this.prsAt = now;
    try {
      this.prs = { list: parseOpenPrs(await this.deps.gh(OPEN_PRS_ARGS)), checkedAt: now };
    } catch (error) {
      this.prs = { ...this.prs, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
    }
  }

  /** The PRs between production and the release (git, first parent), once per pair. */
  private async prsOfRelease(productionSha: string, releaseSha: string): Promise<NowPr[] | null> {
    const key = `${productionSha}..${releaseSha}`;
    if (this.releasePrs?.key === key) return this.releasePrs.prs;
    let prs: NowPr[] | null = null;
    try {
      const titles = new Map((this.prs.list ?? []).map((pr) => [pr.number, pr.title]));
      prs = releasePrsFromGitLog(await this.deps.git(["log", "--first-parent", "--format=%s", key]), (number) => titles.get(number) ?? null);
    } catch {
      prs = null; // a commit missing in this clone: unknown, asked again on the next pair
    }
    this.releasePrs = { key, prs };
    return prs;
  }

  /** When the release in flight took the deploy, or the watcher started it (release-started.json). */
  private releaseStartedAt(inFlight: QueuedBehindRelease, sha: string | null): number | null {
    const deploy = this.deps.readDeployLease();
    if (deploy?.startedAt && (!sha || releaseLabelSha(deploy.label) === sha)) return deploy.startedAt * 1000;
    try {
      const started = JSON.parse(readFileSync(this.deps.releaseStartedFile, "utf8")) as { sha?: unknown };
      if (typeof started.sha === "string" && sha && sameSha(started.sha, sha)) return statSync(this.deps.releaseStartedFile).mtimeMs;
    } catch { /* not written, or by another release */ }
    return inFlight.ageS !== null ? this.now() - inFlight.ageS * 1000 : null;
  }
}
