// Free disk space where the work happens (the projects folder, the data
// folder). Worktrees, local CI and builds fill a Mac quietly, and at zero the
// ledgers and the message database stop writing and the server falls over.
// The autonomy tick samples it now and then; each drop into a lower band is
// reported once to the Chief of Staff, and climbing back out re-arms it.
import { statfsSync } from "node:fs";

const GIB = 1024 ** 3;
/** Bands, in GiB free, from "getting low" down to "about to fail". */
export const DISK_BANDS_GIB = [30, 20, 10, 5] as const;
export const DISK_CHECK_EVERY_MS = 10 * 60_000;

/** The lowest band `freeBytes` is under, or null when there is room. */
export function diskBand(freeBytes: number): number | null {
  let band: number | null = null;
  for (const limit of DISK_BANDS_GIB) if (freeBytes < limit * GIB) band = limit;
  return band;
}

export function freeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** Remembers the band last reported per path; says when a new, lower one is reached. */
export class DiskWatch {
  private reported = new Map<string, number | null>();
  private lastCheck = -Infinity;
  private readonly paths: string[];
  private readonly now: () => number;
  private readonly measure: (path: string) => number | null;

  constructor(opts: { paths: string[]; now?: () => number; measure?: (path: string) => number | null }) {
    this.paths = [...new Set(opts.paths)];
    this.now = opts.now ?? Date.now;
    this.measure = opts.measure ?? freeBytes;
  }

  /** At most once per DISK_CHECK_EVERY_MS: the paths that just dropped into a lower band. */
  check(): Array<{ path: string; freeGiB: number; band: number }> {
    const at = this.now();
    if (at - this.lastCheck < DISK_CHECK_EVERY_MS) return [];
    this.lastCheck = at;
    const drops: Array<{ path: string; freeGiB: number; band: number }> = [];
    for (const path of this.paths) {
      const free = this.measure(path);
      if (free === null) continue;
      const band = diskBand(free);
      const before = this.reported.get(path) ?? null;
      if (band !== null && (before === null || band < before)) drops.push({ path, freeGiB: Math.round((free / GIB) * 10) / 10, band });
      this.reported.set(path, band);
    }
    return drops;
  }
}
