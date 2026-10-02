// São Paulo calendar and statistics behind the productivity report (lot V).
import { describe, expect, it } from "vitest";
import {
  bucketKey, bucketStart, bucketStarts, distribution, nextBucket, parseReportBound, presetPeriod, previousPeriod, resolveReportPeriod,
  zonedParts, zonedToUtc,
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
