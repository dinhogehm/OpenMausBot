export interface SseFanoutClient {
  res: {
    write(chunk: string): boolean;
    end(): void;
    writableLength: number;
    once(event: "drain", listener: () => void): unknown;
    writableEnded?: boolean;
    destroyed?: boolean;
  };
  backpressured: boolean;
}

/** A response a frame may still go to: never one ended or destroyed — a write after end is an
 * 'error' event on the response, and unhandled it kills the server (17/10, ERR_STREAM_WRITE_AFTER_END ×26). */
export function sseWritable(res: { writableEnded?: boolean; destroyed?: boolean }): boolean {
  return res.writableEnded !== true && res.destroyed !== true;
}

/** Ends a stream once, whatever ended it before. */
export function endSse(res: { end(): void; writableEnded?: boolean; destroyed?: boolean }): void {
  if (!sseWritable(res)) return;
  try {
    res.end();
  } catch {
  }
}

interface SseStreamResponse {
  write(chunk: string): boolean;
  end(): void;
  writableEnded?: boolean;
  destroyed?: boolean;
  on(event: "error" | "close" | "finish", listener: (...args: unknown[]) => void): unknown;
}

/** The /api/events keepalive: a heartbeat every `heartbeatMs` while `live()`; the stream
 * ended when it is not. However the stream ends — this keepalive, a revoke or an audience
 * change ending the response elsewhere, the client leaving, a socket error — the interval is
 * cleared and `onDone` runs once, and no tick ever writes to an ended response. The
 * response's 'error' is handled here, never left to crash the process. */
export function startSseKeepalive(input: { req: { on(event: "close", listener: () => void): unknown }; res: SseStreamResponse; heartbeatMs: number; live: () => boolean; frame: string; onDone: () => void }): { stop: () => void } {
  const { req, res } = input;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    input.onDone();
  };
  const timer = setInterval(() => {
    if (!sseWritable(res)) return stop();
    if (!input.live()) {
      stop();
      endSse(res);
      return;
    }
    try {
      res.write(input.frame);
    } catch {
      stop();
    }
  }, input.heartbeatMs);
  res.on("error", (error) => {
    console.warn("sse: stream error, keepalive stopped:", error instanceof Error ? error.message : String(error));
    stop();
  });
  res.on("close", stop);
  res.on("finish", stop);
  req.on("close", stop);
  return { stop };
}

/** Past this, cut the client loose; its EventSource reconnects and replays via Last-Event-ID. */
export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type SseFanoutOutcome = "sent" | "dropped" | "disconnected";

/** Only screen captures are skipped while backpressured; durable events are always written, or the client is disconnected to replay them. */
export function deliverSseFrame(client: SseFanoutClient, kind: string, frame: string): SseFanoutOutcome {
  if (!sseWritable(client.res)) return "disconnected";
  if (client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
    try {
      client.res.end();
    } catch {
    }
    return "disconnected";
  }
  if (client.backpressured && kind === "screen") return "dropped";
  try {
    if (!client.res.write(frame) && !client.backpressured) {
      // write() returns false past the 16 KB highWaterMark, which one screen frame clears: it means "not drained yet", and without the drain listener the flag latches forever.
      client.backpressured = true;
      client.res.once("drain", () => {
        client.backpressured = false;
      });
    }
    return "sent";
  } catch {
    return "disconnected";
  }
}
