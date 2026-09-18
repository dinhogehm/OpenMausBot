import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { OpenRouterDriver } from "./openrouter.ts";

const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_PROVIDER"] as const;

const emptyCatalog = () => new Response(JSON.stringify({ data: [] }), { status: 200 });
const completion = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** Stubs fetch so a turn returns a plain JSON completion and hands back what
 * the driver sent, so tests can assert on headers and body. */
function captureRequest() {
  const captured: { url: string; init?: RequestInit } = { url: "" };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return emptyCatalog();
    captured.url = url;
    captured.init = init;
    return completion();
  }));
  return captured;
}

async function sendOneTurn(config: Record<string, unknown>, environment: Record<string, string>) {
  const inst = await OpenRouterDriver.create({
    instanceId: "openrouter-turn",
    displayName: "OpenRouter",
    enabled: true,
    config: OpenRouterDriver.decodeConfig(config),
    environment,
  });
  const recorder = recordEvents(inst.adapter);
  try {
    await inst.adapter.sendTurn({ threadId: "thread", text: "prompt" });
    return await recorder.until((event) => event.type === "turn.completed");
  } finally {
    recorder.stop();
    await inst.dispose();
  }
}

describe("OpenRouterDriver", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // `create` kicks off a catalog refresh on its own; never let a unit test
    // reach the real gateway.
    vi.stubGlobal("fetch", vi.fn(async () => emptyCatalog()));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers with the openrouter kind as a custom-access engine", () => {
    expect(OpenRouterDriver.driverKind).toBe("openrouter");
    expect(OpenRouterDriver.metadata).toEqual({
      displayName: "OpenRouter",
      supportsMultipleInstances: true,
      access: "custom",
    });
  });

  it("seeds a curated catalog flagged custom with vendor badges and context windows", () => {
    expect(OpenRouterDriver.models.default).toBe("anthropic/claude-sonnet-4.5");
    expect(OpenRouterDriver.models.options.length).toBeGreaterThan(5);
    // Every option carries `custom: true`: this engine advertises
    // `access: "custom"`, and the picker renders only custom-flagged options
    // for such engines — an unflagged one is invisible in its own picker.
    expect(OpenRouterDriver.models.options.every((option) => option.custom === true)).toBe(true);
    expect(OpenRouterDriver.models.options[0]).toEqual({
      id: "anthropic/claude-sonnet-4.5",
      label: "Claude Sonnet 4.5",
      contextWindow: 1_000_000,
      provider: "anthropic",
      custom: true,
    });
  });

  it("defaults to an empty config and rejects mistyped fields", () => {
    expect(OpenRouterDriver.defaultConfig()).toEqual({});
    expect(OpenRouterDriver.decodeConfig({ tools: false })).toMatchObject({ tools: false });
    expect(OpenRouterDriver.decodeConfig({ model: "openai/gpt-5", provider: "openai" }))
      .toEqual({ model: "openai/gpt-5", provider: "openai" });
    expect(() => OpenRouterDriver.decodeConfig({ tools: "false" })).toThrow("tools must be a boolean");
    expect(() => OpenRouterDriver.decodeConfig({ model: 42 })).toThrow("model must be a string");
    expect(() => OpenRouterDriver.decodeConfig({ provider: ["fireworks"] })).toThrow("provider must be a string");
  });

  it("reports unavailable without an API key and points at Settings", async () => {
    const inst = await OpenRouterDriver.create({
      instanceId: "openrouter-nokey",
      displayName: "OpenRouter",
      enabled: true,
      config: OpenRouterDriver.defaultConfig(),
      environment: {},
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toMatch(/OPENROUTER_API_KEY/);
    expect(snap.reason).toMatch(/Settings → API keys/);
    await inst.dispose();
  });

  it("is available and metered once the injected key is present", async () => {
    const inst = await OpenRouterDriver.create({
      instanceId: "openrouter-key",
      displayName: "OpenRouter",
      enabled: true,
      config: OpenRouterDriver.defaultConfig(),
      environment: { OPENROUTER_API_KEY: "sk-or-v1-secret" },
    });
    await expect(inst.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: true,
      billing: "metered",
    });
    await inst.dispose();
  });

  it("seeds the picker with the configured default model", async () => {
    const inst = await OpenRouterDriver.create({
      instanceId: "openrouter-default-model",
      displayName: "OpenRouter",
      enabled: true,
      config: OpenRouterDriver.decodeConfig({ model: "vendor/unlisted-model" }),
      environment: { OPENROUTER_API_KEY: "secret" },
    });
    expect(inst.models.default).toBe("vendor/unlisted-model");
    expect(inst.models.options[0]).toMatchObject({ id: "vendor/unlisted-model", provider: "vendor", custom: true });
    await inst.dispose();
  });

  it("maps the public catalog: seed order first, then the rest alphabetically", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "zeta/last", name: "Zeta Last", context_length: 8_192 },
            { id: "alpha/first", name: " ", context_length: "big" },
            { id: "openai/gpt-5", name: "OpenAI: GPT-5", context_length: 400_000 },
            { id: "alpha/first" },
            { id: 17 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const inst = await OpenRouterDriver.create({
      instanceId: "openrouter-catalog",
      displayName: "OpenRouter",
      enabled: true,
      config: OpenRouterDriver.decodeConfig({ model: "vendor/unlisted-model" }),
      environment: {},
    });

    await inst.refreshModels?.();

    // Public catalog: fetched even without a key, and the request carries none.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect(init?.headers).toBeUndefined();

    const ids = inst.models.options.map((option) => option.id);
    const seedIds = OpenRouterDriver.models.options.map((option) => option.id);
    expect(ids).toEqual(["vendor/unlisted-model", ...seedIds, "alpha/first", "zeta/last"]);
    expect(inst.models.default).toBe("vendor/unlisted-model");
    expect(inst.models.options.find((option) => option.id === "openai/gpt-5")).toEqual({
      id: "openai/gpt-5",
      label: "OpenAI: GPT-5",
      contextWindow: 400_000,
      provider: "openai",
      custom: true,
    });
    expect(inst.models.options.find((option) => option.id === "zeta/last")).toEqual({
      id: "zeta/last",
      label: "Zeta Last",
      contextWindow: 8_192,
      provider: "zeta",
      custom: true,
    });
    // Blank names fall back to the id; non-numeric context lengths are dropped.
    expect(inst.models.options.find((option) => option.id === "alpha/first")).toEqual({
      id: "alpha/first",
      label: "alpha/first",
      provider: "alpha",
      custom: true,
    });
    expect(inst.models.options.every((option) => option.custom === true)).toBe(true);
    await inst.dispose();
  });

  it("keeps the seed catalog when the gateway is unreachable or errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const inst = await OpenRouterDriver.create({
      instanceId: "openrouter-offline",
      displayName: "OpenRouter",
      enabled: true,
      config: OpenRouterDriver.defaultConfig(),
      environment: { OPENROUTER_API_KEY: "secret" },
    });
    await inst.refreshModels?.();
    expect(inst.models).toEqual(OpenRouterDriver.models);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await inst.refreshModels?.();
    expect(inst.models).toEqual(OpenRouterDriver.models);
    await inst.dispose();
  });

  it("sends attribution headers and the provider pin on a turn", async () => {
    const captured = captureRequest();

    const completed = await sendOneTurn(
      { provider: "fireworks" },
      { OPENROUTER_API_KEY: "sk-or-v1-secret", OPENROUTER_MODEL: "deepseek/deepseek-chat-v3.1" },
    );

    expect(completed).toMatchObject({ ok: true, usage: { input: 7, output: 2 } });
    expect(captured.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured.init?.headers).toMatchObject({
      "HTTP-Referer": "https://github.com/milind-soni/OpenMausBot",
      "X-Title": "OpenMausBot",
      authorization: "Bearer sk-or-v1-secret",
    });
    expect(JSON.parse(String(captured.init?.body))).toMatchObject({
      model: "deepseek/deepseek-chat-v3.1",
      stream: true,
      stream_options: { include_usage: true },
      provider: { order: ["fireworks"], allow_fallbacks: false },
    });
  });

  it("inherits the environment provider pin unless the instance overrides it", async () => {
    const env = { OPENROUTER_API_KEY: "secret", OPENROUTER_PROVIDER: "env-upstream" };
    const bodyFor = async (config: Record<string, unknown>) => {
      const captured = captureRequest();
      await sendOneTurn(config, env);
      return JSON.parse(String(captured.init?.body));
    };

    expect((await bodyFor({})).provider).toEqual({ order: ["env-upstream"], allow_fallbacks: false });
    expect((await bodyFor({ provider: "instance-upstream" })).provider)
      .toEqual({ order: ["instance-upstream"], allow_fallbacks: false });
    // An explicit empty override disables the inherited routing for an
    // isolated connection; absent still inherits the global pin.
    expect(await bodyFor({ provider: "" })).not.toHaveProperty("provider");
  });

  it("omits provider routing when nothing pins an upstream", async () => {
    const captured = captureRequest();
    await sendOneTurn({}, { OPENROUTER_API_KEY: "secret" });
    const body = JSON.parse(String(captured.init?.body));
    expect(body.model).toBe("anthropic/claude-sonnet-4.5");
    expect(body).not.toHaveProperty("provider");
  });
});
