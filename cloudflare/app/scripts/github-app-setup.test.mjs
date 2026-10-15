import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, registrationUrl, startSetupServer } from "./github-app-setup.mjs";

test("manifest and registration preview request only code and PR permissions", () => {
  const manifest = buildManifest("http://127.0.0.1:1234/callback/fixture");
  assert.deepEqual(manifest.default_permissions, { contents: "write", pull_requests: "write" });
  assert.equal(manifest.request_oauth_on_install, false);
  assert.deepEqual(manifest.callback_urls, ["https://veltram.com/api/github/callback"]);
  assert.equal(new URL(registrationUrl("dinhogehm")).pathname, "/settings/apps/new");
  assert.equal(new URL(registrationUrl("fixture-org", true)).pathname, "/organizations/fixture-org/settings/apps/new");
  assert.throws(() => registrationUrl("../../evil"));
});

test("one-time loopback handoff rejects forgery, keeps credentials out of HTML/logs and retries only same secret values", async () => {
  const events = [], uploads = []; let conversions = 0, failOnce = true;
  const fixture = { id: 123, owner: { login: "dinhogehm" }, slug: "veltram-fixture", client_id: "Iv1.fixture", client_secret: "secret-client-fixture-never-real", webhook_secret: "secret-webhook-fixture-never-real", pem: "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----" };
  const setup = await startSetupServer({ owner: "dinhogehm", worker: "veltram-fixture", config: "/fixture/config.jsonc", lifetimeMs: 30_000 }, {
    fetch: async (url, init) => { conversions++; assert.equal(init.method, "POST"); assert.ok(url.startsWith("https://api.github.com/app-manifests/")); return Response.json(fixture); },
    uploadSecrets: async (secrets, options) => { assert.equal(options.worker, "veltram-fixture"); uploads.push(structuredClone(secrets)); if (failOnce) { failOnce = false; throw new Error("Fixture failure"); } },
    report: message => events.push(message),
  });
  try {
    const localOrigin = new URL(setup.url).origin;
    const response = await fetch(setup.url);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    const state = html.match(/state=([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(state);
    const callback = setup.url.replace("/setup/", "/callback/");
    assert.equal((await fetch(callback + "?code=" + "c".repeat(40) + "&state=" + "é".repeat(43))).status, 400);
    assert.equal(conversions, 0); assert.equal(uploads.length, 0);
    const result = await fetch(callback + "?code=" + "c".repeat(40) + "&state=" + state, { redirect: "manual" });
    assert.equal(result.status, 303); assert.equal(conversions, 1);
    assert.equal(uploads.length, 0);
    const failed = await fetch(localOrigin + result.headers.get("location"));
    assert.equal(failed.status, 503);
    const failurePage = await failed.text();
    assert.equal(failurePage.includes(fixture.client_secret), false);
    const retry = setup.url.replace("/setup/", "/retry/");
    assert.equal((await fetch(retry, { method: "POST", headers: { origin: "https://attacker.example" } })).status, 404);
    assert.equal((await fetch(callback + "?code=" + "c".repeat(40) + "&state=" + state)).status, 400);
    const completed = await fetch(retry, { method: "POST", headers: { origin: localOrigin } });
    assert.equal(completed.status, 200);
    assert.equal((await completed.text()).includes(fixture.pem), false);
    assert.equal(conversions, 1); assert.equal(uploads.length, 2); assert.deepEqual(uploads[0], uploads[1]);
    assert.equal(events.join("\n").includes(fixture.client_secret), false);
    assert.equal(events.join("\n").includes(fixture.webhook_secret), false);
    assert.equal(events.join("\n").includes(fixture.pem), false);
  } finally { await setup.close(); }
});
