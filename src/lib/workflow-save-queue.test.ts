// These are the rules a whole-document PATCH depends on: never two in
// flight, the newest document wins, and a caller that must not proceed on
// stale server state (a run, or leaving the canvas) can tell whether the
// write landed.
import { describe, expect, it, vi } from "vitest";

import { createSaveQueue, type SaveQueue, type SaveStatus } from "./workflow-save-queue";

/** A send whose completion the test controls, recording concurrency. */
function controllable() {
  const resolvers: { resolve: () => void; reject: (cause: unknown) => void }[] = [];
  let inFlight = 0;
  let peak = 0;
  const send = vi.fn(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise<void>((resolve, reject) => resolvers.push({ resolve, reject }));
    } finally {
      inFlight -= 1;
    }
  });
  return {
    send,
    get peak() {
      return peak;
    },
    get pending() {
      return resolvers.length;
    },
    settle: async (at = 0, cause?: unknown) => {
      const one = resolvers[at];
      if (!one) throw new Error(`no send pending at ${at}`);
      if (cause === undefined) one.resolve();
      else one.reject(cause);
      // let the drain's continuation run
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

const track = (): { statuses: SaveStatus[]; onStatus: (status: SaveStatus) => void } => {
  const statuses: SaveStatus[] = [];
  return { statuses, onStatus: (status) => statuses.push(status) };
};

describe("createSaveQueue", () => {
  it("starts clean and sends nothing until something is dirty", async () => {
    const send = vi.fn(async () => {});
    const queue = createSaveQueue({ send });

    expect(queue.snapshot()).toMatchObject({ status: "clean", dirty: false, saving: false });
    await expect(queue.flush()).resolves.toEqual({ ok: true, error: null, sent: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends once for a dirty document and reports it saved", async () => {
    const send = vi.fn(async () => {});
    const { statuses, onStatus } = track();
    const queue = createSaveQueue({ send, onStatus });

    queue.markDirty();
    expect(queue.snapshot()).toMatchObject({ status: "dirty", dirty: true, revision: 1 });

    await expect(queue.flush()).resolves.toEqual({ ok: true, error: null, sent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["dirty", "saving", "saved"]);
    expect(queue.snapshot()).toMatchObject({ status: "saved", dirty: false, saving: false });
  });

  it("never runs two sends at once — a flush during a send queues behind it", async () => {
    const control = controllable();
    const queue = createSaveQueue({ send: control.send });

    queue.markDirty();
    const first = queue.flush();
    expect(queue.snapshot().saving).toBe(true);

    // an edit lands mid-flight, and something asks to save again
    queue.markDirty();
    const second = queue.flush();
    expect(control.send).toHaveBeenCalledTimes(1);

    await control.settle();
    // the second send only starts after the first finished
    expect(control.send).toHaveBeenCalledTimes(2);
    expect(control.peak).toBe(1);

    await control.settle(1);
    await expect(first).resolves.toMatchObject({ ok: true, sent: true });
    await expect(second).resolves.toMatchObject({ ok: true, sent: true });
    expect(queue.snapshot()).toMatchObject({ status: "saved", dirty: false });
  });

  it("resolves a flush only once the newest document has been sent", async () => {
    const control = controllable();
    const queue = createSaveQueue({ send: control.send });

    queue.markDirty();
    void queue.flush();

    // the caller that must not proceed on stale state asks while one is running
    queue.markDirty();
    const flushed = queue.flush();
    let settled = false;
    void flushed.then(() => {
      settled = true;
    });

    await control.settle();
    expect(settled).toBe(false); // the follow-up send is still in flight

    await control.settle(1);
    await expect(flushed).resolves.toMatchObject({ ok: true, sent: true });
    expect(queue.snapshot().dirty).toBe(false);
  });

  it("stays dirty after a mid-flight edit so the next flush ships it", async () => {
    const control = controllable();
    const { statuses, onStatus } = track();
    const queue = createSaveQueue({ send: control.send, onStatus });

    queue.markDirty();
    const first = queue.flush();
    queue.markDirty(); // arrives while the send is running, with no new flush

    await control.settle();
    await expect(first).resolves.toMatchObject({ ok: true, sent: true });
    // one send, and the queue knows the server is behind again
    expect(control.send).toHaveBeenCalledTimes(1);
    expect(queue.snapshot()).toMatchObject({ status: "dirty", dirty: true });
    expect(statuses).toEqual(["dirty", "saving", "dirty"]);
  });

  it("reports a failure, keeps the document dirty, and retries on the next flush", async () => {
    const control = controllable();
    const { statuses, onStatus } = track();
    const queue = createSaveQueue({ send: control.send, onStatus });

    queue.markDirty();
    const failed = queue.flush();
    await control.settle(0, new Error("workflow still has 1 live run"));

    await expect(failed).resolves.toEqual({
      ok: false,
      error: "workflow still has 1 live run",
      sent: false,
    });
    expect(queue.snapshot()).toMatchObject({ status: "error", dirty: true, saving: false });
    expect(statuses).toEqual(["dirty", "saving", "error"]);

    const retried = queue.flush();
    expect(control.send).toHaveBeenCalledTimes(2);
    await control.settle(1);
    await expect(retried).resolves.toMatchObject({ ok: true, sent: true });
    expect(queue.snapshot()).toMatchObject({ status: "saved", dirty: false });
  });

  it("turns a non-Error rejection into a readable message", async () => {
    const queue = createSaveQueue({
      send: async () => {
        throw "boom";
      },
    });
    queue.markDirty();
    await expect(queue.flush()).resolves.toMatchObject({ ok: false, error: "boom" });
  });

  it("clears the error when a new edit arrives, so the debounce can retry quietly", async () => {
    const queue = createSaveQueue({
      send: async () => {
        throw new Error("nope");
      },
    });
    queue.markDirty();
    await queue.flush();
    expect(queue.snapshot().status).toBe("error");

    queue.markDirty();
    expect(queue.snapshot().status).toBe("dirty");
  });

  it("starts a fresh drain for a flush chained onto a finished one", async () => {
    const send = vi.fn(async () => {});
    const queue = createSaveQueue({ send });

    queue.markDirty();
    const chained = queue.flush().then(() => {
      queue.markDirty();
      return queue.flush();
    });

    await expect(chained).resolves.toMatchObject({ ok: true, sent: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends nothing while paused, and keeps the dirty flag for later", async () => {
    const send = vi.fn(async () => {});
    const queue = createSaveQueue({ send });

    queue.markDirty();
    queue.setPaused(true);
    await expect(queue.flush()).resolves.toEqual({ ok: true, error: null, sent: false });
    expect(send).not.toHaveBeenCalled();
    expect(queue.snapshot()).toMatchObject({ dirty: true, paused: true });

    queue.setPaused(false);
    await expect(queue.flush()).resolves.toMatchObject({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("survives many flushes for one dirty document without piling up sends", async () => {
    const control = controllable();
    const queue: SaveQueue = createSaveQueue({ send: control.send });

    queue.markDirty();
    const flushes = [queue.flush(), queue.flush(), queue.flush()];
    expect(control.send).toHaveBeenCalledTimes(1);

    await control.settle();
    // the extra flushes were folded into the running drain, which then found
    // nothing left to do
    expect(control.send).toHaveBeenCalledTimes(1);
    for (const flushed of flushes) await expect(flushed).resolves.toMatchObject({ ok: true });
    expect(queue.snapshot()).toMatchObject({ status: "saved", dirty: false });
  });
});
