// The delivery board's live side (lot Z): one read-only GraphQL query for the
// open and recently merged PRs (merge state, gate, explicit references, the
// body dropped), at most every LIVE_EVERY_MS and never in the request's way;
// the release log re-read when it changed; the receipts read from the
// worktrees; an ETag that only moves when the content does.
import { describe, expect, it } from "vitest";
import { boardEtag, BOARD_PRS_QUERY, LIVE_EVERY_MS, parseLivePr, PipelineBoardService, readBoardPrs } from "./pipeline-board-live.ts";
import { boardGithub, boardOwnerPending, boardRuns, boardSessions, CHIEF, MONITOR, NOW } from "./testing/pipeline-board-fixture.ts";

const node = (extra: Record<string, unknown> = {}) => ({
  number: 9332, title: "feat(atendimento): prazo de reabertura (#9052)", body: "Closes #9052\n\nRefs #9047 and a bare #12", createdAt: "2026-10-01T15:17:56Z", updatedAt: "2026-10-04T14:06:49Z",
  mergedAt: null, state: "OPEN", isDraft: false, baseRefName: "main", headRefName: "feat/9052-x", mergeStateStatus: "BEHIND", mergeCommit: null,
  closingIssuesReferences: { nodes: [] }, labels: { nodes: [{ name: "priority:p1" }] },
  commits: { nodes: [{ commit: { oid: "407e3f9247c315011ad85c663cf74c21bfb01475", status: { context: { state: "FAILURE", createdAt: "2026-10-04T10:00:00Z" } } } }] },
  ...extra,
});

describe("reading the PRs for the board", () => {
  it("keeps the merge state, the gate on the head and the explicit references — never the body", () => {
    const pr = parseLivePr(node())!;
    expect(pr).toEqual({
      number: 9332, title: "feat(atendimento): prazo de reabertura (#9052)", createdAt: Date.parse("2026-10-01T15:17:56Z"), updatedAt: Date.parse("2026-10-04T14:06:49Z"),
      mergedAt: null, state: "OPEN", draft: false, base: "main", head: "feat/9052-x", headSha: "407e3f9247c315011ad85c663cf74c21bfb01475", mergeSha: null,
      gate: "failure", gateAt: Date.parse("2026-10-04T10:00:00Z"), mergeState: "BEHIND", closes: [], refs: [9052, 9047], labels: ["priority:p1"],
    });
    expect(JSON.stringify(pr)).not.toContain("bare");
    // GitHub not done computing: unknown, not a state
    expect(parseLivePr(node({ mergeStateStatus: "UNKNOWN" }))!.mergeState).toBeNull();
    expect(parseLivePr({ title: "no number" })).toBeNull();
  });

  it("asks one query, read-only, for the open and the merged lately", async () => {
    const calls: string[][] = [];
    const prs = await readBoardPrs(async (args) => {
      calls.push(args);
      return JSON.stringify({ data: { repository: { open: { nodes: [node()] }, merged: { nodes: [node({ number: 9350, state: "MERGED", mergedAt: "2026-10-03T23:13:51Z", mergeCommit: { oid: "ba034e1f", message: "Merge pull request #9350\n\nref #8204" } })] } }, rateLimit: { remaining: 4900 } } });
    }, "dinhogehm/nuria-platform");
    expect(calls).toEqual([["api", "graphql", "-f", `query=${BOARD_PRS_QUERY}`, "-f", "owner=dinhogehm", "-f", "name=nuria-platform"]]);
    expect(BOARD_PRS_QUERY).not.toMatch(/\bmutation\b/);
    expect(BOARD_PRS_QUERY.startsWith("query(")).toBe(true);
    expect(prs.open.map((pr) => pr.number)).toEqual([9332]);
    expect(prs.merged[0]).toMatchObject({ number: 9350, state: "MERGED", mergeSha: "ba034e1f" });
  });

  it("fails loudly on a GraphQL error, so the board keeps what it had", async () => {
    await expect(readBoardPrs(async () => JSON.stringify({ errors: [{ message: "API rate limit exceeded" }] }), "dinhogehm/nuria-platform")).rejects.toThrow("GitHub: API rate limit exceeded");
  });
});

function service(extra: { gh?: (args: string[]) => Promise<string>; clock?: { now: number }; files?: Map<string, { text: string; stamp: string }>; reads?: string[] } = {}) {
  const clock = extra.clock ?? { now: NOW };
  let logs = 0;
  const board = new PipelineBoardService({
    enabled: true,
    now: () => clock.now,
    gh: extra.gh ?? (async () => JSON.stringify({ data: { repository: { open: { nodes: [] }, merged: { nodes: [] } } } })),
    source: () => ({ github: boardGithub(), runs: boardRuns(), logCoverage: { from: 1790900000000, to: NOW } }),
    refreshLogs: async () => { logs += 1; },
    sessions: () => boardSessions(),
    ownerPending: () => boardOwnerPending(),
    botNames: () => new Map([[CHIEF, "Chief of Staff"], [MONITOR, "Monitor Chat Atendimento"]]),
    releaseHold: () => "o release de produção 3c04d7c3d está em andamento",
    admission: () => ({ lease: null, intents: [] }),
    readText: (path) => { extra.reads?.push(path); return extra.files?.get(path) ?? null; },
  });
  return { board, clock, logs: () => logs };
}

describe("the board service", () => {
  it("answers at once from what it holds; the live read lands for the next poll", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { board } = service({
      gh: async () => {
        await gate;
        return JSON.stringify({ data: { repository: { open: { nodes: [node({ number: 9368, title: "perf: lote W", body: "", mergeStateStatus: "CLEAN", commits: { nodes: [{ commit: { oid: "5bc51ed6ab3dda77e6ec0a803b3582a97b1d3e46", status: { context: { state: "SUCCESS", createdAt: "2026-10-04T01:00:00Z" } } } }] } })] }, merged: { nodes: [] } } } });
      },
    });
    const first = board.board();
    expect(first.sources.livePrsAt).toBeNull();
    // the collector's open PRs stand in meanwhile: their gate unknown
    expect(first.columns.find((each) => each.stage === "pr")!.cards[0]!.gate?.status).toBe("unknown");
    release();
    await board.settle();
    const second = board.board();
    expect(second.sources.livePrsAt).toBe(NOW);
    expect(second.columns.find((each) => each.stage === "gate")!.cards.map((each) => [each.key, each.reason?.code])).toContainEqual(["pr:9368", "awaiting-merge"]);
  });

  it("reads GitHub at most every LIVE_EVERY_MS, and the log at most every 30 s", async () => {
    const calls: string[][] = [];
    const { board, clock, logs } = service({ gh: async (args) => { calls.push(args); return JSON.stringify({ data: { repository: { open: { nodes: [] }, merged: { nodes: [] } } } }); } });
    board.board();
    await board.settle();
    clock.now += 10_000;
    board.board();
    await board.settle();
    expect(calls).toHaveLength(1);
    expect(logs()).toBe(1);
    clock.now += LIVE_EVERY_MS;
    board.board();
    await board.settle();
    expect(calls).toHaveLength(2);
    expect(logs()).toBe(2);
  });

  it("keeps the last good read when GitHub fails, and says the failure", async () => {
    let fail = false;
    const { board, clock } = service({ gh: async () => { if (fail) throw new Error("gh: HTTP 502"); return JSON.stringify({ data: { repository: { open: { nodes: [] }, merged: { nodes: [] } } } }); } });
    board.board();
    await board.settle();
    fail = true;
    clock.now += LIVE_EVERY_MS;
    board.board();
    await board.settle();
    const after = board.board();
    expect(after.sources.livePrsAt).toBe(NOW);
    expect(after.sources.livePrsError).toBe("gh: HTTP 502");
  });

  it("reads the receipt in each working session's worktree, and parses it again only when it changed", async () => {
    const reads: string[] = [];
    const path = "/repo/.claude/worktrees/9052-tempo-de-reabertura-configuravel-35787b/.local-ci/last-success/receipt.env";
    const files = new Map([[path, { text: "CI_COMMIT=407e3f9247c315011ad85c663cf74c21bfb01475\nCI_FINISHED_AT=20261004T010000Z\nCI_RESULT=success\n", stamp: "1" }]]);
    const { board } = service({ files, reads });
    const card = board.board().columns.flatMap((each) => each.cards).find((each) => each.key === "issue:9052")!;
    expect(card.gate).toMatchObject({ receipt: "head", at: Date.parse("2026-10-04T01:00:00Z") });
    // only sessions with a PR and a worktree are looked at
    expect(reads).toEqual([path]);
  });

  it("says nothing when the release machinery is not on this Mac", () => {
    const off = new PipelineBoardService({ enabled: false, source: () => { throw new Error("never read"); }, sessions: () => [], ownerPending: () => [], botNames: () => new Map(), releaseHold: () => null, admission: () => ({ lease: null, intents: [] }) });
    const board = off.board();
    expect(board.enabled).toBe(false);
    expect(board.columns.every((each) => each.total === null && !each.known)).toBe(true);
  });

  it("an ETag that moves with the content, not with the moment", () => {
    const { board, clock } = service();
    const one = board.board();
    clock.now += 1_000;
    const two = { ...one, generatedAt: one.generatedAt + 1_000 };
    expect(boardEtag(two)).toBe(boardEtag(one));
    const moved = { ...one, columns: one.columns.map((each, index) => (index === 0 ? { ...each, total: (each.total ?? 0) + 1 } : each)) };
    expect(boardEtag(moved)).not.toBe(boardEtag(one));
  });
});
