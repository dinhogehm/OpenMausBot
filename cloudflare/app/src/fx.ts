import type { FxSnapshot } from "./budget-types";
import { budgetDay, decimalUnits, publicJson, record } from "./budget-math";

// BCB PTAX sell closing reference; not card settlement, taxes or payment fees.
// https://dadosabertos.bcb.gov.br/dataset/dolar-americano-usd-todos-os-boletins-diarios
export const FX_MAX_AGE_MS = 5 * 86400000; // Explicit freshness policy, not an FX guarantee.
export const FX_REFRESH_MS = 60 * 60_000;
export async function fetchPtax(now = Date.now(), requestFetch: typeof fetch = fetch): Promise<FxSnapshot> {
  const format = (date: string) => `${date.slice(5, 7)}-${date.slice(8, 10)}-${date.slice(0, 4)}`;
  const url = new URL("https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)");
  url.searchParams.set("@dataInicial", `'${format(budgetDay(now - 8 * 86400000))}'`);
  url.searchParams.set("@dataFinalCotacao", `'${format(budgetDay(now))}'`); url.searchParams.set("$format", "json");
  const source = await publicJson(url.href, requestFetch, 65536), value = record(source.data).value;
  if (!Array.isArray(value) || value.length > 100) throw new Error("budget_fx_invalid");
  const rows = value.map((item) => {
    const row = record(item);
    if (typeof row.dataHoraCotacao !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/.test(row.dataHoraCotacao)) throw new Error("budget_fx_invalid");
    const at = Date.parse(row.dataHoraCotacao.slice(0, 19).replace(" ", "T") + "-03:00");
    const rate = decimalUnits(row.cotacaoVenda, 6);
    if (!Number.isFinite(at) || at > now || !rate || rate > 1_000_000_000) throw new Error("budget_fx_invalid");
    return { at, rate, date: row.dataHoraCotacao.slice(0, 10) };
  }).sort((a, b) => b.at - a.at);
  const latest = rows[0];
  if (!latest || now - latest.at > FX_MAX_AGE_MS) throw new Error("budget_fx_stale");
  return { source: "BCB_PTAX_VENDA", url: url.href, sha256: source.sha256, fetchedAt: now,
    expiresAt: Math.min(now + FX_REFRESH_MS, latest.at + FX_MAX_AGE_MS), baseDate: latest.date, brlPerUsdMicros: latest.rate };
}
