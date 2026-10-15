import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import { HttpError, json } from "./http";
import { requireMembership } from "./organizations";
import { authorizeRepository, prepareRepository, publishRepository, reconcileRepositoryPublication } from "./github";
import { resolveAgents } from "./agent-profiles";
import { appendToolResult, buildModelRequest, callModel, credentialVersion, type ModelCall, type ModelItem } from "./model-broker";
import { codingExecutorName, codingTerminal, codingView, parseCodingInput } from "./coding-state";
import { confirmedCodingStop } from "./coding-admission";
import { CODING_LIMITS, codingTreeDigest, type AgentRole, type CodingChange, type CodingRecord, type CodingTool, type CodingToolResult } from "./coding-types";
import { recordReportSnapshot } from "./reports";
import type { ReportFact } from "./report-types";

type Phase = "source" | "setup" | "model" | "tools" | "test_before" | "test_command" | "test_after" | "review_diff" | "publish" | "cleanup";
interface Entry {
  run: CodingRecord; phase: Phase; executorKey: string; dispatched: boolean;
  step: number; history: Partial<Record<AgentRole, ModelItem[]>>; calls: ModelCall[];
  beforeDigest?: string; fileCount?: number; repairAttempts: number; publicationPending?: boolean;
  reporting?: { startedAt: number; outbox: ReportFact[] };
}
interface Command { organizationId: string; workspaceId: string; userId: string; action: string; runId?: string; body: Record<string, unknown> }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const safeError = (error: unknown) => {
  const code = error instanceof HttpError ? error.code : error instanceof Error ? error.message : "";
  return /^(coding|github|model|executor)_[a-z_]{1,60}$/.test(code) ? code : "coding_execution_failed";
};

/** One company coordinator. Each task/generation receives a separate disposable VM. */
export class CodingRoom extends DurableObject<AppEnv> {
  #busy = false;
  #modelAbort?: AbortController;
  #reportFlush?: Promise<boolean>;

  async fetch(request: Request): Promise<Response> {
    const command = await request.json() as Command;
    return this.ctx.blockConcurrencyWhile(async () => {
      try { const response = await this.command(command); this.ctx.waitUntil(this.flushReports()); return response; }
      catch (error) { return json({ error: error instanceof HttpError ? error.code : safeError(error) }, error instanceof HttpError ? error.status : 503); }
    });
  }

  private async command(c: Command): Promise<Response> {
    const role = await requireMembership(this.env.DB, c.organizationId, c.userId, c.action === "approve");
    if (!await this.env.DB.prepare("SELECT id FROM workspaces WHERE id=? AND organization_id=?").bind(c.workspaceId, c.organizationId).first()) throw new HttpError(404, "not_found");
    const scope = await this.ctx.storage.get<string>("organization");
    if (scope && scope !== c.organizationId) throw new HttpError(404, "not_found");
    if (!scope) await this.ctx.storage.put("organization", c.organizationId);
    if (c.action === "report-sync") return json({ synced: await this.flushReports() });
    if (c.action === "list") {
      const entries = await this.ctx.storage.list<Entry>({ prefix: "run:", limit: 100 });
      return json({ runs: [...entries.values()].filter((entry) => entry.run.workspaceId === c.workspaceId).map((entry) => codingView(entry.run, c.userId, role)).sort((a, b) => b.createdAt - a.createdAt) });
    }
    if (c.action === "create") {
      const input = parseCodingInput(c.body);
      const old = await this.ctx.storage.get<Entry>(`run:${input.requestId}`);
      if (old) {
        if (old.run.createdBy !== c.userId || old.run.workspaceId !== c.workspaceId
          || JSON.stringify(old.run.agentSelections ?? null) !== JSON.stringify(input.agentSelections ?? null)
          || Object.entries(input).some(([key, value]) => key !== "agentSelections" && old.run[key as keyof CodingRecord] !== value)) throw new HttpError(409, "request_id_reused");
        return json({ run: codingView(old.run, c.userId, role) });
      }
      const count = await this.ctx.storage.get<number>("count") ?? 0;
      if (count >= 100) throw new HttpError(429, "coding_history_limit");
      const connection = await authorizeRepository(this.env, c.organizationId, c.userId, input.repositoryConnectionId);
      const agents = await resolveAgents(this.env, c.organizationId, input);
      const now = Date.now();
      const run: CodingRecord = { ...input, organizationId: c.organizationId, workspaceId: c.workspaceId,
        runId: input.requestId, generation: 1, deadlineAt: 0, createdBy: c.userId, createdAt: now, updatedAt: now,
        status: "pending_approval", repositoryName: connection.fullName, credentialVersion: agents.find((agent) => agent.role === "programmer")!.credentialVersion,
        modelCalls: 0, tokens: 0, events: [], agents, agentStage: "coordinator" };
      const entry: Entry = { run, phase: "source", executorKey: codingExecutorName(run), dispatched: false, step: 0, history: {}, calls: [], repairAttempts: 0, reporting: { startedAt: now, outbox: [] } };
      await this.ctx.storage.put({ [`run:${run.runId}`]: entry, ...this.reportPending(entry), count: count + 1 });
      return json({ run: codingView(run, c.userId, role) }, 201);
    }
    const entry = await this.ctx.storage.get<Entry>(`run:${c.runId}`);
    if (!entry || entry.run.workspaceId !== c.workspaceId) throw new HttpError(404, "not_found");
    if (c.action === "get") return json({ run: codingView(entry.run, c.userId, role) });
    if (c.body.generation !== entry.run.generation) throw new HttpError(409, "coding_state_changed");
    if (c.action === "approve") {
      if (entry.run.status !== "pending_approval") throw new HttpError(409, "coding_state_changed");
      if (await this.ctx.storage.get("active")) throw new HttpError(429, "coding_capacity");
      entry.run.approvedBy = c.userId;
      entry.run.deadlineAt = Date.now() + CODING_LIMITS.durationMs;
      await this.authorize(entry.run);
      if (!await this.env.CODING_ADMISSION.getByName("global").acquire(entry.executorKey, c.organizationId, entry.run.deadlineAt)) throw new HttpError(429, "coding_capacity");
      entry.run.status = "queued";
      entry.run.approvedAt = Date.now();
      this.event(entry, "status", "Equipe aprovada. Preparando uma cópia isolada do repositório.");
      await this.ctx.storage.transaction(async (txn) => { await txn.put({ [`run:${entry.run.runId}`]: entry, ...this.reportPending(entry), active: entry.run.runId }); await txn.setAlarm(Date.now() + 100); });
      return json({ run: codingView(entry.run, c.userId, role) });
    }
    if (c.action === "cancel") {
      if (role === "member" && entry.run.createdBy !== c.userId) throw new HttpError(403, "admin_required");
      if (codingTerminal(entry.run.status)) throw new HttpError(409, "coding_state_changed");
      entry.publicationPending = entry.phase === "publish" && entry.dispatched;
      entry.run.generation++; entry.run.status = "canceled"; entry.phase = "cleanup";
      entry.run.finishedAt ??= Date.now();
      this.event(entry, "status", "Cancelamento solicitado. Encerrando o ambiente de execução.");
      await this.ctx.storage.put({ [`run:${entry.run.runId}`]: entry, ...this.reportPending(entry) });
      const active = await this.ctx.storage.get<string>("active");
      if (active === entry.run.runId) { this.#modelAbort?.abort(); await this.ctx.storage.setAlarm(Date.now() + 100); }
      this.ctx.waitUntil(this.env.CODING_EXECUTORS.getByName(entry.executorKey).stop().catch(() => undefined));
      return json({ run: codingView(entry.run, c.userId, role) });
    }
    throw new HttpError(404, "not_found");
  }

  private reportPending(entry: Entry): Record<string, boolean> { return entry.reporting ? { [`report-pending:${entry.run.runId}`]: true } : {}; }
  private mergeReportOutbox(entry: Entry, current: Entry) {
    if (entry.reporting && current.reporting) entry.reporting.outbox = [...new Map([...current.reporting.outbox, ...entry.reporting.outbox].map((fact) => [fact.id, fact])).values()];
  }
  /** Facts observed after cancellation remain facts; they never advance the canceled execution. */
  private async observeReportFact(entry: Entry, fact: ReportFact) {
    if (!entry.reporting) return;
    entry.reporting.outbox.push(fact);
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<Entry>(`run:${entry.run.runId}`);
      if (!current?.reporting) return;
      current.reporting.outbox = [...new Map([...current.reporting.outbox, fact].map((item) => [item.id, item])).values()];
      await txn.put({ [`run:${entry.run.runId}`]: current, ...this.reportPending(current) });
    });
  }
  private flushReports(): Promise<boolean> {
    return this.#reportFlush ??= this.flushReportBatch().finally(() => { this.#reportFlush = undefined; });
  }
  private async flushReportBatch(): Promise<boolean> {
    const pending = await this.ctx.storage.list<boolean>({ prefix: "report-pending:", limit: 100 });
    for (const key of pending.keys()) {
      const runId = key.slice("report-pending:".length), entry = await this.ctx.storage.get<Entry>(`run:${runId}`);
      if (!entry?.reporting) { await this.ctx.storage.delete(key); continue; }
      try {
        const consumed = new Set(entry.reporting.outbox.map((fact) => fact.id));
        await recordReportSnapshot(this.env, entry.run, entry.reporting.outbox, entry.reporting.startedAt);
        await this.ctx.storage.transaction(async (txn) => {
          const latest = await txn.get<Entry>(`run:${runId}`);
          if (!latest?.reporting) { await txn.delete(key); return; }
          latest.reporting.outbox = latest.reporting.outbox.filter((fact) => !consumed.has(fact.id));
          await txn.put(`run:${runId}`, latest);
          if (latest.run.updatedAt === entry.run.updatedAt && latest.run.generation === entry.run.generation && !latest.reporting.outbox.length) await txn.delete(key);
        });
      } catch { /* Durable outbox remains pending. Reporting failure never replays an execution effect. */ }
    }
    const remains = (await this.ctx.storage.list({ prefix: "report-pending:", limit: 1 })).size > 0;
    if (remains) { const alarm = await this.ctx.storage.getAlarm(); if (alarm === null || alarm > Date.now() + 5000) await this.ctx.storage.setAlarm(Date.now() + 5000); }
    return !remains;
  }

  private event(entry: Entry, kind: CodingRecord["events"][number]["kind"], text: string, result?: CodingToolResult) {
    const previous = entry.run.events.at(-1)?.id ?? 0;
    entry.run.updatedAt = Math.max(Date.now(), entry.run.updatedAt + 1);
    entry.run.events.push({ id: previous + 1, at: Date.now(), kind, text: text.slice(0, 32768), ...(result ? { exitCode: result.exitCode, truncated: result.truncated } : {}) });
    while (bytes(entry.run.events) > 196_608 && entry.run.events.length > 1) entry.run.events.shift();
  }
  private async authorize(run: CodingRecord) {
    await requireMembership(this.env.DB, run.organizationId, run.createdBy);
    await requireMembership(this.env.DB, run.organizationId, run.approvedBy!, true);
    const connection = await authorizeRepository(this.env, run.organizationId, run.createdBy, run.repositoryConnectionId);
    for (const agent of run.agents ?? []) if (await credentialVersion(this.env, run.organizationId, agent.provider) !== agent.credentialVersion) throw new Error("coding_key_changed");
    return connection;
  }
  private async assertActive(entry: Entry) {
    const current = await this.ctx.storage.get<Entry>(`run:${entry.run.runId}`);
    if (!current || current.run.generation !== entry.run.generation || codingTerminal(current.run.status)) throw new Error("coding_canceled");
    if (entry.run.deadlineAt <= Date.now()) throw new Error("coding_deadline_elapsed");
    return this.authorize(entry.run);
  }
  private async saveActive(entry: Entry) {
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<Entry>(`run:${entry.run.runId}`);
      if (!current || current.run.generation !== entry.run.generation || codingTerminal(current.run.status)) throw new Error("coding_canceled");
      entry.run.updatedAt = Math.max(Date.now(), current.run.updatedAt + 1);
      this.mergeReportOutbox(entry, current);
      await txn.put({ [`run:${entry.run.runId}`]: entry, ...this.reportPending(entry) });
      await txn.setAlarm(entry.dispatched ? entry.run.deadlineAt : Date.now() + 100);
    });
  }
  private history(entry: Entry) {
    const role = entry.run.agentStage ?? "programmer";
    return entry.history[role] ??= [{ role: "user", content: `Repository: ${entry.run.repositoryName}\nPinned commit: ${entry.run.baseSha}\nTask: ${entry.run.task}\nApproved final test: ${entry.run.testCommand}\n${entry.run.plan ? "Plan:\n" + entry.run.plan : ""}` }];
  }
  private async tool(entry: Entry, tool: CodingTool): Promise<CodingToolResult> {
    await this.assertActive(entry);
    return this.env.CODING_EXECUTORS.getByName(entry.executorKey).step({ runId: entry.run.runId, generation: entry.run.generation, deadlineAt: entry.run.deadlineAt, stepId: `s${entry.step}`, tool });
  }
  private async snapshot(entry: Entry) {
    await this.assertActive(entry);
    const snapshot = await this.env.CODING_EXECUTORS.getByName(entry.executorKey).snapshot({ runId: entry.run.runId, generation: entry.run.generation, deadlineAt: entry.run.deadlineAt, stepId: `s${entry.step}` });
    if (snapshot.treeDigest !== await codingTreeDigest(snapshot.files)) throw new Error("coding_manifest_mismatch");
    return snapshot;
  }

  async alarm(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    let entry: Entry | undefined;
    try {
      await this.flushReports();
      const active = await this.ctx.storage.get<string>("active");
      if (!active) return;
      entry = await this.ctx.storage.get<Entry>(`run:${active}`);
      if (!entry) { await this.ctx.storage.delete("active"); return; }
      if (entry.publicationPending) { await this.recoverPublication(entry); return; }
      if (codingTerminal(entry.run.status) || entry.phase === "cleanup") { await this.cleanup(entry); return; }
      if (entry.dispatched) {
        if (entry.phase === "publish") {
          await this.recoverPublication(entry); return;
        }
        await this.finish(entry, "interrupted", "coding_step_uncertain"); return;
      }
      await this.assertActive(entry);
      if (entry.phase === "source") entry.run.startedAt ??= Date.now();
      entry.dispatched = true; entry.step++;
      await this.saveActive(entry); // Persist before any model, command or GitHub effect.
      await this.advance(entry);
      if (codingTerminal(entry.run.status)) return;
      await this.assertActive(entry);
      entry.dispatched = false;
      await this.saveActive(entry);
    } catch (error) {
      if (entry) {
        if (entry.phase === "publish") { await this.recoverPublication(entry); return; }
        const current = await this.ctx.storage.get<Entry>(`run:${entry.run.runId}`);
        if (current && current.run.generation === entry.run.generation && !codingTerminal(current.run.status)) await this.finish(entry, "failed", safeError(error));
        else if (current) await this.cleanup(current);
      }
    } finally { this.#busy = false; await this.flushReports(); }
  }

  /** Reconcile writes already dispatched, including when cancellation raced their response. */
  private async recoverPublication(entry: Entry) {
    let result = entry.run.result;
    if (!result && entry.run.review?.approved && entry.run.verification?.exitCode === 0) {
      try {
        const connection = await authorizeRepository(this.env, entry.run.organizationId, entry.run.createdBy, entry.run.repositoryConnectionId);
        const receipt = await reconcileRepositoryPublication(this.env, connection, { runId: entry.run.runId, baseSha: entry.run.baseSha!, baseTreeSha: entry.run.baseTreeSha!, baseRef: entry.run.baseRef, task: entry.run.task, verification: entry.run.verification });
        if (receipt) result = { ...receipt, changedFiles: entry.fileCount ?? 0 };
      } catch { /* Leave an explicit uncertain receipt; this path never repeats a write. */ }
    }
    const current = await this.ctx.storage.get<Entry>(`run:${entry.run.runId}`);
    if (!current) return;
    if (current.run.generation === entry.run.generation && !codingTerminal(current.run.status)) {
      entry.run.result = result;
      if (result) entry.run.publishedAt ??= Date.now();
      if (result) this.event(entry, "status", "Publicação recuperada por leitura: o PR e o commit testado foram confirmados no GitHub.");
      await this.finish(entry, result ? "completed" : "interrupted", result ? undefined : "coding_publication_uncertain");
    } else {
      // Cancellation remains cancellation, even if an already-started write succeeded.
      await this.ctx.storage.transaction(async (txn) => {
        const latest = await txn.get<Entry>(`run:${entry.run.runId}`);
        if (!latest) return;
        latest.publicationPending = false;
        latest.run.result = result ?? latest.run.result;
        if (result) latest.run.publishedAt ??= entry.run.publishedAt ?? Date.now();
        latest.run.error = result ? undefined : "coding_publication_uncertain";
        this.event(latest, "status", result ? "O cancelamento foi mantido. Um PR criado antes da confirmação da parada foi encontrado no GitHub." : "O cancelamento foi mantido, mas não foi possível confirmar o resultado da publicação no GitHub.");
        await txn.put({ [`run:${entry.run.runId}`]: latest, ...this.reportPending(latest) });
      });
      await this.cleanup(current);
    }
  }

  private async advance(entry: Entry) {
    const run = entry.run;
    if (entry.phase === "source") {
      const connection = await this.assertActive(entry);
      const source = await prepareRepository(this.env, connection, run.baseRef);
      run.baseSha = source.baseSha; run.baseTreeSha = source.baseTreeSha;
      try {
        await this.assertActive(entry);
        await this.env.CODING_EXECUTORS.getByName(entry.executorKey).init({ organizationId: run.organizationId, workspaceId: run.workspaceId, runId: run.runId, generation: run.generation, deadlineAt: run.deadlineAt, baseSha: source.baseSha, archive: source.archive });
      } catch (error) { await source.archive.cancel().catch(() => undefined); throw error; }
      run.status = "running"; entry.phase = run.setupCommand ? "setup" : "model";
      this.event(entry, "status", `Código preparado no commit ${source.baseSha.slice(0, 12)}. Coordenador iniciando o plano.`);
    } else if (entry.phase === "setup") {
      const result = await this.tool(entry, { kind: "run_command", command: run.setupCommand, cwd: ".", timeoutMs: 600_000 });
      this.event(entry, "tool", `$ ${run.setupCommand}\n${result.output}`, result);
      if (result.exitCode !== 0) throw new Error("coding_setup_failed");
      entry.phase = "model";
    } else if (entry.phase === "model") {
      const history = this.history(entry);
      const agent = run.agents?.find((profile) => profile.role === run.agentStage);
      const requestBytes = bytes(buildModelRequest(agent?.provider ?? run.provider, agent?.model ?? run.model, "", history, agent).body);
      const reserve = requestBytes + CODING_LIMITS.outputTokens;
      if (run.modelCalls >= CODING_LIMITS.modelCalls || run.tokens + reserve > CODING_LIMITS.totalTokens) throw new Error("coding_model_budget");
      if (requestBytes > CODING_LIMITS.contextBytes) throw new Error("coding_context_limit");
      run.modelCalls++; run.tokens += reserve;
      const callId = `s${entry.step}`, modelStartedAt = Date.now();
      const agentFact = { agentId: agent?.profileId ?? `role:${run.agentStage ?? "programmer"}`, agentRole: run.agentStage ?? "programmer", agentName: agent?.name ?? "Programador", callId };
      entry.reporting?.outbox.push({ id: `model-start:${callId}`, kind: "model_started", at: modelStartedAt, ...agentFact });
      await this.saveActive(entry); // Unknown provider response is charged conservatively and never retried.
      this.#modelAbort = new AbortController();
      const turn = await callModel(this.env, run, history, this.#modelAbort.signal);
      this.#modelAbort = undefined;
      await this.observeReportFact(entry, { id: `model-usage:${callId}`, kind: "model_observed", at: Date.now(), ...agentFact, tokens: turn.tokens, durationMs: Math.max(0, Date.now() - modelStartedAt) });
      run.tokens += Math.max(0, turn.tokens) - reserve;
      history.push(...turn.items); entry.calls = turn.calls;
      if (turn.text) this.event(entry, "model", `${run.agents?.find((agent) => agent.role === run.agentStage)?.name ?? "Agente"}: ${turn.text}`);
      if (!turn.calls.length) {
        if (run.agentStage !== "programmer") throw new Error("coding_agent_verdict_required");
        run.summary = turn.text; entry.phase = "test_before";
      } else entry.phase = "tools";
    } else if (entry.phase === "tools") {
      const call = entry.calls.shift();
      if (!call) { entry.phase = "model"; return; }
      const role = run.agentStage ?? "programmer";
      const provider = run.agents?.find((agent) => agent.role === role)?.provider ?? run.provider;
      if (call.tool.kind === "plan_ready") {
        if (role !== "coordinator" || entry.calls.length) throw new Error("coding_invalid_plan");
        run.plan = call.tool.plan; run.agentStage = "programmer";
        this.event(entry, "status", `Plano do coordenador:\n${run.plan}\nProgramador iniciando a implementação.`);
        entry.phase = "model";
      } else if (call.tool.kind === "submit_review") {
        if (role !== "reviewer" || entry.calls.length) throw new Error("coding_invalid_review");
        run.review = { approved: call.tool.approved, summary: call.tool.summary, at: Date.now() };
        this.event(entry, "status", `Revisão ${call.tool.approved ? "aprovada" : "solicitou ajustes"}: ${call.tool.summary}`);
        if (call.tool.approved) {
          if (!run.verification || run.verification.exitCode !== 0) throw new Error("coding_tests_required");
          entry.phase = "publish"; run.status = "publishing";
        } else {
          if (++entry.repairAttempts > 2) throw new Error("coding_review_rejected");
          run.agentStage = "programmer"; run.status = "running"; run.verification = undefined;
          this.history(entry).push({ role: "user", content: `Reviewer requested corrections: ${call.tool.summary}` });
          entry.phase = "model";
        }
      } else {
        const result = await this.tool(entry, call.tool);
        const description = call.tool.kind === "run_command" ? `$ ${call.tool.command}` : `${call.tool.kind}: ${call.tool.path}`;
        this.event(entry, "tool", `${description}\n${result.output}`, result);
        appendToolResult(provider, this.history(entry), call, JSON.stringify(result));
        entry.phase = entry.calls.length ? "tools" : "model";
      }
    } else if (entry.phase === "test_before") {
      const snapshot = await this.snapshot(entry);
      if (!snapshot.files.length) throw new Error("coding_no_changes");
      entry.beforeDigest = snapshot.treeDigest;
      run.status = "testing"; entry.phase = "test_command";
      this.event(entry, "status", "Executando o comando de teste aprovado sobre as alterações finais.");
    } else if (entry.phase === "test_command") {
      const result = await this.tool(entry, { kind: "run_command", command: run.testCommand, cwd: ".", timeoutMs: 600_000 });
      await this.observeReportFact(entry, { id: `test:s${entry.step}`, kind: "test", at: result.finishedAt, exitCode: result.exitCode, durationMs: Math.max(0, result.finishedAt - result.startedAt) });
      this.event(entry, "test", `$ ${run.testCommand}\n${result.output}`, result);
      run.verification = { command: run.testCommand, exitCode: result.exitCode, treeDigest: entry.beforeDigest!, output: result.output, truncated: result.truncated, finishedAt: result.finishedAt };
      if (result.exitCode !== 0) {
        if (++entry.repairAttempts > 2) throw new Error("coding_tests_failed");
        run.agentStage = "programmer"; run.status = "running";
        this.history(entry).push({ role: "user", content: `Final approved test failed with exit ${result.exitCode}. Fix it before finishing.\n${result.output}` });
        entry.phase = "model";
      } else entry.phase = "test_after";
    } else if (entry.phase === "test_after") {
      const snapshot = await this.snapshot(entry);
      if (snapshot.treeDigest !== entry.beforeDigest) throw new Error("coding_tree_changed_during_tests");
      entry.fileCount = snapshot.files.length;
      for (let i = 0; i < snapshot.files.length; i++) {
        const serialized = JSON.stringify(snapshot.files[i]); const chunks = Math.ceil(serialized.length / 60000);
        await this.ctx.storage.put(`file:${run.runId}:${i}:count`, chunks);
        for (let chunk = 0; chunk < chunks; chunk++) await this.ctx.storage.put(`file:${run.runId}:${i}:${chunk}`, serialized.slice(chunk * 60000, (chunk + 1) * 60000));
      }
      run.agentStage = "reviewer"; run.status = "running"; entry.history.reviewer = undefined;
      const diff = snapshot.files.map((file) => ({ path: file.path, mode: file.mode, deleted: file.content === null, content: file.content?.slice(0, 2000) }));
      this.history(entry).push({ role: "user", content: `Programmer summary: ${run.summary}\nActual final test receipt: ${JSON.stringify(run.verification)}\nChanged files (content excerpts, read full files when needed): ${JSON.stringify(diff).slice(0, 45000)}` });
      entry.phase = "review_diff";
      this.event(entry, "status", "Teste concluído com código 0. Revisor conferindo as alterações.");
    } else if (entry.phase === "review_diff") {
      await this.assertActive(entry);
      const diff = await this.env.CODING_EXECUTORS.getByName(entry.executorKey).reviewDiff({ runId: run.runId, generation: run.generation, deadlineAt: run.deadlineAt, stepId: `s${entry.step}` });
      if (diff.exitCode !== 0) throw new Error("coding_diff_unavailable");
      this.history(entry).push({ role: "user", content: `Diff against the original checkout${diff.truncated ? " (truncated; read relevant files to complete review)" : ""}:\n${diff.output}` });
      entry.phase = "model";
    } else if (entry.phase === "publish") {
      const connection = await this.assertActive(entry);
      const files: CodingChange[] = [];
      for (let i = 0; i < (entry.fileCount ?? 0); i++) {
        const chunks = await this.ctx.storage.get<number>(`file:${run.runId}:${i}:count`);
        if (!chunks || chunks > 100) throw new Error("coding_manifest_missing");
        let serialized = "";
        for (let chunk = 0; chunk < chunks; chunk++) {
          const part = await this.ctx.storage.get<string>(`file:${run.runId}:${i}:${chunk}`);
          if (part === undefined) throw new Error("coding_manifest_missing"); serialized += part;
        }
        files.push(JSON.parse(serialized) as CodingChange);
      }
      if (!run.review?.approved || run.verification?.exitCode !== 0 || await codingTreeDigest(files) !== run.verification.treeDigest) throw new Error("coding_tests_required");
      const result = await publishRepository(this.env, connection, { runId: run.runId, baseSha: run.baseSha!, baseTreeSha: run.baseTreeSha!, baseRef: run.baseRef, task: run.task,
        files, verification: run.verification, assertActive: async () => { await this.assertActive(entry); } });
      // A validated GitHub receipt remains evidence if cancellation raced the response.
      run.result = { ...result, changedFiles: files.length };
      run.publishedAt ??= Date.now();
      await this.assertActive(entry);
      this.event(entry, "status", `PR em rascunho criado: ${result.prUrl}`);
      await this.finish(entry, "completed");
    }
  }

  private async finish(entry: Entry, status: "completed" | "failed" | "interrupted", error?: string) {
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<Entry>(`run:${entry.run.runId}`);
      if (!current || current.run.generation !== entry.run.generation || codingTerminal(current.run.status)) return;
      entry.run.status = status; entry.run.error = error; entry.phase = "cleanup"; entry.dispatched = false;
      entry.run.finishedAt ??= Date.now();
      entry.run.updatedAt = Math.max(Date.now(), current.run.updatedAt + 1);
      this.mergeReportOutbox(entry, current);
      if (error) this.event(entry, "error", error);
      await txn.put({ [`run:${entry.run.runId}`]: entry, ...this.reportPending(entry) }); await txn.setAlarm(Date.now() + 100);
    });
    const current = await this.ctx.storage.get<Entry>(`run:${entry.run.runId}`);
    if (current) await this.cleanup(current);
  }
  private async cleanup(entry: Entry) {
    try {
      await confirmedCodingStop(this.env, entry.executorKey);
      await this.env.CODING_ADMISSION.getByName("global").release(entry.executorKey);
      const reportsSynced = await this.flushReports();
      await this.ctx.storage.transaction(async (txn) => {
        if (await txn.get("active") === entry.run.runId) { await txn.delete("active"); if (reportsSynced) await txn.deleteAlarm(); }
      });
    } catch { await this.ctx.storage.setAlarm(Date.now() + 5000); }
  }
}
