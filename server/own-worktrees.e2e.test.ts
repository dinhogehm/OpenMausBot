import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { CcSessionLedger, type CcSession } from "./cc-sessions.ts";
import { findDesktopSession, readDesktopRecord, recordsUsingFolder } from "./claude-desktop.ts";
import { desktopBriefText, followDesktopSessions, ownBriefText, prepareOwnWorktrees, runDesktopWork, type DesktopWorkDeps } from "./desktop-work.ts";
import { parseWorktreeList } from "./nested-worktrees.ts";
import {
  addOwnWorktree, cacheLine, cloneSeedCaches, ensureLink, findCacheDirs, OWN_DEFAULTS, ownLinkPath, OwnWorktreeStore, physicalOffset, planOwnWorktree, realCloneIo, realDirFs, refreshSeed,
  SEED_DIR, SEED_LOCK_REASON, type Exec, type OwnWorktreeSettings,
} from "./own-worktrees.ts";

// Lote X end to end, on a temporary git repository and a temporary HOME:
// real git (origin, fetch, worktree add, lock), a real seed installed by a
// stand-in install, real APFS clones, the desktop flow with a fake app that
// records sessions the way the Claude app does (its cwd is the alias it was
// given). Then origin/main's lockfile changes: the next worktree falls back
// to npm ci saying why, the seed is installed again, and the one after
// clones again. Every command run is recorded: none removes or prunes a
// worktree, and every worktree made is still there at the end.

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const calls: string[][] = [];
const exec: Exec = (file, args, options = {}) => {
  calls.push([file, ...args]);
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, signal: options.signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(String(stdout))));
  });
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();

/** origin (bare) and the main checkout, with npm workspaces' shape: a lockfile, web/. */
function repository(root: string): string {
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  const repo = join(root, "Projetos", "nuria-platform");
  mkdirSync(join(repo, "web"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
  for (const [key, value] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) git(repo, "config", key!, value!);
  writeFileSync(join(repo, "package.json"), '{"name":"x","workspaces":["web"]}\n');
  writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3,"v":1}\n');
  writeFileSync(join(repo, "web", "package.json"), '{"name":"web"}\n');
  writeFileSync(join(repo, ".gitignore"), ".claude/*\nnode_modules/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "-u", "origin", "main");
  return realpathSync(repo);
}

/** What `npm ci` leaves, written by a stand-in: 4 MiB in node_modules, a link in .bin, web's own node_modules. */
const INSTALL = [process.execPath, "-e", [
  "const fs=require('fs');",
  "fs.mkdirSync('node_modules/dep',{recursive:true});fs.mkdirSync('node_modules/.bin',{recursive:true});fs.mkdirSync('web/node_modules/w',{recursive:true});",
  "fs.writeFileSync('node_modules/dep/index.bin',require('crypto').randomBytes(4*1024*1024));",
  "fs.writeFileSync('web/node_modules/w/index.js','module.exports=1');",
  "try{fs.symlinkSync('../dep/index.bin','node_modules/.bin/dep')}catch{}",
  "fs.writeFileSync('node_modules/.installed-from',fs.readFileSync('package-lock.json'));",
].join("")];

it.runIf(process.platform === "darwin")("makes worktrees from origin/main, clones their caches from a seed it keeps fresh, opens the app in them, and never removes one", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-own-e2e-"));
  temps.push(root);
  const home = join(root, "home");
  const dataDir = join(home, ".openmausbot");
  const appSessions = join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
  const projects = join(home, ".claude", "projects");
  mkdirSync(join(appSessions, "org", "acct"), { recursive: true });
  mkdirSync(join(projects, "p"), { recursive: true });
  const repo = repository(root);
  const settings: OwnWorktreeSettings = { ...OWN_DEFAULTS, install: INSTALL, minFreeGiB: 0 };
  const store = new OwnWorktreeStore(join(dataDir, "own-worktrees.json"));
  const admission = join(home, ".nuria", "admission", "intents");
  const releaseBusy = async () => {
    try { return (await import("node:fs")).readdirSync(admission).length ? "o release de produção está na fila da máquina" : null; } catch { return null; }
  };
  const seedDeps = {
    exec, now: Date.now, releaseBusy, freeBytes: () => 100 * 1024 ** 3,
    readFile: (path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
    exists: existsSync,
    findDirs: (path: string, each: OwnWorktreeSettings) => findCacheDirs(path, each.cacheNames, each.extraDirs, realDirFs),
    sizeKb: async (path: string) => Number((await exec("/usr/bin/du", ["-sk", path])).split(/\s+/)[0]) || null,
    node: async () => process.version, log: () => {}, save: (seed: Parameters<typeof store.setSeed>[0]) => store.setSeed(seed),
  };

  // a release queued for the machine: the seed waits, nothing runs
  mkdirSync(admission, { recursive: true });
  writeFileSync(join(admission, String(process.pid)), "release:production:abc");
  const before = calls.length;
  expect((await refreshSeed(repo, settings, store.seed(repo), seedDeps)).state).toBe("waiting");
  expect(calls.length).toBe(before);
  rmSync(join(admission, String(process.pid)));

  // the seed: a locked, detached worktree of origin/main, installed
  const seed = await refreshSeed(repo, settings, store.seed(repo), seedDeps);
  expect(seed).toMatchObject({ state: "ready", lockName: "package-lock.json", dirs: [{ path: "node_modules" }, { path: "web/node_modules" }] });
  const seedEntry = parseWorktreeList(git(repo, "worktree", "list", "--porcelain")).find((entry) => entry.path === join(repo, SEED_DIR));
  expect(seedEntry).toMatchObject({ locked: true, lockReason: SEED_LOCK_REASON });
  expect(git(repo, "status", "--porcelain")).toBe(""); // .claude/* is ignored in the main checkout

  // the flow: ledger, the fake app writing its records, the real folders
  let now = Date.now();
  const ledger = new CcSessionLedger({ path: null, now: () => now });
  const opened: Array<{ folder: string; folderName: string }> = [];
  const deps: DesktopWorkDeps = {
    ledger, now: () => now, getDriver: async () => ({}) as never,
    readRecord: (localId) => readDesktopRecord(localId, appSessions),
    findSession: (marker, since) => findDesktopSession(marker, since, appSessions, projects),
    transcriptOf: () => null, lastText: () => "", turnEnded: () => false, mentions: () => false, writtenAt: () => null,
    repoName: () => "nuria-platform", folderBornAt: () => null,
    folderUsers: (folder, except) => recordsUsingFolder(folder, except, appSessions, true).map((record) => record.title ?? record.sessionId),
    chip: () => {}, report: () => {},
    own: {
      prepare: async (session) => {
        const own = session.desktop!.own!;
        const dir = own.path.split("/").pop()!;
        const made = await addOwnWorktree(session.repo, { dir, path: own.path, branch: own.branch }, exec);
        if (!made.ok) return { ok: false, reason: made.error };
        const link = ownLinkPath(dataDir, session.repo, dir);
        const linkError = ensureLink(link, own.path);
        if (linkError) return { ok: false, reason: linkError };
        const caches = await cloneSeedCaches(store.seed(session.repo), own.path, settings.lockfiles, realCloneIo(exec, async () => process.version));
        store.record({ at: now, sessionId: session.id, repo: session.repo, path: own.path, branch: own.branch, mode: caches.mode, ...(caches.reason ? { reason: caches.reason } : {}), savedKb: caches.savedKb, savedMs: caches.savedMs });
        return { ok: true, head: made.head, link, caches: { mode: caches.mode, ...(caches.reason ? { reason: caches.reason } : {}), dirs: caches.dirs, savedKb: caches.savedKb } };
      },
      briefFor: (session) => ownBriefText(session.title, session.desktop!.marker, session.desktop!.own!.brief, "", session.desktop!.own!, cacheLine(session.desktop!.own!.caches!)),
      classicBlocked: () => null,
    },
    steps: {
      // the Claude app: the link opens a session in the folder it was given; its record keeps that folder
      openIn: async (_driver, input) => {
        opened.push({ folder: input.folder, folderName: input.folderName });
        const session = ledger.all().find((each) => input.text.includes(`[${each.desktop!.marker}]`))!;
        const local = `local_${String(opened.length).padStart(8, "0")}-0000-4000-8000-000000000000`;
        writeFileSync(join(appSessions, "org", "acct", `${local}.json`), JSON.stringify({ sessionId: local, cliSessionId: `cli-${local}`, cwd: input.folder, originCwd: input.folder, createdAt: now, title: session.title }));
        writeFileSync(join(projects, "p", `cli-${local}.jsonl`), `${JSON.stringify({ type: "user", message: { content: input.text } })}\n`);
        return { ok: true };
      },
      create: async () => { throw new Error("New Session must not be used here"); },
    },
  };
  const start = (id: string, title: string): CcSession => {
    const issue = title.split(" ")[0]!;
    const session = ledger.create({ id, ownerBotId: "b", ownerThreadId: "t", title, repo, permissionMode: "auto", surface: "app", desktop: { marker: `OMB${id.toUpperCase()}`, turnsSeen: 0, issue } });
    const plan = planOwnWorktree(repo, { title, issue, sessionId: id }, (each) => existsSync(each.path) || ledger.all().some((other) => other.desktop?.own?.path === each.path))!;
    const classicText = desktopBriefText(title, session.desktop!.marker, "faça", "", now);
    session.desktop!.pending = { kind: "create", text: classicText, since: now, attempts: 0 };
    session.desktop!.own = { path: plan.path, branch: plan.branch, state: "planned", brief: "faça", classicText };
    session.status = "running";
    return session;
  };
  /** One pass of the server for the session just started: make, open, adopt. */
  const open = async (_session: CcSession) => {
    await prepareOwnWorktrees(deps, { preparing: false });
    await runDesktopWork(deps, { busy: false });
    now += 1_000;
    followDesktopSessions(deps);
  };

  // 1st: cloned
  const first = start("aa000001", "9353 Comprar assentos UI");
  await open(first);
  const own1 = first.desktop!.own!;
  expect(own1).toMatchObject({ state: "ready", path: join(repo, ".claude", "worktrees", "9353-comprar-assentos-ui"), branch: "omb/9353-comprar-assentos-ui", caches: { mode: "cloned", dirs: ["node_modules", "web/node_modules"] } });
  expect(own1.head).toBe(git(repo, "rev-parse", "origin/main"));
  // the app was handed the alias, outside .claude/worktrees; the session is the worktree itself
  expect(opened[0]).toEqual({ folder: ownLinkPath(dataDir, repo, "9353-comprar-assentos-ui"), folderName: "9353-comprar-assentos-ui" });
  expect(opened[0]!.folder.includes("/.claude/worktrees/")).toBe(false);
  expect(readlinkSync(opened[0]!.folder)).toBe(own1.path);
  expect(first).toMatchObject({ status: "running", cwd: own1.path, worktree: "9353-comprar-assentos-ui" });
  expect(first.desktop!.wrongFolder).toBeUndefined();
  // the branch does not track origin/main: a bare push can never reach main
  expect(() => git(own1.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow();
  // the caches are clones: the seed's blocks, not copies
  const seedFile = join(repo, SEED_DIR, "node_modules", "dep", "index.bin");
  const at = await physicalOffset(seedFile, exec);
  if (existsSync("/usr/bin/perl")) expect(at).toMatch(/^[0-9a-f]{16}$/);
  if (at) expect(await physicalOffset(join(own1.path, "node_modules", "dep", "index.bin"), exec)).toBe(at);
  expect(lstatSync(join(own1.path, "node_modules", ".bin", "dep")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(own1.path, "web", "node_modules", "w", "index.js"), "utf8")).toBe("module.exports=1");

  // origin/main's lockfile changes (another clone pushes)
  const other = join(root, "other");
  execFileSync("git", ["clone", "--quiet", join(root, "origin.git"), other]);
  for (const [key, value] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) git(other, "config", key!, value!);
  writeFileSync(join(other, "package-lock.json"), '{"lockfileVersion":3,"v":2}\n');
  git(other, "commit", "--quiet", "-am", "bump");
  git(other, "push", "--quiet", "origin", "main");

  // 2nd: from the new origin/main, whose lockfile the seed does not have: the session runs npm ci, told why
  const second = start("bb000002", "9354 Outra coisa");
  await open(second);
  expect(second.desktop!.own).toMatchObject({ state: "ready", caches: { mode: "install" } });
  expect(second.desktop!.own!.caches!.reason).toMatch(/o package-lock.json desta branch \([0-9a-f]{8}\) não é o da semente/);
  expect(existsSync(join(second.desktop!.own!.path, "node_modules"))).toBe(false);
  expect(readFileSync(join(second.desktop!.own!.path, "package-lock.json"), "utf8")).toContain('"v":2');

  // the seed follows origin/main (checkout --force of its own cache, install again)
  const fresh = await refreshSeed(repo, settings, store.seed(repo), seedDeps);
  expect(fresh.state).toBe("ready");
  expect(readFileSync(join(repo, SEED_DIR, "node_modules", ".installed-from"), "utf8")).toContain('"v":2');

  // 3rd: cloned again
  const third = start("cc000003", "9355 Mais uma");
  await open(third);
  expect(third.desktop!.own).toMatchObject({ state: "ready", caches: { mode: "cloned" } });
  expect(third.status).toBe("running");

  // the same issue again later: a folder of its own (the old one stays)
  const again = start("dd000004", "9353 Comprar assentos UI");
  expect(again.desktop!.own!.path).toBe(join(repo, ".claude", "worktrees", "9353-comprar-assentos-ui-dd0000"));

  // archived in the app: nothing is removed
  const record = JSON.parse(readFileSync(join(appSessions, "org", "acct", `${first.desktop!.localId}.json`), "utf8"));
  writeFileSync(join(appSessions, "org", "acct", `${first.desktop!.localId}.json`), JSON.stringify({ ...record, isArchived: true }));
  followDesktopSessions(deps);
  expect(first.status).toBe("archived");

  // what was saved
  // (the flow's clock runs ahead of the wall clock here)
  const summary = store.summary(0, Number.MAX_SAFE_INTEGER);
  expect(summary).toMatchObject({ created: 3, cloned: 2, installed: 1, failed: 0 });
  expect(summary.savedKb).toBeGreaterThanOrEqual(2 * 4 * 1024);

  // never removed: every worktree made is still there, and no command removed, pruned or unlocked one
  const listed = parseWorktreeList(git(repo, "worktree", "list", "--porcelain")).map((entry) => entry.path);
  for (const session of [first, second, third]) {
    expect(listed).toContain(session.desktop!.own!.path);
    expect(existsSync(join(session.desktop!.own!.path, ".git"))).toBe(true);
  }
  expect(listed).toContain(join(repo, SEED_DIR));
  const destructive = calls.filter((call) => call.some((arg) => /^(?:remove|prune|unlock)$/.test(arg)) || (call[0]?.endsWith("rm") ?? false));
  expect(destructive).toEqual([]);
}, 120_000);

it("has no command that removes, prunes or unlocks a worktree anywhere in its code", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of ["own-worktrees.ts", "desktop-work.ts"]) {
    const source = readFileSync(join(here, file), "utf8");
    expect(source).not.toMatch(/"worktree",\s*"(?:remove|prune|unlock)"|worktree (?:remove|prune)|"branch",\s*"-[dD]"/);
  }
  // the one rm in own-worktrees.ts takes back a temporary clone or probe, never a worktree
  const own = readFileSync(join(here, "own-worktrees.ts"), "utf8");
  expect(own.match(/rmSync\(/g)).toHaveLength(1);
  expect(own).toMatch(/dropTemp: \(path\) => rmSync\(path, \{ recursive: true, force: true \}\)/);
  expect([...own.matchAll(/io\.dropTemp\((\w+)\)/g)].map((match) => match[1])).toEqual(["probe", "temp"]);
});
