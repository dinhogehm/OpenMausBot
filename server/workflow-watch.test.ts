// The engine's observability rules as pure tables: when a run counts as
// stuck and how that is worded, the digest's slot math and paragraph, and
// the health document's shape. No engine, no store — the engine tests in
// workflow-watchdog.test.ts prove the wiring.
import { afterEach, describe, expect, it } from "vitest";

import type { Workflow, WorkflowNode, WorkflowRun } from "../shared/workflow.ts";
import {
  buildDigest,
  describeStuck,
  digestSlotAt,
  digestWindowStart,
  formatDuration,
  inOutageBackoff,
  nodeSince,
  stuckAnnouncementDue,
  stuckThresholdMs,
  stuckVerdict,
  workflowEngineHealth,
} from "./workflow-watch.ts";

const MIN = 60_000;
const HOUR = 3_600_000;

const agent: WorkflowNode = { kind: "agent", id: "ship", botId: "shipper", instructions: "Ship.", outcomes: ["shipped"] };
const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: "wf-1",
  name: "Release",
  entryNodeId: "ship",
  nodes: [agent],
  edges: [],
  layout: {},
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});
const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "run-1",
  workflowId: "wf-1",
  status: "running",
  currentNodeId: "ship",
  attempt: 0,
  input: "",
  nodeResults: [],
  startedAt: 1_000,
  ...overrides,
});

describe("formatDuration", () => {
  it("reads like a person says it", () => {
    expect(formatDuration(0)).toBe("under a minute");
    expect(formatDuration(59_000)).toBe("under a minute");
    expect(formatDuration(48 * MIN)).toBe("48m");
    expect(formatDuration(2 * HOUR + 6 * MIN)).toBe("2h 6m");
    expect(formatDuration(3 * HOUR)).toBe("3h");
    expect(formatDuration(26 * HOUR + 30 * MIN)).toBe("1d 2h");
    expect(formatDuration(48 * HOUR)).toBe("2d");
    expect(formatDuration(-5)).toBe("under a minute");
  });
});

describe("nodeSince", () => {
  it("trusts the engine's stamp, then the latest honest instant of an older receipt", () => {
    expect(nodeSince(run({ nodeEnteredAt: 9_000, startedAt: 1_000 }))).toBe(9_000);
    // No stamp: the previous node's end beats the run's start…
    expect(
      nodeSince(run({ nodeResults: [{ nodeId: "plan", outcome: "done", summary: "ok", startedAt: 2_000, endedAt: 5_000 }] })),
    ).toBe(5_000);
    // …and a later dispatch beats that (a retry dispatched after the last
    // result is still the newest thing known about this stay).
    expect(
      nodeSince(
        run({
          dispatchedAt: 7_000,
          nodeResults: [{ nodeId: "plan", outcome: "done", summary: "ok", startedAt: 2_000, endedAt: 5_000 }],
        }),
      ),
    ).toBe(7_000);
    expect(nodeSince(run())).toBe(1_000);
  });
});

describe("stuckThresholdMs", () => {
  it("is the workflow's patience for an agent node, defaulting to two hours", () => {
    expect(stuckThresholdMs(workflow(), run(), agent)).toBe(120 * MIN);
    expect(stuckThresholdMs(workflow({ stuckAfterMinutes: 45 }), run(), agent)).toBe(45 * MIN);
  });

  it("exempts a wait node, an outage wait and anything not live", () => {
    const wait: WorkflowNode = { kind: "wait", id: "pause", minutes: 30 };
    expect(stuckThresholdMs(workflow(), run({ currentNodeId: "pause", waitUntil: 5 }), wait)).toBeNull();
    // A wait whose node was edited away still carries waitUntil.
    expect(stuckThresholdMs(workflow(), run({ waitUntil: 5 }), undefined)).toBeNull();
    const outage = { since: 1, until: 2, attempts: 1, of: 10, reason: "503", waitUntil: 9 };
    expect(inOutageBackoff(run({ outage, nextAttemptAt: 9 }))).toBe(true);
    expect(stuckThresholdMs(workflow(), run({ outage, nextAttemptAt: 9 }), agent)).toBeNull();
    // An outage record without a scheduled attempt is the hand-off to the
    // fallback — a live dispatch, judged like any other.
    expect(stuckThresholdMs(workflow(), run({ outage }), agent)).toBe(120 * MIN);
    // A park for a BUSY bot after the backoff keeps the record but not the
    // wait: the run is waiting on a bot, which is what the watchdog is for.
    const consumed = { ...outage, waitUntil: undefined };
    expect(inOutageBackoff(run({ outage: consumed, nextAttemptAt: 9 }))).toBe(false);
    expect(stuckThresholdMs(workflow(), run({ outage: consumed, nextAttemptAt: 9 }), agent)).toBe(120 * MIN);
    // An older receipt (no waitUntil) parked on a backoff is judged too:
    // the safe side is to speak.
    expect(stuckThresholdMs(workflow(), run({ outage: consumed, nextAttemptAt: 99 }), agent)).toBe(120 * MIN);
    // A run in pre-flight (checks running, or parked for a busy bot's
    // re-check) answers to the checks' own clock.
    expect(stuckThresholdMs(workflow(), run({ preflightStartedAt: 5 }), agent)).toBeNull();
    expect(stuckThresholdMs(workflow(), run({ preflightStartedAt: 5, nextAttemptAt: 99 }), agent)).toBeNull();
    expect(stuckThresholdMs(workflow(), run({ status: "queued" }), agent)).toBeNull();
    expect(stuckThresholdMs(workflow(), run({ status: "completed" }), agent)).toBeNull();
  });

  it("judges an approval gate against its own expiry, times 1.5", () => {
    const gate: WorkflowNode = { kind: "approval", id: "gate", prompt: "OK?", expiresHours: 2 };
    expect(stuckThresholdMs(workflow(), run({ status: "waiting-approval", currentNodeId: "gate" }), gate)).toBe(3 * HOUR);
    const defaulted: WorkflowNode = { kind: "approval", id: "gate", prompt: "OK?" };
    expect(stuckThresholdMs(workflow(), run({ status: "waiting-approval" }), defaulted)).toBe(36 * HOUR);
    // A gate whose node is gone is judged on the default window.
    expect(stuckThresholdMs(workflow(), run({ status: "waiting-approval" }), undefined)).toBe(36 * HOUR);
  });

  it("gives a re-notifying gate its whole budget of windows before calling it stuck", () => {
    // Two windows of 2h (the first ask plus two re-asks = three windows)
    // is the gate's legitimate life; only past 1.5× that is it stuck.
    const renotify: WorkflowNode = { kind: "approval", id: "gate", prompt: "OK?", expiresHours: 2, onExpire: "renotify", maxRenotify: 2 };
    expect(stuckThresholdMs(workflow(), run({ status: "waiting-approval", currentNodeId: "gate" }), renotify)).toBe(9 * HOUR);
    // The default round count when the node does not say.
    const defaulted: WorkflowNode = { kind: "approval", id: "gate", prompt: "OK?", expiresHours: 1, onExpire: "renotify" };
    expect(stuckThresholdMs(workflow(), run({ status: "waiting-approval", currentNodeId: "gate" }), defaulted)).toBe(9 * HOUR);
    // Any other expiry policy keeps the single window.
    const approved: WorkflowNode = { kind: "approval", id: "gate", prompt: "OK?", expiresHours: 2, onExpire: "approved", maxRenotify: 2 };
    expect(stuckThresholdMs(workflow(), run({ status: "waiting-approval", currentNodeId: "gate" }), approved)).toBe(3 * HOUR);
  });
});

describe("stuckVerdict and the announcement cadence", () => {
  it("is null until the threshold is exceeded, then measures from the entry", () => {
    const parked = run({ nodeEnteredAt: 10_000 });
    expect(stuckVerdict(workflow(), parked, agent, 10_000 + 120 * MIN)).toBeNull();
    expect(stuckVerdict(workflow(), parked, agent, 10_000 + 120 * MIN + 1)).toEqual({
      since: 10_000,
      forMs: 120 * MIN + 1,
      thresholdMs: 120 * MIN,
    });
  });

  it("announces once, then at most once per further period, and never past the cap", () => {
    const verdict = { since: 0, forMs: 3 * HOUR, thresholdMs: 2 * HOUR };
    expect(stuckAnnouncementDue(run(), verdict, 3 * HOUR)).toBe(true);
    expect(stuckAnnouncementDue(run({ stuckNotifiedAt: 2 * HOUR }), verdict, 3 * HOUR)).toBe(false);
    expect(stuckAnnouncementDue(run({ stuckNotifiedAt: 2 * HOUR }), verdict, 4 * HOUR)).toBe(true);
    expect(stuckAnnouncementDue(run({ stuckNotifiedAt: 2 * HOUR, stuckAnnouncements: 11 }), verdict, 40 * HOUR)).toBe(true);
    expect(stuckAnnouncementDue(run({ stuckNotifiedAt: 2 * HOUR, stuckAnnouncements: 12 }), verdict, 40 * HOUR)).toBe(false);
  });
});

describe("describeStuck", () => {
  const verdict = { since: 0, forMs: 2 * HOUR + 6 * MIN, thresholdMs: 2 * HOUR };

  it("names the node, the stay, the bot, the attempt, the activity and the last receipt line", () => {
    const stuck = run({
      attempt: 1,
      currentThreadId: "t-2",
      dispatchedAt: HOUR,
      nodeResults: [{ nodeId: "plan", outcome: "done", summary: "Drafted the plan.", startedAt: 0, endedAt: 10 }],
    });
    expect(describeStuck(stuck, agent, verdict, 2 * HOUR + 6 * MIN)).toBe(
      'run stuck at node "ship" for 2h 6m (bot "shipper", attempt 2 of 3, turn live for 1h 6m) — last step plan: done — Drafted the plan.',
    );
  });

  it("says what the run is waiting on when no turn is live, and names the fallback holding the node", () => {
    const now = 2 * HOUR + 6 * MIN;
    expect(describeStuck(run({ nextAttemptAt: now + 5 * MIN }), agent, verdict, now)).toContain("next attempt in 5m");
    expect(describeStuck(run({ nextAttemptAt: now - 1 }), agent, verdict, now)).toContain("waiting for the bot to be free");
    expect(describeStuck(run({ currentBotId: "spare" }), agent, verdict, now)).toContain('bot "spare"');
    expect(describeStuck(run(), agent, verdict, now)).toContain("no step has finished yet");
    expect(describeStuck(run({ status: "waiting-approval", currentNodeId: "gate" }), undefined, verdict, now)).toBe(
      'run stuck at node "gate" for 2h 6m (waiting for a decision) — no step has finished yet',
    );
    expect(describeStuck(run({ currentNodeId: undefined }), undefined, verdict, now)).toContain(
      'run stuck at node "?" for 2h 6m (its node is gone from the workflow)',
    );
  });

  it("clips a long summary so the line fits a notification", () => {
    const long = run({ nodeResults: [{ nodeId: "plan", outcome: "done", summary: "x".repeat(400), startedAt: 0, endedAt: 1 }] });
    const line = describeStuck(long, agent, verdict, 3 * HOUR);
    expect(line.length).toBeLessThan(260);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("digestSlotAt", () => {
  const local = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).getTime();

  it("is today's slot once it has passed, else yesterday's", () => {
    expect(digestSlotAt("18:00", local(2026, 9, 7, 18, 0))).toBe(local(2026, 9, 7, 18, 0));
    expect(digestSlotAt("18:00", local(2026, 9, 7, 23, 59))).toBe(local(2026, 9, 7, 18, 0));
    expect(digestSlotAt("18:00", local(2026, 9, 7, 17, 59))).toBe(local(2026, 9, 6, 18, 0));
    expect(digestSlotAt("00:00", local(2026, 9, 7, 0, 0))).toBe(local(2026, 9, 7, 0, 0));
    expect(digestWindowStart("18:00", local(2026, 9, 7, 18, 0))).toBe(local(2026, 9, 6, 18, 0));
  });

  describe("across a DST change (America/New_York)", () => {
    const tz = process.env.TZ;
    afterEach(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });

    it("fall back: 'yesterday at 18:00' is the slot that was sent, 25 hours ago — not 19:00", () => {
      process.env.TZ = "America/New_York";
      // 2026-11-01 02:00 EDT → 01:00 EST. Just after midnight on the 1st,
      // the latest slot is Oct 31 18:00 — the very instant sent yesterday.
      const sent = local(2026, 10, 31, 18, 0);
      const slot = digestSlotAt("18:00", local(2026, 11, 1, 0, 5));
      expect(slot).toBe(sent);
      // The bug: "today's slot minus 24 hours" is Oct 31 19:00, newer than
      // what was sent, and a second digest for Oct 31 would go out.
      expect(local(2026, 11, 1, 18, 0) - 24 * 3_600_000).toBe(local(2026, 10, 31, 19, 0));
      expect(local(2026, 11, 1, 18, 0) - 24 * 3_600_000).toBeGreaterThan(sent);
      // At Nov 1 18:00 the slot is 25 hours after the previous one, and the
      // window starts exactly at the previous slot.
      expect(digestSlotAt("18:00", local(2026, 11, 1, 18, 0)) - sent).toBe(25 * 3_600_000);
      expect(digestWindowStart("18:00", local(2026, 11, 1, 18, 0))).toBe(sent);
    });

    it("spring forward: the day is 23 hours long and the slots still line up on the wall clock", () => {
      process.env.TZ = "America/New_York";
      // 2026-03-08 02:00 EST → 03:00 EDT.
      const sent = local(2026, 3, 7, 18, 0);
      expect(digestSlotAt("18:00", local(2026, 3, 8, 0, 5))).toBe(sent);
      expect(digestSlotAt("18:00", local(2026, 3, 8, 17, 59))).toBe(sent);
      expect(digestSlotAt("18:00", local(2026, 3, 8, 18, 0)) - sent).toBe(23 * 3_600_000);
      expect(digestWindowStart("18:00", local(2026, 3, 8, 18, 0))).toBe(sent);
    });
  });
});

describe("buildDigest", () => {
  const ended = (overrides: Partial<WorkflowRun>): WorkflowRun => run({ status: "completed", ...overrides });

  it("says so when nothing ended in the window", () => {
    const to = new Date(2026, 8, 7, 18, 0).getTime();
    expect(buildDigest([ended({ startedAt: to, endedAt: to })], to - 24 * HOUR, to)).toBe(
      "daily digest for 2026-09-07: no run ended since the previous digest",
    );
  });

  it("counts the outcomes, averages the completed ones and ranks failing nodes and denials", () => {
    const to = new Date(2026, 8, 7, 18, 0).getTime();
    const from = to - 24 * HOUR;
    const runs: WorkflowRun[] = [
      ended({ id: "a", startedAt: from + HOUR, endedAt: from + HOUR + 20 * MIN }),
      ended({ id: "b", startedAt: from + 2 * HOUR, endedAt: from + 2 * HOUR + 40 * MIN }),
      ended({
        id: "c",
        status: "failed",
        currentNodeId: "ship",
        startedAt: from + 3 * HOUR,
        endedAt: from + 4 * HOUR,
        nodeResults: [
          { nodeId: "plan", outcome: "failed", summary: "x", startedAt: 0, endedAt: 1, denials: ["shell gh (key shell:gh)"] },
          { nodeId: "plan", outcome: "done", summary: "x", startedAt: 0, endedAt: 1, denials: ["shell gh (key shell:gh)"] },
        ],
      }),
      ended({ id: "d", status: "cancelled", startedAt: from + 5 * HOUR, endedAt: from + 5 * HOUR + 1 }),
      // Outside the window on either side: not counted.
      ended({ id: "old", startedAt: from - 2 * HOUR, endedAt: from - 1 }),
      ended({ id: "new", startedAt: to, endedAt: to }),
      // Still live: no end, not counted.
      run({ id: "live" }),
    ];
    expect(buildDigest(runs, from, to)).toBe(
      "daily digest for 2026-09-07: 4 runs ended since the previous digest — 2 completed, 1 failed, 1 cancelled; average run time 30m; nodes that failed most: plan ×1, ship ×1; denials seen most: shell gh (key shell:gh) ×2",
    );
  });
});

describe("workflowEngineHealth", () => {
  it("reports counts, stuck runs, per-workflow clocks and the newest failure", () => {
    const wf = workflow({ triggers: { schedule: { type: "daily", time: "09:00", weekdays: [1] } }, nextRunAt: 50_000, digestAt: "18:00" });
    const other = workflow({ id: "wf-2", name: "Other", nextRunAt: null });
    const runs: WorkflowRun[] = [
      run({ id: "live", status: "running", nodeEnteredAt: 1_000, attempt: 2, stuckNotifiedAt: 3_000 }),
      run({ id: "old-fail", status: "failed", currentNodeId: "plan", error: "older", startedAt: 100, endedAt: 2_000 }),
      run({ id: "new-fail", status: "failed", currentNodeId: "ship", error: "newer", startedAt: 200, endedAt: 4_000 }),
      run({ id: "q", workflowId: "wf-2", status: "queued" }),
      run({ id: "gate", workflowId: "wf-2", status: "waiting-approval" }),
    ];
    const health = workflowEngineHealth({
      version: "1.2.3",
      now: 10_000,
      startedAt: 4_000,
      lastTickAt: 9_990,
      workflows: [wf, other],
      runs,
      stuck: [{ run: runs[0]!, verdict: { since: 1_000, forMs: 9_000, thresholdMs: 5_000 } }],
    });
    expect(health).toEqual({
      ok: false,
      version: "1.2.3",
      now: 10_000,
      engine: { startedAt: 4_000, uptimeMs: 6_000, lastTickAt: 9_990 },
      runs: {
        live: 3,
        queued: 1,
        running: 1,
        waitingApproval: 1,
        stuck: [
          {
            runId: "live",
            workflowId: "wf-1",
            workflowName: "Release",
            nodeId: "ship",
            status: "running",
            since: 1_000,
            stuckForMs: 9_000,
            attempt: 2,
            lastNotifiedAt: 3_000,
          },
        ],
        preflight: [],
      },
      lastFailure: { runId: "new-fail", workflowId: "wf-1", workflowName: "Release", nodeId: "ship", at: 4_000, error: "newer" },
      workflows: [
        {
          id: "wf-1",
          name: "Release",
          schedule: "daily",
          nextRunAt: 50_000,
          liveRunId: "live",
          liveRunStatus: "running",
          lastRun: { id: "new-fail", status: "failed", endedAt: 4_000 },
          lastFailure: { runId: "new-fail", workflowId: "wf-1", workflowName: "Release", nodeId: "ship", at: 4_000, error: "newer" },
          digestAt: "18:00",
          lastDigestAt: null,
          auditGroupId: null,
        },
        {
          id: "wf-2",
          name: "Other",
          schedule: null,
          nextRunAt: null,
          liveRunId: "q",
          liveRunStatus: "queued",
          lastRun: null,
          lastFailure: null,
          digestAt: null,
          lastDigestAt: null,
          auditGroupId: null,
        },
      ],
    });
  });

  it("lists a run in pre-flight under its own column, never as stuck", () => {
    const wf = workflow({ id: "wf-1", name: "Release" });
    const checking = run({ id: "chk", workflowId: "wf-1", currentNodeId: "entry", preflightStartedAt: 7_000 });
    const parked = run({ id: "prk", workflowId: "wf-1", currentNodeId: "entry", preflightStartedAt: 6_000, nextAttemptAt: 10_030 });
    const health = workflowEngineHealth({
      version: "x",
      now: 10_000,
      startedAt: 5,
      lastTickAt: null,
      workflows: [wf],
      runs: [checking, parked],
      stuck: [],
    });
    expect(health.ok).toBe(true);
    expect(health.runs.preflight).toEqual([
      { runId: "chk", workflowId: "wf-1", workflowName: "Release", nodeId: "entry", since: 7_000, inPreflightForMs: 3_000, waitingForBot: false },
      { runId: "prk", workflowId: "wf-1", workflowName: "Release", nodeId: "entry", since: 6_000, inPreflightForMs: 4_000, waitingForBot: true },
    ]);
  });

  it("is ok with nothing stuck and an empty store", () => {
    const health = workflowEngineHealth({ version: "x", now: 5, startedAt: 5, lastTickAt: null, workflows: [], runs: [], stuck: [] });
    expect(health.ok).toBe(true);
    expect(health.engine).toEqual({ startedAt: 5, uptimeMs: 0, lastTickAt: null });
    expect(health.lastFailure).toBeNull();
    expect(health.workflows).toEqual([]);
    expect(health.runs.preflight).toEqual([]);
  });
});
