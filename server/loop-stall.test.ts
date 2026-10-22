import { afterEach, describe, expect, it } from "vitest";
import { currentLoopLabel, resetLoopStallState, runLabeled, slowSectionsBetween, startLoopStallWatch, topSelfTime } from "./loop-stall.ts";

const spin = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* hold the thread */ } };

describe("loop-stall", () => {
  afterEach(() => resetLoopStallState());

  it("names the running handler and remembers slow sections only", () => {
    const from = performance.now();
    runLabeled("GET /api/threads/:id", () => {
      expect(currentLoopLabel()).toBe("GET /api/threads/:id");
      runLabeled("bus turn.completed → index.ts:6266", () => spin(300));
      expect(currentLoopLabel()).toBe("GET /api/threads/:id");
    });
    runLabeled("fast", () => undefined);
    expect(currentLoopLabel()).toBeNull();
    const slow = slowSectionsBetween(from, performance.now() + 1).map((s) => s.label);
    expect(slow).toEqual(["GET /api/threads/:id", "bus turn.completed → index.ts:6266"]);
  });

  it("restores the label when a handler throws", () => {
    expect(() => runLabeled("boom", () => { throw new Error("x"); })).toThrow("x");
    expect(currentLoopLabel()).toBeNull();
  });

  it("logs a block over the threshold with the handler that held the thread", async () => {
    const lines: string[] = [];
    const watch = startLoopStallWatch({ thresholdMs: 200, tickMs: 20, log: (l) => lines.push(l) });
    await new Promise((r) => setTimeout(r, 50));
    runLabeled("store message", () => spin(400));
    await new Promise((r) => setTimeout(r, 80));
    watch.stop();
    expect(watch.stalls()).toBeGreaterThanOrEqual(1);
    expect(lines.find((l) => l.startsWith("[loop-stall] main thread blocked"))).toContain("store message");
  });

  it("ranks self time from a V8 profile", () => {
    const top = topSelfTime({
      startTime: 0, endTime: 30,
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 } },
        { id: 2, callFrame: { functionName: "readThread", url: "file:///x/message-db.js", lineNumber: 9 } },
        { id: 3, callFrame: { functionName: "(idle)", url: "", lineNumber: -1 } },
      ],
      samples: [2, 2, 3, 2],
      timeDeltas: [0, 1000, 1000, 1000],
    });
    expect(top[0]).toEqual({ fn: "readThread (message-db.js:10)", ms: 2 });
  });
});
