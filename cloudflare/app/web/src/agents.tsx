import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentRole } from "../../src/coding-types";
import type { AgentCatalogDraft, AgentCatalogState, CatalogAgent, CatalogSelections } from "../../src/agent-catalog-types";
import { api, ApiError, errorMessage, isAbort, organizationPath, type Organization } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { catalogDraft, catalogFileLimit, importCatalogProfiles, instructionBytes, validateCatalogProfiles } from "./agent-catalog-state";
import { JevSettings } from "./jev-settings";
import "./agents.css";

export const agentRoleNames: Record<AgentRole, string> = { coordinator: "Coordenador", programmer: "Programador", reviewer: "Revisor" };
const roleDescriptions: Record<AgentRole, string> = { coordinator: "Organiza o pedido e o plano de trabalho.", programmer: "Altera o código e executa os testes.", reviewer: "Revisa o código e as evidências antes do PR." };
const roles: AgentRole[] = ["coordinator", "programmer", "reviewer"];
const emptyTeam: CatalogSelections = { coordinator: "", programmer: "", reviewer: "" };

export function Agents({ organization }: { organization: Organization }) {
  return <AgentCatalog key={organization.id} organization={organization} />;
}
function AgentCatalog({ organization }: { organization: Organization }) {
  const path = `${organizationPath(organization.id)}/agent-catalog`;
  const canManage = organization.role !== "member";
  const [saved, setSaved] = useState<AgentCatalogState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [team, setTeam] = useState<CatalogSelections>(emptyTeam);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [imported, setImported] = useState<AgentCatalogDraft[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [reading, setReading] = useState(false);
  const [newDraft, setNewDraft] = useState<AgentCatalogDraft | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileSequence = useRef(0);
  const pending = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const currentAgent = saved?.agents.find((agent) => agent.id === selected);
  const activeDraft = newDraft ?? currentAgent;

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(""); setConflict(false);
    void api<AgentCatalogState>(path, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) { setSaved(data); setTeam(data.selections ?? emptyTeam); setSelected((value) => data.agents.some((agent) => agent.id === value) ? value : data.agents[0]?.id ?? null); setNewDraft(null); pending.current = null; } })
      .catch((failure: unknown) => { if (!isAbort(failure)) { setSaved(null); setError(errorMessage(failure)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);
  useEffect(() => () => { abort.current?.abort(); fileSequence.current += 1; }, []);

  async function mutate(change: { agents?: AgentCatalogDraft[]; selections?: CatalogSelections | null }, message: string, importing = false) {
    if (busy || !saved || !canManage || conflict) return false;
    const payload = { expectedVersion: saved.version, ...change };
    const fingerprint = JSON.stringify({ importing, payload });
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, requestId: crypto.randomUUID() };
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError(""); setNotice("");
    try {
      const data = await api<AgentCatalogState>(importing ? `${path}/import` : path, { method: importing ? "POST" : "PUT", body: { ...payload, requestId: pending.current.requestId }, signal: controller.signal });
      if (controller.signal.aborted) return false;
      setSaved(data); setTeam(data.selections ?? emptyTeam); setConflict(false); setNotice(message); pending.current = null;
      if (change.agents?.length === 1) setSelected(data.agents.find((agent) => agent.sourceId === change.agents![0].sourceId)?.id ?? null);
      else if (!selected) setSelected(data.agents[0]?.id ?? null);
      setNewDraft(null); return true;
    } catch (failure) {
      if (!isAbort(failure)) {
        const changed = failure instanceof ApiError && [403, 409].includes(failure.status);
        setError(changed ? "A configuração ou sua permissão mudou. Recarregue o catálogo antes de salvar novamente." : errorMessage(failure));
        if (changed) setConflict(true);
        if (failure instanceof ApiError && failure.status === 403) setSaved(null);
      }
      return false;
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function readImport(file: File | undefined) {
    const sequence = ++fileSequence.current; setImported(null); setError(""); setNotice("");
    if (!file) return;
    setFileName(file.name);
    if (file.size > catalogFileLimit) { setError("Escolha um arquivo JSON de até 2 MiB."); return; }
    setReading(true);
    try { const text = await file.text(); if (fileSequence.current === sequence) setImported(importCatalogProfiles(text)); }
    catch (failure) { if (fileSequence.current === sequence) setError(failure instanceof Error ? failure.message : "Não foi possível ler este arquivo."); }
    finally { if (fileSequence.current === sequence) setReading(false); }
  }
  function createAgent() {
    setSelected(null); setNewDraft({ sourceId: crypto.randomUUID(), name: "Novo agente", title: "", description: "", instructions: "", section: "Equipe", sourceEngine: "Veltram", sourceModel: "", sourceEffort: "" });
  }
  function exportProfiles() {
    if (!saved) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "veltram-agent-profiles", version: 1, agents: saved.agents.map(catalogDraft) }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "veltram-perfis-agentes.json"; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const matches = saved?.agents.filter((agent) => `${agent.name} ${agent.title} ${agent.section}`.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR"))) ?? [];
  const updates = imported?.filter((agent) => saved?.agents.some((current) => current.sourceId === agent.sourceId)).length ?? 0;
  const teamChanged = JSON.stringify(saved?.selections ?? emptyTeam) !== JSON.stringify(team);

  return <div className="catalog-page">
    <PageHeading eyebrow="EQUIPE DA EMPRESA" title="Agentes">Preserve os perfis de {organization.name} e escolha quem coordena, programa e revisa cada entrega.</PageHeading>
    {!canManage && <Notice kind="info">Você pode consultar os perfis e a equipe. Alterações são feitas por administradores.</Notice>}
    {error && <Notice>{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
    {loading ? <Loading label="Carregando catálogo de agentes" /> : !saved ? <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button> : <>
      {conflict && <div className="catalog-conflict"><button className="button secondary" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>Recarregar e descartar alterações locais</button></div>}
      <section className="catalog-team" aria-labelledby="catalog-team-heading"><header><div><p className="eyebrow">EQUIPE PADRÃO</p><h2 id="catalog-team-heading">Três papéis, uma entrega</h2></div><span className="catalog-count">{saved.selections ? "Perfis do catálogo" : "Equipe inicial do Veltram"}</span></header><p>Esta seleção é sugerida nas próximas tarefas. Cada tarefa registra a equipe e as instruções usadas na sua criação.</p>
        <form onSubmit={(event) => { event.preventDefault(); void mutate({ selections: team }, "Equipe padrão salva para as próximas tarefas."); }}><div className="catalog-role-grid">{roles.map((role, index) => <div key={role}><div className="catalog-role-title"><span>{index + 1}</span><label htmlFor={`catalog-role-${role}`}>{agentRoleNames[role]}</label></div><p>{roleDescriptions[role]}</p><select id={`catalog-role-${role}`} value={team[role]} disabled={!canManage || busy || conflict || !saved.agents.length} onChange={(event) => setTeam((current) => ({ ...current, [role]: event.target.value }))}><option value="">{saved.selections ? "Selecione um perfil" : `${agentRoleNames[role]} padrão`}</option>{saved.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div>)}</div>{canManage && <div className="catalog-team-actions"><span>Na nuvem, os perfis do catálogo usam o modelo escolhido na tarefa.</span><div className="button-row"><button className="button primary small" disabled={busy || conflict || !teamChanged || roles.some((role) => !team[role])}>Salvar equipe</button>{saved.selections && <button className="button secondary small" type="button" disabled={busy || conflict} onClick={() => void mutate({ selections: null }, "A equipe inicial do Veltram foi restaurada.")}>Usar equipe inicial</button>}</div></div>}</form>
      </section>
      <section className="catalog-section" aria-labelledby="catalog-heading"><div className="catalog-section-heading"><div><h2 id="catalog-heading">Catálogo de perfis <span>{saved.agents.length}</span></h2><p>Instruções, especialidades e origem de cada agente.</p></div><div className="button-row"><button className="button secondary small" disabled={!saved.agents.length} onClick={exportProfiles}>Exportar perfis</button>{canManage && <button className="button secondary small" disabled={busy || conflict || saved.agents.length >= 100} onClick={createAgent}><Icon name="plus" size={15} />Novo agente</button>}</div></div>
        {canManage && <details className="catalog-import"><summary>Importar perfis do OpenMausBot ou Veltram</summary><p>Selecione o JSON para conferir os perfis antes de importar. Apenas nomes, descrições, instruções e origem são enviados. Chaves, sessões e histórico ficam de fora.</p><label className="field" htmlFor="catalog-file"><span>Arquivo de perfis (.json, até 2 MiB)</span><input id="catalog-file" type="file" accept=".json,application/json" disabled={busy || conflict || reading} onChange={(event) => { void readImport(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>{reading && <p role="status">Lendo perfis…</p>}{imported && <div className="catalog-import-preview"><h3>Conferir {imported.length} perfis</h3><p>{fileName} · {imported.length - updates} novos · {updates} existentes serão atualizados pelo identificador de origem.</p><ul>{imported.map((agent) => <li key={agent.sourceId}><strong>{agent.name}</strong><span>{agent.sourceEngine || "Origem não informada"}{agent.sourceModel ? ` · ${agent.sourceModel}` : ""}</span></li>)}</ul><div className="button-row"><button className="button primary" disabled={busy || conflict} onClick={() => void mutate({ agents: imported }, `${imported.length} perfis importados. Os demais perfis foram preservados.`, true).then((ok) => { if (ok) setImported(null); })}>{busy ? "Importando…" : `Importar ${imported.length} perfis`}</button><button className="button secondary" disabled={busy} onClick={() => setImported(null)}>Cancelar importação</button></div></div>}</details>}
        {!saved.agents.length && !newDraft ? <div className="catalog-empty"><Icon name="team" size={30} /><h3>Seu catálogo começa aqui</h3><p>Importe os perfis do OpenMausBot ou crie um agente para montar sua equipe. A equipe inicial continua disponível para novas tarefas.</p>{canManage && <button className="button secondary" onClick={createAgent}>Criar primeiro agente</button>}</div> : <div className="catalog-layout"><aside className="catalog-list"><div className="field"><label htmlFor="catalog-search">Buscar agente</label><input id="catalog-search" type="search" placeholder="Nome, título ou seção" value={search} onChange={(event) => setSearch(event.target.value)} /></div><ul aria-label="Perfis do catálogo">{matches.map((agent) => <li key={agent.id}><button className={selected === agent.id && !newDraft ? "selected" : ""} aria-pressed={selected === agent.id && !newDraft} disabled={busy} onClick={() => { setSelected(agent.id); setNewDraft(null); }}><strong>{agent.name}</strong><span>{agent.title || agent.section || "Perfil de agente"}</span><small>{agent.sourceEngine || "Origem não informada"}{agent.sourceModel ? ` · ${agent.sourceModel}` : ""}</small></button></li>)}</ul>{!matches.length && <p className="field-hint">Nenhum agente corresponde à busca.</p>}</aside><div>{activeDraft ? <ProfileEditor key={`${activeDraft.sourceId}-${currentAgent?.revision ?? "new"}`} agent={activeDraft} isNew={!!newDraft} busy={busy} canManage={canManage && !conflict} onSave={(draft) => mutate({ agents: [draft] }, "Perfil salvo. Tarefas já criadas preservam as instruções anteriores.")} onCancel={newDraft ? () => setNewDraft(null) : undefined} /> : <p className="catalog-empty">Selecione um perfil para consultar as instruções.</p>}</div></div>}
      </section>
    </>}
    <JevSettings organization={organization} />
  </div>;
}
function ProfileEditor({ agent, isNew, busy, canManage, onSave, onCancel }: { agent: AgentCatalogDraft | CatalogAgent; isNew: boolean; busy: boolean; canManage: boolean; onSave: (draft: AgentCatalogDraft) => Promise<boolean>; onCancel?: () => void }) {
  const [draft, setDraft] = useState(catalogDraft(agent)); const [error, setError] = useState("");
  const bytes = instructionBytes(draft.instructions); const dirty = isNew || JSON.stringify(draft) !== JSON.stringify(catalogDraft(agent));
  function update(field: "name" | "title" | "section" | "description" | "instructions", value: string) { setDraft((current) => ({ ...current, [field]: value })); setError(""); }
  function save(event: FormEvent) { event.preventDefault(); try { const [validated] = validateCatalogProfiles([draft]); void onSave(validated); } catch (failure) { setError(failure instanceof Error ? failure.message : "Confira os campos do perfil."); } }
  return <form className="catalog-editor form-stack" onSubmit={save}><header><p className="eyebrow">{isNew ? "NOVO PERFIL" : "PERFIL DO AGENTE"}</p><h3>{agent.name}</h3>{"revision" in agent && <span className="field-hint">Revisão {agent.revision}</span>}</header><dl className="catalog-origin"><div><dt>Motor de origem</dt><dd>{agent.sourceEngine || "Não informado"}</dd></div><div><dt>Modelo de origem</dt><dd>{agent.sourceModel || "Não informado"}</dd></div>{agent.sourceEffort && <div><dt>Esforço de origem</dt><dd>{agent.sourceEffort}</dd></div>}</dl><p className="field-hint">A origem preserva a referência do perfil. A execução na nuvem usa a chave da empresa e o modelo escolhido na tarefa.</p>{error && <Notice>{error}</Notice>}<div className="form-pair"><div className="field"><label htmlFor="catalog-name">Nome</label><input id="catalog-name" required maxLength={100} value={draft.name} disabled={!canManage || busy} onChange={(event) => update("name", event.target.value)} /></div><div className="field"><label htmlFor="catalog-section">Seção</label><input id="catalog-section" maxLength={100} value={draft.section} disabled={!canManage || busy} onChange={(event) => update("section", event.target.value)} /></div></div><div className="field"><label htmlFor="catalog-title">Especialidade ou título</label><input id="catalog-title" maxLength={200} value={draft.title} disabled={!canManage || busy} onChange={(event) => update("title", event.target.value)} /></div><div className="field"><label htmlFor="catalog-description">Descrição</label><textarea id="catalog-description" rows={3} maxLength={4000} value={draft.description} disabled={!canManage || busy} onChange={(event) => update("description", event.target.value)} /></div><div className="field"><label htmlFor="catalog-instructions">Instruções</label><textarea id="catalog-instructions" rows={12} maxLength={20000} aria-describedby="catalog-instruction-limit" aria-invalid={bytes > 20000} value={draft.instructions} disabled={!canManage || busy} onChange={(event) => update("instructions", event.target.value)} /><p id="catalog-instruction-limit" className={`field-hint${bytes > 20000 ? " catalog-limit-error" : ""}`}>{bytes.toLocaleString("pt-BR")} / 20.000 bytes. Acentos e símbolos podem ocupar mais de um byte. Quando vazio, a descrição orienta o agente.</p></div>{canManage && <div className="button-row"><button className="button primary" disabled={busy || !dirty || bytes > 20000}>{busy ? "Salvando…" : "Salvar perfil"}</button><button className="button secondary" type="button" disabled={busy || !dirty} onClick={() => { if (onCancel) onCancel(); else { setDraft(catalogDraft(agent)); setError(""); } }}>{isNew ? "Cancelar" : "Descartar alterações"}</button></div>}</form>;
}
