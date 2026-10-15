import type { AppEnv } from "./env";
import type { CodingRecord } from "./coding-types";
import { HttpError, json } from "./http";
import { requireMembership } from "./organizations";
import { compareReportMetric, reportBucketPeriods, reportCoverage, resolveReportQuery } from "./report-period";
import type { ExecutionReport, ReportAgent, ReportCoverage, ReportDistribution, ReportFact, ReportGoalTargets, ReportKpis, ReportMetric, ReportRun } from "./report-types";

const inPeriod = (at: number | null | undefined, from: number, to: number) => at != null && at >= from && at < to;
const terminal = new Set(["completed", "failed", "canceled", "interrupted"]);
async function tracking(env: AppEnv, organizationId: string, workspaceId: string, at: number) {
  await env.DB.prepare(`INSERT INTO report_tracking (organization_id,workspace_id,started_at)
    SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM workspaces WHERE id=? AND organization_id=?)
    ON CONFLICT(organization_id,workspace_id) DO UPDATE SET started_at=MIN(started_at,excluded.started_at)`)
    .bind(organizationId, workspaceId, at, workspaceId, organizationId).run();
}
function snapshot(run: CodingRecord): ReportRun {
  return { runId: run.runId, repositoryId: run.repositoryConnectionId, repositoryName: run.repositoryName, task: run.task, status: run.status,
    createdAt: run.createdAt, approvedAt: run.approvedAt ?? null, startedAt: run.startedAt ?? null, finishedAt: run.finishedAt ?? null, publishedAt: run.publishedAt ?? null,
    agents: (run.agents ?? []).map((agent) => ({ id: agent.profileId ?? `role:${agent.role}`, role: agent.role, name: agent.name })),
    test: run.verification ? { command: run.verification.command, exitCode: run.verification.exitCode, finishedAt: run.verification.finishedAt } : null,
    pr: run.result ? { url: run.result.prUrl, number: run.result.prNumber, commitSha: run.result.commitSha, changedFiles: run.result.changedFiles } : null };
}

/** Called only for new, explicitly tracked runs. Replay cannot duplicate a fact or roll a snapshot back. */
export async function recordReportSnapshot(env: AppEnv, run: CodingRecord, facts: readonly ReportFact[], trackingStartedAt: number): Promise<void> {
  await tracking(env, run.organizationId, run.workspaceId, trackingStartedAt);
  const statements = [env.DB.prepare(`INSERT INTO report_runs (organization_id,workspace_id,run_id,generation,updated_at,created_at,snapshot) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(organization_id,workspace_id,run_id) DO UPDATE SET generation=excluded.generation,updated_at=excluded.updated_at,snapshot=excluded.snapshot
    WHERE excluded.generation>report_runs.generation OR (excluded.generation=report_runs.generation AND excluded.updated_at>=report_runs.updated_at)`)
    .bind(run.organizationId, run.workspaceId, run.runId, run.generation, run.updatedAt, run.createdAt, JSON.stringify(snapshot(run)))];
  for (const fact of facts) {
    if (!/^[A-Za-z0-9_:-]{1,120}$/.test(fact.id) || !Number.isSafeInteger(fact.at) || fact.at < trackingStartedAt
      || (fact.tokens !== undefined && (!Number.isSafeInteger(fact.tokens) || fact.tokens < 0))) throw new Error("invalid_report_fact");
    statements.push(env.DB.prepare("INSERT INTO report_facts (organization_id,workspace_id,run_id,fact_id,at,fact) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(run.organizationId, run.workspaceId, run.runId, fact.id, fact.at, JSON.stringify(fact)));
  }
  await env.DB.batch(statements);
}

type FactRow = ReportFact & { runId: string };
function distribution(values: number[]): ReportDistribution {
  values.sort((a, b) => a - b); const n = values.length;
  return { samples: n, median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null, p90: n ? values[Math.max(0, Math.ceil(n * 0.9) - 1)] : null };
}
function kpis(runs: ReportRun[], facts: FactRow[], from: number, to: number, coverage: ReportCoverage): ReportKpis {
  const within = (at: number | null | undefined) => inPeriod(at, from, to);
  const done = runs.filter((run) => within(run.finishedAt));
  const calls = facts.filter((fact) => fact.kind === "model_started" && within(fact.at));
  const usage = facts.filter((fact) => fact.kind === "model_observed" && within(fact.at));
  const observed = new Set(facts.filter((fact) => fact.kind === "model_observed" && fact.at < to).map((fact) => `${fact.runId}:${fact.callId}`));
  const tests = facts.filter((fact) => fact.kind === "test" && within(fact.at));
  const completed = done.filter((run) => run.status === "completed").length, failed = done.filter((run) => run.status === "failed").length, interrupted = done.filter((run) => run.status === "interrupted").length;
  const passed = tests.filter((fact) => fact.exitCode === 0).length;
  const known = (value: number) => coverage === "none" ? null : value;
  return {
    created: known(runs.filter((run) => within(run.createdAt)).length), completed: known(completed), failed: known(failed), interrupted: known(interrupted), canceled: known(done.filter((run) => run.status === "canceled").length),
    prsCreated: known(runs.filter((run) => run.pr && within(run.publishedAt)).length), testsPassed: known(passed), testsFailed: known(tests.length - passed),
    modelCalls: known(calls.length), observedTokens: coverage === "none" || (!usage.length && calls.length > 0) ? null : usage.reduce((sum, fact) => sum + (fact.tokens ?? 0), 0),
    unobservedModelCalls: known(calls.filter((fact) => !observed.has(`${fact.runId}:${fact.callId}`)).length),
    taskSuccessRate: coverage !== "none" && completed + failed + interrupted > 0 ? completed / (completed + failed + interrupted) : null,
    testPassRate: coverage !== "none" && tests.length ? passed / tests.length : null,
    durationMs: distribution(coverage === "none" ? [] : done.filter((run) => run.startedAt !== null && run.finishedAt! >= run.startedAt).map((run) => run.finishedAt! - run.startedAt!)),
    approvalWaitMs: distribution(coverage === "none" ? [] : runs.filter((run) => within(run.approvedAt) && run.approvedAt! >= run.createdAt).map((run) => run.approvedAt! - run.createdAt)),
  };
}
const definitions = {
  created: "Tarefas criadas no período.", completed: "Tarefas concluídas no período com PR confirmado.",
  failed: "Tarefas encerradas com falha no período.", canceled: "Cancelamentos confirmados no período; um PR anterior pode permanecer no GitHub.", interrupted: "Execuções interrompidas no período, inclusive efeitos ainda incertos.",
  prsCreated: "PRs cujo recibo foi confirmado no período, inclusive após cancelamento. Não indica merge ou publicação em produção.",
  testsPassed: "Execuções do comando final com código de saída zero; inclui novas tentativas após reparos.", testsFailed: "Execuções do comando final com código de saída diferente de zero.",
  modelCalls: "Tentativas de chamada ao provedor iniciadas no período. Uma tentativa pode não ter resposta conhecida.",
  observedTokens: "Tokens informados em respostas válidas recebidas no período. Reservas de orçamento e chamadas sem resposta não entram na soma; não representa cobrança.",
  durationMs: "Tempo entre início da execução e encerramento da tarefa. A espera por aprovação é separada. Reconciliação posterior não altera a duração.",
  taskSuccessRate: "Concluídas ÷ (concluídas + falhas + interrompidas) no período. Cancelamentos e tarefas abertas ficam fora.",
  testPassRate: "Comandos finais que passaram ÷ comandos finais executados no período.",
  agents: "Tentativas, tokens observados e duração das chamadas por agente. Tempo de chamada não é tempo de CPU nem trabalho humano economizado.",
};
function goals(value: unknown): ReportGoalTargets {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_report_goals");
  const result: ReportGoalTargets = {};
  for (const [key, target] of Object.entries(value)) {
    if (!["taskSuccessRate", "testPassRate", "durationMinutes"].includes(key) || typeof target !== "number" || !Number.isFinite(target) || target < 0 || target > (key === "durationMinutes" ? 1440 : 100)) throw new HttpError(400, "invalid_report_goals");
    result[key as keyof ReportGoalTargets] = target;
  }
  return result;
}

async function buildReport(env: AppEnv, organizationId: string, workspaceId: string, userId: string, params: URLSearchParams, canEdit: boolean): Promise<ExecutionReport> {
  const now = Date.now(); let resolved: ReturnType<typeof resolveReportQuery>;
  try { resolved = resolveReportQuery(params, now); } catch { throw new HttpError(400, "invalid_report_query"); }
  await tracking(env, organizationId, workspaceId, now);
  const sync = await env.CODING_RUNS.getByName(organizationId).fetch(new Request("https://coding.internal/command", { method: "POST", body: JSON.stringify({ organizationId, workspaceId, userId, action: "report-sync", body: {} }) }));
  const synced = sync.ok && (await sync.json() as { synced?: boolean }).synced === true;
  const [state, rawRuns, rawFacts] = await Promise.all([
    env.DB.prepare("SELECT started_at,goals_version,goals FROM report_tracking WHERE organization_id=? AND workspace_id=?").bind(organizationId, workspaceId).first<{ started_at: number; goals_version: number; goals: string }>(),
    env.DB.prepare("SELECT snapshot,updated_at FROM report_runs WHERE organization_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 10001").bind(organizationId, workspaceId).all<{ snapshot: string; updated_at: number }>(),
    env.DB.prepare("SELECT run_id,fact FROM report_facts WHERE organization_id=? AND workspace_id=? AND at>=? AND at<? ORDER BY at LIMIT 30001").bind(organizationId, workspaceId, resolved.previous.from, now + 1).all<{ run_id: string; fact: string }>(),
  ]);
  const incomplete = !synced || rawRuns.results.length > 10000 || rawFacts.results.length > 30000;
  const allRuns = rawRuns.results.slice(0, 10000).map((row) => JSON.parse(row.snapshot) as ReportRun);
  const runs = allRuns.filter((run) => (!resolved.query.repositoryId || run.repositoryId === resolved.query.repositoryId) && (!resolved.query.agentId || run.agents.some((agent) => agent.id === resolved.query.agentId)));
  const ids = new Set(runs.map((run) => run.runId));
  const facts = rawFacts.results.slice(0, 30000).map((row) => ({ ...JSON.parse(row.fact) as ReportFact, runId: row.run_id })).filter((fact) => ids.has(fact.runId) && (!resolved.query.agentId || !fact.agentId || fact.agentId === resolved.query.agentId));
  const coverage = (from: number, to: number): ReportCoverage => { const value = reportCoverage(state?.started_at ?? null, from, to); return incomplete && value === "full" ? "partial" : value; };
  const currentCoverage = coverage(resolved.period.from, resolved.comparedUntil), previousCoverage = coverage(resolved.previous.from, resolved.previousComparedUntil);
  const current = kpis(runs, facts, resolved.period.from, resolved.comparedUntil, currentCoverage), previous = kpis(runs, facts, resolved.previous.from, resolved.previousComparedUntil, previousCoverage);
  const comparisons = {} as ExecutionReport["comparisons"];
  for (const key of ["created", "completed", "failed", "canceled", "interrupted", "prsCreated", "testsPassed", "testsFailed", "modelCalls", "observedTokens", "taskSuccessRate", "testPassRate", "durationMs"] as ReportMetric[]) {
    const samples = key === "durationMs" ? { current: current.durationMs.samples, previous: previous.durationMs.samples } : key === "taskSuccessRate" ? { current: (current.completed ?? 0) + (current.failed ?? 0) + (current.interrupted ?? 0), previous: (previous.completed ?? 0) + (previous.failed ?? 0) + (previous.interrupted ?? 0) } : key === "testPassRate" ? { current: (current.testsPassed ?? 0) + (current.testsFailed ?? 0), previous: (previous.testsPassed ?? 0) + (previous.testsFailed ?? 0) } : undefined;
    comparisons[key] = compareReportMetric(key === "durationMs" ? current.durationMs.median : current[key], key === "durationMs" ? previous.durationMs.median : previous[key], currentCoverage, previousCoverage, samples);
  }
  const buckets = (period: typeof resolved.period, end: number) => reportBucketPeriods(period, resolved.granularity).map(({ from, to }) => {
    const cover = coverage(from, Math.min(to, end)), values = kpis(runs, facts, from, Math.min(to, end), cover);
    return { start: from, end: to, coverage: cover, created: values.created, completed: values.completed, failed: values.failed, prsCreated: values.prsCreated, testsPassed: values.testsPassed, testsFailed: values.testsFailed, modelCalls: values.modelCalls, observedTokens: values.observedTokens };
  });
  const agents = new Map<string, ReportAgent>();
  const currentFacts = facts.filter((fact) => inPeriod(fact.at, resolved.period.from, resolved.comparedUntil));
  for (const fact of currentFacts) {
    if (!fact.agentId || !fact.agentRole || !fact.agentName || fact.kind === "test") continue;
    const identity = `${fact.agentId}:${fact.agentRole}`;
    let agent = agents.get(identity);
    if (!agent) { agent = { id: fact.agentId, role: fact.agentRole, name: fact.agentName, modelCalls: 0, observedTokens: null, unobservedModelCalls: 0, modelDurationMs: null }; agents.set(identity, agent); }
    if (fact.kind === "model_started") {
      agent.modelCalls++;
      if (!facts.some((other) => other.kind === "model_observed" && other.runId === fact.runId && other.callId === fact.callId && other.at < resolved.comparedUntil)) agent.unobservedModelCalls++;
    } else { agent.observedTokens = (agent.observedTokens ?? 0) + (fact.tokens ?? 0); if (fact.durationMs !== undefined) agent.modelDurationMs = (agent.modelDurationMs ?? 0) + fact.durationMs; }
  }
  const visibleRuns = runs.filter((run) => [run.createdAt, run.finishedAt, run.publishedAt].some((at) => inPeriod(at, resolved.period.from, resolved.comparedUntil)) || currentFacts.some((fact) => fact.runId === run.runId));
  return { version: 1, organizationId, workspaceId, generatedAt: now, timezone: "America/Sao_Paulo", ...resolved,
    coverage: { trackingStartedAt: state?.started_at ?? null, period: currentCoverage, previous: previousCoverage, factsThrough: rawRuns.results.length ? Math.max(...rawRuns.results.map((row) => row.updated_at), ...facts.map((fact) => fact.at)) : null, historyImported: false,
      notes: ["O acompanhamento começa nesta instalação. Nenhum histórico local foi importado.", "Valores de períodos parcialmente cobertos representam somente os fatos observados.", ...(incomplete ? ["Há fatos pendentes de sincronização ou o limite de leitura foi atingido; os totais são parciais."] : [])] },
    kpis: current, previousKpis: previous, comparisons, buckets: buckets(resolved.period, resolved.comparedUntil), previousBuckets: buckets(resolved.previous, resolved.previousComparedUntil),
    agents: [...agents.values()], runs: visibleRuns.slice(0, 100), runsTruncated: visibleRuns.length > 100 || rawRuns.results.length > 10000,
    backlog: { pendingApproval: runs.filter((run) => run.status === "pending_approval").length, active: runs.filter((run) => run.status !== "pending_approval" && !terminal.has(run.status)).length, at: now },
    filters: { repositories: [...new Map(allRuns.map((run) => [run.repositoryId, { id: run.repositoryId, name: run.repositoryName }])).values()], agents: [...new Map(allRuns.flatMap((run) => run.agents.map((agent) => [agent.id, { id: agent.id, name: agent.name }] as const))).values()] },
    goals: { version: state?.goals_version ?? 0, targets: state ? JSON.parse(state.goals) : {}, canEdit }, definitions,
    sources: [{ id: "executions", label: "Tarefas de código do Veltram", status: "available", reason: "Fatos duráveis de tarefas de código, testes, chamadas e recibos GitHub a partir do início do acompanhamento." },
      { id: "browser", label: "Tarefas de navegador", status: "not_tracked", reason: "Ainda não incluídas neste relatório: consulte o histórico na página Computadores." },
      { id: "cost", label: "Custo de IA", status: "not_tracked", reason: "Não acompanhado: o Veltram não recebe a cobrança das contas de IA da empresa." },
      { id: "production", label: "Produção e DORA", status: "not_tracked", reason: "Não acompanhado: um PR criado não comprova merge, deploy, saúde em produção ou tempo de recuperação." },
      { id: "github_backlog", label: "Issues e backlog do GitHub", status: "not_tracked", reason: "Não acompanhado: o relatório contém tarefas do Veltram e não importa o histórico do repositório." }],
  };
}

export function reportMarkdown(report: ExecutionReport): string {
  const number = (value: number | null) => value === null ? "Não disponível" : String(value);
  const escape = (value: string) => value.replace(/[\\`*_{}[\]()#+.!|<>]/g, "\\$&").replace(/\r?\n/g, " ");
  const date = (value: number) => new Intl.DateTimeFormat("pt-BR", { timeZone: report.timezone, dateStyle: "short", timeStyle: "short" }).format(value);
  const percent = (value: number | null) => value === null ? "Não disponível" : `${(value * 100).toFixed(1)}%`;
  const minutes = (value: number | null) => value === null ? "Não disponível" : `${(value / 60000).toFixed(2)} min`;
  const lines = ["# Relatório de execuções — Veltram", "", `Gerado em ${date(report.generatedAt)} · ${report.timezone}`, `Período: ${date(report.period.from)} a ${date(report.comparedUntil)}`, `Anterior: ${date(report.previous.from)} a ${date(report.previousComparedUntil)}`, `Cobertura: ${report.coverage.period}; período anterior: ${report.coverage.previous}.`, `Acompanhamento iniciado: ${report.coverage.trackingStartedAt === null ? "Não disponível" : date(report.coverage.trackingStartedAt)}.`, "", ...report.coverage.notes.map((note) => `> ${note}`), "", "| Métrica | Atual | Anterior |", "| --- | ---: | ---: |"];
  for (const key of ["created", "completed", "failed", "canceled", "interrupted", "prsCreated", "testsPassed", "testsFailed", "modelCalls", "observedTokens"] as const) lines.push(`| ${escape(report.definitions[key])} | ${number(report.kpis[key])} | ${number(report.previousKpis[key])} |`);
  lines.push(`| Chamadas sem uso confirmado | ${number(report.kpis.unobservedModelCalls)} | ${number(report.previousKpis.unobservedModelCalls)} |`);
  for (const key of ["taskSuccessRate", "testPassRate"] as const) lines.push(`| ${escape(report.definitions[key])} | ${percent(report.kpis[key])} | ${percent(report.previousKpis[key])} |`);
  for (const key of ["durationMs", "approvalWaitMs"] as const) {
    const label = key === "durationMs" ? "Duração de execução" : "Espera por aprovação";
    lines.push(`| ${label} (mediana / p90 / amostra) | ${minutes(report.kpis[key].median)} / ${minutes(report.kpis[key].p90)} / ${report.kpis[key].samples} | ${minutes(report.previousKpis[key].median)} / ${minutes(report.previousKpis[key].p90)} / ${report.previousKpis[key].samples} |`);
  }
  lines.push("", "## Filtros e metas", "", `Repositório: ${escape(report.query.repositoryId ?? "Todos")}. Agente: ${escape(report.query.agentId ?? "Todos")}.`, `Metas: sucesso ${number(report.goals.targets.taskSuccessRate ?? null)}%; testes ${number(report.goals.targets.testPassRate ?? null)}%; duração ${number(report.goals.targets.durationMinutes ?? null)} min.`, `Tarefas acompanhadas agora: ${report.backlog.pendingApproval} aguardando aprovação; ${report.backlog.active} em andamento (${date(report.backlog.at)}).`);
  lines.push("", "## Agentes", "", "| Agente | Papel | Chamadas | Tokens observados | Sem uso confirmado | Tempo das chamadas |", "| --- | --- | ---: | ---: | ---: | ---: |");
  for (const agent of report.agents) lines.push(`| ${escape(agent.name)} | ${agent.role} | ${agent.modelCalls} | ${number(agent.observedTokens)} | ${agent.unobservedModelCalls} | ${minutes(agent.modelDurationMs)} |`);
  lines.push("", "## Tarefas", "", "| Tarefa | Repositório | Estado | PR |", "| --- | --- | --- | --- |");
  for (const run of report.runs) lines.push(`| ${escape(run.task)} | ${escape(run.repositoryName)} | ${run.status} | ${run.pr ? `#${run.pr.number}` : "—"} |`);
  if (report.runsTruncated) lines.push("", "A tabela contém as primeiras 100 tarefas; os indicadores podem abranger mais registros.");
  for (const [label, buckets] of [["Atual", report.buckets], ["Anterior", report.previousBuckets]] as const) {
    lines.push("", `## Série — ${label}`, "", "| Intervalo | Cobertura | Criadas | Concluídas | PRs confirmados | Testes passaram / falharam | Chamadas | Tokens observados |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const bucket of buckets) lines.push(`| ${date(bucket.start)} a ${date(bucket.end)} | ${bucket.coverage} | ${number(bucket.created)} | ${number(bucket.completed)} | ${number(bucket.prsCreated)} | ${number(bucket.testsPassed)} / ${number(bucket.testsFailed)} | ${number(bucket.modelCalls)} | ${number(bucket.observedTokens)} |`);
  }
  lines.push("", "## Fontes e limitações", "", ...report.sources.map((source) => `- ${source.label}: ${source.reason}`));
  return lines.join("\n") + "\n";
}

export async function handleReportsRoute(request: Request, env: AppEnv, userId: string, body: Record<string, unknown> = {}): Promise<Response | null> {
  const url = new URL(request.url), match = /^\/api\/organizations\/([A-Za-z0-9_-]{1,80})\/workspaces\/([A-Za-z0-9_-]{1,80})\/reports(\.md|\/goals)?$/.exec(url.pathname);
  if (!match) return null;
  const [, organizationId, workspaceId, suffix] = match;
  const role = await requireMembership(env.DB, organizationId, userId, suffix === "/goals" && request.method === "PUT");
  if (!await env.DB.prepare("SELECT id FROM workspaces WHERE id=? AND organization_id=?").bind(workspaceId, organizationId).first()) throw new HttpError(404, "not_found");
  if (suffix === "/goals") {
    if (request.method !== "PUT") throw new HttpError(404, "not_found");
    const targets = goals(body.targets), version = body.expectedVersion;
    if (!Number.isSafeInteger(version) || Number(version) < 0) throw new HttpError(400, "invalid_version");
    await tracking(env, organizationId, workspaceId, Date.now());
    const updated = await env.DB.prepare(`UPDATE report_tracking SET goals=?,goals_version=goals_version+1 WHERE organization_id=? AND workspace_id=? AND goals_version=?
      AND EXISTS (SELECT 1 FROM memberships WHERE organization_id=? AND user_id=? AND role IN ('owner','admin'))`).bind(JSON.stringify(targets), organizationId, workspaceId, version, organizationId, userId).run();
    if (updated.meta.changes !== 1) throw new HttpError(409, "report_goals_changed");
    return json({ version: Number(version) + 1, targets, canEdit: true });
  }
  if (request.method !== "GET") throw new HttpError(404, "not_found");
  const report = await buildReport(env, organizationId, workspaceId, userId, url.searchParams, role !== "member");
  return suffix === ".md" ? new Response(reportMarkdown(report), { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": 'attachment; filename="veltram-relatorio.md"', "cache-control": "no-store" } }) : json(report);
}
