import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import { HttpError, json } from "./http";
import { requireMembership } from "./organizations";
import { readAgentCatalog } from "./agent-catalog";
import { browserCredentialVersion, browserModelReservation, callBrowserModel } from "./browser-model";
import { CloudBrowserRuntime, closeBrowserSession, type BrowserBinding } from "./browser-runtime";
import { BROWSER_NETWORK_LIMITS, type BrowserNetworkBudget } from "./browser-network";
import { browserTerminal, browserView, parseBrowserInput } from "./browser-state";
import { BROWSER_LIMITS, type BrowserAction, type BrowserCommand, type BrowserObservation, type BrowserRun } from "./browser-types";

interface Entry { run: BrowserRun; phase: "start" | "step" | "cleanup"; dispatched: boolean; sessionId?: string; launchAttemptAt?: number; tokenBudgetUsed?: number }
interface Network { requests: number; bytes: number }
const safeError = (error: unknown) => error instanceof Error && /^browser_[a-z_]{1,60}$/.test(error.message) ? error.message : "browser_execution_failed";
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("browser_operation_timeout")), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** One organization per coordinator; a separate browser session for each run.
 * A dispatch persisted without its result is interrupted, never replayed. */
export class BrowserRoom extends DurableObject<AppEnv> {
  #busy = false;
  #abort?: AbortController;
  #runtime?: CloudBrowserRuntime;
  private binding(): BrowserBinding {
    const binding = this.env.BROWSER;
    if (!binding || typeof binding.acquire !== "function" || typeof binding.getSession !== "function" || typeof binding.closeSession !== "function") throw new HttpError(503, "browser_unavailable");
    return binding as BrowserBinding;
  }
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try { return await this.command(await request.json() as BrowserCommand); }
      catch (error) { return json({ error: error instanceof HttpError ? error.code : safeError(error) }, error instanceof HttpError ? error.status : 503); }
    });
  }
  private async command(c: BrowserCommand): Promise<Response> {
    const role = await requireMembership(this.env.DB, c.organizationId, c.userId, c.action === "approve");
    if (!await this.env.DB.prepare("SELECT id FROM workspaces WHERE id=? AND organization_id=?").bind(c.workspaceId, c.organizationId).first()) throw new HttpError(404, "not_found");
    const organization = await this.ctx.storage.get<string>("organization");
    if (organization && organization !== c.organizationId) throw new HttpError(404, "not_found");
    if (!organization) await this.ctx.storage.put("organization", c.organizationId);
    if (c.action === "list") {
      const entries = await this.ctx.storage.list<Entry>({ prefix: "run:", limit: BROWSER_LIMITS.history });
      return json({ runs: [...entries.values()].filter((entry) => entry.run.workspaceId === c.workspaceId).map((entry) => browserView(entry.run, c.userId, role)).sort((a, b) => b.createdAt - a.createdAt) });
    }
    if (c.action === "create") {
      this.binding(); const input = parseBrowserInput(c.body);
      const old = await this.ctx.storage.get<Entry>(`run:${input.requestId}`);
      if (old) {
        if (old.run.createdBy !== c.userId || old.run.workspaceId !== c.workspaceId || JSON.stringify(parseBrowserInput(old.run as unknown as Record<string, unknown>)) !== JSON.stringify(input)) throw new HttpError(409, "request_id_reused");
        return json({ run: browserView(old.run, c.userId, role) });
      }
      const count = await this.ctx.storage.get<number>("count") ?? 0;
      if (count >= BROWSER_LIMITS.history) throw new HttpError(429, "browser_history_limit");
      let agentSnapshot: BrowserRun["agentSnapshot"];
      if (input.agent) {
        const catalogue = await readAgentCatalog(this.env, c.organizationId);
        if (catalogue.version !== input.agent.catalogVersion) throw new HttpError(409, "agent_catalog_changed");
        const profile = catalogue.agents.find((agent) => agent.id === input.agent!.profileId);
        if (!profile) throw new HttpError(400, "invalid_agent_selection");
        agentSnapshot = { id: profile.id, revision: profile.revision, name: profile.name,
          instructions: [profile.title, profile.description, profile.instructions].filter(Boolean).join("\n\n") };
      }
      const credentialVersion = await browserCredentialVersion(this.env, c.organizationId, input.provider); const now = Date.now();
      const run: BrowserRun = { ...input, runId: input.requestId, organizationId: c.organizationId, workspaceId: c.workspaceId, generation: 1,
        status: "pending_approval", createdBy: c.userId, createdAt: now, updatedAt: now, deadlineAt: 0, credentialVersion,
        steps: 0, modelCalls: 0, tokens: 0, events: [], cleanupStatus: "closed", ...(agentSnapshot ? { agentSnapshot } : {}) };
      await this.ctx.storage.put({ [`run:${run.runId}`]: { run, phase: "start", dispatched: false } satisfies Entry, count: count + 1 });
      return json({ run: browserView(run, c.userId, role) }, 201);
    }
    const entry = await this.ctx.storage.get<Entry>(`run:${c.runId}`);
    if (!entry || entry.run.workspaceId !== c.workspaceId) throw new HttpError(404, "not_found");
    if (c.action === "get") return json({ run: browserView(entry.run, c.userId, role) });
    if (c.action === "screenshot") {
      const shot = await this.ctx.storage.get<Uint8Array>(`screenshot:${entry.run.runId}`);
      if (!shot) throw new HttpError(404, "not_found");
      return new Response(new Uint8Array(shot).buffer, { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    }
    if (c.body.generation !== entry.run.generation) throw new HttpError(409, "browser_state_changed");
    if (c.action === "approve") {
      this.binding();
      if (entry.run.status !== "pending_approval") throw new HttpError(409, "browser_state_changed");
      if (await this.ctx.storage.get("active")) throw new HttpError(429, "browser_capacity");
      entry.run.approvedBy = c.userId; await this.authorize(entry.run);
      const now = Date.now(); const deadline = now + BROWSER_LIMITS.durationMs;
      const admitted = await this.env.DB.prepare(`INSERT INTO browser_admissions (run_id,organization_id,created_at,expires_at)
        SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM browser_admissions WHERE organization_id=? AND expires_at>?)
        AND (SELECT count(*) FROM browser_admissions WHERE expires_at>?)<4
        AND (SELECT count(*) FROM browser_admissions WHERE organization_id=? AND created_at>?)<10
        AND (SELECT count(*) FROM browser_admissions WHERE created_at>?)<50
        AND EXISTS (SELECT 1 FROM memberships WHERE organization_id=? AND user_id=? AND role IN ('owner','admin'))
        ON CONFLICT(run_id) DO NOTHING`)
        .bind(entry.run.runId, c.organizationId, now, deadline + 60000, c.organizationId, now, now, c.organizationId, now - 86400000, now - 86400000, c.organizationId, c.userId).run();
      if (admitted.meta.changes !== 1) {
        const previous = await this.env.DB.prepare("SELECT organization_id,expires_at FROM browser_admissions WHERE run_id=?").bind(entry.run.runId).first<{ organization_id: string; expires_at: number }>();
        if (!previous || previous.organization_id !== c.organizationId || previous.expires_at < now) throw new HttpError(429, "browser_capacity");
        // Recovery of a known admission uses its original deadline, never extends a lease.
        entry.run.deadlineAt = previous.expires_at - 60000;
      } else entry.run.deadlineAt = deadline;
      entry.run.status = "queued"; entry.run.approvedAt = now; entry.run.cleanupStatus = "pending";
      this.event(entry, "status", "Tarefa aprovada. Abrindo uma sessão isolada na Cloudflare.");
      await this.ctx.storage.transaction(async (txn) => { await txn.put({ [`run:${entry.run.runId}`]: entry, active: entry.run.runId }); await txn.setAlarm(now + 100); });
      return json({ run: browserView(entry.run, c.userId, role) });
    }
    if (c.action === "cancel") {
      if (role === "member" && entry.run.createdBy !== c.userId) throw new HttpError(403, "admin_required");
      if (browserTerminal(entry.run.status)) throw new HttpError(409, "browser_state_changed");
      entry.run.generation++; entry.run.status = "canceled"; entry.run.finishedAt = Date.now(); entry.phase = "cleanup";
      this.event(entry, "status", "Cancelamento solicitado. Encerrando o navegador.");
      await this.ctx.storage.put(`run:${entry.run.runId}`, entry);
      if (await this.ctx.storage.get("active") === entry.run.runId) { this.#abort?.abort(); await this.ctx.storage.setAlarm(Date.now() + 100); }
      if (entry.sessionId) this.ctx.waitUntil(bounded(closeBrowserSession(this.binding(), entry.sessionId), 5000).catch(() => false));
      return json({ run: browserView(entry.run, c.userId, role) });
    }
    throw new HttpError(404, "not_found");
  }
  private event(entry: Entry, kind: BrowserRun["events"][number]["kind"], text: string) {
    entry.run.updatedAt = Math.max(Date.now(), entry.run.updatedAt + 1);
    entry.run.events.push({ id: (entry.run.events.at(-1)?.id ?? 0) + 1, at: Date.now(), kind, text: text.slice(0, 4000) });
    while (bytes(entry.run.events) > BROWSER_LIMITS.eventsBytes) entry.run.events.shift();
  }
  private async authorize(run: BrowserRun) {
    await requireMembership(this.env.DB, run.organizationId, run.createdBy);
    await requireMembership(this.env.DB, run.organizationId, run.approvedBy!, true);
    if (await browserCredentialVersion(this.env, run.organizationId, run.provider) !== run.credentialVersion) throw new Error("browser_key_changed");
  }
  private async assertActive(entry: Entry) {
    const current = await this.ctx.storage.get<Entry>(`run:${entry.run.runId}`);
    if (!current || current.run.generation !== entry.run.generation || browserTerminal(current.run.status) || this.#abort?.signal.aborted) throw new Error("browser_canceled");
    if (current.run.deadlineAt <= Date.now()) throw new Error("browser_deadline_elapsed");
    await this.authorize(current.run);
    const rechecked = await this.ctx.storage.get<Entry>(`run:${entry.run.runId}`);
    if (!rechecked || rechecked.run.generation !== entry.run.generation || browserTerminal(rechecked.run.status) || this.#abort?.signal.aborted) throw new Error("browser_canceled");
    if (rechecked.run.deadlineAt <= Date.now()) throw new Error("browser_deadline_elapsed");
  }
  private budget(entry: Entry): BrowserNetworkBudget {
    return { assertActive: () => this.assertActive(entry), reserve: (amount) => this.network(entry, amount), refund: (amount) => this.network(entry, -amount) };
  }
  private async network(entry: Entry, amount: number) {
    await this.assertActive(entry);
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<Entry>(`run:${entry.run.runId}`);
      if (!current || current.run.generation !== entry.run.generation || browserTerminal(current.run.status)) throw new Error("browser_canceled");
      const budget = await txn.get<Network>(`network:${entry.run.runId}`) ?? { requests: 0, bytes: 0 };
      if (amount > 0) budget.requests++; budget.bytes = Math.max(0, budget.bytes + amount);
      if (budget.requests > BROWSER_NETWORK_LIMITS.requests || budget.bytes > BROWSER_NETWORK_LIMITS.bytes) throw new Error("browser_network_limit");
      await txn.put(`network:${entry.run.runId}`, budget);
    });
  }
  private async save(entry: Entry) {
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<Entry>(`run:${entry.run.runId}`);
      if (!current || current.run.generation !== entry.run.generation || browserTerminal(current.run.status)) throw new Error("browser_canceled");
      await txn.put(`run:${entry.run.runId}`, entry); await txn.setAlarm(Date.now() + 100);
    });
  }
  private async screenshot(entry: Entry, observation: BrowserObservation) {
    await this.assertActive(entry);
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<Entry>(`run:${entry.run.runId}`);
      if (!current || current.run.generation !== entry.run.generation || browserTerminal(current.run.status)) throw new Error("browser_canceled");
      entry.run.screenshotAt = Math.max(Date.now(), (entry.run.screenshotAt ?? 0) + 1);
      current.run.screenshotAt = entry.run.screenshotAt;
      await txn.put({ [`run:${entry.run.runId}`]: current, [`screenshot:${entry.run.runId}`]: observation.jpeg });
    });
  }
  async alarm(): Promise<void> {
    if (this.#busy) { await this.ctx.storage.setAlarm(Date.now() + 1000); return; }
    this.#busy = true;
    try {
      const active = await this.ctx.storage.get<string>("active"); if (!active) return;
      const entry = await this.ctx.storage.get<Entry>(`run:${active}`); if (!entry) return;
      if (browserTerminal(entry.run.status) || entry.phase === "cleanup") { await this.cleanup(entry); return; }
      if (entry.dispatched) { await this.finish(entry, "interrupted", "browser_result_unknown"); return; }
      this.#abort ??= new AbortController();
      try {
        await this.assertActive(entry);
        entry.dispatched = true;
        if (entry.phase === "start") entry.launchAttemptAt = Date.now();
        await this.save(entry);
        await bounded(this.advance(entry), Math.max(1, entry.run.deadlineAt - Date.now()));
        if (!browserTerminal(entry.run.status)) { entry.dispatched = false; await this.save(entry); }
      } catch (error) {
        const current = await this.ctx.storage.get<Entry>(`run:${active}`);
        if (current && current.run.generation === entry.run.generation && !browserTerminal(current.run.status)) {
          entry.sessionId ??= current.sessionId;
          await this.finish(entry, "failed", safeError(error));
        }
      }
    } finally { this.#busy = false; }
  }
  private async advance(entry: Entry) {
    const run = entry.run;
    const signal = this.#abort!.signal;
    if (entry.phase === "start") {
      const runtime = await bounded(CloudBrowserRuntime.acquire(this.binding(), run.allowedHosts, this.budget(entry), signal, async (sessionId) => {
        entry.sessionId = sessionId;
        await this.ctx.storage.transaction(async (txn) => {
          const current = await txn.get<Entry>(`run:${run.runId}`);
          if (!current) throw new Error("browser_canceled"); current.sessionId = sessionId; await txn.put(`run:${run.runId}`, current);
        });
        await this.assertActive(entry);
      }), 30000);
      try { await this.assertActive(entry); }
      catch (error) { this.ctx.waitUntil(bounded(runtime.close(), 5000).catch(() => false)); throw error; }
      this.#runtime = runtime;
      await runtime.navigate(run.initialUrl); await this.screenshot(entry, await runtime.observe());
      run.status = "running"; entry.phase = "step";
      this.event(entry, "status", "Navegador pronto. O agente está observando a página."); return;
    }
    if (!entry.sessionId) throw new Error("browser_session_missing");
    const runtime = this.#runtime ?? await bounded(CloudBrowserRuntime.resume(this.binding(), entry.sessionId, run.allowedHosts, this.budget(entry), signal), 15000);
    try { await this.assertActive(entry); }
    catch (error) { this.ctx.waitUntil(bounded(runtime.close(), 5000).catch(() => false)); throw error; }
    this.#runtime = runtime;
    if (run.modelCalls >= BROWSER_LIMITS.modelCalls || run.steps >= BROWSER_LIMITS.actions || run.tokens >= BROWSER_LIMITS.totalTokens) throw new Error("browser_budget_exhausted");
    const observation = await runtime.observe(); await this.screenshot(entry, observation);
    const reservation = browserModelReservation(run, observation);
    if ((entry.tokenBudgetUsed ?? run.tokens) + reservation > BROWSER_LIMITS.totalTokens) throw new Error("browser_budget_exhausted");
    entry.tokenBudgetUsed = (entry.tokenBudgetUsed ?? run.tokens) + reservation;
    run.modelCalls++; await this.save(entry);
    const turn = await callBrowserModel(this.env, run, observation, signal);
    run.tokens += turn.tokens;
    entry.tokenBudgetUsed += turn.tokens - reservation;
    await this.save(entry);
    if (run.tokens > BROWSER_LIMITS.totalTokens) throw new Error("browser_budget_exhausted");
    await this.assertActive(entry);
    if (turn.action.kind === "finish") {
      run.summary = turn.action.summary;
      await this.finish(entry, turn.action.completed ? "completed" : "failed", turn.action.completed ? undefined : "browser_task_incomplete"); return;
    }
    await runtime.act(turn.action); run.steps++;
    this.event(entry, "action", this.actionText(turn.action));
    await this.screenshot(entry, await runtime.observe());
  }
  private actionText(action: BrowserAction): string {
    if (action.kind === "click") return `Clicou na posição ${action.x}, ${action.y}.`;
    if (action.kind === "type") return `Preencheu o campo selecionado (${action.text.length} caracteres).`;
    if (action.kind === "press") return `Pressionou ${action.key}.`;
    if (action.kind === "scroll") return `Rolou a página ${action.direction === "down" ? "para baixo" : "para cima"}.`;
    if (action.kind === "navigate") return `Abriu ${new URL(action.url).origin}.`;
    return "Observação concluída.";
  }
  private async finish(entry: Entry, status: "completed" | "failed" | "interrupted", error?: string) {
    const controller = this.#abort;
    const terminalized = await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<Entry>(`run:${entry.run.runId}`);
      if (!current || current.run.generation !== entry.run.generation || browserTerminal(current.run.status)) return false;
      entry.sessionId ??= current.sessionId; entry.run.status = status; entry.run.finishedAt = Date.now(); entry.run.error = error;
      entry.phase = "cleanup"; entry.dispatched = false;
      this.event(entry, error ? "error" : "status", error ?? "O agente concluiu a observação e registrou o resultado.");
      await txn.put(`run:${entry.run.runId}`, entry); await txn.setAlarm(Date.now() + 100);
      return true;
    });
    if (terminalized) controller?.abort();
  }
  private async cleanup(entry: Entry) {
    this.#abort?.abort(); let closed = !entry.sessionId && !entry.launchAttemptAt;
    if (entry.sessionId) {
      try { closed = await bounded(this.#runtime?.sessionId === entry.sessionId ? this.#runtime.close() : closeBrowserSession(this.binding(), entry.sessionId), 5000); }
      catch { closed = false; }
    }
    this.#runtime = undefined;
    const idleElapsed = Date.now() > entry.run.deadlineAt + 120000;
    if (!closed && !idleElapsed) { await this.ctx.storage.setAlarm(Date.now() + 5000); return; }
    entry.run.cleanupStatus = closed ? "closed" : "idle_expiry";
    this.event(entry, "status", closed ? "Sessão do navegador encerrada." : "Prazo de inatividade da sessão expirado; não houve confirmação de fechamento pela API.");
    await this.env.DB.prepare("UPDATE browser_admissions SET expires_at=0 WHERE run_id=? AND organization_id=?").bind(entry.run.runId, entry.run.organizationId).run();
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(`run:${entry.run.runId}`, entry);
      if (await txn.get("active") === entry.run.runId) { await txn.delete("active"); await txn.deleteAlarm(); }
    });
    this.#abort = undefined;
  }
}
