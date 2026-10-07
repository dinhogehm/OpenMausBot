import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

// R11-dispatch R11-1 through the real server. Two sessions opened through
// the server's worktree land in a worktree the app made INSIDE it (its
// worktree option on): both fail at adoption, the 2nd trips the breaker, the
// owner gets one item with the diagnosis, and the disk report lists the two
// worktrees "da sessão falhada". Then a start from the queue goes straight
// to the cli (R13-dispatch R13-2: on 06/10 the old way failed along with the
// app's link every time) — no app, no worktree of the server's, no 409.
// Resolving the owner's item rearms it. No create ever reaches the screen:
// the sessions were already sent, and the one start runs headless (a stand-in
// cli that does nothing).

const GIT_DIR = ["/usr/bin", "/bin"].find((dir) => existsSync(join(dir, "git"))) ?? "";

it.runIf(process.platform === "darwin")("two sessions in the app's own worktree trip the breaker: one owner item, the next start straight to the cli, worktrees told; the item resolved rearms it", async () => {
  // a stand-in cli that only writes down where it ran and with what (R13-gate G2: the first turn's cwd and argv)
  const bin = mkdtempSync(join(tmpdir(), "omb-fake-cc-"));
  const turns = join(bin, "turns.txt");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\n{ pwd -P; for arg in "$@"; do printf '%s\\n' "$arg"; done; echo ---; } >> '${turns}'\n`, { mode: 0o755 });
  const env = { ...process.env, OMB_AUTONOMY_TICK_MS: "200", OMB_AUTONOMY_MINUTE_MS: "200", OMB_TEST_GRANT_PATH: GIT_DIR, OMB_CC_BIN: join(bin, "claude") };
  const fixture = await launchVerificationServer(env);
  const { url, dataDir, logPath } = fixture.info;
  // the repository under the fixture's HOME (a start takes only repositories of the home): ~/Projetos/nuria-platform
  const root = join(dataDir, "Projetos");
  const made = join(root, "nuria-platform");
  mkdirSync(made, { recursive: true });
  execFileSync("git", ["init", "--quiet", "-b", "main", made]);
  execFileSync("git", ["-C", made, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "init"]);
  // an origin with main, so the server can make a headless session's worktree from origin/main
  execFileSync("git", ["clone", "--quiet", "--bare", made, join(bin, "origin.git")]);
  execFileSync("git", ["-C", made, "remote", "add", "origin", join(bin, "origin.git")]);
  execFileSync("git", ["-C", made, "fetch", "--quiet", "origin"]);
  const repo = realpathSync(made);
  let restarted: ChildProcess | undefined;
  const boot = async () => {
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(env, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
  };
  const stop = async () => { await waitForExit(restarted!, { signal: "SIGTERM" }); restarted = undefined; };
  const ledger = () => JSON.parse(readFileSync(join(dataDir, "cc-sessions.json"), "utf8")).sessions as any[];
  const items = () => (JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")).ownerPending ?? []) as any[];
  const own = async () => request("/api/worktrees/own", { method: "GET" }, url) as Promise<any>;
  const records = join(dataDir, "Library", "Application Support", "Claude", "claude-code-sessions", "org", "acct");
  const projects = join(dataDir, ".claude", "projects", "p");
  try {
    const bot = (await runControlOmb(["new-bot", "--name", "Eng", "--url", url]) as any).bot;
    const thread = bot.activeTaskId ?? bot.threadId;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    mkdirSync(records, { recursive: true });
    mkdirSync(projects, { recursive: true });
    const now = Date.now();
    const sessions = ["9353", "9354"].map((issue, i) => {
      const dir = `${issue}-x`;
      const path = join(repo, ".claude", "worktrees", dir);
      mkdirSync(path, { recursive: true }); // made by the server (a stand-in: the folder is what the report checks)
      const id = `s${issue}`;
      const local = `local_0a0000${i}0-0000-4000-8000-000000000000`;
      const appMade = join(path, ".claude", "worktrees", `app-${i}`);
      // the app opened it with its worktree option on: its record names a worktree of its own inside ours
      writeFileSync(join(records, `${local}.json`), JSON.stringify({ sessionId: local, cliSessionId: `cli-${id}`, cwd: appMade, worktreePath: appMade, worktreeName: `app-${i}`, createdAt: now - 60_000 + i * 1_000, title: `${issue} x`, originCwd: path }));
      writeFileSync(join(projects, `cli-${id}.jsonl`), `${JSON.stringify({ type: "user", message: { content: `${issue} x\n[OMB${id.toUpperCase()}]` } })}\n`);
      return {
        id, ownerBotId: bot.id, ownerThreadId: thread, title: `${issue} x`, repo, permissionMode: "auto", worktree: dir, surface: "app", status: "running", turns: 0, costUsd: 0, queued: [], createdAt: now - 120_000, lastActivityAt: now - 60_000,
        desktop: { marker: `OMB${id.toUpperCase()}`, turnsSeen: 0, issue, folderGuarded: true, sentAt: now - 90_000,
          own: { path, branch: `omb/${dir}`, state: "ready", link: join(root, ".omb-worktree-links", "nuria-platform", dir), head: "abc", brief: "faça", classicText: "classic", caches: { mode: "install", reason: "x", dirs: [] } } },
      };
    });
    writeFileSync(join(dataDir, "cc-sessions.json"), JSON.stringify({ sessions }));
    await boot();

    // both fail at adoption; the 2nd trips the breaker; one owner item with the diagnosis
    await expect.poll(() => ledger().filter((each) => each.status === "failed" && each.desktop.wrongFolder).length, { timeout: 20_000, interval: 200 }).toBe(2);
    await expect.poll(async () => Boolean((await own()).breaker?.[repo]?.trippedAt), { timeout: 10_000, interval: 200 }).toBe(true);
    const key = `own-worktree-breaker:${repo}`;
    const mine = items().filter((item) => item.key === key && !item.resolvedAt);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toContain("deixe a opção worktree DESLIGADA");
    expect(mine[0].why).toContain("o app criou uma worktree própria dentro da pasta do OMB");
    expect(mine[0].why).toContain("vão direto para a CLI (no terminal, fora do app Claude), sem tentar o app de novo");
    expect(readFileSync(logPath, "utf8")).toContain("breaker tripped, new sessions go straight to the cli until the owner resolves the item");
    // the worktrees of the failed sessions: told, nothing removed
    const left = (await own()).left as any[];
    expect(left.map((each) => [each.sessionId, each.why])).toEqual([["s9353", "failed"], ["s9354", "failed"]]);
    for (const session of sessions) expect(existsSync(session.desktop.own.path)).toBe(true);

    // the next start (from the queue) goes straight to the cli — even with the app's records showing a reused folder (the old way's 409)
    await stop();
    // (the start names the repository as the person does: the home's spelling, not /private/…)
    const reused = join(made, ".claude", "worktrees", "reab-496989");
    writeFileSync(join(records, "local_old.json"), JSON.stringify({ sessionId: "local_old", cliSessionId: "c-old", cwd: reused, isArchived: true, createdAt: now - 3_600_000, title: "Reabertura" }));
    writeFileSync(join(records, "local_new.json"), JSON.stringify({ sessionId: "local_new", cliSessionId: "c-new", cwd: reused, worktreePath: reused, createdAt: now - 1_000, title: "Guarda de release" }));
    writeFileSync(join(dataDir, "cc-start-queue.json"), JSON.stringify({ items: [{ id: "q1", botId: bot.id, threadId: thread, body: { title: "9355 Outra", brief: "investigue", repo: made }, title: "9355 Outra", issue: "9355", priority: 2, at: now }] }));
    await boot();
    const queue = () => JSON.parse(readFileSync(join(dataDir, "cc-start-queue.json"), "utf8")).items as any[];
    try {
      await expect.poll(() => ledger().filter((each) => each.title === "9355 Outra").map((each) => each.surface), { timeout: 20_000, interval: 200 }).toEqual(["cli"]);
    } catch (error) {
      const said = ((await request(`/api/threads/${thread}/messages`, { method: "GET" }, url) as any).messages ?? []).filter((message: any) => /Fila/.test(JSON.stringify(message))).slice(-4).map((message: any) => JSON.stringify(message).slice(0, 600));
      const reports = JSON.stringify(JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")).reports ?? []).match(/Fila de sess[^"]{0,600}/g);
      throw new Error(`${String(error)}\nqueue: ${JSON.stringify(queue())}\nreports: ${reports?.join("\n")}\nthread: ${said.join("\n")}\nlog:\n${readFileSync(logPath, "utf8").split("\n").filter((line) => /queue|own-worktrees|claude-desktop|cc-session/i.test(line)).slice(-25).join("\n")}`);
    }
    expect(queue()).toEqual([]);
    expect(ledger().filter((each) => each.surface === "app").map((each) => each.id).sort()).toEqual(["s9353", "s9354"]); // nothing opened in the app, the server's path not taken
    expect(existsSync(join(repo, ".claude", "worktrees", "9355-outra"))).toBe(false);
    expect(readFileSync(logPath, "utf8")).not.toMatch(/\[claude-desktop\] create start/);
    // G2: the server made the headless session's worktree where claude -w would (branch worktree-<name>, from origin/main)
    // and the first turn ran in it, without -w; no seed here, so its brief says to install before the gate
    await expect.poll(() => ledger().find((each) => each.title === "9355 Outra")?.cliWorktree ?? null, { timeout: 30_000, interval: 200 }).not.toBeNull();
    const cli = ledger().find((each) => each.title === "9355 Outra");
    const path = join(repo, ".claude", "worktrees", cli.worktree);
    expect(cli.cliWorktree).toMatchObject({ path: join(made, ".claude", "worktrees", cli.worktree), branch: `worktree-${cli.worktree}`, caches: "install" });
    expect(execFileSync("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim()).toBe(`worktree-${cli.worktree}`);
    await expect.poll(() => (existsSync(turns) ? readFileSync(turns, "utf8") : ""), { timeout: 20_000, interval: 200 }).toContain("---");
    const [cwd, ...argv] = readFileSync(turns, "utf8").split("---")[0]!.trim().split("\n");
    expect(cwd).toBe(realpathSync(path));
    expect(argv.slice(0, 3)).toEqual(["-p", "--session-id", cli.id]);
    expect(argv).not.toContain("-w");
    expect(argv.join("\n")).toContain("na worktree ANTES de qualquer `npm run ci:local`");

    // the owner resolves the item: the breaker rearms (the queue emptied first: nothing then opens on this Mac)
    await stop();
    writeFileSync(join(dataDir, "cc-start-queue.json"), JSON.stringify({ items: [] }));
    await boot();
    const answer = await fetch(`${url}/api/bots/${bot.id}/owner-pending/${mine[0].id}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(answer.ok).toBe(true);
    await expect.poll(async () => (await own()).breaker?.[repo] ?? null, { timeout: 10_000, interval: 200 }).toBeNull();
    expect(readFileSync(logPath, "utf8")).toContain("rearmed: the owner resolved the item");
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" }).catch(() => {});
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
}, 180_000);
