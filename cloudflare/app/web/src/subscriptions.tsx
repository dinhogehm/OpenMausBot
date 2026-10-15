import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ClaudeConnectionStatus } from "../../src/claude-types";
import { api, ApiError, errorMessage, isAbort, organizationPath } from "./api";
import { Loading, Notice } from "./components";

const states: Record<ClaudeConnectionStatus["state"], string> = {
  disconnected: "Desconectada", connecting: "Aguardando seu acesso", connected: "Conectada",
  reconnect_required: "Conecte novamente", disconnecting: "Desconectando",
};
export function officialClaudeAuthorization(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
      && ["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"].includes(url.hostname)
      && url.pathname === "/oauth/authorize" ? url.href : null;
  } catch { return null; }
}

export function Subscriptions({ organizationId }: { organizationId: string }) {
  const path = `${organizationPath(organizationId)}/me/claude-code`;
  const [status, setStatus] = useState<ClaudeConnectionStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => { setBusy(false); return () => operation.current?.abort(); }, [path]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(null); setError(""); setCode(""); setConfirmDisconnect(false);
    async function refresh() {
      try {
        const next = await api<ClaudeConnectionStatus>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setStatus(next);
        if (next.state === "connecting" || next.state === "disconnecting" || next.busy) timer = setTimeout(() => void refresh(), 2500);
      } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    }
    void refresh();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [path, attempt]);

  async function act(action: "login" | "complete" | "cancel" | "logout") {
    if (busy || !status) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    const submittedCode = code; setCode("");
    const suffix = action === "complete" || action === "cancel" ? `/login/${encodeURIComponent(status.flow!.id)}/${action}` : `/${action}`;
    try {
      const next = await api<ClaudeConnectionStatus>(path + suffix, { method: "POST", signal: controller.signal, body: {
        expectedVersion: status.connectionVersion, ...(action === "login" ? { requestId: crypto.randomUUID() } : {}),
        ...(action === "complete" ? { code: submittedCode } : {}),
      } });
      if (!controller.signal.aborted) { setStatus(next); setConfirmDisconnect(false); setAttempt((value) => value + 1); }
    } catch (failure) {
      if (!isAbort(failure)) { setError(errorMessage(failure)); setStatus(null); }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function complete(event: FormEvent) { event.preventDefault(); void act("complete"); }
  const authorizationUrl = officialClaudeAuthorization(status?.flow?.authorizationUrl);

  return <section className="subscription-section" aria-labelledby="subscriptions-heading">
    <div className="section-heading"><div><h2 id="subscriptions-heading">Minhas assinaturas</h2><p className="muted">Sua conta pessoal nesta empresa. A assinatura não é compartilhada com outros membros.</p></div><button type="button" className="text-button" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>Atualizar conexão</button></div>
    {error && <Notice>{error} Atualize a conexão antes de tentar novamente.</Notice>}
    <section className="provider" aria-labelledby="subscription-claude">
      <div className="provider-summary"><div className="provider-info"><h3 id="subscription-claude">Claude Code hospedado</h3><p>Use sua conta com o programa oficial da Anthropic. A franquia e a cobrança seguem seu plano. Configure os limites de uso extra no Claude; o orçamento de API do Veltram não controla a cobrança da assinatura.</p></div><span className={`status-pill ${status?.state === "connected" ? "saved" : "neutral"}`}><span />{status ? status.enabled ? states[status.state] : "Ativação pendente" : "Verificando"}</span></div>
      {!status && !error && <Loading label="Conferindo conexão pessoal" />}
      {status && !status.enabled && <p className="field-hint">Esta conexão ainda está em validação de isolamento e das condições aplicáveis à hospedagem. O estado da conexão anterior, se existir, permanece disponível para desconexão.</p>}
      {status && (status.enabled || status.state !== "disconnected") && <div className="credential-editor form-stack">
        {status.authMethod && status.authMethod !== "claude.ai" && <Notice kind="info">Esta conexão usa um método de API ou serviço externo. Ela não está habilitada para tarefas por assinatura; use uma conta Claude compatível ou cadastre a API separadamente.</Notice>}
        {status.error && <Notice>{errorMessage(new ApiError(503, status.error))}</Notice>}
        {status.busy && status.state !== "connecting" && <p role="status">Sua conexão está trabalhando. Aguarde a operação atual ou cancele a tarefa.</p>}
        {status.state === "connecting" && status.flow && <>
          {status.enabled && <>
          <p>Abra o acesso oficial, entre na sua conta e conclua a autorização. Cole aqui o código exibido pelo Claude.</p>
          {authorizationUrl ? <a className="button secondary" href={authorizationUrl} target="_blank" rel="noopener noreferrer">Entrar no Claude</a> : <p role="status">Preparando o endereço de acesso oficial…</p>}
          {!status.flow.codeSubmitted && authorizationUrl && <form className="form-stack" onSubmit={complete}><div className="field"><label htmlFor="claude-login-code">Código de autorização</label><input id="claude-login-code" type="password" autoComplete="off" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} maxLength={4096} disabled={busy} required /><p className="field-hint">O código é entregue uma vez ao programa oficial e não fica salvo no formulário.</p></div><button className="button primary" disabled={busy || !code.trim()}>{busy ? "Conectando…" : "Concluir conexão"}</button></form>}
          {status.flow.codeSubmitted && <p role="status">Autorização enviada. Conferindo o resultado…</p>}
          </>}
          <button type="button" className="text-button" disabled={busy} onClick={() => void act("cancel")}>Cancelar conexão</button>
        </>}
        {status.enabled && ["disconnected", "reconnect_required"].includes(status.state) && <button type="button" className="button primary" disabled={busy || status.busy} onClick={() => void act("login")}>{busy ? "Preparando…" : "Conectar minha conta"}</button>}
        {status.state === "connected" && (confirmDisconnect ? <div className="inline-confirm"><h4>Desconectar sua conta do Veltram?</h4><p>As tarefas que usam esta conexão serão interrompidas. Para revogar também a autorização no provedor, remova-a nas configurações de Claude Code no Claude.</p><div className="button-row"><button className="button danger" disabled={busy} onClick={() => void act("logout")}>Desconectar</button><button className="button secondary" disabled={busy} onClick={() => setConfirmDisconnect(false)}>Manter conexão</button></div></div> : <button type="button" className="text-button danger-text" disabled={busy} onClick={() => setConfirmDisconnect(true)}>Desconectar minha conta</button>)}
        <p className="field-hint">A conexão é preservada em cópias protegidas do ambiente, retidas pela Cloudflare por até 30 dias sem restauração. Desconectar bloqueia sua reutilização pelo Veltram. Falhas de recuperação podem exigir novo login.</p>
      </div>}
      <p className="provider-updated">Contas Max e Team elegíveis também podem <a href="https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans" target="_blank" rel="noopener noreferrer">vincular créditos mensais à API</a>. Nesse caso, cadastre abaixo a chave da organização vinculada.</p>
    </section>
    <section className="provider" aria-labelledby="subscription-openai"><div className="provider-summary"><div className="provider-info"><h3 id="subscription-openai">ChatGPT</h3><p>Uso do plano pessoal por Sign in with ChatGPT.</p></div><span className="status-pill neutral"><span />Aguardando habilitação OpenAI</span></div><p className="provider-updated">O uso em um serviço hospedado como o Veltram depende da habilitação da OpenAI. <a href="https://developers.openai.com/siwc/token-sharing-open-source" target="_blank" rel="noopener noreferrer">Condições oficiais</a>.</p></section>
    <p className="field-hint">Se a assinatura estiver indisponível ou atingir seu limite, a execução para. O Veltram não muda automaticamente para uma API paga.</p>
  </section>;
}
