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

  /** The first of its kind in the window goes; a repeat is told what became
   * of the first — unless `failed` says the first's delivery failed since it
   * was taken (failedSince): then this one goes. */
  claim(key: string, failed?: (since: number) => boolean): { ok: true } | { ok: false; sent: boolean; agoMs: number } {
    const at = this.now();
    for (const [each, seen] of this.seen) if (at - seen.at > this.windowMs) this.seen.delete(each);
    const first = this.seen.get(key);
    if (first && !failed?.(first.at)) return { ok: false, sent: first.sent, agoMs: at - first.at };
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

/** Calls `done` with the status the handler itself answers with, when it
 * writes it — not when the client goes away: an app that aborts at 300 ms
 * while the handler still delivers at 1.5 s must not free the key (INSP-R12F
 * r6 D1). Writing to a closed socket still calls writeHead. Once only. */
export function onAnswered<T extends { writeHead: (status: number, ...rest: any[]) => unknown }>(res: T, done: (status: number) => void): void {
  const original = res.writeHead.bind(res);
  let told = false;
  res.writeHead = ((status: number, ...rest: any[]) => {
    if (!told) {
      told = true;
      done(status);
    }
    return original(status, ...rest);
  }) as T["writeHead"];
}

/** The first answer was queued (202) and its delivery failed afterwards: the
 * item's history says so, with an error, after the first was taken — the
 * same answer is free again (INSP-R12F r6 D2). */
export function failedSince(history: ReadonlyArray<{ at: number; kind: string; label?: string; text: string; error?: string }> | undefined, answer: { kind: string; label?: string; text: string }, since: number): boolean {
  return Boolean(history?.some((each) => each.at >= since && each.error && each.kind === answer.kind && (each.label ?? "") === (answer.label ?? "") && each.text === answer.text));
}

/** What the person reads when a repeat is dropped. */
export function duplicateAnswerText(repeat: { sent: boolean; agoMs: number }): string {
  const ago = Math.max(1, Math.round(repeat.agoMs / 1000));
  return repeat.sent
    ? `Essa mesma resposta já foi enviada há ${ago} s; não mandei de novo.`
    : "Essa mesma resposta ainda está sendo enviada; não mandei de novo.";
}
