import type { BudgetUsage } from "./budget-types";
import { count, decimalUnits, hashSource, record } from "./budget-math";

// https://openrouter.ai/docs/cookbook/administration/usage-accounting
// Called on the provider JSON BEFORE tools/choices are validated. No content is retained.
export async function observeOpenRouterUsage(response: unknown): Promise<BudgetUsage> {
  const observation: BudgetUsage = { priced: false, payloadHash: await hashSource(JSON.stringify(response) ?? "null") };
  try {
    const data = record(response);
    if (typeof data.id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(data.id)) observation.providerRequestId = data.id;
    if (typeof data.provider === "string" && data.provider.length <= 200) observation.providerName = data.provider;
    if (typeof data.model === "string" && data.model.length <= 200) observation.model = data.model;
    const usage = record(data.usage);
    const optionalCount = (value: unknown) => value === undefined || value === null ? undefined : count(value);
    observation.promptTokens = optionalCount(usage.prompt_tokens);
    observation.completionTokens = optionalCount(usage.completion_tokens);
    observation.totalTokens = optionalCount(usage.total_tokens);
    const prompt = usage.prompt_tokens_details == null ? {} : record(usage.prompt_tokens_details);
    const completion = usage.completion_tokens_details == null ? {} : record(usage.completion_tokens_details);
    observation.cachedTokens = optionalCount(prompt.cached_tokens); observation.cacheWriteTokens = optionalCount(prompt.cache_write_tokens);
    observation.reasoningTokens = optionalCount(completion.reasoning_tokens);
    const costDetails = usage.cost_details == null ? {} : record(usage.cost_details);
    if (costDetails.upstream_inference_cost != null) observation.upstreamCostUsdNanos = decimalUnits(costDetails.upstream_inference_cost, 9);
    observation.costUsdNanos = decimalUnits(usage.cost, 9);
    observation.priced = !!observation.providerRequestId && observation.promptTokens !== undefined && observation.completionTokens !== undefined
      && observation.totalTokens === observation.promptTokens + observation.completionTokens;
  } catch { observation.priced = false; }
  return observation;
}
