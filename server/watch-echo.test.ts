import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { botMarkPattern, botSlug, isEcho, selfWriteOf, watchKindOf, type SelfWrite } from "./watch-echo.ts";

// The real outputs of the Monitor's watches on 01/10, words pseudonymised
// (same length, same case, same word → same pseudonym; spacing, tabs, line
// breaks, repeated names and the bot's mark exactly as they were):
// `gog sheets get … Atendimento!A1:H400 --plain` — 424 lines, ~108 000
// characters, columns aligned by spaces, no tab — and `gog chat messages
// list … --plain` (TSV RESOURCE SENDER TIME TEXT).
const fixture = (name: string) => readFileSync(new URL(`./testing/fixtures/${name}`, import.meta.url), "utf8").trim().split("\n");
const SHEET = fixture("gog-sheets-plain.txt");
const CHAT = fixture("gog-chat-plain.txt");
const MONITOR = "Monitor Chat Atendimento";
const mark = botMarkPattern(MONITOR, botSlug(MONITOR));
/** Line 422 of the real output: row 178, Status "Pendente", empty Validação, the bot's note in Observações. */
const ROW_178 = SHEET.findLastIndex((line) => line.startsWith("  Oqvnflfa  Neewdoa    Pendente"));
const ROW_180 = SHEET.findLastIndex((line) => line.startsWith("  Dxjlagu   Neewdoa    Pendente"));

/** The sheet with some lines replaced, inserted (index → [line, …]) or removed. */
function edit(lines: readonly string[], changes: Record<number, string[]>): string[] {
  return lines.flatMap((line, i) => changes[i] ?? [line]);
}
/** What the watch sees as new: lines not in the run before. */
const fresh = (before: readonly string[], after: readonly string[]) => after.filter((line) => !before.includes(line));
const sheetEcho = (after: string[], writes: SelfWrite[] = [], previous: string[] | null = SHEET) =>
  isEcho(fresh(SHEET, after), "sheets", writes, 2_000, { mark, previous, current: after }).echo;

describe("the real spreadsheet output (gog --plain, no tabs)", () => {
  it("is the real shape: ~108 000 characters, no tab, the note on the same line as the row's Status", () => {
    expect(SHEET.join("\n").length).toBeGreaterThan(100_000);
    expect(SHEET.some((line) => line.includes("\t"))).toBe(false);
    expect(SHEET[ROW_178]).toContain(`[${MONITOR}] Issue #2800 OPEN`);
  });

  it("wakes the bot for a \"Reprovado\" in the row it annotated (INSP-E A1, INSP-F F4-a)", () => {
    const reproved = SHEET[ROW_178]!.replace("Pendente    Atendimento", "Pendente    Reprovado  Atendimento");
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [reproved] }))).toBe(false);
    // also with a write of the bot in the window, and a day later
    const publicado = selfWriteOf(`gog sheets update SHEET_ID 'Atendimento!E178' --values-json '[["Publicado"]]'`, 1_000)!;
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [reproved] }), [publicado])).toBe(false);
  });

  // the real convention: notes chained in the same cell, " | [Monitor Chat Atendimento] …"
  const NOTE = ` | [${MONITOR}] 01/10 16:10 BRT: sessão aberta`;
  const STARTS_WITH_MARK = SHEET.findIndex((line) => line.startsWith(`[${MONITOR}] `) && line.includes(` | [${MONITOR}] `));

  it("takes a note grown by a new note of the bot, chained with its mark, as its own (INSP-E r2 1)", () => {
    expect(STARTS_WITH_MARK).toBeGreaterThan(0);
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [`${SHEET[ROW_178]}${NOTE}`] }))).toBe(true);
    expect(sheetEcho(edit(SHEET, { [STARTS_WITH_MARK]: [`${SHEET[STARTS_WITH_MARK]}${NOTE}`] }))).toBe(true);
  });

  it("wakes the bot when a person adds to its note, or edits inside it (INSP-E r2 B1)", () => {
    const person = " | Dono 16:40: cliente confirmou que falhou de novo";
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [`${SHEET[ROW_178]}${person}`] }))).toBe(false);
    expect(sheetEcho(edit(SHEET, { [STARTS_WITH_MARK]: [`${SHEET[STARTS_WITH_MARK]}${person}`] }))).toBe(false);
    // a word changed inside the old note (the line still starts with the mark)
    const edited = SHEET[STARTS_WITH_MARK]!.replace(/ BRT: /, " BRT: (corrigido) ");
    expect(edited).not.toBe(SHEET[STARTS_WITH_MARK]);
    expect(sheetEcho(edit(SHEET, { [STARTS_WITH_MARK]: [edited] }))).toBe(false);
  });

  it("takes a new continuation line that starts with its mark as its own", () => {
    expect(sheetEcho(edit(SHEET, { 401: [SHEET[401]!, `[${MONITOR}] 01/10 16:20 BRT: cliente avisada no fio.`] }))).toBe(true);
  });

  it("never takes a new line with the mark in the middle and no line before it", () => {
    expect(sheetEcho([...SHEET, `  Novo  Neewdoa    Pendente    Atendimento: algo novo [${MONITOR}] Issue #1004 OPEN`])).toBe(false);
  });

  it("decides nothing without the complete run before (after a restart): it wakes", () => {
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [`${SHEET[ROW_178]}${NOTE}`] }), [], null)).toBe(false);
  });

  it("wakes when a person removed a line in the same run as the bot's note (INSP-E 9)", () => {
    expect(sheetEcho(edit(SHEET, { 401: [SHEET[401]!, `[${MONITOR}] 01/10 16:20 BRT: nota.`], [ROW_180]: [] }))).toBe(false);
  });

  it("takes a Status the bot set only with its note grown in the same row and run; never Validado/Reprovado (INSP-E r2 2, F4)", () => {
    const fazendo = (i: number, note = "") => `${SHEET[i]!.replace("Pendente    ", "Fazendo     ")}${note}`;
    const write = () => selfWriteOf(`gog sheets update SHEET_ID 'Atendimento!E178' --values-json '[["Fazendo"]]'`, 1_000)!;
    expect(write()).toMatchObject({ kind: "sheets", values: ["fazendo"], via: "shell" });
    // (i) the value written, but no note of the bot in that row: a person could have set it
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [fazendo(ROW_178)] }), [write()])).toBe(false);
    // (ii) with the note "Status → Fazendo" chained in the same run: the bot's
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [fazendo(ROW_178, ` | [${MONITOR}] Status → Fazendo`)] }), [write()])).toBe(true);
    // one write explains one row: the second is a person's
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [fazendo(ROW_178, ` | [${MONITOR}] Status → Fazendo`)], [ROW_180]: [fazendo(ROW_180, ` | [${MONITOR}] Status → Fazendo`)] }), [write()])).toBe(false);
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [fazendo(ROW_178, ` | [${MONITOR}] Status → Fazendo`)] }), [])).toBe(false);
    // (iii) Validado → Reprovado is the requester's, even with a note and a value on record
    const validated = SHEET[ROW_178]!.replace("Pendente    Atendimento", "Publicado   Validado   Atendimento");
    const reproved = `${validated.replace("Validado ", "Reprovado")}${NOTE}`;
    const recorded: SelfWrite = { at: 1_000, kind: "sheets", marks: [], values: ["reprovado"], via: "shell" };
    expect(isEcho([reproved], "sheets", [recorded], 2_000, { mark, previous: edit(SHEET, { [ROW_178]: [validated] }), current: edit(SHEET, { [ROW_178]: [reproved] }) }).echo).toBe(false);
    expect(selfWriteOf(`gog sheets update SHEET_ID 'Atendimento!F178' --values-json '[["Reprovado"]]'`, 1)).toBeNull();
    // a Status changed in a row whose line has no mark (the mark is on a continuation line): it wakes, as before
    const unmarkedStatus = SHEET.findIndex((line) => line.includes("Publicado    Atendimento"));
    expect(unmarkedStatus).toBeGreaterThan(0);
    expect(sheetEcho(edit(SHEET, { [unmarkedStatus]: [SHEET[unmarkedStatus]!.replace("Publicado    ", "Fazendo      ")] }), [write()])).toBe(false);
  });

  it("does not take a quoted value it wrote in one row for the same words a person writes in a row without its mark", () => {
    const write = selfWriteOf(`gog sheets update SHEET_ID 'Atendimento!F170' --values-json '[["Aguardando retorno do cliente"]]'`, 1_000)!;
    expect(write.marks).toEqual([]);
    const person = SHEET.findIndex((line) => line.startsWith("  Karntf"));
    expect(sheetEcho(edit(SHEET, { [person]: [`${SHEET[person]} Aguardando retorno do cliente`] }), [write])).toBe(false);
  });
});

describe("the real Chat output (gog --plain, TSV)", () => {
  // as the Chat shows it: the mention expanded to the full name, then the body
  const posted = "@Fulana de Tal da Silva saiu hoje à tarde a correção do atendimento reaberto";
  const message = (id: string, sender: string, text: string) => `spaces/GSMW4KYdbE4/messages/${id}.${id}\t${sender}\t2026-10-01T13:34:00.000000Z\t${text}`;
  const own = message("nWw1", "Neewdoa Ocex", posted);
  const person = message("nWw2", "Karntf Fhqxr", "obrigada!");
  // newest first: the new message on top, the oldest drops off the end
  const scrolled = (...lines: string[]) => [CHAT[0]!, ...lines, ...CHAT.slice(1, -lines.length)];
  const chatEcho = (after: string[], writes: SelfWrite[]) => isEcho(fresh(CHAT, after), "chat", writes, 2_000, { mark, previous: CHAT, current: after }).echo;

  it("does not recognise a post typed or pasted through the VM: it wakes the bot (INSP-E r2 3, capture off)", () => {
    // the real sequence (clipboard_write URL, hotkey, type_text "@Fulana de Tal", clipboard_write body, press_key) leaves no write
    expect(chatEcho(scrolled(own), [])).toBe(false);
  });

  it("takes the post of a gog chat command by its body, mentions aside, and never a person's message that opens with the same mention", () => {
    const write = selfWriteOf(`gog chat messages send spaces/AAAAexample --text "@Fulana de Tal da Silva saiu hoje à tarde a correção do atendimento reaberto"`, 1_000)!;
    expect(write.marks).toEqual(["saiu hoje à tarde a correção do atendime"]);
    expect(chatEcho(scrolled(own), [write])).toBe(true);
    expect(chatEcho(scrolled(own, person), [write])).toBe(false);
    // someone else calling the same person
    expect(chatEcho(scrolled(message("nWw3", "Dono Exemplo", "@Fulana de Tal da Silva pode confirmar?")), [write])).toBe(false);
    // a person quoting the same words later in their message is not the bot
    expect(chatEcho(scrolled(message("nWw4", "Karntf Fhqxr", `você disse: ${posted}`)), [write])).toBe(false);
    // a mention alone is never a mark
    expect(selfWriteOf(`gog chat messages send spaces/AAAAexample --text "@Fulana de Tal da Silva"`, 1)).toBeNull();
  });
});

describe("issues", () => {
  it("never takes a person's comment for the bot's by a phrase the bot quoted (INSP-E A3)", () => {
    const write = selfWriteOf(`gh issue comment 1001 --body 'Cliente relatou "serviço indisponível" de novo'`, 1_000)!;
    expect(write.marks.every((textMark) => textMark.length > "serviço indisponível".length)).toBe(true);
    const human = '#1001 cliente 4401: aviso de "serviço indisponível" na hora do envio, de novo hoje';
    expect(isEcho([human], "issues", [write], 2_000, { mark, previous: ["#1001 monitor 4400: antes"], current: ["#1001 monitor 4400: antes", human] }).echo).toBe(false);
  });

  it("takes a comment signed with this bot's mark, never another bot's (INSP-E A2)", () => {
    const previous = ["#1002 monitor 4400: Issue registrada"];
    const signed = (slug: string) => `#1002 bot-user 4402: diagnóstico enviado à sessão <!-- bot:${slug} -->`;
    expect(isEcho([signed("monitor-chat-atendimento")], "issues", [], 2_000, { mark, previous, current: [...previous, signed("monitor-chat-atendimento")] }).echo).toBe(true);
    expect(isEcho([signed("qa-prodev")], "issues", [], 2_000, { mark, previous, current: [...previous, signed("qa-prodev")] }).echo).toBe(false);
  });

  it("keeps the words at the end of a gh body, reads through a leading cd, never just the issue number", () => {
    expect(selfWriteOf('cd /Users/owner/wt && gh issue comment 1002 --body "Diagnóstico enviado ao cliente, aguardando retorno dele"', 1)).toMatchObject({ kind: "issues", via: "shell", marks: ["diagnóstico enviado ao cliente, aguardando retorno dele".slice(-40).trim()] });
    expect(selfWriteOf("gh issue comment 1002 --body-file /tmp/x.md", 1)).toBeNull();
    expect(selfWriteOf("gh issue view 1003", 1)).toBeNull();
    // nothing but a link: no words to recognise it by
    expect(selfWriteOf("gh issue comment 1002 --body 'https://github.com/example-org/example-repo/pull/1234'", 1)).toBeNull();
  });

  it("matches a body's end at the end of the comment, without its URL: a person citing the same PR wakes (INSP-E r2 4)", () => {
    const write = selfWriteOf("gh issue comment 1002 --body 'Correção publicada em produção, veja https://github.com/example-org/example-repo/pull/1234'", 1_000)!;
    expect(write.marks).toEqual(["correção publicada em produção, veja"]);
    const previous = ["#1002 monitor 4400: Issue registrada"];
    const own = "#1002 bot-user 4403: Correção publicada em produção, veja https://github.com/example-org/example-repo/pull/1234";
    const human = "#1002 cliente 4404: ainda falha, veja https://github.com/example-org/example-repo/pull/1234";
    expect(isEcho([own], "issues", [write], 2_000, { mark, previous, current: [...previous, own] }).echo).toBe(true);
    expect(isEcho([human], "issues", [write], 2_000, { mark, previous, current: [...previous, human] }).echo).toBe(false);
  });

  it("knows what a watch reads", () => {
    expect(watchKindOf(["gh", "issue", "list", "--search", "sort:updated-desc"])).toBe("issues");
    expect(watchKindOf(["gog", "chat", "messages", "list", "spaces/AAQ"])).toBe("chat");
    expect(watchKindOf(["gog", "sheets", "get", "SHEET_ID", "Atendimento!A1:H400", "--plain"])).toBe("sheets");
    expect(watchKindOf(["git", "ls-remote", "origin"])).toBeNull();
  });
});
