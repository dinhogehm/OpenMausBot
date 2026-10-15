import { DurableObject } from "cloudflare:workers";
import { ClaudeNativeRuntime } from "../../src/claude-runtime";
import { CLAUDE_ENV, CLAUDE_PREFIX } from "../../src/claude-program";
interface Env { PROOF: DurableObjectNamespace<ClaudeSnapshotProof>; FIXTURE_TOKEN_HASH: string; FIXTURE_EXPIRES_AT: string; FIXTURE_RUN_ID: string }
interface ProofResult { checks: Record<string, boolean | number>; failure: string | null; authenticated: false; paidModelRequests: 0; snapshotContains: string; snapshotRetention: string }
const markerPath = "/home/claude/veltram-public-synthetic-marker";
export class ClaudeSnapshotProof extends DurableObject<Env> {
  async prove() {
    const known = await this.ctx.storage.get<ProofResult>("result"); if (known) return known;
    await this.ctx.storage.transaction(async storage => { if (await storage.get("claimed")) throw new Error("proof_already_started"); await storage.put("claimed", true); });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90_000);
    const checks: Record<string, boolean | number> = {}; let failure: string | undefined;
    try {
      if (!this.ctx.container) throw new Error("missing_container");
      await this.ctx.storage.setAlarm(Date.now() + 95_000);
      const runtime = new ClaudeNativeRuntime(this.ctx.container);
      await runtime.start(undefined, controller.signal);
      checks.initiallyLoggedOut = !(await runtime.authStatus(controller.signal)).authenticated;
      if (!checks.initiallyLoggedOut) throw new Error("fixture_must_be_unauthenticated");
      const marker = `PUBLIC_SYNTHETIC_${this.env.FIXTURE_RUN_ID}`;
      const write = `const f=require('fs'); f.writeFileSync(${JSON.stringify(markerPath)},${JSON.stringify(marker)}); process.stdout.write(f.readFileSync('/proc/self/status','utf8'));`;
      const process = await this.ctx.container.exec([...CLAUDE_PREFIX.slice(0, -1), "/usr/local/bin/node", "-e", write], { cwd: "/opt/veltram/request", env: { ...CLAUDE_ENV }, stdout: "pipe", stderr: "pipe", signal: controller.signal });
      const output = await process.output(); const status = new TextDecoder().decode(output.stdout);
      checks.unprivileged = output.exitCode === 0 && /^Uid:\s+1000\s+1000\s+1000\s+1000$/m.test(status)
        && ["CapEff", "CapPrm", "CapBnd", "CapAmb"].every(key => new RegExp(`^${key}:\\s+0+$`, "m").test(status)) && /^NoNewPrivs:\s+1$/m.test(status);
      if (!checks.unprivileged) throw new Error("native_capabilities_not_dropped");
      const snapshot = await runtime.snapshot(controller.signal); checks.snapshotBytes = snapshot.size; checks.snapshotCreated = !!snapshot.id;
      await this.ctx.container.destroy(); checks.firstDestroyed = !this.ctx.container.running;
      await runtime.start(snapshot, controller.signal);
      const read = await this.ctx.container.exec([...CLAUDE_PREFIX.slice(0, -1), "/usr/local/bin/node", "-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(markerPath)}))`], { cwd: "/opt/veltram/request", env: { ...CLAUDE_ENV }, stdout: "pipe", stderr: "pipe", signal: controller.signal });
      const restored = await read.output(); checks.markerRestored = restored.exitCode === 0 && new TextDecoder().decode(restored.stdout) === marker;
      checks.restoredLoggedOut = !(await runtime.authStatus(controller.signal)).authenticated;
      if (!checks.firstDestroyed || !checks.markerRestored || !checks.restoredLoggedOut) throw new Error("snapshot_roundtrip_failed");
    } catch (error) { failure = error instanceof Error ? error.message.slice(0, 1000) : "proof_failed"; }
    finally {
      clearTimeout(timer); controller.abort();
      try { await this.ctx.container?.destroy(); checks.finalDestroyed = !this.ctx.container?.running; if (checks.finalDestroyed) await this.ctx.storage.deleteAlarm(); }
      catch { checks.finalDestroyed = false; }
    }
    const result: ProofResult = { checks, failure: failure ?? null, authenticated: false, paidModelRequests: 0, snapshotContains: "filesystem and public synthetic marker; no account credentials", snapshotRetention: "30 days; platform has no delete API" };
    await this.ctx.storage.put("result", result); return result;
  }
  async alarm() { await this.ctx.storage.setAlarm(Date.now() + 5000); await this.ctx.container?.destroy(); await this.ctx.storage.deleteAlarm(); }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const expiresAt = Number(env.FIXTURE_EXPIRES_AT), token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token || !Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt || !/^[a-f0-9]{64}$/.test(env.FIXTURE_TOKEN_HASH)) return new Response(null, { status: 403 });
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== env.FIXTURE_TOKEN_HASH) return new Response(null, { status: 403 });
    const url = new URL(request.url); if (request.method !== "POST" || url.pathname !== "/prove") return new Response(null, { status: 404 });
    try { const result = await env.PROOF.getByName(env.FIXTURE_RUN_ID).prove(); return Response.json(result, { status: result.failure || !result.checks.finalDestroyed ? 500 : 200 }); }
    catch (error) { return Response.json({ failure: error instanceof Error ? error.message.slice(0, 1000) : "proof_failed" }, { status: 500 }); }
  },
};
