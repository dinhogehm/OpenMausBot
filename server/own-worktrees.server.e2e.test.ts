import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { parseWorktreeList } from "./nested-worktrees.ts";
import { SEED_DIR, SEED_LOCK_REASON } from "./own-worktrees.ts";
import { waitForExit } from "./testing/cleanup.ts";

// Lote X through the real server, on a temporary repository: an app
// session's start waits in the ledger with its worktree planned; the server
// makes the seed (a stand-in install), makes the worktree, clones its caches
// once the seed is ready, and says what that saved in /api/worktrees/own and
// in the V report. The create's screen step is a day away (nextAttemptAt),
// so this test never reaches the screen of the Mac it runs on.

const GIT_DIR = ["/usr/bin", "/bin"].find((dir) => existsSync(join(dir, "git"))) ?? "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();

it.runIf(process.platform === "darwin")("makes the planned worktree and the seed, clones, reports the savings — and never touches the screen", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-own-server-"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  const made = join(root, "nuria-platform");
  mkdirSync(made, { recursive: true });
  execFileSync("git", ["init", "--quiet", "-b", "main", made]);
  for (const [key, value] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) git(made, "config", key!, value!);
  writeFileSync(join(made, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(made, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(made, ".gitignore"), ".claude/*\nnode_modules/\n");
  git(made, "add", "-A");
  git(made, "commit", "--quiet", "-m", "init");
  git(made, "remote", "add", "origin", origin);
  git(made, "push", "--quiet", "-u", "origin", "main");
  const repo = realpathSync(made);

  const env = { ...process.env, OMB_AUTONOMY_TICK_MS: "200", OMB_AUTONOMY_MINUTE_MS: "200", OMB_TEST_GRANT_PATH: GIT_DIR };
  const fixture = await launchVerificationServer(env);
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string) => request(path, { method: "GET" }, url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  const boot = async () => {
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(env, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
  };
  const ledger = () => JSON.parse(readFileSync(join(dataDir, "cc-sessions.json"), "utf8")).sessions as any[];
  const own = () => { try { return JSON.parse(readFileSync(join(dataDir, "own-worktrees.json"), "utf8")); } catch { return { seeds: {}, events: [] }; } };
  try {
    const bot = (await runControlOmb(["new-bot", "--name", "Eng", "--url", url]) as any).bot;
    const thread = bot.activeTaskId ?? bot.threadId;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    // a stand-in for npm ci: node_modules with a file of 2 MiB
    writeFileSync(join(dataDir, "own-worktrees-settings.json"), JSON.stringify({
      minFreeGiB: 0,
      install: [process.execPath, "-e", "const fs=require('fs');fs.mkdirSync('node_modules/dep',{recursive:true});fs.writeFileSync('node_modules/dep/index.bin',require('crypto').randomBytes(2*1024*1024))"],
    }));
    const now = Date.now();
    const session = (id: string, title: string, dir: string) => ({
      id, ownerBotId: bot.id, ownerThreadId: thread, title, repo, permissionMode: "auto", worktree: dir, surface: "app", status: "running", turns: 0, costUsd: 0, queued: [], createdAt: now, lastActivityAt: now,
      desktop: {
        marker: `OMB${id.toUpperCase()}`, turnsSeen: 0, issue: title.split(" ")[0], folderGuarded: true,
        // the screen step a day away: nothing in this test opens the app
        pending: { kind: "create", text: "classic", since: now, attempts: 0, nextAttemptAt: now + 24 * 3_600_000 },
        own: { path: join(repo, ".claude", "worktrees", dir), branch: `omb/${dir}`, state: "planned", brief: "faça X", classicText: "classic" },
      },
    });
    writeFileSync(join(dataDir, "cc-sessions.json"), JSON.stringify({ sessions: [session("s9353", "9353 Comprar assentos", "9353-comprar-assentos")] }));
    // the owner's "destravar o app" item of the old way: no gesture is needed any more
    writeFileSync(join(dataDir, "bot-autonomy.json"), JSON.stringify({ wakes: [], goals: [], reports: [], inFlight: [], ownerPending: [
      { id: "o8", botId: bot.id, threadId: thread, title: "Destravar o app Claude (pasta reaproveitada)", key: "app-reused-folder:nuria-platform", createdAt: now - 3_600_000, stepsAutoAskedAt: now - 3_600_000 },
    ] }));
    await boot();
    await expect.poll(() => (JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")).ownerPending ?? []).filter((item: any) => item.id === "o8" && !item.resolvedAt).length, { timeout: 20_000, interval: 300 }).toBe(0);
    await expect.poll(() => readFileSync(logPath, "utf8"), { timeout: 5_000 }).toContain(`the owner's "destravar o app" item (app-reused-folder:nuria-platform) is closed: the server now makes each session's worktree`);

    // the seed: made, locked, installed; the worktree: made from origin/main
    await expect.poll(() => own().seeds[repo]?.state, { timeout: 60_000, interval: 300 }).toBe("ready");
    await expect.poll(() => ledger().find((each) => each.id === "s9353")?.desktop?.own?.state, { timeout: 60_000, interval: 300 }).toBe("ready");
    const first = ledger().find((each) => each.id === "s9353");
    expect(first.desktop.own.head).toBe(git(repo, "rev-parse", "origin/main"));
    // next to the repository (inside the review hook's ~/Projetos scope in real life), never in the data dir
    expect(first.desktop.own.link).toBe(join(dirname(repo), ".omb-worktree-links", "nuria-platform", "9353-comprar-assentos"));
    expect(first.desktop.own.link.startsWith(dataDir)).toBe(false);
    expect(first.desktop.pending.text).toContain(`Rode \`pwd -P\`. Se a saída não for exatamente ${join(repo, ".claude", "worktrees", "9353-comprar-assentos")}`);
    const listed = parseWorktreeList(git(repo, "worktree", "list", "--porcelain"));
    expect(listed.map((entry) => entry.path)).toContain(join(repo, ".claude", "worktrees", "9353-comprar-assentos"));
    expect(listed.find((entry) => entry.path === join(repo, SEED_DIR))).toMatchObject({ locked: true, lockReason: SEED_LOCK_REASON });

    // a second start, once the seed is ready: its caches are cloned
    await waitForExit(restarted!, { signal: "SIGTERM" });
    writeFileSync(join(dataDir, "cc-sessions.json"), JSON.stringify({ sessions: [...ledger(), session("s9354", "9354 Outra", "9354-outra")] }));
    await boot();
    await expect.poll(() => ledger().find((each) => each.id === "s9354")?.desktop?.own?.state, { timeout: 60_000, interval: 300 }).toBe("ready");
    const second = ledger().find((each) => each.id === "s9354");
    expect(second.desktop.own.caches).toMatchObject({ mode: "cloned", dirs: ["node_modules"] });
    // hooks checked (here git's own, shared): only then "do not install"
    expect(second.desktop.own.caches.hooks).toBeTruthy();
    expect(second.desktop.pending.text).toContain("Não rode `npm ci` no começo");
    expect(readFileSync(join(repo, ".claude", "worktrees", "9354-outra", "node_modules", "dep", "index.bin")).length).toBe(2 * 1024 * 1024);

    // what it saved, for the metrics and the V report
    const metrics = await api("/api/worktrees/own");
    expect(metrics.summary).toMatchObject({ cloned: 1, failed: 0 });
    expect(metrics.summary.created).toBeGreaterThanOrEqual(2);
    expect(metrics.summary.savedKb).toBeGreaterThanOrEqual(2 * 1024);
    expect(metrics.summary.seeds[0]).toMatchObject({ repo, state: "ready" });
    const day = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const report = await api(`/api/reports/productivity?granularity=day&from=${day}&to=${day}`);
    expect(report.worktrees).toMatchObject({ cloned: 1 });

    // the screen was never touched; nothing was removed
    const log = readFileSync(logPath, "utf8");
    expect(log).not.toMatch(/\[claude-desktop\] create start/);
    expect(log).toContain("[own-worktrees]");
    for (const dir of ["9353-comprar-assentos", "9354-outra"]) expect(existsSync(join(repo, ".claude", "worktrees", dir, ".git"))).toBe(true);
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" }).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
