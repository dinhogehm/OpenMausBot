"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { verifyCandidate, policyFile } = require("./check-omb-merge-policy.cjs");

function installCandidate(filename) {
  const stat = fs.lstatSync(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "Policy must be a regular file with one link");
  assert.equal(stat.uid, process.getuid(), "Only the policy owner may install it");
  const source = fs.readFileSync(filename, "utf8");
  const result = verifyCandidate(source, filename);
  if (result.installed) return { installed: true, unchanged: true };

  const suffix = `${Date.now()}-${randomUUID()}`;
  const backup = `${filename}.bak-omb-merge-${suffix}`;
  const temporary = `${filename}.tmp-omb-merge-${suffix}`;
  try {
    fs.writeFileSync(temporary, result.patched, { flag: "wx", mode: stat.mode & 0o777 });
    fs.writeFileSync(backup, source, { flag: "wx", mode: 0o600 });
    const current = fs.lstatSync(filename);
    assert(current.isFile() && current.nlink === 1 && current.dev === stat.dev && current.ino === stat.ino
      && current.mode === stat.mode && current.uid === stat.uid && current.gid === stat.gid
      && fs.readFileSync(filename, "utf8") === source, "Policy changed during preparation; installation aborted");
    fs.renameSync(temporary, filename);
    assert.equal(fs.readFileSync(filename, "utf8"), result.patched, "Installed policy changed unexpectedly");
    return { installed: true, unchanged: false, backup, comparisons: result.comparisons };
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

if (require.main === module) {
  assert.deepEqual(process.argv.slice(2), ["--install"], "Nothing installed. Owner usage: node scripts/policy/install-omb-merge-policy.cjs --install");
  assert(process.stdin.isTTY && process.stdout.isTTY, "Run directly in the owner's interactive Terminal; agents must not install reviewer policy");
  const result = installCandidate(policyFile());
  console.log(result.unchanged ? "Política OMB já instalada; nada alterado." : "Política OMB instalada. O próximo comando usa a regra; não é necessário reiniciar o app.");
  if (result.backup) console.log(`Backup: ${result.backup}`);
  console.log("Este instalador não mesclou nenhuma PR e não alterou a main.");
}

module.exports = { installCandidate };
