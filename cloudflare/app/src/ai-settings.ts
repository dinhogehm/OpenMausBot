import type { AppEnv } from "./env";
import { HttpError, json } from "./http";
import { requireMembership } from "./organizations";
import { claudeConnection } from "./claude-connection";

export async function handleAiSettings(request: Request, env: AppEnv, userId: string, body: Record<string, unknown> = {}): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const budget = path.match(/^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/budget$/);
  const claude = path.match(/^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/me\/claude-code(?:\/(login|logout)(?:\/([A-Za-z0-9_-]{1,80})\/(complete|cancel))?)?$/);
  if (!budget && !claude) return null;
  const organizationId = (budget ?? claude)![1];
  await requireMembership(env.DB, organizationId, userId, Boolean(budget && request.method === "PUT"));
  try {
    if (budget) {
      if (!env.BUDGETS) throw new HttpError(503, "budget_not_configured");
      const ledger = env.BUDGETS.getByName(organizationId);
      if (request.method === "GET") return json({ ...await ledger.get({ organizationId, userId }), enforcement: { required: env.AI_BUDGET_REQUIRED === "true", paidApiAvailable: false } });
      if (request.method === "PUT") {
        if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0 || !Number.isSafeInteger(body.limitBrlMicros) || Number(body.limitBrlMicros) < 0) throw new HttpError(400, "budget_invalid_configuration");
        return json({ ...await ledger.configure({ organizationId, userId, expectedVersion: Number(body.expectedVersion), limitBrlMicros: Number(body.limitBrlMicros) }), enforcement: { required: env.AI_BUDGET_REQUIRED === "true", paidApiAvailable: false } });
      }
    } else if (claude) {
      const connection = claudeConnection(env, organizationId, userId);
      const [, , operation, flowId, flowOperation] = claude;
      if (request.method === "GET" && !operation) return json(await connection.status({ organizationId, userId }));
      if (request.method === "POST" && operation) {
        if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new HttpError(400, "claude_invalid_version");
        const input = { organizationId, userId, expectedVersion: Number(body.expectedVersion) };
        if (operation === "login" && !flowId) {
          if (typeof body.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.requestId)) throw new HttpError(400, "claude_invalid_request");
          return json(await connection.startLogin({ ...input, requestId: body.requestId }));
        }
        if (operation === "login" && flowId && flowOperation === "complete") {
          if (typeof body.code !== "string" || !body.code.trim() || body.code.length > 4096 || /[\r\n\0]/.test(body.code)) throw new HttpError(400, "claude_invalid_code");
          return json(await connection.completeLogin({ ...input, flowId, code: body.code }));
        }
        if (operation === "login" && flowId && flowOperation === "cancel") return json(await connection.cancelLogin({ ...input, flowId }));
        if (operation === "logout" && !flowId) return json(await connection.logout(input));
      }
    }
    throw new HttpError(404, "not_found");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = error instanceof Error && /^(?:claude|budget)_[a-z_]{1,80}$/.test(error.message) ? error.message : "service_unavailable";
    return json({ error: code }, /(?:changed|busy|reused)$/.test(code) ? 409 : 503);
  }
}
