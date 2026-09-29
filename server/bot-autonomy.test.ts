import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  parseWakeInput,
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
    expect(goalEndChip(autonomy.finishGoal("t1", "completed", "deployed")!)).toBe("Goal completed after 1 turn — deployed");
  });
});
