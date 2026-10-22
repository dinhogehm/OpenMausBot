"use strict";

const ANCHOR = "function classifyOnce(raw, cwd, deps = {}) {\n  deps = { ...DEFAULT_DEPS, ...deps };";
const ORIGINAL_ANCHOR = ANCHOR.replace("function classifyOnce(", "function classifyOnceBeforeOmbMerge(");
const WRAPPER = String.raw`function classifyOnce(raw, cwd, deps = {}) {
  const result = classifyOnceBeforeOmbMerge(raw, cwd, deps);
  // A different or future denial remains authoritative, including for this command.
  if (!result || result.decision !== "deny" || result.by !== "rule"
    || result.reason !== 'merge só pelo gate, no formato exato "npm run pr:merge -- --pr N --merge"'
    || result.match !== String(raw).trim()) return result;
  const match = /^gh pr merge ([1-9][0-9]*) --repo github\.com\/dinhogehm\/OpenMausBot --merge --match-head-commit ([a-f0-9]{40})$/.exec(String(raw).trim());
  if (!match) return result;
  const context = { ...DEFAULT_DEPS, ...deps };
  if (context.stopped()) return { decision: "deny", by: "go", reason: "PARAR ligado: sem merge" };
  return { decision: "allow", by: "omb-merge", reason: "Merge OpenMausBot #" + match[1] + " no head exato " + match[2] };
}`;

function count(text, fragment) {
  return text.split(fragment).length - 1;
}

function patchMergePolicy(source) {
  if (source.includes("classifyOnceBeforeOmbMerge") || source.includes("ombCanonicalMerge")) {
    if (count(source, WRAPPER) === 1 && count(source, ORIGINAL_ANCHOR) === 1) return source;
    throw new Error("Unrecognized OMB policy layout; no changes made");
  }
  if (count(source, ANCHOR) !== 1) throw new Error("Unrecognized policy layout; no changes made");
  return source.replace(ANCHOR, `${WRAPPER}\n\n${ORIGINAL_ANCHOR}`);
}

module.exports = { patchMergePolicy };
