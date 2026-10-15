import { HttpError, json } from "./http";
import { requireMembership } from "./organizations";
import { boundedBytes, configured, githubEncoder, githubJson, hash, positiveId, randomSecret, requireConfigured, seal, unseal, type GitHubEnv, type GitHubIdentity, type GitHubRepository, type Installation } from "./github-client";
export { authorizeRepository, prepareRepository, publishRepository, reconcileRepositoryPublication } from "./github-broker";
export type { RepositoryConnection, GitHubEnv } from "./github-client";

interface OAuthRow { id: string; organization_id: string; user_id: string; session_hash: string; verifier: string; token: string | null; github_user_id: number | null; expires_at: number }
interface Selection { id: number; account: string; accountId: number; repositories: { id: number; fullName: string; defaultBranch: string }[] }
const lifetime = 10 * 60_000;
const scope = (row: OAuthRow) => JSON.stringify([row.id, row.organization_id, row.user_id, row.session_hash]);

async function pending(env: GitHubEnv, organizationId: string, identity: GitHubIdentity): Promise<OAuthRow | null> {
  return env.DB.prepare("SELECT * FROM github_oauth WHERE organization_id=? AND user_id=? AND session_hash=? AND token IS NOT NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1")
    .bind(organizationId, identity.userId, await hash(identity.sessionId), Date.now()).first<OAuthRow>();
}
async function pages<T>(token: string, path: string, property?: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = await githubJson<unknown>(token, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const entries = property ? (response as Record<string, unknown>)?.[property] : response;
    if (!Array.isArray(entries)) throw new HttpError(503, "github_invalid_response");
    result.push(...entries as T[]);
    if (entries.length < 100) return result;
  }
  throw new HttpError(413, "github_selection_too_large");
}
async function selections(env: GitHubEnv, row: OAuthRow): Promise<Selection[]> {
  const token = await unseal(env, scope(row) + "/token", row.token!);
  const installations = await pages<Installation>(token, "/user/installations", "installations");
  if (installations.length > 100) throw new HttpError(413, "github_selection_too_large");
  let ownedOrganizations: Set<number> | undefined;
  const result: Selection[] = [];
  let repositoryCount = 0;
  for (const installation of installations) {
    if (!positiveId(installation.id) || String(installation.app_id) !== env.GITHUB_APP_ID || installation.suspended_at
      || installation.permissions?.contents !== "write" || installation.permissions?.pull_requests !== "write") continue;
    if (installation.account.type === "User") {
      if (installation.account.id !== row.github_user_id) continue;
    } else if (installation.account.type === "Organization") {
      if (!ownedOrganizations) {
        const memberships = await pages<{ state: string; role: string; organization: { id: number } }>(token, "/user/memberships/orgs?state=active");
        ownedOrganizations = new Set(memberships.filter(member => member.state === "active" && member.role === "admin").map(member => member.organization.id));
      }
      if (!ownedOrganizations.has(installation.account.id)) continue;
    } else continue;
    const repositories = await pages<GitHubRepository>(token, `/user/installations/${installation.id}/repositories`, "repositories");
    repositoryCount += repositories.length;
    if (repositoryCount > 2000) throw new HttpError(413, "github_selection_too_large");
    result.push({ id: installation.id, account: installation.account.login, accountId: installation.account.id, repositories: repositories
      .filter(repo => positiveId(repo.id) && repo.owner?.id === installation.account.id && !repo.archived && !repo.disabled && repo.permissions?.admin === true
        && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.full_name) && typeof repo.default_branch === "string")
      .map(repo => ({ id: repo.id, fullName: repo.full_name, defaultBranch: repo.default_branch })) });
  }
  return result;
}
async function begin(env: GitHubEnv, organizationId: string, identity: GitHubIdentity): Promise<Response> {
  requireConfigured(env);
  const now = Date.now();
  const count = await env.DB.prepare("SELECT count(*) AS count FROM github_oauth WHERE user_id=? AND created_at>?").bind(identity.userId, now - lifetime).first<{ count: number }>();
  if ((count?.count ?? 0) >= 10) throw new HttpError(429, "github_connect_rate_limited");
  const state = randomSecret(), verifier = randomSecret();
  const row: OAuthRow = { id: crypto.randomUUID(), organization_id: organizationId, user_id: identity.userId, session_hash: await hash(identity.sessionId), verifier: "", token: null, github_user_id: null, expires_at: now + lifetime };
  const statements = [
    env.DB.prepare("DELETE FROM github_oauth WHERE created_at<?").bind(now - lifetime),
    env.DB.prepare("UPDATE github_oauth SET expires_at=?,token=NULL,verifier='',consumed_at=COALESCE(consumed_at,?) WHERE organization_id=? AND user_id=? AND session_hash=?").bind(now, now, organizationId, identity.userId, row.session_hash),
    env.DB.prepare("INSERT INTO github_oauth (id,organization_id,user_id,session_hash,state_hash,verifier,expires_at,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM memberships WHERE organization_id=? AND user_id=? AND role IN ('owner','admin')) AND (SELECT count(*) FROM github_oauth WHERE user_id=? AND created_at>?)<10")
      .bind(row.id, organizationId, identity.userId, row.session_hash, await hash(state), await seal(env, scope(row) + "/verifier", verifier), row.expires_at, now, organizationId, identity.userId, identity.userId, now - lifetime),
  ];
  const results = await env.DB.batch(statements);
  if (!results[2].meta.changes) { await requireMembership(env.DB, organizationId, identity.userId, true); throw new HttpError(429, "github_connect_rate_limited"); }
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID!, redirect_uri: env.APP_ORIGIN + "/api/github/callback", state, code_challenge: await hash(verifier), code_challenge_method: "S256", prompt: "select_account" }).toString();
  return json({ url: url.href });
}
async function callback(request: Request, env: GitHubEnv, identity: GitHubIdentity): Promise<Response> {
  requireConfigured(env);
  const url = new URL(request.url);
  const state = url.searchParams.get("state"), code = url.searchParams.get("code");
  if (!state || state.length > 100 || !code || code.length > 512) throw new HttpError(400, "github_state_invalid");
  const row = await env.DB.prepare("UPDATE github_oauth SET consumed_at=? WHERE state_hash=? AND session_hash=? AND user_id=? AND consumed_at IS NULL AND expires_at>? AND EXISTS (SELECT 1 FROM memberships WHERE organization_id=github_oauth.organization_id AND user_id=github_oauth.user_id AND role IN ('owner','admin')) RETURNING *")
    .bind(Date.now(), await hash(state), await hash(identity.sessionId), identity.userId, Date.now()).first<OAuthRow>();
  if (!row) throw new HttpError(400, "github_state_invalid");
  const verifier = await unseal(env, scope(row) + "/verifier", row.verifier);
  let response: Response;
  try { response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, code_verifier: verifier, redirect_uri: env.APP_ORIGIN + "/api/github/callback" }),
  }); } catch { throw new HttpError(503, "github_unavailable"); }
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(403, "github_authorization_failed"); }
  let result: { access_token?: string; error?: string };
  try { result = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 16_384))); }
  catch { throw new HttpError(503, "github_invalid_response"); }
  if (result.error || typeof result.access_token !== "string" || !/^ghu_[A-Za-z0-9_]{8,500}$/.test(result.access_token)) throw new HttpError(403, "github_authorization_failed");
  const user = await githubJson<{ id: number }>(result.access_token, "/user");
  if (!user || !positiveId(user.id)) throw new HttpError(503, "github_invalid_response");
  const updated = await env.DB.prepare("UPDATE github_oauth SET token=?, github_user_id=?, verifier='' WHERE id=? AND expires_at>? AND EXISTS (SELECT 1 FROM memberships WHERE organization_id=github_oauth.organization_id AND user_id=github_oauth.user_id AND role IN ('owner','admin'))")
    .bind(await seal(env, scope(row) + "/token", result.access_token), user.id, row.id, Date.now()).run();
  if (!updated.meta.changes) throw new HttpError(403, "github_selection_expired");
  return Response.redirect(env.APP_ORIGIN + "/?github=connected&organization=" + encodeURIComponent(row.organization_id), 303);
}
async function connectRepository(env: GitHubEnv, organizationId: string, identity: GitHubIdentity, body: Record<string, unknown>): Promise<Response> {
  requireConfigured(env);
  if (!positiveId(body.installationId) || !positiveId(body.repositoryId)) throw new HttpError(400, "github_invalid_selection");
  const row = await pending(env, organizationId, identity);
  if (!row) throw new HttpError(409, "github_selection_expired");
  const installation = (await selections(env, row)).find(item => item.id === body.installationId);
  const repository = installation?.repositories.find(item => item.id === body.repositoryId);
  if (!installation || !repository) throw new HttpError(403, "github_owner_required");
  const connectionId = crypto.randomUUID(), now = Date.now();
  const allowed = "EXISTS (SELECT 1 FROM memberships WHERE organization_id=? AND user_id=? AND role IN ('owner','admin')) AND EXISTS (SELECT 1 FROM github_oauth WHERE id=? AND token IS NOT NULL AND expires_at>?)";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO github_installations (installation_id,app_id,organization_id,account_id,account_login,status,created_at) SELECT ?,?,?,?,?,'active',? WHERE ${allowed} ON CONFLICT(installation_id) DO UPDATE SET status='active',account_login=excluded.account_login WHERE github_installations.organization_id=excluded.organization_id AND github_installations.app_id=excluded.app_id AND github_installations.account_id=excluded.account_id`)
      .bind(installation.id, env.GITHUB_APP_ID, organizationId, installation.accountId, installation.account, now, organizationId, identity.userId, row.id, now),
    env.DB.prepare(`INSERT INTO github_repositories (id,organization_id,installation_id,repository_id,full_name,default_branch,status,connected_by,created_at) SELECT ?,?,?,?,?,?,'active',?,? WHERE ${allowed} AND EXISTS (SELECT 1 FROM github_installations WHERE installation_id=? AND organization_id=? AND status='active') ON CONFLICT(installation_id,repository_id) DO UPDATE SET status='active',full_name=excluded.full_name,default_branch=excluded.default_branch,connected_by=excluded.connected_by WHERE github_repositories.organization_id=excluded.organization_id`)
      .bind(connectionId, organizationId, installation.id, repository.id, repository.fullName, repository.defaultBranch, identity.userId, now, organizationId, identity.userId, row.id, now, installation.id, organizationId),
  ]);
  await requireMembership(env.DB, organizationId, identity.userId, true);
  const connection = await env.DB.prepare("SELECT id,repository_id AS repositoryId,installation_id AS installationId,full_name AS fullName,default_branch AS defaultBranch,status FROM github_repositories WHERE installation_id=? AND repository_id=? AND organization_id=? AND status='active'")
    .bind(installation.id, repository.id, organizationId).first();
  if (!connection) throw new HttpError(409, "github_installation_claimed");
  return json({ connection }, 201);
}
async function webhook(request: Request, env: GitHubEnv): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) throw new HttpError(503, "github_not_configured");
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) throw new HttpError(401, "github_signature_invalid");
  const bytes = await boundedBytes(new Response(request.body), 1024 * 1024);
  const key = await crypto.subtle.importKey("raw", githubEncoder.encode(env.GITHUB_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const digest = Uint8Array.from(signature.slice(7).match(/../g)!, value => parseInt(value, 16));
  if (!await crypto.subtle.verify("HMAC", key, digest, bytes)) throw new HttpError(401, "github_signature_invalid");
  const delivery = request.headers.get("x-github-delivery") ?? "";
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(delivery)) throw new HttpError(400, "github_delivery_invalid");
  let payload: { action?: string; installation?: { id: number }; repositories_removed?: { id: number }[]; repository?: { id: number }; sender?: { id: number } };
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, "github_payload_invalid"); }
  if (!payload || typeof payload !== "object") throw new HttpError(400, "github_payload_invalid");
  const event = request.headers.get("x-github-event"), installationId = payload.installation?.id;
  // Revocations are idempotent, even if the same signed body arrives with another delivery ID.
  // Installation-created/unsuspend events never claim a tenant or automatically restore access.
  const statements: D1PreparedStatement[] = [];
  const fresh = "NOT EXISTS (SELECT 1 FROM github_deliveries WHERE id=?)";
  if (positiveId(installationId) && event === "installation" && ["deleted", "suspend"].includes(payload.action ?? "")) {
    statements.push(env.DB.prepare(`UPDATE github_installations SET status='revoked' WHERE installation_id=? AND ${fresh}`).bind(installationId, delivery));
    statements.push(env.DB.prepare(`UPDATE github_repositories SET status='revoked' WHERE installation_id=? AND ${fresh}`).bind(installationId, delivery));
  }
  if (positiveId(installationId) && event === "installation_repositories" && payload.action === "removed") {
    if (!Array.isArray(payload.repositories_removed) || payload.repositories_removed.length > 1000) throw new HttpError(400, "github_payload_invalid");
    for (const repo of payload.repositories_removed) {
      if (positiveId(repo.id)) statements.push(env.DB.prepare(`UPDATE github_repositories SET status='revoked' WHERE installation_id=? AND repository_id=? AND ${fresh}`).bind(installationId, repo.id, delivery));
    }
  }
  if (event === "repository" && ["deleted", "transferred", "archived"].includes(payload.action ?? "") && positiveId(payload.repository?.id)) {
    statements.push(env.DB.prepare(`UPDATE github_repositories SET status='revoked' WHERE repository_id=? AND ${fresh}`).bind(payload.repository.id, delivery));
  }
  if (event === "github_app_authorization" && payload.action === "revoked" && positiveId(payload.sender?.id)) {
    statements.push(env.DB.prepare(`DELETE FROM github_oauth WHERE github_user_id=? AND ${fresh}`).bind(payload.sender.id, delivery));
  }
  statements.push(env.DB.prepare("INSERT OR IGNORE INTO github_deliveries VALUES (?,?)").bind(delivery, Date.now()));
  statements.push(env.DB.prepare("DELETE FROM github_deliveries WHERE created_at<?").bind(Date.now() - 7 * 86400_000));
  await env.DB.batch(statements);
  return json({ received: true });
}

export async function handleGitHubRoute(request: Request, env: GitHubEnv, identity: GitHubIdentity | undefined, body: Record<string, unknown> = {}): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/api/github/webhook" && request.method === "POST") return webhook(request, env);
  const match = url.pathname.match(/^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/github(?:\/(connect|repositories)(?:\/([A-Za-z0-9_-]{1,80}))?)?$/);
  const callbackRoute = ["/api/github/callback", "/api/github/setup"].includes(url.pathname);
  if (!match && !callbackRoute) return undefined;
  if (!identity) throw new HttpError(401, "sign_in_required");
  if (callbackRoute) {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    if (url.pathname.endsWith("/callback")) return callback(request, env, identity);
    return Response.redirect(env.APP_ORIGIN + "/?github=installed", 303);
  }
  const [, organizationId, operation, connectionId] = match!;
  const role = await requireMembership(env.DB, organizationId, identity.userId, request.method !== "GET");
  if (request.method !== "GET" && request.headers.get("origin") !== env.APP_ORIGIN) throw new HttpError(403, "origin_forbidden");
  if (!operation && request.method === "GET") {
    const connections = await env.DB.prepare("SELECT id,repository_id AS repositoryId,installation_id AS installationId,full_name AS fullName,default_branch AS defaultBranch,status FROM github_repositories WHERE organization_id=? ORDER BY created_at DESC").bind(organizationId).all();
    const row = role !== "member" && configured(env) ? await pending(env, organizationId, identity) : null;
    const choices = row ? (await selections(env, row)).map(({ id, account, repositories }) => ({ id, account, repositories })) : null;
    return json({ configured: configured(env), connections: connections.results, pending: choices ? { installations: choices } : null, installUrl: configured(env) ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new` : null });
  }
  if (operation === "connect" && !connectionId && request.method === "POST") return begin(env, organizationId, identity);
  if (operation === "repositories" && !connectionId && request.method === "POST") return connectRepository(env, organizationId, identity, body);
  if (operation === "repositories" && connectionId && request.method === "DELETE") {
    const result = await env.DB.prepare("UPDATE github_repositories SET status='revoked' WHERE id=? AND organization_id=? AND EXISTS (SELECT 1 FROM memberships WHERE organization_id=? AND user_id=? AND role IN ('owner','admin'))")
      .bind(connectionId, organizationId, organizationId, identity.userId).run();
    if (!result.meta.changes) throw new HttpError(404, "not_found");
    return json({ revoked: true });
  }
  throw new HttpError(404, "not_found");
}
