/** Public metadata only. Credential files and snapshot handles never cross this interface. */
export const CLAUDE_CLI_VERSION = "2.1.300";
export const CLAUDE_LIMITS = {
  loginMs: 15 * 60_000, startupMs: 30_000, inferenceMs: 120_000,
  idleMs: 5 * 60_000, snapshotMs: 30_000, snapshotTtlMs: 30 * 24 * 60 * 60_000,
  promptBytes: 192_000, instructionsBytes: 32_000, schemaBytes: 32_000,
  resultBytes: 131_072, outputBytes: 262_144, authOutputBytes: 32_768,
  receipts: 128, receiptTtlMs: 24 * 60 * 60_000, outputTokens: 4096,
} as const;
export interface ClaudeIdentity { organizationId: string; userId: string }
export type ClaudeAuthMethod = "claude.ai" | "oauth_token" | "api_key" | "api_key_helper" | "third_party";
export type ClaudeConnectionState = "disconnected" | "connecting" | "connected" | "reconnect_required" | "disconnecting";
export interface ClaudeConnectionStatus {
  enabled: boolean; connectionVersion: number; state: ClaudeConnectionState;
  cliVersion: string; busy: boolean; lastVerifiedAt?: number;
  authMethod?: ClaudeAuthMethod;
  flow?: { id: string; expiresAt: number; authorizationUrl?: string; codeSubmitted: boolean };
  error?: string;
  persistence: "native_snapshot";
  snapshotRetentionDays: 30;
}
export interface ClaudeLoginInput extends ClaudeIdentity { requestId: string; expectedVersion: number }
export interface ClaudeVersionInput extends ClaudeIdentity { expectedVersion: number }
export interface ClaudeFlowInput extends ClaudeVersionInput { flowId: string }
export interface ClaudeInferenceInput extends ClaudeIdentity {
  connectionVersion: number; runId: string; stepId: string; deadlineAt: number;
  model: string; instructions: string; prompt: string; schema: Record<string, unknown>;
}
export interface ClaudeInferenceResult { structuredOutput: unknown; tokens: number; cliVersion: string }
export interface ClaudeConnectionStub {
  status(input: ClaudeIdentity): Promise<ClaudeConnectionStatus>;
  startLogin(input: ClaudeLoginInput): Promise<ClaudeConnectionStatus>;
  completeLogin(input: ClaudeFlowInput & { code: string }): Promise<ClaudeConnectionStatus>;
  cancelLogin(input: ClaudeFlowInput): Promise<ClaudeConnectionStatus>;
  logout(input: ClaudeVersionInput): Promise<ClaudeConnectionStatus>;
  infer(input: ClaudeInferenceInput): Promise<ClaudeInferenceResult>;
  cancelInference(input: ClaudeIdentity & { connectionVersion: number; runId: string; stepId: string }): Promise<void>;
}
