import assert from "node:assert/strict";
import test from "node:test";
import { approveRun, cancelRun, completeRun, createRun, failRun, interruptRun, retryRun, } from "../src/execution.ts";
import type { RunRecord, RunStatus } from "../src/execution.ts";
const start = 1000;
const result = { stdout: "hello\n", artifact: "hello", exitCode: 0 };

function record(status: RunStatus = "waiting_approval"): RunRecord {
  return {
    id: "run-1",
    organizationId: "org_1",
    workspaceId: "workspace_1",
    input: { message: "hello", delayMs: 0 },
    generation: status === "running" ? 1 : 0,
    status,
    createdAt: start,
    updatedAt: start,
    leaseExpiresAt: status === "running" ? start + 60000 : null,
  };
}

test("new runs wait for explicit approval without a lease", () => {
  assert.deepEqual(createRun("run-1", "org_1", "workspace_1", { message: "hello", delayMs: 0 }, start), record());
});

test("invalid Unicode and fractional delays are rejected before approval", () => {
  assert.throws(() => createRun("run-1", "org_1", "workspace_1", { message: "\ud800", delayMs: 0 }, start));
  assert.throws(() => createRun("run-1", "org_1", "workspace_1", { message: "hello", delayMs: 0.5 }, start));
});

test("approval starts a fresh generation with a bounded lease", () => {
  const approved = approveRun(record(), start + 10);
  assert.equal(approved.status, "running");
  assert.equal(approved.generation, 1);
  assert.equal(approved.leaseExpiresAt, start + 60010);
  assert.equal(approved.updatedAt, start + 10);
});

test("double approval is rejected", () => {
  assert.throws(() => approveRun(record("running"), start + 10), /approv.*running/i);
});

test("cancellation invalidates the running generation and rejects a delayed completion", () => {
  const running = record("running");
  const cancelled = cancelRun(running, start + 10);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.generation, running.generation + 1);
  assert.equal(cancelled.leaseExpiresAt, null);
  assert.deepEqual(completeRun(cancelled, running.generation, result, start + 20), cancelled);
  assert.deepEqual(failRun(cancelled, running.generation, "late failure", start + 20), cancelled);
});

test("cancellation also invalidates pending approval", () => {
  const cancelled = cancelRun(record(), start + 10);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.generation, 1);
  assert.throws(() => approveRun(cancelled, start + 20), /approv.*cancelled/i);
});

test("terminal cancellation is idempotent", () => {
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    const terminal = record(status);
    assert.deepEqual(cancelRun(terminal, start + 10), terminal);
  }
});

test("only a current generation may complete", () => {
  const running = record("running");
  assert.deepEqual(completeRun(running, 0, result, start + 10), running);
  assert.deepEqual(failRun(running, 0, "old error", start + 10), running);
  const finished = completeRun(running, 1, result, start + 10);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.result, result);
  assert.equal(finished.leaseExpiresAt, null);
  assert.equal(finished.updatedAt, start + 10);
});

test("callbacks at or after lease expiry cannot overwrite a running run", () => {
  const running = record("running");
  for (const now of [start + 60000, start + 60001]) {
    assert.deepEqual(completeRun(running, 1, result, now), running);
    assert.deepEqual(failRun(running, 1, "timeout", now), running);
  }
});

test("a nonzero exit code becomes a failed run", () => {
  const failed = completeRun(record("running"), 1, { ...result, exitCode: 2 }, start + 10);
  assert.equal(failed.status, "failed");
  assert.equal(failed.result?.exitCode, 2);
  assert.equal(failed.leaseExpiresAt, null);
});

test("infrastructure failures persist a safe message instead of the raw error", () => {
  const failed = failRun(record("running"), 1, "API secret=fixture-secret at internal.host", start + 10);
  assert.equal(failed.status, "failed");
  assert.equal(failed.leaseExpiresAt, null);
  assert.ok(failed.error);
  assert.doesNotMatch(failed.error, /fixture-secret|internal\.host|API/);
});

test("interruption invalidates the generation and clears its lease", () => {
  const running = record("running");
  const interrupted = interruptRun(running, start + 10);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.generation, 2);
  assert.equal(interrupted.leaseExpiresAt, null);
  assert.deepEqual(completeRun(interrupted, 1, result, start + 20), interrupted);
});

test("retry requires approval again and never accepts callbacks from the previous attempt", () => {
  const interrupted = interruptRun(record("running"), start + 10);
  const waiting = retryRun(interrupted, start + 20);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.leaseExpiresAt, null);
  assert.deepEqual(completeRun(waiting, 1, result, start + 30), waiting);
  const approved = approveRun(waiting, start + 40);
  assert.equal(approved.generation, 3);
  assert.deepEqual(completeRun(approved, 1, result, start + 50), approved);
  assert.equal(completeRun(approved, 3, result, start + 50).status, "succeeded");
});

test("retry clears prior failure and result evidence before a new approval", () => {
  const failed = { ...record("failed"), generation: 1, result, error: "Execution failed" };
  const waiting = retryRun(failed, start + 10);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.generation, 1);
  assert.equal(waiting.result, undefined);
  assert.equal(waiting.error, undefined);
});

test("invalid interrupt, retry and approval transitions fail descriptively", () => {
  for (const status of ["waiting_approval", "succeeded", "failed", "cancelled", "interrupted"] as const) {
    assert.throws(() => interruptRun(record(status), start + 10), new RegExp(`interrupt.*${status}`, "i"));
  }
  for (const status of ["waiting_approval", "running", "succeeded", "cancelled"] as const) {
    assert.throws(() => retryRun(record(status), start + 10), new RegExp(`retry.*${status}`, "i"));
  }
  for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
    assert.throws(() => approveRun(record(status), start + 10), new RegExp(`approv.*${status}`, "i"));
  }
});

test("state transitions do not mutate their input records or payloads", () => {
  const initial = record();
  Object.freeze(initial.input);
  Object.freeze(initial);
  const approved = approveRun(initial, start + 10);
  Object.freeze(approved);
  const originalResult = { ...result };
  Object.freeze(originalResult);
  const finished = completeRun(approved, 1, originalResult, start + 20);
  assert.deepEqual(initial, record());
  assert.equal(approved.status, "running");
  assert.notEqual(approved, initial);
  assert.notEqual(finished, approved);
  assert.notEqual(finished.result, originalResult);
});

test("creating a run copies the approved input", () => {
  const input = { message: "original", delayMs: 0 };
  const created = createRun("run", "org", "workspace", input, start);
  input.message = "changed";
  assert.equal(created?.input.message, "original");
});

test("run, organization and workspace identifiers accept only bounded ASCII identifiers", () => {
  for (const invalid of ["", "a".repeat(81), "has space", "../other", "\u00E9", "x\n", 1, null]) {
    assert.throws(() => createRun(invalid as string, "org", "workspace", { message: "ok", delayMs: 0 }, start), /id/i);
    assert.throws(() => createRun("run", invalid as string, "workspace", { message: "ok", delayMs: 0 }, start), /organization/i);
    assert.throws(() => createRun("run", "org", invalid as string, { message: "ok", delayMs: 0 }, start), /workspace/i);
  }
  assert.equal(createRun("a".repeat(80), "org-1", "Z_9-a", { message: "ok", delayMs: 0 }, start)?.id.length, 80);
});

test("proof input rejects empty, excessive or wrongly typed messages and delays", () => {
  for (const message of ["", "  \n ", "a".repeat(1001), null, 123]) {
    assert.throws(() => createRun("run", "org", "workspace", { message: message as string, delayMs: 0 }, start), /message/i);
  }
  for (const delayMs of [-1, 30001, Infinity, NaN, "0", null]) {
    assert.throws(() => createRun("run", "org", "workspace", { message: "ok", delayMs: delayMs as number }, start), /delay/i);
  }
  assert.equal(createRun("run", "org", "workspace", { message: "a".repeat(1000), delayMs: 30000 }, start)?.input.delayMs, 30000);
});

test("all transition timestamps must be finite numbers", () => {
  for (const now of [NaN, Infinity, -Infinity, "1000", null]) {
    const value = now as number;
    assert.throws(() => createRun("run", "org", "workspace", { message: "ok", delayMs: 0 }, value), /timestamp/i);
    assert.throws(() => approveRun(record(), value), /timestamp/i);
    assert.throws(() => cancelRun(record(), value), /timestamp/i);
    assert.throws(() => completeRun(record("running"), 1, result, value), /timestamp/i);
    assert.throws(() => failRun(record("running"), 1, "failed", value), /timestamp/i);
    assert.throws(() => interruptRun(record("running"), value), /timestamp/i);
    assert.throws(() => retryRun(record("interrupted"), value), /timestamp/i);
  }
});

test("completed stdout and artifacts each have a 16 KiB UTF-8 limit", () => {
  const running = record("running");
  for (const field of ["stdout", "artifact"] as const) {
    const atLimit = { ...result, [field]: "\u00E9".repeat(8192) };
    assert.equal(completeRun(running, 1, atLimit, start + 10).result?.[field], atLimit[field]);
    for (const invalid of ["a".repeat(16385), "\u00E9".repeat(8193), null, 12]) {
      assert.throws(() => completeRun(running, 1, { ...result, [field]: invalid } as typeof result, start + 10), new RegExp(field, "i"));
    }
  }
});

test("completion rejects invalid exit codes", () => {
  for (const exitCode of [NaN, Infinity, 1.5, "0", null]) {
    assert.throws(() => completeRun(record("running"), 1, { ...result, exitCode: exitCode as number }, start + 10), /exit.*code/i);
  }
});

test("organization, workspace and run identities remain unchanged through every transition", () => {
  const initial = createRun("run", "organization_A", "workspace_B", { message: "ok", delayMs: 0 }, start);
  const approved = approveRun(initial, start + 10);
  const interrupted = interruptRun(approved, start + 20);
  const retried = retryRun(interrupted, start + 30);
  const succeeded = completeRun(approved, 1, result, start + 20);
  const failed = failRun(approved, 1, "not persisted", start + 20);
  const cancelled = cancelRun(approved, start + 20);
  for (const next of [initial, approved, interrupted, retried, succeeded, failed, cancelled, cancelRun(cancelled, start + 30)]) {
    assert.equal(next.id, "run");
    assert.equal(next.organizationId, "organization_A");
    assert.equal(next.workspaceId, "workspace_B");
    assert.equal(next.createdAt, start);
  }
});
