import type { AgentSelections } from "./agent-catalog-types";
export interface DecisionModelState {
  provider: "jev";
  model: "jev-latest";
  version: number | null;
  status: "missing" | "configured" | "revoked";
  updatedAt: number | null;
  canRecommend: boolean;
}
export interface AgentRecommendation {
  catalogVersion: number;
  recommendation: AgentSelections | null;
  /** Validated probability of the selected option (pTop), not vendor confidence. */
  confidence: { coordinator: number; programmer: number; reviewer: number } | null;
  fallback: boolean;
  reason: "recommended" | "not_configured" | "insufficient_agents" | "busy_or_limited" | "timeout" | "unavailable" | "invalid_response" | "uncertain" | "configuration_changed";
}
