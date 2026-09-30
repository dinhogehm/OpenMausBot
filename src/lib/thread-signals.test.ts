import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { botSignals, ccAlertSummary, needsSignalLook, watchSummary } from "./thread-signals";

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
    expect(botSignals([{}], now)).toEqual({ watch: null, cc: null });
    expect(needsSignalLook(tasks[0]!)).toBe(false);
    expect(needsSignalLook(tasks[1]!)).toBe(true);
    expect(needsSignalLook({ watches: [{ label: "x", standing: false, everyMinutes: 2, lastRunAt: now, failures: 2 }] })).toBe(true);
  });
});
