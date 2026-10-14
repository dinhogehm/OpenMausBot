import type { AppEnv } from "./env";
import { HttpError, json } from "./http";

export type MemberRole = "owner" | "admin" | "member";

export async function requireMembership(db: D1Database, organizationId: string, userId: string, admin = false) {
  const member = await db.prepare("SELECT role FROM memberships WHERE organization_id = ? AND user_id = ?")
    .bind(organizationId, userId).first<{ role: MemberRole }>();
  if (!member) throw new HttpError(404, "not_found");
  if (admin && member.role === "member") throw new HttpError(403, "admin_required");
  return member.role;
}

export async function listOrganizations(env: AppEnv, userId: string) {
  const rows = await env.DB.prepare(`SELECT o.id, o.name, m.role FROM organizations o
    JOIN memberships m ON m.organization_id = o.id WHERE m.user_id = ? ORDER BY o.created_at, o.id`)
    .bind(userId).all();
  return json({ organizations: rows.results });
}

export async function createOrganization(env: AppEnv, userId: string, body: Record<string, unknown>) {
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100) {
    throw new HttpError(400, "invalid_name");
  }
  const name = body.name.trim();
  const id = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  // D1 batch is transactional. The cap and creation happen in the same write.
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO organizations (id, name, created_at)
      SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM memberships WHERE user_id = ? AND role = 'owner') < 10`)
      .bind(id, name, Date.now(), userId),
    env.DB.prepare("INSERT INTO memberships SELECT id, ?, 'owner' FROM organizations WHERE id = ?").bind(userId, id),
    env.DB.prepare("INSERT INTO workspaces SELECT ?, id, 'Principal' FROM organizations WHERE id = ?").bind(workspaceId, id),
  ]);
  if (result[0].meta.changes !== 1) throw new HttpError(429, "organization_limit");
  return json({ id, name, workspaceId }, 201);
}

export async function listWorkspaces(env: AppEnv, organizationId: string, userId: string) {
  await requireMembership(env.DB, organizationId, userId);
  const rows = await env.DB.prepare(`SELECT w.id, w.name FROM workspaces w
    JOIN memberships m ON m.organization_id = w.organization_id
    WHERE w.organization_id = ? AND m.user_id = ? ORDER BY w.id`).bind(organizationId, userId).all();
  return json({ workspaces: rows.results });
}
