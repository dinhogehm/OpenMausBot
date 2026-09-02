/** HTTP surface for the workflow engine. Three layers, so index.ts gains
 * only a thin registration: zod schemas that mirror shared/workflow.ts
 * (the model's shapes, not its semantics — validateWorkflow still owns
 * every graph rule and paints them as issues), pure handlers of the form
 * `(deps, input) => { status, body }` that the unit tests call directly
 * against a real store and engine, and one router that maps method + path
 * onto them. Engine and store errors are their documented message prefixes;
 * the mapping to 400/404/409 lives here and nowhere else. */
import { z } from "zod";

import {
  validateWorkflow,
  WORKFLOW_APPROVAL_OUTCOMES,
  type Workflow,
  type WorkflowIssue,
  type WorkflowNode,
  type WorkflowRun,
} from "../shared/workflow.ts";
import type { WorkflowEngine } from "./workflow-run.ts";
import type { WorkflowInput, WorkflowStore } from "./workflow-store.ts";

export interface WorkflowApiDeps {
  store: WorkflowStore;
  engine: WorkflowEngine;
}

export interface WorkflowApiResponse {
  status: number;
  /** Absent means an empty response body (204). */
  body?: unknown;
}

// ── schemas ───────────────────────────────────────────────────────────
// Shapes only. Bounds exist so a body cannot be arbitrarily large, not to
// pre-empt validateWorkflow: a padded or over-long outcome name is a
// validator issue the canvas must be able to show, so it passes here.
const id = z.string().trim().min(1).max(200);
const outcomeName = z.string().max(1_000);
const longText = z.string().max(20_000);
const optionalNumber = z.number().finite().optional();

const agentNodeSchema = z.object({
  kind: z.literal("agent"),
  id,
  botId: id,
  instructions: longText,
  outcomes: z.array(outcomeName).max(100),
  timeoutMinutes: optionalNumber,
  retries: optionalNumber,
});
const approvalNodeSchema = z.object({
  kind: z.literal("approval"),
  id,
  prompt: longText,
  expiresHours: optionalNumber,
  onExpire: z.enum(WORKFLOW_APPROVAL_OUTCOMES).optional(),
});
const notifyNodeSchema = z.object({
  kind: z.literal("notify"),
  id,
  targetGroupId: id,
  template: longText,
});
const nodeSchema = z.discriminatedUnion("kind", [agentNodeSchema, approvalNodeSchema, notifyNodeSchema]);
const edgeSchema = z.object({ from: id, outcome: outcomeName, to: id });
const layoutSchema = z.record(z.string().max(200), z.object({ x: z.number().finite(), y: z.number().finite() }));
const triggersSchema = z.object({
  schedule: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("daily"), time: z.string().max(20), weekdays: z.array(z.number().finite()).max(7) }),
      z.object({ type: z.literal("once"), at: z.number().finite() }),
    ])
    .optional(),
  webhookId: id.optional(),
});

/** JSON clients say "no value" with `null`; the model and the validator
 * only know an omitted field (validateWorkflow rejects null outright). Nulls
 * are dropped recursively through objects — nodes carry the optional
 * numerics — but never inside arrays, where a null is a real error. */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null) out[key] = stripNulls(entry);
  }
  return out;
}

const workflowInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).optional(),
  // A fresh canvas has no entry yet. validateWorkflow reports it, so a
  // draft can still be saved and the badge can still be painted.
  entryNodeId: z.string().trim().max(200),
  nodes: z.array(nodeSchema).max(200),
  edges: z.array(edgeSchema).max(2_000),
  layout: layoutSchema,
  triggers: triggersSchema.optional(),
  maxNodeExecutions: optionalNumber,
});
const workflowCreateSchema = z.preprocess(stripNulls, workflowInputSchema);
const workflowPatchSchema = z.preprocess(stripNulls, workflowInputSchema.partial());

/** Top-level optional fields a PATCH may clear with an explicit `null`.
 * stripNulls turned the null into an absent key — which a merge would read
 * as "leave alone" — so the intent is restored as an explicit undefined
 * that the store's spread overwrites and the JSON file then omits. */
const CLEARABLE_FIELDS = ["description", "triggers", "maxNodeExecutions"] as const;

const startRunBodySchema = z.object({ input: z.string().max(100_000).optional() });
const approvalBodySchema = z.object({ decision: z.enum(WORKFLOW_APPROVAL_OUTCOMES) });

// ── error mapping ─────────────────────────────────────────────────────
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isUnknownEntity = (error: unknown) => errorMessage(error).startsWith("unknown ");
const isInvalidWorkflow = (error: unknown) => errorMessage(error).startsWith("invalid workflow:");

const notFound = (what: "workflow" | "run"): WorkflowApiResponse => ({ status: 404, body: { error: `no such ${what}` } });
const conflict = (error: unknown): WorkflowApiResponse => ({ status: 409, body: { error: errorMessage(error) } });
const badBody = (error: z.ZodError): WorkflowApiResponse => ({
  status: 400,
  body: {
    error: "invalid request body",
    details: error.issues.map((issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`),
  },
});

export type WorkflowWithIssues = Workflow & { issues: WorkflowIssue[] };
const withIssues = (workflow: Workflow): WorkflowWithIssues => ({ ...workflow, issues: validateWorkflow(workflow) });

// ── handlers ──────────────────────────────────────────────────────────
export function listWorkflows({ store }: WorkflowApiDeps): WorkflowApiResponse {
  return { status: 200, body: { workflows: store.list().map(withIssues) } };
}

export function createWorkflow({ store }: WorkflowApiDeps, body: unknown): WorkflowApiResponse {
  const parsed = workflowCreateSchema.safeParse(body);
  if (!parsed.success) return badBody(parsed.error);
  const input: WorkflowInput = parsed.data;
  return { status: 201, body: { workflow: withIssues(store.create(input)) } };
}

export function patchWorkflow({ store }: WorkflowApiDeps, workflowId: string, body: unknown): WorkflowApiResponse {
  const current = store.get(workflowId);
  if (!current) return notFound("workflow");
  const parsed = workflowPatchSchema.safeParse(body);
  if (!parsed.success) return badBody(parsed.error);
  const patch: Partial<WorkflowInput> = parsed.data;
  if (typeof body === "object" && body !== null) {
    for (const field of CLEARABLE_FIELDS) {
      if ((body as Record<string, unknown>)[field] === null) patch[field] = undefined;
    }
  }
  try {
    return { status: 200, body: { workflow: withIssues(store.update(workflowId, patch)) } };
  } catch (error) {
    if (!isInvalidWorkflow(error)) throw error;
    // The store refused to persist; show the caller every issue the merged
    // draft carries, not just the first one the store tripped on.
    const draft: Workflow = { ...current, ...patch };
    return { status: 400, body: { error: errorMessage(error), issues: validateWorkflow(draft) } };
  }
}

export function deleteWorkflow({ store }: WorkflowApiDeps, workflowId: string): WorkflowApiResponse {
  store.remove(workflowId);
  return { status: 204 };
}

export function listWorkflowRuns({ store }: WorkflowApiDeps, workflowId: string): WorkflowApiResponse {
  return { status: 200, body: { runs: store.listRuns(workflowId) } };
}

const RUNS_LIMIT_DEFAULT = 200;
const RUNS_LIMIT_MAX = 2_000;

/** The UI's boot snapshot: every workflow's runs, newest first, capped. */
export function listAllRuns({ store }: WorkflowApiDeps, limitParam: string | null): WorkflowApiResponse {
  const requested = limitParam === null ? Number.NaN : Number(limitParam);
  const limit = Number.isFinite(requested) && requested >= 1 ? Math.min(Math.floor(requested), RUNS_LIMIT_MAX) : RUNS_LIMIT_DEFAULT;
  return { status: 200, body: { runs: store.listRuns().slice(0, limit) } };
}

export function startRun({ store, engine }: WorkflowApiDeps, workflowId: string, body: unknown): WorkflowApiResponse {
  const workflow = store.get(workflowId);
  if (!workflow) return notFound("workflow");
  const parsed = startRunBodySchema.safeParse(body ?? {});
  if (!parsed.success) return badBody(parsed.error);
  try {
    return { status: 201, body: { run: engine.startRun(workflowId, parsed.data.input ?? "", "manual") } };
  } catch (error) {
    if (isUnknownEntity(error)) return notFound("workflow");
    if (isInvalidWorkflow(error)) {
      return { status: 400, body: { error: errorMessage(error), issues: validateWorkflow(workflow) } };
    }
    throw error;
  }
}

export async function cancelRun({ engine }: WorkflowApiDeps, runId: string): Promise<WorkflowApiResponse> {
  try {
    return { status: 200, body: { run: await engine.cancelRun(runId) } };
  } catch (error) {
    if (isUnknownEntity(error)) return notFound("run");
    throw error;
  }
}

export function resumeRun({ engine }: WorkflowApiDeps, runId: string): WorkflowApiResponse {
  try {
    return { status: 200, body: { run: engine.resumeRun(runId) } };
  } catch (error) {
    if (isUnknownEntity(error)) return notFound("run");
    if (errorMessage(error).startsWith("only failed runs can be resumed")) return conflict(error);
    throw error;
  }
}

export function resolveApproval({ engine }: WorkflowApiDeps, runId: string, body: unknown): WorkflowApiResponse {
  const parsed = approvalBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: `invalid approval decision: expected one of ${WORKFLOW_APPROVAL_OUTCOMES.join(", ")}` },
    };
  }
  try {
    return { status: 200, body: { run: engine.resolveApproval(runId, parsed.data.decision) } };
  } catch (error) {
    if (isUnknownEntity(error)) return notFound("run");
    const message = errorMessage(error);
    if (message.startsWith("invalid approval decision")) return { status: 400, body: { error: message } };
    if (message.startsWith("run is not waiting for approval")) return conflict(error);
    throw error;
  }
}

// ── wiring helpers ────────────────────────────────────────────────────
/** The bot a workflow notification lands on: the current node's bot when it
 * is an agent node, else the graph's first agent bot (approval and notify
 * nodes have none of their own). undefined when the workflow is gone or has
 * no agent node at all — the caller then logs instead of notifying. */
export function workflowNotificationBotId(workflow: Workflow | null, run: WorkflowRun): string | undefined {
  if (!workflow) return undefined;
  const agents = workflow.nodes.filter((node): node is Extract<WorkflowNode, { kind: "agent" }> => node.kind === "agent");
  return agents.find((node) => node.id === run.currentNodeId)?.botId ?? agents[0]?.botId;
}

// ── router ────────────────────────────────────────────────────────────
export interface WorkflowApiRequest {
  method: string;
  path: string;
  searchParams: URLSearchParams;
  readBody: () => Promise<unknown>;
}

const WORKFLOW_PATH = /^\/api\/workflows\/([\w-]+)$/;
const WORKFLOW_RUNS_PATH = /^\/api\/workflows\/([\w-]+)\/runs$/;
const RUN_ACTION_PATH = /^\/api\/workflow-runs\/([\w-]+)\/(cancel|resume|approval)$/;

/** null when the request is not a workflow route, so index.ts's own
 * "no route" 404 stays the answer for everything this module does not own. */
export async function handleWorkflowRequest(
  deps: WorkflowApiDeps,
  request: WorkflowApiRequest,
): Promise<WorkflowApiResponse | null> {
  const { method, path } = request;
  if (!path.startsWith("/api/workflow")) return null;
  if (path === "/api/workflows") {
    if (method === "GET") return listWorkflows(deps);
    if (method === "POST") return createWorkflow(deps, await request.readBody());
    return null;
  }
  if (path === "/api/workflow-runs") {
    return method === "GET" ? listAllRuns(deps, request.searchParams.get("limit")) : null;
  }
  let match = path.match(WORKFLOW_RUNS_PATH);
  if (match) {
    if (method === "GET") return listWorkflowRuns(deps, match[1]);
    if (method === "POST") return startRun(deps, match[1], await request.readBody());
    return null;
  }
  match = path.match(WORKFLOW_PATH);
  if (match) {
    if (method === "PATCH") return patchWorkflow(deps, match[1], await request.readBody());
    if (method === "DELETE") return deleteWorkflow(deps, match[1]);
    return null;
  }
  match = path.match(RUN_ACTION_PATH);
  if (match && method === "POST") {
    if (match[2] === "cancel") return cancelRun(deps, match[1]);
    if (match[2] === "resume") return resumeRun(deps, match[1]);
    return resolveApproval(deps, match[1], await request.readBody());
  }
  return null;
}
