// The productivity report's numbers (lot V) on a small, fully known history
// (testing/productivity-fixture.ts): releases on both sides of a month end
// (São Paulo, not UTC), what each one carried, lead times, failures and the
// time production stayed blocked, the backlog at each bucket's end, coverage
// gaps, and the bots' local effort.
import { describe, expect, it } from "vitest";
import { bucketStarts } from "../shared/productivity.ts";
import { buildProductivityReport, buildTimeline, releasePairs } from "./productivity-report.ts";
import { brt, HOUR, scenario, sha } from "./testing/productivity-fixture.ts";

const monthReport = () => {
  const base = scenario();
  return buildProductivityReport({ ...base, granularity: "month", period: { from: brt("2026-09-01T00:00:00"), to: brt("2026-11-01T00:00:00") } });
};

describe("release timeline", () => {
  it("attributes merges to the release whose range holds their commit, carriers apart", () => {
    const timeline = buildTimeline(scenario());
    expect(timeline.releases.map((release) => [release.sha[0], release.prs.map((pr) => pr.number), release.issues.map((each) => each.number), release.contentUnknown])).toEqual([
      ["a", [], [], true], // the first release: nothing before it to compare with
      ["b", [1, 2], [101], false],
      ["c", [3], [102], false],
    ]);
    expect(timeline.prDelivered.get(4)).toBeUndefined();
    expect(timeline.blocked).toEqual([{ from: brt("2026-10-01T05:00:00"), to: brt("2026-10-01T10:00:00") }]);
  });

  it("asks for the contents of consecutive releases only", () => {
    const base = scenario();
    expect(releasePairs(base)).toEqual([{ base: sha("b"), head: sha("c") }, { base: sha("a"), head: sha("b") }]);
    // across a time no source covers, other deploys may have shipped part of it: not compared
    expect(releasePairs({ ...base, logCoverage: { from: brt("2026-09-30T00:00:00"), to: null } })).toEqual([{ base: sha("b"), head: sha("c") }]);
  });

  it("takes GitHub's old production deployments as releases and failures, the log winning for the same commit", () => {
    const base = scenario();
    base.github.deployments = [
      { id: 1, sha: sha("g"), createdAt: brt("2026-08-20T10:00:00"), successAt: brt("2026-08-20T11:00:00"), failedAt: null, final: true },
      { id: 2, sha: sha("h"), createdAt: brt("2026-08-21T10:00:00"), successAt: null, failedAt: brt("2026-08-21T10:30:00"), final: true },
      { id: 3, sha: sha("a"), createdAt: brt("2026-08-22T10:00:00"), successAt: brt("2026-08-22T11:00:00"), failedAt: null, final: true },
    ];
    const timeline = buildTimeline(base);
    expect(timeline.releases.map((release) => [release.sha[0], release.timeSource])).toEqual([["g", "github-deployment"], ["a", "log"], ["b", "log"], ["c", "log"]]);
    const report = buildProductivityReport({ ...base, granularity: "month", period: { from: brt("2026-08-01T00:00:00"), to: brt("2026-09-01T00:00:00") } });
    expect(report.kpis).toMatchObject({ deliveries: 1, failedReleases: 1 });
    expect(report.releases.map((row) => [row.outcome, row.timeSource])).toEqual([["failed", "github-deployment"], ["released", "github-deployment"]]);
  });
});

describe("month buckets (São Paulo)", () => {
  const report = monthReport();
  const [september, october] = report.buckets;

  it("puts the 23:30 release of Sep 30 in September, though it is October in UTC", () => {
    expect(report.buckets.map((bucket) => bucket.key)).toEqual(["2026-09", "2026-10"]);
    expect(september!.deliveries).toBe(2);
    expect(october!.deliveries).toBe(1);
  });

  it("counts deliveries, merges and closures by their own dates", () => {
    expect(september).toMatchObject({ deliveredPrs: 1, mergedPrs: 1, closedIssues: 1, closedBugs: 1, failedReleases: 0 });
    expect(october).toMatchObject({ deliveredPrs: 1, mergedPrs: 2, closedIssues: 2, closedBugs: 0, failedReleases: 2 });
  });

  it("knows where no release source existed (unknown, not zero)", () => {
    expect(september!.releaseCoverage).toBe("partial");
    expect(october!.releaseCoverage).toBe("full");
    expect(report.coverage.releaseGaps).toEqual([{ from: brt("2026-09-01T00:00:00"), to: brt("2026-09-29T00:00:00") }]);
  });
});

describe("KPIs", () => {
  const report = monthReport();
  const k = report.kpis;

  it("delivery and throughput", () => {
    expect(k).toMatchObject({ deliveries: 3, deliveredPrs: 2, deliveredIssues: 2, mergedPrs: 3, carrierPrs: 1, closedIssues: 3, closedNotPlanned: 1 });
    expect(k.closedByType).toEqual({ bug: 1, improvement: 1, feature: 0, other: 0 });
    expect(k.closedByPriority).toEqual({ p0: 0, p1: 1, p2: 1, p3: 0, none: 0 });
  });

  it("lead times: issue → merge → production", () => {
    // #101: created 09-28 09:00, merged 09-30 20:00, live 09-30 23:30; #102: 09-30 10:00 → 10-01 08:00 → 10-01 10:00
    expect(k.leadIssueToProd).toEqual({ n: 2, median: ((62.5 + 24) / 2) * HOUR, p90: 62.5 * HOUR });
    expect(k.leadIssueToMerge).toEqual({ n: 2, median: ((59 + 22) / 2) * HOUR, p90: 59 * HOUR });
    expect(k.leadMergeToProd).toEqual({ n: 2, median: 2.75 * HOUR, p90: 3.5 * HOUR });
  });

  it("failures, refusals and blocked production", () => {
    expect(k).toMatchObject({ failedReleases: 2, declinedReleases: 1, blockedMs: 5 * HOUR });
  });

  it("backlog at the end of the period and now", () => {
    expect(k.openIssuesAtEnd).toBe(2);
    expect(k.openP1AtEnd).toBe(2);
    expect(report.backlog).toMatchObject({ openIssues: 2, openP1: 1, openP0: 1, prsAwaitingGate: 1, openPrs: 3 });
    expect(report.backlog.oldestOpen).toEqual({ number: 104, createdAt: brt("2026-09-10T10:00:00"), priority: "p1" });
    expect(report.backlog.prsAwaitingGateList.map((pr) => pr.number)).toEqual([20]);
  });

  it("bots: turns, active time, tokens, cost, items and the owner's response", () => {
    expect(k).toMatchObject({ turns: 3, activeMs: 30 * 60_000, timedTurns: 1, inputTokens: 1510, outputTokens: 151, cachedTokens: 800, costUsd: 0.75, needsYouOpened: 3, needsYouResolved: 2 });
    expect(k.ownerResponse).toEqual({ n: 2, median: 1.25 * HOUR, p90: 2 * HOUR });
    expect(report.bots.map((bot) => [bot.name, bot.turns, bot.activeMs, bot.costUsd, bot.needsYouOpened, bot.needsYouResolved, bot.needsYouOpenNow])).toEqual([
      ["Chief of Staff", 2, 30 * 60_000, 0.75, 2, 2, 0],
      ["Lead", 1, 0, null, 1, 0, 1],
    ]);
  });

  it("compares with the period right before (August–September here, nothing)", () => {
    expect(report.previousKpis.deliveries).toBe(0);
    expect(report.previous).toEqual({ from: brt("2026-07-01T00:00:00"), to: brt("2026-09-01T00:00:00") });
  });

  it("checks the tag against the history", () => {
    expect(report.coverage.tag).toMatchObject({ sha: sha("c"), matchesHistory: true });
  });
});

describe("release rows", () => {
  it("lists releases, grouped failures and refusals, newest first", () => {
    const rows = monthReport().releases.map((row) => [row.outcome, row.sha[0], row.attempts ?? 1, row.prs.map((pr) => pr.number), row.issues.map((each) => each.number)]);
    expect(rows).toEqual([
      ["released", "c", 1, [3], [102]],
      ["declined", "x", 1, [], []],
      ["failed", "x", 2, [], []], // two tries of the same commit in a row: one row
      ["released", "b", 1, [1, 2], [101]],
      ["released", "a", 1, [], []],
    ]);
  });
});

describe("hour and day buckets", () => {
  it("48 hours end with the current hour; a release lands in its São Paulo hour", () => {
    const base = scenario();
    const report = buildProductivityReport({ ...base, granularity: "hour", period: { from: brt("2026-09-30T13:00:00"), to: brt("2026-10-02T13:00:00") } });
    expect(report.buckets).toHaveLength(48);
    const late = report.buckets.find((bucket) => bucket.key === "2026-09-30T23")!;
    expect(late.deliveries).toBe(1);
    // a bucket that starts at "now" has no time behind it yet
    expect(report.buckets.at(-2)!.releaseCoverage).toBe("full");
    expect(report.buckets.at(-1)!.releaseCoverage).toBe("none");
    expect(bucketStarts(report.period.from, report.period.to, "hour")).toHaveLength(48);
  });

  it("day buckets carry the backlog at each day's end", () => {
    const base = scenario();
    const report = buildProductivityReport({ ...base, granularity: "day", period: { from: brt("2026-09-28T00:00:00"), to: brt("2026-10-03T00:00:00") } });
    expect(report.buckets.map((bucket) => [bucket.key, bucket.openIssuesAtEnd])).toEqual([
      ["2026-09-28", 3], ["2026-09-29", 4], ["2026-09-30", 4], ["2026-10-01", 2], ["2026-10-02", 2],
    ]);
  });
});
