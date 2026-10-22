import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createRoutineWakeHold, rememberRoutineWake, routineWakeDecision, routineWakeSettings } from "./routine-wake.mjs";

test("the hold is on only when enabled, plugged in, and the server says a routine is due or running", () => {
  const due = { hold: true, reason: "due", at: 1_700_000_000_000 };
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: due }), { hold: true, reason: "due", at: 1_700_000_000_000 });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: { hold: true, reason: "running" } }), { hold: true, reason: "running", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: { hold: false } }), { hold: false, reason: "idle", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: null }), { hold: false, reason: "idle", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: true, status: due }), { hold: false, reason: "battery", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: false, onBattery: false, status: due }), { hold: false, reason: "off", at: null });
});

test("the toggle is on until switched off, and survives a reread", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-routine-wake-"));
  try {
    assert.deepEqual(routineWakeSettings(dir), { keepAwake: true });
    rememberRoutineWake(dir, false);
    assert.deepEqual(routineWakeSettings(dir), { keepAwake: false });
    rememberRoutineWake(dir, true);
    assert.deepEqual(routineWakeSettings(dir), { keepAwake: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one assertion is taken while a hold is warranted and released when it is not, or on stop", async () => {
  const calls = [];
  let nextId = 1;
  const started = new Set();
  const blocker = {
    start(type) { const id = nextId++; started.add(id); calls.push(["start", type, id]); return id; },
    stop(id) { started.delete(id); calls.push(["stop", id]); },
    isStarted: (id) => started.has(id),
  };
  let status = { hold: true, reason: "due", at: 42 };
  let onBattery = false;
  let keepAwake = true;
  const hold = createRoutineWakeHold({
    fetchStatus: async () => status,
    isOnBattery: () => onBattery,
    blocker,
    settings: () => ({ keepAwake }),
    log() {},
    pollMs: 60_000,
  });

  assert.deepEqual(await hold.poll(), { hold: true, reason: "due", at: 42, keepAwake: true, onBattery: false });
  assert.equal(hold.holding(), true);
  await hold.poll();
  assert.deepEqual(calls, [["start", "prevent-app-suspension", 1]]);

  onBattery = true;
  assert.equal((await hold.poll()).reason, "battery");
  assert.equal(hold.holding(), false);
  onBattery = false;
  await hold.poll();
  assert.equal(hold.holding(), true);

  status = null;
  assert.equal((await hold.poll()).reason, "idle");
  assert.equal(hold.holding(), false);
  status = { hold: true, reason: "running" };
  keepAwake = false;
  assert.equal((await hold.poll()).reason, "off");
  assert.equal(hold.holding(), false);

  keepAwake = true;
  await hold.poll();
  assert.equal(hold.holding(), true);
  hold.stop();
  assert.equal(hold.holding(), false);
  assert.deepEqual(calls.at(-1), ["stop", 3]);
});

function pendingWakeFixture() {
  const pending = [];
  const active = new Set();
  const calls = [];
  let nextId = 1;
  const hold = createRoutineWakeHold({
    fetchStatus: () => new Promise((resolve) => pending.push(resolve)),
    isOnBattery: () => false,
    settings: () => ({ keepAwake: true }),
    blocker: {
      start(type) {
        const id = nextId++;
        active.add(id);
        calls.push(["start", type, id]);
        return id;
      },
      stop(id) { active.delete(id); calls.push(["stop", id]); },
      isStarted: (id) => active.has(id),
    },
  });
  return { hold, pending, calls, active };
}

test("a status requested before stop cannot reacquire the power assertion when it resolves late", async () => {
  const f = pendingWakeFixture();
  const request = f.hold.poll();
  await Promise.resolve();
  f.hold.stop();
  assert.equal(f.hold.holding(), false);

  f.pending[0]({ hold: true, reason: "running" });
  await request;
  assert.equal(f.hold.holding(), false);
  assert.equal(f.active.size, 0);
  assert.deepEqual(f.calls, []);
  assert.equal(f.hold.state().reason, "stopped");
});

test("an obsolete idle status cannot release the hold established by a newer running status", async () => {
  const f = pendingWakeFixture();
  const older = f.hold.poll();
  const newer = f.hold.poll();
  await Promise.resolve();

  f.pending[1]({ hold: true, reason: "running" });
  await newer;
  assert.equal(f.hold.holding(), true);
  f.pending[0]({ hold: false });
  await older;

  assert.equal(f.hold.holding(), true);
  assert.equal(f.hold.state().reason, "running");
  assert.equal(f.active.size, 1);
  assert.deepEqual(f.calls, [["start", "prevent-app-suspension", 1]]);
  f.hold.stop();
});
