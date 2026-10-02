// What the resolution screen does with an owner_pending item, through the
// server: answer it (a decision, the person's words, or a request for the
// steps), or mark it resolved. The server sends the answer to the bot in the
// item's conversation; the row updates through the bot frame it broadcasts.
import { api, type Action } from "@/state/store";
import type { NeedsYouItem } from "@/lib/needs-you";

export type OwnerPendingReply = { option: number } | { ask: "steps" } | { text: string; resolve: boolean };

export async function replyToOwnerPending(item: NeedsYouItem, reply: OwnerPendingReply, dispatch: (action: Action) => void): Promise<{ resolved: number }> {
  if (!item.pendingId) throw new Error("not an owner_pending item");
  const receipt = await api(`/api/bots/${encodeURIComponent(item.botId)}/owner-pending/${encodeURIComponent(item.pendingId)}/reply`, {
    method: "POST",
    body: JSON.stringify(reply),
  });
  // the bot is busy there: the words wait their turn, shown queued in the conversation
  if (receipt?.queued && typeof receipt.threadId === "string" && typeof receipt.queueId === "string" && typeof receipt.text === "string") {
    dispatch({ type: "pendingQueued", threadId: receipt.threadId, queueId: receipt.queueId, text: receipt.text, reason: receipt.reason === "capacity" || receipt.reason === "group-turn" ? receipt.reason : undefined });
  }
  return { resolved: Number(receipt?.resolved ?? 0) };
}

export async function resolveOwnerPending(item: NeedsYouItem): Promise<void> {
  if (!item.pendingId) return;
  await api(`/api/bots/${encodeURIComponent(item.botId)}/owner-pending/${encodeURIComponent(item.pendingId)}/resolve`, { method: "POST" });
}
