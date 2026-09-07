// Integration of the 24/7 items (A–H) across a process restart: scenarios
// no single item's suite exercises because each needs two items' state on
// one receipt. Real WorkflowStore over temp files; the restart is a fresh
// engine + store over the same bytes with empty in-memory maps.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  WORKFLOW_CONTROL_CLOSE,
  WORKFLOW_CONTROL_OPEN,
  workflowRoutingFingerprint,
  type BotCapabilities,
  type WorkflowCalendarSchedule,
  type WorkflowNotificationKind,
  type WorkflowRun,
} from "../shared/workflow.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { WorkflowEngine } from "./workflow-run.ts";
import { WorkflowStore, type WorkflowInput } from "./workflow-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const OUTAGE = "unexpected status 503 Service Unavailable: Unknown error, url: https://chatgpt.com/backend-api/codex/responses";
const envelope = (outcome: string, summary = "did the thing") =>
  `Done.\n${WORKFLOW_CONTROL_OPEN}{"outcome":"${outcome}","summary":"${summary}"}${WORKFLOW_CONTROL_CLOSE}`;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Dispatch {
  botId: string;
  threadId: string;
  onDispatchError: (message: string) => void;
}

/** The world outside the engine, shared across restarts: which bots are
 * busy, what flags they carry, and the calendar math for daily schedules. */
interface World {
  busy: Set<string>;
  caps?: BotCapabilities;
  nextOccurrence?: (schedule: WorkflowCalendarSchedule, after: number) => number | null;
}

/** One process: an engine over the shared files. Calling it again over the
 * same files is a restart. */
function process_(files: { file: string; runsFile: string }, clock: { now: number }, prefix: string, world: World) {
  const { busy } = world;
  const store = new WorkflowStore({ ...files, now: () => clock.now });
  const dispatches: Dispatch[] = [];
  const notifications: Array<{ kind: WorkflowNotificationKind; message: string }> = [];
  let seq = 0;
  let events = 0;
  let commands = 0;
  let commandExit: () => number = () => 0;
  const engine = new WorkflowEngine({
    store,
    now: () => clock.now,
    random: () => 0.5,
    botState: (botId) => (busy.has(botId) ? "busy" : "ready"),
    botCapabilities: () => world.caps ?? {},
    ...(world.nextOccurrence ? { nextOccurrence: world.nextOccurrence } : {}),
    createTask: () => ({ threadId: `${prefix}-${++seq}` }),
    startTurn: (botId, threadId, _prompt, onDispatchError) => {
      dispatches.push({ botId, threadId, onDispatchError });
      return Promise.resolve();
    },
    interruptTurn: () => Promise.resolve(),
    notifyUser: (_run, message, kind) => {
      notifications.push({ kind, message });
    },
    preflight: {
      runCommand: async () => {
        commands++;
        return { exitCode: commandExit(), stdout: "", stderr: "", timedOut: false };
      },
    },
  });
  const event = (threadId: string): Pick<RuntimeEvent, "eventId" | "provider" | "threadId" | "createdAt"> => ({
    eventId: `${prefix}-e${++events}`,
    provider: "fake",
    threadId,
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  return {
    store,
    engine,
    dispatches,
    notifications,
    commandsRun: () => commands,
    setCommandExit: (fn: () => number) => (commandExit = fn),
    completeTurn: (threadId: string, text: string) => {
      engine.handleRuntimeEvent({ ...event(threadId), type: "item.completed", itemType: "assistant_text", text });
      engine.handleRuntimeEvent({ ...event(threadId), type: "turn.completed", ok: true });
    },
    failTurn: (threadId: string, message: string) => {
      engine.handleRuntimeEvent({ ...event(threadId), type: "runtime.error", message });
      engine.handleRuntimeEvent({ ...event(threadId), type: "turn.completed", ok: false, stopReason: "rpc_error" });
    },
  };
}

function files() {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-integration-"));
  dirs.push(dir);
  return { file: join(dir, "workflows.json"), runsFile: join(dir, "workflow-runs.json") };
}

const twoStep = (overrides: Partial<WorkflowInput> = {}): WorkflowInput => ({
  name: "Release",
  entryNodeId: "plan",
  nodes: [
    { kind: "agent", id: "plan", botId: "planner", instructions: "Plan.", outcomes: ["done"] },
    { kind: "agent", id: "ship", botId: "shipper", instructions: "Ship.", outcomes: ["shipped"] },
  ],
  edges: [{ from: "plan", outcome: "done", to: "ship" }],
  layout: {},
  ...overrides,
});

describe("24/7 integration across a restart", () => {
  it("B+E: an outage backoff that ended into a busy bot, then a restart — the run is re-driven on its own bot, the outage's attempts carry on, and nothing is announced twice", async () => {
    const f = files();
    const clock = { now: 1_000 };
    const busy = new Set<string>();
    const p1 = process_(f, clock, "t", { busy });
    const workflow = p1.store.create(twoStep({ stuckAfterMinutes: 120 }));
    const run = p1.engine.startRun(workflow.id, "go", "manual");
    // The provider is down: one outage wait (1 min), announced once.
    p1.failTurn("t-1", OUTAGE);
    let receipt = p1.store.getRun(run.id)!;
    expect(receipt.outage?.attempts).toBe(1);
    expect(receipt.outage?.waitUntil).toBe(receipt.nextAttemptAt);
    expect(p1.notifications.map((n) => n.kind)).toEqual(["outage"]);
    // The wait ends while the bot is busy on someone else's turn: the
    // backoff is consumed (stay re-stamped, waitUntil off the record) and
    // the run now waits on the BOT.
    busy.add("planner");
    clock.now += 2 * MIN;
    await p1.engine.tick();
    receipt = p1.store.getRun(run.id)!;
    expect(receipt.outage?.waitUntil).toBeUndefined();
    expect(receipt.outage?.attempts).toBe(1);
    expect(receipt.nodeEnteredAt).toBe(clock.now);
    expect(receipt.nextAttemptAt).toBeLessThanOrEqual(clock.now);
    expect(p1.dispatches).toHaveLength(1);

    // Restart while parked on the busy bot.
    const p2 = process_(f, clock, "r", { busy });
    clock.now += MIN;
    await p2.engine.tick();
    // Still busy: nothing dispatched, nothing stranded-recovered, nothing said.
    expect(p2.dispatches).toHaveLength(0);
    expect(p2.notifications).toEqual([]);
    expect(p2.store.getRun(run.id)!.status).toBe("running");
    // The bot frees: re-dispatched on the node's own bot, attempt untouched.
    busy.delete("planner");
    clock.now += MIN;
    await p2.engine.tick();
    expect(p2.dispatches.map((d) => d.botId)).toEqual(["planner"]);
    receipt = p2.store.getRun(run.id)!;
    expect(receipt.attempt).toBe(0);
    expect(receipt.outage?.attempts).toBe(1);
    // The provider is still down: the SECOND wait continues the count and
    // is not announced again (the horizon's give-up is the next word).
    p2.failTurn("r-1", OUTAGE);
    receipt = p2.store.getRun(run.id)!;
    expect(receipt.outage?.attempts).toBe(2);
    expect(receipt.attempt).toBe(0);
    expect(receipt.nextAttemptAt).toBe(clock.now + 2 * MIN);
    expect(p2.notifications).toEqual([]);
  });

  it("H+restart: a resumed run whose guarded node already has its result, parked on a busy bot in pre-flight, then restarted — the re-check passes and the EDGE is followed, the node is never run twice", async () => {
    const f = files();
    const clock = { now: 1_000 };
    const busy = new Set<string>();
    const p1 = process_(f, clock, "t", { busy });
    const workflow = p1.store.create(
      twoStep({
        preflight: {
          checks: [
            { kind: "command", name: "auth", command: "gh auth status" },
            { kind: "bots-ready", name: "bots", waitMinutes: 10 },
          ],
        },
      }),
    );
    const run = p1.engine.startRun(workflow.id, "go", "manual");
    await flush();
    expect(p1.dispatches).toHaveLength(1);
    // plan finishes, but its edge was deleted under it: the run fails with
    // plan's result recorded and currentNodeId = plan.
    p1.store.update(workflow.id, { edges: [] });
    p1.completeTurn("t-1", envelope("done", "planned"));
    let receipt = p1.store.getRun(run.id)!;
    expect(receipt.status).toBe("failed");
    expect(receipt.nodeResults.map((r) => r.nodeId)).toEqual(["plan"]);
    expect(receipt.currentNodeId).toBe("plan");
    // The owner restores the edge and resumes while the shipper is busy:
    // the checks run (auth passes, bots is transient) and the run parks.
    p1.store.update(workflow.id, { edges: [{ from: "plan", outcome: "done", to: "ship" }] });
    busy.add("shipper");
    p1.engine.resumeRun(run.id);
    await flush();
    receipt = p1.store.getRun(run.id)!;
    expect(receipt.status).toBe("running");
    expect(receipt.preflightStartedAt).toBeDefined();
    expect(receipt.preflight?.ok).toBe(false);
    expect(receipt.nextAttemptAt).toBeDefined();
    expect(p1.dispatches).toHaveLength(1);
    // The start's flight and the resume's: two full runs of the command.
    expect(p1.commandsRun()).toBe(2);

    // Restart mid-wait; the shipper frees.
    const p2 = process_(f, clock, "r", { busy });
    busy.delete("shipper");
    clock.now += MIN;
    await p2.engine.tick();
    await flush();
    receipt = p2.store.getRun(run.id)!;
    expect(receipt.preflightStartedAt).toBeUndefined();
    expect(receipt.preflight?.ok).toBe(true);
    // The recorded result is FOLLOWED: shipper dispatched, plan never again.
    expect(p2.dispatches.map((d) => d.botId)).toEqual(["shipper"]);
    expect(receipt.currentNodeId).toBe("ship");
    expect(receipt.nodeResults.map((r) => r.nodeId)).toEqual(["plan"]);
    // Only the transient check was re-asked: the command did not run again.
    expect(p2.commandsRun()).toBe(0);
    expect(receipt.preflight?.checks.map((c) => c.name)).toEqual(["auth", "bots"]);
    // Nothing more happens on later ticks.
    clock.now += MIN;
    await p2.engine.tick();
    expect(p2.dispatches).toHaveLength(1);
  });

  it("E+upgrade: a receipt from before this branch, running with a thread for 26 hours, is re-driven, timed out once, and announced stuck ONCE for the whole stay", async () => {
    const f = files();
    const clock = { now: 100 * HOUR };
    const busy = new Set<string>();
    const p0 = process_(f, clock, "t", { busy });
    const workflow = p0.store.create(
      twoStep({
        nodes: [
          { kind: "agent", id: "plan", botId: "planner", instructions: "Plan.", outcomes: ["done"] },
          { kind: "agent", id: "ship", botId: "shipper", instructions: "Ship.", outcomes: ["shipped"], timeoutMinutes: 180 },
        ],
      }),
    );
    const enteredShip = clock.now - 26 * HOUR;
    // Written by an older build: no nodeEnteredAt, no stuck markers.
    const old = p0.store.createRun({
      workflowId: workflow.id,
      status: "running",
      trigger: "schedule",
      attempt: 0,
      input: "",
      routingFingerprint: workflowRoutingFingerprint(p0.store.get(workflow.id)!),
      nodeResults: [{ nodeId: "plan", outcome: "done", summary: "planned", startedAt: enteredShip - HOUR, endedAt: enteredShip }],
      currentNodeId: "ship",
      currentThreadId: "dead-thread",
      dispatchedAt: enteredShip + MIN,
      startedAt: enteredShip - HOUR,
    } satisfies Omit<WorkflowRun, "id">);

    const p1 = process_(f, clock, "r", { busy });
    await p1.engine.tick();
    let receipt = p1.store.getRun(old.id)!;
    // The dead dispatch is past its timeout: charged one attempt, retry due
    // in a minute — and the stay is judged from where the receipt says the
    // node began, not from the tick.
    expect(receipt.attempt).toBe(1);
    expect(receipt.nextAttemptAt).toBe(clock.now + MIN);
    expect(p1.notifications.map((n) => n.kind)).toEqual(["stuck"]);
    expect(p1.notifications[0]!.message).toMatch(/stuck at node "ship" for 1d 2h/);
    expect(receipt.stuckAnnouncements).toBe(1);
    // The retry dispatches without resetting the stay.
    clock.now += 2 * MIN;
    await p1.engine.tick();
    receipt = p1.store.getRun(old.id)!;
    expect(p1.dispatches.map((d) => d.botId)).toEqual(["shipper"]);
    expect(receipt.nodeEnteredAt).toBe(enteredShip);
    expect(p1.notifications).toHaveLength(1);
    // Quiet for the rest of the period; speaks again after it.
    clock.now += 100 * MIN;
    await p1.engine.tick();
    expect(p1.notifications).toHaveLength(1);
    clock.now += 20 * MIN;
    await p1.engine.tick();
    expect(p1.notifications.map((n) => n.kind)).toEqual(["stuck", "stuck"]);
    // The node finishing ends the stay: completed, markers gone.
    p1.completeTurn("r-1", envelope("shipped"));
    receipt = p1.store.getRun(old.id)!;
    expect(receipt.status).toBe("completed");
    expect(receipt.stuckNotifiedAt).toBeUndefined();
    expect(p1.notifications.map((n) => n.kind)).toEqual(["stuck", "stuck", "completed"]);
  });

  it("H+restart: a running receipt that never reached its first node is STARTED through the pre-flight on recovery, not dispatched past it", async () => {
    const f = files();
    const clock = { now: 1_000 };
    const busy = new Set<string>();
    const p0 = process_(f, clock, "t", { busy });
    const workflow = p0.store.create(
      twoStep({ preflight: { checks: [{ kind: "command", name: "auth", command: "gh auth status" }] } }),
    );
    // The window between createRun and launch's first write, on disk.
    const run = p0.store.createRun({
      workflowId: workflow.id,
      status: "running",
      trigger: "schedule",
      attempt: 0,
      input: "",
      routingFingerprint: workflowRoutingFingerprint(p0.store.get(workflow.id)!),
      nodeResults: [],
      startedAt: clock.now,
    } satisfies Omit<WorkflowRun, "id">);

    const p1 = process_(f, clock, "r", { busy });
    await p1.engine.tick();
    // The checks ran and the marker was on the receipt before any dispatch.
    expect(p1.commandsRun()).toBe(1);
    await flush();
    const receipt = p1.store.getRun(run.id)!;
    expect(receipt.preflight?.ok).toBe(true);
    expect(receipt.preflightStartedAt).toBeUndefined();
    expect(receipt.currentNodeId).toBe("plan");
    expect(p1.dispatches.map((d) => d.botId)).toEqual(["planner"]);
  });

  it("resume hygiene: a resumed run re-queued behind an active one carries no dead thread, dispatch instant or re-prompt marker through the queue", () => {
    const f = files();
    const clock = { now: 1_000 };
    const busy = new Set<string>();
    const p1 = process_(f, clock, "t", { busy });
    const workflow = p1.store.create(
      twoStep({
        nodes: [
          { kind: "agent", id: "plan", botId: "planner", instructions: "Plan.", outcomes: ["done"], retries: 0 },
          { kind: "agent", id: "ship", botId: "shipper", instructions: "Ship.", outcomes: ["shipped"] },
        ],
      }),
    );
    const first = p1.engine.startRun(workflow.id, "one", "manual");
    // An envelope miss, a re-prompt, a second miss: failed with the thread,
    // the dispatch instant and the re-prompt marker on the terminal receipt.
    p1.completeTurn("t-1", "no envelope here");
    p1.completeTurn("t-1", "still none");
    let receipt = p1.store.getRun(first.id)!;
    expect(receipt.status).toBe("failed");
    expect(receipt.currentThreadId).toBe("t-1");
    expect(receipt.dispatchedAt).toBeDefined();
    expect(receipt.repromptedAt).toBeDefined();
    clock.now += MIN;
    const second = p1.engine.startRun(workflow.id, "two", "manual");
    expect(p1.store.getRun(second.id)!.status).toBe("running");
    const resumed = p1.engine.resumeRun(first.id);
    expect(resumed.status).toBe("queued");
    expect(resumed.currentThreadId).toBeUndefined();
    expect(resumed.dispatchedAt).toBeUndefined();
    expect(resumed.repromptedAt).toBeUndefined();
    // A resume in place still re-dispatches at once, as before.
    p1.completeTurn("t-2", envelope("done"));
    p1.completeTurn("t-3", envelope("shipped"));
    receipt = p1.store.getRun(first.id)!;
    expect(receipt.status).toBe("running");
    expect(receipt.currentThreadId).toBe("t-4");
  });

});

describe("refused starts under a schedule back off and go quiet", () => {
  /** A one-node workflow whose bot must carry `merge`: with no flags on the
   * roster every start is refused at the door (validation), synchronously. */
  const needsMerge = (overrides: Partial<WorkflowInput> = {}): WorkflowInput => ({
    name: "Merge",
    entryNodeId: "merge",
    nodes: [{ kind: "agent", id: "merge", botId: "merger", instructions: "Merge.", outcomes: ["done"], requires: ["merge"] }],
    edges: [],
    layout: {},
    triggers: { schedule: { type: "interval", minutes: 60 } },
    ...overrides,
  });
  /** Ticks every ten minutes for `hours`, settling any async work. */
  const runFor = async (engine: WorkflowEngine, clock: { now: number }, hours: number) => {
    for (let i = 0; i < hours * 6; i++) {
      clock.now += 10 * MIN;
      await engine.tick();
      await flush();
    }
  };

  it("24 hours of refusals: at most eight tries and five notifications, a receipt per try, the streak on the workflow and in the health document", async () => {
    const f = files();
    const clock = { now: Date.UTC(2026, 8, 7, 9, 0) };
    const world: World = { busy: new Set(), caps: {} };
    const p = process_(f, clock, "t", world);
    const workflow = p.store.create(needsMerge());
    // Arm, then fire the first slot an hour later.
    await p.engine.tick();
    await runFor(p.engine, clock, 24);
    const runs = p.store.listRuns(workflow.id);
    expect(runs.length).toBeLessThanOrEqual(8);
    expect(runs.length).toBeGreaterThanOrEqual(5);
    expect(runs.every((run) => run.status === "failed" && run.error?.includes('requires "merge"'))).toBe(true);
    const failed = p.notifications.filter((n) => n.kind === "failed");
    expect(failed.length).toBeLessThanOrEqual(5);
    // The first refusal is announced plainly; the third names the streak and
    // the backed-off next try (60 min × 2^3 = 8 h, capped at 6 h).
    expect(failed[0]!.message).toMatch(/was not started: .*requires "merge"/);
    expect(failed[0]!.message).not.toMatch(/in a row/);
    expect(failed[1]!.message).toMatch(/3 refused starts in a row; next try in 6h/);
    // Re-arms of 2h, 4h, then 6h (the cap) after each refusal: tries at
    // 1h, 3h, 7h, 13h, 19h — and the next one is armed 6h after the last.
    const starts = runs.map((run) => (run.startedAt - clock.now + 24 * HOUR) / HOUR).sort((a, b) => a - b);
    expect(starts).toEqual([1, 3, 7, 13, 19]);
    const streak = p.store.get(workflow.id)!.refusalStreak!;
    expect(streak.count).toBe(5);
    expect(streak.since).toBe(clock.now - 23 * HOUR);
    expect(streak.lastReason).toMatch(/requires "merge"/);
    const health = p.engine.health().workflows.find((row) => row.id === workflow.id)!;
    expect(health.refusalStreak).toEqual(streak);
    expect(health.nextRunAt).toBe(clock.now + HOUR);
  });

  it("the first run that gets past its checks clears the streak, and the interval is back to normal after it", async () => {
    const f = files();
    const clock = { now: Date.UTC(2026, 8, 7, 9, 0) };
    const world: World = { busy: new Set(), caps: {} };
    const p = process_(f, clock, "t", world);
    const workflow = p.store.create(
      needsMerge({
        nodes: [{ kind: "agent", id: "merge", botId: "merger", instructions: "Merge.", outcomes: ["done"], requires: ["merge"], timeoutMinutes: 240 }],
      }),
    );
    await p.engine.tick();
    await runFor(p.engine, clock, 4);
    expect(p.store.get(workflow.id)!.refusalStreak?.count).toBe(2);
    // The flag is granted: the next backed-off try (4 h after the 2nd
    // refusal, at 7h) starts a run and the streak is gone at its dispatch.
    world.caps = { canMerge: true };
    await runFor(p.engine, clock, 4);
    const running = p.store.listRuns(workflow.id).find((run) => run.status === "running")!;
    expect(running).toBeDefined();
    expect(p.store.get(workflow.id)!.refusalStreak).toBeUndefined();
    expect(p.dispatches).toHaveLength(1);
    p.completeTurn(p.dispatches[0]!.threadId, envelope("done"));
    // Idle again: the next slot is one plain interval after the run ended.
    await p.engine.tick();
    expect(p.store.get(workflow.id)!.nextRunAt).toBe(clock.now + 60 * MIN);
  });

  it("a restart in the middle of a streak continues it: the count, the quiet, and the backoff are read from disk", async () => {
    const f = files();
    const clock = { now: Date.UTC(2026, 8, 7, 9, 0) };
    const world: World = { busy: new Set(), caps: {} };
    const p1 = process_(f, clock, "t", world);
    const workflow = p1.store.create(needsMerge());
    await p1.engine.tick();
    await runFor(p1.engine, clock, 4); // refusals at 1h and 3h
    expect(p1.store.get(workflow.id)!.refusalStreak?.count).toBe(2);
    expect(p1.notifications).toHaveLength(1);

    const p2 = process_(f, clock, "r", world);
    await runFor(p2.engine, clock, 20);
    const streak = p2.store.get(workflow.id)!.refusalStreak!;
    expect(streak.count).toBe(5);
    expect(streak.since).toBe(Date.UTC(2026, 8, 7, 10, 0));
    // Only the third refusal spoke after the restart.
    expect(p2.notifications.map((n) => n.kind)).toEqual(["failed"]);
    expect(p2.notifications[0]!.message).toMatch(/3 refused starts in a row/);
  });

  it("a failed pre-flight is a refused start too, and a daily schedule joins and clears the same streak", async () => {
    const f = files();
    const clock = { now: Date.UTC(2026, 8, 7, 9, 0) };
    let auth = false;
    const world: World = {
      busy: new Set(),
      caps: { canMerge: true },
      nextOccurrence: (_schedule, after) => after + 24 * HOUR,
    };
    const p = process_(f, clock, "t", world);
    const workflow = p.store.create(
      needsMerge({
        triggers: { schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] } },
        preflight: { checks: [{ kind: "command", name: "auth", command: "gh auth status" }] },
      }),
    );
    p.setCommandExit(() => (auth ? 0 : 1));
    await p.engine.tick(); // arms tomorrow's slot
    // Three daily slots refused by the check: receipts each time, the
    // person told on the first and the third.
    for (let day = 0; day < 3; day++) {
      clock.now += 24 * HOUR;
      await p.engine.tick();
      await flush();
    }
    expect(p.store.listRuns(workflow.id).filter((run) => run.status === "failed")).toHaveLength(3);
    expect(p.store.get(workflow.id)!.refusalStreak?.count).toBe(3);
    const failed = p.notifications.filter((n) => n.kind === "failed");
    expect(failed).toHaveLength(2);
    expect(failed[1]!.message).toMatch(/pre-flight check "auth" failed.*3 refused starts in a row; next try at the next scheduled slot/);
    // The token is fixed: the next slot passes and the streak is cleared.
    auth = true;
    clock.now += 24 * HOUR;
    await p.engine.tick();
    await flush();
    expect(p.dispatches).toHaveLength(1);
    expect(p.store.get(workflow.id)!.refusalStreak).toBeUndefined();
  });
});
