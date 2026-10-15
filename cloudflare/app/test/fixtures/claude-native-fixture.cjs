// Runs only in a disposable --network=none Docker container. No account or paid model.
const { createServer } = require("node:http");
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync, existsSync } = require("node:fs");
const spec = JSON.parse(process.argv[2]);
if (spec.managedPolicy) {
  mkdirSync("/etc/claude-code", { recursive: true });
  writeFileSync("/etc/claude-code/managed-settings.json", JSON.stringify({ ...(spec.managedPolicy === "explicit_false" ? { disableAllHooks: false } : {}), hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/unsafe-hook-ran" }] }] } }));
}
mkdirSync("/opt/veltram/request/.claude", { recursive: true });
writeFileSync("/opt/veltram/request/.claude/settings.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/unsafe-hook-ran" }] }] } }));
writeFileSync("/opt/veltram/request/.mcp.json", JSON.stringify({ mcpServers: { unsafe: { command: "/bin/sh", args: ["-c", "touch /tmp/unsafe-mcp-ran"] } } }));
const requests = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
  req.on("end", () => {
    let parsed; try { parsed = JSON.parse(body); } catch { parsed = {}; }
    requests.push({ path: req.url, tools: (parsed.tools ?? []).map(tool => tool.name), outputConfig: parsed.output_config, stream: parsed.stream });
    if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":10}'); return; }
    if (!req.url.startsWith("/v1/messages")) { res.writeHead(404); res.end(); return; }
    const structured = (parsed.tools ?? []).find(tool => /structured|response|output/i.test(tool.name));
    const content = spec.mode === "forbidden_tool"
      ? { type: "tool_use", id: "forbidden_tool", name: "Bash", input: { command: "touch /tmp/unsafe-native-tool-ran" } }
      : structured ? { type: "tool_use", id: "tool_fixture", name: structured.name, input: { kind: "done" } } : { type: "text", text: '{"kind":"done"}' };
    const message = { id: `msg_fixture_${requests.length}`, type: "message", role: "assistant", model: parsed.model, content: [content], stop_reason: structured ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
    if (!parsed.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    emit("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    emit("content_block_start", { index: 0, content_block: structured ? { ...content, input: {} } : { type: "text", text: "" } });
    emit("content_block_delta", { index: 0, delta: structured ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) } : { type: "text_delta", text: '{"kind":"done"}' } });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
    emit("message_stop", {}); res.end();
  });
});
server.listen(0, "127.0.0.1", () => {
  const cli = spawn(spec.argv[0], spec.argv.slice(1), { cwd: "/opt/veltram/request", env: { ...spec.env, ANTHROPIC_API_KEY: "fixture-only-not-a-real-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  cli.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 300_000) cli.kill("SIGKILL"); });
  cli.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 32_768) cli.kill("SIGKILL"); });
  cli.stdin.end(spec.prompt);
  const timeout = setTimeout(() => cli.kill("SIGKILL"), 45_000);
  cli.once("close", (exitCode, signal) => {
    clearTimeout(timeout); server.close();
    const result = { exitCode, signal, requests, stdout, stderr, hookRan: existsSync("/tmp/unsafe-hook-ran"), mcpRan: existsSync("/tmp/unsafe-mcp-ran"), forbiddenToolRan: existsSync("/tmp/unsafe-native-tool-ran") };
    console.log(JSON.stringify(result)); process.exitCode = exitCode === 0 && !result.hookRan && !result.mcpRan ? 0 : 1;
  });
});
