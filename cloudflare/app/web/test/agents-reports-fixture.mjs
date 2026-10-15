// Isolated UI fixture. Identities and events are synthetic. Marketplace metadata
// is the reviewed public bundle; installing it only changes this process memory.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { GROK_SNAPSHOT_DIGEST, MARKETPLACE_CHECKED_AT, OMB_LICENSE, OMB_REVISION, ombTeams, grokListings } from "../../src/marketplace-data.ts";
import { resolveReportQuery, reportBucketPeriods } from "../../src/report-period.ts";
const assets = resolve(fileURLToPath(new URL("../../dist/", import.meta.url)));
const now = Date.now(), day = 86400000;
const roles = ["coordinator", "programmer", "reviewer"];
const names = ["Coordenador", "Programador", "Revisor", "Arquiteto", "Qualidade", "Produto", "Infraestrutura", "Design", "Documentação", "Dados", "Segurança", "Pesquisa"];
let catalog = { version: 1, decisionMode: "team", selections: { coordinator: "cloud-0", programmer: "cloud-1", reviewer: "cloud-2" }, agents: names.map((name, index) => ({ id: `cloud-${index}`, revision: 1, sourceId: `omb-${index}`, name, title: `Especialista em ${name.toLowerCase()}`, description: "Perfil sintético para verificar a interface. Nenhum agente real é executado.", instructions: "Leia o contexto e verifique as evidências antes de concluir.\nPreserve o escopo aprovado da tarefa.", section: "Desenvolvimento", sourceEngine: index % 2 ? "codex" : "claude", sourceModel: index % 2 ? "source-codex" : "source-claude", sourceEffort: "high" })) };
let decision = { provider: "jev", model: "jev-latest", version: null, status: "missing", updatedAt: null, canRecommend: false };
let goals = { version: 1, targets: { taskSuccessRate: 90, testPassRate: 95, durationMinutes: 15 }, canEdit: true };
const mutationBodies = [];
const executionRuns = [];
if (process.env.VELTRAM_FIXTURE_EXECUTION_SEEDED === "true") {
  const base = { organizationId: "fixture-company", workspaceId: "fixture-workspace", generation: 0, createdAt: now, updatedAt: now, leaseExpiresAt: null, canApprove: true, canCancel: true };
  executionRuns.push({ ...base, id: "fixture-execution-pending", input: { message: "Verificar o ambiente de execução da empresa", delayMs: 5000 }, status: "waiting_approval" });
  executionRuns.push({ ...base, id: "fixture-execution-success", createdAt: now - 60000, updatedAt: now - 50000, input: { message: "Mensagem sintética reproduzida no resultado", delayMs: 0 }, status: "succeeded", canApprove: false, canCancel: false, result: { stdout: "Mensagem sintética reproduzida no resultado", artifact: "{\n  \"message\": \"Mensagem sintética reproduzida no resultado\"\n}", exitCode: 0 } });
}

const fixtureUser = { id: "fixture-user", name: "Conta de teste", email: "fixture@example.invalid" };
let authenticated = process.env.VELTRAM_FIXTURE_AUTH !== "signed-out";
let organizations = process.env.VELTRAM_FIXTURE_AUTH === "onboarding" ? [] : [{ id: "fixture-company", name: "Empresa de teste · fixture", role: "owner" }, { id: "fixture-empty", name: "Outra empresa · fixture", role: "member" }];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(10000, Math.max(0, Number(ms) || 0))));
let failures = 0;
const connectionsBlocked = process.env.VELTRAM_FIXTURE_CONNECTIONS_BLOCKED === "true";
let fixtureBudget = { version: 1, limitBrlMicros: 1000000000, updatedAt: now, updatedBy: "fixture-user" };
const fixtureCredentials = new Map(["openai", "openrouter"].map(provider => [provider, { provider, version: 1, status: "configured", updatedAt: now }]));
let fixtureClaude = { enabled: !connectionsBlocked, state: connectionsBlocked ? "disconnected" : "connected", authMethod: "claude.ai", connectionVersion: 1, cliVersion: "2.1.300", busy: false, persistence: "native_snapshot", snapshotRetentionDays: 30 };
if (process.env.VELTRAM_FIXTURE_CLAUDE_PENDING === "true") fixtureClaude = { ...fixtureClaude, state: "connecting", flow: { id: "fixture-old-flow", expiresAt: now + 900000, authorizationUrl: "https://claude.ai/oauth/authorize?fixture=never-open", codeSubmitted: false } };
// Synthetic mission receipts only. This fixture never calls a model or repository.
const missionReceipt = { runId: "fixture-mission-run", generation: 3, runUpdatedAt: now, observedAt: now, status: "completed", reviewApproved: true, test: { exitCode: 0, treeDigest: "a".repeat(64), finishedAt: now }, pullRequest: { url: "https://github.com/fixture-owner/example/pull/7", number: 7, branch: "veltram/fixture", commitSha: "b".repeat(40) } };
const missionTemplate = { organizationId: "fixture-company", workspaceId: "fixture-workspace", createdBy: "fixture-user", version: 1, createdAt: now, updatedAt: now, repositoryConnectionId: "repo-fixture", baseRef: "main", provider: "anthropic", model: "fixture-model", modelSource: { kind: "claude-code", connectionVersion: 1 }, setupCommand: "npm ci", testCommand: "npm test", acceptanceCriteria: ["As entradas inválidas apresentam mensagem clara.", "Os testes de regressão passam."], delivery: "pull_request", deliveryEvidence: "not_observed" };
const missions = [
  { ...missionTemplate, missionId: "11111111-1111-4111-8111-111111111111", requestId: "11111111-1111-4111-8111-111111111111", goal: "Melhorar a validação do projeto de teste", status: "active", nextWakeAt: now + 30000, canPause: true, canCancel: true, tasks: [{ title: "Validar o formulário de cadastro", instructions: "Verificar entradas inválidas e incluir testes de regressão.", runId: "fixture-mission-run", attempt: 1, status: "completed", evidence: missionReceipt }, { title: "Explicar erros no formulário de acesso", instructions: "Apresentar mensagens claras para entradas inválidas e testar cada caso.", runId: "fixture-next-run", attempt: 1, status: "running" }] },
  { ...missionTemplate, createdAt: now - 60000, missionId: "22222222-2222-4222-8222-222222222222", requestId: "22222222-2222-4222-8222-222222222222", goal: "Publicar a correção do projeto de teste", status: "awaiting_delivery", delivery: "merge_and_deploy", deliveryEvidence: "project_adapter_required", canCancel: true, tasks: [{ title: "Corrigir a mensagem de validação", instructions: "Corrigir a mensagem e comprovar a entrega pelo processo do projeto.", runId: "fixture-mission-run", attempt: 1, status: "completed", evidence: missionReceipt }] },
];
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
const browserFixtureState = process.env.VELTRAM_FIXTURE_BROWSER_STATE;
if (["pending", "completed", "screenshot-error"].includes(browserFixtureState)) {
  const completed = browserFixtureState !== "pending";
  browserRuns.push({
    runId: "fixture-browser-seeded", requestId: "fixture-browser-seeded", organizationId: "fixture-company", workspaceId: "fixture-workspace",
    task: "Conferir a navegação e os estados de carregamento do portal de demonstração sintético",
    initialUrl: "https://portal-de-demonstracao-sintetica.example.invalid/area-de-trabalho/relatorios?origem=inspecao-visual",
    allowedHosts: ["portal-de-demonstracao-sintetica.example.invalid", "conteudo-estatico-do-portal.example.invalid", "autenticacao-do-portal.example.invalid"],
    provider: "openai", model: "modelo-sintetico-com-visao", generation: 0, status: completed ? "completed" : "pending_approval",
    createdBy: "fixture-user", createdAt: now - 120000, updatedAt: now, deadlineAt: now + 300000, credentialVersion: 1,
    steps: completed ? 4 : 0, modelCalls: completed ? 2 : 0, tokens: completed ? 840 : 0, cleanupStatus: "closed", canApprove: !completed, canCancel: !completed,
    events: completed ? [{ id: 1, at: now - 60000, kind: "action", text: "Captura sintética registrada. Nenhum site externo foi acessado." }, { id: 2, at: now, kind: "status", text: "Inspeção sintética encerrada." }] : [],
    ...(completed ? { screenshotAt: now, finishedAt: now, summary: "O cenário sintético encerrou com quatro ações. Esta evidência serve somente para verificar a interface." } : {}),
  });
}
const legacyAgents = roles.map((role, index) => ({ role, name: names[index], instructions: "Fixture de interface", provider: "inherit", model: "" }));
const codingRuns = ["pending_approval", "queued", "running", "running", "completed", "failed"].map((status, index) => ({
  runId: `fixture-run-${index}`, organizationId: "fixture-company", workspaceId: "fixture-workspace", generation: 1, requestId: `fixture-request-${index}`, repositoryConnectionId: "repo-fixture", repositoryName: "fixture-owner/example", baseRef: "main", task: ["Revisar validação de entrada", "Adicionar testes de regressão", "Corrigir navegação no aplicativo", "Revisar o tratamento de erros", "Melhorar mensagens de validação", "Investigar falha de teste"][index], provider: "openai", model: "fixture-model", setupCommand: "npm ci", testCommand: "npm test", createdBy: "fixture-user", credentialVersion: 1, createdAt: now - index * 60000, updatedAt: now, deadlineAt: now + 600000, status, agentStage: index === 3 ? "reviewer" : "programmer", modelCalls: index, tokens: index * 100, canApprove: status === "pending_approval", canCancel: !["completed", "failed"].includes(status), agents: legacyAgents.map((agent, i) => ({ ...agent, name: names[i], catalogAgentId: `cloud-${i}`, provider: "openai", model: "fixture-model", credentialVersion: 1 })), events: [], ...(status === "failed" ? { error: "coding_tests_failed", verification: { command: "npm test", exitCode: 1, treeDigest: "fixture-digest", output: "Synthetic fixture: test failed", finishedAt: now, truncated: false } } : {}), ...(status === "completed" ? { verification: { command: "npm test", exitCode: 0, treeDigest: "fixture-digest", output: "Synthetic fixture: 2 passed", finishedAt: now, truncated: false }, result: { branch: "veltram/fixture", commitSha: "fixture-commit", prUrl: "https://github.com/fixture-owner/example/pull/7", prNumber: 7, changedFiles: 2 }, review: { approved: true, summary: "Revisão sintética", at: now } } : {})
}));
const kpis = { created: 12, completed: 8, failed: 2, canceled: 1, interrupted: 1, prsCreated: 7, testsPassed: 16, testsFailed: 4, modelCalls: 60, observedTokens: 42000, unobservedModelCalls: 3, taskSuccessRate: .8, testPassRate: .8, durationMs: { median: 420000, p90: 900000, samples: 10 }, approvalWaitMs: { median: 60000, p90: 120000, samples: 12 } };
function report(url, empty) {
  const { period, previous, comparedUntil, previousComparedUntil, granularity } = resolveReportQuery(url.searchParams, now);
  const reportMode = process.env.VELTRAM_FIXTURE_REPORT_MODE;
  empty ||= reportMode === "null";
  const partial = reportMode === "partial";
  const zero = reportMode === "zero";
  const unknown = { ...kpis }; for (const key of Object.keys(unknown)) if (typeof unknown[key] === "number") unknown[key] = null;
  unknown.durationMs = unknown.approvalWaitMs = { median: null, p90: null, samples: 0 };
  const metrics = ["created", "completed", "failed", "canceled", "interrupted", "prsCreated", "testsPassed", "testsFailed", "modelCalls", "observedTokens", "taskSuccessRate", "testPassRate", "durationMs"];
  const makeBuckets = (range) => reportBucketPeriods(range, granularity).map(({ from, to }, i) => ({ start: from, end: to, coverage: empty ? "none" : partial && i === 0 ? "partial" : "full", created: empty ? null : zero ? 0 : i % 3, completed: empty ? null : zero ? 0 : i % 3, failed: empty ? null : 0, prsCreated: empty ? null : zero ? 0 : 1, testsPassed: empty ? null : zero ? 0 : 2, testsFailed: empty ? null : 0, modelCalls: empty ? null : zero ? 0 : 10, observedTokens: empty ? null : zero ? 0 : 6000 }));
  const buckets = makeBuckets(period);
  const currentKpis = empty ? unknown : zero ? Object.fromEntries(Object.entries(kpis).map(([key, value]) => [key, typeof value === "number" ? 0 : { median: null, p90: null, samples: 0 }])) : kpis;
  return { version: 1, organizationId: empty ? "fixture-empty" : "fixture-company", workspaceId: empty ? "empty-workspace" : "fixture-workspace", generatedAt: now, timezone: "America/Sao_Paulo", query: Object.fromEntries(url.searchParams), period, previous, comparedUntil, previousComparedUntil, granularity, coverage: { trackingStartedAt: empty ? null : now - 20 * day, period: empty ? "none" : partial ? "partial" : "full", previous: empty ? "none" : "full", factsThrough: empty ? null : now, historyImported: false, notes: [] }, kpis: currentKpis, previousKpis: currentKpis, comparisons: Object.fromEntries(metrics.map((key) => [key, empty ? { kind: "none", previous: null, delta: null, ratio: null } : (key === "taskSuccessRate" || key === "testPassRate") ? { kind: "trend", previous: .7, delta: .1, ratio: 1 / 7 } : { kind: "trend", previous: 5, delta: 3, ratio: .6 }])), buckets, previousBuckets: makeBuckets(previous), agents: empty ? [] : roles.map((role, i) => ({ id: `cloud-${i}`, role, name: names[i], modelCalls: 20, observedTokens: i === 2 ? null : 21000, unobservedModelCalls: i === 2 ? 3 : 0, modelDurationMs: 60000 })), runs: empty ? [] : [{ runId: "fixture-report-run", repositoryId: "repo-fixture", repositoryName: "fixture-owner/example", task: "Corrigir validação e comprovar os testes", status: "completed", createdAt: now - 600000, approvedAt: now - 590000, startedAt: now - 580000, finishedAt: now - 100000, publishedAt: now - 90000, agents: roles.map((role, i) => ({ id: `cloud-${i}`, role, name: names[i] })), test: { command: "npm test", exitCode: 0, finishedAt: now - 100000 }, pr: { url: "https://github.com/fixture-owner/example/pull/7", number: 7, commitSha: "fixture-commit", changedFiles: 2 } }], runsTruncated: false, backlog: { pendingApproval: empty ? 0 : 2, active: empty ? 0 : 1, at: now }, filters: { repositories: empty ? [] : [{ id: "repo-fixture", name: "fixture-owner/example" }], agents: empty ? [] : catalog.agents.map(({ id, name }) => ({ id, name })) }, goals: empty ? { version: 0, targets: {}, canEdit: false } : goals, sources: [{ id: "coding", label: "Execuções do Veltram", status: "available", reason: "Eventos das tarefas acompanhadas na nuvem." }, ...["DORA", "Publicação em produção", "Custo financeiro"].map((label) => ({ id: label, label, status: "not_tracked", reason: "Ainda não existe fonte conectada para este indicador." }))], definitions: { "Sucesso das tarefas": "Concluídas divididas por concluídas e falhas.", "Tokens observados": "Uso confirmado pelos provedores, com lacunas explicitadas." } };
}
function json(response, value, status = 200) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1"); const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const empty = url.pathname.includes("/fixture-empty/");
    const errorPath = process.env.VELTRAM_FIXTURE_ERROR_PATH;
    if (errorPath && url.pathname.includes(errorPath) && (!process.env.VELTRAM_FIXTURE_ERROR_METHOD || request.method === process.env.VELTRAM_FIXTURE_ERROR_METHOD) && (process.env.VELTRAM_FIXTURE_ERROR_ONCE !== "true" || failures++ === 0)) return json(response, { error: "fixture_unavailable" }, 503);
    if (process.env.VELTRAM_FIXTURE_DELAY_PATH && url.pathname.includes(process.env.VELTRAM_FIXTURE_DELAY_PATH)) await delay(process.env.VELTRAM_FIXTURE_DELAY_MS);
    if (/\/coding-runs(?:\/[^/]+\/(?:approve|cancel))?$/.test(url.pathname)) {
      if (request.method === "POST") await delay(process.env.VELTRAM_FIXTURE_CODING_DELAY_MS);
      else if (process.env.VELTRAM_FIXTURE_CODING_ERROR === "true") return json(response, { error: "fixture_unavailable" }, 503);
    }
    if (url.pathname === "/api/session") return authenticated ? json(response, { user: fixtureUser }) : json(response, { error: "unauthorized" }, 401);
    if (url.pathname === "/api/auth/email-otp/send-verification-otp") return json(response, { success: true });
    if (url.pathname === "/api/auth/sign-in/email-otp") {
      if (body.otp !== "00000000") return json(response, { error: "INVALID_OTP" }, 400);
      authenticated = true; return json(response, { user: fixtureUser });
    }
    if (url.pathname === "/api/auth/sign-out") { authenticated = false; return json(response, { success: true }); }
    if (url.pathname === "/api/organizations") {
      if (request.method === "POST") {
        const organization = { id: "fixture-created", name: body.name, role: "owner" };
        organizations.push(organization); mutationBodies.push({ path: url.pathname, body }); return json(response, organization, 201);
      }
      return json(response, { organizations });
    }
    if (url.pathname === "/fixture-inspect") return json(response, { catalog, decision, goals, missions, fixtureBudget, fixtureClaude, executionRuns, mutationBodies });
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
    if (url.pathname.endsWith("/credentials") && request.method === "GET") return json(response, { credentials: empty ? [] : [...fixtureCredentials.values()] });
    const credentialRoute = url.pathname.match(/^\/api\/organizations\/(fixture-company|fixture-empty)\/credentials\/(openai|anthropic|openrouter)$/);
    if (credentialRoute && ["PUT", "DELETE"].includes(request.method)) {
      if (empty) return json(response, { error: "admin_required" }, 403);
      const provider = credentialRoute[2], current = fixtureCredentials.get(provider);
      if (body.expectedVersion !== (current?.version ?? null)) return json(response, { error: "credential_changed" }, 409);
      const next = { provider, version: (current?.version ?? 0) + 1, status: request.method === "PUT" ? "configured" : "revoked", updatedAt: Date.now() };
      fixtureCredentials.set(provider, next);
      mutationBodies.push({ path: url.pathname, method: request.method, body: { expectedVersion: body.expectedVersion } });
      return json(response, next);
    }
    if (url.pathname.endsWith("/me/claude-code")) return json(response, empty ? { ...fixtureClaude, state: "disconnected" } : fixtureClaude);
    if (url.pathname.endsWith("/me/claude-code/login/fixture-old-flow/cancel") && request.method === "POST") {
      fixtureClaude = { ...fixtureClaude, state: "disconnected", connectionVersion: fixtureClaude.connectionVersion + 1 }; delete fixtureClaude.flow;
      mutationBodies.push({ path: url.pathname, body }); return json(response, fixtureClaude);
    }
    if (url.pathname.endsWith("/me/claude-code/logout") && request.method === "POST") {
      if (empty) return json(response, { error: "not_found" }, 404);
      if (body.expectedVersion !== fixtureClaude.connectionVersion) return json(response, { error: "claude_connection_changed" }, 409);
      fixtureClaude = { ...fixtureClaude, state: "disconnected", connectionVersion: fixtureClaude.connectionVersion + 1 };
      mutationBodies.push({ path: url.pathname, body }); return json(response, fixtureClaude);
    }
    if (url.pathname.endsWith("/budget")) {
      if (request.method === "PUT") {
        if (empty) return json(response, { error: "admin_required" }, 403);
        if (body.expectedVersion !== fixtureBudget.version) return json(response, { error: "budget_configuration_changed" }, 409);
        fixtureBudget = { ...fixtureBudget, version: fixtureBudget.version + 1, limitBrlMicros: body.limitBrlMicros, updatedAt: Date.now() };
        mutationBodies.push({ path: url.pathname, body });
      }
      return json(response, { organizationId: empty ? "fixture-empty" : "fixture-company", day: "2026-10-15", timezone: "America/Sao_Paulo", currency: "BRL", unit: "micros", scope: "estimated_api_inference", exclusions: ["subscriptions", "infrastructure", "taxes", "payment_fees"], enforcement: { required: true, paidApiAvailable: !connectionsBlocked }, configuration: fixtureBudget, settledBrlMicros: 0, reservedBrlMicros: 0, carryoverBrlMicros: 0, availableBrlMicros: fixtureBudget.limitBrlMicros, overrunBlocked: false, canEdit: !empty });
    }
    const missionRoute = url.pathname.match(/^\/api\/organizations\/(fixture-company|fixture-empty)\/workspaces\/(fixture-workspace|empty-workspace)\/missions(?:\/([^/]+))?(?:\/(pause|resume|cancel))?$/);
    if (missionRoute) {
      if (request.method === "POST" && empty) return json(response, { error: "admin_required" }, 403);
      if (request.method === "POST" && !missionRoute[3]) {
        const known = missions.find(item => item.requestId === body.requestId); if (known) return json(response, { mission: known });
        const mission = { ...missionTemplate, ...body, missionId: body.requestId, status: "active", createdAt: Date.now(), updatedAt: Date.now(), nextWakeAt: Date.now() + 30000, canPause: true, canCancel: true, tasks: body.tasks.map(task => ({ ...task, runId: randomUUID(), attempt: 1, status: "queued" })) };
        if (!body.modelSource) delete mission.modelSource;
        missions.unshift(mission); mutationBodies.push({ path: url.pathname, body }); return json(response, { mission }, 201);
      }
      if (!missionRoute[3]) return json(response, { missions: empty ? [] : missions, nextCursor: null });
      const mission = empty ? null : missions.find(item => item.missionId === missionRoute[3]); if (!mission) return json(response, { error: "not_found" }, 404);
      if (request.method === "POST") {
        if (body.expectedVersion !== mission.version) return json(response, { error: "mission_state_changed" }, 409);
        const action = missionRoute[4]; if (!action) return json(response, { error: "not_found" }, 404);
        const status = action === "pause" ? "paused" : action === "resume" ? "active" : "canceled";
        Object.assign(mission, { version: mission.version + 1, updatedAt: Date.now(), status, canPause: status === "active", canResume: status === "paused", canCancel: status !== "canceled", nextWakeAt: status === "active" ? Date.now() + 30000 : undefined });
        mutationBodies.push({ path: url.pathname, body });
      }
      return json(response, { mission });
    }
    if (url.pathname.endsWith("/agents")) return json(response, { version: 1, agents: legacyAgents });
    if (url.pathname.endsWith("/coding-runs")) {
      if (request.method === "POST") { const run = { ...codingRuns[0], ...body, runId: randomUUID(), requestId: body.requestId, createdAt: Date.now(), updatedAt: Date.now(), status: "pending_approval", canApprove: true, canCancel: true }; codingRuns.unshift(run); return json(response, { run }, 201); }
      return json(response, { runs: empty ? [] : codingRuns });
    }
    const action = url.pathname.match(/\/coding-runs\/([^/]+)\/(approve|cancel)$/);
    if (action) { const run = codingRuns.find((item) => item.runId === action[1]); if (!run) return json(response, { error: "not_found" }, 404); Object.assign(run, { status: action[2] === "approve" ? "running" : "canceled", generation: run.generation + 1, updatedAt: Date.now(), canApprove: false, canCancel: action[2] === "approve" }); return json(response, { run }); }
    const executionRoute = url.pathname.match(/^\/api\/organizations\/(fixture-company|fixture-empty)\/workspaces\/([^/]+)\/runs(?:\/([^/]+)\/(approve|cancel))?$/);
    if (executionRoute) {
      const [, organizationId, workspaceId, id, action] = executionRoute;
      if (request.method === "POST") await delay(process.env.VELTRAM_FIXTURE_EXECUTION_DELAY_MS);
      const scoped = executionRuns.filter((run) => run.organizationId === organizationId && run.workspaceId === workspaceId);
      if (request.method === "GET") return json(response, { runs: scoped });
      if (request.method !== "POST") return json(response, { error: "method_not_allowed" }, 405);
      mutationBodies.push({ path: url.pathname, body });
      if (!action) {
        const existing = scoped.find((run) => run.id === body.requestId); if (existing) return json(response, { run: existing });
        const run = { id: body.requestId, organizationId, workspaceId, input: { message: body.message, delayMs: body.delayMs }, generation: 0, status: "waiting_approval", createdAt: Date.now(), updatedAt: Date.now(), leaseExpiresAt: null, canApprove: !empty, canCancel: true };
        executionRuns.unshift(run); return json(response, { run }, 201);
      }
      const run = scoped.find((entry) => entry.id === id); if (!run) return json(response, { error: "not_found" }, 404);
      if (action === "approve" && !run.canApprove) return json(response, { error: "run_state_changed" }, 409);
      const approved = action === "approve";
      Object.assign(run, { status: approved ? "running" : "cancelled", generation: run.generation + 1, updatedAt: Date.now(), leaseExpiresAt: approved ? Date.now() + 60000 : null, canApprove: false, canCancel: approved });
      if (approved) setTimeout(() => {
        if (run.status !== "running") return;
        Object.assign(run, { status: "succeeded", updatedAt: Date.now(), leaseExpiresAt: null, canCancel: false, result: { stdout: run.input.message, artifact: JSON.stringify({ message: run.input.message }, null, 2), exitCode: 0 } });
      }, Math.max(2500, run.input.delayMs));
      return json(response, { run });
    }
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
      if (browserAction[2] === "screenshot") {
        if (browserFixtureState === "screenshot-error") return json(response, { error: "fixture_screenshot_unavailable" }, 503);
        response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" }); response.end(fixtureJpeg); return;
      }
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
    if (url.pathname.endsWith("/reports.md") && process.env.VELTRAM_FIXTURE_REPORT_EXPORT_HTML === "true") { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>Fixture unavailable</title>"); return; }
    if (url.pathname.endsWith("/reports.md")) { response.writeHead(200, { "content-type": "text/markdown" }); response.end("# Relatório sintético do Veltram\n\nNenhum evento real nesta fixture.\n"); return; }
    if (url.pathname.endsWith("/reports")) return json(response, report(url, empty));
    if (url.pathname.startsWith("/api/")) return json(response, { error: "fixture_route_not_found" }, 404);
    const path = resolve(assets, `.${url.pathname === "/" ? "/index.html" : url.pathname}`); if (!path.startsWith(`${assets}${sep}`)) return json(response, { error: "not_found" }, 404);
    const content = await readFile(path); response.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html", "cache-control": "no-store" }); response.end(content);
  } catch { json(response, { error: "fixture_error" }, 500); }
});
server.listen(0, "127.0.0.1", () => console.log(`Agents/reports isolated fixture: http://127.0.0.1:${server.address().port}`));
process.on("SIGINT", () => server.close(() => process.exit(0)));
