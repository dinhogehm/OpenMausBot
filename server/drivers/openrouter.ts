// Dedicated OpenRouter driver. The wire protocol is OpenAI chat completions;
// this file keeps only what is OpenRouter-specific: the fixed gateway URL,
// the attribution headers it asks for, upstream-provider pinning, and its
// public model catalog. The generic `openai-compat` driver stays for Groq,
// vLLM, LM Studio and other endpoints whose URL the user must supply.
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const DRIVER_KIND = "openrouter";
const API_KEY_ENV = "OPENROUTER_API_KEY";
const MODEL_ENV = "OPENROUTER_MODEL";
const PROVIDER_ENV = "OPENROUTER_PROVIDER";
// Not configurable on purpose: a different URL means a different engine,
// and that engine is `openai-compat`.
const API_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
const idleTimeoutMs = () => {
  const raw = process.env.OPENMAUS_OPENROUTER_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 2_147_483_647 ? value : DEFAULT_IDLE_TIMEOUT_MS;
};

type ModelOption = ModelCatalog["options"][number];

/** OpenRouter ids are `vendor/model`; the vendor prefix is what the picker
 * shows as the upstream badge. (`top_provider` in the catalog response is
 * capacity stats, not a name, so it cannot serve here.) */
const vendorOf = (id: string): string | undefined => {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : undefined;
};

const seed = (id: string, label: string, contextWindow: number): ModelOption => ({
  id,
  label,
  contextWindow,
  provider: vendorOf(id),
  // `custom: true` because the driver is access "custom": the picker opens
  // custom-access engines in the pane that lists only custom-flagged models.
  custom: true,
});

// Curated seed shown before (and instead of, when offline) the live catalog.
// Context windows are OpenRouter's advertised `context_length` values.
const SEED_MODELS: ModelCatalog = {
  default: DEFAULT_MODEL,
  options: [
    seed("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", 1_000_000),
    seed("anthropic/claude-opus-4.1", "Claude Opus 4.1", 200_000),
    seed("openai/gpt-5", "GPT-5", 400_000),
    seed("openai/gpt-5-mini", "GPT-5 Mini", 400_000),
    seed("google/gemini-2.5-pro", "Gemini 2.5 Pro", 1_048_576),
    seed("google/gemini-2.5-flash", "Gemini 2.5 Flash", 1_048_576),
    seed("x-ai/grok-4", "Grok 4", 256_000),
    seed("deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1_048_576),
    seed("deepseek/deepseek-v4-pro-0813", "DeepSeek V4 Pro 0813", 1_048_576),
    seed("deepseek/deepseek-chat-v3.1", "DeepSeek V3.1", 163_840),
    seed("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B Instruct", 131_072),
    seed("qwen/qwen3-coder", "Qwen3 Coder", 262_144),
    seed("moonshotai/kimi-k2", "Kimi K2", 131_072),
  ],
};

export interface OpenRouterConfig {
  tools?: boolean;
  model?: string;
  /** Upstream to pin (e.g. "fireworks"). An explicit empty string disables
   * an inherited OPENROUTER_PROVIDER pin for this one instance; absent
   * inherits it. */
  provider?: string;
}

function decodeConfig(raw: unknown): OpenRouterConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.tools !== undefined && typeof config.tools !== "boolean") throw new Error("tools must be a boolean");
  if (config.model !== undefined && typeof config.model !== "string") throw new Error("model must be a string");
  if (config.provider !== undefined && typeof config.provider !== "string") throw new Error("provider must be a string");
  return {
    ...(config.tools !== undefined ? { tools: config.tools as boolean } : {}),
    ...(typeof config.model === "string" && config.model ? { model: config.model } : {}),
    // Empty string is preserved: it is the per-instance "no pin" override
    // that `create` distinguishes from "inherit the environment pin".
    ...(typeof config.provider === "string" ? { provider: config.provider } : {}),
  };
}

/** Seed models keep their curated order at the top; everything else the
 * gateway lists follows alphabetically so a 300+ entry picker stays
 * scannable. The configured default is pinned first when the gateway does
 * not list it (deprecated ids keep working until upstream drops them). */
function mergeCatalog(fetched: ModelOption[], configuredModel: string | undefined): ModelCatalog {
  const byId = new Map(fetched.map((option) => [option.id, option]));
  const options: ModelOption[] = [];
  for (const option of SEED_MODELS.options) {
    const live = byId.get(option.id);
    options.push(live ? { ...option, ...live } : option);
    byId.delete(option.id);
  }
  options.push(...Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id)));
  if (configuredModel && !options.some((option) => option.id === configuredModel)) {
    options.unshift({ id: configuredModel, label: configuredModel, provider: vendorOf(configuredModel), custom: true });
  }
  return { default: configuredModel ?? SEED_MODELS.default, options };
}

export const OpenRouterDriver: ProviderDriver<OpenRouterConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "OpenRouter", supportsMultipleInstances: true, access: "custom" },
  models: SEED_MODELS,
  install: {
    docsUrl: "https://openrouter.ai/keys",
    signInCommand:
      "paste the key in Settings → API keys, or add {\"openrouter\":{\"key\":\"sk-or-v1-…\"}} to ~/.openmausbot/config.json (or set OPENROUTER_API_KEY)",
    command: {
      darwin:
        "Get a key at https://openrouter.ai/keys then paste it in Settings → API keys (or ~/.openmausbot/config.json under openrouter.key)",
      linux:
        "Get a key at https://openrouter.ai/keys then paste it in Settings → API keys (or ~/.openmausbot/config.json under openrouter.key)",
      win32:
        "Get a key at https://openrouter.ai/keys then paste it in Settings → API keys (or %USERPROFILE%\\.openmausbot\\config.json under openrouter.key)",
    },
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey = input.environment[API_KEY_ENV] ?? process.env[API_KEY_ENV] ?? "";
    const model = config.model || input.environment[MODEL_ENV] || process.env[MODEL_ENV] || undefined;
    const provider = config.provider !== undefined
      ? config.provider || undefined
      : input.environment[PROVIDER_ENV] || process.env[PROVIDER_ENV] || undefined;
    let catalog = mergeCatalog([], model);

    // The catalog endpoint is public, so it is fetched even without a key
    // (and without sending one): a person choosing a model before pasting
    // their key still sees the live list.
    const fetchModels = async () => {
      try {
        const response = await fetch(`${API_URL}/models`, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) return;
        const json = await response.json() as {
          data?: Array<{ id?: unknown; name?: unknown; context_length?: unknown }>;
        };
        const rows = Array.isArray(json.data) ? json.data : [];
        const seen = new Set<string>();
        const options: ModelOption[] = [];
        for (const row of rows) {
          const id = typeof row.id === "string" ? row.id : "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          options.push({
            id,
            label: typeof row.name === "string" && row.name.trim() ? row.name : id,
            provider: vendorOf(id),
            ...(typeof row.context_length === "number" && row.context_length > 0
              ? { contextWindow: row.context_length }
              : {}),
            custom: true,
          });
        }
        if (!options.length) return;
        catalog = mergeCatalog(options, model);
      } catch {
        // Catalog refresh is opportunistic; keep the seeded options.
      }
    };
    void fetchModels();

    const keyHint = `set ${API_KEY_ENV} or add the key in Settings → API keys`;
    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl: API_URL,
      tools: config.tools,
      models: () => catalog,
      refreshModels: fetchModels,
      requestBody: (requestModel, messages, stream) => ({
        model: requestModel,
        messages,
        stream,
        stream_options: stream ? { include_usage: true } : undefined,
        ...(provider ? { provider: { order: [provider], allow_fallbacks: false } } : {}),
      }),
      // Attribution OpenRouter asks apps to send; it ranks the app on its
      // public leaderboard and is not a secret.
      extraHeaders: { "HTTP-Referer": "https://github.com/milind-soni/OpenMausBot", "X-Title": "OpenMausBot" },
      httpErrorLabel: "OpenRouter",
      missingKeyError: `no OpenRouter API key — ${keyHint}`,
      unavailableReason: `no OpenRouter API key — ${keyHint}`,
      timeoutMs: idleTimeoutMs(),
      reasoning: true,
      billing: "metered",
      includeUsageInCompleted: true,
      nativeLog: {
        source: "openrouter.chat.completions",
        outgoing: (_turn, messages, requestModel) => ({ model: requestModel, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({
          textLength: text.length,
          reasoningLength: reasoning.length,
          usage,
        }),
      },
    });
  },
};
