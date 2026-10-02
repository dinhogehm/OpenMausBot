import { describe, expect, it } from "vitest";
import { archiveBlockers, claimedPrNumbers, DELIVERY_CHECK_MS, IDLE_WITH_PR_MS, idleWithOpenPrs, deliveryReport, mergeStatePt, prOwnership, sessionBranches, githubSlug, newDeliveryCache, parseLsRemoteTag, prLinks, prsOfSession, productionTime, watchProductionDelivery, type CcDelivery, type DeliveryDeps } from "./prod-delivery.ts";

const SLUG = "dinhogehm/nuria-platform";
const TAG = "c".repeat(40);
const MERGE = "m".repeat(40);

/** The session's worktree: checked out on a local branch, pushed to fix/9311-login. */
const WORKTREE = "/repo/.claude/worktrees/9311-fix-login-111111";
const BRANCH = "fix/9311-login";
const HEAD = "e".repeat(40);
/** `git -C <worktree> rev-parse …` as git answers it, or null for other calls. */
const worktreeGit = (repo: string, args: string[]): string | null => {
  if (repo !== WORKTREE || args[0] !== "rev-parse") return null;
  if (args.includes("@{u}")) return `origin/${BRANCH}\n`;
  if (args.includes("--abbrev-ref")) return "worktree-9311-fix-login-111111\n";
  return `${HEAD}\n`;
};

function fakeDeps(over: Partial<{ state: string; compare: string; tag: string | null; head: string }> = {}) {
  const calls: string[][] = [];
  const reports: string[] = [];
  const chips: string[] = [];
  let now = Date.UTC(2026, 8, 30, 19, 0);
  const deps: DeliveryDeps = {
    now: () => now,
    gh: async (args) => {
      calls.push(args);
      if (args[0] === "pr") return JSON.stringify({ state: over.state ?? "MERGED", mergeCommit: { oid: MERGE }, headRefName: over.head ?? BRANCH, headRefOid: "f".repeat(40) });
      if (args[1]!.includes("/compare/")) return `${over.compare ?? "ahead"}\n`;
      if (args[1]!.includes("/commits/")) return "2026-09-30T19:40:00Z\n";
      throw new Error("unexpected");
    },
    git: async (repo, args) => {
      if (args[0] === "remote") return `git@github.com:${SLUG}.git\n`;
      const own = worktreeGit(repo, args);
      if (own !== null) return own;
      calls.push(["git", ...args]);
      const tag = over.tag === undefined ? TAG : over.tag;
      return tag ? `abc123\trefs/tags/nuria-production-deployed\n${tag}\trefs/tags/nuria-production-deployed^{}\n` : "";
    },
    report: (_session, text) => { reports.push(text); },
    chip: (_session, text) => { chips.push(text); },
    save: () => {},
  };
  return { deps, calls, reports, chips, advance: (ms: number) => { now += ms; } };
}

const session = (): { id: string; title: string; repo: string; cwd: string; status: string; lastReport: string; delivery?: CcDelivery; claimedPrs?: number[] } => ({ id: "s1", title: "9311 fix login", repo: "/repo", cwd: WORKTREE, status: "idle", lastReport: `Done. PR: https://github.com/${SLUG}/pull/9400 (depends on https://github.com/other/repo/pull/5)` });

describe("delivery in production", () => {
  it("reads PR links of the session's own repository, origin slugs and the peeled tag", () => {
    expect(prLinks(session().lastReport, SLUG)).toEqual([{ url: `https://github.com/${SLUG}/pull/9400`, number: 9400 }]);
    expect(githubSlug("https://github.com/dinhogehm/nuria-platform.git")).toBe(SLUG);
    expect(githubSlug("git@github.com:dinhogehm/nuria-platform.git")).toBe(SLUG);
    expect(githubSlug("git@gitlab.com:a/b.git")).toBeNull();
    // every form git accepts, including nuria-platform's port-443 ssh origin
    expect(githubSlug("ssh://git@ssh.github.com:443/dinhogehm/nuria-platform.git")).toBe(SLUG);
    expect(githubSlug("ssh://git@github.com/dinhogehm/nuria-platform")).toBe(SLUG);
    expect(githubSlug("https://github.com/dinhogehm/nuria-platform")).toBe(SLUG);
    expect(githubSlug("https://github.com/dinhogehm/nuria-platform/")).toBe(SLUG);
    expect(githubSlug("git@github.com:dinhogehm/nuria-platform")).toBe(SLUG);
    expect(githubSlug("https://notgithub.com/a/b.git")).toBeNull();
    expect(prLinks("Merged PR #9315 and pull request #9316; issue #9295 stays open", SLUG).map((link) => link.number)).toEqual([9315, 9316]);
    // lists after one "PRs" (R8-followup F5), and still no bare issue numbers
    expect(prLinks("Mergeei as PRs #9329 e #9330; a issue #9326 segue aberta", SLUG).map((link) => link.number)).toEqual([9329, 9330]);
    expect(prLinks("PRs #9315, #9316 and #9317 are in the carrier", SLUG).map((link) => link.number)).toEqual([9315, 9316, 9317]);
    // an issue next to a PR is not a PR (INSP-F F5-a): a list only after the plural, never "/"
    const numbers = (text: string) => prLinks(text, SLUG).map((link) => link.number);
    expect(numbers("PR #9328, #9319 (issue) segue")).toEqual([9328]);
    expect(numbers("PR #9328 / #9319 é a issue")).toEqual([9328]);
    expect(numbers("PR #9328/#9319 com gate verde")).toEqual([9328]);
    // an issue named elsewhere in the sentence never cuts the list (INSP-F r2 #1):
    // the consumers ask GitHub, and a number that is no PR is dropped there
    expect(numbers("PRs #9329 e #9330 fecham a issue #9326")).toEqual([9329, 9330]);
    expect(numbers("PRs #9329 e #9330 (issue #9326) no carrier")).toEqual([9329, 9330]);
    expect(numbers("As PRs #9329 e #9330 resolvem as issues")).toEqual([9329, 9330]);
    expect(numbers("PRs #9328 e #9319: a primeira é a correção... a segunda issue fica aberta")).toEqual([9328, 9319]);
    expect(numbers("a PR #9328 & #9319")).toEqual([9328]);
    expect(numbers("PRs #9328 e #9319 (issue) seguem")).toEqual([9328]);
    expect(numbers("Abri a PR #9328 para a issue #9319")).toEqual([9328]);
    expect(numbers("PRs #9329 e #9330")).toEqual([9329, 9330]);
    expect(numbers("PRs #9329 & #9330 mergeadas. A issue #9326 segue aberta")).toEqual([9329, 9330]);
    // what a session may have left open: its OWN open PRs (by branch, or handed over),
    // never one its report only names, nor a candidate not yet checked (R9-followup #2)
    const prs = { "9330": { number: 9330, url: "", state: "open", owned: "branch" }, "9329": { number: 9329, url: "", state: "merged", owned: "branch" }, "9328": { number: 9328, url: "", state: "open" } };
    expect(prsOfSession({ delivery: { slug: SLUG, prs } as unknown as CcDelivery }).sort()).toEqual([9330]);
    expect(prsOfSession({ delivery: { slug: SLUG, prs } as unknown as CcDelivery, claimedPrs: [9341] }).sort()).toEqual([9330, 9341]);
    expect(prsOfSession({})).toEqual([]);
    expect(parseLsRemoteTag(`aaa\trefs/tags/x\nbbb\trefs/tags/x^{}\n`, "x")).toBe("bbb");
    expect(parseLsRemoteTag(`aaa\trefs/tags/x\n`, "x")).toBe("aaa");
    expect(parseLsRemoteTag("", "x")).toBeNull();
    expect(productionTime("2026-09-30T19:40:00Z")).toBe("30/09 16:40");
  });

  it("reports once, with the time, when the production tag contains the merge", async () => {
    const { deps, reports, chips, calls, advance } = fakeDeps();
    const cache = newDeliveryCache();
    const s = session();
    await watchProductionDelivery([s], deps, cache);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("em produção desde 30/09 16:40");
    expect(reports[0]).toContain("cc_session_archive");
    expect(reports[0]).toContain("No ID, no notice");
    expect(chips[0]).toContain("PR #9400");
    const before = calls.length;
    advance(DELIVERY_CHECK_MS);
    await watchProductionDelivery([s], deps, cache);
    expect(reports).toHaveLength(1);
    expect(calls.length).toBe(before);
  });

  it("keeps waiting while the tag is behind the merge, and re-reads it only every 10 min", async () => {
    const waiting = fakeDeps({ compare: "diverged" });
    const cache = newDeliveryCache();
    const s = session();
    await watchProductionDelivery([s], waiting.deps, cache);
    expect(waiting.reports).toEqual([]);
    const lsRemotes = () => waiting.calls.filter((call) => call[0] === "git").length;
    expect(lsRemotes()).toBe(1);
    waiting.advance(60_000);
    await watchProductionDelivery([s], waiting.deps, cache);
    expect(lsRemotes()).toBe(1);
    expect(waiting.calls.filter((call) => call[0] === "api").length).toBe(1);
  });

  it("stops at closed PRs, repositories without the tag and archived sessions", async () => {
    const closed = fakeDeps({ state: "CLOSED" });
    const s = session();
    await watchProductionDelivery([s], closed.deps, newDeliveryCache());
    expect(s.delivery?.prs["9400"]?.state).toBe("closed");
    expect(closed.reports).toEqual([]);
    const untagged = fakeDeps({ tag: null });
    await watchProductionDelivery([session()], untagged.deps, newDeliveryCache());
    expect(untagged.calls.filter((call) => call[0] === "pr")).toEqual([]);
    const archived = fakeDeps();
    await watchProductionDelivery([{ ...session(), status: "archived" }], archived.deps, newDeliveryCache());
    expect(archived.calls).toEqual([]);
    expect(deliveryReport({ id: "s", title: "t" }, [{ url: "u", number: 1, mergeSha: MERGE, productionSince: "30/09 16:40" }], TAG)).toContain("PR #1 (u)");
  });
});

describe("archiving before delivery", () => {
  it("holds a session whose PR is open or whose merge is not in production, and says why", async () => {
    const open = fakeDeps({ state: "OPEN" });
    expect((await archiveBlockers(session(), open.deps)).blockers).toEqual(["a PR #9400 ainda está aberta"]);
    const behind = fakeDeps({ compare: "diverged" });
    expect((await archiveBlockers(session(), behind.deps)).blockers).toEqual(["a PR #9400 foi mergeada mas ainda não está em nuria-production-deployed"]);
    const shipped = fakeDeps({ compare: "ahead" });
    expect(await archiveBlockers(session(), shipped.deps)).toEqual({ blockers: [], unknown: [] });
    const closed = fakeDeps({ state: "CLOSED" });
    expect((await archiveBlockers(session(), closed.deps)).blockers).toEqual([]);
    const noTag = fakeDeps({ tag: null });
    expect((await archiveBlockers(session(), noTag.deps)).blockers).toEqual([]);
    const offline = fakeDeps();
    offline.deps.gh = async () => { throw new Error("gh: not logged in"); };
    expect(await archiveBlockers(session(), offline.deps)).toEqual({ blockers: [], unknown: ["PR #9400"] });
  });

  /** gh as execFile hands it over: exit 1, the GraphQL message on stderr and in the message. */
  const notPr = (number: number) => Object.assign(new Error(`Command failed: gh pr view ${number} --repo ${SLUG} --json state,mergeCommit\nGraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)\n`), { code: 1, stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)\n` });
  const listReport = { ...session(), lastReport: "PRs #9329 e #9330 fecham a issue #9326. A #9329 já foi mergeada." };
  const ghByNumber = (states: Record<number, string>, heads: Record<number, string> = {}) => async (args: string[]) => {
    if (args[0] === "pr") {
      const number = Number(args[2]);
      if (!(number in states)) throw notPr(number);
      return JSON.stringify({ state: states[number], mergeCommit: states[number] === "MERGED" ? { oid: MERGE } : null, headRefName: heads[number] ?? BRANCH, headRefOid: "f".repeat(40) });
    }
    if (args[1]!.includes("/compare/")) return "ahead\n";
    throw new Error("unexpected");
  };

  it("holds a session whose report lists an open PR next to the issue it closes, and an issue is no blocker nor unknown (INSP-F r2 #1)", async () => {
    const { deps } = fakeDeps();
    deps.gh = ghByNumber({ 9329: "MERGED", 9330: "OPEN" });
    expect(await archiveBlockers(listReport, deps)).toEqual({ blockers: ["a PR #9330 ainda está aberta"], unknown: [] });
    // the issue is not even a candidate: "#9326" is not in a PR list
    deps.gh = ghByNumber({ 9329: "MERGED" });
    const issueListed = { ...session(), lastReport: "PRs #9329 e #9326 (a #9326 é a issue, não PR)" };
    expect(await archiveBlockers(issueListed, deps)).toEqual({ blockers: [], unknown: [] });
  });

  it("drops a reported number that is no PR for good while following deliveries (INSP-F r2 #1)", async () => {
    const f = fakeDeps();
    f.deps.gh = ghByNumber({ 9329: "OPEN" });
    const s = { ...session(), lastReport: "PRs #9329 e #9326 fecham a issue" };
    await watchProductionDelivery([s], f.deps, newDeliveryCache());
    expect(Object.keys(s.delivery!.prs)).toEqual(["9329"]);
    expect(s.delivery!.notPrs).toEqual([9326]);
    // never asked again, never back among its PRs
    f.advance(DELIVERY_CHECK_MS + 1);
    const asked: string[] = [];
    const gh = f.deps.gh;
    f.deps.gh = async (args) => { asked.push(args.join(" ")); return gh(args); };
    await watchProductionDelivery([s], f.deps, newDeliveryCache());
    expect(asked.some((call) => call.includes("view 9326"))).toBe(false);
    expect(Object.keys(s.delivery!.prs)).toEqual(["9329"]);
  });
});

describe("a repository whose GitHub address cannot be read", () => {
  it("is reported as not checked when archiving, never as nothing holding it", async () => {
    const { deps } = fakeDeps();
    deps.git = async () => "/local/path/not/github\n";
    expect(await archiveBlockers(session(), deps)).toEqual({ blockers: [], unknown: ["o repositório (não consegui ler o endereço do GitHub)"] });
  });
});

// R9-followup #2, the real case redacted: the session of #9052 (its PR #9332 on
// its own branch) reported "A trava que limitaria as tentativas … está na PR
// #9328, que ainda não está em main" — and #9328, another session's, became
// its PR: its archiving held, its "em produção" in the wrong conversation, a
// false live owner.
describe("whose PR it is", () => {
  const REPORT_9052 = `PR #9332 aberta com o gate verde. A trava que limitaria as tentativas do watcher está na PR #9328, que ainda não está em main.`;
  const s9052 = () => ({ ...session(), id: "35787b0f", title: "9052 tempo de reabertura", lastReport: REPORT_9052 });
  const heads = { 9332: BRANCH, 9328: "fix/9319-reconciler-contract" };

  it("does not make a PR the session only cites its own, and never asks again", async () => {
    const f = fakeDeps();
    f.deps.gh = async (args) => {
      if (args[0] === "pr") {
        const number = Number(args[2]);
        return JSON.stringify({ state: "OPEN", mergeCommit: null, headRefName: heads[number as 9332 | 9328], headRefOid: "f".repeat(40) });
      }
      throw new Error("unexpected");
    };
    const s = s9052();
    await watchProductionDelivery([s], f.deps, newDeliveryCache());
    expect(Object.values(s.delivery!.prs)).toEqual([expect.objectContaining({ number: 9332, owned: "branch", state: "open" })]);
    expect(s.delivery!.notOwned).toEqual([9328]);
    expect(prsOfSession(s)).toEqual([9332]);
    // a later pass does not bring #9328 back, nor ask GitHub about it
    f.advance(DELIVERY_CHECK_MS + 1);
    const asked: string[] = [];
    const gh = f.deps.gh;
    f.deps.gh = async (args) => { asked.push(args.join(" ")); return gh(args); };
    await watchProductionDelivery([s], f.deps, newDeliveryCache());
    expect(asked.some((call) => call.includes("view 9328"))).toBe(false);
    // archiving is held by its own open PR only
    expect(await archiveBlockers(s, f.deps)).toEqual({ blockers: ["a PR #9332 ainda está aberta"], unknown: [] });
  });

  it("archives a session whose only cited PR is another's, and says so when its worktree cannot be read", async () => {
    const f = fakeDeps({ state: "OPEN", head: "fix/9319-reconciler-contract" });
    const cites = { ...s9052(), lastReport: "Nada meu aberto. A trava está na PR #9328, que ainda não está em main." };
    expect(await archiveBlockers(cites, f.deps)).toEqual({ blockers: [], unknown: [] });
    // no worktree to read: not counted as its own, and not silently "nothing holds it"
    expect(await archiveBlockers({ ...cites, cwd: undefined as unknown as string }, f.deps)).toEqual({ blockers: [], unknown: ["PR #9328 (sem a worktree da sessão para conferir se é dela)"] });
    // pushed with `git push -u origin HEAD:fix/…`: the branch it pushed to is its own
    const pushed = fakeDeps({ state: "OPEN" });
    expect((await archiveBlockers({ ...session(), lastReport: "PR #9400 aberta." }, pushed.deps)).blockers).toEqual(["a PR #9400 ainda está aberta"]);
  });

  it("makes a PR the session's when it was handed over, or its head is the session's HEAD", async () => {
    expect(claimedPrNumbers("Assuma a PR #9328 e rode o gate.")).toEqual([9328]);
    expect(claimedPrNumbers("assumir a #9341 agora")).toEqual([9341]);
    expect(claimedPrNumbers("A PR #9314 é sua a partir de agora; fique com a PR #9330 também")).toEqual(expect.arrayContaining([9314, 9330]));
    expect(claimedPrNumbers("A trava está na PR #9328, que ainda não está em main.")).toEqual([]);
    expect(claimedPrNumbers("depende da #9328")).toEqual([]);
    const branches = { names: [BRANCH], head: HEAD };
    expect(prOwnership({ number: 1, headRefName: BRANCH }, branches)).toBe("branch");
    expect(prOwnership({ number: 1, headRefName: "other", headRefOid: HEAD }, branches)).toBe("branch");
    expect(prOwnership({ number: 1, headRefName: "other", headRefOid: "0".repeat(40) }, branches)).toBeNull();
    expect(prOwnership({ number: 1, headRefName: "other" }, null, [1])).toBe("explicit");
    expect(prOwnership({ number: 1, headRefName: BRANCH }, null)).toBeNull();
    // handed over: its own without asking GitHub whose branch it is
    const f = fakeDeps({ state: "OPEN", head: "fix/9319-reconciler-contract" });
    const s = { ...s9052(), claimedPrs: [9328] };
    await watchProductionDelivery([s], f.deps, newDeliveryCache());
    expect(s.delivery!.prs["9328"]).toMatchObject({ owned: "explicit", state: "open" });
    expect(prsOfSession(s)).toEqual(expect.arrayContaining([9328]));
  });

  it("reads the branches of the session's worktree: its checkout and where it pushed, never main", async () => {
    const git: DeliveryDeps["git"] = async (repo, args) => worktreeGit(repo, args) ?? (() => { throw new Error("no"); })();
    expect(await sessionBranches({ cwd: WORKTREE }, git)).toEqual({ names: ["worktree-9311-fix-login-111111", BRANCH], head: HEAD });
    expect(await sessionBranches({}, git)).toBeNull();
    expect(await sessionBranches({ cwd: "/gone" }, git)).toBeNull();
    const onMain: DeliveryDeps["git"] = async (_repo, args) => (args.includes("@{u}") ? "origin/main\n" : args.includes("--abbrev-ref") ? "main\n" : `${HEAD}\n`);
    expect(await sessionBranches({ cwd: WORKTREE }, onMain)).toEqual({ names: [], head: HEAD });
  });
});

describe("GitHub's merge state on a chip", () => {
  it("is said in pt-BR, and \"UNKNOWN\" is not shown (R9-followup #5)", () => {
    expect(mergeStatePt("UNKNOWN")).toBe("");
    expect(mergeStatePt(undefined)).toBe("");
    expect(mergeStatePt("BLOCKED")).toBe("bloqueada pelas regras do repositório");
    expect(mergeStatePt("behind")).toBe("atrás da main");
    expect(mergeStatePt("DIRTY")).toBe("com conflito");
    expect(mergeStatePt("SOMETHING_NEW")).toBe("");
  });
});

describe("a session idle with its PR still open", () => {
  it("is picked after hours idle with a PR of its own not merged or closed, once a day", () => {
    const now = 100 * 3_600_000;
    const make = (id: string, extra: object) => ({ id, title: id, repo: "/r", status: "idle", lastActivityAt: now - IDLE_WITH_PR_MS - 1, delivery: { slug: SLUG, prs: { "9314": { url: "u", number: 9314, state: "open" as const, owned: "branch" as const } } }, ...extra });
    const waiting = make("c01aae76", {});
    const merged = make("m", { delivery: { slug: SLUG, prs: { "9315": { url: "u", number: 9315, state: "merged" as const, owned: "branch" as const } } } });
    const busy = make("b", { status: "running" });
    const fresh = make("f", { lastActivityAt: now - 60_000 });
    const told = make("t", { idleReportedAt: now - 3_600_000 });
    // a PR its report only named (never checked as its own) does not count
    const cited = make("c", { delivery: { slug: SLUG, prs: { "9328": { url: "u", number: 9328, state: "open" as const } } } });
    expect(idleWithOpenPrs([waiting, merged, busy, fresh, told, cited], now)).toEqual([{ session: waiting, prs: [9314] }]);
  });
});
