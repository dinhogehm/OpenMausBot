// The owner's standing goal for the Chief — "manter a esteira andando":
// whenever the gate's queue is free and no release runs, take the next P1 —
// had no trigger. On 04/10 the queue drained at 20:12; the Chief's watches
// fire only when main or the production tag move, so nothing woke it, and
// #8675 and #9058 (P1, open, no live session) waited the whole night until
// the owner wrote at 09:34 (R11-followup #1, R12-followup #1).
//
// The server now notices the pipeline standing still: no open PR (drafts
// aside), no release on its way, and P0/P1 issues open with no live session
// and no bot naming them for 24 h. It wakes the Chief ONCE for that, with a
// report listing them — never while ~/.nuria/stop exists, at most once every
// 6 h, and within 24 h again only when an issue it was not told of joins the
// list. The Chief has no night silence configured (bots.json, routines.json):
// none is assumed.
import { sessionForNumber } from "./watch-reason-refs.ts";

export const PIPELINE_IDLE_PREFIX = "[Servidor: esteira parada]";
/** At most one report in this long. */
export const PIPELINE_IDLE_GAP_MS = 6 * 3_600_000;
/** An issue a bot named, or whose session moved, within this long is not standing still; the same list is not sent twice within it. */
export const PIPELINE_IDLE_QUIET_MS = 24 * 3_600_000;
/** Issues listed by name; the rest are counted. */
export const PIPELINE_IDLE_LIST_MAX = 12;
/** How often the server looks (GitHub is asked twice each time). */
export const PIPELINE_IDLE_EVERY_MS = 10 * 60_000;

export interface IdleIssue {
  number: number;
  title: string;
  priority: "p0" | "p1";
  createdAt: number;
}

/** A session as the ledger keeps it (cc-sessions.ts). */
export interface IdleSession {
  title: string;
  status: string;
  lastActivityAt: number;
  createdAt?: number;
}

export interface IdleCandidate extends IdleIssue {
  /** Its session, when it has one that is not live (idle, stopped or stalled for a day). */
  stale?: { title: string; status: string; lastActivityAt: number };
}

/** `gh issue list` for the open P0/P1 (a search with two labels is OR). */
export function idleIssuesArgs(repo: string): string[] {
  return ["issue", "list", "-R", repo, "--state", "open", "--search", 'label:"priority:p0","priority:p1"', "--json", "number,title,labels,createdAt", "--limit", "100"];
}

/** `gh pr list` for the open PRs: the gate's queue. */
export function idlePrsArgs(repo: string): string[] {
  return ["pr", "list", "-R", repo, "--state", "open", "--json", "number,isDraft,updatedAt", "--limit", "100"];
}

/** The open P0/P1 from `gh issue list --json number,title,labels,createdAt`; null when unreadable. */
export function parseIdleIssues(json: string): IdleIssue[] | null {
  let rows: unknown;
  try { rows = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const out: IdleIssue[] = [];
  for (const row of rows as Array<Record<string, any>>) {
    if (!row || typeof row.number !== "number") continue;
    const labels: string[] = Array.isArray(row.labels) ? row.labels.map((label: any) => String(label?.name ?? "").toLowerCase()) : [];
    const priority = labels.includes("priority:p0") ? "p0" : labels.includes("priority:p1") ? "p1" : null;
    // blocked: waiting on something else, not standing still (INSP-R12F F5: #9027)
    if (!priority || labels.includes("status:blocked")) continue;
    out.push({ number: row.number, title: String(row.title ?? ""), priority, createdAt: Number.isFinite(Date.parse(row.createdAt)) ? Date.parse(row.createdAt) : 0 });
  }
  return out;
}

/** How many open PRs keep the pipeline moving: not drafts, and touched in
 * the last day — a PR forgotten for days is the pipeline standing still,
 * not moving (INSP-R12F F5). One without a date counts. Null when unreadable. */
export function parseOpenPrCount(json: string, now: number): number | null {
  let rows: unknown;
  try { rows = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const recent = (row: any) => !Number.isFinite(Date.parse(row.updatedAt)) || now - Date.parse(row.updatedAt) < PIPELINE_IDLE_QUIET_MS;
  return rows.filter((row: any) => row && typeof row.number === "number" && !row.isDraft && recent(row)).length;
}

/** The issues an open "Precisa de você" item names: waiting on the owner, not on the Chief. */
export function heldByOwner(items: ReadonlyArray<{ title: string; why?: string; link?: string; steps?: ReadonlyArray<{ text: string; command?: string; link?: string }> }>): Set<number> {
  return mentionedNumbers(items.map((item) => [item.title, item.why ?? "", item.link?.replace(/^.*\/(?:issues|pull)\/(\d+).*$/, "#$1") ?? "", ...(item.steps ?? []).map((step) => step.text)].join("\n")));
}

/** The release as last read (index.ts releaseHold): in flight, none, or
 * unknown — never read yet, being read, or older than `maxAgeMs` (a restart
 * reads it fresh) counts as unknown, and unknown wakes nobody (INSP-R12F F4). */
export function releaseInFlightOf(hold: { label: string | null; found: { overdue?: boolean } | null; at: number; running: boolean }, now: number, maxAgeMs: number): boolean | null {
  if (hold.at === 0 || hold.running || now - hold.at > maxAgeMs || hold.label === "?") return null;
  return hold.found !== null && !hold.found.overdue;
}

/** "#9058", "#8675" in what the bots wrote: the issues someone is on. */
export function mentionedNumbers(texts: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const text of texts) for (const match of text.matchAll(/#(\d{3,6})(?!\d)/g)) out.add(Number(match[1]));
  return out;
}

/** A session someone is on: running, or one that moved in the last day.
 * An idle one left for days is not (#9058's e47cf077, idle since 02/10). */
export function sessionLive(session: IdleSession, now: number): boolean {
  if (session.status === "archived" || session.status === "failed") return false;
  return session.status === "running" || now - session.lastActivityAt < PIPELINE_IDLE_QUIET_MS;
}

/** The P0/P1 standing still: no live session, no bot naming them in the last
 * day. P0 first, then the oldest — the owner's order on 02/10 was "P1 mais
 * antigas, começando pela #8675". */
export function idleCandidates(issues: readonly IdleIssue[], sessions: readonly IdleSession[], mentioned: ReadonlySet<number>, now: number): IdleCandidate[] {
  const out: IdleCandidate[] = [];
  for (const issue of issues) {
    if (mentioned.has(issue.number)) continue;
    const own = sessions.filter((session) => sessionForNumber([session], issue.number));
    if (own.some((session) => sessionLive(session, now))) continue;
    const stale = sessionForNumber(own.filter((session) => session.status !== "archived" && session.status !== "failed"), issue.number);
    out.push({ ...issue, ...(stale ? { stale: { title: stale.title, status: stale.status, lastActivityAt: stale.lastActivityAt } } : {}) });
  }
  return out.sort((a, b) => (a.priority === b.priority ? a.createdAt - b.createdAt || a.number - b.number : a.priority === "p0" ? -1 : 1));
}

/** What the server remembers between looks (DATA_DIR/pipeline-idle.json). */
export interface PipelineIdleState {
  /** When it last woke the Chief, and for which issues. */
  lastAt?: number;
  lastNumbers?: number[];
}

export interface PipelineIdleInput {
  /** ~/.nuria/stop exists. */
  stopped: boolean;
  /** Open PRs in the queue; null when GitHub could not be read. */
  openPrs: number | null;
  /** A release on its way; null when that could not be read. */
  releaseInFlight: boolean | null;
  candidates: readonly IdleCandidate[];
  now: number;
  /** Why something is unknown ("gh pr list falhou: …"), said in the why. */
  unknown?: string;
}

/** One look: whether to wake the Chief now, and the state to keep. Anything
 * unknown (GitHub, the release) wakes nobody. Once told, the Chief hears
 * again only after 6 h and only of an issue it was not told of — the same
 * issues (or fewer: some taken) come back only after 24 h, when nobody has
 * named them for a whole day since. */
export function pipelineIdleStep(state: PipelineIdleState, input: PipelineIdleInput): { state: PipelineIdleState; wake: boolean; why: string } {
  if (input.openPrs === null || input.releaseInFlight === null) return { state, wake: false, why: `estado desconhecido${input.unknown ? ` (${input.unknown})` : ""}` };
  if (input.openPrs > 0) return { state, wake: false, why: `${input.openPrs} PR(s) na fila` };
  if (input.releaseInFlight) return { state, wake: false, why: "release em curso" };
  if (input.stopped) return { state, wake: false, why: "~/.nuria/stop" };
  if (!input.candidates.length) return { state, wake: false, why: "nenhuma P0/P1 parada" };
  const numbers = input.candidates.map((each) => each.number).sort((a, b) => a - b);
  const since = state.lastAt === undefined ? Infinity : input.now - state.lastAt;
  if (since < PIPELINE_IDLE_GAP_MS) return { state, wake: false, why: "avisado há menos de 6 h" };
  const last = new Set(state.lastNumbers ?? []);
  if (since < PIPELINE_IDLE_QUIET_MS && numbers.every((each) => last.has(each))) return { state, wake: false, why: "as mesmas issues já foram avisadas há menos de 24 h" };
  return { state: { lastAt: input.now, lastNumbers: numbers }, wake: true, why: "esteira parada" };
}

/** The log line of one look, only when its why changed since the last one
 * (R13-followup #5: only a wake was logged, so a `gh` that failed every
 * time and a queue that never emptied read the same — nothing). */
export function pipelineIdleLogLine(last: string | undefined, why: string): string | null {
  return why === last ? null : `[pipeline-idle] ${last === undefined ? "" : `${last} -> `}${why}`;
}

const day = (ms: number) => new Date(ms).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });

/** The order this report serves, when the owner gave it ("manter a esteira andando"). */
export function pipelineOrder<T extends { at: number; text: string }>(orders: readonly T[]): T | null {
  return [...orders].sort((a, b) => b.at - a.at).find((order) => /esteira andando|fila do gate (?:estiver |est[aá] )?livre/i.test(order.text)) ?? null;
}

/** The report the Chief reads (the server's voice, in pt-BR). */
export function pipelineIdleReport(candidates: readonly IdleCandidate[], repo: string, order: { at: number; text: string } | null): string {
  const listed = candidates.slice(0, PIPELINE_IDLE_LIST_MAX).map((issue) => {
    const opened = issue.createdAt ? `, aberta em ${day(issue.createdAt)}` : "";
    const stale = issue.stale ? `; sessão «${issue.stale.title.slice(0, 60)}» ${issue.stale.status} desde ${day(issue.stale.lastActivityAt)}` : "; sem sessão";
    return `- #${issue.number} (${issue.priority.toUpperCase()}${opened}${stale}): ${issue.title.replace(/\s+/g, " ").trim().slice(0, 100)}`;
  });
  const more = candidates.length > PIPELINE_IDLE_LIST_MAX ? [`- … e mais ${candidates.length - PIPELINE_IDLE_LIST_MAX} (gh issue list -R ${repo} --state open --search 'label:"priority:p0","priority:p1"').`] : [];
  const said = order ? `Ordem do dono de ${day(order.at)}: «${order.text.replace(/\s+/g, " ").trim().slice(0, 240)}». ` : "";
  return [
    `${PIPELINE_IDLE_PREFIX} A fila de PRs abertas do ${repo} está vazia e não há release em curso. Estas P0/P1 estão abertas sem sessão viva e sem menção de nenhum bot nas últimas 24 h (P0 primeiro, depois as mais antigas):`,
    ...listed,
    ...more,
    `${said}Pegue a próxima: retome ou abra a sessão dela e avise o dono no canal, em uma linha. Se nenhuma deve andar agora, diga ao dono por quê; se depender dele, abra um item (owner_pending) com as opções. Este aviso não volta para as mesmas issues nas próximas 24 h.`,
  ].join("\n");
}
