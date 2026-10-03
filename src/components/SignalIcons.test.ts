import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { ccSessionsSummary } from "@/lib/thread-signals";
import { SignalIcons } from "./SignalIcons";

beforeEach(() => setLocale("pt-br"));
afterEach(() => setLocale("en"));

describe("the sessions icon", () => {
  it("marks a headless session in amber, with where it runs in the label", () => {
    const sessions = ccSessionsSummary([{ sessionId: "a", title: "#9315 lote", status: "running", surface: "cli" }]);
    const html = renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions }));
    expect(html).toContain("data-thread-cc-sessions");
    expect(html).toContain('data-cli="true"');
    expect(html).toContain("text-warning");
    expect(html).toContain("#9315 lote — trabalhando · CLI, não aparece no app Claude");
    expect(renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null }))).toBe("");
  });
});

// R8-dispatch D6 and S-retomar, with the line of 02/10 (redacted)
describe("steps waiting for the Mac, and sessions to resume", () => {
  const now = Date.parse("2026-10-02T18:00:00Z");
  // built inside each test: the locale is set per test
  const line = () => ccSessionsSummary([
    { sessionId: "a", title: "9353 Comprar assentos", status: "running", surface: "app", screenWait: { kind: "create", since: now - 12 * 60_000, waitingFor: "locked" } },
    { sessionId: "b", title: "9311 Chat no ticket", status: "idle", surface: "app", screenWait: { kind: "send", since: now - 3 * 60_000, waitingFor: "inUse" } },
    { sessionId: "c", title: "9052 Tempo de reabertura", status: "failed", surface: "cli", resume: { since: now - 3 * 3_600_000, prs: [9332], why: "falhou: o turno passou de 45 minutos e foi parado" } },
  ], now);

  it("shows an hourglass with the count and says, per session, what waits, since when and why", () => {
    const sessions = line();
    const html = renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions }));
    expect(html).toContain('data-thread-cc-waiting="2"');
    expect(html).toMatch(/<span aria-hidden="true" class="text-\[10px\] leading-none tabular-nums">2<\/span>/);
    expect(sessions!.waiting!.text.split("\n")).toEqual([
      "2 passos no app Claude esperando o Mac",
      expect.stringMatching(/^9353 Comprar assentos — abrir no app, esperando desde .+: a tela está bloqueada ou apagada$/),
      expect.stringMatching(/^9311 Chat no ticket — digitar uma mensagem, esperando desde .+: alguém está usando o Mac \(precisa de 5 s sem mexer\)$/),
    ]);
    // one step: the hourglass alone, said in the singular
    const one = ccSessionsSummary([{ sessionId: "a", title: "x", status: "running", surface: "app", screenWait: { kind: "archive", since: now, waitingFor: "queued" } }], now);
    expect(one!.waiting!.text).toMatch(/^1 passo no app Claude esperando o Mac\nx — arquivar, esperando desde .+: vai assim que o Mac ficar livre$/);
    expect(renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions: one }))).not.toContain("tabular-nums");
  });

  it("shows the turn-back arrow, amber, for a session holding an open PR, with what to resume", () => {
    const sessions = line();
    const html = renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions }));
    const arrow = /<svg[^>]*data-thread-cc-resume="1"[^>]*>/.exec(html)?.[0] ?? "";
    expect(arrow).toContain("text-warning");
    expect(arrow).toContain('role="img"');
    expect(sessions!.resume!.text).toMatch(/^1 sessão para retomar: segura uma PR aberta\n9052 Tempo de reabertura — falhou: o turno passou de 45 minutos e foi parado · PR #9332 · desde .+$/);
  });

  it("shows neither when nothing waits and nothing is to resume", () => {
    const calm = ccSessionsSummary([{ sessionId: "a", title: "x", status: "running", surface: "app" }], now);
    expect(calm).toMatchObject({ waiting: null, resume: null });
    const html = renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions: calm }));
    expect(html).not.toContain("data-thread-cc-waiting");
    expect(html).not.toContain("data-thread-cc-resume");
  });
});
