import { describe, expect, it } from "vitest";
import { appendToolResult, buildModelRequest, parseModelResponse, validateCodingTool } from "../src/model-broker";

describe("model protocols and untrusted tool boundaries", () => {
  it("uses Responses, Messages and Chat Completions without leaking keys into prompts", () => {
    const secret = "fixture-secret-never-a-real-key";
    for (const provider of ["openai", "anthropic", "openrouter"] as const) {
      const request = buildModelRequest(provider, "fixture-model", secret, [{ role: "user", content: "Fix a bug" }]);
      expect(JSON.stringify(request.body)).not.toContain(secret);
      expect(request.url).toBe(provider === "openai" ? "https://api.openai.com/v1/responses" : provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : "https://openrouter.ai/api/v1/chat/completions");
    }
  });
  it("retains OpenAI reasoning items and correlates tool results by call_id", () => {
    const output = [{ type: "reasoning", id: "r", encrypted_content: "encrypted" }, { type: "function_call", call_id: "call", name: "read_file", arguments: '{"path":"a.ts","offset":0,"limit":100}' }];
    const parsed = parseModelResponse("openai", { output, usage: { input_tokens: 10, output_tokens: 20 } });
    expect(parsed.items).toEqual(output);
    expect(parsed.calls[0].id).toBe("call");
    expect(parsed.tokens).toBe(30);
    const history = [...parsed.items];
    appendToolResult("openai", history, parsed.calls[0], "source");
    expect(history.at(-1)).toEqual({ type: "function_call_output", call_id: "call", output: "source" });
  });
  it("retains provider tool blocks and rejects malformed/oversized tools", () => {
    const parsed = parseModelResponse("anthropic", { content: [{ type: "tool_use", id: "a", name: "run_command", input: { command: "node --test", cwd: ".", timeoutMs: 1000 } }], usage: { input_tokens: 1, output_tokens: 2 } });
    expect(parsed.calls[0].tool.kind).toBe("run_command");
    expect(() => validateCodingTool("write_file", { path: "a", content: "x".repeat(1_048_577) })).toThrow();
    expect(() => validateCodingTool("run_command", { command: "test", cwd: ".", timeoutMs: 600001 })).toThrow();
    expect(() => validateCodingTool("fetch_secret", {})).toThrow();
    expect(() => validateCodingTool("read_file", { path: "a", offset: -1, limit: 100 })).toThrow();
  });
  it("does not treat malformed provider responses as completed work", () => {
    expect(() => parseModelResponse("openai", { status: "incomplete", output: [] })).toThrow();
    expect(() => parseModelResponse("openrouter", { choices: [] })).toThrow();
    expect(() => parseModelResponse("anthropic", { error: { message: "secret" } })).toThrow();
    expect(() => parseModelResponse("anthropic", { content: [{ type: "text", text: "Done" }] })).toThrow();
  });
  it("requires structured delegation/review and prevents the reviewer from executing code", () => {
    const usage = { input_tokens: 4, output_tokens: 3 };
    const review = { content: [{ type: "tool_use", id: "r", name: "submit_review", input: { approved: true, summary: "Verified diff and test receipt" } }], usage };
    expect(parseModelResponse("anthropic", review, "reviewer").calls[0].tool).toMatchObject({ kind: "submit_review", approved: true });
    expect(() => parseModelResponse("anthropic", review, "programmer")).toThrow();
    expect(() => parseModelResponse("anthropic", { content: [{ type: "tool_use", id: "r", name: "run_command", input: { command: "touch changed", cwd: ".", timeoutMs: 1 } }], usage }, "reviewer")).toThrow();
  });
});
