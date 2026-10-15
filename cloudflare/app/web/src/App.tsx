import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { api, ApiError, errorMessage, isAbort, type Organization, type User } from "./api";
import { SignIn } from "./auth";
import { Brand, Icon, Loading, Notice, PageHeading, type IconName } from "./components";
import { OrganizationSpace, type Section } from "./organization";
import { canLeavePage, useNavigationGuard } from "./navigation-guard";
import { NavigationGuardDialog } from "./navigation-dialog";
import { readRoute, resolveOrganization, routeHash } from "./navigation";

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

const navigationGroups: { label: string; items: { section: Section; label: string; icon: IconName }[] }[] = [
  { label: "Trabalho", items: [
    { section: "missions", label: "Missões", icon: "play" },
    { section: "coding", label: "Tarefas", icon: "code" },
    { section: "browser", label: "Navegador", icon: "browser" },
    { section: "reports", label: "Relatórios", icon: "chart" },
  ] },
  { label: "Equipe", items: [
    { section: "agents", label: "Agentes", icon: "team" },
    { section: "marketplace", label: "Marketplace", icon: "store" },
  ] },
  { label: "Configuração", items: [
    { section: "repositories", label: "Repositórios", icon: "repository" },
    { section: "credentials", label: "Conexões de IA", icon: "key" },
    { section: "company", label: "Empresa", icon: "building" },
  ] },
];
const sectionLabels = Object.fromEntries(navigationGroups.flatMap((group) => group.items.map((item) => [item.section, item.label]))) as Record<Section, string>;
sectionLabels.runs = "Teste de execução";

function Shell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const initialRoute = useRef(readRoute(window.location.hash, window.location.search));
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeId, setActiveId] = useState(initialRoute.current.organizationId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [section, setSection] = useState<Section>(initialRoute.current.section);
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [reload, setReload] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const main = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const focusContent = useRef(true);
  const historyPosition = useRef<number>(typeof window.history.state?.veltramPosition === "number" ? window.history.state.veltramPosition : 0);
  const displayedHash = useRef(window.location.hash);
  const revertingHistory = useRef(false);
  const routingHistory = useRef(false);
  const active = organizations.find((organization) => organization.id === activeId);
  const pageLabel = creating || !active ? "Nova empresa" : sectionLabels[section];

  const navigate = useCallback((next: Section, company = activeId) => {
    focusContent.current = true;
    setSection(next); setActiveId(company); setCreating(false); setMenuOpen(false);
    const hash = routeHash(next, company);
    displayedHash.current = hash;
    if (window.location.hash !== hash) window.history.pushState({ veltramPosition: ++historyPosition.current }, "", hash);
  }, [activeId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api<{ organizations: Organization[] }>("/api/organizations", { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setOrganizations(data.organizations);
        setActiveId((current) => resolveOrganization(current, data.organizations));
        const url = new URL(window.location.href);
        if (url.searchParams.has("github")) {
          url.searchParams.delete("github"); url.searchParams.delete("organization");
          window.history.replaceState({ veltramPosition: historyPosition.current }, "", `${url.pathname}${url.search}${url.hash}`);
        }
      })
      .catch((failure: unknown) => { if (!isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (loading) return;
    const hash = routeHash(section, activeId);
    displayedHash.current = hash;
    window.history.replaceState({ veltramPosition: historyPosition.current }, "", hash);
  }, [loading, section, activeId]);
  useEffect(() => {
    const restore = async () => {
      const targetHash = window.location.hash;
      // In-page anchors scroll within the current screen and must not replace its route.
      if (targetHash && !targetHash.startsWith("#/")) {
        window.history.replaceState({ veltramPosition: historyPosition.current }, "", displayedHash.current);
        return;
      }
      if (targetHash === displayedHash.current) { revertingHistory.current = false; return; }
      if (revertingHistory.current || routingHistory.current) return;
      routingHistory.current = true;
      const allowed = await canLeavePage();
      routingHistory.current = false;
      // Back/Forward can run again while the in-page dialog is open. Read the
      // actual destination now, not the first event's stale history position.
      const finalHash = window.location.hash;
      const targetPosition = typeof window.history.state?.veltramPosition === "number" ? window.history.state.veltramPosition : historyPosition.current + 1;
      if (!allowed) {
        const distance = historyPosition.current - targetPosition;
        if (distance) { revertingHistory.current = true; window.history.go(distance); }
        else window.history.replaceState({ veltramPosition: historyPosition.current }, "", displayedHash.current);
        return;
      }
      historyPosition.current = targetPosition;
      displayedHash.current = finalHash;
      const route = readRoute(finalHash);
      focusContent.current = true;
      setSection(route.section); setActiveId(resolveOrganization(route.organizationId, organizations));
      setCreating(false); setMenuOpen(false);
    };
    window.addEventListener("popstate", restore); window.addEventListener("hashchange", restore);
    return () => { window.removeEventListener("popstate", restore); window.removeEventListener("hashchange", restore); };
  }, [organizations]);
  useEffect(() => {
    document.title = `${pageLabel}${active ? ` · ${active.name}` : ""} · Veltram`;
    if (focusContent.current && !loading) {
      focusContent.current = false;
      main.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [pageLabel, active, section, creating, loading]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuOpen(false); menuButton.current?.focus(); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);

  async function signOut() {
    if (signingOut) return;
    const controller = new AbortController(); abort.current = controller;
    setSigningOut(true); setError("");
    try {
      await api("/api/auth/sign-out", { method: "POST", body: {}, signal: controller.signal });
      if (!controller.signal.aborted) onSignOut();
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setSigningOut(false); }
  }

  function followLink(event: MouseEvent<HTMLAnchorElement>, next: Section) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); void canLeavePage().then((allowed) => { if (allowed) navigate(next); });
  }
  const guardedNavigate = (next: Section) => { void canLeavePage().then((allowed) => { if (allowed) navigate(next); }); };
  const created = useCallback((organization: Organization) => {
    setOrganizations((current) => [...current, organization]);
    navigate("repositories", organization.id);
  }, [navigate]);
  function cancelCreate() {
    setCreating(false);
    if (window.matchMedia("(max-width: 820px)").matches) menuButton.current?.focus();
    else createButton.current?.focus();
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); main.current?.focus(); }}>Ir para o conteúdo</a>
    <aside className={`sidebar${menuOpen ? " menu-open" : ""}`} aria-label="Navegação da empresa">
      <div className="sidebar-brand"><Brand compact /><button ref={menuButton} className="mobile-menu-button" aria-expanded={menuOpen} aria-controls="sidebar-body" onClick={() => setMenuOpen((value) => !value)}><Icon name={menuOpen ? "close" : "menu"} /><span>{menuOpen ? "Fechar" : "Menu"}</span></button></div>
      <p className="mobile-company" title={active?.name}>{active?.name ?? "Seu espaço de trabalho"}</p>
      <div id="sidebar-body" className="sidebar-body">
        <div className="company-picker"><label htmlFor="active-company">Empresa</label><div className="select-wrap"><select id="active-company" value={activeId} disabled={loading || organizations.length === 0} onChange={(event) => { const company = event.target.value; void canLeavePage().then((allowed) => { if (allowed) navigate(section, company); }); }}>
          {organizations.length === 0 ? <option value="">Sua empresa</option> : organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
        </select><Icon name="chevron" size={16} /></div><button ref={createButton} className="text-button add-company" onClick={async () => { if (!await canLeavePage()) return; focusContent.current = true; setCreating(true); setMenuOpen(false); }} disabled={loading}><Icon name="plus" size={16} /> Nova empresa</button></div>
        <nav className="main-nav" aria-label="Menu principal">
          {navigationGroups.map((group) => <div className="nav-group" key={group.label}><p className="nav-group-label">{group.label}</p>{group.items.map((item) => <a key={item.section} href={routeHash(item.section, activeId)} className={`nav-item${section === item.section && !creating ? " selected" : ""}`} aria-current={section === item.section && !creating ? "page" : undefined} onClick={(event) => followLink(event, item.section)}><Icon name={item.icon} />{item.label}</a>)}</div>)}
          <a href={routeHash("runs", activeId)} className={`nav-item diagnostic-link${section === "runs" && !creating ? " selected" : ""}`} aria-current={section === "runs" && !creating ? "page" : undefined} onClick={(event) => followLink(event, "runs")}><Icon name="shield" />Teste de execução</a>
        </nav>
        <div className="sidebar-bottom"><div className="early-access"><span className="small-dot" /> Acesso antecipado</div><div className="account"><div className="avatar" aria-hidden="true">{(user.name || user.email).slice(0, 1).toUpperCase()}</div><div className="account-text"><span>{user.name || "Sua conta"}</span><small title={user.email}>{user.email}</small></div><button className="icon-button" title="Sair da conta" aria-label="Sair da conta" disabled={signingOut} onClick={async () => { if (await canLeavePage()) void signOut(); }}><Icon name="logout" /></button></div></div>
      </div>
    </aside>
    <div className="workspace-shell"><header className="workspace-bar"><span>{pageLabel}</span><span className="workspace-company" title={active?.name}><Icon name="building" size={16} />{active?.name ?? "Bem-vindo à Veltram"}</span></header>
      <p className="sr-only" role="status" aria-live="polite">{loading ? "Carregando empresas" : `${pageLabel}${active ? `, ${active.name}` : ""}`}</p>
      <main ref={main} id="main-content" className="main-content" tabIndex={-1}>
        {error && <div className="page-error"><Notice>{error}</Notice><button className="text-button" onClick={() => setReload((value) => value + 1)}>Atualizar empresas</button></div>}
        {loading || signingOut ? <Loading label={signingOut ? "Encerrando sua sessão" : "Carregando suas empresas"} /> : creating || !active ? <CreateOrganization onCreated={created} onCancel={active ? cancelCreate : undefined} /> : <OrganizationSpace key={active.id} organization={active} section={section} onNavigate={guardedNavigate} />}
      </main>
    </div>
    <NavigationGuardDialog />
  </div>;
}

function CreateOrganization({ onCreated, onCancel }: { onCreated: (organization: Organization) => void; onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  useNavigationGuard({ dirty: Boolean(name.trim()), busy });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (error && !busy) nameInput.current?.focus(); }, [error, busy]);

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
      <div className="field"><label htmlFor="company-name">Nome da empresa</label><input ref={nameInput} id="company-name" placeholder="Como sua empresa se chama?" autoComplete="organization" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} required disabled={busy} autoFocus /><p className="field-hint">Você será o responsável por este espaço.</p></div>
      <div className="button-row"><button className="button primary" disabled={busy || !name.trim()}>{busy ? "Criando empresa…" : "Criar empresa"}<Icon name="arrow" /></button>{onCancel && <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>Cancelar</button>}</div>
    </form>
    <div className="onboarding-note"><Icon name="building" size={22} /><p>Trabalha com mais de uma empresa? Você pode criar outros espaços e alternar entre eles pelo menu.</p></div>
  </div>;
}
