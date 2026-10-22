import { describe, expect, it } from "vitest";
import { isPortugueseLanguage, languagePrompt, languageReminder, readsAsEnglish } from "./reply-language.ts";
import { goalContinuationPrompt, reportsPrompt, wakePrompt, type BotGoal, type BotWake } from "./bot-autonomy.ts";
import { renderRecall } from "./recall.ts";

describe("reply language", () => {
  it("defaults to pt-BR and follows the language picked in the app", () => {
    expect(languageReminder()).toBe("(Responda à pessoa em português do Brasil.)");
    expect(languageReminder("pt-br")).toBe("(Responda à pessoa em português do Brasil.)");
    expect(languageReminder("de")).toBe("(Reply to the person in German.)");
    expect(languagePrompt("")).toContain("Brazilian Portuguese (pt-BR)");
    expect(languagePrompt("fr")).toContain("written in French");
    expect(languagePrompt()).toContain("Notes to yourself");
    expect(languagePrompt()).toContain("including the short lines you write between tool calls");
    expect(languagePrompt()).toContain("Every sentence people can see is in Brazilian Portuguese (pt-BR)");
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

// R11/R12-followup #4: the Chief's narration that reached the owner's channel as text
describe("a line that reads as English", () => {
  it("is every real slip of 03/10 to 05/10 in the owner's channel", () => {
    for (const said of [
      "It's focused now. Keyboard attempt: press Enter/space to open, then arrow.",
      "The gate is free. Release running? Check log quickly.",
      "Now the orphans: inspect.",
      "Fits the authorized routine: clean, idle >72h, PR merged and in production. Removing without --force.",
      "Release is running via the watcher. Arm a wait on the tag.",
      "Commit is in production. Now hand off to QA and Monitor, cancel my temporary tag watch, archive the session, and put the issue close in pending.",
      // 05/10 02:22 and 08:22 (R12)
      "Published (tag ahead of merge), only graft change, no process using it. Fits the authorized routine.",
      "Both nested ones are clean and published; remove them (routine). The merge-deploy one has untracked `.claude/` config and closed-unmerged PR — leave.",
    ]) expect(readsAsEnglish(said), said).toBe(true);
  });

  it("is never a Portuguese reply, even full of English terms, commands and links", () => {
    for (const said of [
      "Osvaldo, das três worktrees que estavam paradas havia mais de 72 horas fora da tag, removi duas e deixei uma para você decidir. As remoções foram sem `--force`.",
      "Gate verde no head, merge feito.",
      "PR #9376 merged, carrier #9377 publicado: https://github.com/dinhogehm/nuria-platform/pull/9377",
      "Rodei `git worktree remove --force the-old-one` e conferi o `git status`.",
      "Selecionada.",
      "ok",
    ]) expect(readsAsEnglish(said), said).toBe(false);
  });

  it("follows the owner's language: Portuguese by default", () => {
    expect(isPortugueseLanguage()).toBe(true);
    expect(isPortugueseLanguage("")).toBe(true);
    expect(isPortugueseLanguage("pt-br")).toBe(true);
    expect(isPortugueseLanguage("en")).toBe(false);
  });
});
