import { useEffect, useRef, useState } from "react";
import type { MarketplaceEntry, MarketplaceListing, MarketplacePreview, MarketplaceInstallResult } from "../../src/marketplace-types";
import { api, errorMessage, isAbort, organizationPath, type Organization } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { filterMarketplace, marketplaceCategory, marketplaceInstallDecision, sourceLink, type MarketplaceAvailability } from "./marketplace-state";
import { useNavigationGuard } from "./navigation-guard";
import "./marketplace.css";

const sourceNames = { omb: "OpenMausBot", grokbot: "Grok Bot" };
const profileLabel = (count: number) => `${count} ${count === 1 ? "perfil" : "perfis"}`;
const sourceDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Data não informada" : date.toLocaleDateString("pt-BR", { timeZone: "UTC" });
};

export function Marketplace({ organization }: { organization: Organization }) {
  const path = `${organizationPath(organization.id)}/marketplace`;
  const [listing, setListing] = useState<MarketplaceListing | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0); const [search, setSearch] = useState("");
  const [source, setSource] = useState("all"); const [availability, setAvailability] = useState<MarketplaceAvailability>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const detailTrigger = useRef<HTMLButtonElement | null>(null); const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController(); setError("");
    void api<MarketplaceListing>(path, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setListing(value); })
      .catch((failure) => { if (!controller.signal.aborted && !isAbort(failure)) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [path, attempt]);
  const visible = filterMarketplace(listing?.items ?? [], search, source, availability);
  const hasFilters = Boolean(search.trim() || source !== "all" || availability !== "all");
  function clearFilters() { setSearch(""); setSource("all"); setAvailability("all"); searchInput.current?.focus(); }
  function closeDetail() { setSelected(null); requestAnimationFrame(() => detailTrigger.current?.focus()); }
  return <>
    <PageHeading eyebrow="AMPLIE SUA EQUIPE" title="Marketplace">Instale perfis em Agentes ou consulte referências externas. A instalação não inicia tarefas nem ativa conexões e rotinas.</PageHeading>
    {notice && <Notice kind="success">{notice}</Notice>}
    {error && <div className="marketplace-retry"><Notice>{error}</Notice><button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></div>}
    {!listing && !error ? <Loading label="Carregando marketplace" /> : listing && <>
      <div className="marketplace-toolbar" role="search" aria-label="Filtrar marketplace">
        <div className="field marketplace-search"><label htmlFor="marketplace-search">Buscar no catálogo</label><input ref={searchInput} id="marketplace-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, categoria ou objetivo" /></div>
        <div className="field"><label htmlFor="marketplace-source">Origem</label><select id="marketplace-source" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">Todas as origens</option><option value="omb">OpenMausBot</option><option value="grokbot">Grok Bot</option></select></div>
        <div className="field"><label htmlFor="marketplace-availability">Disponibilidade</label><select id="marketplace-availability" value={availability} onChange={(event) => setAvailability(event.target.value as MarketplaceAvailability)}><option value="all">Todos os itens</option><option value="importable">Perfis instaláveis</option><option value="installed">Instalados na empresa</option><option value="reference">Referências externas</option></select></div>
      </div>
      <div className="marketplace-results"><p role="status" aria-live="polite" aria-atomic="true">{visible.length} {visible.length === 1 ? "item" : "itens"}{hasFilters && ` de ${listing.items.length}`}</p>{hasFilters && <button className="button text small" onClick={clearFilters}><Icon name="close" size={16} />Limpar filtros</button>}</div>
      {visible.length > 0 ? <ul className="marketplace-list" aria-label="Itens do marketplace">{visible.map((item) => <li key={item.id}><article className="marketplace-item">
        <div className="marketplace-item-content"><div className="marketplace-item-meta"><span className="marketplace-source">{sourceNames[item.source]}</span><span>{item.kind === "team" ? "Equipe" : "Agente"}</span><span>{marketplaceCategory(item.category)}</span></div>
          <h2>{item.name}</h2><p className="marketplace-description">{item.description}</p>
          <div className="marketplace-item-details"><span className={item.installed !== "not_installed" ? "marketplace-installed" : ""}>{item.installed === "modified" ? "Instalado · Personalizado na empresa" : item.installed === "installed" ? "Instalado na empresa" : item.installable ? `${profileLabel(item.profileCount)} para instalar` : "Referência externa"}</span><span>{item.license.id ? `Licença ${item.license.id}` : "Licença não informada"}</span></div>
        </div>
        <button className="button secondary" aria-label={`Ver detalhes de ${item.name}`} onClick={(event) => { detailTrigger.current = event.currentTarget; setSelected(item.id); }}>Ver detalhes<Icon name="arrow" size={16} /></button>
      </article></li>)}</ul> : <div className="marketplace-empty"><Icon name="search" size={28} /><h2>{hasFilters ? "Nenhum item encontrado" : "Catálogo sem itens"}</h2><p>{hasFilters ? "Tente palavras mais curtas ou remova os filtros para explorar o catálogo." : "Não há itens disponíveis neste catálogo. Tente carregar novamente."}</p>{hasFilters ? <button className="button secondary" onClick={clearFilters}>Limpar filtros</button> : <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Carregar novamente</button>}</div>}
      <section className="marketplace-sources" aria-labelledby="marketplace-sources-title"><h2 id="marketplace-sources-title">Origem e cobertura dos catálogos</h2>{listing.sources.map((item) => <details key={item.id}><summary>{item.name}<span>{item.coverage === "complete_snapshot" ? "Catálogo completo na revisão consultada" : "Seleção do catálogo"}</span></summary><p>{item.note}</p><p className="muted">Consulta: {sourceDate(item.checkedAt)}{item.revision ? ` · Revisão ${item.revision.slice(0, 8)}` : ""}</p>{sourceLink(item.url) && <a href={sourceLink(item.url)} target="_blank" rel="noopener noreferrer">Abrir catálogo de origem<span className="sr-only"> (nova aba)</span> ↗</a>}</details>)}</section>
    </>}
    {selected && <MarketplaceDetail key={`${organization.id}:${selected}`} path={path} entryId={selected} onClose={closeDetail} onInstalled={(entry, result) => {
      closeDetail();
      setListing((current) => current ? { ...current, items: current.items.map((item) => item.id === entry.id ? { ...item, installed: "installed", profileIds: result.profileIds } : item) } : current);
      setNotice(`${profileLabel(result.profileIds.length)} de “${entry.name}” ${result.profileIds.length === 1 ? "está disponível" : "estão disponíveis"} em Agentes. Conexões e rotinas não foram ativadas.`);
      setAttempt((value) => value + 1);
    }} />}
  </>;
}

function MarketplaceDetail({ path, entryId, onClose, onInstalled }: { path: string; entryId: string; onClose: () => void; onInstalled: (entry: MarketplaceEntry, result: MarketplaceInstallResult) => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const pending = useRef<AbortController | null>(null); const installPending = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<MarketplacePreview | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [attempt, setAttempt] = useState(0);
  const requestId = useRef(crypto.randomUUID());
  useNavigationGuard({ busy });
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { pending.current?.abort(); element?.close(); }; }, []);
  useEffect(() => { if (error && !busy) closeButton.current?.focus(); }, [error, busy]);
  useEffect(() => {
    const controller = new AbortController(); setError("");
    void api<MarketplacePreview>(`${path}/${encodeURIComponent(entryId)}`, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setPreview(value); }).catch((failure) => { if (!controller.signal.aborted && !isAbort(failure)) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [path, entryId, attempt]);
  async function install() {
    if (installPending.current || !preview || marketplaceInstallDecision(preview.entry, preview.canInstall) !== "ready") return;
    const controller = new AbortController(); pending.current = controller; installPending.current = true; setBusy(true); setError("");
    try {
      const result = await api<MarketplaceInstallResult>(`${path}/install`, { method: "POST", signal: controller.signal, body: { entryId, version: preview.entry.version, expectedCatalogVersion: preview.catalogVersion, requestId: requestId.current } });
      if (!controller.signal.aborted) onInstalled(preview.entry, result);
    } catch (failure) { if (!controller.signal.aborted && !isAbort(failure)) setError(errorMessage(failure)); }
    finally { installPending.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  const entry = preview?.entry; const decision = preview ? marketplaceInstallDecision(preview.entry, preview.canInstall) : null;
  return <dialog className="marketplace-dialog" ref={dialog} aria-labelledby="marketplace-detail-title" aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!installPending.current) onClose(); }}>
    <header className="marketplace-dialog-header"><div><p className="eyebrow">{entry ? sourceNames[entry.source] : "MARKETPLACE"}</p><h2 id="marketplace-detail-title">{entry?.name ?? "Detalhes do item"}</h2></div><button ref={closeButton} className="button secondary" disabled={busy} onClick={onClose}>Fechar</button></header>
    {error && <div className="marketplace-retry"><Notice>{error}</Notice>{!preview && <button className="button secondary" onClick={() => { closeButton.current?.focus(); setAttempt((value) => value + 1); }}>Tentar novamente</button>}</div>}{!preview && !error && <Loading label="Carregando detalhes" />}
    {entry && preview && <><p>{entry.description}</p>{entry.source === "omb" && <p className="field-hint">Descrição e instruções preservadas no idioma do catálogo de origem.</p>}<p className="muted">{entry.author}</p>
      <div className="marketplace-links">{sourceLink(entry.sourceUrl) && <a href={sourceLink(entry.sourceUrl)} target="_blank" rel="noopener noreferrer">Ver na origem<span className="sr-only"> (nova aba)</span> ↗</a>}{sourceLink(entry.license.url) && <a href={sourceLink(entry.license.url)} target="_blank" rel="noopener noreferrer">Licença {entry.license.id}<span className="sr-only"> (nova aba)</span> ↗</a>}</div>
      {entry.unavailableReason && <Notice kind="info">{entry.unavailableReason}</Notice>}
      {decision === "reference" && !entry.unavailableReason && <Notice kind="info">Este item é uma referência externa. Não há instalação de perfis disponível no Veltram.</Notice>}
      {preview.profiles.length > 0 && <section><h3>Perfis incluídos <span className="muted">({preview.profiles.length})</span></h3><p>Nome, descrição e instruções. Os modelos e as permissões seguem a configuração da sua empresa.</p>{preview.profiles.map((profile) => <details className="marketplace-profile" key={profile.sourceId}><summary>{profile.name}<span>{profile.title}</span></summary><p>{profile.description}</p><pre tabIndex={0} aria-label={`Instruções de ${profile.name}`}>{profile.instructions}</pre></details>)}</section>}
      {entry.requiredCapabilities.length > 0 && <section><h3>Recursos esperados pela equipe</h3><ul>{entry.requiredCapabilities.map((item) => <li key={item}>{item}</li>)}</ul></section>}
      {entry.excludedFeatures.length > 0 && <section><h3>Fora desta instalação</h3><ul>{entry.excludedFeatures.map((item) => <li key={item}>{item}</li>)}</ul></section>}
      <details className="marketplace-profile"><summary>Procedência e licença</summary><p>Versão do catálogo</p><pre tabIndex={0} aria-label="Versão do catálogo">{entry.version}</pre>{entry.license.notice && <pre tabIndex={0} aria-label="Texto da licença">{entry.license.notice}</pre>}</details>
      {entry.installable && <footer className="marketplace-install"><p>{decision === "installed" ? "Os perfis já estão no catálogo da empresa. Suas personalizações são preservadas." : decision === "ready" ? "A instalação adiciona os perfis à empresa e não inicia tarefas nem ativa integrações." : "Um administrador da empresa pode instalar estes perfis."}</p><button className="button primary" disabled={busy || decision !== "ready"} onClick={() => void install()}>{busy ? "Instalando…" : decision === "installed" ? "Já instalado" : `Instalar ${profileLabel(entry.profileCount)}`}</button>{busy && <p className="marketplace-pending" role="status">Aguarde a confirmação da instalação para fechar.</p>}</footer>}
    </>}
  </dialog>;
}
