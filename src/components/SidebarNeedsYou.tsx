import { CircleAlert, ShieldQuestion } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { waitingAge, type NeedsYouItem } from "@/lib/needs-you";
import { displayThreadTitle } from "@/lib/thread-title";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

/** The top of the sidebar: what waits on the person, from every bot, with
 * how long it has waited — one place to answer from. Absent when nothing
 * waits. Each row jumps to its conversation. */
export function SidebarNeedsYou({ items, density, now, onJump }: {
  items: NeedsYouItem[];
  density: SidebarDensity;
  now?: number;
  onJump: (item: NeedsYouItem) => void;
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
          const label = t("needsYou.item", { title: item.title, name: item.botName, age });
          const Icon = item.approval ? ShieldQuestion : CircleAlert;
          return (
            <li key={`${item.botId}-${item.threadId}`}>
              <button
                type="button"
                data-needs-you-row={item.threadId}
                aria-label={label}
                title={label}
                onClick={() => onJump(item)}
                className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink outline-none hover:bg-raised/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
              >
                <Icon size={13} aria-hidden="true" className="shrink-0 text-warning" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{displayThreadTitle(item.title)}</span>
                  <span className="block truncate text-[10.5px] text-ink-secondary">{item.botName}</span>
                </span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-ink-secondary">{age}</span>
              </button>
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
