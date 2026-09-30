import { describe, expect, it } from "vitest";
import { DISK_CHECK_EVERY_MS, DiskWatch, diskBand, freeBytes } from "./disk-watch.ts";

const GIB = 1024 ** 3;

describe("disk watch", () => {
  it("puts free space in bands", () => {
    expect(diskBand(40 * GIB)).toBeNull();
    expect(diskBand(24 * GIB)).toBe(30);
    expect(diskBand(15 * GIB)).toBe(20);
    expect(diskBand(3 * GIB)).toBe(5);
  });

  it("reports each drop into a lower band once, re-arms after recovering, and checks at most every 10 min", () => {
    let now = 0;
    let free = 24 * GIB;
    const watch = new DiskWatch({ paths: ["/p", "/p"], now: () => now, measure: () => free });
    expect(watch.check()).toEqual([{ path: "/p", freeGiB: 24, band: 30 }]);
    now += 60_000;
    free = 9 * GIB;
    expect(watch.check()).toEqual([]); // too soon
    now += DISK_CHECK_EVERY_MS;
    expect(watch.check()).toEqual([{ path: "/p", freeGiB: 9, band: 10 }]);
    now += DISK_CHECK_EVERY_MS;
    expect(watch.check()).toEqual([]); // same band: already told
    free = 50 * GIB;
    now += DISK_CHECK_EVERY_MS;
    expect(watch.check()).toEqual([]);
    free = 25 * GIB;
    now += DISK_CHECK_EVERY_MS;
    expect(watch.check()).toEqual([{ path: "/p", freeGiB: 25, band: 30 }]);
  });

  it("measures a real folder", () => {
    expect(freeBytes(process.cwd())).toBeGreaterThan(0);
    expect(freeBytes("/definitely/not/here")).toBeNull();
  });
});
