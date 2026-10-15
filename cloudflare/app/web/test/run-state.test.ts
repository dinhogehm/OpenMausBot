import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRuns, validateRunScope, type VisibleRun } from "../src/run-state.ts";

const running: VisibleRun = {
  id: "run-a", organizationId: "company-a", workspaceId: "workspace-a",
  input: { message: "A real receipt", delayMs: 0 }, generation: 1,
  status: "running", createdAt: 100, updatedAt: 110, leaseExpiresAt: 60110,
  canApprove: false, canCancel: true,
};

test("late polling cannot undo a cancellation already acknowledged to the user", () => {
  const cancelled: VisibleRun = { ...running, status: "cancelled", generation: 2, updatedAt: 120, leaseExpiresAt: null, canCancel: false };
  const [visible] = mergeRuns([cancelled], [running]);
  assert.equal(visible.status, "cancelled");
  assert.equal(visible.canCancel, false);
});

test("same-millisecond polling cannot hide a completed receipt", () => {
  const completed: VisibleRun = { ...running, status: "succeeded", leaseExpiresAt: null, canCancel: false, result: { stdout: "done", artifact: "done", exitCode: 0 } };
  const [visible] = mergeRuns([completed], [running]);
  assert.equal(visible.status, "succeeded");
  assert.deepEqual(visible.result, completed.result);
});

test("refreshed permissions take effect without a run state change", () => {
  const pending: VisibleRun = { ...running, status: "waiting_approval", generation: 0, canApprove: true };
  const [visible] = mergeRuns([pending], [{ ...pending, canApprove: false, canCancel: false }]);
  assert.equal(visible.canApprove, false);
  assert.equal(visible.canCancel, false);
});

test("an initial listing dispatched before creation does not drop the new receipt", () => {
  const visible = mergeRuns([running], []);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, running.id);
});

test("execution responses from another company or workspace never enter the UI", () => {
  assert.throws(() => validateRunScope([running], "company-b", "workspace-a"), /Unexpected response scope/);
  assert.throws(() => validateRunScope([running], "company-a", "workspace-b"), /Unexpected response scope/);
  assert.deepEqual(validateRunScope([running], "company-a", "workspace-a"), [running]);
});
