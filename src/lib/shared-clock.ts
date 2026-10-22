/** One 1-second clock for every working timer on screen: N timers, one interval (none when nothing listens). */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export function onSecond(listener: () => void): () => void {
  listeners.add(listener);
  // A snapshot: a tick may unsubscribe, or a new timer subscribe, during this loop.
  // oxlint-disable-next-line unicorn/no-useless-spread
  timer ??= setInterval(() => { for (const fn of [...listeners]) fn(); }, 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== null) { clearInterval(timer); timer = null; }
  };
}

export const sharedClockListeners = () => listeners.size;
