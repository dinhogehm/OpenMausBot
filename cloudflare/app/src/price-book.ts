import type { OpenRouterBudgetControls, PriceSnapshot } from "./budget-types";
import { count, decimalUnits, publicJson, record, safeInteger } from "./budget-math";

// Official metadata and routing caps (prices returned in USD per token):
// https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints
// https://openrouter.ai/docs/guides/routing/provider-selection#max-price
export const PRICE_TTL_MS = 15 * 60_000;
export function openRouterPriceUrl(model: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model) || model.startsWith("openrouter/")) throw new Error("budget_model_unpriced");
  return `https://openrouter.ai/api/v1/models/${model}/endpoints`;
}
export function priceMaximum(price: PriceSnapshot, outputTokens: number): number {
  count(outputTokens, price.maxOutputTokens);
  if (!outputTokens) throw new Error("budget_count_invalid");
  const prompt = Math.max(price.promptUsdNanos, price.cacheReadUsdNanos, price.cacheWriteUsdNanos);
  // Entire context is reserved as input, plus output; intentionally conservative.
  return safeInteger(BigInt(price.contextTokens) * BigInt(prompt) + BigInt(outputTokens) * BigInt(price.completionUsdNanos) + BigInt(price.requestUsdNanos));
}
export function openRouterControls(price: PriceSnapshot, outputTokens: number): OpenRouterBudgetControls {
  priceMaximum(price, outputTokens);
  return { model: price.model, max_tokens: outputTokens, stream: false,
    provider: { only: [price.endpoint], allow_fallbacks: false, require_parameters: true,
      max_price: { prompt: price.promptUsdNanos / 1000, completion: price.completionUsdNanos / 1000, request: price.requestUsdNanos / 1_000_000_000, image: 0 } } };
}
export async function fetchOpenRouterPrice(model: string, outputTokens: number, now = Date.now(), requestFetch: typeof fetch = fetch): Promise<PriceSnapshot> {
  const url = openRouterPriceUrl(model); const source = await publicJson(url, requestFetch);
  const data = record(record(source.data).data);
  if (data.id !== model || !Array.isArray(data.endpoints) || data.endpoints.length > 200
    || JSON.stringify(record(data.architecture).output_modalities) !== '["text"]') throw new Error("budget_model_unpriced");
  const prices: PriceSnapshot[] = [];
  for (const value of data.endpoints) {
    try {
      const endpoint = record(value), pricing = record(endpoint.pricing);
      if (typeof endpoint.tag !== "string" || !/^[a-z0-9][a-z0-9_./-]{0,100}$/.test(endpoint.tag)
        || !Array.isArray(endpoint.supported_parameters) || !endpoint.supported_parameters.includes("max_tokens")) continue;
      const known = ["prompt", "completion", "request", "input_cache_read", "input_cache_write", "discount"];
      // No guessed rates for media, search, server tools, reasoning surcharges or tiers.
      if (Object.entries(pricing).some(([key, amount]) => !known.includes(key) && decimalUnits(amount, 9) !== 0)
        || (pricing.discount !== undefined && decimalUnits(pricing.discount, 9) !== 0)) continue;
      const contextTokens = count(endpoint.context_length, 10_000_000), maxOutputTokens = count(endpoint.max_completion_tokens, 1_000_000);
      if (!contextTokens || !maxOutputTokens || outputTokens > maxOutputTokens || outputTokens > contextTokens) continue;
      const promptUsdNanos = decimalUnits(pricing.prompt, 9), completionUsdNanos = decimalUnits(pricing.completion, 9);
      prices.push({ url, sha256: source.sha256, fetchedAt: now, expiresAt: now + PRICE_TTL_MS, provider: "openrouter", model,
        endpoint: endpoint.tag, contextTokens, maxOutputTokens, promptUsdNanos, completionUsdNanos,
        requestUsdNanos: decimalUnits(pricing.request ?? "0", 9), cacheReadUsdNanos: decimalUnits(pricing.input_cache_read ?? pricing.prompt, 9),
        cacheWriteUsdNanos: decimalUnits(pricing.input_cache_write ?? pricing.prompt, 9) });
    } catch { /* An endpoint without a provable bound is ineligible. */ }
  }
  // A base provider slug also matches its variants: only accept it when every
  // matching endpoint is priced, and reserve the maximum of the matching group.
  const safe: PriceSnapshot[] = [];
  for (const price of prices) {
    const matching = data.endpoints.filter((value) => { const tag = record(value).tag; return typeof tag === "string" && (tag === price.endpoint || tag.startsWith(price.endpoint + "/")); });
    const priced = prices.filter((p) => p.endpoint === price.endpoint || p.endpoint.startsWith(price.endpoint + "/"));
    if (matching.length !== priced.length) continue;
    const combined = { ...price };
    for (const key of ["contextTokens", "promptUsdNanos", "completionUsdNanos", "requestUsdNanos", "cacheReadUsdNanos", "cacheWriteUsdNanos"] as const) combined[key] = Math.max(...priced.map((p) => p[key]));
    safe.push(combined);
  }
  safe.sort((a, b) => priceMaximum(a, outputTokens) - priceMaximum(b, outputTokens) || a.endpoint.localeCompare(b.endpoint));
  if (!safe[0]) throw new Error("budget_model_unpriced");
  return safe[0];
}
