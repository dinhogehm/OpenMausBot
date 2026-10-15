import { confirmUnsavedChanges, useNavigationGuard, type NavigationGuard } from "./navigation-guard";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage, formatDate, isAbort, organizationPath, type Credential, type Organization } from "./api";
import { Icon, Loading, Notice, PageHeading } from "./components";
import { Subscriptions } from "./subscriptions";
import { BudgetSettings } from "./budget";
import type { BudgetView } from "../../src/budget-types";
import type { ClaudeConnectionStatus } from "../../src/claude-types";
import "./connections.css";

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
  const [editorState, setEditorState] = useState<NavigationGuard>({});
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [subscription, setSubscription] = useState<ClaudeConnectionStatus | null>(null);
  const editorButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const canManage = organization.role === "owner" || organization.role === "admin";

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setEditing(null); setNotice("");
    void api<{ credentials: Credential[] }>(`${organizationPath(organization.id)}/credentials`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setCredentials(data.credentials); })
      .catch((failure: unknown) => { if (!isAbort(failure)) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [organization.id, attempt]);

  useEffect(() => { setBudget(null); setSubscription(null); }, [organization.id]);

  function closeEditor(provider: string) {
    setEditing(null);
    editorButtons.current[provider]?.focus();
  }
  async function switchEditor(provider: string | null, refresh = false) {
    if (editorState.busy || (editorState.dirty && !await confirmUnsavedChanges())) return;
    const previous = editing;
    setNotice(""); setEditing(provider); setEditorState({});
    if (refresh) setAttempt((value) => value + 1);
    else if (!provider && previous) editorButtons.current[previous]?.focus();
  }

  function changed(credential: Credential) {
    setCredentials((current) => [...current.filter((item) => item.provider !== credential.provider), credential]);
    closeEditor(credential.provider);
    setNotice(credential.status === "revoked" ? "A chave armazenada foi removida da Veltram. Para invalidá-la também no provedor, use o painel dele." : "Chave armazenada. A conexão com o provedor ainda não foi validada.");
  }

  const apiPaused = budget?.enforcement?.required && !budget.enforcement.paidApiAvailable;
  const subscriptionsUnavailable = subscription && !subscription.enabled;
  return <div className="connections-page">
    <PageHeading eyebrow="CONFIGURAÇÃO" title="Conexões de IA">Gerencie as chaves de {organization.name}, suas assinaturas pessoais e o limite de uso da empresa.</PageHeading>
    <div className={`connections-readiness${apiPaused ? " paused" : ""}`} role="status">
      <Icon name="shield" size={22} />
      <div><h2>{apiPaused ? subscriptionsUnavailable ? "Execuções com IA ainda indisponíveis" : "Chamadas pagas de API pausadas" : "Configuração e disponibilidade são etapas diferentes"}</h2>
      <p>{apiPaused ? "As conexões de API aguardam validação do modo de cobrança. Você pode armazenar chaves e definir um limite; essas configurações não liberam a execução." : "Uma chave armazenada não confirma saldo, acesso a modelos ou disponibilidade para executar tarefas. Confira o estado de cada conexão abaixo."}{apiPaused && subscriptionsUnavailable && " As assinaturas pessoais também aguardam liberação."}</p></div>
    </div>
    <nav className="connections-nav" aria-label="Seções de conexões de IA"><a href="#company-api-keys">Chaves da empresa</a><a href="#personal-subscriptions">Minhas assinaturas</a><a href="#daily-api-budget">Orçamento de API</a></nav>
    <section id="company-api-keys" className="connections-section" aria-labelledby="company-api-heading">
    <div className="section-heading"><div><h2 id="company-api-heading">Chaves da empresa</h2><p>Acesso compartilhado com os agentes de {organization.name}.</p></div><button className="text-button" disabled={loading || editorState.busy} onClick={() => void switchEditor(null, true)}><Icon name="refresh" size={15} /> {loading ? "Atualizando…" : "Atualizar chaves"}</button></div>
    {error && <Notice>{error}</Notice>}
    {notice && <Notice kind="success">{notice}</Notice>}
    {!canManage && <Notice kind="info">Você pode consultar as configurações. Alterações de chaves exigem acesso de administrador.</Notice>}
    {loading ? <Loading label="Carregando provedores" /> : !error && <div className="provider-list">{providers.map((provider) => {
      const credential = credentials.find((item) => item.provider === provider.id);
      const configured = credential?.status === "configured";
      return <section className="provider" key={provider.id} aria-labelledby={`provider-${provider.id}`}>
        <div className="provider-summary"><div className={`provider-mark ${provider.className}`} aria-hidden="true">{provider.monogram}</div><div className="provider-info"><h3 id={`provider-${provider.id}`}>{provider.name}</h3><p>{provider.description}</p></div><span className={`status-pill ${configured && !apiPaused ? "saved" : "neutral"}`}><span />{configured ? apiPaused ? "Armazenada · uso pausado" : "Armazenada" : credential?.status === "revoked" ? "Removida" : "Sem chave"}</span>{canManage && <button ref={(node) => { editorButtons.current[provider.id] = node; }} className="button secondary small" disabled={editorState.busy} onClick={() => void switchEditor(editing === provider.id ? null : provider.id)} aria-expanded={editing === provider.id} aria-controls={`credential-editor-${provider.id}`}>{editing === provider.id ? "Fechar" : configured ? "Gerenciar chave" : "Adicionar chave"}</button>}</div>
        {credential && <p className="provider-updated">Última alteração em {formatDate(credential.updatedAt)}</p>}
        {editing === provider.id && <CredentialEditor key={`${provider.id}:${credential?.version ?? 0}`} organizationId={organization.id} provider={provider.id} name={provider.name} credential={credential} onChanged={changed} onState={setEditorState} onCancel={() => void switchEditor(null)} onRefresh={() => void switchEditor(null, true)} />}
      </section>;
    })}</div>}
    <div className="credential-explainer"><Icon name="shield" size={20} /><div><h3>Você mantém o controle</h3><p>As chaves são armazenadas com criptografia. Salvar uma chave não faz chamadas de IA nem confirma saldo ou acesso a modelos. O teste de execução funciona sem essas chaves.</p></div></div>
    </section>
    <Subscriptions key={organization.id} organizationId={organization.id} onStatus={setSubscription} />
    <BudgetSettings key={`budget:${organization.id}`} organizationId={organization.id} onView={setBudget} />
  </div>;
}

function CredentialEditor({ organizationId, provider, name, credential, onChanged, onCancel, onRefresh, onState }: {
  organizationId: string; provider: string; name: string; credential?: Credential; onChanged: (credential: Credential) => void; onCancel: () => void; onRefresh: () => void; onState: (state: NavigationGuard) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { onState({ busy, dirty: Boolean(key) }); }, [busy, key, onState]);
  useEffect(() => () => onState({}), [onState]);
  useEffect(() => { if (confirmRemove) keepButton.current?.focus(); }, [confirmRemove]);
  useEffect(() => { if (error && !busy) input.current?.focus(); }, [error, busy]);
  useNavigationGuard({ dirty: Boolean(key), busy });
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
  return <div className="credential-editor" id={`credential-editor-${provider}`}>
    {error && <><Notice>{error}</Notice><button type="button" className="text-button" onClick={onRefresh} disabled={busy}>Atualizar dados do provedor</button></>}
    {confirmRemove ? <div className="inline-confirm"><h4>Remover a chave de {name}?</h4><p>Ela deixa de estar disponível na Veltram. A chave original continua válida no provedor até você revogá-la por lá.</p><div className="button-row"><button className="button danger" onClick={() => void change("DELETE")} disabled={busy}>{busy ? "Removendo…" : "Remover chave"}</button><button ref={keepButton} className="button secondary" onClick={() => { setConfirmRemove(false); requestAnimationFrame(() => removeButton.current?.focus()); }} disabled={busy}>Manter chave</button></div></div> : <form className="form-stack" onSubmit={save}>
      <div className="field"><label htmlFor={`key-${provider}`}>{credential?.status === "configured" ? "Nova chave de API" : "Chave de API"}</label><input ref={input} id={`key-${provider}`} type="password" autoComplete="new-password" autoCorrect="off" spellCheck={false} minLength={8} maxLength={4096} pattern="[!-~]{8,4096}" placeholder={`Cole sua chave de ${name}`} value={key} onChange={(event) => setKey(event.target.value)} disabled={busy} required autoFocus aria-describedby={`key-help-${provider}`} /><p className="field-hint" id={`key-help-${provider}`}>{credential?.status === "configured" ? "Salvar substitui a chave atual desta empresa." : "A chave fica disponível apenas para esta empresa."}</p></div>
      <div className="button-row"><button className="button primary" disabled={busy || key.length < 8}>{busy ? "Salvando…" : "Salvar chave"}</button><button type="button" className="button secondary" onClick={onCancel} disabled={busy}>Cancelar</button>{credential?.status === "configured" && <button ref={removeButton} type="button" className="text-button danger-text remove-key" onClick={async () => { if (key && !await confirmUnsavedChanges()) return; setConfirmRemove(true); setKey(""); setError(""); }} disabled={busy}>Remover chave</button>}</div>
    </form>}
  </div>;
}
