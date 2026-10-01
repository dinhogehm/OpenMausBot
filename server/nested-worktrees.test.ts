import { describe, expect, it } from "vitest";
import { nestedWorktrees, parseWorktreeList, removeNestedWorktrees } from "./nested-worktrees.ts";

const parent = "/r/nuria-platform/.claude/worktrees/9286-lote";
const porcelain = [
  "worktree /r/nuria-platform\nHEAD aaa\nbranch refs/heads/main",
  `worktree ${parent}\nHEAD bbb\nbranch refs/heads/claude/9286-lote`,
  `worktree ${parent}/g9278\nHEAD c78\nbranch refs/heads/hotfix/9278`,
  `worktree ${parent}/c9322\nHEAD c22\nbranch refs/heads/chore/carrier-9322`,
  `worktree ${parent}/wt9278\nHEAD w78\nbranch refs/heads/fix/9278-eng\nlocked`,
  `worktree ${parent}/g9330\nHEAD c30\nbranch refs/heads/fix/9330`,
  `worktree ${parent}-other\nHEAD ddd\nbranch refs/heads/x`,
].join("\n\n");

describe("worktrees a session left inside its own", () => {
  it("reads the porcelain list and finds only the nested ones", () => {
    const entries = parseWorktreeList(porcelain);
    expect(entries).toHaveLength(7);
    expect(entries[4]).toEqual({ path: `${parent}/wt9278`, head: "w78", branch: "fix/9278-eng", locked: true });
    expect(nestedWorktrees(entries, parent).map((entry) => entry.path.split("/").pop())).toEqual(["g9278", "c9322", "wt9278", "g9330"]);
  });

  it("removes the merged, unlocked and clean ones and names the rest", () => {
    const calls: string[] = [];
    const git = (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "worktree" && args[1] === "list") return porcelain;
      if (args[0] === "merge-base" && args[2] === "c30") throw new Error("not ancestor");
      if (args[0] === "worktree" && args[1] === "remove" && args[2]!.endsWith("/c9322")) throw new Error("contains modified files");
      return "";
    };
    expect(removeNestedWorktrees(parent, git)).toBe(
      "Worktrees internas removidas (já mergeadas): g9278. Mantidas: c9322 (tem mudanças locais), wt9278 (bloqueada), g9330 (não está em origin/main).",
    );
    // never forced, never the session's own worktree
    expect(calls.some((call) => call.includes("--force"))).toBe(false);
    expect(calls).not.toContain(`worktree remove ${parent}`);
  });

  it("says nothing when there are none, or git cannot list them", () => {
    expect(removeNestedWorktrees(parent, () => "worktree /r/nuria-platform\nHEAD aaa")).toBe("");
    expect(removeNestedWorktrees(parent, () => { throw new Error("not a repo"); })).toBe("");
  });
});
