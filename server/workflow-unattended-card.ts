// The one decision a workflow node's permission card gets: nobody is at the
// keyboard, so a request the automatic policy could not answer is denied by
// the harness — now, or after a short grace — instead of parked on a human
// until the node's timeout runs out three times over.
//
// Pure of index.ts: every side effect (the card in the transcript, the answer
// to the provider, the audit row, the engine's receipt, the buzz) is a
// dependency the caller binds to its thread and request, so the four ways
// this can go — delivered, undeliverable, a person answering inside the
// grace, the grace expiring — are testable without a provider.
import { unattendedDenial, type AutoVerdict } from "./auto-approve.ts";
import type { RequestOutcome } from "./contracts.ts";
import type { OptionCardData } from "./store.ts";

export interface UnattendedCardRequest {
  requestId: string;
  tool: string;
  summary: string;
  scope?: "local-computer";
  verdict: Pick<AutoVerdict, "source" | "rule">;
}

export interface UnattendedCardDeps {
  /** How long a person gets before the harness answers; 0 denies at once. */
  graceMs: number;
  /** Append the card to the node's transcript; returns its message id. */
  pushCard: (card: OptionCardData) => string;
  /** The card as it is NOW — a person may have answered it meanwhile. */
  readCard: (messageId: string) => OptionCardData | undefined;
  patchCard: (messageId: string, card: OptionCardData) => void;
  /** Answer the provider's open ask with "deny" and this note; `unavailable`
   * (or a throw) means nothing took the answer. */
  respond: (message: string) => Promise<RequestOutcome>;
  /** The audit row, written only once the outcome is known. */
  appendDecision: (row: { decision: "auto-denied" | "card-shown"; source: AutoVerdict["source"] | "auto-fallback" }) => void;
  /** Tell the engine what the node was refused — only for a denial that
   * was actually delivered, so the receipt never names a refusal nothing
   * received. */
  noteDenial: (line: string) => void;
  /** The card is genuinely waiting on a person (a grace, or a denial that
   * could not be delivered): mark the bot waiting and buzz, as an ordinary
   * card does. */
  notifyHuman: () => void;
  /** Injectable clock for the grace. */
  schedule: (fn: () => void, ms: number) => void;
}

export type UnattendedCardOutcome = "denied" | "answered-by-person" | "undelivered";

export interface UnattendedCardResult {
  messageId: string;
  /** The one line on the card, in the log and on the receipt. */
  denial: string;
  /** Resolves when the harness is done with the card. */
  settled: Promise<UnattendedCardOutcome>;
}

/** Card first, answer second. The card is the transcript's record of the
 * refusal; the answer is what the provider receives. Only a delivered answer
 * reaches the engine and the audit log as a denial — an undeliverable one
 * leaves the card open, says so on it, and hands it to a person, so the
 * node's timeout is the backstop it always was. */
export function denyUnattendedWorkflowCard(
  request: UnattendedCardRequest,
  deps: UnattendedCardDeps,
): UnattendedCardResult {
  const denial = unattendedDenial(request.tool, request.summary, request.verdict, request.scope);
  const grace = deps.graceMs > 0 ? deps.graceMs : 0;
  const messageId = deps.pushCard({
    // Only an instant denial is titled as one: with a grace the person may
    // still be the one who answers.
    title: grace > 0 ? "Approval needed" : "Denied unattended",
    subtitle: request.summary,
    options: ["Allow", "Deny"],
    requestId: request.requestId,
    tool: request.tool,
    // free text, no catalog key: the line names this request's own tool
    // and grant, which no fixed note could
    held: denial,
    ...(request.scope === undefined ? {} : { approvalScope: request.scope }),
  });

  const deny = async (): Promise<UnattendedCardOutcome> => {
    const open = deps.readCard(messageId);
    // a person got there within the grace, or the card is gone
    if (!open || open.answered) return "answered-by-person";
    try {
      const outcome = await deps.respond(denial);
      if (outcome === "unavailable") throw new Error("the ask is no longer open");
    } catch {
      // Re-read before patching: the person may have clicked while the
      // answer was in flight, and their click must not be overwritten.
      const current = deps.readCard(messageId);
      if (current && !current.answered) {
        deps.patchCard(messageId, {
          ...current,
          held: `${denial} — the denial could not be delivered, so this card is waiting on you`,
        });
      }
      deps.appendDecision({ decision: "card-shown", source: "auto-fallback" });
      deps.notifyHuman();
      return "undelivered";
    }
    // The driver's request.resolved marks the card answered; the receipt
    // and the audit row are written only once the provider took the answer.
    deps.noteDenial(denial);
    deps.appendDecision({ decision: "auto-denied", source: request.verdict.source });
    return "denied";
  };

  let settled: Promise<UnattendedCardOutcome>;
  if (grace > 0) {
    // A grace is for a person who watches their runs: tell them, and give
    // them the window before the harness answers.
    deps.notifyHuman();
    settled = new Promise<UnattendedCardOutcome>((resolve) => {
      deps.schedule(() => void deny().then(resolve), grace);
    });
  } else {
    settled = deny();
  }
  return { messageId, denial, settled };
}
