import { useEffect, useRef, useState, type FormEvent } from "react";
import type { RunStatus } from "../../src/execution";
import { api, ApiError, errorMessage, formatDate, isAbort, organizationPath } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { mergeRuns, type VisibleRun as RunRecord } from "./run-state";

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
  const hasRunning = runs.some((run) => run.status === "running");
  const selected = runs.find((run) => run.id === selectedId);

  function validateScope(records: RunRecord[]): RunRecord[] {
    if (records.some((run) => run.organizationId !== organizationId || run.workspaceId !== workspaceId)) throw new Error("Unexpected response scope");
    return records;
  }

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
    if (!hasRunning) return;
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
            else setPollError("Não foi possível atualizar o teste. O último estado conhecido continua abaixo.");
          }
        })
        .finally(() => { pending = false; });
    }, 2000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [path, hasRunning]);

  function changed(run: RunRecord) {
    validateScope([run]);
    setActionError("");
    setRuns((current) => mergeRuns(current, [run]));
    setSelectedId(run.id);
  }

  return <>
    <PageHeading eyebrow="PRIMEIRO PASSO" title="Teste de execução">Envie uma mensagem, aprove a execução e confira o resultado registrado.</PageHeading>
    <div className="proof-note"><Icon name="play" size={18} /><p>Este é um teste do ambiente de execução. Ele reproduz sua mensagem e gera um arquivo de resultado, sem usar um modelo de IA.</p></div>
    <RunComposer path={path} onCreated={changed} />
    <section className="run-history" aria-labelledby="history-title"><div className="section-heading"><div><h2 id="history-title">Histórico de testes</h2><p>O estado e o resultado de cada execução.</p></div><button className="text-button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}><Icon name="refresh" size={15} /> Atualizar</button></div>
      {error && <Notice>{error}</Notice>}{actionError && <Notice>{actionError}</Notice>}{pollError && <Notice kind="info">{pollError}</Notice>}
      {loading ? <Loading label="Carregando testes" /> : !error && (runs.length === 0 ? <div className="empty-state"><div className="empty-symbol"><Icon name="play" size={24} /></div><h3>O primeiro resultado começa aqui.</h3><p>Crie um teste acima. Ele só será iniciado depois da aprovação de um administrador.</p></div> : <div className="run-history-layout"><div className="run-list" aria-label="Testes">{runs.map((run) => <button className={`run-row${run.id === selectedId ? " selected" : ""}`} key={run.id} onClick={() => setSelectedId(run.id)} aria-pressed={run.id === selectedId}><span className="run-title">{run.input.message}</span><Status value={run.status} /><time dateTime={new Date(run.createdAt).toISOString()}>{formatDate(run.createdAt)}</time></button>)}</div>{selected && <RunDetail key={selected.id} path={path} run={selected} onChanged={changed} onConflict={(message) => { setActionError(message); setAttempt((value) => value + 1); }} />}</div>)}
    </section>
  </>;
}

function RunComposer({ path, onCreated }: { path: string; onCreated: (run: RunRecord) => void }) {
  const [message, setMessage] = useState("");
  const [delay, setDelay] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController(); abort.current = controller;
    const input = { message: message.trim(), delayMs: Number(delay) * 1000 };
    const fingerprint = JSON.stringify(input);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const data = await api<{ run: RunRecord }>(path, { method: "POST", body: { ...input, requestId: request.current.id }, signal: controller.signal });
      if (!controller.signal.aborted) { onCreated(data.run); setMessage(""); request.current = null; }
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <form className="run-composer" onSubmit={create}>
    <div className="composer-heading"><h2>Novo teste</h2><span>1. Prepare <span aria-hidden="true">→</span> 2. Aprove <span aria-hidden="true">→</span> 3. Confira</span></div>
    {error && <Notice>{error}</Notice>}
    <div className="field"><label htmlFor="test-message">Mensagem do teste</label><textarea id="test-message" placeholder="Escreva a mensagem que deve aparecer no resultado…" maxLength={1000} required value={message} onChange={(event) => setMessage(event.target.value)} disabled={busy} rows={3} /><div className="textarea-footer"><span>A mensagem será usada exatamente como texto.</span><span>{message.length}/1.000</span></div></div>
    <div className="composer-actions"><div className="delay-field"><label htmlFor="test-delay">Espera antes do resultado</label><select id="test-delay" value={delay} onChange={(event) => setDelay(event.target.value)} disabled={busy}><option value="0">Sem espera</option><option value="5">5 segundos</option><option value="15">15 segundos</option><option value="30">30 segundos</option></select></div><button className="button primary" disabled={busy || !message.trim()}>{busy ? "Preparando…" : "Criar teste"}<Icon name="arrow" /></button></div>
  </form>;
}

function RunDetail({ path, run, onChanged, onConflict }: { path: string; run: RunRecord; onChanged: (run: RunRecord) => void; onConflict: (message: string) => void }) {
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function act(action: "approve" | "cancel") {
    if (busy) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(action); setError("");
    try {
      const data = await api<{ run: RunRecord }>(`${path}/${encodeURIComponent(run.id)}/${action}`, { method: "POST", body: {}, signal: controller.signal });
      if (!controller.signal.aborted) onChanged(data.run);
    } catch (failure) {
      if (!isAbort(failure)) {
        if (failure instanceof ApiError && [403, 404, 409].includes(failure.status)) onConflict(errorMessage(failure));
        else setError(errorMessage(failure));
      }
    }
    finally { if (!controller.signal.aborted) setBusy(null); }
  }

  return <article className="run-detail" aria-label="Detalhes do teste">
    <div className="run-detail-heading"><h3>Resultado do teste</h3><Status value={run.status} /></div>
    <p className="run-input">{run.input.message}</p>
    {error && <Notice>{error}</Notice>}
    {run.status === "waiting_approval" && <div className="approval-request"><h4>{run.canApprove ? "Pronto para executar?" : "Aguardando um administrador"}</h4><p>O teste vai reproduzir esta mensagem e registrar o arquivo de resultado. {run.input.delayMs > 0 ? `A espera configurada é de ${run.input.delayMs / 1000} segundos.` : "Nenhuma chave de IA será usada."}</p><div className="button-row">{run.canApprove && <button className="button primary small" disabled={busy !== null} onClick={() => void act("approve")}><Icon name="check" size={16} />{busy === "approve" ? "Aprovando…" : "Aprovar e executar"}</button>}{run.canCancel && <button className="button secondary small" disabled={busy !== null} onClick={() => void act("cancel")}>{busy === "cancel" ? "Cancelando…" : "Cancelar"}</button>}</div></div>}
    {run.status === "running" && <div className="execution-progress"><p><span className="small-dot" /> Aguardando o resultado da execução.</p><p className="muted">Você pode sair desta tela e voltar pelo histórico.</p>{run.canCancel && <button className="button secondary small" onClick={() => void act("cancel")} disabled={busy !== null}><Icon name="stop" size={14} />{busy === "cancel" ? "Cancelando…" : "Cancelar teste"}</button>}</div>}
    {run.status === "interrupted" && <><Notice kind="info">A execução foi interrompida e o resultado não está confirmado. Ela não será repetida automaticamente.</Notice>{run.canCancel && <button className="button secondary small" disabled={busy !== null} onClick={() => void act("cancel")}>{busy === "cancel" ? "Cancelando…" : "Cancelar teste"}</button>}</>}
    {run.status === "failed" && <Notice>O teste não foi concluído com sucesso. Confira a saída disponível antes de criar outro.</Notice>}
    {run.status === "cancelled" && <p className="muted">Este teste foi cancelado. Nenhum novo resultado será aceito para ele.</p>}
    {run.result && <div className="result-evidence"><div className="evidence-heading"><h4>Saída registrada</h4><span>Código de saída: {run.result.exitCode}</span></div><pre tabIndex={0} aria-label="Saída da execução">{run.result.stdout || "Sem saída de texto."}</pre><h4>Arquivo de resultado</h4><pre tabIndex={0} aria-label="Conteúdo do arquivo de resultado">{run.result.artifact || "Sem conteúdo no arquivo."}</pre></div>}
    <dl className="run-metadata"><div><dt>Criado em</dt><dd>{formatDate(run.createdAt)}</dd></div><div><dt>Última atualização</dt><dd>{formatDate(run.updatedAt)}</dd></div><div><dt>Identificação</dt><dd className="mono">{run.id}</dd></div></dl>
  </article>;
}
