// Worktrees the server makes for the app sessions it opens (lote X, the
// "Floors" idea; R10-dispatch R10-1e). The Claude app picks the folder of a
// New Session itself, and on this Mac it kept landing new sessions in a
// worktree another session had used (01/10 09:53, 02/10 10:07). So the
// server makes the folder first — `git worktree add --no-track -b <branch>
// <repo>/.claude/worktrees/<issue>-<slug> origin/main`, a path of its own by
// construction — and opens the app's New Session right there.
//
// A new worktree of nuria-platform used to run `npm ci` (10–20 min, ~3 GB).
// Its node_modules (and other configured caches) are cloned instead from a
// "seed" checkout the server keeps up to date, with APFS copy-on-write
// (`cp -c -R`, clonefile): no blocks are copied until a file changes. The
// clone is used only when the seed's lockfile is the branch's own and the
// Node is the same; otherwise the session runs `npm ci` itself, as before,
// and the reason is recorded.
//
// The seed (<repo>/.claude/omb-seed, a locked, detached worktree of
// origin/main) is refreshed only when origin/main's lockfile changed, with
// nice, never while a production release is on its way (~/.nuria/admission,
// read only), and stopped if one starts while it installs.
//
// Nothing here removes a worktree, ever: the owner's rule is that the
// server only reports. A failed clone takes back only the temporary copy it
// was writing, inside the new worktree, before any session saw it.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { slugify } from "./cc-sessions.ts";

/** Where the seed lives, inside the repository (`.claude/*` is ignored there). */
export const SEED_DIR = ".claude/omb-seed";
/** The folders the app is given: aliases next to the repository, outside `.claude/worktrees/` (see ownLinkPath). */
export const OWN_LINK_DIR = ".omb-worktree-links";
/** What the seed's lock says, so `git worktree list` tells a person why it is there. */
export const SEED_LOCK_REASON = "OpenMausBot: semente das dependências das worktrees novas; não remover";

export interface OwnWorktreeSettings {
  enabled: boolean;
  /** Names of cache folders found in the seed (up to 3 levels down) and cloned: node_modules by default. */
  cacheNames: string[];
  /** Extra folders, relative to the repository, cloned when the seed has them (".turbo", "web/.next/cache"…). */
  extraDirs: string[];
  /** The lockfiles compared, in order: the first the repository has counts. */
  lockfiles: string[];
  /** How the seed installs (run with nice in the seed); unset: by the lockfile (installFor). */
  install?: string[];
  /** The seed is not installed with less free space than this. */
  minFreeGiB: number;
  /** How often the seed is checked against origin/main. */
  seedEveryMs: number;
}

export const OWN_DEFAULTS: OwnWorktreeSettings = {
  enabled: true,
  cacheNames: ["node_modules"],
  // husky 9 writes its hook shims there on install (ignored by git); git's
  // core.hooksPath points at it, so a worktree without it runs NO hooks
  extraDirs: [".husky/_"],
  lockfiles: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
  minFreeGiB: 10,
  seedEveryMs: 30 * 60_000,
};

/** The repository's own install, by its lockfile: npm ci for npm, pnpm and
 * yarn with the lockfile frozen (never npm ci in a pnpm repository). */
export function installFor(lockName: string | undefined, settings: Pick<OwnWorktreeSettings, "install"> = {}): string[] {
  if (settings.install) return settings.install;
  if (lockName === "pnpm-lock.yaml") return ["pnpm", "install", "--frozen-lockfile"];
  if (lockName === "yarn.lock") return ["yarn", "install", "--frozen-lockfile"];
  return ["npm", "ci", "--no-audit", "--no-fund"];
}

/** The install as a session is told to run it ("npm ci", "pnpm install --frozen-lockfile"). */
export const installText = (lockName: string | undefined, settings: Pick<OwnWorktreeSettings, "install"> = {}) =>
  installFor(lockName, settings).filter((arg) => arg !== "--no-audit" && arg !== "--no-fund").join(" ");

const strings = (value: unknown): string[] | null => (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim()) ? value.map((item: string) => item.trim()) : null);
const safeRelative = (path: string) => !path.startsWith("/") && !path.split("/").includes("..");

/** The settings for `repo`: the defaults, then the file's top level, then its
 * entry for that repository (`{ "enabled": false }` turns it off; the
 * environment's OMB_OWN_WORKTREES=0 turns it off everywhere). */
export function ownSettingsFor(config: unknown, repo: string, env: Record<string, string | undefined> = {}): OwnWorktreeSettings {
  const merged: OwnWorktreeSettings = { ...OWN_DEFAULTS };
  const apply = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const value = raw as Record<string, unknown>;
    if (typeof value.enabled === "boolean") merged.enabled = value.enabled;
    const names = strings(value.cacheNames);
    if (names) merged.cacheNames = names.filter((name) => !name.includes("/"));
    const extra = strings(value.extraDirs);
    if (extra) merged.extraDirs = extra.filter(safeRelative);
    const locks = strings(value.lockfiles);
    if (locks) merged.lockfiles = locks.filter(safeRelative);
    const install = strings(value.install);
    if (install) merged.install = install;
    if (typeof value.minFreeGiB === "number" && value.minFreeGiB >= 0) merged.minFreeGiB = value.minFreeGiB;
    if (typeof value.seedEveryMs === "number" && value.seedEveryMs >= 60_000) merged.seedEveryMs = value.seedEveryMs;
  };
  apply(config);
  apply((config as { repos?: Record<string, unknown> } | null)?.repos?.[repo]);
  if (env.OMB_OWN_WORKTREES === "0") merged.enabled = false;
  return merged;
}

// ── the worktree ───────────────────────────────────────────────────────────

export interface OwnPlan {
  /** The folder's name, `<issue>-<slug>`: the app's folder chip shows it. */
  dir: string;
  path: string;
  branch: string;
}

/** Where a session's worktree goes: `<repo>/.claude/worktrees/<issue>-<slug>`
 * on branch `omb/<issue>-<slug>`, the same for the same session every time.
 * Taken already (a folder, a branch, a folder an app session used — old
 * worktrees stay, nothing removes them) → the session's id is added, which
 * is unique. Null when even that is taken. */
export function planOwnWorktree(repo: string, input: { title: string; issue?: string; sessionId: string }, taken: (plan: OwnPlan) => boolean): OwnPlan | null {
  const words = input.issue ? input.title.replace(new RegExp(`^\\s*#?${input.issue}\\b[\\s:·-]*`), "") : input.title;
  const slug = slugify(words).slice(0, 32).replace(/-+$/g, "") || "sessao";
  const id = input.sessionId.replace(/[^0-9a-z]/gi, "").slice(0, 6).toLowerCase() || "x";
  const base = input.issue ? `${input.issue}-${slug}` : `omb-${id}-${slug}`;
  for (const dir of [base, `${base}-${id}`]) {
    const plan = { dir, path: join(repo, ".claude", "worktrees", dir), branch: `omb/${dir}` };
    if (!taken(plan)) return plan;
  }
  return null;
}

/** Runs a program; resolves with its stdout, rejects with an Error whose
 * `stderr` is git's (or the program's) own words. */
export type Exec = (file: string, args: string[], options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<string>;

/** The last words of a failure, for a person. */
export function failureText(error: unknown): string {
  const stderr = String((error as { stderr?: unknown })?.stderr || "").trim();
  const text = stderr || (error instanceof Error ? error.message : String(error));
  return text.split("\n").map((line) => line.replace(/^(?:fatal|error):\s*/i, "").trim()).filter(Boolean).slice(-2).join(" ").slice(0, 300) || "falhou sem dizer por quê";
}

/** Make the session's worktree from a fresh origin/<base>. A fetch that
 * fails (offline) is said, and the last known origin/<base> is used. The
 * branch does not track origin/<base> (`--no-track`): a bare `git push`
 * from it can never reach main. */
export async function addOwnWorktree(repo: string, plan: OwnPlan, exec: Exec, baseBranch = "main"): Promise<{ ok: true; head: string; fetchError?: string } | { ok: false; error: string }> {
  let fetchError: string | undefined;
  try {
    await exec("git", ["-C", repo, "fetch", "--quiet", "origin", baseBranch], { timeoutMs: 120_000 });
  } catch (error) {
    fetchError = failureText(error);
  }
  // made already by this very plan (the server stopped right after): go on with it
  try {
    const branch = (await exec("git", ["-C", plan.path, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 30_000 })).trim();
    const top = (await exec("git", ["-C", plan.path, "rev-parse", "--show-toplevel"], { timeoutMs: 30_000 })).trim();
    if (branch === plan.branch && top === plan.path) {
      const head = (await exec("git", ["-C", plan.path, "rev-parse", "HEAD"], { timeoutMs: 30_000 })).trim();
      return { ok: true, head, ...(fetchError ? { fetchError } : {}) };
    }
  } catch { /* not there yet */ }
  try {
    await exec("git", ["-C", repo, "worktree", "add", "--no-track", "-b", plan.branch, plan.path, `origin/${baseBranch}`], { timeoutMs: 300_000 });
    const head = (await exec("git", ["-C", plan.path, "rev-parse", "HEAD"], { timeoutMs: 30_000 })).trim();
    return { ok: true, head, ...(fetchError ? { fetchError } : {}) };
  } catch (error) {
    return { ok: false, error: `git worktree add: ${failureText(error)}${fetchError ? ` (e o fetch de origin/${baseBranch} falhou: ${fetchError})` : ""}` };
  }
}

/** The alias the app is given for a worktree:
 * `<repo's parent>/.omb-worktree-links/<repo>/<dir>` (~/Projetos/… for
 * nuria-platform). Two rules place it:
 * - the app's link claude://code/new?folder=… maps any folder inside
 *   `.claude/worktrees/` back to its repository root (appLinkFolder), which
 *   would put the session in the main checkout, so it lives outside that;
 * - next to the repository, so a cwd the app reports through the alias is
 *   still under ~/Projetos, where the review hook (~/.laya, dual-review.cjs:
 *   `cwd.startsWith(~/Projetos/)`) reviews every command — never in the data
 *   dir, which that hook would treat as out of scope (INSP-X r1 X1-2). */
export const ownLinkPath = (repo: string, dir: string) => join(dirname(repo), OWN_LINK_DIR, basename(repo), dir);

/** The folder the Claude app opens for claude://code/new?folder=<path>: its
 * own rule, copied from Claude 2.19675 (app.asar, .vite/build/
 * index.chunk-BZdcw7TE.js, `vIn`, used as `vIn(e)??e`): a path with a
 * `.claude/worktrees/<something>` segment pair (case folded) becomes the
 * folder before `.claude`. */
export function appLinkFolder(path: string): string {
  if (!path.startsWith("/")) return path;
  const parts = path.split("/");
  for (let i = 1; i + 2 < parts.length; i++) {
    if (parts[i]!.toLowerCase() === ".claude" && parts[i + 1]!.toLowerCase() === "worktrees") return parts.slice(0, i).join("/") || "/";
  }
  return path;
}

/** Make (or keep) the alias `link` → `target`. Null when done, else why not. */
export function ensureLink(link: string, target: string): string | null {
  try {
    mkdirSync(dirname(link), { recursive: true });
    let stat: ReturnType<typeof lstatSync> | null = null;
    try { stat = lstatSync(link); } catch { /* not there yet */ }
    if (stat) return stat.isSymbolicLink() && readlinkSync(link) === target ? null : `${link} já existe e não aponta para ${target}`;
    symlinkSync(target, link, "dir");
    return null;
  } catch (error) {
    return failureText(error);
  }
}

/** A folder an app record names, the alias resolved to the worktree it
 * stands for — every check of folders (reuse, root, adoption) compares the
 * worktree itself. Anything else is returned as it is. */
export function canonicalFolder(path: string): string {
  if (!path.includes(`/${OWN_LINK_DIR}/`)) return path;
  try {
    const target = readlinkSync(path);
    return target.startsWith("/") ? target : join(dirname(path), target);
  } catch {
    return path;
  }
}

// ── the seed and the clone ─────────────────────────────────────────────────

export interface SeedState {
  repo: string;
  path: string;
  state: "missing" | "installing" | "ready" | "failed" | "interrupted" | "waiting";
  /** Why it is not ready (pt-BR), when it is not. */
  reason?: string;
  /** The lockfile installed, and its hash. */
  lockName?: string;
  lockHash?: string;
  /** `node --version` the install ran with: native modules are built for it. */
  node?: string;
  head?: string;
  /** The cache folders, relative to the repository, and their size (KiB). */
  dirs?: Array<{ path: string; kb: number }>;
  installedAt?: number;
  /** How long the seed's install took: what each clone spares a session. */
  installMs?: number;
  checkedAt?: number;
  /** Where git looks for hooks, relative to the seed, when that is inside the
   * checkout (".husky/_", made by the install): cloned with the caches. */
  hooks?: string;
  /** An install that left no hooks is not tried again before this, for the same lockfile. */
  retryAfter?: number;
  failedLock?: string;
}

export const lockHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export interface CloneOutcome {
  mode: "cloned" | "install";
  /** Why the caches were not cloned (pt-BR). */
  reason?: string;
  /** The folders cloned (or found cloned already, after a restart), relative to the repository. */
  dirs: string[];
  /** What a full copy (or an install) would have written, in KiB. */
  savedKb: number;
  /** The seed's install time each clone spares, in ms. */
  savedMs: number;
  ms: number;
  /** The repository's own install, as the session is told to run it ("npm ci", "pnpm install --frozen-lockfile"). */
  install: string;
  /** The hooks folder found in the worktree and checked against the main checkout's, when cloned. */
  hooks?: string;
}

/** Where git looks for hooks in `folder` (absolute), or null. */
export async function hooksFolder(folder: string, exec: Exec): Promise<string | null> {
  try {
    return (await exec("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-path", "hooks"], { timeoutMs: 30_000 })).trim() || null;
  } catch {
    return null;
  }
}

/** Why the worktree's git hooks are not the main checkout's (pt-BR), or null
 * when they are: the folder git looks in exists, and has every hook the main
 * checkout has. A hooks folder made by the install (husky 9's `.husky/_`,
 * ignored by git) that did not come with the clone leaves the worktree with
 * no hooks at all, silently (INSP-X r1 X1-1). */
export async function hooksProblem(worktree: string, repo: string, io: Pick<CloneIo, "hooks" | "listDir" | "realpath">): Promise<{ problem: string } | { folder: string }> {
  const here = await io.hooks(worktree);
  if (!here) return { problem: "não consegui ler onde ficam os hooks do git desta worktree" };
  const roots = [worktree, io.realpath(worktree)];
  const root = roots.find((each) => here.startsWith(`${each}/`));
  const name = root ? here.slice(root.length + 1) : here;
  const list = io.listDir(here);
  if (root && list === null) return { problem: `os hooks do git (${name}) não vieram com o clone: sem eles nenhum hook roda nesta worktree` };
  const main = await io.hooks(repo);
  const mainList = main ? io.listDir(main) : null;
  const missing = (mainList ?? []).filter((hook) => !(list ?? []).includes(hook));
  if (missing.length) return { problem: `faltam hooks do git em ${name} (${missing.slice(0, 5).join(", ")}), que o checkout principal tem` };
  return { folder: name };
}

export interface CloneIo {
  exec: Exec;
  now: () => number;
  /** A file's text, or null. */
  readFile: (path: string) => string | null;
  exists: (path: string) => boolean;
  /** The volume a path is on, or null. */
  device: (path: string) => number | null;
  /** Clone one file and prove it shares the original's blocks. Null when it does, else why not. */
  cloneFile: (src: string, dst: string) => Promise<string | null>;
  rename: (from: string, to: string) => void;
  /** Take back a temporary copy this clone made (never a worktree). */
  dropTemp: (path: string) => void;
  /** `node --version` now, or null. */
  node: () => Promise<string | null>;
  /** Where git looks for hooks in a folder (hooksFolder). */
  hooks: (folder: string) => Promise<string | null>;
  /** A folder's entries, or null when it is not there. */
  listDir: (path: string) => string[] | null;
  realpath: (path: string) => string;
  /** A file inside a cache folder (relative) to tell a clone of it by its blocks, or null. */
  sample: (dir: string) => string | null;
  /** Whether two files share their blocks (one is a clone of the other); null when it cannot be told. */
  sameBlocks: (a: string, b: string) => Promise<boolean | null>;
}

/** The first of `lockfiles` the folder has: its name and hash. */
export function lockOf(folder: string, lockfiles: readonly string[], readFile: CloneIo["readFile"]): { name: string; hash: string } | null {
  for (const name of lockfiles) {
    const text = readFile(join(folder, name));
    if (text !== null) return { name, hash: lockHash(text) };
  }
  return null;
}

const CLONE_PROBE = ".omb-clone-probe";

/** Clone the seed's caches into a new worktree, or say why not (then the
 * session installs them as before). Each folder is cloned to a temporary
 * name and renamed once whole, so a session never sees half a node_modules.
 * A folder already there that shares its blocks with the seed's is a clone
 * a stopped server made: counted, never redone nor installed over. The
 * clone counts only when the worktree then has the main checkout's git
 * hooks; otherwise the session installs (the install makes them). */
export async function cloneSeedCaches(seed: SeedState | undefined, worktree: string, lockfiles: readonly string[], io: CloneIo): Promise<CloneOutcome> {
  const started = io.now();
  const lock = lockOf(worktree, lockfiles, io.readFile);
  // what the session runs is the repository's own install, by its lockfile (a setting only changes how the seed installs)
  const install = installText(lock?.name ?? seed?.lockName);
  const fallback = (reason: string): CloneOutcome => ({ mode: "install", reason, dirs: [], savedKb: 0, savedMs: 0, ms: io.now() - started, install });
  if (!seed || seed.state !== "ready" || !seed.lockHash || !seed.dirs?.length) {
    return fallback(`a semente de dependências ainda não está pronta (${seed ? seed.reason ?? seed.state : "nunca instalada"})`);
  }
  if (!lock) return fallback(`a branch não tem lockfile (${lockfiles.join(", ")})`);
  if (seed.hooks && !seed.dirs.some((dir) => dir.path === seed.hooks)) return fallback(`a semente não tem os hooks do git (${seed.hooks}) entre as pastas que clona`);
  if (lock.name !== seed.lockName || lock.hash !== seed.lockHash) {
    return fallback(`o ${lock.name} desta branch (${lock.hash.slice(0, 8)}) não é o da semente (${seed.lockName ?? "?"} ${seed.lockHash.slice(0, 8)}): a semente é de outro commit de origin/main`);
  }
  const node = await io.node();
  if (seed.node && node !== seed.node) return fallback(`o Node mudou (${node ?? "?"}; a semente foi instalada com ${seed.node}): módulos nativos não serviriam`);
  const seedDevice = io.device(seed.path);
  const device = io.device(worktree);
  if (seedDevice === null || device === null || seedDevice !== device) return fallback("a semente e a worktree não estão no mesmo volume: o clone copiaria tudo");
  // one file first, proved shared: where the volume cannot clone, cp -c
  // falls back to a full copy on its own (man cp) and would fill the disk
  const probe = join(worktree, CLONE_PROBE);
  const cannot = await io.cloneFile(join(seed.path, seed.lockName!), probe);
  io.dropTemp(probe);
  if (cannot) return fallback(`o volume não clona arquivos (não é APFS?): ${cannot}`);
  const cloned: string[] = [];
  let savedKb = 0;
  for (const dir of seed.dirs) {
    const target = join(worktree, dir.path);
    if (!io.exists(dirname(target))) continue; // a workspace this branch does not have
    if (io.exists(target)) {
      // never over what is there; a clone of the seed (same blocks) counts as done
      const sample = io.sample(join(seed.path, dir.path));
      if (sample && (await io.sameBlocks(join(seed.path, dir.path, sample), join(target, sample))) === true) {
        cloned.push(dir.path);
        savedKb += dir.kb;
      }
      continue;
    }
    const temp = `${target}.omb-clone`;
    // a copy a stopped server left half made: cp -R into it would nest
    io.dropTemp(temp);
    try {
      await io.exec("/usr/bin/nice", ["-n", "10", "/bin/cp", "-c", "-R", join(seed.path, dir.path), temp], { timeoutMs: 15 * 60_000 });
      io.rename(temp, target);
    } catch (error) {
      io.dropTemp(temp);
      return { ...fallback(`o clone de ${dir.path} falhou: ${failureText(error)}`), dirs: cloned };
    }
    cloned.push(dir.path);
    savedKb += dir.kb;
  }
  if (!cloned.length) return fallback("nenhuma pasta de dependências da semente cabe nesta branch");
  // the hooks git runs here must be the main checkout's: or the session installs (which makes them)
  const hooks = await hooksProblem(worktree, seed.repo, io);
  if ("problem" in hooks) return { ...fallback(hooks.problem), dirs: cloned };
  return { mode: "cloned", dirs: cloned, savedKb, savedMs: seed.installMs ?? 0, ms: io.now() - started, install, hooks: hooks.folder };
}

/** The cache folders of a checkout: every folder named in `names` up to
 * three levels down (the root's node_modules and each workspace's), never
 * inside another one, plus the extra folders it has. Relative paths. */
export function findCacheDirs(root: string, names: readonly string[], extra: readonly string[], fs: { list: (path: string) => string[]; isDir: (path: string) => boolean }): string[] {
  const found: string[] = [];
  const skip = new Set([".git", ".claude", ...names]);
  const walk = (relative: string, depth: number) => {
    let entries: string[];
    try { entries = fs.list(relative ? join(root, relative) : root); } catch { return; }
    for (const name of entries.sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (!fs.isDir(join(root, path))) continue;
      if (names.includes(name)) { found.push(path); continue; }
      if (depth < 3 && !skip.has(name) && !name.startsWith(".")) walk(path, depth + 1);
    }
  };
  walk("", 1);
  for (const path of extra) if (!found.includes(path) && fs.isDir(join(root, path))) found.push(path);
  return found;
}

export interface SeedDeps {
  exec: Exec;
  now: () => number;
  /** A production release on its way (or the admission state unreadable): its words; null when the machine is free of releases. */
  releaseBusy: () => Promise<string | null>;
  /** Free bytes on the repository's volume, or null. */
  freeBytes: (path: string) => number | null;
  readFile: CloneIo["readFile"];
  exists: (path: string) => boolean;
  findDirs: (seedPath: string, settings: OwnWorktreeSettings) => string[];
  /** Size of a folder in KiB (du -sk), or null. */
  sizeKb: (path: string) => Promise<number | null>;
  node: () => Promise<string | null>;
  log: (line: string) => void;
  save: (seed: SeedState) => void;
  /** Why the seed may not change now (a worktree being cloned from it), or null. */
  mayInstall?: () => string | null;
  /** Where git looks for hooks in a folder (hooksFolder). */
  hooks: (folder: string) => Promise<string | null>;
  /** How often a running install looks for a release that started meanwhile. */
  pollMs?: number;
}

const GIB = 1024 ** 3;
/** An install that left no git hooks is tried again after this (same lockfile): HUSKY=0 does not pass by itself. */
export const SEED_HOOKS_RETRY_MS = 6 * 3_600_000;

/** The seed's hooks folder relative to it, when git keeps hooks inside the
 * checkout (husky's `.husky/_`); undefined when they are shared (.git/hooks). */
async function seedHooks(path: string, deps: Pick<SeedDeps, "hooks">): Promise<string | undefined> {
  const found = await deps.hooks(path);
  if (!found) return undefined;
  for (const root of [path, (() => { try { return realpathSync(path); } catch { return path; } })()]) {
    if (found.startsWith(`${root}/`)) return found.slice(root.length + 1);
  }
  return undefined;
}

/** Bring the seed of `repo` to origin/<base>: made the first time (a locked,
 * detached worktree), installed again only when origin/<base>'s lockfile
 * (or the Node) is not the one installed, or its git hooks are missing.
 * Never with a release on its way, never on a nearly full disk; an install
 * a release meets is stopped. An install that leaves no hooks (HUSKY=0, a
 * failed prepare) makes the seed unusable: clones from it would run no
 * hooks. A ready seed from an older build is brought to today's folders. */
export async function refreshSeed(repo: string, settings: OwnWorktreeSettings, previous: SeedState | undefined, deps: SeedDeps, baseBranch = "main"): Promise<SeedState> {
  const path = join(repo, SEED_DIR);
  let seed: SeedState = { ...(previous ?? { repo, path, state: "missing" as const }), repo, path, checkedAt: deps.now() };
  const keep = (state: SeedState["state"], reason?: string): SeedState => {
    // a seed that was ready stays usable while a refresh waits: its lockfile still tells which branches it serves
    const usable = previous?.state === "ready" && state === "waiting" && deps.exists(join(path, ".git"));
    seed = { ...seed, state: usable ? "ready" : state, ...(reason ? { reason } : {}) };
    if (!reason) delete seed.reason;
    if (usable && reason) seed.reason = `pronta (${previous?.lockHash?.slice(0, 8)}); a atualização espera: ${reason}`;
    deps.save(seed);
    return seed;
  };
  const busy = await deps.releaseBusy();
  if (busy) return keep("waiting", `não atualizo a semente com um release na máquina (${busy})`);
  try {
    await deps.exec("git", ["-C", repo, "fetch", "--quiet", "origin", baseBranch], { timeoutMs: 120_000 });
  } catch (error) {
    deps.log(`seed of ${repo}: fetch failed (${failureText(error)}); using the last known origin/${baseBranch}`);
  }
  let wanted: { name: string; hash: string } | null = null;
  for (const name of settings.lockfiles) {
    try {
      wanted = { name, hash: lockHash(await deps.exec("git", ["-C", repo, "show", `origin/${baseBranch}:${name}`], { timeoutMs: 60_000 })) };
      break;
    } catch { /* not this one */ }
  }
  if (!wanted) return keep("failed", `origin/${baseBranch} não tem lockfile (${settings.lockfiles.join(", ")})`);
  const node = await deps.node();
  const install = installFor(wanted.name, settings);
  const same = previous?.lockName === wanted.name && previous.lockHash === wanted.hash && previous.node === node && deps.exists(join(path, ".git"));
  if (same && previous?.state === "ready") {
    // ready for this lockfile: its hooks must still be there, and its folders today's (an older build listed fewer)
    const hooks = await seedHooks(path, deps);
    if (!hooks || deps.exists(join(path, hooks))) {
      const known = new Set((previous.dirs ?? []).map((dir) => dir.path));
      const wantedDirs = [...new Set([...deps.findDirs(path, settings), ...(hooks ? [hooks] : [])])];
      const added = wantedDirs.filter((dir) => !known.has(dir));
      if (added.length || previous.hooks !== hooks) {
        const dirs = [...(previous.dirs ?? [])];
        for (const dir of added) dirs.push({ path: dir, kb: (await deps.sizeKb(join(path, dir))) ?? 0 });
        seed = { ...seed, dirs, ...(hooks ? { hooks } : {}) };
        if (!hooks) delete seed.hooks;
        deps.log(`seed of ${repo}: brought to today's folders (${added.join(", ") || "hooks"})`);
      }
      return keep("ready");
    }
    deps.log(`seed of ${repo}: its git hooks (${hooks}) are gone; installing again`);
  }
  // an install that left no hooks, for this very lockfile: not every 30 min
  if (previous?.state === "failed" && previous.failedLock === wanted.hash && (previous.retryAfter ?? 0) > deps.now()) return keep("failed", previous.reason);
  const free = deps.freeBytes(repo);
  if (free !== null && free < settings.minFreeGiB * GIB) {
    return keep("waiting", `só ${(free / GIB).toFixed(1).replace(".", ",")} GiB livres; instalo a semente com ${settings.minFreeGiB} GiB ou mais`);
  }
  const held = deps.mayInstall?.() ?? null;
  if (held) return keep("waiting", held);
  // from here on no clone is taken from it (its folders are about to change),
  // said before the first await so a clone starting meanwhile sees it
  seed = { ...seed, state: "installing", reason: `instalando ${wanted.name} ${wanted.hash.slice(0, 8)}` };
  delete seed.dirs;
  deps.save(seed);
  try {
    if (!deps.exists(join(path, ".git"))) {
      await deps.exec("git", ["-C", repo, "worktree", "add", "--detach", path, `origin/${baseBranch}`], { timeoutMs: 300_000 });
      await deps.exec("git", ["-C", repo, "worktree", "lock", "--reason", SEED_LOCK_REASON, path], { timeoutMs: 30_000 });
      deps.log(`seed of ${repo}: made ${path} (locked: ${SEED_LOCK_REASON})`);
    } else {
      // the seed is the server's own cache, never anyone's work: what an
      // install left in its tracked files gives way to origin/<base>
      await deps.exec("git", ["-C", path, "checkout", "--quiet", "--force", "--detach", `origin/${baseBranch}`], { timeoutMs: 300_000 });
    }
  } catch (error) {
    return keep("failed", `não consegui preparar ${path}: ${failureText(error)}`);
  }
  const controller = new AbortController();
  let stoppedFor: string | null = null;
  const watch = setInterval(() => {
    void deps.releaseBusy().then((why) => {
      if (why && !stoppedFor) {
        stoppedFor = why;
        controller.abort();
      }
    }).catch(() => {});
  }, deps.pollMs ?? 30_000);
  const started = deps.now();
  try {
    deps.log(`seed of ${repo}: ${install.join(" ")} (nice) for ${wanted.name} ${wanted.hash.slice(0, 8)}`);
    await deps.exec("/usr/bin/nice", ["-n", "15", ...install], { cwd: path, timeoutMs: 45 * 60_000, signal: controller.signal });
  } catch (error) {
    clearInterval(watch);
    if (stoppedFor) return keep("interrupted", `parei a instalação da semente: um release começou (${stoppedFor}); volto depois dele`);
    return keep("failed", `${install.join(" ")} falhou na semente: ${failureText(error)}`);
  }
  clearInterval(watch);
  if (stoppedFor) return keep("interrupted", `parei a instalação da semente: um release começou (${stoppedFor}); volto depois dele`);
  const installed = lockOf(path, settings.lockfiles, deps.readFile);
  // where git looks for hooks there, when the install is what makes them (husky's .husky/_)
  const hooks = await seedHooks(path, deps);
  if (hooks && !deps.exists(join(path, hooks))) {
    seed = { ...seed, failedLock: wanted.hash, retryAfter: deps.now() + SEED_HOOKS_RETRY_MS };
    return keep("failed", `${install.join(" ")} terminou sem criar os hooks do git (${hooks}) — HUSKY=0 ou o prepare falhou; a semente não serve, porque as worktrees clonadas dela não rodariam hook nenhum. Tento de novo em ${SEED_HOOKS_RETRY_MS / 3_600_000} h ou quando o lockfile mudar`);
  }
  const dirs: Array<{ path: string; kb: number }> = [];
  for (const dir of new Set([...deps.findDirs(path, settings), ...(hooks ? [hooks] : [])])) dirs.push({ path: dir, kb: (await deps.sizeKb(join(path, dir))) ?? 0 });
  let head: string | undefined;
  try { head = (await deps.exec("git", ["-C", path, "rev-parse", "HEAD"], { timeoutMs: 30_000 })).trim(); } catch { /* unknown */ }
  if (!installed || !dirs.length) return keep("failed", !installed ? "a semente ficou sem lockfile depois de instalar" : "a instalação não deixou nenhuma pasta de dependências na semente");
  seed = { ...seed, state: "ready", lockName: installed.name, lockHash: installed.hash, ...(node ? { node } : {}), ...(head ? { head } : {}), dirs, ...(hooks ? { hooks } : {}), installedAt: deps.now(), installMs: deps.now() - started };
  if (!hooks) delete seed.hooks;
  delete seed.reason;
  delete seed.retryAfter;
  delete seed.failedLock;
  deps.save(seed);
  deps.log(`seed of ${repo}: ready at ${head?.slice(0, 9) ?? "?"} (${installed.name} ${installed.hash.slice(0, 8)}, ${dirs.length} folder(s), ${Math.round(dirs.reduce((sum, dir) => sum + dir.kb, 0) / 1024)} MiB, ${Math.round((seed.installMs ?? 0) / 1000)} s)`);
  return seed;
}

/** Where a file's first block sits on the device (fcntl F_LOG2PHYS = 49;
 * struct log2phys is packed: u32 flags, off_t contigbytes, off_t
 * devoffset), as hex; null when it cannot be read. Two files with the same
 * offset share their blocks: one is a clone of the other. */
export async function physicalOffset(path: string, exec: Exec): Promise<string | null> {
  try {
    const out = (await exec("/usr/bin/perl", ["-e", 'open(my $f, "<", $ARGV[0]) or die "open: $!"; my $b = pack("Lqq", 0, 0, 0); fcntl($f, 49, $b) or die "fcntl: $!"; print unpack("H*", substr($b, 12, 8));', path], { timeoutMs: 15_000 })).trim();
    return /^[0-9a-f]{16}$/.test(out) && !/^0+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** statfs's type for APFS on macOS. */
const APFS_TYPE = 26;

/** The real filesystem side of a clone. */
export function realCloneIo(exec: Exec, node: () => Promise<string | null>): CloneIo {
  return {
    exec,
    now: Date.now,
    readFile: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
    exists: existsSync,
    device: (path) => { try { return statSync(path).dev; } catch { return null; } },
    // Node's COPYFILE_FICLONE_FORCE is ENOSYS on macOS, and cp -c copies
    // when it cannot clone: clone with cp -c, then check the blocks
    cloneFile: async (src, dst) => {
      try {
        await exec("/bin/cp", ["-c", src, dst], { timeoutMs: 60_000 });
      } catch (error) {
        return failureText(error);
      }
      const [from, to] = [await physicalOffset(src, exec), await physicalOffset(dst, exec)];
      if (from && to) return from === to ? null : "cp -c fez uma cópia comum, não um clone";
      // the blocks could not be read (no perl): APFS on the same volume clones
      try {
        return statfsSync(dst).type === APFS_TYPE ? null : `não deu para confirmar o clone e o volume não é APFS (tipo ${statfsSync(dst).type})`;
      } catch (error) {
        return failureText(error);
      }
    },
    rename: renameSync,
    dropTemp: (path) => rmSync(path, { recursive: true, force: true }),
    node,
    hooks: (folder) => hooksFolder(folder, exec),
    listDir: (path) => { try { return readdirSync(path); } catch { return null; } },
    realpath: (path) => { try { return realpathSync(path); } catch { return path; } },
    sample: (dir) => sampleFile(dir),
    sameBlocks: async (a, b) => {
      const [from, to] = [await physicalOffset(a, exec), await physicalOffset(b, exec)];
      return from && to ? from === to : null;
    },
  };
}

/** A regular file of a cache folder to compare blocks with (npm's
 * `.package-lock.json` first), found within a few levels; relative, or null. */
export function sampleFile(dir: string): string | null {
  const isFile = (path: string) => { try { return lstatSync(path).isFile(); } catch { return false; } };
  if (isFile(join(dir, ".package-lock.json"))) return ".package-lock.json";
  const queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
  for (let seen = 0; queue.length && seen < 200; seen++) {
    const { rel, depth } = queue.shift()!;
    let names: string[];
    try { names = readdirSync(rel ? join(dir, rel) : dir).sort(); } catch { continue; }
    for (const name of names) {
      const path = rel ? `${rel}/${name}` : name;
      if (isFile(join(dir, path))) return path;
    }
    if (depth < 4) for (const name of names) queue.push({ rel: rel ? `${rel}/${name}` : name, depth: depth + 1 });
  }
  return null;
}

/** The real filesystem side of findCacheDirs. */
export const realDirFs = {
  list: (path: string) => readdirSync(path),
  isDir: (path: string) => { try { return lstatSync(path).isDirectory(); } catch { return false; } },
};

// ── what each session's brief is told ─────────────────────────────────────

/** The line about dependencies in the brief of a session in its own worktree. */
export function cacheLine(outcome: Pick<CloneOutcome, "mode" | "reason"> & { dirs?: string[]; install?: string; hooks?: string }): string {
  const install = outcome.install ?? "npm ci";
  // "não instale" only with the hooks checked: a clone without them is an install (cloneSeedCaches)
  if (outcome.mode === "cloned" && outcome.hooks) {
    return `As dependências já estão instaladas nesta worktree: ${(outcome.dirs ?? []).join(", ")} foram clonadas de uma cópia atualizada de origin/main, com o mesmo lockfile, e os hooks do git (${outcome.hooks}) foram conferidos com os do checkout principal. Não rode \`${install}\` no começo; só rode se um comando falhar por dependência faltando.`;
  }
  const why = outcome.mode === "cloned" ? "os hooks do git não foram conferidos" : outcome.reason ?? "motivo desconhecido";
  return `As dependências NÃO foram clonadas (${why}): rode \`${install}\` nesta worktree antes de testar, buildar ou commitar — ele também instala os hooks do git.`;
}

// ── what was saved: the ledger behind the metrics and the report ──────────

export interface OwnEvent {
  at: number;
  sessionId: string;
  repo: string;
  path: string;
  branch: string;
  /** cloned: caches cloned; install: the session installs them (reason); failed: no worktree was made (reason). */
  mode: "cloned" | "install" | "failed";
  reason?: string;
  savedKb?: number;
  savedMs?: number;
  cloneMs?: number;
}

export interface OwnSummary {
  /** Worktrees the server made in the period. */
  created: number;
  cloned: number;
  installed: number;
  failed: number;
  /** Disk a copy (or an install) would have written, KiB. */
  savedKb: number;
  /** Install time spared, ms (the seed's own install time, per clone). */
  savedMs: number;
  /** Why the caches were not cloned (or no worktree made), most frequent first. */
  reasons: Array<{ reason: string; count: number }>;
  seeds: Array<Pick<SeedState, "repo" | "state" | "reason" | "head" | "lockHash" | "installedAt" | "installMs"> & { kb: number }>;
}

/** The reason without what changes from one time to the next (hashes, sizes). */
const reasonKind = (reason: string) => reason.replace(/\b[0-9a-f]{8,}\b/g, "…").replace(/\d+(?:[.,]\d+)?\s*GiB/g, "N GiB").slice(0, 160);

export function ownSummary(events: readonly OwnEvent[], seeds: readonly SeedState[], from: number, to: number): OwnSummary {
  const inside = events.filter((event) => event.at >= from && event.at < to);
  const reasons = new Map<string, number>();
  for (const event of inside) if (event.reason && event.mode !== "cloned") reasons.set(reasonKind(event.reason), (reasons.get(reasonKind(event.reason)) ?? 0) + 1);
  return {
    created: inside.filter((event) => event.mode !== "failed").length,
    cloned: inside.filter((event) => event.mode === "cloned").length,
    installed: inside.filter((event) => event.mode === "install").length,
    failed: inside.filter((event) => event.mode === "failed").length,
    // only a clone saves anything
    savedKb: inside.reduce((sum, event) => sum + (event.mode === "cloned" ? event.savedKb ?? 0 : 0), 0),
    savedMs: inside.reduce((sum, event) => sum + (event.mode === "cloned" ? event.savedMs ?? 0 : 0), 0),
    reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    seeds: seeds.map((seed) => ({ repo: seed.repo, state: seed.state, ...(seed.reason ? { reason: seed.reason } : {}), ...(seed.head ? { head: seed.head } : {}), ...(seed.lockHash ? { lockHash: seed.lockHash } : {}), ...(seed.installedAt ? { installedAt: seed.installedAt } : {}), ...(seed.installMs ? { installMs: seed.installMs } : {}), kb: (seed.dirs ?? []).reduce((sum, dir) => sum + dir.kb, 0) })),
  };
}

/** "2,3 GB e ~14 min": what a clone spared. */
export function savedText(kb: number, ms: number): string {
  const size = kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1).replace(".", ",")} GB` : `${Math.max(1, Math.round(kb / 1024))} MB`;
  return ms >= 60_000 ? `${size} e ~${Math.round(ms / 60_000)} min` : size;
}

export const OWN_EVENTS_MAX = 2_000;

/** The seeds and the per-worktree events, kept in one file of the data dir. */
export class OwnWorktreeStore {
  private seeds: Record<string, SeedState> = {};
  private events: OwnEvent[] = [];
  private readonly path: string | null;

  constructor(path: string | null) {
    this.path = path;
    if (!path) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { seeds?: Record<string, SeedState>; events?: OwnEvent[] };
      if (raw.seeds && typeof raw.seeds === "object") this.seeds = raw.seeds;
      if (Array.isArray(raw.events)) this.events = raw.events.filter((event) => event && typeof event.at === "number");
      // an install the server was running when it stopped did not finish
      for (const seed of Object.values(this.seeds)) {
        if (seed.state === "installing") { seed.state = "interrupted"; seed.reason = "o servidor parou durante a instalação da semente; ela é refeita"; }
      }
    } catch { /* first run, or unreadable: start empty */ }
  }

  private save(): void {
    if (!this.path) return;
    try {
      writeFileAtomic(this.path, `${JSON.stringify({ seeds: this.seeds, events: this.events }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      console.error(`[own-worktrees] could not save ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  seed(repo: string): SeedState | undefined { return this.seeds[repo]; }
  allSeeds(): SeedState[] { return Object.values(this.seeds); }
  setSeed(seed: SeedState): void { this.seeds[seed.repo] = seed; this.save(); }
  record(event: OwnEvent): void {
    this.events = [...this.events, event].slice(-OWN_EVENTS_MAX);
    this.save();
  }
  allEvents(): readonly OwnEvent[] { return this.events; }
  summary(from: number, to: number): OwnSummary { return ownSummary(this.events, this.allSeeds(), from, to); }
}

// ── the breaker: the app keeps opening the sessions elsewhere ─────────────
// A session opened through the alias that the app put in another folder
// (one it made itself with its worktree option on, the root, another
// worktree) stops at its folder check and fails. Two in a row in the same
// repository and the server stops using this path there: the owner gets
// one item with the diagnosis, and the starts go the old way (New Session,
// its 409 and gesture) until a create works or the owner resolves the item
// (R11-dispatch R11-1).

export const OWN_BREAKER_FAILURES = 2;

/** `chip`: the session never opened — its worktree option read ON or
 * unreadable, so nothing was typed (R12-1); `folder` is then empty. */
export interface OwnFailure { at: number; sessionId: string; title: string; folder: string; expected: string; chip?: "on" | "unknown"; seen?: string }
export interface OwnBreakerRepo { failures: OwnFailure[]; trippedAt?: number; itemId?: string }
export interface OwnBreakerState { repos: Record<string, OwnBreakerRepo> }

export const ownBreakerTripped = (state: OwnBreakerState, repo: string) => state.repos[repo]?.trippedAt !== undefined;

/** A failure of the path in `repo`: the new state, and whether this one tripped it. */
export function noteOwnFailure(state: OwnBreakerState, repo: string, failure: OwnFailure): { state: OwnBreakerState; tripped: boolean } {
  const before = state.repos[repo] ?? { failures: [] };
  const failures = [...before.failures.filter((each) => each.sessionId !== failure.sessionId), failure].slice(-5);
  const trips = before.trippedAt === undefined && failures.length >= OWN_BREAKER_FAILURES;
  return { state: { repos: { ...state.repos, [repo]: { ...before, failures, ...(trips ? { trippedAt: failure.at } : {}) } } }, tripped: trips };
}

/** The key the breaker keeps a repository by: its real path, so a session that
 * names it through a symlink trips and rearms what the path check reads
 * (INSP-R11fix F-3). The path as given when it cannot be resolved. */
export function breakerRepo(repo: string, realpath: (path: string) => string = realpathSync): string {
  try { return realpath(repo); } catch { return repo; }
}

/** Rearmed: a create that worked, or the owner's item resolved. */
export function rearmOwnBreaker(state: OwnBreakerState, repo: string): OwnBreakerState {
  if (!state.repos[repo]) return state;
  const repos = { ...state.repos };
  delete repos[repo];
  return { repos };
}

/** What happened to one failure, in words: the app's own worktree inside or beside ours means its worktree option was on. */
export function ownFailureCause(failure: Pick<OwnFailure, "folder" | "expected" | "chip" | "seen">, repo: string): string {
  if (failure.chip) return `a opção worktree estava ${failure.chip === "on" ? "LIGADA" : "ilegível"} na sessão nova${failure.seen ? ` (a tela mostrou: ${failure.seen.slice(0, 120)})` : ""}; nada foi colado — desligue-a antes de abrir sessão`;
  if (failure.folder.startsWith(`${failure.expected}/`)) return `o app criou uma worktree própria dentro da pasta do OMB (${failure.folder}): a opção worktree estava LIGADA`;
  if (failure.folder === repo) return "o app abriu na raiz do repositório, não na pasta do OMB";
  if (failure.folder.includes("/.claude/worktrees/")) return `o app abriu em outra worktree (${failure.folder}), não na do OMB: a opção worktree estava LIGADA, ou o app reaproveitou uma pasta`;
  return `o app abriu em ${failure.folder}, não na pasta do OMB`;
}

/** The owner's item when the breaker trips. */
export function ownBreakerItem(repo: string, failures: readonly OwnFailure[]): { title: string; why: string; steps: Array<{ text: string }> } {
  const name = basename(repo);
  const chipOnly = failures.every((each) => each.chip);
  return {
    title: chipOnly
      ? `O app Claude abriu ${failures.length} sessões de ${name} com a opção worktree LIGADA ou ilegível: desligue-a antes de abrir sessão (o servidor já cria a pasta)`
      : `O app Claude abriu ${failures.length} sessões de ${name} fora da worktree que o servidor criou: deixe a opção worktree DESLIGADA para sessões novas`,
    why: [
      chipOnly
        ? `As sessões novas de ${name} abrem numa worktree que o servidor cria, pelo link do próprio app, e só com a opção worktree desligada. Nas últimas ${failures.length}, a opção estava ligada ou não deu para lê-la, e nada foi colado:`
        : `As sessões novas de ${name} abrem numa worktree que o servidor cria, pelo link do próprio app. As últimas ${failures.length} não ficaram nela (ou nem abriram, com a opção worktree ligada), sem mexer em nada:`,
      ...failures.map((each) => `- "${each.title.slice(0, 60)}": ${ownFailureCause(each, repo)}`),
      "Até você resolver este item, as sessões novas vão pelo jeito antigo (Nova sessão), com o 409 e o gesto de sempre. As worktrees criadas ficam como estão (o servidor nunca remove) e aparecem no relatório de disco.",
    ].join("\n"),
    steps: [
      { text: "No app Claude, abra uma sessão nova (Arquivo → Nova sessão) e veja o chip “worktree” ao lado da pasta." },
      { text: "Deixe-o DESLIGADO e feche sem enviar nada: a pasta das sessões do servidor já é a worktree." },
      { text: "Resolva este item: o servidor volta a criar a worktree e abrir o app nela. Se falhar de novo duas vezes, este item volta com o que a tela mostrou." },
    ],
  };
}

// ── the worktrees of sessions that did not use them: told, never removed ──

export interface LeftWorktree { path: string; repo: string; sessionId: string; title: string; why: "failed" | "unused"; command: string }

const quote = (value: string) => (/^[\w./@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** The server's worktrees whose session failed, or that the session never
 * used (it went the old way): for the disk report, with the command a
 * person runs. Nothing here removes anything. */
export function leftOwnWorktrees(sessions: ReadonlyArray<{ id: string; title: string; repo: string; status: string; desktop?: { own?: { path: string; state: string } } }>, exists: (path: string) => boolean): LeftWorktree[] {
  const out: LeftWorktree[] = [];
  for (const session of sessions) {
    const own = session.desktop?.own;
    if (!own || !exists(own.path)) continue;
    const why = session.status === "failed" ? "failed" as const : own.state === "abandoned" || own.state === "failed" ? "unused" as const : null;
    if (!why) continue;
    out.push({ path: own.path, repo: session.repo, sessionId: session.id, title: session.title, why, command: `git -C ${quote(session.repo)} worktree remove ${quote(own.path)}` });
  }
  return out;
}

/** The disk report's lines for them (null when there are none). */
export function leftWorktreesReport(left: readonly LeftWorktree[]): string | null {
  if (!left.length) return null;
  const lines = left.map((each) => `- ${each.path}: ${each.why === "failed" ? `da sessão falhada "${each.title.slice(0, 60)}" (${each.sessionId.slice(0, 8)})` : `criada para a sessão "${each.title.slice(0, 60)}" (${each.sessionId.slice(0, 8)}), que não a usou`} — para remover, depois de conferir: ${each.command}`);
  return `Worktrees criadas pelo OMB que ficaram sem uso (${left.length}). O servidor não remove nada; uma pessoa confere (git status, o que há dentro) e decide:\n${lines.join("\n")}`;
}
