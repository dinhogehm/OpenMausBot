import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { createAuth } from "../src/auth";
import type { AppEnv } from "../src/env";

type Email = Parameters<AppEnv["EMAIL"]["send"]>[0];

function fixture() {
  const messages: Email[] = [];
  const send = vi.fn(async (message: Email) => { messages.push(message); });
  const bindings: AppEnv = { ...(env as unknown as AppEnv), EMAIL: { send } };

  async function request(path: string, body: unknown, options: { cookie?: string; origin?: string } = {}) {
    const ctx = createExecutionContext();
    const headers = new Headers({
      "content-type": "application/json",
      origin: options.origin ?? bindings.APP_ORIGIN,
      "cf-connecting-ip": "198.51.100.33",
    });
    if (options.cookie) headers.set("cookie", options.cookie);
    const response = await createAuth(bindings, ctx).handler(new Request(`${bindings.APP_ORIGIN}/api/auth${path}`, {
      method: "POST", headers, body: JSON.stringify(body),
    }));
    await waitOnExecutionContext(ctx);
    return response;
  }

  async function session(cookie?: string) {
    const ctx = createExecutionContext();
    const result = await createAuth(bindings, ctx).api.getSession({
      headers: new Headers(cookie ? { cookie } : {}),
    });
    await waitOnExecutionContext(ctx);
    return result;
  }

  async function sendOTP(email: string) {
    const before = messages.length;
    const response = await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(messages).toHaveLength(before + 1);
    expect(messages.at(-1)?.to).toBe(email);
    const otp = messages.at(-1)?.text.match(/\b\d{8}\b/)?.[0];
    expect(otp).toBeTruthy();
    return otp!;
  }

  return { bindings, messages, send, request, session, sendOTP };
}

function sessionCookie(response: Response): string {
  const header = response.headers.getSetCookie().find((value) => value.includes(".session_token="));
  expect(header).toBeTruthy();
  expect(header).toMatch(/;\s*HttpOnly/i);
  expect(header).toMatch(/;\s*SameSite=Lax/i);
  expect(header).toMatch(/;\s*Secure(?:;|$)/i);
  expect(header).not.toMatch(/;\s*Domain=/i);
  return header!.split(";", 1)[0];
}

describe("browser email OTP authentication", () => {
  it("creates no session before OTP verification and then authenticates a verified user by cookie", async () => {
    const app = fixture();
    const email = "verified@example.test";
    expect(await app.session()).toBeNull();
    const otp = await app.sendOTP(email);
    expect(await app.session()).toBeNull();
    const sessions = await app.bindings.DB.prepare('SELECT COUNT(*) AS count FROM "session"').first<{ count: number }>();
    expect(sessions?.count).toBe(0);
    const stored = await app.bindings.DB.prepare('SELECT value FROM "verification" WHERE identifier = ?')
      .bind(`sign-in-otp-${email}`).first<{ value: string }>();
    expect(stored?.value).toBeTruthy();
    expect(stored?.value).not.toContain(otp);

    const signedIn = await app.request("/sign-in/email-otp", { email, otp, name: "Verified user" });
    expect(signedIn.status).toBe(200);
    const cookie = sessionCookie(signedIn);
    expect(await app.session(cookie)).toMatchObject({ user: { email, emailVerified: true, name: "Verified user" } });
    expect(signedIn.headers.get("set-auth-token")).toBeNull();
  });

  it("rejects a wrong code without creating a session and consumes the accepted code once", async () => {
    const app = fixture();
    const email = "one-use@example.test";
    const otp = await app.sendOTP(email);
    const wrongOTP = `${otp[0] === "0" ? "1" : "0"}${otp.slice(1)}`;
    const wrong = await app.request("/sign-in/email-otp", { email, otp: wrongOTP });
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await app.session()).toBeNull();

    const accepted = await app.request("/sign-in/email-otp", { email, otp });
    expect(accepted.status).toBe(200);
    const cookie = sessionCookie(accepted);
    const replay = await app.request("/sign-in/email-otp", { email, otp });
    expect(replay.status).toBe(400);
    expect(await app.session(cookie)).toMatchObject({ user: { email, emailVerified: true } });
  });

  it("rejects an expired OTP", async () => {
    const app = fixture();
    const email = "expired@example.test";
    const otp = await app.sendOTP(email);
    await app.bindings.DB.prepare('UPDATE "verification" SET "expiresAt" = ? WHERE identifier = ?')
      .bind(Date.now() - 1, `sign-in-otp-${email}`).run();
    const response = await app.request("/sign-in/email-otp", { email, otp });
    expect(response.status).toBe(400);
    expect(await app.session()).toBeNull();
  });

  it("invalidates the previous code when the recipient asks for another OTP", async () => {
    const app = fixture();
    const email = "resend@example.test";
    const first = await app.sendOTP(email);
    const latest = await app.sendOTP(email);
    expect((await app.request("/sign-in/email-otp", { email, otp: first })).status).toBe(400);
    expect((await app.request("/sign-in/email-otp", { email, otp: latest })).status).toBe(200);
  });

  it("invalidates an OTP after five wrong attempts", async () => {
    const app = fixture();
    const email = "attempts@example.test";
    const otp = await app.sendOTP(email);
    const wrongOTP = `${otp[0] === "0" ? "1" : "0"}${otp.slice(1)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await app.request("/sign-in/email-otp", { email, otp: wrongOTP })).status).toBe(400);
    }
    expect((await app.request("/sign-in/email-otp", { email, otp })).status).toBe(403);
    expect(await app.session()).toBeNull();
  });

  it("uses a usable HttpOnly cookie on the local HTTP fixture", async () => {
    const app = fixture();
    app.bindings.APP_ORIGIN = "http://localhost:8787";
    const email = "localhost@example.test";
    const otp = await app.sendOTP(email);
    const response = await app.request("/sign-in/email-otp", { email, otp });
    expect(response.status).toBe(200);
    const header = response.headers.getSetCookie().find((value) => value.includes(".session_token="));
    expect(header).toMatch(/;\s*HttpOnly/i);
    expect(header).toMatch(/;\s*SameSite=Lax/i);
    expect(header).not.toMatch(/;\s*Secure(?:;|$)/i);
    expect(await app.session(header!.split(";", 1)[0])).toMatchObject({ user: { email } });
  });

  it("rejects foreign-origin OTP sending and cookie-authenticated sign-out", async () => {
    const app = fixture();
    const email = "origin@example.test";
    const denied = await app.request("/email-otp/send-verification-otp", { email, type: "sign-in" }, { origin: "https://other.example.test" });
    expect(denied.status).toBe(403);
    expect(app.messages).toHaveLength(0);

    const otp = await app.sendOTP(email);
    const signedIn = await app.request("/sign-in/email-otp", { email, otp });
    expect(signedIn.status).toBe(200);
    const cookie = sessionCookie(signedIn);
    const deniedSignOut = await app.request("/sign-out", {}, { cookie, origin: "https://other.example.test" });
    expect(deniedSignOut.status).toBe(403);
    expect(await app.session(cookie)).toMatchObject({ user: { email } });
    expect((await app.request("/sign-out", {}, { cookie })).status).toBe(200);
    expect(await app.session(cookie)).toBeNull();
  });

  it("keeps delivery failures generic without returning provider errors", async () => {
    const app = fixture();
    app.send.mockRejectedValueOnce(new Error("provider-secret: private@example.test"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await app.request("/email-otp/send-verification-otp", { email: "delivery@example.test", type: "sign-in" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(await app.session()).toBeNull();
      expect(log.mock.calls).toEqual([[JSON.stringify({ event: "auth_email_delivery_failed" })]]);
    } finally {
      log.mockRestore();
    }
  });
});
