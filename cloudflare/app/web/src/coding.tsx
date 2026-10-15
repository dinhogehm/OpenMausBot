import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CodingRunInput, CodingStatus } from "../../src/coding-types";
import type { CredentialProvider } from "../../src/credentials";
import { api, ApiError, errorMessage, formatDate, isAbort, organizationPath, type Credential } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { isCodingActive, mergeCodingRuns, needsCodingRefresh, safePullRequestUrl, testOutcome, type VisibleCodingRun } from "./coding-state";
import type { Section } from "./organization";
import type { GithubState, RepositoryConnection } from "./repositories";
import { agentRoleNames } from "./agents";

const providers: Record<CredentialProvider, string> = { openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter" };
const statusNames: Record<CodingStatus, string> = {
  pending_approval: "Aguardando aprovação", queued: "Na fila", running: "Trabalhando", testing: "Executando testes",
  publishing: "Criando PR", completed: "Concluída", failed: "Falhou", canceled: "Cancelada", interrupted: "Interrompida",
};

function Status({ value }: { value: CodingStatus }) {
  return <span className={`status-pill ${value}`}><span />{statusNames[value]}</span>;
}

export function Coding({ organizationId, workspaceId, onNavigate }: { organizationId: string; workspaceId: string; onNavigate: (section: Section) => void }) {
  const organization = organizationPath(organizationId);
  const path = `${organization}/workspaces/${encodeURIComponent(workspaceId)}/coding-runs`;
  const [runs, setRuns] = useState<VisibleCodingRun[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [actionError, setActionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const selected = runs.find((run) => run.runId === selectedId);
  const hasPending = runs.some((run) => needsCodingRefresh(run));

  function validateScope(records: VisibleCodingRun[]): VisibleCodingRun[] {
    if (records.some((run) => run.organizationId !== organizationId || run.workspaceId !== workspaceId)) throw new Error("Unexpected response scope");
    return records;
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setPollError("");
    void api<{ runs: VisibleCodingRun[] }>(path, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        const scoped = validateScope(data.runs);
        setRuns((current) => mergeCodingRuns(current, scoped));
        setSelectedId((current) => current || scoped[0]?.runId || "");
      })
      .catch((failure: unknown) => {
        if (!isAbort(failure)) {
          if (failure instanceof ApiError && [403, 404].includes(failure.status)) setRuns([]);
          setError(errorMessage(failure));
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);

  useEffect(() => {
    if (!hasPending) return;
    const controller = new AbortController();
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      if (!runs.some((run) => needsCodingRefresh(run))) { window.clearInterval(timer); return; }
      pending = true;
      void api<{ runs: VisibleCodingRun[] }>(path, { signal: controller.signal })
        .then((data) => { if (!controller.signal.aborted) { const scoped = validateScope(data.runs); setRuns((current) => mergeCodingRuns(current, scoped)); setPollError(""); } })
        .catch((failure: unknown) => {
          if (!isAbort(failure)) {
            if (failure instanceof ApiError && [403, 404].includes(failure.status)) { setRuns([]); setError(errorMessage(failure)); }
            else setPollError("Não foi possível atualizar as tarefas. Abaixo está o último estado recebido.");
          }
        })
        .finally(() => { pending = false; });
    }, 2000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [path, hasPending, runs]);

  function changed(run: VisibleCodingRun) {
    validateScope([run]);
    setActionError(""); setRuns((current) => mergeCodingRuns(current, [run])); setSelectedId(run.runId);
  }

  return <>
    <PageHeading eyebrow="TRABALHO NO REPOSITÓRIO" title="Tarefas">Descreva a alteração. O agente prepara o código, executa os testes e entrega um PR para revisão.</PageHeading>
    <CodingSetup organizationPath={organization} path={path} onCreated={changed} onNavigate={onNavigate} />
    <section className="run-history" aria-labelledby="coding-history-title"><div className="section-heading"><div><h2 id="coding-history-title">Histórico de tarefas</h2><p>Alterações, testes e resultados registrados.</p></div><button className="text-button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}><Icon name="refresh" size={15} />Atualizar</button></div>
      {error && <Notice>{error}</Notice>}{actionError && <Notice>{actionError}</Notice>}{pollError && <Notice kind="info">{pollError}</Notice>}
      {loading ? <Loading label="Carregando tarefas" /> : !error && (runs.length === 0 ? <div className="empty-state"><div className="empty-symbol"><Icon name="code" size={24} /></div><h3>Comece com uma alteração bem definida.</h3><p>Informe o resultado esperado e o comando de testes. Um administrador aprova a tarefa antes de ela usar a chave de IA.</p></div> : <div className="run-history-layout coding-history-layout"><div className="run-list" aria-label="Tarefas">{runs.map((run) => <button className={`run-row${run.runId === selectedId ? " selected" : ""}`} key={run.runId} onClick={() => setSelectedId(run.runId)} aria-pressed={run.runId === selectedId}><span className="run-title">{run.task}</span><span className="run-repository">{run.repositoryName}</span><Status value={run.status} /><time dateTime={new Date(run.createdAt).toISOString()}>{formatDate(run.createdAt)}</time></button>)}</div>{selected && <CodingDetail key={selected.runId} path={path} run={selected} onChanged={changed} onConflict={(message) => { setActionError(message); setAttempt((value) => value + 1); }} />}</div>)}
    </section>
  </>;
}

function CodingSetup({ organizationPath: organization, path, onCreated, onNavigate }: { organizationPath: string; path: string; onCreated: (run: VisibleCodingRun) => void; onNavigate: (section: Section) => void }) {
  const [github, setGithub] = useState<GithubState | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const repositories = github?.connections.filter((connection) => connection.status === "active") ?? [];
  const availableProviders = credentials.filter((credential) => credential.status === "configured" && credential.provider in providers).map((credential) => credential.provider as CredentialProvider);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void Promise.all([
      api<GithubState>(`${organization}/github`, { signal: controller.signal }),
      api<{ credentials: Credential[] }>(`${organization}/credentials`, { signal: controller.signal }),
    ]).then(([nextGithub, nextCredentials]) => {
      if (!controller.signal.aborted) { setGithub(nextGithub); setCredentials(nextCredentials.credentials); }
    }).catch((failure: unknown) => { if (!isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [organization, attempt]);

  if (loading) return <Loading label="Conferindo repositórios e chaves de IA" />;
  if (error) return <><Notice>{error}</Notice><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></>;
  if (!repositories.length || !availableProviders.length) return <section className="coding-setup" aria-labelledby="coding-setup-title"><h2 id="coding-setup-title">Prepare a primeira tarefa</h2>
    <div className="setup-step"><span className="setup-step-number" aria-hidden="true">1</span><div><h3>{repositories.length ? "Repositório conectado" : "Conecte um repositório"}</h3><p>{repositories.length ? `${repositories.length} ${repositories.length === 1 ? "repositório disponível" : "repositórios disponíveis"} para esta empresa.` : github?.configured ? "Escolha no GitHub o código em que o agente vai trabalhar." : "A conexão com o GitHub ainda precisa ser configurada pelo responsável pela Veltram."}</p></div><button className="button secondary small" onClick={() => onNavigate("repositories")}>{repositories.length ? "Ver repositórios" : "Repositórios"}</button></div>
    <div className="setup-step"><span className="setup-step-number" aria-hidden="true">2</span><div><h3>{availableProviders.length ? "Chave de IA armazenada" : "Adicione uma chave de IA"}</h3><p>{availableProviders.length ? "O modelo e o acesso ao provedor serão verificados durante a execução." : "A tarefa usa a chave e os limites da conta de IA da empresa."}</p></div><button className="button secondary small" onClick={() => onNavigate("credentials")}>{availableProviders.length ? "Ver chaves" : "Chaves de IA"}</button></div>
  </section>;
  return <CodingComposer path={path} repositories={repositories} availableProviders={availableProviders} onCreated={onCreated} />;
}

function CodingComposer({ path, repositories, availableProviders, onCreated }: { path: string; repositories: RepositoryConnection[]; availableProviders: CredentialProvider[]; onCreated: (run: VisibleCodingRun) => void }) {
  const [repositoryId, setRepositoryId] = useState(repositories[0].id);
  const [baseRef, setBaseRef] = useState(repositories[0].defaultBranch);
  const [task, setTask] = useState("");
  const [provider, setProvider] = useState<CredentialProvider>(availableProviders[0]);
  const [model, setModel] = useState("");
  const [setupCommand, setSetupCommand] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!task.trim() || !baseRef.trim() || !model.trim() || !testCommand.trim()) {
      setError("Descreva a tarefa e preencha a branch, o modelo e o comando de testes."); setSettingsOpen(true); return;
    }
    const fields = { repositoryConnectionId: repositoryId, baseRef: baseRef.trim(), task: task.trim(), provider, model: model.trim(), setupCommand: setupCommand.trim(), testCommand: testCommand.trim() };
    const fingerprint = JSON.stringify(fields);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    const body: CodingRunInput = { ...fields, requestId: request.current.id };
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError("");
    try {
      const data = await api<{ run: VisibleCodingRun }>(path, { method: "POST", body, signal: controller.signal });
      if (!controller.signal.aborted) { onCreated(data.run); setTask(""); request.current = null; }
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <form className="run-composer coding-composer form-stack" onSubmit={create} noValidate>
    <div className="composer-heading"><h2>Nova tarefa</h2><span>Revisão por PR</span></div>
    {error && <Notice>{error}</Notice>}
    <div className="field"><label htmlFor="coding-repository">Repositório</label><select id="coding-repository" disabled={busy} value={repositoryId} onChange={(event) => { setRepositoryId(event.target.value); setBaseRef(repositories.find((repository) => repository.id === event.target.value)?.defaultBranch ?? ""); }}>{repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.fullName}</option>)}</select></div>
    <div className="field"><label htmlFor="coding-task">O que precisa mudar?</label><textarea id="coding-task" rows={4} required maxLength={4000} disabled={busy} value={task} onChange={(event) => setTask(event.target.value)} placeholder="Descreva o problema, o resultado esperado e como verificar a alteração." aria-describedby="coding-task-help" /><div className="textarea-footer" id="coding-task-help"><span>Inclua o contexto necessário para uma alteração específica.</span><span>{task.length}/4.000</span></div></div>
    <details className="execution-settings" open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}><summary>Modelo e execução <span>{model && testCommand ? `${providers[provider]} · ${model}` : "Configuração necessária"}</span></summary><div className="execution-settings-fields form-stack">
      <div className="form-pair"><div className="field"><label htmlFor="coding-provider">Provedor de IA</label><select id="coding-provider" value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value as CredentialProvider); setModel(""); }}>{availableProviders.map((value) => <option key={value} value={value}>{providers[value]}</option>)}</select></div><div className="field"><label htmlFor="coding-model">Modelo</label><input id="coding-model" required maxLength={120} autoComplete="off" disabled={busy} value={model} onChange={(event) => setModel(event.target.value)} placeholder="ID do modelo na sua conta" /></div></div>
      <p className="field-hint">Use um modelo com suporte a ferramentas. A disponibilidade e o custo dependem da conta da empresa no provedor.</p>
      <div className="field"><label htmlFor="coding-base">Branch de origem</label><input id="coding-base" required maxLength={200} autoComplete="off" disabled={busy} value={baseRef} onChange={(event) => setBaseRef(event.target.value)} /><p className="field-hint">A alteração será entregue em uma nova branch com um PR em rascunho.</p></div>
      <div className="field"><label htmlFor="coding-setup">Preparação do projeto <span className="optional-label">opcional</span></label><input id="coding-setup" maxLength={2000} autoComplete="off" spellCheck={false} disabled={busy} value={setupCommand} onChange={(event) => setSetupCommand(event.target.value)} placeholder="Ex.: npm ci" /><p className="field-hint">Comando para instalar dependências ou preparar o ambiente.</p></div>
      <div className="field"><label htmlFor="coding-test">Comando de testes</label><input id="coding-test" required maxLength={2000} autoComplete="off" spellCheck={false} disabled={busy} value={testCommand} onChange={(event) => setTestCommand(event.target.value)} placeholder="Ex.: npm test" /><p className="field-hint">Informe os testes que comprovam a tarefa. O comando será executado sobre o código final.</p></div>
    </div></details>
    <div className="coding-composer-footer"><p>Um administrador revisa e aprova o uso da chave de IA antes da execução.</p><button className="button primary" disabled={busy || !task.trim()}>{busy ? "Criando tarefa…" : "Criar tarefa"}<Icon name="arrow" /></button></div>
  </form>;
}

function CodingDetail({ path, run, onChanged, onConflict }: { path: string; run: VisibleCodingRun; onChanged: (run: VisibleCodingRun) => void; onConflict: (message: string) => void }) {
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const resultUrl = run.result ? safePullRequestUrl(run.result.prUrl, run.repositoryName) : null;
  const outcome = testOutcome(run);
  const providerNames = [...new Set((run.agents?.length ? run.agents : [run]).map((agent) => providers[agent.provider]))].join(", ");

  async function act(action: "approve" | "cancel") {
    if (busy) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(action); setError("");
    try {
      const data = await api<{ run: VisibleCodingRun }>(`${path}/${encodeURIComponent(run.runId)}/${action}`, { method: "POST", body: { generation: run.generation }, signal: controller.signal });
      if (!controller.signal.aborted) onChanged(data.run);
    } catch (failure) {
      if (!isAbort(failure)) {
        if (failure instanceof ApiError && [403, 404, 409].includes(failure.status)) onConflict(errorMessage(failure));
        else setError(errorMessage(failure));
      }
    } finally { if (!controller.signal.aborted) setBusy(null); }
  }

  return <article className="run-detail coding-detail" aria-label="Detalhes da tarefa">
    <div className="run-detail-heading"><h3>Tarefa no repositório</h3><Status value={run.status} /></div><p className="run-repository detail-repository">{run.repositoryName}</p><p className="run-input">{run.task}</p>
    {error && <Notice>{error}</Notice>}
    <dl className="coding-configuration"><div><dt>Origem</dt><dd className="mono">{run.baseRef}</dd></div><div><dt>Modelo</dt><dd>{providers[run.provider]} · {run.model}</dd></div><div><dt>Preparação</dt><dd className="mono">{run.setupCommand || "Nenhum comando"}</dd></div><div><dt>Testes</dt><dd className="mono">{run.testCommand}</dd></div></dl>
    {run.status === "pending_approval" && <div className="approval-request"><h4>{run.canApprove ? "Revisar e iniciar" : "Aguardando um administrador"}</h4><p>A aprovação permite usar as chaves de IA desta empresa ({providerNames}), executar os comandos acima e criar uma branch e um PR em rascunho no repositório. O uso de IA pode gerar cobrança nos provedores.</p><p>Limite por tarefa: 30 minutos e até 30 chamadas de IA.</p><div className="button-row">{run.canApprove && <button className="button primary small" disabled={busy !== null} onClick={() => void act("approve")}><Icon name="check" size={16} />{busy === "approve" ? "Aprovando…" : "Aprovar e executar"}</button>}{run.canCancel && <button className="button secondary small" disabled={busy !== null} onClick={() => void act("cancel")}>{busy === "cancel" ? "Cancelando…" : "Cancelar"}</button>}</div></div>}
    {isCodingActive(run.status) && <div className="execution-progress"><p role="status"><span className="small-dot" />{statusNames[run.status]}{run.agentStage ? ` · ${run.agents?.find((agent) => agent.role === run.agentStage)?.name ?? agentRoleNames[run.agentStage]}` : ""}</p><p className="muted">A execução continua na nuvem. Você pode voltar a este histórico para acompanhar.</p>{run.canCancel && <button className="button secondary small" disabled={busy !== null} onClick={() => void act("cancel")}><Icon name="stop" size={14} />{busy === "cancel" ? "Cancelando…" : "Cancelar tarefa"}</button>}</div>}
    {run.status === "interrupted" && !run.error && <Notice kind="info">A execução foi interrompida. Confira o último registro e o GitHub antes de criar outra tarefa, pois algum efeito pode precisar de confirmação.</Notice>}
    {run.status === "canceled" && <p className="muted execution-message">Tarefa cancelada. As alterações já publicadas, se houver, permanecem no GitHub.</p>}
    {run.error && <Notice>{errorMessage(new ApiError(503, run.error))}</Notice>}
    {run.summary && <section className="coding-summary"><h4>Resumo do agente</h4><p>{run.summary}</p></section>}
    {run.plan && <details className="coding-log"><summary>Plano do coordenador</summary><p className="agent-plan">{run.plan}</p></details>}
    {run.review && <section className="coding-summary"><h4>Revisão do agente: {run.review.approved ? "aprovada" : "alterações solicitadas"}</h4><p>{run.review.summary}</p></section>}
    <section className="result-evidence coding-verification" aria-label="Verificação por testes"><div className="evidence-heading"><h4>Verificação final</h4><span className={`status-pill ${outcome === "passed" ? "succeeded" : outcome === "failed" ? "failed" : "neutral"}`}><span />{outcome === "passed" ? "Comando passou" : outcome === "failed" ? "Comando falhou" : "Sem resultado de testes"}</span></div>
      {run.verification ? <><p className="command-label mono">{run.verification.command}</p><p className="evidence-caption">Código de saída: {run.verification.exitCode} · {formatDate(run.verification.finishedAt)}</p><pre tabIndex={0} aria-label="Saída dos testes finais">{run.verification.output || "O comando não produziu saída de texto."}</pre>{run.verification.truncated && <p className="field-hint">A saída atingiu o limite de exibição. Apenas parte do texto está disponível.</p>}</> : <p className="muted">Ainda não há resultado confirmado do comando de testes sobre a alteração final.</p>}
    </section>
    {run.result && <section className="coding-result"><h4>Alteração no GitHub</h4><p>{run.result.changedFiles} {run.result.changedFiles === 1 ? "arquivo alterado" : "arquivos alterados"} · PR #{run.result.prNumber}</p>{resultUrl ? <a className="button primary small" href={resultUrl} target="_blank" rel="noopener noreferrer">Revisar PR no GitHub<Icon name="arrow" size={16} /></a> : <Notice kind="info">O endereço do PR não pôde ser confirmado. Confira a branch no repositório.</Notice>}<p className="field-hint mono">{run.result.branch}</p></section>}
    {run.events.length > 0 && <details className="coding-log"><summary>Registro da execução <span>{run.events.length} eventos</span></summary><ol>{run.events.map((event) => <li key={event.id}><div className="event-heading"><time dateTime={new Date(event.at).toISOString()}>{formatDate(event.at)}</time><span>{event.kind === "model" ? "Modelo" : event.kind === "tool" ? "Ferramenta" : event.kind === "test" ? "Teste" : event.kind === "error" ? "Erro" : "Estado"}{event.exitCode !== undefined ? ` · saída ${event.exitCode}` : ""}</span></div><pre tabIndex={0}>{event.text}</pre>{event.truncated && <p className="field-hint">Saída parcial por limite de tamanho.</p>}</li>)}</ol></details>}
    {run.agents && <details className="coding-log"><summary>Equipe desta tarefa</summary><dl className="coding-configuration">{run.agents.map((agent) => <div key={agent.role}><dt>{agentRoleNames[agent.role]}</dt><dd>{agent.name}<br /><span className="muted">{providers[agent.provider]} · {agent.model}</span></dd></div>)}</dl></details>}
    <dl className="run-metadata"><div><dt>Criada em</dt><dd>{formatDate(run.createdAt)}</dd></div><div><dt>Última atualização</dt><dd>{formatDate(run.updatedAt)}</dd></div><div><dt>Chamadas de IA</dt><dd>{run.modelCalls}</dd></div>{run.baseSha && <div><dt>Commit de origem</dt><dd className="mono">{run.baseSha}</dd></div>}{run.result && <div><dt>Commit entregue</dt><dd className="mono">{run.result.commitSha}</dd></div>}<div><dt>Identificação</dt><dd className="mono">{run.runId}</dd></div></dl>
  </article>;
}
