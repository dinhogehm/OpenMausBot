import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BotAutonomy,
  GOAL_DEFAULT_MAX_TURNS,
  GOAL_MIN_TURN_GAP_MS,
  goalContinuationPrompt,
  goalEndChip,
  parseGoalEndInput,
  parseGoalInput,
  parsePromiseInput,
  prsCited,
  lastQuestionAt,
  parseWakeInput,
  promiseOverdueReport,
  parseWatchInput,
  chipText,
  parseStandingLabel,
  reportsPrompt,
  wakeChip,
  wakeFiredChip,
  watchLabel,
  wakePrompt,
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
    const watch = autonomy.setWatch("bot", "t1", { ...chat, until: "Pedro" });
    expect(autonomy.recordWatchRun(watch, { ok: true, output: "Pedro: oi", fingerprint: "f2", matched: true })).toBe("matched");
    autonomy.rearmStanding(watch);
    expect(autonomy.recordWatchRun(watch, { ok: true, output: "Pedro: oi", fingerprint: "f2", matched: true })).toBeNull();
    expect(autonomy.recordWatchRun(watch, { ok: true, output: "Pedro: oi\nPedro: e aí?", fingerprint: "f3", matched: true })).toBe("matched");
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
    const old = "2026-03-16T19:19:20Z Cezar Boa!\n2026-03-31T10:00:00Z Marluce ok";
    const wake = autonomy.setWatch("bot", "t1", { ...base, command: "gog chat messages list spaces/X --plain", label: "chat", baseline: old, baselineFingerprint: "f1" });
    now += 2 * 3_600_000;
    autonomy.recordWatchRun(wake, { ok: true, output: old, matched: false, fingerprint: "f1" });
    expect(autonomy.staleWatches()).toEqual([]);
    now += 2 * 3_600_000;
    expect(autonomy.staleWatches()).toEqual([wake]);
    autonomy.markWatchStaleAlerted(wake);
    expect(autonomy.staleWatches()).toEqual([]);
    const fresh = autonomy.setWatch("bot", "t2", { ...base, command: "gog x", label: "chat", baseline: `${new Date(now).toISOString()} Pedro`, baselineFingerprint: "f2" });
    now += 4 * 3_600_000;
    expect(autonomy.staleWatches()).not.toContain(fresh);
  });

  it("tells the bot which lines are new when the output is cut", () => {
    const autonomy = make();
    const rows = Array.from({ length: 5 }, (_, i) => `linha ${i}`);
    const wake = autonomy.setWatch("bot", "t1", { ...base, command: "curl https://docs.google.com/x", label: "planilha", baseline: "linha 0", baselineFingerprint: "a" });
    autonomy.recordWatchRun(wake, { ok: true, output: "linha 0", matched: false, fingerprint: "a", truncated: true, lines: rows });
    now += 60_000;
    autonomy.recordWatchRun(wake, { ok: true, output: "linha 0", matched: false, fingerprint: "b", truncated: true, lines: [...rows, "linha 5 — Pedro, nova"] });
    expect(wake.watch!.trigger).toBe("changed");
    const prompt = wakePrompt(wake, null, now);
    expect(prompt).toContain("Lines new or changed since the run before (1):\nlinha 5 — Pedro, nova");
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
    expect(watchLabel("gh pr view 9300 -R dinhogehm/nuria-platform --json state")).toBe("PR #9300");
    expect(watchLabel("gh issue view 9298 --json comments")).toBe("issue #9298");
    expect(watchLabel("gog chat messages list spaces/AAQA4TXnzJ4 --plain")).toBe("Chat");
    expect(watchLabel("gog sheets get 163U0 'Atendimento!A1:I200'")).toBe("Planilha");
    expect(watchLabel("git ls-remote origin refs/tags/nuria-production-deployed")).toBe("tag nuria-production-deployed");
    expect(watchLabel("curl -sL https://docs.google.com/spreadsheets/d/x/export?format=csv")).toBe("docs.google.com");
    expect(chipText("confira `gh pr checks` e avise o Osvaldo sobre o resultado final do merge", 40)).toBe("confira gh pr checks e avise o Osvaldo…");
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
    expect(prsCited("GO para mergear a PR #9303? https://github.com/dinhogehm/nuria-platform/pull/9286 e pull request 9290")).toEqual([
      { number: 9286, slug: "dinhogehm/nuria-platform" }, { number: 9303 }, { number: 9290 },
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
    const input = parseWatchInput({ reason: "x", standing: true, label: "chat", ignore: "\\tOsvaldo Gehm\\t" });
    expect(input).toMatchObject({ ok: true, ignore: "\\tOsvaldo Gehm\\t" });
    const wake = make().setWatch("bot", "t1", { argv: ["gog"], command: "gog chat", everyMinutes: 3, maxMinutes: 60, reason: "x", baseline: "b", standing: true, ignore: "Osvaldo" });
    expect(make().standingFor("t1")?.watch?.ignore).toBe("Osvaldo");
    expect(wake.watch?.ignore).toBe("Osvaldo");
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
