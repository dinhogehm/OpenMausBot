import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "@/state/store";
import * as store from "@/state/store";
import { ApiKeyRow, OpenAiCompatUrl, OpenRouterSettings, TypeSafeSettings } from "./ApiKeys";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const render = (element: React.ReactElement) => {
  vi.stubGlobal("window", {});
  return renderToStaticMarkup(createElement(StoreProvider, null, element));
};

describe("provider key rows", () => {
  it("describes a stored key as configured without claiming an authenticated connection", () => {
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: {
        ...store.initialState.config, openaiCompat: { configured: true, url: "https://openrouter.ai/api/v1" },
      } as store.ConfigStatus },
      dispatch: vi.fn(),
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    });
    const html = render(createElement(ApiKeyRow, { section: "openaiCompat", testProvider: "openaiCompat" }));
    expect(html).toContain("Configured");
    expect(html).not.toContain("Connected");
    expect(html).not.toContain("authenticated");
    expect(html).toContain(">Test<");
    expect(html).toContain('value=""');
  });

  it("renders the provider rows write-only, with the provider's own console linked", () => {
    const anthropic = render(createElement(ApiKeyRow, { section: "anthropic", testProvider: "anthropic" }));
    expect(anthropic).toContain("Anthropic API key");
    expect(anthropic).toContain('type="password"');
    expect(anthropic).toContain("sk-ant-…");
    // The console link and the description live in the help popover.
    expect(anthropic).toContain('aria-label="About Anthropic API key"');
    expect(anthropic).not.toContain("Connected");
    // Nothing to test until a key is typed or saved.
    expect(anthropic).not.toContain(">Test<");

    const openai = render(createElement(ApiKeyRow, { section: "openaiCompat", testProvider: "openaiCompat" }));
    expect(openai).toContain("OpenAI-compatible API key");
    expect(openai).toContain("sk-or-v1-…");

    expect(render(createElement(ApiKeyRow, { section: "xai", testProvider: "xai" }))).toContain("xAI API key");

    const openrouter = render(createElement(ApiKeyRow, { section: "openrouter", testProvider: "openrouter" }));
    expect(openrouter).toContain("OpenRouter API key");
    expect(openrouter).toContain("sk-or-v1-…");
    expect(openrouter).toContain('type="password"');

    const typesafe = render(createElement(ApiKeyRow, { section: "typesafe", testProvider: "typesafe" }));
    expect(typesafe).toContain("TypeSafe (Jev) API key");
    expect(typesafe).toContain('type="password"');
    expect(typesafe).toContain('aria-label="About TypeSafe (Jev) API key"');
  });

  it("keeps OpenRouter's model and provider pin as settings next to the key", () => {
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: {
        ...store.initialState.config, openrouter: { configured: true, model: "anthropic/claude-sonnet-4.5", provider: "anthropic" },
      } as store.ConfigStatus },
      dispatch: vi.fn(),
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    });
    const html = render(createElement(OpenRouterSettings));
    expect(html).toContain("Default model");
    expect(html).toContain('value="anthropic/claude-sonnet-4.5"');
    expect(html).toContain("Provider pin");
    expect(html).toContain('value="anthropic"');
  });

  it("locks Jev's permission review switch until a TypeSafe key is saved", () => {
    const unconfigured = render(createElement(TypeSafeSettings));
    expect(unconfigured).toContain('placeholder="jev-latest"');
    expect(unconfigured).toContain("Let Jev review permission requests");
    expect(unconfigured).toContain("100 ms");
    expect(unconfigured).toContain("Save a TypeSafe key first.");
    expect(unconfigured).toMatch(/disabled=""[^>]*role="switch"[^>]*aria-checked="false"/);

    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: {
        ...store.initialState.config, typesafe: { configured: true, model: "", permissionReview: true },
      } as store.ConfigStatus },
      dispatch: vi.fn(),
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    });
    const configured = render(createElement(TypeSafeSettings));
    expect(configured).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(configured).not.toMatch(/disabled=""[^>]*role="switch"/);
    expect(configured).not.toContain("Save a TypeSafe key first.");
  });

  it("offers the base URL as a setting next to the key", () => {
    const html = render(createElement(OpenAiCompatUrl));
    expect(html).toContain("OpenAI-compatible base URL");
    expect(html).toContain('placeholder="https://openrouter.ai/api/v1"');
    expect(html).toContain("api.openai.com/v1");
  });
});
