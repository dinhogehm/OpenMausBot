import { describe, expect, it } from "vitest";

import type { Workflow, WorkflowRun } from "../../shared/workflow";
import { validationSummary, withLiveIssues } from "../lib/workflow-state";
import { initialState, reducer, type AppState, type BotAnnouncement } from "./store";

const draft = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: "wf-1",
  name: "Untitled workflow",
  entryNodeId: "",
  nodes: [],
  edges: [],
  layout: {},
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "run-1",
  workflowId: "wf-1",
  status: "queued",
  attempt: 0,
  input: "",
  nodeResults: [],
  startedAt: 5_000,
  ...overrides,
});

describe("workflows view", () => {
  it("showWorkflows opens the view and closes every side panel, like the other views", () => {
    const open: AppState = {
      ...initialState,
      settingsOpen: true,
      computerOpen: true,
      inspectorOpen: true,
      appSettingsOpen: true,
      pluginsOpen: true,
    };
    const next = reducer(open, { type: "showWorkflows" });
    expect(next.activeView).toBe("workflows");
    expect(next).toMatchObject({
      settingsOpen: false,
      computerOpen: false,
      inspectorOpen: false,
      appSettingsOpen: false,
      pluginsOpen: false,
    });
  });
});

describe("workflows slice", () => {
  it("starts empty", () => {
    expect(initialState.workflows).toEqual([]);
    expect(initialState.workflowRuns).toEqual([]);
  });

  it("workflowsHydrated adopts the boot snapshot with server issues and newest-first runs", () => {
    const next = reducer(initialState, {
      type: "workflowsHydrated",
      workflows: [{ ...draft(), issues: [{ severity: "error", code: "bad-entry", message: "server said so" }] }],
      runs: [run({ id: "old", startedAt: 1 }), run({ id: "new", startedAt: 2 })],
    });
    expect(next.workflows[0]!.issues[0]!.message).toBe("server said so");
    expect(next.workflowRuns.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("a `workflow` frame upserts by id and recomputes issues when the frame carries none", () => {
    const created = reducer(initialState, { type: "workflowPatched", workflow: draft() });
    expect(created.workflows).toHaveLength(1);
    expect(created.workflows[0]!.issues.map((issue) => issue.code)).toEqual(["bad-entry"]);

    const renamed = reducer(created, { type: "workflowPatched", workflow: draft({ name: "Triage", updatedAt: 2_000 }) });
    expect(renamed.workflows).toHaveLength(1);
    expect(renamed.workflows[0]).toMatchObject({ name: "Triage", updatedAt: 2_000 });
    expect(renamed.workflows[0]!.issues.map((issue) => issue.code)).toEqual(["bad-entry"]);

    const fixed = reducer(renamed, {
      type: "workflowPatched",
      workflow: draft({
        entryNodeId: "a",
        nodes: [{ kind: "agent", id: "a", botId: "bot", instructions: "go", outcomes: ["done"] }],
        // wired to itself so the node is not a silent terminal sink: one warning remains
        edges: [{ from: "a", outcome: "done", to: "a" }],
      }),
    });
    // A self-loop on the entry with no pause: two warnings (unwired failure,
    // hot cycle), and no error — the run may still start.
    expect(fixed.workflows[0]!.issues.map((issue) => issue.severity)).toEqual(["warning", "warning"]);
  });

  it("carries a node's pre-approved keys and a step's denials through the frames untouched", () => {
    // Optional fields the reducer knows nothing about must survive the
    // upsert as-is: the panel edits `alwaysAllow`, the timeline paints
    // `denials`, and a reducer that rebuilt nodes or results would drop both.
    const granted = draft({
      entryNodeId: "a",
      nodes: [{ kind: "agent", id: "a", botId: "bot", instructions: "go", outcomes: ["done"], alwaysAllow: ["Bash:gh"] }],
    });
    const withDefinition = reducer(initialState, { type: "workflowPatched", workflow: granted });
    expect(withDefinition.workflows[0]!.nodes[0]).toMatchObject({ alwaysAllow: ["Bash:gh"] });
    // and the validator, run client-side on the frame, judges the field
    const padded = reducer(withDefinition, {
      type: "workflowPatched",
      workflow: draft({ ...granted, nodes: [{ ...granted.nodes[0]!, alwaysAllow: [" Bash:gh"] }] as typeof granted.nodes }),
    });
    expect(padded.workflows[0]!.issues.map((issue) => issue.code)).toContain("bad-always-allow");

    const denied = run({
      status: "failed",
      nodeResults: [
        {
          nodeId: "a",
          outcome: "failed",
          summary: "node timed out — denied unattended: shell (key shell:gh) — no always-allow names \"shell:gh\"",
          startedAt: 5_000,
          endedAt: 6_000,
          denials: ['denied unattended: shell (key shell:gh) — no always-allow names "shell:gh"'],
        },
      ],
    });
    const withRun = reducer(withDefinition, { type: "workflowRunPatched", run: denied });
    expect(withRun.workflowRuns[0]!.nodeResults[0]!.denials).toEqual(denied.nodeResults[0]!.denials);
  });

  it("keeps an approval gate's policy on the definition and its clocks, notices and card threads on the run", () => {
    // The timeline reads the waiting line from these fields and the node
    // panel writes the policy; a reducer that rebuilt either would lose them.
    const gated = draft({
      entryNodeId: "gate",
      nodes: [{ kind: "approval", id: "gate", prompt: "Ship?", onExpire: "renotify", maxRenotify: 3, notifyTargetGroupId: "grp-1" }],
    });
    const withDefinition = reducer(initialState, { type: "workflowPatched", workflow: gated });
    expect(withDefinition.workflows[0]!.nodes[0]).toMatchObject({ onExpire: "renotify", maxRenotify: 3, notifyTargetGroupId: "grp-1" });
    // and the validator, run client-side on the frame, judges the policy
    const badRounds = reducer(withDefinition, {
      type: "workflowPatched",
      workflow: draft({ ...gated, nodes: [{ ...gated.nodes[0]!, maxRenotify: 0 }] as typeof gated.nodes }),
    });
    expect(badRounds.workflows[0]!.issues.map((issue) => issue.code)).toContain("bad-approval-config");

    const waiting = run({
      status: "waiting-approval",
      currentNodeId: "gate",
      approvalRequestedAt: 5_000,
      approvalRemindedAt: 6_000,
      approvalRenotified: 1,
      approvalRenotifiedAt: 7_000,
      approvalNotices: [
        { at: 6_000, kind: "reminder" },
        { at: 7_000, kind: "renotify" },
      ],
      approvalThreadIds: ["thread-bot", "thread-room"],
    });
    const withRun = reducer(withDefinition, { type: "workflowRunPatched", run: waiting });
    expect(withRun.workflowRuns[0]).toMatchObject({
      approvalRequestedAt: 5_000,
      approvalRemindedAt: 6_000,
      approvalRenotified: 1,
      approvalRenotifiedAt: 7_000,
      approvalNotices: waiting.approvalNotices,
      approvalThreadIds: ["thread-bot", "thread-room"],
    });
    const settled = run({
      status: "running",
      nodeResults: [{ nodeId: "gate", outcome: "approved", summary: "approved by user", startedAt: 5_000, endedAt: 8_000, notices: waiting.approvalNotices }],
    });
    const afterDecision = reducer(withRun, { type: "workflowRunPatched", run: settled });
    expect(afterDecision.workflowRuns[0]!.nodeResults[0]!.notices).toEqual(waiting.approvalNotices);
    expect(afterDecision.workflowRuns[0]!.approvalThreadIds).toBeUndefined();
  });

  it("a `workflow-run` frame upserts by id and keeps the list newest-first", () => {
    let state = reducer(initialState, { type: "workflowRunPatched", run: run({ id: "r-1", startedAt: 1_000 }) });
    state = reducer(state, { type: "workflowRunPatched", run: run({ id: "r-2", startedAt: 3_000 }) });
    state = reducer(state, { type: "workflowRunPatched", run: run({ id: "r-3", startedAt: 2_000 }) });
    expect(state.workflowRuns.map((item) => item.id)).toEqual(["r-2", "r-3", "r-1"]);

    const settled = reducer(state, {
      type: "workflowRunPatched",
      run: run({ id: "r-3", startedAt: 2_000, status: "completed", endedAt: 2_500 }),
    });
    expect(settled.workflowRuns).toHaveLength(3);
    expect(settled.workflowRuns[1]).toMatchObject({ id: "r-3", status: "completed" });
  });

  it("`workflow.deleted` removes the definition but keeps its runs", () => {
    let state = reducer(initialState, { type: "workflowPatched", workflow: draft() });
    state = reducer(state, { type: "workflowPatched", workflow: draft({ id: "wf-2" }) });
    state = reducer(state, { type: "workflowRunPatched", run: run() });
    const next = reducer(state, { type: "workflowDeleted", workflowId: "wf-1" });
    expect(next.workflows.map((workflow) => workflow.id)).toEqual(["wf-2"]);
    expect(next.workflowRuns).toHaveLength(1);
    // an unknown id is a no-op
    expect(reducer(next, { type: "workflowDeleted", workflowId: "ghost" }).workflows).toBe(next.workflows);
  });
});

describe("standing permissions and the list", () => {
  const scout = (canMerge: boolean): BotAnnouncement => ({
    id: "bot-a",
    threadId: "thread-a",
    name: "Scout",
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
    canMerge,
  });
  const requiresMerge = draft({
    entryNodeId: "a",
    nodes: [{ kind: "agent", id: "a", botId: "bot-a", instructions: "merge it", outcomes: ["done"], requires: ["merge"] }],
  });
  const missing = (workflows: ReturnType<typeof withLiveIssues>) =>
    workflows[0]!.issues.filter((issue) => issue.code === "missing-capability").length;

  it("a `bot` frame flipping canMerge moves the derived issues of a workflow that requires merge", () => {
    const hydrated = reducer(reducer(initialState, { type: "botPatched", bot: scout(true) }), {
      type: "workflowsHydrated",
      workflows: [{ ...requiresMerge, issues: [] }],
      runs: [],
    });
    expect(missing(withLiveIssues(hydrated.workflows, hydrated.bots))).toBe(0);

    const revoked = reducer(hydrated, { type: "botPatched", bot: scout(false) });
    // the stored row did not move — only the roster did — and the list must
    // still say so, or Run stays open on a workflow the server would refuse
    expect(revoked.workflows).toBe(hydrated.workflows);
    const refused = withLiveIssues(revoked.workflows, revoked.bots);
    expect(missing(refused)).toBe(1);
    expect(validationSummary(refused[0]!.issues).errors).toBe(1);

    const granted = reducer(revoked, { type: "botPatched", bot: scout(true) });
    expect(missing(withLiveIssues(granted.workflows, granted.bots))).toBe(0);
  });
});

describe("fallback bot and the list", () => {
  const bot = (id: string, name: string): BotAnnouncement => ({
    id,
    threadId: `thread-${id}`,
    name,
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
  });
  const withFallback = draft({
    entryNodeId: "a",
    nodes: [{ kind: "agent", id: "a", botId: "bot-a", instructions: "plan", outcomes: ["done"], fallbackBotId: "bot-b" }],
  });
  const fallbackMissing = (workflows: ReturnType<typeof withLiveIssues>) =>
    workflows[0]!.issues.filter((issue) => issue.code === "fallback-missing-bot").length;

  it("a `workflow` frame keeps fallbackBotId, and the list judges it against the live roster", () => {
    const state = reducer(reducer(initialState, { type: "botPatched", bot: bot("bot-a", "Scout") }), {
      type: "workflowPatched",
      workflow: withFallback,
    });
    const node = state.workflows[0]!.nodes[0]!;
    expect(node.kind === "agent" && node.fallbackBotId).toBe("bot-b");
    // The frame carried no issues, so the slice computed structural ones:
    // a fallback naming a bot is structurally fine…
    expect(state.workflows[0]!.issues.map((issue) => issue.code)).not.toContain("fallback-missing-bot");
    // …but against a roster without bot-b the list paints the error, and Run
    // must be refused the way the server would refuse it.
    const judged = withLiveIssues(state.workflows, state.bots);
    expect(fallbackMissing(judged)).toBe(1);
    expect(validationSummary(judged[0]!.issues).errors).toBe(1);

    const joined = reducer(state, { type: "botPatched", bot: bot("bot-b", "Rook") });
    expect(joined.workflows).toBe(state.workflows); // only the roster moved
    expect(fallbackMissing(withLiveIssues(joined.workflows, joined.bots))).toBe(0);
  });

  it("a `workflow-run` frame keeps the outage and currentBotId bookkeeping the timeline reads", () => {
    const outage = { since: 1, until: 2, attempts: 3, of: 10, reason: "503", fallbackBotId: "bot-b" };
    const state = reducer(initialState, {
      type: "workflowRunPatched",
      run: run({ status: "running", outage, currentBotId: "bot-b", nextAttemptAt: 9 }),
    });
    expect(state.workflowRuns[0]).toMatchObject({ outage, currentBotId: "bot-b", nextAttemptAt: 9 });
  });
});
