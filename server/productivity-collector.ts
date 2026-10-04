// The productivity report's collector (lot V): keeps a cache under
// <data>/productivity/ and refreshes it in the background — the release log
// (re-read only when a file changed; the rotated .gz once), GitHub through
// `gh` (incremental, paginated, stopping before the rate limit), and the
// "Precisa de você" items. A report request never waits on GitHub: it is
// built from whatever the cache holds, with the sync's state beside it.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { previousPeriod, sanitizeGoals, type Granularity, type ProductivityReport, type ReportGoals, type ReportPeriod, type ReportSyncState } from "../shared/productivity.ts";
import { writeFileAtomic } from "./atomic.ts";
import { emptyGhCache, execGh, GH_CACHE_VERSION, migrateGhCache, RateLimited, syncCompares, syncGithub, type GhCache, type GhRunner, type SyncProgress } from "./productivity-github.ts";
import { emptyNeedsYouLog, mergeNeedsYou, type NeedsYouLog } from "./productivity-local.ts";
import { readFile } from "node:fs/promises";
import {
  applyLiveWithoutTag, emptyReleaseLogState, feedReleaseLogFile, fileSignature, finishReleaseLog, liveWithoutTagShas, sameSignature,
  type DeclineEvent, type FileSignature, type ReleaseLogState, type ReleaseRun,
} from "./productivity-release-log.ts";
import { buildProductivityReport, releasePairs, type UsageLike } from "./productivity-report.ts";

export const SYNC_INTERVAL_MS = 15 * 60_000;
/** A request may ask for a fresh sync at most this often. */
export const MANUAL_SYNC_MIN_MS = 60_000;

interface PendingLike { id: string; botId: string; createdAt: number; history?: Array<{ at: number; by?: string }> }
interface ResolvedLike extends PendingLike { resolvedAt: number; resolvedBy: "owner" | "bot" | "server" }

export interface CollectorDeps {
  dataDir: string;
  gh?: GhRunner;
  now?: () => number;
  /** The watcher's out log (and its rotated .gz) and its err log (read for "live without the tag"). */
  logs: { gz: string; out: string; err?: string };
  ownerPending: () => { open: readonly PendingLike[]; resolved: readonly ResolvedLike[] };
  botNames: () => ReadonlyMap<string, string>;
  usage: (range: { from: Date; to: Date }) => readonly UsageLike[];
  digests: (from: number, to: number) => ReadonlyArray<{ botId: string; at: number; durationMs: number | null }>;
  oldestDigestAt: () => number | null;
  /** Oldest month file of the usage ledger, as an instant. */
  usageFrom: () => number | null;
  log?: (line: string) => void;
}

/** Bumped when the release log's reading changes (v2: superseded/aborted runs,
 * the head PR, the post-release verdict). An older history is reparsed from
 * the logs still on disk; runs only it remembers (rotated away) are kept. */
export const RELEASES_VERSION = 2;

interface ReleaseHistory {
  version: number;
  runs: Record<string, ReleaseRun>;
  declines: Record<string, DeclineEvent>;
  coverage: { from: number | null; to: number | null };
  /** Commits the err log says went live without the tag advancing. */
  liveWithoutTag?: string[];
}

const emptyHistory = (): ReleaseHistory => ({ version: RELEASES_VERSION, runs: {}, declines: {}, coverage: { from: null, to: null } });

/** A run saved by an older reading: the field names of today, and a run that
 * never ran (no time of its own, no verdict) is not a failure. */
export function migrateRun(run: ReleaseRun & { carrierPr?: number }): ReleaseRun {
  const { carrierPr, ...rest } = run;
  const migrated: ReleaseRun = { ...rest, ...(carrierPr && !rest.headPr ? { headPr: carrierPr } : {}) };
  if (migrated.outcome === "failed" && migrated.timeSource === "neighbor" && migrated.deployedAt === undefined) {
    return migrated.cause ? { ...migrated, outcome: "aborted" } : { ...migrated, outcome: "superseded" };
  }
  return migrated;
}

function readJson<T>(path: string, fallback: () => T, valid: (value: any) => boolean): T {
  try {
    if (!existsSync(path)) return fallback();
    const value = JSON.parse(readFileSync(path, "utf8"));
    return valid(value) ? value as T : fallback();
  } catch {
    return fallback();
  }
}

export class ProductivityCollector {
  private readonly deps: CollectorDeps;
  private readonly dir: string;
  private readonly gh: GhRunner;
  private readonly now: () => number;
  private github: GhCache;
  private history: ReleaseHistory;
  private needsYou: NeedsYouLog;
  /** Parser state after the rotated .gz, so the live file is replayed on top of it. */
  private gzParsed: { signature: FileSignature; state: ReleaseLogState } | null = null;
  private outSignature: FileSignature | null = null;
  private errSignature: FileSignature | null = null;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sync: ReportSyncState = { state: "idle", lastSyncAt: null, lastAttemptAt: null, nextSyncAt: null, error: null, rateLimit: null };
  private goals: ReportGoals = {};
  /** Reports already built for the current data (cleared whenever it changes). */
  private readonly memo = new Map<string, ProductivityReport>();
  private dataStamp = 0;

  constructor(deps: CollectorDeps) {
    this.deps = deps;
    this.dir = join(deps.dataDir, "productivity");
    this.gh = deps.gh ?? execGh;
    this.now = deps.now ?? Date.now;
    const savedGithub = readJson(join(this.dir, "github.json"), () => emptyGhCache(), (value) => typeof value?.version === "number" && typeof value.prs === "object" && typeof value.issues === "object");
    const github = migrateGhCache(savedGithub);
    this.github = github.cache;
    if (github.migrated) {
      deps.log?.(`[productivity] GitHub cache v${savedGithub.version} → v${GH_CACHE_VERSION}: walks restart, stale deployments re-read`);
      this.save("github.json", this.github);
    }
    const savedHistory = readJson(join(this.dir, "releases.json"), emptyHistory, (value) => typeof value?.version === "number" && typeof value.runs === "object");
    this.history = savedHistory.version === RELEASES_VERSION ? savedHistory : {
      ...savedHistory,
      version: RELEASES_VERSION,
      runs: Object.fromEntries(Object.entries(savedHistory.runs).map(([key, run]) => [key, migrateRun(run)])),
    };
    this.needsYou = readJson(join(this.dir, "needs-you.json"), emptyNeedsYouLog, (value) => value?.version === 1 && typeof value.items === "object");
    this.goals = sanitizeGoals(readJson(join(this.dir, "goals.json"), () => ({}), (value) => typeof value === "object" && value !== null));
    this.sync.lastSyncAt = this.github.syncedAt;
  }

  /** The owner's targets (empty by default). */
  getGoals(): ReportGoals {
    return { ...this.goals };
  }

  setGoals(raw: unknown): ReportGoals {
    this.goals = sanitizeGoals(raw);
    this.save("goals.json", this.goals);
    this.memo.clear();
    return this.getGoals();
  }

  /** Sync now and then every SYNC_INTERVAL_MS, off the request path. */
  start(firstDelayMs = 20_000): void {
    if (this.timer) return;
    const first = setTimeout(() => void this.refresh(), firstDelayMs);
    first.unref?.();
    this.timer = setInterval(() => void this.refresh(), SYNC_INTERVAL_MS);
    this.timer.unref?.();
    this.sync.nextSyncAt = this.now() + firstDelayMs;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(): ReportSyncState {
    return { ...this.sync, ...(this.sync.rateLimit ? { rateLimit: { ...this.sync.rateLimit } } : {}) };
  }

  /** Ask for a sync (the screen's "Atualizar"); ignored while one runs or one just ran. */
  requestSync(): boolean {
    if (this.inflight) return false;
    if (this.sync.lastAttemptAt !== null && this.now() - this.sync.lastAttemptAt < MANUAL_SYNC_MIN_MS) return false;
    if (this.sync.state === "rate-limited" && this.sync.rateLimit && this.now() < this.sync.rateLimit.resetAt) return false;
    void this.refresh();
    return true;
  }

  /** One full refresh; concurrent callers share it. */
  refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.runSync().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private save(name: string, value: unknown): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(join(this.dir, name), JSON.stringify(value), { mode: 0o600 });
    } catch (error) {
      this.deps.log?.(`[productivity] could not save ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Re-read the release log when one of its files changed. */
  async refreshLogs(): Promise<void> {
    const gz = fileSignature(this.deps.logs.gz);
    const out = fileSignature(this.deps.logs.out);
    if (gz && !sameSignature(gz, this.gzParsed?.signature)) {
      const state = emptyReleaseLogState();
      await feedReleaseLogFile(state, gz.path);
      // the live file changed meaning: it is replayed on the new base below
      this.gzParsed = { signature: gz, state };
      this.outSignature = null;
    } else if (!gz) {
      this.gzParsed = null;
    }
    const err = this.deps.logs.err ? fileSignature(this.deps.logs.err) : null;
    if (out && sameSignature(out, this.outSignature) && sameSignature(err, this.errSignature) && this.gzParsed?.signature && sameSignature(gz, this.gzParsed.signature)) return;
    const state: ReleaseLogState = this.gzParsed ? structuredClone(this.gzParsed.state) : emptyReleaseLogState();
    if (out) await feedReleaseLogFile(state, out.path);
    const parsed = finishReleaseLog(state, { endOfStream: true });
    // deploys that went live while the tag push was refused (err log only), kept across its truncation
    const liveWithoutTag = new Set(this.history.liveWithoutTag ?? []);
    if (err) for (const sha of liveWithoutTagShas(await readFile(err.path, "utf8"))) liveWithoutTag.add(sha);
    const parsedKeys = new Set(parsed.runs.map((run) => run.key));
    const merged = [...Object.values(this.history.runs).filter((run) => !parsedKeys.has(run.key)), ...parsed.runs];
    const runs: Record<string, ReleaseRun> = {};
    for (const run of applyLiveWithoutTag(merged, liveWithoutTag)) runs[run.key] = run;
    // a run seen running before and gone from the files now (rotated away mid-run) is not left running
    for (const [key, run] of Object.entries(runs)) {
      if (run.outcome === "running" && !parsed.runs.some((each) => each.key === key)) runs[key] = { ...run, outcome: "failed", interrupted: true };
    }
    const declines = { ...this.history.declines };
    for (const decline of parsed.declines) if (!declines[decline.sha]) declines[decline.sha] = decline;
    const from = [this.history.coverage.from, parsed.from].filter((value): value is number => value !== null);
    const to = [this.history.coverage.to, parsed.to].filter((value): value is number => value !== null);
    this.history = { version: RELEASES_VERSION, runs, declines, coverage: { from: from.length ? Math.min(...from) : null, to: to.length ? Math.max(...to) : null }, liveWithoutTag: [...liveWithoutTag] };
    this.outSignature = out;
    this.errSignature = err;
    this.save("releases.json", this.history);
    this.touch();
  }

  private snapshotNeedsYou(): void {
    try {
      const { open, resolved } = this.deps.ownerPending();
      this.needsYou = mergeNeedsYou(this.needsYou, { open, resolved, now: this.now() });
      this.save("needs-you.json", this.needsYou);
      this.touch();
    } catch (error) {
      this.deps.log?.(`[productivity] needs-you snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async runSync(): Promise<void> {
    const started = this.now();
    this.sync = { ...this.sync, state: "syncing", lastAttemptAt: started, error: null, phase: "release-log" };
    try {
      await this.refreshLogs();
    } catch (error) {
      this.deps.log?.(`[productivity] release log: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.snapshotNeedsYou();
    const progress: SyncProgress = { phase: "github", pages: 0, rateRemaining: null, rateResetAt: null };
    const pairsNow = () => releasePairs({ runs: Object.values(this.history.runs), github: this.github, logCoverage: this.history.coverage, now: this.now() });
    const onPhase = (phase: string) => { this.sync = { ...this.sync, phase }; };
    try {
      await syncGithub({ gh: this.gh, cache: this.github, now: started, progress, onPhase });
      // the deployments just read can add release ranges: their contents come after
      await syncCompares({ gh: this.gh, cache: this.github, pairs: pairsNow(), onPhase });
      this.sync = { state: "idle", lastSyncAt: this.now(), lastAttemptAt: started, nextSyncAt: started + SYNC_INTERVAL_MS, error: null, rateLimit: progress.rateRemaining !== null ? { remaining: progress.rateRemaining, resetAt: progress.rateResetAt ?? 0 } : null };
    } catch (error) {
      if (error instanceof RateLimited) {
        this.sync = { ...this.sync, state: "rate-limited", nextSyncAt: Math.max(error.resetAt, started + 60_000), error: null, rateLimit: { remaining: progress.rateRemaining ?? 0, resetAt: error.resetAt } };
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log?.(`[productivity] GitHub sync failed: ${message}`);
        this.sync = { ...this.sync, state: "error", error: message.slice(0, 300), nextSyncAt: started + SYNC_INTERVAL_MS };
      }
    } finally {
      delete this.sync.phase;
      this.save("github.json", this.github);
      this.touch();
    }
  }

  /** Every release run the history holds, as read (the "Agora" panel's production and estimate). */
  releaseRuns(): ReleaseRun[] {
    return Object.values(this.history.runs);
  }

  /** What the delivery board (lot Z) reads from the cache as it is now:
   * GitHub (null until the first sync), the release runs and how far the log
   * was read, and a stamp that changes whenever any of it does. Read-only. */
  boardSource(): { github: GhCache | null; runs: ReleaseRun[]; logCoverage: { from: number | null; to: number | null }; stamp: number } {
    return {
      github: this.github.syncedAt === null ? null : this.github,
      runs: Object.values(this.history.runs),
      logCoverage: { ...this.history.coverage },
      stamp: this.dataStamp,
    };
  }

  /** The data changed: reports built before are stale. */
  private touch(): void {
    this.dataStamp += 1;
    this.memo.clear();
  }

  /** The report for a period, from the cache as it is now. */
  report(granularity: Granularity, period: ReportPeriod): ProductivityReport {
    // the same question on the same data within the same minute is answered once
    const key = `${granularity}:${period.from}:${period.to}:${this.dataStamp}:${Math.floor(this.now() / 60_000)}`;
    const known = this.memo.get(key);
    if (known) return { ...known, sync: this.state() };
    const report = this.build(granularity, period);
    if (this.memo.size > 16) this.memo.clear();
    this.memo.set(key, report);
    return report;
  }

  private build(granularity: Granularity, period: ReportPeriod): ProductivityReport {
    const previous = previousPeriod(period, granularity);
    const from = previous.from;
    const to = period.to;
    const usage = this.deps.usage({ from: new Date(from), to: new Date(to) });
    let digests: ReadonlyArray<{ botId: string; at: number; durationMs: number | null }> = [];
    let digestsFrom: number | null = null;
    try {
      digests = this.deps.digests(from, to);
      digestsFrom = this.deps.oldestDigestAt();
    } catch (error) {
      this.deps.log?.(`[productivity] digests: ${error instanceof Error ? error.message : String(error)}`);
    }
    const needsYou = Object.values(this.needsYou.items);
    return buildProductivityReport({
      granularity, period, now: this.now(), github: this.github,
      runs: Object.values(this.history.runs), declines: Object.values(this.history.declines), logCoverage: this.history.coverage,
      usage, digests, needsYou, botNames: this.deps.botNames(),
      local: {
        usageFrom: this.deps.usageFrom(),
        digestsFrom,
        // items are recorded from the log's first look on; earlier ones are not known
        needsYouFrom: this.needsYou.startedAt,
      },
      sync: this.state(),
      goals: this.goals,
    });
  }
}

/** The oldest turn the usage ledger holds (its first month file's earliest row). */
export function oldestUsageAt(dataDir: string): number | null {
  try {
    const dir = join(dataDir, "usage");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
    const first = readdirSync(dir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort()[0];
    if (!first) return null;
    let oldest: number | null = null;
    for (const line of readFileSync(join(dir, first), "utf8").split("\n")) {
      const at = /"at":"([^"]+)"/.exec(line)?.[1];
      const ms = at ? Date.parse(at) : NaN;
      if (Number.isFinite(ms)) oldest = oldest === null ? ms : Math.min(oldest, ms);
    }
    return oldest;
  } catch {
    return null;
  }
}
