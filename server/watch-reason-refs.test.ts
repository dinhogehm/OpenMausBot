import { describe, expect, it } from "vitest";
import { wakePrompt, type BotWake } from "./bot-autonomy.ts";
import { citedRefs, parseRefState, refStateArgs, sessionForNumber, staleRefsLine, watchSlug } from "./watch-reason-refs.ts";

// The Chief's real 'prod' note on 02/10 (bot-autonomy.json, dbb9f1cf):
// every PR it names merged, every session archived since 01/10.
const PROD_NOTE = "Tag de produção andou: fechar carrier #9327, avisar sessões 9295 (#9314), 8891 (#9329), 9326 (#9330) e liberar gate da #9328 (F4-1); carrier da F4 só com meu sinal. Pedir validação ao QA e aviso ao Monitor do que entrou.";
const PROD_ARGV = ["gh", "api", "repos/dinhogehm/nuria-platform/git/ref/tags/nuria-production-deployed", "--jq", ".object.sha"];

describe("what a watch's note names (R10-followup #5)", () => {
  it("reads the PRs and the sessions of the real 'prod' note", () => {
    expect(citedRefs(PROD_NOTE)).toEqual({ numbers: [9327, 9314, 9329, 9330, 9328], sessions: [9295, 8891, 9326] });
    // "F4-1" is not a session; a note without numbers names nothing
    expect(citedRefs("Main andou: conferir qual PR entrou, informar o Osvaldo (PR, head)")).toEqual({ numbers: [], sessions: [] });
    expect(citedRefs("rever PR 9350 e a issue 9351; sessão 8204")).toEqual({ numbers: [9350, 9351], sessions: [8204] });
  });

  it("finds the repository in the command, a -R flag or a URL", () => {
    expect(watchSlug(PROD_ARGV, PROD_NOTE)).toBe("dinhogehm/nuria-platform");
    expect(watchSlug(["gh", "issue", "list", "-R", "dinhogehm/nuria-platform"], "")).toBe("dinhogehm/nuria-platform");
    expect(watchSlug(["true"], "ver https://github.com/acme/web/pull/12")).toBe("acme/web");
    expect(watchSlug(["true"], "nada")).toBeNull();
  });

  it("asks GitHub one number at a time and tells PR from issue, merged from closed", () => {
    expect(refStateArgs("dinhogehm/nuria-platform", 9327)).toEqual(["api", "repos/dinhogehm/nuria-platform/issues/9327", "--jq", "[.state, (.pull_request != null), (.pull_request.merged_at // \"\")] | @tsv"]);
    expect(parseRefState(9327, "closed\ttrue\t2026-10-01T21:02:11Z\n")).toEqual({ number: 9327, kind: "pr", state: "merged" });
    expect(parseRefState(9330, "closed\ttrue\t\n")).toEqual({ number: 9330, kind: "pr", state: "closed" });
    expect(parseRefState(9350, "open\ttrue\t\n")).toEqual({ number: 9350, kind: "pr", state: "open" });
    expect(parseRefState(9295, "closed\tfalse\t\n")).toEqual({ number: 9295, kind: "issue", state: "closed" });
    expect(parseRefState(1, "")).toBeNull();
    expect(parseRefState(1, "gh: Not Found (HTTP 404)")).toBeNull();
  });

  it("names a session by the number its title starts with, the newest first", () => {
    const sessions = [
      { title: "9295 Tempo de reabertura", createdAt: 1 },
      { title: "9334 9331 Inatividade do chat", createdAt: 2 },
      { title: "Corrigir #8891 no login", createdAt: 3 },
      { title: "9295 Segunda tentativa", createdAt: 4 },
      { title: "Revisar 9326 depois", createdAt: 5 },
    ];
    expect(sessionForNumber(sessions, 9295)?.title).toBe("9295 Segunda tentativa");
    expect(sessionForNumber(sessions, 9331)?.title).toBe("9334 9331 Inatividade do chat");
    expect(sessionForNumber(sessions, 8891)?.title).toBe("Corrigir #8891 no login");
    // a number in the middle of a title, without "#", is not the session's
    expect(sessionForNumber(sessions, 9326)).toBeNull();
  });

  it("says only what is done; nothing when everything named is still open", () => {
    const line = staleRefsLine([
      { number: 9327, kind: "pr", state: "merged" },
      { number: 9314, kind: "pr", state: "merged", inProduction: true },
      { number: 9330, kind: "pr", state: "closed" },
      { number: 9350, kind: "pr", state: "open" },
      { number: 9295, kind: "issue", state: "closed" },
      null,
    ], [
      { number: 9295, title: "9295 Tempo de reabertura", archived: true },
      { number: 8204, title: "8204 Sidebar", archived: false },
    ]);
    expect(line).toBe("Checked by the server just now — of what your note names, these are no longer open: PR #9327 merged; PR #9314 merged and already in production; PR #9330 closed without merge; issue #9295 closed; session 9295 (\"9295 Tempo de reabertura\") archived. What the note asks about them may already be done: check before redoing it, act on what is still open, then give the note a current text with wake_when update_reason (same label).");
    expect(staleRefsLine([{ number: 9350, kind: "pr", state: "open" }, null], [{ number: 8204, title: "8204", archived: false }])).toBeNull();
  });

  it("the line sits right under the note in the wake's prompt", () => {
    const now = 1_790_960_000_000;
    const wake = {
      botId: "b", threadId: "t", at: now, createdAt: now - 30 * 3_600_000, reason: PROD_NOTE,
      watch: { command: PROD_ARGV.join(" "), argv: PROD_ARGV, standing: true, label: "prod", reasonAt: now - 30 * 3_600_000, runs: 40, baseline: "a", lastOutput: "b", trigger: "changed", failures: 0, everyMs: 300_000, until: undefined },
    } as unknown as BotWake;
    const refs = "Checked by the server just now — of what your note names, these are no longer open: PR #9327 merged.";
    const prompt = wakePrompt(wake, null, now, "LANG", refs);
    const lines = prompt.split("\n");
    const note = lines.findIndex((line) => line.includes("check it still holds"));
    expect(note).toBeGreaterThan(0);
    expect(lines[note + 1]).toBe(refs);
    expect(wakePrompt(wake, null, now, "LANG")).not.toContain("Checked by the server");
  });
});
