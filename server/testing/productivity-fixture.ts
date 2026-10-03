// A small, fully known history for the productivity report's tests (lot V):
// three releases (one at 23:30 of Sep 30 in São Paulo, already October in
// UTC), a carrier, PRs linked by "Closes" and by branch name, two failed tries
// and a refusal, an open backlog with P0/P1, the open PRs' gate, and the bots'
// turns, durations and "Precisa de você" items. Issue titles carry a client's
// name on purpose: nothing exported may show them.
import type { ReportSyncState } from "../../shared/productivity.ts";
import { emptyGhCache, type GhCache, type GhIssue, type GhPr } from "../productivity-github.ts";
import type { NeedsYouRecord } from "../productivity-local.ts";
import type { ReleaseRun } from "../productivity-release-log.ts";
import type { ReportInputs } from "../productivity-report.ts";

export const brt = (text: string) => Date.parse(`${text}-03:00`);
export const HOUR = 3_600_000;
export const sha = (char: string) => char.repeat(40);
export const CLIENT_NAME = "Acme Transportes";

export function issue(number: number, created: string, extra: Partial<GhIssue> = {}): GhIssue {
  return { number, title: `${CLIENT_NAME} quer ${number}`, createdAt: brt(created), updatedAt: brt(created), closedAt: null, state: "OPEN", stateReason: null, labels: [], ...extra };
}
export function pull(number: number, merged: string, extra: Partial<GhPr> = {}): GhPr {
  return { number, title: `Correção para ${CLIENT_NAME} ${number}`, createdAt: brt(merged) - HOUR, updatedAt: brt(merged), mergedAt: brt(merged), closedAt: brt(merged), state: "MERGED", draft: false, base: "main", head: `feat/x-${number}`, mergeSha: `m${number}`, closes: [], labels: [], ...extra };
}
export function run(key: string, outcome: ReleaseRun["outcome"], ended: string, extra: Partial<ReleaseRun> = {}): ReleaseRun {
  return { key, sha: sha(key[0]!), pid: 1, outcome, startedAt: brt(ended) - HOUR, endedAt: brt(ended), timeSource: "log", ...extra };
}

export const IDLE_SYNC: ReportSyncState = { state: "idle", lastSyncAt: null, lastAttemptAt: null, nextSyncAt: null, error: null, rateLimit: null };

export function fixtureGithub(): GhCache {
  const github: GhCache = emptyGhCache();
  const issues = [
    issue(101, "2026-09-28T09:00:00", { state: "CLOSED", closedAt: brt("2026-09-30T20:05:00"), stateReason: "COMPLETED", labels: ["type:bug", "priority:p1"] }),
    issue(102, "2026-09-30T10:00:00", { state: "CLOSED", closedAt: brt("2026-10-01T08:05:00"), stateReason: "COMPLETED", labels: ["type:improvement", "priority:p2"] }),
    issue(103, "2026-09-29T10:00:00", { state: "CLOSED", closedAt: brt("2026-10-01T09:00:00"), stateReason: "NOT_PLANNED" }),
    issue(104, "2026-09-10T10:00:00", { labels: ["priority:p1"] }),
    issue(105, "2026-09-20T10:00:00", { labels: ["priority:critical"] }),
  ];
  for (const each of issues) github.issues[String(each.number)] = each;
  const prs = [
    pull(1, "2026-09-30T20:00:00", { closes: [101] }),
    pull(2, "2026-09-30T20:30:00", { head: "chore/release-carrier-1" }),
    pull(3, "2026-10-01T08:00:00", { head: "fix/102-melhoria", refs: [102] }), // "Refs #102" in its body
    pull(4, "2026-10-01T12:00:00"), // merged after the last release: not in production yet
    pull(5, "2026-10-01T12:30:00", { base: "develop" }), // not main: not counted
    // an epic's slice: names open issue #104 explicitly and in its branch — still not delivered (open)
    pull(6, "2026-10-01T08:30:00", { head: "perf/104-epico", refs: [104] }),
    // a branch that names #103 (not planned) and nothing else: no reference, nothing delivered
    pull(7, "2026-10-01T08:40:00", { head: "fix/103-tentativa" }),
  ];
  for (const each of prs) github.prs[String(each.number)] = each;
  github.compares[`${sha("a")}...${sha("b")}`] = ["m1", "m2"];
  github.compares[`${sha("b")}...${sha("c")}`] = ["m3", "m6", "m7"];
  github.repoCreatedAt = brt("2026-08-15T00:00:00");
  github.openPrs = [
    { number: 20, title: `Esperando ${CLIENT_NAME}`, createdAt: brt("2026-10-01T09:00:00"), draft: false, base: "main", headSha: "h", gate: "missing", gateAt: null },
    { number: 21, title: "Verde", createdAt: brt("2026-10-01T09:00:00"), draft: false, base: "main", headSha: "h", gate: "success", gateAt: null },
    { number: 22, title: "Rascunho", createdAt: brt("2026-10-01T09:00:00"), draft: true, base: "main", headSha: "h", gate: "missing", gateAt: null },
  ];
  github.tag = { sha: sha("c"), checkedAt: brt("2026-10-02T12:00:00") };
  github.syncedAt = brt("2026-10-02T12:00:00");
  github.prWalk.complete = true;
  github.issueWalk.complete = true;
  return github;
}

export function fixtureRuns(): ReleaseRun[] {
  return [
    run("a1", "released", "2026-09-29T12:00:00"),
    // 02:30Z on Oct 1st: still September here; its post-release check rolled it back
    run("b1", "released", "2026-09-30T23:30:00", { headPr: 2, postRelease: "rolled_back" }),
    run("x1", "failed", "2026-10-01T05:00:00", { cause: `Tenant ${CLIENT_NAME} reprovou a migration`, headPr: 6 }),
    run("x2", "failed", "2026-10-01T06:00:00", { sha: sha("x"), cause: "Local CI failed at tests" }),
    // dropped before running: neither is a failure, neither stops the pipeline
    run("s1", "superseded", "2026-10-01T06:30:00", { timeSource: "neighbor" }),
    run("z1", "aborted", "2026-10-01T06:40:00", { timeSource: "neighbor", cause: "Nao foi possivel inicializar smart-deploy" }),
    run("c1", "released", "2026-10-01T10:00:00", { postRelease: "healthy" }),
    run("d1", "running", "2026-10-02T11:00:00"),
  ];
}

export function fixtureNeedsYou(): NeedsYouRecord[] {
  return [
    { id: "o1", botId: "chief", createdAt: brt("2026-10-01T09:00:00"), resolvedAt: brt("2026-10-01T11:00:00"), resolvedBy: "owner", ownerFirstAnswerAt: brt("2026-10-01T09:30:00") },
    { id: "o2", botId: "chief", createdAt: brt("2026-10-01T10:00:00"), resolvedAt: brt("2026-10-01T12:00:00"), resolvedBy: "owner", ownerFirstAnswerAt: null },
    { id: "o3", botId: "lead", createdAt: brt("2026-10-02T09:00:00"), resolvedAt: null, resolvedBy: null, ownerFirstAnswerAt: null },
  ];
}

export function fixtureUsage(): ReportInputs["usage"] {
  return [
    { at: new Date(brt("2026-10-01T09:00:00")).toISOString(), botId: "chief", botName: "Chief of Staff", input: 1000, output: 100, cachedInput: 800, costUsd: 0.5 },
    { at: new Date(brt("2026-10-01T09:30:00")).toISOString(), botId: "chief", botName: "Chief of Staff", input: 500, output: 50, costUsd: 0.25 },
    { at: new Date(brt("2026-09-30T09:30:00")).toISOString(), botId: "lead", botName: "Lead", input: 10, output: 1, costUsd: null },
  ];
}

export function scenario(): Omit<ReportInputs, "granularity" | "period"> {
  return {
    now: brt("2026-10-02T12:00:00"),
    github: fixtureGithub(),
    runs: fixtureRuns(),
    declines: [{ sha: "xxxxxxxxx", at: brt("2026-10-01T06:10:00"), timeSource: "neighbor" }],
    logCoverage: { from: brt("2026-09-29T00:00:00"), to: brt("2026-10-02T11:00:00") },
    usage: fixtureUsage(),
    digests: [
      { botId: "chief", at: brt("2026-10-01T09:00:00"), durationMs: 30 * 60_000 },
      { botId: "chief", at: brt("2026-10-01T09:30:00"), durationMs: null },
    ],
    needsYou: fixtureNeedsYou(),
    botNames: new Map([["chief", "Chief of Staff"], ["lead", "Lead"]]),
    local: { usageFrom: brt("2026-09-28T00:00:00"), digestsFrom: brt("2026-09-28T00:00:00"), needsYouFrom: brt("2026-10-01T00:00:00") },
    sync: IDLE_SYNC,
  };
}
