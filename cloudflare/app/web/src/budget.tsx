import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BudgetView } from "../../src/budget-types";
import { api, errorMessage, isAbort, organizationPath } from "./api";
import { Loading, Notice } from "./components";

const brl = (micros: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(micros / 1_000_000);
export function BudgetSettings({ organizationId }: { organizationId: string }) {
  const [view, setView] = useState<BudgetView | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [limit, setLimit] = useState(""); const [busy, setBusy] = useState(false); const [attempt, setAttempt] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  const path = `${organizationPath(organizationId)}/budget`;
  useEffect(() => { setBusy(false); return () => mutation.current?.abort(); }, [path]);
  useEffect(() => {
    const controller = new AbortController(); setView(null); setError("");
    void api<BudgetView>(path, { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) { setView(next); setLimit((next.configuration.limitBrlMicros / 1_000_000).toFixed(2)); }
    }).catch((failure: unknown) => { if (!isAbort(failure)) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [path, attempt]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || !view?.canEdit) return;
    const amount = Number(limit); if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return;
    const controller = new AbortController(); mutation.current = controller; setBusy(true); setError(""); setNotice("");
    try {
      const next = await api<BudgetView>(path, { method: "PUT", signal: controller.signal, body: { expectedVersion: view.configuration.version, limitBrlMicros: Math.round(amount * 1_000_000) } });
      if (!controller.signal.aborted) { setView(next); setNotice("Limite diário atualizado. Compromissos de chamadas já enviadas continuam contabilizados."); }
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="provider" aria-labelledby="budget-heading">
    <div className="section-heading"><div><h2 id="budget-heading">Orçamento diário de API</h2><p className="muted">Controle estimado em reais, por empresa. O dia segue o horário de São Paulo.</p></div><button className="text-button" disabled={busy} onClick={() => { setNotice(""); setAttempt((n) => n + 1); }}>Atualizar consumo</button></div>
    {error && <Notice>{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
    {!view && !error && <Loading label="Carregando orçamento" />}
    {view && <>
      {view.enforcement?.required && !view.enforcement.paidApiAvailable && <Notice kind="info">O orçamento está configurado. Chamadas pagas de API estão pausadas enquanto os modos de cobrança das conexões são validados.</Notice>}
      <dl className="company-details"><div><dt>Consumo apurado de {view.day}</dt><dd>{brl(view.settledBrlMicros)}</dd></div><div><dt>Reservado neste dia</dt><dd>{brl(view.reservedBrlMicros)}</dd></div><div><dt>Compromissos pendentes de dias anteriores</dt><dd>{brl(view.carryoverBrlMicros)}</dd></div><div><dt>Disponível</dt><dd>{brl(view.availableBrlMicros)}</dd></div></dl>
      {view.overrunBlocked && <Notice>Foi observado consumo acima de uma reserva. Novas chamadas pagas estão pausadas para conferência.</Notice>}
      {view.canEdit ? <form className="form-stack credential-editor" onSubmit={save}><div className="field"><label htmlFor="ai-daily-budget">Limite por dia (R$)</label><input id="ai-daily-budget" type="number" min="0" max="1000000" step="0.01" value={limit} onChange={(event) => setLimit(event.target.value)} disabled={busy} required /><p className="field-hint">Zero pausa novas chamadas pagas. Reduzir o limite não desfaz consumo nem chamadas já enviadas.</p></div><button className="button primary" disabled={busy || !limit}>{busy ? "Salvando…" : "Salvar limite"}</button></form> : <p>Limite diário: <strong>{brl(view.configuration.limitBrlMicros)}</strong>. Alterações exigem acesso de administrador.</p>}
    </>}
    <p className="field-hint">Os valores usam preços dos provedores e câmbio PTAX. Assinaturas pessoais, infraestrutura, tributos e tarifas do pagamento não estão incluídos. Provedores e modos de cobrança ainda sem controle compatível ficam bloqueados. Chamadas sem resultado confirmado continuam comprometendo o saldo; o valor da fatura pode ser diferente.</p>
  </section>;
}
