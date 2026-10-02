// Everything that waits on the person, across all bots: approvals a bot
// stopped for, goals that asked, bots whose last reply asked something. One
// list, oldest first — what has waited longest is what to answer first.
import type { Bot, Task } from "@/state/store";
import { t } from "@/lib/i18n";

export interface NeedsYouItem {
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  since: number;
  approval: boolean;
  /** An owner_pending item: its id (the person can resolve it), deadline and link. */
  pendingId?: string;
  due?: string;
  link?: string;
  /** The exact command to act on it, copied with one click (never run). */
  command?: string;
}

export function needsYouItems(bots: readonly Bot[]): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const bot of bots) {
    if (bot.hidden) continue;
    const tasks: Task[] = bot.tasks ?? [{ threadId: bot.threadId, title: bot.name, createdAt: 0, activity: bot.activity, goalNeedsInput: bot.goalNeedsInput, goalNeedsInputSince: bot.goalNeedsInputSince } as Task];
    for (const task of tasks) {
      if (task.routineRunId || task.archivedAt) continue;
      // listed by the bot (or the server): one row each, until resolved
      for (const pending of task.ownerPending ?? []) {
        items.push({ botId: bot.id, botName: bot.name, threadId: task.threadId, title: pending.title, since: pending.since, approval: false, pendingId: pending.id, ...(pending.due ? { due: pending.due } : {}), ...(pending.link ? { link: pending.link } : {}), ...(pending.command ? { command: pending.command } : {}) });
      }
      const approval = task.activity === "waiting-on-you";
      if (!approval && task.goalNeedsInput !== true) continue;
      items.push({ botId: bot.id, botName: bot.name, threadId: task.threadId, title: task.title, since: task.goalNeedsInputSince ?? task.updatedAt ?? task.createdAt, approval });
    }
  }
  return items.sort((a, b) => a.since - b.since);
}

/** "agora", "12 min", "3 h", "2 d": how long it has waited. */
export function waitingAge(since: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (!since || minutes < 1) return t("needsYou.ageNow");
  if (minutes < 60) return t("needsYou.ageMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("needsYou.ageHours", { count: hours });
  return t("needsYou.ageDays", { count: Math.floor(hours / 24) });
}
