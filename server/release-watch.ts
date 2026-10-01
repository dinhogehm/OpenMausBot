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

const TAG_NOT_ADVANCED = /production is live at ([0-9a-f]{7,40}) but the certification tag was NOT advanced/i;
const TAG_REFUSAL = /GH013|protected ref|Cannot update this protected/i;
/** Lines that close one release's output in the err log: nothing before them is this release's. */
const RELEASE_BOUNDARY = /production is live at [0-9a-f]{7,40}|Release production failed for [0-9a-f]{7,40}|Certification tag (?:nuria-production-deployed advanced|unchanged)/i;
/** How far above its warning a release's push refusal may sit. */
const TAG_CAUSE_WINDOW = 40;

/** Why the tag did not move for `releasedSha`, from the err log's tail
 * (local-release.sh writes both to stderr): that release's own warning
 * ("production is live at <releasedSha> but the certification tag was NOT
 * advanced") and GitHub's refusal of its push, which comes just before it —
 * never a refusal from an earlier release (01/10: the GH013 of 1bbd5c2a7
 * stays in the tail for days). Null when this release left no warning. */
export function tagStuckCause(errTail: string, releasedSha: string): string | null {
  const released = releasedSha.trim();
  if (!released) return null;
  const lines = errTail.split("\n").map((line) => line.replace(ANSI_COLOUR, "").trim()).filter(Boolean);
  const at = lines.findLastIndex((line) => {
    const sha = TAG_NOT_ADVANCED.exec(line)?.[1];
    return Boolean(sha && (sha.startsWith(released) || released.startsWith(sha)));
  });
  if (at < 0) return null;
  let refusal: string | undefined;
  for (let i = at - 1; i >= 0 && at - i <= TAG_CAUSE_WINDOW && !RELEASE_BOUNDARY.test(lines[i]!); i -= 1) {
    if (TAG_REFUSAL.test(lines[i]!)) { refusal = lines[i]; break; }
  }
  const exit = /\(exit (\d+)\)/.exec(lines[at]!)?.[1];
  const warned = `o release avisou que a tag não avançou${exit ? ` (exit ${exit})` : ""}`;
  if (!refusal) return warned;
  return `${warned}; o GitHub recusou o push da tag (${/GH013/.test(refusal) ? "GH013: regra de proteção do repositório" : "ref protegida"})`;
}

/** Production runs `releasedSha` (released at `releasedAt`) and the tag is
 * not at it (nor past it) after TAG_STUCK_AFTER_MS: what to tell, else null. */
export function tagStuck(input: { releasedSha: string; releasedAt: number; tagSha: string | null; tagContainsRelease: boolean; now: number; cause: string | null }): string | null {
  const released = input.releasedSha.trim();
  if (!released || !input.tagSha || input.tagContainsRelease || input.now - input.releasedAt < TAG_STUCK_AFTER_MS) return null;
  const minutes = Math.round((input.now - input.releasedAt) / 60_000);
  return `Produção está no ar em ${released.slice(0, 9)} há ${minutes} min, mas a tag de produção continua em ${input.tagSha.slice(0, 9)}${input.cause ? ` (${input.cause})` : ""}: os vigias da tag não veem a entrega e nenhum cliente é avisado. Alguém precisa avançar a tag (ou corrigir o que a barrou).`;
}

const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
/** The watcher's reason codes, said in pt-BR (unknown codes are kept as they are). */
const HALT_REASONS: Record<string, string> = {
  "content-failure-limit": "limite de falhas de conteúdo atingido",
};

/** The watcher's halt of a tip, or null when none. The halt exists if and
 * only if halted-production-release.sha holds a commit sha: that is the one
 * file the watcher reads to decide (watch-production-release.sh), and the one
 * the alert tells to remove for a retry — the escalation JSON stays behind
 * after that `rm`, so it never makes a halt by itself; it only adds the
 * failure count and the last failure when its sha is the same commit.
 * Without a .reason (the post-deploy halts, exit 20/21/23, write none) the
 * reason is the post-deploy check. */
export function haltedRelease(input: { escalationJson: string; haltedSha: string; haltedReason: string }): { sha: string; reason: string; failures?: number; lastFailure?: string } | null {
  const sha = input.haltedSha.trim();
  if (!COMMIT_SHA.test(sha)) return null;
  let escalation: { reason?: string; failures?: number; lastFailure?: string } = {};
  try {
    const raw = JSON.parse(input.escalationJson) as { kind?: unknown; sha?: unknown; reason?: unknown; failures?: unknown; last_failure?: unknown };
    if (raw.kind === "production-release-halted" && typeof raw.sha === "string" && COMMIT_SHA.test(raw.sha) && (raw.sha.startsWith(sha) || sha.startsWith(raw.sha))) {
      escalation = {
        ...(typeof raw.reason === "string" && raw.reason.trim() ? { reason: raw.reason.trim() } : {}),
        ...(typeof raw.failures === "number" ? { failures: raw.failures } : {}),
        ...(typeof raw.last_failure === "string" && raw.last_failure.trim() ? { lastFailure: raw.last_failure.trim().slice(0, 300) } : {}),
      };
    }
  } catch { /* no escalation file, or not readable as one */ }
  const code = input.haltedReason.trim().split("\n")[0]!.trim().slice(0, 200) || escalation.reason || "";
  return {
    sha,
    reason: code ? HALT_REASONS[code] ?? code : "checagem pós-deploy",
    ...(escalation.failures !== undefined ? { failures: escalation.failures } : {}),
    ...(escalation.lastFailure ? { lastFailure: escalation.lastFailure } : {}),
  };
}
