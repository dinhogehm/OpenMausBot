import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { pageSize } from "../host/message-pages.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(messagePage: ThreadRouteDeps["messagePage"], overrides: Partial<ThreadRouteDeps> = {}): Promise<string> {
  const bots = [{ id: "b1", threadId: "t1", modelSelection: {} }, { id: "b2", threadId: "t2", modelSelection: {} }];
  const deps = {
    store: { bots, groups: [], sections: [], tasks: () => [] },
    cfg: {},
    groupUsageReader: { refresh: () => {} },
    defaultPage: 50,
    pageSize,
    messagePage,
    publicBotQueuedMessages: () => ({}),
    wireBot: (bot: { id: string }) => ({ id: bot.id }),
    botComputerControlSnapshot: () => ({ held: false, helpReason: null }),
    viewerFor: () => ({}),
    visibleTo: () => ({ everything: true, bot: () => true, group: () => true, thread: () => true, sections: (s: unknown) => s }),
    workspaceAccess: () => null,
    desktopMutationToken: () => undefined,
    companionMutationToken: () => undefined,
    cliOwnerToken: () => undefined,
  } as unknown as ThreadRouteDeps;
  Object.assign(deps, overrides);
  const routes = [createThreadRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /api/bots pages transcripts by default", () => {
  it("reuses the projected task list and preserves explicit empty tasks", async () => {
    const tasks = [{ threadId: "t1", title: "Waiting", createdAt: 1, waitingForTeammates: true }];
    const projectTask = vi.fn((task: (typeof tasks)[number]) => ({ ...task }));
    const wireBot = vi.fn((bot: { id: string }) => ({ id: bot.id,
      ...(bot.id === "b1" ? { tasks: tasks.map(projectTask) } : {}),
    }));
    const base = await serve(() => ({ messages: [], activeLeafId: null }), {
      wireBot: wireBot as unknown as ThreadRouteDeps["wireBot"],
    });

    const body = await (await fetch(`${base}/api/bots`)).json() as { bots: Array<{ tasks: unknown[] }> };
    expect(body.bots.map((bot) => bot.tasks)).toEqual([tasks, []]);
    expect(wireBot).toHaveBeenCalledTimes(2);
    expect(projectTask).toHaveBeenCalledTimes(1);
  });

  it("answers the newest page without ?messages=, the whole transcript only with ?messages=all", async () => {
    const messagePage = vi.fn((_threadId: string, limit: number | undefined) => ({ messages: [], activeLeafId: null, ...(limit === undefined ? {} : { hasMore: false }) }));
    const base = await serve(messagePage);

    expect((await fetch(`${base}/api/bots`)).status).toBe(200);
    expect(messagePage.mock.calls.map(([, limit]) => limit)).toEqual([50, 50]);

    messagePage.mockClear();
    await fetch(`${base}/api/bots?messages=3`);
    expect(messagePage.mock.calls.map(([, limit]) => limit)).toEqual([3, 3]);

    messagePage.mockClear();
    await fetch(`${base}/api/bots?messages=all`);
    expect(messagePage.mock.calls.map(([, limit]) => limit)).toEqual([undefined, undefined]);

    expect((await fetch(`${base}/api/bots?messages=-1`)).status).toBe(400);
  });
});
