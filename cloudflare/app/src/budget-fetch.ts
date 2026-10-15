import type { BudgetRpc, BudgetScope } from "./budget-types";
import { count, hashSource, record } from "./budget-math";
import { HttpError } from "./http";

export interface BudgetFetchEnv { AI_BUDGET_REQUIRED?: string; BUDGETS?: { getByName(name: string): BudgetRpc } }
export interface BudgetFetchScope extends BudgetScope {
  operationId: string; provider: string;
  /** Trusted, credential-specific qualification, never a user request field or
   * inferred from zero/missing upstream usage. Absence disables paid API calls. */
  billingMode?: "openrouter_credits_qualified";
  assertActive?: () => Promise<void>;
}
export interface BudgetModelRequest { url: string; headers: HeadersInit; body: unknown }
export const budgetRequired = (env: BudgetFetchEnv): boolean => env.AI_BUDGET_REQUIRED === "true";
export function assertBudgetAdapter(env: BudgetFetchEnv, adapter: "browser_vision" | "jev"): void {
  if (budgetRequired(env) && adapter) throw new HttpError(409, "budget_adapter_unqualified");
}
function invalid(): never { throw new HttpError(409, "budget_request_unqualified"); }
function only(object: Record<string, unknown>, keys: string[]): void { if (Object.keys(object).some(key => !keys.includes(key))) invalid(); }
/** Qualifies only bounded text completions and client function tools. Native
 * server tools, plugins, media, cache directives, tiers and extra headers can
 * create charges outside the public text tariff and remain disabled. */
function qualifyRequest(request: BudgetModelRequest): { model: string; maxOutputTokens: number; body: Record<string, unknown>; headers: Headers } {
  if (request.url !== "https://openrouter.ai/api/v1/chat/completions") invalid();
  const headers = new Headers(request.headers);
  headers.forEach((_value, key) => { if (!["authorization", "content-type"].includes(key)) invalid(); });
  if (!headers.get("authorization")?.startsWith("Bearer ")) invalid();
  const serialized = JSON.stringify(request.body); if (!serialized || new TextEncoder().encode(serialized).length > 1_200_000) invalid();
  const body = record(JSON.parse(serialized));
  only(body, ["model", "max_tokens", "messages", "tools", "tool_choice", "parallel_tool_calls", "temperature", "stream"]);
  if (typeof body.model !== "string" || !count(body.max_tokens, 1_000_000) || (body.stream !== undefined && body.stream !== false)) invalid();
  if (!Array.isArray(body.messages) || !body.messages.length) invalid();
  for (const value of body.messages) {
    const message = record(value); only(message, ["role", "content", "tool_calls", "tool_call_id", "name", "reasoning", "reasoning_details", "refusal"]);
    if (!["system", "user", "assistant", "tool"].includes(String(message.role))) invalid();
    if (message.content != null && typeof message.content !== "string") {
      if (!Array.isArray(message.content)) invalid();
      for (const value of message.content) { const block = record(value); only(block, ["type", "text"]); if (block.type !== "text" || typeof block.text !== "string") invalid(); }
    }
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) invalid();
      for (const value of message.tool_calls) {
        const tool = record(value); only(tool, ["id", "type", "function", "index"]);
        const fn = record(tool.function); only(fn, ["name", "arguments"]);
        if (tool.type !== "function" || typeof fn.name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(fn.name) || typeof fn.arguments !== "string") invalid();
      }
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) invalid();
    for (const value of body.tools) {
      const tool = record(value); only(tool, ["type", "function"]); const fn = record(tool.function);
      only(fn, ["name", "description", "parameters", "strict"]);
      if (tool.type !== "function" || typeof fn.name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(fn.name)) invalid();
    }
  }
  if (body.tool_choice !== undefined && !["none", "auto", "required"].includes(String(body.tool_choice))) invalid();
  return { model: body.model as string, maxOutputTokens: Number(body.max_tokens), body, headers };
}
function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw new Error("model_request_canceled"); }
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  checkSignal(signal); let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new Error("model_request_canceled")); signal.addEventListener("abort", rejectAbort, { once: true }); });
  try { return await Promise.race([work(), aborted]); }
  finally { if (rejectAbort) signal.removeEventListener("abort", rejectAbort); }
}
async function readProviderJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("model_invalid_response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await abortable(() => reader.read(), signal); if (part.done) break;
      size += part.value.byteLength; if (size > 1_200_000) throw new Error("model_response_limit"); chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("model_invalid_response"); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Returns decoded JSON only after usage has been durably observed, before any
 * functional parser sees it. The caller supplies a stable operation ID derived
 * from persisted run/generation/call index; retries never mint a replacement ID.
 * This adapter requires a separately qualified OpenRouter credits credential.
 * It cannot establish that qualification from public prices or a response.
 */
export async function budgetedModelFetch(env: BudgetFetchEnv, scope: BudgetFetchScope, request: BudgetModelRequest, signal?: AbortSignal, requestFetch: typeof fetch = fetch): Promise<unknown> {
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
  const active = async () => { checkSignal(combined); await scope.assertActive?.(); checkSignal(combined); };
  await active();
  // Legacy non-budgeted brokers keep their existing lifecycle outside this adapter.
  if (!budgetRequired(env)) throw new HttpError(409, "budget_not_enabled");
  if (scope.provider !== "openrouter") throw new HttpError(409, "budget_adapter_unqualified");
  if (scope.billingMode !== "openrouter_credits_qualified") throw new HttpError(409, "budget_billing_unqualified");
  if (!env.BUDGETS) throw new HttpError(503, "budget_unavailable");
  const qualified = qualifyRequest(request), rpc = env.BUDGETS.getByName(scope.organizationId);
  const reservationId = `request:${await hashSource(JSON.stringify([scope.organizationId, scope.userId, scope.operationId]))}`;
  const key = { organizationId: scope.organizationId, reservationId };
  const requestHash = await hashSource(JSON.stringify({ url: request.url, body: qualified.body }));
  let reserved = false, dispatched = false, observed = false;
  try {
    const reservation = await rpc.reserve({ ...key, userId: scope.userId, operationId: scope.operationId, requestHash,
      provider: "openrouter", model: qualified.model, maxOutputTokens: qualified.maxOutputTokens });
    reserved = reservation.status === "reserved"; await active();
    const permission = await rpc.dispatch(key);
    if (!permission.dispatchAllowed) throw new HttpError(409, "budget_already_dispatched");
    dispatched = true; await active();
    const body = JSON.stringify({ ...qualified.body, ...reservation.controls });
    const pending = requestFetch(request.url, { method: "POST", headers: qualified.headers, body, redirect: "manual", signal: combined });
    // If a transport resolves after cancellation, discard its response; the
    // durable full reservation remains uncertain and is never released.
    void pending.then(response => { if (combined.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    let response: Response;
    try { response = await abortable(() => pending, combined); }
    catch { throw new Error(combined.aborted ? "model_request_canceled" : "model_request_failed"); }
    const data = await readProviderJson(response, combined);
    const receipt = await rpc.observe({ ...key, response: data }); observed = true;
    if (!response.ok) throw new Error("model_request_failed");
    if (receipt.status !== "settled") throw new HttpError(409, "budget_usage_uncertain");
    await active(); return data;
  } catch (error) {
    if (reserved && !dispatched) {
      // This RPC itself verifies undispatched state, including a lost dispatch
      // reply. It can never release a previously dispatched/replayed request.
      await rpc.releaseUndispatched(key).catch(() => {});
    } else if (dispatched && !observed) await rpc.uncertain(key).catch(() => {});
    throw error;
  }
}
