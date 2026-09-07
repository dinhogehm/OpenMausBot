// The gate's card in a chat or a room, and a click on it — over a fake
// store that records every message, so the cases the engine tests cannot
// see (a second card never appears, a refresh rewrites the note, a second
// click answers what happened, a run that moved on closes the card) are
// pinned here without the app store.
import { describe, expect, it, vi } from "vitest";

import {
  WORKFLOW_APPROVAL_CARD_OPTIONS,
  WORKFLOW_APPROVAL_CARD_TOOL,
  workflowApprovalRequestId,
  type Workflow,
  type WorkflowRun,
} from "../shared/workflow.ts";
import {
  approvalCardHeld,
  approvalCardSubtitle,
  approvalCardTitle,
  approvalNudgeText,
  createWorkflowApprovalReach,
  resolveWorkflowApprovalCard,
  type ApprovalCardLike,
  type ApprovalCardMessage,
  type WorkflowApprovalReachStore,
} from "./workflow-approval-reach.ts";
import type { WorkflowApprovalAnnouncement } from "./workflow-run.ts";

type ApprovalNode = Extract<Workflow["nodes"][number], { kind: "approval" }>;

function fakeStore() {
  const threads = new Map<string, Array<ApprovalCardMessage & { kind: string; text?: string; from?: unknown }>>();
  const unread: string[] = [];
  let seq = 0;
  const store: WorkflowApprovalReachStore = {
    messagesFor: (threadId) => threads.get(threadId) ?? [],
    appendMessage: (threadId, message) => {
      const list = threads.get(threadId) ?? [];
      const stored = { id: `m${++seq}`, kind: message.kind, text: message.text, card: message.card, from: message.from };
      list.push(stored);
      threads.set(threadId, list);
      return { id: stored.id };
    },
    patchMessage: (threadId, messageId, patch) => {
      const message = (threads.get(threadId) ?? []).find((candidate) => candidate.id === messageId);
      if (!message) return null;
      message.card = patch.card;
      return message;
    },
    botThread: (botId) => (botId === "gone" ? null : `chat-${botId}`),
    groupThread: (groupId) => (groupId === "deleted-room" ? null : `room-${groupId}`),
    markBotUnread: (botId) => {
      unread.push(`bot:${botId}`);
    },
    markGroupUnread: (groupId) => {
      unread.push(`group:${groupId}`);
    },
  };
  const cards = (threadId: string) => (threads.get(threadId) ?? []).filter((m) => m.card).map((m) => m.card as ApprovalCardLike);
  const texts = (threadId: string) => (threads.get(threadId) ?? []).filter((m) => m.kind === "text").map((m) => m.text);
  return { store, threads, unread, cards, texts };
}

const node = (extra: Partial<ApprovalNode> = {}): ApprovalNode => ({ kind: "approval", id: "gate", prompt: "Merge the PR?", ...extra });
const workflow = (gate: ApprovalNode = node()): Workflow => ({
  id: "wf-1",
  name: "Delivery",
  entryNodeId: "review",
  nodes: [{ kind: "agent", id: "review", botId: "reviewer", instructions: "Review.", outcomes: ["done"] }, gate],
  edges: [{ from: "review", outcome: "done", to: "gate" }],
  layout: {},
  createdAt: 1,
  updatedAt: 1,
});
const run = (extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "run-1",
  workflowId: "wf-1",
  status: "waiting-approval",
  attempt: 0,
  input: "go",
  nodeResults: [{ nodeId: "review", outcome: "done", summary: "PR #42 is ready", threadId: "t1", startedAt: 10, endedAt: 20 }],
  startedAt: 5,
  currentNodeId: "gate",
  approvalRequestedAt: 20,
  ...extra,
});
const announcement = (extra: Partial<WorkflowApprovalAnnouncement> = {}): WorkflowApprovalAnnouncement => ({
  run: run(),
  workflow: workflow(),
  node: node(),
  kind: "approval",
  round: 0,
  maxRounds: 5,
  summary: "PR #42 is ready",
  ...extra,
});
const ROOM_AUTHOR = { botId: "workflow", name: "Workflow", color: "purple" };

describe("approval card wording", () => {
  it("names the workflow and the node, carries the prompt and the previous summary, and says the expiry policy", () => {
    expect(approvalCardTitle(announcement())).toBe('Workflow "Delivery" needs your decision at "gate"');
    const subtitle = approvalCardSubtitle(announcement());
    expect(subtitle).toContain("Merge the PR?");
    expect(subtitle).toContain("Previous step: PR #42 is ready");
    expect(subtitle).toContain("Run run-1");
    expect(approvalCardHeld(announcement())).toBe(
      'Waiting for a decision since 1970-01-01T00:00:00.020Z; if nobody answers, the workflow takes "rejected" when the window runs out.',
    );
    expect(approvalCardHeld(announcement({ node: node({ onExpire: "renotify" }), kind: "renotify", round: 2 }))).toBe(
      "Asked again (2 of 5) — waiting for a decision since 1970-01-01T00:00:00.020Z; if nobody answers, the workflow asks again up to 5 times and then rejects.",
    );
    expect(approvalCardHeld(announcement({ kind: "reminder" }))).toMatch(/^Reminder — waiting/);
    expect(approvalNudgeText(announcement({ kind: "renotify", round: 3 }))).toBe(
      '"Delivery" is still waiting for your decision at "gate" — asked again (3 of 5). The card above is still open.',
    );
    expect(approvalNudgeText(announcement({ kind: "reminder" }))).toMatch(/^Reminder: "Delivery" is still waiting/);
  });

  it("a blank prompt still yields a readable card", () => {
    expect(approvalCardSubtitle(announcement({ node: node({ prompt: "  " }), summary: "" }))).toMatch(/^\(the approval node has no prompt\)/);
  });
});

describe("announce", () => {
  it("posts one approval card into the previous bot's chat and marks it unread", () => {
    const f = fakeStore();
    const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    expect(reach.announce(announcement())).toEqual(["chat-reviewer"]);
    const [card] = f.cards("chat-reviewer");
    expect(card).toMatchObject({
      requestId: workflowApprovalRequestId(run()),
      tool: WORKFLOW_APPROVAL_CARD_TOOL,
      options: [...WORKFLOW_APPROVAL_CARD_OPTIONS],
      workflowApproval: { runId: "run-1", workflowId: "wf-1", nodeId: "gate" },
    });
    expect(card!.answered).toBeUndefined();
    expect(f.unread).toEqual(["bot:reviewer"]);
  });

  it("is idempotent on the request id: a second announce refreshes the note instead of adding a card", () => {
    const f = fakeStore();
    const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    reach.announce(announcement());
    expect(reach.announce(announcement({ kind: "renotify", round: 1 }))).toEqual(["chat-reviewer"]);
    expect(f.cards("chat-reviewer")).toHaveLength(1);
    expect(f.cards("chat-reviewer")[0]!.held).toMatch(/^Asked again \(1 of 5\)/);
    // A re-notification also leaves a fresh line at the bottom of the chat.
    expect(f.texts("chat-reviewer")).toEqual([
      '"Delivery" is still waiting for your decision at "gate" — asked again (1 of 5). The card above is still open.',
    ]);
    // The first post says nothing extra: the card IS the message.
    expect(f.unread).toEqual(["bot:reviewer", "bot:reviewer"]);
  });

  it("posts a room copy signed by the workflow when the node names a room, and tolerates a deleted room", () => {
    const f = fakeStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
      const gate = node({ notifyTargetGroupId: "team" });
      expect(reach.announce(announcement({ node: gate, workflow: workflow(gate) }))).toEqual(["chat-reviewer", "room-team"]);
      expect(f.threads.get("room-team")![0]!.from).toEqual(ROOM_AUTHOR);
      expect(f.cards("room-team")[0]!.requestId).toBe(f.cards("chat-reviewer")[0]!.requestId);
      expect(f.unread).toEqual(["bot:reviewer", "group:team"]);

      const missing = node({ notifyTargetGroupId: "deleted-room" });
      expect(reach.announce(announcement({ run: run({ id: "run-2" }), node: missing, workflow: workflow(missing) }))).toEqual(["chat-reviewer"]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/room "deleted-room".*no longer exists/));
    } finally {
      warn.mockRestore();
    }
  });

  it("with no bot to post to, returns no threads and warns", () => {
    const f = fakeStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => undefined, roomAuthor: ROOM_AUTHOR });
      expect(reach.announce(announcement())).toEqual([]);
      const gone = createWorkflowApprovalReach({ store: f.store, botFor: () => "gone", roomAuthor: ROOM_AUTHOR });
      expect(gone.announce(announcement())).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves an answered card alone and reports the thread as not carrying an open card", () => {
    const f = fakeStore();
    const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    reach.announce(announcement());
    reach.settle(run(), ["chat-reviewer"], "approved");
    expect(reach.announce(announcement({ kind: "reminder" }))).toEqual([]);
    expect(f.cards("chat-reviewer")).toHaveLength(1);
    expect(f.texts("chat-reviewer")).toEqual([]);
  });
});

describe("settle", () => {
  it("marks every copy with the client-rendered answered marks, once", () => {
    const f = fakeStore();
    const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    const gate = node({ notifyTargetGroupId: "team" });
    const threads = reach.announce(announcement({ node: gate, workflow: workflow(gate) }));
    reach.settle(run(), threads, "approved");
    expect(f.cards("chat-reviewer")[0]).toMatchObject({ answered: "allow", dismissed: true });
    expect(f.cards("room-team")[0]).toMatchObject({ answered: "allow", dismissed: true });
    // A second settle (a race) does not flip an answered card.
    reach.settle(run(), threads, "rejected");
    expect(f.cards("chat-reviewer")[0]!.answered).toBe("allow");

    const other = fakeStore();
    const reach2 = createWorkflowApprovalReach({ store: other.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    reach2.settle(run(), reach2.announce(announcement()), "rejected");
    expect(other.cards("chat-reviewer")[0]).toMatchObject({ answered: "deny", dismissed: true });
    reach2.announce(announcement({ run: run({ id: "run-3" }) }));
    reach2.settle(run({ id: "run-3" }), ["chat-reviewer"], "unavailable");
    expect(other.cards("chat-reviewer")[1]).toMatchObject({ answered: "unavailable", dismissed: true });
  });

  it("a thread with no card for that request is skipped without error", () => {
    const f = fakeStore();
    const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    expect(() => reach.settle(run(), ["chat-nobody", "chat-reviewer"], "approved")).not.toThrow();
  });
});

describe("resolveWorkflowApprovalCard", () => {
  function setup(current: WorkflowRun | null = run()) {
    const f = fakeStore();
    const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    const threads = reach.announce(announcement());
    const resolve = vi.fn((_runId: string, decision: "approved" | "rejected") => {
      // What the engine does on settle: marks every recorded copy and
      // records the gate's result, keyed by its opening instant.
      reach.settle(current!, threads, decision);
      return {
        ...current!,
        status: "running" as const,
        nodeResults: [
          ...current!.nodeResults,
          { nodeId: "gate", outcome: decision, summary: `${decision} by user`, startedAt: current!.approvalRequestedAt ?? 0, endedAt: 30 },
        ],
      };
    });
    const requestId = workflowApprovalRequestId(run());
    const deps = { store: f.store, resolve, run: () => current };
    return { f, resolve, requestId, deps };
  }

  it("does not claim a card that is not a gate", () => {
    const f = fakeStore();
    f.store.appendMessage("chat-x", { role: "bot", kind: "options", card: { title: "?", subtitle: "", options: [], requestId: "r1", tool: "Bash" } });
    const result = resolveWorkflowApprovalCard({ store: f.store, resolve: vi.fn(), run: () => null }, { threadId: "chat-x", requestId: "r1", behavior: "allow" });
    expect(result).toEqual({ claimed: false });
  });

  it("allow approves through the engine and marks the card; deny rejects", () => {
    const a = setup();
    const approved = resolveWorkflowApprovalCard(a.deps, { threadId: "chat-reviewer", requestId: a.requestId, behavior: "allow" });
    expect(approved).toEqual({ claimed: true, status: 200, body: { ok: true, outcome: "allowed-once", decision: "approved" } });
    expect(a.resolve).toHaveBeenCalledWith("run-1", "approved");
    expect(a.f.cards("chat-reviewer")[0]).toMatchObject({ answered: "allow", dismissed: true });

    const b = setup();
    const rejected = resolveWorkflowApprovalCard(b.deps, { threadId: "chat-reviewer", requestId: b.requestId, behavior: "deny" });
    expect(rejected).toMatchObject({ status: 200, body: { outcome: "rejected", decision: "rejected" } });
    expect(b.f.cards("chat-reviewer")[0]!.answered).toBe("deny");
  });

  it("is idempotent: a second click answers what happened and never reaches the engine again", () => {
    const a = setup();
    resolveWorkflowApprovalCard(a.deps, { threadId: "chat-reviewer", requestId: a.requestId, behavior: "allow" });
    const again = resolveWorkflowApprovalCard(a.deps, { threadId: "chat-reviewer", requestId: a.requestId, behavior: "deny" });
    expect(again).toEqual({ claimed: true, status: 200, body: { ok: true, outcome: "allowed-once", alreadyAnswered: true } });
    expect(a.resolve).toHaveBeenCalledTimes(1);
  });

  it("marks the card here even when the engine's settle did not know this thread", () => {
    const f = fakeStore();
    const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    reach.announce(announcement());
    const resolve = vi.fn(() => ({
      ...run(),
      status: "running" as const,
      nodeResults: [...run().nodeResults, { nodeId: "gate", outcome: "approved", summary: "approved by user", startedAt: 20, endedAt: 30 }],
    }));
    const requestId = workflowApprovalRequestId(run());
    resolveWorkflowApprovalCard({ store: f.store, resolve, run: () => run() }, { threadId: "chat-reviewer", requestId, behavior: "allow" });
    expect(f.cards("chat-reviewer")[0]).toMatchObject({ answered: "allow", dismissed: true });
  });

  it("closes the card and answers 409 when the run is gone, moved on, or waiting on a later opening of the gate", () => {
    const gone = setup(null);
    expect(resolveWorkflowApprovalCard(gone.deps, { threadId: "chat-reviewer", requestId: gone.requestId, behavior: "allow" })).toEqual({
      claimed: true,
      status: 409,
      body: { error: "this workflow run no longer exists" },
    });
    expect(gone.f.cards("chat-reviewer")[0]).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(gone.resolve).not.toHaveBeenCalled();

    const moved = setup(run({ status: "running", currentNodeId: "merge", approvalRequestedAt: undefined }));
    expect(resolveWorkflowApprovalCard(moved.deps, { threadId: "chat-reviewer", requestId: moved.requestId, behavior: "allow" })).toMatchObject({
      status: 409,
      body: { error: "this workflow run is no longer waiting for this decision" },
    });

    // Same node, later opening (a cycle): the older card cannot settle it.
    const later = setup(run({ approvalRequestedAt: 99 }));
    expect(resolveWorkflowApprovalCard(later.deps, { threadId: "chat-reviewer", requestId: later.requestId, behavior: "allow" })).toMatchObject({ status: 409 });
    expect(later.resolve).not.toHaveBeenCalled();
  });

  it("a race the engine refuses closes the card with the engine's reason", () => {
    const f = fakeStore();
    const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    reach.announce(announcement());
    const resolve = vi.fn(() => {
      throw new Error("run is not waiting for approval (run is running)");
    });
    const requestId = workflowApprovalRequestId(run());
    const result = resolveWorkflowApprovalCard({ store: f.store, resolve, run: () => run() }, { threadId: "chat-reviewer", requestId, behavior: "deny" });
    expect(result).toEqual({ claimed: true, status: 409, body: { error: "run is not waiting for approval (run is running)" } });
    expect(f.cards("chat-reviewer")[0]!.answered).toBe("unavailable");
  });

  it("answers 409 and closes the card when the engine returned a FAILED run instead of a decision (gate edited away)", () => {
    const f = fakeStore();
    const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    reach.announce(announcement());
    const resolve = vi.fn(() => ({
      ...run(),
      status: "failed" as const,
      error: "the workflow was deleted or edited under this run and its approval node is gone",
    }));
    const requestId = workflowApprovalRequestId(run());
    const result = resolveWorkflowApprovalCard({ store: f.store, resolve, run: () => run() }, { threadId: "chat-reviewer", requestId, behavior: "allow" });
    expect(result).toEqual({
      claimed: true,
      status: 409,
      body: { error: "the workflow was deleted or edited under this run and its approval node is gone" },
    });
    expect(f.cards("chat-reviewer")[0]).toMatchObject({ answered: "unavailable", dismissed: true });
  });

  it("a decision that landed is 200 and the card answered even when the successor failed synchronously in the same call", () => {
    const f = fakeStore();
    const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    reach.announce(announcement());
    const resolve = vi.fn(() => ({
      ...run(),
      status: "failed" as const,
      error: 'could not post to group "grp-1": channel "grp-1" no longer exists',
      nodeResults: [...run().nodeResults, { nodeId: "gate", outcome: "approved", summary: "approved by user", startedAt: 20, endedAt: 30 }],
    }));
    const requestId = workflowApprovalRequestId(run());
    const result = resolveWorkflowApprovalCard({ store: f.store, resolve, run: () => run() }, { threadId: "chat-reviewer", requestId, behavior: "allow" });
    expect(result).toEqual({ claimed: true, status: 200, body: { ok: true, outcome: "allowed-once", decision: "approved" } });
    expect(f.cards("chat-reviewer")[0]).toMatchObject({ answered: "allow", dismissed: true });
  });

  it("finds the gate's own result even when the run advanced through a notify step in the same call", () => {
    const f = fakeStore();
    const reach = createWorkflowApprovalReach({ store: f.store, botFor: () => "reviewer", roomAuthor: ROOM_AUTHOR });
    reach.announce(announcement());
    const resolve = vi.fn(() => ({
      ...run(),
      status: "completed" as const,
      nodeResults: [
        ...run().nodeResults,
        { nodeId: "gate", outcome: "approved", summary: "approved by user", startedAt: 20, endedAt: 30 },
        { nodeId: "ping", outcome: "sent", summary: "posted", startedAt: 30, endedAt: 30 },
      ],
    }));
    const requestId = workflowApprovalRequestId(run());
    expect(resolveWorkflowApprovalCard({ store: f.store, resolve, run: () => run() }, { threadId: "chat-reviewer", requestId, behavior: "allow" })).toMatchObject({
      status: 200,
      body: { decision: "approved" },
    });
  });

  it("refuses a free-text answer: a gate is allow or deny", () => {
    const a = setup();
    expect(resolveWorkflowApprovalCard(a.deps, { threadId: "chat-reviewer", requestId: a.requestId, behavior: "answer" })).toMatchObject({ status: 400 });
    expect(a.f.cards("chat-reviewer")[0]!.answered).toBeUndefined();
  });
});
