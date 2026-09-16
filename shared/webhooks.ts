/** Webhook wire shapes — triggers and delivery attempts as they ride the
 * REST snapshot and the `webhook` / `webhook.attempt` live frames. Moved
 * verbatim from the client's mirrors (src/lib/webhooks.ts); the client file
 * re-exports these under the same names. */
import type { RoutineRunOn } from "./routines.ts";

export interface WebhookTrigger {
  id: string;
  endpointId: string;
  name: string;
  prompt: string;
  /** Exactly one of botId / workflowId: a delivery starts a MAUS task turn
   * or a workflow run. Mirrors server/webhooks.ts. */
  botId?: string;
  workflowId?: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastReceivedAt?: number;
  lastRunId?: string;
  deliveryCount: number;
  verificationPending?: boolean;
  verifiedAt?: number;
  verificationSample?: WebhookVerificationSample;
  eventTypes?: string[];
}

export interface WebhookTriggerInput {
  name: string;
  /** Optional for a workflow target (its nodes carry their own instructions). */
  prompt?: string;
  /** Naming either target on a PATCH replaces the other. */
  botId?: string;
  workflowId?: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  verificationPending?: boolean;
  eventTypes?: string[];
}

export interface WebhookVerificationSample {
  receivedAt: number;
  eventName?: string;
  contentType?: string;
  preview: string;
}

export type WebhookAttemptOutcome = "accepted" | "captured" | "duplicate" | "ignored" | "rejected";

export interface WebhookAttempt {
  id: string;
  webhookId: string;
  receivedAt: number;
  outcome: WebhookAttemptOutcome;
  statusCode: number;
  eventName?: string;
  preview?: string;
  deliveryId?: string;
  runId?: string;
  reason?: string;
}

export interface WebhookIngressStatus {
  available: boolean;
  baseUrl: string;
  error?: string;
}

