import type { CodingRecord, CodingRunInput } from "./coding-types";

export interface MissionScope { organizationId: string; workspaceId: string; userId: string }
export interface MissionInput extends Omit<CodingRunInput, "task" | "agentSelections"> {
  goal: string;
  acceptanceCriteria: string[];
  delivery: "pull_request" | "merge_and_deploy";
  tasks: { title: string; instructions: string }[];
}
export type MissionStatus = "active" | "paused" | "paused_budget" | "paused_subscription" | "paused_authorization" | "reconciling" | "awaiting_delivery" | "completed" | "failed" | "interrupted" | "canceling" | "canceled";
export interface MissionEvidence {
  runId: string; generation: number; runUpdatedAt: number; observedAt: number; status: CodingRecord["status"];
  test?: { exitCode: number; treeDigest: string; finishedAt: number };
  reviewApproved: boolean;
  pullRequest?: { url: string; number: number; commitSha: string; branch: string };
  error?: string;
}
export interface MissionTask {
  title: string; instructions: string; runId: string; attempt: number;
  status: "queued" | "dispatching" | "running" | "completed" | "failed" | "interrupted" | "canceled";
  dispatchedAt?: number; finishedAt?: number; error?: string; evidence?: MissionEvidence;
  previousAttempts?: MissionEvidence[];
}
export interface MissionRecord extends Omit<MissionInput, "tasks"> {
  missionId: string; organizationId: string; workspaceId: string; createdBy: string;
  version: number; status: MissionStatus; createdAt: number; updatedAt: number; finishedAt?: number;
  tasks: MissionTask[]; nextWakeAt?: number; error?: string;
  deliveryEvidence: "not_observed" | "pull_requests_verified" | "project_adapter_required";
}
export interface MissionCodingScope extends MissionScope { missionId: string }
export interface MissionCodingRpc {
  createFromMission(input: MissionCodingScope & { input: CodingRunInput }): Promise<{ run: CodingRecord }>;
  getFromMission(input: MissionCodingScope & { runId: string }): Promise<{ run: CodingRecord | null }>;
  /** Must tombstone the deterministic run ID even when create has not committed yet. */
  cancelFromMission(input: MissionCodingScope & { runId: string }): Promise<{ run: CodingRecord | null }>;
}
export interface MissionCommand extends MissionScope {
  action: "create" | "list" | "get" | "pause" | "resume" | "cancel";
  missionId?: string; body: Record<string, unknown>;
}
export const MISSION_LIMITS = { active: 50, tasks: 20, attempts: 3, pollMs: 30_000, bodyBytes: 65_536 } as const;
export const isMissionId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const missionTerminal = (status: MissionStatus) => ["completed", "failed", "canceled"].includes(status);

export function parseMissionInput(body: Record<string, unknown>): MissionInput {
  const invalid = () => { throw new Error("mission_invalid_input"); };
  const text = (value: unknown, max: number, empty = false) => {
    if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0") || value.length > max || !empty && !value.trim()) return invalid();
    return value.trim();
  };
  const requestId = text(body.requestId, 36);
  const goal = text(body.goal, 1000);
  const repositoryConnectionId = text(body.repositoryConnectionId, 80);
  const baseRef = text(body.baseRef, 200);
  const model = text(body.model, 120);
  if (!isMissionId(requestId) || !/^[A-Za-z0-9_-]+$/.test(repositoryConnectionId) || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(baseRef) || baseRef.includes("..") || baseRef.includes("//") || baseRef.endsWith("/") || !/^[A-Za-z0-9_][A-Za-z0-9_./:@-]*$/.test(model) || !["openai", "anthropic", "openrouter"].includes(String(body.provider))) return invalid();
  if (!Array.isArray(body.acceptanceCriteria) || !body.acceptanceCriteria.length || body.acceptanceCriteria.length > 10) return invalid();
  const acceptanceCriteria = body.acceptanceCriteria.map(value => text(value, 200));
  if (acceptanceCriteria.join("\n").length > 800 || !Array.isArray(body.tasks) || !body.tasks.length || body.tasks.length > MISSION_LIMITS.tasks) return invalid();
  const tasks = body.tasks.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    return { title: text(value.title, 100), instructions: text(value.instructions, 1600) };
  });
  if (body.delivery !== "pull_request" && body.delivery !== "merge_and_deploy") return invalid();
  let modelSource: CodingRunInput["modelSource"];
  if (body.modelSource !== undefined) {
    const source = body.modelSource as Record<string, unknown> | null;
    if (!source || source.kind !== "claude-code" || body.provider !== "anthropic" || !Number.isSafeInteger(source.connectionVersion) || Number(source.connectionVersion) < 1) return invalid();
    modelSource = { kind: "claude-code", connectionVersion: Number(source.connectionVersion) };
  }
  return { requestId, goal, acceptanceCriteria, repositoryConnectionId, baseRef, provider: body.provider as CodingRunInput["provider"], model,
    setupCommand: text(body.setupCommand, 2000, true), testCommand: text(body.testCommand, 2000), delivery: body.delivery, tasks, ...(modelSource ? { modelSource } : {}) };
}

export async function missionRunId(scope: Pick<MissionScope, "organizationId" | "workspaceId">, missionId: string, index: number, attempt: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["veltram-mission-v1", scope.organizationId, scope.workspaceId, missionId, index, attempt]))));
  digest[6] = (digest[6] & 15) | 80; digest[8] = (digest[8] & 63) | 128;
  const hex = Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function missionCodingInput(mission: MissionRecord, task: MissionTask): CodingRunInput {
  return { requestId: task.runId, repositoryConnectionId: mission.repositoryConnectionId, baseRef: mission.baseRef, provider: mission.provider, model: mission.model,
    setupCommand: mission.setupCommand, testCommand: mission.testCommand,
    task: `Mission objective: ${mission.goal}\nAcceptance criteria:\n${mission.acceptanceCriteria.map(item => `- ${item}`).join("\n")}\nDeclared task: ${task.title}\n${task.instructions}\nDelivery policy: ${mission.delivery}. Respect the repository's delivery controls. A pull request is not proof of merge or production publication.`,
    ...(mission.modelSource ? { modelSource: mission.modelSource } : {}) };
}

export function nextBudgetDay(now: number): number {
  const brt = new Date(now - 3 * 3_600_000);
  return Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate() + 1, 3);
}
