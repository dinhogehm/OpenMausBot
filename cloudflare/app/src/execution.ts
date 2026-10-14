export type RunStatus = "waiting_approval" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface ProofInput {
  message: string;
  delayMs: number;
}

export interface RunRecord {
  id: string;
  organizationId: string;
  workspaceId: string;
  input: ProofInput;
  generation: number;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  leaseExpiresAt: number | null;
  result?: {
    stdout: string;
    artifact: string;
    exitCode: number;
  };
  error?: string;
}

/**
 * Validates state only, not authorization. The caller must authenticate the
 * organization/workspace membership and derive the storage namespace from that
 * verified scope; client-provided identifiers alone are never authorization.
 */

export function createRun(
  id: string,
  organizationId: string,
  workspaceId: string,
  input: ProofInput,
  now: number,
): RunRecord {
  validateTimestamp(now);
  validateId(id, "Run id");
  validateId(organizationId, "Organization id");
  validateId(workspaceId, "Workspace id");
  if (!input || typeof input.message !== "string" || !input.message.isWellFormed() || !input.message.trim() || input.message.length > 1000) {
    throw new Error("Message must contain 1 to 1000 characters");
  }
  if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0 || input.delayMs > 30000) {
    throw new Error("Delay must be an integer between 0 and 30000 milliseconds");
  }
  return {
    id,
    organizationId,
    workspaceId,
    input: { message: input.message, delayMs: input.delayMs },
    generation: 0,
    status: "waiting_approval",
    createdAt: now,
    updatedAt: now,
    leaseExpiresAt: null,
  };
}

export function approveRun(record: RunRecord, now: number): RunRecord {
  validateTimestamp(now);
  if (record.status !== "waiting_approval") {
    throw new Error(`Cannot approve run in ${record.status} status`);
  }
  return {
    ...copyRecord(record),
    status: "running",
    generation: record.generation + 1,
    updatedAt: now,
    leaseExpiresAt: now + 60000,
  };
}

export function cancelRun(record: RunRecord, now: number): RunRecord {
  validateTimestamp(now);
  if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") {
    return copyRecord(record);
  }
  return {
    ...copyRecord(record),
    status: "cancelled",
    generation: record.generation + 1,
    updatedAt: now,
    leaseExpiresAt: null,
  };
}

export function completeRun(
  record: RunRecord,
  generation: number,
  result: NonNullable<RunRecord["result"]>,
  now: number,
): RunRecord {
  validateTimestamp(now);
  if (!acceptsCallback(record, generation, now)) return copyRecord(record);
  validateResult(result);
  return {
    ...copyRecord(record),
    status: result.exitCode === 0 ? "succeeded" : "failed",
    result: { stdout: result.stdout, artifact: result.artifact, exitCode: result.exitCode },
    updatedAt: now,
    leaseExpiresAt: null,
  };
}

export function failRun(record: RunRecord, generation: number, _error: string, now: number): RunRecord {
  validateTimestamp(now);
  if (!acceptsCallback(record, generation, now)) return copyRecord(record);
  return {
    ...copyRecord(record),
    status: "failed",
    error: "Execution failed. Review the run before retrying.",
    updatedAt: now,
    leaseExpiresAt: null,
  };
}

export function interruptRun(record: RunRecord, now: number): RunRecord {
  validateTimestamp(now);
  if (record.status !== "running") {
    throw new Error(`Cannot interrupt run in ${record.status} status`);
  }
  return {
    ...copyRecord(record),
    status: "interrupted",
    generation: record.generation + 1,
    updatedAt: now,
    leaseExpiresAt: null,
  };
}

export function retryRun(record: RunRecord, now: number): RunRecord {
  validateTimestamp(now);
  if (record.status !== "interrupted" && record.status !== "failed") {
    throw new Error(`Cannot retry run in ${record.status} status`);
  }
  const next = copyRecord(record);
  delete next.result;
  delete next.error;
  return { ...next, status: "waiting_approval", updatedAt: now, leaseExpiresAt: null };
}

function copyRecord(record: RunRecord): RunRecord {
  return {
    ...record,
    input: { ...record.input },
    ...(record.result ? { result: { ...record.result } } : {}),
  };
}

function acceptsCallback(record: RunRecord, generation: number, now: number): boolean {
  return record.status === "running"
    && record.generation === generation
    && record.leaseExpiresAt !== null
    && now < record.leaseExpiresAt;
}

function validateTimestamp(now: number): void {
  if (!Number.isFinite(now)) throw new Error("Timestamp must be a finite number");
}

function validateId(id: string, name: string): void {
  if (typeof id !== "string" || id.length < 1 || id.length > 80 || /[^A-Za-z0-9_-]/.test(id)) {
    throw new Error(`${name} must contain 1 to 80 ASCII letters, digits, hyphens or underscores`);
  }
}

function validateResult(result: NonNullable<RunRecord["result"]>): void {
  for (const field of ["stdout", "artifact"] as const) {
    if (!result || typeof result[field] !== "string" || new TextEncoder().encode(result[field]).byteLength > 16384) {
      throw new Error(`Result ${field} must be a string of at most 16 KiB`);
    }
  }
  if (!Number.isSafeInteger(result.exitCode)) throw new Error("Result exit code must be a finite integer");
}
