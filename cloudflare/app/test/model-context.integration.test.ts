import { describe, expect, it } from "vitest";
import { buildModelRequest, parseModelResponse, validateCodingTool } from "../src/model-broker";

describe("Graft context tools in every agent role", () => {
  it.each(["coordinator", "programmer", "reviewer"] as const)("offers bounded structural tools to %s without granting write tools", (role) => {
    const agent = { role, name: role, instructions: "Inspect source", provider: "anthropic" as const, model: "fixture", credentialVersion: 1 };
    const body = buildModelRequest("anthropic", "fixture", "fixture-key", [], agent).body;
    const encoded = JSON.stringify(body);
    for (const name of ["graft_map", "graft_grep", "graft_skeleton", "graft_callers"]) expect(encoded).toContain(`"${name}"`);
    if (role !== "programmer") expect(encoded).not.toContain('"name":"write_file"');
    const parsed = parseModelResponse("anthropic", { content: [{ type: "tool_use", id: "ctx", name: "graft_callers", input: { symbol: "handle", path: ".", direction: "in", depth: 2 } }], usage: { input_tokens: 8, output_tokens: 4 } }, role);
    expect(parsed.calls[0].tool).toEqual({ kind: "graft_callers", symbol: "handle", path: ".", direction: "in", depth: 2 });
  });
  it("rejects unrestricted graph traversal and malformed queries", () => {
    expect(validateCodingTool("graft_map", {})).toEqual({ kind: "graft_map" });
    expect(() => validateCodingTool("graft_callers", { symbol: "x", path: ".", direction: "in", depth: 99 })).toThrow();
    expect(() => validateCodingTool("graft_callers", { symbol: "x", path: ".", direction: "both", depth: 1 })).toThrow();
    expect(() => validateCodingTool("graft_grep", { pattern: "", path: "." })).toThrow();
    expect(() => validateCodingTool("graft_grep", { pattern: "x".repeat(1025), path: "." })).toThrow();
  });
});
