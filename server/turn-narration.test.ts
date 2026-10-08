import { describe, expect, it } from "vitest";
import { englishNarration, narrationPatch, narrationShaped } from "./turn-narration.ts";

// The Chief's turns of 05/10 in the owner's channel (52417e4a), as stored
const turn = (turnId: string, texts: string[]) => texts.map((text, index) => ({ id: `${turnId}-${index}`, role: "bot", kind: "text", text, turnId }));

describe("English narration in a turn", () => {
  it("02:22 and 08:22 of 05/10: the English lines before the Portuguese reply are work notes", () => {
    const night = turn("8aa7628f", [
      "Published (tag ahead of merge), only graft change, no process using it. Fits the authorized routine.",
      "Osvaldo, removi a worktree publicada da graft (sem `--force`). Não apaguei mais nada.",
    ]);
    expect(englishNarration(night, "8aa7628f", "8aa7628f-1").map((each) => each.id)).toEqual(["8aa7628f-0"]);
    const morning = turn("2c83a258", [
      "Both nested ones are clean and published; remove them (routine). The merge-deploy one has untracked `.claude/` config and closed-unmerged PR — leave.",
      "Osvaldo, das três worktrees que estavam paradas havia mais de 72 horas fora da tag, removi duas e deixei uma para você decidir. As remoções foram sem `--force`.",
    ]);
    expect(englishNarration(morning, "2c83a258", "2c83a258-1").map((each) => each.id)).toEqual(["2c83a258-0"]);
    // the text stays whole: in the message and in the chip's expandable output, backticks and all
    expect(narrationPatch(morning[0]!.text)).toEqual({
      kind: "activity",
      text: morning[0]!.text,
      tool: { name: "Nota de trabalho do bot, em inglês (não é mensagem para você)", ok: true, output: morning[0]!.text },
    });
  });

  // INSP-R12F F3: a draft the owner asked for, or a log, was cut into a chip and lost
  it("never takes an e-mail draft, a log, a code block or a quote for narration", () => {
    const reply = "Pronto, o rascunho está acima.";
    const keep = [
      "Dear John,\n\nThank you for your email. We will send the invoice by Friday, as agreed with your team last week. Please let us know if the PO number changes.\n\nBest regards,\nOsvaldo",
      "Hi Maria, thanks for the quick reply. The new build is ready and we will deploy it on Monday.",
      "Error: Cannot find module 'x' in /app/src. The file is not there.",
      "2026-10-05 15:05:55 WARN the gate is still pending for the head of the PR",
      "TypeError: cannot read properties of undefined (reading 'id') at the handler of the route",
      "Here is the fix:\n```ts\nconst x = 1;\n```",
      "> The release is blocked until the disk has 8 GiB free.\nThat is what the watcher said.",
      `${"The release is running and the tag will move when it is done. ".repeat(8)}`,
    ];
    for (const text of keep) {
      expect(englishNarration(turn("d", [text, reply]), "d", "d-1"), text).toEqual([]);
      expect(narrationShaped(text), text).toBe(false);
    }
    // the real slips still are narration
    expect(narrationShaped("Now the orphans: inspect.")).toBe(true);
    expect(narrationShaped("Commit is in production. Now hand off to QA and Monitor, cancel my temporary tag watch, archive the session, and put the issue close in pending.")).toBe(true);
  });

  it("keeps the reply, Portuguese narration, other turns, and everything when the reply itself is English", () => {
    const mixed = [
      ...turn("t1", ["Agora confiro o log do release.", "Now the orphans: inspect.", "Osvaldo, o release terminou e a tag andou."]),
      ...turn("t0", ["The gate is free. Release running? Check log quickly."]),
      { id: "a", role: "bot", kind: "activity", turnId: "t1" },
      { id: "u", role: "user", kind: "text", text: "Now the orphans: inspect.", turnId: "t1" },
    ];
    expect(englishNarration(mixed, "t1", "t1-2").map((each) => each.id)).toEqual(["t1-1"]);
    // the person writes English, the bot answers in English: nothing is hidden
    const english = turn("t2", ["Let me check the gate.", "The gate is green and the PR is merged."]);
    expect(englishNarration(english, "t2", "t2-1")).toEqual([]);
    // no terminal reply known: nothing is hidden
    expect(englishNarration(english, "t2", "missing")).toEqual([]);
  });
});
