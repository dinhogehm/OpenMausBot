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
}

export type CcSurface = "app" | "cli";

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
  /** The permission mode the app really runs it in (read from its record). */
  permissionMode?: string;
  /** Remove its worktree once the app confirms it archived (remove_worktree). */
  removeWorktree?: boolean;
  /** The issue number the session is about ("9311"), from its title or brief. */
  issue?: string;
  /** A rename to "#NNNN …" was already tried (it is tried once). */
  renameTried?: boolean;
  /** tool_use id of the open question already reported to the owner. */
  questionReported?: string;
  /** Its folder was found missing (reported once). */
  cwdGone?: boolean;
  /** Our latest message typed into the app, and whether its transcript showed it. */
  lastSend?: { at: number; confirmed: boolean };
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
    if (status === "archived") session.archivedAt = this.now();
    this.save();
  }
}

export function ccSessionLine(session: CcSession): string {
  const bits = [
    `${session.id} · "${session.title}" · ${session.status}${session.surface === "app" ? " · in the Claude app" : ""}`,
    `turns ${session.turns}, US$ ${session.costUsd.toFixed(2)}`,
    session.cwd ? `worktree ${session.cwd}` : session.surface === "app" ? "worktree chosen by the app (pending)" : `worktree ${session.repo}/.claude/worktrees/${session.worktree} (pending)`,
    ...(session.desktop?.pending ? [`waiting for an idle Mac to ${session.desktop.pending.kind === "create" ? "open it" : session.desktop.pending.kind === "archive" ? "archive it" : session.desktop.pending.kind === "rename" ? "rename it" : "send a message"}${session.desktop.pending.lastReason ? ` (${session.desktop.pending.lastReason})` : ""}`] : []),
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
    ...(extra.hookDecision ? [`Latest review-hook decision for this session (deny/ask preferred): ${extra.hookDecision}`] : []),
    ...(session.lastReport ? [`Its report:\n${session.lastReport}`] : []),
    "Decide the next step: answer or steer it with cc_session_send, verify its claims yourself (gh, git) before relaying them, or archive it with cc_session_archive once its work has shipped.",
  ].join("\n");
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

/** What the owner hears about queued messages held back for their age. */
export function ccHeldQueueReport(session: CcSession, held: CcQueued[], now: number): string {
  const age = (at: number) => (at ? `${Math.round((now - at) / 3_600_000)}h` : "age unknown");
  return [
    `Claude Code session "${session.title}" (${session.id}): ${held.length} queued message(s) were NOT delivered — they waited too long (over ${Math.round(CC_QUEUE_MAX_AGE_MS / 3_600_000)}h) and may no longer hold:`,
    ...held.map((item) => `- (${age(item.at)}) ${item.text.split("\n")[0]!.slice(0, 200)}`),
    "Check what is current and send again with cc_session_send what still applies.",
  ].join("\n");
}
