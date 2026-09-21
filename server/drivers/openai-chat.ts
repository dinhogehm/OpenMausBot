import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import { toolDetailPreview } from "../tool-summary.ts";
import { ChatToolSessionError, mountChatTools, type ChatToolDefinition, type ChatToolSession } from "./chat-mcp-tools.ts";
import { createChatToolApproval } from "./chat-tool-approval.ts";
import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls, MAX_CHAT_TOOL_CALLS, object, type ChatToolCall } from "./openai-chat-protocol.ts";
import { appendNative } from "./native.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning_details?: Record<string, unknown>[];
}

interface Usage {
  input: number;
  output: number;
}

interface Completion {
  text: string;
  reasoning: string;
  usage: Usage | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  protocolReasoning: string;
  protocolReasoningDetails: Record<string, unknown>[];
}

interface CompletionJson {
  choices?: Array<{
    index?: number;
    message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    finish_reason?: string | null;
  }>;
  error?: unknown;
  base_resp?: { status_code?: unknown; status_msg?: unknown };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The message of a JSON error body a provider returned with HTTP 200.
 *  MiniMax reports auth, balance, and parameter failures as `base_resp`. */
function providerError(json: CompletionJson): string | null {
  if (typeof json.error === "string") return json.error;
  const error = object(json.error);
  if (error) return typeof error.message === "string" ? error.message : "unknown error";
  const code = json.base_resp?.status_code;
  if (typeof code === "number" && code !== 0) {
    const msg = typeof json.base_resp?.status_msg === "string" ? json.base_resp.status_msg : "";
    return `upstream error ${code}${msg ? `: ${msg}` : ""}`;
  }
  return null;
}

interface NativeLog {
  source: string;
  outgoing(turn: SendTurnInput, messages: OpenAIChatMessage[], model: string): unknown;
  incoming(completion: Completion): unknown;
}

interface RuntimeOptions<Config> {
  input: DriverCreateInput<Config>;
  driverKind: string;
  apiKey: string;
  apiUrl: string;
  models: () => ModelCatalog;
  requestBody(model: string, messages: OpenAIChatMessage[], stream: boolean): Record<string, unknown>;
  httpErrorLabel: string;
  missingKeyError: string;
  unavailableReason: string;
  timeoutMs: number;
  nativeLog: NativeLog;
  refreshModels?: () => Promise<void>;
  generateModel?: () => string;
  reasoning?: boolean;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  retryScale?: number;
  /** Explicit text-only mode for endpoints/models that cannot accept tools. */
  tools?: boolean;
  /** Non-secret attribution headers a gateway asks for (OpenRouter's
   * HTTP-Referer / X-Title). Authorization always wins over these. */
  extraHeaders?: Record<string, string>;
}

const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
    : null;

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

/** Shared runtime for the three providers that speak OpenAI chat completions. */
/** What went wrong with one tool call, as the person needs to hear it. An
 * approval nobody answered is not a refusal, and neither is a call the
 * model malformed — only "failed" means something actually ran and broke. */
export type ToolProblemKind = "failed" | "denied" | "unanswered" | "rejected";
export interface ToolProblem { name: string; kind: ToolProblemKind }

/** The chip that carries the note shows at most this much of it. */
export const TOOL_NOTICE_MAX_CHARS = 160;
const RECEIPT_WARNING = "Read the reply as a report, not a receipt";

/** Harness-owned MCP servers prefix every tool; the prefix says nothing. */
const shortToolName = (name: string): string => name.replace(/^composio_composio_/, "composio:");

/** The harness's own line when a turn ends in a reply after a tool call did
 * not do what the model may say it did.
 *
 * A chat model that was denied a write will happily close with "done, I
 * pushed it", so the reply must never read as a receipt. That sentence
 * leads, so no truncation can cut it. What follows says what actually
 * happened, because the cases need different responses from the person:
 * a tool that FAILED while running is a problem to look at; an approval
 * that went UNANSWERED is fifteen minutes nobody was at the card; a call
 * REJECTED before running is the model's own malformed request, harmless.
 * Only failures are named — the rest are counted — so the line fits the
 * chip even with the long names harness MCP servers give their tools. */
export function toolFailureNotice(problems: readonly ToolProblem[]): string {
  const count = (kind: ToolProblemKind) => problems.filter((problem) => problem.kind === kind);
  const failed = count("failed");
  const denied = count("denied").length;
  const unanswered = count("unanswered").length;
  const rejected = count("rejected").length;
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));
  const build = (withNames: boolean): string => {
    const parts: string[] = [];
    if (failed.length) {
      const names = withNames ? ` (${[...new Set(failed.map((problem) => shortToolName(problem.name)))].join(", ")})` : "";
      parts.push(`${plural(failed.length, "1 tool failed", "# tools failed")} while running${names}`);
    }
    if (denied) parts.push(plural(denied, "1 call was denied", "# calls were denied"));
    if (unanswered) parts.push(plural(unanswered, "1 approval went unanswered", "# approvals went unanswered"));
    if (rejected) parts.push(plural(rejected, "1 call was rejected before running", "# calls were rejected before running"));
    return `${RECEIPT_WARNING} — ${parts.join("; ")}.`;
  };
  const full = build(true);
  if (full.length <= TOOL_NOTICE_MAX_CHARS) return full;
  const counted = build(false);
  return counted.length <= TOOL_NOTICE_MAX_CHARS ? counted : `${counted.slice(0, TOOL_NOTICE_MAX_CHARS - 1)}…`;
}

export function createOpenAIChatRuntime<Config>(options: RuntimeOptions<Config>): ProviderInstance {
  const { input } = options;
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, {
    abort: AbortController;
    turnId: string;
    done: Promise<void>;
    approval: ReturnType<typeof createChatToolApproval>;
  }>();

  const emit = (event: RuntimeEvent) => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const base = (threadId: string, turnId: string) => ({
    eventId: newEventId(),
    provider: options.driverKind,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
  });

  const complete = async (
    messages: OpenAIChatMessage[],
    model: string,
    stream: boolean,
    signal?: AbortSignal,
    onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void,
    tools: ChatToolDefinition[] = [],
  ): Promise<Completion> => {
    // Idle timer that is renewed on every received chunk during streaming
    const timeoutController = new AbortController();
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutController.abort(new DOMException("Streaming idle timeout elapsed", "AbortError"));
      }, options.timeoutMs);
    };

    resetIdleTimer();

    try {
      const activeSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      const response = await fetch(`${options.apiUrl}/chat/completions`, {
        method: "POST",
        headers: { ...options.extraHeaders, authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...options.requestBody(model, messages, stream),
          ...(tools.length ? { tools } : {}),
        }),
        signal: activeSignal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${options.httpErrorLabel} HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }

      if (!stream || response.headers.get("content-type")?.includes("application/json")) {
        const json = await response.json() as CompletionJson;
        const bodyError = providerError(json);
        if (bodyError) throw new ChatProtocolError(`provider returned a completion error: ${bodyError.slice(0, 200)}`);
        const message = json.choices?.[0]?.message;
        if (!message || !object(message) || !["content", "reasoning_content", "reasoning", "reasoning_details", "tool_calls", "function_call"].some((key) => key in message)) {
          throw new ChatProtocolError("provider returned no completion message");
        }
        if (message?.function_call) throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
        const calls = new ChatToolCalls();
        calls.add(message?.tool_calls, false);
        const details = new ChatReasoningDetails();
        details.add(message.reasoning_details);
        const reasoning = message.reasoning_content ?? message.reasoning;
        const finishReason = json.choices?.[0]?.finish_reason ?? null;
        activeSignal.throwIfAborted();
        return {
          text: typeof message?.content === "string" ? message.content : "",
          reasoning: options.reasoning && typeof reasoning === "string"
            ? reasoning
            : "",
          usage: usageFrom(json.usage),
          toolCalls: calls.finish(finishReason, false),
          finishReason,
          protocolReasoning: typeof reasoning === "string" ? reasoning : "",
          protocolReasoningDetails: details.blocks,
        };
      }

      if (!response.body) {
        throw new Error(options.noBodyError ?? `${options.httpErrorLabel} returned no response body`);
      }
      let text = "";
      let reasoning = "";
      let protocolReasoning = "";
      let usage: Usage | null = null;
      let finishReason: string | null = null;
      let malformedFrame = false;
      let sawChoice = false;
      const calls = new ChatToolCalls();
      const details = new ChatReasoningDetails();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consumeDataLine = (line: string, atEof = false): boolean => {
        if (!line.startsWith("data:")) return false;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return true;
        let chunk: CompletionJson;
        try {
          chunk = JSON.parse(data) as CompletionJson;
        } catch {
          // A tail left in the buffer when the socket closed is an INCOMPLETE
          // frame, not a bad one: a stop, an abort or a dropped connection all
          // end mid-frame. Only a properly newline-terminated frame that will
          // not parse means the provider actually sent something malformed.
          // Counting the tail here turned a stopped turn into a hard,
          // non-retryable failure (`calls.finish(finishReason, malformedFrame)`).
          if (!atEof) malformedFrame = true;
          return false;
        }
        const chunkError = providerError(chunk);
        if (chunkError) throw new ChatProtocolError(`provider returned a streaming completion error: ${chunkError.slice(0, 200)}`);
        const choice = chunk.choices?.find((row) => row.index === undefined || row.index === 0);
        const delta = choice?.delta;
        if (object(delta)) sawChoice = true;
        if (delta?.function_call) throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
        calls.add(delta?.tool_calls, true);
        details.add(delta?.reasoning_details);
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const reasoningPart = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoningPart === "string") protocolReasoning += reasoningPart;
        const reasoningDelta = options.reasoning && typeof reasoningPart === "string"
          ? reasoningPart
          : "";
        const contentDelta = typeof delta?.content === "string" ? delta.content : "";
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          onDelta?.(reasoningDelta, "reasoning_text");
        }
        if (contentDelta) {
          text += contentDelta;
          onDelta?.(contentDelta, "assistant_text");
        }
        if (chunk.usage) usage = usageFrom(chunk.usage);
        return false;
      };
      try {
        readLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            const line = buffer.trim();
            if (line && line !== "data: [DONE]") consumeDataLine(line, true);
            // MiniMax's api.minimax.io/v1 closes the connection after the
            // finish_reason chunk and never sends `[DONE]`.
            if (buffer.trim() === "data: [DONE]" || finishReason) break;
            if (!sawChoice) {
              let body: CompletionJson | undefined;
              try { body = JSON.parse(buffer) as CompletionJson; } catch { body = undefined; }
              const bodyError = body ? providerError(body) : null;
              if (bodyError) throw new ChatProtocolError(`provider returned a completion error: ${bodyError.slice(0, 200)}`);
            }
            throw new ChatProtocolError("Stream ended before completion");
          }
          resetIdleTimer();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 2_000_000) throw new ChatProtocolError("provider stream frame exceeded the size limit");
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (consumeDataLine(line)) break readLoop;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      activeSignal.throwIfAborted();
      if (!sawChoice) throw new ChatProtocolError("provider returned no streaming completion choice");
      return { text, reasoning, usage, toolCalls: calls.finish(finishReason, malformedFrame), finishReason, protocolReasoning, protocolReasoningDetails: details.blocks };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  };

  const messagesFor = (turn: SendTurnInput): OpenAIChatMessage[] => [
    ...(turn.system ? [{ role: "system" as const, content: turn.system }] : []),
    ...(turn.transcript ?? []).map((message) => ({
      role: message.role,
      content: message.text,
    })),
    { role: "user", content: turn.text },
  ];

  const sendTurn = async (turn: SendTurnInput) => {
    if (!options.apiKey) throw new Error(options.missingKeyError);
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");

    const turnId = newId();
    const abort = new AbortController();
    const messages = messagesFor(turn);
    const model = turn.model || options.models().default;
    const secrets = [options.apiKey];
    for (const integration of Object.values(turn.integrations ?? {})) {
      const entries = object(integration);
      const specs = entries && "command" in entries ? [entries] : Object.values(entries ?? {}).map(object);
      for (const spec of specs) {
        for (const [key, value] of Object.entries(object(spec?.env) ?? {})) {
          if (/key|token|password|secret|authorization/i.test(key) && typeof value === "string" && value) secrets.push(value);
        }
      }
    }
    const safeText = (text: string) => {
      let safe = text;
      for (const secret of secrets) if (secret) safe = safe.split(secret).join("[redacted]");
      return redactSecretsInText(safe);
    };
    const preview = (value: unknown) => toolDetailPreview(JSON.parse(JSON.stringify(value, (_key, part) =>
      typeof part === "string" ? safeText(part) : part)));
    const native = (dir: "out" | "in", msg: unknown) => appendNative(turn.threadId, {
      dir, source: options.nativeLog.source,
      msg: JSON.parse(JSON.stringify(msg, (_key, part) => typeof part === "string" ? safeText(part) : part)),
    });
    const approval = createChatToolApproval({
      signal: abort.signal,
      open: (ask) => emit({
        ...base(turn.threadId, turnId), type: "request.opened", requestType: "permission",
        requestId: ask.id, tool: ask.tool, summary: ask.summary, allowSession: false,
      }),
      resolved: (ask, allowed, source) => emit({
        ...base(turn.threadId, turnId), type: "request.resolved", requestId: ask.id,
        behavior: allowed ? "allow" : "deny", source,
      }),
    });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    active.set(turn.threadId, { abort, turnId, done, approval });
    emit({ ...base(turn.threadId, turnId), type: "turn.started" });
    emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model });

    void (async () => {
      let tools: ChatToolSession | undefined;
      const usage: Usage = { input: 0, output: 0 };
      let hasUsage = false;
      let ok = false;
      let stopReason: string | null = null;
      let failure: string | undefined;
      /** Every call that did not do what the model may claim, and why. */
      const toolProblems: ToolProblem[] = [];
      const denials: string[] = [];
      const seenCalls = new Set<string>();
      try {
        tools = await mountChatTools(options.tools === false ? undefined : turn.integrations, abort.signal);
        for (let round = 0; round < 16; round++) {
          abort.signal.throwIfAborted();
          native("out", options.nativeLog.outgoing(turn, messages, model));
          let attempt = 0;
          let completion: Completion;
          for (;;) {
            let streamed = false;
            const pending = { assistant_text: "", reasoning_text: "" };
            const delta = (text: string, streamKind: keyof typeof pending, flush = false) => {
              let combined = pending[streamKind] + text;
              // Mask complete matches before holding a suffix: otherwise a key
              // such as "abab" could be split at its own repeated prefix.
              for (const secret of secrets) if (secret) combined = combined.split(secret).join("[redacted]");
              let hold = 0;
              // A configured credential can straddle chunks. Hold any suffix
              // that could be its prefix until the next chunk disambiguates it.
              if (!flush) for (const secret of secrets) {
                for (let length = Math.min(secret.length - 1, combined.length); length > hold; length--) {
                  if (combined.endsWith(secret.slice(0, length))) { hold = length; break; }
                }
              }
              pending[streamKind] = hold ? combined.slice(-hold) : "";
              const visible = safeText(hold ? combined.slice(0, -hold) : combined);
              if (visible) emit({ ...base(turn.threadId, turnId), type: "content.delta", streamKind, delta: visible });
            };
            try {
              completion = await complete(messages, model, true, abort.signal, (text, streamKind) => {
                streamed = true;
                delta(text, streamKind);
              }, tools.definitions);
              delta("", "assistant_text", true);
              delta("", "reasoning_text", true);
              break;
            } catch (value) {
              const error = asError(value);
              const verdict = classifyError(error);
              // Once a call has been handled, never replay it through a turn retry.
              if (options.retryScale === undefined || abort.signal.aborted || streamed || seenCalls.size ||
                  error instanceof ChatProtocolError || !verdict.transient || attempt >= RETRY_MAX_ATTEMPTS - 1) throw error;
              const delayMs = computeBackoff(attempt++);
              emit({ ...base(turn.threadId, turnId), type: "turn.retrying", attempt, delayMs, reason: verdict.reason });
              await interruptibleDelay(delayMs * options.retryScale, abort.signal).promise;
              abort.signal.throwIfAborted();
            }
          }
          native("in", options.nativeLog.incoming(completion));
          if (completion.usage) {
            usage.input += completion.usage.input;
            usage.output += completion.usage.output;
            hasUsage = true;
            emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", ...usage });
          }
          // Reasoning on a tool-call round belongs to the protocol, not a final reply.
          const reply = completion.text.trim() ? completion.text : completion.toolCalls.length ? "" : completion.reasoning;
          if (reply.trim()) emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: safeText(reply) });
          abort.signal.throwIfAborted();
          if (!completion.toolCalls.length) {
            if (!reply.trim()) throw new ChatProtocolError("provider returned an empty response");
            if (completion.finishReason && completion.finishReason !== "stop") {
              throw new ChatProtocolError(`provider did not finish the response (${completion.finishReason})`);
            }
            // A failed or denied tool does not make this a broken run.
            // Mark it instead of failing it: the note is not terminal, so
            // the reply stands beside a chip naming what did not execute.
            if (toolProblems.length) {
              stopReason = "tool_error";
              emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: toolFailureNotice(toolProblems), terminal: false });
            }
            ok = true;
            break;
          }
          if (!tools.definitions.length) throw new ChatProtocolError("provider returned tool calls, but no tools are available for this turn");
          // Validate IDs for the entire batch before executing any of its calls.
          for (const call of completion.toolCalls) {
            if (seenCalls.has(call.id)) throw new ChatProtocolError("provider reused a tool-call ID; refusing to repeat an operation");
            seenCalls.add(call.id);
          }
          if (seenCalls.size > MAX_CHAT_TOOL_CALLS) throw new ChatProtocolError("tool-call limit reached");
          messages.push({ role: "assistant", content: completion.text || null, tool_calls: completion.toolCalls,
            ...(completion.protocolReasoning ? { reasoning_content: completion.protocolReasoning } : {}),
            ...(completion.protocolReasoningDetails.length ? { reasoning_details: completion.protocolReasoningDetails } : {}),
          });
          for (const call of completion.toolCalls) {
            abort.signal.throwIfAborted();
            let result: { text: string; ok: boolean };
            let started = false;
            let fatal: Error | undefined;
            // Where a call stopped decides what the closing note says about it.
            let problem: ToolProblemKind = "rejected";
            try {
              let args: unknown;
              try { args = JSON.parse(call.function.arguments); }
              catch { throw new ChatProtocolError("tool arguments are not complete JSON"); }
              if (!object(args)) throw new ChatProtocolError("tool arguments must be a JSON object");
              tools.validate(call.function.name, args);
              const inputPreview = preview(args);
              // Full access is the person's explicit grant to answer every
              // prompt. This runtime has no provider reviewer to hand it to,
              // so it is honoured here: without it every single tool call on
              // an OpenAI-compatible engine stops for a card, and a Chief's
              // delegated Full access cannot help either.
              // The bot's own built-in browser was authorized by mounting it
              // (turn-scoped capability, its own profile), as Claude does.
              const decision = turn.approvalMode === "full" || tools.preAllowed(call.function.name)
                ? { allowed: true, source: "system" as const }
                : await approval.decide(call.function.name, inputPreview ?? "This tool has no arguments.");
              const allowed = decision.allowed;
              if (!allowed) problem = decision.source === "timeout" ? "unanswered" : "denied";
              abort.signal.throwIfAborted();
              emit({ ...base(turn.threadId, turnId), type: "item.started", itemType: "tool", itemId: call.id,
                title: call.function.name, ...(inputPreview ? { input: inputPreview } : {}),
              });
              started = true;
              if (allowed) {
                problem = "failed";
                result = await tools.execute(call.function.name, args as Record<string, unknown>, abort.signal);
              } else {
                denials.push(call.function.name);
                result = { ok: false, text: "Permission denied or expired; the tool was not executed." };
              }
            } catch (error) {
              if (error instanceof ChatToolSessionError) fatal = error;
              result = { ok: false, text: abort.signal.aborted
                ? "Tool interrupted; an operation already dispatched may have taken effect. Verify its state before retrying."
                : safeText(asError(error).message).slice(0, 2_000) };
            }
            if (!started) emit({ ...base(turn.threadId, turnId), type: "item.started", itemType: "tool", itemId: call.id, title: call.function.name });
            const text = safeText(result.text);
            const output = preview({ ok: result.ok, result: text });
            emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "tool", itemId: call.id, ok: result.ok, output });
            if (!result.ok) toolProblems.push({ name: call.function.name, kind: problem });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: result.ok, result: text }) });
            abort.signal.throwIfAborted();
            if (fatal) throw fatal;
          }
        }
        if (!ok) throw new ChatProtocolError("model-call limit reached before a final response");
      } catch (value) {
        stopReason = abort.signal.aborted ? "interrupted" : stopReason ?? "error";
        failure = safeText(asError(value).message).slice(0, 2_000);
      } finally {
        approval.close();
        let cleanupFailed = false;
        try { await tools?.close(); }
        catch {
          ok = false;
          stopReason = "error";
          cleanupFailed = true;
          failure = "Tool processes could not be stopped; their execution state is uncertain.";
        }
        if (abort.signal.aborted) { ok = false; stopReason = "interrupted"; }
        if (failure && (!abort.signal.aborted || cleanupFailed)) {
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: failure, terminal: !abort.signal.aborted });
        }
        active.delete(turn.threadId);
        emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok, stopReason, cost: null,
          ...(hasUsage && (options.includeUsageInCompleted || seenCalls.size) ? { usage } : {}),
          ...(denials.length ? { denials } : {}),
        });
        resolveDone();
      }
    })();
    return { turnId };
  };

  return {
    instanceId: input.instanceId,
    driverKind: options.driverKind,
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return options.models();
    },
    ...(options.refreshModels ? { refreshModels: options.refreshModels } : {}),
    snapshot: async () => options.apiKey
      ? { state: "available", authenticated: true, version: null, ...(options.billing ? { billing: options.billing } : {}) }
      : { state: "unavailable", reason: options.unavailableReason },
    adapter: {
      provider: options.driverKind,
      capabilities: {
        sessionModelSwitch: "in-session",
        customMcp: options.tools !== false,
        agentsMcp: options.tools !== false,
        composioMcp: options.tools !== false,
        // mountChatTools starts the built-in browser's stdio proxy like any
        // other MCP server; its results are text snapshots this runtime reads
        browserMcp: options.tools !== false,
      },
      sendTurn,
      interruptTurn: async (threadId, turnId) => {
        const turn = active.get(threadId);
        if (!turn || (turnId && turn.turnId !== turnId)) return;
        turn.abort.abort();
        await turn.done;
      },
      respondToRequest: async (threadId, requestId, decision) =>
        active.get(threadId)?.approval.answer(requestId, decision.behavior) ?? "unavailable",
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        const turns = [...active.values()];
        for (const turn of turns) turn.abort.abort();
        await Promise.all(turns.map((turn) => turn.done));
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    generateText: async (prompt, { signal } = {}) => {
      const model = options.generateModel?.() ?? options.models().default;
      const { text, reasoning, toolCalls } = await complete([{ role: "user", content: prompt }], model, false, signal);
      if (toolCalls.length) throw new ChatProtocolError("provider returned tool calls to a text-only helper");
      return text.trim() ? text : reasoning;
    },
    dispose: async () => {
      const turns = [...active.values()];
      for (const turn of turns) turn.abort.abort();
      await Promise.all(turns.map((turn) => turn.done));
      listeners.clear();
    },
  };
}
