import { describe, expect, it } from "vitest";
import { askCoveredByItem, echoAsk, ownerAskText, OWNER_PENDING_TITLE_MAX, ownerPendingRecommendNote, ownerPendingStepsAutoReport, parseOwnerPendingDetails, practicalMissing, RECOMMEND_MISSING } from "./bot-autonomy.ts";
import { availableTools, catalogProfileFromEnv } from "./drivers/agents-catalog.ts";
import { reusedFolderRefusal } from "./claude-desktop.ts";
import { APP_UNBLOCK_DECLINE_LABEL, APP_UNBLOCK_DECLINE_MS, appUnblockPending } from "./owner-chips.ts";
import { powerPendingDetails } from "./power.ts";
import { releaseLoopPending, tagAdvancePending } from "./release-watch.ts";

// R10-visual N12, the five conversation lines of "Precisa de você" on 02/10
// (GET /api/bots, goalNeedsInputAsk), redacted: the owner is "Renata", the
// client is "a cliente". Four only echo the panel or another item, or say
// nothing; the fifth is a real ask.
const BOTS = ["Chief of Staff", "Monitor Chat Atendimento", "Delivery PRODEV"];
const OPEN_IDS = ["o1", "o2", "o3", "o4", "o6", "o8", "o14", "o15", "o16"];
const ECHOES = [
  "Preciso de você",
  "O pedido continua na sua lista 'Precisa de você' (o15).",
  "O Monitor abriu a pendência o6 em 'Precisa de você'.",
  "Precisa de você: o Chief deixou no seu 'Precisa de você' um pedido sobre duas issues da cliente:",
];
const REAL = "Renata, a sessão da #9058 está pronta para o gate, mas o timeout do pre-push depende de uma decisão sua: 10 min ou sem limite?";

describe("the lines of \"Precisa de você\" that say nothing of their own", () => {
  it("drops the four echoes of 02/10 and keeps the real ask: 5 lines become 1", () => {
    for (const ask of ECHOES) expect(echoAsk(ownerAskText(ask, 200, BOTS), OPEN_IDS), ask).toBe(true);
    expect(echoAsk(ownerAskText(REAL, 200, BOTS), OPEN_IDS)).toBe(false);
    expect([...ECHOES, REAL].filter((ask) => !echoAsk(ownerAskText(ask, 200, BOTS), OPEN_IDS))).toEqual([REAL]);
  });

  // INSP-J r1 #4: short real questions and questions naming an item were hidden
  it("a question is never an echo, short or naming an item; it carries the sentence before it", () => {
    for (const ask of [
      "Osvaldo, a #9350 passou no gate e o QA aprovou. Mesclo?",
      "Confirma?",
      "Quer que eu responda à cliente agora (o4)?",
      "Preciso de você para decidir a pendência o3: pausar chats durante o aviso, sim ou não?",
      "Posso fechar o o14 e liberar o gate da #9348?",
    ]) expect(echoAsk(ownerAskText(ask, 200, BOTS), OPEN_IDS), ask).toBe(false);
    expect(ownerAskText("Osvaldo, a #9350 passou no gate e o QA aprovou. Mesclo?", 200, BOTS)).toBe("A #9350 passou no gate e o QA aprovou. Mesclo?");
    expect(ownerAskText("Confirma?", 200, BOTS)).toBe("Confirma?");
    // a long question needs nothing before it
    expect(ownerAskText("Fiz o deploy. Aviso os clientes da #9334 agora?", 200, BOTS)).toBe("Aviso os clientes da #9334 agora?");
  });

  it("an item id counts only when it is an open item's; a real ask naming the panel in passing is no echo", () => {
    expect(echoAsk("Deixei para você o o14, com o comando.", OPEN_IDS)).toBe(true);
    expect(echoAsk("Posso liberar o gate da #9348 agora?", OPEN_IDS)).toBe(false);
    expect(echoAsk("Aprovo o deploy do helpdesk hoje às 18h?", [])).toBe(false);
    expect(echoAsk("Renata, preciso de você.", [])).toBe(true);
    expect(echoAsk("", [])).toBe(true);
  });

  // INSP-J r1 #3: the owner's channel (52417e4a) always holds a server item
  // (o8, unblock the app); any line there was hidden, new questions too
  it("a conversation holding an unrelated item still shows its new question; the bot's item for that very ask covers it", () => {
    const at = Date.parse("2026-10-02T15:10:00Z");
    const o8 = { id: "o8", threadId: "52417e4a", createdAt: Date.parse("2026-10-01T23:10:00Z"), key: "app-reused-folder:nuria-platform" };
    const mesclo = { text: ownerAskText("Osvaldo, a #9350 passou no gate e o QA aprovou. Mesclo?", 400, BOTS), at };
    expect(askCoveredByItem(mesclo, [o8], "52417e4a")).toBe(false);
    // even a server item opened right now is not that question
    expect(askCoveredByItem(mesclo, [{ ...o8, id: "o17", key: "power:battery", createdAt: at }], "52417e4a")).toBe(false);
    // the bot opened an item with its question, in the same turn: one row
    expect(askCoveredByItem(mesclo, [o8, { id: "o18", threadId: "52417e4a", createdAt: at - 20_000 }], "52417e4a")).toBe(true);
    // an old item of the bot, about something else, does not
    expect(askCoveredByItem(mesclo, [{ id: "o3", threadId: "52417e4a", createdAt: at - 20 * 3_600_000 }], "52417e4a")).toBe(false);
    // an echo is covered whatever the conversation holds
    expect(askCoveredByItem({ text: ownerAskText(ECHOES[1]!, 400, BOTS), at }, [], "dbb9f1cf")).toBe(true);
  });

  it("the vocative is who, not what: the title starts at the ask", () => {
    expect(ownerAskText(REAL, 200, BOTS)).toBe("A sessão da #9058 está pronta para o gate, mas o timeout do pre-push depende de uma decisão sua: 10 min ou sem limite?");
    // a sentence that only starts with a capital word and a comma is not a vocative
    expect(ownerAskText("Pronto, posso seguir com o carrier?", 200, BOTS)).toBe("Pronto, posso seguir com o carrier?");
  });
});

// J17 (the owner, 02/10): the steps come with the item, never on request
describe("an item is born with why and steps", () => {
  it("is refused without them, saying exactly what is missing", () => {
    expect(practicalMissing({})).toContain("owner_pending recusado: falta why e steps.");
    expect(practicalMissing({ why: "O release depende disso." })).toContain("falta steps.");
    expect(practicalMissing({ why: "  ", steps: [{ text: "x" }] })).toContain("falta why.");
    expect(practicalMissing({ why: "x", steps: [] })).toContain("falta steps.");
    expect(practicalMissing({ why: "x", steps: [{ text: "x" }] })).toBeNull();
    expect(practicalMissing({})).toContain("o comando exato em command ou o link em link");
    const tool = availableTools(catalogProfileFromEnv({})).find((each) => each.name === "owner_pending")!;
    expect(tool.description).toContain("ALWAYS why and steps");
  });

  it("every item the server creates has them", () => {
    const FULL = "d5bb1f70bea397bdd937d02148c685e406985ba0";
    for (const item of [appUnblockPending("nuria-platform"), releaseLoopPending({ short: "d5bb1f70b", full: FULL, count: 4 }), powerPendingDetails(false), tagAdvancePending(FULL, null), tagAdvancePending(FULL, "git tag -f x")]) {
      expect(practicalMissing(item)).toBeNull();
    }
    // the server's own request for an older item's steps: a report, never the person's words
    expect(ownerPendingStepsAutoReport({ id: "o9", title: "Planilha linha 169" })).toMatch(/^\[Servidor: pendência sem passo a passo\] O item o9 .*owner_pending update, id o9.*Não escreva ao dono só por isto\.$/);
  });
});

// J16 (the owner, 02/10): four decisions and nothing said which was best
describe("the recommended decision", () => {
  const four = [
    { label: "Sem limite + esperar", reply: "Sem limite; espere o gate." },
    { label: "Sem limite + update-branch", reply: "Sem limite; atualize a branch.", recommended: true, why: "Destrava o gate hoje." },
    { label: "Sem limite + timeout maior", reply: "Sem limite; aumente o timeout." },
    { label: "Outro prazo padrão", reply: "Use outro prazo padrão." },
  ];

  it("is at most one, always with why; a missing one is said to the bot", () => {
    const ok = parseOwnerPendingDetails({ options: four });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.ok && ok.options?.[1]).toEqual({ label: "Sem limite + update-branch", reply: "Sem limite; atualize a branch.", recommended: true, why: "Destrava o gate hoje." });
    expect(ok.ok && ok.options?.[0]).toEqual({ label: "Sem limite + esperar", reply: "Sem limite; espere o gate." });
    expect(parseOwnerPendingDetails({ options: four.map((each) => ({ ...each, recommended: true, why: "x" })) })).toEqual({ ok: false, error: "no máximo UMA opção recomendada: marque recommended só na melhor" });
    expect(parseOwnerPendingDetails({ options: [{ label: "A", reply: "a", recommended: true }, { label: "B", reply: "b" }] })).toMatchObject({ ok: false, error: expect.stringContaining("precisa de why") });
    // the tool asks for it
    const tool = availableTools(catalogProfileFromEnv({})).find((each) => each.name === "owner_pending")!;
    expect(tool.description).toContain("ALWAYS mark the one you recommend");
    expect(RECOMMEND_MISSING).toContain("recommended: true e why");
    expect(ownerPendingRecommendNote({ id: "o9" })).toContain("recommended: true em UMA delas");
  });

  it("the server's own items are born with it", () => {
    const FULL = "d5bb1f70bea397bdd937d02148c685e406985ba0";
    for (const item of [appUnblockPending("nuria-platform"), releaseLoopPending({ short: "d5bb1f70b", full: FULL, count: 4 }), powerPendingDetails(false), tagAdvancePending(FULL, null)]) {
      const picks = item.options.filter((option) => option.recommended);
      expect(picks).toHaveLength(1);
      expect(picks[0]!.why!.length).toBeGreaterThan(20);
      expect(parseOwnerPendingDetails({ options: item.options })).toMatchObject({ ok: true });
    }
  });
});

// R10-visual N13: 11 of 12 items had no why, steps nor options — even the
// server's own o8. Each item the server creates is born practical.
describe("the items the server creates come with why, steps and options", () => {
  const FULL = "d5bb1f70bea397bdd937d02148c685e406985ba0";
  const practical = (item: { title: string; why?: string; steps?: Array<{ text: string; command?: string }>; options?: Array<{ label: string; reply: string }> }) => {
    expect(item.title.length).toBeLessThanOrEqual(OWNER_PENDING_TITLE_MAX);
    expect(item.why?.length ?? 0).toBeGreaterThan(40);
    expect(item.why!.length).toBeLessThanOrEqual(400);
    expect(item.steps?.length ?? 0).toBeGreaterThanOrEqual(2);
    for (const option of item.options ?? []) expect(option.label.length).toBeLessThanOrEqual(40);
    expect(`${item.title} ${item.why} ${item.steps!.map((step) => step.text).join(" ")}`).not.toMatch(/\b(?:the|and|click|open|run)\b/i);
  };

  it("unblock the app (askOwnerToUnblockApp)", () => {
    const item = appUnblockPending("nuria-platform");
    practical(item);
    expect(item.steps.map((step) => step.text).join("\n")).toContain("raiz do repositório nuria-platform");
    expect(item.options.map((option) => option.label)).toEqual(["Feito, conferir", APP_UNBLOCK_DECLINE_LABEL]);
    // INSP-J r1 #8: the same gesture as the 409 the bot reads — root, worktree OFF, File → New session
    const steps = item.steps.map((step) => step.text).join("\n");
    expect(steps).toContain("menu Arquivo, escolha Nova sessão");
    expect(steps).toContain("deixe a worktree DESLIGADA");
    const refusal = reusedFolderRefusal({ folder: "/r/.claude/worktrees/atendimento-reaberto-bugs-496989", earlier: ["a", "b"] }, "nuria-platform");
    expect(refusal).toContain("com a worktree DESLIGADA");
    expect(refusal).not.toContain("worktree ligada");
    expect(item.title).toContain("com a worktree desligada");
    // the decline promises only what the server keeps (24 h, owner-declines.json)
    expect(item.options[1]!.reply).toContain("nas próximas 24 h");
    expect(APP_UNBLOCK_DECLINE_MS).toBe(24 * 3_600_000);
  });

  it("a release in a loop, the stuck tag, the battery", () => {
    practical(releaseLoopPending({ short: "d5bb1f70b", full: FULL, count: 10, cycleMs: 50 * 60_000 }));
    const manual = `git tag -f nuria-production-deployed ${FULL} && git push --force-with-lease origin nuria-production-deployed`;
    const tag = tagAdvancePending(FULL, manual);
    practical(tag);
    expect(tag).toMatchObject({ key: `tag-advance:${FULL}`, command: manual });
    expect(tag.steps[0]).toMatchObject({ command: manual });
    // the title says where the command is (INSP-J r1 #11)
    expect(tag.title).toContain("comando no passo 1");
    expect(tagAdvancePending(FULL, null).title).toContain("comando no log do servidor");
    // without the printed advance: no command invented, the log is named
    const blind = tagAdvancePending(FULL, null);
    expect(blind.command).toBeUndefined();
    expect(blind.steps[0]!.text).toContain("log do servidor");
    const power = powerPendingDetails(true);
    practical({ title: "Ligue o Mac na tomada (12%, abaixo do seu limite de 20%) — release em curso", ...power });
    expect(power.why).toContain("o release de produção que está em curso");
    expect(power.why).toContain("O watcher automático de produção não olha a bateria");
  });
});
