import { useEffect, useRef, useState } from "react";
import { api, errorMessage, isAbort, organizationPath, type Organization, type Workspace } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { Credentials } from "./credentials";
import { Runs } from "./runs";
import { Coding } from "./coding";
import { Repositories } from "./repositories";
import { Agents } from "./agents";
import { Reports } from "./reports";
import { BrowserTasks } from "./browser";
import { Marketplace } from "./marketplace";
import { Missions } from "./missions";
import { canLeavePage } from "./navigation-guard";
import "./company-execution.css";

export type Section = "missions" | "browser" | "marketplace" | "reports" | "coding" | "repositories" | "agents" | "runs" | "credentials" | "company";
const roleNames = { owner: "Responsável", admin: "Administrador", member: "Membro" };

export function OrganizationSpace({ organization, section, onNavigate }: { organization: Organization; section: Section; onNavigate: (section: Section) => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api<{ workspaces: Workspace[] }>(`${organizationPath(organization.id)}/workspaces`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setWorkspaces(data.workspaces);
        setWorkspaceId((current) => data.workspaces.some((workspace) => workspace.id === current) ? current : data.workspaces[0]?.id ?? "");
      })
      .catch((failure: unknown) => { if (!isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [organization.id, attempt]);

  if (section === "reports") return <Reports organization={organization} />;
  if (section === "browser") return <BrowserTasks organization={organization} />;
  if (section === "marketplace") return <Marketplace key={organization.id} organization={organization} />;
  if (section === "credentials") return <Credentials organization={organization} />;
  if (section === "repositories") return <Repositories organization={organization} />;
  if (section === "agents") return <Agents organization={organization} />;
  if (section === "company") return <CompanyContext organization={organization} workspaces={workspaces} loading={loading} error={error} onRetry={() => setAttempt((value) => value + 1)} onNavigate={onNavigate} />;
  if (loading) return <Loading label="Carregando espaço de trabalho" />;
  if (error) return <><Notice>{error}</Notice><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></>;
  if (!workspaceId) return <><PageHeading eyebrow="SEU ESPAÇO" title="Nenhum espaço de trabalho disponível">Não encontramos um espaço para esta empresa. Atualize os dados ou fale com o responsável.</PageHeading><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Atualizar</button></>;
  return <>
    {workspaces.length > 1 && <div className="workspace-picker field"><label htmlFor="active-workspace">Espaço de trabalho</label><select id="active-workspace" value={workspaceId} onChange={(event) => { const nextWorkspaceId = event.target.value; if (nextWorkspaceId !== workspaceId) void canLeavePage().then((leave) => { if (leave) setWorkspaceId(nextWorkspaceId); }); }}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></div>}
    {section === "missions" ? <Missions key={workspaceId} organization={organization} workspaceId={workspaceId} onNavigate={onNavigate} /> : section === "coding" ? <Coding key={workspaceId} organizationId={organization.id} workspaceId={workspaceId} onNavigate={onNavigate} /> : <Runs key={workspaceId} organizationId={organization.id} workspaceId={workspaceId} />}
  </>;
}

export function CompanyContext({ organization, workspaces, loading, error, onRetry, onNavigate }: { organization: Organization; workspaces: Workspace[]; loading: boolean; error: string; onRetry: () => void; onNavigate: (section: Section) => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  return <>
    <PageHeading eyebrow="SEU CONTEXTO" title="Empresa">As informações do espaço em que você está trabalhando.</PageHeading>
    <h2 className="sr-only" ref={heading} tabIndex={-1}>Informações de {organization.name}</h2>
    <dl className="company-details"><div><dt>Nome da empresa</dt><dd>{organization.name}</dd></div><div><dt>Seu acesso</dt><dd>{roleNames[organization.role]}</dd></div><div><dt>Espaços de trabalho</dt><dd aria-busy={loading}>{loading ? <span role="status">Carregando espaços…</span> : error ? "Não foi possível consultar" : workspaces.length > 0 ? <ul className="company-workspaces">{workspaces.map((workspace) => <li key={workspace.id}>{workspace.name}</li>)}</ul> : "Nenhum espaço disponível"}</dd></div></dl>
    {error && <div className="company-load-error"><Notice>{error}</Notice><button className="button secondary" disabled={loading} onClick={() => { heading.current?.focus(); onRetry(); }}>Tentar novamente</button></div>}
    {!loading && !error && workspaces.length === 0 && <p className="company-context-note">Atualize os dados ou fale com o responsável pela empresa para verificar o acesso a um espaço de trabalho. <button className="text-button" onClick={() => { heading.current?.focus(); onRetry(); }}>Atualizar espaços</button></p>}
    <section className="company-setup" aria-labelledby="company-setup-heading"><h2 id="company-setup-heading">Configuração do espaço</h2><p className="muted">Conexões e perfis pertencem a {organization.name}. As permissões da sua conta são aplicadas em cada área.</p><div className="company-setup-links">
      <button onClick={() => onNavigate("repositories")}><Icon name="repository" size={22} /><span><strong>Repositórios</strong><span>Confira o código autorizado para as tarefas.</span></span><Icon name="arrow" /></button>
      <button onClick={() => onNavigate("agents")}><Icon name="team" size={22} /><span><strong>Agentes e equipe</strong><span>Defina os perfis que coordenam, programam e revisam.</span></span><Icon name="arrow" /></button>
      <button onClick={() => onNavigate("credentials")}><Icon name="key" size={22} /><span><strong>Conexões de IA</strong><span>Gerencie chaves, assinaturas e orçamento.</span></span><Icon name="arrow" /></button>
    </div></section>
  </>;
}
