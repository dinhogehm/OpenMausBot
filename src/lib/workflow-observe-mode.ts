// The canvas's Edit ⇄ Observe machine, extracted from the component for the
// same reason `workflow-save-queue.ts` was: its rules are about ORDERING
// against a save queue and a server, not about React, and a rule nobody can
// test is a rule held in place by a comment.
//
// The three it exists to enforce:
//
//   * Observe is never lossy. Everything outstanding is written BEFORE the
//     queue is paused, and a write that fails (or an edit that lands DURING
//     it) keeps the canvas in Edit — a paused queue's `flush` sends nothing,
//     so parking unsaved work behind one strands it with no way out.
//   * Leaving Observe unpauses and drains whatever accumulated, so an edit
//     that somehow happened while observing still reaches the server.
//   * A run action's answer belongs to the run AND the node it was issued
//     for. The observed run switches on its own — `observedRunFor` follows
//     the newest live run whenever nothing is picked — so an action keyed
//     only by node id would print run A's 409 on run B's card.
//
// Everything here is a function over injected dependencies: no fetch, no
// store, no React.
import type { SaveQueueSnapshot, SaveResult } from "./workflow-save-queue";
import type { WorkflowRun } from "../../shared/workflow";

/** The answer to one approve / reject / resume, pinned to what it was about. */
export interface WorkflowRunAction {
  runId: string;
  nodeId: string;
  busy: boolean;
  error: string | null;
}

export interface ObserveModeState {
  observing: boolean;
  /** A mode switch is in flight; it awaits a save, so it can be refused. */
  switching: boolean;
  /** Set only by an explicit pick; null means "follow the live run". */
  pickedRunId: string | null;
  action: WorkflowRunAction | null;
  /** A mode-switch or run-level failure, as visible text. */
  error: string | null;
}

export const initialObserveModeState: ObserveModeState = {
  observing: false,
  switching: false,
  pickedRunId: null,
  action: null,
  error: null,
};

/** Only the parts of the save queue this machine may touch. Notably NOT
 * `markDirty`: observation never writes. */
export interface ObserveModeQueue {
  flush(): Promise<SaveResult>;
  setPaused(paused: boolean): void;
  snapshot(): SaveQueueSnapshot;
}

export interface ObserveModeDeps {
  queue: ObserveModeQueue;
  /** Drops a pending debounce; the machine is about to flush by hand. */
  cancelDebounce: () => void;
  /** Merges a partial into the canvas's observation state. */
  patch: (next: Partial<ObserveModeState>) => void;
  /** POSTs one run action, resolving with the run the server echoed back.
   * Throwing is how it reports a 404/409 — the message is what the author
   * is shown. */
  send: (runId: string, path: string, body: string) => Promise<WorkflowRun | null>;
  /** Folds a run into the store, exactly as the SSE frame will. */
  adopt: (run: WorkflowRun) => void;
}

export interface ObserveMode {
  /** Save, then pause, then switch. Resolves true only if Observe was
   * actually entered. */
  enter(): Promise<boolean>;
  leave(): void;
  /** Unmount: whatever mode it was in, the queue must not stay paused or the
   * final drain would send nothing. */
  release(): void;
  act(run: WorkflowRun, path: string, body: string): Promise<void>;
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** What the current action says about ONE card. Null — no busy state, no
 * error — for every other node and every other run, which is what keeps a
 * failure from following the view onto the next run. */
export function actionOn(
  action: WorkflowRunAction | null | undefined,
  runId: string,
  nodeId: string,
): { busy: boolean; error: string | null } | null {
  if (!action || action.runId !== runId || action.nodeId !== nodeId) return null;
  return { busy: action.busy, error: action.error };
}

export function createObserveMode({ queue, cancelDebounce, patch, send, adopt }: ObserveModeDeps): ObserveMode {
  return {
    async enter() {
      patch({ switching: true, error: null });
      try {
        cancelDebounce();
        const flushed = await queue.flush();
        if (!flushed.ok) {
          patch({ error: `Still editing — the latest changes could not be saved first: ${flushed.error}` });
          return false;
        }
        // An edit that landed WHILE that flush was in flight bumped the
        // queue's revision, so the drain returned ok with the document still
        // dirty. Pausing now would hide it behind a queue that cannot send.
        if (queue.snapshot().dirty) {
          const again = await queue.flush();
          if (!again.ok || queue.snapshot().dirty) {
            patch({ error: "Still editing — a change arrived while saving. Try Observe again." });
            return false;
          }
        }
        queue.setPaused(true);
        // Follow whatever is live right now: a pick left over from an earlier
        // visit would hide the run the author came to watch.
        patch({ observing: true, pickedRunId: null, action: null, error: null });
        return true;
      } finally {
        patch({ switching: false });
      }
    },

    leave() {
      queue.setPaused(false);
      patch({ observing: false, error: null });
      if (queue.snapshot().dirty) {
        cancelDebounce();
        void queue.flush();
      }
    },

    release() {
      queue.setPaused(false);
    },

    async act(run, path, body) {
      const nodeId = run.currentNodeId;
      if (!nodeId) return;
      patch({ action: { runId: run.id, nodeId, busy: true, error: null } });
      try {
        const next = await send(run.id, path, body);
        if (next) adopt(next);
        patch({ action: null });
      } catch (cause) {
        // A 409 means someone else resolved this first (the chat card,
        // another window, the expiry sweep). The store already has — or is
        // about to get — the real state, so there is nothing to undo here,
        // only something to say.
        patch({ action: { runId: run.id, nodeId, busy: false, error: messageOf(cause) } });
      }
    },
  };
}
