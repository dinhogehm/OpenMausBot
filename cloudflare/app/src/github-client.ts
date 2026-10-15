import { createPrivateKey, sign } from "node:crypto";
import { HttpError } from "./http";

export interface GitHubEnv {
  DB: D1Database;
  APP_ORIGIN: string;
  CREDENTIAL_MASTER_KEY: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}
export interface GitHubIdentity { userId: string; sessionId: string }
export interface RepositoryConnection {
  id: string;
  organizationId: string;
  installationId: number;
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
  accountId: number;
  authorizedUserId: string;
}
export const githubEncoder = new TextEncoder();
export function configured(env: GitHubEnv): boolean {
  return Boolean(env.GITHUB_APP_ID && /^\d+$/.test(env.GITHUB_APP_ID) && env.GITHUB_APP_SLUG
    && /^[a-z0-9-]+$/.test(env.GITHUB_APP_SLUG) && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
    && env.GITHUB_PRIVATE_KEY && env.GITHUB_WEBHOOK_SECRET);
}
export function requireConfigured(env: GitHubEnv): void {
  if (!configured(env)) throw new HttpError(503, "github_not_configured");
}
export function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function randomSecret(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
export async function hash(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", githubEncoder.encode(value))));
}
export async function seal(env: GitHubEnv, scope: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(env.CREDENTIAL_MASTER_KEY), c => c.charCodeAt(0)), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: githubEncoder.encode("veltram/github/v1/" + scope) }, key, githubEncoder.encode(value));
  return JSON.stringify({ iv: base64url(iv), data: base64url(new Uint8Array(encrypted)) });
}
export async function unseal(env: GitHubEnv, scope: string, envelope: string): Promise<string> {
  try {
    const stored = JSON.parse(envelope) as { iv: string; data: string };
    const decode = (v: string) => Uint8Array.from(atob(v.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(env.CREDENTIAL_MASTER_KEY), c => c.charCodeAt(0)), "AES-GCM", false, ["decrypt"]);
    return new TextDecoder("utf-8", { fatal: true }).decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(stored.iv), additionalData: githubEncoder.encode("veltram/github/v1/" + scope) }, key, decode(stored.data)));
  } catch { throw new HttpError(503, "github_credentials_unavailable"); }
}
export function positiveId(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

/** Every response, including an error, is bounded before it is decoded. */
export async function boundedBytes(response: Response, max = 4 * 1024 * 1024): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new HttpError(413, "github_response_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function githubJson<T>(token: string, path: string, options: { method?: string; body?: unknown; allow404?: boolean } = {}): Promise<T | undefined> {
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) throw new Error("Invalid GitHub API path");
  let response: Response;
  try {
    response = await fetch("https://api.github.com" + path, {
      method: options.method ?? "GET", redirect: "manual", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10", "user-agent": "Veltram", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch { throw new HttpError(503, "github_unavailable"); }
  if (response.status === 404 && options.allow404) { await response.body?.cancel(); return undefined; }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(response.status === 404 ? 404 : response.status === 401 || response.status === 403 ? 403 : response.status === 409 || response.status === 422 ? 409 : 503,
      response.status === 401 || response.status === 403 || response.status === 404 ? "github_access_revoked" : response.status === 409 || response.status === 422 ? "github_conflict" : "github_unavailable");
  }
  if (response.status === 204) { await response.body?.cancel(); return undefined; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(response))) as T; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, "github_invalid_response"); }
}
export function appJwt(env: GitHubEnv): string {
  requireConfigured(env);
  const seconds = Math.floor(Date.now() / 1000);
  const header = base64url(githubEncoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = base64url(githubEncoder.encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: env.GITHUB_APP_ID })));
  try { return `${header}.${body}.${base64url(sign("RSA-SHA256", Buffer.from(`${header}.${body}`), createPrivateKey(env.GITHUB_PRIVATE_KEY!)))}`; }
  catch { throw new HttpError(503, "github_credentials_unavailable"); }
}
export interface Installation { id: number; app_id: number; account: { id: number; login: string; type: string }; suspended_at: string | null; permissions: { contents?: string; pull_requests?: string } }
export interface GitHubRepository { id: number; full_name: string; default_branch: string; owner: { id: number }; archived?: boolean; disabled?: boolean; permissions?: { admin?: boolean; push?: boolean } }
export async function installationToken(env: GitHubEnv, connection: RepositoryConnection, write = false, readPullRequests = false): Promise<string> {
  const jwt = appJwt(env);
  const installation = await githubJson<Installation>(jwt, `/app/installations/${connection.installationId}`);
  if (!installation || installation.id !== connection.installationId || String(installation.app_id) !== env.GITHUB_APP_ID
    || installation.account.id !== connection.accountId || installation.suspended_at) throw new HttpError(403, "github_access_revoked");
  const result = await githubJson<{ token: string; expires_at: string }>(jwt, `/app/installations/${connection.installationId}/access_tokens`, {
    method: "POST", body: { repository_ids: [connection.repositoryId], permissions: write ? { contents: "write", pull_requests: "write" } : { contents: "read", ...(readPullRequests ? { pull_requests: "read" } : {}) } },
  });
  if (!result || typeof result.token !== "string" || !result.token || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now()) throw new HttpError(503, "github_invalid_response");
  return result.token;
}
export function repositoryPath(connection: RepositoryConnection): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(connection.fullName)) throw new HttpError(400, "github_invalid_repository");
  return `/repos/${connection.fullName}`;
}
export function validateRef(ref: string): void {
  if (typeof ref !== "string" || !ref || ref.length > 200 || !ref.isWellFormed() || /[\s\p{Cc}]/u.test(ref) || [...ref].some(character => "~^:?*[\\".includes(character))
    || ref.includes("..") || ref.includes("@{") || ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".")
    || ref.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))) throw new HttpError(400, "github_invalid_ref");
}
