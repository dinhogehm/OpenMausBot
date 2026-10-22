// Request-scoped administration audit. State and callbacks stay in one factory.
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebhookTrigger } from "../../shared/webhooks.ts";
import { appendAdminAction, botAuditSnapshot, botChangeRows, configChangeRows, sharedSignIn, signInListsOf, type AdminActionRow, type AdminActor } from "../admin-activity.ts";
import { onConfigSaved, DATA_DIR } from "../config.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { parsedBodyOf, onJsonBody } from "../harness/http.ts";
import type { Store } from "../store.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { WebhookManager } from "../webhooks.ts";

type AdminAuditDeps = {
  DESKTOP_MANAGED: boolean;
  HOSTED_WORKSPACE: boolean;
  readonly store: Store;
  sessions: SessionRegistry;
  readonly webhooks: WebhookManager;
  signInAllowList(): Parameters<typeof sharedSignIn>[0];
  lendingEnabled(): boolean;
  decisionActorFor(auth: RequestAuth): AdminActor;
};
export function createAdminAuditRuntime(deps: AdminAuditDeps) {
  const { DESKTOP_MANAGED, HOSTED_WORKSPACE, sessions, signInAllowList, lendingEnabled, decisionActorFor } = deps;
function adminActivityRecording(): boolean {
  if (DESKTOP_MANAGED) return false;
  if (HOSTED_WORKSPACE) return true;
  const chatOnly = (scopes: readonly string[]) => !scopes.includes("admin");
  return sharedSignIn(signInAllowList()) || sessions.list().some((session) => chatOnly(session.scopes)) ||
    sessions.openPairings().some((pairing) => chatOnly(pairing.scopes));
}

function adminActorFor(auth: RequestAuth, req: IncomingMessage): AdminActor {
  if (auth.kind === "loopback" && auth.trust !== "service" &&
    (req.headers["x-openmausbot-cli"] === "1" || req.headers["x-openmausbot-cli-owner"] !== undefined)) return { kind: "cli" };
  return decisionActorFor(auth);
}

const adminActorScope = new AsyncLocalStorage<{ actor: AdminActor; sharedAtStart: boolean } | null>();
onConfigSaved((before, after) => {
  const scope = adminActorScope.getStore();
  if (!scope || DESKTOP_MANAGED) return;
  if (!scope.sharedAtStart && !adminActivityRecording() && !sharedSignIn(signInListsOf(before)) && !sharedSignIn(signInListsOf(after))) return;
  for (const row of configChangeRows(before, after)) appendAdminAction(DATA_DIR, { ...row, actor: scope.actor });
});

interface AuditPlan {
  config: boolean;
  botId?: string;
  createsBots: boolean;
  deletesBot?: string;
  createsWebhook: boolean;
  webhookId?: string;
  sessionId?: string;
  pairing: boolean;
  engineAction?: { id: string; action: string };
  roomId?: string;
}

const ACCOUNT_ADD_ENGINES = new Map([["/api/instances/claude-accounts", "claude"], ["/api/instances/chatgpt-accounts", "chatgpt"],
  ["/api/instances/antigravity-accounts", "antigravity"]]);

function adminAuditPlan(method: string, path: string): AuditPlan | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (path.startsWith("/api/internal/") || path.startsWith("/api/testing/")) return null;
  const plan: AuditPlan = {
    config: requiredScope(method, path, { sharedComputers: lendingEnabled() }) === "admin",
    createsBots: method === "POST" && (path === "/api/bots" || path === "/api/teams/import" || path === "/api/org-library/add"),
    createsWebhook: method === "POST" && path === "/api/webhooks",
    pairing: method === "POST" && path === "/api/auth/pairing",
  };
  let m = /^\/api\/bots\/([\w-]+)(?:\/(always-allow|model))?$/.exec(path);
  if (m && ((!m[2] && method === "PATCH") || (m[2] === "model" && method === "PATCH") || (m[2] === "always-allow" && method === "POST"))) plan.botId = m[1];
  if (m && !m[2] && method === "DELETE") plan.deletesBot = m[1];
  m = /^\/api\/webhooks\/([\w-]+)(\/rotate)?$/.exec(path);
  if (m && ((m[2] && method === "POST") || (!m[2] && (method === "PATCH" || method === "DELETE")))) plan.webhookId = m[1];
  m = /^\/api\/auth\/sessions\/([\w-]+)$/.exec(path);
  if (m && method === "DELETE") plan.sessionId = m[1];
  m = /^\/api\/groups\/([\w-]+)$/.exec(path);
  if (m && method === "PATCH") plan.roomId = m[1];
  m = /^\/api\/instances\/([\w.-]+)\/(install|auth\/complete|auth\/sign-out|claude-update|leftover-files\/remove)$/.exec(path);
  if (m && method === "POST") plan.engineAction = { id: m[1]!, action: m[2]!.replace("/", "-") };
  const accountAdd = method === "POST" ? ACCOUNT_ADD_ENGINES.get(path) : undefined;
  if (accountAdd) plan.engineAction = { id: accountAdd, action: "account-add" };
  return plan.config || plan.botId || plan.createsBots || plan.deletesBot || plan.createsWebhook || plan.webhookId || plan.sessionId || plan.pairing || plan.engineAction || plan.roomId ? plan : null;
}

const WEBHOOK_AUDIT_FIELDS = ["name", "prompt", "botId", "runOn", "enabled", "eventTypes"] as const;
const auditBot = (id: string | undefined) => (id ? botAuditSnapshot(deps.store.bot(id) as unknown as Record<string, unknown> | null) : null);
const auditHook = (id: string | undefined) => (id ? deps.webhooks.list().find((hook) => hook.id === id) : undefined);
const hookFields = (hook: WebhookTrigger, fields: readonly string[] = WEBHOOK_AUDIT_FIELDS) =>
  Object.fromEntries(fields.map((field) => [field, (hook as unknown as Record<string, unknown>)[field] ?? null]));

function requestedBotFields(req: IncomingMessage, path: string): string[] {
  if (path.endsWith("/always-allow")) return ["alwaysAllow"];
  if (path.endsWith("/model")) return ["modelSelection"];
  const body = parsedBodyOf(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const fields = new Set(Object.keys(body));
  if (fields.has("autoApprove") || fields.has("approvalMode")) fields.add("autoApprove").add("approvalMode");
  if (fields.has("chiefOfStaff")) fields.add("managedSections");
  return [...fields];
}

/** Each row compares only what this request named or created, so another admin's concurrent change is not attributed here. */
function beginAdminAudit(req: IncomingMessage, res: ServerResponse, method: string, path: string, auth: RequestAuth): void {
  const plan = DESKTOP_MANAGED ? null : adminAuditPlan(method, path);
  const actor = plan ? adminActorFor(auth, req) : null;
  const sharedAtStart = plan ? adminActivityRecording() : false;
  // Set for every request, so a kept-alive connection never inherits one.
  adminActorScope.enterWith(plan?.config && actor ? { actor, sharedAtStart } : null);
  if (!plan || !actor) return;
  const before = {
    bot: auditBot(plan.botId ?? plan.deletesBot),
    botName: deps.store.bot(plan.botId ?? plan.deletesBot ?? "")?.name,
    hook: auditHook(plan.webhookId),
    session: plan.sessionId ? sessions.list().find((session) => session.id === plan.sessionId) : undefined,
    roomFloor: plan.roomId ? deps.store.group(plan.roomId)?.audienceFloor ?? "everyone" : undefined,
  };
  let answered: unknown;
  if (plan.createsBots || plan.createsWebhook || plan.pairing) onJsonBody(res, (body) => (answered = body));
  res.once("finish", () => {
    if (res.statusCode >= 400 || (!sharedAtStart && !adminActivityRecording())) return;
    try {
      for (const row of adminAuditRows(plan, req, path, before, answered)) appendAdminAction(DATA_DIR, { ...row, actor });
    } catch (error) {
      console.warn(`admin activity: could not record ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function adminAuditRows(
  plan: AuditPlan,
  req: IncomingMessage,
  path: string,
  before: { bot: Record<string, unknown> | null; botName?: string; hook?: WebhookTrigger; session?: ReturnType<typeof sessions.list>[number]; roomFloor?: unknown },
  answered: unknown,
): Array<Omit<AdminActionRow, "at" | "actor">> {
  const rows: Array<Omit<AdminActionRow, "at" | "actor">> = [];
  const reply = answered && typeof answered === "object" ? answered as Record<string, unknown> : {};
  const idOf = (value: unknown) => (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : undefined);
  if (plan.botId) {
    rows.push(...botChangeRows({ id: plan.botId, name: deps.store.bot(plan.botId)?.name }, before.bot, auditBot(plan.botId), requestedBotFields(req, path)));
  }
  if (plan.createsBots) {
    const created = [idOf(reply.bot), ...(Array.isArray(reply.bots) ? reply.bots.map(idOf) : [])].filter((id): id is string => Boolean(id));
    for (const id of new Set(created)) {
      const fields = auditBot(id);
      if (fields) rows.push({ category: "bot", action: "bot.create", target: { kind: "bot", id, name: deps.store.bot(id)!.name }, after: fields });
    }
  }
  if (plan.deletesBot && before.bot && !deps.store.bot(plan.deletesBot)) {
    rows.push({ category: "bot", action: "bot.delete", target: { kind: "bot", id: plan.deletesBot, ...(before.botName ? { name: before.botName } : {}) }, before: before.bot });
  }
  const hookTarget = (hook: WebhookTrigger) => ({ kind: "webhook", id: hook.id, name: hook.name });
  if (plan.createsWebhook) {
    const hook = auditHook(idOf(reply.webhook));
    if (hook) rows.push({ category: "webhook", action: "webhook.create", target: hookTarget(hook), after: hookFields(hook) });
  }
  if (plan.webhookId && before.hook) {
    const after = auditHook(plan.webhookId);
    if (!after) rows.push({ category: "webhook", action: "webhook.delete", target: hookTarget(before.hook), before: hookFields(before.hook) });
    else if (path.endsWith("/rotate")) rows.push({ category: "webhook", action: "webhook.rotate-secret", target: hookTarget(after) });
    else {
      const body = parsedBodyOf(req);
      const named = body && typeof body === "object" ? Object.keys(body) : [];
      const changed = WEBHOOK_AUDIT_FIELDS.filter((field) => named.includes(field) &&
        JSON.stringify(hookFields(before.hook!, [field])) !== JSON.stringify(hookFields(after, [field])));
      if (changed.length) {
        rows.push({ category: "webhook", action: "webhook.update", target: hookTarget(after), changed: [...changed], before: hookFields(before.hook, changed), after: hookFields(after, changed) });
      }
    }
  }
  if (before.session && !sessions.list().some((session) => session.id === before.session!.id)) {
    const session = before.session;
    rows.push({ category: "session", action: "session.revoke", target: { kind: "session", id: session.id, name: session.email ?? session.label },
      before: { label: session.label, ...(session.email ? { email: session.email } : {}), scopes: session.scopes } });
  }
  if (plan.pairing) {
    const pairing = sessions.openPairings().find((candidate) => candidate.id === reply.id);
    if (pairing) rows.push({ category: "session", action: "pairing.create", target: { kind: "pairing", name: pairing.label }, after: { label: pairing.label, scopes: pairing.scopes } });
  }
  if (plan.engineAction) rows.push({ category: "engine", action: `engine.${plan.engineAction.action}`, target: { kind: "engine", id: plan.engineAction.id } });
  const roomBody = plan.roomId ? parsedBodyOf(req) : undefined;
  const room = plan.roomId ? deps.store.group(plan.roomId) : undefined;
  if (room && roomBody && typeof roomBody === "object" && (roomBody as { resetAudience?: unknown }).resetAudience === true) {
    rows.push({ category: "visibility", action: "room.audience-reset", target: { kind: "room", id: room.id, name: room.name },
      changed: ["audienceFloor"], before: { audienceFloor: before.roomFloor ?? "everyone" }, after: { audienceFloor: room.audienceFloor ?? "everyone" } });
  }
  return rows;
}

  return { adminActorScope, beginAdminAudit, adminActivityRecording };
}
