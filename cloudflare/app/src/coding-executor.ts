import { DurableObject } from "cloudflare:workers";
import { CODING_LIMITS, codingTreeDigest } from "./coding-types";
import type { CodingIdentity, CodingTool, CodingToolResult, CodingSnapshot } from "./coding-types";
import { CODING_INIT_PROGRAM, CODING_TOOL_PROGRAM, CODING_PYTHON, CODING_UNTRUSTED_PREFIX, CODING_OUTPUT_BYTES, CODING_SNAPSHOT_BYTES, boundedStream, limitedArchive, validateCodingTool } from "./coding-program";

interface Identity extends CodingIdentity { baseSha: string }
interface Receipt { fingerprint: string; status: "running" | "done"; chunks?: number }
type Fence = Pick<CodingIdentity, "runId" | "generation" | "deadlineAt"> & { stepId: string };
const bytes = (text: string) => new TextEncoder().encode(text);
const stream = (data: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } });
const identifier = (id: unknown) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
async function fingerprint(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(JSON.stringify(value)))), b => b.toString(16).padStart(2, "0")).join("");
}

/** One VM per tenant/run/generation. Arbitrary repository code never receives credentials. */
export class CodingExecutor extends DurableObject<unknown> {
  #stopped = false;
  #shutdown?: Promise<void>;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const identity = await ctx.storage.get<Identity>("identity");
      if (!identity) return;
      if (await ctx.storage.get("stopped") || await ctx.storage.get("active") || !ctx.container?.running || identity.deadlineAt <= Date.now()) {
        // An effect without its receipt is uncertain. Never replay it on recovery.
        await this.stop();
      } else {
        await ctx.container.setInactivityTimeout(Math.max(1, identity.deadlineAt - Date.now()));
      }
    });
  }

  async init(input: CodingIdentity & { baseSha: string; archive: ReadableStream<Uint8Array> }): Promise<{ ready: true }> {
    if (![input.organizationId, input.workspaceId, input.runId].every(identifier) || !Number.isSafeInteger(input.generation) || input.generation < 1 || !/^[a-f0-9]{40}$/.test(input.baseSha)
      || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= Date.now() || input.deadlineAt > Date.now() + CODING_LIMITS.durationMs) throw new Error("invalid_coding_identity");
    const identity: Identity = { organizationId: input.organizationId, workspaceId: input.workspaceId, runId: input.runId, generation: input.generation, baseSha: input.baseSha, deadlineAt: input.deadlineAt };
    const digest = await fingerprint(identity);
    const replay = await this.ctx.storage.transaction(async storage => {
      if (this.#stopped || await storage.get("stopped")) throw new Error("executor_stopped");
      const previous = await storage.get<Identity>("identity");
      if (previous) {
        if (await fingerprint(previous) !== digest) throw new Error("executor_identity_mismatch");
        if (await storage.get("ready")) return true;
        throw new Error("executor_already_started");
      }
      await storage.put({ identity, active: "init" });
      await storage.setAlarm(input.deadlineAt);
      return false;
    });
    if (replay) { await input.archive.cancel(); return { ready: true }; }
    try {
      const container = this.ctx.container;
      if (!container?.images.coding) throw new Error("coding_image_not_configured");
      const exports = this.ctx.exports as unknown as { CodingDependencyNetwork: (options: { props: { executorId: string; runId: string; generation: number; deadlineAt: number } }) => Fetcher };
      const network = exports.CodingDependencyNetwork({ props: { executorId: this.ctx.id.toString(), runId: input.runId, generation: input.generation, deadlineAt: input.deadlineAt } });
      await container.interceptOutboundHttp("*", network);
      await container.interceptOutboundHttps("*", network);
      this.#assertTime(input.deadlineAt);
      container.start({ image: container.images.coding, instance: "standard-1", enableInternet: false });
      await container.setInactivityTimeout(Math.max(1, input.deadlineAt - Date.now()));
      const result = await this.#execute([CODING_PYTHON, "-I", "-c", CODING_INIT_PROGRAM, input.baseSha], limitedArchive(input.archive), Math.min(input.deadlineAt, Date.now() + 120_000), CODING_OUTPUT_BYTES);
      if (result.exitCode !== 0) throw new Error("repository_preparation_failed");
      let baseline: unknown;
      try { baseline = (JSON.parse(result.output) as { baseline?: unknown }).baseline; } catch { throw new Error("repository_preparation_failed"); }
      if (typeof baseline !== "string" || !/^[a-f0-9]{40}$/.test(baseline)) throw new Error("repository_preparation_failed");
      await this.ctx.storage.transaction(async storage => {
        if (this.#stopped || await storage.get("stopped")) throw new Error("executor_stopped");
        await storage.put({ ready: true, baseline }); await storage.delete("active"); await storage.setAlarm(input.deadlineAt);
      });
      return { ready: true };
    } catch (error) { await this.#fail(error); throw error; }
  }

  async step(input: Fence & { tool: CodingTool }): Promise<CodingToolResult> {
    validateCodingTool(input.tool);
    const claimed = await this.#claim(input, input.tool);
    if (claimed !== null) return claimed as CodingToolResult;
    try {
      const deadlineAt = Math.min(input.deadlineAt, Date.now() + (input.tool.kind === "run_command" ? input.tool.timeoutMs : 30_000));
      const result = await this.#execute([...CODING_UNTRUSTED_PREFIX, CODING_PYTHON, "-I", "-c", CODING_TOOL_PROGRAM], stream(bytes(JSON.stringify(input.tool))), deadlineAt, CODING_OUTPUT_BYTES);
      await this.#save(input, result);
      return result;
    } catch (error) { await this.#fail(error); throw error; }
  }

  async snapshot(input: Fence): Promise<CodingSnapshot> {
    const claimed = await this.#claim(input, { kind: "snapshot" });
    if (claimed !== null) return claimed as CodingSnapshot;
    try {
      const baseline = await this.ctx.storage.get<string>("baseline");
      const result = await this.#execute([CODING_PYTHON, "-I", "-c", CODING_TOOL_PROGRAM], stream(bytes(JSON.stringify({ kind: "snapshot", baseline }))), Math.min(input.deadlineAt, Date.now() + 60_000), CODING_SNAPSHOT_BYTES);
      if (result.exitCode !== 0 || result.truncated) throw new Error("coding_snapshot_failed");
      let snapshot: CodingSnapshot;
      try { snapshot = JSON.parse(result.output) as CodingSnapshot; } catch { throw new Error("coding_snapshot_failed"); }
      this.#validateSnapshot(snapshot);
      if (await codingTreeDigest(snapshot.files) !== snapshot.treeDigest) throw new Error("coding_snapshot_digest_mismatch");
      await this.#save(input, snapshot);
      return snapshot;
    } catch (error) { await this.#fail(error); throw error; }
  }

  async reviewDiff(input: Fence): Promise<CodingToolResult> {
    const claimed = await this.#claim(input, { kind: "review_diff" });
    if (claimed !== null) return claimed as CodingToolResult;
    try {
      const baseline = await this.ctx.storage.get<string>("baseline");
      const result = await this.#execute([CODING_PYTHON, "-I", "-c", CODING_TOOL_PROGRAM], stream(bytes(JSON.stringify({ kind: "review_diff", baseline }))), Math.min(input.deadlineAt, Date.now() + 30_000), CODING_OUTPUT_BYTES);
      if (result.exitCode !== 0) throw new Error("coding_review_diff_failed");
      await this.#save(input, result);
      return result;
    } catch (error) { await this.#fail(error); throw error; }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.ctx.storage.put("stopped", true);
    // A failed destroy leaves a durable retry alarm and never acknowledges stop.
    await this.ctx.storage.setAlarm(Date.now() + 3000);
    if (!this.#shutdown) this.#shutdown = this.ctx.container?.destroy() ?? Promise.resolve();
    try { await this.#shutdown; } catch { this.#shutdown = undefined; throw new Error("executor_cleanup_failed"); }
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> { await this.stop(); }

  /** Called only by the trusted outbound Worker, never through the application router. */
  async reserveEgress(input: Pick<CodingIdentity, "runId" | "generation" | "deadlineAt"> & { bytes: number; newRequest: boolean }): Promise<boolean> {
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > 100 * 1024 * 1024 || typeof input.newRequest !== "boolean") return false;
    return this.ctx.storage.transaction(async storage => {
      const identity = await storage.get<Identity>("identity");
      if (this.#stopped || await storage.get("stopped") || !identity || identity.runId !== input.runId || identity.generation !== input.generation || identity.deadlineAt !== input.deadlineAt || Date.now() >= identity.deadlineAt) return false;
      const budget = await storage.get<{ bytes: number; requests: number }>("egress") ?? { bytes: 0, requests: 0 };
      const next = { bytes: budget.bytes + input.bytes, requests: budget.requests + (input.newRequest ? 1 : 0) };
      if (next.bytes > 1024 * 1024 * 1024 || next.requests > 2000) return false;
      await storage.put("egress", next);
      return true;
    });
  }

  async #claim(input: Fence, operation: unknown): Promise<CodingToolResult | CodingSnapshot | null> {
    if (!identifier(input.stepId) || !identifier(input.runId) || !Number.isSafeInteger(input.generation) || !Number.isSafeInteger(input.deadlineAt)) throw new Error("invalid_coding_step");
    const digest = await fingerprint({ runId: input.runId, generation: input.generation, deadlineAt: input.deadlineAt, stepId: input.stepId, operation });
    const receipt = await this.ctx.storage.transaction(async storage => {
      if (this.#stopped || await storage.get("stopped")) throw new Error("executor_stopped");
      const identity = await storage.get<Identity>("identity");
      if (!identity || identity.runId !== input.runId || identity.generation !== input.generation || identity.deadlineAt !== input.deadlineAt) throw new Error("executor_identity_mismatch");
      this.#assertTime(input.deadlineAt);
      if (!await storage.get("ready")) throw new Error("executor_not_ready");
      const previous = await storage.get<Receipt>(`step:${input.stepId}`);
      if (previous) {
        if (previous.fingerprint !== digest) throw new Error("step_identity_mismatch");
        if (previous.status !== "done") throw new Error("executor_already_started");
        return previous;
      }
      if (await storage.get("active")) throw new Error("executor_busy");
      const count = await storage.get<number>("steps") ?? 0;
      if (count >= 200) throw new Error("executor_step_limit");
      await storage.put({ [`step:${input.stepId}`]: { fingerprint: digest, status: "running" }, active: input.stepId, steps: count + 1 });
      return null;
    });
    if (!receipt) return null;
    const chunks = await Promise.all(Array.from({ length: receipt.chunks! }, (_, index) => this.ctx.storage.get<Uint8Array>(`result:${input.stepId}:${index}`)));
    if (chunks.some(chunk => !chunk)) throw new Error("executor_receipt_missing");
    const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk!.length, 0));
    let offset = 0; for (const chunk of chunks) { output.set(chunk!, offset); offset += chunk!.length; }
    return JSON.parse(new TextDecoder().decode(output)) as CodingToolResult | CodingSnapshot;
  }

  async #save(input: Fence, result: CodingToolResult | CodingSnapshot): Promise<void> {
    const data = bytes(JSON.stringify(result));
    const chunks = Math.ceil(data.length / 60_000);
    for (let index = 0; index < chunks; index++) {
      this.#assertTime(input.deadlineAt);
      await this.ctx.storage.put(`result:${input.stepId}:${index}`, data.slice(index * 60_000, (index + 1) * 60_000));
    }
    await this.ctx.storage.transaction(async storage => {
      if (this.#stopped || await storage.get("stopped")) throw new Error("executor_stopped");
      this.#assertTime(input.deadlineAt);
      const previous = await storage.get<Receipt>(`step:${input.stepId}`);
      if (!previous || previous.status !== "running" || await storage.get("active") !== input.stepId) throw new Error("executor_step_changed");
      await storage.put(`step:${input.stepId}`, { ...previous, status: "done", chunks });
      await storage.delete("active"); await storage.setAlarm(input.deadlineAt);
    });
  }

  async #execute(argv: string[], stdin: ReadableStream<Uint8Array>, deadlineAt: number, limit: number): Promise<CodingToolResult> {
    this.#assertTime(deadlineAt);
    const container = this.ctx.container;
    if (!container?.running) throw new Error("executor_not_running");
    const startedAt = Date.now();
    await this.ctx.storage.setAlarm(deadlineAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("executor_timeout")), Math.max(1, deadlineAt - Date.now())); });
      const stopped = container.monitor().then(() => { throw new Error(this.#stopped ? "executor_stopped" : "executor_container_stopped"); });
      const run = (async () => {
        const process = await container.exec(argv, { stdin, stdout: "pipe", stderr: "combined" });
        const [output, exitCode] = await Promise.all([boundedStream(process.stdout, limit), process.exitCode]);
        this.#assertTime(deadlineAt);
        return { ...output, exitCode, startedAt, finishedAt: Date.now() };
      })();
      return await Promise.race([run, timeout, stopped]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  #assertTime(deadlineAt: number): void {
    if (this.#stopped) throw new Error("executor_stopped");
    if (Date.now() >= deadlineAt) throw new Error("executor_timeout");
  }

  async #fail(error: unknown): Promise<never> {
    const canceled = this.#stopped;
    await this.stop();
    if (canceled) throw new Error("executor_stopped");
    const code = error instanceof Error && /^(?:executor|coding|repository)_[a-z_]{1,80}$/.test(error.message) ? error.message : "coding_executor_failed";
    throw new Error(code);
  }

  #validateSnapshot(snapshot: CodingSnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.files) || snapshot.files.length > CODING_LIMITS.files || !/^[a-f0-9]{64}$/.test(snapshot.treeDigest)) throw new Error("invalid_coding_snapshot");
    const seen = new Set<string>(); let total = 0;
    for (const file of snapshot.files) {
      validateCodingTool({ kind: "write_file", path: file.path, content: file.content });
      if (file.path === "." || file.path.includes("\\") || file.path.split("/").some(p => !p || p === ".") || /^\.github\/workflows(?:\/|$)/i.test(file.path) || file.path.toLowerCase() === ".gitmodules"
        || !["100644", "100755"].includes(file.mode) || seen.has(file.path)) throw new Error("invalid_coding_snapshot");
      seen.add(file.path); total += file.content === null ? 0 : bytes(file.content).length;
    }
    if (total > CODING_LIMITS.changeBytes) throw new Error("coding_snapshot_limit");
  }
}
