import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import type { AgentRole, CodingChange, CodingExecutorStub, CodingRecord, CodingRunInput, CodingTool, CodingToolResult } from "../src/coding-types";
import { codingTreeDigest } from "../src/coding-types";
import { changeCredential } from "../src/credential-store";
import { CodingRoom } from "../src/coding-room";
import type { ModelCall, ModelTurn } from "../src/model-broker";
import { agentCatalogRoute } from "../src/agent-catalog";
import type { AgentCatalogResponse } from "../src/agent-catalog-types";

// Real D1 and Durable Object steps compete with other integration files in the full suite.

const sourceSha = "a".repeat(40);
const sourceTree = "b".repeat(40);
const deliveredSha = "c".repeat(40);
const deliveredTree = "d".repeat(40);
type VisibleRecord = CodingRecord & { canApprove: boolean; canCancel: boolean };
let configured: AppEnv;
let fixtureNumber = 0;
const repositories = new Map<string, { installationId: number; repositoryId: number; fullName: string }>();
const mutations: { path: string; body: Record<string, unknown> }[] = [];
const reads: string[] = [];
const modelReply = vi.fn<(role: AgentRole, body: Record<string, unknown>, signal?: AbortSignal | null) => Promise<ModelTurn>>();
let publicationFault: { loseResponse?: boolean; failedReads?: number; accepted?: () => void; responseGate?: Promise<void> } = {};

beforeAll(async () => {
  const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
  configured = { ...env, GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "veltram-fixture", GITHUB_CLIENT_ID: "fixture-client", GITHUB_CLIENT_SECRET: "fixture-secret", GITHUB_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----`, GITHUB_WEBHOOK_SECRET: "fixture-webhook" };
});
afterEach(() => vi.restoreAllMocks());

function turn(calls: ModelCall[] = [], text = ""): ModelTurn {
  return { items: [{ role: "assistant", content: text || "Tool requested" }], calls, text, tokens: 100 };
}
function commandResult(output = "ok", exitCode = 0): CodingToolResult {
  return { output, exitCode, truncated: false, startedAt: Date.now(), finishedAt: Date.now() };
}

beforeEach(() => {
  repositories.clear(); mutations.length = 0; reads.length = 0;
  publicationFault = {};
  let programmerTurns = 0;
  modelReply.mockReset().mockImplementation(async (role) => {
    if (role === "coordinator") return turn([{ id: "plan", tool: { kind: "plan_ready", plan: "Fix validation and run the approved test." } }]);
    if (role === "reviewer") return turn([{ id: "review", tool: { kind: "submit_review", approved: true, summary: "The diff and final test receipt satisfy the requested fix." } }]);
    programmerTurns++;
    return programmerTurns % 2 === 1
      ? turn([{ id: `write-${programmerTurns}`, tool: { kind: "write_file", path: "src/validation.ts", content: `export const fixed = ${programmerTurns};\n` } }])
      : turn([], "Fixed validation and preserved the surrounding code.");
  });
  const refs = new Set<string>();
  const pulls = new Map<string, object>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = new URL(String(request));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.href === "https://api.openai.com/v1/responses") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-only-provider-key");
      const role = /Your role is (coordinator|programmer|reviewer)/.exec(String(body.instructions))?.[1] as AgentRole;
      const result = await modelReply(role, body, init?.signal);
      return Response.json({ output: [
        ...result.calls.map((call) => { const { kind, ...args } = call.tool; return { type: "function_call", call_id: call.id, name: kind, arguments: JSON.stringify(args) }; }),
        ...(result.text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: result.text }] }] : []),
      ], usage: { total_tokens: result.tokens } });
    }
    if (url.origin !== "https://api.github.com") throw new Error(`Unexpected external request ${url.origin}`);
    const path = url.pathname;
    if (path.startsWith("/app/installations/")) {
      const repository = [...repositories.values()].find((item) => path.split("/")[3] === String(item.installationId));
      if (!repository) throw new Error("Unknown fixture installation");
      if (path.endsWith("/access_tokens")) {
        expect(body.repository_ids).toEqual([repository.repositoryId]);
        return Response.json({ token: "ghs_fixture_only", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return Response.json({ id: repository.installationId, app_id: 123, account: { id: 77 }, suspended_at: null });
    }
    const fullName = path.split("/").slice(2, 4).join("/");
    const repository = repositories.get(fullName);
    if (!repository) throw new Error(`Unknown fixture repository ${fullName}`);
    const suffix = path.slice(`/repos/${fullName}`.length);
    if (init?.method === "POST") mutations.push({ path, body }); else reads.push(path);
    if (!suffix) return Response.json({ id: repository.repositoryId, full_name: fullName, owner: { id: 77 } });
    if (suffix === "/commits/main") return Response.json({ sha: sourceSha, commit: { tree: { sha: sourceTree } } });
    if (suffix === `/tarball/${sourceSha}`) return new Response("fixture archive");
    if (suffix === `/git/commits/${sourceSha}`) return Response.json({ tree: { sha: sourceTree } });
    if (suffix === `/git/commits/${deliveredSha}`) return Response.json({ sha: deliveredSha, tree: { sha: deliveredTree }, parents: [{ sha: sourceSha }] });
    if (suffix === "/git/blobs") return Response.json({ sha: "e".repeat(40) });
    if (suffix === "/git/trees") return Response.json({ sha: deliveredTree });
    if (suffix === "/git/commits") return Response.json({ sha: deliveredSha });
    if (suffix.startsWith("/git/ref/heads/")) return refs.has(`${fullName}:${suffix.slice("/git/ref/heads/".length)}`) ? Response.json({ object: { sha: deliveredSha } }) : new Response(null, { status: 404 });
    if (suffix === "/git/refs") { refs.add(`${fullName}:${String(body.ref).slice("refs/heads/".length)}`); return Response.json({ object: { sha: deliveredSha } }); }
    if (suffix === "/pulls" && init?.method === "POST") {
      expect(body.draft).toBe(true);
      const pull = { number: 1, html_url: `https://github.com/${fullName}/pull/1`, head: { sha: deliveredSha, ref: body.head, repo: { id: repository.repositoryId } }, base: { ref: "main", repo: { id: repository.repositoryId } }, state: "open" };
      pulls.set(`${fullName}:${body.head}`, pull);
      publicationFault.accepted?.();
      await publicationFault.responseGate;
      if (publicationFault.loseResponse) throw new Error("Fixture lost the accepted pull response");
      return Response.json(pull);
    }
    if (suffix === "/pulls") {
      const found = pulls.get(`${fullName}:${url.searchParams.get("head")?.split(":").slice(1).join(":")}`);
      if (found && publicationFault.failedReads && publicationFault.failedReads > 0) {
        publicationFault.failedReads--;
        throw new Error("Fixture pull lookup unavailable after the accepted write");
      }
      return Response.json(found ? [found] : []);
    }
    throw new Error(`Unexpected fixture GitHub path ${path}`);
  });
});

async function fixture() {
  const organizationId = crypto.randomUUID(), workspaceId = crypto.randomUUID(), userId = crypto.randomUUID();
  fixtureNumber++;
  const repository = { installationId: fixtureNumber, repositoryId: 1000 + fixtureNumber, fullName: `fixture-owner/coding-${fixtureNumber}` };
  repositories.set(repository.fullName, repository);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(userId, "Fixture coder", `${userId}@example.test`, Date.now(), Date.now()),
    env.DB.prepare("INSERT INTO organizations VALUES (?,?,?)").bind(organizationId, "Coding fixture", Date.now()),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,'owner')").bind(organizationId, userId),
    env.DB.prepare("INSERT INTO workspaces VALUES (?,?,?)").bind(workspaceId, organizationId, "Fixture"),
    env.DB.prepare("INSERT INTO github_installations VALUES (?,'123',?,77,'fixture-owner','active',0)").bind(repository.installationId, organizationId),
    env.DB.prepare("INSERT INTO github_repositories VALUES (?,?,?,?,?,'main','active',?,0)").bind(`repository-${fixtureNumber}`, organizationId, repository.installationId, repository.repositoryId, repository.fullName, userId),
  ]);
  await changeCredential(env, organizationId, userId, "openai", "PUT", { expectedVersion: null, key: "fixture-only-provider-key" });
  const stub = env.CODING_RUNS.getByName(organizationId);
  await runInDurableObject(stub, (instance) => { Object.assign((instance as unknown as { env: AppEnv }).env, configured); });
  return {
    organizationId, workspaceId, userId, stub, repository, connectionId: `repository-${fixtureNumber}`,
    command(action: string, body: Record<string, unknown> = {}, runId?: string, identity: Partial<{ organizationId: string; workspaceId: string; userId: string }> = {}) {
      return stub.fetch(new Request("https://coding-room.internal/", { method: "POST", body: JSON.stringify({ organizationId, workspaceId, userId, ...identity, action, body, runId }) }));
    },
    alarm() { return runDurableObjectAlarm(stub); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(overrides: Partial<CodingRunInput> = {}): CodingRunInput {
  return { requestId: crypto.randomUUID(), repositoryConnectionId: "fixture-repository", baseRef: "main", task: "Fix the validation failure", provider: "openai", model: "fixture-model", setupCommand: "", testCommand: "npm test", ...overrides };
}
async function create(f: Fixture, body = input({ repositoryConnectionId: f.connectionId })) {
  const response = await f.command("create", { ...body });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { run: VisibleRecord }).run;
}
async function get(f: Fixture, runId: string) {
  const response = await f.command("get", {}, runId);
  expect(response.status).toBe(200);
  return (await response.json() as { run: VisibleRecord }).run;
}
async function approve(f: Fixture, run: CodingRecord) {
  const response = await f.command("approve", { generation: run.generation }, run.runId);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as { run: VisibleRecord }).run;
}
async function drain(f: Fixture, runId: string) {
  for (let count = 0; count < 80; count++) {
    await f.alarm();
    const run = await get(f, runId);
    if (["completed", "failed", "canceled", "interrupted"].includes(run.status)) return run;
  }
  throw new Error("Fixture did not reach a terminal state within 80 durable steps");
}
async function fakeExecutor(f: Fixture, options: {
  command?: (tool: Extract<CodingTool, { kind: "run_command" }>, calls: number) => CodingToolResult | Promise<CodingToolResult>;
  stop?: () => Promise<void>;
  mutateOnTest?: boolean;
} = {}) {
  let files: CodingChange[] = [];
  let commandCalls = 0;
  const executor: CodingExecutorStub = {
    init: vi.fn(async (value) => { await new Response(value.archive).arrayBuffer(); return { ready: true as const }; }),
    step: vi.fn(async ({ tool }) => {
      if (tool.kind === "write_file") { files = [{ path: tool.path, content: tool.content, mode: "100644" }]; return commandResult("file written"); }
      if (tool.kind === "run_command") {
        commandCalls++;
        if (options.mutateOnTest) files = [{ ...files[0], content: "modified by tests\n" }];
        return options.command ? options.command(tool, commandCalls) : commandResult("2 tests passed", 0);
      }
      return commandResult("source content");
    }),
    snapshot: vi.fn(async () => ({ files: structuredClone(files), treeDigest: await codingTreeDigest(files) })),
    reviewDiff: vi.fn(async () => commandResult(files.map((file) => `diff --git a/${file.path} b/${file.path}\n+${file.content ?? "deleted file"}`).join("\n"))),
    stop: vi.fn(options.stop ?? (async () => {})),
  };
  await runInDurableObject(f.stub, (instance) => { (instance as unknown as { env: AppEnv }).env.CODING_EXECUTORS = { getByName: () => executor }; });
  return executor;
}

it("runs coordinator, programmer and reviewer in a durable workflow before publishing the tested manifest", async () => {
  const f = await fixture();
  const executor = await fakeExecutor(f);
  const run = await create(f);
  expect(run.agents?.map((agent) => agent.role)).toEqual(["coordinator", "programmer", "reviewer"]);
  expect(run.status).toBe("pending_approval");
  expect(modelReply).not.toHaveBeenCalled();
  await approve(f, run);
  const completed = await drain(f, run.runId);
  expect(completed.status).toBe("completed");
  expect(completed.plan).toContain("approved test");
  expect(completed.review?.approved).toBe(true);
  expect(completed.verification).toMatchObject({ command: "npm test", exitCode: 0, output: "2 tests passed" });
  expect(completed.result).toMatchObject({ commitSha: deliveredSha, prNumber: 1, changedFiles: 1 });
  expect(executor.init).toHaveBeenCalledTimes(1);
  expect(executor.reviewDiff).toHaveBeenCalledTimes(1);
  expect(executor.step).toHaveBeenCalledWith(expect.objectContaining({ tool: expect.objectContaining({ kind: "run_command", command: "npm test" }) }));
  expect(reads.filter((path) => path.includes("/tarball/"))).toHaveLength(1);
  expect(mutations.filter((call) => call.path.endsWith("/pulls"))).toHaveLength(1);
  expect(modelReply).toHaveBeenCalledTimes(4);
  expect(modelReply.mock.calls.map(([role]) => role)).toEqual(["coordinator", "programmer", "programmer", "reviewer"]);
  expect(mutations.find((call) => call.path.endsWith("/git/commits"))?.body.parents).toEqual([sourceSha]);
  expect(mutations.find((call) => call.path.endsWith("/git/blobs"))?.body.content).toBe("export const fixed = 1;\n");
  expect(await codingTreeDigest([{ path: "src/validation.ts", content: "export const fixed = 1;\n", mode: "100644" }])).toBe(completed.verification?.treeDigest);
  expect(executor.stop).toHaveBeenCalled();
  const leases = await runInDurableObject(env.CODING_ADMISSION.getByName("global"), (_instance, state) => state.storage.get("leases"));
  expect(leases).toEqual([]);
});

it("records report facts from the durable workflow with real timestamps and observed tokens by agent", async () => {
  const f = await fixture(); await fakeExecutor(f);
  const run = await create(f); await approve(f, run);
  const completed = await drain(f, run.runId);
  expect(completed.status).toBe("completed");
  const synced = await f.command("report-sync");
  expect(synced.status).toBe(200);
  const stored = await env.DB.prepare("SELECT snapshot FROM report_runs WHERE organization_id=? AND workspace_id=? AND run_id=?").bind(f.organizationId, f.workspaceId, run.runId).first<{ snapshot: string }>();
  const snapshot = JSON.parse(stored!.snapshot);
  expect(snapshot.approvedAt).toBeGreaterThanOrEqual(snapshot.createdAt);
  expect(snapshot.startedAt).toBeGreaterThanOrEqual(snapshot.approvedAt);
  expect(snapshot.finishedAt).toBeGreaterThanOrEqual(snapshot.startedAt);
  const facts = (await env.DB.prepare("SELECT fact FROM report_facts WHERE organization_id=? AND run_id=?").bind(f.organizationId, run.runId).all<{ fact: string }>()).results.map((row) => JSON.parse(row.fact));
  expect(facts.filter((fact) => fact.kind === "model_started")).toHaveLength(4);
  expect(facts.filter((fact) => fact.kind === "model_observed").reduce((sum, fact) => sum + fact.tokens, 0)).toBe(400);
  expect(new Set(facts.filter((fact) => fact.kind === "model_observed").map((fact) => fact.agentRole))).toEqual(new Set(["coordinator", "programmer", "reviewer"]));
  expect(facts.filter((fact) => fact.kind === "test")).toHaveLength(1);
  await f.command("report-sync");
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM report_facts WHERE organization_id=? AND run_id=?").bind(f.organizationId, run.runId).first<{ n: number }>())?.n).toBe(facts.length);
});

it("replays canonical agent selections but rejects dropping them from an existing request", async () => {
  const f = await fixture();
  const catalog = await (await agentCatalogRoute(env, f.organizationId, f.userId, "POST", { expectedVersion: 0, requestId: crypto.randomUUID(), agents: [{ sourceId: "fixture-persona", name: "Fixture", title: "Team", description: "Fixture only", instructions: "Check the task", section: "Team", sourceEngine: "codex", sourceModel: "fixture-model", sourceEffort: "medium" }] }, true)).json() as AgentCatalogResponse;
  const id = catalog.agents[0].id;
  const body = input({ repositoryConnectionId: f.connectionId, agentSelections: { catalogVersion: catalog.version, coordinator: id, programmer: id, reviewer: id } });
  const created = await create(f, body);
  const replay = await f.command("create", { ...body, agentSelections: { reviewer: id, programmer: id, coordinator: id, catalogVersion: catalog.version } });
  expect(replay.status).toBe(200);
  expect((await replay.json() as { run: CodingRecord }).run.runId).toBe(created.runId);
  const omitted = { ...body }; delete omitted.agentSelections;
  const response = await f.command("create", omitted);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "request_id_reused" });
});

it("retries the durable reporting outbox after D1 recovery without starting a coding task", async () => {
  const f = await fixture();
  const database = env.DB;
  await runInDurableObject(f.stub, (instance) => {
    const bound = (instance as unknown as { env: AppEnv }).env; const real = bound.DB;
    bound.DB = new Proxy(real, { get(target, property) {
      if (property === "prepare") return (sql: string) => { if (sql.includes("report_")) throw new Error("Fixture reporting database unavailable"); return target.prepare(sql); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  const run = await create(f);
  expect(await (await f.command("report-sync")).json()).toEqual({ synced: false });
  expect(await runInDurableObject(f.stub, (_instance, state) => state.storage.get(`report-pending:${run.runId}`))).toBe(true);
  await runInDurableObject(f.stub, (instance) => { (instance as unknown as { env: AppEnv }).env.DB = database; });
  await f.alarm();
  expect(await runInDurableObject(f.stub, (_instance, state) => state.storage.get(`report-pending:${run.runId}`))).toBeUndefined();
  const row = await env.DB.prepare("SELECT snapshot FROM report_runs WHERE organization_id=? AND run_id=?").bind(f.organizationId, run.runId).first<{ snapshot: string }>();
  expect(JSON.parse(row!.snapshot).status).toBe("pending_approval");
  expect(modelReply).not.toHaveBeenCalled();
  expect(mutations).toHaveLength(0);
});

it("recovers an accepted PR through read-only reconciliation after its response and first lookup are lost", async () => {
  const f = await fixture(); await fakeExecutor(f);
  publicationFault = { loseResponse: true, failedReads: 1 };
  const run = await create(f); await approve(f, run);
  const completed = await drain(f, run.runId);
  expect(completed.status).toBe("completed");
  expect(completed.error).toBeUndefined();
  expect(completed.result).toMatchObject({ prUrl: `https://github.com/${f.repository.fullName}/pull/1`, prNumber: 1, commitSha: deliveredSha, changedFiles: 1 });
  expect(completed.events.some((event) => event.text.includes("recuperada por leitura"))).toBe(true);
  expect(reads.filter((path) => path.endsWith("/pulls"))).toHaveLength(3);
  expect(mutations.filter((call) => call.path.endsWith("/git/refs"))).toHaveLength(1);
  expect(mutations.filter((call) => call.path.endsWith("/pulls"))).toHaveLength(1);
});

it("preserves explicit publication uncertainty when GitHub accepted a PR but its receipt remains unreadable", async () => {
  const f = await fixture(); const executor = await fakeExecutor(f);
  publicationFault = { loseResponse: true, failedReads: Infinity };
  const run = await create(f); await approve(f, run);
  const interrupted = await drain(f, run.runId);
  expect(interrupted.status).toBe("interrupted");
  expect(interrupted.error).toBe("coding_publication_uncertain");
  expect(interrupted.result).toBeUndefined();
  expect(interrupted.verification?.exitCode).toBe(0);
  expect(reads.filter((path) => path.endsWith("/pulls"))).toHaveLength(3);
  const writes = mutations.length;
  await f.alarm();
  expect(mutations).toHaveLength(writes);
  expect(mutations.filter((call) => call.path.endsWith("/pulls"))).toHaveLength(1);
  expect(executor.stop).toHaveBeenCalled();
});

it.each([
  { label: "subsequent lookup available", failedReads: 0 },
  { label: "subsequent lookup unavailable", failedReads: Infinity },
])("keeps cancellation and attaches the known PR when cancellation races an accepted GitHub publication ($label)", async ({ failedReads }) => {
  const f = await fixture(); const executor = await fakeExecutor(f);
  let release!: () => void;
  let accepted = false;
  publicationFault = { failedReads, accepted: () => { accepted = true; }, responseGate: new Promise<void>((resolve) => { release = resolve; }) };
  const run = await create(f); await approve(f, run);
  const publication = drain(f, run.runId);
  let writesAtCancel = 0;
  try {
    await expect.poll(() => accepted, { timeout: 15_000 }).toBe(true);
    writesAtCancel = mutations.length;
    expect((await f.command("cancel", { generation: run.generation }, run.runId)).status).toBe(200);
    expect((await get(f, run.runId)).status).toBe("canceled");
  } finally {
    release();
    await publication;
  }
  const canceled = await get(f, run.runId);
  expect(canceled.status).toBe("canceled");
  expect(canceled.generation).toBe(run.generation + 1);
  expect(canceled.error).toBeUndefined();
  expect(canceled.result).toMatchObject({ prUrl: `https://github.com/${f.repository.fullName}/pull/1`, prNumber: 1, commitSha: deliveredSha, changedFiles: 1 });
  expect(mutations).toHaveLength(writesAtCancel);
  expect(mutations.filter((call) => call.path.endsWith("/pulls"))).toHaveLength(1);
  expect(executor.stop).toHaveBeenCalled();
});

it("recovers a canceled publication after coordinator restart without waiting for the lost continuation", async () => {
  const f = await fixture(); await fakeExecutor(f);
  let release!: () => void;
  let accepted = false;
  publicationFault = { accepted: () => { accepted = true; }, responseGate: new Promise<void>((resolve) => { release = resolve; }) };
  const run = await create(f); await approve(f, run);
  const interruptedContinuation = drain(f, run.runId);
  let writesAtCancel = 0;
  try {
    await expect.poll(() => accepted, { timeout: 15_000 }).toBe(true);
    writesAtCancel = mutations.length;
    expect((await f.command("cancel", { generation: run.generation }, run.runId)).status).toBe(200);
    // A fresh coordinator shares only durable state. The old POST response remains blocked.
    await runInDurableObject(f.stub, async (instance, state) => {
      const restarted = new CodingRoom(state, (instance as unknown as { env: AppEnv }).env);
      await restarted.alarm();
    });
    const recovered = await get(f, run.runId);
    expect(recovered.status).toBe("canceled");
    expect(recovered.generation).toBe(run.generation + 1);
    expect(recovered.error).toBeUndefined();
    expect(recovered.result).toMatchObject({ prNumber: 1, commitSha: deliveredSha, changedFiles: 1 });
    expect(mutations).toHaveLength(writesAtCancel);
  } finally {
    release();
    await interruptedContinuation;
  }
  expect(mutations.filter((call) => call.path.endsWith("/pulls"))).toHaveLength(1);
  expect(mutations).toHaveLength(writesAtCancel);
});

it("isolates company/workspace state and makes request retries idempotent without accepting changed input", async () => {
  const a = await fixture(), b = await fixture();
  const body = input({ repositoryConnectionId: a.connectionId });
  const first = await create(a, body);
  const repeated = await a.command("create", { ...body });
  expect(repeated.status).toBe(200);
  expect((await repeated.json() as { run: CodingRecord }).run.runId).toBe(first.runId);
  expect((await a.command("create", { ...body, task: "Different task" })).status).toBe(409);
  expect((await a.command("get", {}, first.runId, { userId: b.userId })).status).toBe(404);
  expect((await b.command("get", {}, first.runId)).status).toBe(404);
  expect((await a.command("list", {}, undefined, { organizationId: b.organizationId, workspaceId: b.workspaceId, userId: b.userId })).status).toBe(404);
  const otherWorkspace = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO workspaces VALUES (?,?,?)").bind(otherWorkspace, a.organizationId, "Other").run();
  expect((await a.command("get", {}, first.runId, { workspaceId: otherWorkspace })).status).toBe(404);
  expect((await a.command("create", { ...body }, undefined, { workspaceId: otherWorkspace })).status).toBe(409);
  expect(modelReply).not.toHaveBeenCalled();
  expect(mutations).toHaveLength(0);
});

it("requires current administration and generation before approval, and fences stale actions after cancel", async () => {
  const f = await fixture(), outsider = await fixture();
  await fakeExecutor(f);
  const run = await create(f);
  await env.DB.prepare("INSERT INTO memberships VALUES (?,?,'member')").bind(f.organizationId, outsider.userId).run();
  expect((await f.command("approve", { generation: run.generation }, run.runId, { userId: outsider.userId })).status).toBe(403);
  expect((await f.command("cancel", { generation: run.generation }, run.runId, { userId: outsider.userId })).status).toBe(403);
  expect((await f.command("approve", { generation: run.generation - 1 }, run.runId)).status).toBe(409);
  await approve(f, run);
  expect((await f.command("approve", { generation: run.generation }, run.runId)).status).toBe(409);
  expect((await f.command("cancel", { generation: run.generation - 1 }, run.runId)).status).toBe(409);
  const canceled = await f.command("cancel", { generation: run.generation }, run.runId);
  expect(canceled.status).toBe(200);
  expect((await canceled.json() as { run: CodingRecord }).run.generation).toBe(run.generation + 1);
  expect((await f.command("approve", { generation: run.generation }, run.runId)).status).toBe(409);
  await f.alarm();
  expect(modelReply).not.toHaveBeenCalled();
  expect(mutations).toHaveLength(0);
});

it("does not accept a late model result after cancellation or perform subsequent commands", async () => {
  const f = await fixture();
  const executor = await fakeExecutor(f);
  let complete!: (value: ModelTurn) => void;
  let modelSignal: AbortSignal | null | undefined;
  let started = false;
  const pending = new Promise<ModelTurn>((resolve) => { complete = resolve; });
  modelReply.mockImplementation(async (_role, _body, signal) => { modelSignal = signal; started = true; return pending; });
  const run = await create(f); await approve(f, run);
  await f.alarm(); // Source checkout, the next durable step is the first model call.
  const modelStep = f.alarm();
  try {
    await expect.poll(() => started, { timeout: 15_000 }).toBe(true);
    expect((await f.command("cancel", { generation: run.generation }, run.runId)).status).toBe(200);
    expect(modelSignal?.aborted).toBe(true);
  } finally {
    complete(turn([{ id: "late-plan", tool: { kind: "plan_ready", plan: "This response arrived after cancellation" } }]));
    await modelStep;
  }
  const canceled = await get(f, run.runId);
  expect(canceled.status).toBe("canceled");
  expect(canceled.plan).toBeUndefined();
  expect(canceled.result).toBeUndefined();
  expect(executor.step).not.toHaveBeenCalled();
  expect(executor.stop).toHaveBeenCalled();
  expect(mutations).toHaveLength(0);
  await f.command("report-sync");
  const observed = await env.DB.prepare("SELECT fact FROM report_facts WHERE organization_id=? AND run_id=? AND fact_id LIKE 'model-usage:%'").bind(f.organizationId, run.runId).all<{ fact: string }>();
  expect(observed.results).toHaveLength(1);
  expect(JSON.parse(observed.results[0].fact).tokens).toBe(100);
  const snapshot = await env.DB.prepare("SELECT snapshot FROM report_runs WHERE organization_id=? AND run_id=?").bind(f.organizationId, run.runId).first<{ snapshot: string }>();
  expect(JSON.parse(snapshot!.snapshot).status).toBe("canceled");
});

it("canceling a pending task does not abort a different active task's model call", async () => {
  const f = await fixture();
  await fakeExecutor(f);
  const active = await create(f), pendingRun = await create(f);
  let complete!: (value: ModelTurn) => void;
  let signal: AbortSignal | null | undefined;
  let started = false;
  const pending = new Promise<ModelTurn>((resolve) => { complete = resolve; });
  modelReply.mockImplementation(async (_role, _body, currentSignal) => { signal = currentSignal; started = true; return pending; });
  await approve(f, active); await f.alarm();
  const modelStep = f.alarm();
  try {
    await expect.poll(() => started, { timeout: 15_000 }).toBe(true);
    expect((await f.command("cancel", { generation: pendingRun.generation }, pendingRun.runId)).status).toBe(200);
    expect(signal?.aborted).toBe(false);
    expect((await get(f, active.runId)).status).toBe("running");
    expect((await get(f, pendingRun.runId)).status).toBe("canceled");
  } finally { complete(turn([{ id: "valid-plan", tool: { kind: "plan_ready", plan: "Continue the active task" } }])); await modelStep; }
  expect((await get(f, active.runId)).status).toBe("running");
  await f.command("cancel", { generation: active.generation }, active.runId); await f.alarm();
});

for (const phase of ["model", "publish"] as const) {
  it(`interrupts an uncertain ${phase} dispatch after recovery without replaying the effect`, async () => {
    const f = await fixture(); const executor = await fakeExecutor(f);
    const run = await create(f); await approve(f, run);
    await runInDurableObject(f.stub, async (_instance, state) => {
      const entry = await state.storage.get<{ phase: string; dispatched: boolean }>(`run:${run.runId}`);
      entry!.phase = phase; entry!.dispatched = true;
      await state.storage.put(`run:${run.runId}`, entry);
    });
    await f.alarm();
    const result = await get(f, run.runId);
    expect(result.status).toBe("interrupted");
    expect(result.error).toBe(phase === "publish" ? "coding_publication_uncertain" : "coding_step_uncertain");
    await f.alarm();
    expect(modelReply).not.toHaveBeenCalled();
    expect(executor.init).not.toHaveBeenCalled();
    expect(executor.step).not.toHaveBeenCalled();
    expect(executor.stop).toHaveBeenCalled();
    expect(mutations).toHaveLength(0);
  });
}

it("returns a failing final test to the programmer and publishes only the repaired, retested content", async () => {
  const f = await fixture();
  const executor = await fakeExecutor(f, { command: (_tool, count) => count === 1 ? commandResult("expected true, received false", 1) : commandResult("2 tests passed", 0) });
  const run = await create(f); await approve(f, run);
  const result = await drain(f, run.runId);
  expect(result.status).toBe("completed");
  expect(result.events.filter((event) => event.kind === "test").map((event) => event.exitCode)).toEqual([1, 0]);
  expect(result.verification?.exitCode).toBe(0);
  const testCalls = vi.mocked(executor.step).mock.calls.filter(([value]) => value.tool.kind === "run_command");
  expect(testCalls).toHaveLength(2);
  expect(mutations.filter((call) => call.path.endsWith("/git/blobs")).map((call) => call.body.content)).toEqual(["export const fixed = 3;\n"]);
  expect(result.verification?.treeDigest).toBe(await codingTreeDigest([{ path: "src/validation.ts", content: "export const fixed = 3;\n", mode: "100644" }]));
  expect(modelReply.mock.calls.some(([role, body]) => role === "programmer" && JSON.stringify(body.input).includes("Final approved test failed with exit 1"))).toBe(true);
});

it("allows reviewer-requested corrections only after a fresh final test", async () => {
  const f = await fixture(); const executor = await fakeExecutor(f);
  const defaultReply = modelReply.getMockImplementation()!;
  let reviews = 0;
  modelReply.mockImplementation(async (role, body, signal) => {
    if (role === "reviewer") return turn([{ id: `review-${++reviews}`, tool: { kind: "submit_review", approved: reviews > 1, summary: reviews === 1 ? "Handle the empty input case." : "The correction and new tests satisfy the request." } }]);
    return defaultReply(role, body, signal);
  });
  const run = await create(f); await approve(f, run);
  const result = await drain(f, run.runId);
  expect(result.status).toBe("completed");
  expect(reviews).toBe(2);
  expect(result.review?.approved).toBe(true);
  const reviewCalls = modelReply.mock.calls.filter(([role]) => role === "reviewer");
  expect(JSON.stringify(reviewCalls[0][1].input)).toContain("export const fixed = 1");
  expect(JSON.stringify(reviewCalls[1][1].input)).toContain("export const fixed = 3");
  expect(vi.mocked(executor.step).mock.calls.filter(([value]) => value.tool.kind === "run_command")).toHaveLength(2);
  expect(mutations.filter((call) => call.path.endsWith("/pulls"))).toHaveLength(1);
  expect(mutations.find((call) => call.path.endsWith("/git/blobs"))?.body.content).toBe("export const fixed = 3;\n");
});

it("stops repeated reviewer rejection without publishing a PR despite passing commands", async () => {
  const f = await fixture(); await fakeExecutor(f);
  const defaultReply = modelReply.getMockImplementation()!;
  modelReply.mockImplementation(async (role, body, signal) => role === "reviewer"
    ? turn([{ id: "reject", tool: { kind: "submit_review", approved: false, summary: "The change still violates the requested behavior." } }])
    : defaultReply(role, body, signal));
  const run = await create(f); await approve(f, run);
  const result = await drain(f, run.runId);
  expect(result.status).toBe("failed");
  expect(result.error).toBe("coding_review_rejected");
  expect(result.review?.approved).toBe(false);
  expect(result.verification?.exitCode).toBe(0);
  expect(result.result).toBeUndefined();
  expect(mutations).toHaveLength(0);
});

it("rejects a test that changes the delivered tree even when its exit code is zero", async () => {
  const f = await fixture(); await fakeExecutor(f, { mutateOnTest: true });
  const run = await create(f); await approve(f, run);
  const result = await drain(f, run.runId);
  expect(result.status).toBe("failed");
  expect(result.error).toBe("coding_tree_changed_during_tests");
  expect(result.verification?.exitCode).toBe(0);
  expect(result.result).toBeUndefined();
  expect(modelReply.mock.calls.some(([role]) => role === "reviewer")).toBe(false);
  expect(mutations).toHaveLength(0);
});

it("retains capacity after failed cleanup and releases it only after confirmed executor stop", async () => {
  const f = await fixture();
  let stopConfirmed = false;
  await fakeExecutor(f, { stop: async () => { if (!stopConfirmed) throw new Error("Fixture teardown pending"); } });
  const run = await create(f); await approve(f, run);
  expect((await drain(f, run.runId)).status).toBe("completed");
  const next = await create(f);
  expect((await f.command("approve", { generation: next.generation }, next.runId)).status).toBe(429);
  const admission = env.CODING_ADMISSION.getByName("global");
  const before = await runInDurableObject(admission, (_instance, state) => state.storage.get<unknown[]>("leases"));
  expect(before).toHaveLength(1);
  await f.alarm();
  expect(await runInDurableObject(admission, (_instance, state) => state.storage.get<unknown[]>("leases"))).toHaveLength(1);
  stopConfirmed = true; await f.alarm();
  expect(await runInDurableObject(admission, (_instance, state) => state.storage.get("leases"))).toEqual([]);
  await approve(f, next);
  await f.command("cancel", { generation: next.generation }, next.runId); await f.alarm();
});

it("rechecks frozen credential versions before model calls after a key rotation", async () => {
  const f = await fixture(); const executor = await fakeExecutor(f);
  const run = await create(f); await approve(f, run); await f.alarm();
  await changeCredential(env, f.organizationId, f.userId, "openai", "PUT", { expectedVersion: 1, key: "fixture-rotated-provider-key" });
  const result = await drain(f, run.runId);
  expect(result.status).toBe("failed"); expect(result.error).toBe("coding_key_changed");
  expect(modelReply).not.toHaveBeenCalled(); expect(executor.stop).toHaveBeenCalled(); expect(mutations).toHaveLength(0);
});
