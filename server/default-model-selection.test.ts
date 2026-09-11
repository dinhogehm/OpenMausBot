import { describe, expect, it } from "vitest";

import type { ModelCatalog, ProviderSnapshot } from "./contracts.ts";
import { applyModelTier, selectDefaultModelSelection } from "./default-model-selection.ts";

const codex = {
  instanceId: "codex",
  driverKind: "codex",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: {
    default: "codex-default",
    options: [{ id: "codex-default", label: "Default" }, { id: "selected-model", label: "Selected" }],
  } satisfies ModelCatalog,
  capabilities: { effortLevels: ["low", "high"] as const },
};
const claude = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: { default: "claude-default", options: [{ id: "claude-default", label: "Claude" }] },
};

describe("new bot default model selection", () => {
  it.each(["low", "high"] as const)("honors the configured provider, model, and supported %s effort ahead of the Claude preference", (effort) => {
    const preferred = { instanceId: "codex", model: "selected-model", effort };
    const selection = selectDefaultModelSelection([claude, codex], preferred);
    expect(selection).toEqual(preferred);
    expect(selection).not.toBe(preferred);
  });

  it.each([
    { label: "missing capabilities", capabilities: undefined },
    { label: "no effort control", capabilities: {} },
    { label: "empty effort list", capabilities: { effortLevels: [] } },
    { label: "changed effort support", capabilities: { effortLevels: ["low"] as const } },
  ])("omits stale effort for $label without changing the provider, model, or saved preference", ({ capabilities }) => {
    const preferred = { instanceId: "codex", model: "selected-model", effort: "high" as const };
    const selection = selectDefaultModelSelection([
      { ...claude, capabilities: { effortLevels: ["high"] } },
      { ...codex, capabilities },
    ], preferred);
    expect(selection).toEqual({ instanceId: "codex", model: "selected-model" });
    expect(selection).not.toHaveProperty("effort");
    expect(preferred.effort).toBe("high");
  });

  it("accepts the provider default even when it is not repeated in its options", () => {
    expect(selectDefaultModelSelection(
      [{ ...codex, models: { default: "codex-default", options: [] } }],
      { instanceId: "codex", model: "codex-default" },
    )).toEqual({ instanceId: "codex", model: "codex-default" });
  });

  it.each([
    { label: "missing provider", instances: [claude] },
    { label: "unavailable provider", instances: [claude, { ...codex, snapshot: { state: "unavailable" as const } }] },
    { label: "signed-out provider", instances: [claude, { ...codex, snapshot: { state: "available" as const, authenticated: false } }] },
    { label: "removed model", instances: [claude, { ...codex, models: { default: "new-model", options: [] } }] },
  ])("returns setup for a saved $label without changing provider", ({ instances }) => {
    expect(selectDefaultModelSelection(instances, { instanceId: "codex", model: "selected-model" }))
      .toEqual({ instanceId: "", model: "" });
  });

  it("keeps the existing Claude preference when no default was saved", () => {
    expect(selectDefaultModelSelection([codex, claude])).toEqual({ instanceId: "claude", model: "claude-default" });
    expect(selectDefaultModelSelection([codex])).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(selectDefaultModelSelection([])).toEqual({ instanceId: "", model: "" });
  });
});

describe("weighing a new bot's work", () => {
  const weighted = {
    instanceId: "claude",
    driverKind: "claudeAgent",
    snapshot: { state: "available" as const, authenticated: true },
    models: {
      default: "claude-sonnet-5",
      options: [
        { id: "claude-opus-5", label: "Claude Opus 5" },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      ],
    },
    capabilities: { effortLevels: ["low", "medium", "high"] as const },
  };

  it.each([
    ["light", "claude-haiku-4-5", "low"],
    ["standard", "claude-sonnet-5", "medium"],
    ["heavy", "claude-opus-5", "high"],
  ] as const)("gives %s work %s", (tier, model, effort) => {
    expect(selectDefaultModelSelection([weighted], undefined, tier))
      .toEqual({ instanceId: "claude", model, effort });
  });

  it("moves the model but never the provider the user chose", () => {
    const selection = selectDefaultModelSelection(
      [
        weighted,
        {
          ...codex,
          models: {
            default: "codex-default",
            options: [
              { id: "codex-default", label: "Codex" },
              { id: "selected-model", label: "Selected" },
              { id: "codex-max", label: "Codex Max" },
            ],
          },
        },
      ],
      { instanceId: "codex", model: "selected-model" },
      "heavy",
    );
    expect(selection).toEqual({ instanceId: "codex", model: "codex-max", effort: "high" });
  });

  it("keeps the engine's only model when it has no such weight to give", () => {
    expect(selectDefaultModelSelection([claude], undefined, "heavy"))
      .toEqual({ instanceId: "claude", model: "claude-default" });
  });

  it("leaves effort alone on a driver that does not take it", () => {
    const selection = selectDefaultModelSelection([{ ...weighted, capabilities: undefined }], undefined, "heavy");
    expect(selection).toEqual({ instanceId: "claude", model: "claude-opus-5" });
    expect(selection).not.toHaveProperty("effort");
  });

  it("sets only the levels the driver reports", () => {
    const selection = selectDefaultModelSelection(
      [{ ...weighted, capabilities: { effortLevels: ["low", "high"] as const } }],
      undefined,
      "standard",
    );
    expect(selection).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
  });

  it("changes nothing without a tier", () => {
    expect(selectDefaultModelSelection([weighted])).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
  });

  it("retunes a Chief's own selection in place, for the bots it creates", () => {
    const chief = { instanceId: "claude", model: "claude-opus-5", effort: "high" as const };
    expect(applyModelTier(chief, weighted, "light"))
      .toEqual({ instanceId: "claude", model: "claude-haiku-4-5", effort: "low" });
    expect(chief.model).toBe("claude-opus-5");
  });
});
