import { DurableObject } from "cloudflare:workers";
import { HttpError, json } from "./http";
import { requireMembership } from "./organizations";
import type { CodingRecord } from "./coding-types";
import { MISSION_LIMITS, isMissionId, missionCodingInput, missionRunId, missionTerminal, nextBudgetDay, parseMissionInput } from "./mission-types";
import type { MissionCodingRpc, MissionCommand, MissionEvidence, MissionRecord, MissionScope, MissionTask } from "./mission-types";

interface MissionEnv { DB: D1Database; CODING_RUNS: { getByName(name: string): MissionCodingRpc } }
interface Entry { mission: MissionRecord; fingerprint: string; cancelBy?: string; failures: number }
const key = (id: string) => `mission:${id}`;
const safeError = (error: unknown) => {
  const code = error instanceof HttpError ? error.code : error instanceof Error ? error.message : "";
  return /^(?:mission|budget|claude|coding|github|model|executor)_[a-z_]{1,80}$/.test(code) || ["not_found", "admin_required"].includes(code) ? code : "mission_result_unknown";
};
const paused = (status: MissionRecord["status"]) => ["paused", "paused_budget", "paused_subscription", "paused_authorization"].includes(status);
const authorizationError = (code: string) => ["not_found", "admin_required", "github_access_revoked", "github_owner_required"].includes(code);
const subscriptionError = (code: string) => code.startsWith("claude_") && !["claude_result_unknown", "claude_operation_timeout", "claude_cleanup_failed", "claude_cleanup_pending"].includes(code);
const waitingTask = (mission: MissionRecord) => mission.tasks.find(task => !["completed", "canceled"].includes(task.status));

/** One organization, bounded active queue and paginated history. No paid planner loop. */
export class MissionRoom extends DurableObject<MissionEnv> {
  #busy = false;

  async fetch(request: Request): Promise<Response> {
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MISSION_LIMITS.bodyBytes + 2048) throw new HttpError(413, "mission_input_limit");
      const command = JSON.parse(raw) as MissionCommand;
      return await this.ctx.blockConcurrencyWhile(async () => {
        // Expected authorization/CAS errors must not break the Durable Object's
        // input gate; the object must remain usable by the next valid request.
        try { return await this.command(command); }
        catch (error) { return this.errorResponse(error); }
      });
    } catch (error) {
      return this.errorResponse(error);
    }
  }

  private errorResponse(error: unknown) {
    const code = safeError(error);
    return json({ error: code }, error instanceof HttpError ? error.status : code === "mission_invalid_input" ? 400 : 503);
  }

  private async authorize(scope: MissionScope, admin: boolean) {
    if (![scope.organizationId, scope.workspaceId].every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id)) || typeof scope.userId !== "string") throw new HttpError(404, "not_found");
    const role = await requireMembership(this.env.DB, scope.organizationId, scope.userId, admin);
    if (!await this.env.DB.prepare("SELECT id FROM workspaces WHERE id=? AND organization_id=?").bind(scope.workspaceId, scope.organizationId).first()) throw new HttpError(404, "not_found");
    const organization = await this.ctx.storage.get<string>("organization");
    if (organization && organization !== scope.organizationId) throw new HttpError(404, "not_found");
    return role;
  }

  private async command(c: MissionCommand): Promise<Response> {
    if (!c || !c.body || typeof c.body !== "object" || !["create", "list", "get", "pause", "resume", "cancel"].includes(c.action)) throw new HttpError(400, "mission_invalid_input");
    const admin = !["list", "get"].includes(c.action);
    const role = await this.authorize(c, admin);
    if (c.action === "list") {
      const cursor = c.body.cursor;
      const prefix = `timeline:${c.workspaceId}:`;
      if (cursor !== undefined && (typeof cursor !== "string" || !cursor.startsWith(prefix) || !/^\d{13}:[a-f0-9-]{36}$/i.test(cursor.slice(prefix.length)))) throw new HttpError(400, "mission_invalid_input");
      const page = await this.ctx.storage.list<string>({ prefix, reverse: true, limit: 51, ...(cursor ? { end: cursor as string } : {}) });
      const indexes = [...page.entries()];
      const entries = await Promise.all(indexes.slice(0, 50).map(([, id]) => this.ctx.storage.get<Entry>(key(id))));
      return json({ missions: entries.filter((entry): entry is Entry => Boolean(entry && entry.mission.workspaceId === c.workspaceId)).map(entry => this.view(entry.mission, role !== "member")), nextCursor: indexes.length > 50 ? indexes[49][0] : null });
    }
    if (c.action === "create") {
      const input = parseMissionInput(c.body);
      const fingerprint = JSON.stringify(input);
      const known = await this.ctx.storage.get<Entry>(key(input.requestId));
      if (known) {
        if (known.fingerprint !== fingerprint || known.mission.createdBy !== c.userId || known.mission.workspaceId !== c.workspaceId) throw new HttpError(409, "mission_request_reused");
        return json({ mission: this.view(known.mission, true) });
      }
      const active = await this.ctx.storage.get<string[]>("active") ?? [];
      if (active.length >= MISSION_LIMITS.active) throw new HttpError(429, "mission_capacity");
      const now = Date.now();
      const tasks: MissionTask[] = await Promise.all(input.tasks.map(async (task, index) => ({ ...task, runId: await missionRunId(c, input.requestId, index, 1), attempt: 1, status: "queued" })));
      const mission: MissionRecord = { ...input, missionId: input.requestId, organizationId: c.organizationId, workspaceId: c.workspaceId, createdBy: c.userId, version: 1, status: "active", tasks, createdAt: now, updatedAt: now, nextWakeAt: now, deliveryEvidence: "not_observed" };
      await this.ctx.storage.transaction(async storage => {
        await storage.put({ organization: c.organizationId, [key(mission.missionId)]: { mission, fingerprint, failures: 0 } satisfies Entry, [`timeline:${c.workspaceId}:${now}:${mission.missionId}`]: mission.missionId, active: [...active, mission.missionId] });
        await storage.setAlarm(now + 100);
      });
      return json({ mission: this.view(mission, true) }, 201);
    }
    if (!isMissionId(c.missionId)) throw new HttpError(404, "not_found");
    const entry = await this.ctx.storage.get<Entry>(key(c.missionId));
    if (!entry || entry.mission.workspaceId !== c.workspaceId) throw new HttpError(404, "not_found");
    if (c.action === "get") return json({ mission: this.view(entry.mission, role !== "member") });
    if (c.body.expectedVersion !== entry.mission.version) throw new HttpError(409, "mission_state_changed");
    const mission = entry.mission;
    if (missionTerminal(mission.status)) throw new HttpError(409, "mission_state_changed");
    if (c.action === "pause") {
      if (mission.status === "canceling" || mission.status === "awaiting_delivery") throw new HttpError(409, "mission_state_changed");
      mission.status = "paused"; delete mission.nextWakeAt;
      if (waitingTask(mission)?.dispatchedAt && !waitingTask(mission)?.finishedAt) mission.nextWakeAt = Date.now();
    } else if (c.action === "cancel") {
      mission.status = "canceling"; mission.nextWakeAt = Date.now(); entry.cancelBy = c.userId;
    } else {
      if (!paused(mission.status) && mission.status !== "reconciling" && mission.status !== "interrupted") throw new HttpError(409, "mission_state_changed");
      if (c.body.modelSource !== undefined) {
        if (!mission.modelSource || mission.createdBy !== c.userId) throw new HttpError(403, "mission_subscription_owner_required");
        const task = waitingTask(mission);
        if (task?.dispatchedAt && !task.finishedAt) throw new HttpError(409, "mission_active_source_frozen");
        mission.modelSource = parseMissionInput({ ...mission, modelSource: c.body.modelSource }).modelSource;
      }
      await this.retryKnownFailure(entry);
      mission.status = "active"; mission.nextWakeAt = Date.now(); delete mission.error;
    }
    if (!await this.save(entry, mission.version)) throw new HttpError(409, "mission_state_changed");
    return json({ mission: this.view(mission, true) });
  }

  private view(mission: MissionRecord, admin: boolean) {
    return { ...mission, canPause: admin && ["active", "reconciling"].includes(mission.status), canResume: admin && (paused(mission.status) || ["reconciling", "interrupted"].includes(mission.status)), canCancel: admin && !missionTerminal(mission.status) && mission.status !== "canceling" };
  }

  private async save(entry: Entry, expectedVersion: number): Promise<boolean> {
    return this.ctx.storage.transaction(async storage => {
      const current = await storage.get<Entry>(key(entry.mission.missionId));
      if (!current || current.mission.version !== expectedVersion) return false;
      entry.mission.version = expectedVersion + 1; entry.mission.updatedAt = Date.now();
      await storage.put(key(entry.mission.missionId), entry);
      if (missionTerminal(entry.mission.status)) {
        const active = await storage.get<string[]>("active") ?? [];
        await storage.put("active", active.filter(id => id !== entry.mission.missionId));
      }
      await storage.setAlarm(Date.now() + 100);
      return true;
    });
  }

  async alarm(): Promise<void> {
    if (this.#busy) { await this.ctx.storage.setAlarm(Date.now() + MISSION_LIMITS.pollMs); return; }
    this.#busy = true;
    try {
      const active = await this.ctx.storage.get<string[]>("active") ?? [];
      for (const id of active) {
        const entry = await this.ctx.storage.get<Entry>(key(id));
        if (!entry || entry.mission.nextWakeAt === undefined || entry.mission.nextWakeAt > Date.now()) continue;
        await this.advance(entry); break;
      }
    } finally { this.#busy = false; await this.schedule(); }
  }

  private async schedule() {
    const active = await this.ctx.storage.get<string[]>("active") ?? [];
    const entries = await Promise.all(active.map(id => this.ctx.storage.get<Entry>(key(id))));
    const times = entries.flatMap(entry => entry?.mission.nextWakeAt !== undefined ? [entry.mission.nextWakeAt] : []);
    if (!times.length) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...times)));
  }

  private async retryKnownFailure(entry: Entry) {
    const mission = entry.mission, task = waitingTask(mission);
    if (!task || task.status !== "failed" || !task.evidence || task.evidence.status !== "failed" || task.evidence.pullRequest || !(task.error?.startsWith("budget_") || subscriptionError(task.error ?? ""))) return;
    if (task.attempt >= MISSION_LIMITS.attempts) throw new HttpError(409, "mission_attempt_limit");
    task.previousAttempts = [...task.previousAttempts ?? [], task.evidence];
    task.attempt++;
    task.runId = await missionRunId(mission, mission.missionId, mission.tasks.indexOf(task), task.attempt);
    task.status = "queued"; delete task.dispatchedAt; delete task.finishedAt; delete task.error; delete task.evidence;
  }

  private async advance(entry: Entry) {
    const mission = entry.mission;
    const scope = { organizationId: mission.organizationId, workspaceId: mission.workspaceId, userId: entry.cancelBy ?? mission.createdBy, missionId: mission.missionId };
    const rpc = this.env.CODING_RUNS.getByName(mission.organizationId);
    try {
      await this.authorize(scope, true);
      if (mission.status === "paused_budget") {
        await this.retryKnownFailure(entry);
        mission.status = "active"; delete mission.error;
        if (!await this.save(entry, mission.version)) return;
      }
      const task = waitingTask(mission);
      if (mission.status === "canceling") {
        if (task?.dispatchedAt) {
          // The adapter persists a tombstone even for an absent/in-flight run.
          const { run } = await rpc.cancelFromMission({ ...scope, runId: task.runId });
          const current = await this.ctx.storage.get<Entry>(key(mission.missionId));
          if (!current || current.mission.status !== "canceling") return;
          const currentTask = current.mission.tasks.find(item => item.runId === task.runId)!;
          if (run) currentTask.evidence = this.evidence(current.mission, currentTask, run);
          if (run && !["completed", "failed", "canceled", "interrupted"].includes(run.status)) { current.mission.nextWakeAt = Date.now() + MISSION_LIMITS.pollMs; await this.save(current, current.mission.version); return; }
          this.cancelRemaining(current); await this.save(current, current.mission.version); return;
        }
        this.cancelRemaining(entry); await this.save(entry, mission.version); return;
      }
      if (!task) {
        mission.status = mission.delivery === "merge_and_deploy" ? "awaiting_delivery" : "completed";
        mission.deliveryEvidence = mission.delivery === "merge_and_deploy" ? "project_adapter_required" : "pull_requests_verified";
        delete mission.nextWakeAt;
        if (mission.status === "completed") mission.finishedAt = Date.now();
        await this.save(entry, mission.version); return;
      }
      if (task.dispatchedAt) {
        const { run } = await rpc.getFromMission({ ...scope, runId: task.runId });
        if (run) {
          if (run.status === "pending_approval" && !paused(mission.status)) {
            // Idempotent adapter retries approval only; it never recreates the run.
            mission.nextWakeAt = Date.now() + MISSION_LIMITS.pollMs;
            if (!await this.save(entry, mission.version)) return;
            const latest = await rpc.createFromMission({ ...scope, input: missionCodingInput(mission, task) });
            await this.observe(mission.missionId, task.runId, latest.run); return;
          }
          await this.observe(mission.missionId, task.runId, run); return;
        }
      }
      if (paused(mission.status)) { delete mission.nextWakeAt; await this.save(entry, mission.version); return; }
      if (task.status === "interrupted" || task.status === "failed") {
        mission.status = "interrupted"; mission.error = task.error ?? "mission_result_unknown"; delete mission.nextWakeAt; await this.save(entry, mission.version); return;
      }
      task.status = "dispatching"; task.dispatchedAt ??= Date.now(); mission.nextWakeAt = Date.now() + MISSION_LIMITS.pollMs;
      if (!await this.save(entry, mission.version)) return;
      const { run } = await rpc.createFromMission({ ...scope, input: missionCodingInput(mission, task) });
      await this.observe(mission.missionId, task.runId, run);
    } catch (error) { await this.failure(mission.missionId, entry.mission.version, safeError(error)); }
  }

  private cancelRemaining(entry: Entry) {
    for (const task of entry.mission.tasks) if (task.status !== "completed") { task.status = "canceled"; task.finishedAt ??= Date.now(); }
    entry.mission.status = "canceled"; entry.mission.finishedAt = Date.now(); delete entry.mission.nextWakeAt;
  }

  private evidence(mission: MissionRecord, task: MissionTask, run: CodingRecord): MissionEvidence {
    if (run.organizationId !== mission.organizationId || run.workspaceId !== mission.workspaceId || run.missionId !== mission.missionId || run.runId !== task.runId || run.createdBy !== mission.createdBy || run.repositoryConnectionId !== mission.repositoryConnectionId) throw new Error("mission_evidence_scope_mismatch");
    let pullRequest: MissionEvidence["pullRequest"];
    if (run.result) {
      const url = new URL(run.result.prUrl);
      if (url.protocol !== "https:" || url.host !== "github.com" || url.username || url.password || url.search || url.hash || !/^[\w.-]+\/[\w.-]+$/.test(run.repositoryName) || !Number.isSafeInteger(run.result.prNumber) || run.result.prNumber < 1 || url.pathname !== `/${run.repositoryName}/pull/${run.result.prNumber}` || !/^[a-f0-9]{40}$/.test(run.result.commitSha)) throw new Error("mission_evidence_invalid");
      pullRequest = { url: url.href, number: run.result.prNumber, commitSha: run.result.commitSha, branch: run.result.branch };
    }
    const test = run.verification && run.verification.command === mission.testCommand && /^[a-f0-9]{64}$/.test(run.verification.treeDigest) ? { exitCode: run.verification.exitCode, treeDigest: run.verification.treeDigest, finishedAt: run.verification.finishedAt } : undefined;
    return { runId: run.runId, generation: run.generation, runUpdatedAt: run.updatedAt, observedAt: Date.now(), status: run.status, reviewApproved: run.review?.approved === true, ...(pullRequest ? { pullRequest } : {}), ...(test ? { test } : {}), ...(run.error ? { error: run.error } : {}) };
  }

  private async observe(missionId: string, runId: string, run: CodingRecord) {
    const entry = await this.ctx.storage.get<Entry>(key(missionId));
    if (!entry) return;
    const mission = entry.mission, task = mission.tasks.find(item => item.runId === runId);
    if (!task) return;
    if (task.evidence && (run.generation < task.evidence.generation || run.generation === task.evidence.generation && run.updatedAt < task.evidence.runUpdatedAt)) return;
    const evidence = this.evidence(mission, task, run);
    // Late receipts remain facts, even after a pause/cancellation. They cannot
    // reactivate a mission or dispatch its next task.
    task.evidence = evidence; entry.failures = 0;
    if (["canceling", "canceled"].includes(mission.status)) { await this.save(entry, mission.version); return; }
    if (run.status === "completed") {
      if (!evidence.pullRequest || evidence.test?.exitCode !== 0 || !evidence.reviewApproved) {
        mission.status = "interrupted"; task.status = "interrupted"; mission.error = task.error = "mission_evidence_incomplete"; delete mission.nextWakeAt;
      } else {
        task.status = "completed"; task.finishedAt = run.finishedAt ?? Date.now(); delete task.error;
        if (paused(mission.status)) delete mission.nextWakeAt;
        else if (mission.delivery === "merge_and_deploy") { mission.status = "awaiting_delivery"; mission.deliveryEvidence = "project_adapter_required"; delete mission.nextWakeAt; }
        else { mission.status = "active"; mission.nextWakeAt = Date.now() + 100; }
      }
    } else if (["failed", "canceled", "interrupted"].includes(run.status)) {
      task.status = run.status === "canceled" ? "canceled" : run.status === "failed" ? "failed" : "interrupted";
      task.finishedAt = run.finishedAt ?? Date.now(); task.error = run.error ?? `coding_${run.status}`;
      const manuallyPaused = mission.status === "paused";
      this.applyFailure(entry, task.error, run.status === "interrupted" || Boolean(evidence.pullRequest));
      if (manuallyPaused) { mission.status = "paused"; delete mission.nextWakeAt; }
    } else {
      task.status = "running"; mission.nextWakeAt = Date.now() + MISSION_LIMITS.pollMs;
      if (!paused(mission.status)) mission.status = "active";
    }
    await this.save(entry, mission.version);
  }

  private applyFailure(entry: Entry, code: string, uncertain = false) {
    const mission = entry.mission;
    mission.error = code;
    if (uncertain || /(?:unknown|uncertain|scope_mismatch|evidence_invalid)$/.test(code)) { mission.status = "interrupted"; delete mission.nextWakeAt; }
    else if (authorizationError(code)) { mission.status = "paused_authorization"; delete mission.nextWakeAt; }
    else if (code.startsWith("budget_")) { mission.status = "paused_budget"; mission.nextWakeAt = code === "budget_exhausted" ? nextBudgetDay(Date.now()) : undefined; }
    else if (subscriptionError(code)) { mission.status = "paused_subscription"; delete mission.nextWakeAt; }
    else if (code === "coding_capacity") { mission.status = "active"; mission.nextWakeAt = Date.now() + MISSION_LIMITS.pollMs; }
    else { mission.status = "failed"; mission.finishedAt = Date.now(); delete mission.nextWakeAt; }
  }

  private async failure(missionId: string, version: number, code: string) {
    const entry = await this.ctx.storage.get<Entry>(key(missionId));
    if (!entry || entry.mission.version !== version) return;
    const mission = entry.mission;
    if (code === "mission_result_unknown" || mission.status === "canceling") {
      if (mission.status !== "canceling") mission.status = "reconciling";
      mission.error = code; entry.failures++;
      mission.nextWakeAt = Date.now() + Math.min(300_000, MISSION_LIMITS.pollMs * 2 ** Math.min(entry.failures - 1, 4));
    } else this.applyFailure(entry, code);
    await this.save(entry, mission.version);
  }
}
