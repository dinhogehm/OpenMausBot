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
  capabilityIssues,
  validateWorkflow,
  WORKFLOW_APPROVAL_OUTCOMES,
  WORKFLOW_CAPABILITIES,
  WORKFLOW_SCHEDULE_TIME_RE,
  type BotCapabilities,
  type Workflow,
  type WorkflowEdge,
  type WorkflowIssue,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowTriggers,
} from "../shared/workflow.ts";
import { schemaIssue } from "./schema.ts";
import type { WorkflowEngine } from "./workflow-run.ts";
import type { WorkflowInput, WorkflowStore } from "./workflow-store.ts";

export interface WorkflowApiDeps {
  store: WorkflowStore;
  engine: WorkflowEngine;
  /** The merge/deploy flags a bot carries (store.bot in index.ts); null for
   * a bot that no longer exists. Read on every listing and every start, so
   * the canvas and the run gate see a toggle the moment a person flips it. */
  botCapabilities: (botId: string) => BotCapabilities | null;
  /** Called once a definition is actually gone, so what pointed AT it can be
   * released — index.ts pauses the webhooks that targeted it, which would
   * otherwise answer 410 forever. A throw here is logged, never turned into
   * a failed DELETE: the definition is already deleted by then. */
  onWorkflowDeleted?: (workflowId: string) => void;
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
// Identifiers are never rewritten (no trim): a node id is also a layout key
// and an edge endpoint, and a botId or group id is a foreign key — silently
// trimming one copy would let the others drift. The schedule is the one
// place a shape rule doubles as a semantic one: a time or weekday the
// scheduler could not arm is refused at the door as well as by the
// validator, since a draft has nothing to gain from keeping it.
const untrimmed = (value: string) => value === value.trim();
const NO_SURROUNDING_WHITESPACE = "must not have surrounding whitespace";
const id = z.string().min(1).max(200).refine(untrimmed, NO_SURROUNDING_WHITESPACE);
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
  // The one node field with a closed vocabulary: a name outside it could
  // never be granted, so the door refuses it like the validator would, and
  // a list longer than the vocabulary can only be padding. Duplicates
  // within that length stay the validator's (bad-requires), as pinned.
  requires: z.array(z.enum(WORKFLOW_CAPABILITIES)).max(WORKFLOW_CAPABILITIES.length).optional(),
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
const layoutSchema = z.record(id, z.object({ x: z.number().finite(), y: z.number().finite() }));
const triggersSchema = z.object({
  schedule: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("daily"),
        time: z.string().regex(WORKFLOW_SCHEDULE_TIME_RE, "must be HH:MM (24-hour)"),
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      }),
      z.object({ type: z.literal("once"), at: z.number().finite() }),
    ])
    .optional(),
});

const workflowInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: longText.optional(),
  // A fresh canvas has no entry yet. validateWorkflow reports it, so a
  // draft can still be saved and the badge can still be painted.
  entryNodeId: z.string().max(200).refine(untrimmed, NO_SURROUNDING_WHITESPACE),
  nodes: z.array(nodeSchema).max(200),
  edges: z.array(edgeSchema).max(2_000),
  layout: layoutSchema,
  triggers: triggersSchema.optional(),
  maxNodeExecutions: optionalNumber,
});

// Compile-time drift guards. Exact<> catches value-type drift, but two object
// types that differ only by an OPTIONAL key are mutually assignable — and an
// optional field added to the model without a schema line is exactly what
// zod's non-strict objects would then strip on every PATCH. SameKeys<>
// compares the key sets at every object level, so either kind of drift
// fails typecheck here.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SameKeys<A, B> = Exact<keyof A, keyof B>;
type AgentNode = Extract<WorkflowNode, { kind: "agent" }>;
type ApprovalNode = Extract<WorkflowNode, { kind: "approval" }>;
type NotifyNode = Extract<WorkflowNode, { kind: "notify" }>;
type Schedule = NonNullable<WorkflowTriggers["schedule"]>;
type SchemaSchedule = NonNullable<z.infer<typeof triggersSchema>["schedule"]>;
const _schemaMatchesModel: Exact<z.infer<typeof workflowInputSchema>, WorkflowInput> = true;
const _workflowKeys: SameKeys<z.infer<typeof workflowInputSchema>, WorkflowInput> = true;
const _agentKeys: SameKeys<z.infer<typeof agentNodeSchema>, AgentNode> = true;
const _approvalKeys: SameKeys<z.infer<typeof approvalNodeSchema>, ApprovalNode> = true;
const _notifyKeys: SameKeys<z.infer<typeof notifyNodeSchema>, NotifyNode> = true;
const _edgeKeys: SameKeys<z.infer<typeof edgeSchema>, WorkflowEdge> = true;
const _triggerKeys: SameKeys<z.infer<typeof triggersSchema>, WorkflowTriggers> = true;
const _dailyKeys: SameKeys<Extract<SchemaSchedule, { type: "daily" }>, Extract<Schedule, { type: "daily" }>> = true;
const _onceKeys: SameKeys<Extract<SchemaSchedule, { type: "once" }>, Extract<Schedule, { type: "once" }>> = true;
void [
  _schemaMatchesModel,
  _workflowKeys,
  _agentKeys,
  _approvalKeys,
  _notifyKeys,
  _edgeKeys,
  _triggerKeys,
  _dailyKeys,
  _onceKeys,
];

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

const workflowCreateSchema = z.preprocess(stripNulls, workflowInputSchema);
const workflowPatchSchema = z.preprocess(stripNulls, workflowInputSchema.partial());

/** The only top-level fields a client may null: on a PATCH that clears
 * them (stripNulls made the key absent — which a merge would read as
 * "leave alone" — so the intent is restored as an explicit undefined the
 * store's spread overwrites and the JSON file then omits). A null on any
 * other top-level field is refused outright rather than becoming a silent
 * no-op. Single source of truth for both rules. */
const CLEARABLE_FIELDS = ["description", "triggers", "maxNodeExecutions"] as const;
const isClearable = (key: string) => (CLEARABLE_FIELDS as readonly string[]).includes(key);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Every top-level field the model knows. Unknown keys are not judged here:
 * zod strips them silently, and a null in one is no different. */
const WORKFLOW_FIELDS = new Set(Object.keys(workflowInputSchema.shape));

/** The first known top-level field whose value is null and which is not
 * clearable. */
function nullRequiredField(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  return Object.keys(record).find((key) => WORKFLOW_FIELDS.has(key) && record[key] === null && !isClearable(key));
}

const startRunBodySchema = z.object({ input: z.string().max(100_000).optional() });
const approvalBodySchema = z.object({ decision: z.enum(WORKFLOW_APPROVAL_OUTCOMES) });

// ── error mapping ─────────────────────────────────────────────────────
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isUnknownEntity = (error: unknown) => errorMessage(error).startsWith("unknown ");
const isInvalidWorkflow = (error: unknown) => errorMessage(error).startsWith("invalid workflow:");

const notFound = (what: "workflow" | "run"): WorkflowApiResponse => ({ status: 404, body: { error: `no such ${what}` } });
const conflict = (error: unknown): WorkflowApiResponse => ({ status: 409, body: { error: errorMessage(error) } });
/** `error` is the house first-issue line (schemaIssue, as webhooks use);
 * `details` lists every issue for a form to paint. */
const badBody = (error: z.ZodError): WorkflowApiResponse => ({
  status: 400,
  body: {
    error: schemaIssue(error, "invalid request body"),
    details: error.issues.map((issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`),
  },
});
const nullField = (field: string): WorkflowApiResponse => {
  const detail = `${field}: cannot be null`;
  return { status: 400, body: { error: detail, details: [detail] } };
};

export type WorkflowWithIssues = Workflow & { issues: WorkflowIssue[] };
/** The structural issues plus the per-bot capability ones — the same union
 * the engine gates a start on, so what the canvas paints in red is exactly
 * what Run is refused for. */
const issuesOf = (deps: WorkflowApiDeps, workflow: Workflow): WorkflowIssue[] => [
  ...validateWorkflow(workflow),
  ...capabilityIssues(workflow, deps.botCapabilities),
];
const withIssues = (deps: WorkflowApiDeps, workflow: Workflow): WorkflowWithIssues => ({
  ...workflow,
  issues: issuesOf(deps, workflow),
});

const LIVE_RUN_STATUSES = new Set<WorkflowRunStatus>(["queued", "running", "waiting-approval"]);

// ── handlers ──────────────────────────────────────────────────────────
export function listWorkflows(deps: WorkflowApiDeps): WorkflowApiResponse {
  return { status: 200, body: { workflows: deps.store.list().map((workflow) => withIssues(deps, workflow)) } };
}

export function createWorkflow(deps: WorkflowApiDeps, body: unknown): WorkflowApiResponse {
  // Before the parse: stripNulls would turn `edges: null` into a missing
  // field, and "expected array, received undefined" hides what was sent.
  const nulled = nullRequiredField(body);
  if (nulled !== undefined) return nullField(nulled);
  const parsed = workflowCreateSchema.safeParse(body);
  if (!parsed.success) return badBody(parsed.error);
  const input: WorkflowInput = parsed.data;
  return { status: 201, body: { workflow: withIssues(deps, deps.store.create(input)) } };
}

/** A draft is saveable at every stage, so a graph the validator flags is a
 * 200 carrying its issues — never a 400. Only running one is refused
 * (POST /runs), which is the moment the issues actually matter. */
export function patchWorkflow(deps: WorkflowApiDeps, workflowId: string, body: unknown): WorkflowApiResponse {
  const { store } = deps;
  if (!store.get(workflowId)) return notFound("workflow");
  const nulled = nullRequiredField(body);
  if (nulled !== undefined) return nullField(nulled);
  const parsed = workflowPatchSchema.safeParse(body);
  if (!parsed.success) return badBody(parsed.error);
  const patch: Partial<WorkflowInput> = parsed.data;
  const raw = asRecord(body);
  for (const field of CLEARABLE_FIELDS) {
    if (raw?.[field] === null) patch[field] = undefined;
  }
  return { status: 200, body: { workflow: withIssues(deps, store.update(workflowId, patch)) } };
}

const liveRuns = (store: WorkflowStore, workflowId: string) =>
  store.listRuns(workflowId).filter((run) => LIVE_RUN_STATUSES.has(run.status));

/** Idempotent. Live runs are cancelled BEFORE the definition goes: a run
 * left running on a deleted workflow would keep driving its bot until the
 * engine noticed. Queued runs go first — cancelling the active run promotes
 * the oldest queued one (drainQueue), so emptying the queue while the active
 * run still holds the slot keeps every cancellation dispatch-free. A cancel
 * awaits the provider's interrupt, and a trigger can start a fresh run under
 * that await, so the sweep is bounded and re-checked synchronously right
 * before removal: with anything still live, nothing is removed and the
 * caller gets a 409 to retry — never a definition-less run driving a bot. */
export async function deleteWorkflow(
  { store, engine, onWorkflowDeleted }: WorkflowApiDeps,
  workflowId: string,
): Promise<WorkflowApiResponse> {
  for (let pass = 0; pass < 4; pass++) {
    const live = liveRuns(store, workflowId).sort((a, b) => Number(a.status !== "queued") - Number(b.status !== "queued"));
    if (live.length === 0) break;
    for (const run of live) {
      try {
        await engine.cancelRun(run.id);
      } catch (error) {
        if (!isUnknownEntity(error)) throw error; // pruned meanwhile: nothing to cancel
      }
    }
  }
  // Synchronous from here to the removal: no await in between.
  const remaining = liveRuns(store, workflowId).length;
  if (remaining > 0) {
    return {
      status: 409,
      body: { error: `workflow still has ${remaining} live run${remaining === 1 ? "" : "s"} — retry` },
    };
  }
  store.remove(workflowId);
  try {
    onWorkflowDeleted?.(workflowId);
  } catch (error) {
    // The definition is gone; failing the DELETE now would be a lie.
    console.warn(`workflow: releasing triggers of deleted workflow ${workflowId} failed`, error);
  }
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

export function startRun(deps: WorkflowApiDeps, workflowId: string, body: unknown): WorkflowApiResponse {
  const { store, engine } = deps;
  const workflow = store.get(workflowId);
  if (!workflow) return notFound("workflow");
  const parsed = startRunBodySchema.safeParse(body ?? {});
  if (!parsed.success) return badBody(parsed.error);
  try {
    return { status: 201, body: { run: engine.startRun(workflowId, parsed.data.input ?? "", "manual") } };
  } catch (error) {
    if (isUnknownEntity(error)) return notFound("workflow");
    if (isInvalidWorkflow(error)) {
      // The engine refused on the same union the listing paints, capability
      // issues included; answer with all of it so the canvas can show why.
      return { status: 400, body: { error: errorMessage(error), issues: issuesOf(deps, workflow) } };
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
export interface NotificationBotLookup {
  /** Whether a bot with this id still exists. */
  exists: (botId: string) => boolean;
  /** The bot that owns a thread (a bot's own thread or one of its task
   * threads — store.botByThread), or undefined. */
  botByThread: (threadId: string) => string | undefined;
}

/** The bot a workflow notification lands on. The most common terminal
 * failures are exactly the ones where the obvious bot is gone — "this
 * node's bot was deleted", "the workflow was deleted" — so the answer is
 * the first bot that still EXISTS among: the current node's bot, every
 * other agent node's bot in graph order, then the owner of the run's
 * current thread and of the most recent node-result threads (a workflow
 * deleted under a run leaves no graph, but its task threads still name
 * their bots). undefined only when nobody is left to tell. */
export function workflowNotificationBotId(
  workflow: Workflow | null,
  run: WorkflowRun,
  lookup: NotificationBotLookup,
): string | undefined {
  const agents = (workflow?.nodes ?? []).filter((node): node is AgentNode => node.kind === "agent");
  const candidates: string[] = [];
  const current = agents.find((node) => node.id === run.currentNodeId);
  if (current) candidates.push(current.botId);
  for (const node of agents) candidates.push(node.botId);
  const threads = [run.currentThreadId, ...run.nodeResults.map((result) => result.threadId).reverse()];
  for (const threadId of threads) {
    if (threadId === undefined) continue;
    const owner = lookup.botByThread(threadId);
    if (owner !== undefined) candidates.push(owner);
  }
  return candidates.find((botId) => lookup.exists(botId));
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
