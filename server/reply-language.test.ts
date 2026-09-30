import { describe, expect, it } from "vitest";
import { languagePrompt, languageReminder } from "./reply-language.ts";
import { goalContinuationPrompt, reportsPrompt, wakePrompt, type BotGoal, type BotWake } from "./bot-autonomy.ts";
import { renderRecall } from "./recall.ts";

describe("reply language", () => {
  it("defaults to pt-BR and follows the language picked in the app", () => {
    expect(languageReminder()).toBe("(Responda à pessoa em português do Brasil.)");
    expect(languageReminder("pt-br")).toBe("(Responda à pessoa em português do Brasil.)");
    expect(languageReminder("de")).toBe("(Reply to the person in German.)");
    expect(languagePrompt("")).toContain("Brazilian Portuguese (pt-BR)");
    expect(languagePrompt("fr")).toContain("written in French");
  });

  it("closes every harness-written turn message with the reminder", () => {
    const wake: BotWake = { botId: "b", threadId: "t", dueAt: 0, reason: "check", createdAt: 0 };
    const goal: BotGoal = { botId: "b", threadId: "t", goal: "ship", status: "active", startedAt: 0, deadlineAt: 3_600_000, maxTurns: 5, turnCount: 1, consecutiveFailures: 0 };
    const reminder = "(Responda à pessoa em português do Brasil.)";
    expect(wakePrompt(wake, null, 60_000).endsWith(reminder)).toBe(true);
    expect(reportsPrompt({ botId: "b", threadId: "t", items: ["report"] }, null).endsWith(reminder)).toBe(true);
    expect(goalContinuationPrompt(goal, 0).endsWith(reminder)).toBe(true);
    expect(wakePrompt(wake, null, 60_000, "(Reply to the person in German.)").endsWith("German.)")).toBe(true);
    expect(renderRecall([{ source: "memory", label: "MEMORY", snippet: "x" }], 10_000, reminder)!.text.split("\n")[0]).toContain(reminder);
  });
});
