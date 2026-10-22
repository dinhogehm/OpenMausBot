// "Agora" (lot Y), the screen's half: the lines built from the real states —
// a release running in its tests, a ci:local queued behind it, a PR BEHIND
// without a receipt, items waiting on the owner, a session to resume — the
// "novo" marks and "desde 08:30", the Markdown summary, the notifications
// (once each), and "—" wherever the server does not know.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot, Task } from "@/state/store";
import type { NowServerStatus } from "../../shared/now-status";
import {
  durationText, nowLines, nowLocal, nowMarkdown, nowNews, nowOwnerNews, nowNotificationKeys, nowNotifications, nowSince, phaseText, seenKeys, type NowLine,
} from "./now-status";

const SHA = "3c04d7c3d2608c36f082fded54bcb0d99e833a85";
const PREV = "f9e7a2350e58397d155858568184650b66e24a91";
const NOW = Date.parse("2026-10-04T13:30:00Z"); // 10:30 in São Paulo
const MIN = 60_000;
const H = 3_600_000;

const task = (threadId: string, title: string, extra: Partial<Task> = {}): Task => ({ threadId, title, createdAt: NOW - 86_400_000, ...extra }) as Task;
const bot = (id: string, name: string, tasks: Task[]): Bot => ({ id, name, threadId: tasks[0]!.threadId, tasks }) as unknown as Bot;

/** The team as the app holds it: two items waiting on the owner, one answered (on its bot now), a session to resume, one on hold. */
const bots = [
  bot("chief", "Chief of Staff", [task("desk", "Esteira", {
    ownerPending: [
      { id: "o1", title: "Aprovar o merge da PR #9332", since: NOW - 2 * H },
      { id: "o2", title: "Recusar o release cb015584a", since: NOW - 20 * MIN },
      { id: "o3", title: "Responder ao cliente Zeta", since: NOW - 3 * H, awaitingSince: NOW - 10 * MIN },
    ],
  })]),
  bot("eng", "Eng", [task("e1", "Lote W", {
    ccSessions: [
      { sessionId: "s1", title: "fix/9368 admissão", status: "idle", surface: "app", resume: { since: NOW - 30 * MIN, prs: [9368], why: "parada há 2 h com a PR aberta", kind: "idle" } },
      { sessionId: "s2", title: "feat/9332 prazo", status: "failed", surface: "app", resume: { since: NOW - 4 * H, prs: [9332], why: "falhou", kind: "failed", held: "release" } },
      { sessionId: "s3", title: "chore: limpeza", status: "stalled", surface: "cli" },
    ],
  })]),
];

function server(extra: Partial<NowServerStatus> = {}): NowServerStatus {
  return {
    version: 1, generatedAt: NOW, enabled: true,
    production: {
      sha: PREV, at: NOW - 3 * H,
      tag: { sha: PREV, checkedAt: NOW - 10 * MIN, agrees: true },
      today: [{ sha: PREV, at: NOW - 3 * H, prs: [{ number: 9280, title: "fix(helpdesk): rodízio de equipe atômico", url: "https://github.com/dinhogehm/nuria-platform/pull/9280" }] }],
    },
    release: {
      state: "running", sha: SHA, startedAt: NOW - 75 * MIN, phase: "tests", phaseAt: NOW - 12 * MIN,
      prs: [{ number: 9301, title: "feat: x", url: "https://github.com/dinhogehm/nuria-platform/pull/9301" }],
      profile: "migrations", estimateMs: 2 * H + 45 * MIN, remainingMs: 90 * MIN, samples: 3, progress: null,
    },
    prs: {
      checkedAt: NOW - MIN,
      list: [
        { number: 9332, title: "feat(atendimento): prazo", url: "https://github.com/dinhogehm/nuria-platform/pull/9332", merge: "BEHIND", gate: "missing", draft: false, createdAt: NOW - 3 * 86_400_000 },
        { number: 9368, title: "perf(release)", url: "https://github.com/dinhogehm/nuria-platform/pull/9368", merge: "BLOCKED", gate: "success", draft: false, createdAt: NOW - 30 * MIN },
        { number: 9380, title: "wip", url: "https://github.com/dinhogehm/nuria-platform/pull/9380", merge: "DRAFT", gate: "missing", draft: true, createdAt: NOW - 5 * MIN },
      ],
    },
    ci: { state: "queued", queued: 2, behindRelease: true },
    alerts: [],
    throughput: { deliveries: 1, mergedPrs: 7, closedIssues: 4, failedReleases: 0, syncedAt: NOW - 10 * MIN },
    ...extra,
  };
}

const byId = (lines: NowLine[]) => Object.fromEntries(lines.map((line) => [line.id, line]));

beforeEach(() => setLocale("pt-br"));
afterEach(() => setLocale("en"));

describe("the lines, from the real states", () => {
  // built inside each test: the catalog's language is set per test
  let local: ReturnType<typeof nowLocal>;
  let lines: NowLine[];
  let line: Record<string, NowLine>;
  beforeEach(() => {
    local = nowLocal(bots, NOW);
    lines = nowLines(server(), local, NOW);
    line = byId(lines);
  });

  it("about six lines, in reading order; sessions shown because some wait", () => {
    expect(lines.map((each) => each.id)).toEqual(["production", "release", "prs", "ci", "needsYou", "sessions", "throughput"]);
  });

  it("production: the commit, since when, what went in today with its PR and title, to the PR", () => {
    expect(line.production).toMatchObject({
      label: "Produção", text: "f9e7a2350 · no ar há 3 h · 1 entrega hoje", detail: "#9280 fix(helpdesk): rodízio de equipe atômico", tone: "ok",
      target: { kind: "url", url: "https://github.com/dinhogehm/nuria-platform/pull/9280" },
    });
  });

  it("release running: commit, phase and for how long, since when, time left by the history, its PRs", () => {
    expect(line.release).toMatchObject({
      text: "3c04d7c3d · testes há 12 min · começou há 1 h 15",
      detail: "faltam ~1 h 30 · mediana 2 h 45 (3 releases com migrations) · #9301 feat: x",
      tone: "info",
      target: { kind: "url", url: "https://github.com/dinhogehm/nuria-platform/pull/9301" },
    });
    const late = byId(nowLines(server({ release: { ...server().release, remainingMs: -20 * MIN } }), local, NOW));
    expect(late.release).toMatchObject({ tone: "warn", detail: "passou da mediana em 20 min · mediana 2 h 45 (3 releases com migrations) · #9301 feat: x" });
    const hung = byId(nowLines(server({ release: { ...server().release, overdue: true } }), local, NOW));
    expect(hung.release).toMatchObject({ tone: "danger" });
    expect(hung.release!.detail).toContain("pode ter travado");
  });

  it("release: every phase says since when, the deploy's included; workers counted; '—' when its start is not known", () => {
    const at = (release: Partial<NowServerStatus["release"]>) => byId(nowLines(server({ release: { ...server().release, ...release } }), local, NOW)).release!;
    expect(at({ phase: "migrations-check", phaseAt: NOW - 95 * MIN }).text).toBe("3c04d7c3d · verificando migrations nos tenants há 1 h 35 · começou há 1 h 15");
    expect(at({ phase: "workers", phaseAt: NOW - 3 * MIN, progress: { done: 12, total: 46 } }).text).toBe("3c04d7c3d · deploy dos workers 12 de 46 há 3 min · começou há 1 h 15");
    expect(at({ phase: "post-release", phaseAt: NOW - MIN, progress: { done: 3, total: 5 } }).text).toBe("3c04d7c3d · checagem pós-release 3 de 5 há 1 min · começou há 1 h 15");
    expect(at({ phase: "deploy", phaseAt: null }).text).toBe("3c04d7c3d · deploy há — · começou há 1 h 15");
    expect(at({ phase: "purge", phaseAt: NOW - 20_000 }).text).toBe("3c04d7c3d · purge do CDN agora mesmo · começou há 1 h 15");
  });

  it("release: no estimate without the profile or with fewer than 3 comparable releases ('—')", () => {
    const of = (release: Partial<NowServerStatus["release"]>) => byId(nowLines(server({ release: { ...server().release, ...release } }), local, NOW)).release!.detail;
    expect(of({ profile: null, estimateMs: null, remainingMs: null, samples: 0 })).toBe("estimativa: — (ainda não se sabe se tem migrations) · #9301 feat: x");
    expect(of({ profile: "light", estimateMs: null, remainingMs: null, samples: 1 })).toBe("estimativa: — (1 releases sem migrations no histórico; precisa de 3) · #9301 feat: x");
  });

  it("release idle: each profile's median, never one mixed", () => {
    const idle = byId(nowLines(server({ release: { state: "idle", estimateMs: null, samples: 0, profiles: { migrations: { ms: 3 * H + 5 * MIN, samples: 7 }, light: { ms: 49 * MIN, samples: 3 } } } }), local, NOW)).release!;
    expect(idle).toMatchObject({ text: "nenhum release em curso", detail: "mediana 3 h 05 com migrations · 49 min sem" });
  });

  it("open PRs in pt-BR: behind main and blocked counted, receipts counted, the one needing a hand first, drafts apart", () => {
    expect(line.prs).toMatchObject({
      text: "2 abertas · 1 atrás da main, 1 bloqueada · com recibo: 1",
      detail: "#9332 atrás da main, sem recibo · #9368 bloqueada, recibo verde · +1 rascunho",
      tone: "warn",
      target: { kind: "url", url: "https://github.com/dinhogehm/nuria-platform/pull/9332" },
    });
    // BLOCKED is every PR's state before its gate: no alarm for it alone
    const blocked = byId(nowLines(server({ prs: { checkedAt: NOW, list: [server().prs.list![1]!] } }), local, NOW)).prs!;
    expect(blocked).toMatchObject({ text: "1 aberta · 1 bloqueada · com recibo: 1", tone: "info" });
  });

  it("ci:local queued behind the release: a legitimate wait, not an alarm", () => {
    expect(line.ci).toMatchObject({ text: "na fila atrás do release: 2", detail: "espera legítima: começa quando o release liberar a máquina", tone: "info" });
    expect(line.ci!.target).toBeUndefined();
    const running = byId(nowLines(server({ ci: { state: "running", label: "local-ci:e388511c72a2", since: NOW - 12 * MIN, queued: 1, session: { sessionId: "s1", title: "fix/9368 admissão", botId: "eng", threadId: "e1" } } }), local, NOW));
    expect(running.ci).toMatchObject({ text: "rodando há 12 min · na fila: 1", detail: "local-ci:e388511c72a2 · sessão “fix/9368 admissão”", target: { kind: "thread", botId: "eng", threadId: "e1" } });
  });

  it("what waits on the owner: the same items as the sidebar (the answered one is on its bot), to the resolution screen", () => {
    expect(line.needsYou).toMatchObject({
      text: "2 itens · o mais antigo há 2 h",
      detail: "Aprovar o merge da PR #9332 · Recusar o release cb015584a · +1 aguardando o bot",
      tone: "warn", target: { kind: "needsYou" },
    });
  });

  it("sessions: one to resume, one stuck, one on hold for the release — to the conversation of the first", () => {
    expect(line.sessions).toMatchObject({
      text: "1 a retomar · 1 travada · em espera pelo release: 1",
      tone: "warn", target: { kind: "thread", botId: "eng", threadId: "e1" },
    });
  });

  it("today's throughput from the report, to the report", () => {
    // each label stays with its number (no "1" alone on the next line of a narrow panel)
    expect(line.throughput).toMatchObject({ text: "produção 1 · PRs mergeadas 7 · issues fechadas 4", target: { kind: "report" } });
  });

  it("an alert of the Chief's: its words, when, to the Chief's conversation", () => {
    const alerted = byId(nowLines(server({ alerts: [{ key: "a", at: NOW - 5 * MIN, text: "release cb015584a falhou 2× e não foi publicado", botId: "chief", threadId: "desk" }] }), local, NOW));
    expect(alerted.alerts).toMatchObject({ text: "release cb015584a falhou 2× e não foi publicado", detail: "há 5 min, na conversa do Chief", tone: "danger", target: { kind: "thread", botId: "chief", threadId: "desk" } });
  });

  it("an alert only read from the watcher's log never claims the Chief's conversation", () => {
    const logged = byId(nowLines(server({ alerts: [{ key: "failing:cb015584a:2", at: NOW - 40 * MIN, sha: "cb015584a", kind: "release", text: "Release cb015584a falhou 2× seguidas — não está em produção (log do watcher)" }] }), local, NOW));
    expect(logged.alerts).toMatchObject({ detail: "há 40 min, no log do watcher", tone: "danger" });
    expect(logged.alerts!.target).toBeUndefined();
  });
});

describe("unknown is '—', never zero", () => {
  it("no server answer yet: every server line says —, the local ones still count", () => {
    const lines = byId(nowLines(null, nowLocal(bots, NOW), NOW));
    expect(lines.production!.text).toBe("—");
    expect(lines.release!.text).toBe("—");
    expect(lines.prs!.text).toBe("—");
    expect(lines.ci!.text).toBe("—");
    expect(lines.throughput!.text).toBe("produção — · PRs mergeadas — · issues fechadas —");
    expect(lines.needsYou!.text).toBe("2 itens · o mais antigo há 2 h");
  });

  it("partial knowledge: today without a release source, GitHub never synced, the release's PRs unknown", () => {
    const lines = byId(nowLines(server({
      production: { ...server().production, today: null },
      release: { ...server().release, prs: null, profile: null, estimateMs: null, remainingMs: null, samples: 0 },
      throughput: { deliveries: null, mergedPrs: null, closedIssues: null, failedReleases: null, syncedAt: null },
      prs: { list: null, checkedAt: null, error: "gh: not logged in" },
    }), nowLocal([], NOW), NOW));
    expect(lines.production!.text).toBe("f9e7a2350 · no ar há 3 h · hoje: —");
    expect(lines.release!.detail).toBe("estimativa: — (ainda não se sabe se tem migrations) · PRs: —");
    expect(lines.throughput).toMatchObject({ text: "produção — · PRs mergeadas — · issues fechadas —", detail: "GitHub ainda não sincronizado" });
    expect(lines.prs).toMatchObject({ text: "—", detail: "O GitHub não respondeu" });
  });

  it("a failed GitHub read keeps the last list and says from when", () => {
    const lines = byId(nowLines(server({ prs: { ...server().prs, error: "HTTP 502" } }), nowLocal([], NOW), NOW));
    expect(lines.prs!.detail).toContain("O GitHub não respondeu; lista das 10:29");
  });

  it("the tag on GitHub disagreeing with production is said", () => {
    const lines = byId(nowLines(server({ production: { ...server().production, sha: SHA, at: null, tag: { sha: PREV, checkedAt: NOW - 10 * MIN, agrees: false } } }), nowLocal([], NOW), NOW));
    expect(lines.production).toMatchObject({ tone: "warn", text: "3c04d7c3d · acabou de entrar · 1 entrega hoje" });
    expect(lines.production!.detail).toContain("tag no GitHub em f9e7a2350 (conferida às 10:20)");
  });

  it("phases the server does not know are said as the log names them; durations read naturally", () => {
    expect(phaseText("smart-deploy")).toBe("validação selada");
    expect(phaseText("new-step")).toBe("new-step");
    expect(phaseText(null)).toBe("—");
    expect([durationText(20_000), durationText(12 * MIN), durationText(2 * H), durationText(75 * MIN), durationText(50 * H)]).toEqual(["agora", "12 min", "2 h", "1 h 15", "2 d"]);
  });
});

describe("what changed since the owner last looked", () => {
  let local: ReturnType<typeof nowLocal>;
  let lines: NowLine[];
  beforeEach(() => {
    local = nowLocal(bots, NOW);
    lines = nowLines(server(), local, NOW);
  });

  it("first look: no marks, no 'since'", () => {
    expect(nowNews(lines, null).size).toBe(0);
    expect(nowSince(server(), local, null)).toBeNull();
  });

  it("marks the lines whose facts changed, and counts what arrived after 07:00 by its own time", () => {
    const at7 = Date.parse("2026-10-04T10:00:00Z");
    const before = nowLines(server({ production: { ...server().production, today: [] }, ci: { state: "idle", queued: 0 } }), local, at7);
    const seen = { at: at7, keys: { ...seenKeys(before), needsYou: "chief:desk:o1" } };
    expect([...nowNews(lines, seen)].sort()).toEqual(["ci", "needsYou", "production"]);
    // delivered 07:30, items since 08:30 and 10:10, PR #9368 opened 10:00, s1 to resume since 10:00
    expect(nowSince(server(), local, seen)).toBe("Desde 07:00: +1 em produção, +2 esperando você, +1 nas PRs abertas, +1 a retomar");
    const quiet = { at: NOW, keys: seenKeys(lines) };
    expect(nowNews(lines, quiet).size).toBe(0);
    expect(nowSince(server(), local, quiet)).toBe("Nada novo desde 10:30");
  });

  it("the release moving to its next phase is not news; a new release is", () => {
    const seen = { at: NOW, keys: seenKeys(lines) };
    expect(nowNews(nowLines(server({ release: { ...server().release, phase: "deploy" } }), local, NOW), seen).has("release")).toBe(false);
    expect(nowNews(nowLines(server({ release: { ...server().release, sha: PREV } }), local, NOW), seen).has("release")).toBe(true);
  });

  // R11-visual N16: "novo" on 6 of 7 lines marked nothing, and the rail's blue "6" competed with the amber
  it("marks nothing when more than half the lines changed (the 'Desde' line says it), and the rail counts only what waits on the owner", () => {
    const counted = lines.filter((line) => line.fingerprint);
    const stale = { at: NOW - 86_400_000, keys: Object.fromEntries(counted.map((line) => [line.id, "yesterday"])) };
    expect(nowNews(lines, stale).size).toBe(0);
    expect(nowSince(server(), local, stale)).toMatch(/^Desde /);
    // half or fewer changed: each one marked
    const half = { at: NOW, keys: { ...seenKeys(lines), ...Object.fromEntries(counted.slice(0, Math.floor(counted.length / 2)).map((line) => [line.id, "old"])) } };
    expect(nowNews(lines, half).size).toBe(Math.floor(counted.length / 2));
    // the rail: items that started waiting on the owner since the last look, and nothing on the first look
    const at7 = Date.parse("2026-10-04T10:00:00Z");
    expect(nowOwnerNews(local, { at: at7, keys: {} })).toBe(local.needsYou.waiting.filter((item) => item.since > at7).length);
    expect(nowOwnerNews(local, { at: at7, keys: {} })).toBeGreaterThan(0);
    expect(nowOwnerNews(local, { at: NOW, keys: {} })).toBe(0);
    expect(nowOwnerNews(local, null)).toBe(0);
  });
});

describe("Copiar resumo", () => {
  it("one Markdown block: title with day and hour, what changed, one bullet per line, PRs linked", () => {
    const local = nowLocal(bots, NOW);
    const md = nowMarkdown(nowLines(server(), local, NOW), NOW, "Desde 08:30: +1 em produção");
    expect(md.split("\n")).toEqual([
      "**Andamento — 04/10 10:30**",
      "_Desde 08:30: +1 em produção_",
      "",
      "- Produção: f9e7a2350 · no ar há 3 h · 1 entrega hoje — [#9280](https://github.com/dinhogehm/nuria-platform/pull/9280) fix(helpdesk): rodízio de equipe atômico",
      "- Release: 3c04d7c3d · testes há 12 min · começou há 1 h 15 — faltam ~1 h 30 · mediana 2 h 45 (3 releases com migrations); [#9301](https://github.com/dinhogehm/nuria-platform/pull/9301) feat: x",
      "- PRs abertas: 2 abertas · 1 atrás da main, 1 bloqueada · com recibo: 1 — [#9332](https://github.com/dinhogehm/nuria-platform/pull/9332) atrás da main, sem recibo; [#9368](https://github.com/dinhogehm/nuria-platform/pull/9368) bloqueada, recibo verde",
      "- ci:local: na fila atrás do release: 2 (espera legítima: começa quando o release liberar a máquina)",
      "- Precisa de você: 2 itens · o mais antigo há 2 h — Aprovar o merge da PR #9332; Recusar o release cb015584a",
      "- Sessões: 1 a retomar · 1 travada · em espera pelo release: 1 — fix/9368 admissão; chore: limpeza; feat/9332 prazo",
      "- Hoje: produção 1 · PRs mergeadas 7 · issues fechadas 4",
    ]);
  });
});

describe("notifications: discreet, once each", () => {
  it("a delivery in production and a new item waiting; nothing twice; the first look seeds the record", () => {
    const local = nowLocal(bots, NOW);
    const seeded = new Set(nowNotificationKeys(server(), local));
    expect([...seeded].sort()).toEqual(["needsYou:chief:desk:o1", "needsYou:chief:desk:o2", `production:${PREV}`]);
    expect(nowNotifications(server(), local, seeded)).toEqual([]);
    const later = server({ production: { ...server().production, today: [{ sha: SHA, at: NOW, prs: [{ number: 9301, title: "feat: x", url: "https://github.com/dinhogehm/nuria-platform/pull/9301" }] }, ...server().production.today!] } });
    expect(nowNotifications(later, local, seeded)).toEqual([
      { key: `production:${SHA}`, title: "Em produção: 3c04d7c3d", body: "#9301 feat: x", target: { kind: "url", url: "https://github.com/dinhogehm/nuria-platform/pull/9301" } },
    ]);
    // the answered item (on its bot) is not news for the owner
    expect(nowNotificationKeys(server(), local).some((key) => key.endsWith(":o3"))).toBe(false);
  });

  it("no second banner for what the bot's turn already announced, nor for a bot whose switch is off", () => {
    const local = nowLocal(bots, NOW);
    const sent = new Set([`production:${PREV}`]);
    const notified = nowNotifications(server(), local, sent, { serverNotified: (botId, threadId, since) => botId === "chief" && threadId === "desk" && since === NOW - 20 * MIN });
    expect(notified.map((each) => [each.key, each.quiet ?? false])).toEqual([["needsYou:chief:desk:o1", false], ["needsYou:chief:desk:o2", true]]);
    expect(nowNotifications(server(), local, sent, { botNotifies: () => false }).every((each) => each.quiet)).toBe(true);
  });

  it("the same conversation asking again is news again (its own key per ask)", () => {
    const asking = (since: number) => nowLocal([bot("qa", "QA", [task("q1", "Rodar QA", { goalNeedsInput: true, goalNeedsInputSince: since })])], NOW);
    const first = nowNotificationKeys(null, asking(NOW - 3 * H));
    expect(nowNotifications(null, asking(NOW - 10 * MIN), new Set(first)).map((each) => each.key)).toEqual([`needsYou:qa:q1:ask@${NOW - 10 * MIN}`]);
  });
});
