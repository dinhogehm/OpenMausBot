// São Paulo calendar and statistics behind the productivity report (lot V).
import { describe, expect, it } from "vitest";
import {
  BOT_ROLES, botRole, bucketKey, bucketStart, bucketStarts, closedMonth, compareKpi, distribution, exportReadiness, goalStatus, isNationalHoliday, nextBucket, parseReportBound, periodTitle, presetPeriod,
  previousPeriod, resolveReportPeriod, sanitizeGoals, zonedParts, zonedToUtc,
} from "./productivity.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const brt = (text: string) => Date.parse(`${text}-03:00`);

describe("São Paulo calendar", () => {
  it("reads the wall clock at an instant (UTC−3)", () => {
    expect(zonedParts(Date.parse("2026-10-01T02:30:00Z"))).toMatchObject({ year: 2026, month: 9, day: 30, hour: 23, minute: 30 });
    expect(iso(zonedToUtc(2026, 10, 1))).toBe("2026-10-01T03:00:00.000Z");
  });

  it("puts 23:30 of the 30th in September and its day, though UTC is already October", () => {
    const at = brt("2026-09-30T23:30:00");
    expect(bucketKey(at, "month")).toBe("2026-09");
    expect(bucketKey(at, "day")).toBe("2026-09-30");
    expect(bucketKey(at, "hour")).toBe("2026-09-30T23");
    expect(iso(bucketStart(at, "month"))).toBe("2026-09-01T03:00:00.000Z");
    expect(iso(nextBucket(bucketStart(at, "month"), "month"))).toBe("2026-10-01T03:00:00.000Z");
  });

  it("walks month ends, February and the year turn", () => {
    expect(bucketStarts(brt("2026-01-15T00:00:00"), brt("2026-04-01T00:00:00"), "month").map((at) => bucketKey(at, "month"))).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(bucketStarts(brt("2028-02-28T00:00:00"), brt("2028-03-02T00:00:00"), "day").map((at) => bucketKey(at, "day"))).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
    expect(bucketStarts(brt("2026-12-31T22:00:00"), brt("2027-01-01T02:00:00"), "hour").map((at) => bucketKey(at, "hour"))).toEqual(["2026-12-31T22", "2026-12-31T23", "2027-01-01T00", "2027-01-01T01"]);
  });

  it("keeps day buckets whole across the last daylight-saving jump (2018-11-04, 00:00 → 01:00)", () => {
    // to = midnight of the 6th, already at −02 (02:00Z)
    const days = bucketStarts(Date.parse("2018-11-03T03:00:00Z"), Date.parse("2018-11-06T02:00:00Z"), "day");
    expect(days.map((at) => bucketKey(at, "day"))).toEqual(["2018-11-03", "2018-11-04", "2018-11-05"]);
    // the 4th had no 00:00: it starts at 01:00 (−02), and lasts 23 hours
    expect(iso(days[1]!)).toBe("2018-11-04T03:00:00.000Z");
    expect(days[2]! - days[1]!).toBe(23 * 3_600_000);
  });
});

describe("the hour repeated when daylight saving ended (16/02/2019 23h, INSP-V r1 #16)", () => {
  it("is two buckets with two keys, an hour each", () => {
    const hours = bucketStarts(Date.parse("2019-02-17T00:00:00Z"), Date.parse("2019-02-17T04:00:00Z"), "hour");
    expect(hours.map((at) => bucketKey(at, "hour"))).toEqual(["2019-02-16T22-02", "2019-02-16T23-02", "2019-02-16T23", "2019-02-17T00"]);
    expect(new Set(hours.map((at) => bucketKey(at, "hour"))).size).toBe(4);
    expect(hours[2]! - hours[1]!).toBe(3_600_000);
  });
});

describe("comparisons (INSP-V r1 #7)", () => {
  it("a trend only on a comparable base of at least 5; the absolute value below; nothing before the repository", () => {
    expect(compareKpi(8, 6)).toEqual({ kind: "trend", delta: 2, ratio: 2 / 6 });
    expect(compareKpi(20, 1)).toEqual({ kind: "absolute", previous: 1 });
    expect(compareKpi(3, 0)).toEqual({ kind: "absolute", previous: 0 });
    expect(compareKpi(2868, 0, { beforeRepo: true })).toEqual({ kind: "none", reason: "before-repo" });
    expect(compareKpi(27, 2, { comparable: false })).toEqual({ kind: "none", reason: "not-comparable" });
    expect(compareKpi(null, 4)).toEqual({ kind: "none", reason: "no-base" });
    // a median of 9 samples gets no trend, only the previous value
    expect(compareKpi(30, 90, { samples: { current: 9, previous: 40 } })).toEqual({ kind: "absolute", previous: 90 });
    // a rate on enough runs trends though it is below 5; a ratio is judged by the count under it
    expect(compareKpi(0.9, 0.8, { samples: { current: 12, previous: 10 } })).toMatchObject({ kind: "trend" });
    expect(compareKpi(1.2, 0.8, { base: 16 })).toMatchObject({ kind: "trend" });
    expect(compareKpi(1.2, 0.2, { base: 1 })).toEqual({ kind: "absolute", previous: 0.2 });
  });
});

describe("export readiness (INSP-V r2 #3)", () => {
  const now = brt("2026-10-03T09:00:00");
  const base = (lastSyncAt: number | null, state: "idle" | "syncing" = "idle", matchesHistory: boolean | null = true) => ({
    sync: { state, lastSyncAt, lastAttemptAt: lastSyncAt, nextSyncAt: null, error: null, rateLimit: null },
    coverage: { github: { syncedAt: lastSyncAt }, tag: { sha: "9dbb1dcdd", matchesHistory, checkedAt: lastSyncAt } },
  }) as never;
  it("is ready only when synced within the hour, not syncing, and the tag agrees", () => {
    expect(exportReadiness(base(now - 30 * 60_000), now)).toEqual({ ready: true, blockers: [], ageMs: 30 * 60_000 });
    // the r2 board PDF: synced 16 h earlier, the tag read before the last release
    expect(exportReadiness(base(now - 16 * 3_600_000, "idle", false), now).blockers).toEqual(["stale", "tag-mismatch"]);
    expect(exportReadiness(base(now - 60_000, "syncing"), now).blockers).toEqual(["syncing"]);
    expect(exportReadiness(base(null, "idle", null), now).blockers).toEqual(["never"]);
    // a fresh sync whose history walk stopped short still leaves partial counts (INSP-V r3 #3)
    const partial = base(now - 60_000) as unknown as { coverage: { github: { complete: boolean } } };
    partial.coverage.github.complete = false;
    expect(exportReadiness(partial as never, now).blockers).toEqual(["incomplete"]);
  });
});

describe("calendar and roles", () => {
  it("knows Brazil's national holidays, Good Friday included; Carnival stays a business day", () => {
    expect(isNationalHoliday(2026, 9, 7)).toBe(true);
    expect(isNationalHoliday(2026, 4, 3)).toBe(true); // Good Friday 2026
    expect(isNationalHoliday(2026, 2, 17)).toBe(false); // Carnival, optional
    expect(isNationalHoliday(2026, 9, 8)).toBe(false);
  });

  it("tells engineering bots from operations by an explicit list, id first (INSP-V r2 #4, r3 #4)", () => {
    for (const name of ["Lead PRODEV", "Eng PRODEV", "QA PRODEV", "DBA PRODEV", "SRE PRODEV", "Delivery PRODEV"]) expect(botRole(name)).toBe("engineering");
    for (const name of ["Monitor Chat Atendimento", "Chief of Staff"]) expect(botRole(name)).toBe("operations");
    // a renamed bot keeps its role by id; a new one is "other", never guessed from its name
    expect(botRole("Monitor renomeado", "891b6b94-facf-4d44-9ef4-de647a15ce72")).toBe("operations");
    expect(botRole("Eng PRODEV 2")).toBe("other");
    expect(botRole("Assistente")).toBe("other");
    expect(Object.values(BOT_ROLES).filter((role) => role === "engineering")).toHaveLength(12);
  });
});

describe("goals", () => {
  it("keep only sane numbers and light only where a target exists", () => {
    expect(sanitizeGoals({ deploysPerBusinessDay: 1, leadTimeHours: -2, releaseSuccessRate: 140, changeFailureRate: "x", other: 3 })).toEqual({ deploysPerBusinessDay: 1 });
    expect(goalStatus("deploysPerBusinessDay", 1.2, { deploysPerBusinessDay: 1 })).toBe("met");
    expect(goalStatus("deploysPerBusinessDay", 0.85, { deploysPerBusinessDay: 1 })).toBe("close");
    expect(goalStatus("deploysPerBusinessDay", 0.4, { deploysPerBusinessDay: 1 })).toBe("off");
    expect(goalStatus("leadTimeHours", 40, { leadTimeHours: 48 })).toBe("met");
    expect(goalStatus("leadTimeHours", 70, { leadTimeHours: 48 })).toBe("off");
    expect(goalStatus("leadTimeHours", 40, {})).toBeNull();
    expect(goalStatus("leadTimeHours", null, { leadTimeHours: 48 })).toBeNull();
  });
});

describe("titles", () => {
  const now = brt("2026-10-02T17:40:00");
  it("name a closed month, the current one so far, or a date range", () => {
    expect(periodTitle({ from: brt("2026-09-01T00:00:00"), to: brt("2026-10-01T00:00:00") }, now)).toBe("setembro/2026");
    expect(periodTitle({ from: brt("2026-10-01T00:00:00"), to: brt("2026-11-01T00:00:00") }, now)).toBe("outubro/2026 (até 02/10)");
    expect(periodTitle(presetPeriod("day", 30, now), now)).toBe("03/09 a 02/10/2026");
    expect(periodTitle({ from: brt("2026-09-17T00:00:00"), to: brt("2026-09-18T00:00:00") }, now)).toBe("17/09/2026");
    expect(periodTitle({ from: brt("2025-11-01T00:00:00"), to: brt("2026-11-01T00:00:00") }, now)).toBe("novembro/2025 – outubro/2026");
    expect(periodTitle({ from: brt("2026-09-01T00:00:00"), to: brt("2026-10-01T00:00:00") }, now, "en")).toBe("September/2026");
    expect(closedMonth(now)).toEqual({ from: "2026-09", to: "2026-09" });
    expect(closedMonth(brt("2026-01-05T10:00:00"))).toEqual({ from: "2025-12", to: "2025-12" });
  });
});

describe("periods", () => {
  const now = brt("2026-10-02T17:40:00");

  it("offers the last 48 hours, 30 or 90 days and 12 months, current bucket included", () => {
    const hours = presetPeriod("hour", 48, now);
    expect(bucketStarts(hours.from, hours.to, "hour")).toHaveLength(48);
    expect(iso(hours.to)).toBe(iso(brt("2026-10-02T18:00:00")));
    const days = presetPeriod("day", 30, now);
    expect(bucketKey(days.from, "day")).toBe("2026-09-03");
    expect(iso(days.to)).toBe(iso(brt("2026-10-03T00:00:00")));
    expect(bucketStarts(presetPeriod("day", 90, now).from, days.to, "day")).toHaveLength(90);
    const months = presetPeriod("month", 12, now);
    expect(bucketKey(months.from, "month")).toBe("2025-11");
    expect(bucketStarts(months.from, months.to, "month")).toHaveLength(12);
  });

  it("compares with the same number of buckets right before", () => {
    const month = presetPeriod("month", 1, now);
    const previous = previousPeriod(month, "month");
    expect(bucketKey(previous.from, "month")).toBe("2026-09");
    expect(previous.to).toBe(month.from);
    const days = presetPeriod("day", 30, now);
    const before = previousPeriod(days, "day");
    expect(bucketStarts(before.from, before.to, "day")).toHaveLength(30);
    expect(bucketKey(before.from, "day")).toBe("2026-08-04");
  });

  it("parses dates in São Paulo, months, instants, and refuses the rest", () => {
    expect(iso(parseReportBound("2026-09-01", false)!)).toBe("2026-09-01T03:00:00.000Z");
    expect(iso(parseReportBound("2026-09-30", true)!)).toBe("2026-10-01T03:00:00.000Z");
    expect(iso(parseReportBound("2026-09", true)!)).toBe("2026-10-01T03:00:00.000Z");
    expect(iso(parseReportBound("2026-10-02T12:00:00Z", false)!)).toBe("2026-10-02T12:00:00.000Z");
    expect(parseReportBound("2026-02-31", false)).toBeNull();
    expect(parseReportBound("2026-13", false)).toBeNull();
    expect(parseReportBound("yesterday", false)).toBeNull();
  });

  it("resolves a request: presets, explicit ranges, and limits", () => {
    expect(resolveReportPeriod({ granularity: "day", now, count: 90 })).toEqual({ period: presetPeriod("day", 90, now) });
    expect(resolveReportPeriod({ granularity: "day", now, count: 7 })).toEqual({ period: presetPeriod("day", 30, now) });
    const september = resolveReportPeriod({ granularity: "day", now, from: "2026-09-01", to: "2026-09-30" });
    expect("period" in september && bucketStarts(september.period.from, september.period.to, "day")).toHaveLength(30);
    expect(resolveReportPeriod({ granularity: "day", now, from: "2026-09-01" })).toEqual({ error: "from and to go together" });
    expect(resolveReportPeriod({ granularity: "day", now, from: "2026-09-30", to: "2026-09-01" })).toEqual({ error: "from must come before to" });
    expect(resolveReportPeriod({ granularity: "hour", now, from: "2026-08-01", to: "2026-09-30" })).toEqual({ error: "at most 336 hours per report" });
  });
});

describe("distribution", () => {
  it("median of the middle pair, p90 by nearest rank", () => {
    expect(distribution([])).toEqual({ n: 0, median: null, p90: null });
    expect(distribution([5])).toEqual({ n: 1, median: 5, p90: 5 });
    expect(distribution([4, 1, 3, 2])).toEqual({ n: 4, median: 2.5, p90: 4 });
    expect(distribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ n: 10, median: 5.5, p90: 9 });
    expect(distribution([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110])).toMatchObject({ median: 60, p90: 100 });
  });
});
