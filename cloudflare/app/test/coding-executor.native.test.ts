import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codingTreeDigest } from "../src/coding-types.ts";
import type { CodingTool, CodingToolResult, CodingSnapshot } from "../src/coding-types.ts";

test("native container API supports checkout, edit/test, bounded egress, diff, snapshot and cancellation", { skip: !process.env.VELTRAM_NATIVE_URL, timeout: 180_000 }, async () => {
  const origin = process.env.VELTRAM_NATIVE_URL!;
  assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin));
  const directory = mkdtempSync(join(tmpdir(), "veltram-native-source-"));
  const repo = join(directory, "repo"); mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e 'if(require(\"./sum\")(2,3)!==5)process.exit(1)'" } }));
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.venv/\n");
  writeFileSync(join(repo, "sum.js"), "module.exports=(a,b)=>a-b;\n");
  const archive = spawnSync("tar", ["czf", "-", "-C", directory, "repo"], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).stdout;
  const identity = { organizationId: "native_fixture", workspaceId: "native_fixture", runId: crypto.randomUUID(), generation: 1, deadlineAt: Date.now() + 180_000 };
  let step = 0;
  async function request(path: string, payload: object = {}) {
    return fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...identity, ...payload }) });
  }
  async function tool(value: CodingTool) {
    const response = await request("/step", { stepId: `s${++step}`, tool: value });
    const result = await response.json() as CodingToolResult;
    assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  try {
    const init = await fetch(origin + "/init", { method: "POST", headers: { "x-fixture-input": JSON.stringify({ ...identity, baseSha: "a".repeat(40) }) }, body: archive });
    assert.equal(init.status, 200, await init.text());
    const protectedRuntime = await tool({ kind: "run_command", cwd: ".", timeoutMs: 20_000, command: "/usr/bin/python3 -I -c 'import os,pathlib\nassert os.getuid()==os.geteuid()==1000\nassert os.getgid()==os.getegid()==1000\ns=dict(line.split('\"'\"':'\"'\"',1) for line in pathlib.Path('\"'\"'/proc/self/status'\"'\"').read_text().splitlines() if '\"'\"':'\"'\"' in line)\nfor k in ['\"'\"'CapInh'\"'\"','\"'\"'CapPrm'\"'\"','\"'\"'CapEff'\"'\"','\"'\"'CapBnd'\"'\"','\"'\"'CapAmb'\"'\"']: assert int(s[k].strip(),16)==0,(k,s[k])\nassert s['\"'\"'NoNewPrivs'\"'\"'].strip()=='\"'\"'1'\"'\"'\nfor p in ['\"'\"'/usr/local/bin/python3'\"'\"','\"'\"'/usr/bin/python3'\"'\"','\"'\"'/usr/bin/git'\"'\"','\"'\"'/usr/lib/python3.13/json/__init__.py'\"'\"','\"'\"'/workspace/repo/.git/config'\"'\"','\"'\"'/workspace/.veltram/baseline.json'\"'\"']:\n try:\n  with open(p,'\"'\"'wb'\"'\"') as f: f.write(b'\"'\"'forged'\"'\"')\n except PermissionError: pass\n else: raise Exception('\"'\"'trusted path writable: '\"'\"'+p)\nfor a,b in [('\"'\"'/workspace/repo/.git'\"'\"','\"'\"'/workspace/repo/stolen-git'\"'\"'),('\"'\"'/workspace/repo'\"'\"','\"'\"'/workspace/stolen-repo'\"'\"')]:\n try: os.rename(a,b)\n except PermissionError: pass\n else: raise Exception('\"'\"'trusted path replaceable: '\"'\"'+a)\ntry: os.setuid(0)\nexcept PermissionError: pass\nelse: raise Exception('\"'\"'root regained'\"'\"')\nprint('\"'\"'uid1000; capabilities zero; no_new_privs; trusted files protected'\"'\"')'" });
    assert.equal(protectedRuntime.exitCode, 0, protectedRuntime.output);
    const spoof = await tool({ kind: "write_file", path: "json.py", content: "raise Exception(\"repository import injected\")\n" });
    assert.equal(spoof.exitCode, 0);
    const isolatedRead = await tool({ kind: "list_files", path: "." });
    assert.equal(isolatedRead.exitCode, 0);
    await tool({ kind: "write_file", path: "json.py", content: null });
    const failed = await tool({ kind: "run_command", command: "npm test", cwd: ".", timeoutMs: 20_000 });
    assert.equal(failed.exitCode, 1);
    const changed = await tool({ kind: "write_file", path: "sum.js", content: "module.exports=(a,b)=>a+b;\n" }); assert.equal(changed.exitCode, 0);
    const network = await tool({ kind: "run_command", cwd: ".", timeoutMs: 60_000, command: "node -e \"(async()=>{let r=await fetch('https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz');if(!r.ok||(await r.arrayBuffer()).byteLength<100)throw Error('allowed dependency failed');r=await fetch('https://example.com/');if(r.status!==403)throw Error('egress not blocked');console.log('dependency downloaded; unknown host denied')})().catch(e=>{console.error(e.message);process.exit(1)})\"" });
    assert.equal(network.exitCode, 0, network.output);
    const background = await tool({ kind: "run_command", cwd: ".", timeoutMs: 20_000, command: "/usr/bin/python3 -c 'import pathlib,time; p=pathlib.Path(\"/tmp/veltram-background-proof\"); [(p.write_text(str(i)),time.sleep(.005)) for i in range(10000)]' >/dev/null 2>&1 & sleep .1" });
    assert.equal(background.exitCode, 0);
    const beforeResponse = await request("/snapshot", { stepId: `s${++step}` });
    const before = await beforeResponse.json() as CodingSnapshot; assert.equal(beforeResponse.status, 200, JSON.stringify(before));
    const quiescent = await tool({ kind: "run_command", cwd: ".", timeoutMs: 20_000, command: "a=$(cat /tmp/veltram-background-proof); sleep .1; b=$(cat /tmp/veltram-background-proof); test \"$a\" = \"$b\"" });
    assert.equal(quiescent.exitCode, 0, quiescent.output);
    const passing = await tool({ kind: "run_command", command: "npm test && python3 -c 'assert 2+3==5'", cwd: ".", timeoutMs: 20_000 });
    assert.equal(passing.exitCode, 0, passing.output);
    const afterResponse = await request("/snapshot", { stepId: `s${++step}` });
    const after = await afterResponse.json() as CodingSnapshot; assert.equal(afterResponse.status, 200, JSON.stringify(after));
    assert.equal(before.treeDigest, after.treeDigest); assert.equal(after.treeDigest, await codingTreeDigest(after.files));
    const diffResponse = await request("/diff", { stepId: `s${++step}` });
    const diff = await diffResponse.json() as CodingToolResult; assert.equal(diffResponse.status, 200, JSON.stringify(diff));
    assert.match(diff.output, /a-b/); assert.match(diff.output, /a\+b/);
    const pending = request("/step", { stepId: `s${++step}`, tool: { kind: "run_command", cwd: ".", command: "sleep 30", timeoutMs: 40_000 } });
    await new Promise(resolve => setTimeout(resolve, 500));
    const stopped = await request("/stop"); assert.equal(stopped.status, 200, await stopped.text());
    const canceled = await pending; assert.equal(canceled.status, 409); assert.match(await canceled.text(), /executor_stopped/);
    const late = await request("/step", { stepId: `s${++step}`, tool: { kind: "list_files", path: "." } });
    assert.equal(late.status, 409); assert.match(await late.text(), /executor_stopped/);
  } finally {
    await request("/stop").catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});
