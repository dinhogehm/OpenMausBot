import { describe, expect, it } from "vitest";

import { dueAt, sortNeedsYou, type NeedsYouItem } from "./needs-you";

// INSP-J r1 #14: the power item ("Ligue o Mac … — release em curso", 12 min)
// is the most urgent and came last in "Prazo": it had no due.
describe("an item due now", () => {
  it("is due this very moment: first in 'Prazo', not overdue", () => {
    const now = Date.parse("2026-10-02T18:10:00Z");
    expect(dueAt("agora", now)).toBe(now);
    const item = (title: string, since: number, due?: string) => ({ botId: "chief", botName: "Chief of Staff", threadId: "52417e4a", threadTitle: "Canal", title, since, approval: false, ...(due ? { due } : {}) }) as NeedsYouItem;
    const items = [
      item("Recusar d5bb1f70b (laço, 11×)", now - 5 * 3_600_000),
      item("Decidir o timeout", now - 20 * 3_600_000, "hoje"),
      item("Ligue o Mac na tomada (12%, abaixo do seu limite de 20%) — release em curso", now - 12 * 60_000, "agora"),
    ];
    expect(sortNeedsYou(items, "due", now).map((each) => each.title.slice(0, 9))).toEqual(["Ligue o M", "Decidir o", "Recusar d"]);
    // "agora" inside a sentence is not a deadline
    expect(dueAt("até agora não", now)).toBeNull();
  });
});
