import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CcStartQueue, priorityLabel, START_QUEUE_MAX, startPriority, type QueuedStart } from "./cc-start-queue.ts";

const item = (id: string, title: string, at: number, botId = "chief"): QueuedStart =>
  ({ id, botId, threadId: "t", body: { title }, title, priority: startPriority(title), at });

describe("the queue of session starts", () => {
  it("ranks P1/hotfix first, then a client's Reprovado, then arrival", () => {
    expect(startPriority("#9331 hotfix 503 no inbox")).toBe(0);
    expect(startPriority("P1: #9326 PREVIOUS_COMMIT vazio")).toBe(0);
    expect(startPriority("#9295 Reprovado pela Daiane")).toBe(1);
    expect(startPriority("#9052 limpeza")).toBe(2);
    expect(priorityLabel(0)).toBe("P1");
  });

  it("opens the most urgent first, keeps order within a priority, and survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-startq-"));
    try {
      const path = join(dir, "cc-start-queue.json");
      const queue = new CcStartQueue(path);
      expect(queue.add(item("a", "#9052 limpeza", 1))).toBe(1);
      expect(queue.add(item("b", "#9295 Reprovado", 2))).toBe(1);
      expect(queue.add(item("c", "#9331 hotfix", 3))).toBe(1);
      expect(queue.add(item("d", "#9060 outra", 4, "lead"))).toBe(4);
      expect(new CcStartQueue(path).ordered().map((each) => each.id)).toEqual(["c", "b", "a", "d"]);
      expect(queue.of("chief").map((each) => each.id)).toEqual(["c", "b", "a"]);
      const next = queue.take()!;
      expect(next.id).toBe("c");
      // it could not open after all: back in its place
      queue.restore(next);
      expect(queue.take()!.id).toBe("c");
      expect(queue.remove("chief", "a")?.id).toBe("a");
      expect(queue.remove("lead", "b")).toBeNull();
      expect(new CcStartQueue(path).ordered().map((each) => each.id)).toEqual(["b", "d"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses once full", () => {
    const queue = new CcStartQueue(null);
    for (let i = 0; i < START_QUEUE_MAX; i += 1) queue.add(item(`x${i}`, "x", i));
    expect(queue.add(item("over", "x", 99))).toBeNull();
  });
});
