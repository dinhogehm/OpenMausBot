import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

// The restart drill (R7-resilience V2): a wake turn and a Claude Code
// session cut off by a restart. On boot the wake runs again exactly once,
// the session is marked interrupted, and the Chief's desk gets the
// resumption report. No server is left running afterwards.
it("after a restart, re-runs a cut-off wake once, reports it and the cut-off session to the Chief, and leaves no server behind", async () => {
  const parentEnv = { ...process.env, OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "100", OMB_AUTONOMY_TURN_GAP_MS: "50" };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief", "--url", url]) as any).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true }, "PATCH");
    const worker = (await runControlOmb(["new-bot", "--name", "Monitor", "--url", url]) as any).bot;
    await waitForExit(fixture.child, { signal: "SIGTERM" });

    // What a process killed mid-turn leaves on disk: a leased wake and a running CLI session.
    const at = Date.now() - 60_000;
    const wake = { botId: worker.id, threadId: worker.activeTaskId, dueAt: at, createdAt: at - 60_000, reason: "RETOMAR_9315 conferir a tag" };
    writeFileSync(join(dataDir, "bot-autonomy.json"), JSON.stringify({ wakes: [], goals: [], inFlight: [{ kind: "wake", botId: worker.id, threadId: worker.activeTaskId, startedAt: at, wake }] }));
    writeFileSync(join(dataDir, "cc-sessions.json"), JSON.stringify({ sessions: [{
      id: "cc-cut", ownerBotId: worker.id, ownerThreadId: worker.activeTaskId, title: "#9315 lote", repo: dataDir, worktree: "9315-lote",
      permissionMode: "auto", status: "running", surface: "cli", createdAt: at, lastActivityAt: at, turns: 1, costUsd: 0, queued: [],
    }] }));

    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      if (restarted?.exitCode !== null) throw new Error(readFileSync(logPath, "utf8"));
      return fetch(url + "/api/health").then((r) => r.ok).catch(() => false);
    }, { timeout: 15_000, interval: 150 }).toBe(true);

    const chips = async (threadId: string) => ((await api(`/api/threads/${threadId}/messages`, undefined, "GET")).messages as any[])
      .filter((message) => message.kind === "activity").map((message) => String(message.tool?.name ?? ""));
    await expect.poll(async () => (await chips(chief.activeTaskId)).some((chip) => chip === "Servidor reiniciado: 1 retomado(s), 0 para confirmar, 1 sessão(ões) cortada(s)"), { timeout: 15_000 }).toBe(true);
    // the wake ran again, once, and its lease is settled
    await expect.poll(async () => (await chips(worker.activeTaskId)).filter((chip) => chip.includes("RETOMAR_9315")).length, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")).inFlight ?? [], { timeout: 15_000 }).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await chips(worker.activeTaskId)).filter((chip) => chip.includes("RETOMAR_9315"))).toHaveLength(1);
    const sessions = JSON.parse(readFileSync(join(dataDir, "cc-sessions.json"), "utf8")).sessions;
    expect(sessions[0]).toMatchObject({ id: "cc-cut", status: "failed", lastError: expect.stringContaining("server restarted") });
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
  // nothing of the drill is still running
  expect(restarted?.exitCode !== null || restarted?.signalCode !== null).toBe(true);
}, 60_000);

it("a test server goes away with the process that launched it", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  let orphan: ChildProcess | undefined;
  const launcher = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: "ignore" });
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    orphan = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...verificationServerEnvironment(process.env, dataDir, Number(new URL(url).port)), OMB_EXIT_WITH_PARENT: String(launcher.pid) },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
    // the launcher ends: the server follows on its own, no kill from here
    await expect.poll(() => orphan!.exitCode !== null || orphan!.signalCode !== null, { timeout: 20_000, interval: 250 }).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("the process that launched this server is gone");
  } finally {
    launcher.kill();
    await waitForExit(orphan, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 60_000);
