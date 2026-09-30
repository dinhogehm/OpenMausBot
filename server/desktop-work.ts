// Following and driving the Claude Code sessions that live in the Claude
// desktop app (server/claude-desktop.ts does the screen, this decides when).
//
// followDesktopSessions only READS: the app's session records and the
// transcripts they point to. It finds the session a brief opened, checks a
// typed message really arrived, notices finished (or blocked) turns and
// hands them to the owning bot. runDesktopWork performs at most one screen
// action per call — the oldest one whose backoff has passed — and records
// how it went. watchStalledSessions tells the owner when a session marked
// running shows no sign of work.
//
// Everything outside the ledger comes in through DesktopWorkDeps, so the
// whole flow is testable with a fake app and fake records.
import type { CcDesktopPending, CcSession, CcSessionLedger } from "./cc-sessions.ts";
import { ccReportForOwner, ccStallReport } from "./cc-sessions.ts";
import {
  archiveDesktopSession,
  createDesktopSession,
  recordBlocked,
  recordInWorktree,
  sendToDesktopSession,
  type DesktopDriver,
  type DesktopRecord,
  type DesktopStep,
} from "./claude-desktop.ts";

/** A screen action nobody could perform in this long is given up. */
export const DESKTOP_PENDING_MAX_MS = 12 * 3_600_000;
/** After the brief is sent, the app's record must appear within this. */
export const DESKTOP_RECORD_WAIT_MS = 5 * 60_000;
/** After a message is typed, the session must show it within this... */
export const DESKTOP_SEND_CONFIRM_MS = 3 * 60_000;
/** ...or it is typed again, up to this many times in all. */
export const DESKTOP_SEND_MAX_DELIVERIES = 3;
/** Screens that did not show what was expected (unlocked, Claude in front) before giving up. */
export const DESKTOP_MAX_MISSES = 5;
export const DESKTOP_BACKOFF_BASE_MS = 30_000;
export const DESKTOP_BACKOFF_MAX_MS = 10 * 60_000;
/** After the Archive click, the app's record must say archived within this... */
export const DESKTOP_ARCHIVE_CONFIRM_MS = 2 * 60_000;
/** ...or it is clicked again, up to this many times in all. */
export const DESKTOP_ARCHIVE_MAX_TRIES = 3;
/** A running session with no sign of work for this long is reported. */
export const CC_STALL_MS = 30 * 60_000;
/** A running session counts as "someone else is working on it" only this long after its last progress. */
export const CC_ACTIVE_MS = 45 * 60_000;

export interface DesktopWorkDeps {
  ledger: CcSessionLedger;
  now: () => number;
  getDriver: () => Promise<DesktopDriver>;
  readRecord: (localId: string) => DesktopRecord | null;
  findSession: (marker: string, since: number) => DesktopRecord | null;
  /** The Claude Code transcript of a CLI session id, or null. */
  transcriptOf: (cliSessionId: string) => string | null;
  lastText: (transcript: string) => string;
  mentions: (transcript: string, text: string) => boolean;
  writtenAt: (transcript: string) => number | null;
  repoName: (session: CcSession) => string;
  chip: (session: CcSession, text: string, ok?: boolean) => void;
  /** Hand a report to the owning bot (and the thread the last order came from). */
  report: (session: CcSession, text: string) => void;
  /** The review hook's latest decision for a folder, if known. */
  hookDecision?: (cwd: string) => string | null;
  /** The app confirmed the session archived (remove its worktree if asked). */
  onArchived?: (session: CcSession) => void;
  steps?: {
    create?: typeof createDesktopSession;
    send?: typeof sendToDesktopSession;
    archive?: typeof archiveDesktopSession;
  };
}

/** The brief as typed into the app. Its first line is the title with the
 * issue number ("#9298 …"): the app titles the session from its opening
 * words, and the number is what people look for in the sidebar. The marker
 * that finds the session again goes on its own line below. */
export function desktopBriefText(title: string, marker: string, brief: string, footer = ""): string {
  const number = /#\d{3,6}\b/.test(title) ? null : /(?:#|\/issues\/|\/pull\/)(\d{3,6})\b/.exec(brief)?.[1];
  return `${number ? `#${number} ${title}` : title}\n[${marker}]\n\n${brief}${footer}`;
}

/** Wait before retrying a screen action that touched the screen and stopped. */
export function desktopBackoffMs(attempts: number): number {
  return Math.min(DESKTOP_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), DESKTOP_BACKOFF_MAX_MS);
}

const liveApp = (session: CcSession) =>
  session.surface === "app" && Boolean(session.desktop) && session.status !== "archived" && session.status !== "stopped";

/** The oldest screen action that may run now; one stuck action never blocks the rest. */
export function pickDesktopPending(sessions: CcSession[], now: number): CcSession | null {
  return sessions
    .filter((session) => liveApp(session) && session.desktop!.pending && !session.desktop!.pending!.verifyUntil && (session.desktop!.pending!.nextAttemptAt ?? 0) <= now)
    .sort((a, b) => a.desktop!.pending!.since - b.desktop!.pending!.since)[0] ?? null;
}

/** Someone else is working for this conversation: running, and recently alive. */
export function ccSessionActive(session: CcSession, now: number): boolean {
  return session.status === "running" && now - (session.progressAt ?? session.lastActivityAt) < CC_ACTIVE_MS;
}

export function reportFor(deps: DesktopWorkDeps, session: CcSession): string {
  const cwd = session.cwd;
  return ccReportForOwner(session, { hookDecision: cwd && deps.hookDecision ? deps.hookDecision(cwd) : null });
}

export function failDesktopSession(deps: DesktopWorkDeps, session: CcSession, reason: string): void {
  if (session.desktop) {
    delete session.desktop.pending;
    delete session.desktop.sent;
  }
  session.status = "failed";
  session.lastError = reason;
  deps.ledger.save();
  deps.chip(session, `stopped with a problem — ${reason.slice(0, 100)}`, false);
  deps.report(session, reportFor(deps, session));
}

const actionLabel = (kind: CcDesktopPending["kind"]) =>
  kind === "create" ? "open the session" : kind === "archive" ? "archive the session" : "send the message";

/** The app's record of a session we opened: adopt its ids, mode and folder. */
function adoptRecord(deps: DesktopWorkDeps, session: CcSession, record: DesktopRecord): boolean {
  const desktop = session.desktop!;
  desktop.localId = record.sessionId;
  desktop.cliSessionId = record.cliSessionId;
  if (record.cwd) session.cwd = record.cwd;
  if (record.worktreeName) session.worktree = record.worktreeName;
  if (record.permissionMode) desktop.permissionMode = record.permissionMode;
  session.progressAt = deps.now();
  deps.ledger.save();
  if (!recordInWorktree(record)) {
    failDesktopSession(deps, session, `the session opened outside a git worktree (in ${record.cwd ?? "an unknown folder"}), so it works on the main checkout — check it in the Claude app now and stop it there if needed`);
    return false;
  }
  deps.chip(session, "opened in the Claude app");
  return true;
}

/** Read the app's records: find new sessions, confirm messages arrived, notice finished turns. */
export function followDesktopSessions(deps: DesktopWorkDeps): void {
  const now = deps.now();
  for (const session of deps.ledger.all()) {
    if (!liveApp(session)) continue;
    const desktop = session.desktop!;
    if (!desktop.localId) {
      if (!desktop.sentAt) continue;
      const record = deps.findSession(desktop.marker, desktop.sentAt - 60_000);
      if (record) {
        if (!adoptRecord(deps, session, record)) continue;
      } else {
        if (now - desktop.sentAt > DESKTOP_RECORD_WAIT_MS) {
          delete desktop.sentAt;
          failDesktopSession(deps, session, "the brief was sent, but no matching session appeared in the Claude app within 5 minutes");
        }
        continue;
      }
    }
    const record = deps.readRecord(desktop.localId!);
    if (!record) continue;
    if (record.permissionMode && record.permissionMode !== desktop.permissionMode) {
      desktop.permissionMode = record.permissionMode;
      deps.ledger.save();
    }
    if (record.isArchived) {
      delete desktop.pending;
      deps.ledger.setStatus(session, "archived");
      deps.chip(session, "archived in the Claude app");
      deps.onArchived?.(session);
      continue;
    }
    const verifying = desktop.pending?.kind === "archive" ? desktop.pending : null;
    if (verifying?.verifyUntil && now > verifying.verifyUntil) {
      // Clicked, but the app never said archived: wrong entry, or a menu that changed.
      delete verifying.verifyUntil;
      if ((verifying.archiveTries ?? 0) >= DESKTOP_ARCHIVE_MAX_TRIES) {
        failDesktopSession(deps, session, `Archive was clicked ${verifying.archiveTries} times in the Claude app, but the app never marked the session archived; archive it by hand there`);
        continue;
      }
      deps.ledger.save();
      deps.chip(session, "the app did not confirm the archive; trying again", false);
    }
    const transcript = deps.transcriptOf(record.cliSessionId);
    if (desktop.sent) {
      const sent = desktop.sent;
      const arrived = (record.latestUserFrameAt ?? 0) > sent.userFrameAt || (transcript !== null && deps.mentions(transcript, sent.text));
      if (arrived) {
        delete desktop.sent;
        session.progressAt = now;
        deps.ledger.save();
      } else if (now - sent.at > DESKTOP_SEND_CONFIRM_MS) {
        delete desktop.sent;
        if (sent.deliveries >= DESKTOP_SEND_MAX_DELIVERIES) {
          failDesktopSession(deps, session, `a message was typed into the Claude app ${sent.deliveries} times but never reached the session (its transcript does not show it); it was not delivered: "${sent.text.slice(0, 200)}"`);
          continue;
        }
        desktop.pending = { kind: "send", text: sent.text, since: now, attempts: 0, deliveries: sent.deliveries };
        deps.ledger.save();
        deps.chip(session, `the message did not reach the session; typing it again (${sent.deliveries + 1} of ${DESKTOP_SEND_MAX_DELIVERIES})`, false);
        continue;
      }
    }
    const turns = record.completedTurns ?? 0;
    if (turns > desktop.turnsSeen) {
      desktop.turnsSeen = turns;
      session.turns = turns;
      if (record.cwd) session.cwd = record.cwd;
      const said = transcript ? deps.lastText(transcript) : "";
      session.lastReport = [said, record.prUrl ? `PR: ${record.prUrl}` : ""].filter(Boolean).join("\n\n") || "(no text in its last reply)";
      const blocked = recordBlocked(record);
      if (blocked) session.blockedOn = blocked;
      else delete session.blockedOn;
      session.status = "idle";
      delete session.lastError;
      session.lastActivityAt = now;
      session.progressAt = now;
      const next = desktop.archiveWhenResolved ? null : deps.ledger.takeQueued(session);
      if (next !== null) {
        desktop.pending = { kind: "send", text: next, since: now, attempts: 0 };
        session.status = "running";
        deps.ledger.save();
        deps.chip(session, "your queued message goes in next");
        continue;
      }
      deps.ledger.save();
      deps.chip(session, blocked ? `finished turn ${turns} blocked — needs: ${blocked.slice(0, 80)}` : `finished turn ${turns}`, !blocked);
      deps.report(session, reportFor(deps, session));
    }
    if (desktop.archiveWhenResolved && !desktop.pending && !desktop.sent) {
      delete desktop.archiveWhenResolved;
      desktop.pending = { kind: "archive", text: "", since: now, attempts: 0 };
      deps.ledger.save();
      deps.chip(session, "queued to be archived in the Claude app");
    }
  }
}

/** One screen action, if one is due. `state.busy` keeps them one at a time. */
export async function runDesktopWork(deps: DesktopWorkDeps, state: { busy: boolean }): Promise<void> {
  followDesktopSessions(deps);
  if (state.busy) return;
  const now = deps.now();
  const next = pickDesktopPending(deps.ledger.all(), now);
  if (!next) return;
  const desktop = next.desktop!;
  const pending = desktop.pending!;
  if (now - pending.since > DESKTOP_PENDING_MAX_MS) {
    failDesktopSession(deps, next, `the Mac was never idle and unlocked for long enough in 12 hours to ${actionLabel(pending.kind)} (${pending.lastReason ?? "busy"})`);
    return;
  }
  // A crash between Return and saving leaves a create that may have gone
  // through: look for its session before opening another one.
  if (pending.kind === "create" && pending.triedAt) {
    const record = deps.findSession(desktop.marker, pending.since - 60_000);
    if (record) {
      delete desktop.pending;
      desktop.sentAt = pending.triedAt;
      next.status = "running";
      next.lastActivityAt = now;
      adoptRecord(deps, next, record);
      return;
    }
  }
  if ((pending.kind === "send" || pending.kind === "archive") && !desktop.localId) {
    failDesktopSession(deps, next, "the session never opened in the Claude app, so nothing can be done to it there; start a new one");
    return;
  }
  state.busy = true;
  try {
    let driver: DesktopDriver;
    try {
      driver = await deps.getDriver();
    } catch (error) {
      failDesktopSession(deps, next, `could not prepare the screen helper: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const steps = deps.steps ?? {};
    let userFrameAt = 0;
    let step: DesktopStep;
    if (pending.kind === "create") {
      pending.triedAt = deps.now();
      deps.ledger.save();
      step = await (steps.create ?? createDesktopSession)(driver, { repoName: deps.repoName(next), text: pending.text });
    } else {
      const record = deps.readRecord(desktop.localId!);
      userFrameAt = record?.latestUserFrameAt ?? 0;
      step = pending.kind === "archive"
        ? await (steps.archive ?? archiveDesktopSession)(driver, { localId: desktop.localId!, title: record?.title ?? next.title })
        : await (steps.send ?? sendToDesktopSession)(driver, { localId: desktop.localId!, text: pending.text, title: record?.title ?? next.title });
    }
    const at = deps.now();
    if (step.ok) {
      if (pending.kind === "archive") {
        // Only the app's record says it worked; followDesktopSessions checks it.
        pending.verifyUntil = at + DESKTOP_ARCHIVE_CONFIRM_MS;
        pending.archiveTries = (pending.archiveTries ?? 0) + 1;
        deps.ledger.save();
        return;
      }
      delete desktop.pending;
      if (pending.kind === "create") desktop.sentAt = at;
      else desktop.sent = { text: pending.text, at, userFrameAt, deliveries: (pending.deliveries ?? 0) + 1 };
      next.status = "running";
      next.lastActivityAt = at;
      next.progressAt = at;
      deps.ledger.save();
      deps.chip(next, pending.kind === "create" ? "brief sent in the Claude app" : "message typed in the Claude app (checking that it arrives)");
      return;
    }
    if (!step.retry) {
      failDesktopSession(deps, next, step.reason);
      return;
    }
    if (step.miss) {
      pending.misses = (pending.misses ?? 0) + 1;
      if (pending.misses >= DESKTOP_MAX_MISSES) {
        failDesktopSession(deps, next, `could not ${actionLabel(pending.kind)} after ${pending.misses} tries with the screen unlocked and the Claude app in front: ${step.reason}`);
        return;
      }
    }
    const changed = pending.lastReason !== step.reason;
    pending.lastReason = step.reason;
    if (step.touched) {
      pending.attempts += 1;
      pending.nextAttemptAt = at + desktopBackoffMs(pending.attempts);
    }
    // Waiting for an idle Mac is checked every tick; write only what changed.
    if (step.touched || step.miss || changed) deps.ledger.save();
  } catch (error) {
    pending.attempts += 1;
    pending.nextAttemptAt = deps.now() + desktopBackoffMs(pending.attempts);
    pending.lastReason = error instanceof Error ? error.message.slice(0, 200) : String(error);
    deps.ledger.save();
  } finally {
    state.busy = false;
  }
}

/** Running sessions (app or CLI) with no sign of work for a while: tell the owner, once per stall. */
export function watchStalledSessions(deps: DesktopWorkDeps): void {
  const now = deps.now();
  for (const session of deps.ledger.all()) {
    if (session.status !== "running") continue;
    // Waiting for an idle Mac to open it is not a stall of the session.
    if (session.surface === "app" && (session.desktop?.pending?.kind === "create" || !session.desktop?.localId)) continue;
    let progress = Math.max(session.progressAt ?? 0, session.lastActivityAt);
    const record = session.surface === "app" && session.desktop?.localId ? deps.readRecord(session.desktop.localId) : null;
    if (record?.lastActivityAt) progress = Math.max(progress, record.lastActivityAt);
    const cliSessionId = session.surface === "app" ? session.desktop?.cliSessionId : session.id;
    const transcript = cliSessionId ? deps.transcriptOf(cliSessionId) : null;
    const written = transcript ? deps.writtenAt(transcript) : null;
    if (written) progress = Math.max(progress, written);
    session.progressAt = progress;
    if (now - progress <= CC_STALL_MS || session.stallReportedAt === progress) continue;
    session.stallReportedAt = progress;
    deps.ledger.save();
    const minutes = Math.round((now - progress) / 60_000);
    deps.chip(session, `no progress for ${minutes} min`, false);
    deps.report(session, ccStallReport(session, minutes));
  }
}
