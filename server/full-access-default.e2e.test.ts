// Real server, repository-owned fake engines only.
//
// fork: Ask até a pessoa escolher. Upstream v0.1.109 starts every bot at
// Full access; this fork keeps Ask as the level of a bot or thread nobody
// has set one on (DEFAULT_APPROVAL_MODE in shared/approval-mode.ts), on
// every engine family, and a new thread saves that Ask. Full access is only
// ever a level stored on the record, which the desktop's confirmed grant
// leaves behind; here the fixture writes it into its own disposable
// bots.json while the server is stopped (fixture setup, not a grant
// endpoint). A stored Full then runs in each engine's own most permissive
// mode, as upstream maps it, and a level a person lowers to Ask stays.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("starts new bots and threads at Ask on each engine family, and runs only a stored Full in each engine's permissive mode", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const { dataDir, url, logPath } = fixture.info;
  const codexDump = join(dataDir, "codex-dump.json");
  const droidDump = join(dataDir, "droid-dump.json");
  const botsPath = join(dataDir, "bots.json");
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const start = async () => {
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const send = (botId: string, threadId: string) => control("send", "--bot", botId, "--task", threadId, "--text", "Check the fixture report.");
  const wait = (botId: string, threadId: string) => control("wait", "--bot", botId, "--task", threadId, "--timeout", "30");
  const stored = (botId: string) => JSON.parse(readFileSync(botsPath, "utf8")).find((bot: any) => bot.id === botId);
  const storedTask = (botId: string, threadId: string) => stored(botId).tasks.find((task: any) => task.threadId === threadId);
  const wired = async (botId: string) => (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId);
  const openCard = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=50`)).messages as any[])
    .find((message) => message.card?.requestId && !message.card.answered)?.card;
  // An Ask turn on the permission-asking fixture stops on its card; deny it
  // so the turn settles.
  const denyCard = async (threadId: string) => {
    await expect.poll(() => openCard(threadId), { timeout: 20_000 }).toBeTruthy();
    const card = await openCard(threadId);
    await api("POST", `/api/threads/${threadId}/respond`, { requestId: card.requestId, behavior: "deny" });
  };
  const claudePermissionMode = () => {
    const argv = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).argv as string[];
    return argv[argv.indexOf("--permission-mode") + 1];
  };
  const lastCodexTurn = () => JSON.parse(readFileSync(codexDump, "utf8")).calls.findLast((call: any) => call.method === "turn/start");
  const lastDroidMode = () => JSON.parse(readFileSync(`${droidDump}.config.json`, "utf8")).findLast((call: any) => call.method === "session/set_mode");
  const decisionsFor = async (threadId: string) => ((await api("GET", "/api/decisions")).decisions as any[])
    .filter((row) => row.threadId === threadId).map((row) => `${row.decision}:${row.source}`);
  try {
    // Add the other engine families to the launcher's own temporary config
    // while it is stopped. Never the person's CLIs or home.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.codex.environment = { FAKE_CODEX_DUMP: codexDump };
    config.instances.droid = {
      driver: "droidAgent", displayName: "Droid fixture",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: { FACTORY_API_KEY: "fixture-only", FAKE_ACP_MODE: "permission", FAKE_ACP_DUMP: droidDump },
    };
    writeFileSync(configPath, JSON.stringify(config));
    await start();
    const instances = (await api("GET", "/api/instances")).instances as any[];
    const model = (instanceId: string) => ({ instanceId, model: instances.find((item) => item.instanceId === instanceId).models.default });

    // A bot made with no level stores none, and runs at Ask.
    const bots: Record<string, any> = {};
    for (const instanceId of ["claude", "codex", "droid"]) {
      bots[instanceId] = (await api("POST", "/api/bots", { name: `Default ${instanceId}`, modelSelection: model(instanceId) }, 201)).bot;
      expect(bots[instanceId].approvalMode).toBe("ask");
      expect(stored(bots[instanceId].id).approvalMode).toBeUndefined();
    }
    // A new thread on that bot starts at Ask, saves it on disk, and runs in
    // the engine's asking mode.
    const askThreads: Record<string, string> = {};
    for (const [instanceId, bot] of Object.entries(bots)) {
      const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: `New ${instanceId} thread` }, 201)).task;
      expect(task.approvalMode).toBe("ask");
      expect(storedTask(bot.id, task.threadId)).toMatchObject({ approvalMode: "ask", autoApprove: false });
      askThreads[instanceId] = task.threadId;
      await send(bot.id, task.threadId);
      if (instanceId === "droid") await denyCard(task.threadId);
      expect((await wait(bot.id, task.threadId)).status).toBe("settled");
    }
    expect(claudePermissionMode()).toBe("default");
    expect(lastCodexTurn().params).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } });
    expect(lastCodexTurn().params.sandboxPolicy.type).not.toBe("dangerFullAccess");
    expect(lastDroidMode()).toMatchObject({ method: "session/set_mode", params: { modeId: "normal" } });
    // Droid's permission request reached a person; Full answered nothing.
    expect(await decisionsFor(askThreads.droid)).not.toContain("auto-approved:full-access");

    // Onboarding's first bot is made the same way, whenever its engine is
    // connected: no level, so Ask, and on Codex the workspace-write turn.
    const starter = (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => !Object.values(bots).some((mine: any) => mine.id === bot.id));
    expect(starter.approvalMode).toBe("ask");
    expect(stored(starter.id).approvalMode).toBeUndefined();
    await api("PATCH", `/api/bots/${starter.id}`, { modelSelection: model("codex") });
    await send(starter.id, starter.threadId);
    expect((await wait(starter.id, starter.threadId)).status).toBe("settled");
    expect(lastCodexTurn().params).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } });

    // Full access is a stored level only. Fixture setup, not a grant
    // endpoint: stop the owned server and write it into the disposable
    // bots.json, as a confirmed desktop grant leaves it, on the three bots
    // and every thread they have.
    await waitForExit(server!, { signal: "SIGTERM" });
    const records = JSON.parse(readFileSync(botsPath, "utf8"));
    for (const record of records) {
      if (!Object.values(bots).some((bot: any) => bot.id === record.id)) continue;
      Object.assign(record, { approvalMode: "full", autoApprove: false, alwaysAllow: [] });
      for (const task of record.tasks ?? []) Object.assign(task, { approvalMode: "full", autoApprove: false, alwaysAllow: [] });
    }
    writeFileSync(botsPath, JSON.stringify(records, null, 2));
    await start();

    // A bot that saved Full opens its new threads at Full, and each engine
    // runs it in its own most permissive mode.
    const fullThreads: Record<string, string> = {};
    for (const [instanceId, bot] of Object.entries(bots)) {
      expect((await wired(bot.id)).approvalMode).toBe("full");
      const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: `Full ${instanceId} thread` }, 201)).task;
      expect(task.approvalMode).toBe("full");
      fullThreads[instanceId] = task.threadId;
      await send(bot.id, task.threadId);
      expect((await wait(bot.id, task.threadId)).status).toBe("settled");
    }
    expect(claudePermissionMode()).toBe("bypassPermissions");
    expect(lastCodexTurn().params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    expect(lastDroidMode()).toMatchObject({ method: "session/set_mode", params: { modeId: "auto-high" } });
    // Droid's remaining permission request was answered by Full, not carded.
    expect(await decisionsFor(fullThreads.droid)).toEqual(["auto-approved:full-access"]);
    expect(await openCard(fullThreads.droid)).toBeUndefined();

    // The bot nobody gave a level is still at Ask after the restart, and so
    // is the next thread it opens.
    expect((await wired(starter.id)).approvalMode).toBe("ask");
    expect(stored(starter.id).approvalMode).toBeUndefined();
    expect((await api("POST", `/api/bots/${starter.id}/tasks`, { title: "Still Ask" }, 201)).task.approvalMode).toBe("ask");

    // A level a person lowers stays: Ask reaches the bot and every thread,
    // survives a restart, and asks again on the next thread.
    expect((await api("PATCH", `/api/bots/${bots.droid.id}`, { approvalMode: "ask", applyToAllThreads: true })).bot.approvalMode).toBe("ask");
    await waitForExit(server!, { signal: "SIGTERM" });
    await start();
    expect(stored(bots.droid.id).approvalMode).toBe("ask");
    const askThread = (await api("POST", `/api/bots/${bots.droid.id}/tasks`, { title: "Ask thread" }, 201)).task;
    expect(askThread.approvalMode).toBe("ask");
    expect((await wired(bots.claude.id)).approvalMode).toBe("full");
    await send(bots.droid.id, askThread.threadId);
    await denyCard(askThread.threadId);
    expect((await wait(bots.droid.id, askThread.threadId)).status).toBe("settled");
    expect(lastDroidMode()).toMatchObject({ params: { modeId: "normal" } });
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 180_000);
