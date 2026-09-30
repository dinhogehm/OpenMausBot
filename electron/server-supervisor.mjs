// The desktop owns one child, including while its health probe is pending.
// Startup port selection stays with the caller; runtime recovery retries the
// established port so existing renderer and Companion connections can recover.
// When the quick retries run out, `slowRetryDelaysMs` (if given) keeps trying
// on a long backoff, its last delay repeating forever: a Mac left alone must
// not stay down until someone clicks a dialog. onExhausted fires once per
// streak, when the quick budget is spent.
export function createServerSupervisor({
  restart,
  stop,
  onReady,
  onUnavailable,
  onExhausted,
  log = () => {},
  retryDelaysMs = [1_000, 2_000, 4_000],
  slowRetryDelaysMs = [],
  stableUptimeMs = 60_000,
  now = () => performance.now(),
}) {
  let current = null;
  let readySince = null;
  let stopped = false;
  let attempts = 0;
  let timer = null;
  let shutdownPromise = null;

  const isCurrent = (proc) => !stopped && current === proc;

  function ready(proc) {
    if (!isCurrent(proc)) return false;
    readySince = now();
    onReady(proc);
    return true;
  }

  function schedule() {
    if (stopped) return;
    if (attempts === retryDelaysMs.length) onExhausted();
    if (attempts >= retryDelaysMs.length && !slowRetryDelaysMs.length) return;
    const slow = attempts - retryDelaysMs.length;
    const delay = slow < 0 ? retryDelaysMs[attempts] : slowRetryDelaysMs[Math.min(slow, slowRetryDelaysMs.length - 1)];
    attempts++;
    log(slow < 0 ? `server recovery attempt ${attempts}/${retryDelaysMs.length} in ${delay}ms` : `server recovery: slow retry ${slow + 1} in ${Math.round(delay / 1000)}s`);
    timer = setTimeout(async () => {
      timer = null;
      let result;
      try {
        result = await restart();
      } catch (error) {
        log(`server recovery failed: ${error?.message ?? error}`);
        // A thrown start with a still-owned child is not permission to fork
        // a sibling. The caller must reap failed probes before returning.
        result = { abort: current !== null };
      }
      if (stopped) return;
      if (result?.proc && ready(result.proc)) return;
      if (result?.abort) onExhausted();
      else schedule();
    }, delay);
    timer.unref?.();
  }

  function watch(proc) {
    if (stopped || current) throw new Error("Cannot replace an owned server child");
    current = proc;
    proc.once("exit", () => {
      // Late exits from a failed boot must not clear a replacement's state.
      if (current !== proc) return;
      const wasReady = readySince !== null;
      if (wasReady && now() - readySince >= stableUptimeMs) attempts = 0;
      current = null;
      readySince = null;
      onUnavailable();
      if (wasReady) schedule();
    });
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    clearTimeout(timer);
    timer = null;
    const proc = current;
    current = null;
    readySince = null;
    onUnavailable();
    shutdownPromise = Promise.resolve(stop(proc));
    return shutdownPromise;
  }

  return { watch, ready, isCurrent, shutdown };
}
