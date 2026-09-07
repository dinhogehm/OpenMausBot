// Provider resilience: a run must survive the provider going away for
// longer than the node's retries would allow, wait it out with a long
// backoff that spends none of them, hand the node to a fallback bot on
// another engine when there is one, and pick the wait back up after a
// restart. Fake timers drive the engine's own 10s reconciler, so what is
// exercised is the real tick, not a hand-called one. Real WorkflowStore
// over throwaway temp dirs, as workflow-run.test.ts does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WORKFLOW_CONTROL_CLOSE,
  WORKFLOW_CONTROL_OPEN,
  workflowOutageWaitMessage,
  type BotCapabilities,
  type WorkflowNotificationKind,
} from "../shared/workflow.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { WorkflowEngine } from "./workflow-run.ts";
import { WorkflowStore, type WorkflowInput } from "./workflow-store.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;
const CODEX_404 =
  "unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: 8f3a1b2c4d5e6f70-GRU";

const dirs: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface CapturedDispatch {
  botId: string;
  threadId: string;
  prompt: string;
  onDispatchError: (message: string) => void;
}

/** planner runs on "codex", spare on "claude" — the shape the fallback is
 * for. Everything is overridable per test. */
function harness({ engineLookup = true }: { engineLookup?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-outage-"));
  dirs.push(dir);
  const file = join(dir, "workflows.json");
  const runsFile = join(dir, "workflow-runs.json");
  const engines: Record<string, string | null> = { planner: "codex", spare: "claude", twin: "codex" };
  const states: Record<string, "ready" | "busy" | "missing"> = {};
  /** Absent means "a bot with no flags"; an explicit null is a bot the
   * roster does not have. */
  const capabilities: Record<string, BotCapabilities | null> = {};
  const notifications: Array<{ runId: string; message: string; kind: WorkflowNotificationKind }> = [];
  const build = (prefix: string) => {
    const store = new WorkflowStore({ file, runsFile });
    const dispatches: CapturedDispatch[] = [];
    const interrupts: Array<{ botId: string; threadId: string }> = [];
    let seq = 0;
    const engine = new WorkflowEngine({
      store,
      random: () => 0.5, // jitter-free, so every wait is exact
      botState: (botId) => states[botId] ?? "ready",
      botCapabilities: (botId) => (botId in capabilities ? capabilities[botId]! : {}),
      ...(engineLookup ? { botEngine: (botId: string) => engines[botId] ?? null } : {}),
      createTask: () => ({ threadId: `${prefix}-${++seq}` }),
      startTurn: (botId, threadId, prompt, onDispatchError) => {
        dispatches.push({ botId, threadId, prompt, onDispatchError });
        return Promise.resolve();
      },
      interruptTurn: (botId, threadId) => {
        interrupts.push({ botId, threadId });
        return Promise.resolve();
      },
      notifyUser: (run, message, kind) => {
        notifications.push({ runId: run.id, message, kind });
      },
    });
    let eventSeq = 0;
    const base = (threadId: string) => ({
      eventId: `${prefix}-e${++eventSeq}`,
      provider: "fake",
      threadId,
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    const completeTurn = (threadId: string, text: string) => {
      engine.handleRuntimeEvent({ ...base(threadId), type: "item.completed", itemType: "assistant_text", text } satisfies RuntimeEvent);
      engine.handleRuntimeEvent({ ...base(threadId), type: "turn.completed", ok: true } satisfies RuntimeEvent);
    };
    /** A not-ok turn as the drivers end one: an optional runtime.error
     * (message, setup) followed by turn.completed with a stop reason. */
    const failTurn = (
      threadId: string,
      failure: { stopReason?: string; message?: string; setup?: boolean },
    ) => {
      if (failure.message !== undefined) {
        engine.handleRuntimeEvent({
          ...base(threadId),
          type: "runtime.error",
          message: failure.message,
          ...(failure.setup === undefined ? {} : { setup: failure.setup }),
        } satisfies RuntimeEvent);
      }
      engine.handleRuntimeEvent({
        ...base(threadId),
        type: "turn.completed",
        ok: false,
        ...(failure.stopReason === undefined ? {} : { stopReason: failure.stopReason }),
      } satisfies RuntimeEvent);
    };
    /** A runtime.error with the turn still live — what codex relays for a
     * stream error it retries itself. */
    const runtimeError = (threadId: string, message: string) => {
      engine.handleRuntimeEvent({ ...base(threadId), type: "runtime.error", message } satisfies RuntimeEvent);
    };
    return { store, engine, dispatches, interrupts, completeTurn, failTurn, runtimeError };
  };
  const first = build("thread");
  return {
    ...first,
    notifications,
    /** A process restart: fresh engine and store over the same files. */
    restart: () => build("re-thread"),
    setState: (botId: string, state: "ready" | "busy" | "missing") => (states[botId] = state),
    setCapabilities: (botId: string, flags: BotCapabilities | null) => (capabilities[botId] = flags),
    setEngine: (botId: string, instanceId: string | null) => (engines[botId] = instanceId),
  };
}

const envelope = (outcome: string, summary = "did the thing") =>
  `Done.\n${WORKFLOW_CONTROL_OPEN}{"outcome":"${outcome}","summary":"${summary}"}${WORKFLOW_CONTROL_CLOSE}`;

/** plan --done--> ship (sink); plan --failed--> report (sink). retries: 0 on
 * plan, so ONE ordinary failure is terminal — which is what proves an
 * outage wait costs nothing. */
const pipeline = (overrides: Partial<WorkflowInput> = {}, plan: Record<string, unknown> = {}): WorkflowInput => ({
  name: "Release",
  entryNodeId: "plan",
  nodes: [
    { kind: "agent", id: "plan", botId: "planner", instructions: "Plan.", outcomes: ["done"], retries: 0, ...plan },
    { kind: "agent", id: "ship", botId: "shipper", instructions: "Ship.", outcomes: ["shipped"] },
    { kind: "agent", id: "report", botId: "shipper", instructions: "Report.", outcomes: ["reported"] },
  ],
  edges: [
    { from: "plan", outcome: "done", to: "ship" },
    { from: "plan", outcome: "failed", to: "report" },
  ],
  layout: {},
  ...overrides,
});

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("provider outage — entering the wait", () => {
  it("parks the run on a one-minute wait without spending an attempt, and re-dispatches when due", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline());
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    expect(h.dispatches).toHaveLength(1);

    h.dispatches[0]!.onDispatchError(CODEX_404);

    const waiting = h.store.getRun(run.id)!;
    expect(waiting.status).toBe("running");
    expect(waiting.attempt).toBe(0);
    expect(waiting.currentNodeId).toBe("plan");
    expect(waiting.currentThreadId).toBeUndefined();
    expect(waiting.currentBotId).toBeUndefined();
    expect(waiting.nextAttemptAt).toBe(T0 + MIN);
    expect(waiting.outage).toEqual({
      since: T0,
      until: T0 + 6 * HOUR,
      attempts: 1,
      of: 10,
      reason: CODEX_404,
      waitUntil: T0 + MIN, // the pending backoff, for the watchdog's exemption
    });
    expect(workflowOutageWaitMessage(waiting, (at) => `@${at - T0}`)).toBe(
      "Waiting for the provider: next attempt @60000 (attempt 1 of 10)",
    );
    // Waiting is not a failure — but the first wait is announced once, so
    // the operator knows the run is parked and for how long at most.
    expect(h.notifications.map((n) => n.kind)).toEqual(["outage"]);
    expect(h.notifications[0]!.message).toBe(
      `Workflow "Release" is waiting out a provider outage at node "plan": next attempt in 1m, giving up after 6h — ${CODEX_404}`,
    );

    await tick(50_000);
    expect(h.dispatches).toHaveLength(1); // not due yet
    await tick(20_000);
    expect(h.dispatches).toHaveLength(2);
    expect(h.dispatches[1]!.botId).toBe("planner");
    const redispatched = h.store.getRun(run.id)!;
    expect(redispatched.attempt).toBe(0);
    expect(redispatched.nextAttemptAt).toBeUndefined();
    expect(redispatched.outage?.attempts).toBe(1); // the wait is over, the outage is not known to be
    h.engine.stop();
  });

  it("a codex turn/completed carrying the backend 404 as its stop reason enters the wait", () => {
    const h = harness();
    const workflow = h.store.create(pipeline());
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.failTurn(h.dispatches[0]!.threadId, { stopReason: CODEX_404 });
    const waiting = h.store.getRun(run.id)!;
    expect(waiting.status).toBe("running");
    expect(waiting.attempt).toBe(0);
    expect(waiting.outage?.reason).toBe(CODEX_404);
    expect(waiting.nextAttemptAt).toBe(T0 + MIN);
  });

  it("a codex launch failure — the 503 on runtime.error, rpc_error as the stop reason — enters the wait with the real message", () => {
    const h = harness();
    const workflow = h.store.create(pipeline());
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.failTurn(h.dispatches[0]!.threadId, {
      stopReason: "rpc_error",
      message: "unexpected status 503 Service Unavailable, url: https://chatgpt.com/backend-api/codex/responses",
    });
    const waiting = h.store.getRun(run.id)!;
    expect(waiting.attempt).toBe(0);
    expect(waiting.outage?.reason).toBe(
      "unexpected status 503 Service Unavailable, url: https://chatgpt.com/backend-api/codex/responses (rpc_error)",
    );
  });

  it("a claude CLI death with a dropped socket in stderr, settled as exit_before_result, enters the wait", () => {
    const h = harness();
    const workflow = h.store.create(pipeline());
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.failTurn(h.dispatches[0]!.threadId, {
      stopReason: "exit_before_result",
      message: "claude exited 1 before result: TypeError: fetch failed",
    });
    expect(h.store.getRun(run.id)!.outage?.reason).toBe("claude exited 1 before result: TypeError: fetch failed (exit_before_result)");
    expect(h.store.getRun(run.id)!.attempt).toBe(0);
  });

  it.each([
    [
      "a claude CLI death over a bad API key, settled as exit_before_result",
      { stopReason: "exit_before_result", message: "claude exited 1 before result: Invalid API key · Please run /login" },
    ],
    [
      "a codex auth failure the driver flagged as setup",
      { stopReason: "auth_required", message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", setup: true },
    ],
    ["a bare exit_before_result with nothing said", { stopReason: "exit_before_result" }],
    ["a bare rpc_error with nothing said", { stopReason: "rpc_error" }],
    ["a pi close with no stop reason and no runtime.error", {}],
    ["a model that does not exist", { stopReason: "rpc_error", message: "unexpected status 400 Bad Request: model not found" }],
  ])("%s is charged to the node, never waited out or handed to the fallback", (_case, failure) => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare", retries: 1 }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.failTurn(h.dispatches[0]!.threadId, failure);
    const charged = h.store.getRun(run.id)!;
    expect(charged.status).toBe("running");
    expect(charged.attempt).toBe(1);
    expect(charged.outage).toBeUndefined();
    expect(charged.nextAttemptAt).toBe(T0 + MIN); // the linear retry, not the outage wait
    expect(h.dispatches).toHaveLength(1); // no hand-off
  });

  it("records the real message, not the bare code, on the failed edge once retries are spent", () => {
    const h = harness();
    const workflow = h.store.create(pipeline());
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.failTurn(h.dispatches[0]!.threadId, {
      stopReason: "exit_before_result",
      message: "claude exited 1 before result: Invalid API key · Please run /login",
    });
    const failed = h.store.getRun(run.id)!;
    expect(failed.currentNodeId).toBe("report");
    expect(failed.nodeResults[0]!.summary).toBe(
      "claude exited 1 before result: Invalid API key · Please run /login (exit_before_result)",
    );
  });

  it("clears the outage when the provider comes back and the node completes", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline());
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    await tick(MIN);
    h.completeTurn(h.dispatches[1]!.threadId, envelope("done"));

    const advanced = h.store.getRun(run.id)!;
    expect(advanced.currentNodeId).toBe("ship");
    expect(advanced.outage).toBeUndefined();
    expect(advanced.nodeResults[0]).toMatchObject({ nodeId: "plan", outcome: "done" });
    expect(advanced.nodeResults[0]!.fallback).toBeUndefined();
    h.engine.stop();
  });

  it("an ordinary failure after the provider answered ends the outage and is charged as usual", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { retries: 2 }));
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    await tick(MIN);
    h.failTurn(h.dispatches[1]!.threadId, { stopReason: "failed", message: "pi turn failed" });

    const charged = h.store.getRun(run.id)!;
    expect(charged.status).toBe("running");
    expect(charged.attempt).toBe(1);
    expect(charged.outage).toBeUndefined();
    expect(charged.nextAttemptAt).toBe(T0 + 2 * MIN); // linear retry: +60s from now
    h.engine.stop();
  });

  it("keeps the outage through a busy re-park: contention is still not a failure", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline());
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    await tick(MIN);
    h.dispatches[1]!.onDispatchError("the bot is already working — interrupt it first");

    const parked = h.store.getRun(run.id)!;
    expect(parked.attempt).toBe(0);
    expect(parked.outage?.attempts).toBe(1);
    expect(parked.nextAttemptAt).toBe(T0 + MIN + 30_000);
    h.engine.stop();
  });

  it("the timeout sweep leaves a waiting run alone", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { timeoutMinutes: 1 }));
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    // Fail every re-dispatch the same way; the wait grows well past the
    // node's one-minute timeout without the sweep ever interrupting.
    for (let round = 0; round < 3; round++) {
      await tick(h.store.getRun(run.id)!.nextAttemptAt! - Date.now());
      h.dispatches.at(-1)!.onDispatchError(CODEX_404);
    }
    expect(h.interrupts).toEqual([]);
    expect(h.store.getRun(run.id)!.outage?.attempts).toBe(4);
    h.engine.stop();
  });
});

describe("provider outage — backoff progression and horizon", () => {
  it("doubles the wait each time (1, 2, 4, 8, 16, 32, 60, 60 min) with attempt still 0", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline());
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    const waits: number[] = [];
    for (let round = 0; round < 8; round++) {
      h.dispatches.at(-1)!.onDispatchError(CODEX_404);
      const waiting = h.store.getRun(run.id)!;
      expect(waiting.attempt).toBe(0);
      expect(waiting.outage?.attempts).toBe(round + 1);
      waits.push((waiting.nextAttemptAt! - Date.now()) / MIN);
      await tick(waiting.nextAttemptAt! - Date.now());
      expect(h.dispatches).toHaveLength(round + 2);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect(h.store.getRun(run.id)!.status).toBe("running");
    h.engine.stop();
  });

  it("honours the workflow's backoff cap", () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ providerOutage: { maxBackoffMinutes: 3 } }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    expect(h.store.getRun(run.id)!.outage?.of).toBe(121); // 1 + 2 + 3×119 = 360 ≤ 360
  });

  it("gives up through the failed edge once the next wait would pass the horizon", async () => {
    const h = harness();
    // 10-minute horizon: waits at 1, 3, 7 minutes; the fourth (8 min) would land at 15.
    const workflow = h.store.create(pipeline({ providerOutage: { horizonHours: 10 / 60 } }));
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    expect(h.store.getRun(run.id)!.nodeResults).toEqual([]);
    for (let round = 0; round < 3; round++) {
      h.dispatches.at(-1)!.onDispatchError(CODEX_404);
      expect(h.store.getRun(run.id)!.outage?.attempts).toBe(round + 1);
      await tick(h.store.getRun(run.id)!.nextAttemptAt! - Date.now());
    }
    expect(Date.now()).toBe(T0 + 7 * MIN);
    h.dispatches.at(-1)!.onDispatchError(CODEX_404);

    const failedOver = h.store.getRun(run.id)!;
    expect(failedOver.status).toBe("running");
    expect(failedOver.currentNodeId).toBe("report"); // the failed edge
    expect(failedOver.outage).toBeUndefined();
    expect(failedOver.attempt).toBe(0);
    const failure = failedOver.nodeResults[0]!;
    expect(failure).toMatchObject({ nodeId: "plan", outcome: "failed" });
    expect(failure.summary).toContain("the provider stayed unavailable for 0.1h (3 attempts)");
    expect(failure.summary).toContain("backend-api/codex/responses");
    h.engine.stop();
  });

  it("fails the run terminally, with the outage in the reason, when no failed edge is wired", async () => {
    const h = harness();
    const input = pipeline({ providerOutage: { horizonHours: 10 / 60 } });
    input.edges = input.edges.filter((edge) => edge.outcome !== "failed");
    input.nodes = input.nodes.filter((node) => node.id !== "report");
    const workflow = h.store.create(input);
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    for (let round = 0; round < 3; round++) {
      h.dispatches.at(-1)!.onDispatchError(CODEX_404);
      await tick(h.store.getRun(run.id)!.nextAttemptAt! - Date.now());
    }
    h.dispatches.at(-1)!.onDispatchError(CODEX_404);

    const failed = h.store.getRun(run.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.outage).toBeUndefined();
    expect(failed.error).toContain("the provider stayed unavailable for 0.1h (3 attempts)");
    // The first wait was announced; the spent horizon is announced ONCE,
    // as the run's failure (there is no failed edge for a separate
    // "gave up" line to precede), never twice for one event.
    expect(h.notifications.map((n) => n.kind)).toEqual(["outage", "failed"]);
    expect(h.notifications[1]!.message).toContain('at node "plan"');
    expect(h.notifications[1]!.message).toContain("the provider stayed unavailable for 0.1h (3 attempts)");
    h.engine.stop();
  });

  it("a horizon shorter than the first wait fails on the first outage error, not silently", () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ providerOutage: { horizonHours: 0.5 / 60 } }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    const over = h.store.getRun(run.id)!;
    expect(over.currentNodeId).toBe("report");
    expect(over.nodeResults[0]!.summary).toContain("(0 attempts)");
  });
});

describe("provider outage — restart mid-wait", () => {
  it("a restarted engine neither re-drives a waiting run early nor forgets how far the outage got", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline());
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    await tick(MIN);
    h.dispatches[1]!.onDispatchError(CODEX_404); // second wait: 2 minutes from now
    const before = h.store.getRun(run.id)!;
    expect(before.outage?.attempts).toBe(2);
    expect(before.nextAttemptAt).toBe(T0 + 3 * MIN);
    h.engine.stop();

    // The process dies here. The new one has empty in-memory maps.
    const re = h.restart();
    re.engine.start();
    await tick(MIN); // T0 + 2 min: a tick ran, the run is not stranded (it has a timer) and not due
    expect(re.dispatches).toHaveLength(0);
    expect(re.store.getRun(run.id)!.status).toBe("running");

    await tick(MIN); // T0 + 3 min: due
    expect(re.dispatches).toHaveLength(1);
    expect(re.dispatches[0]!.botId).toBe("planner");
    const resumed = re.store.getRun(run.id)!;
    expect(resumed.attempt).toBe(0);
    expect(resumed.outage).toMatchObject({ since: T0, until: T0 + 6 * HOUR, attempts: 2 });

    // Still down: the backoff continues from where the old process left it.
    re.dispatches[0]!.onDispatchError(CODEX_404);
    const third = re.store.getRun(run.id)!;
    expect(third.outage?.attempts).toBe(3);
    expect(third.nextAttemptAt).toBe(Date.now() + 4 * MIN);
    re.engine.stop();
  });

  it("a turn orphaned by the crash that then comes back as an outage joins the wait too", async () => {
    // The dispatch is live when the process dies; the new process finds a
    // stranded run and re-dispatches it (no attempt charged), and THAT
    // dispatch sees the outage.
    const h = harness();
    const workflow = h.store.create(pipeline());
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.engine.stop();
    const re = h.restart();
    re.engine.start();
    await tick(0);
    expect(re.dispatches).toHaveLength(1);
    re.dispatches[0]!.onDispatchError(CODEX_404);
    const waiting = re.store.getRun(run.id)!;
    expect(waiting.attempt).toBe(0);
    expect(waiting.outage?.attempts).toBe(1);
    re.engine.stop();
  });
});

describe("provider outage — fallback bot", () => {
  it("hands the node to the fallback bot at once when it is on another engine, free and able", () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare" }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);

    expect(h.dispatches).toHaveLength(2);
    expect(h.dispatches[1]!.botId).toBe("spare");
    expect(h.dispatches[1]!.threadId).not.toBe(h.dispatches[0]!.threadId); // a fresh task on the fallback
    const handed = h.store.getRun(run.id)!;
    expect(handed.status).toBe("running");
    expect(handed.attempt).toBe(0);
    expect(handed.currentBotId).toBe("spare");
    expect(handed.nextAttemptAt).toBeUndefined();
    expect(handed.outage).toMatchObject({ attempts: 0, fallbackBotId: "spare", reason: CODEX_404 });
    // The hand-off is announced — who has the node now, and why.
    expect(h.notifications).toEqual([
      {
        runId: run.id,
        kind: "fallback",
        message: `Workflow "Release" handed node "plan" to fallback bot "spare" because: ${CODEX_404}`,
      },
    ]);

    h.completeTurn(h.dispatches[1]!.threadId, envelope("done", "planned on claude"));
    const advanced = h.store.getRun(run.id)!;
    expect(advanced.currentNodeId).toBe("ship");
    expect(advanced.outage).toBeUndefined();
    expect(advanced.currentBotId).toBe("shipper");
    expect(advanced.nodeResults[0]).toMatchObject({
      nodeId: "plan",
      outcome: "done",
      summary: "planned on claude",
      fallback: { botId: "spare", because: CODEX_404 },
    });
  });

  it("the fallback's own outage joins the backoff, and the next attempt goes back to the primary — no second hand-off", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare" }));
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    h.dispatches[1]!.onDispatchError("fetch failed");

    const waiting = h.store.getRun(run.id)!;
    expect(waiting.attempt).toBe(0);
    expect(waiting.outage).toMatchObject({ attempts: 1, fallbackBotId: "spare", reason: "fetch failed" });
    expect(waiting.nextAttemptAt).toBe(T0 + MIN);
    expect(waiting.currentBotId).toBeUndefined();

    await tick(MIN);
    expect(h.dispatches).toHaveLength(3);
    expect(h.dispatches[2]!.botId).toBe("planner");
    h.dispatches[2]!.onDispatchError(CODEX_404);
    // Once per outage: the primary failing again waits, it does not hand over again.
    expect(h.dispatches).toHaveLength(3);
    expect(h.store.getRun(run.id)!.outage?.attempts).toBe(2);
    h.engine.stop();
  });

  it("an ordinary failure on the fallback is charged to the node like any other", () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare", retries: 1 }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    h.failTurn(h.dispatches[1]!.threadId, { stopReason: "failed", message: "pi turn failed" });
    const charged = h.store.getRun(run.id)!;
    expect(charged.attempt).toBe(1);
    expect(charged.outage).toBeUndefined();
    expect(charged.currentBotId).toBeUndefined();
  });

  it.each([
    ["the fallback shares the primary's engine", () => { const h = harness(); h.setEngine("spare", "codex"); return h; }],
    ["the fallback's engine is unknown", () => { const h = harness(); h.setEngine("spare", null); return h; }],
    ["the fallback is busy", () => { const h = harness(); h.setState("spare", "busy"); return h; }],
    ["the fallback no longer exists", () => { const h = harness(); h.setState("spare", "missing"); return h; }],
    ["the engine has no botEngine lookup", () => harness({ engineLookup: false })],
  ])("waits instead of handing over when %s", (_case, arrange) => {
    const h = arrange();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare" }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    expect(h.dispatches).toHaveLength(1);
    const waiting = h.store.getRun(run.id)!;
    expect(waiting.outage).toMatchObject({ attempts: 1 });
    expect(waiting.outage?.fallbackBotId).toBeUndefined();
    expect(waiting.nextAttemptAt).toBe(T0 + MIN);
  });

  it("waits when the fallback lacks a capability the node requires, and hands over when it has it", () => {
    const h = harness();
    h.setCapabilities("planner", { canDeploy: true });
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare", requires: ["deploy"] }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    expect(h.dispatches).toHaveLength(1);
    expect(h.store.getRun(run.id)!.outage?.fallbackBotId).toBeUndefined();

    const h2 = harness();
    h2.setCapabilities("planner", { canDeploy: true });
    h2.setCapabilities("spare", { canDeploy: true });
    const workflow2 = h2.store.create(pipeline({}, { fallbackBotId: "spare", requires: ["deploy"] }));
    h2.engine.startRun(workflow2.id, "go", "manual");
    h2.dispatches[0]!.onDispatchError(CODEX_404);
    expect(h2.dispatches.map((dispatch) => dispatch.botId)).toEqual(["planner", "spare"]);
  });

  it("refuses to start a run whose fallback bot the roster does not have, on the same gate as a missing capability", () => {
    const h = harness();
    h.setCapabilities("ghost", null);
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "ghost" }));
    expect(() => h.engine.startRun(workflow.id, "go", "manual")).toThrow(
      'invalid workflow: Node "plan" names a fallback bot "ghost" that does not exist.',
    );
    expect(h.dispatches).toHaveLength(0);
  });

  it("a fallback naming the node's own bot is never used", () => {
    const h = harness();
    // validateWorkflow refuses this at start, so the definition is edited
    // under a live run to reach the engine's own guard.
    const workflow = h.store.create(pipeline());
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.store.update(workflow.id, {
      nodes: workflow.nodes.map((node) => (node.id === "plan" ? { ...node, fallbackBotId: "planner" } : node)),
    });
    h.dispatches[0]!.onDispatchError(CODEX_404);
    expect(h.dispatches).toHaveLength(1);
    expect(h.store.getRun(run.id)!.outage?.fallbackBotId).toBeUndefined();
  });

  it("a timeout, an interrupt and activeRunForBot all reach the bot actually holding the node", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare", timeoutMinutes: 1, retries: 1 }));
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    const onSpare = h.dispatches[1]!;
    expect(h.engine.activeRunForBot("spare")).toEqual({ runId: run.id, threadId: onSpare.threadId });
    expect(h.engine.activeRunForBot("planner")).toBeNull();

    await tick(MIN + 10_000);
    expect(h.interrupts).toEqual([{ botId: "spare", threadId: onSpare.threadId }]);
    const timedOut = h.store.getRun(run.id)!;
    expect(timedOut.attempt).toBe(1); // a timeout is the node's own failure
    expect(timedOut.outage).toBeUndefined();
    h.engine.stop();
  });

  it("the re-prompt for a missing envelope goes to the fallback bot while it holds the node", () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare" }));
    h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    h.completeTurn(h.dispatches[1]!.threadId, "no envelope here");
    expect(h.dispatches).toHaveLength(3);
    expect(h.dispatches[2]).toMatchObject({ botId: "spare", threadId: h.dispatches[1]!.threadId });
  });

  it("cancelling a run on its fallback interrupts the fallback and clears the outage", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare" }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    const cancelled = await h.engine.cancelRun(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.outage).toBeUndefined();
    expect(h.interrupts).toEqual([{ botId: "spare", threadId: h.dispatches[1]!.threadId }]);
  });
});

describe("provider outage — fallback contention race", () => {
  it("a 409 from the fallback re-parks the run FOR the fallback, so the reconciler retries it and not the dead primary", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare" }));
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    expect(h.dispatches[1]!.botId).toBe("spare");
    // the fallback took a turn between the eligibility check and the call
    h.dispatches[1]!.onDispatchError("the bot is already working — interrupt it first");

    const parked = h.store.getRun(run.id)!;
    expect(parked.attempt).toBe(0);
    expect(parked.currentBotId).toBe("spare"); // still aimed at the fallback
    expect(parked.outage).toMatchObject({ attempts: 0, fallbackBotId: "spare" });
    expect(parked.nextAttemptAt).toBe(T0 + 30_000);

    // still busy when due: skipped, not thrown at the primary
    h.setState("spare", "busy");
    await tick(30_000);
    expect(h.dispatches).toHaveLength(2);
    expect(h.store.getRun(run.id)!.currentBotId).toBe("spare");

    h.setState("spare", "ready");
    await tick(10_000);
    expect(h.dispatches).toHaveLength(3);
    expect(h.dispatches[2]!.botId).toBe("spare");
    h.completeTurn(h.dispatches[2]!.threadId, envelope("done"));
    expect(h.store.getRun(run.id)!.nodeResults[0]).toMatchObject({
      outcome: "done",
      fallback: { botId: "spare", because: CODEX_404 },
    });
    h.engine.stop();
  });

  it("a restart while parked for the fallback re-drives it on the fallback", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare" }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    h.dispatches[1]!.onDispatchError("the bot is already working — interrupt it first");
    const re = h.restart();
    re.engine.start();
    await tick(30_000);
    expect(re.dispatches).toHaveLength(1);
    expect(re.dispatches[0]!.botId).toBe("spare");
    expect(re.store.getRun(run.id)!.currentBotId).toBe("spare");
    re.engine.stop();
  });

  it("a live fallback dispatch orphaned by a crash is re-driven on the fallback, not the primary", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare" }));
    h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    expect(h.dispatches[1]!.botId).toBe("spare");
    const re = h.restart();
    re.engine.start();
    await tick(0);
    expect(re.dispatches).toHaveLength(1);
    expect(re.dispatches[0]!.botId).toBe("spare");
    re.engine.stop();
  });

  it("the fallback busy at a re-dispatch keeps the park aimed at it", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { fallbackBotId: "spare" }));
    h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    h.setState("spare", "busy");
    // recoverStranded → dispatchNode(…, "spare") → busy branch
    const re = h.restart();
    re.engine.start();
    await tick(0);
    expect(re.dispatches).toHaveLength(0);
    const parked = re.store.listRuns(workflow.id)[0]!;
    expect(parked.currentBotId).toBe("spare");
    expect(parked.nextAttemptAt).toBeDefined();
    re.engine.stop();
  });
});

describe("provider outage — knobs edited mid-outage", () => {
  it("recomputes the horizon and 'of Z' from the workflow as it is now, keeping the outage's start", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline());
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError(CODEX_404);
    expect(h.store.getRun(run.id)!.outage).toMatchObject({ since: T0, until: T0 + 6 * HOUR, of: 10 });

    h.store.update(workflow.id, { providerOutage: { maxBackoffMinutes: 5, horizonHours: 1 } });
    await tick(MIN);
    h.dispatches[1]!.onDispatchError(CODEX_404);
    // 1+2+4 = 7, then 5-minute waits: 12 … 57, the next at 62 > 60 → 13
    expect(h.store.getRun(run.id)!.outage).toMatchObject({ since: T0, until: T0 + HOUR, of: 13, attempts: 2 });
    h.engine.stop();
  });
});

describe("provider outage — a stale runtime.error must not describe a later turn", () => {
  const STREAM_503 = "stream error: unexpected status 503 Service Unavailable, url: https://chatgpt.com/backend-api/codex/responses, retrying 1/5";

  it("the reviewer's case: stream error retried by the driver, ok turn without envelope, re-prompt, then an interrupt — charged as the node's failure, not an outage", () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { retries: 1 }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    const thread = h.dispatches[0]!.threadId;
    // turn 1: codex relayed a stream error it retried itself, then finished ok — with no envelope
    h.runtimeError(thread, STREAM_503); // runtime.error only…
    h.completeTurn(thread, "here is my answer, no envelope"); // …then an ok turn.completed
    expect(h.dispatches).toHaveLength(2); // the re-prompt, same thread
    expect(h.dispatches[1]!.threadId).toBe(thread);
    // turn 2: stopped by the harness
    h.failTurn(thread, { stopReason: "interrupted" });

    const charged = h.store.getRun(run.id)!;
    expect(charged.outage).toBeUndefined();
    expect(charged.attempt).toBe(1);
    expect(charged.nextAttemptAt).toBe(T0 + MIN);
  });

  it("an ok turn clears the thread's runtime.error, so a later not-ok turn on it is described by its own words", () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { retries: 1 }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    const thread = h.dispatches[0]!.threadId;
    h.runtimeError(thread, STREAM_503);
    h.completeTurn(thread, "no envelope");
    h.failTurn(thread, { stopReason: "failed" }); // nothing said this time
    expect(h.store.getRun(run.id)!.outage).toBeUndefined();
    expect(h.store.getRun(run.id)!.attempt).toBe(1);
  });

  it("an interrupt never enters the wait even when a real outage message was logged on the same turn", () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { retries: 1 }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.failTurn(h.dispatches[0]!.threadId, { stopReason: "interrupted", message: "fetch failed" });
    const charged = h.store.getRun(run.id)!;
    expect(charged.outage).toBeUndefined();
    expect(charged.attempt).toBe(1);
  });

  it("the timeout sweep's own interrupt is a timeout, whatever the thread logged before", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({}, { retries: 1, timeoutMinutes: 1 }));
    h.engine.start();
    const run = h.engine.startRun(workflow.id, "go", "manual");
    const thread = h.dispatches[0]!.threadId;
    h.runtimeError(thread, STREAM_503); // the turn is still live
    await tick(MIN + 10_000);
    expect(h.interrupts).toHaveLength(1);
    // the driver answers the interrupt late; the sweep already forgot the thread
    h.failTurn(thread, { stopReason: "interrupted" });
    const timedOut = h.store.getRun(run.id)!;
    expect(timedOut.outage).toBeUndefined();
    expect(timedOut.attempt).toBe(1);
    h.engine.stop();
  });
});
