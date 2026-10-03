// What a conversation's row says about the automation working for it: its
// watches (label, last run, failures) and the Claude Code sessions it owns
// that need a look. Red when something is failing or a watcher bot lost its
// standing watch; the tooltip spells it out.
import type { WireCcAlert, WireCcSession, WireWatch } from "../../shared/wire";
import { t } from "@/lib/i18n";
import { sidebarStamp } from "@/lib/message-stamp";
import { sessionErrorPt } from "../../shared/session-error-pt";

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
    // a failure says why, in the reader's words when it is a known one
    text: alerts.map((alert) => `${t("ccAlert.item", { title: alert.title, state: ccAlertState(alert.state) })}${alert.state === "failed" && alert.detail ? `: ${sessionErrorPt(alert.detail)}` : ""}`).join("\n"),
    severe: alerts.some((alert) => alert.state !== "stalled"),
  };
}

/** The conversation's Claude Code sessions, each with where it runs: a CLI
 * one is said to be out of the Claude app, so the person knows to follow it
 * here (R8-visual N2). `cli` when any of them is headless. */
export function ccSessionsSummary(sessions: readonly WireCcSession[] | undefined, now = Date.now()): { text: string; cli: boolean; waiting: { count: number; text: string } | null; resume: { count: number; text: string } | null } | null {
  if (!sessions?.length) return null;
  const waiting = sessions.filter((session) => session.screenWait);
  const resume = sessions.filter((session) => session.resume);
  return {
    text: [t("ccSession.indicator"), ...sessions.map((session) => t(session.surface === "cli" ? "ccSession.cliItem" : "ccSession.appItem", { title: session.title, status: t(`ccSession.status.${session.status}`) }))].join("\n"),
    cli: sessions.some((session) => session.surface === "cli"),
    // R8-dispatch D6: screen steps waiting for the Mac — what, since when, what holds them
    waiting: waiting.length ? {
      count: waiting.length,
      text: [
        waiting.length === 1 ? t("ccSession.waitingOne") : t("ccSession.waitingMany", { count: waiting.length }),
        ...waiting.map((session) => t("ccSession.wait.item", {
          title: session.title,
          action: t(`ccSession.wait.action.${session.screenWait!.kind}`),
          when: sidebarStamp(session.screenWait!.since, now),
          why: t(`ccSession.wait.why.${session.screenWait!.waitingFor}`),
        })),
      ].join("\n"),
    } : null,
    // S-retomar: failed or idle 2 h+ holding an open PR of its own
    resume: resume.length ? {
      count: resume.length,
      text: [
        resume.length === 1 ? t("ccSession.resumeOne") : t("ccSession.resumeMany", { count: resume.length }),
        ...resume.map((session) => t("ccSession.resume.item", {
          title: session.title,
          why: session.resume!.why,
          prs: session.resume!.prs.map((number) => `PR #${number}`).join(", "),
          when: sidebarStamp(session.resume!.since, now),
        })),
      ].join("\n"),
    } : null,
  };
}

type SignalTask = { watches?: readonly WireWatch[]; watchesLost?: boolean; ccAlerts?: readonly WireCcAlert[]; ccSessions?: readonly WireCcSession[]; routineRunId?: string };

/** The same two signals for a whole bot, across its conversations: what its
 * row shows while its thread list is folded away. */
export function botSignals(tasks: readonly SignalTask[] | undefined, now = Date.now()): { watch: ReturnType<typeof watchSummary>; cc: ReturnType<typeof ccAlertSummary>; sessions: ReturnType<typeof ccSessionsSummary> } {
  const own = (tasks ?? []).filter((task) => !task.routineRunId);
  return {
    watch: watchSummary(own.flatMap((task) => task.watches ?? []), own.some((task) => task.watchesLost === true), now),
    cc: ccAlertSummary(own.flatMap((task) => task.ccAlerts ?? [])),
    sessions: ccSessionsSummary(own.flatMap((task) => task.ccSessions ?? []), now),
  };
}

/** A conversation whose automation needs a look: a failing or lost watch, a
 * Claude Code session in trouble. Kept reachable when its tree is folded. */
export function needsSignalLook(task: SignalTask): boolean {
  // a headless session is followed here, nowhere else: keep its conversation reachable
  // …and one to resume, or a step waiting for the person to leave the Mac alone
  return Boolean(task.watchesLost || task.watches?.some((watch) => watch.failures > 0) || task.ccAlerts?.length
    || task.ccSessions?.some((session) => session.surface === "cli" || session.resume || session.screenWait));
}
