import { DurableObject } from "cloudflare:workers";
import { buildProofCommand, PROOF_TIMEOUT_MS, readProofOutput, validateProofInput } from "./linux-proof";
import type { LinuxProofInput, LinuxProofResult } from "./linux-proof";

interface AttemptRecord {
  fingerprint: string;
  status: "running" | "completed" | "failed";
  result?: LinuxProofResult;
}

/** One instance per organization/workspace/run/generation, selected by the coordinator. */
export class LinuxExecutor extends DurableObject<unknown> {
  #stopped = false;
  #shutdown?: Promise<void>;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    // A restarted Durable Object cannot prove whether an old command finished.
    // Stop any surviving container; never automatically replay that attempt.
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        await this.#destroy();
        const record = await ctx.storage.get<AttemptRecord>("attempt");
        if (record?.status === "running") await ctx.storage.put("attempt", { ...record, status: "failed" });
        await ctx.storage.deleteAlarm();
      });
    }
  }

  async execute(input: LinuxProofInput): Promise<LinuxProofResult> {
    validateProofInput(input);
    const bytes = new TextEncoder().encode(JSON.stringify([
      input.organizationId, input.workspaceId, input.runId, input.generation, input.message, input.delayMs, input.deadlineAt,
    ]));
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const deadlineAt = Math.min(Date.now() + PROOF_TIMEOUT_MS, input.deadlineAt);
    const replay = await this.ctx.storage.transaction(async (storage) => {
      if (this.#stopped || await storage.get("stopped")) throw new Error("executor_stopped");
      const previous = await storage.get<AttemptRecord>("attempt");
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("executor_identity_mismatch");
        if (previous.status === "completed") return previous.result!;
        throw new Error("executor_already_started");
      }
      if (deadlineAt <= Date.now()) throw new Error("executor_deadline_elapsed");
      if (input.deadlineAt > Date.now() + 60_000) throw new Error("invalid_proof_deadline");
      await storage.put<AttemptRecord>("attempt", { fingerprint, status: "running" });
      await storage.setAlarm(deadlineAt);
      return undefined;
    });
    if (replay) return replay;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("executor_timeout")), Math.max(0, deadlineAt - Date.now()));
    });
    try {
      const result = await Promise.race([this.#run(input, deadlineAt), deadline]);
      if (this.#stopped) throw new Error("executor_stopped");
      if (Date.now() >= deadlineAt) throw new Error("executor_timeout");
      await this.#destroy();
      await this.ctx.storage.transaction(async (storage) => {
        if (this.#stopped || await storage.get("stopped")) throw new Error("executor_stopped");
        await storage.put<AttemptRecord>("attempt", { fingerprint, status: "completed", result });
        await storage.deleteAlarm();
      });
      return result;
    } catch (error) {
      // Destroy the whole container: process signals do not stop descendants.
      // If destruction fails, leave the durable alarm available for a retry.
      await this.#destroy();
      await this.ctx.storage.put<AttemptRecord>("attempt", { fingerprint, status: "failed" });
      await this.ctx.storage.deleteAlarm();
      // Native teardown can reject monitor/stdout before #run observes stop.
      // Preserve the persisted cancellation after destruction is confirmed.
      if (this.#stopped) throw new Error("executor_stopped");
      const message = error instanceof Error && ["executor_timeout", "executor_stopped", "executor_deadline_elapsed", "proof_output_limit", "proof_artifact_mismatch"].includes(error.message)
        ? error.message : "executor_failed";
      throw new Error(message);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    // Persist before teardown so a delayed or retried execute RPC cannot start.
    await this.ctx.storage.put("stopped", true);
    await this.#destroy();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    await this.stop();
  }

  async #run(input: LinuxProofInput, deadlineAt: number): Promise<LinuxProofResult> {
    if (this.#stopped) throw new Error("executor_stopped");
    if (Date.now() >= deadlineAt) throw new Error("executor_deadline_elapsed");
    const container = this.ctx.container;
    if (!container) throw new Error("executor_not_configured");
    const command = buildProofCommand(input);
    this.#shutdown = undefined;
    container.start({
      image: "cloudflare/debian-trixie", instance: "lite",
      entrypoint: ["sleep", "infinity"], enableInternet: false,
    });
    const stopped = container.monitor().then(() => { throw new Error("executor_container_stopped"); });
    const commandResult = (async () => {
      await container.setInactivityTimeout(60_000);
      if (this.#stopped) throw new Error("executor_stopped");
      if (Date.now() >= deadlineAt) throw new Error("executor_deadline_elapsed");
      const process = await container.exec(command.argv, {
        stdin: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(command.stdin); controller.close(); } }),
        stdout: "pipe", stderr: "ignore",
      });
      const [stdout, exitCode] = await Promise.all([readProofOutput(process.stdout), process.exitCode]);
      if (exitCode === 0 && stdout !== input.message) throw new Error("proof_artifact_mismatch");
      return { stdout, artifact: stdout, exitCode };
    })();
    return Promise.race([commandResult, stopped]);
  }

  async #destroy(): Promise<void> {
    if (!this.#shutdown) this.#shutdown = this.ctx.container?.destroy() ?? Promise.resolve();
    try {
      await this.#shutdown;
    } catch {
      this.#shutdown = undefined;
      throw new Error("executor_cleanup_failed");
    }
  }
}
