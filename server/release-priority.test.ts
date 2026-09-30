import { describe, expect, it } from "vitest";
import { parsePsTable } from "./bg-jobs.ts";
import { ciGroupToStop, ownerSession, releaseBlockedBy } from "./release-priority.ts";

const log = [
  "ADMISSION_LOAD_CLEAR label=release:production load1=7.55 threshold=12.00 ncpu=10 waited=90s",
  "ADMISSION_WAITING kind=release label=release:production:2995ef2 blocked_by=ci-full:48250 waited=420s limit=2700s",
].join("\n");

// the server (100), a session's claude (500) that started the full CI (48250 → 48260),
// someone else's CI (70000), and the release itself (1338)
const table = parsePsTable([
  "  100     1   100 Tue Sep 30 10:00:00 2026 node server/index.js",
  "  500   100   500 Tue Sep 30 10:00:10 2026 claude -p --output-format stream-json",
  "48250   500 48250 Tue Sep 30 10:01:00 2026 bash ./scripts/local-ci.sh --profile full",
  "48260 48250 48250 Tue Sep 30 10:01:01 2026 node node_modules/.bin/vitest run",
  "70000     1 70000 Tue Sep 30 10:02:00 2026 bash ./scripts/local-ci.sh --profile full",
  " 1338     1  1338 Tue Sep 30 10:03:00 2026 bash scripts/local-release.sh --environment production",
  " 1400  1338  1338 Tue Sep 30 10:03:01 2026 bash ./scripts/local-ci.sh --profile release",
].join("\n"));

describe("the production release first", () => {
  it("reads a release waiting on a full CI, and nothing else", () => {
    expect(releaseBlockedBy(log)).toEqual({ label: "release:production:2995ef2", pid: 48250, waitedS: 420 });
    expect(releaseBlockedBy(`${log}\nADMISSION_ACQUIRED kind=release label=x`)).toBeNull();
    expect(releaseBlockedBy("ADMISSION_WAITING kind=ci-full label=x blocked_by=release:1338 waited=60s limit=2700s")).toBeNull();
    expect(releaseBlockedBy("")).toBeNull();
  });

  it("finds the managed session a CI belongs to — its claude's tree, its job, or its app worktree — and no one else's", () => {
    const sessions = [{ sessionId: "cli", claudePid: 500 }, { sessionId: "app", worktree: "/repo/.claude/worktrees/fix-9311" }];
    expect(ownerSession(48250, table, () => null, sessions)).toBe("cli");
    expect(ownerSession(70000, table, () => null, sessions)).toBeNull();
    expect(ownerSession(70000, table, () => "/repo/.claude/worktrees/fix-9311/packages", sessions)).toBe("app");
    expect(ownerSession(70000, table, () => "/repo", sessions)).toBeNull();
    expect(ownerSession(70000, table, () => null, [{ sessionId: "job", jobPids: [70000] }])).toBe("job");
    expect(ownerSession(99999, table, () => null, sessions)).toBeNull();
  });

  it("stops only a local CI's own group — never the release's, never the server's", () => {
    expect(ciGroupToStop(48250, table, 100)).toBe(48250);
    expect(ciGroupToStop(1400, table, 100)).toBeNull(); // in the release's group
    expect(ciGroupToStop(1338, table, 100)).toBeNull(); // the release
    expect(ciGroupToStop(500, table, 100)).toBeNull(); // not a CI
    expect(ciGroupToStop(48250, table, 48250)).toBeNull(); // our own group
  });
});
