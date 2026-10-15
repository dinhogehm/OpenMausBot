import type { CodingExecutor } from "../../src/coding-executor";
import type { CodingIdentity, CodingTool } from "../../src/coding-types";
export { CodingExecutor } from "../../src/coding-executor";
export { CodingDependencyNetwork } from "../../src/coding-network";

// Isolated loopback fixture. Never the production entrypoint.
export default {
  async fetch(request: Request, env: { CODING_EXECUTORS: DurableObjectNamespace<CodingExecutor> }): Promise<Response> {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return new Response(null, { status: 403 });
    if (request.method !== "POST") return new Response(null, { status: 404 });
    try {
      const input = (url.pathname === "/init" ? JSON.parse(request.headers.get("x-fixture-input") ?? "null") : await request.json()) as CodingIdentity & { baseSha: string; stepId: string; tool: CodingTool };
      const executor = env.CODING_EXECUTORS.getByName(JSON.stringify([input.organizationId, input.workspaceId, input.runId, input.generation]));
      if (url.pathname === "/init" && request.body) return Response.json(await executor.init({ ...input, archive: request.body }));
      if (url.pathname === "/step") return Response.json(await executor.step(input));
      if (url.pathname === "/snapshot") return Response.json(await executor.snapshot(input));
      if (url.pathname === "/diff") return Response.json(await executor.reviewDiff(input));
      if (url.pathname === "/stop") { await executor.stop(); return Response.json({ stopped: true }); }
      return new Response(null, { status: 404 });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "fixture_failed" }, { status: 409 }); }
  },
};
