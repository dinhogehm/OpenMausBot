import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentCatalogState } from "../../src/agent-catalog-types";
import type { BudgetView } from "../../src/budget-types";
import type { BrowserRunInput, BrowserRunStatus } from "../../src/browser-types";
import { api, ApiError, errorMessage, formatDate, isAbort, organizationPath, type Credential, type Organization, type Workspace } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { assertBrowserScope, browserCanStart, browserCaptureMessage, browserSessionLabel, browserDestination, mergeBrowserRuns, needsBrowserRefresh, type VisibleBrowserRun } from "./browser-state";
import { canLeavePage, useNavigationGuard } from "./navigation-guard";
import "./browser.css";

const statuses: Record<BrowserRunStatus, string> = { pending_approval: "A aprovar", queued: "Na fila", running: "Em execução", completed: "Concluída", failed: "Falhou", canceled: "Cancelada", interrupted: "Interrompida" };
const providers = [{ id: "openai", label: "OpenAI" }, { id: "anthropic", label: "Anthropic" }, { id: "openrouter", label: "OpenRouter" }] as const;
export function BrowserTasks({ organization }: { organization: Organization }) { return <BrowserWorkspace key={organization.id} organization={organization} />; }
function BrowserWorkspace({ organization }: { organization: Organization }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]); const [workspaceId, setWorkspaceId] = useState("");
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [attempt, setAttempt] = useState(0);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError("");
    void api<{ workspaces: Workspace[] }>(`${organizationPath(organization.id)}/workspaces`, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) { setWorkspaces(data.workspaces); setWorkspaceId(data.workspaces[0]?.id ?? ""); } }).catch((failure) => { if (!isAbort(failure)) setError(errorMessage(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [organization.id, attempt]);
  if (loading) return <Loading label="Carregando tarefas do navegador" />;
  if (error) return <><Notice>{error}</Notice><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></>;
  if (!workspaceId) return <Notice kind="info">Crie um espaço de trabalho para usar o navegador na nuvem.</Notice>;
  return <>{workspaces.length > 1 && <div className="field"><label htmlFor="browser-workspace">Espaço de trabalho</label><select id="browser-workspace" value={workspaceId} onChange={async (event) => { const next = event.target.value; if (await canLeavePage()) setWorkspaceId(next); }}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></div>}<BrowserTaskList key={workspaceId} organization={organization} workspaceId={workspaceId} /></>;
}
function BrowserTaskList({ organization, workspaceId }: { organization: Organization; workspaceId: string }) {
  const path = `${organizationPath(organization.id)}/workspaces/${encodeURIComponent(workspaceId)}/browser-runs`;
  const [runs, setRuns] = useState<VisibleBrowserRun[]>([]); const [selected, setSelected] = useState("");
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [pollError, setPollError] = useState("");
  const [attempt, setAttempt] = useState(0); const [composing, setComposing] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false); const [detailBusy, setDetailBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const createButton = useRef<HTMLButtonElement | null>(null);
  const detail = useRef<HTMLDivElement | null>(null);
  const focusDetail = useRef(false);
  const active = runs.find((run) => run.runId === selected);
  function changed(run: VisibleBrowserRun) {
    assertBrowserScope([run], organization.id, workspaceId);
    setRuns((current) => mergeBrowserRuns(current, [run])); setSelected(run.runId);
    setAnnouncement(`Tarefa: ${statuses[run.status]}.`);
  }
  function openComposer() { if (!detailBusy) { setComposing(true); setAnnouncement(""); } }
  async function closeComposer() {
    if (!await canLeavePage()) return;
    setComposing(false); requestAnimationFrame(() => createButton.current?.focus());
  }
  useEffect(() => {
    if (focusDetail.current) { focusDetail.current = false; detail.current?.focus(); }
  }, [selected, composing]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void Promise.all([api<{ runs: VisibleBrowserRun[] }>(path, { signal: controller.signal }), api<BudgetView>(`${organizationPath(organization.id)}/budget`, { signal: controller.signal })]).then(([data, budgetView]) => {
      if (!controller.signal.aborted) {
        setBudget(budgetView);
        const scoped = assertBrowserScope(data.runs, organization.id, workspaceId);
        setRuns((current) => mergeBrowserRuns(current, scoped)); setSelected((value) => value || scoped[0]?.runId || ""); setPollError("");
      }
    }).catch((failure) => { if (!isAbort(failure)) { setError(errorMessage(failure)); if (failure instanceof ApiError && [403, 404].includes(failure.status)) setRuns([]); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, organization.id, workspaceId, attempt]);
  const refreshDelay = runs.some(needsBrowserRefresh) ? 2000 : 15000;
  useEffect(() => {
    if (error) return;
    const controller = new AbortController(); let pending = false;
    const refresh = () => {
      if (pending || document.visibilityState === "hidden") return; pending = true;
      void api<{ runs: VisibleBrowserRun[] }>(path, { signal: controller.signal }).then((data) => {
        if (!controller.signal.aborted) {
          const scoped = assertBrowserScope(data.runs, organization.id, workspaceId);
          setRuns((current) => mergeBrowserRuns(current, scoped)); setSelected((value) => value || scoped[0]?.runId || ""); setPollError("");
        }
      }).catch((failure) => {
        if (!isAbort(failure)) {
          if (failure instanceof ApiError && [403, 404].includes(failure.status)) { setRuns([]); setError(errorMessage(failure)); }
          else setPollError("A atualização foi interrompida. Os dados abaixo são os últimos confirmados; uma nova tentativa será feita automaticamente.");
        }
      }).finally(() => { pending = false; });
    };
    const timer = window.setInterval(refresh, refreshDelay); document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [path, organization.id, workspaceId, refreshDelay, error]);
  return <div className="browser-page">
    <PageHeading eyebrow="TRABALHO NA NUVEM" title="Navegador">Defina um objetivo e os sites que o agente pode acessar. Confira a execução pelas ações registradas e capturas.</PageHeading>
    <div className="browser-intro"><div><p>Uma sessão isolada na Cloudflare para cada tarefa.</p><ul className="browser-limits" aria-label="Limites de execução"><li>Até 5 minutos</li><li>Até 20 ações</li><li>Aprovação antes de iniciar</li></ul></div>
      <button ref={createButton} className="button primary" disabled={composing || detailBusy} onClick={openComposer}><Icon name="plus" size={16} />Nova tarefa</button></div>
    {budget?.enforcement?.required && <Notice kind="info"><strong>Navegação autônoma pausada.</strong> O Veltram ainda precisa validar o controle de cobrança para modelos com visão. As tarefas e evidências existentes continuam disponíveis.</Notice>}
    <p className="sr-only" role="status">{announcement}</p>
    {composing && <BrowserComposer organization={organization} path={path} blocked={detailBusy} onBusyChange={setComposerBusy} onClose={closeComposer} onCreated={(run) => { focusDetail.current = true; changed(run); setComposing(false); setComposerBusy(false); }} />}
    <section className="browser-history" aria-labelledby="browser-history-title">
      <div className="browser-section-heading"><div><h2 id="browser-history-title">Tarefas do navegador</h2><p>Selecione uma tarefa para conferir o estado e as evidências.</p></div><button className="text-button" disabled={loading || detailBusy || composerBusy} onClick={() => setAttempt((value) => value + 1)}><Icon name="refresh" size={16} />{loading ? "Atualizando…" : "Atualizar"}</button></div>
      {error && <Notice>{error}</Notice>}{pollError && <Notice kind="info">{pollError}</Notice>}
      {loading && !runs.length ? <Loading label="Carregando histórico do navegador" /> : !error && (runs.length ? <div className="browser-history-layout">
        <div className="browser-history-index"><p className="browser-count">{runs.length} {runs.length === 1 ? "tarefa neste espaço" : "tarefas neste espaço"}</p>
          <ul className="browser-run-list" aria-label="Tarefas do navegador">{runs.map((run) => <li key={run.runId}><button aria-pressed={selected === run.runId} disabled={detailBusy || composerBusy} className={selected === run.runId ? "selected" : ""} onClick={() => { focusDetail.current = true; setSelected(run.runId); if (selected === run.runId) detail.current?.focus(); }}><strong>{run.task}</strong><span className={`browser-list-status ${run.status}`}>{statuses[run.status]}</span><small>{formatDate(run.createdAt)}</small></button></li>)}</ul>
          <p className="browser-history-limit">Esta versão armazena até 50 tarefas por empresa.</p>
        </div>
        {active && <div ref={detail} tabIndex={-1} className="browser-detail-focus" aria-label="Tarefa selecionada"><BrowserDetail key={active.runId} run={active} path={path} blocked={composerBusy} executionAvailable={browserCanStart(budget)} onBusyChange={setDetailBusy} onChanged={changed} onRefresh={() => setAttempt((value) => value + 1)} /></div>}
      </div> : <div className="browser-empty"><Icon name="browser" size={30} /><h3>Comece com uma tarefa de navegação</h3><p>Informe o endereço e o resultado esperado. Um administrador confere os domínios e aprova a tarefa antes de iniciar.</p><button className="button secondary" disabled={composing} onClick={openComposer}>Criar primeira tarefa</button></div>)}
    </section>
  </div>;
}
function BrowserComposer({ organization, path, onCreated, onClose, onBusyChange, blocked }: { organization: Organization; path: string; blocked: boolean; onCreated: (run: VisibleBrowserRun) => void; onClose: () => void; onBusyChange: (busy: boolean) => void }) {
  const [credentials, setCredentials] = useState<Credential[]>([]); const [catalog, setCatalog] = useState<AgentCatalogState | null>(null);
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const objective = useRef<HTMLTextAreaElement | null>(null);
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(""); const [attempt, setAttempt] = useState(0);
  const [task, setTask] = useState(""); const [initialUrl, setInitialUrl] = useState(""); const [hosts, setHosts] = useState("");
  const [provider, setProvider] = useState<BrowserRunInput["provider"]>("openai"); const [model, setModel] = useState(""); const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [conflict, setConflict] = useState(false);
  const abort = useRef<AbortController | null>(null); const request = useRef<{ fingerprint: string; id: string } | null>(null);
  useNavigationGuard({ dirty: Boolean(task || initialUrl || hosts || model || profileId), busy });
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => { if (!loading && !loadError) objective.current?.focus(); }, [loading, loadError]);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setLoadError("");
    void Promise.all([api<{ credentials: Credential[] }>(`${organizationPath(organization.id)}/credentials`, { signal: controller.signal }), api<AgentCatalogState>(`${organizationPath(organization.id)}/agent-catalog`, { signal: controller.signal }), api<BudgetView>(`${organizationPath(organization.id)}/budget`, { signal: controller.signal })]).then(([keys, profiles, budgetView]) => { if (!controller.signal.aborted) { const available = keys.credentials.filter((key) => key.status === "configured"); setCredentials(available); setCatalog(profiles); setBudget(budgetView); setProfileId(""); setProvider((current) => available.some((key) => key.provider === current) ? current : (available.find((key) => providers.some((item) => item.id === key.provider))?.provider as BrowserRunInput["provider"]) ?? "openai"); setConflict(false); } }).catch((failure) => { if (!isAbort(failure)) setLoadError(errorMessage(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [organization.id, attempt]);
  useEffect(() => () => abort.current?.abort(), []);
  async function create(event: FormEvent) {
    event.preventDefault(); if (busy || blocked || !catalog || conflict || !browserCanStart(budget)) return;
    let destination: ReturnType<typeof browserDestination>;
    try { destination = browserDestination(initialUrl.trim(), hosts); } catch (failure) { setError(failure instanceof Error ? failure.message : "Confira os sites autorizados."); return; }
    const input = { task: task.trim(), ...destination, provider, model: model.trim(), ...(profileId ? { agent: { catalogVersion: catalog.version, profileId } } : {}) };
    const fingerprint = JSON.stringify(input); if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError("");
    try { const data = await api<{ run: VisibleBrowserRun }>(path, { method: "POST", body: { ...input, requestId: request.current.id }, signal: controller.signal }); if (!controller.signal.aborted) onCreated(data.run); }
    catch (failure) { if (!isAbort(failure)) { setError(errorMessage(failure)); if (failure instanceof ApiError && failure.status === 409) setConflict(true); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  const configured = credentials.some((key) => key.provider === provider);
  let destination: ReturnType<typeof browserDestination> | null = null;
  try { if (initialUrl.trim()) destination = browserDestination(initialUrl.trim(), hosts); } catch { /* Validation is announced on submit, not while typing. */ }
  return <form className="browser-composer form-stack" onSubmit={create} aria-labelledby="browser-composer-title"><div className="browser-composer-heading"><div><h2 id="browser-composer-title">Preparar navegação</h2><p className="field-hint">Defina o objetivo, o alcance e o modelo.</p></div><button type="button" className="button secondary" disabled={busy || blocked} onClick={onClose}>Fechar</button></div>{loading ? <Loading label="Carregando chaves e perfis disponíveis" /> : loadError ? <><Notice>{loadError}</Notice><button className="button secondary" type="button" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></> : <>{error && <Notice>{error}</Notice>}{budget?.enforcement?.required && <Notice kind="info"><strong>Execução no navegador pausada.</strong> O controle de cobrança para modelos com visão ainda precisa ser validado pelo Veltram. Chaves e limites salvos não liberam essa execução. Você pode preparar o objetivo, mas a criação permanece indisponível.</Notice>}{!configured && <Notice kind="info">Adicione uma chave da empresa em Conexões para usar este provedor.</Notice>}<div className="field"><label htmlFor="browser-objective">O que o agente deve fazer?</label><textarea ref={objective} id="browser-objective" required maxLength={4000} rows={4} value={task} disabled={busy || blocked} onChange={(event) => setTask(event.target.value)} placeholder="Descreva o objetivo e como conferir o resultado." /></div><div className="form-pair"><div className="field"><label htmlFor="browser-url">Endereço inicial</label><input id="browser-url" aria-describedby="browser-url-help" type="url" required maxLength={2000} value={initialUrl} disabled={busy || blocked} onChange={(event) => setInitialUrl(event.target.value)} placeholder="https://exemplo.com" /><p className="field-hint" id="browser-url-help">Somente HTTPS público. O domínio deste endereço é incluído na autorização.</p></div><div className="field"><label htmlFor="browser-hosts">Outros domínios autorizados</label><textarea id="browser-hosts" aria-describedby="browser-hosts-help" rows={3} maxLength={2600} value={hosts} disabled={busy || blocked} onChange={(event) => setHosts(event.target.value)} placeholder={"app.exemplo.com\ncdn.exemplo.com"} /><p className="field-hint" id="browser-hosts-help">Um domínio exato por linha, até 10 no total. Subdomínios precisam ser incluídos separadamente. Não use curingas.</p></div></div><div className="browser-model-fields"><div className="field"><label htmlFor="browser-provider">Provedor</label><select id="browser-provider" value={provider} disabled={busy || blocked} onChange={(event) => { setProvider(event.target.value as BrowserRunInput["provider"]); setModel(""); }}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}{credentials.some((key) => key.provider === item.id) ? "" : " · sem chave"}</option>)}</select></div><div className="field"><label htmlFor="browser-model">Modelo com visão</label><input id="browser-model" required maxLength={120} value={model} disabled={busy || blocked} onChange={(event) => setModel(event.target.value)} placeholder="ID do modelo na sua conta" /></div><div className="field"><label htmlFor="browser-profile">Perfil do agente</label><select id="browser-profile" value={profileId} disabled={busy || blocked} onChange={(event) => setProfileId(event.target.value)}><option value="">Padrão de navegação</option>{catalog?.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div></div>{destination && <div className="browser-domain-preview"><h3>Domínios para aprovação</h3><ul>{destination.allowedHosts.map((host) => <li key={host}>{host}</li>)}</ul></div>}<p className="field-hint">A sessão não importa cookies ou logins do seu computador. Criar a tarefa não inicia a navegação: um administrador precisa aprová-la.</p>{conflict ? <button type="button" className="button secondary" onClick={() => { request.current = null; setAttempt((value) => value + 1); }}>Atualizar perfis e conferir seleção</button> : <div><button className="button primary" disabled={busy || blocked || !configured || !browserCanStart(budget) || !task.trim() || !model.trim() || !initialUrl.trim()}>{busy ? "Criando…" : "Criar para aprovação"}</button></div>}</>}</form>;
}
export function BrowserDetail({ run, path, onChanged, onRefresh, onBusyChange, executionAvailable, blocked }: { run: VisibleBrowserRun; path: string; blocked: boolean; executionAvailable: boolean; onChanged: (run: VisibleBrowserRun) => void; onRefresh: () => void; onBusyChange: (busy: boolean) => void }) {
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null); const [error, setError] = useState(""); const abort = useRef<AbortController | null>(null);
  const [canceling, setCanceling] = useState(false);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  const keepButton = useRef<HTMLButtonElement | null>(null);
  const actionConfirmed = useRef(false);
  useNavigationGuard({ busy: busy !== null });
  useEffect(() => { onBusyChange(busy !== null); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => { if (canceling) keepButton.current?.focus(); }, [canceling]);
  useEffect(() => { if (actionConfirmed.current) { actionConfirmed.current = false; heading.current?.focus(); } if (!run.canCancel && canceling) { setCanceling(false); heading.current?.focus(); } }, [run.status, run.canCancel]);
  useEffect(() => () => abort.current?.abort(), []);
  async function act(action: "approve" | "cancel") {
    if (busy || blocked || (action === "approve" && !executionAvailable)) return; const controller = new AbortController(); abort.current = controller; setBusy(action); setError("");
    try { const data = await api<{ run: VisibleBrowserRun }>(`${path}/${encodeURIComponent(run.runId)}/${action}`, { method: "POST", body: { generation: run.generation }, signal: controller.signal }); if (!controller.signal.aborted) { actionConfirmed.current = true; setCanceling(false); onChanged(data.run); } }
    catch (failure) { if (!isAbort(failure)) { setError(errorMessage(failure)); if (failure instanceof ApiError && [403, 404, 409].includes(failure.status)) onRefresh(); } }
    finally { if (!controller.signal.aborted) setBusy(null); }
  }
  return <article className="browser-detail" aria-label="Detalhes da tarefa de navegação"><div className="browser-detail-heading"><h3 ref={heading} tabIndex={-1}>{run.task}</h3><span className={`browser-status ${run.status}`}>{statuses[run.status]}</span></div>{error && <Notice>{error}</Notice>}<dl className="browser-metadata"><div><dt>Endereço inicial</dt><dd>{run.initialUrl}</dd></div><div><dt>Sites autorizados</dt><dd><ul className="browser-host-list">{run.allowedHosts.map((host) => <li key={host}>{host}</li>)}</ul></dd></div><div><dt>Agente e modelo</dt><dd>{run.agentSnapshot?.name ?? "Padrão de navegação"} · {run.provider} / {run.model}</dd></div></dl>{run.status === "pending_approval" && <div className="browser-approval"><h4>{run.canApprove ? "Confira o objetivo e os sites antes de aprovar" : "Aguardando aprovação de um administrador"}</h4><p>O agente poderá navegar, clicar e preencher campos nos sites autorizados para cumprir este objetivo. Limite: 5 minutos e 20 ações.</p><p>A execução usa a chave de IA da empresa e pode gerar cobrança pelo provedor de IA e pelo navegador na nuvem.</p>{!executionAvailable && <p><strong>A aprovação permanece indisponível enquanto o controle de cobrança para visão não for validado.</strong></p>}</div>}<div className="button-row">{run.canApprove && !canceling && <button className="button primary small" disabled={blocked || busy !== null || !executionAvailable} onClick={() => void act("approve")}>{busy === "approve" ? "Aprovando…" : "Aprovar e iniciar"}</button>}{run.canCancel && !canceling && <button ref={cancelButton} className="button secondary small" disabled={blocked || busy !== null} onClick={() => setCanceling(true)}><Icon name="stop" size={16} />Cancelar tarefa</button>}</div>{canceling && <section className="browser-cancel-confirmation" aria-labelledby="browser-cancel-title"><h4 id="browser-cancel-title">Cancelar esta tarefa?</h4><p>O cancelamento interrompe novas ações. Ações já realizadas nos sites não são desfeitas.</p><div className="button-row"><button ref={keepButton} className="button secondary" disabled={blocked || busy !== null} onClick={() => { setCanceling(false); requestAnimationFrame(() => cancelButton.current?.focus()); }}>Manter tarefa</button><button className="button danger" disabled={blocked || busy !== null} onClick={() => void act("cancel")}>{busy === "cancel" ? "Cancelando…" : "Confirmar cancelamento"}</button></div></section>}{run.error && <Notice>{errorMessage(new ApiError(500, run.error))}</Notice>}{run.summary && <section className="browser-result"><h4>Resumo do agente</h4><p>{run.summary}</p><p className="field-hint">Confira o registro de ações e a captura para verificar o resultado informado.</p></section>}<BrowserScreenshot run={run} path={path} /><div className="browser-evidence"><dl><div><dt>Ações</dt><dd>{run.steps} / 20</dd></div><div><dt>Chamadas de IA</dt><dd>{run.modelCalls}</dd></div><div><dt>Tokens registrados</dt><dd>{run.tokens.toLocaleString("pt-BR")}</dd></div><div><dt>Sessão</dt><dd>{browserSessionLabel(run)}</dd></div></dl></div><section className="browser-events"><h4>Registro de ações</h4>{!run.events.length ? <p className="field-hint">{["pending_approval", "queued", "running"].includes(run.status) ? "As ações aparecerão quando forem registradas pela execução." : "Nenhuma ação foi registrada nesta tarefa."}</p> : <ol>{run.events.map((event) => <li key={event.id}><time dateTime={new Date(event.at).toISOString()}>{formatDate(event.at)}</time><p>{event.text}</p></li>)}</ol>}</section><p className="field-hint">Criada em {formatDate(run.createdAt)} · Atualizada em {formatDate(run.updatedAt)}</p></article>;
}
function BrowserScreenshot({ run, path }: { run: VisibleBrowserRun; path: string }) {
  const [capture, setCapture] = useState<{ url: string; at: number } | null>(null);
  const [error, setError] = useState(""); const [attempt, setAttempt] = useState(0); const [loading, setLoading] = useState(false);
  const currentUrl = useRef<string | null>(null);
  const captureHeading = useRef<HTMLHeadingElement | null>(null);
  const retryButton = useRef<HTMLButtonElement | null>(null);
  const restoreRetryFocus = useRef(false);
  useEffect(() => {
    if (loading || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    if (document.activeElement === document.body || document.activeElement === retryButton.current) {
      (error ? retryButton.current : captureHeading.current)?.focus();
    }
  }, [loading, error, capture]);
  useEffect(() => () => { if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); }, []);
  useEffect(() => {
    if (!run.screenshotAt) {
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
      currentUrl.current = null; setCapture(null); setLoading(false); setError(""); return;
    }
    const controller = new AbortController(); const at = run.screenshotAt; setError(""); setLoading(true);
    void fetch(`${path}/${encodeURIComponent(run.runId)}/screenshot`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal }).then(async (response) => {
      if (response.status === 401) window.dispatchEvent(new Event("veltram:session-expired"));
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/jpeg")) throw new Error("screenshot_unavailable");
      const blob = await response.blob(); controller.signal.throwIfAborted(); const url = URL.createObjectURL(blob);
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
      currentUrl.current = url; setCapture({ url, at });
    }).catch((failure) => { if (!isAbort(failure)) setError("Não foi possível carregar a última captura."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, run.runId, run.screenshotAt, attempt]);
  return <figure className="browser-capture">
    <figcaption><div><h4 ref={captureHeading} tabIndex={-1}>Última captura</h4>{capture && <span>{formatDate(capture.at)}</span>}</div>{capture && <a className="text-button" href={capture.url} target="_blank" rel="noopener noreferrer">Abrir imagem<span className="sr-only"> em nova aba</span><Icon name="arrow" size={16} /></a>}</figcaption>
    {error && <div className="browser-capture-error" role="alert"><p>{error}{capture && " A captura anterior permanece visível."}</p><button ref={retryButton} className="text-button" disabled={loading} onClick={(event) => { restoreRetryFocus.current = document.activeElement === event.currentTarget; setAttempt((value) => value + 1); }}>Tentar novamente</button></div>}
    {loading && capture && <p className="browser-capture-updating" role="status">Atualizando captura…</p>}
    {capture ? <img src={capture.url} alt={`Captura do navegador da tarefa: ${run.task}`} onError={() => { setError("A imagem recebida não pôde ser exibida."); setCapture(null); }} /> : !error && <div className="browser-capture-placeholder" role="status">{loading || run.screenshotAt ? "Carregando captura…" : browserCaptureMessage(run)}</div>}
  </figure>;
}
