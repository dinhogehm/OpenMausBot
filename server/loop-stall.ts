// Event-loop stall watch: a timer that should fire every `tickMs` notices when the main thread was held
// for more than `thresholdMs`, and says which labelled handler (HTTP route, bus subscriber, store listener)
// was running, plus — when the in-process sampling profiler is on — the functions that ate the time.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export interface SlowSection { label: string; ms: number; endedAt: number }

const SLOW_SECTION_MS = 250;
const RECENT_MAX = 64;
let current: string | null = null;
const recent: SlowSection[] = [];

/** The label of the synchronous section running right now (null between handlers). */
export function currentLoopLabel(): string | null {
  return current;
}

export function noteSlowSection(label: string, ms: number, endedAt = performance.now()): void {
  recent.push({ label, ms, endedAt });
  if (recent.length > RECENT_MAX) recent.shift();
}

/** Runs `fn` under `label`; its synchronous part is timed and remembered when slow. */
export function runLabeled<T>(label: string, fn: () => T): T {
  const previous = current;
  current = label;
  const started = performance.now();
  try {
    return fn();
  } finally {
    const ended = performance.now();
    current = previous;
    if (ended - started >= SLOW_SECTION_MS) noteSlowSection(label, ended - started, ended);
  }
}

/** Slow sections that ended inside (from, to], longest first. */
export function slowSectionsBetween(from: number, to: number): SlowSection[] {
  return recent.filter((s) => s.endedAt > from && s.endedAt <= to).sort((a, b) => b.ms - a.ms);
}

export function resetLoopStallState(): void {
  current = null;
  recent.length = 0;
}

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }
interface CpuProfile { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[]; startTime: number; endTime: number }

/** Self time per function, heaviest first: "name (file:line) 812 ms". */
export function topSelfTime(profile: CpuProfile, limit = 10): Array<{ fn: string; ms: number }> {
  const byNode = new Map<number, ProfileNode>(profile.nodes.map((n) => [n.id, n]));
  const totals = new Map<string, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const node = byNode.get(samples[i]!);
    if (!node) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    if (functionName === "(idle)" || functionName === "(program)") continue;
    const file = url ? url.slice(url.lastIndexOf("/") + 1) : "";
    const key = `${functionName || "(anonymous)"}${file ? ` (${file}:${lineNumber + 1})` : ""}`;
    // A sample's time is the gap to the next one.
    const us = deltas[i + 1] ?? 0;
    totals.set(key, (totals.get(key) ?? 0) + us / 1000);
  }
  return [...totals.entries()].map(([fn, ms]) => ({ fn, ms })).sort((a, b) => b.ms - a.ms).slice(0, limit);
}

export interface LoopStallWatchOptions {
  thresholdMs?: number;
  tickMs?: number;
  /** Sample the main thread with the in-process V8 profiler and keep a profile of each stall. */
  profile?: boolean;
  profileDir?: string;
  keepProfiles?: number;
  log?: (line: string) => void;
  now?: () => number;
}

type InspectorSession = { connect(): void; disconnect(): void; post(method: string, params?: object, cb?: (err: Error | null, res?: any) => void): void };

export function startLoopStallWatch(options: LoopStallWatchOptions = {}): { stop(): void; stalls(): number } {
  const thresholdMs = options.thresholdMs ?? 2000;
  const tickMs = options.tickMs ?? 500;
  const log = options.log ?? ((line: string) => console.warn(line));
  const now = options.now ?? (() => performance.now());
  const profileDir = options.profileDir ?? join(tmpdir(), "omb-loop-stalls");
  const keep = options.keepProfiles ?? 6;
  let stalls = 0;
  let last = now();
  let session: InspectorSession | null = null;
  let windowStarted = Date.now();

  const restartProfiler = () => {
    if (!session) return;
    session.post("Profiler.stop", {}, () => {
      session?.post("Profiler.start", {}, () => {});
      windowStarted = Date.now();
    });
  };

  if (options.profile) {
    try {
      session = new Session() as unknown as InspectorSession;
      session.connect();
      session.post("Profiler.enable", {}, () => {});
      session.post("Profiler.setSamplingInterval", { interval: 2000 }, () => {});
      session.post("Profiler.start", {}, () => {});
    } catch (error) {
      session = null;
      log(`[loop-stall] profiler unavailable (${error instanceof Error ? error.message : String(error)}); timing only`);
    }
  }

  const dumpProfile = (blockedMs: number, label: string) => {
    if (!session) return;
    session.post("Profiler.stop", {}, (err, res) => {
      try {
        const profile = res?.profile as CpuProfile | undefined;
        if (!err && profile) {
          const top = topSelfTime(profile, 8).map((t) => `${t.fn} ${Math.round(t.ms)} ms`).join(" · ");
          log(`[loop-stall] hot functions over the last ${Math.round((Date.now() - windowStarted) / 1000)} s: ${top || "none sampled"}`);
          mkdirSync(profileDir, { recursive: true, mode: 0o700 });
          const name = `stall-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.round(blockedMs)}ms.cpuprofile`;
          writeFileSync(join(profileDir, name), JSON.stringify(profile), { mode: 0o600 });
          const old = readdirSync(profileDir).filter((f) => f.endsWith(".cpuprofile")).sort();
          for (const f of old.slice(0, Math.max(0, old.length - keep))) rmSync(join(profileDir, f), { force: true });
          log(`[loop-stall] profile kept at ${join(profileDir, name)} (${label})`);
        }
      } catch (error) {
        log(`[loop-stall] could not keep the profile (${error instanceof Error ? error.message : String(error)})`);
      } finally {
        session?.post("Profiler.start", {}, () => {});
        windowStarted = Date.now();
      }
    });
  };

  let sinceRestart = 0;
  const timer = setInterval(() => {
    const t = now();
    const blocked = t - last - tickMs;
    if (blocked >= thresholdMs) {
      stalls++;
      const sections = slowSectionsBetween(last, t);
      const label = sections.length
        ? sections.slice(0, 4).map((s) => `${s.label} ${(s.ms / 1000).toFixed(1)} s`).join(", ")
        : "no labelled handler (timer, child-process or stream callback)";
      log(`[loop-stall] main thread blocked ${(blocked / 1000).toFixed(1)} s — ${label}`);
      dumpProfile(blocked, label);
      sinceRestart = 0;
    } else if (session && (sinceRestart += tickMs) >= 60_000) {
      // Bound the profile's memory: only the last minute is kept.
      sinceRestart = 0;
      restartProfiler();
    }
    last = t;
  }, tickMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      if (session) {
        try { session.post("Profiler.stop", {}, () => {}); session.disconnect(); } catch { /* already gone */ }
        session = null;
      }
    },
    stalls: () => stalls,
  };
}
