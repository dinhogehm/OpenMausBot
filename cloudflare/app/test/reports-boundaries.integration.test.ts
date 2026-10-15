import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { CodingRecord } from "../src/coding-types";
import type { ExecutionReport, ReportFact } from "../src/report-types";
import { resolveReportQuery } from "../src/report-period";
import { handleReportsRoute, recordReportSnapshot } from "../src/reports";

const day = 86400000;
const boundary = resolveReportQuery(new URLSearchParams("period=day"), Date.now()).period.from - day;
const date = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
async function fixture() {
  const organizationId = crypto.randomUUID(), workspaceId = crypto.randomUUID(), userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(userId, "Boundary fixture", `${userId}@example.test`, boundary, boundary),
    env.DB.prepare("INSERT INTO organizations VALUES (?,?,?)").bind(organizationId, "Boundary fixture", boundary),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,?)").bind(organizationId, userId, "owner"),
    env.DB.prepare("INSERT INTO workspaces VALUES (?,?,?)").bind(workspaceId, organizationId, "Fixture"),
  ]);
  const runId = crypto.randomUUID();
  const run: CodingRecord = { runId, organizationId, workspaceId, requestId: runId, generation: 1, deadlineAt: boundary + day, repositoryConnectionId: "boundary-repo", repositoryName: "fixture/repo", baseRef: "main", task: "Verify period boundaries", provider: "openai", model: "fixture", setupCommand: "", testCommand: "npm test", createdBy: userId, credentialVersion: 1, createdAt: boundary - 10000, updatedAt: boundary - 1000, status: "running", modelCalls: 1, tokens: 50000, events: [], agents: [{ role: "programmer", profileId: "boundary-agent", name: "Programmer", instructions: "Fixture only", provider: "openai", model: "fixture", credentialVersion: 1 }] };
  return { run, async report(at: number) {
    const query = `period=custom&from=${date(at)}&to=${date(at)}`;
    const response = await handleReportsRoute(new Request(`https://cloud-app.example.test/api/organizations/${organizationId}/workspaces/${workspaceId}/reports?${query}`), env, userId);
    return await response!.json() as ExecutionReport;
  } };
}

it("assigns model starts and observed usage to their own days without rewriting an earlier cutoff", async () => {
  const f = await fixture();
  const identity = { callId: "cross-midnight", agentId: "boundary-agent", agentRole: "programmer" as const, agentName: "Programmer" };
  const facts: ReportFact[] = [
    { id: "start:cross-midnight", kind: "model_started", at: boundary - 1000, ...identity },
    { id: "usage:cross-midnight", kind: "model_observed", at: boundary + 1000, ...identity, tokens: 123, durationMs: 2000 },
  ];
  await recordReportSnapshot(env, f.run, facts, boundary - 3 * day);
  const earlier = await f.report(boundary - day), later = await f.report(boundary);
  expect(earlier.kpis).toMatchObject({ modelCalls: 1, observedTokens: null, unobservedModelCalls: 1 });
  expect(later.kpis).toMatchObject({ modelCalls: 0, observedTokens: 123, unobservedModelCalls: 0 });
  expect(later.agents).toEqual([expect.objectContaining({ id: "boundary-agent", modelCalls: 0, observedTokens: 123, modelDurationMs: 2000 })]);
  expect(earlier.buckets.reduce((sum, bucket) => sum + (bucket.observedTokens ?? 0), 0)).toBe(0);
  expect(later.buckets.reduce((sum, bucket) => sum + (bucket.observedTokens ?? 0), 0)).toBe(123);
});

it("a PR receipt confirmed after cancellation adds publication evidence without moving the duration sample", async () => {
  const f = await fixture();
  const canceled: CodingRecord = { ...f.run, generation: 2, status: "canceled", approvedAt: boundary - 9000, startedAt: boundary - 8000, finishedAt: boundary - 2000, updatedAt: boundary - 2000 };
  await recordReportSnapshot(env, canceled, [], boundary - 3 * day);
  await recordReportSnapshot(env, { ...canceled, updatedAt: boundary + 2000, publishedAt: boundary + 1000, result: { branch: "veltram/fixture", commitSha: "a".repeat(40), prUrl: "https://github.com/fixture/repo/pull/1", prNumber: 1, changedFiles: 1 } }, [], boundary - 3 * day);
  const earlier = await f.report(boundary - day), later = await f.report(boundary);
  expect(earlier.kpis).toMatchObject({ canceled: 1, prsCreated: 0, durationMs: { median: 6000, p90: 6000, samples: 1 }, approvalWaitMs: { median: 1000, samples: 1 } });
  expect(later.kpis).toMatchObject({ canceled: 0, prsCreated: 1, durationMs: { median: null, p90: null, samples: 0 } });
  expect(later.runs[0]).toMatchObject({ status: "canceled", finishedAt: canceled.finishedAt, publishedAt: boundary + 1000 });
});

it("cancellation before execution does not create a zero-duration sample", async () => {
  const f = await fixture();
  await recordReportSnapshot(env, { ...f.run, status: "canceled", generation: 2, finishedAt: boundary + 1000, updatedAt: boundary + 1000 }, [], boundary - 3 * day);
  const report = await f.report(boundary);
  expect(report.kpis.canceled).toBe(1);
  expect(report.kpis.durationMs).toEqual({ median: null, p90: null, samples: 0 });
  expect(report.kpis.approvalWaitMs).toEqual({ median: null, p90: null, samples: 0 });
});
