// One intake turn per bot. A watch firing and a routine run of the same bot
// read the same sources (Chat, spreadsheet, issues) in different
// conversations: run together, both answer the same client message. So a
// bot runs one such turn at a time; the other waits — a watch stays due, a
// routine is deferred — until the first conversation is idle again.

export class IntakeLock {
  private readonly running = new Map<string, string>();
  private readonly busy: (botId: string, threadId: string) => boolean;

  // plain field assignment, not a parameter property (node type-stripping)
  constructor(busy: (botId: string, threadId: string) => boolean) {
    this.busy = busy;
  }

  /** Another intake turn of this bot is still running, in another conversation. */
  busyElsewhere(botId: string, threadId?: string): boolean {
    const running = this.running.get(botId);
    if (!running || running === threadId) return false;
    if (this.busy(botId, running)) return true;
    this.running.delete(botId);
    return false;
  }

  note(botId: string, threadId: string): void {
    this.running.set(botId, threadId);
  }

  /** The turn in `threadId` ended (or never started). */
  settle(threadId: string): void {
    for (const [botId, running] of this.running) if (running === threadId) this.running.delete(botId);
  }
}
