import { hasCheckableProof } from "./result-contract.ts";
import type { OwnerDelegation, OwnerDelegationBack } from "./owner-delegate.ts";
import type { RowCheck, Superseded } from "./owner-pending-guard.ts";
import { OWNER_ASK, goalCitedPrs } from "./bot-autonomy-text.ts";
// A bot's wakes, watches, promises, goals and owner_pending items: their shapes, limits and input parsing.
import { type SelfWrite } from "./watch-echo.ts";

/** How long, and how many, message starts a bot keeps as seen in its Chat watches. */
export const SEEN_CHAT_MS = 24 * 3_600_000;

export const SEEN_CHAT_MAX = 2_000;

/** Message starts kept on disk per bot (the newest, as hashes), and the most lines of a watch run kept (as hashes). */
export const ECHO_SEEN_PERSIST_MAX = 1_000;

export const ECHO_LINES_PERSIST_MAX = 5_000;

/** The echo memory on disk (bot-autonomy.echo.json): no client text, only hashes. */
export interface EchoMemory {
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
  /** While waiting on the person: the cited PRs' states the bot was last told
   * about (citedPrsOutcome "closed"), so the same news is told once. */
  prNotice?: string;
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
export interface RecoveredLease { botId: string; threadId: string; kind: InFlight["kind"]; startedAt: number; stale: boolean; what: string; outward?: string[]; continued?: boolean; dropped?: boolean }

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
  /** Given by the Decisor (server/owner-decisor.ts) on the owner's behalf, not clicked by the owner. */
  decisor?: true;
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
export const OPENABLE_LINK = /^(?:https?:\/\/\S+|claude:\/\/\S+)$/i;

export const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

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
export function slimResolved(item: OwnerPending, resolvedAt: number, resolvedBy: ResolvedOwnerPending["resolvedBy"], note?: string): ResolvedOwnerPending {
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
export function keepResolved(items: readonly ResolvedOwnerPending[]): ResolvedOwnerPending[] {
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

/** What only the bot reads when the person asks, from "Precisa de você",
 * which decision it recommends (the turn's prompt, never the transcript). */
export function ownerPendingRecommendNote(item: Pick<OwnerPending, "id">): string {
  return `[Nota do OpenMausBot, não escrita pela pessoa] A pessoa abriu a pendência ${item.id} em "Precisa de você" e pediu a sua recomendação. Reescreva as options com owner_pending update, id ${item.id}: as mesmas decisões, com recommended: true em UMA delas (a que você escolheria) e why (uma frase: por que é a melhor). Responda à pessoa em uma frase.`;
}

/** The person's words for that request. */
export function ownerPendingRecommendText(item: Pick<OwnerPending, "title">, botName: string): string {
  return `${botName}, qual destas decisões você recomenda para «${item.title}», e por quê?`;
}

/** A saved item's structured part, read back defensively (an older ledger
 * has none; a hand-edited one may carry anything). */
export function savedDetails(pending: OwnerPending): OwnerPending {
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

export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The commits an item's title names: 9–40 hex characters with a digit and
 * a letter — not a conversation's id ("6477b3f4", 8 characters, or a whole
 * uuid), which is no commit (INSP-H r1 #3). */
export function commitsIn(title: string): string[] {
  return [...title.replace(UUID, " ").matchAll(/(?<![0-9a-z])([0-9a-f]{9,40})(?![0-9a-z])/gi)].map((match) => match[1]!.toLowerCase()).filter((hex) => /\d/.test(hex) && /[a-f]/.test(hex));
}

export const normalLink = (link: string) => link.trim().replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();

export const normalTitle = (title: string) => title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

/** The words that carry a title's meaning (4+ letters, or a #number). */
export const titleWords = (title: string) => new Set(normalTitle(title).split(" ").filter((each) => each.length >= 4 || /^#\d+$/.test(each)));

/** Two titles mostly about the same: at least 60% of the shorter one's words in the other. */
export function similarTitles(a: string, b: string): boolean {
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

export const HEX_SHA = /^[0-9a-f]{7,40}$/;

/** The same action: same kind, and the same target (a commit by prefix, anything else exactly). */
export const sameAction = (a: { kind: string; sha?: string }, b: { kind: string; sha?: string }) =>
  a.kind === b.kind && (a.sha !== undefined && b.sha !== undefined && HEX_SHA.test(a.sha) && HEX_SHA.test(b.sha) ? a.sha.startsWith(b.sha) || b.sha.startsWith(a.sha) : a.sha === b.sha);

/** Two of a bot's items ask the person for the same thing (R9-followup #3:
 * three items, in three conversations, for one release loop): the same
 * action (server key, or the same action read from a title); else the same
 * title; else the same link AND a similar title — "Aprovar o merge da PR
 * #N" and "#M / PR #N: confirmar o padrão" share a link, not an
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

export interface Ledger {
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

/** A conversation whose last standing watch was cancelled: a watcher bot
 * left without its watcher. Alerted once if nothing re-arms it in time. */
export interface StandingLost { botId: string; threadId: string; at: number; alerted?: boolean }

export const STANDING_LOST_ALERT_MS = 10 * 60_000;

export const clip = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export const intIn = (value: unknown, min: number, max: number): number | null =>
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

export type GoalEndInput = { ok: true; status: GoalEndStatus; detail: string; proof?: string } | { ok: false; error: string };

export function parseGoalEndInput(body: { status?: unknown; detail?: unknown; proof?: unknown }): GoalEndInput {
  const raw = typeof body.status === "string" ? body.status.trim().replace("_", "-") : "";
  if (raw !== "completed" && raw !== "blocked" && raw !== "needs-input") {
    return { ok: false, error: "status must be completed, blocked or needs_input" };
  }
  const detail = clip(body.detail, GOAL_DETAIL_MAX);
  if (!detail) return { ok: false, error: "detail is required: what was delivered, or exactly what blocks it" };
  if (raw !== "completed") return { ok: true, status: raw, detail };
  const proof = clip(body.proof, GOAL_DETAIL_MAX);
  if (!proof || !hasCheckableProof(proof)) {
    return { ok: false, error: "proof is required for completed: what someone else can check (a link, the sent message's ID, a PR or issue number, a commit, or the command in backticks with its output). Without one, end as blocked or needs_input." };
  }
  return { ok: true, status: raw, detail: `${detail} — prova: ${proof}`, proof };
}

/** Where a wake is kept: the conversation's one ordinary wake, or its standing watch beside it. */
/** Standing watches: several per conversation, one per label, beside the
 * one ordinary wake. Keys written before labels existed read as "default". */
export const STANDING = "\u0000standing";

export const STANDING_DEFAULT_LABEL = "default";

export const STANDING_MAX_PER_THREAD = 5;

export const standingKey = (threadId: string, label = STANDING_DEFAULT_LABEL) => `${threadId}${STANDING}\u0000${label}`;

export const wakeKey = (wake: Pick<BotWake, "threadId" | "watch">): string => (wake.watch?.standing ? standingKey(wake.threadId, wake.watch.label) : wake.threadId);

export const OUTWARD_CUT_PREFIX = "[Este turno foi interrompido por um restart do servidor e NÃO foi repetido automaticamente,";

export const OUTWARD_CUT_LABELS = 8;

export function outwardCutNote(labels: readonly string[]): string {
  const shown = labels.slice(0, OUTWARD_CUT_LABELS).join(", ");
  const more = labels.length > OUTWARD_CUT_LABELS ? ` e mais ${labels.length - OUTWARD_CUT_LABELS}` : "";
  const why = labels.length
    ? ` porque já tinha agido para fora antes do corte: ${shown}${more}.`
    : " porque não deu para conferir o que ele já tinha feito para fora antes do corte.";
  return `${OUTWARD_CUT_PREFIX}${why} Não repita nada disso: confira antes o estado real (o push, o merge, o release, a mensagem enviada) e faça só o que ainda falta; se não der para confirmar, pergunte ao dono.]`;
}

export type LeaseRecovery =
  /** nothing outward, nothing that goes on: due again, once (as before) */
  | { kind: "rerun" }
  /** its turn already acted outward: not run again; the bot is asked, with what it did */
  | { kind: "outward"; labels: string[] }
  /** its own root goes on (the work it handed out, the person's cards): that is the continuation */
  | { kind: "continued" };

export function leaseRecoveryFor(
  lease: Pick<InFlight, "startedAt">,
  found: { roots: ReadonlyArray<{ createdAt: number }>; outward: readonly string[] },
): LeaseRecovery {
  if (found.roots.some((root) => root.createdAt >= lease.startedAt)) return { kind: "continued" };
  if (found.outward.length) return { kind: "outward", labels: [...found.outward] };
  return { kind: "rerun" };
}

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

export const QUESTION_REPORT_PREFIX = "[Servidor: pergunta sem passo a passo]";

export function questionStepsAutoReport(ask: Pick<AskPromotion, "threadId" | "askAt" | "text">, threadTitle?: string): string {
  const where = threadTitle ? ` na conversa «${threadTitle.slice(0, 80)}»` : "";
  return `${QUESTION_REPORT_PREFIX} Ref ${ask.threadId}@${ask.askAt}. Você terminou um turno${where} com uma pergunta ao dono: «${ask.text.slice(0, 300)}». Em "Precisa de você" ela aparece só como título, sem por quê, sem passos e sem opções. Registre-a com owner_pending add: replacesAsk "${ask.threadId}@${ask.askAt}" (é o que liga o item a esta pergunta), title (o que o dono decide, em uma frase), why (1–2 frases: por que importa e o que acontece se esperar), steps (passos práticos, com o comando em command ou o link em link quando houver) e options (as respostas possíveis, UMA com recommended: true e why). O item substitui a pergunta na tela. Se a pergunta não vale mais, não abra nada. Não escreva ao dono só por isto.`;
}

export function questionReportRef(text: string): { threadId: string; askAt: number } | null {
  if (!text.startsWith(QUESTION_REPORT_PREFIX)) return null;
  const ref = /^ Ref ([\w-]+)@(\d+)\./.exec(text.slice(QUESTION_REPORT_PREFIX.length));
  return ref ? { threadId: ref[1]!, askAt: Number(ref[2]) } : null;
}

export function parseReplacesAsk(value: unknown): { threadId: string; askAt: number } | null {
  const ref = typeof value === "string" ? /^([\w-]+)@(\d+)$/.exec(value.trim()) : null;
  return ref ? { threadId: ref[1]!, askAt: Number(ref[2]) } : null;
}

export const ANSWERED_IN_CONVERSATION = "respondida na conversa";

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

export const ANSWER_WINDOW_MS = 2 * 3_600_000;

export const ANSWERED_REPORT_PREFIX = "[Servidor: pendência fechada]";

export function answeredInConversationReport(item: Pick<OwnerPending, "id" | "title">, ref: Pick<AskPromotion, "threadId" | "askAt" | "text">, answer: string): string {
  return `${ANSWERED_REPORT_PREFIX} O dono respondeu na conversa à sua pergunta «${ref.text.slice(0, 200)}»: «${answer.slice(0, 300)}». O item ${item.id} («${item.title.slice(0, 120)}») foi fechado como ${ANSWERED_IN_CONVERSATION}. Se era a resposta, siga com ela. Se não era resposta a esta pergunta, reabra o item com owner_pending add replacesAsk "${ref.threadId}@${ref.askAt}" (o mesmo title, why, steps e options). Não escreva ao dono só por isto.`;
}

export function ownerPendingNumber(id: string): number {
  const match = /^o(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

export const sameCommands = (existing: OwnerPending, input: { steps?: OwnerPendingStep[]; options?: OwnerPendingOption[] }) =>
  (!input.steps?.length || JSON.stringify(input.steps) === JSON.stringify(existing.steps)) && (!input.options?.length || JSON.stringify(input.options) === JSON.stringify(existing.options));

export interface DiskPushCheck {
  botId: string;
  /** The conversation the answer was sent to, and when, and how it begins: the turn that carried it ends there. */
  threadId: string;
  at: number;
  marker: string;
  folders: Array<{ name: string; branch?: string; head: string }>;
}

export const DELIVERY_VERB = /\b(?:lev(?:ar|e|o)|sub(?:ir|a|o)|publi(?:car|que|co)|entreg(?:ar|ue|o)|coloc(?:ar|que|o)|cheg(?:ar|ue)|liber(?:ar|e)|ship|deploy|release)\b/i;

export const PRODUCTION_WORD = /produ[cç][aã]o|\bproduction\b|\bprod\b/i;

export function productionGoal(goalText: string): boolean {
  return DELIVERY_VERB.test(goalText) && PRODUCTION_WORD.test(goalText);
}

export function productionGoalProblem(input: { goalText: string; goalStartedAt: number; proof: string; announcedPrs: ReadonlySet<number>; certifiedReleases: ReadonlyMap<string, number> }): string | null {
  if (!productionGoal(input.goalText)) return null;
  const guide = "Se ainda não chegou, espere o anúncio, ou encerre como blocked ou needs_input dizendo o que falta.";
  const goalPrs = goalCitedPrs(input.goalText).map((pr) => pr.number);
  if (goalPrs.length) {
    const missing = goalPrs.filter((number) => !input.announcedPrs.has(number));
    if (!missing.length) return null;
    return `a meta fala em produção: toda PR que ela cita precisa ter sido anunciada em produção pelo servidor (o chip "em produção desde"). ${missing.map((number) => `#${number}`).join(", ")} ainda não ${missing.length > 1 ? "foram anunciadas" : "foi anunciada"}. ${guide}`;
  }
  const proofPrs = goalCitedPrs(input.proof).map((pr) => pr.number);
  if (proofPrs.length && proofPrs.every((number) => input.announcedPrs.has(number))) return null;
  const shas = [...input.proof.matchAll(/\b[0-9a-f]{40}\b/g)].map((match) => match[0]);
  if (shas.some((sha) => (input.certifiedReleases.get(sha) ?? -Infinity) > input.goalStartedAt)) return null;
  return `a meta fala em produção: a prova precisa citar PRs que o servidor já anunciou em produção (o chip "em produção desde"), ou o commit completo (40 caracteres) de um release que o corredor certificou depois que a meta começou. ${guide}`;
}
