import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DecisionModelState } from "../../src/decision-model-types";
import { api, ApiError, errorMessage, formatDate, isAbort, organizationPath, type Organization } from "./api";
import { Loading, Notice } from "./components";
import { useNavigationGuard } from "./navigation-guard";

export function JevAvailability({ state }: { state: DecisionModelState }) {
  return <><p id="jev-status" tabIndex={-1} className={`jev-status ${state.status === "configured" ? "configured" : ""}`}><span aria-hidden="true" />{state.status === "configured" ? "Chave armazenada" : state.status === "revoked" ? "Chave removida" : "Sem chave configurada"}</p>
    <p className="field-hint">{state.status === "configured" ? "Armazenar a chave não confirma sua validade no Jev e não faz uma chamada de IA." : "A escolha manual da equipe continua disponível. Um administrador pode armazenar a chave para solicitar sugestões."}{state.updatedAt ? ` Atualizado em ${formatDate(state.updatedAt)}.` : ""}</p>
    {state.status === "configured" && <p className="field-hint">{state.canRecommend ? "Para consultar, crie uma tarefa e escolha Sugerir equipe com Jev. Confira a sugestão antes de usá-la." : "As sugestões estão indisponíveis neste momento. Escolha os perfis manualmente na tarefa."}</p>}</>;
}

/** Jev is a decision service. Its key never becomes a coding-agent credential. */
export function JevSettings({ organization }: { organization: Organization }) {
  const path = `${organizationPath(organization.id)}/decision-model`;
  const [state, setState] = useState<DecisionModelState | null>(null);
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<"save" | "remove" | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const canManage = organization.role !== "member";
  useNavigationGuard({ dirty: Boolean(key), busy });
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setState(null); setError(""); setConflict(false); setKey(""); setRemoving(false);
    void api<DecisionModelState>(path, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setState(data); })
      .catch((failure) => { if (!isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (removing) keepButton.current?.focus(); }, [removing]);
  async function change(remove: boolean) {
    if (!state || busy || !canManage || conflict || (!remove && !key.trim())) return;
    const controller = new AbortController(); abort.current = controller; setOperation(remove ? "remove" : "save"); setError(""); setNotice("");
    try {
      const data = await api<DecisionModelState>(path, { method: remove ? "DELETE" : "PUT", body: { expectedVersion: state.version, ...(remove ? {} : { key: key.trim() }) }, signal: controller.signal });
      if (!controller.signal.aborted) {
        setState(data); setKey(""); setRemoving(false);
        setNotice(remove ? "A chave do Jev foi removida. Você pode continuar escolhendo os agentes manualmente." : "Chave armazenada. Nenhuma consulta ao Jev foi feita.");
        requestAnimationFrame(() => document.getElementById("jev-status")?.focus());
      }
    } catch (failure) {
      if (!isAbort(failure)) {
        const changed = failure instanceof ApiError && [403, 409].includes(failure.status);
        setError(changed ? "A configuração ou sua permissão mudou. Atualize o estado antes de continuar." : errorMessage(failure));
        if (changed) { setConflict(true); setKey(""); }
      }
    } finally { if (!controller.signal.aborted) setOperation(null); }
  }
  function save(event: FormEvent) { event.preventDefault(); void change(false); }
  return <section className="catalog-section jev-settings" aria-labelledby="jev-heading"><div><p className="eyebrow">SUGESTÃO DE EQUIPE</p><h2 id="jev-heading" tabIndex={-1}>Jev</h2><p>O Jev sugere um perfil do catálogo para cada papel, a partir da descrição da tarefa. Você confere os três nomes antes de criar e aprovar a execução.</p><p className="field-hint">A consulta envia a descrição e os perfis ao Jev e pode gerar cobrança. A chave pertence a {organization.name}; nenhuma chave do aplicativo local é importada.</p></div><div>{error && <Notice>{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}{loading ? <Loading label="Carregando configuração do Jev" /> : !state || conflict ? <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Atualizar configuração do Jev</button> : <><JevAvailability state={state} />{canManage && <form className="form-stack" onSubmit={save}><div className="field"><label htmlFor="jev-key">{state.status === "configured" ? "Substituir chave do Jev" : "Chave de API do Jev"}</label><input id="jev-key" type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} placeholder="Cole a chave desta empresa" aria-describedby="jev-key-hint" /><p className="field-hint" id="jev-key-hint">A chave fica protegida e não será exibida depois de salva.</p></div><div className="button-row"><button className="button primary small" disabled={busy || !key.trim()}>{operation === "save" ? "Salvando chave…" : "Salvar chave"}</button>{key && <button type="button" className="text-button" disabled={busy} onClick={() => { setKey(""); document.getElementById("jev-key")?.focus(); }}>Limpar campo</button>}{state.status === "configured" && !removing && <button ref={removeButton} type="button" className="button secondary small" disabled={busy} onClick={() => setRemoving(true)}>Remover chave</button>}</div>{removing && <div className="jev-remove" role="group" aria-labelledby="jev-remove-title"><h3 id="jev-remove-title">Remover a chave de {organization.name}?</h3><p>Novas sugestões do Jev ficarão indisponíveis. A seleção manual e as equipes já registradas em tarefas serão preservadas.</p><div className="button-row"><button ref={keepButton} className="button secondary" type="button" disabled={busy} onClick={() => { setRemoving(false); requestAnimationFrame(() => removeButton.current?.focus()); }}>Manter chave</button><button className="button secondary danger" type="button" disabled={busy} onClick={() => void change(true)}>{operation === "remove" ? "Removendo chave…" : "Confirmar remoção"}</button></div></div>}</form>}</>}</div></section>;
}
