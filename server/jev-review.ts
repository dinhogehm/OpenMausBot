// Jev-backed permission review. When the owner opts in
// (`typesafe.permissionReview: true` plus a TypeSafe key), Jev replaces the
// provider-boundary reviewer in auto-review.ts for EVERY engine — including
// the API-key drivers that expose no `reviewPermission` one-shot at all.
//
// This is the one place where an action summary deliberately leaves the
// provider that produced it: the opt-in is the owner's explicit consent to
// send the bot's persona, the tool name, and the summary to TypeSafe. Without
// that flag the boundary rule in auto-review.ts stays in force unchanged.
//
// Jev never writes free text, so there is no JSON contract to parse and no
// prompt-injection surface in the answer: the verdict is a calibrated choice
// plus a risk probability, and the thresholds below are the whole policy.
import {
  AUTO_REVIEW_TIMEOUT_MS,
  MAX_REVIEW_REASON_CHARS,
  type ReviewRequest,
  type ReviewVerdict,
} from "./auto-review.ts";
import type { AppConfig } from "./config.ts";
import {
  evaluateSystemOne,
  typesafeCredentials,
  type ChoiceQuestion,
  type NoulQuestion,
  type TypeSafeCredentials,
} from "./typesafe.ts";

/** Below this the `allow` choice is treated as "Jev is not sure", which is a
 * deny: an auto-approval must be a confident one, a shrug keeps the card. */
export const JEV_REVIEW_MIN_CONFIDENCE = 0.6;
/** With nobody watching, Jev is the only reviewer there is — no human will
 * catch a marginal call later — so an unattended approval demands a
 * stricter confidence and a lower risk ceiling. */
export const JEV_REVIEW_MIN_CONFIDENCE_UNATTENDED = 0.75;
/** The `risky` noul is a second, independent gate so a confident "allow"
 * on the rubric cannot wave through something Jev also flags as risky. */
export const JEV_REVIEW_MAX_RISK = 0.5;
export const JEV_REVIEW_MAX_RISK_UNATTENDED = 0.3;

export interface JevReviewer {
  credentials: TypeSafeCredentials;
  /** The owner also lets Jev answer cards raised while nobody is watching
   * (workflow nodes, webhooks, routines) — the turns auto-approve.ts
   * otherwise fails closed on. A second, separate opt-in on purpose: this is
   * Jev standing in for the absent human, not merely a faster reviewer. */
  unattended: boolean;
  /** The owner also lets Jev judge cards the destructive/sensitive pattern
   * guards in auto-approve.ts would otherwise send straight to a person. The
   * guard's own match travels to Jev as a flagged reason, so a regex hit is
   * evidence in the decision rather than the decision itself. */
  guarded: boolean;
}

/** The Jev reviewer for this workspace, or null when the owner has not opted
 * in or no key is configured — the caller then falls back to the provider. */
export function jevReviewer(cfg: Pick<AppConfig, "typesafe" | "openrouter">): JevReviewer | null {
  if (cfg.typesafe?.permissionReview !== true) return null;
  const credentials = typesafeCredentials(cfg);
  return credentials
    ? { credentials, unattended: cfg.typesafe?.reviewUnattended === true, guarded: cfg.typesafe?.reviewGuarded === true }
    : null;
}

// Same bound as buildReviewPrompt: a giant summary is cut, never rejected.
const MAX_REVIEW_FIELD_CHARS = 2_000;

const VERDICT_QUESTION: ChoiceQuestion = {
  type: "choice",
  instructions: "Should this AI-agent action run without asking its owner?",
  criteria: {
    allow: "Routine, reversible work the owner would obviously allow without pausing",
    deny: "Could expose credentials, move money, communicate externally, delete or overwrite data, change access, control the owner's computer, or is unclear",
  },
};

const RISKY_QUESTION: NoulQuestion = {
  type: "noul",
  instructions: "Could this action be irreversible, external, or touch credentials, money, or access?",
};

export function buildJevReviewQuestions(): { verdict: ChoiceQuestion; risky: NoulQuestion } {
  return { verdict: VERDICT_QUESTION, risky: RISKY_QUESTION };
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** One System One call; the verdict is derived purely from the thresholds.
 * Any failure — key rejected, timeout, malformed answer, a missing question
 * — resolves to null so the human card stays open. Never throws. */
export async function requestJevReview(
  reviewer: JevReviewer,
  request: ReviewRequest,
  options: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    unattended?: boolean;
    /** What a pattern guard matched ("destructive: rm -rf …"), when the card
     * reached Jev only through the `guarded` opt-in. */
    flagged?: string;
  } = {},
): Promise<ReviewVerdict | null> {
  const bounded = (value: string) => value.slice(0, MAX_REVIEW_FIELD_CHARS);
  // An unattended card is only reviewed under the second opt-in; without it
  // the caller's existing fail-closed rules stand and Jev is never asked.
  if (options.unattended && !reviewer.unattended) return null;
  if (options.flagged && !reviewer.guarded) return null;
  const minConfidence = options.unattended ? JEV_REVIEW_MIN_CONFIDENCE_UNATTENDED : JEV_REVIEW_MIN_CONFIDENCE;
  const maxRisk = options.unattended ? JEV_REVIEW_MAX_RISK_UNATTENDED : JEV_REVIEW_MAX_RISK;
  try {
    const response = await evaluateSystemOne({
      credentials: reviewer.credentials,
      // Same shape as the provider prompt's payload so the two reviewers see
      // the same facts; Jev treats state as data, so no "untrusted" preamble.
      state: {
        bot: bounded(request.persona),
        tool: bounded(request.tool),
        action: bounded(request.summary),
        // A pattern guard's hit is evidence for Jev to weigh, not a verdict:
        // the same rubric decides, with the flag in plain sight.
        ...(options.flagged ? { flagged: bounded(options.flagged) } : {}),
      },
      questions: buildJevReviewQuestions(),
      timeoutMs: options.timeoutMs ?? AUTO_REVIEW_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });
    const verdict = response.answers.verdict;
    const risky = response.answers.risky;
    if (verdict?.type !== "choice" || risky?.type !== "noul") return null;

    const choiceProbability = verdict.probabilities[verdict.choice] ?? 0;
    const allow =
      verdict.choice === "allow" &&
      verdict.confidence >= minConfidence &&
      risky.noul < maxRisk;
    // Reads as an audit line in the decisions log: which model, what it
    // leaned towards and how sure it was, and the risk gate's own number.
    const reason = `${response.model}: ${verdict.choice} ${pct(choiceProbability)} (confidence ${pct(verdict.confidence)}), risk ${pct(risky.noul)}${options.unattended ? ", unattended" : ""}`
      .slice(0, MAX_REVIEW_REASON_CHARS);
    return { allow, reason };
  } catch {
    return null;
  }
}
