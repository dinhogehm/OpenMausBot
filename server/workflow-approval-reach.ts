// An approval gate a person can answer without opening the canvas.
//
// The evidence: three runs of the live pipeline reached `aprovacao-merge`;
// two were cancelled by hand, the third waited 24 hours, expired as
// `rejected` and threw away a finished PR. The card existed only on the
// canvas. This module puts the SAME decision into the places a person
// already looks — the bot's 1:1 chat, optionally a room — as an ordinary
// option card with a `requestId`, so the existing respond routes (desktop
// composer, the companion app's card, a room) settle it through the one
// engine call the canvas uses. No second notification system: the card is
// a harness-owned durable card like a routine proposal, and the buzz is the
// same `notify` frame every approval card sends.
//
// Pure: every store touch is injected, so the cases (post, refresh,
// settle from elsewhere, a second click, a run that moved on, a restart)
// are unit-tested without the app store.
import {
  WORKFLOW_APPROVAL_CARD_OPTIONS,
  WORKFLOW_APPROVAL_CARD_TOOL,
  workflowApprovalRequestId,
  type WorkflowApprovalCardData,
  type WorkflowRun,
} from "../shared/workflow.ts";
import type { ApprovalDecision, WorkflowApprovalAnnouncement } from "./workflow-run.ts";

/** The slice of an option card this module reads and writes. */
export interface ApprovalCardLike {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  workflowApproval?: WorkflowApprovalCardData;
}

export interface ApprovalCardMessage {
  id: string;
  card?: ApprovalCardLike;
}

/** What the harness lends this module: message access on a thread, the
 * bot and room lookups, and the "something new is waiting here" marks. */
export interface WorkflowApprovalReachStore {
  messagesFor(threadId: string): ApprovalCardMessage[];
  appendMessage(
    threadId: string,
    message: {
      role: "bot";
      kind: "options" | "text";
      text?: string;
      card?: ApprovalCardLike;
      from?: { botId: string; name: string; color: string };
    },
  ): { id: string };
  patchMessage(threadId: string, messageId: string, patch: { card: ApprovalCardLike }): unknown;
  /** The bot's own chat thread, or null for a bot that no longer exists. */
  botThread(botId: string): string | null;
  /** A room's thread, or null for a room that no longer exists. */
  groupThread(groupId: string): string | null;
  markBotUnread(botId: string): void;
  markGroupUnread(groupId: string): void;
}

export interface WorkflowApprovalReachDeps {
  store: WorkflowApprovalReachStore;
  /** The bot whose chat carries the card (workflowApprovalBotId in
   * index.ts); undefined when no bot of the workflow exists any more. */
  botFor: (announcement: WorkflowApprovalAnnouncement) => string | undefined;
  /** Author of a room copy of the card — the workflow itself, exactly as a
   * notify node's post is signed. */
  roomAuthor: { botId: string; name: string; color: string };
}

/** One wording for what the card asks, in the chat and in the room. */
export function approvalCardTitle(announcement: Pick<WorkflowApprovalAnnouncement, "workflow" | "node">): string {
  return `Workflow "${announcement.workflow.name}" needs your decision at "${announcement.node.id}"`;
}

/** The card's body: the node's prompt, then what the previous step found
 * — the reviewer's summary is what the person is actually deciding on. */
export function approvalCardSubtitle(announcement: Pick<WorkflowApprovalAnnouncement, "node" | "summary" | "run">): string {
  const lines = [announcement.node.prompt.trim() || "(the approval node has no prompt)"];
  if (announcement.summary.trim()) lines.push("", `Previous step: ${announcement.summary.trim()}`);
  lines.push("", `Run ${announcement.run.id} · started ${new Date(announcement.run.startedAt).toISOString()}`);
  return lines.join("\n");
}

/** The note under the card: how long the gate has been open and how many
 * times it has asked again. Rewritten on every reach, so the card in the
 * transcript always says where the gate stands. */
export function approvalCardHeld(announcement: Pick<WorkflowApprovalAnnouncement, "kind" | "round" | "maxRounds" | "run" | "node">): string | undefined {
  const { run, node } = announcement;
  const since = run.approvalRequestedAt === undefined ? "" : ` since ${new Date(run.approvalRequestedAt).toISOString()}`;
  const policy =
    (node.onExpire ?? "rejected") === "renotify"
      ? `; if nobody answers, the workflow asks again up to ${announcement.maxRounds} times and then rejects`
      : `; if nobody answers, the workflow takes "${node.onExpire ?? "rejected"}" when the window runs out`;
  if (announcement.kind === "renotify") {
    return `Asked again (${announcement.round} of ${announcement.maxRounds}) — waiting for a decision${since}${policy}.`;
  }
  if (announcement.kind === "reminder") return `Reminder — waiting for a decision${since}${policy}.`;
  return `Waiting for a decision${since}${policy}.`;
}

/** The one-line nudge posted under an existing card on a reminder or a
 * re-notification, so the chat's newest message says why it buzzed. */
export function approvalNudgeText(announcement: Pick<WorkflowApprovalAnnouncement, "kind" | "round" | "maxRounds" | "node" | "workflow">): string {
  const what = `"${announcement.workflow.name}" is still waiting for your decision at "${announcement.node.id}"`;
  return announcement.kind === "renotify"
    ? `${what} — asked again (${announcement.round} of ${announcement.maxRounds}). The card above is still open.`
    : `Reminder: ${what}. The card above is still open.`;
}

function findCard(store: WorkflowApprovalReachStore, threadId: string, requestId: string): ApprovalCardMessage | undefined {
  return store.messagesFor(threadId).find((message) => message.card?.requestId === requestId && message.card.workflowApproval);
}

/** Post the gate's card into one thread, or refresh the one already there.
 * Idempotent on `requestId`: a second call for the same gate opening never
 * adds a second card, and a card already answered is left alone. Returns
 * whether the thread carries an open card afterwards. */
function upsertCard(
  store: WorkflowApprovalReachStore,
  threadId: string,
  announcement: WorkflowApprovalAnnouncement,
  from: { botId: string; name: string; color: string } | undefined,
): boolean {
  const requestId = workflowApprovalRequestId(announcement.run);
  const card: ApprovalCardLike = {
    title: approvalCardTitle(announcement),
    subtitle: approvalCardSubtitle(announcement),
    options: [...WORKFLOW_APPROVAL_CARD_OPTIONS],
    requestId,
    tool: WORKFLOW_APPROVAL_CARD_TOOL,
    held: approvalCardHeld(announcement),
    workflowApproval: {
      runId: announcement.run.id,
      workflowId: announcement.workflow.id,
      nodeId: announcement.node.id,
    },
  };
  const existing = findCard(store, threadId, requestId);
  if (!existing?.card) {
    store.appendMessage(threadId, { role: "bot", kind: "options", card, ...(from ? { from } : {}) });
    return true;
  }
  if (existing.card.answered || existing.card.dismissed) return false;
  store.patchMessage(threadId, existing.id, { card: { ...existing.card, held: card.held, subtitle: card.subtitle } });
  if (announcement.kind !== "approval") {
    store.appendMessage(threadId, { role: "bot", kind: "text", text: approvalNudgeText(announcement), ...(from ? { from } : {}) });
  }
  return true;
}

/** The engine's `approvalReach` over a harness store. */
export function createWorkflowApprovalReach(deps: WorkflowApprovalReachDeps): {
  announce: (announcement: WorkflowApprovalAnnouncement) => string[];
  settle: (run: WorkflowRun, threadIds: string[], outcome: ApprovalDecision | "unavailable") => void;
} {
  const { store } = deps;
  return {
    announce(announcement) {
      const threads: string[] = [];
      const botId = deps.botFor(announcement);
      const botThread = botId === undefined ? null : store.botThread(botId);
      if (botId !== undefined && botThread !== null) {
        if (upsertCard(store, botThread, announcement, undefined)) {
          store.markBotUnread(botId);
          threads.push(botThread);
        }
      } else {
        console.warn(`workflow: no bot chat to post the approval card of run ${announcement.run.id} into`);
      }
      const groupId = announcement.node.notifyTargetGroupId;
      if (groupId !== undefined) {
        const groupThread = store.groupThread(groupId);
        if (groupThread === null) {
          // Not a failure of the gate: the chat copy (and the canvas) still
          // carry the decision. The room is the extra reach, not the only one.
          console.warn(`workflow: room "${groupId}" for the approval card of run ${announcement.run.id} no longer exists`);
        } else if (upsertCard(store, groupThread, announcement, deps.roomAuthor)) {
          store.markGroupUnread(groupId);
          threads.push(groupThread);
        }
      }
      return threads;
    },
    settle(run, threadIds, outcome) {
      const requestId = workflowApprovalRequestId(run);
      for (const threadId of threadIds) {
        const existing = findCard(store, threadId, requestId);
        if (!existing?.card || existing.card.answered) continue;
        store.patchMessage(threadId, existing.id, { card: settledCard(existing.card, outcome) });
      }
    },
  };
}

/** The answered marks the clients already render: `allow` / `deny` draw
 * the check and the cross, `unavailable` + dismissed is how every other
 * card that can no longer be answered is closed (closeOpenApprovals). */
function settledCard(card: ApprovalCardLike, outcome: ApprovalDecision | "unavailable"): ApprovalCardLike {
  if (outcome === "unavailable") return { ...card, answered: "unavailable", dismissed: true };
  return { ...card, answered: outcome === "approved" ? "allow" : "deny", dismissed: true };
}

export type ResolveWorkflowApprovalResult =
  /** Not a gate card: the caller carries on with its other kinds. */
  | { claimed: false }
  /** Settled now, through the engine — every other copy is marked by the
   * engine's settle hook. */
  | { claimed: true; status: 200; body: { ok: true; outcome: "allowed-once" | "rejected"; decision: ApprovalDecision } }
  /** Already decided — here, elsewhere, or by expiry. The second click is
   * a no-op that answers what happened, never an error. */
  | { claimed: true; status: 200; body: { ok: true; outcome: "allowed-once" | "rejected" | "unavailable"; alreadyAnswered: true } }
  /** Nothing to decide any more (the run moved on, was cancelled, or is
   * gone); the card is closed so it stops asking. */
  | { claimed: true; status: 409; body: { error: string } }
  | { claimed: true; status: 400; body: { error: string } };

export interface ResolveWorkflowApprovalDeps {
  store: WorkflowApprovalReachStore;
  /** The engine's own decision path — `resolveApproval` — which throws its
   * documented messages for a run that is not waiting. */
  resolve: (runId: string, decision: ApprovalDecision) => WorkflowRun;
  /** The run as the store has it now, or null. */
  run: (runId: string) => WorkflowRun | null;
}

/** A click on the gate's card, from any thread that carries one. Claims
 * only cards with a `workflowApproval` payload; the decision goes through
 * the same engine call the canvas uses, so the receipt is identical. The
 * card in THIS thread is marked here as well as by the engine's settle
 * hook, so a card whose thread the run never recorded (a hand-edited
 * receipt) still closes. */
export function resolveWorkflowApprovalCard(
  deps: ResolveWorkflowApprovalDeps,
  args: { threadId: string; requestId: string; behavior: string },
): ResolveWorkflowApprovalResult {
  const existing = findCard(deps.store, args.threadId, args.requestId);
  const card = existing?.card;
  const payload = card?.workflowApproval;
  if (!existing || !card || !payload) return { claimed: false };
  if (card.answered) {
    const outcome = card.answered === "allow" ? "allowed-once" : card.answered === "deny" ? "rejected" : "unavailable";
    return { claimed: true, status: 200, body: { ok: true, outcome, alreadyAnswered: true } };
  }
  if (args.behavior !== "allow" && args.behavior !== "deny") {
    return { claimed: true, status: 400, body: { error: "a workflow approval is answered with allow or deny" } };
  }
  const decision: ApprovalDecision = args.behavior === "allow" ? "approved" : "rejected";
  const current = deps.run(payload.runId);
  // The card is for one OPENING of the gate (its request id carries the
  // instant); a run that has since moved on, re-entered the same node, or
  // ended has nothing this card can decide.
  if (
    !current ||
    current.status !== "waiting-approval" ||
    current.currentNodeId !== payload.nodeId ||
    workflowApprovalRequestId(current) !== args.requestId
  ) {
    deps.store.patchMessage(args.threadId, existing.id, { card: settledCard(card, "unavailable") });
    return {
      claimed: true,
      status: 409,
      body: { error: !current ? "this workflow run no longer exists" : "this workflow run is no longer waiting for this decision" },
    };
  }
  try {
    deps.resolve(payload.runId, decision);
  } catch (error) {
    // The engine's own refusal (a race with the canvas or an expiry in the
    // same instant): close the card and say so.
    deps.store.patchMessage(args.threadId, existing.id, { card: settledCard(card, "unavailable") });
    return { claimed: true, status: 409, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  // The engine's settle hook has marked every recorded copy; this thread
  // may not be among them (see above), so mark it here regardless.
  const after = findCard(deps.store, args.threadId, args.requestId);
  if (after?.card && !after.card.answered) {
    deps.store.patchMessage(args.threadId, after.id, { card: settledCard(after.card, decision) });
  }
  return {
    claimed: true,
    status: 200,
    body: { ok: true, outcome: decision === "approved" ? "allowed-once" : "rejected", decision },
  };
}
