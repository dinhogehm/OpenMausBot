import { describe, expect, it } from "vitest";
import { bgJobOverdueReport, bgJobResumePrompt, isInteractiveShell, jobAliveIn, leftoversIn, newTurnTree, noteDescendants, parseLsofCwd, parsePsTable, pidAlive, sessionLeftovers } from "./bg-jobs.ts";

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

  const table = [
    "  500     1   500 Tue Sep 30 10:00:00 2026 claude -p --output-format stream-json",
    "  510   500   510 Tue Sep 30 10:01:00 2026 /bin/zsh -c npm run ci:local",
    "  520   510   510 Tue Sep 30 10:01:01 2026 node scripts/local-ci.mjs",
    "  900   899   900 Tue Sep 30 09:00:00 2026 -zsh",
    "  910   900   900 Tue Sep 30 09:05:00 2026 npm run dev",
  ].join("\n");

  it("parses ps with lstart, and tells an interactive shell from a job", () => {
    expect(parsePsTable(table)[1]).toEqual({ pid: 510, ppid: 500, pgid: 510, start: "Tue Sep 30 10:01:00 2026", command: "/bin/zsh -c npm run ci:local" });
    expect(isInteractiveShell("-zsh")).toBe(true);
    expect(isInteractiveShell("/bin/bash -il")).toBe(true);
    expect(isInteractiveShell("zsh")).toBe(true);
    expect(isInteractiveShell("/bin/zsh -c npm run ci:local")).toBe(false);
  });

  it("keeps only what the turn's claude left running — not the person's shell or dev server in the same worktree", () => {
    const tree = newTurnTree(500);
    noteDescendants(tree, parsePsTable(table));
    expect([...tree.seen.keys()].sort()).toEqual([510, 520]);
    // the turn ended: claude is gone and its children were reparented to launchd
    const after = parsePsTable(table.replace("  510   500   510", "  510     1   510").split("\n").filter((line) => !line.includes("claude -p")).join("\n"));
    const cwds = [510, 520, 900, 910].map((pid) => ({ pid, cwd: "/repo/.claude/worktrees/fix-1" }));
    expect(sessionLeftovers("/repo/.claude/worktrees/fix-1", tree, after, cwds).map((proc) => proc.pid)).toEqual([510, 520]);
    expect(sessionLeftovers("/repo/.claude/worktrees/fix-1", tree, after, cwds)[1]!.start).toBe("Tue Sep 30 10:01:01 2026");
    // a later process in the job's process group, never sampled, still counts
    const late = parsePsTable(`${table}\n  530     1   510 Tue Sep 30 10:30:00 2026 node gate-child.mjs`);
    expect(sessionLeftovers("/repo/.claude/worktrees/fix-1", tree, late, [...cwds, { pid: 530, cwd: "/repo/.claude/worktrees/fix-1" }]).map((proc) => proc.pid)).toContain(530);
    // a reused pid (same number, another start) is not the job
    const reused = parsePsTable("  520     1   777 Tue Sep 30 12:00:00 2026 node something-else.mjs");
    expect(sessionLeftovers("/repo/.claude/worktrees/fix-1", tree, reused, [{ pid: 520, cwd: "/repo/.claude/worktrees/fix-1" }])).toEqual([]);
  });

  it("checks a job by pid and start time, and reports one that outlives its deadline", () => {
    const rows = parsePsTable(table);
    expect(jobAliveIn({ pids: [520], starts: ["Tue Sep 30 10:01:01 2026"] }, rows)).toBe(true);
    expect(jobAliveIn({ pids: [520], starts: ["Mon Sep 29 08:00:00 2026"] }, rows)).toBe(false);
    expect(jobAliveIn({ pids: [520] }, rows)).toBe(true);
    const report = bgJobOverdueReport({ id: "s1", title: "Fix" }, { pids: [520], commands: ["node scripts/local-ci.mjs"], since: 0 }, 3 * 3_600_000);
    expect(report).toContain("still running after 3 h");
    expect(report).toContain("no longer waits");
    expect(report).not.toContain("no watch needed");
  });
});
