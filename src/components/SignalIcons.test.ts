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

  it("shows an hourglass with the count and says, under what holds them, what is pending and since when", () => {
    const sessions = line();
    const html = renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions }));
    expect(html).toContain('data-thread-cc-waiting="2"');
    expect(html).toMatch(/<span aria-hidden="true" class="text-\[10px\] leading-none tabular-nums">2<\/span>/);
    expect(sessions!.waiting!.text.split("\n")).toEqual([
      "2 passos no app Claude pendentes",
      "Esperando o Mac: a tela está bloqueada ou apagada",
      expect.stringMatching(/^ {2}9353 Comprar assentos — abrir no app, desde .+$/),
      "Esperando o Mac: alguém está usando (precisa de 5 s sem mexer)",
      expect.stringMatching(/^ {2}9311 Chat no ticket — digitar uma mensagem, desde .+$/),
    ]);
    // one step: the hourglass alone, said in the singular
    const one = ccSessionsSummary([{ sessionId: "a", title: "x", status: "running", surface: "app", screenWait: { kind: "archive", since: now, waitingFor: "queued" } }], now);
    expect(one!.waiting!.text).toMatch(/^1 passo no app Claude pendente\nNa fila: vai assim que o Mac ficar livre\n {2}x — arquivar, desde .+$/);
    expect(renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions: one }))).not.toContain("tabular-nums");
  });

  // INSP-S r1 S-8: "esperando o Mac" was said of a screen miss and a draft too
  it("never says 'waiting for the Mac' of a screen step that did not show, or of a draft", () => {
    const held = ccSessionsSummary([
      { sessionId: "a", title: "9298 Regra", status: "running", surface: "app", screenWait: { kind: "send", since: now, waitingFor: "screen" } },
      { sessionId: "b", title: "9300 Gate", status: "running", surface: "app", screenWait: { kind: "send", since: now, waitingFor: "draft" } },
    ], now)!.waiting!.text;
    expect(held).not.toContain("Esperando o Mac");
    expect(held.split("\n").filter((text) => !text.startsWith("  "))).toEqual([
      "2 passos no app Claude pendentes",
      "O app não mostrou o esperado; tenta de novo",
      "Há texto não enviado no campo da sessão: envie ou apague",
    ]);
  });

  it("shows the step-forward mark, amber, with the count, for sessions holding an open PR, with what to resume", () => {
    const sessions = line();
    const html = renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions }));
    const mark = /<span data-thread-cc-resume="1"[^>]*>(.*?)<\/span>/.exec(html);
    expect(mark?.[0]).toContain("text-warning");
    expect(mark?.[0]).toContain('role="img"');
    expect(mark?.[0]).toContain('aria-label="1 sessão para retomar');
    // not the turn-back arrow (it read as "reload/undo")
    expect(html).toContain("lucide-step-forward");
    expect(html).not.toMatch(/lucide-rotate-ccw|lucide-refresh/);
    expect(mark?.[1]).not.toContain("tabular-nums");
    expect(sessions!.resume!.text).toMatch(/^1 sessão para retomar: segura uma PR aberta\n9052 Tempo de reabertura — falhou: o turno passou de 45 minutos e foi parado · PR #9332 · desde .+$/);
    const two = ccSessionsSummary([
      { sessionId: "c", title: "9052", status: "failed", surface: "cli", resume: { since: now, prs: [9332], why: "x", kind: "failed", detail: "the turn ran past 45 minutes and was stopped" } },
      { sessionId: "d", title: "9195", status: "idle", surface: "cli", resume: { since: now, prs: [9280], why: "y", kind: "idle" } },
    ], now);
    expect(renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions: two }))).toMatch(/data-thread-cc-resume="2".*tabular-nums">2<\/span>/s);
    // the reason in the reader's words, from the kind (not the server's pt-BR `why`)
    expect(two!.resume!.text).toContain("9052 — falhou: o turno passou de 45 minutos e foi parado · PR #9332");
    expect(two!.resume!.text).toContain("9195 — parada: o último turno terminou e nada a retomou · PR #9280");
  });

  // INSP-S r2 S2-3: the mark used to vanish while a release ran and come back after
  it("keeps the mark while a release holds them, in the secondary ink, saying not to resume now", () => {
    const held = ccSessionsSummary([
      { sessionId: "c", title: "9052", status: "failed", surface: "cli", resume: { since: now, prs: [9332], why: "x", kind: "failed", detail: "the turn ran past 45 minutes and was stopped", held: "release" } },
      { sessionId: "p", title: "8204", status: "idle", surface: "cli", resume: { since: now, prs: [9350], why: "y", kind: "idle", held: "parked" } },
    ], now);
    expect(held!.resume).toMatchObject({ count: 2, held: true });
    const html = renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions: held }));
    const mark = /<span data-thread-cc-resume="2"[^>]*>/.exec(html)?.[0] ?? "";
    expect(mark).toContain('data-held="true"');
    expect(mark).toContain("text-ink-secondary");
    expect(mark).not.toContain("text-warning");
    expect(held!.resume!.text).toMatch(/9052 — falhou: o turno passou de 45 minutos e foi parado · PR #9332 · desde .+ — em espera: há um release de produção em andamento — não retome agora/);
    expect(held!.resume!.text).toMatch(/8204 — parada: o último turno terminou e nada a retomou · PR #9350 · desde .+ — em espera: estacionada atrás do release de produção — o servidor a retoma quando a tag andar/);
    // one free to resume among them: amber again
    const mixed = ccSessionsSummary([
      { sessionId: "c", title: "9052", status: "failed", surface: "cli", resume: { since: now, prs: [9332], why: "x", kind: "idle", held: "release" } },
      { sessionId: "d", title: "9195", status: "idle", surface: "cli", resume: { since: now, prs: [9280], why: "y", kind: "idle" } },
    ], now);
    expect(mixed!.resume!.held).toBe(false);
    expect(renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions: mixed }))).toMatch(/data-thread-cc-resume="2"[^>]*text-warning/);
  });

  it("says why to resume in English for an English reader (INSP-S r1 S-8)", () => {
    setLocale("en");
    const text = ccSessionsSummary([
      { sessionId: "c", title: "9052", status: "failed", surface: "cli", resume: { since: now, prs: [9332], why: "falhou: o turno passou de 45 minutos e foi parado", kind: "failed", detail: "the turn ran past 45 minutes and was stopped" } },
      { sessionId: "e", title: "9280", status: "idle", surface: "cli", resume: { since: now, prs: [9280], why: "parada, bloqueada: aprovar", kind: "blocked", detail: "approve the merge" } },
    ], now)!.resume!.text;
    expect(text).toContain("9052 — failed: the turn ran past 45 minutes and was stopped · PR #9332");
    expect(text).toContain("9280 — stopped, blocked: approve the merge · PR #9280");
    expect(text).not.toMatch(/falhou|parada/);
  });

  it("shows neither when nothing waits and nothing is to resume", () => {
    const calm = ccSessionsSummary([{ sessionId: "a", title: "x", status: "running", surface: "app" }], now);
    expect(calm).toMatchObject({ waiting: null, resume: null });
    const html = renderToStaticMarkup(createElement(SignalIcons, { watch: null, cc: null, sessions: calm }));
    expect(html).not.toContain("data-thread-cc-waiting");
    expect(html).not.toContain("data-thread-cc-resume");
  });
});
