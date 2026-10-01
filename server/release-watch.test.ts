import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { haltedRelease, releaseFailureCause, releaseFailures, ReleaseWatchState, TAG_STUCK_AFTER_MS, tagStuck, tagStuckCause } from "./release-watch.ts";

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

describe("after a release", () => {
  it("says when production runs ahead of the tag (01/10: GH013), with the cause, and not before 15 min", () => {
    const log = [
      "Release production completed for 1bbd5c2",
      "remote: error: GH013: Repository rule violations found for refs/tags/nuria-production-deployed.",
      "WARNING: production is live at 1bbd5c2a7 but the certification tag was NOT advanced (exit 1)",
    ].join("\n");
    const cause = tagStuckCause(log);
    expect(cause).toContain("certification tag was NOT advanced");
    expect(cause).toContain("GH013");
    const base = { releasedSha: "1bbd5c2a7f00", releasedAt: 0, tagSha: "90b3ef2a5aaa", tagContainsRelease: false, cause };
    expect(tagStuck({ ...base, now: TAG_STUCK_AFTER_MS - 1 })).toBeNull();
    expect(tagStuck({ ...base, now: 20 * 60_000 })).toContain("Produção está no ar em 1bbd5c2a7 há 20 min, mas a tag de produção continua em 90b3ef2a5");
    expect(tagStuck({ ...base, now: 20 * 60_000, tagContainsRelease: true })).toBeNull();
    expect(tagStuckCause("Release production completed for abc")).toBeNull();
  });

  it("reads the watcher's halt from its escalation file (#9328), or from its halted files", () => {
    const json = '{"to":"chief","kind":"production-release-halted","reason":"content-failure-limit","sha":"2995ef215","failures":3,"limit":3,"last_failure":"reconcile 0608","at":"2026-10-01T12:00:00Z"}';
    expect(haltedRelease({ escalationJson: json, haltedSha: "", haltedReason: "" })).toEqual({ sha: "2995ef215", reason: "content-failure-limit", failures: 3, lastFailure: "reconcile 0608" });
    expect(haltedRelease({ escalationJson: "", haltedSha: "c88f99d62\n", haltedReason: "" })).toEqual({ sha: "c88f99d62", reason: "unknown" });
    expect(haltedRelease({ escalationJson: "not json", haltedSha: "", haltedReason: "" })).toBeNull();
  });

  it("tells each stuck tag or halt once, across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-release-"));
    try {
      const state = new ReleaseWatchState(join(dir, "release-watch.json"));
      expect(state.once("tag:1bbd5c2a7")).toBe(true);
      expect(state.once("tag:1bbd5c2a7")).toBe(false);
      expect(new ReleaseWatchState(join(dir, "release-watch.json")).once("tag:1bbd5c2a7")).toBe(false);
      expect(state.once("halt:2995ef215")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
