import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { LinuxExecutor } from "../src/linux-executor.ts";

const input = { runId: "run_1", organizationId: "org_1", workspaceId: "workspace_1", generation: 1, message: "prova 🚀", delayMs: 0, deadlineAt: Date.now() + 55_000 };

function fixtureContainer() {
  let starts = 0;
  let executions = 0;
  let destroys = 0;
  let running = false;
  let startOptions: ContainerStartupOptions | undefined;
  let resolveMonitor: (() => void) | undefined;
  let complete: (() => void) | undefined;
  let releaseStartup: (() => void) | undefined;
  let defer = false;
  let slowStartup = false;
  let destroyFailsOnce = false;
  const container = {
    get running() { return running; },
    start(options: ContainerStartupOptions) { starts++; running = true; startOptions = options; },
    async setInactivityTimeout() { if (slowStartup) await new Promise<void>((resolve) => { releaseStartup = resolve; }); },
    monitor() { return new Promise<void>((resolve) => { resolveMonitor = resolve; }); },
    async destroy() {
      destroys++;
      if (destroyFailsOnce) { destroyFailsOnce = false; throw new Error("synthetic cleanup failure"); }
      running = false; resolveMonitor?.(); complete?.(); releaseStartup?.();
    },
    async exec(argv: string[], options: ContainerExecOptions) {
      executions++;
      expect(argv[0]).toBe("node");
      expect(options.env).toBeUndefined();
      expect(options.stderr).toBe("ignore");
      const bytes = new Uint8Array(await new Response(options.stdin as ReadableStream).arrayBuffer());
      const gate = defer ? new Promise<void>((resolve) => { complete = resolve; }) : Promise.resolve();
      return {
        stdout: new ReadableStream({ async start(controller) { await gate; controller.enqueue(bytes); controller.close(); } }),
        exitCode: gate.then(() => 0),
      };
    },
  };
  return {
    container, defer: () => { defer = true; }, delayStartup: () => { slowStartup = true; }, failNextDestroy: () => { destroyFailsOnce = true; },
    get starts() { return starts; }, get executions() { return executions; }, get destroys() { return destroys; }, get startOptions() { return startOptions; },
  };
}

async function inExecutor<T>(callback: (instance: LinuxExecutor, state: DurableObjectState) => T | Promise<T>) {
  const namespace = (env as unknown as { LINUX_EXECUTORS: DurableObjectNamespace<LinuxExecutor> }).LINUX_EXECUTORS;
  return runInDurableObject(namespace.get(namespace.newUniqueId()), callback);
}

describe("LinuxExecutor attempt isolation", () => {
  it("refuses dispatch after the coordinator deadline without starting a container", async () => {
    await inExecutor(async (executor, state) => {
      const fixture = fixtureContainer();
      Object.defineProperty(state, "container", { configurable: true, value: fixture.container });
      await expect(executor.execute({ ...input, deadlineAt: Date.now() - 1 })).rejects.toThrow("executor_deadline_elapsed");
      await expect(executor.execute({ ...input, deadlineAt: Date.now() + 61_000 })).rejects.toThrow("invalid_proof_deadline");
      expect(fixture.starts).toBe(0);
    });
  });
  it("returns the artifact, destroys the container, and replays the receipt without executing twice", async () => {
    await inExecutor(async (executor, state) => {
      const fixture = fixtureContainer();
      Object.defineProperty(state, "container", { configurable: true, value: fixture.container });
      const result = await executor.execute(input);
      expect(result).toEqual({ stdout: input.message, artifact: input.message, exitCode: 0 });
      expect(fixture.startOptions).toMatchObject({ enableInternet: false, image: "cloudflare/debian-trixie", instance: "lite" });
      expect(fixture.startOptions?.env).toBeUndefined();
      expect(fixture.destroys).toBe(1);
      expect(await executor.execute(input)).toEqual(result);
      expect(fixture.starts).toBe(1);
      expect(fixture.executions).toBe(1);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("destroys a startup that exceeds the absolute deadline without executing its command", async () => {
    await inExecutor(async (executor, state) => {
      const fixture = fixtureContainer();
      fixture.delayStartup();
      Object.defineProperty(state, "container", { configurable: true, value: fixture.container });
      await expect(executor.execute({ ...input, deadlineAt: Date.now() + 100 })).rejects.toThrow();
      expect(fixture.starts).toBe(1);
      expect(fixture.executions).toBe(0);
      expect(fixture.destroys).toBe(1);
    });
  });

  it("rejects reuse of an instance for another tenant or another input", async () => {
    await inExecutor(async (executor, state) => {
      const fixture = fixtureContainer();
      Object.defineProperty(state, "container", { configurable: true, value: fixture.container });
      await executor.execute(input);
      await expect(executor.execute({ ...input, organizationId: "other_org" })).rejects.toThrow("executor_identity_mismatch");
      await expect(executor.execute({ ...input, message: "different" })).rejects.toThrow("executor_identity_mismatch");
      expect(fixture.executions).toBe(1);
    });
  });

  it("persists a stop before dispatch so a late RPC cannot start a container", async () => {
    await inExecutor(async (executor, state) => {
      const fixture = fixtureContainer();
      Object.defineProperty(state, "container", { configurable: true, value: fixture.container });
      await executor.stop();
      await expect(executor.execute(input)).rejects.toThrow("executor_stopped");
      expect(fixture.starts).toBe(0);
    });
  });

  it("destroys an in-flight container and refuses to publish a late successful output", async () => {
    await inExecutor(async (executor, state) => {
      const fixture = fixtureContainer();
      fixture.defer();
      Object.defineProperty(state, "container", { configurable: true, value: fixture.container });
      const execution = executor.execute(input);
      const rejection = expect(execution).rejects.toThrow();
      while (fixture.executions === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      await expect(executor.execute(input)).rejects.toThrow("executor_already_started");
      await executor.stop();
      await rejection;
      expect(fixture.destroys).toBe(1);
      await expect(executor.execute(input)).rejects.toThrow("executor_stopped");
    });
  });

  it("does not acknowledge stop when teardown fails, and retries teardown on the next stop", async () => {
    await inExecutor(async (executor, state) => {
      const fixture = fixtureContainer();
      fixture.failNextDestroy();
      Object.defineProperty(state, "container", { configurable: true, value: fixture.container });
      await expect(executor.stop()).rejects.toThrow("executor_cleanup_failed");
      await executor.stop();
      expect(fixture.destroys).toBe(2);
      await expect(executor.execute(input)).rejects.toThrow("executor_stopped");
    });
  });
});
