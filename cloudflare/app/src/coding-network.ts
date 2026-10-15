import { WorkerEntrypoint } from "cloudflare:workers";
import type { CodingExecutor } from "./coding-executor";

type Reserve = (bytes: number, newRequest: boolean) => Promise<boolean>;

const destinations: Record<string, RegExp> = {
  "registry.npmjs.org": /^\//,
  "registry.yarnpkg.com": /^\//,
  "nodejs.org": /^\/(?:dist|download\/release)\//,
  "pypi.org": /^\/(?:simple(?:\/|$)|pypi\/[^/]+\/json$)/,
  "files.pythonhosted.org": /^\/packages\//,
};

export function isAllowedDependencyRequest(request: Request): boolean {
  const url = new URL(request.url);
  return (request.method === "GET" || request.method === "HEAD") && url.protocol === "https:"
    && !url.username && !url.password && (!url.port || url.port === "443")
    && !url.search && !url.hash && Boolean(destinations[url.hostname]?.test(url.pathname));
}

export async function proxyDependencyRequest(request: Request, deadlineAt: number,
  fetcher: (request: Request) => Promise<Response> = fetch, reserve: Reserve = async () => true): Promise<Response> {
  if (!Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt) return new Response("Execution expired", { status: 403 });
  if (!isAllowedDependencyRequest(request)) return new Response("Dependency destination denied", { status: 403 });
  if (!await reserve(0, true)) return new Response("Dependency budget exhausted", { status: 429 });
  // No cookies, authorization, arbitrary headers or redirects cross this boundary.
  const upstream = await fetcher(new Request(request.url, {
    method: request.method, redirect: "manual", headers: { Accept: request.headers.get("accept") ?? "*/*", "User-Agent": "Veltram dependency downloader" },
    signal: AbortSignal.timeout(Math.min(120_000, deadlineAt - Date.now())),
  }));
  if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return new Response("Dependency redirect denied", { status: 502 }); }
  if (Number(upstream.headers.get("content-length") ?? 0) > 100 * 1024 * 1024) { await upstream.body?.cancel(); return new Response("Dependency too large", { status: 502 }); }
  let count = 0;
  const body = upstream.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ async transform(chunk, controller) {
    count += chunk.length;
    if (count > 100 * 1024 * 1024 || Date.now() >= deadlineAt) throw new Error("dependency_limit");
    if (!await reserve(chunk.length, false)) throw new Error("dependency_budget_exhausted");
    controller.enqueue(chunk);
  } }));
  const headers = new Headers();
  for (const name of ["content-type", "content-encoding", "cache-control", "etag"]) {
    const value = upstream.headers.get(name); if (value) headers.set(name, value);
  }
  return new Response(body ?? null, { status: upstream.status, headers });
}

interface NetworkProps { executorId: string; runId: string; generation: number; deadlineAt: number }
export class CodingDependencyNetwork extends WorkerEntrypoint<{ CODING_EXECUTORS: DurableObjectNamespace<CodingExecutor> }, NetworkProps> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    const executor = this.env.CODING_EXECUTORS.get(this.env.CODING_EXECUTORS.idFromString(props.executorId));
    return proxyDependencyRequest(request, props.deadlineAt, fetch, (bytes, newRequest) => executor.reserveEgress({ runId: props.runId, generation: props.generation, deadlineAt: props.deadlineAt, bytes, newRequest }));
  }
}
