import { useEffect, useRef, useState } from "react";
import { api, errorMessage, isAbort, organizationPath, type Organization } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { safeGithubAuthorizationUrl } from "./coding-state";

export interface RepositoryConnection {
  id: string; repositoryId: number; installationId: number; fullName: string; defaultBranch: string; status: "active" | "revoked";
}
export interface GithubState {
  configured: boolean; connections: RepositoryConnection[];
  pending: { installations: { id: number; account: string; repositories: { id: number; fullName: string; defaultBranch: string }[] }[] } | null;
  installUrl: string | null;
}

export function Repositories({ organization }: { organization: Organization }) {
  const path = `${organizationPath(organization.id)}/github`;
  const [state, setState] = useState<GithubState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const canManage = organization.role !== "member";
  const installUrl = state?.installUrl ? safeGithubAuthorizationUrl(state.installUrl) : null;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api<GithubState>(path, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setState(data); })
      .catch((failure: unknown) => { if (!isAbort(failure)) { setState(null); setError(errorMessage(failure)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);
  useEffect(() => () => abort.current?.abort(), []);

  async function connect() {
    if (busy) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy("connect"); setError(""); setNotice("");
    try {
      const data = await api<{ url: string }>(`${path}/connect`, { method: "POST", body: {}, signal: controller.signal });
      if (controller.signal.aborted) return;
      const url = safeGithubAuthorizationUrl(data.url);
      if (!url) throw new Error("Invalid GitHub authorization URL");
      window.location.assign(url);
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(null); }
  }

  async function selectRepository(installationId: number, repositoryId: number) {
    if (busy) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(`select-${repositoryId}`); setError(""); setNotice("");
    try {
      await api(`${path}/repositories`, { method: "POST", body: { installationId, repositoryId }, signal: controller.signal });
      if (!controller.signal.aborted) { setNotice("Repositório conectado a esta empresa."); setAttempt((value) => value + 1); }
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(null); }
  }

  async function remove(connection: RepositoryConnection) {
    if (busy) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(connection.id); setError(""); setNotice("");
    try {
      await api(`${path}/repositories/${encodeURIComponent(connection.id)}`, { method: "DELETE", body: {}, signal: controller.signal });
      if (!controller.signal.aborted) { setRemoving(null); setNotice("Conexão removida desta empresa."); setAttempt((value) => value + 1); }
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(null); }
  }

  return <>
    <PageHeading eyebrow="CÓDIGO DA EMPRESA" title="Repositórios">Escolha os repositórios que os agentes de {organization.name} podem usar.</PageHeading>
    <div className="section-heading"><h2>GitHub</h2><button className="text-button" disabled={loading || busy !== null} onClick={() => setAttempt((value) => value + 1)}><Icon name="refresh" size={15} />Atualizar</button></div>
    {error && <Notice>{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
    {loading ? <Loading label="Carregando repositórios" /> : state && <>
      {!state.configured ? <div className="connection-message"><Icon name="repository" size={24} /><div><h3>A conexão com o GitHub está em preparação</h3><p>O responsável pela Veltram precisa concluir a configuração do aplicativo no GitHub. Os repositórios poderão ser conectados assim que ela estiver pronta.</p></div></div> : <>
        {canManage ? <div className="github-connect"><div><h3>Conecte sua conta do GitHub</h3><p>Confirme sua conta e selecione os repositórios autorizados para esta empresa. O GitHub mostra as permissões antes de você continuar.</p></div><button className="button primary" disabled={busy !== null} onClick={() => void connect()}>{busy === "connect" ? "Abrindo GitHub…" : state.pending ? "Atualizar acesso" : "Conectar GitHub"}<Icon name="arrow" /></button></div> : <Notice kind="info">Um administrador da empresa pode conectar e remover repositórios.</Notice>}
        {canManage && state.pending && <section className="repository-selection" aria-labelledby="repository-selection-title"><h3 id="repository-selection-title">Disponíveis para conectar</h3>
          {state.pending.installations.length === 0 && <p className="muted">Nenhuma instalação autorizada foi encontrada. Instale o aplicativo na conta do GitHub que possui os repositórios e depois atualize o acesso.</p>}
          {state.pending.installations.map((installation) => <div className="installation-group" key={installation.id}><p className="installation-account">{installation.account}</p>{installation.repositories.length === 0 ? <p className="muted">Nenhum repositório disponível nesta instalação.</p> : installation.repositories.map((repository) => {
            const connected = state.connections.some((connection) => connection.repositoryId === repository.id && connection.status === "active");
            return <div className="repository-row" key={repository.id}><div><h4>{repository.fullName}</h4><p>Branch padrão: <span className="mono">{repository.defaultBranch}</span></p></div>{connected ? <span className="status-pill saved"><span />Conectado</span> : <button className="button secondary small" disabled={busy !== null} onClick={() => void selectRepository(installation.id, repository.id)}>{busy === `select-${repository.id}` ? "Conectando…" : "Conectar"}</button>}</div>;
          })}</div>)}
          {installUrl && <a className="text-button" href={installUrl} target="_blank" rel="noopener noreferrer">Selecionar repositórios no GitHub<Icon name="arrow" size={15} /></a>}
        </section>}
      </>}
      <section className="connected-repositories" aria-labelledby="connected-repositories-title"><h2 id="connected-repositories-title">Conectados a {organization.name}</h2>
        {state.connections.length === 0 ? <div className="empty-state"><Icon name="repository" size={26} /><h3>Nenhum repositório conectado</h3><p>Os repositórios escolhidos aparecerão aqui e ficarão disponíveis ao criar uma tarefa.</p></div> : <div className="repository-list">{state.connections.map((connection) => <div className="repository-entry" key={connection.id}><div className="repository-row"><div><h3>{connection.fullName}</h3><p>Branch padrão: <span className="mono">{connection.defaultBranch}</span></p></div><span className={`status-pill ${connection.status === "active" ? "saved" : "neutral"}`}><span />{connection.status === "active" ? "Conectado" : "Acesso removido"}</span>{canManage && connection.status === "active" && <button className="text-button danger-text" disabled={busy !== null} onClick={() => setRemoving(connection.id)}>Remover</button>}</div>
          {removing === connection.id && <div className="inline-confirm repository-confirm"><h4>Remover esta conexão?</h4><p>Novas tarefas não poderão usar este repositório. As branches e os PRs já criados continuam no GitHub.</p><div className="button-row"><button className="button danger small" disabled={busy !== null} onClick={() => void remove(connection)}>{busy === connection.id ? "Removendo…" : "Remover conexão"}</button><button className="button secondary small" disabled={busy !== null} onClick={() => setRemoving(null)}>Manter</button></div></div>}
        </div>)}</div>}
      </section>
    </>}
  </>;
}
