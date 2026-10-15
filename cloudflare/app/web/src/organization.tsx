import { useEffect, useState } from "react";
import { api, errorMessage, isAbort, organizationPath, type Organization, type Workspace } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { Credentials } from "./credentials";
import { Runs } from "./runs";
import { Coding } from "./coding";
import { Repositories } from "./repositories";
import { Agents } from "./agents";

export type Section = "coding" | "repositories" | "agents" | "runs" | "credentials" | "company";
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

  if (section === "credentials") return <Credentials organization={organization} />;
  if (section === "repositories") return <Repositories organization={organization} />;
  if (section === "agents") return <Agents organization={organization} />;
  if (section === "company") return <>
    <PageHeading eyebrow="SEU CONTEXTO" title="Empresa">As informações do espaço em que você está trabalhando.</PageHeading>
    <dl className="company-details"><div><dt>Nome da empresa</dt><dd>{organization.name}</dd></div><div><dt>Seu acesso</dt><dd>{roleNames[organization.role]}</dd></div><div><dt>Espaços de trabalho</dt><dd>{loading ? "Carregando…" : workspaces.length > 0 ? workspaces.map((workspace) => workspace.name).join(", ") : "Nenhum espaço disponível"}</dd></div></dl>
    {error && <Notice>{error}</Notice>}
    <section className="company-next"><div><Icon name="key" size={22} /><div><h2>Chaves da empresa</h2><p className="muted">Cadastre e gerencie os provedores de IA deste espaço.</p></div></div><button className="button secondary" onClick={() => onNavigate("credentials")}>Gerenciar chaves<Icon name="arrow" /></button></section>
  </>;
  if (loading) return <Loading label="Carregando espaço de trabalho" />;
  if (error) return <><Notice>{error}</Notice><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></>;
  if (!workspaceId) return <><PageHeading eyebrow="SEU ESPAÇO" title="Nenhum espaço de trabalho disponível">Não encontramos um espaço para esta empresa. Atualize os dados ou fale com o responsável.</PageHeading><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Atualizar</button></>;
  return <>
    {workspaces.length > 1 && <div className="workspace-picker field"><label htmlFor="active-workspace">Espaço de trabalho</label><select id="active-workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></div>}
    {section === "coding" ? <Coding key={workspaceId} organizationId={organization.id} workspaceId={workspaceId} onNavigate={onNavigate} /> : <Runs key={workspaceId} organizationId={organization.id} workspaceId={workspaceId} />}
  </>;
}
