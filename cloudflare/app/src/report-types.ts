import type { AgentRole, CodingStatus } from "./coding-types";

export type ReportPreset = "day" | "week" | "fortnight" | "month" | "48h" | "90d" | "12m" | "previous_month" | "custom";
export type ReportGranularity = "hour" | "day" | "month";
export type ReportCoverage = "full" | "partial" | "none";
export interface ReportPeriod { from: number; to: number }
export interface ReportQuery { period: ReportPreset; from?: string; to?: string; repositoryId?: string; agentId?: string; granularity?: ReportGranularity }
export interface ReportDistribution { median: number | null; p90: number | null; samples: number }
export interface ReportKpis {
  created: number | null; completed: number | null; failed: number | null; canceled: number | null; interrupted: number | null;
  prsCreated: number | null; testsPassed: number | null; testsFailed: number | null;
  modelCalls: number | null; observedTokens: number | null; unobservedModelCalls: number | null;
  taskSuccessRate: number | null; testPassRate: number | null;
  durationMs: ReportDistribution; approvalWaitMs: ReportDistribution;
}
export type ReportMetric = "created" | "completed" | "failed" | "canceled" | "interrupted" | "prsCreated" | "testsPassed" | "testsFailed" | "modelCalls" | "observedTokens" | "taskSuccessRate" | "testPassRate" | "durationMs";
export interface ReportComparison { kind: "trend" | "absolute" | "none"; previous: number | null; delta: number | null; ratio: number | null; reason?: string }
export interface ReportBucket { start: number; end: number; coverage: ReportCoverage; created: number | null; completed: number | null; failed: number | null; prsCreated: number | null; testsPassed: number | null; testsFailed: number | null; modelCalls: number | null; observedTokens: number | null }
export interface ReportAgent { id: string; role: AgentRole; name: string; modelCalls: number; observedTokens: number | null; unobservedModelCalls: number; modelDurationMs: number | null }
export interface ReportRun {
  runId: string; repositoryId: string; repositoryName: string; task: string; status: CodingStatus;
  createdAt: number; approvedAt: number | null; startedAt: number | null; finishedAt: number | null; publishedAt: number | null;
  agents: Array<{ id: string; role: AgentRole; name: string }>;
  test: { command: string; exitCode: number; finishedAt: number } | null;
  pr: { url: string; number: number; commitSha: string; changedFiles: number } | null;
}
export interface ReportGoalTargets { taskSuccessRate?: number; testPassRate?: number; durationMinutes?: number }
export interface ExecutionReport {
  version: 1; organizationId: string; workspaceId: string; generatedAt: number; timezone: "America/Sao_Paulo";
  query: ReportQuery; period: ReportPeriod; previous: ReportPeriod; comparedUntil: number; previousComparedUntil: number; granularity: ReportGranularity;
  coverage: { trackingStartedAt: number | null; period: ReportCoverage; previous: ReportCoverage; factsThrough: number | null; historyImported: false; notes: string[] };
  kpis: ReportKpis; previousKpis: ReportKpis; comparisons: Record<ReportMetric, ReportComparison>;
  buckets: ReportBucket[]; previousBuckets: ReportBucket[]; agents: ReportAgent[]; runs: ReportRun[]; runsTruncated: boolean;
  backlog: { pendingApproval: number; active: number; at: number };
  filters: { repositories: Array<{ id: string; name: string }>; agents: Array<{ id: string; name: string }> };
  goals: { version: number; targets: ReportGoalTargets; canEdit: boolean };
  sources: Array<{ id: string; label: string; status: "available" | "not_tracked"; reason: string }>;
  definitions: Record<string, string>;
}

/** Structured execution facts, never parsed from assistant prose or bounded logs. */
export interface ReportFact {
  id: string; kind: "model_started" | "model_observed" | "test"; at: number;
  agentId?: string; agentRole?: AgentRole; agentName?: string; callId?: string;
  tokens?: number; durationMs?: number; exitCode?: number;
}
