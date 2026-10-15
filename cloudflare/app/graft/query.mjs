import { createHash } from "node:crypto";
import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "0.22.0";
const LIMIT = 32_000;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php", ".r", ".scala", ".sc", ".vue", ".svelte", ".ex", ".exs", ".erl", ".lua"]);
const SKIP = new Set(["node_modules", "dist", "build", "_build", "out", "target", "vendor", "coverage", "__pycache__", "venv"]);
const fallback = "Use list_files/read_file for direct source inspection; this query did not change the repository.";
const hash = value => createHash("sha256").update(value).digest("hex");
const sourceName = name => !name.startsWith(".") && !SKIP.has(name.toLowerCase()) && !/^(?:env|config|configuration|secrets?|credentials?)(?:[._-]|$)/i.test(name) && !/(?:^|[._-])(?:config|secrets?|credentials?)(?:[._-]|$)/i.test(name);

function queryPath(value) {
  if (typeof value !== "string" || !value || !value.isWellFormed() || Buffer.byteLength(value) > 1024 || value.includes("\\") || value.includes("\0") || value.startsWith("/")) throw new Error("graft_invalid_query");
  const parts = value.split("/");
  if (parts.some(part => part === ".." || part !== "." && part.startsWith("."))) throw new Error("graft_invalid_query");
  return parts.filter(part => part !== "." && part !== "").join("/");
}

function validate(tool) {
  if (!tool || typeof tool !== "object") throw new Error("graft_invalid_query");
  if (tool.kind === "graft_map") return;
  queryPath(tool.path);
  if (tool.kind === "graft_skeleton") return;
  if (tool.kind === "graft_grep" && typeof tool.pattern === "string" && tool.pattern.isWellFormed() && tool.pattern.length && !tool.pattern.includes("\0") && Buffer.byteLength(tool.pattern) <= 512) return;
  if (tool.kind === "graft_callers" && typeof tool.symbol === "string" && tool.symbol.isWellFormed() && tool.symbol.trim() && !tool.symbol.includes("\0") && Buffer.byteLength(tool.symbol) <= 256 && ["in", "out"].includes(tool.direction) && [1, 2].includes(tool.depth)) return;
  throw new Error("graft_invalid_query");
}

// The caller has already stopped repository processes. No repository config,
// ignore rules, hooks, symlinks or non-source contents enter the parser mirror.
function collect(repo) {
  const files = [];
  const excluded = { policy: 0, symlink: 0, encoding: 0, oversized: 0 };
  let entries = 0;
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  function visit(directory, prefix = "", depth = 0) {
    if (depth > 64) throw new Error("graft_source_limit");
    for (const nameBytes of readdirSync(directory, { encoding: "buffer" }).sort(Buffer.compare)) {
      if (++entries > 20_000) throw new Error("graft_source_limit");
      let name;
      try { name = decoder.decode(nameBytes); } catch { excluded.encoding++; continue; }
      if (!sourceName(name)) { excluded.policy++; continue; }
      const relative = prefix + name;
      if (Buffer.byteLength(relative) > 1024) { excluded.policy++; continue; }
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) { excluded.symlink++; continue; }
      if (stat.isDirectory()) { visit(absolute, relative + "/", depth + 1); continue; }
      if (!stat.isFile() || !SOURCE_EXTENSIONS.has(extname(name).toLowerCase())) { excluded.policy++; continue; }
      if (stat.size > 1_000_000) { excluded.oversized++; continue; }
      if (files.length >= 4096 || bytes + stat.size > 64 * 1024 * 1024) throw new Error("graft_source_limit");
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content;
      try { content = readFileSync(fd); } finally { closeSync(fd); }
      try { decoder.decode(content); } catch { excluded.encoding++; continue; }
      if (content.includes(0)) { excluded.encoding++; continue; }
      bytes += content.length;
      files.push({ path: relative, content });
    }
  }
  if (lstatSync(repo).isSymbolicLink() || !lstatSync(repo).isDirectory()) throw new Error("graft_invalid_checkout");
  visit(repo);
  const revision = hash(JSON.stringify(files.map(file => [file.path, hash(file.content)])));
  return { files, excluded, bytes, revision };
}

function nodeSummary(node) {
  return { id: node.id, name: node.name, kind: node.kind, path: node.path, span: node.span, signature: node.signature };
}

export function boundedResult(value) {
  let json = JSON.stringify(value);
  if (Buffer.byteLength(json) <= LIMIT) return json;
  const excerpt = new TextDecoder().decode(Buffer.from(JSON.stringify(value.result)).subarray(0, 10_000), { stream: true });
  json = JSON.stringify({ ...value, result: { excerpt, incomplete: true }, truncated: true });
  if (Buffer.byteLength(json) > LIMIT) throw new Error("graft_output_limit");
  return json;
}

/** Exported for isolated fixtures. Production paths and environment are fixed by the launcher. */
export async function query({ repo, cache, identity, tool, packageRoot = new URL("./node_modules/@nanonets/graft/", import.meta.url) }) {
  let baseSha;
  try {
    validate(tool);
    if (!identity || ![identity.organizationId, identity.workspaceId, identity.runId].every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id)) || !Number.isSafeInteger(identity.generation) || identity.generation < 1 || !/^[a-f0-9]{40}$/.test(identity.baseSha)) throw new Error("graft_invalid_identity");
    baseSha = identity.baseSha;
    const scope = hash(JSON.stringify([identity.organizationId, identity.workspaceId, identity.runId, identity.generation, baseSha]));
    const root = join(cache, scope);
    const source = join(root, "source");
    const contextDir = join(root, "index");
    const collected = collect(repo);
    // Recreate the sanitized mirror on every query. Graft's extraction cache is
    // content-hashed, so unchanged files reuse their parse; deletions disappear.
    rmSync(source, { recursive: true, force: true });
    mkdirSync(source, { recursive: true, mode: 0o700 });
    for (const file of collected.files) {
      const path = join(source, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file.content, { mode: 0o600 });
    }
    const metadata = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
    if (metadata.version !== VERSION) throw new Error("graft_version_mismatch");
    const [{ buildGraph }, { readGraph, wiringPath }, { buildRepoMap }, { grepGraph }, { resolveSymbol, impactOfMany }] = await Promise.all([
      import(new URL("dist/graph/build.js", packageRoot)),
      import(new URL("dist/graph/write.js", packageRoot)),
      import(new URL("dist/graph/map.js", packageRoot)),
      import(new URL("dist/search/grep.js", packageRoot)),
      import(new URL("dist/graph/traverse.js", packageRoot)),
    ]);
    const build = await buildGraph(source, { contextDir, graphOnly: true, reuse: true, lsp: false });
    const graph = readGraph(wiringPath(contextDir));
    if (!graph) throw new Error("graft_index_unavailable");
    const scopePath = tool.path ? queryPath(tool.path) : "";
    let result;
    let truncated = false;
    if (tool.kind === "graft_map") {
      result = buildRepoMap(graph, { maxDirs: 20, hubsPerDir: 3, hotspots: 12 });
      delete result.saved;
      truncated = result.dropped > 0 || result.scopes?.some(scope => scope.dropped > 0) || false;
    } else if (tool.kind === "graft_grep") {
      result = grepGraph(graph, source, tool.pattern, { fixed: true, maxHits: 30, ...(scopePath ? { in: scopePath } : {}) });
      delete result.saved;
      truncated = Boolean(result.truncated?.files || result.truncated?.hits);
    } else if (tool.kind === "graft_skeleton") {
      const nodes = graph.nodes.filter(node => node.path === scopePath && node.kind !== "file");
      result = { file: scopePath, entries: nodes.slice(0, 120).map(nodeSummary) };
      truncated = nodes.length > 120;
    } else {
      const matches = resolveSymbol(graph, tool.symbol, scopePath ? { in: scopePath } : {});
      const edges = impactOfMany(graph, matches.slice(0, 20), tool.depth, tool.direction);
      result = { symbol: tool.symbol, direction: tool.direction, depth: tool.depth, matches: matches.slice(0, 20).map(nodeSummary), edges: edges.slice(0, 100).map(edge => ({ ...edge, node: edge.node ? nodeSummary(edge.node) : null })) };
      truncated = matches.length > 20 || edges.length > 100;
    }
    return boundedResult({ available: true, version: VERSION, baseSha, revision: collected.revision, coverage: { sourceFiles: collected.files.length, indexedFiles: build.files, sourceBytes: collected.bytes, excluded: collected.excluded, parseErrors: build.errors.length, note: "Structural source-only index; configs, hidden paths, dependencies and unsupported or invalid UTF-8 files are excluded. References can be incomplete without project config or language servers." }, result, truncated });
  } catch (error) {
    const reason = error instanceof Error && /^graft_[a-z_]+$/.test(error.message) ? error.message : "graft_unavailable";
    return JSON.stringify({ available: false, version: VERSION, ...(baseSha ? { baseSha } : {}), reason, fallback });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // No CLI, dotenv, user config, telemetry, LSP, deep pass or AI client is invoked.
  // The launcher provides an empty allowlisted environment and disables egress.
  const input = JSON.parse(readFileSync(0, "utf8"));
  console.log = console.warn = console.error = () => {};
  process.stdout.write(await query({ repo: "/workspace/repo", cache: "/workspace/.veltram-graft", identity: input.identity, tool: input.tool }));
}
