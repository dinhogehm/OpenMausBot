import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentRole } from "../../src/coding-types";
import type { AgentCatalogDraft, AgentCatalogState, CatalogAgent, CatalogSelections } from "../../src/agent-catalog-types";
import { api, ApiError, errorMessage, isAbort, organizationPath, type Organization } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { catalogDraft, catalogFileLimit, importCatalogProfiles, instructionBytes, matchesCatalogSearch, validateCatalogProfiles } from "./agent-catalog-state";
import { acceptProfileChanges, getProfileDraft, updateProfileDraft, type ProfileDrafts } from "./agent-editor-state";
import { JevSettings } from "./jev-settings";
import { useNavigationGuard } from "./navigation-guard";
import "./agents.css";

export const agentRoleNames: Record<AgentRole, string> = { coordinator: "Coordenador", programmer: "Programador", reviewer: "Revisor" };
const roleDescriptions: Record<AgentRole, string> = { coordinator: "Organiza o pedido e o plano de trabalho.", programmer: "Altera o código e executa os testes.", reviewer: "Revisa o código e as evidências antes do PR." };
const roles: AgentRole[] = ["coordinator", "programmer", "reviewer"];
const emptyTeam: CatalogSelections = { coordinator: "", programmer: "", reviewer: "" };
type CatalogConfirmation = "reload" | "import" | "team" | null;

export function Agents({ organization }: { organization: Organization }) {
  return <AgentCatalog key={organization.id} organization={organization} />;
}
function AgentCatalog({ organization }: { organization: Organization }) {
  const path = `${organizationPath(organization.id)}/agent-catalog`;
  const canManage = organization.role !== "member";
  const [saved, setSaved] = useState<AgentCatalogState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [team, setTeam] = useState<CatalogSelections>(emptyTeam);
  const [drafts, setDrafts] = useState<ProfileDrafts>({});
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
  const [confirmation, setConfirmation] = useState<CatalogConfirmation>(null);
  const abort = useRef<AbortController | null>(null);
  const fileSequence = useRef(0);
  const pending = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const editorFocus = useRef(false);
  const newButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const currentAgent = saved?.agents.find((agent) => agent.id === selected);
  const activeAgent = selected === null ? newDraft : currentAgent;
  const activeDraft = activeAgent ? getProfileDraft(drafts, activeAgent.sourceId) ?? catalogDraft(activeAgent) : null;
  const teamChanged = JSON.stringify(saved?.selections ?? emptyTeam) !== JSON.stringify(team);
  const dirtyCount = Object.keys(drafts).length + (newDraft ? 1 : 0);
  const unsaved = Boolean(dirtyCount || teamChanged || imported);

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(""); setConflict(false);
    void api<AgentCatalogState>(path, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) { setSaved(data); setTeam(data.selections ?? emptyTeam); setSelected((value) => data.agents.some((agent) => agent.id === value) ? value : data.agents[0]?.id ?? null); setNewDraft(null); setDrafts({}); setImported(null); pending.current = null; } })
      .catch((failure: unknown) => { if (!isAbort(failure)) { setSaved(null); setError(errorMessage(failure)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);
  useEffect(() => () => { abort.current?.abort(); fileSequence.current += 1; }, []);
  useNavigationGuard({ dirty: unsaved, busy: busy || reading });
  useEffect(() => {
    if (editorFocus.current && activeAgent) {
      editorFocus.current = false;
      document.getElementById("catalog-profile-heading")?.focus();
    }
  }, [activeAgent?.sourceId]);
  useEffect(() => { if (confirmation) confirmButton.current?.focus(); }, [confirmation]);

  async function mutate(change: { agents?: AgentCatalogDraft[]; selections?: CatalogSelections | null }, message: string, importing = false) {
    if (busy || !saved || !canManage || conflict) return false;
    const payload = { expectedVersion: saved.version, ...change };
    const fingerprint = JSON.stringify({ importing, payload });
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, requestId: crypto.randomUUID() };
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError(""); setNotice("");
    try {
      const data = await api<AgentCatalogState>(importing ? `${path}/import` : path, { method: importing ? "POST" : "PUT", body: { ...payload, requestId: pending.current.requestId }, signal: controller.signal });
      if (controller.signal.aborted) return false;
      setSaved(data); setConflict(false); setNotice(message); pending.current = null;
      // A team save must not erase a profile draft, or a profile save the unsaved team.
      if (change.selections !== undefined) setTeam(data.selections ?? emptyTeam);
      if (change.agents) {
        setDrafts((current) => {
          if (!importing) return acceptProfileChanges(current, change.agents!);
          const remaining = { ...current };
          for (const agent of change.agents!) delete remaining[agent.sourceId];
          return remaining;
        });
        if (newDraft && change.agents.some((agent) => agent.sourceId === newDraft.sourceId)) setNewDraft(null);
        if (!importing && change.agents.length === 1) setSelected(data.agents.find((agent) => agent.sourceId === change.agents![0].sourceId)?.id ?? null);
        else if (!activeAgent) setSelected(data.agents[0]?.id ?? null);
      }
      return true;
    } catch (failure) {
      if (!isAbort(failure)) {
        const changed = failure instanceof ApiError && [403, 409].includes(failure.status);
        setError(changed ? "A configuração ou sua permissão mudou. Seus rascunhos continuam nesta página. Recarregue o catálogo antes de salvar novamente." : errorMessage(failure));
        if (changed) setConflict(true);
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
  function selectAgent(id: string | null) { editorFocus.current = true; setSelected(id); setNotice(""); if (selected === id) requestAnimationFrame(() => document.getElementById("catalog-profile-heading")?.focus()); }
  function createAgent() {
    editorFocus.current = true; setSelected(null);
    if (!newDraft) setNewDraft({ sourceId: crypto.randomUUID(), name: "Novo agente", title: "", description: "", instructions: "", section: "Equipe", sourceEngine: "Veltram", sourceModel: "", sourceEffort: "" });
    else requestAnimationFrame(() => document.getElementById("catalog-profile-heading")?.focus());
  }
  function askConfirmation(action: CatalogConfirmation) {
    confirmationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmation(action);
  }
  function closeConfirmation() { setConfirmation(null); requestAnimationFrame(() => confirmationTrigger.current?.focus()); }
  async function importProfiles() {
    if (!imported) return;
    const ok = await mutate({ agents: imported }, `${imported.length} perfis importados. Os demais perfis e rascunhos foram preservados.`, true);
    if (ok) { setImported(null); closeConfirmation(); }
  }
  function exportProfiles() {
    if (!saved) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "veltram-agent-profiles", version: 1, agents: saved.agents.map(catalogDraft) }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "veltram-perfis-agentes.json"; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Perfis salvos exportados. Rascunhos ainda não salvos ficam apenas nesta página.");
  }
  function discardProfile() {
    if (!activeAgent) return;
    setDrafts((current) => { const next = { ...current }; delete next[activeAgent.sourceId]; return next; });
    if (selected === null) { setNewDraft(null); setSelected(saved?.agents[0]?.id ?? null); requestAnimationFrame(() => newButton.current?.focus()); }
  }
  const matches = saved?.agents.filter((agent) => matchesCatalogSearch(agent, search)) ?? [];
  const updates = imported?.filter((agent) => saved?.agents.some((current) => current.sourceId === agent.sourceId)).length ?? 0;
  const importOverwrites = imported?.filter((agent) => getProfileDraft(drafts, agent.sourceId) || newDraft?.sourceId === agent.sourceId) ?? [];

  return <div className="catalog-page">
    <PageHeading eyebrow="EQUIPE DA EMPRESA" title="Agentes">Escolha quem coordena, programa e revisa as tarefas de {organization.name}.</PageHeading>
    <nav className="catalog-sections" aria-label="Nesta página">{[["catalog-team-heading", "Equipe padrão"], ["catalog-heading", "Perfis dos agentes"], ["jev-heading", "Jev"]].map(([id, label]) => <button key={id} onClick={() => { const heading = document.getElementById(id); heading?.focus(); heading?.scrollIntoView({ block: "start" }); }}>{label}<Icon name="chevron" size={14} /></button>)}</nav>
    {!canManage && <Notice kind="info">Você pode consultar os perfis e a equipe. Alterações são feitas por administradores.</Notice>}
    {error && <Notice>{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
    {loading ? <Loading label="Carregando catálogo de agentes" /> : !saved ? <section className="catalog-empty"><h2>Não foi possível carregar os agentes</h2><p>Tente novamente para consultar a equipe desta empresa.</p><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></section> : <>
      {conflict && <div className="catalog-conflict"><button className="button secondary" disabled={busy} onClick={() => askConfirmation("reload")}>Recarregar catálogo</button></div>}
      {confirmation && <section className="catalog-confirm" aria-labelledby="catalog-confirm-title">
        <h2 id="catalog-confirm-title">{confirmation === "reload" ? "Recarregar e descartar rascunhos?" : confirmation === "team" ? "Restaurar a equipe inicial?" : "Substituir perfis em edição?"}</h2>
        <p>{confirmation === "reload" ? "As alterações de perfis, equipe e importação ainda não salvas serão descartadas. Os dados salvos serão carregados novamente." : confirmation === "team" ? "As próximas tarefas voltarão a usar os três agentes iniciais do Veltram. Tarefas já criadas mantêm sua equipe." : `O arquivo substituirá os rascunhos de: ${importOverwrites.map((agent) => agent.name).join(", ")}. Os demais rascunhos permanecem nesta página.`}</p>
        <div className="button-row"><button ref={confirmButton} className="button secondary" disabled={busy} onClick={closeConfirmation}>Continuar editando</button><button className="button secondary danger" disabled={busy} onClick={() => {
          if (confirmation === "reload") { setConfirmation(null); setAttempt((value) => value + 1); }
          else if (confirmation === "team") void mutate({ selections: null }, "A equipe inicial foi restaurada para as próximas tarefas.").then((ok) => { if (ok) closeConfirmation(); });
          else void importProfiles();
        }}>{busy ? "Aplicando…" : confirmation === "reload" ? "Descartar e recarregar" : confirmation === "team" ? "Restaurar equipe" : "Substituir e importar"}</button></div>
      </section>}
      <section className="catalog-team" aria-labelledby="catalog-team-heading"><header><div><p className="eyebrow">EQUIPE PADRÃO</p><h2 id="catalog-team-heading" tabIndex={-1}>Três papéis, uma entrega</h2></div><span className="catalog-count">{saved.selections ? "Perfis do catálogo" : "Equipe inicial do Veltram"}</span></header><p>A seleção é sugerida nas próximas tarefas. Cada tarefa preserva os perfis e as instruções usados na sua criação.</p>
        <form onSubmit={(event) => { event.preventDefault(); void mutate({ selections: team }, "Equipe padrão salva para as próximas tarefas."); }}><div className="catalog-role-grid">{roles.map((role, index) => <div key={role}><div className="catalog-role-title"><span aria-hidden="true">{index + 1}</span><label htmlFor={`catalog-role-${role}`}>{agentRoleNames[role]}</label></div><p>{roleDescriptions[role]}</p><select id={`catalog-role-${role}`} value={team[role]} disabled={!canManage || busy || conflict || !saved.agents.length} onChange={(event) => setTeam((current) => ({ ...current, [role]: event.target.value }))}><option value="">{saved.selections ? "Selecione um perfil" : `${agentRoleNames[role]} padrão`}</option>{saved.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div>)}</div>{canManage && <div className="catalog-team-actions"><span>{teamChanged ? "Equipe alterada. Salve para aplicar às próximas tarefas." : "Os perfis usam o modelo escolhido na tarefa."}</span><div className="button-row"><button className="button primary small" disabled={busy || conflict || !teamChanged || roles.some((role) => !team[role])}>Salvar equipe</button>{teamChanged && <button className="button secondary small" type="button" disabled={busy} onClick={() => setTeam(saved.selections ?? emptyTeam)}>Descartar seleção</button>}{saved.selections && <button className="text-button" type="button" disabled={busy || conflict} onClick={() => askConfirmation("team")}>Usar equipe inicial</button>}</div></div>}</form>
      </section>
      <section className="catalog-section" aria-labelledby="catalog-heading"><div className="catalog-section-heading"><div><h2 id="catalog-heading" tabIndex={-1}>Perfis dos agentes <span>{saved.agents.length}</span></h2><p>Especialidades, instruções e origem de cada perfil.</p></div><div className="button-row"><button className="button secondary small" disabled={!saved.agents.length} onClick={exportProfiles}>Exportar perfis salvos</button>{canManage && <button ref={newButton} className="button secondary small" disabled={busy || conflict || (!newDraft && saved.agents.length >= 100)} onClick={createAgent}><Icon name="plus" size={16} />{newDraft ? "Continuar novo perfil" : "Novo agente"}</button>}</div></div>
        {canManage && <details className="catalog-import"><summary>Importar perfis do OpenMausBot ou Veltram</summary><p>Confira os perfis antes de importar. Apenas nomes, descrições, instruções e origem são enviados. Chaves, sessões e histórico ficam de fora.</p><label className="field" htmlFor="catalog-file"><span>Arquivo de perfis (.json, até 2 MiB)</span><input id="catalog-file" type="file" accept=".json,application/json" disabled={busy || conflict || reading} onChange={(event) => { void readImport(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>{reading && <p role="status">Lendo perfis…</p>}{imported && <div className="catalog-import-preview"><h3>Conferir {imported.length} perfis</h3><p>{fileName} · {imported.length - updates} novos · {updates} existentes serão atualizados pelo identificador de origem.</p><ul>{imported.map((agent) => <li key={agent.sourceId}><strong>{agent.name}</strong><span>{agent.sourceEngine || "Origem não informada"}{agent.sourceModel ? ` · ${agent.sourceModel}` : ""}</span></li>)}</ul><div className="button-row"><button className="button primary" disabled={busy || conflict} onClick={() => importOverwrites.length ? askConfirmation("import") : void importProfiles()}>{busy ? "Importando…" : `Importar ${imported.length} perfis`}</button><button className="button secondary" disabled={busy} onClick={() => { setImported(null); document.getElementById("catalog-file")?.focus(); }}>Cancelar importação</button></div></div>}</details>}
        {dirtyCount > 0 && <p className="catalog-draft-note" role="status">{dirtyCount === 1 ? "1 perfil com alterações não salvas." : `${dirtyCount} perfis com alterações não salvas.`} Você pode alternar entre os perfis. Os rascunhos ficam apenas nesta página.</p>}
        {!saved.agents.length && !newDraft ? <div className="catalog-empty"><Icon name="team" size={30} /><h3>Seu catálogo começa aqui</h3><p>{canManage ? "Importe perfis do OpenMausBot ou crie um agente para montar sua equipe." : "Um administrador pode importar ou criar perfis para esta empresa."} A equipe inicial continua disponível para novas tarefas.</p>{canManage && <button className="button secondary" onClick={createAgent}>Criar primeiro agente</button>}</div> : <div className="catalog-layout"><aside className="catalog-list"><div className="field"><label htmlFor="catalog-search">Buscar agente</label><input id="catalog-search" type="search" placeholder="Nome, título ou seção" value={search} onChange={(event) => setSearch(event.target.value)} /></div><p className="catalog-search-count" aria-live="polite">{matches.length} de {saved.agents.length} perfis</p><ul aria-label="Perfis do catálogo">{newDraft && <li><button className={selected === null ? "selected" : ""} aria-pressed={selected === null} disabled={busy} onClick={() => selectAgent(null)}><strong>{newDraft.name}</strong><span className="catalog-unsaved">Novo perfil não salvo</span></button></li>}{matches.map((agent) => <li key={agent.id}><button className={selected === agent.id ? "selected" : ""} aria-pressed={selected === agent.id} disabled={busy} onClick={() => selectAgent(agent.id)}><strong>{agent.name}</strong><span>{agent.title || agent.section || "Perfil de agente"}</span>{getProfileDraft(drafts, agent.sourceId) ? <small className="catalog-unsaved">Alterações não salvas</small> : <small>{agent.sourceEngine || "Origem não informada"}{agent.sourceModel ? ` · ${agent.sourceModel}` : ""}</small>}</button></li>)}</ul>{!matches.length && <div className="catalog-no-matches"><p>Nenhum perfil corresponde a “{search}”.</p><button className="text-button" onClick={() => { setSearch(""); document.getElementById("catalog-search")?.focus(); }}>Limpar busca</button></div>}</aside><div>{activeAgent && activeDraft ? <ProfileEditor key={activeAgent.sourceId} agent={activeAgent} draft={activeDraft} isNew={selected === null} dirty={selected === null || Boolean(getProfileDraft(drafts, activeAgent.sourceId))} busy={busy} canManage={canManage && !conflict} onChange={(next) => { if (selected === null) setNewDraft(next); else setDrafts((current) => updateProfileDraft(current, catalogDraft(activeAgent), next)); }} onSave={(draft) => mutate({ agents: [draft] }, "Perfil salvo. Tarefas já criadas preservam as instruções anteriores.")} onDiscard={discardProfile} /> : <p className="catalog-empty">Selecione um perfil para consultar as instruções.</p>}</div></div>}
      </section>
    </>}
    <JevSettings organization={organization} />
  </div>;
}
function ProfileEditor({ agent, draft, isNew, dirty, busy, canManage, onChange, onSave, onDiscard }: { agent: AgentCatalogDraft | CatalogAgent; draft: AgentCatalogDraft; isNew: boolean; dirty: boolean; busy: boolean; canManage: boolean; onChange: (draft: AgentCatalogDraft) => void; onSave: (draft: AgentCatalogDraft) => Promise<boolean>; onDiscard: () => void }) {
  const [error, setError] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const keepButton = useRef<HTMLButtonElement>(null);
  const discardButton = useRef<HTMLButtonElement>(null);
  const bytes = instructionBytes(draft.instructions);
  useEffect(() => { if (discarding) keepButton.current?.focus(); }, [discarding]);
  function update(field: "name" | "title" | "section" | "description" | "instructions", value: string) { onChange({ ...draft, [field]: value }); setError(""); }
  function save(event: FormEvent) { event.preventDefault(); try { const [validated] = validateCatalogProfiles([draft]); void onSave(validated).then((ok) => { if (ok) { setDiscarding(false); document.getElementById("catalog-profile-heading")?.focus(); } }); } catch (failure) { setError(failure instanceof Error ? failure.message : "Confira os campos do perfil."); } }
  return <form className="catalog-editor form-stack" onSubmit={save} aria-labelledby="catalog-profile-heading"><header><p className="eyebrow">{isNew ? "NOVO PERFIL" : "PERFIL DO AGENTE"}</p><h3 id="catalog-profile-heading" tabIndex={-1}>{isNew ? "Novo agente" : agent.name}</h3><span className="field-hint">{"revision" in agent ? `Revisão ${agent.revision} salva` : "Ainda não adicionado ao catálogo"}{dirty ? " · Alterações não salvas" : ""}</span></header><details className="catalog-origin-details"><summary>Origem do perfil</summary><dl className="catalog-origin"><div><dt>Motor</dt><dd>{agent.sourceEngine || "Não informado"}</dd></div><div><dt>Modelo</dt><dd>{agent.sourceModel || "Não informado"}</dd></div>{agent.sourceEffort && <div><dt>Esforço</dt><dd>{agent.sourceEffort}</dd></div>}</dl><p className="field-hint">A origem é uma referência. A execução usa a conexão e o modelo escolhidos na tarefa.</p></details>{error && <Notice>{error}</Notice>}<div className="form-pair"><div className="field"><label htmlFor="catalog-name">Nome</label><input id="catalog-name" required maxLength={100} value={draft.name} disabled={!canManage || busy} onChange={(event) => update("name", event.target.value)} /></div><div className="field"><label htmlFor="catalog-section">Seção</label><input id="catalog-section" maxLength={100} value={draft.section} disabled={!canManage || busy} onChange={(event) => update("section", event.target.value)} /></div></div><div className="field"><label htmlFor="catalog-title">Especialidade ou título</label><input id="catalog-title" maxLength={200} value={draft.title} disabled={!canManage || busy} onChange={(event) => update("title", event.target.value)} /></div><div className="field"><label htmlFor="catalog-description">Descrição</label><textarea id="catalog-description" rows={3} maxLength={4000} value={draft.description} disabled={!canManage || busy} onChange={(event) => update("description", event.target.value)} /></div><div className="field"><label htmlFor="catalog-instructions">Instruções</label><textarea id="catalog-instructions" rows={10} maxLength={20000} aria-describedby="catalog-instruction-limit" aria-invalid={bytes > 20000} value={draft.instructions} disabled={!canManage || busy} onChange={(event) => update("instructions", event.target.value)} /><p id="catalog-instruction-limit" className={`field-hint${bytes > 20000 ? " catalog-limit-error" : ""}`}>{bytes.toLocaleString("pt-BR")} / 20.000 bytes. Acentos e símbolos podem ocupar mais de um byte. Quando vazio, a descrição orienta o agente.</p></div>{canManage && <div className="catalog-editor-actions"><div className="button-row"><button className="button primary" disabled={busy || !dirty || bytes > 20000}>{busy ? "Salvando…" : "Salvar perfil"}</button><button ref={discardButton} className="button secondary" type="button" disabled={busy || !dirty} onClick={() => setDiscarding(true)}>{isNew ? "Cancelar novo perfil" : "Descartar alterações"}</button></div>{discarding && <div className="catalog-confirm" role="group" aria-labelledby="profile-discard-title"><h4 id="profile-discard-title">Descartar {isNew ? "este novo perfil" : "as alterações deste perfil"}?</h4><p>Os campos ainda não salvos serão perdidos. Os demais perfis permanecem como estão.</p><div className="button-row"><button ref={keepButton} type="button" className="button secondary" disabled={busy} onClick={() => { setDiscarding(false); discardButton.current?.focus(); }}>Continuar editando</button><button type="button" className="button secondary danger" disabled={busy} onClick={() => { onDiscard(); setDiscarding(false); setError(""); requestAnimationFrame(() => document.getElementById("catalog-profile-heading")?.focus()); }}>{isNew ? "Descartar novo perfil" : "Descartar alterações"}</button></div></div>}</div>}</form>;
}
