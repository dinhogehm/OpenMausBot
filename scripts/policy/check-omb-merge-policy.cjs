"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { patchMergePolicy } = require("./omb-merge-scope.cjs");

function compilePolicy(source, filename) {
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  module._compile(source, filename);
  return module.exports;
}

function verifyCandidate(source, filename) {
  const patched = patchMergePolicy(source);
  const before = compilePolicy(source, filename);
  const after = compilePolicy(patched, filename);
  if (typeof before.protectedPath === "function") {
    assert.equal(after.protectedPath(filename), before.protectedPath(filename));
    assert.equal(typeof after.protectedPath(filename), "string", "Reviewer policy must remain protected from agent writes");
  }
  const sha = "a1".repeat(20);
  const command = `gh pr merge 23 --repo github.com/dinhogehm/OpenMausBot --merge --match-head-commit ${sha}`;
  const deps = {
    stopped: () => false, readText: () => null, readScript: () => null,
    currentBranch: () => "fix/fixture", branchOf: () => "fix/fixture", isTag: () => false,
    gitAlias: () => "", gitConfig: () => "", ghSearch: () => [], openPrForHead: () => [],
    deliveredInProduction: () => false, shaInProduction: () => false,
    realpath: value => value, fileInfo: () => null, originOf: () => null,
    ghRepoEnv: () => "", ghHostEnv: () => "", procTable: () => [], procCwd: () => null,
    roles: () => [], listDir: () => [], selfPid: () => 999_999, nlinkOf: () => 0,
  };
  const cwd = "/tmp/omb-policy-fixture";
  assert.equal(after.classify(command, cwd, deps)?.decision, "allow");
  assert.equal(after.classify(command, cwd, { ...deps, stopped: () => true })?.decision, "deny");
  const commands = [
    command.replace("OpenMausBot", "nuria-platform"),
    command.replace("dinhogehm", "another-owner"),
    command.replace("github.com/", "example.com/"),
    command.replace("github.com/", ""),
    command.replace(" --match-head-commit " + sha, ""),
    command.replace(sha, sha.slice(0, 12)),
    `${command} --admin`, `${command} --delete-branch`, `${command} --auto`,
    `${command} && echo extra`, `${command}\necho extra`, `${command} | cat`,
    `${command} > /tmp/result`, `GH_HOST=example.com ${command}`,
    `cd /tmp && ${command}`, `bash -c '${command}'`, `echo '${command}'`,
    "gh pr merge 23 --repo dinhogehm/nuria-platform --merge",
    "gh api --method PUT repos/dinhogehm/OpenMausBot/pulls/23/merge",
    "npm run pr:merge -- --pr 23 --merge", "npm run pr:merge -- --pr 23 --publish",
    "git push origin HEAD:main", "git push --force origin branch", "wrangler deploy",
    "gh pr view 23 --repo dinhogehm/OpenMausBot",
  ];
  for (const raw of commands) {
    for (const stopped of [false, true]) {
      const context = { ...deps, stopped: () => stopped };
      assert.deepEqual(after.classify(raw, cwd, context), before.classify(raw, cwd, context), raw);
    }
  }
  assert.equal(patchMergePolicy(patched), patched);
  return { patched, comparisons: commands.length * 2, installed: patched === source };
}

function policyFile() {
  return path.join(os.userInfo().homedir, ".laya", "hooks", "dual-review-rules.cjs");
}

if (require.main === module) {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/policy/check-omb-merge-policy.cjs");
  const filename = policyFile();
  const result = verifyCandidate(fs.readFileSync(filename, "utf8"), filename);
  console.log(JSON.stringify({ candidateVerified: true, comparisons: result.comparisons,
    installed: result.installed, writes: 0 }));
  console.log(result.installed ? "Política OMB já instalada." : "Verificação concluída. A política OMB NÃO foi instalada; instalação exclusiva do dono.");
}

module.exports = { verifyCandidate, policyFile };
