// Who hears about a broken run, how often, and in what words.
import { describe, expect, it } from "vitest";

import { chiefForBot, INCIDENT_HARD_LIMIT, INCIDENT_RETRY_LIMIT, IncidentLedger, incidentChip, incidentText, routineFailureAlertDue, deskThread, OwnerWroteAt, ownerWrote, type Incident } from "./incidents.ts";

const bots = [
  { id: "clive", name: "Clive", section: "Ops", chiefOfStaff: true },
  { id: "ada", name: "Ada", section: "Ops" },
  { id: "ben", name: "Ben", section: "Research" },
  { id: "rita", name: "Rita", section: "Research", chiefOfStaff: true, hidden: true },
  { id: "maya", name: "Maya", section: "Sales", chiefOfStaff: true, managedSections: ["Research"] },
  { id: "solo", name: "Solo", section: "Alone" },
];

describe("chiefForBot", () => {
  it("picks the Chief of the bot's own section first, then a Chief allowed to coordinate it", () => {
    expect(chiefForBot(bots, bots[1]!)?.id).toBe("clive");
    // Research's own Chief is hidden; Maya may coordinate Research
    expect(chiefForBot(bots, bots[2]!)?.id).toBe("maya");
  });
  it("gives a Chief no Chief, and a section with none goes to the person", () => {
    expect(chiefForBot(bots, bots[0]!)).toBeNull();
    expect(chiefForBot(bots, bots[4]!)).toBeNull();
    expect(chiefForBot(bots, bots[5]!)).toBeNull();
  });
});

describe("IncidentLedger", () => {
  it("lets the Chief retry twice, then says so, then goes quiet on a crash loop", () => {
    let now = 1_000_000;
    const ledger = new IncidentLedger({ now: () => now });
    const seen = Array.from({ length: INCIDENT_HARD_LIMIT + 1 }, () => ledger.note("t1"));
    expect(seen.map((entry) => entry.count)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen.map((entry) => entry.mayRetry)).toEqual([true, true, false, false, false, false]);
    expect(seen.map((entry) => entry.muted)).toEqual([false, false, false, false, false, true]);
    expect(INCIDENT_RETRY_LIMIT).toBe(2);
    // another thread is its own count; an hour later the first is fresh again
    expect(ledger.note("t2")).toEqual({ count: 1, mayRetry: true, muted: false });
    now += 61 * 60_000;
    expect(ledger.note("t1")).toEqual({ count: 1, mayRetry: true, muted: false });
    ledger.forget("t2");
    expect(ledger.note("t2").count).toBe(1);
  });
});

describe("incident wording", () => {
  const incident: Incident = {
    kind: "failed",
    bot: { id: "ada", name: "Ada", section: "Ops" },
    threadId: "t-ada",
    title: "Invoice reconciliation",
    detail: "exit_before_result",
    lastRequest: "Reconcile the September invoices.\n\nThanks",
    lastReply: "```\nlots of code\n```\nStarting the reconciliation now",
  };

  it("names the bot, the thread and what happened, marks the quoted text as data, and tells the Chief what to do", () => {
    const text = incidentText(incident, { count: 1, mayRetry: true, muted: false });
    expect(text.startsWith("[Incident report from OpenMausBot — not from the person.")).toBe(true);
    expect(text).toContain("Ada's run in its thread #Invoice reconciliation failed: \"exit_before_result\".");
    expect(text).toContain('The request there was: "Reconcile the September invoices. Thanks"');
    expect(text).toContain('Ada last said: "Starting the reconciliation now"');
    expect(text).toContain('retry_thread with bot_id "ada" and thread_id "t-ada"');
    expect(text).not.toContain("incident on that thread");
    expect(incidentChip(incident)).toBe('Incident: Ada\'s run in its thread #Invoice reconciliation failed: "exit_before_result"');
  });

  it("counts repeats and, once retries are used up, asks for the person instead of another retry", () => {
    const second = incidentText(incident, { count: 2, mayRetry: true, muted: false });
    expect(second).toContain("This is the second incident on that thread within the hour.");
    expect(second).toContain("retry_thread");
    const third = incidentText(incident, { count: 3, mayRetry: false, muted: false });
    expect(third).toContain("Retries for that thread are used up.");
    expect(third).not.toContain("call retry_thread");
  });

  it("words a stall, a start failure, a routine and a room each in their own terms", () => {
    expect(incidentChip({ ...incident, kind: "stalled", detail: "" })).toBe("Incident: Ada's run in its thread #Invoice reconciliation stopped after showing no activity");
    expect(incidentChip({ ...incident, kind: "could-not-start", title: null })).toContain("Ada's run in its main conversation could not start");
    expect(incidentChip({ ...incident, kind: "routine-failed", title: "Inbox digest" })).toContain("Ada's scheduled routine in its thread #Inbox digest failed");
    expect(incidentChip({ ...incident, room: "Standup" })).toContain('Ada\'s run in the room "Standup" failed');
  });
});

describe("routineFailureAlertDue", () => {
  it("raises a routine's failures at two in a row, then every fifth", () => {
    expect([1, 2, 3, 4, 5, 6, 10, 11].map(routineFailureAlertDue)).toEqual([false, true, false, false, true, false, true, false]);
  });
});

describe("deskThread", () => {
  const task = (threadId: string, createdAt: number, extra: object = {}) => ({ threadId, createdAt, title: threadId, ...extra });
  it("prefers the pinned conversation, else the oldest open one without an active goal", () => {
    const tasks = [task("goal", 1), task("main", 2), task("new", 3), task("old", 0, { archivedAt: 5 })];
    expect(deskThread(tasks, "selected", (id) => id === "goal")).toBe("main");
    expect(deskThread([...tasks, task("pin", 9, { pinned: true })], "selected", () => false)).toBe("pin");
    expect(deskThread([], "selected", () => false)).toBe("selected");
  });

  it("puts the automatic alerts in the conversation the owner named, while it is open (R8-followup F2)", () => {
    const tasks = [task("ade82a65", 1), task("dbb9f1cf", 2), task("pin", 3, { pinned: true }), task("closed", 4, { archivedAt: 5 })];
    expect(deskThread(tasks, "selected", () => false, "dbb9f1cf")).toBe("dbb9f1cf");
    expect(deskThread(tasks, "selected", () => false, "closed")).toBe("pin");
    expect(deskThread(tasks, "selected", () => false, null)).toBe("pin");
    // the named one wins even while it runs a goal: the owner chose it (INSP-F F2-c)
    expect(deskThread(tasks, "selected", (id) => id === "dbb9f1cf", "dbb9f1cf")).toBe("dbb9f1cf");
  });

  it("never lets where the owner wrote last pass over the conversation they named (R9-followup #1)", () => {
    // 01/10: the order of 09:49 named dbb9f1cf; at 19:53 the owner reported a bug in dd9c5ece
    const tasks = [task("ade82a65", 1), task("dbb9f1cf", 2), task("dd9c5ece", 3)];
    const wrote = (id: string) => ({ dbb9f1cf: 1_000, dd9c5ece: 9_000 } as Record<string, number>)[id] ?? null;
    expect(deskThread(tasks, "selected", () => false, "dbb9f1cf", wrote)).toBe("dbb9f1cf");
    // ...and pinned elsewhere does not either
    expect(deskThread([...tasks, task("pin", 4, { pinned: true })], "selected", () => false, "dbb9f1cf", wrote)).toBe("dbb9f1cf");
    // with no conversation named, the last one written in is the fallback
    expect(deskThread(tasks, "selected", () => false, null, wrote)).toBe("dd9c5ece");
  });

  /** The shape of the Chief's real state on 01/10 (redacted titles): 14 open
   * conversations, none pinned, ownerThread null in shared-state.json, the
   * oldest (ade82a65) a "New thread" nobody writes in, the owner's last
   * message in dbb9f1cf (also bot.threadId), older ones elsewhere, and the
   * rest only peers' delegations and bot posts. createdAt and the owner's
   * last-message times are the real ones. */
  const CHIEF_TASKS = [
    ["bdba1ace", "New thread", 1790877733388],
    ["52417e4a", "@Monitor · parallel work", 1790875675236],
    ["57eeeb2d", "@QA", 1790867685658],
    ["3e55c0fd", "@Monitor · parallel work", 1790863874924],
    ["dd9c5ece", "Prioridade da esteira", 1790726227093],
    ["a8416843", "@Eng", 1790706948117],
    ["6477b3f4", "PRs sem dono", 1790703521574],
    ["e7e94e89", "@Lead", 1790694164742],
    ["cc5c122f", "Teste do fluxo completo", 1790686305968],
    ["f4d06b8a", "@Monitor · parallel work", 1790647260730],
    ["dbb9f1cf", "@Monitor", 1790644603310],
    ["590384ea", "Continuação de outro bot", 1790639581483],
    ["936f8e51", "Team incidents", 1790637419160],
    ["ade82a65", "New thread", 1790636853409],
  ].map(([threadId, title, createdAt]) => ({ threadId: threadId as string, title: title as string, createdAt: createdAt as number }));
  const OWNER_WROTE: Record<string, number> = {
    dbb9f1cf: 1790879604293,
    "6477b3f4": 1790869726485,
    dd9c5ece: 1790728775199,
    cc5c122f: 1790686349497,
    f4d06b8a: 1790686088516,
    "590384ea": 1790644993032,
  };

  it("with no named conversation and no pin, alerts go where the owner wrote last, not to the oldest (INSP-F F2-a, state of 01/10)", () => {
    const chiefThreadId = "dbb9f1cf";
    // what the old rule gave: the oldest open one, ade82a65 (the 10:10 disk alert landed there)
    expect(deskThread(CHIEF_TASKS, chiefThreadId, () => false, null)).toBe("ade82a65");
    expect(deskThread(CHIEF_TASKS, chiefThreadId, () => false, null, (id) => OWNER_WROTE[id] ?? null)).toBe("dbb9f1cf");
    // closed: the next one the owner wrote in
    const closed = CHIEF_TASKS.map((task) => (task.threadId === "dbb9f1cf" ? { ...task, archivedAt: 1 } : task));
    expect(deskThread(closed, chiefThreadId, () => false, null, (id) => OWNER_WROTE[id] ?? null)).toBe("6477b3f4");
  });

  it("knows where the owner wrote last from the messages, ignoring a peer's delegation and bot posts", () => {
    const threads: Record<string, Array<{ at: number; role: string; kind: string; from?: unknown; peerAsk?: unknown }>> = {
      dbb9f1cf: [
        { at: 1790876346668, role: "user", kind: "text" },
        { at: 1790877695393, role: "user", kind: "text", peerAsk: { botId: "monitor", name: "Monitor" } },
        { at: 1790879604293, role: "user", kind: "text" },
        { at: 1790881029980, role: "bot", kind: "text" },
      ],
      ade82a65: [
        { at: 1790877165827, role: "bot", kind: "text" },
        { at: 1790877166006, role: "user", kind: "text", from: { botId: "monitor" } },
      ],
      "57eeeb2d": [{ at: 1790880758062, role: "user", kind: "text", peerAsk: { botId: "qa", name: "QA" } }],
    };
    let reads = 0;
    const wrote = new OwnerWroteAt((threadId) => { reads += 1; return threads[threadId] ?? []; });
    expect(wrote.at("dbb9f1cf")).toBe(1790879604293);
    expect(wrote.at("ade82a65")).toBeNull();
    expect(wrote.at("57eeeb2d")).toBeNull();
    const tasks = [task("ade82a65", 1), task("dbb9f1cf", 2), task("57eeeb2d", 3)];
    expect(deskThread(tasks, "x", () => false, null, (id) => wrote.at(id))).toBe("dbb9f1cf");
    // kept current without reading again
    wrote.note("ade82a65", { at: 1790890000000, role: "user", kind: "text" });
    wrote.note("ade82a65", { at: 1790890000001, role: "user", kind: "text", peerAsk: { botId: "qa" } });
    expect(wrote.at("ade82a65")).toBe(1790890000000);
    expect(deskThread(tasks, "x", () => false, null, (id) => wrote.at(id))).toBe("ade82a65");
    expect(reads).toBe(3);
    expect(ownerWrote({ role: "user", kind: "text", aside: true })).toBe(false);
  });
});
