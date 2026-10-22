// Routine definitions, persisted run shapes and installed-package stamp validation.
import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { RoutineRequestOperation } from "../shared/routine-request.ts";
import type { RoutineContextAttachment, RoutineRetryCause, RoutineRunStatus, RoutineRunTrigger } from "../shared/routines.ts";
import { ROUTINE_PARTS, type PartPair, type RoutinePart } from "./package-parts.ts";
import type { DeclaredResult } from "./result-contract.ts";
import type { RoutineSchedule, RoutineScheduleInput } from "./routine-schedules.ts";
import type { RoutineRunAsk } from "./routine-waits.ts";


/** `cloud` runs the agent inside the bot's Boat VM; `maus` runs the bot's own provider and borrows only its computer tools. */
export type RoutineRunOn = "maus" | "cloud";
export type RoutineTarget = "bot" | "room-goal";
export type RoutineGoalStatus = Exclude<GroupGoalRunStatus, "working">;

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  target: RoutineTarget;
  botId: string;
  groupId?: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  durationMinutes: number;
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  continuity?: boolean;
  /** An occurrence due while this routine's previous run is still active: by default (absent, or "queue")
   * it is coalesced into ONE pending run that starts as soon as the target is free; "skip" drops it. */
  overlap?: "skip" | "queue";
  /** "own": the routine runs in a lane of its own — it does not wait behind
   * (nor hold) the bot's one-intake-turn lock, so a long routine of the same
   * bot never delays it (19/10: the Esteira waited 45 min behind the Chief of
   * Staff's other routines). The bot's thread capacity still applies. */
  lane?: "own";
  runOnStartup?: boolean;
  skippedRuns?: number;
  lastSkippedAt?: number;
  failureStreak?: number;
  weekRuns?: { ok: number; total: number };
  warning?: string;
  sourceThreadId?: string;
  resultsThreadId?: string;
  installedPackage?: RoutinePackageStamp;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutinePackageStamp {
  installId: string;
  key: string;
  parts: Record<RoutinePart, PartPair>;
}

const HASH = /^[a-f0-9]{64}$/;
export function loadInstalledPackage(value: unknown): RoutinePackageStamp | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stamp = value as Partial<RoutinePackageStamp>;
  if (typeof stamp.installId !== "string" || !/^[a-f0-9]{32}$/.test(stamp.installId) || typeof stamp.key !== "string" || !stamp.key || stamp.key.length > 80) return undefined;
  const parts = stamp.parts as Record<string, Partial<PartPair>> | undefined;
  if (!parts || typeof parts !== "object" || !ROUTINE_PARTS.every((part) => HASH.test(String(parts[part]?.r)) && HASH.test(String(parts[part]?.w)))) return undefined;
  return {
    installId: stamp.installId,
    key: stamp.key,
    parts: Object.fromEntries(ROUTINE_PARTS.map((part) => [part, { r: parts[part]!.r!, w: parts[part]!.w! }])) as Record<RoutinePart, PartPair>,
  };
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  prompt?: string;
  durationMinutes?: number;
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  target: RoutineTarget;
  goalStatus?: RoutineGoalStatus;
  groupId?: string;
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  deferredAt?: number;
  deferredNoticeAt?: number;
  /** Later scheduled occurrences folded into this pending run while it waited; the run stands for all of them. */
  coalescedRuns?: number;
  /** A queued run starts no earlier than this. */
  retryAt?: number;
  retried?: RoutineRetryCause;
  /** When its current wait began; read only while the run is waiting. */
  waitingSince?: number;
  asked?: RoutineRunAsk;
  /** Time spent waiting on the person's answers, which the run limit does not count. */
  waitedMs?: number;
  triggerSource?: RoutineRunTrigger;
  /** "app": a connected-app event started it (its triggerSource stays "webhook", an outside event). */
  eventSource?: "app";
  webhookId?: string;
  deliveryId?: string;
  sourceThreadId?: string;
  resultsThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  attention?: string;
  error?: string;
  cost?: number | null;
  denials?: string[];
  /** Its prompt asked for a RESULTADO line (result-contract.ts): only "feito"
   * with a checkable proof closes it as completed. */
  resultContract?: boolean;
  /** What its last answer declared, read from the whole answer (output is clipped). */
  declared?: DeclaredResult;
  /** Failed only by its declared result: the turn itself ended, and its
   * answer stands for whatever reads it (the disk decision). */
  resultFailed?: boolean;
  createdAt: number;
  seenAt?: number;
}

export interface RoutineRequestReceipt {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  fingerprint: string;
  resultId: string;
  appliedAt: number;
}

export interface RoutineRequestCommit {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  fingerprint: string;
}

export type RoutineRequestCommitFor<Action extends RoutineRequestOperation["action"]> =
  Omit<RoutineRequestCommit, "action"> & { action: Action };

export interface RoutineInput {
  name: string;
  prompt: string;
  target?: RoutineTarget;
  botId: string;
  groupId?: string | null;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineScheduleInput;
  durationMinutes?: number;
  timeoutMinutes?: number | null;
  attachments?: RoutineContextAttachment[];
  continuity?: boolean;
  overlap?: "skip" | "queue";
  lane?: "own" | null;
  runOnStartup?: boolean;
  resultsThreadId?: string | null;
}


export type RoutineRequestOwner = Pick<RoutineRequestReceipt, "requestId" | "messageId" | "botId" | "threadId">;
