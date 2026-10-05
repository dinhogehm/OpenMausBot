// A batch session makes worktrees of its own inside its folder (g9278,
// c9322…) and leaves them behind when it is archived: dozens of GiB of
// merged branches nobody will open again. Nothing here removes a worktree:
// the server only plans — on archive (G12) and every 6 h for the ones
// already in production (G3) — and a person runs the commands it reports.

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  locked: boolean;
  /** Why it is locked (`git worktree lock --reason`), when given. */
  lockReason?: string;
  /** git's "prunable": its folder is gone. */
  prunable?: true;
  /** The repository itself (a bare repo has no work tree). */
  bare?: true;
}

/** A C-quoted git string ("sess\303\243o \"x\"") as text ("sessão "x""); anything else as is. */
export function unquoteGit(value: string): string {
  if (value.length < 2 || !value.startsWith("\"") || !value.endsWith("\"")) return value;
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, "\"": 34 };
  const body = value.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char !== "\\") { bytes.push(...Buffer.from(char, "utf8")); continue; }
    const octal = /^[0-3][0-7]{2}/.exec(body.slice(i + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue; }
    const next = body[i + 1];
    if (next !== undefined && simple[next] !== undefined) { bytes.push(simple[next]!); i += 1; continue; }
    bytes.push(92);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** `git worktree list --porcelain`, one entry per blank-line block. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length);
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//, "");
    const rawReason = lines.find((line) => line.startsWith("locked "))?.slice("locked ".length).trim();
    const lockReason = rawReason ? unquoteGit(rawReason) : undefined;
    entries.push({
      path, ...(head ? { head } : {}), ...(branch ? { branch } : {}),
      locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
      ...(lockReason ? { lockReason } : {}),
      ...(lines.some((line) => line === "prunable" || line.startsWith("prunable ")) ? { prunable: true as const } : {}),
      ...(lines.includes("bare") ? { bare: true as const } : {}),
    });
  }
  return entries;
}

/** Worktrees inside `parent` (not `parent` itself). */
export function nestedWorktrees(entries: readonly WorktreeEntry[], parent: string): WorktreeEntry[] {
  const prefix = `${parent.replace(/\/+$/, "")}/`;
  return entries.filter((entry) => entry.path.startsWith(prefix));
}

// ── Worktrees already in production (R8 G3): a report, never a removal ──
// Every 6 h the server lists, for the Chief, the worktrees whose HEAD the
// production tag already contains and that look safe to remove, each with
// the `git worktree remove <path>` a person runs. The server itself removes
// none: removing is final, and a wrong guess loses work. A worktree is a
// candidate only when every one of these holds:
// - no agent works in it: the deepest worktree holding a session's, a
//   bot's, the app's or a Codex session's folder is out, with what is
//   inside it (a folder that is the main checkout or above it protects
//   only the main checkout, which is never a candidate);
// - no other worktree inside it: `git worktree remove` of a parent deletes
//   a nested worktree its .gitignore hides (`.worktrees/`), uncommitted
//   work and all (INSP-G r1, proved with git);
// - no running process with its cwd inside it, or naming it in its argv;
// - nothing done in it for 24 h (its HEAD, index, reflog, folder): a
//   worktree just made from main is "in production" by definition;
// - not locked, not prunable, clean for `git status` (tracked and
//   untracked), and no ignored file but rebuildable ones (node_modules,
//   dist, caches, logs): an ignored `.env.local`, `.deploy-history/` or a
//   nested `.worktrees/` keeps it out. When in doubt it is not a candidate.
// git runs async (`git`), so the pass never stops the server.

export const RELEASED_MIN_IDLE_MS = 24 * 3_600_000;

/** Ignored folders anything can rebuild (an install, a build, a test run). */
const DISPOSABLE_DIRS = new Set([
  "node_modules", ".pnpm-store", "dist", "build", ".next", ".turbo", ".wrangler", ".vite", ".cache",
  "coverage", "playwright-report", "test-results", "blob-report", ".skillseeker-cache", ".local-ci", ".deploy-cache",
]);
/** Ignored files anything can rebuild. */
const DISPOSABLE_FILE = /(?:^|\/)(?:\.DS_Store|Thumbs\.db|\.eslintcache|\.test-metrics(?:-history)?\.json|\.test-report\.md|\.flaky-tests\.json)$|\.(?:log|tsbuildinfo)$/;
/** A folder whose content is never assumed rebuildable, whatever is below it. */
const NEVER_DISPOSABLE = new Set([".worktrees", "worktrees", ".claude", ".codex", ".git"]);

/** An ignored path (`git ls-files --others --ignored --directory`; folders
 * end in "/") that removing the worktree may lose: only what can be rebuilt. */
export function isDisposableIgnored(path: string): boolean {
  const segments = path.replace(/\/+$/, "").split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (NEVER_DISPOSABLE.has(segment)) return false;
    if (DISPOSABLE_DIRS.has(segment) && (i < segments.length - 1 || path.endsWith("/"))) return true;
  }
  return DISPOSABLE_FILE.test(path);
}

const trimSlash = (path: string) => (path === "/" ? "/" : path.replace(/\/+$/, ""));
/** `path` is `folder` or inside it. */
export const isInside = (path: string, folder: string): boolean => path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);

/** A git failure in pt-BR, from its stderr. */
export function gitFailureLabel(error: unknown, what = "não conferida"): string {
  const stderr = String((error as { stderr?: unknown })?.stderr || (error as Error)?.message || error || "");
  if (/modified or untracked|contains modified|untracked files/i.test(stderr)) return "tem mudanças locais";
  if (/timed out|ETIMEDOUT|SIGTERM/i.test(stderr)) return `${what}: git demorou demais`;
  const line = stderr.split("\n").map((part) => part.replace(/^(?:fatal|error):\s*/i, "").trim()).find(Boolean) ?? "erro do git";
  return `${what}: ${line.slice(0, 80)}`;
}

/** Latest sign of work in a worktree, from what git and the folder record:
 * its admin dir's HEAD, index and reflog, and the folder itself. Null when
 * it cannot be told (no `.git` file, unreadable): such a worktree is kept. */
export function worktreeLastActivity(path: string, fs: { readFile: (path: string) => string; mtime: (path: string) => number | null }): number | null {
  let admin: string;
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFile(`${path}/.git`))?.[1]?.trim();
    if (!gitdir) return null;
    admin = gitdir.startsWith("/") ? gitdir : `${path}/${gitdir}`;
  } catch {
    return null;
  }
  const head = fs.mtime(`${admin}/HEAD`);
  const folder = fs.mtime(path);
  if (head === null || folder === null) return null;
  return Math.max(head, folder, fs.mtime(`${admin}/index`) ?? 0, fs.mtime(`${admin}/logs/HEAD`) ?? 0);
}

export interface ReleasedPlanDeps {
  /** `git <args>` in the repository (args may start with `-C <worktree>`);
   * read-only commands only; rejects on failure, with git's `stderr`. */
  git: (args: string[]) => Promise<string>;
  /** Folders agents work in: sessions (ours and the app's), bots' conversations, Codex. */
  inUse: Iterable<string>;
  /** The cwd of every running process. */
  processCwds: readonly string[];
  /** The command line of every running process. */
  processCommands: readonly string[];
  /** Latest activity in a worktree (ms), or null when unknown. */
  lastActivity: (path: string) => number | null | Promise<number | null>;
  now: number;
  /** Canonical form of a path (realpath); the identity by default. */
  canon?: (path: string) => string;
}

export interface ReleasedPlan {
  /** Safe to remove, with the command a person runs. */
  candidates: Array<{ path: string; command: string }>;
  /** In production but not a candidate: "<path> (<why>)". */
  kept: string[];
  /** What was judged: the worktrees listed (besides the main checkout) and
   * those contained in the tag — the only ones judged for removal. */
  scope?: { total: number; inTag: number };
  /** Outside the tag, nobody in them, untouched for STALE_OUTSIDE_TAG_MS:
   * told to a person as information, with the command; never removed. */
  stale?: StaleFolder[];
}

/** A folder idle for days outside the tag: information for a person (R10-resilience D). */
export interface StaleFolder {
  path: string;
  kind: "worktree" | "task-workspace";
  idleSince: number;
  /** What a person runs after checking (no --force; a task-workspace goes to the Trash, not rm). */
  command: string;
  sizeKb?: number | null;
  /** Whose it was, for a task-workspace ("conversa fechada", "conversa aberta, parada desde 29/09"). */
  note?: string;
}

/** Smaller than this, an idle folder is counted, not listed. */
export const STALE_MIN_KB = 200 * 1024;

/** How long a folder outside the tag must sit untouched before a person hears of it. */
export const STALE_OUTSIDE_TAG_MS = 72 * 3_600_000;

const shellQuote = (value: string) => (/^[\w./@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** Worktrees of `repo` whose work is already in production (HEAD contained in
 * `releasedSha`, the production tag) that a person may remove, and those
 * that must stay and why. Only reads: it never removes anything. */
export async function planReleasedWorktrees(repo: string, releasedSha: string, deps: ReleasedPlanDeps): Promise<ReleasedPlan> {
  const canon = (path: string) => trimSlash(deps.canon ? deps.canon(path) : path);
  const plan: ReleasedPlan = { candidates: [], kept: [] };
  let listed: WorktreeEntry[];
  try {
    listed = parseWorktreeList(await deps.git(["worktree", "list", "--porcelain"]));
  } catch {
    return plan;
  }
  if (!listed.length) return plan;
  const entries = listed.map((entry) => ({ entry, path: canon(entry.path) }));
  // git lists the main working tree first
  const main = new Set([entries[0]!.path, canon(repo)]);
  const worktrees = entries.filter(({ path, entry }) => !main.has(path) && !entry.bare);

  // each folder in use protects the deepest worktree holding it, and what is inside that one
  const guarded = new Set<string>();
  for (const raw of deps.inUse) {
    if (!raw) continue;
    const folder = canon(raw);
    if ([...main].some((root) => isInside(root, folder))) continue; // the main checkout, or above it
    const holder = worktrees.filter(({ path }) => isInside(folder, path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (holder) guarded.add(holder.path);
  }
  const cwds = deps.processCwds.map(canon);
  const keep = (entry: WorktreeEntry, why: string) => { plan.kept.push(`${entry.path} (${why})`); };
  let inTag = 0;
  const stale: StaleFolder[] = [];

  for (const { entry, path } of worktrees) {
    if (!entry.head) continue;
    if ([...guarded].some((root) => isInside(path, root))) continue; // an agent works there
    try {
      await deps.git(["merge-base", "--is-ancestor", entry.head, releasedSha]);
    } catch {
      // not in production yet (or not known here): never judged for removal —
      // but one nobody touched for days is told, as information (R10-resilience D:
      // ~17 GB idle for 4–5 days while the Chief said "nenhuma pode ser removida")
      if (!holdsAnother(path, entries.map((other) => other.path)) && !entry.locked && !entry.prunable && !usedByProcess([path, entry.path], cwds, deps.processCommands)) {
        const active = await deps.lastActivity(entry.path);
        if (active !== null && deps.now - active > STALE_OUTSIDE_TAG_MS) stale.push({ path: entry.path, kind: "worktree", idleSince: active, command: removeCommand(repo, entry.path) });
      }
      continue;
    }
    inTag += 1;
    if (holdsAnother(path, entries.map((other) => other.path))) { keep(entry, "contém outra worktree"); continue; }
    if (entry.locked) { keep(entry, "bloqueada"); continue; }
    if (entry.prunable) { keep(entry, "pasta já não existe"); continue; }
    if (usedByProcess([path, entry.path], cwds, deps.processCommands)) { keep(entry, "em uso por processo"); continue; }
    const active = await deps.lastActivity(entry.path);
    if (active === null) { keep(entry, "atividade desconhecida"); continue; }
    if (deps.now - active < RELEASED_MIN_IDLE_MS) { keep(entry, "usada há menos de 24 h"); continue; }
    const content = await contentBlocker(entry.path, deps.git);
    if (content) { keep(entry, content); continue; }
    plan.candidates.push({ path: entry.path, command: removeCommand(repo, entry.path) });
  }
  plan.scope = { total: worktrees.length, inTag };
  if (stale.length) plan.stale = stale;
  return plan;
}

/** What one open (not archived) conversation keeps in use, and — for the disk
 * report only — the note of its workspace when the conversation is closed, or
 * quiet past STALE_OUTSIDE_TAG_MS without a turn or a goal. A bot conversation's
 * own folder (task.cwd) usually IS that workspace: it must not count as in use
 * then, or no closed or quiet workspace ever reaches the report (R11-resilience
 * D2: ~6,5 GB never told). A folder elsewhere (a project) stays in use. */
export function conversationFolders(
  task: { cwd?: unknown; closedBy?: unknown; busy?: boolean; title: string; createdAt: number; updatedAt?: number },
  workspace: string,
  opts: { forDisk: boolean; hasGoal: boolean; now: number; day: (ms: number) => string },
): { inUse: string[]; quiet?: string } {
  const cwd = typeof task.cwd === "string" ? task.cwd : null;
  let quiet: string | undefined;
  if (opts.forDisk) {
    const quietSince = task.updatedAt ?? task.createdAt;
    if (task.closedBy) quiet = `conversa "${task.title.slice(0, 40)}" fechada`;
    else if (!task.busy && !opts.hasGoal && opts.now - quietSince > STALE_OUTSIDE_TAG_MS) quiet = `conversa "${task.title.slice(0, 40)}" aberta, parada desde ${opts.day(quietSince)}`;
  }
  if (quiet) return { inUse: cwd && !isInside(trimSlash(cwd), trimSlash(workspace)) ? [cwd] : [], quiet };
  return { inUse: [...(cwd ? [cwd] : []), workspace] };
}

/** When a folder last changed: the newest of its own time and of its entries one
 * level below — an edit inside repo/ or a new file does not touch the top's mtime
 * (INSP-R12a R12b-3). At most `limit` entries are read; unreadable, the top's time. */
export function folderActivity(path: string, deps: { list: (dir: string) => string[]; mtime: (path: string) => number | null }, limit = 200): number | null {
  let newest = deps.mtime(path);
  let entries: string[] = [];
  try { entries = deps.list(path); } catch { return newest; }
  for (const entry of entries.slice(0, limit)) {
    const at = deps.mtime(`${trimSlash(path)}/${entry}`);
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** Every task-workspace under `root` (<root>/<bot>/<conversation>), with its
 * last activity and the note of its conversation when closed or quiet. */
export function scanTaskWorkspaces(root: string, deps: { list: (dir: string) => string[]; activity: (path: string) => number | null; notes: ReadonlyMap<string, string> }): Array<{ path: string; lastActivity: number | null; note?: string }> {
  const found: Array<{ path: string; lastActivity: number | null; note?: string }> = [];
  let bots: string[] = [];
  try { bots = deps.list(root); } catch { return found; } // no task-workspaces here
  for (const bot of bots) {
    const botDir = `${trimSlash(root)}/${bot}`;
    let threads: string[] = [];
    try { threads = deps.list(botDir); } catch { continue; }
    for (const thread of threads) {
      const path = `${botDir}/${thread}`;
      const note = deps.notes.get(path);
      found.push({ path, lastActivity: deps.activity(path), ...(note ? { note } : {}) });
    }
  }
  return found;
}

/** The task-workspaces (task-workspaces/<bot>/<conversation>) idle past
 * STALE_OUTSIDE_TAG_MS that no agent uses: no open conversation, no session
 * inside, not already told as a worktree. Information for a person, with a
 * command that moves to the Trash (undoable), never one that deletes. */
export function staleTaskWorkspaces(folders: ReadonlyArray<{ path: string; lastActivity: number | null; note?: string }>, input: { inUse: Iterable<string>; now: number; known?: readonly string[]; canon?: (path: string) => string; root?: string; home?: string; processCwds?: Iterable<string> }): StaleFolder[] {
  const canon = (path: string) => trimSlash(input.canon ? input.canon(path) : path);
  const root = input.root ? canon(input.root) : null;
  const home = input.home ? canon(input.home) : null;
  // a folder at or above the task-workspaces root ("/", the home, ~/.openmausbot) holds
  // none of them: an app session with cwd "/" made every one "in use" (R12-resilience D3),
  // as the main checkout or above it holds no worktree in planReleasedWorktrees
  const above = (each: string) => each === "/" || each === home || (root !== null && isInside(root, each));
  // a live process (a manual claude, a shell) working inside one holds it too (INSP-R12a R12b-3)
  const used = [...input.inUse, ...(input.processCwds ?? [])].filter(Boolean).map(canon).filter((each) => !above(each));
  const known = (input.known ?? []).map(canon);
  return folders.flatMap((folder) => {
    const path = canon(folder.path);
    if (folder.lastActivity === null || input.now - folder.lastActivity <= STALE_OUTSIDE_TAG_MS) return [];
    if (used.some((each) => isInside(each, path) || isInside(path, each))) return [];
    if (known.some((each) => isInside(each, path) || isInside(path, each))) return [];
    return [{ path: folder.path, kind: "task-workspace" as const, idleSince: folder.lastActivity, command: `mv ${shellQuote(folder.path)} ~/.Trash/`, ...(folder.note ? { note: folder.note } : {}) }];
  });
}

/** A folder line's kind, with whose conversation it was for a task-workspace. */
const folderKind = (each: StaleFolder): string => (each.kind === "worktree" ? "worktree" : `task-workspace${each.note ? ` (${each.note})` : ""}`);

/** "Nobody in them" only when it is true: a quiet conversation still open has its
 * workspace listed with a note, and only no PROCESS uses it (INSP-U r1 U2). */
const nobodyIn = (folders: readonly StaleFolder[]): string => (folders.some((each) => each.note && /\baberta\b/.test(each.note))
  ? "sem processo nelas (uma conversa ainda aberta está marcada como tal)"
  : folders.some((each) => each.note) ? "sem processo nelas" : "sem ninguém nelas");

/** A size for a person: "3,0 GB", "640 MB". */
export function sizeLabel(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1).replace(".", ",")} GB`;
  return `${Math.max(1, Math.round(kb / 1024))} MB`;
}

/** What the server judged, said so a bot never reads "none may be removed"
 * as "nothing on disk can go" (R10-resilience D). */
export function releasedScopeLine(repoName: string, plan: ReleasedPlan, tag: string): string | null {
  if (!plan.scope) return null;
  const { total, inTag } = plan.scope;
  return `${repoName}: avaliei para remoção só as worktrees já contidas na tag ${tag} (${inTag} de ${total}); as outras ${total - inTag} não foram avaliadas para remoção.`;
}

/** The idle folders outside the tag, biggest first, for a person: each with
 * its size, since when, and the command; null when there are none. */
export function staleFoldersReport(stale: readonly StaleFolder[], timeZone = "America/Sao_Paulo", minKb = STALE_MIN_KB): { chip: string; report: string } | null {
  // the big ones are the news: biggest first, the small ones counted (INSP-J r1 #7)
  const sorted = [...stale].sort((a, b) => (b.sizeKb ?? -1) - (a.sizeKb ?? -1) || a.idleSince - b.idleSince);
  const shown = sorted.filter((each) => (each.sizeKb ?? 0) >= minKb);
  const small = sorted.length - shown.length;
  if (!shown.length) return null;
  const totalKb = shown.reduce((sum, each) => sum + (each.sizeKb ?? 0), 0);
  const day = (ms: number) => new Date(ms).toLocaleDateString("pt-BR", { timeZone, day: "2-digit", month: "2-digit" });
  const lines = shown.map((each) => `- ${folderKind(each)} ${each.path} (${sizeLabel(each.sizeKb!)}, sem mudança desde ${day(each.idleSince)}): ${each.command}`);
  const total = `~${sizeLabel(totalKb)}`;
  const trash = shown.some((each) => each.kind === "task-workspace") ? " A task-workspace vai para a Lixeira: o espaço só volta ao esvaziar a Lixeira." : "";
  return {
    chip: `Disco: ${shown.length} pasta(s) parada(s) há mais de 72 h fora da tag, ${total} — informação para o dono, nada foi removido`,
    report: `Paradas há mais de 72 h, fora da tag e ${nobodyIn(shown)}: ${shown.length}, ${total} no total${small ? ` (e mais ${small} pequena(s), abaixo de ${sizeLabel(minKb)}, não listada(s))` : ""}. Só informação: o servidor não removeu nada e não avaliou se podem sair; uma pessoa confere (git status, o que há dentro) e decide. Os comandos não usam --force.${trash}\n${lines.join("\n")}`,
  };
}

/** How many idle folders a low-disk alert names: the biggest. */
export const DISK_ALERT_FOLDERS_MAX = 5;

/** The low-disk alert for the Chief. On 02/10 (6,3 GiB free) the old text,
 * "Libere espaço (worktrees antigas, caches de build) ou avise a pessoa",
 * had the Chief delete node_modules of 9 worktrees on its own and then tell
 * the owner twice that "nenhuma worktree pode ser removida" — while ~17 GB
 * sat idle outside the tag (R10-resilience D). The alert now carries what
 * the server last measured, biggest first with the command, says nothing is
 * removed by a bot without the owner's OK, and, when nothing was measured
 * yet, that the in-tag report says nothing about the rest. */
export function diskAlertText(
  drop: { freeGiB: number; path: string; band: number },
  stale: { at: number; folders: readonly StaleFolder[] } | null,
  timeZone = "America/Sao_Paulo",
  minKb = STALE_MIN_KB,
): { chip: string; report: string } {
  const head = `Pouco espaço em disco: ${String(drop.freeGiB).replace(".", ",")} GiB livres em ${drop.path} (abaixo de ${drop.band} GiB). Worktrees, CI local e builds podem falhar, e em zero o servidor para de gravar.`;
  const rule = "Não remova nada por conta própria, nem node_modules: o que sai do disco é decisão do dono. Leve a ele o que ocupa espaço, com tamanho e comando, e espere o OK.";
  const big = [...(stale?.folders ?? [])].filter((each) => (each.sizeKb ?? 0) >= minKb).sort((a, b) => (b.sizeKb ?? 0) - (a.sizeKb ?? 0));
  if (!stale || !big.length) {
    // du failed on some: not measured is not small (INSP-U r1 U2)
    const unsized = (stale?.folders ?? []).filter((each) => each.sizeKb === undefined || each.sizeKb === null);
    const unmeasured = stale && unsized.length
      ? `Na última medição do servidor havia ${unsized.length} pasta(s) parada(s) há mais de 72 h fora da tag cujo tamanho não consegui medir: ${unsized.slice(0, DISK_ALERT_FOLDERS_MAX).map((each) => `${folderKind(each)} ${each.path}`).join("; ")}. Meça com du -sh e não diga ao dono que nada pode ser removido.`
      : stale
      ? "Na última medição do servidor não havia pasta grande parada há mais de 72 h fora da tag: veja caches de build e o $TMPDIR (du -sh) e diga ao dono o que achou."
      : "O servidor ainda não mediu as pastas paradas fora da tag (o relatório de worktrees sai a cada 6 h e avalia para remoção só as contidas na tag): não diga ao dono que nada pode ser removido; meça com du -sh e diga o que achou.";
    return { chip: head, report: `${head} ${rule} ${unmeasured}` };
  }
  const totalKb = big.reduce((sum, each) => sum + (each.sizeKb ?? 0), 0);
  const when = new Date(stale.at).toLocaleString("pt-BR", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const shown = big.slice(0, DISK_ALERT_FOLDERS_MAX);
  const more = big.length - shown.length;
  const lines = shown.map((each) => `- ${folderKind(each)} ${each.path} (${sizeLabel(each.sizeKb!)}): ${each.command}`);
  const trash = shown.some((each) => each.kind === "task-workspace") ? " A task-workspace vai para a Lixeira: o espaço só volta ao esvaziar a Lixeira." : "";
  return {
    chip: `${head.replace(/\. Worktrees, CI local.*$/, "")} — ~${sizeLabel(totalKb)} em ${big.length} pasta(s) parada(s) fora da tag, para o dono decidir`,
    report: `${head} ${rule} Medido pelo servidor em ${when}: ${big.length} pasta(s) parada(s) há mais de 72 h, fora da tag e ${nobodyIn(shown)}, ~${sizeLabel(totalKb)} no total — "nenhuma worktree pode ser removida" vale só para as contidas na tag, não para estas. As maiores${more ? ` (e mais ${more})` : ""}:\n${lines.join("\n")}\nOs comandos não usam --force; uma pessoa confere antes.${trash}`,
  };
}

/** The command a person runs to remove a worktree (never --force). */
export const removeCommand = (repo: string, path: string): string => `git -C ${shellQuote(repo)} worktree remove ${shellQuote(path)}`;

/** Another worktree (of `all`) strictly inside `path`. */
const holdsAnother = (path: string, all: readonly string[]): boolean => all.some((other) => other !== path && isInside(other, path));

/** A running process works in the folder (cwd inside it) or names it in its argv; `forms` are the folder's spellings. */
export function usedByProcess(forms: readonly string[], cwds: readonly string[], commands: readonly string[]): boolean {
  return cwds.some((cwd) => forms.some((form) => isInside(cwd, form)))
    || commands.some((command) => forms.some((form) => command.includes(`${form}/`) || command.endsWith(form) || command.includes(`${form} `)));
}

/** What in a worktree's content forbids removing it — local changes (tracked
 * or untracked), an ignored file that cannot be rebuilt, or a git failure
 * (when in doubt it stays) — or null when there is nothing but what git has. */
export async function contentBlocker(path: string, git: (args: string[]) => Promise<string>): Promise<string | null> {
  try {
    const status = await git(["-C", path, "--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]);
    if (status.trim()) return "tem mudanças locais";
    const ignored = (await git(["-C", path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]))
      .split("\n").map((line) => line.trim()).filter(Boolean).filter((line) => !isDisposableIgnored(line));
    if (ignored.length) return `tem arquivos ignorados: ${ignored.slice(0, 3).join(", ")}${ignored.length > 3 ? ` e mais ${ignored.length - 3}` : ""}`;
    return null;
  } catch (error) {
    return gitFailureLabel(error);
  }
}

/** The folders a Codex session works in, from its rollout's first line
 * (`{"type":"session_meta","payload":{"cwd":…,"runtime_workspace_roots":[…]}}`).
 * The line can be cut (a long base_instructions): then `"cwd":"…"` is read alone. */
export function codexRolloutFolders(head: string): string[] {
  const first = head.split("\n")[0] ?? "";
  try {
    const meta = JSON.parse(first) as { type?: string; payload?: { cwd?: unknown; runtime_workspace_roots?: unknown } };
    if (meta.type !== "session_meta") return [];
    const roots = Array.isArray(meta.payload?.runtime_workspace_roots) ? meta.payload!.runtime_workspace_roots as unknown[] : [];
    return [meta.payload?.cwd, ...roots].filter((folder): folder is string => typeof folder === "string" && folder.startsWith("/"));
  } catch {
    if (!first.includes(`"session_meta"`)) return [];
    const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(first)?.[1];
    return cwd?.startsWith("/") ? [cwd.replace(/\\(.)/g, "$1")] : [];
  }
}

/** The Chief's line for one repository's pass, or null when it says nothing
 * new: the same paths as candidates and as kept as `previousKey`. Only the
 * paths count — a kept worktree's reason flips between passes ("em uso por
 * processo", "usada há menos de 24 h"…) and is no news (INSP-G r2 item 6).
 * `key` is what to remember for the next pass. */
export function releasedPlanLine(repoName: string, plan: ReleasedPlan, previousKey: string | undefined): { line: string | null; key: string } {
  const keptPath = (item: string) => { const at = item.indexOf(" ("); return at < 0 ? item : item.slice(0, at); };
  const key = [...plan.candidates.map((candidate) => `+${candidate.path}`), ...plan.kept.map((item) => `=${keptPath(item)}`)].sort().join("\n");
  if (key === (previousKey ?? "") || !plan.candidates.length && !plan.kept.length) return { line: null, key };
  const name = (item: string) => {
    const at = item.indexOf(" (");
    const path = at < 0 ? item : item.slice(0, at);
    return `${path.split("/").pop()}${at < 0 ? "" : item.slice(at)}`;
  };
  // "of those in the tag": never read as "nothing on disk can go" (R10-resilience D)
  const candidates = plan.candidates.length ? `${plan.candidates.length} das contidas na tag pode(m) ser removida(s) (${plan.candidates.map((candidate) => name(candidate.path)).join(", ")})` : "nenhuma das contidas na tag pode ser removida";
  return { line: `${repoName}: ${candidates}${plan.kept.length ? `; mantidas: ${plan.kept.map(name).join(", ")}` : ""}`, key };
}

// ── On archive (G12): a report, never a removal ─────────────────────────
// Archiving a session lists the worktrees it left inside its folder (and,
// when asked, its own worktree) that a person may remove, each with the
// command, and the ones that must stay and why. The server removes, unlocks
// or prunes nothing (INSP-G r2: a removal lost a detached HEAD's commits and
// went past another agent's lock). A worktree is offered only when nothing
// can be lost:
// - its HEAD is in some ref (branch, remote branch or tag): a detached HEAD
//   with commits of its own would lose them — the report gives the command
//   that saves them in a branch first;
// - not locked, unless the lock's reason names this very session;
// - no other worktree inside, no process in it, no other agent's folder in
//   it, no local change, no ignored file that cannot be rebuilt;
// - nested ones: merged.

export interface ArchiveCleanupDeps {
  repo: string;
  /** `git <args>` in the repository, read-only commands; rejects with git's `stderr`. */
  git: (args: string[]) => Promise<string>;
  processCwds: readonly string[];
  processCommands: readonly string[];
  /** Folders other agents work in (sessions, bots, Codex): one inside a worktree keeps it. */
  foldersInUse?: readonly string[];
  /** What a lock set for this very session names (its id): only such a lock does not keep it. */
  ownLockMarkers?: readonly string[];
  canon?: (path: string) => string;
}

export interface ArchiveCleanup {
  /** Safe to remove, with the command a person runs (and a note when git may refuse it: submodules). */
  candidates: Array<{ path: string; command: string }>;
  /** What must stay, why, and — when one helps — a command (saving its commits in a branch). */
  kept: Array<{ path: string; why: string; command?: string }>;
}

async function listEntries(deps: ArchiveCleanupDeps): Promise<Array<{ entry: WorktreeEntry; path: string }> | null> {
  const canon = (path: string) => trimSlash(deps.canon ? deps.canon(path) : path);
  try {
    return parseWorktreeList(await deps.git(["worktree", "list", "--porcelain"])).map((entry) => ({ entry, path: canon(entry.path) }));
  } catch {
    return null;
  }
}

type Verdict = { ok: true; command: string } | { ok: false; why: string; command?: string };

/** Whether the worktree at `path` (canonical; `entry` as git lists it) may be
 * removed by a person, with the command; or why it must stay. Only reads. */
async function archiveVerdict(entry: WorktreeEntry, path: string, all: readonly string[], deps: ArchiveCleanupDeps, cwds: readonly string[]): Promise<Verdict> {
  if (holdsAnother(path, all)) return { ok: false, why: "contém outra worktree" };
  if (entry.prunable) return { ok: false, why: "pasta já não existe" };
  if (!entry.head) return { ok: false, why: "sem commit" };
  let ownLock = false;
  if (entry.locked) {
    const reason = entry.lockReason ?? "";
    ownLock = reason !== "" && (deps.ownLockMarkers ?? []).some((marker) => marker.length >= 6 && reason.includes(marker));
    if (!ownLock) return { ok: false, why: reason ? `bloqueada: ${reason.slice(0, 80)}` : "bloqueada (sem motivo)" };
  }
  if (usedByProcess([path, entry.path], cwds, deps.processCommands)) return { ok: false, why: "em uso por processo" };
  const canon = (folder: string) => trimSlash(deps.canon ? deps.canon(folder) : folder);
  if ((deps.foldersInUse ?? []).some((folder) => isInside(canon(folder), path))) return { ok: false, why: "em uso por outra sessão" };
  // its commits must live on in some ref once the folder is gone (a detached HEAD's would not)
  try {
    const refs = await deps.git(["for-each-ref", "--count=1", "--contains", entry.head, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]);
    if (!refs.trim()) {
      const name = path.split("/").pop() ?? "worktree";
      return { ok: false, why: "commits fora de qualquer branch", command: `git -C ${shellQuote(entry.path)} branch ${shellQuote(`salvo/${name}`)} HEAD` };
    }
  } catch (error) {
    return { ok: false, why: gitFailureLabel(error) };
  }
  const content = await contentBlocker(entry.path, deps.git);
  if (content) return { ok: false, why: content };
  const remove = removeCommand(deps.repo, entry.path);
  // git refuses to remove a worktree with submodules — after an unlock that
  // would leave it unlocked: only the remove, never chained to the unlock
  let submodules = false;
  try {
    submodules = (await deps.git(["-C", entry.path, "ls-files", "--stage"])).split("\n").some((line) => line.startsWith("160000 "));
  } catch (error) {
    return { ok: false, why: gitFailureLabel(error) };
  }
  if (submodules) return { ok: false, why: `contém submódulos: o git recusa remover assim; confira à mão${ownLock ? " (e não tire o lock antes)" : ""}`, command: remove };
  return { ok: true, command: ownLock ? `git -C ${shellQuote(deps.repo)} worktree unlock ${shellQuote(entry.path)} && ${remove}` : remove };
}

/** The merged worktrees nested in `parent` a person may remove (deepest first), and those that stay. */
export async function planNestedWorktrees(parent: string, deps: ArchiveCleanupDeps, mainRef = "origin/main"): Promise<ArchiveCleanup> {
  const result: ArchiveCleanup = { candidates: [], kept: [] };
  const canon = (path: string) => trimSlash(deps.canon ? deps.canon(path) : path);
  const listed = await listEntries(deps);
  if (!listed) return result;
  const root = canon(parent);
  const all = listed.map(({ path }) => path);
  const cwds = deps.processCwds.map(canon);
  const nested = listed.filter(({ path }) => path !== root && isInside(path, root)).sort((a, b) => b.path.length - a.path.length);
  for (const { entry, path } of nested) {
    if (entry.head) {
      try {
        await deps.git(["merge-base", "--is-ancestor", entry.head, mainRef]);
      } catch {
        result.kept.push({ path: entry.path, why: `não está em ${mainRef}` });
        continue;
      }
    }
    const verdict = await archiveVerdict(entry, path, all, deps, cwds);
    if (verdict.ok) result.candidates.push({ path: entry.path, command: verdict.command });
    else result.kept.push({ path: entry.path, why: verdict.why, ...(verdict.command ? { command: verdict.command } : {}) });
  }
  return result;
}

/** Whether a person may remove the archived session's own worktree, with the
 * command; never when another session (`users`) works in it. */
export async function planArchivedWorktree(folder: string, deps: ArchiveCleanupDeps, users: readonly string[]): Promise<ArchiveCleanup> {
  const result: ArchiveCleanup = { candidates: [], kept: [] };
  if (users.length) { result.kept.push({ path: folder, why: `em uso por ${users.join(", ")}` }); return result; }
  const canon = (path: string) => trimSlash(deps.canon ? deps.canon(path) : path);
  const listed = await listEntries(deps);
  const path = canon(folder);
  const found = listed?.find((item) => item.path === path);
  if (!listed || !found || found.path === listed[0]?.path) { result.kept.push({ path: folder, why: !listed ? "não conferida: git não listou as worktrees" : "não é uma worktree deste repositório" }); return result; }
  const verdict = await archiveVerdict(found.entry, path, listed.map((item) => item.path), deps, deps.processCwds.map(canon));
  if (verdict.ok) result.candidates.push({ path: folder, command: verdict.command });
  else result.kept.push({ path: folder, why: verdict.why, ...(verdict.command ? { command: verdict.command } : {}) });
  return result;
}

/** The bot's chip and report for an archive's plan ("" when there is nothing). */
export function archiveCleanupNote(parent: string, result: ArchiveCleanup): { chip: string; report: string } {
  if (!result.candidates.length && !result.kept.length) return { chip: "", report: "" };
  const name = (path: string) => (path.startsWith(`${parent}/`) ? path.slice(parent.length + 1) : path);
  const chip = [
    result.candidates.length ? `Worktrees que podem ser removidas: ${result.candidates.map((item) => name(item.path)).join(", ")}.` : "",
    result.kept.length ? `Mantidas: ${result.kept.map((item) => `${name(item.path)} (${item.why})`).join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  const report = [
    `${chip} O servidor não remove worktrees.`,
    result.candidates.length ? `Para remover (sem --force; confira antes):\n${result.candidates.map((item) => item.command).join("\n")}` : "",
    ...result.kept.filter((item) => item.command).map((item) => (item.why.startsWith("commits fora")
      ? `Para guardar os commits de ${name(item.path)} antes de qualquer remoção:\n${item.command}`
      : `${name(item.path)} ${item.why}; só depois de conferir, sem tirar lock:\n${item.command}`)),
  ].filter(Boolean).join("\n");
  return { chip, report };
}
