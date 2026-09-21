// The Chief's "Team incidents" thread is found by title and reused, so
// without rotation every report re-sends a transcript that only ever grows:
// one workspace reached millions of input tokens on a thread nobody had
// read in days. Full means archived — still readable, and the lookup skips
// archived threads — and the next report opens a fresh one with a link
// back.
//
// This spawns its own server (rather than the shared verification fixture,
// which deliberately lets nothing but FAKE_CLAUDE_* through) so the message
// limit can be 2 and the rotation happens on the second incident instead of
// the two-hundredth.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess;
let home = "";
let base = "";
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
  home = mkdtempSync(join(tmpdir(), "omb-incidents-rotate-"));
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Incident rotation test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      crash: fixture("Crashes on every run", { FAKE_CLAUDE_MODE: "exit-early" }),
      chief: fixture("Reads its incidents", {
        FAKE_CLAUDE_MODE: "happy",
        FAKE_CLAUDE_REPLIES: JSON.stringify(["Noted, I will look at it."]),
        FAKE_CLAUDE_REPLY_STATE: join(home, "chief-replies.txt"),
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
      // two messages, not two hundred: the point is the rotation, not the size
      OMB_INCIDENTS_THREAD_MAX: "2",
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

const createBot = async (name: string, instanceId: string) =>
  (await api("POST", "/api/bots", {
    name,
    section: "Ops",
    modelSelection: { instanceId, model: "claude-sonnet-5" },
    requireAvailableModel: true,
  })).body.bot;

const tasksOf = async (botId: string) => {
  const state = (await api("GET", "/api/bots?messages=0")).body;
  return (state.bots.find((bot: { id: string }) => bot.id === botId)?.tasks ?? []) as any[];
};

const incidentThreads = async (chiefId: string) =>
  (await tasksOf(chiefId)).filter((task) => task.title === "Team incidents");

const messagesOf = async (threadId: string) =>
  ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages ?? []) as any[];

it("archives a full incidents thread and opens a fresh one that links back", async () => {
  const chief = await createBot("Clive", "chief");
  expect((await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true })).status).toBe(200);
  const ada = await createBot("Ada", "crash");
  const bob = await createBot("Bob", "crash");

  // First crash: the Chief's incidents thread appears and takes the report.
  expect((await api("POST", `/api/bots/${ada.id}/messages`, { text: "Reconcile the September invoices." })).status).toBe(202);
  await expect.poll(async () => (await incidentThreads(chief.id)).length, { timeout: 30_000 }).toBe(1);
  const first = (await incidentThreads(chief.id))[0];
  await expect.poll(
    async () => (await messagesOf(first.threadId)).some((message) => (message.tool?.name ?? "").includes("Ada's run")),
    { timeout: 20_000 },
  ).toBe(true);
  // past the (test-sized) limit now: the chip plus the report line
  await expect.poll(async () => (await messagesOf(first.threadId)).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

  // Second crash, a different worker: the full thread is retired and the
  // report lands in a NEW thread instead of growing the old one.
  expect((await api("POST", `/api/bots/${bob.id}/messages`, { text: "Publish the changelog." })).status).toBe(202);
  await expect.poll(async () => (await incidentThreads(chief.id)).length, { timeout: 40_000 }).toBe(2);

  const threads = await incidentThreads(chief.id);
  const archived = threads.find((task) => task.threadId === first.threadId);
  const fresh = threads.find((task) => task.threadId !== first.threadId)!;
  expect(archived?.archivedAt).toBeGreaterThan(0);
  expect(fresh.archivedAt).toBeFalsy();

  // The fresh thread opens with a link back, and carries Bob's report.
  const opened = await messagesOf(fresh.threadId);
  expect(opened[0]?.tool?.name).toMatch(/Earlier incidents moved to an archived thread/);
  expect(opened[0]?.threadRef).toMatchObject({ botId: chief.id, threadId: first.threadId, title: "Team incidents" });
  await expect.poll(
    async () => (await messagesOf(fresh.threadId)).some((message) => (message.tool?.name ?? "").includes("Bob's run")),
    { timeout: 20_000 },
  ).toBe(true);

  // …and the old thread never saw Bob at all — that is the whole point.
  expect((await messagesOf(first.threadId)).some((message) => (message.tool?.name ?? "").includes("Bob's run"))).toBe(false);
  // nothing was deleted: the archived thread is still readable
  expect((await messagesOf(first.threadId)).length).toBeGreaterThanOrEqual(2);
}, 150_000);
