import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { CodingRecord } from "../src/coding-types";
import { handleReportsRoute, recordReportSnapshot } from "../src/reports";
import type { ExecutionReport, ReportFact } from "../src/report-types";

const stamp = Date.now();
async function fixture(role = "owner") {
  const organizationId = crypto.randomUUID(), workspaceId = crypto.randomUUID(), userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(userId, "Report fixture", `${userId}@example.test`, stamp, stamp),
    env.DB.prepare("INSERT INTO organizations VALUES (?,?,?)").bind(organizationId, "Report fixture", stamp),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,?)").bind(organizationId, userId, role),
    env.DB.prepare("INSERT INTO workspaces VALUES (?,?,?)").bind(workspaceId, organizationId, "Fixture"),
  ]);
  const url = `https://cloud-app.example.test/api/organizations/${organizationId}/workspaces/${workspaceId}/reports`;
  return { organizationId, workspaceId, userId, url, async report(query = "period=week") {
    const response = await handleReportsRoute(new Request(`${url}?${query}`), env, userId);
    return await response!.json() as ExecutionReport;
  } };
}
function run(f: Awaited<ReturnType<typeof fixture>>, at = stamp): CodingRecord {
  const runId = crypto.randomUUID();
  return { ...f, runId, requestId: runId, generation: 1, deadlineAt: at + 30_000, repositoryConnectionId: "repo-fixture", repositoryName: "fixture/repo", baseRef: "main", task: "Verify reporting", provider: "openai", model: "fixture", setupCommand: "", testCommand: "npm test", createdBy: f.userId, credentialVersion: 1, createdAt: at, updatedAt: at, status: "pending_approval", modelCalls: 0, tokens: 0, events: [] };
}
it("starts coverage explicitly without importing past runs, and preserves null before tracking", async () => {
  const f = await fixture(); const report = await f.report();
  expect(report.coverage.trackingStartedAt).toBeGreaterThanOrEqual(stamp);
  expect(report.coverage.historyImported).toBe(false);
  expect(report.previousKpis.created).toBeNull();
  expect(report.coverage.previous).toBe("none");
  expect(report.runs).toEqual([]);
  expect(report.sources.find((source) => source.id === "cost")?.status).toBe("not_tracked");
});
it("isolates organizations and workspaces before any read or tracking creation", async () => {
  const a = await fixture(), b = await fixture();
  await recordReportSnapshot(env, run(a), [], stamp - 1000);
  await expect(handleReportsRoute(new Request(a.url), env, b.userId)).rejects.toMatchObject({ status: 404 });
  const wrong = a.url.replace(a.workspaceId, b.workspaceId);
  await expect(handleReportsRoute(new Request(wrong), env, a.userId)).rejects.toMatchObject({ status: 404 });
  expect((await b.report()).runs).toEqual([]);
});
it("deduplicates facts and uses observed model usage instead of reserved run tokens", async () => {
  const f = await fixture(); const value = run(f, stamp - 1000);
  value.modelCalls = 1; value.tokens = 50000;
  const facts: ReportFact[] = [{ id: "call:1", kind: "model_started", at: stamp - 900, callId: "1", agentId: "agent-a", agentRole: "programmer", agentName: "Ana" }];
  await recordReportSnapshot(env, value, facts, stamp - 2000);
  await recordReportSnapshot(env, value, facts, stamp - 2000);
  const pending = await f.report();
  expect(pending.kpis.modelCalls).toBe(1); expect(pending.kpis.observedTokens).toBeNull(); expect(pending.kpis.unobservedModelCalls).toBe(1);
  await recordReportSnapshot(env, value, [{ ...facts[0], id: "usage:1", kind: "model_observed", at: stamp - 800, tokens: 123, durationMs: 100 }], stamp - 2000);
  const observed = await f.report();
  expect(observed.kpis.observedTokens).toBe(123); expect(observed.kpis.unobservedModelCalls).toBe(0);
  expect(observed.agents[0]).toMatchObject({ id: "agent-a", modelCalls: 1, observedTokens: 123 });
});
it("preserves cancellation, a confirmed PR, real duration and test failure when an older snapshot arrives", async () => {
  const f = await fixture(); const initial = run(f, stamp - 2000);
  const canceled: CodingRecord = { ...initial, generation: 2, status: "canceled", updatedAt: stamp - 10, approvedAt: stamp - 1500, startedAt: stamp - 1000, finishedAt: stamp - 100, publishedAt: stamp - 50, result: { branch: "veltram/fixture", commitSha: "a".repeat(40), prUrl: "https://github.com/fixture/repo/pull/1", prNumber: 1, changedFiles: 1 } };
  await recordReportSnapshot(env, canceled, [{ id: "test:1", kind: "test", at: stamp - 200, exitCode: 1 }], stamp - 3000);
  await recordReportSnapshot(env, initial, [], stamp - 3000);
  const report = await f.report();
  expect(report.kpis.canceled).toBe(1); expect(report.kpis.prsCreated).toBe(1); expect(report.kpis.testsFailed).toBe(1);
  expect(report.kpis.durationMs).toMatchObject({ median: 900, samples: 1 });
  expect(report.runs[0].status).toBe("canceled");
});
it("separates each role when the same catalogue profile performs several jobs", async () => {
  const f = await fixture(); const value = run(f, stamp - 1000);
  const facts = ["coordinator", "programmer", "reviewer"].flatMap((role, index) => [
    { id: `call:${index}`, kind: "model_started", at: stamp - 900, callId: String(index), agentId: "shared-profile", agentRole: role, agentName: "Same persona" },
    { id: `usage:${index}`, kind: "model_observed", at: stamp - 800, callId: String(index), agentId: "shared-profile", agentRole: role, agentName: "Same persona", tokens: 10 + index, durationMs: 100 },
  ]) as ReportFact[];
  await recordReportSnapshot(env, value, facts, stamp - 2000);
  const report = await f.report();
  expect(report.agents).toHaveLength(3);
  expect(report.agents.map((agent) => [agent.role, agent.modelCalls, agent.observedTokens])).toEqual([["coordinator", 1, 10], ["programmer", 1, 11], ["reviewer", 1, 12]]);
});
it("filters repository and agent without leaking unrelated rows or zeroing unavailable metrics", async () => {
  const f = await fixture(); const value = run(f, stamp - 1000);
  value.agents = [{ role: "programmer", name: "Ana", profileId: "agent-a", instructions: "fixture", provider: "openai", model: "fixture", credentialVersion: 1 }];
  await recordReportSnapshot(env, value, [], stamp - 2000);
  expect((await f.report("period=week&agentId=agent-a")).runs).toHaveLength(1);
  expect((await f.report("period=week&repositoryId=other")).runs).toHaveLength(0);
  const response = await handleReportsRoute(new Request(`${f.url}.md?period=week`), env, f.userId);
  expect(response!.headers.get("content-type")).toContain("text/markdown");
  expect(await response!.text()).toContain("Não acompanhado");
});
it("allows only administrators to change versioned report goals", async () => {
  const owner = await fixture(), member = await fixture("member");
  const body = { expectedVersion: 0, targets: { taskSuccessRate: 90, durationMinutes: 15 } };
  const response = await handleReportsRoute(new Request(`${owner.url}/goals`, { method: "PUT" }), env, owner.userId, body);
  expect(await response!.json()).toMatchObject({ version: 1, targets: body.targets });
  await expect(handleReportsRoute(new Request(`${owner.url}/goals`, { method: "PUT" }), env, owner.userId, body)).rejects.toMatchObject({ status: 409 });
  await expect(handleReportsRoute(new Request(`${member.url}/goals`, { method: "PUT" }), env, member.userId, body)).rejects.toMatchObject({ status: 403 });
});
