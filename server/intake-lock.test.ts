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

  it("says who waited behind whom, and for how long, when the waiter runs", () => {
    let now = 1_000;
    const busy = new Set<string>(["vigia-chat"]);
    const lock = new IntakeLock((_botId, threadId) => busy.has(threadId), () => now);
    lock.note("monitor", "vigia-chat");
    // the issues watch is held, twice: the first wait counts
    lock.noteWait("monitor", "vigia-issues");
    now += 20_000;
    lock.noteWait("monitor", "vigia-issues");
    lock.noteWait("monitor", "routine");
    expect(lock.holder("monitor")).toBe("vigia-chat");
    busy.delete("vigia-chat");
    lock.settle("vigia-chat");
    now += 19_000;
    expect(lock.note("monitor", "vigia-issues")).toEqual({ behind: "vigia-chat", ms: 39_000 });
    // asked again, it is gone; the routine runs in its results thread, under its own name
    expect(lock.note("monitor", "vigia-issues")).toBeNull();
    expect(lock.note("monitor", "results-1", "routine")).toEqual({ behind: "vigia-chat", ms: 19_000 });
    // a turn that never waited says nothing
    expect(lock.note("chief", "c1")).toBeNull();
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
