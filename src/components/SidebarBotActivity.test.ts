import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BellDot, CircleAlert, Clock3, Loader2 } from "lucide-react";
import { describe, expect, it } from "vitest";
import type { Bot, Group, GroupTask, Task } from "@/state/store";
import { setLocale, t } from "@/lib/i18n";
import {
  attentionJumpAction, attentionOwnerName, attentionRowStatus, attentionUnpinAction, BotActivityRow, crossBotAttentionThreads,
  crossBotPinnedThreads, sidebarBotActivityTasks, sidebarGroupActivityTasks, threadsWhenTreeHidden,
} from "./SidebarBotActivity";
import { botShowsUnread } from "@/lib/bot-unread";

const task = (threadId: string, title: string, extra: Partial<Task>): Task =>
  ({ threadId, title, createdAt: 0, ...extra }) as Task;
const bot = (id: string, name: string, threadId: string, tasks?: Task[], extra: Partial<Bot> = {}): Bot =>
  ({ id, name, threadId, tasks, ...extra }) as unknown as Bot;
const group = (id: string, name: string, threadId: string, extra: Partial<Group> = {}): Group =>
  ({ id, name, threadId, memberIds: [], bulletin: "", unread: false, createdAt: 0, messages: [], ...extra }) as unknown as Group;

describe("botShowsUnread", () => {
  it("keeps the bot flag when there is no task list", () => {
    expect(botShowsUnread(bot("s", "Solo", "s0", undefined, { unread: true }))).toBe(true);
    expect(botShowsUnread(bot("s", "Solo", "s0", undefined))).toBe(false);
    expect(botShowsUnread(bot("s", "Solo", "s0", [], { unread: true }))).toBe(true);
  });

  it("ignores a hidden routine execution and counts a visible unread thread", () => {
    const hiddenOnly = bot("r", "Runner", "r0", [
      task("r0", "Read chat", {}),
      task("r1", "Failed run", { routineRunId: "run-1", unread: true }),
    ], { unread: true });
    expect(botShowsUnread(hiddenOnly)).toBe(false);
    const visible = bot("p", "Plain", "p0", [
      task("p0", "Unread chat", { unread: true }),
      task("p1", "Failed run", { routineRunId: "run-1", unread: true }),
    ]);
    expect(botShowsUnread(visible)).toBe(true);
  });
});

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

  // INSP-S r1 S-6: the button's aria-label replaces its children's, and the
  // icons-only density used to drop the hourglass and the resume mark
  const sessionsLine = (now: number): Partial<Task> => ({
    ccSessions: [
      { sessionId: "a", title: "9353 Comprar assentos", status: "running", surface: "app", screenWait: { kind: "create", since: now - 12 * 60_000, waitingFor: "inUse" } },
      { sessionId: "b", title: "9052 Tempo de reabertura", status: "failed", surface: "cli", resume: { since: now - 3 * 3_600_000, prs: [9332], why: "falhou: o turno passou de 45 minutos e foi parado", kind: "failed", detail: "the turn ran past 45 minutes and was stopped" } },
      { sessionId: "c", title: "9195 Filtros", status: "idle", surface: "cli", resume: { since: now - 4 * 3_600_000, prs: [9280], why: "parada: o último turno terminou e nada a retomou", kind: "idle" } },
    ],
  });

  it("says the sessions, the steps pending in the app and the ones to resume in the row's accessible name", () => {
    setLocale("pt-br");
    try {
      const markup = row(sessionsLine(Date.now()));
      const label = /<button[^>]*aria-label="([^"]*)"/.exec(markup)?.[1] ?? "";
      expect(label).toContain("Sessões do Claude Code desta conversa · 9353 Comprar assentos");
      expect(label).toContain("1 passo no app Claude pendente · Esperando o Mac: alguém está usando (precisa de 5 s sem mexer) · 9353 Comprar assentos — abrir no app, desde");
      expect(label).toContain("2 sessões para retomar: seguram PRs abertas · 9052 Tempo de reabertura — falhou: o turno passou de 45 minutos e foi parado · PR #9332");
      expect(label).not.toContain("\n");
      // the visible marks: the hourglass, and the resume mark with its count
      expect(markup).toContain('data-thread-cc-waiting="1"');
      expect(/<span data-thread-cc-resume="2"[^>]*>.*?<\/span><\/span>/.exec(markup)?.[0]).toMatch(/tabular-nums">2<\/span>/);
    } finally { setLocale("en"); }
  });

  it("shows the hourglass and the resume mark in the icons-only density too", () => {
    const markup = renderToStaticMarkup(createElement(BotActivityRow, {
      bot: { name: "Chief" }, task: { ...task("c1", "#9311", sessionsLine(Date.now())), queued: false }, iconOnly: true, onJump: () => {},
    }));
    expect(markup).toContain("data-thread-cc-waiting");
    expect(markup).toContain("data-thread-cc-resume");
    expect(markup).not.toContain("data-activity-title");
    // the icons sidebar is 80 px: the marks wrap to a second line instead of spilling out
    expect(/<button[^>]*class="([^"]*)"/.exec(markup)?.[1]).toContain("flex-wrap");
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

describe("cross-bot pinned threads", () => {
  it("collects only pinned threads from every bot, newest pin first", () => {
    const alpha = bot("a", "Alpha", "a0", [
      task("a0", "Idle chat", {}),
      task("a1", "Old pin", { pinned: true, updatedAt: 1 }),
    ]);
    const beta = bot("b", "Beta", "b0", [
      task("b0", "Unpinned", {}),
      task("b1", "New pin", { pinned: true, updatedAt: 2 }),
    ]);
    const entries = crossBotPinnedThreads([alpha, beta], [], {});
    expect(entries.map((entry) => entry.task.threadId)).toEqual(["b1", "a1"]);
    expect(entries.map((entry) => attentionOwnerName(entry))).toEqual(["Beta", "Alpha"]);
  });

  it("ignores a pinned routine run and a hidden bot", () => {
    const visible = bot("v", "Visible", "v0", [task("v0", "Pinned run", { pinned: true, routineRunId: "run-1" })]);
    const hidden = bot("h", "Hidden", "h0", [task("h0", "Pinned elsewhere", { pinned: true })], { hidden: true });
    expect(crossBotPinnedThreads([visible, hidden], [], {})).toEqual([]);
  });

  it("includes a pinned room thread alongside pinned bot threads", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Pinned chat", { pinned: true, updatedAt: 1 })]);
    const room = group("g", "Crew", "g0", { tasks: [{ threadId: "g0", title: "Crew", createdAt: 0, pinned: true, updatedAt: 2 }] });
    const entries = crossBotPinnedThreads([alpha], [room], {});
    expect(entries.map((entry) => `${entry.kind}:${entry.task.threadId}`)).toEqual(["group:g0", "bot:a0"]);
    expect(attentionJumpAction(entries[0])).toEqual({ type: "select", id: "g" });
  });

  it("marks a pinned thread queued the same way attention does", () => {
    const alpha = bot("a", "Alpha", "a0", [task("a0", "Pinned chat", { pinned: true })]);
    const [entry] = crossBotPinnedThreads([alpha], [], { a0: [{}] });
    expect(entry.task.queued).toBe(true);
  });

  it("keeps pinned task status independent of the bot's aggregate activity", () => {
    const alpha = bot("a", "Alpha", "a0", [
      task("a0", "Idle pin", { pinned: true, busy: false, activity: "idle" }),
      task("a1", "Working pin", { pinned: true, busy: true, activity: "working" }),
    ], { busy: true, activity: "waiting-on-you" });
    const entries = crossBotPinnedThreads([alpha], [], {});
    expect(attentionRowStatus(entries[0].task).active).toBe(false);
    expect(attentionRowStatus(entries[1].task).label).toBe(t("chat.activity.working"));
  });

  it("derives a pinned room's live status without attributing it to an idle sibling", () => {
    const alpha = bot("a", "Alpha", "a0", [], { activity: "waiting-on-you" });
    const room = group("g", "Crew", "g0", { busyBotId: "a", unread: true, tasks: [
      { threadId: "g0", title: "Crew", createdAt: 0, pinned: true },
      { threadId: "g1", title: "Idle sibling", createdAt: 0, pinned: true },
    ] });
    const status = (patch: Partial<Group>) => crossBotPinnedThreads([alpha], [{ ...room, ...patch }], {})
      .map((entry) => attentionRowStatus(entry.task));
    expect(status({})[0].label).toBe(t("task.waiting"));
    expect(status({ busyBotId: null, working: true })[0].label).toBe(t("chat.activity.working"));
    expect(status({ busyBotId: null })[0].label).toBe(t("task.unread"));
    expect(status({})[1].active).toBe(false);
  });
});

describe("attentionRowStatus", () => {
  it("flags a waiting-on-you task active with the CircleAlert icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false, activity: "waiting-on-you" });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("task.waiting"));
    expect(status.Icon).toBe(CircleAlert);
  });

  it("flags a working task active with the spinning Loader2 icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false, busy: true, activity: "working" });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("chat.activity.working"));
    expect(status.Icon).toBe(Loader2);
  });

  it("flags a queued task active with the Clock3 icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: true });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("task.queued"));
    expect(status.Icon).toBe(Clock3);
  });

  it("flags an unread task active with the BellDot icon", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false, unread: true });
    expect(status.active).toBe(true);
    expect(status.label).toBe(t("task.unread"));
    expect(status.Icon).toBe(BellDot);
  });

  it("marks a plain idle task inactive", () => {
    const status = attentionRowStatus({ threadId: "t", title: "T", createdAt: 0, queued: false });
    expect(status.active).toBe(false);
  });
});

describe("attentionUnpinAction", () => {
  it("unpins a bot thread via updateTask", () => {
    const [entry] = crossBotPinnedThreads([bot("a", "Alpha", "a0", [task("a0", "Pinned chat", { pinned: true })])], [], {});
    expect(attentionUnpinAction(entry)).toEqual({ type: "updateTask", botId: "a", threadId: "a0", patch: { pinned: false } });
  });

  it("unpins a room thread via pinGroupTask", () => {
    const room = group("g", "Crew", "g0", { tasks: [{ threadId: "g0", title: "Crew", createdAt: 0, pinned: true }] });
    const [entry] = crossBotPinnedThreads([], [room], {});
    expect(attentionUnpinAction(entry)).toEqual({ type: "pinGroupTask", groupId: "g", threadId: "g0", pinned: false, title: "Crew" });
  });
});
