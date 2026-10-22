import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, lstatSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { patchMergePolicy } = createRequire(import.meta.url)("./omb-merge-scope.cjs");
const { installCandidate } = createRequire(import.meta.url)("./install-omb-merge-policy.cjs");
const SHA = "a1".repeat(20);
const command = `gh pr merge 23 --repo github.com/dinhogehm/OpenMausBot --merge --match-head-commit ${SHA}`;
const source = `const DEFAULT_DEPS = { stopped: () => false };
function classifyOnce(raw, cwd, deps = {}) {
  deps = { ...DEFAULT_DEPS, ...deps };
  return { decision: "deny", by: "rule", reason: 'merge só pelo gate, no formato exato "npm run pr:merge -- --pr N --merge"', match: raw.trim() };
}
module.exports = { classify: classifyOnce };\n`;

function load(text) {
  const module = new Module("/tmp/omb-synthetic-policy.cjs");
  module._compile(text, "/tmp/omb-synthetic-policy.cjs");
  return module.exports;
}

test("canonical OMB merge with a full head SHA uses its own corridor", () => {
  const rules = load(patchMergePolicy(source));
  assert.equal(rules.classify(command, "/tmp").decision, "allow");
});

test("STOP still blocks the canonical OMB merge", () => {
  const rules = load(patchMergePolicy(source));
  assert.equal(rules.classify(command, "/tmp", { stopped: () => true }).decision, "deny");
});

for (const result of [
  '{ decision: "deny", by: "rule", reason: "future mandatory rule", match: raw.trim() }',
  '{ decision: "deny", by: "other", reason: "another control", match: raw.trim() }',
  '{ decision: "allow", by: "original", reason: "already allowed" }',
  'null',
]) {
  test(`a different original decision remains authoritative: ${result}`, () => {
    const changed = source.replace(/return \{ decision:.*?\};/, `return ${result};`);
    assert.notEqual(changed, source, "The alternate original decision must be installed in the fixture");
    assert.deepEqual(load(patchMergePolicy(changed)).classify(command, "/tmp"), load(changed).classify(command, "/tmp"));
  });
}

const rejected = [
  command.replace("OpenMausBot", "nuria-platform"),
  command.replace("dinhogehm", "another-owner"),
  command.replace("github.com/", "git.example.com/"),
  command.replace("github.com/", ""),
  command.replace(" --match-head-commit " + SHA, ""),
  command.replace(SHA, SHA.slice(0, 12)),
  command.replace(SHA, "z".repeat(40)),
  command.replace("merge 23", "merge 0"),
  command.replace("merge 23", "merge -1"),
  command.replace("--merge", "--squash"),
  `${command} --admin`,
  `${command} --delete-branch`,
  `${command} --auto`,
  `${command} && echo changed`,
  `${command}\necho changed`,
  `${command} | cat`,
  `${command} > /tmp/result`,
  `GH_HOST=git.example.com ${command}`,
  `cd /tmp && ${command}`,
  `bash -c '${command}'`,
  `echo '${command}'`,
  `gh api --method PUT repos/dinhogehm/OpenMausBot/pulls/23/merge`,
  "npm run pr:merge -- --pr 23 --merge",
  "git push origin HEAD:main",
  "wrangler deploy",
];
for (const input of rejected) {
  test(`unrelated or extended command keeps the original decision: ${input}`, () => {
    assert.deepEqual(load(patchMergePolicy(source)).classify(input, "/tmp"), load(source).classify(input, "/tmp"));
  });
}

test("patch is idempotent", () => {
  const patched = patchMergePolicy(source);
  assert.equal(patchMergePolicy(patched), patched);
});

test("unknown policy layout is rejected", () => {
  assert.throws(() => patchMergePolicy("module.exports = {};"), /layout/i);
});

test("a partial or modified previous patch is rejected", () => {
  const patched = patchMergePolicy(source);
  assert.throws(() => patchMergePolicy(patched.replace("by: \"omb-merge\"", "by: \"changed\"")), /layout/i);
});

test("installer preserves the original bytes in a private backup and can be repeated", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-policy-install-"));
  const file = join(dir, "rules.cjs");
  try {
    writeFileSync(file, source, { mode: 0o640 });
    const result = installCandidate(file);
    assert.equal(result.installed, true);
    assert.equal(readFileSync(result.backup, "utf8"), source);
    assert.equal(lstatSync(result.backup).mode & 0o777, 0o600);
    assert.equal(lstatSync(file).mode & 0o777, 0o640);
    assert.equal(readFileSync(file, "utf8"), patchMergePolicy(source));
    assert.deepEqual(installCandidate(file), { installed: true, unchanged: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const kind of ["symlink", "hardlink", "unknown layout"]) {
  test(`installer refuses ${kind} without changing the original`, () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-policy-reject-"));
    const original = join(dir, "original.cjs");
    const file = join(dir, "rules.cjs");
    try {
      writeFileSync(original, source);
      if (kind === "symlink") symlinkSync(original, file);
      else if (kind === "hardlink") linkSync(original, file);
      else writeFileSync(file, "module.exports = {};");
      const contents = readFileSync(file, "utf8");
      assert.throws(() => installCandidate(file));
      assert.equal(readFileSync(file, "utf8"), contents);
      assert.equal(readFileSync(original, "utf8"), source);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
