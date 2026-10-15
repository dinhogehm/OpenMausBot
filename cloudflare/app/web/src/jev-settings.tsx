import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DecisionModelState } from "../../src/decision-model-types";
import { api, ApiError, errorMessage, formatDate, isAbort, organizationPath, type Organization } from "./api";
import { Loading, Notice } from "./components";

/** Jev is a decision service. Its key never becomes a coding-agent credential. */
export function JevSettings({ organization }: { organization: Organization }) {
  const path = `${organizationPath(organization.id)}/decision-model`;
  const [state, setState] = useState<DecisionModelState | null>(null);
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const canManage = organization.role !== "member";
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(""); setConflict(false); setKey("");
    void api<DecisionModelState>(path, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setState(data); })
      .catch((failure) => { if (!isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);
  useEffect(() => () => abort.current?.abort(), []);
  async function change(remove: boolean) {
    if (!state || busy || !canManage || conflict || (!remove && !key.trim())) return;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError(""); setNotice("");
    try {
      const data = await api<DecisionModelState>(path, { method: remove ? "DELETE" : "PUT", body: { expectedVersion: state.version, ...(remove ? {} : { key: key.trim() }) }, signal: controller.signal });
      if (!controller.signal.aborted) { setState(data); setKey(""); setRemoving(false); setNotice(remove ? "A chave do Jev foi removida. A seleção manual de agentes continua disponível." : "Chave armazenada. A conexão será usada quando você solicitar uma recomendação na criação da tarefa."); }
    } catch (failure) {
      if (!isAbort(failure)) {
        const changed = failure instanceof ApiError && [403, 409].includes(failure.status);
        setError(changed ? "A configuração ou sua permissão mudou. Atualize o estado antes de continuar." : errorMessage(failure));
        if (changed) { setConflict(true); setKey(""); }
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function save(event: FormEvent) { event.preventDefault(); void change(false); }
  return <section className="catalog-section jev-settings" aria-labelledby="jev-heading"><div><p className="eyebrow">ESCOLHA DA EQUIPE</p><h2 id="jev-heading">Jev</h2><p>O Jev recomenda um perfil do catálogo para cada papel a partir da tarefa. Você confere a sugestão antes de criar e aprovar a execução.</p><p className="field-hint">É um serviço de decisão separado dos agentes que escrevem código. A chave pertence a esta empresa; nenhuma chave do aplicativo local é importada.</p></div><div>{error && <Notice>{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}{loading ? <Loading label="Carregando configuração do Jev" /> : !state || conflict ? <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Atualizar configuração</button> : <><p className={`jev-status ${state.status === "configured" ? "configured" : ""}`}><span aria-hidden="true" />{state.status === "configured" ? "Chave armazenada" : state.status === "revoked" ? "Chave removida" : "Sem chave configurada"}</p><p className="field-hint">{state.status === "configured" ? "Salvar a chave não valida a conexão nem faz uma chamada de IA." : "Conecte o Jev para solicitar recomendações. Você também pode escolher a equipe manualmente."}{state.updatedAt ? ` Atualizado em ${formatDate(state.updatedAt)}.` : ""}</p>{canManage && <form className="form-stack" onSubmit={save}><div className="field"><label htmlFor="jev-key">{state.status === "configured" ? "Substituir chave do Jev" : "Chave de API do Jev"}</label><input id="jev-key" type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} placeholder="Cole a chave desta empresa" /></div><div className="button-row"><button className="button primary small" disabled={busy || !key.trim()}>{busy ? "Salvando…" : "Salvar chave"}</button>{state.status === "configured" && <button type="button" className="button secondary small" disabled={busy} onClick={() => setRemoving((value) => !value)}>Remover chave</button>}</div>{removing && <div className="jev-remove"><p>Novas recomendações do Jev ficarão indisponíveis para esta empresa.</p><div className="button-row"><button className="button secondary small" type="button" disabled={busy} onClick={() => void change(true)}>Confirmar remoção</button><button className="text-button" type="button" disabled={busy} onClick={() => setRemoving(false)}>Manter chave</button></div></div>}</form>}</>}</div></section>;
}
