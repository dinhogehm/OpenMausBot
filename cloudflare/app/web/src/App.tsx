import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, errorMessage, isAbort, type Organization, type User } from "./api";
import { SignIn } from "./auth";
import { Brand, Icon, Loading, Notice, PageHeading } from "./components";
import { OrganizationSpace, type Section } from "./organization";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setChecking(true); setError("");
    void api<{ user: User }>("/api/session", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setUser(data.user); })
      .catch((failure: unknown) => { if (!isAbort(failure) && !(failure instanceof ApiError && failure.status === 401)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const endSession = () => { setExpired(Boolean(user)); setUser(null); };
    window.addEventListener("veltram:session-expired", endSession);
    return () => window.removeEventListener("veltram:session-expired", endSession);
  }, [user]);

  if (checking) return <main className="initial-state"><Brand /><Loading label="Conferindo seu acesso" /></main>;
  if (error) return <main className="initial-state"><Brand /><Notice>{error}</Notice><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></main>;
  if (!user) return <SignIn expired={expired} onSignIn={(next) => { setExpired(false); setUser(next); }} />;
  return <Shell key={user.id} user={user} onSignOut={() => { setExpired(false); setUser(null); }} />;
}

function Shell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [section, setSection] = useState<Section>("runs");
  const [creating, setCreating] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [reload, setReload] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const active = organizations.find((organization) => organization.id === activeId);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api<{ organizations: Organization[] }>("/api/organizations", { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setOrganizations(data.organizations);
        setActiveId((current) => data.organizations.some((organization) => organization.id === current) ? current : data.organizations[0]?.id ?? "");
      })
      .catch((failure: unknown) => { if (!isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => () => abort.current?.abort(), []);

  async function signOut() {
    if (signingOut) return;
    const controller = new AbortController();
    abort.current = controller;
    setSigningOut(true); setError("");
    try {
      await api("/api/auth/sign-out", { method: "POST", body: {}, signal: controller.signal });
      if (!controller.signal.aborted) onSignOut();
    } catch (failure) {
      if (!isAbort(failure)) setError(errorMessage(failure));
    } finally { if (!controller.signal.aborted) setSigningOut(false); }
  }

  const created = useCallback((organization: Organization) => {
    setOrganizations((current) => [...current, organization]);
    setActiveId(organization.id); setCreating(false); setSection("runs");
  }, []);

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Ir para o conteúdo</a>
    <aside className="sidebar">
      <Brand compact />
      <div className="company-picker"><label htmlFor="active-company">EMPRESA</label><div className="select-wrap"><select id="active-company" value={activeId} disabled={loading || organizations.length === 0} onChange={(event) => { setActiveId(event.target.value); setCreating(false); }}>
        {organizations.length === 0 ? <option value="">Sua empresa</option> : organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
      </select><Icon name="chevron" size={16} /></div><button className="text-button add-company" onClick={() => setCreating(true)} disabled={loading}><Icon name="plus" size={14} /> Nova empresa</button></div>
      <nav className="main-nav" aria-label="Menu principal">
        <button className={section === "runs" && !creating ? "nav-item selected" : "nav-item"} aria-current={section === "runs" && !creating ? "page" : undefined} onClick={() => { setSection("runs"); setCreating(false); }}><Icon name="play" />Teste de execução</button>
        <button className={section === "credentials" && !creating ? "nav-item selected" : "nav-item"} aria-current={section === "credentials" && !creating ? "page" : undefined} onClick={() => { setSection("credentials"); setCreating(false); }}><Icon name="key" />Chaves de IA</button>
        <button className={section === "company" && !creating ? "nav-item selected" : "nav-item"} aria-current={section === "company" && !creating ? "page" : undefined} onClick={() => { setSection("company"); setCreating(false); }}><Icon name="building" />Empresa</button>
      </nav>
      <div className="sidebar-bottom"><div className="early-access"><span className="small-dot" /> Acesso antecipado</div><div className="account"><div className="avatar" aria-hidden="true">{(user.name || user.email).slice(0, 1).toUpperCase()}</div><div className="account-text"><span>{user.name || "Sua conta"}</span><small title={user.email}>{user.email}</small></div><button className="icon-button" title="Sair da conta" aria-label="Sair da conta" disabled={signingOut} onClick={() => void signOut()}><Icon name="logout" /></button></div></div>
    </aside>
    <div className="workspace-shell"><header className="workspace-bar"><span>{active?.name ?? "Bem-vindo à Veltram"}</span><span className="workspace-bar-note">Seu trabalho, organizado.</span></header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        {error && <div className="page-error"><Notice>{error}</Notice><button className="text-button" onClick={() => setReload((value) => value + 1)}>Atualizar empresas</button></div>}
        {loading || signingOut ? <Loading label={signingOut ? "Encerrando sua sessão" : "Carregando suas empresas"} /> : creating || !active ? <CreateOrganization onCreated={created} onCancel={active ? () => setCreating(false) : undefined} /> : <OrganizationSpace key={active.id} organization={active} section={section} onNavigate={setSection} />}
      </main>
    </div>
  </div>;
}

function CreateOrganization({ onCreated, onCancel }: { onCreated: (organization: Organization) => void; onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError("");
    try {
      const result = await api<{ id: string; name: string }>("/api/organizations", { method: "POST", body: { name: name.trim() }, signal: controller.signal });
      if (!controller.signal.aborted) onCreated({ id: result.id, name: result.name, role: "owner" });
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <div className="onboarding-content"><PageHeading eyebrow="VAMOS COMEÇAR" title={onCancel ? "Crie uma empresa" : "Dê um lugar ao seu trabalho."}>Cada empresa tem seu próprio espaço, suas chaves de IA e seu histórico.</PageHeading>
    <form className="company-form form-stack" onSubmit={create}>
      {error && <Notice>{error}</Notice>}
      <div className="field"><label htmlFor="company-name">Nome da empresa</label><input id="company-name" placeholder="Como sua empresa se chama?" autoComplete="organization" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} required disabled={busy} autoFocus /><p className="field-hint">Você será o responsável por este espaço.</p></div>
      <div className="button-row"><button className="button primary" disabled={busy || !name.trim()}>{busy ? "Criando empresa…" : "Criar empresa"}<Icon name="arrow" /></button>{onCancel && <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>Cancelar</button>}</div>
    </form>
    <div className="onboarding-note"><Icon name="building" size={22} /><p>Trabalha com mais de uma empresa? Você pode criar outros espaços e alternar entre eles pelo menu.</p></div>
  </div>;
}
