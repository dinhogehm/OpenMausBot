import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveReportQuery, reportCoverage, compareReportMetric } from "../src/report-period.ts";

const now = Date.parse("2026-10-14T15:00:00Z"); // noon in São Paulo
test("presets use São Paulo calendar boundaries and the same elapsed span for comparison", () => {
  const day = resolveReportQuery(new URLSearchParams("period=day"), now);
  assert.equal(new Date(day.period.from).toISOString(), "2026-10-14T03:00:00.000Z");
  assert.equal(new Date(day.period.to).toISOString(), "2026-10-15T03:00:00.000Z");
  assert.equal(day.previousComparedUntil - day.previous.from, 12 * 3_600_000);
  assert.equal(day.comparedUntil, now);
  const week = resolveReportQuery(new URLSearchParams("period=week"), now);
  assert.equal(new Date(week.period.from).toISOString(), "2026-10-08T03:00:00.000Z");
  assert.equal(week.previous.to, week.period.from);
});
test("custom dates include the final calendar day and reject invalid or excessive ranges", () => {
  const resolved = resolveReportQuery(new URLSearchParams("period=custom&from=2026-09-01&to=2026-09-30"), now);
  assert.equal(new Date(resolved.period.to).toISOString(), "2026-10-01T03:00:00.000Z");
  assert.equal(resolved.previousComparedUntil, resolved.previous.to);
  for (const value of ["period=custom&from=2026-02-30&to=2026-03-02", "period=custom&from=2024-01-01&to=2026-10-01", "period=custom&from=2026-10-15&to=2026-10-16", "period=nope", "period=day&agentId=../other"]) {
    assert.throws(() => resolveReportQuery(new URLSearchParams(value), now), /invalid_report_query/);
  }
});
test("coverage and comparisons preserve unknown periods and avoid percentages on small bases", () => {
  assert.equal(reportCoverage(null, 100, 200), "none");
  assert.equal(reportCoverage(150, 100, 200), "partial");
  assert.equal(reportCoverage(100, 100, 200), "full");
  assert.equal(compareReportMetric(12, 10, "full", "none").kind, "none");
  assert.equal(compareReportMetric(4, 2, "full", "full").kind, "absolute");
  assert.equal(compareReportMetric(12, 10, "full", "full").ratio, 0.2);
});

test("preserves the longer OMB windows, closed month and bounded hourly/daily/monthly grouping", () => {
  const hours = resolveReportQuery(new URLSearchParams("period=48h"), now);
  assert.equal(hours.period.to - hours.period.from, 48 * 3_600_000);
  assert.equal(hours.granularity, "hour");
  const quarter = resolveReportQuery(new URLSearchParams("period=90d"), now);
  assert.equal(quarter.period.to - quarter.period.from, 90 * 86_400_000);
  const year = resolveReportQuery(new URLSearchParams("period=12m"), now);
  assert.equal(year.granularity, "month");
  assert.equal(new Date(year.period.from).toISOString(), "2025-11-01T03:00:00.000Z");
  assert.equal(new Date(year.previous.from).toISOString(), "2024-11-01T03:00:00.000Z");
  const closed = resolveReportQuery(new URLSearchParams("period=previous_month"), now);
  assert.equal(new Date(closed.period.from).toISOString(), "2026-09-01T03:00:00.000Z");
  assert.equal(new Date(closed.previous.from).toISOString(), "2026-08-01T03:00:00.000Z");
  assert.throws(() => resolveReportQuery(new URLSearchParams("period=90d&granularity=hour"), now), /invalid_report_query/);
});
