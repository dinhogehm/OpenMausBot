import { Check, ChevronRight, CircleAlert, Copy, ExternalLink, ListChecks, ListTodo, ShieldQuestion } from "lucide-react";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { dueAt, sortNeedsYou, waitingAge, type NeedsYouItem } from "@/lib/needs-you";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

/** Rows shown in the sidebar before "Ver todos": the rest is one click away, on the resolution screen. */
export const NEEDS_YOU_SIDEBAR_ROWS = 6;

/** The top of the sidebar: what waits on the person, from every bot, with
 * how long it has waited — one place to answer from. Absent when nothing
 * waits. Each row opens the resolution screen on that item; "Ver todos"
 * opens it on the whole list. */
export function SidebarNeedsYou({ items, density, now, onOpen, onResolve, onOpenLink = (url) => void openExternalLink(url), onCopy = (text) => void navigator.clipboard?.writeText(text).catch(() => {}) }: {
  items: NeedsYouItem[];
  density: SidebarDensity;
  now?: number;
  /** Open the resolution screen: on one item, or (null) on the list. */
  onOpen: (item: NeedsYouItem | null) => void;
  /** Mark an owner_pending item done (the bot hears it in that conversation). */
  onResolve?: (item: NeedsYouItem) => void;
  /** Open an owner_pending item's link (a PR, a session in the Claude app). */
  onOpenLink?: (url: string) => void;
  /** Copy an owner_pending item's command (the person runs it; nothing here runs it). */
  onCopy?: (text: string) => void;
}) {
  if (!items.length || density === "icons") return null;
  const compact = density === "compact";
  const clock = now ?? Date.now();
  // the same order as the resolution screen opens in: what falls due first (INSP-I r1 #8)
  const shown = sortNeedsYou(items, "due", clock).slice(0, NEEDS_YOU_SIDEBAR_ROWS);
  return (
    <section
      data-testid="sidebar-needs-you"
      aria-label={t("needsYou.aria", { count: items.length })}
      className={cn("mx-2 overflow-hidden rounded-lg border border-warning/40 bg-warning/5", compact ? "mb-1.5" : "mb-2")}
    >
      <h2 className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11.5px] font-semibold text-warning">
        <CircleAlert size={compact ? 11 : 12} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("needsYou.title")}</span>
        {/* ringed, not tinted: the warning ink on a warning tint drops to 4.2:1 on light skins */}
        <span className="rounded-full border border-warning/40 px-1.5 text-[10.5px] font-semibold tabular-nums" aria-hidden="true">{items.length}</span>
      </h2>
      <ul className="max-h-64 overflow-y-auto pb-0.5">
        {shown.map((item) => {
          const age = waitingAge(item.since, now);
          const at = dueAt(item.due, clock);
          const overdue = at !== null && at < clock;
          const label = [t("needsYou.item", { title: item.title, name: item.botName, age }), item.due ? t("needsYou.due", { due: item.due }) : ""].filter(Boolean).join(" · ");
          const Icon = item.approval ? ShieldQuestion : item.options?.length ? ListChecks : item.pendingId ? ListTodo : CircleAlert;
          const copy = Boolean(item.pendingId && item.command && !item.steps?.length);
          const link = Boolean(item.pendingId && item.link);
          const resolve = Boolean(item.pendingId && onResolve);
          const actions = Number(copy) + Number(link) + Number(resolve);
          return (
            <li key={`${item.botId}-${item.threadId}-${item.pendingId ?? ""}`} className="relative">
              <button
                type="button"
                data-needs-you-row={item.threadId}
                aria-label={t("needsYou.openItem", { label })}
                title={label}
                onClick={() => onOpen(item)}
                className="flex w-full min-w-0 items-start gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink outline-none hover:bg-raised/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
              >
                <Icon size={13} aria-hidden="true" className="mt-px shrink-0 text-warning" />
                <span className="min-w-0 flex-1">
                  {/* the title has the row's whole width, in up to two lines (no "block": it
                      would undo line-clamp's -webkit-box — INSP-I r1 #7) */}
                  <span className="line-clamp-2 break-words leading-snug">{item.title}</span>
                  {/* who and when on the second line; the row's buttons sit at its end */}
                  <span className="flex min-w-0 items-center gap-1 text-[10.5px] text-ink-secondary" style={{ paddingRight: actions * 24 }}>
                    <span className="min-w-0 truncate">{item.botName}</span>
                    <span aria-hidden="true">·</span>
                    <span className={cn("shrink-0 tabular-nums", overdue && "font-semibold text-danger")}>{item.due ?? age}</span>
                  </span>
                </span>
              </button>
              {actions > 0 && <span className="absolute bottom-1 right-1.5 flex items-center">
              {copy && (
                <button
                  type="button"
                  data-needs-you-copy={item.command}
                  aria-label={t("needsYou.copy", { command: item.command! })}
                  title={t("needsYou.copy", { command: item.command! })}
                  onClick={() => onCopy(item.command!)}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <Copy size={12} aria-hidden="true" />
                </button>
              )}
              {link && (
                <button
                  type="button"
                  data-needs-you-link={item.link}
                  aria-label={t("needsYou.openLink", { title: item.title })}
                  title={item.link}
                  onClick={() => onOpenLink(item.link!)}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <ExternalLink size={12} aria-hidden="true" />
                </button>
              )}
              {resolve && (
                <button
                  type="button"
                  aria-label={t("needsYou.resolve", { title: item.title })}
                  title={t("needsYou.resolve", { title: item.title })}
                  onClick={() => onResolve!(item)}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <Check size={12} aria-hidden="true" />
                </button>
              )}
              </span>}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        data-needs-you-all=""
        onClick={() => onOpen(null)}
        className="flex w-full items-center gap-1 border-t border-warning/20 px-2.5 py-1.5 text-left text-[11.5px] font-medium text-warning outline-none hover:bg-warning/10 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
      >
        <span className="min-w-0 flex-1 truncate">{items.length === 1 ? t("needsYou.seeAllOne") : t("needsYou.seeAll", { count: items.length })}</span>
        <ChevronRight size={13} aria-hidden="true" className="shrink-0" />
      </button>
    </section>
  );
}
