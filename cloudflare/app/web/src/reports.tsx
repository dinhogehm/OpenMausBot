import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ExecutionReport, ReportGoalTargets, ReportGranularity, ReportPreset, ReportQuery } from "../../src/report-types";
import { api, errorMessage, formatDate, isAbort, organizationPath, type Organization, type Workspace } from "./api";
import { Loading, Notice, PageHeading } from "./components";
import { ReportBars, ReportTrend } from "./report-charts";
import { assertReportScope, reportComparison, reportDateInput, reportDuration, reportNumber, reportPercent, reportPeriodLabel, safeReportPr, validReportRange } from "./report-state";
import "./reports.css";

const presets: [ReportPreset, string][] = [["day", "Hoje"], ["48h", "48 horas"], ["week", "7 dias"], ["fortnight", "15 dias"], ["month", "30 dias"], ["90d", "90 dias"], ["12m", "12 meses"], ["previous_month", "Mês anterior"], ["custom", "Personalizado"]];
const statuses: Record<string, string> = { pending_approval: "A aprovar", queued: "Na fila", running: "Em execução", testing: "Em teste", publishing: "Criando PR", completed: "Concluída", failed: "Falhou", canceled: "Cancelada", interrupted: "Interrompida" };
const metricNames: Record<string, string> = { created: "Tarefas criadas", completed: "Tarefas concluídas", failed: "Falhas", canceled: "Cancelamentos", interrupted: "Interrupções", prsCreated: "PRs confirmados", testsPassed: "Testes finais aprovados", testsFailed: "Testes finais com falha", modelCalls: "Chamadas de IA", observedTokens: "Tokens observados", durationMs: "Duração das tarefas", taskSuccessRate: "Sucesso das tarefas", testPassRate: "Aprovação dos testes", agents: "Esforço por agente" };
const roleNames: Record<string, string> = { coordinator: "Coordenação", programmer: "Programação", reviewer: "Revisão" };

export function Reports({ organization }: { organization: Organization }) {
  return <ReportWorkspace key={organization.id} organization={organization} />;
}
function ReportWorkspace({ organization }: { organization: Organization }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void api<{ workspaces: Workspace[] }>(`${organizationPath(organization.id)}/workspaces`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) { setWorkspaces(data.workspaces); setWorkspaceId(data.workspaces[0]?.id ?? ""); } })
      .catch((failure) => { if (!isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [organization.id, attempt]);
  if (loading) return <Loading label="Carregando espaços de relatório" />;
  if (error) return <><Notice>{error}</Notice><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></>;
  if (!workspaceId) return <PageHeading eyebrow="ATIVIDADE DA EMPRESA" title="Relatórios">Esta empresa ainda não tem um espaço de trabalho disponível.</PageHeading>;
  return <>{workspaces.length > 1 && <div className="field report-controls"><label htmlFor="report-workspace">Espaço de trabalho</label><select id="report-workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></div>}<ReportContent key={workspaceId} organization={organization} workspaceId={workspaceId} /></>;
}
function ReportContent({ organization, workspaceId }: { organization: Organization; workspaceId: string }) {
  const path = `${organizationPath(organization.id)}/workspaces/${encodeURIComponent(workspaceId)}/reports`;
  const [query, setQuery] = useState<ReportQuery>({ period: "week" });
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(reportDateInput(Date.now() - 6 * 86400_000));
  const [to, setTo] = useState(reportDateInput(Date.now()));
  const [compare, setCompare] = useState(true);
  const [report, setReport] = useState<ExecutionReport | null>(null);
  const [filters, setFilters] = useState<ExecutionReport["filters"]>({ repositories: [], agents: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [exporting, setExporting] = useState(false);
  const exportAbort = useRef<AbortController | null>(null);
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== "") as [string, string][]).toString();
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(""); setReport(null);
    void api<ExecutionReport>(`${path}?${params}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) { assertReportScope(data, organization.id, workspaceId); setReport(data); setFilters(data.filters); } })
      .catch((failure) => { if (!isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, params, attempt, organization.id, workspaceId]);
  useEffect(() => () => exportAbort.current?.abort(), []);
  function choosePeriod(period: ReportPreset) { setCustom(period === "custom"); setActionError(""); if (period !== "custom") setQuery((current) => ({ ...current, period, from: undefined, to: undefined, granularity: undefined })); }
  function applyRange(event: FormEvent) { event.preventDefault(); if (!validReportRange(from, to, query.granularity === "month" ? 1096 : query.granularity === "hour" ? 14 : 366) || to > reportDateInput(Date.now())) { setActionError("Informe datas válidas até hoje. Use até 14 dias por hora, 366 dias por dia ou 36 meses por mês."); return; } setActionError(""); setQuery((current) => ({ ...current, period: "custom", from, to })); }
  function previousPeriod() { if (!report) return; const start = reportDateInput(report.previous.from), end = reportDateInput(report.previous.to - 1); setFrom(start); setTo(end); setCustom(true); setQuery((current) => ({ ...current, period: "custom", from: start, to: end })); }
  function nextPeriod() {
    if (!report) return;
    const start = reportDateInput(report.period.to), end = reportDateInput(Math.min(Date.now(), report.period.to + report.period.to - report.period.from - 1));
    setFrom(start); setTo(end); setCustom(true); setQuery((current) => ({ ...current, period: "custom", from: start, to: end }));
  }
  async function exportMarkdown() {
    if (!report || exporting) return;
    const controller = new AbortController(); exportAbort.current = controller; setExporting(true); setActionError("");
    try {
      const response = await fetch(`${path}.md?${params}`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error("export_failed");
      const content = await response.text(); controller.signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `veltram-relatorio-${reportDateInput(report.period.from)}.md`; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (!isAbort(failure)) setActionError("Não foi possível exportar o relatório. Atualize os dados e tente novamente."); }
    finally { if (!controller.signal.aborted) setExporting(false); }
  }
  const kpis = report?.kpis;
  return <div className="report-page">
    <PageHeading eyebrow="ATIVIDADE DA EMPRESA" title="Relatórios">Acompanhe entregas, testes e esforço dos agentes de {organization.name} com base nas execuções registradas.</PageHeading>
    <div className="report-toolbar report-controls"><div className="report-periods" aria-label="Período do relatório">{presets.map(([id, label]) => <button key={id} aria-pressed={custom ? id === "custom" : query.period === id} onClick={() => choosePeriod(id)}>{label}</button>)}</div><div className="button-row"><button className="button secondary small" disabled={!report || exporting} onClick={() => void exportMarkdown()}>{exporting ? "Exportando…" : "Exportar Markdown"}</button><button className="button secondary small" disabled={!report} onClick={() => window.print()}>Imprimir / PDF</button></div></div>
    <div className="report-filters report-controls">
      <div className="field"><label htmlFor="report-repository">Repositório</label><select id="report-repository" value={query.repositoryId ?? ""} onChange={(event) => setQuery((current) => ({ ...current, repositoryId: event.target.value || undefined }))}><option value="">Todos os repositórios</option>{filters.repositories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="field"><label htmlFor="report-agent">Agente</label><select id="report-agent" value={query.agentId ?? ""} onChange={(event) => setQuery((current) => ({ ...current, agentId: event.target.value || undefined }))}><option value="">Todos os agentes</option>{filters.agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="field"><label htmlFor="report-granularity">Agrupar por</label><select id="report-granularity" value={query.granularity ?? ""} onChange={(event) => setQuery((current) => ({ ...current, granularity: event.target.value ? event.target.value as ReportGranularity : undefined }))}><option value="">Automático</option><option value="hour" disabled={!!report && report.period.to - report.period.from > 14 * 86400000}>Hora</option><option value="day" disabled={!!report && report.period.to - report.period.from > 366 * 86400000}>Dia</option><option value="month">Mês</option></select></div>
      <label className="report-compare"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} />Comparar com período anterior</label>
      {custom && <form className="report-filter-dates" onSubmit={applyRange}><div className="field"><label htmlFor="report-from">De</label><input id="report-from" type="date" min="2000-01-01" max={reportDateInput(Date.now())} value={from} onChange={(event) => setFrom(event.target.value)} /></div><div className="field"><label htmlFor="report-to">Até</label><input id="report-to" type="date" min={from || "2000-01-01"} max={reportDateInput(Date.now())} value={to} onChange={(event) => setTo(event.target.value)} /></div><button className="button secondary" type="submit">Aplicar período</button></form>}
    </div>
    {actionError && <Notice>{actionError}</Notice>}{error && <><Notice>{error}</Notice><button className="button secondary report-controls" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></>}
    {loading ? <Loading label="Calculando relatório das execuções" /> : report && kpis && <>
      <div className="report-heading-line"><div><h2>{reportPeriodLabel(report.period)}</h2><p>Horário de Brasília{compare ? ` · Comparação: ${reportPeriodLabel(report.previous)}` : ""}</p></div><div className="button-row report-controls"><button className="text-button" onClick={previousPeriod}>Período anterior</button><button className="text-button" disabled={report.period.to >= Date.now()} onClick={nextPeriod}>Próximo período</button><button className="text-button" onClick={() => setAttempt((value) => value + 1)}>Atualizar</button></div></div>
      {report.coverage.period !== "full" && <Notice kind="info">{report.coverage.period === "none" ? "O acompanhamento ainda não tem registros para este período. Os indicadores sem fonte permanecem como não acompanhados." : "Este período tem cobertura parcial. Os indicadores representam somente as execuções acompanhadas."} {report.coverage.trackingStartedAt ? `A coleta começou em ${formatDate(report.coverage.trackingStartedAt)}.` : "O histórico do OpenMausBot não foi importado."}</Notice>}
      <section className="report-summary" aria-labelledby="report-summary"><div><h2 id="report-summary">Resumo do período</h2><p>{kpis.completed === null ? "Ainda não há cobertura para resumir entregas neste intervalo." : `${reportNumber(kpis.completed)} tarefas concluídas e ${reportNumber(kpis.prsCreated)} PRs confirmados no GitHub.`} {kpis.testsPassed !== null && `${reportNumber(kpis.testsPassed)} execuções do teste final passaram; ${reportNumber(kpis.testsFailed)} falharam.`}</p><ul><li>PR confirmado não comprova merge ou publicação em produção.</li><li>Comparações usam o mesmo tempo decorrido dos dois períodos.</li>{report.coverage.notes.map((note) => <li key={note}>{note}</li>)}</ul></div><aside><dl><div><dt>Aguardando aprovação agora</dt><dd>{report.backlog.pendingApproval}</dd></div><div><dt>Em andamento agora</dt><dd>{report.backlog.active}</dd></div><div><dt>Snapshot do backlog</dt><dd>{formatDate(report.backlog.at)}</dd></div></dl></aside></section>
      <dl className="report-kpis">
        <Metric title="Tarefas criadas" value={reportNumber(kpis.created)} comparison={compare ? reportComparison(report.comparisons.created) : undefined} />
        <Metric title="Tarefas concluídas" value={reportNumber(kpis.completed)} comparison={compare ? reportComparison(report.comparisons.completed) : undefined} />
        <Metric title="PRs confirmados" value={reportNumber(kpis.prsCreated)} comparison={compare ? reportComparison(report.comparisons.prsCreated) : undefined} />
        <Metric title="Sucesso das tarefas" value={reportPercent(kpis.taskSuccessRate)} comparison={compare ? reportComparison(report.comparisons.taskSuccessRate, true) : undefined} />
        <Metric title="Aprovação dos testes finais" value={reportPercent(kpis.testPassRate)} comparison={compare ? reportComparison(report.comparisons.testPassRate, true) : undefined} />
        <Metric title="Duração mediana" value={reportDuration(kpis.durationMs.median)} comparison={`${kpis.durationMs.samples} amostras · p90 ${reportDuration(kpis.durationMs.p90)}`} />
        <Metric title="Chamadas de IA" value={reportNumber(kpis.modelCalls)} comparison={compare ? reportComparison(report.comparisons.modelCalls) : undefined} />
        <Metric title="Tokens observados" value={reportNumber(kpis.observedTokens)} comparison={kpis.unobservedModelCalls ? `${kpis.unobservedModelCalls} chamadas sem uso confirmado` : "Uso informado pelos provedores"} />
      </dl>
      <div className="report-chart-grid"><ReportTrend title="Entregas ao longo do período" description={compare ? "Tarefas concluídas por intervalo. Linha tracejada: período anterior." : "Tarefas concluídas por intervalo."} compare={compare} points={report.buckets.map((bucket, index) => ({ label: new Intl.DateTimeFormat("pt-BR", { timeZone: report.timezone, ...(report.granularity === "hour" ? { hour: "2-digit" } : report.granularity === "month" ? { month: "short", year: "numeric" } : { day: "2-digit", month: "2-digit" }) }).format(bucket.start), current: bucket.completed, previous: report.previousBuckets[index]?.completed }))} /><ReportBars title="Resultados registrados" description="Eventos do período selecionado, sem estimar estados ausentes." items={[{ label: "Concluídas", value: kpis.completed }, { label: "Falhas", value: kpis.failed }, { label: "Canceladas", value: kpis.canceled }, { label: "Interrompidas", value: kpis.interrupted }].filter((item): item is { label: string; value: number } => item.value !== null)} /></div>
      <section className="report-section"><h2>Esforço por agente</h2><p>Chamadas, tokens e tempo do provedor são observações de execução. Não representam horas de trabalho humano ou custo financeiro.</p>{!report.agents.length ? <p className="report-empty">O esforço aparecerá quando houver chamadas acompanhadas neste período.</p> : <div className="report-table-wrap"><table><caption>Uso de IA por perfil e papel</caption><thead><tr><th scope="col">Agente</th><th scope="col">Papel</th><th scope="col">Chamadas</th><th scope="col">Tokens observados</th><th scope="col">Tempo do modelo</th></tr></thead><tbody>{report.agents.map((agent) => <tr key={`${agent.id}-${agent.role}`}><th scope="row">{agent.name}</th><td>{roleNames[agent.role]}</td><td className="report-numeric">{reportNumber(agent.modelCalls)}</td><td>{reportNumber(agent.observedTokens)}{agent.unobservedModelCalls > 0 && <p>{agent.unobservedModelCalls} chamadas sem uso confirmado</p>}</td><td className="report-numeric">{reportDuration(agent.modelDurationMs)}</td></tr>)}</tbody></table></div>}</section>
      <ReportGoals key={report.goals.version} report={report} path={path} canManage={organization.role !== "member"} onSaved={() => setAttempt((value) => value + 1)} />
      <section className="report-section"><h2>Tarefas e PRs</h2><p>Resultados e evidências das tarefas que contribuíram para este intervalo.</p>{report.runsTruncated && <Notice kind="info">A lista atingiu o limite de exibição. Restrinja o período ou os filtros para conferir tarefas específicas.</Notice>}{!report.runs.length ? <p className="report-empty">Nenhuma tarefa corresponde aos filtros selecionados.</p> : <div className="report-table-wrap"><table><caption>Tarefas com o último resultado conhecido</caption><thead><tr><th scope="col">Tarefa</th><th scope="col">Estado</th><th scope="col">Teste final</th><th scope="col">PR</th></tr></thead><tbody>{report.runs.map((run) => { const pr = run.pr ? safeReportPr(run.pr.url, run.repositoryName) : null; return <tr key={run.runId}><th scope="row" className="report-task-title"><details><summary>{run.task}</summary><p>{run.repositoryName}</p><p>Criada em {formatDate(run.createdAt)}</p><p>Equipe: {run.agents.map((agent) => agent.name).join(", ")}</p>{run.test && <p>Comando: <code>{run.test.command}</code></p>}{run.pr && <p>Commit: <code>{run.pr.commitSha}</code></p>}</details></th><td>{statuses[run.status]}</td><td>{run.test ? run.test.exitCode === 0 ? "Passou" : `Falhou (saída ${run.test.exitCode})` : "Não registrado"}</td><td>{pr ? <a href={pr} target="_blank" rel="noopener noreferrer">PR #{run.pr!.number}</a> : "Não confirmado"}</td></tr>; })}</tbody></table></div>}</section>
      <section className="report-section"><h2>Fontes e cobertura</h2><p>Uma métrica sem fonte permanece explícita, sem ser preenchida com zero.</p><dl className="report-source-list">{report.sources.map((source) => <div key={source.id}><dt>{source.label} · {source.status === "available" ? "Acompanhado" : "Não acompanhado"}</dt><dd>{source.reason}</dd></div>)}</dl><details className="chart-data"><summary>Como os indicadores são calculados</summary><dl className="report-source-list">{Object.entries(report.definitions).map(([key, value]) => <div key={key}><dt>{metricNames[key] ?? "Indicador"}</dt><dd>{value}</dd></div>)}</dl></details></section>
      <p className="report-generated">Gerado em {formatDate(report.generatedAt)} · {organization.name} · Histórico importado: nenhum{report.coverage.factsThrough ? ` · Último registro em ${formatDate(report.coverage.factsThrough)}` : ""}</p>
    </>}
  </div>;
}
function Metric({ title, value, comparison }: { title: string; value: string; comparison?: string }) { return <div><dt>{title}</dt><dd>{value === "Não acompanhado" ? <small>{value}</small> : value}</dd>{comparison && <p>{comparison}</p>}</div>; }
function ReportGoals({ report, path, canManage, onSaved }: { report: ExecutionReport; path: string; canManage: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState({ taskSuccessRate: report.goals.targets.taskSuccessRate?.toString() ?? "", testPassRate: report.goals.targets.testPassRate?.toString() ?? "", durationMinutes: report.goals.targets.durationMinutes?.toString() ?? "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const items = [{ key: "taskSuccessRate" as const, label: "Sucesso das tarefas", value: report.kpis.taskSuccessRate === null ? null : report.kpis.taskSuccessRate * 100, unit: "%", max: 100 }, { key: "testPassRate" as const, label: "Aprovação dos testes", value: report.kpis.testPassRate === null ? null : report.kpis.testPassRate * 100, unit: "%", max: 100 }, { key: "durationMinutes" as const, label: "Duração mediana máxima", value: report.kpis.durationMs.median === null ? null : report.kpis.durationMs.median / 60000, unit: "min", max: 1440 }];
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || !canManage || !report.goals.canEdit) return;
    const targets: ReportGoalTargets = {};
    for (const item of items) { const value = values[item.key].trim(); if (!value) continue; const n = Number(value); if (!Number.isFinite(n) || n < 0 || n > item.max || (item.key === "durationMinutes" && n === 0)) { setError("Confira as metas: taxas entre 0 e 100%; duração maior que zero."); return; } targets[item.key] = n; }
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError("");
    try { await api(`${path}/goals`, { method: "PUT", body: { expectedVersion: report.goals.version, targets }, signal: controller.signal }); if (!controller.signal.aborted) { setEditing(false); onSaved(); } }
    catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="report-section"><div className="report-heading-line"><h2>Metas da equipe</h2>{canManage && report.goals.canEdit && <button className="text-button report-controls" onClick={() => setEditing((value) => !value)}>{editing ? "Fechar edição" : "Configurar metas"}</button>}</div><p>Referências definidas pela empresa, aplicadas aos resultados observados do período.</p><div className="report-goals">{items.map((item) => { const target = report.goals.targets[item.key]; return <div key={item.key}><h3>{item.label}</h3><div className="report-goal-value"><span>{item.value === null ? "Não acompanhado" : `${reportNumber(item.value)} ${item.unit}`}</span><span>{target === undefined ? "Sem meta" : `Meta: ${reportNumber(target)} ${item.unit}`}</span></div>{target !== undefined && item.value !== null && <p className="field-hint">{(item.key === "durationMinutes" ? item.value <= target : item.value >= target) ? "Dentro da meta" : "Fora da meta"}</p>}</div>; })}</div>{editing && <form className="report-goal-editor form-stack report-controls" onSubmit={save}>{error && <Notice>{error}</Notice>}<div className="form-pair">{items.map((item) => <div className="field" key={item.key}><label htmlFor={`goal-${item.key}`}>{item.label} ({item.unit})</label><input id={`goal-${item.key}`} type="number" min={item.key === "durationMinutes" ? .1 : 0} max={item.max} step="any" value={values[item.key]} disabled={busy} onChange={(event) => setValues((current) => ({ ...current, [item.key]: event.target.value }))} placeholder="Sem meta" /></div>)}</div><p className="field-hint">Deixe o campo vazio para remover uma meta. Metas não alteram os limites da execução.</p><div><button className="button primary" disabled={busy}>{busy ? "Salvando…" : "Salvar metas"}</button></div></form>}</section>;
}
