import { describe, expect, it, vi } from "vitest";
import { CcSessionLedger, type CcSession } from "./cc-sessions.ts";
import type { DesktopRecord, DesktopStep } from "./claude-desktop.ts";
import {
  desktopBriefText,
  followDesktopSessions,
  OWN_OPEN_MAX_MISSES,
  ownBriefText,
  ownFolderGuard,
  pickDesktopPending,
  prepareOwnWorktrees,
  reviveScreenFailures,
  runDesktopWork,
  WRONG_FOLDER_ANSWER,
  type DesktopWorkDeps,
  type OwnWorktreeDeps,
} from "./desktop-work.ts";

// Lote X through the flow, with a fake app: the create waits for the
// worktree the server makes, opens the app right in it (the app's link, its
// alias), checks the session landed there, and goes back to New Session when
// the worktree could not be made or the app would not open there.

const REPO = "/Users/o/Projetos/nuria-platform";
const PATH = `${REPO}/.claude/worktrees/9353-comprar-assentos`;
const LINK = "/Users/o/.openmausbot/worktree-links/nuria-platform/9353-comprar-assentos";
const LOCAL = "local_0a000009-0000-4000-8000-000000000000";

function harness(prepare?: OwnWorktreeDeps["prepare"], blocked: string | null = null) {
  let now = Date.parse("2026-10-04T13:00:00Z");
  const ledger = new CcSessionLedger({ path: null, now: () => now });
  const records = new Map<string, DesktopRecord>();
  const byMarker = new Map<string, DesktopRecord>();
  const chips: Array<{ id: string; text: string; ok: boolean }> = [];
  const reports: Array<{ id: string; text: string }> = [];
  const logs: string[] = [];
  const results: DesktopStep[] = [];
  const next = (): DesktopStep => results.shift() ?? { ok: true };
  const steps = { openIn: vi.fn(async () => next()), create: vi.fn(async () => next()), send: vi.fn(async () => next()), archive: vi.fn(async () => next()), rename: vi.fn(async () => next()) };
  const own: OwnWorktreeDeps = {
    prepare: prepare ?? (async () => ({ ok: true, head: "abc1234567", link: LINK, caches: { mode: "cloned", dirs: ["node_modules"], savedKb: 1_500_000, savedMs: 840_000, ms: 40_000 } })),
    briefFor: (session) => ownBriefText(session.title, session.desktop!.marker, session.desktop!.own!.brief, "", session.desktop!.own!, "CACHES"),
    classicBlocked: () => blocked,
  };
  const deps: DesktopWorkDeps = {
    ledger,
    now: () => now,
    getDriver: async () => ({}) as never,
    readRecord: (localId) => records.get(localId) ?? null,
    findSession: (marker) => byMarker.get(marker) ?? null,
    transcriptOf: () => null,
    lastText: () => "",
    turnEnded: () => false,
    mentions: () => false,
    writtenAt: () => null,
    repoName: () => "nuria-platform",
    pathExists: () => true,
    folderBornAt: () => null,
    folderUsers: () => [],
    chip: (session, text, ok = true) => { chips.push({ id: session.id, text, ok }); },
    report: (session, text) => { reports.push({ id: session.id, text }); },
    log: (line) => { logs.push(line); },
    own,
    steps,
  };
  const start = (id = "s1"): CcSession => {
    const session = ledger.create({ id, ownerBotId: "chief", ownerThreadId: "t", title: "9353 Comprar assentos", repo: REPO, permissionMode: "auto", surface: "app", desktop: { marker: `OMB${id.toUpperCase()}`, turnsSeen: 0, issue: "9353", folderGuarded: true } });
    const classicText = desktopBriefText(session.title, session.desktop!.marker, "faça X", "", now);
    session.desktop!.pending = { kind: "create", text: classicText, since: now, attempts: 0 };
    session.desktop!.own = { path: PATH, branch: "omb/9353-comprar-assentos", state: "planned", brief: "faça X", classicText };
    session.status = "running";
    return session;
  };
  return {
    deps, ledger, records, byMarker, chips, reports, logs, results, steps, start,
    prepareState: { preparing: false }, state: { busy: false },
    get now() { return now; }, advance(ms: number) { now += ms; },
  };
}

describe("the brief of a session in the server's own worktree", () => {
  it("checks that very folder (pwd -P, the alias resolved) and says what to do with dependencies", () => {
    const guard = ownFolderGuard(PATH, "omb/9353-x", "CACHES");
    expect(guard).toContain(`Rode \`pwd -P\`. Se a saída não for exatamente ${PATH}, pare aí: responda só "${WRONG_FOLDER_ANSWER}: <a saída do pwd>"`);
    expect(guard).toContain("na branch omb/9353-x");
    expect(guard.endsWith("CACHES")).toBe(true);
    const text = ownBriefText("9353 Comprar", "OMBX", "faça X", "\n\nfooter", { path: PATH, branch: "omb/9353-x" }, "CACHES");
    expect(text.startsWith("9353 Comprar\n[OMBX]\n\nPasso 0")).toBe(true);
    expect(text.endsWith("faça X\n\nfooter")).toBe(true);
  });
});

describe("a create with a worktree of the server's", () => {
  it("waits while the worktree is made, then opens the app in it through the alias, with the exact folder check", async () => {
    const h = harness();
    const session = h.start();
    expect(pickDesktopPending(h.ledger.all(), h.now)).toBeNull();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    expect(session.desktop!.own).toMatchObject({ state: "ready", head: "abc1234567", link: LINK, caches: { mode: "cloned", savedKb: 1_500_000 } });
    expect(session.desktop!.pending!.text).toContain(`exatamente ${PATH}`);
    expect(session.desktop!.pending!.text).toContain("CACHES");
    expect(h.chips.at(-1)!.text).toContain(`worktree criada pelo OMB: ${PATH} (omb/9353-comprar-assentos); dependências clonadas da semente (1 pasta(s), ~1465 MB sem ocupar disco)`);
    expect(pickDesktopPending(h.ledger.all(), h.now)?.id).toBe("s1");
    await runDesktopWork(h.deps, h.state);
    expect(h.steps.create).not.toHaveBeenCalled();
    expect(h.steps.openIn).toHaveBeenCalledWith({}, { folder: LINK, folderName: "9353-comprar-assentos", text: session.desktop!.pending?.text ?? expect.any(String) });
    expect(session.desktop!.sentAt).toBe(h.now);
  });

  it("adopts the session the app opened there (its record names the worktree) and nobody else's", async () => {
    const h = harness();
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    await runDesktopWork(h.deps, h.state);
    h.byMarker.set(session.desktop!.marker, { sessionId: LOCAL, cliSessionId: "cli-1", cwd: PATH, createdAt: h.now });
    h.records.set(LOCAL, { sessionId: LOCAL, cliSessionId: "cli-1", cwd: PATH, createdAt: h.now, completedTurns: 0 });
    followDesktopSessions(h.deps);
    expect(session.status).toBe("running");
    expect(session).toMatchObject({ cwd: PATH, worktree: "9353-comprar-assentos" });
    expect(session.desktop!.wrongFolder).toBeUndefined();
    expect(h.chips.at(-1)!.text).toBe("aberta no app Claude, na worktree que o OMB criou (9353-comprar-assentos)");
  });

  it.each([
    ["the repository root", { cwd: REPO }, `in ${REPO} instead`],
    ["a worktree the app made inside it", { cwd: `${PATH}/.claude/worktrees/x`, worktreePath: `${PATH}/.claude/worktrees/x`, worktreeName: "x" }, `in ${PATH}/.claude/worktrees/x instead`],
    ["another session's worktree", { cwd: `${REPO}/.claude/worktrees/atendimento-reaberto-bugs-496989` }, "atendimento-reaberto-bugs-496989 instead"],
  ])("fails for good when the app opened it in %s; the worktree it made stays", async (_name, where, said) => {
    const h = harness();
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    await runDesktopWork(h.deps, h.state);
    h.byMarker.set(session.desktop!.marker, { sessionId: LOCAL, cliSessionId: "cli-1", createdAt: h.now, ...where });
    followDesktopSessions(h.deps);
    expect(session.status).toBe("failed");
    expect(session.desktop!.wrongFolder).toBeTruthy();
    expect(session.lastError).toContain(`should have opened in the worktree the server made for it (${PATH})`);
    expect(session.lastError).toContain(said);
    expect(session.lastError).toContain("The worktree the server made stays as it is (the server never removes one)");
    // never revived as a screen failure
    expect(reviveScreenFailures({ ledger: h.ledger, readRecord: () => ({ sessionId: LOCAL, cliSessionId: "c" }), chip: () => {} })).toEqual([]);
  });

  it("fails when another session already works in the worktree", async () => {
    const h = harness();
    const session = h.start();
    h.deps.folderUsers = () => ["Aumentar usuários Piperun para 50"];
    await prepareOwnWorktrees(h.deps, h.prepareState);
    await runDesktopWork(h.deps, h.state);
    h.byMarker.set(session.desktop!.marker, { sessionId: LOCAL, cliSessionId: "cli-1", cwd: PATH, createdAt: h.now });
    followDesktopSessions(h.deps);
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain('in it together with "Aumentar usuários Piperun para 50" (app)');
  });

  it("goes back to New Session, with the old folder check, after the app would not open there a few times", async () => {
    const h = harness();
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    for (let i = 0; i < OWN_OPEN_MAX_MISSES; i++) {
      h.results.push({ ok: false, reason: "the new session does not show the folder 9353-comprar-assentos in its chips; nothing was typed", retry: true, miss: true, touched: true, seen: "• Local | nuria-platform" });
      await runDesktopWork(h.deps, h.state);
      h.advance(11 * 60_000);
    }
    expect(h.steps.openIn).toHaveBeenCalledTimes(OWN_OPEN_MAX_MISSES);
    expect(session.desktop!.own).toMatchObject({ state: "abandoned" });
    expect(session.desktop!.own!.reason).toContain("does not show the folder");
    expect(session.desktop!.pending).toMatchObject({ kind: "create", text: session.desktop!.own!.classicText, attempts: 0 });
    expect(h.chips.at(-1)!.text).toContain("abrindo pelo jeito antigo (Nova sessão)");
    await runDesktopWork(h.deps, h.state);
    expect(h.steps.create).toHaveBeenCalledTimes(1);
    expect(session.status).toBe("running");
  });

  it("fails with the 409's words when the worktree could not be made and New Session would land in a wrong folder now", async () => {
    const h = harness(async () => ({ ok: false, reason: "git worktree add: invalid reference: origin/main" }), "não abri: a sessão mais recente do app Claude abriu em …");
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    expect(session.desktop!.own).toMatchObject({ state: "failed", reason: "git worktree add: invalid reference: origin/main" });
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain("não consegui criar a worktree da sessão (git worktree add: invalid reference: origin/main); and New Session, the old way, would land in a wrong folder now — não abri:");
    expect(h.steps.create).not.toHaveBeenCalled();
  });

  it("goes on through New Session when the worktree could not be made and the app is free", async () => {
    const h = harness(async () => { throw new Error("git: not found"); });
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    expect(session.desktop!.own).toMatchObject({ state: "failed", reason: "git: not found" });
    expect(session.desktop!.pending!.text).toBe(session.desktop!.own!.classicText);
    await runDesktopWork(h.deps, h.state);
    expect(h.steps.create).toHaveBeenCalledTimes(1);
    expect(h.steps.openIn).not.toHaveBeenCalled();
  });

  it("leaves what it made as it is when the session was stopped meanwhile, and makes one worktree at a time", async () => {
    let release: () => void = () => {};
    const h = harness(() => new Promise((resolve) => { release = () => resolve({ ok: true, head: "h", link: LINK, caches: { mode: "install", reason: "x", dirs: [] } }); }));
    const session = h.start();
    h.start("s2").desktop!.own!.path = `${PATH}-2`;
    const first = prepareOwnWorktrees(h.deps, h.prepareState);
    await prepareOwnWorktrees(h.deps, h.prepareState); // busy: does nothing
    session.status = "stopped";
    release();
    await first;
    expect(session.desktop!.own!.state).toBe("planned");
    expect(h.logs.at(-1)).toContain("which no longer waits to open; left as it is");
    expect(h.prepareState.preparing).toBe(false);
  });
});
