import { afterEach, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { validateClaudeInput } from "../src/claude-program";
import type { ClaudeInferenceInput } from "../src/claude-types";
import { callModel } from "../src/model-broker";
import { resolveAgents } from "../src/agent-profiles";
import type { AppEnv } from "../src/env";
import type { CodingRecord } from "../src/coding-types";
import type { ClaudeConnectionStub } from "../src/claude-types";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const organizationId = crypto.randomUUID(), userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(userId, "Fixture", `${userId}@example.test`, Date.now(), Date.now()),
    env.DB.prepare("INSERT INTO organizations VALUES (?,?,?)").bind(organizationId, "Native fixture", Date.now()),
    env.DB.prepare("INSERT INTO memberships VALUES (?, ?, 'owner')").bind(organizationId, userId),
  ]);
  const infer = vi.fn(async (_input: unknown) => ({ structuredOutput: { summary: "", calls: [{ id: "ctx", name: "graft_map", argumentsJson: "{}" }] }, tokens: 12, cliVersion: "fixture" }));
  const status = vi.fn(async () => ({ enabled: true, state: "connected", authMethod: "claude.ai", connectionVersion: 4 }));
  const cancelInference = vi.fn(async () => {});
  const getByName = vi.fn(() => ({ infer, status, cancelInference }) as unknown as ClaudeConnectionStub);
  const configured = { ...env, CLAUDE_CONNECTIONS: { getByName } } as AppEnv;
  const run = { organizationId, workspaceId: "fixture", runId: crypto.randomUUID(), requestId: crypto.randomUUID(), createdBy: userId, approvedBy: userId,
    provider: "anthropic", model: "sonnet", modelSource: { kind: "claude-code", connectionVersion: 4 }, generation: 1, deadlineAt: Date.now() + 30_000,
    agentStage: "reviewer", modelCalls: 1, task: "Fixture", repositoryConnectionId: "fixture", baseRef: "main", setupCommand: "", testCommand: "npm test" } as CodingRecord;
  return { configured, run, infer, status, cancelInference, getByName };
}
it("uses only the creator's native connection and validates role tools without reading an API key", async () => {
  const f = await fixture(); const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external call"));
  const result = await callModel(f.configured, f.run, [{ role: "user", content: "Inspect" }]);
  expect(result.calls[0].tool).toEqual({ kind: "graft_map" });
  expect(f.getByName).toHaveBeenCalledWith(JSON.stringify([f.run.organizationId, f.run.createdBy]));
  expect(f.infer.mock.calls[0][0]).toMatchObject({ connectionVersion: 4, runId: f.run.runId, userId: f.run.createdBy });
  validateClaudeInput(f.infer.mock.calls[0][0] as ClaudeInferenceInput);
  expect(fetch).not.toHaveBeenCalled();
  f.infer.mockResolvedValueOnce({ structuredOutput: { summary: "", calls: [{ id: "bad", name: "write_file", argumentsJson: '{"path":"x","content":"bad"}' }] }, tokens: 12, cliVersion: "fixture" });
  await expect(callModel(f.configured, f.run, [])).rejects.toThrow("model_invalid_response");
});
it("resolves the whole team from the explicit personal connection and rejects rotated authentication", async () => {
  const f = await fixture();
  const agents = await resolveAgents(f.configured, f.run.organizationId, f.run, f.run.createdBy);
  expect(agents).toHaveLength(3);
  expect(agents.every((agent) => agent.provider === "anthropic" && agent.modelSource?.connectionVersion === 4)).toBe(true);
  f.status.mockResolvedValueOnce({ enabled: true, state: "connected", authMethod: "claude.ai", connectionVersion: 5 });
  await expect(resolveAgents(f.configured, f.run.organizationId, f.run, f.run.createdBy)).rejects.toThrow("claude_connection_changed");
});
it("propagates quota failure without API fallback and cancels the exact native operation", async () => {
  const f = await fixture(); const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No fallback"));
  f.infer.mockRejectedValueOnce(new Error("claude_quota_exhausted"));
  await expect(callModel(f.configured, f.run, [])).rejects.toThrow("claude_quota_exhausted");
  const controller = new AbortController();
  f.infer.mockImplementationOnce(async () => { controller.abort(); return { structuredOutput: { summary: "Done", calls: [] }, tokens: 12, cliVersion: "fixture" }; });
  await callModel(f.configured, f.run, [], controller.signal);
  expect(f.cancelInference).toHaveBeenCalledWith(expect.objectContaining({ runId: f.run.runId, connectionVersion: 4, stepId: "1-1" }));
  expect(fetch).not.toHaveBeenCalled();
});
