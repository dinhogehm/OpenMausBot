// "Agora" (lot Y): the aggregate built from the states the line really goes
// through — a release running (its log markers as the watcher writes them), a
// ci:local queued behind it, PRs BEHIND/BLOCKED with and without the gate's
// receipt, a production that moved today, a commit failing twice — and the
// rule that what is not known is null ("—"), never zero.
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProductivityReport } from "../shared/productivity.ts";
import { nowFingerprint } from "../shared/now-status.ts";
import type { PsRow } from "./bg-jobs.ts";
import type { ReleaseRun } from "./productivity-release-log.ts";
import {
  buildNowStatus, ciLocalNow, clockBefore, deliveriesToday, emptyReleaseTail, gateOf, NowStatusService, OPEN_PRS_ARGS, parseOpenPrs,
  pushReleaseTail, readLogGrowth, releasePrsFromGitLog, throughputToday, type NowInputs,
} from "./now-status.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const SHA = "3c04d7c3d2608c36f082fded54bcb0d99e833a85";
const PREV = "f9e7a2350e58397d155858568184650b66e24a91";
const NOW = Date.parse("2026-10-04T01:12:00Z"); // 22:12 in São Paulo, during the 3c04d7c release

/** The markers of a real run (production-release.out.log, 03–04/10), noise in between. */
const RUNNING_LOG = [
  "HEAD=3c04d7c3d Merge pull request #9370 from dinhogehm/chore/release-carrier-9195-rodizio-equipe-atomico",
  `ADMISSION_INTENT kind=release label=release:production:${SHA} pid=83221`,
  "[00:59:17] build",
  "@nuria/web:build: vite v6 building for production...",
  "[01:01:05] lint",
  "[01:02:15] typecheck",
  "\u001b[32m[01:04:37] tests\u001b[0m",
  "@nuria/web:test:  ✓ src/a.test.ts (3 tests)",
];
const ENDING_LOG = [
  "[01:19:52] smart-deploy",
  "[01:31:29] script-contracts",
  "**Data:** 2026-10-04T01:39:30Z | **Branch:**  | **Commit:** 3c04d7c3d | **Duracao:** 301s",
  "[INFO] Deploying helpdesk...",
  "[INFO] Purging CDN cache...",
  "[OK] Concluido! (8874s)",
  "POST_RELEASE_RESULT=healthy exit=0 record=/x",
  `Certification tag nuria-production-deployed advanced to ${SHA}`,
  `Release production completed for ${SHA}`,
  "ADMISSION_RELEASED kind=release pid=83221",
];

const row = (pid: number, ppid: number, command: string, start = "Sat Oct 4 09:06:00 2026"): PsRow => ({ pid, ppid, pgid: pid, start, command });

const run = (sha: string, startedAt: number, endedAt: number, extra: Partial<ReleaseRun> = {}): ReleaseRun => ({
  key: `${sha}:1`, sha, pid: 1, outcome: "released", startedAt, endedAt, timeSource: "log", ...extra,
});

/** A minimal today's report: what the panel reads from it. */
function report(extra: { releases?: ProductivityReport["releases"]; deliveries?: number; mergedPrs?: number; closedIssues?: number; failedReleases?: number; covered?: "full" | "partial" | "none"; synced?: number | null; tag?: string | null } = {}): ProductivityReport {
  return {
    kpis: { deliveries: extra.deliveries ?? 0, mergedPrs: extra.mergedPrs ?? 0, closedIssues: extra.closedIssues ?? 0, failedReleases: extra.failedReleases ?? 0, releaseCovered: extra.covered ?? "full" },
    releases: extra.releases ?? [],
    coverage: { github: { syncedAt: extra.synced === undefined ? NOW - 600_000 : extra.synced }, tag: { sha: extra.tag === undefined ? PREV : extra.tag, checkedAt: NOW - 600_000, matchesHistory: true } },
  } as unknown as ProductivityReport;
}

const base = (extra: Partial<NowInputs> = {}): NowInputs => ({
  now: NOW, enabled: true, report: report(), runs: [run(PREV, NOW - 6 * 3_600_000, NOW - 3 * 3_600_000)], tail: emptyReleaseTail(),
  inFlight: null, releaseStartedAt: null, releasePrs: null, prs: { list: [], checkedAt: NOW }, ci: { state: "idle", queued: 0 }, alerts: [], ...extra,
});

describe("the release's phase, read from its log as it grows", () => {
  it("follows the steps of a running release and dates them by the UTC clock", () => {
    const tail = emptyReleaseTail();
    for (const line of RUNNING_LOG) pushReleaseTail(tail, line);
    expect(tail).toMatchObject({ sha: SHA, pid: 83221, phase: "tests", firstClock: 59 * 60 + 17, ended: null });
    expect(new Date(clockBefore(tail.firstClock!, NOW)).toISOString()).toBe("2026-10-04T00:59:17.000Z");
  });

  it("a failed run ends failed; the next intent starts over", () => {
    const tail = emptyReleaseTail();
    for (const line of [...RUNNING_LOG, `Release production failed for 3c04d7c3d (exit 1)`]) pushReleaseTail(tail, line);
    expect(tail.ended).toBe("failed");
    pushReleaseTail(tail, `ADMISSION_INTENT kind=release label=release:production:${PREV} pid=9`);
    expect(tail).toMatchObject({ sha: PREV, phase: "queued", ended: null, firstClock: null });
  });

  it("reads only what the log gained, whole lines, and starts over when it shrinks (rotation)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-now-log-"));
    try {
      const path = join(dir, "out.log");
      writeFileSync(path, "old line\nADMISSION_INTENT x\n[00:59:17] bu");
      const first = readLogGrowth(path, null, 1024)!;
      expect(first.text).toBe("old line\nADMISSION_INTENT x");
      appendFileSync(path, "ild\n[01:01:05] lint\n");
      const second = readLogGrowth(path, first.offset)!;
      expect(second.text).toBe("[00:59:17] build\n[01:01:05] lint");
      writeFileSync(path, "new\n");
      expect(readLogGrowth(path, second.offset)).toMatchObject({ restarted: true, text: "new" });
      expect(readLogGrowth(join(dir, "missing"), null)).toBeNull();
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("open PRs and the gate's receipt (gh pr list)", () => {
  const output = JSON.stringify([
    { number: 9368, title: "perf(release/admission): fila sem estouro (lote W)", isDraft: false, mergeStateStatus: "BLOCKED", createdAt: "2026-10-03T20:32:13Z", statusCheckRollup: [] },
    { number: 9332, title: "feat(atendimento): prazo de reabertura", isDraft: false, mergeStateStatus: "BEHIND", createdAt: "2026-10-01T15:17:56Z", statusCheckRollup: [{ __typename: "StatusContext", context: "nuria/local-merge-gate", state: "SUCCESS" }] },
    { number: 9380, title: "wip", isDraft: true, mergeStateStatus: "DRAFT", createdAt: "2026-10-04T00:00:00Z", statusCheckRollup: [{ context: "nuria/local-merge-gate", state: "FAILURE" }, { context: "other", state: "SUCCESS" }] },
  ]);

  it("reads merge state, draft and the gate on the head; read-only arguments", () => {
    expect(parseOpenPrs(output)).toEqual([
      { number: 9332, title: "feat(atendimento): prazo de reabertura", url: "https://github.com/dinhogehm/nuria-platform/pull/9332", merge: "BEHIND", gate: "success", draft: false, createdAt: Date.parse("2026-10-01T15:17:56Z") },
      { number: 9368, title: "perf(release/admission): fila sem estouro (lote W)", url: "https://github.com/dinhogehm/nuria-platform/pull/9368", merge: "BLOCKED", gate: "missing", draft: false, createdAt: Date.parse("2026-10-03T20:32:13Z") },
      { number: 9380, title: "wip", url: "https://github.com/dinhogehm/nuria-platform/pull/9380", merge: "DRAFT", gate: "failure", draft: true, createdAt: Date.parse("2026-10-04T00:00:00Z") },
    ]);
    expect(OPEN_PRS_ARGS.slice(0, 2)).toEqual(["pr", "list"]);
    expect(OPEN_PRS_ARGS).not.toContain("--web");
    expect(gateOf([{ context: "nuria/local-merge-gate", state: "PENDING" }])).toBe("pending");
    expect(gateOf(null)).toBe("missing");
    expect(() => parseOpenPrs("{}")).toThrow();
  });
});

describe("what a release carries (git log --first-parent)", () => {
  it("lists the PRs, oldest first, without the release carrier", () => {
    const log = [
      "Merge pull request #9370 from dinhogehm/chore/release-carrier-9195-rodizio-equipe-atomico",
      "fix(helpdesk): rodízio de equipe atômico no fallback de distribuição (#9195) (#9280)",
      "Merge pull request #9301 from dinhogehm/fix/9300-x",
      "chore: sem número",
    ].join("\n");
    expect(releasePrsFromGitLog(log, (n) => (n === 9301 ? "Título da 9301" : null))).toEqual([
      { number: 9301, title: "Título da 9301", url: "https://github.com/dinhogehm/nuria-platform/pull/9301" },
      { number: 9280, title: "fix(helpdesk): rodízio de equipe atômico no fallback de distribuição (#9195)", url: "https://github.com/dinhogehm/nuria-platform/pull/9280" },
    ]);
  });
});

describe("the local CI: the lease and who waits for it", () => {
  const rows = [
    row(1, 0, "/sbin/launchd"),
    row(1866, 500, "bash scripts/local-ci.sh --profile full", "Sat Oct 4 09:06:00 2026"),
    row(1870, 1866, "node vitest"),
    row(2001, 600, "npm run ci:local"),
    row(2002, 2001, "/bin/bash /x/scripts/local-ci.sh"),
    row(2003, 2002, "bash /x/scripts/local-ci.sh step"),
    row(83221, 1, "bash scripts/macos/watch-production-release.sh"),
  ];

  it("running: the lease's ci:local, its age, and one more waiting (counted once per tree)", () => {
    expect(ciLocalNow({ lease: { ownerPid: "1866", kind: "ci-full", label: "local-ci:e388511c72a2", start: "Sat Oct 4 09:06:00 2026" }, leaseSince: NOW - 600_000, rows, release: null }))
      .toEqual({ state: "running", label: "local-ci:e388511c72a2", since: NOW - 600_000, queued: 1, session: null });
  });

  it("queued behind a release that holds the machine (lot W): a legitimate wait", () => {
    const release = { label: `release:production:${SHA}`, state: "holding" as const, ageS: 600, overdue: false };
    expect(ciLocalNow({ lease: { ownerPid: "83221", kind: "release", label: `release:production:${SHA}` }, leaseSince: null, rows, release }))
      .toEqual({ state: "queued", queued: 2, behindRelease: true });
  });

  it("a lease whose owner died (or a reused pid) holds nothing", () => {
    expect(ciLocalNow({ lease: { ownerPid: "1866", kind: "ci-full", label: "local-ci:x", start: "Fri Oct 3 01:00:00 2026" }, leaseSince: null, rows: rows.slice(0, 1), release: null }))
      .toEqual({ state: "idle", queued: 0 });
  });

  it("unknown, never idle, when the admission state cannot be read; the queue unknown without ps", () => {
    expect(ciLocalNow({ lease: "unreadable", leaseSince: null, rows, release: null })).toEqual({ state: "unknown", queued: null });
    expect(ciLocalNow({ lease: { ownerPid: "1866", kind: "ci-full", label: "local-ci:x" }, leaseSince: null, rows: null, release: null })).toMatchObject({ state: "running", queued: null });
  });

  it("says whose CI it is: a managed session's (its claude above it) or the owner's terminal", () => {
    const withClaude = [...rows, row(500, 400, "claude -p --output-format stream-json")];
    const info = { sessionId: "s1", title: "Lote W", botId: "eng", threadId: "t1" };
    expect(ciLocalNow({ lease: { ownerPid: "1866", kind: "ci-full", label: "local-ci:x" }, leaseSince: null, rows: withClaude, release: null, sessions: [{ sessionId: "s1", claudePid: 500 }], sessionInfo: () => info }).session).toEqual(info);
    const withShell = [...rows, row(500, 400, "-zsh")];
    expect(ciLocalNow({ lease: { ownerPid: "1866", kind: "ci-full", label: "local-ci:x" }, leaseSince: null, rows: withShell, release: null, sessions: [] }).session).toBe("owner");
  });
});

describe("the aggregate", () => {
  it("a release running: commit, PRs, since when, phase — and no estimate while its profile is unknown", () => {
    const tail = emptyReleaseTail();
    for (const line of RUNNING_LOG) pushReleaseTail(tail, line);
    const h = 3_600_000;
    const status = buildNowStatus(base({
      tail,
      runs: [run(PREV, NOW - 6 * h, NOW - 3 * h), run("b", NOW - 30 * h, NOW - 27.5 * h)],
      inFlight: { label: `release:production:${SHA}`, state: "holding", ageS: 900, overdue: false },
      releaseStartedAt: Date.parse("2026-10-04T00:57:00Z"),
      releasePrs: [{ number: 9280, title: "fix(helpdesk): rodízio", url: "https://github.com/dinhogehm/nuria-platform/pull/9280" }],
    }));
    expect(status.release).toEqual({
      state: "running", sha: SHA,
      startedAt: Date.parse("2026-10-04T00:59:17Z"), // the first CI step, as the history measures
      phase: "tests", phaseAt: Date.parse("2026-10-04T01:04:37Z"), progress: null,
      prs: [{ number: 9280, title: "fix(helpdesk): rodízio", url: "https://github.com/dinhogehm/nuria-platform/pull/9280" }],
      // tests come before the CI tells whether there are migrations: no "faltam ~" on a guess
      profile: null, estimateMs: null, remainingMs: null, samples: 0,
    });
  });

  it("a release queued for the machine, before its first step: since the lease, phase 'queued'", () => {
    const tail = emptyReleaseTail();
    pushReleaseTail(tail, RUNNING_LOG[1]!);
    const status = buildNowStatus(base({ tail, inFlight: { label: `release:production:${SHA}`, state: "queued", ageS: null, overdue: false }, releaseStartedAt: NOW - 120_000 }));
    expect(status.release).toMatchObject({ state: "queued", sha: SHA, startedAt: NOW - 120_000, phase: "queued", phaseAt: null });
  });

  it("idle and unknown are different things", () => {
    expect(buildNowStatus(base()).release.state).toBe("idle");
    expect(buildNowStatus(base({ inFlight: "unknown" })).release.state).toBe("unknown");
  });

  it("production: the last release that went live, today's deliveries with their PRs, the tag checked", () => {
    // delivered 41 min before the GitHub sync read the tag: past the 15 min a tag needs to settle
    const delivered = Date.parse("2026-10-04T00:21:00Z");
    const status = buildNowStatus(base({
      runs: [run(PREV, NOW - 6 * 3_600_000, delivered)],
      report: report({ deliveries: 1, mergedPrs: 7, closedIssues: 4, failedReleases: 1, tag: PREV, releases: [
        { sha: PREV, at: delivered, timeSource: "log", outcome: "released", prs: [
          { number: 9280, title: "fix(helpdesk): rodízio", kind: "pr" }, { number: 9370, title: "carrier", kind: "pr", carrier: true },
        ], issues: [] },
        { sha: "dead", at: delivered - 1, timeSource: "log", outcome: "failed", prs: [], issues: [] },
      ] }),
    }));
    expect(status.production).toEqual({
      sha: PREV, at: delivered,
      tag: { sha: PREV, checkedAt: NOW - 600_000, agrees: true },
      today: [{ sha: PREV, at: delivered, prs: [{ number: 9280, title: "fix(helpdesk): rodízio", url: "https://github.com/dinhogehm/nuria-platform/pull/9280" }] }],
    });
    expect(status.throughput).toEqual({ deliveries: 1, mergedPrs: 7, closedIssues: 4, failedReleases: 1, syncedAt: NOW - 600_000 });
  });

  it("the log said the tag advanced before the history was re-read: production is that commit already, the tag 'a conferir'", () => {
    const tail = emptyReleaseTail();
    for (const line of [...RUNNING_LOG, ...ENDING_LOG]) pushReleaseTail(tail, line, NOW - 60_000);
    const status = buildNowStatus(base({ tail }));
    // the GitHub reading (10 min old) is from before the release: never "diverge" on it
    expect(status.production).toMatchObject({ sha: SHA, at: null, tag: { sha: PREV, agrees: null } });
  });

  it("unknown is null, never zero: no release source today, no GitHub sync yet, no collector", () => {
    expect(deliveriesToday(report({ covered: "none" }))).toBeNull();
    expect(throughputToday(report({ covered: "none", synced: null, deliveries: 0, mergedPrs: 0 }))).toEqual({ deliveries: null, mergedPrs: null, closedIssues: null, failedReleases: null, syncedAt: null });
    expect(throughputToday(null)).toEqual({ deliveries: null, mergedPrs: null, closedIssues: null, failedReleases: null, syncedAt: null });
    const off = buildNowStatus(base({ report: null, runs: [], alerts: null, prs: { list: null, checkedAt: null } }));
    expect(off.production).toEqual({ sha: null, at: null, tag: { sha: null, checkedAt: null, agrees: null }, today: null });
    expect(off.alerts).toBeNull();
    expect(off.prs.list).toBeNull();
  });

  it("alerts: only those said since production last moved and within two days, newest first", () => {
    const moved = NOW - 3 * 3_600_000;
    const status = buildNowStatus(base({
      runs: [run(PREV, moved - 3_600_000, moved)],
      alerts: [
        { key: "a", at: moved - 60_000, text: "antes do último release" },
        { key: "b", at: NOW - 3_600_000, text: "release 3c04d7c3d falhou 2×", botId: "chief", threadId: "desk" },
        { key: "c", at: NOW - 60_000, text: "tag parada" },
      ],
    }));
    expect(status.alerts!.map((alert) => alert.key)).toEqual(["c", "b"]);
  });

  it("the fingerprint ignores the clock and follows the facts", () => {
    const one = buildNowStatus(base());
    expect(nowFingerprint({ ...one, generatedAt: one.generatedAt + 60_000 })).toBe(nowFingerprint(one));
    expect(nowFingerprint(buildNowStatus(base({ ci: { state: "running", queued: 0, label: "local-ci:x", since: NOW } })))).not.toBe(nowFingerprint(one));
  });
});

describe("the service", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir); });

  function service(extra: { gh?: (args: string[]) => Promise<string>; log?: string; tag?: () => string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "omb-now-"));
    dirs.push(dir);
    const outLog = join(dir, "out.log");
    writeFileSync(outLog, (extra.log ?? RUNNING_LOG.join("\n")) + "\n");
    const calls: string[][] = [];
    const changes: number[] = [];
    let refreshed = 0;
    let clock = NOW;
    const svc = new NowStatusService({
      dataDir: dir, enabled: true, now: () => clock,
      report: () => report(), runs: () => [run(PREV, NOW - 6 * 3_600_000, NOW - 3 * 3_600_000)], refreshLogs: async () => { refreshed += 1; },
      outLog, releaseStartedFile: join(dir, "release-started.json"),
      readLease: () => ({ ownerPid: "83221", kind: "release", label: `release:production:${SHA}` }),
      readDeployLease: () => ({ ownerPid: "83221", label: `release:production:${SHA}`, startedAt: Math.floor(NOW / 1000) - 900 }),
      leaseSince: () => null,
      inFlight: () => ({ label: `release:production:${SHA}`, state: "holding", ageS: 900, overdue: false }),
      ps: async () => [row(83221, 1, "bash watch-production-release.sh"), row(2002, 600, "bash /x/scripts/local-ci.sh")],
      gh: extra.gh ?? (async (args) => { calls.push(args); return JSON.stringify([{ number: 9332, title: "t", isDraft: false, mergeStateStatus: "BEHIND", createdAt: "2026-10-01T15:17:56Z", statusCheckRollup: [] }]); }),
      git: async (args) => { calls.push(["git", ...args]); return "fix: x (#9280)"; },
      sessions: () => [], sessionInfo: () => null, failing: () => ({ sha: "cb015584a", count: 2, at: NOW - 20 * 60_000 }),
      readTag: async () => { calls.push(["ls-remote"]); return extra.tag?.() ?? PREV; },
      declined: () => null,
      onChange: () => changes.push(clock),
    });
    /** One tick: the status, after the background GitHub read it started has landed. */
    const tickRefresh = async () => { await svc.refresh(); await svc.settled(); return svc.refresh(); };
    return { svc, calls, changes, outLog, dir, refreshed: () => refreshed, tick: (ms: number) => { clock += ms; }, tickRefresh };
  }

  it("gathers everything, pushes it when it changes, and asks GitHub at most every 3 min — off the request path", async () => {
    // the first answer does not wait for a slow gh: the list is not read yet ("—"), never empty
    let answer: (value: string) => void = () => {};
    const { svc: slow } = service({ gh: () => new Promise<string>((resolve) => { answer = resolve; }) });
    expect((await slow.refresh()).prs.list).toBeNull();
    answer("[]");
    await slow.settled();
    expect((await slow.refresh()).prs.list).toEqual([]);
    const { calls, changes, tick, tickRefresh } = service();
    const status = await tickRefresh();
    expect(status.release).toMatchObject({ state: "running", sha: SHA, phase: "tests", prs: [{ number: 9280 }] });
    expect(status.ci).toEqual({ state: "queued", queued: 1, behindRelease: true });
    expect(status.prs.list).toMatchObject([{ number: 9332, merge: "BEHIND", gate: "missing" }]);
    // read from the watcher's log, dated by the failure (not by this read), and said so
    expect(status.alerts).toMatchObject([{ key: "failing:cb015584a:2", at: NOW - 20 * 60_000, sha: "cb015584a", text: "Release cb015584a falhou 2× seguidas — não está em produção (log do watcher)" }]);
    expect(status.alerts![0]!.botId).toBeUndefined();
    const pushed = changes.length;
    tick(60_000);
    await tickRefresh();
    expect(changes).toHaveLength(pushed); // nothing changed: nothing pushed
    expect(calls.filter((call) => call[0] === "pr")).toHaveLength(1);
    expect(calls.filter((call) => call[0] === "git")).toEqual([["git", "log", "--first-parent", "--format=%s", `${PREV}..${SHA}`]]);
    tick(3 * 60_000);
    await tickRefresh();
    expect(calls.filter((call) => call[0] === "pr")).toHaveLength(2);
  });

  it("a release ending in the log re-reads the history at once, and the tag a minute later", async () => {
    let tag = PREV;
    const { svc, changes, outLog, refreshed, tick, tickRefresh, calls } = service({ tag: () => tag });
    await tickRefresh();
    appendFileSync(outLog, ENDING_LOG.join("\n") + "\n");
    tick(60_000);
    const ended = await svc.refresh();
    expect(refreshed()).toBe(1);
    expect(ended.production).toMatchObject({ sha: SHA, tag: { agrees: null } });
    expect(changes.length).toBeGreaterThanOrEqual(2);
    const reads = calls.filter((call) => call[0] === "ls-remote").length;
    tag = SHA;
    tick(61_000);
    const confirmed = await tickRefresh();
    expect(calls.filter((call) => call[0] === "ls-remote").length).toBe(reads + 1);
    expect(confirmed.production.tag).toMatchObject({ sha: SHA, agrees: true });
  });

  it("a tag that really stayed behind is said only on a reading after the release", async () => {
    const { svc, outLog, tick, tickRefresh } = service({ tag: () => PREV });
    await tickRefresh();
    appendFileSync(outLog, ENDING_LOG.join("\n") + "\n");
    tick(60_000);
    expect((await svc.refresh()).production.tag.agrees).toBeNull();
    tick(61_000);
    expect((await tickRefresh()).production.tag).toMatchObject({ sha: PREV, agrees: false });
  });

  it("a GitHub failure keeps the last list and says so; it is never an empty list", async () => {
    let fail = false;
    const { tick, tickRefresh } = service({ gh: async () => { if (fail) throw new Error("HTTP 502"); return "[]"; } });
    expect((await tickRefresh()).prs).toEqual({ list: [], checkedAt: NOW });
    fail = true;
    tick(4 * 60_000);
    expect((await tickRefresh()).prs).toEqual({ list: [], checkedAt: NOW, error: "HTTP 502" });
    const { tickRefresh: never } = service({ gh: async () => { throw new Error("gh: not logged in"); } });
    expect((await never()).prs).toEqual({ list: null, checkedAt: null, error: "gh: not logged in" });
  });

  it("a git failure is asked again in 2 min, not kept for the whole release", async () => {
    let fail = true;
    const { svc, tick } = service();
    // swap git for a failing one (same service, its deps object)
    const deps = (svc as unknown as { deps: { git: (args: string[]) => Promise<string> } }).deps;
    deps.git = async () => { if (fail) throw new Error("timeout"); return "fix: x (#9280)"; };
    expect((await svc.refresh()).release.prs).toBeNull();
    fail = false;
    tick(60_000);
    expect((await svc.refresh()).release.prs).toBeNull(); // within the 2 min
    tick(61_000);
    expect((await svc.refresh()).release.prs).toMatchObject([{ number: 9280 }]);
  });

  it("intents it cannot read make the release unknown ('—'), never 'none on its way'", async () => {
    const { svc } = service();
    (svc as unknown as { deps: { inFlight: () => never } }).deps.inFlight = () => { throw new Error("release intents unreadable"); };
    expect((await svc.refresh()).release.state).toBe("unknown");
  });

  it("the phases read live keep their time across a restart; what came while down has none", async () => {
    const { svc, outLog, dir, tick } = service();
    await svc.refresh();
    appendFileSync(outLog, ["[01:19:52] smart-deploy", "[01:29:07] migration-lint", "**Data:** 2026-10-04T01:39:30Z | **Commit:** 3c04d7c3d | **Duracao:** 301s", "=== RELEASE ORQUESTRADO ===", "=== DEPLOY ==="].join("\n") + "\n");
    tick(60_000);
    const live = await svc.refresh();
    expect(live.release).toMatchObject({ phase: "deploy-check", phaseAt: NOW + 60_000, profile: "migrations" });
    // a new server on the same data: the phase and its time are still known
    const again = new NowStatusService({ ...(svc as unknown as { deps: ConstructorParameters<typeof NowStatusService>[0] }).deps, now: () => NOW + 120_000 });
    expect((await again.refresh()).release).toMatchObject({ phase: "deploy-check", phaseAt: NOW + 60_000 });
    // a line that arrived while it was down: its phase, but no invented time
    appendFileSync(outLog, "[INFO] Banco/migrations: verificacao completa (unclassified-sql; review=unknown)\n");
    const cold = new NowStatusService({ ...(svc as unknown as { deps: ConstructorParameters<typeof NowStatusService>[0] }).deps, now: () => NOW + 180_000 });
    expect((await cold.refresh()).release).toMatchObject({ phase: "migrations-check", phaseAt: null });
    expect(existsSync(join(dir, "now", "tail.json"))).toBe(true);
  });

  it("keeps what the owner saw and the alerts the Chief got, across a restart", async () => {
    const { svc, dir } = service();
    svc.markSeen({ production: "abc", "bad key!": "x", release: 7 });
    svc.recordAlert({ text: "release 3c04d7c3d falhou 2×", botId: "chief", threadId: "desk" });
    expect(svc.seen()).toEqual({ at: NOW, keys: { production: "abc" } });
    expect(existsSync(join(dir, "now", "seen.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "now", "alerts.json"), "utf8"))).toMatchObject([{ key: "release:3c04d7c3d", sha: "3c04d7c3d", kind: "release", text: "release 3c04d7c3d falhou 2×", botId: "chief", threadId: "desk", at: NOW }]);
    // the same commit's next alert replaces it (one line per subject); a stuck tag is its own subject
    svc.recordAlert({ text: "release 3c04d7c3d falhou 3×", botId: "chief", threadId: "desk" });
    svc.recordAlert({ text: "Produção está no ar em f9e7a2350 há 20 min, mas a tag de produção continua em 3c04d7c3d: …", botId: "chief", threadId: "desk" });
    expect(JSON.parse(readFileSync(join(dir, "now", "alerts.json"), "utf8")).map((alert: { key: string; text: string }) => [alert.key, alert.text.slice(0, 26)])).toEqual([
      ["release:3c04d7c3d", "release 3c04d7c3d falhou 3"],
      ["tag:f9e7a2350", "Produção está no ar em f9e"],
    ]);
  });
});
