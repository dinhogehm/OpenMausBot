import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_INIT_PROGRAM, CODING_TOOL_PROGRAM, CODING_PYTHON, CODING_UNTRUSTED_PREFIX } from "../src/coding-program.ts";
import { codingTreeDigest } from "../src/coding-types.ts";

test("real Linux image edits and tests a JavaScript/Python repository without networking or credentials", { skip: process.env.VELTRAM_DOCKER_TEST !== "1" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "veltram-docker-source-"));
  const name = `veltram-coding-fixture-${crypto.randomUUID()}`;
  const repo = join(directory, "repo"); mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e 'if(require(\"./sum\")(2,3)!==5)process.exit(1)'" } }));
  writeFileSync(join(repo, "sum.js"), "module.exports=(a,b)=>a-b;\n");
  writeFileSync(join(repo, "sum.py"), "def sum(a,b): return a-b\n");
  const archive = spawnSync("tar", ["czf", "-", "-C", directory, "repo"], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).stdout;
  function exec(program: string, input: Buffer | string, args: string[] = [], untrusted = false) {
    return spawnSync("docker", ["exec", "-i", name, ...(untrusted ? CODING_UNTRUSTED_PREFIX : []), CODING_PYTHON, "-I", "-c", program, ...args], { input, timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
  }
  let baseline = "";
  const tool = (value: unknown) => exec(CODING_TOOL_PROGRAM, JSON.stringify({ ...value as object, baseline }), [], !["snapshot", "review_diff"].includes((value as { kind: string }).kind));
  try {
    const start = spawnSync("docker", ["run", "-d", "--rm", "--network", "none", "--name", name, "veltram-coding-fixture:20261014"], { timeout: 30_000 });
    assert.equal(start.status, 0, start.stderr.toString());
    const initialized = exec(CODING_INIT_PROGRAM, archive, ["a".repeat(40)]);
    assert.equal(initialized.status, 0, initialized.stderr.toString());
    baseline = JSON.parse(initialized.stdout.toString()).baseline;
    const protectedRuntime = tool({ kind: "run_command", cwd: ".", timeoutMs: 20_000, command: "/usr/bin/python3 -I -c 'import os,pathlib\nassert os.getuid()==os.geteuid()==1000\nassert os.getgid()==os.getegid()==1000\ns=dict(line.split('\"'\"':'\"'\"',1) for line in pathlib.Path('\"'\"'/proc/self/status'\"'\"').read_text().splitlines() if '\"'\"':'\"'\"' in line)\nfor k in ['\"'\"'CapInh'\"'\"','\"'\"'CapPrm'\"'\"','\"'\"'CapEff'\"'\"','\"'\"'CapBnd'\"'\"','\"'\"'CapAmb'\"'\"']: assert int(s[k].strip(),16)==0,(k,s[k])\nassert s['\"'\"'NoNewPrivs'\"'\"'].strip()=='\"'\"'1'\"'\"'\nfor p in ['\"'\"'/usr/local/bin/python3'\"'\"','\"'\"'/usr/bin/python3'\"'\"','\"'\"'/usr/bin/git'\"'\"','\"'\"'/usr/lib/python3.13/json/__init__.py'\"'\"','\"'\"'/workspace/repo/.git/config'\"'\"','\"'\"'/workspace/.veltram/baseline.json'\"'\"']:\n try:\n  with open(p,'\"'\"'wb'\"'\"') as f: f.write(b'\"'\"'forged'\"'\"')\n except PermissionError: pass\n else: raise Exception('\"'\"'trusted path writable: '\"'\"'+p)\nfor a,b in [('\"'\"'/workspace/repo/.git'\"'\"','\"'\"'/workspace/repo/stolen-git'\"'\"'),('\"'\"'/workspace/repo'\"'\"','\"'\"'/workspace/stolen-repo'\"'\"')]:\n try: os.rename(a,b)\n except PermissionError: pass\n else: raise Exception('\"'\"'trusted path replaceable: '\"'\"'+a)\ntry: os.setuid(0)\nexcept PermissionError: pass\nelse: raise Exception('\"'\"'root regained'\"'\"')\nprint('\"'\"'uid1000; capabilities zero; no_new_privs; trusted files protected'\"'\"')'" });
    assert.equal(protectedRuntime.status, 0, protectedRuntime.stderr.toString());
    const spoof = tool({ kind: "write_file", path: "json.py", content: "raise Exception(\"repository import injected\")\n" });
    assert.equal(spoof.status, 0);
    const isolatedRead = tool({ kind: "list_files", path: "." });
    assert.equal(isolatedRead.status, 0);
    tool({ kind: "write_file", path: "json.py", content: null });
    const failing = tool({ kind: "run_command", cwd: ".", command: "npm test", timeoutMs: 10_000 });
    assert.equal(failing.status, 1);
    for (const [path, content] of [["sum.js", "module.exports=(a,b)=>a+b;\n"], ["sum.py", "def sum(a,b): return a+b\n"]]) {
      const edited = tool({ kind: "write_file", path, content }); assert.equal(edited.status, 0, edited.stderr.toString());
    }
    const background = tool({ kind: "run_command", cwd: ".", timeoutMs: 20_000, command: "/usr/bin/python3 -c 'import pathlib,time; p=pathlib.Path(\"/tmp/veltram-background-proof\"); [(p.write_text(str(i)),time.sleep(.005)) for i in range(10000)]' >/dev/null 2>&1 & sleep .1" });
    assert.equal(background.status, 0);
    const before = JSON.parse(tool({ kind: "snapshot" }).stdout.toString());
    const quiescent = tool({ kind: "run_command", cwd: ".", timeoutMs: 20_000, command: "a=$(cat /tmp/veltram-background-proof); sleep .1; b=$(cat /tmp/veltram-background-proof); test \"$a\" = \"$b\"" });
    assert.equal(quiescent.status, 0, quiescent.stderr.toString());
    const passing = tool({ kind: "run_command", cwd: ".", command: "npm test && python3 -c 'from sum import sum; assert sum(2,3)==5' && test -z \"$OPENAI_API_KEY$GITHUB_TOKEN$CLOUDFLARE_API_TOKEN\"", timeoutMs: 10_000 });
    assert.equal(passing.status, 0, passing.stderr.toString());
    const after = JSON.parse(tool({ kind: "snapshot" }).stdout.toString());
    assert.equal(before.treeDigest, after.treeDigest);
    assert.equal(after.treeDigest, await codingTreeDigest(after.files));
    assert.deepEqual(after.files.map((f: { path: string }) => f.path), ["sum.js", "sum.py"]);
  } finally {
    spawnSync("docker", ["rm", "-f", name], { timeout: 15_000 });
    rmSync(directory, { recursive: true, force: true });
  }
});
