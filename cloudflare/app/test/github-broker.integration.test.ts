import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authorizeRepository, prepareRepository, publicationDigest, publishRepository, reconcileRepositoryPublication, validateRepositoryFiles, type PublicationInput } from "../src/github-broker";
import { HttpError } from "../src/http";
import type { GitHubEnv } from "../src/github-client";

const baseSha = "a".repeat(40), baseTreeSha = "b".repeat(40), treeSha = "c".repeat(40), commitSha = "d".repeat(40), blobSha = "e".repeat(40);
let configured: GitHubEnv;
beforeAll(async () => {
  const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
  configured = { ...env, GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "veltram-fixture", GITHUB_CLIENT_ID: "fixture", GITHUB_CLIENT_SECRET: "fixture", GITHUB_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----`, GITHUB_WEBHOOK_SECRET: "fixture-secret" };
});
afterEach(() => vi.restoreAllMocks());
async function seed() {
  await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (\'broker-user\',\'Fixture\',\'broker@example.test\',1,0,0)').run();
  await env.DB.prepare("INSERT INTO organizations VALUES ('broker-company','Fixture',0)").run();
  await env.DB.prepare("INSERT INTO memberships VALUES ('broker-company','broker-user','owner')").run();
  await env.DB.prepare("INSERT INTO github_installations VALUES (456,'123','broker-company',77,'fixture-owner','active',0)").run();
  await env.DB.prepare("INSERT INTO github_repositories VALUES ('broker-connection','broker-company',456,789,'fixture-owner/repository','main','active','broker-user',0)").run();
  return authorizeRepository(configured, "broker-company", "broker-user", "broker-connection");
}
function apiMock(options: { redirect?: string; lostBranch?: boolean; lostPull?: boolean; wrongBranch?: boolean; archiveChunks?: number } = {}) {
  let branchCreated = false, pullCreated = false;
  const mutations: { url: string; body: Record<string, unknown> }[] = [];
  const pull = { number: 42, html_url: "https://github.com/fixture-owner/repository/pull/42", head: { sha: commitSha, ref: "veltram/test-run", repo: { id: 789 } }, base: { ref: "main", repo: { id: 789 } }, state: "open" };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const headers = new Headers(init?.headers);
    if (url.startsWith("https://codeload.github.com/")) {
      expect(headers.has("authorization")).toBe(false);
      if (options.archiveChunks) {
        let chunks = options.archiveChunks;
        return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (chunks-- > 0) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); } }));
      }
      return new Response("fixture archive");
    }
    if (url.endsWith("/app/installations/456")) return Response.json({ id: 456, app_id: 123, account: { id: 77 }, suspended_at: null });
    if (url.endsWith("/access_tokens")) {
      expect(body.repository_ids).toEqual([789]);
      return Response.json({ token: "ghs_fixture_only", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (url.endsWith("/repos/fixture-owner/repository")) return Response.json({ id: 789, full_name: "fixture-owner/repository", owner: { id: 77 } });
    if (url.endsWith("/commits/main")) return Response.json({ sha: baseSha, commit: { tree: { sha: baseTreeSha } } });
    if (url.endsWith(`/tarball/${baseSha}`)) return new Response(null, { status: 302, headers: { location: options.redirect ?? `https://codeload.github.com/fixture-owner/repository/legacy.tar.gz/${baseSha}?token=fixture-signed-url` } });
    if (url.endsWith(`/git/commits/${baseSha}`)) return Response.json({ tree: { sha: baseTreeSha } });
    if (url.endsWith(`/git/commits/${commitSha}`)) return Response.json({ sha: commitSha, tree: { sha: treeSha }, parents: [{ sha: baseSha }] });
    if (init?.method === "POST") mutations.push({ url, body });
    if (url.endsWith("/git/blobs")) return Response.json({ sha: blobSha });
    if (url.endsWith("/git/trees")) { expect(body.base_tree).toBe(baseTreeSha); return Response.json({ sha: treeSha }); }
    if (url.endsWith("/git/commits")) { expect(body.parents).toEqual([baseSha]); return Response.json({ sha: commitSha }); }
    if (url.endsWith("/git/ref/heads/veltram/test-run")) return options.wrongBranch || branchCreated ? Response.json({ object: { sha: options.wrongBranch ? "f".repeat(40) : commitSha } }) : new Response(null, { status: 404 });
    if (url.endsWith("/git/refs")) {
      expect(body.ref).toBe("refs/heads/veltram/test-run");
      expect(body).not.toHaveProperty("force"); branchCreated = true;
      if (options.lostBranch) throw new Error("Response lost after branch creation");
      return Response.json({ object: { sha: commitSha } });
    }
    if (url.includes("/pulls?")) return Response.json(pullCreated ? [pull] : []);
    if (url.endsWith("/pulls")) {
      expect(body.draft).toBe(true); expect(body.base).toBe("main"); pullCreated = true;
      if (options.lostPull) throw new Error("Response lost after PR creation");
      return Response.json(pull);
    }
    throw new Error("Unexpected API request " + url);
  });
  return { spy, mutations };
}
async function input(): Promise<PublicationInput> {
  const files = [{ path: "src/hello.ts", content: "export const hello = 1;\n", mode: "100644" as const }];
  return { runId: "test-run", baseSha, baseTreeSha, baseRef: "main", task: "Add hello", files, verification: { command: "pnpm test", exitCode: 0, treeDigest: await publicationDigest(files) }, assertActive: async () => {} };
}
describe("GitHub broker boundaries", () => {
  it("streams the pinned archive and never forwards installation credentials to redirects", async () => {
    const connection = await seed(); apiMock();
    const prepared = await prepareRepository(configured, connection, "main");
    expect(prepared.baseSha).toBe(baseSha); expect(prepared.baseTreeSha).toBe(baseTreeSha);
    expect(await new Response(prepared.archive).text()).toBe("fixture archive");
  });
  it("rejects a malicious archive redirect", async () => {
    const connection = await seed(); const { spy } = apiMock({ redirect: "https://attacker.example/archive" });
    await expect(prepareRepository(configured, connection, "main")).rejects.toMatchObject({ code: "github_archive_redirect_forbidden" });
    expect(spy.mock.calls.some(([url]) => String(url).includes("attacker.example"))).toBe(false);
  });
  it("bounds the archive while streaming without trusting Content-Length", async () => {
    const connection = await seed(); apiMock({ archiveChunks: 65 });
    const prepared = await prepareRepository(configured, connection, "main");
    const reader = prepared.archive.getReader();
    let received = 0;
    await expect((async () => { for (;;) { const result = await reader.read(); if (result.done) return; received += result.value.byteLength; } })()).rejects.toMatchObject({ code: "github_archive_too_large" });
    expect(received).toBe(64 * 1024 * 1024);
  });
  it("publishes only tested content and reconciles lost branch and PR responses without duplication", async () => {
    const connection = await seed(); const { mutations } = apiMock({ lostBranch: true, lostPull: true });
    const request = await input();
    expect(await publishRepository(configured, connection, request)).toEqual({ branch: "veltram/test-run", commitSha, prUrl: "https://github.com/fixture-owner/repository/pull/42", prNumber: 42 });
    expect(await publishRepository(configured, connection, request)).toMatchObject({ prNumber: 42 });
    expect(mutations.filter(item => item.url.endsWith("/pulls"))).toHaveLength(1);
    expect(mutations.filter(item => item.url.endsWith("/git/refs"))).toHaveLength(1);
  });
  it("recovers a confirmed publication with only repository reads and rejects a mismatched receipt", async () => {
    const connection = await seed(); const { mutations, spy } = apiMock(); const request = await input();
    const published = await publishRepository(configured, connection, request);
    await env.DB.prepare("UPDATE github_publications SET pr_url=NULL,pr_number=NULL").run();
    mutations.length = 0; spy.mockClear();
    expect(await reconcileRepositoryPublication(configured, connection, request)).toEqual(published);
    expect(mutations).toHaveLength(0);
    const tokenCall = spy.mock.calls.find(([url]) => String(url).endsWith("/access_tokens"));
    expect(JSON.parse(String(tokenCall![1]!.body)).permissions).toEqual({ contents: "read", pull_requests: "read" });
    expect((await env.DB.prepare("SELECT pr_url FROM github_publications").first())!.pr_url).toBeNull();
    expect(await reconcileRepositoryPublication(configured, connection, { ...request, verification: { ...request.verification, treeDigest: "0".repeat(64) } })).toBeNull();
    await env.DB.prepare("UPDATE github_publications SET tree_sha=?").bind("f".repeat(40)).run();
    expect(await reconcileRepositoryPublication(configured, connection, request)).toBeNull();
  });
  it("rejects failed tests, changed receipts and existing branches before overwriting anything", async () => {
    const connection = await seed(); const { mutations } = apiMock({ wrongBranch: true });
    const request = await input();
    await expect(publishRepository(configured, connection, { ...request, verification: { ...request.verification, exitCode: 1 } })).rejects.toMatchObject({ code: "github_publication_invalid" });
    await expect(publishRepository(configured, connection, { ...request, files: [{ ...request.files[0], content: "untested" }] })).rejects.toMatchObject({ code: "github_verification_mismatch" });
    expect(mutations).toHaveLength(0);
    await expect(publishRepository(configured, connection, request)).rejects.toMatchObject({ code: "github_branch_changed" });
    expect(mutations.filter(item => item.url.endsWith("/git/refs") || item.url.endsWith("/pulls"))).toHaveLength(0);
  });
  it("rechecks cancellation and revoked memberships immediately before writes", async () => {
    const connection = await seed(); const { mutations } = apiMock();
    const request = await input(); let checks = 0;
    request.assertActive = async () => { checks++; if (checks === 2) throw new HttpError(409, "run_canceled"); };
    await expect(publishRepository(configured, connection, request)).rejects.toMatchObject({ code: "run_canceled" });
    expect(mutations).toHaveLength(0);
    await env.DB.prepare("DELETE FROM memberships").run();
    await expect(prepareRepository(configured, connection, "main")).rejects.toMatchObject({ code: "not_found" });
  });
  it("rejects traversal, workflow changes, symlinks, duplicate paths and binary content", async () => {
    for (const path of ["../secret", "/etc/passwd", "a//b", ".git/config", ".github", ".github/workflows/ci.yml", "a\\b"]) {
      expect(() => validateRepositoryFiles([{ path, content: "x", mode: "100644" }])).toThrow();
    }
    expect(() => validateRepositoryFiles([{ path: "a", content: "\0", mode: "100644" }])).toThrow();
    expect(() => validateRepositoryFiles([{ path: "a", content: "x", mode: "120000" as "100644" }])).toThrow();
    expect(() => validateRepositoryFiles([{ path: "a", content: "x", mode: "100644" }, { path: "a", content: null, mode: "100644" }])).toThrow();
  });
});
