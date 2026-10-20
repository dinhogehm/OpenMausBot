// wake_me / set_goal from a bot's own turn: wakes, watches, standing orders and goals.
import { STANDING_DEFAULT_LABEL, STANDING_MAX_PER_THREAD, chipText, goalEndChip, goalStartedAck, parseGoalEndInput, parseGoalInput, parsePromiseInput, parseStandingLabel, parseWakeInput, parseWatchInput, wakeChip, watchLabel } from "../bot-autonomy.ts";
import { augmentedPath } from "../env-path.ts";
import { parseWatchCommand, runWatchCommand, watchCommandWarnings, watchIgnoreWarnings, watchMatches } from "../wake-watch.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

/** Built per request, inside the internal capability gate. */
export function createInternalWakeGoalRoutes(deps: {
  store: import("../store.ts").Store;
  autonomy: import("../bot-autonomy.ts").BotAutonomy;
  broadcast: (payload: Record<string, unknown>, options?: { adminOnly?: boolean }) => void;
  intakeLock: import("../intake-lock.ts").IntakeLock;
  watchCwd: (botId: string, threadId: string) => string;
  wireBot: (bot: import("../store.ts").BotRecord) => import("../../shared/wire.ts").WireBot;
  internalSender: NonNullable<ReturnType<import("../store.ts").Store["bot"]>>;
  internalCapability: { threadId: string; botId: string };
  readInternalBody: () => ReturnType<RouteContext["readBody"]>;
  requireActiveInternalCapability: () => void;
}): RouteHandler {
  const { store, autonomy, broadcast, intakeLock, watchCwd, wireBot, internalSender, internalCapability, readInternalBody, requireActiveInternalCapability } = deps;
  return async ({ res, path, method, json }) => {
    if (!(method === "POST" && (path === "/api/internal/wake" || path === "/api/internal/goal"))) return PASS;
    const body = await readInternalBody();
    const bot = internalSender;
    const threadId = internalCapability.threadId;
    // Tool results here are read by the bot and often relayed to people:
    // in the owner's language (pt-BR), like the bots answer.
    if (store.groupByThread(threadId)) {
      return json(res, 400, { error: "não disponível em salas (not available in rooms) — salas têm as próprias execuções /goal" });
    }
    if (!store.taskByThread(bot.id, threadId)) return json(res, 404, { error: "esta conversa não existe mais" });
    requireActiveInternalCapability();
    if (path === "/api/internal/wake") {
      if (body.cancel === true && body.standing === true) {
        const label = parseStandingLabel(body.label);
        if (label === null) return json(res, 400, { error: "label inválido: 1 a 40 letras, dígitos, espaços ou . _ # : -" });
        const cancelled = autonomy.cancelStanding(threadId, label);
        intakeLock.dropWaits(threadId);
        if (cancelled) store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `Vigia permanente${cancelled.watch?.label ? ` "${cancelled.watch.label}"` : ""} desligado — ${watchLabel(cancelled.watch!.command)}`, ok: false } });
        const others = autonomy.standingsFor(threadId).map((wake) => wake.watch?.label ?? "default");
        return json(res, 200, { message: `${cancelled ? `Vigia permanente "${label}" desligado.` : `Não havia vigia permanente "${label}" nesta conversa.`}${others.length ? ` Continuam armados: ${others.join(", ")}.` : ""}` });
      }
      if (body.updateReason === true) {
        const label = parseStandingLabel(body.label);
        if (label === null) return json(res, 400, { error: "label inválido: 1 a 40 letras, dígitos, espaços ou . _ # : -" });
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!reason) return json(res, 400, { error: "reason é obrigatório: o que fazer quando ele disparar, agora" });
        const updated = autonomy.updateStandingReason(threadId, label, reason);
        if (!updated) return json(res, 404, { error: `não há vigia permanente "${label}" nesta conversa` });
        store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Motivo do vigia "${label}" atualizado — ${updated.reason}`, 240), ok: true } });
        return json(res, 200, { message: `Motivo do vigia permanente "${label}" atualizado; ele continua armado com a mesma base.` });
      }
      if (body.cancel === true) {
        const cancelled = autonomy.cancelWake(threadId);
        intakeLock.dropWaits(threadId);
        return json(res, 200, { message: cancelled ? `${cancelled.watch ? "Vigia" : "Despertador"} cancelado.` : "Não havia despertador nem vigia pendente nesta conversa." });
      }
      if (body.command !== undefined) {
        const command = parseWatchCommand(body.command);
        if (!command.ok) return json(res, 400, { error: command.error });
        const input = parseWatchInput(body);
        if (!input.ok) return json(res, 400, { error: input.error });
        // one watch per command per bot: two conversations watching the
        // same thing wake twice and answer twice
        const elsewhere = autonomy.sameWatchElsewhere(bot.id, threadId, String(body.command));
        const movedFrom: string[] = [];
        if (elsewhere.length && body.move === true) {
          // move it here: the watch in the other conversation is switched off
          for (const wake of elsewhere) {
            const removed = wake.watch?.standing ? autonomy.cancelStanding(wake.threadId, wake.watch.label ?? STANDING_DEFAULT_LABEL) : autonomy.cancelWake(wake.threadId);
            if (!removed) continue;
            const title = store.taskByThread(bot.id, wake.threadId)?.title ?? wake.threadId;
            movedFrom.push(`"${title}"`);
            store.appendMessage(wake.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Vigia ${watchLabel(wake.watch!.command)} movido para "${store.taskByThread(bot.id, threadId)?.title ?? threadId}"`, 200), ok: true } });
          }
        } else if (elsewhere.length) {
          const where = [...new Set(elsewhere.map((wake) => `"${store.taskByThread(bot.id, wake.threadId)?.title ?? wake.threadId}" (${wake.threadId})`))].join(", ");
          return json(res, 409, { error: `você já tem um vigia com este mesmo comando em outra conversa: ${where}. Não armei outro. Para trazê-lo para esta conversa, chame wake_when de novo com move: true (o de lá é desligado); ou acompanhe por lá.` });
        }
        const warnings = [...watchCommandWarnings(String(body.command)), ...watchIgnoreWarnings(input.ignore, String(body.command))];
        if (input.standing) {
          const armed = autonomy.standingsFor(threadId);
          const label = input.label ?? STANDING_DEFAULT_LABEL;
          if (!armed.some((wake) => (wake.watch?.label ?? STANDING_DEFAULT_LABEL) === label) && armed.length >= STANDING_MAX_PER_THREAD) {
            return json(res, 409, { error: `esta conversa já tem ${STANDING_MAX_PER_THREAD} vigias permanentes (${armed.map((wake) => wake.watch?.label ?? STANDING_DEFAULT_LABEL).join(", ")}); desligue um com cancel e label antes de armar outro` });
          }
        }
        // The first run proves the command works and becomes the baseline.
        const first = await runWatchCommand(command.argv, { cwd: watchCwd(bot.id, threadId), path: augmentedPath(), ignore: input.ignore });
        requireActiveInternalCapability();
        if (!first.ok) return json(res, 400, { error: `o comando falhou na primeira execução — corrija antes de vigiar:\n${first.output.slice(0, 1_500)}` });
        if (!input.standing && watchMatches(first.output, input.until)) {
          return json(res, 200, { message: `Já é verdade — a saída casa com "${input.until}" agora, então não há o que esperar. Saída:\n${first.output.slice(0, 1_500)}` });
        }
        const wake = autonomy.setWatch(bot.id, threadId, { ...input, command: String(body.command).trim(), argv: command.argv, baseline: first.output, baselineFingerprint: first.fingerprint });
        store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: wakeChip(wake), ok: true } });
        return json(res, 200, {
          message: input.standing
            ? `${movedFrom.length ? `Movido de ${movedFrom.join(", ")} (lá ficou desligado). ` : ""}${warnings.length ? `Atenção: ${warnings.join(" ")} ` : ""}Vigia permanente armado. O servidor roda o comando a cada ${input.everyMinutes} min, sem modelo, e te acorda aqui toda vez que ${input.until ? `uma saída nova casar com "${input.until}"` : "a saída mudar"} (e a cada ${input.maxMinutes} min de qualquer forma). Ele continua armado depois de disparar — não chame wake_when de novo para ele; wake_me aqui não o substitui. Encerre o turno agora. Saída atual:\n${first.output.slice(0, 1_500)}`
            : `${movedFrom.length ? `Movido de ${movedFrom.join(", ")} (lá ficou desligado). ` : ""}${warnings.length ? `Atenção: ${warnings.join(" ")} ` : ""}Vigiando. O servidor roda o comando a cada ${input.everyMinutes} min, sem modelo, e te acorda aqui quando ${input.until ? `a saída casar com "${input.until}"` : "a saída mudar"}, ou depois de ${input.maxMinutes} min de qualquer forma. Encerre o turno agora. Saída atual:\n${first.output.slice(0, 1_500)}`,
        });
      }
      // Promises with a deadline ride on wake_me, alone or beside a wake.
      const promiseNotes: string[] = [];
      if (typeof body.promiseKept === "string") {
        // a message counts as sent only with the ID the send returned
        const proof = typeof body.promiseProof === "string" ? body.promiseProof.trim().slice(0, 300) : "";
        if (!proof) return json(res, 400, { error: "promise_kept precisa de promise_proof: o ID ou o link da mensagem enviada (o que o comando de envio devolveu). Sem ID, a mensagem não conta como enviada." });
        const kept = autonomy.keepPromise(threadId, body.promiseKept.trim());
        if (!kept.length) return json(res, 404, { error: `não há promessa "${body.promiseKept}" aberta nesta conversa${autonomy.promisesFor(threadId).length ? ` (abertas: ${autonomy.promisesFor(threadId).map((open) => `${open.id} "${chipText(open.text, 60)}"`).join(", ")})` : ""}` });
        for (const promise of kept) store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `Promessa cumprida — ${chipText(promise.text, 120)} · mensagem ${chipText(proof, 60)}`, ok: true } });
        promiseNotes.push(`Promessa${kept.length > 1 ? "s" : ""} ${kept.map((promise) => promise.id).join(", ")} marcada${kept.length > 1 ? "s" : ""} como cumprida${kept.length > 1 ? "s" : ""}.`);
      }
      if (body.promise !== undefined) {
        const promiseInput = parsePromiseInput(body);
        if (!promiseInput.ok) return json(res, 400, { error: promiseInput.error });
        const promise = autonomy.addPromise(bot.id, threadId, promiseInput.text, promiseInput.minutes);
        store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `Promessa ${promise.id} — ${chipText(promise.text, 120)} · prazo em ${promiseInput.minutes} min`, ok: true } });
        promiseNotes.push(`Promessa ${promise.id} registrada: prazo em ${promiseInput.minutes} min. Se passar sem você marcar promise_kept "${promise.id}", você e o Chief são avisados.`);
      }
      if (body.minutes === undefined && body.reason === undefined && promiseNotes.length) {
        return json(res, 200, { message: promiseNotes.join(" ") });
      }
      const input = parseWakeInput(body);
      if (!input.ok) return json(res, 400, { error: input.error });
      const wake = autonomy.setWake(bot.id, threadId, input.minutes, input.reason);
      store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: wakeChip(wake), ok: true } });
      return json(res, 200, {
        message: `${promiseNotes.length ? `${promiseNotes.join(" ")} ` : ""}Você recebe um novo turno aqui em ${input.minutes} min, com a sua nota. Encerre o turno agora; não fique consultando enquanto isso.`,
      });
    }
    if (body.action === "start") {
      const input = parseGoalInput(body);
      if (!input.ok) return json(res, 400, { error: input.error });
      // a goal that was still open here is replaced: said, never silent
      const previous = autonomy.goalFor(threadId);
      const replaced = previous && (previous.status === "active" || previous.status === "needs-input") ? previous : null;
      const goal = autonomy.startGoal(bot.id, threadId, input);
      if (replaced) store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Objetivo anterior substituído (estava ${replaced.status === "active" ? "ativo" : "esperando você"}): ${replaced.goal}`, 240), ok: false } });
      store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `Modo objetivo ligado — ${chipText(goal.goal, 140)}`, ok: true } });
      return json(res, 200, { message: `${replaced ? `O objetivo anterior desta conversa ("${chipText(replaced.goal, 160)}") foi substituído por este — se ele ainda vale, diga isso à pessoa. ` : ""}${goalStartedAck(goal)}` });
    }
    if (body.action === "end") {
      const input = parseGoalEndInput(body);
      if (!input.ok) return json(res, 400, { error: input.error });
      // A decision given in another conversation ends the goal that was
      // waiting for it there: one of this bot's own direct conversations.
      let target = threadId;
      if (typeof body.targetThreadId === "string" && body.targetThreadId.trim()) {
        target = body.targetThreadId.trim();
        if (!store.taskByThread(bot.id, target) || store.groupByThread(target)) {
          return json(res, 400, { error: "thread_id precisa ser uma das suas próprias conversas diretas" });
        }
      }
      const goal = autonomy.finishGoal(target, input.status, input.detail);
      if (!goal) return json(res, 409, { error: target === threadId ? "o modo objetivo não está ligado nesta conversa" : "o modo objetivo não está ligado naquela conversa" });
      store.appendMessage(target, { role: "bot", kind: "activity", tool: { name: goalEndChip(goal), ok: goal.status === "completed" } });
      if (target !== threadId) {
        // the sidebar row reads the goal state: refresh it
        const owner = store.bot(bot.id);
        if (owner) broadcast({ kind: "bot", bot: wireBot(owner) });
        return json(res, 200, { message: `Objetivo da outra conversa encerrado (${goal.status}).` });
      }
      return json(res, 200, {
        message: goal.status === "needs-input"
          ? "Objetivo pausado até a pessoa responder; a próxima mensagem dela o retoma. Faça a sua pergunta na resposta."
          : "Modo objetivo encerrado. Relate o resultado na sua resposta.",
      });
    }
    return json(res, 400, { error: "action deve ser start ou end" });
  };
}
