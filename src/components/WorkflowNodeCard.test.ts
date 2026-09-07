// The node card is the only place a graph problem is visible while the
// author is drawing, so its diagnostics have to be text in the DOM — not a
// tooltip, not an aria-label on a role-less span (browsers drop those).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkflowNodeCard, formatWaitMinutes } from "./WorkflowNodeCard";
import { outcomeHandles } from "@/lib/workflow-graph";
import type { WorkflowIssue, WorkflowNode } from "../../shared/workflow";

const card = (
  node: WorkflowNode,
  overrides: Partial<Parameters<typeof WorkflowNodeCard>[0]> = {},
  issues: WorkflowIssue[] = [],
  entry = false,
) =>
  renderToStaticMarkup(
    createElement(WorkflowNodeCard, {
      data: { node, entry, issues, outcomes: outcomeHandles(node) },
      ...overrides,
    }),
  );

const agent: WorkflowNode = {
  kind: "agent",
  id: "agent-1",
  botId: "bot-a",
  instructions: "Read the inbox and decide whether it needs a human.",
  outcomes: ["escalate", "resolved"],
};

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("WorkflowNodeCard — run tone", () => {
  const bot = { name: "Scout", color: "green" } as const;

  it("names the state a run puts the node in, rather than only colouring it", () => {
    expect(text(card(agent, { bot, tone: "current" }))).toContain("Running");
    expect(text(card(agent, { bot, tone: "waiting" }))).toContain("Waiting");
    expect(text(card(agent, { bot, tone: "failed" }))).toContain("Stopped here");
  });

  it("pulses the node in flight and the gate holding the run, and nothing else", () => {
    expect(card(agent, { bot, tone: "current" })).toContain("animate-pulse");
    expect(card(agent, { bot, tone: "waiting" })).toContain("animate-pulse");
    expect(card(agent, { bot, tone: "failed" })).not.toContain("animate-pulse");
    // `done` says what it produced in the footer, so it needs no badge
    expect(text(card(agent, { bot, tone: "done" }))).not.toContain("Running");
    expect(card(agent, { bot, tone: "idle" })).not.toContain("animate-pulse");
  });

  it("renders the run controls the observation view puts in the footer slot", () => {
    const markup = card(agent, { bot, footer: "Approve or reject" });
    expect(markup).toContain("Approve or reject");
    // the slot is drag-proof, or clicking a control would move the node
    expect(markup).toContain("nodrag nopan");
  });
});

describe("WorkflowNodeCard — agent", () => {
  it("names the bot, the node id and every outcome including the implicit failure path", () => {
    const markup = card(agent, { bot: { name: "Scout", color: "green" } });
    const flat = text(markup);

    expect(flat).toContain("Scout");
    expect(flat).toContain("agent-1");
    expect(flat).toContain("escalate");
    expect(flat).toContain("resolved");
    expect(flat).toContain("failed");
    expect(flat).toContain("implicit failure path");
    expect(flat).toContain("Read the inbox");
  });

  it("says the bot is missing, and which id broke, when it no longer resolves", () => {
    const flat = text(card(agent, { bot: null }));

    expect(flat).toContain("Bot missing");
    expect(flat).toContain("bot-a");
    expect(flat).toContain("no longer exists");
  });

  it("marks the entry node", () => {
    expect(text(card(agent, { bot: { name: "Scout", color: "green" } }, [], true))).toContain("Entry");
    expect(text(card(agent, { bot: { name: "Scout", color: "green" } }))).not.toContain("Entry");
  });

  it("prints each issue as readable text with its severity, never only a tooltip", () => {
    const markup = card(agent, { bot: { name: "Scout", color: "green" } }, [
      { severity: "error", code: "unreachable", nodeId: "agent-1", message: 'Node "agent-1" is unreachable.' },
      { severity: "warning", code: "unwired-failure", nodeId: "agent-1", message: "no failure edge" },
    ]);
    const flat = text(markup);

    expect(flat).toContain("Error:");
    expect(flat).toContain("is unreachable.");
    expect(flat).toContain("Warning:");
    expect(flat).toContain("no failure edge");
    // no mouse-only diagnostics: the messages are text, not a tooltip
    expect(markup).not.toContain("title=");
    // …and the severity rides in sr-only copy, never an aria-label on a
    // role-less span, which browsers drop (the avatar's svg[role=img] is the
    // one legitimately named element on the card).
    expect(markup.replace(/<svg[\s\S]*?<\/svg>/g, "")).not.toContain("aria-label=");
  });
});

describe("WorkflowNodeCard — capability requirements", () => {
  const needsMerge: WorkflowNode = { ...agent, requires: ["merge"] };

  it("tags each requirement, red with a textual cue when the bot lacks it", () => {
    const markup = card(needsMerge, { bot: { name: "Scout", color: "green" } });
    const flat = text(markup);

    expect(flat).toContain("needs merge");
    expect(markup).toMatch(/text-danger[^>]*>needs merge/);
    // colour is never the only signal
    expect(flat).toContain("bot not allowed");
    expect(markup).not.toContain("title=");
  });

  it("draws the tag quietly when the bot holds the capability", () => {
    const markup = card(needsMerge, { bot: { name: "Scout", color: "green", canMerge: true } });

    expect(text(markup)).toContain("needs merge");
    expect(markup).not.toMatch(/text-danger[^>]*>needs merge/);
    expect(text(markup)).not.toContain("bot not allowed");
  });

  it("tags every requirement, judging each on its own flag", () => {
    const both: WorkflowNode = { ...agent, requires: ["merge", "deploy"] };
    const markup = card(both, { bot: { name: "Scout", color: "green", canMerge: true } });

    expect(markup).not.toMatch(/text-danger[^>]*>needs merge/);
    expect(markup).toMatch(/text-danger[^>]*>needs deploy/);
  });

  it("shows no tag for a node that requires nothing", () => {
    const flat = text(card(agent, { bot: { name: "Scout", color: "green", canMerge: true } }));
    expect(flat).not.toContain("needs merge");
    expect(flat).not.toContain("needs deploy");
  });
});

describe("WorkflowNodeCard — approval and notify", () => {
  it("shows the approval prompt and both decision outcomes", () => {
    const flat = text(card({ kind: "approval", id: "approval-1", prompt: "Ship the release?" }));

    expect(flat).toContain("Ship the release?");
    expect(flat).toContain("approved");
    expect(flat).toContain("rejected");
  });

  it("falls back to a placeholder when an approval has no prompt yet", () => {
    expect(text(card({ kind: "approval", id: "approval-1", prompt: "" }))).toContain("No prompt yet");
  });

  it("names the target room, its template and the single sent outcome", () => {
    const node: WorkflowNode = { kind: "notify", id: "notify-1", targetGroupId: "g1", template: "All done" };
    const flat = text(card(node, { groupName: "Ops room" }));

    expect(flat).toContain("Ops room");
    expect(flat).toContain("All done");
    expect(flat).toContain("sent");
  });

  it("says so when the target room no longer resolves", () => {
    const node: WorkflowNode = { kind: "notify", id: "notify-1", targetGroupId: "g1", template: "All done" };
    expect(text(card(node, { groupName: null }))).toContain("no longer exists");
  });
});

describe("WorkflowNodeCard — wait", () => {
  it("says how long the pause is and offers the single elapsed outcome", () => {
    const flat = text(card({ kind: "wait", id: "wait-1", minutes: 30 }));
    expect(flat).toContain("Wait");
    expect(flat).toContain("wait-1");
    expect(flat).toContain("Pauses the run for 30 min");
    expect(flat).toContain("elapsed");
  });

  it("prints long pauses in hours", () => {
    expect(formatWaitMinutes(60)).toBe("1 h");
    expect(formatWaitMinutes(90)).toBe("1 h 30 min");
    expect(formatWaitMinutes(1_440)).toBe("24 h");
    expect(formatWaitMinutes(5)).toBe("5 min");
  });
});

describe("WorkflowNodeCard — handle slots", () => {
  it("renders one source handle per outcome and a single target handle", () => {
    const markup = card(agent, {
      bot: { name: "Scout", color: "green" },
      renderSourceHandle: (handle) =>
        createElement("i", { key: handle.outcome, "data-handle": handle.outcome }),
      renderTargetHandle: () => createElement("i", { "data-handle": "in" }),
    });

    expect(markup).toContain('data-handle="escalate"');
    expect(markup).toContain('data-handle="resolved"');
    expect(markup).toContain('data-handle="failed"');
    expect(markup).toContain('data-handle="in"');
  });
});
