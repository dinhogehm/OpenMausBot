import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bot, Group, GroupTask, Task } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { attentionJumpAction, attentionOwnerName, BotActivityRow, crossBotAttentionThreads, sidebarBotActivityTasks, sidebarGroupActivityTasks, threadsWhenTreeHidden } from "./SidebarBotActivity";

const task = (threadId: string, title: string, extra: Partial<Task>): Task =>
  ({ threadId, title, createdAt: 0, ...extra }) as Task;
const bot = (id: string, name: string, threadId: string, tasks?: Task[], extra: Partial<Bot> = {}): Bot =>
  ({ id, name, threadId, tasks, ...extra }) as unknown as Bot;
const group = (id: string, name: string, threadId: string, extra: Partial<Group> = {}): Group =>
  ({ id, name, threadId, memberIds: [], bulletin: "", unread: false, createdAt: 0, messages: [], ...extra }) as unknown as Group;

describe("cross-bot attention", () => {
  it("collects only attention threads from every other bot, waiting first across bots", () => {
    const alpha = bot("a", "Alpha", "a0", [
      task("a0", "Idle chat", {}),
      task("a1", "Waiting approval", { activity: "waiting-on-you" }),
      task("a2", "Unread reply", { unread: true }),
    ]);
    const beta = bot("b", "Beta", "b0", [
      task("b0", "Building site", { busy: true, activity: "working" }),
      task("b1", "Wrapped long ago", {}),
    ]);
    const entries = crossBotAttentionThreads([alpha, beta], { b2: [{}] }, "current");
    expect(entries.map((entry) => entry.task.threadId)).toEqual(["a1", "b0", "a2"]);
    expect(entries.map((entry) => attentionOwnerName(entry))).toEqual(["Alpha", "Beta", "Alpha"]);
  });

  it("excludes the bot the picker belongs to and keeps queued threads", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Waiting approval", { activity: "waiting-on-you" })]);
    const beta = bot("b", "Beta", "b0", [task("b0", "Queued job", {})]);
    const entries = crossBotAttentionThreads([alpha, beta], { b0: [{}] }, "a");
    expect(entries.map((entry) => entry.task.threadId)).toEqual(["b0"]);
    expect(entries[0].task.queued).toBe(true);
  });

  it("falls back to the bot's own line when it has no task list yet", () => {
    const solo = bot("s", "Solo", "s0", undefined, { unread: true });
    expect(crossBotAttentionThreads([solo], {}).map((entry) => entry.task.threadId)).toEqual(["s0"]);
  });
  it("never offers a hidden bot or a routine run", () => {
    const hidden = bot("h", "Hidden", "h0", [task("h0", "Waiting", { activity: "waiting-on-you" })], { hidden: true });
    const runner = bot("r", "Runner", "r0", [task("r0", "Routine step", { routineRunId: "run-1", busy: true })]);
    const plain = bot("p", "Plain", "p0", [task("p0", "Unread note", { unread: true })]);
    expect(crossBotAttentionThreads([hidden, runner, plain], {}).map((entry) => entry.task.threadId)).toEqual(["p0"]);
  });

  it("orders waiting ahead of unread across bots, not just inside one", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Unread reply", { unread: true })]);
    const beta = bot("b", "Beta", "b0", [task("b0", "Waiting approval", { activity: "waiting-on-you" })]);
    expect(crossBotAttentionThreads([alpha, beta], {}).map((entry) => entry.task.threadId)).toEqual(["b0", "a0"]);
  });
});

describe("goal waiting on the person", () => {
  it("keeps a thread whose goal stopped to ask the person in the attention list", () => {
    const chief = bot("c", "Chief", "c0", [task("c0", "Idle", {}), task("c1", "PR #9300 GO", { goalNeedsInput: true })]);
    expect(sidebarBotActivityTasks(chief, {}).map((entry) => entry.threadId)).toEqual(["c1"]);
  });
});

describe("group attention", () => {
  it("surfaces a working or waiting room on its primary thread", () => {
    const busyBot = bot("b", "Beta", "b0", [], { activity: "waiting-on-you" });
    const room = group("g", "Crew", "g0", { working: true, busyBotId: "b" });
    const tasks = sidebarGroupActivityTasks(room, [busyBot], {});
    expect(tasks.map((task) => task.threadId)).toEqual(["g0"]);
    expect(tasks[0].activity).toBe("waiting-on-you");
  });

  it("ignores an idle room and never surfaces a bot-to-bot DM channel", () => {
    const idle = group("g", "Crew", "g0");
    const dm = group("d", "Bot DM", "d0", { working: true, dm: true });
    expect(sidebarGroupActivityTasks(idle, [], {})).toEqual([]);
    expect(sidebarGroupActivityTasks(dm, [], {})).toEqual([]);
  });

  it("attributes busy/unread only to the room's own primary task, not its other conversations", () => {
    const extra: GroupTask = { threadId: "g1", title: "Side thread", createdAt: 0 };
    const room = group("g", "Crew", "g0", { working: true, unread: true, tasks: [{ threadId: "g0", title: "Crew", createdAt: 0 }, extra] });
    const tasks = sidebarGroupActivityTasks(room, [], {});
    expect(tasks.map((task) => task.threadId)).toEqual(["g0"]);
    expect(tasks[0].busy).toBe(true);
    expect(tasks[0].unread).toBe(true);
  });

  it("keeps a queued side conversation even while the room itself is idle", () => {
    const room = group("g", "Crew", "g0", { tasks: [{ threadId: "g0", title: "Crew", createdAt: 0 }, { threadId: "g1", title: "Side thread", createdAt: 0 }] });
    const tasks = sidebarGroupActivityTasks(room, [], { g1: [{}] });
    expect(tasks.map((task) => task.threadId)).toEqual(["g1"]);
    expect(tasks[0].queued).toBe(true);
  });

  it("merges bot and room entries into one ordered attention list", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Unread reply", { unread: true })]);
    const room = group("g", "Crew", "g0", { working: true, busyBotId: "b", tasks: [{ threadId: "g0", title: "Crew", createdAt: 0 }] });
    const busyBot = bot("b", "Beta", "b0", [], { activity: "waiting-on-you" });
    const entries = crossBotAttentionThreads([alpha, busyBot], {}, undefined, [room]);
    expect(entries.map((entry) => `${entry.kind}:${entry.task.threadId}`)).toEqual(["group:g0", "bot:a0"]);
    expect(entries.map((entry) => attentionOwnerName(entry))).toEqual(["Crew", "Alpha"]);
  });

  it("jumps a room's primary thread by selecting the room, and a side conversation via switchGroupTask", () => {
    const room = group("g", "Crew", "g0", { working: true, tasks: [{ threadId: "g0", title: "Crew", createdAt: 0 }] });
    const [primary] = crossBotAttentionThreads([], {}, undefined, [room]);
    expect(attentionJumpAction(primary)).toEqual({ type: "select", id: "g" });

    const sideRoom = group("g", "Crew", "g0", { tasks: [{ threadId: "g0", title: "Crew", createdAt: 0 }, { threadId: "g1", title: "Side thread", createdAt: 0 }] });
    const [side] = crossBotAttentionThreads([], { g1: [{}] }, undefined, [sideRoom]);
    expect(attentionJumpAction(side)).toEqual({ type: "switchGroupTask", groupId: "g", threadId: "g1" });
  });

  it("jumps a bot entry with switchTask", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Unread reply", { unread: true })]);
    const [entry] = crossBotAttentionThreads([alpha], {});
    expect(attentionJumpAction(entry)).toEqual({ type: "switchTask", botId: "a", threadId: "a0" });
  });
});

describe("a folded bot's activity rows", () => {
  const row = (extra: Partial<Task>) => renderToStaticMarkup(createElement(BotActivityRow, {
    bot: { name: "Chief" }, task: { ...task("c1", "#9311 corrigir login do cliente com um título longo", extra), queued: false }, iconOnly: false, onJump: () => {},
  }));

  it("never lets the status swallow the title: the status truncates at 55%, the title keeps the rest", () => {
    setLocale("pt-br");
    try {
      const markup = row({ goalNeedsInput: true, goalNeedsInputSince: Date.now() - 3 * 3_600_000 });
      const status = markup.match(/<span data-activity-status[^>]*>/)?.[0] ?? "";
      expect(status).toContain("max-w-[55%]");
      expect(status).toContain("truncate");
      expect(status).toContain("min-w-0");
      expect(status).not.toContain("shrink-0");
      expect(markup.match(/<span data-activity-title[^>]*>/)?.[0]).toContain("flex-1");
      expect(markup).toContain("#9311 corrigir login");
      expect(markup).toContain("Precisa de você");
    } finally { setLocale("en"); }
  });

  it("shows the watch eye and the Claude Code triangle, as the thread row does", () => {
    const markup = row({
      unread: true,
      watches: [{ label: "chat", standing: true, everyMinutes: 3, lastRunAt: Date.now(), failures: 3 }],
      ccAlerts: [{ sessionId: "a", title: "#9308", state: "question" }],
    });
    expect(markup).toContain("data-thread-watches");
    expect(markup.match(/<svg[^>]*data-thread-watches[^>]*>/)?.[0]).toContain("text-danger");
    expect(markup).toContain("data-thread-cc-alert");
    expect(markup).toContain("#9308");
  });

  it("keeps a conversation whose automation needs a look reachable while folded", () => {
    const chief = bot("c", "Chief", "c0", [
      task("c0", "Main", {}),
      task("c1", "Vigias", { watchesLost: true }),
      task("c2", "Sessão", { ccAlerts: [{ sessionId: "s", title: "#1", state: "failed" }] }),
      task("c3", "Quiet", { watches: [{ label: "chat", standing: true, everyMinutes: 3, lastRunAt: 0, failures: 0 }] }),
    ]);
    expect(threadsWhenTreeHidden(chief, {}).map((entry) => entry.threadId).sort()).toEqual(["c1", "c2"]);
    // the bell stays on attention only
    expect(sidebarBotActivityTasks(chief, {})).toEqual([]);
  });
});
