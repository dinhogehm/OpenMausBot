// The canvas's save state machine, extracted from the component so its
// concurrency rules are unit-testable without a React tree or a DOM.
//
// The rules it exists to enforce:
//   * exactly one request in flight — a save asked for while one is running
//     queues behind it instead of racing it, so the last write to reach the
//     server is always the newest document;
//   * `flush()` resolves only once the drain is finished, and reports whether
//     the document actually reached the server — a caller that needs the
//     server to be current (starting a run, leaving the canvas) can await it
//     and abort on failure;
//   * a failed send leaves the document dirty so the next attempt retries it.
//
// The debounce lives in the component: which edits are worth coalescing is a
// UI decision, while "one at a time, newest wins, report failure" is not.

export type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "error";

export interface SaveResult {
  /** False only when a send was attempted and threw. */
  ok: boolean;
  error: string | null;
  /** Whether anything was actually sent. False when there was nothing to save
   * or the queue is paused — an honest `ok: true` that did not write. */
  sent: boolean;
}

export interface SaveQueueSnapshot {
  status: SaveStatus;
  error: string | null;
  /** Local edits the server has not acknowledged. */
  dirty: boolean;
  saving: boolean;
  paused: boolean;
  /** Bumped by every `markDirty`; a send that finishes on the same revision
   * it started on is known to have shipped everything. */
  revision: number;
}

export interface SaveQueue {
  /** One local edit happened. Never sends by itself — the caller's debounce
   * decides when to `flush`. */
  markDirty(): void;
  /** Drain the queue: send the newest document, and keep going while more
   * flushes arrive. Resolves when nothing is left to do. */
  flush(): Promise<SaveResult>;
  /** Suspend sending without losing the dirty flag. A paused queue's `flush`
   * is a no-op that reports `sent: false`. Observation modes that swap the
   * document out from under the editor use this so a swapped-in document can
   * never be written back. */
  setPaused(paused: boolean): void;
  snapshot(): SaveQueueSnapshot;
}

export interface SaveQueueOptions {
  /** Performs one write of the caller's current document. Throwing is how it
   * reports failure. */
  send: () => Promise<void>;
  /** Called on every status transition, for the component's indicator. */
  onStatus?: (status: SaveStatus, error: string | null) => void;
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function createSaveQueue({ send, onStatus }: SaveQueueOptions): SaveQueue {
  let status: SaveStatus = "clean";
  let error: string | null = null;
  let dirty = false;
  let saving = false;
  /** A flush was asked for and not yet served. */
  let queued = false;
  let paused = false;
  let revision = 0;
  let draining: Promise<SaveResult> | null = null;

  const emit = (next: SaveStatus, nextError: string | null) => {
    if (status === next && error === nextError) return;
    status = next;
    error = nextError;
    onStatus?.(status, error);
  };

  const drain = async (): Promise<SaveResult> => {
    let result: SaveResult = { ok: true, error: null, sent: false };
    while (queued) {
      queued = false;
      if (paused || !dirty) break;
      // Everything up to this revision is what this attempt is shipping; a
      // higher one on the way back means the author kept typing.
      const at = revision;
      saving = true;
      emit("saving", null);
      try {
        await send();
      } catch (cause) {
        saving = false;
        const failure = messageOf(cause);
        emit("error", failure);
        // dirty stays true: the next flush retries the same document.
        return { ok: false, error: failure, sent: false };
      }
      saving = false;
      if (revision === at) {
        dirty = false;
        emit("saved", null);
      } else {
        emit("dirty", null);
      }
      result = { ok: true, error: null, sent: true };
    }
    return result;
  };

  return {
    markDirty() {
      revision += 1;
      dirty = true;
      // Mid-send edits must not blank the spinner; the drain reports "dirty"
      // itself when it lands on a stale revision.
      if (!saving) emit("dirty", null);
    },

    flush() {
      queued = true;
      if (draining) return draining;
      draining = (async () => {
        try {
          return await drain();
        } finally {
          // Cleared before this promise resolves, so a flush chained onto it
          // starts a fresh drain rather than adopting a finished one.
          draining = null;
        }
      })();
      return draining;
    },

    setPaused(next: boolean) {
      paused = next;
    },

    snapshot() {
      return { status, error, dirty, saving, paused, revision };
    },
  };
}
