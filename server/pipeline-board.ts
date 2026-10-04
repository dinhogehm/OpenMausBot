// "Esteira" (lot Z): builds the delivery pipeline board — Entrada, Sessão,
// PR aberta, Gate, Release, Produção — from the productivity collector's
// cache (issues, merged PRs, the release log, the compares that say what
// each release carried) and the live state the server holds (Claude Code
// sessions, the open PRs read for the board, the ci:local receipts and runs
// in the sessions' worktrees, the admission lease and intents, "Precisa de você").
//
// Pure and deterministic: the same inputs give the same board, cards in the
// same order. A card is one piece of work: an issue together with the
// sessions and PRs that name it — joined only by explicit references (a PR's
// Closes/Fixes/Fecha/Corrige/Refs, a session's PR by its branch or by
// hand-over, the issue number a session's title opens with). Its stage is the
// least advanced of its unfinished parts; what it waits on comes from the
// data, never guessed. An open issue never leaves the board unsaid: delivered
// or abandoned and still open, it is back in Entrada as a cycle to close.
import { BOARD_STAGES, DEFAULT_LIMITS, ENTRY_DORMANT_MS, ENTRY_RECENT_MS, PRODUCTION_WINDOW_MS, stageLimitMs, type BoardCard, type BoardColumn, type BoardGateStatus, type BoardLimits, type BoardOwnerItem, type BoardPriority, type BoardReason, type BoardStage, type CardState, type PipelineBoard } from "../shared/pipeline-board.ts";
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
  /** Of `refs`, the ones it says it closes (not "Refs"); undefined in a cache read before it existed. */
  fixes?: number[];
  /** It says it ships a part ("Fase 0 do #9071"). */
  partial?: true;
  labels: string[];
}

/** The PR says it closes this issue (GitHub's link, Closes/Fecha…), not only cites it (Refs).
 * A PR read before `fixes` existed counts only by GitHub's link: "Refs" is the convention. */
export function closesIssue(pr: Pick<LivePr, "closes" | "refs" | "fixes">, issue: number): boolean {
  return pr.closes.includes(issue) || (pr.fixes ?? []).includes(issue);
}

/** What shipped means for an issue still open.
 *
 * CONVENTION (confirmed by the owner, 04/10/2026): "Refs #N" is a COMPLETE fix awaiting
 * validation — lot P's gate refuses Closes/Fixes in a runtime PR, so a whole fix ships with
 * "Refs #N" and the issue stays open until the requester validates it. Shipped and still
 * open, it is "validate": "entregue, aguardando validação/fechamento", a cycle to close.
 * A PR that says it closes it (Closes/Fecha…) with the issue still open: "close" (the
 * cycle was not closed). "partial" only when every PR that shipped says it is a part
 * ("Fase 0", "parte 2", "etapa 1", "entrega parcial" — partialDelivery): never inferred
 * from "Refs". The screen says the same in the columns' tooltip (pipeline.convention.refs). */
export function deliveryKind(prs: ReadonlyArray<Pick<LivePr, "closes" | "refs" | "fixes" | "partial">>, issue: number): "close" | "validate" | "partial" {
  if (prs.some((pr) => closesIssue(pr, issue))) return "close";
  return prs.length > 0 && prs.every((pr) => pr.partial) ? "partial" : "validate";
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
  /** Its worktree: where its ci:local receipt and runs are. */
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
  /** The board's own read of open and recently merged PRs; null before the first one.
   * `openComplete` false: more PRs are open than the read holds (none is taken for closed). */
  live: { at: number; open: LivePr[]; merged: LivePr[]; openComplete?: boolean } | null;
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
  /** When each ci:local run in a session's worktree started (.local-ci/runs/<stamp>-…). */
  ciRuns?: Readonly<Record<string, readonly number[]>>;
  /** The owner's limits (the defaults when none). */
  limits?: BoardLimits;
}

// ── titles without names ────────────────────────────────────────────────────

/** A real day/month: "Etapa 1/3" is a date by shape, "Deploy 45/10" is not. */
const DATE = String.raw`(?<!\d)(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/\d{2,4})?(?!\d)`;
const NAME = String.raw`\p{Lu}\p{Ll}{2,}`;
/** One person as titles write them: "Daiane", "Pedro Henrique". */
const PERSON = String.raw`${NAME}(?:\s+${NAME})?`;
const NAMES = String.raw`(?:${PERSON}\s*(?:\/|,|e(?![\p{L}]))\s*)*${PERSON}`;
/** Where the request came in, written before the name: "(Chat Patricia 24/09)". */
const CHANNEL = String.raw`(?:Chat|Ticket|WhatsApp|Whats|E-?mail|Telefone|Liga[çc][ãa]o|Meet|Reuni[ãa]o|Planilha)\s+`;
/** Without accents, in lower case: "Patrícia" and "PATRICIA" are one name. */
export const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** Words a title puts before a date or after "cliente" that are never a person: work,
 * channels and meetings, the days and the months. */
export const STOPWORDS = new Set([
  "deploy", "release", "releases", "relatorio", "relatorios", "etapa", "fase", "lote", "sprint", "versao", "build", "teste", "testes", "bug", "erro", "falha", "fila", "filas",
  "helpdesk", "atendimento", "atendimentos", "ticket", "tickets", "chat", "widget", "sessao", "gate", "hoje", "ontem", "amanha", "issue", "issues", "linha", "planilha",
  "cliente", "clientes", "data", "prazo", "status", "admin", "agente", "agentes", "supervisor", "reprovado", "aprovado", "reprovacao", "producao", "main", "carrier",
  "hotfix", "nuria", "piloto", "epic", "inbox", "portal", "core", "web", "infra",
  "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo", "seg", "ter", "qua", "qui", "sex", "sab", "dom",
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
  "jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez",
  "atualizacao", "correcao", "melhoria", "ajuste", "tarefa", "demanda", "rodada", "revisao", "validacao", "entrega", "publicacao", "migracao", "backup",
  "monitor", "chief", "delivery", "lead", "eng", "qa", "dba", "sre", "relato", "pedido", "final", "inicio", "fim", "semana", "mes", "dia", "plano", "conta",
  "empresa", "usuario", "usuarios", "reuniao", "reunioes", "call", "daily", "demo", "meet", "ligacao", "whatsapp", "whats", "email", "telefone", "suporte",
  "comercial", "financeiro", "gestao", "equipe", "time", "contrato", "proposta", "treinamento", "implantacao", "onboarding", "evento", "alerta", "incidente",
]);

/** One letter apart inside the name (Levenshtein 1, not at its end): "Felipe"/"Filipe",
 * "Mateus"/"Matheus" — but not "Pedra"/"Pedro", where the end makes another word. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (i >= Math.min(a.length, b.length) - 1) return false;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** A word that is a requester the dictionary learned, in any spelling a title uses for
 * them: the name itself in any case or accent; and, for a capitalized word that is not
 * Portuguese (COMMON_PT, or a word the titles write in lower case), a one-letter variant
 * of a name of 5+ letters (Felipe, Mateus) or a diminutive of one (Pedrinho); a short form
 * (Dai) only where a title showed it beside the full name. "Mat", "Math", "Pat", "Rob",
 * "Mate", "Marinho", "Patinho" and a sentence's "Daí" are words, not people. */
export function isRequester(word: string, names: Pick<NameDictionary, "people" | "common" | "aliases">): boolean {
  const folded = fold(word);
  if (names.people.has(folded)) return true;
  if (names.aliases.has(word.toLocaleLowerCase("pt-BR"))) return true;
  if (!/^\p{Lu}/u.test(word) || folded.length < 4 || STOPWORDS.has(folded) || COMMON_PT.has(folded) || names.common.has(folded)) return false;
  const base = folded.replace(/z?inh[oa]s?$/u, "");
  for (const name of names.people) {
    if (name.length < 5) continue;
    if (folded.length >= 5 && oneEditApart(folded, name)) return true;
    if (base !== folded && base.length >= 4 && name.startsWith(base)) return true;
  }
  return false;
}

export interface NameDictionary {
  /** Folded (fold()) requesters' names. */
  people: ReadonlySet<string>;
  /** Folded clients' (tenants') names. */
  tenants: ReadonlySet<string>;
  /** Folded words the titles write in lower case: Portuguese, never a variant of a name. */
  common: ReadonlySet<string>;
  /** Short forms seen beside the full name in a title ("Dai" with "Daiane"), lower case with accents. */
  aliases: ReadonlySet<string>;
}

/** Portuguese words a name variant could look like, capitalized at a sentence's start
 * (the titles' own lower-case words are added to these when the dictionary is built). */
export const COMMON_PT = new Set([
  "mate", "mato", "matar", "mata", "matriz", "matricula", "mapa", "marca", "marco", "marinho", "marinha", "mar", "pato", "patinho", "pata", "patio", "pedra", "pedras",
  "pedal", "pedaco", "pedido", "roberto", "robo", "robusto", "rota", "roda", "filme", "filho", "filha", "fila", "filtro", "dado", "dados", "daily", "dai", "daqui",
  "daria", "dano", "danos", "dama", "data", "felino", "feliz", "fechar", "mesa", "meta", "metade", "metodo", "modo", "pagina", "pagar", "pago", "parte", "pauta",
  "peso", "pena", "pelo", "pela", "perto", "pois", "porta", "posto", "rede", "regra", "resto", "risco", "roteiro", "salvo", "santo", "senha", "sino", "tela",
  "tempo", "tipo", "todo", "toda", "valor", "vez", "via", "visao", "volta", "zona", "patricio", "mateiro", "dairy", "math", "matt", "rob", "pat",
]);

/** A second name or a surname that goes with a requester's first ("Pedro Henrique", "Mateus Rodrigues"). */
const SECOND_NAMES = new Set([
  "henrique", "paulo", "eduardo", "augusto", "gabriel", "luiz", "luis", "carlos", "antonio", "jose", "maria", "ana", "clara", "luiza", "luisa", "fernanda",
  "cristina", "helena", "vitoria", "miguel", "arthur", "artur", "felipe", "filipe", "gustavo", "rafael", "lucas", "vinicius", "victor", "vitor", "ricardo",
  "alberto", "roberto", "fernando", "rodrigo", "daniel", "daniela", "beatriz", "carolina", "julia", "juliana", "leticia", "camila", "amanda", "marcos",
  "silva", "santos", "oliveira", "souza", "sousa", "rodrigues", "ferreira", "alves", "pereira", "lima", "gomes", "costa", "ribeiro", "martins", "carvalho",
  "almeida", "lopes", "soares", "fernandes", "vieira", "barbosa", "rocha", "dias", "nascimento", "andrade", "moreira", "nunes", "marques", "machado",
  "mendes", "freitas", "cardoso", "ramos", "goncalves", "santana", "teixeira", "araujo", "melo", "mello", "batista", "campos", "pinto", "moura", "cavalcanti",
  "monteiro", "correia", "correa", "azevedo", "medeiros", "reis", "farias", "castro", "fonseca", "guimaraes", "siqueira", "xavier", "prado", "brito", "sales",
]);

/** Requesters and clients, learned only where the title says who asked —
 * "(Daiane 01/10)", "(ticket 142461, Pedro 02/10)", "— Marluce 30/09",
 * "(Filipe, planilha L110)", "Relato do Matheus", "cliente Roberto" — or names
 * a client as one ("tenant PIPERUN"); never a common word ("Deploy 02/10",
 * "Relatório 30/09"). Built over every title the board may show, so a name
 * is removed wherever it appears, in any case and with or without accents. */
export function nameDictionary(texts: Iterable<string>): NameDictionary {
  const people = new Set<string>();
  const tenants = new Set<string>();
  // each person's first name is learned ("Pedro Henrique" → pedro); the second goes with it when removed
  const learn = (names: string) => {
    for (const person of names.split(/\s*(?:\/|,|(?<![\p{L}])e(?![\p{L}]))\s*/u)) {
      const first = person.trim().split(/\s+/)[0];
      if (first && !STOPWORDS.has(fold(first))) people.add(fold(first));
    }
  };
  const attributed = new RegExp(String.raw`(?:^|[(,]\s*)(?:${CHANNEL})?(${NAMES}),?\s+${DATE}\s*$`, "u");
  const tail = new RegExp(String.raw`[—–-]\s+(?:${CHANNEL})?(${NAMES}),?\s+\(?${DATE}\)?\s*$`, "u");
  const sheet = new RegExp(String.raw`\((${NAME}),\s*(?:planilha|linha|L\d)`, "gu");
  const reported = new RegExp(String.raw`(?:[Rr]elato|[Rr]elatad[oa]|[Rr]eportad[oa]|[Pp]edido|[Qq]uem pediu foi)\s+(?:d[oa]|pel[oa]|por|de|[oa])\s+(${NAME})|(?<![\p{L}])[Cc]lientes?\s+(${NAME})(?![\p{L}])`, "gu");
  // a client is named as one somewhere ("tenant PIPERUN", "cliente ACME"): then it goes from
  // every title, also where nothing marks it. Capitals alone are not a client ("NEGATIVA", "FORBIDDEN_WORDS")
  const tenant = /(?<![\p{L}\d_])(?:[Tt]enant|[Cc]liente|[Ww]orkspace)\s+([A-Z][A-Z0-9]{3,})(?![\p{L}\d_])/gu;
  const common = new Set<string>();
  const all = [...texts];
  for (const text of all) {
    for (const group of text.matchAll(/\(([^()]*)\)/gu)) {
      const match = attributed.exec(group[1]!.trim());
      if (match) learn(match[1]!);
    }
    const end = tail.exec(text);
    if (end) learn(end[1]!);
    for (const match of text.matchAll(sheet)) learn(match[1]!);
    for (const match of text.matchAll(reported)) learn((match[1] ?? match[2])!);
    for (const match of text.matchAll(tenant)) tenants.add(fold(match[1]!));
    // a word written in lower case is a word of the language, never a person
    for (const match of text.matchAll(/(?<![\p{L}\d_@.])\p{Ll}[\p{Ll}]{2,}(?![\p{L}\d_])/gu)) common.add(fold(match[0]));
  }
  // a short form counts only where a title shows it beside the full name ("Dai (Daiane)", "Daiane/Dai")
  const aliases = new Set<string>();
  for (const text of all) {
    const words = [...text.matchAll(/\p{Lu}\p{Ll}+/gu)].map((match) => match[0]);
    const full = words.filter((word) => people.has(fold(word))).map(fold);
    if (!full.length) continue;
    for (const word of words) {
      const folded = fold(word);
      if (folded.length >= 3 && !people.has(folded) && !STOPWORDS.has(folded) && full.some((name) => name.length >= folded.length + 2 && name.startsWith(folded))) aliases.add(word.toLocaleLowerCase("pt-BR"));
    }
  }
  for (const name of people) common.delete(name);
  return { people, tenants, common, aliases };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}._-]*/gu;
const MARK = "\u0000";
/** Longer than this, a title is cut (the screen clamps to two lines and shows it whole on hover). */
const TITLE_MAX = 240;

const hasPerson = (text: string, names: NameDictionary) => [...text.matchAll(/\p{L}+/gu)].some((word) => isRequester(word[0], names));
const hasTenant = (text: string, names: NameDictionary) => [...names.tenants].some((name) => fold(text).includes(name));

/** A card's title: no leading issue numbers, no "fix(scope):", no requester
 * or client (their parenthesis or dash tail goes whole, with its date, its
 * spreadsheet row, its ticket), no e-mail address, a client's domain or name
 * inside a word said as "cliente". */
export function boardTitle(raw: string, names: NameDictionary): string {
  const sensitive = (text: string) => new RegExp(String.raw`#\d|\bref\b|planilha|(?<![\p{L}])L\d{1,4}(?![\p{L}\d])|linha \d|ticket \d|${DATE}|(?<![\p{L}])cliente|@`, "iu").test(text)
    || hasPerson(text, names) || hasTenant(text, names);
  let text = raw.replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:#?\d{3,6}(?!\d)[\s,]+)+(?=\S)/, "");
  text = text.replace(/^(?:feat|fix|chore|perf|refactor|docs|test|ci|build|style|hotfix|ops|revert)(?:\([^)]*\))?!?:\s+/i, "");
  // a parenthesis about who asked, when, where (row, ticket) or which issue: whole
  for (let before = ""; before !== text;) { before = text; text = text.replace(/\s*\(([^()]*)\)/gu, (whole, inner: string) => (sensitive(inner) ? "" : whole)); }
  // a dash tail of the same kind: "— Marluce 30/09", "— reprovação linha 106"
  for (let before = ""; before !== text;) { before = text; text = text.replace(/\s+[—–-]\s+([^—–]*)$/u, (whole, tail: string) => (sensitive(tail) ? "" : whole)); }
  // an address is a person's; a domain or a word with a client inside is the client
  text = text.replace(EMAIL, "e-mail");
  text = text.replace(TOKEN, (token) => {
    const client = [...names.tenants].find((name) => fold(token).includes(name));
    if (!client) return token;
    if (/\.[\p{L}]{2,}$/u.test(token)) return "cliente";
    const inside = token.replace(new RegExp(escape(client), "i"), "cliente");
    return inside === token ? "cliente" : inside;
  });
  // a requester, with the "do/da/pelo" before and the names and date that go with
  text = text.replace(/\p{L}+/gu, (word) => (isRequester(word, names) ? MARK : word));
  // the second name goes with the first only when it is one ("Pedro Henrique", "Mateus Rodrigues") —
  // never the next word of the sentence ("Filipe Sidebar quebrou")
  for (let before = ""; before !== text;) { before = text; text = text.replace(new RegExp(`${MARK} (${NAME})(?![\\p{L}])`, "gu"), (whole, next: string) => (SECOND_NAMES.has(fold(next)) ? `${MARK} ${MARK}` : whole)); }
  // with the "do/da/pelo" before, the others joined to it ("do Roberto e da Daiane") and the date after
  const joined = String.raw`(?:\s*(?:\/|,)\s*|\s+|\s+e(?:\s+(?:d[oa]s?|pel[oa]s?|[oa]s?))?\s+)`;
  text = text.replace(new RegExp(String.raw`(?:(?<![\p{L}])(?:d[oa]|pel[oa]|por|com|[oa])\s+)?${MARK}(?:${joined}${MARK})*(?:,?\s+\(?${DATE}\)?)?`, "gu"), "");
  // a slash between words stays ("automação / Chat Web"); one a removed name left alone goes
  text = text.replace(/\s+([,.;:!?)])(?=\s|$)/g, "$1").replace(/\(\s*\)/g, "").replace(/\s+\/\s*(?=[,.;:)]|$)|(?<=^|\()\s*\/\s+/g, " ")
    .replace(/^[\s,;:/—–-]+/u, "").replace(/[\s,;:/—–-]+$/u, "").replace(/\s{2,}/g, " ").trim();
  if (!text) return "—";
  text = text[0]!.toLocaleUpperCase("pt-BR") + text.slice(1);
  if (text.length <= TITLE_MAX) return text;
  const cut = text.slice(0, TITLE_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[\s,;:—–-]+$/u, "")}…`;
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
    || hasPerson(text, names) || hasTenant(text, names));
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

/** Whether a release of `sha` can carry a merge made at `mergedAt`: it is the
 * merge's own commit, or a commit the watcher first tried after the merge (a
 * retry of an older commit, d5bb1f70b ×11, never carries what merged since). */
function shipsMerge(sha: string, pr: Pick<LivePr, "mergeSha" | "mergedAt">, firstTry: ReadonlyMap<string, number>): boolean {
  if (pr.mergeSha && sha === pr.mergeSha) return true;
  const first = firstTry.get(sha);
  return first !== undefined && pr.mergedAt !== null && first >= pr.mergedAt;
}

export function buildPipelineBoard(input: BoardInputs): PipelineBoard {
  const { now, repo } = input;
  const limits = input.limits ?? DEFAULT_LIMITS;
  const github = input.github;
  const githubKnown = github !== null && github.syncedAt !== null;
  const issues: Record<string, GhIssue> = github?.issues ?? {};

  // ── PRs: the collector's, overlaid with the board's own live read ──
  const prs = new Map<number, LivePr>();
  for (const pr of Object.values(github?.prs ?? {})) prs.set(pr.number, fromCache(pr));
  if (input.live) {
    for (const pr of [...input.live.merged, ...input.live.open]) prs.set(pr.number, pr);
    const openNow = new Set(input.live.open.map((pr) => pr.number));
    // open in the older cache, gone from a complete live open list and not seen merged: closed meanwhile — off the board
    if (input.live.openComplete !== false) for (const pr of prs.values()) if (pr.state === "OPEN" && !openNow.has(pr.number)) prs.set(pr.number, { ...pr, state: "CLOSED" });
  } else if (github) {
    for (const open of github.openPrs) {
      const known = prs.get(open.number);
      prs.set(open.number, { ...(known ?? fromCache(null, open.number)), number: open.number, title: open.title || known?.title || "", createdAt: open.createdAt, state: "OPEN", draft: open.draft, base: open.base, headSha: open.headSha, gate: open.gate, gateAt: open.gateAt, mergeState: null, mergedAt: null });
    }
  }

  // ── what reached production, and when ──
  const timeline = github ? buildTimeline({ runs: [...input.runs], github: github as GhCache, now, logCoverage: input.logCoverage }) : null;
  const releaseOfPr = new Map<number, { at: number; sha: string }>();
  for (const release of timeline?.releases ?? []) for (const pr of release.prs) if (!releaseOfPr.has(pr.number)) releaseOfPr.set(pr.number, { at: release.at, sha: release.sha });
  const sessionDelivered = new Map<number, number>();
  for (const session of input.sessions) for (const pr of Object.values(session.delivery?.prs ?? {})) if (pr.inProductionAt) sessionDelivered.set(pr.number, Math.min(sessionDelivered.get(pr.number) ?? Infinity, pr.inProductionAt));
  const runs = [...input.runs].filter((run) => run.startedAt !== null || run.endedAt !== null).sort((a, b) => (a.startedAt ?? a.endedAt!) - (b.startedAt ?? b.endedAt!));
  const firstTry = new Map<string, number>();
  for (const run of runs) if (!firstTry.has(run.sha)) firstTry.set(run.sha, run.startedAt ?? run.endedAt!);
  const successes = runs.filter((run) => run.outcome === "released" && run.endedAt !== null);
  const deliveredOf = (pr: LivePr): PrView["delivered"] => {
    if (pr.mergedAt === null) return null;
    const exact = releaseOfPr.get(pr.number);
    if (exact) return { at: exact.at, sha: exact.sha, inferred: false };
    const told = sessionDelivered.get(pr.number);
    if (told !== undefined) return { at: told, sha: null, inferred: false };
    // what a release carried is read later (compares): until then, a release of the merge's
    // own commit or of one first tried after the merge — said as inferred, by the times
    const after = successes.find((run) => shipsMerge(run.sha, pr, firstTry));
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
    const card = buildCard(keys.sort(), { input, issues, views, sessions, names, cites, limits, firstTry });
    if (card) cards.push(card);
  }

  // ── columns ──
  const order = (a: BoardCard, b: BoardCard) =>
    STATE_RANK[a.state] - STATE_RANK[b.state]
    || (a.priority ? PRIORITY_RANK[a.priority] : 9) - (b.priority ? PRIORITY_RANK[b.priority] : 9)
    || (a.since ?? Infinity) - (b.since ?? Infinity)
    || a.key.localeCompare(b.key);
  // Entrada: what waits on the person, then a client's demand (or a spreadsheet row), then P0/P1,
  // then the newest: what the screen folds at the tail is old backlog, never a new demand
  const entryRank = (card: BoardCard) => (card.state === "owner" ? 0 : card.origin === "client" || card.sheetRow !== null ? 1 : card.priority === "p0" || card.priority === "p1" ? 2 : 3);
  const urgency = (card: BoardCard) => (card.priority === "p0" ? 0 : card.priority === "p1" ? 1 : 2);
  const entryOrder = (a: BoardCard, b: BoardCard) =>
    entryRank(a) - entryRank(b)
    || urgency(a) - urgency(b)
    || (b.since ?? -Infinity) - (a.since ?? -Infinity)
    || a.key.localeCompare(b.key);
  const productionOrder = (a: BoardCard, b: BoardCard) => (b.since ?? 0) - (a.since ?? 0) || a.key.localeCompare(b.key);
  const productionKnown = githubKnown && (input.logCoverage.to !== null || (github?.deployments.length ?? 0) > 0);
  const columns: BoardColumn[] = BOARD_STAGES.map((stage) => {
    const known = stage === "session" ? true : stage === "production" ? productionKnown : githubKnown || (stage !== "entry" && input.live !== null);
    const all = cards.filter((card) => card.stage === stage).sort(stage === "production" ? productionOrder : stage === "entry" ? entryOrder : order);
    return { stage, known, total: known ? all.length : null, cards: all, dormant: stage === "entry" && known ? dormant : null };
  });
  const botIds = new Set(cards.map((card) => card.bot?.id).filter((id): id is string => Boolean(id)));
  return {
    version: 1,
    enabled: true,
    generatedAt: now,
    repo,
    columns,
    bots: [...botIds].map((id) => ({ id, name: input.botNames.get(id) ?? id.slice(0, 8) })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    limits,
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
    gate: "missing", gateAt: null, mergeState: null, closes: pr?.closes ?? [], refs: pr?.refs ?? [], ...(pr?.fixes ? { fixes: pr.fixes } : {}), ...(pr?.partial ? { partial: true as const } : {}), labels: pr?.labels ?? [],
  };
}

interface CardContext {
  input: BoardInputs;
  issues: Record<string, GhIssue>;
  views: Map<number, PrView>;
  sessions: readonly BoardSession[];
  names: NameDictionary;
  cites: Map<BoardOwnerPending, { numbers: Set<number>; text: string }>;
  limits: BoardLimits;
  firstTry: ReadonlyMap<string, number>;
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
  const recentDelivery = delivered.filter((pr) => now - pr.delivered!.at < PRODUCTION_WINDOW_MS);
  const openIssues = knownIssues.filter((issue) => issue.state === "OPEN");

  let stage: BoardStage;
  if (workingSession) stage = "session";
  else if (open.length) stage = open.some((pr) => gateSince(pr, sessions, input) === undefined) ? "pr" : "gate";
  else if (waitingRelease.length) stage = "release";
  else if (recentDelivery.length) stage = "production";
  else if (!openIssues.length) return null; // delivered over 7 days ago and closed, or nothing left open
  else stage = liveSessions.length ? "session" : "entry";

  // ── what it is ──
  const primary = pickPrimary(issueNumbers, sessions, knownIssues);
  const primaryIssue = primary !== null ? issues[String(primary)] : undefined;
  const leadPr = open[0] ?? waitingRelease[0] ?? recentDelivery[0] ?? delivered[0] ?? null;
  const rawTitle = primaryIssue?.title ?? leadPr?.title ?? sessions[0]?.title ?? "";
  const ownerCites = [...context.cites.entries()].filter(([, cite]) => issueNumbers.some((number) => cite.numbers.has(number)) || prViews.some((pr) => cite.numbers.has(pr.number)) || sessions.some((session) => cite.text.includes(session.id) || new RegExp(`(?<![0-9a-f])${session.id.slice(0, 8)}(?![0-9a-f])`).test(cite.text)))
    .map(([item]) => item).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const texts = [...knownIssues.map((issue) => issue.title), ...prViews.map((pr) => pr.title), ...sessions.map((session) => session.title), ...ownerCites.map((item) => item.title)];
  const labels = [...knownIssues.flatMap((issue) => issue.labels), ...prViews.flatMap((pr) => pr.labels)];
  const priorities = [issuePriority(labels), ...knownIssues.map((issue) => issuePriority(issue.labels))].filter((value): value is BoardPriority => value !== "none");
  const priority = priorities.sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b])[0] ?? null;
  const sheetRow = texts.map(sheetRowOf).find((row) => row !== null) ?? null;
  const origin = isClientWork(texts, names) ? "client" : "internal";
  const urgent = priority === "p0" || priority === "p1" || origin === "client" || sheetRow !== null;
  const responsible = sessions[0] ?? null;
  const ownerItem = ownerCites[0] ?? null;
  const botId = responsible?.ownerBotId ?? ownerItem?.botId ?? null;

  // ── where it stands ──
  let since: number | null = null;
  let state: CardState = "idle";
  let reason: BoardReason | null = null;
  let gate: BoardCard["gate"] = null;
  let release: BoardCard["release"] = null;
  let closeout = false;
  if (stage === "entry") {
    if (delivered.length) {
      // its PRs reached production more than 7 days ago and the issue is still open: shipped
      // whole ("Refs", the convention) it waits to be validated and closed; a PR that closes it
      // means the cycle was not closed; both are cycles to close. A phase ("Fase 0") is not.
      const last = [...delivered].sort((a, b) => b.delivered!.at - a.delivered!.at)[0]!;
      const kind = primary !== null ? deliveryKind(delivered, primary) : "validate";
      since = last.delivered!.at;
      reason = { code: kind === "close" ? "delivered-open" : kind === "partial" ? "delivered-partial" : "delivered-validate" };
      release = { sha: last.delivered!.sha ? short(last.delivered!.sha) : "—", state: "released", at: last.delivered!.at, ...(last.delivered!.inferred ? { inferred: true as const } : {}) };
      closeout = kind !== "partial";
    } else if (sessions.length) {
      // a session was opened for it and archived without a PR: reopen it or close the issue
      since = Math.max(...sessions.map((session) => session.archivedAt ?? session.lastActivityAt));
      reason = { code: "session-archived" };
      closeout = true;
    } else {
      since = primaryIssue?.createdAt ?? null;
      reason = { code: "no-session" };
    }
  } else if (stage === "session") {
    const session = workingSession ?? liveSessions[0]!;
    since = session.createdAt;
    ({ state, reason } = sessionState(session, now));
  } else if (stage === "pr" || stage === "gate") {
    // the PR that holds the card back: the least advanced, then the oldest
    const pr = stage === "pr" ? open.find((each) => gateSince(each, sessions, input) === undefined)! : open[0]!;
    const receipt = receiptFor(pr, sessions, input);
    const admission = admissionFor(pr, input);
    gate = { status: input.live || pr.gate !== "missing" ? pr.gate as BoardGateStatus : "unknown", receipt: receipt?.head ? "head" : receipt ? "other" : null, at: pr.gateAt ?? (receipt?.head ? receipt.finishedAt : null) };
    // Gate: since the first sign of it (the first ci:local run after the PR opened, its status, a receipt)
    since = stage === "pr" ? pr.createdAt || null : gateSince(pr, sessions, input) ?? null;
    ({ state, reason } = prState(pr, stage === "gate" ? admission : null, receipt?.head === true, liveSessions[0] ?? null, now));
  } else if (stage === "release") {
    const pr = [...waitingRelease].sort((a, b) => a.mergedAt! - b.mergedAt!)[0]!;
    since = pr.mergedAt;
    ({ state, reason, release } = releaseState(pr, input, context.firstTry));
  } else {
    const last = [...recentDelivery].sort((a, b) => b.delivered!.at - a.delivered!.at)[0]!;
    since = last.delivered!.at;
    state = "done";
    release = { sha: last.delivered!.sha ? short(last.delivered!.sha) : "—", state: "released", at: last.delivered!.at, ...(last.delivered!.inferred ? { inferred: true as const } : {}) };
  }
  const blocked = state === "blocked";
  // in production too: closing the cycle (telling the requester, the issue) may still wait on the person
  const owner: BoardOwnerItem | null = ownerItem
    ? { botId: ownerItem.botId, threadId: ownerItem.threadId, pendingId: ownerItem.id, since: ownerItem.createdAt, more: ownerCites.length - 1 }
    : null;
  if (owner) state = "owner";

  const key = primary !== null ? `issue:${primary}` : leadPr ? `pr:${leadPr.number}` : `session:${sessions[0]?.id ?? keys[0]}`;
  // the PR the card is about now: the one holding it back, the first waiting, or the last shipped
  const lastShipped = [...(stage === "production" ? recentDelivery : delivered)].sort((a, b) => b.delivered!.at - a.delivered!.at || b.number - a.number)[0];
  const linkPr = (stage === "pr" || stage === "gate" ? open[0] : stage === "release" ? waitingRelease[0] : lastShipped ?? leadPr) ?? null;
  return {
    key, stage,
    title: boardTitle(rawTitle, names),
    issue: primary,
    issues: issueNumbers,
    prs: prViews.map((pr) => pr.number),
    priority,
    origin,
    sheetRow,
    bot: botId ? { id: botId, name: input.botNames.get(botId) ?? null } : null,
    session: responsible ? { id: responsible.id, title: boardTitle(responsible.title, names), status: responsible.status } : null,
    since,
    limitMs: stageLimitMs(stage, urgent, context.limits),
    state, blocked, urgent, closeout, reason, owner,
    issueOpen: primaryIssue?.state === "OPEN",
    closing: stage === "production" && primaryIssue?.state === "OPEN" && primary !== null ? deliveryKind(delivered, primary) : null,
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

/** Where the merged PR stands on its way to production. Only releases that can
 * carry it count: of its merge's commit, or of one first tried after it. */
function releaseState(pr: PrView, input: BoardInputs, firstTry: ReadonlyMap<string, number>): { state: CardState; reason: BoardReason; release: BoardCard["release"] } {
  const runs = input.runs.filter((run) => shipsMerge(run.sha, pr, firstTry)).sort((a, b) => (a.startedAt ?? a.endedAt!) - (b.startedAt ?? b.endedAt!));
  const running = runs.filter((run) => run.outcome === "running").at(-1);
  if (running) return { state: "running", reason: { code: "release-running", detail: short(running.sha) }, release: { sha: short(running.sha), state: "running", at: running.startedAt } };
  // a release on its way that the log does not show yet: it carries the PR only if it is its commit or a newer one
  const heldSha = /([0-9a-f]{40})/.exec(input.releaseHold ?? "")?.[1];
  if (heldSha && (heldSha === pr.mergeSha || (firstTry.get(heldSha) ?? -Infinity) >= pr.mergedAt!)) {
    return { state: "running", reason: { code: "release-running", detail: short(heldSha) }, release: { sha: short(heldSha), state: "running", at: null } };
  }
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

/** When the PR entered the gate — the first ci:local run in its worktree after it
 * opened, its gate status, a receipt — null when it is in the gate with no time
 * (ci:local holding the machine now), undefined when the gate never began. */
function gateSince(pr: PrView, sessions: readonly BoardSession[], input: BoardInputs): number | null | undefined {
  const times: number[] = [];
  for (const session of sessions) {
    if (!sessionPrs(session).includes(pr.number)) continue;
    for (const at of input.ciRuns?.[session.id] ?? []) if (at >= pr.createdAt) times.push(at);
  }
  const receipt = receiptFor(pr, sessions, input);
  if (receipt && (receipt.head || (receipt.finishedAt ?? 0) >= pr.createdAt) && receipt.finishedAt !== null) times.push(receipt.finishedAt);
  if (pr.gate !== "missing" && pr.gateAt !== null) times.push(pr.gateAt);
  if (times.length) return Math.min(...times);
  if (pr.gate !== "missing" || admissionFor(pr, input) !== null || receipt?.head) return null;
  return undefined;
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
  return { commit, finishedAt: utcStamp(field("CI_FINISHED_AT")) };
}

/** "20261001T155724Z" (ci:local's stamps) as an instant. */
export function utcStamp(text: string): number | null {
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(text);
  return stamp ? Date.UTC(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3]), Number(stamp[4]), Number(stamp[5]), Number(stamp[6])) : null;
}
