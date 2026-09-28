// The bot settings dialog's section rail — one entry per BotSettingsSection,
// in the fixed order the rail renders them. Search filters against label
// plus keywords, the same convention as the app SettingsModal's SECTIONS.
// Labels and keywords come from the catalog, so the rail and its search are
// read in the active language; botSections() is called during render rather
// than frozen at import so a locale switch is picked up.
// "slack" is listed here but shown only when the server offers a link to the
// organisation's Admin (BotSettingsDialog filters it out otherwise), and
// "visibility" only to an admin in a browser (never in the desktop app).
import {
  BookOpen,
  Brain,
  CalendarClock,
  Coins,
  Cpu,
  Eye,
  History,
  LayoutDashboard,
  type LucideIcon,
  Mic,
  Network,
  ShieldCheck,
  Slack,
  Sparkles,
  User,
} from "lucide-react";

import { t } from "@/lib/i18n";
import type { BotSettingsSection } from "@/state/store";

export type BotSectionEntry = {
  id: BotSettingsSection;
  label: string;
  icon: LucideIcon;
  keywords: string[];
};

const SECTION_ICONS: Array<{ id: BotSettingsSection; icon: LucideIcon }> = [
  { id: "overview", icon: LayoutDashboard },
  { id: "identity", icon: User },
  { id: "slack", icon: Slack },
  { id: "soul", icon: Sparkles },
  { id: "skills", icon: BookOpen },
  { id: "memory", icon: Brain },
  { id: "routines", icon: CalendarClock },
  { id: "access", icon: Network },
  { id: "model", icon: Cpu },
  { id: "permissions", icon: ShieldCheck },
  { id: "voice", icon: Mic },
  { id: "visibility", icon: Eye },
  { id: "history", icon: History },
  { id: "usage", icon: Coins },
];

/** Keywords are one catalog string per section so a translator edits a
 * single natural phrase; search splits them back apart on commas. */
function keywords(id: BotSettingsSection): string[] {
  return t(`botSettings.keywords.${id}` as Parameters<typeof t>[0])
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);
}

export function botSections(): BotSectionEntry[] {
  return SECTION_ICONS.map(({ id, icon }) => ({
    id,
    icon,
    label: t(`botSettings.section.${id}` as Parameters<typeof t>[0]),
    keywords: keywords(id),
  }));
}
