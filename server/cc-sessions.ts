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
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";

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
  /** Messages sent while a turn was running; each becomes the next turn. */
  queued: string[];
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
}

export type CcSurface = "app" | "cli";

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
  /** The permission mode the app really runs it in (read from its record). */
  permissionMode?: string;
  /** Remove its worktree once the app confirms it archived (remove_worktree). */
  removeWorktree?: boolean;
}

export interface CcDesktopPending {
  kind: "create" | "send" | "archive";
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
  const title = typeof body.title === "string" ? body.title.trim().slice(0, CC_TITLE_MAX) : "";
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
  private readonly path: string | null;
  private readonly now: () => number;

  // plain field assignments, not parameter properties — the server runs
  // under Node's type-stripping, which cannot transform the latter
  constructor(opts: { path: string | null; now?: () => number }) {
    this.path = opts.path;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { sessions?: CcSession[] };
      for (const session of raw.sessions ?? []) {
        if (!session || typeof session.id !== "string") continue;
        // A run cannot survive a server restart: it was lost mid-turn.
        if ((session.status === "running" || session.status === "stalled") && session.surface !== "app") {
          session.status = "failed";
          session.lastError = "the server restarted (the computer was shut down or the app quit) while this turn was running; resume it with cc_session_send";
          this.interruptedOnLoad.push(session);
        }
        // Reported as stalled before the "stalled" status existed, and no
        // progress since: it is stalled, already told once.
        if (session.status === "running" && session.stallReportedAt !== undefined && session.stallReportedAt === session.progressAt) {
          session.status = "stalled";
          session.stallReports = session.stallReports ?? 1;
          session.stallNotifiedAt = session.stallNotifiedAt ?? this.now();
        }
        session.queued = Array.isArray(session.queued) ? session.queued : [];
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

  runningCount(): number {
    return [...this.sessions.values()].filter((session) => session.status === "running").length;
  }

  markRunning(session: CcSession): void {
    session.status = "running";
    session.turns += 1;
    session.lastActivityAt = this.now();
    session.progressAt = session.lastActivityAt;
    delete session.lastError;
    delete session.blockedOn;
    this.save();
  }

  finishTurn(session: CcSession, outcome: CcTurnOutcome): void {
    if (outcome.cwd) session.cwd = outcome.cwd;
    session.costUsd = Math.round((session.costUsd + outcome.costUsd) * 10_000) / 10_000;
    session.lastActivityAt = this.now();
    session.progressAt = session.lastActivityAt;
    if (session.status === "stopped" || session.status === "archived") {
      this.save();
      return;
    }
    session.status = outcome.ok ? "idle" : "failed";
    if (outcome.report) session.lastReport = outcome.report;
    if (outcome.error) session.lastError = outcome.error;
    else delete session.lastError;
    this.save();
  }

  enqueue(session: CcSession, message: string): number {
    session.queued.push(message);
    this.save();
    return session.queued.length;
  }

  takeQueued(session: CcSession): string | null {
    const next = session.queued.shift() ?? null;
    if (next !== null) this.save();
    return next;
  }

  setStatus(session: CcSession, status: "stopped" | "archived"): void {
    session.status = status;
    session.queued = [];
    session.lastActivityAt = this.now();
    if (status === "archived") session.archivedAt = this.now();
    this.save();
  }
}

export function ccSessionLine(session: CcSession): string {
  const bits = [
    `${session.id} · "${session.title}" · ${session.status}${session.surface === "app" ? " · in the Claude app" : ""}`,
    `turns ${session.turns}, US$ ${session.costUsd.toFixed(2)}`,
    session.cwd ? `worktree ${session.cwd}` : session.surface === "app" ? "worktree chosen by the app (pending)" : `worktree ${session.repo}/.claude/worktrees/${session.worktree} (pending)`,
    ...(session.desktop?.pending ? [`waiting for an idle Mac to ${session.desktop.pending.kind === "create" ? "open it" : session.desktop.pending.kind === "archive" ? "archive it" : "send a message"}${session.desktop.pending.lastReason ? ` (${session.desktop.pending.lastReason})` : ""}`] : []),
    ...(session.desktop?.sent ? ["message typed in the app, checking that it arrived"] : []),
    ...(session.blockedOn ? [`BLOCKED — needs: ${session.blockedOn.slice(0, 200)}`] : []),
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

export function ccReportForOwner(session: CcSession, extra: { hookDecision?: string | null } = {}): string {
  const head = session.status === "failed"
    ? `Claude Code session "${session.title}" (${session.id}) stopped with a problem: ${session.lastError ?? "unknown error"}`
    : session.blockedOn
      ? `Claude Code session "${session.title}" (${session.id}) finished its turn ${session.turns} BLOCKED — it needs: ${session.blockedOn}`
      : `Claude Code session "${session.title}" (${session.id}) finished its turn ${session.turns}.`;
  return [
    head,
    ccModeLine(session),
    ...(extra.hookDecision ? [`Latest review-hook decision in its folder: ${extra.hookDecision}`] : []),
    ...(session.lastReport ? [`Its report:\n${session.lastReport}`] : []),
    "Decide the next step: answer or steer it with cc_session_send, verify its claims yourself (gh, git) before relaying them, or archive it with cc_session_archive once its work has shipped.",
  ].join("\n");
}

/** A running session that shows no sign of work: the manager must look. */
export function ccStallReport(session: CcSession, minutes: number): string {
  return [
    `Claude Code session "${session.title}" (${session.id}) is marked running but has shown no progress for ${minutes} min.`,
    ccModeLine(session),
    session.surface === "app"
      ? "It may be waiting on an approval or a question in the Claude app, or a message may not have reached it. Check it (cc_session_list with its session_id), tell the person what it waits on, or steer it with cc_session_send."
      : "Its run may be stuck. Check it (cc_session_list with its session_id); stop it with cc_session_stop and resume with cc_session_send if needed.",
  ].join("\n");
}

/** The review hook's latest decision about commands run in `cwd`, from the
 * tail of its log (read only; the hook owns the file). */
export function lastHookDecision(logPath: string, cwd: string, maxBytes = 256 * 1024): string | null {
  if (!cwd) return null;
  let fd: number | null = null;
  try {
    const size = statSync(logPath).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(logPath, "r");
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (line && line.includes(cwd)) return line.slice(0, 400);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
