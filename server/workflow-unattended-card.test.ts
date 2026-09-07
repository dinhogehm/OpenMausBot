// The four ways a workflow node's permission card can go once the harness
// decides nobody will click it: denied and delivered; denial undeliverable
// (a person gets the card after all); a grace a person answers inside; a
// grace that expires into the denial.
import { describe, expect, it } from "vitest";

import type { RequestOutcome } from "./contracts.ts";
import type { OptionCardData } from "./store.ts";
import { denyUnattendedWorkflowCard, type UnattendedCardDeps } from "./workflow-unattended-card.ts";

const WRAPPED = '/bin/zsh -lc "gh project item-list 10 --owner @me"';
const DENIAL = `denied unattended: shell "${WRAPPED}" (key shell:gh) — no always-allow names "shell:gh"`;

function fixture(options: { graceMs?: number; respond?: () => Promise<RequestOutcome> } = {}) {
  const cards = new Map<string, OptionCardData>();
  const responses: string[] = [];
  const decisions: Array<{ decision: string; source: string }> = [];
  const denials: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let notified = 0;
  let seq = 0;
  const deps: UnattendedCardDeps = {
    graceMs: options.graceMs ?? 0,
    pushCard: (card) => {
      const id = `msg-${++seq}`;
      cards.set(id, card);
      return id;
    },
    readCard: (id) => cards.get(id),
    patchCard: (id, card) => void cards.set(id, card),
    respond: (message) => {
      responses.push(message);
      return options.respond ? options.respond() : Promise.resolve("rejected");
    },
    appendDecision: (row) => void decisions.push(row),
    noteDenial: (line) => void denials.push(line),
    notifyHuman: () => void notified++,
    schedule: (fn, ms) => void timers.push({ fn, ms }),
  };
  const run = () =>
    denyUnattendedWorkflowCard(
      { requestId: "req-1", tool: "shell", summary: WRAPPED, verdict: { source: "no-grant" } },
      deps,
    );
  return { deps, cards, responses, decisions, denials, timers, notified: () => notified, run };
}

describe("denyUnattendedWorkflowCard", () => {
  it("writes the card, answers the provider, and only then tells the engine and the log", async () => {
    const f = fixture();
    const result = f.run();
    // the card is in the transcript before anything is answered, named as a denial
    expect(f.cards.get(result.messageId)).toMatchObject({
      title: "Denied unattended",
      subtitle: WRAPPED,
      options: ["Allow", "Deny"],
      requestId: "req-1",
      tool: "shell",
      held: DENIAL,
    });
    expect(f.cards.get(result.messageId)).not.toHaveProperty("approvalScope");
    expect(result.denial).toBe(DENIAL);

    await expect(result.settled).resolves.toBe("denied");
    expect(f.responses).toEqual([DENIAL]);
    expect(f.denials).toEqual([DENIAL]);
    expect(f.decisions).toEqual([{ decision: "auto-denied", source: "no-grant" }]);
    // nobody is buzzed for a card the harness answered itself
    expect(f.notified()).toBe(0);
    expect(f.timers).toEqual([]);
  });

  it("carries the scope onto the card and into the line", () => {
    const f = fixture();
    const result = denyUnattendedWorkflowCard(
      { requestId: "req-1", tool: "session_search", summary: "notes", scope: "local-computer", verdict: { source: "no-grant" } },
      f.deps,
    );
    expect(f.cards.get(result.messageId)).toMatchObject({ approvalScope: "local-computer" });
    expect(result.denial).toContain("scope local-computer");
  });

  it("hands an undeliverable denial to a person: the card stays open with a note, the log says card-shown, the bot waits", async () => {
    for (const respond of [
      () => Promise.resolve<RequestOutcome>("unavailable"),
      () => Promise.reject(new Error("provider unavailable")),
    ]) {
      const f = fixture({ respond });
      const result = f.run();
      await expect(result.settled).resolves.toBe("undelivered");
      expect(f.cards.get(result.messageId)).toMatchObject({
        held: `${DENIAL} — the denial could not be delivered, so this card is waiting on you`,
      });
      expect(f.cards.get(result.messageId)!.answered).toBeUndefined();
      // the engine is never told of a refusal nothing received
      expect(f.denials).toEqual([]);
      expect(f.decisions).toEqual([{ decision: "card-shown", source: "auto-fallback" }]);
      expect(f.notified()).toBe(1);
    }
  });

  it("never overwrites a person's click that landed while the answer was in flight", async () => {
    let release!: () => void;
    const gate = new Promise<RequestOutcome>((resolve) => {
      release = () => resolve("unavailable");
    });
    const f = fixture({ respond: () => gate });
    const result = f.run();
    // the person answers the card while respond() is pending
    f.cards.set(result.messageId, { ...f.cards.get(result.messageId)!, answered: "allow" });
    release();
    await expect(result.settled).resolves.toBe("undelivered");
    expect(f.cards.get(result.messageId)).toMatchObject({ answered: "allow", held: DENIAL });
  });

  it("with a grace, buzzes at once and lets a person's answer inside the window stand", async () => {
    const f = fixture({ graceMs: 30_000 });
    const result = f.run();
    expect(f.cards.get(result.messageId)).toMatchObject({ title: "Approval needed", held: DENIAL });
    expect(f.notified()).toBe(1);
    expect(f.timers).toEqual([expect.objectContaining({ ms: 30_000 })]);
    expect(f.responses).toEqual([]);

    // the person clicks Allow before the grace runs out
    f.cards.set(result.messageId, { ...f.cards.get(result.messageId)!, answered: "allow" });
    f.timers[0]!.fn();
    await expect(result.settled).resolves.toBe("answered-by-person");
    expect(f.responses).toEqual([]);
    expect(f.denials).toEqual([]);
    expect(f.decisions).toEqual([]);
  });

  it("with a grace nobody uses, denies when it expires, exactly as an instant denial would", async () => {
    const f = fixture({ graceMs: 30_000 });
    const result = f.run();
    f.timers[0]!.fn();
    await expect(result.settled).resolves.toBe("denied");
    expect(f.responses).toEqual([DENIAL]);
    expect(f.denials).toEqual([DENIAL]);
    expect(f.decisions).toEqual([{ decision: "auto-denied", source: "no-grant" }]);
    // the grace buzz is the only one
    expect(f.notified()).toBe(1);
  });

  it("treats a card that vanished before the answer as answered: nothing is denied twice", async () => {
    const f = fixture({ graceMs: 1_000 });
    const result = f.run();
    f.cards.delete(result.messageId);
    f.timers[0]!.fn();
    await expect(result.settled).resolves.toBe("answered-by-person");
    expect(f.responses).toEqual([]);
  });
});
