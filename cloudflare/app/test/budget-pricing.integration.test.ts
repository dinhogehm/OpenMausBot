import { expect, it, vi } from "vitest";
import { decimalUnits, brlMicros, budgetDay } from "../src/budget-math";
import { fetchOpenRouterPrice, priceMaximum, openRouterControls } from "../src/price-book";
import { fetchPtax } from "../src/fx";
import { observeOpenRouterUsage } from "../src/budget-usage";

const now = Date.parse("2026-10-13T18:00:00Z");
const endpoint = { tag: "fixture", context_length: 100000, max_completion_tokens: 10000, supported_parameters: ["max_tokens", "tools"], pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000075" } };
const catalog = () => ({ data: { id: "fixture/model", architecture: { output_modalities: ["text"] }, endpoints: [structuredClone(endpoint)] } });
it("uses integer arithmetic, rounds reservations upwards and keys the São Paulo day", () => {
  expect(decimalUnits("0.0000000001", 9)).toBe(1);
  expect(decimalUnits("1.5e-7", 9)).toBe(150);
  expect(brlMicros(1, 5009600)).toBe(1);
  expect(brlMicros(1_000_000_000, 5009600)).toBe(5009600);
  expect(budgetDay(Date.parse("2026-10-14T02:59:59Z"))).toBe("2026-10-13");
  expect(budgetDay(Date.parse("2026-10-14T03:00:00Z"))).toBe("2026-10-14");
  for (const value of ["-1", "NaN", "Infinity", "1e999", "", " 1"]) expect(() => decimalUnits(value, 9)).toThrow();
});
it("reserves the full endpoint context plus maximum output, with fixed routing and no paid fallback", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(catalog()));
  const price = await fetchOpenRouterPrice("fixture/model", 4096, now, fetcher);
  expect(priceMaximum(price, 4096)).toBe(100000 * 150 + 4096 * 600);
  expect(openRouterControls(price, 4096)).toMatchObject({ model: "fixture/model", max_tokens: 4096, stream: false, provider: { only: ["fixture"], allow_fallbacks: false, require_parameters: true, max_price: { prompt: .15, completion: .6, request: 0, image: 0 } } });
  expect(fetcher.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models/fixture/model/endpoints");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  expect(price.sha256).toMatch(/^[a-f0-9]{64}$/); expect(price.expiresAt).toBeGreaterThan(now);
});
it("rejects missing, negative, unknown billing dimensions, aliases and source redirects", async () => {
  for (const change of [{ pricing: {} }, { pricing: { prompt: "-1", completion: "0" } }, { pricing: { ...endpoint.pricing, unpriced_compute: "1" } }, { context_length: null }, { max_completion_tokens: 100 }]) {
    const data = catalog(); Object.assign(data.data.endpoints[0], change);
    await expect(fetchOpenRouterPrice("fixture/model", 4096, now, async () => Response.json(data))).rejects.toThrow();
  }
  await expect(fetchOpenRouterPrice("openrouter/auto", 4096, now, async () => Response.json(catalog()))).rejects.toThrow();
  await expect(fetchOpenRouterPrice("fixture/model", 4096, now, async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }))).rejects.toThrow();
});
it("selects the latest PTAX sell close, preserves its date over weekends, and expires stale sources", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ value: [{ cotacaoVenda: 5.0096, dataHoraCotacao: "2026-10-09 13:07:30.746597" }] }));
  const fx = await fetchPtax(Date.parse("2026-10-11T18:00:00Z"), fetcher);
  expect(fx).toMatchObject({ brlPerUsdMicros: 5009600, baseDate: "2026-10-09", source: "BCB_PTAX_VENDA" });
  expect(String(fetcher.mock.calls[0][0])).toContain("olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo");
  await expect(fetchPtax(Date.parse("2026-10-20T18:00:00Z"), fetcher)).rejects.toThrow("budget_fx_stale");
});
it("extracts ID, detailed usage and cost before functional parsing, while unknown is never zero", async () => {
  const result = await observeOpenRouterUsage({ id: "gen-fixture", model: "fixture/model", provider: "Fixture", choices: "malformed", usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: .0003, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 10 }, cost_details: { upstream_inference_cost: .00025 } } });
  expect(result).toMatchObject({ providerRequestId: "gen-fixture", promptTokens: 100, completionTokens: 20, cachedTokens: 40, cacheWriteTokens: 5, reasoningTokens: 10, costUsdNanos: 300000, upstreamCostUsdNanos: 250000, priced: true });
  for (const response of [{}, { id: "gen-missing", usage: { total_tokens: 1 } }, { usage: { cost: 0 } }, { id: "gen-negative", usage: { cost: -1 } }]) expect((await observeOpenRouterUsage(response)).priced).toBe(false);
});
it("bounds every matching provider variant and rejects a base with unpriced variants", async () => {
  const data = catalog(); data.data.endpoints.push({ ...structuredClone(endpoint), tag: "fixture/regional", context_length: 200000, pricing: { ...endpoint.pricing, prompt: "0.0000003" } });
  const price = await fetchOpenRouterPrice("fixture/model", 4096, now, async () => Response.json(data));
  expect(price.contextTokens).toBe(200000); expect(price.promptUsdNanos).toBe(300);
  Object.assign(data.data.endpoints[1], { pricing: { ...endpoint.pricing, extra_billing: "0.01" } });
  await expect(fetchOpenRouterPrice("fixture/model", 4096, now, async () => Response.json(data))).rejects.toThrow("budget_model_unpriced");
});
