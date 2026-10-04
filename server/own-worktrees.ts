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
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { slugify } from "./cc-sessions.ts";

/** Where the seed lives, inside the repository (`.claude/*` is ignored there). */
export const SEED_DIR = ".claude/omb-seed";
/** The folders the app is given: aliases outside `.claude/worktrees/` (see ownLinkPath). */
export const OWN_LINK_DIR = "worktree-links";
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
  /** How the seed installs (run with nice in the seed). */
  install: string[];
  /** The seed is not installed with less free space than this. */
  minFreeGiB: number;
  /** How often the seed is checked against origin/main. */
  seedEveryMs: number;
}

export const OWN_DEFAULTS: OwnWorktreeSettings = {
  enabled: true,
  cacheNames: ["node_modules"],
  extraDirs: [],
  lockfiles: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
  install: ["npm", "ci", "--no-audit", "--no-fund"],
  minFreeGiB: 10,
  seedEveryMs: 30 * 60_000,
};

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
  try {
    await exec("git", ["-C", repo, "worktree", "add", "--no-track", "-b", plan.branch, plan.path, `origin/${baseBranch}`], { timeoutMs: 300_000 });
    const head = (await exec("git", ["-C", plan.path, "rev-parse", "HEAD"], { timeoutMs: 30_000 })).trim();
    return { ok: true, head, ...(fetchError ? { fetchError } : {}) };
  } catch (error) {
    return { ok: false, error: `git worktree add: ${failureText(error)}${fetchError ? ` (e o fetch de origin/${baseBranch} falhou: ${fetchError})` : ""}` };
  }
}

/** The alias the app is given for a worktree. The app's link
 * claude://code/new?folder=… maps any folder inside `.claude/worktrees/`
 * back to its repository root (Claude 2.19675, `vIn`), which would put the
 * session in the main checkout; an alias outside it keeps the folder. */
export const ownLinkPath = (dataDir: string, repo: string, dir: string) => join(dataDir, OWN_LINK_DIR, basename(repo), dir);

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
}

export const lockHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export interface CloneOutcome {
  mode: "cloned" | "install";
  /** Why the caches were not cloned (pt-BR). */
  reason?: string;
  /** The folders cloned, relative to the repository. */
  dirs: string[];
  /** What a full copy (or an install) would have written, in KiB. */
  savedKb: number;
  /** The seed's install time each clone spares, in ms. */
  savedMs: number;
  ms: number;
}

export interface CloneIo {
  exec: Exec;
  now: () => number;
  /** A file's text, or null. */
  readFile: (path: string) => string | null;
  exists: (path: string) => boolean;
  /** The volume a path is on, or null. */
  device: (path: string) => number | null;
  /** Clone one file, failing when the volume cannot clone (never a plain copy). Null when done, else why not. */
  cloneFile: (src: string, dst: string) => string | null;
  rename: (from: string, to: string) => void;
  /** Take back a temporary copy this clone made (never a worktree). */
  dropTemp: (path: string) => void;
  /** `node --version` now, or null. */
  node: () => Promise<string | null>;
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
 * name and renamed once whole, so a session never sees half a node_modules. */
export async function cloneSeedCaches(seed: SeedState | undefined, worktree: string, lockfiles: readonly string[], io: CloneIo): Promise<CloneOutcome> {
  const started = io.now();
  const fallback = (reason: string): CloneOutcome => ({ mode: "install", reason, dirs: [], savedKb: 0, savedMs: 0, ms: io.now() - started });
  if (!seed || seed.state !== "ready" || !seed.lockHash || !seed.dirs?.length) {
    return fallback(`a semente de dependências ainda não está pronta (${seed ? seed.reason ?? seed.state : "nunca instalada"})`);
  }
  const lock = lockOf(worktree, lockfiles, io.readFile);
  if (!lock) return fallback(`a branch não tem lockfile (${lockfiles.join(", ")})`);
  if (lock.name !== seed.lockName || lock.hash !== seed.lockHash) {
    return fallback(`o ${lock.name} desta branch (${lock.hash.slice(0, 8)}) não é o da semente (${seed.lockName ?? "?"} ${seed.lockHash.slice(0, 8)}): a semente é de outro commit de origin/main`);
  }
  const node = await io.node();
  if (seed.node && node !== seed.node) return fallback(`o Node mudou (${node ?? "?"}; a semente foi instalada com ${seed.node}): módulos nativos não serviriam`);
  const seedDevice = io.device(seed.path);
  const device = io.device(worktree);
  if (seedDevice === null || device === null || seedDevice !== device) return fallback("a semente e a worktree não estão no mesmo volume: o clone copiaria tudo");
  // one file first: a volume that cannot clone fails here, before cp -c
  // falls back to a full copy on its own (man cp), filling the disk
  const probe = join(worktree, CLONE_PROBE);
  const cannot = io.cloneFile(join(seed.path, seed.lockName!), probe);
  io.dropTemp(probe);
  if (cannot) return fallback(`o volume não clona arquivos (não é APFS?): ${cannot}`);
  const cloned: string[] = [];
  let savedKb = 0;
  for (const dir of seed.dirs) {
    const target = join(worktree, dir.path);
    if (!io.exists(dirname(target))) continue; // a workspace this branch does not have
    if (io.exists(target)) continue; // never over what is there
    const temp = `${target}.omb-clone`;
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
  return { mode: "cloned", dirs: cloned, savedKb, savedMs: seed.installMs ?? 0, ms: io.now() - started };
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
  /** How often a running install looks for a release that started meanwhile. */
  pollMs?: number;
}

const GIB = 1024 ** 3;

/** Bring the seed of `repo` to origin/<base>: made the first time (a locked,
 * detached worktree), installed again only when origin/<base>'s lockfile
 * (or the Node) is not the one installed. Never with a release on its way,
 * never on a nearly full disk; an install a release meets is stopped. */
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
  const fresh = previous?.state === "ready" && previous.lockName === wanted.name && previous.lockHash === wanted.hash && previous.node === node && deps.exists(join(path, ".git"));
  if (fresh) return keep("ready");
  const free = deps.freeBytes(repo);
  if (free !== null && free < settings.minFreeGiB * GIB) {
    return keep("waiting", `só ${(free / GIB).toFixed(1).replace(".", ",")} GiB livres; instalo a semente com ${settings.minFreeGiB} GiB ou mais`);
  }
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
  // installing now: until it ends, no clone is taken from a half-made node_modules
  seed = { ...seed, state: "installing", reason: `instalando ${wanted.name} ${wanted.hash.slice(0, 8)}` };
  delete seed.dirs;
  deps.save(seed);
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
    deps.log(`seed of ${repo}: ${settings.install.join(" ")} (nice) for ${wanted.name} ${wanted.hash.slice(0, 8)}`);
    await deps.exec("/usr/bin/nice", ["-n", "15", ...settings.install], { cwd: path, timeoutMs: 45 * 60_000, signal: controller.signal });
  } catch (error) {
    clearInterval(watch);
    if (stoppedFor) return keep("interrupted", `parei a instalação da semente: um release começou (${stoppedFor}); volto depois dele`);
    return keep("failed", `${settings.install.join(" ")} falhou na semente: ${failureText(error)}`);
  }
  clearInterval(watch);
  if (stoppedFor) return keep("interrupted", `parei a instalação da semente: um release começou (${stoppedFor}); volto depois dele`);
  const installed = lockOf(path, settings.lockfiles, deps.readFile);
  const dirs: Array<{ path: string; kb: number }> = [];
  for (const dir of deps.findDirs(path, settings)) dirs.push({ path: dir, kb: (await deps.sizeKb(join(path, dir))) ?? 0 });
  let head: string | undefined;
  try { head = (await deps.exec("git", ["-C", path, "rev-parse", "HEAD"], { timeoutMs: 30_000 })).trim(); } catch { /* unknown */ }
  if (!installed || !dirs.length) return keep("failed", !installed ? "a semente ficou sem lockfile depois de instalar" : "a instalação não deixou nenhuma pasta de dependências na semente");
  seed = { ...seed, state: "ready", lockName: installed.name, lockHash: installed.hash, ...(node ? { node } : {}), ...(head ? { head } : {}), dirs, installedAt: deps.now(), installMs: deps.now() - started };
  delete seed.reason;
  deps.save(seed);
  deps.log(`seed of ${repo}: ready at ${head?.slice(0, 9) ?? "?"} (${installed.name} ${installed.hash.slice(0, 8)}, ${dirs.length} folder(s), ${Math.round(dirs.reduce((sum, dir) => sum + dir.kb, 0) / 1024)} MiB, ${Math.round((seed.installMs ?? 0) / 1000)} s)`);
  return seed;
}

/** The real filesystem side of a clone. */
export function realCloneIo(exec: Exec, node: () => Promise<string | null>): CloneIo {
  return {
    exec,
    now: Date.now,
    readFile: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
    exists: existsSync,
    device: (path) => { try { return statSync(path).dev; } catch { return null; } },
    cloneFile: (src, dst) => {
      try {
        copyFileSync(src, dst, constants.COPYFILE_FICLONE_FORCE);
        return null;
      } catch (error) {
        return failureText(error);
      }
    },
    rename: renameSync,
    dropTemp: (path) => rmSync(path, { recursive: true, force: true }),
    node,
  };
}

/** The real filesystem side of findCacheDirs. */
export const realDirFs = {
  list: (path: string) => readdirSync(path),
  isDir: (path: string) => { try { return lstatSync(path).isDirectory(); } catch { return false; } },
};

// ── what each session's brief is told ─────────────────────────────────────

/** The line about dependencies in the brief of a session in its own worktree. */
export function cacheLine(outcome: Pick<CloneOutcome, "mode" | "reason"> & { dirs?: string[] }): string {
  if (outcome.mode === "cloned") {
    return `As dependências já estão instaladas nesta worktree: ${(outcome.dirs ?? []).join(", ")} foram clonadas de uma cópia atualizada de origin/main, com o mesmo lockfile. Não rode npm ci nem npm install no começo; só rode se um comando falhar por dependência faltando.`;
  }
  return `As dependências NÃO foram clonadas (${outcome.reason ?? "motivo desconhecido"}): rode \`npm ci\` nesta worktree antes de testar ou buildar.`;
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
    savedKb: inside.reduce((sum, event) => sum + (event.savedKb ?? 0), 0),
    savedMs: inside.reduce((sum, event) => sum + (event.savedMs ?? 0), 0),
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
