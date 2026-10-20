// Claude Code sessions a bot manages, run by the server: turns, worktrees, the release hold, the start queue and the app watches.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { type WireCcAlert, type WireOwnerPending, type WireCcSession } from "../shared/wire.ts";
import { DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { toolCallsWith, userTextMessagesWith } from "./message-db.ts";
import { ownerWrote } from "./incidents.ts";
import { BotAutonomy, chipText, STANDING_DEFAULT_LABEL, watchLabel } from "./bot-autonomy.ts";
import { watchIgnoreWarnings } from "./wake-watch.ts";
import { CC_MAX_RUNNING, CC_TURN_TIMEOUT_MS, CcSessionLedger, ccProcAlive, PS_BIN, PS_ENV, ccReportForOwner, ccTurnArgs, lastHookBlock, lastHookDecision, parseCcStartInput, repoCorridor, cliSurfaceRefusal, appStalledReason, recentAppFailure, issueTitle, clientIssue, type AppAvailability, hotfixWithReleaseScripts, corridorVersionOf, repoPackageManager, repoScripts, useRepoScripts, parseCcStream, type CcSession } from "./cc-sessions.ts";
import {
  DESKTOP_IDLE_SECONDS,
  ensureHelper,
  findDesktopSession,
  lastAssistantText,
  macDesktopDriver,
  newMarker,
  lastAppRepo,
  liveWorktreeNames,
  liveRecordFolders,
  lastAppWorktreeFolder,
  lastServerSessionInRoot,
  reusedFolderRefusal,
  rootAnchorSession,
  rootFolderRefusal,
  readDesktopRecord,
  
  recordsUsingFolder,
  transcriptMentions,
  transcriptPath,
  transcriptTurnEnded,
  transcriptOpenQuestion,
  transcriptWrittenAt,
  type DesktopDriver,
} from "./claude-desktop.ts";
import { desktopBriefText, issueNumber, liveSessionForIssue, uniqueSessionTitle, reviveScreenFailures, screenWaitOf, reportFor as desktopReportFor, takeFreshQueued, type DesktopWorkDeps } from "./desktop-work.ts";
import { DESKTOP_HELPER_SOURCE } from "./claude-desktop-helper.ts";
import { BG_JOB_MAX_MS, cutLeftovers, parseLsofCwd, backgroundProcesses, bgJobOverdueReport, bgJobResumePrompt, jobAlive, newTurnTree, noteDescendants, psTable, type TurnTree } from "./bg-jobs.ts";
import { spawn as spawnCcProcess, execFile as execFileCc, execFileSync as execFileSyncCc, type ChildProcess as CcChildProcess } from "node:child_process";
import { claimedPrNumbers, claimsInToolCalls, githubSlug, parseLsRemoteTag, PRODUCTION_TAG, resumeNeeded } from "./prod-delivery.ts";
import { checkArchivedOutside, githubLookups } from "./archived-outside.ts";
import { sessionErrorPt } from "../shared/session-error-pt.ts";
import { SESSION_TOKEN_SERVICE, SessionToken } from "./session-token.ts";
import { appFlappingPending, appUnblockPending, flappingRefusal, type FolderBlockSeen, type FolderFlapState, noteFolderBlock, ownerChannelChip, serverRestartedChip, sessionChips, staleUnblockItem } from "./owner-chips.ts";
import { CHANNEL_ORDER_WORDS, lastChannelOrder, SharedState, threadByRef } from "./shared-state.ts";
import { channelTurnThread } from "./owner-channel.ts";
import { type AdmissionLease, ciQueuedBehindRelease, ciQueuedText, type DeployLease, preemptCiForRelease, type PreemptState, RELEASE_QUEUE_CEILING_S, releaseHoldText, releaseInFlight, type ReleaseIntent, releaseLabelSha, releaseOverdueText, resumeAfterRelease, stoppedReleaseFromLog } from "./release-priority.ts";
import { DECLINED_SHA_FILE, haltedRelease, readTail, RELEASE_ERR_LOG, RELEASE_OUT_LOG, RELEASED_SHA_FILE, releaseFailures, releaseInLoop, ReleaseWatchState } from "./release-watch.ts";
import { cloudHomeConfiguration } from "./cloud-home.ts";
import { CcStartQueue, drainStartQueue, priorityLabel, slotFreeForWork, START_QUEUE_MAX, startGate, startPriority, type StartResult } from "./cc-start-queue.ts";
import { archiveCleanupNote, codexRolloutFolders, planArchivedWorktree, planNestedWorktrees, planReleasedWorktrees, releasedPlanLine, releasedScopeLine, STALE_OUTSIDE_TAG_MS, type StaleFolder, staleFoldersReport, staleTaskWorkspaces, worktreeLastActivity } from "./nested-worktrees.ts";
import { Store, type BotRecord } from "./store.ts";
import { TASK_WORKSPACES_DIR } from "./workspace.ts";
import type { WireTask } from "../shared/wire.ts";

export interface CcRuntimeDeps {
  CLOUD_HOME: ReturnType<typeof cloudHomeConfiguration>;
  DESKTOP_MANAGED: boolean;
  alertAutomationTrouble: (bot: BotRecord, threadId: string, text: string) => void;
  autonomy: BotAutonomy;
  autonomyTestMs: (name: string) => number | undefined;
  carrierPowerCheck: (text: string) => { refusal: string } | { note: string } | null;
  chiefDeskThread: (chief: BotRecord, except?: string) => string;
  cloudOwnerOnlyThread: (threadId: string) => boolean;
  finishGoalWithChip: (threadId: string, status: "stopped" | "limit" | "blocked", detail: string) => void;
  mainThreadOf: (botId: string, except?: string) => string | null;
  ownerThreadGone: (botId: string, threadId: string, why: string) => void;
  readHaltedRelease: () => ReturnType<typeof haltedRelease>;
  refreshBotRow: (botId: string) => void;
  releaseAlertToChief: (text: string, report: string, logPrefix?: string) => void;
  releaseWatch: { state: ReleaseWatchState | null; lastAt: number; quiet: Set<string> };
  store: Store;
  setThreadSignals: (signals: (threadId: string) => ThreadSignals) => void;
}

type ThreadSignals = Pick<WireTask, "watches" | "watchesLost" | "ccAlerts" | "ownerPending" | "ccSessions">;

/** Built once, where server/index.ts used to declare all of this inline. */
export function createCcRuntime(deps: CcRuntimeDeps) {
  const { CLOUD_HOME, DESKTOP_MANAGED, alertAutomationTrouble, autonomy, autonomyTestMs, carrierPowerCheck, chiefDeskThread, cloudOwnerOnlyThread, finishGoalWithChip, mainThreadOf, ownerThreadGone, readHaltedRelease, refreshBotRow, releaseAlertToChief, releaseWatch, store, setThreadSignals } = deps;
  // ── what a bot's conversations know about each other (server/shared-state.ts)
  const sharedState = new SharedState(join(DATA_DIR, "bots"));

  // ── Claude Code sessions a bot manages (server/cc-sessions.ts) ─────────
  // a turn's claude that outlived the server is followed, not marked failed (R9-resilience RS-PID)
  const ccLedger = new CcSessionLedger({ path: join(DATA_DIR, "cc-sessions.json"), procAlive: ccProcAlive });
  // The owner's last channel order, read back from the history before
  // anything is reported: what the boot says goes to the conversation they named.

  /** Once per session: the PRs its orders handed it before claimedPrs existed
   * ("assuma a PR #N", 01/10 18:13, to the 29da943f), read back from the
   * bots' tool calls in messages.db (read only) — INSP-H r1 #1. */
  function backfillClaimedPrs(): void {
    const pending = ccLedger.all().filter((session) => session.claimsReadAt === undefined);
    if (!pending.length) return;
    try {
      const calls = [...toolCallsWith("cc_session_send"), ...toolCallsWith("cc_session_start")];
      for (const session of pending) {
        const sameTitle = (title: string) => {
          const named = issueTitle(title.trim());
          return session.title === named || session.title.startsWith(`${named} · `);
        };
        const claimed = claimsInToolCalls(calls, session.id, sameTitle);
        session.claimsReadAt = Date.now();
        if (!claimed.length) continue;
        session.claimedPrs = [...new Set([...(session.claimedPrs ?? []), ...claimed])];
        if (session.delivery?.notOwned) session.delivery.notOwned = session.delivery.notOwned.filter((number) => !claimed.includes(number));
        console.log(`[cc-sessions] ${session.id}: PRs handed to it before, read back from the history: ${claimed.map((number) => `#${number}`).join(", ")}`);
      }
      ccLedger.save();
    } catch (error) {
      console.error(`[cc-sessions] could not read back the PRs handed to sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // A restart cut these turns off: tell each owner, or nobody would ever resume them.
  // (the Chief's desk gets one summary of all of them: no chip twice there)
  let bootDesk: string | null = null;

  /** Standing watches armed before the warning existed, with an `ignore` that
   * swallows lines a person changed: said once in their conversation. */
  function warnArmedIgnores(): void {
    for (const wake of autonomy.standingWatches()) {
      const watch = wake.watch!;
      if (watch.ignoreWarnedAt !== undefined || !store.taskByThread(wake.botId, wake.threadId)) continue;
      const warnings = watchIgnoreWarnings(watch.ignore, watch.command);
      if (!warnings.length) continue;
      autonomy.markIgnoreWarned(wake);
      const label = watch.label ?? watchLabel(watch.command);
      store.appendMessage(wake.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Vigia ${label}: o ignore pode esconder mudanças de pessoas`, 200), ok: false } });
      autonomy.addReport(wake.botId, wake.threadId, `[Aviso do servidor sobre o vigia permanente "${label}"] ${warnings.join(" ")} Para trocar, arme de novo o vigia (wake_when, mesmo label) sem o ignore ou com ele ancorado.`);
    }
  }

  /** Routine results threads made before they were titled in pt-BR. */
  function renameResultsThreads(): void {
    for (const bot of store.bots) {
      for (const task of store.tasks(bot.id)) {
        if (!task.title.endsWith(" · Results")) continue;
        try {
          store.patchTask(bot.id, task.threadId, { title: `${task.title.slice(0, -" · Results".length)} · Resultados` });
        } catch { /* a task that cannot be patched keeps its title */ }
      }
    }
  }

  /** Sessions still owned by a conversation that was closed, archived or
   * deleted before closing handed work over (or while the server was down):
   * handed over now, on load. */
  function retireWorkOfClosedThreads(): void {
    const seen = new Set<string>();
    for (const session of ccLedger.all()) {
      if (session.status === "archived") continue;
      const key = `${session.ownerBotId}:${session.ownerThreadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const task = store.taskByThread(session.ownerBotId, session.ownerThreadId);
      if (task && !task.closedBy && !task.archivedAt) continue;
      try {
        retireThreadWork(session.ownerBotId, session.ownerThreadId, task?.closedBy ? "fechada" : task?.archivedAt ? "arquivada" : "apagada");
      } catch (error) {
        console.error(`[cc-sessions] could not hand over the work of ${session.ownerThreadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** After a restart: what it cut off, what the server re-ran on its own and
   * what it left for someone to confirm — one report on the Chief's desk. */
  function reportResumptionToChief(): void {
    const leases = autonomy.recoveredOnLoad;
    const sessions = ccLedger.interruptedOnLoad;
    const survived = ccLedger.survivedOnLoad;
    if (!leases.length && !sessions.length && !survived.length) return;
    const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
    const desk = chief ? chiefDeskThread(chief) : null;
    if (!chief || !desk || !store.taskByThread(chief.id, desk)) return;
    const when = (at: number) => new Date(at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const name = (botId: string) => store.bot(botId)?.name ?? botId;
    const rerun = leases.filter((lease) => !lease.stale);
    const asked = leases.filter((lease) => lease.stale);
    const text = [
      "[Relatório de retomada — o servidor reiniciou]",
      ...(rerun.length ? ["Reenviado automaticamente (turnos cortados pelo restart, retomados como devidos):", ...rerun.map((lease) => `- ${name(lease.botId)} · ${lease.kind === "wake" ? "despertador/vigia" : "relatórios"} de ${when(lease.startedAt)} (conversa ${lease.threadId}): ${lease.what}`)] : []),
      ...(asked.length ? ["NÃO repetido (mais de 6 h; o bot foi perguntado se ainda vale):", ...asked.map((lease) => `- ${name(lease.botId)} · ${lease.kind} de ${when(lease.startedAt)} (conversa ${lease.threadId}): ${lease.what}`)] : []),
      ...(sessions.length ? ["Sessões do Claude Code interrompidas (o turno foi cortado e o processo claude não sobreviveu; o dono de cada uma recebeu o relatório):", ...sessions.map((session) => `- "${session.title}" (${session.id}) de ${name(session.ownerBotId)}`)] : []),
      ...(survived.length ? ["Sessões do Claude Code cujo processo claude seguiu rodando (o servidor acompanha até o fim do turno e o relatório chega como de costume; NÃO retome nem mande outra mensagem para elas agora):", ...survived.map((session) => `- "${session.title}" (${session.id}, PID ${session.proc?.pid}) de ${name(session.ownerBotId)}`)] : []),
      "Confira o que ficou pendente e retome o que for preciso.",
    ].join("\n");
    store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(serverRestartedChip({ interrupted: sessions.length, survived: survived.length, rerun: rerun.length, asked: asked.length }), 200), ok: asked.length === 0 && sessions.length === 0 } });
    autonomy.addReport(chief.id, desk, text);
  }
  const ccProcesses = new Map<string, CcChildProcess>();
  // OMB_CC_BIN points end-to-end tests at a scripted stand-in for `claude`.
  const ccBin = (): string => process.env.OMB_CC_BIN || "claude";
  // OMB_CC_TURN_TIMEOUT_MS shortens the turn cut for end-to-end tests only.
  const ccTurnTimeoutMs = Number(process.env.OMB_CC_TURN_TIMEOUT_MS) > 0 ? Number(process.env.OMB_CC_TURN_TIMEOUT_MS) : CC_TURN_TIMEOUT_MS;
  const CC_TURN_FOOTER = "\n\nWhen you stop, end with a short report for your manager: what you changed, the branch and PR (link), what the tests and the repository's gates say, and exactly what is blocked or needs a decision. When you merge a batch of PRs: hotfix/P0/P1 work (by label, title or the linked issue's priority) goes first, ahead of CI or infrastructure PRs, released on its own; PRs that change release scripts (release, carrier, merge-gate or production-watch scripts) go last, in a separate release, with a dry run first. Follow the repository's own rules (CLAUDE.md/AGENTS.md) for issues, PRs, gates and releases, and run its scripts with the package manager they name (npm run when the repository has a package-lock.json — never swap in pnpm or yarn). Do not use AskUserQuestion or wait for an answer mid-turn: if you need a decision or an approval, stop and put the question in your final report. Write your reports and summaries — everything the person reads in the app — in Brazilian Portuguese (pt-BR); keep code, commands and identifiers as they are.";
  /** The footer of a first turn: the general rules, plus the repository's own corridor. */
  const ccTurnFooter = (session: CcSession): string => `${CC_TURN_FOOTER}${repoCorridor(session.repo)}`;
  /** Headless runs only: nothing wakes such a session after its turn ends. */
  const CC_CLI_FOOTER = "\nYou run headless: nothing wakes you after you stop. Never end your turn waiting on a background job or a notification — run gates in the foreground and wait for them (up to 80 min), or report the PID, the log/receipt path and what to check.";

  function ccIsGitRepo(dir: string): boolean {
    if (!dir.startsWith(homedir()) || !existsSync(dir)) return false;
    try {
      return execFileSyncCc("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe", env: { ...process.env, PATH: augmentedPath() } }).toString().trim() === "true";
    } catch {
      return false;
    }
  }

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
    autonomy.addReport(session.ownerBotId, to, text);
    if (to !== session.ownerThreadId || ownerChannelOf(session.ownerBotId)) return;
    if (session.replyThreadId && session.replyThreadId !== session.ownerThreadId && store.taskByThread(session.ownerBotId, session.replyThreadId)) {
      autonomy.addReport(session.ownerBotId, session.replyThreadId, text);
    }
  }

  // ── the GitHub token sessions run with (server/session-token.ts) ────────
  const sessionToken = new SessionToken(process.env.OMB_CC_BIN ? { read: () => { throw new Error("tests use no Keychain"); } } : {});
  let sessionTokenMissingTold = false;

  /** GH_TOKEN/GITHUB_TOKEN for a session of the platform, from the Keychain.
   * Missing: the session uses the owner's gh as before, and the Chief is told
   * once. The value is never logged or stored. */
  function sessionTokenEnv(session: CcSession): Record<string, string> {
    const { env, missing } = sessionToken.envFor(session.repo);
    if (missing && !sessionTokenMissingTold) {
      sessionTokenMissingTold = true;
      const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
      const desk = chief ? chiefDeskThread(chief) : null;
      const text = `token de sessão ausente — usando o gh do dono (Chaveiro: ${SESSION_TOKEN_SERVICE}); as sessões do Claude Code rodam com as permissões dele`;
      console.warn(`[cc-sessions] ${text}`);
      if (chief && desk && store.taskByThread(chief.id, desk)) {
        store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(text, 200), ok: false } });
        autonomy.addReport(chief.id, desk, `[Aviso do servidor] ${text}.`);
      }
    }
    return env;
  }

  /** One headless turn. Its exit hands the report to the owning conversation,
   * unless a reply was queued meanwhile, which then runs as the next turn. */
  function runCcTurn(session: CcSession, prompt: string, first: boolean): void {
    const expectedCwd = join(session.repo, ".claude", "worktrees", session.worktree);
    const cwd = first ? session.repo : session.cwd ?? (existsSync(expectedCwd) ? expectedCwd : session.repo);
    ccLedger.markRunning(session);
    const lines: string[] = [];
    let buffer = "";
    let timedOut = false;
    let settled = false;
    const keep = (line: string) => {
      // Tool output can be huge; only the init and result events matter here.
      if (line.includes('"subtype":"init"') || line.includes('"type":"result"') || !line.startsWith("{")) {
        lines.push(line);
        if (lines.length > 50) lines.splice(0, lines.length - 50);
      }
    };
    let child: CcChildProcess;
    try {
      child = spawnCcProcess(ccBin(), ccTurnArgs(session, first ? `${prompt}${ccTurnFooter(session)}${CC_CLI_FOOTER}` : prompt, first), {
        cwd,
        // a token without admin rights for the platform's sessions, when the owner keeps one
        env: { ...process.env, PATH: augmentedPath(), ...sessionTokenEnv(session) },
        stdio: ["ignore", "pipe", "pipe"],
        // its own process group: what it leaves running is told apart from
        // everything else in the worktree (server/bg-jobs.ts)
        detached: process.platform !== "win32",
      });
    } catch (error) {
      ccLedger.finishTurn(session, { ok: false, report: "", costUsd: 0, error: `could not start claude: ${error instanceof Error ? error.message : String(error)}` });
      ccReport(session, desktopReportFor(desktopWork, session));
      return;
    }
    ccProcesses.set(session.id, child);
    // its pid and start time on the ledger: after a restart the server can
    // tell whether this very process is still at work (R9-resilience RS-PID)
    if (child.pid && process.platform !== "win32") {
      const pid = child.pid;
      execFileCc(PS_BIN, ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000, env: { ...process.env, ...PS_ENV } }, (error, stdout) => {
        // gone already (error): nothing to follow
        if (!error && ccProcesses.get(session.id) === child && String(stdout).trim()) ccLedger.setProc(session, { pid, lstart: String(stdout) });
      });
    }
    // The process tree under this turn's claude, sampled as it works: its
    // background job is what is left of it when the turn ends.
    const tree: TurnTree | null = child.pid ? newTurnTree(child.pid) : null;
    let sampledAt = 0;
    const sample = () => {
      if (!tree || process.platform === "win32" || Date.now() - sampledAt < 5_000) return;
      sampledAt = Date.now();
      void psTable()
        .then((rows) => {
          noteDescendants(tree, rows);
          noteReleaseQueue(rows);
        })
        .catch(() => {});
    };
    // nuria-platform lote W1: a ci:local of this turn queued behind a release
    // waits for it as long as it takes; that wait is not the turn's, so it is
    // added to the turn's limit instead of cutting it, and said once per release.
    // INSP-W r1 W-1: up to the same 5 h ceiling as the admission: a release older
    // than that (or 5 h of excused wait, when its age is unknown) is no longer an
    // excuse, and the turn is cut again saying the release may have hung.
    const turnStartedAt = Date.now();
    let queuedMs = 0;
    let queuedSince = 0;
    let overdueReason = "";
    const queuedTold = new Set<string>();
    const noteReleaseQueue = (rows: Parameters<typeof noteDescendants>[1]) => {
      if (!child.pid) return;
      let queued: ReturnType<typeof ciQueuedBehindRelease> = null;
      try {
        const alive = (pid: number) => rows.some((row) => row.pid === pid);
        queued = ciQueuedBehindRelease({ rows, rootPid: child.pid, lease: readAdmissionLease(), deployLease: readDeployLease(), intents: readReleaseIntents() ?? [], alive });
      } catch {
        // the lease could not be read: undecided, so the wait is not counted
      }
      const now = Date.now();
      const excusedMs = queuedMs + (queuedSince ? now - queuedSince : 0);
      if (queued && (queued.overdue || excusedMs >= RELEASE_QUEUE_CEILING_S * 1000) && !overdueReason) {
        overdueReason = releaseOverdueText(queued.label);
        ccChip(session, `${overdueReason} — o ci:local desta sessão não espera mais por ele e o turno volta a ter limite`, false);
      }
      const excused = Boolean(queued) && !overdueReason;
      if (excused && !queuedSince) queuedSince = now;
      if (!excused && queuedSince) {
        queuedMs += now - queuedSince;
        queuedSince = 0;
      }
      if (queued && excused && !queuedTold.has(queued.label)) {
        queuedTold.add(queued.label);
        ccChip(session, ciQueuedText(queued));
      }
    };
    const sampler = setInterval(sample, 30_000);
    sampler.unref();
    const cutOrWait = () => {
      const now = Date.now();
      const due = turnStartedAt + ccTurnTimeoutMs + queuedMs + (queuedSince ? now - queuedSince : 0);
      if (queuedSince || now < due) {
        timer = setTimeout(cutOrWait, Math.max(60_000, due - now));
        timer.unref();
        return;
      }
      timedOut = true;
      if (overdueReason) ccChip(session, `turno cortado: ${overdueReason}`, false);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    let timer = setTimeout(cutOrWait, ccTurnTimeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      sample();
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        keep(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    const finish = (code: number | null, signal: string | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(sampler);
      ccProcesses.delete(session.id);
      if (buffer) keep(buffer);
      const outcome = parseCcStream([...lines, ...(spawnError ? [spawnError] : []), ...stderr.split("\n").slice(-5)], { code, signal, timedOut });
      ccLedger.finishTurn(session, outcome);
      // this turn was the resumption after a cut: at most one per cut in a row
      const resumedAfterCut = session.resumedAfterCut === true;
      if (resumedAfterCut) {
        delete session.resumedAfterCut;
        ccLedger.save();
      }
      if (session.status === "stopped" || session.status === "archived") return;
      const next = session.status === "idle" ? takeFreshQueued(desktopWork, session) : null;
      if (next !== null) {
        ccChip(session, "a mensagem da fila está rodando agora");
        runCcTurn(session, next, false);
        return;
      }
      ccChip(session, session.status === "failed" ? `parou com um problema — ${sessionErrorPt(String(session.lastError)).slice(0, 120)}` : `terminou o turno ${session.turns}`, session.status !== "failed");
      // A process it left running in its worktree (a gate in the background)
      // would finish with nobody to tell: note it; the tick resumes the
      // session when it is gone (watchBackgroundJobs).
      const folder = session.cwd;
      // A turn cut at 90 min leaves its gate running in a group of its own
      // (npm → local-ci): followed like a background job, so the session is
      // resumed when it ends instead of the CI running on with nobody to tell
      // (R8-resilience TO). Nothing is killed here.
      const cut = timedOut && session.status === "failed";
      const limitMin = Math.round(ccTurnTimeoutMs / 60_000);
      // cut again right after the server resumed it from a cut: a structural
      // stall (a loop, a wait that never ends) — no second resumption, the Chief decides
      if (cut && resumedAfterCut) {
        ccChip(session, `turno cortado em ${limitMin} min duas vezes seguidas — o servidor não retoma de novo; o Chief decide`, false);
        ccReport(session, `${desktopReportFor(desktopWork, session)}\n(Its turn was cut at the ${limitMin}-min limit twice in a row: the second turn was the server's resumption after the first cut. The server does not resume it again. Check whether it is stuck — a loop, a wait that never ends — then send it a message with cc_session_send, or stop it.)`);
        return;
      }
      if ((session.status === "idle" || cut) && tree && folder && folder.includes("/.claude/worktrees/")) {
        void backgroundProcesses(folder, tree).then((found) => {
          // after a cut only a group of its own counts (the gate); the claude's own group (MCP servers) dies with it
          const left = cut ? cutLeftovers(found, tree.rootPid) : found;
          if (!left.length || (session.status !== "idle" && !(cut && session.status === "failed"))) {
            ccReport(session, desktopReportFor(desktopWork, session));
            return;
          }
          session.bgJob = { pids: left.map((proc) => proc.pid), commands: left.map((proc) => proc.command), starts: left.map((proc) => proc.start), since: Date.now(), ...(cut ? { afterCut: true as const } : {}) };
          ccLedger.save();
          ccChip(session, cut
            ? `turno cortado em ${limitMin} min com ${left.length} processo(s) ainda rodando — o servidor retoma a sessão quando terminarem`
            : `terminou o turno com ${left.length} processo(s) rodando em segundo plano — o servidor retoma a sessão quando terminarem`);
          ccReport(session, `${desktopReportFor(desktopWork, session)}\n(Its turn ${cut ? `was cut at the ${limitMin}-min limit` : "ended"} with process(es) still running in its worktree: ${left.map((proc) => `PID ${proc.pid} ${proc.command.slice(0, 80)}`).join("; ")}. The server resumes the session with a new turn when they finish, and tells you if they are still running after ${Math.round(BG_JOB_MAX_MS / 3_600_000)} h.${cut ? " One of them may be what stalled the turn; the server resumes it once at most — cut again, it waits for you." : ""})`);
        }).catch(() => ccReport(session, desktopReportFor(desktopWork, session)));
        return;
      }
      ccReport(session, desktopReportFor(desktopWork, session));
    };
    child.on("error", (error) => finish(null, null, `could not run ${ccBin()}: ${error.message}`));
    child.on("close", (code, signal) => finish(code, signal));
  }

  // ── Claude Code sessions in the Claude desktop app (server/claude-desktop.ts)
  // The person follows these in the app. Screen actions (open, send, archive)
  // wait for an idle, unlocked Mac and run one at a time; following them only
  // reads files. The flow itself lives in server/desktop-work.ts.
  let desktopDriver: DesktopDriver | null = null;
  const desktopState = { busy: false };

  async function getDesktopDriver(): Promise<DesktopDriver> {
    if (!desktopDriver) {
      const env = { ...process.env, PATH: augmentedPath() };
      desktopDriver = macDesktopDriver(await ensureHelper(DATA_DIR, DESKTOP_HELPER_SOURCE, env), env);
    }
    return desktopDriver;
  }

  /** The brief typed into the app: it opens with the folder check, since the
   * app may land the new session in a folder that is not its own. */
  function desktopBrief(session: CcSession, brief: string, since = Date.now()): string {
    session.desktop!.folderGuarded = true;
    return desktopBriefText(session.title, session.desktop!.marker, brief, ccTurnFooter(session), since);
  }

  const DUAL_DECISIONS_LOG = join(homedir(), ".laya", "hooks", "dual-decisions.log");

  const desktopWork: DesktopWorkDeps = {
    ledger: ccLedger,
    now: Date.now,
    getDriver: getDesktopDriver,
    readRecord: (localId) => readDesktopRecord(localId),
    findSession: (marker, since) => findDesktopSession(marker, since),
    transcriptOf: (cliSessionId) => transcriptPath({ cliSessionId }),
    lastText: (transcript) => lastAssistantText(transcript),
    turnEnded: transcriptTurnEnded,
    openQuestion: transcriptOpenQuestion,
    mentions: transcriptMentions,
    writtenAt: transcriptWrittenAt,
    repoName: (session) => basename(session.repo),
    chip: ccChip,
    report: ccReport,
    ownerPending: (session, item) => {
      // in the conversation with the owner, where they were told to look
      const threadId = sessionReportThread(session);
      if (!store.taskByThread(session.ownerBotId, threadId)) return;
      autonomy.addOwnerPending(session.ownerBotId, threadId, item);
      refreshBotRow(session.ownerBotId);
    },
    resolveOwnerPending: (key) => {
      for (const item of autonomy.resolveOwnerPending({ key })) refreshBotRow(item.botId);
    },
    hookDecision: (sessionId) => lastHookDecision(DUAL_DECISIONS_LOG, sessionId),
    hookBlock: (sessionId) => lastHookBlock(DUAL_DECISIONS_LOG, sessionId),
    liveWorktrees: () => liveWorktreeNames(undefined, true),
    baseBranch: (session) => repoBaseBranch(session.repo),
    // never a session the server opened (a failed one in the root is the newest there — INSP-S r1 S-3)
    rootAnchor: (session) => rootAnchorSession(session.repo, undefined, ourAppLocalIds()),
    folderUsers: (folder, exceptLocalId) => recordsUsingFolder(folder, exceptLocalId, undefined, true).map((record) => record.title ?? record.sessionId),
    log: (line) => console.log(`[claude-desktop] ${line}`),
    onArchived: (session) => {
      void reportArchivedWorktrees(session, session.desktop?.removeWorktree === true).catch((error) => console.warn(`[worktrees] archive report of ${session.id} failed: ${error instanceof Error ? error.message : String(error)}`));
    },
  };


  /** The branch origin/HEAD points to ("main"), what a new app session must show. */
  function repoBaseBranch(repo: string): string {
    try {
      const ref = String(execFileSyncCc("git", ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { stdio: "pipe", env: { ...process.env, PATH: augmentedPath() } })).trim();
      return ref.replace(/^origin\//, "") || "main";
    } catch {
      return "main";
    }
  }

  /** Worktrees whose work is already in the production tag, in the
   * repositories the sessions use: every 6 h the Chief gets the ones a person
   * may remove, with the command, and those kept and why — only when that
   * changed. The server removes none (R8 G3, server/nested-worktrees.ts). */
  const releasedCleanup: { lastAt: number; running: boolean; lastKey: Map<string, string> } = { lastAt: 0, running: false, lastKey: new Map() };
  /** `git` with git's stderr on the error, async, with a timeout. */
  const gitAsync = (args: string[]) => new Promise<string>((resolve, reject) => {
    execFileCc("git", args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: augmentedPath(), GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr ?? "") }));
      else resolve(String(stdout));
    });
  });
  /** Every process's cwd (`lsof -a -d cwd -Fpn`), or null when it cannot be read. */
  const allProcessCwds = () => new Promise<string[] | null>((resolve) => {
    execFileCc("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn"], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (_error, stdout) => {
      // lsof exits 1 when it could not read another user's process: the output still counts
      const found = parseLsofCwd(String(stdout ?? ""));
      resolve(found.length ? found.map((proc) => proc.cwd) : null);
    });
  });
  /** Codex sessions of the last week: the folders they work in (`session_meta.cwd`). */
  function recentCodexFolders(now: number): string[] {
    const root = join(homedir(), ".codex", "sessions");
    const folders = new Set<string>();
    const walk = (dir: string, depth: number) => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        const path = join(dir, name);
        if (depth < 3) { walk(path, depth + 1); continue; }
        if (!name.endsWith(".jsonl")) continue;
        try {
          if (now - statSync(path).mtimeMs > 7 * 86_400_000) continue;
          for (const folder of codexRolloutFolders(readHead(path, 256 * 1024))) folders.add(folder);
        } catch { /* unreadable: skipped */ }
      }
    };
    walk(root, 0);
    return [...folders];
  }
  function readHead(path: string, bytes: number): string {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)).toString("utf8");
    } finally { closeSync(fd); }
  }
  /** Folders agents work in: our sessions, the app's sessions, every bot's
   * open conversation (its folder or its task-workspace), rooms, Codex. */
  function foldersInUse(opts: { quietWorkspaces?: Map<string, string> } = {}): string[] {
    const folders: string[] = ccLedger.all().filter((session) => session.status !== "archived" && session.cwd).map((session) => session.cwd!);
    if (process.platform === "darwin") folders.push(...liveRecordFolders());
    const now = Date.now();
    const day = (ms: number) => new Date(ms).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
    for (const bot of store.bots) {
      if (bot.cwd) folders.push(bot.cwd);
      for (const task of store.tasks(bot.id)) {
        if (task.archivedAt) continue;
        if (typeof task.cwd === "string") folders.push(task.cwd);
        const workspace = join(TASK_WORKSPACES_DIR, bot.id, task.threadId);
        // for the disk report only: a closed conversation's workspace, or one
        // quiet for 72 h and not running, is told as information (INSP-J r1 #7a)
        if (opts.quietWorkspaces) {
          const quietSince = task.updatedAt ?? task.createdAt;
          if (task.closedBy) { opts.quietWorkspaces.set(workspace, `conversa "${task.title.slice(0, 40)}" fechada`); continue; }
          if (!task.busy && !autonomy.goalFor(task.threadId) && now - quietSince > STALE_OUTSIDE_TAG_MS) { opts.quietWorkspaces.set(workspace, `conversa "${task.title.slice(0, 40)}" aberta, parada desde ${day(quietSince)}`); continue; }
        }
        folders.push(workspace);
      }
    }
    for (const group of store.groups ?? []) {
      if (group.cwd) folders.push(group.cwd);
      if (group.pinnedCwd) folders.push(group.pinnedCwd);
    }
    folders.push(...recentCodexFolders(Date.now()));
    return folders;
  }
  const canonPath = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  /** A folder's size in KB (`du -sk`, at most 2 min), or null. */
  const duKb = (path: string) => new Promise<number | null>((resolve) => {
    execFileCc("/usr/bin/du", ["-sk", path], { timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? null : Number(/^(\d+)/.exec(String(stdout).trim())?.[1]) || null));
  });
  async function cleanReleasedWorktrees(): Promise<void> {
    if (!DESKTOP_MANAGED || process.env.VITEST || releasedCleanup.running || Date.now() - releasedCleanup.lastAt < 6 * 3_600_000) return;
    releasedCleanup.running = true;
    releasedCleanup.lastAt = Date.now();
    try {
      // without every process's cwd and argv nothing can be judged in use: no report
      const [cwds, rows] = await Promise.all([allProcessCwds(), psTable()]);
      if (!cwds || !rows.length) return;
      const inUse = foldersInUse();
      // the idle task-workspaces are told with closed and quiet conversations too (information only)
      const quietWorkspaces = new Map<string, string>();
      const inUseForDisk = foldersInUse({ quietWorkspaces });
      const lines: string[] = [];
      const mtime = (file: string) => { try { return statSync(file).mtimeMs; } catch { return null; } };
      const activity = (path: string) => worktreeLastActivity(path, { readFile: (file) => readFileSync(file, "utf8"), mtime });
      const stale: StaleFolder[] = [];
      for (const repo of new Set(ccLedger.all().map((session) => session.repo))) {
        const git = (args: string[]) => gitAsync(["-C", repo, ...args]);
        let tagSha: string | null = null;
        try {
          tagSha = parseLsRemoteTag(await execCc("git", ["-C", repo, "ls-remote", "origin", `refs/tags/${PRODUCTION_TAG}`, `refs/tags/${PRODUCTION_TAG}^{}`]), PRODUCTION_TAG);
          if (tagSha) await git(["cat-file", "-e", `${tagSha}^{commit}`]);
        } catch { continue; } // no tag, or its commit is not fetched here: nothing can be judged
        if (!tagSha) continue;
        const plan = await planReleasedWorktrees(repo, tagSha, {
          git, inUse, processCwds: cwds, processCommands: rows.map((row) => row.command), now: Date.now(), canon: canonPath, lastActivity: activity,
        });
        stale.push(...(plan.stale ?? []));
        const { line, key } = releasedPlanLine(basename(repo), plan, releasedCleanup.lastKey.get(repo));
        releasedCleanup.lastKey.set(repo, key);
        if (!line) continue;
        console.log(`[worktrees] ${repo}: judged only the ${plan.scope?.inTag ?? "?"} of ${plan.scope?.total ?? "?"} worktrees contained in ${PRODUCTION_TAG}: ${plan.candidates.length} may be removed (${plan.candidates.map((candidate) => candidate.path).join(", ") || "none"}); kept ${plan.kept.join(", ") || "none"}`);
        // what was judged comes first: "nenhuma pode ser removida" is about those in the tag only (R10-resilience D)
        const scope = releasedScopeLine(basename(repo), plan, PRODUCTION_TAG);
        if (scope) lines.push(scope);
        lines.push(line);
        if (plan.candidates.length) lines.push(`Para remover (sem --force; confira antes): ${plan.candidates.map((candidate) => candidate.command).join(" ; ")}`);
      }
      // the task-workspaces of conversations no longer open, idle for days
      const workspaces: Array<{ path: string; lastActivity: number | null; note?: string }> = [];
      try {
        for (const bot of readdirSync(TASK_WORKSPACES_DIR)) {
          const botDir = join(TASK_WORKSPACES_DIR, bot);
          let threads: string[] = [];
          try { threads = readdirSync(botDir); } catch { continue; }
          for (const thread of threads) {
            const path = join(botDir, thread);
            const at = existsSync(join(path, ".git")) ? activity(path) ?? mtime(path) : mtime(path);
            const note = quietWorkspaces.get(path);
            workspaces.push({ path, lastActivity: at, ...(note ? { note } : {}) });
          }
        }
      } catch { /* no task-workspaces here */ }
      stale.push(...staleTaskWorkspaces(workspaces, { inUse: inUseForDisk, now: Date.now(), known: stale.map((each) => each.path), canon: canonPath }));
      const staleKey = stale.map((each) => each.path).sort().join("\n");
      const staleNews = staleKey !== (releasedCleanup.lastKey.get("\u0000stale") ?? "");
      releasedCleanup.lastKey.set("\u0000stale", staleKey);
      if (staleNews && stale.length) {
        // every one measured (du, 2 min each at most), so the report orders by size, not by disk order (INSP-J r1 #7b)
        for (const each of stale) each.sizeKb = await duKb(each.path);
        console.log(`[worktrees] idle >72 h outside ${PRODUCTION_TAG} (told as information, nothing removed): ${stale.map((each) => `${each.path} (${each.sizeKb ?? "?"} KB)`).join(", ")}`);
      }
      const staleTold = staleNews ? staleFoldersReport(stale) : null;
      if (!lines.length && !staleTold) return;
      const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
      const desk = chief ? chiefDeskThread(chief) : null;
      if (chief && desk && store.taskByThread(chief.id, desk)) {
        const plans = lines.filter((line) => !line.startsWith("Para remover") && !/: avaliei para remoção só/.test(line));
        if (plans.length) store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(`Worktrees já em produção — ${plans[0]}${plans.length > 1 ? " …" : ""}`, 240), ok: true } });
        if (staleTold) store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(staleTold.chip, 240), ok: true } });
        const parts = [
          ...(lines.length ? [`Worktrees já em produção — estas podem ser removidas por uma pessoa, depois de conferir:\n${lines.join("\n")}`] : []),
          ...(staleTold ? [staleTold.report] : []),
        ];
        autonomy.addReport(chief.id, desk, `[Servidor: worktrees e disco] O servidor não remove nada. ${parts.join("\n\n")}\nAo falar com o dono, diga o escopo: "nenhuma pode ser removida" vale só para as contidas na tag; as paradas fora dela são decisão dele.`);
      }
    } finally {
      releasedCleanup.running = false;
    }
  }

  /** An archived session's worktrees (G12, server/nested-worktrees.ts): the
   * merged ones it left inside its folder and — `includeOwn` — its own. The
   * server removes none: the bot gets the ones a person may remove, with the
   * command, and the ones that stay and why. Async: it waits for the
   * session's own claude to exit (its cwd would keep the worktree "in use"). */
  async function reportArchivedWorktrees(session: CcSession, includeOwn: boolean): Promise<void> {
    const folder = session.cwd;
    if (!folder || !existsSync(folder)) {
      if (includeOwn && folder?.includes("/.claude/worktrees/")) ccChip(session, `A worktree ${folder} já não existia.`);
      return;
    }
    for (let waited = 0; ccProcesses.has(session.id) && waited < 15_000; waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
    const [cwds, rows] = await Promise.all([allProcessCwds(), psTable()]);
    if (!cwds || !rows.length) {
      ccChip(session, "worktrees não conferidas (sem a lista de processos)", false);
      return;
    }
    const deps = {
      repo: session.repo,
      git: (args: string[]) => gitAsync(["-C", session.repo, ...args]),
      processCwds: cwds,
      processCommands: rows.map((row) => row.command),
      foldersInUse: foldersInUse().filter((path) => canonPath(path) !== canonPath(folder)),
      ownLockMarkers: [session.id, ...(session.desktop?.localId ? [session.desktop.localId] : [])],
      canon: canonPath,
    };
    const nested = await planNestedWorktrees(folder, deps);
    // The app reuses worktrees of archived sessions for new ones: never offer
    // one that another live session (ours or the app's) works in.
    const own = includeOwn && folder.includes("/.claude/worktrees/") ? await planArchivedWorktree(folder, deps, [
      ...ccLedger.all().filter((other) => other.id !== session.id && other.cwd === folder && other.status !== "archived").map((other) => `"${other.title}"`),
      ...recordsUsingFolder(folder, session.desktop?.localId).map((record) => `"${record.title ?? record.sessionId}" (app)`),
    ]) : { candidates: [], kept: [] };
    const { chip, report } = archiveCleanupNote(folder, { candidates: [...nested.candidates, ...own.candidates], kept: [...nested.kept, ...own.kept] });
    if (!chip) return;
    ccChip(session, chip, !nested.kept.length && !own.kept.length);
    ccReport(session, `[Arquivamento de "${session.title}" (${session.id}): worktrees] ${report}`);
  }

  /** Headless sessions whose turn ended with a background job: resume each
   * once its processes are all gone (same pid and start time). One still
   * running after BG_JOB_MAX_MS is reported to the owner and no longer
   * waited on. With every slot taken, an idle session is retried next tick
   * rather than queued, since nothing would deliver a queue to it. */
  async function watchBackgroundJobs(): Promise<void> {
    const now = Date.now();
    for (const session of ccLedger.all()) {
      const job = session.bgJob;
      if (!job || session.surface === "app") continue;
      if (session.status === "archived" || session.status === "stopped") {
        delete session.bgJob;
        ccLedger.save();
        continue;
      }
      if (job.doneAt === undefined) {
        if (await jobAlive(job)) {
          if (now - job.since < BG_JOB_MAX_MS) continue;
          delete session.bgJob;
          ccLedger.save();
          ccChip(session, `processo(s) em segundo plano ainda rodando após ${Math.round(BG_JOB_MAX_MS / 3_600_000)} h — o dono foi avisado`, false);
          ccReport(session, bgJobOverdueReport(session, job, now));
          continue;
        }
        job.doneAt = now;
        ccLedger.save();
      }
      const prompt = bgJobResumePrompt(job, job.doneAt);
      if (session.status === "running") {
        delete session.bgJob;
        ccLedger.enqueue(session, prompt);
        ccLedger.save();
        continue;
      }
      // a P1 waiting in the start queue gets its slot first
      if (!ccSlotFreeForWork()) continue;
      delete session.bgJob;
      // the resumption after a cut: cut again, it is not resumed a second time
      if (job.afterCut) session.resumedAfterCut = true;
      ccLedger.save();
      ccChip(session, "o processo em segundo plano terminou — sessão retomada");
      runCcTurn(session, prompt, false);
    }
  }

  setThreadSignals((threadId) => {
    const watches = autonomy.watchesFor(threadId).map((wake) => ({
      label: wake.watch!.standing ? wake.watch!.label ?? STANDING_DEFAULT_LABEL : watchLabel(wake.watch!.command),
      standing: wake.watch!.standing === true,
      everyMinutes: Math.round(wake.watch!.everyMs / 60_000) || 1,
      lastRunAt: wake.watch!.lastRunAt,
      failures: wake.watch!.failures,
    }));
    const ccAlerts = ccLedger.all()
      .filter((session) => session.ownerThreadId === threadId && session.status !== "archived")
      .flatMap((session): WireCcAlert[] => {
        // a failure already reported as a day old (archive suggested) stops alerting
        if (session.status === "failed") return session.failedAgingReportedAt !== undefined ? [] : [{ sessionId: session.id, title: session.title, state: "failed", detail: (session.lastError ?? "").slice(0, 200) }];
        if (session.desktop?.questionReported && (session.status === "running" || session.status === "stalled")) return [{ sessionId: session.id, title: session.title, state: "question" }];
        if (session.status === "stalled") return [{ sessionId: session.id, title: session.title, state: "stalled" }];
        return [];
      });
    const ccSessions = ccLedger.all()
      .filter((session) => session.ownerThreadId === threadId && session.status !== "archived")
      .map((session): WireCcSession => {
        const screenWait = screenWaitOf(session);
        const resume = wireResumeOf(session);
        return {
          sessionId: session.id, title: session.title, status: session.status as WireCcSession["status"], surface: session.surface === "app" ? "app" : "cli",
          ...(screenWait ? { screenWait } : {}), ...(resume ? { resume } : {}),
        };
      });
    const ownerPending = autonomy.ownerPendingFor(threadId).map((item): WireOwnerPending => ({
      id: item.id, title: item.title, since: item.createdAt, ...(item.due ? { due: item.due } : {}), ...(item.link ? { link: item.link } : {}), ...(item.command ? { command: item.command } : {}),
      ...(item.why ? { why: item.why } : {}), ...(item.steps?.length ? { steps: item.steps } : {}), ...(item.options?.length ? { options: item.options } : {}),
      ...(item.stepsRequestedAt ? { stepsRequestedAt: item.stepsRequestedAt } : {}),
      ...(item.recommendRequestedAt ? { recommendRequestedAt: item.recommendRequestedAt } : {}),
      ...(item.history?.length ? { history: item.history.map(({ at, kind, label, text, delivered, queued, error }) => ({ at, kind, ...(label ? { label } : {}), text, delivered, ...(queued ? { queued } : {}), ...(error ? { error } : {}) })) } : {}),
      ...(item.awaitingSince ? { awaitingSince: item.awaitingSince } : {}),
      // when the bot last rewrote it: an older "não foi entregue" is over then (INSP-J2 r4 A2)
      ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    }));
    return {
      ...(watches.length ? { watches } : {}),
      ...(autonomy.isStandingLost(threadId) ? { watchesLost: true } : {}),
      ...(ccAlerts.length ? { ccAlerts } : {}),
      ...(ownerPending.length ? { ownerPending } : {}),
      ...(ccSessions.length ? { ccSessions } : {}),
    };
  });

  /** `file args` in `cwd`, stdout; rejects on a non-zero exit. */
  const execCc = (file: string, args: string[], cwd?: string) => new Promise<string>((resolve, reject) => {
    execFileCc(file, args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: augmentedPath() } }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });

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

  /** "Assuma a PR #N" in an order to a session: that PR is its own from now
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

  /** Send a message to a session the way cc_session_send would, from the
   * server: now if it is idle, else after its current turn. */
  function sendToSessionFromServer(session: CcSession, text: string): void {
    if (session.surface === "app" && session.desktop) {
      if (session.status === "idle" && !session.desktop.pending && !session.desktop.sent) {
        session.desktop.pending = { kind: "send", text, since: Date.now(), attempts: 0 };
        session.status = "running";
        ccLedger.save();
      } else ccLedger.enqueue(session, text);
      return;
    }
    if (session.status !== "running" && !ccProcesses.has(session.id) && ccSlotFreeForWork()) runCcTurn(session, text, false);
    else ccLedger.enqueue(session, text);
  }

  // ── the production release first (server/release-priority.ts) ──────────
  // A release waiting over 2 min behind the full local CI of a session this
  // server manages: that CI's process group is stopped, the session is told,
  // and it is resumed when the production tag moves. Only on the server the
  // desktop app runs (it reads this Mac's release log and processes).
  // decided cases survive a restart (release-watch.json), so nothing is told or signalled twice
  const preemptHandled = new Set<string>();
  const releasePriority = {
    running: false,
    lastAt: 0,
    state: {
      handled: {
        has: (key: string) => preemptHandled.has(key) || Boolean(releaseWatch.state?.isDecided(key)),
        add: (key: string) => { preemptHandled.add(key); releaseWatch.state?.decide(key); },
      },
      retries: new Map<string, number>(),
    } as PreemptState,
    tagCheckAt: 0,
  };
  /** admission-control.sh's state (nuria-platform scripts/admission-control.sh): lease and release intents. */
  const ADMISSION_DIR = join(homedir(), ".nuria", "admission");
  /** null only when there is no lease (ENOENT); any other read error throws. */
  function readAdmissionLease(): AdmissionLease | null {
    const read = (name: string) => {
      try {
        return readFileSync(join(ADMISSION_DIR, "lease", name), "utf8").trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    const ownerPid = read("owner.pid");
    if (!ownerPid) return null;
    // `start` (INSP-W r1 W-1): the owner's lstart, absent in leases written before it
    return { ownerPid, kind: read("kind") ?? "", label: read("label") ?? "", start: read("start") ?? undefined };
  }
  /** A small admission file, or undefined when it is not there (or unreadable). */
  function readAdmissionFile(...path: string[]): string | undefined {
    try {
      return readFileSync(join(ADMISSION_DIR, ...path), "utf8").trim();
    } catch {
      return undefined;
    }
  }
  /** The release's deploy lease (lote W2): held for the whole release, also while the machine is free. */
  function readDeployLease(): DeployLease | null {
    const ownerPid = readAdmissionFile("deploy-lease", "owner.pid");
    if (!ownerPid) return null;
    const startedAt = Number(readAdmissionFile("deploy-lease", "started"));
    return { ownerPid, label: readAdmissionFile("deploy-lease", "label") ?? "", start: readAdmissionFile("deploy-lease", "start"), startedAt: startedAt > 0 ? startedAt : undefined };
  }
  function readReleaseIntents(): ReleaseIntent[] | null {
    // admission-control.sh creates intents/ on every acquire: missing while a
    // release logs a wait means we look in the wrong place — undecided, not "no release"
    const dir = join(ADMISSION_DIR, "intents");
    try {
      return readdirSync(dir).filter((name) => /^\d+$/.test(name)).map((name) => ({ pid: Number(name), label: readTail(join(dir, name), 512).trim(), start: readAdmissionFile("intents", `${name}.start`) }));
    } catch {
      return null;
    }
  }

  /** A production release on its way on this Mac (release-priority.ts
   * releaseInFlight), read at most once a minute: while one is, no session is
   * told to resume (INSP-S r1 S-1). `label` null: none; "?" while the
   * admission state cannot be read (undecided, so nobody is told either). A
   * release past the ceiling has likely hung and holds nothing. */
  const releaseHold: { label: string | null; at: number; running: boolean } = { label: null, at: 0, running: false };
  // a test's minute is shorter (OMB_AUTONOMY_MINUTE_MS)
  const RELEASE_HOLD_EVERY_MS = autonomyTestMs("OMB_AUTONOMY_MINUTE_MS") ?? 60_000;
  async function refreshReleaseHold(): Promise<void> {
    if (releaseHold.running || Date.now() - releaseHold.at < RELEASE_HOLD_EVERY_MS) return;
    releaseHold.running = true;
    try {
      let label: string | null;
      try {
        const lease = readAdmissionLease();
        const deployLease = readDeployLease();
        const intents = readReleaseIntents() ?? [];
        if (!lease && !deployLease && !intents.length) label = null;
        else {
          const rows = await psTable();
          const found = releaseInFlight({ rows, lease, deployLease, intents, alive: (pid) => rows.some((row) => row.pid === pid) });
          label = found && !found.overdue ? releaseHoldText(found) : null;
        }
      } catch {
        label = "?";
      }
      if (label !== releaseHold.label) console.log(`[cc-sessions] release hold: ${label === null ? "none" : label === "?" ? "admission state unreadable" : label}`);
      releaseHold.label = label;
      releaseHold.at = Date.now();
    } finally {
      releaseHold.running = false;
    }
  }
  /** resumeNeeded under the release hold this server last read. */
  const resumeOf = (session: CcSession, now = Date.now()) => resumeNeeded(session, now, { release: releaseHold.label });
  /** What a row shows: the session still holds its PR while a release runs,
   * so the mark stays, "on hold" — parked behind the release, or with one on
   * its way — instead of vanishing and coming back (INSP-S r2 S2-3). The bots
   * are told nothing meanwhile (resumeOf). */
  const wireResumeOf = (session: CcSession, now = Date.now()): WireCcSession["resume"] | null => {
    const held = session.resumeAfterTag ? "parked" as const : releaseHold.label ? "release" as const : null;
    const need = resumeNeeded(held === "parked" ? { ...session, resumeAfterTag: undefined } : session, now);
    return need ? { ...need, ...(held ? { held } : {}) } : null;
  };

  async function preemptCiForReleaseTick(): Promise<void> {
    if (!DESKTOP_MANAGED || process.env.VITEST || releasePriority.running || Date.now() - releasePriority.lastAt < 20_000) return;
    releasePriority.running = true;
    releasePriority.lastAt = Date.now();
    try {
      await resumeSessionsAfterTag();
      await preemptCiForRelease({
        outLogTail: () => readTail(RELEASE_OUT_LOG, 64 * 1024),
        readLease: readAdmissionLease,
        readIntents: readReleaseIntents,
        ps: psTable,
        cwdOf: async (pid) => {
          try {
            return parseLsofCwd(await execCc("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", String(pid)]))[0]?.cwd ?? null;
          } catch { return null; /* gone, or not ours to read */ }
        },
        sessions: () => ccLedger.all().filter((session) => session.status !== "archived").map((session) => ({
          sessionId: session.id,
          title: session.title,
          ...(ccProcesses.get(session.id)?.pid ? { claudePid: ccProcesses.get(session.id)!.pid } : {}),
          ...(session.bgJob ? { jobPids: session.bgJob.pids, ...(session.bgJob.starts ? { jobStarts: session.bgJob.starts } : {}) } : {}),
          ...(session.surface === "app" && session.cwd ? { worktree: session.cwd } : {}),
        })),
        // never the server, its parent (the app), nor any managed session's claude
        guard: (rows) => ({
          ownPgid: rows.find((row) => row.pid === process.pid)?.pgid ?? process.pid,
          protectedPids: [process.pid, process.ppid, ...[...ccProcesses.values()].map((proc) => proc.pid).filter((pid): pid is number => typeof pid === "number")],
        }),
        kill: (pid, signal) => { process.kill(pid, signal); },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        alertChief: releaseAlertToChief,
        looping: releaseLoopingNow,
        log: (line) => console.log(line),
        home: homedir(),
        stopped: async ({ session: managed, blocked, target }) => {
          const session = ccLedger.get(managed.sessionId);
          if (!session) return;
          let tagSha: string | null = null;
          try {
            tagSha = parseLsRemoteTag(await execCc("git", ["-C", session.repo, "ls-remote", "origin", `refs/tags/${PRODUCTION_TAG}`, `refs/tags/${PRODUCTION_TAG}^{}`]), PRODUCTION_TAG);
          } catch { /* resumed on the first tag read that works */ }
          const note = "ci:local interrompido para liberar o release de produção; relançar quando a tag nuria-production-deployed andar ou esse release falhar";
          const releaseSha = releaseLabelSha(blocked.label);
          const failures = releaseFailures(readTail(RELEASE_ERR_LOG, 128 * 1024), readTail(RELEASED_SHA_FILE, 200).trim());
          session.resumeAfterTag = {
            fromSha: tagSha, at: Date.now(),
            message: `A tag ${PRODUCTION_TAG} andou: o release de produção que esperava passou. O seu ci:local (processo ${blocked.pid}) foi interrompido pelo servidor para liberar esse release — relance-o agora (npm run ci:local) e siga de onde parou.`,
            ...(releaseSha ? { releaseSha, failuresAtStop: failures && (failures.sha.startsWith(releaseSha) || releaseSha.startsWith(failures.sha)) ? failures.count : 0 } : {}),
          };
          ccLedger.save();
          ccChip(session, note, false);
          const what = target.kind === "group" ? `o grupo de processos ${target.pgid}` : `a árvore de processos do CI (${target.pids.length} processos a partir de ${target.root.pid})`;
          ccReport(session, `[Sessão Claude Code "${session.title}" (${session.id})] ${note}. O servidor interrompeu ${what} (ci-full:${blocked.pid}) porque ${blocked.label} esperava havia ${blocked.waitedS}s, e conferiu que o lease foi liberado; a sessão é retomada com uma mensagem quando a tag andar, ou quando esse release falhar, for recusado ou parado.`);
          const owner = store.bot(session.ownerBotId);
          if (owner) alertAutomationTrouble(owner, session.ownerThreadId, `ci:local da sessão "${session.title}" interrompido para liberar o release de produção (${blocked.label}), que esperava havia ${Math.round(blocked.waitedS / 60)} min; o lease foi liberado e a sessão é retomada quando a tag de produção andar ou esse release falhar`);
        },
      }, releasePriority.state);
    } finally {
      releasePriority.running = false;
    }
  }

  /** Sessions whose CI gave way to a release: resumed when the tag moves. */
  async function resumeSessionsAfterTag(): Promise<void> {
    if (Date.now() - releasePriority.tagCheckAt < 2 * 60_000) return;
    releasePriority.tagCheckAt = Date.now();
    for (const session of ccLedger.all()) {
      const wait = session.resumeAfterTag;
      if (!wait) continue;
      if (session.status === "archived" || session.status === "stopped") {
        delete session.resumeAfterTag;
        ccLedger.save();
        continue;
      }
      let sha: string | null = null;
      try {
        sha = parseLsRemoteTag(await execCc("git", ["-C", session.repo, "ls-remote", "origin", `refs/tags/${PRODUCTION_TAG}`, `refs/tags/${PRODUCTION_TAG}^{}`]), PRODUCTION_TAG);
      } catch { /* the tag unread: the release's own end still gives the CI back */ }
      // the release that took the CI's place failing again, refused or halted gives it back too (R10-resilience PRIO-LOOP)
      const failures = releaseFailures(readTail(RELEASE_ERR_LOG, 128 * 1024), readTail(RELEASED_SHA_FILE, 200).trim());
      // a wait an earlier build recorded names no release: the server log's own SIGTERM line does (INSP-J r1 #2)
      if (!wait.releaseSha) {
        const fromLog = SERVER_LOG_FILES.map((file) => stoppedReleaseFromLog(readTail(file, 4 * 1024 * 1024), session.id)).find(Boolean);
        if (fromLog) {
          wait.releaseSha = fromLog;
          wait.failuresAtStop = 0;
          ccLedger.save();
          console.log(`[release-priority] session ${session.id}: its parked CI gave way to ${fromLog.slice(0, 9)} (from the server log)`);
        }
      }
      const message = resumeAfterRelease(wait, { tagSha: sha, failures, declined: readTail(DECLINED_SHA_FILE, 200).trim(), halted: readHaltedRelease()?.sha ?? null, at: Date.now() });
      if (!message) continue;
      delete session.resumeAfterTag;
      ccLedger.save();
      const moved = Boolean(sha && sha !== wait.fromSha);
      ccChip(session, moved ? `a tag de produção andou (${sha!.slice(0, 8)}) — sessão retomada para relançar o ci:local` : `o release que tomou a vez (${wait.releaseSha?.slice(0, 9)}) não saiu — sessão retomada para relançar o ci:local`);
      console.log(`[release-priority] resumed session ${session.id}: ${moved ? `tag moved to ${sha!.slice(0, 9)}` : `release ${wait.releaseSha} failed again, was refused or halted`}`);
      sendToSessionFromServer(session, message);
    }
  }

  /** Where the desktop app writes this server's output (electron/main.mjs: app.getPath("logs")/server.log). */
  const SERVER_LOG_FILES = process.platform === "darwin" ? ["openmausbot", "OpenMausBot"].map((name) => join(homedir(), "Library", "Logs", name, "server.log")) : [];

  /** The release in `label` is in a loop: why, or null (release-watch's releaseInLoop on this Mac's files). */
  function releaseLoopingNow(label: string): string | null {
    const sha = releaseLabelSha(label);
    if (!sha || !releaseWatch.state) return null;
    const failures = releaseFailures(readTail(RELEASE_ERR_LOG, 128 * 1024), readTail(RELEASED_SHA_FILE, 200).trim());
    const key = `release-loop:${sha.slice(0, 9)}`;
    const itemOpen = store.bots.some((bot) => autonomy.ownerPendingOf(bot.id).some((item) => item.key === key));
    const known = failures && (failures.sha.startsWith(sha) || sha.startsWith(failures.sha)) ? failures.sha : sha;
    return releaseInLoop({ sha, failures, seen: releaseWatch.state.seenOf(known), itemOpen, declined: readTail(DECLINED_SHA_FILE, 200).trim() });
  }

  // ── starting a Claude Code session (cc_session_start) ──────────────────
  // Every slot taken, or starts already waiting: the start waits in the queue
  // (server/cc-start-queue.ts) and opens by itself when a slot frees, P1 first.
  const ccStartQueue = new CcStartQueue(process.env.VITEST ? null : join(DATA_DIR, "cc-start-queue.json"));

  /** Existing work may take a slot: one stays free for each P1 waiting. */
  const ccSlotFreeForWork = () => slotFreeForWork({ taken: ccLedger.slotsTaken(), urgentQueued: ccStartQueue.urgentCount(), max: CC_MAX_RUNNING });

  function startCcSession(bot: BotRecord, threadId: string, replyThreadId: string, body: Record<string, unknown>, fromQueue = false): StartResult {
    const input = parseCcStartInput(body, ccIsGitRepo);
    if (!input.ok) return { status: 400, body: { error: input.error } };
    // One live session per issue: a second would redo the same work.
    const duplicate = liveSessionForIssue(ccLedger.all(), input.repo, issueNumber(input.title, input.brief));
    if (duplicate) {
      const mine = duplicate.ownerBotId === bot.id;
      return { status: 409, body: { error: `já existe uma sessão viva para a issue #${issueNumber(input.title, input.brief)} em ${basename(input.repo)}: ${duplicate.id} ("${duplicate.title}", ${duplicate.status})${mine ? "" : `, de outro bot (${store.bot(duplicate.ownerBotId)?.name ?? duplicate.ownerBotId})`}. Não abri outra. ${mine ? `Mande a nova instrução para ela com cc_session_send (session_id ${duplicate.id})` : "Peça ao dono dela para mandar a instrução"}; se ela não serve mais, arquive com cc_session_archive e comece de novo.` } };
    }
    // The repository's own commands (npm run …), never a guessed pnpm.
    const scripts = useRepoScripts(input.brief, repoPackageManager(input.repo), repoScripts(input.repo));
    input.brief = scripts.text;
    const corridor = repoCorridor(input.repo);
    const mixWarning = corridor ? hotfixWithReleaseScripts(`${input.title}\n${input.brief}`) : null;
    const cliReason = typeof body.cliReason === "string" ? body.cliReason.trim().slice(0, 300) : "";
    // why it runs headless, as the server knows it (recorded on its chip)
    let cliOnRecord = cliReason;
    if (body.surface === "cli") {
      // decided by the app's state the server knows, not by the words of cli_reason (R9-dispatch R9-3, INSP-H r1 #6)
      const { state: app, reason: appReason } = appAvailability(input.repo);
      // the app blocked by the reused folder, with a client's work waiting: the owner is asked, once, to unblock it
      if (app === "blocked" && clientIssue(`${input.title}\n${input.brief}`)) askOwnerToUnblockApp(bot, threadId, input.repo, appFolderBlock());
      const decided = cliSurfaceRefusal({ corridor, title: input.title, brief: input.brief, reason: cliReason, app, appReason, appFailure: app === "available" ? recentAppFailure(ccLedger.all(), input.repo, Date.now()) : null });
      if ("refusal" in decided) return { status: 409, body: { error: decided.refusal } };
      cliOnRecord = decided.onRecord;
    }
    // on battery only a carrier ORDER is refused; from the queue it keeps its place until the Mac is plugged in
    const onBattery = carrierPowerCheck(`${input.title}\n${input.brief}`);
    if (onBattery && "refusal" in onBattery) return { status: 409, body: { error: onBattery.refusal }, retry: fromQueue };
    if (onBattery) input.brief = `${input.brief}\n\n${onBattery.note}`;
    const taken = ccLedger.slotsTaken();
    const gate = startGate({ fromQueue, queued: ccStartQueue.ordered().length, taken, max: CC_MAX_RUNNING });
    if (gate === "busy") return { status: 409, body: { error: "busy" }, busy: true };
    if (gate === "queue") {
      // urgency from the bot's explicit priority, else the title; never the brief
      const priority = startPriority(input.title, body.priority);
      const queued = ccStartQueue.add({ id: randomUUID().slice(0, 8), botId: bot.id, threadId, ...(replyThreadId !== threadId ? { replyThreadId } : {}), body, title: input.title, ...(issueNumber(input.title, input.brief) ? { issue: issueNumber(input.title, input.brief) } : {}), priority, at: Date.now() });
      if (queued === null) return { status: 409, body: { error: `já há ${CC_MAX_RUNNING} sessões do Claude Code ocupando as vagas e a fila de espera está cheia (${START_QUEUE_MAX}); espere uma relatar, ou tire um start seu da fila (cc_session_archive com o id dele)` } };
      const why = taken >= CC_MAX_RUNNING ? `as ${CC_MAX_RUNNING} vagas do Claude Code estão ocupadas` : "há starts esperando na fila (um novo não passa na frente deles)";
      if (queued.duplicate) {
        return { status: 200, body: { message: `"${input.title}" já estava na fila de sessões (#${queued.position}, id ${queued.id}); não enfileirei de novo. Encerre o turno agora.` } };
      }
      store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Fila de sessões: "${input.title}" é a #${queued.position} (prioridade ${priorityLabel(priority)}); abre sozinha quando uma vaga liberar`, 240), ok: true } });
      return { status: 200, body: { message: `Não abri agora porque ${why}: "${input.title}" entrou na fila de sessões (#${queued.position}, prioridade ${priorityLabel(priority)}, id ${queued.id}) e abre sozinha quando uma vaga liberar; o aviso chega aqui. Veja a fila em cc_session_list; para tirá-la da fila, cc_session_archive com session_id ${queued.id}. Encerre o turno agora.` } };
    }
    if (body.surface !== "cli" && process.platform === "darwin") {
      // New Session in the app opens in the folder of its latest
      // session; another repository cannot be picked from here. Say so
      // before touching the screen instead of failing five times. From the
      // queue it may pass (the person opens one there): it keeps its place.
      const lastRepo = lastAppRepo();
      if (lastRepo && lastRepo !== input.repo) {
        return { status: 409, body: { error: `o app Claude abre sessões novas na última pasta usada (${lastRepo}), não em ${input.repo}. Use surface "cli" para este repositório, ou peça à pessoa para abrir uma sessão em ${basename(input.repo)} no app uma vez e tente de novo.` }, retry: fromQueue };
      }
      const block = appFolderBlock();
      if (block) {
        // only the owner can unblock it: one item for them, however many starts hit this (R9-dispatch R9-2)
        const asked = askOwnerToUnblockApp(bot, threadId, input.repo, block);
        const refusal = block.kind === "flapping" ? flappingRefusal(block.seen, basename(input.repo), fromQueue)
          : block.kind === "reused" ? reusedFolderRefusal(block.last, basename(input.repo), fromQueue) : rootFolderRefusal(block.last, basename(input.repo), fromQueue);
        return { status: 409, body: { error: `${refusal}${asked ? ` O pedido ao dono já está em "Precisa de você" (${asked}): não abra outro item para isso.` : ""}` }, retry: fromQueue };
      }
      const appId = randomUUID();
      const session = ccLedger.create({ id: appId, ownerBotId: bot.id, ownerThreadId: threadId, title: uniqueSessionTitle(ccLedger.all(), input.title, appId), repo: input.repo, permissionMode: input.permissionMode, surface: "app", desktop: { marker: newMarker(), turnsSeen: 0 } });
      if (replyThreadId !== threadId) session.replyThreadId = replyThreadId;
      const issue = issueNumber(input.title, input.brief);
      if (issue) session.desktop!.issue = issue;
      session.desktop!.pending = { kind: "create", text: desktopBrief(session, input.brief), since: Date.now(), attempts: 0 };
      if (corridor) session.corridorVersion = corridorVersionOf(corridor);
      session.status = "running";
      ccLedger.save();
      ccChip(session, "na fila para abrir no app Claude quando o Mac estiver livre");
      noteClaimedPrs(session, input.brief);
      const ignored = [body.permissionMode !== undefined ? "permission_mode" : "", input.model ? "model" : ""].filter(Boolean);
      return { status: 200, body: { message: `Sessão do Claude Code ${session.id} ("${session.title}") na fila para abrir no app Claude, em ${basename(input.repo)} com worktree própria, assim que o Mac estiver desbloqueado e ninguém mexer nele por ${DESKTOP_IDLE_SECONDS} segundos — a pessoa acompanha por lá.${mixWarning ? ` ${mixWarning}` : ""}${ignored.length ? ` ${ignored.join(" e ")} não valem no app (ele usa as próprias configurações; o relatório diz o modo em que ela realmente roda).` : ""} Quando ela terminar um turno, o relatório chega aqui como um novo turno. Encerre o turno agora — não fique consultando.${scripts.changed ? " (Troquei pnpm por npm run no texto: este repositório usa npm.)" : ""}` } };
    }
    const session = ccLedger.create({ id: randomUUID(), ownerBotId: bot.id, ownerThreadId: threadId, title: input.title, repo: input.repo, permissionMode: input.permissionMode, surface: "cli", ...(input.model ? { model: input.model } : {}) });
    if (replyThreadId !== threadId) session.replyThreadId = replyThreadId;
    if (corridor) session.corridorVersion = corridorVersionOf(corridor);
    ccLedger.save();
    runCcTurn(session, input.brief, true);
    ccChip(session, `iniciada em ${input.repo}/.claude/worktrees/${session.worktree}`);
    noteClaimedPrs(session, input.brief);
    if (cliOnRecord) ccChipShort(session, sessionChips.cli(session.title, `${cliOnRecord}${cliReason && cliReason !== cliOnRecord ? ` (o bot disse: ${chipText(cliReason, 80)})` : ""}`));
    return { status: 200, body: { message: `Sessão do Claude Code ${session.id} ("${session.title}") iniciada na própria worktree. Ela trabalha sozinha; quando parar, o relatório chega aqui como um novo turno.${mixWarning ? ` ${mixWarning}` : ""} Encerre o turno agora — não fique consultando.${scripts.changed ? " (Troquei pnpm por npm run no texto: este repositório usa npm.)" : ""}` } };
  }

  /** Whether the Claude app can take a new session in `repo` now: not on this
   * Mac or opening another repository ("unavailable"), held by the
   * reused-folder 409 ("blocked"), else "available". */
  function appAvailability(repo: string): { state: AppAvailability; reason: string | null } {
    if (process.platform !== "darwin") return { state: "unavailable", reason: null };
    const lastRepo = lastAppRepo();
    if (!lastRepo || lastRepo !== repo) return { state: "unavailable", reason: null };
    if (appFolderBlock()) return { state: "blocked", reason: null };
    // the Mac locked, or a create stuck in the queue: the app opens nothing now (INSP-H r2 #2)
    const stalled = appStalledReason(ccLedger.all(), repo, screenWatch.lockedSince, Date.now());
    return stalled ? { state: "unavailable", reason: stalled } : { state: "available", reason: null };
  }

  /** Whether the screen is locked, and since when, read every minute by the
   * desktop app's server with the screen helper (the one the screen actions
   * use). Only the app's server touches the screen helper. */
  const screenWatch: { lockedSince: number | null; lastAt: number; running: boolean } = { lockedSince: null, lastAt: 0, running: false };
  async function watchScreenLock(): Promise<void> {
    if (!DESKTOP_MANAGED || process.env.VITEST || process.platform !== "darwin" || screenWatch.running || Date.now() - screenWatch.lastAt < 60_000) return;
    screenWatch.running = true;
    screenWatch.lastAt = Date.now();
    try {
      const locked = await (await getDesktopDriver()).locked();
      screenWatch.lockedSince = locked ? screenWatch.lockedSince ?? Date.now() : null;
    } catch { /* unknown: keep what was known */ } finally {
      screenWatch.running = false;
    }
  }

  const APP_UNBLOCK_KEY = "app-reused-folder:";

  /** What the owner declined from "Precisa de você", and until when (kept across restarts). */
  const ownerDeclines = (() => {
    const path = join(DATA_DIR, "owner-declines.json");
    let until: Record<string, number> = {};
    try { until = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>; } catch { /* none yet */ }
    return {
      until: (key: string) => (typeof until[key] === "number" ? until[key]! : 0),
      set(key: string, at: number) {
        until = { ...Object.fromEntries(Object.entries(until).filter(([, when]) => when > Date.now())), [key]: at };
        try { writeFileAtomic(path, `${JSON.stringify(until)}\n`, { mode: 0o600 }); } catch (error) { console.error(`[owner-declines] ${error instanceof Error ? error.message : String(error)}`); }
      },
    };
  })();

  /** The app reuses worktrees, so the server will not create there: ONE item
   * in "Precisa de você" asks the owner to unblock it — the action that is
   * theirs alone. Its id, or null when no conversation of the bot can hold it. */
  function askOwnerToUnblockApp(bot: BotRecord, threadId: string, repo: string, block: AppFolderBlock | null = null): string | null {
    const thread = ownerChannelOf(bot.id) ?? threadId;
    if (!store.taskByThread(bot.id, thread)) return null;
    const name = basename(repo);
    // the owner chose "seguir no terminal": not asked again while that holds (INSP-J r1 #8)
    const declinedUntil = ownerDeclines.until(`${APP_UNBLOCK_KEY}${name}`);
    if (declinedUntil > Date.now()) {
      console.log(`[claude-desktop] the owner chose to keep ${name}'s sessions in the terminal until ${new Date(declinedUntil).toISOString()}: not asked again`);
      return null;
    }
    const want = block?.kind === "flapping" ? appFlappingPending(name, block.seen) : appUnblockPending(name, block?.kind ?? "reused");
    const item = autonomy.addOwnerPending(bot.id, thread, { ...want, key: `${APP_UNBLOCK_KEY}${name}` });
    refreshBotRow(bot.id);
    return item.id;
  }

  /** The app sessions the server opened (their local ids): never the
   * owner's, never an anchor. */
  const ourAppLocalIds = () => new Set(ccLedger.all().flatMap((session) => session.desktop?.localId ? [session.desktop.localId] : []));

  /** The blocks the server saw lately (owner-chips.ts noteFolderBlock), kept
   * across restarts: a 2nd switch between "reused" and "root" stops the
   * gestures (INSP-S r1 S-3). */
  const appFolderFlaps = (() => {
    const path = join(DATA_DIR, "app-folder-blocks.json");
    let state: FolderFlapState = { seen: [] };
    try { state = JSON.parse(readFileSync(path, "utf8")) as FolderFlapState; } catch { /* none yet */ }
    return {
      get: () => state,
      set(next: FolderFlapState) {
        if (next === state) return;
        if (next.stoppedAt !== undefined && state.stoppedAt === undefined) console.log(`[claude-desktop] the app flipped ${next.seen.map((each) => each.kind).join(" → ")}: no more gestures asked; sessions go to the terminal until the owner answers or the app stays free`);
        if (next.stoppedAt === undefined && state.stoppedAt !== undefined) console.log("[claude-desktop] the app's flip stop is over (it stayed free, a create worked, it expired, or the owner answered): counted from zero");
        state = next;
        try { writeFileAtomic(path, `${JSON.stringify(state)}\n`, { mode: 0o600 }); } catch (error) { console.error(`[app-folder-blocks] ${error instanceof Error ? error.message : String(error)}`); }
      },
    };
  })();

  /** Why a New Session in the app would land in a wrong folder now: the
   * newest session in a worktree others had used ("reused"), or the server's
   * own last session in the root, without a worktree ("root"); "flapping"
   * once the two took turns (each gesture brought the other back) until the
   * owner answers; null when the app may be used. */
  type AppFolderBlock = { kind: "reused"; last: NonNullable<ReturnType<typeof lastAppWorktreeFolder>> } | { kind: "root"; last: NonNullable<ReturnType<typeof lastServerSessionInRoot>> } | { kind: "flapping"; last: { folder: string; title?: string }; seen: FolderBlockSeen[] };
  function appFolderBlock(): AppFolderBlock | null {
    const reused = lastAppWorktreeFolder();
    const root = reused ? null : lastServerSessionInRoot(ourAppLocalIds());
    const raw: AppFolderBlock | null = reused ? { kind: "reused", last: reused } : root ? { kind: "root", last: root } : null;
    // the latest create of ours that worked: adopted in a worktree of its own and past its folder check (a turn seen)
    const lastGoodCreateAt = Math.max(Number.NEGATIVE_INFINITY, ...ccLedger.all()
      .filter((session) => session.surface === "app" && session.desktop?.localId && !session.desktop.wrongFolder && /\/\.(?:claude\/)?worktrees\//.test(session.cwd ?? "") && (session.turns > 0 || (session.desktop.turnsSeen ?? 0) > 0))
      .map((session) => session.createdAt));
    const flaps = noteFolderBlock(appFolderFlaps.get(), raw ? { kind: raw.kind as "reused" | "root", folder: raw.last.folder, ...(raw.last.title ? { title: raw.last.title } : {}) } : null, Date.now(), lastGoodCreateAt);
    appFolderFlaps.set(flaps);
    if (flaps.stoppedAt !== undefined) return { kind: "flapping", last: raw?.last ?? flaps.seen.at(-1)!, seen: flaps.seen };
    return raw;
  }

  /** The "destravar o app" items close by themselves once the app no longer
   * opens new sessions in a wrong folder. While it still does, an item that
   * asks an older or other gesture (the legacy o8 had only a title, R10-2; or
   * it asked "worktree off" and the server's session then landed in the
   * root) is rewritten to the gesture that fits now, in place. */
  const appUnblockWatch = { lastAt: 0 };
  function settleAppUnblock(): void {
    if (process.platform !== "darwin" || Date.now() - appUnblockWatch.lastAt < 2 * 60_000) return;
    appUnblockWatch.lastAt = Date.now();
    const open = store.bots.flatMap((bot) => autonomy.ownerPendingOf(bot.id)).filter((item) => item.key?.startsWith(APP_UNBLOCK_KEY));
    if (!open.length) return;
    const block = appFolderBlock();
    if (block) {
      for (const item of open) {
        const want = staleUnblockItem(item, item.key!.slice(APP_UNBLOCK_KEY.length), block.kind, block.kind === "flapping" ? block.seen : []);
        if (!want) continue;
        autonomy.addOwnerPending(item.botId, item.threadId, { ...want, key: item.key! });
        refreshBotRow(item.botId);
        console.log(`[claude-desktop] the owner's "destravar o app" item ${item.id} now asks the gesture for "${block.kind}"`);
      }
      return;
    }
    for (const key of new Set(open.map((item) => item.key!))) {
      for (const done of autonomy.resolveOwnerPending({ key })) refreshBotRow(done.botId);
    }
    console.log("[claude-desktop] the app no longer opens new sessions in a wrong folder: the owner's \"destravar o app\" item is closed");
  }

  /** Open queued starts while there are free slots; the bot hears how each
   * went (server/cc-start-queue.ts drainStartQueue). */
  function drainCcStartQueue(): void {
    if (ccStartQueue.corruptPath) {
      // the file could not be read at startup: kept aside, and the Chief hears it once
      const aside = ccStartQueue.corruptPath;
      ccStartQueue.corruptPath = null;
      const chief = store.bots.find((bot) => bot.chiefOfStaff);
      const desk = chief ? chiefDeskThread(chief) : null;
      if (chief && desk && openThreadOf(chief.id, desk)) {
        store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(`A fila de sessões do Claude Code não pôde ser lida ao iniciar; o arquivo foi guardado em ${aside} e a fila começou vazia`, 240), ok: false } });
        autonomy.addReport(chief.id, desk, `[Fila de sessões do Claude Code] The queue file could not be read when the server started; it was kept as ${aside} and the queue started empty. Starts queued before may be lost: check it, and ask the bots to queue again what still applies.`);
      }
    }
    drainStartQueue(ccStartQueue, {
      now: () => Date.now(),
      slotFree: () => ccLedger.slotsTaken() < CC_MAX_RUNNING,
      botExists: (botId) => Boolean(store.bot(botId)),
      threadOpen: (botId, threadId) => openThreadOf(botId, threadId),
      mainThread: (botId, except) => mainThreadOf(botId, except),
      start: (item, threadId, replyThreadId) => {
        const bot = store.bot(item.botId);
        return bot ? startCcSession(bot, threadId, replyThreadId, item.body, true) : { status: 404, body: { error: "o bot não existe mais" } };
      },
      chip: (threadId, text, ok) => { store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: chipText(text, 240), ok } }); },
      report: (botId, threadId, text) => autonomy.addReport(botId, threadId, text),
      log: (text) => console.error(`[cc-start-queue] ${text}`),
    });
  }

  /** A conversation of the bot still open (not archived, closed or deleted). */
  function openThreadOf(botId: string, threadId: string | null | undefined): boolean {
    const task = threadId ? store.taskByThread(botId, threadId) : null;
    return Boolean(task && !task.archivedAt && !task.closedBy);
  }

  /** Where a bot hears what concerns a conversation that may be gone: that
   * one while open, else its main conversation (mainThreadOf). */
  function liveThreadFor(botId: string, threadId: string): string | null {
    return openThreadOf(botId, threadId) ? threadId : mainThreadOf(botId, threadId);
  }

  /** A session archived in the Claude app by someone, not by the server: its
   * PRs still open are left without a session. The owner hears which, and the
   * person gets a "Precisa de você" item (INSP-F F1: ffd6ee1a / #N) — in
   * the conversation that owned it, or in the bot's main one when that one
   * was closed. The logic is server/archived-outside.ts. */
  const archivedOutsideWatch = { running: false };
  async function watchArchivedOutside(): Promise<void> {
    if (archivedOutsideWatch.running) return;
    archivedOutsideWatch.running = true;
    // the conversation with the owner first: an orphaned PR is the owner's to hear about there
    const where = (session: CcSession) => ownerChannelOf(session.ownerBotId) ?? liveThreadFor(session.ownerBotId, session.ownerThreadId);
    try {
      await checkArchivedOutside(ccLedger.all(), {
        now: () => Date.now(),
        save: () => ccLedger.save(),
        slugOf: async (session) => githubSlug((await execCc("git", ["-C", session.repo, "remote", "get-url", "origin"])).trim()),
        ...githubLookups(execCc),
        chip: (session, text, ok) => {
          const threadId = where(session);
          if (threadId) store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Claude Code "${session.title.slice(0, 60)}": ${text}`, 240), ok } });
          refreshBotRow(session.ownerBotId);
        },
        report: (session, text) => {
          const threadId = where(session);
          if (threadId) autonomy.addReport(session.ownerBotId, threadId, text);
          else console.error(`[cc-sessions] archived-outside report for ${session.id} has no open conversation of ${session.ownerBotId}: ${text.slice(0, 200)}`);
        },
        ownerPending: (session, item) => {
          const threadId = where(session);
          if (!threadId) return;
          autonomy.addOwnerPending(session.ownerBotId, threadId, item);
          refreshBotRow(session.ownerBotId);
        },
      });
    } finally {
      archivedOutsideWatch.running = false;
    }
  }
  /** The boot-time work, run once index.ts holds everything returned here. */
  function bootCcRuntime(): void {
    adoptOwnerChannels();
    backfillClaimedPrs();
    bootDesk = (() => {
      const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
      return chief ? chiefDeskThread(chief) : null;
    })();
    if (ccLedger.interruptedOnLoad.length) {
      for (const session of ccLedger.interruptedOnLoad) {
        ccChipShort(session, sessionChips.interrupted(session.title, session.turns), false, bootDesk);
        ccReport(session, ccReportForOwner(session));
      }
      ccLedger.save();
    }
    // ...and these went on working: followed to the end of their turn (followSurvivingSessions)
    for (const session of ccLedger.survivedOnLoad) ccChipShort(session, sessionChips.survived(session.title, session.turns), true, bootDesk);
    if (ccLedger.survivedOnLoad.length) ccLedger.save();
    reportResumptionToChief();
    retireWorkOfClosedThreads();
    renameResultsThreads();
    warnArmedIgnores();
    // App sessions an older build failed over a screen step are alive in the
    // app: back to idle on load, so they take messages again.
    if (process.platform === "darwin") reviveScreenFailures(desktopWork);
  }
  return { bootCcRuntime, sharedState, ccLedger, ccProcesses, ccTurnTimeoutMs, ownerTurnThread, moveWorkToOwnerThread, ccChip, ccChipShort, ccReport, runCcTurn, desktopState, desktopWork, cleanReleasedWorktrees, reportArchivedWorktrees, watchBackgroundJobs, execCc, retireThreadWork, noteClaimedPrs, releaseHold, refreshReleaseHold, resumeOf, wireResumeOf, preemptCiForReleaseTick, ccStartQueue, ccSlotFreeForWork, startCcSession, watchScreenLock, APP_UNBLOCK_KEY, ownerDeclines, appFolderFlaps, appFolderBlock, settleAppUnblock, drainCcStartQueue, openThreadOf, watchArchivedOutside };
}
