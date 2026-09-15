const DAY = 24 * 60 * 60_000;
const RETRY = 60 * 60_000;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const sameScope = (left, right) => Boolean(left && right && left.key === right.key && left.generation === right.generation);

/** One opt-in schedule for this desktop workspace. The encrypted store and
 * transfer are injected so this never owns a second credential or upload path. */
export function createCompanyBackupSchedule({ store, scope, run, onState = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let record = null, revision = 0, timer = null, closed = false, started = false;
  let controller = null, operation = null, status = "off", message, needsClear = false;
  const snapshot = () => ({ enabled: Boolean(record) || needsClear, status, ...(record ? {
    nextBackupAt: record.nextBackupAt,
    ...(record.lastAttemptAt === undefined ? {} : { lastAttemptAt: record.lastAttemptAt }),
    ...(record.lastBackupAt === undefined ? {} : { lastBackupAt: record.lastBackupAt }),
  } : {}), ...(message ? { message } : {}) });
  const publish = (nextStatus, nextMessage) => { status = nextStatus; message = nextMessage; onState(snapshot()); return snapshot(); };
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const current = stamp => !closed && stamp === revision;
  const arm = () => {
    stopTimer();
    if (!closed && started && record && !operation) {
      // ponytail: one hourly retry, no missed-day queue or background OS job.
      const delay = scope() ? Math.max(1000, Math.min(DAY, record.nextBackupAt - now())) : RETRY;
      timer = setTimer(() => { timer = null; return tick().catch(() => {}); }, delay);
      timer?.unref?.();
    }
  };
  async function forget() {
    const stamp = ++revision;
    stopTimer(); controller?.abort(); record = null; needsClear = true;
    publish("paused", "Turning daily backups off.");
    try {
      await store.write(null);
      if (current(stamp)) { needsClear = false; publish("off"); }
    }
    catch {
      if (current(stamp)) publish("error", "The saved schedule could not be cleared. Unlock your system keychain and turn daily backups off again before restarting.");
      throw new Error("The saved daily backup schedule could not be cleared.");
    }
    return snapshot();
  }
  async function tick() {
    if (closed || !started || !record || operation) return;
    const currentScope = scope(), authority = currentScope ? { ...currentScope } : null;
    if (authority && authority.key !== record.scope) { await forget(); return; }
    if (!authority) { publish("paused", "Daily backups will resume when this local workspace and company connection are available."); arm(); return; }
    if (record.nextBackupAt > now()) { publish("waiting"); arm(); return; }
    const stamp = revision, abort = new AbortController();
    controller = abort;
    const active = record;
    // Reserve the retry before starting any work, including after a crash.
    active.nextBackupAt = now() + RETRY;
    active.lastAttemptAt = now();
    const work = (async () => {
      try {
        await store.write({ ...active });
        if (!current(stamp) || !sameScope(authority, scope())) return;
        abort.signal.throwIfAborted();
        publish("running");
        await run(active.password, abort.signal, authority);
        if (!current(stamp) || !sameScope(authority, scope())) return;
        abort.signal.throwIfAborted();
        const completed = { ...active, lastBackupAt: now(), nextBackupAt: now() + DAY };
        await store.write(completed);
        if (current(stamp)) { record = completed; publish("waiting"); }
      } catch (error) {
        if (!current(stamp)) return;
        publish(abort.signal.aborted || error?.code === "workspace_busy" ? "paused" : "error",
          abort.signal.aborted || error?.code === "workspace_busy"
            ? "Daily backup postponed. It will retry when the workspace is available."
            : "The daily backup did not complete. Check your connection, system keychain and free disk space; it will retry in an hour.");
      }
    })();
    operation = work;
    try { await work; }
    finally {
      if (operation === work) operation = null;
      if (controller === abort) controller = null;
      arm();
    }
  }
  return {
    state: snapshot,
    async start() {
      if (started || closed) return snapshot();
      started = true;
      const stamp = revision;
      try {
        const saved = await store.read();
        if (!current(stamp)) return snapshot();
        if (saved !== null) {
          if (!saved || saved.version !== 1 || typeof saved.scope !== "string" || saved.scope.length > 8192 ||
              typeof saved.password !== "string" || saved.password.length < 12 || saved.password.length > 1024 ||
              !validTime(saved.nextBackupAt) || (saved.lastAttemptAt !== undefined && !validTime(saved.lastAttemptAt)) ||
              (saved.lastBackupAt !== undefined && !validTime(saved.lastBackupAt))) throw new Error("Invalid schedule");
          record = { version: 1, scope: saved.scope, password: saved.password, nextBackupAt: Math.min(saved.nextBackupAt, now() + DAY),
            ...(saved.lastAttemptAt === undefined ? {} : { lastAttemptAt: saved.lastAttemptAt }),
            ...(saved.lastBackupAt === undefined ? {} : { lastBackupAt: saved.lastBackupAt }) };
        }
        publish(record ? "waiting" : "off");
        await tick();
      } catch {
        if (current(stamp)) { record = null; publish("error", "Daily backups could not be restored. Unlock your system keychain and enable them again."); }
      }
      return snapshot();
    },
    async configure(input) {
      if (closed) throw new Error("The desktop is shutting down.");
      if (input?.enabled === false && Object.keys(input).length === 1) return forget();
      if (needsClear) throw new Error("Finish turning daily backups off before enabling them again.");
      if (input?.enabled !== true || input.confirmation !== "BACK UP THIS WORKSPACE DAILY" ||
          typeof input.password !== "string" || input.password.length < 12 || input.password.length > 1024 ||
          Object.keys(input).some(key => !["enabled", "password", "confirmation"].includes(key))) throw new Error("Confirm daily backup of this entire workspace and use a password of 12 to 1,024 characters.");
      const currentScope = scope(), authority = currentScope ? { ...currentScope } : null;
      if (!authority) throw new Error("Connect your organisation in the local desktop before enabling daily backups.");
      const stamp = ++revision;
      stopTimer(); controller?.abort();
      record = { version: 1, scope: authority.key, password: input.password, nextBackupAt: now() + DAY };
      try {
        await store.write({ ...record });
        if (!current(stamp)) return snapshot();
        if (!sameScope(authority, scope())) { await forget(); throw new Error("The workspace connection changed."); }
        started = true; publish("waiting"); arm(); return snapshot();
      } catch (error) {
        if (current(stamp)) { record = null; publish("error", "Daily backups were not enabled. Unlock your system keychain and try again."); }
        throw error;
      }
    },
    forget,
    reconcile() {
      const authority = scope();
      if (!authority) controller?.abort();
      if (record && authority && record.scope !== authority.key) { void forget().catch(() => {}); return; }
      // Repeated connection refreshes cannot bring a persisted retry forward.
      arm();
    },
    close() { closed = true; revision++; stopTimer(); controller?.abort(); record = null; },
  };
}
