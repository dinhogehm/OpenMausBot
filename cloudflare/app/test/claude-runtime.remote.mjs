import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.equal(process.env.VELTRAM_REMOTE_PROOF, "1", "Explicit isolated remote proof authorization is required");
const app = resolve(import.meta.dirname, "..");
const name = "veltram-claude-proof-" + randomBytes(6).toString("hex");
const token = randomBytes(32).toString("hex"), tokenHash = createHash("sha256").update(token).digest("hex");
const directory = await mkdtemp(join(tmpdir(), name + "-")), configPath = join(directory, "wrangler.jsonc");
const evidencePath = resolve(app, "../../docs/verification/evidence", name + ".json");
const receipt = { name, startedAt: new Date().toISOString(), accountId: "768841fa976bce74242ce11c4e98bc9d", expiresAt: new Date(Date.now() + 20 * 60000).toISOString(), productionTouched: false, sourceHashes: {}, checks: {}, cleanup: {}, logs: {} };
const redact = value => String(value).replaceAll(token, "[REDACTED]").replaceAll(tokenHash, "[TOKEN_HASH_REDACTED]");
for (const file of ["Dockerfile.claude", "src/claude-runtime.ts", "src/claude-program.ts", "src/claude-types.ts", "test/fixtures/claude-remote-worker.ts", "test/claude-runtime.remote.mjs"]) receipt.sourceHashes[file] = createHash("sha256").update(await readFile(join(app, file))).digest("hex");
await writeFile(configPath, JSON.stringify({ name, account_id: receipt.accountId, main: join(app, "test/fixtures/claude-remote-worker.ts"), compatibility_date: "2026-10-14", compatibility_flags: ["nodejs_compat"], workers_dev: true, preview_urls: false, observability: { enabled: false }, durable_objects: { bindings: [{ name: "PROOF", class_name: "ClaudeSnapshotProof" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["ClaudeSnapshotProof"] }], containers: [{ class_name: "ClaudeSnapshotProof", scheduling_policy: "durable_object", images: { claude: { dockerfile: join(app, "Dockerfile.claude"), build_context: app } } }], vars: { FIXTURE_TOKEN_HASH: tokenHash, FIXTURE_EXPIRES_AT: String(Date.parse(receipt.expiresAt)), FIXTURE_RUN_ID: name } }, null, 2), { mode: 0o600 });
function wrangler(...args) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(process.execPath, [join(app, "node_modules/wrangler/bin/wrangler.js"), ...args, "--config", configPath], { cwd: app, env: { ...process.env, CI: "true" }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", timedOut = false, forced;
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; }); child.stdin.end("y\n");
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); forced = setTimeout(() => child.kill("SIGKILL"), 5000); }, 600_000);
    child.on("error", error => { clearTimeout(timer); clearTimeout(forced); reject(error); });
    child.on("close", code => { clearTimeout(timer); clearTimeout(forced); resolveCommand({ code: timedOut ? 124 : code, output: redact(output) }); });
  });
}
const inventory = output => { const start = output.search(/^\[\s*(?:\n|\])/m); assert.ok(start >= 0, "Missing JSON inventory"); const list = JSON.parse(output.slice(start, output.lastIndexOf("]") + 1)); assert.ok(Array.isArray(list)); return list; };
let origin, failure;
try {
  console.log(JSON.stringify({ phase: "deploying", name }));
  const deployed = await wrangler("deploy"); receipt.logs.deploy = deployed.output; assert.equal(deployed.code, 0, deployed.output);
  origin = deployed.output.match(new RegExp("https://" + name + "\\.[a-z0-9-]+\\.workers\\.dev"))?.[0]; assert.ok(origin, "Exact fixture URL missing"); receipt.origin = origin;
  const until = Date.now() + 90_000;
  do {
    receipt.checks.unauthorized = (await fetch(origin + "/prove", { method: "POST", signal: AbortSignal.timeout(15000) })).status;
    if (receipt.checks.unauthorized === 403) break;
    await new Promise(resolveRetry => setTimeout(resolveRetry, 2000));
  } while (Date.now() < until);
  assert.equal(receipt.checks.unauthorized, 403);
  receipt.checks.wrongToken = (await fetch(origin + "/prove", { method: "POST", headers: { authorization: "Bearer " + "0".repeat(64) }, signal: AbortSignal.timeout(15000) })).status; assert.equal(receipt.checks.wrongToken, 403);
  console.log(JSON.stringify({ phase: "native_snapshot_acceptance", name }));
  const response = await fetch(origin + "/prove", { method: "POST", headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(115000) });
  receipt.checks.httpStatus = response.status; const body = await response.text();
  try { receipt.checks.runtime = JSON.parse(body); } catch { receipt.checks.responseText = body.slice(0, 4000); }
  assert.equal(response.status, 200, JSON.stringify(receipt.checks));
} catch (error) { failure = error; receipt.failure = redact(error.message); }
finally {
  const errors = []; receipt.cleanup.errors = errors;
  const clean = async (stage, action) => { try { await action(); } catch (error) { errors.push({ stage, error: redact(error.message) }); } };
  try {
    console.log(JSON.stringify({ phase: "cleanup", name }));
    await clean("worker", async () => { const result = await wrangler("delete", name, "--force"); receipt.logs.delete = result.output; receipt.cleanup.workerDeleteExit = result.code; assert.equal(result.code, 0); });
    await clean("containers", async () => {
      const first = await wrangler("containers", "list", "--json"); assert.equal(first.code, 0);
      for (const item of inventory(first.output).filter(item => item.name === name + "-claudesnapshotproof")) { const result = await wrangler("containers", "delete", item.id); receipt.logs.deleteContainer = result.output; assert.equal(result.code, 0); }
      const last = await wrangler("containers", "list", "--json"); assert.equal(last.code, 0); receipt.cleanup.remainingContainers = inventory(last.output).filter(item => item.name.startsWith(name)); assert.equal(receipt.cleanup.remainingContainers.length, 0);
    });
    await clean("images", async () => {
      const first = await wrangler("containers", "images", "list", "--json", "--filter", "(^|/)" + name); assert.equal(first.code, 0); receipt.images = inventory(first.output).filter(item => item.name.startsWith(name)); receipt.cleanup.images = [];
      for (const item of receipt.images) for (const tag of item.tags) { const result = await wrangler("containers", "images", "delete", item.name + ":" + tag, "--skip-confirmation"); receipt.cleanup.images.push({ image: item.name + ":" + tag, exit: result.code }); if (result.code !== 0) errors.push({ stage: "image_delete", error: "Deletion not confirmed" }); }
      const last = await wrangler("containers", "images", "list", "--json", "--filter", "(^|/)" + name); assert.equal(last.code, 0); receipt.cleanup.remainingImages = inventory(last.output).filter(item => item.name.startsWith(name)); assert.equal(receipt.cleanup.remainingImages.length, 0);
    });
    await clean("endpoint", async () => {
      if (!origin) return;
      const until = Date.now() + 45_000;
      do { receipt.cleanup.finalHttpStatus = (await fetch(origin + "/prove", { signal: AbortSignal.timeout(15000), cache: "no-store" }).catch(() => null))?.status ?? "unreachable"; if ([404, "unreachable"].includes(receipt.cleanup.finalHttpStatus)) break; await new Promise(resolveRetry => setTimeout(resolveRetry, 2000)); } while (Date.now() < until);
      assert.ok([404, "unreachable"].includes(receipt.cleanup.finalHttpStatus));
    });
  } finally {
    await clean("local_config", () => rm(directory, { recursive: true, force: true }));
    receipt.finishedAt = new Date().toISOString(); await mkdir(resolve(evidencePath, ".."), { recursive: true }); await writeFile(evidencePath, JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ phase: "finished", evidencePath, checks: receipt.checks, cleanup: receipt.cleanup, failure: receipt.failure?.slice(0, 1000) }));
  }
}
if (failure || receipt.cleanup.workerDeleteExit !== 0 || receipt.cleanup.errors.length || !Array.isArray(receipt.cleanup.remainingContainers) || receipt.cleanup.remainingContainers.length || !Array.isArray(receipt.cleanup.remainingImages) || receipt.cleanup.remainingImages.length) process.exitCode = 1;
