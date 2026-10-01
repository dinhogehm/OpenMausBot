import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIVED_OUTSIDE_MAX_TRIES, ARCHIVED_OUTSIDE_PER_PASS, ARCHIVED_OUTSIDE_RETRY_MS, checkArchivedOutside, githubLookups, notAPullRequest, prOfIssue, type ArchivedOutsideDeps, type FoundPr, type OwnerPendingItem, type PrState } from "./archived-outside.ts";
import type { CcSession } from "./cc-sessions.ts";

const SLUG = "owner/platform";

/** The shape of the real case (ffd6ee1a on 01/10, redacted): an app session
 * archived in the app by someone, with no delivered PRs, its issue 9319 on
 * record, a worktree named after another branch, and a last report that
 * names its PR only as "o ci:local da #9328" — never "PR #9328" — next to
 * an issue (#9323). GitHub: #9328 is OPEN and found by searching 9319. */
const ffd6ee1a = (): CcSession => ({
  id: "ffd6ee1a-0000-4000-8000-000000000000",
  ownerBotId: "chief-0000",
  ownerThreadId: "thread-owner",
  title: "9319 contrato do reconciliador",
  repo: "/Users/owner/Projetos/platform",
  permissionMode: "auto",
  surface: "app",
  desktop: { marker: "OMBTEST001", turnsSeen: 2, issue: "9319", localId: "local_00000000-0000-4000-8000-000000000001", cliSessionId: "00000000-0000-4000-8000-000000000002" },
  worktree: "fix-9298-other-branch-572720",
  cwd: "/Users/owner/Projetos/platform/.claude/worktrees/fix-9298-other-branch-572720",
  status: "archived",
  createdAt: 1790859184804,
  lastActivityAt: 1790860366365,
  turns: 2,
  costUsd: 0,
  queued: [],
  lastReport: "Nada a fazer do seu lado: a #9323 já estava fechada (\"Obsoleta: substituída pela #9328\").\n\nO `ci:local` da #9328 continua esperando o release de produção terminar. Depois rodo o gate e o merge, e paro esperando o seu sinal.",
  delivery: { prs: {} },
  archivedAt: 1790860366365,
  archivedOutsideAt: 1790860366365,
}) as CcSession;

/** gh as it answers: `gh pr view 9319` fails with "Could not resolve to a PullRequest". */
const PR_9328: FoundPr = { number: 9328, title: "Contrato do reconciliador (#9319)", headRefName: "fix/9319-reconciler-contract" };

function fakeGithub(over: Partial<{ down: (session: string) => boolean; byIssue: Record<string, FoundPr[]>; byBranch: Record<string, number[]>; states: Record<number, PrState>; branches: Record<string, string> }> = {}) {
  let now = 1790861000000;
  const calls: string[] = [];
  const chips: Array<{ id: string; text: string; ok: boolean }> = [];
  const reports: Array<{ id: string; text: string }> = [];
  const pending: Array<{ id: string; item: OwnerPendingItem }> = [];
  let current = "";
  const down = () => over.down?.(current) ?? false;
  const deps: ArchivedOutsideDeps = {
    now: () => now,
    save: () => {},
    slugOf: async (session) => { current = session.id; return SLUG; },
    prState: async (number) => {
      calls.push(`view ${number}`);
      if (down()) throw new Error("gh: connect: network is unreachable");
      const state = (over.states ?? { 9328: "OPEN" })[number];
      if (!state || state === "NOT_PR") throw Object.assign(new Error(`Command failed: gh pr view ${number}`), { stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)` });
      return state;
    },
    openPrs: async (by) => {
      calls.push("issue" in by ? `list issue ${by.issue}` : `list head ${by.branch}`);
      if (down()) throw new Error("gh: connect: network is unreachable");
      return "issue" in by ? (over.byIssue ?? { 9319: [PR_9328] })[by.issue] ?? [] : ((over.byBranch ?? {})[by.branch] ?? []).map((number) => ({ number }));
    },
    branchOf: async (cwd) => (over.branches ?? {})[cwd] ?? null,
    chip: (session, text, ok) => { chips.push({ id: session.id, text, ok }); },
    report: (session, text) => { reports.push({ id: session.id, text }); },
    ownerPending: (session, item) => { pending.push({ id: session.id, item }); },
  };
  return { deps, calls, chips, reports, pending, advance: (ms: number) => { now += ms; } };
}

describe("a session archived in the app by someone (INSP-F F1)", () => {
  it("finds #9328 of ffd6ee1a by its issue, though its report never says \"PR #9328\"", async () => {
    const gh = fakeGithub();
    const session = ffd6ee1a();
    await checkArchivedOutside([session], gh.deps);
    expect(gh.calls).toEqual(["list issue 9319"]);
    expect(session.archivedOutsideCheckedAt).toBeDefined();
    expect(gh.chips).toEqual([{ id: session.id, text: "PR #9328 ficou sem sessão: https://github.com/owner/platform/pull/9328", ok: false }]);
    expect(gh.reports).toHaveLength(1);
    expect(gh.reports[0]!.text).toContain("PR #9328 ficou sem sessão");
    expect(gh.reports[0]!.text).toContain("https://github.com/owner/platform/pull/9328");
    expect(gh.pending).toEqual([{ id: session.id, item: { title: expect.stringContaining("PR #9328 ficou sem sessão"), link: "https://github.com/owner/platform/pull/9328", key: `cc-orphan-pr:${session.id}:9328` } }]);
    // once per session
    await checkArchivedOutside([session], gh.deps);
    expect(gh.calls).toHaveLength(1);
  });

  it("finds an open PR by the branch of its worktree too", async () => {
    const gh = fakeGithub({ byIssue: {}, branches: { [ffd6ee1a().cwd!]: "fix/9319-reconciler-contract" }, byBranch: { "fix/9319-reconciler-contract": [9328] } });
    const session = ffd6ee1a();
    await checkArchivedOutside([session], gh.deps);
    expect(gh.calls).toEqual(["list issue 9319", "list head fix/9319-reconciler-contract"]);
    expect(gh.chips.map((chip) => chip.text)).toEqual(["PR #9328 ficou sem sessão: https://github.com/owner/platform/pull/9328"]);
  });

  it("drops a number that is not a PR for good (\"Could not resolve to a PullRequest\") and settles on the real one", async () => {
    const gh = fakeGithub({ byIssue: {} });
    const session = { ...ffd6ee1a(), lastReport: "PR #9319 (issue) e a PR #9328 seguem", delivery: { prs: { 9319: { number: 9319, url: "", state: "open" as const } } } };
    await checkArchivedOutside([session], gh.deps);
    expect(gh.calls).toEqual(["list issue 9319", "view 9319", "view 9328"]);
    expect(session.archivedOutsideCheckedAt).toBeDefined();
    expect(session.archivedOutsideTries).toBeUndefined();
    expect(gh.chips.map((chip) => chip.text)).toEqual(["PR #9328 ficou sem sessão: https://github.com/owner/platform/pull/9328"]);
    expect(notAPullRequest(Object.assign(new Error("Command failed: gh pr view 9319"), { stderr: "GraphQL: Could not resolve to a PullRequest with the number of 9319." }))).toBe(true);
    expect(notAPullRequest(new Error("gh: connect: network is unreachable"))).toBe(false);
  });

  it("does not let sessions GitHub cannot answer for hold back the others, and gives up on them after a few tries", async () => {
    const stuck = ["a", "b", "c"].map((id, i) => ({ ...ffd6ee1a(), id, archivedOutsideAt: 1790860000000 + i }));
    const fourth = { ...ffd6ee1a(), id: "d", archivedOutsideAt: 1790860000009 };
    const gh = fakeGithub({ down: (id) => id !== "d" });
    const all = [...stuck, fourth];
    expect(ARCHIVED_OUTSIDE_PER_PASS).toBe(3);
    await checkArchivedOutside(all, gh.deps); // a, b, c: gh down
    expect(stuck.every((session) => session.archivedOutsideTries === 1 && session.archivedOutsideCheckedAt === undefined)).toBe(true);
    await checkArchivedOutside(all, gh.deps); // the next pass reaches d
    expect(fourth.archivedOutsideCheckedAt).toBeDefined();
    expect(gh.chips.filter((chip) => chip.id === "d").map((chip) => chip.text)).toEqual(["PR #9328 ficou sem sessão: https://github.com/owner/platform/pull/9328"]);
    // a, b and c wait out a growing pause, and are settled after the last try
    const before = gh.calls.length;
    await checkArchivedOutside(all, gh.deps);
    expect(gh.calls.length).toBe(before);
    for (let tries = 1; tries < ARCHIVED_OUTSIDE_MAX_TRIES; tries += 1) {
      gh.advance(ARCHIVED_OUTSIDE_RETRY_MS * tries);
      await checkArchivedOutside(all, gh.deps);
    }
    expect(stuck.every((session) => session.archivedOutsideTries === ARCHIVED_OUTSIDE_MAX_TRIES && session.archivedOutsideCheckedAt !== undefined)).toBe(true);
    expect(gh.chips.filter((chip) => chip.id === "a").map((chip) => chip.text)).toEqual(["não consegui conferir no GitHub: as PRs da issue/branch"]);
    expect(gh.reports.find((report) => report.id === "a")!.text).toContain(`GitHub did not answer after ${ARCHIVED_OUTSIDE_MAX_TRIES} tries`);
  });

  it("says nothing when no PR of it is open", async () => {
    const gh = fakeGithub({ byIssue: {} });
    const session = ffd6ee1a();
    await checkArchivedOutside([session], gh.deps);
    expect(session.archivedOutsideCheckedAt).toBeDefined();
    expect(gh.chips).toEqual([]);
    expect(gh.reports).toEqual([]);
  });
});

/** The three real cases of 01/10 the r2 inspection ran `gh pr list --search`
 * on (redacted titles and ids): the search finds PRs that only cite the
 * issue, and PRs another session still alive carries on. */
describe("PRs the issue search finds that are not left without a session (INSP-F r2 #2)", () => {
  // #9332 is the PR of #9052: its title and branch name 9052; its body cites 9307
  const PR_9332: FoundPr = { number: 9332, title: "Exportação do relatório (#9052)", headRefName: "feat/9052-report-export" };
  const PR_9330: FoundPr = { number: 9330, title: "Gate do reconciliador (#9326)", headRefName: "fix/9326-reconciler-gate" };
  const archivedFor = (id: string, issue: string): CcSession => ({ ...ffd6ee1a(), id, title: `${issue} sessão anterior`, desktop: { ...ffd6ee1a().desktop!, issue }, lastReport: "Parei aqui." });
  const live = (id: string, issue: string, extra: Partial<CcSession> = {}): CcSession => ({ ...ffd6ee1a(), id, title: `${issue} sessão viva`, status: "idle", desktop: { ...ffd6ee1a().desktop!, issue }, lastReport: "", archivedOutsideAt: undefined, archivedAt: undefined, ...extra }) as CcSession;

  it("issue 9307 → #9332 (a PR of #9052 that only cites 9307): no warning", async () => {
    const gh = fakeGithub({ byIssue: { 9307: [PR_9332] } });
    const session = archivedFor("b7df2f12-0000-4000-8000-000000000000", "9307");
    await checkArchivedOutside([session], gh.deps);
    expect(session.archivedOutsideCheckedAt).toBeDefined();
    expect(gh.chips).toEqual([]);
    expect(gh.reports).toEqual([]);
    expect(gh.pending).toEqual([]);
  });

  it("issue 9052 → #9332, carried by the live session that reports it: \"segue com a sessão\", no warning", async () => {
    const gh = fakeGithub({ byIssue: { 9052: [PR_9332] } });
    const archived = archivedFor("93001904-0000-4000-8000-000000000000", "9052");
    const carrier = live("35787b0f-0000-4000-8000-000000000000", "9099", { lastReport: "PR #9332 com o gate verde, esperando o merge." });
    await checkArchivedOutside([archived, carrier], gh.deps);
    expect(gh.chips).toEqual([{ id: archived.id, text: 'a PR #9332 segue com a sessão "9099 sessão viva" (35787b0f)', ok: true }]);
    expect(gh.chips.some((chip) => chip.text.includes("ficou sem sessão"))).toBe(false);
    expect(gh.reports).toEqual([]);
    expect(gh.pending).toEqual([]);
  });

  it("issue 9326 → #9330, with a live session on the same issue: \"segue com a sessão\", no warning", async () => {
    const gh = fakeGithub({ byIssue: { 9326: [PR_9330] } });
    const archived = archivedFor("36300f35-0000-4000-8000-000000000000", "9326");
    const carrier = live("29da943f-0000-4000-8000-000000000000", "9326", { title: "9326 gate da PR 9330", status: "running" });
    await checkArchivedOutside([archived, carrier], gh.deps);
    expect(gh.chips.map((chip) => chip.text)).toEqual(['a PR #9330 segue com a sessão "9326 gate da PR 9330" (29da943f)']);
    expect(gh.reports).toEqual([]);
    expect(gh.pending).toEqual([]);
    // the same PR with that session archived too: left without a session
    const alone = fakeGithub({ byIssue: { 9326: [PR_9330] } });
    const again = archivedFor("36300f35-0000-4000-8000-000000000001", "9326");
    await checkArchivedOutside([again, { ...carrier, status: "archived" }], alone.deps);
    expect(alone.chips.map((chip) => chip.text)).toEqual(["PR #9330 ficou sem sessão: https://github.com/owner/platform/pull/9330"]);
  });

  it("a PR carried only by a stopped (or failed) session is left without a session (INSP-F r3 #2)", async () => {
    for (const status of ["stopped", "failed"] as const) {
      const gh = fakeGithub({ byIssue: { 9326: [PR_9330] } });
      const archived = archivedFor(`36300f35-0000-4000-8000-00000000000${status.length}`, "9326");
      const halted = live("29da943f-0000-4000-8000-000000000000", "9326", { title: "9326 gate da PR 9330", status, lastReport: "PR #9330 esperando o gate" });
      await checkArchivedOutside([archived, halted], gh.deps);
      expect(gh.chips).toEqual([{ id: archived.id, text: "PR #9330 ficou sem sessão: https://github.com/owner/platform/pull/9330", ok: false }]);
      expect(gh.pending).toHaveLength(1);
    }
  });

  it("a running CLI session on the same issue, known only by the number in its title, carries the PR on (INSP-F r3 #2)", async () => {
    const gh = fakeGithub({ byIssue: { 9326: [PR_9330] } });
    const archived = archivedFor("36300f35-0000-4000-8000-000000000009", "9326");
    const cli = { ...live("c11e0000-0000-4000-8000-000000000000", "9326", { title: "9326 F4-2 gate", status: "running", surface: "cli" }), desktop: undefined } as CcSession;
    await checkArchivedOutside([archived, cli], gh.deps);
    expect(gh.chips).toEqual([{ id: archived.id, text: 'a PR #9330 segue com a sessão "9326 F4-2 gate" (c11e0000)', ok: true }]);
    expect(gh.reports).toEqual([]);
    expect(gh.pending).toEqual([]);
  });

  it("keeps a searched PR only when its title or branch names the issue", () => {
    expect(prOfIssue(PR_9332, "9307")).toBe(false);
    expect(prOfIssue(PR_9332, "9052")).toBe(true);
    expect(prOfIssue({ number: 9400, title: "Ajuste", headRefName: "fix/9052-x" }, "9052")).toBe(true);
    expect(prOfIssue({ number: 9400, title: "Corrige #90521" }, "9052")).toBe(false);
    expect(prOfIssue({ number: 9052, title: "#9052" }, "9052")).toBe(false);
  });

  it("words a failed session the person archived as such, never as \"sem pedido do OMB\" (INSP-F r2 #4)", async () => {
    const gh = fakeGithub();
    const session = { ...ffd6ee1a(), archivedAfterFailure: true };
    await checkArchivedOutside([session], gh.deps);
    expect(gh.chips.map((chip) => chip.text)).toEqual(["PR #9328 ficou sem sessão: https://github.com/owner/platform/pull/9328"]);
    expect(gh.reports[0]!.text).toContain("foi arquivada no app Claude depois de falhar");
    expect(gh.reports[0]!.text).not.toContain("sem pedido do OMB");
    expect(gh.pending[0]!.item.title).toContain("falhou e foi arquivada no app");
  });
});

describe("the gh adapter over a real execFile (INSP-F r2 #5)", () => {
  it("reads gh's real \"Could not resolve to a PullRequest\" (exit 1, stderr) as not a PR, and other failures as unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-fake-gh-"));
    try {
      const gh = join(dir, "gh");
      // what gh 2.x prints for `gh pr view <issue number>`, and a network failure
      writeFileSync(gh, `#!/bin/sh
if [ "$2" = "list" ]; then echo '[{"number":9328,"title":"Contrato (#9319)","headRefName":"fix/9319-x"},{"bogus":true}]'; exit 0; fi
case "$3" in
  9319) echo "GraphQL: Could not resolve to a PullRequest with the number of 9319. (repository.pullRequest)" >&2; exit 1 ;;
  9328) echo '{"state":"OPEN"}' ;;
  9331) echo '{"state":"DRAFT_UNKNOWN"}' ;;
  *) echo "error connecting to api.github.com" >&2; exit 1 ;;
esac
`);
      chmodSync(gh, 0o755);
      // the server's execCc: execFile, reject with execFile's own error
      const exec = (file: string, args: string[]) => new Promise<string>((resolve, reject) => {
        execFile(file === "gh" ? gh : file, args, { timeout: 30_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
      });
      const lookups = githubLookups(exec);
      expect(await lookups.prState(9319, SLUG)).toBe("NOT_PR");
      expect(await lookups.prState(9328, SLUG)).toBe("OPEN");
      await expect(lookups.prState(7777, SLUG)).rejects.toThrow(/error connecting/);
      // an answer it does not know is not taken for "closed": tried again
      await expect(lookups.prState(9331, SLUG)).rejects.toThrow(/unexpected state/);
      expect(await lookups.openPrs({ issue: "9319" }, SLUG)).toEqual([{ number: 9328, title: "Contrato (#9319)", headRefName: "fix/9319-x" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
