// Boot-time watches the server keeps: transient computer errors, owner activity per conversation, power and older needs-you items.
import { type SharedState } from "./shared-state.ts";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type WireBot } from "../shared/wire.ts";
import { loadConfig, DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { buildNotification, type Notification } from "./notify.ts";
import { chiefForBot, deskThread, OwnerWroteAt } from "./incidents.ts";
import { BotAutonomy, GOAL_MAX_CONSECUTIVE_FAILURES, goalEndChip, ownerPendingStepsAutoReport, missingParts, type OwnerPendingStep, type OwnerPendingOption, NEEDS_INPUT_EXPIRE_MS, promiseOverdueReport, type OwnerPending, chipText, DISPATCH_RETRY_MAX_MINUTES, watchLabel, goalCitedPrs, citedPrsOutcome, NEEDS_INPUT_PR_CHECK_MAX, type CitedPrState, questionStepsAutoReport, questionReportRef, ANSWERED_IN_CONVERSATION, answerToAsk, answeredInConversationReport, type AskPromotion } from "./bot-autonomy.ts";
import { runWatchCommand, watchMatches } from "./wake-watch.ts";
import { DiskWatch } from "./disk-watch.ts";
import { psTable } from "./bg-jobs.ts";
import { execFile as execFileCc } from "node:child_process";
import { parseLsRemoteTag, PRODUCTION_TAG, notAPullRequest } from "./prod-delivery.ts";
import { computerErrorPt } from "./error-pt.ts";
import { appUnblockPending } from "./owner-chips.ts";
import { batteryMinPercent, carrierBatteryCheck, carrierIntent, isReleaseProcess, lastUnplugAt, parsePmsetBatt, POWER_PENDING_KEY, powerPendingDetails, powerStep, readPowerWatch, shouldReadPmsetLog, type PowerState, type PowerWatchState } from "./power.ts";
import { ATTENTION_ESCALATION_FILE, ATTENTION_FILE_MAX_BYTES, DECLINED_SHA_FILE, fullReleaseSha, haltReport, LAST_FAILURE_FILE, productionStateLine, releaseFailedText, releaseAttention, releaseAttentionAlert, releaseAttentionDue, HALT_ESCALATION_FILE, HALTED_REASON_FILE, HALTED_SHA_FILE, haltedRelease, nothingToPublish, readTail, RELEASE_ERR_LOG, RELEASE_OUT_LOG, RELEASED_SHA_FILE, releaseFailureCause, releaseFailures, releaseLoopItemsToClose, releaseLoopPending, releaseLoopPlan, releaseRetryText, ReleaseWatchState, haltStillMatters, tagAdvancePending, tagAdvanceToResolve, tagContainsRelease, tagManualAdvance, tagStuck, tagStuckCause, tagStuckReport } from "./release-watch.ts";
import { botMarkPattern, botSlug } from "./watch-echo.ts";
import { Store, type BotRecord } from "./store.ts";
import { writeFileAtomic } from "./atomic.ts";
import { heldByOwner, idleCandidates, idleIssuesArgs, idlePrsArgs, mentionedNumbers, parseIdleIssues, releaseInFlightOf, parseOpenPrCount, PIPELINE_IDLE_EVERY_MS, PIPELINE_IDLE_QUIET_MS, pipelineIdleLogLine, pipelineIdleReport, pipelineIdleStep, pipelineOrder, type IdleCandidate, type PipelineIdleState } from "./pipeline-idle.ts";
import { PRODUCTION_REPO } from "../shared/productivity.ts";
import { markStaleRoutineAsks } from "./routine-owner-ask.ts";
import { botTextsWithRefsSince } from "./message-db.ts";
import { type NowStatusService } from "./now-status.ts";
import { type CcSessionLedger } from "./cc-sessions.ts";
import { diskAlertText } from "./nested-worktrees.ts";

export interface BootWatchRuntimeDeps {
  DESKTOP_MANAGED: boolean;
  autonomy: BotAutonomy;
  autonomyTestMs: (name: string) => number | undefined;
  goalNeedsInputForThread: (threadId: string) => number | null;
  goalNeedsInputAskForThread: (threadId: string) => string | null;
  questionPromotion: (threadId: string, at: number) => AskPromotion | null;
  personSpokeSince: (threadId: string, at: number) => boolean;
  readonly ccLedger: Pick<CcSessionLedger, "all">;
  readonly refreshReleaseHold: () => Promise<void>;
  readonly releaseHold: Parameters<typeof releaseInFlightOf>[0];
  readonly RELEASE_HOLD_EVERY_MS: number;
  readonly releasedCleanup: { lastStale: Parameters<typeof diskAlertText>[1] };
  readonly nowStatus: Pick<NowStatusService, "recordAlert">;
  broadcast: (payload: Record<string, unknown>, options?: { adminOnly?: boolean }) => void;
  cfg: ReturnType<typeof loadConfig>;
  notify: (notification: Notification | null) => void;
  store: Store;
  wireBot: (bot: BotRecord) => WireBot;
  readonly sharedState: SharedState;
  readonly openThreadOf: (botId: string, threadId: string | null | undefined) => boolean;
  readonly execCc: (file: string, args: string[], cwd?: string) => Promise<string>;
  readonly ownerTurnThread: (botId: string, from: string) => string;
  readonly APP_UNBLOCK_KEY: string;
}

/** Built once, where server/index.ts used to declare all of this inline. */
export function createBootWatchRuntime(deps: BootWatchRuntimeDeps) {
  const { DESKTOP_MANAGED, autonomy, autonomyTestMs, goalNeedsInputForThread, goalNeedsInputAskForThread, questionPromotion, personSpokeSince, broadcast, cfg, notify, store, wireBot } = deps;
  /** Errors of a computer still coming up after a boot: waited out quietly. */
  const BOOT_TRANSIENT = /cannot safely resume|Start (?:docker|podman|container) first|is not running|Cua Driver is not ready yet|Cannot connect to the Docker daemon/i;
  /** Retries of a turn that would not start before the Chief is told, and the
   * window after a server start in which computer errors count as boot noise. */
  const DISPATCH_ALERT_AFTER = 5;
  const BOOT_GRACE_MS = 20 * 60_000;

  /** An autonomous turn that failed after dispatch: its wake or reports go
   * back, due after a growing wait (bot-autonomy.ts returnFailedDispatch), with
   * a chip; its goal counts a failed turn. The Chief hears about it at once,
   * unless it looks like a computer still booting — then only if it keeps
   * failing. A Stop or a cancelled setup just drops the lease. */
  function autonomyDispatchFailed(botId: string, threadId: string, message: string): void {
    if (/\bstopped\b|cancelled|changed before dispatch/i.test(message)) {
      autonomy.settleInFlight(threadId);
      return;
    }
    const back = autonomy.returnFailedDispatch(threadId, message);
    const goal = autonomy.goalFor(threadId);
    if (goal?.status === "active" && !back.length) {
      const failures = autonomy.noteGoalTurnOutcome(threadId, false);
      if (failures >= GOAL_MAX_CONSECUTIVE_FAILURES) finishGoalWithChip(threadId, "blocked", `${failures} turns in a row could not start — ${message.slice(0, 120)}.`);
      else if (!autonomy.wakeFor(threadId)) autonomy.setWake(botId, threadId, 2 * failures, "The previous goal turn could not start. Check what went wrong, then continue the goal or call goal_end with blocked.");
    }
    const bot = store.bot(botId);
    if (!bot || !store.taskByThread(botId, threadId)) return;
    const worst = back.reduce((max, item) => (item.failures > max.failures ? item : max), { failures: 0, delayMs: 0 } as { failures: number; delayMs: number });
    const minutes = Math.max(1, Math.round(worst.delayMs / 60_000));
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: chipText(`O turno automático não começou (${computerErrorPt(message)}) — nova tentativa em ${minutes} min`, 240), ok: false } });
    const booting = BOOT_TRANSIENT.test(message) && process.uptime() * 1_000 < BOOT_GRACE_MS;
    if (worst.failures === DISPATCH_ALERT_AFTER || (worst.failures === 1 && !booting)) {
      alertAutomationTrouble(bot, threadId, `o turno automático não começou ${worst.failures === 1 ? "" : `${worst.failures} vezes seguidas `}(${chipText(computerErrorPt(message), 140)}); o servidor tenta de novo sozinho, com espera crescente até ${DISPATCH_RETRY_MAX_MINUTES} min`);
    }
    refreshBotRow(botId);
  }

  /** When the owner last wrote in each conversation (server/incidents.ts):
   * read from a conversation's newest messages once, then kept current. */
  const ownerWroteAt = new OwnerWroteAt((threadId) => store.messagesTail(threadId, 300).messages);
  store.onChange((change) => {
    if (change.type === "message") ownerWroteAt.note(change.threadId, change.message);
    else if (change.type === "thread.deleted") ownerWroteAt.forget(change.threadId);
  });

  /** Where the harness's own alerts reach a Chief (deskThread): the
   * conversation the owner named, else its pinned one, else the one where the
   * owner wrote last, else its oldest open one not running a goal — never
   * whichever thread happens to be selected (bot.threadId follows the UI).
   * `except`: a conversation on its way out (being archived or deleted). */
  function chiefDeskThread(chief: BotRecord, except?: string): string {
    // sharedState and ownerWroteAt are set up as the server loads: a call made
    // before that falls back to the rest of the rule
    let ownerThread: string | null = null;
    try {
      const named = deps.sharedState.ownerThread(chief.id);
      // closed while nobody was looking (or before this check existed): forget it, and say so
      if (named && !deps.openThreadOf(chief.id, named.threadId)) ownerThreadGone(chief.id, named.threadId, "fechada");
      else ownerThread = named?.threadId ?? null;
    } catch { /* not set up yet */ }
    const wrote = (threadId: string) => {
      try { return ownerWroteAt.at(threadId); } catch { return null; }
    };
    const tasks = store.tasks(chief.id).filter((task) => task.threadId !== except);
    return deskThread(tasks, chief.threadId, (threadId) => autonomy.goalFor(threadId)?.status === "active", ownerThread, wrote);
  }

  /** The conversation the owner named for talking to them was closed,
   * archived or deleted: it is forgotten as theirs, and the conversation that
   * now gets what was meant for them says so (INSP-F F2-b). */
  function ownerThreadGone(botId: string, threadId: string, why: string): void {
    const title = store.taskByThread(botId, threadId)?.title;
    if (!deps.sharedState.forgetOwnerThread(botId, threadId)) return;
    const bot = store.bot(botId);
    if (!bot) return;
    const next = mainThreadOf(botId, threadId);
    console.log(`[shared-state] ${bot.name}: the conversation with the owner (${threadId}) was ${why}; ${next ? `now ${next}` : "no open conversation left"}`);
    if (!next) return;
    store.appendMessage(next, { role: "bot", kind: "activity", tool: { name: chipText(`a conversa com o dono${title ? ` ("${title}")` : ""} foi ${why}; os avisos vêm para cá`, 240), ok: false } });
  }

  /** A bot's main conversation other than `except`, still open: its desk
   * (deskThread: the named one, the pin, where the owner wrote last, the
   * oldest), else the one selected in the UI. */
  function mainThreadOf(botId: string, except?: string): string | null {
    const bot = store.bot(botId);
    if (!bot) return null;
    return [chiefDeskThread(bot, except), bot.threadId].find((candidate) => candidate && candidate !== except && deps.openThreadOf(botId, candidate)) ?? null;
  }

  /** Automation that keeps failing on its own (a standing watch, a routine):
   * a red chip where it runs, and a report to the bot's Chief of Staff, which
   * wakes it — or, with no Chief on duty, a notification to the person. */
  function alertAutomationTrouble(bot: BotRecord, threadId: string, text: string): void {
    if (store.taskByThread(bot.id, threadId)) store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: chipText(text, 240), ok: false } });
    const chief = chiefForBot(store.bots, bot);
    const desk = chief ? chiefDeskThread(chief) : null;
    if (chief && desk && store.taskByThread(chief.id, desk)) {
      store.appendMessage(desk, {
        role: "bot",
        kind: "activity",
        tool: { name: chipText(`${bot.name}: ${text}`, 240), ok: false },
        threadRef: { botId: bot.id, threadId, title: store.taskByThread(bot.id, threadId)?.title ?? `${bot.name}'s conversation` },
      });
      autonomy.addReport(chief.id, desk, `[Automation trouble in ${bot.name}'s conversation ${threadId}] ${text}\nLook into it: fix it with ${bot.name}, or tell the person what is not being watched or run.`);
      return;
    }
    notify(buildNotification("incident", bot, threadId, text, { avatarUrl: bot.avatarUrl }));
  }

  /** Stop means stop: the person's Stop ends goal mode and drops a pending
   * wake-up, before the interrupt settles the turn as failed. */
  function stopAutonomyByPerson(threadId: string): void {
    // a cut lease not given back yet (resumeCutLeases) is stopped too: never run after the Stop
    const cutWake = autonomy.dropRecoveredLeases(threadId).some((lease) => lease.kind === "wake");
    if (autonomy.cancelWake(threadId) || cutWake) {
      store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: "Despertador cancelado — parado por você", ok: true } });
    }
    finishGoalWithChip(threadId, "stopped", "stopped by you");
  }

  function finishGoalWithChip(threadId: string, status: "stopped" | "limit" | "blocked", detail: string): void {
    const goal = autonomy.finishGoal(threadId, status, detail);
    if (goal) store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: goalEndChip(goal), ok: false } });
  }

  /** Where a watch command runs: the conversation's project folder, else the
   * bot's, else home — the same folder the bot's own commands start in. */
  function watchCwd(botId: string, threadId: string): string {
    const cwd = store.taskByThread(botId, threadId)?.cwd ?? store.bot(botId)?.cwd;
    return cwd && existsSync(cwd) ? cwd : homedir();
  }

  async function runDueWatches(): Promise<void> {
    const watches = autonomy.watchesToRun();
    await Promise.all(watches.map(async (wake) => {
      if (!store.taskByThread(wake.botId, wake.threadId)) return;
      const watch = wake.watch!;
      const result = await runWatchCommand(watch.argv, { cwd: watchCwd(wake.botId, wake.threadId), path: augmentedPath(), ignore: watch.ignore });
      const owner = store.bot(wake.botId);
      const echoBefore = watch.echoAt;
      autonomy.recordWatchRun(wake, { ...result, matched: result.ok && watchMatches(result.output, watch.until), ...(owner ? { ownMark: botMarkPattern(owner.name, botSlug(owner.name)) } : {}) });
      // every echo let pass is said: in server.log, and with a chip where the watch runs
      if (watch.echo && watch.echoAt !== echoBefore) {
        const label = watch.label ?? watchLabel(watch.command);
        console.log(`[watch-echo] ${label} in ${wake.threadId} of ${owner?.name ?? wake.botId}: ${watch.echo.lines} line(s) taken as its own write (${watch.echo.reasons.join("; ")}): ${watch.echo.sample}`);
        if (store.taskByThread(wake.botId, wake.threadId)) {
          store.appendMessage(wake.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Vigia ${label}: a mudança era sua (${watch.echo.reasons[0]}), não acordei — ${watch.echo.sample}`, 240), ok: true } });
        }
      }
    }));
    // Rows show each watch's last run and failures: refresh the bots that ran one.
    for (const botId of new Set(watches.map((wake) => wake.botId))) refreshBotRow(botId);
    // A standing watch that sees only old items and never changes is likely
    // looking at the wrong page: say so once, where it runs and to the Chief.
    for (const wake of autonomy.staleWatches()) {
      autonomy.markWatchStaleAlerted(wake);
      const bot = store.bot(wake.botId);
      if (!bot || !store.taskByThread(bot.id, wake.threadId)) continue;
      alertAutomationTrouble(bot, wake.threadId, `Vigia permanente ${wake.watch!.label ? `"${wake.watch!.label}" ` : ""}em ${watchLabel(wake.watch!.command)} não muda há horas e só mostra itens com mais de 24 h — ele pode estar olhando a página errada (ex.: gog sem --order "createTime desc") e não ver nada novo`);
    }
  }

  function refreshBotRow(botId: string): void {
    const bot = store.bot(botId);
    if (bot) broadcast({ kind: "bot", bot: wireBot(bot) });
  }

  /** A watcher bot left without any standing watch for a while: say so where
   * it runs and to the Chief — nothing new is detected until it re-arms one. */
  function alertLostStandingWatches(): void {
    for (const lost of autonomy.standingLostDue()) {
      autonomy.markStandingLostAlerted(lost.threadId);
      const bot = store.bot(lost.botId);
      if (!bot || !store.taskByThread(bot.id, lost.threadId)) continue;
      alertAutomationTrouble(bot, lost.threadId, `${bot.name} está sem vigia permanente nesta conversa há mais de 10 min — nada novo é detectado até rearmar um (wake_when com standing)`);
      refreshBotRow(bot.id);
    }
  }

  /** A promise past its time and not marked kept: told once to the bot, in
   * its conversation, and to its Chief of Staff. */
  function alertOverduePromises(): void {
    const now = Date.now();
    for (const promise of autonomy.overduePromises()) {
      autonomy.markPromiseOverdue(promise.id);
      const bot = store.bot(promise.botId);
      if (!bot || !store.taskByThread(bot.id, promise.threadId)) continue;
      const text = promiseOverdueReport(promise, bot.name, now);
      store.appendMessage(promise.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Promessa ${promise.id} passou do prazo — ${promise.text}`, 240), ok: false } });
      autonomy.addReport(bot.id, promise.threadId, text);
      const chief = chiefForBot(store.bots, bot);
      const desk = chief && chief.id !== bot.id ? chiefDeskThread(chief) : null;
      if (chief && desk && store.taskByThread(chief.id, desk)) {
        store.appendMessage(desk, {
          role: "bot",
          kind: "activity",
          tool: { name: chipText(`${bot.name}: promessa passou do prazo — ${promise.text}`, 240), ok: false },
          threadRef: { botId: bot.id, threadId: promise.threadId, title: store.taskByThread(bot.id, promise.threadId)?.title ?? `${bot.name}'s conversation` },
        });
        autonomy.addReport(chief.id, desk, `${text}\n(${bot.name}'s conversation ${promise.threadId}: make sure the person gets an answer.)`);
      }
      refreshBotRow(bot.id);
    }
  }

  /** Low disk where the work happens: told once per band to the Chief of Staff. */
  // Only the server the desktop app runs watches this Mac's disk. Test and
  // verification servers share the same real disk and must not wake their
  // scripted Chief about it (it would start turns the tests never planned).
  const diskWatch = new DiskWatch({
    paths: DESKTOP_MANAGED && !process.env.VITEST ? [join(homedir(), "Projetos"), DATA_DIR].filter((path) => existsSync(path)) : [],
    statePath: join(DATA_DIR, "disk-watch.json"),
  });

  function checkDiskSpace(): void {
    const drops = diskWatch.check();
    if (!drops.length) return;
    const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
    for (const drop of drops) {
      // with what the worktree report last measured outside the tag, and no "free space" order to a bot (R10-resilience D)
      const alert = diskAlertText(drop, deps.releasedCleanup.lastStale);
      console.warn(`[disk] ${alert.report.split("\n")[0]}`);
      const desk = chief ? chiefDeskThread(chief) : null;
      if (!chief || !desk || !store.taskByThread(chief.id, desk)) continue;
      store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(alert.chip, 200), ok: false } });
      autonomy.addReport(chief.id, desk, `[Alerta do servidor] ${alert.report}`);
    }
  }

  /** Goals waiting on the person about a PR: every 10 min, ask gh what became
   * of the PRs their question cites (citedPrsOutcome). All merged: the question
   * is moot, but merge is not delivery, so the goal resumes and the bot is told
   * to check the result. One closed without merge: the bot is told once and the
   * goal keeps waiting. The server never closes the goal as completed here. */
  const needsInputChecks = new Map<string, number>();
  let needsInputRunning = false;
  async function revalidateNeedsInputGoals(): Promise<void> {
    if (needsInputRunning) return;
    needsInputRunning = true;
    try {
      const now = Date.now();
      for (const goal of autonomy.needsInputGoals()) {
        // left unanswered too long: shown as stopped, no longer "needs you"
        const since = goal.finishedAt ?? goal.startedAt;
        if (now - since > NEEDS_INPUT_EXPIRE_MS) {
          const detail = `sem resposta há mais de ${Math.round(NEEDS_INPUT_EXPIRE_MS / 3_600_000)} h — parado desde ${new Date(since).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}. Pergunta que ficou: ${chipText(goal.detail ?? "", 160)}`;
          if (autonomy.resolveNeedsInput(goal.threadId, detail, "blocked")) {
            store.appendMessage(goal.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Objetivo parado: ${detail}`, 240), ok: false } });
            refreshBotRow(goal.botId);
          }
          continue;
        }
        if (now - (needsInputChecks.get(goal.threadId) ?? 0) < 10 * 60_000) continue;
        needsInputChecks.set(goal.threadId, now);
        // the question is what the world may answer: the PRs it cites, not the goal's own text
        const prs = goalCitedPrs(goal.detail ?? "");
        if (!prs.length || prs.length > NEEDS_INPUT_PR_CHECK_MAX) continue;
        const states: CitedPrState[] = [];
        for (const pr of prs) {
          try {
            const view = JSON.parse(await deps.execCc("gh", ["pr", "view", String(pr.number), ...(pr.slug ? ["--repo", pr.slug] : []), "--json", "state,mergedAt,closedAt"], watchCwd(goal.botId, goal.threadId))) as { state?: string; mergedAt?: string | null; closedAt?: string | null };
            const changedAt = Date.parse(view.mergedAt ?? view.closedAt ?? "");
            states.push({ number: pr.number, state: view.state ?? "?", explicit: pr.explicit, ...(Number.isFinite(changedAt) ? { changedAt } : {}) });
          } catch (error) {
            // a bare number that is an issue is not cited as a PR at all
            if (notAPullRequest(error)) continue;
            states.push({ number: pr.number, state: "?", explicit: pr.explicit });
          }
        }
        const outcome = citedPrsOutcome(states, goal.finishedAt ?? goal.startedAt);
        if (!outcome) continue;
        if (outcome.kind === "merged" ? !autonomy.resumeGoalAfterInput(goal.threadId) : !autonomy.notePrNotice(goal.threadId, outcome.signature)) continue;
        autonomy.addReport(goal.botId, goal.threadId, outcome.report);
        store.appendMessage(goal.threadId, { role: "bot", kind: "activity", tool: { name: chipText(outcome.chip, 240), ok: outcome.kind === "merged" } });
        refreshBotRow(goal.botId);
      }
    } finally {
      needsInputRunning = false;
    }
  }

  /** A production release that fails twice on the same commit: a red chip and
   * a report on the Chief's desk (server/release-watch.ts). Only the server the
   * desktop app runs reads this Mac's release logs, every 2 min. */
  const releaseWatch = { state: DESKTOP_MANAGED && !process.env.VITEST ? new ReleaseWatchState(join(DATA_DIR, "release-watch.json")) : null, lastAt: 0, quiet: new Set<string>() };
  /** A release alert on the Chief's desk: a red chip and a report. */
  function releaseAlertToChief(text: string, report: string, logPrefix = "release"): void {
    console.warn(`[${logPrefix}] ${text}`);
    const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
    const desk = chief ? chiefDeskThread(chief) : null;
    // "Agora" shows the release alerts the Chief got, and where (lot Y); power alerts are not release news
    if (logPrefix === "release") deps.nowStatus.recordAlert({ text: chipText(text, 240), ...(chief && desk ? { botId: chief.id, threadId: desk } : {}) });
    if (!chief || !desk || !store.taskByThread(chief.id, desk)) return;
    store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(text, 240), ok: false } });
    autonomy.addReport(chief.id, desk, report);
  }

  /** The production tag's commit now (`git ls-remote`, no fetch), or null when unreadable. */
  async function readProductionTag(): Promise<string | null> {
    try {
      return parseLsRemoteTag(await deps.execCc("git", ["-C", join(homedir(), "Projetos", "nuria-platform"), "ls-remote", "origin", `refs/tags/${PRODUCTION_TAG}`, `refs/tags/${PRODUCTION_TAG}^{}`]), PRODUCTION_TAG);
    } catch {
      return null;
    }
  }

  /** The watcher's halt of a tip (nuria-platform #N), if any. */
  function readHaltedRelease(): ReturnType<typeof haltedRelease> {
    return haltedRelease({ escalationJson: readTail(HALT_ESCALATION_FILE, 8 * 1024), haltedSha: readTail(HALTED_SHA_FILE, 200), haltedReason: readTail(HALTED_REASON_FILE, 200) });
  }

  /** Production ran ahead of the tag (GH013), or the watcher halted a tip: told once each. */
  async function checkReleaseAftermath(state: ReleaseWatchState, released: string): Promise<void> {
    const halted = readHaltedRelease();
    let haltMatters = false;
    if (halted && !state.wasTold(`halt:${halted.sha}`)) {
      // a .sha left behind after a LATER successful release is not news (main moving is not evidence)
      const repo = join(homedir(), "Projetos", "nuria-platform");
      const releasedContainsHalt = released
        ? await deps.execCc("git", ["-C", repo, "merge-base", "--is-ancestor", halted.sha, released]).then(() => true, (error: unknown) => ((error as { code?: unknown }).code === 1 ? false : null))
        : null;
      const mtime = (path: string) => { try { return statSync(path).mtimeMs; } catch { return null; } };
      const releasedAtMs = mtime(RELEASED_SHA_FILE);
      const haltedAtMs = mtime(HALTED_SHA_FILE);
      haltMatters = haltStillMatters({ haltedSha: halted.sha, releasedSha: released, releasedContainsHalt, releasedAtMs, haltedAtMs });
      if (!haltMatters && !releaseWatch.quiet.has(`halt:${halted.sha}`) && releaseWatch.quiet.add(`halt:${halted.sha}`)) console.log(`[release] halt of ${halted.sha.slice(0, 9)} left behind: a later release went through (${released.slice(0, 9)}, contains it: ${releasedContainsHalt}) — no alert`);
    }
    // the watcher's "needs attention" (lot P): a failure before the CI or a signal, not halted —
    // told once per write (one per failure signature), to the conversation with the owner
    const attention = releaseAttention(readTail(ATTENTION_ESCALATION_FILE, ATTENTION_FILE_MAX_BYTES + 1));
    if (attention && releaseAttentionDue(attention, { now: Date.now(), releasedSha: released }) && state.once(attention.key)) {
      const alert = releaseAttentionAlert(attention, { err: RELEASE_ERR_LOG });
      releaseAlertToChief(alert.text, alert.report);
    }
    if (halted && haltMatters && state.once(`halt:${halted.sha}`)) {
      const alert = haltReport(halted, { halted: HALTED_SHA_FILE, escalation: HALT_ESCALATION_FILE, lastFailure: LAST_FAILURE_FILE });
      releaseAlertToChief(alert.text, `${alert.report}\n${productionStateLine(await readProductionTag())}`);
    }
    if (!released) return;
    const repo = join(homedir(), "Projetos", "nuria-platform");
    let tagSha: string | null = null;
    let contains: boolean | null = null;
    try {
      tagSha = parseLsRemoteTag(await deps.execCc("git", ["-C", repo, "ls-remote", "origin", `refs/tags/${PRODUCTION_TAG}`, `refs/tags/${PRODUCTION_TAG}^{}`]), PRODUCTION_TAG);
    } catch { return; /* the tag could not be read: nothing to say */ }
    if (tagSha && (tagSha.startsWith(released) || released.startsWith(tagSha))) contains = true;
    else if (tagSha) {
      // ls-remote does not fetch: both commits must be in this clone before merge-base can say "not contained"
      const known = async (sha: string) => deps.execCc("git", ["-C", repo, "cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false);
      const [releasedKnown, tagKnown] = await Promise.all([known(released), known(tagSha)]);
      let isAncestor: boolean | null = null;
      if (releasedKnown && tagKnown) {
        isAncestor = await deps.execCc("git", ["-C", repo, "merge-base", "--is-ancestor", released, tagSha])
          .then(() => true, (error: unknown) => ((error as { code?: unknown }).code === 1 ? false : null));
      }
      contains = tagContainsRelease({ releasedKnown, tagKnown, isAncestor });
      if (contains === null && !releaseWatch.quiet.has(`tag:${tagSha}:${released}`) && releaseWatch.quiet.add(`tag:${tagSha}:${released}`)) console.log(`[release] tag ${PRODUCTION_TAG} at ${tagSha.slice(0, 9)} vs released ${released.slice(0, 9)}: not verifiable in ${repo} (commit missing here, or git failed) — no stuck-tag alert`);
    }
    await resolveTagAdvancePendings(repo, tagSha, released, contains);
    let releasedAt = Date.now();
    try { releasedAt = statSync(RELEASED_SHA_FILE).mtimeMs; } catch { return; }
    // the cause of THIS release only: its warning and the refusal just above it (stderr)
    const cause = tagStuckCause(readTail(RELEASE_ERR_LOG, 128 * 1024), released);
    const text = tagStuck({ releasedSha: released, releasedAt, tagSha, tagContainsRelease: contains, now: Date.now(), cause });
    if (text && state.once(`tag:${released}`)) {
      // the force push past the ruleset is the owner's: the command goes to the log and the owner's pending list, never to a bot's report
      const manual = tagManualAdvance(readTail(RELEASE_ERR_LOG, 128 * 1024), released);
      console.warn(`[release] tag ${PRODUCTION_TAG} stuck at ${tagSha?.slice(0, 9)} while production runs ${released.slice(0, 9)}; manual advance (owner only, needs the ruleset bypass): ${manual ?? "(not printed by the release)"}`);
      releaseAlertToChief(text, `${tagStuckReport(text, Boolean(manual))}\nLogs: ${RELEASE_OUT_LOG} e ${RELEASE_ERR_LOG}.`);
      const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
      const desk = chief ? chiefDeskThread(chief) : null;
      if (chief && desk && store.taskByThread(chief.id, desk)) {
        autonomy.addOwnerPending(chief.id, desk, tagAdvancePending(released, manual));
        refreshBotRow(chief.id);
      }
    }
  }

  /** The owner's "advance the tag" items close by themselves once the tag
   * contains their commit (by hand or by a later release): left open, the
   * command they point to would move the production tag back. */
  async function resolveTagAdvancePendings(repo: string, tagSha: string | null, released: string, releasedContained: boolean | null): Promise<void> {
    const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
    if (!chief || !tagSha) return;
    // by bot, not by the current desk: the desk can change, and the item would be left behind
    const open = autonomy.ownerPendingOf(chief.id).map((item) => item.key ?? "").filter((key) => key.startsWith("tag-advance:"));
    if (!open.length) return;
    const contained = new Map<string, boolean | null>();
    for (const key of open) {
      const sha = key.slice("tag-advance:".length);
      if (released && (sha.startsWith(released) || released.startsWith(sha))) contained.set(sha, releasedContained);
      else contained.set(sha, await deps.execCc("git", ["-C", repo, "merge-base", "--is-ancestor", sha, tagSha]).then(() => true, () => null));
    }
    const done = tagAdvanceToResolve(open, tagSha, (sha) => contained.get(sha) ?? null);
    for (const key of done) {
      for (const item of autonomy.resolveOwnerPending({ key })) refreshBotRow(item.botId);
      console.log(`[release] tag ${PRODUCTION_TAG} at ${tagSha.slice(0, 9)} contains ${key.slice("tag-advance:".length, "tag-advance:".length + 9)}: the owner's "advance the tag" item is closed`);
    }
  }

  /** The Mac's power (server/power.ts): on battery below the owner's limit
   * (20% unless config.power.batteryMinPercent), the Chief and the person hear
   * it and the Chief's carrier orders are held; above it, nothing. */
  const POWER_WATCH_FILE = join(DATA_DIR, "power-watch.json");
  const powerWatch: { state: PowerState | null; watch: PowerWatchState | null; lastAt: number } = { state: null, watch: null, lastAt: 0 };
  async function checkPower(): Promise<void> {
    if (!DESKTOP_MANAGED || process.env.VITEST || process.platform !== "darwin" || Date.now() - powerWatch.lastAt < 2 * 60_000) return;
    powerWatch.lastAt = Date.now();
    const output = await deps.execCc("/usr/bin/pmset", ["-g", "batt"]).catch(() => "");
    if (!output.trim()) return; // pmset failed: nothing known, nothing said or resolved
    const power = parsePmsetBatt(output);
    powerWatch.state = power;
    powerWatch.watch ??= readPowerWatch(existsSync(POWER_WATCH_FILE) ? readFileSync(POWER_WATCH_FILE, "utf8") : null);
    const releaseRunning = power.onBattery && (await psTable()).some((row) => isReleaseProcess(row.command));
    // the discharge counts from when the Mac left the wall (pmset's own log),
    // not from this server's first look: read ONCE per discharge, found or not (R9-resilience BAT-T0, INSP-H r1 #9)
    const logRead = shouldReadPmsetLog(powerWatch.watch, power);
    const unpluggedAt = logRead ? lastUnplugAt(await execPmsetLog().catch(() => ""), Date.now()) : null;
    const step = powerStep(powerWatch.watch, power, Date.now(), releaseRunning, { minPercent: batteryMinPercent(cfg.power?.batteryMinPercent), unpluggedAt, logRead });
    powerWatch.watch = step.watch;
    if (step.changed) {
      try { writeFileSync(POWER_WATCH_FILE, JSON.stringify(step.watch)); } catch { /* memory still holds it */ }
    }
    if (step.resolvePending) for (const item of autonomy.resolveOwnerPending({ key: POWER_PENDING_KEY })) refreshBotRow(item.botId);
    const alert = step.alert;
    if (!alert) return;
    releaseAlertToChief(alert.text, `[Alerta do servidor: Mac na bateria] ${alert.text}`, "power");
    const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
    const desk = chief ? chiefDeskThread(chief) : null;
    if (chief && desk && store.taskByThread(chief.id, desk)) {
      autonomy.addOwnerPending(chief.id, desk, { title: alert.pendingTitle, key: POWER_PENDING_KEY, ...powerPendingDetails(releaseRunning) });
      refreshBotRow(chief.id);
    }
  }

  /** The pipeline standing still (server/pipeline-idle.ts): no open PR, no
   * release, and P0/P1 with nobody on them — the Chief is woken once, in its
   * desk, with the list (R12-followup #1). Only the desktop app's server looks
   * (OMB_PIPELINE_IDLE=1 lets a test's server look too), every 10 min. */
  const PIPELINE_IDLE_FILE = join(DATA_DIR, "pipeline-idle.json");
  const pipelineIdle: { state: PipelineIdleState | null; lastAt: number; running: boolean; lastWhy?: string } = { state: null, lastAt: 0, running: false };
  /** `gh` with JSON out, or why it failed (said in the log, R13-followup #5). */
  function ghJson(args: string[]): Promise<{ out: string | null; error?: string }> {
    return new Promise((resolve) => {
      execFileCc("gh", args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: augmentedPath() } }, (error, stdout, stderr) => resolve(error ? { out: null, error: `gh ${args.slice(0, 2).join(" ")} falhou: ${(String(stderr ?? "").trim().split("\n").at(-1) || error.message).slice(0, 160)}` } : { out: String(stdout) }));
    });
  }
  /** A look's why, logged when it changed. */
  function logPipelineIdleWhy(why: string): void {
    const line = pipelineIdleLogLine(pipelineIdle.lastWhy, why);
    pipelineIdle.lastWhy = why;
    if (line) console.log(line);
  }
  async function checkPipelineIdle(): Promise<void> {
    const enabled = process.env.OMB_PIPELINE_IDLE === "1" || (DESKTOP_MANAGED && !process.env.VITEST);
    const every = autonomyTestMs("OMB_PIPELINE_IDLE_EVERY_MS") ?? PIPELINE_IDLE_EVERY_MS;
    if (!enabled || pipelineIdle.running || Date.now() - pipelineIdle.lastAt < every) return;
    const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
    if (!chief) return;
    pipelineIdle.running = true;
    pipelineIdle.lastAt = Date.now();
    try {
      if (!pipelineIdle.state) {
        try { pipelineIdle.state = JSON.parse(readFileSync(PIPELINE_IDLE_FILE, "utf8")) as PipelineIdleState; } catch { pipelineIdle.state = {}; }
      }
      const stopped = existsSync(NURIA_STOP_FILE);
      const prs = stopped ? null : await ghJson(idlePrsArgs(PRODUCTION_REPO));
      const openPrs = stopped ? 0 : prs?.out == null ? null : parseOpenPrCount(prs.out, Date.now());
      let unknown = prs?.error ?? (prs?.out != null && openPrs === null ? "gh pr list ilegível" : undefined);
      let releaseInFlight: boolean | null = false;
      if (!stopped && openPrs === 0) {
        await deps.refreshReleaseHold();
        // read now by this call or another: anything older, or still being read, is unknown (INSP-R12F F4)
        releaseInFlight = releaseInFlightOf(deps.releaseHold, Date.now(), 2 * deps.RELEASE_HOLD_EVERY_MS);
        if (releaseInFlight === null) unknown = "release ainda não lido";
      }
      const now = Date.now();
      let candidates: IdleCandidate[] = [];
      if (!stopped && openPrs === 0 && releaseInFlight === false) {
        const issues = await ghJson(idleIssuesArgs(PRODUCTION_REPO));
        const parsed = issues.out === null ? null : parseIdleIssues(issues.out);
        if (parsed === null) return logPipelineIdleWhy(`estado desconhecido (${issues.error ?? "gh issue list ilegível"})`);
        // a bot named it in the last day, or an open "Precisa de você" item waits on the owner for it
        const taken = new Set([...mentionedNumbers(botTextsWithRefsSince(now - PIPELINE_IDLE_QUIET_MS)), ...heldByOwner(store.bots.flatMap((bot) => autonomy.ownerPendingOf(bot.id)))]);
        candidates = idleCandidates(parsed, deps.ccLedger.all(), taken, now);
      }
      const step = pipelineIdleStep(pipelineIdle.state, { stopped, openPrs, releaseInFlight, candidates, now, ...(unknown ? { unknown } : {}) });
      logPipelineIdleWhy(step.why);
      if (!step.wake) return;
      const desk = chiefDeskThread(chief);
      // "told" is kept only once the report is on the Chief's desk (INSP-R12F F5)
      if (!store.taskByThread(chief.id, desk)) return;
      const order = pipelineOrder(deps.sharedState.orders(chief.id));
      store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(`Esteira parada: fila de PRs vazia, sem release, ${candidates.length} P0/P1 sem ninguém nelas (${candidates.slice(0, 4).map((each) => `#${each.number}`).join(", ")}${candidates.length > 4 ? ", …" : ""}) — o Chief foi avisado`, 240), ok: true } });
      autonomy.addReport(chief.id, desk, pipelineIdleReport(candidates, PRODUCTION_REPO, order));
      pipelineIdle.state = step.state;
      try { writeFileAtomic(PIPELINE_IDLE_FILE, `${JSON.stringify(step.state)}\n`); } catch { /* memory still holds it */ }
      refreshBotRow(chief.id);
      console.log(`[pipeline-idle] the pipeline stands still: ${candidates.length} P0/P1 with nobody on them (${candidates.map((each) => `#${each.number}`).join(" ")}); the Chief is told in ${desk}`);
    } finally {
      pipelineIdle.running = false;
    }
  }

  /** The Mac's power right now, for an answer that claims it (INSP-J2 r2 N4):
   * null when unknown (not a Mac, pmset failed). OMB_TEST_PMSET_BATT stands in
   * for `pmset -g batt` in the e2e tests. */
  async function readPowerNow(): Promise<PowerState | null> {
    const fake = process.env.OMB_TEST_PMSET_BATT;
    if (fake !== undefined) return fake.trim() ? parsePmsetBatt(fake) : null;
    if (process.platform !== "darwin") return null;
    const output = await deps.execCc("/usr/bin/pmset", ["-g", "batt"]).catch(() => "");
    if (!output.trim()) return null;
    powerWatch.state = parsePmsetBatt(output);
    return powerWatch.state;
  }

  /** `pmset -g log` (several MB): only the lines that say which power source was in use. */
  function execPmsetLog(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFileCc("/usr/bin/pmset", ["-g", "log"], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).split("\n").filter((line) => /\bUsing (?:AC|Batt)/i.test(line)).join("\n"))));
    });
  }

  /** On battery below the owner's limit (20% unless configured): an order to
   * run a carrier is refused; a mere mention of one (a failed run to
   * investigate) goes through with a note for the session. Above it: nothing. */
  function carrierPowerCheck(text: string): { refusal: string } | { note: string } | null {
    return carrierBatteryCheck(powerWatch.state, carrierIntent(text), batteryMinPercent(cfg.power?.batteryMinPercent));
  }

  async function checkProductionRelease(): Promise<void> {
    if (!releaseWatch.state || Date.now() - releaseWatch.lastAt < 2 * 60_000) return;
    releaseWatch.lastAt = Date.now();
    const released = readTail(RELEASED_SHA_FILE, 200).trim();
    await checkReleaseAftermath(releaseWatch.state, released);
    const failed = releaseFailures(readTail(RELEASE_ERR_LOG, 128 * 1024), released);
    const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
    const halted = readHaltedRelease();
    const declined = readTail(DECLINED_SHA_FILE, 200).trim();
    const isHalted = Boolean(failed && halted && sameSha(halted.sha, failed.sha));
    const isDeclined = Boolean(failed && /^[0-9a-f]{7,40}$/.test(declined) && sameSha(declined, failed.sha));
    // the owner refused it, the watcher halted it, or it is no longer the commit failing: its item is done
    settleReleaseLoopPendings(failed && !isHalted && !isDeclined ? failed.sha : null);
    if (!failed) return;
    // a later release that already contains the failed commit settles it
    if (released) {
      try {
        await deps.execCc("git", ["-C", join(homedir(), "Projetos", "nuria-platform"), "merge-base", "--is-ancestor", failed.sha, released]);
        settleReleaseLoopPendings(null);
        return;
      } catch { /* not an ancestor, or unknown here: alert */ }
    }
    const outTail = readTail(RELEASE_OUT_LOG, 512 * 1024);
    const cause = releaseFailureCause(outTail);
    releaseWatch.state.observe(failed.sha, failed.count, Date.now(), cause);
    const told = releaseWatch.state.take(failed.sha, failed.count);
    // the same commit failing the same way, again and again: ONE item for the
    // owner, with the one command the installed watcher respects (never "halted");
    // never when the watcher says it is the machine (attention.json, lot P)
    const attention = releaseAttention(readTail(ATTENTION_ESCALATION_FILE, ATTENTION_FILE_MAX_BYTES + 1));
    const machine = Boolean(attention && sameSha(attention.sha, failed.sha) && releaseAttentionDue(attention, { now: Date.now(), releasedSha: released }));
    const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
    const desk = chief ? chiefDeskThread(chief) : null;
    const loopKey = releaseLoopPending({ short: failed.sha, full: null, count: failed.count }).key;
    const itemOpen = Boolean(chief && autonomy.ownerPendingOf(chief.id).some((item) => item.key === loopKey));
    const plan = releaseLoopPlan({ sha: failed.sha, count: failed.count, halted: isHalted, declined: isDeclined, machine, told, itemOpen, state: releaseWatch.state });
    let loopItem: OwnerPending | null = null;
    if (plan.upsert && chief && desk && store.taskByThread(chief.id, desk)) {
      // the full sha: git knows it (the release's own label sits MBs above the tail read here)
      const full = await deps.execCc("git", ["-C", join(homedir(), "Projetos", "nuria-platform"), "rev-parse", "--verify", `${failed.sha}^{commit}`]).then((out) => out.trim(), () => fullReleaseSha(outTail, failed.sha));
      loopItem = autonomy.addOwnerPending(chief.id, desk, releaseLoopPending({ short: failed.sha, full: /^[0-9a-f]{40}$/.test(full ?? "") ? full : null, count: failed.count, cycleMs: releaseWatch.state.cycleMs(failed.sha) }));
      refreshBotRow(chief.id);
    } else if (plan.loop && chief) {
      loopItem = autonomy.ownerPendingOf(chief.id).find((item) => item.key === loopKey) ?? null;
    }
    if (told && !plan.report) console.log(`[release] ${failed.sha.slice(0, 9)} failed again (${failed.count}×, same cause): ${loopItem ? `only ${loopItem.id}'s title refreshed` : "the owner already had the item"} — the Chief is not woken`);
    if (!plan.report) return;
    // the chip opens with the essential (INSP-H r1 #8); the full cause goes in the report
    const text = releaseFailedText(failed.sha, failed.count, cause);
    // after the watcher's halt it does not retry: never say it does; and never "every 2 min" (R9-release #7)
    const retries = releaseRetryText({ halted: isHalted, ...(isHalted && halted ? { haltCode: halted.reasonCode } : {}), cycleMs: releaseWatch.state.cycleMs(failed.sha), nothingToPublish: nothingToPublish(cause) });
    const ownerItem = loopItem
      ? ` O dono já tem UM item em "Precisa de você" para recusar este commit (${loopItem.id}): ${loopItem.title}${loopItem.command ? ` (comando, com botão de copiar no item: ${loopItem.command})` : ""}. Cite ${loopItem.id}; não abra outro item para este laço nem proponha o arquivo halted-production-release.sha (quem o escreve é o watcher, ao parar um commit: escrito à mão, faz o servidor relatar um halt que não houve) nem desligar o LaunchAgent.`
      : "";
    releaseAlertToChief(text, `[Alerta do servidor: release de produção falhando] ${text}${cause ? ` Último motivo: ${cause}.` : ""}\nLogs: ${RELEASE_ERR_LOG} e ${RELEASE_OUT_LOG}. ${retries}${ownerItem} Veja se é carga da máquina (CI concorrente, timeouts) ou falha real, avise quem precisa (SRE/Delivery, o dono) e não dê a entrega como feita ao cliente.\n${productionStateLine(await readProductionTag())}`);
  }

  /** The owner's "refuse the looping release" items whose commit is no longer
   * the one failing (`failing`: the commit still looping, or null) are done:
   * refused, halted, released, or main moved on. */
  function settleReleaseLoopPendings(failing: string | null): void {
    // every bot's items, keyed or not: the real o7 (keyless) asked to pause the watcher on a commit already refused
    for (const bot of store.bots) {
      for (const item of releaseLoopItemsToClose(autonomy.ownerPendingOf(bot.id), failing)) {
        for (const done of autonomy.resolveOwnerPending({ botId: bot.id, id: item.id })) refreshBotRow(done.botId);
        console.log(`[release] the loop is over (refused, halted, released or no longer failing): ${bot.name}'s item ${item.id} ("${item.title.slice(0, 80)}") is closed`);
      }
    }
  }

  /** Older items without steps: the server asks their bot once each (J17), the
   * owner does not have to click "Pedir o passo a passo". Not in the first
   * minutes after a boot (the boot's own work goes first), never while
   * ~/.nuria/stop exists, one item per bot per minute; the request is a report,
   * so it wakes the bot only when its conversation is free, like any report. */
  const STEPS_ASK_AFTER_BOOT_MS = Number(process.env.OMB_OWNER_STEPS_ASK_AFTER_MS) >= 0 && process.env.OMB_OWNER_STEPS_ASK_AFTER_MS !== undefined ? Number(process.env.OMB_OWNER_STEPS_ASK_AFTER_MS) : 3 * 60_000;
  const stepsAsk = { bootAt: Date.now(), lastAt: 0, questionsAt: 0 };
  const NURIA_STOP_FILE = join(homedir(), ".nuria", "stop");
  function askStepsForOlderItems(): void {
    const now = Date.now();
    // settling never sends anything to a bot: it runs even with ~/.nuria/stop
    settleAnsweredQuestions();
    // a routine's item it stopped repeating says so, still open (INSP-N22 A8)
    for (const item of markStaleRoutineAsks(autonomy, now)) refreshBotRow(item.botId);
    if (now - stepsAsk.bootAt < STEPS_ASK_AFTER_BOOT_MS || existsSync(NURIA_STOP_FILE)) return;
    // a bare question is looked at every minute on its own: an item's pace must not hold it back
    if (now - stepsAsk.questionsAt >= QUESTION_STEPS_PACE_MS) {
      stepsAsk.questionsAt = now;
      askStepsForQuestions(now);
    }
    if (now - stepsAsk.lastAt < 60_000) return;
    stepsAsk.lastAt = now;
    // the server's own items, saved by an older build: the server completes them, never their bot (INSP-J2 #5)
    for (const item of autonomy.serverItemsIncomplete()) {
      const details = serverItemDetails(item);
      if (!details) continue;
      autonomy.addOwnerPending(item.botId, item.threadId, { title: item.title, key: item.key!, ...details });
      console.log(`[owner-pending] server item ${item.id} (${item.key}) completed with why/steps/options by the server`);
      refreshBotRow(item.botId);
    }
    // a bot's own items: ONE report per bot, listing each with what it lacks
    const byBot = new Map<string, OwnerPending[]>();
    for (const item of autonomy.ownerPendingNeedingSteps()) byBot.set(item.botId, [...(byBot.get(item.botId) ?? []), item]);
    for (const [botId, items] of byBot) {
      const target = deps.ownerTurnThread(botId, items[0]!.threadId);
      if (!store.taskByThread(botId, target)) continue;
      for (const item of items) autonomy.markOwnerPendingStepsAutoAsked(botId, item.id);
      autonomy.addReport(botId, target, ownerPendingStepsAutoReport(items));
      console.log(`[owner-pending] ${store.bot(botId)?.name ?? botId}: ${items.map((item) => item.id).join(", ")} lack ${[...new Set(items.flatMap(missingParts))].join("/")}: one report, in ${target}`);
      refreshBotRow(botId);
    }
  }

  /** A question a bot ended its turn with (lot J2): the line "Precisa de você"
   * shows has no why, steps nor options — the bot is asked, once, to register
   * it as an item that takes its place. Not in a routine's run nor an archived
   * conversation (the panel does not show those lines either), and only when
   * it has waited 30 min with the person silent in that conversation — a live
   * exchange is never interrupted (INSP-J2b #3). */
  function askStepsForQuestions(now: number): void {
    for (const bot of store.bots) {
      if (bot.hidden) continue;
      for (const task of store.tasks(bot.id)) {
        if (task.routineRunId || task.archivedAt || task.activity === "waiting-on-you") continue;
        const at = goalNeedsInputForThread(task.threadId);
        if (at === null || now - at < QUESTION_STEPS_ASK_AFTER_MS || questionPromotion(task.threadId, at) || personSpokeSince(task.threadId, at)) continue;
        askQuestionSteps(bot.id, task.threadId, at);
      }
    }
  }

  /** The person answered a question in its own conversation after the server
   * asked for its item (INSP-J2b #3): the item the bot opened for it is
   * settled as "respondida na conversa" — unless the person was already
   * answering the item itself — and a request still waiting is withdrawn. */
  function settleAnsweredQuestions(): void {
    for (const promotion of autonomy.allAskPromotions()) {
      if (promotion.answeredAt !== undefined || !store.taskByThread(promotion.botId, promotion.threadId)) continue;
      const answer = questionAnswer(promotion);
      if (!answer) continue;
      autonomy.markAskAnswered(promotion);
      autonomy.dropReports(promotion.reportThreadId, (each) => { const ref = questionReportRef(each); return ref?.threadId === promotion.threadId && ref.askAt === promotion.askAt; });
      const item = autonomy.askPromotionOpenItem(promotion);
      if (item && !item.history?.length) {
        for (const done of autonomy.resolveOwnerPending({ botId: item.botId, id: item.id, by: "owner", note: ANSWERED_IN_CONVERSATION })) {
          if (store.taskByThread(done.botId, done.threadId)) store.appendMessage(done.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Resolvido (${ANSWERED_IN_CONVERSATION}): ${done.title}`, 240), ok: true } });
          // the bot hears it closed, as the server, where the person answered (INSP-J2b r2 c-2)
          autonomy.addReport(done.botId, promotion.threadId, answeredInConversationReport(done, promotion, answer.text));
          console.log(`[owner-pending] ${done.id} settled: the person answered its question in ${promotion.threadId}`);
        }
      }
      refreshBotRow(promotion.botId);
    }
  }

  /** The person's message answering the promoted question, by answerToAsk: the
   * question's whole message (its #refs), else what the panel showed. */
  function questionAnswer(promotion: AskPromotion): { at: number; text: string } | null {
    const messages = store.messagesFor(promotion.threadId);
    const asked = messages.find((each) => each.at === promotion.askAt && each.role === "bot" && each.kind === "text")?.text ?? autonomy.goalFor(promotion.threadId)?.detail ?? "";
    return answerToAsk(messages, promotion.askAt, `${asked} ${promotion.text}`);
  }

  /** A bare question gets this long to be answered on the spot before its bot is asked for the item (INSP-J2b #3: 30 min). */
  const QUESTION_STEPS_ASK_AFTER_MS = Number(process.env.OMB_QUESTION_STEPS_ASK_AFTER_MS) >= 0 && process.env.OMB_QUESTION_STEPS_ASK_AFTER_MS !== undefined ? Number(process.env.OMB_QUESTION_STEPS_ASK_AFTER_MS) : 30 * 60_000;
  /** How often the bare questions are looked at: a minute (shrunk by the autonomy tests). */
  const QUESTION_STEPS_PACE_MS = autonomyTestMs("OMB_AUTONOMY_MINUTE_MS") ?? 60_000;
  /** "Pedir de novo" on a question: the same 15 min the screen waits before offering it (J17). */
  const QUESTION_STEPS_ASK_AGAIN_MS = 15 * 60_000;

  /** Asks the bot, as the server, to register the question its conversation
   * asked at `at` as an owner_pending item (lot J2): a report, the J17 way —
   * to the owner's channel, waiting for it to be free, dropped by ~/.nuria/stop
   * at dispatch. A request still waiting for the same question is replaced. */
  function askQuestionSteps(botId: string, threadId: string, at: number): AskPromotion | null {
    const target = deps.ownerTurnThread(botId, threadId);
    if (!store.taskByThread(botId, target)) return null;
    const title = store.taskByThread(botId, threadId)?.title;
    const text = goalNeedsInputAskForThread(threadId) ?? title ?? "";
    const asked = autonomy.noteAskPromotion({ botId, threadId, askAt: at, text, reportThreadId: target });
    autonomy.dropReports(target, (each) => { const ref = questionReportRef(each); return ref?.threadId === threadId && ref.askAt === at; });
    autonomy.addReport(botId, target, questionStepsAutoReport(asked, title));
    console.log(`[owner-pending] ${store.bot(botId)?.name ?? botId}: its question in ${threadId} ("${text.slice(0, 80)}") has no steps: asked to register it as an item, in ${target}`);
    refreshBotRow(botId);
    return asked;
  }

  /** A server item's why/steps/options, rebuilt from its key (an older build saved it bare). */
  function serverItemDetails(item: OwnerPending): { why: string; steps: OwnerPendingStep[]; options?: OwnerPendingOption[] } | null {
    const key = item.key ?? "";
    if (key.startsWith(deps.APP_UNBLOCK_KEY)) { const { why, steps, options } = appUnblockPending(key.slice(deps.APP_UNBLOCK_KEY.length)); return { why, steps, options }; }
    if (key === POWER_PENDING_KEY) { const { why, steps, options } = powerPendingDetails(false); return { why, steps, options }; }
    const tag = /^tag-advance:([0-9a-f]{7,40})$/.exec(key)?.[1];
    if (tag) { const { why, steps, options } = tagAdvancePending(tag, item.command ?? null); return { why, steps, options }; }
    const loop = /^release-loop:([0-9a-f]{7,40})$/.exec(key)?.[1];
    if (loop) {
      const full = /\b([0-9a-f]{40})\b/.exec(item.command ?? "")?.[1] ?? null;
      const { why, steps, options } = releaseLoopPending({ short: loop, full, count: Number(/(\d+)×/.exec(item.title)?.[1] ?? 3) });
      return { why, steps, options };
    }
    return null;
  }

  return { autonomyDispatchFailed, chiefDeskThread, ownerThreadGone, mainThreadOf, alertAutomationTrouble, stopAutonomyByPerson, finishGoalWithChip, watchCwd, runDueWatches, refreshBotRow, alertLostStandingWatches, alertOverduePromises, checkDiskSpace, revalidateNeedsInputGoals, releaseWatch, releaseAlertToChief, readHaltedRelease, checkPower, readPowerNow, carrierPowerCheck, checkProductionRelease, NURIA_STOP_FILE, askStepsForOlderItems, readProductionTag, checkPipelineIdle, pipelineIdle, PIPELINE_IDLE_FILE, QUESTION_STEPS_ASK_AGAIN_MS, askQuestionSteps, questionAnswer };
}
