import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotAutonomy } from "./bot-autonomy.ts";
import { releaseCauseKey, releaseInLoop } from "./release-watch.ts";
import { ATTENTION_FILE_MAX_BYTES, ATTENTION_MAX_AGE_MS, fullReleaseSha, haltedRelease, haltReport, productionStateLine, readTail, releaseAttention, releaseAttentionAlert, releaseAttentionDue, haltStillMatters, nothingToPublish, releaseFailureCause, releaseFailures, releaseLoopDue, releaseLoopItemsToClose, releaseLoopPending, releaseLoopPlan, releaseRetryText, ReleaseWatchState, TAG_STUCK_AFTER_MS, tagAdvancePendingTitle, tagAdvanceToResolve, tagContainsRelease, tagManualAdvance, tagStuck, tagStuckCause, tagStuckReport } from "./release-watch.ts";

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
    expect(haltedRelease({ escalationJson: json, haltedSha: "2995ef215\n", haltedReason: "" })).toEqual({ sha: "2995ef215", reasonCode: "content-failure-limit", reason: "limite de falhas de conteúdo atingido", failures: 3, lastFailure: "reconcile 0608" });
    expect(haltedRelease({ escalationJson: json, haltedSha: "2995ef215fc784ea87387cb1550c1a733aba4dc5", haltedReason: "content-failure-limit\n" })).toMatchObject({ sha: "2995ef215fc784ea87387cb1550c1a733aba4dc5", failures: 3 });
    // the owner ran `rm halted-production-release.sha` to retry: the JSON left behind is no halt
    expect(haltedRelease({ escalationJson: json, haltedSha: "", haltedReason: "" })).toBeNull();
    // the JSON of another commit: only the .sha's own sha and reason
    expect(haltedRelease({ escalationJson: json, haltedSha: "c88f99d62", haltedReason: "post-deploy-health" })).toEqual({ sha: "c88f99d62", reasonCode: "post-deploy-health", reason: "post-deploy-health" });
    // INSP-R r2 item 5: the health halt's code (#9319) in pt-BR
    expect(haltedRelease({ escalationJson: "", haltedSha: "c88f99d62", haltedReason: "post-release-health\n" })).toEqual({ sha: "c88f99d62", reasonCode: "post-release-health", reason: "checagem de saúde pós-deploy" });
    // no .reason (post-deploy halts, exit 20/21/23, on main today): the post-deploy check
    expect(haltedRelease({ escalationJson: "", haltedSha: "c88f99d62\n", haltedReason: "" })).toEqual({ sha: "c88f99d62", reasonCode: "post-release-health", reason: "checagem pós-deploy" });
    // lot P's own halt: the same failure twice after the CI, in pt-BR
    expect(haltedRelease({ escalationJson: "", haltedSha: "d5bb1f70b", haltedReason: "repeated-failure\n" })).toMatchObject({ reasonCode: "repeated-failure", reason: "a mesma falha 2× seguidas depois da CI" });
    // a .sha that is not a commit sha is no halt
    for (const junk of ["not-a-sha", "c88f", "C88F99D62", "c88f99d62 extra", "zzzzzzzzz"]) expect(haltedRelease({ escalationJson: json, haltedSha: junk, haltedReason: "" })).toBeNull();
    expect(haltedRelease({ escalationJson: "not json", haltedSha: "c88f99d62", haltedReason: "" })).toEqual({ sha: "c88f99d62", reasonCode: "post-release-health", reason: "checagem pós-deploy" });
  });

  // lot T: the halt the lot P watcher now writes on its own needs its own way out
  it("a repeated-failure halt tells both files to remove, that the next main commit goes by itself, and never asks for declined", () => {
    const files = { halted: "/h/.nuria/halted-production-release.sha", escalation: "/h/.nuria/escalations/production-release-halted.json", lastFailure: "/h/.nuria/last-failure-production-release" };
    const halted = haltedRelease({ escalationJson: '{"kind":"production-release-halted","reason":"repeated-failure","sha":"d5bb1f70b","failures":2,"last_failure":"Local CI failed at script-contracts; FAIL scripts/__tests__/unified-schema-tenant-reconcilers.test.ts"}', haltedSha: "d5bb1f70bea397bdd937d02148c685e406985ba0", haltedReason: "repeated-failure" })!;
    const { text, report } = haltReport(halted, files);
    expect(text).toBe("O watcher de produção PAROU de tentar o commit d5bb1f70b (a mesma falha 2× seguidas depois da CI, 2 falhas): ele não tenta de novo este commit sozinho.");
    expect(report).toContain("Última falha: Local CI failed at script-contracts; FAIL scripts/__tests__/unified-schema-tenant-reconcilers.test.ts.");
    expect(report).toContain("rm /h/.nuria/halted-production-release.sha /h/.nuria/last-failure-production-release");
    expect(report).toContain("Um commit novo na main (a correção num carrier) é tentado pelo watcher sozinho.");
    expect(report).toContain("Falhou igual duas vezes com o mesmo teste nomeado: é provavelmente do conteúdo do commit.");
    expect(report).toContain("Não peça ao dono para gravar declined-production-release.sha");
    // the content halt keeps its own remedy, without the failure memory
    const drift = haltReport(haltedRelease({ escalationJson: "", haltedSha: "2995ef215", haltedReason: "content-failure-limit" })!, files);
    expect(drift.report).toContain("Drift de tenant");
    expect(drift.report).not.toContain("last-failure-production-release");
  });

  // INSP-T r1 #4: a halt may be the machine; and a lot P watcher's "same" proves nothing
  it("a repeated-failure halt without a named test says it may be the machine, never that it is the content", () => {
    const files = { halted: "/h/halted", escalation: "/h/esc", lastFailure: "/h/last" };
    const flake = haltReport({ sha: "9dbb1dcdd", reasonCode: "repeated-failure", reason: "x", failures: 2, lastFailure: "Local CI failed at tests; Failed: @nuria/widget#test (timeout, unhandled)" }, files).report;
    expect(flake).toContain("pode ser carga da máquina, não do commit");
    expect(flake).not.toContain("do conteúdo do commit");
    const lotP = haltReport({ sha: "9dbb1dcdd", reasonCode: "repeated-failure", reason: "x", failures: 2, lastFailure: "Bloqueado: validacao reprovada (CRITICAL/ERROR)." }, files).report;
    expect(lotP).toContain("compara só o veredito genérico do Smart Deploy");
    expect(lotP).not.toContain("do conteúdo do commit");
  });

  // INSP-T r1 #5: the post-deploy halt latches production; the next commit is refused (exit 23)
  it("a post-deploy health halt never promises that the next commit goes by itself", () => {
    const report = haltReport(haltedRelease({ escalationJson: "", haltedSha: "c88f99d62", haltedReason: "" })!, { halted: "/h/halted", escalation: "/h/esc", lastFailure: "/h/last" }).report;
    expect(report).toContain("O próximo commit da main NÃO sai sozinho enquanto a trava pós-deploy existir");
    expect(report).toContain("NURIA_POST_RELEASE_LATCH_ACK");
    expect(report).not.toMatch(/tentado (pelo watcher )?sozinho/);
  });

  it("every release alert carries production as read now, and says so when it could not be read (R10-release #3)", () => {
    expect(productionStateLine("09d832f4bfa46e60fb6252e8da6d44471f6ec67b")).toBe("Produção agora (git ls-remote da tag nuria-production-deployed, lido neste alerta): 09d832f4b. Ao falar ao dono ou a cliente sobre o que está em produção, use este sha ou releia a tag no mesmo turno; nunca de memória.");
    expect(productionStateLine(null)).toContain("não pôde ser lida neste alerta");
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

// nuria-platform lot P: the watcher writes production-release-attention.json
// (the format of escalate_to_chief, as in the fixture) once per signature of a
// failure before the CI, or a release killed by a signal.
describe("a release that needs attention without being halted (H9)", () => {
  const FIXTURE = readFileSync(join(import.meta.dirname, "testing", "fixtures", "production-release-attention.json"), "utf8");
  const FULL = "cb015584a35296ec89b2dbaf2c54373e6f93b826";
  const now = Date.parse("2026-10-02T00:10:00Z");

  it("reads the watcher's file and says, in pt-BR, why and what to do", () => {
    const attention = releaseAttention(FIXTURE)!;
    expect(attention).toMatchObject({ sha: FULL, reason: "fast-failure", lastFailure: "git@github.com: Permission denied (publickey).", at: "2026-10-01T23:58:12Z", key: "attention:cb015584a352:fast-failure:2026-10-01T23:58:12Z" });
    expect(releaseAttentionDue(attention, { now, releasedSha: "a9e4b93ca" })).toBe(true);
    const alert = releaseAttentionAlert(attention, { err: "/x/production-release.err.log" });
    expect(alert.text).toBe("Release cb015584a: falha da máquina (ssh/git), não do commit — o watcher tenta de novo. O release falhou antes da CI ou sem veredito dela (git/ssh, npm ci, lock de admissão): é a máquina, não o commit; último erro: git@github.com: Permission denied (publickey).");
    expect(alert.report).toContain("[Alerta do servidor: release de produção pede atenção]");
    expect(alert.report).toContain("O que fazer: veja /x/production-release.err.log perto de 2026-10-01T23:58:12Z e corrija a máquina (chave ssh/acesso ao git, npm ci, um lock de admissão preso)");
    expect(alert.report).toContain("não proponha recusá-lo nem o arquivo halted");
    const signal = releaseAttention(JSON.stringify({ ...JSON.parse(FIXTURE), reason: "signal", last_failure: "exit 143" }))!;
    expect(releaseAttentionAlert(signal, { err: "e" }).report).toContain("descubra o que matou o processo");
  });

  it("tells each write once: a new signature (another time) is news, the same file read again is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-attention-"));
    try {
      const state = new ReleaseWatchState(join(dir, "release-watch.json"));
      const first = releaseAttention(FIXTURE)!;
      expect(state.once(first.key)).toBe(true);
      expect(new ReleaseWatchState(join(dir, "release-watch.json")).once(first.key)).toBe(false);
      const next = releaseAttention(JSON.stringify({ ...JSON.parse(FIXTURE), last_failure: "npm ci: EINTEGRITY", at: "2026-10-02T00:40:00Z" }))!;
      expect(next.key).not.toBe(first.key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a missing, empty, corrupt, too large, foreign, old or already released escalation", () => {
    expect(releaseAttention("")).toBeNull();
    expect(releaseAttention("{\"kind\":\"production-release-attention\",")).toBeNull();
    expect(releaseAttention("[1,2]")).toBeNull();
    expect(releaseAttention(JSON.stringify({ ...JSON.parse(FIXTURE), kind: "production-release-halted" }))).toBeNull();
    expect(releaseAttention(JSON.stringify({ ...JSON.parse(FIXTURE), sha: "not-a-sha" }))).toBeNull();
    expect(releaseAttention(`${FIXTURE}${" ".repeat(ATTENTION_FILE_MAX_BYTES)}`)).toBeNull();
    // control characters and a huge last_failure are cut, never passed on
    const noisy = releaseAttention(JSON.stringify({ ...JSON.parse(FIXTURE), last_failure: `erro\u0007\u001b[31m vermelho ${"x".repeat(1_000)}` }))!;
    expect(noisy.lastFailure!.length).toBeLessThanOrEqual(300);
    expect(noisy.lastFailure).not.toMatch(new RegExp(String.fromCharCode(27)));
    // no time: still one key per content
    expect(releaseAttention(JSON.stringify({ ...JSON.parse(FIXTURE), at: undefined }))!.key).toBe("attention:cb015584a352:fast-failure:git@github.com: Permission denied (publickey).");
    const attention = releaseAttention(FIXTURE)!;
    expect(releaseAttentionDue(attention, { now: now + ATTENTION_MAX_AGE_MS, releasedSha: "" })).toBe(false);
    expect(releaseAttentionDue(attention, { now, releasedSha: `${FULL}\n` })).toBe(false);
    expect(releaseAttentionDue(attention, { now, releasedSha: "cb015584a" })).toBe(false);
  });

  it("reads the real file robustly: missing, or larger than the limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-attention-"));
    try {
      const file = join(dir, "production-release-attention.json");
      expect(releaseAttention(readTail(file, ATTENTION_FILE_MAX_BYTES + 1))).toBeNull();
      writeFileSync(file, FIXTURE);
      expect(releaseAttention(readTail(file, ATTENTION_FILE_MAX_BYTES + 1))?.sha).toBe(FULL);
      writeFileSync(file, `${"y".repeat(5 * ATTENTION_FILE_MAX_BYTES)}${FIXTURE}`);
      expect(releaseAttention(readTail(file, ATTENTION_FILE_MAX_BYTES + 1))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// INSP-H r1 #4/#5: a failure of the MACHINE is no reason to refuse the commit,
// a refused commit closes every item about its loop (the real o7 had no key),
// and an item the owner resolved is not created again on the next check.
describe("a release loop against the machine's failures and the owner's answers", () => {
  const FULL = "cb015584a35296ec89b2dbaf2c54373e6f93b826";
  // the lot P watcher's line for a failure before the CI (git/ssh, npm ci, lock)
  const fast = (sha: string) => `Release production failed for ${sha} (exit 128), before or without a CI verdict: retried next poll`;
  const ATTENTION = JSON.stringify({ to: "chief", kind: "production-release-attention", reason: "fast-failure", sha: FULL, failures: 1, limit: 0, last_failure: "git@github.com: Permission denied (publickey).", at: "2026-10-02T00:30:00Z" });

  it("does not count failures of the machine, and asks the owner nothing for them", () => {
    const errLog = [fast("cb015584a"), "npm WARN x", fast("cb015584a"), fast("cb015584a")].join("\n");
    expect(releaseFailures(errLog, "a9e4b93ca")).toBeNull();
    // real failures before, machine failures after: only the real ones count
    expect(releaseFailures(["Release production failed for cb015584a (exit 1)", fast("cb015584a"), fast("cb015584a")].join("\n"), "")).toEqual({ sha: "cb015584a", count: 1 });
    // three real failures, but attention.json says the machine: no refusal item, only the machine alert
    const dir = mkdtempSync(join(tmpdir(), "omb-loop-plan-"));
    try {
      const state = new ReleaseWatchState(join(dir, "w.json"));
      state.observe("cb015584a", 3, 1, "Local CI failed at tests");
      const attention = releaseAttention(ATTENTION)!;
      const machine = releaseAttentionDue(attention, { now: Date.parse("2026-10-02T00:40:00Z"), releasedSha: "" });
      expect(releaseLoopPlan({ sha: "cb015584a", count: 3, halted: false, declined: false, machine, told: true, itemOpen: false, state })).toEqual({ loop: false, upsert: null, report: true });
      expect(releaseAttentionAlert(attention, { err: "e" }).report).toContain("não proponha recusá-lo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the item once per commit: resolved, it does not come back on the next checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-loop-plan-"));
    try {
      const state = new ReleaseWatchState(join(dir, "w.json"));
      state.observe("cb015584a", 3, 1, "Release de producao sem alvo de runtime");
      const base = { sha: "cb015584a", count: 3, halted: false, declined: false, machine: false, told: true, itemOpen: false, state };
      expect(releaseLoopPlan(base)).toEqual({ loop: true, upsert: "create", report: true });
      // open: refreshed only when a new failure is told, and the Chief is not woken for it (R10-followup #4)
      expect(releaseLoopPlan({ ...base, itemOpen: true, told: false })).toEqual({ loop: true, upsert: null, report: false });
      expect(releaseLoopPlan({ ...base, itemOpen: true, told: true })).toEqual({ loop: true, upsert: "refresh", report: false });
      // the owner resolved it: two more checks, nothing created and nothing told — also after a restart
      expect(releaseLoopPlan({ ...base, told: false })).toEqual({ loop: true, upsert: null, report: false });
      expect(releaseLoopPlan({ ...base, told: true, count: 4, state: new ReleaseWatchState(join(dir, "w.json")) })).toEqual({ loop: true, upsert: null, report: false });
      // refused or halted: no loop at all
      expect(releaseLoopPlan({ ...base, declined: true }).loop).toBe(false);
      expect(releaseLoopPlan({ ...base, halted: true }).loop).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes, once the commit is refused, every item about its loop — the keyless o7 too, not o1", () => {
    const items = [
      { id: "o1", title: "#9052 / PR #9332: confirmar padrão \"sem limite\" e decidir o timeout do pre-push", link: "https://github.com/o/r/pull/9332" },
      { id: "o7", title: "Autorizar pausar o watcher de produção no cb015584a (arquivo halted) para a PR #9341 passar no gate", link: "https://github.com/o/r/pull/9341" },
      { id: "o10", title: `Recusar o release em laço de cb015584a (5 falhas iguais): echo ${FULL} > ~/.nuria/declined-production-release.sha`, key: "release-loop:cb015584a" },
      { id: "o11", title: "Revisar com o QA o diff do cb015584a" },
    ];
    // declined (the real declined-production-release.sha = cb015584a…): nothing loops any more
    expect(releaseLoopItemsToClose(items, null).map((item) => item.id)).toEqual(["o7", "o10"]);
    // asking something else about the commit survives (INSP-H r2 #5)
    const check = { id: "o12", title: "Conferir no watcher se o deploy do cb015584a terminou" };
    expect(releaseLoopItemsToClose([...items, check], null).map((item) => item.id)).toEqual(["o7", "o10"]);
    // still looping on it: nothing to close; looping on another commit: these are done
    expect(releaseLoopItemsToClose(items, "cb015584a")).toEqual([]);
    expect(releaseLoopItemsToClose(items, "2995ef215").map((item) => item.id)).toEqual(["o7", "o10"]);
  });
});

// 01/10 (R9-release #1, #7; R9-resilience LOOP): the carrier cb015584a had
// nothing to publish; each try was a whole validation (~41 min) and the next
// began as the last failed. The alert said "a cada 2 min", and the Chief
// opened three items, one of them proposing the "halted" file.
describe("a release in a loop", () => {
  const FULL = "cb015584a35296ec89b2dbaf2c54373e6f93b826";
  const CAUSE = "Release de producao sem alvo de runtime (só scripts/ mudou desde a tag). Release abortado";

  it("measures the real cycle from the counts it sees, and never says \"a cada 2 min\"", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-release-loop-"));
    try {
      const path = join(dir, "release-watch.json");
      const state = new ReleaseWatchState(path);
      const at = Date.parse("2026-10-01T21:58:00Z");
      state.observe("cb015584a", 1, at, CAUSE);
      expect(state.cycleMs("cb015584a")).toBeNull();
      state.observe("cb015584a", 1, at + 120_000, CAUSE); // the same count, read again 2 min later
      state.observe("cb015584a", 2, at + 41 * 60_000, CAUSE);
      state.observe("cb015584a", 4, at + 123 * 60_000, CAUSE);
      expect(Math.round(state.cycleMs("cb015584a")! / 60_000)).toBe(41);
      // kept across a restart
      expect(Math.round(new ReleaseWatchState(path).cycleMs("cb015584a")! / 60_000)).toBe(41);
      const text = releaseRetryText({ halted: false, cycleMs: state.cycleMs("cb015584a"), nothingToPublish: nothingToPublish(CAUSE) });
      expect(text).toBe("O watcher recomeça este commit depois de uma falha e para sozinho (halt) na 2ª falha seguida depois da CI que ele considere igual à anterior; aí o servidor avisa. Cada volta leva ~41 min (medido aqui), e enquanto roda ele segura o lease de release, o que faz os gates das sessões esperarem. Não há nada para publicar neste commit: nenhuma volta vai dar certo.");
      // INSP-T r1 #4: nothing promised about what "the same" means (it depends on the installed watcher)
      expect(text).not.toMatch(/a cada 2 min|sem limite|mesmo step|mesmos testes/);
      expect(releaseRetryText({ halted: false, cycleMs: null, nothingToPublish: false })).toContain("Cada volta é uma validação completa");
      expect(releaseRetryText({ halted: true, haltCode: "repeated-failure", cycleMs: 1, nothingToPublish: true })).toBe("O watcher PAROU de tentar este commit (halt): não tenta de novo este commit, e um commit novo na main é tentado sozinho.");
      // INSP-T r1 #5: after a post-deploy halt the next commit does not go by itself (latch, exit 23)
      for (const haltCode of ["post-release-health", "post-deploy-health"]) {
        const latched = releaseRetryText({ halted: true, haltCode, cycleMs: 1, nothingToPublish: false });
        expect(latched).toContain("o próximo commit da main não sai sozinho enquanto a trava pós-deploy existir");
        expect(latched).not.toContain("tentado sozinho");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks the owner once, at 3 failures with the same cause, with the declined command and the full sha — never \"halted\"", () => {
    const seen = (causes: string[]) => ({ firstCount: 1, firstAt: 0, count: 3, at: 1, causes });
    expect(releaseLoopDue(seen([CAUSE]), 2)).toBe(false);
    expect(releaseLoopDue(seen([CAUSE]), 3)).toBe(true);
    // seen for the first time at 5 (a boot): the one cause read counts as the same
    expect(releaseLoopDue(undefined, 5)).toBe(true);
    // two different causes: bad luck (load, a timeout), not a loop
    expect(releaseLoopDue(seen([CAUSE, "ADMISSION_TIMEOUT"]), 4)).toBe(false);
    const out = `ADMISSION_GRANTED kind=release label=release:production:${FULL} pid=39238 waited=0s\n`;
    expect(fullReleaseSha(out, "cb015584a")).toBe(FULL);
    expect(fullReleaseSha(out, "2995ef215")).toBeNull();
    const item = releaseLoopPending({ short: "cb015584a", full: FULL, count: 4 });
    // the title fits two lines of "Precisa de você"; the command is copied with its own button (INSP-H r1 #8)
    expect(item).toMatchObject({ key: "release-loop:cb015584a", title: "Recusar cb015584a (laço, 4×): copie o comando de recusa", command: `echo ${FULL} > ~/.nuria/declined-production-release.sha` });
    // the commit and the verb within the first 40 characters (INSP-H r2 #6)
    expect(item.title.slice(0, 40)).toMatch(/Recusar cb015584a/);
    expect(item.title.length).toBeLessThanOrEqual(80);
    expect(`${item.title} ${item.command}`).not.toMatch(/halted/);
    // the full sha unknown: a command that writes it, still the declined file
    expect(releaseLoopPending({ short: "cb015584a", full: null, count: 3 }).command).toBe("git -C ~/Projetos/nuria-platform rev-parse cb015584a > ~/.nuria/declined-production-release.sha");
    expect(nothingToPublish("Local CI failed at tests")).toBe(false);
  });

  it("takes over the bot's own item for the same commit: one item, with the server's key and the right remedy", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-release-loop-"));
    try {
      const autonomy = new BotAutonomy({ path: join(dir, "bot-autonomy.json"), now: () => 5 });
      const o7 = autonomy.addOwnerPending("chief", "ade82a65", { title: "Autorizar pausar o watcher de produção no cb015584a (arquivo halted)", link: "https://github.com/o/r/pull/9341" });
      const loop = releaseLoopPending({ short: "cb015584a", full: FULL, count: 3 });
      const item = autonomy.addOwnerPending("chief", "dbb9f1cf", loop);
      expect(item).toMatchObject({ id: o7.id, threadId: "dbb9f1cf", key: loop.key, title: loop.title, command: loop.command, link: "https://github.com/o/r/pull/9341" });
      expect(autonomy.ownerPendingOf("chief")).toHaveLength(1);
      // the bot asking again is told it exists
      expect(autonomy.addOwnerPending("chief", "3e55c0fd", { title: "Parar o LaunchAgent? laço no cb015584a" })).toMatchObject({ id: o7.id, duplicate: true });
      // the server closes it by key once the owner refused the commit
      expect(autonomy.resolveOwnerPending({ key: loop.key }).map((each) => each.id)).toEqual([o7.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 02/10 (R10-followup #4, R10-release #3): d5bb1f70b failed 10× at
// script-contracts; between 07:18 and 13:01 the owner got 8 messages "o
// release falhou pela N-ésima vez", all asking for the same o14, whose title
// stayed at "(5 falhas iguais)".
describe("a loop with the owner's item open: the item is refreshed, nobody is woken (02/10, d5bb1f70b)", () => {
  const FULL = "d5bb1f70bea397bdd937d02148c685e406985ba0";
  const CAUSE = "Local CI failed at script-contracts";
  const T0 = Date.parse("2026-10-02T09:31:00Z");
  const CYCLE = 50 * 60_000;

  it("from the 4th failure on: only the count and the cycle in the title change; no report to the Chief", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-loop-open-"));
    try {
      const state = new ReleaseWatchState(join(dir, "release-watch.json"));
      const autonomy = new BotAutonomy({ path: join(dir, "bot-autonomy.json"), now: () => T0 });
      const reports: string[] = [];
      let itemId = "";
      // the server's checkProductionRelease, each new count as the log showed it
      for (let count = 2; count <= 10; count += 1) {
        state.observe("d5bb1f70b", count, T0 + (count - 2) * CYCLE, CAUSE);
        const told = state.take("d5bb1f70b", count);
        const loopKey = releaseLoopPending({ short: "d5bb1f70b", full: null, count }).key;
        const itemOpen = autonomy.ownerPendingOf("chief").some((item) => item.key === loopKey);
        const plan = releaseLoopPlan({ sha: "d5bb1f70b", count, halted: false, declined: false, machine: false, told, itemOpen, state });
        if (plan.upsert) itemId = autonomy.addOwnerPending("chief", "52417e4a", releaseLoopPending({ short: "d5bb1f70b", full: FULL, count, cycleMs: state.cycleMs("d5bb1f70b") })).id;
        if (plan.report) reports.push(`falhou ${count}×`);
      }
      // the 2nd failure (bad luck?) and the 3rd (the item is created): told; the 4th to the 10th: not
      expect(reports).toEqual(["falhou 2×", "falhou 3×"]);
      const items = autonomy.ownerPendingOf("chief");
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id: itemId, key: "release-loop:d5bb1f70b", title: "Recusar d5bb1f70b (laço, 10×, volta de ~50 min): copie o comando de recusa", command: `echo ${FULL} > ~/.nuria/declined-production-release.sha` });
      expect(items[0]!.title.length).toBeLessThanOrEqual(80);
      // the resolution screen has something to show: why, the step with the command, and two answers
      expect(items[0]!.why).toMatch(/segura a fila de CI/);
      expect(items[0]!.steps?.[0]).toMatchObject({ command: `echo ${FULL} > ~/.nuria/declined-production-release.sha` });
      expect(items[0]!.options?.map((option) => option.label)).toEqual(["Já gravei a recusa", "Deixar tentar"]);
      // a new cause is not the same loop: the Chief hears it
      state.observe("d5bb1f70b", 11, T0 + 9 * CYCLE, "ADMISSION_TIMEOUT waiting for lease");
      const plan = releaseLoopPlan({ sha: "d5bb1f70b", count: 11, halted: false, declined: false, machine: false, told: state.take("d5bb1f70b", 11), itemOpen: true, state });
      expect(plan).toEqual({ loop: false, upsert: null, report: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // INSP-J r1 #1: the real release-watch.json of 02/10 kept the one failure
  // of d5bb1f70b as 5 causes — each with its own log path (redacted folder).
  const REAL_CAUSES = [
    "5RILoB/release-ci-output/20261002T125749Z-release-d5bb1f70bea3-74689",
    "iazcpu/release-ci-output/20261002T134623Z-release-d5bb1f70bea3-51813",
    "DC4FUf/release-ci-output/20261002T143806Z-release-d5bb1f70bea3-8813",
    "d4Z9Xl/release-ci-output/20261002T152130Z-release-d5bb1f70bea3-88013",
    "u9pRC1/release-ci-output/20261002T162258Z-release-d5bb1f70bea3-49910",
  ].map((tail) => `Local CI failed at script-contracts. Logs: /private/var/folders/xx/redacted/T/nuria-smart-deploy.${tail}`);

  it("one failure is one cause, whatever log path each try printed — and the causes already saved are read that way", () => {
    expect(new Set(REAL_CAUSES.map(releaseCauseKey))).toEqual(new Set(["Local CI failed at script-contracts"]));
    // what still tells two failures apart stays
    expect(releaseCauseKey("Tenant nuria-ws-01a0ed885c1a reprovou inspecao da migration 0608")).toContain("migration 0608");
    expect(releaseCauseKey("ADMISSION_TIMEOUT waited=2700s pid=4411 at 2026-10-02T12:57:49Z")).toBe("ADMISSION_TIMEOUT waited=2700s at");
    const dir = mkdtempSync(join(tmpdir(), "omb-loop-causes-"));
    try {
      const path = join(dir, "release-watch.json");
      // the file as the fc0326c3 build left it
      writeFileSync(path, JSON.stringify({ alerted: { d5bb1f70b: 10 }, told: ["loop-item:d5bb1f70b"], seen: { d5bb1f70b: { firstCount: 1, firstAt: T0, count: 10, at: T0 + 9 * CYCLE, causes: REAL_CAUSES } } }));
      const state = new ReleaseWatchState(path);
      expect(state.seenOf("d5bb1f70b")?.causes).toEqual(["Local CI failed at script-contracts"]);
      // the 11th try, another log path: still one cause, still a loop
      state.observe("d5bb1f70b", 11, T0 + 10 * CYCLE, REAL_CAUSES[4]!.replace("u9pRC1", "Zz9Q1a"));
      expect(state.seenOf("d5bb1f70b")?.causes).toHaveLength(1);
      expect(releaseLoopDue(state.seenOf("d5bb1f70b"), 11)).toBe(true);
      const told = state.take("d5bb1f70b", 11);
      expect(releaseLoopPlan({ sha: "d5bb1f70b", count: 11, halted: false, declined: false, machine: false, told, itemOpen: true, state })).toEqual({ loop: true, upsert: "refresh", report: false });
      // the item closed ("Deixar tentar"): a session's CI is still left alone
      expect(releaseInLoop({ sha: FULL, failures: { sha: "d5bb1f70b", count: 11 }, seen: state.seenOf("d5bb1f70b"), itemOpen: false, declined: "" })).toBe("o d5bb1f70b já falhou 11× seguidas pela mesma causa (CI local falhou em script-contracts)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the same report still waiting for the Chief's turn is queued once", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-loop-report-"));
    try {
      const autonomy = new BotAutonomy({ path: join(dir, "bot-autonomy.json"), now: () => T0 });
      const report = "[Alerta do servidor: release de produção falhando] Release d5bb1f70b falhou 3× seguidas (CI local falhou em script-contracts)";
      autonomy.addReport("chief", "52417e4a", report);
      autonomy.addReport("chief", "52417e4a", report);
      autonomy.addReport("chief", "52417e4a", "[Sessão Claude Code \"9347\"] PR aberta");
      expect(autonomy.takeReports("52417e4a")?.items).toEqual([report, "[Sessão Claude Code \"9347\"] PR aberta"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
