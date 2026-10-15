import { useEffect, useId, useRef, useState } from "react";
import { api, errorMessage, isAbort, organizationPath, type Organization } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { safeGithubAuthorizationUrl } from "./coding-state";
import { useNavigationGuard } from "./navigation-guard";
import "./repositories.css";

export interface RepositoryConnection {
  id: string; repositoryId: number; installationId: number; fullName: string; defaultBranch: string; status: "active" | "revoked";
}
export interface GithubState {
  configured: boolean; connections: RepositoryConnection[];
  pending: { installations: { id: number; account: string; repositories: { id: number; fullName: string; defaultBranch: string }[] }[] } | null;
  installUrl: string | null;
}

const canManageRepositories = (organization: Organization) => organization.role === "owner" || organization.role === "admin";

export function Repositories({ organization }: { organization: Organization }) {
  return <RepositoriesContent key={organization.id} organization={organization} />;
}

function RepositoriesContent({ organization }: { organization: Organization }) {
  const path = `${organizationPath(organization.id)}/github`;
  const [state, setState] = useState<GithubState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const message = useRef<HTMLDivElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const canManage = canManageRepositories(organization);
  const pending = loading || busy !== null || redirectUrl !== null;
  const disabled = pending || Boolean(error);
  const installUrl = state?.installUrl ? safeGithubAuthorizationUrl(state.installUrl) : null;
  useNavigationGuard({ busy: busy !== null });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api<GithubState>(path, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setState(data); })
      .catch((failure: unknown) => { if (!controller.signal.aborted && !isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if ((error || notice) && !loading && !busy) message.current?.focus(); }, [error, notice, loading, busy]);
  // Navigate after the pending guard has cleared, without a misleading unsaved-work prompt.
  useEffect(() => {
    if (!redirectUrl) return;
    try { window.location.assign(redirectUrl); }
    catch { setRedirectUrl(null); setError("Não foi possível abrir o GitHub. Tente novamente."); }
  }, [redirectUrl]);

  function refresh() {
    if (pending) return;
    region.current?.focus();
    setNotice(""); setRemoving(null); setAttempt((value) => value + 1);
  }

  async function connect() {
    if (disabled || abort.current || !canManage) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy("connect"); setError(""); setNotice(""); setRemoving(null);
    try {
      const data = await api<{ url: string }>(`${path}/connect`, { method: "POST", body: {}, signal: controller.signal });
      if (controller.signal.aborted) return;
      const url = safeGithubAuthorizationUrl(data.url);
      if (!url) throw new Error("Invalid GitHub authorization URL");
      setRedirectUrl(url);
    } catch (failure) { if (!controller.signal.aborted && !isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) { abort.current = null; setBusy(null); } }
  }

  async function selectRepository(installationId: number, repositoryId: number) {
    if (disabled || abort.current || !canManage) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(`select-${installationId}-${repositoryId}`); setError(""); setNotice(""); setRemoving(null);
    try {
      const { connection } = await api<{ connection: RepositoryConnection }>(`${path}/repositories`, { method: "POST", body: { installationId, repositoryId }, signal: controller.signal });
      if (controller.signal.aborted) return;
      setState((current) => current && { ...current, connections: [connection, ...current.connections.filter((item) => item.id !== connection.id)] });
      setNotice(`${connection.fullName} foi conectado a ${organization.name}.`);
    } catch (failure) { if (!controller.signal.aborted && !isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) { abort.current = null; setBusy(null); } }
  }

  async function remove(connection: RepositoryConnection) {
    if (disabled || abort.current || !canManage) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(connection.id); setError(""); setNotice("");
    try {
      await api(`${path}/repositories/${encodeURIComponent(connection.id)}`, { method: "DELETE", body: {}, signal: controller.signal });
      if (controller.signal.aborted) return;
      setState((current) => current && { ...current, connections: current.connections.map((item) => item.id === connection.id ? { ...item, status: "revoked" } : item) });
      setRemoving(null); setNotice(`${connection.fullName} foi desconectado de ${organization.name}.`);
    } catch (failure) { if (!controller.signal.aborted && !isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) { abort.current = null; setBusy(null); } }
  }

  return <div ref={region} className="repositories-page" tabIndex={-1}>
    <PageHeading eyebrow="CÓDIGO DA EMPRESA" title="Repositórios">Escolha os repositórios que os agentes de {organization.name} podem usar.</PageHeading>
    <div className="repositories-toolbar"><span><Icon name="repository" />GitHub</span><button className="text-button" disabled={pending} onClick={refresh}><Icon name="refresh" size={16} />{loading ? "Atualizando…" : "Atualizar"}</button></div>
    {(error || notice) && <div ref={message} className="repository-feedback" tabIndex={-1}>
      {error ? <Notice><strong>{state ? "Não foi possível confirmar a atualização." : "Não foi possível consultar os repositórios."}</strong><p>{error}</p>{state && <p>Os vínculos exibidos são os últimos confirmados. Atualize antes de tentar novamente.</p>}<button className="button secondary small" disabled={pending} onClick={refresh}>Tentar novamente</button></Notice> : <Notice kind="success">{notice}</Notice>}
    </div>}
    {loading && !state ? <Loading label="Carregando repositórios" /> : state && <>
      {loading && <p className="repository-updating" role="status">Consultando os vínculos atuais no GitHub…</p>}
      <RepositoryConnections organization={organization} connections={state.connections} configured={state.configured} disabled={disabled} busy={busy} removing={removing} onRequestRemove={(id) => { setError(""); setNotice(""); setRemoving(id); }} onDismiss={() => { setRemoving(null); if (error) message.current?.focus(); }} onRemove={(connection) => void remove(connection)} />
      {!canManage && <Notice kind="info">Somente administradores de {organization.name} podem conectar ou desconectar repositórios.</Notice>}
      {!state.configured ? <div className="connection-message"><Icon name="repository" size={24} /><div><h3>A conexão com o GitHub está em preparação</h3><p>O responsável pela Veltram precisa concluir a configuração do aplicativo no GitHub. Os repositórios poderão ser conectados assim que ela estiver pronta.</p></div></div> : canManage && <section className="repository-authorization" aria-labelledby="repository-authorization-title">
        <div className="github-connect"><div><h2 id="repository-authorization-title">Adicionar repositórios</h2><p>Autorize sua conta no GitHub e escolha os repositórios para {organization.name}. Você confere as permissões antes de continuar.</p></div><button className="button primary" disabled={disabled} onClick={() => void connect()}>{busy === "connect" || redirectUrl ? "Abrindo GitHub…" : state.pending ? "Atualizar autorização" : "Autorizar no GitHub"}<Icon name="arrow" /></button></div>
        {state.pending && <section className="repository-selection" aria-labelledby="repository-selection-title"><h3 id="repository-selection-title">Disponíveis para conectar</h3><p>Somente os repositórios que você conectar ficam disponíveis às tarefas desta empresa.</p>
          <RepositoryChoices installations={state.pending.installations} connections={state.connections} disabled={disabled} busy={busy} onSelect={(installationId, repositoryId) => void selectRepository(installationId, repositoryId)} />
          {installUrl && <div className="repository-access-help"><p>Não encontrou um repositório? Confira a seleção de acesso no GitHub e depois atualize a autorização acima.</p><a className="text-button" href={installUrl} target="_blank" rel="noopener noreferrer">Selecionar repositórios no GitHub<span className="sr-only"> (abre em nova aba)</span><Icon name="arrow" size={15} /></a></div>}
        </section>}
      </section>}
    </>}
  </div>;
}

type ConnectionProps = {
  organization: Organization; connections: RepositoryConnection[]; configured?: boolean; disabled: boolean; busy: string | null; removing: string | null;
  onRequestRemove: (id: string) => void; onDismiss: () => void; onRemove: (connection: RepositoryConnection) => void;
};

export function RepositoryConnections(props: ConnectionProps) {
  const { organization, connections, configured = true } = props;
  const activeCount = connections.filter((connection) => connection.status === "active").length;
  return <section className="connected-repositories" aria-labelledby="connected-repositories-title">
    <div className="repository-section-heading"><h2 id="connected-repositories-title">Vínculos de {organization.name}</h2><p>{activeCount === 0 ? "Nenhum repositório disponível para novas tarefas" : `${activeCount} ${activeCount === 1 ? "repositório disponível" : "repositórios disponíveis"} para novas tarefas`}</p></div>
    {connections.length === 0 ? <div className="empty-state"><Icon name="repository" size={28} /><h3>Nenhum repositório conectado</h3><p>{!configured ? "A conexão com o GitHub precisa estar disponível para adicionar o primeiro repositório." : canManageRepositories(organization) ? "Autorize o acesso ao GitHub abaixo e escolha um repositório para começar." : "Peça a um administrador da empresa para conectar o primeiro repositório."}</p></div> : <div className="repository-list">{connections.map((connection) => <RepositoryEntry key={connection.id} {...props} connection={connection} />)}</div>}
  </section>;
}

function RepositoryEntry({ connection, organization, disabled, busy, removing, onRequestRemove, onDismiss, onRemove }: ConnectionProps & { connection: RepositoryConnection }) {
  const removeButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const confirmTitle = useId();
  const open = removing === connection.id;
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && busy) confirmation.current?.focus();
    else if (open) keepButton.current?.focus();
    else if (wasOpen.current && !busy) removeButton.current?.focus();
    wasOpen.current = open;
  }, [open, busy]);
  return <div className="repository-entry">
    <div className="repository-row"><div><h3>{connection.fullName}</h3><p>Branch padrão: <span className="mono">{connection.defaultBranch}</span></p></div><span className={`status-pill ${connection.status === "active" ? "saved" : "neutral"}`}><span />{connection.status === "active" ? "Conectado" : "Acesso removido"}</span>{canManageRepositories(organization) && connection.status === "active" && <button ref={removeButton} className="text-button danger-text" disabled={disabled} aria-expanded={open} aria-label={`Desconectar ${connection.fullName}`} onClick={() => onRequestRemove(connection.id)}>Desconectar</button>}</div>
    {open && <div ref={confirmation} className="inline-confirm repository-confirm" role="group" tabIndex={-1} aria-busy={busy === connection.id} aria-labelledby={confirmTitle} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); onDismiss(); } }}><h4 id={confirmTitle}>Desconectar {connection.fullName}?</h4><p>Novas tarefas de {organization.name} não poderão usar este repositório. As branches e os PRs já criados continuam no GitHub.</p><div className="button-row"><button ref={keepButton} className="button secondary small" disabled={busy !== null} onClick={onDismiss}>Manter conexão</button><button className="button danger small" disabled={disabled} onClick={() => onRemove(connection)}>{busy === connection.id ? "Desconectando…" : "Confirmar desconexão"}</button></div></div>}
  </div>;
}

export function RepositoryChoices({ installations, connections, disabled, busy, onSelect }: { installations: NonNullable<GithubState["pending"]>["installations"]; connections: RepositoryConnection[]; disabled: boolean; busy: string | null; onSelect: (installationId: number, repositoryId: number) => void }) {
  if (installations.length === 0) return <p className="repository-empty-choices">Nenhuma instalação autorizada foi encontrada. Instale o aplicativo na conta que possui os repositórios e depois atualize a autorização.</p>;
  return <>{installations.map((installation) => <div className="installation-group" key={installation.id}><h4 className="installation-account">Conta GitHub: {installation.account}</h4>{installation.repositories.length === 0 ? <p className="repository-empty-choices">Nenhum repositório disponível nesta instalação. Confira a seleção de acesso no GitHub.</p> : installation.repositories.map((repository) => {
    const connected = connections.some((connection) => connection.installationId === installation.id && connection.repositoryId === repository.id && connection.status === "active");
    return <div className="repository-row" key={repository.id}><div><h4>{repository.fullName}</h4><p>Branch padrão: <span className="mono">{repository.defaultBranch}</span></p></div>{connected ? <span className="status-pill saved"><Icon name="check" size={14} />Já conectado</span> : <button className="button secondary small" disabled={disabled} aria-label={`Conectar ${repository.fullName}`} onClick={() => onSelect(installation.id, repository.id)}>{busy === `select-${installation.id}-${repository.id}` ? "Conectando…" : "Conectar"}</button>}</div>;
  })}</div>)}</>;
}
