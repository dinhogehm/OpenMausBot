// Jev (TypeSafe System One) driver. Jev is not a chat model: it never writes
// prose or calls tools. `POST /v1/systemone` takes a `state` plus a map of
// typed questions and returns one calibrated answer per question (a 0–1
// `noul`, a `choice` with probabilities, a `score` on a legend). So this
// engine is a decision bot: every user message becomes the state, the
// questions come from the message itself, the bot's instructions, or the
// instance config, and the reply is the answer map rendered as markdown
// with the raw JSON attached for anything downstream that wants to parse it.
//
// The wire client lives in server/typesafe.ts (shared with Jev-backed
// permission review and room routing); this file only owns the engine shape.
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import {
  OPENROUTER_API_KEY_ENV,
  TYPESAFE_API_KEY_ENV,
  TYPESAFE_DEFAULT_MODEL,
  TYPESAFE_MODEL_ENV,
  TypeSafeError,
  describeAnswer,
  evaluateSystemOne,
  listTypeSafeModels,
  questionMapSchema,
  type TypeSafeCredentials,
  type TypeSafeQuestion,
  type TypeSafeState,
} from "../typesafe.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "jev";
const NATIVE_SOURCE = "typesafe.systemone";
/** How much of the thread rides along as `history` in the state. Jev's
 * budget is 64k tokens for state plus questions; twenty entries keeps a
 * long room well inside that without the client having to truncate. */
const HISTORY_ENTRIES = 20;
const MISSING_KEY_ERROR = `no Jev key — set ${TYPESAFE_API_KEY_ENV} or ${OPENROUTER_API_KEY_ENV}, or add a TypeSafe or OpenRouter key in Settings → API keys`;
const UNAVAILABLE_REASON = `no Jev key — add a TypeSafe or OpenRouter key in Settings → API keys (or set ${TYPESAFE_API_KEY_ENV} / ${OPENROUTER_API_KEY_ENV})`;

// `custom: true` because the driver is access "custom": the picker opens
// custom-access engines in the pane that lists only custom-flagged models.
const SEED_MODELS: ModelCatalog = {
  default: TYPESAFE_DEFAULT_MODEL,
  options: [
    { id: "jev-latest", label: "Jev (latest)", custom: true, contextWindow: 64_000 },
    { id: "jev-preview", label: "Jev (preview)", custom: true, contextWindow: 64_000 },
    { id: "jev-1.13.0", label: "Jev 1.13", custom: true, contextWindow: 64_000 },
  ],
};

export interface JevConfig {
  /** The questions every turn asks when neither the message nor the bot's
   * instructions carry their own. Absent = the built-in triage set. */
  questions?: Record<string, TypeSafeQuestion>;
}

/** What a bot with no questions of its own asks about every message: the
 * generic inbox triage a router or a human handoff can act on directly. */
export const DEFAULT_JEV_QUESTIONS: Record<string, TypeSafeQuestion> = {
  intent: {
    type: "choice",
    instructions: "What is the sender trying to do with this message?",
    criteria: {
      question: "asks for information or an explanation",
      request: "asks for something to be done",
      complaint: "reports a problem or expresses dissatisfaction",
      feedback: "offers an opinion or suggestion without asking for action",
      other: null,
    },
  },
  urgency: {
    type: "noul",
    instructions: "Does this message need attention right now rather than in the normal course of work?",
  },
  sentiment: {
    type: "score",
    instructions: "What is the emotional tone of the message?",
    criteria: ["negative", "neutral", "positive"],
  },
  needs_human: {
    type: "noul",
    instructions: "Would this need a person rather than an automated answer?",
  },
};

export type JevQuestionSource = "message" | "system" | "config" | "default";

export interface ResolvedJevQuestions {
  questions: Record<string, TypeSafeQuestion>;
  state: TypeSafeState;
  source: JevQuestionSource;
}

const FENCED_JSON = /```json[^\n]*\n([\s\S]*?)```/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every JSON object a text carries: the whole text when it is one, else
 * each ```json fence in order. Bad JSON is skipped, not fatal — a message
 * that merely looks like JSON is still a message. */
function jsonObjectsIn(text: string): Array<{ object: Record<string, unknown>; fenced: boolean }> {
  const found: Array<{ object: Record<string, unknown>; fenced: boolean }> = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) found.push({ object: parsed, fenced: false });
    } catch { /* not a bare JSON message */ }
  }
  for (const match of text.matchAll(FENCED_JSON)) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      if (isRecord(parsed)) found.push({ object: parsed, fenced: true });
    } catch { /* prose that happens to hold a broken fence */ }
  }
  return found;
}

/** The first `{"questions": {...}}` in `text` that passes the schema, with
 * the state the same object may carry. */
function questionsIn(text: string | undefined): { questions: Record<string, TypeSafeQuestion>; state?: TypeSafeState; fenced: boolean } | null {
  if (!text) return null;
  for (const { object, fenced } of jsonObjectsIn(text)) {
    const parsed = questionMapSchema.safeParse(object.questions);
    if (!parsed.success) continue;
    const state = object.state;
    const hasState = typeof state === "string" ? state.length > 0 : typeof state === "object" && state !== null;
    return { questions: parsed.data, fenced, ...(hasState ? { state: state as TypeSafeState } : {}) };
  }
  return null;
}

/** The state Jev evaluates for an ordinary message: the message plus the
 * recent thread, as an object so Jev sees the structure instead of a
 * transcript it has to re-parse. */
function defaultState(message: string, transcript: SendTurnInput["transcript"]): TypeSafeState {
  const history = (transcript ?? []).slice(-HISTORY_ENTRIES).map(({ role, text }) => ({ role, text }));
  return { ...(message ? { message } : {}), ...(history.length ? { history } : {}) };
}

/** Which questions this turn asks, and about what. Precedence: the message
 * (a person or another bot steering one evaluation), the bot's instructions
 * (the persona's standing questions), the instance config, the triage set.
 * Exported so the precedence is testable without a fetch. */
export function resolveJevQuestions(turn: Pick<SendTurnInput, "text" | "system" | "transcript">, config: JevConfig): ResolvedJevQuestions {
  const fromMessage = questionsIn(turn.text);
  if (fromMessage) {
    if (fromMessage.state !== undefined) return { questions: fromMessage.questions, state: fromMessage.state, source: "message" };
    // The text outside the fence is the message being asked about; a bare
    // JSON message with no state leaves only the thread to evaluate.
    const remaining = fromMessage.fenced ? turn.text.replace(FENCED_JSON, "").trim() : "";
    const state = remaining || turn.transcript?.length
      ? defaultState(remaining, turn.transcript)
      : defaultState(turn.text, turn.transcript);
    return { questions: fromMessage.questions, state, source: "message" };
  }
  const state = defaultState(turn.text, turn.transcript);
  const fromSystem = questionsIn(turn.system);
  if (fromSystem) return { questions: fromSystem.questions, state, source: "system" };
  if (config.questions) return { questions: config.questions, state, source: "config" };
  return { questions: DEFAULT_JEV_QUESTIONS, state, source: "default" };
}

export function decodeJevConfig(raw: unknown): JevConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.questions === undefined) return {};
  const parsed = questionMapSchema.safeParse(config.questions);
  if (!parsed.success) throw new Error(`questions: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return { questions: parsed.data };
}

const asError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value));

/** `credentials` is null when neither key is present: the instance then
 * reports unavailable and refuses turns, like every other API-key driver. */
function createJevRuntime(input: DriverCreateInput<JevConfig>, credentials: TypeSafeCredentials | null): ProviderInstance {
  const apiKey = credentials?.apiKey ?? "";
  const defaultModel = credentials?.model ?? TYPESAFE_DEFAULT_MODEL;
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, { abort: AbortController; turnId: string; done: Promise<void> }>();
  let models: ModelCatalog = SEED_MODELS.options.some((option) => option.id === defaultModel)
    ? { ...SEED_MODELS, default: defaultModel }
    : { default: defaultModel, options: [{ id: defaultModel, label: defaultModel, custom: true, contextWindow: 64_000 }, ...SEED_MODELS.options] };

  const emit = (event: RuntimeEvent) => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const base = (threadId: string, turnId: string) => ({
    eventId: newEventId(),
    provider: DRIVER_KIND,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
  });
  // The key is the only secret this driver holds; it must never reach the
  // chat, the error card, or the native log even if the API echoes it.
  const safeText = (text: string) => redactSecretsInText(apiKey ? text.split(apiKey).join("[redacted]") : text);
  const native = (threadId: string, dir: "in" | "out", msg: unknown) => appendNative(threadId, {
    dir, source: NATIVE_SOURCE,
    msg: JSON.parse(JSON.stringify(msg, (_key, part) => typeof part === "string" ? safeText(part) : part)),
  });

  const refreshModels = async () => {
    if (!apiKey) return;
    try {
      const listed = await listTypeSafeModels({ apiKey, gateway: credentials?.gateway });
      const known = new Set(models.options.map((option) => option.id));
      const added = listed
        .filter((model) => model.name && !known.has(model.name))
        .map((model) => ({ id: model.name, label: model.description || model.name, custom: true, contextWindow: 64_000 }));
      if (added.length) models = { ...models, options: [...models.options, ...added] };
    } catch {
      // The seed catalog stays: a listing outage must not empty the picker.
    }
  };

  const sendTurn = async (turn: SendTurnInput) => {
    if (!apiKey) throw new Error(MISSING_KEY_ERROR);
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");

    const turnId = newId();
    const abort = new AbortController();
    const model = turn.model || models.default;
    const { questions, state, source } = resolveJevQuestions(turn, input.config);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    active.set(turn.threadId, { abort, turnId, done });
    emit({ ...base(turn.threadId, turnId), type: "turn.started" });
    emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model });

    void (async () => {
      let ok = false;
      let usage: { input: number; output: number } | undefined;
      let failure: { message: string; setup: boolean } | undefined;
      try {
        native(turn.threadId, "out", { model, source, state, questions });
        const result = await evaluateSystemOne({ credentials: { apiKey, model, gateway: credentials?.gateway }, state, questions, model, signal: abort.signal });
        native(turn.threadId, "in", result);
        abort.signal.throwIfAborted();
        if (result.usage) usage = { input: result.usage.input_tokens, output: result.usage.output_tokens };
        // One readable line per question, then the raw answers for a
        // router or a script that would rather parse than read.
        const lines = Object.entries(result.answers).map(([id, answer]) => `**${id}** — ${describeAnswer(answer)}`);
        const text = `${lines.join("\n")}\n\n\`\`\`json\n${JSON.stringify({ model: result.model, answers: result.answers }, null, 2)}\n\`\`\``;
        emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: safeText(text) });
        ok = true;
      } catch (value) {
        const error = asError(value);
        failure = {
          message: safeText(error.message).slice(0, 2_000),
          setup: error instanceof TypeSafeError && error.kind === "auth",
        };
      } finally {
        const interrupted = abort.signal.aborted;
        // A Stop is the person's decision, not a failure to report.
        if (failure && !interrupted) {
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: failure.message, terminal: true, setup: failure.setup });
        }
        active.delete(turn.threadId);
        emit({
          ...base(turn.threadId, turnId), type: "turn.completed",
          ok: ok && !interrupted,
          stopReason: interrupted ? "interrupted" : ok ? "end_turn" : "error",
          cost: null,
          ...(usage ? { usage } : {}),
        });
        resolveDone();
      }
    })();
    return { turnId };
  };

  const stopAll = async () => {
    const turns = [...active.values()];
    for (const turn of turns) turn.abort.abort();
    await Promise.all(turns.map((turn) => turn.done));
  };

  return {
    instanceId: input.instanceId,
    driverKind: DRIVER_KIND,
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return models;
    },
    refreshModels,
    snapshot: async () => apiKey
      ? {
          state: "available", authenticated: true, version: null, billing: "metered",
          // Which front door answers matters for billing: say so once here.
          ...(credentials?.gateway === "openrouter" ? { account: { organization: "via OpenRouter", method: "api-key" as const } } : {}),
        }
      : { state: "unavailable", reason: UNAVAILABLE_REASON },
    adapter: {
      provider: DRIVER_KIND,
      // No tools, MCP, or images: Jev evaluates, it does not act. Announcing
      // any of those would tell a bot it has hands it does not have.
      capabilities: { sessionModelSwitch: "in-session" },
      sendTurn,
      interruptTurn: async (threadId, turnId) => {
        const turn = active.get(threadId);
        if (!turn || (turnId && turn.turnId !== turnId)) return;
        turn.abort.abort();
        await turn.done;
      },
      // Jev never asks anything back, so there is no request to answer.
      respondToRequest: async () => "unavailable",
      hasSession: (threadId) => active.has(threadId),
      stopAll,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    dispose: async () => {
      await stopAll();
      listeners.clear();
    },
  };
}

export const JevDriver: ProviderDriver<JevConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Jev (TypeSafe)", supportsMultipleInstances: true, access: "custom" },
  models: SEED_MODELS,
  install: {
    docsUrl: "https://console.typesafe.ai/settings/keys",
    signInCommand: `add {"typesafe":{"key":"…"}} (or an OpenRouter key under "openrouter") to ~/.openmausbot/config.json — or set ${TYPESAFE_API_KEY_ENV} / ${OPENROUTER_API_KEY_ENV}`,
    command: {
      darwin: "Get a key at https://console.typesafe.ai/settings/keys then add it to ~/.openmausbot/config.json under typesafe.key",
      linux: "Get a key at https://console.typesafe.ai/settings/keys then add it to ~/.openmausbot/config.json under typesafe.key",
      win32: "Get a key at https://console.typesafe.ai/settings/keys then add it to %USERPROFILE%\\.openmausbot\\config.json under typesafe.key",
    },
  },
  decodeConfig: decodeJevConfig,
  defaultConfig: () => ({}),

  async create(input) {
    // Same precedence as typesafeCredentials(): TypeSafe's own key first,
    // then the OpenRouter key through its Decisions endpoint. Instance
    // environment (injected from the workspace config) beats process env.
    const read = (name: string) => input.environment[name]?.trim() || process.env[name]?.trim() || "";
    const model = read(TYPESAFE_MODEL_ENV) || TYPESAFE_DEFAULT_MODEL;
    const typesafeKey = read(TYPESAFE_API_KEY_ENV);
    const openRouterKey = read(OPENROUTER_API_KEY_ENV);
    const credentials: TypeSafeCredentials | null = typesafeKey
      ? { apiKey: typesafeKey, model, gateway: "typesafe" }
      : openRouterKey
        ? { apiKey: openRouterKey, model, gateway: "openrouter" }
        : null;
    return createJevRuntime(input, credentials);
  },
};
