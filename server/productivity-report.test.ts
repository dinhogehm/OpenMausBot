// The productivity report's numbers (lot V) on a small, fully known history
// (testing/productivity-fixture.ts): releases on both sides of a month end
// (São Paulo, not UTC), what each one carried, lead times, failures that ran
// vs runs superseded or aborted, the release pipeline stopped (production up),
// DORA, the backlog at each bucket's end, coverage gaps, the bots' local effort
// only where it was recorded, and the time a report takes on a real-size cache.
import { describe, expect, it } from "vitest";
import { bucketStarts } from "../shared/productivity.ts";
import type { GhIssue, GhPr } from "./productivity-github.ts";
import { buildProductivityReport, buildTimeline, businessDays, issuesOfPr, releasePairs, weekendMs } from "./productivity-report.ts";
import { brt, HOUR, scenario, sha } from "./testing/productivity-fixture.ts";

const monthReport = () => {
  const base = scenario();
  return buildProductivityReport({ ...base, granularity: "month", period: { from: brt("2026-09-01T00:00:00"), to: brt("2026-11-01T00:00:00") } });
};

describe("release timeline", () => {
  it("attributes merges to the release whose range holds their commit; issues only by explicit reference and only when closed (INSP-V r1 #3)", () => {
    const timeline = buildTimeline(scenario());
    expect(timeline.releases.map((release) => [release.sha[0], release.prs.map((pr) => pr.number), release.issues.map((each) => each.number), release.contentUnknownReason ?? null])).toEqual([
      ["a", [], [], "first"], // the first release: nothing before it to compare with
      ["b", [1, 2], [101], null],
      // #6 names open issue #104 (and its branch says 104): not delivered; #7's branch says 103: no reference
      ["c", [3, 6, 7], [102], null],
    ]);
    expect(timeline.issueDelivered.has(104)).toBe(false);
    expect(timeline.issueDelivered.has(103)).toBe(false);
    expect(timeline.prDelivered.get(4)).toBeUndefined();
    // only failures that ran open the stopped interval; superseded and aborted runs do not
    expect(timeline.blocked).toEqual([{ from: brt("2026-10-01T05:00:00"), to: brt("2026-10-01T10:00:00") }]);
  });

  it("a PR delivers only closed, completed issues it names", () => {
    const issues: Record<string, GhIssue> = {
      1: { number: 1, title: "", createdAt: 0, updatedAt: 0, closedAt: 1, state: "CLOSED", stateReason: "COMPLETED", labels: [] },
      2: { number: 2, title: "", createdAt: 0, updatedAt: 0, closedAt: null, state: "OPEN", stateReason: null, labels: [] },
      3: { number: 3, title: "", createdAt: 0, updatedAt: 0, closedAt: 1, state: "CLOSED", stateReason: "NOT_PLANNED", labels: [] },
      4: { number: 4, title: "", createdAt: 0, updatedAt: 0, closedAt: 1, state: "CLOSED", stateReason: "COMPLETED", labels: [] },
    };
    const pr = { number: 9, closes: [1, 2], refs: [3], head: "fix/4-branch" } as unknown as GhPr;
    expect(issuesOfPr(pr, issues).map((issue) => issue.number)).toEqual([1]);
  });

  it("says why a release's contents are unknown: first, across a gap, or not read yet", () => {
    const base = scenario();
    delete base.github.compares[`${sha("b")}...${sha("c")}`];
    expect(buildTimeline(base).releases.map((release) => release.contentUnknownReason ?? null)).toEqual(["first", null, "pending"]);
    expect(buildTimeline({ ...scenario(), logCoverage: { from: brt("2026-09-30T00:00:00"), to: null } }).releases.map((release) => release.contentUnknownReason ?? null)).toEqual(["first", "gap", null]);
  });

  it("asks for the contents of consecutive releases only", () => {
    const base = scenario();
    expect(releasePairs(base)).toEqual([{ base: sha("b"), head: sha("c") }, { base: sha("a"), head: sha("b") }]);
    // across a time no source covers, other deploys may have shipped part of it: not compared
    expect(releasePairs({ ...base, logCoverage: { from: brt("2026-09-30T00:00:00"), to: null } })).toEqual([{ base: sha("b"), head: sha("c") }]);
  });

  it("takes GitHub's old production deployments as releases and failures, the log winning for the same commit, a bot's preview never", () => {
    const base = scenario();
    base.github.deployments = [
      { id: 0, sha: sha("v"), createdAt: brt("2026-02-04T17:43:55"), successAt: brt("2026-02-04T17:58:58"), failedAt: null, creator: "vercel[bot]", final: true },
      { id: 1, sha: sha("g"), createdAt: brt("2026-08-20T10:00:00"), successAt: brt("2026-08-20T11:00:00"), failedAt: null, creator: "dinhogehm", final: true },
      { id: 2, sha: sha("h"), createdAt: brt("2026-08-21T10:00:00"), successAt: null, failedAt: brt("2026-08-21T10:30:00"), creator: "dinhogehm", final: true },
      { id: 3, sha: sha("a"), createdAt: brt("2026-08-22T10:00:00"), successAt: brt("2026-08-22T11:00:00"), failedAt: null, creator: "dinhogehm", final: true },
    ];
    const timeline = buildTimeline(base);
    expect(timeline.releases.map((release) => [release.sha[0], release.timeSource])).toEqual([["g", "github-deployment"], ["a", "log"], ["b", "log"], ["c", "log"]]);
    const report = buildProductivityReport({ ...base, granularity: "month", period: { from: brt("2026-08-01T00:00:00"), to: brt("2026-09-01T00:00:00") } });
    expect(report.kpis).toMatchObject({ deliveries: 1, failedReleases: 1 });
    expect(report.coverage.githubDeployments.from).toBe(brt("2026-08-20T11:00:00"));
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

  it("counts deliveries, merges and closures by their own dates; unknown contents are flagged", () => {
    expect(september).toMatchObject({ deliveredPrs: 1, unknownContentReleases: 1, mergedPrs: 1, closedIssues: 1, closedBugs: 1, failedReleases: 0 });
    expect(october).toMatchObject({ deliveredPrs: 3, unknownContentReleases: 0, mergedPrs: 4, closedIssues: 2, closedBugs: 0, failedReleases: 2 });
  });

  it("knows where no release source existed, and where the bots were not recorded (unknown, not zero)", () => {
    expect(september!.releaseCoverage).toBe("partial");
    expect(october!.releaseCoverage).toBe("full");
    expect(report.coverage.releaseGaps).toEqual([{ from: brt("2026-09-01T00:00:00"), to: brt("2026-09-29T00:00:00") }]);
    expect(september).toMatchObject({ usageCoverage: "partial", turns: 1 });
    const day = buildProductivityReport({ ...scenario(), granularity: "day", period: { from: brt("2026-09-26T00:00:00"), to: brt("2026-09-29T00:00:00") } });
    // the ledger starts on the 28th: the 26th and 27th are "—", the 28th is recorded
    expect(day.buckets.map((bucket) => [bucket.key, bucket.turns, bucket.usageCoverage])).toEqual([["2026-09-26", null, "none"], ["2026-09-27", null, "none"], ["2026-09-28", 0, "full"]]);
  });
});

describe("KPIs", () => {
  const report = monthReport();
  const k = report.kpis;

  it("delivery and throughput; delivered totals are lower bounds when a release's contents are unknown (INSP-V r1 #4)", () => {
    expect(k).toMatchObject({ deliveries: 3, deliveredPrs: 4, deliveredIssues: 2, unknownContentReleases: 1, mergedPrs: 5, carrierPrs: 1, closedIssues: 3, closedNotPlanned: 1 });
    expect(k.closedByType).toEqual({ bug: 1, improvement: 1, feature: 0, other: 0 });
    expect(k.closedByPriority).toEqual({ p0: 0, p1: 1, p2: 1, p3: 0, none: 0 });
  });

  it("lead times: issue → merge → production", () => {
    // #101: created 09-28 09:00, merged 09-30 20:00, live 09-30 23:30; #102: 09-30 10:00 → 10-01 08:00 → 10-01 10:00
    expect(k.leadIssueToProd).toEqual({ n: 2, median: ((62.5 + 24) / 2) * HOUR, p90: 62.5 * HOUR });
    expect(k.leadIssueToMerge).toEqual({ n: 2, median: ((59 + 22) / 2) * HOUR, p90: 59 * HOUR });
    // PRs 1, 3, 6, 7: 3,5 h, 2 h, 1,5 h, 1 h 20
    expect(k.leadMergeToProd).toEqual({ n: 4, median: 1.75 * HOUR, p90: 3.5 * HOUR });
  });

  it("a failure is a run that ran; superseded and aborted runs are apart and out of the success rate (INSP-V r1 #1)", () => {
    expect(k).toMatchObject({ failedReleases: 2, supersededReleases: 1, abortedReleases: 1, declinedReleases: 1, releaseSuccessRate: 3 / 5 });
  });

  it("the release pipeline stopped 5 h (production up), none of it on a weekend (INSP-V r1 #2)", () => {
    expect(k).toMatchObject({ blockedMs: 5 * HOUR, blockedWeekendMs: 0 });
  });

  it("DORA: deploys per business day, change failure rate and time to restore from the post-release check", () => {
    // September has 22 business days; Oct 1st (Thu) whole, Oct 2nd (Fri) half by noon
    expect(k.businessDays).toBe(23.5);
    expect(k.deploysPerBusinessDay).toBe(0.13);
    expect(k).toMatchObject({ changeFailures: 1, checkedReleases: 2 });
    expect(k.timeToRestore).toEqual({ n: 1, median: 10.5 * HOUR, p90: 10.5 * HOUR });
  });

  it("backlog at the end of the period and now, P1 = p1 + high and P0 = p0 + critical, each split (INSP-V r1 #5)", () => {
    expect(k.openIssuesAtEnd).toBe(2);
    expect(k.openP1AtEnd).toBe(2);
    expect(report.backlog).toMatchObject({ openIssues: 2, openP1: 1, openP0: 1, openP1Split: { current: 1, legacy: 0 }, openP0Split: { current: 0, legacy: 1 }, prsAwaitingGate: 1, openPrs: 3 });
    expect(report.backlog.oldestOpen).toEqual({ number: 104, createdAt: brt("2026-09-10T10:00:00"), priority: "p1" });
    expect(report.backlog.prsAwaitingGateList.map((pr) => pr.number)).toEqual([20]);
  });

  it("bots: only the recorded days, the cost per delivery in those days (INSP-V r1 #6)", () => {
    expect(k).toMatchObject({ turns: 3, activeMs: 30 * 60_000, timedTurns: 1, inputTokens: 1510, outputTokens: 151, cachedTokens: 800, costUsd: 0.75, needsYouOpened: 3, needsYouResolved: 2 });
    // ledger from 28/09 00:00 to now (02/10 12:00): 4,5 days, 3 deliveries in them
    expect(k).toMatchObject({ usageDays: 4.5, deliveriesInUsageDays: 3, costPerDelivery: 0.25 });
    expect(k.ownerResponse).toEqual({ n: 2, median: 1.25 * HOUR, p90: 2 * HOUR });
    expect(report.bots.map((bot) => [bot.name, bot.turns, bot.activeMs, bot.costUsd, bot.needsYouOpened, bot.needsYouResolved, bot.needsYouOpenNow])).toEqual([
      ["Chief of Staff", 2, 30 * 60_000, 0.75, 2, 2, 0],
      ["Lead", 1, 0, null, 1, 0, 1],
    ]);
  });

  it("knows when the repository was created (no comparison against a period before it)", () => {
    expect(report.previous).toEqual({ from: brt("2026-07-01T00:00:00"), to: brt("2026-09-01T00:00:00") });
    expect(report.coverage.github.repoCreatedAt).toBe(brt("2026-08-15T00:00:00"));
  });

  it("checks the tag against the history", () => {
    expect(report.coverage.tag).toMatchObject({ sha: sha("c"), matchesHistory: true });
  });
});

describe("release rows", () => {
  it("lists releases, failures that ran, superseded and aborted runs, and refusals, newest first; the head PR is a carrier only when it is one (INSP-V r1 #8)", () => {
    const rows = monthReport().releases.map((row) => [row.outcome, row.sha[0], row.attempts ?? 1, row.headPr ?? null, row.headPrIsCarrier ?? false, row.prs.map((pr) => pr.number), row.issues.map((each) => each.number)]);
    expect(rows).toEqual([
      ["released", "c", 1, null, false, [3, 6, 7], [102]],
      ["aborted", "z", 1, null, false, [], []],
      ["superseded", "s", 1, null, false, [], []],
      ["declined", "x", 1, null, false, [], []],
      ["failed", "x", 2, 6, false, [], []], // two tries of the same commit in a row: one row; #6 is not a carrier
      ["released", "b", 1, 2, true, [1, 2], [101]],
      ["released", "a", 1, null, false, [], []],
    ]);
    expect(monthReport().releases.find((row) => row.sha[0] === "a")).toMatchObject({ contentUnknown: true, contentUnknownReason: "first" });
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
    expect(report.buckets.at(-1)!.turns).toBeNull();
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

describe("calendar helpers", () => {
  it("weekend time and business days in São Paulo", () => {
    // Fri 25/09 03:05 → Tue 29/09 14:26 (the real stop of 25–29/09): the whole weekend inside
    expect(weekendMs(brt("2026-09-25T03:05:00"), brt("2026-09-29T14:26:00"))).toBe(48 * HOUR);
    expect(businessDays(brt("2026-09-28T00:00:00"), brt("2026-10-05T00:00:00"))).toBe(5);
    expect(businessDays(brt("2026-10-03T00:00:00"), brt("2026-10-05T00:00:00"))).toBe(0);
  });
});

describe("speed (INSP-V r1 #10)", () => {
  it("builds a year by day and two weeks by hour over a cache the size of the real one in under 50 ms each", () => {
    const base = scenario();
    const start = brt("2026-01-10T00:00:00");
    // 7.3 thousand PRs and 1.9 thousand issues, as on 02/10
    for (let i = 0; i < 7300; i += 1) {
      const at = start + i * 37 * 60_000;
      base.github.prs[String(10_000 + i)] = { number: 10_000 + i, title: "", createdAt: at - HOUR, updatedAt: at, mergedAt: at, closedAt: at, state: "MERGED", draft: false, base: "main", head: i % 9 ? `fix/${i}` : `chore/release-carrier-${i}`, mergeSha: `x${i}`, closes: [], labels: [] };
    }
    for (let i = 0; i < 1900; i += 1) {
      const at = start + i * 140 * 60_000;
      base.github.issues[String(30_000 + i)] = { number: 30_000 + i, title: "", createdAt: at, updatedAt: at, closedAt: i % 8 ? at + 30 * HOUR : null, state: i % 8 ? "CLOSED" : "OPEN", stateReason: i % 8 ? "COMPLETED" : null, labels: ["type:bug", "priority:p1"] };
    }
    const time = (granularity: "day" | "hour", from: string, to: string) => {
      const runs: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const t0 = performance.now();
        buildProductivityReport({ ...base, granularity, period: { from: brt(from), to: brt(to) } });
        runs.push(performance.now() - t0);
      }
      return Math.min(...runs);
    };
    expect(time("day", "2025-10-03T00:00:00", "2026-10-03T00:00:00")).toBeLessThan(50);
    expect(time("hour", "2026-09-19T00:00:00", "2026-10-03T00:00:00")).toBeLessThan(50);
  });
});
