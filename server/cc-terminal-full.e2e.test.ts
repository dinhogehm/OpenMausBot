import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { CcSessionLedger } from "./cc-sessions.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("delegates Full Access through the Claude terminal for every requested surface and respects revocation", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir, logPath } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const callsPath = join(dataDir, "terminal-calls.jsonl");
  const nativePath = join(dataDir, "native-calls.jsonl");
  const fake = join(dataDir, "fake-delegated-claude.mjs");
  const guard = join(dataDir, "native-guard.mjs");
  const evidencePath = `${logPath}.cc-terminal-full.json`;
  const evidence: Record<string, unknown> = { fixture: fixture.info, actions: [] };
  let server: ChildProcess | undefined;
  const records = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.ok, `${response.status}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  try {
    const bot = (await cli("new-bot", "--name", "Terminal verification")).bot;
    const repo = join(dataDir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const saved = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    const stored = saved.find((each: any) => each.id === bot.id);
    stored.approvalMode = "full";
    stored.tasks.find((task: any) => task.threadId === bot.activeTaskId).approvalMode = "full";
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify(saved));
    const historicalId = "historical-desktop-fixture";
    const uncertainId = "uncertain-desktop-fixture";
    const pendingId = "unattempted-desktop-fixture";
    const unprovenStopId = "unproven-stop-fixture";
    const nativeDir = join(dataDir, "Library", "Application Support", "Claude", "claude-code-sessions", "fixture-org", "fixture-account");
    const nativeProject = join(dataDir, ".claude", "projects", "fixture-project");
    mkdirSync(nativeDir, { recursive: true });
    mkdirSync(nativeProject, { recursive: true });
    const nativeSnapshots = new Map<string, string>();
    for (const [kind, ended] of [["finished", true], ["uncertain", false]] as const) {
      const recordPath = join(nativeDir, `local_${kind}.json`);
      const transcript = join(nativeProject, `cli-${kind}.jsonl`);
      const cwd = join(repo, ".claude", "worktrees", `native-${kind}`);
      mkdirSync(cwd, { recursive: true });
      const record = JSON.stringify({ sessionId: `local_${kind}`, cliSessionId: `cli-${kind}`, cwd, originCwd: repo, worktreePath: cwd,
        completedTurns: 0, permissionMode: "auto" });
      const text = JSON.stringify(ended ? { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Synthetic native work completed" }] } }
        : { type: "user", message: { content: "Synthetic native work still uncertain" } }) + "\n";
      writeFileSync(recordPath, record);
      writeFileSync(transcript, text);
      nativeSnapshots.set(recordPath, record);
      nativeSnapshots.set(transcript, text);
    }
    const seededLedger = new CcSessionLedger({ path: join(dataDir, "cc-sessions.json") });
    seededLedger.create({
      id: historicalId, ownerBotId: bot.id, ownerThreadId: bot.activeTaskId, title: "99101 Historical desktop fixture", repo,
      permissionMode: "auto", surface: "app", desktop: { marker: "fixture-only-desktop", localId: "local_finished", turnsSeen: 0 },
    });
    seededLedger.create({
      id: uncertainId, ownerBotId: bot.id, ownerThreadId: bot.activeTaskId, title: "99102 Uncertain desktop fixture", repo,
      permissionMode: "auto", surface: "app", desktop: { marker: "fixture-only-uncertain", localId: "local_uncertain", turnsSeen: 0 },
    });
    const unattempted = seededLedger.create({
      id: pendingId, ownerBotId: bot.id, ownerThreadId: bot.activeTaskId, title: "Unattempted desktop fixture", repo,
      permissionMode: "auto", surface: "app", desktop: { marker: "fixture-only-unattempted", turnsSeen: 0,
        pending: { kind: "create", text: "Never sent", since: Date.now(), attempts: 0 } },
    });
    unattempted.status = "running";
    const unprovenStop = seededLedger.create({
      id: unprovenStopId, ownerBotId: bot.id, ownerThreadId: bot.activeTaskId, title: "99103 Unproven stopped desktop fixture", repo,
      permissionMode: "auto", surface: "app", desktop: { marker: "fixture-unproven-stop", turnsSeen: 0 },
    });
    unprovenStop.status = "stopped";
    seededLedger.save();
    mkdirSync(join(dataDir, ".claude"), { recursive: true });
    const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo synthetic-review-hook" }] }] };
    writeFileSync(join(dataDir, ".claude", "settings.json"), JSON.stringify({ hooks }));
    writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const prompt = argv.at(-1);
let cwd = process.cwd();
const w = argv.indexOf("-w");
if (w >= 0) { cwd = join(cwd, ".claude", "worktrees", argv[w + 1]); mkdirSync(cwd, { recursive: true }); }
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ argv, cwd, hooks: JSON.parse(readFileSync(join(process.env.HOME, ".claude", "settings.json"), "utf8")).hooks }) + "\\n");
console.log(JSON.stringify({ type: "system", subtype: "init", cwd, session_id: "fixture-terminal" }));
const gate = /GATE:(\\S+)/.exec(prompt)?.[1];
while (gate && !existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 20));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Synthetic terminal work completed", total_cost_usd: 0 }));
`);
    chmodSync(fake, 0o755);
    writeFileSync(guard, `import cp from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";
for (const name of ["execFile", "spawn"]) {
  const original = cp[name];
  cp[name] = function(command, ...args) {
    if (["xcrun", "osascript", "open", "screencapture"].includes(basename(String(command)))) {
      appendFileSync(${JSON.stringify(nativePath)}, JSON.stringify({ command: String(command) }) + "\\n");
      throw new Error("Native desktop launch blocked by isolated fixture");
    }
    return original.call(this, command, ...args);
  };
}
syncBuiltinESMExports();
`);
    const env = verificationServerEnvironment({ OMB_CC_BIN: fake, OMB_TEST_GRANT_PATH: "/usr/bin", OMB_AUTONOMY_TICK_MS: "100" }, dataDir, Number(new URL(url).port));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--import", guard, ...verificationServerArgs(env)], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    const script: any[] = [];
    const ledger = (): any[] => JSON.parse(readFileSync(join(dataDir, "cc-sessions.json"), "utf8")).sessions;
    await expect.poll(() => ledger().find(each => each.id === pendingId)?.status, { timeout: 10_000 }).toBe("stopped");
    expect(ledger().find(each => each.id === pendingId)).toMatchObject({ surface: "app", turns: 0,
      desktop: { pending: { kind: "create", attempts: 0 } } });
    evidence.unattempted = ledger().find(each => each.id === pendingId);
    const run = async (key: string, steps: unknown[]) => {
      script.push({ key, match: [key], steps, reply: `Acknowledged ${key}` });
      writeFileSync(planPath, JSON.stringify({ [bot.id]: { script: [...script, { key: "reports", match: [], repeat: true, reply: "Fixture report received" }] } }));
      const send = await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", key);
      await expect.poll(() => records(`${planPath}.evidence.jsonl`).find(turn => turn.planKey === key), { timeout: 20_000 }).toBeTruthy();
      const wait = await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20");
      const turn = records(`${planPath}.evidence.jsonl`).find(each => each.planKey === key);
      const results = turn.evidence.filter((entry: any) => entry.step).map((entry: any) => ({ step: entry.step, response: entry.response }));
      (evidence.actions as unknown[]).push({ key, send, wait, results });
      expect(send.success).toBe(true);
      expect(wait.status).toBe("settled");
      return results;
    };
    const sessions: string[] = [];
    for (const [index, surface] of ["cli", "app", undefined].entries()) {
      const key = `FULL_TERMINAL_${index}`;
      const gate = join(dataDir, `${key}.gate`);
      await run(key, [{ tool: "cc_session_start", arguments: { title: key, brief: `Synthetic work GATE:${gate}`, repo, ...(surface ? { surface } : {}) } }]);
      await expect.poll(() => records(callsPath).length, { timeout: 10_000 }).toBe(index + 1);
      const call = records(callsPath)[index];
      expect(call.argv[call.argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
      expect(call.hooks).toEqual(hooks);
      expect(call.argv).not.toContain("--setting-sources");
      expect(call.argv).not.toContain("--settings");
      const session = ledger().find(each => each.title === key);
      expect(session).toMatchObject({ surface: "cli", lastTurnPermissionMode: "bypassPermissions" });
      sessions.push(session.id);
      writeFileSync(gate, "release");
      await expect.poll(() => ledger().find(each => each.id === session.id).status, { timeout: 10_000 }).toBe("idle");
      await expect.poll(async () => (await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "1")).status, { timeout: 10_000 }).toBe("settled");
    }
    await expect.poll(() => records(`${planPath}.evidence.jsonl`).some(turn => turn.planKey === "reports"
      && JSON.stringify(turn.prompt).includes("permission mode bypassPermissions")), { timeout: 10_000 }).toBe(true);
    evidence.fullModeReported = true;
    const forged = await run("FORGED_PERMISSION", [{ tool: "cc_session_start", arguments: {
      title: "FORGED_PERMISSION", brief: "Synthetic forged mode", repo, surface: "cli", permission_mode: "bypassPermissions",
    }, expectError: true }]);
    expect(forged[0].response.error || forged[0].response.result?.isError).toBeTruthy();
    expect(records(callsPath)).toHaveLength(3);
    const historical = await run("HISTORICAL_DESKTOP", [{ tool: "cc_session_send", arguments: {
      session_id: historicalId, message: "Synthetic historical desktop follow-up",
    }, expectError: true }]);
    expect(historical[0].response.error || historical[0].response.result?.isError).toBeTruthy();
    expect(JSON.stringify(historical[0].response)).toMatch(/Full|terminal/i);
    expect(records(callsPath)).toHaveLength(3);
    expect(ledger()).toHaveLength(7);
    expect(ledger().find(each => each.id === historicalId)).toMatchObject({ surface: "app", turns: 0, queued: [] });
    const duplicate = await run("DUPLICATE_ISSUE", [{ tool: "cc_session_start", arguments: {
      title: "99101 Replacement terminal fixture", brief: "Synthetic replacement for issue #99101", repo,
    }, expectError: true }]);
    expect(JSON.stringify(duplicate[0].response)).toContain("já existe uma sessão viva");
    expect(records(callsPath)).toHaveLength(3);
    const uncertainArchive = await run("REFUSE_UNCERTAIN_ARCHIVE", [{ tool: "cc_session_archive", arguments: { session_id: uncertainId }, expectError: true }]);
    expect(uncertainArchive[0].response.error || uncertainArchive[0].response.result?.isError).toBeTruthy();
    expect(ledger().find(each => each.id === uncertainId)).toMatchObject({ surface: "app", status: "idle", turns: 0 });
    const unprovenArchive = await run("REFUSE_UNPROVEN_STOP", [{ tool: "cc_session_archive", arguments: { session_id: unprovenStopId }, expectError: true }]);
    expect(unprovenArchive[0].response.error || unprovenArchive[0].response.result?.isError).toBeTruthy();
    expect(ledger().find(each => each.id === unprovenStopId)).toMatchObject({ surface: "app", status: "stopped", turns: 0 });
    await run("ARCHIVE_UNATTEMPTED_START", [{ tool: "cc_session_archive", arguments: { session_id: pendingId } }]);
    expect(ledger().find(each => each.id === pendingId)).toMatchObject({ surface: "app", status: "archived", turns: 0,
      heldQueue: [expect.objectContaining({ text: "Never sent" })] });
    const archived = await run("ARCHIVE_LOCAL_RECORD", [{ tool: "cc_session_archive", arguments: { session_id: historicalId } }]);
    expect(archived[0].response.error || archived[0].response.result?.isError).toBeFalsy();
    expect(ledger().find(each => each.id === historicalId)).toMatchObject({ surface: "app", status: "archived", turns: 0 });
    expect(records(nativePath)).toEqual([]);
    await run("REPLACE_ARCHIVED_ISSUE", [{ tool: "cc_session_start", arguments: {
      title: "99101 Replacement terminal fixture", brief: "Synthetic replacement for issue #99101", repo,
    } }]);
    await expect.poll(() => records(callsPath).length, { timeout: 10_000 }).toBe(4);
    expect(ledger().find(each => each.title === "99101 Replacement terminal fixture")).toMatchObject({ surface: "cli", lastTurnPermissionMode: "bypassPermissions" });
    expect(ledger()).toHaveLength(8);
    await expect.poll(() => ledger().find(each => each.title === "99101 Replacement terminal fixture").status, { timeout: 10_000 }).toBe("idle");
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "10")).status).toBe("settled");
    await api(`/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, "PATCH", { approvalMode: "ask" });
    await run("REVOKED_PERMISSION", [{ tool: "cc_session_send", arguments: { session_id: sessions[0], message: "Synthetic follow-up after revocation" } }]);
    await expect.poll(() => records(callsPath).length, { timeout: 10_000 }).toBe(5);
    const revoked = records(callsPath)[4];
    expect(revoked.argv[revoked.argv.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(revoked.argv.slice(0, 3)).toEqual(["-p", "--resume", sessions[0]]);
    expect(revoked.hooks).toEqual(hooks);
    expect(ledger().find(each => each.id === sessions[0]).lastTurnPermissionMode).toBe("auto");
    expect(records(nativePath)).toEqual([]);
    for (const [path, before] of nativeSnapshots) expect(readFileSync(path, "utf8")).toBe(before);
    evidence.nativeStorageUnchanged = true;
    evidence.calls = records(callsPath);
    evidence.nativeCalls = records(nativePath);
    evidence.sessions = ledger();
    evidence.messages = await cli("messages", "--bot", bot.id, "--task", bot.activeTaskId);
  } finally {
    evidence.calls = records(callsPath);
    evidence.nativeCalls = records(nativePath);
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(`Claude terminal Full fixture evidence: ${evidencePath}`);
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
