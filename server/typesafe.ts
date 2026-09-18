// TypeSafe System One client (Jev). Jev is not a chat model: it evaluates a
// `state` against a map of typed questions and returns one calibrated answer
// per question, never free text or tool calls. Everything in the app that
// needs a fast structured decision — the Jev engine, Jev-backed permission
// review, and smart room routing — goes through this one client so the key,
// the timeout, and the response validation live in a single place.
//
//
// Two front doors reach the same model: TypeSafe's own API (a TypeSafe key)
// and OpenRouter's Decisions endpoint (the workspace's OpenRouter key). The
// request and answer shapes are identical; only the URL, the model id and the
// key differ, so the gateway is one field on the credentials.
//
// Reference: https://docs.typesafe.ai/api
// Reference: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
import { z } from "zod";

import type { AppConfig } from "./config.ts";

export const TYPESAFE_API_URL = "https://api.typesafe.ai/v1";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";
export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
export const TYPESAFE_MODEL_ENV = "TYPESAFE_MODEL";
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const OPENROUTER_DECISION_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=decisions";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Jev's per-request budget: 64k tokens for state plus every question. A
 * state this long is cut before the request so an oversized transcript
 * degrades to a truncated evaluation instead of a 4xx. */
const MAX_STATE_CHARS = 120_000;

// ── request ────────────────────────────────────────────────────────────
export type TypeSafeState = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: TypeSafeState;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: TypeSafeState;
  /** option → rubric (null when the name is enough). */
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: TypeSafeState;
  /** Ordered level descriptions, at least two. */
  criteria: string[];
}

export type TypeSafeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

// ── response ───────────────────────────────────────────────────────────
const noulAnswerSchema = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) });
const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});
const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), z.string()).optional(),
  confidence: z.number().min(0).max(1),
});
const answerSchema = z.discriminatedUnion("type", [noulAnswerSchema, choiceAnswerSchema, scoreAnswerSchema]);
const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).optional(),
});

export type NoulAnswer = z.output<typeof noulAnswerSchema>;
export type ChoiceAnswer = z.output<typeof choiceAnswerSchema>;
export type ScoreAnswer = z.output<typeof scoreAnswerSchema>;
export type TypeSafeAnswer = z.output<typeof answerSchema>;
export type TypeSafeResponse = z.output<typeof responseSchema>;

/** The user-editable question map, as a bot's instructions or a message may
 * carry it. Strict enough that a typo never reaches the API as a 4xx. */
const instructionsSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown()), z.array(z.unknown())]);
export const questionSchema: z.ZodType<TypeSafeQuestion> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: instructionsSchema,
    criteria: z.object({ true: z.string().optional(), false: z.string().optional() }).optional(),
  }).strict(),
  z.object({
    type: z.literal("choice"),
    instructions: instructionsSchema,
    criteria: z.record(z.string().min(1), z.string().nullable()).refine((map) => Object.keys(map).length >= 2, "a choice needs at least two options"),
  }).strict(),
  z.object({
    type: z.literal("score"),
    instructions: instructionsSchema,
    criteria: z.array(z.string()).min(2),
  }).strict(),
]);
export const questionMapSchema = z.record(z.string().min(1).max(120), questionSchema).refine(
  (map) => Object.keys(map).length > 0,
  "at least one question is required",
);

// ── errors ─────────────────────────────────────────────────────────────
/** `auth` = key rejected; `rate` = 429; `request` = our body was refused;
 * `upstream` = 5xx or malformed answer; `network` = fetch failed/aborted. */
export type TypeSafeErrorKind = "auth" | "rate" | "request" | "upstream" | "network";

// No constructor parameter properties: the server runs on Node's strip-only
// TypeScript loader, which rejects that syntax at import time.
export class TypeSafeError extends Error {
  readonly status: number | null;
  readonly kind: TypeSafeErrorKind;

  constructor(message: string, status: number | null, kind: TypeSafeErrorKind) {
    super(message);
    this.name = "TypeSafeError";
    this.status = status;
    this.kind = kind;
  }
}

// ── credentials ────────────────────────────────────────────────────────
export type TypeSafeGateway = "typesafe" | "openrouter";

export interface TypeSafeCredentials {
  apiKey: string;
  model: string;
  /** Which front door `apiKey` opens. Absent means TypeSafe's own API. */
  gateway?: TypeSafeGateway;
}

const GATEWAY_LABEL: Record<TypeSafeGateway, string> = { typesafe: "TypeSafe", openrouter: "OpenRouter" };

/** A TypeSafe model name as OpenRouter spells it. An id that already carries
 * a vendor prefix is the user's own choice and passes through untouched.
 * `jev-latest` is a router alias there (`~typesafe/…`), and pinned releases
 * are published by minor version (`jev-1.13.0` → `typesafe/jev-1.13`). */
export function openRouterJevModel(model: string): string {
  const name = model.trim() || TYPESAFE_DEFAULT_MODEL;
  if (name.includes("/")) return name;
  if (name === TYPESAFE_DEFAULT_MODEL) return `~typesafe/${name}`;
  const pinned = /^(jev-\d+\.\d+)(?:\.\d+)?$/.exec(name);
  return `typesafe/${pinned ? pinned[1] : name}`;
}

/** The workspace's Jev credentials, or null when no key is configured. A
 * TypeSafe key wins; without one, the OpenRouter key reaches the same model
 * through OpenRouter's Decisions endpoint. The config already folded
 * TYPESAFE_API_KEY / TYPESAFE_MODEL / OPENROUTER_API_KEY from the env. */
export function typesafeCredentials(cfg: Pick<AppConfig, "typesafe" | "openrouter">): TypeSafeCredentials | null {
  const model = cfg.typesafe?.model?.trim() || TYPESAFE_DEFAULT_MODEL;
  const apiKey = cfg.typesafe?.key?.trim();
  if (apiKey) return { apiKey, model, gateway: "typesafe" };
  const openRouterKey = cfg.openrouter?.key?.trim();
  if (openRouterKey) return { apiKey: openRouterKey, model, gateway: "openrouter" };
  return null;
}

// ── evaluation ─────────────────────────────────────────────────────────
export interface EvaluateInput {
  credentials: TypeSafeCredentials;
  state: TypeSafeState;
  questions: Record<string, TypeSafeQuestion>;
  /** Overrides credentials.model for this one call (the engine's picker). */
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
}

function boundedState(state: TypeSafeState): TypeSafeState {
  if (typeof state === "string") return state.length > MAX_STATE_CHARS ? state.slice(0, MAX_STATE_CHARS) : state;
  const text = JSON.stringify(state);
  return text.length > MAX_STATE_CHARS ? text.slice(0, MAX_STATE_CHARS) : state;
}

/** One `POST /v1/systemone` call (or its OpenRouter Decisions twin). Throws
 * TypeSafeError; never returns a partially validated answer map. */
export async function evaluateSystemOne(input: EvaluateInput): Promise<TypeSafeResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const gateway = input.credentials.gateway ?? "typesafe";
  const label = GATEWAY_LABEL[gateway];
  const requested = input.model || input.credentials.model;
  const endpoint = gateway === "openrouter"
    ? input.apiUrl ?? OPENROUTER_DECISIONS_URL
    : `${(input.apiUrl ?? TYPESAFE_API_URL).replace(/\/+$/, "")}/systemone`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    if (input.signal?.aborted) throw new TypeSafeError("evaluation aborted", null, "network");
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${input.credentials.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          state: boundedState(input.state),
          model: gateway === "openrouter" ? openRouterJevModel(requested) : requested,
          questions: input.questions,
        }),
        signal: controller.signal,
        // Never replay the key to wherever the front door points today.
        redirect: "manual",
      });
    } catch (error) {
      throw new TypeSafeError(
        controller.signal.aborted ? `${label} request timed out` : `${label} unreachable: ${(error as Error).message}`,
        null,
        "network",
      );
    }
    if (response.status === 401 || response.status === 403) throw new TypeSafeError(`${label} rejected the API key`, response.status, "auth");
    if (response.status === 429) throw new TypeSafeError(`${label} rate limit reached`, 429, "rate");
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new TypeSafeError(
        `${label} returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        response.status,
        response.status >= 500 ? "upstream" : "request",
      );
    }
    const body: unknown = await response.json().catch(() => null);
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new TypeSafeError(`${label} returned an answer the app could not read`, response.status, "upstream");
    return parsed.data;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** `GET /v1/models`: the names this account may send in `model`. Used by the
 * key check and the engine's catalog refresh; aliases only, per the docs. */
export async function listTypeSafeModels(
  credentials: Pick<TypeSafeCredentials, "apiKey" | "gateway">,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; apiUrl?: string } = {},
): Promise<Array<{ name: string; description: string; release_date: string }>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    if (credentials.gateway === "openrouter") {
      // OpenRouter lists decision models under their own ids (`typesafe/…`),
      // which openRouterJevModel() passes through unchanged.
      const response = await fetchImpl(options.apiUrl ?? OPENROUTER_DECISION_MODELS_URL, {
        headers: { authorization: `Bearer ${credentials.apiKey}` },
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status === 401 || response.status === 403) throw new TypeSafeError("OpenRouter rejected the API key", response.status, "auth");
      if (!response.ok) throw new TypeSafeError(`OpenRouter returned HTTP ${response.status}`, response.status, "upstream");
      const body: unknown = await response.json().catch(() => null);
      const parsed = z.object({
        data: z.array(z.object({ id: z.string(), name: z.string().default("") })),
      }).safeParse(body);
      if (!parsed.success) throw new TypeSafeError("OpenRouter model list could not be read", response.status, "upstream");
      return parsed.data.data
        .filter((model) => /(^|~)typesafe\//.test(model.id))
        .map((model) => ({ name: model.id, description: model.name, release_date: "" }));
    }
    const response = await fetchImpl(`${(options.apiUrl ?? TYPESAFE_API_URL).replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${credentials.apiKey}` },
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status === 401 || response.status === 403) throw new TypeSafeError("TypeSafe rejected the API key", response.status, "auth");
    if (!response.ok) throw new TypeSafeError(`TypeSafe returned HTTP ${response.status}`, response.status, "upstream");
    const body: unknown = await response.json().catch(() => null);
    const parsed = z.object({
      models: z.array(z.object({ name: z.string(), description: z.string().default(""), release_date: z.string().default("") })),
    }).safeParse(body);
    if (!parsed.success) throw new TypeSafeError("TypeSafe model list could not be read", response.status, "upstream");
    return parsed.data.models;
  } catch (error) {
    if (error instanceof TypeSafeError) throw error;
    throw new TypeSafeError(`TypeSafe unreachable: ${(error as Error).message}`, null, "network");
  } finally {
    clearTimeout(timer);
  }
}

/** Render an answer map as short human text — the engine's reply and the
 * activity lines the harness writes when Jev decided something. */
export function describeAnswer(answer: TypeSafeAnswer): string {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  if (answer.type === "noul") return `${pct(answer.noul)} yes`;
  if (answer.type === "choice") {
    const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([option, probability]) => `${option} ${pct(probability)}`).join(", ");
    return `${answer.choice} (${ranked}; confidence ${pct(answer.confidence)})`;
  }
  const level = answer.legend?.[String(Math.round(answer.score))];
  return `${answer.score.toFixed(2)}${level ? ` ≈ ${level}` : ""} (confidence ${pct(answer.confidence)})`;
}
