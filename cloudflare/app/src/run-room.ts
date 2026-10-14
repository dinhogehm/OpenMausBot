import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import { approveRun, cancelRun, completeRun, createRun, interruptRun, type RunRecord } from "./execution";
import { HttpError, json } from "./http";
import { requireMembership, type MemberRole } from "./organizations";

interface StoredRun { run: RunRecord; createdBy: string; approvedBy?: string; dispatched: boolean }
interface Command {
  organizationId: string; workspaceId: string; userId: string;
  action: "list" | "create" | "get" | "approve" | "cancel";
  runId?: string; body: Record<string, unknown>;
}

function view(entry: StoredRun, userId: string, role: MemberRole) {
  return { ...entry.run,
    canApprove: role !== "member" && entry.run.status === "waiting_approval",
    canCancel: (role !== "member" || entry.createdBy === userId) && ["waiting_approval", "running", "interrupted"].includes(entry.run.status),
  };
}

export function executorName(run: RunRecord): string {
  return `${run.organizationId}/${run.workspaceId}/${run.id}/${run.generation}`;
}

/** One coordinator per organization. No public route accepts executor callbacks. */
export class ExecutionRoom extends DurableObject<AppEnv> {
  async fetch(request: Request): Promise<Response> {
    const command = await request.json() as Command;
    return this.ctx.blockConcurrencyWhile(async () => {
      try { return await this.command(command); }
      catch (error) {
        // Expected request errors must not escape the input gate and reset the object.
        return json({ error: error instanceof HttpError ? error.code : "service_unavailable" }, error instanceof HttpError ? error.status : 503);
      }
    });
  }

  private async command(command: Command): Promise<Response> {
    const { organizationId, workspaceId, userId, action, body } = command;
    const role = await requireMembership(this.env.DB, organizationId, userId, action === "approve");
    const workspace = await this.env.DB.prepare("SELECT id FROM workspaces WHERE id = ? AND organization_id = ?").bind(workspaceId, organizationId).first();
    if (!workspace) throw new HttpError(404, "not_found");
    const scope = await this.ctx.storage.get<string>("organization");
    if (scope && scope !== organizationId) throw new HttpError(404, "not_found");
    if (!scope) await this.ctx.storage.put("organization", organizationId);
    if (action === "list") {
      const rows = await this.ctx.storage.list<StoredRun>({ prefix: "run:", limit: 100 });
      const runs: ReturnType<typeof view>[] = [];
      for (const entry of rows.values()) {
        if (entry.run.workspaceId === workspaceId) runs.push(view(await this.expire(entry), userId, role));
      }
      return json({ runs: runs.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)) });
    }
    if (action === "create") {
      if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId)) throw new HttpError(400, "invalid_request_id");
      if (typeof body.message !== "string" || !body.message.isWellFormed() || !Number.isSafeInteger(body.delayMs ?? 0)) throw new HttpError(400, "invalid_run");
      let run: RunRecord;
      try { run = createRun(body.requestId, organizationId, workspaceId, { message: body.message as string, delayMs: (body.delayMs ?? 0) as number }, Date.now()); }
      catch { throw new HttpError(400, "invalid_run"); }
      const existing = await this.ctx.storage.get<StoredRun>(`run:${run.id}`);
      if (existing) {
        if (existing.run.workspaceId !== workspaceId || existing.createdBy !== userId || existing.run.input.message !== run.input.message || existing.run.input.delayMs !== run.input.delayMs) throw new HttpError(409, "request_id_reused");
        return json({ run: view(await this.expire(existing), userId, role) });
      }
      const count = await this.ctx.storage.get<number>("count") ?? 0;
      if (count >= 100) throw new HttpError(429, "run_history_limit");
      const entry = { run, createdBy: userId, dispatched: false } satisfies StoredRun;
      await this.ctx.storage.put({ [`run:${run.id}`]: entry, count: count + 1 });
      return json({ run: view(entry, userId, role) }, 201);
    }
    const stored = await this.ctx.storage.get<StoredRun>(`run:${command.runId}`);
    if (!stored || stored.run.workspaceId !== workspaceId) throw new HttpError(404, "not_found");
    const entry = await this.expire(stored);
    if (action === "get") return json({ run: view(entry, userId, role) });
    if (action === "approve") {
      if (entry.run.status !== "waiting_approval") throw new HttpError(409, "run_state_changed");
      const run = approveRun(entry.run, Date.now());
      const admitted = await this.env.ADMISSION.getByName("global").acquire(executorName(run), organizationId, run.leaseExpiresAt!);
      if (!admitted) throw new HttpError(429, "execution_capacity");
      entry.run = run;
      entry.approvedBy = userId;
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put({ [`run:${run.id}`]: entry, active: run.id });
        await txn.setAlarm(Date.now());
      });
      return json({ run: view(entry, userId, role) });
    }
    if (action === "cancel") {
      if (role === "member" && entry.createdBy !== userId) throw new HttpError(403, "admin_required");
      const previous = entry.run;
      entry.run = cancelRun(previous, Date.now());
      await this.save(entry);
      if (previous.status === "running") {
        // The tombstone in the executor prevents a delayed dispatch from starting.
        // Keep the admission lease if stop cannot be confirmed.
        this.ctx.waitUntil(this.env.LINUX_EXECUTORS.getByName(executorName(previous)).stop().then(
          () => this.env.ADMISSION.getByName("global").release(executorName(previous)),
          () => undefined,
        ));
      }
      return json({ run: view(entry, userId, role) });
    }
    throw new HttpError(404, "not_found");
  }

  private async save(entry: StoredRun) { await this.ctx.storage.put(`run:${entry.run.id}`, entry); }
  private stopAttempt(run: RunRecord): void {
    this.ctx.waitUntil(this.env.LINUX_EXECUTORS.getByName(executorName(run)).stop().then(
      () => this.env.ADMISSION.getByName("global").release(executorName(run)),
      () => undefined,
    ));
  }
  private async expire(entry: StoredRun): Promise<StoredRun> {
    if (entry.run.status === "running" && entry.run.leaseExpiresAt! <= Date.now()) {
      const expired = entry.run;
      entry.run = interruptRun(entry.run, Date.now());
      await this.save(entry);
      this.stopAttempt(expired);
    }
    return entry;
  }

  async alarm(): Promise<void> {
    const attempt = await this.ctx.blockConcurrencyWhile(async () => {
      const id = await this.ctx.storage.get<string>("active");
      if (!id) return;
      const stored = await this.ctx.storage.get<StoredRun>(`run:${id}`);
      if (!stored) return;
      const entry = await this.expire(stored);
      if (entry.run.status !== "running") return;
      if (entry.dispatched) {
        // An earlier alarm may have dispatched before the process disappeared.
        // There is no proof that replaying would be safe.
        const abandoned = entry.run;
        entry.run = interruptRun(entry.run, Date.now());
        await this.save(entry);
        this.stopAttempt(abandoned);
        return;
      }
      try {
        await requireMembership(this.env.DB, entry.run.organizationId, entry.approvedBy!, true);
        await requireMembership(this.env.DB, entry.run.organizationId, entry.createdBy);
      } catch {
        const revoked = entry.run;
        entry.run = cancelRun(entry.run, Date.now());
        await this.save(entry);
        this.stopAttempt(revoked);
        return;
      }
      entry.dispatched = true;
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put(`run:${entry.run.id}`, entry);
        await txn.setAlarm(entry.run.leaseExpiresAt!);
      });
      return entry.run;
    });
    if (!attempt) return;
    const executor = this.env.LINUX_EXECUTORS.getByName(executorName(attempt));
    try {
      const result = await executor.execute({ runId: attempt.id, organizationId: attempt.organizationId, workspaceId: attempt.workspaceId,
        generation: attempt.generation, deadlineAt: attempt.leaseExpiresAt!, ...attempt.input });
      await this.ctx.blockConcurrencyWhile(async () => {
        const entry = await this.ctx.storage.get<StoredRun>(`run:${attempt.id}`);
        if (!entry) return;
        if (result.exitCode === 0 && result.artifact !== attempt.input.message) result.exitCode = 1;
        entry.run = completeRun(entry.run, attempt.generation, result, Date.now());
        await this.save(entry);
      });
    } catch {
      await this.ctx.blockConcurrencyWhile(async () => {
        const entry = await this.ctx.storage.get<StoredRun>(`run:${attempt.id}`);
        if (entry?.run.status === "running" && entry.run.generation === attempt.generation) {
          entry.run = interruptRun(entry.run, Date.now());
          await this.save(entry);
        }
      });
    } finally {
      // Release only after the adapter confirms the container is stopped.
      try { await executor.stop(); await this.env.ADMISSION.getByName("global").release(executorName(attempt)); } catch { /* lease expires */ }
    }
  }
}
