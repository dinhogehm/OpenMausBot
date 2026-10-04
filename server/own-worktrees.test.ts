import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cacheLine, canonicalFolder, cloneSeedCaches, ensureLink, findCacheDirs, lockHash, OWN_DEFAULTS, ownLinkPath, ownSettingsFor, ownSummary, OwnWorktreeStore, planOwnWorktree,
  refreshSeed, savedText, SEED_DIR, SEED_LOCK_REASON, type CloneIo, type Exec, type OwnEvent, type SeedDeps, type SeedState,
} from "./own-worktrees.ts";

const REPO = "/Users/o/Projetos/nuria-platform";
const LOCK = '{"lockfileVersion":3,"packages":{}}';
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "omb-own-")); temps.push(dir); return dir; };

describe("where a session's worktree goes", () => {
  it("is <repo>/.claude/worktrees/<issue>-<slug> on omb/<issue>-<slug>, the same every time, without the issue twice", () => {
    const plan = planOwnWorktree(REPO, { title: "9353 Comprar assentos: UI do checkout", issue: "9353", sessionId: "a1b2c3d4-0000" }, () => false);
    expect(plan).toEqual({ dir: "9353-comprar-assentos-ui-do-checkout", path: `${REPO}/.claude/worktrees/9353-comprar-assentos-ui-do-checkout`, branch: "omb/9353-comprar-assentos-ui-do-checkout" });
    expect(planOwnWorktree(REPO, { title: "#9353 Comprar assentos: UI do checkout", issue: "9353", sessionId: "zz" }, () => false)?.dir).toBe(plan!.dir);
    // the same input, the same place (deterministic)
    expect(planOwnWorktree(REPO, { title: "9353 Comprar assentos: UI do checkout", issue: "9353", sessionId: "a1b2c3d4-0000" }, () => false)).toEqual(plan);
  });

  it("adds the session's id when the folder or branch is taken (old worktrees stay), and gives up only when that is taken too", () => {
    const taken = new Set([`${REPO}/.claude/worktrees/9353-comprar`]);
    const second = planOwnWorktree(REPO, { title: "9353 Comprar", issue: "9353", sessionId: "A1B2C3D4-x" }, (plan) => taken.has(plan.path));
    expect(second).toMatchObject({ dir: "9353-comprar-a1b2c3", branch: "omb/9353-comprar-a1b2c3" });
    expect(planOwnWorktree(REPO, { title: "9353 Comprar", issue: "9353", sessionId: "a1b2c3" }, () => true)).toBeNull();
  });

  it("names a session without an issue by its id, and cuts long titles", () => {
    const plan = planOwnWorktree(REPO, { title: "Limpeza geral do relatório de produtividade e mais coisas longas", sessionId: "f00dbabe-1" }, () => false)!;
    expect(plan.dir).toBe("omb-f00dba-limpeza-geral-do-relatorio-de-pr");
    expect(plan.dir.length).toBeLessThanOrEqual(4 + 7 + 32);
  });
});

describe("settings", () => {
  it("are on by default, can be turned off for all, per repository, or by the environment", () => {
    expect(ownSettingsFor(null, REPO)).toEqual(OWN_DEFAULTS);
    expect(ownSettingsFor({ enabled: false }, REPO).enabled).toBe(false);
    expect(ownSettingsFor({ repos: { [REPO]: { enabled: false } } }, REPO).enabled).toBe(false);
    expect(ownSettingsFor({ repos: { [REPO]: { enabled: false } } }, "/x/other").enabled).toBe(true);
    expect(ownSettingsFor({}, REPO, { OMB_OWN_WORKTREES: "0" }).enabled).toBe(false);
  });

  it("take extra caches and an install command, and ignore what is unsafe or malformed", () => {
    const settings = ownSettingsFor({ extraDirs: [".turbo", "../fora", "/abs"], cacheNames: ["node_modules", "a/b"], install: ["pnpm", "install", "--frozen-lockfile"], minFreeGiB: -1, seedEveryMs: 5 }, REPO);
    expect(settings.extraDirs).toEqual([".turbo"]);
    expect(settings.cacheNames).toEqual(["node_modules"]);
    expect(settings.install).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(settings.minFreeGiB).toBe(OWN_DEFAULTS.minFreeGiB);
    expect(settings.seedEveryMs).toBe(OWN_DEFAULTS.seedEveryMs);
  });
});

/** A seed ready for `lock` with two cache folders, and a fake filesystem around a new worktree. */
function cloneWorld(over: Partial<CloneIo> = {}, files: Record<string, string> = {}) {
  const calls: string[][] = [];
  const renamed: string[] = [];
  const dropped: string[] = [];
  const present = new Set([`${REPO}/.claude/worktrees/w`, `${REPO}/.claude/worktrees/w/web`]);
  const seed: SeedState = { repo: REPO, path: `${REPO}/${SEED_DIR}`, state: "ready", lockName: "package-lock.json", lockHash: lockHash(LOCK), node: "v22.19.0", installMs: 14 * 60_000, dirs: [{ path: "node_modules", kb: 1_200_000 }, { path: "web/node_modules", kb: 300_000 }, { path: "apps/gone/node_modules", kb: 5 }] };
  const io: CloneIo = {
    exec: (async (file, args) => { calls.push([file, ...args]); return ""; }) as Exec,
    now: (() => { let t = 0; return () => (t += 1_000); })(),
    readFile: (path) => ({ [`${REPO}/.claude/worktrees/w/package-lock.json`]: LOCK, ...files })[path] ?? null,
    exists: (path) => present.has(path),
    device: () => 7,
    cloneFile: async () => null,
    rename: (from, to) => { renamed.push(`${from} -> ${to}`); present.add(to); },
    dropTemp: (path) => { dropped.push(path); },
    node: async () => "v22.19.0",
    ...over,
  };
  return { io, seed, calls, renamed, dropped, present, worktree: `${REPO}/.claude/worktrees/w` };
}

describe("cloning the seed's caches", () => {
  it("clones each folder with nice + cp -c -R to a temporary name, renames it whole, and counts what it saved", async () => {
    const w = cloneWorld();
    const out = await cloneSeedCaches(w.seed, w.worktree, OWN_DEFAULTS.lockfiles, w.io);
    expect(out).toMatchObject({ mode: "cloned", dirs: ["node_modules", "web/node_modules"], savedKb: 1_500_000, savedMs: 14 * 60_000 });
    expect(w.calls).toEqual([
      ["/usr/bin/nice", "-n", "10", "/bin/cp", "-c", "-R", `${w.seed.path}/node_modules`, `${w.worktree}/node_modules.omb-clone`],
      ["/usr/bin/nice", "-n", "10", "/bin/cp", "-c", "-R", `${w.seed.path}/web/node_modules`, `${w.worktree}/web/node_modules.omb-clone`],
    ]);
    expect(w.renamed).toEqual([`${w.worktree}/node_modules.omb-clone -> ${w.worktree}/node_modules`, `${w.worktree}/web/node_modules.omb-clone -> ${w.worktree}/web/node_modules`]);
    // only the one-file probe was taken back; a workspace the branch lacks was skipped
    expect(w.dropped).toEqual([`${w.worktree}/.omb-clone-probe`]);
  });

  it("never writes over a folder that is already there", async () => {
    const w = cloneWorld();
    w.present.add(`${w.worktree}/node_modules`);
    const out = await cloneSeedCaches(w.seed, w.worktree, OWN_DEFAULTS.lockfiles, w.io);
    expect(out.dirs).toEqual(["web/node_modules"]);
    expect(w.calls).toHaveLength(1);
  });

  it.each([
    ["no seed yet", (w: ReturnType<typeof cloneWorld>) => ({ seed: undefined as SeedState | undefined, io: w.io }), /semente de dependências ainda não está pronta \(nunca instalada\)/],
    ["the seed is installing", (w: ReturnType<typeof cloneWorld>) => ({ seed: { ...w.seed, state: "installing" as const, reason: "instalando package-lock.json 1234abcd" }, io: w.io }), /ainda não está pronta \(instalando/],
    ["the branch's lockfile is another", (w: ReturnType<typeof cloneWorld>) => ({ seed: w.seed, io: { ...w.io, readFile: () => '{"other":1}' } }), /o package-lock.json desta branch \([0-9a-f]{8}\) não é o da semente \(package-lock.json [0-9a-f]{8}\)/],
    ["no lockfile", (w: ReturnType<typeof cloneWorld>) => ({ seed: w.seed, io: { ...w.io, readFile: () => null } }), /a branch não tem lockfile/],
    ["another Node", (w: ReturnType<typeof cloneWorld>) => ({ seed: w.seed, io: { ...w.io, node: async () => "v24.1.0" } }), /o Node mudou \(v24.1.0; a semente foi instalada com v22.19.0\)/],
    ["another volume", (w: ReturnType<typeof cloneWorld>) => ({ seed: w.seed, io: { ...w.io, device: (path: string) => (path.includes("omb-seed") ? 1 : 2) } }), /não estão no mesmo volume/],
    ["a volume that cannot clone", (w: ReturnType<typeof cloneWorld>) => ({ seed: w.seed, io: { ...w.io, cloneFile: async () => "cp -c fez uma cópia comum, não um clone" } }), /o volume não clona arquivos \(não é APFS\?\): cp -c fez uma cópia comum, não um clone/],
  ])("falls back to the session's own npm ci, saying why, when %s — and copies nothing", async (_name, setup, why) => {
    const w = cloneWorld();
    const { seed, io } = setup(w);
    const out = await cloneSeedCaches(seed, w.worktree, OWN_DEFAULTS.lockfiles, io);
    expect(out.mode).toBe("install");
    expect(out.reason).toMatch(why);
    expect(out.savedKb).toBe(0);
    expect(w.calls).toEqual([]);
  });

  it("takes back only its own half-made copy when cp fails, and the session installs", async () => {
    const w = cloneWorld({ exec: (async (_file, args) => { if (args.at(-1)!.includes("web/")) throw Object.assign(new Error("cp"), { stderr: "cp: No space left on device" }); return ""; }) as Exec });
    const out = await cloneSeedCaches(w.seed, w.worktree, OWN_DEFAULTS.lockfiles, w.io);
    expect(out).toMatchObject({ mode: "install", dirs: ["node_modules"], savedKb: 0 });
    expect(out.reason).toBe("o clone de web/node_modules falhou: cp: No space left on device");
    expect(w.dropped).toContain(`${w.worktree}/web/node_modules.omb-clone`);
    // the worktree itself is never touched
    expect(w.dropped.every((path) => path.endsWith(".omb-clone") || path.endsWith(".omb-clone-probe"))).toBe(true);
  });

  it("tells the session what to do either way", () => {
    expect(cacheLine({ mode: "cloned", dirs: ["node_modules", "web/node_modules"] })).toContain("Não rode npm ci nem npm install no começo");
    expect(cacheLine({ mode: "install", reason: "o volume não clona arquivos" })).toBe("As dependências NÃO foram clonadas (o volume não clona arquivos): rode `npm ci` nesta worktree antes de testar ou buildar.");
  });
});

/** A repository whose origin/main has `lock`, seen through a fake exec. */
function seedWorld(opts: { lock?: string; busy?: Array<string | null>; free?: number; installFails?: boolean; seedExists?: boolean; slowInstall?: boolean } = {}) {
  const calls: string[][] = [];
  const saved: SeedState[] = [];
  let installed = false;
  const busy = [...(opts.busy ?? [null])];
  const deps: SeedDeps = {
    exec: (async (file, args, options) => {
      calls.push([file, ...args]);
      if (args.includes("show")) return opts.lock ?? LOCK;
      if (args.includes("rev-parse")) return "abc1234567890\n";
      if (file === "/usr/bin/nice") {
        if (opts.installFails) throw Object.assign(new Error("npm"), { stderr: "npm ERR! network" });
        if (opts.slowInstall) {
          await new Promise<void>((resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            setTimeout(resolve, 2_000);
          });
        }
        installed = true;
      }
      return "";
    }) as Exec,
    now: Date.now,
    releaseBusy: async () => (busy.length > 1 ? busy.shift()! : busy[0] ?? null),
    freeBytes: () => opts.free ?? 100 * 1024 ** 3,
    readFile: (path) => (path.endsWith("package-lock.json") && installed ? opts.lock ?? LOCK : null),
    exists: (path) => (path.endsWith(".git") ? opts.seedExists ?? true : true),
    findDirs: () => ["node_modules", "web/node_modules"],
    sizeKb: async (path) => (path.endsWith("web/node_modules") ? 300_000 : 1_200_000),
    node: async () => "v22.19.0",
    log: () => {},
    save: (seed) => { saved.push(structuredClone(seed)); },
    pollMs: 20,
  };
  return { deps, calls, saved };
}

const settings = { ...OWN_DEFAULTS, minFreeGiB: 10 };
const noRemoval = (calls: string[][]) => calls.flat().filter((arg) => /^(?:remove|prune|rm|unlock)$/.test(arg) || arg === "--delete");

describe("the seed", () => {
  it("is made the first time as a locked, detached worktree of origin/main and installed with nice", async () => {
    const w = seedWorld({ seedExists: false });
    const seed = await refreshSeed(REPO, settings, undefined, w.deps);
    expect(w.calls).toContainEqual(["git", "-C", REPO, "worktree", "add", "--detach", `${REPO}/${SEED_DIR}`, "origin/main"]);
    expect(w.calls).toContainEqual(["git", "-C", REPO, "worktree", "lock", "--reason", SEED_LOCK_REASON, `${REPO}/${SEED_DIR}`]);
    expect(w.calls).toContainEqual(["/usr/bin/nice", "-n", "15", "npm", "ci", "--no-audit", "--no-fund"]);
    expect(seed).toMatchObject({ state: "ready", lockName: "package-lock.json", lockHash: lockHash(LOCK), node: "v22.19.0", head: "abc1234567890", dirs: [{ path: "node_modules", kb: 1_200_000 }, { path: "web/node_modules", kb: 300_000 }] });
    // while installing, it said so (no clone is taken from a half-made node_modules)
    expect(w.saved.some((each) => each.state === "installing")).toBe(true);
    expect(noRemoval(w.calls)).toEqual([]);
  });

  it("is left alone when origin/main's lockfile and the Node are the ones installed", async () => {
    const w = seedWorld();
    const ready: SeedState = { repo: REPO, path: `${REPO}/${SEED_DIR}`, state: "ready", lockName: "package-lock.json", lockHash: lockHash(LOCK), node: "v22.19.0", dirs: [{ path: "node_modules", kb: 1 }] };
    const seed = await refreshSeed(REPO, settings, ready, w.deps);
    expect(seed.state).toBe("ready");
    expect(w.calls.some(([file]) => file === "/usr/bin/nice")).toBe(false);
    expect(w.calls.some((call) => call.includes("checkout"))).toBe(false);
  });

  it("is installed again when origin/main's lockfile changed: checkout of origin/main in the seed, then the install", async () => {
    const w = seedWorld({ lock: '{"changed":true}' });
    const old: SeedState = { repo: REPO, path: `${REPO}/${SEED_DIR}`, state: "ready", lockName: "package-lock.json", lockHash: lockHash(LOCK), node: "v22.19.0", dirs: [{ path: "node_modules", kb: 1 }] };
    const seed = await refreshSeed(REPO, settings, old, w.deps);
    expect(w.calls).toContainEqual(["git", "-C", `${REPO}/${SEED_DIR}`, "checkout", "--quiet", "--force", "--detach", "origin/main"]);
    expect(seed).toMatchObject({ state: "ready", lockHash: lockHash('{"changed":true}') });
  });

  it("never runs with a release on its way: nothing at all is run, not even a fetch", async () => {
    const w = seedWorld({ busy: ["o release de produção 3c04d7c3d está em andamento"] });
    const seed = await refreshSeed(REPO, settings, undefined, w.deps);
    expect(w.calls).toEqual([]);
    expect(seed).toMatchObject({ state: "waiting" });
    expect(seed.reason).toContain("com um release na máquina (o release de produção 3c04d7c3d está em andamento)");
  });

  it("stops an install a release meets, and says it", async () => {
    const w = seedWorld({ lock: '{"changed":true}', slowInstall: true, busy: [null, null, "o release de produção 3c04d7c3d está na fila da máquina"] });
    const seed = await refreshSeed(REPO, settings, undefined, w.deps);
    expect(seed.state).toBe("interrupted");
    expect(seed.reason).toContain("um release começou");
  });

  it("waits on a nearly full disk, and a seed that was ready stays usable for the branches it serves", async () => {
    const w = seedWorld({ lock: '{"changed":true}', free: 3.3 * 1024 ** 3 });
    const old: SeedState = { repo: REPO, path: `${REPO}/${SEED_DIR}`, state: "ready", lockName: "package-lock.json", lockHash: lockHash(LOCK), node: "v22.19.0", dirs: [{ path: "node_modules", kb: 1 }] };
    const seed = await refreshSeed(REPO, settings, old, w.deps);
    expect(w.calls.some(([file]) => file === "/usr/bin/nice")).toBe(false);
    expect(seed).toMatchObject({ state: "ready", lockHash: lockHash(LOCK) });
    expect(seed.reason).toContain("só 3,3 GiB livres; instalo a semente com 10 GiB ou mais");
    const fresh = await refreshSeed(REPO, settings, undefined, seedWorld({ free: 3.3 * 1024 ** 3 }).deps);
    expect(fresh.state).toBe("waiting");
  });

  it("says when the install failed, and removes nothing", async () => {
    const w = seedWorld({ installFails: true });
    const seed = await refreshSeed(REPO, settings, undefined, w.deps);
    expect(seed).toMatchObject({ state: "failed", reason: "npm ci --no-audit --no-fund falhou na semente: npm ERR! network" });
    expect(noRemoval(w.calls)).toEqual([]);
  });

  it("finds node_modules at the root and in each workspace, never inside another one", () => {
    const tree: Record<string, string[]> = {
      "/s": ["node_modules", "web", "apps", ".git", ".claude", "README.md"],
      "/s/web": ["node_modules", "src"],
      "/s/web/src": [],
      "/s/apps": ["calls", "forms"],
      "/s/apps/calls": ["node_modules"],
      "/s/apps/forms": ["src"],
      "/s/apps/forms/src": [],
      "/s/.turbo": [],
    };
    const fs = { list: (path: string) => tree[path] ?? [], isDir: (path: string) => path in tree || path.endsWith("node_modules") };
    expect(findCacheDirs("/s", ["node_modules"], [".turbo", "missing"], fs)).toEqual(["apps/calls/node_modules", "node_modules", "web/node_modules", ".turbo"]);
  });
});

describe("what the clones saved", () => {
  const event = (over: Partial<OwnEvent>): OwnEvent => ({ at: 10, sessionId: "s", repo: REPO, path: "/p", branch: "omb/p", mode: "cloned", savedKb: 1_500_000, savedMs: 14 * 60_000, ...over });
  it("sums the period's clones and groups why the others were not", () => {
    const summary = ownSummary([
      event({}), event({ at: 20 }),
      event({ at: 30, mode: "install", reason: "o package-lock.json desta branch (aaaaaaaa) não é o da semente (package-lock.json bbbbbbbb): x", savedKb: undefined }),
      event({ at: 31, mode: "install", reason: "o package-lock.json desta branch (cccccccc) não é o da semente (package-lock.json dddddddd): x", savedKb: undefined }),
      event({ at: 40, mode: "failed", reason: "git worktree add: invalid reference", savedKb: undefined }),
      event({ at: 99 }),
    ], [{ repo: REPO, path: "/s", state: "ready", dirs: [{ path: "node_modules", kb: 5 }], installMs: 1 }], 0, 50);
    expect(summary).toMatchObject({ created: 4, cloned: 2, installed: 2, failed: 1, savedKb: 3_000_000, savedMs: 28 * 60_000 });
    expect(summary.reasons).toEqual([
      { reason: "o package-lock.json desta branch (…) não é o da semente (package-lock.json …): x", count: 2 },
      { reason: "git worktree add: invalid reference", count: 1 },
    ]);
    expect(summary.seeds).toEqual([{ repo: REPO, state: "ready", installMs: 1, kb: 5 }]);
    expect(savedText(3_000_000, 28 * 60_000)).toBe("2,9 GB e ~28 min");
    expect(savedText(2_048, 0)).toBe("2 MB");
  });

  it("keeps seeds and events across restarts, and an install cut by a restart is not taken as ready", () => {
    const dir = temp();
    const path = join(dir, "own-worktrees.json");
    const store = new OwnWorktreeStore(path);
    store.setSeed({ repo: REPO, path: "/s", state: "installing" });
    store.record(event({}));
    const again = new OwnWorktreeStore(path);
    expect(again.seed(REPO)).toMatchObject({ state: "interrupted" });
    expect(again.allEvents()).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).events).toHaveLength(1);
  });
});

describe("the folder the app is given", () => {
  it("is an alias outside .claude/worktrees, and reading a record resolves it to the worktree", () => {
    const dir = temp();
    const worktree = join(dir, "repo", ".claude", "worktrees", "9353-x");
    mkdirSync(worktree, { recursive: true });
    const link = ownLinkPath(join(dir, "data"), join(dir, "repo"), "9353-x");
    expect(link).toBe(join(dir, "data", "worktree-links", "repo", "9353-x"));
    expect(link.includes("/.claude/worktrees/")).toBe(false);
    expect(ensureLink(link, worktree)).toBeNull();
    expect(ensureLink(link, worktree)).toBeNull(); // kept
    expect(canonicalFolder(link)).toBe(worktree);
    expect(canonicalFolder(worktree)).toBe(worktree);
    expect(canonicalFolder("/x/worktree-links/missing")).toBe("/x/worktree-links/missing");
    // something else in its place is never replaced
    const other = join(dir, "data", "worktree-links", "repo", "busy");
    mkdirSync(other, { recursive: true });
    expect(ensureLink(other, worktree)).toContain("já existe e não aponta para");
    expect(existsSync(other)).toBe(true);
  });
});
