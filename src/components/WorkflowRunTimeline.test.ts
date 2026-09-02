// The panel that says what a run did. Its contract is that everything an
// author needs is READABLE — the trigger, the status, the duration, the
// reason it failed and every step — rather than hidden behind a tooltip, and
// that it never offers a transcript that does not exist.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkflowRunTimeline } from "./WorkflowRunTimeline";
import type { WorkflowNodeResult, WorkflowRun } from "../../shared/workflow";

const NOW = 1_700_000_100_000;

const step = (overrides: Partial<WorkflowNodeResult> & { nodeId: string }): WorkflowNodeResult => ({
  outcome: "done",
  summary: "",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_002_500,
  ...overrides,
});

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "run-1",
  workflowId: "wf-1",
  status: "running",
  trigger: "manual",
  attempt: 0,
  input: "",
  nodeResults: [],
  startedAt: 1_700_000_000_000,
  ...overrides,
});

const panel = (overrides: Partial<Parameters<typeof WorkflowRunTimeline>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(WorkflowRunTimeline, {
      runs: [],
      run: null,
      pickedId: null,
      now: NOW,
      onPick: vi.fn(),
      ...overrides,
    }),
  );

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("WorkflowRunTimeline", () => {
  it("says there is nothing to watch when the workflow has never run", () => {
    const flat = text(panel());
    expect(flat).toContain("No runs yet");
    expect(flat).toContain("Switch back to Edit");
  });

  it("shows a queued run as queued with no steps, rather than an empty panel", () => {
    const queued = run({ status: "queued", trigger: "schedule" });
    const flat = text(panel({ runs: [queued], run: queued }));

    expect(flat).toContain("Queued");
    expect(flat).toContain("Schedule");
    expect(flat).toContain("no node has started yet");
    expect(flat).not.toContain("Open transcript");
  });

  it("lists every step in order with its node, outcome, summary and duration", () => {
    const walked = run({
      status: "waiting-approval",
      currentNodeId: "gate",
      nodeResults: [
        step({ nodeId: "plan", outcome: "review", summary: "drafted the release note", threadId: "t-1" }),
        step({ nodeId: "review", outcome: "changes", summary: "needs a shorter title", threadId: "t-2" }),
      ],
    });
    const flat = text(panel({ runs: [walked], run: walked, onOpenStep: vi.fn() }));

    expect(flat).toContain("plan");
    expect(flat).toContain("review");
    expect(flat).toContain("drafted the release note");
    expect(flat).toContain("needs a shorter title");
    expect(flat).toContain("2.5s");
    expect(flat).toContain("Waiting for approval");
    // a live run reports how long it has been going, from the injected clock
    expect(flat).toContain("Running for");
    // the run advances on its own, so its status is announced; the ticking
    // duration deliberately sits outside the live region
    expect(panel({ runs: [walked], run: walked })).toContain('role="status"');
  });

  it("offers a transcript only for a step that actually has a thread", () => {
    const mixed = run({
      status: "completed",
      endedAt: 1_700_000_010_000,
      nodeResults: [
        step({ nodeId: "plan", outcome: "done", threadId: "t-1" }),
        // a notify step never opens a task thread
        step({ nodeId: "tell-room", outcome: "sent" }),
      ],
    });
    const markup = panel({ runs: [mixed], run: mixed, onOpenStep: vi.fn() });

    expect(markup.match(/Open transcript/g)).toHaveLength(1);
    expect(text(markup)).toContain("tell-room");
  });

  it("offers no transcript at all when the caller cannot navigate", () => {
    const done = run({
      status: "completed",
      endedAt: 1_700_000_010_000,
      nodeResults: [step({ nodeId: "plan", outcome: "done", threadId: "t-1" })],
    });
    expect(text(panel({ runs: [done], run: done }))).not.toContain("Open transcript");
  });

  it("reads a missed scheduled slot as missed, not as a broken graph", () => {
    const missed = run({
      status: "failed",
      trigger: "schedule",
      error: "missed: the app was closed past the 12h catch-up window",
      endedAt: 1_700_000_000_000,
    });
    const flat = text(panel({ runs: [missed], run: missed }));

    expect(flat).toContain("Missed");
    expect(flat).not.toContain("Failed");
    expect(flat).toContain("the app was closed past the 12h catch-up window");
    // the machine marker is not shown to a human
    expect(flat).not.toContain("missed:");
  });

  it("prints a real failure's reason as text", () => {
    const broken = run({
      status: "failed",
      currentNodeId: "review",
      error: "node did not produce a valid outcome envelope",
      endedAt: 1_700_000_009_000,
      nodeResults: [step({ nodeId: "plan", outcome: "review" })],
    });
    const markup = panel({ runs: [broken], run: broken });

    expect(text(markup)).toContain("node did not produce a valid outcome envelope");
    expect(text(markup)).toContain("Failed");
    expect(markup).not.toContain("title=");
  });

  it("marks the observed run in the picker and only offers Follow latest once a pick is stuck", () => {
    const newer = run({ id: "newer", status: "completed", startedAt: 1_700_000_050_000, endedAt: 1_700_000_051_000 });
    const older = run({ id: "older", status: "failed", startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000 });

    const following = panel({ runs: [newer, older], run: newer, pickedId: null });
    expect(following).not.toContain("Follow latest");

    const picked = panel({ runs: [newer, older], run: older, pickedId: "older" });
    expect(picked).toContain("Follow latest");
    expect(picked).toContain('aria-current="true"');
  });
});
