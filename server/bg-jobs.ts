// A headless Claude Code turn that ends while a process it started keeps
// running in the session's folder (a gate like ci:local left in the
// background): nothing would wake the session when that process finishes.
// The server notes those processes when the turn ends and resumes the
// session with a new turn once they are all gone.
import { execFile } from "node:child_process";

export interface BgProcess { pid: number; cwd: string; command: string }

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

const run = (file: string, args: string[]) => new Promise<string>((resolve) => {
  execFile(file, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout ?? "")));
});

/** The processes still running in `folder`, with their command lines. */
export async function backgroundProcesses(folder: string): Promise<BgProcess[]> {
  if (process.platform === "win32") return [];
  const inFolder = leftoversIn(folder, parseLsofCwd(await run("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn"])), [process.pid]);
  if (!inFolder.length) return [];
  const listing = await run("/bin/ps", ["-o", "pid=,command=", "-p", inFolder.map((proc) => proc.pid).join(",")]);
  const commands = new Map(listing.split("\n").map((line) => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map((match) => [Number(match![1]), match![2]!] as const));
  return inFolder.map((proc) => ({ ...proc, command: (commands.get(proc.pid) ?? "").slice(0, 200) }));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
