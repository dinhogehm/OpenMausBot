import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appLinkFolder, breakerRepo, leftOwnWorktrees, leftWorktreesReport, noteOwnFailure, ownBreakerCli, ownBreakerItem, ownBreakerTripped, ownFailureCause, rearmOwnBreaker, type OwnBreakerState, type OwnFailure, cacheLine, canonicalFolder, cloneSeedCaches, ensureLink, findCacheDirs, installFor, installText, lockHash, OWN_DEFAULTS, ownLinkPath, ownSettingsFor, ownSummary, OwnWorktreeStore, planOwnWorktree,
  refreshSeed, savedText, SEED_DIR, SEED_LOCK_REASON, type CloneIo, type Exec, type OwnEvent, type SeedDeps, type SeedState,
  cliDependencyLine, cliWorktreePlan, prepareCliWorktree, pruneDanglingLinks, SEEDED_START_MAX_MS, seededStartChain, type OwnPlan,
  addOwnWorktree, enqueueSeededStart, type SeededSession, groupExec, realCloneIo, interruptedCommand,
  claudeConfigPath, trustFoldersInClaudeConfig, withTrustedFolders,
} from "./own-worktrees.ts";
import { ccTurnArgs } from "./cc-sessions.ts";
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

  // INSP-R13dis 6: every reason the screen steps give now, in pt-BR, and no English left in the owner's item
  it("says every new reason in pt-BR, with no English in the owner's text", () => {
    const cases: Array<[string, string]> = [
      ["the new session shows another folder in its chips (the folder before), not x; nothing was clicked or typed", "a sessão nova mostrou outra pasta nos chips (a da sessão anterior), não a worktree do OMB"],
      ["the new session's folder chip is cut short to a start that another worktree of the repository shares, not only x; nothing was clicked or typed", "o nome da pasta nos chips veio cortado e serve para mais de uma worktree; não dá para saber se é a do OMB"],
      ["the app asks to trust the workspace x again after the server clicked it once in this create; no second click — the create goes on in the cli", "o app pediu de novo para confiar no workspace depois do clique do servidor"],
      ["the app asks to trust the workspace /a/b, not x; nothing was clicked or typed", "o app pediu para confiar em outra pasta (/a/b), não na worktree do OMB; não cliquei"],
      ["the app asks to trust the workspace x, which is not a worktree the server made; nothing was clicked or typed", "o app pediu para confiar numa pasta que não é uma worktree do OMB; não cliquei"],
      ["the app saved the trust for /a/c, not x, after the click; nothing was typed", "o app gravou a confiança para outra pasta (/a/c), não para a worktree do OMB"],
      ["trusted the workspace x; nothing was typed — the app's link is opened again and the folder checked before the brief goes in", "confiei no workspace da worktree do OMB, mas a sessão não abriu nela depois"],
      ["New Session did not show a new session's screen (no empty task field and no folder chips; the screen shows a conversation); nothing was typed", "a sessão nova pelo jeito antigo também não apareceu (a tela mostrou uma conversa)"],
      ["something the server never said before", "o app não abriu a sessão na worktree do OMB (motivo registrado no log do servidor)"],
    ];
    for (const [missed, said] of cases) expect(ownFailureCause({ folder: "", expected: "x", missed }, REPO)).toBe(`${said}; nada foi colado`);
    const item = ownBreakerItem(REPO, cases.map(([missed], i) => ({ at: i, sessionId: `s${i}`, title: `t${i}`, folder: "", expected: "x", missed })));
    expect(item.why).not.toMatch(/\b(?:the|was|nothing|clicked|typed|asks|folder)\b/);
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

// R13-gate G2: `claude -p -w <name>` made bare worktrees; b2d01a's first
// ci:local failed on a missing vite (Cannot find module …/node_modules/vite)
// after ~14 min of the global lease. The server now makes that worktree
// where claude would, seeds it like the app's, and the first turn runs there.
describe("a headless session's worktree, seeded like the app's (R13-gate G2)", () => {
  const session = { id: "b2d01a01-0000-4000-8000-000000000000", worktree: "w", permissionMode: "auto" as const };
  const made = (plans: OwnPlan[]) => async (plan: OwnPlan) => { plans.push(plan); return { ok: true as const, head: "abc" }; };

  it("seed in date: the worktree where claude -w would put it, the caches cloned, the first turn there without -w, and the brief says not to install", async () => {
    const w = cloneWorld();
    const plans: OwnPlan[] = [];
    const out = await prepareCliWorktree(REPO, "w", { add: made(plans), clone: (path) => cloneSeedCaches(w.seed, path, OWN_DEFAULTS.lockfiles, w.io) });
    expect(plans).toEqual([{ dir: "w", path: `${REPO}/.claude/worktrees/w`, branch: "worktree-w" }]);
    expect(cliWorktreePlan(REPO, "w")).toEqual(plans[0]);
    expect(out).toMatchObject({ ok: true, caches: { mode: "cloned", dirs: ["node_modules", "web/node_modules"], hooks: ".husky/_" } });
    const line = cliDependencyLine(out);
    expect(line).toContain("As dependências já estão instaladas nesta worktree: node_modules, web/node_modules");
    expect(line).toContain("Não rode `npm ci` no começo");
    expect(line).not.toContain("ANTES de qualquer");
    const args = ccTurnArgs({ ...session, cliWorktree: { path: `${REPO}/.claude/worktrees/w`, branch: "worktree-w", caches: "cloned" } }, "brief", true);
    expect(args).not.toContain("-w");
    expect(args.slice(0, 3)).toEqual(["-p", "--session-id", session.id]);
  });

  it("seed not in date (another lockfile): nothing cloned, and the brief says to run npm ci in the worktree before any ci:local", async () => {
    const w = cloneWorld({}, { [`${REPO}/.claude/worktrees/w/package-lock.json`]: '{"lockfileVersion":3,"packages":{"x":{}}}' });
    const out = await prepareCliWorktree(REPO, "w", { add: made([]), clone: (path) => cloneSeedCaches(w.seed, path, OWN_DEFAULTS.lockfiles, w.io) });
    expect(out).toMatchObject({ ok: true, caches: { mode: "install", dirs: [] } });
    expect(w.calls).toEqual([]); // nothing copied
    const line = cliDependencyLine(out);
    expect(line).toContain("As dependências NÃO foram clonadas (");
    expect(line).toContain("rode `npm ci` na worktree ANTES de qualquer `npm run ci:local` ou `npm run pr:merge`: sem node_modules o gate reprova à toa (vite ausente)");
  });

  it("worktree not made (git failed): claude -w makes it as before, and the brief still says to install before the gate; a failing clone is an install", async () => {
    const out = await prepareCliWorktree(REPO, "w", { add: async () => ({ ok: false, error: "git worktree add: invalid reference: origin/main" }), clone: async () => { throw new Error("never"); } });
    expect(out).toEqual({ ok: false, reason: "git worktree add: invalid reference: origin/main" });
    const line = cliDependencyLine(out, "pnpm install --frozen-lockfile");
    expect(line).toContain("o servidor não criou a worktree: git worktree add: invalid reference: origin/main");
    expect(line).toContain("rode `pnpm install --frozen-lockfile` na worktree ANTES de qualquer `npm run ci:local`");
    expect(ccTurnArgs(session, "brief", true)).toEqual(expect.arrayContaining(["-w", "w"]));
    const thrown = await prepareCliWorktree(REPO, "w", { add: made([]), clone: async () => { throw new Error("cp: No space left on device"); } });
    expect(thrown).toMatchObject({ ok: true, caches: { mode: "install", reason: "o clone das dependências falhou: cp: No space left on device" } });
    expect(cliDependencyLine(thrown)).toContain("ANTES de qualquer `npm run ci:local`");
  });
});

// R13-dispatch R13-2(d): 06/10, 13 aliases in ~/Projetos/.omb-worktree-links/
// nuria-platform/ pointed at worktrees removed by hand (the 9032 ones among them).
// INSP-R13dis 3 and R2-1: the seeded starts spawn in the order they came,
// and a start that hangs (a clone stuck, git waiting) holds the next ones for
// SEEDED_START_MAX_MS at most: then it goes the old way and the queue moves.
describe("the seeded headless starts: in order, each with a deadline (R2-1)", () => {
  /** Timers run by hand: the ones of `ms` fire when the test says. */
  function clock() {
    const pending = new Map<number, { run: () => void; ms: number }>();
    let next = 0;
    return {
      timers: { set: (run: () => void, ms: number) => { pending.set(++next, { run, ms }); return next; }, clear: (timer: unknown) => { pending.delete(timer as number); } },
      fire: (ms: number) => { for (const [id, each] of Array.from(pending)) if (each.ms === ms) { pending.delete(id); each.run(); } },
      pending: () => Array.from(pending.values(), (each) => each.ms),
    };
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  /** A step that hangs until the start's signal aborts it, then stops a little later (a killed git or cp). */
  const untilAborted = (signal: AbortSignal, log: string[], name: string) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => { log.push(`${name} aborted`); void tick().then(() => { log.push(`${name} stopped`); reject(new Error("killed")); }); });
  });

  it("a start that hangs is aborted at its deadline and waited for until it stopped; only then its late, and only then the next one (R3-2)", async () => {
    const c = clock();
    const enqueue = seededStartChain(SEEDED_START_MAX_MS, c.timers);
    const log: string[] = [];
    let hungLive: () => boolean = () => true;
    void enqueue((live, signal) => { hungLive = live; log.push("hung started"); return untilAborted(signal, log, "hung"); }, (why, stopped) => log.push(`hung late (stopped ${stopped}): ${why}`));
    const second = enqueue(async (live) => { log.push(`second spawned (live ${live()})`); }, (why) => log.push(`second late: ${why}`));
    await tick();
    expect(log).toEqual(["hung started"]);
    expect(c.pending()).toEqual([180_000]);
    expect(hungLive()).toBe(true);
    c.fire(180_000); // 3 min pass
    expect(hungLive()).toBe(false);
    await second;
    expect(log).toEqual(["hung started", "hung aborted", "hung stopped", "hung late (stopped true): a preparação da worktree passou de 180 s", "second spawned (live true)"]);
    expect(c.pending()).toEqual([]);
  });

  it("a start that ignores the abort holds the next one for the grace at most, and its late says it did not stop", async () => {
    const c = clock();
    const enqueue = seededStartChain(SEEDED_START_MAX_MS, c.timers, 60_000);
    const log: string[] = [];
    void enqueue(() => new Promise<void>(() => {}), (_why, stopped) => log.push(`deaf late (stopped ${stopped})`));
    const second = enqueue(async () => { log.push("second spawned"); }, () => log.push("second late"));
    await tick();
    c.fire(180_000);
    await tick();
    expect(log).toEqual([]);
    expect(c.pending()).toEqual([60_000]);
    c.fire(60_000);
    await second;
    expect(log).toEqual(["deaf late (stopped false)", "second spawned"]);
  });

  it("keeps the order of the starts (a P1 first stays first), and a throw is the old way too, the next going on", async () => {
    const c = clock();
    const enqueue = seededStartChain(SEEDED_START_MAX_MS, c.timers);
    const log: string[] = [];
    const slow = (name: string) => async () => { await tick(); await tick(); log.push(name); };
    void enqueue(slow("P1 #9906"), () => log.push("P1 late"));
    void enqueue(() => { throw new Error("git: not found"); }, (why) => log.push(`P2 late: ${why}`));
    const last = enqueue(async () => { log.push("P2 #9905"); }, () => log.push("P2 #9905 late"));
    await last;
    expect(log).toEqual(["P1 #9906", "P2 late: git: not found", "P2 #9905"]);
    // every deadline cleared once its start ended
    expect(c.pending()).toEqual([]);
  });

  // R3-1: the real start (prepareCliWorktree and cloneSeedCaches) with a git or a cp that hangs
  // until the abort kills it — the session never runs in a worktree half made, and no temporary copy stays
  describe("with git or the clone stuck (R3-1)", () => {
    type Outcome = Awaited<ReturnType<typeof prepareCliWorktree>>;
    const session = () => ({ id: "s9905", repo: REPO, worktree: "w", turns: 0, status: "running" });
    function run(world: ReturnType<typeof cloneWorld>, exec: (signal: AbortSignal) => Exec) {
      const c = clock();
      const log: string[] = [];
      const spawned: Array<{ worktree: string; ready: string | null; line: string }> = [];
      const s: SeededSession = session();
      const done = enqueueSeededStart(seededStartChain(SEEDED_START_MAX_MS, c.timers), s, {
        prepare: (repo, name, signal) => prepareCliWorktree(repo, name, {
          add: (plan) => addOwnWorktree(repo, plan, exec(signal)),
          clone: (path) => cloneSeedCaches(world.seed, path, OWN_DEFAULTS.lockfiles, { ...world.io, exec: exec(signal) }),
        }),
        spawn: (each, line, outcome: Outcome) => { log.push(`spawn ${each.worktree} (${outcome.ok ? "ready" : "old way"})`); spawned.push({ worktree: each.worktree, ready: each.cliWorktree?.path ?? null, line }); },
        exists: (path) => world.present.has(path),
        save: () => {},
        log: (line) => log.push(line),
        rename: (name) => `${name}-2b7c`,
      });
      return { c, log, spawned, s, done };
    }
    const WT = `${REPO}/.claude/worktrees/w`;

    it("git worktree add stuck: aborted, waited for; the session goes the old way under a new name, never in the half-made folder, which is told", async () => {
      const w = cloneWorld();
      w.present.delete(WT); // made by the add below
      const r = run(w, (signal) => (async (_file, args) => {
        if (args.includes("rev-parse") && !w.present.has(WT)) throw new Error("not a git repository");
        if (args.includes("worktree") && args.includes("add")) {
          // git writes <path>/.git first, then checks out: it hangs there until killed
          w.present.add(WT);
          w.present.add(`${WT}/.git`);
          await untilAborted(signal, r.log, "git worktree add");
        }
        return "";
      }) as Exec);
      await tick();
      expect(r.spawned).toEqual([]);
      r.c.fire(180_000);
      await r.done;
      expect(r.log.indexOf("git worktree add stopped")).toBeLessThan(r.log.findIndex((line) => line.startsWith("spawn")));
      expect(r.spawned).toHaveLength(1);
      expect(r.spawned[0]).toMatchObject({ worktree: "w-2b7c", ready: null });
      expect(r.spawned[0]!.line).toContain("ANTES de qualquer `npm run ci:local`");
      expect(r.s.cliWorktree).toBeUndefined();
      expect(r.s.cliWorktreeLeft).toEqual({ path: WT, reason: "a preparação da worktree passou de 180 s" });
      // the half-made folder: in the worktree report, for a person (the server removes no worktree)
      const left = leftOwnWorktrees([{ ...r.s, title: "9905 x" }], (path) => w.present.has(path));
      expect(left).toEqual([expect.objectContaining({ path: WT, sessionId: "s9905", why: "interrupted", command: interruptedCommand(REPO, WT, null) })]);
      // the report says what each case needs (INSP-R4-2): a half-made checkout, or a folder git never registered, and the branch
      const said = leftWorktreesReport(left)!;
      expect(said).toContain(`- ${WT}: preparação interrompida (prazo de 180 s) da sessão de CLI "9905 x" (s9905), que seguiu em outra worktree — para remover, depois de conferir com git -C ${REPO} worktree list: confira com git -C ${REPO} worktree list; se ela estiver na lista: git -C ${REPO} worktree remove --force ${WT}; se não estiver: git -C ${REPO} worktree prune, e mova a pasta para o Lixo (mv ${WT} ~/.Trash/); depois, git -C ${REPO} branch -D worktree-w (a branch que o OMB criou para ela). O --force vale SÓ para esta pasta: o OMB a abandonou no meio da preparação (checkout incompleto) e nenhuma sessão a usa`);
    });

    it("the clone stuck in its 2nd folder: the cp killed, its temporary copy taken back (no *.omb-clone left), the session the old way under a new name", async () => {
      const w = cloneWorld();
      const temps: string[] = [];
      w.io.dropTemp = (path) => { w.dropped.push(path); w.present.delete(path); };
      w.io.rename = (from, to) => { w.renamed.push(`${from} -> ${to}`); w.present.delete(from); w.present.add(to); };
      const r = run(w, (signal) => (async (file, args) => {
        if (file === "/usr/bin/nice") {
          const temp = args.at(-1)!;
          w.present.add(temp);
          temps.push(temp);
          w.calls.push([file, ...args]);
          // the 2nd folder's copy never ends until killed
          if (temp.endsWith("web/node_modules.omb-clone")) await untilAborted(signal, r.log, "cp web/node_modules");
          return "";
        }
        if (args.includes("rev-parse")) return args.includes("--abbrev-ref") ? "worktree-w" : args.includes("--show-toplevel") ? WT : "abc";
        return "";
      }) as Exec);
      await tick();
      r.c.fire(180_000);
      await r.done;
      expect(temps).toEqual([`${WT}/node_modules.omb-clone`, `${WT}/web/node_modules.omb-clone`]);
      // nothing named *.omb-clone left in the folder: the killed copy was taken back
      expect([...w.present].filter((path) => path.endsWith(".omb-clone"))).toEqual([]);
      expect(w.dropped).toContain(`${WT}/web/node_modules.omb-clone`);
      expect(r.log.indexOf("cp web/node_modules stopped")).toBeLessThan(r.log.findIndex((line) => line.startsWith("spawn")));
      expect(r.spawned).toEqual([expect.objectContaining({ worktree: "w-2b7c", ready: null })]);
      expect(r.s.cliWorktree).toBeUndefined();
      expect(r.s.cliWorktreeLeft?.path).toBe(WT);
    });

    it("the preparation ending in time: the ready mark set, the first turn in it, nothing renamed", async () => {
      const w = cloneWorld();
      const r = run(w, () => (async (file, args) => {
        if (file === "/usr/bin/nice") { w.present.add(args.at(-1)!); return ""; }
        if (args.includes("rev-parse")) return args.includes("--abbrev-ref") ? "worktree-w" : args.includes("--show-toplevel") ? WT : "abc";
        return "";
      }) as Exec);
      await r.done;
      expect(r.spawned).toEqual([{ worktree: "w", ready: WT, line: expect.stringContaining("já estão instaladas") }]);
      expect(r.s.cliWorktreeLeft).toBeUndefined();
      expect(r.c.pending()).toEqual([]);
    });
  });
});

// INSP-R4-1/R4-3: the preparation's programs stop as a process group, and
// "stopped" is when they have exited (close), not when the abort was sent —
// real processes here: a child slow to leave after SIGTERM, a grandchild
// that ignores it, and a copy that still writes after the TERM.
describe.runIf(process.platform !== "win32")("the preparation's programs, stopped for real (INSP-R4-1, R4-3)", () => {
  const dirs: string[] = [];
  // every test's controllers aborted at its end, and each program bounded by WAIT_MS (groupExec kills its group then):
  // a "ready" that never comes leaves no detached child behind (INSP-R6-1)
  const controllers: AbortController[] = [];
  const ctl = () => { const controller = new AbortController(); controllers.push(controller); return controller; };
  const WAIT_MS = 4_000;
  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.abort();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const temp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "omb-group-"))); dirs.push(dir); return dir; };
  // No clock in these (INSP-R5-2: time-based tests stopped production at #9391): each child prints
  // "ready" once its trap is armed, the abort comes only after that line, and what is checked is
  // ORDER — the child's own last write exists when the promise settles.
  /** groupExec that aborts `controller` once the program printed "ready". */
  const abortOnReady = (controller: AbortController, killAfterMs?: number) => groupExec(process.env, killAfterMs, { output: (text) => { if (text.includes("ready")) controller.abort(); } });

  it("settles on close: a child still working after the SIGTERM is waited for — its last write is there when the promise settles", async () => {
    const dir = temp();
    const controller = ctl();
    const run = abortOnReady(controller)("/bin/sh", ["-c", `trap 'sleep 0.3; touch "${dir}/child-exited"; exit 1' TERM; echo ready; while :; do sleep 0.05; done`], { signal: controller.signal, timeoutMs: WAIT_MS });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(join(dir, "child-exited"))).toBe(true);
  });

  it("waits for a grandchild that ignores the TERM and still holds the output (a git hook); a group deaf to TERM is killed (SIGKILL) before its end", async () => {
    const dir = temp();
    const controller = ctl();
    const run = abortOnReady(controller)("/bin/sh", ["-c", `(trap '' TERM; echo ready; sleep 0.3; touch '${dir}/hook-done') & wait`], { signal: controller.signal, timeoutMs: WAIT_MS });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    // settled only once the grandchild had finished
    expect(existsSync(join(dir, "hook-done"))).toBe(true);
    // deaf to the TERM: the SIGKILL ends it — it never reaches its last line
    const deaf = ctl();
    const stuck = abortOnReady(deaf, 100)("/bin/sh", ["-c", `trap '' TERM; echo ready; sleep 30; touch '${dir}/deaf-finished'`], { signal: deaf.signal, timeoutMs: WAIT_MS });
    await expect(stuck).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(join(dir, "deaf-finished"))).toBe(false);
  });

  it("keeps a UTF-8 character split between two chunks whole (INSP-R5-1), and says when the output passes its cap", async () => {
    // "ç" is C3 A7: its two bytes in two writes, apart
    expect(await groupExec()("/bin/sh", ["-c", "printf 'a\\303'; sleep 0.2; printf '\\247o\\n'"])).toBe("aço\n");
    const told: string[] = [];
    const big = await groupExec(process.env, undefined, { overflow: (line) => told.push(line) })("/bin/sh", ["-c", "head -c 17825792 /dev/zero | tr '\\0' 'x'"]);
    expect(big.length).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(big.length).toBeLessThan(17825792);
    expect(told).toEqual(["/bin/sh: stdout passed 16 MB; the rest of it is not kept"]);
  });

  it("runs as an Exec otherwise: its output, a failure with its stderr, a timeout", async () => {
    expect(await groupExec()("/bin/sh", ["-c", "echo ok"])).toBe("ok\n");
    await expect(groupExec()("/bin/sh", ["-c", "echo nope >&2; exit 3"])).rejects.toMatchObject({ stderr: "nope\n" });
    await expect(groupExec()("/bin/sh", ["-c", "sleep 5"], { timeoutMs: 100 })).rejects.toThrow("passou de 0 s");
    const aborted = new AbortController();
    aborted.abort();
    await expect(groupExec()("/bin/sh", ["-c", "echo never"], { signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("the queue waits for that child before its late and before the next start (the deadline fired by hand, once the child is ready)", async () => {
    const dir = temp();
    const timers = new Map<number, { run: () => void; ms: number }>();
    let id = 0;
    const enqueue = seededStartChain(SEEDED_START_MAX_MS, { set: (run, ms) => { timers.set(++id, { run, ms }); return id; }, clear: (timer) => { timers.delete(timer as number); } });
    const log: string[] = [];
    let ready: () => void = () => {};
    const isReady = new Promise<void>((resolve) => { ready = resolve; });
    const watching = groupExec(process.env, undefined, { output: (text) => { if (text.includes("ready")) ready(); } });
    void enqueue((_live, signal) => watching("/bin/sh", ["-c", `trap 'sleep 0.3; touch "${dir}/child-exited"; exit 1' TERM; echo ready; while :; do sleep 0.05; done`], { signal, timeoutMs: WAIT_MS }).then(() => {}), (_why, stopped) => log.push(`late (stopped ${stopped}; child exited ${existsSync(join(dir, "child-exited"))})`));
    const next = enqueue(async () => { log.push(`next (child exited ${existsSync(join(dir, "child-exited"))})`); }, () => {});
    await isReady;
    for (const [key, each] of Array.from(timers)) if (each.ms === SEEDED_START_MAX_MS) { timers.delete(key); each.run(); }
    await next;
    expect(log).toEqual(["late (stopped true; child exited true)", "next (child exited true)"]);
  });

  it("an aborted clone whose copy still writes after the TERM leaves no *.omb-clone and no probe: taken back after the copy exited (R4-3)", async () => {
    const root = temp();
    const seedPath = join(root, "seed");
    const worktree = join(root, "w");
    for (const dir of ["node_modules", "web/node_modules"]) mkdirSync(join(seedPath, dir), { recursive: true });
    mkdirSync(join(worktree, "web"), { recursive: true });
    writeFileSync(join(worktree, "package-lock.json"), LOCK);
    const seed: SeedState = { repo: root, path: seedPath, state: "ready", lockName: "package-lock.json", lockHash: lockHash(LOCK), node: "v22.19.0", installMs: 60_000, dirs: [{ path: "node_modules", kb: 10 }, { path: "web/node_modules", kb: 10 }] };
    const controller = ctl();
    const group = abortOnReady(controller);
    const exec: Exec = (file, args, options = {}) => {
      if (file !== "/usr/bin/nice") return Promise.resolve("");
      const dst = args.at(-1)!;
      // the 1st folder copies at once; the 2nd one says "ready" with its trap armed, and keeps writing after the TERM
      const script = dst.endsWith("web/node_modules.omb-clone")
        ? `mkdir -p '${dst}'; echo a > '${dst}/a'; trap "echo b > '${dst}/b-after-term'; sleep 0.3; echo c > '${dst}/c-after-term'; touch '${root}/copy-exited'; exit 1" TERM; echo ready; while :; do sleep 0.05; done`
        : `mkdir -p '${dst}'; echo a > '${dst}/a'`;
      return group("/bin/sh", ["-c", script], { ...options, signal: controller.signal, timeoutMs: WAIT_MS });
    };
    const real = realCloneIo(exec, async () => "v22.19.0");
    // the order that matters: each temporary copy is taken back after its cp has exited
    const drops: string[] = [];
    const io: CloneIo = { ...real, device: () => 7, cloneFile: async (_src, dst) => { writeFileSync(dst, "probe"); return null; }, hooks: async () => null, listDir: () => null, dropTemp: (path) => { if (path.endsWith("web/node_modules.omb-clone") && existsSync(path)) drops.push(`web copy taken back (cp exited ${existsSync(join(root, "copy-exited"))})`); real.dropTemp(path); } };
    const out = await cloneSeedCaches(seed, worktree, OWN_DEFAULTS.lockfiles, io);
    expect(drops).toEqual(["web copy taken back (cp exited true)"]);
    expect(out).toMatchObject({ mode: "install", dirs: ["node_modules"] });
    expect(out.reason).toContain("o clone de web/node_modules falhou");
    const left: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); left.push(path); if (!name.includes(".") && existsSync(path) && readdirSync(path, { withFileTypes: true }).length >= 0) { try { walk(path); } catch { /* a file */ } } } };
    walk(worktree);
    expect(left.filter((path) => path.includes(".omb-clone"))).toEqual([]);
    expect(existsSync(join(worktree, "node_modules", "a"))).toBe(true);
  });
});

// INSP-R4-2: the commands for a folder a seeded start left: a plain remove
// refuses an interrupted checkout; a folder git never registered is "not a
// working tree"; and its branch stays.
describe("the report's commands for a folder a seeded start left (INSP-R4-2)", () => {
  const R = "/Users/o/Projetos/nuria-platform";
  const P = `${R}/.claude/worktrees/9905-x-6d2776`;
  it("--force only for that registered folder, prune and the Trash when git never registered it, both when git cannot say; the branch always", () => {
    expect(interruptedCommand(R, P, true)).toBe(`git -C ${R} worktree remove --force ${P}; depois, git -C ${R} branch -D worktree-9905-x-6d2776 (a branch que o OMB criou para ela). O --force vale SÓ para esta pasta: o OMB a abandonou no meio da preparação (checkout incompleto) e nenhuma sessão a usa`);
    const unlisted = interruptedCommand(R, P, false);
    expect(unlisted).toContain(`git -C ${R} worktree prune, e mova a pasta para o Lixo (mv ${P} ~/.Trash/)`);
    expect(unlisted).not.toContain("remove --force");
    expect(unlisted).not.toMatch(/\brm\b/);
    const unknown = interruptedCommand(R, P, null);
    expect(unknown).toContain(`confira com git -C ${R} worktree list; se ela estiver na lista: git -C ${R} worktree remove --force ${P}; se não estiver: git -C ${R} worktree prune`);
    for (const text of [unlisted, unknown]) expect(text).toContain(`branch -D worktree-9905-x-6d2776`);
    // a path with a space is quoted
    expect(interruptedCommand("/a b/repo", "/a b/repo/.claude/worktrees/x", true)).toContain("worktree remove --force '/a b/repo/.claude/worktrees/x'");
  });

  it("asks git which case it is when it can (by real path), and leaves the app's own worktrees' line as it was", () => {
    const sessions = [
      { id: "s1", title: "cli", repo: R, status: "running", cliWorktreeLeft: { path: P } },
      { id: "s2", title: "app", repo: R, status: "failed", desktop: { own: { path: `${R}/.claude/worktrees/9353-x`, state: "ready" } } },
    ];
    const listed = leftOwnWorktrees(sessions, () => true, () => [P]);
    expect(listed[0]).toMatchObject({ why: "interrupted", command: interruptedCommand(R, P, true) });
    expect(listed[1]).toMatchObject({ why: "failed", command: `git -C ${R} worktree remove ${R}/.claude/worktrees/9353-x` });
    expect(leftOwnWorktrees(sessions, () => true, () => [])[0]!.command).toBe(interruptedCommand(R, P, false));
    expect(leftOwnWorktrees(sessions, () => true, () => null)[0]!.command).toBe(interruptedCommand(R, P, null));
  });
});

describe("the aliases whose worktree is gone (R13-2d)", () => {
  it("are removed, and only they: a live alias, a session's own, a plain folder or file, another repository's stay", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-links-")));
    try {
      const repo = join(root, "Projetos", "nuria-platform");
      const links = join(root, "Projetos", ".omb-worktree-links", "nuria-platform");
      const others = join(root, "Projetos", ".omb-worktree-links", "outro");
      mkdirSync(links, { recursive: true });
      mkdirSync(others, { recursive: true });
      const worktree = (name: string) => { const path = join(repo, ".claude", "worktrees", name); mkdirSync(path, { recursive: true }); return path; };
      // 13 gone, as on 06/10
      const gone = Array.from({ length: 13 }, (_, i) => `93${String(i).padStart(2, "0")}-gone`);
      for (const name of gone) symlinkSync(join(repo, ".claude", "worktrees", name), join(links, name));
      symlinkSync(worktree("9398-live"), join(links, "9398-live"));
      symlinkSync(join(repo, ".claude", "worktrees", "9032-kept"), join(links, "9032-kept"));
      symlinkSync("../../nuria-platform/.claude/worktrees/rel-gone", join(links, "rel-gone"));
      symlinkSync("../../nuria-platform/.claude/worktrees/9398-live", join(links, "rel-live"));
      mkdirSync(join(links, "a-folder"));
      writeFileSync(join(links, "a-file"), "x");
      symlinkSync(join(root, "nowhere"), join(others, "gone-elsewhere"));
      const removed = pruneDanglingLinks(repo, new Set([join(links, "9032-kept")]));
      expect(removed.map((path) => path.split("/").pop()).sort()).toEqual([...gone, "rel-gone"].sort());
      expect(readdirSync(links).sort()).toEqual(["9032-kept", "9398-live", "a-file", "a-folder", "rel-live"]);
      expect(readdirSync(others)).toEqual(["gone-elsewhere"]);
      // the worktrees themselves untouched; nothing more to remove the second time
      expect(existsSync(join(repo, ".claude", "worktrees", "9398-live"))).toBe(true);
      expect(pruneDanglingLinks(repo, new Set([join(links, "9032-kept")]))).toEqual([]);
      // no alias folder at all: nothing
      expect(pruneDanglingLinks(join(root, "Projetos", "sem-links"), new Set())).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("our worktree trusted in the Claude app's config before its link (o92)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const ALIAS = "/Users/o/Projetos/.omb-worktree-links/nuria-platform/9463-faixa";
  const REAL = "/Users/o/Projetos/nuria-platform/.claude/worktrees/9463-faixa";

  it("the config's path: CLAUDE_CONFIG_DIR, else the home", () => {
    expect(claudeConfigPath({}, "/Users/o")).toBe("/Users/o/.claude.json");
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/Users/o")).toBe("/cfg/.claude.json");
  });

  it("sets hasTrustDialogAccepted on both folders, keeps every other key and entry, and says when nothing changed", () => {
    const config = { numStartups: 7, projects: { [ALIAS]: { allowedTools: ["x"] }, "/other": { hasTrustDialogAccepted: false } } };
    const { config: next, changed } = withTrustedFolders(config, [ALIAS, REAL]);
    expect(changed).toBe(true);
    expect(next).toEqual({ numStartups: 7, projects: { [ALIAS]: { allowedTools: ["x"], hasTrustDialogAccepted: true }, [REAL]: { hasTrustDialogAccepted: true }, "/other": { hasTrustDialogAccepted: false } } });
    // the input is not touched
    expect(config.projects[ALIAS]).toEqual({ allowedTools: ["x"] });
    expect(withTrustedFolders(next, [ALIAS, REAL]).changed).toBe(false);
    expect(withTrustedFolders(null, [ALIAS])).toEqual({ config: { projects: { [ALIAS]: { hasTrustDialogAccepted: true } } }, changed: true });
  });

  it("writes the file only when something changed, keeps its mode, and never overwrites one that does not parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-claudecfg-"));
    dirs.push(dir);
    const file = join(dir, ".claude.json");
    writeFileSync(file, JSON.stringify({ userID: "u", projects: {} }), { mode: 0o600 });
    expect(trustFoldersInClaudeConfig(file, [ALIAS, REAL])).toBeNull();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toEqual({ userID: "u", projects: { [ALIAS]: { hasTrustDialogAccepted: true }, [REAL]: { hasTrustDialogAccepted: true } } });
    expect(statMode(file)).toBe(0o600);
    const before = readFileSync(file, "utf8");
    expect(trustFoldersInClaudeConfig(file, [ALIAS])).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(before);
    writeFileSync(file, "{ broken");
    expect(trustFoldersInClaudeConfig(file, [ALIAS])).toContain("could not read");
    expect(readFileSync(file, "utf8")).toBe("{ broken");
    // no file yet: made, private
    const fresh = join(dir, "new", ".claude.json");
    mkdirSync(join(dir, "new"));
    expect(trustFoldersInClaudeConfig(fresh, [REAL])).toBeNull();
    expect(JSON.parse(readFileSync(fresh, "utf8"))).toEqual({ projects: { [REAL]: { hasTrustDialogAccepted: true } } });
    expect(statMode(fresh)).toBe(0o600);
  });
});

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
