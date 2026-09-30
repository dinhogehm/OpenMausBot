import { describe, expect, it } from "vitest";
import { bgJobResumePrompt, leftoversIn, parseLsofCwd, pidAlive } from "./bg-jobs.ts";

describe("background jobs of a headless session", () => {
  it("reads lsof's cwd listing and keeps the processes inside the session's worktree", () => {
    const listing = parseLsofCwd("p100\nfcwd\nn/repo/.claude/worktrees/fix-1\np200\nfcwd\nn/repo\np300\nfcwd\nn/repo/.claude/worktrees/fix-1/packages/a\n");
    expect(listing).toEqual([{ pid: 100, cwd: "/repo/.claude/worktrees/fix-1" }, { pid: 200, cwd: "/repo" }, { pid: 300, cwd: "/repo/.claude/worktrees/fix-1/packages/a" }]);
    expect(leftoversIn("/repo/.claude/worktrees/fix-1", listing, [300]).map((proc) => proc.pid)).toEqual([100]);
    expect(leftoversIn("/repo/.claude/worktrees/fix-10", listing)).toEqual([]);
  });

  it("knows a live pid from a gone one, and tells the session what finished", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
    const prompt = bgJobResumePrompt({ pids: [77871], commands: ["npm run ci:local -- --profile full"], since: 0 }, 25 * 60_000);
    expect(prompt).toContain("after 25 min");
    expect(prompt).toContain("PID 77871: npm run ci:local -- --profile full");
  });
});
