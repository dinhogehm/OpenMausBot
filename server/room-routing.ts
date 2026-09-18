// Smart room routing. A room whose default responder is `smart` has no fixed
// lead: an untagged message is shown to Jev with the roster's personas and
// the member it picks answers. Explicit @mentions never reach this file —
// roomResponders in store.ts resolves them first — so Jev only ever breaks
// the tie the person left open.
import {
  evaluateSystemOne,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type TypeSafeCredentials,
} from "./typesafe.ts";

/** A choice over N members spreads probability thinner than a yes/no: with
 * four plausible teammates a clear favourite may only reach 40%, so the bar
 * sits well below the binary review gate (jev-review.ts). Under it the
 * caller keeps its lead fallback rather than acting on a coin flip. */
export const JEV_ROUTING_MIN_CONFIDENCE = 0.35;
/** Routing sits between the person pressing Send and the first reply, so it
 * gets a tighter budget than a permission review. */
export const ROUTING_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_DESCRIPTION_CHARS = 300;

export interface RoutableMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
}

export interface SmartRoute<T extends RoutableMember> {
  member: T;
  confidence: number;
  probabilities: ChoiceAnswer["probabilities"];
}

/** Build the question: one option per member, rubric = who they are. The
 * option key is the member id so the answer maps back without name lookups. */
export function buildRoutingQuestion(members: RoutableMember[]): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const member of members) {
    criteria[member.id] = `${member.name}${member.title ? ` — ${member.title}` : ""}${
      member.description ? `: ${member.description.slice(0, MAX_DESCRIPTION_CHARS)}` : ""
    }`;
  }
  return { type: "choice", instructions: "Which team member should answer this message?", criteria };
}

/** Pick the member best placed to answer `text`. A single member is returned
 * directly without a request. Null means "no confident pick" — an error, a
 * timeout, an answer naming nobody in the roster, or confidence under the
 * bar — and the caller decides who answers instead. Never throws. */
export async function pickSmartResponder<T extends RoutableMember>(
  text: string,
  members: T[],
  credentials: TypeSafeCredentials,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SmartRoute<T> | null> {
  if (members.length === 0) return null;
  if (members.length === 1) return { member: members[0]!, confidence: 1, probabilities: { [members[0]!.id]: 1 } };
  try {
    const response = await evaluateSystemOne({
      credentials,
      state: { message: text.slice(0, MAX_MESSAGE_CHARS) },
      questions: { responder: buildRoutingQuestion(members) },
      timeoutMs: options.timeoutMs ?? ROUTING_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });
    const answer = response.answers.responder;
    if (answer?.type !== "choice") return null;
    const member = members.find((candidate) => candidate.id === answer.choice);
    if (!member || answer.confidence < JEV_ROUTING_MIN_CONFIDENCE) return null;
    return { member, confidence: answer.confidence, probabilities: answer.probabilities };
  } catch {
    return null;
  }
}
