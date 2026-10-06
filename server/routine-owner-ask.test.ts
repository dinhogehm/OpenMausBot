import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotAutonomy } from "./bot-autonomy.ts";
import { applyRoutineAsks, ROUTINE_ASK_SETTLED_MS, routineOwnerAsks, routineReplyText, saysRoutineAskResolved, settleRoutineAsks } from "./routine-owner-ask.ts";

// The Monitor's routine "Atendimento: Chat, planilha e issues", 05/10 09:00 (R12-visual N22), as it wrote it.
const MONITOR_0510 = [
  "Passada das 10h sem novidade. Não postei nada no Chat, não mexi na planilha e não avisei o Chief of Staff.",
  "",
  "- **Chat:** a mensagem mais recente ainda é a do Filipe Migon às 8:58, \"Top, corrigido o problema então\". Ela veio depois de o Matheus confirmar a #9295 e já foi tratada na passada das 9h; não pede nada. A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.",
  "- **Planilha:** nada mudou desde a cópia das 8h.",
  "- **GitHub:** nenhuma issue foi criada nem atualizada em `dinhogehm/nuria-platform` desde as 8h.",
].join("\n");
const BOTS = ["Monitor Chat Atendimento", "Chief of Staff"];
const ctx = { ownerName: "Osvaldo", knownNames: BOTS };

describe("routineOwnerAsks: what a routine leaves with the owner", () => {
  it("the Monitor's real reply of 05/10: one ask, about the Luis Rossi conversation in the widget", () => {
    const asks = routineOwnerAsks(MONITOR_0510, ctx);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ subject: { kind: "pessoa", id: "luis-rossi" }, person: { name: "Luis Rossi", article: "o" }, context: "widget" });
    expect(asks[0]!.sentence).toBe("A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.");
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

  it.each([
    ["a denial", "Esse trabalho já é meu e não depende de você."],
    ["a denial by name", "Não depende do Osvaldo: eu mesmo abro a issue."],
    ["a quote", "O Filipe escreveu no Chat: \"isso continua com você, Osvaldo\". Já respondi."],
    ["a quoted block", "O Chief disse:\n> A conversa do widget continua com você.\nNada mudou desde então."],
    ["an echo of an item the owner has", "A linha 179 segue esperando a sua decisão em \"Precisa de você\" (item o14)."],
    ["a sentence with no one waiting", "Passada concluída. Não havia nada novo, então não postei nada nem mexi na planilha."],
    // the Chief's real lines of the week: the new phrases under "nada" deny it
    ["nothing waits", "Osvaldo, não tem nada esperando por você agora."],
    ["none of it depends", "Nada disso depende de você."],
  ])("never: %s", (_label, text) => {
    expect(routineOwnerAsks(text, { ...ctx, itemIds: ["o14"] })).toEqual([]);
  });

  it("a list it leads is the ask, said in the title (the Monitor's real 02/10 15:00)", () => {
    const text = [
      "- **Chat:** não postei. O Chief sugeriu abrir uma conversa nova com ele para confirmar o recebimento e pedir os filtros e o print, mas preferi deixar essa decisão com você.",
      "",
      "Preciso da sua decisão em duas coisas:",
      "1. Posso escrever o número da issue nas Observações da linha 110, depois do texto do Filipe? Isso depende de você confirmar.",
      "2. Abro uma conversa nova com o Filipe no Chat para pedir os filtros e o print?",
    ].join("\n");
    const asks = routineOwnerAsks(text, ctx);
    // asks without a subject in one reply are one
    expect(asks).toHaveLength(1);
    expect(asks[0]!.what).toBe("Posso escrever o número da issue nas Observações da linha 110, depois do texto do Filipe?");
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

describe("saysRoutineAskResolved: the bot says it is done", () => {
  const luis = { key: "routine-ask:pessoa:luis-rossi", title: "Responder ao Luis Rossi (widget)", why: "Monitor Chat Atendimento, na rotina \"Atendimento\", escreveu: \"A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.\" Disse isso às 09:00 de 05/10." };
  it("closes on the bot's word for done about the same subject", () => {
    expect(saysRoutineAskResolved(luis, "Respondi ao Luis Rossi no widget; a conversa está resolvida.")).toBe(true);
    expect(saysRoutineAskResolved(luis, "A conversa do widget com o Luis Rossi não está mais com você.")).toBe(true);
  });
  it("never under a negation, a condition, a quote, nor while asking again", () => {
    expect(saysRoutineAskResolved(luis, "A conversa do widget com o Luis Rossi ainda não foi resolvida.")).toBe(false);
    expect(saysRoutineAskResolved(luis, "O widget do Luis Rossi só fecha quando você confirmar que foi resolvido.")).toBe(false);
    expect(saysRoutineAskResolved(luis, "O Matheus escreveu: \"o widget do Luis Rossi está resolvido\".")).toBe(false);
    expect(saysRoutineAskResolved(luis, "A conversa do widget com o Luis Rossi continua com você; o resto foi resolvido.")).toBe(false);
  });
  it("a person named in passing is not the ask (the Monitor's real lines of 30/09 and 01/10)", () => {
    const marluce = { key: "routine-ask:pessoa:marluce", title: "Decidir: se o que a Marluce espera…", why: "X, na rotina \"Y\", escreveu: \"Uma decisão fica com você: se o que a Marluce espera, tickets distribuídos fora do horário do chat, vira mudança de regra ou só ajuste na grade de horário do helpdesk.\" Disse isso às 12:00 de 30/09." };
    expect(saysRoutineAskResolved(marluce, "A 177 só muda quando a Marluce confirmar que o ajuste resolveu, ou quando você decidir encerrar.")).toBe(false);
    expect(saysRoutineAskResolved(marluce, "- **Ponto de atenção:** antes de mim, às 16:28, a Marluce Oliveira tinha respondido só \"sim\", e a Daiane curtiu.")).toBe(false);
    expect(saysRoutineAskResolved(marluce, "| Ticket criado de chat grava o nome de quem falou (PR #9316) | #9311, fechada | Marluce | 176 |")).toBe(false);
  });
  it("what was asked, done: the 0042's issue opened (the Monitor's real 03/10)", () => {
    const ticket = { key: "routine-ask:ticket:atd-202610-0042", title: "A abertura da issue do ATD-202610-0042…", why: "X, na rotina \"Y\", escreveu: \"Ainda dependem do Osvaldo: a abertura da issue do ATD-202610-0042 e, com ela, a linha dele na planilha.\" Disse isso às 16:00 de 01/10." };
    expect(saysRoutineAskResolved(ticket, "- **#9364 (ATD-202610-0042 reabre e encerra de novo) e #9365 (aviso vermelho de assentos e fila esvaziada):** as duas da Daiane, abertas às 09:36 na minha outra conversa com o Chief.")).toBe(true);
    expect(saysRoutineAskResolved(ticket, "- Issue (a): o ATD-202610-0042 é reaberto e logo encerra de novo.")).toBe(false);
  });
});

describe("applyRoutineAsks: one item per subject, in the ledger", () => {
  let dir: string;
  let now: number;
  const make = () => new BotAutonomy({ path: join(dir, "bot-autonomy.json"), now: () => now });
  const run = (ledger: BotAutonomy, text: string) => applyRoutineAsks(ledger, { botId: "monitor", botName: "Monitor Chat Atendimento", routineName: "Atendimento: Chat, planilha e issues", threadId: "results", conversationTitle: "Atendimento: Chat, planilha e issues", text, at: now, ...ctx });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-routine-ask-"));
    now = new Date(2026, 9, 5, 9, 0).getTime();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the hourly repetition refreshes the one item: same id, same title, why says since when", () => {
    const ledger = make();
    const first = run(ledger, MONITOR_0510);
    expect(first.opened).toHaveLength(1);
    const item = first.opened[0]!;
    expect(item).toMatchObject({ id: "o1", threadId: "results", key: "routine-ask:pessoa:luis-rossi", title: "Responder ao Luis Rossi (widget)" });
    expect(item.why).toBe("Monitor Chat Atendimento, na rotina \"Atendimento: Chat, planilha e issues\", escreveu: \"A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.\" Disse isso às 09:00 de 05/10.");
    expect(item.steps?.map((step) => step.text)).toEqual([
      "Veja o contexto na conversa \"Atendimento: Chat, planilha e issues\" de Monitor Chat Atendimento.",
      "Resolva com o Luis Rossi o que ficou com você.",
      "Responda aqui o que fez ou decidiu: o item fecha com a sua resposta, ou quando o bot disser que resolveu.",
    ]);
    expect(item.options?.map((option) => option.label)).toEqual(["Já resolvi"]);
    now += 3_600_000;
    // reworded, the same person: the same item
    const second = run(ledger, "Passada das 11h sem novidade. A conversa do widget com o Luis Rossi continua com você.");
    now += 3_600_000;
    const third = run(make(), MONITOR_0510);
    expect([second.opened, third.opened]).toEqual([[], []]);
    expect(third.refreshed.map((each) => each.id)).toEqual(["o1"]);
    const open = make().ownerPendingOf("monitor");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: "o1", title: "Responder ao Luis Rossi (widget)" });
    expect(open[0]!.why).toContain("Repete isso desde as 09:00 de 05/10; a última vez foi às 11:00 de 05/10.");
  });

  it("silence never closes it; the bot's word does, and a new ask after gets a new id", () => {
    const ledger = make();
    run(ledger, MONITOR_0510);
    now += 30 * 3_600_000;
    expect(run(ledger, "Passada concluída. Não havia nada novo.").resolved).toEqual([]);
    expect(ledger.ownerPendingOf("monitor").map((each) => each.id)).toEqual(["o1"]);
    const done = settleRoutineAsks(ledger, "monitor", "Respondi ao Luis Rossi no widget; a conversa está resolvida.");
    expect(done.map((each) => each.id)).toEqual(["o1"]);
    expect(ledger.resolvedOwnerPendingOf("monitor")[0]).toMatchObject({ id: "o1", resolvedBy: "bot", resolvedNote: "o bot disse que resolveu" });
    // ownerPendingSeq: a settled o1 is never a new item's id
    expect(run(make(), MONITOR_0510).opened.map((each) => each.id)).toEqual(["o2"]);
  });

  it("answered by the owner: the routine repeating what it read before does not reopen it for 24 h", () => {
    const ledger = make();
    const [item] = run(ledger, MONITOR_0510).opened;
    ledger.resolveOwnerPending({ botId: "monitor", id: item!.id, by: "owner" });
    now += 3_600_000;
    expect(run(ledger, MONITOR_0510).opened).toEqual([]);
    now += ROUTINE_ASK_SETTLED_MS;
    expect(run(ledger, MONITOR_0510).opened.map((each) => each.id)).toEqual(["o2"]);
  });

  it("a bot's own item on the same person already asks it", () => {
    const ledger = make();
    ledger.addOwnerPending("monitor", "results", { title: "Falar com o Luis Rossi sobre o widget" });
    expect(run(ledger, MONITOR_0510)).toMatchObject({ opened: [], refreshed: [] });
  });
});
