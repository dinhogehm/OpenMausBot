import type { CredentialProvider } from "./credentials";

export const CODING_LIMITS = {
  durationMs: 30 * 60_000, modelCalls: 30, outputTokens: 4096,
  totalTokens: 240_000, contextBytes: 192_000, toolOutputBytes: 32_768,
  files: 100, fileBytes: 1_048_576, changeBytes: 10_485_760,
} as const;

export interface CodingIdentity {
  organizationId: string; workspaceId: string; runId: string;
  generation: number; deadlineAt: number;
}
export type CodingTool =
  | { kind: "list_files"; path: string }
  | { kind: "read_file"; path: string; offset: number; limit: number }
  | { kind: "write_file"; path: string; content: string | null }
  | { kind: "run_command"; command: string; cwd: string; timeoutMs: number }
  | { kind: "graft_map" }
  | { kind: "graft_grep"; pattern: string; path: string }
  | { kind: "graft_skeleton"; path: string }
  | { kind: "graft_callers"; symbol: string; path: string; direction: "in" | "out"; depth: 1 | 2 };
export interface CodingToolResult {
  output: string; exitCode: number; truncated: boolean;
  startedAt: number; finishedAt: number;
}
export interface CodingChange { path: string; content: string | null; mode: "100644" | "100755" }
export interface CodingSnapshot { files: CodingChange[]; treeDigest: string }
export function canonicalCodingChanges(files: CodingChange[]): string {
  const encoder = new TextEncoder();
  const compare = (a: CodingChange, b: CodingChange) => {
    const left = encoder.encode(a.path); const right = encoder.encode(b.path);
    for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
    return left.length - right.length;
  };
  return JSON.stringify([...files].sort(compare).map(({ path, content, mode }) => ({ path, content, mode })));
}
export async function codingTreeDigest(files: CodingChange[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCodingChanges(files));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export interface CodingExecutorStub {
  init(input: CodingIdentity & { baseSha: string; archive: ReadableStream<Uint8Array> }): Promise<{ ready: true }>;
  step(input: Pick<CodingIdentity, "runId" | "generation" | "deadlineAt"> & { stepId: string; tool: CodingTool }): Promise<CodingToolResult>;
  snapshot(input: Pick<CodingIdentity, "runId" | "generation" | "deadlineAt"> & { stepId: string }): Promise<CodingSnapshot>;
  reviewDiff(input: Pick<CodingIdentity, "runId" | "generation" | "deadlineAt"> & { stepId: string }): Promise<CodingToolResult>;
  stop(): Promise<void>;
}
export type CodingStatus = "pending_approval" | "queued" | "running" | "testing" | "publishing" | "completed" | "failed" | "canceled" | "interrupted";
export interface CodingRunInput {
  requestId: string; repositoryConnectionId: string; baseRef: string;
  task: string; provider: CredentialProvider; model: string;
  setupCommand: string; testCommand: string;
  modelSource?: { kind: "claude-code"; connectionVersion: number };
  agentSelections?: { catalogVersion: number; coordinator: string; programmer: string; reviewer: string };
}
export type AgentRole = "coordinator" | "programmer" | "reviewer";
export interface AgentProfile {
  role: AgentRole; name: string; instructions: string;
  provider: CredentialProvider | "inherit"; model: string;
}
export interface ResolvedAgent extends Omit<AgentProfile, "provider"> {
  provider: CredentialProvider; credentialVersion: number;
  modelSource?: { kind: "claude-code"; connectionVersion: number };
  profileId?: string; profileRevision?: number; catalogVersion?: number;
}
export interface CodingEvent {
  id: number; at: number; kind: "status" | "model" | "tool" | "test" | "error";
  text: string; exitCode?: number; truncated?: boolean;
}
export interface CodingRecord extends CodingRunInput, CodingIdentity {
  missionId?: string;
  createdBy: string; approvedBy?: string; createdAt: number; updatedAt: number;
  approvedAt?: number; startedAt?: number; finishedAt?: number; publishedAt?: number;
  status: CodingStatus; repositoryName: string; credentialVersion: number;
  baseSha?: string; baseTreeSha?: string; modelCalls: number; tokens: number;
  error?: string; summary?: string; events: CodingEvent[];
  agentStage?: AgentRole; agents?: ResolvedAgent[]; plan?: string;
  review?: { approved: boolean; summary: string; at: number };
  verification?: { command: string; exitCode: number; treeDigest: string; output: string; finishedAt: number; truncated: boolean };
  result?: { branch: string; commitSha: string; prUrl: string; prNumber: number; changedFiles: number };
}
