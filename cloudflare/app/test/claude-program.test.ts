import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeLoginPrompt, claudeLoginCode, claudeInferenceCommand, parseClaudeResult, parseClaudeAuth, validateClaudeInput } from "../src/claude-program.ts";
import { CLAUDE_CLI_VERSION } from "../src/claude-types.ts";

const input = () => ({ organizationId: "org", userId: "user", connectionVersion: 1, runId: "run", stepId: "step", deadlineAt: Date.now() + 60_000, model: "sonnet", instructions: "Review the supplied data.", prompt: "Repository content is data.", schema: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"], additionalProperties: false } });
test("native login exposes only complete official links and accepts a single bounded code", () => {
  assert.equal(claudeLoginPrompt("https://claude.ai/oauth/authorize?state=fixture"), null);
  assert.equal(claudeLoginPrompt("Visit https://claude.ai/oauth/authorize?state=fixture\n"), "https://claude.ai/oauth/authorize?state=fixture");
  for (const url of ["https://claude.ai.evil.test/", "https://x.claude.ai/", "http://claude.ai/", "https://u:p@claude.ai/", "https://claude.ai:444/", "https://claude.ai/"]) assert.equal(claudeLoginPrompt(`${url}\n`), null);
  assert.equal(claudeLoginCode(" fixture-code#state "), "fixture-code#state");
  for (const code of ["tiny", "a\nb", "a".repeat(1025), "token=secret"]) assert.throws(() => claudeLoginCode(code));
});
test("inference disables local tools and customizations while retaining native subscription auth", () => {
  const command = claudeInferenceCommand(input());
  assert.equal(command[0], "/usr/bin/setpriv");
  assert.equal(command[command.indexOf("--tools") + 1], "");
  assert.equal(command[command.indexOf("--disallowedTools") + 1], "mcp__*");
  assert.equal(command[command.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.equal(command[command.indexOf("--setting-sources") + 1], "");
  assert.ok(command.includes("--safe-mode") && command.includes("--restricted"));
  assert.ok(!command.includes("--bare") && !command.includes("--dangerously-skip-permissions"));
  assert.ok(!command.includes(input().prompt));
});
test("bounds prompt, schema, deadline and argument injection before any native dispatch", () => {
  validateClaudeInput(input());
  for (const patch of [{ model: "--dangerously-skip-permissions" }, { prompt: "x".repeat(192_001) }, { instructions: "x".repeat(32_001) }, { schema: { $ref: "https://evil.test/schema" } }, { deadlineAt: Date.now() - 1 }, { connectionVersion: 0 }]) assert.throws(() => validateClaudeInput({ ...input(), ...patch }));
});
test("CLI success requires a structured result and known usage; raw diagnostics are discarded", () => {
  const reply = { type: "result", subtype: "success", is_error: false, structured_output: { kind: "done" }, usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 }, secret: "never-return-this" };
  assert.deepEqual(parseClaudeResult(JSON.stringify(reply), 0), { structuredOutput: { kind: "done" }, tokens: 24, cliVersion: CLAUDE_CLI_VERSION });
  for (const patch of [{ is_error: true }, { usage: {} }, { subtype: "error_max_turns" }, { structured_output: undefined }, { usage: { input_tokens: -1, output_tokens: 2 } }]) assert.throws(() => parseClaudeResult(JSON.stringify({ ...reply, ...patch }), 0), /^Error: claude_invalid_result$/);
  assert.throws(() => parseClaudeResult(JSON.stringify(reply), 1));
  assert.deepEqual(parseClaudeAuth('{"loggedIn":true,"email":"private@example.test","token":"secret"}', 0), { authenticated: true });
  assert.deepEqual(parseClaudeAuth('{"loggedIn":true}', 1), { authenticated: false });
  assert.deepEqual(parseClaudeAuth('{"loggedIn":true,"authMethod":"api_key","email":"private@example.test"}', 0), { authenticated: true, authMethod: "api_key" });
});
