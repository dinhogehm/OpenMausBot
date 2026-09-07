/** Why a workflow node attempt failed, as far as the engine can tell from
 * what a turn leaves behind — a `turn.completed` stop reason, the last
 * `runtime.error` message (and its `setup` flag) on that thread, or a
 * dispatch rejection — plus the engine's own reasons. Pure: the engine's
 * retry funnel (`attemptFailure`) branches on the class, so what counts as
 * an outage is decided in exactly one place and pinned by a table test.
 *
 * What the drivers actually hand over (read off codex.ts, claude.ts,
 * acp/core.ts, pi.ts): the stop reason is usually a bare CODE —
 * `exit_before_result`, `rpc_error`, `auth_required`, `failed`,
 * `spawn_error`, `shutdown_timeout` — and the sentence that says what
 * happened rides on a `runtime.error` emitted just before it. Only codex's
 * `turn/completed` puts the provider's text in the stop reason itself. So
 * a failure is described from BOTH, and a bare code never decides on its
 * own: claude.ts settles every death of its CLI with a turn still live as
 * `exit_before_result`, whether the cause was a dropped socket or
 * "Invalid API key · Please run /login".
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

/** What must NEVER be waited out or handed to a fallback, whatever else
 * the message says: a credential, a request the provider refuses by
 * shape, a model that does not exist, a CLI that is not installed. These
 * are judged before any outage pattern, because a driver's stderr tail
 * can carry both ("exited 1 before result: Invalid API key"). */
const TERMINAL_PATTERNS: RegExp[] = [
  /\b(?:status|http|error)\s*:?\s*(?:400|401|403|422)\b/i,
  /\b40[13]\s+(?:unauthorized|forbidden)\b|\b400\s+bad request\b/i,
  /\bunauthorized\b|\bforbidden\b|\binvalid api key\b|\bmissing bearer\b|\bauthentication required\b|\bnot logged in\b|\blogged out\b/i,
  /\binvalid request\b|\bmalformed\b|\bmodel not found\b|\bunknown model\b|\bunsupported model\b|\bdoes not exist for model\b/i,
  /\bisn't installed\b|\bisn't executable\b|\bcommand not found\b|\bENOENT\b|\bEACCES\b/,
];

/** Account-side refusals that read as terminal — unless the same line
 * carries a 5xx/429 with status context: Gemini's
 * `429 RESOURCE_EXHAUSTED: Quota exceeded` is the provider throttling,
 * which passes, not a card that expired. Same for a "/login" hint riding
 * on a 503 page. */
const ACCOUNT_PATTERNS: RegExp[] = [/\binsufficient_quota\b|\bquota\b|\bbilling\b/i, /\/login\b/i];
const STATUS_THROTTLE: RegExp[] = [
  /\b(?:status|http|error)\s*:?\s*(?:5\d{2}|429)\b/i,
  /\b(?:5\d{2}|429)\s+(?:internal server error|bad gateway|service unavailable|gateway time-?out|overloaded|too many requests)/i,
  /\b(?:5\d{2}|429)\s+[A-Z_]{4,}\b/,
];

const OUTAGE_PATTERNS: RegExp[] = [
  // HTTP-level refusals as codex/claude spell them ("unexpected status 503
  // Service Unavailable", "HTTP 529", "529 overloaded"). A bare three-digit
  // number is not enough: "step 512 failed" is not a gateway.
  /\b(?:status|http|error)\s*:?\s*5\d{2}\b/i,
  /\b5\d{2}\s+(?:internal server error|bad gateway|service unavailable|gateway time-?out|overloaded)/i,
  /\binternal server error\b|\bbad gateway\b|\bservice unavailable\b|\bgateway time-?out\b|\boverloaded\b|\bat capacity\b/i,
  /\b(?:status|http|error)\s*:?\s*429\b|\b429\s+too many requests\b|\brate.?limit/i,
  // A status followed by an UPPER_CASE reason code, Google-style
  // ("429 RESOURCE_EXHAUSTED"); case-sensitive on purpose, "429 tokens" is prose.
  /\b(?:5\d{2}|429)\s+[A-Z_]{4,}\b/,
  /\btoo many requests\b/i,
  // Transport: what node's fetch and the CLIs' stderr surface.
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)\b/,
  /\bfetch failed\b|\bsocket hang up\b|\bconnection reset\b|\bconnection refused\b|\bnetwork error\b/i,
  // The engine process died before it answered, or would not die when
  // asked — the drivers' own close-handler wording (codex, claude, acp,
  // pi). A death that explained itself with a credential or a missing
  // binary was caught by TERMINAL_PATTERNS above; one that did not is the
  // harness losing the provider, whatever the provider was doing.
  /\bexited (?:-?\d+|null) before (?:turn\/completed|result|the prompt result)\b/,
  /\bprocess exited before replying\b/,
  /\bdid not shut down\b/,
];

/** Classify one attempt's failure reason. Order is precedence: contention
 * and capability are the harness's own words and never look like a
 * provider error; the engine's envelope reason is exact; a credential,
 * request-shape or setup problem is terminal-ish (`other`: the node's
 * ordinary budget, never a six-hour wait and never a fallback) even when
 * a dead-process sentence sits beside it; an outage is judged before a
 * timeout because `ETIMEDOUT` is a dead connection, not a slow model. A
 * bare stop code on its own (`exit_before_result`, `rpc_error`, `failed`)
 * says nothing and is `other` — see `describeWorkflowTurnFailure`. */
export function classifyWorkflowFailure(reason: string): WorkflowFailureClass {
  const text = reason.trim();
  if (BUSY_DISPATCH.test(text)) return "contention";
  if (/\bis not allowed to (?:merge|deploy)\b/.test(text)) return "capability";
  if (text === ENVELOPE_MISS_REASON) return "envelope";
  if (TERMINAL_PATTERNS.some((pattern) => pattern.test(text))) return "other";
  if (ACCOUNT_PATTERNS.some((pattern) => pattern.test(text)) && !STATUS_THROTTLE.some((pattern) => pattern.test(text))) {
    return "other";
  }
  if (/\b404\b/.test(text) && PROVIDER_BACKEND.test(text)) return "provider-outage";
  if (OUTAGE_PATTERNS.some((pattern) => pattern.test(text))) return "provider-outage";
  if (text === NODE_TIMEOUT_REASON || /\btimed? out\b|\btimeout\b/i.test(text)) return "timeout";
  return "other";
}

/** What a not-ok `turn.completed` leaves the engine: its stop reason and
 * the last `runtime.error` on the thread (message and `setup` flag), any
 * of which may be absent. */
export interface WorkflowTurnFailure {
  stopReason?: string;
  message?: string;
  /** The driver's own verdict that this is a setup problem (credentials,
   * a missing binary): never an outage, whatever the text says. */
  setup?: boolean;
}

export const TURN_FAILURE_DEFAULT_REASON = "the bot did not complete this node";

/** A stop reason that is a code, not a description: one snake_case token
 * (`exit_before_result`, `rpc_error`, `auth_required`, `failed`). Codex's
 * `turn/completed` is the one driver path that puts a sentence there. */
const isBareStopCode = (stopReason: string): boolean => /^[a-z][a-z0-9_]*$/i.test(stopReason.trim());

/** The one line the engine records — in `outage.reason`, on the failed
 * result, in the run's error — for a turn that ended not-ok. The
 * runtime.error MESSAGE is the substance whenever the stop reason is a
 * bare code; the code is kept in parentheses so the receipt still says
 * which driver path it came through. A descriptive stop reason (codex's
 * provider text) stands on its own. */
export function describeWorkflowTurnFailure(failure: WorkflowTurnFailure): string {
  const stopReason = failure.stopReason?.trim() || undefined;
  const message = failure.message?.trim() || undefined;
  if (stopReason === undefined) return message ?? TURN_FAILURE_DEFAULT_REASON;
  if (!isBareStopCode(stopReason)) return stopReason;
  return message === undefined ? stopReason : `${message} (${stopReason})`;
}

/** Classify a not-ok turn from what the drivers actually emit. A driver
 * that flagged the error as `setup` has already said it is not the
 * provider's fault; otherwise the described line is classified as any
 * other reason. */
export function classifyWorkflowTurnFailure(failure: WorkflowTurnFailure): WorkflowFailureClass {
  if (failure.setup) return "other";
  // The harness's own stop — the timeout sweep's interrupt, a person's
  // cancel — is never the provider's fault, whatever runtime.error was
  // logged earlier on the thread. The sweep already knows it timed out
  // (it calls attemptFailure itself); anything else is `other`.
  if (failure.stopReason !== undefined && HARNESS_STOP.test(failure.stopReason)) return "other";
  return classifyWorkflowFailure(describeWorkflowTurnFailure(failure));
}

/** Stop reasons the drivers use for a stop the harness asked for. */
const HARNESS_STOP = /^\s*(?:interrupted|cancelled|canceled|aborted)\s*$/i;

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
