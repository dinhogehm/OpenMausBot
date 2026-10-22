// cc_session from a bot's own turn: starts, steers, lists and stops its Claude Code sessions.
import { chipText } from "../bot-autonomy.ts";
import { CC_APP_FULL_REFUSAL, CC_MAX_RUNNING, ccProcAlive, ccSessionLine, corridorForSend, hotfixWithReleaseScripts, repoCorridor, repoPackageManager, repoScripts, resumeLine, useRepoScripts } from "../cc-sessions.ts";
import { queueListing } from "../cc-start-queue.ts";
import { readDesktopRecord, recordBlocked, transcriptPath, transcriptTurnEnded } from "../claude-desktop.ts";
import { ccSessionActive } from "../desktop-work.ts";
import { sessionChips } from "../owner-chips.ts";
import { archiveBlockers, resumeNeeded } from "../prod-delivery.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

/** Built per request, inside the internal capability gate. */
export function createInternalCcSessionRoutes(deps: {
  store: import("../store.ts").Store;
  fullAccessForSource: (botId: string, threadId: string) => boolean;
  carrierPowerCheck: (text: string) => { refusal: string } | { note: string } | null;
  ccChip: (session: import("../cc-sessions.ts").CcSession, text: string, ok?: boolean) => void;
  ccChipShort: (session: import("../cc-sessions.ts").CcSession, text: string, ok?: boolean, skip?: string | null) => void;
  ccReport: (session: import("../cc-sessions.ts").CcSession, text: string) => void;
  ccLedger: import("../cc-sessions.ts").CcSessionLedger;
  ccProcesses: Map<string, import("node:child_process").ChildProcess>;
  ccSlotFreeForWork: () => boolean;
  ccStartQueue: import("../cc-start-queue.ts").CcStartQueue;
  execCc: (file: string, args: string[], cwd?: string) => Promise<string>;
  noteClaimedPrs: (session: import("../cc-sessions.ts").CcSession, text: string) => void;
  openThreadOf: (botId: string, threadId: string | null | undefined) => boolean;
  releaseHold: { label: string | null; at: number; running: boolean };
  reportArchivedWorktrees: (session: import("../cc-sessions.ts").CcSession, includeOwn: boolean) => Promise<void>;
  resumeOf: (session: import("../cc-sessions.ts").CcSession, now?: number) => ReturnType<typeof import("../prod-delivery.ts").resumeNeeded>;
  runCcTurn: (session: import("../cc-sessions.ts").CcSession, prompt: string, first: boolean) => void;
  startCcSession: (bot: import("../store.ts").BotRecord, threadId: string, replyThreadId: string, body: Record<string, unknown>, fromQueue?: boolean) => import("../cc-start-queue.ts").StartResult;
  internalSender: NonNullable<ReturnType<import("../store.ts").Store["bot"]>>;
  internalCapability: { threadId: string; botId: string };
  readInternalBody: () => ReturnType<RouteContext["readBody"]>;
  requireActiveInternalCapability: () => void;
}): RouteHandler {
  const { store, fullAccessForSource, carrierPowerCheck, ccChip, ccChipShort, ccReport, ccLedger, ccProcesses, ccSlotFreeForWork, ccStartQueue, execCc, noteClaimedPrs, openThreadOf, releaseHold, reportArchivedWorktrees, resumeOf, runCcTurn, startCcSession, internalSender, internalCapability, readInternalBody, requireActiveInternalCapability } = deps;
  return async ({ res, path, method, json }) => {
    if (!(method === "POST" && path === "/api/internal/cc-session")) return PASS;
    const body = await readInternalBody();
    const bot = internalSender;
    const threadId = internalCapability.threadId;
    if (store.groupByThread(threadId)) return json(res, 400, { error: "gerencie sessões do Claude Code de uma conversa direta, não de uma sala" });
    requireActiveInternalCapability();
    const action = String(body.action ?? "");
    // Reports go back to the thread the order came from (see send); a
    // second conversation of this bot may be named to get them too.
    let replyThreadId = threadId;
    if (typeof body.replyThreadId === "string" && body.replyThreadId.trim()) {
      replyThreadId = body.replyThreadId.trim();
      if (!store.taskByThread(bot.id, replyThreadId) || store.groupByThread(replyThreadId)) {
        return json(res, 400, { error: "reply_thread_id precisa ser uma das suas próprias conversas diretas" });
      }
    }
    if (action === "list") {
      const sessions = ccLedger.owned(bot.id, body.includeArchived === true);
      const detail = typeof body.sessionId === "string" ? ccLedger.get(body.sessionId) : null;
      if (detail && detail.ownerBotId !== bot.id) return json(res, 404, { error: "você não tem essa sessão" });
      const now = Date.now();
      // the Chief sees every bot's session to resume: the line waits on them (S-retomar)
      const othersToResume = bot.chiefOfStaff
        ? ccLedger.all().filter((session) => session.ownerBotId !== bot.id).flatMap((session) => {
          const resume = resumeOf(session, now);
          return resume ? [`${session.id} · "${session.title}" · de ${store.bot(session.ownerBotId)?.name ?? session.ownerBotId} · ${resumeLine(session, resume, now).replace(/Retome com cc_session_send \(session_id [^)]+\)/, `Peça a ${store.bot(session.ownerBotId)?.name ?? "o bot dono"} que a retome com cc_session_send`)}`] : [];
        })
        : [];
      return json(res, 200, {
        message: [
          sessions.length ? sessions.map((session) => {
            const record = session.surface === "app" && session.desktop?.localId && session.status !== "archived" ? readDesktopRecord(session.desktop.localId) : null;
            return ccSessionLine(session, { blocked: record ? recordBlocked(record) : null, resume: resumeOf(session, now), now });
          }).join("\n") : "Você não gerencia nenhuma sessão do Claude Code.",
          ...(othersToResume.length ? [`\nSessões de outros bots para RETOMAR (seguram PRs):\n${othersToResume.join("\n")}`] : []),
          // the ones a live release holds back: said, so nobody resumes them by hand meanwhile (INSP-S r1 S-1)
          ...(releaseHold.label && (bot.chiefOfStaff ? ccLedger.all() : sessions).some((session) => resumeNeeded(session, now) !== null)
            ? [`\nNenhuma sessão é retomada agora: ${releaseHold.label === "?" ? "o estado do release de produção não pôde ser lido" : releaseHold.label}. Uma sessão retomada agora rodaria o ci:local contra ele; o aviso de RETOMAR volta quando ele terminar.`]
            : []),
          // the slots are shared: everyone sees the whole queue, the Chief with whose each item is
          ...(ccStartQueue.ordered().length ? [queueListing(ccStartQueue, { id: bot.id, chief: Boolean(bot.chiefOfStaff) }, (botId) => store.bot(botId)?.name ?? botId, CC_MAX_RUNNING)] : []),
          ...(detail ? [`\nÚltimo relatório de ${detail.id}:\n${detail.lastReport ?? "(nenhum ainda)"}${detail.lastError ? `\nÚltimo problema: ${detail.lastError}` : ""}`] : []),
        ].join("\n"),
      });
    }
    if (action === "start") {
      const started = startCcSession(bot, threadId, replyThreadId, body);
      return json(res, started.status, started.body);
    }
    // A start still in the queue has no session yet: archive (or stop)
    // with its queue id takes it out of the queue.
    if ((action === "archive" || action === "stop") && typeof body.sessionId === "string") {
      const dropped = ccStartQueue.remove(bot.id, body.sessionId.trim());
      if (dropped) {
        if (openThreadOf(bot.id, dropped.threadId)) store.appendMessage(dropped.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Fila de sessões: "${dropped.title}" saiu da fila (cancelado)`, 240), ok: true } });
        return json(res, 200, { message: `"${dropped.title}" saiu da fila de sessões; não vai abrir.` });
      }
      const others = ccStartQueue.ordered().find((item) => item.id === body.sessionId.trim());
      if (others) return json(res, 403, { error: `esse start da fila é de ${store.bot(others.botId)?.name ?? others.botId}; só o bot que o enfileirou pode tirá-lo` });
    }
    const session = typeof body.sessionId === "string" ? ccLedger.get(body.sessionId) : null;
    if (!session || session.ownerBotId !== bot.id) return json(res, 404, { error: "você não tem essa sessão — chame cc_session_list" });
    if (action === "send") {
      if (session.surface === "app" && fullAccessForSource(bot.id, threadId)) return json(res, 409, { error: CC_APP_FULL_REFUSAL });
      const scripts = useRepoScripts(typeof body.message === "string" ? body.message.trim().slice(0, 20_000) : "", repoPackageManager(session.repo), repoScripts(session.repo));
      if (!scripts.text) return json(res, 400, { error: "message é obrigatório" });
      if (session.status === "archived") return json(res, 409, { error: "essa sessão está arquivada; comece outra" });
      // A send that merges or publishes carries the repository's
      // corridor once (sessions started before it, or since it changed).
      const sendCorridor = repoCorridor(session.repo);
      const onBattery = carrierPowerCheck(scripts.text);
      if (onBattery && "refusal" in onBattery) return json(res, 409, { error: onBattery.refusal });
      const corridored = corridorForSend(session, sendCorridor, scripts.text);
      const sendWarning = sendCorridor ? hotfixWithReleaseScripts(scripts.text) : null;
      if (sendWarning) ccChip(session, "a mensagem junta hotfix com script de release — o corredor pede carriers separados", false);
      const message = onBattery ? `${corridored.text}\n\n${onBattery.note}` : corridored.text;
      // The order came from this conversation: its report comes back here.
      // Only once the order is accepted — a refused one moves nothing.
      const claim = () => {
        if (corridored.version) {
          session.corridorVersion = corridored.version;
          ccLedger.save();
        }
        noteClaimedPrs(session, scripts.text);
        const moved = threadId !== session.ownerThreadId;
        if (moved) session.ownerThreadId = threadId;
        const reportTo = replyThreadId === session.ownerThreadId ? undefined : replyThreadId;
        if (moved || reportTo !== session.replyThreadId) {
          if (reportTo) session.replyThreadId = reportTo;
          else delete session.replyThreadId;
          ccLedger.save();
        }
      };
      if (session.surface === "app") {
        const desktop = session.desktop;
        const opening = !desktop?.localId && session.status === "running" && Boolean(desktop?.pending?.kind === "create" || desktop?.sentAt);
        if (!desktop?.localId && !opening) {
          return json(res, 409, { error: "essa sessão nunca abriu no app Claude; comece outra com cc_session_start" });
        }
        // A session that opened lives in the app whatever went wrong here
        // (a screen step, a lost message): it can still take messages.
        if (session.status === "failed" && !desktop?.localId) {
          return json(res, 409, { error: `essa sessão falhou (${(session.lastError ?? "erro desconhecido").slice(0, 300)}); veja no app Claude e depois comece outra com cc_session_start` });
        }
        // one the app opened in a folder that is not its own never takes work (R10-dispatch R10-1b)
        if (desktop?.wrongFolder) {
          return json(res, 409, { error: `essa sessão abriu numa pasta que não é dela (${desktop.wrongFolder}) e parou sem mexer em nada; ela não recebe mensagens. Arquive-a com cc_session_archive e comece outra com cc_session_start quando o app destravar.` });
        }
        if (session.status === "failed") {
          session.status = "idle";
          delete session.lastError;
        }
        if (desktop?.archiveWhenResolved || desktop?.pending?.kind === "archive") return json(res, 409, { error: "essa sessão está sendo arquivada; comece outra" });
        claim();
        if (session.status === "running" || desktop?.pending || desktop?.sent) {
          const position = ccLedger.enqueue(session, message);
          return json(res, 200, { message: `A sessão está ocupada; sua mensagem entrou na fila (#${position}) e vai para o app Claude depois deste turno. Encerre o turno agora.${sendWarning ? ` ${sendWarning}` : ""}` });
        }
        session.desktop!.pending = { kind: "send", text: message, since: Date.now(), attempts: 0 };
        session.status = "running";
        ccLedger.save();
        ccChip(session, "mensagem na fila para o app Claude");
        return json(res, 200, { message: `Na fila: vai para a sessão no app Claude assim que o Mac estiver livre, e o servidor confere que chegou; o próximo relatório volta aqui. Encerre o turno agora.${scripts.changed ? " (Troquei pnpm por npm run no texto: este repositório usa npm.)" : ""}${sendWarning ? ` ${sendWarning}` : ""}` });
      }
      // A stalled run may still be alive: never start a second one beside it.
      if (session.status === "running" || (session.status === "stalled" && ccProcesses.has(session.id))) {
        claim();
        const position = ccLedger.enqueue(session, message);
        return json(res, 200, { message: `A sessão está no meio de um turno; sua mensagem entrou na fila (#${position}) e roda assim que este turno terminar. Encerre o turno agora.${sendWarning ? ` ${sendWarning}` : ""}` });
      }
      if (!ccSlotFreeForWork()) {
        return json(res, 409, { error: ccLedger.slotsTaken() >= CC_MAX_RUNNING
          ? `já há ${CC_MAX_RUNNING} sessões do Claude Code ocupando as vagas; tente de novo depois que uma relatar`
          : `a vaga livre está reservada para ${ccStartQueue.urgentCount()} start(s) P1 na fila de sessões; tente de novo depois que ele(s) abrir(em) (veja cc_session_list)` });
      }
      claim();
      runCcTurn(session, message, session.turns === 0);
      ccChip(session, "mensagem enviada");
      return json(res, 200, { message: `Enviada. A sessão está trabalhando; o relatório volta aqui como um novo turno. Encerre o turno agora.${scripts.changed ? " (Troquei pnpm por npm run no texto: este repositório usa npm.)" : ""}${sendWarning ? ` ${sendWarning}` : ""}` });
    }
    if (session.surface === "app" && action === "stop") {
      // Nothing on the screen is touched: the server stops waiting for it,
      // drops what it would still type into it, and says so.
      const desktop = session.desktop!;
      const dropped = session.queued.length + (desktop.pending?.kind === "send" ? 1 : 0);
      session.queued = [];
      if (desktop.pending?.kind === "send" || desktop.pending?.kind === "create") delete desktop.pending;
      delete desktop.sent;
      session.status = desktop.localId ? "idle" : "stopped";
      session.lastActivityAt = Date.now();
      ccLedger.save();
      ccChip(session, `parada aqui${dropped ? ` — ${dropped} mensagem(ns) da fila descartada(s)` : ""}`, false);
      return json(res, 200, { message: `Marcada como parada aqui; a sessão no app Claude não foi tocada (se ela estiver no meio de um turno, só a pessoa a interrompe, com Esc na sessão).${dropped ? ` ${dropped} mensagem(ns) que ainda iam para ela foram descartadas.` : ""} Para retomar, use cc_session_send.` });
    }
    // Work that has not shipped is not archived by accident: an open PR,
    // or a merge not yet in the production tag, holds it unless the bot
    // says force with a reason.
    let archiveNote = "";
    if (action === "archive") {
      const forced = body.force === true;
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
      if (forced && !reason) return json(res, 400, { error: "force precisa de reason: por que arquivar sem a entrega em produção" });
      if (!forced) {
        const held = await archiveBlockers(session, { gh: (args) => execCc("gh", args), git: (repo, args) => execCc("git", ["-C", repo, ...args]) });
        if (held.blockers.length) {
          return json(res, 409, { error: `não arquivei: ${held.blockers.join("; ")}. Arquive quando a entrega estiver em produção, ou chame de novo com force: true e reason (ex.: trabalho abandonado, PR fechada em outra sessão).` });
        }
        if (held.unknown.length) archiveNote = ` (Não consegui conferir no GitHub: ${held.unknown.join(", ")}.)`;
      } else {
        ccChip(session, `arquivamento forçado: ${chipText(reason, 120)}`, false);
      }
    }
    if (session.surface === "app" && action === "archive") {
      const desktop = session.desktop!;
      if (fullAccessForSource(bot.id, threadId)) {
        const pending = desktop.pending;
        const neverOpened = !desktop.localId && desktop.sentAt === undefined && !desktop.sent
          && pending?.kind === "create" && pending.triedAt === undefined && pending.attempts === 0 && session.turns === 0;
        const record = desktop.localId ? readDesktopRecord(desktop.localId) : null;
        const transcript = record ? transcriptPath(record) : null;
        const uncertainSend = Boolean(desktop.sent || ((pending?.kind === "send" || pending?.kind === "create") && (pending.triedAt !== undefined || pending.attempts > 0)));
        const ended = (session.status === "idle" || session.status === "stopped" || session.status === "archived")
          && !uncertainSend && record && (record.isArchived || (transcript && transcriptTurnEnded(transcript)));
        if (!neverOpened && !ended) return json(res, 409, { error: "Não arquivei: o término da sessão no app Claude ainda não está confirmado. Nenhum app foi aberto e nenhuma execução foi duplicada." });
        const held = [...session.queued, ...(pending?.kind === "send" || pending?.kind === "create" ? [{ text: pending.text, at: pending.since }] : [])];
        if (held.length) session.heldQueue = [...(session.heldQueue ?? []), ...held];
        delete desktop.pending;
        delete desktop.archiveWhenResolved;
        ccLedger.setStatus(session, "archived");
        ccChip(session, `registro arquivado somente no OpenMausBot; app e worktree preservados${held.length ? `; ${held.length} mensagem(ns) não enviada(s) preservada(s) no histórico` : ""}`);
        return json(res, 200, { message: `Registro arquivado somente no OpenMausBot; o app Claude não foi aberto nem alterado e a worktree foi preservada. Uma nova sessão desta tarefa pode ser iniciada no terminal.${archiveNote}` });
      }
      if (desktop.pending?.kind === "archive" || desktop.archiveWhenResolved) {
        return json(res, 200, { message: "Já está na fila para ser arquivada no app Claude." });
      }
      const opening = !desktop.localId && (desktop.pending?.kind === "create" && desktop.pending.triedAt !== undefined || desktop.sentAt !== undefined);
      if (!desktop.localId && !opening) {
        ccLedger.setStatus(session, "archived");
        delete desktop.pending;
        ccLedger.save();
        ccChip(session, "arquivada (nunca abriu no app)");
        return json(res, 200, { message: "Arquivada; ela ainda não tinha aberto no app Claude." });
      }
      // An active session: never drop a message on its way, never archive
      // mid-turn. A stalled or idle one may be archived; what was still
      // queued for it is dropped, and said so.
      const active = ccSessionActive(session, Date.now());
      if (active && (desktop.pending?.kind === "send" || desktop.sent || session.queued.length)) {
        return json(res, 409, { error: "há uma mensagem a caminho dessa sessão; arquive depois que ela chegar e a sessão relatar" });
      }
      if (desktop.localId && active) {
        return json(res, 409, { error: "a sessão está no meio de um turno; arquive depois do relatório (ou peça à pessoa para pará-la no app)" });
      }
      const droppedTexts = [...session.queued.map((item) => item.text), ...(desktop.pending?.kind === "send" ? [desktop.pending.text] : [])];
      const dropped = droppedTexts.length;
      session.queued = [];
      if (desktop.pending?.kind === "send") delete desktop.pending;
      delete desktop.sent;
      if (dropped) {
        ccChip(session, `${dropped} mensagem(ns) da fila descartada(s) ao arquivar`, false);
        ccReport(session, `Claude Code session "${session.title}" (${session.id}) is being archived with ${dropped} message(s) that never reached it; they were NOT delivered:\n${droppedTexts.map((text) => `- ${text.split("\n")[0]!.slice(0, 200)}`).join("\n")}`);
      }
      // Its worktree goes only after the app's record confirms the archive.
      if (body.removeWorktree === true) desktop.removeWorktree = true;
      if (opening) {
        desktop.archiveWhenResolved = true;
        ccLedger.save();
        ccChip(session, "será arquivada no app Claude assim que abrir");
        return json(res, 200, { message: "Na fila: ela é arquivada no app Claude assim que abrir." });
      }
      desktop.pending = { kind: "archive", text: "", since: Date.now(), attempts: 0 };
      ccLedger.save();
      ccChip(session, "na fila para ser arquivada no app Claude");
      return json(res, 200, { message: `Na fila: ela é arquivada no app Claude assim que o Mac estiver livre, e o servidor confere no registro do app que arquivou${desktop.removeWorktree ? "; só então a worktree é conferida e você recebe o comando para uma pessoa removê-la, se não houver nada a perder (o servidor não remove)" : ""}.` });
    }
    if (action === "stop" || action === "archive") {
      // messages still queued for it leave with it: the owner hears which
      if (session.queued.length) {
        ccReport(session, `Claude Code session "${session.title}" (${session.id}) was ${action === "stop" ? "stopped" : "archived"} with ${session.queued.length} message(s) still queued for it; they were NOT delivered:\n${session.queued.map((item) => `- ${item.text.split("\n")[0]!.slice(0, 200)}`).join("\n")}`);
        ccChip(session, `${session.queued.length} mensagem(ns) da fila descartada(s) ao ${action === "stop" ? "parar" : "arquivar"}`, false);
      }
      const child = ccProcesses.get(session.id);
      if (child) {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      } else if (session.survivedRestartAt !== undefined && session.proc && ccProcAlive(session.proc)) {
        // the claude that outlived a restart, in its own group (detached): stopped with what it started
        const pid = session.proc.pid;
        try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
        ccChipShort(session, sessionChips.survivorStopped(session.title), true);
      }
      ccLedger.setStatus(session, action === "stop" ? "stopped" : "archived");
      if (action === "archive") {
        void reportArchivedWorktrees(session, body.removeWorktree === true).catch((error) => console.warn(`[worktrees] archive report of ${session.id} failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      ccChip(session, action === "stop" ? "parada" : "arquivada");
      const worktreeNote = action === "archive" && session.cwd ? " As worktrees dela são conferidas agora; o servidor não remove nenhuma: as que uma pessoa pode remover chegam como chip e relatório, com o comando, e as que ficam, com o motivo." : "";
      return json(res, 200, { message: `${action === "stop" ? "Parada; cc_session_send a retoma depois." : "Arquivada."}${worktreeNote}${archiveNote}` });
    }
    return json(res, 400, { error: "action deve ser start, send, list, stop ou archive" });
  };
}
