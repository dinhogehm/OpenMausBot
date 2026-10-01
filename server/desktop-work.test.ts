import { describe, expect, it, vi } from "vitest";
import { CcSessionLedger, type CcSession } from "./cc-sessions.ts";
import type { DesktopRecord, DesktopStep } from "./claude-desktop.ts";
import {
  CC_STALL_MAX_REPORTS,
  CC_STALL_MS,
  CC_STALL_REMIND_MS,
  DESKTOP_ARCHIVE_CONFIRM_MS,
  DESKTOP_DRAFT_RECHECK_MS,
  DESKTOP_ARCHIVE_MAX_TRIES,
  DESKTOP_MAX_MISSES,
  DESKTOP_SEND_CONFIRM_MS,
  DESKTOP_SUMMARY_WAIT_MS,
  DESKTOP_SEND_MAX_DELIVERIES,
  ccSessionActive,
  desktopBackoffMs,
  desktopBriefText,
  issueNumber,
  followDesktopSessions,
  liveSessionForIssue,
  orphanedIssues,
  reviveScreenFailures,
  ageFailedSessions,
  uniqueSessionTitle,
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
  const transcripts = new Map<string, { text: string; writtenAt: number; ended?: boolean; question?: { id: string; text: string } }>();
  const chips: Array<{ id: string; text: string; ok: boolean }> = [];
  const reports: Array<{ id: string; text: string }> = [];
  const results: DesktopStep[] = [];
  const next = (): DesktopStep => results.shift() ?? { ok: true };
  const steps = { create: vi.fn(async () => next()), send: vi.fn(async () => next()), archive: vi.fn(async () => next()), rename: vi.fn(async () => next()) };
  const deps: DesktopWorkDeps = {
    ledger,
    now: () => now,
    getDriver: async () => ({}) as never,
    readRecord: (localId) => records.get(localId) ?? null,
    findSession: (marker) => byMarker.get(marker) ?? null,
    transcriptOf: (cli) => (transcripts.has(cli) ? cli : null),
    lastText: (cli) => transcripts.get(cli)?.text.split("\n").at(-1) ?? "",
    turnEnded: (cli) => transcripts.get(cli)?.ended ?? false,
    mentions: (cli, text) => transcripts.get(cli)?.text.includes(text.split("\n")[0]!) ?? false,
    writtenAt: (cli) => transcripts.get(cli)?.writtenAt ?? null,
    repoName: () => "nuria-platform",
    pathExists: () => true,
    folderBornAt: () => null,
    openQuestion: (cli) => transcripts.get(cli)?.question ?? null,
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
    expect(h.chips.at(-1)?.text).toBe("brief enviado no app Claude");

    h.advance(14_000);
    h.byMarker.set("OMBA", { sessionId: LOCAL, cliSessionId: "cli-a", cwd: WORKTREE, completedTurns: 0, permissionMode: "bypassPermissions", worktreeName: "helpdesk-f30521" });
    h.records.set(LOCAL, h.byMarker.get("OMBA")!);
    h.transcripts.set("cli-a", { text: "brief\nworking", writtenAt: h.now });
    followDesktopSessions(h.deps);
    expect(session.desktop).toMatchObject({ localId: LOCAL, cliSessionId: "cli-a", permissionMode: "bypassPermissions" });
    expect(session.worktree).toBe("helpdesk-f30521");
    expect(h.chips.at(-1)?.text).toBe("aberta no app Claude");

    h.ledger.enqueue(session, "now open the PR");
    h.records.get(LOCAL)!.completedTurns = 1;
    h.transcripts.set("cli-a", { text: "brief\nroot cause found", writtenAt: h.now });
    followDesktopSessions(h.deps);
    expect(session.desktop!.pending).toMatchObject({ kind: "send", text: "now open the PR" });
    // the owner still hears what that turn said before the queued message goes in
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toContain("root cause found");

    await h.tick();
    expect(h.steps.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ localId: LOCAL, text: "now open the PR" }));
    h.records.get(LOCAL)!.latestUserFrameAt = h.now + 1;
    h.records.get(LOCAL)!.completedTurns = 2;
    h.transcripts.set("cli-a", { text: "brief\nPR #9301 open", writtenAt: h.now });
    followDesktopSessions(h.deps);
    expect(session.desktop!.sent).toBeUndefined();
    expect(session.status).toBe("idle");
    expect(h.reports).toHaveLength(2);
    expect(h.reports[1]!.text).toContain("PR #9301 open");
    expect(h.reports[1]!.text).toContain("permission mode bypassPermissions");
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

  it("refuses a new session that landed in a worktree another session worked in, or one the app did not name", () => {
    for (const [record, other, why] of [
      [{ worktreeName: "helpdesk-f30521" }, "ledger", "the worktree of \"#b\""],
      [{ worktreeName: "helpdesk-f30521" }, "app", "\"Teste de pasta\" (app)"],
      [{}, "", "gave it no worktree name"],
      [{ worktreeName: "helpdesk-f30521" }, "old", "created before the brief was sent"],
    ] as const) {
      const h = harness();
      const session = h.appSession("a", { sentAt: h.now });
      if (other === "ledger") h.appSession("b").cwd = WORKTREE;
      if (other === "app") h.deps.folderUsers = () => ["Teste de pasta"];
      if (other === "old") h.deps.folderBornAt = () => h.now - 3_600_000;
      h.byMarker.set("OMBA", { sessionId: LOCAL, cliSessionId: "cli-a", cwd: WORKTREE, ...record });
      followDesktopSessions(h.deps);
      expect(session.status).toBe("failed");
      expect(session.lastError).toContain(why);
      expect(session.lastError).toContain("stop it in the Claude app");
    }
  });

  it("looks for the session a crashed try may have opened before opening another", async () => {
    const h = harness();
    const session = h.appSession("a");
    session.desktop!.pending = { kind: "create", text: "brief", since: h.now, attempts: 0, triedAt: h.now };
    h.byMarker.set("OMBA", { sessionId: LOCAL, cliSessionId: "cli-a", cwd: WORKTREE, worktreeName: "helpdesk-f30521" });
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
      h.results.push({ ok: false, reason: "the new session did not open in nuria-platform", retry: true, miss: true, touched: true, seen: "OpenMausBot main | worktree" });
      await h.tick();
      h.advance(10 * 60_000);
    }
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain(`after ${DESKTOP_MAX_MISSES} tries`);
    expect(session.lastError).toContain("the screen showed: OpenMausBot main | worktree");
  });

  it("archives a session asked to be archived while it was opening, once it opens", () => {
    const h = harness();
    const session = h.appSession("a", { sentAt: h.now, archiveWhenResolved: true });
    h.byMarker.set("OMBA", { sessionId: LOCAL, cliSessionId: "cli-a", cwd: WORKTREE, worktreeName: "helpdesk-f30521" });
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

describe("sessions left running with no turn coming (#9298)", () => {
  it("takes an app session whose last turn ended long ago as idle and delivers its queue", async () => {
    const h = harness();
    const session = h.opened("a", { completedTurns: 1 });
    session.desktop!.turnsSeen = 1;
    session.turns = 1;
    h.ledger.enqueue(session, "Chief aqui: siga sem o comentário");
    h.transcripts.set("cli-a", { text: "brief\nparei: o Jev negou o comentário", writtenAt: h.now, ended: true });
    h.advance(DESKTOP_SEND_CONFIRM_MS - 60_000);
    followDesktopSessions(h.deps);
    expect(session.desktop!.pending).toBeUndefined(); // too recent to call
    h.advance(2 * 60_000);
    followDesktopSessions(h.deps);
    expect(session.desktop!.pending).toMatchObject({ kind: "send", text: "Chief aqui: siga sem o comentário" });
    expect(session.queued).toEqual([]);
    expect(h.chips.at(-1)).toMatchObject({ ok: false, text: expect.stringContaining("estava parada") });
    expect(h.reports.at(-1)!.text).toContain("found it idle in the app");
    await h.tick();
    expect(h.steps.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: "Chief aqui: siga sem o comentário" }));
  });

  it("leaves a turn that is still open alone", () => {
    const h = harness();
    const session = h.opened("a", { completedTurns: 1 });
    session.desktop!.turnsSeen = 1;
    h.ledger.enqueue(session, "x");
    h.transcripts.set("cli-a", { text: "brief", writtenAt: h.now, ended: false });
    h.advance(10 * 60_000);
    followDesktopSessions(h.deps);
    expect(session.status).toBe("running");
    expect(session.queued.map((item) => item.text)).toEqual(["x"]);
  });

  it("waits for the app's summary of this turn before reporting it blocked (or not)", () => {
    const h = harness();
    const session = h.opened("a", { completedTurns: 1, lastAssistantUuid: "u2", postTurnSummary: { status_category: "blocked", needs_action: "old", summarizes_uuid: "u1" } });
    followDesktopSessions(h.deps);
    expect(h.reports).toEqual([]); // still the previous turn's summary
    h.records.get(LOCAL)!.postTurnSummary = { status_category: "completed", summarizes_uuid: "u2" };
    followDesktopSessions(h.deps);
    expect(h.reports).toHaveLength(1);
    expect(session.blockedOn).toBeUndefined();
  });

  it("reports a turn after a minute even if the summary never catches up, without its stale blocked", () => {
    const h = harness();
    const session = h.opened("a", { completedTurns: 1, lastAssistantUuid: "u2", postTurnSummary: { status_category: "blocked", needs_action: "old", summarizes_uuid: "u1" } });
    followDesktopSessions(h.deps);
    h.advance(DESKTOP_SUMMARY_WAIT_MS + 1_000);
    followDesktopSessions(h.deps);
    expect(h.reports).toHaveLength(1);
    expect(session.blockedOn).toBeUndefined();
  });

  it("states facts in a stall report: turn open, bypass has no approval dialog, queue size", () => {
    const h = harness();
    const session = h.opened("a", { completedTurns: 1 });
    session.desktop!.turnsSeen = 1;
    session.desktop!.permissionMode = "bypassPermissions";
    h.ledger.enqueue(session, "x");
    h.transcripts.set("cli-a", { text: "brief", writtenAt: h.now, ended: false });
    h.advance(CC_STALL_MS + 60_000);
    watchStalledSessions(h.deps);
    const text = h.reports.at(-1)!.text;
    expect(text).toContain("A turn is still open in its transcript");
    expect(text).toContain("no approval dialog");
    expect(text).toContain("1 message(s) are queued");
    expect(text).not.toMatch(/waiting on an approval/);
  });

  it("retries preparing the screen helper with backoff before failing the session", async () => {
    const h = harness();
    h.deps.getDriver = async () => { throw new Error("xcrun: error: invalid active developer path"); };
    const session = h.appSession("a");
    session.desktop!.pending = { kind: "create", text: "brief", since: h.now, attempts: 0 };
    await h.tick();
    expect(session.status).toBe("running");
    expect(session.desktop!.pending).toMatchObject({ helperFailures: 1, nextAttemptAt: h.now + 30_000 });
    h.advance(30_000);
    await h.tick();
    h.advance(60_000);
    await h.tick();
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain("3 tries");
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

  it("marks a session without progress stalled: reported once, no longer active, back to running on any progress", () => {
    const h = harness();
    const session = h.opened("a");
    h.advance(CC_STALL_MS - 60_000);
    watchStalledSessions(h.deps);
    expect(h.reports).toEqual([]);
    expect(ccSessionActive(session, h.now)).toBe(true);
    h.advance(2 * 60_000);
    watchStalledSessions(h.deps);
    watchStalledSessions(h.deps);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toMatch(/no progress for 31 min/);
    expect(session.status).toBe("stalled");
    // stalled: holds neither its thread nor the Mac
    expect(ccSessionActive(session, h.now)).toBe(false);
    // it moves again: running, and a later stall is a new one
    h.transcripts.set("cli-a", { text: "brief\nmore", writtenAt: h.now });
    watchStalledSessions(h.deps);
    expect(session.status).toBe("running");
    expect(h.chips.at(-1)?.text).toBe("voltou a mostrar progresso");
    h.advance(CC_STALL_MS + 60_000);
    watchStalledSessions(h.deps);
    expect(h.reports).toHaveLength(2);
    expect(session.status).toBe("stalled");
  });

  it("reminds the owner every 6 h while it stays stalled, 3 times in all", () => {
    const h = harness();
    const session = h.opened("a");
    session.turns = 1; // a turn is under way (not ended): it stays stalled
    h.advance(CC_STALL_MS + 60_000);
    watchStalledSessions(h.deps);
    for (let i = 0; i < 5; i++) {
      h.advance(CC_STALL_REMIND_MS - 60_000);
      watchStalledSessions(h.deps);
      h.advance(60_000);
      watchStalledSessions(h.deps);
    }
    expect(h.reports).toHaveLength(CC_STALL_MAX_REPORTS);
    expect(h.reports[1]!.text).toContain("Reminder 2 of 3");
    expect(session.status).toBe("stalled");
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

describe("round 3: screen failures, questions, old queues, names", () => {
  it("a message the screen would not take fails only the message, not the session", async () => {
    const h = harness();
    const session = h.opened("a");
    session.status = "idle";
    session.desktop!.pending = { kind: "send", text: "OK do gerente: siga com o push", since: h.now, attempts: 0 };
    for (let i = 0; i < DESKTOP_MAX_MISSES; i++) {
      h.results.push({ ok: false, reason: "the session is not the one on screen", retry: true, miss: true, touched: true });
      await h.tick();
      h.advance(10 * 60_000);
    }
    expect(session.status).toBe("idle");
    expect(session.desktop!.pending).toBeUndefined();
    expect(session.desktop!.lastSend).toMatchObject({ confirmed: false });
    expect(h.reports.at(-1)!.text).toMatch(/was NOT delivered[\s\S]*OK do gerente: siga com o push/);
  });

  it("reports a question left open in the app after 2 minutes, once, verbatim", () => {
    const h = harness();
    const session = h.opened("a");
    h.transcripts.set("cli-a", { text: "brief", writtenAt: h.now, question: { id: "tu1", text: "Posso publicar o comentário? [opções: Sim / Não]" } });
    followDesktopSessions(h.deps);
    expect(h.reports).toEqual([]);
    h.advance(2 * 60_000 + 1_000);
    followDesktopSessions(h.deps);
    followDesktopSessions(h.deps);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toContain("Posso publicar o comentário? [opções: Sim / Não]");
    expect(h.reports[0]!.text).toContain(`claude://code/continue?session=${LOCAL}`);
    expect(session.status).toBe("running");
  });

  it("says the hook judges a blocked command again, and hands over the exact command to run by hand", () => {
    const h = harness();
    h.opened("a");
    h.deps.hookBlock = () => ({ command: 'gh issue comment 9298 --body "pronto"', truncated: false, cwd: WORKTREE, at: h.now });
    h.transcripts.set("cli-a", { text: "brief", writtenAt: h.now, question: { id: "tu1", text: "O hook bloqueou o gh issue comment. Posso publicar?" } });
    h.advance(2 * 60_000 + 1_000);
    followDesktopSessions(h.deps);
    const text = h.reports[0]!.text;
    expect(text).toContain("the hook judges the command again on every try");
    expect(text).toContain(`  cd ${WORKTREE}\n  gh issue comment 9298 --body "pronto"`);
    // without a block on record, the rule is still said
    const plain = harness();
    plain.opened("a");
    plain.transcripts.set("cli-a", { text: "brief", writtenAt: plain.now, question: { id: "tu1", text: "Posso seguir?" } });
    plain.advance(2 * 60_000 + 1_000);
    followDesktopSessions(plain.deps);
    expect(plain.reports[0]!.text).toContain("answering in the app does not get it past the hook");
  });

  it("holds back a queued order older than 2h at reconciliation and asks the owner", () => {
    const h = harness();
    const session = h.opened("a", { completedTurns: 1 });
    session.desktop!.turnsSeen = 1;
    session.queued.push({ text: "NÃO rode ci:local ainda", at: h.now });
    h.transcripts.set("cli-a", { text: "brief", writtenAt: h.now, ended: true });
    h.advance(11 * 3_600_000);
    followDesktopSessions(h.deps);
    expect(session.desktop!.pending).toBeUndefined();
    expect(session.heldQueue?.map((item) => item.text)).toEqual(["NÃO rode ci:local ainda"]);
    expect(h.reports.some((report) => /NOT delivered[\s\S]*\(11h\) NÃO rode ci:local ainda/.test(report.text))).toBe(true);
  });

  it("closes a stalled session that never answered its brief at the last reminder", () => {
    const h = harness();
    const session = h.opened("a");
    session.queued.push({ text: "status?", at: h.now });
    h.advance(CC_STALL_MS + 60_000);
    watchStalledSessions(h.deps);
    h.advance(CC_STALL_REMIND_MS);
    watchStalledSessions(h.deps);
    h.advance(CC_STALL_REMIND_MS);
    watchStalledSessions(h.deps);
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain("never answered its brief");
    expect(session.queued).toEqual([]);
  });

  it("says once when a session's folder is gone", () => {
    const h = harness();
    h.deps.pathExists = () => false;
    h.opened("a").cwd = WORKTREE;
    followDesktopSessions(h.deps);
    followDesktopSessions(h.deps);
    expect(h.reports.filter((report) => report.text.includes("no longer exists"))).toHaveLength(1);
  });

  it("renames a session to \"#NNNN …\" once, then delivers what was queued meanwhile", async () => {
    const h = harness();
    const session = h.opened("a", { title: "Chat ticket agent/client labels bug" });
    session.status = "idle";
    session.desktop!.issue = "9311";
    followDesktopSessions(h.deps);
    expect(session.desktop!.pending).toMatchObject({ kind: "rename", text: "#9311 Chat ticket agent/client labels bug" });
    session.queued.push({ text: "siga com o PR", at: h.now });
    h.transcripts.get("cli-a")!.ended = true;
    await h.tick();
    expect(h.steps.rename).toHaveBeenCalled();
    // clicked, not yet confirmed: it counts once the app's record shows the title
    expect(h.chips.some((chip) => chip.text.startsWith("renomeada"))).toBe(false);
    h.records.get(LOCAL)!.title = "#9311 Chat ticket agent/client labels bug";
    followDesktopSessions(h.deps);
    expect(h.chips.some((chip) => chip.text.startsWith("renomeada no app: #9311"))).toBe(true);
    followDesktopSessions(h.deps);
    expect(session.desktop!.pending).toMatchObject({ kind: "send", text: "siga com o PR" });
    followDesktopSessions(h.deps);
    expect(h.steps.rename).toHaveBeenCalledTimes(1);
  });

  it("never renames mid-turn, and reports a rename the app's record never showed", async () => {
    const h = harness();
    const session = h.opened("a", { title: "Chat ticket agent/client labels bug" });
    session.desktop!.issue = "9311";
    session.status = "idle";
    followDesktopSessions(h.deps);
    session.status = "running";
    await h.tick();
    expect(h.steps.rename).not.toHaveBeenCalled();
    // idle by the ledger, but the transcript's turn is still going
    session.status = "idle";
    await h.tick();
    expect(h.steps.rename).not.toHaveBeenCalled();
    h.transcripts.get("cli-a")!.ended = true;
    h.advance(61_000);
    await h.tick();
    expect(h.steps.rename).toHaveBeenCalledTimes(1);
    h.advance(DESKTOP_ARCHIVE_CONFIRM_MS + 1);
    followDesktopSessions(h.deps);
    expect(session.desktop!.pending).toBeUndefined();
    expect(h.reports.at(-1)!.text).toContain('still says "Chat ticket agent/client labels bug"');
    expect(h.chips.some((chip) => chip.text.startsWith("renomeada"))).toBe(false);
  });

  it("never numbers the brief twice", () => {
    expect(desktopBriefText("9311 Chat no ticket mostra Agente e Cliente", "OMBX", "x").split("\n")[0]).toBe("#9311 Chat no ticket mostra Agente e Cliente");
    expect(issueNumber("9307 9306 Atendimento reaberto")).toBe("9307");
  });
});

describe("old failures and duplicates", () => {
  it("puts sessions failed over a screen step back to idle on load, with a chip; real failures stay", () => {
    const h = harness();
    const screen = h.opened("a");
    screen.status = "failed";
    screen.lastError = "a message was typed into the Claude app 3 times but never reached the session";
    const outside = h.opened("b");
    outside.status = "failed";
    outside.lastError = "the session opened outside a git worktree (in /repo)";
    const never = h.appSession("c");
    never.status = "failed";
    never.lastError = "could not open the session after 5 tries with the screen unlocked";
    const gone = h.appSession("d", { localId: "local_gone" });
    gone.status = "failed";
    gone.lastError = "could not send the message: the Claude app lost focus";
    expect(reviveScreenFailures(h.deps).map((session) => session.id)).toEqual(["a"]);
    expect(screen.status).toBe("idle");
    expect(screen.lastError).toBeUndefined();
    expect(h.chips.find((chip) => chip.id === "a")!.text).toContain("voltou a aceitar mensagens");
    expect([outside.status, never.status, gone.status]).toEqual(["failed", "failed", "failed"]);
  });

  it("finds the live session of an issue, by its number or its title, in the same repository only", () => {
    const h = harness();
    const live = h.opened("a");
    live.desktop!.issue = "9311";
    const titled = h.appSession("b");
    titled.title = "#9307 Atendimento reaberto";
    titled.desktop!.localId = LOCAL;
    const archived = h.appSession("c", { issue: "9298" });
    archived.status = "archived";
    const neverOpened = h.appSession("d", { issue: "9300" });
    neverOpened.status = "failed";
    const repo = "/Users/o/Projetos/nuria-platform";
    expect(liveSessionForIssue(h.ledger.all(), repo, "9311")?.id).toBe("a");
    expect(liveSessionForIssue(h.ledger.all(), repo, "9307")?.id).toBe("b");
    expect(liveSessionForIssue(h.ledger.all(), repo, "9298")).toBeNull();
    expect(liveSessionForIssue(h.ledger.all(), repo, "9300")).toBeNull();
    expect(liveSessionForIssue(h.ledger.all(), "/other", "9311")).toBeNull();
    expect(liveSessionForIssue(h.ledger.all(), repo, undefined)).toBeNull();
  });
});

describe("failed sessions left alone, and titles alike", () => {
  it("reports a session failed for over 24 h once, suggesting to archive it", () => {
    const h = harness();
    const session = h.appSession("a");
    session.status = "failed";
    session.failedAt = h.now;
    h.advance(23 * 3_600_000);
    expect(ageFailedSessions(h.deps)).toEqual([]);
    h.advance(2 * 3_600_000);
    expect(ageFailedSessions(h.deps).map((aged) => aged.id)).toEqual(["a"]);
    expect(h.reports.at(-1)!.text).toContain("cc_session_archive");
    expect(ageFailedSessions(h.deps)).toEqual([]);
  });

  it("gives a new session a short suffix when a live one has the same title", () => {
    const h = harness();
    h.appSession("a").title = "Automação inatividade não dispara";
    expect(uniqueSessionTitle(h.ledger.all(), "automação  inatividade não dispara", "1819df34-x")).toBe("automação  inatividade não dispara · 1819");
    expect(uniqueSessionTitle(h.ledger.all(), "Outra", "1819df34")).toBe("Outra");
  });
});

describe("an issue left without a live session", () => {
  it("lists issues whose sessions all ended lately, once each, and never one with a live session", () => {
    const h = harness();
    const ended = h.appSession("a", { issue: "8891" });
    ended.status = "archived";
    const failed = h.appSession("b", { issue: "9311" });
    failed.status = "failed";
    const alive = h.appSession("c", { issue: "9311" });
    alive.status = "idle";
    const old = h.appSession("d", { issue: "9000" });
    old.status = "stopped";
    old.lastActivityAt = h.now - 8 * 24 * 3_600_000;
    expect(orphanedIssues(h.ledger.all(), h.now).map((session) => session.id)).toEqual(["a"]);
    ended.orphanCheckedAt = h.now;
    expect(orphanedIssues(h.ledger.all(), h.now)).toEqual([]);
  });
});

describe("a field that already held text", () => {
  it("says when the app's suggestion was sent over", async () => {
    const h = harness();
    const session = h.opened("s");
    session.status = "idle";
    session.desktop!.pending = { kind: "send", text: "Siga", since: h.now, attempts: 0 };
    h.results.push({ ok: true, suggestion: "qual o status do gate da #9330?" });
    await h.tick();
    expect(session.desktop!.pending).toBeUndefined();
    expect(h.chips.some((chip) => chip.text.includes("sugestão do app") && chip.text.includes("#9330"))).toBe(true);
  });

  it("keeps the message, asks the person once in \"Precisa de você\", and settles it when the field is free", async () => {
    const h = harness();
    const pendings: { title: string; link?: string; key: string }[] = [];
    const resolved: string[] = [];
    h.deps.ownerPending = (_session, item) => pendings.push(item);
    h.deps.resolveOwnerPending = (key) => resolved.push(key);
    const session = h.opened("a");
    session.status = "idle";
    session.desktop!.pending = { kind: "send", text: "Pode sim", since: h.now, attempts: 0 };
    const draft = "pode reescrever o corpo da PR com a seção de riscos";
    h.results.push({ ok: false, reason: "há texto não enviado", retry: true, touched: true, draft });
    await h.tick();
    expect(session.desktop!.pending).toMatchObject({ kind: "send", text: "Pode sim", attempts: 0 });
    expect(session.desktop!.pending!.nextAttemptAt).toBe(h.now + DESKTOP_DRAFT_RECHECK_MS);
    expect(pendings).toEqual([expect.objectContaining({ key: "cc-draft:a", link: expect.stringContaining("claude://code/continue?session=") })]);
    expect(pendings[0]!.title).toContain(draft.slice(0, 40));
    expect(h.chips.some((chip) => chip.text.includes("não sobrescrevi"))).toBe(true);
    expect(h.reports.at(-1)!.text).toContain(`"${draft}"`);
    // the same draft later: no second item, no second report
    const reports = h.reports.length;
    h.advance(DESKTOP_DRAFT_RECHECK_MS);
    h.results.push({ ok: false, reason: "há texto não enviado", retry: true, touched: true, draft });
    await h.tick();
    expect(pendings).toHaveLength(1);
    expect(h.reports).toHaveLength(reports);
    // the person cleared it: the message goes, the item is settled
    h.advance(DESKTOP_DRAFT_RECHECK_MS);
    h.results.push({ ok: true });
    await h.tick();
    expect(session.desktop!.pending).toBeUndefined();
    expect(resolved).toEqual(["cc-draft:a"]);
  });
});
