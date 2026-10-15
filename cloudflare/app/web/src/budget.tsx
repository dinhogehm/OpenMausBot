import { useNavigationGuard } from "./navigation-guard";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BudgetView } from "../../src/budget-types";
import { api, errorMessage, isAbort, organizationPath } from "./api";
import { Loading, Notice } from "./components";

const brl = (micros: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(micros / 1_000_000);
const budgetDay = (day: string) => new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));

export function BudgetSettings({ organizationId, onView }: { organizationId: string; onView?: (view: BudgetView | null) => void }) {
  const [view, setView] = useState<BudgetView | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [limit, setLimit] = useState(""); const [busy, setBusy] = useState(false); const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
  const mutation = useRef<AbortController | null>(null);
  const limitInput = useRef<HTMLInputElement | null>(null);
  const budgetHeading = useRef<HTMLHeadingElement | null>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!busy && restoreFocus.current) {
      restoreFocus.current = false;
      (limitInput.current ?? budgetHeading.current)?.focus();
    }
  }, [busy]);
  const path = `${organizationPath(organizationId)}/budget`;
  useEffect(() => { setBusy(false); return () => mutation.current?.abort(); }, [path]);
  useEffect(() => {
    const controller = new AbortController(); setError(""); setRefreshing(true);
    void api<BudgetView>(path, { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) { setView(next); onView?.(next); setLimit((next.configuration.limitBrlMicros / 1_000_000).toFixed(2)); }
    }).catch((failure: unknown) => { if (!isAbort(failure)) { setError(errorMessage(failure)); onView?.(null); } })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [path, attempt, onView]);
  const amount = Number(limit);
  const amountValid = limit.trim() !== "" && Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000;
  const dirty = view !== null && Math.round(amount * 1_000_000) !== view.configuration.limitBrlMicros;
  useNavigationGuard({ dirty, busy });
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || refreshing || !view?.canEdit || !amountValid || !dirty) return;
    const controller = new AbortController(); mutation.current = controller; setBusy(true); setError(""); setNotice("");
    try {
      const next = await api<BudgetView>(path, { method: "PUT", signal: controller.signal, body: { expectedVersion: view.configuration.version, limitBrlMicros: Math.round(amount * 1_000_000) } });
      if (!controller.signal.aborted) { setView(next); onView?.(next); setNotice("Limite diário atualizado. Chamadas já enviadas continuam contabilizadas."); }
    } catch (failure) { if (!isAbort(failure)) setError(errorMessage(failure)); }
    finally {
      if (!controller.signal.aborted) {
        restoreFocus.current = true;
        setBusy(false);
      }
    }
  }
  function discard() {
    if (view) setLimit((view.configuration.limitBrlMicros / 1_000_000).toFixed(2));
    setError(""); setNotice("");
    limitInput.current?.focus();
  }
  return <section id="daily-api-budget" className="connections-section budget-section" aria-labelledby="budget-heading">
    <div className="section-heading"><div><h2 ref={budgetHeading} tabIndex={-1} id="budget-heading">Orçamento de API</h2><p className="muted">Limite diário estimado para a empresa, em reais.</p></div><button className="text-button" disabled={busy || refreshing || dirty} onClick={() => { setNotice(""); setAttempt((n) => n + 1); }}>{refreshing ? "Atualizando…" : error ? "Tentar atualizar" : "Atualizar consumo"}</button></div>
    {error && <Notice>{error}{dirty && " Seu valor não foi descartado. Para atualizar os dados, desfaça a alteração primeiro."}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
    {!view && !error && <Loading label="Carregando orçamento" />}
    {view && <>
      {view.enforcement?.required && !view.enforcement.paidApiAvailable && <p className="budget-pause-note"><strong>Uso de API pausado.</strong> Salvar um limite não libera conexões que ainda aguardam validação de cobrança.</p>}
      {view.overrunBlocked && <Notice>O consumo observado ultrapassou uma reserva. Novas chamadas pagas estão pausadas para conferência.</Notice>}
      <div className="budget-layout">
        <div className="budget-ledger"><h3>Consumo em {budgetDay(view.day)}</h3><p className="field-hint">O dia é contabilizado no horário de São Paulo.</p>
          <dl><div><dt>Consumo apurado</dt><dd>{brl(view.settledBrlMicros)}</dd></div><div><dt>Reservado hoje</dt><dd>{brl(view.reservedBrlMicros)}</dd></div><div><dt>Pendente de dias anteriores</dt><dd>{brl(view.carryoverBrlMicros)}</dd></div><div className="budget-available"><dt>Saldo estimado disponível</dt><dd>{brl(view.availableBrlMicros)}</dd></div></dl>
        </div>
        <div className="budget-limit">
          <h3>Limite da empresa</h3>
          {view.canEdit ? <form className="form-stack budget-form" onSubmit={save}>
            <div className="field"><label htmlFor="ai-daily-budget">Valor por dia (R$)</label><input ref={limitInput} id="ai-daily-budget" type="number" min="0" max="1000000" step="0.01" inputMode="decimal" value={limit} onChange={(event) => { setLimit(event.target.value); setNotice(""); }} disabled={busy || refreshing} required aria-describedby="ai-daily-budget-help" /><p className="field-hint" id="ai-daily-budget-help">Zero pausa novas chamadas pagas. Reduzir o limite não desfaz chamadas já enviadas.</p></div>
            <div className="button-row"><button className="button primary" disabled={busy || refreshing || !amountValid || !dirty}>{busy ? "Salvando…" : "Salvar limite"}</button>{dirty && <button type="button" className="button secondary" disabled={busy || refreshing} onClick={discard}>Desfazer alteração</button>}</div>
          </form> : <><p className="budget-current-limit">{brl(view.configuration.limitBrlMicros)} por dia</p><p className="field-hint">Somente administradores podem alterar o limite.</p></>}
        </div>
      </div>
    </>}
    <details className="connection-details"><summary>Como o orçamento é calculado</summary><p>O controle usa preços dos provedores e câmbio PTAX. Chamadas sem resultado confirmado continuam reservando saldo, inclusive em dias seguintes. O valor da fatura pode ser diferente.</p><p>Não inclui assinaturas pessoais, infraestrutura, tributos ou tarifas de pagamento. Provedores e modos de cobrança sem controle compatível permanecem bloqueados.</p></details>
  </section>;
}
