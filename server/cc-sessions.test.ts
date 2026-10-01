import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CcSessionLedger, cliSurfaceRefusal, corridorForSend, corridorVersionOf, issueTitle, ccSessionLine, ccHeldQueueReport, repoCorridor, repoPackageManager, repoScripts, useRepoScripts, ccReportForOwner, ccStallReport, corridorHint, ccTurnArgs, lastHookBlock, lastHookDecision, parseCcStartInput, parseCcStream, slugify } from "./cc-sessions.ts";

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
    expect(first.takeQueued(session)).toEqual({ next: "also run the tests", held: [] });
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
    expect(ccReportForOwner(app, { hookDecision: "deny gh issue comment" })).toContain("Latest review-hook decision for this session (deny/ask preferred): deny gh issue comment");
    app.blockedOn = "approve the push";
    expect(ccReportForOwner(app)).toContain("BLOCKED — it needs: approve the push");
    expect(ccStallReport(app, 42)).toContain("no progress for 42 min");
  });
});

describe("lastHookDecision", () => {
  it("finds the session by its id and prefers its latest deny or ask", () => {
    const log = join(dir, "dual-decisions.log");
    writeFileSync(log, [
      JSON.stringify({ at: "1", session: "561eb60e", tool: "Bash", outcome: "deny", input: "gh issue comment 9298" }),
      JSON.stringify({ at: "2", session: "79326d3c", tool: "Bash", outcome: "pass", input: "grep helpdesk-inatividade-automation-f30521" }),
      JSON.stringify({ at: "3", session: "561eb60e", tool: "Read", outcome: "pass", input: "x" }),
      "",
    ].join("\n"));
    expect(lastHookDecision(log, "561eb60e")).toContain("gh issue comment 9298");
    expect(lastHookDecision(log, "79326d3c")).toContain('"outcome":"pass"');
    expect(lastHookDecision(log, "nope")).toBeNull();
    expect(lastHookDecision(join(dir, "missing.log"), "561eb60e")).toBeNull();
  });
  it("reads the exact command the hook blocked, even when the log cut its input short", () => {
    const log = join(dir, "dual-decisions.log");
    writeFileSync(log, [
      JSON.stringify({ at: "2026-09-30T19:00:00Z", session: "s1", tool: "Bash", outcome: "deny", cwd: "/repo/.claude/worktrees/fix-9298", input: JSON.stringify({ command: "gh issue comment 9298 --body \"pronto\"" }) }),
      JSON.stringify({ at: "2026-09-30T19:01:00Z", session: "s2", tool: "Bash", outcome: "ask", input: `{"command":"npm run pr:merge -- --pr 9313 --merge --receipt .local-ci/runs/abc/rec` }),
      JSON.stringify({ at: "2026-09-30T19:02:00Z", session: "s1", tool: "Bash", outcome: "pass", input: JSON.stringify({ command: "ls" }) }),
      "",
    ].join("\n"));
    expect(lastHookBlock(log, "s1")).toEqual({ command: 'gh issue comment 9298 --body "pronto"', truncated: false, cwd: "/repo/.claude/worktrees/fix-9298", at: Date.parse("2026-09-30T19:00:00Z") });
    expect(lastHookBlock(log, "s2")).toMatchObject({ command: "npm run pr:merge -- --pr 9313 --merge --receipt .local-ci/runs/abc/rec", truncated: true });
    expect(lastHookBlock(log, "s3")).toBeNull();
  });
});

describe("stalled sessions on load", () => {
  it("turns a running session already reported as stalled (and not moving since) into stalled", () => {
    const path = join(dir, "cc.json");
    const base2 = { ...base, surface: "app" as const, status: "running", createdAt: 1, lastActivityAt: 1, turns: 1, costUsd: 0, queued: [], worktree: "w" };
    writeFileSync(path, JSON.stringify({ sessions: [
      { ...base2, id: "stuck", progressAt: 500, stallReportedAt: 500 },
      { ...base2, id: "moving", progressAt: 900, stallReportedAt: 500 },
      { ...base, id: "cli-stalled", status: "stalled", createdAt: 1, lastActivityAt: 1, turns: 1, costUsd: 0, queued: [], worktree: "w" },
    ] }));
    const l = new CcSessionLedger({ path, now: () => 10_000 });
    expect(l.get("stuck")).toMatchObject({ status: "stalled", stallReports: 1, stallNotifiedAt: 10_000 });
    expect(l.get("moving")?.status).toBe("running");
    expect(l.get("cli-stalled")?.status).toBe("failed");
  });
});

describe("queue age", () => {
  it("holds back queued messages older than 2h and treats untimed ones as old", () => {
    let now = 10 * 3_600_000;
    const l = new CcSessionLedger({ path: join(dir, "cc.json"), now: () => now });
    const session = l.create(base);
    l.enqueue(session, "old order");
    now += 3 * 3_600_000;
    l.enqueue(session, "fresh order");
    const taken = l.takeQueued(session);
    expect(taken.next).toBe("fresh order");
    expect(taken.held.map((item) => item.text)).toEqual(["old order"]);
    expect(session.heldQueue?.map((item) => item.text)).toEqual(["old order"]);
    expect(ccHeldQueueReport(session, taken.held, now)).toMatch(/NOT delivered[\s\S]*\(3h\) old order/);
    const path = join(dir, "legacy.json");
    writeFileSync(path, JSON.stringify({ sessions: [{ ...base, status: "idle", createdAt: 1, lastActivityAt: 1, turns: 1, costUsd: 0, worktree: "w", queued: ["from before ages"] }] }));
    const legacy = new CcSessionLedger({ path, now: () => now });
    const loaded = legacy.get(base.id)!;
    expect(loaded.queued).toEqual([{ text: "from before ages", at: 0 }]);
    expect(legacy.takeQueued(loaded)).toMatchObject({ next: null, held: [{ text: "from before ages" }] });
  });
});

describe("the repository's own scripts", () => {
  it("turns a guessed pnpm into npm run for an npm repository, and leaves the rest", () => {
    const repo = join(dir, "npm-repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "package-lock.json"), "{}");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { "ci:local": "x", "pr:merge": "y", test: "z" } }));
    expect(repoPackageManager(repo)).toBe("npm");
    const brief = "rode `pnpm ci:local`, depois merge por `pnpm pr:merge -- --pr 9286 --merge`; pnpm install antes; pnpm run test; pnpm vitest run a.test.ts";
    expect(useRepoScripts(brief, repoPackageManager(repo), repoScripts(repo))).toEqual({
      text: "rode `npm run ci:local`, depois merge por `npm run pr:merge -- --pr 9286 --merge`; pnpm install antes; npm run test; pnpm vitest run a.test.ts",
      changed: true,
    });
    const pnpmRepo = join(dir, "pnpm-repo");
    mkdirSync(pnpmRepo);
    writeFileSync(join(pnpmRepo, "pnpm-lock.yaml"), "");
    expect(useRepoScripts(brief, repoPackageManager(pnpmRepo), repoScripts(pnpmRepo)).changed).toBe(false);
    expect(repoScripts(join(dir, "nothing")).size).toBe(0);
    const declared = join(dir, "declared");
    mkdirSync(declared);
    writeFileSync(join(declared, "package.json"), JSON.stringify({ packageManager: "npm@10.0.0" }));
    expect(repoPackageManager(declared)).toBe("npm");
    expect(repoPackageManager(join(dir, "nothing"))).toBeNull();
  });
});

describe("a repository's corridor", () => {
  it("lists the exact gate, push and carrier forms, and the order of a batch, only where they exist", () => {
    const repo = join(dir, "platform");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "package-lock.json"), "{}");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { "pr:merge": "./scripts/pr-merge-gate.sh" } }));
    writeFileSync(join(repo, "scripts", "release-carrier.sh"), "");
    const corridor = repoCorridor(repo);
    expect(corridor).toContain("`npm run pr:merge -- --pr N --publish`");
    expect(corridor).toContain("`npm run pr:merge -- --pr N --merge --receipt .local-ci/runs/<run>/receipt.env`");
    expect(corridor).toContain("`git push -u origin HEAD:<type>/<branch>`");
    expect(corridor).toContain("`./scripts/release-carrier.sh --execute --label X`");
    expect(corridor).toContain("no pipes");
    expect(corridor).toContain("hotfix/P0/P1 first, ahead of any CI or infrastructure PR");
    expect(corridor).toContain("separate carrier");
    expect(corridor).not.toContain("pnpm run");
    const plain = join(dir, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(repoCorridor(plain)).toBe("");
    expect(repoCorridor(join(dir, "missing"))).toBe("");
  });

  it("goes with a send that merges or publishes, once per version", () => {
    const corridor = "\n\nThis repository's corridor — …";
    const old: { corridorVersion?: string } = {};
    const sent = corridorForSend(old, corridor, "Inclua o hotfix #9278 no carrier e publique");
    expect(sent.text).toBe(`Inclua o hotfix #9278 no carrier e publique${corridor}`);
    expect(sent.version).toBe(corridorVersionOf(corridor));
    expect(corridorForSend({ corridorVersion: sent.version }, corridor, "agora faça o merge da #9289").text).toBe("agora faça o merge da #9289");
    expect(corridorForSend({ corridorVersion: "older" }, corridor, "merge da #9289").version).toBe(sent.version);
    expect(corridorForSend(old, corridor, "rode os testes de novo")).toEqual({ text: "rode os testes de novo" });
    expect(corridorForSend(old, "", "publique")).toEqual({ text: "publique" });
  });

  it("refuses a headless session of merges and releases without a reason", () => {
    const shipping = { corridor: "x", title: "#9286 #9303 Merge e publicação", brief: "merge e carrier" };
    expect(cliSurfaceRefusal(shipping)).toContain("cli_reason");
    expect(cliSurfaceRefusal({ ...shipping, reason: "o envio no app está falhando" })).toBeNull();
    expect(cliSurfaceRefusal({ ...shipping, corridor: "" })).toBeNull();
    expect(cliSurfaceRefusal({ corridor: "x", title: "limpar worktrees", brief: "apague pastas mergeadas antigas? não, só liste" })).toBeNull();
  });

  it("names the issues a title opens with", () => {
    expect(issueTitle("9286 9303 9289 9290 Merge do lote")).toBe("#9286 #9303 #9289 #9290 Merge do lote");
    expect(issueTitle("9298 automação inatividade")).toBe("#9298 automação inatividade");
    expect(issueTitle("#9237 webauthn flaky")).toBe("#9237 webauthn flaky");
    expect(issueTitle("Lote 2026 de PRs")).toBe("Lote 2026 de PRs");
  });
});

describe("archiving", () => {
  it("clears an old error and a background job when a session is archived", () => {
    const ledger = new CcSessionLedger({ path: null, now: () => 5 });
    const session = ledger.create({ id: "s", ownerBotId: "b", ownerThreadId: "t", title: "#1", repo: "/r", permissionMode: "auto" });
    session.lastError = "could not archive it in the Claude app";
    session.bgJob = { pids: [1], commands: ["x"], since: 0 };
    ledger.setStatus(session, "archived");
    expect(session.lastError).toBeUndefined();
    expect(session.bgJob).toBeUndefined();
    expect(session.archivedAt).toBe(5);
  });
});

describe("the corridor form of what the hook stopped", () => {
  it("names the equivalent corridor command", () => {
    expect(corridorHint("git push -u origin claude/chat-ticket-labels-bug-8c6c68")).toBe("push by the corridor form: `git push -u origin HEAD:claude/chat-ticket-labels-bug-8c6c68`");
    expect(corridorHint("git push origin fix-9298")).toContain("HEAD:fix/fix-9298");
    expect(corridorHint("git push -u origin main")).toBeNull();
    expect(corridorHint("git push -u origin HEAD:fix/x")).toBeNull();
    expect(corridorHint("GH_TOKEN=x gh pr create --fill")).toBe("no environment-variable prefixes: run `gh pr create --fill` as it is");
    expect(corridorHint("npm run ci:local | tail -5")).toContain("no pipes");
    expect(corridorHint("pnpm pr:merge -- --pr 9 --merge")).toContain("npm run pr:merge -- --pr 9 --merge");
    expect(corridorHint("npm run pr:merge -- --pr 9")).toContain("--publish");
  });

  it("puts it in the owner's report, from the hook's denial or a push the session is blocked on", () => {
    const ledger = new CcSessionLedger({ path: null, now: () => 0 });
    const session = ledger.create({ id: "s", ownerBotId: "b", ownerThreadId: "t", title: "#9311", repo: "/r", permissionMode: "auto" });
    session.blockedOn = "OK to push? `git push -u origin claude/chat-ticket-labels-bug-8c6c68` was denied by the hook";
    const hook = JSON.stringify({ session: "s", outcome: "deny", input: JSON.stringify({ command: "CI=1 npm run ci:local" }) });
    const report = ccReportForOwner(session, { hookDecision: hook });
    expect(report).toContain("The corridor lets this through");
    expect(report).toContain("HEAD:claude/chat-ticket-labels-bug-8c6c68");
    expect(report).toContain("run `npm run ci:local` as it is");
    expect(ccReportForOwner({ ...session, blockedOn: undefined }, {})).not.toContain("corridor");
  });
});

describe("what cc_session_list says about a session", () => {
  it("says a message that never arrived, and that a CLI session is not in the app; an archived one carries no old error", () => {
    const path = join(dir, "ledger.json");
    const ledger = new CcSessionLedger({ path, now: () => 0 });
    const app = ledger.create({ id: "a", ownerBotId: "b", ownerThreadId: "t", title: "#9298", repo: "/r", permissionMode: "auto", surface: "app", desktop: { marker: "M", turnsSeen: 0, lastSend: { at: Date.parse("2026-09-30T22:58:00Z"), confirmed: false } } });
    expect(ccSessionLine(app)).toContain("last message did NOT arrive (19:58)");
    const cli = ledger.create({ id: "c", ownerBotId: "b", ownerThreadId: "t", title: "lote", repo: "/r", permissionMode: "auto" });
    expect(ccSessionLine(cli)).toContain("CLI: not visible in the Claude app");
    cli.status = "archived";
    cli.lastError = "could not archive it";
    ledger.save();
    expect(new CcSessionLedger({ path, now: () => 0 }).get("c")?.lastError).toBeUndefined();
  });
});
