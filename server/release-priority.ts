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

/** What to stop so the release can go: the CI's whole process group, or —
 * when that group also holds something else (the session's own claude, a
 * shell) — only the CI's process tree; or why nothing may be stopped. */
export type CiStop =
  | { kind: "group"; pgid: number; root: PsRow }
  | { kind: "tree"; pids: number[]; root: PsRow }
  | { kind: "refuse"; reason: string };

const describe = (row: PsRow) => `${row.pid} "${row.command.slice(0, 120)}" pgid ${row.pgid}`;

/** The pid in the admission lock may be the CI script, or a child of it
 * (vitest, turbo, a `bash -p` of a trusted hook bin), or its `npm run`
 * parent: the CI is found by walking up from it to the topmost process
 * that is still the local CI. On 01/10 a release waited 870 s because the
 * lock's pid was not the script itself ("not a local CI group"). Never the
 * release, never the server's own group. */
export function ciToStop(pid: number, rows: readonly PsRow[], ownPgid: number): CiStop {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const start = byPid.get(pid);
  if (!start) return { kind: "refuse", reason: `ci-full:${pid} is not running` };
  const chain: PsRow[] = [];
  for (let row: PsRow | undefined = start; row && row.pid > 1 && chain.length < 32; row = byPid.get(row.ppid)) chain.push(row);
  const ci = chain.map((row, i) => ({ row, i })).filter(({ row }) => CI_COMMAND.test(row.command));
  if (!ci.length) return { kind: "refuse", reason: `neither ${describe(start)} nor its parents are a local CI` };
  const root = ci.at(-1)!.row;
  const below = chain.slice(0, ci.at(-1)!.i + 1);
  const release = below.find((row) => RELEASE_COMMAND.test(row.command));
  if (release) return { kind: "refuse", reason: `${describe(release)} is the release itself` };
  if (root.pgid <= 1 || root.pgid === ownPgid) return { kind: "refuse", reason: `the CI ${describe(root)} runs in ${root.pgid <= 1 ? "no group of its own" : "the server's own group"}` };
  const group = rows.filter((row) => row.pgid === root.pgid);
  const releaseInGroup = group.find((row) => RELEASE_COMMAND.test(row.command));
  if (releaseInGroup) return { kind: "refuse", reason: `the release ${describe(releaseInGroup)} shares the CI's group` };
  // the CI's tree: the root and everything under it
  const tree = new Set([root.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!tree.has(row.pid) && tree.has(row.ppid)) { tree.add(row.pid); grew = true; }
  }
  if (rows.some((row) => tree.has(row.pid) && RELEASE_COMMAND.test(row.command))) return { kind: "refuse", reason: `the release runs under the CI ${describe(root)}` };
  // the group holds more than the CI (the session's claude): stop only the CI's tree
  if (group.some((row) => !tree.has(row.pid))) return { kind: "tree", pids: [...tree], root };
  return { kind: "group", pgid: root.pgid, root };
}

/** The process group to stop for `pid` (kept for callers that stop groups only). */
export function ciGroupToStop(pid: number, rows: readonly PsRow[], ownPgid: number): number | null {
  const stop = ciToStop(pid, rows, ownPgid);
  return stop.kind === "group" ? stop.pgid : null;
}
