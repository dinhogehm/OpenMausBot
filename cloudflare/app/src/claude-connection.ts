import type { ClaudeConnectionStub } from "./claude-types";

export interface ClaudeConnectionBindings {
  CLAUDE_CODE_ENABLED?: string;
  CLAUDE_CONNECTIONS?: { getByName(name: string): ClaudeConnectionStub };
}
export function claudeConnection(env: ClaudeConnectionBindings, organizationId: string, userId: string): ClaudeConnectionStub {
  if (!env.CLAUDE_CONNECTIONS) throw new Error("claude_not_configured");
  return env.CLAUDE_CONNECTIONS.getByName(JSON.stringify([organizationId, userId]));
}
