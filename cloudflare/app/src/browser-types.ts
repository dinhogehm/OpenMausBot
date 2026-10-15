import type { CredentialProvider } from "./credentials";
export const BROWSER_LIMITS = { durationMs: 300000, actions: 20, modelCalls: 20, totalTokens: 60000, outputTokens: 2048,
  screenshotBytes: 524288, observationChars: 12000, eventsBytes: 65536, history: 50, width: 1280, height: 800 } as const;
export interface BrowserRunInput {
  requestId: string;
  task: string;
  initialUrl: string;
  allowedHosts: string[];
  provider: CredentialProvider;
  model: string;
  agent?: { catalogVersion: number; profileId: string };
}
export type BrowserRunStatus = "pending_approval" | "queued" | "running" | "completed" | "failed" | "canceled" | "interrupted";
export interface BrowserRun extends BrowserRunInput {
  runId: string; organizationId: string; workspaceId: string; generation: number;
  status: BrowserRunStatus; createdBy: string; approvedBy?: string;
  createdAt: number; updatedAt: number; approvedAt?: number; finishedAt?: number; deadlineAt: number;
  credentialVersion: number; steps: number; modelCalls: number; tokens: number;
  events: { id: number; at: number; kind: "status" | "action" | "error"; text: string }[];
  agentSnapshot?: { id: string; revision: number; name: string; instructions: string };
  summary?: string; error?: string; screenshotAt?: number;
  cleanupStatus: "pending" | "closed" | "idle_expiry";
  canApprove?: boolean; canCancel?: boolean;
}
export type BrowserAction = { kind: "navigate"; url: string } | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string } | { kind: "press"; key: "Enter" | "Tab" | "Escape" | "Backspace" | "ArrowDown" | "ArrowUp" }
  | { kind: "scroll"; direction: "up" | "down"; amount: number } | { kind: "finish"; completed: boolean; summary: string };
export interface BrowserObservation { url: string; title: string; text: string; jpeg: Uint8Array }
export interface BrowserModelTurn { action: BrowserAction; tokens: number }
export interface BrowserCommand { organizationId: string; workspaceId: string; userId: string; action: string; runId?: string; body: Record<string, unknown> }
