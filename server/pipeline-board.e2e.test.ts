// GET /api/pipeline-board through the real server (lot Z): a disposable HOME
// whose ~/.nuria holds an excerpt of the real release log and whose
// ~/.openmausbot holds two Claude Code sessions, and a fake `gh` first on
// PATH that answers GitHub reads and records every call. The board answers at
// once, its live read of the open PRs lands for the next poll, an unchanged
// board is a 304, and GitHub is only ever read.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let log = "";

/** The fake gh: the board's query (open PRs with their merge state), the collector's reads, a log of every call. */
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
const query = (args.find((arg) => arg.startsWith("query=")) || "");
const ago = (hours) => new Date(Date.now() - hours * 3600e3).toISOString();
const rate = { remaining: 4900, resetAt: new Date(Date.now() + 3600e3).toISOString() };
const page = (nodes) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const out = (value) => process.stdout.write(JSON.stringify(value));
const open9332 = { number: 9332, title: "feat(atendimento): prazo de reabertura configurável (#9052)", body: "Closes #9052", createdAt: ago(60), updatedAt: ago(1), mergedAt: null, state: "OPEN", isDraft: false, baseRefName: "main", headRefName: "feat/9052-x", mergeStateStatus: "BEHIND", mergeCommit: null, closingIssuesReferences: { nodes: [{ number: 9052 }] }, labels: { nodes: [{ name: "priority:p1" }] }, commits: { nodes: [{ commit: { oid: "407e3f9247c315011ad85c663cf74c21bfb01475", status: null } }] } };
if (args[0] !== "api") { process.stderr.write("only gh api is expected"); process.exit(2); }
if (args[1] === "graphql") {
  if (query.includes("mergeStateStatus")) out({ data: { repository: { open: { nodes: [open9332] }, merged: { nodes: [] } }, rateLimit: rate } });
  else if (query.includes("states: OPEN")) out({ data: { repository: { pullRequests: page([{ number: 9332, title: open9332.title, createdAt: ago(60), isDraft: false, baseRefName: "main", commits: { nodes: [{ commit: { oid: "407e3f9247c315011ad85c663cf74c21bfb01475", status: null } }] } }]) }, rateLimit: rate } });
  else if (query.includes("issues(")) out({ data: { repository: { issues: page([
    { number: 9052, title: "Atendimento: criar configuração de tempo de reabertura", createdAt: ago(300), updatedAt: ago(2), closedAt: null, state: "OPEN", stateReason: null, labels: { nodes: [{ name: "priority:p1" }] } },
    { number: 9058, title: "Chats distribuídos mesmo com agentes offline", createdAt: ago(200), updatedAt: ago(2), closedAt: null, state: "OPEN", stateReason: null, labels: { nodes: [{ name: "priority:p1" }] } },
    { number: 9365, title: "fix(atendimento): aviso vermelho de limite de assentos (Fulana 01/10)", createdAt: ago(5), updatedAt: ago(5), closedAt: null, state: "OPEN", stateReason: null, labels: { nodes: [{ name: "bug" }] } },
  ]) }, rateLimit: rate } });
  else out({ data: { repository: { pullRequests: page([]) }, rateLimit: rate } });
  process.exit(0);
}
const path = args[1];
if (path === "repos/dinhogehm/nuria-platform") out({ created_at: "2025-06-01T12:00:00Z" });
else if (path === "rate_limit") out({ resources: { core: { remaining: 4900, reset: Math.floor(Date.now() / 1000) + 3600 } } });
else if (path.includes("/git/ref/tags/nuria-production-deployed")) out({ object: { sha: "a76a5aa0c72868462320e04c16174383b18cd69e", type: "commit" } });
else if (path.includes("/deployments")) out([]);
else if (path.includes("/compare/")) out({ total_commits: 0, commits: [] });
else { process.stderr.write("HTTP 404: " + path); process.exit(1); }
`;

async function start() {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: [bin, process.env.PATH ?? ""].join(delimiter),
      HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), OMB_WEBHOOK_PORT: String(PORT + 1),
      FAKE_GH_LOG: join(home, "gh-calls.ndjson"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => (log += chunk));
  child.stderr!.on("data", (chunk) => (log += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what} never happened: ${JSON.stringify(value).slice(0, 600)}\n${log.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

posixOnly("GET /api/pipeline-board", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-pipeline-board-e2e-"));
    mkdirSync(join(home, ".nuria", "logs"), { recursive: true });
    copyFileSync(join(SERVER_DIR, "testing", "fixtures", "productivity", "production-release.out.log"), join(home, ".nuria", "logs", "production-release.out.log"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    const now = Date.now();
    // the 9052 session ran a headless turn when the server stopped: it comes back failed (interrupted); 9058's waits idle
    writeFileSync(join(home, ".openmausbot", "cc-sessions.json"), JSON.stringify({ sessions: [
      { id: "35787b0f-ff38-459e-b543-0dd921d068f4", ownerBotId: "chief", ownerThreadId: "desk", title: "9052 Tempo de reabertura configurável", repo: "/repo", worktree: "/repo/wt", permissionMode: "auto", status: "running", surface: "cli", createdAt: now - 50 * 3600e3, lastActivityAt: now - 600e3, turns: 3, costUsd: 0, queued: [], delivery: { prs: { 9332: { url: "https://github.com/dinhogehm/nuria-platform/pull/9332", number: 9332, state: "open", owned: "branch" } } } },
      { id: "e47cf077-0000-4000-8000-000000000058", ownerBotId: "chief", ownerThreadId: "desk", title: "9058 Chat entra com aviso no Widget", repo: "/repo", worktree: "/repo/wt2", permissionMode: "auto", status: "idle", surface: "cli", createdAt: now - 40 * 3600e3, lastActivityAt: now - 20 * 3600e3, turns: 2, costUsd: 0, queued: [] },
    ] }));
    await start();
  });

  afterAll(async () => {
    child?.kill("SIGTERM");
    if (child) await waitForExit(child, 5_000);
    removeTempDir(home);
  });

  it("answers at once, before GitHub was ever read: the sessions known, the rest '—'", async () => {
    const { status, headers, body } = await get("/api/pipeline-board");
    expect(status).toBe(200);
    expect(headers.get("etag")).toMatch(/^"[\w-]+"$/);
    expect(body).toMatchObject({ version: 1, enabled: true, repo: "dinhogehm/nuria-platform" });
    expect(body.columns.map((column: any) => column.stage)).toEqual(["entry", "session", "pr", "gate", "release", "production"]);
    const session = body.columns.find((column: any) => column.stage === "session");
    expect(session.known).toBe(true);
    if (body.sources.githubSyncedAt === null) expect(body.columns.find((column: any) => column.stage === "entry")).toMatchObject({ known: false, total: null });
  });

  it("places the work once GitHub is read: the PR BEHIND blocked, the idle session in Sessão, the new client issue in Entrada", async () => {
    await get("/api/reports/productivity?granularity=day&count=30&refresh=1");
    const { body } = await until(() => get("/api/pipeline-board"), ({ body }) => body.sources.githubSyncedAt !== null && body.sources.livePrsAt !== null, "the sync and the live read");
    const cards = Object.fromEntries(body.columns.flatMap((column: any) => column.cards.map((card: any) => [card.key, card])));
    expect(cards["issue:9052"]).toMatchObject({ stage: "pr", state: "blocked", reason: { code: "behind" }, prs: [9332], priority: "p1" });
    expect(cards["issue:9058"]).toMatchObject({ stage: "session", state: "idle", reason: { code: "session-idle" } });
    expect(cards["issue:9365"]).toMatchObject({ stage: "entry", origin: "client", title: "Aviso vermelho de limite de assentos" });
    expect(JSON.stringify(body)).not.toContain("Fulana");
  });

  it("an unchanged board is a 304; a changed one comes whole", async () => {
    const first = await get("/api/pipeline-board");
    const again = await get("/api/pipeline-board", { "if-none-match": first.headers.get("etag")! });
    expect(again.status).toBe(304);
    const stale = await get("/api/pipeline-board", { "if-none-match": "\"not-this-one\"" });
    expect(stale.status).toBe(200);
    expect(stale.body.columns).toHaveLength(6);
  });

  it("asked GitHub for reads only", async () => {
    const calls = readFileSync(join(home, "gh-calls.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls.some((args) => args.join(" ").includes("mergeStateStatus"))).toBe(true);
    for (const args of calls) {
      if (args[0] !== "api") continue; // the delivery watcher's `gh pr view` (refused by the fake)
      expect(args).not.toContain("-X");
      expect(args).not.toContain("--method");
      expect(args.join(" ")).not.toMatch(/\bmutation\b/);
    }
  });
});
