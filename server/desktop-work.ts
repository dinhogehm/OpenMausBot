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
import { existsSync, statSync } from "node:fs";
import { sessionErrorPt } from "../shared/session-error-pt.ts";
import type { WireCcSession } from "../shared/wire.ts";
import { basename } from "node:path";
import type { CcDesktopPending, CcOwnWorktree, CcSession, CcSessionLedger } from "./cc-sessions.ts";
import { ccHeldQueueReport, ccReportForOwner, ccStallReport, issueTitle, titleOpensWithIssue, type CcStallFacts } from "./cc-sessions.ts";
export { CC_ACTIVE_MS, ccSessionActive } from "./cc-sessions.ts";
import {
  archiveDesktopSession,
  createDesktopSession,
  openDesktopSessionIn,
  renameDesktopSession,
  recordBlocked,
  recordInWorktree,
  summaryIsCurrent,
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
/** A question left open in the app this long is reported to the owner. */
export const DESKTOP_QUESTION_REPORT_MS = 2 * 60_000;
/** A finished turn whose app summary is still the previous turn's is held this long for it. */
export const DESKTOP_SUMMARY_WAIT_MS = 60_000;
/** Tries to prepare the screen helper (compile it) before giving up. */
export const DESKTOP_HELPER_MAX_TRIES = 3;
/** Screens that did not show what was expected (unlocked, Claude in front) before giving up. */
export const DESKTOP_MAX_MISSES = 5;
export const DESKTOP_RENAME_MAX_MISSES = 3;
export const DESKTOP_BACKOFF_BASE_MS = 30_000;
export const DESKTOP_BACKOFF_MAX_MS = 10 * 60_000;
/** After the Archive click, the app's record must say archived within this... */
export const DESKTOP_ARCHIVE_CONFIRM_MS = 2 * 60_000;
/** ...or it is clicked again, up to this many times in all. */
export const DESKTOP_ARCHIVE_MAX_TRIES = 3;
/** After a rename's Return, how long the app's record has to show the new title. */
export const DESKTOP_RENAME_CONFIRM_MS = 2 * 60_000;
/** A running session with no sign of work for this long is reported and marked stalled. */
export const CC_STALL_MS = 30 * 60_000;
/** While it stays stalled, the owner is reminded this often... */
export const CC_STALL_REMIND_MS = 6 * 3_600_000;
/** ...this many times in all (the first report included). */
export const CC_STALL_MAX_REPORTS = 3;

export interface DesktopWorkDeps {
  ledger: CcSessionLedger;
  now: () => number;
  getDriver: () => Promise<DesktopDriver>;
  readRecord: (localId: string) => DesktopRecord | null;
  findSession: (marker: string, since: number) => DesktopRecord | null;
  /** The Claude Code transcript of a CLI session id, or null. */
  transcriptOf: (cliSessionId: string) => string | null;
  lastText: (transcript: string) => string;
  /** The transcript's latest event closes a turn. */
  turnEnded: (transcript: string) => boolean;
  /** An AskUserQuestion in the transcript nobody answered yet. */
  openQuestion?: (transcript: string) => { id: string; text: string } | null;
  /** A user event after `since` carries the text's first line. */
  mentions: (transcript: string, text: string, since: number) => boolean;
  writtenAt: (transcript: string) => number | null;
  repoName: (session: CcSession) => string;
  chip: (session: CcSession, text: string, ok?: boolean) => void;
  /** Hand a report to the owning bot (and the thread the last order came from). */
  report: (session: CcSession, text: string) => void;
  /** Put an item in "Precisa de você" (owner_pending) for the session's owner, or resolve it by key. */
  ownerPending?: (session: CcSession, item: { title: string; link?: string; key: string; why?: string; steps?: Array<{ text: string; command?: string; link?: string }> }) => void;
  resolveOwnerPending?: (key: string) => void;
  /** Worktree names of the app's live sessions: a new session must not open on one. */
  liveWorktrees?: () => string[];
  /** The repository's base branch ("main"): a new session must open on it. */
  baseBranch?: (session: CcSession) => string;
  /** The branch git's HEAD of the repository root is on ("HEAD" when detached), and the repository's branches: an unreadable branch chip is judged by them, with the root session New Session opened from (R11-2, INSP-R12a-r2 R2-1). */
  rootHead?: (session: CcSession) => string | null;
  branches?: (session: CcSession) => string[];
  /** The real paths of the worktrees git lists for the session's repository: a "trust this workspace" is clicked only for one of them. */
  registeredWorktrees?: (session: CcSession) => string[];
  /** A session of the app in the repository root to open before New Session (claude-desktop.ts rootAnchorSession). */
  rootAnchor?: (session: CcSession) => { localId: string; title?: string } | null;
  /** The review hook's latest deny/ask (or decision) for a Claude Code session id. */
  hookDecision?: (sessionId: string) => string | null;
  /** The command the review hook last denied or asked about for a session id. */
  hookBlock?: (sessionId: string) => HookBlock | null;
  /** Does this folder exist (default: the real filesystem)? */
  pathExists?: (path: string) => boolean;
  /** Titles of the app's other sessions (archived too) that worked in `folder`. */
  folderUsers?: (folder: string, exceptLocalId: string) => string[];
  /** When a folder was created, or null (default: the real filesystem). */
  folderBornAt?: (path: string) => number | null;
  /** One line per screen action (server.log). */
  log?: (line: string) => void;
  /** The app confirmed the session archived (remove its worktree if asked). */
  onArchived?: (session: CcSession) => void;
  /** The worktrees the server makes for its app sessions (lote X). */
  own?: OwnWorktreeDeps;
  steps?: {
    openIn?: typeof openDesktopSessionIn;
    create?: typeof createDesktopSession;
    send?: typeof sendToDesktopSession;
    archive?: typeof archiveDesktopSession;
    rename?: typeof renameDesktopSession;
  };
}

/** The worktrees the server makes for its app sessions (own-worktrees.ts), as the flow needs them. */
export interface OwnWorktreeDeps {
  /** Make the session's worktree (and its alias for the app) and clone its caches. */
  prepare: (session: CcSession) => Promise<{ ok: true; head: string; link: string; caches: NonNullable<CcOwnWorktree["caches"]>; fetchError?: string } | { ok: false; reason: string }>;
  /** The app's text once the worktree is ready (ownBriefText, with the session's footer). */
  briefFor: (session: CcSession) => string;
  /** Why New Session, the old way, would land in a wrong folder now (the 409's words), or null. */
  classicBlocked: (session: CcSession) => string | null;
  /** A session opened through the server's worktree landed in `folder` instead (the breaker counts it). */
  wrongFolder?: (session: CcSession, folder: string) => void;
  /** A create through the server's worktree given up because the new session's worktree option read ON or unreadable (the breaker counts it). */
  chipRefused?: (session: CcSession, option: "on" | "unknown", seen?: string) => void;
  /** A create through the server's worktree given up for any other miss —
   * the link opened no new session, its chips showed another folder — with
   * the last reason and what the screen showed: the breaker counts it too
   * (R13-dispatch R13-2: 13 such give-ups on 06/10, none counted). */
  abandoned?: (session: CcSession, reason: string, seen?: string) => void;
  /** Both ways of the app failed for this create (its own worktree, then
   * New Session): the same brief goes to the cli, as one start with the
   * failure on record. The cli session's id, its queue entry, or why not. */
  toCli?: (session: CcSession, why: string) => { sessionId: string } | { queueId: string } | { refusal: string };
  /** A create was adopted in a worktree of its own (either way): the breaker rearms. */
  adopted?: (session: CcSession) => void;
}

/** Screens that did not show the new session in its folder before New Session is used instead. */
export const OWN_OPEN_MAX_MISSES = 3;

/** The issue a session is about: the number its title opens with ("9311 …",
 * or "#9311 …" from before the owner's no-"#" rule), else a "#NNNN" further
 * in its title, else the first "#NNNN" or issue/PR link in its brief. */
export function issueNumber(title: string, brief = ""): string | undefined {
  return /^\s*#?(\d{3,6})\b/.exec(title)?.[1]
    ?? /#(\d{3,6})\b/.exec(title)?.[1]
    ?? /(?:#|\/issues\/|\/pull\/)(\d{3,6})\b/.exec(brief)?.[1];
}

/** The brief as typed into the app. Its first line is the title opening with
 * the issue number, without "#" ("9298 …", the owner's rule): the app titles
 * the session from its opening words, and the number is what people look
 * for in the sidebar. The marker that finds the session again goes on its
 * own line below. */
export function desktopBriefText(title: string, marker: string, brief: string, footer = "", folderSince?: number): string {
  return briefWith(title, marker, brief, footer, folderSince !== undefined ? folderGuard(folderSince) : null);
}

/** The brief of a session opened in the worktree the server made for it:
 * the same first lines, and a folder check against that very folder. */
export function ownBriefText(title: string, marker: string, brief: string, footer: string, own: { path: string; branch: string }, caches: string): string {
  return briefWith(title, marker, brief, footer, ownFolderGuard(own.path, own.branch, caches));
}

function briefWith(title: string, marker: string, brief: string, footer: string, guard: string | null): string {
  const number = issueNumber(title, brief);
  const named = issueTitle(title);
  // One "NNNN" at the start, never twice ("9311 9311 Chat…"); a title that
  // already names its issue further in ("Chat #9311 …") is left as it is.
  const first = !number || titleOpensWithIssue(named, number) || new RegExp(`#${number}(?!\\d)`).test(named) ? named : `${number} ${named}`;
  return `${first}\n[${marker}]\n\n${guard ? `${guard}\n\n` : ""}${brief}${footer}`;
}

/** The first step of a session in the server's own worktree: its folder is
 * known, so the check is exact (`pwd -P`, the alias the app was given
 * resolved). Anything else — the root, another worktree, one the app made
 * inside it — stops it untouched, as folderGuard does. */
export function ownFolderGuard(path: string, branch: string, caches: string): string {
  return [
    "Passo 0, antes de qualquer outra coisa (não leia, edite, faça checkout nem rode mais nada antes dele): confira que esta sessão abriu na worktree que o gerente criou para ela.",
    `Rode \`pwd -P\`. Se a saída não for exatamente ${path}, pare aí: responda só "${WRONG_FOLDER_ANSWER}: <a saída do pwd>" e encerre o turno. O gerente cuida do resto.`,
    `Se for, siga com a tarefa abaixo nessa pasta, na branch ${branch} (feita agora de origin/main; pode renomeá-la).`,
    caches,
  ].join("\n");
}

/** What a session that landed in a wrong folder answers, and nothing else. */
export const WRONG_FOLDER_ANSWER = "PASTA REAPROVEITADA";
/** Slack under the brief's time for the folder's birth (same Mac, same clock). */
const FOLDER_GUARD_SLACK_S = 120;

/** The brief's first step: the app may land a new session in a worktree
 * another session used (01/10 09:53, 02/10 10:07) or in the root, and the
 * server only learns it when the app's record appears — after the brief
 * went in. So the session checks its own folder before it touches
 * anything: a worktree the app made for it is born after the brief was
 * written; a reused one, or the root, is older. It then answers only
 * WRONG_FOLDER_ANSWER and stops; the server fails it (adoptRecord, or the
 * answer itself) and blocks the next creates (R10-dispatch R10-1b). */
export function folderGuard(since: number): string {
  const limit = Math.floor(since / 1_000) - FOLDER_GUARD_SLACK_S;
  return [
    "Passo 0, antes de qualquer outra coisa (não leia, edite, faça checkout nem rode mais nada antes dele): confira que esta sessão abriu numa worktree nova, só sua.",
    `Rode \`pwd\` e \`stat -f %B .\`. Se a pasta não estiver dentro de .claude/worktrees/, ou se o número do stat for menor que ${limit} (a pasta já existia antes deste pedido: o app reaproveitou a worktree de outra sessão), pare aí: responda só "${WRONG_FOLDER_ANSWER}: <a saída do pwd>" e encerre o turno. O gerente cuida do resto.`,
    "Se a pasta estiver em .claude/worktrees/ e o número for maior ou igual, siga com a tarefa abaixo.",
  ].join("\n");
}

/** The session's own answer says it stopped at the folder check. */
export const saidWrongFolder = (text: string) => text.trimStart().toUpperCase().startsWith(WRONG_FOLDER_ANSWER);

/** Wait before retrying a screen action that touched the screen and stopped. */
export function desktopBackoffMs(attempts: number): number {
  return Math.min(DESKTOP_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), DESKTOP_BACKOFF_MAX_MS);
}

/** A screen step of the session waiting for the Mac, for its row (R8-dispatch
 * D6: nothing told the person that work waits for them to leave the Mac
 * alone or unlock it). A step being verified (archive, rename clicked) does
 * not wait for the Mac. */
export function screenWaitOf(session: Pick<CcSession, "surface" | "status" | "desktop">): WireCcSession["screenWait"] | undefined {
  const pending = session.surface === "app" && session.status !== "archived" && session.status !== "stopped" ? session.desktop?.pending : undefined;
  if (!pending || pending.verifyUntil) return undefined;
  const reason = pending.lastReason ?? "";
  const waitingFor = !reason ? "queued" as const
    : /locked|asleep/i.test(reason) ? "locked" as const
      : /Mac is in use|picked the Mac back up|lost focus/i.test(reason) ? "inUse" as const
        : /texto não enviado/i.test(reason) ? "draft" as const
          : "screen" as const;
  return { kind: pending.kind, since: pending.since, waitingFor };
}

const liveApp = (session: CcSession) =>
  session.surface === "app" && Boolean(session.desktop) && session.status !== "archived" && session.status !== "stopped";

/** The oldest screen action that may run now; one stuck action never blocks
 * the rest. A rename waits until the session is idle: never mid-turn. */
export function pickDesktopPending(sessions: CcSession[], now: number): CcSession | null {
  return sessions
    .filter((session) => liveApp(session) && session.desktop!.pending && !session.desktop!.pending!.verifyUntil && (session.desktop!.pending!.nextAttemptAt ?? 0) <= now)
    .filter((session) => session.desktop!.pending!.kind !== "rename" || session.status === "idle")
    // a create waits for the worktree the server is still making for it
    .filter((session) => session.desktop!.pending!.kind !== "create" || session.desktop!.own?.state !== "planned")
    .sort((a, b) => a.desktop!.pending!.since - b.desktop!.pending!.since)[0] ?? null;
}

/** Make the worktree of the oldest create that waits for one (one at a
 * time: git and the clone run with nice, never on the screen). Made: the
 * create opens the app in it, with a brief that checks that very folder.
 * Not made: the create goes on through New Session, as before — unless
 * that would land in a wrong folder now (the 409), and then it fails with
 * those words. Nothing made is ever removed. */
export async function prepareOwnWorktrees(deps: DesktopWorkDeps, state: { preparing: boolean }): Promise<void> {
  if (!deps.own || state.preparing) return;
  const next = deps.ledger.all()
    .filter((session) => liveApp(session) && session.desktop!.own?.state === "planned" && session.desktop!.pending?.kind === "create")
    .sort((a, b) => a.desktop!.pending!.since - b.desktop!.pending!.since)[0];
  if (!next) return;
  const own = next.desktop!.own!;
  state.preparing = true;
  try {
    deps.log?.(`own worktree: making ${own.path} (${own.branch}) for session ${next.id}`);
    let made: Awaited<ReturnType<OwnWorktreeDeps["prepare"]>>;
    try {
      made = await deps.own.prepare(next);
    } catch (error) {
      made = { ok: false, reason: error instanceof Error ? error.message.slice(0, 300) : String(error) };
    }
    // stopped or archived meanwhile: what was made stays, as it is
    if (!liveApp(next) || next.desktop?.own !== own || own.state !== "planned" || next.desktop.pending?.kind !== "create") {
      deps.log?.(`own worktree: ${own.path} ${made.ok ? "made" : "not made"} for session ${next.id}, which no longer waits to open; left as it is`);
      return;
    }
    if (!made.ok) {
      own.state = "failed";
      own.reason = made.reason;
      deps.log?.(`own worktree: could not make ${own.path} for session ${next.id} — ${made.reason}`);
      fallBackToNewSession(deps, next, `não consegui criar a worktree da sessão (${made.reason})`);
      return;
    }
    own.state = "ready";
    own.head = made.head;
    own.link = made.link;
    own.caches = made.caches;
    next.desktop!.pending!.text = deps.own.briefFor(next);
    deps.ledger.save();
    const caches = made.caches.mode === "cloned"
      ? `dependências clonadas da semente (${made.caches.dirs?.length ?? 0} pasta(s), ~${Math.round((made.caches.savedKb ?? 0) / 1024)} MB sem ocupar disco)`
      : `dependências NÃO clonadas — a sessão roda npm ci (${(made.caches.reason ?? "?").slice(0, 120)})`;
    deps.chip(next, `worktree criada pelo OMB: ${own.path} (${own.branch}); ${caches}${made.fetchError ? `; o fetch de origin falhou, usei a origin/main conhecida (${made.fetchError.slice(0, 80)})` : ""}`, made.caches.mode === "cloned");
    deps.log?.(`own worktree: ${own.path} ready at ${made.head.slice(0, 9)} for session ${next.id} — caches ${made.caches.mode}${made.caches.reason ? ` (${made.caches.reason})` : ""}`);
  } finally {
    state.preparing = false;
  }
}

/** The create goes on through New Session with its own folder check (the
 * classic brief), or fails with the 409's words when New Session would
 * land in a wrong folder now. */
function fallBackToNewSession(deps: DesktopWorkDeps, session: CcSession, why: string): void {
  const desktop = session.desktop!;
  const own = desktop.own!;
  const blocked = deps.own?.classicBlocked(session) ?? null;
  if (blocked) {
    const reason = `${why}; and New Session, the old way, would land in a wrong folder now — ${blocked}`;
    // the app would not open in the worktree, and New Session is barred: both ways of the app failed (a worktree never made is not one)
    if (own.state === "abandoned") appWaysFailed(deps, session, reason);
    else failDesktopSession(deps, session, reason);
    return;
  }
  desktop.pending = { kind: "create", text: own.classicText, since: desktop.pending?.since ?? deps.now(), attempts: 0 };
  deps.ledger.save();
  deps.chip(session, `${why} — abrindo pelo jeito antigo (Nova sessão), com a conferência de pasta de sempre`, false);
  deps.log?.(`own worktree: session ${session.id} goes on through New Session — ${why}`);
}


/** The id the review hook logs a session under: its own for a CLI run, the
 * app's Claude Code session id for an app one. */
export function hookSessionId(session: CcSession): string | undefined {
  return session.surface === "app" ? session.desktop?.cliSessionId : session.id;
}

export type HookBlock = { command: string; truncated: boolean; cwd?: string; at: number };

/** For the owner, when an app session stopped on a question. Answering in
 * the app does not get a blocked command past the review hook — the hook
 * judges the command again on every try — so a question about one comes
 * with the exact command for the person to run by hand. */
export function openQuestionReport(session: Pick<CcSession, "title" | "id" | "cwd">, localId: string, question: string, block: HookBlock | null): string {
  return [
    `Claude Code session "${session.title}" (${session.id}) asked a question in the Claude app and is stopped on it — it reads nothing else (queued messages included) until someone answers there. Only the person can answer, in the app: claude://code/continue?session=${localId}`,
    `Its question, verbatim:\n${question}`,
    block
      ? [
        "The review hook blocked this command in that session. Answering \"yes\" in the app does not let it through: the hook judges the command again on every try. If it must run, the person runs it by hand, exactly:",
        `  cd ${block.cwd ?? session.cwd ?? "<the session's worktree>"}`,
        ...block.command.split("\n").map((line) => `  ${line}`),
        ...(block.truncated ? ["(The hook's log cut the command short: copy the rest from the session in the app.)"] : []),
      ].join("\n")
      : "If it asks to run a command the review hook blocked: answering in the app does not get it past the hook — the hook judges the command again on every try. The person runs that command by hand, exactly as the session shows it.",
  ].join("\n");
}

export function reportFor(deps: DesktopWorkDeps, session: CcSession): string {
  const id = hookSessionId(session);
  return ccReportForOwner(session, { hookDecision: id && deps.hookDecision ? deps.hookDecision(id) : null });
}

const renameKey = (session: CcSession) => `cc-rename:${session.id}`;

/** "Precisa de você" shows one line: the app's title (what the person finds
 * in the app's sidebar) and the new one, short. */
export function renameAskTitle(appTitle: string, newTitle: string): string {
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
  return `Renomear no app: "${cut(appTitle, 36)}" → "${cut(newTitle, 44)}"`;
}

/** A screen action that cannot be done. Only a create that never opened
 * fails the session; a message that could not be typed, or an archive or
 * rename the screen would not allow, fails just that action — the session
 * in the app is fine and keeps taking messages. The owner hears exactly
 * what did not happen. */
export function giveUpPending(deps: DesktopWorkDeps, session: CcSession, reason: string): void {
  const desktop = session.desktop!;
  const pending = desktop.pending;
  if (!pending || pending.kind === "create") {
    // New Session failing after the server's own worktree did: both ways of the app failed
    if (pending && desktop.own?.state === "abandoned") appWaysFailed(deps, session, `${desktop.own.reason ? `the app did not open the session in the worktree the server made (${desktop.own.reason.slice(0, 200)}), and then ` : ""}New Session failed too: ${reason}`);
    else failDesktopSession(deps, session, reason);
    return;
  }
  delete desktop.pending;
  // kept on the session: cc_session_list shows it as its last problem
  session.lastError = `could not ${actionLabel(pending.kind)} in the Claude app: ${reason}`.slice(0, 1_000);
  const link = desktop.localId ? ` (claude://code/continue?session=${desktop.localId})` : "";
  if (pending.kind === "send") {
    if (session.status === "running" && !desktop.sent) session.status = "idle";
    desktop.lastSend = { at: deps.now(), confirmed: false };
    deps.ledger.save();
    deps.chip(session, "a mensagem NÃO foi entregue no app", false);
    deps.report(session, `Claude Code session "${session.title}" (${session.id}): your message was NOT delivered — ${reason}. The session itself is fine and idle in the app${link}; send it again with cc_session_send later, or tell the person. Undelivered message: "${pending.text.slice(0, 300)}"`);
    return;
  }
  // "arquive à mão": when the person does, it is what the server asked for
  if (pending.kind === "archive") desktop.archiveHandedOver = true;
  if (pending.kind === "rename") {
    // The title the person sees in the app (not our ledger's), and the new one, essentials first.
    const appTitle = (desktop.localId ? deps.readRecord(desktop.localId)?.title : undefined) ?? session.title;
    desktop.renameAsked = true;
    deps.ownerPending?.(session, {
      title: renameAskTitle(appTitle, pending.text), ...(desktop.localId ? { link: `claude://code/continue?session=${desktop.localId}` } : {}), key: renameKey(session),
      why: "O servidor não consegue renomear esta sessão no app sozinho, e com o título certo você a acha na lista do app Claude.",
      steps: [
        { text: `No app Claude, abra a sessão "${appTitle.slice(0, 60)}".`, ...(desktop.localId ? { link: `claude://code/continue?session=${desktop.localId}` } : {}) },
        { text: `Renomeie-a para: ${pending.text.slice(0, 120)}` },
        { text: "Pronto: o servidor vê o título novo e fecha este item sozinho." },
      ],
    });
  }
  deps.ledger.save();
  const what = pending.kind === "archive" ? "archive" : "rename";
  deps.chip(session, pending.kind === "archive" ? "não foi possível arquivar no app — arquive à mão" : "não foi possível renomear no app", false);
  deps.report(session, `Claude Code session "${session.title}" (${session.id}): could not ${what} it in the Claude app — ${reason}. Nothing else changed; ${pending.kind === "archive" ? "ask the person to archive it by hand" : "the person may rename it by hand"}${link}.`);
}

/** The next queued message still fresh enough to deliver; older ones are
 * held back and the owner is asked to confirm or resend them. */
export function takeFreshQueued(deps: Pick<DesktopWorkDeps, "ledger" | "now" | "chip" | "report">, session: CcSession): string | null {
  const { next, held } = deps.ledger.takeQueued(session);
  if (held.length) {
    deps.chip(session, `${held.length} mensagem(ns) antiga(s) da fila retida(s) — reenvie o que ainda vale`, false);
    deps.report(session, ccHeldQueueReport(session, held, deps.now()));
  }
  return next;
}

export function failDesktopSession(deps: DesktopWorkDeps, session: CcSession, reason: string, then?: (session: CcSession) => string | null): void {
  if (session.desktop) {
    delete session.desktop.pending;
    delete session.desktop.sent;
  }
  session.status = "failed";
  session.lastError = reason;
  session.failedAt = deps.now();
  // what was done about it once the failure is on record (it frees the cli: R13-1), said in the same report
  const after = then?.(session);
  if (after) session.lastError = `${reason}. ${after}`;
  deps.ledger.save();
  deps.chip(session, `parou com um problema — ${sessionErrorPt(reason).slice(0, 120)}`, false);
  deps.report(session, reportFor(deps, session));
}

/** Both ways of the app failed for a create (the server's worktree, then
 * New Session, or New Session barred): the session fails — on record, which
 * frees the cli — and the same brief is started there at once, the reason
 * recorded, instead of a bot finding out and asking (R13-dispatch R13-2). */
function appWaysFailed(deps: DesktopWorkDeps, session: CcSession, reason: string): void {
  failDesktopSession(deps, session, reason, (failed) => {
    if (!deps.own?.toCli) return null;
    let started: ReturnType<NonNullable<OwnWorktreeDeps["toCli"]>>;
    try {
      started = deps.own.toCli(failed, reason);
    } catch (error) {
      started = { refusal: error instanceof Error ? error.message.slice(0, 200) : String(error) };
    }
    failed.desktop!.cliFallback = { at: deps.now(), ...started };
    deps.log?.(`create: session ${failed.id} failed both ways of the app — ${"sessionId" in started ? `started in the cli as ${started.sessionId}` : "queueId" in started ? `queued for the cli (${started.queueId})` : `the cli refused: ${started.refusal}`}`);
    if ("sessionId" in started) return `Both ways of the Claude app failed, so the server started the same brief in the CLI as session ${started.sessionId}; its report comes here. Do not start it again`;
    if ("queueId" in started) return `Both ways of the Claude app failed, so the server put the same brief in the session queue for the CLI (${started.queueId}); it opens by itself. Do not start it again`;
    return `Both ways of the Claude app failed, and the server could not start the same brief in the CLI: ${started.refusal}`;
  });
}

const actionLabel = (kind: CcDesktopPending["kind"]) =>
  kind === "create" ? "open the session" : kind === "archive" ? "archive the session" : kind === "rename" ? "rename the session" : "send the message";

/** The app's record of a session we opened: adopt its ids, mode and folder. */
function adoptRecord(deps: DesktopWorkDeps, session: CcSession, record: DesktopRecord): boolean {
  const desktop = session.desktop!;
  deps.log?.(`create adopted: session ${session.id} is ${record.sessionId} in ${record.cwd ?? "?"}${record.worktreeName ? ` (worktree ${record.worktreeName})` : " (no worktree of its own)"}`);
  desktop.localId = record.sessionId;
  desktop.cliSessionId = record.cliSessionId;
  if (record.cwd) session.cwd = record.cwd;
  if (record.worktreeName) session.worktree = record.worktreeName;
  if (record.permissionMode) desktop.permissionMode = record.permissionMode;
  session.progressAt = deps.now();
  deps.ledger.save();
  // the brief's first step (folderGuard) has it stop untouched in either
  // case; the session stays failed for good (wrongFolder), and the next
  // creates meet the 409 (lastAppWorktreeFolder / lastServerSessionInRoot)
  const guarded = desktop.folderGuarded ? ` — its brief told it to check its folder first and stop, answering "${WRONG_FOLDER_ANSWER}", without touching anything; confirm in the Claude app that it did.` : " — stop it in the Claude app now if it is still working.";
  // opened in the worktree the server made for it: that very folder, nobody else in it
  const own = desktop.own?.state === "ready" ? desktop.own : null;
  if (own) {
    const folder = record.cwd ?? record.worktreePath;
    const others = [
      ...deps.ledger.all().filter((other) => other.id !== session.id && other.cwd === own.path).map((other) => `"${other.title}"`),
      ...(deps.folderUsers?.(own.path, record.sessionId) ?? []).map((title) => `"${title}" (app)`),
    ];
    if (folder === own.path && (!record.worktreePath || record.worktreePath === own.path) && !others.length) {
      session.worktree = basename(own.path);
      deps.ledger.save();
      deps.chip(session, `aberta no app Claude, na worktree que o OMB criou (${basename(own.path)})`);
      deps.own?.adopted?.(session);
      return true;
    }
    desktop.wrongFolder = record.worktreePath ?? folder ?? "?";
    const where = folder === own.path ? `in it together with ${[...new Set(others)].join(", ")}` : `in ${desktop.wrongFolder} instead`;
    failDesktopSession(deps, session, `the session should have opened in the worktree the server made for it (${own.path}) and opened ${where}${guarded} The worktree the server made stays as it is (the server never removes one); start the work again`);
    // the breaker counts it: two in a row and this path is set aside (R11-dispatch R11-1)
    deps.own?.wrongFolder?.(session, desktop.wrongFolder);
    return false;
  }
  if (!recordInWorktree(record)) {
    desktop.wrongFolder = record.cwd ?? "?";
    failDesktopSession(deps, session, `the session opened outside a git worktree (in ${record.cwd ?? "an unknown folder"}), on the main checkout: the app opened it with the worktree option off${guarded} New sessions wait until the owner unblocks the app (the 409 says how — where the server makes the sessions' worktrees, the option stays off); start the work again then`);
    return false;
  }
  const reused = reusedWorktree(deps, session, record);
  if (reused) {
    desktop.wrongFolder = record.worktreePath ?? record.cwd ?? "?";
    failDesktopSession(deps, session, `the session opened in ${reused} instead of a new worktree of its own (${record.cwd}), a folder another session had${guarded} New sessions wait until the owner unblocks the app (the 409 says how); start the work again then`);
    return false;
  }
  deps.chip(session, "aberta no app Claude");
  // a create that worked, the old way: the breaker of the server's worktrees rearms
  deps.own?.adopted?.(session);
  return true;
}

/** A new session must get a worktree of its own: one the app named for it,
 * no other session (ours or the app's, archived ones too) ever worked in,
 * created after the brief went in. What it reused, or null. */
function reusedWorktree(deps: DesktopWorkDeps, session: CcSession, record: DesktopRecord): string | null {
  const folder = record.worktreePath ?? record.cwd;
  if (!folder || !folder.includes("/.claude/worktrees/")) return null;
  const others = [
    ...deps.ledger.all().filter((other) => other.id !== session.id && other.cwd === folder).map((other) => `"${other.title}"`),
    ...(deps.folderUsers?.(folder, record.sessionId) ?? []).map((title) => `"${title}" (app)`),
  ];
  if (others.length) return `the worktree of ${[...new Set(others)].join(", ")}`;
  if (!record.worktreeName) return "an existing worktree (the app gave it no worktree name)";
  const born = (deps.folderBornAt ?? bornAt)(folder);
  const sentAt = session.desktop?.sentAt ?? session.desktop?.pending?.triedAt;
  if (born !== null && sentAt !== undefined && born < sentAt - 60_000) return "a worktree created before the brief was sent";
  return null;
}

const bornAt = (path: string): number | null => {
  try {
    return statSync(path).birthtimeMs || null;
  } catch {
    return null;
  }
};

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
    // The person renamed it by hand (the app's title opens with "NNNN", with
    // or without "#"), or it was archived: the "rename it" item is settled.
    if (desktop.renameAsked && (record.isArchived || (desktop.issue && record.title && titleOpensWithIssue(record.title, desktop.issue)))) {
      delete desktop.renameAsked;
      deps.ledger.save();
      deps.resolveOwnerPending?.(renameKey(session));
    }
    if (record.isArchived) {
      // archived by someone in the app, not by an order to the server: the
      // owner must hear it (its PR may be left without a session). Asked
      // for: an archive on its way, one handed to the person ("arquive à
      // mão"), or a failed session the owner was told to see to in the app.
      // Those that went through cc_session_archive passed archiveBlockers;
      // a failed one did not: its PRs are still checked (archived-outside.ts).
      const failed = session.status === "failed";
      const ordered = desktop.pending?.kind === "archive" || Boolean(desktop.archiveWhenResolved) || Boolean(desktop.archiveHandedOver) || failed;
      delete desktop.pending;
      deps.ledger.setStatus(session, "archived");
      if (ordered) {
        if (failed && !desktop.archiveHandedOver) {
          session.archivedOutsideAt = now;
          session.archivedAfterFailure = true;
          deps.ledger.save();
        }
        deps.chip(session, "arquivada no app Claude");
      } else {
        session.archivedOutsideAt = now;
        deps.ledger.save();
        deps.chip(session, "arquivada no app Claude por alguém, sem pedido do OMB", false);
        deps.chip(session, `abrir no app: claude://code/continue?session=${desktop.localId}`, false);
        deps.report(session, `Claude Code session "${session.title}" (${session.id}) was archived in the Claude app by someone, not through cc_session_archive (claude://code/continue?session=${desktop.localId}). Whatever it was still doing stopped there. The server checks whether a PR of it is still open and tells you; meanwhile check its last report (cc_session_list with its id) and decide who carries the work on.`);
      }
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
      deps.chip(session, "o app não confirmou o arquivamento; tentando de novo", false);
    }
    // A rename counts only once the app's record shows the new title.
    const renaming = desktop.pending?.kind === "rename" && desktop.pending.verifyUntil ? desktop.pending : null;
    if (renaming) {
      if (record.title?.trim() === renaming.text.trim()) {
        delete desktop.pending;
        deps.ledger.save();
        deps.chip(session, `renomeada no app: ${renaming.text.slice(0, 80)}`);
      } else if (now > renaming.verifyUntil!) {
        delete desktop.pending;
        deps.ledger.save();
        deps.chip(session, "o app não mostra o novo título — renomear não foi confirmado", false);
        deps.report(session, `Claude Code session "${session.title}" (${session.id}): the rename to "${renaming.text}" was tried in the Claude app, but the app's record still says "${record.title ?? "(no title)"}". It is not tried again; the person may rename it by hand (claude://code/continue?session=${desktop.localId}).`);
      }
    }
    // The owner wants every session named "NNNN …" in the app (no "#"), and
    // the app titles them itself: rename it once, the way a person would.
    if (desktop.issue && !desktop.renameTried && !desktop.pending && record.title && !record.title.includes(desktop.issue)) {
      desktop.renameTried = true;
      desktop.pending = { kind: "rename", text: `${desktop.issue} ${record.title}`, since: now, attempts: 0 };
      deps.ledger.save();
    }
    const transcript = deps.transcriptOf(record.cliSessionId);
    // Its worktree is gone (removed by hand, or reused and cleaned up): the
    // session cannot work there any more. Say so once; archiving stays possible.
    if (session.cwd && !desktop.cwdGone && !(deps.pathExists ?? existsSync)(session.cwd)) {
      desktop.cwdGone = true;
      deps.ledger.save();
      deps.chip(session, `a pasta da sessão não existe mais (${session.cwd})`, false);
      deps.report(session, `Claude Code session "${session.title}" (${session.id}): its folder ${session.cwd} no longer exists, so it cannot keep working there. Archive it with cc_session_archive (nothing to remove) and start a new session if the work is not done.`);
    }
    if (desktop.sent) {
      const sent = desktop.sent;
      const arrived = (record.latestUserFrameAt ?? 0) > sent.userFrameAt || (transcript !== null && deps.mentions(transcript, sent.text, sent.at));
      if (arrived) {
        delete desktop.sent;
        desktop.lastSend = { at: sent.at, confirmed: true };
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
        deps.chip(session, `a mensagem não chegou à sessão; digitando de novo (${sent.deliveries + 1} de ${DESKTOP_SEND_MAX_DELIVERIES})`, false);
        continue;
      }
    }
    // It asked something in the app and waits for an answer there: nothing
    // we type reaches it until someone answers. Tell the owner what it asks.
    const question = transcript !== null && (session.status === "running" || session.status === "stalled") ? deps.openQuestion?.(transcript) ?? null : null;
    if (question && desktop.questionReported !== question.id && now - (deps.writtenAt(transcript!) ?? now) >= DESKTOP_QUESTION_REPORT_MS) {
      desktop.questionReported = question.id;
      deps.ledger.save();
      deps.chip(session, `a sessão fez uma pergunta no app e está parada nela: ${question.text.split("\n")[0]!.slice(0, 100)}`, false);
      // the hook's block counts only if it came in this turn, around the question
      const block = desktop.cliSessionId ? deps.hookBlock?.(desktop.cliSessionId) ?? null : null;
      const recent = block && block.at >= (desktop.lastSend?.at ?? desktop.sentAt ?? 0) - 60_000 ? block : null;
      deps.report(session, openQuestionReport(session, desktop.localId!, question.text, recent));
    }
    const turns = record.completedTurns ?? 0;
    // Marked running, yet nothing is on its way and the app's last turn has
    // ended long ago: no turn is coming to drain the queue (a message lost
    // before sends were confirmed, a state that drifted). Take it as idle.
    if ((session.status === "running" || session.status === "stalled") && !desktop.pending && !desktop.sent && turns === desktop.turnsSeen && transcript !== null && deps.turnEnded(transcript)) {
      const lastActivity = Math.max(record.lastActivityAt ?? 0, deps.writtenAt(transcript) ?? 0);
      if (now - lastActivity > DESKTOP_SEND_CONFIRM_MS) {
        session.status = "idle";
        session.progressAt = now;
        delete session.stallReportedAt;
        delete session.stallNotifiedAt;
        delete session.stallReports;
        session.lastReport = deps.lastText(transcript) || session.lastReport || "(no text in its last reply)";
        const blocked = recordBlocked(record);
        if (blocked) session.blockedOn = blocked;
        else delete session.blockedOn;
        const next = desktop.archiveWhenResolved ? null : takeFreshQueued(deps, session);
        if (next !== null) {
          desktop.pending = { kind: "send", text: next, since: now, attempts: 0 };
          session.status = "running";
        }
        deps.ledger.save();
        deps.chip(session, `estava parada: o último turno no app já tinha terminado${next !== null ? "; a mensagem da fila vai agora" : ""}`, false);
        deps.report(session, `${reportFor(deps, session)}\n(The server found it idle in the app — its last turn had ended and nothing reached it since${next !== null ? "; the message queued for it is being typed in now, and its answer comes back as a new report" : ""}.)`);
        continue;
      }
    }
    if (turns > desktop.turnsSeen) {
      // The app writes its turn summary after the turn: give it a minute
      // rather than report the previous turn's "blocked" (or miss this one's).
      if (!summaryIsCurrent(record)) {
        desktop.turnWaitSince ??= now;
        if (now - desktop.turnWaitSince < DESKTOP_SUMMARY_WAIT_MS) continue;
      }
      delete desktop.turnWaitSince;
      desktop.turnsSeen = turns;
      session.turns = turns;
      if (record.cwd) session.cwd = record.cwd;
      const said = transcript ? deps.lastText(transcript) : "";
      // In a wrong folder it stays failed: a finished turn does not make it
      // a session to work with (before, it went back to idle here and the
      // bot read "terminou o turno 1"). Its own folder-check answer fails
      // it too, if adoption did not catch the folder (R10-dispatch R10-1b).
      if (desktop.wrongFolder || saidWrongFolder(said)) {
        session.lastReport = said || session.lastReport || "(no text in its last reply)";
        if (!desktop.wrongFolder) {
          desktop.wrongFolder = record.worktreePath ?? record.cwd ?? "?";
          failDesktopSession(deps, session, `the session stopped at its folder check: it opened in ${desktop.wrongFolder}, a folder that existed before its brief (a reused worktree or the root), and touched nothing. New sessions wait until the owner unblocks the app (the 409 says how); start the work again then`);
          if (desktop.own?.state === "ready") deps.own?.wrongFolder?.(session, desktop.wrongFolder);
        } else deps.ledger.save();
        continue;
      }
      session.lastReport = [said, record.prUrl ? `PR: ${record.prUrl}` : ""].filter(Boolean).join("\n\n") || "(no text in its last reply)";
      const blocked = recordBlocked(record);
      if (blocked) session.blockedOn = blocked;
      else delete session.blockedOn;
      session.status = "idle";
      delete session.lastError;
      delete session.stallReportedAt;
      delete session.stallNotifiedAt;
      delete session.stallReports;
      session.lastActivityAt = now;
      session.progressAt = now;
      const next = desktop.archiveWhenResolved ? null : takeFreshQueued(deps, session);
      if (next !== null) {
        desktop.pending = { kind: "send", text: next, since: now, attempts: 0 };
        session.status = "running";
        deps.ledger.save();
        deps.chip(session, blocked ? `terminou o turno ${turns} bloqueada — precisa de: ${blocked.slice(0, 80)}; a mensagem da fila vai em seguida` : `terminou o turno ${turns}; a mensagem da fila vai em seguida`, !blocked);
        // The owner still hears what this turn said before the queued message goes in.
        deps.report(session, `${reportFor(deps, session)}\n(A message you queued earlier is being typed into it now; it may be out of date given this report — follow up with cc_session_send if so.)`);
        continue;
      }
      deps.ledger.save();
      deps.chip(session, blocked ? `terminou o turno ${turns} bloqueada — precisa de: ${blocked.slice(0, 80)}` : `terminou o turno ${turns}`, !blocked);
      deps.report(session, reportFor(deps, session));
    }
    // Idle with messages waiting (queued while a rename or another step was
    // on its way): the next one goes in now.
    if (session.status === "idle" && !desktop.pending && !desktop.sent && !desktop.archiveWhenResolved && session.queued.length) {
      const next = takeFreshQueued(deps, session);
      if (next !== null) {
        desktop.pending = { kind: "send", text: next, since: now, attempts: 0 };
        session.status = "running";
        deps.ledger.save();
      }
    }
    if (desktop.archiveWhenResolved && !desktop.pending && !desktop.sent) {
      delete desktop.archiveWhenResolved;
      desktop.pending = { kind: "archive", text: "", since: now, attempts: 0 };
      deps.ledger.save();
      deps.chip(session, "na fila para ser arquivada no app Claude");
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
    giveUpPending(deps, next, `the Mac was never idle and unlocked for long enough in 12 hours to ${actionLabel(pending.kind)} (${pending.lastReason ?? "busy"})`);
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
  // Status can lag the app: a rename also waits for the transcript's turn to end.
  if (pending.kind === "rename" && desktop.cliSessionId) {
    const transcript = deps.transcriptOf(desktop.cliSessionId);
    if (transcript !== null && !deps.turnEnded(transcript)) {
      pending.nextAttemptAt = now + 60_000;
      return;
    }
  }
  if (pending.kind !== "create" && !desktop.localId) {
    failDesktopSession(deps, next, "the session never opened in the Claude app, so nothing can be done to it there; start a new one");
    return;
  }
  state.busy = true;
  try {
    let driver: DesktopDriver;
    try {
      driver = await deps.getDriver();
    } catch (error) {
      // Compiling the helper can fail for a while (Xcode tools updating, a
      // full disk): back off and try again before giving up on the session.
      const why = `could not prepare the screen helper: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`;
      pending.helperFailures = (pending.helperFailures ?? 0) + 1;
      if (pending.helperFailures >= DESKTOP_HELPER_MAX_TRIES) {
        giveUpPending(deps, next, `${why} (${pending.helperFailures} tries)`);
        return;
      }
      pending.lastReason = why;
      pending.nextAttemptAt = deps.now() + desktopBackoffMs(pending.helperFailures);
      deps.ledger.save();
      return;
    }
    const steps = deps.steps ?? {};
    let userFrameAt = 0;
    let step: DesktopStep;
    deps.log?.(`${pending.kind} start: session ${next.id} "${next.title.slice(0, 60)}" (try ${pending.attempts + 1}${pending.misses ? `, misses ${pending.misses}` : ""})`);
    const own = pending.kind === "create" && desktop.own?.state === "ready" ? desktop.own : null;
    if (pending.kind === "create") {
      pending.triedAt = deps.now();
      deps.ledger.save();
      step = own
        // the app's link opens New Session in the server's own worktree (its alias)
        ? await (steps.openIn ?? openDesktopSessionIn)(driver, { folder: own.link ?? own.path, folderName: basename(own.path), text: pending.text, expected: own.path, registered: () => deps.registeredWorktrees?.(next) ?? [] })
        : await (steps.create ?? createDesktopSession)(driver, { repoName: deps.repoName(next), text: pending.text, liveWorktrees: deps.liveWorktrees?.() ?? [], baseBranch: deps.baseBranch?.(next) ?? "main", anchor: deps.rootAnchor?.(next) ?? null, rootHead: deps.rootHead?.(next) ?? null, branches: deps.branches?.(next) ?? [] });
    } else {
      const record = deps.readRecord(desktop.localId!);
      userFrameAt = record?.latestUserFrameAt ?? 0;
      const target = { localId: desktop.localId!, title: record?.title ?? next.title };
      const repoName = deps.repoName(next);
      step = pending.kind === "archive"
        ? await (steps.archive ?? archiveDesktopSession)(driver, target)
        : pending.kind === "rename"
          ? await (steps.rename ?? renameDesktopSession)(driver, { ...target, newTitle: pending.text, repoName })
          : await (steps.send ?? sendToDesktopSession)(driver, { ...target, text: pending.text, repoName });
    }
    const at = deps.now();
    // a create is "sent" here (the brief left the field); "adopted" comes when the app's record shows up
    const over = step.ok && step.suggestion ? ` (over app suggestion: "${step.suggestion.slice(0, 80)}")` : step.ok && step.note ? ` (${step.note})` : "";
    deps.log?.(`${pending.kind} ${step.ok ? (pending.kind === "create" ? "sent (brief left the field)" : "ok") : step.retry ? "stopped" : "gave up"}: session ${next.id}${over}${step.ok ? "" : ` — ${step.reason}${step.seen ? ` — the screen showed: ${step.seen}` : ""}${step.touched ? " (touched the screen)" : ""}`}`);
    if (step.ok) {
      if (pending.kind === "send" || pending.kind === "rename") clearDraft(deps, next);
      if (pending.kind === "archive") {
        // Only the app's record says it worked; followDesktopSessions checks it.
        pending.verifyUntil = at + DESKTOP_ARCHIVE_CONFIRM_MS;
        pending.archiveTries = (pending.archiveTries ?? 0) + 1;
        deps.ledger.save();
        return;
      }
      if (pending.kind === "rename") {
        // Only the app's record says it worked; followDesktopSessions checks it.
        pending.verifyUntil = at + DESKTOP_RENAME_CONFIRM_MS;
        deps.ledger.save();
        return;
      }
      delete desktop.pending;
      // the app's suggested reply gave way to the message (a draft never does)
      if (pending.kind === "send" && "suggestion" in step && step.suggestion) deps.chip(next, `a sugestão do app no campo (“${step.suggestion.slice(0, 80)}”) foi substituída pela mensagem`, true);
      if (pending.kind === "create") {
        desktop.sentAt = at;
        // a "trust this workspace" the person was asked about is settled
        deps.resolveOwnerPending?.(trustKey(next));
      }
      else {
        desktop.sent = { text: pending.text, at, userFrameAt, deliveries: (pending.deliveries ?? 0) + 1 };
        desktop.lastSend = { at, confirmed: false };
      }
      next.status = "running";
      next.lastActivityAt = at;
      next.progressAt = at;
      deps.ledger.save();
      deps.chip(next, pending.kind === "create" ? "brief enviado no app Claude" : "mensagem digitada no app Claude (conferindo se chegou)");
      return;
    }
    if (step.trustNeeded !== undefined) {
      askToTrust(deps, next, step.trustNeeded, at);
      return;
    }
    if (step.draft !== undefined) {
      holdForDraft(deps, next, step.draft, at, step.leftProbe === true);
      return;
    }
    if (!step.retry) {
      giveUpPending(deps, next, step.reason);
      return;
    }
    // after a "trust" click the link is opened again (R13-3); a second click is a miss, so a prompt that keeps coming back ends
    if (step.trusted && own) {
      pending.trustClicks = (pending.trustClicks ?? 0) + 1;
      if (pending.trustClicks > 1) step.miss = true;
      deps.chip(next, `confiei no workspace ${basename(own.path)} no app Claude; reabrindo o link e conferindo a pasta antes de colar`, false);
    }
    if (step.miss && own) {
      pending.misses = (pending.misses ?? 0) + 1;
      // the last miss says why: a chip reading from an earlier miss never sticks to one of another cause (INSP-R12a X3-5)
      if (step.worktreeOption) {
        pending.worktreeOption = step.worktreeOption;
        if (step.seen) pending.worktreeSeen = step.seen.slice(0, 300);
      } else {
        delete pending.worktreeOption;
        delete pending.worktreeSeen;
      }
      // the app would not open its link there: New Session, as before (the worktree stays)
      if (pending.misses >= OWN_OPEN_MAX_MISSES) {
        own.state = "abandoned";
        own.reason = `${step.reason}${step.seen ? ` — the screen showed: ${step.seen}` : ""}`.slice(0, 600);
        // the worktree option ON (or unreadable) counts in the breaker like a wrong folder, with its own diagnosis (R12-1);
        // so does any other give-up: no new session from the link, another folder's chips (R13-2)
        if (pending.worktreeOption) deps.own?.chipRefused?.(next, pending.worktreeOption, pending.worktreeSeen);
        else deps.own?.abandoned?.(next, step.reason, step.seen);
        fallBackToNewSession(deps, next, `o app não abriu a sessão na worktree criada pelo OMB em ${pending.misses} tentativas (${step.reason.slice(0, 160)})`);
        return;
      }
    } else if (step.miss) {
      pending.misses = (pending.misses ?? 0) + 1;
      // a rename is cosmetic: three misses and the person is asked instead (01/10: 29 silent tries)
      if (pending.misses >= (pending.kind === "rename" ? DESKTOP_RENAME_MAX_MISSES : DESKTOP_MAX_MISSES)) {
        giveUpPending(deps, next, `could not ${actionLabel(pending.kind)} after ${pending.misses} tries with the screen unlocked and the Claude app in front: ${step.reason}${step.seen ? ` — the screen showed: ${step.seen}` : ""}`);
        return;
      }
    }
    // what the screen showed goes with the reason: a live miss is diagnosed from it
    const reason = `${step.reason}${step.seen ? ` — the screen showed: ${step.seen}` : ""}`;
    const changed = pending.lastReason !== reason;
    pending.lastReason = reason;
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
    deps.log?.(`${pending.kind} error: session ${next.id} — ${pending.lastReason}`);
    deps.ledger.save();
  } finally {
    state.busy = false;
  }
}

const trustKey = (session: CcSession) => `cc-trust:${session.id}`;

/** How long a create waits for the person to answer the app's "trust this workspace" before it gives up. */
export const DESKTOP_TRUST_MAX_MS = 2 * 3_600_000;

/** The app asks to trust a folder that is not a worktree the server made:
 * only the person decides. Asked once in "Precisa de você"; the create
 * waits (it is no miss) and looks again every DESKTOP_DRAFT_RECHECK_MS —
 * for DESKTOP_TRUST_MAX_MS at most: then it gives up, and the item says so
 * (INSP-R12a X3-3). */
function askToTrust(deps: DesktopWorkDeps, session: CcSession, folder: string, at: number): void {
  const pending = session.desktop!.pending!;
  pending.trustSince ??= at;
  if (at - pending.trustSince >= DESKTOP_TRUST_MAX_MS) {
    const hours = Math.round(DESKTOP_TRUST_MAX_MS / 3_600_000);
    deps.ownerPending?.(session, {
      title: `A sessão "${session.title.slice(0, 50)}" desistiu de abrir no app Claude: ninguém respondeu ao pedido de confiar no workspace ${folder} em ${hours} h`,
      key: trustKey(session),
      why: `O app Claude pediu para confiar no workspace ${folder}, e o servidor não confia sozinho numa pasta que não é uma worktree dele. Depois de ${hours} h sem resposta, a criação desistiu; o bot foi avisado e pode abrir de novo.`,
      steps: [{ text: "Se a pasta for sua, confie nela no app Claude e peça ao bot para abrir a sessão de novo; senão, resolva este item." }],
    });
    giveUpPending(deps, session, `the Claude app asked to trust the workspace ${folder} and nobody answered in ${hours} h (the server trusts only a worktree it made)`);
    return;
  }
  const first = pending.lastReason?.startsWith("o app pede para confiar") !== true;
  pending.lastReason = `o app pede para confiar no workspace ${folder}; esperando a pessoa`;
  pending.nextAttemptAt = at + DESKTOP_DRAFT_RECHECK_MS;
  deps.ledger.save();
  if (!first) return;
  deps.chip(session, `o app Claude pede para confiar no workspace ${folder}: só você decide — o pedido está em "Precisa de você"`, false);
  deps.ownerPending?.(session, {
    title: `Confiar no workspace ${folder} no app Claude (a sessão "${session.title.slice(0, 50)}" espera por isso)`,
    key: trustKey(session),
    why: `O app Claude pediu para confiar no workspace ${folder} ao abrir a sessão nova. O servidor só confirma isso sozinho numa worktree que ele mesmo criou; nesta pasta, quem decide é você. A sessão espera e o servidor tenta de novo a cada ${DESKTOP_DRAFT_RECHECK_MS / 60_000} min.`,
    steps: [
      { text: `No app Claude, abra uma sessão nova em ${folder} e responda ao pedido "Confiar no workspace" (confie só se a pasta for sua).` },
      { text: "Pronto: na próxima tentativa o servidor abre a sessão e fecha este item sozinho." },
    ],
  });
}

/** How long a message waits before the field is looked at again, while the person's draft is in it. */
export const DESKTOP_DRAFT_RECHECK_MS = 20 * 60_000;
const draftKey = (session: CcSession) => `cc-draft:${session.id}`;

/** The session's field holds text nobody sent: maybe the person's draft. It
 * is never overwritten — the message waits, and the person is asked (once
 * per draft) in "Precisa de você", with the link to the session. */
function holdForDraft(deps: DesktopWorkDeps, session: CcSession, draft: string, at: number, leftProbe = false): void {
  const desktop = session.desktop!;
  const pending = desktop.pending!;
  // The next try reads the draft WITH the "." we left ("texto."): still our
  // dot, so the item keeps saying so instead of becoming a plain "send or
  // clear it" (INSP-D B4).
  const prev = desktop.draftSeen;
  // (once the person took the dot out, the draft is a plain draft again)
  const ourDot = !leftProbe && prev?.leftProbe === true && draft === `${prev.text}.`;
  if (ourDot) {
    leftProbe = true;
    draft = prev!.text;
  }
  pending.lastReason = `há texto não enviado no campo da sessão: "${draft.slice(0, 40)}…"${leftProbe ? ' (ficou um "." no fim dele)' : ""}`;
  pending.nextAttemptAt = at + DESKTOP_DRAFT_RECHECK_MS;
  const seen = prev?.text === draft && (prev.leftProbe === true) === leftProbe;
  desktop.draftSeen = { text: draft, at: seen ? prev!.at : at, ...(leftProbe ? { leftProbe: true } : {}) };
  deps.ledger.save();
  // a "." just left in the person's draft is said at once, even for a draft already reported
  if (seen) return;
  const link = desktop.localId ? `claude://code/continue?session=${desktop.localId}` : undefined;
  deps.chip(session, `há texto não enviado no campo desta sessão — não sobrescrevi; ${pending.kind === "rename" ? "o novo título" : "a mensagem"} espera: “${draft.slice(0, 80)}”${leftProbe ? ' — ficou um "." no fim dele' : ""}`, false);
  deps.ownerPending?.(session, {
    title: leftProbe ? `Rascunho na sessão "${session.title}": deixei um "." no fim dele — apague-o (“${draft.slice(0, 40)}”)` : `Texto não enviado no campo da sessão "${session.title}": envie ou apague (“${draft.slice(0, 60)}”)`,
    ...(link ? { link } : {}), key: draftKey(session),
    why: "Há texto seu não enviado no campo da sessão: o servidor não escreve por cima dele, e a mensagem do bot fica esperando até o campo ficar livre.",
    steps: [
      { text: `No app Claude, abra a sessão "${session.title.slice(0, 60)}".`, ...(link ? { link } : {}) },
      { text: leftProbe ? "Apague o \".\" que ficou no fim do rascunho (ou o rascunho inteiro, se não precisar dele)." : "Envie o texto que está no campo, ou apague-o." },
      { text: "Pronto: com o campo livre, o servidor entrega a mensagem do bot e fecha este item sozinho." },
    ],
  });
  deps.report(session, `Claude Code session "${session.title}" (${session.id}): its message field holds text nobody sent — "${draft.slice(0, 300)}". It is the person's own draft (it did not give way to a keystroke), so nothing was typed over it; your ${pending.kind === "send" ? "message" : pending.kind} waits and is tried again every ${DESKTOP_DRAFT_RECHECK_MS / 60_000} min. The person was asked in "Precisa de você" to send or clear it${link ? ` (${link})` : ""}.${leftProbe ? ' The person came back mid-check, so the test "." stayed at the end of their draft; they were told.' : ""} Do not ask them to type your message for you.`);
}

/** The field was free again: the draft item is settled. */
function clearDraft(deps: DesktopWorkDeps, session: CcSession): void {
  if (!session.desktop?.draftSeen) return;
  delete session.desktop.draftSeen;
  deps.resolveOwnerPending?.(draftKey(session));
}

/** Running sessions (app or CLI) with no sign of work: report them and
 * mark them stalled (they stop holding the Mac and their thread), remind the
 * owner every few hours a few times, and put them back to running on any
 * sign of work. */
export function watchStalledSessions(deps: DesktopWorkDeps): void {
  const now = deps.now();
  for (const session of deps.ledger.all()) {
    if (session.status !== "running" && session.status !== "stalled") continue;
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
    const facts = (): CcStallFacts => ({
      ...(transcript ? { turnEnded: deps.turnEnded(transcript) } : {}),
      lastActivityAt: progress,
      ...(record ? { completedTurns: record.completedTurns ?? 0, blocked: recordBlocked(record) } : {}),
      ...(session.desktop?.localId ? { link: `claude://code/continue?session=${session.desktop.localId}` } : {}),
      ...(transcript && deps.openQuestion ? { question: deps.openQuestion(transcript)?.text ?? null } : {}),
    });
    if (session.status === "stalled") {
      if (session.stallReportedAt !== undefined && progress > session.stallReportedAt) {
        session.status = "running";
        delete session.stallReportedAt;
        delete session.stallNotifiedAt;
        delete session.stallReports;
        deps.ledger.save();
        deps.chip(session, "voltou a mostrar progresso");
        continue;
      }
      const reports = session.stallReports ?? 1;
      if (reports >= CC_STALL_MAX_REPORTS || now - (session.stallNotifiedAt ?? 0) < CC_STALL_REMIND_MS) continue;
      const minutes = Math.round((now - progress) / 60_000);
      const known = facts();
      // The last reminder, and no turn is under way (none ever ran, or the
      // last one ended): nothing will move it. Close it instead of leaving it
      // stalled forever with a queue nobody delivers.
      if (reports + 1 >= CC_STALL_MAX_REPORTS && (session.turns === 0 || known.turnEnded === true)) {
        const dropped = session.queued.length;
        session.queued = [];
        failDesktopSession(deps, session, `${session.turns === 0 ? "it never answered its brief" : "its last turn ended and it never moved again"} (no progress for ${minutes} min, ${CC_STALL_MAX_REPORTS} reminders)${dropped ? `; ${dropped} queued message(s) were dropped` : ""} — reopen the work in a new session or archive this one`);
        continue;
      }
      session.stallReports = reports + 1;
      session.stallNotifiedAt = now;
      deps.ledger.save();
      deps.chip(session, `ainda parada, sem progresso há ${minutes} min (aviso ${reports + 1} de ${CC_STALL_MAX_REPORTS})`, false);
      deps.report(session, `${ccStallReport(session, minutes, known)}\n(Reminder ${reports + 1} of ${CC_STALL_MAX_REPORTS}; after the last one you are not reminded again.)`);
      continue;
    }
    if (now - progress <= CC_STALL_MS) continue;
    session.status = "stalled";
    session.stallReportedAt = progress;
    session.stallNotifiedAt = now;
    session.stallReports = 1;
    deps.ledger.save();
    const minutes = Math.round((now - progress) / 60_000);
    deps.chip(session, `sem progresso há ${minutes} min — marcada como parada`, false);
    deps.report(session, ccStallReport(session, minutes, facts()));
  }
}

/** Failures that came from the screen (a step on the Claude app that could
 * not be done), not from the session itself. */
const SCREEN_FAILURE = /Claude app|screen|typed into|never reached|never idle|sidebar|menu|New Session|did not appear|stayed in the field/i;

/** On load: app sessions an older build failed for a screen step are alive
 * in the app and can take messages. Put them back to idle, with a chip. A
 * session that never opened, or opened outside a worktree, stays failed. */
export function reviveScreenFailures(deps: Pick<DesktopWorkDeps, "ledger" | "readRecord" | "chip">): CcSession[] {
  const revived: CcSession[] = [];
  for (const session of deps.ledger.all()) {
    const desktop = session.desktop;
    if (session.surface !== "app" || session.status !== "failed" || !desktop?.localId) continue;
    const reason = session.lastError ?? "";
    // a session in a wrong folder is not a screen step that failed: it stays failed
    if (!SCREEN_FAILURE.test(reason) || desktop.wrongFolder || /outside a git worktree|instead of a new worktree|stopped at its folder check/i.test(reason)) continue;
    const record = deps.readRecord(desktop.localId);
    if (!record || record.isArchived) continue;
    session.status = "idle";
    delete session.lastError;
    delete desktop.pending;
    delete desktop.sent;
    revived.push(session);
    deps.chip(session, `voltou a aceitar mensagens: a falha era de um passo na tela, não da sessão (${reason.slice(0, 80)})`);
  }
  if (revived.length) deps.ledger.save();
  return revived;
}

/** A session still alive for the same issue in the same repository: a new
 * one would duplicate the work, so the order goes to that one instead. */
export function liveSessionForIssue(sessions: readonly CcSession[], repo: string, issue: string | undefined): CcSession | null {
  if (!issue) return null;
  return sessions.find((session) => session.repo === repo
    && session.status !== "archived" && session.status !== "stopped"
    // a create that never opened is not a session to send to
    && !(session.status === "failed" && session.surface === "app" && !session.desktop?.localId)
    // nor one that landed in a wrong folder: it never takes work (R10-dispatch R10-1b)
    && !session.desktop?.wrongFolder
    && (session.desktop?.issue ?? issueNumber(session.title)) === issue) ?? null;
}

/** A title no other live session of ours uses: the app lists sessions by
 * title, and two alike cannot be told apart there. */
export function uniqueSessionTitle(sessions: readonly CcSession[], title: string, id: string): string {
  const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  const taken = sessions.some((session) => session.status !== "archived" && norm(session.title) === norm(title));
  return taken ? `${title} · ${id.slice(0, 4)}` : title;
}

const liveStatus = (session: CcSession) => session.status === "running" || session.status === "stalled" || session.status === "idle";

/** Issues whose sessions all ended (archived, stopped, failed) in the last
 * week, with none alive and not yet looked at: candidates for "a P1 left
 * without anyone on it". The latest session of each stands for it. */
export function orphanedIssues(sessions: readonly CcSession[], now: number, withinMs = 7 * 24 * 3_600_000): CcSession[] {
  const byIssue = new Map<string, CcSession[]>();
  for (const session of sessions) {
    const issue = session.desktop?.issue ?? issueNumber(session.title);
    if (!issue) continue;
    const key = `${session.repo}#${issue}`;
    byIssue.set(key, [...(byIssue.get(key) ?? []), session]);
  }
  const orphans: CcSession[] = [];
  for (const group of byIssue.values()) {
    if (group.some(liveStatus)) continue;
    const latest = group.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a));
    if (latest.orphanCheckedAt !== undefined || now - latest.lastActivityAt > withinMs) continue;
    orphans.push(latest);
  }
  return orphans;
}
