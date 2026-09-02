// Two of these paths were bugs found by hand and fixed with nothing but a
// comment holding them in place; the third is the invariant the mode exists
// to keep. All three are about ORDERING — against the save queue, against a
// server that can refuse, and against a run that moves on its own — so they
// are pinned here, over the real `createSaveQueue`, rather than in a DOM.
import { describe, expect, it, vi } from "vitest";

import { createSaveQueue } from "./workflow-save-queue";
import {
  actionOn,
  createObserveMode,
  initialObserveModeState,
  type ObserveModeState,
} from "./workflow-observe-mode";
import type { WorkflowRun } from "../../shared/workflow";

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "run-a",
  workflowId: "wf-1",
  status: "waiting-approval",
  currentNodeId: "gate",
  attempt: 0,
  input: "",
  nodeResults: [],
  startedAt: 1_000,
  ...overrides,
});

/** A canvas stand-in: the real save queue, plus the state the component
 * would hold in `useState`. */
function harness(options: {
  send?: () => Promise<void>;
  request?: (runId: string, path: string, body: string) => Promise<WorkflowRun | null>;
} = {}) {
  let state: ObserveModeState = { ...initialObserveModeState };
  const adopted: WorkflowRun[] = [];
  const cancelDebounce = vi.fn();
  const queue = createSaveQueue({ send: options.send ?? (async () => {}) });
  const mode = createObserveMode({
    queue,
    cancelDebounce,
    patch: (next) => {
      state = { ...state, ...next };
    },
    send: options.request ?? (async () => null),
    adopt: (incoming) => adopted.push(incoming),
  });
  return { mode, queue, adopted, cancelDebounce, get state() { return state; } };
}

describe("entering Observe", () => {
  it("saves what is outstanding before it pauses, and reports the mode in state", async () => {
    const sent: number[] = [];
    const canvas = harness({ send: async () => void sent.push(1) });
    canvas.queue.markDirty();

    await expect(canvas.mode.enter()).resolves.toBe(true);

    expect(sent).toHaveLength(1);
    expect(canvas.queue.snapshot()).toMatchObject({ dirty: false, paused: true });
    expect(canvas.state).toMatchObject({ observing: true, switching: false, error: null });
    expect(canvas.cancelDebounce).toHaveBeenCalled();
  });

  it("stays in Edit when the save fails, rather than parking the work behind a paused queue", async () => {
    const canvas = harness({ send: async () => { throw new Error("offline"); } });
    canvas.queue.markDirty();

    await expect(canvas.mode.enter()).resolves.toBe(false);

    expect(canvas.state.observing).toBe(false);
    expect(canvas.state.error).toContain("offline");
    // still writable, and still dirty, so the next edit or retry sends it
    expect(canvas.queue.snapshot()).toMatchObject({ dirty: true, paused: false });
  });

  // An edit landing WHILE the flush is in flight bumps the queue's revision,
  // so the drain returns `{ok: true, sent: true}` with the document still
  // dirty. That reply is honest and useless: pausing on it would park the
  // newer edit behind a queue that sends nothing.
  it("sends again when an edit lands DURING the save it was waiting for", async () => {
    let sends = 0;
    const canvas = harness({
      send: async () => {
        sends += 1;
        if (sends === 1) canvas.queue.markDirty();
      },
    });
    canvas.queue.markDirty();

    await expect(canvas.mode.enter()).resolves.toBe(true);

    expect(sends).toBe(2);
    expect(canvas.queue.snapshot()).toMatchObject({ dirty: false, paused: true });
  });

  it("refuses rather than pausing when that second attempt also fails", async () => {
    let sends = 0;
    const canvas = harness({
      send: async () => {
        sends += 1;
        if (sends === 1) {
          canvas.queue.markDirty();
          return;
        }
        throw new Error("offline");
      },
    });
    canvas.queue.markDirty();

    await expect(canvas.mode.enter()).resolves.toBe(false);
    expect(canvas.state.observing).toBe(false);
    expect(canvas.state.error).toContain("Try Observe again");
    // the edit is still dirty on a queue that can still send it
    expect(canvas.queue.snapshot()).toMatchObject({ dirty: true, paused: false });
  });

  it("clears a stale pick so a live run is followed on the way in", async () => {
    const canvas = harness();
    canvas.mode.leave();
    await canvas.mode.enter();
    expect(canvas.state.pickedRunId).toBeNull();
    expect(canvas.state.action).toBeNull();
  });
});

describe("leaving Observe", () => {
  it("unpauses and drains anything that accumulated while observing", async () => {
    let sends = 0;
    const canvas = harness({ send: async () => void (sends += 1) });
    await canvas.mode.enter();
    expect(sends).toBe(0);

    // an edit that somehow happened while the queue was paused
    canvas.queue.markDirty();
    expect(await canvas.queue.flush()).toMatchObject({ ok: true, sent: false });

    canvas.mode.leave();
    await vi.waitFor(() => expect(sends).toBe(1));
    expect(canvas.queue.snapshot()).toMatchObject({ dirty: false, paused: false });
    expect(canvas.state.observing).toBe(false);
  });

  it("release unpauses so the unmount flush is not a silent no-op", async () => {
    const canvas = harness();
    await canvas.mode.enter();
    canvas.mode.release();
    expect(canvas.queue.snapshot().paused).toBe(false);
  });
});

describe("run actions", () => {
  it("folds the echoed run into the store and clears the action", async () => {
    const advanced = run({ status: "running", currentNodeId: "agent-1" });
    const canvas = harness({ request: async () => advanced });

    await canvas.mode.act(run(), "approval", JSON.stringify({ decision: "approved" }));

    expect(canvas.adopted).toEqual([advanced]);
    expect(canvas.state.action).toBeNull();
  });

  it("keeps a 409 on the run AND node it was issued for", async () => {
    const canvas = harness({ request: async () => { throw new Error("run is not waiting for approval"); } });

    await canvas.mode.act(run(), "approval", "{}");

    expect(canvas.state.action).toEqual({
      runId: "run-a",
      nodeId: "gate",
      busy: false,
      error: "run is not waiting for approval",
    });
    // nothing was folded in: the store's own frame is the truth
    expect(canvas.adopted).toEqual([]);
  });

  it("does nothing for a run with no current node", async () => {
    const request = vi.fn();
    const canvas = harness({ request });
    await canvas.mode.act(run({ currentNodeId: undefined }), "resume", "{}");
    expect(request).not.toHaveBeenCalled();
    expect(canvas.state.action).toBeNull();
  });
});

describe("actionOn", () => {
  const failure = { runId: "run-a", nodeId: "gate", busy: false, error: "run is not waiting for approval" };

  it("reports the failure on the card whose button was pressed", () => {
    expect(actionOn(failure, "run-a", "gate")).toEqual({ busy: false, error: failure.error });
  });

  it("says nothing about another node of the same run", () => {
    // the run MOVES on approval, so "the current node" is not the same card
    expect(actionOn(failure, "run-a", "agent-1")).toBeNull();
  });

  it("says nothing about another run, even at the same node id", () => {
    // the observed run switches on its own whenever nothing is picked: a
    // scheduled run starting must not inherit the failed one's error
    expect(actionOn(failure, "run-b", "gate")).toBeNull();
  });

  it("is null when nothing is in flight", () => {
    expect(actionOn(null, "run-a", "gate")).toBeNull();
  });
});
