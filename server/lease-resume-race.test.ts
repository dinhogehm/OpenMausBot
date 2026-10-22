import { describe, expect, it } from "vitest";
import { leaseRecoveryFor } from "./bot-autonomy.ts";
import { cutLeaseRecovery, cutTurnRoots, type CutRootNode } from "./lease-resume.ts";

// This fork: an autonomous turn a restart cut after it had handed work out
// goes on one way only. Its root resumes in place; its lease (bot-autonomy.ts)
// gives nothing back. The coordinator may resume that root, and the resume
// may end, before the first autonomy tick looks at the lease
// (resumeCutLeases in index.ts): the root has then left active(), and only
// its second execution shows it went on.

type Row = CutRootNode & { status: string; requester: "bot_turn" | "person" };

const LEASE = { threadId: "t1", startedAt: 1_000 };

const row = (over: Partial<Row> & { id: string }): Row => ({
  threadId: "t1",
  createdAt: 1_000,
  executions: 1,
  status: "completed",
  requester: "bot_turn",
  ...over,
});
const autonomous = (node: Row): boolean => node.requester === "bot_turn";

describe("a cut lease whose turn's root already went on is not given back (the boot race)", () => {
  it("counts the root the runtime resumed and ended before the first tick: continued, not a rerun", () => {
    // cut after coordinate_bots, resumed with the teammate's result at boot, done
    const resumed = row({ id: "r1", createdAt: 1_200, executions: 2, status: "completed" });
    // what the live roots alone gave: a second path, the wake run again beside the resume's answer
    expect(leaseRecoveryFor(LEASE, { roots: [], outward: [] })).toEqual({ kind: "rerun" });
    expect(cutLeaseRecovery(LEASE, { live: [], all: [resumed], outward: [] }, autonomous)).toEqual({ kind: "continued" });
  });

  it("counts it in any status once it ran again: failed, cut once more, or parked", () => {
    for (const status of ["failed", "cancelled", "waiting", "needs_input", "queued"]) {
      const resumed = row({ id: `r-${status}`, createdAt: 1_000, executions: 2, status });
      expect(cutLeaseRecovery(LEASE, { live: [], all: [resumed], outward: [] }, autonomous)).toEqual({ kind: "continued" });
    }
    // more than one resume (teammates answered twice, or a second restart cut the resume)
    expect(cutLeaseRecovery(LEASE, { live: [], all: [row({ id: "r3", executions: 4, status: "failed" })], outward: [] }, autonomous)).toEqual({ kind: "continued" });
  });

  it("wins over an outward action in the turn's rows, as a live root does: the resume is the one path", () => {
    const resumed = row({ id: "r1", createdAt: 1_500, executions: 2, status: "completed" });
    expect(cutLeaseRecovery(LEASE, { live: [], all: [resumed], outward: ["git push"] }, autonomous)).toEqual({ kind: "continued" });
  });

  it("keeps a live root as before (cut after handing out work, still waiting)", () => {
    const waiting = row({ id: "r1", createdAt: 1_100, executions: 1, status: "waiting" });
    expect(cutLeaseRecovery(LEASE, { live: [waiting], all: [waiting], outward: [] }, autonomous)).toEqual({ kind: "continued" });
    // a live root older than the lease is an earlier turn's: leaseRecoveryFor still leaves it out
    const older = row({ id: "r0", createdAt: 900, executions: 1, status: "waiting" });
    expect(cutLeaseRecovery(LEASE, { live: [older], all: [older], outward: [] }, autonomous)).toEqual({ kind: "rerun" });
  });
});

describe("a cut lease whose turn did not go on is still given back or asked about", () => {
  it("does not count the cut turn's own root ended on its first execution (the outward hook failed it)", () => {
    const cut = row({ id: "r1", createdAt: 1_000, executions: 1, status: "failed" });
    expect(cutLeaseRecovery(LEASE, { live: [], all: [cut], outward: [] }, autonomous)).toEqual({ kind: "rerun" });
    expect(cutLeaseRecovery(LEASE, { live: [], all: [cut], outward: ["npm run pr:merge"] }, autonomous)).toEqual({ kind: "outward", labels: ["npm run pr:merge"] });
  });

  it("does not count a resumed root of an earlier turn of the conversation", () => {
    const earlier = row({ id: "r0", createdAt: 999, executions: 3, status: "completed" });
    expect(cutLeaseRecovery(LEASE, { live: [], all: [earlier], outward: [] }, autonomous)).toEqual({ kind: "rerun" });
  });

  it("does not count a resumed root of another conversation, a teammate's node, a room's node or a person's root", () => {
    const all = [
      row({ id: "other", threadId: "t2", executions: 2 }),
      row({ id: "child", parentId: "r1", executions: 2 }),
      row({ id: "room", groupId: "g1", executions: 2 }),
      row({ id: "person", requester: "person", executions: 2 }),
    ];
    expect(cutTurnRoots(LEASE, { live: [], all }, autonomous)).toEqual([]);
    expect(cutLeaseRecovery(LEASE, { live: [], all, outward: [] }, autonomous)).toEqual({ kind: "rerun" });
    // the same rows live do not count either
    expect(cutTurnRoots(LEASE, { live: all, all }, autonomous)).toEqual([]);
  });
});

describe("cutTurnRoots", () => {
  it("lists a root found live and among all rows once, live ones first", () => {
    const live = row({ id: "r1", createdAt: 1_100, executions: 2, status: "running" });
    const ended = row({ id: "r2", createdAt: 1_300, executions: 2, status: "completed" });
    expect(cutTurnRoots(LEASE, { live: [live], all: [live, ended] }, autonomous).map((node) => node.id)).toEqual(["r1", "r2"]);
  });

  it("asks isAutonomyRoot only of the conversation's own roots that could count (it reads the coordinator)", () => {
    const asked: string[] = [];
    const isAutonomyRoot = (node: Row): boolean => {
      asked.push(node.id);
      return autonomous(node);
    };
    const all = [
      row({ id: "other", threadId: "t2", executions: 2 }),
      row({ id: "child", parentId: "r1", executions: 2 }),
      row({ id: "once", executions: 1 }),
      row({ id: "earlier", createdAt: 999, executions: 2 }),
      row({ id: "resumed", createdAt: 1_400, executions: 2 }),
    ];
    expect(cutTurnRoots(LEASE, { live: [], all }, isAutonomyRoot).map((node) => node.id)).toEqual(["resumed"]);
    expect(asked).toEqual(["resumed"]);
  });
});
