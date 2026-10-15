import type { BrowserRun, BrowserRunStatus } from "../../src/browser-types";
export type VisibleBrowserRun = BrowserRun & { canApprove: boolean; canCancel: boolean };
const progress: Record<BrowserRunStatus, number> = { pending_approval: 0, queued: 1, running: 2, completed: 3, failed: 3, canceled: 3, interrupted: 3 };
export function needsBrowserRefresh(run: VisibleBrowserRun): boolean { return run.status === "queued" || run.status === "running" || run.cleanupStatus === "pending"; }
export function assertBrowserScope(runs: VisibleBrowserRun[], organizationId: string, workspaceId: string): VisibleBrowserRun[] {
  if (runs.some((run) => run.organizationId !== organizationId || run.workspaceId !== workspaceId)) throw new Error("Unexpected browser task scope");
  return runs;
}
export function mergeBrowserRuns(current: VisibleBrowserRun[], incoming: VisibleBrowserRun[]): VisibleBrowserRun[] {
  const result = new Map(current.map((run) => [run.runId, run]));
  for (const run of incoming) {
    const old = result.get(run.runId);
    const stale = old && (run.generation < old.generation || (run.generation === old.generation && (run.updatedAt < old.updatedAt || (run.updatedAt === old.updatedAt && (progress[run.status] < progress[old.status] || (old.cleanupStatus === "closed" && run.cleanupStatus === "pending"))))));
    result.set(run.runId, stale ? { ...old, canApprove: old.canApprove && run.canApprove, canCancel: old.canCancel && run.canCancel } : run);
  }
  return [...result.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}
function validHost(host: string): boolean {
  return host.length <= 253 && host.includes(".") && !/^\d+(\.\d+)*$/.test(host) && !/(^|\.)(localhost|local|internal|test|invalid|onion|arpa|home|lan)$/.test(host)
    && host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
export function browserDestination(url: string, additionalHosts: string): { initialUrl: string; allowedHosts: string[] } {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Informe um endereço HTTPS completo para iniciar."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !validHost(parsed.hostname)) throw new Error("Use um endereço HTTPS público, sem credenciais ou porta personalizada.");
  const hosts = additionalHosts.split(/[\n,]/).map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (hosts.some((host) => !validHost(host))) throw new Error("Informe nomes exatos de domínio, um por linha, sem caminhos, portas ou curingas.");
  const allowedHosts = [...new Set([parsed.hostname, ...hosts])];
  if (allowedHosts.length > 10) throw new Error("Autorize no máximo 10 domínios, incluindo o endereço inicial.");
  return { initialUrl: parsed.href, allowedHosts };
}
