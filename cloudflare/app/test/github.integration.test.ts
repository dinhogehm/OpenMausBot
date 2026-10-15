import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGitHubRoute } from "../src/github";
import type { GitHubEnv } from "../src/github-client";
import { hash, seal } from "../src/github-client";

const origin = "https://cloud-app.example.test";
const configured = { ...env, GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "veltram-fixture", GITHUB_CLIENT_ID: "fixture-client", GITHUB_CLIENT_SECRET: "fixture-secret", GITHUB_PRIVATE_KEY: "fixture-private", GITHUB_WEBHOOK_SECRET: "fixture-webhook-secret" } satisfies GitHubEnv;
const identity = { userId: "github-owner", sessionId: "fixture-session" };

async function seed() {
  await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?, ?, ?, 1, 0, 0)').bind(identity.userId, "Fixture", "github@example.test").run();
  await env.DB.prepare("INSERT INTO organizations VALUES ('github-company','Fixture',0)").run();
  await env.DB.prepare("INSERT INTO memberships VALUES ('github-company',?,'owner')").bind(identity.userId).run();
}
async function route(path: string, method = "GET", body?: Record<string, unknown>, actor = identity) {
  return handleGitHubRoute(new Request(origin + path, { method, headers: { origin } }), configured, actor, body);
}
async function selectionSession(organizationId = "github-company", actor = identity) {
  const id = crypto.randomUUID(), sessionHash = await hash(actor.sessionId), scope = JSON.stringify([id, organizationId, actor.userId, sessionHash]);
  await env.DB.prepare("INSERT INTO github_oauth (id,organization_id,user_id,session_hash,state_hash,verifier,token,github_user_id,consumed_at,expires_at,created_at) VALUES (?,?,?,?,?,'',?,77,?,?,?)")
    .bind(id, organizationId, actor.userId, sessionHash, await hash(id), await seal(configured, scope + "/token", "ghu_fixture_secret_token"), Date.now(), Date.now() + 600_000, Date.now()).run();
}
const installation = { id: 456, app_id: 123, account: { id: 77, login: "fixture-owner", type: "User" }, suspended_at: null, permissions: { contents: "write", pull_requests: "write" } };
const repository = { id: 789, full_name: "fixture-owner/repository", default_branch: "main", owner: { id: 77 }, permissions: { admin: true, push: true } };
function selectionFetch(overrides: { installation?: object; repository?: object; membership?: object } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/user/installations?")) return Response.json({ installations: [overrides.installation ?? installation] });
    if (url.includes("/user/installations/456/repositories?")) return Response.json({ repositories: [overrides.repository ?? repository] });
    if (url.includes("/user/memberships/orgs?")) return Response.json([overrides.membership ?? { state: "active", role: "member", organization: { id: 77 } }]);
    throw new Error("Unexpected request " + url);
  });
}
afterEach(() => vi.restoreAllMocks());

describe("GitHub connection authorization", () => {
  it("binds OAuth state to company and session and consumes it once", async () => {
    await seed();
    const response = await route("/api/organizations/github-company/github/connect", "POST", {});
    const { url } = await response!.json() as { url: string };
    const oauth = new URL(url);
    expect(oauth.origin).toBe("https://github.com");
    expect(oauth.searchParams.get("code_challenge_method")).toBe("S256");
    const state = oauth.searchParams.get("state")!;
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(route(`/api/github/callback?state=${state}&code=anything`, "GET", undefined, { ...identity, sessionId: "other-session" })).rejects.toMatchObject({ code: "github_state_invalid" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "ghu_fixture_secret_token" });
      if (url === "https://api.github.com/user") return Response.json({ id: 77, login: "fixture-owner" });
      throw new Error("Unexpected request");
    });
    expect((await route(`/api/github/callback?state=${state}&code=valid`))!.status).toBe(303);
    await expect(route(`/api/github/callback?state=${state}&code=valid`)).rejects.toMatchObject({ code: "github_state_invalid" });
    const rows = await env.DB.prepare("SELECT * FROM github_oauth").all();
    expect(JSON.stringify(rows)).not.toContain("ghu_fixture_secret_token");
    expect(JSON.stringify(rows)).not.toContain(state);
  });

  it("does not grant access from an installation_id callback or non-admin member", async () => {
    await seed();
    expect((await route("/api/github/setup?installation_id=999"))!.status).toBe(303);
    expect((await env.DB.prepare("SELECT count(*) AS total FROM github_installations").first<{ total: number }>())!.total).toBe(0);
    await env.DB.prepare("UPDATE memberships SET role='member'").run();
    await expect(route("/api/organizations/github-company/github/connect", "POST", {})).rejects.toMatchObject({ code: "admin_required" });
  });

  it("limits connection starts even when each start invalidates its predecessor", async () => {
    await seed();
    for (let attempt = 0; attempt < 10; attempt++) expect((await route("/api/organizations/github-company/github/connect", "POST", {}))!.status).toBe(200);
    await expect(route("/api/organizations/github-company/github/connect", "POST", {})).rejects.toMatchObject({ code: "github_connect_rate_limited" });
    expect((await env.DB.prepare("SELECT count(*) AS total FROM github_oauth WHERE expires_at>?").bind(Date.now()).first())!.total).toBe(1);
  });

  it("rejects a webhook with an invalid signature before changing connections", async () => {
    await expect(handleGitHubRoute(new Request(origin + "/api/github/webhook", { method: "POST", headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64), "x-github-delivery": "delivery-1", "x-github-event": "installation" }, body: JSON.stringify({ action: "deleted", installation: { id: 123 } }) }), configured, undefined)).rejects.toMatchObject({ code: "github_signature_invalid" });
  });

  it("requires ownership, explicit repository selection and unique installation ownership across companies", async () => {
    await seed(); await selectionSession(); selectionFetch();
    await expect(route("/api/organizations/github-company/github/repositories", "POST", { installationId: 456, repositoryId: 999 })).rejects.toMatchObject({ code: "github_owner_required" });
    const selected = await route("/api/organizations/github-company/github/repositories", "POST", { installationId: 456, repositoryId: 789 });
    expect(selected!.status).toBe(201);
    const { connection } = await selected!.json() as { connection: { id: string } };
    await env.DB.prepare("INSERT INTO organizations VALUES ('second-company','Other',0)").run();
    await env.DB.prepare("INSERT INTO memberships VALUES ('second-company',?,'owner')").bind(identity.userId).run();
    await selectionSession("second-company");
    await expect(route("/api/organizations/second-company/github/repositories", "POST", { installationId: 456, repositoryId: 789 })).rejects.toMatchObject({ code: "github_installation_claimed" });
    const status = await (await route("/api/organizations/github-company/github"))!.json();
    expect(JSON.stringify(status)).not.toContain("ghu_");
    expect((await route(`/api/organizations/github-company/github/repositories/${connection.id}`, "DELETE", {}))!.status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM github_repositories WHERE id=?").bind(connection.id).first())!.status).toBe("revoked");
  });

  it("rejects install visibility from a collaborator and pending organization ownership", async () => {
    await seed(); await selectionSession();
    const spy = selectionFetch({ installation: { ...installation, account: { id: 77, login: "org", type: "Organization" } }, membership: { state: "pending", role: "admin", organization: { id: 77 } } });
    await expect(route("/api/organizations/github-company/github/repositories", "POST", { installationId: 456, repositoryId: 789 })).rejects.toMatchObject({ code: "github_owner_required" });
    spy.mockRestore();
    selectionFetch({ installation: { ...installation, account: { id: 88, login: "other-user", type: "User" } } });
    await expect(route("/api/organizations/github-company/github/repositories", "POST", { installationId: 456, repositoryId: 789 })).rejects.toMatchObject({ code: "github_owner_required" });
  });

  it("lets only one company win a concurrent installation claim", async () => {
    await seed(); await selectionSession(); selectionFetch();
    await env.DB.prepare("INSERT INTO organizations VALUES ('race-company','Other',0)").run();
    await env.DB.prepare("INSERT INTO memberships VALUES ('race-company',?,'owner')").bind(identity.userId).run();
    await selectionSession("race-company");
    const outcomes = await Promise.allSettled(["github-company", "race-company"].map(organizationId =>
      route(`/api/organizations/${organizationId}/github/repositories`, "POST", { installationId: 456, repositoryId: 789 })));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected").map(result => result.reason.code)).toEqual(["github_installation_claimed"]);
    expect((await env.DB.prepare("SELECT count(*) AS total FROM github_repositories").first())!.total).toBe(1);
  });

  it("does not save a connection after admin revocation during GitHub validation", async () => {
    await seed(); await selectionSession();
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      if (String(input).includes("/user/installations?")) return Response.json({ installations: [installation] });
      await env.DB.prepare("DELETE FROM memberships").run();
      return Response.json({ repositories: [repository] });
    });
    await expect(route("/api/organizations/github-company/github/repositories", "POST", { installationId: 456, repositoryId: 789 })).rejects.toMatchObject({ code: "not_found" });
    expect((await env.DB.prepare("SELECT count(*) AS total FROM github_installations").first())!.total).toBe(0);
    expect((await env.DB.prepare("SELECT count(*) AS total FROM github_repositories").first())!.total).toBe(0);
  });

  it("fails closed after OAuth selection expiration or administrative membership revocation", async () => {
    await seed(); await selectionSession();
    await env.DB.prepare("UPDATE github_oauth SET expires_at=0").run();
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(route("/api/organizations/github-company/github/repositories", "POST", { installationId: 456, repositoryId: 789 })).rejects.toMatchObject({ code: "github_selection_expired" });
    expect(spy).not.toHaveBeenCalled();
    await env.DB.prepare("DELETE FROM memberships").run();
    await expect(route("/api/organizations/github-company/github")).rejects.toMatchObject({ code: "not_found" });
  });

  it("applies signed revocation idempotently and never claims a tenant from installation.created", async () => {
    await seed(); await selectionSession(); selectionFetch();
    await route("/api/organizations/github-company/github/repositories", "POST", { installationId: 456, repositoryId: 789 });
    async function deliver(action: string, delivery: string) {
      const body = JSON.stringify({ action, installation: { id: 456 } });
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(configured.GITHUB_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
      const signature = "sha256=" + [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
      return handleGitHubRoute(new Request(origin + "/api/github/webhook", { method: "POST", headers: { "x-hub-signature-256": signature, "x-github-delivery": delivery, "x-github-event": "installation" }, body }), configured, undefined);
    }
    expect((await deliver("deleted", "fixture-delivery-delete"))!.status).toBe(200);
    expect((await deliver("deleted", "fixture-delivery-delete"))!.status).toBe(200);
    expect((await deliver("created", "fixture-delivery-create"))!.status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM github_repositories").first())!.status).toBe("revoked");
    expect((await env.DB.prepare("SELECT status FROM github_installations").first())!.status).toBe("revoked");
  });
});
