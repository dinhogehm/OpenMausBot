import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_TIER,
  effortForTier,
  isModelTier,
  modelTierOf,
  selectModelForTier,
} from "./model-tier";

describe("reading a tier off a model id", () => {
  it.each([
    "claude-haiku-4-5",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
    "grok-3-mini",
    "gemini-2.5-flash",
  ])("puts %s at the cheap end", (model) => {
    expect(modelTierOf(model)).toBe("light");
  });

  it.each(["claude-opus-5", "claude-sonnet-5-thinking-high", "gpt-5.4-max"])(
    "puts %s at the expensive end",
    (model) => {
      expect(modelTierOf(model)).toBe("heavy");
    },
  );

  it.each(["claude-sonnet-5", "gpt-5.6-sol", "glm-5.2", "something-nobody-shipped-yet"])(
    "leaves %s in the middle rather than guessing",
    (model) => {
      expect(modelTierOf(model)).toBe("standard");
    },
  );

  it("does not read a tier out of a word that merely contains one", () => {
    expect(modelTierOf("repair-bench-7")).toBe("standard");
    expect(modelTierOf("deepseek-v3")).toBe("standard");
  });

  it("reads the label too, for ids that carry no weight of their own", () => {
    expect(modelTierOf("local-7", "Qwen Mini")).toBe("light");
  });
});

describe("choosing a model for a tier", () => {
  const catalog = {
    default: "claude-sonnet-5",
    options: [
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
  };

  it.each([
    ["light", "claude-haiku-4-5"],
    ["standard", "claude-sonnet-5"],
    ["heavy", "claude-opus-5"],
  ] as const)("returns %s work to %s", (tier, model) => {
    expect(selectModelForTier(catalog, tier)).toBe(model);
  });

  it("keeps the configured default whenever it already fits the tier", () => {
    const tuned = { ...catalog, options: [{ id: "claude-sonnet-5" }, ...catalog.options] };
    expect(selectModelForTier(tuned, "standard")).toBe("claude-sonnet-5");
  });

  it("falls back to the default rather than failing when the engine has no such weight", () => {
    const single = { default: "only-model", options: [{ id: "only-model" }] };
    expect(selectModelForTier(single, "heavy")).toBe("only-model");
    expect(selectModelForTier(single, "light")).toBe("only-model");
  });

  it("survives a catalog whose default is missing from its own options", () => {
    expect(selectModelForTier({ default: "", options: [{ id: "claude-haiku-4-5" }] }, "heavy")).toBe(
      "claude-haiku-4-5",
    );
    expect(selectModelForTier({ default: "", options: [] }, "standard")).toBe("");
  });
});

describe("tier as untrusted input", () => {
  it.each(["light", "standard", "heavy"])("accepts %s", (value) => {
    expect(isModelTier(value)).toBe(true);
  });

  it.each(["", "LIGHT", "cheap", "opus", 3, null, undefined, {}])("rejects %p", (value) => {
    expect(isModelTier(value)).toBe(false);
  });

  it("defaults to the middle", () => {
    expect(DEFAULT_MODEL_TIER).toBe("standard");
    expect(effortForTier(DEFAULT_MODEL_TIER)).toBe("medium");
  });

  it("spends effort the way it spends model", () => {
    expect(effortForTier("light")).toBe("low");
    expect(effortForTier("heavy")).toBe("high");
  });
});
