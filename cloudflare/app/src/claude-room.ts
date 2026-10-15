import { DurableObject } from "cloudflare:workers";
import { requireMembership } from "./organizations";
import { HttpError } from "./http";
import { ClaudeNativeRuntime, type ClaudeNativeLogin } from "./claude-runtime";
import { claudeFingerprint, claudeId, claudeLoginCode, validateClaudeInput } from "./claude-program";
import { CLAUDE_CLI_VERSION, CLAUDE_LIMITS, type ClaudeConnectionStatus, type ClaudeConnectionState, type ClaudeIdentity, type ClaudeLoginInput, type ClaudeFlowInput, type ClaudeVersionInput, type ClaudeInferenceInput, type ClaudeInferenceResult, type ClaudeAuthMethod } from "./claude-types";

interface ClaudeEnv { DB: D1Database; CLAUDE_CODE_ENABLED?: string }
interface Operation { id: string; kind: "login" | "inference"; deadlineAt: number; runId?: string; stepId?: string }
interface Connection extends ClaudeIdentity {
  version: number; state: ClaudeConnectionState; dirty?: Operation; cleanupPending?: boolean;
  checkpoint?: { handle: ContainerSnapshot; image: string; savedAt: number };
  flow?: { id: string; expiresAt: number; codeSubmitted: boolean };
  lastLogin?: { requestId: string; fingerprint: string; flowId: string; version: number };
  lastVerifiedAt?: number; error?: string; authMethod?: ClaudeAuthMethod;
  canceledSteps?: string[];
}
interface Receipt { fingerprint: string; result: ClaudeInferenceResult; expiresAt: number }
const safeError = (error: unknown) => error instanceof Error && /^claude_[a-z_]{1,64}$/.test(error.message) ? error.message : "claude_operation_failed";

/** A private, trusted CLI environment per company/user. Snapshot handles never leave this DO. */
export class ClaudeConnectionRoom extends DurableObject<ClaudeEnv> {
  #controllers = new Map<string, { version: number; abort: AbortController }>();
  #shutdown?: Promise<void>;
  #logins = new Map<string, { version: number; native: ClaudeNativeLogin; url?: string; task: Promise<void> }>();
  constructor(ctx: DurableObjectState, env: ClaudeEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const current = await ctx.storage.get<Connection>("connection");
      if (!current) return;
      if (current.dirty) {
        // A previous process may have refreshed auth or paid for inference. Never restore/replay it.
        await ctx.storage.put("connection", { ...current, version: current.version + 1, state: "reconnect_required", dirty: undefined, checkpoint: undefined, flow: undefined, cleanupPending: true, error: "claude_result_unknown" } satisfies Connection);
      }
      if (current.dirty || current.cleanupPending) { await ctx.storage.setAlarm(Date.now() + 1000); await this.#destroy().catch(() => {}); }
    });
  }
  async status(input: ClaudeIdentity): Promise<ClaudeConnectionStatus> {
    await this.#authorize(input); return this.#view(await this.#load());
  }
  async startLogin(input: ClaudeLoginInput): Promise<ClaudeConnectionStatus> {
    await this.#authorize(input, true); this.#version(input.expectedVersion);
    if (!claudeId(input.requestId)) throw new Error("claude_invalid_input");
    const digest = await claudeFingerprint({ organizationId: input.organizationId, userId: input.userId, requestId: input.requestId, expectedVersion: input.expectedVersion });
    const claimed = await this.ctx.storage.transaction(async storage => {
      const current = await storage.get<Connection>("connection");
      if (current?.lastLogin?.requestId === input.requestId) {
        if (current.lastLogin.fingerprint !== digest) throw new Error("claude_request_reused");
        if (current.lastLogin.version !== current.version) throw new Error("claude_connection_changed");
        return { current, replay: true };
      }
      if ((current?.version ?? 0) !== input.expectedVersion) throw new Error("claude_connection_changed");
      if (current?.cleanupPending) throw new Error("claude_cleanup_pending");
      if (current?.dirty || current?.state === "connected") throw new Error("claude_connection_busy");
      const version = input.expectedVersion + 1, flowId = crypto.randomUUID(), expiresAt = Date.now() + CLAUDE_LIMITS.loginMs;
      const next: Connection = { organizationId: input.organizationId, userId: input.userId, version, state: "connecting",
        dirty: { id: flowId, kind: "login", deadlineAt: expiresAt }, flow: { id: flowId, expiresAt, codeSubmitted: false },
        lastLogin: { requestId: input.requestId, fingerprint: digest, flowId, version } };
      await storage.put("connection", next); await storage.setAlarm(expiresAt); return { current: next, replay: false };
    });
    if (claimed.replay) return this.#view(claimed.current);
    const current = claimed.current, operation = current.dirty!, abort = new AbortController(); this.#controllers.set(operation.id, { version: current.version, abort });
    try {
      const runtime = this.#runtime();
      await this.#bounded((async () => {
        await this.#assertActive(current, operation, abort.signal);
        await runtime.start(undefined, abort.signal); await this.#assertActive(current, operation, abort.signal);
        const native = await runtime.login(abort.signal); await this.#assertActive(current, operation, abort.signal);
        const task = this.#finishLogin(current, operation, native, runtime, abort);
        this.#logins.set(operation.id, { version: current.version, native, task });
        this.ctx.waitUntil(task.catch(() => {}));
        const url = await native.url; await this.#assertActive(current, operation, abort.signal);
        const login = this.#logins.get(operation.id); if (login) login.url = url;
      })(), Date.now() + CLAUDE_LIMITS.startupMs, abort);
      return this.#view(await this.#load());
    } catch (error) { await this.#fail(current, operation, error); abort.abort(); this.#controllers.delete(operation.id); throw new Error(safeError(error)); }
  }
  async completeLogin(input: ClaudeFlowInput & { code: string }): Promise<ClaudeConnectionStatus> {
    await this.#authorize(input, true); this.#version(input.expectedVersion); const code = claudeLoginCode(input.code);
    const current = await this.ctx.storage.transaction(async storage => {
      const current = await storage.get<Connection>("connection");
      if (!current || current.version !== input.expectedVersion) throw new Error("claude_connection_changed");
      if (current.state === "connected" && current.lastLogin?.flowId === input.flowId) return current;
      if (current.state !== "connecting" || current.flow?.id !== input.flowId || Date.now() >= current.flow.expiresAt || this.#logins.get(input.flowId)?.version !== current.version) throw new Error("claude_login_unavailable");
      if (current.flow.codeSubmitted) throw new Error("claude_code_already_sent");
      current.flow.codeSubmitted = true; await storage.put("connection", current); return current;
    });
    if (current.state === "connected") return this.#view(current);
    const login = this.#logins.get(input.flowId)!;
    try { await login.native.submit(code); await login.task; return this.status(input); }
    catch (error) { await this.#fail(current, current.dirty!, error); throw new Error(safeError(error)); }
  }
  async cancelLogin(input: ClaudeFlowInput): Promise<ClaudeConnectionStatus> {
    await this.#authorize(input); const current = await this.#load(); this.#version(input.expectedVersion);
    if (!current || current.version !== input.expectedVersion) throw new Error("claude_connection_changed");
    if (current.flow?.id !== input.flowId) throw new Error("claude_login_unavailable");
    return this.logout(input);
  }
  async logout(input: ClaudeVersionInput): Promise<ClaudeConnectionStatus> {
    await this.#authorize(input); this.#version(input.expectedVersion);
    const previous = await this.ctx.storage.transaction(async storage => {
      const current = await storage.get<Connection>("connection");
      if (current?.version === input.expectedVersion + 1 && current.state === "disconnected" && !current.cleanupPending) return null;
      if ((current?.version ?? 0) !== input.expectedVersion) throw new Error("claude_connection_changed");
      const next: Connection = { organizationId: input.organizationId, userId: input.userId, version: input.expectedVersion + 1, state: "disconnecting", cleanupPending: true };
      // This tombstone precedes all process I/O. No prior snapshot can be restored again.
      await storage.put("connection", next); await storage.setAlarm(Date.now() + 3000); return current;
    });
    if (previous === null) return this.#view(await this.#load());
    for (const [id, controller] of this.#controllers) if (controller.version <= input.expectedVersion) { controller.abort.abort(); this.#controllers.delete(id); this.#logins.delete(id); }
    // Never restore an old environment just to log out. An active process is destroyed first.
    if (!previous?.dirty && this.ctx.container?.running) {
      const abort = new AbortController();
      await this.#bounded(this.#runtime().logout(abort.signal), Date.now() + 8000, abort).catch(() => {});
    }
    await this.#destroy(); return this.#view(await this.#load());
  }
  async infer(input: ClaudeInferenceInput): Promise<ClaudeInferenceResult> {
    await this.#authorize(input, true); validateClaudeInput(input);
    const digest = await claudeFingerprint(input), receiptKey = `receipt:${input.connectionVersion}:${input.runId}:${input.stepId}`;
    const claimed = await this.ctx.storage.transaction(async storage => {
      const current = await storage.get<Connection>("connection");
      if (!current || current.version !== input.connectionVersion) throw new Error("claude_connection_changed");
      if (current.canceledSteps?.includes(`${input.runId}:${input.stepId}`)) throw new Error("claude_operation_canceled");
      if (current.state !== "connected") throw new Error("claude_reconnect_required");
      const receipt = await storage.get<Receipt>(receiptKey);
      if (receipt) { if (receipt.fingerprint !== digest) throw new Error("claude_step_reused"); return { receipt, current }; }
      if (current.cleanupPending) throw new Error("claude_cleanup_pending");
      if (current.dirty) throw new Error("claude_connection_busy");
      const receipts = await storage.list<Receipt>({ prefix: "receipt:", limit: CLAUDE_LIMITS.receipts + 1 });
      const expired = Array.from(receipts).filter(([, receipt]) => receipt.expiresAt <= Date.now()).map(([key]) => key);
      if (expired.length) await storage.delete(expired);
      if (receipts.size - expired.length >= CLAUDE_LIMITS.receipts) throw new Error("claude_receipt_limit");
      const operation: Operation = { id: crypto.randomUUID(), kind: "inference", deadlineAt: Math.min(input.deadlineAt, Date.now() + CLAUDE_LIMITS.inferenceMs), runId: input.runId, stepId: input.stepId };
      await storage.put("connection", { ...current, dirty: operation }); await storage.setAlarm(operation.deadlineAt);
      return { current: { ...current, dirty: operation }, receipt: undefined };
    });
    if (claimed.receipt) return claimed.receipt.result;
    const current = claimed.current, operation = current.dirty!, abort = new AbortController(); this.#controllers.set(operation.id, { version: current.version, abort });
    try {
      return await this.#bounded((async () => {
        await this.#assertActive(current, operation, abort.signal);
        const checkpoint = current.checkpoint;
        if (!checkpoint || checkpoint.image !== this.ctx.container?.images.claude || checkpoint.savedAt + CLAUDE_LIMITS.snapshotTtlMs <= Date.now()) throw new Error("claude_reconnect_required");
        const runtime = this.#runtime(); await runtime.start(this.ctx.container?.running ? undefined : checkpoint.handle, abort.signal);
        await this.#assertActive(current, operation, abort.signal);
        const auth = await runtime.authStatus(abort.signal); if (!auth.authenticated) throw new Error("claude_reconnect_required");
        if (auth.authMethod !== "claude.ai") throw new Error("claude_auth_method_unsupported");
        await this.#assertActive(current, operation, abort.signal);
        const result = await runtime.infer(input, abort.signal); await this.#assertActive(current, operation, abort.signal);
        const handle = await runtime.snapshot(abort.signal); await this.#assertActive(current, operation, abort.signal);
        await this.ctx.storage.transaction(async storage => {
          const latest = await storage.get<Connection>("connection"); this.#sameOperation(latest, current, operation, abort.signal);
          await storage.put({ connection: { ...latest!, dirty: undefined, checkpoint: { handle, image: this.ctx.container!.images.claude, savedAt: Date.now() }, lastVerifiedAt: Date.now(), authMethod: auth.authMethod },
            [receiptKey]: { fingerprint: digest, result, expiresAt: Date.now() + CLAUDE_LIMITS.receiptTtlMs } satisfies Receipt });
          await storage.setAlarm(Date.now() + CLAUDE_LIMITS.idleMs);
        });
        return result;
      })(), operation.deadlineAt, abort);
    } catch (error) { await this.#fail(current, operation, error); if (error instanceof HttpError) throw error; throw new Error(safeError(error)); }
    finally { this.#controllers.delete(operation.id); }
  }
  async cancelInference(input: ClaudeIdentity & { connectionVersion: number; runId: string; stepId: string }): Promise<void> {
    await this.#authorize(input);
    this.#version(input.connectionVersion);
    if (!claudeId(input.runId) || !claudeId(input.stepId)) throw new Error("claude_invalid_input");
    const canceled = await this.ctx.storage.transaction(async storage => {
      const current = await storage.get<Connection>("connection");
      if (!current || current.version !== input.connectionVersion) return undefined;
      const key = `${input.runId}:${input.stepId}`, canceledSteps = current.canceledSteps ?? [];
      if (!canceledSteps.includes(key)) {
        if (canceledSteps.length >= CLAUDE_LIMITS.receipts) return { current, full: true };
        // Same transaction boundary as inference claim; includes pre-dispatch cancellations.
        await storage.put("connection", { ...current, canceledSteps: [...canceledSteps, key] });
      }
      return { current, full: false };
    });
    if (!canceled) return;
    // Never expire a cancellation while its connection generation can still execute.
    // At the bounded ledger limit, revoke that generation rather than forget a tombstone.
    if (canceled.full) { await this.logout({ ...input, expectedVersion: input.connectionVersion }); return; }
    const current = canceled.current;
    const operation = current.dirty;
    if (!operation || operation.kind !== "inference" || operation.runId !== input.runId || operation.stepId !== input.stepId) return;
    await this.#fail(current, operation, new Error("claude_operation_canceled"));
  }
  async alarm(): Promise<void> {
    const current = await this.#load(); if (!current) return;
    if (current.cleanupPending) { await this.#destroy().catch(() => {}); return; }
    if (current.dirty) {
      if (current.dirty.deadlineAt <= Date.now()) await this.#fail(current, current.dirty, new Error("claude_operation_timeout")).catch(() => {});
      else await this.ctx.storage.setAlarm(current.dirty.deadlineAt);
      return;
    }
    await this.ctx.storage.transaction(async storage => {
      const latest = await storage.get<Connection>("connection");
      if (latest && !latest.dirty) { await storage.put("connection", { ...latest, cleanupPending: true }); await storage.setAlarm(Date.now() + 3000); }
    });
    const latest = await this.#load(); if (latest?.cleanupPending) await this.#destroy().catch(() => {});
  }
  async #finishLogin(current: Connection, operation: Operation, native: ClaudeNativeLogin, runtime: ClaudeNativeRuntime, abort: AbortController) {
    try {
      await this.#bounded((async () => {
        const exitCode = await native.done; await this.#assertActive(current, operation, abort.signal);
        const auth = await runtime.authStatus(abort.signal); if (exitCode !== 0 || !auth.authenticated) throw new Error("claude_login_failed");
        await this.#assertActive(current, operation, abort.signal);
        const handle = await runtime.snapshot(abort.signal); await this.#assertActive(current, operation, abort.signal);
        await this.ctx.storage.transaction(async storage => {
          const latest = await storage.get<Connection>("connection"); this.#sameOperation(latest, current, operation, abort.signal);
          await storage.put("connection", { ...latest!, state: "connected", dirty: undefined, flow: undefined,
            checkpoint: { handle, image: this.ctx.container!.images.claude, savedAt: Date.now() }, lastVerifiedAt: Date.now(), authMethod: auth.authMethod });
          await storage.setAlarm(Date.now() + CLAUDE_LIMITS.idleMs);
        });
      })(), operation.deadlineAt, abort);
    } catch (error) { await this.#fail(current, operation, error); throw new Error(safeError(error)); }
    finally { this.#logins.delete(operation.id); this.#controllers.delete(operation.id); }
  }
  async #fail(current: Connection, operation: Operation, error: unknown): Promise<void> {
    const changed = await this.ctx.storage.transaction(async storage => {
      const latest = await storage.get<Connection>("connection");
      if (latest?.version !== current.version || latest.dirty?.id !== operation.id) return false;
      await storage.put("connection", { ...latest, version: latest.version + 1, state: "reconnect_required", dirty: undefined, checkpoint: undefined, flow: undefined, cleanupPending: true, error: safeError(error) });
      await storage.setAlarm(Date.now() + 3000); return true;
    });
    if (!changed) return;
    this.#controllers.get(operation.id)?.abort.abort(); this.#controllers.delete(operation.id); this.#logins.delete(operation.id); await this.#destroy();
  }
  async #destroy(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    const work = this.#destroyOnce(); this.#shutdown = work;
    try { await work; } finally { if (this.#shutdown === work) this.#shutdown = undefined; }
  }
  async #destroyOnce(): Promise<void> {
    try {
      const before = await this.#load();
      if (!before?.cleanupPending) return;
      const abort = new AbortController();
      await this.#bounded(this.ctx.container?.destroy() ?? Promise.resolve(), Date.now() + 10_000, abort);
      if (this.ctx.container?.running) throw new Error("claude_cleanup_failed");
      await this.ctx.storage.transaction(async storage => {
        const current = await storage.get<Connection>("connection");
        if (!current?.cleanupPending || current.version !== before.version) return;
        await storage.put("connection", { ...current, cleanupPending: false, state: current.state === "disconnecting" ? "disconnected" : current.state }); await storage.deleteAlarm();
      });
    } catch { await this.ctx.storage.setAlarm(Date.now() + 3000); throw new Error("claude_cleanup_failed"); }
  }
  async #authorize(input: ClaudeIdentity, enabled = false): Promise<void> {
    if (!claudeId(input.organizationId) || !claudeId(input.userId)) throw new Error("claude_invalid_input");
    await requireMembership(this.env.DB, input.organizationId, input.userId);
    const current = await this.#load();
    if (current && (current.organizationId !== input.organizationId || current.userId !== input.userId)) throw new Error("claude_identity_mismatch");
    if (enabled && this.env.CLAUDE_CODE_ENABLED !== "true") throw new Error("claude_not_enabled");
  }
  async #assertActive(current: Connection, operation: Operation, signal: AbortSignal): Promise<void> {
    this.#sameOperation(await this.#load(), current, operation, signal);
    await this.#authorize(current, true);
    this.#sameOperation(await this.#load(), current, operation, signal);
  }
  #sameOperation(latest: Connection | undefined, current: Connection, operation: Operation, signal: AbortSignal) {
    if (signal.aborted || latest?.version !== current.version || latest.dirty?.id !== operation.id) throw new Error("claude_operation_canceled");
    if (Date.now() >= operation.deadlineAt) throw new Error("claude_operation_timeout");
  }
  #load() { return this.ctx.storage.get<Connection>("connection"); }
  #runtime() { if (!this.ctx.container?.images.claude) throw new Error("claude_not_configured"); return new ClaudeNativeRuntime(this.ctx.container); }
  #version(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new Error("claude_invalid_input"); }
  #view(current: Connection | undefined): ClaudeConnectionStatus {
    return { enabled: this.env.CLAUDE_CODE_ENABLED === "true", connectionVersion: current?.version ?? 0, state: current?.state ?? "disconnected",
      cliVersion: CLAUDE_CLI_VERSION, busy: !!current?.dirty || !!current?.cleanupPending, lastVerifiedAt: current?.lastVerifiedAt,
      ...(current?.authMethod ? { authMethod: current.authMethod } : {}),
      ...(current?.flow ? { flow: { ...current.flow, ...(this.#logins.get(current.flow.id)?.url ? { authorizationUrl: this.#logins.get(current.flow.id)!.url } : {}) } } : {}),
      ...(current?.error ? { error: current.error } : {}), persistence: "native_snapshot", snapshotRetentionDays: 30 };
  }
  async #bounded<T>(work: Promise<T>, deadlineAt: number, abort: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let canceled!: () => void;
    const timeout = new Promise<never>((_, reject) => {
      canceled = () => reject(new Error("claude_operation_canceled"));
      abort.signal.addEventListener("abort", canceled, { once: true });
      if (abort.signal.aborted) canceled();
      timer = setTimeout(() => { reject(new Error("claude_operation_timeout")); abort.abort(); }, Math.max(1, deadlineAt - Date.now()));
    });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); abort.signal.removeEventListener("abort", canceled); }
  }
}
