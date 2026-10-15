import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeMissions, missionNeedsRefresh, safeMissionPr, type VisibleMission } from "../src/mission-state.ts";

const mission = { missionId: "one", organizationId: "company", workspaceId: "workspace", version: 4, createdAt: 1, status: "paused", tasks: [], nextWakeAt: 100 } as unknown as VisibleMission;

test("a late poll cannot undo a newer pause, cancel, or publication uncertainty", () => {
  for (const status of ["paused", "canceled", "interrupted"] as const) {
    const current = { ...mission, status };
    assert.deepEqual(mergeMissions([current], [{ ...mission, version: 3, status: "active" }], "company", "workspace"), [current]);
  }
  assert.throws(() => mergeMissions([mission], [{ ...mission, organizationId: "another" }], "company", "workspace"), /mission_scope_changed/);
  assert.throws(() => mergeMissions([mission], [{ ...mission, workspaceId: "another" }], "company", "workspace"), /mission_scope_changed/);
});

test("only scheduled observations keep polling; a PR awaiting publication stays unresolved", () => {
  assert.equal(missionNeedsRefresh({ ...mission, status: "paused_budget" }), true);
  assert.equal(missionNeedsRefresh({ ...mission, status: "paused", nextWakeAt: undefined }), false);
  assert.equal(missionNeedsRefresh({ ...mission, status: "awaiting_delivery" }), false);
  assert.equal(missionNeedsRefresh({ ...mission, status: "interrupted" }), false);
});

test("PR receipts cannot turn arbitrary or credentialed URLs into navigable links", () => {
  assert.equal(safeMissionPr("https://github.com/example/project/pull/12"), "https://github.com/example/project/pull/12");
  for (const value of ["javascript:alert(1)", "https://github.com.evil.invalid/example/project/pull/12", "https://user@github.com/example/project/pull/12", "https://github.com/example/project/pull/12?redirect=elsewhere", "https://github.com/example/project/issues/12"]) assert.equal(safeMissionPr(value), null);
});
