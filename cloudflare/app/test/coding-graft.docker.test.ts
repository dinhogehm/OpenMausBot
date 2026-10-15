import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_INIT_PROGRAM, CODING_TOOL_PROGRAM, CODING_PYTHON, CODING_UNTRUSTED_PREFIX } from "../src/coding-program.ts";

test("pinned Linux Graft executes offline under a separate UID, refreshes writes/commands and keeps the index out of the PR", { skip: process.env.VELTRAM_GRAFT_DOCKER_TEST !== "1", timeout: 180_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "veltram-graft-docker-"));
  const name = `veltram-graft-fixture-${crypto.randomUUID()}`;
  const repo = join(directory, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/math.ts"), "export function sum(a: number, b: number) { return a + b; }\nexport function total() { return sum(1, 2); }\n");
  writeFileSync(join(repo, ".env"), "NODE_OPTIONS=--require=/workspace/repo/poison.js\nOPENAI_API_KEY=fixture-do-not-load\n");
  writeFileSync(join(repo, "poison.js"), "throw new Error('repository environment loaded');\n");
  mkdirSync(join(repo, ".graft"));
  writeFileSync(join(repo, ".graft/config.json"), '{"includeDirs":["node_modules"],"followNestedRepos":true}');
  const archive = spawnSync("tar", ["czf", "-", "-C", directory, "repo"], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).stdout;
  const identity = { organizationId: "org_fixture", workspaceId: "ws_fixture", runId: "run_fixture", generation: 1, baseSha: "a".repeat(40) };
  function execute(program: string, input: Buffer | string, args: string[] = [], untrusted = false) {
    const result = spawnSync("docker", ["exec", "-i", name, ...(untrusted ? CODING_UNTRUSTED_PREFIX : []), CODING_PYTHON, "-I", "-c", program, ...args], { input, timeout: 70_000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr.toString() || result.stdout.toString());
    return result.stdout.toString();
  }
  let baseline = "";
  const tool = (value: { kind: string; [key: string]: unknown }) => execute(CODING_TOOL_PROGRAM, JSON.stringify({ ...value, baseline, identity }), [], !value.kind.startsWith("graft_") && value.kind !== "snapshot");
  try {
    const start = spawnSync("docker", ["run", "-d", "--rm", "--network", "none", "--name", name, "veltram-coding-graft-fixture:20261014"], { timeout: 30_000 });
    assert.equal(start.status, 0, start.stderr.toString());
    baseline = JSON.parse(execute(CODING_INIT_PROGRAM, archive, [identity.baseSha])).baseline;
    const before = JSON.parse(tool({ kind: "snapshot" }));
    const map = JSON.parse(tool({ kind: "graft_map" }));
    assert.equal(map.available, true, JSON.stringify(map));
    assert.equal(map.version, "0.22.0");
    const callers = JSON.parse(tool({ kind: "graft_callers", symbol: "sum", path: "src", direction: "in", depth: 1 }));
    assert.ok(callers.result.edges.some((edge: { node?: { name: string } }) => edge.node?.name === "total"));
    assert.deepEqual(JSON.parse(tool({ kind: "snapshot" })), before);
    tool({ kind: "run_command", cwd: ".", timeoutMs: 1000, command: "test ! -r /workspace/.veltram-graft && test ! -w /opt/veltram-graft/query.mjs && ln -s /etc/passwd src/outside.ts" });
    const link = JSON.parse(tool({ kind: "graft_map" }));
    assert.equal(link.coverage.excluded.symlink, 1);
    tool({ kind: "run_command", cwd: ".", timeoutMs: 1000, command: "rm src/outside.ts" });
    tool({ kind: "write_file", path: "src/math.ts", content: "export function add(a: number, b: number) { return a + b; }\n" });
    const changed = JSON.parse(tool({ kind: "graft_skeleton", path: "src/math.ts" }));
    assert.notEqual(changed.revision, map.revision);
    assert.deepEqual(changed.result.entries.map((entry: { name: string }) => entry.name), ["add"]);
    tool({ kind: "run_command", cwd: ".", timeoutMs: 1000, command: "sed -i s/add/mul/g src/math.ts" });
    const command = JSON.parse(tool({ kind: "graft_skeleton", path: "src/math.ts" }));
    assert.notEqual(command.revision, changed.revision);
    assert.deepEqual(command.result.entries.map((entry: { name: string }) => entry.name), ["mul"]);
    const final = JSON.parse(tool({ kind: "snapshot" }));
    assert.deepEqual(final.files.map((file: { path: string }) => file.path), ["src/math.ts"]);
    const protection = execute("import os,pathlib,json\np=pathlib.Path('/workspace/.veltram-graft')\nprint(json.dumps({'uid':p.stat().st_uid,'mode':oct(p.stat().st_mode&0o777),'network':pathlib.Path('/proc/net/route').read_text()}))", "");
    assert.equal(JSON.parse(protection).uid, 1001);
    assert.equal(JSON.parse(protection).mode, "0o700");
    assert.equal(JSON.parse(protection).network.trim().split("\n").length, 1);
  } finally {
    spawnSync("docker", ["rm", "-f", name], { timeout: 15_000 });
    rmSync(directory, { recursive: true, force: true });
  }
});
