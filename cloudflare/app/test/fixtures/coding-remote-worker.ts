import localFixture from "./coding-runtime-worker";
import type { CodingExecutor } from "../../src/coding-executor";
export { CodingExecutor } from "../../src/coding-executor";
export { CodingDependencyNetwork } from "../../src/coding-network";

interface FixtureEnv {
  CODING_EXECUTORS: DurableObjectNamespace<CodingExecutor>;
  FIXTURE_TOKEN_HASH: string;
  FIXTURE_EXPIRES_AT: string;
  FIXTURE_RUN_ID: string;
}

/** Explicitly deployed disposable proof only. Never imported by the app. */
export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const expiresAt = Number(env.FIXTURE_EXPIRES_AT);
    const authorization = request.headers.get("authorization") ?? "";
    if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt || !/^[a-f0-9]{64}$/.test(env.FIXTURE_TOKEN_HASH ?? "") || !/^Bearer [a-f0-9]{64}$/.test(authorization)) return new Response(null, { status: 403 });
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization.slice(7)))), byte => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== env.FIXTURE_TOKEN_HASH) return new Response(null, { status: 403 });
    const url = new URL(request.url);
    if (request.method !== "POST" || !["/init", "/step", "/snapshot", "/diff", "/stop"].includes(url.pathname)) return new Response(null, { status: 404 });
    try {
      const input = (url.pathname === "/init" ? JSON.parse(request.headers.get("x-fixture-input") ?? "null") : await request.clone().json()) as { organizationId: string; workspaceId: string; runId: string; generation: number; deadlineAt: number };
      // Exactly one DO/VM may ever be allocated by this temporary deployment.
      if (input.organizationId !== "native_fixture" || input.workspaceId !== "native_fixture" || input.runId !== env.FIXTURE_RUN_ID || input.generation !== 1 || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt > expiresAt || input.deadlineAt > Date.now() + 180_000) return new Response(null, { status: 403 });
      return localFixture.fetch(new Request("http://127.0.0.1" + url.pathname, request), env);
    } catch { return new Response(null, { status: 400 }); }
  },
};
