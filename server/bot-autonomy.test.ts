import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { botMarkPattern, selfWriteOf } from "./watch-echo.ts";
import { isMentionOnly, stripLeadingMentions } from "../shared/owner-pending-title.ts";
import {
  BotAutonomy,
  ECHO_SEEN_PERSIST_MAX,
  SEEN_CHAT_MAX,
  GOAL_DEFAULT_MAX_TURNS,
  GOAL_MIN_TURN_GAP_MS,
  goalContinuationPrompt,
  goalEndChip,
  parseGoalEndInput,
  parseGoalInput,
  parsePromiseInput,
  prsCited,
  lastQuestionAt,
  ownerAskAt,
  ownerAsk,
  ownerAskText,
  ownerPendingReplyText,
  ownerPendingAwaitNote,
  ownerPendingRemindReport,
  ownerPendingVisible,
  OWNER_PENDING_AWAIT_MS,
  REMIND_REPORT_PREFIX,
  ownerPendingStepsRequestText,
  ownerPendingStepsRequestNote,
  parseOwnerPendingDetails,
  parseWakeInput,
  promiseOverdueReport,
  parseWatchInput,
  chipText,
  parseStandingLabel,
  reportsPrompt,
  sameOwnerPending,
  commitsIn,
  ownerPendingAction,
  wakeChip,
  wakeFiredChip,
  watchLabel,
  wakePrompt,
  questionStepsAutoReport,
  questionReportRef,
  QUESTION_REPORT_PREFIX,
  sameAskText,
  itemTakesOverAsk,
} from "./bot-autonomy.ts";

let dir: string;
let now: number;
const clock = () => now;
const make = () => new BotAutonomy({ path: join(dir, "bot-autonomy.json"), now: clock });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-autonomy-"));
  now = Date.parse("2026-09-29T12:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("input parsing", () => {
  it("accepts a wake within bounds and refuses the rest", () => {
    expect(parseWakeInput({ minutes: 2, reason: " check PR #9280 " })).toEqual({ ok: true, minutes: 2, reason: "check PR #9280" });
    expect(parseWakeInput({ minutes: 0, reason: "x" }).ok).toBe(false);
    expect(parseWakeInput({ minutes: 1.5, reason: "x" }).ok).toBe(false);
    expect(parseWakeInput({ minutes: 1_441, reason: "x" }).ok).toBe(false);
    expect(parseWakeInput({ minutes: 5, reason: "  " }).ok).toBe(false);
  });

  it("defaults goal limits and validates overrides", () => {
    expect(parseGoalInput({ goal: "ship #9195" })).toEqual({ ok: true, goal: "ship #9195", maxTurns: GOAL_DEFAULT_MAX_TURNS, maxHours: 12 });
    expect(parseGoalInput({ goal: "x", maxTurns: 201 }).ok).toBe(false);
    expect(parseGoalInput({ goal: "x", maxHours: 73 }).ok).toBe(false);
    expect(parseGoalInput({ goal: "" }).ok).toBe(false);
  });

  it("takes needs_input with an underscore and requires detail", () => {
    expect(parseGoalEndInput({ status: "needs_input", detail: "which env?" })).toEqual({ ok: true, status: "needs-input", detail: "which env?" });
    expect(parseGoalEndInput({ status: "done", detail: "x" }).ok).toBe(false);
    expect(parseGoalEndInput({ status: "completed" }).ok).toBe(false);
  });
});

describe("wakes", () => {
  it("keeps one wake per conversation and fires it when due", () => {
    const autonomy = make();
    autonomy.setWake("bot", "t1", 5, "first");
    autonomy.setWake("bot", "t1", 2, "second");
    expect(autonomy.dueWakes()).toEqual([]);
    now += 2 * 60_000;
    expect(autonomy.dueWakes().map((wake) => wake.reason)).toEqual(["second"]);
  });

  it("survives a restart", () => {
    make().setWake("bot", "t1", 3, "check deploy");
    const reloaded = make();
    expect(reloaded.wakeFor("t1")?.reason).toBe("check deploy");
    expect(JSON.parse(readFileSync(join(dir, "bot-autonomy.json"), "utf8")).wakes).toHaveLength(1);
  });

  it("restores a taken wake without replacing a newer one", () => {
    const autonomy = make();
    const wake = autonomy.setWake("bot", "t1", 1, "old");
    autonomy.cancelWake("t1");
    autonomy.restoreWake(wake);
    expect(autonomy.wakeFor("t1")).toBe(wake);
    autonomy.cancelWake("t1");
    autonomy.setWake("bot", "t1", 9, "new");
    autonomy.restoreWake(wake);
    expect(autonomy.wakeFor("t1")?.reason).toBe("new");
  });
});

describe("goals", () => {
  it("paces continuations and stops at the turn limit", () => {
    const autonomy = make();
    const goal = autonomy.startGoal("bot", "t1", { goal: "ship", maxTurns: 2, maxHours: 1 });
    expect(autonomy.goalReadyForTurn(goal)).toBe(true);
    autonomy.noteGoalDispatch("t1");
    expect(autonomy.goalReadyForTurn(goal)).toBe(false);
    now += GOAL_MIN_TURN_GAP_MS;
    expect(autonomy.goalReadyForTurn(goal)).toBe(true);
    autonomy.noteGoalDispatch("t1");
    expect(autonomy.goalLimitReached(goal)).toMatch(/2 turns/);
  });

  it("stops at the time limit", () => {
    const autonomy = make();
    const goal = autonomy.startGoal("bot", "t1", { goal: "ship", maxTurns: 50, maxHours: 1 });
    now += 3_600_000;
    expect(autonomy.goalLimitReached(goal)).toMatch(/time limit/);
  });

  it("undoes a dispatch that never ran", () => {
    const autonomy = make();
    const goal = autonomy.startGoal("bot", "t1", { goal: "ship", maxTurns: 5, maxHours: 1 });
    autonomy.noteGoalDispatch("t1");
    autonomy.undoGoalDispatch("t1");
    expect(goal.turnCount).toBe(0);
    expect(autonomy.goalReadyForTurn(goal)).toBe(true);
  });

  it("counts a failure streak and resets it on success", () => {
    const autonomy = make();
    autonomy.startGoal("bot", "t1", { goal: "ship", maxTurns: 5, maxHours: 1 });
    expect(autonomy.noteGoalTurnOutcome("t1", false)).toBe(1);
    expect(autonomy.noteGoalTurnOutcome("t1", false)).toBe(2);
    expect(autonomy.noteGoalTurnOutcome("t1", true)).toBe(0);
  });

  it("finishes once, and needs-input resumes on the person's answer", () => {
    const autonomy = make();
    autonomy.startGoal("bot", "t1", { goal: "ship", maxTurns: 5, maxHours: 1 });
    const ended = autonomy.finishGoal("t1", "needs-input", "which env?");
    expect(ended?.status).toBe("needs-input");
    expect(autonomy.finishGoal("t1", "stopped", "again")).toBeNull();
    expect(autonomy.activeGoals()).toEqual([]);
    expect(autonomy.resumeGoalAfterInput("t1")?.status).toBe("active");
    autonomy.finishGoal("t1", "completed", "shipped");
    expect(autonomy.resumeGoalAfterInput("t1")).toBeNull();
  });

  it("forgets a deleted conversation's wake and goal together", () => {
    const autonomy = make();
    autonomy.setWake("bot", "t1", 1, "x");
    autonomy.startGoal("bot", "t1", { goal: "ship", maxTurns: 5, maxHours: 1 });
    autonomy.forgetThread("t1");
    expect(autonomy.wakeFor("t1")).toBeNull();
    expect(autonomy.goalFor("t1")).toBeNull();
    expect(make().goalFor("t1")).toBeNull();
  });
});

describe("prompts", () => {
  it("tells a continuation its goal, count and escape hatches", () => {
    const autonomy = make();
    autonomy.startGoal("bot", "t1", { goal: "merge and deploy #9280", maxTurns: 10, maxHours: 2 });
    const goal = autonomy.noteGoalDispatch("t1")!;
    const prompt = goalContinuationPrompt(goal, now);
    expect(prompt).toContain("turn 1 of 10");
    expect(prompt).toContain("merge and deploy #9280");
    expect(prompt).toContain("wake_me");
    expect(prompt).toContain("goal_end");
  });

  it("hands the note back on waking", () => {
    const autonomy = make();
    const wake = autonomy.setWake("bot", "t1", 2, "is PR #9280 merged?");
    now += 2 * 60_000;
    const prompt = wakePrompt(wake, null, now);
    expect(prompt).toContain("2 min ago");
    expect(prompt).toContain("is PR #9280 merged?");
  });

  it("labels how a goal ended", () => {
    const autonomy = make();
    autonomy.startGoal("bot", "t1", { goal: "ship", maxTurns: 5, maxHours: 1 });
    autonomy.noteGoalDispatch("t1");
    expect(goalEndChip(autonomy.finishGoal("t1", "completed", "deployed")!)).toBe("Objetivo concluído após 1 turno — deployed");
  });
});

describe("watches", () => {
  const watchInput = { command: "gh pr view 1", argv: ["gh", "pr", "view", "1"], everyMinutes: 2, maxMinutes: 60, reason: "check PR 1", baseline: "OPEN" };

  it("runs on its cadence and fires on a change, not before", () => {
    const autonomy = make();
    const wake = autonomy.setWatch("bot", "t1", watchInput);
    expect(autonomy.watchesToRun()).toEqual([]);
    now += 2 * 60_000;
    expect(autonomy.watchesToRun()).toEqual([wake]);
    expect(autonomy.recordWatchRun(wake, { ok: true, output: "OPEN", matched: false })).toBeNull();
    expect(autonomy.dueWakes()).toEqual([]);
    now += 2 * 60_000;
    expect(autonomy.recordWatchRun(wake, { ok: true, output: "MERGED", matched: false })).toBe("changed");
    expect(autonomy.dueWakes()).toEqual([wake]);
    expect(autonomy.watchesToRun()).toEqual([]);
    const prompt = wakePrompt(wake, null, now);
    expect(prompt).toContain("its output changed");
    expect(prompt).toContain("MERGED");
  });

  it("with until, ignores other changes and fires on a match", () => {
    const autonomy = make();
    const wake = autonomy.setWatch("bot", "t1", { ...watchInput, until: "MERGED" });
    expect(autonomy.recordWatchRun(wake, { ok: true, output: "CLOSED", matched: false })).toBeNull();
    expect(autonomy.recordWatchRun(wake, { ok: true, output: "MERGED", matched: true })).toBe("matched");
  });

  it("wakes the bot after three failed runs in a row", () => {
    const autonomy = make();
    const wake = autonomy.setWatch("bot", "t1", watchInput);
    autonomy.recordWatchRun(wake, { ok: false, output: "boom", matched: false });
    autonomy.recordWatchRun(wake, { ok: true, output: "OPEN", matched: false });
    autonomy.recordWatchRun(wake, { ok: false, output: "boom", matched: false });
    autonomy.recordWatchRun(wake, { ok: false, output: "boom", matched: false });
    expect(autonomy.recordWatchRun(wake, { ok: false, output: "boom", matched: false })).toBe("failing");
  });

  it("still wakes at max_minutes and survives a restart", () => {
    make().setWatch("bot", "t1", watchInput);
    const reloaded = make();
    expect(reloaded.wakeFor("t1")?.watch?.baseline).toBe("OPEN");
    now += 60 * 60_000;
    expect(reloaded.dueWakes()).toHaveLength(1);
    expect(reloaded.watchesToRun()).toEqual([]);
    expect(wakePrompt(reloaded.wakeFor("t1")!, null, now)).toContain("time limit ran out");
  });

  it("validates cadence and limits", () => {
    expect(parseWatchInput({ reason: "x" })).toEqual({ ok: true, everyMinutes: 2, maxMinutes: 120, reason: "x" });
    expect(parseWatchInput({ reason: "x", everyMinutes: 0 }).ok).toBe(false);
    expect(parseWatchInput({ reason: "x", everyMinutes: 30, maxMinutes: 10 }).ok).toBe(false);
    expect(parseWatchInput({ everyMinutes: 2 }).ok).toBe(false);
  });
});

describe("watch fingerprints", () => {
  it("fires on a change past the kept excerpt", () => {
    const autonomy = make();
    const wake = autonomy.setWatch("bot", "t1", { command: "curl https://x", argv: ["curl", "https://x"], everyMinutes: 2, maxMinutes: 60, reason: "sheet", baseline: "same start", baselineFingerprint: "aaa" });
    expect(autonomy.recordWatchRun(wake, { ok: true, output: "same start", fingerprint: "aaa", matched: false })).toBeNull();
    expect(autonomy.recordWatchRun(wake, { ok: true, output: "same start", fingerprint: "bbb", matched: false })).toBe("changed");
  });
});

describe("standing watches", () => {
  const chat = { command: "gog chat messages list spaces/X --plain", argv: ["gog", "chat", "messages", "list", "spaces/X", "--plain"], everyMinutes: 3, maxMinutes: 720, reason: "answer new chat messages", baseline: "m1", baselineFingerprint: "f1", standing: true };

  it("is not replaced by wake_me, and fires again after re-arming on the new output", () => {
    const autonomy = make();
    const watch = autonomy.setWatch("bot", "t1", chat);
    autonomy.setWake("bot", "t1", 5, "check the PR");
    expect(autonomy.standingFor("t1")).toBe(watch);
    expect(autonomy.wakeFor("t1")?.reason).toBe("check the PR");
    now += 3 * 60_000;
    expect(autonomy.recordWatchRun(watch, { ok: true, output: "m1 m2", fingerprint: "f2", matched: false })).toBe("changed");
    expect(autonomy.dueWakes()).toEqual([watch]);
    // the turn started (or could not): re-arm on what it fired on
    autonomy.rearmStanding(watch);
    expect(watch.watch).toMatchObject({ baseline: "m1 m2", baselineFingerprint: "f2", fired: 1 });
    expect(watch.watch!.trigger).toBeUndefined();
    expect(watch.dueAt).toBe(now + 720 * 60_000);
    expect(autonomy.dueWakes()).toEqual([]);
    now += 3 * 60_000;
    expect(autonomy.watchesToRun()).toEqual([watch]);
    expect(autonomy.recordWatchRun(watch, { ok: true, output: "m1 m2", fingerprint: "f2", matched: false })).toBeNull();
    now += 3 * 60_000;
    expect(autonomy.recordWatchRun(watch, { ok: true, output: "m1 m2 m3", fingerprint: "f3", matched: false })).toBe("changed");
    expect(wakePrompt(watch, null, now)).toContain("stays armed");
    expect(wakeChip(watch)).toBe("Vigia permanente em Chat a cada 3 min — answer new chat messages");
  });

  it("with until, fires on each new matching output, not on every run while it matches", () => {
    const autonomy = make();
    const watch = autonomy.setWatch("bot", "t1", { ...chat, until: "Beltrano" });
    expect(autonomy.recordWatchRun(watch, { ok: true, output: "Beltrano: oi", fingerprint: "f2", matched: true })).toBe("matched");
    autonomy.rearmStanding(watch);
    expect(autonomy.recordWatchRun(watch, { ok: true, output: "Beltrano: oi", fingerprint: "f2", matched: true })).toBeNull();
    expect(autonomy.recordWatchRun(watch, { ok: true, output: "Beltrano: oi\nBeltrano: e aí?", fingerprint: "f3", matched: true })).toBe("matched");
  });

  it("re-arms after failing too, remembering it failed", () => {
    const autonomy = make();
    const watch = autonomy.setWatch("bot", "t1", chat);
    for (let i = 0; i < 3; i++) autonomy.recordWatchRun(watch, { ok: false, output: "auth expired", fingerprint: "x", matched: false });
    expect(watch.watch!.trigger).toBe("failing");
    autonomy.rearmStanding(watch);
    expect(watch.watch).toMatchObject({ failures: 0, lastTrigger: "failing", baseline: "m1" });
    expect(autonomy.isCurrent(watch)).toBe(true);
  });

  it("survives a restart beside the ordinary wake, and forgetting the thread drops both", () => {
    const autonomy = make();
    autonomy.setWatch("bot", "t1", chat);
    autonomy.setWake("bot", "t1", 5, "timer");
    const reloaded = make();
    expect(reloaded.standingFor("t1")?.watch?.standing).toBe(true);
    expect(reloaded.wakeFor("t1")?.reason).toBe("timer");
    expect(reloaded.cancelWake("t1")?.reason).toBe("timer");
    expect(reloaded.standingFor("t1")).not.toBeNull();
    reloaded.forgetThread("t1");
    expect(make().standingFor("t1")).toBeNull();
  });

  it("parses standing and refuses anything but a boolean", () => {
    expect(parseWatchInput({ reason: "x", standing: true })).toMatchObject({ ok: true, standing: true });
    expect(parseWatchInput({ reason: "x", standing: false })).not.toHaveProperty("standing");
    expect(parseWatchInput({ reason: "x", standing: "yes" }).ok).toBe(false);
  });
});

describe("migrating watches set before stdout-only fingerprints", () => {
  it("keeps an existing watch and does not fire on the change of method", () => {
    const path = join(dir, "bot-autonomy.json");
    writeFileSync(path, JSON.stringify({
      wakes: [{ botId: "bot", threadId: "t1", dueAt: now + 60 * 60_000, reason: "chat", createdAt: now, watch: { command: "gog chat messages list", argv: ["gog"], everyMs: 120_000, baseline: "m1", baselineFingerprint: "stdout+stderr", lastRunAt: now, runs: 3, failures: 0 } }],
      goals: [],
    }));
    const autonomy = make();
    const wake = autonomy.wakeFor("t1")!;
    expect(wake.watch?.baseline).toBe("m1");
    expect(autonomy.recordWatchRun(wake, { ok: true, output: "m1", fingerprint: "stdout-only", matched: false })).toBeNull();
    expect(autonomy.recordWatchRun(wake, { ok: true, output: "m2", fingerprint: "stdout-2", matched: false })).toBe("changed");
  });
});

describe("leases across a restart", () => {
  it("gives a wake back, due and marked, when the server died before its turn finished", () => {
    const autonomy = make();
    const wake = autonomy.setWake("bot", "t1", 1, "checar o deploy");
    now += 60_000;
    autonomy.leaseWake(wake);
    expect(autonomy.wakeFor("t1")).toBeNull();
    const reloaded = make(); // restart mid-turn
    const back = reloaded.wakeFor("t1")!;
    expect(back.reason).toContain("interrompida por um restart");
    expect(back.reason).toContain("checar o deploy");
    expect(reloaded.dueWakes()).toEqual([back]);
    // and the lease is not given back twice
    expect(make().wakeFor("t1")?.reason).toBe(back.reason);
  });

  it("forgets a lease once the turn completes, and gives leased reports back after a restart", () => {
    const autonomy = make();
    const wake = autonomy.setWake("bot", "t1", 1, "x");
    autonomy.leaseWake(wake);
    autonomy.settleInFlight("t1");
    expect(make().wakeFor("t1")).toBeNull();
    autonomy.addReport("chief", "t2", "PR #9300 pronta");
    expect(autonomy.leaseReports("t2")?.items).toEqual(["PR #9300 pronta"]);
    expect(autonomy.hasReports("t2")).toBe(false);
    const reloaded = make();
    const back = reloaded.takeReports("t2")!;
    expect(back.items[0]).toContain("interrompida por um restart");
    expect(back.items).toContain("PR #9300 pronta");
  });

  it("drops a lease when the turn could not start and puts it back when it lost a race", () => {
    const autonomy = make();
    const wake = autonomy.setWake("bot", "t1", 1, "x");
    autonomy.leaseWake(wake);
    autonomy.restoreWake(wake);
    expect(autonomy.inFlightFor("t1")).toEqual([]);
    expect(autonomy.wakeFor("t1")).toBe(wake);
    autonomy.addReport("chief", "t2", "r");
    const taken = autonomy.leaseReports("t2")!;
    autonomy.restoreReports(taken);
    expect(autonomy.inFlightFor("t2")).toEqual([]);
    expect(make().takeReports("t2")?.items).toEqual(["r"]);
  });

  it("gives a wake or reports back with a growing wait when their turn failed after dispatch", () => {
    const autonomy = make();
    const wake = autonomy.setWake("bot", "t1", 1, "checar o chat");
    now += 60_000;
    autonomy.leaseWake(wake);
    expect(autonomy.returnFailedDispatch("t1", "This desktop image cannot safely resume")).toEqual([{ kind: "wake", failures: 1, delayMs: 60_000 }]);
    expect(autonomy.inFlightFor("t1")).toEqual([]);
    const back = autonomy.wakeFor("t1")!;
    expect(back.reason).toBe("[O turno anterior não começou (This desktop image cannot safely resume); tentando de novo.] checar o chat");
    expect(back.dueAt).toBe(now + 60_000);
    // failing again: twice the wait, one note (not stacked), capped at 10 min
    autonomy.leaseWake(back);
    expect(autonomy.returnFailedDispatch("t1", "Start docker first")[0]!.delayMs).toBe(120_000);
    expect(autonomy.wakeFor("t1")!.reason).toBe("[O turno anterior não começou (Start docker first); tentando de novo.] checar o chat");
    for (let i = 0; i < 6; i++) {
      autonomy.leaseWake(autonomy.wakeFor("t1")!);
      autonomy.returnFailedDispatch("t1", "x");
    }
    expect(autonomy.wakeFor("t1")!.dueAt - now).toBe(10 * 60_000);
    autonomy.addReport("chief", "t2", "relatório");
    autonomy.leaseReports("t2");
    expect(autonomy.returnFailedDispatch("t2", "engine down")).toEqual([{ kind: "reports", failures: 1, delayMs: 60_000 }]);
    expect(autonomy.reportThreads()).toEqual([]);
    now += 60_000;
    expect(autonomy.reportThreads().map((pending) => pending.items)).toEqual([["relatório"]]);
    expect(autonomy.returnFailedDispatch("t3", "x")).toEqual([]);
  });

  it("does not re-run a lease older than 6 h after a restart: it asks the bot, and lists what it found", () => {
    const autonomy = make();
    autonomy.leaseWake(autonomy.setWake("bot", "t1", 1, "responder ao cliente ACME"));
    autonomy.leaseWake(autonomy.setWake("bot", "t2", 1, "checar o deploy"));
    now += 7 * 3_600_000;
    autonomy.leaseWake(autonomy.setWake("bot", "t2", 1, "checar o deploy de novo"));
    const reloaded = make();
    expect(reloaded.wakeFor("t1")).toBeNull();
    const asked = reloaded.takeReports("t1")!;
    expect(asked.items[0]).toContain("NÃO foi repetido automaticamente");
    expect(asked.items[1]).toContain("responder ao cliente ACME");
    expect(reloaded.wakeFor("t2")?.reason).toContain("checar o deploy de novo");
    expect(reloaded.recoveredOnLoad.map((lease) => [lease.threadId, lease.stale])).toEqual([["t1", true], ["t2", true], ["t2", false]]);
  });

  it("never leases a standing watch: it survives a restart as it was", () => {
    const autonomy = make();
    const watch = autonomy.setWatch("bot", "t1", { command: "gog chat messages list", argv: ["gog"], everyMinutes: 3, maxMinutes: 60, reason: "chat", baseline: "m1", standing: true });
    autonomy.leaseWake(watch);
    expect(make().standingFor("t1")?.watch?.baseline).toBe("m1");
  });
});

describe("keeping the Mac awake", () => {
  it("holds for a wake within the horizon, a goal, reports or a turn in flight", () => {
    const autonomy = make();
    expect(autonomy.wakeHold(60 * 60_000)).toEqual({ hold: false });
    autonomy.setWake("bot", "t1", 120, "later");
    expect(autonomy.wakeHold(60 * 60_000)).toEqual({ hold: false });
    autonomy.setWake("bot", "t2", 30, "soon");
    expect(autonomy.wakeHold(60 * 60_000)).toEqual({ hold: true, reason: "due", at: now + 30 * 60_000 });
    autonomy.addReport("bot", "t3", "r");
    expect(autonomy.wakeHold(60 * 60_000)).toMatchObject({ hold: true, reason: "running" });
  });

  it("holds for a watch's next run, not only its time limit", () => {
    const autonomy = make();
    autonomy.setWatch("bot", "t1", { command: "gh pr view 1", argv: ["gh"], everyMinutes: 3, maxMinutes: 720, reason: "x", baseline: "OPEN", standing: true });
    expect(autonomy.wakeHold(60 * 60_000)).toEqual({ hold: true, reason: "due", at: now + 3 * 60_000 });
  });
});

describe("watches that see nothing new, cut outputs and duplicates", () => {
  const base = { argv: ["gog"], everyMinutes: 3, maxMinutes: 120, reason: "x", standing: true };

  it("flags a standing watch whose unchanged output only shows items over a day old, once until it changes", () => {
    const autonomy = make();
    const old = "2026-03-16T19:19:20Z Tício Boa!\n2026-03-31T10:00:00Z Sicrana ok";
    const wake = autonomy.setWatch("bot", "t1", { ...base, command: "gog chat messages list spaces/X --plain", label: "chat", baseline: old, baselineFingerprint: "f1" });
    now += 2 * 3_600_000;
    autonomy.recordWatchRun(wake, { ok: true, output: old, matched: false, fingerprint: "f1" });
    expect(autonomy.staleWatches()).toEqual([]);
    now += 2 * 3_600_000;
    expect(autonomy.staleWatches()).toEqual([wake]);
    autonomy.markWatchStaleAlerted(wake);
    expect(autonomy.staleWatches()).toEqual([]);
    const fresh = autonomy.setWatch("bot", "t2", { ...base, command: "gog x", label: "chat", baseline: `${new Date(now).toISOString()} Beltrano`, baselineFingerprint: "f2" });
    now += 4 * 3_600_000;
    expect(autonomy.staleWatches()).not.toContain(fresh);
  });

  it("tells the bot which lines are new when the output is cut", () => {
    const autonomy = make();
    const rows = Array.from({ length: 5 }, (_, i) => `linha ${i}`);
    const wake = autonomy.setWatch("bot", "t1", { ...base, command: "curl https://docs.google.com/x", label: "planilha", baseline: "linha 0", baselineFingerprint: "a" });
    autonomy.recordWatchRun(wake, { ok: true, output: "linha 0", matched: false, fingerprint: "a", truncated: true, lines: rows });
    now += 60_000;
    autonomy.recordWatchRun(wake, { ok: true, output: "linha 0", matched: false, fingerprint: "b", truncated: true, lines: [...rows, "linha 5 — Beltrano, nova"] });
    expect(wake.watch!.trigger).toBe("changed");
    const prompt = wakePrompt(wake, null, now);
    expect(prompt).toContain("Lines new or changed since the run before (1):\nlinha 5 — Beltrano, nova");
  });

  it("takes the bot's own comment as the new baseline instead of waking it", () => {
    const autonomy = make();
    // a watch on the comments of #9307, as its --jq prints them: "#N login id: <end of the body>"
    const old = "#9307 fulana 4400: O login ainda falha";
    const mine = "#9307 bot-user 4401: Publicado em produção, pode testar";
    const wake = autonomy.setWatch("bot", "t1", { ...base, command: "gh api repos/o/r/issues/9307/comments", argv: ["gh", "api", "repos/o/r/issues/9307/comments"], standing: true, label: "issues", baseline: old, baselineFingerprint: "a" });
    autonomy.recordWatchRun(wake, { ok: true, output: old, matched: false, fingerprint: "a", lines: [old] });
    autonomy.noteSelfWrite("bot", selfWriteOf('gh issue comment 9307 --body "Publicado em produção, pode testar"', now)!);
    now += 60_000;
    expect(autonomy.recordWatchRun(wake, { ok: true, output: `${old}\n${mine}`, matched: false, fingerprint: "b", lines: [old, mine] })).toBeNull();
    expect(wake.watch!.echoAt).toBe(now);
    // a person on the same issue two minutes later: it wakes the bot
    const human = "#9307 fulana 4402: Testei e continua com erro";
    now += 2 * 60_000;
    expect(autonomy.recordWatchRun(wake, { ok: true, output: `${old}\n${mine}\n${human}`, matched: false, fingerprint: "c", lines: [old, mine, human] })).toBe("changed");
  });

  it("judges an echo against the whole run before, not the 20 000 characters kept to show (INSP-E A1, real gog --plain output)", () => {
    // the real spreadsheet watch: ~108 000 characters, line 422 (row 178) far past the cut
    const sheet = readFileSync(new URL("./testing/fixtures/gog-sheets-plain.txt", import.meta.url), "utf8").trim().split("\n");
    const row = sheet.findLastIndex((line) => line.startsWith("  Oqvnflfa  Neewdoa    Pendente"));
    const ownMark = botMarkPattern("Monitor Chat Atendimento", "monitor-chat-atendimento");
    const run = (lines: string[], fingerprint: string) => ({ ok: true, output: lines.join("\n").slice(0, 20_000), truncated: true, matched: false, fingerprint, lines, linesComplete: true, ownMark });
    const autonomy = make();
    const wake = autonomy.setWatch("monitor", "thread-planilha", { ...base, command: "gog sheets get SHEET_ID Atendimento!A1:H400 --plain", argv: ["gog", "sheets", "get", "SHEET_ID", "Atendimento!A1:H400", "--plain"], label: "planilha", baseline: "x", baselineFingerprint: "a" });
    autonomy.recordWatchRun(wake, run(sheet, "a"));
    // the bot's note, pasted through the VM, after its mark: an echo, said with why
    now += 60_000;
    const note = " | [Monitor Chat Atendimento] 01/10 16:10 BRT: sessão aberta";
    expect(autonomy.noteVmClipboard("monitor", note, ownMark)).toBe(true);
    const noted = sheet.map((line, i) => (i === row ? `${line}${note}` : line));
    expect(autonomy.recordWatchRun(wake, run(noted, "b"))).toBeNull();
    expect(wake.watch!.echo).toMatchObject({ at: now, lines: 1, reasons: ["nota que o bot escreveu, acrescentada igual"], sample: expect.stringContaining("Oqvnflfa") });
    // the client's "Reprovado" in that same row: it wakes the bot
    now += 60_000;
    const reproved = noted.map((line, i) => (i === row ? line.replace("Pendente    Atendimento", "Pendente    Reprovado  Atendimento") : line));
    expect(autonomy.recordWatchRun(wake, run(reproved, "c"))).toBe("changed");
  });

  it("a restart keeps the run before, but a line nobody wrote still wakes", () => {
    const lines = ["[Monitor Chat Atendimento] nota", "  Fulana  Dono    Pendente    Algo"];
    const ownMark = botMarkPattern("Monitor Chat Atendimento");
    const first = make();
    const wake = first.setWatch("monitor", "t1", { ...base, command: "gog sheets get x --plain", argv: ["gog", "sheets", "get", "x", "--plain"], label: "planilha", baseline: "x", baselineFingerprint: "a" });
    first.recordWatchRun(wake, { ok: true, output: lines.join("\n"), matched: false, fingerprint: "a", lines, ownMark });
    // the server restarts: the same watch, its lines back for that output; a note the bot did not write is no echo
    const restarted = make();
    const again = restarted.standingFor("t1", "planilha")!;
    const more = [...lines, "[Monitor Chat Atendimento] outra nota"];
    expect(restarted.recordWatchRun(again, { ok: true, output: more.join("\n"), matched: false, fingerprint: "b", lines: more, ownMark })).toBe("changed");
  });

  // R10-intake: the restart of 02/10 13:38 emptied the echo memory, so the
  // bot's first post after it (the notice to a client in the Chat) would
  // wake its own watch once. The memory now survives a restart, bounded.
  it("remembers across a restart the bot's own post, the run before and the messages seen — bounded, and only for the same output", () => {
    const chat = readFileSync(new URL("./testing/fixtures/gog-chat-plain.txt", import.meta.url), "utf8").trim().split("\n");
    const message = (id: string, text: string) => `spaces/GSMW4KYdbE4/messages/${id}.${id}\tNeewdoa Ocex\t2026-10-02T16:59:17.000000Z\t${text}`;
    const ownMark = botMarkPattern("Monitor Chat Atendimento", "monitor-chat-atendimento");
    const argv = ["gog", "chat", "messages", "list", "spaces/AAAAexample", "--max", "10", "--order", "createTime desc", "--plain"];
    const first = make();
    const wake = first.setWatch("monitor", "thread-chat", { ...base, command: argv.join(" "), argv, standing: true, label: "chat", baseline: "x", baselineFingerprint: "a" });
    first.recordWatchRun(wake, { ok: true, output: chat.join("\n"), matched: false, fingerprint: "f0", lines: chat, ownMark });
    first.rearmStanding(wake);
    // the notice the bot pastes through the VM, then the server restarts before the watch runs again
    const body = "a causa foi encontrada e a correção está em andamento, ainda não publicada";
    expect(first.noteVmClipboard("monitor", body)).toBe(true);
    expect(first.seenChatCount("monitor")).toBeGreaterThan(0);
    const restarted = make();
    expect(restarted.seenChatCount("monitor")).toBe(first.seenChatCount("monitor"));
    const again = restarted.standingFor("thread-chat", "chat")!;
    now += 60_000;
    const shown = [chat[0]!, message("nWv9", `@Fulana de Tal ${body}`), ...chat.slice(1, -1)];
    expect(restarted.recordWatchRun(again, { ok: true, output: shown.join("\n"), matched: false, fingerprint: "f1", lines: shown, ownMark })).toBeNull();
    expect(again.watch!.echo?.reasons).toEqual([`post do bot ("${body.slice(0, 40)}")`]);

    // past the echo window the post is forgotten; and lines of another output never come back
    const file = join(dir, "bot-autonomy.echo.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(saved.lastLineHashes)).toHaveLength(1);
    // INSP-J r1 #12: no client text on disk — the Chat's lines and message starts are hashes
    const onDisk = readFileSync(file, "utf8");
    for (const line of chat.slice(1)) {
      const text = (line.split("\t")[3] ?? "").slice(0, 20);
      if (text.length >= 8) expect(onDisk).not.toContain(text);
    }
    expect(Object.keys(saved)).toEqual(["selfWrites", "seenChatHashes", "lastLineHashes"]);
    now += 16 * 60_000;
    const later = make();
    expect(JSON.parse(readFileSync(file, "utf8")).selfWrites.monitor).toHaveLength(1); // on disk until the next save
    const watchLater = later.standingFor("thread-chat", "chat")!;
    const human = [chat[0]!, message("nWva", body), ...shown.slice(1, -1)];
    now += 60_000;
    expect(later.recordWatchRun(watchLater, { ok: true, output: human.join("\n"), matched: false, fingerprint: "f2", lines: human, ownMark })).toBe("changed");
    expect(JSON.parse(readFileSync(file, "utf8")).selfWrites).toEqual({});
    // the watch ran elsewhere meanwhile (its fingerprint moved): its saved lines are not taken back
    const ledger = JSON.parse(readFileSync(join(dir, "bot-autonomy.json"), "utf8"));
    for (const each of ledger.wakes) if (each.watch) each.watch.lastFingerprint = "other";
    writeFileSync(join(dir, "bot-autonomy.json"), JSON.stringify(ledger));
    const moved = make();
    moved.noteSelfWrite("monitor", { at: now, kind: "chat", marks: ["x"], via: "shell" });
    expect(JSON.parse(readFileSync(file, "utf8")).lastLineHashes).toEqual({});
  });

  // INSP-J r1 #12: the real spreadsheet watch (~108 000 characters) never fit
  // the 40 000 kept as text, so the watch that echoes most had no memory
  it("keeps a spreadsheet run past 40 000 characters as hashes, and the bot's own note after a restart is an echo", () => {
    const sheet = readFileSync(new URL("./testing/fixtures/gog-sheets-plain.txt", import.meta.url), "utf8").trim().split("\n");
    expect(sheet.join("\n").length).toBeGreaterThan(40_000);
    const row = sheet.findLastIndex((line) => line.startsWith("  Oqvnflfa  Neewdoa    Pendente"));
    const ownMark = botMarkPattern("Monitor Chat Atendimento", "monitor-chat-atendimento");
    const run = (lines: string[], fingerprint: string) => ({ ok: true, output: lines.join("\n").slice(0, 20_000), truncated: true, matched: false, fingerprint, lines, linesComplete: true, ownMark });
    const first = make();
    const wake = first.setWatch("monitor", "thread-planilha", { ...base, command: "gog sheets get SHEET_ID Atendimento!A1:H400 --plain", argv: ["gog", "sheets", "get", "SHEET_ID", "Atendimento!A1:H400", "--plain"], standing: true, label: "planilha", baseline: "x", baselineFingerprint: "a" });
    first.recordWatchRun(wake, run(sheet, "a"));
    first.rearmStanding(wake);
    const note = " | [Monitor Chat Atendimento] 02/10 16:10 BRT: sessão aberta";
    expect(first.noteVmClipboard("monitor", note, ownMark)).toBe(true);
    const onDisk = readFileSync(join(dir, "bot-autonomy.echo.json"), "utf8");
    expect(onDisk).not.toContain("Oqvnflfa");
    // the server restarts; the note shows in the row: an echo, nobody woken
    const restarted = make();
    const again = restarted.standingFor("thread-planilha", "planilha")!;
    now += 60_000;
    const noted = sheet.map((line, i) => (i === row ? `${line}${note}` : line));
    expect(restarted.recordWatchRun(again, run(noted, "b"))).toBeNull();
    expect(again.watch!.echo?.reasons).toEqual(["nota que o bot escreveu, acrescentada igual"]);
  });

  it("keeps the echo memory bounded on disk", () => {
    const autonomy = make();
    const argv = ["gog", "chat", "messages", "list", "spaces/AAAAexample", "--max", "10", "--plain"];
    const wake = autonomy.setWatch("monitor", "thread-chat", { ...base, command: argv.join(" "), argv, standing: true, label: "chat", baseline: "x", baselineFingerprint: "a" });
    const row = (n: number) => `spaces/AAAAexample/messages/m${n}.m${n}\tKarntf Fhqxr\t2026-10-01T10:00:00.000000Z\tmensagem número ${n} de um cliente com texto`;
    // 1 500 distinct messages seen, a few runs
    for (let run = 0; run < 3; run += 1) {
      const lines = ["RESOURCE\tSENDER\tTIME\tTEXT", ...Array.from({ length: 500 }, (_, i) => row(run * 500 + i))];
      now += 60_000;
      autonomy.recordWatchRun(wake, { ok: true, output: lines.join("\n").slice(0, 20_000), matched: false, fingerprint: `g${run}`, lines });
      autonomy.rearmStanding(wake);
    }
    for (let i = 0; i < 30; i += 1) autonomy.noteSelfWrite("monitor", { at: now, kind: "chat", marks: [`post ${i}`], via: "shell" });
    const saved = JSON.parse(readFileSync(join(dir, "bot-autonomy.echo.json"), "utf8"));
    expect(saved.seenChatHashes.monitor.length).toBe(ECHO_SEEN_PERSIST_MAX);
    expect(saved.selfWrites.monitor).toHaveLength(20);
    // the run, as 501 hashes of 10 hex characters: no message text
    expect(Object.values(saved.lastLineHashes as Record<string, { hashes: string[] }>)[0]!.hashes).toHaveLength(501);
    expect(JSON.stringify(saved)).not.toContain("mensagem número");
  });

  it("follows the real VM sequence of a Chat post: the pasted body is the bot's, a mention or a URL is not, a copied client message is not (INSP-E r3 4)", () => {
    // the real Chat watch output (TSV, newest first), redacted
    const chat = readFileSync(new URL("./testing/fixtures/gog-chat-plain.txt", import.meta.url), "utf8").trim().split("\n");
    const message = (id: string, sender: string, text: string) => `spaces/GSMW4KYdbE4/messages/${id}.${id}\t${sender}\t2026-10-01T13:34:00.000000Z\t${text}`;
    const ownMark = botMarkPattern("Monitor Chat Atendimento", "monitor-chat-atendimento");
    const autonomy = make();
    const wake = autonomy.setWatch("monitor", "thread-chat", { ...base, command: "gog chat messages list spaces/AAAAexample --max 10 --order \"createTime desc\" --plain", argv: ["gog", "chat", "messages", "list", "spaces/AAAAexample", "--max", "10", "--order", "createTime desc", "--plain"], label: "chat", baseline: "x", baselineFingerprint: "a" });
    let shown = chat;
    let fingerprint = 0;
    const run = (...news: string[]) => {
      shown = [shown[0]!, ...news, ...shown.slice(1, -news.length)];
      now += 60_000;
      return autonomy.recordWatchRun(wake, { ok: true, output: shown.join("\n"), matched: false, fingerprint: `f${fingerprint++}`, lines: shown, ownMark });
    };
    autonomy.recordWatchRun(wake, { ok: true, output: chat.join("\n"), matched: false, fingerprint: "a", lines: chat, ownMark });
    // the recorded calls: clipboard_write URL → hotkey → type_text "@Fulana de Tal" → clipboard_write body → press_key
    expect(autonomy.noteVmClipboard("monitor", "https://mail.google.com/chat/u/0/#chat/space/AAAAexample\n")).toBe(false);
    const body = "saiu hoje à tarde a correção do atendimento reaberto, pode testar e me avise";
    expect(autonomy.noteVmClipboard("monitor", body)).toBe(true);
    // (a) the message as the Chat shows it, the mention expanded: the bot's
    expect(run(message("nWv1", "Neewdoa Ocex", `@Fulana de Tal da Silva ${body}`))).toBeNull();
    expect(wake.watch!.echo?.reasons).toEqual([`post do bot ("${body.slice(0, 40)}")`]);
    // (b) someone else calling the same person: it wakes
    expect(run(message("nWv2", "Karntf Fhqxr", "@Fulana de Tal da Silva você viu o erro de novo?"))).toBe("changed");
    autonomy.rearmStanding(wake);
    // (b2) a person pasting the bot's post and adding to it: the message is not the post, it wakes (INSP-E r4 1)
    const body2 = "para testar: abra um atendimento novo e responda pelo widget do chat";
    expect(autonomy.noteVmClipboard("monitor", body2)).toBe(true);
    expect(run(message("nWv4", "Karntf Fhqxr", `@Karntf Fhqxr ${body2} fiz isso e não funcionou`))).toBe("changed");
    autonomy.rearmStanding(wake);
    // (c) the bot copies a client's message (to quote it in an issue), the client sends it again: it wakes
    const clientText = chat.map((line) => line.split("\t")[3] ?? "").find((text) => text.length > 100)!;
    expect(autonomy.noteVmClipboard("monitor", clientText)).toBe(false);
    expect(run(message("nWv3", "Karntf Fhqxr", clientText))).toBe("changed");
  });

  it("knows a message seen in the last 24 h, out of the list now, as a copy, not the bot's post (INSP-E r5 2)", () => {
    const autonomy = make();
    const wake = autonomy.setWatch("monitor", "thread-chat", { ...base, command: "gog chat messages list spaces/AAAAexample --max 10 --plain", argv: ["gog", "chat", "messages", "list", "spaces/AAAAexample", "--max", "10", "--plain"], label: "chat", baseline: "x", baselineFingerprint: "a" });
    const message = (n: number, text: string) => `spaces/AAAAexample/messages/m${n}.m${n}\tKarntf Fhqxr\t2026-10-01T10:${String(n).padStart(2, "0")}:00.000000Z\t${text}`;
    const clientText = "o atendimento caiu de novo às 10h e a cliente não recebeu a resposta do bot";
    let lines = ["RESOURCE\tSENDER\tTIME\tTEXT", message(0, clientText), ...Array.from({ length: 9 }, (_, i) => message(i + 1, `mensagem antiga ${i}`))];
    autonomy.recordWatchRun(wake, { ok: true, output: lines.join("\n"), matched: false, fingerprint: "f0", lines });
    // ten new messages: the client's leaves the list of the last 10
    for (let n = 10; n < 20; n += 1) {
      now += 60_000;
      lines = [lines[0]!, message(n, `mensagem nova ${n}`), ...lines.slice(1, 10)];
      autonomy.recordWatchRun(wake, { ok: true, output: lines.join("\n"), matched: false, fingerprint: `f${n}`, lines });
      if (wake.watch!.trigger) autonomy.rearmStanding(wake);
    }
    expect(lines.some((line) => line.includes(clientText))).toBe(false);
    // the bot copies it (to quote it in an issue): not its post
    expect(autonomy.noteVmClipboard("monitor", clientText)).toBe(false);
    // the client sends it again: it wakes the bot
    now += 60_000;
    lines = [lines[0]!, message(30, clientText), ...lines.slice(1, 10)];
    expect(autonomy.recordWatchRun(wake, { ok: true, output: lines.join("\n"), matched: false, fingerprint: "f30", lines })).toBe("changed");
    // and the memory stays bounded
    const many = Array.from({ length: SEEN_CHAT_MAX + 50 }, (_, i) => message(i, `texto único número ${i} para encher a memória`));
    autonomy.rearmStanding(wake);
    autonomy.recordWatchRun(wake, { ok: true, output: "x", matched: false, fingerprint: "big", lines: many });
    expect(autonomy.seenChatCount("monitor")).toBe(SEEN_CHAT_MAX);
  });

  it("keeps no Chat post from the VM while a Chat watch has no output of its own yet (restart, first run) (INSP-E r4 3)", () => {
    const autonomy = make();
    autonomy.setWatch("monitor", "thread-chat", { ...base, command: "gog chat messages list spaces/AAAAexample --plain", argv: ["gog", "chat", "messages", "list", "spaces/AAAAexample", "--plain"], label: "chat", baseline: "x", baselineFingerprint: "a" });
    const clientText = "o atendimento caiu de novo às 10h e a cliente não recebeu a resposta do bot";
    expect(autonomy.noteVmClipboard("monitor", clientText)).toBe(false);
  });

  it("lets go of a one-shot watch's kept lines when it is handed to its turn (INSP-E r3 3)", () => {
    const autonomy = make();
    const once = autonomy.setWatch("bot", "t9", { ...base, standing: false, command: "gh pr view 1", baseline: "x", baselineFingerprint: "a" });
    autonomy.recordWatchRun(once, { ok: true, output: "OPEN", matched: false, fingerprint: "a", lines: ["OPEN"] });
    expect(autonomy.keptLineSets()).toBe(1);
    // out of time, nothing changed: leased to its turn
    autonomy.leaseWake(once);
    expect(autonomy.keptLineSets()).toBe(0);
  });

  it("lets go of a watch's kept lines when it is cancelled, replaced or fires once (INSP-E r2 5)", () => {
    const autonomy = make();
    const lines = ["linha 1", "linha 2"];
    const run = (wake: ReturnType<typeof autonomy.setWatch>, output: string[], fingerprint: string) =>
      autonomy.recordWatchRun(wake, { ok: true, output: output.join("\n"), matched: false, fingerprint, lines: output });
    const standing = autonomy.setWatch("bot", "t1", { ...base, command: "gog sheets get x --plain", label: "planilha", baseline: "x", baselineFingerprint: "a" });
    run(standing, lines, "a");
    const once = autonomy.setWatch("bot", "t2", { ...base, standing: false, command: "gh pr view 1", baseline: "x", baselineFingerprint: "a" });
    run(once, lines, "a");
    expect(autonomy.keptLineSets()).toBe(2);
    // the one-shot watch fires: used up
    now += 60_000;
    expect(run(once, [...lines, "linha 3"], "b")).toBe("changed");
    expect(autonomy.keptLineSets()).toBe(1);
    // replaced, then cancelled
    const replaced = autonomy.setWatch("bot", "t1", { ...base, command: "gog sheets get x --plain", label: "planilha", baseline: "x", baselineFingerprint: "a" });
    expect(autonomy.keptLineSets()).toBe(0);
    run(replaced, lines, "a");
    expect(autonomy.keptLineSets()).toBe(1);
    autonomy.cancelStanding("t1", "planilha");
    expect(autonomy.keptLineSets()).toBe(0);
  });

  it("finds the same command already watched by this bot in another conversation", () => {
    const autonomy = make();
    autonomy.setWatch("bot", "t1", { ...base, command: "git ls-remote origin refs/tags/nuria-production-deployed", baseline: "x" });
    expect(autonomy.sameWatchElsewhere("bot", "t2", "git  ls-remote origin refs/tags/nuria-production-deployed").map((wake) => wake.threadId)).toEqual(["t1"]);
    expect(autonomy.sameWatchElsewhere("bot", "t1", "git ls-remote origin refs/tags/nuria-production-deployed")).toEqual([]);
    expect(autonomy.sameWatchElsewhere("other", "t2", "git ls-remote origin refs/tags/nuria-production-deployed")).toEqual([]);
  });

  it("does not take a flag's value for the item a watch looks at", () => {
    expect(watchLabel("gh issue list --state all --limit 30 --json number,updatedAt")).toBe("issues");
    expect(watchLabel("gh pr checks 9300")).toBe("PR #9300");
    expect(watchLabel("gh pr view -R o/r 9311")).toBe("PR #9311");
  });
});

describe("several standing watches per conversation", () => {
  const base = { argv: ["gog"], everyMinutes: 3, maxMinutes: 720, reason: "x", baseline: "b", standing: true };

  it("keeps one per label beside the ordinary wake; the same label replaces; cancel by label", () => {
    const autonomy = make();
    const chat = autonomy.setWatch("bot", "t1", { ...base, command: "gog chat messages list", label: "chat" });
    const sheet = autonomy.setWatch("bot", "t1", { ...base, command: "curl https://docs.google.com/x", label: "planilha" });
    autonomy.setWake("bot", "t1", 5, "timer");
    expect(autonomy.standingsFor("t1")).toEqual([chat, sheet]);
    const chat2 = autonomy.setWatch("bot", "t1", { ...base, command: "gog chat messages list --max 30", label: "chat" });
    expect(autonomy.standingsFor("t1")).toEqual([chat2, sheet]);
    expect(autonomy.cancelStanding("t1", "planilha")).toBe(sheet);
    expect(autonomy.standingsFor("t1")).toEqual([chat2]);
    expect(autonomy.wakeFor("t1")?.reason).toBe("timer");
    expect(wakeChip(chat2)).toContain('Vigia permanente "chat"');
    const reloaded = make();
    expect(reloaded.standingFor("t1", "chat")?.watch?.command).toContain("--max 30");
    reloaded.forgetThread("t1");
    expect(make().standingsFor("t1")).toEqual([]);
  });

  it("reads a standing watch saved before labels as the default one", () => {
    const path = join(dir, "bot-autonomy.json");
    writeFileSync(path, JSON.stringify({ wakes: [{ botId: "bot", threadId: "t1", dueAt: now + 60_000, reason: "chat", createdAt: now, watch: { command: "gog chat", argv: ["gog"], everyMs: 180_000, baseline: "m", lastRunAt: now, runs: 1, failures: 0, standing: true, maxMs: 60_000 } }], goals: [] }));
    const autonomy = make();
    expect(autonomy.standingFor("t1")?.reason).toBe("chat");
    autonomy.setWatch("bot", "t1", { ...base, command: "curl https://x", label: "planilha" });
    expect(autonomy.standingsFor("t1")).toHaveLength(2);
    expect(autonomy.cancelStanding("t1")?.reason).toBe("chat");
  });

  it("validates labels", () => {
    expect(parseStandingLabel(undefined)).toBe("default");
    expect(parseStandingLabel(" Planilha ")).toBe("planilha");
    expect(parseStandingLabel("a/b")).toBeNull();
    expect(parseWatchInput({ reason: "x", standing: true, label: "chat" })).toMatchObject({ ok: true, label: "chat" });
  });
});

describe("a watcher left without its standing watch", () => {
  it("is flagged once nothing re-arms it for 10 min, and cleared by a new one", () => {
    const autonomy = make();
    const base = { argv: ["gog"], everyMinutes: 3, maxMinutes: 720, reason: "x", baseline: "b", standing: true, command: "gog chat" };
    autonomy.setWatch("bot", "t1", { ...base, label: "chat" });
    autonomy.setWatch("bot", "t1", { ...base, label: "planilha" });
    autonomy.cancelStanding("t1", "chat");
    expect(autonomy.isStandingLost("t1")).toBe(false); // planilha still armed
    autonomy.cancelStanding("t1", "planilha");
    now += 9 * 60_000;
    expect(autonomy.standingLostDue()).toEqual([]);
    now += 2 * 60_000;
    expect(autonomy.standingLostDue().map((lost) => lost.threadId)).toEqual(["t1"]);
    expect(make().isStandingLost("t1")).toBe(true); // survives a restart
    autonomy.markStandingLostAlerted("t1");
    expect(autonomy.standingLostDue()).toEqual([]);
    autonomy.setWatch("bot", "t1", { ...base, label: "chat" });
    expect(autonomy.isStandingLost("t1")).toBe(false);
  });
  it("counts a one-shot watch as watched: the 10 min run from when no watch at all is left", () => {
    const autonomy = make();
    const base = { argv: ["gog"], everyMinutes: 3, maxMinutes: 30, reason: "x", baseline: "b", command: "gog chat" };
    autonomy.setWatch("bot", "t1", { ...base, standing: true, label: "chat" });
    autonomy.cancelStanding("t1", "chat");
    autonomy.setWatch("bot", "t1", base); // a one-shot watch, the conversation's ordinary wake
    now += 20 * 60_000;
    expect(autonomy.standingLostDue()).toEqual([]);
    expect(autonomy.isStandingLost("t1")).toBe(false);
    autonomy.cancelWake("t1");
    now += 5 * 60_000;
    expect(autonomy.standingLostDue()).toEqual([]);
    now += 6 * 60_000;
    expect(autonomy.standingLostDue().map((lost) => lost.threadId)).toEqual(["t1"]);
    expect(autonomy.isStandingLost("t1")).toBe(true);
  });
});

describe("promises with a deadline", () => {
  it("parses what is owed and the deadline", () => {
    expect(parsePromiseInput({ promise: " resposta ao cliente X ", promiseMinutes: 60 })).toEqual({ ok: true, text: "resposta ao cliente X", minutes: 60 });
    expect(parsePromiseInput({ promise: "", promiseMinutes: 60 }).ok).toBe(false);
    expect(parsePromiseInput({ promise: "x", promiseMinutes: 0 }).ok).toBe(false);
    expect(parsePromiseInput({ promise: "x", promiseMinutes: 7 * 1_440 + 1 }).ok).toBe(false);
  });

  it("is overdue once, past its time and unkept; kept ones never are; survives a restart", () => {
    const autonomy = make();
    const answer = autonomy.addPromise("bot", "t1", "resposta ao cliente X sobre o login", 60);
    const other = autonomy.addPromise("bot", "t1", "planilha atualizada", 30);
    expect([answer.id, other.id]).toEqual(["p1", "p2"]);
    expect(autonomy.wakeHold(2 * 3_600_000)).toEqual({ hold: true, reason: "due", at: other.dueAt });
    expect(autonomy.keepPromise("t1", "p2").map((promise) => promise.id)).toEqual(["p2"]);
    expect(autonomy.keepPromise("t2", "p1")).toEqual([]);
    now += 59 * 60_000;
    expect(autonomy.overduePromises()).toEqual([]);
    now += 2 * 60_000;
    const reloaded = make();
    expect(reloaded.overduePromises().map((promise) => promise.id)).toEqual(["p1"]);
    reloaded.markPromiseOverdue("p1");
    expect(reloaded.overduePromises()).toEqual([]);
    expect(make().promisesFor("t1")).toHaveLength(1);
    const report = promiseOverdueReport(answer, "Monitor", now);
    expect(report).toContain('promised "resposta ao cliente X sobre o login" (p1)');
    expect(report).toContain("promise_kept");
    expect(reloaded.keepPromise("t1", "all")).toHaveLength(1);
    reloaded.addPromise("bot", "t1", "x", 5);
    reloaded.forgetThread("t1");
    expect(make().promisesFor("t1")).toEqual([]);
  });
});

describe("chips", () => {
  it("names what a watch looks at instead of the raw command, and cuts on a word", () => {
    expect(watchLabel("gh pr view 9300 -R example-org/example-repo --json state")).toBe("PR #9300");
    expect(watchLabel("gh issue view 9298 --json comments")).toBe("issue #9298");
    expect(watchLabel("gog chat messages list spaces/AAAAexample --plain")).toBe("Chat");
    expect(watchLabel("gog sheets get 163U0 'Atendimento!A1:I200'")).toBe("Planilha");
    expect(watchLabel("git ls-remote origin refs/tags/nuria-production-deployed")).toBe("tag nuria-production-deployed");
    expect(watchLabel("curl -sL https://docs.google.com/spreadsheets/d/x/export?format=csv")).toBe("docs.google.com");
    expect(chipText("confira `gh pr checks` e avise o Dono sobre o resultado final do merge", 40)).toBe("confira gh pr checks e avise o Dono…");
    expect(chipText("curto", 40)).toBe("curto");
  });

  it("says in pt-BR when and why a watch or wake fires", () => {
    const autonomy = make();
    const watch = autonomy.setWatch("bot", "t1", { command: "gh pr view 9300 --json state", argv: ["gh"], everyMinutes: 15, maxMinutes: 60, reason: "avisar `GO` do merge", baseline: "OPEN" });
    expect(wakeChip(watch)).toMatch(/^Vigiando PR #9300 a cada 15 min até \d\d:\d\d — avisar GO do merge$/);
    autonomy.recordWatchRun(watch, { ok: true, output: "MERGED", matched: false });
    expect(wakeFiredChip(watch)).toBe("Vigia disparou (mudou) em PR #9300 — avisar GO do merge");
    const wake = autonomy.setWake("bot", "t2", 5, "checar deploy");
    expect(wakeChip(wake)).toMatch(/^Despertador às \d\d:\d\d — checar deploy$/);
    expect(wakeFiredChip(wake)).toBe("Acordou — checar deploy");
  });
});

describe("reports", () => {
  it("names what kind of reports arrived without assuming they are all sessions", () => {
    expect(reportsPrompt({ botId: "b", threadId: "t", items: ["one", "two"] }, null)).toContain("2 reports arrived");
  });
});

describe("a goal waiting on the person about a PR", () => {
  it("reads the PRs its question cites, and closes it when the question is moot", () => {
    expect(prsCited("GO para mergear a PR #9303? https://github.com/example-org/example-repo/pull/9286 e pull request 9290")).toEqual([
      { number: 9286, slug: "example-org/example-repo" }, { number: 9303 }, { number: 9290 },
    ]);
    expect(prsCited("nada aqui #12")).toEqual([]);
    const autonomy = make();
    autonomy.startGoal("chief", "t1", { goal: "merge", maxTurns: 5, maxHours: 2 });
    autonomy.finishGoal("t1", "needs-input", "GO para a PR #9303?");
    expect(autonomy.needsInputGoals().map((goal) => goal.threadId)).toEqual(["t1"]);
    expect(autonomy.resolveNeedsInput("t1", "PR #9303 mergeada")?.status).toBe("completed");
    expect(autonomy.needsInputGoals()).toEqual([]);
    expect(autonomy.resolveNeedsInput("t1", "x")).toBeNull();
  });
});

describe("a bot waiting on the person's answer", () => {
  it("counts a last reply that asks something, not an older one or a newer message", () => {
    const at = now;
    expect(lastQuestionAt([{ role: "user", kind: "text", text: "troque o vigia", at: at - 5 }, { role: "bot", kind: "text", text: "O vigia está cego. **Posso trocar?** 🙂", at }, { role: "bot", kind: "activity", at: at + 1 }], at + 10)).toBe(at);
    expect(lastQuestionAt([{ role: "bot", kind: "text", text: "Posso trocar?", at }, { role: "user", kind: "text", text: "pode", at: at + 1 }], at + 10)).toBeNull();
    expect(lastQuestionAt([{ role: "user", kind: "text", text: "x", at: at - 1 }, { role: "bot", kind: "text", text: "Feito.", at }], at + 10)).toBeNull();
    expect(lastQuestionAt([{ role: "user", kind: "text", text: "x", at: at - 1 }, { role: "bot", kind: "text", text: "Posso?", at }], at + 25 * 3_600_000)).toBeNull();
    // a new bot's greeting asks too, but nobody has said anything yet
    expect(lastQuestionAt([{ role: "bot", kind: "text", text: "Hi, I'm Pepper. What would you like me to do?", at }], at + 10)).toBeNull();
  });

  it("closes a needs-input goal as stopped when asked to", () => {
    const autonomy = make();
    autonomy.startGoal("chief", "t1", { goal: "teste", maxTurns: 5, maxHours: 2 });
    autonomy.finishGoal("t1", "needs-input", "Sigo?");
    expect(autonomy.resolveNeedsInput("t1", "sem resposta há mais de 12 h", "blocked")?.status).toBe("blocked");
  });
});

describe("a watch that ignores the bot's own lines", () => {
  it("keeps ignore on the watch", () => {
    const input = parseWatchInput({ reason: "x", standing: true, label: "chat", ignore: "\\tDono Exemplo\\t" });
    expect(input).toMatchObject({ ok: true, ignore: "\\tDono Exemplo\\t" });
    const wake = make().setWatch("bot", "t1", { argv: ["gog"], command: "gog chat", everyMinutes: 3, maxMinutes: 60, reason: "x", baseline: "b", standing: true, ignore: "Dono" });
    expect(make().standingFor("t1")?.watch?.ignore).toBe("Dono");
    expect(wake.watch?.ignore).toBe("Dono");
  });
});

describe("a standing watch's old note", () => {
  it("is shown with its age, so the bot checks it still holds", () => {
    const autonomy = make();
    const wake = autonomy.setWatch("chief", "t1", { argv: ["git"], command: "git ls-remote origin refs/tags/x", everyMinutes: 5, maxMinutes: 60, reason: "Conferir se contém 2995ef215 e pedir ao QA", baseline: "a", standing: true, label: "prod" });
    expect(wakePrompt(wake, null, now + 30 * 60_000)).toContain("Your note for this moment: Conferir");
    const late = wakePrompt(wake, null, now + 5 * 3_600_000);
    expect(late).toContain("written 5 h ago — check it still holds");
    expect(late).toContain("Conferir se contém 2995ef215");
  });
});

describe("a bot waiting on the person, in plain words", () => {
  it("counts an explicit ask anywhere in a reply since the person's last message, until they write again", () => {
    const at = now;
    const person = { role: "user", kind: "text", text: "Como está o lote?", at: at - 10 };
    const ask = { role: "bot", kind: "text", text: "Lote publicado. Continuam com você: ligar a volta automática da #9290 e encerrar os processos 14351 e 14474.", at };
    const later = { role: "bot", kind: "text", text: "Merge da #9315 feito.", at: at + 60_000 };
    expect(ownerAskAt([person, ask, later], at + 120_000)).toBe(at);
    expect(ownerAskAt([person, { ...ask, text: "**Preciso de você:** abra a sessão no app." }], at + 1)).toBe(at);
    expect(ownerAskAt([person, ask, later, { role: "user", kind: "text", text: "feito", at: at + 90_000 }], at + 120_000)).toBeNull();
    expect(ownerAskAt([person, later], at + 120_000)).toBeNull();
    expect(ownerAskAt([{ role: "bot", kind: "text", text: "Hi! What would you like me to do?", at }], at + 1)).toBeNull();
    expect(ownerAskAt([person, ask], at + 49 * 3_600_000)).toBeNull();
    // after a teammate's message, the asks go to the teammate
    expect(ownerAskAt([person, { role: "user", kind: "text", text: "@Monitor confira", at: at - 5, peerAsk: { botId: "c" } }, ask], at + 1)).toBeNull();
  });
});

// J18 (the owner, 02/10): after choosing "Já colei" on o12 (#9331/#9334)
// the screen showed nothing; the item, resolved by the click, left no trace.
describe("what the person answered stays with the item (J18)", () => {
  it("keeps the answers in order, waits on the bot until it rewrites or resolves, and keeps them after it is resolved", () => {
    const autonomy = make();
    const item = autonomy.addOwnerPending("monitor", "dc38193b", { title: "Colar os dois comentários dos avisos de 02/10 nas issues #NNNN e #MMMM", why: "O Jev barrou o comentário do bot.", steps: [{ text: "Cole os comentários" }], options: [{ label: "Já colei", reply: "Já colei os comentários; pode resolver." }, { label: "Cole você", reply: "Tente de novo." }] });
    now += 60_000;
    autonomy.recordOwnerPendingAnswer("monitor", item.id, { kind: "option", label: "Já colei", text: "Já colei os comentários; pode resolver.", delivered: true });
    let open = autonomy.ownerPendingById("monitor", item.id)!;
    expect(open.awaitingSince).toBe(now);
    expect(open.history).toEqual([{ at: now, by: "owner", kind: "option", label: "Já colei", text: "Já colei os comentários; pode resolver.", delivered: true }]);
    // a failed send is kept too, never silent, and does not make it wait
    now += 60_000;
    autonomy.recordOwnerPendingAnswer("monitor", item.id, { kind: "text", text: "E a planilha?", delivered: false, error: "turn admission blocked" });
    open = autonomy.ownerPendingById("monitor", item.id)!;
    expect(open.history?.at(-1)).toMatchObject({ kind: "text", delivered: false, error: "turn admission blocked" });
    expect(open.awaitingSince).toBe(now - 60_000);
    // the server refreshing the item keeps them; a restart too
    autonomy.addOwnerPending("monitor", "dc38193b", { title: open.title, why: "x", steps: [{ text: "y" }] });
    expect(make().ownerPendingById("monitor", item.id)?.history).toHaveLength(2);
    // the bot rewrites it: no longer waiting
    autonomy.updateOwnerPending("monitor", item.id, { why: "Conferi os dois comentários." });
    expect(autonomy.ownerPendingById("monitor", item.id)?.awaitingSince).toBeUndefined();
    // resolved by the bot: kept for audit, with the history, across a restart
    autonomy.resolveOwnerPending({ botId: "monitor", id: item.id, by: "bot" });
    const audit = make().resolvedOwnerPendingOf("monitor");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ id: item.id, resolvedBy: "bot", resolvedAt: now, history: [expect.objectContaining({ label: "Já colei" }), expect.objectContaining({ delivered: false })] });
  });
});

describe("the answers and the audit, robust and small (INSP-J2 #12, #13)", () => {
  it("keeps settled items slim, and at most 3 of one server item", () => {
    const autonomy = make();
    for (let n = 0; n < 5; n += 1) {
      autonomy.addOwnerPending("chief", "c1", { title: "Ligue o Mac na tomada", key: "power:battery", why: "x".repeat(300), steps: [{ text: "y" }] });
      now += 60_000;
      autonomy.resolveOwnerPending({ key: "power:battery" });
    }
    const kept = autonomy.resolvedOwnerPendingOf("chief");
    expect(kept).toHaveLength(3);
    expect(kept[0]).not.toHaveProperty("why");
    expect(kept[0]).not.toHaveProperty("steps");
    expect(Object.keys(kept[0]!).sort()).toEqual(["botId", "createdAt", "id", "key", "resolvedAt", "resolvedBy", "threadId", "title"]);
  });

  it("reads a hand-edited ledger without breaking: bad history dropped, an invalid recommendation loses only its mark", () => {
    writeFileSync(join(dir, "bot-autonomy.json"), JSON.stringify({ wakes: [], goals: [], ownerPending: [
      { id: "o1", botId: "chief", threadId: "c1", title: "A", createdAt: 1, why: "w", steps: [{ text: "s" }], history: "not a list", awaitingSince: "x",
        options: [{ label: "Um", reply: "1", recommended: true }, { label: "Dois", reply: "2", recommended: true, why: "melhor" }, { label: "Três", reply: "3", recommended: true, why: "também" }] },
      { id: "o2", botId: "chief", threadId: "c1", title: "B", createdAt: 2, history: [{ at: 5, kind: "option", label: "Um", text: "1", by: "owner", delivered: true }, { at: "bad" }, null] },
    ] }));
    const autonomy = make();
    const one = autonomy.ownerPendingById("chief", "o1")!;
    expect(one.history).toBeUndefined();
    expect(one.awaitingSince).toBeUndefined();
    expect(one.why).toBe("w");
    expect(one.steps).toEqual([{ text: "s" }]);
    expect(one.options).toEqual([{ label: "Um", reply: "1" }, { label: "Dois", reply: "2", recommended: true, why: "melhor" }, { label: "Três", reply: "3" }]);
    expect(autonomy.ownerPendingById("chief", "o2")!.history).toEqual([{ at: 5, kind: "option", label: "Um", text: "1", by: "owner", delivered: true }]);
  });
});

// INSP-J2 r2 (redacted from the owner's 02/10 items): "na fila" is not
// "enviado", a silent bot can be reminded once, and a guest sees only its own.
describe("queued answers, reminders and who sees the audit (INSP-J2 r2 N3, N7, N9)", () => {
  const add = (autonomy: BotAutonomy, title: string) =>
    autonomy.addOwnerPending("monitor", "m1", { title, why: "O Jev barrou.", steps: [{ text: "Cole os comentários" }], options: [{ label: "Já colei", reply: "Já colei.", recommended: true, why: "Está pronto." }, { label: "Cole você", reply: "Cole você." }] });

  it("records a queued answer as 'na fila', and settles it as sent when its turn starts — or as not sent", () => {
    const autonomy = make();
    const item = add(autonomy, "Colar os dois comentários nas issues #NNNN e #MMMM");
    autonomy.recordOwnerPendingAnswer("monitor", item.id, { kind: "option", label: "Já colei", text: "Já colei.", delivered: false, queued: true, queueId: "q1" });
    const queued = autonomy.ownerPendingById("monitor", item.id)!;
    // answered: it waits on the bot already, but nothing says it reached it
    expect(queued.awaitingSince).toBe(now);
    expect(queued.history).toEqual([expect.objectContaining({ delivered: false, queued: true, queueId: "q1" })]);
    expect(autonomy.settleOwnerPendingQueued((_item, entry) => entry.queueId === "other", { delivered: true })).toEqual([]);
    expect(autonomy.settleOwnerPendingQueued((_item, entry) => entry.queueId === "q1", { delivered: true })).toEqual(["monitor"]);
    expect(autonomy.ownerPendingById("monitor", item.id)!.history).toEqual([{ at: now, by: "owner", kind: "option", label: "Já colei", text: "Já colei.", delivered: true }]);
    // survives a restart as it was settled
    expect(make().ownerPendingById("monitor", item.id)!.history![0]!.delivered).toBe(true);
    // a decision that closed its item, then failed to start: the audit says so
    autonomy.recordOwnerPendingAnswer("monitor", item.id, { kind: "text", text: "E a planilha?", delivered: false, queued: true, queueId: "q2" });
    autonomy.resolveOwnerPending({ botId: "monitor", id: item.id, by: "owner" });
    autonomy.settleOwnerPendingQueued((_item, entry) => entry.queueId === "q2", { error: "o turno não começou" });
    expect(autonomy.resolvedOwnerPendingOf("monitor").at(-1)!.history!.at(-1)).toMatchObject({ delivered: false, error: "o turno não começou" });
    expect(autonomy.resolvedOwnerPendingOf("monitor").at(-1)!.history!.at(-1)).not.toHaveProperty("queued");
  });

  it("reminds a silent bot once, as a system report, and the item waits on the bot again", () => {
    const autonomy = make();
    const item = add(autonomy, "Liberar a escrita na linha 97 da planilha");
    // never answered, or answered 30 min ago: nothing to remind
    expect(autonomy.remindOwnerPending("monitor", item.id, "m1")).toBeNull();
    autonomy.recordOwnerPendingAnswer("monitor", item.id, { kind: "option", label: "Já colei", text: "Já colei.", delivered: true });
    now += 30 * 60_000;
    expect(autonomy.remindOwnerPending("monitor", item.id, "m1")).toBeNull();
    now += OWNER_PENDING_AWAIT_MS;
    const first = autonomy.remindOwnerPending("monitor", item.id, "m1");
    expect(first).toMatchObject({ deduped: false });
    const report = autonomy.takeReports("m1")!.items;
    autonomy.restoreReports({ botId: "monitor", threadId: "m1", items: report });
    expect(report).toHaveLength(1);
    expect(report[0]).toMatch(new RegExp(`^\\${REMIND_REPORT_PREFIX.slice(0, -1)}\\] ${item.id} `));
    expect(report[0]).toContain("a pessoa escolheu «Já colei» há 3 h");
    expect(report[0]).toContain(`owner_pending resolve id ${item.id}`);
    // the history says a reminder is on its way; the item waits on the bot again
    const after = autonomy.ownerPendingById("monitor", item.id)!;
    expect(after.history!.at(-1)).toMatchObject({ kind: "ask", label: "remind", delivered: false, queued: true });
    expect(after.awaitingSince).toBe(now);
    // pressed again while the report waits to be read: no second report, no second entry
    now += OWNER_PENDING_AWAIT_MS;
    expect(autonomy.remindOwnerPending("monitor", item.id, "m1")).toMatchObject({ deduped: true });
    expect(autonomy.takeReports("m1")!.items).toHaveLength(1);
    expect(autonomy.ownerPendingById("monitor", item.id)!.history!.filter((entry) => entry.label === "remind")).toHaveLength(1);
  });

  // INSP-J2 r3 R2
  it("counts the bot's 2 h from delivery, and gives the item back when the answer never arrived", () => {
    const autonomy = make();
    const item = add(autonomy, "Confirmar o teto do lote");
    const queuedAt = now;
    autonomy.recordOwnerPendingAnswer("monitor", item.id, { kind: "option", label: "Já colei", text: "Já colei.", delivered: false, queued: true, queueId: "q1" });
    // waiting its turn: nothing to remind, however long the bot is busy — and said by its reason (r4 A4)
    now += 3 * 3_600_000;
    expect(autonomy.remindOwnerPending("monitor", item.id, "m1")).toBe("queued");
    // delivered 3 h later: the bot's time starts now
    autonomy.settleOwnerPendingQueued((_item, entry) => entry.queueId === "q1", { delivered: true });
    expect(autonomy.ownerPendingById("monitor", item.id)!.awaitingSince).toBe(queuedAt + 3 * 3_600_000);
    // a later answer cancelled in the conversation: the item is the person's again, with why
    now += 60_000;
    autonomy.recordOwnerPendingAnswer("monitor", item.id, { kind: "text", text: "E a planilha?", delivered: false, queued: true, queueId: "q2" });
    autonomy.settleOwnerPendingQueued((_item, entry) => entry.queueId === "q2", { error: "cancelamento na conversa antes de chegar ao bot" });
    const back = autonomy.ownerPendingById("monitor", item.id)!;
    expect(back.awaitingSince).toBeUndefined();
    expect(back.history!.at(-1)).toMatchObject({ delivered: false, error: "cancelamento na conversa antes de chegar ao bot" });
    // an older entry settled late does not move the wait of a newer answer
    autonomy.recordOwnerPendingAnswer("monitor", item.id, { kind: "text", text: "a", delivered: false, queued: true, queueId: "q3" });
    autonomy.recordOwnerPendingAnswer("monitor", item.id, { kind: "text", text: "b", delivered: true });
    const since = autonomy.ownerPendingById("monitor", item.id)!.awaitingSince;
    now += 60_000;
    autonomy.settleOwnerPendingQueued((_item, entry) => entry.queueId === "q3", { error: "x" });
    expect(autonomy.ownerPendingById("monitor", item.id)!.awaitingSince).toBe(since);
  });

  it("says the reminder in the server's voice, never as the person", () => {
    const text = ownerPendingRemindReport({ id: "o7", title: "Aprovar o envio", awaitingSince: 0, history: [{ at: 0, kind: "text", text: "Pode enviar.", by: "owner", delivered: true }] }, 5 * 3_600_000);
    expect(text.startsWith(REMIND_REPORT_PREFIX)).toBe(true);
    expect(text).toContain("a pessoa respondeu há 5 h");
    expect(text).not.toMatch(/\b(eu|me|meu|minha)\b/i);
  });

  it("shows a session only the items from conversations it may write in", () => {
    const items = [{ id: "o1", threadId: "own" }, { id: "o2", threadId: "guest" }];
    expect(ownerPendingVisible(items, () => null).map((item) => item.id)).toEqual(["o1", "o2"]);
    expect(ownerPendingVisible(items, (threadId) => (threadId === "guest" ? null : "not yours")).map((item) => item.id)).toEqual(["o2"]);
  });
});

describe("what waits on the person, made practical (lot I)", () => {
  const steps = [
    { text: "Abra a PR e confira o diff do carrier", link: "https://github.com/acme/app/pull/12" },
    { text: "Rode o gate local", command: "pnpm run ci:local" },
  ];
  const options = [{ label: "Aprovar", reply: "Aprovado: pode fazer o merge da #12." }, { label: "Recusar", reply: "Recusado: não faça o merge." }];

  it("reads why, steps and options the way a bot sends them, and refuses what the person could not use", () => {
    expect(parseOwnerPendingDetails({ why: "  Sem isso\n o deploy para.  ", steps, options })).toEqual({ ok: true, why: "Sem isso o deploy para.", steps, options });
    // some engines send nested values as JSON text; a bare string is a step
    expect(parseOwnerPendingDetails({ steps: JSON.stringify(["Abrir a planilha"]) })).toEqual({ ok: true, steps: [{ text: "Abrir a planilha" }] });
    expect(parseOwnerPendingDetails({})).toEqual({ ok: true });
    expect(parseOwnerPendingDetails({ steps: [], options: [] })).toEqual({ ok: true, steps: [], options: [] });
    const refused = (input: Parameters<typeof parseOwnerPendingDetails>[0]) => { const r = parseOwnerPendingDetails(input); return r.ok ? "" : r.error; };
    expect(refused({ steps: [{ text: "" }] })).toContain("o passo 1 precisa de text");
    expect(refused({ steps: [{ text: "Abrir", link: "javascript:alert(1)" }] })).toContain("https://");
    expect(refused({ steps: Array.from({ length: 9 }, (_, n) => ({ text: `passo ${n}` })) })).toContain("no máximo 8 passos");
    expect(refused({ options: [{ label: "Aprovar" }] })).toContain("reply");
    expect(refused({ options: [{ label: "Sim", reply: "a" }, { label: "sim", reply: "b" }] })).toContain("duas opções");
    expect(refused({ options: [{ label: "x".repeat(41), reply: "a" }] })).toContain("verbo curto");
    expect(refused({ steps: "abra a PR" })).toContain("lista de passos");
  });

  it("keeps why, steps and options on the item, refreshes them on a second add, and an old item without them still loads", () => {
    const autonomy = make();
    const item = autonomy.addOwnerPending("chief", "c1", { title: "Aprovar o merge da PR #12", why: "O release de hoje depende dela.", steps, options });
    expect(item).toMatchObject({ why: "O release de hoje depende dela.", steps, options });
    // the same ask again without the structure keeps it; with new steps replaces them
    expect(autonomy.addOwnerPending("chief", "c1", { title: "Aprovar o merge da PR #12" })).toMatchObject({ id: item.id, steps, options });
    expect(autonomy.addOwnerPending("chief", "c1", { title: "Aprovar o merge da PR #12", steps: [steps[1]!] }).steps).toEqual([steps[1]]);
    // a ledger written before lot I, and one hand-edited with junk, load
    writeFileSync(join(dir, "bot-autonomy.json"), JSON.stringify({ wakes: [], goals: [], ownerPending: [
      { id: "o1", botId: "chief", threadId: "c1", title: "Liberar a escrita na linha 97 da planilha", createdAt: now - 3_600_000 },
      { id: "o2", botId: "chief", threadId: "c1", title: "Decidir o padrão", createdAt: now, steps: "nope", options: [{ label: 3 }] },
    ] }));
    const loaded = make().ownerPendingFor("c1");
    expect(loaded.map((each) => each.id)).toEqual(["o1", "o2"]);
    expect(loaded[1]).not.toHaveProperty("steps");
    expect(loaded[1]).not.toHaveProperty("options");
  });

  it("update rewrites the bot's own item in place — same id, place and age — clears with empty lists, and answers a request for steps", () => {
    const autonomy = make();
    const old = autonomy.addOwnerPending("chief", "c1", { title: "@Chief of Staff", link: "https://github.com/acme/app/pull/12" });
    now += 60_000;
    expect(autonomy.markOwnerPendingStepsRequested("chief", old.id)?.stepsRequestedAt).toBe(now);
    expect(autonomy.updateOwnerPending("monitor", old.id, { why: "x" })).toBeNull();
    expect(autonomy.updateOwnerPending("chief", "o99", { why: "x" })).toBeNull();
    now += 60_000;
    const updated = autonomy.updateOwnerPending("chief", old.id, { title: "Aprovar o merge da PR #12", why: "O release depende dela.", steps, options, due: "hoje 18h" })!;
    expect(updated).toMatchObject({ id: old.id, threadId: "c1", createdAt: old.createdAt, updatedAt: now, title: "Aprovar o merge da PR #12", due: "hoje 18h", link: old.link, steps, options });
    expect(updated).not.toHaveProperty("stepsRequestedAt");
    expect(make().ownerPendingFor("c1")).toEqual([updated]);
    const cleared = autonomy.updateOwnerPending("chief", old.id, { options: [], due: "" })!;
    expect(cleared).not.toHaveProperty("options");
    expect(cleared).not.toHaveProperty("due");
    expect(cleared.steps).toEqual(steps);
    // an id folded into the item (alias) still reaches it
    autonomy.resolveOwnerPending({ botId: "chief", id: old.id });
    expect(autonomy.ownerPendingById("chief", old.id)).toBeNull();
  });

  it("tells the bot which item the person answered, and asks it for the exact update call", () => {
    const item = { id: "o3", title: "Aprovar o merge da PR #12" };
    expect(ownerPendingReplyText(item, " Aprovado: pode fazer o merge da #12. ", true)).toBe("Sobre \"Aprovar o merge da PR #12\" (o3): Aprovado: pode fazer o merge da #12.\n\n(Marquei o3 como resolvido em \"Precisa de você\".)");
    // J18: not resolved, it says the item waits on the bot — in plain words, no tool name
    // INSP-J2 #3: the person's words carry only facts; what the bot must do is a note only it reads
    expect(ownerPendingReplyText(item, "Espere a CI.", false)).toBe("Sobre \"Aprovar o merge da PR #12\" (o3): Espere a CI.");
    expect(ownerPendingAwaitNote(item)).toMatch(/^\[Nota do OpenMausBot, não escrita pela pessoa\] A pendência o3 continua .*owner_pending resolve id o3.*owner_pending update id o3.*2 h/);
    // what the person "says" is plain; the tool call is a note only the bot reads (INSP-I r1 #6)
    expect(ownerPendingStepsRequestText(item)).toBe("Me mostre como resolver «Aprovar o merge da PR #12», passo a passo.");
    expect(ownerPendingStepsRequestText(item)).not.toMatch(/owner_pending|why|steps|options/);
    const note = ownerPendingStepsRequestNote(item);
    expect(note).toContain("não escrita pela pessoa");
    expect(note).toContain("owner_pending update, id o3");
    expect(note).toMatch(/why .* steps .* options/s);
    expect(note).toContain("Não abra outra pendência");
  });

  it("knows a title that only names someone, by the same rule in the server and the app (INSP-I r1 #1/#2)", () => {
    expect(isMentionOnly("@Chief of Staff")).toBe(true);
    expect(isMentionOnly("@Chief of Staff, @Monitor:")).toBe(true);
    expect(isMentionOnly("  @Monitor Chat Atendimento  ", ["Monitor Chat Atendimento"])).toBe(true);
    expect(isMentionOnly("@Monitor Chat Atendimento:")).toBe(true);
    expect(isMentionOnly("@Osvaldo")).toBe(true);
    expect(isMentionOnly("@Osvaldo aprovar o deploy da versão 2.14 em produção")).toBe(false);
    expect(stripLeadingMentions("@Osvaldo aprovar o deploy da versão 2.14")).toBe("aprovar o deploy da versão 2.14");
    // a known name is taken off exactly: the capitalized verb after it stays
    expect(stripLeadingMentions("@Monitor Chat Aprovar a fila", ["Monitor Chat"])).toBe("Aprovar a fila");
    expect(isMentionOnly("Aprovar o carrier da #9315")).toBe(false);
  });

  it("an unknown @handle takes only itself: a capitalized verb after it is the title's first word (INSP-I r2 #1)", () => {
    expect(stripLeadingMentions("@Osvaldo Aprovar o deploy da versão 2.14 em produção")).toBe("Aprovar o deploy da versão 2.14 em produção");
    expect(stripLeadingMentions("@Ana Revisar o contrato de Maria")).toBe("Revisar o contrato de Maria");
    expect(stripLeadingMentions("@time Financeiro Conferir NF")).toBe("Financeiro Conferir NF");
    expect(stripLeadingMentions("@Osvaldo PR #12 aprovar")).toBe("PR #12 aprovar");
    // the text shows where a name of several words ends: a connector, or closing punctuation
    expect(stripLeadingMentions("@Chief of Staff Rodei tudo")).toBe("Rodei tudo");
    expect(stripLeadingMentions("@Monitor Chat Atendimento: preciso da planilha")).toBe("preciso da planilha");
    for (const title of ["@Osvaldo Aprovar o deploy da versão 2.14 em produção", "@Ana Revisar o contrato de Maria", "@time Financeiro Conferir NF", "@Osvaldo PR #12 aprovar", "@Osvaldo Aprovar", "Deploy"]) {
      expect(isMentionOnly(title)).toBe(false);
    }
    // the rest of a person's name is no title; a verb closed by a comma is not a name (INSP-I r3 #3)
    expect(isMentionOnly("@Osvaldo Silva")).toBe(true);
    expect(isMentionOnly("@Osvaldo Silva Santos")).toBe(true);
    expect(stripLeadingMentions("@Osvaldo Aprovar, por favor, o deploy")).toBe("Aprovar, por favor, o deploy");
    expect(stripLeadingMentions("@Equipe Financeiro Comercial Norte: conferir a NF")).toBe("Financeiro Comercial Norte: conferir a NF");
    expect(ownerAskText("@Chief of Staff, rodei a análise. Posso abrir a PR?", 200, ["Chief of Staff"])).toBe("Posso abrir a PR?");
  });

  it("titles an ask by what it asks, not by who: the last question, without a leading mention or markdown", () => {
    expect(ownerAskText("@Chief of Staff, rodei a análise. **Posso abrir a PR da #9052 agora?**")).toBe("Posso abrir a PR da #9052 agora?");
    expect(ownerAskText("@Monitor Chat Atendimento: preciso que você libere a escrita na linha 97 da planilha. Depois sigo.")).toBe("Preciso que você libere a escrita na linha 97 da planilha.");
    expect(ownerAskText("Feito.\n\n- item\n\nTudo certo")).toBe("Feito.");
    expect(ownerAskText("@Chief of Staff")).toBe("");
    const long = ownerAskText(`Você aprova ${"a mudança grande ".repeat(20)}?`, 80);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
    const at = now;
    const person = { role: "user", kind: "text", text: "status?", at: at - 10 };
    expect(ownerAsk([person, { role: "bot", kind: "text", text: "@Chief of Staff Rodei tudo. Posso fazer o merge?", at }], at + 1)).toBe("Posso fazer o merge?");
    expect(ownerAsk([person, { role: "bot", kind: "text", text: "Feito.", at }], at + 1)).toBeNull();
  });
});

describe("what waits on the person", () => {
  it("keeps one item per thing until resolved, survives a restart, and lets the server resolve its own by key", () => {
    const autonomy = make();
    const a = autonomy.addOwnerPending("chief", "c1", { title: "Aprovar o carrier da #9315", due: "hoje 18h", link: "https://github.com/o/r/pull/9315" });
    const again = autonomy.addOwnerPending("chief", "c1", { title: "Aprovar o carrier da #9315", due: "hoje 19h" });
    expect(again.id).toBe(a.id);
    expect(autonomy.ownerPendingFor("c1")).toEqual([again]);
    const draft = autonomy.addOwnerPending("chief", "c1", { title: "Texto não enviado no campo da sessão #9298", key: "cc-draft:s1" });
    expect(make().ownerPendingFor("c1").map((item) => item.id)).toEqual([a.id, draft.id]);
    expect(autonomy.resolveOwnerPending({ key: "cc-draft:s1" })).toEqual([draft]);
    // another bot cannot resolve this one
    expect(autonomy.resolveOwnerPending({ botId: "monitor", id: a.id })).toEqual([]);
    expect(autonomy.resolveOwnerPending({ botId: "chief", threadId: "c1", id: "all" })).toHaveLength(1);
    expect(autonomy.ownerPendingOf("chief")).toEqual([]);
  });

  // The Chief's items of 01/10 21:20 (bot-autonomy.json, redacted): one release
  // loop asked for three times, in three conversations, with three remedies;
  // o1 shares a PR link with o8 but asks something else (R9-followup #3).
  const SHA = "cb015584a35296ec89b2dbaf2c54373e6f93b826";
  const PR = (n: number) => `https://github.com/o/platform/pull/${n}`;
  const ITEMS = [
    { thread: "3e55c0fd", title: "#9052 / PR #9332: confirmar padrão \"sem limite\" e decidir o timeout do pre-push", link: PR(9332) },
    { thread: "dbb9f1cf", title: `Parar o laço do watcher de release no topo cb015584a (sem alvo de runtime): echo ${SHA} > ~/.nuria/declined-production-release.sha` },
    { thread: "ade82a65", title: "Autorizar pausar o watcher de produção no cb015584a (arquivo halted) para a PR #9341 passar no gate", link: PR(9341) },
    { thread: "3e55c0fd", title: "Release automático em laço no cb015584a (só scripts) segura o lease e trava o gate da #9332: parar o LaunchAgent?", link: PR(9332) },
  ];

  it("keeps one item per action across the bot's conversations, and tells the bot which one exists", () => {
    const autonomy = make();
    const [o1, o2, o3, o4] = ITEMS.map((item) => { now += 60_000; return autonomy.addOwnerPending("chief", item.thread, { title: item.title, ...(item.link ? { link: item.link } : {}) }); });
    expect([o1, o2].map((item) => item!.duplicate)).toEqual([undefined, undefined]);
    // the same commit, elsewhere: the first item, untouched, flagged
    expect(o3).toMatchObject({ id: o2!.id, threadId: "dbb9f1cf", duplicate: true });
    expect(o4).toMatchObject({ id: o2!.id, duplicate: true });
    expect(autonomy.ownerPendingOf("chief").map((item) => item.id)).toEqual([o1!.id, o2!.id]);
    expect(autonomy.ownerPendingOf("chief")[1]!.title).toContain("declined-production-release.sha");
    // the same link (no commit) or the same title elsewhere is the same ask too
    expect(autonomy.addOwnerPending("chief", "dd9c5ece", { title: "Decidir o padrão da #9052", link: `${PR(9332)}/` })).toMatchObject({ id: o1!.id, duplicate: true });
    expect(autonomy.addOwnerPending("chief", "dd9c5ece", { title: "  #9052 / PR #9332: confirmar padrão \"sem limite\" e decidir o timeout do pre-push " })).toMatchObject({ id: o1!.id, duplicate: true });
    // another bot keeps its own
    expect(autonomy.addOwnerPending("monitor", "dc38193b", { title: ITEMS[1]!.title }).duplicate).toBeUndefined();
    // a server item with the same key follows the desk, keeping its id
    const power = autonomy.addOwnerPending("chief", "dd9c5ece", { title: "Ligue o Mac na tomada (18%)", key: "power:battery" });
    const moved = autonomy.addOwnerPending("chief", "dbb9f1cf", { title: "Ligue o Mac na tomada (12%)", key: "power:battery" });
    expect(moved).toMatchObject({ id: power.id, threadId: "dbb9f1cf", title: "Ligue o Mac na tomada (12%)" });
    expect(moved.duplicate).toBeUndefined();
    expect(autonomy.ownerPendingOf("chief").filter((item) => item.key === "power:battery")).toHaveLength(1);
  });

  it("folds the equivalent items saved before into the oldest, still resolvable by their old ids", () => {
    writeFileSync(join(dir, "bot-autonomy.json"), JSON.stringify({
      wakes: [], goals: [], inFlight: [],
      ownerPending: ITEMS.map((item, i) => ({ id: `o${[1, 5, 7, 8][i]}`, botId: "chief", threadId: item.thread, title: item.title, createdAt: 1_000 + i, ...(item.link ? { link: item.link } : {}) })),
    }));
    const autonomy = make();
    const open = autonomy.ownerPendingOf("chief");
    expect(open.map((item) => [item.id, item.aliases ?? []])).toEqual([["o1", []], ["o5", ["o7", "o8"]]]);
    // the survivor keeps its remedy (the declined file) and gains the link the others had
    expect(open[1]).toMatchObject({ threadId: "dbb9f1cf", link: PR(9341) });
    // saved folded: a second load finds nothing to fold
    expect(JSON.parse(readFileSync(join(dir, "bot-autonomy.json"), "utf8")).ownerPending).toHaveLength(2);
    // the bot that knew "o7" resolves the one item
    expect(autonomy.resolveOwnerPending({ botId: "chief", id: "o7" }).map((item) => item.id)).toEqual(["o5"]);
    expect(autonomy.ownerPendingOf("chief").map((item) => item.id)).toEqual(["o1"]);
  });

  it("folds by the ACTION asked, never by a commit, a conversation id or a link alone (INSP-H r1 #3)", () => {
    const loop = { title: `Recusar o release em laço de cb015584a (5 falhas iguais)`, key: "release-loop:cb015584a" };
    // the real o5/o7/o8: one action, three wordings
    for (const title of [ITEMS[1]!.title, ITEMS[2]!.title, ITEMS[3]!.title]) expect(sameOwnerPending(loop, { title }), title).toBe(true);
    // naming the commit is not asking to refuse it
    expect(sameOwnerPending(loop, { title: "Revisar com o QA o diff do cb015584a" })).toBe(false);
    // INSP-H r2 #5: the watcher named for something else; stopping said another way
    expect(sameOwnerPending(loop, { title: "Conferir no watcher se o deploy do cb015584a terminou" })).toBe(false);
    expect(sameOwnerPending(loop, { title: "Decidir se paramos o release do cb015584a ou esperamos a #9341" })).toBe(true);
    expect(sameOwnerPending(loop, { title: "Liberar a PR #9341 para passar no gate do cb015584a" })).toBe(false);
  });

  it("joins the real o14 and o15 (one loop, two wordings), and keeps checks and negations apart (INSP-H r3 #1)", () => {
    // the ledger of 02/10, redacted
    const o14 = { title: "Recusar o release em laço de d5bb1f70b (5 falhas iguais) — copie o comando", key: "release-loop:d5bb1f70b" };
    const o15 = { title: "Gravar a trava do release d5bb1f70b para destravar a PR #9348 (#9334/#9331 em produção)" };
    expect(sameOwnerPending(o15, o14)).toBe(true);
    for (const title of ["Travar o release d5bb1f70b", "Escrever o declined do d5bb1f70b"]) expect(sameOwnerPending({ title }, o14), title).toBe(true);
    for (const title of ["Não parar o release d5bb1f70b ainda; esperar a #9348", "Conferir se o release do d5bb1f70b parou", "Seguir sem pausar o watcher no d5bb1f70b",
      // undoing the refusal is the opposite ask (INSP-H r4 #1)
      "Liberar o release d5bb1f70b de novo (desfazer a recusa)", "Destrave o release d5bb1f70b (tire a trava)", "Apagar o declined do d5bb1f70b"]) {
      expect(sameOwnerPending({ title }, o14), title).toBe(false);
      expect(ownerPendingAction({ title }), title).toBeNull();
    }
    // the bot's item lands first; the server's, with its key, takes it over: one item, the bot's id
    const autonomy = make();
    const bots = autonomy.addOwnerPending("chief", "dbb9f1cf", o15);
    const server = autonomy.addOwnerPending("chief", "dbb9f1cf", o14);
    expect(server).toMatchObject({ id: bots.id, key: "release-loop:d5bb1f70b" });
    expect(autonomy.ownerPendingOf("chief")).toHaveLength(1);
  });

  it("joins the owner's \"Abrir no app … raiz de <repo>\" with the server's unblock item (INSP-H r3 #3)", () => {
    // the real o8 of 02/10 (redacted)
    const o8 = "Abrir no app Claude uma sessão nova na raiz de nuria-platform e mandar uma mensagem curta (o app está reaproveitando a worktree [x] em sessões novas)";
    expect(ownerPendingAction({ title: o8 })).toEqual({ kind: "app-reused-folder", sha: "nuria-platform" });
    writeFileSync(join(dir, "bot-autonomy.json"), JSON.stringify({ wakes: [], goals: [], inFlight: [], ownerPending: [{ id: "o8", botId: "chief", threadId: "dbb9f1cf", title: o8, createdAt: 1 }] }));
    const loaded = make();
    // askOwnerToUnblockApp's own item (title from appUnblockTitle)
    const server = loaded.addOwnerPending("chief", "dbb9f1cf", { title: "Abrir no app uma sessão na raiz de nuria-platform e enviar uma mensagem curta (destrava o app, que está reaproveitando worktrees; até lá as sessões vão para o terminal)", key: "app-reused-folder:nuria-platform" });
    expect(server).toMatchObject({ id: "o8", key: "app-reused-folder:nuria-platform" });
    expect(loaded.ownerPendingOf("chief")).toHaveLength(1);
    // another repository is another item
    expect(sameOwnerPending({ title: o8 }, { title: "x", key: "app-reused-folder:OpenMausBot" })).toBe(false);
    // not under a negation (INSP-H r4 #2)
    expect(ownerPendingAction({ title: "Não abrir no app sessão na raiz de nuria-platform" })).toBeNull();
    expect(sameOwnerPending({ title: ITEMS[1]!.title }, { title: "Revisar com o QA o diff do cb015584a" })).toBe(false);
    // a conversation's id is no commit
    expect(commitsIn("Fechar a conversa 6477b3f4")).toEqual([]);
    expect(commitsIn("ver dbb9f1cf-5b8f-486d-9f6d-3167938cd65b")).toEqual([]);
    expect(sameOwnerPending({ title: "Fechar a conversa 6477b3f4" }, { title: "Renomear a conversa 6477b3f4" })).toBe(false);
    // the same link is not the same decision
    expect(sameOwnerPending({ title: ITEMS[0]!.title, link: PR(9332) }, { title: "Aprovar o merge da PR #9332", link: PR(9332) })).toBe(false);
    // different commits, different keys, decimal numbers
    expect(sameOwnerPending({ title: "Parar o laço do release no 2995ef215" }, { title: "Parar o laço do release no cb015584a" })).toBe(false);
    expect(sameOwnerPending({ title: "a", key: "tag-advance:abc123456" }, { title: "a", key: "tag-advance:def567890" })).toBe(false);
    expect(sameOwnerPending({ title: "Aprovar 20261001 e #9332" }, { title: "Outro 20261001" })).toBe(false);
    expect(sameOwnerPending({ title: "Ligue o Mac na tomada" }, { title: "x", key: "power:battery" })).toBe(true);
  });

  it("keeps the why, steps and options of a folded item on the one that stays", () => {
    writeFileSync(join(dir, "bot-autonomy.json"), JSON.stringify({
      wakes: [], goals: [], inFlight: [],
      ownerPending: [
        { id: "o7", botId: "chief", threadId: "ade82a65", title: ITEMS[2]!.title, createdAt: 1_000 },
        { id: "o8", botId: "chief", threadId: "3e55c0fd", title: ITEMS[3]!.title, createdAt: 2_000, why: "O release está parado.", steps: [{ text: "Grave a recusa", command: "echo x" }], options: [{ label: "Recusar", reply: "pode recusar" }] },
      ],
    }));
    const [only] = make().ownerPendingOf("chief");
    expect(only).toMatchObject({ id: "o7", aliases: ["o8"], why: "O release está parado.", steps: [{ text: "Grave a recusa", command: "echo x" }], options: [{ label: "Recusar", reply: "pode recusar" }] });
  });

  it("never gives a new item an id still answered as an alias, and keeps the server's key when folding (INSP-H r1 #3)", () => {
    writeFileSync(join(dir, "bot-autonomy.json"), JSON.stringify({
      wakes: [], goals: [], inFlight: [],
      ownerPending: [
        { id: "o7", botId: "chief", threadId: "ade82a65", title: ITEMS[2]!.title, createdAt: 1_000 },
        { id: "o8", botId: "chief", threadId: "3e55c0fd", title: ITEMS[3]!.title, createdAt: 2_000 },
        { id: "o9", botId: "chief", threadId: "dbb9f1cf", title: "Recusar o release em laço de cb015584a (3 falhas iguais): echo … > ~/.nuria/declined-production-release.sha", key: "release-loop:cb015584a", createdAt: 3_000 },
      ],
    }));
    const autonomy = make();
    const [only] = autonomy.ownerPendingOf("chief");
    // the oldest id stays, with the server's key and remedy
    expect(only).toMatchObject({ id: "o7", key: "release-loop:cb015584a", aliases: ["o8", "o9"] });
    expect(only!.title).toContain("declined-production-release.sha");
    expect(only!.title).not.toContain("halted");
    // the server can still close it by its key
    const fresh = autonomy.addOwnerPending("chief", "dd9c5ece", { title: "Decidir o destino da #9280" });
    expect(["o7", "o8", "o9"]).not.toContain(fresh.id);
    expect(autonomy.resolveOwnerPending({ botId: "chief", id: "o8" }).map((each) => each.id)).toEqual(["o7"]);
    expect(autonomy.ownerPendingOf("chief").map((each) => each.id)).toEqual([fresh.id]);
  });
});

describe("a standing watch's note", () => {
  it("changes in place, keeping its baseline and schedule", () => {
    const autonomy = make();
    const wake = autonomy.setWatch("bot", "t1", { command: "git ls-remote origin", argv: ["git", "ls-remote", "origin"], everyMinutes: 15, maxMinutes: 120, reason: "pedir ao QA o #8891", baseline: "90b3ef2a5", standing: true, label: "prod" });
    const due = wake.dueAt;
    now += 3 * 3_600_000;
    expect(autonomy.updateStandingReason("t1", "prod", "avisar a Fulana quando a #9307 entrar")).toBe(wake);
    expect(wake.reason).toBe("avisar a Fulana quando a #9307 entrar");
    expect(wake.watch!.reasonAt).toBe(now);
    expect(wake.watch!.baseline).toBe("90b3ef2a5");
    expect(wake.dueAt).toBe(due);
    expect(autonomy.updateStandingReason("t1", "chat", "x")).toBeNull();
  });
});

// Lot J2 bug 2: a bot's bare question is asked, once, to become an item with
// why, steps and options; the item the bot opens then takes its place.
describe("a bare question asked to become an item (lot J2)", () => {
  const ask = { threadId: "main", askAt: Date.parse("2026-09-29T00:00:00Z"), text: "A decisão de produto da #9356 continua com você. Sigo com a opção A ou B?" };
  const steps = [{ text: "Leia a issue" }];

  it("asks as the server, never in the person's voice, and reads its own Ref back", () => {
    const report = questionStepsAutoReport(ask, "@Chief of Staff");
    expect(report.startsWith(`${QUESTION_REPORT_PREFIX} Ref main@${ask.askAt}.`)).toBe(true);
    expect(report).toContain("na conversa «@Chief of Staff»");
    expect(report).toContain("owner_pending add");
    expect(report).toContain("UMA com recommended: true e why");
    expect(report).toContain("Não escreva ao dono só por isto.");
    expect(questionReportRef(report)).toEqual({ threadId: "main", askAt: ask.askAt });
    expect(questionReportRef("[Servidor: lembrete de pendência] o1")).toBeNull();
  });

  it("is one request per question: the same ask, or the same words asked again; remembered across a restart", () => {
    const autonomy = make();
    const asked = autonomy.noteAskPromotion({ botId: "b", ...ask, reportThreadId: "channel" });
    expect(asked.askedAt).toBe(now);
    expect(autonomy.askPromotionFor("b", "main", ask.askAt, "anything")).toEqual(asked);
    expect(autonomy.askPromotionFor("b", "main", ask.askAt + 60_000, "a decisão de PRODUTO da #9356 continua com você — sigo com a opção A ou B")).toEqual(asked);
    expect(autonomy.askPromotionFor("b", "main", ask.askAt + 60_000, "Mesclo a #9350?")).toBeNull();
    expect(autonomy.askPromotionFor("b", "other", ask.askAt, ask.text)).toBeNull();
    expect(sameAskText("", "")).toBe(false);
    // "Pedir de novo": the same request, dated now
    now += 20 * 60_000;
    expect(autonomy.noteAskPromotion({ botId: "b", ...ask, reportThreadId: "channel" }).askedAt).toBe(now);
    expect(make().askPromotionFor("b", "main", ask.askAt, "")?.askedAt).toBe(now);
    // ~/.nuria/stop dropped the request before it reached the bot: the question goes back to unasked
    autonomy.dropAskPromotion("b", "main", ask.askAt);
    expect(make().askPromotionFor("b", "main", ask.askAt, "")).toBeNull();
  });

  it("is replaced by the item the bot opens for it — not by an unrelated or earlier one — and stays replaced once it is settled", () => {
    const autonomy = make();
    autonomy.addOwnerPending("b", "main", { title: "Aprovar o carrier da #9300", why: "x", steps });
    now += 60_000;
    const asked = autonomy.noteAskPromotion({ botId: "b", ...ask, reportThreadId: "channel" });
    expect(autonomy.askPromotionItem(asked)).toBeNull();
    // another bot's item, or a server item, never takes it over
    expect(itemTakesOverAsk(asked, { botId: "other", threadId: "channel", createdAt: now, title: "Decidir a #9356" })).toBe(false);
    expect(itemTakesOverAsk(asked, { botId: "b", threadId: "channel", createdAt: now, title: "Decidir a #9356", key: "tag-advance:x" })).toBe(false);
    // elsewhere, saying it: the same #ref, after the request
    expect(itemTakesOverAsk(asked, { botId: "b", threadId: "elsewhere", createdAt: now + 1, title: "Decidir a opção de produto da #9356" })).toBe(true);
    expect(itemTakesOverAsk(asked, { botId: "b", threadId: "elsewhere", createdAt: now + 1, title: "Liberar a linha 97" })).toBe(false);
    now += 30 * 60_000;
    const item = autonomy.addOwnerPending("b", "channel", { title: "Escolher entre A e B para o cliente", why: "A cliente espera.", steps });
    expect(autonomy.askPromotionItem(asked)?.id).toBe(item.id);
    autonomy.resolveOwnerPending({ botId: "b", id: item.id, by: "owner" });
    const reloaded = make();
    const again = reloaded.askPromotionFor("b", "main", ask.askAt, "")!;
    expect(again.itemId).toBe(item.id);
    expect(reloaded.askPromotionItem(again)?.id).toBe(item.id);
  });
});
