/** How much model a job needs, said in a way no provider owns.
 *
 * A tier is a *need*, never a model id. A team file, a bot package or a
 * Chief of Staff may say that a researcher wants heavy reasoning and a
 * note-taker wants the cheap end, but none of them may pin the user to a
 * provider, an engine or a model they never chose: a tier is always
 * resolved against the catalog of the instance the bot already runs on,
 * so only the model *within* that engine moves. That is what keeps
 * `importedMemberProfile`'s allowlist honest — a weight is a hint about
 * the work, not a grant.
 *
 * The three tiers exist to spend money where it changes the answer:
 *
 *   light     short, mechanical, high-volume work — triage, extraction,
 *             titles, summaries of something already written down.
 *   standard  the day's work: writing, reviewing, ordinary code, the
 *             judgement calls a competent generalist makes.
 *   heavy     long-horizon reasoning worth paying for — architecture,
 *             debugging something subtle, planning a whole team's work.
 */
export const MODEL_TIERS = ["light", "standard", "heavy"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** What an agent gets when nobody said otherwise. */
export const DEFAULT_MODEL_TIER: ModelTier = "standard";

/** Narrow untrusted manifest/API/tool input before it becomes a tier. */
export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);
}

export interface TierCatalogOption {
  id: string;
  label?: string;
}

export interface TierCatalog {
  default: string;
  options: readonly TierCatalogOption[];
}

// Matched against the model id and its label together, most specific
// first. Catalogs are provider-authored and grow without us, so an id we
// do not recognise is deliberately "standard" rather than a guess in
// either direction — an unknown model is never silently promoted to the
// expensive tier, nor demoted below the work.
const LIGHT = /\b(haiku|mini|flash|lite|spark|nano|small|tiny|micro|instant|turbo)\b|[-_.](mini|lite|nano|air)\b/i;
const HEAVY = /\b(opus|max|ultra|thinking|reasoner|heavy|deep)\b|[-_.](max|thinking)\b/i;

/** Which tier an existing model already sits in — used when exporting a
 * team, so a shared file carries the *shape* of the roster the user tuned
 * rather than their private model ids. */
export function modelTierOf(model: string, label?: string): ModelTier {
  const text = `${model} ${label ?? ""}`;
  if (LIGHT.test(text)) return "light";
  if (HEAVY.test(text)) return "heavy";
  return DEFAULT_MODEL_TIER;
}

/** The model in this catalog that fits `tier`, staying on this engine.
 *
 * The catalog default wins whenever it already fits: the user configured
 * it, and a tier is a nudge toward the right weight, not a reason to walk
 * away from their choice. A catalog with nothing in the asked-for tier —
 * a single-model provider, a local runtime — falls back to that default
 * too, so asking for weight the engine does not have is never an error.
 */
export function selectModelForTier(catalog: TierCatalog, tier: ModelTier): string {
  const fallback = catalog.default || catalog.options[0]?.id || "";
  const defaultOption = catalog.options.find((option) => option.id === catalog.default);
  if (fallback && modelTierOf(fallback, defaultOption?.label) === tier) return fallback;
  const match = catalog.options.find((option) => modelTierOf(option.id, option.label) === tier);
  return match?.id ?? fallback;
}

/** Reasoning effort that goes with a tier, for the drivers that expose it.
 * The caller must still check the instance actually supports the level —
 * an unsupported effort flag fails the turn instead of the model. */
export function effortForTier(tier: ModelTier): "low" | "medium" | "high" {
  if (tier === "light") return "low";
  if (tier === "heavy") return "high";
  return "medium";
}
