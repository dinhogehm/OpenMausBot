import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { BotAutonomy } from "../bot-autonomy.ts";
import { IntakeLock } from "../intake-lock.ts";
import type { ReleaseRecord } from "../prod-delivery.ts";
import { createInternalWakeGoalRoutes } from "./internal-wake-goal.ts";
import type { RouteContext } from "./table.ts";

const BOT = "bot-1";
const THREAD = "thread-1";
const START = Date.parse("2026-10-22T12:00:00Z");
const SHA = "a1".repeat(20);
type Deps = Parameters<typeof createInternalWakeGoalRoutes>[0];
type Receipt = ReleaseRecord | null | "unavailable";
const certified: ReleaseRecord = { result: "healthy", deployedAt: new Date(START + 1_000).toISOString() };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(releaseRecord: NonNullable<Deps["releaseRecord"]>, goalText = "Publicar a entrega em produção") {
  const autonomy = new BotAutonomy({ path: null, now: () => START });
  const goal = autonomy.startGoal(BOT, THREAD, { goal: goalText, maxTurns: 5, maxHours: 1 });
  const appendMessage = vi.fn();
  const broadcast = vi.fn();
  let active = true;
  const requireActiveInternalCapability = vi.fn(() => {
    if (!active) throw Object.assign(new Error("internal capability revoked"), { status: 403 });
  });
  const replies: Array<{ status: number; body: unknown }> = [];
  const store = {
    groupByThread: () => null,
    taskByThread: (botId: string, threadId: string) => botId === BOT && threadId === THREAD ? { threadId } : null,
    appendMessage,
  } as unknown as Deps["store"];

  async function end(proof = SHA) {
    const body = { action: "end", status: "completed", detail: "Publicado e conferido", proof };
    const route = createInternalWakeGoalRoutes({
      store, autonomy, broadcast, intakeLock: new IntakeLock(() => false),
      watchCwd: () => "/unused",
      wireBot: () => { throw new Error("unexpected wireBot"); },
      internalSender: { id: BOT } as Deps["internalSender"],
      internalCapability: { botId: BOT, threadId: THREAD },
      readInternalBody: async () => body,
      requireActiveInternalCapability,
      deliverySessions: () => [],
      releaseRecord,
    });
    const context: RouteContext = {
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL("http://localhost/api/internal/goal"),
      path: "/api/internal/goal", method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] },
      json: (_res, status, response) => { replies.push({ status, body: response }); },
      readBody: async () => body,
    };
    await route(context);
    return replies.at(-1);
  }

  return { autonomy, goal, appendMessage, broadcast, replies, requireActiveInternalCapability, end, revoke: () => { active = false; } };
}

describe("production goal completion through the internal route", () => {
  it("refuses a PR number without the server's production announcement", async () => {
    const releaseRecord = vi.fn(async () => certified);
    const h = harness(releaseRecord, "Levar a PR #9400 até produção");
    expect(await h.end("PR #9400 mergeada")).toMatchObject({
      status: 400, body: { error: expect.stringContaining("a meta fala em produção") },
    });
    expect(h.autonomy.goalFor(THREAD)).toBe(h.goal);
    expect(h.goal.status).toBe("active");
    expect(h.appendMessage).not.toHaveBeenCalled();
    expect(releaseRecord).not.toHaveBeenCalled();
  });

  it("accepts a certified release after the same goal started", async () => {
    const releaseRecord = vi.fn(async () => certified);
    const h = harness(releaseRecord);
    expect(await h.end()).toMatchObject({ status: 200 });
    expect(releaseRecord).toHaveBeenCalledWith(SHA);
    expect(h.autonomy.goalFor(THREAD)).toBe(h.goal);
    expect(h.goal.status).toBe("completed");
    expect(h.appendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not complete a replacement goal while the certified receipt is loading", async () => {
    const reading = deferred<void>();
    const receipt = deferred<Receipt>();
    const releaseRecord = vi.fn(async (_sha: string) => { reading.resolve(); return receipt.promise; });
    const h = harness(releaseRecord);
    const pending = h.end();
    await Promise.race([reading.promise, pending.then(() => { throw new Error("route ended before reading the release receipt"); })]);
    expect(h.replies).toEqual([]);
    // Same text and clock: the goal's identity, not its timestamp, distinguishes it.
    const replacement = h.autonomy.startGoal(BOT, THREAD, { goal: h.goal.goal, maxTurns: 5, maxHours: 1 });
    expect(replacement.startedAt).toBe(h.goal.startedAt);
    receipt.resolve(certified);
    expect(await pending).toMatchObject({ status: 409 });
    expect(h.autonomy.goalFor(THREAD)).toBe(replacement);
    expect(replacement.status).toBe("active");
    expect(h.goal.status).toBe("active");
    expect(h.appendMessage).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("does not complete the goal after its capability is revoked while the receipt is loading", async () => {
    const reading = deferred<void>();
    const receipt = deferred<Receipt>();
    const releaseRecord = vi.fn(async (_sha: string) => { reading.resolve(); return receipt.promise; });
    const h = harness(releaseRecord);
    const pending = h.end();
    await Promise.race([reading.promise, pending.then(() => { throw new Error("route ended before reading the release receipt"); })]);
    expect(h.replies).toEqual([]);
    h.revoke();
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    receipt.resolve(certified);
    await rejected;
    expect(h.requireActiveInternalCapability).toHaveBeenCalledTimes(2);
    expect(h.autonomy.goalFor(THREAD)).toBe(h.goal);
    expect(h.goal.status).toBe("active");
    expect(h.appendMessage).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.replies).toEqual([]);
  });
});
