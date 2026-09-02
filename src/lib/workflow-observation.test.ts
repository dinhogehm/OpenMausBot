// Everything the canvas needs to read a run is decided here, so the rules
// can be pinned without a React tree: which run is being observed, what tone
// each node wears, which edges the run actually walked, and how a duration
// reads. The engine's receipt shapes these tests reproduce are the real
// ones — a failed run keeps `currentNodeId` on the node that broke and
// records NO result for it, while every finished node leaves one behind.
import { describe, expect, it } from "vitest";

import {
  formatRunDuration,
  isActiveWorkflowRun,
  lastTraversedEdgeKey,
  latestNodeResult,
  nodeTone,
  observedRunFor,
  runDurationMs,
  runEdgeDecorator,
  runStatusLabel,
  traversedEdgeCounts,
  traversedEdgeKey,
  workflowRunsFor,
} from "./workflow-observation";
import type { WorkflowNodeResult, WorkflowRun } from "../../shared/workflow";

const result = (overrides: Partial<WorkflowNodeResult> & { nodeId: string }): WorkflowNodeResult => ({
  outcome: "done",
  summary: "",
  startedAt: 1_000,
  endedAt: 2_000,
  ...overrides,
});

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "run-1",
  workflowId: "wf-1",
  status: "running",
  attempt: 0,
  input: "",
  nodeResults: [],
  startedAt: 1_000,
  ...overrides,
});

describe("observedRunFor", () => {
  it("has nothing to observe when the workflow has no runs", () => {
    expect(observedRunFor([], "wf-1")).toBeNull();
    expect(observedRunFor([run({ workflowId: "other" })], "wf-1")).toBeNull();
  });

  it("follows the live run even when a finished one started later", () => {
    const live = run({ id: "live", status: "waiting-approval", startedAt: 1_000 });
    const newer = run({ id: "newer", status: "completed", startedAt: 9_000 });
    // the slice arrives newest-first, the way the store keeps it
    expect(observedRunFor([newer, live], "wf-1")?.id).toBe("live");
  });

  it("falls back to the most recent run when none is live", () => {
    const older = run({ id: "older", status: "completed", startedAt: 1_000 });
    const newer = run({ id: "newer", status: "failed", startedAt: 9_000 });
    expect(observedRunFor([newer, older], "wf-1")?.id).toBe("newer");
  });

  it("honours a pick, and ignores one that belongs to another workflow or is gone", () => {
    const mine = run({ id: "mine", status: "completed", startedAt: 9_000 });
    const older = run({ id: "older", status: "completed", startedAt: 1_000 });
    const foreign = run({ id: "foreign", workflowId: "wf-2" });

    expect(observedRunFor([mine, older, foreign], "wf-1", "older")?.id).toBe("older");
    expect(observedRunFor([mine, older, foreign], "wf-1", "foreign")?.id).toBe("mine");
    expect(observedRunFor([mine, older, foreign], "wf-1", "evicted")?.id).toBe("mine");
  });

  it("lists only this workflow's runs, in the order the store keeps them", () => {
    const runs = [run({ id: "a", startedAt: 9_000 }), run({ id: "b", workflowId: "wf-2" }), run({ id: "c" })];
    expect(workflowRunsFor(runs, "wf-1").map((candidate) => candidate.id)).toEqual(["a", "c"]);
  });

  it("counts queued, running and waiting-approval as live", () => {
    expect(isActiveWorkflowRun(run({ status: "queued" }))).toBe(true);
    expect(isActiveWorkflowRun(run({ status: "running" }))).toBe(true);
    expect(isActiveWorkflowRun(run({ status: "waiting-approval" }))).toBe(true);
    expect(isActiveWorkflowRun(run({ status: "completed" }))).toBe(false);
    expect(isActiveWorkflowRun(run({ status: "failed" }))).toBe(false);
    expect(isActiveWorkflowRun(run({ status: "cancelled" }))).toBe(false);
  });
});

describe("nodeTone", () => {
  it("leaves every node idle without a run, and while a run is only queued", () => {
    expect(nodeTone(null, "plan")).toBe("idle");
    expect(nodeTone(run({ status: "queued" }), "plan")).toBe("idle");
  });

  it("pulses the current node and marks the finished ones done", () => {
    const live = run({
      status: "running",
      currentNodeId: "review",
      nodeResults: [result({ nodeId: "plan" })],
    });
    expect(nodeTone(live, "review")).toBe("current");
    expect(nodeTone(live, "plan")).toBe("done");
    expect(nodeTone(live, "publish")).toBe("idle");
  });

  it("marks the node a failed run stopped on, which has no result of its own", () => {
    const broken = run({
      status: "failed",
      currentNodeId: "review",
      error: "node did not produce a valid outcome envelope",
      nodeResults: [result({ nodeId: "plan" })],
    });
    expect(nodeTone(broken, "review")).toBe("failed");
    expect(nodeTone(broken, "plan")).toBe("done");
  });

  it("marks an open gate waiting", () => {
    const gate = run({ status: "waiting-approval", currentNodeId: "gate" });
    expect(nodeTone(gate, "gate")).toBe("waiting");
  });

  it("never pulses a run that has stopped: a completed run's last node is done, not current", () => {
    const finished = run({
      status: "completed",
      currentNodeId: "publish",
      nodeResults: [result({ nodeId: "publish" })],
      endedAt: 5_000,
    });
    expect(nodeTone(finished, "publish")).toBe("done");
    // A cancelled run stopped somewhere without finishing that node — it is
    // neither done nor failed, and claiming either would be a lie.
    const stopped = run({ status: "cancelled", currentNodeId: "review", endedAt: 5_000 });
    expect(nodeTone(stopped, "review")).toBe("idle");
  });

  it("a node running again in a loop is current, not done", () => {
    const looping = run({
      status: "running",
      currentNodeId: "plan",
      nodeResults: [result({ nodeId: "plan", outcome: "revise" })],
    });
    expect(nodeTone(looping, "plan")).toBe("current");
  });
});

describe("latestNodeResult", () => {
  it("returns nothing for a node that never ran", () => {
    expect(latestNodeResult(run(), "plan")).toBeNull();
    expect(latestNodeResult(null, "plan")).toBeNull();
  });

  it("returns the last pass and how many times the node ran", () => {
    const looped = run({
      nodeResults: [
        result({ nodeId: "plan", outcome: "revise", summary: "first" }),
        result({ nodeId: "review", outcome: "changes" }),
        result({ nodeId: "plan", outcome: "done", summary: "second" }),
      ],
    });
    expect(latestNodeResult(looped, "plan")).toEqual({
      result: expect.objectContaining({ outcome: "done", summary: "second" }),
      passes: 2,
    });
    expect(latestNodeResult(looped, "review")?.passes).toBe(1);
  });
});

describe("traversed edges", () => {
  it("counts nothing for a queued run", () => {
    expect(traversedEdgeCounts(run({ status: "queued" })).size).toBe(0);
    expect(lastTraversedEdgeKey(run({ status: "queued" }))).toBeNull();
  });

  it("counts one entry per recorded outcome, keyed by node and outcome", () => {
    const looped = run({
      nodeResults: [
        result({ nodeId: "plan", outcome: "review" }),
        result({ nodeId: "review", outcome: "changes" }),
        result({ nodeId: "plan", outcome: "review" }),
        result({ nodeId: "review", outcome: "ship" }),
      ],
    });
    const counts = traversedEdgeCounts(looped);
    expect(counts.get(traversedEdgeKey("plan", "review"))).toBe(2);
    expect(counts.get(traversedEdgeKey("review", "changes"))).toBe(1);
    expect(counts.get(traversedEdgeKey("review", "ship"))).toBe(1);
    expect(counts.get(traversedEdgeKey("plan", "ship"))).toBeUndefined();
    expect(lastTraversedEdgeKey(looped)).toBe(traversedEdgeKey("review", "ship"));
  });
});

describe("runEdgeDecorator", () => {
  const looped = run({
    status: "running",
    currentNodeId: "review",
    nodeResults: [
      result({ nodeId: "plan", outcome: "review" }),
      result({ nodeId: "review", outcome: "changes" }),
      result({ nodeId: "plan", outcome: "review" }),
    ],
  });

  it("lights a traversed edge, labels it with the outcome and says how often it was walked", () => {
    const decorate = runEdgeDecorator(looped);
    const twice = decorate({ from: "plan", outcome: "review", to: "review" });
    expect(twice.label).toBe("review ×2");
    expect(twice.className).toContain("wf-edge-traversed");
    const once = decorate({ from: "review", outcome: "changes", to: "plan" });
    expect(once.label).toBe("changes");
    expect(once.className).toContain("wf-edge-traversed");
  });

  it("animates only the edge the run walked most recently, and only while it is live", () => {
    expect(runEdgeDecorator(looped)({ from: "plan", outcome: "review", to: "review" }).animated).toBe(true);
    expect(runEdgeDecorator(looped)({ from: "review", outcome: "changes", to: "plan" }).animated).toBe(false);
    const stopped = runEdgeDecorator({ ...looped, status: "cancelled", endedAt: 9_000 });
    expect(stopped({ from: "plan", outcome: "review", to: "review" }).animated).toBe(false);
  });

  it("mutes every edge the run did not walk, and mutes them all with no run", () => {
    const decorate = runEdgeDecorator(looped);
    const untaken = decorate({ from: "review", outcome: "ship", to: "publish" });
    expect(untaken.className).toContain("wf-edge-untaken");
    expect(untaken.label).toBe("ship");
    expect(untaken.animated).toBe(false);

    const none = runEdgeDecorator(null)({ from: "plan", outcome: "review", to: "review" });
    expect(none.className).toContain("wf-edge-untaken");
  });
});

describe("run labels and durations", () => {
  it("reads a missed scheduled slot as missed, never as a generic failure", () => {
    const missed = run({
      status: "failed",
      trigger: "schedule",
      error: "missed: the app was closed past the catch-up window",
      endedAt: 2_000,
    });
    expect(runStatusLabel(missed)).toBe("Missed");
    expect(runStatusLabel(run({ status: "failed", error: "provider exploded" }))).toBe("Failed");
    expect(runStatusLabel(run({ status: "waiting-approval" }))).toBe("Waiting for approval");
  });

  it("measures a finished run end to end and a live one up to now", () => {
    expect(runDurationMs(run({ startedAt: 1_000, endedAt: 4_500 }), 99_000)).toBe(3_500);
    expect(runDurationMs(run({ startedAt: 1_000 }), 4_000)).toBe(3_000);
    // a clock that went backwards must not produce a negative duration
    expect(runDurationMs(run({ startedAt: 5_000 }), 1_000)).toBe(0);
  });

  it("formats durations at a readable scale", () => {
    expect(formatRunDuration(0)).toBe("0.0s");
    expect(formatRunDuration(900)).toBe("0.9s");
    expect(formatRunDuration(3_500)).toBe("3.5s");
    expect(formatRunDuration(65_000)).toBe("1m 5s");
    expect(formatRunDuration(3_725_000)).toBe("1h 2m");
  });
});
