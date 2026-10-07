import { describe, expect, it } from "vitest";
import { FIXED_ROW_STALE_MS, fixedRowWarning, itemRowWrites, plainRowCells, rowVerdict, rowWrites, supersededItems, supersededLine, supersedeRefs } from "./owner-pending-guard.ts";

// R13-intake #1, with the items of 05/10 and 06/10 (messages.db): the Chief's o2
// (20:57Z) with five fixed-row commands for row 190, and the Monitor's o1 rewritten
// at 13:10:32Z saying those commands must not run — the o2 kept offering them.
const SHEET = "163U0o9RWFKqikUNsJu6T3tG1rP_3Mn3STZ1W6uYMDPQ";
const cmd = (range: string, values: string) => `gog sheets update ${SHEET} 'Atendimento!${range}' --values-json '${values}' --input RAW --account osvaldo@crmpiperun.com --no-input`;
const o2 = {
  botId: "chief", id: "o2", createdAt: Date.parse("2026-10-05T20:57:23Z"),
  title: "Aprovar a criação da linha 190 da planilha (127138 do Matheus, #9384)",
  why: "A linha 189 já era a do Yuri (#9382), e os comandos aprovados iriam apagá-la. O Monitor parou sem gravar nada. A primeira linha livre é a 190, e o Jev negou o B190 às 17:55.",
  link: "https://github.com/dinhogehm/nuria-platform/issues/9384",
  steps: [
    { text: "No seu terminal, aprove os 5 comandos com o approve, um por célula (formato --values-json, que não divide na vírgula)." },
    { text: "B190", command: cmd("B190", '[["Matheus"]]') },
    { text: "C190", command: cmd("C190", '[["Osvaldo"]]') },
    { text: "E190 (o Status da planilha é Pendente, Fazendo ou Publicado)", command: cmd("E190", '[["Pendente"]]') },
    { text: "G190", command: cmd("G190", '[["Helpdesk: mensagem nova de contato caiu no ticket antigo 127138 importado do Movidesk que aparece Resolvido"]]') },
    { text: "H190", command: cmd("H190", '[["[Monitor Chat Atendimento] Issue #9384 — https://github.com/dinhogehm/nuria-platform/issues/9384 · Chat 05/10 17:20 BRT (conversa wwiZmkbi-aI)"]]') },
  ],
};
const o1 = {
  botId: "monitor", id: "o1", createdAt: Date.parse("2026-10-05T17:40:00Z"),
  title: "Criar a linha 191 da planilha para a #9384 (Matheus, ticket 127138)",
  why: "A linha 190 agora é da Marluce (#9389), criada pelo Chief às 10:09. Os comandos antigos para a linha 190 apagariam a linha dela: não rode esses. O pedido do Matheus continua sem linha.",
  steps: [
    { text: "Solicitante e responsável (um comando por vez, aspas simples no range)", command: cmd("B191:C191", '[["Matheus","Osvaldo"]]') },
    { text: "Status", command: cmd("E191", '[["Pendente"]]') },
  ],
};
const names = ["Chief of Staff", "Monitor Chat Atendimento"];
const first = (botId: string) => (botId === "chief" ? "Chief" : "Monitor");

describe("an item that says another item's commands must not run (R13-intake #1)", () => {
  it("reads the Monitor's o1 of 13:10 as superseding row 190, and marks the Chief's o2 — never itself", () => {
    const refs = supersedeRefs(o1, names);
    expect(refs).toEqual([{ ids: [], rows: [190], issues: [], bots: [], text: "Os comandos antigos para a linha 190 apagariam a linha dela: não rode esses." }]);
    const at = Date.parse("2026-10-06T13:10:32Z");
    const hits = supersededItems({ botId: "monitor", id: "o1", at }, refs, [o2, o1], first);
    expect(hits.map((hit) => `${hit.item.botId}/${hit.item.id}`)).toEqual(["chief/o2"]);
    expect(supersededLine({ botId: "monitor", botName: "Monitor Chat Atendimento", id: "o1", at, text: hits[0]!.text })).toBe("Superado pelo o1 do Monitor Chat Atendimento: «Os comandos antigos para a linha 190 apagariam a linha dela: não rode esses.». Não rode os comandos deste item; veja o o1.");
    // already marked by it: not again
    expect(supersededItems({ botId: "monitor", id: "o1", at }, refs, [{ ...o2, supersededBy: { botId: "monitor", id: "o1" } }], first)).toEqual([]);
  });

  it("does not take a warning about its own past, or words without a target, as superseding", () => {
    // the o2's own why: "os comandos aprovados iriam apagá-la" — no superseding words
    expect(supersedeRefs(o2, names)).toEqual([]);
    expect(supersedeRefs({ title: "Conferir a planilha", why: "Não rode nada sem me avisar." }, names)).toEqual([]);
    // the o28 of 06/10 (disk): commands, but nothing superseded
    expect(supersedeRefs({ title: "Decidir o destino de 15 worktrees paradas", steps: [{ text: "Para remover uma worktree que você decidir descartar (sem --force; falha se houver alteração)" }] }, names)).toEqual([]);
  });

  it("an id names the same bot's item, or the item of the bot it names", () => {
    const chiefO2 = o2;
    const monitorO2 = { ...o2, botId: "monitor", title: "Outro item do Monitor", steps: [{ text: "x", command: cmd("B150", '[["x"]]') }] };
    const by = { botId: "monitor", id: "o9", at: Date.now() };
    const named = supersedeRefs({ title: "Gravar a linha 193", why: "O o2 do Chief está obsoleto." }, names);
    expect(named[0]!.bots).toEqual(["chief"]);
    expect(supersededItems(by, named, [chiefO2, monitorO2], first).map((hit) => hit.item.botId)).toEqual(["chief"]);
    const own = supersedeRefs({ title: "Gravar a linha 193", why: "O o2 foi substituído por este." }, names);
    expect(supersededItems(by, own, [chiefO2, monitorO2], first).map((hit) => hit.item.botId)).toEqual(["monitor"]);
    // by the issue: only an item that carries commands
    const issue = supersedeRefs({ title: "x", why: "Os comandos da #9384 estão errados." }, names);
    expect(supersededItems(by, issue, [chiefO2, { ...chiefO2, id: "o7", steps: [{ text: "Leia a #9384" }] }], first).map((hit) => hit.item.id)).toEqual(["o2"]);
  });
});

describe("fixed sheet rows in an item's commands (R13-intake #1)", () => {
  it("reads the row, the columns and the values a command writes; an append has no fixed row", () => {
    expect(rowWrites(o1.steps[0]!.command!)).toEqual([{ sheetId: SHEET, tab: "Atendimento", row: 191, cells: { B: "Matheus", C: "Osvaldo" }, account: "osvaldo@crmpiperun.com" }]);
    expect(itemRowWrites(o2).map((write) => `${Object.keys(write.cells)[0]}${write.row}`)).toEqual(["B190", "C190", "E190", "G190", "H190"]);
    expect(rowWrites(`gog sheets append ${SHEET} 'Atendimento!B:I' --values-json '[["a"]]'`)).toEqual([]);
  });

  it("warns after 6 h, and says what the row holds when the server read it", () => {
    const answeredAt = Date.parse("2026-10-06T14:00:50Z");
    expect(fixedRowWarning(o2, o2.createdAt + FIXED_ROW_STALE_MS - 1)).toBeNull();
    expect(fixedRowWarning(o2, answeredAt)).toBe("A linha 190 pode ter mudado desde que estes comandos foram escritos: confira antes de rodar.");
    // the CSV the Monitor read at 13:08:36Z: the client's own row
    const row = plainRowCells(["", "Marluce", "Osvaldo", "", "Pendente", "", "Permitir minutos nessa configuração…"].join("\t") + "\n");
    const verdict = rowVerdict(itemRowWrites(o2)[0]!, row);
    expect(verdict).toEqual({ verdict: "ocupada", holds: ["B «Marluce»"] });
    expect(rowVerdict(itemRowWrites(o2)[3]!, row)).toEqual({ verdict: "ocupada", holds: ["G «Permitir minutos nessa configuração…»"] });
    expect(rowVerdict(itemRowWrites(o2)[1]!, row)).toBe("igual");
    expect(rowVerdict(itemRowWrites(o2)[0]!, plainRowCells("\n"))).toBe("vazia");
    const checked = { ...o2, rowCheck: { at: Date.parse("2026-10-06T13:30:00Z"), tab: "Atendimento", row: 190, verdict: "ocupada" as const, holds: ["B «Marluce»"] } };
    expect(fixedRowWarning(checked, answeredAt)).toBe("A linha 190 pode ter mudado desde que estes comandos foram escritos: confira antes de rodar. Lida às 10:30: a linha 190 já tem B «Marluce»: os comandos sobrescreveriam isso.");
    // rewritten by its bot: counted from then
    expect(fixedRowWarning({ ...o2, updatedAt: answeredAt - 3_600_000 }, answeredAt)).toBeNull();
  });
});
