import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { botSignals, ccAlertSummary, ccSessionsSummary, needsSignalLook, watchSummary } from "./thread-signals";

const now = new Date("2026-09-30T10:30:00").getTime();
beforeEach(() => setLocale("pt-br"));
afterEach(() => setLocale("en"));

describe("thread signals", () => {
  it("lists the watches with their last run, red when one fails or the standing one is gone", () => {
    const ok = watchSummary([{ label: "chat", standing: true, everyMinutes: 3, lastRunAt: now - 60_000, failures: 0 }], false, now)!;
    expect(ok.failing).toBe(false);
    expect(ok.text).toBe("Vigias\nchat a cada 3 min · última execução 10:29");
    const failing = watchSummary([{ label: "planilha", standing: true, everyMinutes: 10, lastRunAt: now, failures: 3 }], false, now)!;
    expect(failing).toMatchObject({ failing: true, text: expect.stringContaining("planilha falhando (3× seguidas)") });
    expect(watchSummary([], true, now)).toMatchObject({ failing: true, text: expect.stringContaining("Sem vigia permanente") });
    expect(watchSummary(undefined, false, now)).toBeNull();
  });

  it("names the Claude Code sessions that need a look", () => {
    const summary = ccAlertSummary([{ sessionId: "a", title: "#9308 e-mail", state: "question" }, { sessionId: "b", title: "#9298", state: "stalled" }])!;
    expect(summary.severe).toBe(true);
    expect(summary.text).toBe("Claude Code · #9308 e-mail — com pergunta aberta no app\nClaude Code · #9298 — parada");
    expect(ccAlertSummary([{ sessionId: "b", title: "x", state: "stalled" }])!.severe).toBe(false);
    expect(ccAlertSummary([{ sessionId: "c", title: "#9298", state: "failed", detail: "could not send the message after 5 tries" }])!.text)
      .toBe("Claude Code · #9298 — falhou: não foi possível enviar a mensagem depois de 5 tentativas");
  });

  it("says where each Claude Code session runs, a CLI one out of the Claude app, and keeps its conversation reachable", () => {
    const sessions = [
      { sessionId: "a", title: "#9315 lote", status: "running" as const, surface: "cli" as const },
      { sessionId: "b", title: "#9298 inatividade", status: "idle" as const, surface: "app" as const },
    ];
    expect(ccSessionsSummary(sessions)).toEqual({
      cli: true,
      text: "Sessões do Claude Code desta conversa\n#9315 lote — trabalhando · CLI, não aparece no app Claude\n#9298 inatividade — parada esperando ordem · no app Claude",
      waiting: null,
      resume: null,
    });
    expect(ccSessionsSummary([sessions[1]!])?.cli).toBe(false);
    expect(ccSessionsSummary([])).toBeNull();
    expect(needsSignalLook({ ccSessions: [sessions[0]!] })).toBe(true);
    expect(needsSignalLook({ ccSessions: [sessions[1]!] })).toBe(false);
    // a step waiting for the Mac, or a session to resume, keeps the conversation reachable when folded (D6, S-retomar)
    expect(needsSignalLook({ ccSessions: [{ ...sessions[1]!, screenWait: { kind: "send", since: now, waitingFor: "locked" } }] })).toBe(true);
    expect(needsSignalLook({ ccSessions: [{ ...sessions[1]!, resume: { since: now, prs: [9350], why: "parada" } }] })).toBe(true);
    // a folded bot sums them across its conversations
    const folded = botSignals([
      { ccSessions: [{ ...sessions[1]!, screenWait: { kind: "create", since: now, waitingFor: "inUse" } }] },
      { ccSessions: [{ ...sessions[1]!, sessionId: "z", screenWait: { kind: "send", since: now, waitingFor: "queued" }, resume: { since: now, prs: [9280], why: "parada" } }] },
    ], now).sessions!;
    expect(folded.waiting?.count).toBe(2);
    expect(folded.resume?.count).toBe(1);
    expect(botSignals([{ ccSessions: sessions }]).sessions?.cli).toBe(true);
  });

  it("sums a bot's conversations for its folded row, and knows which need a look", () => {
    const tasks = [
      { watches: [{ label: "chat", standing: true, everyMinutes: 3, lastRunAt: now, failures: 0 }] },
      { watchesLost: true, ccAlerts: [{ sessionId: "a", title: "#9308", state: "failed" as const }] },
      { routineRunId: "r1", ccAlerts: [{ sessionId: "z", title: "routine", state: "failed" as const }] },
    ];
    const signals = botSignals(tasks, now);
    expect(signals.watch).toMatchObject({ failing: true, text: expect.stringContaining("chat a cada 3 min") });
    expect(signals.cc?.text).toBe("Claude Code · #9308 — falhou");
    expect(botSignals([{}], now)).toEqual({ watch: null, cc: null, sessions: null });
    expect(needsSignalLook(tasks[0]!)).toBe(false);
    expect(needsSignalLook(tasks[1]!)).toBe(true);
    expect(needsSignalLook({ watches: [{ label: "x", standing: false, everyMinutes: 2, lastRunAt: now, failures: 2 }] })).toBe(true);
  });
});
