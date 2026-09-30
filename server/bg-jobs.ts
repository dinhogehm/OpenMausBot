// A headless Claude Code turn that ends while a process it started keeps
// running in the session's folder (a gate like ci:local left in the
// background): nothing would wake the session when that process finishes.
// While the turn runs the server notes the process tree under its `claude`
// process; when the turn ends, those descendants still running in the
// session's worktree are its background job, and the session is resumed
// with a new turn once they are all gone. A shell the person opened in the
// worktree is never one of them. Each process is kept with its start time,
// so a PID the system reuses later is not mistaken for the job.
import { execFile } from "node:child_process";

export interface BgProcess { pid: number; cwd: string; command: string; start: string }

/** A session's background job: its processes and their start times (`ps -o lstart`). */
export interface BgJob {
  pids: number[];
  commands: string[];
  since: number;
  /** lstart per pid; older records have none (then only the pid is checked). */
  starts?: string[];
  /** All gone, but no slot was free to resume the session: retried next tick. */
  doneAt?: number;
}

/** A job still running after this is reported to the owner, and no longer waited on. */
export const BG_JOB_MAX_MS = 3 * 3_600_000;

/** `lsof -a -d cwd -Fpn` output: "p<pid>" then "n<cwd>" per process. */
export function parseLsofCwd(output: string): Array<{ pid: number; cwd: string }> {
  const found: Array<{ pid: number; cwd: string }> = [];
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || null;
    else if (line.startsWith("n") && pid !== null) found.push({ pid, cwd: line.slice(1) });
  }
  return found;
}

/** Processes working inside `folder` (its worktree), except `exclude`. */
export function leftoversIn(folder: string, processes: Array<{ pid: number; cwd: string }>, exclude: readonly number[] = []): Array<{ pid: number; cwd: string }> {
  const root = folder.replace(/\/+$/, "");
  return processes.filter((proc) => !exclude.includes(proc.pid) && (proc.cwd === root || proc.cwd.startsWith(`${root}/`)));
}

export interface PsRow { pid: number; ppid: number; pgid: number; start: string; command: string }

/** `LC_ALL=C ps -axo pid=,ppid=,pgid=,lstart=,command=`: lstart is five
 * fields ("Tue Sep 30 16:51:36 2026"). */
export function parsePsTable(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), start: match[4]!.replace(/\s+/g, " "), command: match[5]! });
  }
  return rows;
}

/** A shell someone typed into ("-zsh", "/bin/bash -il"), not a job. */
export function isInteractiveShell(command: string): boolean {
  return /^-\S*(sh|fish)$/.test(command.trim()) || /^(\S*\/)?(zsh|bash|sh|fish|tcsh|ksh)(\s+-[il]+)*$/.test(command.trim());
}

/** What the server saw under a turn's `claude` process: pid → start, and their process groups. */
export interface TurnTree { rootPid: number; seen: Map<number, string>; groups: Set<number> }

export function newTurnTree(rootPid: number): TurnTree {
  return { rootPid, seen: new Map(), groups: new Set([rootPid]) };
}

/** Adds the processes now under the turn's root to what was seen. */
export function noteDescendants(tree: TurnTree, rows: readonly PsRow[]): void {
  const children = new Map<number, PsRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const queue = [...(children.get(tree.rootPid) ?? [])];
  while (queue.length) {
    const row = queue.shift()!;
    if (tree.seen.has(row.pid)) continue;
    tree.seen.set(row.pid, row.start);
    tree.groups.add(row.pgid);
    queue.push(...(children.get(row.pid) ?? []));
  }
}

/** The turn's processes still running in `folder`: seen under its `claude`
 * (same pid and start), in one of the process groups seen there, or still
 * below the root; never an interactive shell, never `exclude`. */
export function sessionLeftovers(folder: string, tree: TurnTree, rows: readonly PsRow[], cwds: ReadonlyArray<{ pid: number; cwd: string }>, exclude: readonly number[] = []): BgProcess[] {
  noteDescendants(tree, rows);
  const inFolder = new Map(leftoversIn(folder, [...cwds], exclude).map((proc) => [proc.pid, proc.cwd]));
  return rows
    .filter((row) => inFolder.has(row.pid) && row.pid !== tree.rootPid && !isInteractiveShell(row.command))
    .filter((row) => tree.seen.get(row.pid) === row.start || (!tree.seen.has(row.pid) && tree.groups.has(row.pgid)))
    .map((row) => ({ pid: row.pid, cwd: inFolder.get(row.pid)!, command: row.command.slice(0, 200), start: row.start }));
}

const run = (file: string, args: string[]) => new Promise<string>((resolve) => {
  execFile(file, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (_error, stdout) => resolve(String(stdout ?? "")));
});

export async function psTable(): Promise<PsRow[]> {
  if (process.platform === "win32") return [];
  return parsePsTable(await run("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="]));
}

/** The turn's processes still running in `folder`, with their command lines. */
export async function backgroundProcesses(folder: string, tree: TurnTree): Promise<BgProcess[]> {
  if (process.platform === "win32") return [];
  const rows = await psTable();
  noteDescendants(tree, rows);
  const candidates = rows.filter((row) => tree.seen.has(row.pid) || tree.groups.has(row.pgid)).map((row) => row.pid).filter((pid) => pid !== process.pid);
  if (!candidates.length) return [];
  const cwds = parseLsofCwd(await run("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", candidates.join(",")]));
  return sessionLeftovers(folder, tree, rows, cwds, [process.pid]);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether any of the job's processes still runs: same pid AND same start
 * time, so a reused PID does not keep the session waiting. */
export function jobAliveIn(job: Pick<BgJob, "pids" | "starts">, rows: readonly PsRow[]): boolean {
  const started = new Map(rows.map((row) => [row.pid, row.start]));
  return job.pids.some((pid, i) => {
    const start = job.starts?.[i];
    return start ? started.get(pid) === start : started.has(pid);
  });
}

export async function jobAlive(job: Pick<BgJob, "pids" | "starts">): Promise<boolean> {
  if (!job.starts?.length) return job.pids.some(pidAlive);
  const alive = job.pids.filter(pidAlive);
  if (!alive.length) return false;
  return jobAliveIn(job, parsePsTable(await run("/bin/ps", ["-o", "pid=,ppid=,pgid=,lstart=,command=", "-p", alive.join(",")])));
}

/** The turn that resumes a session once its background job is gone. */
export function bgJobResumePrompt(job: { pids: number[]; commands: string[]; since: number }, now: number): string {
  const minutes = Math.max(1, Math.round((now - job.since) / 60_000));
  return [
    `[The server resumed you: the process(es) you left running when your last turn ended have finished, after ${minutes} min.]`,
    ...job.commands.map((command, i) => `- PID ${job.pids[i]}: ${command}`),
    "Check how it ended (its log or receipt, the gate's status) and continue from where you stopped. End with your report as usual.",
  ].join("\n");
}

/** For the owner, when a job outlives BG_JOB_MAX_MS: the server stops waiting. */
export function bgJobOverdueReport(session: { id: string; title: string }, job: BgJob, now: number): string {
  const hours = Math.round(((now - job.since) / 3_600_000) * 10) / 10;
  return [
    `[Claude Code session ${session.id} ("${session.title}"): the process(es) its last turn left running are still running after ${hours} h.]`,
    ...job.commands.map((command, i) => `- PID ${job.pids[i]}: ${command}`),
    "The server no longer waits for them to resume the session. Check whether it is stuck (its log or receipt), then send the session a message with cc_session_send, or stop it.",
  ].join("\n");
}
