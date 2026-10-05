// An answer from "Precisa de você" sent twice reaches the bot twice: the app
// gives up on a slow request (a disk item is checked on the Mac first, which
// can take a while), the person presses again, and both requests go through
// (INSP-R12F r5 #3). The same answer to the same item — the same decision,
// or the same words — within a short window is taken once: while the first
// is on its way the second is told so, and once it went the second is told
// it already went. A first that failed is forgotten, so sending again works.

export const ANSWER_DEDUPE_MS = 2 * 60_000;

/** The same answer to the same item: bot, item, kind, label and words. */
export function answerKey(botId: string, itemId: string, answer: { kind: string; label?: string; text: string }): string {
  return JSON.stringify([botId, itemId, answer.kind, answer.label ?? "", answer.text.trim().replace(/\s+/g, " ")]);
}

export class AnswerDedupe {
  private readonly seen = new Map<string, { at: number; sent: boolean }>();
  private readonly windowMs: number;
  private readonly now: () => number;

  // plain field assignments (the server runs under Node's type-stripping)
  constructor(windowMs = ANSWER_DEDUPE_MS, now: () => number = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
  }

  /** The first of its kind in the window goes; a repeat is told what became of the first. */
  claim(key: string): { ok: true } | { ok: false; sent: boolean; agoMs: number } {
    const at = this.now();
    for (const [each, seen] of this.seen) if (at - seen.at > this.windowMs) this.seen.delete(each);
    const first = this.seen.get(key);
    if (first) return { ok: false, sent: first.sent, agoMs: at - first.at };
    this.seen.set(key, { at, sent: false });
    return { ok: true };
  }

  /** The answer went: repeats within the window are dropped. */
  sent(key: string): void {
    const seen = this.seen.get(key);
    if (seen) seen.sent = true;
  }

  /** The answer did not go (refused, failed): it may be sent again. */
  release(key: string): void {
    this.seen.delete(key);
  }
}

/** What the person reads when a repeat is dropped. */
export function duplicateAnswerText(repeat: { sent: boolean; agoMs: number }): string {
  const ago = Math.max(1, Math.round(repeat.agoMs / 1000));
  return repeat.sent
    ? `Essa mesma resposta já foi enviada há ${ago} s; não mandei de novo.`
    : "Essa mesma resposta ainda está sendo enviada; não mandei de novo.";
}
