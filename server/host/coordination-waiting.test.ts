import { describe, expect, it, vi } from "vitest";
import type { HandoffView } from "../coordinator.ts";
import { createCoordinationWaitingSnapshot } from "./coordination-waiting.ts";

type Node = Pick<HandoffView, "id" | "parentId" | "groupId" | "threadId" | "reply" | "status" | "question" | "cards">;
const node = (id: string, patch: Partial<Node> = {}): Node => ({ id, threadId: `${id}-thread`, reply: "resume", status: "running", ...patch });

describe("coordination waiting snapshot", () => {
  it("reads thirteen live assignments once while projecting a thousand historical threads", () => {
    const rows = Array.from({ length: 13 }, (_, i) => node(`root-${i}`, { status: "waiting" }));
    const read = vi.fn(() => rows);
    const waiting = createCoordinationWaitingSnapshot(read);

    for (let i = 0; i < 1_000; i++) expect(waiting(`root-${i}-thread`)).toBe(i < 13);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps direct roots, child replies, room ownership and questions distinct", () => {
    const rows = [
      node("running"), node("queued", { status: "queued" }), node("source", { status: "source" }),
      node("resume", { status: "resume" }), node("waiting", { status: "waiting" }),
      node("question", { status: "waiting", question: "Approve?" }),
      node("empty-question", { status: "waiting", question: "" }),
      node("cards", { status: "waiting", cards: ["approval"] }),
      node("empty-cards", { status: "waiting", cards: [] }),
      node("room-root", { status: "waiting", groupId: "room" }),
      node("parent"), node("child", { parentId: "parent", reply: "poll" }),
      node("room-child-parent"), node("room-child", { parentId: "room-child-parent", groupId: "room" }),
      node("child-of-room", { parentId: "room-root" }),
      node("notify-parent"), node("notify", { parentId: "notify-parent", reply: "none" }),
      node("orphan", { parentId: "missing" }),
      node("nested-parent", { parentId: "parent" }), node("nested-child", { parentId: "nested-parent" }),
    ];
    const waiting = createCoordinationWaitingSnapshot(() => rows);
    expect(rows.filter((row) => waiting(row.threadId)).map((row) => row.id)).toEqual([
      "resume", "waiting", "empty-cards", "parent", "room-child-parent", "nested-parent",
    ]);
  });

  it("takes fresh state for the next projection without mutating an earlier snapshot", () => {
    const current = node("root", { status: "waiting" });
    const read = vi.fn(() => [current]);
    const before = createCoordinationWaitingSnapshot(read);
    current.status = "running";
    const after = createCoordinationWaitingSnapshot(read);

    expect(before(current.threadId)).toBe(true);
    expect(after(current.threadId)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
