// The delivery board's fixture (lot Z), taken from the real pipeline of
// 03–04/10/2026 (cc-sessions.json, the productivity cache, the release log,
// "Precisa de você" and GitHub), with the clock at 04/10 02:13Z — 23:13 in
// São Paulo, while the release of 3c04d7c3d was running:
//   - 9058: a session (idle) with no PR yet;
//   - 9052: its session running, PR #9332 BEHIND main, a ci:local receipt in
//     its worktree of a newer local commit;
//   - 9195: PR #9280 merged at 00:54Z, before the running release started (00:59Z);
//   - 8204: PR #9350 shipped by f9e7a2350 (the compare says so);
//   - 9331/9334: their session's PRs shipped (by the release times only), an
//     owner item still open on them;
//   - Entrada: 9354 (P1), 9355 (an owner item names it), 9365 (a client's, of 01/10).
// Requesters' names are replaced (Fulana, Beltrano, Sicrano), on purpose kept
// in the shapes the real titles use. What was adjusted to the clock: the
// running session's last activity and its receipt's time (both later in the
// real record).
import { emptyGhCache, type GhCache, type GhIssue, type GhPr } from "../productivity-github.ts";
import type { ReleaseRun } from "../productivity-release-log.ts";
import type { BoardInputs, BoardOwnerPending, BoardSession, LivePr } from "../pipeline-board.ts";

export const NOW = 1791080000000; // 2026-10-04T02:13:20Z
export const CHIEF = "871e87c8-74a4-427a-8a4e-494439e748a8";
export const MONITOR = "891b6b94-0000-4000-8000-000000000001";
export const CHIEF_DESK = "dbb9f1cf-0000-4000-8000-000000000001";
export const CLIENT_NAMES = ["Fulana", "Beltrano", "Sicrano"];

const S3C04 = "3c04d7c3d2608c36f082fded54bcb0d99e833a85";
const SF9E7 = "f9e7a2350e58397d155858568184650b66e24a91";
const SF82D = "f82d10edb99b702a5c3a227121eabbbc33fbd1ac";
export const HEAD_9332 = "407e3f9247c315011ad85c663cf74c21bfb01475";
export const LOCAL_9052 = "e388511c72a261e7f10cd191f01a7add05d9e685";

const issue = (number: number, title: string, createdAt: number, labels: string[], extra: Partial<GhIssue> = {}): GhIssue =>
  ({ number, title, createdAt, updatedAt: createdAt, closedAt: null, state: "OPEN", stateReason: null, labels, ...extra });

export function boardIssues(): GhIssue[] {
  return [
    issue(9052, "Atendimento: criar configuração de tempo de reabertura do atendimento", 1789951940000, ["type:feature", "source:agent", "priority:p1", "app:atendimento"]),
    issue(9058, "Chats distribuídos mesmo com agentes offline e aviso no Widget", 1790000483000, ["app:widget", "type:bug", "source:agent", "priority:p1"]),
    issue(9195, "Helpdesk: tickets novos caem todos em um agente (outros vazios) ao logar no CRM — Beltrano 24/09", 1790252954000, ["app:helpdesk", "type:bug", "source:agent", "status:in-progress", "priority:p1", "esteira"], { stateReason: "REOPENED" }),
    issue(8204, "fix(inbox): sidebar do detalhe diverge do helpdesk — catálogo sem árvore, campos descartados e FK de catalog_item_id quebrada", 1785848922000, ["source:agent"], { state: "CLOSED", closedAt: 1786577658000, stateReason: "COMPLETED" }),
    issue(9355, "fix(helpdesk): CSAT enviado ao fim do N1 teve a nota atribuída ao N2 (ticket 142461, Sicrano 02/10) (ref #8696)", 1790960752000, []),
    issue(9331, "fix(atendimento): inatividade encerrou o ATD-202609-0178 ~3 min após a mensagem da cliente e o retorno abriu atendimento novo (ATD-202610-0029)", 1790867717000, ["priority:p2", "app:atendimento", "bug"]),
    issue(9334, "fix(atendimento): inatividade não encerrou o ATD-202610-0028 depois do tempo configurado", 1790870521000, ["priority:p2", "app:atendimento", "bug"]),
    issue(9365, "fix(atendimento): aviso vermelho de limite de assentos na tela da atendente e fila esvaziada sem explicação (Fulana 01/10)", 1791031003000, ["bug"]),
    issue(9354, "fix(release): produção de d5bb1f70b reprova 10× em script-contracts — ExperimentalWarning do node:sqlite (Node 22) no stderr dos reconcilers", 1790957808000, ["type:bug", "source:agent", "priority:p1"]),
    // closed by #9348 on 02/10; lot W's #9368 (opened 03/10) still "Refs" it — history, not its work
    issue(9347, "Release travado em script-contracts: stderr com ExperimentalWarning do SQLite", 1790930000000, ["source:agent", "priority:p1", "bug", "esteira"], { state: "CLOSED", closedAt: 1790964800000, stateReason: "COMPLETED" }),
    // a P0 (old "critical") untouched since 30/07: backlog, counted under Entrada, not a card
    issue(7857, "FORBIDDEN_WORDS apaga sentenças de resposta NEGATIVA legítima; se for a única sentença, vira o sentinel que a policy N1 troca pelo fallback de incidente", 1785441636000, ["app:ai", "type:bug", "priority:critical", "source:agent"]),
    // older backlog: no priority, not recent, nobody names it — not on the board
    issue(9293, "Flaky: admission-control-contract.test.mjs depende do locale (pt_BR \"12,00\")", 1789600000000, ["type:bug", "priority:p3"]),
  ];
}

const merged = (number: number, title: string, createdAt: number, mergedAt: number, head: string, mergeSha: string, refs: number[], labels: string[] = []): LivePr => ({
  number, title, createdAt, updatedAt: mergedAt, mergedAt, state: "MERGED", draft: false, base: "main", head, headSha: null, mergeSha,
  gate: "success", gateAt: mergedAt - 600_000, mergeState: null, closes: [], refs, labels,
});

/** The board's live read at the clock: the two open PRs and the merged ones. */
export function boardLive(): NonNullable<BoardInputs["live"]> {
  return {
    at: NOW - 60_000,
    open: [
      { number: 9332, title: "feat(atendimento): prazo de reabertura configurável do atendimento do chat (#9052)", createdAt: 1790867876000, updatedAt: 1791070000000, mergedAt: null, state: "OPEN", draft: false, base: "main", head: "feat/9052-tempo-reabertura-configuravel-v2", headSha: HEAD_9332, mergeSha: null, gate: "missing", gateAt: null, mergeState: "BEHIND", closes: [], refs: [9052], labels: ["type:feature", "priority:p1", "app:atendimento"] },
      { number: 9368, title: "perf(release/admission): fila sem estouro atrás de release, máquina devolvida na fase de rede, release mais curto (lote W)", createdAt: 1791059533000, updatedAt: 1791070000000, mergedAt: null, state: "OPEN", draft: false, base: "main", head: "ops/lot-w-throughput", headSha: "5bc51ed6ab3dda77e6ec0a803b3582a97b1d3e46", mergeSha: null, gate: "missing", gateAt: null, mergeState: "BLOCKED", closes: [], refs: [9347], labels: [] },
    ],
    merged: [
      merged(9280, "fix(helpdesk): rodízio de equipe atômico no fallback de distribuição (#9195)", 1790646964000, 1791075278000, "hotfix/9195-helpdesk-team-round-robin-race", "432bbd027f2794ae95ea7e823e30403743f90a49", [9195]),
      merged(9350, "fix(filas): sidebar da fila do atendimento grava na chave que a conversa lê (ref #8204)", 1790950750000, 1791069231000, "fix/8204-sidebar-fila-atendimento", "ba034e1f30b43dd2abea695bb01082b69dc34c58", [8204]),
      merged(9344, "fix(inbox): pausa de inatividade do Webchat não vem mais marcada por padrão (#9334)", 1790927738000, 1790928868000, "fix/9334-pausa-inatividade-padrao", "3d98404b8cc8e4e55be6b795fb16e4159e971b43", [9334], ["priority:p2", "app:atendimento", "bug"]),
      merged(9345, "fix(atendimento): webchat não encerra antes do prazo nem ao dispensar pesquisa antiga (#9331)", 1790927771000, 1790929958000, "fix/9331-inatividade-encerra-cedo", "aa74c6345005427981e659874200dff5646a832d", [9331], ["priority:p2", "app:atendimento", "bug"]),
      merged(9348, "fix(scripts): contratos do reconciler selado não dependem do runtime Node (#9347)", 1790934232000, 1790964800000, "fix/9347-script-contracts-sqlite-warning", "9720b32e0c3179eafd7c0a31ae88b488528e7557", [9347], ["priority:p1", "bug"]),
      // the carrier that shipped 9280: how code ships, never a card
      merged(9370, "chore(release): carrier 9195-rodizio-equipe-atomico", 1791075300000, 1791075327000, "chore/release-carrier-9195-rodizio-equipe-atomico", S3C04, []),
    ],
  };
}

export function boardGithub(): GhCache {
  const github = emptyGhCache();
  for (const each of boardIssues()) github.issues[String(each.number)] = each;
  const toGh = (pr: LivePr): GhPr => ({ number: pr.number, title: pr.title, createdAt: pr.createdAt, updatedAt: pr.updatedAt, mergedAt: pr.mergedAt, closedAt: pr.mergedAt, state: pr.state, draft: pr.draft, base: pr.base, head: pr.head, mergeSha: pr.mergeSha, closes: pr.closes, refs: pr.refs, labels: pr.labels });
  const live = boardLive();
  for (const pr of [...live.merged, ...live.open]) github.prs[String(pr.number)] = toGh(pr);
  // what f9e7a2350 carried (the real compare: three commits, #9350's merge among them)
  github.compares[`${SF82D}...${SF9E7}`] = ["ba034e1f30b43dd2abea695bb01082b69dc34c58", "1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"];
  github.openPrs = live.open.map((pr) => ({ number: pr.number, title: pr.title, createdAt: pr.createdAt, draft: pr.draft, base: pr.base, headSha: pr.headSha, gate: pr.gate, gateAt: pr.gateAt }));
  github.syncedAt = NOW - 10 * 60_000;
  return github;
}

const run = (sha: string, pid: number, outcome: ReleaseRun["outcome"], startedAt: number, endedAt: number | null, extra: Partial<ReleaseRun> = {}): ReleaseRun =>
  ({ key: `${sha}:${pid}`, sha, pid, outcome, startedAt, endedAt, timeSource: "log", ...extra });

/** The release log of 02–04/10 as the collector parsed it, at the clock. */
export function boardRuns(): ReleaseRun[] {
  return [
    run("d5bb1f70bea397bdd937d02148c685e406985ba0", 68244, "failed", 1790954490000, 1790956598000, { cause: "Local CI failed at script-contracts", headPr: 9346 }),
    run("d5bb1f70bea397bdd937d02148c685e406985ba0", 70272, "failed", 1790958178000, 1790960253000, { cause: "Local CI failed at script-contracts", headPr: 9346 }),
    run("9dbb1dcdda74dc04debbf8ff6d2292e5ad597445", 53038, "failed", 1790965351000, 1790966967000, { cause: "Local CI failed at tests", headPr: 9360 }),
    run("9dbb1dcdda74dc04debbf8ff6d2292e5ad597445", 56366, "released", 1790967661000, 1790979918000, { headPr: 9360, deployedAt: 1790979918000 }),
    run("23a9f93c544a5e8c1c8035da781e926baeb2894a", 14500, "released", 1791032610000, 1791045263000, { headPr: 9366, deployedAt: 1791045263000 }),
    run(SF82D, 88474, "released", 1791053582000, 1791065907000, { headPr: 9367, deployedAt: 1791065907000 }),
    run(SF9E7, 76254, "released", 1791069412000, 1791071914000, { headPr: 9369, deployedAt: 1791071914000 }),
    run(S3C04, 83221, "running", 1791075557000, null, { headPr: 9370 }),
  ];
}

const session = (id: string, title: string, status: string, createdAt: number, lastActivityAt: number, extra: Partial<BoardSession> = {}): BoardSession =>
  ({ id, ownerBotId: CHIEF, ownerThreadId: CHIEF_DESK, title, status, surface: "cli", createdAt, lastActivityAt, ...extra });

export function boardSessions(): BoardSession[] {
  return [
    session("35787b0f-ff38-459e-b543-0dd921d068f4", "9052 Tempo de reabertura configurável", "running", 1790864769239, NOW - 6 * 60_000, {
      progressAt: NOW - 6 * 60_000,
      cwd: "/repo/.claude/worktrees/9052-tempo-de-reabertura-configuravel-35787b",
      delivery: { prs: { 9332: { number: 9332, state: "open", owned: "branch" } } },
    }),
    session("e47cf077-0000-4000-8000-000000000058", "9058 Chat entra com aviso no Widget", "idle", 1790884777154, 1790962596503, { progressAt: 1790962596503 }),
    session("c38a865a-0000-4000-8000-000000009334", "9334 9331 Inatividade do chat", "idle", 1790926614563, 1790967511365, {
      progressAt: 1790967511365,
      delivery: { prs: {
        9344: { number: 9344, state: "merged", owned: "branch", mergeSha: "3d98404b8cc8e4e55be6b795fb16e4159e971b43" },
        9345: { number: 9345, state: "merged", owned: "branch", mergeSha: "aa74c6345005427981e659874200dff5646a832d" },
        9348: { number: 9348, state: "merged", owned: "branch", mergeSha: "9720b32e0c3179eafd7c0a31ae88b488528e7557" },
      } },
    }),
    session("0fa889be-ff38-459e-b543-0dd921d06195", "9195 Rodízio de equipe atômico PR 9280", "idle", 1791033960437, 1791075453800, {
      progressAt: 1791075453800,
      delivery: { prs: { 9280: { number: 9280, state: "merged", owned: "branch", mergeSha: "432bbd027f2794ae95ea7e823e30403743f90a49" } } },
    }),
    session("9b50cdf7-0000-4000-8000-000000008204", "8204 Reprovado sidebar da fila não reflete no atendimento", "archived", 1790949274688, 1791072278577, {
      archivedAt: 1791072278577,
      delivery: { prs: { 9350: { number: 9350, state: "merged", owned: "branch", mergeSha: "ba034e1f30b43dd2abea695bb01082b69dc34c58" } } },
    }),
    // archived long ago: nothing on the board
    session("93001904-eda1-436f-9ba4-cd74849bb030", "9052 Tempo de reabertura configurável", "archived", 1790863894819, 1790864036683, { surface: "app", archivedAt: 1790864036683, desktop: { localId: "local_4b0ab114-df2d-4b90-9cc6-92cc9ad8a443", issue: "9052" } }),
  ];
}

export function boardOwnerPending(): BoardOwnerPending[] {
  return [
    { id: "o14", botId: MONITOR, threadId: "b5306bef-0000-4000-8000-000000000014", title: "Autorizar a linha nova da #9355 na planilha Atendimento (Sicrano, CSAT do N1 atribuído ao N2, ticket 142461)", link: "https://github.com/dinhogehm/nuria-platform/issues/9355", createdAt: 1790960959453 },
    { id: "o15", botId: MONITOR, threadId: "097e4cff-0000-4000-8000-000000000015", title: "Liberar os comentários de registro dos avisos na #9331 e na #9334", link: "https://github.com/dinhogehm/nuria-platform/issues/9334", createdAt: 1791029313380 },
  ];
}

export function boardInputs(extra: Partial<BoardInputs> = {}): BoardInputs {
  return {
    now: NOW,
    repo: "dinhogehm/nuria-platform",
    github: boardGithub(),
    live: boardLive(),
    runs: boardRuns(),
    logCoverage: { from: 1790900000000, to: NOW - 30_000 },
    sessions: boardSessions(),
    ownerPending: boardOwnerPending(),
    botNames: new Map([[CHIEF, "Chief of Staff"], [MONITOR, "Monitor Chat Atendimento"]]),
    releaseHold: "o release de produção 3c04d7c3d está em andamento",
    admission: { lease: { kind: "release", label: `release:production:${S3C04}` }, intents: [] },
    receipts: { "35787b0f-ff38-459e-b543-0dd921d068f4": { commit: LOCAL_9052, finishedAt: NOW - 20 * 60_000 } },
    ...extra,
  };
}
