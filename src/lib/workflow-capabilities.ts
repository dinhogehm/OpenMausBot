// The renderer's side of per-bot workflow permissions. The shared validator
// (`capabilityIssues`) decides what is an error, and its `missingCapabilities`
// is the only place a capability name meets the profile flag that grants it;
// everything here is built on that one function, so the panel and the card
// can never disagree with a badge. What is added is the shape the UI needs:
// a lookup over the store roster, per-capability questions ("does THIS bot
// hold THIS one?") that an issue message alone cannot answer, tolerance for a
// bot that no longer resolves, and the one editing rule for `requires`.
import {
  WORKFLOW_CAPABILITIES,
  missingCapabilities as capabilitiesMissingFrom,
  type BotCapabilities,
  type WorkflowCapability,
} from "../../shared/workflow";

export interface CapabilityBearer extends BotCapabilities {
  id: string;
}

/** A store bot cut down to the two flags the shared validator reads. */
export function botCapabilities(bot: BotCapabilities): BotCapabilities {
  return { canMerge: bot.canMerge, canDeploy: bot.canDeploy };
}

/** The `lookup` `capabilityIssues` takes, over the roster as it stands right
 * now; `null` for an id the roster no longer has. */
export function capabilityLookup(
  bots: readonly CapabilityBearer[],
): (botId: string) => BotCapabilities | null {
  return (botId) => {
    const bot = bots.find((candidate) => candidate.id === botId);
    return bot ? botCapabilities(bot) : null;
  };
}

/** Absent is not allowed — the flag has to be `true`, never merely present. */
export function hasCapability(bot: BotCapabilities | null | undefined, capability: WorkflowCapability): boolean {
  return bot != null && capabilitiesMissingFrom([capability], bot).length === 0;
}

/** What a bot is allowed to do, in the shared order — the tags a picker
 * shows next to its name. */
export function grantedCapabilities(bot: BotCapabilities | null | undefined): WorkflowCapability[] {
  return WORKFLOW_CAPABILITIES.filter((capability) => hasCapability(bot, capability));
}

/** Of what a node requires, the capabilities its bot does not hold. A bot
 * that no longer resolves holds none of them — the validator skips that
 * node (the missing bot is the louder problem), so the card judges its tags
 * here instead. */
export function missingCapabilities(
  requires: WorkflowCapability[] | undefined,
  bot: BotCapabilities | null | undefined,
): WorkflowCapability[] {
  return bot == null ? [...(requires ?? [])] : capabilitiesMissingFrom(requires, bot);
}

/** One requirement ticked or unticked. The result is `undefined` — the key
 * to OMIT — when nothing is left: the API takes an absent field, never
 * `null`, and `[]` would be a needless diff on every node. Order follows the
 * shared list, so two authors ticking the same boxes write the same document. */
export function toggleRequirement(
  requires: readonly WorkflowCapability[] | undefined,
  capability: WorkflowCapability,
  on: boolean,
): WorkflowCapability[] | undefined {
  const next = new Set(requires ?? []);
  if (on) next.add(capability);
  else next.delete(capability);
  const ordered = WORKFLOW_CAPABILITIES.filter((candidate) => next.has(candidate));
  return ordered.length === 0 ? undefined : ordered;
}
