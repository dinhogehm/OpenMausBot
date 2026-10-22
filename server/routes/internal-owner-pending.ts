// owner_pending from a bot's own turn: it adds, rewrites, resolves or lists what waits on the person.
import { ANSWERED_IN_CONVERSATION, parseOwnerPendingDetails, parseReplacesAsk, practicalMissing, type AskPromotion, type BotAutonomy, type OwnerPending, type OwnerPendingOption, type OwnerPendingStep } from "../bot-autonomy.ts";
import { DISK_DECISION_KEY_PREFIX } from "../disk-decision.ts";
import { fixedRowWarning } from "../owner-pending-guard.ts";
import type { Store } from "../store.ts";
import { isMentionOnly } from "../../shared/owner-pending-title.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const MENTION_ONLY_TITLE = "title só com menção (\"@Chief of Staff\") não diz o que fazer: comece pelo verbo, com o essencial (\"Aprovar o merge da PR #12\"). Quem pediu a pessoa já vê.";

/** Built per request, inside the internal capability gate. */
export function createInternalOwnerPendingRoutes(deps: {
  store: Store;
  autonomy: BotAutonomy;
  refreshBotRow(botId: string): void;
  questionAnswer(promotion: AskPromotion): { at: number; text: string } | null;
  markSuperseded(bot: { id: string; name: string }, item: OwnerPending): string[];
  serverDiskItem(
    bot: { id: string; name: string }, threadId: string,
    input: { title: string; why?: string; command?: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[] },
    replacing?: OwnerPending,
  ): Promise<{ message: string; opened?: OwnerPending } | null>;
  mixedRemovalBeside(
    bot: { id: string; name: string }, threadId: string,
    input: { title: string; command?: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[] },
  ): Promise<{ steps: OwnerPendingStep[]; options?: OwnerPendingOption[]; moved?: string[]; message: string } | null>;
  internalSender: NonNullable<ReturnType<Store["bot"]>>;
  internalCapability: { threadId: string };
  readInternalBody(): ReturnType<RouteContext["readBody"]>;
  requireActiveInternalCapability(): void;
}): RouteHandler {
  const { store, autonomy, refreshBotRow, questionAnswer, markSuperseded, serverDiskItem, mixedRemovalBeside, internalSender, internalCapability, readInternalBody, requireActiveInternalCapability } = deps;
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== "/api/internal/owner-pending") return PASS;
    const body = await readInternalBody();
    const bot = internalSender;
    const threadId = internalCapability.threadId;
    if (store.groupByThread(threadId)) return json(res, 400, { error: "não disponível em salas" });
    if (!store.taskByThread(bot.id, threadId)) return json(res, 404, { error: "esta conversa não existe mais" });
    requireActiveInternalCapability();
    // the person's last answer, when the item waits on the bot (J18)
    const answered = (item: OwnerPending) => {
      const last = item.awaitingSince ? item.history?.findLast((each) => each.delivered) : undefined;
      return last ? ` [o dono respondeu: ${last.kind === "option" ? `escolheu "${last.label}"` : last.kind === "ask" ? (last.label === "recommend" ? "pediu a sua recomendação" : "pediu o passo a passo") : `"${last.text.slice(0, 80)}"`} — resolva ou atualize]` : "";
    };
    const line = (item: OwnerPending) => `${item.id}: ${item.title}${item.due ? ` (até ${item.due})` : ""}${item.link ? ` — ${item.link}` : ""}${answered(item)}`;
    // how practical the item reads to the person: steps and decisions, or a nudge to add them
    const practical = (item: OwnerPending) => [
      item.steps?.length ? `${item.steps.length} passo${item.steps.length === 1 ? "" : "s"}` : "",
      item.options?.length ? `decisões: ${item.options.map((option) => option.label).join(" / ")}` : "",
    ].filter(Boolean).join("; ");
    const details = parseOwnerPendingDetails({ why: body.why, steps: body.steps, options: body.options });
    if (!details.ok && (body.action === "add" || body.action === "update")) return json(res, 400, { error: details.error });
    const structured = details.ok ? { ...(details.why !== undefined ? { why: details.why } : {}), ...(details.steps !== undefined ? { steps: details.steps } : {}), ...(details.options !== undefined ? { options: details.options } : {}) } : {};
    if (body.action === "add") {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) return json(res, 400, { error: "title é obrigatório: o que a pessoa precisa fazer ou decidir" });
      if (isMentionOnly(title, store.bots.map((each) => each.name))) return json(res, 400, { error: MENTION_ONLY_TITLE });
      // born practical: why and steps, or refused with what is missing (J17)
      const incomplete = practicalMissing(structured);
      if (incomplete) return json(res, 400, { error: incomplete });
      // the one link that lets an item take a bare question's place: the Ref of the server's request (INSP-J2b #1)
      const replaces = body.replacesAsk === undefined ? null : parseReplacesAsk(body.replacesAsk);
      if (body.replacesAsk !== undefined && !replaces) return json(res, 400, { error: "replacesAsk deve ser o Ref do pedido do servidor, no formato <conversa>@<número> (ex.: 9f3c…@1791066754187)." });
      const promotion = replaces ? autonomy.askPromotionFor(bot.id, replaces.threadId, replaces.askAt) : null;
      if (replaces && !promotion) return json(res, 400, { error: `replacesAsk ${replaces.threadId}@${replaces.askAt} não é de nenhum pedido do servidor a você. Copie o Ref exato do pedido "[Servidor: pergunta sem passo a passo]", ou abra o item sem replacesAsk.` });
      // reopening what the server settled as "respondida na conversa" is the bot's call (INSP-J2b r3): allowed
      // the linked item itself (bot, id, conversation, birth), never another that had its id (R12-followup #3)
      const reopening = Boolean(promotion && autonomy.askPromotionResolvedItem(promotion)?.resolvedNote === ANSWERED_IN_CONVERSATION);
      if (promotion && !reopening && questionAnswer(promotion)) {
        return json(res, 200, { message: "A pessoa já respondeu essa pergunta na conversa: não abri o item. Siga com a resposta dela." });
      }
      // removing worktrees is the server's disk item, checked on the Mac, whoever opens it — a promoted
      // question too ("Quer que eu remova as worktrees X e Y?"), linked to the server's item (R13-followup #2, INSP-R13fol #6)
      const disk = await serverDiskItem(bot, threadId, { title, ...(typeof body.command === "string" ? { command: body.command } : {}), ...structured });
      if (disk) {
        if (promotion && disk.opened) {
          autonomy.linkAskPromotion(promotion, disk.opened);
          refreshBotRow(bot.id);
        }
        return json(res, 200, { message: `${disk.message}${promotion && disk.opened ? ` Ele substitui a sua pergunta em "Precisa de você".` : ""}` });
      }
      // a mixed item (push, rm -rf… and `worktree remove`): its removal part goes to the server's item beside it,
      // its own removal commands leave it (INSP-R13fol R2-3)
      const beside = await mixedRemovalBeside(bot, threadId, { title, ...structured });
      const own = beside ? { ...structured, steps: beside.steps, ...(beside.options ? { options: beside.options } : {}) } : structured;
      const item = autonomy.addOwnerPending(bot.id, threadId, { title, ...(typeof body.due === "string" ? { due: body.due } : {}), ...(typeof body.link === "string" ? { link: body.link } : {}), ...own });
      // the folders taken to the server: an answer naming them authorizes nothing (R5-1)
      if (beside?.moved?.length) autonomy.patchOwnerPending(bot.id, item.id, { diskMoved: beside.moved });
      if (promotion) {
        autonomy.linkAskPromotion(promotion, item);
        refreshBotRow(bot.id);
      }
      const replaced = promotion ? ` Ele substitui a sua pergunta em "Precisa de você".` : "";
      if (item.duplicate) {
        // one action, one item: the person never sees the same ask twice (R9-followup #3)
        return json(res, 200, { message: `Já existe em "Precisa de você" um item para isso: ${line(item)}${item.threadId === threadId ? "" : ` [conversa ${item.threadId}]`}. Não abri outro.${replaced} Cite ${item.id} ao falar com o dono; se o pedido mudou, use owner_pending update id ${item.id} (ou resolva ${item.id} e abra o novo).` });
      }
      refreshBotRow(bot.id);
      const shape = practical(item);
      const superseding = markSuperseded(bot, item);
      const marked = superseding.length ? ` Marquei como superado, com decisões e comandos desligados: ${superseding.join(", ")}.` : "";
      return json(res, 200, { message: `Em "Precisa de você": ${line(item)}${shape ? ` (${shape})` : ""}.${replaced}${marked}${beside ? ` ${beside.message}` : ""} Resolva com owner_pending resolve id ${item.id} quando estiver decidido.` });
    }
    if (body.action === "update") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return json(res, 400, { error: "id é obrigatório: o item que você reescreve (veja owner_pending list)" });
      const patch = { ...(typeof body.title === "string" ? { title: body.title } : {}), ...(typeof body.due === "string" ? { due: body.due } : {}), ...(typeof body.link === "string" ? { link: body.link } : {}), ...structured };
      if (!Object.keys(patch).length) return json(res, 400, { error: "nada para atualizar: mande title, due, link, why, steps ou options" });
      if (patch.title !== undefined && !patch.title.trim()) return json(res, 400, { error: "title não pode ficar vazio" });
      if (patch.title !== undefined && isMentionOnly(patch.title, store.bots.map((each) => each.name))) return json(res, 400, { error: MENTION_ONLY_TITLE });
      // the item as it would be: still why and steps (an older one gets them now) (J17)
      const current = autonomy.ownerPendingById(bot.id, id);
      if (!current) return json(res, 404, { error: `nenhum item ${id} seu; chame owner_pending list` });
      const incomplete = practicalMissing({ why: structured.why ?? current.why, steps: structured.steps ?? current.steps, options: structured.options ?? current.options });
      if (incomplete) return json(res, 400, { error: incomplete });
      // the server's disk item is not rewritten by a bot; a bot's item that turns out to be about removing worktrees becomes it (R13-followup #2)
      if (current.key?.startsWith(DISK_DECISION_KEY_PREFIX)) {
        if (patch.title !== undefined || structured.why !== undefined || structured.steps !== undefined || structured.options !== undefined) {
          return json(res, 200, { message: `O ${current.id} é o item de disco do servidor, conferido no Mac: não o reescrevi. Ele é reconferido a cada passada da rotina de disco e na resposta do dono.` });
        }
      } else if (!current.key) {
        const disk = await serverDiskItem(bot, current.threadId, { title: patch.title ?? current.title, why: structured.why ?? current.why, ...(current.command ? { command: current.command } : {}), steps: structured.steps ?? current.steps, options: structured.options ?? current.options }, current);
        if (disk) return json(res, 200, { message: disk.message });
      }
      // the removal part of a mixed item: beside it, its commands out of it (INSP-R13fol R2-3)
      const beside = current.key ? null : await mixedRemovalBeside(bot, current.threadId, { title: patch.title ?? current.title, ...(current.command ? { command: current.command } : {}), steps: structured.steps ?? current.steps, options: structured.options ?? current.options });
      const item = autonomy.updateOwnerPending(bot.id, id, beside ? { ...patch, steps: beside.steps, ...(beside.options ? { options: beside.options } : {}) } : patch);
      if (!item) return json(res, 404, { error: `nenhum item ${id} seu; chame owner_pending list` });
      if (beside?.moved?.length) autonomy.patchOwnerPending(bot.id, id, { diskMoved: [...new Set([...(item.diskMoved ?? []), ...beside.moved])] });
      refreshBotRow(bot.id);
      const shape = practical(item);
      const superseding = markSuperseded(bot, item);
      const marked = superseding.length ? ` Marquei como superado, com decisões e comandos desligados: ${superseding.join(", ")}.` : "";
      return json(res, 200, { message: `Atualizado em "Precisa de você": ${line(item)}${shape ? ` (${shape})` : ""}.${marked}${beside ? ` ${beside.message}` : ""}` });
    }
    if (body.action === "resolve") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return json(res, 400, { error: "id é obrigatório (ou \"all\" para os desta conversa)" });
      const done = autonomy.resolveOwnerPending({ botId: bot.id, threadId, id, by: "bot" });
      if (!done.length) return json(res, 404, { error: `nenhum item ${id}; chame owner_pending list` });
      refreshBotRow(bot.id);
      return json(res, 200, { message: `Resolvido: ${done.map(line).join("; ")}` });
    }
    if (body.action === "list") {
      const open = autonomy.ownerPendingOf(bot.id);
      const state = (item: OwnerPending) => `${item.stepsRequestedAt ? " (a pessoa pediu o passo a passo: owner_pending update)" : item.steps?.length ? "" : " (sem passos)"}${item.recommendRequestedAt ? " (a pessoa pediu a sua recomendação: owner_pending update com recommended e why)" : (item.options?.length ?? 0) >= 2 && !item.options!.some((option) => option.recommended) ? " (sem recomendada)" : ""}${item.supersededBy ? ` (SUPERADO pelo ${item.supersededBy.id} do ${item.supersededBy.botName}: resolva ou reescreva os comandos)` : ""}${fixedRowWarning(item, Date.now()) ? ` (${fixedRowWarning(item, Date.now())} Para linha nova, use append, não número fixo.)` : ""}`;
      return json(res, 200, { message: open.length ? open.map((item) => `${line(item)}${state(item)}${item.threadId === threadId ? "" : ` [conversa ${item.threadId}]`}`).join("\n") : "Nada esperando a pessoa." });
    }
    return json(res, 400, { error: "action deve ser add, update, resolve ou list" });
  };
}
