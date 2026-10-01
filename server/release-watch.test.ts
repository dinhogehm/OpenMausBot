import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseFailureCause, releaseFailures, ReleaseWatchState } from "./release-watch.ts";

const log = [
  "Release production failed for b51648498 (exit 1)",
  "npm WARN deprecated glob",
  "Release production failed for 2995ef215 (exit 1)",
  "From ssh://github.com",
  "Release production failed for 2995ef215 (exit 1)",
].join("\n");

describe("production release failures", () => {
  it("counts the failures of the last failing commit, unless it was released since", () => {
    expect(releaseFailures(log, "35fb073da0000")).toEqual({ sha: "2995ef215", count: 2 });
    expect(releaseFailures(log, "2995ef215fc784ea87387cb1550c1a733aba4dc5")).toBeNull();
    expect(releaseFailures("nothing failed", "")).toBeNull();
  });

  it("finds the cause in the release's own log", () => {
    expect(releaseFailureCause("x\n✗ helpdesk: 4 failed\nLocal CI failed at tests\ndone")).toBe("Local CI failed at tests");
    // the real tail of 01/10: test noise after the verdict, coloured [ERROR] lines
    const real = [
      "@nuria/web:test: Error: usePlanContext must be used within PlanProvider",
      "\x1b[0;31m[ERROR]\x1b[0m Tenant nuria-ws-01a0ed885c1a reprovou inspecao da migration 0608",
      "\x1b[0;31m[ERROR]\x1b[0m   reconciler nao emitiu stderr — investigue timeout, sinal ou rede",
      "\x1b[0;31m[ERROR]\x1b[0m Release abortado",
      "@nuria/web:test: Error: usePlanContext must be used within PlanProvider",
    ].join("\n");
    expect(releaseFailureCause(real)).toBe("Tenant nuria-ws-01a0ed885c1a reprovou inspecao da migration 0608");
    expect(releaseFailureCause("all good")).toBeNull();
  });

  it("tells each new failure count once, from the second on, across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-release-"));
    try {
      const path = join(dir, "release-watch.json");
      const state = new ReleaseWatchState(path);
      expect(state.take("2995ef215", 1)).toBe(false);
      expect(state.take("2995ef215", 2)).toBe(true);
      expect(state.take("2995ef215", 2)).toBe(false);
      expect(new ReleaseWatchState(path).take("2995ef215", 2)).toBe(false);
      expect(new ReleaseWatchState(path).take("2995ef215", 3)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
