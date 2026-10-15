import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { handleAiSettings } from "../src/ai-settings";
import type { AppEnv } from "../src/env";
import type { ClaudeConnectionStub } from "../src/claude-types";
import type { BudgetRpc } from "../src/budget-types";

async function fixture(role: "owner" | "member" = "owner") {
  const organizationId = crypto.randomUUID(), userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(userId, "Fixture", `${userId}@example.test`, Date.now(), Date.now()),
    env.DB.prepare("INSERT INTO organizations VALUES (?,?,?)").bind(organizationId, "Fixture", Date.now()),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,?)").bind(organizationId, userId, role),
  ]);
  const status = vi.fn(async () => ({ state: "disconnected" }));
  const startLogin = vi.fn(async () => ({ state: "connecting" }));
  const completeLogin = vi.fn(async () => ({ state: "connected" }));
  const configure = vi.fn(async () => ({ currency: "BRL" }));
  const get = vi.fn(async () => ({ currency: "BRL" }));
  const connections = vi.fn(() => ({ status, startLogin, completeLogin }) as unknown as ClaudeConnectionStub);
  const budgets = vi.fn(() => ({ configure, get }) as unknown as BudgetRpc);
  const configured = { ...env, CLAUDE_CONNECTIONS: { getByName: connections }, BUDGETS: { getByName: budgets } } as AppEnv;
  const request = (suffix: string, method = "GET", body = {}) => handleAiSettings(new Request(`https://fixture/api/organizations/${organizationId}/${suffix}`, { method }), configured, userId, body);
  return { organizationId, userId, configured, request, connections, startLogin, completeLogin, configure };
}
it("derives the personal connection from the session and ignores body identity", async () => {
  const f = await fixture("member");
  const response = await f.request("me/claude-code/login", "POST", { expectedVersion: 0, requestId: crypto.randomUUID(), userId: "other", organizationId: "other" });
  expect(response?.status).toBe(200);
  expect(f.connections).toHaveBeenCalledWith(JSON.stringify([f.organizationId, f.userId]));
  expect(f.startLogin).toHaveBeenCalledWith(expect.objectContaining({ userId: f.userId, organizationId: f.organizationId }));
});
it("rejects nonmembers before resolving credentials and rejects newline injection in authorization codes", async () => {
  const f = await fixture();
  await expect(handleAiSettings(new Request(`https://fixture/api/organizations/${f.organizationId}/me/claude-code`), f.configured, "stranger")).rejects.toMatchObject({ code: "not_found" });
  expect(f.connections).not.toHaveBeenCalled();
  await expect(f.request("me/claude-code/login/fixture/complete", "POST", { expectedVersion: 1, code: "one\ntwo" })).rejects.toMatchObject({ code: "claude_invalid_code" });
  expect(f.completeLogin).not.toHaveBeenCalled();
});
it("allows budget inspection to members but only administrators can change the limit", async () => {
  const f = await fixture("member");
  expect((await f.request("budget"))?.status).toBe(200);
  await expect(f.request("budget", "PUT", { expectedVersion: 0, limitBrlMicros: 0 })).rejects.toMatchObject({ code: "admin_required" });
  expect(f.configure).not.toHaveBeenCalled();
});
it("preserves exact BRL integer limits and rejects fractional micros", async () => {
  const f = await fixture();
  expect((await f.request("budget", "PUT", { expectedVersion: 2, limitBrlMicros: 1_000_000_000 }))?.status).toBe(200);
  expect(f.configure).toHaveBeenCalledWith({ organizationId: f.organizationId, userId: f.userId, expectedVersion: 2, limitBrlMicros: 1_000_000_000 });
  await expect(f.request("budget", "PUT", { expectedVersion: 2, limitBrlMicros: 0.5 })).rejects.toMatchObject({ code: "budget_invalid_configuration" });
});
