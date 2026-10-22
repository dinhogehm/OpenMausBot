// Desktop work, seeded own worktrees and informational worktree reports for CC sessions.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

import { DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";


import { chipText } from "./bot-autonomy.ts";

import { CcSessionLedger, lastHookBlock, lastHookDecision, type CcSession } from "./cc-sessions.ts";
import { ensureHelper, findDesktopSession, lastAssistantText, macDesktopDriver, lastAppRepo, liveWorktreeNames, liveRecordFolders, lastAppWorktreeFolder, lastServerSessionInRoot, reusedFolderRefusal, rootAnchorSession, rootFolderRefusal, readDesktopRecord, recordsUsingFolder, transcriptMentions, transcriptPath, transcriptTurnEnded, transcriptOpenQuestion, transcriptWrittenAt, type DesktopDriver } from "./claude-desktop.ts";
import { desktopBriefText, type DesktopWorkDeps, ownBriefText } from "./desktop-work.ts";
import { DESKTOP_HELPER_SOURCE } from "./claude-desktop-helper.ts";
import { parseLsofCwd, psTable } from "./bg-jobs.ts";
import { execFile as execFileCc, execFileSync as execFileSyncCc, type ChildProcess as CcChildProcess } from "node:child_process";
import { parseLsRemoteTag, PRODUCTION_TAG } from "./prod-delivery.ts";



import { flappingRefusal, type FolderBlockSeen } from "./owner-chips.ts";


import { type ReleaseInFlight, seedReleaseHold } from "./release-priority.ts";
import { readTail } from "./release-watch.ts";

import { type StartResult } from "./cc-start-queue.ts";
import { archiveCleanupNote, codexRolloutFolders, planArchivedWorktree, planNestedWorktrees, planReleasedWorktrees, releasedPlanLine, releasedScopeLine, type StaleFolder, staleFoldersReport, staleTaskWorkspaces, worktreeLastActivity, conversationFolders, folderActivity, parseWorktreeList, scanTaskWorkspaces, staleFoldersLogLine } from "./nested-worktrees.ts";
import { type BotRecord } from "./store.ts";
import { TASK_WORKSPACES_DIR } from "./workspace.ts";
import { type DelegatedItemRef } from "./owner-delegate.ts";






import { freeBytes as volumeFreeBytes } from "./disk-watch.ts";
import { addOwnWorktree, breakerRepo, cacheLine, enqueueSeededStart, groupExec, installText, prepareCliWorktree, pruneDanglingLinks, seededStartChain, cloneSeedCaches, ensureLink, type Exec as OwnExec, hooksFolder, leftOwnWorktrees, leftWorktreesReport, noteOwnFailure, ownBreakerItem, type OwnBreakerState, ownBreakerTripped, rearmOwnBreaker, findCacheDirs, ownLinkPath, ownSettingsFor, OwnWorktreeStore, realCloneIo, realDirFs, refreshSeed, savedText, claudeConfigPath, trustFoldersInClaudeConfig } from "./own-worktrees.ts";
import type { CcRuntimeDeps } from "./cc-runtime.ts";

interface CcOwnRuntimeDeps extends Pick<CcRuntimeDeps, "DESKTOP_MANAGED" | "autonomy" | "chiefDeskThread" | "refreshBotRow" | "fullAccessForSource" | "store"> {
  ccLedger: CcSessionLedger;
  ccProcesses: Map<string, CcChildProcess>;
  ccTurnFooter: (session: CcSession) => string;
  ownerChannelOf: (botId: string) => string | null;
  sessionReportThread: (session: CcSession) => string;
  ccChip: (session: CcSession, text: string, ok?: boolean) => void;
  ccChipShort: (session: CcSession, text: string, ok?: boolean, skip?: string | null) => void;
  ccReport: (session: CcSession, text: string) => void;
  runCcTurn: (session: CcSession, prompt: string, first: boolean) => void;
  execCc: (file: string, args: string[], cwd?: string) => Promise<string>;
  readonly releaseHold: { label: string | null; found: ReleaseInFlight | null };
  refreshReleaseHold: () => Promise<void>;
  startCcSession: (bot: BotRecord, threadId: string, replyThreadId: string, body: Record<string, unknown>, fromQueue?: boolean, delegation?: DelegatedItemRef) => StartResult;
  ourAppLocalIds: () => Set<string>;
  appFolderBlock: () => { kind: "reused"; last: NonNullable<ReturnType<typeof lastAppWorktreeFolder>> } | { kind: "root"; last: NonNullable<ReturnType<typeof lastServerSessionInRoot>> } | { kind: "flapping"; last: { folder: string; title?: string }; seen: FolderBlockSeen[] } | null;
}

export function createCcOwnRuntime(deps: CcOwnRuntimeDeps) {
  const { DESKTOP_MANAGED, autonomy, chiefDeskThread, refreshBotRow, fullAccessForSource, store, ccLedger, ccProcesses, ccTurnFooter, ownerChannelOf, sessionReportThread, ccChip, ccChipShort, ccReport, runCcTurn, execCc, refreshReleaseHold, startCcSession, ourAppLocalIds, appFolderBlock } = deps;
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

  // ── worktrees the server makes for its app sessions (lote X, own-worktrees.ts)
  // The settings file (own-worktrees-settings.json in the data dir) is optional:
  // on by default, `{"enabled": false}` (or per repository under "repos") or
  // OMB_OWN_WORKTREES=0 turns it off; the seeds and what each clone saved live
  // in own-worktrees.json. The server never removes a worktree.
  const OWN_SETTINGS_PATH = join(DATA_DIR, "own-worktrees-settings.json");
  const ownStore = new OwnWorktreeStore(join(DATA_DIR, "own-worktrees.json"));
  function ownWorktreeSettings(repo: string) {
    let config: unknown = null;
    try { config = JSON.parse(readFileSync(OWN_SETTINGS_PATH, "utf8")); } catch { /* none: the defaults */ }
    return ownSettingsFor(config, repo, process.env);
  }
  /** Whether the app sessions of `repo` open in a worktree the server makes. */
  const ownWorktreesOn = (repo: string) => process.platform === "darwin" && ownWorktreeSettings(repo).enabled;
  /** The breaker of this path (own-worktrees.ts): kept across restarts. */
  const OWN_BREAKER_KEY = "own-worktree-breaker:";
  const ownBreaker = (() => {
    const path = join(DATA_DIR, "own-worktree-breaker.json");
    let state: OwnBreakerState = { repos: {} };
    try { state = JSON.parse(readFileSync(path, "utf8")) as OwnBreakerState; } catch { /* none yet */ }
    return {
      get: () => state,
      set(next: OwnBreakerState) {
        state = next;
        try { writeFileAtomic(path, `${JSON.stringify(state)}\n`, { mode: 0o600 }); } catch (error) { console.error(`[own-worktrees] breaker: ${error instanceof Error ? error.message : String(error)}`); }
      },
    };
  })();
  /** Whether new app sessions of `repo` open in a worktree the server makes now: on, and its breaker not tripped. */
  const ownPathActive = (repo: string) => ownWorktreesOn(repo) && !ownBreakerTripped(ownBreaker.get(), breakerRepo(repo));
  /** A session of this path landed elsewhere: counted; the 2nd in a row trips the breaker and asks the owner, once.
   * Kept by the repository's real path, the key ownPathActive reads (INSP-R11fix F-3). */
  /** Whether the server makes the sessions' worktrees for the repository of this name (its texts never ask to turn the worktree option on: R12-1). */
  const ownOnByName = (name: string) => {
    const repos = [...new Set(ccLedger.all().map((session) => session.repo))].filter((repo) => basename(repo) === name);
    // a repository with no session yet: the settings as they stand for any repository (on by default) — INSP-R12a X3-6
    return repos.length ? repos.some(ownWorktreesOn) : ownWorktreesOn("");
  };
  function noteOwnWrongFolder(session: CcSession, folder: string): void {
    noteOwnPathFailure(session, { folder }, `opened in ${folder} instead of ${session.desktop?.own?.path}`);
  }
  /** A create of this path given up because the new session's worktree option read ON or unreadable (R12-1): counted the same way. */
  function noteOwnChipRefused(session: CcSession, option: "on" | "unknown", seen?: string): void {
    noteOwnPathFailure(session, { folder: "", chip: option, ...(seen ? { seen } : {}) }, `was given up: the new session's worktree option read ${option === "on" ? "ON" : "unreadable"}`);
  }
  /** A create of this path given up for any other miss (no new session from the link, another folder's chips): counted too (R13-2). */
  function noteOwnAbandoned(session: CcSession, reason: string, seen?: string): void {
    noteOwnPathFailure(session, { folder: "", missed: reason.slice(0, 300), ...(seen ? { seen: seen.slice(0, 300) } : {}) }, `was given up: ${reason.slice(0, 160)}`);
  }
  /** Both ways of the app failed for a create: the same brief, started in the cli as the same bot's start (R13-2). */
  function startOwnInCli(session: CcSession, why: string): { sessionId: string } | { queueId: string } | { refusal: string } {
    const bot = store.bot(session.ownerBotId);
    if (!bot) return { refusal: `o bot ${session.ownerBotId} não existe mais` };
    const brief = session.desktop?.own?.brief;
    if (!brief) return { refusal: "a sessão não tem o brief original guardado" };
    const started = startCcSession(bot, session.ownerThreadId, session.replyThreadId ?? session.ownerThreadId, { title: session.title, brief, repo: session.repo, surface: "cli", permissionMode: session.permissionMode, cliReason: `os dois caminhos do app Claude falharam na sessão ${session.id.slice(0, 8)}: ${chipText(why, 160)}` });
    if (started.sessionId) return { sessionId: started.sessionId };
    if (started.queueId) return { queueId: started.queueId };
    const error = (started.body as { error?: unknown }).error;
    return { refusal: typeof error === "string" ? error.slice(0, 300) : `HTTP ${started.status}` };
  }
  function noteOwnPathFailure(session: CcSession, what: { folder: string; chip?: "on" | "unknown"; missed?: string; seen?: string }, said: string): void {
    const own = session.desktop?.own;
    if (!own) return;
    const repo = breakerRepo(session.repo);
    const { state, tripped } = noteOwnFailure(ownBreaker.get(), repo, { at: Date.now(), sessionId: session.id, title: session.title, expected: own.path, ...what });
    ownBreaker.set(state);
    console.log(`[own-worktrees] session ${session.id} ${said} (${state.repos[repo]!.failures.length} in a row)${tripped ? ": breaker tripped, new sessions go straight to the cli until the owner resolves the item" : ""}`);
    if (!tripped) return;
    const bot = store.bot(session.ownerBotId);
    const thread = bot ? ownerChannelOf(bot.id) ?? sessionReportThread(session) : null;
    if (!bot || !thread || !store.taskByThread(bot.id, thread)) {
      // tripped all the same; only a create that works rearms it now (R12 INFO)
      console.warn(`[own-worktrees] breaker of ${repo} tripped, but the owner could not be asked: ${!bot ? `the bot ${session.ownerBotId} no longer exists` : "no open conversation of its bot holds the item"}`);
      return;
    }
    const item = autonomy.addOwnerPending(bot.id, thread, { ...ownBreakerItem(repo, state.repos[repo]!.failures), key: `${OWN_BREAKER_KEY}${repo}` });
    ownBreaker.set({ repos: { ...ownBreaker.get().repos, [repo]: { ...ownBreaker.get().repos[repo]!, itemId: item.id } } });
    refreshBotRow(bot.id);
  }
  /** A create worked (either way): the breaker of its repository rearms, and its item closes. */
  function rearmOwnPath(given: string, why: string): void {
    const repo = breakerRepo(given);
    if (!ownBreaker.get().repos[repo]) return;
    const was = ownBreakerTripped(ownBreaker.get(), repo);
    ownBreaker.set(rearmOwnBreaker(ownBreaker.get(), repo));
    for (const done of autonomy.resolveOwnerPending({ key: `${OWN_BREAKER_KEY}${repo}` })) refreshBotRow(done.botId);
    if (was) console.log(`[own-worktrees] breaker of ${repo} rearmed: ${why}`);
  }
  /** The owner resolved the breaker's item: the path is tried again. */
  function settleOwnBreaker(): void {
    for (const [repo, entry] of Object.entries(ownBreaker.get().repos)) {
      if (entry.trippedAt === undefined || !entry.itemId) continue;
      const open = store.bots.flatMap((bot) => autonomy.ownerPendingOf(bot.id)).some((item) => item.key === `${OWN_BREAKER_KEY}${repo}`);
      if (!open) rearmOwnPath(repo, "the owner resolved the item");
    }
  }
  /** A program with the server's PATH, its stdout; rejects with its stderr. */
  const ownExec: OwnExec = (file, args, options = {}) => new Promise<string>((resolve, reject) => {
    execFileCc(file, args, { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, signal: options.signal, env: { ...process.env, PATH: augmentedPath() } }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr ?? "") }));
      else resolve(String(stdout));
    });
  });
  const nodeVersion = async () => {
    try { return (await ownExec("node", ["--version"], { timeoutMs: 15_000 })).trim() || null; } catch { return null; }
  };
  /** A worktree plan nobody has: no folder, no branch, no session (ours, planned ones too, or the app's) ever in it. */
  function ownPlanTaken(repo: string, plan: { path: string; branch: string; dir: string }): boolean {
    if (existsSync(plan.path) || existsSync(ownLinkPath(repo, plan.dir))) return true;
    if (ccLedger.all().some((session) => session.cwd === plan.path || session.desktop?.own?.path === plan.path)) return true;
    if (recordsUsingFolder(plan.path, undefined, undefined, true).length) return true;
    try {
      execFileSyncCc("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${plan.branch}`], { stdio: "ignore", timeout: 15_000, env: { ...process.env, PATH: augmentedPath() } });
      return true;
    } catch {
      return false;
    }
  }
  /** Why New Session, the old way, would not land in a new worktree of its
   * own in `repo` now (the 409's words), or null. */
  function classicAppRefusal(repo: string, fromQueue = false): string | null {
    const lastRepo = lastAppRepo();
    if (lastRepo && lastRepo !== repo) return `o app Claude abre sessões novas na última pasta usada (${lastRepo}), não em ${repo}. Use surface "cli" para este repositório, ou peça à pessoa para abrir uma sessão em ${basename(repo)} no app uma vez e tente de novo.`;
    const block = appFolderBlock();
    if (!block) return null;
    return block.kind === "flapping" ? flappingRefusal(block.seen, basename(repo), fromQueue)
      : block.kind === "reused" ? reusedFolderRefusal(block.last, basename(repo), fromQueue) : rootFolderRefusal(block.last, basename(repo), fromQueue, ownWorktreesOn(repo));
  }
  /** Make the session's planned worktree, its alias for the app, and clone its caches from the seed. */
  async function prepareOwnWorktree(session: CcSession): Promise<Awaited<ReturnType<NonNullable<DesktopWorkDeps["own"]>["prepare"]>>> {
    const own = session.desktop!.own!;
    const dir = basename(own.path);
    const settings = ownWorktreeSettings(session.repo);
    const event = { at: Date.now(), sessionId: session.id, repo: session.repo, path: own.path, branch: own.branch };
    const made = await addOwnWorktree(session.repo, { dir, path: own.path, branch: own.branch }, ownExec, repoBaseBranch(session.repo));
    if (!made.ok) {
      ownStore.record({ ...event, mode: "failed", reason: made.error });
      return { ok: false, reason: made.error };
    }
    // next to the repository (~/Projetos/.omb-worktree-links/…): inside the review hook's scope
    const link = ownLinkPath(session.repo, dir);
    const linkError = ensureLink(link, own.path);
    if (linkError) {
      const reason = `a worktree foi criada (${own.path}, fica como está), mas não o apelido que o app recebe: ${linkError}`;
      ownStore.record({ ...event, mode: "failed", reason });
      return { ok: false, reason };
    }
    // while this clone reads the seed, the seed is not installed again (refreshOwnSeeds waits)
    ownSeedWatch.cloning += 1;
    let caches: Awaited<ReturnType<typeof cloneSeedCaches>>;
    try {
      caches = await cloneSeedCaches(ownStore.seed(session.repo), own.path, settings.lockfiles, realCloneIo(ownExec, nodeVersion));
    } finally {
      ownSeedWatch.cloning -= 1;
    }
    // origin/main moved past the seed (or its hooks are missing): refresh it on the next pass instead of in 30 min
    if (caches.mode === "install" && /não é o da semente|Node mudou|nunca instalada|hooks do git/.test(caches.reason ?? "")) ownSeedWatch.due.add(session.repo);
    // made again after a restart: counted once
    if (!ownStore.allEvents().some((each) => each.path === own.path && each.mode === caches.mode)) {
      ownStore.record({ ...event, mode: caches.mode, ...(caches.reason ? { reason: caches.reason } : {}), ...(caches.mode === "cloned" ? { savedKb: caches.savedKb, savedMs: caches.savedMs, cloneMs: caches.ms } : {}) });
    }
    if (caches.mode === "cloned") console.log(`[own-worktrees] ${own.path}: ${caches.dirs.join(", ")} cloned in ${Math.round(caches.ms / 1000)} s, sparing ${savedText(caches.savedKb, caches.savedMs)}`);
    return {
      ok: true, head: made.head, link,
      caches: { mode: caches.mode, ...(caches.reason ? { reason: caches.reason } : {}), dirs: caches.dirs, savedKb: caches.savedKb, savedMs: caches.savedMs, ms: caches.ms, install: caches.install, ...(caches.hooks ? { hooks: caches.hooks } : {}) },
      ...(made.fetchError ? { fetchError: made.fetchError } : {}),
    };
  }
  const ownPrepareState = { preparing: false };
  /** The seeded headless starts, chained: each spawns after the one before it
   * (INSP-R13dis 3), 3 min each at most, then aborted and waited for (R2-1, R3-1/2). */
  const seededStart = seededStartChain();
  /** The seeded starts' git and cp: process groups, settled on close (own-worktrees.ts groupExec). */
  const preparationExec: OwnExec = (file, args, options = {}) => groupExec({ ...process.env, PATH: augmentedPath() })(file, args, { timeoutMs: 120_000, ...options });
  /** A headless session's first turn in a worktree the server made and seeded
   * from the same seed as the app's (R13-gate G2: `claude -p -w` made bare
   * ones, and the first ci:local failed on a missing vite after ~14 min of
   * lease). Its brief says whether to install; not made in time, it goes the
   * old way under a new name (own-worktrees.ts enqueueSeededStart). */
  function startSeededCli(session: CcSession, brief: string): Promise<void> {
    const seedRepo = breakerRepo(session.repo);
    const settings = ownWorktreeSettings(seedRepo);
    return enqueueSeededStart(seededStart, session, {
      prepare: (repo, name, signal) => {
        // every git and cp of it stops with the abort — its whole process group (hooks too), settled only once
        // it has exited (INSP-R4-1)
        const exec: OwnExec = (file, args, options = {}) => preparationExec(file, args, { ...options, signal });
        return prepareCliWorktree(repo, name, {
          add: (plan) => addOwnWorktree(repo, plan, exec, repoBaseBranch(repo)),
          clone: async (path) => {
            // while this clone reads the seed, the seed is not installed again (refreshOwnSeeds waits)
            ownSeedWatch.cloning += 1;
            try {
              return await cloneSeedCaches(ownStore.seed(seedRepo), path, settings.lockfiles, realCloneIo(exec, nodeVersion));
            } finally {
              ownSeedWatch.cloning -= 1;
            }
          },
        });
      },
      spawn: (_session, line, outcome) => {
        // the seed behind origin/main (or never installed): refreshed on the next pass
        if (outcome.ok && outcome.caches.mode === "install") ownSeedWatch.due.add(seedRepo);
        console.log(`[cc-session] ${session.id}: ${outcome.ok ? `worktree ${outcome.plan.path} made, dependencies ${outcome.caches.mode === "cloned" ? `cloned (${outcome.caches.dirs.length} folders)` : `to install (${outcome.caches.reason ?? "?"})`}` : `worktree not made (${outcome.reason}); claude -w makes it, the brief says to install`}`);
        ccChipShort(session, outcome.ok && outcome.caches.mode === "cloned" ? `dependências clonadas da semente na worktree ${session.worktree}` : `worktree sem dependências clonadas: a sessão roda ${installText(undefined, settings)} antes do gate`);
        runCcTurn(session, `${brief}\n\n${line}`, true);
      },
      exists: existsSync,
      save: () => ccLedger.save(),
      log: (line) => console.log(`[cc-session] ${line}`),
      rename: (name) => `${name}-${randomUUID().slice(0, 4)}`,
      install: installText(undefined, settings),
    });
  }
  /** The seeds of the repositories whose app sessions open in worktrees of the
   * server's: checked every `seedEveryMs` (sooner when a clone met a seed
   * behind origin/main), one at a time, never with a release on its way. */
  const ownSeedWatch = { running: false, cloning: 0, due: new Set<string>() };
  async function refreshOwnSeeds(): Promise<void> {
    // a clone reading a seed now: no seed changes until it is done
    if (ownSeedWatch.running || ownSeedWatch.cloning || process.platform !== "darwin") return;
    const now = Date.now();
    // the repositories the sessions of the last 30 days worked in — headless ones too, seeded the same way (R13-gate G2)
    const repos = [...new Set(ccLedger.all().filter((session) => now - session.createdAt < 30 * 86_400_000).map((session) => breakerRepo(session.repo)))];
    const repo = repos.find((each) => {
      const settings = ownWorktreeSettings(each);
      const seed = ownStore.seed(each);
      return ownWorktreesOn(each) && (ownSeedWatch.due.has(each) || !seed?.checkedAt || now - seed.checkedAt >= settings.seedEveryMs);
    });
    if (!repo) return;
    ownSeedWatch.running = true;
    ownSeedWatch.due.delete(repo);
    try {
      const settings = ownWorktreeSettings(repo);
      await refreshSeed(repo, settings, ownStore.seed(repo), {
        exec: ownExec,
        now: Date.now,
        releaseBusy: async () => {
          await refreshReleaseHold();
          // the network phase holds the seed too (INSP-R11fix F-2)
          return seedReleaseHold(deps.releaseHold.label, deps.releaseHold.found);
        },
        freeBytes: volumeFreeBytes,
        readFile: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
        exists: existsSync,
        findDirs: (seedPath, each) => findCacheDirs(seedPath, each.cacheNames, each.extraDirs, realDirFs),
        sizeKb: async (path) => {
          try { return Number((await ownExec("/usr/bin/nice", ["-n", "15", "/usr/bin/du", "-sk", path], { timeoutMs: 10 * 60_000 })).split(/\s+/)[0]) || null; } catch { return null; }
        },
        node: nodeVersion,
        log: (line) => console.log(`[own-worktrees] ${line}`),
        save: (seed) => ownStore.setSeed(seed),
        mayInstall: () => (ownSeedWatch.cloning ? "uma worktree está sendo clonada da semente agora; tento de novo em seguida" : null),
        hooks: (folder) => hooksFolder(folder, ownExec),
      }, repoBaseBranch(repo));
      // held by a clone that started meanwhile: once it is done, not in half an hour
      if (/sendo clonada/.test(ownStore.seed(repo)?.reason ?? "")) ownSeedWatch.due.add(repo);
    } finally {
      ownSeedWatch.running = false;
    }
  }

  const desktopWork: DesktopWorkDeps = {
    ledger: ccLedger,
    canRunSession: (session) => !fullAccessForSource(session.ownerBotId, session.ownerThreadId),
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
    rootHead: (session) => gitLine(session.repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    // the worktrees git lists for the repository (a "trust this workspace" is clicked only for one of ours)
    registeredWorktrees: (session) => parseWorktreeList(gitLine(session.repo, ["worktree", "list", "--porcelain"]) ?? "").map((entry) => entry.path),
    // the app's own log, read only: what ties a "trust this workspace" prompt to a folder (its last 256 KiB)
    trustLog: () => readTail(join(homedir(), "Library", "Logs", "Claude", "main.log"), 256 * 1024),
    // the app's config: our own worktree trusted before its link (the app ignores the link's folder otherwise, 2.31226.0)
    trustFolders: (folders) => trustFoldersInClaudeConfig(claudeConfigPath(process.env, homedir()), folders),
    // the old way needs the worktree option on, except in a repository of the server's own worktrees (its owner item: OFF)
    worktreeWanted: (session) => (ownWorktreesOn(session.repo) ? undefined : "on"),
    branches: (session) => (gitLine(session.repo, ["for-each-ref", "--count=500", "--format=%(refname:short)", "refs/heads"]) ?? "").split("\n").filter(Boolean),
    // never a session the server opened (a failed one in the root is the newest there — INSP-S r1 S-3)
    rootAnchor: (session) => rootAnchorSession(session.repo, undefined, ourAppLocalIds()),
    folderUsers: (folder, exceptLocalId) => recordsUsingFolder(folder, exceptLocalId, undefined, true).map((record) => record.title ?? record.sessionId),
    log: (line) => console.log(`[claude-desktop] ${line}`),
    onArchived: (session) => {
      void reportArchivedWorktrees(session, session.desktop?.removeWorktree === true).catch((error) => console.warn(`[worktrees] archive report of ${session.id} failed: ${error instanceof Error ? error.message : String(error)}`));
    },
    own: {
      prepare: prepareOwnWorktree,
      briefFor: (session) => {
        const own = session.desktop!.own!;
        session.desktop!.folderGuarded = true;
        return ownBriefText(session.title, session.desktop!.marker, own.brief, ccTurnFooter(session), own, cacheLine(own.caches ?? { mode: "install", reason: "sem resultado do clone", dirs: [] }));
      },
      classicBlocked: (session) => classicAppRefusal(session.repo),
      wrongFolder: noteOwnWrongFolder,
      chipRefused: noteOwnChipRefused,
      abandoned: noteOwnAbandoned,
      toCli: startOwnInCli,
      adopted: (session) => rearmOwnPath(session.repo, `session ${session.id} opened in a worktree of its own`),
    },
  };

  // App sessions an older build failed over a screen step are alive in the
  // app: back to idle on load, so they take messages again.

  /** `git <args>` in the repository, its output trimmed; null when git fails. */
  function gitLine(repo: string, args: string[]): string | null {
    try {
      return String(execFileSyncCc("git", ["-C", repo, ...args], { stdio: "pipe", timeout: 15_000, env: { ...process.env, PATH: augmentedPath() } })).trim();
    } catch {
      return null;
    }
  }

  /** The worktrees git lists for a repository, or null when git cannot say (the worktree report's commands — INSP-R4-2). */
  function registeredWorktreePaths(repo: string): string[] | null {
    const out = gitLine(repo, ["worktree", "list", "--porcelain"]);
    return out === null ? null : parseWorktreeList(out).map((entry) => entry.path);
  }

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
  const releasedCleanup: { lastAt: number; running: boolean; lastKey: Map<string, string>; lastStale: { at: number; folders: StaleFolder[] } | null } = { lastAt: 0, running: false, lastKey: new Map(), lastStale: null };
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
        const workspace = join(TASK_WORKSPACES_DIR, bot.id, task.threadId);
        // for the disk report only: a closed conversation's workspace, or one
        // quiet for 72 h and not running, is told as information (INSP-J r1 #7a) —
        // its own folder (task.cwd = the workspace) included (R11-resilience D2)
        const own = conversationFolders(task, workspace, { forDisk: Boolean(opts.quietWorkspaces), hasGoal: Boolean(autonomy.goalFor(task.threadId)), now, day });
        folders.push(...own.inUse);
        if (own.quiet) opts.quietWorkspaces?.set(workspace, own.quiet);
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
  /** A folder's size in KB (`du -sk`, at most 2 min), or null. An empty
   * folder is 0 KB, not unmeasured (R13-followup #5: ~190 "(? KB)"). */
  const duKb = (path: string, timeoutMs = 120_000) => new Promise<number | null>((resolve) => {
    execFileCc("/usr/bin/du", ["-sk", path], { timeout: Math.max(1, Math.round(timeoutMs)), maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const kb = /^(\d+)/.exec(String(stdout).trim())?.[1];
      resolve(error || kb === undefined ? null : Number(kb));
    });
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
      const workspaces = scanTaskWorkspaces(TASK_WORKSPACES_DIR, {
        list: (dir) => readdirSync(dir),
        // the newest entry one level below, not only the top's mtime (INSP-R12a R12b-3)
        // (lstat: a link is not followed into another tree; unknown past the budget is never "idle")
        activity: (path) => (existsSync(join(path, ".git")) ? activity(path) : null) ?? folderActivity(path, {
          list: (dir) => readdirSync(dir),
          stat: (each) => { try { const found = lstatSync(each); return { mtimeMs: found.mtimeMs, dir: found.isDirectory() }; } catch { return null; } },
        }),
        notes: quietWorkspaces,
      });
      // an app session in "/" or the home holds none of them (R12-resilience D3);
      // a live process working inside one holds it, as for the worktrees (INSP-R12a R12b-3)
      stale.push(...staleTaskWorkspaces(workspaces, { inUse: inUseForDisk, processCwds: cwds, now: Date.now(), known: stale.map((each) => each.path), canon: canonPath, root: TASK_WORKSPACES_DIR, home: homedir() }));
      // the server's own worktrees of failed sessions (or never used): their own lines, "da sessão falhada …" (R11-dispatch R11-1)
      const left = leftOwnWorktrees(ccLedger.all(), existsSync, registeredWorktreePaths);
      const leftPaths = new Set(left.map((each) => canonPath(each.path)));
      for (let i = stale.length - 1; i >= 0; i--) if (leftPaths.has(canonPath(stale[i]!.path))) stale.splice(i, 1);
      const leftKey = left.map((each) => each.path).sort().join("\n");
      const leftTold = leftKey !== (releasedCleanup.lastKey.get("\u0000own-left") ?? "") ? leftWorktreesReport(left) : null;
      releasedCleanup.lastKey.set("\u0000own-left", leftKey);
      if (leftTold) console.log(`[worktrees] the server's worktrees left by failed or other-way sessions (told, nothing removed): ${left.map((each) => each.path).join(", ")}`);
      // the aliases the app was given whose worktree is gone: only those symlinks go (R13-dispatch R13-2d)
      const keepLinks = new Set(ccLedger.all().filter((each) => each.status !== "archived").map((each) => each.desktop?.own?.link).filter((link): link is string => Boolean(link)));
      for (const repo of new Set(ccLedger.all().filter((each) => each.desktop?.own).map((each) => each.repo))) {
        const pruned = pruneDanglingLinks(repo, keepLinks);
        if (pruned.length) console.log(`[own-worktrees] removed ${pruned.length} alias(es) whose worktree is gone: ${pruned.join(", ")}`);
      }
      const staleKey = stale.map((each) => each.path).sort().join("\n");
      const staleNews = staleKey !== (releasedCleanup.lastKey.get("\u0000stale") ?? "");
      releasedCleanup.lastKey.set("\u0000stale", staleKey);
      if (staleNews && stale.length) {
        // every one measured (du, 2 min each at most), so the report orders by size, not by disk order (INSP-J r1 #7b)
        for (const each of stale) each.sizeKb = await duKb(each.path);
        releasedCleanup.lastStale = { at: Date.now(), folders: stale };
        // said as the chip says it: the listed ones, the small and the unmeasured counted (R13-followup #5)
        console.log(`[worktrees] idle >72 h outside ${PRODUCTION_TAG} (told as information, nothing removed): ${staleFoldersLogLine(stale)}`);
      }
      if (!stale.length) releasedCleanup.lastStale = { at: Date.now(), folders: [] };
      const staleTold = staleNews ? staleFoldersReport(stale) : null;
      if (!lines.length && !staleTold && !leftTold) return;
      const chief = store.bots.find((bot) => bot.chiefOfStaff && !bot.hidden);
      const desk = chief ? chiefDeskThread(chief) : null;
      if (chief && desk && store.taskByThread(chief.id, desk)) {
        const plans = lines.filter((line) => !line.startsWith("Para remover") && !/: avaliei para remoção só/.test(line));
        if (plans.length) store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(`Worktrees já em produção — ${plans[0]}${plans.length > 1 ? " …" : ""}`, 240), ok: true } });
        if (staleTold) store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(staleTold.chip, 240), ok: true } });
        const parts = [
          ...(lines.length ? [`Worktrees já em produção — estas podem ser removidas por uma pessoa, depois de conferir:\n${lines.join("\n")}`] : []),
          ...(staleTold ? [staleTold.report] : []),
          ...(leftTold ? [leftTold] : []),
        ];
        if (leftTold) store.appendMessage(desk, { role: "bot", kind: "activity", tool: { name: chipText(`Disco: ${left.length} worktree(s) do OMB de sessão falhada ou não usada — informação, nada foi removido`, 240), ok: true } });
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

  return { desktopState, getDesktopDriver, desktopBrief, ownStore, ownWorktreesOn, ownBreaker, ownPathActive, ownOnByName, settleOwnBreaker, ownPlanTaken, ownPrepareState, startSeededCli, refreshOwnSeeds, desktopWork, registeredWorktreePaths, releasedCleanup, gitAsync, allProcessCwds, foldersInUse, canonPath, duKb, cleanReleasedWorktrees, reportArchivedWorktrees };
}
