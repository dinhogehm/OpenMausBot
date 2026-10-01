import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePsTable, type PsRow } from "./bg-jobs.ts";
import { ciToStop, type CiStop, ownerSession, releaseBlockedBy } from "./release-priority.ts";

const log = [
  "ADMISSION_LOAD_CLEAR label=release:production load1=7.55 threshold=12.00 ncpu=10 waited=90s",
  "ADMISSION_WAITING kind=release label=release:production:2995ef2 blocked_by=ci-full:48250 waited=420s limit=2700s",
].join("\n");

// The real process table of 01/10 15:34 (INSP-R r1), verbatim: the app and its
// server (pgid 34233, server 34250), two managed `claude -p` (38002, 78795)
// whose prompts say "ci:local" and "release-carrier" in argv, and the Bash
// tool's `zsh -c` groups running their ci:local (40320 holds the lease with
// owner.pid 40409 = local-ci.sh itself; 83523 waits in the queue).
const realText = readFileSync(join(import.meta.dirname, "fixtures", "ps-ci-local-2026-10-01.txt"), "utf8");
const real = parsePsTable(realText);
const SERVER = 34250;
const APP = 34233;
const CLAUDES = [38002, 78795];
const guard = { ownPgid: APP, protectedPids: [SERVER, APP, ...CLAUDES] };
const targets = (stop: CiStop) => (stop.kind === "refuse" ? [] : stop.pids);
/** The real table with some commands replaced (same pids, groups and parents). */
const edited = (changes: Record<number, string>, extra: string[] = []): PsRow[] => [
  ...real.map((row) => (changes[row.pid] ? { ...row, command: changes[row.pid]! } : row)),
  ...parsePsTable(extra.join("\n")),
];

describe("the production release first", () => {
  it("reads a release waiting on a full CI, and nothing else", () => {
    expect(releaseBlockedBy(log)).toEqual({ label: "release:production:2995ef2", pid: 48250, waitedS: 420 });
    expect(releaseBlockedBy(`${log}\nADMISSION_ACQUIRED kind=release label=x`)).toBeNull();
    expect(releaseBlockedBy("ADMISSION_WAITING kind=ci-full label=x blocked_by=release:1338 waited=60s limit=2700s")).toBeNull();
    expect(releaseBlockedBy("")).toBeNull();
  });

  it("the fixture is the real table: the claudes carry ci:local and release-carrier in argv", () => {
    const claude = real.find((row) => row.pid === 38002)!;
    expect(claude.command).toMatch(/^claude -p --resume 00000000/);
    expect(claude.command).toContain("Rode ci:local no head");
    expect(claude.command).toContain("./scripts/release-carrier.sh --check");
    expect(real.find((row) => row.pid === 78795)!.command).toContain("relance o `npm run ci:local`");
    expect(real.find((row) => row.pid === 40320)!.command).toMatch(/^\/bin\/zsh -c source .*eval 'npm run ci:local'/);
    expect(real.find((row) => row.pid === 40409)).toMatchObject({ ppid: 40324, pgid: 40320, command: "bash ./scripts/local-ci.sh --profile full" });
  });

  // INSP-R r1 item 1 (CRÍTICO): ciToStop(83637) answered group 78795 — the
  // session's own claude — and ciToStop(40409) refused because the claude's
  // prompt "is the release itself".
  it("stops the lease holder's own `zsh -c` group, never the claude above it (real table)", () => {
    expect(ciToStop(40409, real, guard)).toMatchObject({ kind: "group", pgid: 40320, root: { pid: 40320 } });
    expect(ciToStop(83637, real, guard)).toMatchObject({ kind: "group", pgid: 83523, root: { pid: 83523 } });
    expect(targets(ciToStop(40409, real, guard)).sort((a, b) => a - b)).toEqual([6593, 6596, 6597, 40320, 40324, 40409, 41154, 93072, 93073]);
    expect(targets(ciToStop(83637, real, guard)).sort((a, b) => a - b)).toEqual([6486, 83523, 83526, 83637]);
    for (const pid of [40409, 83637, 41154, 40324, 83526]) {
      const stop = ciToStop(pid, real, guard);
      expect(stop.kind).not.toBe("refuse");
      for (const forbidden of [...CLAUDES, SERVER, APP, 1]) expect(targets(stop)).not.toContain(forbidden);
      expect(stop.kind === "group" && [38002, 78795, 34233].includes(stop.pgid)).toBe(false);
    }
  });

  it("never takes a claude, the app, the server or an MCP for a CI, whatever their argv says", () => {
    for (const pid of [38002, 78795, 34233, 34250, 38043, 38074, 79561, 1]) {
      expect(ciToStop(pid, real, guard)).toMatchObject({ kind: "refuse", reason: expect.stringContaining("não é um ci:local reconhecível") });
    }
    // a zsh -c that only mentions ci:local is not the CI either
    expect(ciToStop(40320, real, guard).kind).toBe("refuse");
    expect(ciToStop(99999, real, guard)).toMatchObject({ kind: "refuse", reason: "o processo que segura o lease já não está rodando" });
  });

  // INSP-R r1 item 2: the release is recognised by its script, along the whole chain
  it("a prompt saying release-carrier is not the release; a real release-carrier.sh above the CI is", () => {
    expect(ciToStop(40409, real, guard).kind).toBe("group");
    // release-carrier.sh → zsh -c → npm run ci:local → local-ci.sh, the CI in a group of its own
    const underRelease = edited({ 38002: "bash ./scripts/release-carrier.sh --execute --label hotfix" });
    expect(ciToStop(40409, underRelease, guard)).toMatchObject({ kind: "refuse", reason: "o ci:local roda dentro do próprio release" });
    // the watcher far above (launchd → watcher → … → local-ci.sh) also counts
    const underWatcher = edited({ 34250: "/bin/bash /Users/o/.nuria/bin/watch-production-release.sh" });
    expect(ciToStop(83637, underWatcher, { ownPgid: 1 })).toMatchObject({ kind: "refuse", reason: "o ci:local roda dentro do próprio release" });
    // the release in the CI's group (or under it)
    const releaseInGroup = edited({}, ["70000 40320 40320 Thu Oct  1 15:30:00 2026     bash scripts/local-release.sh --environment production"]);
    expect(ciToStop(40409, releaseInGroup, guard)).toMatchObject({ kind: "refuse", reason: expect.stringContaining("release roda no mesmo grupo") });
    const npmRelease = edited({}, ["70001 41154 40320 Thu Oct  1 15:30:00 2026     npm run release:local"]);
    expect(ciToStop(40409, npmRelease, guard).kind).toBe("refuse");
  });

  it("stops only the CI's tree when its group also holds something else, and refuses when even that reaches a claude", () => {
    // no `zsh -c` leader: the CI runs in the claude's own group
    const shared = parsePsTable([
      "  100     1   100 Wed Oct  1 13:00:00 2026 node server/index.js",
      "24000   100 24000 Wed Oct  1 13:30:00 2026 claude -p --resume 00000000 -- rode ci:local",
      "25880 24000 24000 Wed Oct  1 13:40:00 2026 npm run ci:local",
      "25890 25880 24000 Wed Oct  1 13:40:01 2026 /bin/bash -p ./scripts/local-ci.sh --profile full",
      "25900 25890 24000 Wed Oct  1 13:40:02 2026 node node_modules/.bin/vitest run",
    ].join("\n"));
    const stop = ciToStop(25890, shared, { ownPgid: 100, protectedPids: [24000] });
    expect(stop).toMatchObject({ kind: "tree", root: { pid: 25880 } });
    expect(targets(stop).sort()).toEqual([25880, 25890, 25900]);
    // a claude below the CI (or a protected pid) is never part of the target
    const claudeBelow = [...shared, ...parsePsTable("26000 25900 24000 Wed Oct  1 13:41:00 2026 claude -p --resume other")];
    expect(ciToStop(25890, claudeBelow, { ownPgid: 100 })).toMatchObject({ kind: "refuse", reason: expect.stringContaining("sessão do Claude") });
    expect(ciToStop(25890, shared, { ownPgid: 100, protectedPids: [25900] })).toMatchObject({ kind: "refuse" });
    // the server's own group, or no group of its own
    expect(ciToStop(40409, real, { ownPgid: 40320 })).toMatchObject({ kind: "refuse", reason: "o ci:local está no grupo de processos do próprio servidor" });
  });

  it("finds the managed session a CI belongs to — its claude's tree, its job, or its app worktree — and no one else's", () => {
    const sessions = [{ sessionId: "29da", claudePid: 38002 }, { sessionId: "5f41", claudePid: 78795 }];
    expect(ownerSession(40409, real, () => null, sessions)).toBe("29da");
    expect(ownerSession(83637, real, () => null, sessions)).toBe("5f41");
    expect(ownerSession(40409, real, () => null, [{ sessionId: "job", jobPids: [40324] }])).toBe("job");
    expect(ownerSession(99999, real, () => null, sessions)).toBeNull();
  });
});
