// "Precisa de você" (this fork), moved out of server/index.ts's inline
// routes into the route table (server/routes/README.md): the settled items
// with what the person answered (GET /api/bots/:id/owner-pending-resolved),
// and, on one open item, resolve, unsupersede, remind, delegate and reply
// (POST /api/bots/:id/owner-pending/:item/...); POST
// /api/bots/:id/tasks/:threadId/ask-steps asks a bot again to register its
// bare question as an item. The table runs after the auth gate; scope rules
// stay keyed by path in server/request-auth.ts, which opens none of these to
// clients (admin scope by default). Everything index.ts owns comes in `deps`.
import { existsSync } from "node:fs";

import type { ResolvedSender } from "../../shared/wire.ts";
import { answerKey, duplicateAnswerText, failedSince, onAnswered, type AnswerDedupe } from "../answer-dedupe.ts";
import {
  chipText,
  ownerPendingAwaitNote,
  ownerPendingRecommendNote,
  ownerPendingRecommendText,
  ownerPendingReplyText,
  ownerPendingStepsRequestNote,
  ownerPendingStepsRequestText,
  ownerPendingVisible,
  type AskPromotion,
  type BotAutonomy,
  type OwnerPending,
} from "../bot-autonomy.ts";
import type { AppAvailability } from "../cc-sessions.ts";
import type { StartResult } from "../cc-start-queue.ts";
import type { AppConfig } from "../config.ts";
import {
  answerTouchesMoved,
  asksBotItemRemoval,
  DISK_BOT_ITEM_NOT_AUTHORIZED,
  DISK_DECISION_KEY_PREFIX,
  DISK_NOT_AUTHORIZED,
  diskChangedText,
  diskTextNotice,
  goneDiskItem,
  keepsFolders,
  keyFolders,
} from "../disk-decision.ts";
import { routedReplyText } from "../owner-channel.ts";
import {
  APP_FLAPPING_CHECK_LABEL,
  APP_UNBLOCK_CHECK_LABEL,
  APP_UNBLOCK_DECLINE_LABEL,
  APP_UNBLOCK_DECLINE_MS,
  appStillBlockedText,
  staleUnblockItem,
  type FolderBlockSeen,
  type FolderFlapState,
} from "../owner-chips.ts";
import { DECISOR_LINE, DECISOR_NOTE_PREFIX, isDecisorRequest } from "../owner-decisor.ts";
import { delegationBrief, delegationChoice, type DelegatedItemRef, type OwnerDelegationBack } from "../owner-delegate.ts";
import { supersededLine } from "../owner-pending-guard.ts";
import { pluggedInRefusal, POWER_PENDING_KEY, POWER_PLUGGED_LABEL, type PowerState } from "../power.ts";
import { promptWithReply } from "../replies.ts";
import type { RequestAuth } from "../request-auth.ts";
import { keepRoutineAsk, ownerAnswersItem, ROUTINE_ASK_KEEP_LABEL, ROUTINE_ASK_KEY_PREFIX } from "../routine-owner-ask.ts";
import { assertWithinBudget } from "../spend.ts";
import { queueSteeredMessage } from "../steer-queue.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Why a New Session in the Claude app would land in a wrong folder now, as
 * appFolderBlock (server/index.ts) answers it; null when the app may be used. */
type AppFolderBlock =
  | { kind: "reused"; last: { folder: string; title?: string } }
  | { kind: "root"; last: { folder: string; title?: string } }
  | { kind: "flapping"; last: { folder: string; title?: string }; seen: FolderBlockSeen[] };

/** What startOrQueueDirectMessage (server/index.ts) answers with: the turn's
 * line, or the queue slot the words wait in. Written out here so the module
 * needs nothing from index.ts. */
type DirectMessageOutcome =
  | { ok: true; queued: true; queueId: string; threadId: string; reason?: unknown }
  | { ok: true; threadId: string; message: Message };

export interface OwnerPendingRouteDeps {
  store: Pick<Store, "appendMessage" | "bot" | "taskByThread">;
  autonomy: BotAutonomy;
  cfg: AppConfig;
  dataDir: string;
  /** The stop file in the owner's home: while it exists, nothing goes out to the bots. */
  nuriaStopFile: string;
  /** The key prefix of the server's own "unblock the app" item. */
  appUnblockKey: string;
  /** How long a request for a bare question's steps holds before another may go. */
  questionStepsAskAgainMs: number;
  /** The replies' answer-dedupe: the same answer to the same item is taken once. */
  answerDedupe: AnswerDedupe;
  /** What the owner declined from "Precisa de você", and until when. */
  ownerDeclines: { set(key: string, at: number): void };
  /** The app's folder blocks, counted toward a flip stop. */
  appFolderFlaps: { set(next: FolderFlapState): void };
  cloudGuestSendRefusal(auth: RequestAuth, threadId: string): string | null;
  messageSender(auth: RequestAuth): ResolvedSender | undefined;
  usageTriggerFor(auth: RequestAuth): UsageTrigger;
  refreshBotRow(botId: string): void;
  ownerTurnThread(botId: string, from: string): string;
  /** Goal mode in this thread stopped to ask the person: when, or null. Read per call (set once autonomy exists). */
  goalNeedsInputForThread(threadId: string): number | null;
  askQuestionSteps(botId: string, threadId: string, at: number): AskPromotion | null;
  delegationTime(at: number): string;
  delegateView(item: OwnerPending, isRepo: (path: string) => boolean): { repo: string } | { onlyYou: string };
  ccIsGitRepo(path: string): boolean;
  delegationOwner(bot: BotRecord, item: OwnerPending): { bot: BotRecord; threadId: string } | null;
  appAvailability(repo: string): { state: AppAvailability; reason: string | null };
  startCcSession(bot: BotRecord, threadId: string, replyThreadId: string, body: Record<string, unknown>, fromQueue?: boolean, delegation?: DelegatedItemRef): StartResult;
  delegationReturned(ref: DelegatedItemRef, back: OwnerDelegationBack): void;
  delegationChip(item: OwnerPending, text: string, ok?: boolean): void;
  appFolderBlock(): AppFolderBlock | null;
  ownOnByName(name: string): boolean;
  readPowerNow(): Promise<PowerState | null>;
  /** Runs `work` in turn with a routine's disk pass. */
  diskItemTurn<T>(work: () => Promise<T>): Promise<T>;
  recheckDiskItem(
    item: OwnerPending, used: readonly string[], processCwds: readonly string[] | null, text: string,
    answer?: { kind: string; label?: string; text?: string },
  ): Promise<{ outcome: "keep" | "replace" | "close"; line: string; note?: string }>;
  foldersInUse(): string[];
  allProcessCwds(): Promise<string[] | null>;
  replaceQueuedChoice(botId: string, item: OwnerPending): void;
  drainQueuedSends(): void;
  startOrQueueDirectMessage(
    botId: string, threadId: string, text: string, replyTo?: Message, sendId?: string, sender?: ResolvedSender, trigger?: UsageTrigger,
  ): Promise<DirectMessageOutcome>;
}

export function createOwnerPendingRoutes(deps: OwnerPendingRouteDeps): RouteHandler {
  const {
    store, autonomy, cfg, answerDedupe, ownerDeclines, appFolderFlaps,
    dataDir: DATA_DIR, nuriaStopFile: NURIA_STOP_FILE, appUnblockKey: APP_UNBLOCK_KEY, questionStepsAskAgainMs: QUESTION_STEPS_ASK_AGAIN_MS,
    cloudGuestSendRefusal, messageSender, usageTriggerFor, refreshBotRow, ownerTurnThread, goalNeedsInputForThread, askQuestionSteps,
    delegationTime, delegateView, ccIsGitRepo, delegationOwner, appAvailability, startCcSession, delegationReturned, delegationChip,
    appFolderBlock, ownOnByName, readPowerNow, diskItemTurn, recheckDiskItem, foldersInUse, allProcessCwds, replaceQueuedChoice,
    drainQueuedSends, startOrQueueDirectMessage,
  } = deps;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/bots/") || (!path.includes("/owner-pending") && !path.endsWith("/ask-steps"))) return PASS;
    /** scratch for the route match, as index.ts's shared `m` */
    let m: RegExpMatchArray | null = null;
    // the settled items, with what the person answered: the audit trail (INSP-J2 #12)
    m = path.match(/^\/api\/bots\/([\w-]+)\/owner-pending-resolved$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // the same guest rule as answering: on a Cloud, a guest sees only what came from conversations it started (INSP-J2 r2 N7)
      return json(res, 200, { resolved: ownerPendingVisible(autonomy.resolvedOwnerPendingOf(bot.id), (threadId) => cloudGuestSendRefusal(auth, threadId)).slice().reverse() });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/owner-pending\/([\w-]+)\/resolve$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const open = autonomy.ownerPendingById(bot.id, m[2]!);
      const notYours = open ? cloudGuestSendRefusal(auth, open.threadId) : null;
      if (notYours) return json(res, 403, { error: notYours });
      const done = autonomy.resolveOwnerPending({ botId: bot.id, id: m[2]!, by: "owner" });
      // the bot reads it in that conversation: the person settled it
      for (const item of done) {
        if (store.taskByThread(bot.id, item.threadId)) store.appendMessage(item.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Resolvido pela pessoa: ${item.title}`, 240), ok: true } });
      }
      refreshBotRow(bot.id);
      return json(res, 200, { resolved: done.length });
    }
    // "Os comandos ainda valem": the owner lifts a superseded mark — the bot that marked it may have been wrong (INSP-R13fol #13)
    m = path.match(/^\/api\/bots\/([\w-]+)\/owner-pending\/([\w-]+)\/unsupersede$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const open = autonomy.ownerPendingById(bot.id, m[2]!);
      if (!open) return json(res, 404, { error: "Este item não está mais aberto." });
      const notYours = cloudGuestSendRefusal(auth, open.threadId);
      if (notYours) return json(res, 403, { error: notYours });
      if (!open.supersededBy) return json(res, 200, { ok: true });
      const was = open.supersededBy;
      autonomy.patchOwnerPending(bot.id, open.id, { supersededBy: undefined });
      if (store.taskByThread(bot.id, open.threadId)) store.appendMessage(open.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`"Precisa de você": ${open.id} — a pessoa disse que os comandos ainda valem (a marca do ${was.id} do ${was.botName} caiu)`, 240), ok: true } });
      refreshBotRow(bot.id);
      console.log(`[owner-pending] ${open.id} of ${bot.name}: the owner lifted the superseded mark of ${was.id} (${was.botName})`);
      return json(res, 200, { ok: true });
    }
    // "Lembrar <bot>": an answered item the bot let go silent for 2 h. The
    // reminder is a system report (never the person's words), sent once while
    // it waits to be read; the item waits on the bot again (INSP-J2 r2 N3).
    m = path.match(/^\/api\/bots\/([\w-]+)\/owner-pending\/([\w-]+)\/remind$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const item = autonomy.ownerPendingById(bot.id, m[2]!);
      if (!item) return json(res, 404, { error: "Este item já foi resolvido." });
      const notYours = cloudGuestSendRefusal(auth, item.threadId);
      if (notYours) return json(res, 403, { error: notYours });
      const target = ownerTurnThread(bot.id, item.threadId);
      if (!store.taskByThread(bot.id, target)) return json(res, 409, { error: "A conversa de origem deste item não existe mais. Marque-o como resolvido." });
      const reminded = autonomy.remindOwnerPending(bot.id, item.id, target);
      // why not, by its real reason: the answer still in the queue is not the bot's silence (INSP-J2 r4 A4)
      if (reminded === "queued") return json(res, 409, { error: `Sua resposta ainda está na fila: ${bot.name} a recebe assim que terminar o que está fazendo. Um lembrete não passaria na frente.`, code: "answer_queued" });
      if (!reminded) return json(res, 409, { error: `${bot.name} ainda tem tempo para responder a este item.`, code: "not_silent" });
      refreshBotRow(bot.id);
      return json(res, 202, { ok: true, deduped: reminded.deduped, threadId: target });
    }
    // "Pedir de novo" on a bot's bare question (lot J2): the server asks the
    // bot again, as itself, to register it as an item with why, steps and
    // options — never in the person's words, never within 15 min of the last
    // request, never with ~/.nuria/stop.
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)\/ask-steps$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (!store.taskByThread(bot.id, m[2]!)) return json(res, 404, { error: "Esta conversa não existe mais." });
      const notYours = cloudGuestSendRefusal(auth, m[2]!);
      if (notYours) return json(res, 403, { error: notYours });
      // a request still in its 15 min (its turn may be running right now, the question hidden meanwhile): nothing more is sent
      const current = autonomy.allAskPromotions().findLast((each) => each.botId === bot.id && each.threadId === m![2] && !each.itemId && each.answeredAt === undefined);
      if (current && Date.now() - current.askedAt < QUESTION_STEPS_ASK_AGAIN_MS) return json(res, 200, { ok: true, deduped: true, askedAt: current.askedAt });
      const at = goalNeedsInputForThread(m[2]!);
      if (at === null) return json(res, 409, { error: `${bot.name} não espera mais uma resposta sua nesta conversa.`, code: "no_question" });
      if (existsSync(NURIA_STOP_FILE)) return json(res, 409, { error: "O ~/.nuria/stop está ativo: nenhum pedido sai para os bots até ele ser removido. Responda abaixo ou abra a conversa.", code: "stopped" });
      const asked = askQuestionSteps(bot.id, m[2]!, at);
      if (!asked) return json(res, 409, { error: `A conversa de ${bot.name} com você não existe mais. Responda abaixo.`, code: "no_channel" });
      return json(res, 202, { ok: true, deduped: false, askedAt: asked.askedAt });
    }
    // "Delegar a um agente" (lote del): the server opens a Claude Code session
    // for the item the way the Chief does (startCcSession: the same guard,
    // worktree option and breaker) with the decision the owner chose, else
    // the recommended one, else the steps. The item waits on the session, out
    // of the count, until its report settles it. Never an approve, and only
    // what an agent may do (server/owner-delegate.ts onlyYouReason).
    m = path.match(/^\/api\/bots\/([\w-]+)\/owner-pending\/([\w-]+)\/delegate$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const item = autonomy.ownerPendingById(bot.id, m[2]!);
      if (!item) return json(res, 404, { error: "Este item já foi resolvido." });
      const notYours = cloudGuestSendRefusal(auth, item.threadId);
      if (notYours) return json(res, 403, { error: notYours });
      // a double click is one delegation: the replies' answer-dedupe, keyed by the item
      const key = answerKey(bot.id, item.id, { kind: "delegate", text: "" });
      const claim = answerDedupe.claim(key);
      if (!claim.ok) return json(res, 200, { ok: true, duplicate: true, message: claim.sent ? "Este item já foi delegado; não abri outra sessão." : "A delegação deste item ainda está sendo aberta; não abri outra sessão." });
      onAnswered(res, (status) => (status < 300 ? answerDedupe.sent(key) : answerDedupe.release(key)));
      // one delegation at a time per item
      if (item.delegation) return json(res, 409, { error: `Este item já está com um agente (delegado ${delegationTime(item.delegation.at)}).`, code: "already_delegated" });
      const view = delegateView(item, ccIsGitRepo);
      if ("onlyYou" in view) return json(res, 409, { error: `Só você: ${view.onlyYou}.`, code: "not_delegable" });
      if (existsSync(NURIA_STOP_FILE)) return json(res, 409, { error: "O ~/.nuria/stop está ativo: nenhuma sessão é aberta até ele ser removido.", code: "stopped" });
      try {
        assertWithinBudget(cfg, DATA_DIR);
      } catch (error) {
        return json(res, 409, { error: error instanceof Error ? error.message : String(error), code: "spend_cap" });
      }
      const owner = delegationOwner(bot, item);
      if (!owner) return json(res, 409, { error: "A conversa de origem deste item não existe mais. Marque-o como resolvido.", code: "no_thread" });
      const { title, brief } = delegationBrief(item, { botName: bot.name, threadTitle: store.taskByThread(bot.id, item.threadId)?.title, now: Date.now(), time: delegationTime });
      // the app when it can take the session now; else the terminal, with the reason the server knows
      const app = appAvailability(view.repo);
      const body: Record<string, unknown> = { title, brief, repo: view.repo, ...(app.state === "available" ? {} : { surface: "cli", cliReason: `delegação do dono pelo "Precisa de você": ${app.reason ?? "o app Claude não abre sessão neste repositório agora"}` }) };
      const choice = delegationChoice(item);
      const ref = { botId: bot.id, itemId: item.id };
      // marked before the start: the session it creates finds the item delegated
      autonomy.patchOwnerPending(bot.id, item.id, { delegation: { at: Date.now(), state: "queued", ...(choice && choice !== "none" ? { option: choice.option.label } : {}) }, delegationBack: undefined });
      const started = startCcSession(owner.bot, owner.threadId, owner.threadId, body, false, ref);
      if (started.status !== 200 || (!started.sessionId && !started.queueId)) {
        const reason = String(started.body.error ?? started.body.message ?? "erro desconhecido").slice(0, 600);
        delegationReturned(ref, { at: Date.now(), outcome: "falhou", text: `a sessão não abriu: ${reason}` });
        return json(res, 409, { error: `A sessão não abriu: ${reason}`, code: "not_opened" });
      }
      const now = autonomy.ownerPendingById(bot.id, item.id);
      if (started.queueId && now?.delegation) autonomy.patchOwnerPending(bot.id, item.id, { delegation: { ...now.delegation, queueId: started.queueId } });
      delegationChip(item, `Delegado a um agente pelo dono: ${item.title}${started.sessionId ? ` (sessão ${started.sessionId})` : " (na fila de sessões)"}`);
      refreshBotRow(bot.id);
      if (owner.bot.id !== bot.id) refreshBotRow(owner.bot.id);
      console.log(`[owner-delegate] ${item.id} of ${bot.name} delegated: ${started.sessionId ? `session ${started.sessionId}` : `queued ${started.queueId}`} in ${view.repo}${choice && choice !== "none" ? `, decision "${choice.option.label}"` : ""}`);
      return json(res, 202, { ok: true, ...(started.sessionId ? { sessionId: started.sessionId } : {}), ...(started.queueId ? { queueId: started.queueId } : {}) });
    }
    // The person answers an item from "Precisa de você": a decision the bot
    // offered (options[n]), their own words, or a request for the steps. The
    // answer goes to the bot that owns the item, in the conversation it came
    // from — as the person's message, so it runs now or waits its turn there
    // like any send — and a decision (or resolve: true) closes the item.
    m = path.match(/^\/api\/bots\/([\w-]+)\/owner-pending\/([\w-]+)\/reply$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      const bot = store.bot(m[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const item = autonomy.ownerPendingById(bot.id, m[2]!);
      if (!item) return json(res, 404, { error: "Este item já foi resolvido." });
      if (!store.taskByThread(bot.id, item.threadId)) return json(res, 409, { error: "A conversa de origem deste item não existe mais. Marque-o como resolvido." });
      const notYours = cloudGuestSendRefusal(auth, item.threadId);
      if (notYours) return json(res, 403, { error: notYours });
      let text: string;
      let resolve: boolean;
      // what goes in the item's history (J18)
      let answer: { kind: "option" | "text" | "ask"; label?: string; text: string; decisor?: true };
      // the Decisor answers through this same route, in-process: its answer is marked as its own (server/owner-decisor.ts)
      const byDecisor = isDecisorRequest(req);
      if (body.ask === "steps") {
        text = ownerPendingStepsRequestText(item);
        resolve = false;
        answer = { kind: "ask", label: "steps", text };
      } else if (body.ask === "recommend") {
        // an item with decisions and none recommended: the bot is asked which, and why (J16)
        if ((item.options?.length ?? 0) < 2) return json(res, 400, { error: "Este item não tem decisões para recomendar." });
        text = ownerPendingRecommendText(item, bot.name);
        resolve = false;
        answer = { kind: "ask", label: "recommend", text };
      } else if (body.option !== undefined && item.key?.startsWith(ROUTINE_ASK_KEY_PREFIX) && body.label === ROUTINE_ASK_KEEP_LABEL && item.options?.some((each) => each.label === ROUTINE_ASK_KEEP_LABEL)) {
        // "Ainda vale" on a routine's item under "Talvez já resolvido": back on top, nothing sent to the bot (INSP-N22 r2 F2)
        keepRoutineAsk(autonomy, bot.id, item.id, Date.now());
        refreshBotRow(bot.id);
        return json(res, 200, { ok: true, resolved: 0, kept: true, message: `"${item.title}" voltou para o topo de "Precisa de você".` });
      } else if (body.option !== undefined && item.supersededBy) {
        // another item said this one's commands must not run: its decisions are off (R13-intake #1)
        return json(res, 409, { error: supersededLine(item.supersededBy), code: "item_superseded" });
      } else if (body.option !== undefined) {
        // the decision the person SAW: its position and its label, so a bot
        // that reordered or rewrote the options meanwhile never gets another
        // answer than the one clicked (INSP-I r1 #3)
        // the server's own unblock item is rewritten by the SERVER (gesture, flip
        // diagnosis) — the answer is taken by its label, and a label the item no
        // longer has says what the item is now, never "o bot" (INSP-S r2 S2-1)
        const unblockItem = Boolean(item.key?.startsWith(APP_UNBLOCK_KEY));
        const option = unblockItem && typeof body.label === "string"
          ? item.options?.find((each) => each.label === body.label)
          : Number.isInteger(body.option) ? item.options?.[body.option as number] : undefined;
        if (unblockItem && !option) {
          return json(res, 409, { error: `O item mudou enquanto você o lia: "${String(body.label ?? "")}" não vale mais. Agora ele diz: ${item.title}.${item.why ? `\n\n${item.why}` : ""}`, code: "item_changed" });
        }
        const rewrote = item.key ? "O servidor atualizou" : "O bot reescreveu";
        if (!option) return json(res, 409, { error: `Esta decisão não existe mais: ${rewrote.charAt(0).toLowerCase()}${rewrote.slice(1)} as opções. Confira e escolha de novo.`, code: "options_changed" });
        if (typeof body.label !== "string" || body.label !== option.label) return json(res, 409, { error: `${rewrote} as opções deste item: "${String(body.label ?? "")}" não é mais a opção ${Number(body.option) + 1}. Confira e escolha de novo.`, code: "options_changed" });
        // "Feito, conferir" is checked against the app's records before it
        // is taken: still blocked, the item stays and the person reads why
        // (R10-dispatch R10-2)
        // "Rodei o teste, conferir" (the app flapped): the count starts over, then the same check (INSP-S r1 S-3)
        const flapCheck = Boolean(item.key?.startsWith(APP_UNBLOCK_KEY) && option.label === APP_FLAPPING_CHECK_LABEL);
        if (flapCheck) {
          appFolderFlaps.set({ seen: [] });
          console.log("[claude-desktop] the owner ran the guided test: the app's folder blocks are counted from zero");
        }
        if (item.key?.startsWith(APP_UNBLOCK_KEY) && (option.label === APP_UNBLOCK_CHECK_LABEL || flapCheck) && process.platform === "darwin") {
          const block = appFolderBlock();
          if (block) {
            const name = item.key.slice(APP_UNBLOCK_KEY.length);
            // the item asks, from now on, the gesture that fits what the records show
            const want = staleUnblockItem(item, name, block.kind, block.kind === "flapping" ? block.seen : [], ownOnByName(name));
            if (want) {
              autonomy.addOwnerPending(bot.id, item.threadId, { ...want, key: item.key });
              refreshBotRow(bot.id);
            }
            // the flip: the diagnosis itself, not only "it changed"
            const diagnosis = block.kind === "flapping" ? `\n\n${(want ?? staleUnblockItem({}, name, "flapping", block.seen))?.why ?? ""}` : "";
            return json(res, 409, { error: `${appStillBlockedText(block, name, ownOnByName(name))}${diagnosis}`, code: "app_still_blocked" });
          }
        }
        // "seguir no terminal" is kept: the server does not recreate the item for 24 h (INSP-J r1 #8) — and it closes it
        const declined = Boolean(item.key?.startsWith(APP_UNBLOCK_KEY) && option.label === APP_UNBLOCK_DECLINE_LABEL);
        if (declined) ownerDeclines.set(item.key!, Date.now() + APP_UNBLOCK_DECLINE_MS);
        // a bot's item waits on the bot after a decision ("Aguardando …", J18); the
        // server's own items (power, release loop, tag, the app) close on the choice
        // as before — the server follows their condition itself (INSP-J2 #2)
        resolve = declined || Boolean(item.key);
        text = ownerPendingReplyText(item, option.reply, resolve);
        answer = { kind: "option", label: option.label, text: option.reply };
        // "Liguei na tomada" is checked, not believed: still on battery, the item stays open (INSP-J2 r2 N4)
        if (item.key === POWER_PENDING_KEY && option.label === POWER_PLUGGED_LABEL) {
          const refusal = pluggedInRefusal(await readPowerNow());
          if (refusal) return json(res, 409, { error: refusal, code: "still_on_battery" });
        }
      } else {
        const reply = typeof body.text === "string" ? body.text.trim() : "";
        if (!reply) return json(res, 400, { error: "Escreva a resposta ao bot." });
        // a routine's item closes with the owner's words when they end it ("Já falei com ele"); a question
        // or a note goes to the bot and the item stays open — in doubt, open (INSP-N22 A3)
        // a ticket's or issue's item: its action named, or the item closed in so many words (INSP-N22 r3 R6)
        // answering THIS item from the panel, the owner needs not name it: any affirmative or action closes it (INSP-N22 r5 T2)
        resolve = body.resolve === true || Boolean(item.key?.startsWith(ROUTINE_ASK_KEY_PREFIX) && ownerAnswersItem(item, reply));
        text = ownerPendingReplyText(item, reply.slice(0, 4_000), resolve);
        answer = { kind: "text", text: reply };
      }
      // any answer to a disk item — a decision or free text ("pode remover todas") — is checked on the Mac first:
      // a folder used since, or no longer clean, changes the item and the answer is not sent (INSP-R12F r2 R2-1);
      // otherwise the Chief reads, under the answer, the state found now and to check again before removing (r3 R3-2)
      // the same answer to the same item, sent again (the app gave up on a slow
      // request and the person pressed again): taken once (INSP-R12F r5 #3)
      if (answer.kind !== "ask") {
        const key = answerKey(bot.id, item.id, answer);
        const said = answer;
        // a first that was queued and failed to deliver since (its history says "não enviada") frees the key (r6 D2)
        const history = () => autonomy.ownerPendingById(bot.id, item.id)?.history ?? autonomy.resolvedOwnerPendingOf(bot.id).findLast((each) => each.id === item.id)?.history;
        const claim = answerDedupe.claim(key, (since) => failedSince(history(), said, since));
        if (!claim.ok) return json(res, 200, { ok: true, duplicate: true, message: duplicateAnswerText(claim), resolved: 0 });
        // settled by what this handler answers, when it answers — never by the client going away (r6 D1)
        onAnswered(res, (status) => (status < 300 ? answerDedupe.sent(key) : answerDedupe.release(key)));
      }
      // "Manter" removes nothing: never checked, never refused (INSP-R12F r4). Every other answer is checked on the
      // Mac and carries the state found now — words that authorize no removal ("sim", "pode decidir por mim…") too,
      // with the server saying so to the bot and to the owner (INSP-R13fol R2-1)
      // free text never removes: the owner hears which buttons do (INSP-R13fol R4-2)
      const diskNotice = item.key?.startsWith(DISK_DECISION_KEY_PREFIX) && answer.kind === "text" ? diskTextNotice(answer.text, keyFolders(item.key), (item.options ?? []).map((option) => option.label)) : undefined;
      if (item.key?.startsWith(DISK_DECISION_KEY_PREFIX) && answer.kind !== "ask" && !keepsFolders(answer)) {
        // in turn with a routine's pass: the item read after it, gone if that pass replaced it
        const check = await diskItemTurn(async () => {
          const now = autonomy.ownerPendingById(bot.id, item.id);
          if (now && now.key === item.key) return recheckDiskItem(now, foldersInUse(), await allProcessCwds(), "", answer);
          // settled by the pass before: what that pass did to it, said as it is (INSP-R12F r5 #1)
          const settled = autonomy.resolvedOwnerPendingOf(bot.id).findLast((each) => each.id === item.id && each.key === item.key);
          return goneDiskItem(settled?.resolvedNote);
        });
        if (check.outcome !== "keep") return json(res, 409, { error: diskChangedText(check), code: "disk_item_changed" });
        text = `${text}\n\n${check.line}`;
      }
      // the Decisor's answer: the bot reads that it was not the owner who clicked, and the history keeps it
      if (byDecisor && answer.kind !== "ask") {
        answer = { ...answer, decisor: true };
        text = `${DECISOR_LINE}\n${text}`;
      }
      // a superseded item's words and asks reach its bot saying so: its commands must not run (INSP-R13fol #16)
      if (item.supersededBy) text = `${text}\n\n[Servidor: ${supersededLine(item.supersededBy)}]`;
      // a bot's mixed item whose removal went to the server's item: an answer about those folders authorizes nothing (R5-1)
      if (!item.key && item.diskMoved?.length && answer.kind !== "ask" && answerTouchesMoved(answer.text, item.diskMoved, item.diskMoved)) text = `${text}\n\n${DISK_NOT_AUTHORIZED}`;
      // any bot's item about worktrees, mixed or not: a decision or words asking for a removal there
      // authorizes no worktree removal; a report of what the owner did passes as it is (INSP-R13fol R6-1, R6-2)
      // a routine's item (keyed) too; only the server's own disk item authorizes, by its buttons (INSP-R13int I6)
      else if (!item.key?.startsWith(DISK_DECISION_KEY_PREFIX) && answer.kind !== "ask" && asksBotItemRemoval(answer.text, item)) text = `${text}\n\n${DISK_BOT_ITEM_NOT_AUTHORIZED}`;
      try {
        assertWithinBudget(cfg, DATA_DIR);
      } catch (error) {
        // refused by the spend cap: in the history as not sent too, never silent (INSP-J2 #14)
        const message = error instanceof Error ? error.message : String(error);
        autonomy.recordOwnerPendingAnswer(bot.id, item.id, { ...answer, delivered: false, error: message });
        refreshBotRow(bot.id);
        return json(res, 409, { error: message, code: "spend_cap" });
      }
      // a new decision while the previous one still waits its turn: only the new one
      // reaches the bot — the old one leaves the queue, said so in the history (INSP-J2 r5 B1)
      if (answer.kind === "option") replaceQueuedChoice(bot.id, item);
      // with a channel named by the owner, the answer wakes the bot there,
      // saying which item and conversation it is about — the bot's reply
      // reaches the owner where they read (R10-followup #1)
      const target = ownerTurnThread(bot.id, item.threadId);
      if (target !== item.threadId) {
        const notThere = cloudGuestSendRefusal(auth, target);
        if (notThere) return json(res, 403, { error: notThere });
        text = routedReplyText(text, item, store.taskByThread(bot.id, item.threadId)?.title ?? item.threadId.slice(0, 8));
      }
      if (body.ask === "steps" || body.ask === "recommend") {
        // the person's words in the conversation; the tool call the bot must
        // make rides only in its prompt, as a note — never as the person's
        // speech (INSP-I r1 #6). Queued, then drained: it runs now when the
        // conversation is free, or after the running turn.
        const note = body.ask === "recommend" ? ownerPendingRecommendNote(item) : ownerPendingStepsRequestNote(item);
        const prompt = promptWithReply(`${text}\n\n${note}`, undefined, cfg.profile?.name?.trim() || "User");
        let asked: ReturnType<typeof queueSteeredMessage>;
        try {
          asked = queueSteeredMessage(bot.id, target, text, { prompt, sender: messageSender(auth), trigger: usageTriggerFor(auth) });
        } catch (error) {
          return ownerAnswerFailed(bot.id, item.id, answer, error);
        }
        // in the queue, not yet with the bot: "na fila" until its turn starts (INSP-J2 r2 N9)
        autonomy.recordOwnerPendingAnswer(bot.id, item.id, { ...answer, delivered: false, queued: true, queueId: asked.id });
        if (body.ask === "recommend") autonomy.markOwnerPendingRecommendRequested(bot.id, item.id);
        else autonomy.markOwnerPendingStepsRequested(bot.id, item.id);
        refreshBotRow(bot.id);
        drainQueuedSends();
        return json(res, 202, { ok: true, threadId: target, resolved: 0, ...(diskNotice ? { notice: diskNotice } : {}) });
      }
      if (!resolve) {
        // the item stays open and waits on the bot: what the bot must do next rides in
        // its prompt as a note, never in the person's words (INSP-J2 #3). Queued, then
        // drained: it runs now when the conversation is free, or after the running turn.
        const prompt = promptWithReply(`${text}\n\n${ownerPendingAwaitNote(item)}`, undefined, cfg.profile?.name?.trim() || "User");
        let queued: ReturnType<typeof queueSteeredMessage>;
        try {
          queued = queueSteeredMessage(bot.id, target, text, { prompt, sender: messageSender(auth), trigger: usageTriggerFor(auth) });
        } catch (error) {
          return ownerAnswerFailed(bot.id, item.id, answer, error);
        }
        autonomy.recordOwnerPendingAnswer(bot.id, item.id, { ...answer, delivered: false, queued: true, queueId: queued.id });
        refreshBotRow(bot.id);
        drainQueuedSends();
        return json(res, 202, { ok: true, queued: true, queueId: queued.id, threadId: target, text, resolved: 0, ...(diskNotice ? { notice: diskNotice } : {}) });
      }
      let receipt: Awaited<ReturnType<typeof startOrQueueDirectMessage>>;
      try {
        receipt = await startOrQueueDirectMessage(bot.id, target, text, undefined, undefined, messageSender(auth), usageTriggerFor(auth));
      } catch (error) {
        // never a silent failure: kept in the history as not delivered, and said on the screen (J18)
        return ownerAnswerFailed(bot.id, item.id, answer, error);
      }
      autonomy.recordOwnerPendingAnswer(bot.id, item.id, "queueId" in receipt && receipt.queued ? { ...answer, delivered: false, queued: true, queueId: receipt.queueId } : { ...answer, delivered: true });
      const done = resolve ? autonomy.resolveOwnerPending({ botId: bot.id, id: item.id, by: "owner", ...(byDecisor ? { note: `${DECISOR_NOTE_PREFIX} decidido pelo Decisor («${answer.label ?? "resposta"}»)` } : {}) }) : [];
      refreshBotRow(bot.id);
      // the text rides along: a queued answer is shown queued in the conversation
      return json(res, 202, { ...receipt, text, resolved: done.length, ...(diskNotice ? { notice: diskNotice } : {}) });

      function ownerAnswerFailed(botId: string, id: string, what: typeof answer, error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        autonomy.recordOwnerPendingAnswer(botId, id, { ...what, delivered: false, error: message });
        refreshBotRow(botId);
        console.error(`[owner-pending] the person's answer to ${id} did not reach ${store.bot(botId)?.name ?? botId}: ${message}`);
        return json(res, 502, { error: `A resposta não chegou ao ${store.bot(botId)?.name ?? "bot"}: ${message}. Ela ficou no histórico do item como não enviada; tente de novo.`, code: "not_delivered" });
      }
    }
    return PASS;
  };
}
