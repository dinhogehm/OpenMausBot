// This fork's hooks on routes the upstream moved out of server/index.ts
// (bot-messages.ts, tasks.ts). Each one existed inline in the fork and was
// lost in the move; these tests hold them in place through the route table.
//
// What is real here: the route modules, the store and the steer queue. What
// is not: the hooks themselves (stopAutonomyByPerson, settleQueuedAnswers,
// retireThreadWork, SharedState, BotAutonomy) live in server/index.ts or
// need a whole server, so they are recording fakes. Only what each route
// touches is passed; a route that reached for anything else would throw.
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { _queuedCount, cancelSteeredMessage, queueSteeredMessage } from "../steer-queue.ts";
import { Store } from "../store.ts";
import { createBotMessageRoutes, type BotMessageRouteDeps } from "./bot-messages.ts";
import { dispatchRoutes, type RouteHandler } from "./table.ts";
import { createTaskRoutes, type TaskRouteDeps } from "./tasks.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** The route table on a local port, answering a thrown { status } the way server/index.ts does. */
async function serve(route: RouteHandler) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
      const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
}

async function messageRoutes() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const other = store.createTask(bot.id, "Another conversation", false)!;
  const order: string[] = [];
  const state = { busy: false, steer: "steered" as "steered" | "refused" };
  // The running turn as the steer route sees it: busy while state.busy says so.
  const routeStore = new Proxy(store, {
    get(target, key) {
      if (key === "projectBotForTask") {
        return (botId: string, threadId: string) => {
          const projected = target.projectBotForTask(botId, threadId);
          return projected && { ...projected, busy: state.busy };
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const steer = vi.fn(async () => state.steer);
  const deps = {
    store: routeStore,
    registry: { get: () => undefined },
    routines: () => ({ activeBotRunForBot: () => null, cancelRun: vi.fn() }),
    handoffs: {
      current: () => undefined,
      steered: vi.fn(),
      stoppedByPerson: vi.fn((threadId: string) => { order.push(`stoppedByPerson:${threadId}`); }),
    },
    directTurnDispatchClaims: new Map(),
    desktopManaged: true,
    cloudHome: false,
    requestedTaskBot: (botId: string, rawThreadId: unknown) => routeStore.projectBotForTask(botId, String(rawThreadId))!,
    botForThread: () => null,
    activeGroupTurnForBot: () => null,
    runningTurnInstance: () => ({ instanceId: "claude", adapter: { capabilities: { queueing: true }, steer } }),
    engineSteersImages: () => false,
    clearUnattended: vi.fn(),
    drainQueuedSends: vi.fn(),
    interruptDirectThread: vi.fn(async (_botId: string, threadId: string) => { order.push(`interrupt:${threadId}`); }),
    stopAutonomyByPerson: vi.fn((threadId: string) => { order.push(`stopAutonomy:${threadId}`); }),
    queuedLinesDelivered: vi.fn(),
  } as unknown as BotMessageRouteDeps;
  const call = await serve(createBotMessageRoutes(deps));
  return { store, bot, other, order, state, steer, deps, call };
}

describe("Stop (POST /api/bots/:id/interrupt) ends goal mode and wake_me, as the fork's did", () => {
  it("on the conversation the request names, after the hand-off is marked and before the interrupt", async () => {
    const { bot, other, order, deps, call } = await messageRoutes();
    const stopped = await call("POST", `/api/bots/${bot.id}/interrupt`, { threadId: other.threadId });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(deps.stopAutonomyByPerson).toHaveBeenCalledTimes(1);
    expect(order).toEqual([`stoppedByPerson:${other.threadId}`, `stopAutonomy:${other.threadId}`, `interrupt:${other.threadId}`]);
  });

  it("on the bot's open conversation when the request names none", async () => {
    const { bot, order, deps, call } = await messageRoutes();
    const stopped = await call("POST", `/api/bots/${bot.id}/interrupt`, {});
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(deps.stopAutonomyByPerson).toHaveBeenCalledWith(bot.threadId);
    expect(order).toEqual([`stoppedByPerson:${bot.threadId}`, `stopAutonomy:${bot.threadId}`, `interrupt:${bot.threadId}`]);
  });

  it("not when the request is refused before anything is stopped", async () => {
    const { bot, deps, call } = await messageRoutes();
    const refused = await call("POST", `/api/bots/${bot.id}/interrupt`, { threadId: "not a task id" });
    expect(refused.status).toBe(400);
    expect(deps.stopAutonomyByPerson).not.toHaveBeenCalled();
  });
});

describe("Steer (POST /api/bots/:id/queue/:queueId/steer) settles a queued \"Precisa de você\" answer", () => {
  it("as delivered when the words are folded into the running turn", async () => {
    const { bot, state, steer, deps, call } = await messageRoutes();
    state.busy = true;
    const queued = queueSteeredMessage(bot.id, bot.threadId, "Sim, pode seguir.");
    const steered = await call("POST", `/api/bots/${bot.id}/queue/${queued.id}/steer`, { threadId: bot.threadId });
    expect(steered.status, JSON.stringify(steered.body)).toBe(200);
    expect(steered.body).toMatchObject({ ok: true, steered: true, queueIds: [queued.id] });
    expect(steer).toHaveBeenCalledTimes(1);
    expect(deps.queuedLinesDelivered).toHaveBeenCalledTimes(1);
    expect(deps.queuedLinesDelivered).toHaveBeenCalledWith([queued.id]);
    expect(_queuedCount(bot.threadId)).toBe(0);
  });

  it("not while the words stay in the queue because the engine refused the steer", async () => {
    const { bot, state, deps, call } = await messageRoutes();
    state.busy = true;
    state.steer = "refused";
    const queued = queueSteeredMessage(bot.id, bot.threadId, "Sim, pode seguir.");
    try {
      const kept = await call("POST", `/api/bots/${bot.id}/queue/${queued.id}/steer`, { threadId: bot.threadId });
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(kept.body).toMatchObject({ ok: true, queued: true });
      expect(deps.queuedLinesDelivered).not.toHaveBeenCalled();
      expect(_queuedCount(bot.threadId)).toBe(1);
    } finally {
      cancelSteeredMessage(bot.id, queued.id, bot.threadId);
    }
  });
});

async function taskRoutes() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const other = store.createTask(bot.id, "Another conversation", false)!;
  const order: string[] = [];
  const state = { busy: false };
  // upstream v0.1.112 deletes through deleteTasks (one or a bulk selection)
  const realDelete = store.deleteTasks.bind(store);
  vi.spyOn(store, "deleteTasks").mockImplementation((botId, threadIds) => {
    for (const threadId of threadIds) order.push(`deleteTask:${threadId}`);
    return realDelete(botId, threadIds);
  });
  const deps = {
    store,
    cloudHome: false,
    desktopManaged: true,
    hostedWorkspace: false,
    hostedFullAccessRefusal: "",
    hostedModels: null,
    routines: () => ({ isActiveThread: () => false }),
    coordinator: { cancelDirect: vi.fn() },
    handoffs: { forget: vi.fn() },
    skillReview: { dropThread: vi.fn() },
    phoneSecretSubmissions: { hasBot: () => false, hasThread: () => false },
    directTurnGenerationByThread: new Map(),
    cloudThreadRefusal: () => null,
    threadBusy: () => state.busy,
    publicBot: (record: { id: string }) => ({ id: record.id }),
    wireTask: (task: { threadId: string; archivedAt?: number }) => ({ threadId: task.threadId, archivedAt: task.archivedAt }),
    settleDirectFollowup: vi.fn(),
    clearTurnDigestState: vi.fn(),
    revokeInternalCapabilitiesForThread: vi.fn(),
    stagedSkillCleanupsForThread: () => [],
    rejectDeletedThreadSkillStages: vi.fn(),
    retireThreadWork: vi.fn((_botId: string, threadId: string, why: string) => { order.push(`retire:${threadId}:${why}`); }),
    forgetDeletedThread: vi.fn((_botId: string, threadId: string) => { order.push(`forget:${threadId}`); }),
  } as unknown as TaskRouteDeps;
  const call = await serve(createTaskRoutes(deps));
  return { store, bot, other, order, state, deps, call };
}

describe("Archiving a conversation (PATCH /api/bots/:id/tasks/:tid archivedAt) retires its work", () => {
  it("once, before the archive is written", async () => {
    const { store, bot, other, deps, call } = await taskRoutes();
    const archivedAt = Date.now();
    vi.mocked(deps.retireThreadWork!).mockImplementation((botId, threadId) => {
      // the retire runs while the conversation is still in the list
      expect(store.taskByThread(botId, threadId)?.archivedAt).toBeUndefined();
    });
    const archived = await call("PATCH", `/api/bots/${bot.id}/tasks/${other.threadId}`, { archivedAt });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(deps.retireThreadWork).toHaveBeenCalledTimes(1);
    expect(deps.retireThreadWork).toHaveBeenCalledWith(bot.id, other.threadId, "arquivada");
    expect(store.taskByThread(bot.id, other.threadId)?.archivedAt).toBe(archivedAt);
  });

  it("not when it is unarchived, and not when the change is refused", async () => {
    const { bot, other, deps, call } = await taskRoutes();
    expect((await call("PATCH", `/api/bots/${bot.id}/tasks/${other.threadId}`, { archivedAt: null })).status).toBe(200);
    expect((await call("PATCH", `/api/bots/${bot.id}/tasks/${other.threadId}`, { archivedAt: "yesterday" })).status).toBe(400);
    // a valid archivedAt beside a field the route refuses: nothing is written, nothing retired
    expect((await call("PATCH", `/api/bots/${bot.id}/tasks/${other.threadId}`, { archivedAt: Date.now(), pinned: "yes" })).status).toBe(400);
    expect(deps.retireThreadWork).not.toHaveBeenCalled();
  });
});

describe("Deleting a conversation (DELETE /api/bots/:id/tasks/:tid) retires and forgets its work", () => {
  it("retires it before the delete and forgets its shared and autonomy state after", async () => {
    const { store, bot, other, order, deps, call } = await taskRoutes();
    const deleted = await call("DELETE", `/api/bots/${bot.id}/tasks/${other.threadId}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(store.taskByThread(bot.id, other.threadId)).toBeUndefined();
    expect(order).toEqual([
      `retire:${other.threadId}:apagada`,
      `deleteTask:${other.threadId}`,
      `forget:${other.threadId}`,
    ]);
    expect(deps.forgetDeletedThread).toHaveBeenCalledWith(bot.id, other.threadId);
  });

  it("touches nothing when the conversation is still working", async () => {
    const { bot, other, order, state, call } = await taskRoutes();
    state.busy = true;
    const refused = await call("DELETE", `/api/bots/${bot.id}/tasks/${other.threadId}`);
    expect(refused.status).toBe(409);
    expect(order).toEqual([]);
  });
});
