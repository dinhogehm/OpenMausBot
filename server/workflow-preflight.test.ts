// The pre-flight runner: real child processes for the command check (this
// is the one place the real runner is exercised — the engine tests inject a
// fake), fakes for the bot roster and the driver snapshot, and the output
// discipline that keeps a token a check echoes off the run receipt.
import { describe, expect, it, vi } from "vitest";

import {
  WORKFLOW_PREFLIGHT_OUTPUT_MAX,
  type Workflow,
  type WorkflowNode,
  type WorkflowPreflightCheck,
} from "../shared/workflow.ts";
import {
  maskPreflightOutput,
  PREFLIGHT_MATCH_MAX,
  preflightBotIds,
  preflightRefusal,
  runPreflightCommand,
  runWorkflowPreflight,
  type PreflightCommandOutcome,
  type PreflightEnvironment,
} from "./workflow-preflight.ts";

/** `node -e` is the one program every test machine has; `process.exit`
 * and `console.log` are the whole vocabulary the checks need. */
const node = (script: string) => `node -e ${JSON.stringify(script)}`;

const nodes: WorkflowNode[] = [
  { kind: "agent", id: "plan", botId: "planner", instructions: "", outcomes: ["done"] },
  { kind: "agent", id: "ship", botId: "shipper", instructions: "", outcomes: ["done"] },
  { kind: "agent", id: "again", botId: "planner", instructions: "", outcomes: ["done"] },
  { kind: "wait", id: "pause", minutes: 5 },
];

const workflow = (checks: WorkflowPreflightCheck[], timeoutSeconds?: number): Pick<Workflow, "nodes" | "preflight"> => ({
  nodes,
  preflight: { checks, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) },
});

const ready: PreflightEnvironment = { botState: () => "ready" };

describe("preflightBotIds", () => {
  it("lists every agent node's bot in graph order, once each, ignoring other kinds", () => {
    expect(preflightBotIds({ nodes })).toEqual(["planner", "shipper"]);
    expect(preflightBotIds({ nodes: [] })).toEqual([]);
  });
});

describe("maskPreflightOutput", () => {
  it("masks GitHub, OpenAI-style and bearer tokens, then bounds the text", () => {
    const masked = maskPreflightOutput(
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123 and sk-abcdefghijklmnopqrstuvwxyz and Authorization: Bearer abcdef.ghijkl-mnop\n",
    );
    expect(masked).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(masked).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(masked).not.toContain("abcdef.ghijkl-mnop");
    expect(masked).toContain("Bearer ");
    expect(masked).toContain("redacted");
  });

  it("truncates to the receipt's bound with an ellipsis, after masking", () => {
    const long = `${"x".repeat(WORKFLOW_PREFLIGHT_OUTPUT_MAX + 50)}ghp_abcdefghijklmnopqrstuvwxyz0123`;
    const masked = maskPreflightOutput(long);
    expect(masked).toHaveLength(WORKFLOW_PREFLIGHT_OUTPUT_MAX + 1);
    expect(masked.endsWith("…")).toBe(true);
    expect(maskPreflightOutput("short")).toBe("short");
  });
});

describe("runPreflightCommand", () => {
  it("runs the command through a non-interactive shell with the inherited environment and captures both streams", async () => {
    process.env.OMB_PREFLIGHT_PROBE = "inherited";
    try {
      const controller = new AbortController();
      const outcome = await runPreflightCommand(
        { kind: "command", name: "env", command: node("console.log(process.env.OMB_PREFLIGHT_PROBE); console.error('warn'); process.exit(3)") },
        controller.signal,
      );
      expect(outcome).toMatchObject({ exitCode: 3, timedOut: false });
      expect(outcome.stdout.trim()).toBe("inherited");
      expect(outcome.stderr.trim()).toBe("warn");
    } finally {
      delete process.env.OMB_PREFLIGHT_PROBE;
    }
  });

  it("honours cwd", async () => {
    const outcome = await runPreflightCommand(
      { kind: "command", name: "cwd", command: node("console.log(process.cwd())"), cwd: process.cwd() },
      new AbortController().signal,
    );
    expect(outcome.stdout.trim()).toBe(process.cwd());
  });

  it("reports a program that could not start rather than throwing", async () => {
    const outcome = await runPreflightCommand(
      { kind: "command", name: "nope", command: "definitely-not-a-program-omb-preflight" },
      new AbortController().signal,
    );
    expect(outcome.timedOut).toBe(false);
    // A shell reports a missing program as exit 127; a failed spawn as an error.
    expect(outcome.exitCode === 127 || outcome.error !== undefined).toBe(true);
  });

  it("keeps what the child printed before the deadline killed it", async () => {
    const controller = new AbortController();
    const started = runPreflightCommand(
      { kind: "command", name: "diag", command: node("console.log('diagnostic-line'); setTimeout(() => {}, 30000)") },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 300);
    const outcome = await started;
    expect(outcome.timedOut).toBe(true);
    expect(outcome.stdout.trim()).toBe("diagnostic-line");
  });

  it.skipIf(process.platform === "win32")("escalates to SIGKILL on the group when the shell ignores TERM", async () => {
    const controller = new AbortController();
    const started = runPreflightCommand(
      { kind: "command", name: "stubborn", command: "trap '' TERM; sleep 777" },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 200);
    const at = performance.now();
    const outcome = await started;
    expect(outcome.timedOut).toBe(true);
    // killCliTree waits up to 5 s for TERM to land before the escalation.
    expect(performance.now() - at).toBeLessThan(12_000);
  }, 20_000);

  it("kills the child when the signal aborts and says the kill was the deadline's", async () => {
    const controller = new AbortController();
    const started = runPreflightCommand(
      { kind: "command", name: "sleep", command: node("setTimeout(() => {}, 30000)") },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);
    const outcome = await started;
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode === null || outcome.exitCode !== 0).toBe(true);
  });
});

describe("runWorkflowPreflight", () => {
  it("passes an empty check list at once", async () => {
    const result = await runWorkflowPreflight(workflow([]), { ...ready, now: () => 42 });
    expect(result).toEqual({ at: 42, ok: true, checks: [] });
  });

  it("judges a command by exit code — the expected one by default zero — and keeps its output", async () => {
    const result = await runWorkflowPreflight(
      workflow([
        { kind: "command", name: "ok", command: node("console.log('fine')") },
        { kind: "command", name: "expects one", command: node("process.exit(1)"), expectExitCode: 1 },
        { kind: "command", name: "fails", command: node("console.error('no token'); process.exit(2)") },
      ]),
      ready,
    );
    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => [check.name, check.ok, check.detail])).toEqual([
      ["ok", true, "exited with code 0"],
      ["expects one", true, "exited with code 1"],
      ["fails", false, "exited with code 2 (expected 0)"],
    ]);
    expect(result.checks[0]).toMatchObject({ kind: "command", stdout: "fine" });
    expect(result.checks[0]!.stderr).toBeUndefined();
    expect(result.checks[2]).toMatchObject({ stderr: "no token" });
    for (const check of result.checks) expect(check.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("judges stdout against expectStdoutMatch — an empty stdout is asserted with ^$", async () => {
    const result = await runWorkflowPreflight(
      workflow([
        { kind: "command", name: "clean", command: node("process.exit(0)"), expectStdoutMatch: "^$" },
        { kind: "command", name: "dirty", command: node("console.log(' M server/index.ts')"), expectStdoutMatch: "^$" },
        { kind: "command", name: "login", command: node("console.log('Logged in as ada')"), expectStdoutMatch: "Logged in" },
      ]),
      ready,
    );
    expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
      ["clean", true],
      ["dirty", false],
      ["login", true],
    ]);
    expect(result.checks[1]!.detail).toBe("exited with code 0 but stdout did not match /^$/");
  });

  it("masks secrets a command prints before they reach the result", async () => {
    const result = await runWorkflowPreflight(
      workflow([
        {
          kind: "command",
          name: "leaky",
          command: node("console.log('GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123'); console.error('Bearer abcdefghijklmnop')"),
        },
      ]),
      ready,
    );
    const [check] = result.checks;
    expect(check!.ok).toBe(true);
    expect(JSON.stringify(check)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(JSON.stringify(check)).not.toContain("abcdefghijklmnop");
  });

  it("runs the checks in parallel under one deadline: a hung command times out, the others still answer", async () => {
    const started = performance.now();
    const result = await runWorkflowPreflight(
      workflow(
        [
          { kind: "command", name: "hang", command: node("setTimeout(() => {}, 60000)") },
          { kind: "command", name: "quick", command: node("process.exit(0)") },
          { kind: "bots-ready", name: "bots" },
        ],
        5,
      ),
      // The deadline is the workflow's; the test only shortens it through
      // a runner that never resolves and a hand-driven signal would not
      // prove the child is killed, so the real runner is used with the
      // smallest legal timeout.
      ready,
    );
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => [check.name, check.ok, check.detail])).toEqual([
      ["hang", false, "timed out after 5s"],
      ["quick", true, "exited with code 0"],
      ["bots", true, "2 bots ready"],
    ]);
  }, 20_000);

  it("a check that timed out still carries the output it had printed, masked", async () => {
    const result = await runWorkflowPreflight(
      workflow(
        [
          {
            kind: "command",
            name: "slow gh",
            command: node("console.log('Logged in with token ghp_abcdefghijklmnopqrstuvwxyz0123, scopes: read:project'); setTimeout(() => {}, 60000)"),
          },
        ],
        5,
      ),
      ready,
    );
    const [check] = result.checks;
    expect(check).toMatchObject({ ok: false, detail: "timed out after 5s" });
    expect(check!.stdout).toContain("scopes: read:project");
    expect(check!.stdout).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  }, 20_000);

  it("tests expectStdoutMatch against the first 16 KB of stdout only", async () => {
    const result = await runWorkflowPreflight(
      workflow([
        {
          kind: "command",
          name: "late needle",
          command: node(`process.stdout.write('x'.repeat(${PREFLIGHT_MATCH_MAX + 10}) + 'NEEDLE')`),
          expectStdoutMatch: "NEEDLE",
        },
        {
          kind: "command",
          name: "early needle",
          command: node("process.stdout.write('NEEDLE' + 'x'.repeat(100))"),
          expectStdoutMatch: "NEEDLE",
        },
      ]),
      ready,
    );
    expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
      ["late needle", false],
      ["early needle", true],
    ]);
  });

  it("times out a health hook that never answers instead of holding the run", async () => {
    const result = await runWorkflowPreflight(workflow([{ kind: "engine-health", name: "engine", botId: "planner" }], 5), {
      ...ready,
      engineHealth: () => new Promise(() => {}),
    });
    expect(result.checks[0]).toMatchObject({ ok: false, detail: "timed out after 5s" });
  }, 20_000);

  it("bots-ready checks every agent node's bot by default, or only the ones listed, and names each problem", async () => {
    const botState = (botId: string) => (botId === "shipper" ? "busy" : botId === "ghost" ? "missing" : "ready");
    const result = await runWorkflowPreflight(
      workflow([
        { kind: "bots-ready", name: "all" },
        { kind: "bots-ready", name: "planner only", botIds: ["planner"] },
        { kind: "bots-ready", name: "ghost", botIds: ["ghost", "shipper"] },
      ]),
      { botState },
    );
    expect(result.checks.map((check) => [check.name, check.ok, check.detail])).toEqual([
      ["all", false, 'bot "shipper" is busy'],
      ["planner only", true, "1 bot ready"],
      ["ghost", false, 'bot "ghost" does not exist; bot "shipper" is busy'],
    ]);
    // Only busy: transient, the engine's to wait out. A missing bot in
    // the mix makes the whole check terminal.
    expect(result.checks[0]!.transient).toBe(true);
    expect(result.checks[2]!.transient).toBeUndefined();
    expect(result.checks[1]!.transient).toBeUndefined();
  });

  it("bots-ready passes a workflow with no agent nodes", async () => {
    const result = await runWorkflowPreflight({ nodes: [], preflight: { checks: [{ kind: "bots-ready", name: "none" }] } }, ready);
    expect(result.checks[0]).toMatchObject({ ok: true, detail: "no bots to check" });
  });

  it("engine-health asks the hook and relays its verdict; without a hook it fails closed", async () => {
    const engineHealth = vi.fn(async (botId: string) =>
      botId === "planner" ? { ok: true, detail: 'engine "codex" ready (1.2.3)' } : { ok: false, detail: 'engine "claude" is not signed in' },
    );
    const withHook = await runWorkflowPreflight(
      workflow([
        { kind: "engine-health", name: "codex", botId: "planner" },
        { kind: "engine-health", name: "claude", botId: "shipper" },
      ]),
      { ...ready, engineHealth },
    );
    expect(withHook.checks.map((check) => [check.ok, check.detail])).toEqual([
      [true, 'engine "codex" ready (1.2.3)'],
      [false, 'engine "claude" is not signed in'],
    ]);
    expect(engineHealth).toHaveBeenCalledTimes(2);
    const without = await runWorkflowPreflight(workflow([{ kind: "engine-health", name: "codex", botId: "planner" }]), ready);
    expect(without.checks[0]).toMatchObject({ ok: false, detail: "engine health is not available in this build" });
  });

  it("a hook or runner that throws is that check's failure, never the run's crash", async () => {
    const runCommand = vi.fn(async () => {
      throw new Error("spawn exploded with token ghp_abcdefghijklmnopqrstuvwxyz0123");
    });
    const result = await runWorkflowPreflight(
      workflow([
        { kind: "command", name: "boom", command: "x" },
        { kind: "engine-health", name: "health", botId: "planner" },
      ]),
      {
        ...ready,
        runCommand,
        engineHealth: async () => {
          throw new Error("registry gone");
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0]!.detail).toMatch(/^check failed: spawn exploded/);
    expect(result.checks[0]!.detail).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(result.checks[1]!.detail).toBe("check failed: registry gone");
  });

  it("uses the injected runner, handing it the check and the deadline's signal", async () => {
    const runCommand = vi.fn(
      async (check: Extract<WorkflowPreflightCheck, { kind: "command" }>, signal: AbortSignal): Promise<PreflightCommandOutcome> => {
        expect(signal.aborted).toBe(false);
        return { exitCode: check.name === "a" ? 0 : 1, stdout: "", stderr: "", timedOut: false };
      },
    );
    const result = await runWorkflowPreflight(
      workflow([
        { kind: "command", name: "a", command: "true" },
        { kind: "command", name: "b", command: "false" },
      ]),
      { ...ready, runCommand },
    );
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(result.checks.map((check) => check.ok)).toEqual([true, false]);
  });
});

describe("preflightRefusal", () => {
  it("names the first failed check and counts the rest", () => {
    const base = { kind: "command" as const, durationMs: 1 };
    expect(
      preflightRefusal({
        at: 0,
        ok: false,
        checks: [
          { ...base, name: "ok", ok: true, detail: "exited with code 0" },
          { ...base, name: "gh", ok: false, detail: "exited with code 1 (expected 0)" },
          { ...base, name: "git", ok: false, detail: "stdout did not match" },
        ],
      }),
    ).toBe('pre-flight check "gh" failed: exited with code 1 (expected 0) (and 1 more)');
    expect(preflightRefusal({ at: 0, ok: false, checks: [{ ...base, name: "only", ok: false, detail: "x" }] })).toBe(
      'pre-flight check "only" failed: x',
    );
  });
});
