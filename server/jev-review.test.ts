import { describe, expect, it, vi } from "vitest";

import { MAX_REVIEW_REASON_CHARS } from "./auto-review.ts";
import { JEV_REVIEW_MIN_CONFIDENCE, jevReviewer, requestJevReview } from "./jev-review.ts";

const reviewer = { credentials: { apiKey: "ts-key", model: "jev-latest" }, unattended: false, guarded: false };
const unattendedReviewer = { ...reviewer, unattended: true };
const guardedReviewer = { ...reviewer, guarded: true };
const request = { tool: "Bash", summary: "git status", persona: "Repo scout" };

type Answers = {
  verdict?: { choice: string; probabilities: Record<string, number>; confidence: number };
  risky?: number;
};

/** A TypeSafe stub that answers every call with the same verdict. */
function jevStub(answers: Answers, model = "jev-1.13.0") {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    return new Response(
      JSON.stringify({
        model,
        answers: {
          ...(answers.verdict ? { verdict: { type: "choice", ...answers.verdict } } : {}),
          ...(answers.risky !== undefined ? { risky: { type: "noul", noul: answers.risky } } : {}),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const confidentAllow = { choice: "allow", probabilities: { allow: 0.91, deny: 0.09 }, confidence: 0.82 };

describe("jevReviewer", () => {
  it("is enabled only by the explicit opt-in plus a key", () => {
    expect(jevReviewer({})).toBeNull();
    expect(jevReviewer({ typesafe: { key: "k" } })).toBeNull();
    expect(jevReviewer({ typesafe: { permissionReview: true } })).toBeNull();
    expect(jevReviewer({ typesafe: { key: "k", permissionReview: true } })).toEqual({
      credentials: { apiKey: "k", model: "jev-latest", gateway: "typesafe" },
      unattended: false,
      guarded: false,
    });
    expect(jevReviewer({ typesafe: { key: "k", permissionReview: true, reviewGuarded: true } })?.guarded).toBe(true);
    expect(jevReviewer({ typesafe: { key: "k", reviewGuarded: true } })).toBeNull();
    // The second opt-in rides on the first: alone it enables nothing.
    expect(jevReviewer({ typesafe: { key: "k", reviewUnattended: true } })).toBeNull();
    expect(jevReviewer({ typesafe: { key: "k", permissionReview: true, reviewUnattended: true } })?.unattended).toBe(true);
    // The opt-in also works with only an OpenRouter key: same model, reached
    // through OpenRouter's Decisions endpoint.
    expect(jevReviewer({ typesafe: { permissionReview: true }, openrouter: { key: "sk-or" } })).toEqual({
      unattended: false,
      guarded: false,
      credentials: { apiKey: "sk-or", model: "jev-latest", gateway: "openrouter" },
    });
    expect(jevReviewer({ openrouter: { key: "sk-or" } })).toBeNull();
  });
});

describe("requestJevReview", () => {
  it("answers an unattended card only under the second opt-in, with stricter thresholds", async () => {
    // no opt-in: Jev is not even asked
    const untouched = jevStub({ verdict: confidentAllow, risky: 0.05 });
    await expect(requestJevReview(reviewer, request, { fetchImpl: untouched.fetchImpl, unattended: true })).resolves.toBeNull();
    expect(untouched.calls).toHaveLength(0);

    // opted in: 82% confidence / 8% risk passes both bars and says so
    const allowed = jevStub({ verdict: confidentAllow, risky: 0.08 });
    await expect(requestJevReview(unattendedReviewer, request, { fetchImpl: allowed.fetchImpl, unattended: true })).resolves.toEqual({
      allow: true,
      reason: "jev-1.13.0: allow 91% (confidence 82%), risk 8%, unattended",
    });

    // an allow that would pass attended (0.6 / 0.5) is a deny with nobody watching
    const marginal = jevStub({ verdict: { ...confidentAllow, confidence: 0.7 }, risky: 0.08 });
    await expect(requestJevReview(unattendedReviewer, request, { fetchImpl: marginal.fetchImpl, unattended: true }))
      .resolves.toMatchObject({ allow: false });
    await expect(requestJevReview(unattendedReviewer, request, { fetchImpl: marginal.fetchImpl })).resolves.toMatchObject({ allow: true });
    const risky = jevStub({ verdict: confidentAllow, risky: 0.4 });
    await expect(requestJevReview(unattendedReviewer, request, { fetchImpl: risky.fetchImpl, unattended: true }))
      .resolves.toMatchObject({ allow: false });
  });

  it("judges a guard-flagged card only under the guarded opt-in, with the flag in the state", async () => {
    const untouched = jevStub({ verdict: confidentAllow, risky: 0.05 });
    await expect(requestJevReview(reviewer, request, { fetchImpl: untouched.fetchImpl, flagged: "destructive: rm -rf" })).resolves.toBeNull();
    expect(untouched.calls).toHaveLength(0);

    const judged = jevStub({ verdict: confidentAllow, risky: 0.08 });
    await expect(requestJevReview(guardedReviewer, request, { fetchImpl: judged.fetchImpl, flagged: "destructive: rm -rf" }))
      .resolves.toMatchObject({ allow: true });
    expect(judged.calls[0]!.body.state).toEqual({ bot: "Repo scout", tool: "Bash", action: "git status", flagged: "destructive: rm -rf" });
    // without a flag the state carries no such field
    const plain = jevStub({ verdict: confidentAllow, risky: 0.08 });
    await requestJevReview(guardedReviewer, request, { fetchImpl: plain.fetchImpl });
    expect(plain.calls[0]!.body.state).not.toHaveProperty("flagged");
  });

  it("allows a confident, low-risk allow and explains it", async () => {
    const stub = jevStub({ verdict: confidentAllow, risky: 0.08 });
    await expect(requestJevReview(reviewer, request, { fetchImpl: stub.fetchImpl })).resolves.toEqual({
      allow: true,
      reason: "jev-1.13.0: allow 91% (confidence 82%), risk 8%",
    });
    expect(stub.calls).toHaveLength(1);
    const { body, headers, url } = stub.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(headers.authorization).toBe("Bearer ts-key");
    expect(body.state).toEqual({ bot: "Repo scout", tool: "Bash", action: "git status" });
    expect(Object.keys(body.questions)).toEqual(["verdict", "risky"]);
    expect(body.questions.verdict.criteria).toHaveProperty("allow");
    expect(body.questions.verdict.criteria).toHaveProperty("deny");
  });

  it("denies an allow Jev is not confident about", async () => {
    const stub = jevStub({ verdict: { ...confidentAllow, confidence: 0.4 }, risky: 0.05 });
    const verdict = await requestJevReview(reviewer, request, { fetchImpl: stub.fetchImpl });
    expect(verdict?.allow).toBe(false);
    expect(verdict?.reason).toContain("confidence 40%");
    expect(0.4).toBeLessThan(JEV_REVIEW_MIN_CONFIDENCE);
  });

  it("denies when Jev chooses deny", async () => {
    const stub = jevStub({ verdict: { choice: "deny", probabilities: { allow: 0.1, deny: 0.9 }, confidence: 0.95 }, risky: 0.2 });
    await expect(requestJevReview(reviewer, request, { fetchImpl: stub.fetchImpl })).resolves.toEqual({
      allow: false,
      reason: "jev-1.13.0: deny 90% (confidence 95%), risk 20%",
    });
  });

  it("denies a confident allow that the risk gate contradicts", async () => {
    const stub = jevStub({ verdict: confidentAllow, risky: 0.7 });
    const verdict = await requestJevReview(reviewer, request, { fetchImpl: stub.fetchImpl });
    expect(verdict?.allow).toBe(false);
    expect(verdict?.reason).toContain("risk 70%");
  });

  it("produces no verdict when an answer is missing or mistyped", async () => {
    const missingRisk = jevStub({ verdict: confidentAllow });
    await expect(requestJevReview(reviewer, request, { fetchImpl: missingRisk.fetchImpl })).resolves.toBeNull();
    const missingVerdict = jevStub({ risky: 0.1 });
    await expect(requestJevReview(reviewer, request, { fetchImpl: missingVerdict.fetchImpl })).resolves.toBeNull();
  });

  it("fails closed on a rejected key, a network failure, or a timeout", async () => {
    const unauthorized = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(requestJevReview(reviewer, request, { fetchImpl: unauthorized })).resolves.toBeNull();

    const offline = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(requestJevReview(reviewer, request, { fetchImpl: offline })).resolves.toBeNull();

    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const hanging = vi.fn((_url: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }) as unknown as typeof fetch;
      const pending = requestJevReview(reviewer, request, { fetchImpl: hanging, timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toBeNull();
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the state fields and the reason", async () => {
    const stub = jevStub({ verdict: confidentAllow, risky: 0.01 }, "m".repeat(400));
    const verdict = await requestJevReview(
      reviewer,
      { ...request, summary: "x".repeat(5_000), persona: "p".repeat(5_000) },
      { fetchImpl: stub.fetchImpl },
    );
    expect(stub.calls[0]!.body.state.action).toHaveLength(2_000);
    expect(stub.calls[0]!.body.state.bot).toHaveLength(2_000);
    expect(verdict?.allow).toBe(true);
    expect(verdict?.reason.length).toBeLessThanOrEqual(MAX_REVIEW_REASON_CHARS);
  });
});
