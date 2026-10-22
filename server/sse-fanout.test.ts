import { describe, expect, it, vi } from "vitest";

import { createServer, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { deliverSseFrame, endSse, SSE_MAX_BUFFERED_BYTES, startSseKeepalive, type SseFanoutClient } from "./sse-fanout.ts";

type TestClient = SseFanoutClient & { drains: (() => void)[] };

function fakeClient(resOverrides: Partial<SseFanoutClient["res"]> = {}): TestClient {
  const drains: (() => void)[] = [];
  return {
    backpressured: false,
    drains,
    res: {
      writableLength: 0,
      write: () => true,
      end: () => {},
      once: (_event: "drain", listener: () => void) => drains.push(listener),
      ...resOverrides,
    },
  };
}

describe("deliverSseFrame", () => {
  it("sends normally while write() returns true", () => {
    const client = fakeClient();
    expect(deliverSseFrame(client, "message", "frame-a")).toBe("sent");
    expect(client.backpressured).toBe(false);
  });

  it("marks the client backpressured when write() returns false, without dropping that frame", () => {
    const client = fakeClient({ write: () => false });
    expect(deliverSseFrame(client, "message", "frame-a")).toBe("sent");
    expect(client.backpressured).toBe(true);
  });

  it("drops a replaceable screen frame once backpressured, but never drops a durable event", () => {
    const written: string[] = [];
    const client = fakeClient({
      write: (chunk: string) => {
        written.push(chunk);
        return false;
      },
    });

    expect(deliverSseFrame(client, "screen", "screen-1")).toBe("sent");
    expect(client.backpressured).toBe(true);

    expect(deliverSseFrame(client, "screen", "screen-2")).toBe("dropped");

    expect(deliverSseFrame(client, "message", "message-1")).toBe("sent");

    expect(written).toEqual(["screen-1", "message-1"]);
  });

  it("disconnects a client once buffered bytes exceed the bound, even for a durable event", () => {
    let ended = false;
    const client = fakeClient({
      writableLength: SSE_MAX_BUFFERED_BYTES + 1,
      end: () => {
        ended = true;
      },
    });
    expect(deliverSseFrame(client, "message", "message-1")).toBe("disconnected");
    expect(ended).toBe(true);
  });

  it("resumes screen frames once the socket drains", () => {
    // A single screen frame exceeds the 16 KB highWaterMark, so even a healthy client's write() returns false.
    let full = true;
    const client = fakeClient({ write: () => !full });

    expect(deliverSseFrame(client, "screen", "screen-1")).toBe("sent");
    expect(client.backpressured).toBe(true);
    expect(deliverSseFrame(client, "screen", "screen-2")).toBe("dropped");
    expect(client.drains).toHaveLength(1);

    full = false;
    for (const drain of client.drains) drain();

    expect(client.backpressured).toBe(false);
    expect(deliverSseFrame(client, "screen", "screen-3")).toBe("sent");
  });

  it("queues one drain listener per backpressure episode, not per frame", () => {
    const client = fakeClient({ write: () => false });

    deliverSseFrame(client, "message", "message-1");
    deliverSseFrame(client, "message", "message-2");
    deliverSseFrame(client, "message", "message-3");

    expect(client.backpressured).toBe(true);
    expect(client.drains).toHaveLength(1);
  });

  it("treats a throwing write() as a dead connection", () => {
    const client = fakeClient({
      write: () => {
        throw new Error("socket hang up");
      },
    });
    expect(deliverSseFrame(client, "message", "message-1")).toBe("disconnected");
  });
});

// 17/10: the server died 26 times (5 since 21:30 BRT) on ERR_STREAM_WRITE_AFTER_END from the
// /api/events keepalive — the response ended (session no longer live, an audience change, a
// revoke) and the interval left running wrote to it on its next tick; unhandled, it killed the process.
describe("startSseKeepalive", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function stream(live: () => boolean) {
    let res!: ServerResponse;
    let req!: Parameters<typeof startSseKeepalive>[0]["req"];
    const done = { count: 0 };
    const writesAfterEnd = { count: 0 };
    const errors: unknown[] = [];
    const server = createServer((incoming, response) => {
      req = incoming;
      res = response;
      response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      response.write("data: hello\n\n");
      const write = response.write.bind(response) as (chunk: string) => boolean;
      response.write = ((chunk: string) => { if (response.writableEnded) writesAfterEnd.count++; return write(chunk); }) as typeof response.write;
      response.on("error", (error) => errors.push(error));
      startSseKeepalive({ req, res: response, heartbeatMs: 15, live, frame: ": keepalive\n\n", onDone: () => { done.count++; } });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/api/events", agent: false });
    client.on("response", (answer) => answer.resume());
    client.on("error", () => {});
    client.end();
    while (!res) await sleep(5);
    return { get res() { return res; }, done, writesAfterEnd, errors, close: () => { client.destroy(); server.closeAllConnections(); server.close(); } };
  }

  it("ends the stream once the session is no longer live, clears its interval, and never writes after end", async () => {
    let live = true;
    const s = await stream(() => live);
    await sleep(40);
    live = false;
    await sleep(120);
    expect(s.res.writableEnded).toBe(true);
    expect(s.done.count).toBe(1);
    expect(s.writesAfterEnd.count).toBe(0);
    expect(s.errors).toEqual([]);
    s.close();
  });

  it("stops when the response is ended elsewhere (an audience change, a revoke) while the session stays live", async () => {
    const s = await stream(() => true);
    await sleep(30);
    endSse(s.res);
    endSse(s.res);
    await sleep(120);
    expect(s.done.count).toBe(1);
    expect(s.writesAfterEnd.count).toBe(0);
    expect(s.errors).toEqual([]);
    s.close();
  });

  it("a tick on an ended or destroyed response writes nothing and stops", async () => {
    let writes = 0;
    let done = 0;
    const res = { writableEnded: true, destroyed: false, write: () => { writes++; return true; }, end: () => {}, on: () => res };
    startSseKeepalive({ req: { on: () => undefined }, res, heartbeatMs: 5, live: () => true, frame: "x", onDone: () => { done++; } });
    await sleep(40);
    expect({ writes, done }).toEqual({ writes: 0, done: 1 });
    expect(deliverSseFrame({ res: { ...res, writableLength: 0, once: () => res }, backpressured: false }, "message", "m")).toBe("disconnected");
    expect(writes).toBe(0);
  });

  it("a response 'error' (a write after end) is logged and stops the keepalive instead of crashing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    let writes = 0;
    let done = 0;
    const res = { writableEnded: false, destroyed: false, write: () => { writes++; return true; }, end: () => {},
      on: (event: string, listener: (...args: unknown[]) => void) => { (listeners[event] ??= []).push(listener); return res; } };
    startSseKeepalive({ req: { on: () => undefined }, res, heartbeatMs: 5, live: () => true, frame: "x", onDone: () => { done++; } });
    expect(listeners.error?.length).toBe(1);
    await sleep(20);
    const before = writes;
    listeners.error![0](Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" }));
    listeners.close?.forEach((listener) => listener());
    await sleep(30);
    expect(writes).toBe(before);
    expect(done).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sse:"), "write after end");
    warn.mockRestore();
  });
});
