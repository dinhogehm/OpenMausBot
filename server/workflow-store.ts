/** Durable CRUD for workflow definitions and run receipts. Definitions and
 * runs live in separate files so the engine patching a receipt on every state
 * transition never rewrites the user-edited definitions file.
 *
 * Persistence does not validate the graph: a half-drawn canvas must be
 * saveable — and editable — or the designer could not save work in progress
 * and a draft could not even be renamed. Validation gates EXECUTION instead
 * (`WorkflowEngine.startRun` refuses a workflow with error-severity issues),
 * while `GET /api/workflows` carries every issue so the canvas can paint the
 * badges. Shape validation still happens at the API's zod layer, so what
 * lands here is always a well-formed Workflow — just not necessarily a
 * runnable one. Every mutation writes to disk BEFORE it lands in memory
 * (save-then-swap), so a failed write can never leave phantom state a later
 * save would persist; every successful write emits a keyed frame for the
 * SSE bus. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Workflow, WorkflowRefusalStreak, WorkflowRun, WorkflowRunStatus, WorkflowSchedule } from "../shared/workflow.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export interface WorkflowStoreOptions {
  file?: string;
  runsFile?: string;
  now?: () => number;
  /** Keyed frames only: every payload on this bus is `{ kind, … }`, which
   * is what lets the server number and replay them. */
  emit?: (payload: Record<string, unknown>) => void;
}

/** What a client may send. `nextRunAt`, `lastDigestAt` and `refusalStreak`
 * are engine-owned state: they are excluded here so no create/update can set
 * them — the API's key-set guard then keeps them out of the request schema
 * as well. */
export type WorkflowInput = Omit<Workflow, "id" | "createdAt" | "updatedAt" | "nextRunAt" | "lastDigestAt" | "refusalStreak">;

interface WorkflowFile {
  version: 1;
  workflows: Workflow[];
}

interface WorkflowRunFile {
  version: 1;
  runs: WorkflowRun[];
}

/** Same retention as routine runs: enough history for the UI, bounded disk. */
const MAX_RUNS = 2_000;

/** A run in one of these states can never transition again; only such
 * receipts are safe to evict — a pruned live run would make every later
 * patchRun from the engine silently miss. */
const TERMINAL_RUN_STATUSES = new Set<WorkflowRunStatus>(["completed", "failed", "cancelled"]);

function loadArray<T extends { id: string }>(path: string, key: string): T[] {
  try {
    const disk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const value = disk?.[key];
    if (!Array.isArray(value)) return [];
    // Element-level garbage (a stray null, a truncated object) must not
    // detonate get/update later; entries without a string id are dropped.
    return value.filter(
      (entry): entry is T =>
        typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string",
    );
  } catch {
    // A missing or corrupted file must never keep the server from booting;
    // atomic writes make truncation a crash-only artifact anyway.
    return [];
  }
}

/** Identity of a schedule, for change detection on update. Both sides come
 * through the same API schema, so key order matches; a false "changed" only
 * costs one harmless re-arm, which is why a plain serialization is enough. */
const scheduleKey = (schedule: WorkflowSchedule | undefined): string => JSON.stringify(schedule ?? null);

/** Oldest terminal receipts go first; live runs (queued/running/waiting)
 * survive the cap because they are the engine's crash-recovery state. The
 * hard cap still stands: with too few terminal runs, oldest go regardless. */
function pruneRuns(runs: WorkflowRun[]): WorkflowRun[] {
  let excess = runs.length - MAX_RUNS;
  if (excess <= 0) return runs;
  const kept: WorkflowRun[] = [];
  for (const run of runs) {
    if (excess > 0 && TERMINAL_RUN_STATUSES.has(run.status)) {
      excess--;
      continue;
    }
    kept.push(run);
  }
  if (excess > 0) kept.splice(0, excess);
  return kept;
}

export class WorkflowStore {
  private readonly file: string;
  private readonly runsFile: string;
  private readonly now: () => number;
  private readonly emit?: (payload: Record<string, unknown>) => void;
  private workflows: Workflow[];
  private runs: WorkflowRun[];

  constructor(options: WorkflowStoreOptions = {}) {
    this.file = options.file ?? join(DATA_DIR, "workflows.json");
    this.runsFile = options.runsFile ?? join(DATA_DIR, "workflow-runs.json");
    this.now = options.now ?? Date.now;
    this.emit = options.emit;
    this.workflows = loadArray<Workflow>(this.file, "workflows");
    this.runs = loadArray<WorkflowRun>(this.runsFile, "runs");
  }

  /** Drafts are saveable by design — a half-drawn canvas must survive a
   * restart — so neither creation nor update validates the graph. */
  create(input: WorkflowInput): Workflow {
    const at = this.now();
    const workflow: Workflow = { ...structuredClone(input), id: randomUUID(), createdAt: at, updatedAt: at };
    const next = [...this.workflows, workflow];
    this.writeWorkflows(next);
    this.workflows = next;
    this.emitWorkflow(workflow);
    return structuredClone(workflow);
  }

  update(id: string, patch: Partial<WorkflowInput>): Workflow {
    const at = this.workflows.findIndex((workflow) => workflow.id === id);
    if (at === -1) throw new Error(`unknown workflow: ${id}`);
    const current = this.workflows[at]!;
    const patched: Workflow = {
      ...current,
      ...structuredClone(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    };
    // Only a CHANGED schedule invalidates the engine's computed occurrence;
    // null tells the sweep to recompute on its next tick. Resetting on every
    // triggers patch would let a canvas that saves the whole document (an
    // identical triggers object on each layout nudge) push the next slot
    // away on every save — and rewrite the file and emit a frame for nothing.
    // Back to "not armed yet" (undefined), never to "disarmed" (null): a
    // changed schedule is exactly what asks the engine's sweep for a fresh
    // arm, while null is how a spent `once` stays spent.
    if (scheduleKey(current.triggers?.schedule) !== scheduleKey(patched.triggers?.schedule)) {
      patched.nextRunAt = undefined;
    }
    const next = this.workflows.slice();
    next[at] = patched;
    this.writeWorkflows(next);
    this.workflows = next;
    this.emitWorkflow(patched);
    return structuredClone(patched);
  }

  remove(id: string): void {
    const next = this.workflows.filter((workflow) => workflow.id !== id);
    if (next.length === this.workflows.length) return;
    this.writeWorkflows(next);
    this.workflows = next;
    this.emit?.({ kind: "workflow.deleted", id });
  }

  /** Engine-owned timing state. Persists like any mutation (save-then-swap,
   * keyed frame) but leaves `updatedAt` alone: the definition did not change,
   * only the scheduler's clock. Null on an unknown id — the sweep may race a
   * delete. An unchanged value (null and undefined count as equal) is a
   * no-op, so a sweep that keeps computing "nothing to arm" never rewrites
   * the file every tick. */
  setNextRunAt(id: string, value: number | null | undefined): Workflow | null {
    const at = this.workflows.findIndex((workflow) => workflow.id === id);
    if (at === -1) return null;
    const current = this.workflows[at]!;
    // The three states are distinct and the difference is load-bearing:
    // `undefined` re-arms on the next sweep, `null` stays disarmed. Folding
    // them together here would make a disarm unrecoverable.
    if (current.nextRunAt === value) return structuredClone(current);
    const patched: Workflow = { ...current, nextRunAt: value };
    const next = this.workflows.slice();
    next[at] = patched;
    this.writeWorkflows(next);
    this.workflows = next;
    this.emitWorkflow(patched);
    return structuredClone(patched);
  }

  /** Engine-owned, like setNextRunAt: the refused-start streak. `undefined`
   * clears it. Same persistence, same frame, `updatedAt` untouched. */
  setRefusalStreak(id: string, value: WorkflowRefusalStreak | undefined): Workflow | null {
    const at = this.workflows.findIndex((workflow) => workflow.id === id);
    if (at === -1) return null;
    const current = this.workflows[at]!;
    if (current.refusalStreak === undefined && value === undefined) return structuredClone(current);
    const patched: Workflow = { ...current, refusalStreak: structuredClone(value) };
    const next = this.workflows.slice();
    next[at] = patched;
    this.writeWorkflows(next);
    this.workflows = next;
    this.emitWorkflow(patched);
    return structuredClone(patched);
  }

  /** Engine-owned, like setNextRunAt: the digest's double-fire guard. Same
   * persistence, same frame, `updatedAt` untouched; null on an unknown id. */
  setLastDigestAt(id: string, value: number): Workflow | null {
    const at = this.workflows.findIndex((workflow) => workflow.id === id);
    if (at === -1) return null;
    const current = this.workflows[at]!;
    if (current.lastDigestAt === value) return structuredClone(current);
    const patched: Workflow = { ...current, lastDigestAt: value };
    const next = this.workflows.slice();
    next[at] = patched;
    this.writeWorkflows(next);
    this.workflows = next;
    this.emitWorkflow(patched);
    return structuredClone(patched);
  }

  get(id: string): Workflow | null {
    const workflow = this.workflows.find((candidate) => candidate.id === id);
    return workflow ? structuredClone(workflow) : null;
  }

  list(): Workflow[] {
    return structuredClone(this.workflows);
  }

  createRun(input: Omit<WorkflowRun, "id">): WorkflowRun {
    const run: WorkflowRun = { ...structuredClone(input), id: randomUUID() };
    const next = pruneRuns([...this.runs, run]);
    this.writeRuns(next);
    this.runs = next;
    this.emitRun(run);
    return structuredClone(run);
  }

  /** Returns null (rather than throwing, as `update` does) on an unknown id:
   * the engine may legitimately patch a receipt the cap already pruned,
   * whereas updating an unknown workflow is a caller error. */
  patchRun(id: string, patch: Partial<WorkflowRun>): WorkflowRun | null {
    const at = this.runs.findIndex((run) => run.id === id);
    if (at === -1) return null;
    const patched: WorkflowRun = { ...this.runs[at]!, ...structuredClone(patch), id };
    const next = this.runs.slice();
    next[at] = patched;
    this.writeRuns(next);
    this.runs = next;
    this.emitRun(patched);
    return structuredClone(patched);
  }

  getRun(id: string): WorkflowRun | null {
    const run = this.runs.find((candidate) => candidate.id === id);
    return run ? structuredClone(run) : null;
  }

  listRuns(workflowId?: string): WorkflowRun[] {
    const selected = workflowId === undefined ? this.runs : this.runs.filter((run) => run.workflowId === workflowId);
    return structuredClone(selected).sort((a, b) => b.startedAt - a.startedAt);
  }

  private writeWorkflows(workflows: Workflow[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const disk: WorkflowFile = { version: 1, workflows };
    // Definitions are hand-inspectable like routines/bots; runs stay compact.
    writeFileAtomic(this.file, JSON.stringify(disk, null, 2), { mode: 0o600 });
  }

  private writeRuns(runs: WorkflowRun[]) {
    mkdirSync(dirname(this.runsFile), { recursive: true });
    const disk: WorkflowRunFile = { version: 1, runs };
    writeFileAtomic(this.runsFile, JSON.stringify(disk), { mode: 0o600 });
  }

  private emitWorkflow(workflow: Workflow) {
    this.emit?.({ kind: "workflow", workflow: structuredClone(workflow) });
  }

  private emitRun(run: WorkflowRun) {
    this.emit?.({ kind: "workflow-run", run: structuredClone(run) });
  }
}
