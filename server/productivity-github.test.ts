// GitHub for the productivity report (lot V), against a mocked `gh`: pages
// walked newest-updated first and resumed from the cursor, later syncs stopping
// at the watermark, the budget floor, the open PRs' gate, the lightweight tag,
// old deployments and paginated compares. Only reads are ever asked for.
import { describe, expect, it } from "vitest";
import {
  branchIssueNumbers, emptyGhCache, isCarrier, issuePriority, issueType, parseGate, RATE_FLOOR, RateLimited,
  readCompare, readDeployments, readTagSha, syncCompares, syncGithub, type GhRunner, type SyncProgress,
} from "./productivity-github.ts";

const REPO = "dinhogehm/nuria-platform";
const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 8, day, hour)).toISOString();

interface FakeState { calls: string[][]; remaining: number }

function pr(number: number, updatedDay: number, extra: Record<string, unknown> = {}) {
  return {
    number, title: `PR ${number}`, createdAt: at(1), updatedAt: at(updatedDay), mergedAt: at(updatedDay), closedAt: at(updatedDay), state: "MERGED",
    isDraft: false, baseRefName: "main", headRefName: `fix/${number + 1000}-thing`, mergeCommit: { oid: `m${number}` },
    closingIssuesReferences: { nodes: [{ number: number + 1000 }] }, labels: { nodes: [] }, ...extra,
  };
}

/** A fake gh: GraphQL pages served from lists sorted newest-updated first, REST from a map. */
function fakeGh(data: { prs: ReturnType<typeof pr>[]; issues: Array<Record<string, unknown>>; open?: Array<Record<string, unknown>>; rest?: Record<string, unknown> }, state: FakeState, pageSize = 2): GhRunner {
  return async (args) => {
    state.calls.push(args);
    if (args.includes("POST") || args.some((arg) => /^query=.*\bmutation\b/.test(arg))) throw new Error("a write was attempted");
    if (args[0] === "api" && args[1] === "graphql") {
      const query = args.find((arg) => arg.startsWith("query="))!;
      const after = args.find((arg) => arg.startsWith("after="))?.slice(6) ?? null;
      const list = query.includes("states: OPEN") ? data.open ?? [] : query.includes("issues(") ? data.issues : data.prs;
      const start = after ? Number(after) : 0;
      const nodes = list.slice(start, start + pageSize);
      state.remaining -= 1;
      const connection = { pageInfo: { hasNextPage: start + pageSize < list.length, endCursor: String(start + pageSize) }, nodes };
      return JSON.stringify({ data: { repository: query.includes("issues(") ? { issues: connection } : { pullRequests: connection }, rateLimit: { remaining: state.remaining, resetAt: "2026-10-02T20:00:00Z" } } });
    }
    const path = args[1]!;
    if (path === "rate_limit") return JSON.stringify({ resources: { core: { remaining: 4000, reset: 1_790_000_000 } } });
    const answer = data.rest?.[path];
    if (answer === undefined) throw new Error(`HTTP 404: ${path}`);
    return JSON.stringify(answer);
  };
}

const progress = (): SyncProgress => ({ phase: "", pages: 0, rateRemaining: null, rateResetAt: null });
const sortedPrs = (list: ReturnType<typeof pr>[]) => list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

describe("labels and links", () => {
  it("classifies type and priority, mapping the older scale", () => {
    expect(issueType(["type:bug", "priority:p1"])).toBe("bug");
    expect(issueType(["type:hotfix"])).toBe("bug");
    expect(issueType(["type:improvement"])).toBe("improvement");
    expect(issueType(["type:feature"])).toBe("feature");
    expect(issueType(["app:web"])).toBe("other");
    expect(issuePriority(["priority:p0"])).toBe("p0");
    expect(issuePriority(["priority:critical"])).toBe("p0");
    expect(issuePriority(["priority:high"])).toBe("p1");
    expect(issuePriority(["priority:medium"])).toBe("p2");
    expect(issuePriority(["priority:low"])).toBe("p3");
    expect(issuePriority([])).toBe("none");
  });

  it("knows a release carrier and the issue numbers a branch names", () => {
    expect(isCarrier({ head: "chore/release-carrier-9347-sqlite", title: "x" })).toBe(true);
    expect(isCarrier({ head: "fix/9347-script-contracts", title: "x" })).toBe(false);
    expect(branchIssueNumbers("fix/9331-inatividade-encerra-cedo")).toEqual([9331]);
    expect(branchIssueNumbers("claude/helpdesk-rodizio-equipe-9195")).toEqual([9195]);
    expect(branchIssueNumbers("chore/release-carrier-9334-9331-x")).toEqual([9334, 9331]);
    expect(branchIssueNumbers("fix/f4-2-post-release-guard")).toEqual([]);
  });

  it("reads the merge gate on the PR head", () => {
    const node = (state?: string) => ({ commits: { nodes: [{ commit: { oid: "abc", status: state ? { context: { state, createdAt: at(3) } } : null } }] } });
    expect(parseGate(node("SUCCESS")).gate).toBe("success");
    expect(parseGate(node("PENDING")).gate).toBe("pending");
    expect(parseGate(node("FAILURE")).gate).toBe("failure");
    expect(parseGate(node("ERROR")).gate).toBe("failure");
    expect(parseGate(node()).gate).toBe("missing");
    expect(parseGate(node("SUCCESS"))).toMatchObject({ headSha: "abc", gateAt: Date.parse(at(3)) });
  });
});

describe("syncGithub", () => {
  const issues = [{ number: 2001, title: "Issue", createdAt: at(1), updatedAt: at(5), closedAt: at(5), state: "CLOSED", stateReason: "COMPLETED", labels: { nodes: [{ name: "type:bug" }] } }];
  const rest = { [`repos/${REPO}/git/ref/tags/nuria-production-deployed`]: { object: { sha: "tagsha", type: "commit" } }, [`repos/${REPO}/deployments?environment=production&per_page=100&page=1`]: [] };

  it("walks every page the first time, then only what changed since the watermark", async () => {
    const state = { calls: [] as string[][], remaining: 5000 };
    const data = { prs: sortedPrs([pr(1, 2), pr(2, 3), pr(3, 4), pr(4, 5), pr(5, 6)]), issues, rest };
    const cache = emptyGhCache(REPO);
    await syncGithub({ gh: fakeGh(data, state), cache, now: Date.parse(at(7)), progress: progress() });
    expect(Object.keys(cache.prs).sort()).toEqual(["1", "2", "3", "4", "5"]);
    expect(cache.prWalk).toMatchObject({ complete: true, cursor: null, watermark: Date.parse(at(6)) });
    expect(cache.issues["2001"]).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED", labels: ["type:bug"] });
    expect(cache.tag.sha).toBe("tagsha");
    // a PR changes: the next sync reads one page and stops at the watermark
    data.prs = sortedPrs([pr(6, 9, { title: "new" }), pr(1, 2), pr(2, 3), pr(3, 4), pr(4, 5), pr(5, 6)]);
    state.calls = [];
    await syncGithub({ gh: fakeGh(data, state), cache, now: Date.parse(at(10)), progress: progress() });
    const prPages = state.calls.filter((args) => args.some((arg) => arg.startsWith("query=") && arg.includes("pullRequests(first: 100, after: $after, orderBy: { field: UPDATED_AT")));
    expect(prPages.length).toBe(2); // 6,1 then 2,3 (overlap kept under the watermark), not to the bottom
    expect(cache.prs["6"]!.title).toBe("new");
    expect(cache.prWalk.watermark).toBe(Date.parse(at(9)));
  });

  it("resumes a long first pass from its cursor on the next sync", async () => {
    const state = { calls: [] as string[][], remaining: 5000 };
    const data = { prs: sortedPrs([pr(1, 2), pr(2, 3), pr(3, 4), pr(4, 5), pr(5, 6), pr(6, 7)]), issues, rest };
    const cache = emptyGhCache(REPO);
    await syncGithub({ gh: fakeGh(data, state), cache, now: Date.parse(at(8)), progress: progress(), maxPages: 1 });
    expect(cache.prWalk).toMatchObject({ complete: false, cursor: "2" });
    expect(Object.keys(cache.prs)).toHaveLength(2);
    await syncGithub({ gh: fakeGh(data, state), cache, now: Date.parse(at(8)), progress: progress(), maxPages: 1 });
    expect(cache.prWalk.cursor).toBe("4");
    await syncGithub({ gh: fakeGh(data, state), cache, now: Date.parse(at(8)), progress: progress(), maxPages: 1 });
    expect(cache.prWalk).toMatchObject({ complete: true, cursor: null });
    expect(Object.keys(cache.prs)).toHaveLength(6);
  });

  it("stops before the rate limit, keeping the cursor for after the reset", async () => {
    // the first page leaves RATE_FLOOR − 1 points: the walk keeps that page and stops
    const state = { calls: [] as string[][], remaining: RATE_FLOOR };
    const data = { prs: sortedPrs([pr(1, 2), pr(2, 3), pr(3, 4), pr(4, 5), pr(5, 6)]), issues, rest };
    const cache = emptyGhCache(REPO);
    const error = await syncGithub({ gh: fakeGh(data, state), cache, now: Date.parse(at(7)), progress: progress() }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).resetAt).toBe(Date.parse("2026-10-02T20:00:00Z"));
    expect(cache.prWalk).toMatchObject({ complete: false, cursor: "2" });
    expect(Object.keys(cache.prs)).toHaveLength(2);
  });

  it("reads the open PRs with their gate", async () => {
    const state = { calls: [] as string[][], remaining: 5000 };
    const open = [
      { number: 10, title: "Waiting", createdAt: at(1), isDraft: false, baseRefName: "main", commits: { nodes: [{ commit: { oid: "h10", status: null } }] } },
      { number: 11, title: "Green", createdAt: at(2), isDraft: false, baseRefName: "main", commits: { nodes: [{ commit: { oid: "h11", status: { context: { state: "SUCCESS", createdAt: at(3) } } } }] } },
    ];
    const cache = emptyGhCache(REPO);
    await syncGithub({ gh: fakeGh({ prs: [], issues: [], open, rest }, state), cache, now: Date.parse(at(7)), progress: progress() });
    expect(cache.openPrs.map((each) => [each.number, each.gate])).toEqual([[10, "missing"], [11, "success"]]);
  });

  it("never asks GitHub for a write", async () => {
    const state = { calls: [] as string[][], remaining: 5000 };
    const cache = emptyGhCache(REPO);
    await syncGithub({ gh: fakeGh({ prs: sortedPrs([pr(1, 2)]), issues, rest }, state), cache, now: Date.parse(at(7)), progress: progress() });
    for (const args of state.calls) {
      expect(args[0]).toBe("api");
      expect(args).not.toContain("-X");
      expect(args).not.toContain("--method");
      expect(args.join(" ")).not.toMatch(/\bmutation\b/);
    }
  });
});

describe("REST reads", () => {
  it("follows an annotated tag to its commit", async () => {
    const state = { calls: [] as string[][], remaining: 5000 };
    const gh = fakeGh({ prs: [], issues: [], rest: {
      [`repos/${REPO}/git/ref/tags/nuria-production-deployed`]: { object: { sha: "tagobj", type: "tag" } },
      [`repos/${REPO}/git/tags/tagobj`]: { object: { sha: "commitsha" } },
    } }, state);
    expect(await readTagSha(gh, REPO)).toBe("commitsha");
  });

  it("pages a compare until every commit is read", async () => {
    const state = { calls: [] as string[][], remaining: 5000 };
    const commits = Array.from({ length: 230 }, (_, index) => ({ sha: `c${index}` }));
    const rest: Record<string, unknown> = {};
    for (let page = 1; page <= 3; page += 1) rest[`repos/${REPO}/compare/a...b?per_page=100&page=${page}`] = { total_commits: 230, commits: commits.slice((page - 1) * 100, page * 100) };
    const gh = fakeGh({ prs: [], issues: [], rest }, state);
    const shas = await readCompare(gh, REPO, "a", "b");
    expect(shas).toHaveLength(230);
    expect(shas.at(-1)).toBe("c229");
  });

  it("reads production deployments: success time, failures, and not a bot's preview", async () => {
    const state = { calls: [] as string[][], remaining: 5000 };
    const gh = fakeGh({ prs: [], issues: [], rest: {
      [`repos/${REPO}/deployments?environment=production&per_page=100&page=1`]: [
        { id: 3, sha: "s3", created_at: at(25), creator: { login: "dinhogehm" } },
        { id: 2, sha: "s2", created_at: at(24), creator: { login: "dinhogehm" } },
        { id: 1, sha: "s1", created_at: at(4), creator: { login: "vercel[bot]" } },
      ],
      [`repos/${REPO}/deployments/3/statuses?per_page=100`]: [{ state: "inactive", created_at: at(26) }, { state: "success", created_at: at(25, 15) }, { state: "in_progress", created_at: at(25, 13) }],
      [`repos/${REPO}/deployments/2/statuses?per_page=100`]: [{ state: "failure", created_at: at(24, 14) }],
    } }, state);
    const deployments = await readDeployments(gh, REPO, []);
    expect(deployments).toEqual([
      { id: 2, sha: "s2", createdAt: Date.parse(at(24)), successAt: null, failedAt: Date.parse(at(24, 14)), final: true },
      { id: 3, sha: "s3", createdAt: Date.parse(at(25)), successAt: Date.parse(at(25, 15)), failedAt: null, final: true },
    ]);
    // a final deployment is not asked again
    state.calls = [];
    await readDeployments(gh, REPO, deployments);
    expect(state.calls.some((args) => args[1]!.includes("/statuses"))).toBe(false);
  });

  it("reads each release range once", async () => {
    const state = { calls: [] as string[][], remaining: 5000 };
    const gh = fakeGh({ prs: [], issues: [], rest: { [`repos/${REPO}/compare/a...b?per_page=100&page=1`]: { total_commits: 1, commits: [{ sha: "m1" }] } } }, state);
    const cache = emptyGhCache(REPO);
    expect(await syncCompares({ gh, cache, pairs: [{ base: "a", head: "b" }] })).toBe(1);
    expect(cache.compares["a...b"]).toEqual(["m1"]);
    expect(await syncCompares({ gh, cache, pairs: [{ base: "a", head: "b" }] })).toBe(0);
  });
});
