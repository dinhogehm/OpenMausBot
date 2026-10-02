import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePsTable, type PsRow } from "./bg-jobs.ts";
import { type AdmissionLease, ciLabel, ciOwner, ciToStop, type CiStop, leaseConfirms, ownerSession, preemptCiForRelease, type PreemptEnv, type PreemptState, PREEMPT_RETRY_LIMIT, refusalText, releaseBlockedBy, type ReleaseIntent, releaseLabelSha, resumeAfterRelease, targetDrift } from "./release-priority.ts";
import { releaseFailures, releaseInLoop } from "./release-watch.ts";

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

  // INSP-R r2 item 1: this repo's fork is public — the fixture keeps the real
  // shape (pids, groups, lstart, the head of every command) and nothing else.
  // Allowlists, so the guard itself names nothing private.
  it("the fixture stays redacted: fake home, ids, sockets, tokens, worktrees, PRs", () => {
    expect(realText).not.toMatch(/token-file\s+\S*connector|\.token\b|#?93\d\d\b/i);
    expect(realText).not.toMatch(/\/Users\/(?!owner\b)/);
    expect(realText).not.toMatch(/--pr \d/);
    for (const uuid of realText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []) expect(uuid).toMatch(/^00000000-0000-4000-8000-0000000000\d\d$/);
    for (const sock of realText.match(/\S+\.sock\b/g) ?? []) expect(sock).toBe("/var/folders/xx/redacted/T/cua-34233-00000000.sock");
    for (const worktree of realText.match(/\/\.claude\/worktrees\/[^/\s]+/g) ?? []) expect(worktree).toMatch(/^\/\.claude\/worktrees\/session-[ab]$/);
    for (const sha of realText.match(/\b(?:head|em) `?[0-9a-f]{9}\b/g) ?? []) expect(sha).toMatch(/0000000[a-f]\d$/);
    // the redaction kept the shape the tests need
    expect(real).toHaveLength(37);
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

  it("refuses when the target would reach the app, its server helper or a terminal; a CI's own Chromium is fine", () => {
    const below = (command: string) => edited({}, [`70002 41154 40320 Thu Oct  1 15:33:00 2026     ${command}`]);
    for (const command of [
      "/Users/owner/Projetos/OpenMausBot/release/mac-arm64/OpenMausBot.app/Contents/Frameworks/OpenMausBot Helper.app/Contents/MacOS/OpenMausBot Helper --type=utility",
      "/Applications/Claude.app/Contents/MacOS/Claude",
      "-zsh",
      "tmux new -s ci",
      "/Users/o/.local/bin/claude --resume x",
    ]) expect(ciToStop(40409, below(command), guard), command).toMatchObject({ kind: "refuse", reason: expect.stringContaining("o alvo incluiria") });
    const chromium = below("/Users/o/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium --headless");
    expect(ciToStop(40409, chromium, guard)).toMatchObject({ kind: "group", pgid: 40320 });
  });

  it("finds the managed session a CI belongs to — its claude's tree, its job, or its app worktree — and no one else's", () => {
    const sessions = [{ sessionId: "29da", claudePid: 38002 }, { sessionId: "5f41", claudePid: 78795 }];
    expect(ownerSession(40409, real, () => null, sessions)).toBe("29da");
    expect(ownerSession(83637, real, () => null, sessions)).toBe("5f41");
    expect(ownerSession(40409, real, () => null, [{ sessionId: "job", jobPids: [40324], jobStarts: ["Thu Oct 1 15:01:46 2026"] }])).toBe("job");
    expect(ownerSession(99999, real, () => null, sessions)).toBeNull();
    // an app session (no claude pid): a CI working inside its worktree, started by nothing of the owner's
    const app = [{ sessionId: "app", worktree: "/Users/o/Projetos/nuria-platform/.claude/worktrees/fix-b" }];
    expect(ownerSession(83637, real, () => "/Users/o/Projetos/nuria-platform/.claude/worktrees/fix-b/packages", app)).toBe("app");
    expect(ownerSession(83637, real, () => "/Users/o/Projetos/nuria-platform", app)).toBeNull();
  });

  // INSP-R r1 item 7: the owner's own ci:local, typed in a terminal inside an
  // app session's worktree, was attributed to that session
  it("a ci:local the owner typed in a terminal is the owner's, even inside a session's worktree", () => {
    const worktree = "/Users/o/Projetos/nuria-platform/.claude/worktrees/fix-b";
    const terminal = parsePsTable([
      "    1     0     1 Wed Sep 30 15:49:16 2026     /sbin/launchd",
      "  700     1   700 Thu Oct  1 09:00:00 2026     /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      "  710   700   710 Thu Oct  1 09:00:01 2026     login -pf osvaldo",
      "  711   710   711 Thu Oct  1 09:00:01 2026     -zsh",
      "  900   711   900 Thu Oct  1 15:20:00 2026     npm run ci:local   ",
      "  905   900   900 Thu Oct  1 15:20:01 2026     bash ./scripts/local-ci.sh --profile full",
    ].join("\n"));
    const app = [{ sessionId: "app", worktree }];
    expect(ciOwner(905, terminal, () => `${worktree}/packages`, app)).toMatchObject({ kind: "owner", terminal: { pid: 711 } });
    expect(ownerSession(905, terminal, () => worktree, app)).toBeNull();
    // in tmux too
    const tmux = terminal.map((row) => (row.pid === 711 ? { ...row, command: "tmux: server" } : row));
    expect(ciOwner(905, tmux, () => worktree, app).kind).toBe("owner");
    // a managed claude below the owner's shell still owns its CI (it comes first walking up)
    const claudeInTerminal = parsePsTable([
      ...terminal.slice(0, 4).map((row) => `${row.pid} ${row.ppid} ${row.pgid} ${row.start} ${row.command}`),
      "  800   711   800 Thu Oct  1 15:00:00 2026     claude --resume abc",
      "  810   800   810 Thu Oct  1 15:20:00 2026     /bin/zsh -c eval 'npm run ci:local'",
      "  815   810   810 Thu Oct  1 15:20:01 2026     bash ./scripts/local-ci.sh --profile full",
    ].join("\n"));
    expect(ciOwner(815, claudeInTerminal, () => null, [{ sessionId: "cli", claudePid: 800 }])).toEqual({ kind: "session", sessionId: "cli" });
    expect(ciOwner(815, claudeInTerminal, () => null, [])).toMatchObject({ kind: "owner" });
  });

  // INSP-R r2 item 2: a session's job pid, reused by the owner's processes, made the owner's CI the session's
  it("a job pid counts only with its start time, and never above the owner's terminal", () => {
    const tree = parsePsTable([
      "    1     0     1 Wed Sep 30 15:49:16 2026     /sbin/launchd",
      "  500     1   500 Thu Oct  1 09:00:00 2026     /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      "  550   500   550 Thu Oct  1 09:00:01 2026     login -pf owner",
      "  601   550   601 Thu Oct  1 09:00:01 2026     -zsh",
      "  700   601   700 Thu Oct  1 15:20:00 2026     npm run ci:local   ",
      "  701   700   700 Thu Oct  1 15:20:01 2026     bash ./scripts/local-ci.sh --profile full",
    ].join("\n"));
    // the session's job had pid 700 (or 601) once — another process, another start
    for (const job of [700, 601]) {
      expect(ciOwner(701, tree, () => null, [{ sessionId: "s", jobPids: [job] }]), `${job} without start`).toMatchObject({ kind: "owner" });
      expect(ciOwner(701, tree, () => null, [{ sessionId: "s", jobPids: [job], jobStarts: ["Wed Oct 1 08:00:00 2026"] }]), `${job} other start`).toMatchObject({ kind: "owner" });
    }
    // even with the same start, the owner's terminal above it wins
    expect(ciOwner(701, tree, () => null, [{ sessionId: "s", jobPids: [700], jobStarts: ["Thu Oct 1 15:20:00 2026"] }])).toMatchObject({ kind: "owner", terminal: { pid: 601 } });
    // so ciToStop is never asked to stop it as a session's
    expect(ownerSession(701, tree, () => null, [{ sessionId: "s", jobPids: [700] }])).toBeNull();
    // a session's job with the same start and no terminal above: the session's
    const orphan = tree.filter((row) => row.pid >= 700 || row.pid === 1).map((row) => (row.pid === 700 ? { ...row, ppid: 1 } : row));
    expect(ciOwner(701, orphan, () => null, [{ sessionId: "s", jobPids: [700], jobStarts: ["Thu Oct 1 15:20:00 2026"] }])).toEqual({ kind: "session", sessionId: "s" });
    expect(ciOwner(701, orphan, () => null, [{ sessionId: "s", jobPids: [700], jobStarts: ["Thu Oct 1 15:20:09 2026"] }])).toEqual({ kind: "unknown" });
    expect(ciOwner(701, orphan, () => null, [{ sessionId: "s", jobPids: [700] }])).toEqual({ kind: "unknown" });
  });
});

// ── the whole decision, on the real table, with a fake kill ──────────────
// Nothing here signals a process: `kill` is injected and only recorded.
const LABEL = "release:production:c88f99d62";
// the release itself, waiting with its intent (admission intents/<pid> = label)
const releaseRows = parsePsTable("50000     1 50000 Thu Oct  1 15:30:00 2026     bash scripts/local-release.sh --environment production");
const live = [...real, ...releaseRows];
const intent: ReleaseIntent = { pid: 50000, label: `${LABEL}\n` };
const waitingOn = (pid: number, waitedS = 180) => [
  `ADMISSION_INTENT kind=release label=${LABEL} pid=50000`,
  `ADMISSION_WAITING kind=release label=${LABEL} blocked_by=ci-full:${pid} waited=${waitedS}s limit=2700s`,
].join("\n");
const SESSIONS = [{ sessionId: "29da", title: "gate run", claudePid: 38002 }, { sessionId: "5f41", title: "queued gate", claudePid: 78795 }];
const without = (rows: readonly PsRow[], pgid: number) => rows.filter((row) => row.pgid !== pgid);

interface Run {
  env: PreemptEnv;
  state: PreemptState;
  kills: Array<[number, string]>;
  alerts: string[];
  reports: string[];
  stopped: Array<{ session: string; target: CiStop }>;
  sleeps: number[];
  logs: string[];
}

function harness(options: {
  log: string;
  /** successive ps reads before the signal (the last one repeats) */
  before: PsRow[][];
  /** the ps read after the signal */
  after?: PsRow[];
  lease?: AdmissionLease | null;
  leaseAfter?: AdmissionLease | null;
  intents?: ReleaseIntent[] | null;
  sessions?: ReturnType<PreemptEnv["sessions"]>;
  cwd?: string | null;
  guard?: PreemptEnv["guard"];
  killThrows?: boolean;
  /** the lease exists but cannot be read: before the signal, or after it */
  leaseThrows?: "before" | "after";
  looping?: PreemptEnv["looping"];
}): Run {
  const run: Omit<Run, "env"> = { state: { handled: new Set(), retries: new Map() }, kills: [], alerts: [], reports: [], stopped: [], sleeps: [], logs: [] };
  const reads = [...options.before];
  let signalled = false;
  const env: PreemptEnv = {
    outLogTail: () => options.log,
    readLease: () => {
      if (options.leaseThrows === (signalled ? "after" : "before")) throw new Error("EACCES");
      return signalled && options.leaseAfter !== undefined ? options.leaseAfter : options.lease === undefined ? { ownerPid: "40409\n", kind: "ci-full\n" } : options.lease;
    },
    readIntents: () => (options.intents === undefined ? [intent] : options.intents),
    ps: async () => (signalled ? options.after ?? reads[0] ?? [] : (reads.length > 1 ? reads.shift()! : reads[0] ?? [])),
    cwdOf: async () => (options.cwd === undefined ? "/Users/owner/Projetos/nuria-platform/.claude/worktrees/gate-a" : options.cwd),
    sessions: () => options.sessions ?? SESSIONS,
    guard: options.guard ?? (() => guard),
    kill: (pid, signal) => {
      run.kills.push([pid, signal]);
      if (options.killThrows) throw new Error("EPERM");
      signalled = true;
    },
    sleep: async (ms) => { run.sleeps.push(ms); },
    alertChief: (text, report) => { run.alerts.push(text); run.reports.push(report); },
    stopped: ({ session, target }) => { run.stopped.push({ session: session.sessionId, target }); },
    log: (line) => { run.logs.push(line); },
    home: "/Users/owner",
    ...(options.looping ? { looping: options.looping } : {}),
  };
  return { ...run, env };
}

/** No alert carries raw argv: no prompt, no shell line, no script path. */
const expectNoArgv = (texts: string[]) => {
  for (const text of texts) {
    expect(text).not.toMatch(/claude -p|--resume|zsh -c|\.\/scripts\/|shell-snapshots|SINAL:|Conferi:/);
  }
};

describe("stopping a session's CI for the release (fake kill, real table)", () => {
  it("stops the lease holder's zsh -c group, checks the lease 15 s later, and only then says it worked", async () => {
    const run = harness({ log: waitingOn(40409), before: [live, live], after: without(live, 40320), leaseAfter: { ownerPid: "50000", kind: "release" } });
    expect(await preemptCiForRelease(run.env, run.state)).toBe("stopped");
    expect(run.kills).toEqual([[-40320, "SIGTERM"]]);
    expect(run.sleeps).toEqual([15_000]);
    expect(run.stopped).toEqual([{ session: "29da", target: expect.objectContaining({ kind: "group", pgid: 40320 }) }]);
    expect(run.alerts).toEqual([]);
    expect(run.logs.at(-1)).toContain("no longer holds the lease (owner now 50000, the CI is gone)");
    // decided once
    expect(await preemptCiForRelease(run.env, run.state)).toBe("idle");
    expect(run.kills).toHaveLength(1);
  });

  it("the incident's case (ci-full:83637 of session 5f41): signals group 83523, never the claude's 78795", async () => {
    const run = harness({ log: waitingOn(83637), lease: { ownerPid: "83637", kind: "ci-full" }, before: [live, live], after: without(live, 83523), leaseAfter: null });
    expect(await preemptCiForRelease(run.env, run.state)).toBe("stopped");
    expect(run.kills).toEqual([[-83523, "SIGTERM"]]);
    expect(run.stopped[0]!.session).toBe("5f41");
  });

  // INSP-R r1 item 4
  it("when the CI survives the signal: tells the Chief it could not free the release, and resumes nothing", async () => {
    const run = harness({ log: waitingOn(40409), before: [live, live], after: live, leaseAfter: { ownerPid: "40409", kind: "ci-full" } });
    expect(await preemptCiForRelease(run.env, run.state)).toBe("survived");
    expect(run.kills).toEqual([[-40320, "SIGTERM"]]);
    expect(run.stopped).toEqual([]);
    expect(run.alerts).toEqual(['O servidor mandou interromper o ci:local da sessão "gate run" para liberar o release de produção (release:production:c88f99d62), mas 15 s depois ele ainda segura o lease: não consegui liberar o release. Interrompa esse ci:local na sessão (processo 40409), ou deixe o release esperar.']);
    expect(run.reports[0]).toMatch(/^\[Alerta do servidor: release continua bloqueado\]/);
    // ps read nothing after the signal: still not claimed as a success
    const blind = harness({ log: waitingOn(40409), before: [live, live], after: [], leaseAfter: { ownerPid: "40409", kind: "ci-full" } });
    expect(await preemptCiForRelease(blind.env, blind.state)).toBe("survived");
    // a failed signal is said as such
    const failed = harness({ log: waitingOn(40409), before: [live, live], killThrows: true });
    expect(await preemptCiForRelease(failed.env, failed.state)).toBe("kill-failed");
    expect(failed.alerts[0]).toContain("o sinal falhou: nada foi interrompido");
    expect(failed.stopped).toEqual([]);
  });

  // INSP-R r1 item 3
  it("confirms the log against the lease and the intents, and the start times across two reads", async () => {
    const blocked = { pid: 40409, label: LABEL, waitedS: 180 };
    const alive = (pid: number) => live.some((row) => row.pid === pid);
    const lease = { ownerPid: "40409", kind: "ci-full" };
    expect(leaseConfirms(lease, [intent], blocked, alive)).toEqual({ ok: true, releasePid: 50000 });
    expect(leaseConfirms({ ownerPid: "83637", kind: "ci-full" }, [intent], blocked, alive)).toMatchObject({ ok: false, waiting: true, reason: expect.stringContaining("outro processo (83637)") });
    expect(leaseConfirms({ ownerPid: "40409", kind: "release" }, [intent], blocked, alive)).toMatchObject({ ok: false, waiting: true });
    expect(leaseConfirms(null, [intent], blocked, alive)).toMatchObject({ ok: false, waiting: true });
    expect(leaseConfirms(lease, [], blocked, alive)).toMatchObject({ ok: false, waiting: false });
    expect(leaseConfirms(lease, [{ pid: 50000, label: "release:production:other" }], blocked, alive)).toMatchObject({ ok: false, waiting: false });
    expect(leaseConfirms(lease, [{ pid: 59999, label: LABEL }], blocked, alive)).toMatchObject({ ok: false, waiting: false }); // intent of a dead release
    expect(leaseConfirms(lease, [intent], { ...blocked, pid: 99999 }, alive)).toMatchObject({ ok: false });

    // an old log line (the release died waiting): nothing to do, nothing signalled
    const stale = harness({ log: waitingOn(40409), before: [live], intents: [] });
    expect(await preemptCiForRelease(stale.env, stale.state)).toBe("stale");
    expect(stale.kills).toEqual([]);
    // the lease moved to another pid: no signal; after PREEMPT_RETRY_LIMIT ticks the Chief hears it, once
    const moved = harness({ log: waitingOn(40409), before: [live], lease: { ownerPid: "83637", kind: "ci-full" } });
    for (let tick = 0; tick < PREEMPT_RETRY_LIMIT + 2; tick += 1) await preemptCiForRelease(moved.env, moved.state);
    expect(moved.kills).toEqual([]);
    expect(moved.alerts).toHaveLength(1);
    expect(moved.alerts[0]).toContain("não conseguiu confirmar que pode interrompê-lo (o lease é de outro processo (83637), não do ci-full:40409 que o log cita): nada foi interrompido");
    // intents/ unreadable (or not where we look): undecided, never "no release waits"; the Chief hears it on the 3rd tick
    const blind = harness({ log: waitingOn(40409), before: [live], intents: null });
    for (let tick = 0; tick < PREEMPT_RETRY_LIMIT; tick += 1) expect(await preemptCiForRelease(blind.env, blind.state)).toBe("retry");
    expect(blind.kills).toEqual([]);
    expect(blind.alerts).toHaveLength(1);
    expect(blind.alerts[0]).toContain("a pasta de intenções do admission não pôde ser lida");
    // pid reused between the two reads (same pid, other start): no signal
    const reused = live.map((row) => (row.pid === 40409 ? { ...row, start: "Thu Oct 1 15:40:00 2026" } : row));
    const drift = harness({ log: waitingOn(40409), before: [live, reused] });
    expect(await preemptCiForRelease(drift.env, drift.state)).toBe("retry");
    expect(drift.kills).toEqual([]);
    expect(drift.logs.at(-1)).toContain("o processo 40409 mudou de horário de início entre as duas leituras (pid reusado)");
    const first = ciToStop(40409, live, guard);
    expect(targetDrift(first, ciToStop(40409, live, guard), live, live, 40409)).toBeNull();
    expect(targetDrift(first, ciToStop(40409, reused, guard), live, reused, 40409)).toContain("pid reusado");
    expect(targetDrift(first, null, live, [], 40409)).toContain("veio vazia");
  });

  // INSP-R r1 item 5
  it("a CI no managed session owns: the Chief hears it once, with what and where, and nothing is signalled", async () => {
    const run = harness({ log: waitingOn(40409), before: [live], sessions: [], cwd: "/Users/owner/Projetos/nuria-platform/.claude/worktrees/gate-a" });
    expect(await preemptCiForRelease(run.env, run.state)).toBe("not-managed");
    expect(await preemptCiForRelease(run.env, run.state)).toBe("idle");
    expect(run.kills).toEqual([]);
    expect(run.alerts).toEqual(["O release de produção (release:production:c88f99d62) espera há 3 min atrás de um ci:local que não é de sessão gerenciada (local-ci.sh --profile full, em ~/Projetos/nuria-platform/.claude/worktrees/gate-a): o servidor não o interrompe; só quem o rodou pode interrompê-lo, ou o release espera."]);
    expect(run.reports[0]).toMatch(/^\[Alerta do servidor: release esperando atrás de CI\] /);
    // the owner's terminal
    const terminal = parsePsTable([
      "  711     1   711 Thu Oct  1 09:00:01 2026     -zsh",
      "  900   711   900 Thu Oct  1 15:20:00 2026     npm run ci:local   ",
      "  905   900   900 Thu Oct  1 15:20:01 2026     bash ./scripts/local-ci.sh --profile full",
    ].join("\n"));
    const owner = harness({ log: waitingOn(905), lease: { ownerPid: "905", kind: "ci-full" }, before: [[...live, ...terminal]], cwd: null });
    expect(await preemptCiForRelease(owner.env, owner.state)).toBe("not-managed");
    expect(owner.alerts).toEqual(["O release de produção (release:production:c88f99d62) espera há 3 min atrás de um ci:local do dono (local-ci.sh --profile full, em pasta desconhecida), rodado num terminal: o servidor não o interrompe; só o dono pode interrompê-lo, ou o release espera."]);
    expect(owner.kills).toEqual([]);
  });

  // INSP-R r1 item 6
  it("a ps that read nothing decides nothing: the next tick still acts", async () => {
    const run = harness({ log: waitingOn(40409), before: [[], live, live], after: without(live, 40320), leaseAfter: null });
    expect(await preemptCiForRelease(run.env, run.state)).toBe("retry");
    expect(run.state.handled.has(`${LABEL}#40409`)).toBe(false);
    expect(run.kills).toEqual([]);
    expect(await preemptCiForRelease(run.env, run.state)).toBe("stopped");
    expect(run.kills).toEqual([[-40320, "SIGTERM"]]);
  });

  it("waits RELEASE_WAIT_BEFORE_PREEMPT_S before anything, and reads nothing when no release waits", async () => {
    const early = harness({ log: waitingOn(40409, 60), before: [live] });
    expect(await preemptCiForRelease(early.env, early.state)).toBe("idle");
    const none = harness({ log: `${waitingOn(40409)}\nADMISSION_GRANTED kind=release label=${LABEL} pid=50000 waited=190s`, before: [live] });
    expect(await preemptCiForRelease(none.env, none.state)).toBe("idle");
    expect([...early.kills, ...none.kills, ...early.alerts, ...none.alerts]).toEqual([]);
  });

  // INSP-R r1 item 11: every refusal, as the Chief reads it — pt-BR, no argv
  it("says each refusal in pt-BR, without argv", async () => {
    const said = (reason: string) => refusalText({ pid: 40409, label: LABEL, waitedS: 180 }, "gate run", reason);
    const cases: Array<{ name: string; rows: PsRow[]; lease?: string; guard?: PreemptEnv["guard"]; reason: string }> = [
      { name: "not a CI", rows: live, lease: "38043", reason: "o processo que segura o lease não é um ci:local reconhecível (local-ci.sh ou npm run ci:local)" },
      { name: "inside the release", rows: [...edited({ 34250: "bash ./scripts/release-carrier.sh --execute --label x" }), ...releaseRows], reason: "o ci:local roda dentro do próprio release" },
      { name: "server's group", rows: live, guard: () => ({ ownPgid: 40320 }), reason: "o ci:local está no grupo de processos do próprio servidor" },
      { name: "release in the group", rows: [...live, ...parsePsTable("70000 40320 40320 Thu Oct  1 15:30:00 2026     bash scripts/local-release.sh --environment production")], reason: "o release roda no mesmo grupo de processos do ci:local, ou abaixo dele" },
      { name: "the zsh -c leader also chains the release", rows: edited({ 40320: "/bin/zsh -c eval 'npm run ci:local && ./scripts/release-carrier.sh --execute --label x'" }, releaseRows.map((row) => `${row.pid} ${row.ppid} ${row.pgid} ${row.start} ${row.command}`)), reason: "o shell que roda o ci:local também encadeia o release" },
    ];
    for (const each of cases) {
      const lease = each.lease ?? "40409";
      const run = harness({ log: waitingOn(Number(lease)), lease: { ownerPid: lease, kind: "ci-full" }, before: [each.rows], ...(each.guard ? { guard: each.guard } : {}) });
      expect(await preemptCiForRelease(run.env, run.state), each.name).toBe("refused");
      expect(run.kills, each.name).toEqual([]);
      expect(run.alerts, each.name).toEqual([refusalText({ pid: Number(lease), label: LABEL, waitedS: 180 }, "gate run", each.reason)]);
      expectNoArgv([...run.alerts, ...run.reports]);
    }
    expect(said("o ci:local roda dentro do próprio release")).toBe('O release de produção (release:production:c88f99d62) espera há 3 min atrás do ci:local da sessão "gate run" e o servidor NÃO o interrompeu: o ci:local roda dentro do próprio release. Interrompa esse ci:local na sessão, ou deixe o release esperar.');
    expect(ciLabel("bash ./scripts/local-ci.sh --profile full")).toBe("local-ci.sh --profile full");
    expect(ciLabel("npm run ci:local   ")).toBe("npm run ci:local");
    expect(ciLabel(real.find((row) => row.pid === 38002)!.command)).toBe("processo não reconhecido");
  });

  // INSP-R r2, observations: a passing condition does not end the release's
  // chance; an unreadable lease is never read as a free one
  it("a forbidden process in the target is asked again before giving up; an unreadable lease is never 'free'", async () => {
    // a bare `sh` (a CI step) in the group for one tick: not now, then the CI is stopped
    const step = [...live, ...parsePsTable("70003 41154 40320 Thu Oct  1 15:33:30 2026     sh")];
    const passing = harness({ log: waitingOn(40409), before: [step, live, live], after: without(live, 40320), leaseAfter: null });
    expect(await preemptCiForRelease(passing.env, passing.state)).toBe("retry");
    expect(passing.kills).toEqual([]);
    expect(await preemptCiForRelease(passing.env, passing.state)).toBe("stopped");
    expect(passing.kills).toEqual([[-40320, "SIGTERM"]]);
    // still there after PREEMPT_RETRY_LIMIT ticks: the Chief hears it once, nothing signalled
    const stuck = harness({ log: waitingOn(40409), before: [step] });
    for (let tick = 0; tick < PREEMPT_RETRY_LIMIT + 1; tick += 1) await preemptCiForRelease(stuck.env, stuck.state);
    expect(stuck.kills).toEqual([]);
    expect(stuck.alerts).toHaveLength(1);
    expect(stuck.alerts[0]).toContain("(o alvo incluiria uma sessão do Claude, o servidor, o app ou um terminal do dono): nada foi interrompido");
    // the lease unreadable before the signal: undecided, no signal
    const before = harness({ log: waitingOn(40409), before: [live, live], leaseThrows: "before" });
    expect(await preemptCiForRelease(before.env, before.state)).toBe("retry");
    expect(before.kills).toEqual([]);
    // unreadable after the signal: not a success, the Chief hears it, nothing resumed
    const after = harness({ log: waitingOn(40409), before: [live, live], after: without(live, 40320), leaseThrows: "after" });
    expect(await preemptCiForRelease(after.env, after.state)).toBe("survived");
    expect(after.stopped).toEqual([]);
    expect(after.alerts[0]).toContain("não conseguiu ler o lease do admission: não sei se o release foi liberado");
    expectNoArgv([...stuck.alerts, ...after.alerts]);
  });
});

// 02/10 (R10-release #1, R10-resilience PRIO-LOOP): the carrier d5bb1f70b
// failed 10× at script-contracts (Node 22's ExperimentalWarning in stderr).
// At its 4th failure the server killed the ci:local of the session fixing it
// (#9348), then twice the CI of a P1 — for a release that failed again each
// time — and both sessions waited for a tag that never moved.
describe("a release in a loop never takes a session's CI (02/10, d5bb1f70b)", () => {
  const FULL = "d5bb1f70bea397bdd937d02148c685e406985ba0";
  const LOOP_LABEL = `release:production:${FULL}`;
  const CAUSE = "Local CI failed at script-contracts";
  // the real err log's shape that day: one line per try, the same commit
  const errLog = (count: number) => Array.from({ length: count }, () => `Release production failed for d5bb1f70b (exit 1)`).join("\nnpm WARN deprecated glob\n");
  const loopingWith = (count: number, extra: { itemOpen?: boolean; declined?: string; causes?: string[] } = {}) => (label: string) => {
    const sha = releaseLabelSha(label);
    return sha ? releaseInLoop({ sha, failures: releaseFailures(errLog(count), "09d832f4bfa4"), seen: { firstCount: 1, firstAt: 0, count, at: 1, causes: extra.causes ?? [CAUSE] }, itemOpen: extra.itemOpen ?? false, declined: extra.declined ?? "" }) : null;
  };
  const waiting = (pid: number) => [
    `ADMISSION_INTENT kind=release label=${LOOP_LABEL} pid=50000`,
    `ADMISSION_WAITING kind=release label=${LOOP_LABEL} blocked_by=ci-full:${pid} waited=135s limit=2700s`,
  ].join("\n");
  const loopIntent: ReleaseIntent = { pid: 50000, label: `${LOOP_LABEL}\n` };

  it("reads the commit from the admission label", () => {
    expect(releaseLabelSha(LOOP_LABEL)).toBe(FULL);
    expect(releaseLabelSha("release:production:c88f99d62")).toBe("c88f99d62");
    expect(releaseLabelSha("release:production")).toBeNull();
  });

  it("at its 4th failure with one cause: logs and tells once, and signals nothing — whichever CI it waits on", async () => {
    const run = harness({ log: waiting(40409), before: [live, live], after: without(live, 40320), intents: [loopIntent], leaseAfter: null, looping: loopingWith(4) });
    expect(await preemptCiForRelease(run.env, run.state)).toBe("looping");
    expect(run.kills).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(run.logs).toEqual([`[release-priority] leave alone: release ${LOOP_LABEL} is looping (o d5bb1f70b já falhou 4× seguidas pela mesma causa (CI local falhou em script-contracts)); it waited 135s on ci-full:40409 and no CI is stopped for it`]);
    expect(run.alerts).toHaveLength(1);
    expect(run.alerts[0]).toContain("o servidor NÃO interrompe CI para ele: o d5bb1f70b já falhou 4× seguidas pela mesma causa");
    expect(run.reports[0]).toMatch(/^\[Alerta do servidor: release em laço não passa na frente\]/);
    // the next ticks, and the next CI it waits on (the P1's, an hour later): silent, still nothing signalled
    expect(await preemptCiForRelease(run.env, run.state)).toBe("looping");
    run.env.outLogTail = () => waiting(83637);
    expect(await preemptCiForRelease(run.env, run.state)).toBe("looping");
    expect(run.kills).toEqual([]);
    expect(run.alerts).toHaveLength(1);
    expect(run.logs).toHaveLength(1);
    expectNoArgv(run.alerts);
  });

  it("the owner's loop item open, or the commit refused: also a loop; one failure, or two causes, is not", async () => {
    expect(loopingWith(1, { itemOpen: true })(LOOP_LABEL)).toBe("o dono tem aberto o item para recusar o d5bb1f70b (release em laço)");
    expect(loopingWith(1, { declined: FULL })(LOOP_LABEL)).toBe("o dono recusou o d5bb1f70b (declined-production-release.sha)");
    expect(loopingWith(1)(LOOP_LABEL)).toBeNull();
    expect(loopingWith(4, { causes: [CAUSE, "ADMISSION_TIMEOUT waiting for lease"] })(LOOP_LABEL)).toBeNull();
    // another commit than the one failing: free to go first
    expect(loopingWith(10)("release:production:09d832f4bfa4")).toBeNull();
    // and then the release takes the CI as before
    const run = harness({ log: waiting(40409), before: [live, live], after: without(live, 40320), intents: [loopIntent], leaseAfter: null, looping: loopingWith(1) });
    expect(await preemptCiForRelease(run.env, run.state)).toBe("stopped");
    expect(run.kills).toEqual([[-40320, "SIGTERM"]]);
  });

  it("gives the CI back when THAT release fails again, is refused or halted — not only when the tag moves", () => {
    const wait = { fromSha: "09d832f4bfa4", at: 0, message: "A tag andou", releaseSha: FULL, failuresAtStop: 4 };
    const now = { tagSha: "09d832f4bfa4", failures: releaseFailures(errLog(4), "09d832f4bfa4"), declined: "", halted: null };
    // still the 4th failure: it is running; the session waits
    expect(resumeAfterRelease(wait, now)).toBeNull();
    // the 5th failure: back to work, with why
    expect(resumeAfterRelease(wait, { ...now, failures: releaseFailures(errLog(5), "09d832f4bfa4") })).toBe("O release de produção do d5bb1f70b, que tomou a vez do seu ci:local, falhou de novo (5× seguidas) e a tag não andou: relance o seu ci:local agora (npm run ci:local) e siga de onde parou; o servidor não interrompe mais CI de sessão por esse commit enquanto ele estiver em laço.");
    expect(resumeAfterRelease(wait, { ...now, declined: `${FULL}\n` })).toContain("foi recusado pelo dono e não vai sair");
    expect(resumeAfterRelease(wait, { ...now, halted: "d5bb1f70b" })).toContain("foi parado pelo watcher (halt)");
    // the tag moved: the release went through
    expect(resumeAfterRelease(wait, { ...now, tagSha: FULL })).toBe("A tag andou");
    // an old record without the release's commit waits for the tag only
    expect(resumeAfterRelease({ fromSha: "09d832f4bfa4", at: 0, message: "A tag andou" }, { ...now, failures: releaseFailures(errLog(9), "") })).toBeNull();
    // another commit failing is not this release ending
    expect(resumeAfterRelease(wait, { ...now, failures: { sha: "2995ef215", count: 7 } })).toBeNull();
  });
});
