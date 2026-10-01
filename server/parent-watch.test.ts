import { afterEach, describe, expect, it, vi } from "vitest";
import { exitWithParent, parentGone } from "./parent-watch.ts";

afterEach(() => vi.useRealTimers());

describe("a test server outliving its launcher", () => {
  it("tells a gone process from a live one (or one owned by someone else)", () => {
    const fail = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    expect(parentGone(123, fail("ESRCH"))).toBe(true);
    expect(parentGone(123, fail("EPERM"))).toBe(false);
    expect(parentGone(123, () => {})).toBe(false);
    expect(parentGone(process.pid)).toBe(false);
  });

  it("shuts down once, when the launcher is gone, and only when asked to watch", () => {
    vi.useFakeTimers();
    let alive = true;
    const shutdown = vi.fn();
    const probe = () => { if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
    expect(exitWithParent(String(4242), shutdown, 1_000, probe)).not.toBeNull();
    vi.advanceTimersByTime(3_000);
    expect(shutdown).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(3_000);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitWithParent(undefined, shutdown)).toBeNull();
    expect(exitWithParent("1", shutdown)).toBeNull();
    expect(exitWithParent("abc", shutdown)).toBeNull();
  });
});
