import { encryptCredential, type CredentialProvider } from "./credentials";
import type { AppEnv } from "./env";
import { HttpError, json } from "./http";
import { requireMembership } from "./organizations";

const adminPredicate = `EXISTS (SELECT 1 FROM memberships WHERE organization_id = ? AND user_id = ? AND role IN ('owner', 'admin'))`;

export async function listCredentials(env: AppEnv, organizationId: string, userId: string) {
  await requireMembership(env.DB, organizationId, userId);
  const rows = await env.DB.prepare(`SELECT c.provider, c.key_version AS version, c.status, c.updated_at AS updatedAt
    FROM provider_credentials c JOIN memberships m ON m.organization_id = c.organization_id
    WHERE c.organization_id = ? AND m.user_id = ? ORDER BY c.provider`).bind(organizationId, userId).all();
  return json({ credentials: rows.results });
}

export async function changeCredential(env: AppEnv, organizationId: string, userId: string, providerValue: string,
  method: "PUT" | "DELETE", body: Record<string, unknown>) {
  await requireMembership(env.DB, organizationId, userId, true);
  if (!["openai", "anthropic", "openrouter"].includes(providerValue)) throw new HttpError(400, "invalid_provider");
  const provider = providerValue as CredentialProvider;
  const expected = body.expectedVersion;
  if (expected !== null && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 1 || expected >= Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(400, "invalid_version");
  }
  if (method === "DELETE" && expected === null) throw new HttpError(400, "invalid_version");
  if (method === "PUT" && (typeof body.key !== "string" || !/^[!-~]{8,4096}$/.test(body.key))) {
    throw new HttpError(400, "invalid_key");
  }
  const current = await env.DB.prepare(`SELECT id, key_version AS version, status FROM provider_credentials
    WHERE organization_id = ? AND provider = ?`).bind(organizationId, provider).first<{ id: string; version: number; status: string }>();
  if ((current?.version ?? null) !== expected) throw new HttpError(409, "credential_changed");
  if (method === "DELETE" && !current) throw new HttpError(404, "not_found");
  if (method === "DELETE" && current?.status === "revoked") throw new HttpError(409, "credential_changed");
  // Bound writes/audit growth per organization. Revocation stays available when
  // the quota is full, but cannot manufacture new events for a revoked key.
  if (method === "PUT") {
    const now = Date.now();
    const admission = await env.DB.prepare(`INSERT INTO credential_write_limits (organization_id, count, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(organization_id) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
        expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
      WHERE expires_at <= ? OR count < 30 RETURNING count`).bind(organizationId, now + 3_600_000, now, now, now).first();
    if (!admission) throw new HttpError(429, "credential_write_limit");
  }
  const id = current?.id ?? crypto.randomUUID();
  const version = (current?.version ?? 0) + 1;
  const mutationId = crypto.randomUUID();
  const updatedAt = Date.now();
  const status = method === "PUT" ? "configured" : "revoked";
  const envelope = method === "PUT" ? await encryptCredential(env.CREDENTIAL_MASTER_KEY,
    { organizationId, provider, credentialId: id, keyVersion: version }, body.key as string) : null;

  const write = current
    ? env.DB.prepare(`UPDATE provider_credentials SET key_version = ?, status = ?, iv = ?, ciphertext = ?, mutation_id = ?, updated_at = ?, updated_by = ?
      WHERE organization_id = ? AND provider = ? AND key_version = ? AND ${adminPredicate}`)
      .bind(version, status, envelope?.iv ?? null, envelope?.ciphertext ?? null, mutationId, updatedAt, userId,
        organizationId, provider, expected, organizationId, userId)
    : env.DB.prepare(`INSERT INTO provider_credentials (organization_id, provider, id, key_version, status, iv, ciphertext, mutation_id, updated_at, updated_by)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${adminPredicate}
      ON CONFLICT(organization_id, provider) DO NOTHING`)
      .bind(organizationId, provider, id, version, status, envelope?.iv ?? null, envelope?.ciphertext ?? null, mutationId, updatedAt, userId,
        organizationId, userId);
  const action = method === "DELETE" ? "revoked" : current ? "rotated" : "configured";
  const result = await env.DB.batch([
    write,
    // Audit only the version written by THIS mutation, in the same transaction.
    env.DB.prepare(`INSERT INTO credential_events (id, organization_id, provider, credential_id, key_version, action, actor_id, created_at)
      SELECT ?, organization_id, provider, id, key_version, ?, ?, ? FROM provider_credentials
      WHERE organization_id = ? AND provider = ? AND mutation_id = ?`)
      .bind(mutationId, action, userId, updatedAt, organizationId, provider, mutationId),
  ]);
  if (result[0].meta.changes !== 1) {
    await requireMembership(env.DB, organizationId, userId, true);
    throw new HttpError(409, "credential_changed");
  }
  return json({ provider, version, status, updatedAt });
}
