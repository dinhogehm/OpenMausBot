// The run controls that sit on a node card. Two things are pinned here: the
// action a run is waiting for appears on the RIGHT node and nowhere else,
// and every control that refuses says so in visible text — never a bare
// `disabled` attribute, which drops the button out of the tab order and
// explains nothing.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkflowRunNodeFooter } from "./WorkflowRunNodeFooter";
import type { WorkflowNodeResult, WorkflowRun } from "../../shared/workflow";

const step = (overrides: Partial<WorkflowNodeResult> & { nodeId: string }): WorkflowNodeResult => ({
  outcome: "done",
  summary: "",
  startedAt: 1_000,
  endedAt: 3_000,
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

const footer = (props: Partial<Parameters<typeof WorkflowRunNodeFooter>[0]> & { nodeId: string }) =>
  renderToStaticMarkup(createElement(WorkflowRunNodeFooter, { run: run(), ...props }));

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("WorkflowRunNodeFooter", () => {
  it("adds nothing to a node the run has not touched", () => {
    expect(footer({ nodeId: "plan" })).toBe("");
  });

  it("shows the node's outcome, a cut summary and how long it took", () => {
    const walked = run({
      currentNodeId: "review",
      nodeResults: [step({ nodeId: "plan", outcome: "review", summary: "drafted the note" })],
    });
    const flat = text(footer({ run: walked, nodeId: "plan" }));

    expect(flat).toContain("review");
    expect(flat).toContain("drafted the note");
    expect(flat).toContain("2.0s");
    expect(flat).toContain("Outcome:");
  });

  it("counts the passes when a loop ran the same node twice", () => {
    const looped = run({
      currentNodeId: "plan",
      nodeResults: [
        step({ nodeId: "plan", outcome: "review", summary: "first pass" }),
        step({ nodeId: "review", outcome: "changes" }),
        step({ nodeId: "plan", outcome: "review", summary: "second pass" }),
      ],
    });
    const flat = text(footer({ run: looped, nodeId: "plan" }));

    expect(flat).toContain("×2");
    // the LATEST pass is the one shown
    expect(flat).toContain("second pass");
    expect(flat).not.toContain("first pass");
  });

  it("offers approve and reject on the open gate, and on no other node", () => {
    const waiting = run({ status: "waiting-approval", currentNodeId: "gate" });

    const gate = text(footer({ run: waiting, nodeId: "gate", onApprove: vi.fn(), onReject: vi.fn() }));
    expect(gate).toContain("Approve");
    expect(gate).toContain("Reject");

    expect(footer({ run: waiting, nodeId: "plan", onApprove: vi.fn(), onReject: vi.fn() })).toBe("");
  });

  it("offers Resume here on the node a failed run stopped at, with the reason", () => {
    const broken = run({
      status: "failed",
      currentNodeId: "review",
      error: "node did not produce a valid outcome envelope",
      nodeResults: [step({ nodeId: "plan", outcome: "review" })],
    });
    const flat = text(footer({ run: broken, nodeId: "review", onResume: vi.fn() }));

    expect(flat).toContain("Resume here");
    expect(flat).toContain("node did not produce a valid outcome envelope");
    // the finished node keeps its result and offers no resume of its own
    expect(text(footer({ run: broken, nodeId: "plan", onResume: vi.fn() }))).not.toContain("Resume here");
  });

  it("offers a transcript only when the node's pass left a thread behind", () => {
    const withThread = run({ nodeResults: [step({ nodeId: "plan", threadId: "t-1" })] });
    const withoutThread = run({ nodeResults: [step({ nodeId: "tell-room", outcome: "sent" })] });

    expect(text(footer({ run: withThread, nodeId: "plan", onOpenThread: vi.fn() }))).toContain("Open transcript");
    expect(text(footer({ run: withoutThread, nodeId: "tell-room", onOpenThread: vi.fn() }))).not.toContain(
      "Open transcript",
    );
    // no navigation offered when the canvas cannot navigate
    expect(text(footer({ run: withThread, nodeId: "plan" }))).not.toContain("Open transcript");
  });

  it("refuses while an action is in flight with aria-disabled and a visible reason, never `disabled`", () => {
    const waiting = run({ status: "waiting-approval", currentNodeId: "gate" });
    const markup = footer({ run: waiting, nodeId: "gate", busy: true, onApprove: vi.fn(), onReject: vi.fn() });

    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("aria-describedby=");
    // the bare attribute, not the `aria-` one that ends in the same text
    expect(markup).not.toMatch(/\sdisabled[=\s>]/);
    expect(text(markup)).toContain("Working");
  });

  it("reports a rejected action as an alert, not a tooltip", () => {
    const waiting = run({ status: "waiting-approval", currentNodeId: "gate" });
    const markup = footer({
      run: waiting,
      nodeId: "gate",
      error: "run is not waiting for approval",
      onApprove: vi.fn(),
    });

    expect(markup).toContain('role="alert"');
    expect(text(markup)).toContain("run is not waiting for approval");
    expect(markup).not.toContain("title=");
  });
});
