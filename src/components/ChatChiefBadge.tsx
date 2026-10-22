import { Crown } from "lucide-react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function chiefOfStaffBadge(bot: Bot) {
  if (!bot.chiefOfStaff) return null;
  // One line, never shrinking with the name (it wrapped "Chief / of /
  // Staff", #1871); folds to the crown like the chips beside it do, so the
  // name keeps the room. While the bot works (or its teammates do) the crown
  // alone stays, so the name keeps first claim on the row (R8-visual N4).
  const crownOnly = bot.busy || bot.waitingForTeammates;
  return (
    <span title={t("chat.chiefOfStaff")} className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent @max-4xl/chathead:px-1.5", crownOnly && "px-1.5")}>
      <Crown size={11} aria-hidden="true" /> <span className={cn("@max-4xl/chathead:sr-only", crownOnly && "sr-only")}>{t("chat.chiefOfStaff")}</span>
    </span>
  );
}
