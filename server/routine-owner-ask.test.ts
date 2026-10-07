import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotAutonomy, OWNER_PENDING_MAX_PER_THREAD } from "./bot-autonomy.ts";
import { ROUTINE_ASK_CORPUS } from "./routine-owner-ask.corpus.ts";
import { applyRoutineAsks, keepRoutineAsk, routineAskItem, markStaleRoutineAsks, ownerAnswerCloses, ownerEndsRoutineAsk, ownerSettlesRoutineAsks, ROUTINE_ASK_KEEP_LABEL, ROUTINE_ASK_LET_GO_MS, ROUTINE_ASK_SETTLED_MS, ownerAnswersItem, routineAskKey, routineAskTitle, routineOwnerAsks, routineReplyText, saysRoutineAskResolved, settleRoutineAsks } from "./routine-owner-ask.ts";

// The Monitor's routine "Atendimento: Chat, planilha e issues", 05/10 09:00 (R12-visual N22), as it wrote it.
const MONITOR_0510 = [
  "Passada das 10h sem novidade. Não postei nada no Chat, não mexi na planilha e não avisei o Chief of Staff.",
  "",
  "- **Chat:** a mensagem mais recente ainda é a do Filipe Migon às 8:58, \"Top, corrigido o problema então\". Ela veio depois de o Matheus confirmar a #9295 e já foi tratada na passada das 9h; não pede nada. A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.",
  "- **Planilha:** nada mudou desde a cópia das 8h.",
  "- **GitHub:** nenhuma issue foi criada nem atualizada em `dinhogehm/nuria-platform` desde as 8h.",
].join("\n");
// The Monitor's 02/10 15:00: two decisions under one ask, and the same one said loose before it.
const MONITOR_0210 = [
  "- **Chat:** não postei. O Chief sugeriu abrir uma conversa nova com ele para confirmar o recebimento e pedir os filtros e o print, mas preferi deixar essa decisão com você.",
  "",
  "Preciso da sua decisão em duas coisas:",
  "1. Posso escrever o número da issue nas Observações da linha 110, depois do texto do Filipe? Isso depende de você confirmar.",
  "2. Abro uma conversa nova com o Filipe no Chat para pedir os filtros e o print?",
].join("\n");
const BOTS = ["Monitor Chat Atendimento", "Chief of Staff"];
const ctx = { ownerName: "Osvaldo", knownNames: BOTS };
const titles = (text: string) => routineOwnerAsks(text, ctx).map((ask) => `${routineAskKey(ask)} | ${routineAskTitle(ask)}`);

describe("routineOwnerAsks: what a routine leaves with the owner", () => {
  it("the Monitor's real reply of 05/10: one ask, the widget conversation owed to the Luis Rossi", () => {
    const asks = routineOwnerAsks(MONITOR_0510, ctx);
    expect(asks).toHaveLength(1);
    // the widget is a channel, not a conversation of its own: the key is the person it is owed to (INSP-N22 r2 F1)
    expect(asks[0]).toMatchObject({ subject: { kind: "pessoa", id: "luis-rossi" }, people: [{ name: "Luis Rossi", article: "o" }], context: "widget" });
    expect(routineAskTitle(asks[0]!)).toBe("Responder ao Luis Rossi (widget)");
  });

  it.each([
    ["continua com você", "A conversa da Daiane continua com você."],
    ["aguardando o Osvaldo", "O comentário na #9331 está aguardando o Osvaldo."],
    ["depende de você", "Isso depende de você confirmar."],
    ["fica com você", "Uma decisão fica com você: se o que a Marluce espera vira mudança de regra ou só ajuste na grade."],
    ["precisa da sua decisão", "A linha 179 precisa da sua decisão antes de eu mexer."],
    ["deixar essa decisão com você", "O Chief sugeriu abrir uma conversa com o Filipe, mas preferi deixar essa decisão com você."],
  ])("asks: %s", (_label, sentence) => {
    expect(routineOwnerAsks(sentence, ctx)).toHaveLength(1);
  });

  // INSP-N22 A5 (n22/probe.ts): a condition, a denial by quantifier, a question it answers itself
  it.each([
    ["a denial", "Esse trabalho já é meu e não depende de você."],
    ["a denial by name", "Não depende do Osvaldo: eu mesmo abro a issue."],
    ["a quote", "O Filipe escreveu no Chat: \"isso continua com você, Osvaldo\". Já respondi."],
    ["a quoted block", "O Chief disse:\n> A conversa do widget continua com você.\nNada mudou desde então."],
    ["an echo of an item the owner has", "A linha 179 segue esperando a sua decisão em \"Precisa de você\" (item o14)."],
    ["a sentence with no one waiting", "Passada concluída. Não havia nada novo, então não postei nada nem mexi na planilha."],
    ["nothing waits (the Chief's real line)", "Osvaldo, não tem nada esperando por você agora."],
    ["none of it depends (the Chief's real line)", "Nada disso depende de você."],
    ["se", "Se a checagem de testes estourar o tempo de novo, eu trago as duas opções que dependem de você."],
    ["quando (real, 03/10)", "Quando ela chegar, te digo o que dá para fazer e o que depende de você, por exemplo um login."],
    ["caso", "Caso o Filipe não responda até amanhã, a decisão fica com você."],
    ["nenhuma", "Nenhuma pendência fica com você hoje."],
    ["nada … o Osvaldo", "Nada está aguardando o Osvaldo."],
    ["a question it answers", "Algo depende de você? Não, tudo segue."],
    ["a technical 'do seu'", "O job `deploy` depende do seu token GH_TOKEN; o step aguardando o seu runner é o 3."],
  ])("never: %s", (_label, text) => {
    expect(routineOwnerAsks(text, { ...ctx, itemIds: ["o14"] })).toEqual([]);
  });

  it("a list it leads: one pendency per item, the loose sentence that says one of them is that one (real 02/10, INSP-N22 A9)", () => {
    expect(titles(MONITOR_0210)).toEqual([
      "routine-ask:linha:110 | Decidir: posso escrever o número da issue nas Observações da linha 110, depois do texto do Filipe?",
      "routine-ask:pessoa:filipe | Decidir: abro uma conversa nova com o Filipe no Chat para pedir os filtros e o print?",
    ]);
    expect(titles("Ainda dependem de você:\n- abrir a issue do ATD-202610-0042\n- responder ao Filipe\n- aprovar a #9370")).toEqual([
      "routine-ask:ticket:atd-202610-0042 | Abrir a issue do ATD-202610-0042",
      "routine-ask:pessoa:filipe | Responder ao Filipe",
      "routine-ask:issue:9370 | Aprovar a #9370",
    ]);
  });

  // INSP-N22 A1, A6: the ticket rules the key; a person only when the pendency is owed to them
  it("the key: a ticket or issue named before the person; a person named in passing is no subject", () => {
    expect(titles("O reembolso do Luis Rossi depende de você: ele pediu estorno de R$ 400 no ticket ATD-202610-0099.").map((each) => each.split(" | ")[0])).toEqual(["routine-ask:ticket:atd-202610-0099"]);
    expect(titles("Fica com você decidir a escala; hoje de manhã falei com o Filipe sobre outra coisa.")).toEqual(["routine-ask:frase:decidir-escala-manha-falei | Decidir a escala"]);
    // reported: her words, not the bot's ask (INSP-N22 r2)
    expect(titles("A Marluce disse que a resposta depende de você e do Filipe.")).toEqual([]);
    expect(titles("Fica com você responder ao Filipe e à Marluce sobre a escala de sábado.")).toEqual(["routine-ask:pessoa:filipe+marluce | Responder ao Filipe e à Marluce"]);
    // two pendencies with the same person in one reply: two asks
    expect(titles("A conversa do widget continua com você: você ia falar com o Luis Rossi. O reembolso do Luis Rossi também depende de você.")).toHaveLength(2);
  });

  it("titles: a whole word before the cut, no preposition guessed without an article", () => {
    const [marluce] = routineOwnerAsks("Uma decisão fica com você: se o que a Marluce espera, tickets distribuídos fora do horário do chat, vira mudança de regra ou só ajuste na grade de horário do helpdesk.", ctx);
    // cut at a word, never left on "de"
    expect(routineAskTitle(marluce!)).toBe("Decidir: se o que a Marluce espera, tickets distribuídos fora do horário do chat, vira mudança de regra…");
    expect(titles("Fica com você falar com Filipe sobre a escala.")[0]).toMatch(/\| Falar com Filipe$/);
  });

  it("the run's reply: its last text, never a narration turned into a work note, nor another bot's", () => {
    const messages = [
      { role: "bot", kind: "text", text: "Passada sem novidade. Nada mudou." },
      { role: "bot", kind: "activity", text: "Still waiting on you for the widget thread." },
      { role: "bot", kind: "text", text: "A conversa continua com você.", from: { botId: "x" } },
    ];
    expect(routineReplyText(messages)).toBe("Passada sem novidade. Nada mudou.");
  });
});

describe("saysRoutineAskResolved: the bot says THIS pendency is done (INSP-N22 A4, n22/close.ts)", () => {
  const widget = { key: "routine-ask:pessoa:luis-rossi", title: "Responder ao Luis Rossi (widget)", why: "O bot Monitor, na rotina \"Atendimento\", escreveu: \"A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.\" Última vez dita às 09:00 de 05/10." };
  it("closes on the past, affirmative and whole, about the same pendency", () => {
    expect(saysRoutineAskResolved(widget, "A conversa do widget com o Luis Rossi foi resolvida.")).toBe(true);
    expect(saysRoutineAskResolved(widget, "A conversa do widget com o Luis Rossi não está mais com você.")).toBe(true);
  });
  it.each([
    ["another subject, the same person", "O ticket do Luis Rossi sobre boleto foi resolvido pela Marluce."],
    ["another issue named", "O bug do widget foi resolvido na #9370, o Luis Rossi já foi avisado."],
    ["a long negation", "A conversa do widget com o Luis Rossi ainda não foi, até onde sei, resolvida."],
    ["a negation", "A conversa do widget com o Luis Rossi não está resolvida."],
    ["a condition", "Se o Luis Rossi responder no widget, a conversa fica resolvida."],
    ["a future", "A conversa do widget com o Luis Rossi será resolvida amanhã."],
    ["a question", "A conversa do widget com o Luis Rossi foi resolvida?"],
    ["someone else's word, and a part left", "O Luis Rossi disse que a conversa do widget está resolvida do lado dele, mas falta você confirmar."],
    ["a part", "Metade da conversa do widget com o Luis Rossi foi respondida; a outra parte segue."],
    ["a quote", "O Matheus escreveu: \"a conversa do widget do Luis Rossi está resolvida\"."],
  ])("never: %s", (_label, text) => {
    expect(saysRoutineAskResolved(widget, text)).toBe(false);
  });
  it("a ticket or issue: its own action done, or the word for done about what was asked — not anything said beside it", () => {
    const ticket = { key: "routine-ask:ticket:atd-202610-0042", title: "A abertura da issue do ATD-202610-0042…", why: "X, na rotina \"Atendimento: Chat, planilha e issues\", escreveu: \"Ainda dependem do Osvaldo: a abertura da issue do ATD-202610-0042 e, com ela, a linha dele na planilha.\" Última vez dita às 16:00 de 01/10." };
    // the Monitor's real 03/10
    expect(saysRoutineAskResolved(ticket, "- **#9364 (ATD-202610-0042 reabre e encerra de novo) e #9365 (aviso vermelho de assentos e fila esvaziada):** as duas da Daiane, abertas às 09:36 na minha outra conversa com o Chief.")).toBe(true);
    expect(saysRoutineAskResolved(ticket, "O ATD-202610-0042 foi respondido ao cliente hoje.")).toBe(false);
    expect(saysRoutineAskResolved(ticket, "- Issue (a): o ATD-202610-0042 é reaberto e logo encerra de novo.")).toBe(false);
    const merge = { key: "routine-ask:issue:9370", title: "O merge da #9370", why: "X, na rotina \"Y\", escreveu: \"O merge da #9370 depende de você.\" Última vez dita às 10:00 de 05/10." };
    expect(saysRoutineAskResolved(merge, "A #9370 tinha um comentário que foi resolvido.")).toBe(false);
    expect(saysRoutineAskResolved(merge, "A #9370 foi mesclada às 11:02.")).toBe(true);
    const row = { key: "routine-ask:linha:110", title: "Decidir: posso escrever…", why: "X, na rotina \"Y\", escreveu: \"Preciso da sua decisão: posso escrever o número da issue nas Observações da linha 110?\" Última vez dita às 15:02 de 02/10." };
    expect(saysRoutineAskResolved(row, "Escrevi o número da issue nas Observações da linha 112, resolvido.")).toBe(false);
  });
  it("words alone: the routine's own words are no match (real 01/10: the three watches, the Filipe)", () => {
    const watches = { key: "routine-ask:frase:tres-vigias-permanentes-chat", title: "Três vigias permanentes…", why: "O bot Monitor, na rotina \"Atendimento: Chat, planilha e issues\", escreveu: \"Parado, esperando você: Três vigias permanentes (Chat, planilha e issues): não posso armar numa execução de rotina. Se quiser, peça na minha conversa principal.\" Última vez dita às 16:09 de 30/09." };
    expect(saysRoutineAskResolved(watches, "Passada das 13h BRT (01/10) concluída: li o Chat pelo gog e conferi a planilha e as issues.")).toBe(false);
    expect(saysRoutineAskResolved(watches, "Ele já foi respondido na conversa dele.")).toBe(false);
    const filipe = { key: "routine-ask:pessoa:filipe", title: "Decidir: abro uma conversa nova com o Filipe…", why: "O bot Monitor, na rotina \"Atendimento: Chat, planilha e issues\", escreveu: \"Preciso da sua decisão em duas coisas: Abro uma conversa nova com o Filipe no Chat para pedir os filtros e o print?\" Última vez dita às 15:02 de 02/10." };
    expect(saysRoutineAskResolved(filipe, "**Chat**: respondi na conversa do Filipe sobre o código pedido no widget, que é a da mensagem de 02/10 18:43.")).toBe(false);
    // the people named in passing (real 30/09 and 01/10)
    const marluce = { key: "routine-ask:pessoa:marluce", title: "Decidir: se o que a Marluce espera…", why: "X, na rotina \"Y\", escreveu: \"Uma decisão fica com você: se o que a Marluce espera, tickets distribuídos fora do horário do chat, vira mudança de regra ou só ajuste na grade de horário do helpdesk.\" Última vez dita às 12:00 de 30/09." };
    expect(saysRoutineAskResolved(marluce, "A 177 só muda quando a Marluce confirmar que o ajuste resolveu, ou quando você decidir encerrar.")).toBe(false);
    expect(saysRoutineAskResolved(marluce, "- **Ponto de atenção:** antes de mim, às 16:28, a Marluce Oliveira tinha respondido só \"sim\", e a Daiane curtiu.")).toBe(false);
    expect(saysRoutineAskResolved(marluce, "| Ticket criado de chat grava o nome de quem falou (PR #9316) | #9311, fechada | Marluce | 176 |")).toBe(false);
  });
});

describe("ownerAnswerCloses: the owner's words end the pendency (INSP-N22 A3)", () => {
  it.each(["Já falei com ele por telefone.", "Resolvido.", "Pode fechar", "Feito, respondi no widget."])("closes: %s", (text) => {
    expect(ownerAnswerCloses(text)).toBe(true);
  });
  it.each(["Qual widget? Não entendi", "Ainda não falei com ele.", "Vou falar amanhã.", "Acho que o Chief resolveu, confere?", "Manda o link da conversa"])("stays open: %s", (text) => {
    expect(ownerAnswerCloses(text)).toBe(false);
  });
});

describe("applyRoutineAsks: one item per pendency, in the ledger", () => {
  let dir: string;
  let now: number;
  const make = () => new BotAutonomy({ path: join(dir, "bot-autonomy.json"), now: () => now });
  const run = (ledger: BotAutonomy, text: string) => applyRoutineAsks(ledger, { botId: "monitor", botName: "Monitor Chat Atendimento", routineName: "Atendimento: Chat, planilha e issues", threadId: "results", conversationTitle: "Atendimento: Chat, planilha e issues", text, at: now, ...ctx });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-routine-ask-"));
    now = new Date(2026, 9, 5, 9, 0).getTime();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the hourly repetition refreshes the one item: same id, same title, why says since when and the last time", () => {
    const ledger = make();
    const first = run(ledger, MONITOR_0510);
    expect(first.opened).toHaveLength(1);
    const item = first.opened[0]!;
    expect(item).toMatchObject({ id: "o1", threadId: "results", key: "routine-ask:pessoa:luis-rossi", title: "Responder ao Luis Rossi (widget)" });
    expect(item.why).toBe("O bot Monitor Chat Atendimento, na rotina \"Atendimento: Chat, planilha e issues\", escreveu: \"A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.\" Última vez dita às 09:00 de 05/10.");
    expect(item.steps?.map((step) => step.text)).toEqual([
      "Veja o contexto na conversa \"Atendimento: Chat, planilha e issues\" do bot Monitor Chat Atendimento.",
      "Resolva com o Luis Rossi o que ficou com você.",
      "Quando terminar, escolha \"Já resolvi\" ou diga aqui o que fez. Uma pergunta ou um recado vai para o bot e o item continua aberto.",
    ]);
    // the option says it is done, never the title again
    expect(item.options).toEqual([{ label: "Já resolvi", reply: "Já resolvi essa pendência." }]);
    now += 3_600_000;
    const second = run(ledger, "Passada das 11h sem novidade. A conversa do widget com o Luis Rossi continua com você.");
    now += 3_600_000;
    const third = run(make(), MONITOR_0510);
    expect([second.opened, third.opened]).toEqual([[], []]);
    expect(third.refreshed.map((each) => each.id)).toEqual(["o1"]);
    const open = make().ownerPendingOf("monitor");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: "o1", title: "Responder ao Luis Rossi (widget)", lastSaidAt: now });
    expect(open[0]!.why).toContain("Repete isso desde as 09:00 de 05/10; última vez dita às 11:00 de 05/10.");
  });

  it("another pendency about the same subject is another item, and never rewrites the first one's why (INSP-N22 A1, n22/supp.ts)", () => {
    const ledger = make();
    const [widget] = run(ledger, MONITOR_0510).opened;
    now += 3_600_000;
    const other = run(ledger, "O reembolso do Luis Rossi também depende de você: ele pediu estorno de R$ 400.");
    expect(other.refreshed).toEqual([]);
    expect(other.opened).toHaveLength(1);
    // the same person, another pendency: its own key (~words)
    const third = run(ledger, "Novo: responder ao Luis Rossi sobre o cancelamento do contrato continua com você.");
    expect(third.opened.map((each) => each.key)).toEqual([expect.stringMatching(/^routine-ask:pessoa:luis-rossi~/)]);
    const kept = ledger.ownerPendingById("monitor", widget!.id)!;
    expect(kept.why).toBe(widget!.why);
    // a decision of a sheet row: two items for two decisions
    expect(run(ledger, MONITOR_0210).opened.map((each) => each.key)).toEqual(["routine-ask:linha:110", "routine-ask:pessoa:filipe"]);
  });

  it("silence never closes it: after 24 h without the routine repeating it, the why says so (INSP-N22 A8)", () => {
    const ledger = make();
    run(ledger, MONITOR_0510);
    now += 23 * 3_600_000;
    expect(markStaleRoutineAsks(ledger, now)).toEqual([]);
    now += 2 * 3_600_000;
    expect(run(ledger, "Passada concluída. Não havia nada novo.").resolved).toEqual([]);
    expect(markStaleRoutineAsks(ledger, now).map((each) => each.id)).toEqual(["o1"]);
    expect(ledger.ownerPendingOf("monitor")[0]!.why).toMatch(/Última vez dita às 09:00 de 05\/10\. \(o bot não repete desde 05\/10; confirme se ainda vale\)$/);
    // marked once; said again, the note goes
    expect(markStaleRoutineAsks(ledger, now + 3_600_000)).toEqual([]);
    run(ledger, MONITOR_0510);
    expect(ledger.ownerPendingOf("monitor")[0]!.why).not.toContain("não repete desde");
  });

  it("the bot's word closes it, and a new ask after gets a new id (ownerPendingSeq)", () => {
    const ledger = make();
    run(ledger, MONITOR_0510);
    const done = settleRoutineAsks(ledger, "monitor", "A conversa do widget com o Luis Rossi foi resolvida.");
    expect(done.map((each) => each.id)).toEqual(["o1"]);
    expect(ledger.resolvedOwnerPendingOf("monitor")[0]).toMatchObject({ id: "o1", resolvedBy: "bot", resolvedNote: "o bot disse que resolveu" });
    expect(run(make(), MONITOR_0510).opened.map((each) => each.id)).toEqual(["o2"]);
  });

  it("answered by the owner: only the SAME pendency is held back for 24 h, a new one opens (INSP-N22 A2)", () => {
    const ledger = make();
    const [item] = run(ledger, MONITOR_0510).opened;
    ledger.resolveOwnerPending({ botId: "monitor", id: item!.id, by: "owner" });
    now += 3_600_000;
    expect(run(ledger, MONITOR_0510).opened).toEqual([]);
    now += 3_600_000;
    expect(run(ledger, "Novo: o Luis Rossi pediu cancelamento do contrato e isso depende de você.").opened).toHaveLength(1);
    now += ROUTINE_ASK_SETTLED_MS;
    expect(run(ledger, MONITOR_0510).opened).toHaveLength(1);
  });

  it("a bot's own item on the same subject already asks it", () => {
    const ledger = make();
    ledger.addOwnerPending("monitor", "results", { title: "Responder no widget o que ficou com o Luis Rossi" });
    expect(run(ledger, MONITOR_0510)).toMatchObject({ opened: [], refreshed: [] });
  });

  it("never dropped by the per-conversation cap: the owner's pendency is not closed by a list's size (INSP-N22 A7)", () => {
    const ledger = make();
    const [item] = run(ledger, MONITOR_0510).opened;
    for (let n = 0; n <= OWNER_PENDING_MAX_PER_THREAD; n++) ledger.addOwnerPending("monitor", "results", { title: `Item próprio ${n}` });
    expect(ledger.ownerPendingById("monitor", item!.id)).toBeTruthy();
    expect(ledger.ownerPendingOf("monitor").filter((each) => !each.key)).toHaveLength(OWNER_PENDING_MAX_PER_THREAD);
  });
});

describe("INSP-N22 r2", () => {
  let dir: string;
  let now: number;
  const make = () => new BotAutonomy({ path: join(dir, "bot-autonomy.json"), now: () => now });
  const run = (ledger: BotAutonomy, text: string) => applyRoutineAsks(ledger, { botId: "monitor", botName: "Monitor Chat Atendimento", routineName: "Atendimento: Chat, planilha e issues", threadId: "results", text, at: now, ...ctx });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-routine-ask-r2-"));
    now = new Date(2026, 8, 30, 16, 9).getTime();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("F1: a channel is no key — the widget conversation of someone else never closes the Luis Rossi's item; an identified conversation is", () => {
    const ledger = make();
    const [item] = run(ledger, MONITOR_0510).opened;
    expect(item!.key).toBe("routine-ask:pessoa:luis-rossi");
    expect(settleRoutineAsks(ledger, "monitor", "A conversa do widget com a Daiane foi resolvida.")).toEqual([]);
    expect(settleRoutineAsks(ledger, "monitor", "A conversa sobre o bug do widget foi encerrada no Chat.")).toEqual([]);
    expect(routineOwnerAsks("A conversa `dGFX5l60z8U` do Filipe continua com você.", ctx).map(routineAskKey)).toEqual(["routine-ask:conversa:dgfx5l60z8u"]);
  });

  // the Monitor's real 30/09 16:09: "Parado, esperando você:" and two items; the owner armed the watches at 16:12
  const PARADO = [
    "**Parado, esperando você:**",
    "1. **Três vigias permanentes (Chat, planilha e issues):** não posso armar numa execução de rotina. Se quiser, peça na minha conversa principal.",
    "2. **Regras de 30/09 na minha memória permanente:** só gravo o que você me confirmar diretamente.",
  ].join("\n");
  const ARMED = "▎ Monitor, arme AGORA, nesta conversa, três vigias permanentes com wake_when (standing: true, cada um com seu label, sem until):\n▎ 1. label \"chat\": gog chat messages list spaces/AAQA4TXnzJ4 --plain, a cada 3 min";

  it("F2/T1: the owner doing what the item asked, in a conversation with the bot, folds it under \"Talvez já resolvido\" to confirm — never closes it (real 30/09 16:12)", () => {
    const ledger = make();
    const opened = run(ledger, PARADO).opened;
    expect(opened.map((each) => each.title)).toEqual(["Ver: três vigias permanentes (Chat, planilha e issues)", "Ver: regras de 30/09 na minha memória permanente"]);
    // a question about it, or an earlier message, moves nothing
    expect(ownerSettlesRoutineAsks(ledger, "monitor", [{ at: now + 60_000, text: "O que são os três vigias permanentes?" }, { at: now - 60_000, text: ARMED }])).toEqual([]);
    const at = now + 3 * 60_000;
    const moved = ownerSettlesRoutineAsks(ledger, "monitor", [{ at, text: ARMED }]);
    expect(moved.map((each) => each.id)).toEqual([opened[0]!.id]);
    // still open, folded, with the note and both answers
    expect(ledger.resolvedOwnerPendingOf("monitor")).toEqual([]);
    const watches = ledger.ownerPendingById("monitor", opened[0]!.id)!;
    expect(watches.demotedAt).toBe(at);
    expect(watches.why).toMatch(/\(você tratou disso na conversa às 16:12 de 30\/09; confirme\)$/);
    expect(watches.options?.map((each) => each.label)).toEqual(["Já resolvi", ROUTINE_ASK_KEEP_LABEL]);
    // the routine naming it (to report the watches armed) does not bring it back; asking it again does
    now += 3_600_000;
    expect(run(ledger, "Os três vigias permanentes do Chat, da planilha e das issues estão armados na conversa principal.").promoted).toEqual([]);
    expect(ledger.ownerPendingById("monitor", opened[0]!.id)!.demotedAt).toBe(at);
    // the rules: on top
    expect(ledger.ownerPendingById("monitor", opened[1]!.id)!.demotedAt).toBeUndefined();
  });

  it("F2: said once and let go — 48 h AND 2 runs without it: under \"Talvez já resolvido\", never closed; \"Ainda vale\" and the bot naming it bring it back", () => {
    const ledger = make();
    const [item] = run(ledger, MONITOR_0510).opened;
    const quiet = "Passada concluída. Não havia nada novo.";
    // two quiet runs, but within 48 h: on top
    now += 3_600_000;
    run(ledger, quiet);
    now += 3_600_000;
    expect(run(ledger, quiet).demoted).toEqual([]);
    // 48 h: the minute pass lets it go (2 quiet runs already)
    now = item!.createdAt + ROUTINE_ASK_LET_GO_MS;
    expect(markStaleRoutineAsks(ledger, now).map((each) => each.demotedAt)).toEqual([now]);
    const down = ledger.ownerPendingById("monitor", item!.id)!;
    expect(down.options?.map((each) => each.label)).toEqual(["Já resolvi", ROUTINE_ASK_KEEP_LABEL]);
    expect(ledger.ownerPendingOf("monitor")).toHaveLength(1);
    // "Ainda vale": back on top, counting again from now
    keepRoutineAsk(ledger, "monitor", item!.id, now);
    expect(ledger.ownerPendingById("monitor", item!.id)).toMatchObject({ keptAt: now, options: [{ label: "Já resolvi" }] });
    expect(ledger.ownerPendingById("monitor", item!.id)!.demotedAt).toBeUndefined();
    now += 3_600_000;
    run(ledger, quiet);
    now += 3_600_000;
    run(ledger, quiet);
    expect(markStaleRoutineAsks(ledger, now).filter((each) => each.demotedAt !== undefined)).toEqual([]);
    now += ROUTINE_ASK_LET_GO_MS;
    expect(run(ledger, quiet).demoted.map((each) => each.id)).toEqual([item!.id]);
    // the bot names it again: back on top by itself
    now += 3_600_000;
    const back = run(ledger, "A conversa do widget: o Luis Rossi escreveu de novo às 9h e segue sem resposta.");
    expect(back.promoted.map((each) => each.id)).toEqual([item!.id]);
    expect(ledger.ownerPendingById("monitor", item!.id)!.demotedAt).toBeUndefined();
  });

  it("F3: the owner's partial or open words never close it (the inspector's phrases)", () => {
    for (const text of ["Tratei metade", "Feito em parte", "Respondi o Luis Rossi, falta o Filipe", "Falei com a Marluce, ela vai pensar", "Já falei com ele e ele pediu mais um dia", "Feito o pedido; aguardo a resposta dele pra fechar", "Respondi errado, ignora", "Pronto para revisar, me manda o link", "Pode fechar esse, abre outro pro reembolso"]) {
      expect(ownerAnswerCloses(text), text).toBe(false);
    }
    expect(ownerAnswerCloses("Pronto, feito.")).toBe(true);
  });

  it("F4: a pronoun, a relative or a \"nenhum\" of another clause is no condition nor denial: these ask", () => {
    for (const text of ["O cliente se queixou de novo e a resposta depende de você.", "O ticket que abriu quando o chat caiu continua com você.", "Nenhum agente respondeu o ticket ATD-202610-0050, então a decisão fica com você.", "A Marluce pediu que a escala se mantenha; a decisão fica com você."]) {
      expect(routineOwnerAsks(text, ctx), text).toHaveLength(1);
    }
    // still: the conditions that open the clause of the ask
    expect(routineOwnerAsks("Caso o Filipe não responda até amanhã, a decisão fica com você.", ctx)).toEqual([]);
  });

  it("F5: a \"not\" after the word for done, about what was asked, keeps it open", () => {
    const row = { key: "routine-ask:linha:110", title: "Decidir: posso escrever…", why: "X, na rotina \"Y\", escreveu: \"Preciso da sua decisão: posso escrever o número da issue nas Observações da linha 110?\" Última vez dita às 15:02 de 02/10." };
    expect(saysRoutineAskResolved(row, "A linha 110 foi fechada pelo Filipe como duplicada; o número da issue ainda não foi escrito.")).toBe(false);
  });

  it("F6: a title the owner acts on; someone else's reported words open nothing", () => {
    expect(titles("A planilha da escala de sábado ficou sem dono. O Osvaldo precisa decidir isso.")).toEqual([expect.stringMatching(/\| Decidir: a planilha da escala de sábado ficou sem dono\.?$/)]);
    expect(titles("O Osvaldo precisa aprovar a PR do relatório.")[0]).toMatch(/\| Aprovar a PR do relatório\.?$/);
    expect(titles("O comentário na #9331 está aguardando o Osvaldo.")[0]).toMatch(/\| Ver: o comentário na #9331$/);
    expect(routineOwnerAsks("A Marluce disse que a resposta depende de você e do Filipe.", ctx)).toEqual([]);
  });
});

describe("INSP-N22 r3", () => {
  const WIDGET = "A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.";
  const make = (clock: () => number) => new BotAutonomy({ path: null, now: clock });
  const base = { botId: "m", botName: "Monitor", routineName: "R", threadId: "t1", ...ctx };

  it("R1 (n22/flap.ts): named by the routine, the item is alive — back on top, and not let go again before 48 h and 2 runs more", () => {
    let clock = Date.parse("2026-10-05T12:00:00Z");
    const ledger = make(() => clock);
    applyRoutineAsks(ledger, { ...base, text: WIDGET, at: clock });
    const states: string[] = [];
    for (let h = 1; h <= 110; h++) {
      clock += 3_600_000;
      const text = h === 55 ? "O Luis Rossi ainda não respondeu no widget do Nuria.identify." : "Nada novo.";
      const result = applyRoutineAsks(ledger, { ...base, text, at: clock });
      if (result.demoted.length) states.push(`h${h} rebaixado`);
      if (result.promoted.length) states.push(`h${h} topo`);
    }
    expect(states).toEqual(["h48 rebaixado", "h55 topo", "h103 rebaixado"]);
    expect(ledger.ownerPendingOf("m")[0]!.lastSaidAt).toBe(Date.parse("2026-10-05T12:00:00Z") + 55 * 3_600_000);
  });

  it("R2: an order not to, or not yet, closes nothing", () => {
    let clock = Date.parse("2026-10-05T12:00:00Z");
    const ledger = make(() => clock);
    applyRoutineAsks(ledger, { ...base, text: "Preciso da sua decisão: posso escrever o número da issue nas Observações da linha 110, depois do texto do Filipe?", at: clock });
    expect(ownerSettlesRoutineAsks(ledger, "m", [{ at: clock + 60_000, text: "Não escreva nada na linha 110 ainda." }])).toEqual([]);
    expect(ownerSettlesRoutineAsks(ledger, "m", [{ at: clock + 60_000, text: "Escreva o número da issue na linha 110." }])).toHaveLength(1);
  });

  it("R3: the runs are counted by the routine's id — a renamed routine still lets its item go", () => {
    let clock = Date.parse("2026-10-05T12:00:00Z");
    const ledger = make(() => clock);
    const [item] = applyRoutineAsks(ledger, { ...base, routineId: "r1", text: WIDGET, at: clock }).opened;
    expect(item!.routineId).toBe("r1");
    clock += 49 * 3_600_000;
    applyRoutineAsks(ledger, { ...base, routineName: "R (renomeada)", routineId: "r1", text: "Nada novo.", at: clock });
    // another routine of the bot does not count
    applyRoutineAsks(ledger, { ...base, routineName: "Outra", routineId: "r2", text: "Nada novo.", at: clock });
    expect(ledger.ownerPendingOf("m")[0]!.quietRuns).toBe(1);
    expect(applyRoutineAsks(ledger, { ...base, routineName: "R (renomeada)", routineId: "r1", text: "Nada novo.", at: clock + 3_600_000 }).demoted.map((each) => each.id)).toEqual([item!.id]);
  });

  it("R5: after \"Ainda vale\" the why says so instead of asking to confirm; the titles lead with what is asked", () => {
    let clock = Date.parse("2026-10-05T12:00:00Z");
    const ledger = make(() => clock);
    const [item] = applyRoutineAsks(ledger, { ...base, text: WIDGET, at: clock }).opened;
    clock += 30 * 3_600_000;
    markStaleRoutineAsks(ledger, clock);
    expect(ledger.ownerPendingById("m", item!.id)!.why).toContain("confirme se ainda vale");
    const kept = keepRoutineAsk(ledger, "m", item!.id, clock)!;
    expect(kept.why).not.toContain("confirme se ainda vale");
    expect(kept.why).toMatch(/\(você confirmou que ainda vale às \d\d:\d\d de \d\d\/\d\d\)$/);
    // not marked stale again right away: a day from the confirmation
    expect(markStaleRoutineAsks(ledger, clock + 3_600_000)).toEqual([]);
    expect(titles("Até agora, a resposta ao Filipe continua com você.")[0]).toMatch(/\| Ver: a resposta ao Filipe$/);
    expect(titles("Desde ontem, quando a Marluce pediu, a escala fica com você.")[0]).toMatch(/\| Ver: a escala \(quando a Marluce pediu\)$/);
    expect(titles("O cliente se queixou de novo e a resposta depende de você.")[0]).toMatch(/\| Responder: o cliente se queixou de novo$/);
  });

  it("R6: a ticket's item closes with its action named or in so many words — not with any \"resolvido\" beside the ticket", () => {
    const ticket = { key: "routine-ask:ticket:atd-202610-0042", title: "Ver: a abertura da issue do ATD-202610-0042", why: "X, na rotina \"Y\", escreveu: \"Ainda dependem do Osvaldo: a abertura da issue do ATD-202610-0042 e, com ela, a linha dele na planilha.\" Última vez dita às 16:00 de 01/10." };
    expect(ownerEndsRoutineAsk(ticket, "Respondi a cliente do ATD-202610-0042, resolvido.")).toBe(false);
    expect(ownerEndsRoutineAsk(ticket, "Abri a issue do ATD-202610-0042.")).toBe(true);
    expect(ownerEndsRoutineAsk(ticket, "Pode fechar, já resolvi isso.")).toBe(true);
    expect(ownerEndsRoutineAsk(ticket, "Ainda não abri a issue.")).toBe(false);
    let clock = Date.parse("2026-10-05T12:00:00Z");
    const ledger = make(() => clock);
    applyRoutineAsks(ledger, { ...base, text: "Ainda dependem do Osvaldo: a abertura da issue do ATD-202610-0042 e, com ela, a linha dele na planilha.", at: clock });
    expect(ownerSettlesRoutineAsks(ledger, "m", [{ at: clock + 60_000, text: "Respondi a cliente do ATD-202610-0042, resolvido." }])).toEqual([]);
  });
});

describe("INSP-N22 r4", () => {
  const make = (clock: () => number) => new BotAutonomy({ path: null, now: clock });
  const base = { botId: "m", botName: "Monitor Chat Atendimento", routineName: "Atendimento: Chat, planilha e issues", routineId: "R-A", threadId: "t1", ...ctx };
  const ASKS = {
    widget: "A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.",
    linha: "Preciso da sua decisão: posso escrever o número da issue nas Observações da linha 110, depois do texto do Filipe?",
    ticket: "Ainda dependem do Osvaldo: a abertura da issue do ATD-202610-0042 e, com ela, a linha dele na planilha.",
    marluce: "Uma decisão fica com você: se o que a Marluce espera, tickets distribuídos fora do horário do chat, vira mudança de regra ou só ajuste na grade de horário do helpdesk.",
  };
  const ends = (which: keyof typeof ASKS, owner: string) => {
    const clock = Date.parse("2026-10-05T12:00:00Z");
    const ledger = make(() => clock);
    const item = applyRoutineAsks(ledger, { ...base, text: ASKS[which], at: clock }).opened[0]!;
    const panel = ownerEndsRoutineAsk(item, owner);
    const conversation = ownerSettlesRoutineAsks(ledger, "m", [{ at: clock + 60_000, text: owner }]).length > 0;
    expect(panel, `painel: ${owner}`).toBe(conversation);
    return panel;
  };

  it("S1: \"named\" is strict — the 4 passing mentions of the Chief (real, 30/09-02/10) never keep the rules of 30/09 alive", () => {
    let clock = new Date(2026, 8, 30, 16, 9).getTime();
    const ledger = make(() => clock);
    const parado = "**Parado, esperando você:**\n2. **Regras de 30/09 na minha memória permanente:** só gravo o que você me confirmar diretamente. Pode ser a mesma frase que o Chief sugeriu na conversa principal: \"confirmo as regras de 30/09 e arme os três vigias permanentes\".";
    const [rules] = applyRoutineAsks(ledger, { ...base, text: parado, at: clock }).opened;
    for (const said of ["O Chief of Staff respondeu e está de acordo com o que fiz.", "Quem respondeu foi minha conversa \"@Chief of Staff\", às 12:17 e 12:20; o Chief abriu a issue #9331.", "O Chief of Staff olhou o código e a minha resposta à Daiane bate com o que está na `main`.", "O Chief of Staff abriu a issue da linha 110: é a #9358."]) {
      clock += 6 * 3_600_000;
      applyRoutineAsks(ledger, { ...base, text: said, at: clock });
      expect(ledger.ownerPendingById("m", rules!.id)!.lastSaidAt, said).toBe(rules!.createdAt);
    }
    // its own words, three of them, do name it
    clock += 3_600_000;
    applyRoutineAsks(ledger, { ...base, text: "As regras da memória permanente seguem sem a sua confirmação.", at: clock });
    expect(ledger.ownerPendingById("m", rules!.id)!.lastSaidAt).toBe(clock);
  });

  it("S2: a \"not\" of another clause, \"ainda hoje\" or \"depois do texto\" never keeps open what the owner ended (the inspector's phrases)", () => {
    for (const [which, owner] of [
      ["linha", "Escrevi o número na linha 110, não precisa mais."],
      ["linha", "Pode escrever o número da issue na linha 110, não tem problema."],
      ["linha", "Escreva o número da issue na linha 110, não precisa me perguntar de novo."],
      ["linha", "Escreva o número da issue na linha 110 depois do texto do Filipe."],
      ["widget", "Já falei com o Luis Rossi sobre o widget, não precisa fazer nada."],
      ["widget", "Falei com o Luis Rossi sobre o widget ainda hoje cedo."],
      ["widget", "Resolvido: falei com o Luis Rossi do widget, nem precisa voltar nisso."],
      ["ticket", "Abri a issue do ATD-202610-0042, não precisa mais lembrar."],
      ["ticket", "A issue do ATD-202610-0042 já foi aberta por mim."],
      ["marluce", "Falei com a Marluce: é ajuste de grade, não mudança de regra."],
    ] as const) expect(ends(which, owner), owner).toBe(true);
    // and a "not" of its own clause, a later, still keep it open
    for (const [which, owner] of [
      ["linha", "Não escreva nada na linha 110 ainda."],
      ["linha", "Escreva o número da issue na linha 110 depois."],
      ["widget", "Ainda não falei com o Luis Rossi sobre o widget."],
      ["ticket", "Ainda não abri a issue do ATD-202610-0042."],
    ] as const) expect(ends(which, owner), owner).toBe(false);
    for (const text of ["Pronto pra falar com ele amanhã", "Pronto para revisar, me manda o link", "Respondi errado, ignora", "Decidi esperar a Marluce", "Fechado: ele manda o print na segunda", "Falei com a Marluce, ela vai pensar", "Já falei com ele e ele pediu mais um dia", "Acabei de responder", "ok", "Feito o pedido; aguardo a resposta dele pra fechar", "Pode fechar esse, abre outro pro reembolso", "Concluído não, só começado", "Respondi o Luis Rossi, falta o Filipe", "Tratei metade", "Feito em parte"]) {
      expect(ownerAnswerCloses(text), text).toBe(false);
    }
  });

  it("S3: the object of the ask, and \"pode fechar\" only for the item (the inspector's phrases)", () => {
    expect(ends("ticket", "Pode fechar o ticket ATD-202610-0042 no helpdesk, a cliente sumiu.")).toBe(false);
    expect(ends("ticket", "Abri o ATD-202610-0042 pra ver o histórico.")).toBe(false);
    expect(ends("linha", "Escrevi na linha 110 que o Filipe vai mandar o print.")).toBe(false);
    expect(ends("ticket", "Pode fechar o item do ATD-202610-0042.")).toBe(true);
    expect(ends("ticket", "Abri a issue do ATD-202610-0042 agora há pouco.")).toBe(true);
  });

  it("S4: an older item matched by its routine's name keeps the routine's id", () => {
    let clock = Date.parse("2026-10-05T12:00:00Z");
    const ledger = make(() => clock);
    const [item] = applyRoutineAsks(ledger, { ...base, routineId: undefined, text: ASKS.widget, at: clock }).opened;
    expect(item!.routineId).toBeUndefined();
    clock += 3_600_000;
    applyRoutineAsks(ledger, { ...base, text: "Nada novo.", at: clock });
    expect(ledger.ownerPendingById("m", item!.id)!.routineId).toBe("R-A");
  });
});

describe("INSP-N22 r5 T2: the owner answering THE item from the panel", () => {
  const clock = Date.parse("2026-10-05T12:00:00Z");
  const base = { botId: "m", botName: "Monitor Chat Atendimento", routineName: "Atendimento: Chat, planilha e issues", routineId: "R-A", threadId: "t1", ...ctx };
  const ASKS = {
    widget: "A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.",
    linha: "Preciso da sua decisão: posso escrever o número da issue nas Observações da linha 110, depois do texto do Filipe?",
    ticket: "Ainda dependem do Osvaldo: a abertura da issue do ATD-202610-0042 e, com ela, a linha dele na planilha.",
    marluce: "Uma decisão fica com você: se o que a Marluce espera, tickets distribuídos fora do horário do chat, vira mudança de regra ou só ajuste na grade de horário do helpdesk.",
  };
  const answers = (which: keyof typeof ASKS, text: string) => {
    const item = applyRoutineAsks(new BotAutonomy({ path: null, now: () => clock }), { ...base, text: ASKS[which], at: clock }).opened[0]!;
    return ownerAnswersItem(item, text);
  };
  it.each([
    ["ticket", "Abri a #9364 para o ATD-202610-0042."],
    ["ticket", "Registrei a issue do ATD-202610-0042 no GitHub."],
    ["ticket", "Criei a issue do ATD-202610-0042."],
    ["ticket", "Abri, é a #9364 (ATD-202610-0042)."],
    ["ticket", "ATD-202610-0042: aberta, #9364."],
    ["linha", "Pode escrever na linha 110."],
    ["linha", "Pode escrever, linha 110 liberada."],
    ["linha", "Escreva na linha 110."],
    ["linha", "Sim, pode escrever o número na linha 110."],
    ["widget", "Conversei com o Luis Rossi sobre o widget, tudo certo."],
    ["widget", "Falei direto com o Luis Rossi, o widget está ok."],
    ["marluce", "É só ajuste de grade, falei com a Marluce."],
    ["marluce", "Mudança de regra: tickets fora do horário vão para a fila da Marluce, decidido."],
  ] as const)("closes (the inspector's 13): %s — %s", (which, text) => {
    expect(answers(which, text)).toBe(true);
  });
  it.each([
    ["widget", "Qual widget? Não entendi"],
    ["widget", "Ainda não falei com o Luis Rossi."],
    ["widget", "Vou falar amanhã."],
    ["widget", "Acho que o Chief resolveu, confere?"],
    ["widget", "Manda o link da conversa"],
    ["widget", "Falei com a Marluce, ela vai pensar"],
    ["widget", "Feito o pedido; aguardo a resposta dele pra fechar"],
    ["widget", "Concluído não, só começado"],
    ["widget", "Respondi o Luis Rossi, falta o Filipe"],
    ["widget", "Tratei metade"],
    ["linha", "Não escreva nada na linha 110 ainda."],
    ["linha", "Escreva o número da issue na linha 110 depois."],
    ["ticket", "Ainda não abri a issue do ATD-202610-0042."],
  ] as const)("stays open: %s — %s", (which, text) => {
    expect(answers(which, text)).toBe(false);
  });
});

describe("INSP-N22 r6", () => {
  const WIDGET = "A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.";
  const base = { botId: "m", botName: "Monitor Chat Atendimento", routineName: "Atendimento: Chat, planilha e issues", routineId: "R-A", threadId: "t1", ...ctx };

  it.each([
    "Tentei falar com o Luis Rossi, mas ele não atendeu.",
    "Liguei e ele não atendeu.",
    "Mandei mensagem pra ele, sem resposta.",
    "Sim, mas ainda não falei com ele.",
    "Ok, deixa comigo.",
    "Pode deixar que eu cuido disso.",
    "Expliquei pro Filipe o caso, ele vê.",
  ])("U1: a panel answer with a reservation keeps the item open (the inspector's 7): %s", (text) => {
    const clock = Date.parse("2026-10-05T12:00:00Z");
    const item = applyRoutineAsks(new BotAutonomy({ path: null, now: () => clock }), { ...base, text: WIDGET, at: clock }).opened[0]!;
    expect(ownerAnswersItem(item, text)).toBe(false);
  });

  it.each([
    ["linha", "Escrevi o número na linha 110, não precisa mais."],
    ["linha", "Pode escrever o número da issue na linha 110, não tem problema."],
    ["linha", "Escreva o número da issue na linha 110, não precisa me perguntar de novo."],
    ["widget", "Já falei com o Luis Rossi sobre o widget, não precisa fazer nada."],
    ["widget", "Falei com o Luis Rossi sobre o widget ainda hoje cedo."],
    ["widget", "Resolvido: falei com o Luis Rossi do widget, nem precisa voltar nisso."],
    ["ticket", "Abri a issue do ATD-202610-0042, não precisa mais lembrar."],
    ["marluce", "Falei com a Marluce: é ajuste de grade, não mudança de regra."],
  ] as const)("V1 (r7): what only reinforces the ending is no reservation — the r4's 8 close from the panel: %s — %s", (which, text) => {
    const asks = {
      widget: WIDGET,
      linha: "Preciso da sua decisão: posso escrever o número da issue nas Observações da linha 110, depois do texto do Filipe?",
      ticket: "Ainda dependem do Osvaldo: a abertura da issue do ATD-202610-0042 e, com ela, a linha dele na planilha.",
      marluce: "Uma decisão fica com você: se o que a Marluce espera, tickets distribuídos fora do horário do chat, vira mudança de regra ou só ajuste na grade de horário do helpdesk.",
    };
    const clock = Date.parse("2026-10-05T12:00:00Z");
    const item = applyRoutineAsks(new BotAutonomy({ path: null, now: () => clock }), { ...base, text: asks[which], at: clock }).opened[0]!;
    expect(ownerAnswersItem(item, text)).toBe(true);
    // and the same words alone end nothing
    expect(ownerAnswersItem(item, "Não precisa.")).toBe(false);
  });

  it("U1: an item closed with a reservation never holds the routine back from asking it again", () => {
    let clock = Date.parse("2026-10-05T12:00:00Z");
    const ledger = new BotAutonomy({ path: null, now: () => clock });
    const [item] = applyRoutineAsks(ledger, { ...base, text: WIDGET, at: clock }).opened;
    ledger.recordOwnerPendingAnswer("m", item!.id, { kind: "text", text: "Ok, deixa comigo.", delivered: true });
    ledger.resolveOwnerPending({ botId: "m", id: item!.id, by: "owner" });
    clock += 3_600_000;
    expect(applyRoutineAsks(ledger, { ...base, text: WIDGET, at: clock }).opened).toHaveLength(1);
    // a clean "done" still holds it back
    const [again] = ledger.ownerPendingOf("m");
    ledger.recordOwnerPendingAnswer("m", again!.id, { kind: "text", text: "Falei com o Luis Rossi, tudo certo.", delivered: true });
    ledger.resolveOwnerPending({ botId: "m", id: again!.id, by: "owner" });
    clock += 3_600_000;
    expect(applyRoutineAsks(ledger, { ...base, text: WIDGET, at: clock }).opened).toEqual([]);
  });

  it("U2: the owner spoke, the item folded, \"Ainda vale\", a turn ends — it stays on top, folded again by nothing old", () => {
    let clock = Date.parse("2026-10-05T12:00:00Z");
    const ledger = new BotAutonomy({ path: null, now: () => clock });
    const [item] = applyRoutineAsks(ledger, { ...base, text: WIDGET, at: clock }).opened;
    const said = [{ at: clock + 60_000, text: "Já falei com o Luis Rossi sobre o widget." }];
    clock += 2 * 60_000;
    expect(ownerSettlesRoutineAsks(ledger, "m", said).map((each) => each.id)).toEqual([item!.id]);
    clock += 60_000;
    keepRoutineAsk(ledger, "m", item!.id, clock);
    // the next turn's end reads the same last messages: nothing moves, so no chip is written again
    clock += 60_000;
    expect(ownerSettlesRoutineAsks(ledger, "m", said)).toEqual([]);
    expect(ledger.ownerPendingById("m", item!.id)!.demotedAt).toBeUndefined();
    // the routine asks again, then a turn ends with the same old messages: still on top
    clock += 3_600_000;
    applyRoutineAsks(ledger, { ...base, text: WIDGET, at: clock });
    expect(ownerSettlesRoutineAsks(ledger, "m", said)).toEqual([]);
    expect(ledger.ownerPendingById("m", item!.id)!.demotedAt).toBeUndefined();
    // a new message of the owner after that folds it again
    expect(ownerSettlesRoutineAsks(ledger, "m", [...said, { at: clock + 60_000, text: "Conversei com o Luis Rossi sobre o widget agora, falei com ele." }])).toHaveLength(1);
  });
});

// R13-visual N26: the two routine items of 06/10 (o16, o17) got titles with no subject. The Monitor's replies, verbatim
// from messages.db (threads 61532c8d at 11:08 and 31df5560 at 15:00).
const MONITOR_0610_1108 = [
  "O Chief concordou: a linha da Marluce ([#9389](https://github.com/dinhogehm/nuria-platform/issues/9389)) fica com você, como você decidiu às 11:05. Ele não vai me pedir para gravar nada nela.",
  "",
  "- **Próximo passo:** quando você avisar que gravou a linha 191, eu leio as linhas 190 a 192. A ideia é confirmar que a 190 continua com o Matheus (#9384), que a 191 ficou com a Marluce e que a coluna de Observações não quebrou. Mando o resultado para o Chief.",
  "- **Quem regravou a 190:** continua sem resposta. O Chief não achou essa gravação no log dos comandos e prefere não dizer que foi você.",
  "- **Se demorar:** se a 191 ainda estiver vazia quando a #9389 andar, o Chief fala com você.",
  "",
  "Nesta passada não há mais nada pendente no Chat nem no GitHub.",
].join("\n");
const MONITOR_0610_1500 = [
  "Passada das 15h feita. Não postei nada, porque não havia novidade.",
  "",
  "- **Chat:** a última mensagem continua sendo a sua resposta à Marluce na conversa dela, às 10:10 BRT, sobre a [#9389](https://github.com/dinhogehm/nuria-platform/issues/9389). Ninguém escreveu depois e nenhuma pergunta ficou sem resposta.",
  "- **GitHub:** nenhuma issue foi atualizada desde as 13h BRT.",
  "- **Planilha:** comparei com o snapshot das 07h. As diferenças são as que já conhecíamos: a linha da Jess ([#9380](https://github.com/dinhogehm/nuria-platform/issues/9380)) agora está \"Pendente\" e a linha do Matheus ([#9384](https://github.com/dinhogehm/nuria-platform/issues/9384)) entrou. A linha da Marluce ([#9389](https://github.com/dinhogehm/nuria-platform/issues/9389)) ainda não aparece na planilha. Ela continua com você, então não mexi. Salvei um snapshot novo para comparar na próxima passada.",
].join("\n");

describe("R13-visual N26: a routine item's title always says what it is about", () => {
  // R13-followup 1: the only two routine items in 22 h of N22 were both reports, not asks
  it("o16 (real 11:08): a decision already taken, reported, opens no item", () => {
    expect(routineOwnerAsks(MONITOR_0610_1108, ctx)).toEqual([]);
    for (const said of ["A escala de sábado fica com você, como combinado ontem.", "A linha 179 fica com você, conforme você pediu.", "Você decidiu às 9h: a #9370 fica com você."]) {
      expect(routineOwnerAsks(said, ctx), said).toEqual([]);
    }
  });

  it("o17 (real 15:00): what the routine left alone because it is the owner's opens no item", () => {
    expect(routineOwnerAsks(MONITOR_0610_1500, ctx)).toEqual([]);
    // the inspector's third phrase
    expect(routineOwnerAsks("A linha 192 da Marluce continua com você, então não mexi.", ctx)).toEqual([]);
  });

  // INSP-R13VIS A1: the filter ran before the list, and a lead saying "como combinado" dropped every item
  it("a list is asked in so many words: \"como combinado\" or \"como você pediu\" in its lead drops nothing", () => {
    const listed = ["routine-ask:issue:9400 | Aprovar a #9400", "routine-ask:issue:9401 | Decidir a escala da #9401"];
    expect(titles("Como combinado, ainda dependem de você:\n- aprovar a #9400\n- decidir a escala da #9401")).toEqual(listed);
    expect(titles("Ainda dependem de você, como você pediu:\n- aprovar a #9400\n- decidir a escala da #9401")).toEqual(listed);
  });

  // INSP-R13VIS A2: an ask said the way routines say it wins over a decision taken or a "não mexi"
  it.each([
    ["O Chief concordou: a #9400 precisa do seu GO para o merge."],
    ["O Chief concordou que a #9400 precisa da sua aprovação para subir."],
    ["O Chief concordou com o plano, e a decisão sobre a #9400 fica com você."],
    ["Como combinado, aguardo seu OK para publicar a #9400."],
    ["Você já decidiu a escala, mas a #9400 ainda depende de você: falta o seu GO."],
    ["A #9400 fica com você, não mexi, mas preciso do seu GO até amanhã."],
    ["A #9400 fica com você, não mexi; falta você aprovar a PR."],
  ])("an explicit ask opens one item about the #9400: %s", (text) => {
    expect(titles(text)).toEqual([expect.stringMatching(/^routine-ask:issue:9400 \| .*#9400/)]);
  });

  // INSP-R13VIS round 2
  it.each([
    ["B1", "O Chief concordou com você: a linha da Marluce (#9389) fica com você, como você decidiu às 11:05."],
    ["B1", "O Chief concordou com você: a linha da Marluce (#9389) fica com você."],
    ["B1", "O Chief concordou, e a #9389 fica com você."],
    ["B2", "Como você decidiu às 11:05, a #9389 fica com você; a Marluce precisa da sua resposta, que você já mandou às 11:10."],
    ["B2", "Como combinado, a escala depende de você só nas férias, e isso já está registrado."],
    ["B2", "Como você pediu, aguardo seu retorno apenas se mudar algo; por enquanto sigo."],
  ])("%s: a report opens no item: %s", (_finding, text) => {
    expect(routineOwnerAsks(text, ctx)).toEqual([]);
  });

  // INSP-R13VIS C1: the 9 phrases round 2 opened and round 3 dropped
  it.each([
    ["O Chief concordou com isso, e a decisão sobre a #9400 fica com você."],
    ["O Chief concordou com tudo, e a escala do Lead depende da sua decisão."],
    ["O Chief concordou, mas o merge da #9400 é decisão sua."],
    ["A #9400 continua com você, então não mexi; preciso do seu GO para o merge, que já passou no gate."],
    ["A #9400 continua com você, então não mexi; aguardo seu OK, já que o gate passou."],
    ["Como combinado, preciso do seu GO para a #9400, que já está pronta."],
    ["Como combinado, aguardo sua aprovação para a #9400, já com o gate verde."],
    ["A linha 192 fica com você, não mexi: decida se entra hoje, já que a Marluce cobrou."],
    ["Como você pediu, a #9400 depende de você: o merge já pode sair."],
  ])("C1: an ask is not taken back by \"já que\", \"já com\", \"já pode\" nor by another clause after \"concordou\": %s", (text) => {
    expect(routineOwnerAsks(text, ctx)).toHaveLength(1);
  });

  it("C1: titles of those asks name what is asked, not who agreed", () => {
    expect(titles("O Chief concordou com tudo, e a escala do Lead depende da sua decisão.")).toEqual([expect.stringMatching(/\| Decidir: a escala do Lead$/)]);
  });

  it("C2: a one-word label leaves no \"depende de você\" in the title", () => {
    const origin = { botName: "Monitor", routineName: "R", firstAt: 0, lastAt: 0 };
    const title = (text: string) => routineOwnerAsks(text, ctx).map((ask) => routineAskItem(ask, origin).title);
    expect(title("Jev: liberar push da #9295 depende de você.")).toEqual(["Liberar push da #9295 (Jev)"]);
    expect(title("Planilha: gravar a nota da #9032 na H192 depende de você.")).toEqual(["Gravar a nota da #9032 na H192 (Planilha)"]);
    expect(title("Recomendo: aprovar o merge da #9400 ainda hoje, isso depende de você.")).toEqual(["Aprovar o merge da #9400 ainda hoje"]);
  });

  it("B1: agreeing to a plan, in another clause, still leaves the decision asked", () => {
    expect(titles("O Chief concordou com o plano, e a decisão sobre a #9400 fica com você.")).toEqual(["routine-ask:issue:9400 | Decidir: a #9400"]);
  });

  it("B3: a pronoun nothing before it agrees with is left out of the title, never \"(ela)\"", () => {
    expect(titles("O ticket ATD-202610-0042 voltou. Ela precisa da sua decisão sobre o reembolso.")).toEqual(["routine-ask:frase:reembolso | Decidir: o reembolso"]);
  });

  // B5: the real titles of 30/09, 03/10 and 06/10 that read "Ver: jev (#9278)", "Ver: #9058) (a o12…" and "Ver: o17 (#9378)"
  it("B5: a one-word tag or an item's id before the colon is no title; nor a list cut inside parentheses", () => {
    const origin = { botName: "Monitor", routineName: "R", firstAt: 0, lastAt: 0 };
    const title = (text: string) => routineOwnerAsks(text, ctx).map((ask) => routineAskItem(ask, origin).title);
    expect(title("Ainda depende de você: Jev: liberar push, pr:merge e carrier no nuria-platform. Sem isso, a #9278, que corrige o 503, não entra.")).toEqual([expect.stringMatching(/^Liberar push, pr:merge e carrier no nuria-platform \(Jev\)/)]);
    expect(title("Nada mudou na planilha nem no Chat neste turno; a o12 segue resolvida e a o2 (linha 105, #9058) continua com você.")).toEqual(["Ver: a o2 (linha 105, #9058)"]);
    expect(title("Ainda dependem de você: o17: a worktree da #9378 com a linha do graft no .gitignore.")).toEqual(["Ver: a worktree da #9378 com a linha do graft no .gitignore"]);
    expect(title("Ainda dependem de você: o18: abrir uma sessão à mão no nuria-platform no app, para destravar a sessão nova da #9378.")).toEqual(["Abrir uma sessão à mão no nuria-platform no app, para destravar a sessão nova da #9378"]);
    // the bot's own voice before the colon names nothing
    expect(title("Decisão sua: Recomendo: ajustar o corredor C1 para aceitar as colunas da linha 185.")[0]).toMatch(/^Decidir: ajustar o corredor C1/);
    // a fact the bot told of an item it names by title (06/10 07:39)
    expect(title("Precisa de você: atualizei o item já existente o19 (\"Decidir o destino de 17 worktrees paradas\") com a lista nova e o espaço livre, sem criar item repetido.")).toEqual(["Decidir o destino de 17 worktrees paradas"]);
    // the vocative is who, not what (01/10 18:07); the article the bot used is kept (INSP-R13VIS C3)
    expect(title("Osvaldo, a #9314 (https://github.com/dinhogehm/nuria-platform/pull/9314) (9295) travou e precisa de você para seguir.")).toEqual(["Ver: a #9314"]);
  });

  it("an explicit ask in the same paragraph still opens it, titled with its subject", () => {
    expect(titles("A linha 192 da Marluce continua com você, então não mexi. Preciso que confirme o valor da coluna H.")).toEqual(["routine-ask:linha:192 | Ver: a linha 192 da Marluce"]);
    expect(titles("A linha da Marluce (#9389) ainda não aparece na planilha. Ela continua com você, então não mexi: pode confirmar se grava hoje?")).toHaveLength(1);
    expect(titles("A linha da Marluce (#9389) ainda não aparece na planilha. Ela continua com você, então não mexi: pode confirmar se grava hoje?")[0]).toMatch(/^routine-ask:issue:9389 \| /);
    // a decision taken, with a new one asked in the same sentence
    expect(titles("Como você decidiu, a #9370 fica com você: decida até sexta se ela entra no lote.")).toHaveLength(1);
  });

  it("a pronoun inherits only the subject of the sentence right before; the ask is still its own sentence, and the why quotes both", () => {
    const asks = routineOwnerAsks("A linha da Marluce (#9389) ainda não aparece na planilha. Ela continua com você.", ctx);
    expect(asks.map((ask) => `${routineAskKey(ask)} | ${routineAskTitle(ask)}`)).toEqual(["routine-ask:issue:9389 | Ver: a linha da Marluce (#9389)"]);
    const item = routineAskItem(asks[0]!, { botName: "Monitor Chat Atendimento", routineName: "Atendimento: Chat, planilha e issues", firstAt: 0, lastAt: 0 });
    expect(item.why).toContain("escreveu: \"A linha da Marluce (#9389) ainda não aparece na planilha.");
    expect(item.why).toContain("Ela continua com você.\"");
  });

  // INSP-R13VIS A3: the nearest sentence that NAMES something was taken, and its whole fact became the title
  it("the sentence right before, never one further up that names an id: Daiane, not the closed #9403", () => {
    expect(titles("Fechei a #9403. A Daiane respondeu. Ela precisa da sua decisão sobre o reembolso.")).toEqual(["routine-ask:frase:daiane-reembolso | Decidir: o reembolso (a Daiane)"]);
    // a pronoun with no agreeing subject right before stays as the bot said it ("Ela" is not "a #9403"… nor "o widget")
    expect(titles("O widget caiu de novo às 14h. Ela continua com você.")[0]).not.toMatch(/widget/);
    // another item of the list is another paragraph: never its subject
    expect(titles("- A #9380 está pendente.\n- Ela continua com você.")[0]).not.toContain("9380");
  });

  // INSP-R13VIS A3: the five real titles that got worse (01/10 3e55c0fd ×3, 02/10 9f80f3ae, 03/10 52417e4a) and the "cisa de você" of 05/10
  it("the real cases: a label line, a fact the bot did or a time clause is no subject", () => {
    const origin = { botName: "Chief of Staff", routineName: "R", firstAt: 0, lastAt: 0 };
    const title = (text: string) => routineOwnerAsks(text, ctx).map((ask) => routineAskItem(ask, origin).title);
    for (const scope of ["o mesmo escopo de antes", "é o mesmo das outras tentativas"]) {
      expect(title(`Pedido: ${scope}, com o padrão "sem limite". Ela não faz o merge sem o meu OK, porque o valor padrão ainda depende do Osvaldo.`)).toEqual(["Ver: porque o valor padrão (ela não faz o merge sem o meu OK)"]);
    }
    expect(title("Quando essa publicação terminar, a sessão envia de novo, roda o CI e publica o gate. Ela não faz o merge sem o meu OK, e o valor padrão \"sem limite\" ainda depende do Osvaldo.")[0]).toMatch(/^Ver: o valor padrão "sem limite"/);
    expect(title("Abri então uma sessão do Claude Code com prioridade Reprovado: \"8204 Reprovado sidebar da fila não reflete no atendimento\". Ela roda sem o app, porque o app está preso reaproveitando uma worktree, e isso já está com o Osvaldo como pendência.")[0]).not.toMatch(/abri/i);
    expect(title("Osvaldo, o Redator KB Nuria mandou o levantamento do que entrou em produção. Ele ainda não consegue publicar artigo nem cadastrar entradas no changelog porque falta acesso, e só você pode liberar.")[0]).toMatch(/^Ver: o Redator KB Nuria ainda não consegue publicar/);
    expect(title("A linha 185 da planilha ainda está incompleta. Isso depende de você no item o1 de \"Precisa de você\": ajustar o corredor (recomendo) ou gravar as três células à mão.")).toEqual(["Ajustar o corredor (recomendo) ou gravar as três células à mão (linha 185)"]);
  });

  it("a fact told in the past is no title, with or without a colon (INSP-R13VIS A4)", () => {
    const origin = { botName: "Monitor", routineName: "R", firstAt: 0, lastAt: 0 };
    const title = (text: string) => routineOwnerAsks(text, ctx).map((ask) => routineAskItem(ask, origin).title);
    expect(title("Fechei a #9403 e isso fica com você.")).toEqual(["Ver: a #9403"]);
    expect(title("O Redator KB Nuria mandou o levantamento e isso fica com você.")).toEqual(["Ver o recado do Monitor na rotina \"R\""]);
  });

  it("a told fact before the colon is no label: what follows is the subject", () => {
    expect(titles("O Filipe respondeu: a linha 110 continua com você.")).toEqual(["routine-ask:linha:110 | Ver: a linha 110"]);
  });

  it("the subject from the paragraph: the sentence before, or the one before it when that one names nothing that agrees", () => {
    expect(titles("A linha 191 ainda está vazia. O Chat ficou quieto a tarde toda. Isso continua com você.")).toEqual(["routine-ask:linha:191 | Ver: a linha 191"]);
    expect(titles("A #9380 voltou para Pendente.\nIsso continua com você.")).toEqual(["routine-ask:issue:9380 | Ver: a #9380"]);
  });

  it("still no subject: whose message it is, in which routine — never a pronoun nobody can place", () => {
    const [ask] = routineOwnerAsks("Ela continua com você.", ctx);
    const item = routineAskItem(ask!, { botName: "Monitor Chat Atendimento", routineName: "Atendimento: Chat, planilha e issues", firstAt: 0, lastAt: 0 });
    expect(item.title).toBe("Ver o recado do Monitor Chat Atendimento na rotina \"Atendimento: Chat, planilha e issues\"");
  });

  it("a decision still asked keeps \"Decidir\"; a label that is no told fact stays the label", () => {
    expect(titles("Uma decisão fica com você: se o Filipe recebe a escala nova.")[0]).toMatch(/\| Decidir: se o Filipe recebe a escala nova$/);
    expect(titles("Escala de sábado do helpdesk: a conversa continua com você.")[0]).toMatch(/\| Ver: escala de sábado do helpdesk$/);
  });
});

// INSP-R13VIS rounds 1-4: every attack phrase, with the items it must open (server/routine-owner-ask.corpus.ts)
describe("the attack corpus", () => {
  const corpusCtx = { ownerName: "Osvaldo", knownNames: ["Chief of Staff", "Monitor Chat Atendimento", "Redator KB Nuria"], itemIds: [] };
  const origin = { botName: "Monitor", routineName: "Atendimento", firstAt: 0, lastAt: 0 };
  it.each(ROUTINE_ASK_CORPUS.map(([round, text, expected, note]) => [round, note ?? "", text, expected] as const))("%s %s: %s", (_round, _note, text, expected) => {
    expect(routineOwnerAsks(text, corpusCtx).map((ask) => routineAskItem(ask, origin).title)).toEqual(expected);
  });

  it("holds every finding's phrases", () => {
    expect(ROUTINE_ASK_CORPUS.length).toBeGreaterThanOrEqual(118);
    expect(new Set(ROUTINE_ASK_CORPUS.map(([, text]) => text)).size).toBe(ROUTINE_ASK_CORPUS.length);
  });
});
