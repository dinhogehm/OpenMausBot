// A production release waits behind the local CI of another worktree
// (admission-control: "ADMISSION_WAITING kind=release … blocked_by=ci-full:<pid>").
// When that CI belongs to a Claude Code session this server manages, the
// release wins: the server stops that CI's process group, tells the session
// why, and resumes it once the production tag moves. It never touches a
// process that is not a managed session's, and never the release itself.
import type { PsRow } from "./bg-jobs.ts";

/** How long the release must have waited before a CI is stopped for it. */
export const RELEASE_WAIT_BEFORE_PREEMPT_S = 120;

/** The release's current wait, from the admission log's tail: the latest
 * ADMISSION_* line must be a release waiting on a full CI. */
export function releaseBlockedBy(logTail: string): { pid: number; waitedS: number; label: string } | null {
  const lines = logTail.split("\n").filter((line) => line.startsWith("ADMISSION_"));
  const last = lines.at(-1);
  if (!last) return null;
  const match = /^ADMISSION_WAITING kind=release label=(\S+) blocked_by=ci-full:(\d+) waited=(\d+)s/.exec(last);
  return match ? { label: match[1]!, pid: Number(match[2]), waitedS: Number(match[3]) } : null;
}

const RELEASE_COMMAND = /release-production|local-release|release-carrier|watch-production-release/;
const CI_COMMAND = /local-ci\.sh|ci:local/;

/** What the server knows of a managed session's processes. */
export interface ManagedSessionProcs {
  sessionId: string;
  /** A running headless turn's claude pid, if any. */
  claudePid?: number;
  /** Background job pids (with start times) it left. */
  jobPids?: number[];
  /** Its worktree (for app sessions: a process working inside counts). */
  worktree?: string;
}

/** The session owning `pid`: a descendant of its running claude, one of its
 * background job's processes (or their descendants), or — for a worktree —
 * a process working inside it. Interactive shells never count. */
export function ownerSession(pid: number, rows: readonly PsRow[], cwdOf: (pid: number) => string | null, sessions: readonly ManagedSessionProcs[]): string | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const self = byPid.get(pid);
  if (!self || /^-\S*sh$/.test(self.command.trim())) return null;
  const ancestors = new Set<number>();
  for (let row = self, hops = 0; row && hops < 64; row = byPid.get(row.ppid)!, hops++) {
    ancestors.add(row.pid);
    if (row.ppid <= 1) break;
  }
  for (const session of sessions) {
    if (session.claudePid && ancestors.has(session.claudePid)) return session.sessionId;
    if (session.jobPids?.some((job) => ancestors.has(job))) return session.sessionId;
  }
  const cwd = cwdOf(pid);
  if (cwd) {
    for (const session of sessions) {
      const root = session.worktree?.replace(/\/+$/, "");
      if (root && root.includes("/.claude/worktrees/") && (cwd === root || cwd.startsWith(`${root}/`))) return session.sessionId;
    }
  }
  return null;
}

/** The process group to stop for `pid`, only if it is a local CI and not the
 * release; null otherwise. Never our own group. */
export function ciGroupToStop(pid: number, rows: readonly PsRow[], ownPgid: number): number | null {
  const row = rows.find((candidate) => candidate.pid === pid);
  if (!row || !CI_COMMAND.test(row.command) || RELEASE_COMMAND.test(row.command)) return null;
  if (row.pgid <= 1 || row.pgid === ownPgid) return null;
  // nothing of the release may share that group
  if (rows.some((other) => other.pgid === row.pgid && RELEASE_COMMAND.test(other.command))) return null;
  return row.pgid;
}
