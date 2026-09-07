/** The pre-flight: every check a workflow declares, run in parallel under
 * one deadline, answering "is the environment ready for a run RIGHT NOW"
 * before a single bot turn is dispatched. Pure orchestration over three
 * injected answers — the bot roster's state, the driver's health snapshot,
 * a command runner — so the engine tests never spawn a process and the
 * command runner is tested on its own against real child processes.
 *
 * Output discipline: whatever a check prints is scrubbed of secrets and
 * bounded BEFORE it becomes a result, because a result is persisted on the
 * run receipt, broadcast over SSE and shown in the UI as is. A `gh auth
 * status` that echoes a token, or a curl that prints a bearer header, must
 * not put it on disk. */
import { spawn, type ChildProcess } from "node:child_process";

import {
  WORKFLOW_PREFLIGHT_OUTPUT_MAX,
  WORKFLOW_PREFLIGHT_TIMEOUT_DEFAULT_S,
  type Workflow,
  type WorkflowPreflightCheck,
  type WorkflowPreflightCheckResult,
  type WorkflowPreflightResult,
} from "../shared/workflow.ts";
import { augmentedPath } from "./env-path.ts";
import { killCliTree } from "./procs.ts";
import { redactSecretsInText } from "./redact.ts";

type CommandCheck = Extract<WorkflowPreflightCheck, { kind: "command" }>;

/** What running a command came to. `exitCode` is null when the process
 * never ran (`error`) or was killed (`signal`); `timedOut` says the kill
 * was the deadline's. */
export interface PreflightCommandOutcome {
  exitCode: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export type PreflightCommandRunner = (check: CommandCheck, signal: AbortSignal) => Promise<PreflightCommandOutcome>;

/** The driver's verdict on a bot's engine: reachable and signed in, or
 * why not. Must cost no tokens — a version probe and a login check. */
export interface PreflightEngineHealth {
  ok: boolean;
  detail: string;
}

export interface PreflightEnvironment {
  /** Same lookup the engine dispatches on. */
  botState: (botId: string) => "ready" | "busy" | "missing";
  /** Absent: an engine-health check fails closed — a check that cannot be
   * performed must not pass. */
  engineHealth?: (botId: string) => Promise<PreflightEngineHealth>;
  /** Absent: the real child-process runner below. */
  runCommand?: PreflightCommandRunner;
  now?: () => number;
}

/** Everything a check prints goes through here before it is kept: secrets
 * masked FIRST (a truncation could otherwise cut a token into a prefix the
 * scrubber no longer recognises), then bounded. */
export function maskPreflightOutput(text: string): string {
  const masked = redactSecretsInText(text.trim());
  return masked.length > WORKFLOW_PREFLIGHT_OUTPUT_MAX ? `${masked.slice(0, WORKFLOW_PREFLIGHT_OUTPUT_MAX)}…` : masked;
}

/** Bounded capture: a check that streams megabytes must not hold them in
 * memory for the sake of a 500-char excerpt. */
const CAPTURE_MAX = 64 * 1024;

/** The default runner: `/bin/sh -c <command>` (cmd.exe on Windows), no
 * TTY, stdin closed, the server's own environment plus the app's augmented
 * PATH — a GUI app's PATH does not know where `gh` lives, and the check
 * would fail for that alone. Its own process group on POSIX, so the
 * deadline's kill reaps whatever the shell started. The command string is
 * the one the author saved and nothing else: no run input, no webhook
 * payload, no template is ever folded into it. */
export const runPreflightCommand: PreflightCommandRunner = (check, signal) =>
  new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(check.command, {
        shell: true,
        cwd: check.cwd,
        env: { ...process.env, PATH: augmentedPath() },
        stdio: ["ignore", "pipe", "pipe"],
        ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, error: errorMessage(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const settle = (outcome: Omit<PreflightCommandOutcome, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve({ ...outcome, stdout, stderr, timedOut });
    };
    const onAbort = () => {
      timedOut = true;
      void killCliTree(child);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < CAPTURE_MAX) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < CAPTURE_MAX) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => settle({ exitCode: null, error: errorMessage(error) }));
    child.on("close", (code, killedBy) => settle({ exitCode: code, signal: killedBy }));
  });

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The bots a `bots-ready` check with no list means: every agent node's,
 * in graph order, once each. */
export function preflightBotIds(workflow: Pick<Workflow, "nodes">): string[] {
  const ids: string[] = [];
  for (const node of workflow.nodes) {
    if (node.kind === "agent" && !ids.includes(node.botId)) ids.push(node.botId);
  }
  return ids;
}

function judgeCommand(check: CommandCheck, outcome: PreflightCommandOutcome, timeoutSeconds: number): Omit<WorkflowPreflightCheckResult, "durationMs"> {
  const base = {
    name: check.name,
    kind: check.kind,
    ...(outcome.stdout.trim() === "" ? {} : { stdout: maskPreflightOutput(outcome.stdout) }),
    ...(outcome.stderr.trim() === "" ? {} : { stderr: maskPreflightOutput(outcome.stderr) }),
  };
  if (outcome.timedOut) return { ...base, ok: false, detail: `timed out after ${timeoutSeconds}s` };
  if (outcome.error !== undefined) return { ...base, ok: false, detail: `could not start: ${outcome.error}` };
  const expected = check.expectExitCode ?? 0;
  if (outcome.exitCode === null) {
    return { ...base, ok: false, detail: `killed by ${outcome.signal ?? "a signal"} before it exited` };
  }
  if (outcome.exitCode !== expected) {
    return { ...base, ok: false, detail: `exited with code ${outcome.exitCode} (expected ${expected})` };
  }
  if (check.expectStdoutMatch !== undefined) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(check.expectStdoutMatch);
    } catch {
      // The validator refuses this shape; a hand-edited file can still
      // carry it, and a check that cannot be judged must not pass.
      return { ...base, ok: false, detail: `expectStdoutMatch is not a valid regular expression` };
    }
    if (!pattern.test(outcome.stdout)) {
      return { ...base, ok: false, detail: `exited with code ${outcome.exitCode} but stdout did not match /${check.expectStdoutMatch}/` };
    }
  }
  return { ...base, ok: true, detail: `exited with code ${outcome.exitCode}` };
}

function judgeBots(
  check: Extract<WorkflowPreflightCheck, { kind: "bots-ready" }>,
  workflow: Pick<Workflow, "nodes">,
  botState: PreflightEnvironment["botState"],
): Omit<WorkflowPreflightCheckResult, "durationMs"> {
  const ids = check.botIds ?? preflightBotIds(workflow);
  const problems: string[] = [];
  for (const botId of ids) {
    const state = botState(botId);
    if (state === "missing") problems.push(`bot "${botId}" does not exist`);
    else if (state === "busy") problems.push(`bot "${botId}" is busy`);
  }
  if (problems.length > 0) return { name: check.name, kind: check.kind, ok: false, detail: problems.join("; ") };
  return {
    name: check.name,
    kind: check.kind,
    ok: true,
    detail: ids.length === 0 ? "no bots to check" : `${ids.length} ${ids.length === 1 ? "bot" : "bots"} ready`,
  };
}

/** Run every check of `workflow.preflight` in parallel under one deadline.
 * A check still unanswered at the deadline is a failure that says so; the
 * command runner is told (through the signal) so it can kill its child.
 * Never throws: a runner or a health hook that throws is that check's
 * failure, never the run's crash. */
export async function runWorkflowPreflight(
  workflow: Pick<Workflow, "nodes" | "preflight">,
  environment: PreflightEnvironment,
): Promise<WorkflowPreflightResult> {
  const now = environment.now ?? Date.now;
  const at = now();
  const checks = workflow.preflight?.checks ?? [];
  const timeoutSeconds = workflow.preflight?.timeoutSeconds ?? WORKFLOW_PREFLIGHT_TIMEOUT_DEFAULT_S;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);
  timer.unref?.();
  // The deadline as a promise every async check races against, so a hook
  // that ignores the signal still cannot hold the run past it.
  const deadline = new Promise<"timeout">((resolve) => {
    controller.signal.addEventListener("abort", () => resolve("timeout"), { once: true });
  });
  const runOne = async (check: WorkflowPreflightCheck): Promise<WorkflowPreflightCheckResult> => {
    const started = performance.now();
    const finish = (verdict: Omit<WorkflowPreflightCheckResult, "durationMs">): WorkflowPreflightCheckResult => ({
      ...verdict,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    });
    const timedOut = (): WorkflowPreflightCheckResult =>
      finish({ name: check.name, kind: check.kind, ok: false, detail: `timed out after ${timeoutSeconds}s` });
    try {
      if (check.kind === "bots-ready") return finish(judgeBots(check, workflow, environment.botState));
      if (check.kind === "engine-health") {
        const health = environment.engineHealth;
        if (!health) {
          return finish({ name: check.name, kind: check.kind, ok: false, detail: "engine health is not available in this build" });
        }
        // Fail closed on a hook that never answers; its late rejection is
        // swallowed so it cannot surface as an unhandled one.
        const asked = health(check.botId);
        asked.catch(() => {});
        const answer = await Promise.race([asked, deadline]);
        if (answer === "timeout") return timedOut();
        return finish({ name: check.name, kind: check.kind, ok: answer.ok, detail: maskPreflightOutput(answer.detail) });
      }
      const run = environment.runCommand ?? runPreflightCommand;
      const asked = run(check, controller.signal);
      asked.catch(() => {});
      const outcome = await Promise.race([asked, deadline]);
      if (outcome === "timeout") return timedOut();
      return finish(judgeCommand(check, outcome, timeoutSeconds));
    } catch (error) {
      return finish({ name: check.name, kind: check.kind, ok: false, detail: maskPreflightOutput(`check failed: ${errorMessage(error)}`) });
    }
  };
  try {
    const results = await Promise.all(checks.map(runOne));
    return { at, ok: results.every((result) => result.ok), checks: results };
  } finally {
    clearTimeout(timer);
  }
}

/** One wording for the run's `error` and its notification when the
 * pre-flight refuses a start: the first failed check, by name, and why. */
export function preflightRefusal(result: WorkflowPreflightResult): string {
  const failed = result.checks.filter((check) => !check.ok);
  const first = failed[0];
  if (!first) return "pre-flight failed";
  const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : "";
  return `pre-flight check "${first.name}" failed: ${first.detail}${more}`;
}
