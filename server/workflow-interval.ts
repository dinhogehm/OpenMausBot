/** Occurrence math for `triggers.schedule` of type "interval" — pure, local
 * timezone, no I/O. The routine scheduler's `nextOccurrence` covers the
 * calendar shapes (daily, once); an interval is not a calendar at all. It
 * measures IDLENESS: the next run is armed a fixed number of minutes after
 * the last one ended, clamped into the active window when there is one. */
import { refusalBackoffMs, type WorkflowActiveHours, type WorkflowIntervalSchedule } from "../shared/workflow.ts";

const DAY_MS = 24 * 60 * 60_000;
/** How far ahead a window start is searched. One week covers every weekday
 * set; the extra day absorbs a wrap-around window that begins late on the
 * seventh day. */
const WINDOW_SEARCH_DAYS = 8;

const minutesOfDay = (time: string): number => {
  const [hour, minute] = time.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
};

const atClock = (day: Date, minutes: number): Date => {
  const at = new Date(day);
  at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return at;
};

/** Whether `at` falls inside the window. A window whose start is after its
 * end wraps past midnight, and either segment counts; the weekday tested is
 * the instant's own, so "22:00–06:00 on Fridays" ends at Friday midnight
 * and resumes at 22:00 — a wrap window that should cover the early hours of
 * the next day lists that day too. */
export function withinActiveHours(hours: WorkflowActiveHours | undefined, at: number): boolean {
  if (!hours) return true;
  const date = new Date(at);
  if (hours.weekdays !== undefined && !hours.weekdays.includes(date.getDay())) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const start = minutesOfDay(hours.start);
  const end = minutesOfDay(hours.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** The first instant at or after `at` that is inside the window — `at`
 * itself when it already is. Candidates are every day's `start`, plus each
 * midnight for a wrap-around window (the second segment begins there), and
 * the earliest one the predicate above accepts wins; null only when no
 * weekday is allowed, which the validator already refuses. */
export function nextActiveWindowStart(hours: WorkflowActiveHours | undefined, at: number): number | null {
  if (withinActiveHours(hours, at)) return at;
  if (!hours) return at;
  const start = minutesOfDay(hours.start);
  const wraps = start > minutesOfDay(hours.end);
  let best: number | null = null;
  for (let offset = 0; offset < WINDOW_SEARCH_DAYS; offset++) {
    const day = new Date(at + offset * DAY_MS);
    const candidates = [atClock(day, start).getTime()];
    if (wraps) candidates.push(atClock(day, 0).getTime());
    for (const candidate of candidates) {
      if (candidate <= at || !withinActiveHours(hours, candidate)) continue;
      if (best === null || candidate < best) best = candidate;
    }
    if (best !== null) return best;
  }
  return null;
}

/** When an interval schedule should fire next, measured from `idleSince` —
 * the instant the workflow's last run ended, or now when it never ran. A
 * result in the past is deliberate: a computer that slept through the
 * interval is due immediately, not at some later multiple, because there is
 * no calendar slot to realign with. */
export function intervalFireAt(schedule: WorkflowIntervalSchedule, idleSince: number): number | null {
  const due = idleSince + schedule.minutes * 60_000;
  return Number.isFinite(due) ? nextActiveWindowStart(schedule.activeHours, due) : null;
}

/** Where an interval trigger re-arms after `count` refused starts in a
 * row: the backed-off delay (interval × 2^count, capped) from when the
 * workflow went idle, moved into the active window like any slot — or the
 * next window's start when that comes first, so a workflow refused at
 * night is tried again when its day begins rather than six hours into it. */
export function refusalFireAt(schedule: WorkflowIntervalSchedule, idleSince: number, count: number): number | null {
  const due = idleSince + refusalBackoffMs(schedule.minutes, count);
  if (!Number.isFinite(due)) return null;
  const at = nextActiveWindowStart(schedule.activeHours, due);
  const windowStart = nextActiveWindowStart(schedule.activeHours, idleSince);
  if (at === null) return windowStart !== null && windowStart > idleSince ? windowStart : null;
  return windowStart !== null && windowStart > idleSince && windowStart < at ? windowStart : at;
}
