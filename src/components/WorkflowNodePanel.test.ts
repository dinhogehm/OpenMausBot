// The panel is where an author declares what a step needs and picks who runs
// it, so the two have to be legible together: the picker tags each bot with
// what it may do, and a requirement the chosen bot cannot meet is a sentence
// under the boxes — which bot, which permission, where to fix it — not a
// tooltip and not only a badge somewhere else on the canvas.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkflowNodePanel, botOptionLabel, type WorkflowPanelBot } from "./WorkflowNodePanel";
import { outcomeHandles } from "@/lib/workflow-graph";
import type { WorkflowNode } from "../../shared/workflow";

const scout: WorkflowPanelBot = { id: "bot-a", name: "Scout", color: "green" };
const rook: WorkflowPanelBot = { id: "bot-b", name: "Rook", color: "blue", canMerge: true, canDeploy: true };
const ghost: WorkflowPanelBot = { id: "bot-h", name: "Ghost", color: "green", hidden: true };

const agent = (overrides: Partial<Extract<WorkflowNode, { kind: "agent" }>> = {}): WorkflowNode => ({
  kind: "agent",
  id: "agent-1",
  botId: "bot-a",
  instructions: "Merge the release branch.",
  outcomes: ["done"],
  ...overrides,
});

const panel = (node: WorkflowNode, bots: WorkflowPanelBot[]) =>
  renderToStaticMarkup(
    createElement(WorkflowNodePanel, {
      node,
      issues: [],
      entry: false,
      bots,
      groups: [],
      outcomes: outcomeHandles(node),
      targets: [],
      routes: {},
      onRoute: vi.fn(),
      onUpdate: vi.fn(),
      onAddOutcome: vi.fn(),
      onRenameOutcome: vi.fn(),
      onRemoveOutcome: vi.fn(),
      onMakeEntry: vi.fn(),
      onDelete: vi.fn(),
      onClose: vi.fn(),
    }),
  );

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("WorkflowNodePanel — requires", () => {
  it("renders one checkbox per capability, ticked for what the node requires", () => {
    const markup = panel(agent({ requires: ["merge"] }), [scout]);

    expect(text(markup)).toContain("Requires");
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
    expect(markup).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""[^>]*\/>merge</);
    expect(markup).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked=""[^>]*\/>deploy</);
  });

  it("names the bot, the permission and where to grant it when the bot falls short", () => {
    const flat = text(panel(agent({ requires: ["merge", "deploy"] }), [scout]));

    expect(flat).toContain("Scout is not allowed to merge — enable it in the bot's settings");
    expect(flat).toContain("Scout is not allowed to deploy — enable it in the bot's settings");
  });

  it("says nothing when the bot holds what the node requires, or the node requires nothing", () => {
    expect(text(panel(agent({ botId: "bot-b", requires: ["merge", "deploy"] }), [scout, rook]))).not.toContain(
      "is not allowed to",
    );
    expect(text(panel(agent(), [scout]))).not.toContain("is not allowed to");
  });

  it("leaves the shortfall to the picker when the bot itself no longer resolves", () => {
    const flat = text(panel(agent({ botId: "gone", requires: ["merge"] }), [scout]));

    expect(flat).toContain("Missing bot gone");
    expect(flat).not.toContain("is not allowed to");
  });

  it("only offers requirements on agent nodes", () => {
    expect(text(panel({ kind: "approval", id: "gate", prompt: "Ship it?" }, [scout]))).not.toContain("Requires");
  });
});

describe("WorkflowNodePanel — bot picker", () => {
  it("tags each bot with the permissions it holds, in the option text itself", () => {
    const markup = panel(agent(), [scout, rook]);

    expect(markup).toContain(">Scout</option>");
    expect(markup).toContain(">Rook · merge · deploy</option>");
    expect(botOptionLabel({ id: "x", name: "Ivy", color: "green", canDeploy: true })).toBe("Ivy · deploy");
  });
});

describe("WorkflowNodePanel — hidden bots", () => {
  it("resolves the bound bot from the whole roster even when it is hidden, and says so", () => {
    const markup = panel(agent({ botId: "bot-h", requires: ["merge"] }), [scout, ghost]);
    const flat = text(markup);

    expect(markup).toContain(">Ghost (hidden)</option>");
    expect(flat).not.toContain("Missing bot");
    // …and judges its permissions like any other bound bot
    expect(flat).toContain("Ghost is not allowed to merge — enable it in the bot's settings");
  });

  it("never offers a hidden bot for a new binding", () => {
    const markup = panel(agent(), [scout, ghost]);

    expect(markup).toContain(">Scout</option>");
    expect(markup).not.toContain("Ghost");
  });

  it("keeps the hidden mark after the permission tags", () => {
    expect(botOptionLabel({ ...ghost, canMerge: true })).toBe("Ghost · merge (hidden)");
  });
});

describe("WorkflowNodePanel — wait", () => {
  it("offers the pause in minutes with its bounds, and no bot or room picker", () => {
    const markup = panel({ kind: "wait", id: "wait-1", minutes: 45 }, [scout]);
    const flat = text(markup);
    expect(flat).toContain("Wait");
    expect(flat).toContain("Pause (minutes)");
    expect(markup).toMatch(/<input[^>]*type="number"[^>]*value="45"/);
    expect(flat).toContain("1–1440");
    expect(flat).toContain("does not count toward the execution cap");
    expect(markup).not.toContain('id="wf-wait-1-bot"');
    expect(markup).not.toContain('id="wf-wait-1-room"');
    // Routing, which every node has: one row for the elapsed outcome.
    expect(markup.match(/<select/g)).toHaveLength(1);
    expect(flat).toContain("elapsed");
  });
});
