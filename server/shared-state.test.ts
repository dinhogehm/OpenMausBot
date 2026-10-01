import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { firstSentence, isOwnerOrder, SHARED_STATE_MAX_BYTES, SharedState } from "./shared-state.ts";

describe("what a bot's conversations know about each other", () => {
  it("shows a fact from one conversation in the prompt of another, never in its own", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-shared-"));
    try {
      const state = new SharedState(dir);
      const at = Date.parse("2026-09-30T21:00:00Z");
      state.record("chief", { threadId: "t-esteira", title: "Esteira", at, decision: "Mergeei a #9313 pelo gate.", pending: "GO para o carrier da #9278?" }, [{ threadId: "t-esteira", at, text: "Não rode ci:local enquanto houver release." }]);
      const other = new SharedState(dir).render("chief", "t-main", at, ["Sessão \"#9311 labels\" (idle)"]);
      expect(other).toContain("Estado das suas outras conversas");
      expect(other).toContain("Mergeei a #9313 pelo gate.");
      expect(other).toContain("esperando o dono: GO para o carrier da #9278?");
      expect(other).toContain("Ordens do dono em vigor");
      expect(other).toContain("Não rode ci:local enquanto houver release.");
      expect(other).toContain("#9311 labels");
      const own = state.render("chief", "t-esteira", at);
      expect(own).not.toContain("Mergeei a #9313");
      expect(own).toContain("Não rode ci:local"); // orders hold in every conversation
      expect(readFileSync(join(dir, "chief", "shared-state.md"), "utf8")).toContain("Mergeei a #9313");
      expect(state.render("monitor", "x", at)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the block small and without repeats", () => {
    const state = new SharedState(null);
    for (let i = 0; i < 40; i++) state.record("b", { threadId: `t${i}`, title: `Conversa ${i}`, at: i, decision: "x".repeat(150) }, [{ threadId: `t${i}`, at: i, text: "Sempre avise o Chief." }]);
    const block = state.render("b", "none", 100);
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(SHARED_STATE_MAX_BYTES);
    expect(block.match(/Sempre avise o Chief/g)).toHaveLength(1);
  });

  it("leaves out the conversations, and their orders, that the caller does not include", () => {
    const state = new SharedState(null);
    state.record("b", { threadId: "mine", title: "Mine", at: 1, decision: "OWNER-SAID" }, [{ threadId: "mine", at: 1, text: "Sempre avise o Chief." }]);
    state.record("b", { threadId: "guest", title: "Guest's", at: 2, decision: "GUEST-SAID" }, [{ threadId: "guest", at: 2, text: "Nunca publique sem GO." }]);
    const block = state.render("b", "now", 3, [], (threadId) => threadId !== "guest");
    expect(block).toContain("OWNER-SAID");
    expect(block).toContain("Sempre avise o Chief.");
    expect(block).not.toMatch(/GUEST-SAID|Guest's|Nunca publique/);
    expect(state.render("b", "now", 3, [], () => false)).toBe("");
  });

  it("tells an order from an ordinary request", () => {
    expect(isOwnerOrder("Não rode o ci:local agora")).toBe(true);
    expect(isOwnerOrder("A partir de agora, publique só com GO")).toBe(true);
    expect(isOwnerOrder("PARAR")).toBe(true);
    expect(isOwnerOrder("Veja a PR 9300 por favor")).toBe(false);
    expect(firstSentence("**Feito.** Abri a PR #9401 e rodei o gate.")).toBe("Feito.");
  });
});
