// Isolated UI fixture. Identities and events are synthetic. Marketplace metadata
// is the reviewed public bundle; installing it only changes this process memory.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { GROK_SNAPSHOT_DIGEST, MARKETPLACE_CHECKED_AT, OMB_LICENSE, OMB_REVISION, ombTeams, grokListings } from "../../src/marketplace-data.ts";
const assets = resolve(fileURLToPath(new URL("../../dist/", import.meta.url)));
const now = Date.now(), day = 86400000;
const roles = ["coordinator", "programmer", "reviewer"];
const names = ["Coordenador", "Programador", "Revisor", "Arquiteto", "Qualidade", "Produto", "Infraestrutura", "Design", "Documentação", "Dados", "Segurança", "Pesquisa"];
let catalog = { version: 1, decisionMode: "team", selections: { coordinator: "cloud-0", programmer: "cloud-1", reviewer: "cloud-2" }, agents: names.map((name, index) => ({ id: `cloud-${index}`, revision: 1, sourceId: `omb-${index}`, name, title: `Especialista em ${name.toLowerCase()}`, description: "Perfil sintético para verificar a interface. Nenhum agente real é executado.", instructions: "Leia o contexto e verifique as evidências antes de concluir.\nPreserve o escopo aprovado da tarefa.", section: "Desenvolvimento", sourceEngine: index % 2 ? "codex" : "claude", sourceModel: index % 2 ? "source-codex" : "source-claude", sourceEffort: "high" })) };
let decision = { provider: "jev", model: "jev-latest", version: null, status: "missing", updatedAt: null, canRecommend: false };
let goals = { version: 1, targets: { taskSuccessRate: 90, testPassRate: 95, durationMinutes: 15 }, canEdit: true };
const mutationBodies = [];
const marketplaceReceipts = new Map();
const marketplaceDefinitions = [
  ...ombTeams.map((team) => ({ id: `omb-${team.slug}`, source: "omb", kind: "team", name: team.name, description: team.summary, category: team.category,
    author: "Milind Soni e colaboradores do OpenMausBot/BotMRR", sourceUrl: `https://github.com/milind-soni/openmausbot-teams/blob/${OMB_REVISION}/${team.manifest}`, version: OMB_REVISION,
    license: { id: "MIT", url: `https://github.com/milind-soni/openmausbot-teams/blob/${OMB_REVISION}/LICENSE`, notice: OMB_LICENSE }, installable: true, unavailableReason: null,
    profileCount: team.members.length, requiredCapabilities: team.requiredApps, excludedFeatures: ["Skills e plugins do pacote", "Rotinas e agendamentos", "Conexões, credenciais e autorizações externas", "Salas, memória e histórico"],
    profiles: team.members.map((member) => ({ sourceId: `marketplace-omb-${team.slug}-${member.key}`, name: member.name, title: member.title, description: member.description, instructions: team.bulletin, section: team.name, sourceEngine: "", sourceModel: "", sourceEffort: "" })) })),
  ...grokListings.map((bot) => ({ id: `grokbot-${bot.slug}`, source: "grokbot", kind: "agent", name: bot.name, description: "Referência do catálogo oficial. Consulte a página de origem para conhecer o perfil e seus requisitos.", category: bot.category, author: bot.author,
    sourceUrl: `https://x.ai/bot/marketplace/bots/${bot.slug}`, version: `snapshot-${GROK_SNAPSHOT_DIGEST}`, license: { id: null, url: null, notice: null }, installable: false,
    unavailableReason: "A licença de redistribuição do perfil não foi confirmada. Este bot não é instalado nem executado no Veltram.", profileCount: 0, requiredCapabilities: ["Requisitos e conexões devem ser conferidos no Grok Bot"], excludedFeatures: ["Perfil e instruções do bot", "Integrações e automações do Grok Bot"], profiles: [] })),
];
const marketplaceSources = [
  { id: "omb", name: "OpenMausBot · BotMRR", url: "https://github.com/milind-soni/openmausbot-teams", checkedAt: MARKETPLACE_CHECKED_AT, coverage: "complete_snapshot", revision: OMB_REVISION, note: "As seis equipes do catálogo público nesta revisão. Instala somente os 18 perfis de compatibilidade e sua orientação compartilhada." },
  { id: "grokbot", name: "Grok Bot", url: "https://x.ai/bot/marketplace", checkedAt: MARKETPLACE_CHECKED_AT, coverage: "complete_snapshot", revision: GROK_SNAPSHOT_DIGEST, note: "90 referências únicas observadas no índice público e em suas nove categorias. Nenhum perfil, instrução ou imagem do Grok Bot é importado." },
];
function marketplaceEntry(definition, state) {
  const { profiles, ...entry } = definition;
  const existing = profiles.flatMap((profile) => { const found = state.agents.find((agent) => agent.sourceId === profile.sourceId); return found ? [found] : []; });
  const customized = existing.some((agent) => Object.entries(profiles.find((profile) => profile.sourceId === agent.sourceId)).some(([key, value]) => agent[key] !== value));
  return { ...entry, installed: customized ? "modified" : profiles.length > 0 && existing.length === profiles.length ? "installed" : "not_installed", profileIds: existing.map((agent) => agent.id) };
}
const fixtureJpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAKABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD2qiiipMz/2Q==", "base64");
const browserRuns = [];
const legacyAgents = roles.map((role, index) => ({ role, name: names[index], instructions: "Fixture de interface", provider: "inherit", model: "" }));
const codingRuns = ["pending_approval", "queued", "running", "running", "completed", "failed"].map((status, index) => ({
  runId: `fixture-run-${index}`, organizationId: "fixture-company", workspaceId: "fixture-workspace", generation: 1, requestId: `fixture-request-${index}`, repositoryConnectionId: "repo-fixture", repositoryName: "fixture-owner/example", baseRef: "main", task: ["Revisar validação de entrada", "Adicionar testes de regressão", "Corrigir navegação no aplicativo", "Revisar o tratamento de erros", "Melhorar mensagens de validação", "Investigar falha de teste"][index], provider: "openai", model: "fixture-model", setupCommand: "npm ci", testCommand: "npm test", createdBy: "fixture-user", credentialVersion: 1, createdAt: now - index * 60000, updatedAt: now, deadlineAt: now + 600000, status, agentStage: index === 3 ? "reviewer" : "programmer", modelCalls: index, tokens: index * 100, canApprove: status === "pending_approval", canCancel: !["completed", "failed"].includes(status), agents: legacyAgents.map((agent, i) => ({ ...agent, name: names[i], catalogAgentId: `cloud-${i}`, provider: "openai", model: "fixture-model", credentialVersion: 1 })), events: [], ...(status === "failed" ? { error: "coding_test_failed", verification: { command: "npm test", exitCode: 1, treeDigest: "fixture-digest", output: "Synthetic fixture: test failed", finishedAt: now, truncated: false } } : {}), ...(status === "completed" ? { verification: { command: "npm test", exitCode: 0, treeDigest: "fixture-digest", output: "Synthetic fixture: 2 passed", finishedAt: now, truncated: false }, result: { branch: "veltram/fixture", commitSha: "fixture-commit", prUrl: "https://github.com/fixture-owner/example/pull/7", prNumber: 7, changedFiles: 2 }, review: { approved: true, summary: "Revisão sintética", at: now } } : {})
}));
const kpis = { created: 12, completed: 8, failed: 2, canceled: 1, interrupted: 1, prsCreated: 7, testsPassed: 16, testsFailed: 4, modelCalls: 60, observedTokens: 42000, unobservedModelCalls: 3, taskSuccessRate: .8, testPassRate: .8, durationMs: { median: 420000, p90: 900000, samples: 10 }, approvalWaitMs: { median: 60000, p90: 120000, samples: 12 } };
function report(url, empty) {
  const period = { from: now - 7 * day, to: now + 1 }, previous = { from: now - 14 * day, to: now - 7 * day };
  const unknown = { ...kpis }; for (const key of Object.keys(unknown)) if (typeof unknown[key] === "number") unknown[key] = null;
  unknown.durationMs = unknown.approvalWaitMs = { median: null, p90: null, samples: 0 };
  const metrics = ["created", "completed", "failed", "canceled", "interrupted", "prsCreated", "testsPassed", "testsFailed", "modelCalls", "observedTokens", "taskSuccessRate", "testPassRate", "durationMs"];
  const buckets = Array.from({ length: 7 }, (_, i) => ({ start: now - (7 - i) * day, end: now - (6 - i) * day, coverage: empty ? "none" : "full", created: empty ? null : i % 3, completed: empty ? null : i % 3, failed: empty ? null : 0, prsCreated: empty ? null : 1, testsPassed: empty ? null : 2, testsFailed: empty ? null : 0, modelCalls: empty ? null : 10, observedTokens: empty ? null : 6000 }));
  return { version: 1, organizationId: empty ? "fixture-empty" : "fixture-company", workspaceId: empty ? "empty-workspace" : "fixture-workspace", generatedAt: now, timezone: "America/Sao_Paulo", query: Object.fromEntries(url.searchParams), period, previous, comparedUntil: now, previousComparedUntil: previous.to - 1, granularity: url.searchParams.get("granularity") ?? "day", coverage: { trackingStartedAt: empty ? null : now - 20 * day, period: empty ? "none" : "full", previous: empty ? "none" : "full", factsThrough: empty ? null : now, historyImported: false, notes: [] }, kpis: empty ? unknown : kpis, previousKpis: empty ? unknown : kpis, comparisons: Object.fromEntries(metrics.map((key) => [key, empty ? { kind: "none", previous: null, delta: null, ratio: null } : (key === "taskSuccessRate" || key === "testPassRate") ? { kind: "trend", previous: .7, delta: .1, ratio: 1 / 7 } : { kind: "trend", previous: 5, delta: 3, ratio: .6 }])), buckets, previousBuckets: buckets.map((bucket) => ({ ...bucket, start: bucket.start - 7 * day, end: bucket.end - 7 * day })), agents: empty ? [] : roles.map((role, i) => ({ id: `cloud-${i}`, role, name: names[i], modelCalls: 20, observedTokens: i === 2 ? null : 21000, unobservedModelCalls: i === 2 ? 3 : 0, modelDurationMs: 60000 })), runs: empty ? [] : [{ runId: "fixture-report-run", repositoryId: "repo-fixture", repositoryName: "fixture-owner/example", task: "Corrigir validação e comprovar os testes", status: "completed", createdAt: now - 600000, approvedAt: now - 590000, startedAt: now - 580000, finishedAt: now - 100000, publishedAt: now - 90000, agents: roles.map((role, i) => ({ id: `cloud-${i}`, role, name: names[i] })), test: { command: "npm test", exitCode: 0, finishedAt: now - 100000 }, pr: { url: "https://github.com/fixture-owner/example/pull/7", number: 7, commitSha: "fixture-commit", changedFiles: 2 } }], runsTruncated: false, backlog: { pendingApproval: empty ? 0 : 2, active: empty ? 0 : 1, at: now }, filters: { repositories: empty ? [] : [{ id: "repo-fixture", name: "fixture-owner/example" }], agents: empty ? [] : catalog.agents.map(({ id, name }) => ({ id, name })) }, goals: empty ? { version: 0, targets: {}, canEdit: false } : goals, sources: [{ id: "coding", label: "Execuções do Veltram", status: "available", reason: "Eventos das tarefas acompanhadas na nuvem." }, ...["DORA", "Publicação em produção", "Custo financeiro"].map((label) => ({ id: label, label, status: "not_tracked", reason: "Ainda não existe fonte conectada para este indicador." }))], definitions: { "Sucesso das tarefas": "Concluídas divididas por concluídas e falhas.", "Tokens observados": "Uso confirmado pelos provedores, com lacunas explicitadas." } };
}
function json(response, value, status = 200) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1"); const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const empty = url.pathname.includes("/fixture-empty/");
    if (url.pathname === "/api/session") return json(response, { user: { id: "fixture-user", name: "Conta de teste", email: "fixture@example.invalid" } });
    if (url.pathname === "/api/organizations") return json(response, { organizations: [{ id: "fixture-company", name: "Empresa de teste · fixture", role: "owner" }, { id: "fixture-empty", name: "Outra empresa · fixture", role: "member" }] });
    if (url.pathname === "/fixture-inspect") return json(response, { catalog, decision, goals, mutationBodies });
    const marketplace = url.pathname.match(/^\/api\/organizations\/(fixture-company|fixture-empty)\/marketplace(?:\/([^/]+))?$/);
    if (marketplace) {
      const state = empty ? { version: 0, agents: [], selections: null, decisionMode: "team" } : catalog;
      if (request.method === "POST" && marketplace[2] === "install") {
        if (empty) return json(response, { error: "admin_required" }, 403);
        const definition = marketplaceDefinitions.find((item) => item.id === body.entryId);
        if (!definition) return json(response, { error: "marketplace_not_found" }, 404);
        if (!definition.installable) return json(response, { error: "marketplace_external_only" }, 409);
        if (body.version !== definition.version) return json(response, { error: "marketplace_version_changed" }, 409);
        const fingerprint = JSON.stringify(body), known = marketplaceReceipts.get(body.requestId);
        if (known && known.fingerprint !== fingerprint) return json(response, { error: "agent_import_changed" }, 409);
        if (!known) {
          if (body.expectedCatalogVersion !== catalog.version) return json(response, { error: "agent_catalog_changed" }, 409);
          if (marketplaceEntry(definition, catalog).installed === "modified") return json(response, { error: "marketplace_profiles_changed" }, 409);
          for (const profile of definition.profiles) if (!catalog.agents.some((agent) => agent.sourceId === profile.sourceId)) catalog.agents.push({ ...profile, id: randomUUID(), revision: 1 });
          catalog = { ...catalog, version: catalog.version + 1 };
          marketplaceReceipts.set(body.requestId, { fingerprint, version: catalog.version }); mutationBodies.push({ path: url.pathname, body });
        }
        return json(response, { entryId: definition.id, catalog: { ...catalog, mutation: { requestId: body.requestId, appliedVersion: marketplaceReceipts.get(body.requestId).version, replayed: Boolean(known) } }, profileIds: marketplaceEntry(definition, catalog).profileIds });
      }
      if (request.method !== "GET") return json(response, { error: "not_found" }, 404);
      if (marketplace[2]) { const definition = marketplaceDefinitions.find((item) => item.id === marketplace[2]); return definition ? json(response, { entry: marketplaceEntry(definition, state), catalogVersion: state.version, canInstall: !empty, profiles: definition.profiles }) : json(response, { error: "marketplace_not_found" }, 404); }
      return json(response, { version: `omb-${OMB_REVISION}-grok-${GROK_SNAPSHOT_DIGEST}`, catalogVersion: state.version, canInstall: !empty, sources: marketplaceSources, items: marketplaceDefinitions.map((definition) => marketplaceEntry(definition, state)) });
    }
    if (url.pathname.endsWith("/workspaces")) return json(response, { workspaces: [{ id: empty ? "empty-workspace" : "fixture-workspace", name: "Fixture" }] });
    if (url.pathname.endsWith("/github")) return json(response, { configured: true, connections: [{ id: "repo-fixture", repositoryId: 1, installationId: 1, fullName: "fixture-owner/example", defaultBranch: "main", status: "active" }], pending: null, installUrl: null });
    if (url.pathname.endsWith("/credentials")) return json(response, { credentials: [{ provider: "openai", version: 1, status: "configured", updatedAt: now }] });
    if (url.pathname.endsWith("/agents")) return json(response, { version: 1, agents: legacyAgents });
    if (url.pathname.endsWith("/coding-runs")) {
      if (request.method === "POST") { const run = { ...codingRuns[0], ...body, runId: randomUUID(), requestId: body.requestId, createdAt: Date.now(), updatedAt: Date.now(), status: "pending_approval", canApprove: true, canCancel: true }; codingRuns.unshift(run); return json(response, { run }, 201); }
      return json(response, { runs: empty ? [] : codingRuns });
    }
    const action = url.pathname.match(/\/coding-runs\/([^/]+)\/(approve|cancel)$/);
    if (action) { const run = codingRuns.find((item) => item.runId === action[1]); if (!run) return json(response, { error: "not_found" }, 404); Object.assign(run, { status: action[2] === "approve" ? "running" : "canceled", generation: run.generation + 1, updatedAt: Date.now(), canApprove: false, canCancel: action[2] === "approve" }); return json(response, { run }); }
    if (url.pathname.endsWith("/runs")) return json(response, { runs: [] });
    if (url.pathname.endsWith("/agent-catalog/recommend")) return json(response, { catalogVersion: catalog.version, recommendation: { catalogVersion: catalog.version, coordinator: catalog.agents[0].id, programmer: catalog.agents[1].id, reviewer: catalog.agents[2].id }, confidence: { coordinator: .92, programmer: .88, reviewer: .91 }, fallback: false, reason: "recommended" });
    if (url.pathname.endsWith("/browser-runs")) {
      if (request.method === "POST") {
        const run = { ...body, runId: randomUUID(), organizationId: "fixture-company", workspaceId: "fixture-workspace", generation: 0, status: "pending_approval", createdBy: "fixture-user", createdAt: Date.now(), updatedAt: Date.now(), deadlineAt: Date.now() + 300000, credentialVersion: 1, steps: 0, modelCalls: 0, tokens: 0, events: [], cleanupStatus: "closed", canApprove: true, canCancel: true };
        if (body.agent) { const profile = catalog.agents.find((item) => item.id === body.agent.profileId); run.agentSnapshot = { id: profile.id, revision: profile.revision, name: profile.name, instructions: profile.instructions }; }
        browserRuns.unshift(run); mutationBodies.push({ path: url.pathname, body }); return json(response, { run }, 201);
      }
      return json(response, { runs: empty ? [] : browserRuns });
    }
    const browserAction = url.pathname.match(/\/browser-runs\/([^/]+)\/(approve|cancel|screenshot)$/);
    if (browserAction) {
      const run = browserRuns.find((item) => item.runId === browserAction[1]); if (!run || empty) return json(response, { error: "not_found" }, 404);
      if (browserAction[2] === "screenshot") { response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" }); response.end(fixtureJpeg); return; }
      if (body.generation !== run.generation) return json(response, { error: "browser_conflict" }, 409);
      const approve = browserAction[2] === "approve"; mutationBodies.push({ path: url.pathname, body });
      Object.assign(run, { generation: run.generation + 1, updatedAt: Date.now(), status: approve ? "running" : "canceled", canApprove: false, canCancel: approve, cleanupStatus: approve ? "pending" : "closed", ...(approve ? { approvedAt: Date.now(), screenshotAt: Date.now(), steps: 1, modelCalls: 1, tokens: 120, events: [{ id: 1, at: Date.now(), kind: "status", text: "Navegador sintético iniciado. Nenhum site externo foi acessado." }, { id: 2, at: Date.now(), kind: "action", text: "Captura sintética para verificar a interface." }] } : { finishedAt: Date.now() }) });
      return json(response, { run });
    }
    if (url.pathname.endsWith("/agent-catalog") || url.pathname.endsWith("/agent-catalog/import")) {
      if (request.method !== "GET") {
        if (empty) return json(response, { error: "forbidden" }, 403);
        if (body.expectedVersion !== catalog.version) return json(response, { error: "agent_catalog_changed" }, 409);
        mutationBodies.push({ path: url.pathname, body });
        for (const draft of body.agents ?? []) { const old = catalog.agents.find((agent) => agent.sourceId === draft.sourceId); if (old) Object.assign(old, draft, { revision: old.revision + 1 }); else catalog.agents.push({ ...draft, id: randomUUID(), revision: 1 }); }
        catalog = { ...catalog, version: catalog.version + 1, selections: body.selections === undefined ? catalog.selections : body.selections };
      }
      return json(response, empty ? { version: 0, agents: [], selections: null, decisionMode: "team" } : catalog);
    }
    if (url.pathname.endsWith("/decision-model")) {
      if (request.method !== "GET") { if (empty) return json(response, { error: "forbidden" }, 403); decision = { ...decision, version: (decision.version ?? 0) + 1, status: request.method === "DELETE" ? "revoked" : "configured", updatedAt: Date.now(), canRecommend: request.method !== "DELETE" }; }
      return json(response, empty ? { ...decision, version: null, status: "missing", canRecommend: false } : decision);
    }
    if (url.pathname.endsWith("/reports/goals") && request.method === "PUT") { if (empty) return json(response, { error: "forbidden" }, 403); goals = { version: goals.version + 1, targets: body.targets, canEdit: true }; return json(response, goals); }
    if (url.pathname.endsWith("/reports.md")) { response.writeHead(200, { "content-type": "text/markdown" }); response.end("# Relatório sintético do Veltram\n\nNenhum evento real nesta fixture.\n"); return; }
    if (url.pathname.endsWith("/reports")) return json(response, report(url, empty));
    if (url.pathname.startsWith("/api/")) return json(response, { error: "fixture_route_not_found" }, 404);
    const path = resolve(assets, `.${url.pathname === "/" ? "/index.html" : url.pathname}`); if (!path.startsWith(`${assets}${sep}`)) return json(response, { error: "not_found" }, 404);
    const content = await readFile(path); response.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html", "cache-control": "no-store" }); response.end(content);
  } catch { json(response, { error: "fixture_error" }, 500); }
});
server.listen(0, "127.0.0.1", () => console.log(`Agents/reports isolated fixture: http://127.0.0.1:${server.address().port}`));
process.on("SIGINT", () => server.close(() => process.exit(0)));
