import { useEffect, useRef, useState } from "react";
import type { MarketplaceEntry, MarketplaceListing, MarketplacePreview, MarketplaceInstallResult } from "../../src/marketplace-types";
import { api, errorMessage, isAbort, organizationPath, type Organization } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import "./marketplace.css";

const sourceNames = { omb: "OpenMausBot", grokbot: "Grok Bot" };
function sourceLink(value: string | null) {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

export function Marketplace({ organization }: { organization: Organization }) {
  const path = `${organizationPath(organization.id)}/marketplace`;
  const [listing, setListing] = useState<MarketplaceListing | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0); const [search, setSearch] = useState("");
  const [source, setSource] = useState("all"); const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setError("");
    void api<MarketplaceListing>(path, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setListing(value); })
      .catch((failure) => { if (!isAbort(failure)) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [path, attempt]);
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const visible = listing?.items.filter((item) => (source === "all" || item.source === source) && normalize(`${item.name} ${item.description} ${item.category}`).includes(normalize(search))) ?? [];
  return <>
    <PageHeading eyebrow="AMPLIE SUA EQUIPE" title="Marketplace">Encontre equipes e agentes do OpenMausBot e do Grok Bot. Confira a origem e o que pode ser instalado no Veltram.</PageHeading>
    {notice && <Notice kind="success">{notice}</Notice>}
    {error && <><Notice>{error}</Notice><button className="button secondary small" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></>}
    {!listing && !error ? <Loading label="Carregando marketplace" /> : listing && <>
      <div className="marketplace-toolbar"><div className="field"><label htmlFor="marketplace-search">Buscar no catálogo</label><input id="marketplace-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, categoria ou objetivo" /></div><div className="field"><label htmlFor="marketplace-source">Origem</label><select id="marketplace-source" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">Todas as origens</option><option value="omb">OpenMausBot</option><option value="grokbot">Grok Bot</option></select></div><span className="muted" role="status">{visible.length} {visible.length === 1 ? "item" : "itens"}</span></div>
      <div className="marketplace-grid">{visible.map((item) => <article className="marketplace-card" key={item.id}>
        <div className="marketplace-card-top"><span className={`marketplace-source ${item.source}`}>{sourceNames[item.source]}</span><span className="muted">{item.kind === "team" ? "Equipe" : "Agente"}</span></div>
        <p className="eyebrow">{item.category}</p><h2>{item.name}</h2><p className="marketplace-description">{item.description}</p>
        <div className="marketplace-card-meta"><span>{item.installable ? `${item.profileCount} ${item.profileCount === 1 ? "perfil" : "perfis"}` : "Referência externa"}</span><span>{item.installed === "modified" ? "Personalizado na empresa" : item.installed === "installed" ? "Instalado" : item.license.id ?? "Licença não informada"}</span></div>
        <button className="button secondary small" onClick={() => setSelected(item.id)}>Ver detalhes<Icon name="arrow" size={16} /></button>
      </article>)}</div>
      {!visible.length && <p className="marketplace-empty">Nenhum item corresponde aos filtros. Tente outro nome ou origem.</p>}
      <section className="marketplace-sources"><h2>Sobre os catálogos</h2>{listing.sources.map((item) => <div key={item.id}><h3>{item.name}</h3><p>{item.note}</p><p className="muted">{item.coverage === "complete_snapshot" ? "Catálogo completo na revisão consultada" : "Seleção do catálogo"} · Consulta: {item.checkedAt.slice(0, 10)}{item.revision ? ` · Revisão ${item.revision.slice(0, 8)}` : ""}</p><a href={sourceLink(item.url)} target="_blank" rel="noopener noreferrer">Abrir catálogo de origem ↗</a></div>)}</section>
    </>}
    {selected && <MarketplaceDetail key={`${organization.id}:${selected}`} path={path} entryId={selected} onClose={() => setSelected(null)} onInstalled={(entry) => { setSelected(null); setNotice(`${entry.profileCount} perfis de “${entry.name}” estão disponíveis em Agentes. Conexões e rotinas não foram ativadas.`); setAttempt((value) => value + 1); }} />}
  </>;
}

function MarketplaceDetail({ path, entryId, onClose, onInstalled }: { path: string; entryId: string; onClose: () => void; onInstalled: (entry: MarketplaceEntry) => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const pending = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<MarketplacePreview | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { pending.current?.abort(); element?.close(); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<MarketplacePreview>(`${path}/${encodeURIComponent(entryId)}`, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setPreview(value); }).catch((failure) => { if (!isAbort(failure)) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [path, entryId]);
  async function install() {
    if (busy || !preview?.canInstall || !preview.entry.installable || preview.entry.installed !== "not_installed") return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError("");
    try {
      await api<MarketplaceInstallResult>(`${path}/install`, { method: "POST", signal: controller.signal, body: { entryId, version: preview.entry.version, expectedCatalogVersion: preview.catalogVersion, requestId: requestId.current } });
      if (!controller.signal.aborted) onInstalled(preview.entry);
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  const entry = preview?.entry;
  return <dialog className="marketplace-dialog" ref={dialog} aria-labelledby="marketplace-detail-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="marketplace-dialog-header"><h2 id="marketplace-detail-title">{entry?.name ?? "Detalhes do item"}</h2><button className="button secondary small" disabled={busy} onClick={onClose}>Fechar</button></div>
    {error && <Notice>{error}</Notice>}{!preview && !error && <Loading label="Carregando detalhes" />}
    {entry && preview && <><p>{entry.description}</p><p className="muted">{sourceNames[entry.source]} · {entry.author} · Versão {entry.version}</p>
      <div className="marketplace-links"><a href={sourceLink(entry.sourceUrl)} target="_blank" rel="noopener noreferrer">Ver na origem ↗</a>{entry.license.url && <a href={sourceLink(entry.license.url)} target="_blank" rel="noopener noreferrer">Licença {entry.license.id} ↗</a>}</div>
      {entry.unavailableReason && <Notice kind="info">{entry.unavailableReason}</Notice>}
      {preview.profiles.length > 0 && <section><h3>Perfis incluídos</h3><p>Nome, descrição e instruções. Os modelos e as permissões seguem a configuração da sua empresa.</p>{preview.profiles.map((profile) => <details className="marketplace-profile" key={profile.sourceId}><summary>{profile.name}<span>{profile.title}</span></summary><p>{profile.description}</p><pre>{profile.instructions}</pre></details>)}</section>}
      {entry.requiredCapabilities.length > 0 && <section><h3>Recursos esperados pela equipe</h3><ul>{entry.requiredCapabilities.map((item) => <li key={item}>{item}</li>)}</ul></section>}
      {entry.excludedFeatures.length > 0 && <section><h3>Fora desta instalação</h3><ul>{entry.excludedFeatures.map((item) => <li key={item}>{item}</li>)}</ul></section>}
      {entry.license.notice && <details className="marketplace-profile"><summary>Atribuição e licença</summary><pre>{entry.license.notice}</pre></details>}
      {entry.installable && <footer className="marketplace-install"><p>{entry.installed !== "not_installed" ? "Os perfis já estão no catálogo da empresa. Suas personalizações são preservadas." : preview.canInstall ? "A instalação adiciona os perfis à empresa e não inicia tarefas nem ativa integrações." : "Um administrador da empresa pode instalar estes perfis."}</p><button className="button primary" disabled={busy || !preview.canInstall || entry.installed !== "not_installed"} onClick={() => void install()}>{busy ? "Instalando…" : entry.installed !== "not_installed" ? "Já instalado" : `Instalar ${entry.profileCount} perfis`}</button></footer>}
    </>}
  </dialog>;
}
