import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess;
let fixtureHome = "";
let base = "";
let stateFile = "";
let dumpFile = "";
let finishFile = "";
let stderr = "";
let boxServer: Server;
let boxRow: { id: string; name: string; state: string } | null = null;
let allowBoxCreation = false;
const boxCalls: Array<{ method: string; path: string }> = [];
const boxPrompts: Array<Record<string, unknown>> = [];
const vmState = (state: Record<string, unknown> = {}) => writeFileAtomic(stateFile, JSON.stringify(state));
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await r.json() as any;
  expect(r.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
  return result;
};
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${stderr}`);
    await new Promise(r => setTimeout(r, 40));
  }
}
const dump = () => until(() => existsSync(dumpFile) ? JSON.parse(readFileSync(dumpFile, "utf8")) : null, Boolean);
const idle = (botId: string) => until(() => api("GET", "/api/bots?messages=0"), s => !s.bots.find((b: any) => b.id === botId)?.busy);
const computer = (d: any) => d.mcpConfig.mcpServers.computer;
const gate = (c: any) => fetch(c.env.OMB_CONTROL_URL, { headers: { authorization: `Bearer ${c.env.OMB_CONTROL_TOKEN}` } });

beforeAll(async () => {
  fixtureHome = mkdtempSync(join(tmpdir(), "omb-group-vm-"));
  stateFile = join(fixtureHome, "vm.json");
  dumpFile = join(fixtureHome, "dump.json");
  finishFile = join(fixtureHome, "finish");
  vmState();
  const data = join(fixtureHome, "data");
  const ui = join(fixtureHome, "static");
  mkdirSync(data); mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<title>Isolated VM routing</title>");
  writeFileSync(join(ui, "assets", "test.css"), "body{}");
  boxServer = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://box.fixture").pathname;
    boxCalls.push({ method: req.method ?? "GET", path });
    res.setHeader("content-type", "application/json");
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (path === "/boxes" && req.method === "POST") {
      if (!allowBoxCreation) { res.statusCode = 409; return res.end(JSON.stringify({ error: "Unexpected Box creation in routing fixture" })); }
      boxRow = { id: "bx_23456789", name: body.name ?? "fixture-new-box", state: "idle" };
      return res.end(JSON.stringify({ box: boxRow }));
    }
    if (path === "/boxes") return res.end(JSON.stringify({ boxes: boxRow ? [boxRow] : [] }));
    if (/^\/boxes\/bx_[^/]+$/.test(path)) {
      if (!boxRow) res.statusCode = 404;
      else if (req.method === "PATCH" && body.name) boxRow.name = body.name;
      return res.end(JSON.stringify(boxRow ? { box: boxRow } : { error: "missing" }));
    }
    if (path.endsWith("/desktop")) return res.end(JSON.stringify({ desktopUrl: "https://desktop.fixture.invalid/" }));
    if (path.endsWith("/resume") && boxRow) { boxRow.state = "idle"; return res.end("{}"); }
    if (path.endsWith("/prompt") && req.method === "POST") {
      boxPrompts.push(body);
      return res.end(JSON.stringify({ promptRun: { id: "fixture-prompt" } }));
    }
    if (path.includes("/prompts/")) return res.end(JSON.stringify({ promptRun: { status: "finished", result: "Cloud fixture completed" } }));
    return res.end("{}");
  });
  await new Promise<void>(resolve => boxServer.listen(0, "127.0.0.1", resolve));
  const boxPort = (boxServer.address() as { port: number }).port;
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
    driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
    environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
  }, computer: { driver: "boxAgent", config: { pollMs: 10 } } } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href, join(ROOT, "server/index.ts")], {
    cwd: ROOT, env: {
      PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: fixtureHome, USERPROFILE: fixtureHome, OMB_DATA_DIR: data,
      APPDATA: join(fixtureHome, "appdata"), LOCALAPPDATA: join(fixtureHome, "localappdata"),
      TEMP: fixtureHome, TMP: fixtureHome, TMPDIR: fixtureHome,
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui, OMB_TEST_VM_STATE: stateFile,
      OMB_BOX_API: `http://127.0.0.1:${boxPort}`,
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", () => {});
  child.stderr!.on("data", c => { stderr += c; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(stderr);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, Boolean);
});
afterAll(async () => {
  if (stateFile) vmState();
  if (finishFile) writeFileSync(finishFile, "finish");
  await waitForExit(child, { signal: "SIGTERM" });
  if (boxServer) await new Promise<void>(resolve => boxServer.close(() => resolve()));
  if (fixtureHome) await removeTempDir(fixtureHome);
});
const rooms: string[] = [];
afterEach(async () => {
  vmState();
  writeFileSync(finishFile, "finish");
  for (const id of rooms.splice(0)) await stop(id);
});
async function room() {
  vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
  const bots = [];
  for (const name of ["VM lead", "VM worker"]) {
    const { bot } = await api("POST", "/api/bots", { name });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "vm" });
    bots.push(bot);
  }
  const { group } = await api("POST", "/api/groups", { name: "Fixture VM room", memberIds: bots.map(b => b.id),
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: bots[0].id } } });
  rooms.push(group.id);
  return { bots, group };
}
const send = (id: string) => api("POST", `/api/groups/${id}/messages`, { text: "Reply once." });
const stop = (id: string) => api("POST", `/api/groups/${id}/interrupt`, {});

describe("Group Local VM ownership on the real isolated server", () => {
  it.each(["wake", "removed", "missing-auto"])("chat selection starts or provisions a configured cloud computer (%s) only after selecting it", async state => {
    vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot } = await api("POST", "/api/bots", { name: "Chat cloud selection" });
    try {
      await api("PUT", "/api/config", { box: { token: "box_fixture" } });
      await api("PATCH", `/api/bots/${bot.id}`, { computer: state === "missing-auto" ? "browser" : "vm", browser: false });
      const environmentId = readFileSync(join(fixtureHome, "data", "environment-id"), "utf8").trim();
      const scope = createHash("sha256").update(environmentId).digest("hex").slice(0, 12);
      const prefix = bot.id.slice(0, 8).replace(/[^a-z0-9]/g, "");
      const suffix = createHash("sha256").update(bot.id).digest("hex").slice(0, 6);
      boxRow = { id: "bx_23456789", name: `ogb-${scope}-${prefix}-${suffix}`, state: "archived" };
      allowBoxCreation = true;
      if (state === "missing-auto") { boxRow = null; vmState({ failed: true }); }
      boxCalls.length = 0; boxPrompts.length = 0;
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on the cloud VM" });
      const before: any = await dump();
      if (computer(before)) expect((await gate(computer(before))).status).toBe(200);
      const token = before.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      const options = await (await fetch(base + "/api/internal/computer/select", { headers: { authorization: `Bearer ${token}` } })).json() as any;
      expect(options.options.find((option: any) => option.surface === "cloud")).toMatchObject({ available: true, ready: false,
        canStart: state !== "missing-auto", canCreate: state === "missing-auto" });
      expect(boxCalls.every(call => call.method === "GET")).toBe(true);
      const result = await fetch(base + "/api/internal/computer/select", { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ surface: state === "missing-auto" ? "auto" : "cloud" }) });
      expect(await result.json()).toMatchObject({ status: "pending", surface: "cloud" });
      if (computer(before)) expect((await gate(computer(before))).status).toBe(401);
      expect((await fetch(base + "/api/internal/computer/select", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
      expect(boxCalls.every(call => call.method === "GET")).toBe(true);
      if (state === "removed") boxRow = null;
      writeFileSync(finishFile, "finish");
      await until(() => api("GET", "/api/bots?messages=30"), result => {
        const saved = result.bots.find((b: any) => b.id === bot.id);
        return !saved.busy && boxPrompts.length === 1;
      });
      expect(boxCalls.filter(call => call.method === "POST" && call.path === "/boxes")).toHaveLength(state === "wake" ? 0 : 1);
      expect(boxCalls.some(call => call.path.endsWith("/resume"))).toBe(state === "wake");
      expect(boxPrompts[0]).toMatchObject({ model: "claude-fable-5" });
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Inspect the current page on the same cloud VM" });
      await until(async () => boxPrompts.length === 2 && !(await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id).busy, Boolean);
      expect(boxCalls.filter(call => call.method === "POST" && call.path === "/boxes")).toHaveLength(state === "wake" ? 0 : 1);
    } finally {
      writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}); await idle(bot.id);
      boxRow = null;
      allowBoxCreation = false;
      await api("DELETE", `/api/bots/${bot.id}`);
      await api("PUT", "/api/config", { box: { token: "" } });
    }
  });

  it("lets a chat tool select Auto, replaces tools after completion, and continues the same user message once", async () => {
    vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot } = await api("POST", "/api/bots", { name: "Chat selects computer" });
    try {
      await api("PUT", "/api/config", { box: { token: "box_fixture" } });
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: false });
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on an available VM and inspect its page title" });
      const before: any = await dump();
      expect(computer(before)).toBeUndefined();
      const token = before.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      const call = (method: string, body?: unknown) => fetch(base + "/api/internal/computer/select", { method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const available = await (await call("GET")).json() as any;
      expect(available.canSelect).toBe(true);
      expect(available.options).toContainEqual(expect.objectContaining({ surface: "vm", available: true }));
      expect(available.options).toContainEqual(expect.objectContaining({ surface: "cloud", ready: false, canCreate: true }));
      expect(await (await call("POST", { surface: "auto" })).json()).toMatchObject({ status: "pending", surface: "vm" });
      expect((await call("POST", { surface: "cloud" })).status).toBe(409);
      rmSync(dumpFile, { force: true });
      writeFileSync(finishFile, "finish");
      const after: any = await dump();
      expect(computer(after)).toBeTruthy();
      expect(after.systemPrompt).toContain("Local VM");
      expect(after.systemPrompt).not.toContain("call select_computer");
      await idle(bot.id);
      const state = await api("GET", "/api/bots?messages=30");
      const saved = state.bots.find((b: any) => b.id === bot.id);
      expect(saved.tasks.find((task: any) => task.threadId === bot.threadId).surface).toBe("vm");
      expect(saved.messages.filter((message: any) => message.role === "user" && message.kind === "text")).toHaveLength(1);
      expect((await call("GET")).status).toBe(401);
    } finally {
      writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}); await idle(bot.id);
      await api("DELETE", `/api/bots/${bot.id}`);
      await api("PUT", "/api/config", { box: { token: "" } });
    }
  });

  it.each(["stop", "failure", "off", "manual-selection", "new-request"])("does not continue a computer selection after %s", async failure => {
    vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
    const { bot } = await api("POST", "/api/bots", { name: `Computer selection ${failure}` });
    try {
      await api("PATCH", `/api/bots/${bot.id}`, { computer: failure === "off" ? "off" : "browser", browser: false });
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on the VM" });
      const sent: any = await dump();
      const token = sent.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      const selected = await fetch(base + "/api/internal/computer/select", { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ surface: "vm" }) });
      expect(selected.status).toBe(failure === "off" ? 403 : 200);
      rmSync(dumpFile, { force: true });
      if (failure === "failure") process.kill(sent.pid, "SIGKILL");
      else if (failure === "manual-selection") {
        const changing = await fetch(base + `/api/bots/${bot.id}/tasks/${bot.threadId}`, { method: "PATCH",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ surface: "browser" }) });
        expect(changing.status).toBe(409);
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}); await idle(bot.id);
        await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { surface: "browser" });
      } else if (failure === "new-request") {
        const queued = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Forget the VM request. Just answer this new question." });
        expect(queued.queued).toBe(true);
        writeFileSync(finishFile, "finish");
        const next: any = await dump();
        expect(computer(next)).toBeUndefined();
      } else await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await idle(bot.id);
      if (failure !== "new-request") expect(existsSync(dumpFile)).toBe(false);
      const state = await api("GET", "/api/bots?messages=0");
      expect(state.bots.find((b: any) => b.id === bot.id).tasks[0].surface).toBe(failure === "manual-selection" ? "browser" : undefined);
    } finally {
      writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}); await idle(bot.id);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("runs successive direct tasks on their pinned Local VM despite a Cloud profile default", async () => {
    vmState();
    const { bot } = await api("POST", "/api/bots", { name: "Pinned Local VM" });
    try {
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud", browser: false });
      for (const text of ["Open Chrome on the Local VM", "Inspect the page title on the same Local VM"]) {
        const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, {});
        await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "vm" });
        rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true });
        await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: task.threadId });
        const sent = await dump() as { systemPrompt: string };
        expect(sent.systemPrompt).toContain("Local VM");
        expect(sent.systemPrompt).not.toContain("You can act on the user's computer");
        const c = computer(sent);
        expect(c).toBeTruthy();
        expect(c.args.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
        expect((await gate(c)).status).toBe(200);
        expect((await api("GET", `/api/bots/${bot.id}/computer?threadId=${task.threadId}`)).surface).toBe("vm");
        writeFileSync(finishFile, "finish");
        await until(() => api("GET", "/api/bots?messages=0"), state => !state.bots.find((b: any) => b.id === bot.id)?.tasks.find((t: any) => t.threadId === task.threadId)?.busy);
        expect((await gate(c)).status).toBe(401);
      }
    } finally {
      writeFileSync(finishFile, "finish");
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await idle(bot.id);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("reports unsupported channel destinations instead of dispatching without the promised tools", async () => {
    const { bots, group } = await room();
    await api("PATCH", `/api/bots/${bots[0].id}`, { computer: "local" });
    await send(group.id);
    await until(() => api("GET", "/api/bots?messages=30"), state => JSON.stringify(state).includes("not available in channels yet"));
    await idle(bots[0].id);
    expect(existsSync(dumpFile)).toBe(false);
  });

  it("releases a failed readiness claim so the bot and room can run again", async () => {
    const { bots, group } = await room();
    vmState({ failed: true });
    await send(group.id);
    await until(() => api("GET", "/api/bots?messages=30"), r => JSON.stringify(r).includes("fixture desktop unavailable"));
    await idle(bots[0].id);
    vmState();
    await send(group.id);
    const c = computer(await dump());
    expect((await gate(c)).status).toBe(200);
    await stop(group.id); await idle(bots[0].id);
  });
  it("does not dispatch after Stop during readiness and releases the old lease", async () => {
    const { bots, group } = await room();
    vmState({ blocked: true }); rmSync(stateFile + ".entered", { force: true });
    await send(group.id);
    await until(() => existsSync(stateFile + ".entered"), Boolean);
    await stop(group.id);
    vmState();
    await idle(bots[0].id);
    expect(existsSync(dumpFile)).toBe(false);
    await send(group.id);
    expect(computer(await dump())).toBeTruthy();
    await stop(group.id); await idle(bots[0].id);
  });
  it("revokes the previous member and rejects cross-bot control after a shared desktop handoff", async () => {
    const { bots, group } = await room();
    await send(group.id);
    const first = computer(await dump());
    expect((await gate(first)).status).toBe(200);
    writeFileSync(finishFile, "finish"); await idle(bots[0].id);
    expect((await gate(first)).status).toBe(401);
    rmSync(finishFile, { force: true }); rmSync(dumpFile, { force: true });
    await api("PATCH", `/api/groups/${group.id}`, { defaultResponder: { kind: "member", botId: bots[1].id } });
    await send(group.id);
    const second = computer(await dump());
    expect(second.args).toEqual(first.args);
    expect((await gate(second)).status).toBe(200);
    expect((await gate(first)).status).toBe(401);
    const impersonation = await fetch(second.env.OMB_CONTROL_URL.replace(bots[1].id, bots[0].id), {
      headers: { authorization: `Bearer ${second.env.OMB_CONTROL_TOKEN}` },
    });
    expect(impersonation.status).toBe(403);
    await stop(group.id); await idle(bots[1].id);
  });
  it("denies computer access when an otherwise active speaker's lease expires", async () => {
    const { bots, group } = await room();
    await send(group.id);
    const c = computer(await dump());
    expect((await gate(c)).status).toBe(200);
    vmState({ clockOffset: 31 * 60_000 });
    expect((await gate(c)).status).toBe(401);
    await stop(group.id); await idle(bots[0].id); vmState();
  });
  it.each(["timeout", "stall"])("releases %s bookkeeping after the interrupt grace period", async (failure) => {
    const { bots, group } = await room();
    vmState({ timeout: failure === "timeout" });
    await send(group.id);
    const c = computer(await dump());
    if (failure === "stall") vmState({ stall: true });
    await idle(bots[0].id);
    expect((await gate(c)).status).toBe(401);
    // Mode changes reject stale localVmActiveThreads even after the bot is idle.
    await api("PATCH", "/api/config", { localVm: { mode: "per-bot", maxInstances: 2 } });
    vmState({ noContainers: true });
    await api("PATCH", "/api/config", { localVm: { mode: "shared", maxInstances: 2 } });
    vmState();
  });
});
