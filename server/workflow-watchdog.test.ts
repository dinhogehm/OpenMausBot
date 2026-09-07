// The engine's observability, end to end: the run watchdog (a run parked on
// one node is announced once, then at most once per period, across retries
// and a restart), the announcement of every transition and its mirror in
// the audit room, the daily digest (fires once per slot, never twice
// across a restart) and the health document. Real WorkflowStore over
// throwaway temp dirs; the clock is the engine's injected `now`, and
// tick() is called by hand so every instant is exact.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORKFLOW_CONTROL_CLOSE,
  WORKFLOW_CONTROL_OPEN,
  type WorkflowNotificationKind,
} from "../shared/workflow.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { WorkflowEngine } from "./workflow-run.ts";
import { WorkflowStore, type WorkflowInput } from "./workflow-store.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
/** A local-time anchor, so the digest's wall-clock slot is timezone-proof. */
const local = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).getTime();
const T0 = local(2026, 9, 7, 9, 0);

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface CapturedDispatch {
  botId: string;
  threadId: string;
  prompt: string;
  onDispatchError: (message: string) => void;
}

function harness({ groups = ["audit", "ops"] }: { groups?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-watchdog-"));
  dirs.push(dir);
  const file = join(dir, "workflows.json");
  const runsFile = join(dir, "workflow-runs.json");
  let now = T0;
  const notifications: Array<{ runId: string; message: string; kind: WorkflowNotificationKind }> = [];
  const posts: Array<{ groupId: string; text: string }> = [];
  const rooms = new Set(groups);
  let notifyThrows: string | null = null;
  const states: Record<string, "ready" | "busy" | "missing"> = {};
  const build = (prefix: string) => {
    const store = new WorkflowStore({ file, runsFile, now: () => now });
    const dispatches: CapturedDispatch[] = [];
    let seq = 0;
    const engine = new WorkflowEngine({
      store,
      now: () => now,
      version: "9.9.9-test",
      random: () => 0.5,
      botState: (botId) => states[botId] ?? "ready",
      botCapabilities: () => ({}),
      groupExists: (groupId) => rooms.has(groupId),
      createTask: () => ({ threadId: `${prefix}-${++seq}` }),
      startTurn: (botId, threadId, prompt, onDispatchError) => {
        dispatches.push({ botId, threadId, prompt, onDispatchError });
        return Promise.resolve();
      },
      interruptTurn: () => Promise.resolve(),
      // index.ts's wrapper throws for a room that no longer exists.
      postGroupMessage: (groupId, text) => {
        if (!rooms.has(groupId)) throw new Error(`channel "${groupId}" no longer exists`);
        posts.push({ groupId, text });
      },
      notifyUser: (run, message, kind) => {
        if (notifyThrows !== null) throw new Error(notifyThrows);
        notifications.push({ runId: run.id, message, kind });
      },
      nextOccurrence: (schedule, after) => (schedule.type === "daily" ? after + HOUR : null),
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
    return { store, engine, dispatches, completeTurn };
  };
  const first = build("thread");
  return {
    ...first,
    notifications,
    posts,
    setNow: (value: number) => (now = value),
    advance: (ms: number) => (now += ms),
    failNotifications: (message: string | null) => (notifyThrows = message),
    setState: (botId: string, state: "ready" | "busy" | "missing") => (states[botId] = state),
    dropRoom: (groupId: string) => rooms.delete(groupId),
    /** A process restart: fresh engine and store over the same files, the
     * same notification sinks. */
    restart: () => build("re-thread"),
  };
}

const envelope = (outcome: string, summary = "did the thing") =>
  `Done.\n${WORKFLOW_CONTROL_OPEN}{"outcome":"${outcome}","summary":"${summary}"}${WORKFLOW_CONTROL_CLOSE}`;

/** plan --done--> ship (sink). Day-long node timeouts, so a stay the
 * watchdog measures is one live turn and not a chain of timeouts (the
 * retry test builds its own short-timeout nodes). */
const pipeline = (overrides: Partial<WorkflowInput> = {}): WorkflowInput => ({
  name: "Release",
  entryNodeId: "plan",
  nodes: [
    { kind: "agent", id: "plan", botId: "planner", instructions: "Plan.", outcomes: ["done"], timeoutMinutes: 1_440 },
    { kind: "agent", id: "ship", botId: "shipper", instructions: "Ship.", outcomes: ["shipped"], timeoutMinutes: 1_440 },
  ],
  edges: [{ from: "plan", outcome: "done", to: "ship" }],
  layout: {},
  ...overrides,
});

const kinds = (h: { notifications: Array<{ kind: string }> }) => h.notifications.map((n) => n.kind);

describe("run watchdog", () => {
  it("announces a run parked on one node once past the workflow's patience, then at most once per period, and clears when it moves", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ stuckAfterMinutes: 60 }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    expect(h.store.getRun(run.id)!.nodeEnteredAt).toBe(T0);

    h.setNow(T0 + 60 * MIN);
    await h.engine.tick();
    expect(kinds(h)).toEqual([]); // exactly the patience is not past it

    h.setNow(T0 + 60 * MIN + 10_000);
    await h.engine.tick();
    expect(h.notifications).toEqual([
      {
        runId: run.id,
        kind: "stuck",
        message:
          'Workflow "Release" run stuck at node "plan" for 1h (bot "planner", attempt 1 of 3, turn live for 1h) — no step has finished yet',
      },
    ]);
    // Persisted, so a restart continues the cadence rather than repeating.
    expect(h.store.getRun(run.id)!.stuckNotifiedAt).toBe(T0 + 60 * MIN + 10_000);

    // Every following tick inside the period is silent…
    for (let minute = 1; minute < 60; minute += 7) {
      h.setNow(T0 + 60 * MIN + 10_000 + minute * MIN);
      await h.engine.tick();
    }
    expect(h.notifications).toHaveLength(1);
    // …and the next period brings exactly one more.
    h.setNow(T0 + 120 * MIN + 10_000);
    await h.engine.tick();
    expect(h.notifications).toHaveLength(2);
    expect(h.notifications[1]!.message).toContain('stuck at node "plan" for 2h');

    // The node finishes: the marker goes, the successor's stay starts now.
    h.completeTurn(h.dispatches[0]!.threadId, envelope("done", "Planned."));
    const moved = h.store.getRun(run.id)!;
    expect(moved.currentNodeId).toBe("ship");
    expect(moved.stuckNotifiedAt).toBeUndefined();
    expect(moved.nodeEnteredAt).toBe(T0 + 120 * MIN + 10_000);
    h.setNow(T0 + 150 * MIN);
    await h.engine.tick();
    expect(h.notifications).toHaveLength(2); // 30 minutes on ship is not stuck

    h.setNow(T0 + 181 * MIN);
    await h.engine.tick();
    expect(h.notifications).toHaveLength(3);
    expect(h.notifications[2]!.message).toBe(
      'Workflow "Release" run stuck at node "ship" for 1h (bot "shipper", attempt 1 of 3, turn live for 1h) — last step plan: done — Planned.',
    );
  });

  it("measures the stay across retries of the same node — three dead attempts are one long stay", async () => {
    const h = harness();
    const workflow = h.store.create(
      pipeline({
        stuckAfterMinutes: 45,
        nodes: [
          { kind: "agent", id: "plan", botId: "planner", instructions: "Plan.", outcomes: ["done"], timeoutMinutes: 15, retries: 2 },
          { kind: "agent", id: "ship", botId: "shipper", instructions: "Ship.", outcomes: ["shipped"] },
        ],
      }),
    );
    const run = h.engine.startRun(workflow.id, "go", "manual");
    // Attempt 1 times out at 15 min, attempt 2 is dispatched a minute
    // later, times out at 31, attempt 3 at 33 — the evidence run's shape.
    h.setNow(T0 + 16 * MIN);
    await h.engine.tick();
    h.setNow(T0 + 17 * MIN);
    await h.engine.tick();
    expect(h.dispatches).toHaveLength(2);
    h.setNow(T0 + 33 * MIN);
    await h.engine.tick();
    h.setNow(T0 + 35 * MIN);
    await h.engine.tick();
    expect(h.dispatches).toHaveLength(3);
    expect(h.store.getRun(run.id)).toMatchObject({ attempt: 2, nodeEnteredAt: T0 });
    expect(kinds(h)).toEqual([]);

    h.setNow(T0 + 46 * MIN);
    await h.engine.tick();
    expect(kinds(h)).toEqual(["stuck"]);
    expect(h.notifications[0]!.message).toBe(
      'Workflow "Release" run stuck at node "plan" for 46m (bot "planner", attempt 3 of 3, turn live for 11m) — no step has finished yet',
    );
  });

  it("survives a restart: the marker on the receipt keeps it quiet, the period re-announces, and an orphan keeps its stay", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ stuckAfterMinutes: 30 }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.setNow(T0 + 31 * MIN);
    await h.engine.tick();
    expect(kinds(h)).toEqual(["stuck"]);

    // The app restarts: the turn is an orphan, re-driven on a fresh task —
    // the same node, so the stay is NOT reset and the marker is kept.
    h.setNow(T0 + 40 * MIN);
    const re = h.restart();
    await re.engine.tick();
    expect(re.dispatches).toHaveLength(1);
    expect(re.store.getRun(run.id)).toMatchObject({ nodeEnteredAt: T0, stuckNotifiedAt: T0 + 31 * MIN });
    expect(h.notifications).toHaveLength(1); // no repeat on the first tick after boot

    h.setNow(T0 + 62 * MIN);
    await re.engine.tick();
    expect(h.notifications).toHaveLength(2);
    expect(h.notifications[1]!.message).toContain('stuck at node "plan" for 1h 2m');
    expect(h.notifications[1]!.message).toContain("turn live for 22m");
  });

  it("fixes an older receipt's stay at what its fields say, rather than at the first dispatch after the upgrade", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ stuckAfterMinutes: 60 }));
    // A receipt from before the stamp existed: plan finished a day ago and
    // the dispatch of ship was lost with the process (no thread, no
    // dispatch time) — the classic orphan recoverStranded re-drives.
    const old = h.store.createRun({
      workflowId: workflow.id,
      status: "running",
      attempt: 0,
      input: "",
      nodeResults: [{ nodeId: "plan", outcome: "done", summary: "Planned.", startedAt: T0 - 27 * HOUR, endedAt: T0 - 26 * HOUR }],
      currentNodeId: "ship",
      startedAt: T0 - 27 * HOUR,
    });
    const re = h.restart();
    await re.engine.tick();
    expect(re.dispatches).toHaveLength(1);
    expect(re.dispatches[0]!.botId).toBe("shipper");
    expect(re.store.getRun(old.id)!.nodeEnteredAt).toBe(T0 - 26 * HOUR);
    expect(kinds(h)).toEqual(["stuck"]);
    expect(h.notifications[0]!.message).toContain('stuck at node "ship" for 1d 2h');
  });

  it("leaves a wait node, an outage wait and a gate inside its window alone", async () => {
    const h = harness();
    const parked = h.store.create({
      name: "Paused",
      entryNodeId: "pause",
      nodes: [
        { kind: "wait", id: "pause", minutes: 600 },
        { kind: "approval", id: "gate", prompt: "OK?", expiresHours: 10 },
      ],
      edges: [{ from: "pause", outcome: "elapsed", to: "gate" }],
      layout: {},
      stuckAfterMinutes: 10,
    });
    const run = h.engine.startRun(parked.id, "go", "manual");
    h.setNow(T0 + 5 * HOUR);
    await h.engine.tick();
    expect(kinds(h)).toEqual([]); // ten hours of wait is the node's own business
    h.setNow(T0 + 10 * HOUR + MIN);
    await h.engine.tick();
    expect(h.store.getRun(run.id)!.status).toBe("waiting-approval");
    expect(kinds(h)).toEqual(["approval"]);
    // Fourteen hours into a ten-hour gate: the expiry sweep settles it
    // before the watchdog ever looks (the gate is a sink, so its default
    // rejection completes the run — announced as such, never as stuck).
    h.setNow(T0 + 24 * HOUR + MIN);
    await h.engine.tick();
    expect(kinds(h)).toEqual(["approval", "completed"]);

    // An outage wait has two announcements of its own and is never
    // "stuck" while it waits — even past the patience. When the wait ends
    // the stay starts OVER: hours the provider was away are not hours the
    // run sat unexplained, so the first tick after a long outage must not
    // call a run that is moving again "stuck" (nor flip the health probe).
    const outage = h.store.create(pipeline({ stuckAfterMinutes: 10, providerOutage: { horizonHours: 1 } }));
    const waiting = h.engine.startRun(outage.id, "go", "manual");
    const parkedAt = T0 + 24 * HOUR + MIN;
    // Waits of 1, 2, 4 and 8 minutes (jitter-free): each tick lands when
    // the wait is over, re-dispatches, and the turn fails again at once.
    const fail = () => h.dispatches.at(-1)!.onDispatchError("unexpected status 503 Service Unavailable");
    fail();
    for (const at of [1, 3, 7]) {
      h.setNow(parkedAt + at * MIN);
      await h.engine.tick();
      fail();
    }
    expect(h.store.getRun(waiting.id)).toMatchObject({ outage: { attempts: 4 }, nextAttemptAt: parkedAt + 15 * MIN });
    h.setNow(parkedAt + 12 * MIN);
    await h.engine.tick(); // twelve minutes into the stay, past the patience, but waiting
    expect(h.notifications.filter((n) => n.runId === waiting.id).map((n) => n.kind)).toEqual(["outage"]);
    h.setNow(parkedAt + 15 * MIN);
    await h.engine.tick(); // live again, on a fresh stay
    expect(h.notifications.filter((n) => n.runId === waiting.id).map((n) => n.kind)).toEqual(["outage"]);
    expect(h.store.getRun(waiting.id)).toMatchObject({ nodeEnteredAt: parkedAt + 15 * MIN, outage: { attempts: 4 } });
    expect(h.engine.health().runs.stuck.map((entry) => entry.runId)).not.toContain(waiting.id);
    h.setNow(parkedAt + 25 * MIN);
    await h.engine.tick(); // ten minutes into the new stay, still on the same turn: not yet
    expect(h.notifications.filter((n) => n.runId === waiting.id).map((n) => n.kind)).toEqual(["outage"]);
    h.setNow(parkedAt + 26 * MIN);
    await h.engine.tick(); // eleven: now it is
    expect(h.notifications.filter((n) => n.runId === waiting.id).map((n) => n.kind)).toEqual(["outage", "stuck"]);
    expect(h.notifications.at(-1)!.message).toContain('stuck at node "plan" for 11m');
  });

  it("an outage backoff followed by a busy bot: the wait on the bot IS a stay, and is announced", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ stuckAfterMinutes: 10, providerOutage: { horizonHours: 6 } }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.dispatches[0]!.onDispatchError("unexpected status 503 Service Unavailable");
    expect(h.store.getRun(run.id)).toMatchObject({ outage: { attempts: 1, waitUntil: T0 + MIN }, nextAttemptAt: T0 + MIN });
    expect(kinds(h)).toEqual(["outage"]);

    // The backoff ends, but the bot is busy: the run parks for the bot and
    // keeps the outage record (the provider is not known to be back).
    h.setState("planner", "busy");
    h.setNow(T0 + MIN);
    await h.engine.tick();
    const parked = h.store.getRun(run.id)!;
    expect(parked.nextAttemptAt).toBe(T0 + MIN);
    expect(parked.outage).toMatchObject({ attempts: 1 });
    expect(parked.outage?.waitUntil).toBeUndefined();
    expect(parked.nodeEnteredAt).toBe(T0 + MIN); // the backoff's minute is forgotten…
    expect(h.dispatches).toHaveLength(1);

    // …but three hours waiting on a busy bot is a stay like any other.
    h.setNow(T0 + 11 * MIN);
    await h.engine.tick();
    expect(kinds(h)).toEqual(["outage"]);
    h.setNow(T0 + 11 * MIN + 10_000);
    await h.engine.tick();
    expect(kinds(h)).toEqual(["outage", "stuck"]);
    expect(h.notifications[1]!.message).toContain('stuck at node "plan" for 10m (bot "planner", attempt 1 of 3, waiting for the bot to be free)');
    expect(h.engine.health().runs.stuck.map((entry) => entry.runId)).toEqual([run.id]);
    h.setNow(T0 + 3 * HOUR);
    await h.engine.tick();
    expect(h.engine.health().ok).toBe(false);

    // The bot frees: the park is consumed WITHOUT restarting the stay — it
    // was never the provider's time — so the next announcement counts the
    // whole wait.
    h.setState("planner", "ready");
    h.setNow(T0 + 3 * HOUR + 10_000);
    await h.engine.tick();
    expect(h.dispatches).toHaveLength(2);
    expect(h.store.getRun(run.id)!.nodeEnteredAt).toBe(T0 + MIN);
  });

  it("stops after twelve announcements for one stay, says so on the last, and starts over on the next node", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ stuckAfterMinutes: 10 }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    for (let period = 1; period <= 20; period++) {
      h.setNow(T0 + period * 10 * MIN + 10_000);
      await h.engine.tick();
    }
    expect(h.notifications).toHaveLength(12);
    expect(h.notifications[10]!.message).not.toContain("last stuck announcement");
    expect(h.notifications[11]!.message).toMatch(/for 2h \(.*— last stuck announcement for this stay; quiet until the run moves$/);
    expect(h.store.getRun(run.id)).toMatchObject({ stuckAnnouncements: 12 });
    // Still listed for a monitor while it is quiet.
    expect(h.engine.health().runs.stuck.map((entry) => entry.runId)).toEqual([run.id]);

    h.completeTurn(h.dispatches[0]!.threadId, envelope("done"));
    expect(h.store.getRun(run.id)!.stuckAnnouncements).toBeUndefined();
    h.setNow(T0 + 4 * HOUR);
    await h.engine.tick();
    expect(h.notifications).toHaveLength(13);
    expect(h.notifications[12]!.message).toContain('stuck at node "ship"');
  });

  it("lists a gate past 1.5 times its window as stuck in the health document", () => {
    const h = harness();
    const gated = h.store.create({
      name: "Gated",
      entryNodeId: "gate",
      nodes: [{ kind: "approval", id: "gate", prompt: "OK?", expiresHours: 2 }],
      edges: [],
      layout: {},
    });
    const run = h.engine.startRun(gated.id, "go", "manual");
    h.setNow(T0 + 3 * HOUR);
    expect(h.engine.health().runs.stuck).toEqual([]);
    h.setNow(T0 + 3 * HOUR + 1);
    const stuck = h.engine.health().runs.stuck;
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ runId: run.id, nodeId: "gate", status: "waiting-approval", since: T0, attempt: 0 });
  });

  it("retries an announcement that failed to go out, never persists the marker for it, and does not repost it to the room meanwhile", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ stuckAfterMinutes: 10, auditGroupId: "audit" }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    h.failNotifications("phone off");
    h.setNow(T0 + 11 * MIN);
    await h.engine.tick();
    expect(h.notifications).toEqual([]);
    expect(h.store.getRun(run.id)!.stuckNotifiedAt).toBeUndefined();
    expect(errors).toHaveBeenCalled();
    h.setNow(T0 + 11 * MIN + 10_000);
    await h.engine.tick();
    expect(h.posts).toEqual([]); // the room copy waits for the person's copy, or every retry would repost it
    h.failNotifications(null);
    h.setNow(T0 + 11 * MIN + 20_000);
    await h.engine.tick();
    expect(kinds(h)).toEqual(["stuck"]);
    expect(h.posts).toHaveLength(1);
    expect(h.store.getRun(run.id)!.stuckNotifiedAt).toBe(T0 + 11 * MIN + 20_000);
  });

  it("does not count time spent queued behind another run, nor time before a resume", async () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ stuckAfterMinutes: 30 }));
    const first = h.engine.startRun(workflow.id, "one", "manual");
    const second = h.engine.startRun(workflow.id, "two", "manual");
    expect(h.store.getRun(second.id)!.status).toBe("queued");
    h.setNow(T0 + 2 * HOUR);
    await h.engine.cancelRun(first.id);
    expect(h.store.getRun(second.id)).toMatchObject({ status: "running", nodeEnteredAt: T0 + 2 * HOUR });
    await h.engine.tick();
    expect(h.notifications.filter((n) => n.runId === second.id)).toEqual([]);

    // A resumed failure starts a fresh stay.
    h.setState("planner", "missing");
    await h.engine.cancelRun(second.id);
    const third = h.engine.startRun(workflow.id, "three", "manual");
    expect(h.store.getRun(third.id)!.status).toBe("failed");
    h.setState("planner", "ready");
    h.setNow(T0 + 5 * HOUR);
    h.engine.resumeRun(third.id);
    expect(h.store.getRun(third.id)).toMatchObject({ status: "running", nodeEnteredAt: T0 + 5 * HOUR, stuckNotifiedAt: undefined });
    await h.engine.tick();
    expect(h.notifications.filter((n) => n.runId === third.id && n.kind === "stuck")).toEqual([]);
  });
});

describe("every transition is announced, and mirrored in the audit room", () => {
  it("completed: names the last step and its summary, on the phone and in the room with the workflow prefix", () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ auditGroupId: "audit" }));
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.completeTurn(h.dispatches[0]!.threadId, envelope("done", "Planned it."));
    h.advance(7 * MIN);
    h.completeTurn(h.dispatches[1]!.threadId, envelope("shipped", "Shipped v2."));
    expect(h.store.getRun(run.id)!.status).toBe("completed");
    expect(h.notifications).toEqual([
      {
        runId: run.id,
        kind: "completed",
        message: 'Workflow "Release" run completed after 7m — last step "ship": shipped — Shipped v2.',
      },
    ]);
    expect(h.posts).toEqual([{ groupId: "audit", text: '[Release] run completed after 7m — last step "ship": shipped — Shipped v2.' }]);
  });

  it("failed, cancelled, approval and reminder all reach the room; a room that vanished mid-run is logged, never a reason to stop", async () => {
    const h = harness();
    const gated = h.store.create({
      name: "Gated",
      entryNodeId: "gate",
      nodes: [
        { kind: "approval", id: "gate", prompt: "Ship it?", expiresHours: 2 },
        { kind: "agent", id: "ship", botId: "shipper", instructions: "Ship.", outcomes: ["shipped"], retries: 0 },
        { kind: "notify", id: "nope", targetGroupId: "ops", template: "not shipped" },
      ],
      edges: [
        { from: "gate", outcome: "approved", to: "ship" },
        { from: "gate", outcome: "rejected", to: "nope" },
      ],
      layout: {},
      auditGroupId: "audit",
    });
    const run = h.engine.startRun(gated.id, "go", "manual");
    h.setNow(T0 + HOUR);
    await h.engine.tick();
    expect(h.posts.map((post) => post.text)).toEqual([
      '[Gated] needs approval at node "gate": Ship it?',
      '[Gated] still needs approval at node "gate" (reminder): Ship it?',
    ]);
    h.engine.resolveApproval(run.id, "approved");
    const cancelled = await h.engine.cancelRun(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(h.notifications.at(-1)!.message).toBe('Workflow "Gated" run cancelled at node "ship"');
    expect(h.posts.at(-1)).toEqual({ groupId: "audit", text: '[Gated] run cancelled at node "ship"' });

    // The room is deleted under a live run: the person is still told, the
    // miss is logged, and the run is driven exactly as before.
    const second = h.engine.startRun(gated.id, "again", "manual");
    h.engine.resolveApproval(second.id, "approved");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.dropRoom("audit");
    h.dispatches.at(-1)!.onDispatchError("boom");
    expect(h.store.getRun(second.id)!.status).toBe("failed");
    expect(h.notifications.at(-1)).toMatchObject({ kind: "failed", message: 'Workflow "Gated" run failed at node "ship": boom' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('audit room "audit" of Gated no longer exists; failed not posted'));
    expect(h.posts.at(-1)!.text).toBe('[Gated] needs approval at node "gate": Ship it?'); // nothing landed after the room went
  });

  it("a queued webhook run that is dropped is announced with the reason, once per run", () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ auditGroupId: "ops" }));
    h.engine.startRun(workflow.id, "live", "manual");
    h.engine.startRun(workflow.id, "a", "webhook", { webhookId: "hook" });
    h.engine.startRun(workflow.id, "b", "webhook", { webhookId: "hook" });
    expect(h.engine.cancelQueuedForWebhook("hook", "webhook paused")).toBe(2);
    expect(kinds(h)).toEqual(["cancelled", "cancelled"]);
    expect(h.notifications[0]!.message).toBe('Workflow "Release" queued run cancelled: webhook paused');
    expect(h.posts.map((post) => post.groupId)).toEqual(["ops", "ops"]);
  });

  it("the audit room and a notify node's room are independent, and the audit line is scrubbed of secrets", () => {
    const h = harness();
    const workflow = h.store.create({
      name: "Announce",
      entryNodeId: "plan",
      nodes: [
        { kind: "agent", id: "plan", botId: "planner", instructions: "Plan.", outcomes: ["done"] },
        { kind: "notify", id: "say", targetGroupId: "ops", template: "{{summary}}" },
      ],
      edges: [{ from: "plan", outcome: "done", to: "say" }],
      layout: {},
      auditGroupId: "audit",
    });
    h.engine.startRun(workflow.id, "go", "manual");
    h.completeTurn(h.dispatches[0]!.threadId, envelope("done", "token sk-ant-abcdefghijklmnop1234 used"));
    expect(h.posts.map((post) => post.groupId)).toEqual(["ops", "audit"]);
    expect(h.posts[1]!.text).toContain('[Announce] run completed');
    expect(h.posts[1]!.text).not.toContain("sk-ant-abcdefghijklmnop1234");
  });

  it("a workflow whose audit room does not exist still runs: the person is told, the post is skipped with a log line", () => {
    const h = harness();
    const workflow = h.store.create(pipeline({ auditGroupId: "nope" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = h.engine.startRun(workflow.id, "go", "manual");
    expect(run.status).toBe("running");
    h.completeTurn(h.dispatches[0]!.threadId, envelope("done"));
    h.completeTurn(h.dispatches[1]!.threadId, envelope("shipped"));
    expect(kinds(h)).toEqual(["completed"]);
    expect(h.posts).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('audit room "nope" of Release no longer exists; completed not posted'));
  });
});

describe("daily digest", () => {
  const withDigest = (h: ReturnType<typeof harness>) =>
    h.store.create(pipeline({ digestAt: "18:00", auditGroupId: "audit" }));

  it("fires once at the slot with the day's runs, not again inside the day, and again the next day", async () => {
    const h = harness();
    const workflow = withDigest(h);
    const run = h.engine.startRun(workflow.id, "go", "manual");
    h.completeTurn(h.dispatches[0]!.threadId, envelope("done"));
    h.advance(10 * MIN);
    h.completeTurn(h.dispatches[1]!.threadId, envelope("shipped"));
    expect(h.store.getRun(run.id)!.status).toBe("completed");
    const failed = h.engine.startRun(workflow.id, "again", "manual");
    h.dispatches[2]!.onDispatchError("Node \"plan\" requires \"merge\" but its bot \"planner\" is not allowed to merge.");
    expect(h.store.getRun(failed.id)!.status).toBe("failed");
    h.notifications.length = 0;
    h.posts.length = 0;

    h.setNow(local(2026, 9, 7, 17, 59));
    await h.engine.tick();
    expect(kinds(h)).toEqual([]);

    h.setNow(local(2026, 9, 7, 18, 0));
    await h.engine.tick();
    const digest =
      'Workflow "Release" daily digest for 2026-09-07: 2 runs ended since the previous digest — 1 completed, 1 failed, 0 cancelled; average run time 10m; nodes that failed most: plan ×1';
    expect(h.notifications).toEqual([{ runId: expect.any(String), kind: "digest", message: digest }]);
    expect(h.posts).toEqual([{ groupId: "audit", text: `[Release] ${digest.slice('Workflow "Release" '.length)}` }]);
    expect(h.store.get(workflow.id)!.lastDigestAt).toBe(local(2026, 9, 7, 18, 0));

    h.setNow(local(2026, 9, 7, 23, 30));
    await h.engine.tick();
    expect(h.notifications).toHaveLength(1);

    h.setNow(local(2026, 9, 8, 18, 0));
    await h.engine.tick();
    expect(h.notifications).toHaveLength(2);
    expect(h.notifications[1]!.message).toBe('Workflow "Release" daily digest for 2026-09-08: no run ended since the previous digest');
  });

  it("does not duplicate across a restart, and a computer that slept through days sends one digest on waking", async () => {
    const h = harness();
    const workflow = withDigest(h);
    h.setNow(local(2026, 9, 7, 18, 0));
    await h.engine.tick();
    expect(kinds(h)).toEqual(["digest"]);

    // Restart a minute later: the persisted lastDigestAt keeps it quiet.
    h.setNow(local(2026, 9, 7, 18, 1));
    const re = h.restart();
    await re.engine.tick();
    expect(kinds(h)).toEqual(["digest"]);

    // Asleep for three days: one digest, for the slot woken into.
    h.setNow(local(2026, 9, 10, 20, 0));
    await re.engine.tick();
    await re.engine.tick();
    expect(kinds(h)).toEqual(["digest", "digest"]);
    expect(h.notifications[1]!.message).toContain("daily digest for 2026-09-10");
    expect(re.store.get(workflow.id)!.lastDigestAt).toBe(local(2026, 9, 10, 18, 0));
  });

  it("records the slot only once the digest went out, so a transport hiccup retries on the next tick", async () => {
    const h = harness();
    const workflow = withDigest(h);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    h.failNotifications("phone off");
    h.setNow(local(2026, 9, 7, 18, 0));
    await h.engine.tick();
    expect(kinds(h)).toEqual([]);
    expect(h.store.get(workflow.id)!.lastDigestAt).toBeUndefined();
    expect(errors).toHaveBeenCalled();
    h.failNotifications(null);
    h.setNow(local(2026, 9, 7, 18, 0) + 10_000);
    await h.engine.tick();
    expect(kinds(h)).toEqual(["digest"]);
    expect(h.store.get(workflow.id)!.lastDigestAt).toBe(local(2026, 9, 7, 18, 0));
  });

  describe("across the DST fall-back night (America/New_York)", () => {
    const tz = process.env.TZ;
    afterEach(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });

    it("sends October 31 once and November 1 once, 25 hours later", async () => {
      process.env.TZ = "America/New_York";
      const h = harness();
      h.setNow(local(2026, 10, 30, 9, 0));
      const workflow = withDigest(h);
      h.setNow(local(2026, 10, 31, 18, 0));
      await h.engine.tick();
      expect(kinds(h)).toEqual(["digest"]);
      // Just after midnight on the 1st — the clock has not fallen back yet
      // (that is at 02:00) but "today's slot minus 24 hours" already lies.
      for (const at of [local(2026, 11, 1, 0, 5), local(2026, 11, 1, 3, 0), local(2026, 11, 1, 17, 59)]) {
        h.setNow(at);
        await h.engine.tick();
      }
      expect(kinds(h)).toEqual(["digest"]);
      h.setNow(local(2026, 11, 1, 18, 0));
      await h.engine.tick();
      expect(kinds(h)).toEqual(["digest", "digest"]);
      expect(h.notifications[1]!.message).toContain("daily digest for 2026-11-01");
      expect(h.store.get(workflow.id)!.lastDigestAt! - local(2026, 10, 31, 18, 0)).toBe(25 * HOUR);
    });
  });

  it("a workflow with no runs at all is still reported, and one without digestAt never is", async () => {
    const h = harness();
    withDigest(h);
    h.store.create(pipeline({ name: "Silent" }));
    h.setNow(local(2026, 9, 7, 18, 0));
    await h.engine.tick();
    expect(h.notifications).toEqual([
      { runId: expect.stringMatching(/^digest-/), kind: "digest", message: 'Workflow "Release" daily digest for 2026-09-07: no run ended since the previous digest' },
    ]);
  });
});

describe("health", () => {
  it("reports version, uptime, the last tick, live and stuck runs, the next slot and the last failure", async () => {
    const h = harness();
    const scheduled = h.store.create(
      pipeline({ stuckAfterMinutes: 10, triggers: { schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] } } }),
    );
    const idle = h.store.create(pipeline({ name: "Idle", digestAt: "07:30" }));
    const before = h.engine.health();
    expect(before.engine).toEqual({ startedAt: T0, uptimeMs: 0, lastTickAt: null });
    expect(before.version).toBe("9.9.9-test");
    expect(before.ok).toBe(true);

    await h.engine.tick(); // arms the schedule
    const run = h.engine.startRun(scheduled.id, "go", "manual");
    const dead = h.engine.startRun(idle.id, "go", "manual");
    h.dispatches[1]!.onDispatchError('Node "plan" requires "deploy" but its bot "planner" is not allowed to deploy.');
    h.setNow(T0 + 11 * MIN);
    await h.engine.tick();

    const health = h.engine.health();
    expect(health.ok).toBe(false);
    expect(health.now).toBe(T0 + 11 * MIN);
    expect(health.engine).toEqual({ startedAt: T0, uptimeMs: 11 * MIN, lastTickAt: T0 + 11 * MIN });
    expect(health.runs).toMatchObject({ live: 1, queued: 0, running: 1, waitingApproval: 0 });
    expect(health.runs.stuck).toEqual([
      {
        runId: run.id,
        workflowId: scheduled.id,
        workflowName: "Release",
        nodeId: "plan",
        status: "running",
        since: T0,
        stuckForMs: 11 * MIN,
        attempt: 0,
        lastNotifiedAt: T0 + 11 * MIN,
      },
    ]);
    expect(health.lastFailure).toMatchObject({ runId: dead.id, workflowId: idle.id, workflowName: "Idle", nodeId: "plan" });
    expect(health.workflows).toEqual([
      expect.objectContaining({ id: scheduled.id, schedule: "daily", nextRunAt: T0 + HOUR, liveRunId: run.id, liveRunStatus: "running", lastRun: null }),
      expect.objectContaining({
        id: idle.id,
        schedule: null,
        nextRunAt: null,
        liveRunId: null,
        lastRun: { id: dead.id, status: "failed", endedAt: T0 },
        digestAt: "07:30",
        // 07:30 was before the definition was saved: the first digest is
        // tomorrow's, so nothing has been sent yet.
        lastDigestAt: null,
      }),
    ]);
    // Stable: the document is plain JSON with no functions or dates.
    expect(JSON.parse(JSON.stringify(health))).toEqual(health);
  });
});
