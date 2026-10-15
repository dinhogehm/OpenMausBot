import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCodingTool } from "../src/coding-program.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { query, boundedResult } from "../graft/query.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "veltram-graft-"));
  const repo = join(dir, "repo"); const cache = join(dir, "cache");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/math.ts"), "export function sum(a: number, b: number) { return a + b; }\nexport function total() { return sum(1, 2); }\n");
  const identity = { organizationId: "org_a", workspaceId: "ws_a", runId: "run_a", generation: 1, baseSha: "a".repeat(40) };
  const call = async (tool: unknown, other = identity) => JSON.parse(await query({ repo, cache, identity: other, tool }));
  return { dir, repo, cache, identity, call, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Graft tools accept bounded structural queries and reject unsafe or ambiguous arguments", () => {
  for (const tool of [
    { kind: "graft_map" },
    { kind: "graft_grep", pattern: "foo[bar]", path: "." },
    { kind: "graft_skeleton", path: "src/main.ts" },
    { kind: "graft_callers", symbol: "handleTask", path: "src", direction: "in", depth: 2 },
  ]) assert.doesNotThrow(() => validateCodingTool(tool));
  for (const tool of [
    { kind: "graft_skeleton", path: "../outside.ts" },
    { kind: "graft_skeleton", path: "src\\main.ts" },
    { kind: "graft_skeleton", path: ".graft/config.json" },
    { kind: "graft_grep", pattern: "", path: "." },
    { kind: "graft_grep", pattern: "x".repeat(513), path: "." },
    { kind: "graft_grep", pattern: "\ud800", path: "." },
    { kind: "graft_callers", symbol: "main", path: ".", direction: "both", depth: 1 },
    { kind: "graft_callers", symbol: "main", path: ".", direction: "in", depth: 3 },
  ]) assert.throws(() => validateCodingTool(tool), /invalid_coding_tool/);
});

test("real pinned Graft maps source, provides signatures, literal grep and call references without modifying checkout", async () => {
  const f = fixture();
  try {
    const original = readFileSync(join(f.repo, "src/math.ts"), "utf8");
    const map = await f.call({ kind: "graft_map" });
    assert.equal(map.available, true, JSON.stringify(map));
    assert.equal(map.version, "0.22.0");
    assert.equal(map.coverage.indexedFiles, 1);
    const skeleton = await f.call({ kind: "graft_skeleton", path: "src/math.ts" });
    assert.deepEqual(skeleton.result.entries.map((entry: { name: string }) => entry.name).sort(), ["sum", "total"]);
    const grep = await f.call({ kind: "graft_grep", pattern: "return sum(1, 2)", path: "src" });
    assert.equal(grep.result.totalHits, 1);
    const callers = await f.call({ kind: "graft_callers", symbol: "sum", path: ".", direction: "in", depth: 1 });
    assert.ok(callers.result.edges.some((edge: { node?: { name: string } }) => edge.node?.name === "total"), JSON.stringify(callers));
    assert.equal(readFileSync(join(f.repo, "src/math.ts"), "utf8"), original);
    assert.deepEqual(readdirSync(f.repo), ["src"]);
  } finally { f.clean(); }
});

test("refresh hashes same-size edits and deletions, isolates tenants and rejects invalid UTF-8, symlinks and configuration", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.repo, ".graft"));
    writeFileSync(join(f.repo, ".graft/config.json"), '{"includeDirs":["node_modules"],"followNestedRepos":true}');
    writeFileSync(join(f.repo, ".env"), "PRIVATE_MARKER=do_not_index");
    writeFileSync(join(f.repo, "config.ts"), "export function secretConfig() {}\n");
    writeFileSync(join(f.repo, "src/invalid.ts"), Buffer.from([0xff, 0xfe, 0x65]));
    writeFileSync(join(f.dir, "external.ts"), "export function externalSecret() {}\n");
    symlinkSync(join(f.dir, "external.ts"), join(f.repo, "src/link.ts"));
    const before = await f.call({ kind: "graft_map" });
    assert.equal(before.coverage.indexedFiles, 1);
    assert.equal(before.coverage.excluded.symlink, 1);
    assert.equal(before.coverage.excluded.encoding, 1);
    const content = readFileSync(join(f.repo, "src/math.ts"), "utf8").replaceAll("sum", "add");
    writeFileSync(join(f.repo, "src/math.ts"), content); utimesSync(join(f.repo, "src/math.ts"), 1, 1);
    const after = await f.call({ kind: "graft_skeleton", path: "src/math.ts" });
    assert.notEqual(after.revision, before.revision);
    assert.ok(after.result.entries.some((entry: { name: string }) => entry.name === "add"));
    assert.ok(!after.result.entries.some((entry: { name: string }) => entry.name === "sum"));
    rmSync(join(f.repo, "src/math.ts"));
    const other = await f.call({ kind: "graft_map" }, { ...f.identity, organizationId: "org_b" });
    assert.equal(other.result.totals.files, 0);
    const deleted = await f.call({ kind: "graft_skeleton", path: "src/math.ts" });
    assert.deepEqual(deleted.result.entries, []);
    assert.equal(readdirSync(f.cache).length, 2);
    assert.ok(!JSON.stringify(other).includes("externalSecret"));
  } finally { f.clean(); }
});

test("missing runtime falls back explicitly and oversized result remains bounded valid JSON", async () => {
  const f = fixture();
  try {
    const result = JSON.parse(await query({ repo: f.repo, cache: f.cache, identity: f.identity, tool: { kind: "graft_map" }, packageRoot: pathToFileURL(join(f.dir, "missing/")) }));
    assert.equal(result.available, false); assert.equal(result.reason, "graft_unavailable");
    assert.match(result.fallback, /read_file/);
    const output = boundedResult({ available: true, result: { values: Array(50_000).fill('"🚀') }, truncated: false });
    assert.ok(Buffer.byteLength(output) <= 32_000);
    assert.equal(JSON.parse(output).truncated, true);
  } finally { f.clean(); }
});

test("source limits fail closed instead of returning a partial graph as fresh", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 4096; index++) writeFileSync(join(f.repo, "src", `file-${index}.ts`), "export const value = 1;\n");
    const result = await f.call({ kind: "graft_map" });
    assert.equal(result.available, false);
    assert.equal(result.reason, "graft_source_limit");
    assert.equal(result.revision, undefined);
  } finally { f.clean(); }
});
