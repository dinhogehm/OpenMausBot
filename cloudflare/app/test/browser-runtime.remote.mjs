import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.equal(process.env.VELTRAM_REMOTE_PROOF, "1", "Explicit remote proof authorization required");
const app = resolve(import.meta.dirname, "..");
const name = "veltram-browser-proof-" + randomBytes(6).toString("hex");
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const directory = await mkdtemp(join(tmpdir(), name + "-"));
const configPath = join(directory, "wrangler.jsonc");
const evidencePath = resolve(app, "../../docs/verification/evidence", name + ".json");
const receipt = { name, startedAt: new Date().toISOString(), accountId: "768841fa976bce74242ce11c4e98bc9d", expiresAt: new Date(Date.now() + 20 * 60000).toISOString(), productionTouched: false, sourceHashes: {}, checks: {}, cleanup: {}, logs: {} };
for (const file of ["src/browser-runtime.ts", "src/browser-network.ts", "src/browser-state.ts", "src/browser-types.ts", "test/fixtures/browser-remote-worker.ts"]) receipt.sourceHashes[file] = createHash("sha256").update(await readFile(join(app, file))).digest("hex");
await writeFile(configPath, JSON.stringify({ name, account_id: receipt.accountId, main: join(app, "test/fixtures/browser-remote-worker.ts"), compatibility_date: "2026-10-14", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"], browser: { binding: "BROWSER" }, workers_dev: true, preview_urls: false, observability: { enabled: false }, vars: { FIXTURE_TOKEN_HASH: tokenHash, FIXTURE_EXPIRES_AT: String(Date.parse(receipt.expiresAt)) } }, null, 2), { mode: 0o600 });
function wrangler(...args) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(process.execPath, [join(app, "node_modules/wrangler/bin/wrangler.js"), ...args, "--config", configPath], { cwd: app, env: { ...process.env, CI: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject); child.on("close", code => resolveCommand({ code, output: output.replaceAll(token, "[REDACTED]").replaceAll(tokenHash, "[TOKEN_HASH_REDACTED]").replace(/^.*FIXTURE_TOKEN_HASH.*$/gm, "[fixture verifier binding omitted]") }));
  });
}
let origin; let failure;
try {
  console.log(JSON.stringify({ phase: "deploying", name }));
  const deployed = await wrangler("deploy"); receipt.logs.deploy = deployed.output; assert.equal(deployed.code, 0, deployed.output);
  origin = deployed.output.match(new RegExp("https://" + name + "\\.[a-z0-9-]+\\.workers\\.dev"))?.[0]; assert.ok(origin, "No fixture URL"); receipt.origin = origin;
  const until = Date.now() + 90000;
  do {
    receipt.checks.unauthorized = (await fetch(origin + "/prove", { method: "POST", signal: AbortSignal.timeout(15000) })).status;
    receipt.checks.wrongToken = (await fetch(origin + "/prove", { method: "POST", headers: { authorization: "Bearer " + "0".repeat(64) }, signal: AbortSignal.timeout(15000) })).status;
    if (receipt.checks.unauthorized === 403 && receipt.checks.wrongToken === 403) break;
    assert.ok([403, 404, 500, 502, 503, 504].includes(receipt.checks.unauthorized) && [403, 404, 500, 502, 503, 504].includes(receipt.checks.wrongToken), "Unexpected authentication probe response");
    await new Promise(resolveRetry => setTimeout(resolveRetry, 2000));
  } while (Date.now() < until);
  assert.equal(receipt.checks.unauthorized, 403);
  assert.equal(receipt.checks.wrongToken, 403);
  console.log(JSON.stringify({ phase: "native_browser_acceptance", name }));
  const response = await fetch(origin + "/prove", { method: "POST", headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(110000) });
  receipt.checks.httpStatus = response.status;
  const responseBody = await response.text();
  try { receipt.checks.runtime = JSON.parse(responseBody); } catch { receipt.checks.responseText = responseBody.slice(0, 4000); }
  assert.equal(response.status, 200, JSON.stringify(receipt.checks.runtime));
} catch (error) { failure = error; receipt.failure = error.message.replaceAll(token, "[REDACTED]"); }
finally {
  console.log(JSON.stringify({ phase: "cleanup", name }));
  try {
    const deleted = await wrangler("delete", name, "--force"); receipt.logs.delete = deleted.output; receipt.cleanup.workerDeleteExit = deleted.code;
    if (origin) {
      const until = Date.now() + 45000;
      do {
        receipt.cleanup.finalHttpStatus = (await fetch(origin + "/site", { signal: AbortSignal.timeout(15000), cache: "no-store" }).catch(() => null))?.status ?? "unreachable";
        if (receipt.cleanup.finalHttpStatus === 404 || receipt.cleanup.finalHttpStatus === "unreachable") break;
        await new Promise(resolveRetry => setTimeout(resolveRetry, 2000));
      } while (Date.now() < until);
    }
  } catch (error) { receipt.cleanup.error = error.message.replaceAll(token, "[REDACTED]"); }
  await rm(directory, { recursive: true, force: true });
  receipt.finishedAt = new Date().toISOString(); await mkdir(resolve(evidencePath, ".."), { recursive: true }); await writeFile(evidencePath, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ phase: "finished", evidencePath, checks: receipt.checks, cleanup: receipt.cleanup, failure: receipt.failure }));
}
if (failure || receipt.cleanup.workerDeleteExit !== 0 || receipt.cleanup.error || ![404, "unreachable"].includes(receipt.cleanup.finalHttpStatus)) process.exitCode = 1;
