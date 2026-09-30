import { describe, expect, it, vi } from "vitest";
import { CcSessionLedger, type CcSession } from "./cc-sessions.ts";
import type { DesktopRecord, DesktopStep } from "./claude-desktop.ts";
import {
  CC_ACTIVE_MS,
  CC_STALL_MS,
  DESKTOP_ARCHIVE_CONFIRM_MS,
  DESKTOP_ARCHIVE_MAX_TRIES,
  DESKTOP_MAX_MISSES,
  DESKTOP_SEND_CONFIRM_MS,
  DESKTOP_SEND_MAX_DELIVERIES,
  ccSessionActive,
  desktopBackoffMs,
  desktopBriefText,
  followDesktopSessions,
  pickDesktopPending,
  runDesktopWork,
  watchStalledSessions,
  type DesktopWorkDeps,
} from "./desktop-work.ts";

const LOCAL = "local_9d56adfd-0000-4000-8000-000000000000";
const WORKTREE = "/Users/o/Projetos/nuria-platform/.claude/worktrees/helpdesk-f30521";

/** The ledger, the app's records and transcripts, and a scripted screen. */
function harness() {
  let now = Date.parse("2026-09-29T19:30:00Z");
  const ledger = new CcSessionLedger({ path: null, now: () => now });
  const records = new Map<string, DesktopRecord>();
  const byMarker = new Map<string, DesktopRecord>();
  const transcripts = new Map<string, { text: string; writtenAt: number }>();
  const chips: Array<{ id: string; text: string; ok: boolean }> = [];
  const reports: Array<{ id: string; text: string }> = [];
  const results: DesktopStep[] = [];
  const next = (): DesktopStep => results.shift() ?? { ok: true };
  const steps = { create: vi.fn(async () => next()), send: vi.fn(async () => next()), archive: vi.fn(async () => next()) };
  const deps: DesktopWorkDeps = {
    ledger,
    now: () => now,
    getDriver: async () => ({}) as never,
    readRecord: (localId) => records.get(localId) ?? null,
    findSession: (marker) => byMarker.get(marker) ?? null,
    transcriptOf: (cli) => (transcripts.has(cli) ? cli : null),
    lastText: (cli) => transcripts.get(cli)?.text.split("\n").at(-1) ?? "",
    mentions: (cli, text) => transcripts.get(cli)?.text.includes(text.split("\n")[0]!) ?? false,
    writtenAt: (cli) => transcripts.get(cli)?.writtenAt ?? null,
    repoName: () => "nuria-platform",
    chip: (session, text, ok = true) => { chips.push({ id: session.id, text, ok }); },
    report: (session, text) => { reports.push({ id: session.id, text }); },
    steps,
  };
  const state = { busy: false };
  const appSession = (id: string, extra: Partial<CcSession["desktop"]> = {}): CcSession => {
    const session = ledger.create({ id, ownerBotId: "chief", ownerThreadId: "t-owner", title: `#${id}`, repo: "/Users/o/Projetos/nuria-platform", permissionMode: "auto", surface: "app", desktop: { marker: `OMB${id.toUpperCase()}`, turnsSeen: 0, ...extra } });
    session.status = "running";
    return session;
  };
  const opened = (id: string, record: Partial<DesktopRecord> = {}): CcSession => {
    const session = appSession(id, { localId: LOCAL, cliSessionId: `cli-${id}`, sentAt: now });
    records.set(LOCAL, { sessionId: LOCAL, cliSessionId: `cli-${id}`, cwd: WORKTREE, completedTurns: 0, latestUserFrameAt: now, lastActivityAt: now, ...record });
    transcripts.set(`cli-${id}`, { text: "brief", writtenAt: now });
    return session;
  };
  return {
    deps, state, ledger, records, byMarker, transcripts, chips, reports, results, steps, appSession, opened,
    get now() { return now; },
    advance(ms: number) { now += ms; },
    tick: () => runDesktopWork(deps, state),
  };
}

describe("the brief", () => {
  it("opens with the title and its issue number, the marker on its own line", () => {
    expect(desktopBriefText("automação inatividade não dispara", "OMBX", "Issue: https://github.com/o/r/issues/9298\nFaça X")).toBe("#9298 automação inatividade não dispara\n[OMBX]\n\nIssue: https://github.com/o/r/issues/9298\nFaça X");
    expect(desktopBriefText("#9300 gate", "OMBY", "ver #9299", "\n\nfooter")).toBe("#9300 gate\n[OMBY]\n\nver #9299\n\nfooter");
    expect(desktopBriefText("limpeza", "OMBZ", "sem número").split("\n")[0]).toBe("limpeza");
  });
});

describe("backoff and the queue", () => {
  it("backs off 30s, doubling, up to 10 minutes", () => {
    expect(desktopBackoffMs(1)).toBe(30_000);
    expect(desktopBackoffMs(2)).toBe(60_000);
    expect(desktopBackoffMs(5)).toBe(480_000);
    expect(desktopBackoffMs(9)).toBe(600_000);
  });

  it("takes the oldest action that may run now, so one stuck action does not block the rest", () => {
    const h = harness();
    const stuck = h.appSession("a");
    stuck.desktop!.pending = { kind: "create", text: "a", since: h.now - 60_000, attempts: 3, nextAttemptAt: h.now + 120_000 };
    const ready = h.appSession("b");
    ready.desktop!.pending = { kind: "create", text: "b", since: h.now, attempts: 0 };
    expect(pickDesktopPending(h.ledger.all(), h.now)?.id).toBe("b");
    h.advance(120_000);
    expect(pickDesktopPending(h.ledger.all(), h.now)?.id).toBe("a");
  });

  it("backs off after a try that touched the screen, and not while it only waits for an idle Mac", async () => {
    const h = harness();
    const session = h.appSession("a");
    session.desktop!.pending = { kind: "create", text: "brief", since: h.now, attempts: 0 };
    h.results.push({ ok: false, reason: "the Mac is in use", retry: true });
    await h.tick();
    expect(session.desktop!.pending).toMatchObject({ attempts: 0, lastReason: "the Mac is in use" });
    expect(session.desktop!.pending!.nextAttemptAt).toBeUndefined();
    h.results.push({ ok: false, reason: "the Claude app lost focus", retry: true, touched: true });
    await h.tick();
    expect(session.desktop!.pending).toMatchObject({ attempts: 1, nextAttemptAt: h.now + 30_000 });
    await h.tick();
    expect(h.steps.create).toHaveBeenCalledTimes(2);
  });
});

describe("opening a session", () => {
  it("create → record → finished turn → queued message goes in next", async () => {
    const h = harness();
    const session = h.appSession("a");
    session.desktop!.pending = { kind: "create", text: "[OMBA] brief", since: h.now, attempts: 0 };
    await h.tick();
    expect(session.desktop).toMatchObject({ sentAt: h.now });
    expect(session.desktop!.pending).toBeUndefined();
    expect(h.chips.at(-1)?.text).toBe("brief sent in the Claude app");

    h.advance(14_000);
    h.byMarker.set("OMBA", { sessionId: LOCAL, cliSessionId: "cli-a", cwd: WORKTREE, completedTurns: 0, permissionMode: "bypassPermissions", worktreeName: "helpdesk-f30521" });
    h.records.set(LOCAL, h.byMarker.get("OMBA")!);
    h.transcripts.set("cli-a", { text: "brief\nworking", writtenAt: h.now });
    followDesktopSessions(h.deps);
    expect(session.desktop).toMatchObject({ localId: LOCAL, cliSessionId: "cli-a", permissionMode: "bypassPermissions" });
    expect(session.worktree).toBe("helpdesk-f30521");
    expect(h.chips.at(-1)?.text).toBe("opened in the Claude app");

    h.ledger.enqueue(session, "now open the PR");
    h.records.get(LOCAL)!.completedTurns = 1;
    h.transcripts.set("cli-a", { text: "brief\nroot cause found", writtenAt: h.now });
    followDesktopSessions(h.deps);
    expect(session.desktop!.pending).toMatchObject({ kind: "send", text: "now open the PR" });
    expect(h.reports).toEqual([]);

    await h.tick();
    expect(h.steps.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ localId: LOCAL, text: "now open the PR" }));
    h.records.get(LOCAL)!.latestUserFrameAt = h.now + 1;
    h.records.get(LOCAL)!.completedTurns = 2;
    h.transcripts.set("cli-a", { text: "brief\nPR #9301 open", writtenAt: h.now });
    followDesktopSessions(h.deps);
    expect(session.desktop!.sent).toBeUndefined();
    expect(session.status).toBe("idle");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toContain("PR #9301 open");
    expect(h.reports[0]!.text).toContain("permission mode bypassPermissions");
  });

  it("fails loudly when the app opened the session outside a worktree", () => {
    const h = harness();
    const session = h.appSession("a", { sentAt: h.now });
    h.byMarker.set("OMBA", { sessionId: LOCAL, cliSessionId: "cli-a", cwd: "/Users/o/Projetos/nuria-platform" });
    followDesktopSessions(h.deps);
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain("outside a git worktree");
    expect(h.reports[0]!.text).toContain("outside a git worktree");
  });

  it("looks for the session a crashed try may have opened before opening another", async () => {
    const h = harness();
    const session = h.appSession("a");
    session.desktop!.pending = { kind: "create", text: "brief", since: h.now, attempts: 0, triedAt: h.now };
    h.byMarker.set("OMBA", { sessionId: LOCAL, cliSessionId: "cli-a", cwd: WORKTREE });
    await h.tick();
    expect(h.steps.create).not.toHaveBeenCalled();
    expect(session.desktop).toMatchObject({ localId: LOCAL, sentAt: h.now });
    expect(session.desktop!.pending).toBeUndefined();
  });

  it("gives up after repeated screens that did not show the repository, with the screen unlocked", async () => {
    const h = harness();
    const session = h.appSession("a");
    session.desktop!.pending = { kind: "create", text: "brief", since: h.now, attempts: 0 };
    for (let i = 0; i < DESKTOP_MAX_MISSES; i++) {
      h.results.push({ ok: false, reason: "the new session did not open in nuria-platform", retry: true, miss: true, touched: true });
      await h.tick();
      h.advance(10 * 60_000);
    }
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain(`after ${DESKTOP_MAX_MISSES} tries`);
  });

  it("archives a session asked to be archived while it was opening, once it opens", () => {
    const h = harness();
    const session = h.appSession("a", { sentAt: h.now, archiveWhenResolved: true });
    h.byMarker.set("OMBA", { sessionId: LOCAL, cliSessionId: "cli-a", cwd: WORKTREE });
    h.records.set(LOCAL, h.byMarker.get("OMBA")!);
    followDesktopSessions(h.deps);
    expect(session.desktop!.pending).toMatchObject({ kind: "archive" });
    expect(session.desktop!.archiveWhenResolved).toBeUndefined();
  });
});

describe("messages", () => {
  it("types a message again when the session never shows it, and fails after 3 tries", async () => {
    const h = harness();
    const session = h.opened("a");
    session.desktop!.pending = { kind: "send", text: "Conferi o c445f4459", since: h.now, attempts: 0 };
    for (let delivery = 1; delivery <= DESKTOP_SEND_MAX_DELIVERIES; delivery++) {
      await h.tick();
      expect(session.desktop!.sent).toMatchObject({ deliveries: delivery });
      h.advance(DESKTOP_SEND_CONFIRM_MS + 1_000);
      followDesktopSessions(h.deps);
    }
    expect(h.steps.send).toHaveBeenCalledTimes(3);
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain("never reached the session");
    expect(h.reports.at(-1)!.text).toContain("Conferi o c445f4459");
  });

  it("counts a message as arrived when the transcript shows it", async () => {
    const h = harness();
    const session = h.opened("a");
    session.desktop!.pending = { kind: "send", text: "Fique parada", since: h.now, attempts: 0 };
    await h.tick();
    h.transcripts.set("cli-a", { text: "brief\nFique parada", writtenAt: h.now });
    h.advance(DESKTOP_SEND_CONFIRM_MS + 1_000);
    followDesktopSessions(h.deps);
    expect(session.desktop!.sent).toBeUndefined();
    expect(session.desktop!.pending).toBeUndefined();
  });

  it("fails an action that needs the app's session when it never opened", async () => {
    const h = harness();
    const session = h.appSession("a");
    session.desktop!.pending = { kind: "send", text: "x", since: h.now, attempts: 0 };
    await h.tick();
    expect(session.status).toBe("failed");
    expect(h.steps.send).not.toHaveBeenCalled();
  });
});

describe("archiving", () => {
  it("waits for the app's record to confirm, clicks again, and fails after 3 unconfirmed clicks", async () => {
    const h = harness();
    const session = h.opened("a");
    session.status = "idle";
    session.desktop!.pending = { kind: "archive", text: "", since: h.now, attempts: 0 };
    for (let click = 1; click <= DESKTOP_ARCHIVE_MAX_TRIES; click++) {
      await h.tick();
      expect(session.desktop!.pending).toMatchObject({ archiveTries: click, verifyUntil: expect.any(Number) });
      await h.tick(); // still verifying: no second click yet
      expect(h.steps.archive).toHaveBeenCalledTimes(click);
      h.advance(DESKTOP_ARCHIVE_CONFIRM_MS + 1_000);
      followDesktopSessions(h.deps);
    }
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain("never marked the session archived");
  });

  it("marks it archived only when the record says so, then lets the worktree go", async () => {
    const h = harness();
    const archived: string[] = [];
    h.deps.onArchived = (s) => archived.push(s.id);
    const session = h.opened("a");
    session.desktop!.pending = { kind: "archive", text: "", since: h.now, attempts: 0 };
    await h.tick();
    expect(session.status).not.toBe("archived");
    h.records.get(LOCAL)!.isArchived = true;
    followDesktopSessions(h.deps);
    expect(session.status).toBe("archived");
    expect(session.desktop!.pending).toBeUndefined();
    expect(archived).toEqual(["a"]);
  });
});

describe("following turns", () => {
  it("reports a turn that ended blocked, with what it needs", () => {
    const h = harness();
    const session = h.opened("a", { postTurnSummary: { status_category: "blocked", needs_action: "the hook denied gh issue comment" } });
    h.records.get(LOCAL)!.completedTurns = 1;
    followDesktopSessions(h.deps);
    expect(session.blockedOn).toBe("the hook denied gh issue comment");
    expect(h.chips.at(-1)).toMatchObject({ ok: false });
    expect(h.reports[0]!.text).toContain("BLOCKED");
  });

  it("reports a running session with no progress once per stall", () => {
    const h = harness();
    const session = h.opened("a");
    h.advance(CC_STALL_MS - 60_000);
    watchStalledSessions(h.deps);
    expect(h.reports).toEqual([]);
    h.advance(2 * 60_000);
    watchStalledSessions(h.deps);
    watchStalledSessions(h.deps);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toMatch(/no progress for 31 min/);
    expect(ccSessionActive(session, h.now)).toBe(true);
    h.advance(CC_ACTIVE_MS);
    expect(ccSessionActive(session, h.now)).toBe(false);
    // it moves again, then stalls again: a new report
    h.transcripts.set("cli-a", { text: "brief\nmore", writtenAt: h.now });
    watchStalledSessions(h.deps);
    h.advance(CC_STALL_MS + 60_000);
    watchStalledSessions(h.deps);
    expect(h.reports).toHaveLength(2);
  });

  it("watches headless sessions by their own transcript too", () => {
    const h = harness();
    const session = h.ledger.create({ id: "cli1", ownerBotId: "chief", ownerThreadId: "t", title: "cli", repo: "/r", permissionMode: "auto", surface: "cli" });
    h.ledger.markRunning(session);
    h.transcripts.set("cli1", { text: "x", writtenAt: h.now + 20 * 60_000 });
    h.advance(CC_STALL_MS + 60_000);
    watchStalledSessions(h.deps);
    expect(h.reports).toEqual([]);
    h.advance(CC_STALL_MS);
    watchStalledSessions(h.deps);
    expect(h.reports[0]!.text).toContain("headless");
  });
});
