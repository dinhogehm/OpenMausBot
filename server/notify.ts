import type { Notification, NotifyKind } from "../shared/notification.ts";
import { personMentionExcerpt } from "../shared/person-mention.ts";

export type { Notification, NotifyKind } from "../shared/notification.ts";

/** A model's markdown as the plain text a notification banner can show:
 * no fences, headings, emphasis markers, link syntax, bullets, quotes or
 * table pipes. "#N" and snake_case words stay as they are. */
export function plainNotificationText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^[ \t]*\|/gm, "")
    .replace(/\|[ \t]*$/gm, "")
    .replace(/^[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*$/gm, "")
    .replace(/[ \t]*\|[ \t]*/g, " · ")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "");
}

/** One line, short enough for a lock screen, with the newlines and the
 * markdown of a model's answer flattened out of it. */
export function summarize(text: string, max = 140): string {
  const line = plainNotificationText(text).replace(/\s+/g, " ").replace(/^[\s·]+|[\s·]+$/g, "").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export interface NotifyBot {
  id: string;
  name: string;
  threadId: string;
  notifications?: boolean;
}

export function buildSpendNotification(
  bot: Pick<NotifyBot, "id" | "name">,
  threadId: string,
  text: { title: string; body: string },
): Notification {
  return { kind: "spend", botId: bot.id, botName: bot.name, threadId, title: text.title, body: summarize(text.body, 200) };
}

export function buildNotification(
  kind: NotifyKind,
  bot: NotifyBot,
  threadId: string,
  detail: string,
  extra?: { avatarUrl?: string; group?: { id: string; name: string }; site?: string },
): Notification | null {
  if (bot.notifications === false) return null;

  const body = summarize(detail);
  // A bot working in a room is not "Scout" to whoever reads the banner — it
  // is Scout, in that room. Name the room or the notification reads as if it
  // came from the 1:1 thread it will not open.
  // Titles are read on the lock screen by the owner, in pt-BR like the bots.
  const who = extra?.group ? `${bot.name} em ${extra.group.name}` : bot.name;
  const title =
    kind === "approval"
      ? `${who} precisa de aprovação`
      : kind === "question"
        ? `${who} tem uma pergunta`
        : kind === "sign-in"
          ? `${who} precisa que você entre em ${extra?.site ?? "um site"}`
          : kind === "routine-failed"
            ? `A rotina de ${who} falhou`
            : kind === "routine-deferred"
              ? `A rotina de ${who} está esperando`
            : kind === "turn-failed"
              ? `${who} não conseguiu começar`
              : kind === "incident"
                ? `${who} teve um problema`
                : kind === "delegation-settled"
                  ? `${who} retomou com os resultados`
                  : kind === "mention"
                    ? `${who} mencionou você`
                    : `${who} terminou`;

  if ((kind === "done" || kind === "mention") && !body) return null;

  const notification: Notification = { kind, botId: bot.id, botName: bot.name, threadId, title, body };
  if (extra?.avatarUrl) notification.avatarUrl = extra.avatarUrl;
  if (extra?.group) notification.groupId = extra.group.id;
  return notification;
}

type MentionSource = {
  activePath(threadId: string): readonly { role: string; kind: string; text?: string; turnId?: string; from?: { botId: string } }[];
  bot(id: string): { name: string; hidden?: boolean } | null | undefined;
};

export function buildMentionNotification(
  source: MentionSource,
  bot: Omit<NotifyBot, "threadId"> & { avatarUrl?: string },
  room: { id: string; name: string; dm?: boolean; memberIds: readonly string[] },
  turn: { threadId: string; turnId?: string; reply: string; profileName?: string },
): Notification | null {
  if (room.dm) return null;
  const texts = turn.turnId
    ? source.activePath(turn.threadId).filter((m) => m.role === "bot" && m.kind === "text" && m.turnId === turn.turnId && m.from?.botId === bot.id).map((m) => m.text ?? "")
    : [turn.reply];
  const botNames = room.memberIds.flatMap((id) => {
    const member = source.bot(id);
    return member && !member.hidden ? [member.name] : [];
  });
  for (const text of texts) {
    const excerpt = personMentionExcerpt(text, { profileName: turn.profileName, botNames });
    if (excerpt) return buildNotification("mention", { ...bot, threadId: turn.threadId }, turn.threadId, excerpt, { avatarUrl: bot.avatarUrl, group: room });
  }
  return null;
}
