import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotAutonomy, OWNER_PENDING_MAX_PER_THREAD } from "./bot-autonomy.ts";
import { applyRoutineAsks, keepRoutineAsk, markStaleRoutineAsks, ownerAnswerCloses, ownerSettlesRoutineAsks, ROUTINE_ASK_KEEP_LABEL, ROUTINE_ASK_LET_GO_MS, ROUTINE_ASK_OWNER_THREAD_NOTE, ROUTINE_ASK_SETTLED_MS, routineAskKey, routineAskTitle, routineOwnerAsks, routineReplyText, saysRoutineAskResolved, settleRoutineAsks } from "./routine-owner-ask.ts";

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

  it("F2: the owner doing what the item asked, in a conversation with the bot, closes it as theirs (real 30/09 16:12)", () => {
    const ledger = make();
    const opened = run(ledger, PARADO).opened;
    expect(opened.map((each) => each.title)).toEqual(["Ver: três vigias permanentes (Chat, planilha e issues)", "Ver: regras de 30/09 na minha memória permanente"]);
    // a question about it, or an earlier message, closes nothing
    expect(ownerSettlesRoutineAsks(ledger, "monitor", [{ at: now + 60_000, text: "O que são os três vigias permanentes?" }, { at: now - 60_000, text: ARMED }])).toEqual([]);
    const done = ownerSettlesRoutineAsks(ledger, "monitor", [{ at: now + 3 * 60_000, text: ARMED }]);
    expect(done.map((each) => each.id)).toEqual([opened[0]!.id]);
    expect(ledger.resolvedOwnerPendingOf("monitor")[0]).toMatchObject({ resolvedBy: "owner", resolvedNote: ROUTINE_ASK_OWNER_THREAD_NOTE });
    // the rules: still open
    expect(ledger.ownerPendingOf("monitor").map((each) => each.id)).toEqual([opened[1]!.id]);
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
