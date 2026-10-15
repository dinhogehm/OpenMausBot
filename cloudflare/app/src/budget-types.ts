/** Budget RPCs are internal Worker capabilities, never public request payloads. */
export const BUDGET_DEFAULT_LIMIT_BRL_MICROS = 1_000_000_000;
export const BUDGET_TIMEZONE = "America/Sao_Paulo";
export interface BudgetScope { organizationId: string; userId: string }
export interface SourceSnapshot { url: string; sha256: string; fetchedAt: number; expiresAt: number }
export interface FxSnapshot extends SourceSnapshot { baseDate: string; brlPerUsdMicros: number; source: "BCB_PTAX_VENDA" }
export interface PriceSnapshot extends SourceSnapshot {
  provider: "openrouter"; model: string; endpoint: string; contextTokens: number; maxOutputTokens: number;
  promptUsdNanos: number; completionUsdNanos: number; requestUsdNanos: number;
  cacheReadUsdNanos: number; cacheWriteUsdNanos: number;
}
export interface OpenRouterBudgetControls {
  model: string; max_tokens: number; stream: false;
  provider: { only: string[]; allow_fallbacks: false; require_parameters: true; max_price: { prompt: number; completion: number; request: number; image: 0 } };
}
export interface BudgetReserveInput extends BudgetScope {
  reservationId: string; operationId: string; provider: "openrouter"; model: string; maxOutputTokens: number; requestHash: string;
}
export type BudgetReservationStatus = "reserved" | "dispatched" | "settled" | "uncertain" | "released";
export interface BudgetUsage {
  providerRequestId?: string; providerName?: string; model?: string;
  promptTokens?: number; completionTokens?: number; totalTokens?: number;
  cachedTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number;
  costUsdNanos?: number; upstreamCostUsdNanos?: number;
  priced: boolean; payloadHash: string;
}
export interface BudgetReservation extends BudgetReserveInput {
  status: BudgetReservationStatus; day: string; createdAt: number; updatedAt: number; dispatchedAt?: number; settledAt?: number;
  maxUsdNanos: number; maxBrlMicros: number; actualBrlMicros?: number;
  price: PriceSnapshot; fx: FxSnapshot; controls: OpenRouterBudgetControls; usage?: BudgetUsage;
}
export interface BudgetConfiguration { version: number; limitBrlMicros: number; updatedAt: number; updatedBy: string | null }
export interface BudgetView {
  organizationId: string; day: string; timezone: typeof BUDGET_TIMEZONE; currency: "BRL"; unit: "micros";
  scope: "estimated_api_inference"; exclusions: ["subscriptions", "infrastructure", "taxes", "payment_fees"];
  enforcement?: { required: boolean; paidApiAvailable: boolean };
  configuration: BudgetConfiguration; settledBrlMicros: number; reservedBrlMicros: number; carryoverBrlMicros: number;
  availableBrlMicros: number; overrunBlocked: boolean; canEdit: boolean;
}
export interface BudgetRpc {
  get(scope: BudgetScope): Promise<BudgetView>;
  configure(input: BudgetScope & { expectedVersion: number; limitBrlMicros: number }): Promise<BudgetView>;
  reserve(input: BudgetReserveInput): Promise<BudgetReservation>;
  dispatch(input: { organizationId: string; reservationId: string }): Promise<{ dispatchAllowed: boolean; reservation: BudgetReservation }>;
  observe(input: { organizationId: string; reservationId: string; response: unknown }): Promise<BudgetReservation>;
  uncertain(input: { organizationId: string; reservationId: string }): Promise<BudgetReservation>;
  releaseUndispatched(input: { organizationId: string; reservationId: string }): Promise<BudgetReservation>;
}
