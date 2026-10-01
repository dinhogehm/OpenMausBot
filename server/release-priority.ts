// A production release waits behind the local CI of another worktree
// (admission-control: "ADMISSION_WAITING kind=release … blocked_by=ci-full:<pid>").
// When that CI belongs to a Claude Code session this server manages, the
// release wins: the server stops that CI, tells the session why, and resumes
// it once the production tag moves. It never touches a process that is not a
// managed session's CI, never the session's own claude, never the server or
// the app, and never the release itself.
import { isInteractiveShell, type PsRow } from "./bg-jobs.ts";

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

// ── what a command is: anchored on the executable and the script, never on
// free text — a `claude -p` carries its whole prompt in argv, and a prompt
// that says "rode ci:local … ./scripts/release-carrier.sh --check" is not a CI
// nor a release (INSP-R r1: the server picked the claude's group as "the CI").
const SHELL = String.raw`(?:\S*/)?(?:ba|z)?sh`;
const SHELL_OPTS = String.raw`(?:\s+-\S+)*`;
/** `bash ./scripts/local-ci.sh --profile full`, `/bin/bash -p scripts/local-ci.sh`. */
const CI_SCRIPT = new RegExp(`^${SHELL}${SHELL_OPTS}\\s+\\S*scripts/local-ci\\.sh(?:\\s|$)`);
/** `npm run ci:local` (the process title npm sets). */
const CI_NPM = /^(?:\S*\/)?npm(?:\s+-\S+)*\s+run(?:-script)?\s+ci:local(?:\s|$)/;
/** The Bash tool's `/bin/zsh -c …` (or `bash -c`) that leads the CI's group. */
const SHELL_C = new RegExp(`^${SHELL}${SHELL_OPTS}\\s+-c\\s`);
/** The release: its scripts run by a shell, the watcher, or `npm run release…`. */
const RELEASE_SCRIPT = new RegExp(`^${SHELL}${SHELL_OPTS}\\s+\\S*(?:scripts/(?:local-release|release-carrier)|watch-production-release)\\.sh(?:\\s|$)`);
const RELEASE_NPM = /^(?:\S*\/)?npm(?:\s+-\S+)*\s+run(?:-script)?\s+release(?::\S*)?(?:\s|$)/;
/** A Claude Code process: `claude …` or its node entry point. */
const CLAUDE = /^(?:\S*\/)?claude(?:\s|$)|\/@anthropic-ai\/claude-code\//;
/** An app bundle's process: the OpenMausBot app, its helpers (the server), Claude, a terminal. */
const APP_BUNDLE = /\.app\/Contents\//;

export const isCiCommand = (command: string): boolean => CI_SCRIPT.test(command.trim()) || CI_NPM.test(command.trim());
export const isReleaseCommand = (command: string): boolean => RELEASE_SCRIPT.test(command.trim()) || RELEASE_NPM.test(command.trim());
export const isClaudeCommand = (command: string): boolean => CLAUDE.test(command.trim());

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

/** What to stop so the release can go — the CI's whole process group, or,
 * when that group also holds something else, only the CI's process tree —
 * with every pid the signal reaches; or why nothing may be stopped: `reason`
 * in pt-BR for the alert (no argv), `detail` with pids and commands for the log. */
export type CiStop =
  | { kind: "group"; pgid: number; root: PsRow; pids: number[] }
  | { kind: "tree"; pids: number[]; root: PsRow }
  | { kind: "refuse"; reason: string; detail: string };

/** What must never be signalled, besides the release: the server's own group,
 * and every pid the caller names (managed sessions' claudes, the server, its parent). */
export interface StopGuard {
  ownPgid: number;
  protectedPids?: readonly number[];
}

const describe = (row: PsRow) => `${row.pid} "${row.command.slice(0, 120)}" pgid ${row.pgid}`;
const refuse = (reason: string, detail: string): CiStop => ({ kind: "refuse", reason, detail });

/** The pid in the lease is the CI script itself: admission-control.sh writes
 * `$$` to lease/owner.pid, and it is sourced by local-ci.sh (01/10, live lease:
 * owner.pid 40409 = `bash ./scripts/local-ci.sh --profile full`). The CI is
 * found by walking up from it only through contiguous processes that are
 * still the local CI (`local-ci.sh`, `npm run ci:local`) in the lease pid's
 * own process group — plus that group's leader when it is the `zsh -c` that
 * ran it. Nothing above that is ever part of the target. Refuses when the
 * whole chain up to launchd holds the release, when the group or tree holds
 * the release, or when the target would reach a claude, an app bundle (the
 * server, the app), an interactive shell, the server's group or a protected pid. */
export function ciToStop(pid: number, rows: readonly PsRow[], guard: StopGuard): CiStop {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const start = byPid.get(pid);
  if (!start) return refuse("o processo que segura o lease já não está rodando", `ci-full:${pid} is not running`);
  if (!isCiCommand(start.command)) return refuse("o processo que segura o lease não é um ci:local reconhecível (local-ci.sh ou npm run ci:local)", `${describe(start)} is not local-ci.sh / npm run ci:local`);
  const chain: PsRow[] = [start];
  for (let row = start; row.ppid > 0 && chain.length < 128;) {
    const parent = byPid.get(row.ppid);
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    row = parent;
  }
  const releaseAbove = chain.find((row) => isReleaseCommand(row.command));
  if (releaseAbove) return refuse("o ci:local roda dentro do próprio release", `${describe(releaseAbove)} is an ancestor of ci-full:${pid}`);
  let top = 0;
  while (top + 1 < chain.length && chain[top + 1]!.pgid === start.pgid && isCiCommand(chain[top + 1]!.command)) top += 1;
  const leader = chain[top + 1];
  if (leader && leader.pgid === start.pgid && leader.pid === leader.pgid && SHELL_C.test(leader.command.trim())) top += 1;
  const root = chain[top]!;
  if (root.pgid <= 1 || root.pgid === guard.ownPgid) {
    return refuse(root.pgid <= 1 ? "o ci:local não tem um grupo de processos próprio" : "o ci:local está no grupo de processos do próprio servidor", `the CI ${describe(root)} runs in ${root.pgid <= 1 ? "no group of its own" : "the server's own group"}`);
  }
  const tree = new Set([root.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!tree.has(row.pid) && tree.has(row.ppid)) { tree.add(row.pid); grew = true; }
  }
  const group = rows.filter((row) => row.pgid === root.pgid);
  const release = [...group, ...rows.filter((row) => tree.has(row.pid))].find((row) => isReleaseCommand(row.command));
  if (release) return refuse("o release roda no mesmo grupo de processos do ci:local, ou abaixo dele", `the release ${describe(release)} shares the CI's group or tree (root ${describe(root)})`);
  // the whole group when it is only the CI; else only the CI's tree
  const whole = group.every((row) => tree.has(row.pid));
  const targets = whole ? group : rows.filter((row) => tree.has(row.pid));
  const guarded = new Set(guard.protectedPids ?? []);
  const forbidden = targets.find((row) => row.pid <= 1 || guarded.has(row.pid) || row.pgid === guard.ownPgid || isClaudeCommand(row.command) || APP_BUNDLE.test(row.command) || isInteractiveShell(row.command));
  if (forbidden) return refuse("o alvo incluiria uma sessão do Claude, o servidor, o app ou um terminal do dono", `stopping ${whole ? `group ${root.pgid}` : `the tree of ${root.pid}`} would reach ${describe(forbidden)}`);
  const pids = targets.map((row) => row.pid);
  return whole ? { kind: "group", pgid: root.pgid, root, pids } : { kind: "tree", pids, root };
}
