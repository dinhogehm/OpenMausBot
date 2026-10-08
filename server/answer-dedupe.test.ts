import { describe, expect, it } from "vitest";
import { ANSWER_DEDUPE_MS, AnswerDedupe, answerKey, duplicateAnswerText, failedSince, onAnswered } from "./answer-dedupe.ts";

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

  // INSP-R12F r6 D1: the client aborting at 300 ms freed the key while the handler still delivered at 1.5 s
  it("is settled by the status the handler writes, once, never by the client going away", () => {
    const statuses: number[] = [];
    const written: number[] = [];
    const res = { writeHead: (status: number) => { written.push(status); return res; } };
    onAnswered(res, (status) => statuses.push(status));
    // the client went away: nothing yet — the handler has not answered
    expect(statuses).toEqual([]);
    res.writeHead(202);
    res.writeHead(500);
    expect(statuses).toEqual([202]);
    expect(written).toEqual([202, 500]);
    // wired as the route does: an abort before the end keeps the key "on its way"
    const dedupe = new AnswerDedupe();
    const key = answerKey("chief", "o14", { kind: "text", text: "pode remover sim" });
    expect(dedupe.claim(key).ok).toBe(true);
    const slow = { writeHead: (_status: number) => slow };
    onAnswered(slow, (status) => (status < 300 ? dedupe.sent(key) : dedupe.release(key)));
    expect(dedupe.claim(key)).toMatchObject({ ok: false, sent: false });
    slow.writeHead(202);
    expect(dedupe.claim(key)).toMatchObject({ ok: false, sent: true });
    // a refusal frees it
    const other = answerKey("chief", "o14", { kind: "text", text: "outra" });
    dedupe.claim(other);
    const refused = { writeHead: (_status: number) => refused };
    onAnswered(refused, (status) => (status < 300 ? dedupe.sent(other) : dedupe.release(other)));
    refused.writeHead(409);
    expect(dedupe.claim(other).ok).toBe(true);
  });

  // INSP-R12F r6 D2: a first queued (202) whose delivery failed afterwards kept the repeat out
  it("a first queued and then failed to deliver, as the item's history says, frees the same answer", () => {
    let now = 1_000_000;
    const dedupe = new AnswerDedupe(ANSWER_DEDUPE_MS, () => now);
    const answer = { kind: "option", label: "Push e remover", text: "Para as worktrees 8204…" };
    const key = answerKey("chief", "o14", answer);
    expect(dedupe.claim(key).ok).toBe(true);
    dedupe.sent(key);
    const history = [{ at: now + 10, ...answer, delivered: false, queued: true as const }];
    now += 20_000;
    // still queued, nothing failed: a repeat is dropped
    expect(dedupe.claim(key, (since) => failedSince(history, answer, since)).ok).toBe(false);
    // the queue failed it ("não enviada")
    history[0] = { ...history[0]!, error: "a conversa não existe mais" } as typeof history[0];
    expect(failedSince(history, answer, now - 20_000)).toBe(true);
    expect(dedupe.claim(key, (since) => failedSince(history, answer, since)).ok).toBe(true);
    // an error on another answer, or before this one was taken, does not count
    expect(failedSince([{ at: now, kind: "text", text: "outra", error: "x" }], answer, now - 1)).toBe(false);
    expect(failedSince([{ ...answer, at: now - 60_000, error: "x" }], answer, now - 1)).toBe(false);
  });

  it("a first that failed (refused, not delivered) is forgotten: sending again works", () => {
    const dedupe = new AnswerDedupe();
    const key = answerKey("chief", "o14", { kind: "option", label: "Push e remover", text: "Para as worktrees…" });
    expect(dedupe.claim(key).ok).toBe(true);
    dedupe.release(key);
    expect(dedupe.claim(key).ok).toBe(true);
  });
});
