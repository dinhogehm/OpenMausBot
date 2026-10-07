import { describe, expect, it } from "vitest";
import { bgJobOverdueReport, bgJobResumePrompt, cutLeftovers, gateLabel, gatesIn, isGateCommand, isInteractiveShell, isPollingShell, isToolProcess, jobAliveIn, mergeProcesses, leftoversIn, newTurnTree, noteDescendants, parseLsofCwd, parsePsTable, pidAlive, sessionLeftovers } from "./bg-jobs.ts";

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

  it("never takes a hook's graft sync, a hook runner or a sleep for the session's job", () => {
    expect(isToolProcess("node /Users/o/.npm-global/lib/node_modules/@nanonets/graft/dist/claude/sync-run.js")).toBe(true);
    expect(isToolProcess("node /opt/homebrew/bin/graft build")).toBe(true);
    expect(isToolProcess("node /Users/o/.laya/hooks/dual-review.cjs")).toBe(true);
    expect(isToolProcess("sleep 30")).toBe(true);
    expect(isToolProcess("node scripts/local-ci.mjs")).toBe(false);
    const tree = newTurnTree(500);
    const rows = parsePsTable([
      "  510   500   510 Tue Sep 30 10:01:00 2026 node /x/graft/dist/claude/sync-run.js",
      "  520   500   520 Tue Sep 30 10:01:01 2026 bash ./scripts/local-ci.sh --profile full",
    ].join("\n"));
    const cwds = [510, 520].map((pid) => ({ pid, cwd: "/w" }));
    expect(sessionLeftovers("/w", tree, rows, cwds).map((proc) => proc.pid)).toEqual([520]);
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

  it("after a cut follows only processes in a group of their own, never the claude's group", () => {
    const left = [
      { pid: 601, cwd: "/w", command: "node mcp-server", start: "s", pgid: 500 },
      { pid: 610, cwd: "/w", command: "bash ./scripts/local-ci.sh --profile full", start: "s", pgid: 610 },
      { pid: 620, cwd: "/w", command: "old record", start: "s" },
    ];
    expect(cutLeftovers(left, 500).map((proc) => proc.pid)).toEqual([610]);
  });

  // INSP-R13res A1/A6: the gate of a session is found by what it runs and
  // where, wherever its parent is; the agent's polling shells are neither a
  // gate nor a job.
  it("finds the session's gate anywhere on the machine, and never takes a polling shell for a gate or a job", () => {
    expect(isGateCommand("npm run ci:local")).toBe(true);
    expect(isGateCommand("bash ./scripts/local-ci.sh --profile full")).toBe(true);
    expect(isGateCommand("/bin/zsh -c source /x/snapshot.sh && eval 'npm run ci:local 2>&1 | tee /tmp/ci-local-9398.log'")).toBe(true);
    expect(isGateCommand("node scripts/pr-merge-gate.mjs 9398")).toBe(true);
    expect(isGateCommand("npm run dev")).toBe(false);
    expect(isPollingShell("/bin/zsh -c until grep -q 'exit=' /tmp/ci-local-9398.log; do sleep 5; done")).toBe(true);
    expect(isPollingShell("/bin/zsh -c while pgrep -f ci:local >/dev/null; do sleep 10; done")).toBe(true);
    expect(isPollingShell("tail -f /tmp/ci-local-9398.log")).toBe(true);
    expect(isGateCommand("/bin/zsh -c while pgrep -f ci:local >/dev/null; do sleep 10; done")).toBe(false);
    expect(isPollingShell("bash ./scripts/local-ci.sh --profile full")).toBe(false);
    expect(gateLabel([{ command: "node scripts/pr-merge-gate.mjs" }])).toBe("pr:merge");
    expect(gateLabel([{ command: "npm run ci:local" }])).toBe("ci:local");
    const rows = parsePsTable([
      // nohup'd: launchd is its parent, no turn's tree has it
      "  700     1   700 Tue Sep 30 10:01:00 2026 npm run ci:local",
      "  710   700   700 Tue Sep 30 10:01:01 2026 bash ./scripts/local-ci.sh --profile full",
      "  720     1   720 Tue Sep 30 10:02:00 2026 /bin/zsh -c until grep -q exit= /tmp/ci-local.log; do sleep 5; done",
      // another session's gate, in its own worktree
      "  730     1   730 Tue Sep 30 10:03:00 2026 npm run ci:local",
    ].join("\n"));
    const cwds = [{ pid: 700, cwd: "/w/a" }, { pid: 710, cwd: "/w/a/packages/x" }, { pid: 720, cwd: "/w/a" }, { pid: 730, cwd: "/w/b" }];
    expect(gatesIn("/w/a", rows, cwds).map((proc) => proc.pid)).toEqual([700, 710]);
    // a polling shell left by the turn is not its job either
    const tree = newTurnTree(500);
    const turn = parsePsTable([
      "  510   500   510 Tue Sep 30 10:01:00 2026 /bin/zsh -c until grep -q exit= /tmp/ci-local.log; do sleep 5; done",
      "  520   500   520 Tue Sep 30 10:01:01 2026 bash ./scripts/local-ci.sh --profile full",
    ].join("\n"));
    expect(sessionLeftovers("/w", tree, turn, [510, 520].map((pid) => ({ pid, cwd: "/w" }))).map((proc) => proc.pid)).toEqual([520]);
    expect(mergeProcesses([{ pid: 1, cwd: "/w", command: "a", start: "s" }], [{ pid: 1, cwd: "/w", command: "a", start: "s" }, { pid: 2, cwd: "/w", command: "b", start: "s" }]).map((proc) => proc.pid)).toEqual([1, 2]);
  });

  it("does not claim to know how a followed process ended", () => {
    const prompt = bgJobResumePrompt({ pids: [77871], commands: ["npm run ci:local"], since: 0 }, 60_000);
    expect(prompt).toContain("cannot see their exit code");
  });
});
