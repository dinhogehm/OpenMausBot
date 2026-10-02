import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { channelOrderTarget, decisionOf, firstSentence, isOwnerChannelOrder, isOwnerOrder, lastChannelOrder, orderTopic, SHARED_STATE_MAX_BYTES, SharedState, threadByRef } from "./shared-state.ts";

describe("what a bot's conversations know about each other", () => {
  it("shows a fact from one conversation in the prompt of another, never in its own", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-shared-"));
    try {
      const state = new SharedState(dir);
      const at = Date.parse("2026-09-30T21:00:00Z");
      state.record("chief", { threadId: "t-esteira", title: "Esteira", at, decision: "Mergeei a #9313 pelo gate.", pending: "GO para o carrier da #9278?" }, [{ threadId: "t-esteira", at, text: "Não rode ci:local enquanto houver release." }]);
      const other = new SharedState(dir).render("chief", "t-main", at, ["Sessão \"#9311 labels\" (idle)"]);
      expect(other).toContain("Estado das suas outras conversas");
      expect(other).toContain("Mergeei a #9313 pelo gate.");
      expect(other).toContain("esperando o dono: GO para o carrier da #9278?");
      expect(other).toContain("Ordens do dono em vigor");
      expect(other).toContain("Não rode ci:local enquanto houver release.");
      expect(other).toContain("#9311 labels");
      const own = state.render("chief", "t-esteira", at);
      expect(own).not.toContain("Mergeei a #9313");
      expect(own).toContain("Não rode ci:local"); // orders hold in every conversation
      expect(readFileSync(join(dir, "chief", "shared-state.md"), "utf8")).toContain("Mergeei a #9313");
      expect(state.render("monitor", "x", at)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the block small and without repeats", () => {
    const state = new SharedState(null);
    for (let i = 0; i < 40; i++) state.record("b", { threadId: `t${i}`, title: `Conversa ${i}`, at: i, decision: "x".repeat(150) }, [{ threadId: `t${i}`, at: i, text: "Sempre avise o Chief." }]);
    const block = state.render("b", "none", 100);
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(SHARED_STATE_MAX_BYTES);
    expect(block.match(/Sempre avise o Chief/g)).toHaveLength(1);
  });

  it("leaves out the conversations, and their orders, that the caller does not include", () => {
    const state = new SharedState(null);
    state.record("b", { threadId: "mine", title: "Mine", at: 1, decision: "OWNER-SAID" }, [{ threadId: "mine", at: 1, text: "Sempre avise o Chief." }]);
    state.record("b", { threadId: "guest", title: "Guest's", at: 2, decision: "GUEST-SAID" }, [{ threadId: "guest", at: 2, text: "Nunca publique sem GO." }]);
    const block = state.render("b", "now", 3, [], (threadId) => threadId !== "guest");
    expect(block).toContain("OWNER-SAID");
    expect(block).toContain("Sempre avise o Chief.");
    expect(block).not.toMatch(/GUEST-SAID|Guest's|Nunca publique/);
    expect(state.render("b", "now", 3, [], () => false)).toBe("");
  });

  it("tells an order from an ordinary request", () => {
    expect(isOwnerOrder("Não rode o ci:local agora")).toBe(true);
    expect(isOwnerOrder("A partir de agora, publique só com GO")).toBe(true);
    expect(isOwnerOrder("PARAR")).toBe(true);
    expect(isOwnerOrder("Veja a PR 9300 por favor")).toBe(false);
    expect(firstSentence("**Feito.** Abri a PR #9401 e rodei o gate.")).toBe("Feito.");
  });
});

describe("one conversation with the owner, and the newest order wins", () => {
  it("knows the conversation the owner named, and tells the others to speak to them only there", () => {
    expect(isOwnerChannelOrder("Use só a conversa da esteira para falar comigo")).toBe(true);
    expect(isOwnerChannelOrder("fale comigo só por aqui")).toBe(true);
    expect(isOwnerChannelOrder("Use só o gate local")).toBe(false);
    const state = new SharedState(null);
    state.record("chief", { threadId: "esteira", title: "Esteira", at: 10 }, [{ threadId: "esteira", at: 10, text: "Use só a conversa da esteira para falar comigo." }]);
    expect(state.ownerThread("chief")).toMatchObject({ threadId: "esteira", title: "Esteira" });
    expect(state.render("chief", "main", 20)).toContain('Conversa com o dono: "Esteira"');
    expect(state.render("chief", "esteira", 20)).toContain("Esta é a conversa com o dono");
  });

  it("forgets the conversation with the owner when it is deleted, closed or archived (INSP-F F2-b)", () => {
    const named = () => {
      const state = new SharedState(null);
      state.record("chief", { threadId: "dbb9f1cf", title: "@Monitor", at: 10 }, [{ threadId: "dbb9f1cf", at: 10, text: "Use só a conversa da esteira para falar comigo." }]);
      state.record("chief", { threadId: "ade82a65", title: "New thread", at: 11 });
      return state;
    };
    const deleted = named();
    expect(deleted.forgetThread("chief", "ade82a65")).toBe(false);
    expect(deleted.ownerThread("chief")?.threadId).toBe("dbb9f1cf");
    expect(deleted.forgetThread("chief", "dbb9f1cf")).toBe(true);
    expect(deleted.ownerThread("chief")).toBeNull();
    expect(deleted.render("chief", "ade82a65", 20)).not.toContain("Conversa com o dono");
    const archived = named();
    expect(archived.forgetOwnerThread("chief", "dbb9f1cf")).toBe(true);
    expect(archived.ownerThread("chief")).toBeNull();
    expect(archived.forgetOwnerThread("chief", "dbb9f1cf")).toBe(false);
    // its record stays: only the deleted conversation's goes
    expect(archived.render("chief", "ade82a65", 20)).toContain('"@Monitor"');
  });

  it("replaces an older order on the same thing with the newer one, wherever each was given", () => {
    expect(orderTopic("Não mergeie a #9314 antes do lote")).toBe("#9314");
    const state = new SharedState(null);
    state.record("chief", { threadId: "a", title: "A", at: 1 }, [{ threadId: "a", at: 1, text: "Não mergeie a #9314 antes do lote." }]);
    state.record("chief", { threadId: "b", title: "B", at: 2 }, [{ threadId: "b", at: 2, text: "Pode mergear a #9314 agora, a partir de agora ela vai primeiro." }]);
    const block = state.render("chief", "c", 3);
    expect(block).toContain("a #9314 agora");
    expect(block).not.toContain("antes do lote");
    expect(block).toContain("vale a mais recente");
    // an older order arriving late does not undo a newer one
    state.record("chief", { threadId: "a", title: "A", at: 4 }, [{ threadId: "a", at: 1, text: "Não mergeie a #9314 antes do lote." }]);
    expect(state.render("chief", "c", 5)).not.toContain("antes do lote");
  });

  // The owner's order of 01/10 09:49 in dbb9f1cf, as pasted (names and the
  // work items redacted; the conversation ids are the real ones). The build
  // of 21:05 did not recognize it, and the Chief's desk fell to dd9c5ece,
  // where the owner had reported a bug at 19:53 (R9-followup #1).
  const DBB = "dbb9f1cf-5b8f-486d-9f6d-3167938cd65b";
  const ADE = "ade82a65-0000-4000-8000-000000000001";
  const OLD = "6477b3f4-0000-4000-8000-000000000002";
  const DD9 = "dd9c5ece-0000-4000-8000-000000000003";
  const ORDER_0949 = "<pasted-text index=\"1\">\nChief, a partir de agora esta conversa (dbb9f1cf) é o único canal comigo. Não fale comigo na 6477b3f4 nem na ade82a65; mova para cá os vigias main e prod. Faça hoje, nesta ordem, e me reporte aqui em uma linha por item:\n\n1. Ponha a #NNNN (correção do [cliente]) de volta na fila e acorde a sessão [id]. Ela ficou 14 h parada sem aviso.\n2. Corrija o que você me disse às 05:10 sobre o release [sha].\n</pasted-text>";
  const resolveAmong = (ids: string[]) => (ref: string) => ids.find((id) => id.startsWith(ref)) ?? null;

  it("recognizes the owner's real channel orders, not their other requests (R9-followup #1)", () => {
    for (const order of [
      ORDER_0949,
      "esta conversa é o canal único comigo",
      "A partir de agora o único canal comigo é esta conversa.",
      "Não fale comigo na ade82a65.",
      "não me escreva nas outras conversas",
      "fale comigo só aqui",
      "Fale comigo só nesta conversa.",
      "use só esta conversa",
      "fale comigo só na dbb9f1cf",
      "Use só a conversa da esteira para falar comigo",
      "fale comigo só por aqui",
    ]) expect(isOwnerChannelOrder(order), order).toBe(true);
    for (const request of [
      "Use só o gate local",
      "fale comigo só pelo Chat do Google quando publicar",
      "o único canal do cliente é a planilha",
      "não fale com o cliente na thread dele",
      "devo falar com você só aqui?",
      "Veja a conversa da Daiane e me diga o que falta",
      "Esta é a única conversa sobre o release, não abra outra.",
      "não use a conversa do Monitor para isso",
      "não mande o relatório na outra thread",
      // INSP-H r1 #2: requests and facts with no owner spoken to
      "Mande só o link da PR aqui.",
      "Responda só o número da issue aqui.",
      "Fique só aqui esperando o CI terminar.",
      "Use só a conversa do Monitor para os alertas do Chat.",
      "O WhatsApp é o único canal de atendimento do cliente aqui.",
      "Não me mande mais nada na thread do release, só quando terminar.",
      "Esse ticket é a única conversa com o cliente sobre isso, comigo não.",
      // INSP-H r2 #4: "só" with the object, and speech reported
      "Me mande só o resumo aqui.",
      "Me responda só com o número aqui.",
      "O Monitor disse: fale comigo só nesta conversa.",
      "Ele escreveu \"use só esta conversa\" no ticket.",
    ]) expect(isOwnerChannelOrder(request), request).toBe(false);
    // INSP-H r2 #4: the channel named another way
    const ids = ["dbb9f1cf-5b8f-486d-9f6d-3167938cd65b"];
    for (const order of ["Use a dbb9f1cf como canal comigo.", "Meu canal é a dbb9f1cf."]) {
      expect(isOwnerChannelOrder(order), order).toBe(true);
      expect(channelOrderTarget(order, "dd9c5ece", (ref) => ids.find((id) => id.startsWith(ref)) ?? null), order).toBe(ids[0]);
    }
    // INSP-H r1 #2: the owner spoken to, said other ways
    for (const order of ["Converse comigo só por aqui", "Só me procure nesta conversa.", "Daqui pra frente, quero falar com você apenas aqui."]) {
      expect(isOwnerChannelOrder(order), order).toBe(true);
      expect(channelOrderTarget(order, "here", () => null), order).toBe("here");
    }
    expect(isOwnerChannelOrder("A única conversa comigo é esta.")).toBe(true);
    expect(isOwnerChannelOrder("não me mande nada na outra conversa")).toBe(true);
  });

  it("makes the conversation the order names the owner's, wherever it was given", () => {
    const ids = [DBB, ADE, OLD, DD9];
    // given in dbb9f1cf, naming itself
    expect(channelOrderTarget(ORDER_0949, DBB, resolveAmong(ids))).toBe(DBB);
    // the same order pasted in another conversation still names dbb9f1cf
    expect(channelOrderTarget(ORDER_0949, DD9, resolveAmong(ids))).toBe(DBB);
    expect(channelOrderTarget("fale comigo só na dbb9f1cf", DD9, resolveAmong(ids))).toBe(DBB);
    // only forbidding others: the conversation it was given in
    expect(channelOrderTarget("Não fale comigo na 6477b3f4 nem na ade82a65.", DBB, resolveAmong(ids))).toBe(DBB);
    expect(channelOrderTarget("Fale comigo só aqui, não na ade82a65.", DD9, resolveAmong(ids))).toBe(DD9);
    // forbidding the very conversation it is given in names none
    expect(channelOrderTarget("não fale comigo na ade82a65", ADE, resolveAmong(ids))).toBeNull();
    // a conversation nobody knows is not guessed
    expect(channelOrderTarget("fale comigo só na abcdef12", DD9, resolveAmong(ids))).toBeNull();
    expect(channelOrderTarget("Veja a #9330", DD9, resolveAmong(ids))).toBeNull();
  });

  it("records the 09:49 order as the conversation with the owner, and its text without the paste marks", () => {
    const state = new SharedState(null);
    state.record("chief", { threadId: DD9, title: "Prioridade máxima", at: 5 });
    state.record("chief", { threadId: DBB, title: "@Monitor", at: 10 }, [{ threadId: DBB, at: 10, text: ORDER_0949 }]);
    expect(state.ownerThread("chief")).toMatchObject({ threadId: DBB, title: "@Monitor", at: 10 });
    const elsewhere = state.render("chief", DD9, 20);
    expect(elsewhere).toContain('Conversa com o dono: "@Monitor"');
    expect(elsewhere).toContain("é o único canal comigo");
    expect(elsewhere).not.toContain("pasted-text");
    // where the owner writes next (a one-off bug report) does not move it
    state.record("chief", { threadId: DD9, title: "Prioridade máxima", at: 30 }, [{ threadId: DD9, at: 30, text: "Nunca publique sem o gate verde." }]);
    expect(state.ownerThread("chief")?.threadId).toBe(DBB);
  });

  it("reads the newest channel order back at boot, and never revives an older one (R9-followup #1)", () => {
    const ids = [DBB, ADE, OLD, DD9];
    const history = [
      { threadId: ADE, at: 1, text: "fale comigo só aqui" },
      { threadId: DBB, at: 2, text: ORDER_0949 },
      { threadId: DD9, at: 3, text: "Prioridade máxima: destravar a esteira." },
    ];
    const found = lastChannelOrder(history, resolveAmong(ids));
    expect(found).toMatchObject({ target: DBB, order: { threadId: DBB, at: 2, channelThreadId: DBB } });
    // the newest names a conversation nobody knows: nothing, not the older ADE one
    expect(lastChannelOrder([...history, { threadId: DD9, at: 4, text: "fale comigo só na abcdef12" }], resolveAmong(ids))).toBeNull();
    expect(lastChannelOrder([{ threadId: DD9, at: 4, text: "Veja a #9330" }], resolveAmong(ids))).toBeNull();
    expect(threadByRef(ids, "dbb9f1cf")).toBe(DBB);
    expect(threadByRef([DBB, `${DBB.slice(0, 8)}-ffff`], "dbb9f1cf")).toBeNull();

    const state = new SharedState(null);
    expect(state.adoptChannelOrder("chief", found!.order, { threadId: DBB, title: "@Monitor" })).toBe(true);
    expect(state.ownerThread("chief")).toMatchObject({ threadId: DBB, at: 2 });
    expect(state.render("chief", DD9, 5)).toContain("Ordens do dono em vigor");
    // read back again: nothing changes
    expect(state.adoptChannelOrder("chief", found!.order, { threadId: DBB, title: "@Monitor" })).toBe(false);
    // a newer order already on record wins over an older one read back
    state.record("chief", { threadId: DD9, title: "Esteira", at: 50 }, [{ threadId: DD9, at: 50, text: "Use só esta conversa." }]);
    expect(state.adoptChannelOrder("chief", found!.order, { threadId: DBB, title: "@Monitor" })).toBe(false);
    expect(state.ownerThread("chief")?.threadId).toBe(DD9);
  });

  it("records what was decided, not the greeting", () => {
    expect(decisionOf("Osvaldo, o retorno do QA chegou. Mergeei a #9315 pelo gate. Falta a #9316.")).toBe("Mergeei a #9315 pelo gate.");
    expect(decisionOf("Osvaldo, o retorno do QA chegou.")).toBe("o retorno do QA chegou.");
  });
});
