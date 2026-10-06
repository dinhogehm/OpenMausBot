// What the resolution screen does with an owner_pending item, through the
// server: answer it (a decision, the person's words, or a request for the
// steps), or mark it resolved. The server sends the answer to the bot in the
// item's conversation; the row updates through the bot frame it broadcasts.
import { api, ApiError, type Action } from "@/state/store";
import type { NeedsYouItem } from "@/lib/needs-you";

/** A decision carries the label the person saw with its position: the
 * server refuses it (409) when the bot rewrote the options since. */
export type OwnerPendingReply = { option: number; label: string } | { ask: "steps" } | { ask: "recommend" } | { text: string; resolve: boolean };

/** The decision at `option` as the screen shows it. */
export function decisionReply(item: NeedsYouItem, option: number): OwnerPendingReply {
  return { option, label: item.options?.[option]?.label ?? "" };
}

/** An answer to a question or an approval asked in a conversation: an
 * ordinary message there, awaited — a failed send is an error on the
 * screen and the draft stays (INSP-I r1 #10). */
export async function sendToConversation(item: NeedsYouItem, text: string, dispatch: (action: Action) => void): Promise<void> {
  const sendId = crypto.randomUUID();
  const body = await api(`/api/bots/${encodeURIComponent(item.botId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, threadId: item.threadId, sendId }),
  });
  if (body?.message && typeof body.threadId === "string") dispatch({ type: "messageAdded", threadId: body.threadId, message: body.message });
  if (body?.queued && typeof body.threadId === "string" && typeof body.queueId === "string") {
    dispatch({ type: "pendingQueued", threadId: body.threadId, queueId: body.queueId, text, reason: body.reason === "capacity" || body.reason === "group-turn" ? body.reason : undefined });
  }
}

export async function replyToOwnerPending(item: NeedsYouItem, reply: OwnerPendingReply, dispatch: (action: Action) => void): Promise<{ resolved: number; info?: string }> {
  if (!item.pendingId) throw new Error("not an owner_pending item");
  const receipt = await api(`/api/bots/${encodeURIComponent(item.botId)}/owner-pending/${encodeURIComponent(item.pendingId)}/reply`, {
    method: "POST",
    body: JSON.stringify(reply),
  });
  // the bot is busy there: the words wait their turn, shown queued in the conversation
  if (receipt?.queued && typeof receipt.threadId === "string" && typeof receipt.queueId === "string" && typeof receipt.text === "string") {
    dispatch({ type: "pendingQueued", threadId: receipt.threadId, queueId: receipt.queueId, text: receipt.text, reason: receipt.reason === "capacity" || receipt.reason === "group-turn" ? receipt.reason : undefined });
  }
  // the same answer sent again (the app gave up and the person pressed again): the server
  // took it once, and says so — news for the neutral notice, not a new send (INSP-R12F r6 D2)
  if (receipt?.duplicate === true && typeof receipt.message === "string") return { resolved: 0, info: receipt.message };
  // "Ainda vale" on an item under "Talvez já resolvido": back on top, nothing sent to the bot (INSP-N22 r2 F2)
  if (receipt?.kept === true && typeof receipt.message === "string") return { resolved: 0, info: receipt.message };
  return { resolved: Number(receipt?.resolved ?? 0) };
}

/** "Lembrar <bot>" (INSP-J2 r2 N3): the server reminds the bot, as itself. */
export async function remindOwnerPending(item: NeedsYouItem): Promise<{ deduped: boolean; info?: string }> {
  if (!item.pendingId) return { deduped: false };
  try {
    const receipt = await api(`/api/bots/${encodeURIComponent(item.botId)}/owner-pending/${encodeURIComponent(item.pendingId)}/remind`, { method: "POST" });
    return { deduped: receipt?.deduped === true };
  } catch (error) {
    // "sua resposta ainda está na fila" is news, not a failure: a neutral notice (INSP-J2 r5 B4)
    if (error instanceof ApiError && (error.body as { code?: unknown } | undefined)?.code === "answer_queued") return { deduped: false, info: error.message };
    throw error;
  }
}

/** "Pedir de novo" on a bot's bare question (lot J2): the server asks the
 * bot, as itself, to register it as an item with steps; the row says
 * "Pedindo…" through the bot frame it broadcasts. */
export async function askQuestionSteps(item: NeedsYouItem): Promise<{ deduped: boolean }> {
  const receipt = await api(`/api/bots/${encodeURIComponent(item.botId)}/tasks/${encodeURIComponent(item.threadId)}/ask-steps`, { method: "POST" });
  return { deduped: receipt?.deduped === true };
}

/** "Delegar a um agente" (lote del): the server opens a Claude Code session
 * for the item; the row turns "delegado" through the bot frame it
 * broadcasts. A second click is told so, never a second session. */
export async function delegateOwnerPending(item: NeedsYouItem): Promise<{ info?: string; sessionId?: string; queued?: boolean }> {
  if (!item.pendingId) throw new Error("not an owner_pending item");
  const receipt = await api(`/api/bots/${encodeURIComponent(item.botId)}/owner-pending/${encodeURIComponent(item.pendingId)}/delegate`, { method: "POST", body: "{}" });
  if (receipt?.duplicate === true && typeof receipt.message === "string") return { info: receipt.message };
  return { ...(typeof receipt?.sessionId === "string" ? { sessionId: receipt.sessionId } : {}), ...(typeof receipt?.queueId === "string" ? { queued: true } : {}) };
}

export async function resolveOwnerPending(item: NeedsYouItem): Promise<void> {
  if (!item.pendingId) return;
  await api(`/api/bots/${encodeURIComponent(item.botId)}/owner-pending/${encodeURIComponent(item.pendingId)}/resolve`, { method: "POST" });
}
