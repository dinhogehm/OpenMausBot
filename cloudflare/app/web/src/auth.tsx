import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage, isAbort, type User } from "./api";
import { Brand, Icon, Notice } from "./components";

export function SignIn({ onSignIn, expired }: { onSignIn: (user: User) => void; expired: boolean }) {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { (stage === "code" ? codeInput : emailInput).current?.focus(); }, [stage]);
  useEffect(() => { if (error && !busy) (stage === "code" ? codeInput : emailInput).current?.focus(); }, [error, busy, stage]);
  useEffect(() => {
    if (!sentAt) return;
    const update = () => setSeconds(Math.max(0, 60 - Math.floor((Date.now() - sentAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [sentAt]);

  async function sendCode(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setError(""); setOtp("");
    try {
      await api("/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email: email.trim(), type: "sign-in" }, signal: controller.signal });
      if (!controller.signal.aborted) { setStage("code"); setSentAt(Date.now()); }
    } catch (failure) {
      if (!isAbort(failure)) setError(errorMessage(failure));
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setError("");
    try {
      await api("/api/auth/sign-in/email-otp", { method: "POST", body: { email: email.trim(), otp }, signal: controller.signal });
      setOtp("");
      const data = await api<{ user: User }>("/api/session", { signal: controller.signal });
      if (!controller.signal.aborted) onSignIn(data.user);
    } catch (failure) {
      if (!isAbort(failure)) setError(errorMessage(failure));
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <main className="auth-layout">
    <section className="auth-story" aria-label="Sobre a Veltram">
      <Brand />
      <div className="auth-story-content"><p className="eyebrow">TRABALHO EM BOAS MÃOS</p><h2>Sua equipe de agentes.<br />Um lugar para<br /><span>fazer acontecer.</span></h2><p>Um espaço para organizar o trabalho, acompanhar cada execução e decidir o próximo passo.</p></div>
      <div className="auth-story-footer"><span className="brand-line" /><span>Veltram · Acesso antecipado</span></div>
    </section>
    <section className="auth-entry" aria-label="Entrar na Veltram">
      <div className="auth-mobile-brand"><Brand /></div>
      <div className="auth-form-wrap">
        <div className="section-icon"><Icon name={stage === "email" ? "arrow" : "shield"} size={24} /></div>
        <p className="eyebrow">SEU ESPAÇO DE TRABALHO</p>
        <h1>{stage === "email" ? "Entre na Veltram" : "Confira seu e-mail"}</h1>
        <p className="muted auth-description">{stage === "email" ? "Use seu e-mail para entrar ou criar sua conta. Você recebe um código, sem precisar de senha." : <>Digite o código de oito dígitos enviado para <strong>{email.trim()}</strong>. Ele vale por 10 minutos.</>}</p>
        {expired && stage === "email" && <Notice kind="info">Sua sessão terminou. Entre novamente para continuar.</Notice>}
        {error && <div id="sign-in-error"><Notice>{error}</Notice></div>}
        {stage === "email" ? <form onSubmit={sendCode} className="form-stack" aria-busy={busy}>
          <div className="field"><label htmlFor="sign-in-email">E-mail</label><input ref={emailInput} id="sign-in-email" aria-describedby={error ? "sign-in-error" : undefined} type="email" autoComplete="email" placeholder="voce@empresa.com" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} autoFocus /></div>
          <button className="button primary wide" disabled={busy}>{busy ? "Solicitando código…" : "Continuar com e-mail"}<Icon name="arrow" /></button>
        </form> : <form onSubmit={verify} className="form-stack" aria-busy={busy}>
          <div className="field"><label htmlFor="sign-in-code">Código de acesso</label><input ref={codeInput} id="sign-in-code" className="code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8} minLength={8} required value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 8))} disabled={busy} aria-describedby={error ? "code-help sign-in-error" : "code-help"} /><p id="code-help" className="field-hint">Se não encontrar, confira a pasta de spam.</p></div>
          <button className="button primary wide" disabled={busy || otp.length !== 8}>{busy ? "Confirmando…" : "Entrar"}<Icon name="arrow" /></button>
          <div className="auth-code-actions"><button type="button" className="text-button" disabled={busy || seconds > 0} onClick={() => void sendCode()}>{seconds > 0 ? `Reenviar em ${seconds}s` : "Enviar outro código"}</button><button type="button" className="text-button" disabled={busy} onClick={() => { setStage("email"); setOtp(""); setError(""); }}>Alterar e-mail</button></div>
        </form>}
        <p className="auth-footnote"><Icon name="shield" size={15} /> Seu acesso e os dados de cada empresa ficam separados.</p>
      </div>
      <p className="auth-copyright">© {new Date().getFullYear()} Veltram</p>
    </section>
  </main>;
}
