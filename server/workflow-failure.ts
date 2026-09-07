/** Why a workflow node attempt failed, as far as the engine can tell from
 * the one string it gets — a turn's stop reason, a runtime.error message, a
 * dispatch rejection, or one of its own reasons. Pure: the engine's retry
 * funnel (`attemptFailure`) branches on the class, so what counts as an
 * outage is decided in exactly one place and pinned by a table test.
 *
 * This is deliberately NOT `server/drivers/retry.ts`. That classifier
 * answers a different question — "should the driver relaunch its CLI
 * within one turn" — and treats every 404 and every `unexpected status`
 * as terminal, which is right for a request the driver just built and
 * wrong for a run: the evidence that started this module is a Codex
 * backend answering 404 for minutes and then coming back. A run measures
 * in hours, so it waits. */

export type WorkflowFailureClass =
  /** The harness refused the dispatch because the bot already has a turn:
   * nothing ran, nothing was learned. Re-parked, never charged. */
  | "contention"
  /** The bot cannot be dispatched at all (a permission only a person can
   * grant): no retry can fix it, so it is terminal. */
  | "capability"
  /** The model answered but not with a control envelope. */
  | "envelope"
  /** The node's own timeout, or a provider-side timeout. */
  | "timeout"
  /** The provider is unreachable or refusing everyone: waited out with a
   * long backoff that spends none of the node's attempts. */
  | "provider-outage"
  | "other";

/** The harness's refusal to start a turn on a bot that already has one. It
 * is a 409 with this wording, and index.ts already keys two other
 * recoveries off the same phrase — a dispatch that never began is
 * contention, and every caller that treats it as a failure is wrong in the
 * same way. */
export const BUSY_DISPATCH = /already working/i;

/** The reason strings the engine itself writes, so the classifier and the
 * funnel can never drift apart on them. */
export const NODE_TIMEOUT_REASON = "node timed out";
export const ENVELOPE_MISS_REASON = "node did not produce a valid outcome envelope";

/** Hosts whose 404 is a provider backend failing, not a resource that does
 * not exist. A 404 on anything else — "no such thread" — stays terminal
 * in the driver and `other` here. The URL is in the message because that
 * is how codex's app-server formats a transport error
 * (`unexpected status 404 Not Found: …, url: https://chatgpt.com/…`). */
const PROVIDER_BACKEND = /backend-api|chatgpt\.com|openai\.com|anthropic\.com|googleapis\.com|api\.x\.ai/i;

const OUTAGE_PATTERNS: RegExp[] = [
  // HTTP-level refusals as codex/claude spell them ("unexpected status 503
  // Service Unavailable", "HTTP 529", "529 overloaded"). A bare three-digit
  // number is not enough: "step 512 failed" is not a gateway.
  /\b(?:status|http|error)\s*:?\s*5\d{2}\b/i,
  /\b5\d{2}\s+(?:internal server error|bad gateway|service unavailable|gateway time-?out|overloaded)/i,
  /\binternal server error\b|\bbad gateway\b|\bservice unavailable\b|\bgateway time-?out\b|\boverloaded\b|\bat capacity\b/i,
  /\b(?:status|http|error)\s*:?\s*429\b|\b429\s+too many requests\b|\brate.?limit/i,
  /\btoo many requests\b/i,
  // Transport: what node's fetch and the CLIs' stderr surface.
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)\b/,
  /\bfetch failed\b|\bsocket hang up\b|\bconnection reset\b|\bconnection refused\b|\bnetwork error\b/i,
  // The engine process died before it answered, or would not die when
  // asked: the harness lost the provider, whatever the provider was doing.
  /\bexit_before_result\b/,
  /\bexited (?:-?\d+|null) before turn\/completed\b/,
  /\bdid not shut down\b/,
];

/** Classify one attempt's failure reason. Order is precedence: contention
 * and capability are the harness's own words and never look like a
 * provider error; the engine's envelope reason is exact; an outage is
 * judged before a timeout because `ETIMEDOUT` is a dead connection, not a
 * slow model. */
export function classifyWorkflowFailure(reason: string): WorkflowFailureClass {
  const text = reason.trim();
  if (BUSY_DISPATCH.test(text)) return "contention";
  if (/\bis not allowed to (?:merge|deploy)\b/.test(text)) return "capability";
  if (text === ENVELOPE_MISS_REASON) return "envelope";
  if (/\b404\b/.test(text) && PROVIDER_BACKEND.test(text)) return "provider-outage";
  if (OUTAGE_PATTERNS.some((pattern) => pattern.test(text))) return "provider-outage";
  if (text === NODE_TIMEOUT_REASON || /\btimed? out\b|\btimeout\b/i.test(text)) return "timeout";
  return "other";
}

/** First wait of the outage backoff; every later one doubles until the cap. */
export const OUTAGE_BACKOFF_BASE_MS = 60_000;
/** Jitter keeps a fleet of runs that saw the same outage from re-hitting
 * the provider on the same second when it comes back. ±25%, so a test can
 * bound every wait. */
const OUTAGE_JITTER = 0.25;

/** How long the `attempt`-th wait (1-based) of an outage lasts: base × 2^(n-1),
 * capped, with ±25% jitter from `random` (0 ≤ random < 1). */
export function outageDelayMs(attempt: number, capMs: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  const nominal = Math.min(OUTAGE_BACKOFF_BASE_MS * 2 ** exponent, capMs);
  const spread = nominal * OUTAGE_JITTER;
  return Math.round(nominal - spread + random() * spread * 2);
}

/** How many waits the horizon allows on the nominal (jitter-free) schedule:
 * the "of Z" the UI prints. Never fewer than one, so a horizon shorter than
 * the first wait still yields "attempt 1 of 1" rather than "of 0". */
export function outagePlannedAttempts(capMs: number, horizonMs: number): number {
  let elapsed = 0;
  let count = 0;
  for (;;) {
    elapsed += Math.min(OUTAGE_BACKOFF_BASE_MS * 2 ** Math.min(count, 30), capMs);
    if (elapsed > horizonMs) break;
    count++;
    if (count >= 10_000) break; // a pathological cap/horizon pair must not spin
  }
  return Math.max(1, count);
}
