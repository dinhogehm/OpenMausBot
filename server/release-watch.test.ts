import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotAutonomy } from "./bot-autonomy.ts";
import { haltedRelease, haltStillMatters, releaseFailureCause, releaseFailures, ReleaseWatchState, TAG_STUCK_AFTER_MS, tagAdvancePendingTitle, tagAdvanceToResolve, tagContainsRelease, tagManualAdvance, tagStuck, tagStuckCause, tagStuckReport } from "./release-watch.ts";

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
      "WARNING: production is live at 1bbd5c2a72a2ed67bc5a6a0d163f3ac2df576e44 but the certification tag was NOT advanced (exit 1)",
    ].join("\n");
    const cause = tagStuckCause(log, "1bbd5c2a72a2ed67bc5a6a0d163f3ac2df576e44");
    expect(cause).toBe("o release avisou que a tag não avançou (exit 1); o GitHub recusou o push da tag (GH013: regra de proteção do repositório)");
    const base = { releasedSha: "1bbd5c2a7f00", releasedAt: 0, tagSha: "90b3ef2a5aaa", tagContainsRelease: false, cause };
    expect(tagStuck({ ...base, now: TAG_STUCK_AFTER_MS - 1 })).toBeNull();
    expect(tagStuck({ ...base, now: 20 * 60_000 })).toContain("Produção está no ar em 1bbd5c2a7 há 20 min, mas a tag de produção continua em 90b3ef2a5");
    expect(tagStuck({ ...base, now: 20 * 60_000, tagContainsRelease: true })).toBeNull();
    expect(tagStuckCause("Release production completed for abc", "abc1234")).toBeNull();
  });

  // INSP-R r1 item 9: the err log keeps the GH013 of 1bbd5c2a7 for days
  it("cites only the cause of the release whose tag is stuck, never an older release's GH013", () => {
    const A = "1bbd5c2a72a2ed67bc5a6a0d163f3ac2df576e44";
    const B = "c88f99d62aaaabbbbccccddddeeeeffff0000111";
    const tail = [
      "To github.com:example/platform.git",
      " ! [remote rejected] nuria-production-deployed -> nuria-production-deployed (push declined due to repository rule violations)",
      "remote: error: GH013: Repository rule violations found for refs/tags/nuria-production-deployed.",
      `WARNING: production is live at ${A} but the certification tag was NOT advanced (exit 1)`,
      "Runtime targets and the deploy receipt are unaffected. Advance it manually:",
      "npm WARN deprecated glob",
    ].join("\n");
    // B was released and its tag is stuck, with no cause of its own in the log
    expect(tagStuckCause(tail, B)).toBeNull();
    expect(tagStuckCause(tail, A)).toContain("GH013");
    expect(tagStuckCause(tail, A.slice(0, 9))).toContain("GH013");
    // B warned, without a refusal of its own: the older GH013 above A's warning is not B's
    const later = `${tail}\nRelease production failed for d3415792b (exit 1)\nremote: error: GH013: old\nWARNING: production is live at ${A} but the certification tag was NOT advanced (exit 1)\nsomething\nWARNING: production is live at ${B} but the certification tag was NOT advanced (exit 128)`;
    expect(tagStuckCause(later, B)).toBe("o release avisou que a tag não avançou (exit 128)");
    // a refusal far above the warning (other output in between) is not taken
    const far = ["remote: error: GH013: x", ...Array.from({ length: 50 }, (_, i) => `line ${i}`), `WARNING: production is live at ${B} but the certification tag was NOT advanced (exit 1)`].join("\n");
    expect(tagStuckCause(far, B)).toBe("o release avisou que a tag não avançou (exit 1)");
    expect(tagStuckCause(tail, "")).toBeNull();
  });

  // INSP-R r2 item 4: in the real order (err.log :16706-16716) the line closest to
  // the warning is "- Cannot update this protected ref.", and GH013 is 8 lines up.
  // Rebuilt from git/GitHub's output and local-release.sh:431-433, owner/repo redacted.
  it("prefers GH013 anywhere in the release's window, and adds the manual advance the release printed", () => {
    const sha = "1bbd5c2a72a2ed67bc5a6a0d163f3ac2df576e44";
    const real = [
      "remote: error: GH013: Repository rule violations found for refs/tags/nuria-production-deployed.        ",
      "remote: Review all repository rules at https://github.com/owner/repo/rules?ref=refs%2Ftags%2Fnuria-production-deployed        ",
      "remote: ",
      "remote: - Cannot update this protected ref.        ",
      "remote: ",
      "To github.com:owner/repo.git",
      " ! [remote rejected]   nuria-production-deployed -> nuria-production-deployed (push declined due to repository rule violations)",
      "error: failed to push some refs to 'github.com:owner/repo.git'",
      `WARNING: production is live at ${sha} but the certification tag was NOT advanced (exit 1)`,
      "Runtime targets and the deploy receipt are unaffected. Advance it manually:",
      `  git tag -f nuria-production-deployed ${sha} && git push --force-with-lease=refs/tags/nuria-production-deployed origin refs/tags/nuria-production-deployed:refs/tags/nuria-production-deployed`,
    ].join("\n");
    const cause = tagStuckCause(real, sha);
    expect(cause).toContain("GH013");
    expect(cause).not.toContain("ref protegida");
    expect(cause).toBe("o release avisou que a tag não avançou (exit 1); o GitHub recusou o push da tag (GH013: regra de proteção do repositório)");
    // INSP-R r3 item 2: the force push is the owner's — kept for the log and the owner's pending list,
    // never in what the Chief (a bot with tools) reads
    const manual = tagManualAdvance(real, sha);
    expect(manual).toBe(`git tag -f nuria-production-deployed ${sha} && git push --force-with-lease=refs/tags/nuria-production-deployed origin refs/tags/nuria-production-deployed:refs/tags/nuria-production-deployed`);
    expect(tagManualAdvance(real, "c88f99d62")).toBeNull();
    const text = tagStuck({ releasedSha: sha, releasedAt: 0, tagSha: "90b3ef2a5aaa", tagContainsRelease: false, now: 20 * 60_000, cause });
    const report = tagStuckReport(text!, Boolean(manual));
    expect(report).toContain("GH013");
    expect(report).toContain("ação do dono (ou de quem tem bypass do ruleset do repositório); bots não executam");
    expect(`${text}\n${report}`).not.toMatch(/--force|git tag -f|git push/);
    expect(text).not.toMatch(/Alguém precisa/);
    const title = tagAdvancePendingTitle(sha);
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title).toContain("só o dono ou quem tem bypass");
    // only the protected-ref line: said as such
    expect(tagStuckCause(real.split("\n").slice(1).join("\n"), sha)).toContain("(ref protegida)");
  });

  // INSP-R r4: an open "advance the tag to X" after the tag reached X would move the tag BACK
  it("closes the owner's 'advance the tag' item once the tag contains its commit", () => {
    const X = "1bbd5c2a72a2ed67bc5a6a0d163f3ac2df576e44";
    const Y = "c88f99d62000000000000000000000000000000a";
    const autonomy = new BotAutonomy({ path: null });
    autonomy.addOwnerPending("chief", "desk", { title: tagAdvancePendingTitle(X), key: `tag-advance:${X}` });
    autonomy.addOwnerPending("chief", "desk", { title: "outra coisa", key: "desktop:abc" });
    const open = () => autonomy.ownerPendingFor("desk").map((item) => item.key ?? "");
    // the tag still behind X: stays open
    expect(tagAdvanceToResolve(open(), "90b3ef2a5aaa", () => false)).toEqual([]);
    expect(tagAdvanceToResolve(open(), "90b3ef2a5aaa", () => null)).toEqual([]); // not verifiable: kept
    expect(tagAdvanceToResolve(open(), null, () => true)).toEqual([]);
    // advanced by hand to X (same commit), or past it by a later release Y that contains X
    expect(tagAdvanceToResolve(open(), X, () => null)).toEqual([`tag-advance:${X}`]);
    const done = tagAdvanceToResolve(open(), Y, (sha) => sha === X);
    expect(done).toEqual([`tag-advance:${X}`]);
    for (const key of done) autonomy.resolveOwnerPending({ key });
    expect(open()).toEqual(["desktop:abc"]);
    // INSP-R r5: an item made on another of the Chief's conversations (the desk changed) closes too:
    // the server reads them by bot (ownerPendingOf), as here
    autonomy.addOwnerPending("chief", "old-desk", { title: tagAdvancePendingTitle(Y), key: `tag-advance:${Y}` });
    const byBot = () => autonomy.ownerPendingOf("chief").map((item) => item.key ?? "").filter((key) => key.startsWith("tag-advance:"));
    expect(byBot()).toEqual([`tag-advance:${Y}`]);
    for (const key of tagAdvanceToResolve(byBot(), Y, () => null)) autonomy.resolveOwnerPending({ key });
    expect(byBot()).toEqual([]);
    expect(autonomy.ownerPendingFor("old-desk")).toEqual([]);
  });

  // INSP-R r1 item 10: ls-remote does not fetch; a commit missing in the clone is no evidence
  it("says nothing about the tag when the clone cannot verify it", () => {
    const base = { releasedSha: "1bbd5c2a7f00", releasedAt: 0, tagSha: "90b3ef2a5aaa", now: 20 * 60_000, cause: null };
    expect(tagContainsRelease({ releasedKnown: true, tagKnown: false, isAncestor: null })).toBeNull();
    expect(tagContainsRelease({ releasedKnown: false, tagKnown: true, isAncestor: null })).toBeNull();
    expect(tagContainsRelease({ releasedKnown: true, tagKnown: true, isAncestor: null })).toBeNull(); // git failed
    expect(tagContainsRelease({ releasedKnown: true, tagKnown: true, isAncestor: false })).toBe(false);
    expect(tagContainsRelease({ releasedKnown: true, tagKnown: true, isAncestor: true })).toBe(true);
    // the tag ahead of the release, its commit not fetched here: no "stuck" text
    expect(tagStuck({ ...base, tagContainsRelease: tagContainsRelease({ releasedKnown: true, tagKnown: false, isAncestor: null }) })).toBeNull();
    expect(tagStuck({ ...base, tagContainsRelease: null })).toBeNull();
    expect(tagStuck({ ...base, tagContainsRelease: false })).toContain("a tag de produção continua em 90b3ef2a5");
  });

  // INSP-R r1 item 8: the halt is the .sha file — the one the watcher reads — and nothing else
  it("reads the watcher's halt from halted-production-release.sha; the escalation JSON (#9328) only adds detail for the same commit", () => {
    const json = '{"to":"chief","kind":"production-release-halted","reason":"content-failure-limit","sha":"2995ef215","failures":3,"limit":3,"last_failure":"reconcile 0608","at":"2026-10-01T12:00:00Z"}';
    expect(haltedRelease({ escalationJson: json, haltedSha: "2995ef215\n", haltedReason: "" })).toEqual({ sha: "2995ef215", reason: "limite de falhas de conteúdo atingido", failures: 3, lastFailure: "reconcile 0608" });
    expect(haltedRelease({ escalationJson: json, haltedSha: "2995ef215fc784ea87387cb1550c1a733aba4dc5", haltedReason: "content-failure-limit\n" })).toMatchObject({ sha: "2995ef215fc784ea87387cb1550c1a733aba4dc5", failures: 3 });
    // the owner ran `rm halted-production-release.sha` to retry: the JSON left behind is no halt
    expect(haltedRelease({ escalationJson: json, haltedSha: "", haltedReason: "" })).toBeNull();
    // the JSON of another commit: only the .sha's own sha and reason
    expect(haltedRelease({ escalationJson: json, haltedSha: "c88f99d62", haltedReason: "post-deploy-health" })).toEqual({ sha: "c88f99d62", reason: "post-deploy-health" });
    // INSP-R r2 item 5: the health halt's code (#9319) in pt-BR
    expect(haltedRelease({ escalationJson: "", haltedSha: "c88f99d62", haltedReason: "post-release-health\n" })).toEqual({ sha: "c88f99d62", reason: "checagem de saúde pós-deploy" });
    // no .reason (post-deploy halts, exit 20/21/23, on main today): the post-deploy check
    expect(haltedRelease({ escalationJson: "", haltedSha: "c88f99d62\n", haltedReason: "" })).toEqual({ sha: "c88f99d62", reason: "checagem pós-deploy" });
    // a .sha that is not a commit sha is no halt
    for (const junk of ["not-a-sha", "c88f", "C88F99D62", "c88f99d62 extra", "zzzzzzzzz"]) expect(haltedRelease({ escalationJson: json, haltedSha: junk, haltedReason: "" })).toBeNull();
    expect(haltedRelease({ escalationJson: "not json", haltedSha: "c88f99d62", haltedReason: "" })).toEqual({ sha: "c88f99d62", reason: "checagem pós-deploy" });
  });

  it("tells each stuck tag or halt once, across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-release-"));
    try {
      const state = new ReleaseWatchState(join(dir, "release-watch.json"));
      expect(state.once("tag:1bbd5c2a7")).toBe(true);
      expect(state.once("tag:1bbd5c2a7")).toBe(false);
      expect(new ReleaseWatchState(join(dir, "release-watch.json")).once("tag:1bbd5c2a7")).toBe(false);
      expect(state.once("halt:2995ef215")).toBe(true);
      // the release-priority decisions persist too, in a list of their own
      expect(state.isDecided("release:production:c88f99d62#40409")).toBe(false);
      state.decide("release:production:c88f99d62#40409");
      expect(new ReleaseWatchState(join(dir, "release-watch.json")).isDecided("release:production:c88f99d62#40409")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // INSP-R r2 item 3: 40+ preemption decisions pushed `halt:X` out of the alert list
  it("keeps release-priority decisions apart: they never push a halt out, and an old build's are moved", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-release-"));
    try {
      const path = join(dir, "release-watch.json");
      const state = new ReleaseWatchState(path);
      expect(state.once("halt:2995ef215")).toBe(true);
      for (let i = 0; i < 45; i += 1) state.decide(`release:production:x#${1000 + i}`);
      expect(state.once("halt:2995ef215")).toBe(false);
      expect(new ReleaseWatchState(path).once("halt:2995ef215")).toBe(false);
      expect(new ReleaseWatchState(path).isDecided("release:production:x#1044")).toBe(true);
      // the previous build wrote decisions into `told` as "preempt:…"
      writeFileSync(path, JSON.stringify({ told: ["halt:aaaaaaa1", "preempt:release:production:y#7"] }));
      const old = new ReleaseWatchState(path);
      expect(old.isDecided("release:production:y#7")).toBe(true);
      expect(old.wasTold("halt:aaaaaaa1")).toBe(true);
      expect(old.wasTold("preempt:release:production:y#7")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // INSP-R r3 item 1: only a LATER successful release supersedes a halt; main moving does not
  it("does not tell a halt only when a later release went through", () => {
    const haltedSha = "2995ef215";
    const older = "b51648498aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // released before the halt
    const later = "c88f99d62000000000000000000000000000000a";
    // exit 21 (post-release-health): production runs the halted commit, nothing released after it,
    // main moved on meanwhile — the alert goes out
    expect(haltedRelease({ escalationJson: "", haltedSha, haltedReason: "post-release-health" })?.reason).toBe("checagem de saúde pós-deploy");
    expect(haltStillMatters({ haltedSha, releasedSha: older, releasedContainsHalt: false, releasedAtMs: 1_000, haltedAtMs: 2_000 })).toBe(true);
    expect(haltStillMatters({ haltedSha, releasedSha: older, releasedContainsHalt: null, releasedAtMs: 1_000, haltedAtMs: 2_000 })).toBe(true);
    // superseded: the released sha contains it, or a later release (newer file, another sha)
    expect(haltStillMatters({ haltedSha, releasedSha: later, releasedContainsHalt: true, releasedAtMs: 3_000, haltedAtMs: 2_000 })).toBe(false);
    expect(haltStillMatters({ haltedSha, releasedSha: later, releasedContainsHalt: false, releasedAtMs: 3_000, haltedAtMs: 2_000 })).toBe(false);
    expect(haltStillMatters({ haltedSha, releasedSha: later, releasedContainsHalt: null, releasedAtMs: 3_000, haltedAtMs: 2_000 })).toBe(false);
    // the same commit "released" after its own halt is no later release; unknown times keep the alert
    expect(haltStillMatters({ haltedSha, releasedSha: "2995ef215fc784ea87387cb1550c1a733aba4dc5", releasedContainsHalt: null, releasedAtMs: 3_000, haltedAtMs: 2_000 })).toBe(true);
    expect(haltStillMatters({ haltedSha, releasedSha: later, releasedContainsHalt: null, releasedAtMs: null, haltedAtMs: 2_000 })).toBe(true);
    expect(haltStillMatters({ haltedSha, releasedSha: "", releasedContainsHalt: null, releasedAtMs: null, haltedAtMs: null })).toBe(true);
    // there is no main-tip input any more: main moving cannot silence it
    expect(haltStillMatters.length).toBe(1);
  });
});
