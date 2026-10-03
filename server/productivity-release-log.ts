// Production releases as the release watcher logged them (lot V). The watcher
// (nuria-platform scripts/macos/watch-production-release.sh) runs one release
// per new origin/main tip and writes everything to
// ~/.nuria/logs/production-release.out.log (rotated to .out.log.1.gz). A run
// is bracketed by the admission lines:
//
//   ADMISSION_INTENT kind=release label=release:production:<sha40> pid=<pid>
//   …local CI steps "[HH:MM:SS] build" (UTC clock, no date)…
//   **Data:** 2026-10-02T04:04:54Z | … | **Duracao:** 291s   (review report)
//   [OK] Concluido! (8291s)                                     (deploy done)
//   Certification tag nuria-production-deployed advanced to <sha40>
//   ADMISSION_RELEASED kind=release pid=<pid>
//
// The log has no date on most lines, so the time of a run is rebuilt from
// what it does carry: the review report's ISO date and its duration (the
// deploy's own START_TIME is Data − Duracao, and "Concluido! (N s)" counts
// from it), Lighthouse's ISO stamps, and the UTC clock of the CI steps,
// dated by the nearest stamp. Each run says how its time was obtained.
//
// The parser is a small state machine whose state is plain JSON, so the big
// rotated file is parsed once and the live file is replayed on top of it.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { releaseCauseKey, releaseFailureCause } from "./release-watch.ts";

/** released: the tag advanced (or went live without it); failed: the run EXECUTED
 * (CI or deploy steps ran) and ended without releasing; superseded: it never ran —
 * the watcher moved on to a newer tip, or the run left the admission queue;
 * aborted: it stopped before running anything (a stale lock, a smart-deploy that
 * could not start) — neither of the last two is a failure of the commit. */
export type RunOutcome = "released" | "failed" | "superseded" | "aborted" | "noop" | "running";
export type RunTimeSource = "log" | "log-clock" | "neighbor";

export interface ReleaseRun {
  /** `${sha}:${pid}` — unique per attempt, stable across re-parses and rotation. */
  key: string;
  sha: string;
  pid: number;
  outcome: RunOutcome;
  startedAt: number | null;
  /** Released: the deploy finished (code live). Failed: the last moment the run was seen. */
  endedAt: number | null;
  timeSource: RunTimeSource;
  /** Failure: the run's own verdict, with paths, times and pids removed. */
  cause?: string;
  /** The PR whose merge is the released tip ("HEAD=<sha> Merge pull request #N") —
   * a release carrier only when GitHub says so (the report checks). */
  headPr?: number;
  /** The post-release health verdict (POST_RELEASE_RESULT=…): healthy, rolled_back… */
  postRelease?: string;
  /** The run never logged its end (killed, or the watcher restarted). */
  interrupted?: boolean;
  /** Not from the log: a production deployment GitHub recorded (the Actions era). */
  origin?: "github-deployment";
  /** The deploy finished (review date − duration + "Concluido"), certified or not. */
  deployedAt?: number;
  /** Live in production, but the watcher could not advance the tag (it was moved by hand later). */
  tagNotAdvanced?: true;
}

const LIVE_WITHOUT_TAG = /production is live at ([0-9a-f]{40}) but the certification tag was NOT advanced/g;

/** The watcher's err log says when a deploy went live but the tag push was
 * refused ("WARNING: production is live at <sha> but the certification tag
 * was NOT advanced"): that run is a delivery, not a failure — the code is in
 * production. Its last finished attempt of that commit becomes released,
 * dated by its own deploy end. */
export function liveWithoutTagShas(errText: string): string[] {
  return [...new Set([...errText.matchAll(LIVE_WITHOUT_TAG)].map((match) => match[1]!))];
}

export function applyLiveWithoutTag(runs: readonly ReleaseRun[], shas: Iterable<string>): ReleaseRun[] {
  const live = new Set(shas);
  if (!live.size) return [...runs];
  const out = [...runs];
  for (const sha of live) {
    if (out.some((run) => run.sha === sha && run.outcome === "released")) continue;
    const index = out.map((run, at) => ({ run, at })).filter(({ run }) => run.sha === sha && run.outcome === "failed" && run.deployedAt !== undefined).at(-1)?.at;
    if (index === undefined) continue;
    const { cause: _cause, ...run } = out[index]!;
    out[index] = { ...run, outcome: "released", endedAt: run.deployedAt!, tagNotAdvanced: true };
  }
  return out;
}

export interface DeclineEvent {
  /** As the watcher printed it (short sha). */
  sha: string;
  at: number | null;
  timeSource: RunTimeSource;
}

export interface ReleaseLogResult {
  runs: ReleaseRun[];
  declines: DeclineEvent[];
  /** First and last instant the parsed text is known to cover. */
  from: number | null;
  to: number | null;
}

interface RawRun {
  seq: number;
  sha: string;
  pid: number;
  /** Seconds-of-day (UTC) of the first and last CI step. */
  firstClock: number | null;
  lastClock: number | null;
  anchors: number[];
  dataAt: number | null;
  dataDuration: number | null;
  concluded: number | null;
  certified: boolean;
  closed: boolean;
  noop: boolean;
  headPr?: number;
  postRelease?: string;
  tail: string[];
}

interface RawDecline { seq: number; sha: string }

/** Serializable parser state (see the header). */
export interface ReleaseLogState {
  seq: number;
  runs: RawRun[];
  declines: RawDecline[];
  open: RawRun | null;
  /** "HEAD=<sha9> Merge pull request #N" seen before the run that releases it. */
  pendingCarrier: { sha: string; pr: number } | null;
  /** The last run that closed, until the next one starts (its no-op line follows it). */
  lastClosed: number | null;
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const INTENT = /^ADMISSION_INTENT kind=release label=release:production:([0-9a-f]{40}) pid=(\d+)/;
const RELEASED = /^ADMISSION_RELEASED kind=release pid=(\d+)/;
const CLOCK = /^\[(\d{2}):(\d{2}):(\d{2})\] \S/;
const LIGHTHOUSE = /^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) LH:/;
const REVIEW = /\*\*Data:\*\*\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z).*\*\*Duracao:\*\*\s*(\d+)s/;
const CONCLUDED = /Concluido! \((\d+)s\)/;
const CERTIFIED = /^Certification tag nuria-production-deployed advanced to ([0-9a-f]{40})/;
const CARRIER = /^HEAD=([0-9a-f]{7,40}) Merge pull request #(\d+)/;
const DECLINED = /^Operator (?:already )?declined (?:release for )?([0-9a-f]{7,40})/;
const NOOP = /^Release of ([0-9a-f]{7,40}) is a no-op/;
const POST_RELEASE = /^POST_RELEASE_RESULT=([a-z_]+)/;
const TAIL_LINES = 160;
const DAY_S = 86_400;

export function emptyReleaseLogState(): ReleaseLogState {
  return { seq: 0, runs: [], declines: [], open: null, pendingCarrier: null, lastClosed: null };
}

function closeOpen(state: ReleaseLogState): void {
  if (!state.open) return;
  state.runs.push(state.open);
  state.lastClosed = state.runs.length - 1;
  state.open = null;
}

/** Feed one line (without its newline). Cheap on the noise: a workspace's
 * test output (@nuria/x:test: …) and the build tables are skipped first. */
export function pushReleaseLogLine(state: ReleaseLogState, raw: string): void {
  const first = raw.charCodeAt(0);
  // '@' (workspace output) and '│'/'✓' tables carry no release fact
  if (first === 64 || raw.length === 0) return;
  const line = raw.includes(ESC) ? raw.replace(ANSI, "") : raw;
  const run = state.open;
  if (line.startsWith("ADMISSION_")) {
    const intent = INTENT.exec(line);
    if (intent) {
      closeOpen(state);
      const sha = intent[1]!;
      const carrier = state.pendingCarrier && sha.startsWith(state.pendingCarrier.sha) ? state.pendingCarrier.pr : undefined;
      state.pendingCarrier = null;
      state.open = {
        seq: state.seq++, sha, pid: Number(intent[2]), firstClock: null, lastClock: null, anchors: [],
        dataAt: null, dataDuration: null, concluded: null, certified: false, closed: false, noop: false,
        ...(carrier ? { headPr: carrier } : {}), tail: [],
      };
      return;
    }
    const released = RELEASED.exec(line);
    if (released && run && run.pid === Number(released[1])) {
      run.closed = true;
      closeOpen(state);
    }
    return;
  }
  const carrier = CARRIER.exec(line);
  if (carrier) { state.pendingCarrier = { sha: carrier[1]!, pr: Number(carrier[2]) }; return; }
  const declined = DECLINED.exec(line);
  if (declined) { state.declines.push({ seq: state.seq++, sha: declined[1]! }); return; }
  const noop = NOOP.exec(line);
  if (noop) {
    const target = run ?? (state.lastClosed !== null ? state.runs[state.lastClosed] : undefined);
    if (target && target.sha.startsWith(noop[1]!)) target.noop = true;
    return;
  }
  if (!run) return;
  const clock = CLOCK.exec(line);
  if (clock) {
    const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
    if (run.firstClock === null) run.firstClock = seconds;
    run.lastClock = seconds;
    return;
  }
  const lighthouse = LIGHTHOUSE.exec(line);
  if (lighthouse) {
    const at = Date.parse(lighthouse[1]!);
    if (Number.isFinite(at) && run.anchors.at(-1) !== at) run.anchors.push(at);
    return;
  }
  const review = REVIEW.exec(line);
  if (review) {
    const at = Date.parse(review[1]!);
    if (Number.isFinite(at)) { run.dataAt = at; run.dataDuration = Number(review[2]); run.anchors.push(at); }
    return;
  }
  const concluded = CONCLUDED.exec(line);
  if (concluded) { run.concluded = Number(concluded[1]); return; }
  const certified = CERTIFIED.exec(line);
  if (certified) { if (certified[1] === run.sha) run.certified = true; return; }
  const post = POST_RELEASE.exec(line);
  if (post) { run.postRelease = post[1]!; return; }
  const text = line.trim();
  if (!text || text.startsWith("│") || text.startsWith("✓")) return;
  run.tail.push(text.slice(0, 400));
  if (run.tail.length > TAIL_LINES) run.tail.splice(0, run.tail.length - TAIL_LINES);
}

/** The instant a UTC clock reading names, given a reference instant: the
 * candidate day closest to the reference (runs last hours, not days). */
export function clockNear(seconds: number, reference: number): number {
  const day = Math.floor(reference / 1000 / DAY_S) * DAY_S;
  let best = (day + seconds) * 1000;
  for (const offset of [-DAY_S, DAY_S]) {
    const candidate = (day + offset + seconds) * 1000;
    if (Math.abs(candidate - reference) < Math.abs(best - reference)) best = candidate;
  }
  return best;
}

/** The first instant at or after `after` whose UTC clock reads `seconds`. */
export function clockAfter(seconds: number, after: number): number {
  const day = Math.floor(after / 1000 / DAY_S) * DAY_S;
  const candidate = (day + seconds) * 1000;
  // a clock a few minutes behind the bound is the same moment seen late, not tomorrow
  return candidate >= after - 10 * 60_000 ? candidate : candidate + DAY_S * 1000;
}

/** Turn the parser state into dated runs. `endOfStream` marks a run still
 * open at the end as running (the watcher is on it right now). */
export function finishReleaseLog(state: ReleaseLogState, options: { endOfStream?: boolean } = {}): ReleaseLogResult {
  const raws = [...state.runs, ...(state.open ? [state.open] : [])];
  const items: Array<{ seq: number; run?: RawRun; decline?: RawDecline }> = [
    ...raws.map((run) => ({ seq: run.seq, run })),
    ...state.declines.map((decline) => ({ seq: decline.seq, decline })),
  ].sort((a, b) => a.seq - b.seq);
  // the next absolute stamp after each item, for runs that carry none
  const nextAnchor: Array<number | null> = Array.from({ length: items.length }, () => null);
  let upcoming: number | null = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    nextAnchor[i] = upcoming;
    const anchors = items[i]!.run?.anchors;
    if (anchors?.length) upcoming = anchors[0]!;
  }
  const runs: ReleaseRun[] = [];
  const declines: DeclineEvent[] = [];
  const seenDeclines = new Set<string>();
  let context: number | null = null;
  let from: number | null = null;
  let to: number | null = null;
  const note = (at: number | null) => {
    if (at === null) return;
    from = from === null ? at : Math.min(from, at);
    to = to === null ? at : Math.max(to, at);
  };
  items.forEach((item, index) => {
    if (item.decline) {
      const key = item.decline.sha;
      if (seenDeclines.has(key)) return;
      seenDeclines.add(key);
      declines.push({ sha: key, at: context, timeSource: "neighbor" });
      return;
    }
    const raw = item.run!;
    let source: RunTimeSource = "neighbor";
    let startedAt: number | null = null;
    let lastSeen: number | null = null;
    if (raw.anchors.length) {
      source = "log";
      const reference = raw.anchors[0]!;
      startedAt = raw.firstClock !== null ? Math.min(clockNear(raw.firstClock, reference), reference) : reference;
      lastSeen = Math.max(...raw.anchors, raw.lastClock !== null ? clockNear(raw.lastClock, raw.anchors.at(-1)!) : -Infinity);
    } else if (raw.firstClock !== null && (context !== null || nextAnchor[index] !== null)) {
      source = "log-clock";
      startedAt = context !== null ? clockAfter(raw.firstClock, context) : clockNear(raw.firstClock, nextAnchor[index]!);
      const upper = nextAnchor[index];
      if (upper !== null && upper !== undefined && startedAt > upper) startedAt = clockNear(raw.firstClock, upper);
      lastSeen = raw.lastClock !== null ? clockAfter(raw.lastClock, startedAt) : startedAt;
    } else {
      startedAt = context;
      lastSeen = context;
    }
    let endedAt = lastSeen;
    let outcome: RunOutcome = raw.certified ? "released" : raw.noop ? "noop" : "failed";
    // the deploy's START_TIME is the review's date minus its duration
    const deployedAt = raw.dataAt !== null && raw.dataDuration !== null && raw.concluded !== null
      ? Math.max(raw.dataAt, raw.dataAt - raw.dataDuration * 1000 + raw.concluded * 1000)
      : null;
    if (raw.certified && deployedAt !== null) {
      endedAt = deployedAt;
    } else if (raw.certified && source === "log") {
      source = "log-clock";
    }
    if (!raw.closed && !raw.certified && options.endOfStream && state.open === raw) outcome = "running";
    // a failure is a run that RAN: a CI step, a dated report or a deploy
    const executed = raw.firstClock !== null || raw.anchors.length > 0 || raw.concluded !== null;
    let cause = outcome === "failed" ? releaseFailureCause(raw.tail.join("\n")) : null;
    if (outcome === "failed" && !executed) {
      // stopped before anything ran: an abort with its own verdict, or a run
      // the watcher dropped (a newer tip, the admission queue) with none
      outcome = cause ? "aborted" : "superseded";
      if (outcome === "superseded") cause = null;
    }
    runs.push({
      key: `${raw.sha}:${raw.pid}`,
      sha: raw.sha,
      pid: raw.pid,
      outcome,
      startedAt,
      endedAt,
      timeSource: source,
      ...(cause ? { cause: releaseCauseKey(cause).slice(0, 240) } : {}),
      ...(raw.headPr ? { headPr: raw.headPr } : {}),
      ...(raw.postRelease ? { postRelease: raw.postRelease } : {}),
      ...(!raw.closed && outcome !== "running" ? { interrupted: true } : {}),
      ...(deployedAt !== null ? { deployedAt } : {}),
    });
    note(startedAt);
    note(endedAt);
    if (endedAt !== null) context = Math.max(context ?? endedAt, endedAt);
  });
  return { runs, declines, from, to };
}

/** Parse a whole text (tests, small files). */
export function parseReleaseLogText(text: string, options: { endOfStream?: boolean } = {}): ReleaseLogResult {
  const state = emptyReleaseLogState();
  for (const line of text.split("\n")) pushReleaseLogLine(state, line);
  return finishReleaseLog(state, options);
}

export interface FileSignature { path: string; size: number; mtimeMs: number }

export function fileSignature(path: string): FileSignature | null {
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    return stat.isFile() ? { path, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) } : null;
  } catch {
    return null;
  }
}

export const sameSignature = (a: FileSignature | null | undefined, b: FileSignature | null | undefined): boolean =>
  Boolean(a && b && a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs);

/** Stream a (possibly gzipped) file into the parser without holding it in
 * memory; yields to the event loop between chunks so the server keeps
 * answering while a 400 MB rotated log is read. */
export async function feedReleaseLogFile(state: ReleaseLogState, path: string): Promise<void> {
  const source = createReadStream(path);
  const stream = path.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      pushReleaseLogLine(state, line);
      if (++count % 50_000 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    lines.close();
    source.destroy();
  }
}
