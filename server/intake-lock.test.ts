import { describe, expect, it } from "vitest";
import { IntakeLock } from "./intake-lock.ts";

describe("one intake turn per bot", () => {
  it("holds a bot's second intake turn in another conversation while the first runs", () => {
    const busy = new Set<string>();
    const lock = new IntakeLock((_botId, threadId) => busy.has(threadId));
    lock.note("monitor", "vigia-chat");
    busy.add("vigia-chat");
    expect(lock.busyElsewhere("monitor", "rotina")).toBe(true);
    expect(lock.busyElsewhere("monitor")).toBe(true);
    expect(lock.busyElsewhere("monitor", "vigia-chat")).toBe(false);
    expect(lock.busyElsewhere("chief", "x")).toBe(false);
    // the first ended without an event: seen idle, the lock lets go
    busy.delete("vigia-chat");
    expect(lock.busyElsewhere("monitor", "rotina")).toBe(false);
    lock.note("monitor", "rotina");
    busy.add("rotina");
    lock.settle("rotina");
    expect(lock.busyElsewhere("monitor", "vigia-chat")).toBe(false);
  });
});
