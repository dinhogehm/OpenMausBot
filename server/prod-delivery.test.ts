import { describe, expect, it } from "vitest";
import { archiveBlockers, DELIVERY_CHECK_MS, deliveryReport, githubSlug, newDeliveryCache, parseLsRemoteTag, prLinks, productionTime, watchProductionDelivery, type CcDelivery, type DeliveryDeps } from "./prod-delivery.ts";

const SLUG = "dinhogehm/nuria-platform";
const TAG = "c".repeat(40);
const MERGE = "m".repeat(40);

function fakeDeps(over: Partial<{ state: string; compare: string; tag: string | null }> = {}) {
  const calls: string[][] = [];
  const reports: string[] = [];
  const chips: string[] = [];
  let now = Date.UTC(2026, 8, 30, 19, 0);
  const deps: DeliveryDeps = {
    now: () => now,
    gh: async (args) => {
      calls.push(args);
      if (args[0] === "pr") return JSON.stringify({ state: over.state ?? "MERGED", mergeCommit: { oid: MERGE } });
      if (args[1]!.includes("/compare/")) return `${over.compare ?? "ahead"}\n`;
      if (args[1]!.includes("/commits/")) return "2026-09-30T19:40:00Z\n";
      throw new Error("unexpected");
    },
    git: async (_repo, args) => {
      if (args[0] === "remote") return `git@github.com:${SLUG}.git\n`;
      calls.push(["git", ...args]);
      const tag = over.tag === undefined ? TAG : over.tag;
      return tag ? `abc123\trefs/tags/nuria-production-deployed\n${tag}\trefs/tags/nuria-production-deployed^{}\n` : "";
    },
    report: (_session, text) => { reports.push(text); },
    chip: (_session, text) => { chips.push(text); },
    save: () => {},
  };
  return { deps, calls, reports, chips, advance: (ms: number) => { now += ms; } };
}

const session = (): { id: string; title: string; repo: string; status: string; lastReport: string; delivery?: CcDelivery } => ({ id: "s1", title: "#9311 fix login", repo: "/repo", status: "idle", lastReport: `Done. PR: https://github.com/${SLUG}/pull/9400 (depends on https://github.com/other/repo/pull/5)` });

describe("delivery in production", () => {
  it("reads PR links of the session's own repository, origin slugs and the peeled tag", () => {
    expect(prLinks(session().lastReport, SLUG)).toEqual([{ url: `https://github.com/${SLUG}/pull/9400`, number: 9400 }]);
    expect(githubSlug("https://github.com/dinhogehm/nuria-platform.git")).toBe(SLUG);
    expect(githubSlug("git@github.com:dinhogehm/nuria-platform.git")).toBe(SLUG);
    expect(githubSlug("git@gitlab.com:a/b.git")).toBeNull();
    expect(parseLsRemoteTag(`aaa\trefs/tags/x\nbbb\trefs/tags/x^{}\n`, "x")).toBe("bbb");
    expect(parseLsRemoteTag(`aaa\trefs/tags/x\n`, "x")).toBe("aaa");
    expect(parseLsRemoteTag("", "x")).toBeNull();
    expect(productionTime("2026-09-30T19:40:00Z")).toBe("30/09 16:40");
  });

  it("reports once, with the time, when the production tag contains the merge", async () => {
    const { deps, reports, chips, calls, advance } = fakeDeps();
    const cache = newDeliveryCache();
    const s = session();
    await watchProductionDelivery([s], deps, cache);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("em produção desde 30/09 16:40");
    expect(reports[0]).toContain("cc_session_archive");
    expect(reports[0]).toContain("No ID, no notice");
    expect(chips[0]).toContain("PR #9400");
    const before = calls.length;
    advance(DELIVERY_CHECK_MS);
    await watchProductionDelivery([s], deps, cache);
    expect(reports).toHaveLength(1);
    expect(calls.length).toBe(before);
  });

  it("keeps waiting while the tag is behind the merge, and re-reads it only every 10 min", async () => {
    const waiting = fakeDeps({ compare: "diverged" });
    const cache = newDeliveryCache();
    const s = session();
    await watchProductionDelivery([s], waiting.deps, cache);
    expect(waiting.reports).toEqual([]);
    const lsRemotes = () => waiting.calls.filter((call) => call[0] === "git").length;
    expect(lsRemotes()).toBe(1);
    waiting.advance(60_000);
    await watchProductionDelivery([s], waiting.deps, cache);
    expect(lsRemotes()).toBe(1);
    expect(waiting.calls.filter((call) => call[0] === "api").length).toBe(1);
  });

  it("stops at closed PRs, repositories without the tag and archived sessions", async () => {
    const closed = fakeDeps({ state: "CLOSED" });
    const s = session();
    await watchProductionDelivery([s], closed.deps, newDeliveryCache());
    expect(s.delivery?.prs["9400"]?.state).toBe("closed");
    expect(closed.reports).toEqual([]);
    const untagged = fakeDeps({ tag: null });
    await watchProductionDelivery([session()], untagged.deps, newDeliveryCache());
    expect(untagged.calls.filter((call) => call[0] === "pr")).toEqual([]);
    const archived = fakeDeps();
    await watchProductionDelivery([{ ...session(), status: "archived" }], archived.deps, newDeliveryCache());
    expect(archived.calls).toEqual([]);
    expect(deliveryReport({ id: "s", title: "t" }, [{ url: "u", number: 1, mergeSha: MERGE, productionSince: "30/09 16:40" }], TAG)).toContain("PR #1 (u)");
  });
});

describe("archiving before delivery", () => {
  it("holds a session whose PR is open or whose merge is not in production, and says why", async () => {
    const open = fakeDeps({ state: "OPEN" });
    expect((await archiveBlockers(session(), open.deps)).blockers).toEqual(["a PR #9400 ainda está aberta"]);
    const behind = fakeDeps({ compare: "diverged" });
    expect((await archiveBlockers(session(), behind.deps)).blockers).toEqual(["a PR #9400 foi mergeada mas ainda não está em nuria-production-deployed"]);
    const shipped = fakeDeps({ compare: "ahead" });
    expect(await archiveBlockers(session(), shipped.deps)).toEqual({ blockers: [], unknown: [] });
    const closed = fakeDeps({ state: "CLOSED" });
    expect((await archiveBlockers(session(), closed.deps)).blockers).toEqual([]);
    const noTag = fakeDeps({ tag: null });
    expect((await archiveBlockers(session(), noTag.deps)).blockers).toEqual([]);
    const offline = fakeDeps();
    offline.deps.gh = async () => { throw new Error("gh: not logged in"); };
    expect(await archiveBlockers(session(), offline.deps)).toEqual({ blockers: [], unknown: ["PR #9400"] });
  });
});
