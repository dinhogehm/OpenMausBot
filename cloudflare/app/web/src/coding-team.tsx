import { useEffect, useRef, useState } from "react";
import type { AgentCatalogState, AgentSelections, CatalogSelections } from "../../src/agent-catalog-types";
import { agentRoleNames } from "./agents";
import { api, errorMessage, isAbort } from "./api";
import { Notice } from "./components";

const roles = ["coordinator", "programmer", "reviewer"] as const;
export function CodingTeamPicker({ catalog, organizationPath, task, disabled, onChange, onBusyChange }: {
  catalog: AgentCatalogState; organizationPath: string; task: string; disabled: boolean;
  onChange: (selection: AgentSelections | undefined, valid: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [custom, setCustom] = useState(Boolean(catalog.selections));
  const [selection, setSelection] = useState<CatalogSelections>(catalog.selections ?? { coordinator: "", programmer: "", reviewer: "" });
  const [jev, setJev] = useState<{ status: string; canRecommend: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ status: string; canRecommend: boolean }>(`${organizationPath}/decision-model`, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setJev(value); }).catch(() => { if (!controller.signal.aborted) setJev(null); });
    return () => controller.abort();
  }, [organizationPath]);
  useEffect(() => { abort.current?.abort(); setBusy(false); setNotice(""); setError(""); return () => abort.current?.abort(); }, [task, catalog.version, organizationPath]);
  if (!catalog.agents.length) return <p className="field-hint">A tarefa usa os três agentes configurados em Agentes.</p>;
  function publish(next: CatalogSelections, enabled: boolean) {
    onChange(enabled ? { ...next, catalogVersion: catalog.version } : undefined, !enabled || roles.every((role) => Boolean(next[role])));
  }
  async function recommend() {
    if (busy || !task.trim() || !jev?.canRecommend || jev.status !== "configured") return;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ catalogVersion: number; recommendation: AgentSelections | null; confidence: Record<keyof CatalogSelections, number> | null; fallback: boolean }>(`${organizationPath}/agent-catalog/recommend`, { method: "POST", body: { catalogVersion: catalog.version, task: task.trim() }, signal: controller.signal });
      if (controller.signal.aborted) return;
      const next = result.recommendation;
      if (result.fallback || !next) { setNotice("O Jev não retornou uma escolha confiável. A equipe selecionada foi mantida."); return; }
      if (result.catalogVersion !== catalog.version || next.catalogVersion !== catalog.version || !roles.every((role) => catalog.agents.some((agent) => agent.id === next[role]) && typeof result.confidence?.[role] === "number" && result.confidence[role] >= 0.6 && result.confidence[role] <= 1)) throw new Error("Invalid recommendation");
      setCustom(true); setSelection(next); publish(next, true);
      setNotice(`Equipe sugerida pelo Jev. Confira os três nomes antes de criar a tarefa. Probabilidade das escolhas: ${roles.map((role) => `${agentRoleNames[role]} ${Math.round(result.confidence![role] * 100)}%`).join(" · ")}.`);
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <fieldset className="coding-team-picker"><legend>Equipe da tarefa</legend><label className="team-choice"><input type="checkbox" disabled={disabled || busy} checked={custom} onChange={(event) => { setCustom(event.target.checked); publish(selection, event.target.checked); }} />Escolher os agentes do catálogo</label>
    {custom ? <div className="coding-team-fields">{roles.map((role) => <div className="field" key={role}><label htmlFor={`task-agent-${role}`}>{agentRoleNames[role]}</label><select id={`task-agent-${role}`} value={selection[role]} disabled={disabled || busy} onChange={(event) => { const next = { ...selection, [role]: event.target.value }; setSelection(next); publish(next, true); }}><option value="">Escolha um agente</option>{catalog.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div>)}</div> : <p className="field-hint">Usar a equipe padrão definida em Agentes.</p>}
    <p className="field-hint">Os perfis selecionados usarão o provedor e o modelo desta tarefa. A equipe fica registrada no momento da criação.</p>
    {jev?.status === "configured" && jev.canRecommend && <div className="jev-task-choice"><button type="button" className="button secondary small" disabled={disabled || busy || !task.trim()} onClick={() => void recommend()}>{busy ? "Consultando Jev…" : "Sugerir equipe com Jev"}</button><p className="field-hint">Envia a descrição da tarefa e os perfis ao Jev. A consulta usa a chave da empresa e pode gerar cobrança.</p></div>}
    {jev?.status !== "configured" && <p className="field-hint">Para receber sugestões do Jev, configure sua chave na página Agentes.</p>}
    {error && <Notice>{error}</Notice>}{notice && <Notice kind="info">{notice}</Notice>}
  </fieldset>;
}
