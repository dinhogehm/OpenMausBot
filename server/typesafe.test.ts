import { describe, expect, it, vi } from "vitest";

import {
  describeAnswer,
  evaluateSystemOne,
  listTypeSafeModels,
  openRouterJevModel,
  questionMapSchema,
  TypeSafeError,
  typesafeCredentials,
} from "./typesafe.ts";

const credentials = { apiKey: "ts-fixture-key", model: "jev-latest" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("typesafeCredentials", () => {
  it("returns null without a key and defaults the model alias", () => {
    expect(typesafeCredentials({})).toBeNull();
    expect(typesafeCredentials({ typesafe: { key: "  " } })).toBeNull();
    expect(typesafeCredentials({ typesafe: { key: " k " } })).toEqual({ apiKey: "k", model: "jev-latest", gateway: "typesafe" });
    expect(typesafeCredentials({ typesafe: { key: "k", model: "jev-1.13.0" } })).toEqual({ apiKey: "k", model: "jev-1.13.0", gateway: "typesafe" });
  });

  it("falls back to the OpenRouter key through the Decisions gateway, TypeSafe key first", () => {
    expect(typesafeCredentials({ openrouter: { key: "sk-or" } })).toEqual({ apiKey: "sk-or", model: "jev-latest", gateway: "openrouter" });
    expect(typesafeCredentials({ openrouter: { key: "sk-or" }, typesafe: { model: "jev-1.13.0" } }))
      .toEqual({ apiKey: "sk-or", model: "jev-1.13.0", gateway: "openrouter" });
    expect(typesafeCredentials({ openrouter: { key: "sk-or" }, typesafe: { key: "k" } })).toMatchObject({ apiKey: "k", gateway: "typesafe" });
    expect(typesafeCredentials({ openrouter: { key: " " } })).toBeNull();
  });
});

describe("openRouterJevModel", () => {
  it("spells TypeSafe model names the way OpenRouter lists them", () => {
    expect(openRouterJevModel("jev-latest")).toBe("~typesafe/jev-latest");
    expect(openRouterJevModel("")).toBe("~typesafe/jev-latest");
    expect(openRouterJevModel("jev-1.13.0")).toBe("typesafe/jev-1.13");
    expect(openRouterJevModel("jev-1.13")).toBe("typesafe/jev-1.13");
    expect(openRouterJevModel("typesafe/jev-1.13")).toBe("typesafe/jev-1.13");
  });
});

describe("questionMapSchema", () => {
  it("accepts the three question types and rejects typos", () => {
    expect(questionMapSchema.safeParse({
      urgent: { type: "noul", instructions: "Is it urgent?" },
      team: { type: "choice", instructions: "Which team?", criteria: { billing: null, tech: "Bugs" } },
      mood: { type: "score", instructions: "How angry?", criteria: ["calm", "angry"] },
    }).success).toBe(true);
    expect(questionMapSchema.safeParse({}).success).toBe(false);
    expect(questionMapSchema.safeParse({ team: { type: "choice", instructions: "x", criteria: { only: null } } }).success).toBe(false);
    expect(questionMapSchema.safeParse({ mood: { type: "score", instructions: "x", criteria: ["one"] } }).success).toBe(false);
    expect(questionMapSchema.safeParse({ urgent: { type: "noul", instructions: "x", extra: 1 } }).success).toBe(false);
  });
});

describe("evaluateSystemOne", () => {
  it("posts state, model and questions with the bearer key and validates the answers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      model: "jev-1.13.0",
      answers: {
        team: { type: "choice", choice: "billing", probabilities: { billing: 0.84, tech: 0.16 }, confidence: 0.6 },
        urgent: { type: "noul", noul: 0.92 },
      },
      usage: { input_tokens: 12, output_tokens: 2 },
    }));
    const result = await evaluateSystemOne({
      credentials,
      state: "Payouts failing for 3 days",
      questions: {
        team: { type: "choice", instructions: "Which team?", criteria: { billing: null, tech: null } },
        urgent: { type: "noul", instructions: "Urgent?" },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers.team).toMatchObject({ type: "choice", choice: "billing" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ts-fixture-key");
    expect(init.redirect).toBe("manual");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      state: "Payouts failing for 3 days",
      model: "jev-latest",
      questions: {
        team: { type: "choice", instructions: "Which team?", criteria: { billing: null, tech: null } },
        urgent: { type: "noul", instructions: "Urgent?" },
      },
    });
  });

  it("routes through OpenRouter's Decisions endpoint when the credentials say so", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ model: "typesafe/jev-1.13", answers: { u: { type: "noul", noul: 0.5 } } }));
    await evaluateSystemOne({
      credentials: { apiKey: "sk-or-fixture", model: "jev-latest", gateway: "openrouter" }, state: "x",
      questions: { u: { type: "noul", instructions: "?" } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-fixture");
    expect(JSON.parse(init.body as string).model).toBe("~typesafe/jev-latest");
  });

  it("lets a call pin its own model", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ model: "jev-1.13.0", answers: { u: { type: "noul", noul: 0.1 } } }));
    await evaluateSystemOne({
      credentials, model: "jev-1.13.0", state: "x",
      questions: { u: { type: "noul", instructions: "?" } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe("jev-1.13.0");
  });

  it("classifies auth, rate-limit, request and upstream failures", async () => {
    const attempt = (status: number, body: unknown = { error: "nope" }) => evaluateSystemOne({
      credentials, state: "x", questions: { u: { type: "noul", instructions: "?" } },
      fetchImpl: (async () => jsonResponse(body, status)) as unknown as typeof fetch,
    });
    await expect(attempt(401)).rejects.toMatchObject({ name: "TypeSafeError", kind: "auth", status: 401 });
    await expect(attempt(429)).rejects.toMatchObject({ kind: "rate", status: 429 });
    await expect(attempt(422)).rejects.toMatchObject({ kind: "request", status: 422 });
    await expect(attempt(503)).rejects.toMatchObject({ kind: "upstream", status: 503 });
    await expect(attempt(200, { model: "jev", answers: { u: { type: "noul", noul: 7 } } })).rejects.toMatchObject({ kind: "upstream" });
  });

  it("reports network failures and honors an outer abort", async () => {
    await expect(evaluateSystemOne({
      credentials, state: "x", questions: { u: { type: "noul", instructions: "?" } },
      fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch,
    })).rejects.toMatchObject({ kind: "network" });
    const controller = new AbortController();
    controller.abort();
    await expect(evaluateSystemOne({
      credentials, state: "x", questions: { u: { type: "noul", instructions: "?" } },
      signal: controller.signal,
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    })).rejects.toBeInstanceOf(TypeSafeError);
  });
});

describe("listTypeSafeModels", () => {
  it("returns the account's model names", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ models: [{ name: "jev-latest", description: "flagship", release_date: "2026-01-01" }] }));
    const models = await listTypeSafeModels({ apiKey: "k" }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(models.map((model) => model.name)).toEqual(["jev-latest"]);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.typesafe.ai/v1/models");
  });
});

describe("describeAnswer", () => {
  it("renders each answer type on one line", () => {
    expect(describeAnswer({ type: "noul", noul: 0.92 })).toBe("92% yes");
    expect(describeAnswer({ type: "choice", choice: "billing", probabilities: { billing: 0.84, tech: 0.16 }, confidence: 0.6 }))
      .toBe("billing (billing 84%, tech 16%; confidence 60%)");
    expect(describeAnswer({ type: "score", score: 1.04, legend: { "0": "calm", "1": "annoyed", "2": "angry" }, confidence: 0.8 }))
      .toBe("1.04 ≈ annoyed (confidence 80%)");
  });
});
