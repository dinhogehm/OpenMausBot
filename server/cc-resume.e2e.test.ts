import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

// S-retomar and R8-dispatch D6, through the real server, with the line of
// 02/10 (redacted): 9052 (#9332) failed hours ago and 9195 (#9280) idle, each
// holding its own PR open; 8204 (#9350) idle too, but parked by the server
// behind a release (resumeAfterTag, INSP-S r1 S-1); and a message for an app
// session waiting for the Mac (screen locked). While a release is on its way
// (the fixture's own deploy lease, held by this test's pid) nobody is told
// to resume anything; once it is gone, the rows carry both signals and the
// session's bot and the Chief are told, once — never about 8204. The waiting
// step's next try is a day away, so this test never reaches the screen of
// the Mac it runs on.
it("holds RETOMAR while a release is on its way or holds the session, then tells the bot and the Chief once", async () => {
  const prompts = join(tmpdir(), `omb-resume-${process.pid}-${Date.now()}.jsonl`);
  const env = { ...process.env, OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "200", OMB_AUTONOMY_TURN_GAP_MS: "50", FAKE_CLAUDE_PROMPTS: prompts };
  const fixture = await launchVerificationServer(env);
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  const boot = async () => {
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(env, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
  };
  const sessionsOf = async (botId: string) => ((await api("/api/bots", undefined, "GET")).bots as any[]).find((bot) => bot.id === botId).tasks.flatMap((task: any) => task.ccSessions ?? []) as any[];
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief of Staff", "--url", url]) as any).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true }, "PATCH");
    const monitor = (await runControlOmb(["new-bot", "--name", "Monitor Chat", "--url", url]) as any).bot;
    const thread = monitor.activeTaskId ?? monitor.threadId;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const now = Date.now();
    const base = { ownerBotId: monitor.id, ownerThreadId: thread, repo: "/Users/o/Projetos/nuria-platform", permissionMode: "auto", turns: 3, costUsd: 1, queued: [], createdAt: now - 26 * 3_600_000 };
    const pr = (number: number) => ({ slug: "o/nuria-platform", prs: { [String(number)]: { url: `https://github.com/o/nuria-platform/pull/${number}`, number, state: "open", owned: "branch" } } });
    writeFileSync(join(dataDir, "cc-sessions.json"), JSON.stringify({ sessions: [
      { ...base, id: "s9052", title: "9052 Tempo de reabertura", worktree: "w1", surface: "cli", status: "failed", lastActivityAt: now - 4 * 3_600_000, failedAt: now - 4 * 3_600_000, lastError: "the turn ran past 45 minutes and was stopped", delivery: pr(9332) },
      // its ci:local gave way to the release 2,5 h ago: the server resumes it when the tag moves
      { ...base, id: "s8204", title: "8204 Sidebar da fila", worktree: "w2", surface: "cli", status: "idle", lastActivityAt: now - 2.5 * 3_600_000, delivery: pr(9350),
        resumeAfterTag: { fromSha: "09d832f4bfa4", at: now - 2.5 * 3_600_000, message: "A tag andou", releaseSha: "d5bb1f70b" } },
      { ...base, id: "s9195", title: "9195 Filtros", worktree: "w3", surface: "cli", status: "idle", lastActivityAt: now - 3 * 3_600_000, delivery: pr(9280) },
      // a fresh stop: not yet one to resume
      { ...base, id: "s9301", title: "9301 Fresca", worktree: "w5", surface: "cli", status: "idle", lastActivityAt: now - 30 * 60_000, delivery: pr(9301) },
      // a message for an app session, held by the locked screen; its next try a day away
      { ...base, id: "s9311", title: "9311 Chat no ticket", worktree: "w4", surface: "app", status: "running", lastActivityAt: now - 60_000, progressAt: now - 60_000,
        desktop: { marker: "OMBTEST001", turnsSeen: 1, localId: "local_0a0000ee-0000-4000-8000-000000000000", cliSessionId: "c", pending: { kind: "send", text: "segue", since: now - 12 * 60_000, attempts: 1, lastReason: "the screen is locked or the display is asleep", nextAttemptAt: now + 24 * 3_600_000 } } },
    ] }));
    // a production release on its way: the fixture's HOME is its data dir, and this test's pid is alive
    const deployLease = join(dataDir, ".nuria", "admission", "deploy-lease");
    mkdirSync(deployLease, { recursive: true });
    writeFileSync(join(deployLease, "owner.pid"), String(process.pid));
    writeFileSync(join(deployLease, "label"), "release:production:d5bb1f70b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6");
    await boot();

    // while it runs: no RETOMAR to anyone; the rows keep the mark, "on hold" (INSP-S r2 S2-3)
    await expect.poll(() => readFileSync(logPath, "utf8"), { timeout: 15_000, interval: 200 }).toContain("[cc-sessions] release hold: o release de produção d5bb1f70b está em andamento");
    await expect.poll(async () => (await sessionsOf(monitor.id)).find((session) => session.sessionId === "s9311")?.screenWait?.waitingFor, { timeout: 15_000, interval: 200 }).toBe("locked");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const heldOf = async () => Object.fromEntries((await sessionsOf(monitor.id)).filter((session) => session.resume).map((session) => [session.sessionId, session.resume.held ?? "free"]));
    expect(await heldOf()).toEqual({ s9052: "release", s9195: "release", s8204: "parked" });
    expect(existsSync(prompts) ? readFileSync(prompts, "utf8") : "").not.toContain("[Sessão para retomar]");
    expect(readFileSync(logPath, "utf8")).not.toContain("must be resumed");

    // the release is gone: two to resume, the parked one still on hold (the server resumes it)
    rmSync(join(dataDir, ".nuria"), { recursive: true, force: true });
    await expect.poll(heldOf, { timeout: 15_000, interval: 200 }).toEqual({ s9052: "free", s9195: "free", s8204: "parked" });
    const rows = await sessionsOf(monitor.id);
    expect(rows.find((session) => session.sessionId === "s9052").resume).toMatchObject({ prs: [9332], why: "falhou: o turno passou de 45 minutos e foi parado", kind: "failed" });
    expect(rows.find((session) => session.sessionId === "s9195").resume).toMatchObject({ prs: [9280], why: "parada: o último turno terminou e nada a retomou", kind: "idle" });
    expect(rows.find((session) => session.sessionId === "s8204").resume).toMatchObject({ prs: [9350], held: "parked" });
    expect(rows.find((session) => session.sessionId === "s9301").resume).toBeUndefined();
    expect(rows.find((session) => session.sessionId === "s9311").screenWait).toEqual({ kind: "send", since: now - 12 * 60_000, waitingFor: "locked" });

    // told once: the bot owning them and the Chief, with the PR and the way out
    await expect.poll(() => (existsSync(prompts) ? readFileSync(prompts, "utf8") : "").split("[Sessão para retomar]").length - 1, { timeout: 20_000, interval: 200 }).toBeGreaterThanOrEqual(4);
    const said = readFileSync(prompts, "utf8");
    expect(said).toContain('Claude Code session \\"9052 Tempo de reabertura\\" (s9052) — RETOMAR — há 4 h com PR #9332 aberta, falhou: o turno passou de 45 minutos e foi parado. Retome com cc_session_send (session_id s9052)');
    expect(said).toContain("Cobre de Monitor Chat a retomada (cc_session_send na sessão s9052)");
    expect(said).not.toContain("(s8204)");
    expect(said).not.toContain("(s9301)");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("[cc-sessions] release hold: none");
    expect(log).toContain("[cc-sessions] s9052 must be resumed (#9332)");
    expect(log).toContain("[cc-sessions] s9195 must be resumed (#9280)");
    expect(log).not.toContain("s8204 must be resumed");
    const ledger = JSON.parse(readFileSync(join(dataDir, "cc-sessions.json"), "utf8")).sessions as any[];
    expect(ledger.filter((session) => session.resumeReportedAt).map((session) => session.id).sort()).toEqual(["s9052", "s9195"]);
    // a restart does not tell again
    await waitForExit(restarted, { signal: "SIGTERM" });
    await boot();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(readFileSync(logPath, "utf8").split("must be resumed").length - 1).toBe(2);
    // and the screen of this Mac was never touched: the waiting step was not tried
    expect(readFileSync(logPath, "utf8")).not.toMatch(/\[claude-desktop\] (send|create|rename|archive) start/);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(prompts, { force: true });
  }
}, 120_000);
