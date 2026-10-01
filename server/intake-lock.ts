// One intake turn per bot. A watch firing and a routine run of the same bot
// read the same sources (Chat, spreadsheet, issues) in different
// conversations: run together, both answer the same client message. So a
// bot runs one such turn at a time; the other waits — a watch stays due, a
// routine is deferred — until the first conversation is idle again.
//
// A teammate's message to such a bot is intake too: the Chief saying "pode
// avisar a Daiane" in one conversation while the bot's own tag watch fires
// in another sends the same notice twice. So it takes the same lock.
//
// Every wait is remembered (who waited, behind which conversation, since
// when) and handed back when the waiter runs, for the server log: the lock
// has to be visible to be trusted (R8-intake 4).

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
    const wait = this.note(botId, threadId);
    if (wait) onRun?.(wait);
    return true;
  }

  /** The intake turn in `threadId` starts; how long it waited, if it did
   * (`waiter` names it when it waited under another name, e.g. "routine"). */
  note(botId: string, threadId: string, waiter = threadId): IntakeWait | null {
    this.running.set(botId, threadId);
    const key = `${botId}\u0000${waiter}`;
    const wait = this.waits.get(key);
    if (!wait) return null;
    this.waits.delete(key);
    return { behind: wait.behind, ms: this.now() - wait.since };
  }

  /** The turn in `threadId` ended (or never started). */
  settle(threadId: string): void {
    for (const [botId, running] of this.running) if (running === threadId) this.running.delete(botId);
  }
}
