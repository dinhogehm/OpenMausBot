// "Agora" (lot Y) through the real server: a disposable HOME whose ~/.nuria
// holds a release running (its log markers, the admission lease of kind
// release owned by a live process, release-started.json), a fake `gh` and a
// fake `git log` first on PATH that record every call. GET /api/now answers
// with the release, its phase, its PRs, the open PRs and their gate; the
// server pushes a "now" frame on its own; POST /api/now/seen keeps what the
// owner saw; nothing is ever written to GitHub.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");
const SHA = "3c04d7c3d2608c36f082fded54bcb0d99e833a85";

let child: ChildProcess;
let home: string;
let log = "";

const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify([
    { number: 9332, title: "feat(atendimento): prazo de reabertura", isDraft: false, mergeStateStatus: "BEHIND", createdAt: "2026-10-01T15:17:56Z", statusCheckRollup: [] },
    { number: 9368, title: "perf(release/admission): fila sem estouro", isDraft: false, mergeStateStatus: "BLOCKED", createdAt: "2026-10-03T20:32:13Z", statusCheckRollup: [{ context: "nuria/local-merge-gate", state: "SUCCESS" }] },
  ]));
  process.exit(0);
}
process.stderr.write("HTTP 404: not in this fixture"); process.exit(1);
`;

/** git log of the release's range answers from the fixture; everything else is the real git. */
const FAKE_GIT = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--first-parent" ]; then
    echo "$@" >> "$FAKE_GIT_LOG"
    printf '%s\\n' "Merge pull request #9370 from dinhogehm/chore/release-carrier-9195" "fix(helpdesk): rodízio de equipe atômico (#9195) (#9280)"
    exit 0
  fi
done
exec /usr/bin/git "$@"
`;

async function start() {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), FAKE_GH);
  writeFileSync(join(bin, "git"), FAKE_GIT);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "git"), 0o755);
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: [bin, process.env.PATH ?? ""].join(delimiter),
      HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), OMB_WEBHOOK_PORT: String(PORT + 1),
      FAKE_GH_LOG: join(home, "gh-calls.ndjson"), FAKE_GIT_LOG: join(home, "git-calls.txt"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => (log += chunk));
  child.stderr!.on("data", (chunk) => (log += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

posixOnly("GET /api/now", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-now-e2e-"));
    const nuria = join(home, ".nuria");
    mkdirSync(join(nuria, "logs"), { recursive: true });
    mkdirSync(join(nuria, "admission", "lease"), { recursive: true });
    mkdirSync(join(nuria, "admission", "intents"), { recursive: true });
    // a release running now: the markers the watcher writes, in its tests
    const clock = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString().slice(11, 19);
    writeFileSync(join(nuria, "logs", "production-release.out.log"), [
      `ADMISSION_INTENT kind=release label=release:production:${SHA} pid=${process.pid}`,
      `[${clock(40)}] build`,
      `[${clock(35)}] lint`,
      `[${clock(30)}] typecheck`,
      `[${clock(20)}] tests`,
      "@nuria/web:test:  ✓ src/a.test.ts (3 tests)",
      "",
    ].join("\n"));
    // the machine is the release's, held by a live process (this test's)
    writeFileSync(join(nuria, "admission", "lease", "owner.pid"), String(process.pid));
    writeFileSync(join(nuria, "admission", "lease", "kind"), "release");
    writeFileSync(join(nuria, "admission", "lease", "label"), `release:production:${SHA}`);
    writeFileSync(join(nuria, "admission", "release-started.json"), JSON.stringify({ kind: "release", label: `release:production:${SHA}`, pid: process.pid, sha: SHA }));
    await start();
  });

  afterAll(async () => {
    child?.kill("SIGTERM");
    if (child) await waitForExit(child, 5_000);
    removeTempDir(home);
  });

  it("answers with the release running, its phase and PRs, the open PRs and the gate; unknown stays null", async () => {
    const res = await fetch(`${BASE}/api/now?refresh=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { status, seen } = await res.json() as any;
    expect(seen).toBeNull();
    expect(status).toMatchObject({ version: 1, enabled: true });
    expect(status.release).toMatchObject({ state: "running", sha: SHA, phase: "tests", estimateMs: null, samples: 0 });
    expect(Date.now() - status.release.startedAt).toBeGreaterThan(39 * 60_000);
    expect(Date.now() - status.release.startedAt).toBeLessThan(42 * 60_000);
    // no release reached production in this HOME: production is unknown, not "nothing"
    expect(status.production).toMatchObject({ sha: null, at: null });
    expect(status.release.prs).toBeNull();
    expect(status.prs.list).toMatchObject([
      { number: 9332, merge: "BEHIND", gate: "missing", url: "https://github.com/dinhogehm/nuria-platform/pull/9332" },
      { number: 9368, merge: "BLOCKED", gate: "success" },
    ]);
    expect(status.ci).toMatchObject({ state: "idle" });
  });

  it("pushes a 'now' frame on the event stream when the line moves", async () => {
    const controller = new AbortController();
    const res = await fetch(`${BASE}/api/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 15_000;
    // the release reaches its next step; any recompute (the minute tick, or a screen's refresh) pushes it
    const out = join(home, ".nuria", "logs", "production-release.out.log");
    writeFileSync(out, `${readFileSync(out, "utf8")}[${new Date().toISOString().slice(11, 19)}] smart-deploy\n`);
    await fetch(`${BASE}/api/now?refresh=1`);
    try {
      while (!text.includes('"kind":"now"')) {
        if (Date.now() > deadline) throw new Error(`no "now" frame:\n${text.slice(-2000)}`);
        const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000))]);
        if (chunk && !chunk.done) text += decoder.decode(chunk.value);
      }
    } finally {
      controller.abort();
    }
    const frame = JSON.parse(text.split("\n").find((line) => line.startsWith("data:") && line.includes('"kind":"now"'))!.slice(5));
    expect(frame.status.release).toMatchObject({ state: "running", sha: SHA, phase: "smart-deploy" });
  });

  it("keeps what the owner saw, refuses a malformed body", async () => {
    const post = (body: unknown) => fetch(`${BASE}/api/now/seen`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ keys: "x" })).status).toBe(400);
    expect((await post([])).status).toBe(400);
    const saved = await (await post({ keys: { production: "abc", release: "running:x" } })).json() as any;
    expect(saved.seen.keys).toEqual({ production: "abc", release: "running:x" });
    const { seen } = await (await fetch(`${BASE}/api/now`)).json() as any;
    expect(seen).toEqual(saved.seen);
    expect(JSON.parse(readFileSync(join(home, ".openmausbot", "now", "seen.json"), "utf8"))).toEqual(saved.seen);
  });

  it("reads GitHub with 'gh pr list' only — no write of any kind", () => {
    const calls = readFileSync(join(home, "gh-calls.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const prList = calls.filter((args) => args[0] === "pr");
    expect(prList.length).toBeGreaterThanOrEqual(1);
    for (const args of prList) expect(args.slice(0, 2)).toEqual(["pr", "list"]);
    for (const args of calls) {
      expect(args.join(" ")).not.toMatch(/\b(merge|edit|comment|create|close|reopen|ready|--method|-X)\b/);
    }
  });
});
