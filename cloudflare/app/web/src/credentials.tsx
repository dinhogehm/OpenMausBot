import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage, formatDate, isAbort, organizationPath, type Credential, type Organization } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { Subscriptions } from "./subscriptions";
import { BudgetSettings } from "./budget";

const providers = [
  { id: "openai", name: "OpenAI", monogram: "O", description: "Modelos da OpenAI", className: "openai" },
  { id: "anthropic", name: "Anthropic", monogram: "A", description: "Família de modelos Claude", className: "anthropic" },
  { id: "openrouter", name: "OpenRouter", monogram: "↗", description: "Modelos de diferentes provedores", className: "openrouter" },
];

export function Credentials({ organization }: { organization: Organization }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const canManage = organization.role === "owner" || organization.role === "admin";

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setEditing(null);
    void api<{ credentials: Credential[] }>(`${organizationPath(organization.id)}/credentials`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setCredentials(data.credentials); })
      .catch((failure: unknown) => { if (!isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [organization.id, attempt]);

  function changed(credential: Credential) {
    setCredentials((current) => [...current.filter((item) => item.provider !== credential.provider), credential]);
    setEditing(null);
    setNotice(credential.status === "revoked" ? "A chave armazenada foi removida da Veltram. Para invalidá-la também no provedor, use o painel dele." : "Chave armazenada. A conexão com o provedor ainda não foi validada.");
  }

  return <>
    <PageHeading eyebrow="CONEXÕES DE IA" title="Suas contas. Seus modelos.">Vincule sua conta pessoal ou cadastre uma chave de API para {organization.name}.</PageHeading>
    <Subscriptions key={organization.id} organizationId={organization.id} />
    <BudgetSettings key={`budget:${organization.id}`} organizationId={organization.id} />
    <div className="section-heading"><h2>Chaves de API da empresa</h2><button className="text-button" disabled={loading} onClick={() => { setNotice(""); setAttempt((value) => value + 1); }}><Icon name="refresh" size={15} /> Atualizar</button></div>
    {error && <Notice>{error}</Notice>}
    {notice && <Notice kind="success">{notice}</Notice>}
    {!canManage && <Notice kind="info">Você pode consultar as configurações. Alterações de chaves exigem acesso de administrador.</Notice>}
    {loading ? <Loading label="Carregando provedores" /> : !error && <div className="provider-list">{providers.map((provider) => {
      const credential = credentials.find((item) => item.provider === provider.id);
      const configured = credential?.status === "configured";
      return <section className="provider" key={provider.id} aria-labelledby={`provider-${provider.id}`}>
        <div className="provider-summary"><div className={`provider-mark ${provider.className}`} aria-hidden="true">{provider.monogram}</div><div className="provider-info"><h3 id={`provider-${provider.id}`}>{provider.name}</h3><p>{provider.description}</p></div><span className={`status-pill ${configured ? "saved" : "neutral"}`}><span />{configured ? "Armazenada" : credential?.status === "revoked" ? "Removida" : "Sem chave"}</span>{canManage && <button className="button secondary small" onClick={() => { setNotice(""); setEditing((current) => current === provider.id ? null : provider.id); }} aria-expanded={editing === provider.id}>{editing === provider.id ? "Fechar" : configured ? "Gerenciar" : "Adicionar chave"}</button>}</div>
        {credential && <p className="provider-updated">Última alteração em {formatDate(credential.updatedAt)}</p>}
        {editing === provider.id && <CredentialEditor key={`${provider.id}:${credential?.version ?? 0}`} organizationId={organization.id} provider={provider.id} name={provider.name} credential={credential} onChanged={changed} onCancel={() => setEditing(null)} onRefresh={() => setAttempt((value) => value + 1)} />}
      </section>;
    })}</div>}
    <div className="credential-explainer"><Icon name="shield" size={20} /><div><h3>Você mantém o controle</h3><p>As chaves são armazenadas com criptografia. Salvar uma chave não faz chamadas de IA nem confirma saldo ou acesso a modelos. O teste de execução funciona sem essas chaves.</p></div></div>
  </>;
}

function CredentialEditor({ organizationId, provider, name, credential, onChanged, onCancel, onRefresh }: {
  organizationId: string; provider: string; name: string; credential?: Credential; onChanged: (credential: Credential) => void; onCancel: () => void; onRefresh: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function change(method: "PUT" | "DELETE") {
    if (busy) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError("");
    const body = { expectedVersion: credential?.version ?? null, ...(method === "PUT" ? { key } : {}) };
    setKey("");
    try {
      const result = await api<Credential>(`${organizationPath(organizationId)}/credentials/${provider}`, { method, body, signal: controller.signal });
      if (!controller.signal.aborted) onChanged(result);
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  function save(event: FormEvent) { event.preventDefault(); void change("PUT"); }
  return <div className="credential-editor">
    {error && <><Notice>{error}</Notice><button type="button" className="text-button" onClick={onRefresh} disabled={busy}>Atualizar dados do provedor</button></>}
    {confirmRemove ? <div className="inline-confirm"><h4>Remover a chave de {name}?</h4><p>Ela deixa de estar disponível na Veltram. A chave original continua válida no provedor até você revogá-la por lá.</p><div className="button-row"><button className="button danger" onClick={() => void change("DELETE")} disabled={busy}>{busy ? "Removendo…" : "Remover chave"}</button><button className="button secondary" onClick={() => setConfirmRemove(false)} disabled={busy}>Manter chave</button></div></div> : <form className="form-stack" onSubmit={save}>
      <div className="field"><label htmlFor={`key-${provider}`}>{credential?.status === "configured" ? "Nova chave de API" : "Chave de API"}</label><input id={`key-${provider}`} type="password" autoComplete="new-password" autoCorrect="off" spellCheck={false} minLength={8} maxLength={4096} pattern="[!-~]{8,4096}" placeholder={`Cole sua chave de ${name}`} value={key} onChange={(event) => setKey(event.target.value)} disabled={busy} required autoFocus aria-describedby={`key-help-${provider}`} /><p className="field-hint" id={`key-help-${provider}`}>{credential?.status === "configured" ? "Salvar substitui a chave atual desta empresa." : "A chave fica disponível apenas para esta empresa."}</p></div>
      <div className="button-row"><button className="button primary" disabled={busy || key.length < 8}>{busy ? "Salvando…" : "Salvar chave"}</button><button type="button" className="button secondary" onClick={onCancel} disabled={busy}>Cancelar</button>{credential?.status === "configured" && <button type="button" className="text-button danger-text remove-key" onClick={() => { setConfirmRemove(true); setKey(""); setError(""); }} disabled={busy}>Remover chave</button>}</div>
    </form>}
  </div>;
}
