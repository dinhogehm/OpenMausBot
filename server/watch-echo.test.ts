import { describe, expect, it } from "vitest";
import { ECHO_WINDOW_MS, isEcho, selfWriteOf, watchKindOf } from "./watch-echo.ts";

describe("the bot's own writes", () => {
  it("reads which issue a gh write touched, not the numbers in its body", () => {
    expect(selfWriteOf('gh issue comment 9307 --repo nuria/plat --body "Publicado em 30/09, 2 itens"', 1))
      .toEqual({ at: 1, kind: "issues", marks: ["9307"] });
    expect(selfWriteOf("gh api -X POST repos/nuria/plat/issues/8891/comments -f body=ok", 1)?.marks).toEqual(["8891"]);
    expect(selfWriteOf("gh issue view 9307", 1)).toBeNull();
    expect(selfWriteOf("gh api repos/nuria/plat/issues/8891", 1)).toBeNull();
  });

  it("keeps the text a Chat post or a spreadsheet note leaves, and nothing short", () => {
    expect(selfWriteOf('gog chat messages send spaces/AAQ --text "Daiane, a correção da L173 foi publicada"', 1))
      .toEqual({ at: 1, kind: "chat", marks: ["daiane, a correção da l173 foi publicada"] });
    expect(selfWriteOf(`gog sheets update 1abc 'Clientes!H173' --values '[["Publicado 01/10 #9307"]]'`, 1))
      .toEqual({ at: 1, kind: "sheets", marks: ["publicado 01/10 #9307"] });
    expect(selfWriteOf('gog sheets update 1abc H173 --values "ok"', 1)).toBeNull();
    expect(selfWriteOf("gog chat messages list spaces/AAQ --max 10", 1)).toBeNull();
  });

  it("knows what a watch reads", () => {
    expect(watchKindOf(["gh", "issue", "list", "--search", "sort:updated-desc"])).toBe("issues");
    expect(watchKindOf(["gog", "chat", "messages", "list", "spaces/AAQ"])).toBe("chat");
    expect(watchKindOf(["curl", "-sL", "https://docs.google.com/spreadsheets/d/x/export?format=csv"])).toBe("sheets");
    expect(watchKindOf(["git", "ls-remote", "origin"])).toBeNull();
  });

  it("calls a change an echo only when every new line carries the bot's own mark", () => {
    const comment = selfWriteOf("gh issue comment 9307 --body x", 1_000)!;
    const row = "9307\tOPEN\tL173 correção\testeira\t2026-10-01T08:37:20Z";
    expect(isEcho([row], "issues", [comment], 2_000)).toBe(true);
    // a client's issue changed in the same run: not an echo
    expect(isEcho([row, "9311\tOPEN\tMarluce\t\t2026-10-01T08:36:00Z"], "issues", [comment], 2_000)).toBe(false);
    // too late, another kind of source, or nothing new
    expect(isEcho([row], "issues", [comment], 1_000 + ECHO_WINDOW_MS + 1)).toBe(false);
    expect(isEcho([row], "chat", [comment], 2_000)).toBe(false);
    expect(isEcho([], "issues", [comment], 2_000)).toBe(false);
    const post = selfWriteOf('gog chat messages send spaces/AAQ --text "Daiane, a correção da L173 foi publicada"', 1_000)!;
    expect(isEcho(["2026-10-01T08:28:00Z  Osvaldo Gehm: Daiane, a correção da L173 foi publicada hoje"], "chat", [post], 2_000)).toBe(true);
    expect(isEcho(["2026-10-01T08:29:00Z  Daiane: obrigada!"], "chat", [post], 2_000)).toBe(false);
  });
});
