// Everything that waits on the person, across all bots: approvals a bot
// stopped for, goals that asked, bots whose last reply asked something. One
// list, oldest first — what has waited longest is what to answer first.
import type { Bot, Task } from "@/state/store";
import { t } from "@/lib/i18n";
import type { WireOwnerPending } from "../../shared/wire";
import { isMentionOnly, stripLeadingMentions } from "../../shared/owner-pending-title";

export type NeedsYouStep = NonNullable<WireOwnerPending["steps"]>[number];
export type NeedsYouOption = NonNullable<WireOwnerPending["options"]>[number];

export interface NeedsYouItem {
  botId: string;
  botName: string;
  threadId: string;
  /** What to do, said the way the panel shows it (never only a mention). */
  title: string;
  /** The title as the bot (or the conversation) wrote it, when the panel reworded it. */
  rawTitle?: string;
  /** The conversation it came from ("Abrir conversa"). */
  threadTitle?: string;
  since: number;
  approval: boolean;
  /** An owner_pending item: its id (the person can resolve it), deadline and link. */
  pendingId?: string;
  due?: string;
  link?: string;
  /** The exact command to act on it, copied with one click (never run). */
  command?: string;
  /** Why it matters, what to do and the decisions the bot offered. */
  why?: string;
  steps?: NeedsYouStep[];
  options?: NeedsYouOption[];
  /** The person asked the bot for steps; it has not rewritten the item yet. */
  stepsRequestedAt?: number;
  /** The person asked the bot which decision it recommends; no update yet. */
  recommendRequestedAt?: number;
  /** What the person answered, in order (J18). */
  history?: NonNullable<WireOwnerPending["history"]>;
  /** The person's last answer reached the bot, which has not updated nor resolved the item since. */
  awaitingSince?: number;
}

/** The option the person last chose and that reached the bot, if any (J18). */
export function chosenOption(item: Pick<NeedsYouItem, "history">): string | null {
  return item.history?.findLast((each) => each.kind === "option" && each.delivered)?.label ?? null;
}

/** "16:07" today, "02/10 16:07" another day: when an answer was given. */
export function answerTime(at: number, now = Date.now()): string {
  const day = new Date(at);
  const today = new Date(now);
  const time = day.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return day.toDateString() === today.toDateString() ? time : `${day.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${time}`;
}

/** The decisions in the order they are shown, each with its index in the
 * item (what the server checks): the recommended one first (J16), the rest
 * in the bot's order. */
export function decisionsInOrder(options: readonly NeedsYouOption[]): Array<{ option: NeedsYouOption; index: number }> {
  const all = options.map((option, index) => ({ option, index }));
  return [...all.filter((each) => each.option.recommended), ...all.filter((each) => !each.option.recommended)];
}

/** An answer that declines or postpones: drawn as a neutral button (J15). */
export const negativeDecision = (label: string): boolean =>
  /^(?:n[ãa]o\b|nunca\b|recusar|rejeitar|cancelar|adiar|deixar\b|vou deixar|seguir no terminal|ignorar)/i.test(label.trim());

const REFS_FIRST = /^((?:(?:PR|issue|sess[ãa]o)\s*)?#\d+(?:\s*(?:[/·,&+]|e)\s*(?:(?:PR|issue)\s*)?#\d+)*)\s*[:—–-]\s*(.+)$/iu;

/** A title that reads in the panel. The mentions it opens with are set
 * aside by the server's rule ("@Osvaldo aprovar o deploy" → "Aprovar o
 * deploy"); a title that is ONLY a mention becomes the bot's question
 * (`ask`, never the item's "why") or "<bot> precisa de uma resposta sua".
 * A title that starts with references ("#9052 / PR #9332: confirmar…")
 * starts with the action, references after ("Confirmar… (#9052 / PR #9332)"). */
export function needsYouTitle(title: string, opts: { ask?: string; botName: string; botNames?: readonly string[] }): string {
  const rest = stripLeadingMentions(title, opts.botNames);
  if (isMentionOnly(title, opts.botNames)) {
    const ask = opts.ask?.trim();
    return ask ? ask : t("needsYou.answerBot", { name: opts.botName });
  }
  const refs = REFS_FIRST.exec(rest);
  if (refs && /\p{L}{3}/u.test(refs[2]!)) {
    const action = refs[2]!.trim();
    return `${action.charAt(0).toLocaleUpperCase()}${action.slice(1)} (${refs[1]!.replace(/\s+/g, " ")})`;
  }
  return rest.charAt(0).toLocaleUpperCase() + rest.slice(1);
}

export function needsYouItems(bots: readonly Bot[]): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const botNames = bots.map((bot) => bot.name).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const bot of bots) {
    if (bot.hidden) continue;
    const tasks: Task[] = bot.tasks ?? [{ threadId: bot.threadId, title: bot.name, createdAt: 0, activity: bot.activity, goalNeedsInput: bot.goalNeedsInput, goalNeedsInputSince: bot.goalNeedsInputSince } as Task];
    for (const task of tasks) {
      if (task.routineRunId || task.archivedAt) continue;
      // listed by the bot (or the server): one row each, until resolved
      for (const pending of task.ownerPending ?? []) {
        // never the "why" as the title: it is shown under it (INSP-I r1 #2)
        const title = needsYouTitle(pending.title, { botName: bot.name, botNames });
        items.push({
          botId: bot.id, botName: bot.name, threadId: task.threadId, threadTitle: task.title, title,
          // a mention was set aside: what the bot wrote stays one line away (INSP-I r2 #1);
          // moved references or a capital letter are no reason to repeat it (INSP-I r3 #2)
          ...(stripLeadingMentions(pending.title, botNames) !== pending.title.replace(/\s+/g, " ").trim() ? { rawTitle: pending.title } : {}),
          since: pending.since, approval: false, pendingId: pending.id,
          ...(pending.due ? { due: pending.due } : {}), ...(pending.link ? { link: pending.link } : {}), ...(pending.command ? { command: pending.command } : {}),
          ...(pending.why ? { why: pending.why } : {}), ...(pending.steps?.length ? { steps: pending.steps } : {}), ...(pending.options?.length ? { options: pending.options } : {}),
          ...(pending.stepsRequestedAt ? { stepsRequestedAt: pending.stepsRequestedAt } : {}),
          ...(pending.recommendRequestedAt ? { recommendRequestedAt: pending.recommendRequestedAt } : {}),
          ...(pending.history?.length ? { history: pending.history } : {}),
          ...(pending.awaitingSince ? { awaitingSince: pending.awaitingSince } : {}),
        });
      }
      const approval = task.activity === "waiting-on-you";
      if (!approval && task.goalNeedsInput !== true) continue;
      // the bot's question says what it waits for better than the conversation's title
      const ask = task.goalNeedsInputAsk?.trim();
      const title = ask || needsYouTitle(task.title, { botName: bot.name, botNames });
      items.push({ botId: bot.id, botName: bot.name, threadId: task.threadId, threadTitle: task.title, title, since: task.goalNeedsInputSince ?? task.updatedAt ?? task.createdAt, approval });
    }
  }
  return items.sort((a, b) => a.since - b.since);
}

/** A stable key for one item across renders and refreshes. */
export const needsYouKey = (item: Pick<NeedsYouItem, "botId" | "threadId" | "pendingId">) => `${item.botId}:${item.threadId}:${item.pendingId ?? ""}`;

/** "agora", "12 min", "3 h", "2 d": how long it has waited. */
export function waitingAge(since: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (!since || minutes < 1) return t("needsYou.ageNow");
  if (minutes < 60) return t("needsYou.ageMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("needsYou.ageHours", { count: hours });
  return t("needsYou.ageDays", { count: Math.floor(hours / 24) });
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/;
const BR_DAY = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
const HOUR = /\b(\d{1,2})\s*(?:h|:)\s*(\d{2})?\b/i;
const WEEKDAYS = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];

/** When a deadline written as text falls, best effort: "2026-10-03",
 * "2026-10-03T18:00", "03/10", "hoje 18h", "amanhã 9h30", "antes de ~19:45".
 * A day without an hour ends at 23:59. null when it does not read as a time. */
export function dueAt(due: string | undefined, now = Date.now()): number | null {
  if (!due) return null;
  const text = due.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const hour = HOUR.exec(text.replace(ISO_DAY, "").replace(BR_DAY, ""));
  const at = (day: Date) => {
    if (hour && Number(hour[1]) < 24) day.setHours(Number(hour[1]), Number(hour[2] ?? 0), 0, 0);
    else day.setHours(23, 59, 0, 0);
    return day.getTime();
  };
  const iso = ISO_DAY.exec(text);
  if (iso) {
    const day = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (iso[4]) { day.setHours(Number(iso[4]), Number(iso[5]), 0, 0); return day.getTime(); }
    return at(day);
  }
  const br = BR_DAY.exec(text);
  if (br) {
    const year = br[3] ? Number(br[3].length === 2 ? `20${br[3]}` : br[3]) : new Date(now).getFullYear();
    return at(new Date(year, Number(br[2]) - 1, Number(br[1])));
  }
  const today = new Date(now);
  // "agora": due this very moment — first in "Prazo", never shown as overdue (INSP-J r1 #14)
  if (/^\s*agora\b/.test(text)) return now;
  if (/\bamanha\b/.test(text)) return at(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  // checked before "ontem": "anteontem" contains it
  if (/\banteontem\b/.test(text)) return at(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2));
  if (/\bontem\b/.test(text)) return at(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
  const weekday = WEEKDAYS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(text));
  if (weekday >= 0) return at(new Date(today.getFullYear(), today.getMonth(), today.getDate() + ((weekday - today.getDay() + 7) % 7)));
  if (/\bhoje\b/.test(text) || hour) return at(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  return null;
}

export type NeedsYouSort = "due" | "age";

/** "due": what falls due first (items without a deadline after, oldest
 * first); "age": what has waited longest. */
export function sortNeedsYou(items: readonly NeedsYouItem[], sort: NeedsYouSort, now = Date.now()): NeedsYouItem[] {
  if (sort === "age") return items.toSorted((a, b) => a.since - b.since);
  const when = new Map(items.map((item) => [item, dueAt(item.due, now)]));
  return items.toSorted((a, b) => {
    const left = when.get(a) ?? null;
    const right = when.get(b) ?? null;
    if (left !== null && right !== null && left !== right) return left - right;
    if (left !== null && right === null) return -1;
    if (left === null && right !== null) return 1;
    return a.since - b.since;
  });
}

/** The bots that have something waiting, with how many, for the filter. */
export function needsYouBots(items: readonly NeedsYouItem[]): Array<{ botId: string; botName: string; count: number }> {
  const bots = new Map<string, { botId: string; botName: string; count: number }>();
  for (const item of items) {
    const entry = bots.get(item.botId) ?? { botId: item.botId, botName: item.botName, count: 0 };
    entry.count += 1;
    bots.set(item.botId, entry);
  }
  return [...bots.values()].sort((a, b) => b.count - a.count || a.botName.localeCompare(b.botName));
}

/** The steps the screen shows: the bot's, else the one command the item
 * carries (a server item), else none — then the screen offers to ask. */
export function needsYouSteps(item: NeedsYouItem): NeedsYouStep[] {
  if (item.steps?.length) return item.steps;
  if (item.command) return [{ text: t("needsYou.steps.runCommand"), command: item.command }];
  return [];
}
