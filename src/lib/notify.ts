import type { Notification } from "../../shared/notification";
import { finishedNotificationsEnabled, notificationSoundsEnabled } from "./notification-preferences";

export type NotifyFrame = Notification;

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId">;

/** Call from the click: browsers may reject a permission request made later from an SSE frame. Resolves to the permission now in force. */
export async function requestNotificationPermission(): Promise<NotificationPermission | null> {
  if (typeof Notification === "undefined") return null;
  try {
    return Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  } catch {
    return Notification.permission;
  }
}

export interface NotificationBotIdentity {
  id: string;
  avatarUrl?: string | null;
}

export function buildNotificationOptions(bot: NotificationBotIdentity): NotificationOptions {
  return { tag: `openmausbot:${bot.id}`, icon: bot.avatarUrl ?? undefined };
}

/** When the server last notified about each conversation ("bot:thread" → ms):
 * "Agora" does not raise a second banner for what the bot's own turn already
 * announced. Kept for this page's life only. */
const serverNotified = new Map<string, number>();

export function recordServerNotification(target: NotificationTarget, at = Date.now()): void {
  serverNotified.set(`${target.botId}:${target.threadId}`, at);
}

/** The server notified about this conversation at or after `since` (a 2 min margin: the turn's
 * notification may land just before the item it opened reaches the screen). */
export function serverNotifiedSince(botId: string, threadId: string, since: number): boolean {
  const at = serverNotified.get(`${botId}:${threadId}`);
  return at !== undefined && at >= since - 2 * 60_000;
}

/** Show one unless the exact destination conversation is already visible.
 * A focused app may still be showing another task (routine runs are detached),
 * so window focus alone is not proof that the actionable card can be seen. */
export function showNotification(
  frame: NotifyFrame,
  onOpen: (target: NotificationTarget) => void,
  avatarUrl?: string | null,
  visibleThreadId?: string | null,
) {
  recordServerNotification({ botId: frame.botId, threadId: frame.threadId });
  if (typeof Notification === "undefined") return;
  if (frame.kind === "done" && !finishedNotificationsEnabled()) return;
  const spend = frame.kind === "spend";
  if (!spend && document.hasFocus() && visibleThreadId === frame.threadId) return;

  const open = () => {
    window.focus();
    onOpen({ botId: frame.botId, threadId: frame.threadId });
  };

  if (Notification.permission === "granted") {
    const options: NotificationOptions = {
      body: frame.body,
      ...buildNotificationOptions({ id: frame.botId, avatarUrl }),
      ...(spend ? { tag: "openmausbot:spend", icon: undefined } : {}),
      ...(notificationSoundsEnabled() ? {} : { silent: true }),
    };
    new Notification(frame.title, options).onclick = open;
  }
}
