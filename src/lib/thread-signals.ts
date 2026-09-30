// What a conversation's row says about the automation working for it: its
// watches (label, last run, failures) and the Claude Code sessions it owns
// that need a look. Red when something is failing or a watcher bot lost its
// standing watch; the tooltip spells it out.
import type { WireCcAlert, WireWatch } from "../../shared/wire";
import { t } from "@/lib/i18n";
import { sidebarStamp } from "@/lib/message-stamp";

export function watchSummary(watches: readonly WireWatch[] | undefined, lost: boolean | undefined, now = Date.now()): { text: string; failing: boolean } | null {
  if (!watches?.length && !lost) return null;
  const lines = (watches ?? []).map((watch) => watch.failures > 0
    ? t("watch.failing", { label: watch.label, count: watch.failures })
    : t("watch.item", { label: watch.label, every: watch.everyMinutes, when: sidebarStamp(watch.lastRunAt, now) }));
  if (lost) lines.push(t("watch.lost"));
  return { text: `${t("watch.indicator")}\n${lines.join("\n")}`, failing: Boolean(lost) || (watches ?? []).some((watch) => watch.failures > 0) };
}

export function ccAlertState(state: WireCcAlert["state"]): string {
  return t(`ccAlert.${state}`);
}

export function ccAlertSummary(alerts: readonly WireCcAlert[] | undefined): { text: string; severe: boolean } | null {
  if (!alerts?.length) return null;
  return {
    text: alerts.map((alert) => t("ccAlert.item", { title: alert.title, state: ccAlertState(alert.state) })).join("\n"),
    severe: alerts.some((alert) => alert.state !== "stalled"),
  };
}
