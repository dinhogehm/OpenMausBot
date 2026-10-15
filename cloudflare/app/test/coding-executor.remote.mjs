import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Operator-invoked remote acceptance. The secret exists only in this process;
// Cloudflare receives its SHA256 verifier. No app/GitHub/model credentials bind.
assert.equal(process.env.VELTRAM_REMOTE_PROOF, "1", "Explicit remote proof authorization is required");
const app = resolve(import.meta.dirname, "..");
const startedAt = new Date().toISOString();
const name = "veltram-coding-proof-" + randomBytes(6).toString("hex");
const token = randomBytes(32).toString("hex");
const runId = randomBytes(16).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const directory = await mkdtemp(join(tmpdir(), name + "-"));
const configPath = join(directory, "wrangler.jsonc");
const evidencePath = resolve(app, "../../docs/verification/evidence", name + ".json");
const receipt = { name, startedAt, accountId: "768841fa976bce74242ce11c4e98bc9d", expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), productionTouched: false, sourceHashes: {}, checks: {}, cleanup: {}, logs: {} };
for (const file of ["Dockerfile.coding", "src/coding-executor.ts", "src/coding-program.ts", "src/coding-network.ts", "test/coding-executor.native.test.ts", "test/fixtures/coding-remote-worker.ts"]) receipt.sourceHashes[file] = createHash("sha256").update(await readFile(join(app, file))).digest("hex");
await writeFile(configPath, JSON.stringify({ name, account_id: receipt.accountId, main: join(app, "test/fixtures/coding-remote-worker.ts"), compatibility_date: "2026-10-14", workers_dev: true, preview_urls: false, observability: { enabled: false }, durable_objects: { bindings: [{ name: "CODING_EXECUTORS", class_name: "CodingExecutor" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["CodingExecutor"] }], containers: [{ class_name: "CodingExecutor", scheduling_policy: "durable_object", images: { coding: { dockerfile: join(app, "Dockerfile.coding"), build_context: app } } }], vars: { FIXTURE_TOKEN_HASH: tokenHash, FIXTURE_EXPIRES_AT: String(Date.parse(receipt.expiresAt)), FIXTURE_RUN_ID: runId } }, null, 2));
function command(args, timeout = 240_000, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: app, env: { ...process.env, CI: "true", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.stdin.end("y\n");
    let timedOut = false; let forced;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); forced = setTimeout(() => child.kill("SIGKILL"), 10_000); }, timeout);
    child.on("error", error => { clearTimeout(timer); clearTimeout(forced); reject(error); });
    child.on("close", code => { clearTimeout(timer); clearTimeout(forced); resolvePromise({ code: timedOut ? 124 : code, output: output.replaceAll(token, "[REDACTED]").replaceAll(tokenHash, "[TOKEN_HASH_REDACTED]") }); });
  });
}
const wrangler = (...args) => command([process.execPath, join(app, "node_modules/wrangler/bin/wrangler.js"), ...args, "--config", configPath], 600_000);
const parseArray = output => { const start = output.search(/^\[\s*(?:\n|\])/m); assert.ok(start >= 0, "Missing JSON inventory"); const result = JSON.parse(output.slice(start, output.lastIndexOf("]") + 1)); assert.ok(Array.isArray(result), "Invalid JSON inventory"); return result; };
let origin;
let proxy;
let failure;
try {
  console.log(JSON.stringify({ phase: "deploying", name, expiresAt: receipt.expiresAt }));
  const deployed = await wrangler("deploy"); receipt.logs.deploy = deployed.output;
  assert.equal(deployed.code, 0, deployed.output);
  origin = deployed.output.match(new RegExp("https://" + name + "\\.[a-z0-9-]+\\.workers\\.dev"))?.[0];
  assert.ok(origin, "No exact fixture URL in deploy receipt"); receipt.origin = origin;
  receipt.checks.unauthorized = (await fetch(origin + "/init", { method: "POST" })).status;
  receipt.checks.wrongToken = (await fetch(origin + "/init", { method: "POST", headers: { authorization: "Bearer " + "0".repeat(64) } })).status;
  assert.equal(receipt.checks.unauthorized, 403); assert.equal(receipt.checks.wrongToken, 403);
  receipt.checks.wrongScope = (await fetch(origin + "/init", { method: "POST", headers: { authorization: "Bearer " + token, "x-fixture-input": JSON.stringify({ organizationId: "other", workspaceId: "native_fixture", runId, generation: 1, deadlineAt: Date.now() + 180_000 }) } })).status;
  assert.equal(receipt.checks.wrongScope, 403);
  proxy = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.headers.origin || !["/init", "/step", "/snapshot", "/diff", "/stop"].includes(request.url)) { response.writeHead(403).end(); return; }
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 2 * 1024 * 1024) throw new Error("proxy_limit"); chunks.push(chunk); }
      let body = Buffer.concat(chunks);
      const headers = { authorization: "Bearer " + token };
      if (request.url === "/init") {
        const input = JSON.parse(request.headers["x-fixture-input"]); input.runId = runId; headers["x-fixture-input"] = JSON.stringify(input);
      } else {
        assert.match(request.headers["content-type"] ?? "", /^application\/json/);
        const input = JSON.parse(body.toString()); input.runId = runId; body = Buffer.from(JSON.stringify(input)); headers["content-type"] = "application/json";
      }
      const upstream = await fetch(origin + request.url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(150_000) });
      response.writeHead(upstream.status, { "content-type": "application/json" }); response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) { response.writeHead(502).end(JSON.stringify({ error: error.message.replaceAll(token, "[REDACTED]") })); }
  });
  await new Promise(resolveListen => proxy.listen(0, "127.0.0.1", resolveListen));
  console.log(JSON.stringify({ phase: "native_acceptance", name }));
  const accepted = await command([process.execPath, "--experimental-strip-types", "--test", "test/coding-executor.native.test.ts"], 210_000, { VELTRAM_NATIVE_URL: "http://127.0.0.1:" + proxy.address().port });
  receipt.logs.acceptance = accepted.output; receipt.checks.nativeAcceptanceExit = accepted.code;
  assert.equal(accepted.code, 0, accepted.output);
} catch (error) { failure = error; receipt.failure = error.message.replaceAll(token, "[REDACTED]"); }
finally {
  const cleanupErrors = [];
  receipt.cleanup.errors = cleanupErrors;
  async function clean(label, operation) {
    try { await operation(); } catch (error) { cleanupErrors.push({ stage: label, error: error.message.replaceAll(token, "[REDACTED]").replaceAll(tokenHash, "[TOKEN_HASH_REDACTED]") }); }
  }
  try {
    await clean("proxy", async () => { if (proxy) { proxy.closeAllConnections(); await new Promise(resolveClose => proxy.close(resolveClose)); } });
    console.log(JSON.stringify({ phase: "cleanup", name }));
    await clean("worker", async () => {
      const removed = await wrangler("delete", name, "--force"); receipt.logs.deleteWorker = removed.output; receipt.cleanup.workerDeleteExit = removed.code;
      assert.equal(removed.code, 0, "Worker deletion was not confirmed");
    });
    await clean("containers", async () => {
      const applications = await wrangler("containers", "list", "--json");
      assert.equal(applications.code, 0, "Container inventory unavailable");
      for (const application of parseArray(applications.output).filter(item => item.name === name + "-codingexecutor")) {
        const result = await wrangler("containers", "delete", application.id); receipt.logs.deleteContainer = result.output; receipt.cleanup.containerDeleteExit = result.code;
        assert.equal(result.code, 0, "Container deletion was not confirmed");
      }
      const remaining = await wrangler("containers", "list", "--json");
      assert.equal(remaining.code, 0, "Final container inventory unavailable");
      receipt.cleanup.remainingContainers = parseArray(remaining.output).filter(item => item.name.startsWith(name));
      assert.equal(receipt.cleanup.remainingContainers.length, 0, "Fixture container remains");
    });
    await clean("images", async () => {
      const images = await wrangler("containers", "images", "list", "--json", "--filter", "(^|/)" + name);
      assert.equal(images.code, 0, "Image inventory unavailable");
      receipt.images = parseArray(images.output).filter(item => item.name.startsWith(name));
      receipt.cleanup.images = [];
      for (const image of receipt.images) for (const tag of image.tags) {
        const result = await wrangler("containers", "images", "delete", image.name + ":" + tag, "--skip-confirmation");
        receipt.cleanup.images.push({ image: image.name + ":" + tag, exit: result.code });
        if (result.code !== 0) cleanupErrors.push({ stage: "image_delete", image: image.name + ":" + tag, error: "Image deletion was not confirmed" });
      }
      const remaining = await wrangler("containers", "images", "list", "--json", "--filter", "(^|/)" + name);
      assert.equal(remaining.code, 0, "Final image inventory unavailable");
      receipt.cleanup.remainingImages = parseArray(remaining.output).filter(item => item.name.startsWith(name));
      assert.equal(receipt.cleanup.remainingImages.length, 0, "Fixture image remains");
    });
    await clean("endpoint", async () => { if (origin) receipt.cleanup.finalHttpStatus = (await fetch(origin, { signal: AbortSignal.timeout(15_000) }).catch(() => null))?.status ?? "unreachable"; });
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await clean("local_config", () => rm(directory, { recursive: true, force: true }));
    await mkdir(resolve(evidencePath, ".."), { recursive: true }); await writeFile(evidencePath, JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ phase: "finished", name, evidencePath, checks: receipt.checks, cleanup: receipt.cleanup, failure: receipt.failure?.slice(0, 1000) }));
  }
}
if (failure || receipt.cleanup.workerDeleteExit !== 0 || receipt.cleanup.errors?.length || !Array.isArray(receipt.cleanup.remainingContainers) || receipt.cleanup.remainingContainers.length || !Array.isArray(receipt.cleanup.remainingImages) || receipt.cleanup.remainingImages.length) process.exitCode = 1;
