// What the report missed on 16/10 (lot AA), each against the field truth of that week:
//  - 14 "failed releases" in 7 days were 14 TRIES of 6 commits, and 6 of them stopped on
//    the snapshot's drift, a full disk or with no verdict at all: the commits that failed
//    on the change were 4, out of 22 that ran (18 released);
//  - a release run by hand (release-production.sh, 342236931 on 15/10) logs to its own
//    file, which the report never read: a delivery missing, its PRs credited to the next;
//  - a lote merges the work of PRs that are then closed WITHOUT merge (#9604 took 12):
//    those PRs never counted as delivered, and while open they counted as "waiting for
//    the gate" (17 instead of 5).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { presetPeriod } from "../shared/productivity.ts";
import { MANUAL_RELEASE_LOG, manualReleaseLogs, ProductivityCollector } from "./productivity-collector.ts";
import { batchMembers, citedNumbers, isBatch, parsePr, type GhRunner } from "./productivity-github.ts";
import { batchOrigins, buildProductivityReport, buildTimeline, countedRun } from "./productivity-report.ts";
import { infrastructureCause } from "./release-watch.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { brt, HOUR, pull, run, scenario, sha } from "./testing/productivity-fixture.ts";

const week = (base: ReturnType<typeof scenario>) => buildProductivityReport({ ...base, granularity: "day", period: presetPeriod("day", 7, base.now) });

describe("a failure is a commit judged on its change (lot AA)", () => {
  it("drift of the sealed snapshot, git unreadable, full disk, queue and nothing-to-publish are the machine's, not the commit's", () => {
    for (const cause of [
      "Integridade do snapshot Git: drift detectado em preflight read-only do deploy",
      "Integridade do snapshot Git: falha operacional ao consultar fetch/refs/heads/main",
      "Integridade do snapshot Git: nao foi possivel persistir journal da transacao",
      "fatal: write error: No space left on device",
      "Release snapshot changed before sealed validation: origin/main is no longer 7ccd26970",
      "tempo de espera na fila esgotou (ADMISSION_TIMEOUT)",
      "Release de producao sem alvo de runtime: nenhum Worker, web ou widget seria publicado",
    ]) expect(infrastructureCause(cause), cause).toBe(true);
    for (const cause of ["Local CI failed at tests", "Bloqueado: validacao reprovada (CRITICAL/ERROR). Corrija os issues antes de publicar", "Reconciliacao tenant 0634 falhou em nuria-ws", "flags FALHOU", "Tenant nuria-ws- reprovou inspecao da migration 0608"]) {
      expect(infrastructureCause(cause), cause).toBe(false);
    }
  });

  it("a run that ran with no verdict, or stopped on the machine, is aborted; a verdict on the change stays a failure", () => {
    expect(countedRun(run("p1", "failed", "2026-10-01T05:00:00")).outcome).toBe("aborted");
    expect(countedRun(run("p1", "failed", "2026-10-01T05:00:00", { cause: "Integridade do snapshot Git: drift detectado em preflight read-only do deploy" })).outcome).toBe("aborted");
    expect(countedRun(run("p1", "failed", "2026-10-01T05:00:00", { cause: "Local CI failed at tests" })).outcome).toBe("failed");
    expect(countedRun({ ...run("p1", "failed", "2026-10-01T05:00:00"), origin: "github-deployment" }).outcome).toBe("failed");
  });

  it("the 15/10 commit: five tries — two on the change, three on the machine — are ONE failed commit; a retried commit that released is a success", () => {
    const base = scenario();
    const tries = [
      run("q1", "failed", "2026-10-01T05:00:00", { cause: "Release abortado" }), // after a full disk: no verdict
      run("q2", "failed", "2026-10-01T05:10:00", { cause: "Local CI failed at smart-deploy" }),
      run("q3", "failed", "2026-10-01T05:20:00", { cause: "Bloqueado: validacao reprovada (CRITICAL/ERROR). Corrija os issues antes de publicar" }),
      run("q4", "failed", "2026-10-01T05:30:00", { interrupted: true }), // killed (exit 143)
      run("q5", "failed", "2026-10-01T05:40:00", { cause: "Integridade do snapshot Git: drift detectado em preflight read-only do deploy" }),
      // a commit that failed once and then went out
      run("r1", "failed", "2026-10-01T07:00:00", { sha: sha("c"), cause: "Local CI failed at tests" }),
    ].map((each, index) => ({ ...each, key: `${each.key}:${index}`, sha: each.sha === sha("r") ? sha("c") : each.sha }));
    const report = week({ ...base, runs: [...base.runs.filter((each) => !each.key.startsWith("x")), ...tries] });
    // q (one commit, two verdicts), and c released after its failure: one failed commit
    expect(report.kpis).toMatchObject({ failedReleases: 1, failedAttempts: 3, abortedReleases: 4, deliveries: 3, releaseSuccessRate: 3 / 4 });
    expect(report.releases.filter((row) => row.outcome === "failed").map((row) => row.sha[0])).toEqual(["c", "q"]);
  });
});

describe("lotes: the PRs a lote took are delivered (lot AA)", () => {
  const github = () => {
    const base = scenario();
    const g = base.github;
    // lote #30 merged before release c (10:00), citing #31 and #32 (closed without merge after it), #33 (still open),
    // #34 (closed BEFORE the lote: abandoned, not taken), #2 (a carrier) and issue #102
    const lote = pull(30, "2026-10-01T07:00:00", { title: "chore(lote): fila de produto", head: "chore/lote-b-15-10", batch: [31, 32, 33, 34, 2, 102] });
    const closed = (number: number, at: string) => pull(number, "2026-09-30T12:00:00", { mergedAt: null, mergeSha: null, state: "CLOSED", closedAt: brt(at), refs: number === 31 ? [102] : [] });
    g.prs["30"] = lote;
    g.prs["31"] = closed(31, "2026-10-01T09:00:00");
    g.prs["32"] = closed(32, "2026-10-01T09:00:00");
    g.prs["34"] = closed(34, "2026-09-30T13:00:00");
    g.prs["33"] = pull(33, "2026-09-30T12:00:00", { mergedAt: null, mergeSha: null, state: "OPEN", closedAt: null });
    g.compares[`${sha("b")}...${sha("c")}`] = [...g.compares[`${sha("b")}...${sha("c")}`]!, "m30"];
    g.openPrs.push({ number: 33, title: "absorvida pelo lote", createdAt: brt("2026-09-30T12:00:00"), draft: false, base: "main", headSha: "h", gate: "missing", gateAt: null });
    return base;
  };

  it("recognises a lote, not \"ações em lote\" nor a carrier, and keeps what it cites", () => {
    expect(isBatch({ title: "fix(lote): Lote B — #9409 #9432", head: "lote/b-planilha" })).toBe(true);
    expect(isBatch({ title: "chore(lote): fila de produto, cache e billing (Refs #9596)", head: "chore/lote-b-15-10" })).toBe(true);
    expect(isBatch({ title: "chore(release): lote 24/09 — 7 PRs (#9168 #9171)", head: "release/lote-2026-09-24" })).toBe(true);
    expect(isBatch({ title: "fix(ui): restaurar ações em lote em Contatos e Empresas (Refs #9558)", head: "fix/bulk-actions-9558" })).toBe(false);
    expect(isBatch({ title: "chore(release): carrier lote-b-9604", head: "chore/release-carrier-lote-b-9604" })).toBe(false);
    expect(citedNumbers("Refs #9027 #9604", 9604)).toEqual([9027]);
    // what it took: the title, the table's first cell, the "**PR #N" headings — not a PR it left out
    const body = "Refs #9027 #9595\n\n| PR de origem | Head |\n| --- | --- |\n| #9570 | e0c5d6094 |\n| 2 | #9597 | Refs #9358 |\n**PR #9409 — L110 — CSAT.** Refs #9358\n- #9575/#9576 ficam na etapa de scripts do corredor.\nNo formato do Lote Foco (#9506).";
    expect(batchMembers("chore(lote): fila (Refs #9596)", body, 9604)).toEqual([9596, 9570, 9597, 9409]);
    const node = { number: 9604, title: "chore(lote): fila de produto", body, headRefName: "chore/lote-b-15-10", state: "MERGED", mergedAt: "2026-10-16T00:45:26Z", baseRefName: "main" };
    expect(parsePr(node)!.batch).toEqual([9570, 9597, 9409]);
    expect(parsePr({ ...node, title: "fix: x", headRefName: "fix/x" })!.batch).toBeUndefined();
  });

  it("its closed-without-merge PRs reach production with the lote, merged when the lote merged; the lote itself is the vehicle", () => {
    const base = github();
    expect([...batchOrigins(base.github).keys()].sort()).toEqual([31, 32]);
    const timeline = buildTimeline(base);
    const c = timeline.releases.find((release) => release.sha === sha("c"))!;
    expect(c.prs.map((pr) => pr.number)).toEqual([3, 6, 7, 30, 31, 32]);
    expect(timeline.vehicles.has(30)).toBe(true);
    const report = buildProductivityReport({ ...base, granularity: "month", period: { from: brt("2026-10-01T00:00:00"), to: brt("2026-11-01T00:00:00") } });
    // 3, 6, 7 + the lote's 31 and 32 (the lote #30 is not counted twice)
    expect(report.kpis.deliveredPrs).toBe(5);
    expect(report.kpis.batchedPrs).toBe(2);
    // merge → production of 31/32 runs from the lote's merge (07:00) to the release (10:00), never from 1970
    expect(report.kpis.leadMergeToProd.p90).toBeLessThanOrEqual(3 * HOUR);
    const row = report.releases.find((each) => each.sha === sha("c"))!;
    expect(row.prs.find((pr) => pr.number === 31)).toMatchObject({ viaBatch: 30 });
    expect(row.prs.find((pr) => pr.number === 30)).toMatchObject({ batch: true });
  });

  it("an open PR a merged lote already took is not waiting for the gate", () => {
    const report = week(github());
    expect(report.backlog.prsAwaitingGateList.map((pr) => pr.number)).toEqual([20]);
  });
});

describe("a release run by hand logs to its own file (lot AA)", () => {
  const temp = mkdtempSync(join(tmpdir(), "omb-manual-release-"));
  afterAll(() => removeTempDir(temp));
  const hand = "c".repeat(40);
  const watcher = "d".repeat(40);

  it("names the hand-run logs, not the watcher's, the err log or the CI's", () => {
    for (const name of ["9580-production-20261015T0355.log", "production-release-9017.out.log"]) expect(MANUAL_RELEASE_LOG.test(name), name).toBe(true);
    for (const name of ["production-release.out.log", "production-release.err.log", "production-release-9017.err.log", "9580-ci-full-20261015T0256.log", "production-release.out.log.1.gz"]) expect(MANUAL_RELEASE_LOG.test(name), name).toBe(false);
  });

  it("its release counts: a delivery the watcher's log does not have", async () => {
    const dir = join(temp, "logs");
    mkdirSync(dir, { recursive: true });
    const block = (sha40: string, pid: number, data: string) => [
      `ADMISSION_INTENT kind=release label=release:production:${sha40} pid=${pid}`,
      `**Data:** ${data} | **Branch:**  | **Commit:** ${sha40.slice(0, 9)} | **Duracao:** 300s`,
      "[OK] Concluido! (900s)",
      `Certification tag nuria-production-deployed advanced to ${sha40}`,
      `ADMISSION_RELEASED kind=release pid=${pid}`,
    ].join("\n");
    writeFileSync(join(dir, "production-release.out.log"), `${block(watcher, 2, "2026-10-01T15:00:00Z")}\n`);
    writeFileSync(join(dir, "9580-production-20261001T0355.log"), `NURIA_9580_PRODUCTION_START=2026-10-01T03:55:15Z\n${block(hand, 1, "2026-10-01T05:01:40Z")}\nNURIA_9580_PRODUCTION_EXIT=0\n`);
    writeFileSync(join(dir, "9580-ci-full-20261001T0222.log"), `${block("e".repeat(40), 3, "2026-10-01T02:00:00Z")}\n`);
    expect(manualReleaseLogs(dir).map((path) => path.split("/").at(-1))).toEqual(["9580-production-20261001T0355.log"]);
    const quiet: GhRunner = async () => { throw new Error("offline"); };
    const collector = new ProductivityCollector({
      dataDir: join(temp, "data"), gh: quiet, now: () => brt("2026-10-02T12:00:00"),
      logs: { gz: join(dir, "production-release.out.log.1.gz"), out: join(dir, "production-release.out.log"), dir },
      ownerPending: () => ({ open: [], resolved: [] }), botNames: () => new Map(), usage: () => [], digests: () => [], oldestDigestAt: () => null, usageFrom: () => null,
    });
    await collector.refreshLogs();
    const released = collector.releaseRuns().filter((each) => each.outcome === "released").map((each) => each.sha[0]).sort();
    expect(released).toEqual(["c", "d"]);
  });
});
