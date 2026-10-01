import { describe, expect, it } from "vitest";
import { ARCHIVED_OUTSIDE_MAX_TRIES, ARCHIVED_OUTSIDE_PER_PASS, ARCHIVED_OUTSIDE_RETRY_MS, checkArchivedOutside, notAPullRequest, type ArchivedOutsideDeps, type OwnerPendingItem, type PrState } from "./archived-outside.ts";
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
function fakeGithub(over: Partial<{ down: (session: string) => boolean; byIssue: Record<string, number[]>; byBranch: Record<string, number[]>; states: Record<number, PrState>; branches: Record<string, string> }> = {}) {
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
      return "issue" in by ? (over.byIssue ?? { 9319: [9328] })[by.issue] ?? [] : (over.byBranch ?? {})[by.branch] ?? [];
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
