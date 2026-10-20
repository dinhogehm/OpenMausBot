// "Precisa de você": the person settles, reminds or answers a bot's open item.
import type { BotAutonomy, OwnerPending } from "../bot-autonomy.ts";
import { chipText, ownerPendingAwaitNote, ownerPendingRecommendNote, ownerPendingRecommendText, ownerPendingReplyText, ownerPendingStepsRequestNote, ownerPendingStepsRequestText, ownerPendingVisible } from "../bot-autonomy.ts";
import type { loadConfig } from "../config.ts";
import { DATA_DIR } from "../config.ts";
import { APP_FLAPPING_CHECK_LABEL, APP_UNBLOCK_CHECK_LABEL, APP_UNBLOCK_DECLINE_LABEL, APP_UNBLOCK_DECLINE_MS, appStillBlockedText, staleUnblockItem, type FolderFlapState } from "../owner-chips.ts";
import { routedReplyText } from "../owner-channel.ts";
import { pluggedInRefusal, POWER_PENDING_KEY, POWER_PLUGGED_LABEL, type PowerState } from "../power.ts";
import { promptWithReply } from "../replies.ts";
import type { RequestAuth } from "../request-auth.ts";
import { assertWithinBudget } from "../spend.ts";
import { queueSteeredMessage } from "../steer-queue.ts";
import type { Store } from "../store.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import type { ResolvedSender } from "../../shared/wire.ts";
import { PASS, type RouteHandler } from "./table.ts";

type FolderBlock = Parameters<typeof appStillBlockedText>[0] & { seen?: NonNullable<Parameters<typeof staleUnblockItem>[3]> };

export interface OwnerPendingRouteDeps<B extends FolderBlock> {
  store: Store;
  autonomy: BotAutonomy;
  cfg: ReturnType<typeof loadConfig>;
  appUnblockKey: string;
  appFolderBlock(): B | null;
  appFolderFlaps: { set(state: FolderFlapState): void };
  ownerDeclines: { set(key: string, until: number): void };
  cloudGuestSendRefusal(auth: RequestAuth, threadId: string): string | null;
  drainQueuedSends(): void;
  messageSender(auth: RequestAuth): ResolvedSender | undefined;
  ownerTurnThread(botId: string, from: string): string;
  readPowerNow(): Promise<PowerState | null>;
  refreshBotRow(botId: string): void;
  replaceQueuedChoice(botId: string, item: OwnerPending): void;
  startOrQueueDirectMessage(botId: string, threadId: string, text: string, replyTo: undefined, sendId: undefined, sender: ResolvedSender | undefined, trigger: UsageTrigger): Promise<object>;
  usageTriggerFor(auth: RequestAuth): UsageTrigger;
}

export function createOwnerPendingRoutes<B extends FolderBlock>(deps: OwnerPendingRouteDeps<B>): RouteHandler {
  const { store, autonomy, cfg, appUnblockKey: APP_UNBLOCK_KEY, appFolderBlock, appFolderFlaps, ownerDeclines, cloudGuestSendRefusal, drainQueuedSends, messageSender, ownerTurnThread, readPowerNow, refreshBotRow, replaceQueuedChoice, startOrQueueDirectMessage, usageTriggerFor } = deps;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/bots/") || !path.includes("/owner-pending")) return PASS;
    let m: RegExpMatchArray | null;
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
      let answer: { kind: "option" | "text" | "ask"; label?: string; text: string };
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
            const want = staleUnblockItem(item, name, block.kind, block.kind === "flapping" ? block.seen : []);
            if (want) {
              autonomy.addOwnerPending(bot.id, item.threadId, { ...want, key: item.key });
              refreshBotRow(bot.id);
            }
            // the flip: the diagnosis itself, not only "it changed"
            const diagnosis = block.kind === "flapping" ? `\n\n${(want ?? staleUnblockItem({}, name, "flapping", block.seen))?.why ?? ""}` : "";
            return json(res, 409, { error: `${appStillBlockedText(block, name)}${diagnosis}`, code: "app_still_blocked" });
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
        resolve = body.resolve === true;
        text = ownerPendingReplyText(item, reply.slice(0, 4_000), resolve);
        answer = { kind: "text", text: reply };
      }
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
        return json(res, 202, { ok: true, threadId: target, resolved: 0 });
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
        return json(res, 202, { ok: true, queued: true, queueId: queued.id, threadId: target, text, resolved: 0 });
      }
      let receipt: Awaited<ReturnType<typeof startOrQueueDirectMessage>>;
      try {
        receipt = await startOrQueueDirectMessage(bot.id, target, text, undefined, undefined, messageSender(auth), usageTriggerFor(auth));
      } catch (error) {
        // never a silent failure: kept in the history as not delivered, and said on the screen (J18)
        return ownerAnswerFailed(bot.id, item.id, answer, error);
      }
      const sent = receipt as { queued?: boolean; queueId?: string };
      autonomy.recordOwnerPendingAnswer(bot.id, item.id, "queueId" in sent && sent.queued ? { ...answer, delivered: false, queued: true, queueId: sent.queueId! } : { ...answer, delivered: true });
      const done = resolve ? autonomy.resolveOwnerPending({ botId: bot.id, id: item.id, by: "owner" }) : [];
      refreshBotRow(bot.id);
      // the text rides along: a queued answer is shown queued in the conversation
      return json(res, 202, { ...receipt, text, resolved: done.length });

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
