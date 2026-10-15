import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReportScope, reportComparison, reportDateInput, reportDuration, reportNumber, reportPercent, safeReportPr, validReportRange } from "../src/report-state.ts";
import type { ExecutionReport } from "../../src/report-types.ts";

test("unknown report data never formats as zero, while an observed zero remains visible", () => {
  for (const value of [null, undefined]) {
    assert.equal(reportNumber(value), "Não acompanhado");
    assert.equal(reportPercent(value), "Não acompanhado");
    assert.equal(reportDuration(value), "Não acompanhado");
  }
  assert.equal(reportNumber(0), "0"); assert.equal(reportPercent(0), "0%");
  assert.equal(reportDuration(90_000), "1,5 min");
});

test("report comparison distinguishes relative changes, points and unavailable baselines", () => {
  const comparison = { kind: "trend" as const, previous: 10, delta: 5, ratio: .5 };
  assert.equal(reportComparison(comparison), "+50% sobre o anterior");
  assert.equal(reportComparison({ ...comparison, previous: .8, delta: .1, ratio: .125 }, true), "+10 p.p. sobre o anterior");
  assert.equal(reportComparison({ kind: "none", previous: null, delta: null, ratio: null }), "Comparação indisponível");
  assert.equal(reportComparison({ kind: "absolute", previous: 2, delta: null, ratio: null }), "Anterior: 2 · base pequena");
});

test("date ranges reject normalized invalid dates and use Brasilia calendar days", () => {
  assert.equal(validReportRange("2026-02-30", "2026-03-01"), false);
  assert.equal(validReportRange("2026-10-20", "2026-10-01"), false);
  assert.equal(validReportRange("2026-10-01", "2026-10-01"), true);
  assert.equal(reportDateInput(Date.parse("2026-10-15T01:00:00Z")), "2026-10-14");
});

test("report scope rejects a response from a different company or workspace", () => {
  const report = { organizationId: "org-a", workspaceId: "ws-a" } as ExecutionReport;
  assert.equal(assertReportScope(report, "org-a", "ws-a"), report);
  assert.throws(() => assertReportScope(report, "org-b", "ws-a"));
  assert.throws(() => assertReportScope(report, "org-a", "ws-b"));
});

test("PR evidence links stay on the recorded GitHub repository", () => {
  assert.equal(safeReportPr("https://github.com/owner/repo/pull/9", "owner/repo"), "https://github.com/owner/repo/pull/9");
  for (const url of ["javascript:alert(1)", "https://github.com/other/repo/pull/9", "https://evil@github.com/owner/repo/pull/9", "https://github.com/owner/repo/pull/9?redirect=evil"]) assert.equal(safeReportPr(url, "owner/repo"), null);
});
