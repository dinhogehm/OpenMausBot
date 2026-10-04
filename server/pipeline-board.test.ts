// The delivery board's builder (lot Z) over the real pipeline of 03–04/10
// (server/testing/pipeline-board-fixture.ts): an issue in a session, a PR
// BEHIND main, a release in progress and what reached production — each card
// in its column, with its time in the stage, its state and the reason from
// the data; titles without names; unknown as "—", never zero; the same
// inputs, the same board. INSP-Z r1: new client demands first in Entrada, an
// open issue never gone, the owner's limits, "Fecha #N", one coherent state,
// names in any spelling, "delivered by the times" only by a release that can
// carry the merge, the Gate's time since the gate began.
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, ENTRY_FOLD, isStale, sanitizeLimits, type BoardCard, type PipelineBoard } from "../shared/pipeline-board.ts";
import { boardTitle, buildPipelineBoard, fold, nameDictionary, parseReceipt, sheetRowOf, utcStamp, type BoardInputs } from "./pipeline-board.ts";
import { explicitReferences } from "./productivity-github.ts";
import { boardInputs, boardInputsWithBacklog, boardLive, boardRuns, boardSessions, CHIEF, CLIENT_NAMES, HEAD_9332, MONITOR, NOW } from "./testing/pipeline-board-fixture.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const column = (board: PipelineBoard, stage: string) => board.columns.find((each) => each.stage === stage)!;
const card = (board: PipelineBoard, key: string): BoardCard => {
  const found = board.columns.flatMap((each) => each.cards).find((each) => each.key === key);
  if (!found) throw new Error(`no card ${key}: ${board.columns.map((each) => `${each.stage}=[${each.cards.map((c) => c.key)}]`).join(" ")}`);
  return found;
};
const keys = (board: PipelineBoard, stage: string) => column(board, stage).cards.map((each) => each.key);
const all = (board: PipelineBoard) => board.columns.flatMap((each) => each.cards);

describe("the board of 04/10 02:13Z (real records)", () => {
  const board = buildPipelineBoard(boardInputs());

  it("puts every piece of work in one column, in the pipeline's order", () => {
    expect(board.columns.map((each) => each.stage)).toEqual(["entry", "session", "pr", "gate", "release", "production"]);
    expect(keys(board, "entry")).toEqual(["issue:9355", "issue:9365", "issue:9364", "issue:9358", "issue:9352", "issue:9337", "issue:9308", "issue:9305", "issue:9354", "issue:9074"]);
    expect(keys(board, "session")).toEqual(["issue:9058"]);
    expect(keys(board, "pr")).toEqual(["pr:9368"]);
    expect(keys(board, "gate")).toEqual(["issue:9052"]);
    expect(keys(board, "release")).toEqual(["issue:9195"]);
    expect(keys(board, "production")).toEqual(["issue:8204", "issue:9334", "issue:9185"]);
    expect(board.columns.map((each) => each.total)).toEqual([10, 1, 1, 1, 1, 3]);
    expect(board.limits).toEqual(DEFAULT_LIMITS);
  });

  it("an issue in a session: Sessão, idle since it stopped, its bot, its conversation, past 24 h", () => {
    const found = card(board, "issue:9058");
    expect(found).toMatchObject({
      stage: "session", state: "idle", reason: { code: "session-idle" }, issue: 9058, prs: [], priority: "p1", origin: "internal",
      bot: { id: CHIEF, name: "Chief of Staff" }, session: { id: "e47cf077-0000-4000-8000-000000000058", title: "Chat entra com aviso no Widget", status: "idle" },
      since: 1790884777154, limitMs: 24 * HOUR,
      links: { issue: "https://github.com/dinhogehm/nuria-platform/issues/9058", pr: null, session: { kind: "thread", botId: CHIEF } },
    });
    expect(isStale(found, NOW)).toBe(true);
  });

  it("a PR BEHIND main: in Gate since the first ci:local of its worktree after it opened (01/10 15:57Z), blocked by BEHIND", () => {
    const found = card(board, "issue:9052");
    expect(found).toMatchObject({
      stage: "gate", state: "blocked", blocked: true, reason: { code: "behind" }, prs: [9332], priority: "p1",
      gate: { status: "missing", receipt: "other", at: null },
      since: Date.parse("2026-10-01T15:57:24Z"), limitMs: 24 * HOUR,
      title: "Atendimento: criar configuração de tempo de reabertura do atendimento",
      links: { pr: "https://github.com/dinhogehm/nuria-platform/pull/9332" },
    });
    expect(found.session?.status).toBe("running");
    expect(isStale(found, NOW)).toBe(true);
  });

  it("a release in progress: the PR merged before it started rides it, and the carrier is no card", () => {
    const found = card(board, "issue:9195");
    expect(found).toMatchObject({
      stage: "release", state: "running", reason: { code: "release-running", detail: "3c04d7c3d" },
      release: { sha: "3c04d7c3d", state: "running", at: 1791075557000 }, prs: [9280], since: 1791075278000, origin: "client", limitMs: 4 * HOUR,
    });
    expect(found.title).toBe("Helpdesk: tickets novos caem todos em um agente (outros vazios) ao logar no CRM");
    expect(all(board).some((each) => each.prs.includes(9370))).toBe(false);
  });

  it("delivered: by the release's content when the compare is known, by the times otherwise — and said so", () => {
    expect(card(board, "issue:8204")).toMatchObject({ stage: "production", state: "done", since: 1791071914000, release: { sha: "f9e7a2350", state: "released", at: 1791071914000 }, prs: [9350] });
    expect(card(board, "issue:8204").release).not.toHaveProperty("inferred");
    // 9344/9345/9348 merged before 9dbb1dcdd was first tried (02/10 18:42Z), whose content was never read
    expect(card(board, "issue:9334")).toMatchObject({ stage: "production", release: { sha: "9dbb1dcdd", inferred: true, at: 1790979918000 }, prs: [9344, 9345, 9348], issues: [9331, 9334, 9347] });
    expect(card(board, "issue:9334").links.pr).toMatch(/\/pull\/93(44|45|48)$/);
  });

  it("what waits on the person is in evidence on its card: state owner, the item to open, in Entrada and in Produção alike", () => {
    expect(card(board, "issue:9355")).toMatchObject({ state: "owner", owner: { botId: MONITOR, pendingId: "o14", since: 1790960959453, more: 0 }, bot: { id: MONITOR }, origin: "client" });
    expect(card(board, "issue:9334")).toMatchObject({ state: "owner", owner: { pendingId: "o15" } });
    expect(column(board, "entry").cards[0]!.state).toBe("owner");
  });

  it("an issue closed before a PR opened does not fold that PR into its work (lot W's 'Refs #9347')", () => {
    expect(card(board, "pr:9368")).toMatchObject({ stage: "pr", issues: [], state: "idle", reason: { code: "no-gate" }, bot: null, session: null, title: "Fila sem estouro atrás de release, máquina devolvida na fase de rede, release mais curto (lote W)" });
  });

  it("shows no requester or client name anywhere", () => {
    const text = JSON.stringify(board);
    for (const name of CLIENT_NAMES) expect(text).not.toContain(name);
    expect(card(board, "issue:9365").title).toBe("Aviso vermelho de limite de assentos na tela da atendente e fila esvaziada sem explicação");
    expect(card(board, "issue:9355").title).toBe("CSAT enviado ao fim do N1 teve a nota atribuída ao N2");
  });

  it("lists the bots that carry cards, for the filter, and where its data comes from", () => {
    expect(board.bots).toEqual([{ id: CHIEF, name: "Chief of Staff" }, { id: MONITOR, name: "Monitor Chat Atendimento" }]);
    expect(board.sources).toEqual({ githubSyncedAt: NOW - 10 * 60_000, livePrsAt: NOW - 60_000, livePrsError: null, releaseLogTo: NOW - 30_000, releaseHold: "o release de produção 3c04d7c3d está em andamento" });
  });
});

describe("INSP-Z r1", () => {
  it("Z-1: Entrada leads with what waits on the person and the clients' demands, newest first; old backlog goes to the tail", () => {
    const board = buildPipelineBoard(boardInputsWithBacklog());
    const entry = column(board, "entry").cards;
    expect(entry.length).toBeGreaterThan(ENTRY_FOLD);
    const at = (key: string) => entry.findIndex((each) => each.key === key);
    for (const key of ["issue:9365", "issue:9364", "issue:9358", "issue:9352", "issue:9337"]) {
      expect(at(key)).toBeGreaterThanOrEqual(0);
      expect(at(key)).toBeLessThan(ENTRY_FOLD);
      expect(card(board, key).origin).toBe("client");
    }
    // the spreadsheet rows are on their cards
    expect(card(board, "issue:9358").sheetRow).toBe(110);
    expect(card(board, "issue:9352").sheetRow).toBe(106);
    // every client card comes before every internal one; the tail is internal and old
    const lastClient = Math.max(...entry.map((each, index) => (each.origin === "client" ? index : -1)));
    const firstInternal = entry.findIndex((each) => each.origin === "internal" && each.state !== "owner");
    expect(lastClient).toBeLessThan(firstInternal);
    expect(entry.slice(-2).map((each) => each.key)).toEqual(["issue:8128", "issue:7111"]);
    // newest first among the clients without priority
    expect(at("issue:9365")).toBeLessThan(at("issue:9358"));
    expect(at("issue:9358")).toBeLessThan(at("issue:9337"));
  });

  it("Z-2: an open issue whose PRs shipped over 7 days ago is back in Entrada, 'delivered on <date>', a cycle to close", () => {
    const board = buildPipelineBoard(boardInputs());
    expect(card(board, "issue:9074")).toMatchObject({
      stage: "entry", state: "idle", reason: { code: "delivered-open" }, closeout: true, prs: [9087, 9113, 9118],
      since: 1790111712000, release: { sha: "e21afb7e5", state: "released", at: 1790111712000, inferred: true },
      links: { pr: "https://github.com/dinhogehm/nuria-platform/pull/9118" }, limitMs: 7 * DAY, urgent: true,
    });
    expect(isStale(card(board, "issue:9074"), NOW)).toBe(true);
    // and it never vanishes: 9 days later, still there
    const later = buildPipelineBoard(boardInputs({ now: NOW + 9 * DAY } as Partial<BoardInputs>));
    expect(card(later, "issue:9074").stage).toBe("entry");
  });

  it("Z-3: limits are the owner's — defaults sane, saved values used, broken ones the default", () => {
    expect(DEFAULT_LIMITS).toEqual({ entryUrgentH: 168, entryOtherH: 720, sessionH: 24, prH: 24, gateH: 24, releaseH: 4 });
    expect(sanitizeLimits({ sessionH: 6, gateH: -1, prH: 2.5, releaseH: "8", entryOtherH: 99_999, junk: 1 })).toEqual({ ...DEFAULT_LIMITS, sessionH: 6 });
    const board = buildPipelineBoard(boardInputs({ limits: { ...DEFAULT_LIMITS, sessionH: 100 * 24, entryUrgentH: 12 } }));
    expect(card(board, "issue:9058")).toMatchObject({ limitMs: 100 * DAY });
    expect(isStale(card(board, "issue:9058"), NOW)).toBe(false);
    expect(card(board, "issue:9354")).toMatchObject({ limitMs: 12 * HOUR });
    expect(isStale(card(board, "issue:9354"), NOW)).toBe(true);
    // a non-urgent Entrada card waits 30 days by default
    const backlog = buildPipelineBoard(boardInputsWithBacklog());
    expect(card(backlog, "issue:9363")).toMatchObject({ urgent: false, limitMs: 30 * DAY });
    expect(board.limits.sessionH).toBe(100 * 24);
  });

  it("Z-4: 'Fecha #N' is an explicit reference: #9190 and #9185 are one card, not two", () => {
    expect(explicitReferences("Fecha #9185 (degrau 2 do épico #8984).")).toEqual([9185]);
    expect(explicitReferences("Corrige #12; resolve #13 e encerra #14. Closes #15")).toEqual([12, 13, 14, 15]);
    expect(explicitReferences("fechamento #16, corrigido no #17")).toEqual([]);
    const board = buildPipelineBoard(boardInputs());
    expect(card(board, "issue:9185")).toMatchObject({ stage: "production", prs: [9190], release: { sha: "f6d127693" } });
    expect(all(board).filter((each) => each.issues.includes(9185) || each.prs.includes(9190))).toHaveLength(1);
  });

  it("Z-6: a session archived without a PR: one state — reopen it or close the issue", () => {
    const board = buildPipelineBoard(boardInputs());
    expect(card(board, "issue:9305")).toMatchObject({
      stage: "entry", state: "idle", reason: { code: "session-archived" }, closeout: true, since: 1790793140122,
      session: { id: "28963e07-1958-421f-99fa-b4eb1d1fc5bb", status: "archived" },
      links: { session: { kind: "app", url: "claude://code/continue?session=local_afeb24d3-d5d4-4d9b-8040-1d7f52a094bc" } },
    });
    expect(all(board).filter((each) => each.reason?.code === "no-session" && each.session !== null)).toEqual([]);
  });

  it("Z-8: a retry of a commit first tried before the merge never ships it — not even by the times", () => {
    // d5bb1f70b (first tried 02/10 13:21Z) released again after #9280 merged (04/10 00:54Z)
    const runs = [...boardRuns().filter((run) => run.outcome !== "running"),
      { key: "d5bb1f70bea397bdd937d02148c685e406985ba0:99999", sha: "d5bb1f70bea397bdd937d02148c685e406985ba0", pid: 99999, outcome: "released" as const, startedAt: 1791076000000, endedAt: 1791078000000, timeSource: "log" as const }];
    const board = buildPipelineBoard(boardInputs({ runs, releaseHold: null }));
    expect(card(board, "issue:9195")).toMatchObject({ stage: "release", state: "queued", reason: { code: "release-wait" }, release: null });
    // a release on its way of an older commit does not carry it either
    const held = buildPipelineBoard(boardInputs({ runs: boardRuns().filter((run) => run.outcome !== "running"), releaseHold: "release:production:d5bb1f70bea397bdd937d02148c685e406985ba0" }));
    expect(card(held, "issue:9195")).toMatchObject({ state: "queued", reason: { code: "release-wait" } });
    // the merge's own commit does
    const own = buildPipelineBoard(boardInputs({ runs: boardRuns().filter((run) => run.outcome !== "running"), releaseHold: "release:production:432bbd027f2794ae95ea7e823e30403743f90a49" }));
    expect(card(own, "issue:9195")).toMatchObject({ state: "running", reason: { code: "release-running", detail: "432bbd027" } });
  });

  it("Z-9: blocked stays counted when the owner's item also waits; ci runs from before the PR do not start its gate", () => {
    const board = buildPipelineBoard(boardInputs({ ownerPending: [...boardInputs().ownerPending, { id: "o4", botId: CHIEF, threadId: "t4", title: "Decidir a PR #9332", createdAt: NOW - HOUR }] }));
    expect(card(board, "issue:9052")).toMatchObject({ state: "owner", blocked: true, reason: { code: "behind" } });
    const early = buildPipelineBoard(boardInputs({ receipts: {}, ciRuns: { "35787b0f-ff38-459e-b543-0dd921d068f4": [Date.parse("2026-09-30T10:00:00Z")] } }));
    expect(card(early, "issue:9052")).toMatchObject({ stage: "pr", since: 1790867876000 });
  });
});

describe("the board's rules", () => {
  it("is deterministic: the same inputs in another order give the same board", () => {
    const one = buildPipelineBoard(boardInputs());
    const live = boardLive();
    const two = buildPipelineBoard(boardInputs({
      sessions: [...boardSessions()].reverse(),
      runs: [...boardRuns()].reverse(),
      live: { ...live, open: [...live.open].reverse(), merged: [...live.merged].reverse() },
    }));
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it("says unknown, never zero, when GitHub was never read: '—' columns, the sessions still known", () => {
    const board = buildPipelineBoard(boardInputs({ github: null, live: null }));
    expect(board.columns.map((each) => [each.stage, each.known, each.total])).toEqual([
      ["entry", false, null], ["session", true, 2], ["pr", false, null], ["gate", false, null], ["release", false, null], ["production", false, null],
    ]);
    expect(keys(board, "session")).toEqual(["issue:9052", "issue:9058"]);
  });

  it("an unknown time is null, and never stale", () => {
    const live = boardLive();
    const board = buildPipelineBoard(boardInputs({ receipts: {}, ciRuns: {}, live: { ...live, open: [{ ...live.open[0]!, gate: "pending", gateAt: null, mergeState: "CLEAN" }, live.open[1]!] } }));
    const found = card(board, "issue:9052");
    expect(found).toMatchObject({ stage: "gate", since: null, state: "running", reason: { code: "gate-pending" } });
    expect(isStale(found, NOW + 100 * HOUR)).toBe(false);
  });

  it("a failing release blocks what waits for it, with the failing step and the tries", () => {
    const runs = boardRuns().map((run) => (run.outcome === "running" ? { ...run, outcome: "failed" as const, endedAt: NOW - HOUR, cause: "Local CI failed at script-contracts" } : run));
    const board = buildPipelineBoard(boardInputs({ runs, releaseHold: null, admission: { lease: null, intents: [] } }));
    expect(card(board, "issue:9195")).toMatchObject({ stage: "release", state: "blocked", blocked: true, reason: { code: "release-failed", detail: "Local CI failed at script-contracts", count: 1 }, release: { sha: "3c04d7c3d", state: "failed" } });
  });

  it("waits behind the next release when none runs", () => {
    const runs = boardRuns().filter((run) => run.outcome !== "running");
    const board = buildPipelineBoard(boardInputs({ runs, releaseHold: null }));
    expect(card(board, "issue:9195")).toMatchObject({ state: "queued", reason: { code: "release-wait" }, release: null, limitMs: 4 * HOUR });
  });

  it("ci:local of a PR's head holding the machine is the gate running; queued for it, queued", () => {
    const running = buildPipelineBoard(boardInputs({ admission: { lease: { kind: "ci-full", label: "local-ci:5bc51ed" }, intents: [] } }));
    expect(card(running, "pr:9368")).toMatchObject({ stage: "gate", state: "running", reason: { code: "ci-running" } });
    const queued = buildPipelineBoard(boardInputs({ admission: { lease: null, intents: ["local-ci:5bc51ed"] } }));
    expect(card(queued, "pr:9368")).toMatchObject({ stage: "gate", state: "queued", reason: { code: "ci-queued" } });
  });

  it("a green gate waits on the merge; a red one is blocked", () => {
    const live = boardLive();
    const green = buildPipelineBoard(boardInputs({ live: { ...live, open: [live.open[0]!, { ...live.open[1]!, gate: "success", gateAt: NOW - HOUR, mergeState: "CLEAN" }] } }));
    expect(card(green, "pr:9368")).toMatchObject({ stage: "gate", state: "idle", reason: { code: "awaiting-merge" }, since: NOW - HOUR, gate: { status: "success" } });
    const red = buildPipelineBoard(boardInputs({ live: { ...live, open: [live.open[0]!, { ...live.open[1]!, gate: "failure", gateAt: NOW - HOUR }] } }));
    expect(card(red, "pr:9368")).toMatchObject({ state: "blocked", reason: { code: "gate-failed" } });
  });

  it("the receipt of the head itself, with no gate published, says so", () => {
    const board = buildPipelineBoard(boardInputs({ receipts: { "35787b0f-ff38-459e-b543-0dd921d068f4": { commit: HEAD_9332, finishedAt: NOW - HOUR } }, live: { ...boardLive(), open: [{ ...boardLive().open[0]!, mergeState: "CLEAN" }, boardLive().open[1]!] } }));
    expect(card(board, "issue:9052")).toMatchObject({ stage: "gate", reason: { code: "receipt-only" }, gate: { receipt: "head", at: NOW - HOUR }, since: Date.parse("2026-10-01T15:57:24Z") });
  });

  it("a failed session is blocked with its recorded error; an app session links to the Claude app", () => {
    const sessions = boardSessions().map((session) => session.title.startsWith("9058")
      ? { ...session, status: "failed", failedAt: NOW - HOUR, lastError: "the turn ran past 45 minutes and was stopped" } : session);
    const board = buildPipelineBoard(boardInputs({ sessions }));
    expect(card(board, "issue:9058")).toMatchObject({ state: "blocked", reason: { code: "session-failed", detail: "the turn ran past 45 minutes and was stopped" } });
    const app = buildPipelineBoard(boardInputs({ sessions: boardSessions().map((session) => session.title.startsWith("9058") ? { ...session, surface: "app", desktop: { localId: "local_21b6dfe7-b762-492b-b71f-23b1aece055b" } } : session) }));
    expect(card(app, "issue:9058").links.session).toEqual({ kind: "app", url: "claude://code/continue?session=local_21b6dfe7-b762-492b-b71f-23b1aece055b" });
  });

  it("an item answered and waiting on its bot is not the person's", () => {
    const board = buildPipelineBoard(boardInputs({ ownerPending: boardInputs().ownerPending.map((item) => ({ ...item, awaitingSince: NOW - 10 * 60_000 })) }));
    expect(card(board, "issue:9355")).toMatchObject({ state: "idle", owner: null });
  });

  it("without the board's own read, the collector's open PRs stand in, their gate unknown", () => {
    const board = buildPipelineBoard(boardInputs({ live: null }));
    expect(card(board, "pr:9368").gate).toEqual({ status: "unknown", receipt: null, at: null });
    expect(column(board, "pr").known).toBe(true);
  });

  it("an open PR gone from a complete live read leaves the board; from a partial one (100+ open) it stays", () => {
    const live = boardLive();
    expect(all(buildPipelineBoard(boardInputs({ live: { ...live, open: [live.open[0]!] } }))).some((each) => each.key === "pr:9368")).toBe(false);
    expect(all(buildPipelineBoard(boardInputs({ live: { ...live, open: [live.open[0]!], openComplete: false } }))).some((each) => each.key === "pr:9368")).toBe(true);
  });

  it("Produção keeps the last 7 days only", () => {
    const later = buildPipelineBoard(boardInputs({ now: 1790979918000 + 7 * DAY + 60_000 } as Partial<BoardInputs>));
    expect(keys(later, "production")).toEqual(["issue:8204"]);
  });

  it("an old P3 nobody names stays off; an old P0 nobody touched is counted as backlog", () => {
    const board = buildPipelineBoard(boardInputs());
    expect(JSON.stringify(board)).not.toContain("9293");
    expect(JSON.stringify(board)).not.toContain("7857");
    expect(column(board, "entry").dormant).toBe(1);
    expect(board.columns.filter((each) => each.stage !== "entry").every((each) => each.dormant === null)).toBe(true);
  });
});

describe("titles, rows and receipts", () => {
  const names = nameDictionary([
    "Helpdesk: ticket 142527 não distribuído — automação registrou \"fora do horário\" — Fulana 30/09",
    "BI: indicadores de CSAT não funcionam — erro de filtros não compatíveis (Beltrano, planilha L110)",
    "fix(web): refresh do board derruba o D1 do ACMECORP (#8891)",
    "core: coluna extra estoura o teto do D1 (tenant ACMECORP)",
    "Relato do Sicrano: tela trava",
    "CSAT atribuído ao N2 (ticket 142461, Patricia 02/10)",
    // never a name: a common word before a date, or a date that is no date
    "Deploy 02/10 travou na fila",
    "fix(release): Relatório 30/09 sai vazio",
    "Etapa 1/3 do épico (Etapa 1/3)",
    "(Deploy 02/10)",
  ]);

  it("learns the requesters and the clients only where the title says who asked or names a client", () => {
    expect([...names.people].sort()).toEqual(["beltrano", "fulana", "patricia", "sicrano"]);
    expect([...names.tenants]).toEqual(["acmecorp"]);
  });

  it("removes them with their date, row, ticket or reference, and the commit prefix", () => {
    expect(boardTitle("BI: indicadores de CSAT não funcionam — erro de filtros não compatíveis (Beltrano, planilha L110)", names)).toBe("BI: indicadores de CSAT não funcionam — erro de filtros não compatíveis");
    expect(boardTitle("fix(filas): Sidebar do ticket (Filas > Editar) salva mas não reflete — reprovação linha 106 (Fulana, 02/10) (ref #8204)", names)).toBe("Sidebar do ticket (Filas > Editar) salva mas não reflete");
    expect(boardTitle("fix(web): refresh do board derruba o D1 do ACMECORP (#8891)", names)).toBe("Refresh do board derruba o D1 do cliente");
    expect(boardTitle("Epic: e-mail do helpdesk — achados do caso AcmeCorp", names)).toBe("Epic: e-mail do helpdesk");
    expect(boardTitle("Piloto AcmeCorp: D1 com full-scans", names)).toBe("Piloto cliente: D1 com full-scans");
    expect(boardTitle("Revalidar portal acmecorp-crm 404", names)).toBe("Revalidar portal cliente-crm 404");
    expect(boardTitle("gate de main no Node da .nvmrc", names)).toBe("Gate de main no Node da .nvmrc");
    expect(boardTitle("Relato do Sicrano: tela trava", names)).toBe("Relato: tela trava");
    expect(boardTitle("9334 9331 Inatividade do chat", names)).toBe("Inatividade do chat");
    expect(boardTitle("Atendimento: e-mail do Fulana não grava", names)).toBe("Atendimento: e-mail não grava");
    expect(boardTitle("", names)).toBe("—");
  });

  it("Z-7: in any case and with or without accents; e-mail addresses and a client's domain; no orphan punctuation", () => {
    expect(boardTitle("Erro reportado pela Patrícia 02/10 no CSAT", names)).toBe("Erro reportado no CSAT");
    expect(boardTitle("Erro do PATRÍCIA e da patricia no filtro", names)).toBe("Erro e no filtro");
    expect(boardTitle("Helpdesk: remetente em domínio do cliente — ex.: suporte@crmacmecorp.com", names)).toBe("Helpdesk: remetente em domínio do cliente");
    expect(boardTitle("Remetente crmacmecorp.com recusado pelo SendGrid", names)).toBe("Remetente cliente recusado pelo SendGrid");
    expect(boardTitle("Contato fulana.silva@gmail.com não recebe o e-mail", names)).toBe("Contato e-mail não recebe o e-mail");
    expect(boardTitle("Fulana: aviso vermelho na fila", names)).toBe("Aviso vermelho na fila");
    expect(boardTitle("Fulana/Beltrano 30/09 — erro na fila", names)).toBe("Erro na fila");
    // common words stay: they were never learned
    expect(boardTitle("Deploy 02/10 travou na fila", names)).toBe("Deploy 02/10 travou na fila");
    expect(boardTitle("Relatório mensal fica zerado", names)).toBe("Relatório mensal fica zerado");
    expect(fold("Patrícia")).toBe("patricia");
  });

  it("capitals are not a client: emphasis and code stay as written", () => {
    const caps = nameDictionary(["FORBIDDEN_WORDS apaga sentenças de resposta NEGATIVA legítima", "depois de ABORTAR a suíte do web"]);
    expect([...caps.tenants]).toEqual([]);
    expect(boardTitle("FORBIDDEN_WORDS apaga sentenças de resposta NEGATIVA legítima", caps)).toBe("FORBIDDEN_WORDS apaga sentenças de resposta NEGATIVA legítima");
  });

  it("reads the spreadsheet row a title names", () => {
    expect(sheetRowOf("(Beltrano, planilha L110)")).toBe(110);
    expect(sheetRowOf("Reprovado: widget pede código (L99)")).toBe(99);
    expect(sheetRowOf("reprovação linha 106 (Fulana, 02/10)")).toBe(106);
    expect(sheetRowOf("linha 12 da planilha")).toBe(12);
    expect(sheetRowOf("ATD-202610-0042 reaberto")).toBeNull();
  });

  it("reads a ci:local receipt, and only a successful one; and its runs' stamps", () => {
    const text = "CI_COMMIT=e388511c72a261e7f10cd191f01a7add05d9e685\nCI_BASE_COMMIT=3c04d7c3d2608c36f082fded54bcb0d99e833a85\nCI_PROFILE=full\nCI_FINISHED_AT=20261004T135853Z\nCI_RESULT=success\n";
    expect(parseReceipt(text)).toEqual({ commit: "e388511c72a261e7f10cd191f01a7add05d9e685", finishedAt: Date.parse("2026-10-04T13:58:53Z") });
    expect(parseReceipt(text.replace("success", "failure"))).toBeNull();
    expect(parseReceipt("CI_COMMIT=nope\nCI_RESULT=success")).toBeNull();
    expect(utcStamp("20261001T155724Z-full-6cf57a9af456-39753")).toBe(Date.parse("2026-10-01T15:57:24Z"));
  });
});
