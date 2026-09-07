// What a dispatch was told about the turn it starts — the one place the
// harness decides whether a turn runs with nobody at the keyboard.
//
// Three readers used to answer that question for themselves: the computer
// mount (does Auto get the desktop?), the approval mode handed to the
// provider (does Auto downgrade to Ask?), and the permission fold (does a
// named grant fire, does the card wait for a person?). Each read the per-bot
// unattended mark — a mutable flag every dispatch rewrites, a person's
// message clears and an idle half hour ages out — and one of them had grown
// its own notion of "automated" that treated a routine's turn as
// unattended. So the answer is computed ONCE here, from the dispatch's own
// opts, and every reader takes the same field.

/** Where a turn came from, as startTurn is told it. Routine triggers plus
 * the workflow engine's own source; undefined is a person typing. */
export type TurnAutomationSource = "schedule" | "manual" | "webhook" | "workflow";

export interface TurnProvenance {
  automationSource?: TurnAutomationSource;
  /** Nobody at the keyboard: a webhook, a workflow node, or a hop inherited
   * from a bot already running unattended. A routine — scheduled or Run
   * now — stays attended: its prompt is the person's own text, which is
   * the decision Auto mode was switched on for (approvalModeForOrigin says
   * why, and upstream restricted the mark to webhooks deliberately). */
  unattended: boolean;
  /** Grants a workflow node pre-approves for this turn, if any. */
  alwaysAllow?: string[];
}

/** The opts startTurn receives that bear on provenance. */
export interface TurnProvenanceOpts {
  automationSource?: TurnAutomationSource;
  unattended?: boolean;
  cardContinuation?: boolean;
  alwaysAllow?: string[];
}

const UNATTENDED_SOURCES = new Set<TurnAutomationSource>(["webhook", "workflow"]);

/** The record for a dispatch. A card continuation resumes the turn a
 * previous dispatch began — a connector or credential card answered on a
 * workflow node's thread resumes a workflow turn, not a person's — so it
 * keeps that dispatch's record when there is one; a continuation with no
 * record to inherit (the thread was dispatched by a process that died) is
 * judged by its own opts, which fail closed to whatever they carry. */
export function turnProvenanceFor(
  opts: TurnProvenanceOpts | undefined,
  inherited: TurnProvenance | undefined,
): TurnProvenance {
  if (opts?.cardContinuation && inherited) return inherited;
  const source = opts?.automationSource;
  return {
    ...(source === undefined ? {} : { automationSource: source }),
    unattended: (source !== undefined && UNATTENDED_SOURCES.has(source)) || opts?.unattended === true,
    ...(opts?.alwaysAllow?.length ? { alwaysAllow: [...opts.alwaysAllow] } : {}),
  };
}

/** What every reader asks: unattended by the thread's own record OR by the
 * bot's mark. Never narrower than the mark alone, so nothing that asked a
 * human before asks a bot now; a stale mark only ever adds caution. */
export function unattendedByEither(record: TurnProvenance | undefined, botMarkedUnattended: boolean): boolean {
  return record?.unattended === true || botMarkedUnattended;
}
