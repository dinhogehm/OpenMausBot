import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appLinkFolder, breakerRepo, leftOwnWorktrees, leftWorktreesReport, noteOwnFailure, ownBreakerCli, ownBreakerItem, ownBreakerTripped, ownFailureCause, rearmOwnBreaker, type OwnBreakerState, type OwnFailure, cacheLine, canonicalFolder, cloneSeedCaches, ensureLink, findCacheDirs, installFor, installText, lockHash, OWN_DEFAULTS, ownLinkPath, ownSettingsFor, ownSummary, OwnWorktreeStore, planOwnWorktree,
  refreshSeed, savedText, SEED_DIR, SEED_LOCK_REASON, type CloneIo, type Exec, type OwnEvent, type SeedDeps, type SeedState,
} from "./own-worktrees.ts";
import { worktreeLines } from "./productivity-export.ts";
import type { ProductivityReport } from "../shared/productivity.ts";

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
    // husky-style hooks inside each checkout; the worktree's came with the clone when node_modules did
    hooks: async (folder) => `${folder}/.husky/_`,
    listDir: (path) => (path === `${REPO}/.husky/_` || present.has(`${REPO}/.claude/worktrees/w/node_modules`) ? ["pre-commit", "pre-push", "h"] : null),
    realpath: (path) => path,
    sample: () => ".package-lock.json",
    sameBlocks: async () => false,
    ...over,
  };
  return { io, seed, calls, renamed, dropped, present, worktree: `${REPO}/.claude/worktrees/w` };
}

describe("cloning the seed's caches", () => {
  it("clones each folder with nice + cp -c -R to a temporary name, renames it whole, and counts what it saved", async () => {
    const w = cloneWorld();
    const out = await cloneSeedCaches(w.seed, w.worktree, OWN_DEFAULTS.lockfiles, w.io);
    expect(out).toMatchObject({ mode: "cloned", dirs: ["node_modules", "web/node_modules"], savedKb: 1_500_000, savedMs: 14 * 60_000, install: "npm ci", hooks: ".husky/_" });
    expect(w.calls).toEqual([
      ["/usr/bin/nice", "-n", "10", "/bin/cp", "-c", "-R", `${w.seed.path}/node_modules`, `${w.worktree}/node_modules.omb-clone`],
      ["/usr/bin/nice", "-n", "10", "/bin/cp", "-c", "-R", `${w.seed.path}/web/node_modules`, `${w.worktree}/web/node_modules.omb-clone`],
    ]);
    expect(w.renamed).toEqual([`${w.worktree}/node_modules.omb-clone -> ${w.worktree}/node_modules`, `${w.worktree}/web/node_modules.omb-clone -> ${w.worktree}/web/node_modules`]);
    // only the one-file probe and stale temporary copies are taken back; a workspace the branch lacks was skipped
    expect(w.dropped).toEqual([`${w.worktree}/.omb-clone-probe`, `${w.worktree}/node_modules.omb-clone`, `${w.worktree}/web/node_modules.omb-clone`]);
  });

  it("never writes over a folder that is already there", async () => {
    const w = cloneWorld();
    w.present.add(`${w.worktree}/node_modules`);
    const out = await cloneSeedCaches(w.seed, w.worktree, OWN_DEFAULTS.lockfiles, w.io);
    expect(out.dirs).toEqual(["web/node_modules"]);
    expect(w.calls).toHaveLength(1);
  });

  it("after a restart, takes the folders a stopped server cloned (same blocks as the seed's) as done: cloned, no install over them (X1-3)", async () => {
    const w = cloneWorld({ sameBlocks: async () => true });
    w.present.add(`${w.worktree}/node_modules`);
    w.present.add(`${w.worktree}/web/node_modules`);
    const out = await cloneSeedCaches(w.seed, w.worktree, OWN_DEFAULTS.lockfiles, w.io);
    expect(out).toMatchObject({ mode: "cloned", dirs: ["node_modules", "web/node_modules"], savedKb: 1_500_000, hooks: ".husky/_" });
    expect(w.calls).toEqual([]);
    expect(cacheLine(out)).toContain("Não rode `npm ci` no começo");
  });

  it("is an install when the worktree ends up without the main checkout's git hooks — the brief then says to install (X1-1)", async () => {
    // the clone brought node_modules but no hooks folder (a seed of an older build, HUSKY=0, a failed prepare)
    const w = cloneWorld({ listDir: (path) => (path === `${REPO}/.husky/_` ? ["pre-commit", "pre-push", "h"] : null) });
    const out = await cloneSeedCaches(w.seed, w.worktree, OWN_DEFAULTS.lockfiles, w.io);
    expect(out).toMatchObject({ mode: "install", reason: "os hooks do git (.husky/_) não vieram com o clone: sem eles nenhum hook roda nesta worktree", savedKb: 0 });
    expect(cacheLine(out)).toBe("As dependências NÃO foram clonadas (os hooks do git (.husky/_) não vieram com o clone: sem eles nenhum hook roda nesta worktree): rode `npm ci` nesta worktree antes de testar, buildar ou commitar — ele também instala os hooks do git.");
    // a hook missing that the main checkout has
    const some = cloneWorld({ listDir: (path) => (path === `${REPO}/.husky/_` ? ["pre-commit", "pre-push"] : ["pre-commit"]) });
    expect((await cloneSeedCaches(some.seed, some.worktree, OWN_DEFAULTS.lockfiles, some.io)).reason).toBe("faltam hooks do git em .husky/_ (pre-push), que o checkout principal tem");
    // a seed whose hooks folder is not among what it clones
    const stale = cloneWorld();
    expect((await cloneSeedCaches({ ...stale.seed, hooks: ".husky/_" }, stale.worktree, OWN_DEFAULTS.lockfiles, stale.io)).reason).toBe("a semente não tem os hooks do git (.husky/_) entre as pastas que clona");
  });

  it("tells the session the repository's own install: pnpm where the lockfile is pnpm's", async () => {
    const w = cloneWorld({ readFile: (path) => (path.endsWith("/pnpm-lock.yaml") ? "lockfileVersion: 9" : null) });
    const out = await cloneSeedCaches(w.seed, w.worktree, OWN_DEFAULTS.lockfiles, w.io);
    expect(out.install).toBe("pnpm install --frozen-lockfile");
    expect(cacheLine(out)).toContain("rode `pnpm install --frozen-lockfile` nesta worktree");
    expect(installFor("pnpm-lock.yaml")).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(installFor("yarn.lock")).toEqual(["yarn", "install", "--frozen-lockfile"]);
    expect(installFor("package-lock.json")).toEqual(["npm", "ci", "--no-audit", "--no-fund"]);
    expect(installFor("pnpm-lock.yaml", { install: ["custom"] })).toEqual(["custom"]);
    expect(installText("package-lock.json")).toBe("npm ci");
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

  it("tells the session not to install only when the hooks were checked", () => {
    expect(cacheLine({ mode: "cloned", dirs: ["node_modules"], install: "npm ci", hooks: ".husky/_" })).toContain("os hooks do git (.husky/_) foram conferidos com os do checkout principal. Não rode `npm ci` no começo");
    expect(cacheLine({ mode: "cloned", dirs: ["node_modules"], install: "npm ci" })).toContain("NÃO foram clonadas (os hooks do git não foram conferidos): rode `npm ci`");
    expect(cacheLine({ mode: "install", reason: "o volume não clona arquivos" })).toBe("As dependências NÃO foram clonadas (o volume não clona arquivos): rode `npm ci` nesta worktree antes de testar, buildar ou commitar — ele também instala os hooks do git.");
  });
});

/** A repository whose origin/main has `lock`, seen through a fake exec. */
function seedWorld(opts: { lock?: string; busy?: Array<string | null>; free?: number; installFails?: boolean; seedExists?: boolean; slowInstall?: boolean; noHooksMade?: boolean } = {}) {
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
    // the install makes husky's hooks folder (or not: HUSKY=0, a failed prepare)
    exists: (path) => (path.endsWith(".git") ? opts.seedExists ?? true : path.endsWith(".husky/_") ? !opts.noHooksMade : true),
    findDirs: () => ["node_modules", "web/node_modules"],
    sizeKb: async (path) => (path.endsWith("web/node_modules") ? 300_000 : path.endsWith(".husky/_") ? 8 : 1_200_000),
    node: async () => "v22.19.0",
    log: () => {},
    save: (seed) => { saved.push(structuredClone(seed)); },
    hooks: async (folder) => `${folder}/.husky/_`,
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
    expect(seed).toMatchObject({ state: "ready", lockName: "package-lock.json", lockHash: lockHash(LOCK), node: "v22.19.0", head: "abc1234567890", hooks: ".husky/_", dirs: [{ path: "node_modules", kb: 1_200_000 }, { path: "web/node_modules", kb: 300_000 }, { path: ".husky/_", kb: 8 }] });
    // while installing, it said so (no clone is taken from a half-made node_modules)
    expect(w.saved.some((each) => each.state === "installing")).toBe(true);
    expect(noRemoval(w.calls)).toEqual([]);
  });

  it("is left alone when origin/main's lockfile and the Node are the ones installed", async () => {
    const w = seedWorld();
    const ready: SeedState = { repo: REPO, path: `${REPO}/${SEED_DIR}`, state: "ready", lockName: "package-lock.json", lockHash: lockHash(LOCK), node: "v22.19.0", hooks: ".husky/_", dirs: [{ path: "node_modules", kb: 1 }, { path: "web/node_modules", kb: 1 }, { path: ".husky/_", kb: 1 }] };
    const seed = await refreshSeed(REPO, settings, ready, w.deps);
    expect(seed).toMatchObject({ state: "ready", dirs: ready.dirs });
    expect(w.calls.some(([file]) => file === "/usr/bin/nice")).toBe(false);
    expect(w.calls.some((call) => call.includes("checkout"))).toBe(false);
  });

  it("brings a ready seed of an older build to today's folders (its hooks), measuring only, without installing (X1-1)", async () => {
    const w = seedWorld();
    const old: SeedState = { repo: REPO, path: `${REPO}/${SEED_DIR}`, state: "ready", lockName: "package-lock.json", lockHash: lockHash(LOCK), node: "v22.19.0", dirs: [{ path: "node_modules", kb: 1 }] };
    const seed = await refreshSeed(REPO, settings, old, w.deps);
    expect(seed).toMatchObject({ state: "ready", hooks: ".husky/_" });
    expect(seed.dirs!.map((dir) => dir.path)).toEqual(["node_modules", "web/node_modules", ".husky/_"]);
    expect(w.calls.some(([file]) => file === "/usr/bin/nice")).toBe(false);
  });

  it("is installed again when its hooks are gone, and is not usable when the install makes none (HUSKY=0, a failed prepare) — not retried for 6 h (X1-1)", async () => {
    const gone = seedWorld({ noHooksMade: true });
    const ready: SeedState = { repo: REPO, path: `${REPO}/${SEED_DIR}`, state: "ready", lockName: "package-lock.json", lockHash: lockHash(LOCK), node: "v22.19.0", hooks: ".husky/_", dirs: [{ path: "node_modules", kb: 1 }, { path: ".husky/_", kb: 1 }] };
    const seed = await refreshSeed(REPO, settings, ready, gone.deps);
    expect(gone.calls).toContainEqual(["/usr/bin/nice", "-n", "15", "npm", "ci", "--no-audit", "--no-fund"]);
    expect(seed.state).toBe("failed");
    expect(seed.reason).toContain("terminou sem criar os hooks do git (.husky/_) — HUSKY=0 ou o prepare falhou");
    expect(seed.retryAfter).toBeGreaterThan(Date.now() + 5 * 3_600_000);
    // a clone never comes from it
    const w = cloneWorld();
    expect((await cloneSeedCaches(seed, w.worktree, OWN_DEFAULTS.lockfiles, w.io)).mode).toBe("install");
    // and the next pass does not install again for the same lockfile
    const again = seedWorld({ noHooksMade: true });
    expect((await refreshSeed(REPO, settings, seed, again.deps)).state).toBe("failed");
    expect(again.calls.some(([file]) => file === "/usr/bin/nice")).toBe(false);
  });

  it("installs a pnpm repository with pnpm, never npm ci (X1-4)", async () => {
    const w = seedWorld();
    w.deps.exec = (async (file: string, args: string[]) => {
      w.calls.push([file, ...args]);
      if (args.includes("show")) { if (args.at(-1)!.endsWith("pnpm-lock.yaml")) return "lockfileVersion: 9"; throw new Error("no such path"); }
      return "";
    }) as Exec;
    await refreshSeed(REPO, settings, undefined, w.deps);
    expect(w.calls).toContainEqual(["/usr/bin/nice", "-n", "15", "pnpm", "install", "--frozen-lockfile"]);
    expect(w.calls.flat()).not.toContain("ci");
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

  it("does not change while a worktree is being cloned from it, and says it is installing before its first change", async () => {
    const held = seedWorld({ lock: '{"changed":true}' });
    held.deps.mayInstall = () => "uma worktree está sendo clonada da semente agora; tento de novo em seguida";
    const old: SeedState = { repo: REPO, path: `${REPO}/${SEED_DIR}`, state: "ready", lockName: "package-lock.json", lockHash: lockHash(LOCK), node: "v22.19.0", dirs: [{ path: "node_modules", kb: 1 }] };
    const kept = await refreshSeed(REPO, settings, old, held.deps);
    expect(kept).toMatchObject({ state: "ready", lockHash: lockHash(LOCK) });
    expect(kept.reason).toContain("sendo clonada");
    expect(held.calls.some((call) => call.includes("checkout") || call[0] === "/usr/bin/nice")).toBe(false);
    // the first change (checkout) comes only after "installing" was saved
    const w = seedWorld({ lock: '{"changed":true}' });
    const states: string[] = [];
    const save = w.deps.save;
    w.deps.save = (seed) => { states.push(seed.state); save(seed); };
    const exec = w.deps.exec;
    w.deps.exec = (file, args, options) => { if (args.includes("checkout")) states.push("checkout"); return exec(file, args, options); };
    await refreshSeed(REPO, settings, old, w.deps);
    expect(states.indexOf("installing")).toBeLessThan(states.indexOf("checkout"));
  });

  it("clones husky's hook shims with the dependencies by default: git's hooksPath points at them", () => {
    expect(OWN_DEFAULTS.extraDirs).toContain(".husky/_");
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

describe("the breaker counts the worktree option ON or unreadable too (R12-1)", () => {
  const W = `${REPO}/.claude/worktrees/9353-x`;
  it("trips on two creates given up for the chip, and tells the owner to turn the option off", () => {
    const chip = (id: string, option: "on" | "unknown"): OwnFailure => ({ at: 1, sessionId: id, title: `${id} título`, folder: "", expected: W, chip: option, seen: "• Local | 9353-x | v worktree" });
    let out = noteOwnFailure({ repos: {} }, REPO, chip("a", "on"));
    expect(out.tripped).toBe(false);
    out = noteOwnFailure(out.state, REPO, chip("b", "unknown"));
    expect(out.tripped).toBe(true);
    const item = ownBreakerItem(REPO, out.state.repos[REPO]!.failures);
    expect(item.title).toBe("O app Claude abriu 2 sessões de nuria-platform com a opção worktree LIGADA ou ilegível: desligue-a antes de abrir sessão (o servidor já cria a pasta)");
    expect(item.why).toContain('- "a título": a opção worktree estava LIGADA na sessão nova (a tela mostrou: • Local | 9353-x | v worktree); nada foi colado — desligue-a antes de abrir sessão');
    expect(item.why).toContain('- "b título": a opção worktree estava ilegível');
    // mixed with a wrong folder: the general title, each cause said
    const mixed = ownBreakerItem(REPO, [chip("a", "on"), { at: 2, sessionId: "c", title: "c título", folder: `${W}/.claude/worktrees/app-1`, expected: W }]);
    expect(mixed.title).toContain("fora da worktree que o servidor criou");
    expect(mixed.why).toContain("a opção worktree estava LIGADA na sessão nova");
    expect(mixed.why).toContain("o app criou uma worktree própria dentro da pasta do OMB");
  });
});

describe("the breaker (R11-1)", () => {
  const W = `${REPO}/.claude/worktrees/9353-x`;
  const failure = (id: string, folder: string, at = 1): OwnFailure => ({ at, sessionId: id, title: `${id} título`, folder, expected: W });
  it("trips on the 2nd session in a row that landed elsewhere, once; the same session twice counts once", () => {
    let state: OwnBreakerState = { repos: {} };
    let out = noteOwnFailure(state, REPO, failure("a", `${W}/.claude/worktrees/app-1`));
    expect(out.tripped).toBe(false);
    out = noteOwnFailure(out.state, REPO, failure("a", `${W}/.claude/worktrees/app-1`));
    expect(out.tripped).toBe(false);
    out = noteOwnFailure(out.state, REPO, failure("b", REPO, 5));
    expect(out.tripped).toBe(true);
    expect(ownBreakerTripped(out.state, REPO)).toBe(true);
    expect(ownBreakerTripped(out.state, "/other")).toBe(false);
    // a 3rd does not trip it again (one item)
    expect(noteOwnFailure(out.state, REPO, failure("c", REPO, 9)).tripped).toBe(false);
    state = rearmOwnBreaker(out.state, REPO);
    expect(ownBreakerTripped(state, REPO)).toBe(false);
    expect(state.repos[REPO]).toBeUndefined();
  });

  // INSP-R11fix F-3: tripped by session.repo, read by the real path — behind a symlink it never read as tripped
  it("keeps a repository by its real path: tripped through a symlink, read through the real path, and back", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-breaker-"));
    try {
      const real = join(root, "real-repo");
      mkdirSync(real);
      const link = join(root, "linked-repo");
      symlinkSync(real, link);
      expect(breakerRepo(link)).toBe(breakerRepo(real));
      expect(breakerRepo(join(root, "gone"))).toBe(join(root, "gone"));
      let out = noteOwnFailure({ repos: {} }, breakerRepo(link), failure("a", link));
      out = noteOwnFailure(out.state, breakerRepo(link), failure("b", link, 5));
      expect(out.tripped).toBe(true);
      // the path check reads it by the real path (and through the link): tripped
      expect(ownBreakerTripped(out.state, breakerRepo(real))).toBe(true);
      expect(ownBreakerTripped(out.state, breakerRepo(link))).toBe(true);
      // rearmed through the real path, it is rearmed for the link too
      expect(ownBreakerTripped(rearmOwnBreaker(out.state, breakerRepo(real)), breakerRepo(link))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tells the owner what the app did, per session, and the gesture", () => {
    expect(ownFailureCause({ folder: `${W}/.claude/worktrees/app-1`, expected: W }, REPO)).toContain("o app criou uma worktree própria dentro da pasta do OMB");
    expect(ownFailureCause({ folder: `${W}/.claude/worktrees/app-1`, expected: W }, REPO)).toContain("a opção worktree estava LIGADA");
    expect(ownFailureCause({ folder: REPO, expected: W }, REPO)).toBe("o app abriu na raiz do repositório, não na pasta do OMB");
    expect(ownFailureCause({ folder: `${REPO}/.claude/worktrees/reab-496989`, expected: W }, REPO)).toContain("o app abriu em outra worktree");
    const item = ownBreakerItem(REPO, [failure("a", `${W}/.claude/worktrees/app-1`), failure("b", REPO)]);
    expect(item.title).toBe("O app Claude abriu 2 sessões de nuria-platform fora da worktree que o servidor criou: deixe a opção worktree DESLIGADA para sessões novas");
    expect(item.why).toContain('- "a título": o app criou uma worktree própria');
    expect(item.why).toContain("as sessões novas deste repositório vão direto para a CLI (no terminal, fora do app Claude), sem tentar o app de novo");
    expect(item.steps.map((step) => step.text).join(" ")).toContain("Deixe-o DESLIGADO");
  });
});

// R13-dispatch R13-2: 13 creates given up on 06/10, none counted, no item;
// the last two (#9032, 0e2ba7eb and 7d8a26ca) as the ledger has them.
describe("the breaker counts every give-up of the path, and sends the next sessions to the cli (R13-2)", () => {
  const SEEN = "Never skip, bypass or fake the gate; never push to main, never force. | Order of a batch: hotfix/PO/P1 first, ahead of any Cl or infrastructure PR";
  const missed = (id: string, folder: string, at: number, reason: string): OwnFailure => ({ at, sessionId: id, title: "9032 Equipe em massa tickets N1", folder: "", expected: `${REPO}/.claude/worktrees/${folder}`, missed: reason, seen: SEEN });
  const first = missed("0e2ba7eb-dd8d-4a71-9b83-67d65551cf8f", "9032-equipe-em-massa-tickets-n1", 1791325667722, "the app's link did not open a new session for 9032-equipe-em-massa-tickets-n1 (no empty task field); nothing was clicked or typed");
  const second = missed("7d8a26ca-ad00-4b4b-9e6f-7ad337084ab6", "9032-equipe-em-massa-tickets-n1-7d8a26", 1791327408569, "the app's link did not open a new session for 9032-equipe-em-massa-tickets-n1-7d8a26 (no empty task field); nothing was clicked or typed");

  it("trips on the 2nd give-up in a row in the repository, and the owner's item says what the screen showed", () => {
    let out = noteOwnFailure({ repos: {} }, REPO, first);
    expect(out.tripped).toBe(false);
    out = noteOwnFailure(out.state, REPO, second);
    expect(out.tripped).toBe(true);
    const item = ownBreakerItem(REPO, out.state.repos[REPO]!.failures);
    expect(item.title).toBe("O app Claude não abriu 2 sessões seguidas de nuria-platform na worktree que o servidor criou: as próximas vão direto para a CLI até você conferir o app");
    expect(item.why).toContain('- "9032 Equipe em massa tickets N1": o link do app não abriu uma sessão nova (a tela mostrou uma conversa, sem o campo vazio de tarefa) (a tela mostrou: Never skip, bypass');
    expect(item.why).toContain("vão direto para a CLI");
    expect(item.steps.map((step) => step.text).join(" ")).toContain("Descreva algo para criar");
    // the chips of the folder before (b3a17a95, 06/10 14:36Z) said as such
    expect(ownFailureCause({ folder: "", expected: "x", missed: "the new session does not show the folder 9384-hook-v2-7-c2b-append-atendimento-b7fcd0 in its chips; nothing was clicked or typed" }, REPO)).toContain("a sessão nova mostrou outra pasta nos chips (a da sessão anterior)");
  });

  it("sends new sessions to the cli only while tripped with the owner asked, until the item is resolved (rearmed)", () => {
    let out = noteOwnFailure({ repos: {} }, REPO, first);
    expect(ownBreakerCli(out.state, REPO)).toBeNull();
    out = noteOwnFailure(out.state, REPO, second);
    // tripped, nobody asked yet (no conversation held the item): the old way still runs, so a create that works rearms it
    expect(ownBreakerCli(out.state, REPO)).toBeNull();
    const asked: OwnBreakerState = { repos: { [REPO]: { ...out.state.repos[REPO]!, itemId: "o40" } } };
    const said = ownBreakerCli(asked, REPO);
    expect(said).toContain("o app Claude não abriu as últimas 2 sessões de nuria-platform na worktree que o servidor cria (disjuntor desde 06/10");
    expect(said).toContain("as sessões novas vão direto para a CLI até o dono resolver o item");
    expect(ownBreakerCli(asked, "/other")).toBeNull();
    expect(ownBreakerCli(rearmOwnBreaker(asked, REPO), REPO)).toBeNull();
  });
});

describe("worktrees left by failed sessions (R11-1)", () => {
  it("are told 'da sessão falhada X' (or never used), with the command; nothing removed", () => {
    const sessions = [
      { id: "f1aaaaaaa", title: "9353 Comprar", repo: REPO, status: "failed", desktop: { own: { path: `${REPO}/.claude/worktrees/9353-comprar`, state: "ready" } } },
      { id: "u2bbbbbbb", title: "9354 Outra", repo: REPO, status: "running", desktop: { own: { path: `${REPO}/.claude/worktrees/9354-outra`, state: "abandoned" } } },
      { id: "ok3cccccc", title: "9355 Viva", repo: REPO, status: "running", desktop: { own: { path: `${REPO}/.claude/worktrees/9355-viva`, state: "ready" } } },
      { id: "gone4dddd", title: "9356 Sumiu", repo: REPO, status: "failed", desktop: { own: { path: `${REPO}/.claude/worktrees/9356-sumiu`, state: "ready" } } },
      { id: "cli5eeeee", title: "9357 CLI", repo: REPO, status: "failed" },
    ];
    const left = leftOwnWorktrees(sessions, (path) => !path.endsWith("9356-sumiu"));
    expect(left.map((each) => [each.sessionId, each.why])).toEqual([["f1aaaaaaa", "failed"], ["u2bbbbbbb", "unused"]]);
    expect(left[0]!.command).toBe(`git -C ${REPO} worktree remove ${REPO}/.claude/worktrees/9353-comprar`);
    const report = leftWorktreesReport(left)!;
    expect(report).toContain(`- ${REPO}/.claude/worktrees/9353-comprar: da sessão falhada "9353 Comprar" (f1aaaaaa)`);
    expect(report).toContain('criada para a sessão "9354 Outra" (u2bbbbbb), que não a usou');
    expect(report).toContain("O servidor não remove nada");
    expect(report).not.toMatch(/--force/);
    expect(leftWorktreesReport([])).toBeNull();
  });
});

describe("the V report", () => {
  it("has a section with what the server's worktrees saved, why some were not cloned, the seeds, and that nothing is removed", () => {
    const worktrees = ownSummary([
      { at: 1, sessionId: "a", repo: REPO, path: "/p1", branch: "b", mode: "cloned", savedKb: 2_400_000, savedMs: 14 * 60_000 },
      { at: 2, sessionId: "b", repo: REPO, path: "/p2", branch: "b", mode: "install", reason: "a semente de dependências ainda não está pronta (só 3,3 GiB livres; instalo a semente com 10 GiB ou mais)" },
    ], [{ repo: REPO, path: "/s", state: "waiting", reason: "só 3,3 GiB livres", head: "c360ee2a2ffff" }], 0, 10);
    const lines = worktreeLines({ worktrees } as ProductivityReport);
    expect(lines).toContain("## Worktrees criadas pelo OMB (clone APFS)");
    expect(lines).toContain("- Criadas: 2; com dependências clonadas da semente: 1; a sessão instalou (npm ci, pnpm install…): 1");
    expect(lines.find((line) => line.startsWith("- Economia dos clones:"))).toMatch(/^- Economia dos clones: 2,3 GB que não foram gravados em disco e 14 ?min/);
    expect(lines).toContain("- Sem clone, 1×: a semente de dependências ainda não está pronta (só N GiB livres; instalo a semente com N GiB ou mais)");
    expect(lines).toContain("- Semente de nuria-platform: esperando em `c360ee2a2` — só 3,3 GiB livres");
    expect(lines.at(-1)).toBe("- O servidor nunca remove worktrees: só relata.");
    expect(worktreeLines({} as ProductivityReport)).toEqual([]);
    expect(worktreeLines({ worktrees: ownSummary([], [], 0, 1) } as ProductivityReport)).toContain("Nenhuma worktree criada pelo servidor no período.");
  });
});

describe("the folder the app is given", () => {
  it("is an alias outside .claude/worktrees, and reading a record resolves it to the worktree", () => {
    const dir = temp();
    const worktree = join(dir, "repo", ".claude", "worktrees", "9353-x");
    mkdirSync(worktree, { recursive: true });
    const link = ownLinkPath(join(dir, "repo"), "9353-x");
    // next to the repository, never in the data dir
    expect(link).toBe(join(dir, ".omb-worktree-links", "repo", "9353-x"));
    expect(link.includes("/.claude/worktrees/")).toBe(false);
    expect(ensureLink(link, worktree)).toBeNull();
    expect(ensureLink(link, worktree)).toBeNull(); // kept
    expect(canonicalFolder(link)).toBe(worktree);
    expect(canonicalFolder(worktree)).toBe(worktree);
    expect(canonicalFolder("/x/.omb-worktree-links/missing")).toBe("/x/.omb-worktree-links/missing");
    // something else in its place is never replaced
    const other = join(dir, ".omb-worktree-links", "repo", "busy");
    mkdirSync(other, { recursive: true });
    expect(ensureLink(other, worktree)).toContain("já existe e não aponta para");
    expect(existsSync(other)).toBe(true);
  });

  it("is a folder the app's link keeps, while the worktree's own path is mapped back to the root by it", () => {
    const repo = "/Users/osvaldo/Projetos/nuria-platform";
    const worktree = `${repo}/.claude/worktrees/9353-x`;
    // the app's rule (vIn) on the worktree itself: the repository root — why the alias exists
    expect(appLinkFolder(worktree)).toBe(repo);
    expect(appLinkFolder(`${repo}/.Claude/Worktrees/9353-x`)).toBe(repo);
    // on the alias: kept as it is
    const link = ownLinkPath(repo, "9353-x");
    expect(link).toBe("/Users/osvaldo/Projetos/.omb-worktree-links/nuria-platform/9353-x");
    expect(appLinkFolder(link)).toBe(link);
  });
});
