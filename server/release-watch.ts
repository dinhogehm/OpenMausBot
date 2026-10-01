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
// ESC [ … m, built from a string so no control character sits in a regex literal
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function releaseFailureCause(outTail: string): string | null {
  // ANSI colours out; a workspace's test noise (@nuria/web:test: …) is never the cause
  const lines = outTail.split("\n").map((line) => line.replace(ANSI_COLOUR, "").trim()).filter((line) => line && !/@[\w.-]+\/[\w.-]+:test:/.test(line));
  // the release's own verdict: the first [ERROR] of the block that ends in "Release abortado"
  const abort = lines.findLastIndex((line) => /Release abortado|Release aborted/i.test(line));
  if (abort >= 0) {
    let start = abort;
    while (start > 0 && /\[ERROR\]/.test(lines[start - 1]!)) start -= 1;
    if (start < abort) return lines[start]!.replace(/^\[ERROR\]\s*/, "").slice(0, 300);
  }
  const named = lines.findLast((line) => /Release snapshot changed|ADMISSION_TIMEOUT|Local CI failed at/.test(line))
    ?? lines.findLast((line) => /\[ERROR\]/.test(line));
  return named ? named.replace(/^\[ERROR\]\s*/, "").slice(0, 300) : null;
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
  private told: string[] = [];

  constructor(path: string) {
    this.path = path;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { alerted?: Record<string, number>; told?: string[] };
      this.alerted = raw.alerted ?? {};
      this.told = raw.told ?? [];
    } catch { /* first run */ }
  }

  private save(): void {
    writeFileAtomic(this.path, `${JSON.stringify({ alerted: this.alerted, told: this.told }, null, 2)}\n`, { mode: 0o600 });
  }

  /** Whether `count` failures of `sha` are news. Records them if so. */
  take(sha: string, count: number): boolean {
    if (count < RELEASE_FAILURES_ALERT || count <= (this.alerted[sha] ?? 0)) return false;
    this.alerted = { ...Object.fromEntries(Object.entries(this.alerted).slice(-20)), [sha]: count };
    this.save();
    return true;
  }

  /** Whether `key` (a stuck tag, a halt) is news. Records it if so. */
  once(key: string): boolean {
    if (this.told.includes(key)) return false;
    this.told = [...this.told.slice(-40), key];
    this.save();
    return true;
  }
}

// ── after a release: the tag, and the watcher's own halt ────────────────
// A release can reach production and still leave the certification tag
// where it was (01/10: GH013, a ruleset blocked the watcher's push): every
// watch on the tag goes blind and no client hears the delivery. And the
// watcher can halt a tip for good (nuria-platform #9328: after N content
// failures it writes ~/.nuria/halted-production-release.{sha,reason} and
// ~/.nuria/escalations/production-release-halted.json); from then on it does
// NOT retry, and saying "it retries every 2 min" would be false.

export const HALTED_SHA_FILE = join(homedir(), ".nuria", "halted-production-release.sha");
export const HALTED_REASON_FILE = join(homedir(), ".nuria", "halted-production-release.reason");
export const HALT_ESCALATION_FILE = join(homedir(), ".nuria", "escalations", "production-release-halted.json");
/** How long production may run ahead of the tag before the Chief hears it. */
export const TAG_STUCK_AFTER_MS = 15 * 60_000;

/** Why the tag did not move, from the release logs' tails: the release's own warning and GitHub's refusal. */
export function tagStuckCause(logTail: string): string | null {
  const lines = logTail.split("\n").map((line) => line.replace(ANSI_COLOUR, "").trim()).filter(Boolean);
  const refusal = lines.findLast((line) => /GH013|protected ref|Cannot update this protected/i.test(line));
  const warning = lines.findLast((line) => /certification tag was NOT advanced/i.test(line));
  const parts = [warning, refusal].filter((line): line is string => Boolean(line)).map((line) => line.slice(0, 200));
  return parts.length ? [...new Set(parts)].join(" · ") : null;
}

/** Production runs `releasedSha` (released at `releasedAt`) and the tag is
 * not at it (nor past it) after TAG_STUCK_AFTER_MS: what to tell, else null. */
export function tagStuck(input: { releasedSha: string; releasedAt: number; tagSha: string | null; tagContainsRelease: boolean; now: number; cause: string | null }): string | null {
  const released = input.releasedSha.trim();
  if (!released || !input.tagSha || input.tagContainsRelease || input.now - input.releasedAt < TAG_STUCK_AFTER_MS) return null;
  const minutes = Math.round((input.now - input.releasedAt) / 60_000);
  return `Produção está no ar em ${released.slice(0, 9)} há ${minutes} min, mas a tag de produção continua em ${input.tagSha.slice(0, 9)}${input.cause ? ` (${input.cause})` : ""}: os vigias da tag não veem a entrega e nenhum cliente é avisado. Alguém precisa avançar a tag (ou corrigir o que a barrou).`;
}

/** The watcher's halt of a tip, from its escalation file or its halted files; null when none. */
export function haltedRelease(input: { escalationJson: string; haltedSha: string; haltedReason: string }): { sha: string; reason: string; failures?: number; lastFailure?: string } | null {
  try {
    const raw = JSON.parse(input.escalationJson) as { kind?: string; sha?: string; reason?: string; failures?: number; last_failure?: string };
    if (raw.kind === "production-release-halted" && typeof raw.sha === "string" && raw.sha) {
      return { sha: raw.sha, reason: raw.reason ?? "unknown", ...(typeof raw.failures === "number" ? { failures: raw.failures } : {}), ...(raw.last_failure ? { lastFailure: raw.last_failure } : {}) };
    }
  } catch { /* no escalation file, or not readable as one */ }
  const sha = input.haltedSha.trim();
  return sha ? { sha, reason: input.haltedReason.trim() || "unknown" } : null;
}
