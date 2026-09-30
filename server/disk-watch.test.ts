import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISK_CHECK_EVERY_MS, DiskWatch, deviceOf, diskBand, freeBytes } from "./disk-watch.ts";

const GIB = 1024 ** 3;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-disk-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function watch(free: { value: number }, clock: { now: number }, opts: { paths?: string[]; device?: (path: string) => string } = {}) {
  return new DiskWatch({
    paths: opts.paths ?? ["/p"],
    statePath: join(dir, "disk-watch.json"),
    now: () => clock.now,
    measure: () => free.value,
    device: opts.device ?? (() => "vol1"),
  });
}

describe("disk watch", () => {
  it("puts free space in bands", () => {
    expect(diskBand(40 * GIB)).toBeNull();
    expect(diskBand(24 * GIB)).toBe(30);
    expect(diskBand(15 * GIB)).toBe(20);
    expect(diskBand(3 * GIB)).toBe(5);
  });

  it("reports each drop into a lower band once, checking at most every 10 min", () => {
    const clock = { now: 0 };
    const free = { value: 24 * GIB };
    const w = watch(free, clock);
    expect(w.check()).toEqual([{ path: "/p", freeGiB: 24, band: 30 }]);
    clock.now += 60_000;
    free.value = 9 * GIB;
    expect(w.check()).toEqual([]); // too soon
    clock.now += DISK_CHECK_EVERY_MS;
    expect(w.check()).toEqual([{ path: "/p", freeGiB: 9, band: 10 }]);
    clock.now += DISK_CHECK_EVERY_MS;
    expect(w.check()).toEqual([]); // same band: already told
  });

  it("does not ping-pong on a band's edge: re-arms only 2 GiB above the limit", () => {
    const clock = { now: 0 };
    const free = { value: 19.9 * GIB };
    const w = watch(free, clock);
    expect(w.check()).toHaveLength(1); // below 20
    for (const gib of [20.1, 19.9, 21.5, 19.8]) {
      free.value = gib * GIB;
      clock.now += DISK_CHECK_EVERY_MS;
      expect(w.check(), `${gib} GiB`).toEqual([]);
    }
    free.value = 22.5 * GIB; // clears the margin: back to the 30 band
    clock.now += DISK_CHECK_EVERY_MS;
    expect(w.check()).toEqual([]);
    free.value = 19.5 * GIB;
    clock.now += DISK_CHECK_EVERY_MS;
    expect(w.check()).toEqual([{ path: "/p", freeGiB: 19.5, band: 20 }]);
  });

  it("remembers what it reported across a restart", () => {
    const clock = { now: 0 };
    const free = { value: 19.9 * GIB };
    expect(watch(free, clock).check()).toHaveLength(1);
    free.value = 20.1 * GIB; // back in the milder 30 band, but within the margin
    expect(watch(free, clock).check()).toEqual([]);
    free.value = 45 * GIB;
    expect(watch(free, clock).check()).toEqual([]);
    free.value = 25 * GIB;
    expect(watch(free, clock).check()).toEqual([{ path: "/p", freeGiB: 25, band: 30 }]);
  });

  it("counts folders on one volume once", () => {
    const clock = { now: 0 };
    const free = { value: 9 * GIB };
    const w = watch(free, clock, { paths: ["/Users/o/Projetos", "/Users/o/.openmausbot", "/Volumes/ext"], device: (path) => (path.startsWith("/Volumes") ? "vol2" : "vol1") });
    expect(w.check().map((drop) => drop.path)).toEqual(["/Users/o/Projetos", "/Volumes/ext"]);
  });

  it("measures a real folder and its volume", () => {
    expect(freeBytes(process.cwd())).toBeGreaterThan(0);
    expect(freeBytes("/definitely/not/here")).toBeNull();
    expect(deviceOf(process.cwd())).toBe(deviceOf(join(process.cwd(), "server")));
  });
});
