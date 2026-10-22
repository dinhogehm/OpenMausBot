import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { HandoffView } from "../coordinator.ts";
import type { GroupRecord, Store } from "../store.ts";
import { createRoomJobs } from "./room-jobs.ts";

const node = (patch: Partial<HandoffView>): HandoffView => ({
  id: "n1", parentId: "root", botId: "bot-a", threadId: "room-thread", groupId: "room-1", status: "queued", createdAt: 1,
  ...patch,
} as HandoffView);

describe("room jobs read only live hand-offs", () => {
  it("builds a room's line from coordinator.active(), never from every assignment ever kept", () => {
    const active = vi.fn(() => [
      node({ id: "late", status: "running", createdAt: 2 }),
      node({ id: "early", status: "queued", createdAt: 1, botId: "bot-b" }),
      node({ id: "other-room", groupId: "room-2" }),
    ]);
    const coordinator = { active, all: vi.fn(() => { throw new Error("all() must not be read for a room line"); }) };
    const jobs = createRoomJobs({
      store: {} as Store, coordinator, cfg: { features: { parallelRoomJobs: true } } as AppConfig,
      operations: () => [], speakerOf: () => undefined, laneRoomThread: () => undefined,
    });
    const line = jobs.roomLineOf({ id: "room-1" } as GroupRecord);
    expect(active).toHaveBeenCalledTimes(1);
    expect(coordinator.all).not.toHaveBeenCalled();
    expect(line.map((entry) => entry.assignmentId)).toEqual(expect.arrayContaining(["early", "late"]));
    expect(line.some((entry) => entry.assignmentId === "other-room")).toBe(false);
    expect(jobs.useLanes({ id: "room-1" } as GroupRecord, "room-thread", 1, "work")).toBe(true);
    expect(coordinator.all).not.toHaveBeenCalled();
  });
});
