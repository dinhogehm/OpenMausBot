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

describe("WorkflowNodePanel — pre-approved tools", () => {
  it("offers the node's keys one per line, only on agent nodes", () => {
    const markup = panel(agent({ alwaysAllow: ["Bash:gh", "session_search"] }), [scout]);
    expect(text(markup)).toContain("Pre-approved tools on this node");
    expect(markup).toMatch(/<textarea[^>]*id="wf-agent-1-always-allow"[^>]*>Bash:gh\nsession_search<\/textarea>/);
    // a node with none shows an empty field, and the hint names the shape of a key
    expect(panel(agent(), [scout])).toMatch(/<textarea[^>]*id="wf-agent-1-always-allow"[^>]*><\/textarea>/);
    expect(text(panel({ kind: "approval", id: "gate", prompt: "Ship it?" }, [scout]))).not.toContain("Pre-approved");
  });

  it("says what the keys buy and what they never buy, next to the field", () => {
    const flat = text(panel(agent(), [scout]));
    expect(flat).toContain("denied at once");
    expect(flat).toContain("Never covers destructive commands, credentials, or this computer");
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

  it("tells the author the fallback runs on its own standing permissions", () => {
    expect(text(panel(agent(), [scout, rook]))).toContain("runs with its own standing permissions");
  });

  it("only offers a fallback on agent nodes", () => {
    expect(text(panel({ kind: "approval", id: "gate", prompt: "Ship it?" }, [scout]))).not.toContain("Fallback bot");
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

describe("WorkflowNodePanel — approval gate", () => {
  type ApprovalNode = Extract<WorkflowNode, { kind: "approval" }>;
  const gate = (overrides: Partial<ApprovalNode> = {}): ApprovalNode => ({ kind: "approval", id: "gate", prompt: "Merge?", ...overrides });
  const rooms = [
    { id: "grp-1", name: "Deploys" },
    { id: "grp-2", name: "Reviews" },
  ];
  const gatePanel = (node: WorkflowNode, groups = rooms) =>
    renderToStaticMarkup(
      createElement(WorkflowNodePanel, {
        node,
        issues: [],
        entry: false,
        bots: [scout],
        groups,
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
  const expirySelect = (markup: string) => markup.match(/<select id="wf-gate-on-expire"[\s\S]*?<\/select>/)?.[0] ?? "";
  const roomSelect = (markup: string) => markup.match(/<select id="wf-gate-approval-room"[\s\S]*?<\/select>/)?.[0] ?? "";

  it("offers the three expiry policies, with the unset choice honest about what the engine does", () => {
    const select = expirySelect(gatePanel(gate()));
    expect(select).toMatch(/<option value="" selected="">Route to rejected \(unset\)<\/option>/);
    expect(select).toContain('<option value="renotify">Ask again, then route to rejected</option>');
    expect(select).toContain('<option value="approved">Route to approved</option>');
    expect(select).toContain('<option value="rejected">Route to rejected</option>');
    expect(expirySelect(gatePanel(gate({ onExpire: "renotify" })))).toMatch(/<option value="renotify" selected="">/);
  });

  it("shows the round count only under the renotify policy, with its default and bounds", () => {
    const flat = text(gatePanel(gate({ onExpire: "renotify", maxRenotify: 3 })));
    expect(flat).toContain("Ask again up to (times)");
    expect(flat).toContain("(1–30 rounds)");
    expect(gatePanel(gate({ onExpire: "renotify", maxRenotify: 3 }))).toMatch(/<input id="wf-gate-max-renotify"[^>]*value="3"/);
    expect(gatePanel(gate({ onExpire: "renotify" }))).toMatch(/<input id="wf-gate-max-renotify"[^>]*placeholder="5"/);
    expect(text(gatePanel(gate({ onExpire: "rejected" })))).not.toContain("Ask again up to");
    expect(text(gatePanel(gate()))).not.toContain("Ask again up to");
  });

  it("offers every room with 'none' first, keeps a room the roster lost as missing, and says where the card always lands", () => {
    const none = roomSelect(gatePanel(gate()));
    expect(none).toMatch(/<option value="" selected="">None — the bot&#x27;s chat only<\/option>/);
    expect(none).toContain('<option value="grp-1">Deploys</option>');
    expect(none).not.toContain("Missing room");

    const picked = roomSelect(gatePanel(gate({ notifyTargetGroupId: "grp-2" })));
    expect(picked).toMatch(/<option value="grp-2" selected="">Reviews<\/option>/);

    const missing = roomSelect(gatePanel(gate({ notifyTargetGroupId: "gone" })));
    expect(missing).toMatch(/<option value="missing" disabled="" selected="">Missing room gone<\/option>/);

    expect(text(gatePanel(gate()))).toContain("always lands in the chat of the bot that ran the previous step");
  });

  it("writes the room id when one is picked and drops the key on 'none'; leaving renotify drops the round count", () => {
    // renderToStaticMarkup cannot fire events; the edits are the whole-node
    // replacements the selects call, pinned here as data.
    const withRoom: ApprovalNode = { ...gate(), notifyTargetGroupId: "grp-1" };
    const { notifyTargetGroupId: _room, ...noRoom } = withRoom;
    expect(_room).toBe("grp-1");
    expect(noRoom).toEqual(gate());
    const renotifying = gate({ onExpire: "renotify", maxRenotify: 4 });
    const { maxRenotify: _rounds, ...rest } = renotifying;
    expect(_rounds).toBe(4);
    expect({ ...rest, onExpire: "approved" }).toEqual(gate({ onExpire: "approved" }));
  });

  it("only offers the expiry policy and the room on approval nodes", () => {
    const markup = panel(agent(), [scout]);
    expect(markup).not.toContain('id="wf-agent-1-on-expire"');
    expect(markup).not.toContain('id="wf-agent-1-approval-room"');
  });
});
