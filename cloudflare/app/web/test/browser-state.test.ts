import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBrowserScope, browserCanStart, browserCaptureMessage, browserSessionLabel, browserDestination, mergeBrowserRuns, needsBrowserRefresh, type VisibleBrowserRun } from "../src/browser-state.ts";
import type { BudgetView } from "../../src/budget-types.ts";
const run = { runId: "a", organizationId: "org", workspaceId: "ws", generation: 1, createdAt: 1, updatedAt: 2, status: "running", cleanupStatus: "pending", canApprove: false, canCancel: true } as VisibleBrowserRun;
test("browser authorization contains the initial host and only exact public host names", () => {
  assert.deepEqual(browserDestination("https://example.com/path", "cdn.example.com\nEXAMPLE.COM"), { initialUrl: "https://example.com/path", allowedHosts: ["example.com", "cdn.example.com"] });
  for (const url of ["http://example.com", "https://user:pass@example.com", "https://127.0.0.1", "https://localhost", "https://[::1]", "https://example.com:8443"]) assert.throws(() => browserDestination(url, ""));
  for (const hosts of ["*.example.com", "https://example.com", "example.com/path", "127.0.0.1", "foo.local"]) assert.throws(() => browserDestination("https://example.com", hosts));
});
test("late browser polling cannot restore canceled work or reverse confirmed cleanup", () => {
  const canceled = { ...run, generation: 2, status: "canceled" as const, updatedAt: 3, canCancel: false };
  assert.deepEqual(mergeBrowserRuns([canceled], [run]), [canceled]);
  const closed = { ...canceled, cleanupStatus: "closed" as const };
  assert.deepEqual(mergeBrowserRuns([closed], [canceled]), [closed]);
  assert.equal(needsBrowserRefresh(canceled), true);
  assert.equal(needsBrowserRefresh(closed), false);
});
test("browser records from another company or workspace are rejected", () => {
  assert.deepEqual(assertBrowserScope([run], "org", "ws"), [run]);
  assert.throws(() => assertBrowserScope([run], "another", "ws"));
  assert.throws(() => assertBrowserScope([run], "org", "another"));
});
test("finished browser work does not promise a future screenshot", () => {
  for (const status of ["completed", "failed", "canceled", "interrupted"] as const) {
    assert.equal(browserCaptureMessage({ ...run, status }), "Nenhuma captura foi registrada nesta tarefa.");
  }
  assert.match(browserCaptureMessage({ ...run, status: "pending_approval" }), /aprovação/);
  assert.match(browserCaptureMessage({ ...run, status: "running" }), /primeira captura/);
});
test("canceling before approval never claims that a browser session ran", () => {
  assert.equal(browserSessionLabel({ ...run, status: "canceled", approvedAt: undefined, cleanupStatus: "closed" }), "Não iniciada");
  assert.equal(browserSessionLabel({ ...run, status: "canceled", approvedAt: 1, cleanupStatus: "pending" }), "Encerramento pendente");
  assert.equal(browserSessionLabel({ ...run, status: "completed", approvedAt: 1, cleanupStatus: "closed" }), "Encerrada");
});
test("browser vision is unavailable until its own billing adapter is qualified", () => {
  assert.equal(browserCanStart(null), false);
  assert.equal(browserCanStart({ enforcement: { required: true, paidApiAvailable: true } } as BudgetView), false);
  assert.equal(browserCanStart({ enforcement: { required: true, paidApiAvailable: false } } as BudgetView), false);
  assert.equal(browserCanStart({ enforcement: { required: false, paidApiAvailable: true } } as BudgetView), true);
});
