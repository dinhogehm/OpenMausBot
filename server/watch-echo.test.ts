import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { botMarkPattern, botSlug, isEcho, selfWriteOf, urlOfToolCall, vmWriteOf, watchKindOf, type SelfWrite } from "./watch-echo.ts";

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

  it("takes only what follows the bot's mark changing as its own note", () => {
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [`${SHEET[ROW_178]} · 01/10 16:10 BRT: sessão aberta`] }))).toBe(true);
  });

  it("takes a new continuation line that starts with its mark as its own", () => {
    expect(sheetEcho(edit(SHEET, { 401: [SHEET[401]!, `[${MONITOR}] 01/10 16:20 BRT: cliente avisada no fio.`] }))).toBe(true);
  });

  it("never takes a new line with the mark in the middle and no line before it", () => {
    expect(sheetEcho([...SHEET, `  Novo  Neewdoa    Pendente    Atendimento: algo novo [${MONITOR}] Issue #1004 OPEN`])).toBe(false);
  });

  it("decides nothing without the complete run before (after a restart): it wakes", () => {
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [`${SHEET[ROW_178]} · nota`] }), [], null)).toBe(false);
  });

  it("wakes when a person removed a line in the same run as the bot's note (INSP-E 9)", () => {
    expect(sheetEcho(edit(SHEET, { 401: [SHEET[401]!, `[${MONITOR}] 01/10 16:20 BRT: nota.`], [ROW_180]: [] }))).toBe(false);
  });

  it("takes a Status the bot itself set in its marked row, once; the same value elsewhere, or by nobody, wakes (F4)", () => {
    const fazendo = (i: number) => SHEET[i]!.replace("Pendente    ", "Fazendo     ");
    const vm = vmWriteOf("mcp__computer__type", JSON.stringify({ text: "Fazendo" }), "https://docs.google.com/spreadsheets/d/SHEET_ID/edit#gid=50318669&range=E178", 1_000)!;
    expect(vm).toMatchObject({ kind: "sheets", values: ["fazendo"], via: "vm" });
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [fazendo(ROW_178)] }), [structuredClone(vm)])).toBe(true);
    // one write explains one line: the second "Fazendo" is a person's
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [fazendo(ROW_178)], [ROW_180]: [fazendo(ROW_180)] }), [structuredClone(vm)])).toBe(false);
    expect(sheetEcho(edit(SHEET, { [ROW_178]: [fazendo(ROW_178)] }), [])).toBe(false);
    // a Status changed in a row whose line has no mark (the mark is on a continuation line): it wakes, as before
    const unmarkedStatus = SHEET.findIndex((line) => line.includes("Publicado    Atendimento"));
    expect(unmarkedStatus).toBeGreaterThan(0);
    expect(sheetEcho(edit(SHEET, { [unmarkedStatus]: [SHEET[unmarkedStatus]!.replace("Publicado    ", "Fazendo      ")] }), [structuredClone(vm)])).toBe(false);
  });

  it("does not take a quoted value it wrote in one row for the same words a person writes in a row without its mark", () => {
    const write = selfWriteOf(`gog sheets update SHEET_ID 'Atendimento!F170' --values-json '[["Aguardando retorno do cliente"]]'`, 1_000)!;
    expect(write.marks).toEqual([]);
    const person = SHEET.findIndex((line) => line.startsWith("  Karntf"));
    expect(sheetEcho(edit(SHEET, { [person]: [`${SHEET[person]} Aguardando retorno do cliente`] }), [write])).toBe(false);
  });
});

describe("the real Chat output (gog --plain, TSV)", () => {
  const url = "https://mail.google.com/chat/u/0/#chat/space/AAAAexample";
  const posted = "@Fulana de Tal entrou no ar a correção do atendimento reaberto";
  const own = `spaces/GSMW4KYdbE4/messages/nWw1.nWw1\tNeewdoa Ocex\t2026-10-01T13:34:00.000000Z\t${posted}`;
  const person = "spaces/GSMW4KYdbE4/messages/nWw2.nWw2\tKarntf Fhqxr\t2026-10-01T13:35:00.000000Z\tobrigada!";
  // newest first: the new message on top, the oldest drops off the end
  const scrolled = (...lines: string[]) => [CHAT[0]!, ...lines, ...CHAT.slice(1, -lines.length)];
  const chatEcho = (after: string[], writes: SelfWrite[]) => isEcho(fresh(CHAT, after), "chat", writes, 2_000, { mark, previous: CHAT, current: after }).echo;

  it("takes the post the bot pasted through the VM as its own, and a person's message beside it wakes the bot (INSP-E 5)", () => {
    expect(urlOfToolCall("mcp__computer__open_url", JSON.stringify({ url }))).toBe(url);
    const vm = vmWriteOf("mcp__computer__clipboard_write", JSON.stringify({ text: posted }), url, 1_000)!;
    expect(vm).toMatchObject({ kind: "chat", via: "vm" });
    expect(chatEcho(scrolled(own), [vm])).toBe(true);
    expect(chatEcho(scrolled(own, person), [vm])).toBe(false);
    // typed on another page: not a Chat write
    expect(vmWriteOf("mcp__computer__type", JSON.stringify({ text: posted }), "https://app.example.com/inbox", 1_000)).toBeNull();
  });

  it("takes the post of a gog chat command, only from the start of its text", () => {
    const write = selfWriteOf(`gog chat messages send spaces/AAAAexample --text "${posted}"`, 1_000)!;
    expect(chatEcho(scrolled(own), [write])).toBe(true);
    // a person quoting the same words later in their message is not the bot
    const quoting = `spaces/GSMW4KYdbE4/messages/nWw3.nWw3\tKarntf Fhqxr\t2026-10-01T13:36:00.000000Z\tvocê disse: ${posted}`;
    expect(chatEcho(scrolled(quoting), [write])).toBe(false);
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

  it("keeps the start and end of a gh body, reads through a leading cd, never just the issue number", () => {
    expect(selfWriteOf('cd /Users/owner/wt && gh issue comment 1002 --body "Diagnóstico enviado ao cliente, aguardando retorno dele"', 1)).toMatchObject({ kind: "issues", via: "shell", marks: ["diagnóstico enviado ao cliente, aguardando retorno dele".slice(0, 40), "diagnóstico enviado ao cliente, aguardando retorno dele".slice(-40)] });
    expect(selfWriteOf("gh issue comment 1002 --body-file /tmp/x.md", 1)).toBeNull();
    expect(selfWriteOf("gh issue view 1003", 1)).toBeNull();
  });

  it("knows what a watch reads", () => {
    expect(watchKindOf(["gh", "issue", "list", "--search", "sort:updated-desc"])).toBe("issues");
    expect(watchKindOf(["gog", "chat", "messages", "list", "spaces/AAQ"])).toBe("chat");
    expect(watchKindOf(["gog", "sheets", "get", "SHEET_ID", "Atendimento!A1:H400", "--plain"])).toBe("sheets");
    expect(watchKindOf(["git", "ls-remote", "origin"])).toBeNull();
  });
});
