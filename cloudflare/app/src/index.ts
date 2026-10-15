import type { AppEnv } from "./env";
import { createAuth } from "./auth";
import { changeCredential, listCredentials } from "./credential-store";
import { HttpError, json, privateResponse, readJson } from "./http";
import { createOrganization, listOrganizations, listWorkspaces, requireMembership } from "./organizations";
import { limitOTPDelivery } from "./otp-limits";
import { handleGitHubRoute } from "./github";
import { agentProfilesRoute } from "./agent-profiles";
import { agentCatalogRoute } from "./agent-catalog";
import { handleReportsRoute } from "./reports";
import { decisionModelRoute, recommendAgents } from "./decision-model";
import { handleMarketplaceRoute } from "./marketplace-routes";
export { ExecutionRoom } from "./run-room";
export { Admission } from "./admission";
export { LinuxExecutor } from "./linux-executor";
export { CodingRoom } from "./coding-room";
export { CodingAdmission } from "./coding-admission";
export { CodingExecutor } from "./coding-executor";
export { CodingDependencyNetwork } from "./coding-network";
export { BrowserRoom } from "./browser-room";

const authPaths = new Set(["/api/auth/email-otp/send-verification-otp", "/api/auth/sign-in/email-otp", "/api/auth/sign-out"]);

async function route(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const origin = new URL(env.APP_ORIGIN);
  if (origin.origin !== env.APP_ORIGIN || url.origin !== env.APP_ORIGIN
    || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new HttpError(503, "origin_not_configured");
  }
  if (url.pathname === "/api/health" && request.method === "GET") return json({ service: "veltram", status: "ok", release: env.RELEASE_ID ?? "local" });
  if (!url.pathname.startsWith("/api/")) {
    if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "method_not_allowed");
    if (!env.ASSETS) throw new HttpError(404, "not_found");
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return new Response(response.body, { status: response.status, headers });
  }
  if (url.pathname === "/api/github/webhook") {
    const response = await handleGitHubRoute(request, env, undefined);
    if (!response) throw new HttpError(404, "not_found");
    return response;
  }
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  let body: Record<string, unknown> | undefined;
  if (mutating) {
    if (request.headers.get("origin") !== env.APP_ORIGIN) throw new HttpError(403, "origin_forbidden");
    const limit = /\/agent-catalog(?:\/import)?$/.test(url.pathname) ? 262144 : url.pathname.endsWith("/agents") ? 131072 : /\/coding-runs(?:\/|$)/.test(url.pathname) ? 32768 : 8192;
    body = await readJson(request, limit);
  }
  const auth = createAuth(env, ctx);
  if (url.pathname.startsWith("/api/auth/")) {
    if (request.method !== "POST" || !authPaths.has(url.pathname)) throw new HttpError(404, "not_found");
    if (url.pathname.endsWith("/send-verification-otp")) await limitOTPDelivery(request, env, body!);
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const response = await auth.handler(new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) }));
    if (response.ok && url.pathname === "/api/auth/sign-in/email-otp") {
      // Browser clients authenticate only with the HttpOnly cookie. Better Auth
      // also returns a bearer token by default; this app does not expose it.
      await response.body?.cancel();
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-length");
      responseHeaders.set("content-type", "application/json");
      return new Response(JSON.stringify({ success: true }), { status: response.status, headers: responseHeaders });
    }
    return response;
  }
  if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "not_found");
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.emailVerified) throw new HttpError(401, "sign_in_required");
  const userId = session.user.id;
  const githubResponse = await handleGitHubRoute(request, env, { userId, sessionId: session.session.id }, body);
  if (githubResponse) return githubResponse;
  const marketplaceResponse = await handleMarketplaceRoute(request, env, userId, body);
  if (marketplaceResponse) return marketplaceResponse;
  const decisionMatch = url.pathname.match(/^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/decision-model$/);
  if (decisionMatch) return decisionModelRoute(env, decisionMatch[1], userId, request.method, body ?? {});
  const recommendMatch = url.pathname.match(/^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/agent-catalog\/recommend$/);
  if (recommendMatch && request.method === "POST") return recommendAgents(env, recommendMatch[1], userId, body ?? {});
  const catalogMatch = url.pathname.match(/^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/agent-catalog(\/import)?$/);
  if (catalogMatch) return agentCatalogRoute(env, catalogMatch[1], userId, request.method, body ?? {}, Boolean(catalogMatch[2]));
  const reportResponse = await handleReportsRoute(request, env, userId, body);
  if (reportResponse) return reportResponse;
  const browserMatch = url.pathname.match(/^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/workspaces\/([A-Za-z0-9_-]{1,80})\/browser-runs(?:\/([A-Za-z0-9_-]{1,80})(?:\/(approve|cancel|screenshot))?)?$/);
  if (browserMatch) {
    const [, organizationId, workspaceId, runId, operation] = browserMatch;
    const action = request.method === "GET" ? (operation === "screenshot" ? "screenshot" : !operation ? (runId ? "get" : "list") : undefined)
      : request.method === "POST" && operation !== "screenshot" ? (!runId ? "create" : operation) : undefined;
    if (!action) throw new HttpError(404, "not_found");
    await requireMembership(env.DB, organizationId, userId, action === "approve");
    if (!env.BROWSER_RUNS) throw new HttpError(503, "browser_unavailable");
    return env.BROWSER_RUNS.getByName(organizationId).fetch(new Request("https://browser.internal/command", {
      method: "POST", body: JSON.stringify({ organizationId, workspaceId, runId, userId, action, body: body ?? {} }),
    }));
  }
  const agentsMatch = url.pathname.match(/^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/agents$/);
  if (agentsMatch) return agentProfilesRoute(env, agentsMatch[1], userId, request.method, body ?? {});
  const codingMatch = url.pathname.match(/^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/workspaces\/([A-Za-z0-9_-]{1,80})\/coding-runs(?:\/([A-Za-z0-9_-]{1,80})(?:\/(approve|cancel))?)?$/);
  if (codingMatch) {
    const [, organizationId, workspaceId, runId, operation] = codingMatch;
    const action = request.method === "GET" && !operation ? (runId ? "get" : "list") : request.method === "POST" ? (!runId ? "create" : operation) : undefined;
    if (!action) throw new HttpError(404, "not_found");
    await requireMembership(env.DB, organizationId, userId, action === "approve");
    return env.CODING_RUNS.getByName(organizationId).fetch(new Request("https://coding.internal/command", {
      method: "POST", body: JSON.stringify({ organizationId, workspaceId, runId, userId, action, body: body ?? {} }),
    }));
  }
  if (url.pathname === "/api/session" && request.method === "GET") {
    return json({ user: { id: userId, email: session.user.email, name: session.user.name } });
  }
  if (url.pathname === "/api/organizations") {
    if (request.method === "GET") return listOrganizations(env, userId);
    if (request.method === "POST") return createOrganization(env, userId, body!);
  }
  const runMatch = url.pathname.match(/^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/workspaces\/([A-Za-z0-9_-]{1,80})\/runs(?:\/([A-Za-z0-9_-]{1,80})(?:\/(approve|cancel))?)?$/);
  if (runMatch) {
    const [, organizationId, workspaceId, runId, operation] = runMatch;
    const action = request.method === "GET" && !operation ? (runId ? "get" : "list")
      : request.method === "POST" ? (!runId ? "create" : operation) : undefined;
    if (!action) throw new HttpError(404, "not_found");
    await requireMembership(env.DB, organizationId, userId, action === "approve");
    const workspace = await env.DB.prepare("SELECT id FROM workspaces WHERE id = ? AND organization_id = ?").bind(workspaceId, organizationId).first();
    if (!workspace) throw new HttpError(404, "not_found");
    return env.RUNS.getByName(organizationId).fetch(new Request("https://execution.internal/command", {
      method: "POST", body: JSON.stringify({ organizationId, workspaceId, runId, userId, action, body: body ?? {} }),
    }));
  }
  const match = url.pathname.match(/^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/(workspaces|credentials)(?:\/([^/]+))?$/);
  if (match) {
    const [, organizationId, resource, provider] = match;
    if (resource === "workspaces" && !provider && request.method === "GET") return listWorkspaces(env, organizationId, userId);
    if (resource === "credentials") {
      if (!provider && request.method === "GET") return listCredentials(env, organizationId, userId);
      if (provider && (request.method === "PUT" || request.method === "DELETE")) return changeCredential(env, organizationId, userId, provider, request.method, body!);
    }
  }
  throw new HttpError(404, "not_found");
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    try { return privateResponse(await route(request, env, ctx)); }
    catch (error) {
      // Never return raw auth/provider/database errors or request bodies.
      return privateResponse(json({ error: error instanceof HttpError ? error.code : "service_unavailable" }, error instanceof HttpError ? error.status : 503));
    }
  },
};
