// Self-paced work for one bot in one conversation, without a person typing.
//
// Two pieces, one ledger:
//   - A wake: the bot asked (wake_me) to be given a new turn in this
//     conversation after N minutes — to check a CI run, a deploy, another
//     agent's session, or to follow a "check every 2 minutes" rule. One
//     pending wake per conversation; a new one replaces it.
//   - A watch (wake_when) is a wake with a read-only command attached: the
//     server runs it every few minutes, with no model involved, and moves
//     the wake up to "now" once the output changes, matches what the bot
//     waits for, or keeps failing. The time limit still wakes it regardless.
//   - A standing watch (wake_when standing) is never used up: after it fires
//     it re-arms on the output it fired on, whether or not the turn could
//     start. It lives beside the conversation's one ordinary wake, so a
//     wake_me there never replaces it.
//   - A promise (wake_me promise): the bot owes someone an answer by a
//     time ("responder ao cliente até 16h"). It is not a wake: nothing
//     happens while it is kept in time. Past its time and not marked kept
//     (wake_me promise_kept), it is reported to the bot and to its Chief.
//   - A goal: the bot was told to keep working until something is delivered
//     (goal_start). The harness keeps handing it continuation turns until it
//     calls goal_end, a limit runs out, or the person presses Stop.
//
// This file is state and policy only: it decides what is due and what the
// continuation prompt says. server/index.ts owns the timer, the busy checks
// and startTurn. Persisted to one JSON file so a restart neither drops a
// promised wake nor forgets a running goal.
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import type { RowCheck, Superseded } from "./owner-pending-guard.ts";
import { leadingVocative } from "./owner-channel.ts";
import { languageReminder } from "./reply-language.ts";
import { stripLeadingMentions } from "../shared/owner-pending-title.ts";
import { lineHash, newestStamp } from "./wake-watch.ts";
import type { OwnerDelegation, OwnerDelegationBack } from "./owner-delegate.ts";
import { chatStartHash, chatTexts, ECHO_WINDOW_MS, isEcho, normalize, vmChatPostOf, vmSheetNoteOf, watchKindOf, withoutLeadingMentions, type SelfWrite } from "./watch-echo.ts";
/** How long, and how many, message starts a bot keeps as seen in its Chat watches. */
export const SEEN_CHAT_MS = 24 * 3_600_000;
export const SEEN_CHAT_MAX = 2_000;
/** Message starts kept on disk per bot (the newest, as hashes), and the most lines of a watch run kept (as hashes). */
export const ECHO_SEEN_PERSIST_MAX = 1_000;
export const ECHO_LINES_PERSIST_MAX = 5_000;

/** The echo memory on disk (bot-autonomy.echo.json): no client text, only hashes. */
interface EchoMemory {
  selfWrites: Record<string, SelfWrite[]>;
  seenChatHashes: Record<string, Array<[string, number]>>;
  lastLineHashes: Record<string, { fingerprint: string; hashes: string[] }>;
}

export const WAKE_MIN_MINUTES = 1;
export const WAKE_MAX_MINUTES = 1_440;
export const WAKE_REASON_MAX = 500;
export const GOAL_TEXT_MAX = 2_000;
export const GOAL_DETAIL_MAX = 500;
export const GOAL_DEFAULT_MAX_TURNS = 60;
export const GOAL_MAX_TURNS_LIMIT = 200;
export const GOAL_DEFAULT_MAX_HOURS = 12;
export const GOAL_MAX_HOURS_LIMIT = 72;
/** Consecutive failed turns before a goal stops as blocked. */
export const GOAL_MAX_CONSECUTIVE_FAILURES = 3;
/** A continuation is never dispatched sooner than this after the previous
 * one, even if the thread already looks idle: startTurn resolves on dispatch,
 * and the busy flag must get a chance to settle before the next check. */
export const GOAL_MIN_TURN_GAP_MS = 15_000;

export const WATCH_MIN_EVERY_MINUTES = 1;
export const WATCH_MAX_EVERY_MINUTES = 60;
export const WATCH_DEFAULT_EVERY_MINUTES = 2;
export const WATCH_MIN_MAX_MINUTES = 5;
export const WATCH_DEFAULT_MAX_MINUTES = 120;
export const WATCH_UNTIL_MAX = 200;
/** Consecutive failed runs before the bot is woken to fix its command. */
export const WATCH_MAX_FAILURES = 3;
const WATCH_PROMPT_OUTPUT_MAX = 1_500;

export type WatchTrigger = "changed" | "matched" | "failing";

export interface WakeWatch {
  command: string;
  argv: string[];
  everyMs: number;
  until?: string;
  baseline: string;
  /** sha256 of the whole baseline output; absent on watches set before it existed. */
  baselineFingerprint?: string;
  lastOutput?: string;
  /** sha256 of the latest successful output; a standing watch compares against it. */
  lastFingerprint?: string;
  /** Fingerprints cover stdout only (older watches fingerprinted stderr too). */
  stdoutFingerprint?: true;
  lastRunAt: number;
  runs: number;
  failures: number;
  trigger?: WatchTrigger;
  /** What made a standing watch fire last time. */
  lastTrigger?: WatchTrigger;
  /** Never used up: re-armed after each firing. */
  standing?: true;
  /** Names one of a conversation's standing watches ("chat", "planilha"); absent = "default". */
  label?: string;
  /** A standing watch's time limit, re-applied on each re-arm. */
  maxMs?: number;
  /** Times it fired; a standing watch keeps counting. */
  fired?: number;
  /** Hashes of the latest stdout's lines, and the lines new since the run
   * before (shown when the output is cut at WATCH_OUTPUT_MAX). */
  lineHashes?: string[];
  newLines?: string[];
  truncated?: boolean;
  /** When its reason was written (a standing watch keeps it across re-arms). */
  reasonAt?: number;
  /** Lines matching this do not count as a change (wake_when ignore). */
  ignore?: string;
  /** When its stdout last changed (or it was set), and when an old,
   * unchanging output was reported. */
  changedAt?: number;
  staleAlertedAt?: number;
  /** The last change it let pass as the bot's own write (server/watch-echo.ts). */
  echoAt?: number;
  /** That change: how many lines, why each was the bot's, the first one. */
  echo?: { at: number; lines: number; reasons: string[]; sample: string };
  /** An unanchored `ignore` was pointed out in its conversation. */
  ignoreWarnedAt?: number;
}

export interface BotWake {
  botId: string;
  threadId: string;
  dueAt: number;
  reason: string;
  createdAt: number;
  watch?: WakeWatch;
  /** Turns for it that failed to start (VM, docker, engine); spaces the retries. */
  dispatchFailures?: number;
}

export type GoalEndStatus = "completed" | "blocked" | "needs-input";
export type GoalStatus = "active" | GoalEndStatus | "stopped" | "limit";

export interface BotGoal {
  botId: string;
  threadId: string;
  goal: string;
  status: GoalStatus;
  startedAt: number;
  deadlineAt: number;
  maxTurns: number;
  turnCount: number;
  consecutiveFailures: number;
  lastDispatchAt?: number;
  detail?: string;
  finishedAt?: number;
}

/** Reports waiting to be handed to a conversation (Claude Code sessions the
 * bot manages finished a turn). Kept apart from wakes so a report never
 * replaces a pending wake or watch, and several reports arrive together. */
export interface PendingReports {
  botId: string;
  threadId: string;
  items: string[];
  /** A turn for them failed to start: not before this, and how many times. */
  notBefore?: number;
  dispatchFailures?: number;
}

/** A wake or reports handed to a turn that has not finished yet. Kept on
 * disk until the turn completes, so a restart in between gives it back
 * instead of losing it. */
export interface InFlight {
  kind: "wake" | "reports";
  botId: string;
  threadId: string;
  startedAt: number;
  wake?: BotWake;
  items?: string[];
}

/** A lease older than this is not given back after a restart. */
export const IN_FLIGHT_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** A lease older than this is not re-run after a restart: the bot is asked
 * whether it still holds (it may already have answered a client). */
export const IN_FLIGHT_STALE_MS = 6 * 3_600_000;
export const STALE_PREFIX = "[Este turno foi interrompido por um restart do servidor há mais de 6 h e NÃO foi repetido automaticamente. Antes de agir, confira se ainda vale — uma resposta a cliente pode já ter sido enviada.]";
/** The longest wait between retries of a turn that failed to start. */
export const DISPATCH_RETRY_MAX_MINUTES = 10;

/** What a restart found cut off, for the resumption report. */
export interface RecoveredLease { botId: string; threadId: string; kind: InFlight["kind"]; startedAt: number; stale: boolean; what: string }
export const INTERRUPTED_PREFIX = "[A execução anterior foi interrompida por um restart do servidor antes de terminar; retome daqui.]";

/** Something the bot owes by a time; see the header. */
export interface BotPromise {
  id: string;
  botId: string;
  threadId: string;
  text: string;
  dueAt: number;
  createdAt: number;
  /** Reported as overdue (once). */
  overdueAt?: number;
}
/** Something that waits on the person (owner_pending): a decision, an
 * approval, a draft left in a field. It stays in "Precisa de você" until
 * the bot, the server or the person resolves it. */
export interface OwnerPending {
  id: string;
  botId: string;
  threadId: string;
  title: string;
  createdAt: number;
  /** By when, as the bot wrote it ("hoje 18h", "2026-10-02"). */
  due?: string;
  /** Where to act on it (a PR, a claude:// session link). */
  link?: string;
  /** The exact command the person runs to act on it (copied in "Precisa de você"). */
  command?: string;
  /** Set by the server for its own items, so it can resolve them itself. */
  key?: string;
  /** Ids of equivalent items folded into this one (still resolvable by them). */
  aliases?: string[];
  /** Why it matters, in one or two sentences (shown above the steps). */
  why?: string;
  /** What to do, in order: each step may carry the exact command or a link. */
  steps?: OwnerPendingStep[];
  /** When it is a choice: the answers the person can pick, each one the reply
   * the bot receives in its conversation. */
  options?: OwnerPendingOption[];
  /** The person asked the bot to rewrite it with steps (the bot's update clears it). */
  stepsRequestedAt?: number;
  /** The person asked the bot which decision it recommends (the bot's update clears it). */
  recommendRequestedAt?: number;
  /** The server asked the bot for this item's steps on its own, once (J17): never again for it. */
  stepsAutoAskedAt?: number;
  /** What the person answered from "Precisa de você", in order (J18): kept with the item, and after it is resolved. */
  history?: OwnerPendingAnswer[];
  /** The person's last answer reached the bot and the bot has not updated nor resolved the item since (J18). */
  awaitingSince?: number;
  /** Last time the bot rewrote it (owner_pending update). */
  updatedAt?: number;
  /** A routine's item (server/routine-owner-ask.ts): the last time the routine said it. */
  lastSaidAt?: number;
  /** A routine's item: runs of its routine in a row that did not name it since it was last said (or kept). */
  quietRuns?: number;
  /** A routine's item said once and let go (48 h and 2 runs without it): out of the count, under "Talvez já resolvido". */
  demotedAt?: number;
  /** The owner said "Ainda vale": back on top, the 48 h and 2 runs count again from here. */
  keptAt?: number;
  /** A routine's item: the routine that said it (its runs are counted by it, not by a name that may change). */
  routineId?: string;
  /** The owner delegated it to a Claude Code session (lote del): out of the count while it runs. */
  delegation?: OwnerDelegation;
  /** It came back from a delegation (partial, stopped by the hook, never opened): on top, with why. */
  delegationBack?: OwnerDelegationBack;
  /** Another bot's item (or another of its own) said this one's commands must not run (R13-intake #1): decisions and commands off. */
  supersededBy?: Superseded;
  /** What the server last read of the fixed sheet rows its commands write (R13-intake #1), one per row. */
  rowChecks?: RowCheck[];
  /** A disk item's folders kept out, each "name (why)" (INSP-R13fol #8). */
  diskKept?: string[];
  /** A bot's mixed item: the folders whose removal was taken to the server's disk item — an answer naming them authorizes nothing (R5-1). */
  diskMoved?: string[];
}

/** One answer of the person to an item (J18). */
export interface OwnerPendingAnswer {
  at: number;
  kind: "option" | "text" | "ask";
  /** The option's label, or the ask ("steps", "recommend", "remind"). */
  label?: string;
  /** What reached the bot (the option's reply, the person's words, the ask). */
  text: string;
  by: "owner";
  /** It reached the bot: its turn started with it. */
  delivered: boolean;
  /** Waiting its turn (the conversation is busy): not delivered yet, not failed (INSP-J2 r2 N9). */
  queued?: true;
  /** The send queue's id, to settle it when it drains. */
  queueId?: string;
  /** Why it did not reach the bot. */
  error?: string;
}

/** What of the items a session may see: those whose conversation it may
 * write in (`refusal` is the guest rule: null when it may). INSP-J2 r2 N7. */
export function ownerPendingVisible<T extends { threadId: string }>(items: readonly T[], refusal: (threadId: string) => string | null): T[] {
  return items.filter((item) => refusal(item.threadId) === null);
}

/** An answered item waits on its bot this long; then it is the person's again (INSP-J2 #2). */
export const OWNER_PENDING_AWAIT_MS = 2 * 3_600_000;
/** The server's reminder to a bot that let an answered item go silent (INSP-J2 r2 N3). */
export const REMIND_REPORT_PREFIX = "[Servidor: lembrete de pendência]";

/** The reminder, as a system report: facts and the two tool calls, never in the person's voice. */
export function ownerPendingRemindReport(item: Pick<OwnerPending, "id" | "title" | "awaitingSince" | "history">, now: number): string {
  const last = item.history?.findLast((each) => each.delivered || each.queued);
  const what = last?.kind === "option" ? `escolheu «${last.label ?? ""}»` : last?.kind === "ask" ? "pediu ajuda" : "respondeu";
  const hours = Math.max(1, Math.round((now - (item.awaitingSince ?? now)) / 3_600_000));
  return `${REMIND_REPORT_PREFIX} ${item.id} («${item.title}»): a pessoa ${what} há ${hours} h e o item segue em "Precisa de você" sem resposta sua. Faça o que foi pedido e feche com owner_pending resolve id ${item.id}, ou diga o que falta com owner_pending update id ${item.id}.`;
}

/** A settled item, as kept for audit (J18). */
export interface ResolvedOwnerPending extends OwnerPending {
  resolvedAt: number;
  resolvedBy: "owner" | "bot" | "server";
  /** How, when it says more than who ("respondida na conversa"). */
  resolvedNote?: string;
}
export interface OwnerPendingStep {
  text: string;
  command?: string;
  link?: string;
}
export interface OwnerPendingOption {
  label: string;
  reply: string;
  /** The bot's pick among the decisions (at most one per item), with why in one sentence. */
  recommended?: true;
  why?: string;
}
export const OWNER_PENDING_TITLE_MAX = 200;
/** Answers kept per item, and settled items kept for audit (J18). */
export const OWNER_PENDING_HISTORY_MAX = 30;
export const RESOLVED_PENDING_MAX = 200;
export const RESOLVED_PER_KEY = 3;
export const OWNER_PENDING_OPTION_WHY_MAX = 200;
export const OWNER_PENDING_WHY_MAX = 400;
export const OWNER_PENDING_STEPS_MAX = 8;
export const OWNER_PENDING_STEP_MAX = 300;
export const OWNER_PENDING_OPTIONS_MAX = 4;
export const OWNER_PENDING_OPTION_LABEL_MAX = 40;
export const OWNER_PENDING_OPTION_REPLY_MAX = 500;

/** A link the person can open from "Precisa de você": the web, or the Claude app. */
const OPENABLE_LINK = /^(?:https?:\/\/\S+|claude:\/\/\S+)$/i;
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** The structured part of an item (why, steps, options), as a bot sent it in
 * owner_pending: checked and clipped, or the reasons it is refused — in
 * pt-BR, since the bot reads them and fixes its call. A JSON string where an
 * array belongs is read as that array (some engines send nested values as
 * text). Absent fields stay absent; an empty list clears. */
export function parseOwnerPendingDetails(input: { why?: unknown; steps?: unknown; options?: unknown }): {
  ok: true; why?: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[];
} | { ok: false; error: string } {
  const list = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  };
  const out: { why?: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[] } = {};
  if (input.why !== undefined && input.why !== null) {
    if (typeof input.why !== "string") return { ok: false, error: "why deve ser um texto (1–2 frases dizendo por que importa)" };
    out.why = oneLine(input.why).slice(0, OWNER_PENDING_WHY_MAX);
  }
  const steps = list(input.steps);
  if (steps !== undefined && steps !== null) {
    if (!Array.isArray(steps)) return { ok: false, error: "steps deve ser uma lista de passos: [{\"text\": \"…\", \"command\": \"…\", \"link\": \"…\"}]" };
    if (steps.length > OWNER_PENDING_STEPS_MAX) return { ok: false, error: `no máximo ${OWNER_PENDING_STEPS_MAX} passos: junte os menores` };
    out.steps = [];
    for (const [index, raw] of steps.entries()) {
      const step = typeof raw === "string" ? { text: raw } : raw as Record<string, unknown> | null;
      const text = step && typeof step.text === "string" ? oneLine(step.text) : "";
      if (!text) return { ok: false, error: `o passo ${index + 1} precisa de text: o que a pessoa faz, em uma frase` };
      const command = step && typeof step.command === "string" ? step.command.trim() : "";
      const link = step && typeof step.link === "string" ? step.link.trim() : "";
      if (link && !OPENABLE_LINK.test(link)) return { ok: false, error: `o link do passo ${index + 1} deve começar com https:// (ou claude://)` };
      out.steps.push({ text: text.slice(0, OWNER_PENDING_STEP_MAX), ...(command ? { command: command.slice(0, 500) } : {}), ...(link ? { link: link.slice(0, 500) } : {}) });
    }
  }
  const options = list(input.options);
  if (options !== undefined && options !== null) {
    if (!Array.isArray(options)) return { ok: false, error: "options deve ser uma lista de decisões: [{\"label\": \"Aprovar\", \"reply\": \"Aprovado, pode seguir.\"}]" };
    if (options.length > OWNER_PENDING_OPTIONS_MAX) return { ok: false, error: `no máximo ${OWNER_PENDING_OPTIONS_MAX} opções de decisão` };
    out.options = [];
    for (const [index, raw] of options.entries()) {
      const option = raw as Record<string, unknown> | null;
      const label = option && typeof option.label === "string" ? oneLine(option.label) : "";
      const reply = option && typeof option.reply === "string" ? option.reply.trim() : "";
      if (!label || !reply) return { ok: false, error: `a opção ${index + 1} precisa de label (o botão, ex. "Aprovar") e reply (o que você recebe quando a pessoa escolhe)` };
      if (label.length > OWNER_PENDING_OPTION_LABEL_MAX) return { ok: false, error: `o label da opção ${index + 1} passa de ${OWNER_PENDING_OPTION_LABEL_MAX} caracteres: use um verbo curto ("Aprovar", "Recusar")` };
      if (out.options.some((each) => each.label.toLowerCase() === label.toLowerCase())) return { ok: false, error: `duas opções com o label "${label}"` };
      const recommended = option?.recommended === true || option?.recommended === "true";
      const why = option && typeof option.why === "string" ? oneLine(option.why).slice(0, OWNER_PENDING_OPTION_WHY_MAX) : "";
      if (recommended && !why) return { ok: false, error: `a opção recomendada ("${label}") precisa de why: em uma frase, por que é a melhor` };
      out.options.push({ label, reply: reply.slice(0, OWNER_PENDING_OPTION_REPLY_MAX), ...(recommended ? { recommended: true as const, why } : {}) });
    }
    if (out.options.filter((each) => each.recommended).length > 1) return { ok: false, error: "no máximo UMA opção recomendada: marque recommended só na melhor" };
  }
  return { ok: true, ...out };
}

/** A settled item as kept for audit: who, what, when and what the person
 * answered — not its why/steps/options, so the ledger (rewritten on every
 * save) stays small (INSP-J2 #12). */
function slimResolved(item: OwnerPending, resolvedAt: number, resolvedBy: ResolvedOwnerPending["resolvedBy"], note?: string): ResolvedOwnerPending {
  return {
    id: item.id, botId: item.botId, threadId: item.threadId, title: item.title, createdAt: item.createdAt, resolvedAt, resolvedBy,
    ...(note ? { resolvedNote: note } : {}),
    ...(item.key ? { key: item.key } : {}),
    // a routine's item keeps the words it quoted: the routine repeating the SAME pendency is told from a new one (INSP-N22 A2)
    ...(item.key?.startsWith("routine-ask:") && item.why ? { why: item.why } : {}),
    ...(item.history?.length ? { history: item.history.slice(-OWNER_PENDING_HISTORY_MAX) } : {}),
  };
}

/** The newest RESOLVED_PENDING_MAX, and at most RESOLVED_PER_KEY of one
 * server item (the power item comes back at every unplug). */
function keepResolved(items: readonly ResolvedOwnerPending[]): ResolvedOwnerPending[] {
  const perKey = new Map<string, number>();
  const kept: ResolvedOwnerPending[] = [];
  for (const item of [...items].reverse()) {
    if (item.key) {
      const seen = perKey.get(item.key) ?? 0;
      if (seen >= RESOLVED_PER_KEY) continue;
      perKey.set(item.key, seen + 1);
    }
    kept.push(item);
    if (kept.length >= RESOLVED_PENDING_MAX) break;
  }
  return kept.reverse();
}

/** The decisions put the recommended one first (the person reads it first,
 * and its color says so); the rest keep the bot's order. */
export function recommendedFirst<T extends { recommended?: true }>(options: readonly T[]): T[] {
  return [...options.filter((each) => each.recommended), ...options.filter((each) => !each.recommended)];
}

/** An item without why or steps is refused (J17: the owner does not want to
 * click "Pedir o passo a passo" — the steps come with the item). The bot
 * hears exactly what is missing; null when the item is complete. */
export function practicalMissing(item: { why?: string | undefined; steps?: readonly unknown[] | undefined; options?: ReadonlyArray<{ label: string; recommended?: unknown }> | undefined }): string | null {
  const missing = missingParts(item);
  if (!missing.length) return null;
  const said = missing.join(" e ");
  return `owner_pending recusado: falta ${said}. Todo item nasce com why (1–2 frases: por que importa e o que acontece se esperar) e steps (pelo menos 1 passo prático, na ordem; o comando exato em command ou o link em link quando houver), por exemplo steps: [{"text": "No Terminal, grave a recusa", "command": "echo <sha> > ~/.nuria/declined-production-release.sha"}]; com 2 ou mais options, UMA delas com recommended: true e why (uma frase: por que é a melhor). A pessoa não deve precisar pedir o passo a passo nem a recomendação. Mande de novo com ${said}.`;
}

/** What an item lacks to be practical: "why", "steps", "a recomendada" (2+ options, none marked — INSP-J2 #7). */
export function missingParts(item: { why?: string | undefined; steps?: readonly unknown[] | undefined; options?: ReadonlyArray<{ label: string; recommended?: unknown }> | undefined }): string[] {
  return [
    !item.why?.trim() ? "why" : "",
    !item.steps?.length ? "steps" : "",
    (item.options?.length ?? 0) >= 2 && !item.options!.some((option) => option.recommended) ? "a recomendada" : "",
  ].filter(Boolean);
}

/** The server's own request, as a report to the bot, for an older item's
 * steps (J17): nobody typed it, and the person is not answered for it. */
export const STEPS_REPORT_PREFIX = "[Servidor: pendências sem passo a passo]";

/** The server's own request, ONE report per bot for all its items that
 * lack something (J17, INSP-J2 #5): each with exactly what it lacks. Nobody
 * typed it, and the person is not answered for it. */
export function ownerPendingStepsAutoReport(items: ReadonlyArray<Pick<OwnerPending, "id" | "title" | "why" | "steps" | "options">>): string {
  const lines = items.map((item) => `- ${item.id} («${item.title.slice(0, 120)}»): falta ${missingParts(item).join(" e ")}`);
  return `${STEPS_REPORT_PREFIX} Itens: ${items.map((item) => item.id).join(", ")}. O dono quer cada pendência com o passo a passo e, se for uma escolha, com a sua recomendação. Complete cada um com owner_pending update (why: 1–2 frases sobre por que importa; steps: passos práticos com o comando em command ou o link em link quando houver; options: UMA com recommended: true e why):\n${lines.join("\n")}\nSe um item não vale mais, resolva-o com owner_pending resolve. Não escreva ao dono só por isto.`;
}

/** A question a bot ended its turn with (a goal's needs_input, or its reply
 * that waits on the person), which the server asked it, once, to register
 * as an owner_pending item with why, steps and options (lot J2): the
 * question's own line in "Precisa de você" gives way to that item. */
export interface AskPromotion {
  botId: string;
  /** The conversation that asked. */
  threadId: string;
  /** When it asked (the line's "since"): one request per question. */
  askAt: number;
  /** What it asked, as the panel shows it. */
  text: string;
  /** When the server asked the bot (again, when the person asked it to). */
  askedAt: number;
  /** Where the request went: the owner's channel, or the conversation itself. */
  reportThreadId: string;
  /** The item the bot opened for it, linked by owner_pending add replacesAsk. */
  itemId?: string;
  /** That item's conversation and birth: with its id, the one item (ids were
   * reused before the counter — the Monitor had two "o2"; R12-followup #3). */
  itemThreadId?: string;
  itemCreatedAt?: number;
  /** When the server saw the person answer it in the conversation itself (settled once). */
  answeredAt?: number;
}
export const ASK_PROMOTIONS_MAX = 100;

/** The server's own request, as a report, to turn a bare question into an item (lot J2). */
export const QUESTION_REPORT_PREFIX = "[Servidor: pergunta sem passo a passo]";

/** That request: facts and the one tool call, never in the person's voice.
 * `Ref <thread>@<askAt>` lets a stop at dispatch put the question back. */
export function questionStepsAutoReport(ask: Pick<AskPromotion, "threadId" | "askAt" | "text">, threadTitle?: string): string {
  const where = threadTitle ? ` na conversa «${threadTitle.slice(0, 80)}»` : "";
  return `${QUESTION_REPORT_PREFIX} Ref ${ask.threadId}@${ask.askAt}. Você terminou um turno${where} com uma pergunta ao dono: «${ask.text.slice(0, 300)}». Em "Precisa de você" ela aparece só como título, sem por quê, sem passos e sem opções. Registre-a com owner_pending add: replacesAsk "${ask.threadId}@${ask.askAt}" (é o que liga o item a esta pergunta), title (o que o dono decide, em uma frase), why (1–2 frases: por que importa e o que acontece se esperar), steps (passos práticos, com o comando em command ou o link em link quando houver) e options (as respostas possíveis, UMA com recommended: true e why). O item substitui a pergunta na tela. Se a pergunta não vale mais, não abra nada. Não escreva ao dono só por isto.`;
}

/** The question a stopped request was about, read back from its Ref. */
export function questionReportRef(text: string): { threadId: string; askAt: number } | null {
  if (!text.startsWith(QUESTION_REPORT_PREFIX)) return null;
  const ref = /^ Ref ([\w-]+)@(\d+)\./.exec(text.slice(QUESTION_REPORT_PREFIX.length));
  return ref ? { threadId: ref[1]!, askAt: Number(ref[2]) } : null;
}

/** owner_pending add's replacesAsk, "<thread>@<askAt>" — the Ref of the
 * request it answers (INSP-J2b #1: only this link replaces a question). */
export function parseReplacesAsk(value: unknown): { threadId: string; askAt: number } | null {
  const ref = typeof value === "string" ? /^([\w-]+)@(\d+)$/.exec(value.trim()) : null;
  return ref ? { threadId: ref[1]!, askAt: Number(ref[2]) } : null;
}

/** Why an item settled by the server says the person answered its question in the conversation itself. */
export const ANSWERED_IN_CONVERSATION = "respondida na conversa";

/** The person's message that answers a question the bot asked at `askAt`
 * (INSP-J2b r2 c-2): the first one after it, before the bot asks anything
 * else — unless it names other #refs and none of the question's —, or any
 * later one naming the question's #ref. null while none does: a message
 * about something else never settles the question's item. */
export function answerToAsk(messages: ReadonlyArray<{ role: string; kind: string; text?: string; at: number; peerAsk?: unknown; from?: unknown }>, askAt: number, askText: string): { at: number; text: string } | null {
  const refs = new Set(askText.match(/#\d+/g) ?? []);
  const asks = (text: string) => /\?[\s*_`)\]]*$/.test(text);
  let first = true;
  for (const message of messages.filter((each) => each.at > askAt).toSorted((a, b) => a.at - b.at)) {
    const text = (message.text ?? "").trim();
    if (message.role === "bot" && message.kind === "text" && !message.from) {
      // the bot asked something else: what follows answers that, unless it names this question's #ref
      if (asks(text) || OWNER_ASK.test(text)) first = false;
      continue;
    }
    if (message.role !== "user" || message.kind !== "text" || message.peerAsk || message.from) continue;
    // the person asking something back never answers it, #ref or not (INSP-J2b r3)
    if (asks(text)) { first = false; continue; }
    const cited = text.match(/#\d+/g) ?? [];
    // "the first message" holds only while the question is fresh: a plain order a day later is about something else
    const fresh = message.at - askAt <= ANSWER_WINDOW_MS;
    if (cited.some((ref) => refs.has(ref)) || (first && fresh && !cited.length)) return { at: message.at, text };
    first = false;
  }
  return null;
}

/** How long after a question the person's first plain message counts as its answer (INSP-J2b r3). */
export const ANSWER_WINDOW_MS = 2 * 3_600_000;

/** The server tells the bot it closed the item of its question, answered by the person in the conversation. */
export const ANSWERED_REPORT_PREFIX = "[Servidor: pendência fechada]";
export function answeredInConversationReport(item: Pick<OwnerPending, "id" | "title">, ref: Pick<AskPromotion, "threadId" | "askAt" | "text">, answer: string): string {
  return `${ANSWERED_REPORT_PREFIX} O dono respondeu na conversa à sua pergunta «${ref.text.slice(0, 200)}»: «${answer.slice(0, 300)}». O item ${item.id} («${item.title.slice(0, 120)}») foi fechado como ${ANSWERED_IN_CONVERSATION}. Se era a resposta, siga com ela. Se não era resposta a esta pergunta, reabra o item com owner_pending add replacesAsk "${ref.threadId}@${ref.askAt}" (o mesmo title, why, steps e options). Não escreva ao dono só por isto.`;
}

/** What only the bot reads when the person asks, from "Precisa de você",
 * which decision it recommends (the turn's prompt, never the transcript). */
export function ownerPendingRecommendNote(item: Pick<OwnerPending, "id">): string {
  return `[Nota do OpenMausBot, não escrita pela pessoa] A pessoa abriu a pendência ${item.id} em "Precisa de você" e pediu a sua recomendação. Reescreva as options com owner_pending update, id ${item.id}: as mesmas decisões, com recommended: true em UMA delas (a que você escolheria) e why (uma frase: por que é a melhor). Responda à pessoa em uma frase.`;
}

/** The person's words for that request. */
export function ownerPendingRecommendText(item: Pick<OwnerPending, "title">, botName: string): string {
  return `${botName}, qual destas decisões você recomenda para «${item.title}», e por quê?`;
}

/** 7 for "o7"; 0 for anything else. */
function ownerPendingNumber(id: string): number {
  const match = /^o(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** The item said again with the same commands and decisions (or none sent): what was said of them still holds. */
const sameCommands = (existing: OwnerPending, input: { steps?: OwnerPendingStep[]; options?: OwnerPendingOption[] }) =>
  (!input.steps?.length || JSON.stringify(input.steps) === JSON.stringify(existing.steps)) && (!input.options?.length || JSON.stringify(input.options) === JSON.stringify(existing.options));

/** A saved item's structured part, read back defensively (an older ledger
 * has none; a hand-edited one may carry anything). */
function savedDetails(pending: OwnerPending): OwnerPending {
  // a saved recommendation that no longer passes (no why, or two of them) loses
  // only the mark — never the item's why, steps and options (INSP-J2 #13)
  let marked = false;
  const options = Array.isArray(pending.options)
    ? pending.options.map((option) => {
      if (!option || typeof option !== "object" || !option.recommended) return option;
      const keep = !marked && typeof option.why === "string" && option.why.trim().length > 0;
      if (keep) { marked = true; return option; }
      const { recommended: _r, why: _w, ...rest } = option;
      return rest;
    })
    : pending.options;
  const details = parseOwnerPendingDetails({ why: pending.why, steps: pending.steps, options });
  const { why: _why, steps: _steps, options: _options, history, awaitingSince, ...base } = pending;
  // the person's answers, read back defensively: a hand-edited ledger must never break the screen
  const answers = Array.isArray(history)
    ? history.filter((each): each is OwnerPendingAnswer => Boolean(each) && typeof each === "object" && typeof each.at === "number" && typeof each.text === "string" && (each.kind === "option" || each.kind === "text" || each.kind === "ask") && typeof each.delivered === "boolean")
      .slice(-OWNER_PENDING_HISTORY_MAX)
    : [];
  const kept = { ...base, ...(answers.length ? { history: answers } : {}), ...(typeof awaitingSince === "number" && Number.isFinite(awaitingSince) ? { awaitingSince } : {}) };
  if (!details.ok) return kept;
  return { ...kept, ...(details.why ? { why: details.why } : {}), ...(details.steps?.length ? { steps: details.steps } : {}), ...(details.options?.length ? { options: details.options } : {}) };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** The commits an item's title names: 9–40 hex characters with a digit and
 * a letter — not a conversation's id ("6477b3f4", 8 characters, or a whole
 * uuid), which is no commit (INSP-H r1 #3). */
export function commitsIn(title: string): string[] {
  return [...title.replace(UUID, " ").matchAll(/(?<![0-9a-z])([0-9a-f]{9,40})(?![0-9a-z])/gi)].map((match) => match[1]!.toLowerCase()).filter((hex) => /\d/.test(hex) && /[a-f]/.test(hex));
}
const normalLink = (link: string) => link.trim().replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
const normalTitle = (title: string) => title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();
/** The words that carry a title's meaning (4+ letters, or a #number). */
const titleWords = (title: string) => new Set(normalTitle(title).split(" ").filter((each) => each.length >= 4 || /^#\d+$/.test(each)));
/** Two titles mostly about the same: at least 60% of the shorter one's words in the other. */
function similarTitles(a: string, b: string): boolean {
  const [small, large] = [titleWords(a), titleWords(b)].sort((x, y) => x.size - y.size);
  if (!small!.size) return false;
  return [...small!].filter((each) => large!.has(each)).length / small!.size >= 0.6;
}

/** The ACTION an item asks for, when it is one the server knows by key:
 * its own key, or — for a bot's item — the same action read from its title
 * (refusing a looping release of a commit, advancing the tag to a commit,
 * plugging the Mac in). Merely naming a commit is no action: "Revisar com
 * o QA o diff do cb015584a" is not the release loop (INSP-H r1 #3). */
export function ownerPendingAction(item: { title: string; key?: string }): { kind: string; sha?: string } | null {
  if (item.key) {
    const [kind, ...rest] = item.key.split(":");
    return { kind: kind!, ...(rest.length ? { sha: rest.join(":").toLowerCase() } : {}) };
  }
  const sha = commitsIn(item.title)[0];
  // stopping a release of the commit: a verb of stopping, any inflection ("parar", "paramos",
  // "pausar", "recusar", "desligar"; not "para", the preposition) AND what is stopped
  // (release, watcher, loop, LaunchAgent) — "Conferir no watcher se o deploy terminou" asks
  // something else and must not be folded nor closed with the loop (INSP-H r2 #5)
  // INSP-H r3 #1: "travar" too ("Gravar a trava do release d5bb1f70b", the real o15), not
  // "parou" (a check: "Conferir se o release parou"), and never under a negation
  // ("Não parar o release ainda", "sem pausar o watcher")
  const verbs = [...item.title.matchAll(/(?<![\p{L}])(?:par(?:ar|amos|e|em|ando)|paus\p{L}*|recus\p{L}*|deslig\p{L}*|interromp\p{L}*|halt\p{L}*|declin\p{L}*|trav(?:ar|e|em|amos|a)?)(?![\p{L}])/giu)];
  const negated = (at: number) => /(?<![\p{L}])(?:n[ãa]o|nem|sem)\s+(?:\S+\s+){0,2}$/iu.test(item.title.slice(0, at));
  const stops = verbs.filter((match) => !negated(match.index)).map((match) => match.index);
  // writing the refusal itself is stopping the release ("Escrever o declined do d5bb1f70b")
  const writes = /(?<![\p{L}])(?:grav|escrev)\p{L}*\s+(?:a\s+trava|o\s+declined|a\s+recusa)(?![\p{L}])/iu.exec(item.title);
  // undoing it is the opposite ask (INSP-H r4 #1): "Liberar o release … (desfazer a recusa)",
  // "Destrave o release … (tire a trava)" — an undo said BEFORE the stop/refusal cancels it;
  // the real o15 ("Gravar a trava … para destravar a PR") undoes nothing of the release
  const firstStop = Math.min(...stops, writes?.index ?? Number.POSITIVE_INFINITY);
  const undo = /(?<![\p{L}])(?:desfaz\p{L}*|desfa[çc]a|tir[ae]\p{L}*|remov\p{L}*|apag\p{L}*|rm|liber\p{L}*|destrav\p{L}*)(?![\p{L}])/iu.exec(item.title);
  const undone = undo !== null && undo.index < firstStop;
  if (sha && !undone && (writes || (stops.length && /(?<![\p{L}])(?:release|watcher|la[çc]o|loop|launchagent|carrier)(?![\p{L}])/iu.test(item.title)))) return { kind: "release-loop", sha };
  // INSP-H r3 #3: the owner opening a fresh session at the repository's root is the server's
  // "destravar o app" item (app-reused-folder:<repo>) — not under a negation (INSP-H r4 #2)
  const unblock = /(?<![\p{L}])abr\p{L}*\s+(?:no\s+app(?:\s+claude)?\s+)?(?:uma\s+)?sess[ãa]o[^.;]{0,40}?raiz\s+d[eo]\s+([\w.-]+)/iu.exec(item.title);
  if (unblock && !negated(unblock.index)) return { kind: "app-reused-folder", sha: unblock[1]!.replace(/[.,;:]+$/, "") };
  if (sha && /avan[çc]ar a tag/iu.test(item.title)) return { kind: "tag-advance", sha };
  if (/(?:ligu?e|ligar) o mac na tomada/iu.test(item.title)) return { kind: "power", sha: "battery" };
  return null;
}
const HEX_SHA = /^[0-9a-f]{7,40}$/;
/** The same action: same kind, and the same target (a commit by prefix, anything else exactly). */
const sameAction = (a: { kind: string; sha?: string }, b: { kind: string; sha?: string }) =>
  a.kind === b.kind && (a.sha !== undefined && b.sha !== undefined && HEX_SHA.test(a.sha) && HEX_SHA.test(b.sha) ? a.sha.startsWith(b.sha) || b.sha.startsWith(a.sha) : a.sha === b.sha);

/** Two of a bot's items ask the person for the same thing (R9-followup #3:
 * three items, in three conversations, for one release loop): the same
 * action (server key, or the same action read from a title); else the same
 * title; else the same link AND a similar title — "Aprovar o merge da PR
 * #9332" and "#9052 / PR #9332: confirmar o padrão" share a link, not an
 * ask (INSP-H r1 #3). */
export function sameOwnerPending(a: { title: string; link?: string; key?: string }, b: { title: string; link?: string; key?: string }): boolean {
  const actionA = ownerPendingAction(a);
  const actionB = ownerPendingAction(b);
  if (actionA && actionB) return sameAction(actionA, actionB);
  if (a.key && b.key) return false;
  if (normalTitle(a.title) === normalTitle(b.title)) return true;
  return Boolean(a.link && b.link && normalLink(a.link) === normalLink(b.link) && similarTitles(a.title, b.title));
}
export const OWNER_PENDING_MAX_PER_THREAD = 10;

export const PROMISE_TEXT_MAX = 300;
export const PROMISE_MAX_MINUTES = 7 * 1_440;
export const PROMISES_MAX_PER_THREAD = 10;

interface Ledger {
  promises?: BotPromise[];
  ownerPending?: OwnerPending[];
  /** Items settled, kept with their history for audit (the newest RESOLVED_PENDING_MAX). */
  resolvedOwnerPending?: ResolvedOwnerPending[];
  wakes: BotWake[];
  goals: BotGoal[];
  reports?: PendingReports[];
  inFlight?: InFlight[];
  standingLost?: StandingLost[];
  /** Questions a bot left in a conversation, asked once to become items (lot J2). */
  askPromotions?: AskPromotion[];
  /** Per bot, the number of its last "oN": ids only go up, never reused (R12-followup #3). */
  ownerPendingSeq?: Record<string, number>;
  /** "Push e remover" answered: the commits the server looks for on the remote after the turn that carries the answer (INSP-R13fol R2-4). */
  diskPushChecks?: DiskPushCheck[];
}

/** One "Push e remover" answer the server checks on the remote, kept across a restart. */
export interface DiskPushCheck {
  botId: string;
  /** The conversation the answer was sent to, and when, and how it begins: the turn that carried it ends there. */
  threadId: string;
  at: number;
  marker: string;
  folders: Array<{ name: string; branch?: string; head: string }>;
}

/** A conversation whose last standing watch was cancelled: a watcher bot
 * left without its watcher. Alerted once if nothing re-arms it in time. */
export interface StandingLost { botId: string; threadId: string; at: number; alerted?: boolean }
export const STANDING_LOST_ALERT_MS = 10 * 60_000;

const clip = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const intIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;

export type WakeInput = { ok: true; minutes: number; reason: string } | { ok: false; error: string };

export function parseWakeInput(body: { minutes?: unknown; reason?: unknown }): WakeInput {
  const minutes = intIn(body.minutes, WAKE_MIN_MINUTES, WAKE_MAX_MINUTES);
  if (minutes === null) return { ok: false, error: `minutes must be a whole number from ${WAKE_MIN_MINUTES} to ${WAKE_MAX_MINUTES}` };
  const reason = clip(body.reason, WAKE_REASON_MAX);
  if (!reason) return { ok: false, error: "reason is required: what to check or do when you wake up" };
  return { ok: true, minutes, reason };
}

export type PromiseInput = { ok: true; text: string; minutes: number } | { ok: false; error: string };

export function parsePromiseInput(body: { promise?: unknown; promiseMinutes?: unknown }): PromiseInput {
  const text = clip(body.promise, PROMISE_TEXT_MAX);
  if (!text) return { ok: false, error: "promise precisa dizer o que você deve e a quem (ex.: \"resposta ao cliente X no space Y sobre Z\")" };
  const minutes = intIn(body.promiseMinutes, 1, PROMISE_MAX_MINUTES);
  if (minutes === null) return { ok: false, error: `promise_minutes precisa ser um número inteiro de 1 a ${PROMISE_MAX_MINUTES}: o prazo, em minutos a partir de agora` };
  return { ok: true, text, minutes };
}

export type WatchInput =
  | { ok: true; everyMinutes: number; maxMinutes: number; until?: string; reason: string; standing?: true; label?: string; ignore?: string }
  | { ok: false; error: string };

export function parseWatchInput(body: { everyMinutes?: unknown; maxMinutes?: unknown; until?: unknown; reason?: unknown; standing?: unknown; label?: unknown; ignore?: unknown }): WatchInput {
  const everyMinutes = body.everyMinutes === undefined
    ? WATCH_DEFAULT_EVERY_MINUTES
    : intIn(body.everyMinutes, WATCH_MIN_EVERY_MINUTES, WATCH_MAX_EVERY_MINUTES);
  if (everyMinutes === null) return { ok: false, error: `every_minutes must be a whole number from ${WATCH_MIN_EVERY_MINUTES} to ${WATCH_MAX_EVERY_MINUTES}` };
  const maxMinutes = body.maxMinutes === undefined
    ? WATCH_DEFAULT_MAX_MINUTES
    : intIn(body.maxMinutes, WATCH_MIN_MAX_MINUTES, WAKE_MAX_MINUTES);
  if (maxMinutes === null) return { ok: false, error: `max_minutes must be a whole number from ${WATCH_MIN_MAX_MINUTES} to ${WAKE_MAX_MINUTES}` };
  if (maxMinutes < everyMinutes) return { ok: false, error: "max_minutes must be at least every_minutes" };
  const until = clip(body.until, WATCH_UNTIL_MAX) || undefined;
  const reason = clip(body.reason, WAKE_REASON_MAX);
  if (!reason) return { ok: false, error: "reason is required: what to do when the watch fires" };
  if (body.standing !== undefined && typeof body.standing !== "boolean") return { ok: false, error: "standing must be true or false" };
  const label = parseStandingLabel(body.label);
  if (label === null) return { ok: false, error: "label must be 1-40 letters, digits, spaces or . _ # : -" };
  const ignore = clip(body.ignore, WATCH_UNTIL_MAX) || undefined;
  return { ok: true, everyMinutes, maxMinutes, ...(until ? { until } : {}), ...(ignore ? { ignore } : {}), reason, ...(body.standing === true ? { standing: true as const, ...(label !== STANDING_DEFAULT_LABEL ? { label } : {}) } : {}) };
}

/** A standing watch's label: default when absent, null when malformed. */
export function parseStandingLabel(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return STANDING_DEFAULT_LABEL;
  if (typeof value !== "string") return null;
  const label = value.trim().toLowerCase();
  return /^[\p{L}\p{N} ._#:-]{1,40}$/u.test(label) ? label : null;
}

export type GoalInput =
  | { ok: true; goal: string; maxTurns: number; maxHours: number }
  | { ok: false; error: string };

export function parseGoalInput(body: { goal?: unknown; maxTurns?: unknown; maxHours?: unknown }): GoalInput {
  const goal = clip(body.goal, GOAL_TEXT_MAX);
  if (!goal) return { ok: false, error: "goal is required: the concrete deliverable and how you will know it is done" };
  const maxTurns = body.maxTurns === undefined ? GOAL_DEFAULT_MAX_TURNS : intIn(body.maxTurns, 1, GOAL_MAX_TURNS_LIMIT);
  if (maxTurns === null) return { ok: false, error: `max_turns must be a whole number from 1 to ${GOAL_MAX_TURNS_LIMIT}` };
  const maxHours = body.maxHours === undefined ? GOAL_DEFAULT_MAX_HOURS : intIn(body.maxHours, 1, GOAL_MAX_HOURS_LIMIT);
  if (maxHours === null) return { ok: false, error: `max_hours must be a whole number from 1 to ${GOAL_MAX_HOURS_LIMIT}` };
  return { ok: true, goal, maxTurns, maxHours };
}

export type GoalEndInput = { ok: true; status: GoalEndStatus; detail: string } | { ok: false; error: string };

export function parseGoalEndInput(body: { status?: unknown; detail?: unknown }): GoalEndInput {
  const raw = typeof body.status === "string" ? body.status.trim().replace("_", "-") : "";
  if (raw !== "completed" && raw !== "blocked" && raw !== "needs-input") {
    return { ok: false, error: "status must be completed, blocked or needs_input" };
  }
  const detail = clip(body.detail, GOAL_DETAIL_MAX);
  if (!detail) return { ok: false, error: "detail is required: what was delivered, or exactly what blocks it" };
  return { ok: true, status: raw, detail };
}

/** Where a wake is kept: the conversation's one ordinary wake, or its standing watch beside it. */
/** Standing watches: several per conversation, one per label, beside the
 * one ordinary wake. Keys written before labels existed read as "default". */
const STANDING = "\u0000standing";
export const STANDING_DEFAULT_LABEL = "default";
export const STANDING_MAX_PER_THREAD = 5;
const standingKey = (threadId: string, label = STANDING_DEFAULT_LABEL) => `${threadId}${STANDING}\u0000${label}`;
const wakeKey = (wake: Pick<BotWake, "threadId" | "watch">): string => (wake.watch?.standing ? standingKey(wake.threadId, wake.watch.label) : wake.threadId);

export class BotAutonomy {
  private wakes = new Map<string, BotWake>();
  private goals = new Map<string, BotGoal>();
  private reports = new Map<string, PendingReports>();
  private inFlight: InFlight[] = [];
  private standingLost = new Map<string, StandingLost>();
  private promises: BotPromise[] = [];
  private ownerPending: OwnerPending[] = [];
  private resolvedOwnerPending: ResolvedOwnerPending[] = [];
  private askPromotions: AskPromotion[] = [];
  private pushChecks: DiskPushCheck[] = [];
  private ownerPendingSeq = new Map<string, number>();
  /** The bot's recent writes to watched sources, per bot (kept across restarts: saveEcho). */
  private selfWrites = new Map<string, SelfWrite[]>();
  /** Each watch's complete output lines of its last run (kept across restarts for that very output). */
  private lastLines = new Map<string, string[]>();
  /** The fingerprint of the output each `lastLines` entry came from. */
  private lastLinesPrint = new Map<string, string>();
  /** Per bot, the start of each message its Chat watches showed, and when (insertion order = age). */
  private seenChat = new Map<string, Map<string, number>>();
  /** Per bot, the hashes of message starts seen before the last restart (chatStartHash), and when. */
  private seenChatHashes = new Map<string, Map<string, number>>();
  /** Each watch's run before the last restart, as its lines' hashes, until it runs again. */
  private savedLineHashes = new Map<string, { fingerprint: string; hashes: string[] }>();
  /** Leases a restart cut off, as found on load. */
  readonly recoveredOnLoad: RecoveredLease[] = [];
  private readonly path: string | null;
  /** The echo memory's own file, beside the ledger (null: in memory only). */
  private readonly echoPath: string | null;
  private readonly now: () => number;
  private readonly minuteMs: number;
  private readonly turnGapMs: number;

  // plain field assignments, not parameter properties — the server runs
  // under Node's type-stripping, which cannot transform the latter
  // minuteMs/turnGapMs only shrink time for end-to-end tests.
  constructor(opts: { path: string | null; now?: () => number; minuteMs?: number; turnGapMs?: number }) {
    this.path = opts.path;
    this.echoPath = opts.path ? opts.path.replace(/\.json$/, "") + ".echo.json" : null;
    this.now = opts.now ?? Date.now;
    this.minuteMs = opts.minuteMs ?? 60_000;
    this.turnGapMs = opts.turnGapMs ?? GOAL_MIN_TURN_GAP_MS;
    this.load();
    // after the ledger: a watch's lines come back only while the watch does
    this.loadEcho();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Ledger>;
      for (const wake of raw.wakes ?? []) {
        if (wake && typeof wake.threadId === "string" && typeof wake.botId === "string" && Number.isFinite(wake.dueAt)) {
          this.wakes.set(wakeKey(wake), wake);
        }
      }
      for (const pending of raw.reports ?? []) {
        if (pending && typeof pending.threadId === "string" && Array.isArray(pending.items) && pending.items.length) {
          this.reports.set(pending.threadId, pending);
        }
      }
      for (const goal of raw.goals ?? []) {
        if (goal && typeof goal.threadId === "string" && typeof goal.botId === "string" && typeof goal.goal === "string") {
          this.goals.set(goal.threadId, goal);
        }
      }
      for (const promise of raw.promises ?? []) {
        if (promise && typeof promise.id === "string" && typeof promise.threadId === "string" && typeof promise.botId === "string" && Number.isFinite(promise.dueAt)) this.promises.push(promise);
      }
      for (const pending of raw.ownerPending ?? []) {
        if (pending && typeof pending.id === "string" && typeof pending.threadId === "string" && typeof pending.botId === "string" && typeof pending.title === "string") this.ownerPending.push(savedDetails(pending));
      }
      for (const done of raw.resolvedOwnerPending ?? []) {
        if (done && typeof done.id === "string" && typeof done.botId === "string" && typeof done.title === "string" && typeof done.resolvedAt === "number") this.resolvedOwnerPending.push(done);
      }
      this.resolvedOwnerPending = keepResolved(this.resolvedOwnerPending.map((item) => slimResolved(item, item.resolvedAt, item.resolvedBy, typeof item.resolvedNote === "string" ? item.resolvedNote : undefined)));
      const folded = this.foldEquivalentPending();
      // the counter starts past every "oN" the bot ever had, open, folded or settled (ledgers before it reused them)
      for (const [botId, seq] of Object.entries(raw.ownerPendingSeq ?? {})) if (Number.isFinite(seq)) this.ownerPendingSeq.set(botId, seq);
      for (const item of [...this.ownerPending, ...this.resolvedOwnerPending]) {
        const top = Math.max(0, ...[item.id, ...(item.aliases ?? [])].map(ownerPendingNumber));
        if (top > (this.ownerPendingSeq.get(item.botId) ?? 0)) this.ownerPendingSeq.set(item.botId, top);
      }
      for (const lost of raw.standingLost ?? []) {
        if (lost && typeof lost.threadId === "string" && typeof lost.botId === "string") this.standingLost.set(lost.threadId, lost);
      }
      for (const asked of raw.askPromotions ?? []) {
        if (asked && typeof asked.botId === "string" && typeof asked.threadId === "string" && typeof asked.text === "string" && Number.isFinite(asked.askAt) && Number.isFinite(asked.askedAt)) {
          this.askPromotions.push({ ...asked, reportThreadId: typeof asked.reportThreadId === "string" ? asked.reportThreadId : asked.threadId });
        }
      }
      for (const check of raw.diskPushChecks ?? []) {
        if (check && typeof check.botId === "string" && typeof check.threadId === "string" && typeof check.marker === "string" && Number.isFinite(check.at) && Array.isArray(check.folders)) this.pushChecks.push(check);
      }
      // Turns a restart cut off: what woke them is due again, marked as such.
      const at = this.now();
      let recovered = false;
      for (const lease of raw.inFlight ?? []) {
        if (!lease || typeof lease.threadId !== "string" || typeof lease.botId !== "string" || at - lease.startedAt > IN_FLIGHT_MAX_AGE_MS) continue;
        recovered = true;
        const what = (lease.kind === "wake" ? lease.wake?.reason : lease.items?.join(" / ")) ?? "";
        const stale = at - lease.startedAt > IN_FLIGHT_STALE_MS;
        this.recoveredOnLoad.push({ botId: lease.botId, threadId: lease.threadId, kind: lease.kind, startedAt: lease.startedAt, stale, what: what.slice(0, 200) });
        if (stale) {
          // not re-run: handed over as a question, with what it was about
          const items = [STALE_PREFIX, lease.kind === "wake" ? `Wake-up note: ${lease.wake?.reason ?? "(none)"}` : "", ...(lease.kind === "reports" ? lease.items ?? [] : [])].filter(Boolean);
          const current = this.reports.get(lease.threadId);
          this.reports.set(lease.threadId, { botId: lease.botId, threadId: lease.threadId, items: [...items, ...(current?.items ?? [])] });
          continue;
        }
        if (lease.kind === "wake" && lease.wake && !this.wakes.has(lease.threadId)) {
          this.wakes.set(lease.threadId, { ...lease.wake, dueAt: at, reason: `${INTERRUPTED_PREFIX} ${lease.wake.reason}`.slice(0, WAKE_REASON_MAX + INTERRUPTED_PREFIX.length + 1) });
          continue;
        }
        const items = lease.kind === "reports" && lease.items?.length
          ? lease.items
          : [`Wake-up note: ${lease.wake?.reason ?? "(none)"}`];
        const current = this.reports.get(lease.threadId);
        this.reports.set(lease.threadId, { botId: lease.botId, threadId: lease.threadId, items: [INTERRUPTED_PREFIX, ...items, ...(current?.items ?? [])] });
      }
      // saved once the whole ledger is read: an earlier save would drop what is not loaded yet
      if (recovered || folded) this.save();
    } catch (error) {
      console.error(`[autonomy] ignoring unreadable ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private save(): void {
    if (!this.path) return;
    const ledger: Ledger = { ...(this.promises.length ? { promises: this.promises } : {}), ...(this.ownerPending.length ? { ownerPending: this.ownerPending } : {}), ...(this.resolvedOwnerPending.length ? { resolvedOwnerPending: this.resolvedOwnerPending } : {}), wakes: [...this.wakes.values()], goals: [...this.goals.values()], reports: [...this.reports.values()], inFlight: this.inFlight, standingLost: [...this.standingLost.values()], ...(this.askPromotions.length ? { askPromotions: this.askPromotions } : {}), ...(this.pushChecks.length ? { diskPushChecks: this.pushChecks } : {}), ...(this.ownerPendingSeq.size ? { ownerPendingSeq: Object.fromEntries(this.ownerPendingSeq) } : {}) };
    writeFileAtomic(this.path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  }

  // ── wakes ──────────────────────────────────────────────────────────────

  setWake(botId: string, threadId: string, minutes: number, reason: string): BotWake {
    const at = this.now();
    const wake: BotWake = { botId, threadId, dueAt: at + minutes * this.minuteMs, reason, createdAt: at };
    // the ordinary wake; a standing watch here is kept beside it
    this.wakes.set(threadId, wake);
    this.lastLines.delete(threadId);
    this.save();
    return wake;
  }

  /** A wake that fires early when a watched command's output moves. The
   * first run already happened (its output is the baseline). */
  setWatch(
    botId: string,
    threadId: string,
    input: { command: string; argv: string[]; everyMinutes: number; maxMinutes: number; until?: string; reason: string; baseline: string; baselineFingerprint?: string; standing?: boolean; label?: string; ignore?: string },
  ): BotWake {
    const at = this.now();
    // the same standing watch set again with the same note keeps the note's age
    const before = input.standing ? this.standingFor(threadId, input.label ?? STANDING_DEFAULT_LABEL) : null;
    const sameNote = before?.watch && before.botId === botId && before.reason === input.reason ? before : null;
    const wake: BotWake = {
      botId,
      threadId,
      dueAt: at + input.maxMinutes * this.minuteMs,
      reason: input.reason,
      createdAt: sameNote?.createdAt ?? at,
      watch: {
        command: input.command,
        argv: input.argv,
        everyMs: input.everyMinutes * this.minuteMs,
        ...(input.until ? { until: input.until } : {}),
        ...(input.ignore ? { ignore: input.ignore } : {}),
        baseline: input.baseline,
        ...(input.baselineFingerprint ? { baselineFingerprint: input.baselineFingerprint, lastFingerprint: input.baselineFingerprint } : {}),
        stdoutFingerprint: true,
        lastRunAt: at,
        runs: 1,
        failures: 0,
        changedAt: at,
        // a legacy note of unknown age stays unknown ("more than N"), its createdAt kept (INSP-R12F F9)
        ...(sameNote ? (sameNote.watch?.reasonAt !== undefined ? { reasonAt: sameNote.watch.reasonAt } : {}) : { reasonAt: at }),
        ...(input.standing ? { standing: true as const, maxMs: input.maxMinutes * this.minuteMs, ...(input.label && input.label !== STANDING_DEFAULT_LABEL ? { label: input.label } : {}) } : {}),
      },
    };
    this.wakes.set(wakeKey(wake), wake);
    // a new watch (or one replacing another) starts with no lines of its own
    this.lastLines.delete(wakeKey(wake));
    if (input.standing) this.standingLost.delete(threadId);
    this.save();
    return wake;
  }

  /** How many watches keep the lines of their last run (for tests). */
  keptLineSets(): number {
    return this.lastLines.size;
  }

  /** Watches whose command is due to run again (not yet triggered). */
  watchesToRun(): BotWake[] {
    const at = this.now();
    return [...this.wakes.values()].filter((wake) =>
      wake.watch && !wake.watch.trigger && wake.dueAt > at && at - wake.watch.lastRunAt >= wake.watch.everyMs,
    );
  }

  /** Record one run; the wake becomes due now if the watch triggered. The
   * caller decides changed/matched (it owns the matching rule). */
  recordWatchRun(wake: BotWake, result: { ok: boolean; output: string; matched: boolean; fingerprint?: string; truncated?: boolean; lines?: string[]; linesComplete?: boolean; ownMark?: RegExp }): WatchTrigger | null {
    const watch = wake.watch;
    if (!watch || this.wakes.get(wakeKey(wake)) !== wake || watch.trigger) return null;
    watch.lastRunAt = this.now();
    watch.runs += 1;
    // The whole output of the run before (not lastOutput, cut at 20 000
    // characters): what an echo is judged against. Unknown — after a
    // restart, or a run past WATCH_LINES_MAX — means no echo.
    // after a restart, the run before is read back from its hashes against this run's lines
    const previous = this.lastLines.get(wakeKey(wake)) ?? this.savedRun(wakeKey(wake), result.ok ? result.lines : undefined);
    if (result.ok) this.savedLineHashes.delete(wakeKey(wake));
    if (result.ok && result.lines && result.linesComplete !== false) {
      this.lastLines.set(wakeKey(wake), result.lines);
      // which output these lines are: after a restart they count only for that very output
      if (result.fingerprint) this.lastLinesPrint.set(wakeKey(wake), result.fingerprint);
      else this.lastLinesPrint.delete(wakeKey(wake));
    } else if (result.ok) this.lastLines.delete(wakeKey(wake));
    watch.lastOutput = result.output;
    if (result.ok && result.lines && watchKindOf(watch.argv) === "chat") this.noteChatSeen(wake.botId, result.lines);
    let fresh: string[] = [];
    if (result.ok && result.lines) {
      // what is new since the run before, past the cut the bot reads
      const hashes = result.lines.map(lineHash);
      if (watch.lineHashes) {
        const seen = new Set(watch.lineHashes);
        fresh = result.lines.filter((_, i) => !seen.has(hashes[i]!));
        if (fresh.length) watch.newLines = clipLines(fresh, 8_000);
      }
      watch.lineHashes = hashes.slice(0, 5_000);
      watch.truncated = result.truncated === true;
    }
    if (result.ok && result.fingerprint && result.fingerprint !== watch.lastFingerprint) {
      watch.changedAt = this.now();
      delete watch.staleAlertedAt;
    }
    let trigger: WatchTrigger | null = null;
    if (!result.ok) {
      watch.failures += 1;
      if (watch.failures >= WATCH_MAX_FAILURES) trigger = "failing";
    } else {
      watch.failures = 0;
      if (result.fingerprint && !watch.stdoutFingerprint) {
        // Set before fingerprints covered stdout only: take this run as the
        // baseline instead of firing on the change of method.
        watch.stdoutFingerprint = true;
        watch.baselineFingerprint = result.fingerprint;
        watch.lastFingerprint = result.fingerprint;
      }
      // A standing watch compares with the output it last saw, a one-shot with the one it was set on.
      const reference = watch.standing ? watch.lastFingerprint ?? watch.baselineFingerprint : watch.baselineFingerprint;
      const changed = reference && result.fingerprint ? result.fingerprint !== reference : result.output !== watch.baseline;
      // A standing watch fires on a match only when it is a new output, not on every run while it matches.
      if (result.matched && (!watch.standing || changed)) trigger = "matched";
      else if (!watch.until && changed) trigger = "changed";
      // the change is only the bot's own comment, post or note: take it as
      // the new baseline without waking the bot
      const echo = trigger === "changed" && result.lines
        ? isEcho(fresh, watchKindOf(watch.argv), this.selfWrites.get(wake.botId) ?? [], this.now(), { ...(result.ownMark ? { mark: result.ownMark } : {}), previous: result.linesComplete === false ? null : previous, current: result.lines })
        : null;
      if (echo?.echo) {
        trigger = null;
        watch.echoAt = this.now();
        // said where the bot and the person see it (server.log and a chip)
        watch.echo = { at: this.now(), lines: fresh.length, reasons: [...new Set(echo.reasons)], sample: fresh[0]!.trim().slice(0, 120) };
        watch.baseline = result.output;
        if (result.fingerprint) watch.baselineFingerprint = result.fingerprint;
      }
      if (result.fingerprint) watch.lastFingerprint = result.fingerprint;
    }
    if (trigger) {
      watch.trigger = trigger;
      watch.fired = (watch.fired ?? 0) + 1;
      wake.dueAt = this.now();
      // a one-shot watch is used up by firing: nothing more to compare
      if (!watch.standing) this.lastLines.delete(wakeKey(wake));
    }
    this.save();
    this.saveEcho();
    return trigger;
  }

  /** A write the bot just made to a source its watches may read. */
  noteSelfWrite(botId: string, write: SelfWrite): void {
    const at = this.now();
    const kept = (this.selfWrites.get(botId) ?? []).filter((item) => at - item.at <= ECHO_WINDOW_MS);
    this.selfWrites.set(botId, [...kept, write].slice(-20));
    this.saveEcho();
  }

  // ── the echo memory, across restarts (R10-intake: after the restart of
  // 13:38 the bot's first post woke its watch once — the run before, its
  // own writes and the messages seen were gone). Kept apart from the
  // ledger, bounded: writes of the last ECHO_WINDOW_MS (≤ 20 per bot), the
  // ECHO_SEEN_PERSIST_MAX newest message starts of the last 24 h per bot,
  // and each live watch's last run — taken back only for the very output it
  // came from (its fingerprint), so a watch that ran elsewhere meanwhile is
  // never compared with lines it did not see. No client text goes to disk
  // (INSP-J r1 #12): a run is kept as its lines' hashes and a message start
  // as its hash; the run is read back against the next run's own lines (a
  // line still there is known again; one gone stays a hash, never anyone's).

  private loadEcho(): void {
    if (!this.echoPath || !existsSync(this.echoPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.echoPath, "utf8")) as Partial<EchoMemory>;
      const at = this.now();
      for (const [botId, writes] of Object.entries(raw.selfWrites ?? {})) {
        const kept = (Array.isArray(writes) ? writes : []).filter((write) => write && typeof write.at === "number" && typeof write.kind === "string" && Array.isArray(write.marks) && at - write.at <= ECHO_WINDOW_MS);
        if (kept.length) this.selfWrites.set(botId, kept.slice(-20));
      }
      for (const [botId, starts] of Object.entries(raw.seenChatHashes ?? {})) {
        const seen = new Map<string, number>();
        for (const pair of Array.isArray(starts) ? starts : []) {
          if (Array.isArray(pair) && typeof pair[0] === "string" && /^[0-9a-f]{16}$/.test(pair[0]) && typeof pair[1] === "number" && at - pair[1] <= SEEN_CHAT_MS) seen.set(pair[0], pair[1]);
        }
        if (seen.size) this.seenChatHashes.set(botId, seen);
      }
      for (const [key, saved] of Object.entries(raw.lastLineHashes ?? {})) {
        const wake = this.wakes.get(key);
        if (!wake?.watch || !saved || !Array.isArray(saved.hashes) || typeof saved.fingerprint !== "string") continue;
        if (wake.watch.lastFingerprint !== saved.fingerprint) continue;
        this.savedLineHashes.set(key, { fingerprint: saved.fingerprint, hashes: saved.hashes.filter((hash): hash is string => typeof hash === "string") });
      }
    } catch (error) {
      console.error(`[autonomy] ignoring unreadable ${this.echoPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The run before a restart, read back against this run's lines: each
   * hash that is one of them is that line again; one that is not stays an
   * opaque placeholder (it went away, and isEcho accounts for it as such). */
  private savedRun(key: string, current: readonly string[] | undefined): string[] | null {
    const saved = this.savedLineHashes.get(key);
    if (!saved || !current) return null;
    const byHash = new Map<string, string>();
    for (const line of current) byHash.set(lineHash(line), line);
    const savedSet = new Set(saved.hashes);
    // a line that grew (a note appended to a spreadsheet row): its old self is a prefix of a new line
    const changed = current.filter((line) => !savedSet.has(lineHash(line))).slice(0, 50);
    const grownFrom = (hash: string): string | undefined => {
      for (const line of changed) {
        for (let end = line.length - 1; end > 0; end -= 1) if (lineHash(line.slice(0, end)) === hash) return line.slice(0, end);
      }
      return undefined;
    };
    return saved.hashes.map((hash) => byHash.get(hash) ?? grownFrom(hash) ?? `\u0000gone:${hash}`);
  }

  private saveEcho(): void {
    if (!this.echoPath) return;
    const at = this.now();
    const memory: EchoMemory = { selfWrites: {}, seenChatHashes: {}, lastLineHashes: {} };
    for (const [botId, writes] of this.selfWrites) {
      const kept = writes.filter((write) => at - write.at <= ECHO_WINDOW_MS);
      if (kept.length) memory.selfWrites[botId] = kept.slice(-20);
    }
    for (const botId of new Set([...this.seenChat.keys(), ...this.seenChatHashes.keys()])) {
      const pairs = new Map<string, number>(this.seenChatHashes.get(botId) ?? []);
      for (const [start, when] of this.seenChat.get(botId) ?? []) pairs.set(chatStartHash(start), Math.max(when, pairs.get(chatStartHash(start)) ?? 0));
      const kept = [...pairs].filter(([, when]) => at - when <= SEEN_CHAT_MS).sort((a, b) => a[1] - b[1]).slice(-ECHO_SEEN_PERSIST_MAX);
      if (kept.length) memory.seenChatHashes[botId] = kept;
    }
    for (const [key, lines] of this.lastLines) {
      const fingerprint = this.lastLinesPrint.get(key);
      if (!fingerprint || !this.wakes.has(key) || lines.length > ECHO_LINES_PERSIST_MAX) continue;
      memory.lastLineHashes[key] = { fingerprint, hashes: lines.map(lineHash) };
    }
    // read back but not run again since the restart: still the run before
    for (const [key, saved] of this.savedLineHashes) if (!memory.lastLineHashes[key] && this.wakes.has(key)) memory.lastLineHashes[key] = saved;
    try {
      writeFileAtomic(this.echoPath, `${JSON.stringify(memory)}\n`, { mode: 0o600 });
    } catch (error) {
      console.error(`[autonomy] could not save ${this.echoPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The start of every message a bot's Chat watches showed (40 characters,
   * @mentions aside): a text pasted later that starts the same is a copy,
   * not a post, even once the message scrolled out of the list. Kept 24 h,
   * at most SEEN_CHAT_MAX per bot, in memory. */
  private noteChatSeen(botId: string, lines: readonly string[]): void {
    const at = this.now();
    const seen = this.seenChat.get(botId) ?? new Map<string, number>();
    for (const text of chatTexts(lines)) {
      const start = normalize(withoutLeadingMentions(text)).slice(0, 40);
      if (!start) continue;
      seen.delete(start);
      seen.set(start, at);
    }
    for (const [start, when] of seen) if (at - when > SEEN_CHAT_MS) seen.delete(start);
    while (seen.size > SEEN_CHAT_MAX) seen.delete(seen.keys().next().value!);
    this.seenChat.set(botId, seen);
  }

  /** How many message starts a bot keeps as seen (for tests). */
  seenChatCount(botId: string): number {
    const hashes = new Set(this.seenChatHashes.get(botId)?.keys() ?? []);
    for (const start of this.seenChat.get(botId)?.keys() ?? []) hashes.add(chatStartHash(start));
    return hashes.size;
  }

  /** Text the bot put on the VM's clipboard: kept as its Chat post only when
   * it is one (server/watch-echo.ts vmChatPostOf), checked against what its
   * Chat watches last showed. True when kept. */
  noteVmClipboard(botId: string, text: string, mark?: RegExp): boolean {
    // a note for the spreadsheet: it starts with the bot's own mark
    const note = mark ? vmSheetNoteOf(text, this.now(), mark) : null;
    if (note) {
      this.noteSelfWrite(botId, note);
      return true;
    }
    // a Chat post: only when every Chat watch of the bot has its last output
    // to tell it from a copied message (none after a restart: in doubt, not kept)
    const chatWatches = [...this.wakes.entries()].filter(([, wake]) => wake.botId === botId && wake.watch && watchKindOf(wake.watch.argv) === "chat");
    // (or, right after a restart, its run kept as hashes: the messages it showed are among the starts seen)
    if (!chatWatches.length || chatWatches.some(([key]) => !this.lastLines.has(key) && !this.savedLineHashes.has(key))) return false;
    // what its Chat watches show now, and every message they showed in the last 24 h (as text, or as hashes from before a restart)
    const shown = [...chatWatches.flatMap(([key]) => chatTexts(this.lastLines.get(key) ?? [])), ...(this.seenChat.get(botId)?.keys() ?? [])];
    const write = vmChatPostOf(text, this.now(), shown, this.seenChatHashes.get(botId));
    if (write) this.noteSelfWrite(botId, write);
    return write !== null;
  }

  /** Standing watches whose output has not changed for `afterMs` and whose
   * newest time stamp is older than `oldMs`: likely looking at the wrong
   * page (gog's oldest-first list). Each is returned once until it changes. */
  staleWatches(afterMs = 3 * 3_600_000, oldMs = 24 * 3_600_000): BotWake[] {
    const at = this.now();
    return [...this.wakes.values()].filter((wake) => {
      const watch = wake.watch;
      if (!watch?.standing || watch.staleAlertedAt !== undefined || watch.failures > 0) return false;
      if (at - (watch.changedAt ?? wake.createdAt) < afterMs) return false;
      const newest = newestStamp(watch.lastOutput ?? watch.baseline);
      return newest !== null && at - newest > oldMs;
    });
  }

  markWatchStaleAlerted(wake: BotWake): void {
    if (!wake.watch) return;
    wake.watch.staleAlertedAt = this.now();
    this.save();
  }

  /** Other watches of this bot, in other conversations, running the same command. */
  sameWatchElsewhere(botId: string, threadId: string, command: string): BotWake[] {
    const norm = (text: string) => text.trim().replace(/\s+/g, " ");
    return [...this.wakes.values()].filter((wake) => wake.botId === botId && wake.threadId !== threadId && wake.watch && norm(wake.watch.command) === norm(command));
  }

  /** A standing watch fired (its turn started, or could not): arm it again on
   * the output it fired on, with a fresh time limit. */
  rearmStanding(wake: BotWake): BotWake | null {
    const watch = wake.watch;
    if (!watch?.standing || this.wakes.get(wakeKey(wake)) !== wake) return null;
    const at = this.now();
    if (watch.lastOutput !== undefined && watch.failures === 0) watch.baseline = watch.lastOutput;
    if (watch.lastFingerprint) watch.baselineFingerprint = watch.lastFingerprint;
    if (watch.trigger) watch.lastTrigger = watch.trigger;
    else delete watch.lastTrigger;
    delete watch.trigger;
    watch.failures = 0;
    // createdAt and reasonAt stay: the note is as old as when it was written,
    // not as the last re-arm (R11-followup #2 — 'prod' read 1 h old after 4 days)
    wake.dueAt = at + (watch.maxMs ?? WATCH_DEFAULT_MAX_MINUTES * this.minuteMs);
    this.save();
    return wake;
  }

  /** Every standing watch, of every conversation. */
  standingWatches(): BotWake[] {
    return [...this.wakes.values()].filter((wake) => wake.watch?.standing);
  }

  /** Its `ignore` was pointed out (once). */
  markIgnoreWarned(wake: BotWake): void {
    if (!wake.watch) return;
    wake.watch.ignoreWarnedAt = this.now();
    this.save();
  }

  /** A new note for a standing watch, keeping its baseline and schedule. */
  updateStandingReason(threadId: string, label: string, reason: string): BotWake | null {
    const wake = this.standingFor(threadId, label);
    if (!wake?.watch) return null;
    wake.reason = reason.slice(0, WAKE_REASON_MAX);
    wake.watch.reasonAt = this.now();
    this.save();
    return wake;
  }

  /** Is this still the wake kept for its conversation (not replaced or cancelled)? */
  isCurrent(wake: BotWake): boolean {
    return this.wakes.get(wakeKey(wake)) === wake;
  }

  standingFor(threadId: string, label = STANDING_DEFAULT_LABEL): BotWake | null {
    return this.wakes.get(standingKey(threadId, label)) ?? null;
  }

  /** Every watch (standing or not) of a conversation. */
  watchesFor(threadId: string): BotWake[] {
    return [...this.wakes.values()].filter((wake) => wake.threadId === threadId && wake.watch);
  }

  standingsFor(threadId: string): BotWake[] {
    return [...this.wakes.values()].filter((wake) => wake.threadId === threadId && wake.watch?.standing);
  }

  cancelStanding(threadId: string, label = STANDING_DEFAULT_LABEL): BotWake | null {
    const wake = this.wakes.get(standingKey(threadId, label)) ?? null;
    if (wake) {
      this.wakes.delete(standingKey(threadId, label));
      this.lastLines.delete(standingKey(threadId, label));
      if (!this.standingsFor(threadId).length) this.standingLost.set(threadId, { botId: wake.botId, threadId, at: this.now() });
      this.save();
    }
    return wake;
  }

  /** Conversations that had a standing watch and have had no watch at all
   * (standing or one-shot) for `afterMs`, not yet alerted. A one-shot watch
   * keeps it watched while it lasts; the clock restarts when it is gone. */
  standingLostDue(afterMs = STANDING_LOST_ALERT_MS): StandingLost[] {
    const at = this.now();
    return [...this.standingLost.values()].filter((lost) => {
      if (this.watchesFor(lost.threadId).length) {
        lost.at = at;
        return false;
      }
      return !lost.alerted && at - lost.at >= afterMs;
    });
  }

  markStandingLostAlerted(threadId: string): void {
    const lost = this.standingLost.get(threadId);
    if (!lost) return;
    lost.alerted = true;
    this.save();
  }

  /** It had a standing watch, has none now, and that has lasted. */
  isStandingLost(threadId: string, afterMs = STANDING_LOST_ALERT_MS): boolean {
    const lost = this.standingLost.get(threadId);
    return Boolean(lost && !this.watchesFor(threadId).length && this.now() - lost.at >= afterMs);
  }

  // ── promises ───────────────────────────────────────────────────────────

  addPromise(botId: string, threadId: string, text: string, minutes: number): BotPromise {
    const at = this.now();
    const used = new Set(this.promises.map((promise) => promise.id));
    let n = this.promises.length + 1;
    while (used.has(`p${n}`)) n += 1;
    const promise: BotPromise = { id: `p${n}`, botId, threadId, text, dueAt: at + minutes * this.minuteMs, createdAt: at };
    this.promises = [...this.promises.filter((open) => open.threadId !== threadId || open.text !== text), promise];
    const mine = this.promises.filter((open) => open.threadId === threadId);
    if (mine.length > PROMISES_MAX_PER_THREAD) this.promises = this.promises.filter((open) => open !== mine[0]);
    this.save();
    return promise;
  }

  /** Marks kept (removes) one promise of this conversation by id, or all with "all". */
  keepPromise(threadId: string, id: string): BotPromise[] {
    const kept = this.promises.filter((promise) => promise.threadId === threadId && (id === "all" || promise.id === id));
    if (!kept.length) return [];
    this.promises = this.promises.filter((promise) => !kept.includes(promise));
    this.save();
    return kept;
  }

  promisesFor(threadId: string): BotPromise[] {
    return this.promises.filter((promise) => promise.threadId === threadId);
  }

  // ── what waits on the person ───────────────────────────────────────────

  /** Add (or refresh, same key or title in the conversation) one item. An
   * equivalent item of the same bot in ANY conversation (sameOwnerPending)
   * is that one: a server item with the same key is refreshed where it is;
   * for anything else the existing item comes back untouched, flagged
   * `duplicate`, so the bot is told "já existe o5" instead of the person
   * getting a second item for the same action. */
  addOwnerPending(botId: string, threadId: string, input: { title: string; due?: string; link?: string; key?: string; command?: string; why?: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[]; lastSaidAt?: number; routineId?: string; diskKept?: string[] }): OwnerPending & { duplicate?: true } {
    const title = input.title.replace(/\s+/g, " ").trim().slice(0, OWNER_PENDING_TITLE_MAX);
    const here = (open: OwnerPending) => open.threadId === threadId && (input.key ? open.key === input.key : open.title === title);
    const elsewhere = this.ownerPending.find((open) => open.botId === botId && !here(open) && sameOwnerPending(open, { ...input, title }));
    // a bot's second ask is that one; a server item takes the equivalent one
    // over (its key, so the server can close it; its title, the exact remedy)
    if (elsewhere && !input.key) return { ...elsewhere, duplicate: true };
    const same = (open: OwnerPending) => here(open) || open === elsewhere;
    const existing = this.ownerPending.find(same);
    // an id still answered as an alias is taken: "resolve o8" must never close two items (INSP-H r1 #3)
    const pending: OwnerPending = {
      id: existing?.id ?? this.nextOwnerPendingId(botId), botId, threadId, title, createdAt: existing?.createdAt ?? this.now(),
      ...(input.due?.trim() ? { due: input.due.trim().slice(0, 80) } : existing?.due ? { due: existing.due } : {}),
      ...(input.link?.trim() ? { link: input.link.trim().slice(0, 500) } : existing?.link ? { link: existing.link } : {}),
      ...(input.command?.trim() ? { command: input.command.trim().slice(0, 500) } : existing?.command ? { command: existing.command } : {}),
      ...(input.key ? { key: input.key } : {}),
      ...(existing?.aliases?.length ? { aliases: existing.aliases } : {}),
      // the practical part: what the bot sent now, else what the item had
      ...(input.why?.trim() ? { why: input.why.trim() } : existing?.why ? { why: existing.why } : {}),
      ...(input.steps?.length ? { steps: input.steps } : existing?.steps?.length ? { steps: existing.steps } : {}),
      ...(input.options?.length ? { options: input.options } : existing?.options?.length ? { options: existing.options } : {}),
      // what the person answered stays with the item when the server refreshes it (J18)
      ...(existing?.history?.length ? { history: existing.history } : {}),
      ...(existing?.awaitingSince ? { awaitingSince: existing.awaitingSince } : {}),
      ...(existing?.stepsAutoAskedAt ? { stepsAutoAskedAt: existing.stepsAutoAskedAt } : {}),
      // a delegation running (or just back) stays with the item when the bot or the server says it again (lote del)
      ...(existing?.delegation ? { delegation: existing.delegation } : {}),
      ...(existing?.delegationBack ? { delegationBack: existing.delegationBack } : {}),
      // said again with the same commands: still superseded (R13-intake #1); new commands are the bot's new answer
      ...(existing?.supersededBy && sameCommands(existing, input) ? { supersededBy: existing.supersededBy } : {}),
      ...(existing?.rowChecks && sameCommands(existing, input) ? { rowChecks: existing.rowChecks } : {}),
      ...(input.lastSaidAt !== undefined ? { lastSaidAt: input.lastSaidAt } : existing?.lastSaidAt !== undefined ? { lastSaidAt: existing.lastSaidAt } : {}),
      ...(input.routineId ? { routineId: input.routineId } : existing?.routineId ? { routineId: existing.routineId } : {}),
      // a disk item's folders kept out, as a list (INSP-R13fol #8)
      ...(input.diskKept?.length ? { diskKept: input.diskKept } : {}),
    };
    // a server item (same key) found in another conversation follows the server to where it says it now
    this.ownerPending = [...this.ownerPending.filter((open) => !same(open)), pending];
    // the cap holds a bot's own items; the server's (a routine's ask, the disk, the app) are never
    // dropped by it: that would close what waits on the owner without a word (INSP-N22 A7)
    const mine = this.ownerPending.filter((open) => open.threadId === threadId && !open.key);
    if (mine.length > OWNER_PENDING_MAX_PER_THREAD) {
      console.warn(`[owner-pending] ${mine[0]!.id} ("${mine[0]!.title.slice(0, 80)}") left the list: more than ${OWNER_PENDING_MAX_PER_THREAD} items of the bot in ${threadId}`);
      this.ownerPending = this.ownerPending.filter((open) => open !== mine[0]);
    }
    this.save();
    return pending;
  }

  /** The bot's next "oN": past its last one (persisted), so a settled "o3"
   * is never a new item's id (R12-followup #3: the Chief had 13 "o3"); and
   * never an id still open or answered as an alias (INSP-H r1 #3). */
  private nextOwnerPendingId(botId: string): string {
    const used = new Set(this.ownerPending.flatMap((open) => [open.id, ...(open.aliases ?? [])]));
    let n = (this.ownerPendingSeq.get(botId) ?? 0) + 1;
    while (used.has(`o${n}`)) n += 1;
    this.ownerPendingSeq.set(botId, n);
    return `o${n}`;
  }

  /** Items saved before the dedupe (or by two conversations at once) that ask
   * for the same thing become one: the oldest stays, with the others' ids as
   * aliases (a bot resolving "o7" resolves it) and a link one of them had.
   * True when any was folded (the caller saves). */
  private foldEquivalentPending(): boolean {
    const kept: OwnerPending[] = [];
    let folded = false;
    for (const item of [...this.ownerPending].sort((a, b) => a.createdAt - b.createdAt)) {
      const into = kept.find((open) => open.botId === item.botId && sameOwnerPending(open, item));
      if (!into) {
        kept.push(item);
        continue;
      }
      into.aliases = [...new Set([...(into.aliases ?? []), item.id, ...(item.aliases ?? [])])];
      if (!into.link && item.link) into.link = item.link;
      // and the practical part one of them had (why, steps, options)
      if (!into.why && item.why) into.why = item.why;
      if (!into.steps?.length && item.steps?.length) into.steps = item.steps;
      if (!into.options?.length && item.options?.length) into.options = item.options;
      // and what the person answered on either, in time order (INSP-J2 #13)
      if (item.history?.length) into.history = [...(into.history ?? []), ...item.history].sort((a, b) => a.at - b.at).slice(-OWNER_PENDING_HISTORY_MAX);
      if (item.awaitingSince && (!into.awaitingSince || item.awaitingSince > into.awaitingSince)) into.awaitingSince = item.awaitingSince;
      // a server item's key (and its exact remedy) survives: else the server could never close it (INSP-H r1 #3)
      if (!into.key && item.key) {
        into.key = item.key;
        into.title = item.title;
      }
      folded = true;
      console.log(`[owner-pending] ${item.id} ("${item.title.slice(0, 80)}") is the same as ${into.id} ("${into.title.slice(0, 80)}"): folded into it`);
    }
    if (folded) this.ownerPending = this.ownerPending.filter((item) => kept.includes(item));
    return folded;
  }

  /** Resolve one item of a bot by id, all of a conversation with "all", or a server item by key. */
  resolveOwnerPending(match: { botId?: string; threadId?: string; id?: string; key?: string; by?: ResolvedOwnerPending["resolvedBy"]; note?: string }): OwnerPending[] {
    const done = this.ownerPending.filter((open) =>
      (match.botId === undefined || open.botId === match.botId)
      && (match.key !== undefined ? open.key === match.key
        : match.id === "all" ? open.threadId === match.threadId
          : open.id === match.id || Boolean(match.id && open.aliases?.includes(match.id))));
    if (!done.length) return [];
    this.ownerPending = this.ownerPending.filter((open) => !done.includes(open));
    // kept for audit, with what the person answered (J18)
    const at = this.now();
    this.resolvedOwnerPending = keepResolved([...this.resolvedOwnerPending, ...done.map((item) => slimResolved(item, at, match.by ?? "server", match.note))]);
    this.save();
    return done;
  }

  /** Settled items, newest last (audit). */
  resolvedOwnerPendingOf(botId?: string): ResolvedOwnerPending[] {
    return this.resolvedOwnerPending.filter((item) => botId === undefined || item.botId === botId);
  }

  /** The person answered `id` (J18): kept in its history; when it reached
   * the bot, the item waits on the bot until it updates or resolves it. */
  recordOwnerPendingAnswer(botId: string, id: string, answer: Omit<OwnerPendingAnswer, "at" | "by">): OwnerPending | null {
    const item = this.ownerPendingById(botId, id);
    if (!item) return null;
    const at = this.now();
    const entry: OwnerPendingAnswer = { at, by: "owner", ...answer, text: answer.text.slice(0, 500), ...(answer.error ? { error: answer.error.slice(0, 300) } : {}) };
    item.history = [...(item.history ?? []), entry].slice(-OWNER_PENDING_HISTORY_MAX);
    // answered (sent or waiting its turn): the item waits on the bot
    if (answer.delivered || answer.queued) item.awaitingSince = at;
    this.save();
    return item;
  }

  /** Answers that were waiting their turn now reached the bot, or did not
   * (INSP-J2 r2 N9): "na fila" becomes "enviado" when the turn starts with
   * them, "não enviado" when it could not start. The bots touched. */
  settleOwnerPendingQueued(match: (item: OwnerPending, entry: OwnerPendingAnswer) => boolean, outcome: { delivered: true } | { error: string }): string[] {
    const touched = new Set<string>();
    // a decision that closed its item may still be waiting its turn: the audit keeps its outcome too
    for (const item of [...this.ownerPending, ...this.resolvedOwnerPending]) {
      if (!item.history?.some((entry) => entry.queued && match(item, entry))) continue;
      // the answer that put the item in wait is the last one sent or queued
      const last = item.history.findLast((entry) => entry.delivered || entry.queued);
      let settledLast = false;
      item.history = item.history.map((entry) => {
        if (!entry.queued || !match(item, entry)) return entry;
        if (entry === last) settledLast = true;
        const { queued: _queued, queueId: _queueId, ...rest } = entry;
        return "error" in outcome ? { ...rest, delivered: false, error: outcome.error.slice(0, 300) } : { ...rest, delivered: true };
      });
      if (settledLast) {
        // INSP-J2 r3 R2: the bot's 2 h count from delivery, not from the queue; an
        // answer that never arrived gives the item back to the person, with why
        if ("error" in outcome) {
          const earlier = item.history.findLast((entry) => entry.delivered || entry.queued);
          if (earlier?.queued) item.awaitingSince = earlier.at;
          else delete item.awaitingSince;
        } else item.awaitingSince = this.now();
      }
      touched.add(item.botId);
    }
    if (touched.size) this.save();
    return [...touched];
  }

  /** The person reminds the bot of an answered item it let go silent
   * (INSP-J2 r2 N3): one system report, never twice while one waits to be
   * read; the item waits on the bot again. null when it is not silent. */
  remindOwnerPending(botId: string, id: string, threadId: string): { item: OwnerPending; deduped: boolean } | "queued" | null {
    const item = this.ownerPendingById(botId, id);
    if (!item || item.awaitingSince === undefined) return null;
    const waiting = this.reports.get(threadId)?.items.some((text) => text.startsWith(`${REMIND_REPORT_PREFIX} ${item.id} `)) ?? false;
    if (waiting) return { item, deduped: true };
    // the person's answer still waits its turn: the bot has not had it yet, and a
    // reminder would not pass it in the queue — said so (INSP-J2 r3 R2, r4 A4)
    if (item.history?.findLast((entry) => entry.delivered || entry.queued)?.queued) return "queued";
    const now = this.now();
    if (now - item.awaitingSince < OWNER_PENDING_AWAIT_MS) return null;
    this.addReport(botId, threadId, ownerPendingRemindReport(item, now));
    this.recordOwnerPendingAnswer(botId, item.id, { kind: "ask", label: "remind", text: "Lembrete enviado pelo OpenMausBot.", delivered: false, queued: true });
    return { item, deduped: false };
  }

  /** One of a bot's items, by id or by an id folded into it. */
  ownerPendingById(botId: string, id: string): OwnerPending | null {
    return this.ownerPending.find((open) => open.botId === botId && (open.id === id || Boolean(open.aliases?.includes(id)))) ?? null;
  }

  /** The bot rewrites one of its items (owner_pending update): the fields it
   * sends replace the item's, an empty list clears steps or options, and a
   * pending "pedir passo a passo" is answered. The item keeps its id, place
   * and age — it is the same ask, said better. null when it is not the bot's. */
  updateOwnerPending(botId: string, id: string, patch: { title?: string; due?: string; link?: string; why?: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[] }): OwnerPending | null {
    const item = this.ownerPendingById(botId, id);
    if (!item) return null;
    const title = patch.title === undefined ? "" : oneLine(patch.title).slice(0, OWNER_PENDING_TITLE_MAX);
    const next: OwnerPending = { ...item, ...(title ? { title } : {}), updatedAt: this.now() };
    const text = (field: "due" | "link" | "why", value: string | undefined, max: number) => {
      if (value === undefined) return;
      const clean = oneLine(value).slice(0, max);
      if (clean) next[field] = clean;
      else delete next[field];
    };
    text("due", patch.due, 80);
    text("link", patch.link, 500);
    text("why", patch.why, OWNER_PENDING_WHY_MAX);
    if (patch.steps !== undefined) {
      if (patch.steps.length) next.steps = patch.steps;
      else delete next.steps;
    }
    if (patch.options !== undefined) {
      if (patch.options.length) next.options = patch.options;
      else delete next.options;
    }
    delete next.stepsRequestedAt;
    // its own bot rewrote the commands or the decisions: no longer the superseded ones, nor the row it read (R13-intake #1)
    if (!sameCommands(item, { ...(patch.steps !== undefined ? { steps: patch.steps } : {}), ...(patch.options !== undefined ? { options: patch.options } : {}) })) {
      delete next.supersededBy;
      delete next.rowChecks;
    }
    // the bot answered the person by rewriting the item: no longer waiting on it (J18)
    delete next.awaitingSince;
    if (patch.options !== undefined) delete next.recommendRequestedAt;
    this.ownerPending = this.ownerPending.map((open) => (open === item ? next : open));
    this.save();
    return next;
  }

  /** The person asked the bot to rewrite an item with steps: shown on the
   * item ("pedido há 2 min") until the bot updates it. */
  /** A routine's item, set in place (server/routine-owner-ask.ts): its why, options and where it stands
   * ("Talvez já resolvido"). An undefined value clears the field. */
  patchOwnerPending(botId: string, id: string, patch: Partial<Pick<OwnerPending, "why" | "options" | "quietRuns" | "demotedAt" | "keptAt" | "lastSaidAt" | "routineId" | "delegation" | "delegationBack" | "supersededBy" | "rowChecks" | "diskMoved">>): OwnerPending | null {
    const item = this.ownerPendingById(botId, id);
    if (!item) return null;
    for (const [field, value] of Object.entries(patch) as Array<[keyof typeof patch, unknown]>) {
      if (value === undefined) delete item[field];
      else (item as unknown as Record<string, unknown>)[field] = value;
    }
    this.save();
    return item;
  }

  markOwnerPendingStepsRequested(botId: string, id: string): OwnerPending | null {
    const item = this.ownerPendingById(botId, id);
    if (!item) return null;
    item.stepsRequestedAt = this.now();
    this.save();
    return item;
  }

  /** Older items still without steps that the server has not asked about
   * yet (J17): asked once each, oldest first. */
  ownerPendingNeedingSteps(): OwnerPending[] {
    // a bot's own items only: the server completes its keyed ones itself (INSP-J2 #5)
    return this.ownerPending.filter((item) => !item.key && missingParts(item).length > 0 && item.stepsAutoAskedAt === undefined).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The request for a bot's question (lot J2): this very ask, by its exact
   * moment — a new question with the same words is a new one (INSP-J2b #2). */
  askPromotionFor(botId: string, threadId: string, askAt: number): AskPromotion | null {
    return this.askPromotions.find((each) => each.botId === botId && each.threadId === threadId && each.askAt === askAt) ?? null;
  }

  /** Every request made, for the server's settling pass. */
  allAskPromotions(): readonly AskPromotion[] {
    return this.askPromotions;
  }

  /** The person answered the question in its conversation: settled once. */
  markAskAnswered(promotion: AskPromotion): void {
    promotion.answeredAt = this.now();
    this.save();
  }

  /** The bot answered the request with owner_pending add replacesAsk: this item takes the question's place. */
  linkAskPromotion(promotion: AskPromotion, item: Pick<OwnerPending, "id" | "threadId" | "createdAt">): void {
    promotion.itemId = item.id;
    promotion.itemThreadId = item.threadId;
    promotion.itemCreatedAt = item.createdAt;
    this.save();
  }

  /** "Push e remover" answered: the commits to look for on the remote, kept across a restart (INSP-R13fol R2-4). */
  addDiskPushCheck(check: DiskPushCheck): void {
    this.pushChecks.push(check);
    this.save();
  }

  diskPushChecksOf(botId: string): DiskPushCheck[] {
    return this.pushChecks.filter((each) => each.botId === botId);
  }

  dropDiskPushCheck(check: DiskPushCheck): void {
    this.pushChecks = this.pushChecks.filter((each) => each !== check);
    this.save();
  }

  /** The server asked the bot to register its question (again, when the person asked). */
  noteAskPromotion(input: Omit<AskPromotion, "askedAt" | "itemId">): AskPromotion {
    const current = this.askPromotionFor(input.botId, input.threadId, input.askAt);
    const asked: AskPromotion = { ...input, askedAt: this.now() };
    this.askPromotions = [...this.askPromotions.filter((each) => each !== current), asked].slice(-ASK_PROMOTIONS_MAX);
    this.save();
    return asked;
  }

  /** A request that never reached the bot (~/.nuria/stop): the question may be asked again later. */
  dropAskPromotion(botId: string, threadId: string, askAt: number): void {
    const before = this.askPromotions.length;
    this.askPromotions = this.askPromotions.filter((each) => !(each.botId === botId && each.threadId === threadId && each.askAt === askAt && !each.itemId));
    if (this.askPromotions.length !== before) this.save();
  }

  /** The item the bot linked to the question (replacesAsk), open or already
   * settled; null while none is — nothing else ever replaces it (INSP-J2b #1). */
  askPromotionItem(promotion: AskPromotion): OwnerPending | null {
    if (!promotion.itemId) return null;
    return this.askPromotionOpenItem(promotion)
      ?? this.askPromotionResolvedItem(promotion)
      // settled and aged out of the audit trail: this very question was answered all the same
      ?? { id: promotion.itemId, botId: promotion.botId, threadId: promotion.reportThreadId, title: promotion.text, createdAt: promotion.askedAt };
  }

  /** The open item linked to the question, if any (the one to settle when the person answers in the conversation). */
  askPromotionOpenItem(promotion: AskPromotion): OwnerPending | null {
    const id = promotion.itemId;
    if (!id) return null;
    return this.ownerPending.find((item) => item.botId === promotion.botId && (
      // by its conversation and birth too, when the link knows them: an item that merely took the id is not it
      (item.id === id && (promotion.itemCreatedAt === undefined || (item.createdAt === promotion.itemCreatedAt && item.threadId === promotion.itemThreadId)))
      // folded into an older equivalent item: that one answers for it
      || Boolean(item.aliases?.includes(id)))) ?? null;
  }

  /** The settled item linked to the question, if it is still in the audit
   * trail: by bot, id, conversation and birth. A link saved before those
   * were kept takes, among the bot's settled items with that id, the one born
   * nearest the server's request — the item was opened in answer to it. */
  askPromotionResolvedItem(promotion: AskPromotion): ResolvedOwnerPending | null {
    const id = promotion.itemId;
    if (!id) return null;
    const same = this.resolvedOwnerPending.filter((item) => item.botId === promotion.botId && item.id === id);
    if (promotion.itemCreatedAt !== undefined) return same.find((item) => item.createdAt === promotion.itemCreatedAt && item.threadId === promotion.itemThreadId) ?? null;
    const distance = (item: ResolvedOwnerPending) => Math.abs(item.createdAt - promotion.askedAt);
    return same.reduce<ResolvedOwnerPending | null>((best, item) => (!best || distance(item) < distance(best) ? item : best), null);
  }

  /** The server's own items (keyed) still without why or steps — saved by an older build. */
  serverItemsIncomplete(): OwnerPending[] {
    return this.ownerPending.filter((item) => item.key && missingParts(item).length > 0);
  }

  /** Steps reports for `ids` were dropped before reaching the bot (~/.nuria/stop): they may be asked again later. */
  unmarkOwnerPendingStepsAutoAsked(botId: string, ids: readonly string[]): void {
    let changed = false;
    for (const item of this.ownerPending) {
      if (item.botId !== botId || !ids.includes(item.id) || item.stepsAutoAskedAt === undefined) continue;
      delete item.stepsAutoAskedAt;
      if (item.stepsRequestedAt !== undefined) delete item.stepsRequestedAt;
      changed = true;
    }
    if (changed) this.save();
  }

  /** Takes out of a conversation's waiting reports those matching `drop`; returns them. */
  dropReports(threadId: string, drop: (text: string) => boolean): string[] {
    const pending = this.reports.get(threadId);
    if (!pending) return [];
    const gone = pending.items.filter(drop);
    if (!gone.length) return [];
    pending.items = pending.items.filter((text) => !drop(text));
    if (!pending.items.length) this.reports.delete(threadId);
    this.save();
    return gone;
  }

  /** The server asked the bot for `id`'s steps: the screen shows it asked, and it is never asked again by the server. */
  markOwnerPendingStepsAutoAsked(botId: string, id: string): OwnerPending | null {
    const item = this.ownerPendingById(botId, id);
    if (!item) return null;
    item.stepsAutoAskedAt = this.now();
    item.stepsRequestedAt = item.stepsAutoAskedAt;
    this.save();
    return item;
  }

  markOwnerPendingRecommendRequested(botId: string, id: string): OwnerPending | null {
    const item = this.ownerPendingById(botId, id);
    if (!item) return null;
    item.recommendRequestedAt = this.now();
    this.save();
    return item;
  }

  ownerPendingFor(threadId: string): OwnerPending[] {
    return this.ownerPending.filter((open) => open.threadId === threadId);
  }

  ownerPendingOf(botId: string): OwnerPending[] {
    return this.ownerPending.filter((open) => open.botId === botId);
  }

  /** Every open item, all bots (the productivity report's snapshot, lot V). */
  allOwnerPending(): OwnerPending[] {
    return [...this.ownerPending];
  }

  /** Past their time, not kept, not yet reported. */
  overduePromises(): BotPromise[] {
    const at = this.now();
    return this.promises.filter((promise) => promise.overdueAt === undefined && promise.dueAt <= at);
  }

  markPromiseOverdue(id: string): void {
    const promise = this.promises.find((open) => open.id === id);
    if (!promise) return;
    promise.overdueAt = this.now();
    this.save();
  }


  /** Put back a wake that was taken but could not start (the thread got
   * busy in between); it stays due and keeps its original note and time. */
  restoreWake(wake: BotWake): void {
    this.inFlight = this.inFlight.filter((lease) => lease.wake !== wake);
    if (!this.wakes.has(wakeKey(wake))) this.wakes.set(wakeKey(wake), wake);
    this.save();
  }

  /** Take a due wake for a turn; it stays on disk until settleInFlight. A
   * standing watch is not taken at all (it re-arms instead). */
  leaseWake(wake: BotWake): void {
    if (wake.watch?.standing) return;
    if (this.wakes.get(wake.threadId) === wake) this.wakes.delete(wake.threadId);
    // a one-shot watch handed to its turn (fired, or out of time): its lines go
    if (wake.watch) this.lastLines.delete(wake.threadId);
    this.inFlight.push({ kind: "wake", botId: wake.botId, threadId: wake.threadId, startedAt: this.now(), wake });
    this.save();
  }

  /** A turn a lease was handed to failed to start after it was dispatched
   * (the VM, docker or the engine gave up; no turn.completed will come).
   * The wake or reports go back, due after a wait that doubles with each
   * failure (1 min … DISPATCH_RETRY_MAX_MINUTES). Returns what went back. */
  returnFailedDispatch(threadId: string, reason: string): Array<{ kind: InFlight["kind"]; failures: number; delayMs: number }> {
    const leases = this.inFlight.filter((lease) => lease.threadId === threadId);
    if (!leases.length) return [];
    this.inFlight = this.inFlight.filter((lease) => lease.threadId !== threadId);
    const at = this.now();
    const delay = (failures: number) => Math.min(this.minuteMs * 2 ** (failures - 1), DISPATCH_RETRY_MAX_MINUTES * this.minuteMs);
    const note = `[O turno anterior não começou (${reason.slice(0, 160)}); tentando de novo.]`;
    const back: Array<{ kind: InFlight["kind"]; failures: number; delayMs: number }> = [];
    for (const lease of leases) {
      if (lease.kind === "wake" && lease.wake) {
        if (this.wakes.has(threadId)) continue; // a newer wake replaced it
        const failures = (lease.wake.dispatchFailures ?? 0) + 1;
        const reasonText = lease.wake.reason.startsWith("[O turno anterior não começou") ? lease.wake.reason.replace(/^\[O turno anterior não começou[^\]]*\] /, "") : lease.wake.reason;
        this.wakes.set(threadId, { ...lease.wake, dueAt: at + delay(failures), dispatchFailures: failures, reason: `${note} ${reasonText}`.slice(0, WAKE_REASON_MAX + 200) });
        back.push({ kind: "wake", failures, delayMs: delay(failures) });
      } else if (lease.kind === "reports" && lease.items?.length) {
        const current = this.reports.get(threadId);
        const failures = (current?.dispatchFailures ?? 0) + 1;
        this.reports.set(threadId, { botId: lease.botId, threadId, items: [...lease.items, ...(current?.items ?? [])], notBefore: at + delay(failures), dispatchFailures: failures });
        back.push({ kind: "reports", failures, delayMs: delay(failures) });
      }
    }
    this.save();
    return back;
  }

  /** The turn a lease was handed to finished (well or not): forget it. */
  settleInFlight(threadId: string): void {
    const before = this.inFlight.length;
    this.inFlight = this.inFlight.filter((lease) => lease.threadId !== threadId);
    this.standingLost.delete(threadId);
    if (this.inFlight.length !== before) this.save();
  }

  inFlightFor(threadId: string): InFlight[] {
    return this.inFlight.filter((lease) => lease.threadId === threadId);
  }

  wakeFor(threadId: string): BotWake | null {
    return this.wakes.get(threadId) ?? null;
  }

  cancelWake(threadId: string): BotWake | null {
    const wake = this.wakes.get(threadId) ?? null;
    if (wake) {
      this.wakes.delete(threadId);
      this.lastLines.delete(threadId);
      this.save();
    }
    return wake;
  }

  dueWakes(): BotWake[] {
    const at = this.now();
    return [...this.wakes.values()].filter((wake) => wake.dueAt <= at).sort((a, b) => a.dueAt - b.dueAt);
  }

  // ── reports ────────────────────────────────────────────────────────────

  addReport(botId: string, threadId: string, text: string): void {
    const pending = this.reports.get(threadId) ?? { botId, threadId, items: [] };
    // the same report still waiting to be read is not news: one turn, one reminder (R10-followup #4)
    if (pending.items.includes(text)) return;
    pending.items.push(text);
    this.reports.set(threadId, pending);
    this.save();
  }

  hasReports(threadId: string): boolean {
    return (this.reports.get(threadId)?.items.length ?? 0) > 0;
  }

  reportThreads(): PendingReports[] {
    const at = this.now();
    return [...this.reports.values()].filter((pending) => pending.items.length > 0 && (pending.notBefore ?? 0) <= at);
  }

  takeReports(threadId: string): PendingReports | null {
    const pending = this.reports.get(threadId) ?? null;
    if (!pending) return null;
    this.reports.delete(threadId);
    this.save();
    return pending;
  }

  /** takeReports for a turn: kept on disk until settleInFlight. */
  leaseReports(threadId: string): PendingReports | null {
    const pending = this.reports.get(threadId) ?? null;
    if (!pending) return null;
    this.reports.delete(threadId);
    this.inFlight.push({ kind: "reports", botId: pending.botId, threadId, startedAt: this.now(), items: pending.items });
    this.save();
    return pending;
  }

  /** Put reports back when their turn could not start. */
  restoreReports(pending: PendingReports): void {
    this.inFlight = this.inFlight.filter((lease) => !(lease.kind === "reports" && lease.threadId === pending.threadId && lease.items === pending.items));
    const current = this.reports.get(pending.threadId);
    this.reports.set(pending.threadId, current ? { ...pending, items: [...pending.items, ...current.items] } : pending);
    this.save();
  }

  // ── goals ──────────────────────────────────────────────────────────────

  startGoal(botId: string, threadId: string, input: { goal: string; maxTurns: number; maxHours: number }): BotGoal {
    const at = this.now();
    const goal: BotGoal = {
      botId,
      threadId,
      goal: input.goal,
      status: "active",
      startedAt: at,
      deadlineAt: at + input.maxHours * 3_600_000,
      maxTurns: input.maxTurns,
      turnCount: 0,
      consecutiveFailures: 0,
    };
    this.goals.set(threadId, goal);
    this.save();
    return goal;
  }

  goalFor(threadId: string): BotGoal | null {
    return this.goals.get(threadId) ?? null;
  }

  activeGoals(): BotGoal[] {
    return [...this.goals.values()].filter((goal) => goal.status === "active");
  }

  finishGoal(threadId: string, status: Exclude<GoalStatus, "active">, detail: string): BotGoal | null {
    const goal = this.goals.get(threadId);
    if (!goal || goal.status !== "active") return null;
    goal.status = status;
    goal.detail = detail;
    goal.finishedAt = this.now();
    this.save();
    return goal;
  }

  /** Goals stopped to ask the person something. */
  needsInputGoals(): BotGoal[] {
    return [...this.goals.values()].filter((goal) => goal.status === "needs-input");
  }

  /** A goal waiting on the person whose question the world already answered
   * (the PR it asked about was merged or closed): closed as completed. */
  resolveNeedsInput(threadId: string, detail: string, status: "completed" | "blocked" = "completed"): BotGoal | null {
    const goal = this.goals.get(threadId);
    if (!goal || goal.status !== "needs-input") return null;
    goal.status = status;
    goal.detail = detail;
    goal.finishedAt = this.now();
    this.save();
    return goal;
  }

  /** A person answered a goal that stopped to ask them something: the same
   * goal picks up again, with its limits intact. */
  resumeGoalAfterInput(threadId: string): BotGoal | null {
    const goal = this.goals.get(threadId);
    if (!goal || goal.status !== "needs-input") return null;
    goal.status = "active";
    delete goal.detail;
    delete goal.finishedAt;
    goal.consecutiveFailures = 0;
    this.save();
    return goal;
  }

  /** Why an active goal must stop before its next turn, or null. */
  goalLimitReached(goal: BotGoal): string | null {
    if (goal.turnCount >= goal.maxTurns) return `used all ${goal.maxTurns} turns`;
    if (this.now() >= goal.deadlineAt) return "reached its time limit";
    return null;
  }

  /** Ready for its next continuation (the caller still checks busy state). */
  goalReadyForTurn(goal: BotGoal): boolean {
    return goal.status === "active" && (goal.lastDispatchAt === undefined || this.now() - goal.lastDispatchAt >= this.turnGapMs);
  }

  noteGoalDispatch(threadId: string): BotGoal | null {
    const goal = this.goals.get(threadId);
    if (!goal || goal.status !== "active") return null;
    goal.turnCount += 1;
    goal.lastDispatchAt = this.now();
    this.save();
    return goal;
  }

  /** The continuation lost a race for the thread and never ran. */
  undoGoalDispatch(threadId: string): void {
    const goal = this.goals.get(threadId);
    if (!goal || goal.turnCount === 0) return;
    goal.turnCount -= 1;
    delete goal.lastDispatchAt;
    this.save();
  }

  /** A goal turn settled; returns the new failure streak. */
  noteGoalTurnOutcome(threadId: string, ok: boolean): number {
    const goal = this.goals.get(threadId);
    if (!goal || goal.status !== "active") return 0;
    const next = ok ? 0 : goal.consecutiveFailures + 1;
    if (next !== goal.consecutiveFailures) {
      goal.consecutiveFailures = next;
      this.save();
    }
    return next;
  }

  /** Should the Mac stay awake for self-paced work? A goal running, reports
   * or a leased turn in flight, or a wake/watch due within `horizonMs`. */
  wakeHold(horizonMs: number): { hold: boolean; reason?: "running" | "due"; at?: number } {
    if (this.activeGoals().length || this.reportThreads().length || this.inFlight.length) return { hold: true, reason: "running" };
    const at = this.now();
    const due = [
      ...[...this.wakes.values()].map((wake) => wake.watch && !wake.watch.trigger ? Math.min(wake.dueAt, wake.watch.lastRunAt + wake.watch.everyMs) : wake.dueAt),
      ...this.promises.filter((promise) => promise.overdueAt === undefined).map((promise) => promise.dueAt),
    ]
      .filter((when) => when <= at + horizonMs)
      .sort((a, b) => a - b)[0];
    return due === undefined ? { hold: false } : { hold: true, reason: "due", at: due };
  }

  /** Drop everything tied to a conversation that no longer exists. */
  forgetThread(threadId: string): void {
    for (const key of this.lastLines.keys()) if (key === threadId || key.startsWith(`${threadId}${STANDING}`)) this.lastLines.delete(key);
    let hadStanding = false;
    for (const wake of this.standingsFor(threadId)) hadStanding = this.wakes.delete(wakeKey(wake)) || hadStanding;
    const hadWake = this.wakes.delete(threadId) || hadStanding;
    const hadGoal = this.goals.delete(threadId);
    const hadReports = this.reports.delete(threadId);
    const hadPromises = this.promises.some((promise) => promise.threadId === threadId);
    this.promises = this.promises.filter((promise) => promise.threadId !== threadId);
    const hadPending = this.ownerPending.some((open) => open.threadId === threadId);
    this.ownerPending = this.ownerPending.filter((open) => open.threadId !== threadId);
    this.inFlight = this.inFlight.filter((lease) => lease.threadId !== threadId);
    if (hadWake || hadGoal || hadReports || hadPromises || hadPending) this.save();
  }
}

const minutesLabel = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

const GOAL_RULES = [
  "Keep going without waiting for the person. Do the next concrete step now: run the command, open the PR, check the deploy, fix what failed.",
  "When you are waiting on something outside this conversation (CI, a deploy, a review), call wake_when with a read-only command that shows its state — it costs nothing until that state changes — or wake_me for a plain timer, and end the turn instead of polling in a loop.",
  "When teammates you delegated to are still working, just end the turn: their results wake you here.",
  "Call goal_end with status completed only when the deliverable is verifiably done, blocked when you cannot proceed, or needs_input when only the person can decide. Never claim completion you have not checked.",
];

export function goalStartedAck(goal: BotGoal): string {
  return [
    `Modo objetivo ligado nesta conversa: até ${goal.maxTurns} turnos ou ${minutesLabel(goal.deadlineAt - goal.startedAt)}. Quando este turno terminar, você recebe o próximo automaticamente.`,
    "Quando estiver esperando algo fora desta conversa (CI, deploy, revisão), use wake_when com um comando só de leitura que mostre o estado — não custa nada até o estado mudar — ou wake_me para um despertador simples, e encerre o turno em vez de ficar consultando.",
    "Quando colegas a quem você delegou ainda estiverem trabalhando, apenas encerre o turno: os resultados deles te acordam aqui.",
    "Chame goal_end com status completed só quando a entrega estiver comprovadamente feita, blocked quando não puder seguir, ou needs_input quando só a pessoa puder decidir. Nunca declare conclusão que você não conferiu.",
  ].join(" ");
}

// Each harness-written turn message ends with the reply-language reminder
// (server/reply-language.ts): it is machine English, and what the model
// reads last sets the language it answers people in.
export function goalContinuationPrompt(goal: BotGoal, now: number, reminder = languageReminder()): string {
  return [
    `[Goal mode — turn ${goal.turnCount} of ${goal.maxTurns}, ${minutesLabel(goal.deadlineAt - now)} left. Nobody typed this; the harness continues your goal.]`,
    `Goal: ${goal.goal}`,
    "Use this conversation as your progress ledger: check what is already done before repeating anything.",
    ...GOAL_RULES,
    reminder,
  ].join("\n");
}

const clipOutput = (text: string | undefined): string => {
  const value = (text ?? "").trim();
  if (!value) return "(empty)";
  return value.length > WATCH_PROMPT_OUTPUT_MAX ? `${value.slice(0, WATCH_PROMPT_OUTPUT_MAX)}\n… (truncated)` : value;
};

function watchLines(wake: BotWake): string[] {
  const watch = wake.watch;
  if (!watch) return [];
  const why = watch.trigger === "matched"
    ? `its output now matches "${watch.until}"`
    : watch.trigger === "changed"
      ? "its output changed"
      : watch.trigger === "failing"
        ? `the command failed ${watch.failures} times in a row — fix or replace it`
        : "the time limit ran out before anything changed";
  return [
    `Your ${watch.standing ? "standing " : ""}watch \`${watch.command}\` ran ${watch.runs} time(s); you are woken because ${why}.`,
    ...(watch.standing ? ["It stays armed: the server re-arms it on this output after this turn, so do not call wake_when again for it."] : []),
    `${watch.standing ? "Output it last compared against" : "Output when you set it"}:\n${clipOutput(watch.baseline)}`,
    ...(watch.lastOutput !== undefined && watch.lastOutput !== watch.baseline ? [`Latest output:\n${clipOutput(watch.lastOutput)}`] : []),
    // the output is cut: what changed may be past the cut, so say it here
    ...(watch.truncated && watch.newLines?.length ? [`The output is longer than what is shown above. Lines new or changed since the run before (${watch.newLines.length}):\n${watch.newLines.join("\n")}`] : []),
    ...(watch.truncated && !watch.newLines?.length ? ["The output is longer than what is shown above: fetch it again if you need the rest."] : []),
  ];
}

/** Lines, whole, up to `max` characters in all. */
function clipLines(lines: string[], max: number): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > max) break;
    kept.push(line);
    size += line.length + 1;
  }
  return kept;
}

/** When a wake's note was written. A standing watch keeps it across
 * re-arms (reasonAt); one set before reasonAt existed falls back on its
 * createdAt — which re-arms no longer move, and which older builds moved at
 * every firing, so it is the latest the note can be from ("more than N"). */
export function noteWrittenAt(wake: Pick<BotWake, "createdAt" | "watch">): number {
  return wake.watch?.standing ? wake.watch.reasonAt ?? wake.createdAt : wake.createdAt;
}

/** `refsLine`: what the note names that the server found already done
 * (watch-reason-refs.ts), said right under the note (R10-followup #5). */
export function wakePrompt(wake: BotWake, goal: BotGoal | null, now: number, reminder = languageReminder(), refsLine: string | null = null): string {
  return [
    `[${wake.watch ? "Watch" : "Wake-up"} you scheduled ${minutesLabel(now - wake.createdAt)} ago. Nobody typed this.]`,
    ...watchLines(wake),
    // a standing watch's note was written when it was set: it can be stale by now
    wake.watch?.standing && now - noteWrittenAt(wake) >= 3_600_000
      ? `Your note for this moment, written ${wake.watch.reasonAt === undefined ? "more than " : ""}${minutesLabel(now - noteWrittenAt(wake))} ago — check it still holds before acting on it; if not, give it a current one with wake_when update_reason (same label): ${wake.reason}`
      : `Your note for this moment: ${wake.reason}`,
    ...(refsLine ? [refsLine] : []),
    ...(goal && goal.status === "active"
      ? [`You are in goal mode (turn ${goal.turnCount} of ${goal.maxTurns}). Goal: ${goal.goal}`, ...GOAL_RULES]
      : ["Do what the note says. If it still is not ready, call wake_when or wake_me again; if it is, report the result here."]),
    reminder,
  ].join("\n");
}

// Chips are read by people, in the owner's language (pt-BR): short, cut on
// a word, no backticks, and never the raw command a watch runs.

/** `text` on one line, without backticks, cut at a word boundary with "…". */
export function chipText(text: string, max: number): string {
  const clean = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.(—-]+$/, "")}…`;
}

/** A short name for what a watch looks at: "PR #9300", "Chat", a host. */
export function watchLabel(command: string): string {
  const words = command.trim().split(/\s+/).map((word) => word.replace(/^['"]|['"]$/g, ""));
  const [program, group] = words;
  // a number right after a flag is its value (--limit 30, -L 30), not an item
  const number = words.find((word, i) => i > 1 && /^#?\d+$/.test(word) && !words[i - 1]!.startsWith("-"))?.replace("#", "");
  if (program === "gh") {
    if (group === "pr") return number ? `PR #${number}` : "PRs";
    if (group === "issue") return number ? `issue #${number}` : "issues";
    if (group === "run" || group === "workflow") return number ? `execução #${number} do CI` : "execuções do CI";
    if (group === "release") return "releases";
    if (group === "api") {
      const pull = /pulls\/(\d+)/.exec(command) ?? /issues\/(\d+)/.exec(command);
      return pull ? `#${pull[1]} no GitHub` : "GitHub";
    }
    return "GitHub";
  }
  if (program === "gog") return words.includes("sheets") ? "Planilha" : words.includes("chat") ? "Chat" : "Google";
  if (program === "git") {
    const tag = words.find((word) => word.startsWith("refs/tags/"));
    return tag ? `tag ${tag.slice("refs/tags/".length)}` : words.includes("ls-remote") ? "repositório remoto" : "repositório";
  }
  if (program === "curl") {
    const url = words.find((word) => /^https?:\/\//i.test(word));
    try {
      if (url) return new URL(url).host;
    } catch { /* fall through */ }
  }
  return chipText(words.slice(0, 3).join(" "), 40);
}

const hhmm = (ms: number): string => {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

export function wakeChip(wake: BotWake): string {
  const reason = chipText(wake.reason, 100);
  if (wake.watch) {
    const every = Math.round(wake.watch.everyMs / 60_000) || 1;
    const label = watchLabel(wake.watch.command);
    if (wake.watch.standing) return `Vigia permanente${wake.watch.label ? ` "${wake.watch.label}"` : ""} em ${label} a cada ${every} min — ${reason}`;
    return `Vigiando ${label} a cada ${every} min até ${hhmm(wake.dueAt)} — ${reason}`;
  }
  return `Despertador às ${hhmm(wake.dueAt)} — ${chipText(wake.reason, 120)}`;
}

/** The chip for a wake that fires: what woke the bot, in a few words. */
export function wakeFiredChip(wake: BotWake): string {
  if (!wake.watch) return `Acordou — ${chipText(wake.reason, 140)}`;
  const why = { changed: "mudou", matched: "condição atingida", failing: "comando falhando" }[wake.watch.trigger ?? "changed"];
  return `${wake.watch.standing ? `Vigia permanente${wake.watch.label ? ` "${wake.watch.label}"` : ""}` : "Vigia"} disparou (${wake.watch.trigger ? why : "tempo esgotado"}) em ${watchLabel(wake.watch.command)} — ${chipText(wake.reason, 110)}`;
}

export function goalEndChip(goal: BotGoal): string {
  const label = {
    completed: "Objetivo concluído",
    blocked: "Objetivo bloqueado",
    "needs-input": "Objetivo esperando você",
    stopped: "Objetivo parado",
    limit: "Objetivo pausado no limite",
  }[goal.status as Exclude<GoalStatus, "active">];
  return `${label} após ${goal.turnCount} turno${goal.turnCount === 1 ? "" : "s"}${goal.detail ? ` — ${chipText(goal.detail, 160)}` : ""}`;
}

export function reportsPrompt(pending: PendingReports, goal: BotGoal | null, reminder = languageReminder()): string {
  return [
    `[${pending.items.length === 1 ? "A report arrived" : `${pending.items.length} reports arrived`} — from Claude Code sessions you manage or from the harness. Nobody typed this.]`,
    ...pending.items,
    ...(goal && goal.status === "active" ? [`You are in goal mode (turn ${goal.turnCount} of ${goal.maxTurns}). Goal: ${goal.goal}`] : []),
    reminder,
  ].join("\n\n---\n\n");
}

/** For the bot (and its Chief) when a promise passed its time unkept. */
export function promiseOverdueReport(promise: BotPromise, botName: string, now: number): string {
  return [
    `[Promise overdue by ${minutesLabel(now - promise.dueAt)}: ${botName} promised "${promise.text}" (${promise.id}), due ${minutesLabel(now - promise.createdAt)} after it was made, and it was not marked kept.]`,
    "Send what was promised now, or tell the person when it will come and why — then mark it kept with wake_me promise_kept and promise_proof (the sent message's ID). If it was already sent, mark it kept with that message's ID; without an ID it was not sent.",
  ].join("\n");
}

/** The PRs a goal's question cites: links (owner/repo) and "PR #N" / "#N". */
export function prsCited(text: string): Array<{ number: number; slug?: string }> {
  const found = new Map<number, string | undefined>();
  for (const match of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) found.set(Number(match[2]), match[1]);
  for (const match of text.matchAll(/\b(?:PR|pull request)\s*#?(\d{2,6})\b/gi)) if (!found.has(Number(match[1]))) found.set(Number(match[1]), undefined);
  return [...found].map(([number, slug]) => ({ number, ...(slug ? { slug } : {}) }));
}

/** A goal left waiting on the person this long is not "needs you" any more:
 * it is shown as stopped, and the question as unanswered. */
export const NEEDS_INPUT_EXPIRE_MS = 12 * 3_600_000;

/** A bot's own reply that ends by asking the person something ("Posso
 * trocar?"): its time, or null. Only the conversation's last text counts,
 * and only as an answer to the person: a greeting a new bot opens with
 * ("What would you like me to do?") has no message of theirs before it. */
export function lastQuestionAt(messages: ReadonlyArray<{ role: string; kind: string; text?: string; at: number }>, now: number, maxAgeMs = 24 * 3_600_000): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.kind !== "text") continue;
    if (message.role !== "bot") return null;
    const text = (message.text ?? "").replace(/[\s*_`)\]\p{Extended_Pictographic}\uFE0F]+$/u, "");
    const answersPerson = messages.slice(0, i).some((earlier) => earlier.role === "user" && earlier.kind === "text");
    return answersPerson && text.endsWith("?") && now - message.at < maxAgeMs ? message.at : null;
  }
  return null;
}

/** "Preciso de você", "Continuam com você", "Decisão para você"…: the bot
 * asks the person for something in plain words, not only with a "?". */
// "depende de você", "precisa da sua decisão", "aguardando você", "deixei essa decisão com você" (R12-visual N22);
// "do seu"/"da sua" only before what the owner gives (a decision, an ok, a GO): "depende do seu token" asks nothing (INSP-N22 A5)
const OWNER_ASK = /\b(preciso (?:que voc[êe]|de voc[êe]|da sua|do seu|de uma decis[ãa]o)|precisa de voc[êe]|(?:precisa(?:m)?|depende(?:m)?) d[ao] (?:sua|seu) (?:decis[ãa]o|autoriza[çc][ãa]o|aprova[çc][ãa]o|confirma[çc][ãa]o|resposta|aval|ok|go|libera[çc][ãa]o|escolha|aceite|aten[çc][ãa]o|retorno|valida[çc][ãa]o|revis[ãa]o|parecer|sinal|palavra)\b|depende(?:m)? de voc[êe]|continua(?:m)? com voc[êe]|fica(?:m)? com voc[êe]|decis[ãa]o (?:para voc[êe]|sua)|deix(?:o|ei|ar|amos) (?:essa |esta |a )?decis[ãa]o com voc[êe]|pend[êe]ncias? (?:com voc[êe]|do dono|suas)|aguardo (?:a sua|o seu|sua|seu)|aguardando voc[êe]|aguardando (?:a |o )?(?:sua|seu) (?:decis[ãa]o|autoriza[çc][ãa]o|aprova[çc][ãa]o|confirma[çc][ãa]o|resposta|aval|ok|go|libera[çc][ãa]o|escolha|aceite|aten[çc][ãa]o|retorno|valida[çc][ãa]o|revis[ãa]o|parecer|sinal|palavra)\b|esperando (?:por )?voc[êe]|s[óo] voc[êe] pode|need (?:you|your)|waiting (?:on|for) you)/i;
/** A sentence that says the person is NOT needed (R11-visual N15: "Esse
 * trabalho já é meu … e não depende de decisão sua." counted for 10 h). */
// word edges by letter, not \b: \b is ASCII-only, and "é", "você" end in a non-ASCII letter
const NOT_ASK = /(?<![\p{L}\p{N}])(?:n[ãa]o (?:depende|precisa|preciso|requer|exige|pede)(?![\p{L}])[^.!?]*?(?<![\p{L}])(?:voc[êe]|sua|seu|dono)|nada (?:para|pra) (?:voc[êe]|o dono|fazer)|(?:[ée]|fica|est[áa]) (?:meu|comigo)|sigo sozinh[oa]|n[ãa]o (?:h[áa]|tem) (?:nada|pend[êe]ncia|decis[ãa]o) (?:para|pra|sua|de voc[êe])|nada (?:disso |d[ae]ss[ae]s? )?(?:depende|precisa|est[áa] (?:esperando|aguardando)|esperando|aguardando)(?![\p{L}])[^.!?]*?(?<![\p{L}])(?:voc[êe]|sua|seu)|nenhum[ao]?s?\s+(?:\p{L}+\s+){0,2}(?:fica|ficam|continua|continuam|depende|dependem|precisa|precisam|est[áa]|est[ãa]o|espera|esperam|aguarda|aguardam)(?![\p{L}])[^.!?]*?(?<![\p{L}])(?:voc[êe]|dono)|doesn'?t (?:need|depend on) you)(?![\p{L}\p{N}])/iu;
/** A sentence that asks for the person: an explicit ask, never one that denies it. */
/** A sentence's clauses, cut where a contrast or a list starts a new one ("é meu, mas preciso…",
 * "não preciso de você para X, só preciso que…"): a denial in one never cancels an ask in another (INSP-R11fix F-1). */
const CLAUSE_CUT = /\s*(?:,?\s*(?<![\p{L}])(?:mas|por[ée]m|s[óo] que|contudo|entretanto|todavia)(?![\p{L}])|;|,\s*s[óo](?![\p{L}]))\s*/iu;
const asksOwner = (sentence: string): boolean => sentence.split(CLAUSE_CUT).some((clause) => OWNER_ASK.test(clause) && !NOT_ASK.test(clause));
/** asksOwner, also for a routine's text (server/routine-owner-ask.ts), with an extra ask `also` (the owner by name) judged by clause the same way. */
export const asksOwnerSentence = (sentence: string, also?: RegExp): boolean =>
  sentence.split(CLAUSE_CUT).some((clause) => (OWNER_ASK.test(clause) || Boolean(also?.test(clause))) && !NOT_ASK.test(clause));
const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?…])\s+|\n+/);
/** Where, in `sentence`, the ask starts (its first clause that asks without denying), or -1: what comes
 * before it says whether it is said under a condition ("Se a checagem estourar, trago o que depende de você"). */
export function ownerAskIndex(sentence: string, also?: RegExp): number {
  let from = 0;
  for (const clause of sentence.split(CLAUSE_CUT)) {
    const at = sentence.indexOf(clause, from);
    from = at + clause.length;
    if (NOT_ASK.test(clause)) continue;
    const found = [OWNER_ASK.exec(clause), also?.exec(clause) ?? null].filter((match): match is RegExpExecArray => match !== null).map((match) => match.index);
    if (found.length) return at + Math.min(...found);
  }
  return -1;
}

/** Since when the bot has been waiting on the person: the first of its
 * replies, after the person's last message, that asks them something (a
 * question at its end, or an explicit ask anywhere in it). It holds until the
 * person writes again, however many replies come after. null when none, or
 * older than `maxAgeMs`. */
export function ownerAskAt(messages: ReadonlyArray<{ role: string; kind: string; text?: string; at: number; peerAsk?: unknown; from?: unknown }>, now: number, maxAgeMs = 48 * 3_600_000): number | null {
  const fromPerson = (message: { role: string; kind: string; peerAsk?: unknown; from?: unknown }) => message.role === "user" && message.kind === "text" && !message.peerAsk && !message.from;
  const lastPerson = messages.findLastIndex(fromPerson);
  if (lastPerson < 0) return null; // a greeting nobody answered yet asks nothing of anyone
  for (const message of messages.slice(lastPerson + 1)) {
    // once another bot speaks to it, what it asks is for that bot
    if (message.role === "user" && message.peerAsk) break;
    if (message.role !== "bot" || message.kind !== "text" || message.from) continue;
    const text = (message.text ?? "").replace(/[\s*_`)\]\p{Extended_Pictographic}\uFE0F]+$/u, "");
    if ((text.endsWith("?") || sentencesOf(text).some(asksOwner)) && now - message.at < maxAgeMs) return message.at;
  }
  return null;
}


/** What the bot asked, in one sentence the person can read in "Precisa de
 * você" instead of the conversation's title ("@Chief of Staff" says who, not
 * what): the last question of its reply, else the sentence that asks for
 * the person, else its first sentence. Markdown and a leading mention are
 * dropped; at most `max` characters, cut at a word. "" when nothing reads. */
export function ownerAskText(text: string, max = 200, knownNames: readonly string[] = []): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~>]+/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "");
  const sentences = plain
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((each) => stripLeadingMentions(each, knownNames))
    .filter((each) => /\p{L}{3}/u.test(each));
  const at = sentences.findLastIndex((each) => each.endsWith("?"));
  const found = at >= 0
    // a short question carries the sentence before it ("A #9350 passou no gate. Mesclo?": INSP-J r1 #4)
    ? (usefulWords(sentences[at]!) < 2 && at > 0 ? `${sentences[at - 1]} ${sentences[at]}` : sentences[at]!)
    : sentences.find(asksOwner) ?? sentences[0] ?? "";
  // the vocative is who, not what ("Osvaldo, a sessão da #9058…": R10-visual N12c)
  const vocative = leadingVocative(found);
  const said = vocative ? found.replace(/^[\s*_>"'“-]*[^,]+,\s*/u, "") : found;
  // a sentence that followed the mention starts lower-case ("@Chief, preciso…"): a title starts upper-case
  const pick = said.charAt(0).toLocaleUpperCase("pt-BR") + said.slice(1);
  if (pick.length <= max) return pick;
  const cut = pick.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, "")}…`;
}

/** The ask behind ownerAskAt: the bot's reply that waits on the person, as one sentence. */
export function ownerAsk(messages: ReadonlyArray<{ role: string; kind: string; text?: string; at: number; peerAsk?: unknown; from?: unknown }>, now: number, maxAgeMs = 48 * 3_600_000, knownNames: readonly string[] = []): string | null {
  const at = ownerAskAt(messages, now, maxAgeMs);
  if (at === null) return null;
  const message = messages.find((each) => each.at === at && each.role === "bot" && each.kind === "text" && !each.from);
  return message?.text ? ownerAskText(message.text, 200, knownNames) || null : null;
}

/** Words that ask for the person without saying for what. */
const ASK_FILLER = new Set(["preciso", "precisa", "precisamos", "você", "voce", "vocês", "sua", "seu", "suas", "seus", "ajuda", "favor", "por", "uma", "um", "agora", "aqui", "isso", "olhar", "ver", "atenção", "atencao", "urgente", "dono"]);

/** A bot's ask that says nothing of its own, so its own line in "Precisa de
 * você" would only be noise (R10-visual N12: 4 of 17 rows): it points at the
 * panel itself ("O pedido continua na sua lista 'Precisa de você' (o15)"),
 * at another item ("O Monitor abriu a pendência o6"), or asks with no
 * content ("Preciso de você"). `itemIds`: the ids and aliases of the open
 * items — an id among them means the item says it. */
export function echoAsk(text: string, itemIds: readonly string[] = []): boolean {
  const plain = text.replace(/[*_`~]+/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return true;
  // the panel by its name, as a place: quoted, or "na sua lista / no painel / em Precisa de você"
  if (/["'“«‘]\s*Precisa de voc[êe]\s*["'”»’]/i.test(plain) || /\b(?:lista|painel|tela|aba|em|no seu|na sua|no)\s+Precisa de voc[êe]\b/i.test(plain)) return true;
  // a question asks something of its own, even short ("Mesclo?", "Confirma?")
  // or naming an item ("Quer que eu responda à cliente agora (o4)?"): never an echo (INSP-J r1 #4)
  if (/\?\s*\)?\s*$/.test(plain)) return false;
  // it says the person is not needed ("já é meu", "não depende de decisão sua"): nothing to ask (R11-visual N15)
  if (NOT_ASK.test(plain) && !sentencesOf(plain).some(asksOwner)) return true;
  // another item by its id, said and nothing asked ("O Monitor abriu a pendência o6.")
  if (/\b(?:pend[êe]ncias?|itens?|pedidos?)\s+o\d+\b/i.test(plain) || /\(o\d+\)/.test(plain)) return true;
  const ids = new Set(itemIds.map((id) => id.toLowerCase()));
  if ((plain.match(/\bo\d+\b/gi) ?? []).some((id) => ids.has(id.toLowerCase()))) return true;
  // nothing asked: under two words that say something
  return usefulWords(plain) < 2;
}

/** Words of an ask that say something (a vocative, "preciso de você" aside). */
function usefulWords(text: string): number {
  return text.toLowerCase().replace(/^[^,]{1,30},\s*/u, "").split(/[^\p{L}\p{N}#]+/u).filter((word) => word.length >= 3 && !ASK_FILLER.has(word)).length;
}

/** The ask is the very request of an item the person already has: it only
 * echoes one (echoAsk), or the bot opened an item in this conversation in
 * the same breath (a bot item, not the server's — those live in the
 * owner's channel beside any new question). A conversation holding an
 * unrelated item still shows its new question (INSP-J r1 #3). */
export function askCoveredByItem(ask: { text: string; at: number }, items: ReadonlyArray<Pick<OwnerPending, "id" | "threadId" | "createdAt" | "key" | "aliases">>, threadId: string, windowMs = 10 * 60_000): boolean {
  const ids = items.flatMap((item) => [item.id, ...(item.aliases ?? [])]);
  if (echoAsk(ask.text, ids)) return true;
  return items.some((item) => item.threadId === threadId && !item.key && Math.abs(item.createdAt - ask.at) <= windowMs);
}

/** What the bot reads, in the item's conversation, when the person answers
 * an item from "Precisa de você": which item, and the answer — a decision
 * the bot offered, or the person's own words. `resolved` says the item is
 * closed already, so the bot does not open it again. */
export function ownerPendingReplyText(item: Pick<OwnerPending, "id" | "title">, reply: string, resolved: boolean): string {
  // only facts in the person's voice: what to do next goes in ownerPendingAwaitNote, which only the bot reads (INSP-J2 #3)
  return `Sobre "${item.title}" (${item.id}): ${reply.trim()}${resolved ? `\n\n(Marquei ${item.id} como resolvido em "Precisa de você".)` : ""}`;
}

/** What only the bot reads with an answer that keeps the item open (the
 * turn's prompt, never the transcript): it waits on the bot now (J18). */
export function ownerPendingAwaitNote(item: Pick<OwnerPending, "id">): string {
  return `[Nota do OpenMausBot, não escrita pela pessoa] A pendência ${item.id} continua em "Precisa de você", aguardando você: quando estiver feito, resolva-a com owner_pending resolve id ${item.id}; se faltar algo, reescreva-a com owner_pending update id ${item.id}. Sem uma das duas em 2 h, ela volta para a pessoa como "o bot não respondeu".`;
}

/** The person's request, from "Precisa de você", to rewrite an item that has
 * no steps — the words shown in the conversation as theirs (INSP-I r1 #6:
 * plain, no tool names). */
export function ownerPendingStepsRequestText(item: Pick<OwnerPending, "title">): string {
  return `Me mostre como resolver «${item.title}», passo a passo.`;
}

/** What only the bot reads with that request (the turn's prompt, never the
 * transcript): the exact tool call it answers with. */
export function ownerPendingStepsRequestNote(item: Pick<OwnerPending, "id">): string {
  return `[Nota do OpenMausBot, não escrita pela pessoa] A pessoa abriu a pendência ${item.id} em "Precisa de você" e pediu o passo a passo. Reescreva-a com owner_pending update, id ${item.id}: why (1–2 frases: por que importa e o que acontece se esperar), steps (passos numerados e práticos, cada um com o comando exato em command ou o link em link quando houver) e options (as decisões, se for uma escolha: label curto como "Aprovar" e reply com a resposta que você deve receber). Não abra outra pendência; responda à pessoa em uma frase.`;
}
