// GET /api/reports/productivity through the real server (lot V): a disposable
// HOME whose ~/.nuria holds an excerpt of the real release log, and a fake
// `gh` first on PATH that answers GitHub reads from fixtures and records every
// call. The report answers at once from the cache, `refresh=1` starts a sync
// in the background, the numbers follow São Paulo's calendar, the exports
// download as Markdown and PDF without any title, and nothing is ever written
// to GitHub.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

const F50 = "f50b70a3df5898865020e052c3749c3ddf6f2548";
const A76 = "a76a5aa0c72868462320e04c16174383b18cd69e";

let child: ChildProcess;
let home: string;
let log = "";

/** The fake gh: GitHub's answers for this excerpt, and a log of every call. */
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
const query = (args.find((arg) => arg.startsWith("query=")) || "");
const empty = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
const rate = { remaining: 4900, resetAt: "2026-10-02T20:00:00Z" };
const pr = (number, merged, head, closes, title, body = "") => ({ number, title, body, createdAt: "2026-09-17T12:00:00Z", updatedAt: merged, mergedAt: merged, closedAt: merged, state: "MERGED", isDraft: false, baseRefName: "main", headRefName: head, mergeCommit: { oid: "m" + number, message: title }, closingIssuesReferences: { nodes: closes.map((number) => ({ number })) }, labels: { nodes: [] } });
const out = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] !== "api") { process.stderr.write("only gh api is expected"); process.exit(2); }
if (args[1] === "graphql") {
  if (query.includes("states: OPEN")) out({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
    { number: 9001, title: "Cliente Zeta: ajuste", createdAt: "2026-09-17T09:00:00Z", isDraft: false, baseRefName: "main", commits: { nodes: [{ commit: { oid: "h1", status: null } }] } },
  ] } }, rateLimit: rate } });
  else if (query.includes("issues(")) out({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
    { number: 8986, title: "Cliente Zeta: tela quebrada", createdAt: "2026-09-16T10:00:00Z", updatedAt: "2026-09-17T14:00:00Z", closedAt: "2026-09-17T14:00:00Z", state: "CLOSED", stateReason: "COMPLETED", labels: { nodes: [{ name: "type:bug" }, { name: "priority:p1" }] } },
    { number: 8800, title: "Cliente Zeta: antiga", createdAt: "2026-08-01T10:00:00Z", updatedAt: "2026-09-01T10:00:00Z", closedAt: null, state: "OPEN", stateReason: null, labels: { nodes: [{ name: "priority:p0" }] } },
  ] } }, rateLimit: rate } });
  else out({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
    pr(8987, "2026-09-17T14:00:00Z", "hotfix/8987-tela", [8986], "Cliente Zeta: corrige tela"),
    pr(8990, "2026-09-17T14:10:00Z", "chore/release-carrier-hotfix-8987", [], "carrier"),
  ] } }, rateLimit: rate } });
  process.exit(0);
}
const path = args[1];
if (path === "repos/dinhogehm/nuria-platform") out({ created_at: "2025-06-01T12:00:00Z" });
else if (path === "rate_limit") out({ resources: { core: { remaining: 4900, reset: 1790971200 } } });
else if (path.includes("/git/ref/tags/nuria-production-deployed")) out({ object: { sha: "${A76}", type: "commit" } });
else if (path.includes("/deployments")) out([]);
else if (path.includes("/compare/${F50}...${A76}")) out({ total_commits: 2, commits: [{ sha: "m8987" }, { sha: "m8990" }] });
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

const get = async (path: string) => {
  const res = await fetch(`${BASE}${path}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  let body: any = null;
  try { body = JSON.parse(buffer.toString("utf8")); } catch { /* an export */ }
  return { status: res.status, headers: res.headers, body, buffer };
};

posixOnly("GET /api/reports/productivity", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-productivity-e2e-"));
    mkdirSync(join(home, ".nuria", "logs"), { recursive: true });
    copyFileSync(join(SERVER_DIR, "testing", "fixtures", "productivity", "production-release.out.log"), join(home, ".nuria", "logs", "production-release.out.log"));
    await start();
  });

  afterAll(async () => {
    child?.kill("SIGTERM");
    if (child) await waitForExit(child, 5_000);
    removeTempDir(home);
  });

  it("refuses a bad granularity, count or range", async () => {
    expect((await get("/api/reports/productivity?granularity=week")).status).toBe(400);
    expect((await get("/api/reports/productivity?granularity=day&count=-1")).status).toBe(400);
    expect((await get("/api/reports/productivity?granularity=day&from=2026-09-30")).body).toEqual({ error: "from and to go together" });
    expect((await get("/api/reports/productivity?granularity=day&from=2026-09-31&to=2026-10-01")).status).toBe(400);
    expect((await get("/api/reports/productivity?granularity=hour&from=2026-01-01&to=2026-09-01")).status).toBe(400);
  });

  it("answers at once from the cache, and refresh=1 syncs in the background", async () => {
    const first = await get("/api/reports/productivity?granularity=day&from=2026-09-17&to=2026-09-17&refresh=1");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.body).toMatchObject({ version: 2, enabled: true, timezone: "America/Sao_Paulo", granularity: "day", repo: "dinhogehm/nuria-platform" });
    let report = first.body;
    const deadline = Date.now() + 20_000;
    while (!(report.sync.state === "idle" && report.sync.lastSyncAt)) {
      if (Date.now() > deadline) throw new Error(`sync never finished: ${JSON.stringify(report.sync)}\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      report = (await get("/api/reports/productivity?granularity=day&from=2026-09-17&to=2026-09-17")).body;
    }
    expect(report.sync.error).toBeNull();
  });

  it("counts the day of the excerpt in São Paulo: releases, failures, refusal, what each release carried", async () => {
    const { body: report } = await get("/api/reports/productivity?granularity=day&from=2026-09-17&to=2026-09-17");
    expect(report.buckets.map((bucket: any) => bucket.key)).toEqual(["2026-09-17"]);
    // 13:27Z and 16:16Z are the 17th in São Paulo; so is 22:02Z (19:02); the 01:33Z failures were still the 16th there
    expect(report.kpis).toMatchObject({ deliveries: 2, failedReleases: 2, supersededReleases: 1, abortedReleases: 0, releaseSuccessRate: 0.5, declinedReleases: 1, deliveredPrs: 1, deliveredIssues: 1, mergedPrs: 1, carrierPrs: 1, closedIssues: 1 });
    expect(report.kpis.leadIssueToProd).toEqual({ n: 1, median: Date.parse("2026-09-17T16:16:13Z") - Date.parse("2026-09-16T10:00:00Z"), p90: Date.parse("2026-09-17T16:16:13Z") - Date.parse("2026-09-16T10:00:00Z") });
    const rows = report.releases.map((row: any) => [row.outcome, row.sha.slice(0, 9), row.prs.map((pr: any) => pr.number), row.issues.map((issue: any) => issue.number)]);
    expect(rows).toEqual([
      ["declined", "cb015584a", [], []],
      ["failed", "cb015584a", [], []],
      // queued behind a newer commit and never ran: superseded, not a failure (INSP-V r1 #1)
      ["superseded", "94eedf2b4", [], []],
      ["released", "a76a5aa0c", [8987, 8990], [8986]],
      ["failed", "3f99428bf", [], []],
      ["released", "f50b70a3d", [], []],
    ]);
    expect(report.releases.find((row: any) => row.sha.startsWith("f50")).contentUnknown).toBe(true);
    expect(report.backlog).toMatchObject({ openIssues: 1, openP0: 1, prsAwaitingGate: 1 });
    expect(report.coverage.tag).toMatchObject({ sha: A76, matchesHistory: true });
    expect(report.summary["pt-BR"]).toHaveLength(5);
    expect(report.summary["pt-BR"][0]).toMatch(/^Produção: 2 entregas/);
    expect(report.summary.en[0]).toMatch(/^Production: 2 deliveries/);
  });

  it("the previous day holds the night's failures (01:33Z is 22:33 of the 16th)", async () => {
    const { body: report } = await get("/api/reports/productivity?granularity=day&from=2026-09-16&to=2026-09-16");
    // f50b70a3d (pid 76716) never ran — aborted, outside the rate; 3f99428bf ran and failed (INSP-V r1 #1)
    expect(report.kpis).toMatchObject({ failedReleases: 1, abortedReleases: 1, supersededReleases: 0, deliveries: 0 });
  });

  it("keeps the board's targets: empty by default, saved sane, and lit in the report", async () => {
    expect((await get("/api/reports/productivity/goals")).body).toEqual({ goals: {} });
    const put = await fetch(`${BASE}/api/reports/productivity/goals`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ goals: { releaseSuccessRate: 80, leadTimeHours: -1 } }) });
    expect(put.status).toBe(200);
    expect((await get("/api/reports/productivity/goals")).body).toEqual({ goals: { releaseSuccessRate: 80 } });
    expect((await get("/api/reports/productivity?granularity=day&from=2026-09-17&to=2026-09-17")).body.goals).toEqual({ releaseSuccessRate: 80 });
    await fetch(`${BASE}/api/reports/productivity/goals`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ goals: {} }) });
  });

  it("serves the hour, day and month presets", async () => {
    for (const [granularity, count, buckets] of [["hour", null, 48], ["day", 30, 30], ["day", 90, 90], ["month", null, 12]] as const) {
      const { status, body } = await get(`/api/reports/productivity?granularity=${granularity}${count ? `&count=${count}` : ""}`);
      expect(status).toBe(200);
      expect(body.buckets).toHaveLength(buckets);
    }
  });

  it("downloads Markdown and PDF for the board, with no title or client name", async () => {
    const markdown = await get("/api/reports/productivity.md?granularity=day&from=2026-09-17&to=2026-09-17");
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(markdown.headers.get("content-disposition")).toBe('attachment; filename="produtividade-dia-2026-09-17_2026-09-17.md"');
    const text = markdown.buffer.toString("utf8");
    expect(text).toContain("## Resumo executivo");
    expect(text.split("\n")[0]).toBe("# Produtividade de engenharia — 17/09/2026");
    expect(text).toContain("| `a76a5aa0c` | em produção | #8987 | #8986 |");
    expect(text).not.toContain("Zeta");
    const pdf = await get("/api/reports/productivity.pdf?granularity=day&from=2026-09-17&to=2026-09-17");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.buffer.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(pdf.buffer.toString("latin1")).not.toContain("Zeta");
  });

  it("asked GitHub for reads only, and kept its cache under the data dir", async () => {
    const calls = readFileSync(join(home, "gh-calls.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args[0]).toBe("api");
      expect(args).not.toContain("-X");
      expect(args).not.toContain("--method");
      expect(args.join(" ")).not.toMatch(/\bmutation\b/);
    }
    expect(existsSync(join(home, ".openmausbot", "productivity", "github.json"))).toBe(true);
    expect(existsSync(join(home, ".openmausbot", "productivity", "releases.json"))).toBe(true);
  });
});
