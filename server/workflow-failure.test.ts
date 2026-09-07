// The one place "is this a provider outage" is decided for a workflow run.
// Two tables. The first pins the reason STRINGS the engine actually has in
// hand: a dispatch rejection, its own reasons, and the line
// `describeWorkflowTurnFailure` builds from a not-ok turn. The second pins
// the (runtime.error message, stopReason, setup) PAIRS the four drivers
// really emit — read off codex.ts, claude.ts, acp/core.ts and pi.ts, and
// off two failed runs of 2026-09-03 — so a driver rewording an error is
// caught here, not by a run that waited six hours on a bad API key.
import { describe, expect, it } from "vitest";

import {
  BUSY_DISPATCH,
  classifyWorkflowFailure,
  classifyWorkflowTurnFailure,
  describeWorkflowTurnFailure,
  ENVELOPE_MISS_REASON,
  NODE_TIMEOUT_REASON,
  OUTAGE_BACKOFF_BASE_MS,
  outageDelayMs,
  outagePlannedAttempts,
  TURN_FAILURE_DEFAULT_REASON,
  type WorkflowFailureClass,
  type WorkflowTurnFailure,
} from "./workflow-failure.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const CODEX_404 =
  "unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: 8f3a1b2c4d5e6f70-GRU";

describe("classifyWorkflowFailure — reason strings", () => {
  const table: Array<[string, WorkflowFailureClass]> = [
    // codex.ts `turn/completed`: the provider's text IS the stop reason
    // (t.error.message), as in the two real runs of 2026-09-03.
    [CODEX_404, "provider-outage"],
    ["unexpected status 500 Internal Server Error: Unknown error, url: https://chatgpt.com/backend-api/codex/responses", "provider-outage"],
    ["unexpected status 502 Bad Gateway", "provider-outage"],
    ["unexpected status 503 Service Unavailable", "provider-outage"],
    ["unexpected status 529 overloaded_error", "provider-outage"],
    ["unexpected status 429 Too Many Requests: Rate limit reached", "provider-outage"],
    ["HTTP 529", "provider-outage"],
    ["error 503 from upstream", "provider-outage"],
    ["rate_limit_error: This request would exceed your rate limit", "provider-outage"],
    ["Rate limited, try again later", "provider-outage"],
    // Transport — node's fetch and the CLIs' stderr, as the described line carries them
    ["fetch failed", "provider-outage"],
    ["TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:443 (rpc_error)", "provider-outage"],
    ["read ECONNRESET (exit_before_result)", "provider-outage"],
    ["connect ETIMEDOUT 104.18.32.47:443", "provider-outage"],
    ["getaddrinfo ENOTFOUND api.anthropic.com", "provider-outage"],
    ["getaddrinfo EAI_AGAIN api.openai.com", "provider-outage"],
    ["socket hang up", "provider-outage"],
    // The drivers' close-handler wording: a process that died with no
    // explanation of its own
    ["codex exited null before turn/completed (exit_before_result)", "provider-outage"],
    ["codex exited 1 before turn/completed: some stderr tail (exit_before_result)", "provider-outage"],
    ["claude exited 1 before result (exit_before_result)", "provider-outage"],
    ["gemini exited 137 before the prompt result (exit_before_result)", "provider-outage"],
    ["pi process exited before replying", "provider-outage"],
    ["codex did not shut down after termination was requested (shutdown_timeout)", "provider-outage"],
    // …but one that DID explain itself with a credential or a shape problem
    // is not an outage, whatever else the line says
    ["claude exited 1 before result: Invalid API key · Please run /login (exit_before_result)", "other"],
    ["claude exited 1 before result: Not logged in · Please run /login (exit_before_result)", "other"],
    ["unexpected status 401 Unauthorized: Missing bearer or basic authentication in header (rpc_error)", "other"],
    ["unexpected status 403 Forbidden (rpc_error)", "other"],
    ["unexpected status 400 Bad Request: model not found (rpc_error)", "other"],
    ["unexpected status 422 Unprocessable Entity: invalid request (rpc_error)", "other"],
    ["codex exited 1 before turn/completed: Error: model `gpt-99` does not exist for model (exit_before_result)", "other"],
    ["`codex` isn't installed, or isn't on this app's PATH (spawn_error)", "other"],
    ["spawn failed: spawn codex ENOENT (spawn_error)", "other"],
    ["insufficient_quota: You exceeded your current quota (rpc_error)", "other"],
    // A bare stop code on its own says nothing
    ["exit_before_result", "other"],
    ["rpc_error", "other"],
    ["failed", "other"],
    ["interrupted", "other"],
    ["spawn_error", "other"],
    [TURN_FAILURE_DEFAULT_REASON, "other"],
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
    // Dispatch rejections that a retry may legitimately fix
    ["the model engine is not installed", "other"],
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

describe("describeWorkflowTurnFailure / classifyWorkflowTurnFailure — what the drivers emit", () => {
  /** [driver path, the pair, the line the engine records, its class] */
  const table: Array<[string, WorkflowTurnFailure, string, WorkflowFailureClass]> = [
    [
      "codex turn/completed with a backend 404 (no runtime.error)",
      { stopReason: CODEX_404 },
      CODEX_404,
      "provider-outage",
    ],
    [
      "codex launch-catch: transport error as runtime.error + rpc_error",
      { stopReason: "rpc_error", message: "unexpected status 503 Service Unavailable, url: https://chatgpt.com/backend-api/codex/responses" },
      "unexpected status 503 Service Unavailable, url: https://chatgpt.com/backend-api/codex/responses (rpc_error)",
      "provider-outage",
    ],
    [
      "codex launch-catch: auth as runtime.error{setup} + auth_required",
      { stopReason: "auth_required", message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", setup: true },
      "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header (auth_required)",
      "other",
    ],
    [
      "codex close handler: process died, stderr tail + exit_before_result",
      { stopReason: "exit_before_result", message: "codex exited null before turn/completed" },
      "codex exited null before turn/completed (exit_before_result)",
      "provider-outage",
    ],
    [
      "codex shutdown: did not shut down + shutdown_timeout",
      { stopReason: "shutdown_timeout", message: "codex did not shut down after termination was requested" },
      "codex did not shut down after termination was requested (shutdown_timeout)",
      "provider-outage",
    ],
    [
      "claude close handler: dropped socket in stderr + exit_before_result",
      { stopReason: "exit_before_result", message: "claude exited 1 before result: TypeError: fetch failed" },
      "claude exited 1 before result: TypeError: fetch failed (exit_before_result)",
      "provider-outage",
    ],
    [
      "claude close handler: bad key in stderr + exit_before_result — NOT an outage",
      { stopReason: "exit_before_result", message: "claude exited 1 before result: Invalid API key · Please run /login" },
      "claude exited 1 before result: Invalid API key · Please run /login (exit_before_result)",
      "other",
    ],
    [
      "claude close handler: unknown model in stderr + exit_before_result — NOT an outage",
      { stopReason: "exit_before_result", message: "claude exited 1 before result: API Error: 404 model not found" },
      "claude exited 1 before result: API Error: 404 model not found (exit_before_result)",
      "other",
    ],
    [
      "claude relaunch-catch: relaunch threw + exit_before_result",
      { stopReason: "exit_before_result", message: "spawn failed: spawn claude ENOENT" },
      "spawn failed: spawn claude ENOENT (exit_before_result)",
      "other",
    ],
    [
      "acp close handler: process died + exit_before_result",
      { stopReason: "exit_before_result", message: "gemini exited 137 before the prompt result" },
      "gemini exited 137 before the prompt result (exit_before_result)",
      "provider-outage",
    ],
    [
      "acp prompt-catch: 529 as runtime.error + rpc_error",
      { stopReason: "rpc_error", message: "HTTP 529: overloaded" },
      "HTTP 529: overloaded (rpc_error)",
      "provider-outage",
    ],
    [
      "acp prompt-catch: login note as runtime.error{setup} + auth_required",
      { stopReason: "auth_required", message: "Run `gemini` once in a terminal to sign in", setup: true },
      "Run `gemini` once in a terminal to sign in (auth_required)",
      "other",
    ],
    [
      "acp result error: provider text as runtime.error + the ACP stop reason",
      { stopReason: "refusal", message: "Model turn failed: refusal" },
      "Model turn failed: refusal (refusal)",
      "other",
    ],
    [
      "pi turn_end error: errorMessage as runtime.error + failed",
      { stopReason: "failed", message: "rate_limit_error: This request would exceed your rate limit" },
      "rate_limit_error: This request would exceed your rate limit (failed)",
      "provider-outage",
    ],
    [
      "pi turn_end error with no detail",
      { stopReason: "failed", message: "pi turn failed" },
      "pi turn failed (failed)",
      "other",
    ],
    [
      "pi spawn error: runtime.error{setup} and settle(false) with no stop reason",
      { message: "`pi` isn't installed, or isn't on this app's PATH", setup: true },
      "`pi` isn't installed, or isn't on this app's PATH",
      "other",
    ],
    [
      "pi close with nothing said: settle(false) and no runtime.error at all",
      {},
      TURN_FAILURE_DEFAULT_REASON,
      "other",
    ],
    [
      "any driver: a user interrupt",
      { stopReason: "interrupted" },
      "interrupted",
      "other",
    ],
    [
      "setup flag wins even over outage-looking text",
      { stopReason: "rpc_error", message: "fetch failed", setup: true },
      "fetch failed (rpc_error)",
      "other",
    ],
  ];

  it.each(table)("%s", (_path, failure, described, expected) => {
    expect(describeWorkflowTurnFailure(failure)).toBe(described);
    expect(classifyWorkflowTurnFailure(failure)).toBe(expected);
  });

  it("a bare stop code alone is recorded as itself and never an outage", () => {
    expect(describeWorkflowTurnFailure({ stopReason: "exit_before_result" })).toBe("exit_before_result");
    expect(classifyWorkflowTurnFailure({ stopReason: "exit_before_result" })).toBe("other");
    expect(classifyWorkflowTurnFailure({ stopReason: "rpc_error" })).toBe("other");
  });

  it("trims and ignores blank parts", () => {
    expect(describeWorkflowTurnFailure({ stopReason: "  ", message: " fetch failed " })).toBe("fetch failed");
    expect(describeWorkflowTurnFailure({ stopReason: "failed", message: "" })).toBe("failed");
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
