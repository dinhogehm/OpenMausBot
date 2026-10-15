import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_INIT_PROGRAM, CODING_TOOL_PROGRAM, validateCodingTool, boundedStream, limitedArchive, CODING_ARCHIVE_BYTES } from "../src/coding-program.ts";
import { codingTreeDigest } from "../src/coding-types.ts";

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "veltram-program-"));
  const source = join(path, "archive/repository");
  mkdirSync(join(source, ".github/workflows"), { recursive: true });
  writeFileSync(join(source, "sum.py"), "def sum(a, b): return a - b\n");
  writeFileSync(join(source, ".github/workflows/test.yml"), "name: Original\n");
  const archive = spawnSync("tar", ["czf", "-", "-C", join(path, "archive"), "repository"], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).stdout;
  const init = spawnSync("python3", ["-c", CODING_INIT_PROGRAM.replace("    protect_checkout()", "    # Linux ownership is covered by Docker/native fixtures").replaceAll("/workspace", join(path, "work")), "a".repeat(40)], { input: archive });
  assert.equal(init.status, 0, init.stderr.toString());
  const baseline = JSON.parse(init.stdout.toString()).baseline;
  const call = (tool: unknown) => spawnSync("python3", ["-c", CODING_TOOL_PROGRAM.replace("    quiesce_repository()", "    # Process quiescence is covered by Docker/native fixtures").replaceAll("/workspace", join(path, "work"))], { input: JSON.stringify({ ...tool as object, baseline }), maxBuffer: 20 * 1024 * 1024 });
  return { path, call, clean: () => rmSync(path, { recursive: true, force: true }) };
}

test("extracts a baseline, edits source, runs real tests and returns a stable exact change manifest", () => {
  const f = fixture();
  try {
    const original = JSON.parse(f.call({ kind: "snapshot" }).stdout.toString());
    assert.deepEqual(original.files, []);
    const write = f.call({ kind: "write_file", path: "sum.py", content: "def sum(a, b): return a + b\n" });
    assert.equal(write.status, 0, write.stderr.toString());
    const before = JSON.parse(f.call({ kind: "snapshot" }).stdout.toString());
    const run = f.call({ kind: "run_command", command: "python3 -c 'from sum import sum; assert sum(2, 3) == 5'", cwd: ".", timeoutMs: 1000 });
    assert.equal(run.status, 0, run.stderr.toString());
    const after = JSON.parse(f.call({ kind: "snapshot" }).stdout.toString());
    assert.equal(before.files[0].content, "def sum(a, b): return a + b\n");
    assert.notEqual(before.treeDigest, original.treeDigest);
    assert.equal(after.treeDigest, before.treeDigest);
  } finally { f.clean(); }
});

test("tool paths cannot escape or modify git metadata; workflow edits are rejected at snapshot", () => {
  const f = fixture();
  try {
    for (const path of ["../outside", "/etc/passwd", ".git/config", "a/../../outside"]) {
      assert.notEqual(f.call({ kind: "write_file", path, content: "bad" }).status, 0);
    }
    symlinkSync("/tmp", join(f.path, "work/repo/escape"));
    assert.notEqual(f.call({ kind: "read_file", path: "escape/anything", offset: 0, limit: 100 }).status, 0);
    assert.equal(f.call({ kind: "write_file", path: ".github/workflows/test.yml", content: "name: Changed" }).status, 0);
    assert.notEqual(f.call({ kind: "snapshot" }).status, 0);
  } finally { f.clean(); }
});

test("tool validation refuses invalid size, timeout, malformed unicode and scope", () => {
  assert.throws(() => validateCodingTool({ kind: "run_command", command: "id", cwd: ".", timeoutMs: 600001 }), /invalid_coding_tool/);
  assert.throws(() => validateCodingTool({ kind: "write_file", path: "x", content: "\ud800" }), /invalid_coding_tool/);
  assert.throws(() => validateCodingTool({ kind: "read_file", path: "x", offset: -1, limit: 100 }), /invalid_coding_tool/);
});

test("bounded output drains excess bytes and preserves UTF-8 without retaining arbitrary output", async () => {
  const bytes = new TextEncoder().encode("abc🚀tail");
  const result = await boundedStream(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 5)); c.enqueue(bytes.subarray(5)); c.close(); } }), 7);
  assert.equal(result.output, "abc🚀");
  assert.equal(result.truncated, true);
});

test("archive handling rejects traversals and symlinks before checkout", () => {
  for (const mode of ["traversal", "symlink"]) {
    const path = mkdtempSync(join(tmpdir(), "veltram-archive-"));
    try {
      const archive = spawnSync("python3", ["-c", `import tarfile,io,sys
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as tar:
 root=tarfile.TarInfo('repository');root.type=tarfile.DIRTYPE;tar.addfile(root)
 item=tarfile.TarInfo('repository/../outside' if sys.argv[1]=='traversal' else 'repository/link')
 if sys.argv[1]=='symlink':item.type=tarfile.SYMTYPE;item.linkname='/tmp'
 tar.addfile(item)
`, mode]).stdout;
      const result = spawnSync("python3", ["-c", CODING_INIT_PROGRAM.replace("    protect_checkout()", "    # Linux ownership is covered by Docker/native fixtures").replaceAll("/workspace", join(path, "work")), "a".repeat(40)], { input: archive });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr.toString(), /unsafe_archive_path|unsupported_repository_entry/);
    } finally { rmSync(path, { recursive: true, force: true }); }
  }
});

test("archive streaming rejects compressed input beyond the configured cap", async () => {
  const archive = limitedArchive(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(CODING_ARCHIVE_BYTES + 1)); c.close(); } }));
  await assert.rejects(new Response(archive).arrayBuffer(), /repository_archive_limit/);
});

test("Python and Worker compute the same canonical Unicode manifest digest", async () => {
  const f = fixture();
  try {
    for (const path of ["𐀀.txt", "\ue000.txt", "ação.txt"]) assert.equal(f.call({ kind: "write_file", path, content: "Olá 🚀\n\u2028" }).status, 0);
    const snapshot = JSON.parse(f.call({ kind: "snapshot" }).stdout.toString());
    assert.equal(snapshot.treeDigest, await codingTreeDigest(snapshot.files));
  } finally { f.clean(); }
});

test("changing HEAD or the VM baseline file cannot hide source edits from the trusted snapshot", () => {
  const f = fixture();
  try {
    assert.equal(f.call({ kind: "write_file", path: "sum.py", content: "def sum(a,b): return a+b\n" }).status, 0);
    const commit = f.call({ kind: "run_command", cwd: ".", command: "git -c user.name=Fixture -c user.email=fixture@example.test commit -am changed && git rev-parse HEAD", timeoutMs: 1000 });
    assert.equal(commit.status, 0, commit.stderr.toString());
    const newHead = commit.stdout.toString().trim().split("\n").at(-1);
    writeFileSync(join(f.path, "work/.veltram/baseline.json"), JSON.stringify({ baseline: newHead }));
    const snapshot = JSON.parse(f.call({ kind: "snapshot" }).stdout.toString());
    assert.equal(snapshot.files.length, 1);
    const diff = f.call({ kind: "review_diff" });
    assert.equal(diff.status, 0, diff.stderr.toString());
    assert.match(diff.stdout.toString(), /return a - b/);
    assert.match(diff.stdout.toString(), /return a\+b/);
  } finally { f.clean(); }
});

test("git index assume-unchanged cannot hide edited source from the final manifest", () => {
  const f = fixture();
  try {
    assert.equal(f.call({ kind: "run_command", cwd: ".", command: "git update-index --assume-unchanged sum.py", timeoutMs: 1000 }).status, 0);
    assert.equal(f.call({ kind: "write_file", path: "sum.py", content: "def sum(a,b): return a+b\n" }).status, 0);
    const snapshot = JSON.parse(f.call({ kind: "snapshot" }).stdout.toString());
    assert.equal(snapshot.files.length, 1);
  } finally { f.clean(); }
});
