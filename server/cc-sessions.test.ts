import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CcSessionLedger, ccReportForOwner, ccStallReport, ccTurnArgs, lastHookDecision, parseCcStartInput, parseCcStream, slugify } from "./cc-sessions.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-cc-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const ledger = () => new CcSessionLedger({ path: join(dir, "cc.json") });
const base = { id: "11111111-2222-3333-4444-555555555555", ownerBotId: "chief", ownerThreadId: "t1", title: "#9237 WebAuthn flaky", repo: "/repo", permissionMode: "auto" as const };

describe("argv", () => {
  it("creates with a fixed id in its own worktree, then resumes", () => {
    const session = ledger().create(base);
    expect(session.worktree).toBe("9237-webauthn-flaky-111111");
    expect(ccTurnArgs(session, "do it", true)).toEqual(["-p", "--session-id", base.id, "-w", session.worktree, "--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--", "do it"]);
    expect(ccTurnArgs(session, "-rf looks like a flag", false)).toEqual(["-p", "--resume", base.id, "--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--", "-rf looks like a flag"]);
  });

  it("slugs accents and symbols", () => {
    expect(slugify("Seletor Disponível → Offline!")).toBe("seletor-disponivel-offline");
    expect(slugify("###")).toBe("sessao");
  });
});

describe("stream parsing", () => {
  const init = JSON.stringify({ type: "system", subtype: "init", cwd: "/repo/.claude/worktrees/x", session_id: base.id });
  it("reads the report, cost and worktree of a successful turn", () => {
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "PR #1 open", total_cost_usd: 0.42 });
    expect(parseCcStream([init, "{\"type\":\"assistant\"}", result], { code: 0 })).toEqual({ ok: true, cwd: "/repo/.claude/worktrees/x", report: "PR #1 open", costUsd: 0.42 });
  });

  it("treats an error result or a missing one as a failure", () => {
    const failed = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "" });
    expect(parseCcStream([init, failed], { code: 1 })).toMatchObject({ ok: false, error: "error_max_turns" });
    expect(parseCcStream([init, "boom: auth expired"], { code: 1 })).toMatchObject({ ok: false, error: expect.stringContaining("exited with code 1") });
    expect(parseCcStream([], { code: null, timedOut: true }).error).toContain("was stopped");
  });
});

describe("input", () => {
  const isRepo = (path: string) => path === "/repo";
  it("defaults to auto and refuses what it cannot run", () => {
    expect(parseCcStartInput({ title: "t", brief: "b", repo: "/repo" }, isRepo)).toEqual({ ok: true, title: "t", brief: "b", repo: "/repo", permissionMode: "auto" });
    expect(parseCcStartInput({ title: "t", brief: "b", repo: "/nope" }, isRepo).ok).toBe(false);
    expect(parseCcStartInput({ title: "t", brief: "b", repo: "relative" }, isRepo).ok).toBe(false);
    expect(parseCcStartInput({ title: "t", brief: "b", repo: "/repo", permissionMode: "bypassPermissions" }, isRepo).ok).toBe(false);
    expect(parseCcStartInput({ brief: "b", repo: "/repo" }, isRepo).ok).toBe(false);
  });
});

describe("ledger", () => {
  it("tracks turns, cost, queue and ownership, and survives a restart", () => {
    const first = ledger();
    const session = first.create(base);
    first.markRunning(session);
    expect(first.runningCount()).toBe(1);
    expect(first.enqueue(session, "also run the tests")).toBe(1);
    first.finishTurn(session, { ok: true, cwd: "/repo/.claude/worktrees/w", report: "done", costUsd: 0.1 });
    expect(session).toMatchObject({ status: "idle", turns: 1, costUsd: 0.1, cwd: "/repo/.claude/worktrees/w", lastReport: "done" });
    expect(first.takeQueued(session)).toBe("also run the tests");
    expect(first.owned("someone-else")).toEqual([]);
    first.markRunning(session);
    const reloaded = ledger();
    expect(reloaded.get(base.id)).toMatchObject({ status: "failed", lastError: expect.stringContaining("restarted") });
    expect(reloaded.interruptedOnLoad.map((session) => session.id)).toEqual([base.id]);
    // The server saves right after telling the owners, so it is reported once.
    reloaded.save();
    expect(ledger().interruptedOnLoad).toEqual([]);
  });

  it("keeps a stopped session stopped when its run exits late", () => {
    const l = ledger();
    const session = l.create(base);
    l.markRunning(session);
    l.setStatus(session, "stopped");
    l.finishTurn(session, { ok: true, report: "late", costUsd: 0.05 });
    expect(session.status).toBe("stopped");
    expect(session.lastReport).toBeUndefined();
    l.setStatus(session, "archived");
    expect(l.owned("chief")).toEqual([]);
    expect(l.owned("chief", true)).toHaveLength(1);
  });

  it("writes a report the manager can act on", () => {
    const l = ledger();
    const session = l.create(base);
    l.markRunning(session);
    l.finishTurn(session, { ok: true, report: "PR #9286 open, gate green", costUsd: 1 });
    expect(ccReportForOwner(session)).toContain("PR #9286 open, gate green");
    expect(ccReportForOwner(session)).toContain("cc_session_send");
  });

  it("says how the session runs: headless denials end the turn, app sessions name the mode the app really uses", () => {
    const l = ledger();
    const cli = l.create(base);
    expect(ccReportForOwner(cli)).toMatch(/headless CLI .* no approval dialog: a hook denial ends the turn/);
    const app = l.create({ ...base, id: "22222222-2222-3333-4444-555555555555", surface: "app", desktop: { marker: "OMBX", turnsSeen: 0, permissionMode: "bypassPermissions" } });
    expect(ccReportForOwner(app)).toContain("the app runs it as bypassPermissions");
    expect(ccReportForOwner(app, { hookDecision: "deny gh issue comment" })).toContain("Latest review-hook decision in its folder: deny gh issue comment");
    app.blockedOn = "approve the push";
    expect(ccReportForOwner(app)).toContain("BLOCKED — it needs: approve the push");
    expect(ccStallReport(app, 42)).toContain("no progress for 42 min");
  });
});

describe("lastHookDecision", () => {
  it("returns the latest log line about the folder, or null", () => {
    const log = join(dir, "dual-decisions.log");
    writeFileSync(log, [
      "2026-09-30T00:40:02Z | /repo/.claude/worktrees/a | deny | git push",
      "2026-09-30T00:41:00Z | /repo/.claude/worktrees/b | allow | gh pr view",
      "2026-09-30T00:48:12Z | /repo/.claude/worktrees/a | pass | jev: deny (confiança 51%)",
      "",
    ].join("\n"));
    expect(lastHookDecision(log, "/repo/.claude/worktrees/a")).toContain("jev: deny (confiança 51%)");
    expect(lastHookDecision(log, "/elsewhere")).toBeNull();
    expect(lastHookDecision(join(dir, "missing.log"), "/repo")).toBeNull();
  });
});
