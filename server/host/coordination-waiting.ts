import type { HandoffView } from "../coordinator.ts";

type CoordinationNode = Pick<HandoffView, "id" | "parentId" | "groupId" | "threadId" | "reply" | "status" | "question" | "cards">;

export function createCoordinationWaitingSnapshot(read: () => readonly CoordinationNode[]): (threadId: string) => boolean {
  const nodes = read();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const waiting = new Set<string>();
  for (const node of nodes) {
    if (node.parentId && node.reply !== "none") {
      const parent = byId.get(node.parentId);
      if (parent && parent.groupId === undefined) waiting.add(parent.threadId);
    }
    if (!node.parentId && !node.groupId &&
      (node.status === "resume" || (node.status === "waiting" && node.question === undefined && !node.cards?.length))) {
      waiting.add(node.threadId);
    }
  }
  return (threadId) => waiting.has(threadId);
}
