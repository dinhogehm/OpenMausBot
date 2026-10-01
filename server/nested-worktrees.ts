// A batch session makes worktrees of its own inside its folder (g9278,
// c9322…) and leaves them behind when it is archived: dozens of GiB of
// merged branches nobody will open again. Archiving a session removes the
// ones that are safe to remove: merged into origin/main, not locked, and
// clean (`git worktree remove` without --force refuses a dirty one). Any
// other is kept and named.

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  locked: boolean;
  /** git's "prunable": its folder is gone. */
  prunable?: true;
  /** The repository itself (a bare repo has no work tree). */
  bare?: true;
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
    entries.push({
      path, ...(head ? { head } : {}), ...(branch ? { branch } : {}),
      locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
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
export function gitFailureLabel(error: unknown): string {
  const stderr = String((error as { stderr?: unknown })?.stderr || (error as Error)?.message || error || "");
  if (/timed out|ETIMEDOUT|SIGTERM/i.test(stderr)) return "não conferida: git demorou demais";
  const line = stderr.split("\n").map((part) => part.replace(/^(?:fatal|error):\s*/i, "").trim()).find(Boolean) ?? "erro do git";
  return `não conferida: ${line.slice(0, 80)}`;
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
}

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

  for (const { entry, path } of worktrees) {
    if (!entry.head) continue;
    if ([...guarded].some((root) => isInside(path, root))) continue; // an agent works there
    try {
      await deps.git(["merge-base", "--is-ancestor", entry.head, releasedSha]);
    } catch {
      continue; // not in production yet (or not known here)
    }
    if (entries.some((other) => other.path !== path && isInside(other.path, path))) { keep(entry, "contém outra worktree"); continue; }
    if (entry.locked) { keep(entry, "bloqueada"); continue; }
    if (entry.prunable) { keep(entry, "pasta já não existe"); continue; }
    const named = (command: string) => [path, entry.path].some((form) => command.includes(`${form}/`) || command.endsWith(form) || command.includes(`${form} `));
    if (cwds.some((cwd) => isInside(cwd, path)) || deps.processCommands.some(named)) { keep(entry, "em uso por processo"); continue; }
    const active = await deps.lastActivity(entry.path);
    if (active === null) { keep(entry, "atividade desconhecida"); continue; }
    if (deps.now - active < RELEASED_MIN_IDLE_MS) { keep(entry, "usada há menos de 24 h"); continue; }
    try {
      const status = await deps.git(["-C", entry.path, "--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]);
      if (status.trim()) { keep(entry, "tem mudanças locais"); continue; }
      const ignored = (await deps.git(["-C", entry.path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]))
        .split("\n").map((line) => line.trim()).filter(Boolean).filter((line) => !isDisposableIgnored(line));
      if (ignored.length) { keep(entry, `tem arquivos ignorados: ${ignored.slice(0, 3).join(", ")}${ignored.length > 3 ? ` e mais ${ignored.length - 3}` : ""}`); continue; }
    } catch (error) {
      keep(entry, gitFailureLabel(error));
      continue;
    }
    plan.candidates.push({ path: entry.path, command: `git -C ${shellQuote(repo)} worktree remove ${shellQuote(entry.path)}` });
  }
  return plan;
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
 * new (same candidates and same kept list as `previousKey`). `key` is what
 * to remember for the next pass. */
export function releasedPlanLine(repoName: string, plan: ReleasedPlan, previousKey: string | undefined): { line: string | null; key: string } {
  const key = [...plan.candidates.map((candidate) => `+${candidate.path}`), ...plan.kept].sort().join("\n");
  if (key === (previousKey ?? "") || !plan.candidates.length && !plan.kept.length) return { line: null, key };
  const name = (item: string) => {
    const at = item.indexOf(" (");
    const path = at < 0 ? item : item.slice(0, at);
    return `${path.split("/").pop()}${at < 0 ? "" : item.slice(at)}`;
  };
  const candidates = plan.candidates.length ? `${plan.candidates.length} pode(m) ser removida(s) (${plan.candidates.map((candidate) => name(candidate.path)).join(", ")})` : "nenhuma pode ser removida";
  return { line: `${repoName}: ${candidates}${plan.kept.length ? `; mantidas: ${plan.kept.map(name).join(", ")}` : ""}`, key };
}

/** Remove the merged, unlocked, clean worktrees nested in `parent`; a pt-BR
 * note of what was removed and what was kept, or "" when there were none. */
export function removeNestedWorktrees(parent: string, git: (args: string[]) => string, mainRef = "origin/main"): string {
  let entries: WorktreeEntry[];
  try {
    entries = nestedWorktrees(parseWorktreeList(git(["worktree", "list", "--porcelain"])), parent);
  } catch {
    return "";
  }
  if (!entries.length) return "";
  const removed: string[] = [];
  const kept: string[] = [];
  const name = (entry: WorktreeEntry) => entry.path.slice(parent.length + 1);
  for (const entry of entries) {
    if (entry.locked) { kept.push(`${name(entry)} (bloqueada)`); continue; }
    if (!entry.head) { kept.push(`${name(entry)} (sem commit)`); continue; }
    try {
      git(["merge-base", "--is-ancestor", entry.head, mainRef]);
    } catch {
      kept.push(`${name(entry)} (não está em ${mainRef})`);
      continue;
    }
    try {
      git(["worktree", "remove", entry.path]);
      removed.push(name(entry));
    } catch {
      kept.push(`${name(entry)} (tem mudanças locais)`);
    }
  }
  return [
    removed.length ? `Worktrees internas removidas (já mergeadas): ${removed.join(", ")}.` : "",
    kept.length ? `Mantidas: ${kept.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}
