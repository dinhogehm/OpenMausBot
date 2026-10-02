// Claude Code sessions a bot manages: it opens one per piece of work, the
// session does the work in its own git worktree, and the bot answers it,
// steers it, and archives it when the work has shipped. The bot is the
// manager; the session is the one that writes code.
//
// Each turn is one headless `claude -p` run: the first creates the session
// (--session-id, -w <worktree>), later ones continue it (--resume, from the
// worktree the first run reported). When a run exits, its final report is
// handed to the owning bot's conversation, so the bot is woken by the event
// instead of polling. State is persisted so a restart neither forgets a
// session nor loses a reply queued while it was running.
//
// This file is state, argv and stream parsing only. server/index.ts owns the
// processes, the routes and the wake-ups.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import type { BgJob } from "./bg-jobs.ts";
import type { CcDelivery } from "./prod-delivery.ts";

export const CC_TITLE_MAX = 120;
export const CC_BRIEF_MAX = 20_000;
export const CC_MESSAGE_MAX = 20_000;
export const CC_REPORT_MAX = 6_000;
/** Sessions running at once, across all bots. Each is a full agent. */
export const CC_MAX_RUNNING = 4;
/** One turn may not run longer than this before it is stopped. */
export const CC_TURN_TIMEOUT_MS = 90 * 60_000;
export const CC_PERMISSION_MODES = ["auto", "acceptEdits", "default", "plan"] as const;
export type CcPermissionMode = (typeof CC_PERMISSION_MODES)[number];

/** "stalled": was running, showed no progress past the watchdog's limit and
 * was reported. It no longer holds the Mac awake or its thread; any sign of
 * work puts it back to "running". */
export type CcStatus = "running" | "stalled" | "idle" | "failed" | "stopped" | "archived";

export interface CcSession {
  id: string;
  ownerBotId: string;
  ownerThreadId: string;
  title: string;
  repo: string;
  worktree: string;
  /** Where the session lives; known once the first run reports it. */
  cwd?: string;
  model?: string;
  permissionMode: CcPermissionMode;
  status: CcStatus;
  createdAt: number;
  lastActivityAt: number;
  turns: number;
  costUsd: number;
  lastReport?: string;
  lastError?: string;
  /** The repository corridor this session was last given (hash), so a
   * send that ships work carries it once, and again only when it changes. */
  corridorVersion?: string;
  /** Messages sent while a turn was running; each becomes the next turn,
   * unless it waited so long it may no longer hold (see takeQueued). */
  queued: CcQueued[];
  /** Queued messages held back for being too old; the owner must resend. */
  heldQueue?: CcQueued[];
  archivedAt?: number;
  /** "app": the session lives in the Claude desktop app, driven through its
   * screen (server/claude-desktop.ts); "cli" (default for older records):
   * headless `claude -p` turns. */
  surface?: CcSurface;
  desktop?: CcDesktopState;
  /** Where the last order came from (a thread of the owning bot); its
   * reports go there too, besides the owning conversation. */
  replyThreadId?: string;
  /** Last sign of work (record, transcript, turn); the watchdog's clock. */
  progressAt?: number;
  /** progressAt of the stall already reported, so each stall is told once. */
  stallReportedAt?: number;
  /** When the owner was last told about this stall, and how many times. */
  stallNotifiedAt?: number;
  stallReports?: number;
  /** What the session said it needs when its last turn ended blocked. */
  blockedOn?: string;
  /** CLI: the `claude` of its running turn (pid and `ps -o lstart`), so a
   * restart can tell whether that process survived (R9-resilience RS-PID). */
  proc?: CcProc;
  /** CLI: its turn's claude survived a server restart; the server follows
   * it (alive, transcript) until it ends, instead of marking it failed. */
  survivedRestartAt?: number;
  /** Its turn was cut off by a restart that its claude did not survive. */
  interruptedAt?: number;
  /** CLI: processes its last turn left running in its worktree; the server
   * resumes it when they are gone. */
  bgJob?: BgJob;
  /** Its running turn is the resumption after a turn cut at the time limit:
   * if this one is cut too, the server does not resume it again. */
  resumedAfterCut?: true;
  /** Its local CI was stopped so a production release could run: resume
   * it once the production tag moves past `fromSha`. */
  resumeAfterTag?: { fromSha: string | null; at: number; message: string };
  /** When the owner was last told it sits idle with a PR still open. */
  idleReportedAt?: number;
  /** Its issue was checked for being a P1 left with no live session. */
  orphanCheckedAt?: number;
  /** When it failed, and when the owner was told it stayed failed a day. */
  failedAt?: number;
  failedAgingReportedAt?: number;
  /** Archived in the Claude app by someone, not through cc_session_archive. */
  archivedOutsideAt?: number;
  /** Archived in the app by the person after it failed: expected (no "por
   * fora"), but its PRs are still checked, since nobody else did. */
  archivedAfterFailure?: boolean;
  /** Its PRs were checked after that (left without a session, or not). */
  archivedOutsideCheckedAt?: number;
  /** Checks that could not reach GitHub, and when the last one was tried. */
  archivedOutsideTries?: number;
  archivedOutsideTriedAt?: number;
  /** Its PRs on the way to production (server/prod-delivery.ts). */
  delivery?: CcDelivery;
  /** PRs it was told to take over ("assuma a PR #9328"): its own, though
   * their branch is not its worktree's (prod-delivery.ts claimedPrNumbers). */
  claimedPrs?: number[];
  /** The orders it was given before claimedPrs existed were read back (once). */
  claimsReadAt?: number;
}

export type CcSurface = "app" | "cli";

/** A process as `ps` knows it: the pid, and its start time (`ps -o lstart=`),
 * so a pid reused by another program is never taken for it. */
export interface CcProc { pid: number; lstart: string }

/** `ps` by its path (the server's PATH may be bare) in the C locale, so a
 * start time read now compares with one read at spawn. */
export const PS_BIN = "/bin/ps";
export const PS_ENV = { LC_ALL: "C", LANG: "C" };
const sameStart = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** A process's start time (`ps -o lstart=`), or null when there is no such process. */
export function processStartSync(pid: number): string | null {
  try {
    return execFileSync(PS_BIN, ["-o", "lstart=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, env: { ...process.env, ...PS_ENV } }).toString().trim() || null;
  } catch {
    return null; // no such process
  }
}

/** Whether `proc` is still the same running process: its pid exists and
 * started at the same time. Synchronous (the ledger loads synchronously). */
export function ccProcAlive(proc: CcProc): boolean {
  if (!Number.isInteger(proc.pid) || proc.pid <= 1 || !proc.lstart) return false;
  const start = processStartSync(proc.pid);
  return start !== null && sameStart(start, proc.lstart);
}

/** A message waiting for a session's turn to end, and when it was queued. */
export interface CcQueued { text: string; at: number }

/** A queued message older than this is not delivered on its own: the state
 * it was written for may have changed (a policy, a branch, a GO). */
export const CC_QUEUE_MAX_AGE_MS = 2 * 3_600_000;

/** A running session counts as "someone is working on it" only this long after its last progress. */
export const CC_ACTIVE_MS = 45 * 60_000;

/** Someone is working for this conversation: running, and recently alive. A
 * session marked running but silent past this holds no slot, no thread and
 * does not keep the Mac awake. */
export function ccSessionActive(session: Pick<CcSession, "status" | "progressAt" | "lastActivityAt">, now: number): boolean {
  return session.status === "running" && now - (session.progressAt ?? session.lastActivityAt) < CC_ACTIVE_MS;
}

export interface CcDesktopState {
  /** Written at the top of the brief; finds the session among the app's records. */
  marker: string;
  /** The app's session id (local_…) and the Claude Code session it points to. */
  localId?: string;
  cliSessionId?: string;
  /** completedTurns already reported to the owner. */
  turnsSeen: number;
  /** When the brief was sent; the app's record must appear after this. */
  sentAt?: number;
  /** A screen action waiting for the Mac to be idle. */
  pending?: CcDesktopPending;
  /** A message typed into the session, not yet seen arriving in it. */
  sent?: { text: string; at: number; userFrameAt: number; deliveries: number };
  /** Archive once the session has opened and nothing is waiting to go in. */
  archiveWhenResolved?: boolean;
  /** The server could not archive it on the screen and asked the person to
   * archive it by hand: their archiving is the expected end, not something
   * done behind the server's back. (A failed session, which the owner was
   * told to see to in the app, counts the same while it is failed.) */
  archiveHandedOver?: boolean;
  /** The permission mode the app really runs it in (read from its record). */
  permissionMode?: string;
  /** Once the app confirms it archived, report whether its own worktree may be removed (remove_worktree); the server never removes it. */
  removeWorktree?: boolean;
  /** The issue number the session is about ("9311"), from its title or brief. */
  issue?: string;
  /** A rename to "NNNN …" was already tried (it is tried once). */
  renameTried?: boolean;
  /** The person was asked (owner_pending) to rename it by hand: resolved once the app's title opens with "NNNN", or on archive. */
  renameAsked?: boolean;
  /** tool_use id of the open question already reported to the owner. */
  questionReported?: string;
  /** Its folder was found missing (reported once). */
  cwdGone?: boolean;
  /** Our latest message typed into the app, and whether its transcript showed it. */
  lastSend?: { at: number; confirmed: boolean };
  /** Text found in the session's field and left alone (maybe the person's draft). */
  draftSeen?: { text: string; at: number; leftProbe?: boolean };
  /** A finished turn whose app summary was still the previous turn's: wait a little for it. */
  turnWaitSince?: number;
}

export interface CcDesktopPending {
  kind: "create" | "send" | "archive" | "rename";
  text: string;
  since: number;
  /** Tries that touched the screen and had to stop. */
  attempts: number;
  lastReason?: string;
  /** Not before this (backoff after a try that touched the screen). */
  nextAttemptAt?: number;
  /** Tries where the screen, unlocked and with Claude in front, did not show what was expected. */
  misses?: number;
  /** A try began (the screen may have been changed); a crash after Return leaves this behind. */
  triedAt?: number;
  /** send: how many times this message was already typed without arriving. */
  deliveries?: number;
  /** Failed tries to prepare the screen helper. */
  helperFailures?: number;
  /** archive: clicked; the app's record must say archived by then. */
  verifyUntil?: number;
  /** archive: clicks that the app's record did not confirm. */
  archiveTries?: number;
}

export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "sessao";
}

/** argv for one turn. The brief/message always goes last, after "--", so a
 * text starting with "-" can never be read as a flag. */
export function ccTurnArgs(session: Pick<CcSession, "id" | "worktree" | "model" | "permissionMode">, prompt: string, first: boolean): string[] {
  return [
    "-p",
    ...(first ? ["--session-id", session.id, "-w", session.worktree] : ["--resume", session.id]),
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", session.permissionMode,
    ...(session.model ? ["--model", session.model] : []),
    "--",
    prompt,
  ];
}

export interface CcTurnOutcome {
  ok: boolean;
  cwd?: string;
  report: string;
  costUsd: number;
  error?: string;
}

/** Fold a run's stream-json lines into what the manager needs. A run that
 * printed no result line (crash, kill, timeout) is a failure. */
export function parseCcStream(lines: string[], exit: { code: number | null; signal?: string | null; timedOut?: boolean }): CcTurnOutcome {
  let cwd: string | undefined;
  let result: Record<string, unknown> | null = null;
  const stray: string[] = [];
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (line.trim()) stray.push(line.trim());
      continue;
    }
    if (event.type === "system" && event.subtype === "init" && typeof event.cwd === "string") cwd = event.cwd;
    if (event.type === "result") result = event;
  }
  if (!result) {
    const why = exit.timedOut
      ? `the turn ran past ${Math.round(CC_TURN_TIMEOUT_MS / 60_000)} minutes and was stopped`
      : exit.signal
        ? `the run was stopped (${exit.signal})`
        : `the run exited with code ${exit.code} before reporting`;
    return { ok: false, ...(cwd ? { cwd } : {}), report: "", costUsd: 0, error: [why, ...stray.slice(-5)].join("\n").slice(0, 2_000) };
  }
  const report = typeof result.result === "string" ? result.result : "";
  const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
  const failed = result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success");
  return {
    ok: !failed,
    ...(cwd ? { cwd } : {}),
    report: report.slice(0, CC_REPORT_MAX),
    costUsd,
    ...(failed ? { error: `${String(result.subtype ?? "error")}${report ? `: ${report.slice(0, 500)}` : ""}` } : {}),
  };
}

export type CcStartInput =
  | { ok: true; title: string; brief: string; repo: string; permissionMode: CcPermissionMode; model?: string }
  | { ok: false; error: string };

export function parseCcStartInput(
  body: { title?: unknown; brief?: unknown; repo?: unknown; permissionMode?: unknown; model?: unknown },
  isGitRepo: (path: string) => boolean,
): CcStartInput {
  const title = typeof body.title === "string" ? issueTitle(body.title.trim().slice(0, CC_TITLE_MAX)) : "";
  if (!title) return { ok: false, error: "title is required: a short name for the work (e.g. the issue)" };
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (!brief) return { ok: false, error: "brief is required: the complete task for the session" };
  if (brief.length > CC_BRIEF_MAX) return { ok: false, error: `brief is longer than ${CC_BRIEF_MAX} characters` };
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (!repo.startsWith("/")) return { ok: false, error: "repo must be the absolute path of a git repository" };
  if (!isGitRepo(repo)) return { ok: false, error: `${repo} is not a git repository on this computer` };
  const permissionMode = body.permissionMode === undefined ? "auto" : body.permissionMode;
  if (!CC_PERMISSION_MODES.includes(permissionMode as CcPermissionMode)) {
    return { ok: false, error: `permission_mode must be one of ${CC_PERMISSION_MODES.join(", ")}` };
  }
  const model = typeof body.model === "string" && /^[\w.:-]{1,80}$/.test(body.model.trim()) ? body.model.trim() : undefined;
  return { ok: true, title, brief, repo, permissionMode: permissionMode as CcPermissionMode, ...(model ? { model } : {}) };
}

export class CcSessionLedger {
  private sessions = new Map<string, CcSession>();
  /** Sessions whose turn was cut off by a restart; their owners must hear it. */
  readonly interruptedOnLoad: CcSession[] = [];
  /** Sessions whose turn's claude survived the restart: followed, not failed. */
  readonly survivedOnLoad: CcSession[] = [];
  private readonly path: string | null;
  private readonly now: () => number;
  private readonly procAlive: (proc: CcProc) => boolean;

  // plain field assignments, not parameter properties — the server runs
  // under Node's type-stripping, which cannot transform the latter
  constructor(opts: { path: string | null; now?: () => number; procAlive?: (proc: CcProc) => boolean }) {
    this.path = opts.path;
    this.now = opts.now ?? Date.now;
    this.procAlive = opts.procAlive ?? (() => false);
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { sessions?: CcSession[] };
      for (const session of raw.sessions ?? []) {
        if (!session || typeof session.id !== "string") continue;
        // A turn running when the server stopped: its claude runs in a group
        // of its own and may have outlived the server (an app quit, not a
        // shutdown). Alive and the same process: followed until it ends.
        // Gone: the turn was lost — interrupted, and its owner hears it.
        if ((session.status === "running" || session.status === "stalled") && session.surface !== "app") {
          if (session.proc && this.procAlive(session.proc)) {
            session.survivedRestartAt = this.now();
            this.survivedOnLoad.push(session);
          } else {
            session.status = "failed";
            session.failedAt = this.now();
            session.interruptedAt = this.now();
            session.lastError = `interrupted: the server restarted (the computer was shut down or the app quit) while this turn was running${session.proc ? `, and its claude (PID ${session.proc.pid}) did not survive` : ""}; resume it with cc_session_send`;
            delete session.proc;
            delete session.survivedRestartAt;
            this.interruptedOnLoad.push(session);
          }
        }
        // Reported as stalled before the "stalled" status existed, and no
        // progress since: it is stalled, already told once.
        if (session.status === "running" && session.stallReportedAt !== undefined && session.stallReportedAt === session.progressAt) {
          session.status = "stalled";
          session.stallReports = session.stallReports ?? 1;
          session.stallNotifiedAt = session.stallNotifiedAt ?? this.now();
        }
        // Archived before archiving cleared it: an old error only misleads.
        if (session.status === "archived") delete session.lastError;
        // Older ledgers queued bare strings, with no age: treat them as old.
        session.queued = Array.isArray(session.queued)
          ? (session.queued as unknown[]).map((item) => (typeof item === "string" ? { text: item, at: 0 } : item as CcQueued)).filter((item) => item && typeof item.text === "string")
          : [];
        this.sessions.set(session.id, session);
      }
    } catch (error) {
      console.error(`[cc-sessions] ignoring unreadable ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  save(): void {
    if (!this.path) return;
    writeFileAtomic(this.path, `${JSON.stringify({ sessions: [...this.sessions.values()] }, null, 2)}\n`, { mode: 0o600 });
  }

  create(input: { id: string; ownerBotId: string; ownerThreadId: string; title: string; repo: string; permissionMode: CcPermissionMode; model?: string; surface?: CcSurface; desktop?: CcDesktopState }): CcSession {
    const at = this.now();
    const session: CcSession = {
      ...input,
      worktree: `${slugify(input.title)}-${input.id.slice(0, 6)}`,
      status: "idle",
      createdAt: at,
      lastActivityAt: at,
      turns: 0,
      costUsd: 0,
      queued: [],
    };
    this.sessions.set(session.id, session);
    this.save();
    return session;
  }

  get(id: string): CcSession | null {
    return this.sessions.get(id) ?? null;
  }

  /** A bot sees and steers only the sessions it opened. */
  owned(botId: string, includeArchived = false): CcSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.ownerBotId === botId && (includeArchived || session.status !== "archived"))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  all(): CcSession[] {
    return [...this.sessions.values()];
  }

  /** Sessions actively running (a silent one does not hold one of the slots). */
  runningCount(now = this.now()): number {
    return [...this.sessions.values()].filter((session) => ccSessionActive(session, now)).length;
  }

  /** Slots held, for deciding whether another session may start: the ones
   * at work, and every app session still on its way in or with a message on
   * its way — a create or a send waiting for the Mac, a brief typed but not
   * yet adopted, a message typed but not yet seen arriving. Those make no
   * progress while the Mac is locked, so the 45 min of ccSessionActive would
   * free their slot and let the start queue open more (INSP-F F3-b). */
  slotsTaken(now = this.now()): number {
    return [...this.sessions.values()].filter((session) => ccSessionActive(session, now) || (
      session.status === "running" && session.surface === "app" && Boolean(session.desktop)
      && (!session.desktop!.localId || session.desktop!.pending?.kind === "create" || session.desktop!.pending?.kind === "send" || Boolean(session.desktop!.sent))
    )).length;
  }

  markRunning(session: CcSession): void {
    session.status = "running";
    session.turns += 1;
    session.lastActivityAt = this.now();
    session.progressAt = session.lastActivityAt;
    delete session.lastError;
    delete session.blockedOn;
    delete session.proc;
    delete session.survivedRestartAt;
    delete session.interruptedAt;
    this.save();
  }

  /** The claude of its running turn, once `ps` told its start time. */
  setProc(session: CcSession, proc: CcProc): void {
    session.proc = { pid: proc.pid, lstart: proc.lstart.trim() };
    this.save();
  }

  finishTurn(session: CcSession, outcome: CcTurnOutcome): void {
    delete session.proc;
    delete session.survivedRestartAt;
    if (outcome.cwd) session.cwd = outcome.cwd;
    session.costUsd = Math.round((session.costUsd + outcome.costUsd) * 10_000) / 10_000;
    session.lastActivityAt = this.now();
    session.progressAt = session.lastActivityAt;
    if (session.status === "stopped" || session.status === "archived") {
      this.save();
      return;
    }
    session.status = outcome.ok ? "idle" : "failed";
    if (outcome.ok) {
      delete session.failedAt;
      delete session.failedAgingReportedAt;
    } else session.failedAt = this.now();
    if (outcome.report) session.lastReport = outcome.report;
    if (outcome.error) session.lastError = outcome.error;
    else delete session.lastError;
    this.save();
  }

  enqueue(session: CcSession, message: string): number {
    session.queued.push({ text: message, at: this.now() });
    this.save();
    return session.queued.length;
  }

  /** The next queued message to deliver. Messages older than
   * CC_QUEUE_MAX_AGE_MS are not delivered: they move to heldQueue, and the
   * caller tells the owner (`held`) to confirm or resend them. */
  takeQueued(session: CcSession): { next: string | null; held: CcQueued[] } {
    const now = this.now();
    const held: CcQueued[] = [];
    while (session.queued.length && now - session.queued[0]!.at > CC_QUEUE_MAX_AGE_MS) held.push(session.queued.shift()!);
    if (held.length) session.heldQueue = [...(session.heldQueue ?? []), ...held];
    const next = session.queued.shift()?.text ?? null;
    if (next !== null || held.length) this.save();
    return { next, held };
  }

  setStatus(session: CcSession, status: "stopped" | "archived"): void {
    session.status = status;
    session.queued = [];
    session.lastActivityAt = this.now();
    // a claude followed after a restart is no longer followed (the caller stopped it)
    delete session.survivedRestartAt;
    delete session.proc;
    if (status === "archived") {
      session.archivedAt = this.now();
      // an archived session has nothing left to fix: an old error only misleads
      delete session.lastError;
      delete session.bgJob;
    }
    this.save();
  }
}

export function ccSessionLine(session: CcSession, app: { blocked?: string | null } = {}): string {
  const bits = [
    `${session.id} · "${session.title}" · ${session.status}${session.surface === "app" ? " · in the Claude app" : ""}`,
    `turns ${session.turns}, US$ ${session.costUsd.toFixed(2)}`,
    session.cwd ? `worktree ${session.cwd}` : session.surface === "app" ? "worktree chosen by the app (pending)" : `worktree ${session.repo}/.claude/worktrees/${session.worktree} (pending)`,
    ...(session.desktop?.pending ? [`waiting for an idle Mac to ${session.desktop.pending.kind === "create" ? "open it" : session.desktop.pending.kind === "archive" ? "archive it" : session.desktop.pending.kind === "rename" ? "rename it" : "send a message"}${session.desktop.pending.lastReason ? ` (${session.desktop.pending.lastReason})` : ""}`] : []),
    ...(session.desktop?.sent ? ["message typed in the app, checking that it arrived"] : []),
    ...(!session.desktop?.sent && session.desktop?.lastSend && !session.desktop.lastSend.confirmed ? [`last message did NOT arrive (${new Date(session.desktop.lastSend.at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })})`] : []),
    ...(session.surface !== "app" ? ["CLI: not visible in the Claude app"] : []),
    ...(session.blockedOn ? [`BLOCKED — needs: ${session.blockedOn.slice(0, 200)}`] : []),
    // the app's own summary says the session stopped for something
    ...(app.blocked && !session.blockedOn ? [`BLOCKED in the app — needs: ${app.blocked.slice(0, 200)}`] : []),
    ...(session.desktop?.draftSeen ? [`text nobody sent sits in its field ("${session.desktop.draftSeen.text.slice(0, 80)}"): the person was asked to send or clear it`] : []),
    ...(session.desktop?.archiveWhenResolved ? ["to be archived once it opens"] : []),
    ...(session.queued.length ? [`${session.queued.length} message(s) queued`] : []),
  ];
  return bits.join(" · ");
}

/** How the session runs, for the manager: it decides who can approve what. */
export function ccModeLine(session: CcSession): string {
  if (session.surface === "app") {
    const mode = session.desktop?.permissionMode ?? session.permissionMode;
    return `Mode: in the Claude app, permission mode ${mode}${session.desktop?.permissionMode && session.desktop.permissionMode !== session.permissionMode ? ` (asked for ${session.permissionMode}; the app runs it as ${session.desktop.permissionMode})` : ""} — the person sees it there and can approve prompts in the app.`;
  }
  return `Mode: headless CLI (claude -p), permission mode ${session.permissionMode} — nobody sees it and there is no approval dialog: a hook denial ends the turn; answer it with cc_session_send.`;
}

/** The corridor form of a command the review hook stopped, when there is
 * one: what to send the session instead of handing the item to the owner. */
export function corridorHint(command: string): string | null {
  const cmd = command.trim();
  if (/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+\S/.test(cmd)) {
    return `no environment-variable prefixes: run \`${cmd.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "")}\` as it is`;
  }
  if (/[|;&`]|\$\(/.test(cmd)) return "one command per call: no pipes, `&&`, `;` or `$(…)`";
  const push = /^git push(?:\s+-u|\s+--set-upstream)?\s+origin\s+(?!HEAD:)([\w./-]+)$/.exec(cmd);
  if (push && push[1] !== "main" && push[1] !== "HEAD") {
    const branch = push[1]!;
    const typed = /^(feat|fix|hotfix|chore|ci|docs|perf|refactor|test|claude)\//.test(branch) ? branch : `fix/${branch}`;
    return `push by the corridor form: \`git push -u origin HEAD:${typed}\``;
  }
  const pnpm = /^pnpm (?:run )?(pr:merge|ci:local\S*)(.*)$/.exec(cmd);
  if (pnpm) return `the repository's own command: \`npm run ${pnpm[1]}${pnpm[2]}\``;
  if (/^npm run pr:merge\b/.test(cmd) && !/ -- --pr \d+ --(publish|merge)\b/.test(cmd)) {
    return "the gate's exact forms: `npm run pr:merge -- --pr N --publish`, then `npm run pr:merge -- --pr N --merge`";
  }
  return null;
}

/** The command in a review-hook log line ("input" is the tool input JSON, maybe cut short). */
export function hookLineCommand(line: string): string | null {
  try {
    const input = String((JSON.parse(line) as { input?: unknown }).input ?? "");
    try {
      return String((JSON.parse(input) as { command?: unknown }).command ?? "") || null;
    } catch {
      return /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(input)?.[1]?.replace(/\\"/g, '"') ?? null;
    }
  } catch {
    return null;
  }
}

export function ccReportForOwner(session: CcSession, extra: { hookDecision?: string | null } = {}): string {
  const head = session.status === "failed"
    ? `Claude Code session "${session.title}" (${session.id}) stopped with a problem: ${session.lastError ?? "unknown error"}`
    : session.blockedOn
      ? `Claude Code session "${session.title}" (${session.id}) finished its turn ${session.turns} BLOCKED — it needs: ${session.blockedOn}`
      : `Claude Code session "${session.title}" (${session.id}) finished its turn ${session.turns}.`;
  return [
    head,
    ccModeLine(session),
    ...(extra.hookDecision ? [`Latest review-hook decision for this session (deny/ask preferred): ${extra.hookDecision}`] : []),
    ...corridorHints(session, extra.hookDecision),
    ...(session.lastReport ? [`Its report:\n${session.lastReport}`] : []),
    "Decide the next step: answer or steer it with cc_session_send, verify its claims yourself (gh, git) before relaying them, or archive it with cc_session_archive once its work has shipped.",
  ].join("\n");
}

/** Corridor forms for what the hook stopped, or for a push the session says
 * it is blocked on: send it that form with cc_session_send before listing
 * the item as the owner's. */
function corridorHints(session: CcSession, hookDecision?: string | null): string[] {
  const commands = new Set<string>();
  if (hookDecision && /"outcome"\s*:\s*"(deny|ask|block)/i.test(hookDecision)) {
    const command = hookLineCommand(hookDecision);
    if (command) commands.add(command);
  }
  for (const text of [session.blockedOn ?? "", session.lastReport ?? ""]) {
    for (const match of text.matchAll(/git push(?: -u| --set-upstream)? origin [\w./:-]+/g)) commands.add(match[0]);
  }
  const hints = [...commands].map((command) => ({ command, hint: corridorHint(command) })).filter((item) => item.hint);
  return hints.length
    ? [`The corridor lets this through — send it to the session with cc_session_send instead of handing it to the owner:`, ...hints.map((item) => `- \`${item.command.slice(0, 160)}\` → ${item.hint}`)]
    : [];
}

/** What the watchdog knows about a silent session, read from the app's
 * record and the transcript, so the report states facts instead of guesses. */
export interface CcStallFacts {
  /** The transcript's last event closed a turn; undefined when unreadable. */
  turnEnded?: boolean;
  lastActivityAt?: number;
  completedTurns?: number;
  /** This turn's app summary says blocked, with what it needs. */
  blocked?: string | null;
  /** Deep link that opens it in the Claude app. */
  link?: string;
  /** A question it asked in the app that nobody answered. */
  question?: string | null;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** A running session that shows no sign of work: the manager must look. */
export function ccStallReport(session: CcSession, minutes: number, facts: CcStallFacts = {}): string {
  const app = session.surface === "app";
  const mode = app ? session.desktop?.permissionMode ?? session.permissionMode : session.permissionMode;
  const lastSend = session.desktop?.lastSend;
  return [
    `Claude Code session "${session.title}" (${session.id}) is marked running but has shown no progress for ${minutes} min${facts.lastActivityAt ? ` (last activity ${clock(facts.lastActivityAt)})` : ""}.`,
    ccModeLine(session),
    facts.turnEnded === undefined
      ? "Its transcript could not be read, so whether a turn is open is unknown."
      : facts.turnEnded
        ? `Its last turn ENDED${facts.completedTurns !== undefined ? ` (the app shows ${facts.completedTurns} completed turn(s))` : ""}: it is idle, waiting for a message — nothing is pending inside it.`
        : `A turn is still open in its transcript, but nothing has been written for ${minutes} min.`,
    ...(lastSend ? [lastSend.confirmed ? `Our last message (typed ${clock(lastSend.at)}) did reach it.` : `Our last message (typed ${clock(lastSend.at)}) never showed up in its transcript.`] : []),
    ...(session.queued.length ? [`${session.queued.length} message(s) are queued for it here.`] : []),
    ...(facts.blocked ? [`Its last turn ended BLOCKED — it needs: ${facts.blocked}`] : []),
    ...(facts.question ? [`It is STOPPED ON A QUESTION in the app (only the person can answer there): ${facts.question}`] : []),
    // An approval prompt is only possible mid-turn, and never in bypass mode.
    ...(!facts.turnEnded && app ? [mode === "bypassPermissions" ? "It runs in bypassPermissions: there is no approval dialog to answer." : `If it waits on anything, it is a prompt in the Claude app (mode ${mode}) — check before saying so.`] : []),
    app
      ? facts.turnEnded
        ? "Next: send it what it should do with cc_session_send (it goes in right away), or archive it."
        : `Next: look at it in the app${facts.link ? ` (${facts.link})` : ""} before telling anyone what it waits on.`
      : "Next: check it with cc_session_list (session_id); stop it with cc_session_stop and resume with cc_session_send if needed.",
  ].join("\n");
}

/** The review hook's latest word on a Claude Code session, from the tail of
 * its log (read only; the hook owns the file). Lines carry the session id
 * ("session":"<id>"), not a folder. A deny or ask is what a manager needs,
 * so the latest of those wins over later passes. */
export function lastHookDecision(logPath: string, sessionId: string, maxBytes = 256 * 1024): string | null {
  if (!sessionId) return null;
  let fd: number | null = null;
  try {
    const size = statSync(logPath).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(logPath, "r");
    readSync(fd, buffer, 0, length, size - length);
    const needle = `"session":"${sessionId}"`;
    const lines = buffer.toString("utf8").split("\n").map((line) => line.trim()).filter((line) => line.includes(needle));
    const stop = lines.filter((line) => /"outcome"\s*:\s*"(deny|ask|block)/i.test(line)).at(-1);
    const line = stop ?? lines.at(-1);
    return line ? line.slice(0, 400) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The command the review hook last denied (or asked about) for a session,
 * from its log line's input; `truncated` when the log cut it short. */
export function lastHookBlock(logPath: string, sessionId: string, maxBytes = 256 * 1024): { command: string; truncated: boolean; cwd?: string; at: number } | null {
  if (!sessionId) return null;
  let fd: number | null = null;
  try {
    const size = statSync(logPath).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(logPath, "r");
    readSync(fd, buffer, 0, length, size - length);
    const needle = `"session":"${sessionId}"`;
    const line = buffer.toString("utf8").split("\n").filter((entry) => entry.includes(needle) && /"outcome"\s*:\s*"(deny|ask|block)/i.test(entry)).at(-1);
    if (!line) return null;
    const entry = JSON.parse(line) as { at?: string; input?: string; cwd?: string };
    const input = String(entry.input ?? "");
    let command = "";
    let truncated = false;
    try {
      command = String((JSON.parse(input) as { command?: unknown }).command ?? "");
    } catch {
      // the log keeps a prefix of the input: read the command as far as it goes
      const raw = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(input)?.[1] ?? "";
      try { command = JSON.parse(`"${raw.replace(/\\$/, "")}"`) as string; } catch { command = raw; }
      truncated = true;
    }
    if (!command.trim()) return null;
    return { command, truncated, ...(entry.cwd ? { cwd: entry.cwd } : {}), at: Date.parse(entry.at ?? "") || 0 };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** What the owner hears about queued messages held back for their age. */
export function ccHeldQueueReport(session: CcSession, held: CcQueued[], now: number): string {
  const age = (at: number) => (at ? `${Math.round((now - at) / 3_600_000)}h` : "age unknown");
  return [
    `Claude Code session "${session.title}" (${session.id}): ${held.length} queued message(s) were NOT delivered — they waited too long (over ${Math.round(CC_QUEUE_MAX_AGE_MS / 3_600_000)}h) and may no longer hold:`,
    ...held.map((item) => `- (${age(item.at)}) ${item.text.split("\n")[0]!.slice(0, 200)}`),
    "Check what is current and send again with cc_session_send what still applies.",
  ].join("\n");
}

/** The package manager a repository runs its scripts with, from its
 * lockfile or package.json "packageManager"; null when it cannot tell. */
export function repoPackageManager(repo: string): "npm" | "pnpm" | "yarn" | null {
  const has = (file: string) => existsSync(`${repo}/${file}`);
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("package-lock.json")) return "npm";
  try {
    const declared = String((JSON.parse(readFileSync(`${repo}/package.json`, "utf8")) as { packageManager?: unknown }).packageManager ?? "");
    if (declared.startsWith("npm@")) return "npm";
    if (declared.startsWith("pnpm@")) return "pnpm";
    if (declared.startsWith("yarn@")) return "yarn";
  } catch { /* no package.json */ }
  return null;
}

/** The scripts a repository's package.json declares. */
export function repoScripts(repo: string): Set<string> {
  try {
    return new Set(Object.keys((JSON.parse(readFileSync(`${repo}/package.json`, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {}));
  } catch {
    return new Set();
  }
}

/** "pnpm pr:merge" / "pnpm run ci:local" in an order to a session of an
 * npm repository becomes "npm run …": the repository's gates and the review
 * hook only know its own commands, and a session told "pnpm" goes off-road.
 * Only scripts the repository declares: "pnpm vitest" is not "npm run vitest". */
export function useRepoScripts(text: string, manager: ReturnType<typeof repoPackageManager>, scripts: ReadonlySet<string>): { text: string; changed: boolean } {
  if (manager !== "npm") return { text, changed: false };
  let changed = false;
  const out = text.replace(/\bpnpm(?:\s+run)?\s+([a-z][\w:.-]*)/gi, (match, script: string) => {
    if (!scripts.has(script)) return match;
    changed = true;
    return `npm run ${script}`;
  });
  return { text: out, changed };
}

/** "#9286 #9303 Merge…" → "9286 9303 Merge…": the owner's rule (the Chief's
 * SOUL) is that a session's name opens with the number of its issue WITHOUT
 * "#" — "9052 tempo de reabertura", never "#9052 …" (R9-dispatch R9-4). Only
 * the numbers the title opens with lose it (each said once); a "#9330"
 * further in stays. */
export function issueTitle(title: string): string {
  return title.replace(/^\s*(?:#?\d{3,6}[\s,]+)*#?\d{3,6}(?=[\s,:—-]|$)/, (run) => [...new Set(run.match(/\d{3,6}/g))].join(" "));
}

/** Whether an app title already opens with the issue number (with or without "#"). */
export function titleOpensWithIssue(title: string, issue: string): boolean {
  return new RegExp(`^\\s*#?${issue}(?!\\d)`).test(title);
}

/** The text merges, publishes or releases (or asks for it). */
export function shipsWork(text: string): boolean {
  return /\b(?:merge|mergear|mergeie|publica\w*|publish\w*|publique|carrier|release|deploy\w*|produção|production|pr:merge)\b/i.test(text);
}

/** A hotfix/P1 and a release-script change in the same batch text: the
 * corridor says they ship in separate carriers. A warning, not a refusal —
 * an explicit order of the owner ("NESTA ORDEM") prevails (PLANO-10 D6). */
export function hotfixWithReleaseScripts(text: string): string | null {
  if (!/\b(?:hotfix|P0|P1)\b/i.test(text)) return null;
  const script = /\b(?:scripts\/[\w.-]*release[\w.-]*|local-release(?:\.sh)?|watch-production-release(?:\.sh)?|release-carrier(?:\.sh)?)\b/i.exec(text);
  return script ? `Atenção: este texto junta hotfix/P1 com mudança de script de release (${script[0]}). Pelo corredor, o hotfix sai num carrier próprio, antes, e os scripts de release num carrier separado, depois — a menos que o dono tenha ordenado esta ordem explicitamente; nesse caso, diga isso no relatório.` : null;
}

/** A brief about an issue a client of the business brought (the owner
 * follows those in the app): the Atendimento spreadsheet and its rows, the
 * clients' Chat, "issue do cliente", a report by someone named ("Relato do
 * Matheus", "quem pediu foi o Pedro"). Not the product's own word "cliente"
 * (the end customer in a ticket: "o mesmo cliente entrou na fila"), not an
 * order about clients ("Não avise o cliente"), not a technical "client"
 * (HTTP client, client-side) — INSP-H r1 #6. */
export function clientIssue(text: string): boolean {
  const flat = text.replace(/\s+/g, " ");
  if (/planilha (?:de )?atendimento|linha \d{1,4} da planilha|chat\.google\.com|(?<![\p{L}])spaces\/[A-Za-z0-9_-]{6,}|issue (?:d[oe]|de um|de uma) clientes?(?![\p{L}])|(?<![\p{L}])clientes? (?:reportou|relatou|pediu|reclamou|reclama|reporta|reportaram|relataram)(?![\p{L}])/iu.test(flat)) return true;
  return /(?<![\p{L}])(?:[Rr]elato|[Rr]elatad[oa]|[Rr]eportad[oa]|[Pp]edido) (?:d[oa]|pel[oa]|por|de) \p{Lu}\p{Ll}+|(?<![\p{L}])[Qq]uem pediu foi [oa] \p{Lu}\p{Ll}+/u.test(flat);
}

/** How far back an app failure the server saw still frees the cli. */
export const APP_FAILURE_WINDOW_MS = 2 * 3_600_000;

/** The newest app failure the server itself saw for `repo` in the last 2 h,
 * said in pt-BR, or null: a message typed into the app that never arrived,
 * a screen action that kept failing, or an app session that failed. */
export function recentAppFailure(sessions: readonly CcSession[], repo: string, now: number): string | null {
  const when = (at: number) => new Date(at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const found: Array<{ at: number; text: string }> = [];
  for (const session of sessions) {
    if (session.surface !== "app" || session.repo !== repo || !session.desktop) continue;
    const name = session.title.slice(0, 50);
    const send = session.desktop.lastSend;
    if (send && !send.confirmed) found.push({ at: send.at, text: `a mensagem digitada na sessão "${name}" não chegou (${when(send.at)})` });
    const pending = session.desktop.pending;
    if (pending?.triedAt !== undefined && pending.attempts > 0 && pending.lastReason) found.push({ at: pending.triedAt, text: `${pending.kind === "create" ? "abrir" : pending.kind === "send" ? "enviar" : pending.kind === "archive" ? "arquivar" : "renomear"} "${name}" no app falhou ${pending.attempts}× (${pending.lastReason.slice(0, 80)})` });
    if (session.status === "failed" && session.failedAt !== undefined && session.lastError) found.push({ at: session.failedAt, text: `a sessão "${name}" falhou no app (${when(session.failedAt)})` });
  }
  return found.filter((each) => now - each.at <= APP_FAILURE_WINDOW_MS).sort((a, b) => b.at - a.at)[0]?.text ?? null;
}

/** Whether the Claude app can take a new session for the repository now:
 * "available"; "blocked" by the reused-folder 409 (the owner must act);
 * "unavailable" (not this Mac, no app, or it opens another repository). */
export type AppAvailability = "available" | "blocked" | "unavailable";

/** Whether a headless session is refused, decided by what the SERVER knows
 * of the app, never by the words of a cli_reason ("Sessões no terminal nunca
 * falham por tela bloqueada" names failures under a negation; "O app está
 * fechado agora" is legitimate and named none — INSP-H r1 #6):
 * - internal chores (no client's issue, nothing shipped) run headless;
 * - the app blocked (reused folder) or unavailable: allowed — the server
 *   records its own reason (`onRecord`);
 * - the app available: allowed only with an app failure the server saw in
 *   the last 2 h (`appFailure`), or for options the app does not apply
 *   (permission_mode, model) the start really sets; otherwise refused. */
export function cliSurfaceRefusal(input: { corridor: string; title: string; brief: string; reason?: string; app?: AppAvailability; appFailure?: string | null; appIgnoredOptions?: string[] }): { refusal: string } | { onRecord: string } {
  const text = `${input.title}\n${input.brief}`;
  const client = clientIssue(text);
  const ships = Boolean(input.corridor) && shipsWork(text);
  const said = input.reason?.trim() ? input.reason.trim().slice(0, 200) : "";
  if (!client && !ships) return { onRecord: said || "tarefa interna" };
  if (input.app === "blocked") return { onRecord: "o app Claude está reaproveitando worktrees (409 de pasta reaproveitada)" };
  if (input.app !== "available") return { onRecord: "o app Claude não abre sessão neste repositório agora (outra pasta, ou sem app neste Mac)" };
  if (input.appFailure) return { onRecord: `falha recente no app: ${input.appFailure}` };
  if (input.appIgnoredOptions?.length) return { onRecord: `o app não aplica ${input.appIgnoredOptions.join(" nem ")}` };
  const why = client ? "é uma issue de cliente, que o dono acompanha no app Claude" : "faz merge ou publicação num repositório com gate e carrier";
  return {
    refusal: `${said ? `cli_reason recusado ("${said.slice(0, 120)}"): ` : ""}este brief ${why}, e o app Claude pode abrir a sessão agora — não houve falha no app nas últimas 2 h. Use surface "app" (o padrão); se o app falhar, o servidor registra e libera a cli.`,
  };
}

export const corridorVersionOf = (corridor: string): string => createHash("sha256").update(corridor).digest("hex").slice(0, 12);

/** The corridor to append to a send that ships work, once per version. */
export function corridorForSend(session: Pick<CcSession, "corridorVersion">, corridor: string, message: string): { text: string; version?: string } {
  if (!corridor || !shipsWork(message)) return { text: message };
  const version = corridorVersionOf(corridor);
  if (session.corridorVersion === version) return { text: message };
  return { text: `${message}${corridor}`, version };
}

/** For a repository with a local merge gate (`pr:merge`) and a release
 * carrier: the exact command forms its review hook lets through, and the
 * order a batch of PRs ships in. A session that improvises (pnpm, a pipe, an
 * env prefix, a skipped gate) is stopped by the hook or goes off-road. "" for
 * any other repository. */
export function repoCorridor(repo: string): string {
  let scripts: Record<string, unknown> = {};
  try {
    scripts = ((JSON.parse(readFileSync(`${repo}/package.json`, "utf8")) as { scripts?: Record<string, unknown> }).scripts) ?? {};
  } catch { /* no package.json */ }
  const gate = typeof scripts["pr:merge"] === "string" && repoPackageManager(repo) === "npm";
  const carrier = existsSync(`${repo}/scripts/release-carrier.sh`);
  if (!gate && !carrier) return "";
  return [
    "",
    "",
    "This repository's corridor — use these exact forms, one command per call: no pipes, no `&&`, no environment-variable prefixes, and `npm run` (never pnpm or yarn):",
    ...(gate ? [
      "- `npm run pr:merge -- --pr N --publish` (runs the local gate and publishes its status on the PR head)",
      "- `npm run pr:merge -- --pr N --merge` or `npm run pr:merge -- --pr N --merge --receipt .local-ci/runs/<run>/receipt.env` (merges only with the gate green on the head)",
    ] : []),
    "- `git push -u origin HEAD:<type>/<branch>` (type: feat, fix, hotfix, chore, ci, docs, perf, refactor, test)",
    ...(carrier ? ["- `./scripts/release-carrier.sh --check`, then `./scripts/release-carrier.sh --execute --label X`"] : []),
    "Never skip, bypass or fake the gate; never push to main, never force.",
    "Order of a batch: hotfix/P0/P1 first, ahead of any CI or infrastructure PR, and released on its own. PRs that change release scripts (scripts/*release*, watch-production-release, release-carrier) ship in a separate carrier of their own, after the rest.",
  ].join("\n");
}
