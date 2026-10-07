import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkItemRows, FIXED_ROW_STALE_MS, fixedRowWarning, itemRows, itemRowWrites, jsonRows, ROW_CHECK_EVERY_MS, RowCheckBackoff, rowVerdict, rowWrites, supersededItems, supersededLine, supersedeRefs, type RowCheck } from "./owner-pending-guard.ts";

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
    expect(supersededLine({ botId: "monitor", botName: "Monitor Chat Atendimento", id: "o1", at, text: hits[0]!.text })).toBe("Superado pelo item o1 do Monitor Chat Atendimento: «Os comandos antigos para a linha 190 apagariam a linha dela: não rode esses.». Não rode os comandos deste item; veja o o1.");
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

  it("an id names the same bot's item — by its own name too — or the item of the bot it names", () => {
    const monitorO2 = { ...o2, botId: "monitor", title: "Outro item do Monitor", steps: [{ text: "x", command: cmd("B150", '[["x"]]') }] };
    const by = { botId: "monitor", id: "o9", at: Date.now() };
    const named = supersedeRefs({ title: "Gravar a linha 193", why: "O o2 do Chief está obsoleto." }, names);
    expect(named[0]!.bots).toEqual(["chief"]);
    expect(supersededItems(by, named, [o2, monitorO2], first).map((hit) => hit.item.botId)).toEqual(["chief"]);
    const own = supersedeRefs({ title: "Gravar a linha 193", why: "O o2 foi substituído por este." }, names);
    expect(supersededItems(by, own, [o2, monitorO2], first).map((hit) => hit.item.botId)).toEqual(["monitor"]);
    // INSP-R13fol #17: the Chief naming its own o2 marks it
    const self = supersedeRefs({ title: "Gravar a linha 193", why: "O o2 do Chief está obsoleto." }, names);
    expect(supersededItems({ botId: "chief", id: "o9", at: Date.now() }, self, [o2], first).map((hit) => hit.item.id)).toEqual(["o2"]);
    // by the issue: only "comandos da #N", and only an item that carries commands
    const issue = supersedeRefs({ title: "x", why: "Os comandos da #9384 estão errados." }, names);
    expect(issue[0]!.issues).toEqual([9384]);
    expect(supersededItems(by, issue, [o2, { ...o2, id: "o7", steps: [{ text: "Leia a #9384" }] }], first).map((hit) => hit.item.id)).toEqual(["o2"]);
  });

  it("never marks a server's item, nor reads an approval, an order or a replacement as superseding (INSP-R13fol #13, #14)", () => {
    const at = Date.now();
    // a disk item of the server, and the power item: they have a key
    const disk = { ...o2, id: "o40", key: "disk-decision:503-atendimento-helpdesk-2785c8" };
    const power = { ...o2, id: "o41", key: "power:plug" };
    for (const words of ["O o40 está obsoleto.", "O o40 do Chief está obsoleto, não use.", "O o41 está superado."]) {
      expect(supersededItems({ botId: "chief", id: "o9", at }, supersedeRefs({ title: "x", why: words }, names), [disk, power], first), words).toEqual([]);
      expect(supersededItems({ botId: "monitor", id: "o9", at }, supersedeRefs({ title: "x", why: words }, names), [disk, power], first), words).toEqual([]);
    }
    // the Chief's item of 04/10 20:15Z: the PR it closes is replaced by #9371 — the merge of #9371 must not go off
    const merge = { botId: "chief", id: "o5", createdAt: at - 1, title: "Fazer o merge da PR #9371", steps: [{ text: "Merge", command: "gh pr merge 9371 --squash" }] };
    expect(supersedeRefs({ title: "Fechar a PR #9332 (substituída pela #9371)", why: "A #9371 leva a mesma correção." }, names)).toEqual([]);
    expect(supersededItems({ botId: "chief", id: "o4", at }, supersedeRefs({ title: "Fechar a PR #9332 (substituída pela #9371)" }, names), [merge], first)).toEqual([]);
    // an order about approvals is not about commands
    expect(supersedeRefs({ title: "x", why: "Não aprove a #9371 antes do QA." }, names)).toEqual([]);
    // a row named without speaking of commands
    expect(supersedeRefs({ title: "x", why: "A linha 190 está obsoleta." }, names)).toEqual([]);
  });
});

describe("fixed sheet rows in an item's commands (R13-intake #1)", () => {
  it("reads the row, the columns and the values a command writes; a tab with spaces; an append has no fixed row", () => {
    expect(rowWrites(o1.steps[0]!.command!)).toEqual([{ sheetId: SHEET, tab: "Atendimento", row: 191, cells: { B: "Matheus", C: "Osvaldo" }, account: "osvaldo@crmpiperun.com" }]);
    expect(itemRowWrites(o2).map((write) => `${Object.keys(write.cells)[0]}${write.row}`)).toEqual(["B190", "C190", "E190", "G190", "H190"]);
    expect(itemRows(o2)).toHaveLength(1);
    expect(Object.keys(itemRows(o2)[0]!.cells)).toEqual(["B", "C", "E", "G", "H"]);
    expect(rowWrites(`gog sheets update ${SHEET} 'Base de Dados!B5' --values-json '[["x"]]'`)).toEqual([{ sheetId: SHEET, tab: "Base de Dados", row: 5, cells: { B: "x" } }]);
    expect(rowWrites(`gog sheets append ${SHEET} 'Atendimento!B:I' --values-json '[["a"]]'`)).toEqual([]);
  });

  it("reads gog's real --json output, a cell with line breaks included, and never takes an unreadable one as empty (INSP-R13fol #12)", () => {
    // `gog sheets get 163U…YMDPQ 'Atendimento!A120:Z120' --json`, read once on 07/10 (server/fixtures)
    const real = readFileSync(join(import.meta.dirname, "fixtures", "gog-sheets-get-atendimento-row120.json"), "utf8");
    const rows = jsonRows(real, 120, 120)!;
    const cells = rows.get(120)!;
    expect(cells.slice(1, 5)).toEqual(["Matheus", "Osvaldo", "15/09/2026 01:18", "Publicado"]);
    expect(cells[6]).toContain("se você preencher\nalguns campo");
    const bc = rowWrites(cmd("B120:C120", '[["Matheus","Osvaldo"]]'))[0]!;
    expect(rowVerdict(bc, cells)).toBe("igual");
    const h = rowWrites(cmd("H120", '[["[Monitor] outra coisa"]]'))[0]!;
    expect(rowVerdict(h, cells)).toEqual({ verdict: "ocupada", holds: [expect.stringMatching(/^H «Fix da #8802 publicado na PR #8844/)] });
    // an empty range has no "values": empty, as the Sheets API says it; past the last filled row too
    expect(jsonRows('{"range":"Atendimento!A900:Z900"}', 900, 900)!.get(900)).toEqual([]);
    expect(jsonRows(real, 120, 121)!.get(121)).toEqual([]);
    // the --plain output (columns aligned with spaces, no tabs) and garbage are not read
    expect(jsonRows(`${" ".repeat(96)}Matheus   Osvaldo   15/09/2026 01:18   Publicado\n`, 120, 120)).toBeNull();
    expect(jsonRows('{"values":[["a"]]}', 120, 120)).toBeNull();
    expect(jsonRows("", 120, 120)).toBeNull();
  });

  it("warns after 6 h, and says what each row holds — or that it could not be read, never \"vazia\"", () => {
    const answeredAt = Date.parse("2026-10-06T14:00:50Z");
    expect(fixedRowWarning(o2, o2.createdAt + FIXED_ROW_STALE_MS - 1)).toBeNull();
    expect(fixedRowWarning(o2, answeredAt)).toBe("A linha 190 pode ter mudado desde que estes comandos foram escritos: confira antes de rodar.");
    const occupied: RowCheck = { at: Date.parse("2026-10-06T13:30:00Z"), tab: "Atendimento", row: 190, verdict: "ocupada", holds: ["B «Marluce»"] };
    expect(fixedRowWarning({ ...o2, rowChecks: [occupied] }, answeredAt)).toBe("A linha 190 pode ter mudado desde que estes comandos foram escritos: confira antes de rodar. Lida às 10:30: a linha 190 já tem B «Marluce»: os comandos sobrescreveriam isso.");
    const unknown: RowCheck = { ...occupied, verdict: "desconhecida" };
    delete unknown.holds;
    expect(fixedRowWarning({ ...o2, rowChecks: [unknown] }, answeredAt)).toBe("A linha 190 pode ter mudado desde que estes comandos foram escritos: confira antes de rodar. Às 10:30 não consegui conferir a linha 190.");
    // two rows: both said
    const two = { ...o1, createdAt: o2.createdAt, steps: [...o1.steps, { text: "H192", command: cmd("H192", '[["x"]]') }] };
    expect(fixedRowWarning({ ...two, rowChecks: [{ ...occupied, row: 191, verdict: "vazia" }, { ...occupied, row: 192 }] }, answeredAt)).toBe("As linhas 191, 192 podem ter mudado desde que estes comandos foram escritos: confira antes de rodar. Lida às 10:30: a linha 191 está vazia onde os comandos escrevem. Lida às 10:30: a linha 192 já tem B «Marluce»: os comandos sobrescreveriam isso.");
    // rewritten by its bot: counted from then
    expect(fixedRowWarning({ ...o2, updatedAt: answeredAt - 3_600_000 }, answeredAt)).toBeNull();
  });
});

describe("reading the rows, with backoff when gog fails (INSP-R13fol #15, #17)", () => {
  const item = { ...o1, createdAt: Date.parse("2026-10-06T00:00:00Z"), steps: [...o1.steps, { text: "H192", command: cmd("H192", '[["x"]]') }] };
  const start = item.createdAt + FIXED_ROW_STALE_MS + 1;

  it("a failing gog is asked 8 times in 2 h of 10 s ticks, not 720, with one log line per change of state", async () => {
    const backoff = new RowCheckBackoff();
    const calls: string[][] = [];
    const logs: string[] = [];
    const saved: RowCheck[][] = [];
    let ok = false;
    const tick = (now: number) => checkItemRows([item], {
      now, backoff,
      gog: async (args) => { calls.push(args); return ok ? { out: '{"range":"Atendimento!A191:Z192","values":[["","Matheus","Osvaldo"]]}' } : { out: null, error: "token expired" }; },
      save: (_item, checks) => saved.push(checks),
      log: (line) => logs.push(line),
    });
    for (let t = 0; t < 2 * 3_600_000; t += 10_000) await tick(start + t);
    expect(calls).toHaveLength(8);
    // one read for both rows of the tab, as JSON
    expect(calls[0]).toEqual(["sheets", "get", SHEET, "Atendimento!A191:Z192", "--json", "--no-input", "--account", "osvaldo@crmpiperun.com"]);
    expect(logs).toEqual(["[owner-pending] monitor/o1: the row could not be read (token expired); next try in 1 min, at most every 30 min"]);
    // a failure is "desconhecida" for every row, never "vazia"
    expect(saved.at(-1)!.map((check) => `${check.row}:${check.verdict}`)).toEqual(["191:desconhecida", "192:desconhecida"]);
    // gog back: read, said once, and then every 30 min
    ok = true;
    const back = start + 2 * 3_600_000 + 30 * 60_000;
    await tick(back);
    expect(calls).toHaveLength(9);
    expect(logs.at(-1)).toBe("[owner-pending] monitor/o1: the row is read again");
    expect(saved.at(-1)!.map((check) => `${check.row}:${check.verdict}`)).toEqual(["191:parcial", "192:vazia"]);
    for (let t = 10_000; t < ROW_CHECK_EVERY_MS; t += 10_000) await tick(back + t);
    expect(calls).toHaveLength(9);
    await tick(back + ROW_CHECK_EVERY_MS);
    expect(calls).toHaveLength(10);
    expect(logs).toHaveLength(2);
  });

  it("does not read a recent item, a superseded one, or one without fixed rows", async () => {
    const calls: string[][] = [];
    const deps = { now: start, backoff: new RowCheckBackoff(), gog: async (args: string[]) => { calls.push(args); return { out: null }; }, save: () => undefined, log: () => undefined };
    await checkItemRows([{ ...item, createdAt: start - 1 }, { ...item, id: "o3", supersededBy: { botId: "chief" } }, { ...item, id: "o4", steps: [{ text: "x", command: `gog sheets append ${SHEET} 'Atendimento!B:I'` }] }], deps);
    expect(calls).toEqual([]);
  });
});
