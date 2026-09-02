import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { RoutineRunOn } from "./routines.ts";
import { parseJson, schemaIssue, type JsonValue } from "./schema.ts";

export type WebhookTriggerInput = z.input<typeof triggerInputSchema>;
export type WebhookVerificationSample = z.output<typeof verificationSampleSchema>;
export type WebhookAttempt = z.output<typeof webhookAttemptSchema>;
export type WebhookAttemptOutcome = WebhookAttempt["outcome"];
type StoredWebhookTrigger = z.output<typeof storedWebhookSchema>;
export type WebhookTrigger = Omit<StoredWebhookTrigger, "secretHash">;
type DeliveryReceipt = z.output<typeof deliveryReceiptSchema>;
type WebhookFile = z.output<typeof webhookFileSchema>;

type CleanWebhookInput = Omit<
  WebhookTrigger,
  | "id"
  | "endpointId"
  | "createdAt"
  | "updatedAt"
  | "lastReceivedAt"
  | "lastRunId"
  | "deliveryCount"
  | "verifiedAt"
  | "verificationSample"
>;

interface CreatedWebhook {
  webhook: WebhookTrigger;
  secret: string;
}

export interface WebhookEvent {
  payload: JsonValue;
  contentType?: string;
  eventName?: string;
  userAgent?: string;
  deliveryId?: string;
}

export interface WebhookReceiveResult {
  runId?: string;
  deliveryId: string;
  duplicate: boolean;
  captured?: boolean;
  ignored?: boolean;
}

/** Where deliveries go: a MAUS (a routine-style task turn) or a workflow (a
 * workflow run). Exactly one — the webhook owns the link, and a record that
 * named both would leave "delete this MAUS" and "which run?" ambiguous. */
export type WebhookTarget = { botId: string; workflowId?: undefined } | { workflowId: string; botId?: undefined };

export type WebhookEnqueueInput = {
  webhookId: string;
  webhookName: string;
  /** The full routine prompt: the webhook's instruction block plus the
   * untrusted event data section. */
  prompt: string;
  /** The untrusted event data section alone — what a workflow run takes as
   * its input, since the graph's nodes carry their own instructions. */
  eventText: string;
  runOn: RoutineRunOn;
  deliveryId: string;
  receivedAt: number;
} & WebhookTarget;

export interface WebhookManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (event: WebhookManagerEvent) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  /** Whether a workflow with this id still exists. Absent, none does: a
   * workflow-targeted webhook then answers 410 rather than enqueueing into
   * a void. */
  workflowExists?: (workflowId: string) => boolean;
  /** The delivery sink. A throw here (a workflow that fails validation,
   * a MAUS gone between the guard and the queue) is recorded as a rejected
   * attempt and surfaces as the error's own status, or 422. */
  enqueue: (input: WebhookEnqueueInput) => { id: string };
  cancelQueued?: (webhookId: string, message: string) => void;
  pendingRuns?: (webhookId: string) => number;
}

export type WebhookManagerEvent =
  | { kind: "webhook"; webhook: WebhookTrigger }
  | { kind: "webhook.deleted"; webhookId: string }
  | { kind: "webhook.attempt"; attempt: WebhookAttempt };

const MAX_DELIVERIES = 2_000;
const MAX_ATTEMPTS = 2_000;
const MAX_EVENT_CHARS = 48_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;
const MAX_PENDING_RUNS = 3;

const runOnSchema = z.enum(["maus", "cloud"]);
const eventTypesSchema = z.array(z.string()).max(20).optional();
// A workflow id is a foreign key into the workflow store and is never
// rewritten: surrounding whitespace is refused, not trimmed (as the
// workflow API treats every identifier).
const workflowIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim(), "must not have surrounding whitespace");
const hasTarget = (value: { botId?: string; workflowId?: string }) =>
  value.botId !== undefined || value.workflowId !== undefined;
const triggerFieldsSchema = z.object({
  name: z.string(),
  /** Instructions for a MAUS-targeted webhook; a workflow's nodes carry
   * their own, so it is optional and defaults to empty. */
  prompt: z.string().optional(),
  botId: z.string().optional(),
  workflowId: workflowIdSchema.optional(),
  runOn: runOnSchema.optional(),
  enabled: z.boolean().optional(),
  verificationPending: z.boolean().optional(),
  eventTypes: eventTypesSchema,
});
const triggerInputSchema = triggerFieldsSchema.refine(hasTarget, "botId or workflowId is required");
// A patch may name neither (leave the target alone); the merged result is
// re-checked by cleanInput.
const triggerPatchSchema = triggerFieldsSchema.partial();
const verificationSampleSchema = z.object({
  receivedAt: z.number().finite().nonnegative(),
  eventName: z.string().optional(),
  contentType: z.string().optional(),
  preview: z.string(),
});
// botId went optional when workflow targets arrived; every record written
// before then carries a botId and no workflowId, so it still parses.
const storedWebhookSchema = z.object({
  id: z.string().min(1),
  endpointId: z.string().min(1),
  name: z.string(),
  prompt: z.string(),
  botId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  runOn: runOnSchema,
  enabled: z.boolean(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  lastReceivedAt: z.number().finite().nonnegative().optional(),
  lastRunId: z.string().optional(),
  deliveryCount: z.number().int().nonnegative(),
  verificationPending: z.boolean().optional(),
  verifiedAt: z.number().finite().nonnegative().optional(),
  verificationSample: verificationSampleSchema.optional(),
  eventTypes: eventTypesSchema,
  secretHash: z.string().regex(/^[a-f0-9]{64}$/),
}).refine(hasTarget, "botId or workflowId is required");
const deliveryReceiptSchema = z.object({
  key: z.string().min(1),
  runId: z.string().min(1),
  at: z.number().finite().nonnegative(),
});
const webhookAttemptSchema = z.object({
  id: z.string().min(1),
  webhookId: z.string().min(1),
  receivedAt: z.number().finite().nonnegative(),
  outcome: z.enum(["accepted", "captured", "duplicate", "ignored", "rejected"]),
  statusCode: z.number().int().min(100).max(599),
  eventName: z.string().optional(),
  preview: z.string().optional(),
  deliveryId: z.string().optional(),
  runId: z.string().optional(),
  reason: z.string().optional(),
});
const webhookFileSchema = z.object({
  version: z.literal(1),
  webhooks: z.array(storedWebhookSchema),
  deliveries: z.array(deliveryReceiptSchema),
  attempts: z.array(webhookAttemptSchema).optional(),
});
const taskPayloadSchema = z.object({ task: z.string().optional(), message: z.string().optional() });
const statusErrorSchema = z.object({ status: z.number().int().optional() });

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function invalidInput(error: z.ZodError): never {
  fail(400, schemaIssue(error, "Invalid webhook settings"));
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(secret: string, expectedHex: string): boolean {
  if (!secret) return false;
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function newEndpointId(): string {
  return `wh_${randomBytes(12).toString("base64url")}`;
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function cleanInput(input: WebhookTriggerInput): CleanWebhookInput {
  const name = input.name.trim().slice(0, 80);
  const prompt = (input.prompt ?? "").trim().slice(0, 20_000);
  // A blank botId is "no MAUS", so a form that always sends the field can
  // still pick a workflow.
  const botId = input.botId?.trim() || undefined;
  const workflowId = input.workflowId;
  const runOn = input.runOn ?? "maus";
  if (!name) fail(400, "Give the webhook a name");
  if (botId !== undefined && workflowId !== undefined) fail(400, "Choose either a MAUS or a workflow, not both");
  if (botId === undefined && workflowId === undefined) fail(400, "Choose a MAUS or a workflow");
  if (runOn !== "maus" && runOn !== "cloud") fail(400, "Choose where this webhook runs");
  const eventTypes = Array.from(new Set(
    (input.eventTypes ?? [])
      .map((value) => value.trim().slice(0, 200))
      .filter(Boolean),
  )).slice(0, 20);
  const enabled = input.enabled !== false;
  const clean: CleanWebhookInput = {
    name,
    prompt,
    runOn,
    enabled,
    verificationPending: enabled ? false : input.verificationPending === true,
  };
  if (workflowId !== undefined) clean.workflowId = workflowId;
  else clean.botId = botId;
  if (eventTypes.length) clean.eventTypes = eventTypes;
  return clean;
}

/** Exactly one of the two by the schemas' refine; the "neither" arm is
 * unreachable but keeps the union honest without an assertion. */
function targetOf(trigger: Pick<StoredWebhookTrigger, "botId" | "workflowId">): WebhookTarget {
  if (trigger.workflowId !== undefined) return { workflowId: trigger.workflowId };
  if (trigger.botId !== undefined) return { botId: trigger.botId };
  fail(500, "This webhook has no target");
}

function parseTriggerInput(value: JsonValue): WebhookTriggerInput {
  const parsed = triggerInputSchema.safeParse(value);
  if (!parsed.success) invalidInput(parsed.error);
  return parsed.data;
}

function parseTriggerPatch(value: JsonValue): Partial<WebhookTriggerInput> {
  const parsed = triggerPatchSchema.safeParse(value);
  if (!parsed.success) invalidInput(parsed.error);
  return parsed.data;
}

function publicTrigger(trigger: StoredWebhookTrigger): WebhookTrigger {
  const { secretHash: _secretHash, ...safe } = trigger;
  return { ...safe };
}

function serializePayload(payload: JsonValue): string {
  let text: string;
  const plainText = z.string().safeParse(payload);
  if (plainText.success) text = plainText.data;
  else {
    try {
      text = JSON.stringify(payload, null, 2) ?? String(payload);
    } catch {
      text = String(payload);
    }
  }
  if (text.length <= MAX_EVENT_CHARS) return text;
  return `${text.slice(0, MAX_EVENT_CHARS)}\n\n[Payload truncated by OpenMausBot]`;
}

function previewPayload(payload: JsonValue): string {
  return serializePayload(payload).replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function taskFromPayload(payload: JsonValue): string {
  const parsed = taskPayloadSchema.safeParse(payload);
  if (!parsed.success) return "";
  const task = parsed.data.task ?? parsed.data.message ?? "";
  return task.trim().slice(0, 20_000);
}

/** The untrusted section of a delivery prompt — metadata plus the bounded,
 * serialized payload between the markers — and nothing else. A workflow run
 * takes exactly this as its input: the graph's nodes carry their own
 * instructions, so no webhook prompt is prepended. */
export function eventDataBlock(event: WebhookEvent, receivedAt: number, deliveryId: string): string {
  const metadata = [
    `Received: ${new Date(receivedAt).toISOString()}`,
    `Delivery ID: ${deliveryId}`,
    event.eventName && `Event: ${event.eventName.slice(0, 200)}`,
    event.contentType && `Content-Type: ${event.contentType.slice(0, 200)}`,
    event.userAgent && `Sender: ${event.userAgent.slice(0, 300)}`,
  ].filter(Boolean);
  return [
    "[UNTRUSTED WEBHOOK EVENT DATA]",
    ...metadata,
    "",
    serializePayload(event.payload),
    "[/UNTRUSTED WEBHOOK EVENT DATA]",
  ].join("\n");
}

/** The routine prompt: the instruction block, then the event data block. */
function eventPrompt(trigger: StoredWebhookTrigger, event: WebhookEvent, receivedAt: number, deliveryId: string): string {
  const configured = trigger.prompt.trim();
  const requestedTask = configured ? "" : taskFromPayload(event.payload);
  const instructionBlock = configured
    ? ["[USER-CONFIGURED WEBHOOK INSTRUCTIONS]", configured, "[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]"]
    : requestedTask
      ? ["[AUTHENTICATED WEBHOOK TASK]", requestedTask, "[/AUTHENTICATED WEBHOOK TASK]"]
      : [
          "[DEFAULT WEBHOOK INSTRUCTIONS]",
          "Review the incoming event and summarize what happened. Do not take external actions unless the event clearly requires them and existing permissions allow them.",
          "[/DEFAULT WEBHOOK INSTRUCTIONS]",
        ];
  return [...instructionBlock, "", eventDataBlock(event, receivedAt, deliveryId)].join("\n");
}

export class WebhookManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: WebhookManagerOptions;
  private webhooks: StoredWebhookTrigger[] = [];
  private deliveries: DeliveryReceipt[] = [];
  private attempts: WebhookAttempt[] = [];
  private rate = new Map<string, number[]>();

  constructor(options: WebhookManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "webhooks.json");
    this.now = options.now ?? Date.now;
    try {
      const parsed = webhookFileSchema.safeParse(parseJson(readFileSync(this.file, "utf8")));
      if (!parsed.success) throw parsed.error;
      this.webhooks = parsed.data.webhooks;
      this.deliveries = parsed.data.deliveries.slice(-MAX_DELIVERIES);
      this.attempts = (parsed.data.attempts ?? []).slice(-MAX_ATTEMPTS);
    } catch {
      this.webhooks = [];
      this.deliveries = [];
      this.attempts = [];
    }
  }

  list(): WebhookTrigger[] {
    return this.webhooks.map(publicTrigger);
  }

  listAttempts(): WebhookAttempt[] {
    return this.attempts.map((attempt) => ({ ...attempt }));
  }

  create(input: JsonValue): CreatedWebhook {
    const clean = cleanInput(parseTriggerInput(input));
    this.assertTargetExists(clean);
    const now = this.now();
    const secret = newSecret();
    const trigger: StoredWebhookTrigger = {
      id: randomUUID(),
      endpointId: newEndpointId(),
      ...clean,
      secretHash: hashSecret(secret),
      createdAt: now,
      updatedAt: now,
      deliveryCount: 0,
    };
    this.webhooks.unshift(trigger);
    this.save();
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  update(id: string, value: JsonValue): WebhookTrigger | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const patch = parseTriggerPatch(value);
    // The target is replaced as a unit: naming either side of it drops the
    // other, so one field moves a webhook between a MAUS and a workflow and
    // a record never carries both.
    const retarget = patch.botId !== undefined || patch.workflowId !== undefined;
    const clean = cleanInput({
      name: patch.name ?? trigger.name,
      prompt: patch.prompt ?? trigger.prompt,
      botId: retarget ? patch.botId : trigger.botId,
      workflowId: retarget ? patch.workflowId : trigger.workflowId,
      runOn: patch.runOn ?? trigger.runOn,
      enabled: patch.enabled ?? trigger.enabled,
      verificationPending: patch.verificationPending ?? trigger.verificationPending,
      eventTypes: patch.eventTypes ?? trigger.eventTypes,
    });
    this.assertTargetExists(clean);
    Object.assign(trigger, clean, { updatedAt: this.now() });
    if (clean.botId === undefined) delete trigger.botId;
    if (clean.workflowId === undefined) delete trigger.workflowId;
    if (!clean.eventTypes?.length) delete trigger.eventTypes;
    if (patch.enabled === false) {
      this.options.cancelQueued?.(trigger.id, "The webhook was paused before this delivery started");
    }
    this.save();
    this.emit(trigger);
    return publicTrigger(trigger);
  }

  remove(id: string): boolean {
    const at = this.webhooks.findIndex((candidate) => candidate.id === id);
    if (at === -1) return false;
    const [trigger] = this.webhooks.splice(at, 1);
    this.deliveries = this.deliveries.filter((delivery) => !delivery.key.startsWith(`${trigger.endpointId}:`));
    this.attempts = this.attempts.filter((attempt) => attempt.webhookId !== trigger.id);
    this.rate.delete(trigger.endpointId);
    this.options.cancelQueued?.(trigger.id, "The webhook was deleted before this delivery started");
    this.save();
    this.options.emit?.({ kind: "webhook.deleted", webhookId: id });
    return true;
  }

  rotateSecret(id: string): { webhook: WebhookTrigger; secret: string } | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const secret = newSecret();
    trigger.secretHash = hashSecret(secret);
    trigger.updatedAt = this.now();
    this.save();
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  /** A deleted MAUS pauses the webhooks aimed at it. Workflow-targeted
   * webhooks have no botId and are never touched — the workflow's own
   * nodes decide what a missing bot means. */
  disableForBot(botId: string): void {
    let changed = false;
    for (const trigger of this.webhooks) {
      if (trigger.botId !== botId || !trigger.enabled) continue;
      trigger.enabled = false;
      trigger.updatedAt = this.now();
      this.options.cancelQueued?.(trigger.id, "The assigned MAUS was deleted");
      this.emit(trigger);
      changed = true;
    }
    if (changed) this.save();
  }

  authorize(endpointId: string, secret: string): boolean {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    return Boolean(trigger && secretMatches(secret, trigger.secretHash));
  }

  receive(endpointId: string, secret: string, event: WebhookEvent): WebhookReceiveResult {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger || !secretMatches(secret, trigger.secretHash)) fail(401, "Invalid webhook URL or secret");
    if (trigger.verificationPending && !trigger.enabled) return this.captureVerification(trigger, event);
    try {
      return this.dispatch(trigger, event);
    } catch (error) {
      const parsedError = statusErrorSchema.safeParse(error);
      const status = parsedError.success ? parsedError.data.status ?? 500 : 500;
      this.recordRejectedForTrigger(trigger, status, error instanceof Error ? error.message : String(error), event);
      throw error;
    }
  }

  test(id: string, payload: JsonValue = { event: "openmaus.test", message: "Test webhook delivery" }): WebhookReceiveResult | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const eventName = trigger.eventTypes?.[0] ?? "openmaus.test";
    return this.dispatch(trigger, {
      payload,
      contentType: "application/json",
      eventName,
      userAgent: "OpenMausBot webhook tester",
      deliveryId: `test-${randomUUID()}`,
    });
  }

  recordRejected(endpointId: string, statusCode: number, reason: string, event: Partial<WebhookEvent> = {}): WebhookAttempt | null {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger) return null;
    return this.recordRejectedForTrigger(trigger, statusCode, reason, event);
  }

  /** Management-time check that the target still exists (400); dispatch
   * makes the same check at delivery time (410). */
  private assertTargetExists(target: Pick<CleanWebhookInput, "botId" | "workflowId">): void {
    if (target.workflowId !== undefined) {
      if (!this.options.workflowExists?.(target.workflowId)) fail(400, "That workflow no longer exists");
      return;
    }
    if (target.botId === undefined || this.options.botState(target.botId) === "missing") fail(400, "That MAUS no longer exists");
  }

  private dispatch(trigger: StoredWebhookTrigger, event: WebhookEvent): WebhookReceiveResult {
    if (!trigger.enabled) fail(409, "This webhook is paused");
    const target = targetOf(trigger);
    if (target.workflowId !== undefined) {
      if (!this.options.workflowExists?.(target.workflowId)) fail(410, "The target workflow no longer exists");
    } else if (this.options.botState(target.botId) === "missing") {
      fail(410, "The assigned MAUS no longer exists");
    }

    const allowed = trigger.eventTypes ?? [];
    if (allowed.length > 0 && (!event.eventName || !allowed.includes(event.eventName))) {
      const deliveryId = String(event.deliveryId ?? "").trim().slice(0, 200) || randomUUID();
      this.appendAttempt(trigger, event, {
        outcome: "ignored",
        statusCode: 202,
        deliveryId,
        reason: event.eventName ? `Event type “${event.eventName}” is not enabled` : "Event type is missing",
      });
      this.save();
      return { deliveryId, duplicate: false, ignored: true };
    }

    const now = this.now();
    const requestedDeliveryId = String(event.deliveryId ?? "").trim().slice(0, 200);
    if (requestedDeliveryId) {
      const key = `${trigger.endpointId}:${requestedDeliveryId}`;
      const duplicate = this.deliveries.find((delivery) => delivery.key === key);
      if (duplicate) {
        this.appendAttempt(trigger, event, {
          outcome: "duplicate",
          statusCode: 202,
          deliveryId: requestedDeliveryId,
          runId: duplicate.runId,
          reason: "Duplicate delivery ignored",
        });
        this.save();
        return { runId: duplicate.runId, deliveryId: requestedDeliveryId, duplicate: true };
      }
    }

    // A sender retrying an already-accepted delivery must remain idempotent
    // even while this webhook's queue is full. Only new work consumes a slot.
    if ((this.options.pendingRuns?.(trigger.id) ?? 0) >= MAX_PENDING_RUNS) {
      fail(429, "This webhook already has too many unfinished tasks");
    }

    const recent = (this.rate.get(trigger.endpointId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) fail(429, "Webhook rate limit exceeded");
    recent.push(now);
    this.rate.set(trigger.endpointId, recent);

    const deliveryId = requestedDeliveryId || randomUUID();
    let run: { id: string };
    try {
      run = this.options.enqueue({
        webhookId: trigger.id,
        webhookName: trigger.name,
        prompt: eventPrompt(trigger, event, now, deliveryId),
        eventText: eventDataBlock(event, now, deliveryId),
        runOn: trigger.runOn,
        deliveryId,
        receivedAt: now,
        ...target,
      });
    } catch (error) {
      // Nothing was queued, so the delivery id stays unspent and the
      // sender's retry is a fresh attempt, not a "duplicate". receive()
      // records the rejection; the status is the sink's own when it names
      // one (a MAUS gone: 410), else 422 — the event was well-formed, the
      // target could not take it (a workflow that fails validation).
      const parsedError = statusErrorSchema.safeParse(error);
      const status = parsedError.success && parsedError.data.status !== undefined ? parsedError.data.status : 422;
      fail(status, error instanceof Error ? error.message : String(error));
    }
    this.deliveries.push({ key: `${trigger.endpointId}:${deliveryId}`, runId: run.id, at: now });
    if (this.deliveries.length > MAX_DELIVERIES) {
      this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
    }
    trigger.lastReceivedAt = now;
    trigger.lastRunId = run.id;
    trigger.deliveryCount += 1;
    trigger.updatedAt = now;
    this.appendAttempt(trigger, event, {
      outcome: "accepted",
      statusCode: 202,
      deliveryId,
      runId: run.id,
    });
    this.save();
    this.emit(trigger);
    return { runId: run.id, deliveryId, duplicate: false };
  }

  private captureVerification(trigger: StoredWebhookTrigger, event: WebhookEvent): WebhookReceiveResult {
    const receivedAt = this.now();
    const deliveryId = String(event.deliveryId ?? "").trim().slice(0, 200) || randomUUID();
    trigger.verificationPending = false;
    trigger.verifiedAt = receivedAt;
    trigger.lastReceivedAt = receivedAt;
    trigger.updatedAt = receivedAt;
    const sample: WebhookVerificationSample = {
      receivedAt,
      preview: previewPayload(event.payload),
    };
    if (event.eventName) sample.eventName = event.eventName.slice(0, 200);
    if (event.contentType) sample.contentType = event.contentType.slice(0, 200);
    trigger.verificationSample = sample;
    this.appendAttempt(trigger, event, {
      outcome: "captured",
      statusCode: 202,
      deliveryId,
      reason: "Test event captured; enable the webhook to start MAUS tasks",
    });
    this.save();
    this.emit(trigger);
    return { deliveryId, duplicate: false, captured: true };
  }

  private recordRejectedForTrigger(trigger: StoredWebhookTrigger, statusCode: number, reason: string, event: Partial<WebhookEvent>): WebhookAttempt {
    const attempt = this.appendAttempt(trigger, event, {
      outcome: "rejected",
      statusCode,
      reason: reason.slice(0, 500),
      deliveryId: event.deliveryId,
    });
    this.save();
    return attempt;
  }

  private appendAttempt(
    trigger: StoredWebhookTrigger,
    event: Partial<WebhookEvent>,
    details: Pick<WebhookAttempt, "outcome" | "statusCode"> & Partial<Pick<WebhookAttempt, "deliveryId" | "runId" | "reason">>,
  ): WebhookAttempt {
    const attempt: WebhookAttempt = {
      id: randomUUID(),
      webhookId: trigger.id,
      receivedAt: this.now(),
      outcome: details.outcome,
      statusCode: details.statusCode,
    };
    if (event.eventName) attempt.eventName = event.eventName.slice(0, 200);
    if (event.payload !== undefined) attempt.preview = previewPayload(event.payload);
    if (details.deliveryId) attempt.deliveryId = details.deliveryId.slice(0, 200);
    if (details.runId) attempt.runId = details.runId;
    if (details.reason) attempt.reason = details.reason;
    this.attempts.push(attempt);
    if (this.attempts.length > MAX_ATTEMPTS) this.attempts.splice(0, this.attempts.length - MAX_ATTEMPTS);
    this.options.emit?.({ kind: "webhook.attempt", attempt: { ...attempt } });
    return attempt;
  }

  private emit(trigger: StoredWebhookTrigger): void {
    this.options.emit?.({ kind: "webhook", webhook: publicTrigger(trigger) });
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: 1, webhooks: this.webhooks, deliveries: this.deliveries, attempts: this.attempts } satisfies WebhookFile, null, 2),
      { mode: 0o600 },
    );
  }
}
