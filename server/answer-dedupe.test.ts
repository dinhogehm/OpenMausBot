import { describe, expect, it } from "vitest";
import { ANSWER_DEDUPE_MS, AnswerDedupe, answerKey, duplicateAnswerText } from "./answer-dedupe.ts";

// INSP-R12F r5 #3: the app gave up on a slow answer, the owner sent it again, the Chief got it twice
describe("the same answer to the same item, sent twice", () => {
  it("is taken once within the window: a repeat is told the first is on its way, or went", () => {
    let now = 1_000_000;
    const dedupe = new AnswerDedupe(ANSWER_DEDUPE_MS, () => now);
    const key = answerKey("chief", "o14", { kind: "text", text: "pode remover  todas" });
    expect(dedupe.claim(key)).toEqual({ ok: true });
    now += 5_000;
    // still on its way (the disk check is slow): not sent again
    const pending = dedupe.claim(key);
    expect(pending).toEqual({ ok: false, sent: false, agoMs: 5_000 });
    expect(duplicateAnswerText(pending as { sent: boolean; agoMs: number })).toBe("Essa mesma resposta ainda está sendo enviada; não mandei de novo.");
    dedupe.sent(key);
    now += 10_000;
    const went = dedupe.claim(answerKey("chief", "o14", { kind: "text", text: "pode remover todas" }));
    expect(went).toEqual({ ok: false, sent: true, agoMs: 15_000 });
    expect(duplicateAnswerText(went as { sent: boolean; agoMs: number })).toBe("Essa mesma resposta já foi enviada há 15 s; não mandei de novo.");
    // another answer, or another item, goes
    expect(dedupe.claim(answerKey("chief", "o14", { kind: "text", text: "mantenha" }))).toEqual({ ok: true });
    expect(dedupe.claim(answerKey("chief", "o15", { kind: "text", text: "pode remover todas" }))).toEqual({ ok: true });
    expect(dedupe.claim(answerKey("chief", "o14", { kind: "option", label: "Push e remover", text: "pode remover todas" }))).toEqual({ ok: true });
    // past the window, the same words go again
    now += ANSWER_DEDUPE_MS + 1;
    expect(dedupe.claim(key)).toEqual({ ok: true });
  });

  it("a first that failed (refused, not delivered) is forgotten: sending again works", () => {
    const dedupe = new AnswerDedupe();
    const key = answerKey("chief", "o14", { kind: "option", label: "Push e remover", text: "Para as worktrees…" });
    expect(dedupe.claim(key).ok).toBe(true);
    dedupe.release(key);
    expect(dedupe.claim(key).ok).toBe(true);
  });
});
