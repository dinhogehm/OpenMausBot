// Claude Code sessions a bot manages, run by the server: turns, worktrees, the release hold, the start queue and the app watches.
import { createCcOwnRuntime } from "./cc-own-runtime.ts";
import { createCcOwnerRuntime } from "./cc-owner-runtime.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { type WireCcAlert, type WireOwnerPending, type WireCcSession, type WireTask } from "../shared/wire.ts";
import { DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { toolCallsWith } from "./message-db.ts";

import { BotAutonomy, chipText, STANDING_DEFAULT_LABEL, watchLabel } from "./bot-autonomy.ts";
import { watchIgnoreWarnings } from "./wake-watch.ts";
import { CC_MAX_RUNNING, CC_TURN_TIMEOUT_MS, CcSessionLedger, ccProcAlive, PS_BIN, PS_ENV, ccReportForOwner, ccTurnArgs, parseCcStartInput, repoCorridor, cliSurfaceRefusal, appStalledReason, recentAppFailure, issueTitle, clientIssue, type AppAvailability, hotfixWithReleaseScripts, corridorVersionOf, repoPackageManager, repoScripts, useRepoScripts, parseCcStream, type CcSession, appFailureRead, CC_APP_FULL_REFUSAL } from "./cc-sessions.ts";
import { DESKTOP_IDLE_SECONDS, newMarker, lastAppRepo, lastAppWorktreeFolder, lastServerSessionInRoot, reusedFolderRefusal, rootFolderRefusal } from "./claude-desktop.ts";
import { issueNumber, liveSessionForIssue, uniqueSessionTitle, reviveScreenFailures, screenWaitOf, reportFor as desktopReportFor, takeFreshQueued } from "./desktop-work.ts";

import { BG_JOB_MAX_MS, cutLeftovers, parseLsofCwd, backgroundProcesses, bgJobOverdueReport, bgJobResumePrompt, jobAlive, newTurnTree, noteDescendants, psTable, type TurnTree, gateLabel, mergeProcesses, sessionGates, type BgProcess } from "./bg-jobs.ts";
import { spawn as spawnCcProcess, execFile as execFileCc, execFileSync as execFileSyncCc, type ChildProcess as CcChildProcess } from "node:child_process";
import { claimsInToolCalls, githubSlug, parseLsRemoteTag, PRODUCTION_TAG, resumeNeeded } from "./prod-delivery.ts";
import { checkArchivedOutside, githubLookups } from "./archived-outside.ts";
import { sessionErrorPt } from "../shared/session-error-pt.ts";
import { SESSION_TOKEN_SERVICE, SessionToken } from "./session-token.ts";
import { appFlappingPending, appUnblockPending, flappingRefusal, type FolderBlockSeen, type FolderFlapState, noteFolderBlock, serverRestartedChip, sessionChips, staleUnblockItem } from "./owner-chips.ts";
import { SharedState } from "./shared-state.ts";

import { type AdmissionLease, ciQueuedBehindRelease, ciQueuedText, type DeployLease, preemptCiForRelease, type PreemptState, RELEASE_QUEUE_CEILING_S, releaseHoldText, releaseInFlight, type ReleaseIntent, releaseLabelSha, releaseOverdueText, resumeAfterRelease, stoppedReleaseFromLog, type ReleaseInFlight, releaseResumeHold } from "./release-priority.ts";
import { DECLINED_SHA_FILE, haltedRelease, readTail, RELEASE_ERR_LOG, RELEASE_OUT_LOG, RELEASED_SHA_FILE, releaseFailures, releaseInLoop, ReleaseWatchState, RELEASE_FAILURES_ALERT, LAST_FAILURE_FILE } from "./release-watch.ts";
import { cloudHomeConfiguration } from "./cloud-home.ts";
import { CcStartQueue, drainStartQueue, priorityLabel, slotFreeForWork, START_QUEUE_MAX, startGate, startPriority, type StartResult } from "./cc-start-queue.ts";

import { Store, type BotRecord } from "./store.ts";

import { type DelegatedItemRef } from "./owner-delegate.ts";
import { fixedRowWarning } from "./owner-pending-guard.ts";
import { type ProductivityCollector } from "./productivity-collector.ts";
import { PipelineBoardService } from "./pipeline-board-live.ts";
import { presetPeriod } from "../shared/productivity.ts";
import { NowStatusService } from "./now-status.ts";
import { execGh } from "./productivity-github.ts";

import { breakerRepo, ownBreakerCli, planOwnWorktree } from "./own-worktrees.ts";

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
  fullAccessForSource: (botId: string, threadId: string) => boolean;
  productivityEnabled: boolean;
  productivity: Pick<ProductivityCollector, "report" | "releaseRuns" | "refreshLogs" | "boardSource">;
  readProductionTag: () => Promise<string | null>;
  broadcast: (payload: Record<string, unknown>, options?: { adminOnly?: boolean }) => void;
  nuriaStopFile: string;
  assertBudget: () => void;
  releaseDelegationAnswer: (botId: string, itemId: string) => void;
  store: Store;
  setThreadSignals: (signals: (threadId: string) => ThreadSignals) => void;
}

type ThreadSignals = Pick<WireTask, "watches" | "watchesLost" | "ccAlerts" | "ownerPending" | "ccSessions">;

/** Built once, where server/index.ts used to declare all of this inline. */
export function createCcRuntime(deps: CcRuntimeDeps) {
  const { DESKTOP_MANAGED, alertAutomationTrouble, autonomy, autonomyTestMs, carrierPowerCheck, chiefDeskThread, mainThreadOf, readHaltedRelease, refreshBotRow, releaseAlertToChief, releaseWatch, fullAccessForSource, productivityEnabled, productivity, readProductionTag, broadcast, nuriaStopFile, assertBudget, store, setThreadSignals } = deps;
  const sharedState = new SharedState(join(DATA_DIR, "bots"));

  // ── Claude Code sessions a bot manages (server/cc-sessions.ts) ─────────
  // a turn's claude that outlived the server is followed, not marked failed (R9-resilience RS-PID)
  const ccLedger = new CcSessionLedger({ path: join(DATA_DIR, "cc-sessions.json"), procAlive: ccProcAlive });
  // The owner's last channel order, read back from the history before
  // anything is reported: what the boot says goes to the conversation they named.

  /** Once per session: the PRs its orders handed it before claimedPrs existed
   * ("assuma a PR #9328", 01/10 18:13, to the 29da943f), read back from the
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
  // The Chief resumption report waits for cut-lease reconciliation in the first autonomy tick.

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
    // This fork: each cut lease as resumeCutLeases gave it back (bot-autonomy.ts RecoveredLease)
    const open = leases.filter((lease) => !lease.dropped && !lease.continued);
    const continued = leases.filter((lease) => !lease.dropped && lease.continued);
    const dropped = leases.filter((lease) => lease.dropped);
    const outward = open.filter((lease) => lease.outward !== undefined);
    const rerun = open.filter((lease) => lease.outward === undefined && !lease.stale);
    const asked = open.filter((lease) => lease.outward === undefined && lease.stale);
    const kindPt = (lease: { kind: string }) => (lease.kind === "wake" ? "despertador/vigia" : "relatórios");
    const text = [
      "[Relatório de retomada — o servidor reiniciou]",
      ...(rerun.length ? ["Reenviado automaticamente (turnos cortados pelo restart, retomados como devidos):", ...rerun.map((lease) => `- ${name(lease.botId)} · ${kindPt(lease)} de ${when(lease.startedAt)} (conversa ${lease.threadId}): ${lease.what}`)] : []),
      ...(outward.length ? ["NÃO repetido (o turno já tinha agido para fora antes do corte; o bot foi perguntado, com o que já fez — confira que nada saiu duas vezes):", ...outward.map((lease) => `- ${name(lease.botId)} · ${kindPt(lease)} de ${when(lease.startedAt)} (conversa ${lease.threadId}): ${lease.what} — ${lease.outward!.length ? `já feito: ${lease.outward!.slice(0, 8).join(", ")}` : "não deu para conferir o que ele já tinha feito"}`)] : []),
      ...(asked.length ? ["NÃO repetido (mais de 6 h; o bot foi perguntado se ainda vale):", ...asked.map((lease) => `- ${name(lease.botId)} · ${lease.kind} de ${when(lease.startedAt)} (conversa ${lease.threadId}): ${lease.what}`)] : []),
      ...(continued.length ? ["Não reenviado (o turno tinha passado trabalho a colegas ou esperava uma resposta; ele mesmo continua de onde parou quando ela chegar, ou já continuou depois do restart):", ...continued.map((lease) => `- ${name(lease.botId)} · ${kindPt(lease)} de ${when(lease.startedAt)} (conversa ${lease.threadId}): ${lease.what}`)] : []),
      ...(dropped.length ? ["Descartado (parado pela pessoa, ou a conversa foi encerrada, antes da retomada):", ...dropped.map((lease) => `- ${name(lease.botId)} · ${kindPt(lease)} de ${when(lease.startedAt)} (conversa ${lease.threadId}): ${lease.what}`)] : []),
      ...(sessions.length ? ["Sessões do Claude Code interrompidas (o turno foi cortado e o processo claude não sobreviveu; o dono de cada uma recebeu o relatório):", ...sessions.map((session) => `- "${session.title}" (${session.id}) de ${name(session.ownerBotId)}`)] : []),
      ...(survived.length ? ["Sessões do Claude Code cujo processo claude seguiu rodando (o servidor acompanha até o fim do turno e o relatório chega como de costume; NÃO retome nem mande outra mensagem para elas agora):", ...survived.map((session) => `- "${session.title}" (${session.id}, PID ${session.proc?.pid}) de ${name(session.ownerBotId)}`)] : []),
      "Confira o que ficou pendente e retome o que for preciso.",
    ].join("\n");
    // a turn its own root carries on counts as resumed; one not run again for what it did, as one to confirm
    const toConfirm = asked.length + outward.length;
    store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(serverRestartedChip({ interrupted: sessions.length, survived: survived.length, rerun: rerun.length + continued.length, asked: toConfirm }), 200), ok: toConfirm === 0 && sessions.length === 0 } });
    autonomy.addReport(chief.id, desk, text);
  }
  const ccProcesses = new Map<string, CcChildProcess>();
  /** Sessions whose ended turn is being checked for what it left running (its background job). */
  const ccLeftoverChecks = new Set<string>();
  // OMB_CC_BIN points end-to-end tests at a scripted stand-in for `claude`.
  const ccBin = (): string => process.env.OMB_CC_BIN || "claude";
  // OMB_CC_TURN_TIMEOUT_MS shortens the turn cut for end-to-end tests only.
  const ccTurnTimeoutMs = Number(process.env.OMB_CC_TURN_TIMEOUT_MS) > 0 ? Number(process.env.OMB_CC_TURN_TIMEOUT_MS) : CC_TURN_TIMEOUT_MS;
  // The gate wait (INSP-R13res A1, R2 B6). A turn past its limit while a gate
  // of its session runs is not cut: on a cut Claude Code kills its own
  // background shells, the gate with them. The cut waits for the gate, checked
  // once a minute, and the rule is the same for a turn the server runs and for
  // one followed after a restart: never past this long from the turn's start.
  // The wait of a ci:local queued behind a release is a separate excuse, never
  // added to it: the cut comes at whichever ends later, so a turn lasts at
  // most what the release queue alone allowed before (~6,5 h), or 3 h.
  // Unknown (ps or lsof failed) counts as a gate still running: the next check
  // decides, and the ceiling still holds (R2 B2). OMB_CC_GATE_WAIT_MAX_MS
  // shortens it for tests.
  const ccGateWaitMaxMs = Number(process.env.OMB_CC_GATE_WAIT_MAX_MS) > 0 ? Number(process.env.OMB_CC_GATE_WAIT_MAX_MS) : 3 * 3_600_000;
  /** How long a cut waited for the gate, as it was (R2 B7): "depois de esperar 90 min pelo gate". */
  const gateWaitPt = (waitedMs: number) => (waitedMs > 0 ? `depois de esperar ${spanPt(waitedMs)} pelo gate` : "já além do teto de espera do gate");
  const gateWaitEn = (waitedMs: number) => (waitedMs > 0 ? `after waiting ${spanPt(waitedMs)} for it` : "already past the gate wait's ceiling");
  /** How often a gate wait is checked again. */
  const ccGateRecheckMs = Math.min(60_000, ccTurnTimeoutMs);
  /** Sessions whose cut waits for their gate, and since when: a delegated item does not time out meanwhile. */
  const ccGateWaits = new Map<string, number>();
  /** Every session's claude: never a gate, even when its prompt names one (R2 B3). */
  const ccClaudePids = (): number[] => [
    ...[...ccProcesses.values()].map((child) => child.pid ?? 0),
    ...ccLedger.all().map((session) => session.proc?.pid ?? 0),
  ].filter((pid) => pid > 0);
  /** "3 h", "90 min": how long, for the owner. */
  const spanPt = (ms: number) => (ms >= 3_600_000 ? `${Math.round(ms / 360_000) / 10} h`.replace(".", ",") : `${Math.max(1, Math.round(ms / 60_000))} min`);
  /** The turn's worktree, when it has one: only there a gate is the session's. */
  const worktreeFolder = (folder: string | undefined) => (folder && folder.includes("/.claude/worktrees/") ? folder : null);
  const CC_TURN_FOOTER = "\n\nWhen you stop, end with a short report for your manager: what you changed, the branch and PR (link), what the tests and the repository's gates say, and exactly what is blocked or needs a decision. When you merge a batch of PRs: hotfix/P0/P1 work (by label, title or the linked issue's priority) goes first, ahead of CI or infrastructure PRs, released on its own; PRs that change release scripts (release, carrier, merge-gate or production-watch scripts) go last, in a separate release, with a dry run first. Follow the repository's own rules (CLAUDE.md/AGENTS.md) for issues, PRs, gates and releases, and run its scripts with the package manager they name (npm run when the repository has a package-lock.json — never swap in pnpm or yarn). Do not use AskUserQuestion or wait for an answer mid-turn: if you need a decision or an approval, stop and put the question in your final report. Write your reports and summaries — everything the person reads in the app — in Brazilian Portuguese (pt-BR); keep code, commands and identifiers as they are.";
  /** The footer of a first turn: the general rules, plus the repository's own corridor. */
  const ccTurnFooter = (session: CcSession): string => `${CC_TURN_FOOTER}${repoCorridor(session.repo)}`;
  /** Headless runs only: nothing wakes such a session after its turn ends. */
  const CC_CLI_FOOTER = "\nYou run headless: nothing wakes you after you stop. Never end your turn waiting on a background job or a notification — run gates in the foreground and wait for them (up to 80 min), or report the PID, the log/receipt path and what to check.";

  function ccIsGitRepo(path: string): boolean {
    if (!path.startsWith(homedir()) || !existsSync(path)) return false;
    try {
      return execFileSyncCc("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe", env: { ...process.env, PATH: augmentedPath() } }).toString().trim() === "true";
    } catch {
      return false;
    }
  }

  const { ownerChannelOf, sessionReportThread, ownerTurnThread, moveWorkToOwnerThread, adoptOwnerChannels, ccChip, ccChipShort, ccReport, retireThreadWork, noteClaimedPrs, delegationTime, delegateView, delegationOwner, delegationChip, delegationOpened, delegationReturned, reconcileDelegations, wireDelegation } = createCcOwnerRuntime({
    ...deps, sharedState, ccLedger, ccLeftoverChecks, ccGateWaits,
    get ccStartQueue() { return ccStartQueue; },
    execCc: (file, args, cwd) => execCc(file, args, cwd), openThreadOf,
  });

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
    const fullAccess = fullAccessForSource(session.ownerBotId, session.ownerThreadId);
    session.lastTurnPermissionMode = fullAccess ? "bypassPermissions" : session.permissionMode;
    const expectedCwd = join(session.repo, ".claude", "worktrees", session.worktree);
    // the first turn runs in the worktree the server made, or in the repository for claude -w to make one
    const cwd = first ? session.cliWorktree?.path ?? session.repo : session.cwd ?? (existsSync(expectedCwd) ? expectedCwd : session.repo);
    ccLedger.markRunning(session);
    const lines: string[] = [];
    let buffer = "";
    let timedOut = false;
    let settled = false;
    // where this turn works, as its init event says: its gate runs there
    let initCwd: string | undefined;
    const keep = (line: string) => {
      if (initCwd === undefined && line.includes('"subtype":"init"')) {
        try {
          const said = (JSON.parse(line) as { cwd?: unknown }).cwd;
          if (typeof said === "string") initCwd = said;
        } catch { /* not the event */ }
      }
      // Tool output can be huge; only the init and result events matter here.
      if (line.includes('"subtype":"init"') || line.includes('"type":"result"') || !line.startsWith("{")) {
        lines.push(line);
        if (lines.length > 50) lines.splice(0, lines.length - 50);
      }
    };
    let child: CcChildProcess;
    try {
      child = spawnCcProcess(ccBin(), ccTurnArgs(session, first ? `${prompt}${ccTurnFooter(session)}${CC_CLI_FOOTER}` : prompt, first, fullAccess), {
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
    // the gate this turn's cut waited for, past the ceiling: cut with it, and how long it waited (INSP-R13res A1, R2 B7)
    let gateCut = "";
    let gateWaitedMs = 0;
    let gateWaitSince = 0;
    // the last gates a check could see: an unknown check keeps them (R2 B2)
    let gatesSeen: BgProcess[] = [];
    const cutOrWait = () => {
      if (settled) return;
      const now = Date.now();
      const due = turnStartedAt + ccTurnTimeoutMs + queuedMs + (queuedSince ? now - queuedSince : 0);
      if (queuedSince || now < due) {
        timer = setTimeout(cutOrWait, Math.max(60_000, due - now));
        timer.unref();
        return;
      }
      // A gate of this session still at work: on a cut Claude Code kills its
      // background shells, the gate with them. The cut waits for the gate (the
      // turn goes on, and hears its result) up to the ceiling.
      // its worktree as its init event said it, else as the ledger knows it, else
      // where a first turn's `-w` makes it (a claude slow to start has said nothing yet)
      let expected: string | undefined;
      try { expected = realpathSync(expectedCwd); } catch { /* not made yet */ }
      const folder = worktreeFolder(initCwd ?? session.cwd ?? expected);
      void (folder ? sessionGates(folder, ccClaudePids()) : Promise.resolve([])).catch(() => null).then((found) => {
        if (settled) return;
        if (found) gatesSeen = found;
        const running = found === null || found.length > 0;
        if (running && Date.now() < turnStartedAt + ccGateWaitMaxMs) {
          if (!gateWaitSince) {
            gateWaitSince = Date.now();
            ccGateWaits.set(session.id, gateWaitSince);
            ccChip(session, `turno passou de ${Math.round(ccTurnTimeoutMs / 60_000)} min, mas o gate (${gateLabel(gatesSeen)}) da sessão ainda roda; o corte espera o gate terminar (até ${spanPt(ccGateWaitMaxMs)} de turno)`);
          }
          console.log(`[cc-sessions] ${session.id}: past the turn limit, gate check: ${found === null ? "unknown (ps/lsof failed)" : `running (${found.map((gate) => gate.pid).join(", ")})`}: the cut waits`);
          timer = setTimeout(cutOrWait, ccGateRecheckMs);
          timer.unref();
          return;
        }
        if (gateWaitSince) gateWaitedMs = Date.now() - gateWaitSince;
        ccGateWaits.delete(session.id);
        // past the ceiling: the gate it waited for, or the last one seen when this check could not tell
        if (running && (found?.length || gatesSeen.length)) gateCut = gateLabel(found?.length ? found : gatesSeen);
        console.log(`[cc-sessions] ${session.id}: cut at the turn limit, gate check: ${!folder ? "no worktree known" : found === null ? "unknown" : found.length ? `running (${found.map((gate) => gate.pid).join(", ")}), past the ceiling` : "none"}`);
        timedOut = true;
        if (overdueReason) ccChip(session, `turno cortado: ${overdueReason}`, false);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      });
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
      ccGateWaits.delete(session.id);
      const outcome = parseCcStream([...lines, ...(spawnError ? [spawnError] : []), ...stderr.split("\n").slice(-5)], { code, signal, timedOut });
      // cut with its gate running: said in the same write as the cut (R2 B1)
      if (gateCut && timedOut && !outcome.ok) outcome.error = `${outcome.error ?? "its turn was cut"}; it was cut while its gate (${gateCut}) still ran, ${gateWaitEn(gateWaitedMs)}`;
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
      // cut past the gate's ceiling, and nothing of it outlived the cut: said as it is
      const gateLost = () => {
        ccChip(session, `turno cortado com ${spanPt(ccGateWaitMaxMs)} de turno, ${gateWaitPt(gateWaitedMs)} (${gateCut}) — gate interrompido pelo corte, sem resultado`, false);
        ccReport(session, `${desktopReportFor(desktopWork, session)}\n(Its turn passed the ${limitMin}-min limit while its gate (${gateCut}) ran; it was cut at the ${spanPt(ccGateWaitMaxMs)} ceiling from the turn's start, ${gateWaitEn(gateWaitedMs)}, and the gate was stopped with it: there is no gate result. Check why the gate ran that long before having it run again.)`);
      };
      if ((session.status === "idle" || cut) && tree && folder && folder.includes("/.claude/worktrees/")) {
        // until it is known whether a job is left, a delegated item does not settle on this turn
        ccLeftoverChecks.add(session.id);
        void Promise.all([backgroundProcesses(folder, tree), cut ? sessionGates(folder, [tree.rootPid, ...ccClaudePids()]).then((gates) => gates ?? []).catch(() => []) : Promise.resolve([])]).finally(() => ccLeftoverChecks.delete(session.id)).then(([found, gates]) => {
          // after a cut only a group of its own counts (the gate), and a gate
          // that outlived the cut wherever it runs (nohup); the claude's own
          // group (MCP servers) dies with it
          const left = cut ? mergeProcesses(cutLeftovers(found, tree.rootPid), gates) : found;
          if (!left.length || (session.status !== "idle" && !(cut && session.status === "failed"))) {
            if (gateCut && cut) gateLost();
            else ccReport(session, desktopReportFor(desktopWork, session));
            return;
          }
          followBgJob(session, left, cut, limitMin, () => ccChip(session, cut
            ? `turno cortado em ${limitMin} min com ${left.length} processo(s) ainda rodando — o servidor retoma a sessão quando terminarem`
            : `terminou o turno com ${left.length} processo(s) rodando em segundo plano — o servidor retoma a sessão quando terminarem`));
        }).catch(() => ccReport(session, desktopReportFor(desktopWork, session)));
        return;
      }
      if (gateCut && cut) gateLost();
      else ccReport(session, desktopReportFor(desktopWork, session));
    };
    child.on("error", (error) => finish(null, null, `could not run ${ccBin()}: ${error.message}`));
    child.on("close", (code, signal) => finish(code, signal));
  }

  /** What a turn left running in its worktree, followed as the session's
   * background job: the tick resumes the session with a new turn once it is
   * all gone (watchBackgroundJobs), once at most after a cut. `chip` says it
   * where the session is followed; the report tells the owner. */
  function followBgJob(session: CcSession, left: readonly BgProcess[], cut: boolean, limitMin: number, chip: () => void): void {
    session.bgJob = { pids: left.map((proc) => proc.pid), commands: left.map((proc) => proc.command), starts: left.map((proc) => proc.start), since: Date.now(), ...(cut ? { afterCut: true as const } : {}) };
    ccLedger.save();
    chip();
    ccReport(session, `${desktopReportFor(desktopWork, session)}\n(Its turn ${cut ? `was cut at the ${limitMin}-min limit` : "ended"} with process(es) still running in its worktree: ${left.map((proc) => `PID ${proc.pid} ${proc.command.slice(0, 80)}`).join("; ")}. The server resumes the session with a new turn when they finish, and tells you if they are still running after ${Math.round(BG_JOB_MAX_MS / 3_600_000)} h.${cut ? " One of them may be what stalled the turn; the server resumes it once at most — cut again, it waits for you." : ""})`);
  }

  const { desktopState, getDesktopDriver, desktopBrief, ownStore, ownWorktreesOn, ownBreaker, ownPathActive, ownOnByName, settleOwnBreaker, ownPlanTaken, ownPrepareState, startSeededCli, refreshOwnSeeds, desktopWork, registeredWorktreePaths, releasedCleanup, gitAsync, allProcessCwds, foldersInUse, canonPath, duKb, cleanReleasedWorktrees, reportArchivedWorktrees } = createCcOwnRuntime({
    ...deps, ccLedger, ccProcesses, ccTurnFooter, ownerChannelOf, sessionReportThread, ccChip, ccChipShort, ccReport, runCcTurn,
    execCc: (file, args, cwd) => execCc(file, args, cwd),
    get releaseHold() { return releaseHold; }, refreshReleaseHold, startCcSession,
    ourAppLocalIds: () => ourAppLocalIds(), appFolderBlock,
  });

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
      // a routine's item said once and let go: under "Talvez já resolvido", out of the count (INSP-N22 r2 F2)
      ...(item.demotedAt ? { demotedAt: item.demotedAt } : {}),
      // "Delegar a um agente": the button, why not, or the delegation running or back (lote del)
      ...wireDelegation(item),
      // another item said its commands must not run; a fixed sheet row that may have changed (R13-intake #1)
      ...(item.supersededBy ? { superseded: { by: `${item.supersededBy.id} do ${item.supersededBy.botName}`, at: item.supersededBy.at, text: item.supersededBy.text } } : {}),
      ...(() => { const warning = fixedRowWarning(item, Date.now()); return warning ? { rowWarning: warning } : {}; })(),
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

  /** Send a message to a session the way cc_session_send would, from the
   * server: now if it is idle, else after its current turn. */
  function sendToSessionFromServer(session: CcSession, text: string): boolean {
    if (session.surface === "app" && fullAccessForSource(session.ownerBotId, session.ownerThreadId)) {
      if (session.blockedOn !== CC_APP_FULL_REFUSAL) {
        session.blockedOn = CC_APP_FULL_REFUSAL;
        ccLedger.save();
        ccChip(session, CC_APP_FULL_REFUSAL, false);
      }
      return false;
    }
    if (session.surface === "app" && session.desktop) {
      if (session.status === "idle" && !session.desktop.pending && !session.desktop.sent) {
        session.desktop.pending = { kind: "send", text, since: Date.now(), attempts: 0 };
        session.status = "running";
        ccLedger.save();
      } else ccLedger.enqueue(session, text);
      return true;
    }
    if (session.status !== "running" && !ccProcesses.has(session.id) && ccSlotFreeForWork()) runCcTurn(session, text, false);
    else ccLedger.enqueue(session, text);
    return true;
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
    return { ownerPid, label: readAdmissionFile("deploy-lease", "label") ?? "", start: readAdmissionFile("deploy-lease", "start"), startedAt: startedAt > 0 ? startedAt : undefined, checkout: readAdmissionFile("deploy-lease", "checkout") };
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

  /** "Agora" (lot Y): the delivery line's state for the panel at the top of the
   * sidebar — production, the release on its way, open PRs and their gate, the
   * ci:local, release alerts and today's throughput — recomputed every minute,
   * pushed to the screens when it changes. Read-only; same inputs, same panel. */
  const nowStatus = new NowStatusService({
    dataDir: DATA_DIR,
    enabled: productivityEnabled,
    report: () => productivity.report("day", presetPeriod("day", 1, Date.now())),
    runs: () => productivity.releaseRuns(),
    refreshLogs: () => productivity.refreshLogs(),
    outLog: RELEASE_OUT_LOG,
    releaseStartedFile: join(ADMISSION_DIR, "release-started.json"),
    readLease: readAdmissionLease,
    readDeployLease,
    leaseSince: () => { try { return statSync(join(ADMISSION_DIR, "lease", "owner.pid")).mtimeMs; } catch { return null; } },
    inFlight: (rows) => {
      // intents/ unreadable is undecided, never "no release" (admission-control.sh creates it on every acquire)
      const intents = readReleaseIntents();
      if (intents === null) throw new Error("release intents unreadable");
      return releaseInFlight({ rows, lease: readAdmissionLease(), deployLease: readDeployLease(), intents, alive: (pid) => rows.some((row) => row.pid === pid) });
    },
    ps: psTable,
    gh: execGh,
    git: (args) => execCc("git", ["-C", join(homedir(), "Projetos", "nuria-platform"), ...args]),
    sessions: () => ccLedger.all().filter((session) => session.status !== "archived").map((session) => ({
      sessionId: session.id,
      ...(ccProcesses.get(session.id)?.pid ? { claudePid: ccProcesses.get(session.id)!.pid } : {}),
      ...(session.bgJob ? { jobPids: session.bgJob.pids, ...(session.bgJob.starts ? { jobStarts: session.bgJob.starts } : {}) } : {}),
      ...(session.surface === "app" && session.cwd ? { worktree: session.cwd } : {}),
    })),
    sessionInfo: (sessionId) => {
      const session = ccLedger.get(sessionId);
      return session ? { sessionId, title: session.title, botId: session.ownerBotId, threadId: session.ownerThreadId } : null;
    },
    failing: () => {
      const failed = releaseFailures(readTail(RELEASE_ERR_LOG, 128 * 1024), readTail(RELEASED_SHA_FILE, 200).trim());
      const declined = readTail(DECLINED_SHA_FILE, 200).trim();
      if (!failed || failed.count < RELEASE_FAILURES_ALERT || (declined && (declined.startsWith(failed.sha) || failed.sha.startsWith(declined)))) return null;
      // when it last failed: the watcher's last-failure record, else the err log's last write (never the read)
      const mtime = (path: string) => { try { return statSync(path).mtimeMs; } catch { return null; } };
      return { ...failed, at: mtime(LAST_FAILURE_FILE) ?? mtime(RELEASE_ERR_LOG) };
    },
    readTag: readProductionTag,
    declined: () => readTail(DECLINED_SHA_FILE, 200).trim() || null,
    onChange: (status) => broadcast({ kind: "now", status }, { adminOnly: true }),
    log: (line) => console.log(line),
  });

  /** A production release on its way on this Mac (release-priority.ts
   * releaseInFlight), read at most once a minute: while one is, no session is
   * told to resume (INSP-S r1 S-1). `label` null: none; "?" while the
   * admission state cannot be read (undecided, so nobody is told either). A
   * release past the ceiling has likely hung and holds nothing. In its network
   * phase (lote W2, "deploying") the machine is free: only the session in the
   * checkout the release deploys from is held (R11 #2; `found`/`checkout`). */
  const releaseHold: { label: string | null; found: ReleaseInFlight | null; checkout: string | null; at: number; running: boolean } = { label: null, found: null, checkout: null, at: 0, running: false };
  // a test's minute is shorter (OMB_AUTONOMY_MINUTE_MS)
  const RELEASE_HOLD_EVERY_MS = autonomyTestMs("OMB_AUTONOMY_MINUTE_MS") ?? 60_000;
  async function refreshReleaseHold(): Promise<void> {
    if (releaseHold.running || Date.now() - releaseHold.at < RELEASE_HOLD_EVERY_MS) return;
    releaseHold.running = true;
    try {
      let label: string | null;
      let found: ReleaseInFlight | null = null;
      let checkout: string | null = null;
      try {
        const lease = readAdmissionLease();
        const deployLease = readDeployLease();
        const intents = readReleaseIntents() ?? [];
        if (!lease && !deployLease && !intents.length) label = null;
        else {
          const rows = await psTable();
          found = releaseInFlight({ rows, lease, deployLease, intents, alive: (pid) => rows.some((row) => row.pid === pid) });
          checkout = deployLease?.checkout ?? null;
          label = releaseResumeHold(found);
        }
      } catch {
        label = "?";
      }
      const said = label ?? (found?.state === "deploying" && !found.overdue ? `none (${releaseHoldText(found)})` : null);
      if (label !== releaseHold.label || found?.state !== releaseHold.found?.state) console.log(`[cc-sessions] release hold: ${said === null ? "none" : label === "?" ? "admission state unreadable" : said}`);
      releaseHold.label = label;
      releaseHold.found = found;
      releaseHold.checkout = checkout;
      releaseHold.at = Date.now();
    } finally {
      releaseHold.running = false;
    }
  }
  /** The release hold this server last read, for this session: in the release's
   * network phase only the session in the checkout it deploys from is held. */
  const releaseHoldOf = (session: Pick<CcSession, "cwd">): string | null => {
    if (releaseHold.label !== null || releaseHold.found?.state !== "deploying" || !session.cwd) return releaseHold.label;
    let cwd = session.cwd;
    try { cwd = realpathSync(cwd); } catch { /* gone: compared as recorded */ }
    return releaseResumeHold(releaseHold.found, cwd, releaseHold.checkout);
  };
  /** resumeNeeded under the release hold this server last read. */
  const resumeOf = (session: CcSession, now = Date.now()) => resumeNeeded(session, now, { release: releaseHoldOf(session) });
  /** What a row shows: the session still holds its PR while a release runs,
   * so the mark stays, "on hold" — parked behind the release, or with one on
   * its way — instead of vanishing and coming back (INSP-S r2 S2-3). The bots
   * are told nothing meanwhile (resumeOf). */
  const wireResumeOf = (session: CcSession, now = Date.now()): WireCcSession["resume"] | null => {
    const held = session.resumeAfterTag ? "parked" as const : releaseHoldOf(session) ? "release" as const : null;
    const need = resumeNeeded(held === "parked" ? { ...session, resumeAfterTag: undefined } : session, now);
    return need ? { ...need, ...(held ? { held } : {}) } : null;
  };

  // ── "Esteira" (lot Z): the delivery pipeline board ──
  // Built from the productivity collector's cache plus the live state held
  // here (sessions, "Precisa de você", the release hold, the admission lease);
  // the open PRs are read for it through gh, read-only, only when it is asked for.
  const pidAlive = (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const pipelineBoard = new PipelineBoardService({
    enabled: productivityEnabled,
    limitsFile: join(DATA_DIR, "pipeline-board", "limits.json"),
    source: () => productivity.boardSource(),
    refreshLogs: () => productivity.refreshLogs(),
    sessions: () => ccLedger.all(),
    ownerPending: () => autonomy.allOwnerPending(),
    botNames: () => new Map(store.bots.map((bot) => [bot.id, bot.name])),
    releaseHold: () => releaseHold.label,
    admission: () => {
      const lease = readAdmissionLease();
      return {
        lease: lease && pidAlive(Number(lease.ownerPid)) ? { kind: lease.kind, label: lease.label ?? "" } : null,
        intents: (readReleaseIntents() ?? []).filter((intent) => pidAlive(intent.pid)).map((intent) => intent.label),
      };
    },
    log: (line) => console.log(line),
  });

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
      if (!sendToSessionFromServer(session, message)) continue;
      delete session.resumeAfterTag;
      ccLedger.save();
      const moved = Boolean(sha && sha !== wait.fromSha);
      ccChip(session, moved ? `a tag de produção andou (${sha!.slice(0, 8)}) — sessão retomada para relançar o ci:local` : `o release que tomou a vez (${wait.releaseSha?.slice(0, 9)}) não saiu — sessão retomada para relançar o ci:local`);
      console.log(`[release-priority] resumed session ${session.id}: ${moved ? `tag moved to ${sha!.slice(0, 9)}` : `release ${wait.releaseSha} failed again, was refused or halted`}`);
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


  function startCcSession(bot: BotRecord, threadId: string, replyThreadId: string, body: Record<string, unknown>, fromQueue = false, delegation?: DelegatedItemRef): StartResult {
    const input = parseCcStartInput(body, ccIsGitRepo);
    if (!input.ok) return { status: 400, body: { error: input.error } };
    const fullAccess = fullAccessForSource(bot.id, threadId);
    const surface = fullAccess ? "cli" : body.surface;
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
    let cliOnRecord = fullAccess ? "Acesso total autorizado pelo dono: terminal" : cliReason;
    // the breaker of the server's worktrees tripped and the owner was asked: straight to the cli, no app try (R13-dispatch R13-2)
    const breakerCli = surface !== "cli" && process.platform === "darwin" && ownWorktreesOn(input.repo) ? ownBreakerCli(ownBreaker.get(), breakerRepo(input.repo)) : null;
    if (breakerCli) cliOnRecord = breakerCli;
    if (surface === "cli" && !fullAccess) {
      // decided by the app's state the server knows, not by the words of cli_reason (R9-dispatch R9-3, INSP-H r1 #6)
      const { state: app, reason: appReason } = appAvailability(input.repo);
      // the app blocked by the reused folder, with a client's work waiting: the owner is asked, once, to unblock it
      if (app === "blocked" && clientIssue(`${input.title}\n${input.brief}`)) askOwnerToUnblockApp(bot, threadId, input.repo, appFolderBlock());
      const decided = cliSurfaceRefusal({ corridor, title: input.title, brief: input.brief, reason: cliReason, app, appReason, appFailure: app === "available" ? recentAppFailure(ccLedger.all(), input.repo, Date.now()) : null, appFailureRead: appFailureRead(ccLedger.all(), input.repo, Date.now()) });
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
      // a delegated item's start never borrows urgency from the item's title: it waits as the lowest (INSP-DEL A10)
      const priority = delegation ? startPriority("", "low") : startPriority(input.title, body.priority);
      const queued = ccStartQueue.add({ id: randomUUID().slice(0, 8), botId: bot.id, threadId, ...(replyThreadId !== threadId ? { replyThreadId } : {}), body, title: input.title, ...(issueNumber(input.title, input.brief) ? { issue: issueNumber(input.title, input.brief) } : {}), priority, at: Date.now(), ...(delegation ? { delegation } : {}) });
      if (queued === null) return { status: 409, body: { error: `já há ${CC_MAX_RUNNING} sessões do Claude Code ocupando as vagas e a fila de espera está cheia (${START_QUEUE_MAX}); espere uma relatar, ou tire um start seu da fila (cc_session_archive com o id dele)` } };
      if (ccStartQueue.of(bot.id).some(item => item.id === queued.id && item.dispatching)) {
        return { status: 409, body: { error: `o início de "${input.title}" tem resultado não confirmado (id ${queued.id}); não enfileirei nem iniciei outra sessão. Confira cc_session_list e a sessão real antes de reconciliar esse registro.` } };
      }
      const why = taken >= CC_MAX_RUNNING ? `as ${CC_MAX_RUNNING} vagas do Claude Code estão ocupadas` : "há starts esperando na fila (um novo não passa na frente deles)";
      // a delegation: the same start already queued is not this one, and the owner reads no bot hint (INSP-DEL A11)
      if (delegation && queued.duplicate) return { status: 409, body: { error: `um start igual ("${input.title}") já está na fila de sessões (id ${queued.id}); não enfileirei outro` } };
      if (queued.duplicate) {
        return { status: 200, body: { message: `"${input.title}" já estava na fila de sessões (#${queued.position}, id ${queued.id}); não enfileirei de novo. Encerre o turno agora.` } };
      }
      store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Fila de sessões: "${input.title}" é a #${queued.position} (prioridade ${priorityLabel(priority)}); abre sozinha quando uma vaga liberar`, 240), ok: true } });
      return { status: 200, queueId: queued.id, body: { message: `Não abri agora porque ${why}: "${input.title}" entrou na fila de sessões (#${queued.position}, prioridade ${priorityLabel(priority)}, id ${queued.id}) e abre sozinha quando uma vaga liberar; o aviso chega aqui. Veja a fila em cc_session_list; para tirá-la da fila, cc_session_archive com session_id ${queued.id}. Encerre o turno agora.` } };
    }
    if (surface !== "cli" && !breakerCli && process.platform === "darwin") {
      const appId = randomUUID();
      // The server makes the session's worktree and opens the app right in it
      // (lote X): the app's last folder, and the worktree it would reuse, do
      // not matter then — no 409 for them. Should the app not open there, the
      // create goes on through New Session, checked as below at that moment.
      // the repository's real path: the brief's folder check compares `pwd -P` with it
      const realRepo = (() => { try { return realpathSync(input.repo); } catch { return input.repo; } })();
      // (not while its breaker is tripped: two sessions in a row landed elsewhere — the old way, 409 and gesture)
      const ownPlan = ownPathActive(input.repo)
        ? planOwnWorktree(realRepo, { title: input.title, issue: issueNumber(input.title, input.brief), sessionId: appId }, (plan) => ownPlanTaken(realRepo, plan))
        : null;
      // New Session in the app opens in the folder of its latest
      // session; another repository cannot be picked from here. Say so
      // before touching the screen instead of failing five times. From the
      // queue it may pass (the person opens one there): it keeps its place.
      const lastRepo = ownPlan ? null : lastAppRepo();
      if (lastRepo && lastRepo !== input.repo) {
        return { status: 409, body: { error: `o app Claude abre sessões novas na última pasta usada (${lastRepo}), não em ${input.repo}. Use surface "cli" para este repositório, ou peça à pessoa para abrir uma sessão em ${basename(input.repo)} no app uma vez e tente de novo.` }, retry: fromQueue };
      }
      const block = ownPlan ? null : appFolderBlock();
      if (block) {
        // only the owner can unblock it: one item for them, however many starts hit this (R9-dispatch R9-2)
        const asked = askOwnerToUnblockApp(bot, threadId, input.repo, block);
        const refusal = block.kind === "flapping" ? flappingRefusal(block.seen, basename(input.repo), fromQueue)
          : block.kind === "reused" ? reusedFolderRefusal(block.last, basename(input.repo), fromQueue) : rootFolderRefusal(block.last, basename(input.repo), fromQueue, ownWorktreesOn(input.repo));
        return { status: 409, body: { error: `${refusal}${asked ? ` O pedido ao dono já está em "Precisa de você" (${asked}): não abra outro item para isso.` : ""}` }, retry: fromQueue };
      }
      const session = ccLedger.create({ id: appId, ownerBotId: bot.id, ownerThreadId: threadId, title: uniqueSessionTitle(ccLedger.all(), input.title, appId), repo: ownPlan ? realRepo : input.repo, permissionMode: input.permissionMode, surface: "app", desktop: { marker: newMarker(), turnsSeen: 0 } });
      if (replyThreadId !== threadId) session.replyThreadId = replyThreadId;
      const issue = issueNumber(input.title, input.brief);
      if (issue) session.desktop!.issue = issue;
      const classicText = desktopBrief(session, input.brief);
      session.desktop!.pending = { kind: "create", text: classicText, since: Date.now(), attempts: 0 };
      // the app's text is made once the worktree exists (its folder check names it)
      if (ownPlan) session.desktop!.own = { path: ownPlan.path, branch: ownPlan.branch, state: "planned", brief: input.brief, classicText };
      if (delegation) delegationOpened(delegation, session);
      if (corridor) session.corridorVersion = corridorVersionOf(corridor);
      session.status = "running";
      ccLedger.save();
      ccChip(session, ownPlan ? `criando a worktree ${ownPlan.dir} (${ownPlan.branch}, de origin/main); depois abre no app Claude quando o Mac estiver livre` : "na fila para abrir no app Claude quando o Mac estiver livre");
      noteClaimedPrs(session, delegation ? input.title : input.brief); // a delegated item's text claims no PR (INSP-DEL A12)
      const ignored = [body.permissionMode !== undefined ? "permission_mode" : "", input.model ? "model" : ""].filter(Boolean);
      const where = ownPlan ? `numa worktree que o servidor cria agora para ela (${ownPlan.path}, branch ${ownPlan.branch}, com as dependências clonadas quando a semente está em dia)` : `em ${basename(input.repo)} com worktree própria`;
      return { status: 200, sessionId: session.id, body: { message: `Sessão do Claude Code ${session.id} ("${session.title}") na fila para abrir no app Claude, ${where}, assim que o Mac estiver desbloqueado e ninguém mexer nele por ${DESKTOP_IDLE_SECONDS} segundos — a pessoa acompanha por lá.${mixWarning ? ` ${mixWarning}` : ""}${ignored.length ? ` ${ignored.join(" e ")} não valem no app (ele usa as próprias configurações; o relatório diz o modo em que ela realmente roda).` : ""} Quando ela terminar um turno, o relatório chega aqui como um novo turno. Encerre o turno agora — não fique consultando.${scripts.changed ? " (Troquei pnpm por npm run no texto: este repositório usa npm.)" : ""}` } };
    }
    const session = ccLedger.create({ id: randomUUID(), ownerBotId: bot.id, ownerThreadId: threadId, title: input.title, repo: input.repo, permissionMode: input.permissionMode, surface: "cli", ...(input.model ? { model: input.model } : {}) });
    if (replyThreadId !== threadId) session.replyThreadId = replyThreadId;
    if (corridor) session.corridorVersion = corridorVersionOf(corridor);
    if (delegation) delegationOpened(delegation, session);
    ccLedger.save();
    // the worktree made and seeded by the server first, as for the app (R13-gate G2); elsewhere claude -w makes a bare one
    if (process.platform === "darwin" && ownWorktreesOn(input.repo)) {
      // running while its worktree is made (not a turn yet: runCcTurn counts it)
      session.status = "running";
      session.progressAt = Date.now();
      ccLedger.save();
      // one at a time, in the order of the starts: a P1 the queue opened first spawns first (INSP-R13dis 3);
      // each for 3 min at most, then aborted, waited for, and the old way (R2-1, R3-1/2)
      void startSeededCli(session, input.brief);
    } else runCcTurn(session, input.brief, true);
    ccChip(session, `iniciada em ${input.repo}/.claude/worktrees/${session.worktree}`);
    noteClaimedPrs(session, delegation ? input.title : input.brief); // a delegated item's text claims no PR (INSP-DEL A12)
    if (cliOnRecord) ccChipShort(session, sessionChips.cli(session.title, `${cliOnRecord}${cliReason && cliReason !== cliOnRecord ? ` (o bot disse: ${chipText(cliReason, 80)})` : ""}`));
    return { status: 200, sessionId: session.id, body: { message: `Sessão do Claude Code ${session.id} ("${session.title}") iniciada na própria worktree. Ela trabalha sozinha; quando parar, o relatório chega aqui como um novo turno.${mixWarning ? ` ${mixWarning}` : ""} Encerre o turno agora — não fique consultando.${scripts.changed ? " (Troquei pnpm por npm run no texto: este repositório usa npm.)" : ""}` } };
  }

  /** Whether the Claude app can take a new session in `repo` now: not on this
   * Mac or opening another repository ("unavailable"), held by the
   * reused-folder 409 ("blocked"), else "available". */
  function appAvailability(repo: string): { state: AppAvailability; reason: string | null } {
    if (process.platform !== "darwin") return { state: "unavailable", reason: null };
    // its breaker tripped with the owner asked: new sessions go to the cli, so one asked for there is not refused (R13-2)
    const tripped = ownWorktreesOn(repo) ? ownBreakerCli(ownBreaker.get(), breakerRepo(repo)) : null;
    if (tripped) return { state: "unavailable", reason: tripped };
    // with a worktree the server makes, the app's last folder and the one it would reuse do not matter (lote X)
    if (!ownPathActive(repo)) {
      const lastRepo = lastAppRepo();
      if (!lastRepo || lastRepo !== repo) return { state: "unavailable", reason: null };
      if (appFolderBlock()) return { state: "blocked", reason: null };
    }
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
    const want = block?.kind === "flapping" ? appFlappingPending(name, block.seen) : appUnblockPending(name, block?.kind ?? "reused", ownWorktreesOn(repo));
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
    let open = store.bots.flatMap((bot) => autonomy.ownerPendingOf(bot.id)).filter((item) => item.key?.startsWith(APP_UNBLOCK_KEY));
    if (!open.length) return;
    // the server makes the worktrees of these repositories' sessions (lote X): no gesture of the owner is needed there
    const ownNames = new Set([...new Set(ccLedger.all().map((session) => session.repo))].filter(ownPathActive).map((repo) => basename(repo)));
    for (const key of new Set(open.map((item) => item.key!).filter((key) => ownNames.has(key.slice(APP_UNBLOCK_KEY.length))))) {
      for (const done of autonomy.resolveOwnerPending({ key })) refreshBotRow(done.botId);
      console.log(`[claude-desktop] the owner's "destravar o app" item (${key}) is closed: the server now makes each session's worktree and opens the app in it, so no gesture is needed`);
    }
    open = open.filter((item) => !ownNames.has(item.key!.slice(APP_UNBLOCK_KEY.length)));
    if (!open.length) return;
    const block = appFolderBlock();
    if (block) {
      for (const item of open) {
        const name = item.key!.slice(APP_UNBLOCK_KEY.length);
        const want = staleUnblockItem(item, name, block.kind, block.kind === "flapping" ? block.seen : [], ownOnByName(name));
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
        if (!bot) return { status: 404, body: { error: "o bot não existe mais" } };
        // a delegated start checks the stop and the budget again when it leaves the queue: they held at the click, maybe not now (INSP-DEL A10)
        if (item.delegation) {
          if (existsSync(nuriaStopFile)) return { status: 409, body: { error: "o ~/.nuria/stop está ativo: a delegação espera na fila até ele ser removido" }, retry: true };
          try {
            assertBudget();
          } catch (error) {
            return { status: 409, body: { error: error instanceof Error ? error.message : String(error) } };
          }
        }
        return startCcSession(bot, threadId, replyThreadId, item.body, true, item.delegation);
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
   * person gets a "Precisa de você" item (INSP-F F1: ffd6ee1a / #9328) — in
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
    retireWorkOfClosedThreads();
    renameResultsThreads();
    warnArmedIgnores();
    // App sessions an older build failed over a screen step are alive in the
    // app: back to idle on load, so they take messages again.
    if (process.platform === "darwin") reviveScreenFailures(desktopWork);
    if (!process.env.VITEST || process.env.OMB_NOW_IN_TESTS === "1") nowStatus.start();
  }
  return { bootCcRuntime, sharedState, ccLedger, ccProcesses, ccTurnTimeoutMs, ownerTurnThread, moveWorkToOwnerThread, ccChip, ccChipShort, ccReport, runCcTurn, desktopState, desktopWork, cleanReleasedWorktrees, reportArchivedWorktrees, watchBackgroundJobs, execCc, retireThreadWork, noteClaimedPrs, releaseHold, refreshReleaseHold, resumeOf, wireResumeOf, preemptCiForReleaseTick, ccStartQueue, ccSlotFreeForWork, startCcSession, watchScreenLock, APP_UNBLOCK_KEY, ownerDeclines, appFolderFlaps, appFolderBlock, settleAppUnblock, drainCcStartQueue, openThreadOf, watchArchivedOutside, reportResumptionToChief, worktreeFolder, ccClaudePids, ccGateWaitMaxMs, ccGateWaits, spanPt, pidAlive, gateWaitEn, followBgJob, ccGateRecheckMs, releaseHoldOf, reconcileDelegations, ownPrepareState, refreshOwnSeeds, settleOwnBreaker, canonPath, gitAsync, ownerChannelOf, foldersInUse, allProcessCwds, duKb, delegationTime, delegateView, ccIsGitRepo, delegationOwner, appAvailability, delegationReturned, delegationChip, ownOnByName, nowStatus, ownStore, ownBreaker, registeredWorktreePaths, pipelineBoard, RELEASE_HOLD_EVERY_MS, releasedCleanup };
}
