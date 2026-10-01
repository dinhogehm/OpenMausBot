import { Check, CircleAlert, ExternalLink, ListTodo, ShieldQuestion } from "lucide-react";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { waitingAge, type NeedsYouItem } from "@/lib/needs-you";
import { displayThreadTitle } from "@/lib/thread-title";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

/** The top of the sidebar: what waits on the person, from every bot, with
 * how long it has waited — one place to answer from. Absent when nothing
 * waits. Each row jumps to its conversation. */
export function SidebarNeedsYou({ items, density, now, onJump, onResolve, onOpenLink = (url) => void openExternalLink(url) }: {
  items: NeedsYouItem[];
  density: SidebarDensity;
  now?: number;
  onJump: (item: NeedsYouItem) => void;
  /** Mark an owner_pending item done (the bot hears it in that conversation). */
  onResolve?: (item: NeedsYouItem) => void;
  /** Open an owner_pending item's link (a PR, a session in the Claude app). */
  onOpenLink?: (url: string) => void;
}) {
  if (!items.length || density === "icons") return null;
  const compact = density === "compact";
  const shown = items.slice(0, 6);
  return (
    <section
      data-testid="sidebar-needs-you"
      aria-label={t("needsYou.aria", { count: items.length })}
      className={cn("mx-2 overflow-hidden rounded-lg border border-warning/40 bg-warning/5", compact ? "mb-1.5" : "mb-2")}
    >
      <h2 className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11.5px] font-semibold text-warning">
        <CircleAlert size={compact ? 11 : 12} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("needsYou.title")}</span>
        <span className="rounded-full bg-warning/15 px-1.5 text-[10.5px] font-medium tabular-nums" aria-hidden="true">{items.length}</span>
      </h2>
      <ul className="max-h-56 overflow-y-auto pb-1">
        {shown.map((item) => {
          const age = waitingAge(item.since, now);
          const label = [t("needsYou.item", { title: item.title, name: item.botName, age }), item.due ? t("needsYou.due", { due: item.due }) : "", item.link ?? ""].filter(Boolean).join(" · ");
          const Icon = item.approval ? ShieldQuestion : item.pendingId ? ListTodo : CircleAlert;
          return (
            <li key={`${item.botId}-${item.threadId}-${item.pendingId ?? ""}`} className="flex items-center">
              <button
                type="button"
                data-needs-you-row={item.threadId}
                aria-label={label}
                title={label}
                onClick={() => onJump(item)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink outline-none hover:bg-raised/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
              >
                <Icon size={13} aria-hidden="true" className="shrink-0 text-warning" />
                <span className="min-w-0 flex-1">
                  {/* an owner_pending title says what to do: two lines, not cut before the essential */}
                  <span className={cn("block", item.pendingId ? "line-clamp-2 break-words" : "truncate")}>{item.pendingId ? item.title : displayThreadTitle(item.title)}</span>
                  <span className="block truncate text-[10.5px] text-ink-secondary">{item.botName}</span>
                </span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-ink-secondary">{item.due ?? age}</span>
              </button>
              {item.pendingId && item.link && (
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
              {item.pendingId && onResolve && (
                <button
                  type="button"
                  aria-label={t("needsYou.resolve", { title: item.title })}
                  title={t("needsYou.resolve", { title: item.title })}
                  onClick={() => onResolve(item)}
                  className="mr-1.5 flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <Check size={12} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > shown.length && (
        <p className="px-2.5 pb-1.5 text-[10.5px] text-ink-secondary">{t("needsYou.more", { count: items.length - shown.length })}</p>
      )}
    </section>
  );
}
