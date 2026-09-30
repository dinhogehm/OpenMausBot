// Free disk space where the work happens (the projects folder, the data
// folder). Worktrees, local CI and builds fill a Mac quietly, and at zero the
// ledgers and the message database stop writing and the server falls over.
// The autonomy tick samples it now and then; each drop into a lower band is
// reported once to the Chief of Staff. A band re-arms only once free space is
// 2 GiB above its limit (no ping-pong on the edge), what was reported is kept
// on disk (a restart does not repeat it), and folders on one volume count once.
import { existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";

const GIB = 1024 ** 3;
/** Bands, in GiB free, from "getting low" down to "about to fail". */
export const DISK_BANDS_GIB = [30, 20, 10, 5] as const;
export const DISK_CHECK_EVERY_MS = 10 * 60_000;
/** Free space must climb this far above a band's limit before it can alert again. */
export const DISK_REARM_MARGIN_BYTES = 2 * GIB;

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

export function deviceOf(path: string): string | null {
  try {
    return String(statSync(path).dev);
  } catch {
    return null;
  }
}

/** Remembers, per volume, the band last reported; says when a new, lower one is reached. */
export class DiskWatch {
  /** Keyed by the first watched folder on each volume (stable across restarts). */
  private reported: Record<string, number | null> = {};
  private lastCheck = -Infinity;
  private readonly paths: string[];
  private readonly statePath: string | null;
  private readonly now: () => number;
  private readonly measure: (path: string) => number | null;

  constructor(opts: { paths: string[]; statePath?: string | null; now?: () => number; measure?: (path: string) => number | null; device?: (path: string) => string | null }) {
    const device = opts.device ?? deviceOf;
    const seen = new Set<string>();
    this.paths = [];
    for (const path of opts.paths) {
      const key = device(path) ?? `path:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.paths.push(path);
    }
    this.statePath = opts.statePath ?? null;
    this.now = opts.now ?? Date.now;
    this.measure = opts.measure ?? freeBytes;
    this.load();
  }

  private load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as { reported?: Record<string, unknown> };
      for (const [path, band] of Object.entries(raw.reported ?? {})) {
        if (band === null || (typeof band === "number" && (DISK_BANDS_GIB as readonly number[]).includes(band))) this.reported[path] = band as number | null;
      }
    } catch { /* start fresh */ }
  }

  private save(): void {
    if (!this.statePath) return;
    try {
      writeFileAtomic(this.statePath, `${JSON.stringify({ reported: this.reported }, null, 2)}\n`, { mode: 0o600 });
    } catch { /* a full disk may refuse; the next check tries again */ }
  }

  /** At most once per DISK_CHECK_EVERY_MS: the volumes that just dropped into a lower band. */
  check(): Array<{ path: string; freeGiB: number; band: number }> {
    const at = this.now();
    if (at - this.lastCheck < DISK_CHECK_EVERY_MS) return [];
    this.lastCheck = at;
    const drops: Array<{ path: string; freeGiB: number; band: number }> = [];
    let changed = false;
    for (const path of this.paths) {
      const free = this.measure(path);
      if (free === null) continue;
      const band = diskBand(free);
      const before = this.reported[path] ?? null;
      let next = before;
      if (band !== null && (before === null || band < before)) {
        drops.push({ path, freeGiB: Math.round((free / GIB) * 10) / 10, band });
        next = band;
      } else if (before !== null) {
        // Re-arm only with a margin above the limit: the band it would be in
        // with 2 GiB less, if that is a milder one.
        const withMargin = diskBand(free - DISK_REARM_MARGIN_BYTES);
        if (withMargin === null || withMargin > before) next = withMargin;
      }
      if (next !== before) {
        this.reported[path] = next;
        changed = true;
      }
    }
    if (changed) this.save();
    return drops;
  }
}
