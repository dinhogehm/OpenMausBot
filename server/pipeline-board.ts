// "Esteira" (lot Z): builds the delivery pipeline board — Entrada, Sessão,
// PR aberta, Gate, Release, Produção — from the productivity collector's
// cache (issues, merged PRs, the release log, the compares that say what
// each release carried) and the live state the server holds (Claude Code
// sessions, the open PRs read for the board, the ci:local receipts in the
// sessions' worktrees, the admission lease and intents, "Precisa de você").
//
// Pure and deterministic: the same inputs give the same board, cards in the
// same order. A card is one piece of work: an issue together with the
// sessions and PRs that name it — joined only by explicit references (a PR's
// Closes/Fixes/Refs, a session's PR by its branch or by hand-over, the issue
// number a session's title opens with). Its stage is the least advanced of
// its unfinished parts; what it waits on comes from the data, never guessed.
import { BOARD_STAGES, ENTRY_CAP, ENTRY_DORMANT_MS, ENTRY_RECENT_MS, PRODUCTION_WINDOW_MS, stageLimitMs, type BoardCard, type BoardColumn, type BoardGateStatus, type BoardOwnerItem, type BoardPriority, type BoardReason, type BoardStage, type CardState, type PipelineBoard } from "../shared/pipeline-board.ts";
import { OWNER_PENDING_AWAIT_MS } from "./bot-autonomy.ts";
import { CC_ACTIVE_MS, clientIssue } from "./cc-sessions.ts";
import { issuePriority, isCarrier, type GateState, type GhCache, type GhIssue, type GhPr } from "./productivity-github.ts";
import type { ReleaseRun } from "./productivity-release-log.ts";
import { buildTimeline } from "./productivity-report.ts";

// ── inputs ──────────────────────────────────────────────────────────────────

/** A PR as the board's own read sees it (open, or merged lately). */
export interface LivePr {
  number: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  base: string;
  head: string;
  headSha: string | null;
  mergeSha: string | null;
  gate: GateState;
  gateAt: number | null;
  /** GitHub's mergeStateStatus (BEHIND, DIRTY, BLOCKED, CLEAN…); null when GitHub has not computed it. */
  mergeState: string | null;
  closes: number[];
  refs: number[];
  labels: string[];
}

/** The fields of a Claude Code session the board reads. */
export interface BoardSession {
  id: string;
  ownerBotId: string;
  ownerThreadId: string;
  replyThreadId?: string;
  title: string;
  status: string;
  surface?: string;
  /** Its worktree: where its last ci:local receipt is. */
  cwd?: string;
  createdAt: number;
  lastActivityAt: number;
  progressAt?: number;
  failedAt?: number;
  lastError?: string;
  blockedOn?: string;
  archivedAt?: number;
  resumeAfterTag?: { releaseSha?: string } | object;
  desktop?: { localId?: string; issue?: string; pending?: { kind: string; since: number } };
  delivery?: { prs: Record<string, { number: number; state?: string; owned?: string; mergeSha?: string; inProductionAt?: number }> };
  claimedPrs?: number[];
}

export interface BoardOwnerPending {
  id: string;
  botId: string;
  threadId: string;
  title: string;
  createdAt: number;
  link?: string;
  command?: string;
  why?: string;
  steps?: ReadonlyArray<{ text: string; command?: string; link?: string }>;
  awaitingSince?: number;
}

export interface BoardInputs {
  now: number;
  repo: string;
  /** The productivity collector's GitHub cache; null when it was never synced. */
  github: Pick<GhCache, "prs" | "issues" | "openPrs" | "compares" | "deployments" | "syncedAt"> | null;
  /** The board's own read of open and recently merged PRs; null before the first one. */
  live: { at: number; open: LivePr[]; merged: LivePr[] } | null;
  /** The last live read failed (the board keeps the one before, or the collector's cache). */
  liveError?: string | null;
  runs: readonly ReleaseRun[];
  logCoverage: { from: number | null; to: number | null };
  sessions: readonly BoardSession[];
  ownerPending: readonly BoardOwnerPending[];
  botNames: ReadonlyMap<string, string>;
  /** A production release on its way on this Mac (lease/intent), as the server last read it. */
  releaseHold: string | null;
  /** The admission lease's holder and the intents queued for the machine, by label ("local-ci:<short sha>", "release:production:<sha>"). */
  admission: { lease: { kind: string; label: string } | null; intents: readonly string[] };
  /** The last ci:local receipt in each session's worktree. */
  receipts: Readonly<Record<string, { commit: string; finishedAt: number | null }>>;
}

// ── titles without names ────────────────────────────────────────────────────

const DATE = String.raw`\d{1,2}\/\d{1,2}(?:\/\d{2,4})?`;
const NAME = String.raw`\p{Lu}\p{Ll}{2,}`;
/** Uppercase words that are not a client (a tenant is named in capitals: "do PIPERUN"). */
const ACRONYMS = new Set(["CSAT", "JSON", "HTTP", "HTTPS", "HTML", "SMTP", "IMAP", "UUID", "CORS", "SAML", "OAUTH", "LGPD", "SLA", "CRUD", "REST", "WABA", "NPS", "SSO", "UTC", "BRT", "CPU", "PDF", "CSV", "DNS", "SSL", "TLS", "URL", "APIS", "NODE", "SQLITE", "MIGRATION", "TODO", "WIP", "PLG", "AAQA"]);

export interface NameDictionary {
  people: ReadonlySet<string>;
  tenants: ReadonlySet<string>;
}

/** Requesters and clients named in the titles themselves — "(Daiane 01/10)",
 * "— Marluce 30/09", "(Filipe, planilha L110)", "Relato do Matheus", "do
 * PIPERUN" — so a name is removed wherever it appears, even where no date
 * follows it. Built over every title the board may show. */
export function nameDictionary(texts: Iterable<string>): NameDictionary {
  const people = new Set<string>();
  const tenants = new Set<string>();
  const groupBeforeDate = new RegExp(String.raw`((?:${NAME}\s*\/\s*)*${NAME}),?\s+${DATE}`, "gu");
  const groupBeforeSheet = new RegExp(String.raw`\((${NAME}),\s*(?:planilha|linha|L\d)`, "gu");
  const reported = new RegExp(String.raw`(?:[Rr]elato|[Rr]elatad[oa]|[Rr]eportad[oa]|[Pp]edido|[Qq]uem pediu foi)\s+(?:d[oa]|pel[oa]|por|de|[oa])\s+(${NAME})|(?<![\p{L}])[Cc]lientes?\s+(${NAME})(?![\p{L}])`, "gu");
  // a client is named as one somewhere ("tenant PIPERUN", "cliente ACME"): then it goes from
  // every title, also where nothing marks it ("derruba o D1 do PIPERUN"). Capitals alone are
  // not a client ("NEGATIVA", "ABORTAR", "FORBIDDEN_WORDS" are emphasis or code)
  const tenant = /(?<![\p{L}\d_])(?:[Tt]enant|[Cc]liente|[Ww]orkspace)\s+([A-Z][A-Z0-9]{3,})(?![\p{L}\d_])/gu;
  for (const text of texts) {
    for (const match of text.matchAll(groupBeforeDate)) for (const name of match[1]!.split("/")) people.add(name.trim());
    for (const match of text.matchAll(groupBeforeSheet)) people.add(match[1]!);
    for (const match of text.matchAll(reported)) people.add((match[1] ?? match[2])!);
    for (const match of text.matchAll(tenant)) if (!ACRONYMS.has(match[1]!)) tenants.add(match[1]!);
  }
  return { people, tenants };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A client's name in any case, as a whole word (hyphens and underscores split words: "piperun-crm"). */
const tenantPattern = (name: string, flags = "") => new RegExp(`(?<![\\p{L}\\d])${escape(name)}(?![\\p{L}\\d])`, `iu${flags}`);
const TITLE_MAX = 90;

/** A card's title: no leading issue numbers, no "fix(scope):", no requester
 * or client (their parenthesis or dash tail goes whole, with its date, its
 * spreadsheet row, its ticket), at most TITLE_MAX characters. */
export function boardTitle(raw: string, names: NameDictionary): string {
  const named = (text: string) => [...names.people].some((name) => new RegExp(`(?<![\\p{L}])${escape(name)}(?![\\p{L}])`, "u").test(text))
    || [...names.tenants].some((name) => tenantPattern(name).test(text));
  const sensitive = (text: string) => new RegExp(String.raw`#\d|\bref\b|planilha|(?<![\p{L}])L\d{1,4}(?![\p{L}\d])|linha \d|ticket \d|${DATE}|(?<![\p{L}])cliente`, "iu").test(text) || named(text);
  let text = raw.replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:#?\d{3,6}(?!\d)[\s,]+)+(?=\S)/, "");
  text = text.replace(/^(?:feat|fix|chore|perf|refactor|docs|test|ci|build|style|hotfix|ops|revert)(?:\([^)]*\))?!?:\s+/i, "");
  // a parenthesis about who asked, when, where (row, ticket) or which issue: whole
  for (let before = ""; before !== text;) { before = text; text = text.replace(/\s*\(([^()]*)\)/gu, (whole, inner: string) => (sensitive(inner) ? "" : whole)); }
  // a dash tail of the same kind: "— Marluce 30/09", "— reprovação linha 106"
  for (let before = ""; before !== text;) { before = text; text = text.replace(/\s+[—–-]\s+([^—–]*)$/u, (whole, tail: string) => (sensitive(tail) ? "" : whole)); }
  for (const name of names.people) text = text.replace(new RegExp(`\\s*(?:(?<![\\p{L}])(?:d[oa]|pel[oa]|por|com)\\s+)?(?<![\\p{L}])${escape(name)}(?![\\p{L}])`, "gu"), "");
  // in any case and inside a name ("PipeRun", "piperun-crm"): the client, not its spelling
  for (const name of names.tenants) text = text.replace(tenantPattern(name, "g"), "cliente");
  text = text.replace(/\s+([,.;:!?)])(?=\s|$)/g, "$1").replace(/\(\s*\)/g, "").replace(/[\s,;:—–-]+$/u, "").replace(/\s{2,}/g, " ").trim();
  if (!text) return "—";
  text = text[0]!.toLocaleUpperCase("pt-BR") + text.slice(1);
  if (text.length <= TITLE_MAX) return text;
  const cut = text.slice(0, TITLE_MAX - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), TITLE_MAX - 20)).replace(/[\s,;:—–-]+$/u, "")}…`;
}

/** The Atendimento spreadsheet row a text names ("planilha L110", "(L99)", "linha 106"). */
export function sheetRowOf(text: string): number | null {
  const match = /planilha\s+(?:L|linha\s*)(\d{1,4})\b|linha\s+(\d{1,4})\s+da\s+planilha|\((?:[^()]*?,\s*)?L(\d{1,4})\)|reprova\S*\s+(?:da\s+)?linha\s+(\d{1,4})|linha nova da #\d+ na planilha/iu.exec(text);
  if (!match) return null;
  const value = match.slice(1).find((group) => group !== undefined);
  return value ? Number(value) : null;
}

/** Brought by a client: a requester or client named, a spreadsheet row, a
 * client's ticket or conversation, or a brief clientIssue() reads as one. */
export function isClientWork(texts: readonly string[], names: NameDictionary): boolean {
  return texts.some((text) => clientIssue(text)
    || sheetRowOf(text) !== null
    // a client's ticket or conversation, or the spreadsheet's "Reprovado" (the client did not accept it)
    || /(?<![\p{L}])(?:ticket\s+\d{5,}|ATD-\d{6}-\d{3,4}|Reprovad[oa](?![\p{L}]))/u.test(text)
    || new RegExp(String.raw`(?:${NAME})(?:\s*\/\s*${NAME})*,?\s+${DATE}`, "u").test(text) && [...names.people].some((name) => text.includes(name))
    || [...names.tenants].some((name) => tenantPattern(name).test(text)));
}

// ── references ──────────────────────────────────────────────────────────────

/** The issue numbers a session's title opens with ("9334 9331 Inatividade"), or its recorded issue. */
export function sessionIssues(session: Pick<BoardSession, "title" | "desktop">): number[] {
  const lead = /^\s*((?:#?\d{3,6}(?!\d)[\s,]+)+)/.exec(`${session.title} `)?.[1] ?? "";
  const numbers = [...lead.matchAll(/\d{3,6}/g)].map((match) => Number(match[0]));
  if (session.desktop?.issue && /^\d{3,6}$/.test(session.desktop.issue)) numbers.push(Number(session.desktop.issue));
  return [...new Set(numbers)];
}

/** A session's PRs: its own by branch, handed over, or kept from before ownership existed. */
export function sessionPrs(session: Pick<BoardSession, "delivery" | "claimedPrs">): number[] {
  const own = Object.values(session.delivery?.prs ?? {}).filter((pr) => pr.owned !== undefined).map((pr) => pr.number);
  return [...new Set([...own, ...(session.claimedPrs ?? [])])];
}

/** The issues, PRs and sessions an owner item names: #N, /pull/N, /issues/N, "PR N", a session id. */
export function itemCites(item: BoardOwnerPending): { numbers: Set<number>; text: string } {
  const text = [item.title, item.why, item.link, item.command, ...(item.steps ?? []).flatMap((step) => [step.text, step.command, step.link])].filter(Boolean).join(" \n ");
  const numbers = new Set<number>();
  for (const match of text.matchAll(/#(\d{3,6})(?!\d)|\/(?:pull|issues)\/(\d{3,6})(?!\d)|\b(?:PR|issue)\s+#?(\d{3,6})(?!\d)/giu)) numbers.add(Number(match[1] ?? match[2] ?? match[3]));
  return { numbers, text };
}

/** "local-ci:407e3f9" names this head. */
const labelNamesHead = (label: string, head: string | null) => {
  const sha = /^local-ci:([0-9a-f]{7,40})$/.exec(label.trim())?.[1];
  return Boolean(sha && head && head.startsWith(sha));
};

// ── the board ───────────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<BoardPriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
const STATE_RANK: Record<CardState, number> = { owner: 0, blocked: 1, running: 2, queued: 3, idle: 4, done: 5 };
const RECENT_MERGE_MS = 21 * 24 * 3_600_000;
const SESSION_LIVE = new Set(["running", "stalled", "idle", "failed"]);

class Groups {
  private readonly parent = new Map<string, string>();
  add(key: string): void { if (!this.parent.has(key)) this.parent.set(key, key); }
  has(key: string): boolean { return this.parent.has(key); }
  find(key: string): string {
    this.add(key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // path halving keeps later finds short
    let at = key;
    while (this.parent.get(at) !== root) { const next = this.parent.get(at)!; this.parent.set(at, root); at = next; }
    return root;
  }
  join(a: string, b: string): void {
    const [x, y] = [this.find(a), this.find(b)];
    if (x === y) return;
    // the smaller key wins: the grouping does not depend on the order of the joins
    if (x < y) this.parent.set(y, x); else this.parent.set(x, y);
  }
  keys(): string[] { return [...this.parent.keys()]; }
}

interface PrView extends LivePr { delivered: { at: number; sha: string | null; inferred: boolean } | null }

const short = (sha: string) => sha.slice(0, 9);
const clip = (text: string | undefined, max = 160) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function buildPipelineBoard(input: BoardInputs): PipelineBoard {
  const { now, repo } = input;
  const github = input.github;
  const githubKnown = github !== null && github.syncedAt !== null;
  const issues: Record<string, GhIssue> = github?.issues ?? {};

  // ── PRs: the collector's, overlaid with the board's own live read ──
  const prs = new Map<number, LivePr>();
  for (const pr of Object.values(github?.prs ?? {})) prs.set(pr.number, fromCache(pr));
  const openNow = new Set<number>();
  if (input.live) {
    for (const pr of [...input.live.merged, ...input.live.open]) prs.set(pr.number, pr);
    for (const pr of input.live.open) openNow.add(pr.number);
    // open in the older cache, gone from the live open list and not seen merged: closed meanwhile (or unknown) — off the board
    for (const pr of prs.values()) if (pr.state === "OPEN" && !openNow.has(pr.number)) prs.set(pr.number, { ...pr, state: "CLOSED" });
  } else if (github) {
    for (const open of github.openPrs) {
      const known = prs.get(open.number);
      prs.set(open.number, { ...(known ?? fromCache(null, open.number)), number: open.number, title: open.title || known?.title || "", createdAt: open.createdAt, state: "OPEN", draft: open.draft, base: open.base, headSha: open.headSha, gate: open.gate, gateAt: open.gateAt, mergeState: null, mergedAt: null });
      openNow.add(open.number);
    }
  }

  // ── what reached production, and when ──
  const timeline = github ? buildTimeline({ runs: [...input.runs], github: github as GhCache, now, logCoverage: input.logCoverage }) : null;
  const releaseOfPr = new Map<number, { at: number; sha: string }>();
  for (const release of timeline?.releases ?? []) for (const pr of release.prs) if (!releaseOfPr.has(pr.number)) releaseOfPr.set(pr.number, { at: release.at, sha: release.sha });
  const sessionDelivered = new Map<number, number>();
  for (const session of input.sessions) for (const pr of Object.values(session.delivery?.prs ?? {})) if (pr.inProductionAt) sessionDelivered.set(pr.number, Math.min(sessionDelivered.get(pr.number) ?? Infinity, pr.inProductionAt));
  const runs = [...input.runs].filter((run) => run.startedAt !== null || run.endedAt !== null).sort((a, b) => (a.startedAt ?? a.endedAt!) - (b.startedAt ?? b.endedAt!));
  const successes = runs.filter((run) => run.outcome === "released" && run.endedAt !== null);
  const deliveredOf = (pr: LivePr): PrView["delivered"] => {
    if (pr.mergedAt === null) return null;
    const exact = releaseOfPr.get(pr.number);
    if (exact) return { at: exact.at, sha: exact.sha, inferred: false };
    const told = sessionDelivered.get(pr.number);
    if (told !== undefined) return { at: told, sha: null, inferred: false };
    // what a release carried is read later (compares): a release that STARTED after the merge
    // published a main that already had it — said as inferred, by the times
    const after = successes.find((run) => run.startedAt !== null && run.startedAt >= pr.mergedAt!);
    return after ? { at: after.endedAt!, sha: after.sha, inferred: true } : null;
  };
  const views = new Map<number, PrView>();
  for (const pr of prs.values()) {
    if (pr.base !== "main" || isCarrier(pr)) continue;
    if (pr.state === "OPEN") views.set(pr.number, { ...pr, delivered: null });
    else if (pr.state === "MERGED" && pr.mergedAt !== null && now - pr.mergedAt < RECENT_MERGE_MS) views.set(pr.number, { ...pr, delivered: deliveredOf(pr) });
  }

  // ── who names what ──
  const groups = new Groups();
  const sessions = input.sessions.filter((session) => SESSION_LIVE.has(session.status) || (session.status === "archived" && session.archivedAt !== undefined && now - session.archivedAt < PRODUCTION_WINDOW_MS));
  for (const session of sessions) {
    const key = `session:${session.id}`;
    groups.add(key);
    for (const number of sessionIssues(session)) groups.join(key, `issue:${number}`);
    for (const number of sessionPrs(session)) if (views.has(number)) groups.join(key, `pr:${number}`);
  }
  for (const pr of views.values()) {
    const key = `pr:${pr.number}`;
    groups.add(key);
    for (const number of new Set([...pr.closes, ...pr.refs])) {
      if (number === pr.number) continue;
      // an issue closed before this PR opened is history it cites ("Refs #9347" in lot W's
      // PR), not its work: joining there would fold unrelated work into one card
      const named = issues[String(number)];
      if (named && named.state === "CLOSED" && (named.closedAt ?? 0) < pr.createdAt) continue;
      groups.join(key, `issue:${number}`);
    }
  }
  const ownerItems = input.ownerPending.filter((item) => !(item.awaitingSince !== undefined && now - item.awaitingSince < OWNER_PENDING_AWAIT_MS));
  const cites = new Map(ownerItems.map((item) => [item, itemCites(item)]));
  const citedIssues = new Set([...cites.values()].flatMap((cite) => [...cite.numbers]));
  // Entrada: open issues that entered lately, urgent ones in motion, those on the delivery
  // track ("esteira") or waiting on the person; an urgent one quiet for weeks is backlog, counted
  let dormant = 0;
  for (const issue of Object.values(issues)) {
    if (issue.state !== "OPEN") continue;
    const priority = issuePriority(issue.labels);
    const urgent = priority === "p0" || priority === "p1";
    const quiet = now - issue.updatedAt >= ENTRY_DORMANT_MS;
    if (now - issue.createdAt < ENTRY_RECENT_MS || (urgent && !quiet) || (issue.labels.includes("esteira") && !quiet) || citedIssues.has(issue.number)) groups.add(`issue:${issue.number}`);
    else if (urgent && !groups.has(`issue:${issue.number}`)) dormant += 1; // a session or a PR names it: it is on a card
  }

  const members = new Map<string, string[]>();
  for (const key of groups.keys()) {
    const root = groups.find(key);
    members.set(root, [...(members.get(root) ?? []), key]);
  }
  const allTexts = [
    ...Object.values(issues).map((issue) => issue.title),
    ...[...views.values()].map((pr) => pr.title),
    ...sessions.map((session) => session.title),
    ...ownerItems.map((item) => item.title),
  ];
  const names = nameDictionary(allTexts);

  const cards: BoardCard[] = [];
  for (const keys of members.values()) {
    const card = buildCard(keys.sort(), { input, issues, views, sessions, names, cites, githubKnown });
    if (card) cards.push(card);
  }

  // ── columns ──
  const order = (a: BoardCard, b: BoardCard) =>
    STATE_RANK[a.state] - STATE_RANK[b.state]
    || (a.priority ? PRIORITY_RANK[a.priority] : 9) - (b.priority ? PRIORITY_RANK[b.priority] : 9)
    || (a.since ?? Infinity) - (b.since ?? Infinity)
    || a.key.localeCompare(b.key);
  const productionOrder = (a: BoardCard, b: BoardCard) => (b.since ?? 0) - (a.since ?? 0) || a.key.localeCompare(b.key);
  const productionKnown = githubKnown && (input.logCoverage.to !== null || (github?.deployments.length ?? 0) > 0);
  const columns: BoardColumn[] = BOARD_STAGES.map((stage) => {
    const known = stage === "session" ? true : stage === "production" ? productionKnown : githubKnown || (stage !== "entry" && input.live !== null);
    const all = cards.filter((card) => card.stage === stage).sort(stage === "production" ? productionOrder : order);
    const shown = stage === "entry" ? all.slice(0, ENTRY_CAP) : all;
    return { stage, known, total: known ? all.length : null, cards: shown, hidden: all.length - shown.length, dormant: stage === "entry" && known ? dormant : null };
  });
  const botIds = new Set(cards.map((card) => card.bot?.id).filter((id): id is string => Boolean(id)));
  return {
    version: 1,
    enabled: true,
    generatedAt: now,
    repo,
    columns,
    bots: [...botIds].map((id) => ({ id, name: input.botNames.get(id) ?? id.slice(0, 8) })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    sources: {
      githubSyncedAt: github?.syncedAt ?? null,
      livePrsAt: input.live?.at ?? null,
      livePrsError: input.liveError ?? null,
      releaseLogTo: input.logCoverage.to,
      releaseHold: input.releaseHold,
    },
  };
}

function fromCache(pr: GhPr | null, number = pr?.number ?? 0): LivePr {
  return {
    number, title: pr?.title ?? "", createdAt: pr?.createdAt ?? 0, updatedAt: pr?.updatedAt ?? 0, mergedAt: pr?.mergedAt ?? null,
    state: pr?.state ?? "OPEN", draft: pr?.draft ?? false, base: pr?.base ?? "main", head: pr?.head ?? "", headSha: null, mergeSha: pr?.mergeSha ?? null,
    gate: "missing", gateAt: null, mergeState: null, closes: pr?.closes ?? [], refs: pr?.refs ?? [], labels: pr?.labels ?? [],
  };
}

interface CardContext {
  input: BoardInputs;
  issues: Record<string, GhIssue>;
  views: Map<number, PrView>;
  sessions: readonly BoardSession[];
  names: NameDictionary;
  cites: Map<BoardOwnerPending, { numbers: Set<number>; text: string }>;
  githubKnown: boolean;
}

/** A session's weight as the card's responsible: one at work first, then stopped, then done. */
const SESSION_RANK: Record<string, number> = { running: 0, stalled: 1, failed: 2, idle: 3, archived: 4 };

function buildCard(keys: string[], context: CardContext): BoardCard | null {
  const { input, issues, views, names } = context;
  const { now, repo } = input;
  const issueNumbers = keys.filter((key) => key.startsWith("issue:")).map((key) => Number(key.slice(6))).sort((a, b) => a - b);
  const prViews = keys.filter((key) => key.startsWith("pr:")).map((key) => views.get(Number(key.slice(3)))).filter((pr): pr is PrView => Boolean(pr)).sort((a, b) => a.number - b.number);
  const sessionIds = new Set(keys.filter((key) => key.startsWith("session:")).map((key) => key.slice(8)));
  const sessions = context.sessions.filter((session) => sessionIds.has(session.id))
    .sort((a, b) => (SESSION_RANK[a.status] ?? 9) - (SESSION_RANK[b.status] ?? 9) || b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
  const knownIssues = issueNumbers.map((number) => issues[String(number)]).filter((issue): issue is GhIssue => Boolean(issue));

  // ── the unfinished parts, and the stage of the least advanced ──
  const open = prViews.filter((pr) => pr.state === "OPEN");
  const waitingRelease = prViews.filter((pr) => pr.state === "MERGED" && pr.delivered === null);
  const delivered = prViews.filter((pr) => pr.state === "MERGED" && pr.delivered !== null);
  const liveSessions = sessions.filter((session) => session.status !== "archived");
  const workingSession = liveSessions.find((session) => {
    const own = sessionPrs(session).map((number) => views.get(number)).filter((pr): pr is PrView => Boolean(pr));
    // a session with a PR on the board is represented by the PR; one whose PRs all merged works on something new only while it runs
    if (own.some((pr) => pr.state === "OPEN" || (pr.state === "MERGED" && pr.delivered === null))) return false;
    // its record names PRs (on the board or not): at work only while it runs
    return sessionPrs(session).length === 0 || session.status === "running" || session.status === "stalled";
  });
  // the gate began: a status on its head, ci:local holding or queued for the machine for
  // its head, or a receipt in its worktree from after the PR opened (maybe of a newer local commit)
  const gateTouched = (pr: PrView) => {
    const receipt = receiptFor(pr, sessions, input);
    return pr.gate !== "missing" || admissionFor(pr, input) !== null || (receipt !== null && (receipt.head || (receipt.finishedAt ?? 0) >= pr.createdAt));
  };
  const recentDelivery = delivered.filter((pr) => now - pr.delivered!.at < PRODUCTION_WINDOW_MS);
  const openIssues = knownIssues.filter((issue) => issue.state === "OPEN");

  let stage: BoardStage;
  if (workingSession) stage = "session";
  else if (open.length) stage = open.some((pr) => !gateTouched(pr)) ? "pr" : "gate";
  else if (waitingRelease.length) stage = "release";
  else if (recentDelivery.length) stage = "production";
  else if (delivered.length || !openIssues.length) return null; // delivered over 7 days ago, or nothing left open
  else stage = liveSessions.length ? "session" : "entry";

  // ── what it is ──
  const primary = pickPrimary(issueNumbers, sessions, knownIssues);
  const primaryIssue = primary !== null ? issues[String(primary)] : undefined;
  const leadPr = open[0] ?? waitingRelease[0] ?? recentDelivery[0] ?? null;
  const rawTitle = primaryIssue?.title ?? leadPr?.title ?? sessions[0]?.title ?? "";
  const ownerCites = [...context.cites.entries()].filter(([, cite]) => issueNumbers.some((number) => cite.numbers.has(number)) || prViews.some((pr) => cite.numbers.has(pr.number)) || sessions.some((session) => cite.text.includes(session.id) || new RegExp(`(?<![0-9a-f])${session.id.slice(0, 8)}(?![0-9a-f])`).test(cite.text)))
    .map(([item]) => item).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const texts = [...knownIssues.map((issue) => issue.title), ...prViews.map((pr) => pr.title), ...sessions.map((session) => session.title), ...ownerCites.map((item) => item.title)];
  const labels = [...knownIssues.flatMap((issue) => issue.labels), ...prViews.flatMap((pr) => pr.labels)];
  const priorities = [issuePriority(labels), ...knownIssues.map((issue) => issuePriority(issue.labels))].filter((value): value is BoardPriority => value !== "none");
  const priority = priorities.sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b])[0] ?? null;
  const sheetRow = texts.map(sheetRowOf).find((row) => row !== null) ?? null;
  const responsible = sessions[0] ?? null;
  const ownerItem = ownerCites[0] ?? null;
  const botId = responsible?.ownerBotId ?? ownerItem?.botId ?? null;

  // ── where it stands ──
  let since: number | null = null;
  let state: CardState = "idle";
  let reason: BoardReason | null = null;
  let gate: BoardCard["gate"] = null;
  let release: BoardCard["release"] = null;
  if (stage === "entry") {
    since = primaryIssue?.createdAt ?? null;
    reason = { code: "no-session" };
  } else if (stage === "session") {
    const session = workingSession ?? liveSessions[0]!;
    since = session.createdAt;
    ({ state, reason } = sessionState(session, now));
  } else if (stage === "pr" || stage === "gate") {
    // the PR that holds the card back: the least advanced, then the oldest
    const pr = stage === "pr" ? open.find((each) => !gateTouched(each))! : open[0]!;
    const receipt = receiptFor(pr, sessions, input);
    const admission = admissionFor(pr, input);
    gate = { status: context.input.live || pr.gate !== "missing" ? pr.gate as BoardGateStatus : "unknown", receipt: receipt?.head ? "head" : receipt ? "other" : null, at: pr.gateAt ?? (receipt?.head ? receipt.finishedAt : null) };
    if (stage === "pr") {
      since = pr.createdAt || null;
      ({ state, reason } = prState(pr, null, receipt?.head === true, liveSessions[0] ?? null, now));
    } else {
      // the earliest sign of the gate in the data: the status on the head, or the worktree's receipt
      since = [pr.gateAt, receipt && (receipt.finishedAt ?? 0) >= pr.createdAt ? receipt.finishedAt : null].filter((at): at is number => typeof at === "number").sort((a, b) => a - b)[0] ?? null;
      ({ state, reason } = prState(pr, admission, receipt?.head === true, liveSessions[0] ?? null, now));
    }
  } else if (stage === "release") {
    const pr = waitingRelease.sort((a, b) => a.mergedAt! - b.mergedAt!)[0]!;
    since = pr.mergedAt;
    ({ state, reason, release } = releaseState(pr.mergedAt!, input));
  } else {
    const last = recentDelivery.sort((a, b) => b.delivered!.at - a.delivered!.at)[0]!;
    since = last.delivered!.at;
    state = "done";
    release = { sha: last.delivered!.sha ? short(last.delivered!.sha) : "—", state: "released", at: last.delivered!.at, ...(last.delivered!.inferred ? { inferred: true as const } : {}) };
  }
  // in production too: closing the cycle (telling the requester, the issue) may still wait on the person
  const owner: BoardOwnerItem | null = ownerItem
    ?{ botId: ownerItem.botId, threadId: ownerItem.threadId, pendingId: ownerItem.id, since: ownerItem.createdAt, more: ownerCites.length - 1 }
    : null;
  if (owner) state = "owner";

  const key = primary !== null ? `issue:${primary}` : leadPr ? `pr:${leadPr.number}` : `session:${sessions[0]?.id ?? keys[0]}`;
  const linkPr = (stage === "pr" || stage === "gate" ? open[0] : stage === "release" ? waitingRelease[0] : leadPr) ?? null;
  return {
    key, stage,
    title: boardTitle(rawTitle, names),
    issue: primary,
    issues: issueNumbers,
    prs: prViews.map((pr) => pr.number),
    priority,
    origin: isClientWork(texts, names) ? "client" : "internal",
    sheetRow,
    bot: botId ? { id: botId, name: input.botNames.get(botId) ?? null } : null,
    session: responsible ? { id: responsible.id, title: boardTitle(responsible.title, names), status: responsible.status } : null,
    since,
    limitMs: stageLimitMs(stage, priority),
    state, reason, owner,
    links: {
      issue: primary !== null ? `https://github.com/${repo}/issues/${primary}` : null,
      pr: linkPr ? `https://github.com/${repo}/pull/${linkPr.number}` : null,
      session: responsible
        ? responsible.surface === "app" && responsible.desktop?.localId && /^local_[0-9a-f-]{36}$/.test(responsible.desktop.localId)
          ? { kind: "app", url: `claude://code/continue?session=${responsible.desktop.localId}` }
          : { kind: "thread", botId: responsible.ownerBotId, threadId: responsible.replyThreadId ?? responsible.ownerThreadId }
        : null,
    },
    gate,
    release,
  };
}

/** The issue a card is about: the one its session's title opens with, else the lowest open, else the lowest. */
function pickPrimary(numbers: number[], sessions: readonly BoardSession[], known: readonly GhIssue[]): number | null {
  for (const session of sessions) {
    const first = sessionIssues(session).find((number) => numbers.includes(number));
    if (first !== undefined) return first;
  }
  return known.find((issue) => issue.state === "OPEN")?.number ?? known[0]?.number ?? numbers[0] ?? null;
}

function sessionState(session: BoardSession, now: number): { state: CardState; reason: BoardReason } {
  if (session.resumeAfterTag) return { state: "queued", reason: { code: "parked-release" } };
  if (session.desktop?.pending) return { state: "queued", reason: { code: "screen-wait", detail: session.desktop.pending.kind } };
  if (session.status === "failed") return { state: "blocked", reason: { code: "session-failed", ...(session.lastError ? { detail: clip(session.lastError) } : {}) } };
  if (session.status === "stalled" || (session.status === "running" && now - (session.progressAt ?? session.lastActivityAt) >= CC_ACTIVE_MS)) return { state: "blocked", reason: { code: "session-stalled" } };
  if (session.status === "running") return { state: "running", reason: { code: "session-running" } };
  if (session.blockedOn) return { state: "blocked", reason: { code: "session-blocked", detail: clip(session.blockedOn) } };
  return { state: "idle", reason: { code: "session-idle" } };
}

function prState(pr: PrView, admission: "running" | "queued" | null, receiptOfHead: boolean, session: BoardSession | null, now: number): { state: CardState; reason: BoardReason } {
  const merge = (pr.mergeState ?? "").toUpperCase();
  if (pr.draft) return { state: "idle", reason: { code: "draft" } };
  if (pr.gate === "failure") return { state: "blocked", reason: { code: "gate-failed" } };
  if (merge === "BEHIND") return { state: "blocked", reason: { code: "behind" } };
  if (merge === "DIRTY") return { state: "blocked", reason: { code: "conflict" } };
  if (admission === "running") return { state: "running", reason: { code: "ci-running" } };
  if (admission === "queued") return { state: "queued", reason: { code: "ci-queued" } };
  if (pr.gate === "pending") return { state: "running", reason: { code: "gate-pending" } };
  if (pr.gate === "success") return { state: merge === "BLOCKED" ? "blocked" : "idle", reason: { code: merge === "BLOCKED" ? "repo-blocked" : "awaiting-merge" } };
  const working = session !== null && (session.status === "running" && now - (session.progressAt ?? session.lastActivityAt) < CC_ACTIVE_MS);
  // ci:local passed on this very head, but the gate status was never published (pr:merge --publish)
  if (pr.gate === "missing" && receiptOfHead) return { state: "idle", reason: { code: "receipt-only" } };
  return { state: working ? "running" : "idle", reason: { code: "no-gate" } };
}

function releaseState(mergedAt: number, input: BoardInputs): { state: CardState; reason: BoardReason; release: BoardCard["release"] } {
  const runs = input.runs.filter((run) => (run.startedAt ?? run.endedAt ?? 0) >= mergedAt).sort((a, b) => (a.startedAt ?? a.endedAt!) - (b.startedAt ?? b.endedAt!));
  const running = runs.filter((run) => run.outcome === "running").at(-1);
  if (running) return { state: "running", reason: { code: "release-running", detail: short(running.sha) }, release: { sha: short(running.sha), state: "running", at: running.startedAt } };
  const heldSha = /([0-9a-f]{9,40})/.exec(input.releaseHold ?? "")?.[1];
  if (input.releaseHold && input.releaseHold !== "?") return { state: "running", reason: { code: "release-running", ...(heldSha ? { detail: short(heldSha) } : {}) }, release: { sha: heldSha ? short(heldSha) : "—", state: "running", at: null } };
  const failed = runs.filter((run) => run.outcome === "failed");
  const last = failed.at(-1);
  if (last) {
    const tries = failed.filter((run) => run.sha === last.sha).length;
    return { state: "blocked", reason: { code: "release-failed", detail: clip(last.cause, 120) || short(last.sha), count: tries }, release: { sha: short(last.sha), state: "failed", at: last.endedAt } };
  }
  return { state: "queued", reason: { code: "release-wait" }, release: null };
}

/** The ci:local receipt for this PR in its session's worktree: of its head, or of another commit. */
function receiptFor(pr: PrView, sessions: readonly BoardSession[], input: BoardInputs): { head: boolean; finishedAt: number | null } | null {
  for (const session of sessions) {
    if (!sessionPrs(session).includes(pr.number)) continue;
    const receipt = input.receipts[session.id];
    if (receipt) return { head: Boolean(pr.headSha && receipt.commit === pr.headSha), finishedAt: receipt.finishedAt };
  }
  return null;
}

/** The ci:local of this PR's head holds the machine (running) or waits for it (queued). */
function admissionFor(pr: PrView, input: BoardInputs): "running" | "queued" | null {
  const lease = input.admission.lease;
  if (lease && lease.kind.trim() !== "release" && labelNamesHead(lease.label, pr.headSha)) return "running";
  return input.admission.intents.some((label) => labelNamesHead(label, pr.headSha)) ? "queued" : null;
}

/** Parse a ci:local receipt (.local-ci/last-success/receipt.env). */
export function parseReceipt(text: string): { commit: string; finishedAt: number | null } | null {
  const field = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const commit = field("CI_COMMIT");
  if (!/^[0-9a-f]{40}$/.test(commit) || field("CI_RESULT") !== "success") return null;
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(field("CI_FINISHED_AT"));
  const finishedAt = stamp ? Date.UTC(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3]), Number(stamp[4]), Number(stamp[5]), Number(stamp[6])) : null;
  return { commit, finishedAt };
}
