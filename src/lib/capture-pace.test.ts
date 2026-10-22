import { afterEach, describe, expect, it, vi } from "vitest";
import { previewCaptureMs } from "./capture-pace";
import { onSecond, sharedClockListeners } from "./shared-clock";

describe("previewCaptureMs", () => {
  it("captures a busy bot every 4 s with focus and every 15 s without", () => {
    expect(previewCaptureMs({ busy: true, focused: true, retryDelay: null })).toBe(4_000);
    expect(previewCaptureMs({ busy: true, focused: false, retryDelay: null })).toBe(15_000);
  });
  it("slows an idle bot to 30 s with focus and 2 min without", () => {
    expect(previewCaptureMs({ busy: false, focused: true, retryDelay: null })).toBe(30_000);
    expect(previewCaptureMs({ busy: false, focused: false, retryDelay: null })).toBe(120_000);
  });
  it("keeps a contention retry's own delay", () => {
    expect(previewCaptureMs({ busy: false, focused: false, retryDelay: 1000 })).toBe(1000);
  });
});

describe("shared clock", () => {
  afterEach(() => vi.useRealTimers());
  it("runs one interval for any number of timers and none when nobody listens", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "setInterval");
    const a = vi.fn(); const b = vi.fn();
    const offA = onSecond(a); const offB = onSecond(b);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(a).toHaveBeenCalledTimes(3); expect(b).toHaveBeenCalledTimes(3);
    offA(); offB();
    expect(sharedClockListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    spy.mockRestore();
  });
});
