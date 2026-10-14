import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";
import { decryptCredential } from "../src/credentials";

const origin = "https://cloud-app.example.test";
const key = "sk-fixture-only-never-a-real-provider-key";

async function request(path: string, cookie = "", method = "GET", body?: unknown, overrides?: Partial<AppEnv>, headers?: Record<string, string>) {
  const ctx = createExecutionContext();
  const init: RequestInit = {
    method, headers: { origin, cookie, "content-type": "application/json", ...headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await worker.fetch(new Request(origin + path, init), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function login(email: string) {
  let otp = "";
  const EMAIL: AppEnv["EMAIL"] = { async send(message) { otp = message.text.match(/\b\d{8}\b/)?.[0] ?? ""; } };
  const sent = await request("/api/auth/email-otp/send-verification-otp", "", "POST", { email, type: "sign-in" }, { EMAIL });
  expect(sent.status).toBe(200);
  expect(otp).toMatch(/^\d{8}$/);
  const response = await request("/api/auth/sign-in/email-otp", "", "POST", { email, otp });
  expect(response.status).toBe(200);
  expect(await response.clone().json()).not.toHaveProperty("token");
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const { user } = await (await request("/api/session", cookie)).json() as { user: { id: string } };
  return { cookie, id: user.id };
}

async function organization(cookie: string, name = "Empresa de teste") {
  const response = await request("/api/organizations", cookie, "POST", { name });
  expect(response.status).toBe(201);
  return await response.json() as { id: string; workspaceId: string; name: string };
}

describe("Cloud app: isolated organizations and BYOK", () => {
  it("requires a real session and prevents caching private responses", async () => {
    const response = await request("/api/organizations");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("creates a company with an owner and workspace, exposing only the caller's companies", async () => {
    const a = await login("a@example.test");
    const b = await login("b@example.test");
    const orgA = await organization(a.cookie, "Mesma empresa");
    const orgB = await organization(b.cookie, "Mesma empresa");
    expect(orgA.id).not.toBe(orgB.id);
    const list = await (await request("/api/organizations", a.cookie)).json() as { organizations: { id: string; role: string }[] };
    expect(list.organizations.map((item) => [item.id, item.role])).toEqual([[orgA.id, "owner"]]);
    const workspaces = await (await request(`/api/organizations/${orgA.id}/workspaces`, a.cookie)).json();
    expect(workspaces).toEqual({ workspaces: [{ id: orgA.workspaceId, name: "Principal" }] });
    const cross = await request(`/api/organizations/${orgB.id}/workspaces`, a.cookie);
    const missing = await request("/api/organizations/nonexistent/workspaces", a.cookie);
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual(await missing.json());
  });

  it("stores authenticated ciphertext, returns only metadata, and isolates keys between companies", async () => {
    const a = await login("a@example.test");
    const b = await login("b@example.test");
    const orgA = await organization(a.cookie);
    const orgB = await organization(b.cookie);
    const path = `/api/organizations/${orgA.id}/credentials/openai`;
    const save = await request(path, a.cookie, "PUT", { key, expectedVersion: null });
    expect(save.status).toBe(200);
    const metadata = await save.json() as { version: number; status: string };
    expect(metadata.version).toBe(1);
    expect(metadata.status).toBe("configured");
    expect(JSON.stringify(metadata)).not.toContain(key);
    const row = await env.DB.prepare("SELECT * FROM provider_credentials WHERE organization_id = ?").bind(orgA.id).first<{ id: string; key_version: number; iv: string; ciphertext: string }>();
    expect(JSON.stringify(row)).not.toContain(key);
    expect(await decryptCredential(env.CREDENTIAL_MASTER_KEY, { organizationId: orgA.id, provider: "openai", credentialId: row!.id, keyVersion: row!.key_version }, { v: 1, iv: row!.iv, ciphertext: row!.ciphertext })).toBe(key);
    const listing = await request(`/api/organizations/${orgA.id}/credentials`, a.cookie);
    const text = await listing.text();
    expect(text).not.toContain(key);
    expect(text).not.toContain(row!.ciphertext);
    expect(text).not.toContain(row!.iv);
    expect(await (await request(`/api/organizations/${orgB.id}/credentials`, b.cookie)).json()).toEqual({ credentials: [] });
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await request(path, b.cookie, method, method === "GET" ? undefined : { key, expectedVersion: 1 });
      expect(response.status).toBe(404);
    }
  });

  it("requires an admin for key changes and rechecks revoked membership on the next request", async () => {
    const owner = await login("owner@example.test");
    const member = await login("member@example.test");
    const org = await organization(owner.cookie);
    await env.DB.prepare("INSERT INTO memberships VALUES (?, ?, 'member')").bind(org.id, member.id).run();
    const path = `/api/organizations/${org.id}/credentials/openai`;
    expect((await request(path, member.cookie, "PUT", { key, expectedVersion: null })).status).toBe(403);
    expect((await request(`/api/organizations/${org.id}/credentials`, member.cookie)).status).toBe(200);
    await env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE user_id = ?").bind(member.id).run();
    expect((await request(path, member.cookie, "PUT", { key, expectedVersion: null })).status).toBe(200);
    await env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(member.id).run();
    expect((await request(path, member.cookie, "DELETE", { expectedVersion: 1 })).status).toBe(404);
    expect((await request(`/api/organizations/${org.id}/credentials`, member.cookie)).status).toBe(404);
  });

  it("uses versions to prevent lost updates and revokes ciphertext with an atomic audit trail", async () => {
    const a = await login("a@example.test");
    const org = await organization(a.cookie);
    const path = `/api/organizations/${org.id}/credentials/anthropic`;
    expect((await request(path, a.cookie, "PUT", { key, expectedVersion: null })).status).toBe(200);
    const responses = await Promise.all([
      request(path, a.cookie, "PUT", { key: key + "-one", expectedVersion: 1 }),
      request(path, a.cookie, "PUT", { key: key + "-two", expectedVersion: 1 }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await request(path, a.cookie, "DELETE", { expectedVersion: 1 })).status).toBe(409);
    expect((await request(path, a.cookie, "DELETE", { expectedVersion: 2 })).status).toBe(200);
    const row = await env.DB.prepare("SELECT status, key_version, iv, ciphertext FROM provider_credentials WHERE organization_id = ?").bind(org.id).first();
    expect(row).toEqual({ status: "revoked", key_version: 3, iv: null, ciphertext: null });
    const audit = await env.DB.prepare("SELECT action, key_version FROM credential_events WHERE organization_id = ? ORDER BY key_version").bind(org.id).all();
    expect(audit.results).toEqual([{ action: "configured", key_version: 1 }, { action: "rotated", key_version: 2 }, { action: "revoked", key_version: 3 }]);
    expect((await request(path, a.cookie, "PUT", { key, expectedVersion: 3 })).status).toBe(200);
  });

  it("rejects cross-origin mutations, oversized bodies, unsupported providers and malformed versions", async () => {
    const a = await login("a@example.test");
    const org = await organization(a.cookie);
    const path = `/api/organizations/${org.id}/credentials/openai`;
    expect((await request(path, a.cookie, "PUT", { key, expectedVersion: null }, undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await request(path, a.cookie, "PUT", { key, expectedVersion: null }, undefined, { origin: "" })).status).toBe(403);
    expect((await request(path, a.cookie, "PUT", { key: "x".repeat(9000), expectedVersion: null })).status).toBe(413);
    expect((await request(path, a.cookie, "PUT", { key, expectedVersion: 0 })).status).toBe(400);
    expect((await request(path, a.cookie, "PUT", { key, expectedVersion: "1" })).status).toBe(400);
    expect((await request(path, a.cookie, "PUT", { key: "bad key\n", expectedVersion: null })).status).toBe(400);
    expect((await request(path.replace("openai", "custom-url"), a.cookie, "PUT", { key, expectedVersion: null })).status).toBe(400);
    expect((await request(path, a.cookie)).status).toBe(404);
  });

  it("fails closed with unavailable encryption and never reflects submitted key material", async () => {
    const a = await login("a@example.test");
    const org = await organization(a.cookie);
    const response = await request(`/api/organizations/${org.id}/credentials/openrouter`, a.cookie, "PUT", { key, expectedVersion: null }, { CREDENTIAL_MASTER_KEY: "invalid" });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(key);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM provider_credentials").first<{ count: number }>())!.count).toBe(0);
  });

  it("invalidates browser access after logout and never returns a session token", async () => {
    const a = await login("a@example.test");
    const session = await (await request("/api/session", a.cookie)).json();
    expect(Object.keys(session as object)).toEqual(["user"]);
    expect((await request("/api/auth/sign-out", a.cookie, "POST", {})).status).toBe(200);
    expect((await request("/api/organizations", a.cookie)).status).toBe(401);
    expect((await request("/api/auth/get-session", a.cookie)).status).toBe(404);
  });

  it("limits OTP email delivery by recipient even when the caller changes IP", async () => {
    let delivered = 0;
    const EMAIL: AppEnv["EMAIL"] = { async send() { delivered++; } };
    for (let i = 1; i <= 6; i++) {
      const response = await request("/api/auth/email-otp/send-verification-otp", "", "POST",
        { email: "limited@example.test", type: "sign-in" }, { EMAIL }, { "cf-connecting-ip": `192.0.2.${i}` });
      expect(response.status).toBe(i <= 5 ? 200 : 429);
    }
    expect(delivered).toBe(5);
    const rows = await env.DB.prepare("SELECT * FROM recipient_limits").all();
    expect(JSON.stringify(rows.results)).not.toContain("limited@example.test");
    await env.DB.prepare("UPDATE recipient_limits SET expires_at = 0").run();
    expect((await request("/api/auth/email-otp/send-verification-otp", "", "POST",
      { email: "limited@example.test", type: "sign-in" }, { EMAIL }, { "cf-connecting-ip": "192.0.2.10" })).status).toBe(200);
  });

  it("rejects invalid emails before storing limits and prevents an IP from growing recipient rows after its quota", async () => {
    let delivered = 0;
    const EMAIL: AppEnv["EMAIL"] = { async send() { delivered++; } };
    for (const email of ["not-an-email", "a\u0000@b.test", "a@b..test"]) {
      expect((await request("/api/auth/email-otp/send-verification-otp", "", "POST",
        { email, type: "sign-in" }, { EMAIL })).status).toBe(400);
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM recipient_limits").first<{ count: number }>())!.count).toBe(0);
    for (let i = 0; i < 7; i++) {
      const response = await request("/api/auth/email-otp/send-verification-otp", "", "POST",
        { email: `person${i}@example.test`, type: "sign-in" }, { EMAIL }, { "cf-connecting-ip": "192.0.2.1" });
      expect(response.status).toBe(i < 5 ? 200 : 429);
    }
    expect(delivered).toBe(5);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM recipient_limits").first<{ count: number }>())!.count).toBe(6);
  });

  it("rejects a key write if admin membership is revoked between its read and transaction", async () => {
    const owner = await login("owner@example.test");
    const admin = await login("admin@example.test");
    const org = await organization(owner.cookie);
    await env.DB.prepare("INSERT INTO memberships VALUES (?, ?, 'admin')").bind(org.id, admin.id).run();
    const DB = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare("DELETE FROM memberships WHERE organization_id = ? AND user_id = ?").bind(org.id, admin.id).run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await request(`/api/organizations/${org.id}/credentials/openai`, admin.cookie, "PUT", { key, expectedVersion: null }, { DB });
    expect(response.status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM provider_credentials").first<{ count: number }>())!.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM credential_events").first<{ count: number }>())!.count).toBe(0);
  });

  it("limits credential mutations per organization before further encryption or audit writes", async () => {
    const a = await login("owner@example.test");
    const org = await organization(a.cookie);
    const path = `/api/organizations/${org.id}/credentials/openai`;
    expect((await request(path, a.cookie, "PUT", { key, expectedVersion: null })).status).toBe(200);
    // Seed the boundary directly so slow hosts need not perform 30 logins/reads.
    await env.DB.prepare("UPDATE credential_write_limits SET count = 29 WHERE organization_id = ?").bind(org.id).run();
    expect((await request(path, a.cookie, "PUT", { key, expectedVersion: 1 })).status).toBe(200);
    expect((await request(path, a.cookie, "PUT", { key, expectedVersion: 2 })).status).toBe(429);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM credential_events").first<{ count: number }>())!.count).toBe(2);
    // A full rotation quota must never prevent emergency revocation.
    expect((await request(path, a.cookie, "DELETE", { expectedVersion: 2 })).status).toBe(200);
    expect((await request(path, a.cookie, "DELETE", { expectedVersion: 3 })).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM credential_events").first<{ count: number }>())!.count).toBe(3);
  });
});
