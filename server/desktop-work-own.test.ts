import { describe, expect, it, vi } from "vitest";
import { sessionErrorPt } from "../shared/session-error-pt.ts";
import { CcSessionLedger, type CcSession } from "./cc-sessions.ts";
import type { DesktopRecord, DesktopStep } from "./claude-desktop.ts";
import {
  DESKTOP_MAX_MISSES,
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
const LINK = "/Users/o/Projetos/.omb-worktree-links/nuria-platform/9353-comprar-assentos";
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
    // with the worktree's own path, by which a "trust this workspace" prompt is judged ours
    expect(h.steps.openIn).toHaveBeenCalledWith({}, { folder: LINK, folderName: "9353-comprar-assentos", text: session.desktop!.pending?.text ?? expect.any(String), expected: PATH, registered: expect.any(Function), trustClicks: 0 });
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

  it("tells the breaker of every session that landed elsewhere (a worktree the app made inside ours), and of every one adopted right (R11-1)", async () => {
    const h = harness();
    const wrong: Array<[string, string]> = [];
    const adopted: string[] = [];
    h.deps.own!.wrongFolder = (session, folder) => { wrong.push([session.id, folder]); };
    h.deps.own!.adopted = (session) => { adopted.push(session.id); };
    const bad = h.start("s1");
    await prepareOwnWorktrees(h.deps, h.prepareState);
    await runDesktopWork(h.deps, h.state);
    h.byMarker.set(bad.desktop!.marker, { sessionId: LOCAL, cliSessionId: "cli-1", createdAt: h.now, cwd: `${PATH}/.claude/worktrees/app-1`, worktreePath: `${PATH}/.claude/worktrees/app-1`, worktreeName: "app-1" });
    followDesktopSessions(h.deps);
    expect(wrong).toEqual([["s1", `${PATH}/.claude/worktrees/app-1`]]);
    expect(adopted).toEqual([]);
    const good = h.start("s2");
    good.desktop!.own!.path = `${PATH}-2`;
    await prepareOwnWorktrees(h.deps, h.prepareState);
    await runDesktopWork(h.deps, h.state);
    h.byMarker.set(good.desktop!.marker, { sessionId: "local_0a00000b-0000-4000-8000-000000000000", cliSessionId: "cli-2", createdAt: h.now, cwd: `${PATH}-2` });
    followDesktopSessions(h.deps);
    expect(adopted).toEqual(["s2"]);
    expect(wrong).toHaveLength(1);
  });

  it("a create given up for the worktree option ON (or unreadable) is told to the breaker, with what the screen showed (R12-1)", async () => {
    const h = harness();
    const refused: Array<[string, string, string | undefined]> = [];
    h.deps.own!.chipRefused = (session, option, seen) => { refused.push([session.id, option, seen]); };
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    for (let i = 0; i < OWN_OPEN_MAX_MISSES; i++) {
      h.results.push({ ok: false, reason: "the new session has the worktree option ON; nothing was typed", retry: true, miss: true, touched: true, seen: "• Local | 9353-comprar-assentos | v worktree", worktreeOption: "on" });
      await runDesktopWork(h.deps, h.state);
      h.advance(11 * 60_000);
    }
    expect(session.desktop!.own!.state).toBe("abandoned");
    expect(refused).toEqual([["s1", "on", "• Local | 9353-comprar-assentos | v worktree"]]);
    // a miss for another reason is not the chip's
    const h2 = harness();
    const other: string[] = [];
    h2.deps.own!.chipRefused = (each) => { other.push(each.id); };
    h2.start();
    await prepareOwnWorktrees(h2.deps, h2.prepareState);
    for (let i = 0; i < OWN_OPEN_MAX_MISSES; i++) {
      h2.results.push({ ok: false, reason: "the new session does not show the folder", retry: true, miss: true, touched: true });
      await runDesktopWork(h2.deps, h2.state);
      h2.advance(11 * 60_000);
    }
    expect(other).toEqual([]);
  });

  it("a workspace the app asks to trust and the server may not: the person is asked once, the create waits (no miss), and the item closes once it opens (R12-visual N20)", async () => {
    const h = harness();
    const asked: Array<{ key: string; title: string }> = [];
    const resolved: string[] = [];
    h.deps.ownerPending = (_session, item) => { asked.push({ key: item.key, title: item.title }); };
    h.deps.resolveOwnerPending = (key) => { resolved.push(key); };
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    const prompt = { ok: false as const, reason: "the app asks to trust the workspace …; nothing was clicked or typed", retry: true, touched: true, trustNeeded: "/Users/o/Projetos/outro" };
    h.results.push(prompt);
    await runDesktopWork(h.deps, h.state);
    expect(asked).toEqual([{ key: "cc-trust:s1", title: 'Confiar no workspace /Users/o/Projetos/outro no app Claude (a sessão "9353 Comprar assentos" espera por isso)' }]);
    expect(session.desktop!.pending).toMatchObject({ kind: "create", attempts: 0 });
    expect(session.desktop!.pending!.misses).toBeUndefined();
    expect(session.desktop!.pending!.nextAttemptAt).toBe(h.now + 20 * 60_000);
    h.advance(21 * 60_000);
    h.results.push(prompt);
    await runDesktopWork(h.deps, h.state);
    expect(asked).toHaveLength(1); // once
    h.advance(21 * 60_000);
    await runDesktopWork(h.deps, h.state); // ok now
    expect(session.desktop!.sentAt).toBe(h.now);
    expect(resolved).toContain("cc-trust:s1");
  });

  it("gives up after 2 h without an answer to the trust question, and the item says so (INSP-R12a X3-3)", async () => {
    const h = harness();
    const asked: Array<{ key: string; title: string }> = [];
    h.deps.ownerPending = (_session, item) => { asked.push({ key: item.key, title: item.title }); };
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    const prompt = { ok: false as const, reason: "the app asks to trust the workspace …", retry: true, touched: true, trustNeeded: "/Users/o/Projetos/outro" };
    for (let i = 0; i < 6; i++) {
      h.results.push(prompt);
      await runDesktopWork(h.deps, h.state);
      expect(session.status).toBe("running");
      h.advance(21 * 60_000);
    }
    h.results.push(prompt);
    await runDesktopWork(h.deps, h.state);
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain("asked to trust the workspace /Users/o/Projetos/outro and nobody answered in 2 h");
    expect(asked.map((each) => each.key)).toEqual(["cc-trust:s1", "cc-trust:s1"]);
    expect(asked[1]!.title).toContain("desistiu de abrir no app Claude: ninguém respondeu ao pedido de confiar no workspace");
  });

  it("does not keep a worktree-option reading from an earlier miss when the next miss has another cause (INSP-R12a X3-5)", async () => {
    const h = harness();
    const refused: string[] = [];
    h.deps.own!.chipRefused = (session) => { refused.push(session.id); };
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    h.results.push({ ok: false, reason: "the new session has the worktree option ON; nothing was typed", retry: true, miss: true, touched: true, seen: "v worktree", worktreeOption: "on" });
    for (let i = 0; i < OWN_OPEN_MAX_MISSES - 1; i++) h.results.push({ ok: false, reason: "the new session does not show the folder", retry: true, miss: true, touched: true });
    for (let i = 0; i < OWN_OPEN_MAX_MISSES; i++) {
      await runDesktopWork(h.deps, h.state);
      if (i === 0) expect(session.desktop!.pending!.worktreeOption).toBe("on");
      if (i === 1) expect(session.desktop!.pending!.worktreeOption).toBeUndefined();
      h.advance(11 * 60_000);
    }
    expect(session.desktop!.own!.state).toBe("abandoned");
    // given up for the folder chip, not for the option: the breaker is not told "option ON"
    expect(refused).toEqual([]);
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

// R13-dispatch: 06/10, 15 creates through the server's worktree, 1 in the
// right folder. What the screen showed (server.log, the ledger's own.reason).
const REAL_NO_FIELD = "the app's link did not open a new session for 9032-equipe-em-massa-tickets-n1 (no empty task field); nothing was clicked or typed";
const REAL_NO_FIELD_SEEN = "Never skip, bypass or fake the gate; never push to main, never force. | Order of a batch: hotfix/PO/P1 first, ahead of any Cl or infrastructure PR, and released on its | own. PRs that change release scripts (scripts/*release*, watch-production-release, release- | carrier) ship in a separate carrier ";
const REAL_PREVIOUS_CHIP = "the new session does not show the folder 9384-hook-v2-7-c2b-append-atendimento-b7fcd0 in its chips; nothing was clicked or typed";
const REAL_PREVIOUS_CHIP_SEEN = "• Local | • 9378-supervisor-papel-… | 2º omb/9378-supervisor-papel-b... | IO worktree | Descreva uma tarefa ou faça uma pergunta | + O v";

describe("the server's worktree given up on the real screens of 06/10 (R13-dispatch R13-2)", () => {
  /** Three misses of the link: the create gives the path up. */
  async function abandon(h: ReturnType<typeof harness>, reason: string, seen: string) {
    await prepareOwnWorktrees(h.deps, h.prepareState);
    for (let i = 0; i < OWN_OPEN_MAX_MISSES; i++) {
      h.results.push({ ok: false, reason, retry: true, miss: true, touched: true, seen });
      await runDesktopWork(h.deps, h.state);
      h.advance(11 * 60_000);
    }
  }

  it.each([
    ["the link opened no new session (#9032, 0e2ba7eb and 7d8a26ca)", REAL_NO_FIELD, REAL_NO_FIELD_SEEN],
    ["the chips showed the previous folder (#9384, b3a17a95)", REAL_PREVIOUS_CHIP, REAL_PREVIOUS_CHIP_SEEN],
  ])("counts every give-up in the breaker: %s", async (_name, reason, seen) => {
    const h = harness();
    const counted: Array<[string, string, string | undefined]> = [];
    const chip: string[] = [];
    h.deps.own!.abandoned = (session, why, shown) => { counted.push([session.id, why, shown]); };
    h.deps.own!.chipRefused = (session) => { chip.push(session.id); };
    const session = h.start();
    await abandon(h, reason, seen);
    expect(session.desktop!.own!.state).toBe("abandoned");
    expect(counted).toEqual([["s1", reason, seen]]);
    expect(chip).toEqual([]);
  });

  it("both ways of the app fail (the link, then New Session): the same brief goes to the cli at once, the failure on record first, one report that says so", async () => {
    const h = harness();
    const handed: Array<{ id: string; status: string; failedAt?: number; why: string }> = [];
    h.deps.own!.toCli = (session, why) => { handed.push({ id: session.id, status: session.status, failedAt: session.failedAt, why }); return { sessionId: "cli-9032" }; };
    const session = h.start();
    await abandon(h, REAL_NO_FIELD, REAL_NO_FIELD_SEEN);
    // New Session, the old way: the same conversation on screen, five misses
    for (let i = 0; i < DESKTOP_MAX_MISSES; i++) {
      h.results.push({ ok: false, reason: "New Session did not show a new session's screen (no empty task field and no folder chips; the screen shows a conversation); nothing was typed", retry: true, miss: true, touched: true, seen: REAL_NO_FIELD_SEEN });
      await runDesktopWork(h.deps, h.state);
      h.advance(31 * 60_000);
    }
    expect(h.steps.create).toHaveBeenCalledTimes(DESKTOP_MAX_MISSES);
    // handed over once, already failed (it is what frees the cli: R13-1)
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ id: "s1", status: "failed", failedAt: expect.any(Number) });
    expect(handed[0]!.why).toContain("the app did not open the session in the worktree the server made");
    expect(handed[0]!.why).toContain("New Session failed too");
    expect(session.status).toBe("failed");
    expect(session.desktop!.cliFallback).toMatchObject({ sessionId: "cli-9032" });
    expect(session.lastError).toContain("the server started the same brief in the CLI as session cli-9032");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toContain("cli-9032");
    expect(h.logs.some((line) => line.includes("failed both ways of the app — started in the cli as cli-9032"))).toBe(true);
  });

  it("New Session barred right after the link failed is both ways failed too; a cli refusal is said, not hidden", async () => {
    const h = harness(undefined, "não abri: a sessão mais recente do app Claude abriu em …");
    h.deps.own!.toCli = () => ({ refusal: "busy" });
    const session = h.start();
    await abandon(h, REAL_NO_FIELD, REAL_NO_FIELD_SEEN);
    expect(session.status).toBe("failed");
    expect(session.desktop!.cliFallback).toMatchObject({ refusal: "busy" });
    expect(session.lastError).toContain("could not start the same brief in the CLI: busy");
  });

  it("a worktree never made is not the app failing: New Session barred fails as before, nothing goes to the cli", async () => {
    const h = harness(async () => ({ ok: false, reason: "git worktree add: invalid reference: origin/main" }), "não abri: …");
    const toCli = vi.fn(() => ({ sessionId: "x" }));
    h.deps.own!.toCli = toCli;
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    expect(session.status).toBe("failed");
    expect(toCli).not.toHaveBeenCalled();
  });

  it("New Session that fails on its own (no worktree of the server's tried) does not go to the cli", async () => {
    const h = harness(async () => { throw new Error("git: not found"); });
    const toCli = vi.fn(() => ({ sessionId: "x" }));
    h.deps.own!.toCli = toCli;
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    h.results.push({ ok: false, reason: "invalid", retry: false });
    await runDesktopWork(h.deps, h.state);
    expect(session.status).toBe("failed");
    expect(toCli).not.toHaveBeenCalled();
  });
});

describe("a \"trust this workspace\" click (R13-dispatch R13-3)", () => {
  const TRUSTED = { ok: false as const, reason: "trusted the workspace 9353-comprar-assentos; nothing was typed — the app's link is opened again and the folder checked before the brief goes in", retry: true, touched: true, trusted: true };

  it("is no miss: the link is opened again on the next try, and the brief goes in only then", async () => {
    const h = harness();
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    h.results.push(TRUSTED);
    await runDesktopWork(h.deps, h.state);
    expect(session.desktop!.pending).toMatchObject({ kind: "create", trustClicks: 1, attempts: 1 });
    expect(session.desktop!.pending!.misses).toBeUndefined();
    expect(h.chips.at(-1)!.text).toContain("reabrindo o link e conferindo a pasta antes de colar");
    h.advance(11 * 60_000);
    await runDesktopWork(h.deps, h.state); // ok: the second open of the link
    expect(h.steps.openIn).toHaveBeenCalledTimes(2);
    expect(session.desktop!.sentAt).toBe(h.now);
  });

  it("one click per create: the next try is told it clicked, and the prompt or a scratch then (cliNow) sends it to the cli at once (INSP-R13dis 5)", async () => {
    const h = harness();
    const started: string[] = [];
    h.deps.own!.toCli = (session) => { started.push(session.id); return { sessionId: "cli-again" }; };
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    h.results.push(TRUSTED);
    await runDesktopWork(h.deps, h.state);
    h.advance(31 * 60_000);
    h.results.push({ ok: false, reason: "the app asks to trust the workspace 9353-comprar-assentos again after the server clicked it once in this create; no second click — the create goes on in the cli", retry: true, miss: true, touched: true, cliNow: true });
    await runDesktopWork(h.deps, h.state);
    expect(h.steps.openIn.mock.calls.map((call) => (call as unknown as [unknown, { trustClicks: number }])[1].trustClicks)).toEqual([0, 1]);
    expect(session.desktop!.own!.state).toBe("abandoned");
    expect(session.status).toBe("failed");
    expect(started).toEqual(["s1"]);
    expect(h.steps.create).not.toHaveBeenCalled();
  });
});

// INSP-R13dis 1/7: the chips on the folder before — no click ever fixes a
// link that reuses it — go to the cli on the FIRST such give-up: no 3 misses,
// no New Session, no new worktree per try. The 10 real screens of 05–06/10.
const REAL_PREVIOUS_10: Array<[string, string]> = [
  ["2f2ec068", "• Local | • 9378-supervisor-do-ate…. | 2º omb/9378-supervisor-do-aten... 1O worktree | Descreva uma tarefa ou faça uma pergunta"],
  ["035161dc", "• Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta"],
  ["e712f070", "• Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta"],
  ["e712f070", "• Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta"],
  ["e712f070", "• Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta"],
  ["e0d7126a", "• Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta"],
  ["e0d7126a", "• Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta"],
  ["e0d7126a", "• Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta"],
  ["b23900b6", "• Local | • 9337-sobrecarga-d1-no-….. | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta"],
  ["b7fcd057", "• Local | • nuria-platform | gº main |O worktree | Descreva uma tarefa ou faça uma pergunta"],
];

describe("the chips on the folder before: the cli on the first such give-up (INSP-R13dis 1, 6, 7)", () => {
  it.each(REAL_PREVIOUS_10)("%s: no click, no 2nd try, no New Session — the breaker counts it and the same brief goes to the cli; the chip says so in pt-BR", async (_session, seen) => {
    const h = harness();
    const counted: string[] = [];
    const handed: string[] = [];
    h.deps.own!.abandoned = (session, reason) => { counted.push(`${session.id}: ${reason}`); };
    h.deps.own!.toCli = (_session, why) => { handed.push(why); return { sessionId: "c11a0000-0000-4000-8000-000000000000" }; };
    const session = h.start();
    await prepareOwnWorktrees(h.deps, h.prepareState);
    const reason = "the new session shows another folder in its chips (the folder before), not 9353-comprar-assentos; nothing was clicked or typed";
    h.results.push({ ok: false, reason, retry: true, miss: true, touched: true, previousFolder: true, seen: `Confiar no workspace | ${seen}` });
    await runDesktopWork(h.deps, h.state);
    expect(h.steps.openIn).toHaveBeenCalledTimes(1);
    expect(h.steps.create).not.toHaveBeenCalled();
    expect(session.desktop!.own!.state).toBe("abandoned");
    expect(counted).toEqual([`s1: ${reason}`]);
    expect(handed).toEqual([`the app did not open the session in the worktree the server made: ${reason}`]);
    expect(session.status).toBe("failed");
    expect(session.desktop!.cliFallback).toMatchObject({ sessionId: "c11a0000-0000-4000-8000-000000000000" });
    expect(session.lastError).toContain("The Claude app did not open the session in the right folder, so the server started the same brief in the CLI as session c11a0000-0000-4000-8000-000000000000;");
    expect(h.chips.map((chip) => chip.text)).toEqual(expect.arrayContaining([
      "parou com um problema — o app abriu a sessão nova na pasta anterior, não na worktree do OMB",
      "o app não abriu na pasta certa; segui pela linha de comando (sessão c11a0000)",
    ]));
    expect(sessionErrorPt(session.lastError!)).toBe("o app não abriu na pasta certa; segui pela linha de comando (sessão c11a0000)");
    expect(h.reports).toHaveLength(1);
  });
});
