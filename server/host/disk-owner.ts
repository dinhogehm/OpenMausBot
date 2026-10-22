// Disk and routine owner items, with one queue for all Mac observations.
import { existsSync, readFileSync, statSync, readdirSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chipText, type BotAutonomy, type DiskPushCheck, type OwnerPending, type OwnerPendingStep, type OwnerPendingOption } from "../bot-autonomy.ts";
import { ownerFirstName } from "../owner-channel.ts";
import type { Store } from "../store.ts";
import type { RoutineRun } from "../routines.ts";
import type { loadConfig } from "../config.ts";
import type { createCcRuntime } from "../cc-runtime.ts";
import { asksOwnerToDecide,botDiskItemFolders,botItemAsk,busyNote,DISK_BRANCH_LABEL,DISK_DECISION_KEY_PREFIX,DISK_PUSH_LABEL,DISK_REPLACED_NOTE,diskAnswerLine,diskDecisionFolders,diskDecisionItem,diskDecisionPlan,diskDecisionRecheck,diskRoutine,diskStateLine,duSize,filesBelow,folderInUse,keptOutOf,namedFolders,openItemFolders,porcelainState,replyLeavesDiskToOwner,splitMixedRemoval,stripUncheckedRemovals,withBotKeeps,type FolderFacts,type LeftFolder } from "../disk-decision.ts";
import { folderActivity,nestedWorktrees,parseWorktreeList,worktreeLastActivity } from "../nested-worktrees.ts";
import { applyRoutineAsks,ownerSettlesRoutineAsks,ROUTINE_ASK_RESOLVED_NOTE,routineReplyText,settleRoutineAsks } from "../routine-owner-ask.ts";

type DiskRuntimeDeps = Pick<ReturnType<typeof createCcRuntime>, "canonPath" | "ccLedger" | "gitAsync" | "ownerTurnThread" | "foldersInUse" | "allProcessCwds" | "duKb" | "ownerChannelOf"> & {
  store: Store;
  autonomy: BotAutonomy;
  cfg: ReturnType<typeof loadConfig>;
  refreshBotRow(botId: string): void;
};
export function createDiskOwnerRuntime(deps: DiskRuntimeDeps) {
  const { store, autonomy, cfg, refreshBotRow, canonPath, ccLedger, gitAsync, ownerTurnThread, foldersInUse, allProcessCwds, duKb, ownerChannelOf } = deps;
const NURIA_WORKTREES = join(homedir(), "Projetos", "nuria-platform", ".claude", "worktrees");
/** One folder as it is on this Mac now: in use (sessions, conversations,
 * live processes, last change), and its git state (INSP-R12F F1). */
async function diskFolderFacts(path: string, used: readonly string[], processCwds: readonly string[] | null): Promise<FolderFacts> {
  const canon = canonPath(path);
  const mtime = (file: string) => { try { return statSync(file).mtimeMs; } catch { return null; } };
  const activity = worktreeLastActivity(path, { readFile: (file) => readFileSync(file, "utf8"), mtime }) ?? folderActivity(path, {
    list: (dir) => readdirSync(dir),
    stat: (each) => { try { const found = lstatSync(each); return { mtimeMs: found.mtimeMs, dir: found.isDirectory() }; } catch { return null; } },
  });
  const sessionOf = () => ccLedger.all().find((session) => session.status !== "archived" && session.status !== "failed" && (session.cwd ? canonPath(session.cwd) === canon || canonPath(session.cwd).startsWith(`${canon}/`) : false))?.title ?? null;
  // every worktree of the repository: one inside this folder keeps it out (INSP-R12F r4 R4-1)
  const worktrees = await gitAsync(["-C", path, "worktree", "list", "--porcelain"]).then((out) => parseWorktreeList(out).map((entry) => ({ ...entry, path: canonPath(entry.path) })), () => null);
  const nested = worktrees ? nestedWorktrees(worktrees, canon).map((entry) => entry.path) : null;
  // a folder that is not itself a worktree: git would answer for the checkout above it
  const registered = worktrees ? worktrees.some((entry) => entry.path === canon) : undefined;
  const inUse = folderInUse(canon, { used: used.map(canonPath), processCwds: processCwds?.map(canonPath) ?? null, activity, now: Date.now(), root: canonPath(NURIA_WORKTREES), home: canonPath(homedir()), sessionOf, nested, ...(registered === undefined ? {} : { registered }) });
  // ignored files count too: a .dev.vars lives only here (INSP-R12F r2 R2-2); a folded folder is walked (r4 R4-2)
  const readdir = (dir: string) => readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
  const state = await gitAsync(["-C", path, "status", "--porcelain", "--ignored"]).then((out) => porcelainState(out, (dir) => filesBelow(join(path, dir), readdir)), () => null);
  const unpushed = await gitAsync(["-C", path, "branch", "-r", "--contains", "HEAD"]).then((out) => out.trim().length === 0, () => null);
  // its branch and HEAD: "push primeiro" names the branch, and the server checks the remote after it (INSP-R13fol #2)
  const branch = await gitAsync(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]).then((out) => out.trim(), () => "");
  const head = await gitAsync(["-C", path, "rev-parse", "HEAD"]).then((out) => out.trim(), () => "");
  return {
    inUse, dirty: state ? state.dirty : null, unpushed, ...(state?.ignored.length ? { ignored: state.ignored } : {}), ...(state?.secrets.length ? { secrets: state.secrets } : {}),
    ...(branch && branch !== "HEAD" ? { branch } : {}), ...(branch === "HEAD" ? { detached: true } : {}), ...(/^[0-9a-f]{40}$/.test(head) ? { head } : {}),
  };
}

/** The repository the worktrees belong to. */
const NURIA_MAIN = join(homedir(), "Projetos", "nuria-platform");

/** "Push e remover" answered (or the owner's words with commits only here):
 * the folders whose commit must reach the remote before they go. After the
 * turn that CARRIES the answer — in the conversation it was sent to, once
 * the answer is there — the server looks at the remote; a commit still only
 * on this Mac, the folder kept or already removed, is said to the bot, so no
 * commit is lost unseen (INSP-R13fol #2, R2-4). Kept in the ledger. */
const DISK_PUSH_CHECK_MS = Number(process.env.OMB_DISK_PUSH_CHECK_MS) > 0 ? Number(process.env.OMB_DISK_PUSH_CHECK_MS) : 24 * 3_600_000;

async function checkDiskPushes(botId: string, threadId: string): Promise<void> {
  const now = Date.now();
  for (const check of autonomy.diskPushChecksOf(botId)) {
    if (now - check.at > DISK_PUSH_CHECK_MS) { await lookAtRemote(check, true); continue; }
    // only the turn that carried the answer: its conversation, with the answer in it
    if (check.threadId !== threadId) continue;
    const carried = store.messagesFor(threadId).some((message) => message.role === "user" && message.at >= check.at - 1_000 && String(message.text ?? "").includes(check.marker));
    if (!carried) continue;
    await lookAtRemote(check, false);
  }
}

/** A check never fired (its answer edited, sent another way, the removal done elsewhere): at 24 h the remote is looked at anyway (R3-4). */
async function sweepDiskPushChecks(): Promise<void> {
  const now = Date.now();
  for (const bot of store.bots) {
    for (const check of autonomy.diskPushChecksOf(bot.id)) if (now - check.at > DISK_PUSH_CHECK_MS) await lookAtRemote(check, true);
  }
}

/** Looks at the remote for a check's commits, once, and settles it: a commit
 * still only on this Mac is said to the bot and, in its conversation, to the
 * owner; at expiry, said even though its turn was never seen (R3-4). */
async function lookAtRemote(check: DiskPushCheck, expired: boolean): Promise<void> {
  autonomy.dropDiskPushCheck(check);
  {
    const lines: string[] = [];
    for (const folder of check.folders) {
      // the remote-tracking branches holding the commit: a push from the worktree updates them
      const remote = await gitAsync(["-C", NURIA_MAIN, "branch", "-r", "--contains", folder.head]).then((out) => out.trim(), () => null);
      if (remote) {
        console.log(`[disk] ${folder.name}: ${folder.head.slice(0, 9)} is on the remote (${remote.split("\n")[0]!.trim()}); it may go`);
        continue;
      }
      const there = existsSync(join(NURIA_WORKTREES, folder.name));
      lines.push(there
        ? `${folder.name}: o commit ${folder.head.slice(0, 9)}${folder.branch ? ` (branch ${folder.branch})` : ""} ainda não está em nenhuma branch remota — não remova antes do push confirmado`
        : `${folder.name} foi removida, mas o commit ${folder.head.slice(0, 9)}${folder.branch ? ` (branch ${folder.branch})` : ""} não está em nenhuma branch remota: ele só existe neste Mac — faça o push dessa branch agora e me confirme`);
    }
    if (lines.length) {
      autonomy.addReport(check.botId, check.threadId, `[Servidor: push conferido no remoto${expired ? ", 24 h depois da resposta" : ""}] ${lines.join("; ")}.`);
      store.appendMessage(check.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Disco: push ainda não está no remoto${expired ? " (24 h depois)" : ""} — ${check.folders.filter((each) => lines.some((line) => line.startsWith(each.name))).map((each) => each.name).join(", ")}`, 240), ok: false } });
      refreshBotRow(check.botId);
      console.log(`[disk] push checked on the remote${expired ? " at expiry" : ""}: ${lines.join("; ")}`);
    } else if (expired) {
      console.log(`[disk] push check expired; every commit is on the remote (${check.folders.map((each) => each.name).join(", ")})`);
    }
  }
}

/** An open disk item checked again on the Mac now (INSP-R12F r2 R2-1): a
 * folder that came into use or is no longer clean changes the item to what
 * holds now; with none left, it is closed with why. Folders gone from the
 * disk drop out. */
async function recheckDiskItem(item: OwnerPending, used: readonly string[], processCwds: readonly string[] | null, text: string, answer?: { kind: string; label?: string; text?: string }): Promise<{ outcome: "keep" | "replace" | "close"; line: string; note?: string }> {
  const folders = openItemFolders(item).filter((folder) => existsSync(join(NURIA_WORKTREES, folder.name)));
  const facts = new Map<string, FolderFacts>();
  for (const folder of folders) facts.set(folder.name, await diskFolderFacts(join(NURIA_WORKTREES, folder.name), used, processCwds));
  // what the Chief reads under the owner's answer: the state found just now (INSP-R12F r3 R3-2)
  const line = diskStateLine(openItemFolders(item).map((folder) => folder.name), facts, Date.now());
  // checked again, it keeps what it said of its origin and of the folders it kept out
  const kept = keptOutOf(item);
  const who = item.why?.split(" Juntas ocupam ")[0];
  const fresh = folders.length ? diskDecisionItem(folders, facts, NURIA_WORKTREES, text, { ...(who ? { who } : {}), ...(kept.length ? { kept } : {}) }) : null;
  const result = diskDecisionRecheck(item.key!, fresh, folders.length ? busyNote(folders.map((folder) => folder.name), facts) : "as pastas não existem mais");
  if (result.action === "keep") {
    // under the owner's answer, only what the answer itself allows, and every other folder forbidden (R13-followup #2, INSP-R13fol #1-#3)
    const allowed = answer ? diskAnswerLine(folders.map((folder) => folder.name), facts, answer, kept) : null;
    // what must be pushed before it goes: looked for on the remote after the turn that carries the answer (INSP-R13fol #2, R2-4)
    const covered = answer?.text && answer.kind === "option" && (answer.label === DISK_PUSH_LABEL || answer.label === DISK_BRANCH_LABEL) ? namedFolders(answer.text, folders.map((folder) => folder.name)) : [];
    const pending = covered.filter((name) => facts.get(name)?.unpushed !== false && facts.get(name)?.head && !facts.get(name)?.inUse);
    if (pending.length && answer?.text) {
      autonomy.addDiskPushCheck({
        botId: item.botId, threadId: ownerTurnThread(item.botId, item.threadId), at: Date.now(), // the item's id with the answer's first words, as ownerPendingReplyText writes them: two items answered alike stay apart (R3-4)
        marker: `(${item.id}): ${answer.text.trim().split("\n")[0]!.slice(0, 50)}`,
        folders: pending.map((name) => ({ name, head: facts.get(name)!.head!, ...(facts.get(name)!.branch ? { branch: facts.get(name)!.branch! } : {}) })),
      });
    }
    return { outcome: "keep", line: allowed ? `${line}\n${allowed}` : line };
  }
  autonomy.resolveOwnerPending({ botId: item.botId, key: item.key!, by: "server", note: result.action === "replace" ? DISK_REPLACED_NOTE : result.note });
  if (result.action === "replace") {
    const opened = autonomy.addOwnerPending(item.botId, item.threadId, result.item);
    store.appendMessage(item.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`"Precisa de você" atualizado (${opened.id}), conferido no Mac: ${result.item.title}`, 240), ok: true } });
  } else {
    store.appendMessage(item.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`"Precisa de você": ${item.id} fechado, ${result.note}`, 240), ok: true } });
  }
  refreshBotRow(item.botId);
  console.log(`[disk] ${item.id} checked again on the Mac: ${result.action} (${item.key})`);
  return { outcome: result.action, line, ...(result.action === "close" ? { note: result.note } : {}) };
}

/** One disk-item pass at a time (a routine's run, an owner's answer): two
 * passes reading the Mac at different moments would undo each other's item. */
let diskItemQueue: Promise<unknown> = Promise.resolve();
function diskItemTurn<T>(work: () => Promise<T>): Promise<T> {
  const turn = diskItemQueue.then(work, work);
  diskItemQueue = turn.catch(() => undefined);
  return turn;
}

/** A routine's run that leaves something with the owner ("A conversa do
 * widget continua com você", R12-visual N22): ONE item per subject in the
 * routine's conversation, refreshed — never doubled — by the hourly
 * repetition; what the run says is resolved closes. A disk routine's ask is
 * openDiskDecision's. */
function openRoutineAsks(run: RoutineRun, routineName: string, threadId: string): void {
  try {
    const bot = store.bot(run.botId);
    if (!bot) return;
    // the run's whole reply (its output is cut at 2 000 characters)
    const text = (run.threadId ? routineReplyText(store.messagesFor(run.threadId)) : undefined) ?? run.output ?? "";
    if (!text || diskRoutine(routineName, text)) return;
    const channel = ownerChannelOf(bot.id) ?? threadId;
    const ownerName = ownerFirstName({
      profileName: cfg.profile?.name,
      aboutMe: cfg.profile?.aboutMe,
      channelReplies: store.messagesFor(channel).filter((message) => message.role === "bot" && message.kind === "text" && !message.from).slice(-60).map((message) => message.text ?? ""),
      botNames: store.bots.map((each) => each.name),
    });
    const result = applyRoutineAsks(autonomy, { botId: bot.id, botName: bot.name, routineName, routineId: run.routineId, threadId, conversationTitle: store.taskByThread(bot.id, threadId)?.title, text, at: Date.now(), ownerName, knownNames: store.bots.map((each) => each.name) });
    for (const item of result.opened) store.appendMessage(item.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Em "Precisa de você" (${item.id}): ${item.title}`, 240), ok: true } });
    for (const item of result.resolved) store.appendMessage(item.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`"Precisa de você": ${item.id} fechado, ${ROUTINE_ASK_RESOLVED_NOTE}`, 240), ok: true } });
    if (!result.opened.length && !result.refreshed.length && !result.resolved.length && !result.demoted.length && !result.promoted.length) return;
    refreshBotRow(bot.id);
    console.log(`[owner-pending] routine "${routineName}" of ${bot.name}: ${[...result.opened.map((item) => `${item.id} opened`), ...result.refreshed.map((item) => `${item.id} refreshed`), ...result.resolved.map((item) => `${item.id} resolved`), ...result.demoted.map((item) => `${item.id} under "Talvez já resolvido"`), ...result.promoted.map((item) => `${item.id} back on top`)].join(", ")}`);
  } catch (error) {
    console.error(`[owner-pending] routine ask: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The bot says, in a conversation, that a routine's item is resolved: it closes (R12-visual N22). */
function closeRoutineAsksSaid(botId: string, text: string): void {
  const done = settleRoutineAsks(autonomy, botId, text);
  for (const item of done) {
    if (store.taskByThread(botId, item.threadId)) store.appendMessage(item.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`"Precisa de você": ${item.id} fechado, ${ROUTINE_ASK_RESOLVED_NOTE}`, 240), ok: true } });
    console.log(`[owner-pending] ${item.id} (${item.key}) resolved: its bot said so`);
  }
  if (done.length) refreshBotRow(botId);
}

/** The owner wrote, in a conversation of the bot, about a routine's item in words that end it or doing what it asked:
 * it goes under "Talvez já resolvido", never closed — a guess must not hide a pendency (INSP-N22 r2 F2, r5 T1). The
 * person's last messages there are read at each turn's end. */
function closeRoutineAsksOwnerSaid(botId: string, threadId: string): void {
  const said = store.messagesFor(threadId).filter((message) => message.role === "user" && message.kind === "text" && !message.peerAsk && !message.from).slice(-5).map((message) => ({ at: message.at, text: message.text }));
  if (!said.length) return;
  const done = ownerSettlesRoutineAsks(autonomy, botId, said);
  for (const item of done) {
    if (store.taskByThread(botId, item.threadId)) store.appendMessage(item.threadId, { role: "bot", kind: "activity", tool: { name: chipText(`"Precisa de você": ${item.id} em "Talvez já resolvido" — você tratou disso na conversa; confirme com "Já resolvi"`, 240), ok: true } });
    console.log(`[owner-pending] ${item.id} (${item.key}) under "Talvez já resolvido": the owner seems to have dealt with it in ${threadId}`);
  }
  if (done.length) refreshBotRow(botId);
}

function openDiskDecision(run: RoutineRun, routineName: string, threadId: string): Promise<void> {
  return diskItemTurn(() => openDiskDecisionNow(run, routineName, threadId));
}

async function openDiskDecisionNow(run: RoutineRun, routineName: string, threadId: string): Promise<void> {
  try {
    const botId = run.botId;
    // the run's whole reply (its output is cut at 2 000 characters, and the ask closes a long table)
    const reply = run.threadId ? [...store.messagesFor(run.threadId)].reverse().find((message) => message.role === "bot" && message.kind === "text" && message.text?.trim())?.text : undefined;
    const text = reply ?? run.output ?? "";
    if (!text || !diskRoutine(routineName, text)) return;
    // every disk run checks the open items again, asked or not (INSP-R12F r2 R2-1)
    const openItems = autonomy.ownerPendingOf(botId).filter((each) => each.key?.startsWith(DISK_DECISION_KEY_PREFIX));
    if (openItems.length) {
      const used = foldersInUse();
      const processCwds = await allProcessCwds();
      for (const item of openItems) await recheckDiskItem(item, used, processCwds, text);
    }
    if (!asksOwnerToDecide(text)) return;
    await openDiskDecisionFromText(botId, threadId, text, "the routine");
  } catch (error) {
    console.error(`[disk] decision item: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The folders' facts on the Mac now; a size the text did not give is
 * measured (du) within `duBudgetMs` in all — a bot's request waits on it, so
 * past the budget the size stays "?" (INSP-R13fol #10). */
async function diskFactsFor(folders: LeftFolder[], duBudgetMs = 120_000): Promise<Map<string, FolderFacts>> {
  const used = foldersInUse();
  const processCwds = await allProcessCwds();
  const facts = new Map<string, FolderFacts>();
  const until = Date.now() + duBudgetMs;
  for (const folder of folders) {
    const path = join(NURIA_WORKTREES, folder.name);
    facts.set(folder.name, await diskFolderFacts(path, used, processCwds));
    // "As duas estão vazias" of two 2,2G worktrees (06/10 23:10): the Mac says the size (R13-followup #4)
    if (folder.size === "?" && until - Date.now() > 500) {
      const kb = await duKb(path, until - Date.now());
      if (kb !== null) folder.size = duSize(kb);
    }
  }
  return facts;
}

/** A text that leaves worktrees to the owner — a disk routine's run, or a
 * bot's reply ("a remoção fica com você. Se quiser apagá-las:" with the
 * commands, 06/10 23:10, R13-followup #4) — opens ONE item, checked on the Mac. */
async function openDiskDecisionFromText(botId: string, threadId: string, text: string, said: string): Promise<void> {
  let names: string[];
  try { names = readdirSync(NURIA_WORKTREES); } catch { return; }
  const folders = diskDecisionFolders(text, names);
  if (!folders.length) return;
  // checked on the Mac, not taken from the routine's words
  const facts = await diskFactsFor(folders);
  const item = diskDecisionItem(folders, facts, NURIA_WORKTREES, text, said === "the routine" ? {} : { who: "A remoção dessas worktrees é sua; o servidor conferiu cada uma no Mac." });
  if (!item) return;
  const plan = diskDecisionPlan(item.key, autonomy.ownerPendingOf(botId), autonomy.resolvedOwnerPendingOf(botId), Date.now());
  if (!plan.add) return;
  for (const key of plan.replace) autonomy.resolveOwnerPending({ botId, key, by: "server", note: "substituído pela lista nova da rotina de disco" });
  const known = autonomy.ownerPendingOf(botId).some((open) => open.key === item.key);
  const opened = autonomy.addOwnerPending(botId, threadId, item);
  if (!known) store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Em "Precisa de você" (${opened.id}): ${item.title}`, 240), ok: true } });
  refreshBotRow(botId);
  console.log(`[disk] ${said} left ${folders.length} folder(s) to the owner: ${known ? "item refreshed" : `item ${opened.id} opened`} (${item.key})`);
}

/** A bot's reply that leaves worktrees to the owner, in text only: the item it did not open. */
function openDiskDecisionFromReply(botId: string, threadId: string, text: string): void {
  if (!replyLeavesDiskToOwner(text)) return;
  void diskItemTurn(() => openDiskDecisionFromText(botId, threadId, text, "a bot's reply")).catch((error) => console.error(`[disk] decision item: ${error instanceof Error ? error.message : String(error)}`));
}

/** A bot's own "Precisa de você" item about removing worktrees (the Chief's
 * o28 on 06/10) is the server's disk item: the folders it names checked on
 * the Mac — use, secrets, nested worktrees — and what the bot itself said
 * keeps one ("em uso agora (lsof)", "manter"); its steps and decisions are
 * the server's, and the owner's answer is checked again (R13-followup #2).
 * Null when the item is not about removing worktrees; otherwise what the
 * bot reads back. `replacing` is the bot's item it rewrote (update). */
/** A mixed item's removal part (INSP-R13fol R2-3: o1 URGENTE of 05/10 had a
 * `git worktree remove` next to a `rm -rf`): the server's disk item opened
 * beside it for those folders, and the bot's steps without the removal
 * commands. Null when the item is not mixed or names no worktree. */
async function mixedRemovalBeside(bot: { id: string; name: string }, threadId: string, input: { title: string; command?: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[] }): Promise<{ steps: OwnerPendingStep[]; options?: OwnerPendingOption[]; moved?: string[]; message: string } | null> {
  let names: string[];
  try { names = readdirSync(NURIA_WORKTREES); } catch { names = []; }
  const split = splitMixedRemoval(input, names);
  if (!split) {
    // a removal of a worktree the server does not check (another repository, .worktrees/): out of the item, whole (R5-2)
    if (botItemAsk(input) === "other") return null;
    const unchecked = stripUncheckedRemovals(input);
    if (!unchecked) return null;
    console.log(`[disk] ${bot.name}'s item: ${unchecked.count} removal(s) of a worktree the server does not check taken out`);
    return { steps: unchecked.steps, ...(unchecked.options ? { options: unchecked.options } : {}), message: `Tirei do seu item ${unchecked.count === 1 ? "o comando" : `${unchecked.count} comandos`} de remoção de uma worktree que o servidor não confere (fora de nuria-platform/.claude/worktrees): não a remova por este item; peça ao dono que a remova no terminal.` };
  }
  const opened = await serverDiskItem(bot, threadId, input, undefined, split.folders);
  // a command that mixed the removal with other steps left whole: the bot writes the other part on its own (INSP-R13fol R4-1)
  const mixed = split.mixedCommands ? ` ${split.mixedCommands === 1 ? "Um comando seu misturava" : `${split.mixedCommands} comandos seus misturavam`} remoção de worktree com outros passos e saiu inteiro: se a outra parte ainda vale, reescreva-a num passo próprio, sem remoção de worktree.` : "";
  return { steps: split.steps, ...(split.options ? { options: split.options } : {}), moved: split.folders.map((folder) => folder.name), message: `${opened?.message ?? "Tirei do seu item os comandos de remoção de worktree: a remoção vai pelo item de disco do servidor."}${mixed} As decisões deste item que removiam worktree agora apontam para o item do servidor.` };
}

async function serverDiskItem(bot: { id: string; name: string }, threadId: string, input: { title: string; why?: string; command?: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[] }, replacing?: OwnerPending, beside?: LeftFolder[]): Promise<{ message: string; opened?: OwnerPending } | null> {
  let names: string[];
  try { names = readdirSync(NURIA_WORKTREES); } catch { return null; }
  // `beside`: the removal part of a mixed item, the server's item opened next to the bot's (INSP-R13fol R2-3)
  const folders = beside ?? botDiskItemFolders(input, names);
  if (!folders.length) return null;
  return diskItemTurn(async () => {
    // the bot's request waits on this: du gets 3 s in all, the rest stays "?" (INSP-R13fol #10)
    const facts = withBotKeeps(folders, await diskFactsFor(folders, 3_000));
    const text = [input.title, input.why ?? "", ...(input.steps ?? []).map((step) => step.text)].join("\n");
    const item = diskDecisionItem(folders, facts, NURIA_WORKTREES, text, { who: `${bot.name} não remove worktrees sem você; o servidor conferiu cada uma no Mac.` });
    const dropped = replacing ? autonomy.resolveOwnerPending({ botId: bot.id, id: replacing.id, by: "server", note: "trocado pelo item de disco do servidor, conferido no Mac" }) : [];
    const was = dropped.length ? ` Fechei o seu ${replacing!.id}.` : "";
    if (!item) {
      refreshBotRow(bot.id);
      console.log(`[disk] ${bot.name}'s item about worktrees: none may go now (${folders.map((folder) => folder.name).join(", ")})`);
      return { message: `O servidor conferiu essas pastas no Mac agora e nenhuma pode sair: ${busyNote(folders.map((folder) => folder.name), facts)}. Não abri o item.${was} Diga isso ao dono em uma linha, sem comandos de remoção.` };
    }
    const plan = diskDecisionPlan(item.key, autonomy.ownerPendingOf(bot.id), autonomy.resolvedOwnerPendingOf(bot.id), Date.now());
    if (!plan.add) {
      refreshBotRow(bot.id);
      return { message: `O servidor já tem um item de disco com essas pastas, ou o dono decidiu sobre elas há menos de 7 dias: não abri outro.${was} Veja owner_pending list.` };
    }
    for (const key of plan.replace) autonomy.resolveOwnerPending({ botId: bot.id, key, by: "server", note: "substituído pela lista nova conferida no Mac" });
    const opened = autonomy.addOwnerPending(bot.id, threadId, item);
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: chipText(`Em "Precisa de você" (${opened.id}), conferido no Mac: ${item.title}`, 240), ok: true } });
    refreshBotRow(bot.id);
    const kept = item.diskKept.join("; ");
    console.log(`[disk] ${bot.name}'s own item about worktrees is the server's now: ${opened.id} (${item.key})${kept ? `; kept out: ${kept}` : ""}`);
    if (beside) return { opened, message: `A remoção de worktrees deste item vai pelo item de disco do servidor, conferido no Mac: ${opened.id}: ${item.title}. Tirei do seu item os comandos de remoção; o resto ficou como você escreveu.${kept ? ` Fora do item de disco, não mexer: ${kept}.` : ""} Não remova worktree por este item.` };
    return { opened, message: `O servidor conferiu as pastas no Mac e abriu o item de disco dele no lugar do seu: ${opened.id}: ${item.title}.${was}${kept ? ` Fora do item, não mexer: ${kept}.` : ""} Os passos e as decisões são do servidor, que reconfere o item a cada passada da rotina de disco e na resposta do dono: não o reescreva. A resposta do dono chega com o que ela autoriza, e só isso pode sair.` };
  });
}

  return { DISK_PUSH_CHECK_MS, checkDiskPushes, sweepDiskPushChecks, recheckDiskItem, diskItemTurn, openRoutineAsks, closeRoutineAsksSaid, closeRoutineAsksOwnerSaid, openDiskDecision, openDiskDecisionFromReply, mixedRemovalBeside, serverDiskItem };
}
