// A production release that fails does not move the production tag, so the
// watches on the tag never see it: the P1 just stays out of production. The
// release watcher (nuria-platform's watch-production-release.sh) writes
// "Release production failed for <sha> (exit N)" to its err log and the
// last released sha to a state file. The server reads both and, when the
// same commit failed twice or more and was not released since, tells the
// Chief — once per new failure.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

export const RELEASE_ERR_LOG = join(homedir(), ".nuria", "logs", "production-release.err.log");
export const RELEASE_OUT_LOG = join(homedir(), ".nuria", "logs", "production-release.out.log");
export const RELEASED_SHA_FILE = join(homedir(), ".nuria", "last-production-release.sha");
/** Failures of one commit before the Chief hears about it. */
export const RELEASE_FAILURES_ALERT = 2;

/** The commit that failed last, and how many times it failed, unless it was released since. */
export function releaseFailures(errLog: string, releasedSha: string): { sha: string; count: number } | null {
  const shas = [...errLog.matchAll(/Release production failed for ([0-9a-f]{7,40}) \(exit \d+\)/g)].map((match) => match[1]!);
  const last = shas.at(-1);
  if (!last) return null;
  const released = releasedSha.trim();
  if (released && (released.startsWith(last) || last.startsWith(released))) return null;
  return { sha: last, count: shas.filter((sha) => sha === last).length };
}

/** The last line saying why (the local CI lane that failed), from the out log's tail. */
export function releaseFailureCause(outTail: string): string | null {
  const lines = outTail.split("\n").filter((line) => /Local CI failed at|failed at \w+|FAIL |Error:/.test(line));
  return lines.at(-1)?.trim().slice(0, 300) ?? null;
}

export function readTail(path: string, bytes: number): string {
  if (!existsSync(path)) return "";
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Failures already told, per commit, kept across restarts. */
export class ReleaseWatchState {
  private readonly path: string;
  private alerted: Record<string, number> = {};

  constructor(path: string) {
    this.path = path;
    try {
      this.alerted = (JSON.parse(readFileSync(path, "utf8")) as { alerted?: Record<string, number> }).alerted ?? {};
    } catch { /* first run */ }
  }

  /** Whether `count` failures of `sha` are news. Records them if so. */
  take(sha: string, count: number): boolean {
    if (count < RELEASE_FAILURES_ALERT || count <= (this.alerted[sha] ?? 0)) return false;
    this.alerted = { ...Object.fromEntries(Object.entries(this.alerted).slice(-20)), [sha]: count };
    writeFileAtomic(this.path, `${JSON.stringify({ alerted: this.alerted }, null, 2)}\n`, { mode: 0o600 });
    return true;
  }
}
