import { describe, expect, it } from "vitest";
import { parseCodingInput, codingTerminal, codingView } from "../src/coding-state";
import type { CodingRecord } from "../src/coding-types";

const input = { requestId: crypto.randomUUID(), repositoryConnectionId: "repo-1", baseRef: "main", task: "Fix the bug", provider: "openai", model: "fixture-model", setupCommand: "", testCommand: "node --test" };
describe("coding admission and permission contracts", () => {
  it("requires explicit test evidence and immutable typed task inputs", () => {
    expect(parseCodingInput(input)).toEqual(input);
    for (const change of [{ testCommand: "" }, { provider: "custom" }, { task: "x".repeat(4001) }, { baseRef: "-bad" }, { model: "bad\nmodel" }, { requestId: "bad" }]) {
      expect(() => parseCodingInput({ ...input, ...change })).toThrow();
    }
  });
  it("exposes creator/admin cancellation and admin-only approval", () => {
    const run = { ...input, createdBy: "author", status: "pending_approval" } as CodingRecord;
    expect(codingView(run, "member", "member").canApprove).toBe(false);
    expect(codingView(run, "member", "member").canCancel).toBe(false);
    expect(codingView(run, "author", "member").canCancel).toBe(true);
    expect(codingView(run, "admin", "admin").canApprove).toBe(true);
    expect(codingView({ ...run, status: "completed" }, "admin", "admin").canCancel).toBe(false);
    expect(codingTerminal("publishing")).toBe(false);
    expect(codingTerminal("interrupted")).toBe(true);
  });
});
