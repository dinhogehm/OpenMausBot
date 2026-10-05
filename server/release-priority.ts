// A production release waits behind the local CI of another worktree
// (admission-control: "ADMISSION_WAITING kind=release … blocked_by=ci-full:<pid>").
// When that CI belongs to a Claude Code session this server manages, the
// release wins: the server stops that CI, tells the session why, and resumes
// it once the production tag moves. It never touches a process that is not a
// managed session's CI, never the session's own claude, never the server or
// the app, and never the release itself.
import { isInteractiveShell, type PsRow } from "./bg-jobs.ts";

/** How long the release must have waited before a CI is stopped for it. */
export const RELEASE_WAIT_BEFORE_PREEMPT_S = 120;

/** The release's current wait, from the admission log's tail: the latest
 * ADMISSION_* line must be a release waiting on a full CI. */
export function releaseBlockedBy(logTail: string): { pid: number; waitedS: number; label: string } | null {
  const lines = logTail.split("\n").filter((line) => line.startsWith("ADMISSION_"));
  const last = lines.at(-1);
  if (!last) return null;
  const match = /^ADMISSION_WAITING kind=release label=(\S+) blocked_by=ci-full:(\d+) waited=(\d+)s/.exec(last);
  return match ? { label: match[1]!, pid: Number(match[2]), waitedS: Number(match[3]) } : null;
}

// ── what a command is: anchored on the executable and the script, never on
// free text — a `claude -p` carries its whole prompt in argv, and a prompt
// that says "rode ci:local … ./scripts/release-carrier.sh --check" is not a CI
// nor a release (INSP-R r1: the server picked the claude's group as "the CI").
const SHELL = String.raw`(?:\S*/)?(?:ba|z)?sh`;
const SHELL_OPTS = String.raw`(?:\s+-\S+)*`;
/** `bash ./scripts/local-ci.sh --profile full`, `/bin/bash -p scripts/local-ci.sh`. */
const CI_SCRIPT = new RegExp(`^${SHELL}${SHELL_OPTS}\\s+\\S*scripts/local-ci\\.sh(?:\\s|$)`);
/** `npm run ci:local` (the process title npm sets). */
const CI_NPM = /^(?:\S*\/)?npm(?:\s+-\S+)*\s+run(?:-script)?\s+ci:local(?:\s|$)/;
/** The Bash tool's `/bin/zsh -c …` (or `bash -c`) that leads the CI's group. */
const SHELL_C = new RegExp(`^${SHELL}${SHELL_OPTS}\\s+-c\\s`);
/** The release: its scripts run by a shell, the watcher, or `npm run release…`. */
const RELEASE_SCRIPT = new RegExp(`^${SHELL}${SHELL_OPTS}\\s+\\S*(?:scripts/(?:local-release|release-carrier)|watch-production-release)\\.sh(?:\\s|$)`);
const RELEASE_NPM = /^(?:\S*\/)?npm(?:\s+-\S+)*\s+run(?:-script)?\s+release(?::\S*)?(?:\s|$)/;
/** Inside a `zsh -c` leader's own script text (not a claude's prompt): a release script it would run. */
const RELEASE_IN_SHELL_TEXT = /scripts\/(?:local-release|release-carrier)\.sh|watch-production-release\.sh|npm\s+run\s+release(?::\S*)?(?:\s|'|$)/;
/** A Claude Code process: `claude …` or its node entry point. */
const CLAUDE = /^(?:\S*\/)?claude(?:\s|$)|\/@anthropic-ai\/claude-code\//;
/** A protected app bundle's process: the OpenMausBot app and its helpers (the
 * server runs in one), and Claude. A CI's own browsers (Chromium.app under
 * Playwright) are not protected; terminals are, through isOwnerTerminal. */
const PROTECTED_APP = /\/(?:OpenMausBot|Claude)[^/]*\.app\/Contents\//;

export const isCiCommand = (command: string): boolean => CI_SCRIPT.test(command.trim()) || CI_NPM.test(command.trim());
export const isReleaseCommand = (command: string): boolean => RELEASE_SCRIPT.test(command.trim()) || RELEASE_NPM.test(command.trim());
export const isClaudeCommand = (command: string): boolean => CLAUDE.test(command.trim());

/** What the server knows of a managed session's processes. */
export interface ManagedSessionProcs {
  sessionId: string;
  /** A running headless turn's claude pid, if any. */
  claudePid?: number;
  /** Background job pids it left, and their start times (BgJob.starts, same
   * order). A job pid counts only with the same start: pids are reused, and
   * a record without starts matches nothing. */
  jobPids?: number[];
  jobStarts?: string[];
  /** Its worktree (for app sessions: a process working inside counts). */
  worktree?: string;
}

/** A process a person types into, or the terminal holding it: an interactive
 * shell (`-zsh`, `bash -il`), login, tmux/screen, sshd, a terminal app. */
const OWNER_TERMINAL = /^(?:\S*\/)?(?:login|tmux|screen|sshd|mosh-server)(?:[\s:]|$)|\/(?:Terminal|iTerm2?|iTerm|Ghostty|WezTerm|Alacritty|kitty|Warp|Visual Studio Code|Cursor)\.app\/Contents\//;
export const isOwnerTerminal = (command: string): boolean => isInteractiveShell(command) || OWNER_TERMINAL.test(command.trim());

/** Whose CI `pid` is. A managed session's when, walking up, its running
 * claude comes before any terminal. Else the owner's when a terminal of the
 * owner is anywhere in the chain (`-zsh → npm run ci:local → local-ci.sh`,
 * even inside a session's worktree or above a pid a job once had). Else a
 * session's when a process in the chain is one of its background jobs by pid
 * AND start time, or — for an app session — the CI works inside its
 * worktree. Else no one the server knows. */
export type CiOwner =
  | { kind: "session"; sessionId: string }
  | { kind: "owner"; terminal: PsRow }
  | { kind: "unknown" };

export function ciOwner(pid: number, rows: readonly PsRow[], cwdOf: (pid: number) => string | null, sessions: readonly ManagedSessionProcs[]): CiOwner {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const chain: PsRow[] = [];
  for (let row = byPid.get(pid); row && !chain.includes(row) && chain.length < 128; row = row.ppid > 0 ? byPid.get(row.ppid) : undefined) chain.push(row);
  if (!chain.length) return { kind: "unknown" };
  // the server's own claude, met before any terminal (the server may run in one, in dev)
  for (const row of chain) {
    const session = sessions.find((each) => each.claudePid === row.pid);
    if (session) return { kind: "session", sessionId: session.sessionId };
    if (isOwnerTerminal(row.command)) break;
  }
  // a terminal of the owner anywhere in the chain: the owner's, even above a job's pid
  const terminal = chain.find((row) => isOwnerTerminal(row.command));
  if (terminal) return { kind: "owner", terminal };
  // a job's process, by pid AND start time
  for (const row of chain) {
    const session = sessions.find((each) => each.jobPids?.some((job, i) => job === row.pid && each.jobStarts?.[i] !== undefined && each.jobStarts[i] === row.start));
    if (session) return { kind: "session", sessionId: session.sessionId };
  }
  const cwd = cwdOf(pid);
  if (cwd) {
    for (const session of sessions) {
      const root = session.worktree?.replace(/\/+$/, "");
      if (root && root.includes("/.claude/worktrees/") && (cwd === root || cwd.startsWith(`${root}/`))) return { kind: "session", sessionId: session.sessionId };
    }
  }
  return { kind: "unknown" };
}

/** The managed session owning `pid`, or null (the owner's, or no one's). */
export function ownerSession(pid: number, rows: readonly PsRow[], cwdOf: (pid: number) => string | null, sessions: readonly ManagedSessionProcs[]): string | null {
  const owner = ciOwner(pid, rows, cwdOf, sessions);
  return owner.kind === "session" ? owner.sessionId : null;
}

/** What to stop so the release can go — the CI's whole process group, or,
 * when that group also holds something else, only the CI's process tree —
 * with every pid the signal reaches; or why nothing may be stopped: `reason`
 * in pt-BR for the alert (no argv), `detail` with pids and commands for the log. */
export type CiStop =
  | { kind: "group"; pgid: number; root: PsRow; pids: number[] }
  | { kind: "tree"; pids: number[]; root: PsRow }
  | { kind: "refuse"; reason: string; detail: string; passing?: boolean };

/** What must never be signalled, besides the release: the server's own group,
 * and every pid the caller names (managed sessions' claudes, the server, its parent). */
export interface StopGuard {
  ownPgid: number;
  protectedPids?: readonly number[];
}

const describe = (row: PsRow) => `${row.pid} "${row.command.slice(0, 120)}" pgid ${row.pgid}`;
/** A refusal; `passing` when it may not hold a second later (a process in the
 * target that may just be a step of the CI): the caller asks again before
 * giving up. The rest (not a CI, the release above or beside it, the
 * server's group) hold for the whole release. */
const refuse = (reason: string, detail: string, passing = false): CiStop => ({ kind: "refuse", reason, detail, ...(passing ? { passing } : {}) });

/** The pid in the lease is the CI script itself: admission-control.sh writes
 * `$$` to lease/owner.pid, and it is sourced by local-ci.sh (01/10, live lease:
 * owner.pid 40409 = `bash ./scripts/local-ci.sh --profile full`). The CI is
 * found by walking up from it only through contiguous processes that are
 * still the local CI (`local-ci.sh`, `npm run ci:local`) in the lease pid's
 * own process group — plus that group's leader when it is the `zsh -c` that
 * ran it. Nothing above that is ever part of the target. Refuses when the
 * whole chain up to launchd holds the release, when the group or tree holds
 * the release, or when the target would reach a claude, an app bundle (the
 * server, the app), an interactive shell, the server's group or a protected pid. */
export function ciToStop(pid: number, rows: readonly PsRow[], guard: StopGuard): CiStop {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const start = byPid.get(pid);
  if (!start) return refuse("o processo que segura o lease já não está rodando", `ci-full:${pid} is not running`);
  if (!isCiCommand(start.command)) return refuse("o processo que segura o lease não é um ci:local reconhecível (local-ci.sh ou npm run ci:local)", `${describe(start)} is not local-ci.sh / npm run ci:local`);
  const chain: PsRow[] = [start];
  for (let row = start; row.ppid > 0 && chain.length < 128;) {
    const parent = byPid.get(row.ppid);
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    row = parent;
  }
  const releaseAbove = chain.find((row) => isReleaseCommand(row.command));
  if (releaseAbove) return refuse("o ci:local roda dentro do próprio release", `${describe(releaseAbove)} is an ancestor of ci-full:${pid}`);
  let top = 0;
  while (top + 1 < chain.length && chain[top + 1]!.pgid === start.pgid && isCiCommand(chain[top + 1]!.command)) top += 1;
  const leader = chain[top + 1];
  if (leader && leader.pgid === start.pgid && leader.pid === leader.pgid && SHELL_C.test(leader.command.trim())) {
    // a `zsh -c` that also chains the release (`npm run ci:local && ./scripts/release-carrier.sh …`) is not stopped whole
    if (RELEASE_IN_SHELL_TEXT.test(leader.command)) return refuse("o shell que roda o ci:local também encadeia o release", `the group leader ${describe(leader)} names a release script`);
    top += 1;
  }
  const root = chain[top]!;
  if (root.pgid <= 1 || root.pgid === guard.ownPgid) {
    return refuse(root.pgid <= 1 ? "o ci:local não tem um grupo de processos próprio" : "o ci:local está no grupo de processos do próprio servidor", `the CI ${describe(root)} runs in ${root.pgid <= 1 ? "no group of its own" : "the server's own group"}`);
  }
  const tree = new Set([root.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!tree.has(row.pid) && tree.has(row.ppid)) { tree.add(row.pid); grew = true; }
  }
  const group = rows.filter((row) => row.pgid === root.pgid);
  const release = [...group, ...rows.filter((row) => tree.has(row.pid))].find((row) => isReleaseCommand(row.command));
  if (release) return refuse("o release roda no mesmo grupo de processos do ci:local, ou abaixo dele", `the release ${describe(release)} shares the CI's group or tree (root ${describe(root)})`);
  // the whole group when it is only the CI; else only the CI's tree
  const whole = group.every((row) => tree.has(row.pid));
  const targets = whole ? group : rows.filter((row) => tree.has(row.pid));
  const guarded = new Set(guard.protectedPids ?? []);
  const forbidden = targets.find((row) => row.pid <= 1 || guarded.has(row.pid) || row.pgid === guard.ownPgid || isClaudeCommand(row.command) || PROTECTED_APP.test(row.command) || isOwnerTerminal(row.command));
  if (forbidden) return refuse("o alvo incluiria uma sessão do Claude, o servidor, o app ou um terminal do dono", `stopping ${whole ? `group ${root.pgid}` : `the tree of ${root.pid}`} would reach ${describe(forbidden)}`, true);
  const pids = targets.map((row) => row.pid);
  return whole ? { kind: "group", pgid: root.pgid, root, pids } : { kind: "tree", pids, root };
}

// ── is it really that CI that holds the release? ─────────────────────────
// The log line can be old (the release died waiting; the server restarted)
// and its pid reused. admission-control.sh is the source of truth: the lease
// (~/.nuria/admission/lease/{owner.pid,kind}) and the release's intent
// (~/.nuria/admission/intents/<release pid>, holding its label).

/** `start` (INSP-W r1 W-1): the owner's `ps -o lstart`, one space apart, when the lease records it. */
export interface AdmissionLease { ownerPid: string; kind: string; label?: string; start?: string }
export interface ReleaseIntent { pid: number; label: string; start?: string }
/** nuria-platform lote W2: one release or deploy at a time, held for the whole release;
 * `startedAt` is when the release took it (epoch seconds); `checkout`, the
 * checkout it deploys from (a ci:local started in it waits for the release). */
export interface DeployLease { ownerPid: string; label: string; start?: string; startedAt?: number; checkout?: string }
/** nuria-platform's NURIA_ADMISSION_RELEASE_CEILING_SECONDS default: a release older than this has very likely hung. */
export const RELEASE_QUEUE_CEILING_S = 5 * 3600;
export interface QueuedBehindRelease { label: string; state: "holding" | "queued"; ageS: number | null; overdue: boolean }

/** A ci:local that queues for the machine (profile full or release; not --steps, not quick). */
const QUEUEING_CI = (command: string) => isCiCommand(command) && !/\s--steps(?:\s|=|$)|\s--profile\s+quick(?:\s|$)|ci:local:quick/.test(command);

/** nuria-platform lote W1: a full ci:local behind a release waits for it, however long,
 * and that wait is legitimate — the session's turn must not be cut for it. The session's
 * ci:local (a queueing local-ci under its turn's process) is queued behind a release when
 * it does not hold the machine and a live release does — or queues for it (an intent,
 * which local CIs wait behind), or holds the deploy lease with the machine free (a CI in
 * the release's own checkout waits for it). Null when it runs, waits behind another CI, or
 * there is no CI.
 * INSP-W r1 W-1: a holder is alive only when its pid is in the table AND, when the lease
 * recorded it, with the same start (a pid reused after a crash or a reboot is no release);
 * and a release older than the ceiling (its deploy lease's `startedAt`) is `overdue`: the
 * wait is no longer excused, the turn is cut again, saying the release may have hung. */
export function ciQueuedBehindRelease(input: { rows: readonly PsRow[]; rootPid: number; lease: AdmissionLease | null; deployLease: DeployLease | null; intents: readonly ReleaseIntent[]; alive: (pid: number) => boolean; nowMs?: number; ceilingS?: number }): QueuedBehindRelease | null {
  const children = new Map<number, PsRow[]>();
  for (const row of input.rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const queue = [...(children.get(input.rootPid) ?? [])];
  const ciPids = new Set<number>();
  const seen = new Set<number>();
  while (queue.length) {
    const row = queue.shift()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    if (QUEUEING_CI(row.command)) ciPids.add(row.pid);
    queue.push(...(children.get(row.pid) ?? []));
  }
  if (!ciPids.size) return null;
  const startOf = new Map(input.rows.map((row) => [row.pid, row.start.replace(/\s+/g, " ").trim()]));
  const live = (pid: number, start?: string) => {
    if (!input.alive(pid)) return false;
    const recorded = start?.replace(/\s+/g, " ").trim();
    const now = startOf.get(pid);
    return !recorded || !now || recorded === now;
  };
  const deployOwner = Number(input.deployLease?.ownerPid.trim());
  const releaseLive = input.deployLease && live(deployOwner, input.deployLease.start);
  const ageS = releaseLive && input.deployLease?.startedAt ? Math.max(0, Math.round((input.nowMs ?? Date.now()) / 1000 - input.deployLease.startedAt)) : null;
  const queued = (label: string, state: QueuedBehindRelease["state"]): QueuedBehindRelease => ({ label, state, ageS, overdue: ageS !== null && ageS >= (input.ceilingS ?? RELEASE_QUEUE_CEILING_S) });
  const owner = Number(input.lease?.ownerPid.trim());
  if (input.lease && ciPids.has(owner)) return null;
  if (input.lease && input.lease.kind.trim() === "release" && live(owner, input.lease.start)) return queued(input.lease.label?.trim() ?? "", "holding");
  const intent = input.intents.find((each) => live(each.pid, each.start));
  if (intent) return queued(intent.label.trim(), "queued");
  if (!input.lease && releaseLive) return queued(input.deployLease!.label.trim(), "holding");
  return null;
}

/** A production release on its way on this Mac now, whatever CI waits for
 * it: it holds the machine (admission lease of kind release) or queues for it
 * (an intent) — "holding"/"queued": resuming a session now would put its
 * ci:local against that release, what lote W exists to prevent, so no
 * session is told to resume (INSP-S r1 S-1). Or it holds only the deploy lease
 * (lote W2: the network phase, after ADMISSION_DOWNGRADED … machine=released) —
 * "deploying": the machine is free, a session's ci:local is admitted at once,
 * so sessions resume (R11 #2: e3e9e7ddc held every resume 2h56, the machine
 * free for ~2 h of it). Liveness as in ciQueuedBehindRelease (pid in the
 * table with the start the lease recorded); `overdue` past the ceiling, when
 * the release very likely hung. */
export interface ReleaseInFlight extends Omit<QueuedBehindRelease, "state"> { state: QueuedBehindRelease["state"] | "deploying" }
export function releaseInFlight(input: { rows: readonly PsRow[]; lease: AdmissionLease | null; deployLease: DeployLease | null; intents: readonly ReleaseIntent[]; alive: (pid: number) => boolean; nowMs?: number; ceilingS?: number }): ReleaseInFlight | null {
  const startOf = new Map(input.rows.map((row) => [row.pid, row.start.replace(/\s+/g, " ").trim()]));
  const live = (pid: number, start?: string) => {
    if (!Number.isInteger(pid) || pid <= 0 || !input.alive(pid)) return false;
    const recorded = start?.replace(/\s+/g, " ").trim();
    const now = startOf.get(pid);
    return !recorded || !now || recorded === now;
  };
  const deployLive = input.deployLease !== null && live(Number(input.deployLease.ownerPid.trim()), input.deployLease.start);
  const ageS = deployLive && input.deployLease?.startedAt ? Math.max(0, Math.round((input.nowMs ?? Date.now()) / 1000 - input.deployLease.startedAt)) : null;
  const found = (label: string, state: ReleaseInFlight["state"]): ReleaseInFlight => ({ label, state, ageS, overdue: ageS !== null && ageS >= (input.ceilingS ?? RELEASE_QUEUE_CEILING_S) });
  if (input.lease && input.lease.kind.trim() === "release" && live(Number(input.lease.ownerPid.trim()), input.lease.start)) return found(input.lease.label?.trim() ?? "", "holding");
  // a release with the deploy lease queues for the machine through its intent (its CPU phase)
  const intent = input.intents.find((each) => live(each.pid, each.start));
  if (intent) return found(intent.label.trim(), "queued");
  return deployLive ? found(input.deployLease!.label.trim(), "deploying") : null;
}

/** What a session waiting on a release is told it waits for, in pt-BR. */
export function releaseHoldText(release: Pick<ReleaseInFlight, "label" | "state">): string {
  if (release.state === "deploying") return `${releaseName(release.label, true)} está na fase de rede; o seu ci:local pode rodar`;
  return `${releaseName(release.label, true)} está ${release.state === "holding" ? "em andamento" : "na fila da máquina"}`;
}

/** What holds the worktree seed (a pnpm install, over the disk and the
 * network) now, or null: a release holding or queueing for the machine (the
 * server's `label`, "?" when unreadable) — and its network phase too, unlike
 * a session's resume: there the disk and the network are the bottleneck, and
 * a seed only speeds up later clones (INSP-R11fix F-2). Past the ceiling, none. */
export function seedReleaseHold(label: string | null, found: ReleaseInFlight | null): string | null {
  if (label === "?") return "o estado da fila de admissão não pôde ser lido";
  if (label) return label;
  return found?.state === "deploying" && !found.overdue ? `${releaseName(found.label, true)} está na fase de rede (deploy): a semente espera ele terminar` : null;
}

/** What holds a session's resume now (resumeNeeded's `hold.release`), or null:
 * a release holding or queueing for the machine holds every session; in its
 * network phase ("deploying") only the session working in the checkout the
 * release deploys from (a ci:local there waits for the release anyway); past
 * the ceiling, none. `sessionCwd` and `releaseCheckout` resolved by the caller. */
export function releaseResumeHold(found: ReleaseInFlight | null, sessionCwd?: string | null, releaseCheckout?: string | null): string | null {
  if (!found || found.overdue) return null;
  if (found.state !== "deploying") return releaseHoldText(found);
  const trim = (path: string) => path.replace(/\/+$/, "");
  return sessionCwd && releaseCheckout && trim(sessionCwd) === trim(releaseCheckout)
    ? `${releaseName(found.label, true)} publica a partir do checkout desta sessão`
    : null;
}

const releaseName = (label: string, article: boolean) => {
  const sha = releaseLabelSha(label)?.slice(0, 9);
  return sha ? `${article ? "o " : ""}release de produção ${sha}` : article ? "um release" : "release";
};

/** The chip for a session whose ci:local waits behind a release: what it waits for, not an error. */
export function ciQueuedText(queued: { label: string; state: "holding" | "queued" }): string {
  return `aguardando ${releaseName(queued.label, true)} (${queued.state === "holding" ? "ele ocupa a máquina" : "ele está na fila pela máquina"}): o ci:local desta sessão está na fila e começa quando ele liberar; o turno não é cortado por essa espera`;
}

/** Past the ceiling: the turn is cut again, and this is why (the same words as nuria-platform's admission). */
export function releaseOverdueText(label: string, ceilingS = RELEASE_QUEUE_CEILING_S): string {
  const sha = releaseLabelSha(label)?.slice(0, 9) ?? (label || "?");
  const hours = ceilingS % 3600 === 0 ? `${ceilingS / 3600} h` : `${ceilingS} s`;
  return `release ${sha} passou de ${hours}: verifique se travou`;
}
export type Blocked = NonNullable<ReturnType<typeof releaseBlockedBy>>;

/** Whether the lease and the intents confirm the log: a live release intent
 * with the log's label, and the lease held by that very ci-full pid, alive.
 * `waiting: false` means no release waits at all (an old log line). */
export function leaseConfirms(lease: AdmissionLease | null, intents: readonly ReleaseIntent[], blocked: Blocked, alive: (pid: number) => boolean): { ok: true; releasePid: number } | { ok: false; waiting: boolean; reason: string } {
  const intent = intents.find((each) => each.label.trim() === blocked.label && alive(each.pid));
  if (!intent) return { ok: false, waiting: false, reason: `nenhum release espera de fato: não há intenção viva de ${blocked.label} em admission/intents` };
  if (!lease) return { ok: false, waiting: true, reason: "o lease do admission não pôde ser lido" };
  const owner = lease.ownerPid.trim();
  if (owner !== String(blocked.pid)) return { ok: false, waiting: true, reason: `o lease é de ${owner ? `outro processo (${owner})` : "ninguém"}, não do ci-full:${blocked.pid} que o log cita` };
  if (lease.kind.trim() !== "ci-full") return { ok: false, waiting: true, reason: `o lease não é de um ci-full (kind=${lease.kind.trim() || "vazio"})` };
  if (!alive(blocked.pid)) return { ok: false, waiting: true, reason: `o ci-full:${blocked.pid} já terminou; o admission recupera o lease sozinho` };
  return { ok: true, releasePid: intent.pid };
}

/** Why the target may have changed between the read that chose it and the
 * read right before the signal (a pid reused, the CI gone, a new group), or
 * null when it is the same: same kind, root and group, and the same start
 * time for the lease pid, the root and every pid seen in both reads. */
export function targetDrift(first: CiStop, second: CiStop | null, before: readonly PsRow[], after: readonly PsRow[], leasePid: number): string | null {
  if (first.kind === "refuse") return first.reason;
  if (!second) return "a segunda leitura da tabela de processos veio vazia";
  if (second.kind === "refuse") return `na segunda leitura, ${second.reason}`;
  if (second.kind !== first.kind || second.root.pid !== first.root.pid || (first.kind === "group" && second.kind === "group" && first.pgid !== second.pgid)) return "o alvo mudou entre as duas leituras";
  const startOf = (rows: readonly PsRow[], pid: number) => rows.find((row) => row.pid === pid)?.start;
  for (const pid of new Set([leasePid, first.root.pid, ...first.pids.filter((each) => second.pids.includes(each))])) {
    if (startOf(before, pid) !== startOf(after, pid)) return `o processo ${pid} mudou de horário de início entre as duas leituras (pid reusado)`;
  }
  return null;
}

/** A CI named for a person: the script and its profile, never the raw argv. */
export function ciLabel(command: string): string {
  const cmd = command.trim();
  if (CI_SCRIPT.test(cmd)) {
    const profile = /\s--profile[\s=]+([\w-]+)/.exec(cmd)?.[1];
    return profile ? `local-ci.sh --profile ${profile}` : "local-ci.sh";
  }
  return CI_NPM.test(cmd) ? "npm run ci:local" : "processo não reconhecido";
}

const homePath = (path: string, home: string) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

// ── one decision per waiting release and CI ──────────────────────────────

/** Ticks a release may stay undecided (ps empty, lease moving, target
 * changing between reads) before the Chief hears the server did nothing. */
export const PREEMPT_RETRY_LIMIT = 3;
/** How long after the signal the lease must be free for the stop to count. */
export const PREEMPT_VERIFY_AFTER_MS = 15_000;

export interface PreemptState {
  /** `<label>#<pid>` decided: acted on, or told. Never decided twice (the
   * server keeps it across restarts; a Set works in tests). */
  handled: { has(key: string): boolean; add(key: string): unknown };
  /** Undecided ticks per `<label>#<pid>`. */
  retries: Map<string, number>;
}

export type ManagedSession = ManagedSessionProcs & { title: string };
export type CiTarget = Exclude<CiStop, { kind: "refuse" }>;

/** Everything the decision touches, injected: the server passes the real
 * files, ps, lsof and process.kill; tests pass fixtures and a fake kill. */
export interface PreemptEnv {
  outLogTail: () => string;
  /** The lease, or null when there is none; throws when it exists but
   * cannot be read (never read as "free"). */
  readLease: () => AdmissionLease | null;
  /** The release intents, or null when the folder cannot be read. */
  readIntents: () => ReleaseIntent[] | null;
  ps: () => Promise<PsRow[]>;
  cwdOf: (pid: number) => Promise<string | null>;
  sessions: () => ManagedSession[];
  guard: (rows: readonly PsRow[]) => StopGuard;
  kill: (pid: number, signal: "SIGTERM") => void;
  sleep: (ms: number) => Promise<void>;
  alertChief: (text: string, report: string) => void;
  /** The CI was stopped and its lease is free: tell the session, resume it later. */
  stopped: (event: { session: ManagedSession; blocked: Blocked; target: CiTarget }) => void | Promise<void>;
  /** Why the release in `label` is in a loop (release-watch's releaseInLoop),
   * or null: a looping release never takes a session's CI. */
  looping?: (label: string) => string | null;
  log: (line: string) => void;
  home?: string;
  verifyAfterMs?: number;
}

export type PreemptOutcome = "idle" | "stale" | "retry" | "not-managed" | "refused" | "kill-failed" | "survived" | "stopped" | "looping";

/** The commit a release's admission label names (`release:production:<sha>`), or null. */
export function releaseLabelSha(label: string): string | null {
  return /^release:[\w-]+:([0-9a-f]{7,40})$/.exec(label.trim())?.[1] ?? null;
}

const REPORT_TAIL = "\nO detalhe técnico (pids, grupo, comando) está no log do servidor, nas linhas [release-priority].";

/** A release waiting over RELEASE_WAIT_BEFORE_PREEMPT_S behind a full CI:
 * stop that CI when it is a managed session's and it is safe; otherwise tell
 * the Chief, once, why nothing was done. Success is claimed only when, after
 * `verifyAfterMs`, the CI no longer holds the lease. */
export async function preemptCiForRelease(env: PreemptEnv, state: PreemptState): Promise<PreemptOutcome> {
  const blocked = releaseBlockedBy(env.outLogTail());
  if (!blocked || blocked.waitedS < RELEASE_WAIT_BEFORE_PREEMPT_S) return "idle";
  const key = `${blocked.label}#${blocked.pid}`;
  if (state.handled.has(key)) return "idle";
  const minutes = Math.max(1, Math.round(blocked.waitedS / 60));
  const waits = `O release de produção (${blocked.label}) espera há ${minutes} min`;
  // a release in a loop fails again whatever it is given: stopping a gate for
  // it only feeds the loop, and that gate may be its fix (R10-release #1:
  // the CI of the fix #9348 killed for d5bb1f70b at its 4th failure).
  // Logged and told once per release, whichever CI it waits on.
  const loop = env.looping?.(blocked.label) ?? null;
  if (loop) {
    const loopKey = `loop:${blocked.label}`;
    if (!state.handled.has(loopKey)) {
      state.handled.add(loopKey);
      env.log(`[release-priority] leave alone: release ${blocked.label} is looping (${loop}); it waited ${blocked.waitedS}s on ci-full:${blocked.pid} and no CI is stopped for it`);
      env.alertChief(`${waits} atrás de um ci:local, e o servidor NÃO interrompe CI para ele: ${loop}. Interromper um gate para um release que vai falhar de novo só alimenta o laço (e o gate pode ser justamente a correção).`, `[Alerta do servidor: release em laço não passa na frente] ${waits} atrás de um ci:local, e o servidor NÃO interrompe CI de sessão para ele: ${loop}. Os gates das sessões seguem; o release espera a vez. Não peça ao dono outra ação por isto: o item de recusa do laço, se aberto, é o mesmo.${REPORT_TAIL}`);
    }
    return "looping";
  }
  const settle = () => {
    state.handled.add(key);
    state.retries.delete(key);
  };
  const tell = (title: string, text: string) => env.alertChief(text, `[Alerta do servidor: ${title}] ${text}${REPORT_TAIL}`);
  const notYet = (why: string): PreemptOutcome => {
    const tries = (state.retries.get(key) ?? 0) + 1;
    state.retries.set(key, tries);
    env.log(`[release-priority] undecided (${tries}/${PREEMPT_RETRY_LIMIT}): release ${blocked.label} waited ${blocked.waitedS}s on ci-full:${blocked.pid} — ${why}`);
    if (tries < PREEMPT_RETRY_LIMIT) return "retry";
    settle();
    tell("release esperando atrás de CI", `${waits} atrás do ci-full:${blocked.pid} e o servidor não conseguiu confirmar que pode interrompê-lo (${why}): nada foi interrompido. Veja quem roda esse ci:local, ou deixe o release esperar.`);
    return "retry";
  };

  const rows = await env.ps();
  if (!rows.length) return notYet("a tabela de processos veio vazia");
  const intents = env.readIntents();
  if (!intents) return notYet("a pasta de intenções do admission não pôde ser lida");
  const alive = (pid: number) => rows.some((row) => row.pid === pid);
  let leaseNow: AdmissionLease | null;
  try {
    leaseNow = env.readLease();
  } catch {
    return notYet("o lease do admission existe mas não pôde ser lido");
  }
  const lease = leaseConfirms(leaseNow, intents, blocked, alive);
  if (!lease.ok) {
    if (lease.waiting) return notYet(lease.reason);
    settle();
    env.log(`[release-priority] nothing to do: the log says ${blocked.label} waits on ci-full:${blocked.pid}, but ${lease.reason}`);
    return "stale";
  }
  const lockRow = rows.find((row) => row.pid === blocked.pid)!;
  const cwd = await env.cwdOf(blocked.pid);
  const sessions = env.sessions();
  const owner = ciOwner(blocked.pid, rows, (pid) => (pid === blocked.pid ? cwd : null), sessions);
  const what = `${ciLabel(lockRow.command)}, em ${cwd ? homePath(cwd, env.home ?? "") : "pasta desconhecida"}`;
  const lockSeen = `ci-full:${blocked.pid} "${lockRow.command.slice(0, 160)}" pgid ${lockRow.pgid} start "${lockRow.start}"`;
  const session = owner.kind === "session" ? sessions.find((each) => each.sessionId === owner.sessionId) : undefined;
  if (!session) {
    settle();
    env.log(`[release-priority] leave alone: release ${blocked.label} (${blocked.waitedS}s) waits on ${lockSeen}, cwd ${cwd ?? "?"} — ${owner.kind === "owner" ? `the owner's (terminal ${owner.terminal.pid} "${owner.terminal.command.slice(0, 60)}")` : "not a managed session's"}`);
    tell("release esperando atrás de CI", owner.kind === "owner"
      ? `${waits} atrás de um ci:local do dono (${what}), rodado num terminal: o servidor não o interrompe; só o dono pode interrompê-lo, ou o release espera.`
      : `${waits} atrás de um ci:local que não é de sessão gerenciada (${what}): o servidor não o interrompe; só quem o rodou pode interrompê-lo, ou o release espera.`);
    return "not-managed";
  }
  const stop = ciToStop(blocked.pid, rows, env.guard(rows));
  if (stop.kind === "refuse" && stop.passing) {
    env.log(`[release-priority] not now: ${lockSeen} of session ${session.sessionId} — ${stop.detail}`);
    return notYet(stop.reason);
  }
  if (stop.kind === "refuse") {
    settle();
    env.log(`[release-priority] leave alone: ${lockSeen} of session ${session.sessionId} — ${stop.detail}`);
    tell("release esperando atrás de CI", refusalText(blocked, session.title, stop.reason));
    return "refused";
  }
  // right before the signal: the same processes, with the same start times
  const rows2 = await env.ps();
  const again = rows2.length ? ciToStop(blocked.pid, rows2, env.guard(rows2)) : null;
  const drift = targetDrift(stop, again, rows, rows2, blocked.pid);
  if (drift || !again || again.kind === "refuse") return notYet(drift ?? "o alvo mudou entre as duas leituras");
  settle();
  const target = again;
  const where = target.kind === "group" ? `group ${target.pgid}` : `tree ${target.pids.join(",")} (its group ${target.root.pgid} also holds other processes)`;
  try {
    if (target.kind === "group") env.kill(-target.pgid, "SIGTERM");
    else for (const pid of target.pids) { try { env.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  } catch (error) {
    env.log(`[release-priority] could not signal ${where}: ${error instanceof Error ? error.message : String(error)}`);
    tell("release esperando atrás de CI", `O servidor tentou interromper o ci:local da sessão "${session.title}" para liberar o release de produção (${blocked.label}), que espera há ${minutes} min, e o sinal falhou: nada foi interrompido. Interrompa esse ci:local na sessão, ou deixe o release esperar.`);
    return "kill-failed";
  }
  const verifyMs = env.verifyAfterMs ?? PREEMPT_VERIFY_AFTER_MS;
  env.log(`[release-priority] SIGTERM to ${where}: ${lockSeen} of session ${session.sessionId}, CI root ${target.root.pid} "${target.root.command.slice(0, 120)}", release ${blocked.label} waited ${blocked.waitedS}s; checking the lease in ${Math.round(verifyMs / 1000)}s`);
  await env.sleep(verifyMs);
  // a lease that cannot be read is not a free lease
  let after: AdmissionLease | null | "unreadable";
  try {
    after = env.readLease();
  } catch {
    after = "unreadable";
  }
  const rows3 = await env.ps();
  const ciAlive = !rows3.length || rows3.some((row) => row.pid === blocked.pid && row.start === lockRow.start);
  const stillHeld = after === "unreadable" || (after !== null && after.ownerPid.trim() === String(blocked.pid) && ciAlive);
  if (stillHeld || after === "unreadable") {
    const seconds = Math.round(verifyMs / 1000);
    env.log(`[release-priority] NOT freed: ${seconds}s after SIGTERM to ${where}, ${after === "unreadable" ? "the lease could not be read" : `ci-full:${blocked.pid} still holds the lease`}${rows3.length ? "" : " (ps read nothing)"}`);
    tell("release continua bloqueado", after === "unreadable"
      ? `O servidor mandou interromper o ci:local da sessão "${session.title}" para liberar o release de produção (${blocked.label}), mas ${seconds} s depois não conseguiu ler o lease do admission: não sei se o release foi liberado. Confira o ci:local da sessão (processo ${blocked.pid}) e o lease.`
      : `O servidor mandou interromper o ci:local da sessão "${session.title}" para liberar o release de produção (${blocked.label}), mas ${seconds} s depois ele ainda segura o lease: não consegui liberar o release. Interrompa esse ci:local na sessão (processo ${blocked.pid}), ou deixe o release esperar.`);
    return "survived";
  }
  env.log(`[release-priority] stopped ${where}: ci-full:${blocked.pid} no longer holds the lease (owner now ${after?.ownerPid.trim() || "none"}${ciAlive ? "" : ", the CI is gone"}); release ${blocked.label} can go`);
  await env.stopped({ session, blocked, target });
  return "stopped";
}

/** The Chief's alert when the server refuses to stop a session's CI: pt-BR, no argv. */
export function refusalText(blocked: Blocked, title: string, reason: string): string {
  return `O release de produção (${blocked.label}) espera há ${Math.max(1, Math.round(blocked.waitedS / 60))} min atrás do ci:local da sessão "${title}" e o servidor NÃO o interrompeu: ${reason}. Interrompa esse ci:local na sessão, ou deixe o release esperar.`;
}

// ── giving the CI back ───────────────────────────────────────────────────

/** A session whose CI gave way to a release (cc-sessions' resumeAfterTag). */
export interface ResumeWait {
  /** The production tag when the CI was stopped. */
  fromSha: string | null;
  at: number;
  /** What the session hears when the tag moves. */
  message: string;
  /** The commit of the release that took the CI's place, and its failures
   * then: a new failure, a refusal or a halt of it also gives the CI back. */
  releaseSha?: string;
  failuresAtStop?: number;
}

/** The longest a session waits for the release that took its CI. */
export const RESUME_AFTER_MAX_MS = 3 * 3_600_000;

/** The commit of the release a session's CI last gave way to, from the
 * server log's own line ("[release-priority] SIGTERM to … of session <id>, …
 * release release:production:<sha> waited …"): what a wait recorded by an
 * earlier build (no releaseSha) is migrated with. Null when the log does not say. */
export function stoppedReleaseFromLog(log: string, sessionId: string): string | null {
  const line = log.split("\n").findLast((each) => each.includes("[release-priority] SIGTERM to ") && each.includes(`of session ${sessionId}`));
  const label = line ? /, release (release:[\w-]+:[0-9a-f]{7,40}) waited \d+s/.exec(line)?.[1] : undefined;
  return label ? releaseLabelSha(label) : null;
}

/** What the session hears now, or null while it still waits: the tag moved
 * (the release went through), or THAT release failed again, was refused by
 * the owner or halted — the tag will not move for it, and waiting on the tag
 * left two sessions parked for hours (R10-resilience PRIO-LOOP: a59760a2 and
 * 9b50cdf7, resumeAfterTag from 09d832f4b while d5bb1f70b kept failing). */
export function resumeAfterRelease(wait: ResumeWait, now: { tagSha: string | null; failures: { sha: string; count: number } | null; declined: string; halted: string | null; at?: number }): string | null {
  if (now.tagSha && now.tagSha !== wait.fromSha) return wait.message;
  const sha = wait.releaseSha;
  // never parked for good: the release may have stopped being the candidate
  // (main moved on) without failing, being refused or halted (INSP-J r1 #2)
  if (now.at !== undefined && now.at - wait.at >= RESUME_AFTER_MAX_MS) {
    return `O release de produção${sha ? ` do ${sha.slice(0, 9)}` : ""}, que tomou a vez do seu ci:local, não saiu em ${Math.round(RESUME_AFTER_MAX_MS / 3_600_000)} h e a tag não andou: relance o seu ci:local agora (npm run ci:local) e siga de onde parou.`;
  }
  if (!sha) return null;
  const same = (other: string | null | undefined) => Boolean(other && /^[0-9a-f]{7,40}$/.test(other.trim()) && (other.trim().startsWith(sha) || sha.startsWith(other.trim())));
  const relaunch = "relance o seu ci:local agora (npm run ci:local) e siga de onde parou; o servidor não interrompe mais CI de sessão por esse commit enquanto ele estiver em laço.";
  const short = sha.slice(0, 9);
  if (same(now.declined)) return `O release de produção do ${short}, que tomou a vez do seu ci:local, foi recusado pelo dono e não vai sair: ${relaunch}`;
  if (same(now.halted)) return `O release de produção do ${short}, que tomou a vez do seu ci:local, foi parado pelo watcher (halt) e não vai sair agora: ${relaunch}`;
  if (now.failures && same(now.failures.sha) && now.failures.count > (wait.failuresAtStop ?? 0)) return `O release de produção do ${short}, que tomou a vez do seu ci:local, falhou de novo (${now.failures.count}× seguidas) e a tag não andou: ${relaunch}`;
  return null;
}
