import { describe, expect, it } from "vitest";
import { botMarkPattern, ECHO_WINDOW_MS, isEcho, selfWriteOf, watchKindOf } from "./watch-echo.ts";

describe("the bot's own writes", () => {
  it("keeps the text a gh write leaves, never just the issue number, and reads through a leading cd", () => {
    expect(selfWriteOf('gh issue comment 9307 --repo nuria/plat --body "Publicado em 30/09, 2 itens"', 1))
      .toMatchObject({ at: 1, kind: "issues", marks: ["publicado em 30/09, 2 itens"] });
    expect(selfWriteOf('cd /Users/o/wt && gh issue comment 9331 --body "Diagnóstico enviado ao cliente"', 1)?.marks).toEqual(["diagnóstico enviado ao cliente"]);
    expect(selfWriteOf('cd /tmp; gog chat messages send spaces/AAQ --text "Daiane, a correção da L173 foi publicada"', 1)?.kind).toBe("chat");
    // no text to recognise: nothing to suppress with
    expect(selfWriteOf("gh api -X POST repos/nuria/plat/issues/8891/comments -f body=ok", 1)).toBeNull();
    expect(selfWriteOf("gh issue view 9307", 1)).toBeNull();
  });

  it("keeps the text a Chat post or a spreadsheet note leaves, and nothing short", () => {
    expect(selfWriteOf('gog chat messages send spaces/AAQ --text "Daiane, a correção da L173 foi publicada"', 1))
      .toMatchObject({ at: 1, kind: "chat", marks: ["daiane, a correção da l173 foi publicada"] });
    expect(selfWriteOf(`gog sheets update 1abc 'Clientes!H173' --values '[["Publicado 01/10 #9307"]]'`, 1))
      .toMatchObject({ at: 1, kind: "sheets", marks: ["publicado 01/10 #9307"] });
    expect(selfWriteOf('gog sheets update 1abc H173 --values "ok"', 1)).toBeNull();
    expect(selfWriteOf("gog chat messages list spaces/AAQ --max 10", 1)).toBeNull();
  });

  it("knows what a watch reads", () => {
    expect(watchKindOf(["gh", "issue", "list", "--search", "sort:updated-desc"])).toBe("issues");
    expect(watchKindOf(["gog", "chat", "messages", "list", "spaces/AAQ"])).toBe("chat");
    expect(watchKindOf(["curl", "-sL", "https://docs.google.com/spreadsheets/d/x/export?format=csv"])).toBe("sheets");
    expect(watchKindOf(["git", "ls-remote", "origin"])).toBeNull();
  });
});

describe("what is an echo", () => {
  const mark = botMarkPattern("Monitor Chat Atendimento");

  it("never takes a person's comment on the same issue for the bot's echo (R8-intake 3)", () => {
    const comment = selfWriteOf('gh issue comment 9331 --body "Encaminhado para a sessão de diagnóstico"', 1_000)!;
    // two minutes later a person comments on #9331: same number, other words
    const human = "9331\tPatrícia\tAinda dá 503 depois do deploy\t2026-10-01T17:18:00Z";
    expect(isEcho([human], "issues", [comment], 1_000 + 2 * 60_000, { mark })).toBe(false);
    // the bot's own comment, by its words or by its mark
    expect(isEcho(["9331\tmonitor\tEncaminhado para a sessão de diagnóstico\t2026-10-01T17:16:00Z"], "issues", [comment], 2_000)).toBe(true);
    expect(isEcho(["9331\tmonitor\tIssue registrada <!-- bot:monitor-chat-atendimento -->"], "issues", [], 2_000, { mark })).toBe(true);
    // too late, another kind of source, or nothing new
    expect(isEcho(["9331\tmonitor\tEncaminhado para a sessão de diagnóstico"], "issues", [comment], 1_000 + ECHO_WINDOW_MS + 1)).toBe(false);
    expect(isEcho(["Encaminhado para a sessão de diagnóstico"], "chat", [comment], 2_000)).toBe(false);
    expect(isEcho([], "issues", [comment], 2_000, { mark })).toBe(false);
  });

  it("knows the bot's mark whatever wrote it (the VM's browser in the Chat), and a person's line beside it wakes the bot", () => {
    const post = "2026-10-01T13:34:00Z  Osvaldo Gehm: [Monitor Chat Atendimento] Daiane, a #9307 foi publicada";
    expect(isEcho([post], "chat", [], 1, { mark })).toBe(true);
    expect(isEcho([post, "2026-10-01T13:35:00Z  Daiane: obrigada!"], "chat", [], 1, { mark })).toBe(false);
  });

  it("wakes the bot for a \"Reprovado\" in the row it annotated, and not for its own note there (R8-intake 2)", () => {
    const before = "178\tPatrícia\tChat sem resposta\tPendente\t\t[Monitor Chat Atendimento] Issue #9331 OPEN";
    const note = "178\tPatrícia\tChat sem resposta\tPendente\t\t[Monitor Chat Atendimento] Issue #9331 OPEN · sessão aberta";
    const failed = "178\tPatrícia\tChat sem resposta\tPublicado\tReprovado\t[Monitor Chat Atendimento] Issue #9331 OPEN";
    expect(isEcho([note], "sheets", [], 1, { mark, previous: [before] })).toBe(true);
    expect(isEcho([failed], "sheets", [], 1, { mark, previous: [before] })).toBe(false);
    // a continuation line of a multi-line note is only the mark: the bot's
    expect(isEcho(["[Monitor Chat Atendimento] Issue #9334 OPEN, sessão 5f41b133"], "sheets", [], 1, { mark, previous: [before] })).toBe(true);
    // a row the bot opened (its mark in it, no row before): its own
    expect(isEcho(["181\tMatheus\tFila errada\tPendente\t\t[Monitor Chat Atendimento] Issue #9337 OPEN"], "sheets", [], 1, { mark, previous: [before] })).toBe(true);
    // a row with no mark at all is a person's
    expect(isEcho(["182\tDaiane\tNova demanda\tPendente\t\t"], "sheets", [], 1, { mark, previous: [before] })).toBe(false);
  });

  it("takes a short value the bot just wrote (\"Publicado\") in its marked row as its own, and the same value from nobody as a change (F4)", () => {
    const before = "173\tDaiane\tL173 correção\tPendente\t\t[Monitor Chat Atendimento] Issue #9307 OPEN";
    const after = "173\tDaiane\tL173 correção\tPublicado\t\t[Monitor Chat Atendimento] Issue #9307 publicada 01/10";
    const write = selfWriteOf(`cd /tmp && gog sheets update 163U0o9 'Atendimento!D173:F173' --input RAW --values-json '[["Publicado","","[Monitor Chat Atendimento] Issue #9307 publicada 01/10"]]'`, 1_000)!;
    expect(write.values).toContain("publicado");
    expect(isEcho([after], "sheets", [write], 2_000, { mark, previous: [before] })).toBe(true);
    // nobody wrote "Publicado" (a person did, by hand): it wakes the bot
    expect(isEcho([after], "sheets", [], 2_000, { mark, previous: [before] })).toBe(false);
    // and a "Reprovado" beside the bot's "Publicado" still wakes it
    const failed = "173\tDaiane\tL173 correção\tPublicado\tReprovado\t[Monitor Chat Atendimento] Issue #9307 publicada 01/10";
    expect(isEcho([failed], "sheets", [write], 2_000, { mark, previous: [before] })).toBe(false);
  });
});
