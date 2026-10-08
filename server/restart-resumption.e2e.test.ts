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
    await expect.poll(async () => (await chips(chief.activeTaskId)).some((chip) => chip === "Servidor reiniciado: 1 sessão interrompida (o Chief retoma), 1 turno retomado"), { timeout: 15_000 }).toBe(true);
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
    await expect.poll(async () => (await chips(chief.activeTaskId)).filter((chip) => chip.startsWith("Servidor reiniciado")), { timeout: 15_000 }).toEqual(["Servidor reiniciado: 1 sessão interrompida (o Chief retoma), 2 sessões seguem rodando"]);
    expect(ledger()[ids.died]).toMatchObject({ status: "failed", lastError: expect.stringContaining(`its claude (PID ${died.pid}) did not survive`) });
    expect(ledger()[ids.finishing]).toMatchObject({ status: "running", proc: { pid: finishing.pid } });
    expect(ledger()[ids.cut]).toMatchObject({ status: "running", proc: { pid: cut.pid } });
    expect((await chips(worker.activeTaskId)).filter((chip) => chip === "Sessão 9315 seguiu rodando no reinício — acompanho o turno 2 até o fim")).toHaveLength(2);
    expect((await chips(worker.activeTaskId)).some((chip) => chip === "Sessão 9315 interrompida no reinício — o Chief retoma (o turno 2 não sobreviveu ao reinício)")).toBe(true);
    // the stand-ins end: each turn ends as its transcript says, and the owner hears it
    await expect.poll(() => ledger()[ids.finishing].status, { timeout: 20_000 }).toBe("idle");
    expect(ledger()[ids.finishing]).toMatchObject({ lastReport: "PR #77 aberta, gate verde no head.", turns: 2 });
    expect(ledger()[ids.finishing].proc).toBeUndefined();
    await expect.poll(() => ledger()[ids.cut].status, { timeout: 20_000 }).toBe("failed");
    expect(ledger()[ids.cut].lastError).toContain("outlived the server restart, ended without finishing its turn");
    const after = await chips(worker.activeTaskId);
    expect(after.some((chip) => chip === "Sessão 9315 terminou o turno 2, acompanhado após o reinício")).toBe(true);
    expect(after.some((chip) => chip.startsWith("Sessão 9315 parou sem fechar o turno 2 — o Chief retoma"))).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain(`the claude that outlived the restart (PID ${finishing.pid}) is gone; turn 2 finished`);
  } finally {
    for (const child of standIns) child.kill("SIGKILL");
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);

// INSP-H r1 #10: a survivor past the turn limit is cut like any turn (it
// never stays "running" for good), and on the Chief's desk the summary is
// not doubled by the session's own chip.
it("cuts a survivor at the turn limit, and says it once on the Chief's desk", async () => {
  const parentEnv = { ...process.env, OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "100", OMB_AUTONOMY_TURN_GAP_MS: "50", OMB_CC_TURN_TIMEOUT_MS: "5000" };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  const { execFileSync } = await import("node:child_process");
  let restarted: ChildProcess | undefined;
  let standIn: ChildProcess | undefined;
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief", "--url", url]) as any).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true }, "PATCH");
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    standIn = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { detached: true, stdio: "ignore" });
    const lstart = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(standIn.pid)], { env: { ...process.env, LC_ALL: "C", LANG: "C" } }).toString().trim();
    const at = Date.now() - 60_000;
    writeFileSync(join(dataDir, "cc-sessions.json"), JSON.stringify({ sessions: [{
      id: "dddddddd-0000-4000-8000-0000000000d4", ownerBotId: chief.id, ownerThreadId: chief.activeTaskId, title: "9316 longo", repo: dataDir, worktree: "9316-longo",
      permissionMode: "auto", status: "running", surface: "cli", createdAt: at, lastActivityAt: at, progressAt: at, turns: 3, costUsd: 0, queued: [], proc: { pid: standIn.pid, lstart },
    }] }));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
    const chips = async (threadId: string) => ((await api(`/api/threads/${threadId}/messages`, undefined, "GET")).messages as any[])
      .filter((message) => message.kind === "activity").map((message) => String(message.tool?.name ?? ""));
    const ledger = () => JSON.parse(readFileSync(join(dataDir, "cc-sessions.json"), "utf8")).sessions[0];
    await expect.poll(() => ledger().status, { timeout: 20_000 }).toBe("failed");
    expect(ledger().lastError).toContain("was cut at the 1-min turn limit");
    await expect.poll(() => standIn!.exitCode !== null || standIn!.signalCode !== null, { timeout: 10_000 }).toBe(true);
    const desk = await chips(chief.activeTaskId);
    expect(desk.filter((chip) => chip.startsWith("Servidor reiniciado"))).toEqual(["Servidor reiniciado: 1 sessão segue rodando"]);
    // the summary says it there: no chip of its own beside it
    expect(desk.some((chip) => chip.startsWith("Sessão 9316 seguiu rodando"))).toBe(false);
    expect(desk.some((chip) => chip.startsWith("Sessão 9316 cortada no limite de 1 min — o Chief retoma"))).toBe(true);
  } finally {
    standIn?.kill("SIGKILL");
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);

// R13-2, INSP-R13res A1: survivors past the turn limit, with stand-ins that
// behave as Claude Code does — on SIGTERM it kills its own background shells,
// the gate with them, whatever their process group. One per case, in one boot:
// - "bg": its gate runs as a background child → the cut waits; the gate ends,
//   the claude hears it and ends its turn (idle, not cut);
// - "nohup": its gate was started with nohup (launchd's child, outside the
//   claude's tree) → found all the same, the cut waits, the turn ends;
// - "stuck": its gate runs past the ceiling → cut, the gate dies with the
//   claude, said as "gate interrompido pelo corte, sem resultado", no job;
// - "plain": no gate → cut as before, the Chief resumes it;
// - "nohupStuck": a nohup'd gate past the ceiling → cut, but the gate truly
//   outlives the cut: followed as a job, the session resumed once when it ends;
// - "again": the server's resumption after a cut, cut again → no second
//   resumption, the Chief decides (INSP-R13res A3).
it("waits for a survivor's gate at the turn limit (background or nohup), cuts honestly past the ceiling, follows only what outlives the cut, and cuts a survivor with no gate as before", async () => {
  const { chmodSync, existsSync, mkdirSync, realpathSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const parentEnv = { ...process.env, OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "100", OMB_AUTONOMY_TURN_GAP_MS: "50", OMB_CC_TURN_TIMEOUT_MS: "5000", OMB_CC_GATE_WAIT_MAX_MS: "1800000" };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, logPath } = fixture.info;
  const data = fixture.info.dataDir;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  const standIns: ChildProcess[] = [];
  const gatePids: number[] = [];
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief", "--url", url]) as any).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true }, "PATCH");
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    // a resumption runs this: it records its prompt and ends its turn
    const fake = join(data, "fake-claude-resume.mjs");
    const calls = join(data, "fake-claude-resume.calls");
    writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "resumed", total_cost_usd: 0 }));
`);
    chmodSync(fake, 0o755);
    const prompts = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as string[]).at(-1)!) : []);
    // the gate: node running a local-ci script, which ends when its release file exists, not on a clock
    const gateJs = join(data, "local-ci.cjs");
    writeFileSync(gateJs, `const { existsSync } = require("node:fs"); const release = process.argv[2]; setInterval(() => { if (existsSync(release)) process.exit(0); }, 100); setTimeout(() => process.exit(0), 120000);\n`);
    // the stand-in claude: argv [mode, gate.js, release, gate pid file, transcript]
    const claudeJs = join(data, "stand-in.cjs");
    writeFileSync(claudeJs, `const { spawn, execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const [mode, gateJs, release, pidFile, transcript] = process.argv.slice(2);
const end = () => { mkdirSync(dirname(transcript), { recursive: true }); writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "gate verde no head" }] } }) + "\\n"); process.exit(0); };
if (mode === "plain") setInterval(() => {}, 1000);
else if (mode === "nohup") {
  // as the Bash tool's shell: a group of its own, which exits at once and leaves the gate to launchd
  const sh = spawn("/bin/sh", ["-c", 'nohup "$0" "$1" "$2" >/dev/null 2>&1 & echo $!', process.execPath, gateJs, release], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  sh.stdout.on("data", (chunk) => { out += chunk; });
  sh.on("exit", () => {
    const pid = Number(out.trim());
    writeFileSync(pidFile, String(pid));
    setInterval(() => { try { process.kill(pid, 0); } catch { end(); } }, 100);
  });
  setInterval(() => {}, 1000);
} else {
  const gate = spawn(process.execPath, [gateJs, release], { detached: true, stdio: "ignore" });
  writeFileSync(pidFile, String(gate.pid));
  // as Claude Code: a cut kills its background shells
  process.on("SIGTERM", () => { try { process.kill(-gate.pid, "SIGKILL"); } catch {} process.exit(143); });
  gate.on("exit", end);
}
`);
    const ids = { bg: "a1a1a1a1-0000-4000-8000-0000000000a1", nohup: "b2b2b2b2-0000-4000-8000-0000000000b2", stuck: "c3c3c3c3-0000-4000-8000-0000000000c3", plain: "d4d4d4d4-0000-4000-8000-0000000000d4", nohupStuck: "e5e5e5e5-0000-4000-8000-0000000000e5", again: "f6f6f6f6-0000-4000-8000-0000000000f6" };
    const titles = { bg: "9401 gate", nohup: "9402 gate nohup", stuck: "9403 gate travado", plain: "9404 sem gate", nohupStuck: "9405 gate nohup travado", again: "9406 retomada cortada" };
    const kinds = { bg: "bg", nohup: "nohup", stuck: "bg", plain: "plain", nohupStuck: "nohup", again: "plain" } as const;
    const releases = Object.fromEntries(Object.keys(ids).map((mode) => [mode, join(data, `release-${mode}`)])) as Record<keyof typeof ids, string>;
    const gatePid: Partial<Record<keyof typeof ids, number>> = {};
    const now = Date.now();
    const sessions = [];
    for (const mode of ["bg", "nohup", "stuck", "plain", "nohupStuck", "again"] as const) {
      const folder = join(data, ".claude", "worktrees", titles[mode].replace(/ /g, "-"));
      mkdirSync(folder, { recursive: true });
      const cwd = realpathSync(folder);
      const pidFile = join(data, `${mode}.pid`);
      const transcript = join(data, ".claude", "projects", "-repo", `${ids[mode]}.jsonl`);
      const standIn = spawn(process.execPath, [claudeJs, kinds[mode], gateJs, releases[mode], pidFile, transcript], { cwd, detached: true, stdio: "ignore" });
      standIns.push(standIn);
      if (kinds[mode] !== "plain") {
        await expect.poll(() => existsSync(pidFile), { timeout: 10_000 }).toBe(true);
        gatePid[mode] = Number(readFileSync(pidFile, "utf8"));
        gatePids.push(gatePid[mode]!);
      }
      const lstart = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(standIn.pid)], { env: { ...process.env, LC_ALL: "C", LANG: "C" } }).toString().trim();
      // past the 5-s limit; the stuck ones also past the 30-min ceiling
      const at = mode === "stuck" || mode === "nohupStuck" ? now - 40 * 60_000 : now - 60_000;
      sessions.push({
        id: ids[mode], ownerBotId: chief.id, ownerThreadId: chief.activeTaskId, title: titles[mode], repo: data, worktree: titles[mode].replace(/ /g, "-"), cwd,
        permissionMode: "auto", status: "running", surface: "cli", createdAt: at, lastActivityAt: at, progressAt: at, turns: 7, costUsd: 0, queued: [], proc: { pid: standIn.pid, lstart },
        ...(mode === "again" ? { resumedAfterCut: true } : {}),
      });
    }
    const [bgGate, nohupGate, stuckGate, nohupStuckGate] = [gatePid.bg!, gatePid.nohup!, gatePid.stuck!, gatePid.nohupStuck!];
    // the nohup'd gate is launchd's, outside any claude's tree
    expect(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(nohupGate)]).toString().trim()).toBe("1");
    writeFileSync(join(data, "cc-sessions.json"), JSON.stringify({ sessions }));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...verificationServerEnvironment(parentEnv, data, Number(new URL(url).port)), OMB_CC_BIN: fake }, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
    const chips = async (threadId: string) => ((await api(`/api/threads/${threadId}/messages`, undefined, "GET")).messages as any[])
      .filter((message) => message.kind === "activity").map((message) => String(message.tool?.name ?? ""));
    const ledger = () => Object.fromEntries((JSON.parse(readFileSync(join(data, "cc-sessions.json"), "utf8")).sessions as any[]).map((each) => [each.id, each]));
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

    // "plain", "again", "stuck" and "nohupStuck" are cut
    await expect.poll(() => [ids.plain, ids.again, ids.stuck, ids.nohupStuck].map((id) => ledger()[id].status), { timeout: 30_000 }).toEqual(["failed", "failed", "failed", "failed"]);
    // "stuck": its gate dies with its claude, said so, nothing followed
    expect(ledger()[ids.stuck].lastError).toContain("with its gate (ci:local) still running, 30 min into the turn, already past the gate wait's ceiling");
    expect(ledger()[ids.stuck].lastError).toContain("its gate (ci:local) was stopped with it, with no result");
    expect(ledger()[ids.stuck].bgJob).toBeUndefined();
    await expect.poll(() => alive(stuckGate), { timeout: 5_000 }).toBe(false);
    expect(ledger()[ids.plain].bgJob).toBeUndefined();
    // "again": the resumption of a cut, cut again: no job, no second resumption, flag cleared
    expect(ledger()[ids.again].bgJob).toBeUndefined();
    expect(ledger()[ids.again].resumedAfterCut).toBeUndefined();
    // "nohupStuck": its gate outlived the cut, so it is followed (afterCut) and still runs
    expect(ledger()[ids.nohupStuck]).toMatchObject({ bgJob: { pids: [nohupStuckGate], afterCut: true } });
    expect(ledger()[ids.nohupStuck].lastError).toContain("the server resumes it when the process(es) still running finish");
    expect(alive(nohupStuckGate)).toBe(true);
    // "bg" and "nohup" wait for their gates: nothing killed, the cut said to wait
    expect(ledger()[ids.bg].status).toBe("running");
    expect(ledger()[ids.nohup].status).toBe("running");
    expect([standIns[0]!.exitCode, standIns[1]!.exitCode, alive(bgGate), alive(nohupGate)]).toEqual([null, null, true, true]);
    await expect.poll(async () => (await chips(chief.activeTaskId)).filter((chip) => chip.includes("mas o gate (ci:local) dela ainda roda — o corte espera o gate terminar (até 30 min de turno)")).length, { timeout: 15_000 }).toBe(2);
    const desk = await chips(chief.activeTaskId);
    expect(desk.some((chip) => chip.startsWith("Sessão 9403 cortada com 30 min de turno, já além do teto de espera do gate (ci:local) — gate interrompido pelo corte, sem resultado"))).toBe(true);
    expect(desk.some((chip) => chip.startsWith("Sessão 9404 cortada no limite de 1 min — o Chief retoma"))).toBe(true);
    expect(desk.some((chip) => chip.startsWith("Sessão 9405 cortada no limite de 1 min; 1 processo seguiu rodando — o servidor retoma a sessão quando terminar"))).toBe(true);
    expect(desk.some((chip) => chip.startsWith("Sessão 9406 cortada no limite de 1 min duas vezes seguidas — o servidor não retoma de novo"))).toBe(true);
    expect(desk.some((chip) => /^Sessão 940[12] cortada/.test(chip))).toBe(false);
    expect(readFileSync(logPath, "utf8")).toContain(`gate check: running (${nohupGate}): the cut waits`);
    expect(prompts()).toEqual([]);

    // the gates end: each waiting claude hears it and ends its turn — finished, not cut
    writeFileSync(releases.bg, "");
    writeFileSync(releases.nohup, "");
    await expect.poll(() => [ledger()[ids.bg].status, ledger()[ids.nohup].status], { timeout: 25_000 }).toEqual(["idle", "idle"]);
    expect(ledger()[ids.bg]).toMatchObject({ lastReport: "gate verde no head", turns: 7 });
    expect(ledger()[ids.nohup]).toMatchObject({ lastReport: "gate verde no head", turns: 7 });
    expect(ledger()[ids.bg].bgJob).toBeUndefined();
    expect(ledger()[ids.nohup].bgJob).toBeUndefined();
    const after = await chips(chief.activeTaskId);
    expect(after.filter((chip) => /^Sessão 940[12] terminou o turno 7, acompanhado após o reinício/.test(chip))).toHaveLength(2);
    expect(after.some((chip) => /^Sessão 940[12] cortada/.test(chip))).toBe(false);
    expect(prompts()).toEqual([]);
    // the followed nohup gate ends: one resumption, which does not claim how it ended
    writeFileSync(releases.nohupStuck, "");
    await expect.poll(() => prompts().length, { timeout: 25_000 }).toBe(1);
    expect(prompts()[0]).toContain(`PID ${nohupStuckGate}`);
    expect(prompts()[0]).toContain("cannot see their exit code");
    await expect.poll(() => ledger()[ids.nohupStuck].status, { timeout: 10_000 }).toBe("idle");
    expect(ledger()[ids.nohupStuck].bgJob).toBeUndefined();
  } finally {
    for (const child of standIns) child.kill("SIGKILL");
    for (const pid of gatePids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);

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
