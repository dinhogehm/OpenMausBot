import type { CodingRecord, CodingStatus } from "../../src/coding-types.ts";

export type VisibleCodingRun = CodingRecord & { canApprove: boolean; canCancel: boolean };
const progress: Record<CodingStatus, number> = {
  pending_approval: 0, queued: 1, running: 2, testing: 3, publishing: 4,
  completed: 5, failed: 5, canceled: 5, interrupted: 5,
};

export function isCodingActive(status: CodingStatus): boolean {
  return ["queued", "running", "testing", "publishing"].includes(status);
}

export function needsCodingRefresh(run: CodingRecord, now = Date.now()): boolean {
  return isCodingActive(run.status) || run.status === "pending_approval"
    || (run.status === "canceled" && !run.result && !run.error && now - run.updatedAt < 60_000);
}

export function mergeCodingRuns(current: VisibleCodingRun[], incoming: VisibleCodingRun[]): VisibleCodingRun[] {
  const byId = new Map(current.map((run) => [run.runId, run]));
  for (const run of incoming) {
    const previous = byId.get(run.runId);
    const older = previous && (run.generation < previous.generation
      || (run.generation === previous.generation && (run.updatedAt < previous.updatedAt
        || (run.updatedAt === previous.updatedAt && progress[run.status] < progress[previous.status]))));
    byId.set(run.runId, older ? { ...previous, canApprove: previous.canApprove && run.canApprove, canCancel: previous.canCancel && run.canCancel } : run);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}

export function testOutcome(run: CodingRecord): "not_run" | "passed" | "failed" {
  return !run.verification ? "not_run" : run.verification.exitCode === 0 ? "passed" : "failed";
}

function githubUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.port && !url.hash ? url : null;
  } catch { return null; }
}

export function safePullRequestUrl(value: string, repository: string): string | null {
  const url = githubUrl(value);
  if (!url || url.search || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  const prefix = `/${repository}/pull/`;
  return url.pathname.startsWith(prefix) && /^[1-9]\d*\/?$/.test(url.pathname.slice(prefix.length)) ? url.href : null;
}

export function safeGithubAuthorizationUrl(value: string): string | null {
  const url = githubUrl(value);
  if (!url) return null;
  return url.pathname === "/login/oauth/authorize" || /^\/apps\/[a-z0-9-]+\/installations\/(new|select_target)$/.test(url.pathname) ? url.href : null;
}
