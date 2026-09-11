import type { EffortLevel, ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { effortForTier, selectModelForTier, type ModelTier } from "../shared/model-tier.ts";

export interface SelectableInstance {
  instanceId: string;
  driverKind: string;
  snapshot: ProviderSnapshot;
  models: ModelCatalog;
  capabilities?: { effortLevels?: readonly EffortLevel[] };
}

/** A saved choice is intentional: an unavailable provider or removed model
 * sends new bots to setup instead of silently changing their provider. */
export function selectDefaultModelSelection(
  instances: readonly SelectableInstance[],
  preferred?: ModelSelection,
  tier?: ModelTier,
): ModelSelection {
  const base = baseSelection(instances, preferred);
  if (!tier || !base.instanceId) return base;
  const instance = instances.find((candidate) => candidate.instanceId === base.instanceId);
  return instance ? applyModelTier(base, instance, tier) : base;
}

function baseSelection(
  instances: readonly SelectableInstance[],
  preferred?: ModelSelection,
): ModelSelection {
  if (preferred) {
    const instance = instances.find((candidate) => candidate.instanceId === preferred.instanceId);
    if (
      instance?.snapshot.state !== "available" ||
      instance.snapshot.authenticated === false ||
      !(instance.models.default === preferred.model || instance.models.options.some((model) => model.id === preferred.model))
    ) {
      return { instanceId: "", model: "" };
    }
    const selection = { ...preferred };
    // A saved effort can outlive driver support. Keep the intentional model,
    // but let the provider use its own effort default instead of failing turn 1.
    if (selection.effort && !instance.capabilities?.effortLevels?.includes(selection.effort)) delete selection.effort;
    return selection;
  }
  const available = instances.filter((instance) => instance.snapshot.state === "available");
  const pick = available.find((instance) => instance.driverKind === "claudeAgent") ?? available[0];
  return { instanceId: pick?.instanceId ?? "", model: pick?.models.default ?? "" };
}

/** Retune a settled selection to the weight of the work, without leaving
 * the engine it is already on.
 *
 * The instance is never reconsidered here: which provider a bot runs on is
 * the user's choice (setup, or the bot's own picker), while a tier only
 * says how much model the job deserves. So a heavy weight on a
 * single-model engine simply keeps that model, and the effort flag is set
 * only when this driver reports the level — an unsupported flag would fail
 * the turn rather than fall back.
 */
export function applyModelTier(
  selection: ModelSelection,
  instance: SelectableInstance,
  tier: ModelTier,
): ModelSelection {
  const model = selectModelForTier(instance.models, tier);
  const next: ModelSelection = { ...selection, ...(model ? { model } : {}) };
  const effort = effortForTier(tier);
  if (instance.capabilities?.effortLevels?.includes(effort)) next.effort = effort;
  return next;
}
