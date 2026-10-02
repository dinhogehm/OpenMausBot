import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CcSessionLedger, ccProcAlive, processStartSync, survivorStep, hotfixWithReleaseScripts, cliSurfaceRefusal, clientIssue, appStalledReason, recentAppFailure, type CcSession, corridorForSend, corridorVersionOf, issueTitle, titleOpensWithIssue, ccSessionLine, ccHeldQueueReport, repoCorridor, repoPackageManager, repoScripts, useRepoScripts, ccReportForOwner, ccStallReport, corridorHint, ccTurnArgs, lastHookBlock, lastHookDecision, parseCcStartInput, parseCcStream, slugify } from "./cc-sessions.ts";

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

  it("follows a turn whose claude outlived the restart, and marks interrupted the one whose claude died (R9-resilience RS-PID)", () => {
    const first = ledger();
    const alive = first.create({ ...base, id: "aaaaaaaa-0000-4000-8000-000000000001" });
    const dead = first.create({ ...base, id: "bbbbbbbb-0000-4000-8000-000000000002" });
    const unknown = first.create({ ...base, id: "cccccccc-0000-4000-8000-000000000003" });
    for (const session of [alive, dead, unknown]) first.markRunning(session);
    first.setProc(alive, { pid: 4242, lstart: "Thu Oct  1 21:00:00 2026\n" });
    first.setProc(dead, { pid: 4343, lstart: "Thu Oct  1 21:00:00 2026" });
    // the pid 4343 is alive but started later: another program, not this claude
    const ps = new Map([[4242, "Thu Oct  1 21:00:00 2026"], [4343, "Thu Oct  1 21:30:00 2026"]]);
    const reloaded = new CcSessionLedger({ path: join(dir, "cc.json"), now: () => 99, procAlive: (proc) => ps.get(proc.pid) === proc.lstart });
    expect(reloaded.survivedOnLoad.map((session) => session.id)).toEqual([alive.id]);
    expect(reloaded.get(alive.id)).toMatchObject({ status: "running", survivedRestartAt: 99, proc: { pid: 4242, lstart: "Thu Oct  1 21:00:00 2026" } });
    expect(reloaded.interruptedOnLoad.map((session) => session.id)).toEqual([dead.id, unknown.id]);
    expect(reloaded.get(dead.id)).toMatchObject({ status: "failed", interruptedAt: 99, failedAt: 99, lastError: expect.stringContaining("interrupted: the server restarted") });
    expect(reloaded.get(dead.id)!.lastError).toContain("its claude (PID 4343) did not survive");
    expect(reloaded.get(dead.id)!.proc).toBeUndefined();
    expect(reloaded.get(unknown.id)!.lastError).not.toContain("PID");
    // the survivor's turn ends like any other: nothing left of the restart on it
    const survivor = reloaded.get(alive.id)!;
    reloaded.finishTurn(survivor, { ok: true, report: "PR #1 aberta", costUsd: 0 });
    expect(survivor).toMatchObject({ status: "idle", lastReport: "PR #1 aberta" });
    expect(survivor.proc).toBeUndefined();
    expect(survivor.survivedRestartAt).toBeUndefined();
    // a ledger without a way to check processes (tests, older callers) fails them as before
    first.markRunning(first.get(alive.id)!);
    expect(ledger().interruptedOnLoad.map((session) => session.id)).toContain(alive.id);
    // the real check: this test process is alive with its own start time; a made-up one is not
    expect(ccProcAlive({ pid: process.pid, lstart: processStartSync(process.pid)! })).toBe(true);
    expect(ccProcAlive({ pid: process.pid, lstart: "Mon Jan  1 00:00:00 1990" })).toBe(false);
    expect(ccProcAlive({ pid: 0, lstart: "x" })).toBe(false);
  });

  it("says the titles of a ledger saved before the no-\"#\" rule the owner's way (e47cf077, INSP-H r1 #11)", () => {
    const first = ledger();
    const live = first.create({ ...base, id: "eeeeeeee-0000-4000-8000-0000000000e5", title: "#9058 Chat entra com aviso no Widget" });
    const old = first.create({ ...base, id: "ffffffff-0000-4000-8000-0000000000f6", title: "#9237 webauthn" });
    first.setStatus(old, "archived");
    first.save();
    const reloaded = ledger();
    expect(reloaded.get(live.id)!.title).toBe("9058 Chat entra com aviso no Widget");
    // an archived one is history: left as it was
    expect(reloaded.get(old.id)!.title).toBe("#9237 webauthn");
  });

  it("follows a survivor within the turn limit, cuts it past it, closes it once gone (INSP-H r1 #10)", () => {
    const turnStart = { lastActivityAt: 1_000 };
    expect(survivorStep(turnStart, true, 1_000 + 90 * 60_000, 90 * 60_000)).toBe("follow");
    expect(survivorStep(turnStart, true, 1_000 + 90 * 60_000 + 1, 90 * 60_000)).toBe("limit");
    expect(survivorStep(turnStart, false, 1_000 + 999 * 60_000, 90 * 60_000)).toBe("gone");
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
    expect(ccReportForOwner(app)).toContain("terminou o turno 0 BLOQUEADA — precisa de: approve the push");
    expect(ccReportForOwner({ ...app, blockedOn: undefined, status: "failed", lastError: undefined } as typeof app)).toMatch(/^A sessão Claude Code ".*" \(22222222-.*\) parou com um problema: erro desconhecido/);
    expect(ccReportForOwner({ ...app, blockedOn: undefined } as typeof app).split("\n")[0]).not.toMatch(/session|finished|stopped|BLOCKED/);
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

  // e47cf077 on 01/10 (redacted): an issue of a client (Atendimento sheet,
  // row 97), started headless with a policy for a reason (R9-dispatch R9-3)
  const CLIENT = { corridor: "x", title: "9058 Chat entra com aviso no Widget", brief: "Issue do cliente (planilha Atendimento, linha 97): o chat entra com aviso no Widget. Corrija e abra a PR." };
  const SHIPPING = { corridor: "x", title: "9286 Merge e publicação", brief: "merge e carrier" };
  const POLICY = "Esteira 24/7 gerida pelo Chief; sessões em terminal não travam no app e o relatório volta para a conversa da esteira.";

  it("decides a headless session by the app's state the server knows, never by the words of cli_reason (INSP-H r1 #6)", () => {
    // the app available, no failure seen: refused, whatever is said — policies with failure words under a negation included
    for (const reason of [
      POLICY,
      "Sessões no terminal nunca falham por tela bloqueada nem por 409",
      "CLI é mais rápido e não dá timeout",
      "Em CLI não há crash do app nem 409",
      "",
    ]) {
      const decided = cliSurfaceRefusal({ ...SHIPPING, reason, app: "available" });
      expect("refusal" in decided && decided.refusal, reason).toContain("não houve falha no app nas últimas 2 h");
    }
    expect(cliSurfaceRefusal({ ...CLIENT, reason: POLICY, app: "available" })).toMatchObject({ refusal: expect.stringContaining("é uma issue de cliente") });
    // a failure the server saw: allowed, recorded as the server knows it
    expect(cliSurfaceRefusal({ ...SHIPPING, app: "available", appFailure: "a mensagem digitada na sessão \"9326 gate\" não chegou (21:02)" })).toEqual({ onRecord: "falha recente no app: a mensagem digitada na sessão \"9326 gate\" não chegou (21:02)" });
    // an option the app does not apply is no reason: e47cf077's brief with permission_mode "auto" (the CLI's default) is refused (INSP-H r2 #1)
    expect(cliSurfaceRefusal({ ...CLIENT, app: "available", reason: "O app Claude não suporta permission_mode auto" })).toMatchObject({ refusal: expect.stringContaining("é uma issue de cliente") });
    // the app unavailable NOW (Mac locked, queue stuck): the CLI runs, with the server's reason (INSP-H r2 #2)
    expect(cliSurfaceRefusal({ ...CLIENT, app: "unavailable", appReason: "Mac bloqueado há 20 min: o app não abre sessão" })).toEqual({ onRecord: "Mac bloqueado há 20 min: o app não abre sessão" });
    // "O app está fechado agora" / blocked: the server knows it, no words needed
    expect(cliSurfaceRefusal({ ...CLIENT, app: "unavailable" })).toEqual({ onRecord: expect.stringContaining("não abre sessão neste repositório") });
    expect(cliSurfaceRefusal({ ...CLIENT, app: "blocked", reason: POLICY })).toEqual({ onRecord: "o app Claude está reaproveitando worktrees (409 de pasta reaproveitada)" });
    // internal chores run headless
    expect(cliSurfaceRefusal({ corridor: "x", title: "limpar worktrees", brief: "liste as pastas antigas", app: "available" })).toEqual({ onRecord: "tarefa interna" });
    expect(cliSurfaceRefusal({ ...SHIPPING, corridor: "", app: "available", reason: "lote interno" })).toEqual({ onRecord: "lote interno" });
  });

  it("knows a client's issue from who brought it, not from the word \"cliente\" (INSP-H r1 #6, real briefs redacted)", () => {
    expect(clientIssue(`${CLIENT.title}\n${CLIENT.brief}`)).toBe(true);
    expect(clientIssue("Relato do Matheus (30/09): o e-mail que o cliente informou no chat não foi gravado.")).toBe(true);
    expect(clientIssue("Quem pediu foi o Pedro, pelo atendimento.")).toBe(true);
    expect(clientIssue("Contexto: https://chat.google.com/room/AAQA4TXnzJ4/x")).toBe(true);
    // 9298 F4-0 (publishing; the client is told by the Monitor), the OMB rename, a technical "client"
    expect(clientIssue("9298 F4-0 publicar e fechar ciclo\n4) Não avise o cliente: o Monitor Chat Atendimento avisa o Pedro no fio [x].")).toBe(false);
    expect(clientIssue("OpenMausBot cc_session_rename\nExemplo: \"9311 Chat no ticket mostra Agente e Cliente\" virou \"Chat ticket agent/client labels bug\".")).toBe(false);
    expect(clientIssue("Troque o client HTTP do gateway; o erro é do lado do cliente.")).toBe(false);
    expect(clientIssue("Corrija o retry do queryClient em 503 no inbox.")).toBe(false);
  });

  it("does not let real clients' issues pass as internal (INSP-H r2 #3, real briefs redacted)", () => {
    // 8891 PIPERUN round 2
    expect(clientIssue("8891 503 PIPERUN rodada 2\nIssue: https://github.com/o/r/issues/8891 (P1, cliente PIPERUN no ar). Está FECHADA; NÃO reabra nem comente.")).toBe(true);
    // 9052 (P1 of a client: the reopening time)
    expect(clientIssue("9052 Tempo de reabertura configurável\nIssue: https://github.com/o/r/issues/9052 (P1, decisão do Osvaldo em 01/10). Permitir configurar o tempo de reabertura do atendimento (por cliente/tenant). Mensagem do cliente recebida depois do prazo abre um novo atendimento.")).toBe(true);
    // 9307 "a resposta do cliente reabriu…"
    expect(clientIssue("9307 Atendimento reaberto\nIssue #9307: a resposta do cliente reabriu o atendimento antigo ATD-202609-0762 em vez de cair no ativo.")).toBe(true);
    expect(clientIssue("O cliente Roberto não consegue trocar de plano.")).toBe(true);
    expect(clientIssue("o mesmo cliente entrou na fila e abriu o ATD-202609-0825")).toBe(true);
    // still not a client's: an order about clients, the OMB rename example
    expect(clientIssue("9298 F4-0 publicar e fechar ciclo\n4) Não avise o cliente: o Monitor Chat Atendimento avisa o Pedro no fio [x].\nP1 vai antes no carrier.")).toBe(false);
    expect(clientIssue("8891 inbox se recupera\nNão comente com o cliente. Mesmo erro 2 vezes: pare.")).toBe(false);
    expect(clientIssue("OpenMausBot cc_session_rename\nExemplo: \"9311 Chat no ticket mostra Agente e Cliente\" virou \"Chat ticket agent/client labels bug\".")).toBe(false);
  });

  it("knows the app opens nothing now: the Mac locked, or a create stuck in the queue for 15 min (INSP-H r2 #2)", () => {
    const now = Date.parse("2026-10-02T03:10:00-03:00");
    const creating = (since: number) => ({ id: "c", ownerBotId: "b", ownerThreadId: "t", title: "9058 Chat entra com aviso no Widget", repo: "/p", worktree: "w", permissionMode: "auto", status: "running", createdAt: since, lastActivityAt: since, turns: 0, costUsd: 0, queued: [], surface: "app", desktop: { marker: "m", turnsSeen: 0, pending: { kind: "create", text: "x", since, attempts: 0 } } }) as unknown as CcSession;
    expect(appStalledReason([], "/p", null, now)).toBeNull();
    // locked for a moment is not the app unavailable; 15 min and more is (INSP-H r3 #2)
    expect(appStalledReason([], "/p", now - 2 * 60_000, now)).toBeNull();
    expect(appStalledReason([], "/p", now - 16 * 60_000, now)).toBe("Mac bloqueado há 16 min: o app não abre sessão");
    expect(appStalledReason([creating(now - 10 * 60_000)], "/p", null, now)).toBeNull();
    // a P1 at night: its create waits 20 min for an unlocked Mac, the screen is locked
    expect(appStalledReason([creating(now - 20 * 60_000)], "/p", now - 3 * 3_600_000, now)).toBe("Mac bloqueado há 180 min: o app não abre sessão");
    expect(appStalledReason([creating(now - 20 * 60_000)], "/p", null, now)).toBe("o app não abre sessão há 20 min (a abertura de \"9058 Chat entra com aviso no Widget\" está parada na fila)");
    expect(appStalledReason([creating(now - 20 * 60_000)], "/other", null, now)).toBeNull();
    // with it, the client's issue runs in the CLI, recorded with that reason
    const reason = appStalledReason([creating(now - 20 * 60_000)], "/p", now - 3 * 3_600_000, now);
    expect(cliSurfaceRefusal({ ...CLIENT, app: "unavailable", appReason: reason })).toEqual({ onRecord: "Mac bloqueado há 180 min: o app não abre sessão" });
  });

  it("finds the app failures the server itself saw in the last 2 h", () => {
    const now = Date.parse("2026-10-01T21:10:00-03:00");
    const app = (id: string, desktop: Partial<CcSession["desktop"]>, extra: Partial<CcSession> = {}) => ({ id, ownerBotId: "b", ownerThreadId: "t", title: `9326 ${id}`, repo: "/p", worktree: "w", permissionMode: "auto", status: "idle", createdAt: 0, lastActivityAt: 0, turns: 1, costUsd: 0, queued: [], surface: "app", desktop: { marker: "m", turnsSeen: 0, ...desktop }, ...extra }) as CcSession;
    expect(recentAppFailure([app("ok", { lastSend: { at: now - 60_000, confirmed: true } })], "/p", now)).toBeNull();
    expect(recentAppFailure([app("old", { lastSend: { at: now - 3 * 3_600_000, confirmed: false } })], "/p", now)).toBeNull();
    expect(recentAppFailure([app("sent", { lastSend: { at: now - 8 * 60_000, confirmed: false } })], "/p", now)).toBe("a mensagem digitada na sessão \"9326 sent\" não chegou (21:02)");
    expect(recentAppFailure([app("open", { pending: { kind: "create", text: "x", since: now - 600_000, attempts: 3, triedAt: now - 300_000, lastReason: "the screen is locked" } })], "/p", now)).toBe("abrir \"9326 open\" no app falhou 3× (the screen is locked)");
    expect(recentAppFailure([app("sent", { lastSend: { at: now - 8 * 60_000, confirmed: false } })], "/other", now)).toBeNull();
  });

  it("warns when a batch puts a hotfix with a release-script change", () => {
    expect(hotfixWithReleaseScripts("Carrier: hotfix #9278 + #9289 (muda scripts/local-release.sh)")).toContain("scripts/local-release.sh");
    expect(hotfixWithReleaseScripts("Inclua o P1 #9278 junto com a #9290 (watch-production-release.sh)")).toContain("watch-production-release.sh");
    expect(hotfixWithReleaseScripts("hotfix #9278 sozinho no carrier")).toBeNull();
    expect(hotfixWithReleaseScripts("#9290 muda scripts/local-release.sh")).toBeNull();
  });

  it("opens a title with its issue numbers without \"#\", the owner's rule (R9-dispatch R9-4)", () => {
    expect(issueTitle("#9052 tempo de reabertura")).toBe("9052 tempo de reabertura");
    expect(issueTitle("9052 tempo de reabertura")).toBe("9052 tempo de reabertura");
    expect(issueTitle("#9286 #9303 9289 #9290 Merge do lote")).toBe("9286 9303 9289 9290 Merge do lote");
    expect(issueTitle("  #9058: Chat entra com aviso no Widget")).toBe("9058: Chat entra com aviso no Widget");
    // a number further in is the bot's own text: left as it is
    expect(issueTitle("9295 rebase sobre a #9330")).toBe("9295 rebase sobre a #9330");
    expect(issueTitle("Lote 2026 de PRs")).toBe("Lote 2026 de PRs");
    // glued by their "#" (INSP-H r1 #11); an 8-digit number is not two issues
    expect(issueTitle("#9058#9059 Chat e Widget")).toBe("9058 9059 Chat e Widget");
    expect(issueTitle("20261001 relatório")).toBe("20261001 relatório");
    expect(titleOpensWithIssue("9311 Chat labels", "9311")).toBe(true);
    expect(titleOpensWithIssue("#9311 Chat labels", "9311")).toBe(true);
    expect(titleOpensWithIssue("93110 outra", "9311")).toBe(false);
    expect(titleOpensWithIssue("Chat #9311", "9311")).toBe(false);
  });

  it("starts a session titled \"9052 …\" when the bot writes \"#9052 …\"", () => {
    const input = parseCcStartInput({ title: "#9052 tempo de reabertura", brief: "x", repo: "/r" }, () => true);
    expect(input.ok && input.title).toBe("9052 tempo de reabertura");
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
    // blocked in the app (its own summary), and a draft left in its field
    expect(ccSessionLine(app, { blocked: "aprovar o push da branch" })).toContain("BLOCKED in the app — needs: aprovar o push da branch");
    expect(ccSessionLine(app)).not.toContain("BLOCKED");
    app.desktop!.draftSeen = { text: "pode reescrever o corpo da PR", at: 0 };
    expect(ccSessionLine(app)).toContain('text nobody sent sits in its field ("pode reescrever o corpo da PR")');
    const cli = ledger.create({ id: "c", ownerBotId: "b", ownerThreadId: "t", title: "lote", repo: "/r", permissionMode: "auto" });
    expect(ccSessionLine(cli)).toContain("CLI: not visible in the Claude app");
    cli.status = "archived";
    cli.lastError = "could not archive it";
    ledger.save();
    expect(new CcSessionLedger({ path, now: () => 0 }).get("c")?.lastError).toBeUndefined();
  });
});
