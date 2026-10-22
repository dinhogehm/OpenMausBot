// Owning conversations, reports and owner-item delegation for CC sessions.

import { existsSync } from "node:fs";

import { join } from "node:path";

import { type WireOwnerPending } from "../shared/wire.ts";

import { augmentedPath } from "./env-path.ts";
import { userTextMessagesWith } from "./message-db.ts";
import { ownerWrote } from "./incidents.ts";
import { chipText, type OwnerPending } from "./bot-autonomy.ts";

import { CcSessionLedger, type CcSession } from "./cc-sessions.ts";




import { execFile as execFileCc } from "node:child_process";
import { claimedPrNumbers } from "./prod-delivery.ts";



import { ownerChannelChip, sessionChips } from "./owner-chips.ts";
import { CHANNEL_ORDER_WORDS, lastChannelOrder, SharedState, threadByRef } from "./shared-state.ts";
import { channelTurnThread } from "./owner-channel.ts";



import { CcStartQueue } from "./cc-start-queue.ts";

import { type BotRecord } from "./store.ts";

import { delegationBackText, delegationChiefNote, delegationClosedNote, delegationRepo, delegationStuck, forOwner, itemText, onlyYouReason, parseDelegationReport, verifiedEvidence, type DelegatedItemRef, type EvidenceDeps, type OwnerDelegationBack } from "./owner-delegate.ts";








import type { CcRuntimeDeps } from "./cc-runtime.ts";

interface CcOwnerRuntimeDeps extends Pick<CcRuntimeDeps, "CLOUD_HOME" | "autonomy" | "chiefDeskThread" | "cloudOwnerOnlyThread" | "finishGoalWithChip" | "ownerThreadGone" | "refreshBotRow" | "releaseDelegationAnswer" | "store"> {
  sharedState: SharedState;
  ccLedger: CcSessionLedger;
  ccLeftoverChecks: Set<string>;
  ccGateWaits: Map<string, number>;
  readonly ccStartQueue: CcStartQueue;
  execCc: (file: string, args: string[], cwd?: string) => Promise<string>;
  openThreadOf: (botId: string, threadId: string | null | undefined) => boolean;
}

export function createCcOwnerRuntime(deps: CcOwnerRuntimeDeps) {
  const { CLOUD_HOME, autonomy, chiefDeskThread, cloudOwnerOnlyThread, finishGoalWithChip, ownerThreadGone, refreshBotRow, releaseDelegationAnswer, store, sharedState, ccLedger, ccLeftoverChecks, ccGateWaits, openThreadOf } = deps;
  /** The owning conversation, plus the thread the last order came from, plus
   * the conversation with the owner when the reports go there. */
  function ccThreads(session: CcSession): string[] {
    const threads = [session.ownerThreadId];
    if (session.replyThreadId && session.replyThreadId !== session.ownerThreadId) threads.push(session.replyThreadId);
    const reportTo = sessionReportThread(session);
    if (!threads.includes(reportTo)) threads.push(reportTo);
    return threads.filter((threadId) => store.taskByThread(session.ownerBotId, threadId));
  }

  /** The conversation the owner named for talking to them (shared-state), while open. */
  function ownerChannelOf(botId: string): string | null {
    try {
      const named = sharedState.ownerThread(botId)?.threadId ?? null;
      return named && openThreadOf(botId, named) ? named : null;
    } catch {
      return null; // not set up yet (module load)
    }
  }

  /** Where a session's report wakes its bot: the conversation the owner named,
   * when there is one — the bot answers the owner from where it is woken, and
   * reports woken elsewhere had the Chief writing to the owner in two
   * conversations 3 s apart (R9-followup #1). A session whose own conversation
   * runs a goal reports there: that goal is waiting for it. */
  function sessionReportThread(session: CcSession): string {
    return ownerTurnThread(session.ownerBotId, session.ownerThreadId);
  }

  /** Where a turn woken on the owner's behalf from `from` runs: the owner's
   * channel when there is one (owner-channel.ts), unless `from` runs a goal. */
  function ownerTurnThread(botId: string, from: string): string {
    return channelTurnThread({ channel: ownerChannelOf(botId), from, goalActive: autonomy.goalFor(from)?.status === "active" });
  }

  /** The owner named a conversation: the Claude Code sessions their bot runs
   * from its other conversations report there from now on (not those of a
   * conversation running a goal). Said once, with a chip in each. */
  function moveWorkToOwnerThread(botId: string, ownerThreadId: string, why: string): void {
    if (!openThreadOf(botId, ownerThreadId)) return;
    const moved: CcSession[] = [];
    for (const session of ccLedger.all()) {
      if (session.ownerBotId !== botId || session.status === "archived" || session.ownerThreadId === ownerThreadId) continue;
      if (autonomy.goalFor(session.ownerThreadId)?.status === "active") continue;
      const from = session.ownerThreadId;
      session.ownerThreadId = ownerThreadId;
      if (session.replyThreadId === ownerThreadId) delete session.replyThreadId;
      moved.push(session);
      if (store.taskByThread(botId, from)) {
        store.appendMessage(from, { role: "bot", kind: "activity", tool: { name: chipText(sessionChips.movedAway(session.title), 240), ok: true }, threadRef: { botId, threadId: ownerThreadId, title: store.taskByThread(botId, ownerThreadId)?.title ?? "conversa com o dono" } });
      }
    }
    if (!moved.length) return;
    ccLedger.save();
    const list = moved.map((session) => `"${session.title}" (${session.id.slice(0, 8)}, ${session.status})`).join(", ");
    store.appendMessage(ownerThreadId, { role: "bot", kind: "activity", tool: { name: chipText(sessionChips.movedHere(moved.map((session) => session.title), why), 240), ok: true } });
    console.log(`[shared-state] ${store.bot(botId)?.name ?? botId}: ${moved.length} session(s) now report to the conversation with the owner (${ownerThreadId}): ${list}`);
    refreshBotRow(botId);
  }

  /** At boot: each bot's last channel order, read back from the history
   * (messages.db, read only). An order given before this build — or before
   * the last turns a record reads — still names the conversation with the
   * owner; where the owner wrote last never takes its place (R9-followup #1). */
  function adoptOwnerChannels(): void {
    for (const bot of store.bots) {
      try {
        const tasks = store.tasks(bot.id).filter((task) => !CLOUD_HOME || cloudOwnerOnlyThread(task.threadId));
        const ids = tasks.map((task) => task.threadId);
        const rows = userTextMessagesWith(ids, CHANNEL_ORDER_WORDS, 200)
          .filter((row) => ownerWrote(row.message) && !store.groupByThread(row.threadId))
          .map((row) => ({ threadId: row.threadId, at: row.message.at, text: row.message.text ?? "" }));
        const found = lastChannelOrder(rows, (ref) => threadByRef(ids, ref));
        if (!found) continue;
        const task = store.taskByThread(bot.id, found.target);
        if (!task || !openThreadOf(bot.id, found.target)) {
          console.log(`[shared-state] ${bot.name}: the owner's last channel order (${new Date(found.order.at).toISOString()}) names ${found.target}, which is no longer open — not adopted`);
          continue;
        }
        if (!sharedState.adoptChannelOrder(bot.id, found.order, { threadId: found.target, title: task.title })) continue;
        const when = new Date(found.order.at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        console.log(`[shared-state] ${bot.name}: the conversation with the owner is ${found.target} (their channel order of ${new Date(found.order.at).toISOString()}, read back from the history)`);
        store.appendMessage(found.target, { role: "bot", kind: "activity", tool: { name: chipText(ownerChannelChip(when), 240), ok: true } });
        moveWorkToOwnerThread(bot.id, found.target, `ordem do dono de ${when}`);
      } catch (error) {
        console.error(`[shared-state] ${bot.name}: could not read back the owner's channel order: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // a channel already on record (set by an earlier build) moved nothing then:
    // the sessions still tied to older conversations move now — idempotent,
    // a session already in the channel is left as it is (R10-followup #2)
    for (const bot of store.bots) {
      const channel = ownerChannelOf(bot.id);
      if (channel) moveWorkToOwnerThread(bot.id, channel, "o canal com o dono já estava definido");
    }
  }

  function ccChip(session: CcSession, text: string, ok = true): void {
    for (const threadId of ccThreads(session)) {
      store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `Claude Code "${session.title.slice(0, 60)}": ${text}`, ok } });
    }
    // the owner's row carries the session's state (failed, stalled, question)
    refreshBotRow(session.ownerBotId);
  }

  /** A chip of the server's own about a session, short and in the owner's
   * words (server/owner-chips.ts), in its conversations — but not in `skip`
   * (the Chief's desk when its summary already says it, INSP-H r1 #10). */
  function ccChipShort(session: CcSession, text: string, ok = true, skip?: string | null): void {
    for (const threadId of ccThreads(session)) {
      if (threadId === skip) continue;
      store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: chipText(text, 240), ok } });
    }
    refreshBotRow(session.ownerBotId);
  }

  /** A session's report wakes its owner — in the conversation the owner named
   * when there is one (sessionReportThread), else in its own conversation and
   * the thread that gave the order. */
  function ccReport(session: CcSession, text: string): void {
    const to = sessionReportThread(session);
    // the Chief reads that the item is the owner's to settle: no resuming a refused session (INSP-DEL A13)
    if (session.delegatedItem) text = `${text}\n\n${delegationChiefNote(session.delegatedItem)}`;
    autonomy.addReport(session.ownerBotId, to, text);
    // a delegated item hears the report too: closed or given back by its lines (lote del)
    settleDelegation(session);
    if (to !== session.ownerThreadId || ownerChannelOf(session.ownerBotId)) return;
    if (session.replyThreadId && session.replyThreadId !== session.ownerThreadId && store.taskByThread(session.ownerBotId, session.replyThreadId)) {
      autonomy.addReport(session.ownerBotId, session.replyThreadId, text);
    }
  }


  /** A conversation closed, archived or deleted: its goal ends (with a chip)
   * and the Claude Code sessions it owned report to the bot's main
   * conversation from now on, instead of to a thread nobody reads. */
  function retireThreadWork(botId: string, threadId: string, why: string): void {
    const bot = store.bot(botId);
    if (!bot) return;
    const goal = autonomy.goalFor(threadId);
    if (goal?.status === "active") finishGoalWithChip(threadId, "stopped", `a conversa foi ${why}`);
    else if (goal?.status === "needs-input") autonomy.resolveNeedsInput(threadId, `a conversa foi ${why}`, "blocked");
    ownerThreadGone(botId, threadId, why);
    const main = [chiefDeskThread(bot, threadId), bot.threadId].find((candidate) => candidate && candidate !== threadId && store.taskByThread(botId, candidate) && !store.taskByThread(botId, candidate)?.archivedAt);
    const moved: CcSession[] = [];
    for (const session of ccLedger.all()) {
      if (session.ownerBotId !== botId || session.status === "archived") continue;
      if (session.replyThreadId === threadId) delete session.replyThreadId;
      if (session.ownerThreadId !== threadId || !main) continue;
      session.ownerThreadId = main;
      moved.push(session);
    }
    ccLedger.save();
    if (!main || !moved.length) return;
    const list = moved.map((session) => `"${session.title}" (${session.id}, ${session.status})`).join(", ");
    store.appendMessage(main, { role: "bot", kind: "activity", tool: { name: chipText(`${moved.length} sessão(ões) do Claude Code passaram para esta conversa (a de origem foi ${why}): ${list}`, 240), ok: true } });
    autonomy.addReport(botId, main, `[The conversation that owned these Claude Code sessions was ${why}; they report here from now on.] ${list}. Check what each still needs (cc_session_list) and carry on here.`);
    refreshBotRow(botId);
  }

  /** "Assuma a PR #9328" in an order to a session: that PR is its own from now
   * on (prod-delivery.ts), though its branch is not the session's. Only an
   * explicit hand-over; a PR the session's report names never is (R9-followup #2). */
  function noteClaimedPrs(session: CcSession, text: string): void {
    const claimed = claimedPrNumbers(text);
    if (!claimed.length) return;
    session.claimedPrs = [...new Set([...(session.claimedPrs ?? []), ...claimed])];
    if (session.delivery?.notOwned) session.delivery.notOwned = session.delivery.notOwned.filter((number) => !claimed.includes(number));
    ccLedger.save();
    ccChipShort(session, sessionChips.claimed(session.title, claimed));
  }


  // ── "Delegar a um agente" (lote del, server/owner-delegate.ts) ──────────
  // The owner hands an item of "Precisa de você" to a Claude Code session,
  // opened by startCcSession like the Chief's (same guard, worktree option,
  // breaker). The item waits on it, out of the count; the session's report
  // settles it: "concluido" with evidence closes it, anything else gives it
  // back on top. Never an approve, never the owner's approval.

  /** "às 14:05" (São Paulo), for what the owner and the session read. */
  const delegationTime = (at: number) => `às ${new Date(at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}`;

  /** Whether an agent may take the item, and in which repository; else why only the owner can.
   * `isRepo` is cheap on the wire (the folder exists) and strict on the click (git). */
  function delegateView(item: OwnerPending, isRepo: (path: string) => boolean): { repo: string } | { onlyYou: string } {
    const reason = onlyYouReason(item);
    if (reason) return { onlyYou: reason };
    const found = delegationRepo(itemText(item), ccLedger.all());
    if ("reason" in found) return { onlyYou: found.reason };
    return isRepo(found.repo) ? { repo: found.repo } : { onlyYou: "o repositório que o item cita não existe mais neste Mac" };
  }

  /** Who owns the delegated session: the Chief at its desk (it runs the sessions), else the item's bot where it talks to the owner. */
  function delegationOwner(bot: BotRecord, item: OwnerPending): { bot: BotRecord; threadId: string } | null {
    const chief = store.bots.find((each) => each.chiefOfStaff && !each.hidden);
    const desk = chief ? chiefDeskThread(chief) : null;
    if (chief && desk && openThreadOf(chief.id, desk) && !store.groupByThread(desk)) return { bot: chief, threadId: desk };
    const thread = ownerTurnThread(bot.id, item.threadId);
    return store.taskByThread(bot.id, thread) && !store.groupByThread(thread) ? { bot, threadId: thread } : null;
  }

  /** A chip in the item's conversation: its bot reads what became of it. */
  function delegationChip(item: OwnerPending, text: string, ok = true): void {
    if (store.taskByThread(item.botId, item.threadId)) store.appendMessage(item.threadId, { role: "bot", kind: "activity", tool: { name: chipText(text, 240), ok } });
  }

  /** The session for a delegated item exists now: the item says which. */
  function delegationOpened(ref: DelegatedItemRef, session: CcSession): void {
    session.delegatedItem = ref;
    const item = autonomy.ownerPendingById(ref.botId, ref.itemId);
    if (!item?.delegation) return;
    const { queueId: _queueId, ...delegation } = item.delegation;
    autonomy.patchOwnerPending(ref.botId, item.id, { delegation: { ...delegation, state: "running", sessionId: session.id } });
    refreshBotRow(ref.botId);
  }

  /** The item goes back to the owner, on top, with what the agent did and what is left. */
  function delegationReturned(ref: DelegatedItemRef, back: OwnerDelegationBack): void {
    const item = autonomy.ownerPendingById(ref.botId, ref.itemId);
    if (!item) return;
    // the server's hints to a bot (tool names, "end the turn") are not the owner's to read
    const owned = { ...back, text: forOwner(back.text) };
    autonomy.patchOwnerPending(ref.botId, item.id, { delegation: undefined, delegationBack: owned });
    // back with the owner: delegating it again is a new click, not a duplicate of the last (INSP-DEL A13)
    releaseDelegationAnswer(ref.botId, item.id);
    delegationChip(item, `Voltou para o dono (delegação): ${item.title} — ${owned.text}`, false);
    refreshBotRow(ref.botId);
    console.log(`[owner-delegate] ${item.id} of ${store.bot(ref.botId)?.name ?? ref.botId} is back with the owner (${back.outcome}${back.sessionId ? `, session ${back.sessionId}` : ""})`);
  }

  /** A delegated session reported: its report, read by its lines, settles the
   * item — closed only on "concluido" with evidence; given back otherwise.
   * A turn the server resumes by itself (background job, release) waits. */
  function settleDelegation(session: CcSession): void {
    const ref = session.delegatedItem;
    if (!ref) return;
    const item = autonomy.ownerPendingById(ref.botId, ref.itemId);
    // resolved meanwhile, or delegated again to another session
    if (!item || (item.delegation ? item.delegation.sessionId !== session.id : item.delegationBack?.sessionId !== session.id)) return;
    // a cut turn whose job the server follows: it resumes the session itself, so the item waits (INSP-R13res A2)
    // (or about to be: its ended turn is still being checked for one)
    if (session.bgJob || ccLeftoverChecks.has(session.id)) return;
    if (session.status === "failed") {
      if (item.delegationBack?.sessionId === session.id && item.delegationBack.outcome === "falhou") return;
      delegationReturned(ref, { at: Date.now(), outcome: "falhou", text: `a sessão parou com um problema: ${(session.lastError ?? "erro desconhecido").slice(0, 300)}`, sessionId: session.id });
      return;
    }
    if (session.status === "running" || session.status === "stalled" || session.bgJob || session.resumeAfterTag) return;
    if ((session.delegationSettledTurns ?? -1) >= session.turns) return;
    session.delegationSettledTurns = session.turns;
    ccLedger.save();
    const report = session.lastReport ?? "";
    const result = parseDelegationReport(report);
    if (result.outcome !== "concluido") {
      delegationReturned(ref, { at: Date.now(), outcome: result.outcome, text: delegationBackText(result, report), ...(result.command ? { command: result.command.slice(0, 500) } : {}), sessionId: session.id });
      return;
    }
    // "concluido" closes only on evidence the server checks itself: a PR open or
    // merged since the delegation, or a commit on the session's branch (INSP-DEL A5)
    // the work must be newer than THIS session, which the delegation created: never 0, even after the item came back (INSP-DEL r2 B1)
    const since = Math.max(session.createdAt, item.delegation?.at ?? 0);
    void verifiedEvidence(result.evidence, since, delegationEvidenceDeps(session, since)).then((proof) => {
      const now = autonomy.ownerPendingById(ref.botId, ref.itemId);
      // resolved or delegated again while the check ran
      if (!now || (now.delegation ? now.delegation.sessionId !== session.id : now.delegationBack?.sessionId !== session.id)) return;
      // already back with the owner: a later "concluido" only notes what it shows, the owner settles (INSP-DEL r3 C6)
      if (!now.delegation && now.delegationBack) {
        // once per piece of evidence: a session saying it again does not grow the text (INSP-DEL r4 D5)
        if (proof && !now.delegationBack.text.includes(proof)) autonomy.patchOwnerPending(ref.botId, ref.itemId, { delegationBack: { ...now.delegationBack, text: `${now.delegationBack.text} Depois disso, a sessão ${session.id} disse que concluiu, com evidência conferida: ${proof}. Confira e marque como resolvido, se for o caso.` } });
        refreshBotRow(ref.botId);
        return;
      }
      if (!proof) {
        delegationReturned(ref, { at: Date.now(), outcome: "parcial", text: `o agente disse concluído, mas não deu evidência que o servidor conseguisse conferir (um link de PR aberto ou mergeado depois da delegação, ou um commit na branch da sessão). Confira na sessão ${session.id}.`, sessionId: session.id });
        return;
      }
      // the type has no "agent": the bot's, with the session and the checked evidence in the note
      for (const done of autonomy.resolveOwnerPending({ botId: ref.botId, id: ref.itemId, by: "bot", note: delegationClosedNote(session.id, proof) })) {
        delegationChip(done, `Resolvido pelo agente (sessão ${session.id}): ${done.title} — evidência conferida: ${proof}`);
      }
      refreshBotRow(ref.botId);
      console.log(`[owner-delegate] ${ref.itemId} of ${store.bot(ref.botId)?.name ?? ref.botId} closed: session ${session.id} reported "concluido", evidence checked (${proof})`);
    }).catch((error) => console.error(`[owner-delegate] evidence check for ${ref.itemId}: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** How the server checks a delegated session's evidence: `gh pr view` for a
   * PR, `git` in the session's own worktree for a commit on its branch. */
  function delegationEvidenceDeps(session: CcSession, since: number): EvidenceDeps {
    const run = (cmd: string, args: string[], cwd?: string) => new Promise<string>((resolve, reject) => {
      // the app's PATH lacks Homebrew (gh) and a sealed fixture's lacks git: the same augmented PATH as execCc
      execFileCc(cmd, args, { timeout: 15_000, env: { ...process.env, PATH: augmentedPath() }, ...(cwd ? { cwd } : {}) }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
    });
    // only the session's own worktree: never the repository's main checkout (INSP-DEL r2 B3)
    const dir = session.desktop?.own?.path ?? (session.worktree ? join(session.repo, ".claude", "worktrees", session.worktree) : null);
    const branchOf = async () => (dir && existsSync(dir) ? (await run("git", ["-C", dir, "branch", "--show-current"])).trim() : "");
    const baseRef = async () => {
      // the base the work must be new against: origin's default branch, else origin/main
      try { return (await run("git", ["-C", dir!, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim() || "origin/main"; } catch { return "origin/main"; }
    };
    return {
      // a PR of THIS session: its head is the session's branch, in the session's repository, created since the delegation (INSP-DEL r2 B2)
      prView: async (url) => {
        const branch = await branchOf();
        if (!branch || !dir) return null;
        const parsed = JSON.parse(await run("gh", ["pr", "view", url, "--json", "state,createdAt,headRefName,url"], dir)) as { state?: string; createdAt?: string; headRefName?: string; url?: string };
        if (!parsed.state || !parsed.createdAt || parsed.headRefName !== branch) return null;
        // the repository: `gh pr view` run in the session's worktree resolves the same URL only for that repository
        const own = JSON.parse(await run("gh", ["pr", "view", parsed.headRefName, "--json", "url"], dir).catch(() => "{}")) as { url?: string };
        if (!own.url || own.url !== parsed.url) return null;
        return { state: parsed.state, createdAt: parsed.createdAt };
      },
      // a commit of THIS session: on its branch, new against the base, with a real change, made since the delegation (INSP-DEL r2 B3)
      hasCommit: async (sha) => {
        if (!dir || !existsSync(dir)) return false;
        await run("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`]);
        await run("git", ["-C", dir, "merge-base", "--is-ancestor", sha, "HEAD"]);
        const base = await baseRef();
        const onBase = await run("git", ["-C", dir, "merge-base", "--is-ancestor", sha, base]).then(() => true, () => false);
        if (onBase) return false;
        const changed = (await run("git", ["-C", dir, "show", "--name-only", "--format=", sha])).trim();
        if (!changed) return false;
        const committed = Number((await run("git", ["-C", dir, "show", "-s", "--format=%ct", sha])).trim()) * 1000;
        return Number.isFinite(committed) && committed >= since;
      },
    };
  }

  /** Delegations nothing will settle: a queued start that left the queue
   * without opening, a session gone from the ledger, or one ended without a
   * report (archived, stopped, failed). Each goes back to the owner. */
  function reconcileDelegations(): void {
    for (const item of autonomy.allOwnerPending()) {
      const delegation = item.delegation;
      if (!delegation) continue;
      const ref = { botId: item.botId, itemId: item.id };
      // one item's trouble never stops the others, nor the desktop-work tick that calls this (INSP-DEL A8)
      try {
        const session = delegation.sessionId ? ccLedger.get(delegation.sessionId) ?? null : null;
        // too long without a report, stalled, or silent: back to the owner, whatever its state (INSP-DEL A8)
        const stuck = delegationStuck(delegation, session ? { status: session.status, lastActivityAt: session.lastActivityAt, progressAt: session.progressAt } : null, Date.now());
        // its turn's cut waits for its gate: a legitimate wait, the item's time is extended while it lasts (R2 B6)
        if (stuck && session && ccGateWaits.has(session.id)) continue;
        if (stuck) {
          delegationReturned(ref, { at: Date.now(), outcome: "falhou", text: `${stuck}; confira a sessão${session ? ` ${session.id}` : ""} antes de delegar de novo`, ...(session ? { sessionId: session.id } : {}) });
          continue;
        }
        if (delegation.state === "queued") {
          if (delegation.queueId && deps.ccStartQueue.ordered().some((each) => each.id === delegation.queueId)) continue;
          const opened = ccLedger.all().find((each) => each.delegatedItem?.botId === ref.botId && each.delegatedItem.itemId === ref.itemId && each.createdAt >= delegation.at);
          if (opened) delegationOpened(ref, opened);
          else delegationReturned(ref, { at: Date.now(), outcome: "falhou", text: "a sessão não abriu: o start saiu da fila de sessões sem abrir (o motivo está na conversa de quem a pediu)" });
          continue;
        }
        if (!session) delegationReturned(ref, { at: Date.now(), outcome: "falhou", text: "a sessão sumiu do registro do servidor sem relatório" });
        else if (session.status !== "running" && session.status !== "stalled") settleDelegation(session);
      } catch (error) {
        console.error(`[owner-delegate] reconcile ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** The item as "Precisa de você" shows its delegation: running (with the
   * session and its link), came back (with why), or the button — or why not. */
  function wireDelegation(item: OwnerPending): Pick<WireOwnerPending, "delegable" | "onlyYou" | "delegation" | "delegationBack"> {
    if (item.delegation) {
      const session = item.delegation.sessionId ? ccLedger.get(item.delegation.sessionId) : null;
      const local = session?.desktop?.localId;
      return {
        delegation: {
          at: item.delegation.at, state: item.delegation.state, ...(item.delegation.option ? { option: item.delegation.option } : {}),
          ...(session ? { sessionId: session.id, sessionTitle: session.title } : {}), ...(local ? { link: `claude://code/continue?session=${local}` } : {}),
        },
      };
    }
    const view = delegateView(item, existsSync);
    const back = item.delegationBack;
    return {
      ...("repo" in view ? { delegable: true as const } : { onlyYou: view.onlyYou }),
      ...(back ? { delegationBack: { at: back.at, outcome: back.outcome, text: back.text, ...(back.command ? { command: back.command } : {}) } } : {}),
    };
  }

  return { ownerChannelOf, sessionReportThread, ownerTurnThread, moveWorkToOwnerThread, adoptOwnerChannels, ccChip, ccChipShort, ccReport, retireThreadWork, noteClaimedPrs, delegationTime, delegateView, delegationOwner, delegationChip, delegationOpened, delegationReturned, reconcileDelegations, wireDelegation };
}
