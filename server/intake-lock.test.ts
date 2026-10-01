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

  it("makes a teammate's message to a watcher bot wait for its intake turn, and hold the lock while it runs", () => {
    const busy = new Set<string>();
    const lock = new IntakeLock((_botId, threadId) => busy.has(threadId));
    // the tag watch fires first: the Chief's "pode avisar" waits
    lock.note("monitor", "vigia-tag");
    busy.add("vigia-tag");
    expect(lock.admitPeer("monitor", "fio-chief", "chief", true)).toBe(false);
    // a bot without standing watches, or a thread the bot opened on itself, never waits
    expect(lock.admitPeer("monitor", "fio-chief", "chief", false)).toBe(true);
    expect(lock.admitPeer("monitor", "fio-proprio", "monitor", true)).toBe(true);
    // the other way round: the Chief's message runs first, the watch waits
    busy.delete("vigia-tag");
    lock.settle("vigia-tag");
    expect(lock.admitPeer("monitor", "fio-chief", "chief", true)).toBe(true);
    busy.add("fio-chief");
    expect(lock.busyElsewhere("monitor", "vigia-tag")).toBe(true);
    lock.settle("fio-chief");
    busy.delete("fio-chief");
    expect(lock.busyElsewhere("monitor", "vigia-tag")).toBe(false);
  });
});
