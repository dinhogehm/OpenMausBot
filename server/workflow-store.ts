/** Durable CRUD for workflow definitions and run receipts. Definitions and
 * runs live in separate files so the engine patching a receipt on every state
 * transition never rewrites the user-edited definitions file. `update` refuses
 * any patch with error-severity issues — persisting an invalid flow must be
 * impossible — while `create` accepts half-drawn canvas drafts. Every write
 * lands atomically and emits a keyed frame for the SSE bus. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { validateWorkflow, type Workflow, type WorkflowRun } from "../shared/workflow.ts";
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

export type WorkflowInput = Omit<Workflow, "id" | "createdAt" | "updatedAt">;

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

function loadArray<T>(path: string, key: string): T[] {
  try {
    const disk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const value = disk?.[key];
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    // A missing or corrupted file must never keep the server from booting;
    // atomic writes make truncation a crash-only artifact anyway.
    return [];
  }
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
   * restart — so creation does not validate. `update` is the gate. */
  create(input: WorkflowInput): Workflow {
    const at = this.now();
    const workflow: Workflow = { ...structuredClone(input), id: randomUUID(), createdAt: at, updatedAt: at };
    this.workflows.push(workflow);
    this.saveWorkflows();
    this.emitWorkflow(workflow);
    return structuredClone(workflow);
  }

  update(id: string, patch: Partial<WorkflowInput>): Workflow {
    const at = this.workflows.findIndex((workflow) => workflow.id === id);
    if (at === -1) throw new Error(`unknown workflow: ${id}`);
    const current = this.workflows[at]!;
    const next: Workflow = {
      ...current,
      ...structuredClone(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    };
    const firstError = validateWorkflow(next).find((issue) => issue.severity === "error");
    if (firstError) throw new Error(`invalid workflow: ${firstError.message}`);
    this.workflows[at] = next;
    this.saveWorkflows();
    this.emitWorkflow(next);
    return structuredClone(next);
  }

  remove(id: string): void {
    const at = this.workflows.findIndex((workflow) => workflow.id === id);
    if (at === -1) return;
    this.workflows.splice(at, 1);
    this.saveWorkflows();
    this.emit?.({ kind: "workflow-removed", id });
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
    this.runs.push(run);
    // The engine appends runs as they start, so insertion order is age order
    // (same retention policy as routine runs).
    if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
    this.saveRuns();
    this.emitRun(run);
    return structuredClone(run);
  }

  patchRun(id: string, patch: Partial<WorkflowRun>): WorkflowRun | null {
    const at = this.runs.findIndex((run) => run.id === id);
    if (at === -1) return null;
    const next: WorkflowRun = { ...this.runs[at]!, ...structuredClone(patch), id };
    this.runs[at] = next;
    this.saveRuns();
    this.emitRun(next);
    return structuredClone(next);
  }

  getRun(id: string): WorkflowRun | null {
    const run = this.runs.find((candidate) => candidate.id === id);
    return run ? structuredClone(run) : null;
  }

  listRuns(workflowId?: string): WorkflowRun[] {
    const selected = workflowId === undefined ? this.runs : this.runs.filter((run) => run.workflowId === workflowId);
    return structuredClone(selected).sort((a, b) => b.startedAt - a.startedAt);
  }

  private saveWorkflows() {
    mkdirSync(dirname(this.file), { recursive: true });
    const disk: WorkflowFile = { version: 1, workflows: this.workflows };
    writeFileAtomic(this.file, JSON.stringify(disk), { mode: 0o600 });
  }

  private saveRuns() {
    mkdirSync(dirname(this.runsFile), { recursive: true });
    const disk: WorkflowRunFile = { version: 1, runs: this.runs };
    writeFileAtomic(this.runsFile, JSON.stringify(disk), { mode: 0o600 });
  }

  private emitWorkflow(workflow: Workflow) {
    this.emit?.({ kind: "workflow", workflow: structuredClone(workflow) });
  }

  private emitRun(run: WorkflowRun) {
    this.emit?.({ kind: "workflow-run", run: structuredClone(run) });
  }
}
