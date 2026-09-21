import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

// Two bots pointed at one project folder. The folder is held for a whole
// turn — two engines editing one checkout overwrite each other — but the
// second turn must QUEUE, not die: it shows a chip naming who is in there,
// and it starts on its own the moment that turn ends. This server runs with
// a short wait cap so the give-up path is reachable in seconds too.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess;
let home = "";
let base = "";
let project = "";
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const fixture = (displayName: string, environment: Record<string, string>) => ({
  driver: "claudeAgent",
  displayName,
  environment,
  config: { cli: FAKE_CLAUDE },
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-workspace-queue-"));
  project = join(home, "shared-project");
  mkdirSync(project, { recursive: true });
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Workspace queue test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      hang: fixture("Holds the folder", { FAKE_CLAUDE_MODE: "hang" }),
      quick: fixture("Waits for the folder", {
        FAKE_CLAUDE_MODE: "happy",
        FAKE_CLAUDE_REPLIES: JSON.stringify(["Got the folder, work done."]),
        FAKE_CLAUDE_REPLY_STATE: join(home, "quick-replies.txt"),
      }),
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_STATIC_DIR: staticDir,
      // seconds, not minutes: this file also exercises the give-up path
      OMB_GOAL_WAIT_MAX_MS: "4000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // Still starting.
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const createBot = async (name: string, instanceId: string) => {
  const created = (await api("POST", "/api/bots", {
    name,
    modelSelection: { instanceId, model: "claude-sonnet-5" },
    requireAvailableModel: true,
  })).body.bot;
  expect((await api("PATCH", `/api/bots/${created.id}`, { cwd: project })).status).toBe(200);
  return created;
};

/** Every activity chip this bot has shown, newest last. */
const chips = async (botId: string): Promise<string[]> => {
  const state = (await api("GET", "/api/bots?messages=40")).body;
  const bot = state.bots.find((candidate: { id: string }) => candidate.id === botId);
  return (bot?.messages ?? [])
    .filter((message: { kind: string }) => message.kind === "activity")
    .map((message: { tool?: { name?: string } }) => message.tool?.name ?? "");
};

it("queues a second turn behind the folder instead of failing it", async () => {
  const holder = await createBot("Holder", "hang");
  const waiter = await createBot("Waiter", "quick");

  // The holder takes the folder and never lets go on its own.
  expect((await api("POST", `/api/bots/${holder.id}/messages`, { text: "Start working in the folder." })).status).toBe(202);
  await expect.poll(async () => {
    const state = (await api("GET", "/api/bots?messages=0")).body;
    return state.bots.find((candidate: { id: string }) => candidate.id === holder.id)?.busy === true;
  }, { timeout: 15_000 }).toBe(true);

  // The second turn is accepted — this is the whole point. Before, the
  // dispatch failed outright with workspace_busy.
  expect((await api("POST", `/api/bots/${waiter.id}/messages`, { text: "I need the same folder." })).status).toBe(202);
  await expect.poll(async () => (await chips(waiter.id)).some((chip) => chip.includes("Waiting for its turn in this project folder")), {
    timeout: 15_000,
  }).toBe(true);
  // the chip names who is in there, so the wait is never a mystery
  const waitingChip = (await chips(waiter.id)).find((chip) => chip.includes("Waiting for its turn"))!;
  expect(waitingChip).toContain("Holder");
  expect(waitingChip).not.toMatch(/error|failed/i);

  // Free the folder: the queued turn starts on its own and answers.
  expect((await api("POST", `/api/bots/${holder.id}/interrupt`)).status).toBeLessThan(300);
  await expect.poll(async () => {
    const state = (await api("GET", "/api/bots?messages=40")).body;
    const bot = state.bots.find((candidate: { id: string }) => candidate.id === waiter.id);
    return JSON.stringify(bot?.messages ?? []).includes("Got the folder, work done.");
  }, { timeout: 30_000 }).toBe(true);
  expect(await chips(waiter.id)).toContainEqual(expect.stringContaining("Project folder free — continuing"));
}, 120_000);

it("gives up with a folder message, and a way out, when the holder never finishes", async () => {
  const holder = await createBot("Holder two", "hang");
  const waiter = await createBot("Waiter two", "quick");

  expect((await api("POST", `/api/bots/${holder.id}/messages`, { text: "Hold the folder." })).status).toBe(202);
  await expect.poll(async () => {
    const state = (await api("GET", "/api/bots?messages=0")).body;
    return state.bots.find((candidate: { id: string }) => candidate.id === holder.id)?.busy === true;
  }, { timeout: 15_000 }).toBe(true);

  expect((await api("POST", `/api/bots/${waiter.id}/messages`, { text: "Same folder again." })).status).toBe(202);
  await expect.poll(async () => {
    const state = (await api("GET", "/api/bots?messages=40")).body;
    const bot = state.bots.find((candidate: { id: string }) => candidate.id === waiter.id);
    return JSON.stringify(bot?.messages ?? []);
  }, { timeout: 30_000 }).toMatch(/still working in this project folder/);

  // the chip truncates a long tool name, so assert on what survives it —
  // the give-up sentence itself is covered by workspace-wait.test.ts
  const text = JSON.stringify((await api("GET", "/api/bots?messages=40")).body);
  expect(text).toMatch(/Holder two is still running Hold the folder/);
  await api("POST", `/api/bots/${holder.id}/interrupt`);
}, 120_000);
