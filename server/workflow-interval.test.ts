// Interval occurrence math. Every instant is built from local wall-clock
// parts, so the assertions hold in whatever timezone the suite runs in.
import { describe, expect, it } from "vitest";

import { intervalFireAt, nextActiveWindowStart, withinActiveHours } from "./workflow-interval.ts";

const MIN = 60_000;
/** September 2026: the 7th is a Monday. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const MON = 7;
const FRI = 11;
const SAT = 12;

describe("withinActiveHours", () => {
  it("is always inside when there is no window", () => {
    expect(withinActiveHours(undefined, at(MON, 3))).toBe(true);
  });

  it("treats the window as start-inclusive, end-exclusive", () => {
    const window = { start: "09:00", end: "18:00" };
    expect(withinActiveHours(window, at(MON, 8, 59))).toBe(false);
    expect(withinActiveHours(window, at(MON, 9))).toBe(true);
    expect(withinActiveHours(window, at(MON, 17, 59))).toBe(true);
    expect(withinActiveHours(window, at(MON, 18))).toBe(false);
  });

  it("wraps past midnight when start is after end", () => {
    const window = { start: "22:00", end: "06:00" };
    expect(withinActiveHours(window, at(MON, 23))).toBe(true);
    expect(withinActiveHours(window, at(MON, 2))).toBe(true);
    expect(withinActiveHours(window, at(MON, 6))).toBe(false);
    expect(withinActiveHours(window, at(MON, 12))).toBe(false);
  });

  it("applies the weekday list to the instant's own day", () => {
    const window = { start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] };
    expect(withinActiveHours(window, at(FRI, 10))).toBe(true);
    expect(withinActiveHours(window, at(SAT, 10))).toBe(false);
  });
});

describe("nextActiveWindowStart", () => {
  it("returns the instant itself when it is already inside", () => {
    expect(nextActiveWindowStart({ start: "09:00", end: "18:00" }, at(MON, 10))).toBe(at(MON, 10));
    expect(nextActiveWindowStart(undefined, at(MON, 10))).toBe(at(MON, 10));
  });

  it("moves an early instant to today's start and a late one to tomorrow's", () => {
    const window = { start: "09:00", end: "18:00" };
    expect(nextActiveWindowStart(window, at(MON, 7))).toBe(at(MON, 9));
    expect(nextActiveWindowStart(window, at(MON, 19))).toBe(at(MON + 1, 9));
  });

  it("skips days the weekday list excludes", () => {
    const window = { start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] };
    expect(nextActiveWindowStart(window, at(FRI, 19))).toBe(at(MON + 7, 9));
    expect(nextActiveWindowStart(window, at(SAT, 10))).toBe(at(MON + 7, 9));
  });

  it("for a wrap-around window, the next start can be tonight's start or the coming midnight", () => {
    const window = { start: "22:00", end: "06:00", weekdays: [1, 2] };
    // Monday noon: the window opens at 22:00 tonight.
    expect(nextActiveWindowStart(window, at(MON, 12))).toBe(at(MON, 22));
    // Wednesday (excluded) at 23:00: the next allowed instant is Monday's
    // midnight segment — Monday is allowed and 00:00 is inside the wrap.
    expect(nextActiveWindowStart(window, at(MON + 2, 23))).toBe(at(MON + 7, 0));
    // Tuesday 07:00 (allowed day, after the window): Tuesday 22:00.
    expect(nextActiveWindowStart(window, at(MON + 1, 7))).toBe(at(MON + 1, 22));
  });

  it("is null only when no weekday is allowed", () => {
    expect(nextActiveWindowStart({ start: "09:00", end: "18:00", weekdays: [] }, at(MON, 10))).toBeNull();
  });
});

describe("intervalFireAt", () => {
  it("is the idle instant plus the interval, in the past if that is where it lands", () => {
    expect(intervalFireAt({ type: "interval", minutes: 30 }, at(MON, 10))).toBe(at(MON, 10, 30));
    const stale = at(MON, 10) - 3 * 24 * 60 * MIN;
    expect(intervalFireAt({ type: "interval", minutes: 30 }, stale)).toBe(stale + 30 * MIN);
  });

  it("lands an out-of-window due instant on the next window start", () => {
    const schedule = { type: "interval" as const, minutes: 60, activeHours: { start: "09:00", end: "18:00" } };
    expect(intervalFireAt(schedule, at(MON, 17, 30))).toBe(at(MON + 1, 9));
    expect(intervalFireAt(schedule, at(MON, 16))).toBe(at(MON, 17));
  });

  it("is null for a non-finite anchor", () => {
    expect(intervalFireAt({ type: "interval", minutes: 30 }, Number.NaN)).toBeNull();
  });
});
