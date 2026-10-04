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
  type NowReleaseProfile, type NowSeen, type NowServerStatus, type NowThroughput, alertSubject, NOW_MIN_SAMPLES, NOW_TICK_MS, nowFingerprint, prUrl,
} from "../shared/now-status.ts";
import { distribution, PRODUCTION_REPO, type ProductivityReport } from "../shared/productivity.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { PsRow } from "./bg-jobs.ts";
import type { GhRunner } from "./productivity-github.ts";
import { clockNear, databaseVerdict, type ReleaseRun } from "./productivity-release-log.ts";
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

// The phases a run goes through, in order, as the watcher's log shows them
// (real runs 23a9f93c5, f82d10edb, f9e7a2350 and 3c04d7c3d, 03–04/10):
//
//   queued            ADMISSION_INTENT … until the first CI step
//   build … script-contracts   "[HH:MM:SS] <step>"  (UTC clock: dated)
//   review            "**Data:** <ISO>"                (dated)
//   deploy-check      "=== RELEASE ORQUESTRADO ===" / the first "=== DEPLOY ===" (a dry run)
//   migrations-check  "Banco/migrations: verificacao completa" — every tenant checked
//   migrations        after "[DRY-RUN] … aprovados": the migrations confirmed for real
//   deploy            the second "=== DEPLOY ==="
//   workers           "Deploying <worker>..." (counted, of "Workers a deployar (N)")
//   purge             "Purging CDN cache..."
//   post-release      "Concluido! (Ns)", then "post-release: sample i/5"
//   tag               "POST_RELEASE_RESULT=…" / "Production receipt tag update"
//
// From review on, the log carries no clock: a phase is dated when this server
// read its line live (within one tick); a line read on a cold start, or after
// the server was down, keeps no date ("há —") rather than a wrong one.

/** What the log says of the newest release run, fed line by line as the log grows. */
export interface ReleaseTailState {
  sha: string | null;
  pid: number | null;
  phase: string | null;
  /** The phase's start: an ISO stamp, a UTC clock (seconds of the day) to date, or the instant the line was read live. */
  phaseIso: number | null;
  phaseClock: number | null;
  phaseSeenAt: number | null;
  /** The first CI step's UTC clock (the start the history measures durations from). */
  firstClock: number | null;
  /** Each CI step's clock (seconds of the UTC day), in order: the estimate's anchors. */
  steps: Record<string, number>;
  /** The review report's date: the anchor for every phase after it. */
  reviewIso: number | null;
  /** With migrations or without, as soon as the run says (CI steps, then the deploy's verdict). */
  profile: "migrations" | "light" | null;
  /** "=== DEPLOY ===" seen so far (the first is the dry run). */
  deployPasses: number;
  dryRunDone: boolean;
  workers: { done: number; total: number | null } | null;
  samples: number | null;
  /** The run said how it ended: released (tag advanced), failed, or ended (left the admission). */
  ended: "released" | "failed" | "ended" | null;
  /** When this server read the end live (the tag advanced then, for "released"); null on a cold read. */
  endedSeenAt: number | null;
}

export const emptyReleaseTail = (): ReleaseTailState => ({
  sha: null, pid: null, phase: null, phaseIso: null, phaseClock: null, phaseSeenAt: null, firstClock: null,
  steps: {}, reviewIso: null, profile: null, deployPasses: 0, dryRunDone: false, workers: null, samples: null, ended: null, endedSeenAt: null,
});

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const T_INTENT = /^ADMISSION_INTENT kind=release label=release:production:([0-9a-f]{40}) pid=(\d+)/;
const T_RELEASED = /^ADMISSION_RELEASED kind=release pid=(\d+)/;
const T_CLOCK = /^\[(\d{2}):(\d{2}):(\d{2})\] ([a-z][\w:-]*)/;
const T_REVIEW = /\*\*Data:\*\*\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/;
const T_ORCHESTRATED = /^=== RELEASE ORQUESTRADO ===/;
const T_DEPLOY = /^=== DEPLOY ===/;
const T_DRY_RUN = /\[DRY-RUN\] .*aprovados/;
const T_MIGRATIONS = /\bMigrations (?:globais|tenant) /;
const T_WORKERS = /Workers a deployar \((\d+)\)/;
const T_DEPLOYING = /\bDeploying \S.*\.\.\./;
const T_PURGE = /\bPurging CDN cache/;
const T_CONCLUDED = /Concluido! \(\d+s\)/;
const T_SAMPLE = /^post-release: sample (\d+)\/(\d+)/;
const T_POST = /^POST_RELEASE_RESULT=|Production receipt tag update/;
const T_CERTIFIED = /^Certification tag nuria-production-deployed advanced to ([0-9a-f]{40})/;
const T_FAILED = /^Release production failed for ([0-9a-f]{7,40})/;

/** Feed one line of the release log. Only the run's markers count; the rest is
 * noise. `seenAt`: when this server read the line live (null on a cold read). */
export function pushReleaseTail(state: ReleaseTailState, raw: string, seenAt: number | null = null): void {
  if (!raw || raw.charCodeAt(0) === 64) return; // '@': a workspace's test output
  const line = raw.includes(ESC) ? raw.replace(ANSI, "") : raw;
  const intent = T_INTENT.exec(line);
  if (intent) {
    Object.assign(state, emptyReleaseTail(), { sha: intent[1]!, pid: Number(intent[2]), phase: "queued", phaseSeenAt: seenAt });
    return;
  }
  if (!state.sha) return;
  // a phase starts once: repeated markers of the same phase keep its first moment
  const set = (phase: string, at: { iso?: number; clock?: number } = {}) => {
    if (state.phase === phase) return;
    state.phase = phase;
    state.phaseIso = at.iso ?? null;
    state.phaseClock = at.clock ?? null;
    state.phaseSeenAt = at.iso === undefined && at.clock === undefined ? seenAt : null;
  };
  const released = T_RELEASED.exec(line);
  if (released) { if (Number(released[1]) === state.pid && !state.ended) { state.ended = "ended"; state.endedSeenAt = seenAt; } return; }
  if (state.ended) return;
  const clock = T_CLOCK.exec(line);
  if (clock) {
    const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
    const step = clock[4]!;
    if (state.firstClock === null) state.firstClock = seconds;
    if (!(step in state.steps)) state.steps[step] = seconds;
    // the CI says the profile before the deploy does: migration-lint, or script-contracts without it
    if (state.profile === null) state.profile = step === "migration-lint" ? "migrations" : step === "script-contracts" ? "light" : null;
    set(step, { clock: seconds });
    return;
  }
  const review = T_REVIEW.exec(line);
  if (review) {
    const at = Date.parse(review[1]!);
    if (Number.isFinite(at)) state.reviewIso = at;
    set("review", Number.isFinite(at) ? { iso: at } : {});
    return;
  }
  const database = databaseVerdict(line);
  if (database) {
    // the deploy's own verdict decides (it is what makes the run take 3 h or 45 min)
    state.profile = database;
    if (database === "migrations") set("migrations-check");
    return;
  }
  if (T_ORCHESTRATED.test(line)) { set("deploy-check"); return; }
  if (T_DEPLOY.test(line)) {
    state.deployPasses += 1;
    set(state.deployPasses === 1 ? "deploy-check" : "deploy");
    return;
  }
  if (T_DRY_RUN.test(line)) { state.dryRunDone = true; return; }
  if (T_MIGRATIONS.test(line)) {
    if (state.dryRunDone && state.deployPasses === 1) set("migrations");
    return;
  }
  const workers = T_WORKERS.exec(line);
  if (workers) { if (state.deployPasses >= 2) state.workers = { done: state.workers?.done ?? 0, total: Number(workers[1]) || null }; return; }
  if (T_DEPLOYING.test(line)) {
    state.workers = { done: (state.workers?.done ?? 0) + 1, total: state.workers?.total ?? null };
    set("workers");
    return;
  }
  if (T_PURGE.test(line)) { set("purge"); return; }
  if (T_CONCLUDED.test(line)) { set("post-release"); return; }
  const sample = T_SAMPLE.exec(line);
  if (sample) { state.samples = Number(sample[1]); set("post-release"); return; }
  if (T_POST.test(line)) { set("tag"); return; }
  const certified = T_CERTIFIED.exec(line);
  if (certified) { if (certified[1] === state.sha) { state.ended = "released"; state.endedSeenAt = seenAt; } return; }
  const failed = T_FAILED.exec(line);
  if (failed && state.sha.startsWith(failed[1]!)) { state.ended = "failed"; state.endedSeenAt = seenAt; }
}

/** When the current phase started, if known: its clock or ISO stamp, or the moment it was read live. */
export function phaseStartedAt(state: ReleaseTailState, now: number): number | null {
  if (state.phaseIso !== null) return state.phaseIso;
  if (state.phaseClock !== null) return clockBefore(state.phaseClock, now);
  return state.phaseSeenAt;
}

/** What a phase counts: workers deployed (of N), post-release samples (of 5). */
export function phaseProgress(state: ReleaseTailState): { done: number; total: number | null } | null {
  if (state.phase === "workers" && state.workers) return { done: state.workers.done, total: state.workers.total && state.workers.total >= state.workers.done ? state.workers.total : null };
  if (state.phase === "post-release" && state.samples !== null) return { done: state.samples, total: 5 };
  return null;
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

/** The last releases of one profile that reached production, as the history measured them (newest first). */
export function comparableRuns(runs: readonly ReleaseRun[], profile: NowReleaseProfile, count = NOW_ESTIMATE_RUNS): ReleaseRun[] {
  return runs
    .filter((run) => run.outcome === "released" && run.timeSource === "log" && !run.tagNotAdvanced && run.profile === profile
      && run.startedAt !== null && run.endedAt !== null && run.endedAt - run.startedAt >= 5 * 60_000 && run.endedAt - run.startedAt <= 12 * 3_600_000)
    .sort((a, b) => b.endedAt! - a.endedAt!)
    .slice(0, count);
}

const medianOf = (values: number[]): { ms: number | null; samples: number } => {
  const { median, n } = distribution(values);
  return { ms: n >= NOW_MIN_SAMPLES && median !== null ? Math.round(median) : null, samples: n };
};

/** Each profile's median duration (first CI step → deploy finished); null below NOW_MIN_SAMPLES releases. */
export function profileMedians(runs: readonly ReleaseRun[]): Record<NowReleaseProfile, { ms: number | null; samples: number }> {
  const of = (profile: NowReleaseProfile) => medianOf(comparableRuns(runs, profile).map((run) => run.endedAt! - run.startedAt!));
  return { migrations: of("migrations"), light: of("light") };
}

/** The estimate for the run in the log, from the releases of ITS profile only: the
 * typical time from the current phase's anchor (its CI step, or the review report
 * for everything after it, or the start while queued) to the deploy's end, minus
 * what already passed since that anchor in this run. Unknown profile, or fewer than
 * NOW_MIN_SAMPLES comparable releases carrying that anchor: no estimate. */
export function releaseEstimateNow(runs: readonly ReleaseRun[], tail: ReleaseTailState, now: number): { profile: NowReleaseProfile | null; estimateMs: number | null; remainingMs: number | null; samples: number } {
  const profile = tail.profile;
  if (!profile) return { profile: null, estimateMs: null, remainingMs: null, samples: 0 };
  const comparable = comparableRuns(runs, profile);
  const total = medianOf(comparable.map((run) => run.endedAt! - run.startedAt!));
  let anchorNow: number;
  let anchorOf: (run: ReleaseRun) => number | undefined;
  const lastStep = Object.keys(tail.steps).at(-1);
  if (tail.reviewIso !== null) {
    anchorNow = tail.reviewIso;
    anchorOf = (run) => run.reviewAt;
  } else if (lastStep) {
    anchorNow = clockBefore(tail.steps[lastStep]!, now);
    anchorOf = (run) => run.steps?.[lastStep];
  } else {
    anchorNow = now;
    anchorOf = (run) => run.startedAt ?? undefined;
  }
  const rest = comparable.flatMap((run) => { const at = anchorOf(run); return at === undefined ? [] : [run.endedAt! - at]; });
  const typical = medianOf(rest);
  return {
    profile,
    estimateMs: total.ms,
    remainingMs: typical.ms === null ? null : typical.ms - (now - anchorNow),
    samples: typical.samples,
  };
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
  /** The tag as this server read it (git ls-remote): right after a release ends, then every few minutes. */
  tagRead?: { sha: string | null; checkedAt: number } | null;
  /** The commit the owner declined to publish (declined-production-release.sha), if any. */
  declined?: string | null;
}

/** A tag read is trusted to judge production only after the tag could have moved:
 * after the log said the tag advanced (read live), or — when that moment is not
 * known — 15 min after the deploy ended (release-watch's TAG_STUCK_AFTER_MS). */
export const TAG_SETTLE_MS = 15 * 60_000;

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
  const productionAt = fresh ? null : live?.at ?? null;
  // the newest tag reading (the GitHub sync's, or this server's ls-remote), judged only once the tag could have moved
  const reads = [input.report?.coverage.tag, input.tagRead].filter((read): read is { sha: string | null; checkedAt: number } => Boolean(read && read.checkedAt !== null));
  const tag = reads.sort((a, b) => b.checkedAt - a.checkedAt)[0] ?? { sha: null, checkedAt: null };
  const certifiedSeen = input.tail.ended === "released" && sameSha(input.tail.sha, productionSha) ? input.tail.endedSeenAt : null;
  const settledAfter = certifiedSeen ?? (productionAt !== null ? productionAt + TAG_SETTLE_MS : null);
  const judged = tag.sha !== null && tag.checkedAt !== null && productionSha !== null && settledAfter !== null && tag.checkedAt >= settledAfter;
  const production = {
    sha: productionSha,
    at: productionAt,
    tag: { sha: tag.sha, checkedAt: tag.checkedAt, agrees: judged ? sameSha(tag.sha, productionSha) : null },
    today: deliveriesToday(input.report),
  };

  const profiles = profileMedians(input.runs);
  let release: NowRelease;
  if (input.inFlight === "unknown") release = { state: "unknown", estimateMs: null, samples: 0, profiles };
  else if (!input.inFlight) release = { state: "idle", estimateMs: null, samples: 0, profiles };
  else {
    const sha = releaseLabelSha(input.inFlight.label) ?? undefined;
    const tail = sha && input.tail.sha === sha ? input.tail : null;
    // measured like the history: from the first CI step; before it, from the lease
    const firstStep = tail?.firstClock !== null && tail?.firstClock !== undefined ? clockBefore(tail.firstClock, input.now) : null;
    const estimate = tail ? releaseEstimateNow(input.runs, tail, input.now) : { profile: null, estimateMs: null, remainingMs: null, samples: 0 };
    release = {
      state: input.inFlight.state === "holding" ? "running" : "queued",
      ...(sha ? { sha } : {}),
      startedAt: firstStep ?? input.releaseStartedAt,
      phase: tail?.phase ?? (input.inFlight.state === "queued" ? "queued" : null),
      phaseAt: tail ? phaseStartedAt(tail, input.now) : null,
      progress: tail ? phaseProgress(tail) : null,
      prs: input.releasePrs,
      profile: estimate.profile,
      estimateMs: estimate.estimateMs,
      remainingMs: estimate.remainingMs,
      samples: estimate.samples,
      ...(input.inFlight.overdue ? { overdue: true } : {}),
    };
  }

  // alerts said since production last moved, none older than two days, and none whose
  // commit is settled: declined by the owner, released, in production or under the tag
  const since = Math.max(production.at ?? 0, input.now - NOW_ALERT_MAX_AGE_MS);
  const declined = input.declined?.trim() || null;
  const settled = (alert: NowAlert): boolean => {
    const sha = alert.sha;
    if (!sha) return false;
    // the tag stuck behind production: settled only when a trusted reading has the tag on that commit
    if (alert.kind === "tag") return judged && sameSha(sha, tag.sha);
    return sameSha(sha, declined) || sameSha(sha, productionSha) || input.runs.some((run) => run.outcome === "released" && sameSha(run.sha, sha));
  };
  const alerts = input.alerts === null ? null : [...input.alerts].filter((alert) => alert.at > since && !settled(alert)).sort((a, b) => b.at - a.at);

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
  /** The commit failing now (releaseFailures), when it failed at least twice, and when it last
   * failed (the watcher's last-failure file, or its err log): the time of the event, not of the read. */
  failing: () => { sha: string; count: number; at: number | null } | null;
  /** The production tag on the remote now (git ls-remote, no fetch); throws or null when unreadable. */
  readTag: () => Promise<string | null>;
  /** The commit the owner declined to publish, if any. */
  declined: () => string | null;
  onChange?: (status: NowServerStatus) => void;
  log?: (line: string) => void;
}

interface NowFiles { seen: NowSeen | null; alerts: NowAlert[] }

/** After the log says a release ended, the tag is read again this much later (the push settles first). */
export const TAG_REREAD_AFTER_MS = 60_000;
/** A failed `git log` of the release's range is asked again after this, not kept for the whole release. */
export const GIT_RETRY_MS = 2 * 60_000;

export class NowStatusService {
  private readonly deps: NowDeps;
  private readonly dir: string;
  private readonly now: () => number;
  private tail: ReleaseTailState = emptyReleaseTail();
  private offset: number | null = null;
  private prs: NowPrs = { list: null, checkedAt: null };
  private prsAt = 0;
  private releasePrs: { key: string; prs: NowPr[] | null; retryAt?: number } | null = null;
  private githubRead: Promise<void> | null = null;
  private tagRead: { sha: string | null; checkedAt: number } | null = null;
  private tagDueAt: number | null = null;
  /** The first read after a boot is cold: what the log gained while this server was down has no live date. */
  private cold = true;
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
    // where the log was read up to, and the run's phases with their live dates: a restart keeps them
    const saved = this.readJson<{ offset: number; tail: Partial<ReleaseTailState> } | null>("tail.json", null, (value) => typeof value?.offset === "number" && typeof value.tail === "object");
    if (saved) {
      this.offset = saved.offset;
      this.tail = { ...emptyReleaseTail(), ...saved.tail };
    }
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

  /** A release alert the Chief just received (release-watch, lot T): kept for the panel, one per
   * subject (the same commit's next alert replaces it), with what settles it. */
  recordAlert(alert: Omit<NowAlert, "key" | "at" | "sha" | "kind"> & { key?: string }): void {
    const at = this.now();
    const subject = alertSubject(alert.text);
    const key = alert.key ?? (subject.sha ? `${subject.kind}:${subject.sha}` : `text:${alert.text.slice(0, 80)}`);
    this.files.alerts = [...this.files.alerts.filter((each) => each.key !== key && at - each.at < NOW_ALERT_MAX_AGE_MS), { ...alert, ...subject, key, at }].slice(-30);
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
    // GitHub and the remote tag are read off this path: the panel never waits on them
    if (deps.enabled) this.readGithub(now);
    const runs = deps.runs();
    const production = productionNow(runs);
    const releaseSha = inFlight && inFlight !== "unknown" ? releaseLabelSha(inFlight.label) : null;
    const releasePrs = releaseSha && production ? await this.prsOfRelease(production.sha, releaseSha, now) : null;
    let report: ProductivityReport | null = null;
    try { report = deps.enabled ? deps.report() : null; } catch (error) { deps.log?.(`[now] report: ${error instanceof Error ? error.message : String(error)}`); }
    const failing = deps.enabled ? deps.failing() : null;
    const alerts = [...this.files.alerts];
    // read from the watcher's log (the Chief may not have been told yet): dated by the failure
    // itself — its run's end in the history, else the watcher's own file — never by this read
    const failedAt = failing ? runs.filter((run) => run.outcome === "failed" && run.endedAt !== null && sameSha(run.sha, failing.sha)).reduce<number | null>((max, run) => Math.max(max ?? 0, run.endedAt!), null) ?? failing.at : null;
    if (failing && failedAt !== null && !alerts.some((alert) => alert.sha && sameSha(alert.sha, failing.sha))) {
      alerts.push({ key: `failing:${failing.sha}:${failing.count}`, at: failedAt, sha: failing.sha, kind: "release", text: `Release ${failing.sha.slice(0, 9)} falhou ${failing.count}× seguidas — não está em produção (log do watcher)` });
    }
    let declined: string | null = null;
    try { declined = deps.enabled ? deps.declined() : null; } catch { declined = null; }
    const status = buildNowStatus({
      now, enabled: deps.enabled, report, runs, tail: this.tail, inFlight,
      releaseStartedAt: inFlight && inFlight !== "unknown" ? this.releaseStartedAt(inFlight, releaseSha) : null,
      releasePrs, prs: this.prs, ci, alerts: deps.enabled ? alerts : null, tagRead: this.tagRead, declined,
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
    // lines read live are dated now; a cold read (boot, rotation) dates nothing it cannot know
    const seenAt = growth.restarted || this.cold ? null : this.now();
    this.cold = false;
    if (growth.text) for (const line of growth.text.split("\n")) pushReleaseTail(this.tail, line, seenAt);
    if (growth.text || growth.restarted) this.save("tail.json", { offset: this.offset, tail: this.tail });
    if (this.tail.ended && (this.tail.ended !== endedBefore || this.tail.sha !== shaBefore) && !growth.restarted) {
      // the tag is read again a minute after a release ends; until then it is "a conferir", never "diverge"
      this.tagDueAt = this.now() + TAG_REREAD_AFTER_MS;
      try { await this.deps.refreshLogs(); } catch (error) { this.deps.log?.(`[now] release history: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /** Open PRs (every NOW_PRS_EVERY_MS) and the remote tag (then, and a minute after a release
   * ends), in the background; the next status carries them. */
  private readGithub(now: number): void {
    const prsDue = now - this.prsAt >= NOW_PRS_EVERY_MS;
    const tagDue = prsDue || (this.tagDueAt !== null && now >= this.tagDueAt);
    if (this.githubRead || (!prsDue && !tagDue)) return;
    if (prsDue) this.prsAt = now;
    if (tagDue) this.tagDueAt = null;
    this.githubRead = (async () => {
      if (prsDue) {
        try {
          this.prs = { list: parseOpenPrs(await this.deps.gh(OPEN_PRS_ARGS)), checkedAt: this.now() };
        } catch (error) {
          this.prs = { ...this.prs, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
        }
      }
      if (tagDue) {
        try {
          const sha = await this.deps.readTag();
          if (sha) this.tagRead = { sha, checkedAt: this.now() };
        } catch { /* unreadable: the last reading stands, judged by its own time */ }
      }
    })().finally(() => {
      this.githubRead = null;
      void this.refresh();
    });
  }

  /** The PRs between production and the release (git, first parent), once per pair; a failure is asked again in GIT_RETRY_MS. */
  private async prsOfRelease(productionSha: string, releaseSha: string, now: number): Promise<NowPr[] | null> {
    const key = `${productionSha}..${releaseSha}`;
    if (this.releasePrs?.key === key && (this.releasePrs.prs !== null || now < (this.releasePrs.retryAt ?? 0))) return this.releasePrs.prs;
    try {
      const titles = new Map((this.prs.list ?? []).map((pr) => [pr.number, pr.title]));
      const prs = releasePrsFromGitLog(await this.deps.git(["log", "--first-parent", "--format=%s", key]), (number) => titles.get(number) ?? null);
      this.releasePrs = { key, prs };
      return prs;
    } catch {
      // a timeout, or a commit not in this clone yet: unknown for now, asked again soon
      this.releasePrs = { key, prs: null, retryAt: now + GIT_RETRY_MS };
      return null;
    }
  }

  /** Wait for a background GitHub read (tests). */
  async settled(): Promise<void> {
    while (this.githubRead || this.running) await (this.githubRead ?? this.running);
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
