import assert from "node:assert/strict";
import { test } from "node:test";
import { boardColumn, filterBoardRuns } from "../src/kanban-state.ts";
import type { VisibleCodingRun } from "../src/coding-state.ts";

const run = { runId: "one", status: "running", task: "Corrigir validação", repositoryName: "owner/repo", agents: [{ role: "programmer", name: "Engenheiro" }] } as VisibleCodingRun;

test("a PR receipt never makes a failed or canceled task look completed", () => {
  for (const status of ["failed", "canceled", "interrupted"] as const) {
    assert.equal(boardColumn({ ...run, status, result: { prNumber: 4 } as VisibleCodingRun["result"] }), "attention");
  }
  assert.equal(boardColumn({ ...run, status: "completed" }), "completed");
});

test("review is separate from programming and actual test execution", () => {
  assert.equal(boardColumn({ ...run, agentStage: "reviewer" }), "review");
  assert.equal(boardColumn({ ...run, agentStage: "reviewer", status: "testing" }), "working");
  assert.equal(boardColumn({ ...run, status: "pending_approval" }), "approval");
  assert.equal(boardColumn({ ...run, status: "queued" }), "queued");
});

test("combined filters search accents and respect exact repository and agent", () => {
  const runs = [run, { ...run, runId: "two", repositoryName: "owner/other" }];
  assert.deepEqual(filterBoardRuns(runs, { query: "VALIDACAO", repository: "owner/repo", agent: "Engenheiro" }), [run]);
  assert.deepEqual(filterBoardRuns(runs, { query: "", repository: "", agent: "Outro" }), []);
});
