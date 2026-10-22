import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { DESKTOP_PORTS } from "./desktop-ports.mjs";
import { portAfterFailure } from "./server-boot-probe.mjs";

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = main.indexOf("async function startServerPackaged()");
const end = main.indexOf("\nfunction syncManagedComposioCredentials", start);
assert.ok(start >= 0 && end > start, "the packaged startup function exists");

function startup(outcomes = [], { shutdown = false, fallback = { proc: null, reason: "timeout" } } = {}) {
  const forks = [], waits = [], adopted = [];
  let index = 0;
  const state = {
    DESKTOP_PORTS,
    portAfterFailure,
    desktopShutdownStarted: shutdown,
    SERVER_PORT: DESKTOP_PORTS[0],
    serverStartConflictOnly: false,
    startServerOn: async port => { forks.push(port); return outcomes[index++] ?? fallback; },
    serverSupervisor: { ready: proc => { adopted.push(proc); return true; } },
    setTimeout: (callback, ms) => { waits.push(ms); callback(); },
  };
  const run = vm.runInNewContext(main.slice(start, end) + "; startServerPackaged", state);
  return { run, state, forks, waits, adopted };
}

test("packaged startup adopts a healthy child on the first preferred port", async () => {
  const proc = { pid: 41 };
  const fixture = startup([{ proc }]);
  assert.equal(await fixture.run(), true);
  assert.deepEqual(fixture.forks, [8799]);
  assert.equal(fixture.state.SERVER_PORT, 8799);
  assert.deepEqual(fixture.adopted, [proc]);
  assert.deepEqual(fixture.waits, []);
});

test("a slow boot retries the same port before adopting its replacement", async () => {
  const proc = { pid: 42 };
  const fixture = startup([{ proc: null, reason: "timeout" }, { proc }]);
  assert.equal(await fixture.run(), true);
  assert.deepEqual(fixture.forks, [8799, 8799]);
  assert.equal(fixture.state.SERVER_PORT, 8799);
  assert.deepEqual(fixture.adopted, [proc]);
});

test("foreign owners and exited children advance through the named ports in order", async () => {
  const proc = { pid: 43 };
  const fixture = startup([{ proc: null, reason: "foreign-owner" }, { proc: null, reason: "exited" }, { proc }]);
  assert.equal(await fixture.run(), true);
  assert.deepEqual(fixture.forks, [...DESKTOP_PORTS]);
  assert.equal(fixture.state.SERVER_PORT, 28799);
  assert.deepEqual(fixture.adopted, [proc]);
});

test("exhausted slow boots stay on the preferred port and stop after two bounded rounds", async () => {
  const fixture = startup();
  assert.equal(await fixture.run(), false);
  assert.deepEqual(fixture.forks, Array(8).fill(8799));
  assert.deepEqual(fixture.waits, [2500, 2500]);
  assert.equal(fixture.state.serverStartConflictOnly, false);
  assert.deepEqual(fixture.adopted, []);
});

test("a taken first port does not let exhausted slow boots skip the next available port", async () => {
  const foreign = { proc: null, reason: "foreign-owner" };
  const timeout = { proc: null, reason: "timeout" };
  const fixture = startup([foreign, timeout, timeout, timeout, timeout, foreign]);
  assert.equal(await fixture.run(), false);
  assert.deepEqual(fixture.forks, [8799, 18799, 18799, 18799, 18799, 8799, 18799, 18799, 18799, 18799]);
  assert.equal(fixture.state.serverStartConflictOnly, false);
  assert.deepEqual(fixture.adopted, []);
});

test("ports all held by foreign processes are tried twice and reported as conflicts", async () => {
  const fixture = startup([], { fallback: { proc: null, reason: "foreign-owner" } });
  assert.equal(await fixture.run(), false);
  assert.deepEqual(fixture.forks, [...DESKTOP_PORTS, ...DESKTOP_PORTS]);
  assert.equal(fixture.state.serverStartConflictOnly, true);
  assert.deepEqual(fixture.waits, [2500, 2500]);
});

test("a child that could not be stopped aborts before any sibling is started", async () => {
  const fixture = startup([{ proc: null, reason: "stuck-child", abort: true }]);
  assert.equal(await fixture.run(), false);
  assert.deepEqual(fixture.forks, [8799]);
  assert.deepEqual(fixture.waits, []);
  assert.deepEqual(fixture.adopted, []);
});

test("shutdown starts no packaged child", async () => {
  const fixture = startup([], { shutdown: true });
  assert.equal(await fixture.run(), false);
  assert.deepEqual(fixture.forks, []);
  assert.deepEqual(fixture.waits, []);
});
