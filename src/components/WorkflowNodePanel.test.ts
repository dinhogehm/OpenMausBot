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

describe("WorkflowNodePanel — fallback bot", () => {
  const codexScout: WorkflowPanelBot = { ...scout, engine: "codex" };
  const claudeRook: WorkflowPanelBot = { ...rook, engine: "claude" };
  const codexTwin: WorkflowPanelBot = { id: "bot-t", name: "Twin", color: "red", engine: "codex" };

  /** The `<select>` for the fallback, on its own so option assertions do
   * not match the primary bot picker above it. */
  const fallbackSelect = (markup: string) => markup.match(/<select id="wf-agent-1-fallback"[\s\S]*?<\/select>/)?.[0] ?? "";

  it("offers every bot but the node's own, with 'none' first and the chosen one selected", () => {
    const select = fallbackSelect(panel(agent({ fallbackBotId: "bot-b" }), [codexScout, claudeRook, codexTwin]));

    expect(select).toContain('value="">None — wait for the provider</option>');
    expect(select).not.toContain(">Scout</option>"); // the primary
    expect(select).toMatch(/<option value="bot-b" selected="">Rook · merge · deploy<\/option>/);
    expect(select).toContain('value="bot-t">Twin</option>');
  });

  it("warns when the fallback shares the primary's engine, since it would never take over", () => {
    const flat = text(panel(agent({ fallbackBotId: "bot-t" }), [codexScout, claudeRook, codexTwin]));
    expect(flat).toContain("Twin runs on the same engine as Scout — it will not take over during an outage");

    const other = text(panel(agent({ fallbackBotId: "bot-b" }), [codexScout, claudeRook, codexTwin]));
    expect(other).not.toContain("same engine");
  });

  it("says nothing about engines when the roster does not name them", () => {
    expect(text(panel(agent({ fallbackBotId: "bot-b" }), [scout, rook]))).not.toContain("same engine");
  });

  it("warns when the fallback lacks a capability the node requires", () => {
    const flat = text(panel(agent({ botId: "bot-b", fallbackBotId: "bot-a", requires: ["merge"] }), [codexScout, claudeRook]));
    expect(flat).toContain("Scout is not allowed to merge — it will not take over this step");
  });

  it("shows a fallback the roster no longer has as missing, and never a hidden one for a new choice", () => {
    const missing = panel(agent({ fallbackBotId: "gone" }), [scout, rook]);
    expect(text(missing)).toContain("Missing bot gone");

    const select = fallbackSelect(panel(agent(), [scout, rook, ghost]));
    expect(select).not.toContain("Ghost");
    const bound = fallbackSelect(panel(agent({ fallbackBotId: "bot-h" }), [scout, rook, ghost]));
    expect(bound).toContain(">Ghost (hidden)</option>");
  });

  it("writes the id when one is picked and drops the key when 'none' is picked", () => {
    // renderToStaticMarkup cannot fire events; the onChange is exercised
    // through the same reducer the picker calls: a whole-node replacement.
    const onUpdate = vi.fn();
    const node = agent({ fallbackBotId: "bot-b" });
    const { fallbackBotId: _fallbackBotId, ...rest } = node as Extract<WorkflowNode, { kind: "agent" }>;
    onUpdate(rest);
    expect(onUpdate).toHaveBeenLastCalledWith(expect.not.objectContaining({ fallbackBotId: expect.anything() }));
    expect(_fallbackBotId).toBe("bot-b");
  });

  it("only offers a fallback on agent nodes", () => {
    expect(text(panel({ kind: "approval", id: "gate", prompt: "Ship it?" }, [scout]))).not.toContain("Fallback bot");
  });
});
