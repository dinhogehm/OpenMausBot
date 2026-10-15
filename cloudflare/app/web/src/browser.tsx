import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentCatalogState } from "../../src/agent-catalog-types";
import type { BrowserRunInput, BrowserRunStatus } from "../../src/browser-types";
import { api, ApiError, errorMessage, formatDate, isAbort, organizationPath, type Credential, type Organization, type Workspace } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { assertBrowserScope, browserDestination, mergeBrowserRuns, needsBrowserRefresh, type VisibleBrowserRun } from "./browser-state";
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
  return <>{workspaces.length > 1 && <div className="field"><label htmlFor="browser-workspace">Espaço de trabalho</label><select id="browser-workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></div>}<BrowserTaskList key={workspaceId} organization={organization} workspaceId={workspaceId} /></>;
}
function BrowserTaskList({ organization, workspaceId }: { organization: Organization; workspaceId: string }) {
  const path = `${organizationPath(organization.id)}/workspaces/${encodeURIComponent(workspaceId)}/browser-runs`;
  const [runs, setRuns] = useState<VisibleBrowserRun[]>([]); const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [pollError, setPollError] = useState("");
  const [attempt, setAttempt] = useState(0); const [composing, setComposing] = useState(false);
  const refreshing = runs.some(needsBrowserRefresh);
  function changed(run: VisibleBrowserRun) { assertBrowserScope([run], organization.id, workspaceId); setRuns((current) => mergeBrowserRuns(current, [run])); setSelected(run.runId); }
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void api<{ runs: VisibleBrowserRun[] }>(path, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) { const scoped = assertBrowserScope(data.runs, organization.id, workspaceId); setRuns((current) => mergeBrowserRuns(current, scoped)); setSelected((value) => value || scoped[0]?.runId || ""); setPollError(""); } })
      .catch((failure) => { if (!isAbort(failure)) { setError(errorMessage(failure)); if (failure instanceof ApiError && [403, 404].includes(failure.status)) setRuns([]); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, organization.id, workspaceId, attempt]);
  useEffect(() => {
    if (!refreshing) return;
    const controller = new AbortController(); let pending = false;
    const timer = window.setInterval(() => { if (pending) return; pending = true;
      void api<{ runs: VisibleBrowserRun[] }>(path, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) { const scoped = assertBrowserScope(data.runs, organization.id, workspaceId); setRuns((current) => mergeBrowserRuns(current, scoped)); setPollError(""); } }).catch((failure) => { if (!isAbort(failure)) { if (failure instanceof ApiError && [403, 404].includes(failure.status)) { setRuns([]); setError(errorMessage(failure)); } else setPollError("Não foi possível atualizar agora. O último estado confirmado permanece visível."); } }).finally(() => { pending = false; });
    }, 2000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [path, organization.id, workspaceId, refreshing]);
  const active = runs.find((run) => run.runId === selected);
  return <div className="browser-page"><PageHeading eyebrow="TRABALHO NA NUVEM" title="Navegador">Dê um objetivo ao agente, autorize os sites e acompanhe as ações no navegador da Cloudflare.</PageHeading><div className="browser-intro"><p>Uma sessão nova para cada tarefa, com até 5 minutos e 20 ações. Os perfis do catálogo podem orientar o agente.</p><button className="button primary" onClick={() => setComposing((value) => !value)}><Icon name="plus" size={16} />{composing ? "Fechar formulário" : "Nova tarefa no navegador"}</button></div>
    {composing && <BrowserComposer organization={organization} path={path} onCreated={(run) => { changed(run); setComposing(false); }} />}
    <section className="browser-history"><div className="browser-section-heading"><div><h2>Tarefas do navegador</h2><p>Objetivo, ações registradas e última captura da sessão.</p></div><button className="text-button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}><Icon name="refresh" size={15} />Atualizar</button></div>{error && <Notice>{error}</Notice>}{pollError && <Notice kind="info">{pollError}</Notice>}{loading ? <Loading label="Carregando histórico do navegador" /> : !error && (runs.length ? <div className="browser-history-layout"><ul className="browser-run-list" aria-label="Tarefas do navegador">{runs.map((run) => <li key={run.runId}><button aria-pressed={selected === run.runId} className={selected === run.runId ? "selected" : ""} onClick={() => setSelected(run.runId)}><strong>{run.task}</strong><span>{statuses[run.status]}</span><small>{formatDate(run.createdAt)}</small></button></li>)}</ul>{active && <BrowserDetail key={active.runId} run={active} path={path} onChanged={changed} onRefresh={() => setAttempt((value) => value + 1)} />}</div> : <div className="browser-empty"><Icon name="play" size={28} /><h3>Prepare a primeira tarefa de navegação</h3><p>Informe o endereço e o resultado esperado. Um administrador confere os domínios e aprova antes de iniciar.</p><button className="button secondary" onClick={() => setComposing(true)}>Criar tarefa</button></div>)}</section>
  </div>;
}
function BrowserComposer({ organization, path, onCreated }: { organization: Organization; path: string; onCreated: (run: VisibleBrowserRun) => void }) {
  const [credentials, setCredentials] = useState<Credential[]>([]); const [catalog, setCatalog] = useState<AgentCatalogState | null>(null);
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(""); const [attempt, setAttempt] = useState(0);
  const [task, setTask] = useState(""); const [initialUrl, setInitialUrl] = useState(""); const [hosts, setHosts] = useState("");
  const [provider, setProvider] = useState<BrowserRunInput["provider"]>("openai"); const [model, setModel] = useState(""); const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [conflict, setConflict] = useState(false);
  const abort = useRef<AbortController | null>(null); const request = useRef<{ fingerprint: string; id: string } | null>(null);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setLoadError("");
    void Promise.all([api<{ credentials: Credential[] }>(`${organizationPath(organization.id)}/credentials`, { signal: controller.signal }), api<AgentCatalogState>(`${organizationPath(organization.id)}/agent-catalog`, { signal: controller.signal })]).then(([keys, profiles]) => { if (!controller.signal.aborted) { const available = keys.credentials.filter((key) => key.status === "configured"); setCredentials(available); setCatalog(profiles); setProfileId(""); setProvider((current) => available.some((key) => key.provider === current) ? current : (available.find((key) => providers.some((item) => item.id === key.provider))?.provider as BrowserRunInput["provider"]) ?? "openai"); setConflict(false); } }).catch((failure) => { if (!isAbort(failure)) setLoadError(errorMessage(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [organization.id, attempt]);
  useEffect(() => () => abort.current?.abort(), []);
  async function create(event: FormEvent) {
    event.preventDefault(); if (busy || !catalog || conflict) return;
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
  return <form className="browser-composer form-stack" onSubmit={create}><h2>Nova tarefa</h2>{loading ? <Loading label="Carregando chaves e perfis disponíveis" /> : loadError ? <><Notice>{loadError}</Notice><button className="button secondary" type="button" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></> : <>{error && <Notice>{error}</Notice>}{!configured && <Notice kind="info">Adicione uma chave da empresa em Chaves de IA para usar este provedor.</Notice>}<div className="field"><label htmlFor="browser-objective">O que o agente deve fazer?</label><textarea id="browser-objective" required maxLength={4000} rows={4} value={task} disabled={busy} onChange={(event) => setTask(event.target.value)} placeholder="Descreva o objetivo e como conferir o resultado." /></div><div className="form-pair"><div className="field"><label htmlFor="browser-url">Endereço inicial</label><input id="browser-url" type="url" required maxLength={2000} value={initialUrl} disabled={busy} onChange={(event) => setInitialUrl(event.target.value)} placeholder="https://exemplo.com" /><p className="field-hint">O domínio deste endereço é incluído na autorização.</p></div><div className="field"><label htmlFor="browser-hosts">Outros domínios autorizados</label><textarea id="browser-hosts" rows={3} maxLength={2600} value={hosts} disabled={busy} onChange={(event) => setHosts(event.target.value)} placeholder={"app.exemplo.com\ncdn.exemplo.com"} /><p className="field-hint">Um domínio exato por linha, até 10 no total. Inclua os domínios necessários para carregar o site.</p></div></div><div className="browser-model-fields"><div className="field"><label htmlFor="browser-provider">Provedor</label><select id="browser-provider" value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value as BrowserRunInput["provider"]); setModel(""); }}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}{credentials.some((key) => key.provider === item.id) ? "" : " · sem chave"}</option>)}</select></div><div className="field"><label htmlFor="browser-model">Modelo com visão</label><input id="browser-model" required maxLength={120} value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} placeholder="ID do modelo na sua conta" /></div><div className="field"><label htmlFor="browser-profile">Perfil do agente</label><select id="browser-profile" value={profileId} disabled={busy} onChange={(event) => setProfileId(event.target.value)}><option value="">Padrão de navegação</option>{catalog?.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div></div><p className="field-hint">A sessão é criada na nuvem, sem importar cookies ou sessões do seu computador. A tarefa fica aguardando aprovação.</p>{conflict ? <button type="button" className="button secondary" onClick={() => { request.current = null; setAttempt((value) => value + 1); }}>Atualizar perfis e conferir seleção</button> : <div><button className="button primary" disabled={busy || !configured || !task.trim() || !model.trim() || !initialUrl.trim()}>{busy ? "Criando…" : "Criar para aprovação"}</button></div>}</>}</form>;
}
function BrowserDetail({ run, path, onChanged, onRefresh }: { run: VisibleBrowserRun; path: string; onChanged: (run: VisibleBrowserRun) => void; onRefresh: () => void }) {
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null); const [error, setError] = useState(""); const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function act(action: "approve" | "cancel") {
    if (busy) return; const controller = new AbortController(); abort.current = controller; setBusy(action); setError("");
    try { const data = await api<{ run: VisibleBrowserRun }>(`${path}/${encodeURIComponent(run.runId)}/${action}`, { method: "POST", body: { generation: run.generation }, signal: controller.signal }); if (!controller.signal.aborted) onChanged(data.run); }
    catch (failure) { if (!isAbort(failure)) { setError(errorMessage(failure)); if (failure instanceof ApiError && [403, 404, 409].includes(failure.status)) onRefresh(); } }
    finally { if (!controller.signal.aborted) setBusy(null); }
  }
  return <article className="browser-detail" aria-label="Detalhes da tarefa de navegação"><div className="browser-detail-heading"><h3>{run.task}</h3><span className={`browser-status ${run.status}`}>{statuses[run.status]}</span></div>{error && <Notice>{error}</Notice>}<dl className="browser-metadata"><div><dt>Endereço inicial</dt><dd>{run.initialUrl}</dd></div><div><dt>Sites autorizados</dt><dd>{run.allowedHosts.join(", ")}</dd></div><div><dt>Agente e modelo</dt><dd>{run.agentSnapshot?.name ?? "Padrão de navegação"} · {run.provider} / {run.model}</dd></div></dl>{run.status === "pending_approval" && <div className="browser-approval"><h4>{run.canApprove ? "Confira o objetivo e os sites antes de aprovar" : "Aguardando aprovação de um administrador"}</h4><p>O agente poderá navegar, clicar e preencher campos nos sites autorizados para cumprir este objetivo. Limite: 5 minutos e 20 ações.</p><p>A execução usa a chave de IA da empresa e pode gerar cobrança pelo provedor de IA e pelo navegador na nuvem.</p></div>}<div className="button-row">{run.canApprove && <button className="button primary small" disabled={busy !== null} onClick={() => void act("approve")}>{busy === "approve" ? "Aprovando…" : "Aprovar e iniciar"}</button>}{run.canCancel && <button className="button secondary small" disabled={busy !== null} onClick={() => void act("cancel")}><Icon name="stop" size={14} />{busy === "cancel" ? "Cancelando…" : "Cancelar tarefa"}</button>}</div>{run.error && <Notice>{errorMessage(new ApiError(500, run.error))}</Notice>}{run.summary && <section className="browser-result"><h4>Resultado registrado</h4><p>{run.summary}</p></section>}<BrowserScreenshot run={run} path={path} /><div className="browser-evidence"><dl><div><dt>Ações</dt><dd>{run.steps} / 20</dd></div><div><dt>Chamadas de IA</dt><dd>{run.modelCalls}</dd></div><div><dt>Tokens registrados</dt><dd>{run.tokens.toLocaleString("pt-BR")}</dd></div><div><dt>Sessão</dt><dd>{run.status === "pending_approval" ? "Não iniciada" : run.status === "queued" ? "Aguardando sessão" : run.cleanupStatus === "closed" ? "Encerrada" : run.cleanupStatus === "idle_expiry" ? "Encerramento por inatividade" : run.status === "running" ? "Em uso" : "Encerramento pendente"}</dd></div></dl></div><section className="browser-events"><h4>Registro de ações</h4>{!run.events.length ? <p className="field-hint">As ações aparecerão quando a execução começar.</p> : <ol>{run.events.map((event) => <li key={event.id}><time dateTime={new Date(event.at).toISOString()}>{formatDate(event.at)}</time><p>{event.text}</p></li>)}</ol>}</section><p className="field-hint">Criada em {formatDate(run.createdAt)} · Atualizada em {formatDate(run.updatedAt)}</p></article>;
}
function BrowserScreenshot({ run, path }: { run: VisibleBrowserRun; path: string }) {
  const [capture, setCapture] = useState<{ url: string; at: number } | null>(null); const [error, setError] = useState(""); const [attempt, setAttempt] = useState(0);
  const currentUrl = useRef<string | null>(null);
  useEffect(() => () => { if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); }, []);
  useEffect(() => {
    if (!run.screenshotAt) return;
    const controller = new AbortController(); const at = run.screenshotAt; setError("");
    void fetch(`${path}/${encodeURIComponent(run.runId)}/screenshot`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal }).then(async (response) => {
      if (response.status === 401) window.dispatchEvent(new Event("veltram:session-expired"));
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/jpeg")) throw new Error("screenshot_unavailable");
      const blob = await response.blob(); controller.signal.throwIfAborted(); const url = URL.createObjectURL(blob); if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); currentUrl.current = url; setCapture({ url, at });
    }).catch((failure) => { if (!isAbort(failure)) setError("Não foi possível carregar a última captura."); });
    return () => controller.abort();
  }, [path, run.runId, run.screenshotAt, attempt]);
  return <figure className="browser-capture"><figcaption><h4>Última captura</h4>{capture && <span>{formatDate(capture.at)}</span>}</figcaption>{error && <div className="browser-capture-error"><p>{error}</p><button className="text-button" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></div>}{capture ? <img src={capture.url} alt={`Captura do navegador da tarefa: ${run.task}`} /> : <div className="browser-capture-placeholder">{run.screenshotAt ? "Carregando captura…" : "A primeira captura aparecerá durante a execução."}</div>}</figure>;
}
