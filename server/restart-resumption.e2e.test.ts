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
    await expect.poll(async () => (await chips(chief.activeTaskId)).some((chip) => chip === "Servidor reiniciado: 1 sessão interrompida (retomar), 1 turno retomado"), { timeout: 15_000 }).toBe(true);
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

// R9-resilience RS-PID: a CLI session's claude runs in a group of its own and
// may outlive the server (an app quit). On boot the server checks the pid AND
// its start time: alive, the session stays running and is followed to the end
// of its turn (its transcript is the report); gone, it is interrupted and its
// owner is told. Here two stand-ins live a few seconds past the restart, one
// leaving a finished transcript, and a third died before it.
it("after a restart, follows the sessions whose claude survived to the end of their turn, and interrupts the one whose claude died", async () => {
  const parentEnv = { ...process.env, OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "100", OMB_AUTONOMY_TURN_GAP_MS: "50" };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  let restarted: ChildProcess | undefined;
  const standIns: ChildProcess[] = [];
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief", "--url", url]) as any).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true }, "PATCH");
    const worker = (await runControlOmb(["new-bot", "--name", "Lead", "--url", url]) as any).bot;
    await waitForExit(fixture.child, { signal: "SIGTERM" });

    // stand-ins for the turns' claude: detached like the real ones, alive ~6 s
    const standIn = (ms: number) => {
      const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { detached: true, stdio: "ignore" });
      standIns.push(child);
      return { pid: child.pid!, lstart: execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(child.pid)], { env: { ...process.env, LC_ALL: "C", LANG: "C" } }).toString().trim() };
    };
    const finishing = standIn(6_000);
    const cut = standIn(6_000);
    const died = standIn(60_000);
    standIns.at(-1)!.kill("SIGKILL");
    await waitForExit(standIns.at(-1), { signal: "SIGKILL" });
    // the finishing one wrote its turn's end in its transcript before the restart
    const ids = { finishing: "aaaaaaaa-0000-4000-8000-0000000000a1", cut: "bbbbbbbb-0000-4000-8000-0000000000b2", died: "cccccccc-0000-4000-8000-0000000000c3" };
    mkdirSync(join(dataDir, ".claude", "projects", "-repo"), { recursive: true });
    writeFileSync(join(dataDir, ".claude", "projects", "-repo", `${ids.finishing}.jsonl`), `${JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "PR #77 aberta, gate verde no head." }] } })}\n`);
    const at = Date.now() - 60_000;
    const session = (id: string, proc: { pid: number; lstart: string }) => ({
      id, ownerBotId: worker.id, ownerThreadId: worker.activeTaskId, title: `9315 ${id.slice(0, 4)}`, repo: dataDir, worktree: `9315-${id.slice(0, 4)}`,
      permissionMode: "auto", status: "running", surface: "cli", createdAt: at, lastActivityAt: at, progressAt: at, turns: 2, costUsd: 0, queued: [], proc,
    });
    writeFileSync(join(dataDir, "cc-sessions.json"), JSON.stringify({ sessions: [session(ids.finishing, finishing), session(ids.cut, cut), session(ids.died, died)] }));

    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      if (restarted?.exitCode !== null) throw new Error(readFileSync(logPath, "utf8"));
      return fetch(url + "/api/health").then((r) => r.ok).catch(() => false);
    }, { timeout: 15_000, interval: 150 }).toBe(true);

    const ledger = () => Object.fromEntries((JSON.parse(readFileSync(join(dataDir, "cc-sessions.json"), "utf8")).sessions as any[]).map((each) => [each.id, each]));
    const chips = async (threadId: string) => ((await api(`/api/threads/${threadId}/messages`, undefined, "GET")).messages as any[])
      .filter((message) => message.kind === "activity").map((message) => String(message.tool?.name ?? ""));
    // the boot: one interrupted, two followed — none of them marked failed for being cut
    await expect.poll(async () => (await chips(chief.activeTaskId)).filter((chip) => chip.startsWith("Servidor reiniciado")), { timeout: 15_000 }).toEqual(["Servidor reiniciado: 1 sessão interrompida (retomar), 2 sessões seguem rodando"]);
    expect(ledger()[ids.died]).toMatchObject({ status: "failed", lastError: expect.stringContaining(`its claude (PID ${died.pid}) did not survive`) });
    expect(ledger()[ids.finishing]).toMatchObject({ status: "running", proc: { pid: finishing.pid } });
    expect(ledger()[ids.cut]).toMatchObject({ status: "running", proc: { pid: cut.pid } });
    expect((await chips(worker.activeTaskId)).filter((chip) => chip === "Sessão 9315 seguiu rodando no reinício — acompanho o turno 2 até o fim")).toHaveLength(2);
    expect((await chips(worker.activeTaskId)).some((chip) => chip === "Sessão 9315 interrompida no reinício — retome-a (o turno 2 não sobreviveu ao reinício)")).toBe(true);
    // the stand-ins end: each turn ends as its transcript says, and the owner hears it
    await expect.poll(() => ledger()[ids.finishing].status, { timeout: 20_000 }).toBe("idle");
    expect(ledger()[ids.finishing]).toMatchObject({ lastReport: "PR #77 aberta, gate verde no head.", turns: 2 });
    expect(ledger()[ids.finishing].proc).toBeUndefined();
    await expect.poll(() => ledger()[ids.cut].status, { timeout: 20_000 }).toBe("failed");
    expect(ledger()[ids.cut].lastError).toContain("outlived the server restart, ended without finishing its turn");
    const after = await chips(worker.activeTaskId);
    expect(after.some((chip) => chip === "Sessão 9315 terminou o turno 2, acompanhado após o reinício")).toBe(true);
    expect(after.some((chip) => chip.startsWith("Sessão 9315 parou sem fechar o turno 2 — retome-a"))).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain(`the claude that outlived the restart (PID ${finishing.pid}) is gone; turn 2 finished`);
  } finally {
    for (const child of standIns) child.kill("SIGKILL");
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);

it("tells a standing watch armed with an unanchored ignore, once, when the server starts (INSP-E 7)", async () => {
  const parentEnv = { ...process.env, OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "100", OMB_AUTONOMY_TURN_GAP_MS: "50" };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string) => request(path, {}, url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  try {
    const monitor = (await runControlOmb(["new-bot", "--name", "Monitor", "--url", url]) as any).bot;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    // the real planilha watch as it is armed today: ignore not anchored
    const at = Date.now();
    writeFileSync(join(dataDir, "bot-autonomy.json"), JSON.stringify({ wakes: [{
      botId: monitor.id, threadId: monitor.activeTaskId, dueAt: at + 3_600_000, createdAt: at, reason: "planilha",
      watch: { command: "gog sheets get SHEET_ID Atendimento!A1:H400 --plain", argv: ["gog", "sheets", "get", "SHEET_ID", "Atendimento!A1:H400", "--plain"], everyMs: 600_000, baseline: "", lastRunAt: at, runs: 1, failures: 0, standing: true, label: "planilha", ignore: "\\[(Monitor Chat Atendimento|Monitor)\\]" },
    }], goals: [] }));
    const boot = () => {
      const log = openSync(logPath, "a", 0o600);
      const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
      });
      closeSync(log);
      return child;
    };
    const healthy = () => expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
    const warned = async () => ((await api(`/api/threads/${monitor.activeTaskId}/messages`)).messages as any[]).filter((message) => String(message.tool?.name ?? "").startsWith("Vigia planilha: o ignore pode esconder")).length;
    restarted = boot();
    await healthy();
    await expect.poll(warned, { timeout: 10_000 }).toBe(1);
    expect(JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")).wakes[0].watch.ignoreWarnedAt).toBeGreaterThan(0);
    // a second start says nothing again
    await waitForExit(restarted, { signal: "SIGTERM" });
    restarted = boot();
    await healthy();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await warned()).toBe(1);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
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
