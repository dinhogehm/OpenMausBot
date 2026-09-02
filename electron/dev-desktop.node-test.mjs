// The dev launcher's two pure pieces: port/URL resolution and the readiness
// poll. The poll is what decides between "our server", "another OpenMausBot
// owns that port" and "the child died", so each of those is pinned here
// against a real local HTTP server rather than a mocked fetch.
import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveDevConfig, waitForHttp } from "../scripts/dev-desktop.mjs";

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("resolveDevConfig defaults to 8799/5199 on 127.0.0.1 and honours the env overrides", () => {
  const defaults = resolveDevConfig({});
  assert.equal(defaults.serverUrl, "http://127.0.0.1:8799");
  assert.equal(defaults.uiUrl, "http://127.0.0.1:5199");
  assert.equal(defaults.bootTimeoutMs, 60_000);

  const custom = resolveDevConfig({ OMB_PORT: "19300", OMB_DEV_UI_PORT: "5233", OMB_DEV_BOOT_TIMEOUT_MS: "5000" });
  assert.equal(custom.serverPort, 19300);
  assert.equal(custom.uiUrl, "http://127.0.0.1:5233");
  assert.equal(custom.bootTimeoutMs, 5000);
});

test("waitForHttp accepts a health answer that echoes the expected pid", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ app: "openmausbot", pid: 42 }));
  });
  try {
    assert.deepEqual(await waitForHttp(`${url}/api/health`, { ownerPid: 42, timeoutMs: 2_000 }), { ok: true });
  } finally {
    server.close();
  }
});

test("waitForHttp reports a foreign owner immediately instead of waiting out the timeout", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ app: "openmausbot", pid: 42 }));
  });
  try {
    const started = Date.now();
    const result = await waitForHttp(`${url}/api/health`, { ownerPid: 43, timeoutMs: 10_000 });
    assert.deepEqual(result, { ok: false, reason: "foreign-owner", pid: 42 });
    assert.ok(Date.now() - started < 5_000, "should not have waited for the timeout");
  } finally {
    server.close();
  }
});

test("waitForHttp gives up when the child it waits for has exited", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  try {
    let alive = true;
    setTimeout(() => (alive = false), 200);
    const result = await waitForHttp(url, { timeoutMs: 10_000, intervalMs: 50, isAlive: () => alive });
    assert.deepEqual(result, { ok: false, reason: "exited" });
  } finally {
    server.close();
  }
});

test("waitForHttp times out on a port nothing answers", async () => {
  const { server, url } = await serve(() => {});
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
  const result = await waitForHttp(url, { timeoutMs: 600, intervalMs: 100 });
  assert.deepEqual(result, { ok: false, reason: "timeout" });
});
