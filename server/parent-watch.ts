// A test or verification server whose launcher died (a vitest worker killed
// on timeout, a terminal closed) used to live on for hours with no owner
// (R7-resilience P-ORF: an omb-api-test server alive 10 h). With
// OMB_EXIT_WITH_PARENT=<pid> the server checks that process every few
// seconds and shuts down cleanly once it is gone. The app never sets it.

export function parentGone(pid: number, probe: (pid: number, signal: 0) => void = process.kill): boolean {
  try {
    probe(pid, 0);
    return false;
  } catch (error) {
    // EPERM: alive, owned by someone else
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Calls `shutdown` once when the process named by `raw` is gone; null when not asked to watch. */
export function exitWithParent(raw: string | undefined, shutdown: () => void, everyMs = 2_000, probe?: (pid: number, signal: 0) => void): NodeJS.Timeout | null {
  const pid = Number(raw);
  if (!raw || !Number.isInteger(pid) || pid <= 1) return null;
  const timer = setInterval(() => {
    if (!parentGone(pid, probe)) return;
    clearInterval(timer);
    shutdown();
  }, everyMs);
  timer.unref();
  return timer;
}
