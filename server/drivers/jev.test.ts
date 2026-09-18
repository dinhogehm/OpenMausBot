import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { DEFAULT_JEV_QUESTIONS, JevDriver, resolveJevQuestions } from "./jev.ts";

const QUESTIONS = {
  refund: { type: "noul" as const, instructions: "Is the sender asking for a refund?" },
  tier: { type: "choice" as const, instructions: "Which plan?", criteria: { free: null, pro: null } },
};

const ANSWERS = {
  refund: { type: "noul", noul: 0.91 },
  tier: { type: "choice", choice: "pro", probabilities: { pro: 0.8, free: 0.2 }, confidence: 0.75 },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function createInstance(environment: Record<string, string> = { TYPESAFE_API_KEY: "ts-secret-key" }, config = {}) {
  return JevDriver.create({ instanceId: "jev-1", displayName: "Jev", enabled: true, config, environment });
}

describe("JevDriver", () => {
  const savedKey = process.env.TYPESAFE_API_KEY;
  const savedModel = process.env.TYPESAFE_MODEL;
  const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_MODEL;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.TYPESAFE_MODEL;
    else process.env.TYPESAFE_MODEL = savedModel;
    if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers as the jev kind, custom access, with a custom-flagged seed catalog", () => {
    expect(JevDriver.driverKind).toBe("jev");
    expect(JevDriver.metadata).toEqual({ displayName: "Jev (TypeSafe)", supportsMultipleInstances: true, access: "custom" });
    expect(JevDriver.models.default).toBe("jev-latest");
    // access "custom" engines render only custom-flagged options in the picker.
    expect(JevDriver.models.options.every((option) => option.custom && option.contextWindow === 64_000)).toBe(true);
    expect(JevDriver.models.options.map((option) => option.id)).toEqual(["jev-latest", "jev-preview", "jev-1.13.0"]);
    expect(JevDriver.install?.docsUrl).toBe("https://console.typesafe.ai/settings/keys");
  });

  it("decodes an empty config and a valid question map", () => {
    expect(JevDriver.defaultConfig()).toEqual({});
    expect(JevDriver.decodeConfig(undefined)).toEqual({});
    expect(JevDriver.decodeConfig({ questions: QUESTIONS })).toEqual({ questions: QUESTIONS });
  });

  it("rejects an invalid question map instead of letting it reach the API", () => {
    expect(() => JevDriver.decodeConfig({ questions: {} })).toThrow(/questions/);
    expect(() => JevDriver.decodeConfig({ questions: { q: { type: "choice", instructions: "x", criteria: { only: null } } } })).toThrow(/two options/);
    expect(() => JevDriver.decodeConfig({ questions: { q: { type: "essay", instructions: "x" } } })).toThrow();
  });

  it("reports unavailable without a key and metered when one is set", async () => {
    const without = await createInstance({});
    expect(await without.snapshot()).toEqual({ state: "unavailable", reason: expect.stringContaining("TYPESAFE_API_KEY") });
    await expect(without.adapter.sendTurn({ threadId: "t", text: "hi" })).rejects.toThrow(/no Jev key/);
    await without.dispose();

    const withKey = await createInstance();
    expect(await withKey.snapshot()).toEqual({ state: "available", authenticated: true, version: null, billing: "metered" });
    expect(withKey.adapter.capabilities).toEqual({ sessionModelSwitch: "in-session" });
    await withKey.dispose();
  });

  it("reaches Jev through OpenRouter's Decisions endpoint when only that key is present", async () => {
    const fetchMock = vi.fn(async () => Response.json({ model: "typesafe/jev-1.13", answers: { urgency: { type: "noul", noul: 0.9 } } }));
    vi.stubGlobal("fetch", fetchMock);
    const inst = await createInstance({ OPENROUTER_API_KEY: "sk-or-fixture" }, { questions: { urgency: { type: "noul", instructions: "Urgent?" } } });
    expect(await inst.snapshot()).toMatchObject({ state: "available", account: { organization: "via OpenRouter" } });
    const recorder = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "t-or", text: "help now" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-fixture");
    expect(JSON.parse(init.body as string).model).toBe("~typesafe/jev-latest");
    expect(completed).toMatchObject({ ok: true });
    await inst.dispose();

    // A TypeSafe key always wins over the OpenRouter fallback.
    const both = await createInstance({ OPENROUTER_API_KEY: "sk-or", TYPESAFE_API_KEY: "ts" });
    expect(await both.snapshot()).toEqual({ state: "available", authenticated: true, version: null, billing: "metered" });
    await both.dispose();
  });

  it("honours TYPESAFE_MODEL from the instance environment as the default", async () => {
    const inst = await createInstance({ TYPESAFE_API_KEY: "k", TYPESAFE_MODEL: "jev-1.13.0" });
    expect(inst.models.default).toBe("jev-1.13.0");
    await inst.dispose();
  });

  describe("resolveJevQuestions", () => {
    it("takes questions and state from a JSON message", () => {
      const resolved = resolveJevQuestions({ text: JSON.stringify({ questions: QUESTIONS, state: { ticket: "I want my money back" } }) }, {});
      expect(resolved).toEqual({ questions: QUESTIONS, state: { ticket: "I want my money back" }, source: "message" });
    });

    it("uses the prose around a fenced block as the state when the block has none", () => {
      const text = `Please evaluate this:\n\n\`\`\`json\n${JSON.stringify({ questions: QUESTIONS })}\n\`\`\``;
      const resolved = resolveJevQuestions({ text, transcript: [{ role: "user", text: "earlier" }] }, { questions: { other: QUESTIONS.refund } });
      expect(resolved.source).toBe("message");
      expect(resolved.questions).toEqual(QUESTIONS);
      expect(resolved.state).toEqual({ message: "Please evaluate this:", history: [{ role: "user", text: "earlier" }] });
    });

    it("takes standing questions from a fenced block in the system prompt", () => {
      const system = `You triage support mail.\n\`\`\`json\n${JSON.stringify({ questions: QUESTIONS })}\n\`\`\``;
      const resolved = resolveJevQuestions({ text: "Refund please", system }, { questions: { other: QUESTIONS.refund } });
      expect(resolved).toEqual({ questions: QUESTIONS, state: { message: "Refund please" }, source: "system" });
    });

    it("falls back to the instance config, then the triage set", () => {
      const fromConfig = resolveJevQuestions({ text: "hi", system: "Be nice." }, { questions: QUESTIONS });
      expect(fromConfig).toMatchObject({ questions: QUESTIONS, source: "config" });
      const fallback = resolveJevQuestions({ text: "hi" }, {});
      expect(fallback).toEqual({ questions: DEFAULT_JEV_QUESTIONS, state: { message: "hi" }, source: "default" });
      expect(Object.keys(DEFAULT_JEV_QUESTIONS)).toEqual(["intent", "urgency", "sentiment", "needs_human"]);
    });

    it("ignores JSON that carries no valid questions and keeps only the last 20 history entries", () => {
      const transcript = Array.from({ length: 25 }, (_, i) => ({ role: "user" as const, text: `m${i}` }));
      const resolved = resolveJevQuestions({ text: '{"questions": {"bad": {"type": "noul"}}}', transcript }, {});
      expect(resolved.source).toBe("default");
      const state = resolved.state as { history: unknown[] };
      expect(state.history).toHaveLength(20);
      expect(state.history[0]).toEqual({ role: "user", text: "m5" });
    });
  });

  it("evaluates a turn and renders the answers as text with the raw JSON attached", async () => {
    let sent: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent = { url: String(url), init };
      return jsonResponse({ model: "jev-1.13.0", answers: ANSWERS, usage: { input_tokens: 40, output_tokens: 6 } });
    }));
    const inst = await createInstance({ TYPESAFE_API_KEY: "ts-secret-key" }, { questions: QUESTIONS });
    const recorder = recordEvents(inst.adapter);

    const { turnId } = await inst.adapter.sendTurn({
      threadId: "thread", text: "I want my money back", model: "jev-preview",
      transcript: [{ role: "assistant", text: "How can I help?" }],
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(sent?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(sent?.init?.headers).get("authorization")).toBe("Bearer ts-secret-key");
    expect(JSON.parse(String(sent?.init?.body))).toEqual({
      model: "jev-preview",
      state: { message: "I want my money back", history: [{ role: "assistant", text: "How can I help?" }] },
      questions: QUESTIONS,
    });

    expect(recorder.events.map((event) => event.type)).toEqual(["turn.started", "session.started", "item.completed", "turn.completed"]);
    expect(recorder.events.every((event) => event.turnId === turnId && event.provider === "jev")).toBe(true);
    expect(recorder.events[1]).toMatchObject({ type: "session.started", sessionId: null, model: "jev-preview" });
    const item = recorder.events[2] as { text: string };
    expect(item).toMatchObject({ type: "item.completed", itemType: "assistant_text" });
    expect(item.text).toContain("**refund** — 91% yes");
    expect(item.text).toContain("**tier** — pro (pro 80%, free 20%; confidence 75%)");
    const fence = /```json\n([\s\S]*?)\n```/.exec(item.text);
    expect(JSON.parse(fence![1])).toEqual({ model: "jev-1.13.0", answers: ANSWERS });
    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn", cost: null, usage: { input: 40, output: 6 } });
    expect(inst.adapter.hasSession("thread")).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("turns a rejected key into a setup error without leaking the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key ts-secret-key", { status: 401 })));
    const inst = await createInstance();
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    const error = recorder.events.find((event) => event.type === "runtime.error");
    expect(error).toMatchObject({ type: "runtime.error", terminal: true, setup: true });
    expect(JSON.stringify(recorder.events)).not.toContain("ts-secret-key");
    expect(completed).toMatchObject({ ok: false, stopReason: "error", cost: null });
    expect(recorder.events.some((event) => event.type === "item.completed")).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("reports a 5xx as a retryable error, not a setup problem", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const inst = await createInstance();
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread", text: "hello" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ setup: false, message: expect.stringContaining("503") });
    recorder.stop();
    await inst.dispose();
  });

  it("interrupts a running evaluation and refuses a second turn on the same thread meanwhile", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const inst = await createInstance();
    const recorder = recordEvents(inst.adapter);

    const { turnId } = await inst.adapter.sendTurn({ threadId: "thread", text: "hello" });
    await recorder.until((event) => event.type === "session.started");
    expect(inst.adapter.hasSession("thread")).toBe(true);
    await expect(inst.adapter.sendTurn({ threadId: "thread", text: "again" })).rejects.toThrow(/already running/);

    await inst.adapter.interruptTurn("thread", turnId);
    const completed = await recorder.until((event) => event.type === "turn.completed");
    expect(completed).toMatchObject({ ok: false, stopReason: "interrupted" });
    // A Stop is the person's decision, not a failure to show.
    expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
    expect(inst.adapter.hasSession("thread")).toBe(false);
    expect(await inst.adapter.respondToRequest("thread", "r", { behavior: "allow" })).toBe("unavailable");
    recorder.stop();
    await inst.dispose();
  });

  it("merges listed model names into the seed catalog and keeps the seed when the listing fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ models: [
      { name: "jev-latest", description: "alias" },
      { name: "jev-2.0.0", description: "Jev 2.0", release_date: "2026-09-01" },
    ] })));
    const inst = await createInstance();
    await inst.refreshModels?.();
    expect(inst.models.options.map((option) => option.id)).toEqual(["jev-latest", "jev-preview", "jev-1.13.0", "jev-2.0.0"]);
    expect(inst.models.options.at(-1)).toEqual({ id: "jev-2.0.0", label: "Jev 2.0", custom: true, contextWindow: 64_000 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await inst.refreshModels?.();
    expect(inst.models.options).toHaveLength(4);
    await inst.dispose();
  });
});
