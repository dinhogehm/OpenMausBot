// The one place "is this a provider outage" is decided for a workflow run.
// The table pins the strings the drivers actually emit — read off
// codex.ts/claude.ts and off two real failed runs — so a driver rewording
// an error is caught here, not by a run that gave up at 3am.
import { describe, expect, it } from "vitest";

import {
  BUSY_DISPATCH,
  classifyWorkflowFailure,
  ENVELOPE_MISS_REASON,
  NODE_TIMEOUT_REASON,
  OUTAGE_BACKOFF_BASE_MS,
  outageDelayMs,
  outagePlannedAttempts,
  type WorkflowFailureClass,
} from "./workflow-failure.ts";

const MIN = 60_000;
const HOUR = 3_600_000;

describe("classifyWorkflowFailure", () => {
  const table: Array<[string, WorkflowFailureClass]> = [
    // The two real runs of 2026-09-03: codex's app-server relays the
    // backend's transport error verbatim as the turn's stop reason.
    [
      "unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: 8f3a1b2c4d5e6f70-GRU",
      "provider-outage",
    ],
    ["exit_before_result", "provider-outage"],
    // codex.ts close handler, when the process died first
    ["codex exited 1 before turn/completed: some stderr tail", "provider-outage"],
    ["codex exited null before turn/completed", "provider-outage"],
    // codex.ts termination path
    ["codex did not shut down after termination was requested", "provider-outage"],
    // HTTP refusals as codex spells them
    ["unexpected status 500 Internal Server Error: Unknown error, url: https://chatgpt.com/backend-api/codex/responses", "provider-outage"],
    ["unexpected status 502 Bad Gateway", "provider-outage"],
    ["unexpected status 503 Service Unavailable", "provider-outage"],
    ["unexpected status 529 overloaded_error", "provider-outage"],
    ["unexpected status 429 Too Many Requests: Rate limit reached", "provider-outage"],
    ["rate_limit_error: This request would exceed your rate limit", "provider-outage"],
    ["Rate limited, try again later", "provider-outage"],
    // Transport — node's fetch and the CLIs' stderr
    ["fetch failed", "provider-outage"],
    ["TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:443", "provider-outage"],
    ["read ECONNRESET", "provider-outage"],
    ["connect ETIMEDOUT 104.18.32.47:443", "provider-outage"],
    ["getaddrinfo ENOTFOUND api.anthropic.com", "provider-outage"],
    ["getaddrinfo EAI_AGAIN api.openai.com", "provider-outage"],
    ["socket hang up", "provider-outage"],
    ["HTTP 529", "provider-outage"],
    ["error 503 from upstream", "provider-outage"],
    // A 404 on anything that is not a provider backend is not an outage
    ["404 no such thread", "other"],
    ["unexpected status 404 Not Found", "other"],
    // A three-digit number is not a status code
    ["step 512 failed", "other"],
    ["reached 429 tokens", "other"],
    // Contention is the harness's own 409 and stays its own class
    ["the bot is already working — interrupt it first", "contention"],
    // Only a person can grant what these are missing
    ['Node "deploy" requires "deploy" but its bot "b1" is not allowed to deploy.', "capability"],
    // The engine's own reasons
    [ENVELOPE_MISS_REASON, "envelope"],
    [NODE_TIMEOUT_REASON, "timeout"],
    ["Request timed out", "timeout"],
    ["timeout waiting for response", "timeout"],
    // Everything a retry may legitimately fix, or that is the model's own doing
    ["the bot did not complete this node", "other"],
    ["the model engine is not installed", "other"],
    ["failed", "other"],
    ["interrupted", "other"],
    ["spawn_error", "other"],
    // Auth is neither an outage nor something a fallback should paper over
    ["unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", "other"],
    ["", "other"],
  ];

  it.each(table)("%j → %s", (reason, expected) => {
    expect(classifyWorkflowFailure(reason)).toBe(expected);
  });

  it("classifies a dead connection as an outage even though it says timed out", () => {
    // ETIMEDOUT is a socket that never connected, not a slow model:
    // precedence puts the outage rules before the timeout rule.
    expect(classifyWorkflowFailure("connect ETIMEDOUT 1.2.3.4:443 (request timed out)")).toBe("provider-outage");
  });

  it("keeps the contention regexp the engine keys on", () => {
    expect(BUSY_DISPATCH.test("the bot is already working — interrupt it first")).toBe(true);
    expect(BUSY_DISPATCH.test("already Working")).toBe(true);
    expect(BUSY_DISPATCH.test("working on it")).toBe(false);
  });
});

describe("outageDelayMs", () => {
  const noJitter = () => 0.5;

  it("doubles from one minute and stops at the cap", () => {
    expect(OUTAGE_BACKOFF_BASE_MS).toBe(MIN);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => outageDelayMs(attempt, 60 * MIN, noJitter))).toEqual([
      1 * MIN,
      2 * MIN,
      4 * MIN,
      8 * MIN,
      16 * MIN,
      32 * MIN,
      60 * MIN,
      60 * MIN,
    ]);
  });

  it("honours a lower cap", () => {
    expect(outageDelayMs(5, 5 * MIN, noJitter)).toBe(5 * MIN);
  });

  it("jitters within ±25% and never below", () => {
    expect(outageDelayMs(1, 60 * MIN, () => 0)).toBe(0.75 * MIN);
    expect(outageDelayMs(1, 60 * MIN, () => 0.999999)).toBeLessThanOrEqual(1.25 * MIN);
    expect(outageDelayMs(1, 60 * MIN, () => 0.999999)).toBeGreaterThan(1.24 * MIN);
  });

  it("treats attempt 0 and negative attempts as the first wait", () => {
    expect(outageDelayMs(0, 60 * MIN, noJitter)).toBe(MIN);
    expect(outageDelayMs(-3, 60 * MIN, noJitter)).toBe(MIN);
  });
});

describe("outagePlannedAttempts", () => {
  it("counts the nominal waits that fit in the horizon: the defaults give ten in six hours", () => {
    // 1+2+4+8+16+32 = 63 min, then 60-minute waits: 123, 183, 243, 303,
    // and the eleventh would land at 363 > 360.
    expect(outagePlannedAttempts(60 * MIN, 6 * HOUR)).toBe(10);
  });

  it("never reports fewer than one, so the UI never prints 'of 0'", () => {
    expect(outagePlannedAttempts(60 * MIN, 30_000)).toBe(1);
  });

  it("uses the cap when it is lower than the doubling schedule", () => {
    // 1, 2, 4, 5, 5, 5, … within 30 minutes: 1+2+4=7, then 12, 17, 22, 27, 32>30 → 7
    expect(outagePlannedAttempts(5 * MIN, 30 * MIN)).toBe(7);
  });
});
