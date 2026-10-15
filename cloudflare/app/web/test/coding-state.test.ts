import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCodingRuns, needsCodingRefresh, safeGithubAuthorizationUrl, safePullRequestUrl, testOutcome, type VisibleCodingRun } from "../src/coding-state.ts";

const run: VisibleCodingRun = {
  runId: "run-a", organizationId: "company-a", workspaceId: "workspace-a", generation: 1,
  requestId: "request-a", repositoryConnectionId: "repo-a", repositoryName: "owner/repo", baseRef: "main",
  task: "Fix the failing validation", provider: "openai", model: "chosen-model", setupCommand: "", testCommand: "npm test",
  createdBy: "user-a", credentialVersion: 1, createdAt: 100, updatedAt: 110, deadlineAt: 1000,
  status: "running", modelCalls: 1, tokens: 10, events: [], canApprove: false, canCancel: true,
};

test("late polling cannot replace a canceled coding task or restore its permissions", () => {
  const canceled: VisibleCodingRun = { ...run, generation: 2, updatedAt: 120, status: "canceled", canCancel: false };
  assert.deepEqual(mergeCodingRuns([canceled], [run]), [canceled]);
});

test("recent cancellation keeps refreshing for a delayed publication receipt, with a bounded settling period", () => {
  const canceled: VisibleCodingRun = { ...run, generation: 2, updatedAt: 120, status: "canceled", canCancel: false };
  assert.equal(needsCodingRefresh(canceled, 30_120), true);
  assert.equal(needsCodingRefresh(canceled, 60_120), false);
  assert.equal(needsCodingRefresh({ ...canceled, error: "coding_publication_uncertain" }, 130), false);
  const reconciled: VisibleCodingRun = { ...canceled, updatedAt: 140,
    result: { branch: "veltram/run-a", commitSha: "sha", prUrl: "https://github.com/owner/repo/pull/1", prNumber: 1, changedFiles: 1 } };
  assert.equal(needsCodingRefresh(reconciled, 150), false);
  assert.deepEqual(mergeCodingRuns([canceled], [reconciled]), [reconciled]);
  assert.deepEqual(mergeCodingRuns([reconciled], [canceled]), [reconciled]);
});

test("same-millisecond polling preserves the PR receipt and final test result", () => {
  const completed: VisibleCodingRun = { ...run, status: "completed", canCancel: false,
    verification: { command: "npm test", exitCode: 0, treeDigest: "digest", output: "1 passed", finishedAt: 110, truncated: false },
    result: { branch: "veltram/run-a", commitSha: "sha", prUrl: "https://github.com/owner/repo/pull/1", prNumber: 1, changedFiles: 1 } };
  const [visible] = mergeCodingRuns([completed], [run]);
  assert.equal(visible.status, "completed");
  assert.deepEqual(visible.verification, completed.verification);
  assert.deepEqual(visible.result, completed.result);
});

test("new permissions take effect and an earlier listing cannot drop a newly created task", () => {
  const pending: VisibleCodingRun = { ...run, status: "pending_approval", canApprove: true };
  assert.equal(mergeCodingRuns([pending], [{ ...pending, canApprove: false }])[0].canApprove, false);
  assert.deepEqual(mergeCodingRuns([pending], []), [pending]);
});

test("model text and completion alone never imply passing tests", () => {
  assert.equal(testOutcome({ ...run, status: "completed", summary: "All tests passed" }), "not_run");
  const verification = { command: "npm test", exitCode: 1, treeDigest: "digest", output: "failed", finishedAt: 110, truncated: false };
  assert.equal(testOutcome({ ...run, verification }), "failed");
  assert.equal(testOutcome({ ...run, verification: { ...verification, exitCode: 0 } }), "passed");
});

test("PR links must identify this repository on GitHub", () => {
  assert.equal(safePullRequestUrl("https://github.com/owner/repo/pull/12", "owner/repo"), "https://github.com/owner/repo/pull/12");
  for (const url of ["javascript:alert(1)", "https://github.com.evil.test/owner/repo/pull/12", "https://github.com/other/repo/pull/12", "https://evil@github.com/owner/repo/pull/12", "https://github.com/owner/repo/pull/12?redirect=elsewhere"]) {
    assert.equal(safePullRequestUrl(url, "owner/repo"), null);
  }
});

test("connect accepts GitHub OAuth or installation pages, never arbitrary redirects", () => {
  assert.ok(safeGithubAuthorizationUrl("https://github.com/login/oauth/authorize?client_id=app&state=nonce"));
  assert.ok(safeGithubAuthorizationUrl("https://github.com/apps/veltram/installations/new"));
  for (const url of ["https://github.com/owner/repo", "http://github.com/login/oauth/authorize", "https://github.com.evil.test/login/oauth/authorize", "https://evil@github.com/login/oauth/authorize", "//github.com/login/oauth/authorize"]) {
    assert.equal(safeGithubAuthorizationUrl(url), null);
  }
});
