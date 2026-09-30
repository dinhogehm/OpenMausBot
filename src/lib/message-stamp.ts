// When a message was sent, in words people read at a glance, in their
// locale and time zone: "hoje 10:16", "ontem 22:47", "29/09 11:16" (the
// year only when it is another one). The sidebar's shorter form drops the
// time for older days ("29/09") and today's word ("10:16").
import { activeLocale, t } from "@/lib/i18n";

const startOfDay = (at: number) => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

function daysAgo(at: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
}

const clock = (at: number) => new Date(at).toLocaleTimeString(activeLocale(), { hour: "2-digit", minute: "2-digit" });

function date(at: number, now: number): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(activeLocale(), { day: "2-digit", month: "2-digit", ...(sameYear ? {} : { year: "numeric" }) });
}

/** The stamp under a message: "hoje 10:16", "ontem 22:47", "29/09 11:16". */
export function messageStamp(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  const days = daysAgo(at, now);
  if (days === 0) return `${t("chat.day.today").toLowerCase()} ${clock(at)}`;
  if (days === 1) return `${t("chat.day.yesterday").toLowerCase()} ${clock(at)}`;
  return `${date(at, now)} ${clock(at)}`;
}

/** The sidebar's stamp: "10:16" today, "ontem 11:16", then just "29/09". */
export function sidebarStamp(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  const days = daysAgo(at, now);
  if (days === 0) return clock(at);
  if (days === 1) return `${t("chat.day.yesterday").toLowerCase()} ${clock(at)}`;
  return date(at, now);
}

/** Full date and time, to the second, for a tooltip. */
export function fullStamp(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  return new Date(at).toLocaleString(activeLocale(), { dateStyle: "full", timeStyle: "medium" });
}

/** Consecutive messages of one author inside the same minute share one stamp. */
export function sharesStamp(
  previous: { role: string; at: number; from?: { botId?: string } } | undefined,
  current: { role: string; at: number; from?: { botId?: string } },
): boolean {
  if (!previous || previous.role !== current.role || previous.from?.botId !== current.from?.botId) return false;
  return Math.floor(previous.at / 60_000) === Math.floor(current.at / 60_000);
}
