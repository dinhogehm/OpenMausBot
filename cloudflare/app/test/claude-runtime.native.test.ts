import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { claudeInferenceCommand, CLAUDE_ENV, parseClaudeResult } from "../src/claude-program.ts";
import { CLAUDE_CLI_VERSION } from "../src/claude-types.ts";

const enabled = process.env.VELTRAM_CLAUDE_DOCKER_PROOF === "1";
async function prove(mode: "success" | "forbidden_tool", managedPolicy?: "hooks_only" | "explicit_false", disableHooks = false) {
  const input = { organizationId: "fixture", userId: "fixture", connectionVersion: 1, runId: "run", stepId: "step", deadlineAt: Date.now() + 120000, model: "sonnet", instructions: "Use the supplied context only. Return requested JSON.", prompt: "Return kind done.", schema: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"], additionalProperties: false } };
  const argv = claudeInferenceCommand(input); if (disableHooks) argv.push("--settings", '{"disableAllHooks":true}');
  const spec = { argv, env: CLAUDE_ENV, prompt: input.prompt, mode, managedPolicy };
  const program = await readFile(new URL("./fixtures/claude-native-fixture.cjs", import.meta.url));
  return new Promise<{ exitCode: number; requests: { path: string; tools: string[] }[]; stdout: string; hookRan: boolean; mcpRan: boolean; forbiddenToolRan: boolean }>((resolve, reject) => {
    const child = spawn("docker", ["run", "--rm", "-i", "--network", "none", "--platform", "linux/amd64", "--entrypoint", "/usr/local/bin/node", `veltram-claude-fixture:${CLAUDE_CLI_VERSION}`, "-", JSON.stringify(spec)], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", diagnostics = "";
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("native_fixture_timeout")); }, 60_000);
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { diagnostics += chunk; }); child.stdin.end(program);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", () => { clearTimeout(timeout); try { resolve(JSON.parse(output)); } catch { reject(new Error(`native_fixture_invalid_output: ${diagnostics.slice(0, 1000)}`)); } });
  });
}
test("published CLI produces structured output with no paid model, project hooks or MCP", { skip: !enabled }, async () => {
  const result = await prove("success");
  assert.equal(result.exitCode, 0); assert.equal(result.requests.length, 1);
  assert.deepEqual(result.requests[0].tools, ["StructuredOutput"]);
  assert.deepEqual(parseClaudeResult(result.stdout, 0), { structuredOutput: { kind: "done" }, tokens: 15, cliVersion: CLAUDE_CLI_VERSION });
  assert.equal(result.hookRan, false); assert.equal(result.mcpRan, false); assert.equal(result.forbiddenToolRan, false);
});
test("published CLI refuses a model-generated shell tool even if upstream returns one", { skip: !enabled }, async () => {
  const result = await prove("forbidden_tool");
  assert.equal(result.hookRan, false); assert.equal(result.mcpRan, false); assert.equal(result.forbiddenToolRan, false);
  assert.ok(result.requests.every(request => !request.tools.includes("Bash")));
  assert.throws(() => parseClaudeResult(result.stdout, result.exitCode));
});
test("restricted hosted CLI cannot run a managed command hook", { skip: !enabled }, async () => {
  const result = await prove("success", "explicit_false");
  assert.equal(result.hookRan, false);
});
for (const policy of ["hooks_only", "explicit_false"] as const) test(`CLI disableAllHooks cannot be overridden by managed ${policy}`, { skip: !enabled }, async () => {
  const result = await prove("success", policy, true);
  assert.equal(result.hookRan, false);
});
