// One intake turn per bot. A watch firing and a routine run of the same bot
// read the same sources (Chat, spreadsheet, issues) in different
// conversations: run together, both answer the same client message. So a
// bot runs one such turn at a time; the other waits — a watch stays due, a
// routine is deferred — until the first conversation is idle again.
//
// A teammate's message to such a bot is intake too: the Chief saying "pode
// avisar a Fulana" in one conversation while the bot's own tag watch fires
// in another sends the same notice twice. So it takes the same lock.
//
// Every wait is remembered (who waited, behind which conversation, since
// when) and handed back when the waiter runs, for the server log: the lock
// has to be visible to be trusted (R8-intake 4).

/** A wait older than this is no longer the same wait (2 h). */
export const WAIT_FORGET_MS = 2 * 3_600_000;

export interface IntakeWait {
  /** The conversation it waited behind. */
  behind: string;
  ms: number;
}

export class IntakeLock {
  private readonly running = new Map<string, string>();
  private readonly waits = new Map<string, { since: number; behind: string }>();
  private readonly busy: (botId: string, threadId: string) => boolean;
  private readonly now: () => number;

  // plain field assignments, not parameter properties (node type-stripping)
  constructor(busy: (botId: string, threadId: string) => boolean, now: () => number = Date.now) {
    this.busy = busy;
    this.now = now;
  }

  /** Another intake turn of this bot is still running, in another conversation. */
  busyElsewhere(botId: string, threadId?: string): boolean {
    const running = this.running.get(botId);
    if (!running || running === threadId) return false;
    if (this.busy(botId, running)) return true;
    this.running.delete(botId);
    return false;
  }

  /** The conversation holding this bot's intake turn. */
  holder(botId: string): string | undefined {
    return this.running.get(botId);
  }

  /** `waiter` (a conversation, or "routine") is held back now: remembered from its first wait. */
  noteWait(botId: string, waiter: string): void {
    const key = `${botId}\u0000${waiter}`;
    const behind = this.running.get(botId);
    if (behind && !this.waits.has(key)) this.waits.set(key, { since: this.now(), behind });
  }

  /** A teammate's turn for a bot that reads intake through standing watches:
   * false while another intake turn runs elsewhere, else it holds the lock.
   * A bot's message to itself (a thread it opened) never waits on itself. */
  admitPeer(botId: string, threadId: string, fromBotId: string, readsIntake: boolean, onRun?: (wait: IntakeWait) => void): boolean {
    if (!readsIntake || fromBotId === botId) return true;
    if (this.busyElsewhere(botId, threadId)) {
      this.noteWait(botId, threadId);
      return false;
    }
    this.note(botId, threadId);
    const wait = this.takeWait(botId, threadId);
    if (wait) onRun?.(wait);
    return true;
  }

  /** The intake turn in `threadId` holds the lock. */
  note(botId: string, threadId: string): void {
    this.running.set(botId, threadId);
  }

  /** How long `waiter` waited, once its turn really started; the wait is
   * spent. A wait older than WAIT_FORGET_MS (a watch cancelled, a routine
   * that never ran) is dropped, not reported. */
  takeWait(botId: string, waiter: string): IntakeWait | null {
    const key = `${botId}\u0000${waiter}`;
    const wait = this.waits.get(key);
    if (!wait) return null;
    this.waits.delete(key);
    const ms = this.now() - wait.since;
    return ms > WAIT_FORGET_MS ? null : { behind: wait.behind, ms };
  }

  /** `waiter` will not run after all (its watch was cancelled or re-armed): its wait is dropped. */
  dropWaits(waiter: string): void {
    for (const key of this.waits.keys()) if (key.endsWith(`\u0000${waiter}`)) this.waits.delete(key);
  }

  /** The turn in `threadId` ended (or never started). */
  settle(threadId: string): void {
    for (const [botId, running] of this.running) if (running === threadId) this.running.delete(botId);
  }
}
