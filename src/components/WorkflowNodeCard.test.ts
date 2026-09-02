// The node card is the only place a graph problem is visible while the
// author is drawing, so its diagnostics have to be text in the DOM — not a
// tooltip, not an aria-label on a role-less span (browsers drop those).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkflowNodeCard } from "./WorkflowNodeCard";
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
