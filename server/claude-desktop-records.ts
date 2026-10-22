// The Claude app's own session records and transcripts, read from disk.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalFolder } from "./own-worktrees.ts";

export const DESKTOP_SESSIONS_DIR = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");

export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface DesktopRecord {
  sessionId: string;
  cliSessionId: string;
  cwd?: string;
  title?: string;
  /** Timestamps are normalised to epoch milliseconds when read. */
  createdAt?: number;
  lastActivityAt?: number;
  /** When the session last received a message from its user (us). */
  latestUserFrameAt?: number;
  completedTurns?: number;
  isArchived?: boolean;
  prUrl?: string;
  /** The mode the app really runs it in (the person may pick bypass there). */
  permissionMode?: string;
  worktreePath?: string;
  worktreeName?: string;
  /** The folder picked when the session was started (the repository root
   * for every record on this Mac, worktree sessions included): where the
   * session landed (`cwd`) is the app's choice, not this one. */
  originCwd?: string;
  /** The base branch the session started from, as the app recorded it. */
  sourceBranch?: string;
  /** The app's own summary of a turn: status_category "blocked" means it waits
   * on someone. It is written after the turn, and summarizes_uuid names the
   * assistant message it is about. */
  postTurnSummary?: { status_category?: string; needs_action?: unknown; summarizes_uuid?: string; [key: string]: unknown };
  /** The session's latest assistant message. */
  lastAssistantUuid?: string;
  /** Set on runs of the app's scheduled tasks (routines). */
  scheduledTaskId?: string;
}

/** Is the app's summary about the latest turn (and not still the previous one's)? */
export function summaryIsCurrent(record: Pick<DesktopRecord, "postTurnSummary" | "lastAssistantUuid">): boolean {
  const about = record.postTurnSummary?.summarizes_uuid;
  return !about || !record.lastAssistantUuid || about === record.lastAssistantUuid;
}

export const toMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1_000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

/** Why the session says it cannot go on, when its last turn ended blocked. */
export function recordBlocked(record: Pick<DesktopRecord, "postTurnSummary" | "lastAssistantUuid">): string | null {
  const summary = record.postTurnSummary;
  // A summary of an earlier turn says nothing about this one.
  if (!summary || summary.status_category !== "blocked" || !summaryIsCurrent(record)) return null;
  const need = summary.needs_action;
  const text = typeof need === "string" ? need : Array.isArray(need) ? need.map(String).join("; ") : need ? JSON.stringify(need) : "";
  return text.trim().slice(0, 1_000) || "it did not say what it needs";
}

/** The session works in a git worktree of its own, not in the main checkout. */
export function recordInWorktree(record: Pick<DesktopRecord, "cwd" | "worktreePath">): boolean {
  return Boolean(record.worktreePath) || Boolean(record.cwd?.includes("/.claude/worktrees/"));
}

export function readRecord(file: string): DesktopRecord | null {
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as DesktopRecord;
    if (typeof record.sessionId !== "string" || typeof record.cliSessionId !== "string") return null;
    for (const key of ["createdAt", "lastActivityAt", "latestUserFrameAt"] as const) {
      const value = toMs(record[key]);
      if (value === undefined) delete record[key];
      else record[key] = value;
    }
    // a session opened through the server's alias of its own worktree
    // (own-worktrees.ts ownLinkPath) is about the worktree itself
    for (const key of ["cwd", "worktreePath"] as const) {
      const folder = record[key];
      if (typeof folder === "string") record[key] = canonicalFolder(folder);
    }
    return record;
  } catch {
    return null;
  }
}

export function readDesktopRecord(localId: string, dir = DESKTOP_SESSIONS_DIR): DesktopRecord | null {
  for (const file of recordFiles(dir)) if (file.endsWith(`/${localId}.json`)) return readRecord(file);
  return null;
}

/** The repository a session's folder belongs to (a worktree's parent repo). */
export function repoOf(record: Pick<DesktopRecord, "cwd" | "worktreePath">): string | undefined {
  const folder = record.worktreePath ?? record.cwd;
  if (!folder) return undefined;
  const at = folder.indexOf("/.claude/worktrees/");
  return at >= 0 ? folder.slice(0, at) : folder;
}

/** A session whose folder was not picked for work: a run of a scheduled
 * task (it opens in its own folder) or a scratch workspace. */
export function notPickedFolder(record: Pick<DesktopRecord, "scheduledTaskId" | "cwd">): boolean {
  return Boolean(record.scheduledTaskId) || Boolean(record.cwd?.includes("/scratch-workspaces/"));
}

/** The repository of the app's most recent work session: New Session opens
 * in the last folder picked, whatever we would like. Scheduled runs and
 * scratch sessions do not move that folder, so they are skipped. */
export function lastAppRepo(dir = DESKTOP_SESSIONS_DIR): string | undefined {
  let newest: DesktopRecord | null = null;
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (record && !notPickedFolder(record) && (record.createdAt ?? 0) > (newest?.createdAt ?? -1)) newest = record;
  }
  return newest ? repoOf(newest) : undefined;
}

/** The app is reusing worktrees: its newest work session opened in a
 * worktree folder that an OLDER session (archived ones included) had used
 * already, and the next New Session with the worktree on may land in an
 * old folder again. null when the newest session is in a repository root
 * or in a worktree of its own (no one used the folder before it).
 *
 * The cause is NOT "the last picked folder is that worktree": the folder
 * picked (`originCwd`) is the repository root in every record on this Mac
 * (390/390 on 01/10, the reused ones included — R9-dispatch R9-1), and on
 * 02/10 10:07 the owner's own session started from the root with the
 * worktree on still landed in a folder four sessions had used
 * (R10-dispatch R10-1). What the records do prove: a newest session in the
 * ROOT (worktree off) makes this null, so that is the gesture asked of the
 * owner. A new session can still land in an old folder after that (the
 * first reuse, 01/10 09:53): the brief's first step stops it before it
 * touches anything (desktop-work.ts folderGuard), adoption marks it failed,
 * and this answers non-null again from that record on. `origin` is the
 * folder that was picked, for the diagnosis.
 *
 * `worktreeName` says nothing here: the app drops it when a session is
 * archived (163 of 179 archived worktree sessions on 01/10 have it null,
 * the ones it created right included), and a reused folder can carry it
 * (local_0a000005 in the folder of local_0a000004). */
export function lastAppWorktreeFolder(dir = DESKTOP_SESSIONS_DIR): { folder: string; title?: string; earlier: string[]; origin?: string } | null {
  const records: DesktopRecord[] = [];
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (record) records.push(record);
  }
  const newest = records.filter((record) => !notPickedFolder(record)).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  const folder = newest ? newest.worktreePath ?? newest.cwd : undefined;
  if (!newest || !folder || !/\/\.(?:claude\/)?worktrees\//.test(folder)) return null;
  const earlier = records.filter((record) => record.sessionId !== newest.sessionId && (record.cwd === folder || record.worktreePath === folder) && (record.createdAt ?? 0) < (newest.createdAt ?? 0));
  if (!earlier.length) return null;
  return {
    folder, ...(newest.title ? { title: newest.title } : {}), earlier: earlier.map((record) => record.title ?? record.sessionId),
    ...(newest.originCwd && newest.originCwd !== folder ? { origin: newest.originCwd } : {}),
  };
}

/** The app's newest work session is one the SERVER opened and it landed in
 * the repository root, without a worktree: New Session came with the
 * worktree option off (the owner's unblock gesture may leave it so), and
 * every create would land there again. The person's own root session is
 * not this (it is the gesture); only ours, by the local ids the ledger
 * adopted. null otherwise. */
export function lastServerSessionInRoot(serverLocalIds: ReadonlySet<string>, dir = DESKTOP_SESSIONS_DIR): { folder: string; title?: string } | null {
  let newest: DesktopRecord | null = null;
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (record && !notPickedFolder(record) && (record.createdAt ?? 0) > (newest?.createdAt ?? -1)) newest = record;
  }
  if (!newest || !newest.cwd || recordInWorktree(newest) || !serverLocalIds.has(newest.sessionId)) return null;
  return { folder: newest.cwd, ...(newest.title ? { title: newest.title } : {}) };
}

/** What cc_session_start answers (409) while the server's last session
 * landed in the root (lastServerSessionInRoot). */
export function rootFolderRefusal(last: { folder: string; title?: string }, repoName: string, fromQueue = false, ownPath = false): string {
  return [
    `não abri: a última sessão que o servidor abriu no app Claude${last.title ? ` ("${last.title}")` : ""} caiu na raiz (${last.folder}), sem worktree própria — o app está abrindo sessões novas com a worktree desligada, e a próxima cairia lá também, mexendo direto no checkout principal.`,
    // with the server's own worktrees (lote X) the option must stay OFF: never ask to turn it on (R12-1)
    ownPath
      ? `Neste repositório o servidor cria a pasta de cada sessão e abre o app nela, e para isso a opção worktree tem de ficar DESLIGADA: não peça ao dono para ligá-la. Esse caminho está suspenso pelo disjuntor; peça ao dono para deixar a opção worktree desligada e resolver o item "O app Claude abriu … sessões …" em "Precisa de você": o servidor volta a abrir as sessões na pasta dele.`
      : `Peça ao dono para, no app, abrir Arquivo → Nova sessão na pasta ${repoName}, LIGAR a opção worktree e enviar uma mensagem curta: o app só grava a sessão depois do primeiro envio. Quando a sessão dele abrir numa worktree nova, o servidor volta a abrir sessões no app sozinho.`,
    fromQueue
      ? `Este pedido veio da fila de sessões e continua nela: o servidor tenta de novo sozinho a cada 5 min e desiste, com aviso, depois de 24 h falhando. Se não der para esperar, use surface "cli" com cli_reason.`
      : `Então tente de novo. Se não der para esperar, use surface "cli" com cli_reason.`,
  ].join(" ");
}

/** A session in the repository root the server can open before New
 * Session, so the new session does not start from a worktree session that
 * is on screen (the R9-dispatch hypothesis for the reuse: New Session with
 * a worktree session open inherits its folder). The newest one not
 * archived, in the root itself, not a scheduled run or scratch; null when
 * there is none (the create then goes as before). Never one the server
 * opened (`ours`, the ledger's local ids): a create of ours that fell in the
 * root is failed and left there, and as the newest it would be picked —
 * the next New Session then inherits the root it fell into (INSP-S r1 S-3).
 * Only the person's own root session (the unblock gesture) anchors. */
export function rootAnchorSession(repo: string, dir = DESKTOP_SESSIONS_DIR, ours: ReadonlySet<string> = new Set()): { localId: string; title?: string } | null {
  let newest: DesktopRecord | null = null;
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (!record || record.isArchived || notPickedFolder(record) || record.cwd !== repo || record.worktreePath) continue;
    if (!/^local_[0-9a-f-]{36}$/.test(record.sessionId) || ours.has(record.sessionId)) continue;
    if ((record.createdAt ?? 0) > (newest?.createdAt ?? -1)) newest = record;
  }
  return newest ? { localId: newest.sessionId, ...(newest.title ? { title: newest.title } : {}) } : null;
}

/** Folders the app's sessions not archived work in (their cwd and worktree). */
export function liveRecordFolders(dir = DESKTOP_SESSIONS_DIR): string[] {
  const folders = new Set<string>();
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (!record || record.isArchived) continue;
    if (record.cwd) folders.add(record.cwd);
    if (record.worktreePath) folders.add(record.worktreePath);
  }
  return [...folders];
}

/** What cc_session_start answers (409) while the app is reusing worktrees.
 * `fromQueue`: the start waited in the session queue and is dropped here —
 * the bot must start it again once the person fixed the app's folder. */
export function reusedFolderRefusal(last: { folder: string; title?: string; earlier: string[]; origin?: string }, repoName: string, fromQueue = false): string {
  const earlier = [...new Set(last.earlier)].slice(0, 3).map((title) => `"${title}"`).join(", ");
  return [
    `não abri: a sessão mais recente do app Claude${last.title ? ` ("${last.title}")` : ""} abriu em ${last.folder}, pasta que já era de ${earlier}${last.origin ? `, embora a pasta escolhida ao abri-la fosse ${last.origin}` : ""}. O app está reaproveitando worktrees e abriria a sessão nova lá também.`,
    // the gesture the records prove: a newest session in the repository ROOT
    // (worktree off) ends the reuse (lastAppWorktreeFolder is null for it);
    // "worktree ligada" fell into a reused worktree again (R10-dispatch R10-1)
    `Peça ao dono para iniciar no app uma sessão nova (Arquivo → Nova sessão) na raiz de ${repoName} (pasta ${repoName}, com a worktree DESLIGADA) e enviar nela uma mensagem curta: o app só grava a sessão depois do primeiro envio, então abrir e fechar sem enviar não muda nada. Ela não precisa ser arquivada: o servidor parte dela para abrir as sessões novas.`,
    fromQueue
      ? `Este pedido veio da fila de sessões e continua nela: o servidor tenta de novo sozinho a cada 5 min e desiste, com aviso, depois de 24 h falhando. Se não der para esperar, use surface "cli" com cli_reason.`
      : `Então tente de novo. Se não der para esperar, use surface "cli" com cli_reason.`,
  ].join(" ");
}

/** Worktree names of the app's sessions (archived ones too with `includeArchived`:
 * the app reopens the folder of an archived session as well). */
export function liveWorktreeNames(dir = DESKTOP_SESSIONS_DIR, includeArchived = false): string[] {
  const names: string[] = [];
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (!record || (record.isArchived && !includeArchived)) continue;
    const name = record.worktreeName ?? (record.worktreePath ?? record.cwd ?? "").split("/.claude/worktrees/")[1];
    if (name) names.push(name);
  }
  return names;
}

/** App sessions, not archived (or archived too), working in `folder` (the app reuses worktrees). */
export function recordsUsingFolder(folder: string, exceptLocalId?: string, dir = DESKTOP_SESSIONS_DIR, includeArchived = false): DesktopRecord[] {
  const found: DesktopRecord[] = [];
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (!record || (record.isArchived && !includeArchived) || record.sessionId === exceptLocalId) continue;
    if (record.cwd === folder || record.worktreePath === folder) found.push(record);
  }
  return found;
}

export function transcriptPath(record: Pick<DesktopRecord, "cliSessionId">, projects = CLAUDE_PROJECTS_DIR): string | null {
  if (!existsSync(projects)) return null;
  for (const project of readdirSync(projects)) {
    const candidate = join(projects, project, `${record.cliSessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The session created from our brief: newer than `since`, marker in its transcript. */
export function findDesktopSession(marker: string, since: number, dir = DESKTOP_SESSIONS_DIR, projects = CLAUDE_PROJECTS_DIR): DesktopRecord | null {
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (!record || (record.createdAt ?? 0) < since) continue;
    const transcript = transcriptPath(record, projects);
    if (!transcript) continue;
    try {
      if (readFileSync(transcript, "utf8").slice(0, 400_000).includes(marker)) return record;
    } catch { /* being written; next tick */ }
  }
  return null;
}

/** The last thing the session said, from its transcript. */
export function lastAssistantText(transcript: string, max = 6_000): string {
  let raw = "";
  try {
    raw = readFileSync(transcript, "utf8");
  } catch {
    return "";
  }
  const lines = raw.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as { type?: string; message?: { content?: unknown } };
      if (event.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
      const text = (event.message!.content as Array<{ type?: string; text?: string }>)
        .filter((part) => part?.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      if (text) return text.slice(0, max);
    } catch { /* partial line */ }
  }
  return "";
}

/** Did our message reach the session? A user event written after `since`
 * (5 s of clock slack) carries its first line. Older messages and the
 * assistant's own words do not count: openings like "Chief aqui." repeat. */
export function transcriptMentions(transcript: string, text: string, since = 0): boolean {
  const first = text.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 60);
  if (!first) return false;
  const needle = JSON.stringify(first).slice(1, -1);
  let raw = "";
  try {
    raw = readFileSync(transcript, "utf8").slice(-2_000_000);
  } catch {
    return false;
  }
  const lines = raw.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"user"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; timestamp?: string; message?: { content?: unknown } };
      if (event.type !== "user") continue;
      const at = event.timestamp ? Date.parse(event.timestamp) : NaN;
      if (Number.isFinite(at) && at < since - 5_000) return false;
      if (JSON.stringify(event.message?.content ?? "").includes(needle)) return true;
    } catch { /* partial line */ }
  }
  return false;
}

/** Did the session's last turn end? Its transcript's latest event closes a
 * turn (the stop hook's summary, or an assistant message that ended the turn). */
export function transcriptTurnEnded(transcript: string): boolean {
  let raw = "";
  try {
    raw = readFileSync(transcript, "utf8").slice(-400_000);
  } catch {
    return false;
  }
  const lines = raw.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as { type?: string; subtype?: string; message?: { stop_reason?: string } };
      if (event.type === "system" && (event.subtype === "stop_hook_summary" || event.subtype === "turn_duration")) return true;
      if (event.type === "assistant") return event.message?.stop_reason === "end_turn";
      if (event.type === "user") return false;
      // other system/meta lines: look further back
    } catch { /* partial line */ }
  }
  return false;
}

/** A question the session asked in the app (AskUserQuestion) that nobody
 * has answered: its tool_use has no tool_result after it. The session is
 * stopped on it and reads nothing else until someone answers in the app. */
export function transcriptOpenQuestion(transcript: string): { id: string; text: string } | null {
  let raw = "";
  try {
    raw = readFileSync(transcript, "utf8").slice(-1_000_000);
  } catch {
    return null;
  }
  const answered = new Set<string>();
  const lines = raw.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as { type?: string; message?: { content?: unknown } };
      const content = Array.isArray(event.message?.content) ? event.message!.content as Array<Record<string, unknown>> : [];
      if (event.type === "user") {
        for (const part of content) if (part?.type === "tool_result" && typeof part.tool_use_id === "string") answered.add(part.tool_use_id);
        continue;
      }
      if (event.type !== "assistant") continue;
      const ask = content.find((part) => part?.type === "tool_use" && part.name === "AskUserQuestion");
      if (!ask) continue;
      const id = String(ask.id ?? "");
      if (answered.has(id)) return null;
      return { id, text: questionText(ask.input) };
    } catch { /* partial line */ }
  }
  return null;
}

export function questionText(input: unknown): string {
  const questions = (input as { questions?: Array<{ question?: unknown; options?: Array<{ label?: unknown }> }> } | undefined)?.questions;
  if (!Array.isArray(questions) || !questions.length) return JSON.stringify(input ?? "").slice(0, 1_000);
  return questions.map((item) => {
    const options = Array.isArray(item.options) ? item.options.map((option) => String(option?.label ?? "")).filter(Boolean) : [];
    return `${String(item.question ?? "").trim()}${options.length ? ` [opções: ${options.join(" / ")}]` : ""}`;
  }).join("\n").slice(0, 2_000);
}

/** When the transcript was last written, or null. */
export function transcriptWrittenAt(transcript: string): number | null {
  try {
    return statSync(transcript).mtimeMs;
  } catch {
    return null;
  }
}

function* recordFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const org of readdirSync(dir)) {
    const orgDir = join(dir, org);
    if (!statSync(orgDir).isDirectory()) continue;
    for (const account of readdirSync(orgDir)) {
      const accountDir = join(orgDir, account);
      if (!statSync(accountDir).isDirectory()) continue;
      for (const file of readdirSync(accountDir)) if (/^local_.+\.json$/.test(file)) yield join(accountDir, file);
    }
  }
}
