// "Agora" (lot Y, INSP-Y r1): the release's phase and estimate on the watcher's
// REAL lines — the runs 23a9f93c5, f82d10edb and 3c04d7c3d (with migrations,
// ~2 h 40 after the review) and f9e7a2350 (without, ~9 min after it), 03–04/10,
// testing/fixtures/now/release-runs.out.log (markers only, paths removed).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProductivityReport } from "../shared/productivity.ts";
import { parseReleaseLogText, type ReleaseRun } from "./productivity-release-log.ts";
import {
  buildNowStatus, emptyReleaseTail, phaseProgress, phaseStartedAt, profileMedians, pushReleaseTail, releaseEstimateNow,
  TAG_SETTLE_MS, type NowInputs, type ReleaseTailState,
} from "./now-status.ts";

const LOG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "testing", "fixtures", "now", "release-runs.out.log"), "utf8");
const LINES = LOG.split("\n");
const SHA_23A9 = "23a9f93c544a5e8c1c8035da781e926baeb2894a";
const SHA_F82D = "f82d10edb99b702a5c3a227121eabbbc33fbd1ac";
const SHA_F9E7 = "f9e7a2350e58397d155858568184650b66e24a91";
const SHA_3C04 = "3c04d7c3d2608c36f082fded54bcb0d99e833a85";
const MIN = 60_000;

/** The lines of one run, from its INTENT to its ADMISSION_RELEASED. */
function runLines(sha: string): string[] {
  const from = LINES.findIndex((line) => line.startsWith(`ADMISSION_INTENT kind=release label=release:production:${sha}`));
  const pid = /pid=(\d+)/.exec(LINES[from]!)![1];
  const to = LINES.findIndex((line, at) => at > from && line === `ADMISSION_RELEASED kind=release pid=${pid}`);
  return LINES.slice(from, to + 1);
}

/** Feed a run as if read live, one line a minute from `start`; the phases it went through and when each started. */
function live(sha: string, start: number): Array<{ phase: string; at: number | null; progress: ReturnType<typeof phaseProgress> }> {
  const tail = emptyReleaseTail();
  const seen: Array<{ phase: string; at: number | null; progress: ReturnType<typeof phaseProgress> }> = [];
  runLines(sha).forEach((line, index) => {
    const now = start + index * MIN;
    pushReleaseTail(tail, line, now);
    if (tail.phase && seen.at(-1)?.phase !== tail.phase) seen.push({ phase: tail.phase, at: phaseStartedAt(tail, now), progress: phaseProgress(tail) });
    else if (seen.length) seen.at(-1)!.progress = phaseProgress(tail);
  });
  return seen;
}

describe("every phase of the real runs, each with its start", () => {
  it("3c04d7c3d (with migrations): never 'review' through the deploy; the network phases have a time", () => {
    const start = Date.parse("2026-10-04T00:55:00Z");
    const phases = live(SHA_3C04, start);
    expect(phases.map((each) => each.phase)).toEqual([
      "queued", "build", "lint", "typecheck", "tests", "smart-deploy", "migration-lint", "migration-contracts", "schema-syntax", "script-contracts",
      "review", "deploy-check", "migrations-check", "migrations", "deploy", "workers", "purge", "post-release", "tag",
    ]);
    // the CI steps by their clock, the review by its stamp, the rest by when the line was read
    expect(phases.find((each) => each.phase === "tests")!.at).toBe(Date.parse("2026-10-04T01:04:37Z"));
    expect(phases.find((each) => each.phase === "review")!.at).toBe(Date.parse("2026-10-04T01:39:30Z"));
    for (const phase of ["deploy-check", "migrations-check", "migrations", "deploy", "workers", "purge", "post-release", "tag"]) {
      expect(phases.find((each) => each.phase === phase)!.at, phase).toBeTypeOf("number");
    }
    expect(phases.find((each) => each.phase === "workers")!.progress).toEqual({ done: 1, total: 1 });
    expect(phases.find((each) => each.phase === "post-release")!.progress).toEqual({ done: 5, total: 5 });
  });

  it("f82d10edb (46 workers): the deploy counts its workers", () => {
    const tail = emptyReleaseTail();
    const lines = runLines(SHA_F82D);
    const tenth = lines.findIndex((line) => line === "[INFO] Deploying bi...");
    for (const line of lines.slice(0, tenth + 1)) pushReleaseTail(tail, line, 1);
    expect(tail.phase).toBe("workers");
    expect(phaseProgress(tail)).toEqual({ done: 10, total: 46 });
    // web and the Pages come after the 46: the count goes on, without a wrong "of 46"
    for (const line of lines.slice(tenth + 1, lines.indexOf("[INFO] Deploying widget Pages...") + 1)) pushReleaseTail(tail, line, 1);
    expect(phaseProgress(tail)).toEqual({ done: 48, total: null });
  });

  it("23a9f93c5 queued behind a ci:local: 'queued' until its first step", () => {
    expect(live(SHA_23A9, 0).slice(0, 2).map((each) => each.phase)).toEqual(["queued", "build"]);
  });

  it("f9e7a2350 (without migrations): no migrations phases", () => {
    expect(live(SHA_F9E7, 0).map((each) => each.phase)).toEqual([
      "queued", "build", "lint", "typecheck", "tests", "smart-deploy", "script-contracts", "review", "deploy-check", "deploy", "workers", "purge", "post-release", "tag",
    ]);
  });

  it("a cold read (boot) keeps the phases but invents no time for those without a clock", () => {
    const tail: ReleaseTailState = emptyReleaseTail();
    const lines = runLines(SHA_3C04);
    for (const line of lines.slice(0, lines.indexOf("[INFO] Deploying helpdesk..."))) pushReleaseTail(tail, line, null);
    expect(tail.phase).toBe("deploy");
    expect(phaseStartedAt(tail, Date.parse("2026-10-04T03:00:00Z"))).toBeNull();
  });
});

describe("the history: steps dated, review and profile of each run", () => {
  const { runs } = parseReleaseLogText(LOG, { endOfStream: true });
  const bySha = (sha: string) => runs.find((run) => run.sha === sha)!;

  it("profile: migrations for 23a9, f82d and 3c04; light for f9e7", () => {
    expect([SHA_23A9, SHA_F82D, SHA_3C04, SHA_F9E7].map((sha) => bySha(sha).profile)).toEqual(["migrations", "migrations", "migrations", "light"]);
  });

  it("each step dated, the review report's date kept", () => {
    const run = bySha(SHA_3C04);
    expect(run.steps).toMatchObject({ build: Date.parse("2026-10-04T00:59:17Z"), "migration-lint": Date.parse("2026-10-04T01:29:07Z"), "script-contracts": Date.parse("2026-10-04T01:31:29Z") });
    expect(run.reviewAt).toBe(Date.parse("2026-10-04T01:39:30Z"));
    // the deploy ended Data − Duracao + Concluido after the review (V's reading): 8874 − 301 s
    expect(run.endedAt! - run.reviewAt!).toBe((8874 - 301) * 1000);
  });

  it("the two profiles are never averaged: 3 with migrations give a median, 1 without gives '—'", () => {
    const medians = profileMedians(runs);
    expect(medians.migrations.samples).toBe(3);
    expect(medians.migrations.ms).toBe(bySha(SHA_F82D).endedAt! - bySha(SHA_F82D).startedAt!);
    expect(medians.light).toEqual({ ms: null, samples: 1 });
  });
});

describe("the estimate, from the current phase, on comparable releases only", () => {
  const { runs: history } = parseReleaseLogText(LOG, { endOfStream: true });
  // the next release with migrations, the same day: the three above are its base
  const NEXT = "1111111111111111111111111111111111111111";
  const next = (lines: string[]) => {
    const tail = emptyReleaseTail();
    for (const line of [`ADMISSION_INTENT kind=release label=release:production:${NEXT} pid=1`, ...lines]) pushReleaseTail(tail, line, null);
    return tail;
  };

  it("before the CI says the profile: no estimate ('—'), never a mix of 45 min and 3 h", () => {
    const tail = next(["[05:00:00] build", "[05:02:00] lint", "[05:04:00] typecheck", "[05:07:00] tests"]);
    expect(releaseEstimateNow(history, tail, Date.parse("2026-10-04T05:20:00Z"))).toEqual({ profile: null, estimateMs: null, remainingMs: null, samples: 0 });
  });

  it("during the deploy: the typical time after the review (2 h 40 28 s) minus what already passed since it", () => {
    const tail = next(["[05:00:00] build", "[05:25:00] smart-deploy", "[05:36:00] migration-lint", "[05:39:00] script-contracts",
      "**Data:** 2026-10-04T05:45:00Z | **Branch:**  | **Commit:** 111111111 | **Duracao:** 300s", "=== RELEASE ORQUESTRADO ===", "=== DEPLOY ===",
      "[INFO] Banco/migrations: verificacao completa (unclassified-sql; review=unknown)"]);
    expect(tail.phase).toBe("migrations-check");
    const now = Date.parse("2026-10-04T06:45:00Z"); // 1 h after the review
    // after the review: 23a9 10371−668 s, f82d 9939−311 s, 3c04 8874−301 s → median 9628 s
    expect(releaseEstimateNow(history, tail, now)).toEqual({ profile: "migrations", estimateMs: expect.any(Number), remainingMs: (9628 - 3600) * 1000, samples: 3 });
  });

  it("during the CI: anchored at the current step in each comparable release", () => {
    const tail = next(["[05:00:00] build", "[05:25:00] smart-deploy", "[05:36:00] migration-lint"]);
    const now = Date.parse("2026-10-04T05:40:00Z");
    const rest = [SHA_23A9, SHA_F82D, SHA_3C04].map((sha) => { const run = history.find((each) => each.sha === sha)!; return run.endedAt! - run.steps!["migration-lint"]!; }).sort((a, b) => a - b);
    expect(releaseEstimateNow(history, tail, now).remainingMs).toBe(rest[1]! - 4 * MIN);
  });

  it("without migrations: only 1 such release in the base → '—'", () => {
    const tail = next(["[05:00:00] build", "[05:15:00] smart-deploy", "[05:24:00] script-contracts"]);
    expect(releaseEstimateNow(history, tail, Date.parse("2026-10-04T05:30:00Z"))).toMatchObject({ profile: "light", remainingMs: null, samples: 1 });
  });

  it("the aggregate carries profile, estimate and time left; past the median the time left is negative", () => {
    const tail = next(["[05:00:00] build", "[05:36:00] migration-lint", "**Data:** 2026-10-04T05:45:00Z | **Duracao:** 300s", "=== DEPLOY ==="]);
    const status = buildNowStatus(inputs({ runs: history, tail, now: Date.parse("2026-10-04T09:00:00Z"), inFlight: { label: `release:production:${NEXT}`, state: "holding", ageS: 100, overdue: false } }));
    expect(status.release).toMatchObject({ phase: "deploy-check", profile: "migrations", samples: 3, remainingMs: (9628 - 3.25 * 3600) * 1000 });
  });
});

function inputs(extra: Partial<NowInputs>): NowInputs {
  return {
    now: Date.parse("2026-10-04T12:00:00Z"), enabled: true, report: null, runs: [], tail: emptyReleaseTail(), inFlight: null, releaseStartedAt: null, releasePrs: null,
    prs: { list: [], checkedAt: null }, ci: { state: "idle", queued: 0 }, alerts: [], ...extra,
  };
}

describe("the tag: judged only on a reading after the release", () => {
  const { runs } = parseReleaseLogText(LOG, { endOfStream: true });
  const delivered = runs.find((run) => run.sha === SHA_3C04)!.endedAt!; // 04:02:23Z
  const report = (sha: string, checkedAt: number) => ({
    kpis: { releaseCovered: "full", deliveries: 0, mergedPrs: 0, closedIssues: 0, failedReleases: 0 }, releases: [],
    coverage: { github: { syncedAt: checkedAt }, tag: { sha, checkedAt, matchesHistory: null } },
  }) as unknown as ProductivityReport;

  it("a GitHub reading from before the tag could move is 'a conferir', not 'diverge'", () => {
    const status = buildNowStatus(inputs({ runs, report: report(SHA_F9E7, delivered + 5 * MIN), now: delivered + 10 * MIN }));
    expect(status.production).toMatchObject({ sha: SHA_3C04, tag: { sha: SHA_F9E7, agrees: null } });
  });

  it("past the settle time, a reading that still has the old tag is a real divergence; the new one agrees", () => {
    expect(buildNowStatus(inputs({ runs, report: report(SHA_F9E7, delivered + TAG_SETTLE_MS + MIN) })).production.tag.agrees).toBe(false);
    expect(buildNowStatus(inputs({ runs, report: report(SHA_3C04, delivered + TAG_SETTLE_MS + MIN) })).production.tag.agrees).toBe(true);
  });

  it("read live: the tag line seen, then this server's own reading after it decides", () => {
    const tail = emptyReleaseTail();
    for (const line of runLines(SHA_3C04)) pushReleaseTail(tail, line, delivered + 4 * MIN);
    const before = buildNowStatus(inputs({ runs, tail, tagRead: { sha: SHA_F9E7, checkedAt: delivered + 3 * MIN } }));
    expect(before.production.tag.agrees).toBeNull();
    const after = buildNowStatus(inputs({ runs, tail, tagRead: { sha: SHA_3C04, checkedAt: delivered + 5 * MIN } }));
    expect(after.production.tag).toMatchObject({ sha: SHA_3C04, agrees: true });
  });
});

describe("alerts leave the red as soon as they are settled", () => {
  const { runs } = parseReleaseLogText(LOG, { endOfStream: true });
  const now = Date.parse("2026-10-04T05:00:00Z");
  const failing = { key: "release:cb015584a", at: now - 30 * MIN, text: "Release cb015584a falhou 3× seguidas — não está em produção; a tag de produção não andou.", sha: "cb015584a", kind: "release" as const, botId: "chief", threadId: "desk" };
  const stuck = { key: "tag:3c04d7c3d", at: now - 20 * MIN, text: "Produção está no ar em 3c04d7c3d há 20 min, mas a tag de produção continua em f9e7a2350: …", sha: "3c04d7c3d", kind: "tag" as const };

  it("a failing commit the owner declined is gone at once", () => {
    expect(buildNowStatus(inputs({ runs, now, alerts: [failing] })).alerts).toHaveLength(1);
    expect(buildNowStatus(inputs({ runs, now, alerts: [failing], declined: "cb015584a0000000000000000000000000000000" })).alerts).toEqual([]);
  });

  it("a stuck tag stays until a reading has the tag on that commit — not merely because production runs it", () => {
    expect(buildNowStatus(inputs({ runs, now, alerts: [stuck], tagRead: { sha: SHA_F9E7, checkedAt: now - MIN } })).alerts).toHaveLength(1);
    expect(buildNowStatus(inputs({ runs, now, alerts: [stuck], tagRead: { sha: SHA_3C04, checkedAt: now - MIN } })).alerts).toEqual([]);
  });

  it("a commit that was released afterwards settles its failure alerts", () => {
    const released = { ...failing, key: "release:f82d10edb", sha: "f82d10edb", at: Date.parse("2026-10-03T18:00:00Z") };
    expect(buildNowStatus(inputs({ runs: runs.filter((run: ReleaseRun) => run.sha !== SHA_3C04 && run.sha !== SHA_F9E7), now: Date.parse("2026-10-03T23:00:00Z"), alerts: [released] })).alerts).toEqual([]);
  });
});
