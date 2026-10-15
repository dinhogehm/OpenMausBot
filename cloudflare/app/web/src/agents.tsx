import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentProfile, AgentRole } from "../../src/coding-types";
import { api, ApiError, errorMessage, isAbort, organizationPath, type Organization } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";

interface AgentConfiguration { version: number; agents: AgentProfile[] }
export const agentRoleNames: Record<AgentRole, string> = { coordinator: "Coordenador", programmer: "Programador", reviewer: "Revisor" };
const roleDescriptions: Record<AgentRole, string> = {
  coordinator: "Organiza o pedido em um plano de trabalho antes das alterações.",
  programmer: "Lê o repositório, altera os arquivos e executa os comandos necessários.",
  reviewer: "Revisa as alterações e os resultados dos testes antes da criação do PR.",
};
const roleOrder: AgentRole[] = ["coordinator", "programmer", "reviewer"];

export function Agents({ organization }: { organization: Organization }) {
  const path = `${organizationPath(organization.id)}/agents`;
  const [saved, setSaved] = useState<AgentConfiguration | null>(null);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const canManage = organization.role !== "member";
  const dirty = saved !== null && JSON.stringify(saved.agents) !== JSON.stringify(agents);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setConflict(false);
    void api<AgentConfiguration>(path, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) { setSaved(data); setAgents(data.agents); } })
      .catch((failure: unknown) => { if (!isAbort(failure)) { setSaved(null); setAgents([]); setError(errorMessage(failure)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);
  useEffect(() => () => abort.current?.abort(), []);

  function update(role: AgentRole, change: Partial<AgentProfile>) {
    setNotice("");
    setAgents((current) => current.map((agent) => agent.role === role ? { ...agent, ...change } : agent));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !saved || !canManage) return;
    if (agents.some((agent) => !agent.name.trim() || !agent.instructions.trim() || (agent.provider !== "inherit" && !agent.model.trim()))) {
      setError("Informe o nome e as instruções de cada agente e o modelo dos provedores escolhidos."); return;
    }
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await api<AgentConfiguration>(path, { method: "PUT", body: { expectedVersion: saved.version, agents }, signal: controller.signal });
      if (!controller.signal.aborted) { setSaved(data); setAgents(data.agents); setConflict(false); setNotice("Equipe salva. As próximas tarefas usarão esta configuração."); }
    } catch (failure) {
      if (!isAbort(failure)) {
        setError(errorMessage(failure));
        if (failure instanceof ApiError && [403, 409].includes(failure.status)) setConflict(true);
        if (failure instanceof ApiError && failure.status === 403) { setSaved(null); setAgents([]); }
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <>
    <PageHeading eyebrow="EQUIPE DA EMPRESA" title="Agentes">Personalize a equipe de {organization.name}. Cada papel participa da tarefa com uma responsabilidade definida.</PageHeading>
    {!canManage && <Notice kind="info">Você pode consultar a equipe. Somente administradores podem alterar sua configuração.</Notice>}
    {error && <Notice>{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
    {loading ? <Loading label="Carregando equipe de agentes" /> : !saved ? <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button> : <form className="agent-team" onSubmit={save}>
      <ol className="agent-order" aria-label="Sequência da equipe">{roleOrder.map((role, index) => <li key={role}><span>{index + 1}</span>{agentRoleNames[role]}</li>)}</ol>
      {roleOrder.map((role) => {
        const agent = agents.find((item) => item.role === role);
        if (!agent) return null;
        return <section className="agent-editor" key={role} aria-labelledby={`agent-${role}-heading`}><header><h2 id={`agent-${role}-heading`}>{agentRoleNames[role]}</h2><p>{roleDescriptions[role]}</p></header><div className="agent-fields form-stack">
          <div className="field"><label htmlFor={`agent-${role}-name`}>Nome</label><input id={`agent-${role}-name`} required maxLength={80} disabled={!canManage || busy} value={agent.name} onChange={(event) => update(role, { name: event.target.value })} /></div>
          <div className="field"><label htmlFor={`agent-${role}-instructions`}>Instruções</label><textarea id={`agent-${role}-instructions`} rows={4} required maxLength={4000} disabled={!canManage || busy} value={agent.instructions} onChange={(event) => update(role, { instructions: event.target.value })} /><p className="field-hint">Oriente como este agente deve trabalhar. As permissões do repositório e a aprovação da tarefa continuam valendo.</p></div>
          <div className="form-pair"><div className="field"><label htmlFor={`agent-${role}-provider`}>Provedor</label><select id={`agent-${role}-provider`} disabled={!canManage || busy} value={agent.provider} onChange={(event) => update(role, { provider: event.target.value as AgentProfile["provider"], model: "" })}><option value="inherit">Usar o provedor da tarefa</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openrouter">OpenRouter</option></select></div><div className="field"><label htmlFor={`agent-${role}-model`}>Modelo</label><input id={`agent-${role}-model`} maxLength={120} autoComplete="off" required={agent.provider !== "inherit"} disabled={!canManage || busy || agent.provider === "inherit"} placeholder={agent.provider === "inherit" ? "Usar o modelo da tarefa" : "ID do modelo na sua conta"} value={agent.model} onChange={(event) => update(role, { model: event.target.value })} /></div></div>
          {agent.provider !== "inherit" && <p className="field-hint">Esta empresa precisa ter uma chave de {agent.provider === "openai" ? "OpenAI" : agent.provider === "anthropic" ? "Anthropic" : "OpenRouter"} disponível para executar novas tarefas.</p>}
        </div></section>;
      })}
      {canManage && <div className="agent-save"><p>As tarefas já criadas mantêm a equipe registrada no momento da criação.</p><div className="button-row">{conflict ? <button type="button" className="button secondary" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>Recarregar configuração atual</button> : <><button className="button primary" disabled={busy || !dirty}><Icon name="check" size={16} />{busy ? "Salvando…" : "Salvar equipe"}</button><button type="button" className="button secondary" disabled={busy || !dirty} onClick={() => { setAgents(saved.agents); setError(""); setNotice(""); }}>Descartar alterações</button></>}</div></div>}
    </form>}
  </>;
}
