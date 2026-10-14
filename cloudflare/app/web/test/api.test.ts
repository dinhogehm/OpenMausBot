import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { api, ApiError, isAbort } from "../src/api.ts";

function observeSessionExpiry(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const target = new EventTarget();
  let expirations = 0;
  target.addEventListener("veltram:session-expired", () => { expirations++; });
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return () => expirations;
}

test("a response from an aborted company context cannot expire the current session", async (t) => {
  const expirations = observeSessionExpiry(t);
  const controller = new AbortController();
  let finishBody!: (value: unknown) => void;
  const body = new Promise((resolve) => { finishBody = resolve; });
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 401, json: () => body }) as Response);
  const request = api("/api/organizations", { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  finishBody({ error: "sign_in_required" });
  await assert.rejects(request, isAbort);
  assert.equal(expirations(), 0);
});

test("aborting while the response body streams stays an abort, not a session failure", async (t) => {
  const expirations = observeSessionExpiry(t);
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 401, json: async () => { throw new DOMException("Aborted", "AbortError"); } }) as Response);
  await assert.rejects(api("/api/organizations"), isAbort);
  assert.equal(expirations(), 0);
});

test("a current protected request that loses authentication expires the session", async (t) => {
  const expirations = observeSessionExpiry(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "sign_in_required" }, { status: 401 }));
  await assert.rejects(api("/api/organizations"), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(expirations(), 1);
});

test("an incorrect sign-in code remains a form error", async (t) => {
  const expirations = observeSessionExpiry(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ code: "INVALID_OTP" }, { status: 401 }));
  await assert.rejects(api("/api/auth/sign-in/email-otp", { method: "POST", body: { email: "test@example.test", otp: "00000000" } }), (error: unknown) => error instanceof ApiError && error.code === "INVALID_OTP");
  assert.equal(expirations(), 0);
});

test("a non-JSON success cannot masquerade as successful authentication", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>Unexpected page</html>"));
  await assert.rejects(api("/api/session"), SyntaxError);
});
