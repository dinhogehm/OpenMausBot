import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CcSessionLedger, type CcSession } from "./cc-sessions.ts";
import { climbStopLadder, STOP_NOTICES_PER_HOUR, type StopLadderDeps } from "./stop-ladder.ts";

const H = 3_600_000;
const SLUG = "dinhogehm/nuria-platform";
const T0 = Date.parse("2026-10-02T12:00:00Z");

// The line of 02/10 (redacted): 9052/#9332 failed, 8204/#9350 idle (and
// parked behind a release), 9195/#9280 idle. One ladder per stop, the clock
// moved by fake timers: what the bot, the Chief and the chips get, in order.
function harness() {
  const ledger = new CcSessionLedger({ path: null, now: () => Date.now() });
  const said: Array<{ to: "bot" | "chief" | "chip"; id: string; text: string; at: number }> = [];
  let release: string | null = null;
  const deps: StopLadderDeps = {
    ledger,
    now: () => Date.now(),
    release: () => release,
    report: (session, text) => { said.push({ to: "bot", id: session.id, text, at: Date.now() }); },
    chip: (session, text) => { said.push({ to: "chip", id: session.id, text, at: Date.now() }); },
    chief: (session, text) => { said.push({ to: "chief", id: session.id, text, at: Date.now() }); },
    ownerName: () => "Monitor Chat",
  };
  const stopped = (id: string, status: "idle" | "failed", extra: Partial<CcSession> = {}, prs: number[] = []): CcSession => {
    const session = ledger.create({ id, ownerBotId: "monitor", ownerThreadId: "t", title: `${id} sessão`, repo: "/r", permissionMode: "auto" });
    session.status = status;
    session.lastActivityAt = Date.now();
    if (status === "failed") {
      session.failedAt = Date.now();
      session.lastError = "the turn ran past 45 minutes and was stopped";
    }
    if (prs.length) session.delivery = { slug: SLUG, prs: Object.fromEntries(prs.map((number) => [String(number), { url: `u/${number}`, number, state: "open" as const, owned: "branch" as const }])) };
    Object.assign(session, extra);
    return session;
  };
  const at = async (hours: number) => {
    vi.setSystemTime(T0 + hours * H);
    return (await climbStopLadder(deps)).map(({ session, stage }) => `${session.id}:${stage}`);
  };
  return { ledger, said, deps, stopped, at, holdRelease: (label: string | null) => { release = label; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("one notice per step of a stop (INSP-S r1 S-2)", () => {
  it("idle with its PR open: RETOMAR at 2 h, nothing at 6 h, the exact block at 24 h, then silence", async () => {
    const h = harness();
    h.stopped("8204", "idle", {}, [9350]);
    const timeline: Record<string, string[]> = {};
    for (const hours of [1, 2, 6, 12, 23, 24, 30, 48, 54, 78, 200]) timeline[hours] = await h.at(hours);
    expect(timeline).toEqual({ 1: [], 2: ["8204:resume"], 6: [], 12: [], 23: [], 24: ["8204:escalate"], 30: [], 48: [], 54: [], 78: [], 200: [] });
    const bot = h.said.filter((each) => each.to === "bot").map((each) => each.text);
    expect(bot).toHaveLength(2);
    expect(bot[0]).toMatch(/^\[Sessão para retomar\] Claude Code session "8204 sessão" \(8204\) — RETOMAR — há 2 h com PR #9350 aberta, parada: o último turno terminou e nada a retomou\. Retome com cc_session_send/);
    expect(bot[1]).toContain("[Sessão parada há 24 h]");
    expect(bot[1]).toContain("O aviso de RETOMAR não a moveu. Não arquive: a PR está aberta. Reporte agora ao dono o bloqueio exato");
    expect(bot[1]).toContain("Este é o último aviso sobre esta parada.");
    // never the old 6 h voice, never "archive" while the PR is open
    expect(h.said.map((each) => each.text).join("\n")).not.toMatch(/esperando um aviso|sugiro arquivar|archive it with/);
    // the Chief hears each step, the chip only the last one
    expect(h.said.filter((each) => each.to === "chief").map((each) => each.at)).toEqual([T0 + 2 * H, T0 + 24 * H]);
    expect(h.said.filter((each) => each.to === "chip").map((each) => each.text)).toEqual(["parada há 24 h com PR #9350 aberta — o bot deve reportar ao dono o bloqueio exato"]);
  });

  it("failed with its PR open: RETOMAR, then the block — never 'sugiro arquivar' (the old 24 h aging)", async () => {
    const h = harness();
    h.stopped("9052", "failed", {}, [9332]);
    expect([...await h.at(2), ...await h.at(6), ...await h.at(30), ...await h.at(54)]).toEqual(["9052:resume", "9052:escalate"]);
    expect(h.said.map((each) => each.text).join("\n")).not.toMatch(/sugiro arquivar|archive it with/);
    // the triangle alert stops after the last word, as the aging did
    expect(h.ledger.get("9052")!.failedAgingReportedAt).toBe(T0 + 30 * H);
  });

  it("failed with no PR: no RETOMAR, 'sugiro arquivar' once at 24 h", async () => {
    const h = harness();
    h.stopped("9101", "failed");
    expect([...await h.at(2), ...await h.at(23), ...await h.at(24), ...await h.at(48)]).toEqual(["9101:archive"]);
    expect(h.said.find((each) => each.to === "chip")!.text).toBe("falhou há mais de 24 h sem ação — sugiro arquivar");
    expect(h.said.filter((each) => each.to === "chief")).toEqual([]);
  });

  it("a create that never opened, holding a PR handed to it: no RETOMAR (the send refuses it), and at 24 h 'open another for the PR before archiving' (S-5)", async () => {
    const h = harness();
    h.stopped("9200", "failed", { surface: "app", desktop: { marker: "OMBX", turnsSeen: 0 }, claimedPrs: [9280] });
    expect([...await h.at(2), ...await h.at(24)]).toEqual(["9200:archive"]);
    expect(h.said.find((each) => each.to === "bot")!.text).toContain("Its PR #9280 is still open and this session cannot take it: start a new session for it (cc_session_start) before archiving this one.");
    expect(h.said.find((each) => each.to === "chip")!.text).toBe("falhou há mais de 24 h sem ação — PR #9280 sem sessão: abrir outra antes de arquivar");
  });

  it("progress starts the ladder over: a new stop gets its own RETOMAR", async () => {
    const h = harness();
    const session = h.stopped("9195", "idle", {}, [9280]);
    expect(await h.at(2)).toEqual(["9195:resume"]);
    // resumed at 3 h, idle again at 4 h
    vi.setSystemTime(T0 + 4 * H);
    session.lastActivityAt = Date.now();
    expect(await h.at(5)).toEqual([]);
    expect(await h.at(6)).toEqual(["9195:resume"]);
    expect(await h.at(28)).toEqual(["9195:escalate"]);
  });

  it("a first boot over a stop already 30 h old says only its last step", async () => {
    const h = harness();
    vi.setSystemTime(T0 - 30 * H);
    h.stopped("9052", "failed", {}, [9332]);
    expect(await h.at(0)).toEqual(["9052:escalate"]);
    expect(h.said.filter((each) => each.to === "bot")).toHaveLength(1);
    expect(h.said[0]!.text).not.toContain("O aviso de RETOMAR não a moveu");
  });

  it("what an older build already said counts: no RETOMAR after its 6 h notice, no aging twice", async () => {
    const h = harness();
    h.stopped("old6", "idle", { idleReportedAt: T0 + 6 * H }, [9314]);
    h.stopped("aged", "failed", { failedAgingReportedAt: T0 + 25 * H });
    vi.setSystemTime(T0 + 25 * H);
    expect(await h.at(25)).toEqual(["old6:escalate"]);
    expect(await h.at(26)).toEqual([]);
  });
});

describe("never while a release holds it (INSP-S r1 S-1)", () => {
  it("8204/#9350 parked behind the release (resumeAfterTag): no RETOMAR at 2,5 h; once the server resumed it and it stopped again, the ladder runs", async () => {
    const h = harness();
    const session = h.stopped("9b50cdf7", "idle", { resumeAfterTag: { fromSha: "09d832f4bfa4", at: T0, message: "A tag andou", releaseSha: "d5bb1f70b" } }, [9350]);
    expect([...await h.at(2.5), ...await h.at(24), ...await h.at(26)]).toEqual([]);
    expect(h.said).toEqual([]);
    // the server's own resumption (resumeSessionsAfterTag) clears it and runs a turn
    delete session.resumeAfterTag;
    vi.setSystemTime(T0 + 27 * H);
    session.lastActivityAt = Date.now();
    expect(await h.at(29)).toEqual(["9b50cdf7:resume"]);
  });

  it("a release on its way holds every RETOMAR and every 'last word' on an open PR; they come once it is gone", async () => {
    const h = harness();
    h.stopped("9052", "failed", {}, [9332]);
    h.stopped("9101", "failed");
    h.holdRelease("o release de produção d5bb1f70b está em andamento");
    expect(await h.at(2)).toEqual([]);
    // the failure with no PR is not held: "archive" runs no CI
    expect(await h.at(24)).toEqual(["9101:archive"]);
    h.holdRelease("?");
    expect(await h.at(25)).toEqual([]);
    h.holdRelease(null);
    expect(await h.at(26)).toEqual(["9052:escalate"]);
  });
});

describe("at most 3 an hour, across restarts (INSP-S r1 S-9)", () => {
  it("five stops due at once: 3, then none within the hour (a new ladder too), then the other 2", async () => {
    const h = harness();
    for (const id of ["a", "b", "c", "d", "e"]) h.stopped(id, "idle", {}, [1]);
    expect(STOP_NOTICES_PER_HOUR).toBe(3);
    expect(await h.at(2)).toEqual(["a:resume", "b:resume", "c:resume"]);
    // every tick of the autonomy (seconds apart) and a restart (the budget is in the ledger)
    expect(await h.at(2.01)).toEqual([]);
    expect(await climbStopLadder({ ...h.deps })).toEqual([]);
    expect(await h.at(2.9)).toEqual([]);
    expect(await h.at(3)).toEqual(["d:resume", "e:resume"]);
  });
});

describe("GitHub's word before saying a PR is open", () => {
  it("merged meanwhile: nothing said; GitHub down: the record stands", async () => {
    const h = harness();
    h.stopped("m", "idle", {}, [9314]);
    h.stopped("g", "idle", {}, [9315]);
    h.deps.confirmOpen = async (session) => (session.id === "m" ? [] : null);
    expect(await h.at(2)).toEqual(["g:resume"]);
    expect(h.said.map((each) => each.id)).not.toContain("m");
  });
});
