import type { CodingRunInput, CodingRecord, CodingStatus } from "./coding-types";
import type { MemberRole } from "./organizations";
import { HttpError } from "./http";

export function parseCodingInput(body: Record<string, unknown>): CodingRunInput {
  const string = (name: string, max: number, empty = false) => {
    const value = body[name];
    if (typeof value !== "string" || !value.isWellFormed() || value.length > max || (!empty && !value.trim()) || value.includes("\0")) throw new HttpError(400, "invalid_coding_task");
    return value.trim();
  };
  const requestId = string("requestId", 36);
  const repositoryConnectionId = string("repositoryConnectionId", 80);
  const baseRef = string("baseRef", 200);
  const model = string("model", 120);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
    || !/^[\w-]+$/.test(repositoryConnectionId) || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(baseRef)
    || baseRef.includes("..") || baseRef.includes("//") || baseRef.endsWith("/") || !/^[A-Za-z0-9_][A-Za-z0-9_./:@-]*$/.test(model)
    || !["openai", "anthropic", "openrouter"].includes(String(body.provider))) throw new HttpError(400, "invalid_coding_task");
  return { requestId, repositoryConnectionId, baseRef, model, provider: body.provider as CodingRunInput["provider"],
    task: string("task", 4000), setupCommand: string("setupCommand", 2000, true), testCommand: string("testCommand", 2000) };
}
export function codingTerminal(status: CodingStatus): boolean {
  return ["completed", "failed", "canceled", "interrupted"].includes(status);
}
export function codingView(run: CodingRecord, userId: string, role: MemberRole) {
  return { ...run, canApprove: role !== "member" && run.status === "pending_approval",
    canCancel: !codingTerminal(run.status) && (role !== "member" || run.createdBy === userId) };
}
export function codingExecutorName(run: CodingRecord): string {
  return `${run.organizationId}/${run.workspaceId}/${run.runId}/${run.generation}`;
}
