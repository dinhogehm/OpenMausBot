// Model validation and permission changes share the same provider checks.
import { approvalModeFor, modelSwitchNeedsAsk, type ApprovalMode } from "../../shared/approval-mode.ts";
import { isEffortLevel } from "../../shared/wire.ts";
import { isModelVariant } from "../contracts.ts";
import type { ModelSelection } from "../contracts.ts";
import type { Store, BotRecord } from "../store.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import type { hostedModelPolicy } from "../hosted-models.ts";

type ModelSelectionDeps = {
  readonly store: Store;
  registry: ProviderRegistry;
  hostedModels: ReturnType<typeof hostedModelPolicy>;
  readonly providerInstancesChanging: ReadonlySet<string>;
  threadBusy(botId: string, threadId: string): boolean;
  activeGroupTurnForBot(botId: string): unknown;
};
export function createModelSelectionRuntime(deps: ModelSelectionDeps) {
  const { registry, hostedModels, threadBusy, activeGroupTurnForBot } = deps;
function checkedModelSelection(
  raw: unknown,
  current?: { selection: ModelSelection; busy: boolean },
  requireAvailableModel = false,
): { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "modelSelection must be an object" };
  }
  const value = raw as { instanceId?: unknown; model?: unknown; effort?: unknown; variant?: unknown };
  if (typeof value.instanceId !== "string" || !value.instanceId.trim()) {
    return { ok: false, status: 400, error: "modelSelection.instanceId is required" };
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    return { ok: false, status: 400, error: "modelSelection.model is required" };
  }
  const selection: ModelSelection = {
    instanceId: value.instanceId.trim(),
    model: value.model.trim(),
  };
  if (hostedModels && !hostedModels.allows(selection)) return { ok: false, status: 400, error: hostedModels.error() };
  if (value.effort !== undefined) {
    if (!isEffortLevel(value.effort)) {
      return { ok: false, status: 400, error: `effort "${String(value.effort)}" is not recognized` };
    }
    selection.effort = value.effort;
  }
  if (value.variant !== undefined) {
    if (!isModelVariant(value.variant)) {
      return { ok: false, status: 400, error: "variant must be a non-empty model variant ID" };
    }
    if (value.effort !== undefined) {
      return { ok: false, status: 400, error: "choose either a model variant or an effort level" };
    }
    selection.variant = value.variant;
  }
  const changed = current && (
    selection.instanceId !== current.selection.instanceId ||
    selection.model !== current.selection.model ||
    selection.effort !== current.selection.effort ||
    selection.variant !== current.selection.variant
  );
  if (current?.busy && changed) {
    return { ok: false, status: 409, error: "the bot is working — stop it before changing models" };
  }
  const target = registry.get(selection.instanceId);
  if (deps.providerInstancesChanging.has(selection.instanceId)) {
    return { ok: false, status: 409, error: "this provider account is being updated — try again shortly" };
  }
    // Free-form model ids: custom engines accept ids outside their catalog, and some drivers learn the catalog only at turn start.
  if (requireAvailableModel) {
    if (!target) {
      return { ok: false, status: 400, error: `model instance "${selection.instanceId}" is unavailable` };
    }
    const offered =
      selection.model === target.models.default ||
      target.models.options.some((option) => option.id === selection.model);
    if (!offered) {
      return {
        ok: false,
        status: 400,
        error: `model "${selection.model}" is not offered by instance "${selection.instanceId}"`,
      };
    }
  }
  const allowed: readonly string[] = target?.adapter.capabilities.effortLevels ?? [];
  if (target && selection.effort !== undefined && !allowed.includes(selection.effort)) {
    return { ok: false, status: 400, error: `effort "${selection.effort}" is not offered by this bot's engine` };
  }
  if (target && selection.variant !== undefined && !target.adapter.capabilities.modelVariants) {
    return { ok: false, status: 400, error: "model variants are not offered by this bot's engine" };
  }
  return { ok: true, selection };
}

/** Whether moving onto `to` must first drop `mode` to Ask: the shared rule
 * (modelSwitchNeedsAsk), so every route agrees. fork: neither Full nor Custom
 * crosses engines (upstream lets Full carry since Oct 12). */
function engineSwitchNeedsAsk(mode: ApprovalMode, from: ModelSelection, to: ModelSelection): boolean {
  return modelSwitchNeedsAsk(mode, registry.cliTarget(from.instanceId)?.driverKind, registry.cliTarget(to.instanceId)?.driverKind);
}

function checkedTaskModelSwitch(current: BotRecord, raw: unknown, updateBotDefault: boolean,
  resetApprovalToAsk: boolean, requireAvailableModel = false, trusted = false) {
  if (current.approvalGrant) return { ok: false as const, status: 409, error: "Wait for the approval change to finish before switching models" };
  const checked = checkedModelSelection(raw, {
    selection: current.modelSelection, busy: threadBusy(current.id, current.threadId),
  }, requireAvailableModel);
  if (!checked.ok) return checked;
  const profile = deps.store.bot(current.id)!;
  if (updateBotDefault) {
    const defaults = checkedModelSelection(checked.selection, {
      selection: profile.modelSelection, busy: Boolean(activeGroupTurnForBot(current.id)),
    });
    if (!defaults.ok) return defaults;
  }
  for (const target of updateBotDefault ? [current, profile] : [current]) {
    const mode = approvalModeFor(target);
    if (resetApprovalToAsk && mode === "custom" && !trusted) {
      return { ok: false as const, status: 403, error: "Leaving Custom approval requires confirmation in the packaged desktop app" };
    }
    if (!resetApprovalToAsk && modelSwitchNeedsAsk(mode,
      registry.cliTarget(target.modelSelection.instanceId)?.driverKind,
      registry.cliTarget(checked.selection.instanceId)?.driverKind)) {
      return { ok: false as const, status: 400, error: "Confirm switching this model with Ask permissions first (resetApprovalToAsk)" };
    }
  }
  if (resetApprovalToAsk && (threadBusy(current.id, current.threadId) ||
    (updateBotDefault && activeGroupTurnForBot(current.id)))) {
    return { ok: false as const, status: 409, error: "Stop work in the selected scope before switching its permissions" };
  }
  return checked;
}

  return { checkedModelSelection, engineSwitchNeedsAsk, checkedTaskModelSwitch };
}
