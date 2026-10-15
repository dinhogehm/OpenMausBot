import { useNavigationGuard } from "./navigation-guard";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AgentCatalogState, AgentSelections } from "../../src/agent-catalog-types";
import { CodingTeamPicker } from "./coding-team";
import type { CodingRunInput, CodingStatus } from "../../src/coding-types";
import type { BudgetView } from "../../src/budget-types";
import type { ClaudeConnectionStatus } from "../../src/claude-types";
import type { CredentialProvider } from "../../src/credentials";
import { api, ApiError, errorMessage, formatDate, isAbort, organizationPath, type Credential } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { isCodingActive, mergeCodingRuns, needsCodingRefresh, safePullRequestUrl, testOutcome, type VisibleCodingRun } from "./coding-state";
import type { Section } from "./organization";
import type { GithubState, RepositoryConnection } from "./repositories";
import { agentRoleNames } from "./agents";
import { boardColumn, boardColumns, filterBoardRuns } from "./kanban-state";
import "./kanban.css";

const providers: Record<CredentialProvider, string> = { openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter" };
const statusNames: Record<CodingStatus, string> = {
  pending_approval: "Aguardando aprovação", queued: "Na fila", running: "Trabalhando", testing: "Executando testes",
  publishing: "Criando PR", completed: "Execução concluída", failed: "Falhou", canceled: "Cancelada", interrupted: "Interrompida",
};

function Status({ value }: { value: CodingStatus }) {
  return <span className={`status-pill ${value}`}><span />{statusNames[value]}</span>;
}

export function Coding({ organizationId, workspaceId, onNavigate }: { organizationId: string; workspaceId: string; onNavigate: (section: Section) => void }) {
  const organization = organizationPath(organizationId);
  const path = `${organization}/workspaces/${encodeURIComponent(workspaceId)}/coding-runs`;
  const [runs, setRuns] = useState<VisibleCodingRun[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [repositoryFilter, setRepositoryFilter] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterToggle = useRef<HTMLButtonElement>(null);
  const filterPanel = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [draftChanged, setDraftChanged] = useState(false);
  useNavigationGuard({ dirty: draftChanged, busy: dialogBusy });
  const dialogOpener = useRef<HTMLElement | null>(null);
  const columns = useRef(new Map<string, HTMLElement>());
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [actionError, setActionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const selected = runs.find((run) => run.runId === selectedId);
  const hasPending = runs.some((run) => needsCodingRefresh(run));

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 700px)");
    const preserveFilterFocus = () => {
      if (mobile.matches && filterPanel.current?.contains(document.activeElement)) setFiltersOpen(true);
      else if (!mobile.matches && document.activeElement === filterToggle.current) document.getElementById("board-search")?.focus();
    };
    mobile.addEventListener("change", preserveFilterFocus);
    return () => mobile.removeEventListener("change", preserveFilterFocus);
  }, []);

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
        setUpdatedAt(Date.now());
      })
      .catch((failure: unknown) => {
        if (!isAbort(failure)) {
          if (failure instanceof ApiError && [403, 404].includes(failure.status)) setRuns([]);
          setError(errorMessage(failure));
        }
      })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); setLoaded(true); } });
    return () => controller.abort();
  }, [path, attempt]);

  useEffect(() => {
    if (!loaded) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      void api<{ runs: VisibleCodingRun[] }>(path, { signal: controller.signal })
        .then((data) => { if (!controller.signal.aborted) { const scoped = validateScope(data.runs); setRuns((current) => mergeCodingRuns(current, scoped)); setPollError(""); setError(""); setUpdatedAt(Date.now()); } })
        .catch((failure: unknown) => {
          if (!isAbort(failure)) {
            if (failure instanceof ApiError && [403, 404].includes(failure.status)) { setRuns([]); setError(errorMessage(failure)); }
            else setPollError("Não foi possível atualizar as tarefas. Abaixo está o último estado recebido.");
          }
        })
        .finally(() => { pending = false; });
    };
    const timer = window.setInterval(refresh, hasPending ? 2000 : 15000);
    document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [path, hasPending, loaded]);

  function changed(run: VisibleCodingRun) {
    validateScope([run]);
    setActionError(""); setRuns((current) => mergeCodingRuns(current, [run])); setSelectedId(run.runId); setCreating(false); setDraftChanged(false); setDialogBusy(false); setUpdatedAt(Date.now());
  }

  const visible = filterBoardRuns(runs, { query, repository: repositoryFilter, agent: agentFilter });
  const repositories = [...new Set(runs.map((run) => run.repositoryName))].sort();
  const agents = [...new Set(runs.flatMap((run) => run.agents?.map((agent) => agent.name) ?? []))].sort();
  const filtered = Boolean(query.trim() || repositoryFilter || agentFilter);
  const activeFilters = [query.trim() && `Busca: “${query.trim()}”`, repositoryFilter && `Repositório: ${repositoryFilter}`, agentFilter && `Agente da equipe: ${agentFilter}`].filter(Boolean);
  const clearFilters = () => { setQuery(""); setRepositoryFilter(""); setAgentFilter(""); queueMicrotask(() => {
    if (!filtersOpen && window.matchMedia("(max-width: 700px)").matches) filterToggle.current?.focus();
    else document.getElementById("board-search")?.focus();
  }); };
  function openCreate(opener: HTMLElement) { dialogOpener.current = opener; setDialogBusy(false); setDraftChanged(false); setCreating(true); }
  function openTask(run: VisibleCodingRun, opener: HTMLElement) { dialogOpener.current = opener; setDialogBusy(false); setSelectedId(run.runId); }
  function jumpToColumn(id: string) {
    const column = columns.current.get(id);
    column?.scrollIntoView({ block: "nearest", inline: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    column?.focus({ preventScroll: true });
  }

  return <>
    <div className="kanban-heading"><PageHeading eyebrow="DO PEDIDO AO PULL REQUEST" title="Tarefas">Um lugar para aprovar, acompanhar e revisar o trabalho da equipe.</PageHeading><button className="button primary" onClick={(event) => openCreate(event.currentTarget)}><Icon name="plus" size={17} />Nova tarefa</button></div>
    {error && runs.length > 0 && <Notice>{error} O quadro mantém o último estado recebido.</Notice>}{actionError && <Notice>{actionError}</Notice>}{pollError && <Notice kind="info">{pollError}</Notice>}
    <div className="kanban-filter-bar"><button ref={filterToggle} type="button" className="button secondary kanban-filter-toggle" aria-expanded={filtersOpen} aria-controls="kanban-filters" onClick={() => setFiltersOpen((current) => !current)}><Icon name="filter" size={16} />Filtros{activeFilters.length > 0 && <span className="filter-count">{activeFilters.length}</span>}</button><div ref={filterPanel} id="kanban-filters" className={`kanban-controls ${filtersOpen ? "is-open" : "is-collapsed"}`}><div className="field board-search"><label htmlFor="board-search">Buscar tarefas</label><input id="board-search" type="search" placeholder="Tarefa, repositório ou agente" value={query} onChange={(event) => setQuery(event.target.value)} /></div><div className="field"><label htmlFor="board-repository">Repositório</label><select id="board-repository" value={repositoryFilter} onChange={(event) => setRepositoryFilter(event.target.value)}><option value="">Todos os repositórios</option>{repositories.map((name) => <option key={name} value={name}>{name}</option>)}</select></div><div className="field"><label htmlFor="board-agent">Agente da equipe</label><select id="board-agent" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}><option value="">Toda a equipe</option>{agents.map((name) => <option key={name} value={name}>{name}</option>)}</select></div></div><button className="button secondary kanban-refresh" disabled={loading} onClick={() => setAttempt((value) => value + 1)}><Icon name="refresh" size={16} />Atualizar</button></div>
    {filtered && <p className="kanban-active-filters">{activeFilters.join(" · ")}</p>}
    <div className="kanban-summary"><div><p aria-live="polite">{loaded ? error && !runs.length ? "Quadro indisponível" : `${visible.length} ${visible.length === 1 ? "tarefa" : "tarefas"}${filtered ? ` de ${runs.length} no quadro` : " no quadro"}` : "Carregando tarefas…"}</p>{filtered && <button type="button" className="text-button" onClick={clearFilters}>Limpar filtros</button>}</div><p>{updatedAt ? `Atualizado às ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(updatedAt)} · atualização automática` : "Os cartões avançam conforme a execução."}</p></div>
    {!loaded ? <div className="kanban-loading" role="status" aria-label="Carregando tarefas"><div className="kanban-skeleton" aria-hidden="true">{[0, 1, 2].map((value) => <div key={value}><span /><i /><i /></div>)}</div></div> : error && !runs.length ? <section className="kanban-message"><Icon name="refresh" size={22} /><div><h2>Não foi possível carregar o quadro</h2><p>{error}</p><button className="button secondary" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></div></section> : <>
    {!runs.length && <section className="kanban-welcome"><div><span className="eyebrow">SEU PRIMEIRO TRABALHO</span><h2>Do objetivo a uma alteração revisável.</h2><p>Crie uma tarefa, confira a equipe e os testes. Após a aprovação, acompanhe cada etapa neste quadro.</p></div><ol aria-label="Etapas da primeira tarefa"><li><span>1</span>Descreva a mudança</li><li><span>2</span>Revise e aprove</li><li><span>3</span>Confira o PR</li></ol></section>}
    {filtered && !visible.length ? <section className="kanban-message"><Icon name="code" size={22} /><div><h2>Nenhuma tarefa corresponde aos filtros</h2><p>Tente outro termo ou limpe os filtros para ver o quadro completo.</p><button className="button secondary" onClick={clearFilters}>Limpar filtros</button></div></section> : <>
    <nav className="kanban-stage-nav" aria-label="Ir para uma etapa do quadro">{boardColumns.map((column) => { const count = visible.filter((run) => boardColumn(run) === column.id).length; return <button type="button" key={column.id} className={`stage-link ${column.id}`} onClick={() => jumpToColumn(column.id)} aria-controls={`board-column-${column.id}`} aria-label={`${column.name}: ${count} ${count === 1 ? "tarefa" : "tarefas"}`}><span className="board-dot" aria-hidden="true" /><span>{column.name}</span><strong>{count}</strong></button>; })}</nav>
    <div className="kanban-scroll" tabIndex={0} role="region" aria-label="Quadro Kanban de tarefas" aria-describedby="kanban-scroll-help" aria-busy={loading}><div className={`kanban-board ${!runs.length ? "is-empty" : ""}`}>{boardColumns.map((column) => {
      const cards = visible.filter((run) => boardColumn(run) === column.id);
      return <section className={`kanban-column ${column.id}`} key={column.id} id={`board-column-${column.id}`} tabIndex={-1} ref={(element) => { if (element) columns.current.set(column.id, element); else columns.current.delete(column.id); }} aria-labelledby={`board-${column.id}`}><header><span className="board-dot" aria-hidden="true" /><h2 id={`board-${column.id}`}>{column.name}</h2><span aria-label={`${cards.length} ${cards.length === 1 ? "tarefa" : "tarefas"}`}>{cards.length}</span></header><div className="kanban-cards">{cards.length ? cards.map((run) => <button className="kanban-card" key={run.runId} onClick={(event) => openTask(run, event.currentTarget)} aria-label={`${run.task}, ${statusNames[run.status]}`}><span className="run-repository" title={run.repositoryName}>{run.repositoryName}</span><strong>{run.task}</strong><Status value={run.status} />{run.result && safePullRequestUrl(run.result.prUrl, run.repositoryName) && <span className="board-receipt">PR #{run.result.prNumber} registrado</span>}<span className="kanban-card-footer"><span className="kanban-card-agent" title={run.agents?.find((agent) => agent.role === run.agentStage)?.name ?? run.agents?.find((agent) => agent.role === "programmer")?.name}>{run.agents?.find((agent) => agent.role === run.agentStage)?.name ?? run.agents?.find((agent) => agent.role === "programmer")?.name ?? "Equipe da tarefa"}</span><time dateTime={new Date(run.createdAt).toISOString()}>{new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(run.createdAt)}</time></span></button>) : <p className="kanban-empty">{filtered ? "Nenhuma tarefa nesta etapa com os filtros atuais." : column.hint}</p>}</div></section>;
    })}</div></div><p className="kanban-footnote" id="kanban-scroll-help">Use as etapas acima ou role o quadro para os lados. As tarefas mudam de etapa automaticamente.</p>
    </>}
    {runs.length >= 100 && <p className="kanban-history-note">O quadro mostra o histórico recente e as tarefas em andamento já carregadas. Os filtros se aplicam a esses itens.</p>}
    </>}
    {creating && <TaskDialog title="Nova tarefa" busy={dialogBusy} dirty={draftChanged} opener={dialogOpener.current} onClose={() => setCreating(false)}><CodingSetup organizationPath={organization} path={path} onCreated={changed} onBusyChange={setDialogBusy} onDraftChange={setDraftChanged} onNavigate={(section) => { setCreating(false); onNavigate(section); }} /></TaskDialog>}
    {selected && !creating && <TaskDialog title="Detalhes da tarefa" busy={dialogBusy} opener={dialogOpener.current} onClose={() => setSelectedId("")}><CodingDetail key={selected.runId} path={path} run={selected} onChanged={changed} onBusyChange={setDialogBusy} onConflict={(message) => { setActionError(message); setAttempt((value) => value + 1); }} /></TaskDialog>}
  </>;
}

function TaskDialog({ title, onClose, children, busy = false, dirty = false, opener }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean; dirty?: boolean; opener: HTMLElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const returnFocus = useRef(opener);
  useEffect(() => {
    const element = dialog.current; element?.showModal();
    return () => { element?.close(); queueMicrotask(() => { if (returnFocus.current?.isConnected && !document.querySelector("dialog[open]")) returnFocus.current.focus({ preventScroll: true }); }); };
  }, []);
  function requestClose() { if (busy) return; if (dirty) setConfirmClose(true); else onClose(); }
  function continueEditing() { setConfirmClose(false); queueMicrotask(() => dialog.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus()); }
  return <dialog ref={dialog} className="task-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); if (busy) return; if (confirmClose) continueEditing(); else requestClose(); }}><header className="task-dialog-header"><h2>{title}</h2><button className="text-button" disabled={busy} onClick={requestClose} aria-label={`Fechar ${title.toLocaleLowerCase("pt-BR")}`}>Fechar <span aria-hidden="true">×</span></button></header>{busy && <p className="task-dialog-progress" role="status">Aguarde a confirmação da operação para fechar.</p>}{confirmClose && <div className="task-draft-confirm" role="alert"><div><strong>Descartar o rascunho local?</strong><p>As informações preenchidas nesta janela serão perdidas.</p></div><div className="button-row"><button type="button" className="button secondary small" disabled={busy} onClick={continueEditing}>Continuar editando</button><button type="button" className="button danger small" disabled={busy} onClick={() => { if (!busy) onClose(); }}>Descartar rascunho</button></div></div>}<div className="task-dialog-content">{children}</div></dialog>;
}

function CodingSetup({ organizationPath: organization, path, onCreated, onNavigate, onBusyChange, onDraftChange }: { organizationPath: string; path: string; onCreated: (run: VisibleCodingRun) => void; onNavigate: (section: Section) => void; onBusyChange: (busy: boolean) => void; onDraftChange: (dirty: boolean) => void }) {
  const [github, setGithub] = useState<GithubState | null>(null);
  const [catalog, setCatalog] = useState<AgentCatalogState | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [claude, setClaude] = useState<ClaudeConnectionStatus | null>(null);
  const nativeAvailable = claude?.enabled && claude.state === "connected" && claude.authMethod === "claude.ai";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const repositories = github?.connections.filter((connection) => connection.status === "active") ?? [];
  const availableProviders = credentials.filter((credential) => credential.status === "configured" && credential.provider in providers && (!budget?.enforcement?.required || budget.enforcement.paidApiAvailable && credential.provider === "openrouter")).map((credential) => credential.provider as CredentialProvider);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void Promise.all([
      api<GithubState>(`${organization}/github`, { signal: controller.signal }),
      api<{ credentials: Credential[] }>(`${organization}/credentials`, { signal: controller.signal }),
      api<AgentCatalogState>(`${organization}/agent-catalog`, { signal: controller.signal }),
      api<ClaudeConnectionStatus>(`${organization}/me/claude-code`, { signal: controller.signal }),
      api<BudgetView>(`${organization}/budget`, { signal: controller.signal }),
    ]).then(([nextGithub, nextCredentials, nextCatalog, nextClaude, nextBudget]) => {
      if (!controller.signal.aborted) { setGithub(nextGithub); setCredentials(nextCredentials.credentials); setCatalog(nextCatalog); setClaude(nextClaude); setBudget(nextBudget); }
    }).catch((failure: unknown) => { if (!isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [organization, attempt]);

  if (loading) return <Loading label="Conferindo repositórios e conexões de IA" />;
  if (error) return <><Notice>{error}</Notice><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></>;
  if (!repositories.length || (!availableProviders.length && !nativeAvailable)) return <section className="coding-setup" aria-labelledby="coding-setup-title"><h2 id="coding-setup-title">Prepare a primeira tarefa</h2>{budget?.enforcement?.required && !budget.enforcement.paidApiAvailable && <Notice kind="info">Chamadas pagas de API aguardam a validação do modo de cobrança. As assinaturas também precisam estar liberadas e conectadas antes de executar tarefas.</Notice>}
    <div className="setup-step"><span className="setup-step-number" aria-hidden="true">1</span><div><h3>{repositories.length ? "Repositório conectado" : "Conecte um repositório"}</h3><p>{repositories.length ? `${repositories.length} ${repositories.length === 1 ? "repositório disponível" : "repositórios disponíveis"} para esta empresa.` : github?.configured ? "Escolha no GitHub o código em que o agente vai trabalhar." : "A conexão com o GitHub ainda precisa ser configurada pelo responsável pela Veltram."}</p></div><button className="button secondary small" onClick={() => onNavigate("repositories")}>{repositories.length ? "Ver repositórios" : "Repositórios"}</button></div>
    <div className="setup-step"><span className="setup-step-number" aria-hidden="true">2</span><div><h3>{availableProviders.length || nativeAvailable ? "IA conectada" : "Conecte sua IA"}</h3><p>{availableProviders.length ? "O modelo e o acesso ao provedor serão verificados durante a execução." : "Conecte uma assinatura compatível ou uma chave de API da empresa."}</p></div><button className="button secondary small" onClick={() => onNavigate("credentials")}>Conexões de IA</button></div>
  </section>;
  return catalog && <CodingComposer organizationPath={organization} catalog={catalog} path={path} repositories={repositories} availableProviders={availableProviders} claude={nativeAvailable ? claude : null} onCreated={onCreated} onBusyChange={onBusyChange} onDraftChange={onDraftChange} />;
}

function CodingComposer({ organizationPath, catalog, path, repositories, availableProviders, claude, onCreated, onBusyChange, onDraftChange }: { organizationPath: string; catalog: AgentCatalogState; path: string; repositories: RepositoryConnection[]; availableProviders: CredentialProvider[]; claude: ClaudeConnectionStatus | null; onCreated: (run: VisibleCodingRun) => void; onBusyChange: (busy: boolean) => void; onDraftChange: (dirty: boolean) => void }) {
  const [repositoryId, setRepositoryId] = useState(repositories[0].id);
  const [baseRef, setBaseRef] = useState(repositories[0].defaultBranch);
  const [task, setTask] = useState("");
  const [source, setSource] = useState<CredentialProvider | "claude-code">(availableProviders[0] ?? "claude-code");
  const provider: CredentialProvider = source === "claude-code" ? "anthropic" : source;
  const sourceName = source === "claude-code" ? "Claude Code · minha conta" : `${providers[provider]} · API`;
  const [model, setModel] = useState("");
  const [setupCommand, setSetupCommand] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [agentSelections, setAgentSelections] = useState<AgentSelections | undefined>(catalog.selections ? { catalogVersion: catalog.version, ...catalog.selections } : undefined);
  const [teamReady, setTeamReady] = useState(true);
  const [jevBusy, setJevBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const draft = JSON.stringify({ repositoryId, baseRef, task, source, model, setupCommand, testCommand, agentSelections });
  const initialDraft = useRef(draft);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { onBusyChange(busy || jevBusy); return () => onBusyChange(false); }, [busy, jevBusy, onBusyChange]);
  useEffect(() => { onDraftChange(draft !== initialDraft.current); return () => onDraftChange(false); }, [draft, onDraftChange]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (jevBusy) return;
    if (!teamReady) { setError("Escolha os três agentes para esta tarefa."); return; }
    if (!task.trim() || !baseRef.trim() || !model.trim() || !testCommand.trim()) {
      setError("Descreva a tarefa e preencha a branch, o modelo e o comando de testes."); setSettingsOpen(true); return;
    }
    const fields = { repositoryConnectionId: repositoryId, baseRef: baseRef.trim(), task: task.trim(), provider, model: model.trim(), setupCommand: setupCommand.trim(), testCommand: testCommand.trim(), ...(source === "claude-code" && claude ? { modelSource: { kind: "claude-code" as const, connectionVersion: claude.connectionVersion } } : {}), ...(agentSelections ? { agentSelections } : {}) };
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
    <CodingTeamPicker catalog={catalog} organizationPath={organizationPath} task={task} disabled={busy} onBusyChange={setJevBusy} onChange={(selection, valid) => { setAgentSelections(selection); setTeamReady(valid); }} />
    <details className="execution-settings" open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}><summary>Modelo e execução <span>{model && testCommand ? `${sourceName} · ${model}` : "Configuração necessária"}</span></summary><div className="execution-settings-fields form-stack">
      <div className="form-pair"><div className="field"><label htmlFor="coding-provider">Conexão de IA</label><select id="coding-provider" value={source} disabled={busy} onChange={(event) => { setSource(event.target.value as CredentialProvider | "claude-code"); setModel(""); }}>{claude && <option value="claude-code">Claude Code · minha conta</option>}{availableProviders.map((value) => <option key={value} value={value}>{providers[value]} · API da empresa</option>)}</select></div><div className="field"><label htmlFor="coding-model">Modelo</label><input id="coding-model" required maxLength={120} autoComplete="off" disabled={busy} value={model} onChange={(event) => setModel(event.target.value)} placeholder={source === "claude-code" ? "Ex.: sonnet" : "ID do modelo na sua conta"} /></div></div>
      <p className="field-hint">{source === "claude-code" ? "A equipe usa exclusivamente sua conexão pessoal. A franquia e cobranças extras seguem seu plano; configure os limites no Claude." : "Use um modelo com suporte a ferramentas. A execução exige controle de custo compatível com o provedor e o modelo."}</p>
      <div className="field"><label htmlFor="coding-base">Branch de origem</label><input id="coding-base" required maxLength={200} autoComplete="off" disabled={busy} value={baseRef} onChange={(event) => setBaseRef(event.target.value)} /><p className="field-hint">A alteração será entregue em uma nova branch com um PR em rascunho.</p></div>
      <div className="field"><label htmlFor="coding-setup">Preparação do projeto <span className="optional-label">opcional</span></label><input id="coding-setup" maxLength={2000} autoComplete="off" spellCheck={false} disabled={busy} value={setupCommand} onChange={(event) => setSetupCommand(event.target.value)} placeholder="Ex.: npm ci" /><p className="field-hint">Comando para instalar dependências ou preparar o ambiente.</p></div>
      <div className="field"><label htmlFor="coding-test">Comando de testes</label><input id="coding-test" required maxLength={2000} autoComplete="off" spellCheck={false} disabled={busy} value={testCommand} onChange={(event) => setTestCommand(event.target.value)} placeholder="Ex.: npm test" /><p className="field-hint">Informe os testes que comprovam a tarefa. O comando será executado sobre o código final.</p></div>
    </div></details>
    <div className="coding-composer-footer"><p>Um administrador revisa e aprova o uso da conexão de IA antes da execução.</p><button className="button primary" disabled={busy || jevBusy || !task.trim() || !teamReady}>{busy ? "Criando tarefa…" : "Criar tarefa"}<Icon name="arrow" /></button></div>
  </form>;
}

function CodingDetail({ path, run, onChanged, onConflict, onBusyChange }: { path: string; run: VisibleCodingRun; onChanged: (run: VisibleCodingRun) => void; onConflict: (message: string) => void; onBusyChange: (busy: boolean) => void }) {
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { onBusyChange(busy !== null); return () => onBusyChange(false); }, [busy, onBusyChange]);
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
        setError(errorMessage(failure));
        if (failure instanceof ApiError && [403, 404, 409].includes(failure.status)) onConflict(errorMessage(failure));
      }
    } finally { if (!controller.signal.aborted) setBusy(null); }
  }

  return <article className="run-detail coding-detail" aria-label="Detalhes da tarefa">
    <div className="run-detail-heading"><h3>Tarefa no repositório</h3><Status value={run.status} /></div><p className="run-repository detail-repository">{run.repositoryName}</p><p className="run-input">{run.task}</p>
    {error && <Notice>{error}</Notice>}
    <dl className="coding-configuration"><div><dt>Origem</dt><dd className="mono">{run.baseRef}</dd></div><div><dt>Modelo</dt><dd>{run.modelSource ? "Claude Code · conta do solicitante" : providers[run.provider]} · {run.model}</dd></div><div><dt>Preparação</dt><dd className="mono">{run.setupCommand || "Nenhum comando"}</dd></div><div><dt>Testes</dt><dd className="mono">{run.testCommand}</dd></div></dl>
    {run.status === "pending_approval" && <div className="approval-request"><h4>{run.canApprove ? "Revisar e iniciar" : "Aguardando um administrador"}</h4><p>{run.modelSource ? "A aprovação usa a assinatura Claude do solicitante, com os limites e eventuais cobranças extras de seu plano." : `A aprovação usa as chaves de IA da empresa (${providerNames}), sujeitas aos controles de orçamento disponíveis.`} A equipe poderá executar os comandos acima e criar uma branch e um PR em rascunho.</p><p>Limite por tarefa: 30 minutos e até 30 chamadas de IA.</p><div className="button-row">{run.canApprove && <button className="button primary small" disabled={busy !== null} onClick={() => void act("approve")}><Icon name="check" size={16} />{busy === "approve" ? "Aprovando…" : "Aprovar e executar"}</button>}{run.canCancel && <button className="button secondary small" disabled={busy !== null} onClick={() => void act("cancel")}>{busy === "cancel" ? "Cancelando…" : "Cancelar"}</button>}</div></div>}
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
