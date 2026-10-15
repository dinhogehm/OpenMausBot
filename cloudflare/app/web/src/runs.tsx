import { useEffect, useRef, useState, type FormEvent } from "react";
import type { RunStatus } from "../../src/execution";
import { api, ApiError, errorMessage, formatDate, isAbort, organizationPath } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { mergeRuns, validateRunScope, type VisibleRun as RunRecord } from "./run-state";
import { useNavigationGuard } from "./navigation-guard";
import "./company-execution.css";

const statusNames: Record<RunStatus, string> = {
  waiting_approval: "Aguardando aprovação", running: "Em execução", succeeded: "Concluído", failed: "Falhou", cancelled: "Cancelado", interrupted: "Interrompido",
};
function Status({ value }: { value: RunStatus }) {
  return <span className={`status-pill ${value}`}><span />{statusNames[value]}</span>;
}

export function Runs({ organizationId, workspaceId }: { organizationId: string; workspaceId: string }) {
  const path = `${organizationPath(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/runs`;
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [actionError, setActionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState(false);
  const [focusCreated, setFocusCreated] = useState(false);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const hasPending = runs.some((run) => run.status === "running" || run.status === "waiting_approval");
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const busy = creating || acting;
  const validateScope = (records: RunRecord[]) => validateRunScope(records, organizationId, workspaceId);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setPollError("");
    void api<{ runs: RunRecord[] }>(path, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        const scoped = validateScope(data.runs);
        setRuns((current) => mergeRuns(current, scoped));
        setSelectedId((current) => current || scoped[0]?.id || "");
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
    if (!hasPending || error || loading || busy) return;
    const controller = new AbortController();
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void api<{ runs: RunRecord[] }>(path, { signal: controller.signal })
        .then((data) => { if (!controller.signal.aborted) { const scoped = validateScope(data.runs); setRuns((current) => mergeRuns(current, scoped)); setPollError(""); } })
        .catch((failure: unknown) => {
          if (!isAbort(failure)) {
            if (failure instanceof ApiError && [403, 404].includes(failure.status)) { setRuns([]); setError(errorMessage(failure)); }
            else setPollError("Não foi possível atualizar automaticamente. O último estado conhecido continua abaixo; use Atualizar para consultar novamente.");
          }
        })
        .finally(() => { pending = false; });
    }, 2000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [path, hasPending, error, loading, busy]);

  function changed(run: RunRecord) {
    validateScope([run]); setActionError("");
    setRuns((current) => mergeRuns(current, [run])); setSelectedId(run.id);
  }
  function refresh() { historyHeading.current?.focus(); setAttempt((value) => value + 1); }

  return <div className="execution-page">
    <PageHeading eyebrow="VERIFICAÇÃO DO AMBIENTE" title="Teste de execução">Confira se o ambiente recebe uma solicitação, aguarda aprovação e registra um resultado.</PageHeading>
    <div className="proof-note"><Icon name="play" size={18} /><p>Este teste reproduz sua mensagem e gera um arquivo de resultado. Não usa IA, não altera repositórios e não substitui uma tarefa de desenvolvimento.</p></div>
    <RunComposer path={path} locked={acting || loading || Boolean(error)} onBusy={setCreating} onCreated={(run) => { changed(run); setFocusCreated(true); }} />
    <section className="run-history" aria-labelledby="history-title">
      <div className="section-heading"><div><h2 id="history-title" ref={historyHeading} tabIndex={-1}>Histórico de testes</h2><p>{runs.length > 0 ? `${runs.length} ${runs.length === 1 ? "teste registrado neste espaço" : "testes registrados neste espaço"}.` : "O estado e o resultado de cada execução."}</p></div><button className="text-button" disabled={loading || busy} onClick={refresh}><Icon name="refresh" size={16} />{loading ? "Atualizando…" : "Atualizar"}</button></div>
      {error && <div className="execution-retry"><Notice>{runs.length > 0 ? `Não foi possível atualizar o histórico. ${error}` : error}</Notice><button className="button secondary" disabled={loading || busy} onClick={refresh}>Tentar novamente</button></div>}
      {actionError && <Notice>{actionError}</Notice>}{pollError && <Notice kind="info">{pollError}</Notice>}
      {loading && runs.length === 0 ? <Loading label="Carregando testes" /> : !error && runs.length === 0 ? <div className="empty-state"><div className="empty-symbol"><Icon name="play" size={24} /></div><h3>Nenhum teste registrado neste espaço.</h3><p>Escreva uma mensagem e crie o primeiro teste. Um administrador precisa aprová-lo antes da execução.</p><button className="button secondary" onClick={() => document.getElementById("test-message")?.focus()}>Escrever mensagem</button></div> : runs.length > 0 && <>
        <div className="execution-mobile-picker field"><label htmlFor="selected-test">Teste selecionado</label><select id="selected-test" value={selected?.id ?? ""} disabled={busy} onChange={(event) => setSelectedId(event.target.value)}>{runs.map((run) => <option key={run.id} value={run.id}>{statusNames[run.status]} · {run.input.message}</option>)}</select></div>
        <div className="run-history-layout"><div className="run-list" aria-label="Selecionar teste">{runs.map((run) => <button className={`run-row${run.id === selected?.id ? " selected" : ""}`} key={run.id} onClick={() => setSelectedId(run.id)} disabled={busy} aria-pressed={run.id === selected?.id}><span className="run-title">{run.input.message}</span><Status value={run.status} /><time dateTime={new Date(run.createdAt).toISOString()}>{formatDate(run.createdAt)}</time></button>)}</div>{selected && <RunDetail key={selected.id} path={path} run={selected} locked={creating || Boolean(error) || loading} onBusy={setActing} focusOnMount={focusCreated} onFocused={() => setFocusCreated(false)} onChanged={changed} onConflict={(message) => { setActionError(message); setAttempt((value) => value + 1); }} />}</div>
      </>}
      <p className="execution-limit">O ambiente mantém até 100 testes por empresa, somando todos os espaços. Os registros permanecem no histórico.</p>
    </section>
  </div>;
}

function RunComposer({ path, onCreated, onBusy, locked }: { path: string; onCreated: (run: RunRecord) => void; onBusy: (busy: boolean) => void; locked: boolean }) {
  const [message, setMessage] = useState("");
  const [delay, setDelay] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const pending = useRef(false);
  useNavigationGuard({ dirty: Boolean(message.trim()) || delay !== "0", busy });
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (error && !busy) errorRef.current?.focus(); }, [error, busy]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (pending.current || locked || !message.trim()) return;
    pending.current = true;
    const controller = new AbortController(); abort.current = controller;
    const input = { message: message.trim(), delayMs: Number(delay) * 1000 };
    const fingerprint = JSON.stringify(input);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true); onBusy(true); setError("");
    try {
      const data = await api<{ run: RunRecord }>(path, { method: "POST", body: { ...input, requestId: request.current.id }, signal: controller.signal });
      if (!controller.signal.aborted) { onCreated(data.run); setMessage(""); setDelay("0"); request.current = null; }
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { pending.current = false; if (!controller.signal.aborted) { setBusy(false); onBusy(false); } }
  }

  return <form className="run-composer" onSubmit={create} aria-busy={busy}>
    <div className="composer-heading"><h2>Novo teste</h2><span>1. Prepare <span aria-hidden="true">→</span> 2. Aprove <span aria-hidden="true">→</span> 3. Confira</span></div>
    {error && <div ref={errorRef} tabIndex={-1}><Notice>{error}</Notice></div>}
    <div className="field"><label htmlFor="test-message">Mensagem do teste</label><textarea id="test-message" aria-describedby="test-message-help" placeholder="Escreva a mensagem que deve aparecer no resultado…" maxLength={1000} required value={message} onChange={(event) => setMessage(event.target.value)} disabled={busy || locked} rows={3} /><div className="textarea-footer"><span id="test-message-help">Seu texto será reproduzido no resultado.</span><span>{message.length}/1.000</span></div></div>
    <div className="composer-actions"><div className="delay-field"><label htmlFor="test-delay">Espera antes do resultado</label><select id="test-delay" value={delay} onChange={(event) => setDelay(event.target.value)} disabled={busy || locked}><option value="0">Sem espera</option><option value="5">5 segundos</option><option value="15">15 segundos</option><option value="30">30 segundos</option></select></div><button className="button primary" disabled={busy || locked || !message.trim()}>{busy ? "Preparando…" : "Criar teste"}<Icon name="arrow" /></button></div>
  </form>;
}

export function RunDetail({ path, run, onChanged, onConflict, onBusy, locked = false, focusOnMount = false, onFocused }: { path: string; run: RunRecord; onChanged: (run: RunRecord) => void; onConflict: (message: string) => void; onBusy: (busy: boolean) => void; locked?: boolean; focusOnMount?: boolean; onFocused?: () => void }) {
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const abort = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const focusAfterAction = useRef(false);
  useNavigationGuard({ busy: busy !== null });
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (focusOnMount) { heading.current?.focus(); onFocused?.(); } }, [focusOnMount, onFocused]);
  useEffect(() => { if (confirmCancel) keepButton.current?.focus(); }, [confirmCancel]);
  useEffect(() => { if (confirmCancel && !run.canCancel) { setConfirmCancel(false); heading.current?.focus(); } }, [confirmCancel, run.canCancel]);
  useEffect(() => { if (!busy && focusAfterAction.current) { focusAfterAction.current = false; heading.current?.focus(); } }, [busy]);
  function dismissCancel() { setConfirmCancel(false); cancelButton.current?.focus(); }
  async function act(action: "approve" | "cancel") {
    if (pending.current || locked) return;
    pending.current = true;
    const controller = new AbortController(); abort.current = controller;
    setBusy(action); onBusy(true); setError("");
    try {
      const data = await api<{ run: RunRecord }>(`${path}/${encodeURIComponent(run.id)}/${action}`, { method: "POST", body: {}, signal: controller.signal });
      if (!controller.signal.aborted) { onChanged(data.run); setConfirmCancel(false); }
    } catch (failure) {
      if (!isAbort(failure)) {
        if (failure instanceof ApiError && [403, 404, 409].includes(failure.status)) { setConfirmCancel(false); onConflict(errorMessage(failure)); }
        else setError(errorMessage(failure));
      }
    }
    finally { pending.current = false; if (!controller.signal.aborted) { focusAfterAction.current = true; setBusy(null); onBusy(false); } }
  }
  const cancelControl = run.canCancel && <button ref={cancelButton} className="button secondary small" disabled={busy !== null || locked} onClick={() => setConfirmCancel(true)}><Icon name="stop" size={16} />Cancelar teste</button>;

  return <article className="run-detail" aria-labelledby="test-detail-heading" aria-busy={busy !== null}>
    <div className="run-detail-heading"><h3 id="test-detail-heading" ref={heading} tabIndex={-1}>Resultado do teste</h3><Status value={run.status} /></div>
    <p className="run-input">{run.input.message}</p>
    {error && <Notice>{error}</Notice>}
    {confirmCancel && run.canCancel && <section className="execution-cancel-confirm" aria-labelledby="cancel-test-heading" onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); dismissCancel(); } }}><h4 id="cancel-test-heading">Cancelar este teste?</h4><p>{run.status === "running" ? "Vamos solicitar a interrupção da execução. Resultados que chegarem depois do cancelamento não serão aceitos." : "Este teste não será executado novamente. Seu registro continuará no histórico."}</p><div className="button-row"><button ref={keepButton} className="button secondary small" disabled={busy !== null || locked} onClick={dismissCancel}>Manter teste</button><button className="button danger small" disabled={busy !== null || locked} onClick={() => void act("cancel")}>{busy === "cancel" ? "Cancelando…" : "Confirmar cancelamento"}</button></div></section>}
    {run.status === "waiting_approval" && <div className="approval-request"><h4>{run.canApprove ? "Pronto para executar?" : "Aguardando um administrador"}</h4><p>O teste vai reproduzir esta mensagem e registrar o arquivo de resultado. Nenhuma chave de IA será usada.{run.input.delayMs > 0 ? ` A espera configurada é de ${run.input.delayMs / 1000} segundos.` : ""}</p>{!confirmCancel && <div className="button-row">{run.canApprove && <button className="button primary small" disabled={busy !== null || locked} onClick={() => void act("approve")}><Icon name="check" size={16} />{busy === "approve" ? "Aprovando…" : "Aprovar e executar"}</button>}{cancelControl}</div>}</div>}
    {run.status === "running" && <div className="execution-progress"><p role="status"><span className="small-dot" /> Aguardando o resultado da execução.</p><p className="muted">O estado é atualizado automaticamente. Você pode sair desta tela e voltar pelo histórico.</p>{!confirmCancel && cancelControl}</div>}
    {run.status === "interrupted" && <><Notice kind="info">A execução foi interrompida e o resultado não está confirmado. Ela não será repetida automaticamente.</Notice>{!confirmCancel && cancelControl}</>}
    {run.status === "failed" && <Notice>O teste não foi concluído com sucesso. Confira a saída disponível antes de criar outro.</Notice>}
    {run.status === "cancelled" && <p className="muted">Este teste foi cancelado. Nenhum novo resultado será aceito para ele.</p>}
    {run.status === "succeeded" && !run.result && <Notice kind="info">O teste consta como concluído, mas a saída ainda não está disponível nesta consulta. Atualize o histórico para conferir a evidência.</Notice>}
    {run.result && <div className="result-evidence"><div className="evidence-heading"><h4>Saída registrada</h4><span>Código de saída: {run.result.exitCode}</span></div><pre tabIndex={0} aria-label="Saída da execução">{run.result.stdout || "Sem saída de texto."}</pre><h4>Arquivo de resultado</h4><pre tabIndex={0} aria-label="Conteúdo do arquivo de resultado">{run.result.artifact || "Sem conteúdo no arquivo."}</pre></div>}
    <dl className="run-metadata"><div><dt>Criado em</dt><dd>{formatDate(run.createdAt)}</dd></div><div><dt>Última atualização</dt><dd>{formatDate(run.updatedAt)}</dd></div><div><dt>Identificação</dt><dd className="mono">{run.id}</dd></div></dl>
  </article>;
}
