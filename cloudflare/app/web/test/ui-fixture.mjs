// UI-only fixture: synthetic API responses, no GitHub, model or production calls.
// Run after `pnpm build`, then inspect the loopback URL printed below.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const assets = resolve(fileURLToPath(new URL("../../dist/", import.meta.url)));
const fixtureAgents = ["coordinator", "programmer", "reviewer"].map((role, index) => ({ role,
  name: ["Coordenador", "Programador", "Revisor"][index], instructions: "Instruções sintéticas desta fixture de interface.", provider: "inherit", model: "" }));
let team = { version: 0, agents: fixtureAgents };
const connections = [{ id: "repo-fixture", repositoryId: 1, installationId: 1, fullName: "fixture-owner/example", defaultBranch: "main", status: "active" }];
const base = {
  runId: "fixture-completed", organizationId: "fixture-company", workspaceId: "fixture-workspace", generation: 1, deadlineAt: Date.now() + 60_000,
  requestId: "fixture-request", repositoryConnectionId: "repo-fixture", repositoryName: "fixture-owner/example", baseRef: "main",
  task: "Fixture de interface: corrigir validação de entrada", provider: "openai", model: "fixture-model", setupCommand: "npm ci", testCommand: "npm test",
  createdBy: "fixture-user", credentialVersion: 1, createdAt: Date.now() - 60_000, updatedAt: Date.now(),
  status: "completed", modelCalls: 3, tokens: 200, canApprove: false, canCancel: false,
  agents: fixtureAgents.map((agent) => ({ ...agent, provider: "openai", model: "fixture-model", credentialVersion: 1 })),
  summary: "Resumo sintético para verificar a interface. Nenhum código foi gerado por esta fixture.",
  plan: "Plano sintético: ler o arquivo, ajustar a validação e verificar os testes.",
  review: { approved: true, summary: "Parecer sintético para verificar a apresentação da revisão.", at: Date.now() },
  events: [{ id: 1, at: Date.now(), kind: "test", text: "Saída sintética da fixture: 2 passed", exitCode: 0 }],
  verification: { command: "npm test", exitCode: 0, treeDigest: "fixture-digest", output: "Saída sintética da fixture: 2 passed", finishedAt: Date.now(), truncated: false },
  result: { branch: "veltram/fixture-completed", commitSha: "fixture-commit", prUrl: "https://github.com/fixture-owner/example/pull/1", prNumber: 1, changedFiles: 1 },
};
const runs = [base, { ...base, runId: "fixture-failed", createdAt: base.createdAt - 1000, task: "Fixture: testes com falha", status: "failed", result: undefined, review: undefined,
  verification: { ...base.verification, exitCode: 1, output: "Saída sintética da fixture: expected true, received false" } }];
function json(response, value, status = 200) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (url.pathname === "/api/session") return json(response, { user: { id: "fixture-user", name: "Conta de teste", email: "fixture@example.invalid" } });
    if (url.pathname === "/api/organizations") return json(response, { organizations: [
      { id: "fixture-company", name: "Empresa de teste · fixture", role: "owner" }, { id: "fixture-empty", name: "Outra empresa · fixture", role: "member" },
    ] });
    const empty = url.pathname.includes("/fixture-empty/");
    if (url.pathname.endsWith("/workspaces")) return json(response, { workspaces: [{ id: empty ? "empty-workspace" : "fixture-workspace", name: "Fixture" }] });
    if (url.pathname.endsWith("/github")) return json(response, { configured: !empty, connections: empty ? [] : connections, pending: empty ? null : { installations: [{ id: 1, account: "fixture-owner", repositories: [{ id: 1, fullName: "fixture-owner/example", defaultBranch: "main" }, { id: 2, fullName: "fixture-owner/another", defaultBranch: "main" }] }] }, installUrl: null });
    if (url.pathname.endsWith("/github/repositories") && request.method === "POST") {
      const connection = { id: "repo-another", repositoryId: body.repositoryId, installationId: body.installationId, fullName: "fixture-owner/another", defaultBranch: "main", status: "active" };
      connections.push(connection); return json(response, { connection }, 201);
    }
    if (url.pathname.includes("/github/repositories/") && request.method === "DELETE") {
      const connection = connections.find((item) => item.id === url.pathname.split("/").at(-1));
      if (connection) connection.status = "revoked";
      return json(response, { revoked: true });
    }
    if (url.pathname.endsWith("/credentials")) return json(response, { credentials: empty ? [] : [{ provider: "openai", version: 1, status: "configured", updatedAt: Date.now() }] });
    if (url.pathname.endsWith("/agents")) {
      if (request.method === "PUT") team = { version: team.version + 1, agents: body.agents };
      return json(response, empty ? { version: 0, agents: fixtureAgents } : team);
    }
    if (url.pathname.endsWith("/coding-runs")) {
      if (request.method !== "POST") return json(response, { runs: empty ? [] : runs });
      const run = { ...base, ...body, runId: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), generation: 0,
        status: "pending_approval", events: [], modelCalls: 0, tokens: 0, canApprove: true, canCancel: true, verification: undefined, result: undefined, summary: undefined, plan: undefined, review: undefined };
      runs.unshift(run); return json(response, { run }, 201);
    }
    const action = url.pathname.match(/\/coding-runs\/([^/]+)\/(approve|cancel)$/);
    if (action) {
      const run = runs.find((item) => item.runId === action[1]);
      if (!run) return json(response, { error: "not_found" }, 404);
      run.status = action[2] === "approve" ? "running" : "canceled";
      run.agentStage = "coordinator"; run.generation++; run.updatedAt = Date.now(); run.canApprove = false; run.canCancel = action[2] === "approve";
      return json(response, { run });
    }
    if (url.pathname.endsWith("/runs")) return json(response, { runs: [] });
    if (url.pathname.startsWith("/api/")) return json(response, { error: "fixture_route_not_found" }, 404);
    const path = resolve(assets, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!path.startsWith(`${assets}${sep}`)) return json(response, { error: "not_found" }, 404);
    response.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html", "cache-control": "no-store" });
    response.end(await readFile(path));
  } catch { json(response, { error: "fixture_error" }, 500); }
});
server.listen(0, "127.0.0.1", () => console.log(`UI-only fixture: http://127.0.0.1:${server.address().port}`));
process.on("SIGINT", () => server.close(() => process.exit(0)));
