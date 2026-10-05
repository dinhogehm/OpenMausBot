import { describe, expect, it } from "vitest";
import { englishNarration, narrationNoteText } from "./turn-narration.ts";

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
    expect(narrationNoteText(morning[0]!.text)).toBe("Nota de trabalho do bot, em inglês (não é mensagem para você): Both nested ones are clean and published; remove them (routine). The merge-deploy one has untracked `.claude/` config and closed-unmerged PR — leave.");
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
