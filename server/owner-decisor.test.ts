// The Decisor (server/owner-decisor.ts): the policy, the plan for each kind of
// item the panel held on 19/10 (their real wording), the pass, and the answer
// going through the panel's own reply route in-process.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AnswerDedupe } from "./answer-dedupe.ts";
import { BotAutonomy, OWNER_PENDING_AWAIT_MS, type OwnerPending } from "./bot-autonomy.ts";
import {
  chooseOption, claimsOwnerAction, createDecisor, createPolicyReader, DECISOR_LINE, DECISOR_NOTE_PREFIX, DEFAULT_DECISOR_POLICY, hardStopHit, invokeRoute,
  parseDecisorPolicy, physicalItem, planDecision, type DecisorDeps, type DecisorPolicy, type PlanContext,
} from "./owner-decisor.ts";
import { createOwnerPendingRoutes, type OwnerPendingRouteDeps } from "./routes/owner-pending.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-19T10:00:00-03:00");
const NOW = T0 + 60 * MIN;
const policy = (patch: Partial<DecisorPolicy> = {}): DecisorPolicy => ({ ...DEFAULT_DECISOR_POLICY, ...patch });
const ctx = (patch: Partial<PlanContext> = {}): PlanContext => ({ policy: policy(), now: NOW, threadExists: true, closedKeyRecently: false, ...patch });
const base = (patch: Partial<OwnerPending>): OwnerPending => ({ id: "o1", botId: "chief", threadId: "t1", title: "Item", createdAt: T0, ...patch });

// ── the items of 19/10, as their bots and the server wrote them ──────────
const triage = (issue: string, what: string) => base({
  id: `o${issue}`,
  title: `Liberar a #${issue} para triagem ou retirar da fila`,
  why: `A #${issue} permanece aberta como P1, além da meta de 4 h, e sem label esteira. A regra anti-trava exige decisão explícita para esta entrada; prioridade não autoriza implementação de segurança.`,
  steps: [
    { text: `Conferir a demanda: ${what}` },
    { text: "Escolher liberar a triagem e o código na esteira ou retirar da fila autônoma. A liberação não autoriza reparo de dados, operação destrutiva, relaxamento de segurança nem bypass de gate; escopos que exigirem autorização própria voltarão para decisão." },
  ],
  options: [
    { label: "Liberar triagem na esteira", reply: `Liberar #${issue}: aplicar label esteira e fazer triagem; código somente no escopo autorizado, sem reparo de dados ou mudança de segurança sem decisão específica.`, recommended: true },
    { label: "Retirar da fila autônoma", reply: `Retirar #${issue} da fila autônoma; manter a issue aberta e sem implementação até nova decisão.` },
  ],
});
const ITEMS = {
  o258: triage("9427", "Atendimento: macro nova não aparece depois de salvar (nem no cadastro nem na listagem)."),
  o260: triage("8834", "Security: triage 6 high dependency findings from release audit."),
  o261: triage("8785", "knowledge: cron cleanupStaleGenerations amplifica falhas do db-gateway e faz full scan por workspace a cada 10min."),
  o64: base({
    id: "o64", botId: "lead",
    title: "Identificar a origem das demandas #9628 e #9639",
    why: "O anúncio da correção de durações já foi enviado, mas os registros não identificam solicitantes nem conversas de origem. Sem esse vínculo, os avisos individuais ficam pendentes para evitar notificar a pessoa errada.",
    steps: [{ text: "Confira a origem dos relatos nas duas issues ou com o Chief de Staff; a autoria no GitHub, sozinha, não identifica quem solicitou no Chat." }],
    options: [
      { label: "Chief recupera a origem", reply: "Encaminhe a identificação dos solicitantes e conversas das #9628/#9639 ao Chief de Staff na coordenação existente; mantenha os avisos individuais pendentes até o retorno.", recommended: true },
      { label: "São achados internos", reply: "As #9628 e #9639 são achados internos sem solicitante no Chat; registre a dispensa dos avisos individuais por esse motivo." },
      { label: "Vou informar os vínculos", reply: "Vou informar os nomes dos solicitantes e os links das conversas de origem das #9628 e #9639." },
    ],
  }),
  o270: base({
    id: "o270", key: "disk-decision:9453-avaliar,9566-revisar|limpas:9453-avaliar,9566-revisar",
    title: "Decidir o destino de 2 worktrees paradas (~0 MB): 9453-avaliar, 9566-revisar",
    steps: [{ text: "Antes de remover qualquer uma, reconfira que nenhuma tem sessão, processo vivo dentro ou mudança nas últimas 24 h." }],
    options: [
      { label: "Remover as limpas", reply: "Remova as worktrees 9453-avaliar 9566-revisar com git worktree remove, sem --force. Antes de remover qualquer uma, reconfira que nenhuma tem sessão." },
      { label: "Manter por 7 dias", reply: "Mantenha as worktrees 9453-avaliar 9566-revisar e não as remova. Elas só voltam a ser perguntadas daqui a 7 dias, se ainda estiverem no disco." },
    ],
  }),
  o272: base({
    id: "o272", key: "cc-archive:56700d2a",
    title: "Arquivar à mão a sessão \"Filtro Todos não limpa no Atendimento\" no app Claude",
    steps: [{ text: "No app Claude, abra a sessão." }, { text: "Arquive-a pelo menu da sessão." }],
  }),
  o246: base({
    id: "o246",
    title: "Concluir a retirada manual do job que relança o CI da #9670",
    steps: [
      { text: "Osvaldo executa a retirada manual exclusivamente do job com.nuria.codex.pr9670.full04.20261018T1551, conforme informou; esta resposta não autoriza o bot a alterar o serviço." },
      { text: "Após o aviso, Chief confere por leitura o serviço, processos e leases.", command: "launchctl print gui/501/com.nuria.codex.pr9670.full04.20261018T1551" },
    ],
    history: [{ at: T0 + 5 * MIN, kind: "option", label: "Vou retirar este job no Mac", text: "Vou retirar", by: "owner", delivered: true }],
    updatedAt: T0 + 10 * MIN,
  }),
  o252: base({
    id: "o252",
    title: "Restabelecer o Local VM dos bots afetados",
    steps: [
      { text: "No OpenMausBot, abrir App Settings → Computers e conferir a configuração/imagem do Local VM usada pelos bots afetados, incluindo Lead PRODEV, QA Produção/QA PRODEV, Monitor Chat Atendimento e Redator KB Nuria." },
      { text: "Depois de restabelecer, informar nesta pendência. A retomada continua apenas código/testes/PR; importação real segue sem autorização nesta rodada." },
    ],
  }),
  o273: base({
    id: "o273",
    title: "Indicar amostras de teste e delimitar a autorização do QA em produção",
    steps: [
      { text: "Informar tenant/workspace e registros de teste sem dados clínicos para cada cenário disponível." },
      { text: "Para os testes com escrita, explicitar por issue os registros e operações permitidos, como selecionar/limpar/restaurar catálogo ou testar destino." },
    ],
  }),
};

describe("the policy file", () => {
  it("fills what the owner left out with the lenient defaults", () => {
    const parsed = parseDecisorPolicy({});
    expect(parsed).toEqual({ policy: DEFAULT_DECISOR_POLICY });
  });

  it("is off with enabled false, and tightens with extraHardStops appended to the defaults", () => {
    const parsed = parseDecisorPolicy({ enabled: false, mode: "dry-run", extraHardStops: [{ id: "deploy", label: "deploy", anyOf: ["\\bdeploy"] }] });
    if (!("policy" in parsed)) throw new Error(parsed.error);
    expect(parsed.policy.enabled).toBe(false);
    expect(parsed.policy.mode).toBe("dry-run");
    expect(parsed.policy.hardStops.at(-1)?.id).toBe("deploy");
    expect(parsed.policy.hardStops.length).toBe(DEFAULT_DECISOR_POLICY.hardStops.length + 1);
  });

  it("fails closed on a pattern that is not a regex, an unknown shape or broken JSON", () => {
    expect(parseDecisorPolicy({ hardStops: [{ anyOf: ["(unclosed"] }] })).toHaveProperty("error");
    expect(parseDecisorPolicy({ hardStops: [{ id: "x" }] })).toHaveProperty("error");
    expect(parseDecisorPolicy([])).toHaveProperty("error");
    const dir = mkdtempSync(join(tmpdir(), "decisor-policy-"));
    const path = join(dir, "decisor-policy.json");
    const read = createPolicyReader(path);
    expect(read()).toBeNull();
    writeFileSync(path, "{ not json");
    expect(read()).toHaveProperty("error");
    writeFileSync(path, JSON.stringify({ mode: "dry-run", graceMinutes: 1 }));
    expect(read()).toMatchObject({ policy: { mode: "dry-run", graceMinutes: 1 } });
  });
});

describe("the hard stops", () => {
  const stops = DEFAULT_DECISOR_POLICY.hardStops;
  it.each([
    ["Apagar os registros antigos do banco de dados de produção", "dados-producao"],
    ["Rodar DELETE FROM atendimentos where tenant = 3", "dados-sql-destrutivo"],
    ["Comprar o plano pago da Vercel por R$ 200", "dinheiro"],
    ["Responder ao cliente por e-mail com o novo prazo", "mensagem-externa"],
    ["Colar o token de acesso do GitHub nesta conversa", "credenciais"],
    ["Desativar o hook de revisão para destravar o push", "seguranca"],
    ["git commit --no-verify", "seguranca"],
  ])("%s → %s", (text, id) => {
    expect(hardStopHit(text, stops)?.id).toBe(id);
  });

  it.each([
    "Liberar #9427: aplicar label esteira e fazer triagem; código somente no escopo autorizado, sem reparo de dados ou mudança de segurança sem decisão específica.",
    "Encaminhe a identificação dos solicitantes e conversas das #9628/#9639 ao Chief de Staff na coordenação existente; mantenha os avisos individuais pendentes até o retorno.",
    "Security: triage 6 high dependency findings from release audit.",
    "Mantenha as worktrees 9453 e 9566 e não as remova.",
  ])("lets through: %s", (text) => {
    expect(hardStopHit(text, stops)).toBeNull();
  });
});

describe("the plan for the items of 19/10", () => {
  it("the four triage items and the origin one: the RECOMENDADA, \"Só você\" or not", () => {
    for (const item of [ITEMS.o258, ITEMS.o260, ITEMS.o261, ITEMS.o64]) {
      expect(planDecision(item, ctx())).toMatchObject({ action: "option", index: 0, label: item.options![0]!.label });
    }
  });

  it("the disk item with no recommendation: the conservative one (keep), never the removal", () => {
    expect(planDecision(ITEMS.o270, ctx())).toMatchObject({ action: "option", index: 1, label: "Manter por 7 dias" });
    expect(planDecision(ITEMS.o270, ctx({ policy: policy({ noRecommended: "first" }) }))).toMatchObject({ action: "option", index: 0 });
    expect(planDecision(ITEMS.o270, ctx({ policy: policy({ noRecommended: "keep" }) }))).toMatchObject({ action: "keep" });
  });

  it("archive by hand in the Claude app: closed with a note, kept once the server opens it again", () => {
    expect(physicalItem(ITEMS.o272)).toBe("server");
    const plan = planDecision(ITEMS.o272, ctx());
    expect(plan).toMatchObject({ action: "resolve" });
    expect(plan.action === "resolve" && plan.note.startsWith(DECISOR_NOTE_PREFIX)).toBe(true);
    expect(planDecision(ITEMS.o272, ctx({ closedKeyRecently: true }))).toMatchObject({ action: "keep" });
    expect(planDecision(ITEMS.o272, ctx({ policy: policy({ physical: "keep" }) }))).toMatchObject({ action: "keep" });
  });

  it("a bot's item that needs the owner's hands: handed back to its bot once, then closed with a note", () => {
    for (const item of [ITEMS.o246, ITEMS.o252]) {
      expect(physicalItem(item)).toBe("bot");
      expect(planDecision(item, ctx())).toMatchObject({ action: "text" });
      const answered: OwnerPending = { ...item, history: [...(item.history ?? []), { at: NOW - 5 * MIN, kind: "text", text: "x", by: "owner", delivered: true, decisor: true }], updatedAt: NOW - 4 * MIN };
      expect(planDecision(answered, ctx())).toMatchObject({ action: "resolve" });
    }
  });

  it("production QA with writes stays with the owner", () => {
    expect(planDecision(ITEMS.o273, ctx())).toMatchObject({ action: "keep", why: expect.stringContaining("produção") });
  });

  it("the go-ahead text names what still needs the owner", () => {
    const plan = planDecision(ITEMS.o252, ctx());
    expect(plan.action === "text" && plan.text).toContain("gastar dinheiro de verdade");
  });
});

describe("when the Decisor waits, and when it stops", () => {
  const item = ITEMS.o258;
  it("waits for a new or just rewritten item, a delegation, a queued answer, a bot still answering", () => {
    expect(planDecision({ ...item, createdAt: NOW - MIN }, ctx())).toMatchObject({ action: "wait" });
    expect(planDecision({ ...item, updatedAt: NOW - MIN }, ctx())).toMatchObject({ action: "wait" });
    expect(planDecision({ ...item, delegation: { at: NOW - MIN, state: "running" } }, ctx())).toMatchObject({ action: "wait" });
    expect(planDecision({ ...item, history: [{ at: NOW - 10 * MIN, kind: "option", label: "x", text: "x", by: "owner", delivered: false, queued: true }] }, ctx())).toMatchObject({ action: "wait" });
    expect(planDecision({ ...item, awaitingSince: NOW - 10 * MIN }, ctx())).toMatchObject({ action: "wait" });
    expect(planDecision({ ...item, recommendRequestedAt: NOW - 10 * MIN }, ctx())).toMatchObject({ action: "wait" });
  });

  it("never decides the same version twice: its bot's silence closes it (stale), or leaves it", () => {
    const decided: OwnerPending = { ...item, history: [{ at: T0 + 5 * MIN, kind: "option", label: "Liberar triagem na esteira", text: "x", by: "owner", delivered: true, decisor: true }], awaitingSince: NOW - OWNER_PENDING_AWAIT_MS - MIN };
    expect(planDecision(decided, ctx())).toMatchObject({ action: "resolve" });
    expect(planDecision(decided, ctx({ policy: policy({ stale: "keep" }) }))).toMatchObject({ action: "keep" });
    // rewritten by its bot since: a new version, decided again — up to maxDecisionsPerItem
    expect(planDecision({ ...decided, awaitingSince: undefined, updatedAt: T0 + 20 * MIN }, ctx())).toMatchObject({ action: "option" });
    expect(planDecision({ ...decided, awaitingSince: undefined, updatedAt: T0 + 20 * MIN }, ctx({ policy: policy({ maxDecisionsPerItem: 1 }) }))).toMatchObject({ action: "keep" });
  });

  it("a recommended decision that is a hard stop is the owner's: never swapped for another option", () => {
    const risky = { ...item, options: [{ label: "Pagar", reply: "Pague a fatura de US$ 40 do Fly.io.", recommended: true as const }, { label: "Esperar", reply: "Espere." }] };
    expect(chooseOption(risky, DEFAULT_DECISOR_POLICY)).toMatchObject({ keep: expect.stringContaining("dinheiro") });
  });

  it("skips the bots the owner listed, and closes items whose conversation is gone", () => {
    expect(planDecision(item, ctx({ policy: policy({ skipBots: ["chief"] }) }))).toMatchObject({ action: "keep" });
    expect(planDecision(item, ctx({ threadExists: false }))).toMatchObject({ action: "resolve" });
  });
});

describe("the pass", () => {
  function harness(patch: Partial<DecisorDeps> = {}, pol: Partial<DecisorPolicy> = {}) {
    const items = [ITEMS.o258, ITEMS.o260, ITEMS.o261, ITEMS.o64, ITEMS.o272, ITEMS.o273];
    const deps: DecisorDeps = {
      readPolicy: () => ({ policy: policy({ maxPerTick: 10, ...pol }) }),
      openItems: () => items,
      resolvedItems: () => [],
      threadExists: () => true,
      botName: (id) => id,
      stopped: () => false,
      reply: vi.fn(async () => ({ status: 202, body: { ok: true } })),
      resolve: vi.fn(),
      log: vi.fn(),
      audit: vi.fn(),
      now: () => NOW,
      ...patch,
    };
    return { deps, decisor: createDecisor(deps) };
  }

  it("decides through the reply route, closes the physical one and says once what stays", async () => {
    const { deps, decisor } = harness();
    const done = await decisor.tick();
    expect(deps.reply).toHaveBeenCalledWith("chief", "o9427", { option: 0, label: "Liberar triagem na esteira" });
    expect(deps.reply).toHaveBeenCalledTimes(4);
    expect(deps.resolve).toHaveBeenCalledWith(ITEMS.o272, expect.stringContaining(DECISOR_NOTE_PREFIX));
    expect(done.find((entry) => entry.item === "o273")).toMatchObject({ action: "keep" });
    expect(deps.audit).toHaveBeenCalledTimes(6);
    // the kept one is not said again on the next pass
    (deps.audit as ReturnType<typeof vi.fn>).mockClear();
    await decisor.tick();
    expect((deps.audit as ReturnType<typeof vi.fn>).mock.calls.filter(([entry]) => entry.item === "o273")).toHaveLength(0);
  });

  it("reads the resolved history once per pass and still holds a key the proxy closed recently", async () => {
    const resolvedItems = vi.fn(() => [
      { ...ITEMS.o272, resolvedAt: NOW - 60_000, resolvedNote: `${DECISOR_NOTE_PREFIX} closed` },
      ...Array.from({ length: 500 }, (_, i) => ({ ...ITEMS.o64, id: `old-${i}`, key: `old-${i}`, resolvedAt: NOW - 60_000, resolvedNote: "by hand" })),
    ]) as unknown as DecisorDeps["resolvedItems"];
    const { deps, decisor } = harness({ resolvedItems });
    const done = await decisor.tick();
    expect(resolvedItems).toHaveBeenCalledTimes(1);
    expect(done.find((entry) => entry.item === "o272")).toMatchObject({ action: "keep" });
    expect(deps.resolve).not.toHaveBeenCalledWith(ITEMS.o272, expect.anything());
  });

  it("dry-run sends nothing and logs each plan once", async () => {
    const { deps, decisor } = harness({}, { mode: "dry-run" });
    await decisor.tick();
    await decisor.tick();
    expect(deps.reply).not.toHaveBeenCalled();
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledTimes(6);
  });

  it("does nothing with no policy file, a broken one, enabled false or ~/.nuria/stop", async () => {
    for (const patch of [{ readPolicy: () => null }, { readPolicy: () => ({ error: "bad" }) }, { stopped: () => true }] as Array<Partial<DecisorDeps>>) {
      const { deps, decisor } = harness(patch);
      await decisor.tick();
      expect(deps.reply).not.toHaveBeenCalled();
      expect(deps.resolve).not.toHaveBeenCalled();
    }
    const off = harness({}, { enabled: false });
    await off.decisor.tick();
    expect(off.deps.reply).not.toHaveBeenCalled();
  });

  it("at most maxPerTick per pass, and a refused answer is not retried at once", async () => {
    const { deps, decisor } = harness({ reply: vi.fn(async () => ({ status: 409, body: { error: "spend cap" } })) }, { maxPerTick: 2 });
    await decisor.tick();
    expect(deps.reply).toHaveBeenCalledTimes(2);
    await decisor.tick();
    // the two refused wait DECISOR_RETRY_MS; the next two items get their turn
    expect((deps.reply as ReturnType<typeof vi.fn>).mock.calls.map(([, id]) => id)).toEqual(["o9427", "o8834", "o8785", "o64"]);
  });
});

describe("through the panel's own reply route", () => {
  function routes() {
    const autonomy = new BotAutonomy({ path: null });
    const appended: Array<{ threadId: string; message: unknown }> = [];
    const direct: string[] = [];
    const bots = new Map([["chief", { id: "chief", name: "Chief of Staff" }]]);
    const deps = {
      store: {
        bot: (id: string) => bots.get(id) ?? null,
        taskByThread: (_botId: string, threadId: string) => ({ threadId, title: "Conversa" }),
        appendMessage: (threadId: string, message: unknown) => { appended.push({ threadId, message }); return message; },
      },
      autonomy, cfg: {}, dataDir: mkdtempSync(join(tmpdir(), "decisor-route-")), nuriaStopFile: join(tmpdir(), "no-such-stop-file"),
      appUnblockKey: "app-reused-folder:", questionStepsAskAgainMs: 60_000, answerDedupe: new AnswerDedupe(),
      ownerDeclines: { set() {} }, appFolderFlaps: { set() {} },
      cloudGuestSendRefusal: () => null, messageSender: () => undefined, usageTriggerFor: () => ({ kind: "owner" }),
      refreshBotRow() {}, ownerTurnThread: (_botId: string, from: string) => from, goalNeedsInputForThread: () => null,
      replaceQueuedChoice() {}, drainQueuedSends() {},
      startOrQueueDirectMessage: async (_botId: string, threadId: string, text: string) => { direct.push(text); return { ok: true, threadId, message: { id: "m1", role: "user", text, at: Date.now() } }; },
    } as unknown as OwnerPendingRouteDeps;
    return { autonomy, handler: createOwnerPendingRoutes(deps), appended, direct };
  }

  it("a bot's item: the option reaches the bot marked as the Decisor's, and the history says so", async () => {
    const { autonomy, handler } = routes();
    const item = autonomy.addOwnerPending("chief", "t1", { title: ITEMS.o258.title, steps: ITEMS.o258.steps, options: ITEMS.o258.options });
    const answer = await invokeRoute(handler, `/api/bots/chief/owner-pending/${item.id}/reply`, { option: 0, label: "Liberar triagem na esteira" });
    expect(answer.status).toBe(202);
    expect(String(answer.body.text)).toMatch(new RegExp(`^${DECISOR_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    const now = autonomy.ownerPendingById("chief", item.id)!;
    expect(now.history?.at(-1)).toMatchObject({ kind: "option", label: "Liberar triagem na esteira", decisor: true, queued: true });
    // the same click again is the dedupe's: taken once
    const again = await invokeRoute(handler, `/api/bots/chief/owner-pending/${item.id}/reply`, { option: 0, label: "Liberar triagem na esteira" });
    expect(again.body.duplicate).toBe(true);
  });

  it("a server item closes on the choice, with the Decisor's note in the audit", async () => {
    const { autonomy, handler, direct } = routes();
    const item = autonomy.addOwnerPending("chief", "t1", { title: "Release travado", key: "release-loop:x", options: [{ label: "Seguir", reply: "Pode seguir.", recommended: true }] });
    const answer = await invokeRoute(handler, `/api/bots/chief/owner-pending/${item.id}/reply`, { option: 0, label: "Seguir" });
    expect(answer.status).toBe(202);
    expect(direct[0]).toContain(DECISOR_LINE);
    expect(autonomy.ownerPendingById("chief", item.id)).toBeNull();
    expect(autonomy.resolvedOwnerPendingOf("chief").at(-1)).toMatchObject({ resolvedBy: "owner", resolvedNote: expect.stringContaining(DECISOR_NOTE_PREFIX) });
  });

  it("a request that is not the Decisor's (an ordinary click) is not marked", async () => {
    const { autonomy, handler } = routes();
    const item = autonomy.addOwnerPending("chief", "t1", { title: ITEMS.o258.title, options: ITEMS.o258.options });
    const { EventEmitter } = await import("node:events");
    let status = 0;
    let sent: Record<string, unknown> = {};
    const res = { headersSent: false, writableEnded: false, setHeader() {}, writeHead(code: number) { status = code; return res; }, end() { return res; } };
    await handler({
      req: Object.assign(new EventEmitter(), { headers: {} }) as never, res: res as never, url: new URL("http://x"), path: `/api/bots/chief/owner-pending/${item.id}/reply`, method: "POST",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json: ((r: typeof res, code: number, data: Record<string, unknown>) => { sent = data; r.writeHead(code); }) as never, readBody: (async () => ({ option: 0, label: "Liberar triagem na esteira" })) as never,
    });
    expect(status).toBe(202);
    expect(String(sent.text)).not.toContain(DECISOR_LINE);
    expect(autonomy.ownerPendingById("chief", item.id)!.history?.at(-1)?.decisor).toBeUndefined();
  });
});

// ── never a false "the owner did it" (20/10: o282, o281, o279, QA Produção o1/o2) ──
describe("the Decisor never claims an owner action", () => {
  const done = [{ label: "Já resolvi", reply: "Já resolvi essa pendência." }];
  const routineAsk = (id: string, title: string, said: string) => base({
    id, title, key: `routine-ask:${id}`,
    why: `O bot Chief of Staff, na rotina "Esteira 24/7", escreveu: "${said}" Última vez dita às 02:20.`,
    steps: [{ text: "Veja o contexto na conversa do bot Chief of Staff." }, { text: "Resolva o que o bot deixou com você." }, { text: 'Quando terminar, escolha "Já resolvi" ou diga aqui o que fez.' }],
    options: done,
  });

  it("o282: merge, SHA approval and swap go through the policy; a lone 'Já resolvi' gets the go-ahead text, never the claim", () => {
    const o282 = routineAsk("o282", "Ver: #9613/#9614 (aprovação do SHA e autorização de merge), #9676 (relaxamento do swap)…", "#9613/#9614 dependem da aprovação do SHA e da autorização de merge; #9676 do relaxamento do swap.");
    const plan = planDecision(o282, ctx());
    expect(plan).toMatchObject({ action: "text" });
    expect(JSON.stringify(plan)).not.toContain("Já resolvi");
    // with a real option beside the claim, the real one is picked
    const withChoice = { ...o282, options: [...done, { label: "Seguir sem merge", reply: "Siga sem merge por enquanto." }] };
    expect(planDecision(withChoice, ctx())).toMatchObject({ action: "option", label: "Seguir sem merge" });
  });

  it("o2 / o1 / o281: a routine 'Ver: …' item with only 'Já resolvi' gets a real decision (the go-ahead text), never the claim", () => {
    for (const item of [
      routineAsk("o2", "Ver: #9310", "A #9310 continua com você."),
      routineAsk("o1", "Ver: a #9310 permanece fora dessa autorização e", "a #9310 permanece fora dessa autorização e continua com você."),
      routineAsk("o281", "Por último, ele vai listar o próximo passo e o responsável de cada outra PR parada…", "Por último, ele vai listar o próximo passo e o responsável de cada outra PR parada."),
    ]) {
      const plan = planDecision(item, ctx());
      expect(plan.action, item.id).toBe("text");
      expect(JSON.stringify(plan), item.id).not.toContain("Já resolvi");
    }
    // a claim plus a postpone: the postpone, never the claim
    const postpone = { ...routineAsk("o2", "Ver: #9310", "A #9310 continua com você."), options: [...done, { label: "Deixar para depois", reply: "Deixe para depois." }] };
    expect(planDecision(postpone, ctx())).toMatchObject({ action: "option", label: "Deixar para depois" });
  });

  it("o279: a recommended 'Liberei' is never chosen; the real option is", () => {
    const o279 = base({
      id: "o279",
      title: "Liberar os comandos de leitura da rotina Esteira 24/7 (gh, ls, ps)",
      why: "Em duas passagens seguidas (23h05 e 23h20), meus comandos de leitura ficaram esperando uma aprovação que ninguém deu.",
      options: [
        { label: "Liberei", reply: "Liberei os comandos de leitura da rotina Esteira.", recommended: true },
        { label: "Manter assim", reply: "Mantenha assim; use o Delivery para as conferências." },
      ],
    });
    expect(planDecision(o279, ctx())).toMatchObject({ action: "option", index: 1, label: "Manter assim", why: expect.stringContaining("afirma algo que o dono fez") });
    expect(planDecision(o279, ctx({ policy: policy({ noRecommended: "keep" }) }))).toMatchObject({ action: "keep" });
    // only claims: answered like an item without options, never with the claim
    const lone = planDecision({ ...o279, options: [o279.options![0]!] }, ctx());
    expect(lone).toMatchObject({ action: "text" });
    expect(JSON.stringify(lone)).not.toContain("Liberei os comandos");
  });

  it("recognizes claims in any case or accent, and not real decisions", () => {
    for (const label of ["Já resolvi", "JA RESOLVI", "ja fiz", "Já fiz isso", "Liberei", "LIBEREI", "Feito", "feito!", "Concluí", "conclui", "Ajustei o hook", "Pronto", "Eu já conferi"]) {
      expect(claimsOwnerAction({ label, reply: "" }), label).toBe(true);
    }
    expect(claimsOwnerAction({ label: "Ok", reply: "Já fiz o ajuste." })).toBe(true);
    for (const label of ["Liberar triagem na esteira", "Manter assim", "Não limpar agora", "Pode limpar", "Retirar da fila autônoma", "Fechar a #9686", "Aprovar a recomendação consolidada", "Chief recupera a origem"]) {
      expect(claimsOwnerAction({ label, reply: "Siga." }), label).toBe(false);
    }
  });

  it("the items of 19/10 it decided right still go the same way", () => {
    expect(chooseOption(ITEMS.o258, DEFAULT_DECISOR_POLICY)).toMatchObject({ index: 0, why: "a recomendada pelo bot" });
  });
});
