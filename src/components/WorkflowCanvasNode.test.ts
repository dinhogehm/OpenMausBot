// The two decisions this component exists to hold, both of which were bugs
// found only by driving the real app and fixed with nothing but a comment
// holding them in place:
//
//   * a read-only canvas must reach the HANDLES, not just the node — xyflow
//     hands `isConnectable` to the node while `<Handle>` defaults its own to
//     true, so a card whose node was not connectable still offered a drag;
//   * an action's answer belongs to the run AND node it was issued for.
//
// The handle is injected, so both are assertable as flat markup with no flow
// provider in sight.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkflowCanvasNode, type WorkflowObservation } from "./WorkflowCanvasNode";
import { outcomeHandles } from "@/lib/workflow-graph";
import type { WorkflowNode, WorkflowRun } from "../../shared/workflow";

const agent: WorkflowNode = {
  kind: "agent",
  id: "agent-1",
  botId: "bot-a",
  instructions: "Draft the release note.",
  outcomes: ["done"],
};

const gate: WorkflowNode = { kind: "approval", id: "gate", prompt: "Ship it?" };

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "run-a",
  workflowId: "wf-1",
  status: "waiting-approval",
  currentNodeId: "gate",
  attempt: 0,
  input: "",
  nodeResults: [],
  startedAt: 1_000,
  ...overrides,
});

const observation = (overrides: Partial<WorkflowObservation> = {}): WorkflowObservation => ({
  run: run(),
  action: null,
  decide: vi.fn(),
  resume: vi.fn(),
  openThread: vi.fn(),
  ...overrides,
});

/** A stand-in for xyflow's `<Handle>` that simply reports what it was told. */
const card = (node: WorkflowNode, props: Partial<Parameters<typeof WorkflowCanvasNode>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(WorkflowCanvasNode, {
      data: { node, entry: false, issues: [], outcomes: outcomeHandles(node) },
      bot: { name: "Scout", color: "green" },
      renderHandle: (handle) =>
        createElement("i", {
          key: handle.key,
          "data-side": handle.side,
          "data-handle": handle.id,
          "data-connectable": String(handle.isConnectable),
          "data-class": handle.className,
        }),
      ...props,
    }),
  );

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("handles", () => {
  it("forwards a connectable node's flag to every handle", () => {
    const markup = card(agent, { isConnectable: true });
    // one target plus one handle per outcome, the implicit failure path included
    expect(markup.match(/data-connectable="true"/g)).toHaveLength(3);
    expect(markup).toContain('data-side="target"');
    expect(markup).toContain('data-handle="done"');
    expect(markup).toContain('data-handle="failed"');
  });

  it("forwards a READ-ONLY node's flag too, so no handle offers a connection", () => {
    // The bug: `nodesConnectable={false}` reaches the node, but `<Handle>`
    // defaults its own `isConnectable` to true — an unforwarded flag left a
    // read-only card draggable into a new edge.
    const markup = card(agent, { isConnectable: false });
    expect(markup).not.toContain('data-connectable="true"');
    expect(markup.match(/data-connectable="false"/g)).toHaveLength(3);
  });

  it("marks the implicit failure path apart from a declared outcome", () => {
    const markup = card(agent);
    expect(markup).toContain('data-class="wf-handle-source wf-handle-implicit"');
    expect(markup).toContain('data-handle="done" data-connectable="true" data-class="wf-handle-source"');
    expect(markup).toContain('data-class="wf-handle-target"');
  });
});

describe("run decoration", () => {
  it("draws nothing from a run in the editor", () => {
    const flat = text(card(gate));
    expect(flat).not.toContain("Waiting");
    expect(flat).not.toContain("Approve");
  });

  it("gives the gate its tone and its controls while a run waits on it", () => {
    const flat = text(card(gate, { observation: observation() }));
    expect(flat).toContain("Waiting");
    expect(flat).toContain("Approve");
    expect(flat).toContain("Reject");
  });

  it("marks where a cancelled run stopped", () => {
    const stopped = observation({ run: run({ status: "cancelled", endedAt: 4_000 }) });
    expect(text(card(gate, { observation: stopped }))).toContain("Cancelled here");
  });
});

describe("action scoping", () => {
  const failed = { runId: "run-a", nodeId: "gate", busy: false, error: "run is not waiting for approval" };

  it("reports the failure on the card whose button was pressed", () => {
    const flat = text(card(gate, { observation: observation({ action: failed }) }));
    expect(flat).toContain("run is not waiting for approval");
  });

  it("says nothing on another node of the same run", () => {
    // approving MOVES the run, so "the current node" is a different card
    const advanced = observation({
      run: run({ status: "running", currentNodeId: "agent-1" }),
      action: failed,
    });
    expect(text(card(agent, { observation: advanced }))).not.toContain("run is not waiting");
  });

  it("says nothing once the view has followed a different run", () => {
    // the observed run switches on its own whenever nothing is picked: a
    // scheduled run starting must not inherit the failed one's error
    const otherRun = observation({ run: run({ id: "run-b" }), action: failed });
    expect(text(card(gate, { observation: otherRun }))).not.toContain("run is not waiting");
  });

  it("shows the busy state only on the acting card", () => {
    const busy = { runId: "run-a", nodeId: "gate", busy: true, error: null };
    expect(card(gate, { observation: observation({ action: busy }) })).toContain('aria-disabled="true"');
    expect(card(gate, { observation: observation({ action: { ...busy, runId: "run-b" } }) })).not.toContain(
      'aria-disabled="true"',
    );
  });
});
