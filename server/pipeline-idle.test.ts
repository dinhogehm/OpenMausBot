import { describe, expect, it } from "vitest";
import {
  heldByOwner,
  releaseInFlightOf,
  idleCandidates,
  idleIssuesArgs,
  mentionedNumbers,
  parseIdleIssues,
  parseOpenPrCount,
  PIPELINE_IDLE_PREFIX,
  pipelineIdleReport,
  pipelineIdleStep,
  pipelineOrder,
  sessionLive,
  type IdleSession,
  type PipelineIdleState,
} from "./pipeline-idle.ts";

const REPO = "dinhogehm/nuria-platform";
const brt = (stamp: string) => Date.parse(`${stamp}-03:00`);
const hours = (n: number) => n * 3_600_000;

// `gh issue list … --json number,title,labels,createdAt` on 05/10 (a part of the 33 open P1)
const ISSUES_JSON = JSON.stringify([
  { number: 9354, title: "fix(release): produção de d5bb1f70b reprova 10× em script-contracts", createdAt: "2026-10-02T16:16:48Z", labels: [{ name: "type:bug" }, { name: "source:agent" }, { name: "priority:p1" }] },
  { number: 9284, title: "Reprovado: mensagem de agentes offline via automação / Chat Web não dispara", createdAt: "2026-09-29T12:04:14Z", labels: [{ name: "type:bug" }, { name: "priority:p1" }, { name: "app:atendimento" }] },
  { number: 9282, title: "Reprovado: widget continua pedindo OTP ao clicar em ticket (após #8998)", createdAt: "2026-09-29T12:04:09Z", labels: [{ name: "app:widget" }, { name: "priority:p1" }] },
  { number: 9195, title: "Helpdesk: tickets novos caem todos em um agente (outros vazios) ao logar", createdAt: "2026-09-24T12:29:14Z", labels: [{ name: "app:helpdesk" }, { name: "status:in-progress" }, { name: "priority:p1" }, { name: "esteira" }] },
  { number: 9058, title: "Chats distribuídos mesmo com agentes offline e aviso no Widget", createdAt: "2026-09-21T14:21:23Z", labels: [{ name: "app:widget" }, { name: "type:bug" }, { name: "priority:p1" }] },
  { number: 8675, title: "GET/POST de mensagens em /conversations/:id validam só o workspace — membro de outra equipe lê a conversa", createdAt: "2026-08-25T21:05:23Z", labels: [{ name: "app:ai" }, { name: "type:security" }, { name: "priority:p1" }] },
  { number: 9001, title: "sem prioridade P0/P1 (a busca não a traria; parse a ignora)", createdAt: "2026-09-01T00:00:00Z", labels: [{ name: "priority:p2" }] },
]);

// cc-sessions.json on 05/10: #9058's session left idle on 02/10 14:36; #9052's archived at 20:13
const SESSIONS: IdleSession[] = [
  { title: "9058 Chat entra com aviso no Widget", status: "idle", lastActivityAt: brt("2026-10-02T14:36:00"), createdAt: brt("2026-10-01T16:59:00") },
  { title: "9052 Tempo de reabertura configurável", status: "archived", lastActivityAt: brt("2026-10-04T20:13:00") },
];

// The bots' texts with a "#N" (messages.db), as they were written that night
const MENTIONS: Array<[number, string]> = [
  [brt("2026-10-04T20:13:29"), "Osvaldo, a **#9052** (tempo de reabertura configurável) está em produção."],
  [brt("2026-10-04T20:31:28"), "Conferi os dois comentários nas issues e marquei a pendência como resolvida: - [#9331, co…"],
  [brt("2026-10-04T20:53:00"), "Monitor: comentários da decisão da #9356 e da #9282 postados pelo Osvaldo."],
  [brt("2026-10-04T22:04:30"), "Osvaldo, a main andou: entrou a PR #9373."],
];
const mentionedAt = (now: number) => mentionedNumbers(MENTIONS.filter(([at]) => at <= now && now - at < hours(24)).map(([, text]) => text));

describe("the pipeline standing still (R12-followup #1)", () => {
  it("reads the open P0/P1, the queue and a live session", () => {
    const issues = parseIdleIssues(ISSUES_JSON)!;
    expect(issues.map((each) => [each.number, each.priority])).toContainEqual([8675, "p1"]);
    expect(issues.some((each) => each.number === 9001)).toBe(false);
    expect(parseIdleIssues("not json")).toBeNull();
    const at = Date.parse("2026-10-05T16:20:00Z");
    expect(parseOpenPrCount("[]", at)).toBe(0);
    expect(parseOpenPrCount(JSON.stringify([{ number: 9379, isDraft: false }, { number: 9380, isDraft: true }]), at)).toBe(1);
    expect(parseOpenPrCount("", at)).toBeNull();
    expect(idleIssuesArgs(REPO)).toContain('label:"priority:p0","priority:p1"');
    const now = brt("2026-10-04T20:20:00");
    // idle since 02/10: nobody is on it; running, or moved in the last day: someone is
    expect(sessionLive(SESSIONS[0]!, now)).toBe(false);
    expect(sessionLive({ ...SESSIONS[0]!, status: "running" }, now)).toBe(true);
    expect(sessionLive({ ...SESSIONS[0]!, lastActivityAt: now - hours(3) }, now)).toBe(true);
    expect(sessionLive({ ...SESSIONS[1]!, lastActivityAt: now }, now)).toBe(false);
    expect(mentionedNumbers(["PR #9373 e #93730", "nada"])).toEqual(new Set([9373, 93730]));
  });

  it("the night of 04/10 to 05/10: one wake at 20:20 naming #8675 then #9058, and none again before the owner wrote at 09:34", () => {
    const issues = parseIdleIssues(ISSUES_JSON)!;
    // the release of the carrier #9372 ran from 17:41 to 20:12; the PR #9373 was open until its merge at 22:04
    const releaseInFlight = (at: number) => at >= brt("2026-10-04T17:41:00") && at < brt("2026-10-04T20:12:00");
    const openPrs = (at: number) => (at >= brt("2026-10-04T21:50:00") && at < brt("2026-10-04T22:04:00") ? 1 : 0);
    let state: PipelineIdleState = {};
    const wakes: Array<{ at: number; numbers: number[]; report: string }> = [];
    for (let at = brt("2026-10-04T19:00:00"); at <= brt("2026-10-05T09:34:00"); at += 10 * 60_000) {
      const candidates = idleCandidates(issues, SESSIONS, mentionedAt(at), at);
      const step = pipelineIdleStep(state, { stopped: false, openPrs: openPrs(at), releaseInFlight: releaseInFlight(at), candidates, now: at });
      state = step.state;
      if (step.wake) wakes.push({ at, numbers: candidates.map((each) => each.number), report: pipelineIdleReport(candidates, REPO, null) });
    }
    expect(wakes.map((wake) => new Date(wake.at).toISOString())).toEqual([new Date(brt("2026-10-04T20:20:00")).toISOString()]);
    // oldest first: the owner's "P1 mais antigas, começando pela #8675"; #9282 had no bot naming it yet at 20:20
    expect(wakes[0]!.numbers).toEqual([8675, 9058, 9195, 9282, 9284, 9354]);
    const report = wakes[0]!.report;
    expect(report.startsWith(`${PIPELINE_IDLE_PREFIX} A fila de PRs abertas do ${REPO} está vazia e não há release em curso.`)).toBe(true);
    expect(report).toContain("- #8675 (P1, aberta em 25/08; sem sessão): GET/POST de mensagens em /conversations/:id validam só o workspace");
    expect(report).toContain("- #9058 (P1, aberta em 21/09; sessão «9058 Chat entra com aviso no Widget» idle desde 02/10): Chats distribuídos");
    expect(report).toContain("Pegue a próxima: retome ou abra a sessão dela e avise o dono no canal");
    expect(state).toEqual({ lastAt: brt("2026-10-04T20:20:00"), lastNumbers: [8675, 9058, 9195, 9282, 9284, 9354] });
  });

  it("a stop, a release or an unreadable GitHub wakes nobody; a live session or a bot naming the issue takes it off the list", () => {
    const issues = parseIdleIssues(ISSUES_JSON)!;
    const at = brt("2026-10-04T20:20:00");
    const candidates = idleCandidates(issues, SESSIONS, new Set(), at);
    expect(pipelineIdleStep({}, { stopped: true, openPrs: 0, releaseInFlight: false, candidates, now: at })).toMatchObject({ wake: false, why: "~/.nuria/stop", state: {} });
    expect(pipelineIdleStep({}, { stopped: false, openPrs: 0, releaseInFlight: true, candidates, now: at }).wake).toBe(false);
    expect(pipelineIdleStep({}, { stopped: false, openPrs: null, releaseInFlight: false, candidates, now: at }).wake).toBe(false);
    expect(pipelineIdleStep({}, { stopped: false, openPrs: 0, releaseInFlight: null, candidates, now: at }).wake).toBe(false);
    expect(pipelineIdleStep({}, { stopped: false, openPrs: 0, releaseInFlight: false, candidates: [], now: at }).wake).toBe(false);
    // the Chief opened #8675's session and named #9058: both leave the list
    const taken = idleCandidates(issues, [...SESSIONS, { title: "8675 Mensagens validam só o workspace", status: "running", lastActivityAt: at }], new Set([9058]), at);
    expect(taken.map((each) => each.number)).toEqual([9195, 9282, 9284, 9354]);
    // a P0 comes before every P1
    const p0 = idleCandidates([...issues, { number: 9400, title: "Fora do ar", priority: "p0", createdAt: at }], SESSIONS, new Set(), at);
    expect(p0[0]!.number).toBe(9400);
  });

  it("at most once every 6 h; within 24 h only an issue it was not told of wakes it again; the same list comes back after 24 h", () => {
    const issues = parseIdleIssues(ISSUES_JSON)!;
    const told = brt("2026-10-04T20:20:00");
    const state: PipelineIdleState = { lastAt: told, lastNumbers: [8675, 9058, 9195, 9282, 9284, 9354] };
    const look = (at: number, extra: typeof issues = []) => pipelineIdleStep(state, { stopped: false, openPrs: 0, releaseInFlight: false, candidates: idleCandidates([...issues, ...extra], SESSIONS, new Set(), at), now: at });
    const fresh = [{ number: 9390, title: "Nova P1", priority: "p1" as const, createdAt: told + hours(1) }];
    expect(look(told + hours(5), fresh)).toMatchObject({ wake: false, why: "avisado há menos de 6 h" });
    expect(look(told + hours(7))).toMatchObject({ wake: false, why: "as mesmas issues já foram avisadas há menos de 24 h" });
    expect(look(told + hours(7), fresh)).toMatchObject({ wake: true, state: { lastAt: told + hours(7), lastNumbers: [8675, 9058, 9195, 9282, 9284, 9354, 9390] } });
    expect(look(told + hours(24)).wake).toBe(true);
  });

  it("quotes the owner's standing order when there is one", () => {
    const orders = [
      { at: brt("2026-10-02T16:32:00"), text: "Prioridade até segunda ordem: escoar para produção…" },
      { at: brt("2026-10-03T15:53:20"), text: "Objetivo permanente: manter a esteira andando. Sempre que a fila do gate estiver livre e não houver release rodando, pegue a PR aberta mais antiga e pronta (P1 primeiro)…" },
    ];
    const order = pipelineOrder(orders);
    expect(order?.at).toBe(orders[1]!.at);
    const report = pipelineIdleReport(idleCandidates(parseIdleIssues(ISSUES_JSON)!, SESSIONS, new Set(), brt("2026-10-04T20:20:00")), REPO, order);
    expect(report).toContain("Ordem do dono de 03/10: «Objetivo permanente: manter a esteira andando.");
    expect(pipelineOrder([orders[0]!])).toBeNull();
  });

  // INSP-R12F F4 and F5
  it("a release not read yet, being read, read long ago or unreadable is unknown, and unknown wakes nobody", () => {
    const now = Date.parse("2026-10-05T16:20:00Z");
    const fresh = { label: null, found: null, at: now - 30_000, running: false };
    expect(releaseInFlightOf(fresh, now, 120_000)).toBe(false);
    expect(releaseInFlightOf({ ...fresh, found: { overdue: false } }, now, 120_000)).toBe(true);
    // after a restart, before the first read: the initial state is not "no release"
    expect(releaseInFlightOf({ ...fresh, at: 0 }, now, 120_000)).toBeNull();
    expect(releaseInFlightOf({ ...fresh, running: true }, now, 120_000)).toBeNull();
    expect(releaseInFlightOf({ ...fresh, at: now - 600_000 }, now, 120_000)).toBeNull();
    expect(releaseInFlightOf({ ...fresh, label: "?" }, now, 120_000)).toBeNull();
    expect(pipelineIdleStep({}, { stopped: false, openPrs: 0, releaseInFlight: releaseInFlightOf({ ...fresh, at: 0 }, now, 120_000), candidates: idleCandidates(parseIdleIssues(ISSUES_JSON)!, SESSIONS, new Set(), now), now }).wake).toBe(false);
  });

  it("a blocked issue, one an open owner item names, and a PR forgotten for days do not count", () => {
    const now = Date.parse("2026-10-05T16:20:00Z");
    // #9027, P1 and status:blocked, as on 05/10
    const blocked = JSON.stringify([{ number: 9027, title: "Campos resetados ao salvar", createdAt: "2026-09-19T00:00:00Z", labels: [{ name: "status:blocked" }, { name: "priority:p1" }] }]);
    expect(parseIdleIssues(blocked)).toEqual([]);
    // an open "Precisa de você" item waits on the owner for #9058 (title) and #8675 (link)
    const held = heldByOwner([
      { title: "Decidir o aviso da #9058 no widget" },
      { title: "Liberar o hotfix", link: "https://github.com/dinhogehm/nuria-platform/issues/8675" },
    ]);
    expect(held).toEqual(new Set([9058, 8675]));
    expect(idleCandidates(parseIdleIssues(ISSUES_JSON)!, SESSIONS, held, now).map((each) => each.number)).not.toContain(9058);
    // the ops PR #9379 touched today keeps the pipeline moving; a PR untouched for 3 days does not
    const prs = JSON.stringify([{ number: 9100, isDraft: false, updatedAt: "2026-10-02T10:00:00Z" }]);
    expect(parseOpenPrCount(prs, now)).toBe(0);
    expect(parseOpenPrCount(JSON.stringify([{ number: 9379, isDraft: false, updatedAt: "2026-10-05T16:15:34Z" }]), now)).toBe(1);
  });
});
