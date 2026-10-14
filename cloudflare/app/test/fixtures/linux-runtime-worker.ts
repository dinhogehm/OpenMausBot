import type { LinuxExecutor } from "../../src/linux-executor";
import type { LinuxProofInput } from "../../src/linux-proof";

export { LinuxExecutor } from "../../src/linux-executor";

// Local acceptance fixture only; this file is not the application's entrypoint.
export default {
  async fetch(request: Request, env: { LINUX_EXECUTORS: DurableObjectNamespace<LinuxExecutor> }): Promise<Response> {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return new Response(null, { status: 403 });
    if (request.method !== "POST" || !["/execute", "/stop"].includes(url.pathname)) return new Response(null, { status: 404 });
    const input = await request.json() as LinuxProofInput;
    const executor = env.LINUX_EXECUTORS.getByName(JSON.stringify([input.organizationId, input.workspaceId, input.runId, input.generation]));
    try {
      if (url.pathname === "/stop") {
        await executor.stop();
        return Response.json({ stopped: true });
      }
      return Response.json(await executor.execute(input));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "fixture_failed" }, { status: 409 });
    }
  },
};
