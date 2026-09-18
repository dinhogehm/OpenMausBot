import { describe, expect, it, vi } from "vitest";

import { JEV_ROUTING_MIN_CONFIDENCE, buildRoutingQuestion, pickSmartResponder } from "./room-routing.ts";

const credentials = { apiKey: "ts-key", model: "jev-latest" };
const members = [
  { id: "atlas", name: "Atlas", title: "Backend", description: "Owns the API and the database." },
  { id: "milind", name: "Milind", title: "Designer" },
  { id: "rae", name: "Rae" },
];

function jevStub(answer: { choice: string; probabilities: Record<string, number>; confidence: number } | null) {
  const calls: Array<{ body: any }> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({ model: "jev-1.13.0", answers: answer ? { responder: { type: "choice", ...answer } } : {} }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("buildRoutingQuestion", () => {
  it("keys options by member id and describes each persona briefly", () => {
    const question = buildRoutingQuestion([...members, { id: "long", name: "Long", description: "d".repeat(500) }]);
    expect(question.criteria).toEqual({
      atlas: "Atlas — Backend: Owns the API and the database.",
      milind: "Milind — Designer",
      rae: "Rae",
      long: `Long: ${"d".repeat(300)}`,
    });
  });
});

describe("pickSmartResponder", () => {
  it("returns the member Jev chose with its confidence", async () => {
    const stub = jevStub({ choice: "milind", probabilities: { atlas: 0.2, milind: 0.7, rae: 0.1 }, confidence: 0.62 });
    const pick = await pickSmartResponder("can you tweak the logo colours?", members, credentials, { fetchImpl: stub.fetchImpl });
    expect(pick?.member).toBe(members[1]);
    expect(pick?.confidence).toBe(0.62);
    expect(pick?.probabilities.milind).toBe(0.7);
    expect(stub.calls[0]!.body.state).toEqual({ message: "can you tweak the logo colours?" });
    expect(Object.keys(stub.calls[0]!.body.questions.responder.criteria)).toEqual(["atlas", "milind", "rae"]);
  });

  it("declines a pick under the confidence bar", async () => {
    const stub = jevStub({ choice: "atlas", probabilities: { atlas: 0.36, milind: 0.33, rae: 0.31 }, confidence: 0.2 });
    await expect(pickSmartResponder("hi all", members, credentials, { fetchImpl: stub.fetchImpl })).resolves.toBeNull();
    expect(0.2).toBeLessThan(JEV_ROUTING_MIN_CONFIDENCE);
  });

  it("declines a choice naming nobody in the roster", async () => {
    const stub = jevStub({ choice: "ghost", probabilities: { ghost: 1 }, confidence: 0.9 });
    await expect(pickSmartResponder("hi", members, credentials, { fetchImpl: stub.fetchImpl })).resolves.toBeNull();
    const missing = jevStub(null);
    await expect(pickSmartResponder("hi", members, credentials, { fetchImpl: missing.fetchImpl })).resolves.toBeNull();
  });

  it("routes a single member without asking", async () => {
    const stub = jevStub(null);
    const pick = await pickSmartResponder("hi", [members[0]!], credentials, { fetchImpl: stub.fetchImpl });
    expect(pick?.member).toBe(members[0]);
    expect(pick?.confidence).toBe(1);
    expect(stub.fetchImpl).not.toHaveBeenCalled();
    await expect(pickSmartResponder("hi", [], credentials, { fetchImpl: stub.fetchImpl })).resolves.toBeNull();
  });

  it("returns null on an error or a timeout instead of throwing", async () => {
    const unauthorized = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(pickSmartResponder("hi", members, credentials, { fetchImpl: unauthorized })).resolves.toBeNull();
    const offline = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(pickSmartResponder("hi", members, credentials, { fetchImpl: offline })).resolves.toBeNull();

    vi.useFakeTimers();
    try {
      const hanging = vi.fn((_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })) as unknown as typeof fetch;
      const pending = pickSmartResponder("hi", members, credentials, { fetchImpl: hanging, timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
