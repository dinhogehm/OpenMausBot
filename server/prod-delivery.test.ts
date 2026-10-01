import { describe, expect, it } from "vitest";
import { archiveBlockers, DELIVERY_CHECK_MS, IDLE_WITH_PR_MS, idleWithOpenPrs, deliveryReport, githubSlug, newDeliveryCache, parseLsRemoteTag, prLinks, prsOfSession, productionTime, watchProductionDelivery, type CcDelivery, type DeliveryDeps } from "./prod-delivery.ts";

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
    // every form git accepts, including nuria-platform's port-443 ssh origin
    expect(githubSlug("ssh://git@ssh.github.com:443/dinhogehm/nuria-platform.git")).toBe(SLUG);
    expect(githubSlug("ssh://git@github.com/dinhogehm/nuria-platform")).toBe(SLUG);
    expect(githubSlug("https://github.com/dinhogehm/nuria-platform")).toBe(SLUG);
    expect(githubSlug("https://github.com/dinhogehm/nuria-platform/")).toBe(SLUG);
    expect(githubSlug("git@github.com:dinhogehm/nuria-platform")).toBe(SLUG);
    expect(githubSlug("https://notgithub.com/a/b.git")).toBeNull();
    expect(prLinks("Merged PR #9315 and pull request #9316; issue #9295 stays open", SLUG).map((link) => link.number)).toEqual([9315, 9316]);
    // lists after one "PRs" (R8-followup F5), and still no bare issue numbers
    expect(prLinks("Mergeei as PRs #9329 e #9330; a issue #9326 segue aberta", SLUG).map((link) => link.number)).toEqual([9329, 9330]);
    expect(prLinks("PRs #9315, #9316 and #9317 are in the carrier", SLUG).map((link) => link.number)).toEqual([9315, 9316, 9317]);
    // an issue next to a PR is not a PR (INSP-F F5-a): a list only after the plural, never "/"
    const numbers = (text: string) => prLinks(text, SLUG).map((link) => link.number);
    expect(numbers("PR #9328, #9319 (issue) segue")).toEqual([9328]);
    expect(numbers("PR #9328 / #9319 é a issue")).toEqual([9328]);
    expect(numbers("PR #9328/#9319 com gate verde")).toEqual([9328]);
    expect(numbers("PRs #9328 e #9319: a primeira é a correção... a segunda issue fica aberta")).toEqual([9328]);
    expect(numbers("a PR #9328 & #9319")).toEqual([9328]);
    expect(numbers("PRs #9328 e #9319 (issue) seguem")).toEqual([9328]);
    expect(numbers("Abri a PR #9328 para a issue #9319")).toEqual([9328]);
    expect(numbers("PRs #9329 e #9330")).toEqual([9329, 9330]);
    expect(numbers("PRs #9329 & #9330 mergeadas. A issue #9326 segue aberta")).toEqual([9329, 9330]);
    // what a session archived in the app may have left open: its open deliveries and the PRs its report names
    expect(prsOfSession({ lastReport: "Abri a PR #9328 (F4-1).", delivery: { slug: SLUG, prs: { "9330": { number: 9330, url: "", state: "open" }, "9329": { number: 9329, url: "", state: "merged" } } } as unknown as CcDelivery }, SLUG).sort()).toEqual([9328, 9330]);
    expect(prsOfSession({ lastReport: "PR #9328" }, null)).toEqual([]);
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

describe("a repository whose GitHub address cannot be read", () => {
  it("is reported as not checked when archiving, never as nothing holding it", async () => {
    const { deps } = fakeDeps();
    deps.git = async () => "/local/path/not/github\n";
    expect(await archiveBlockers(session(), deps)).toEqual({ blockers: [], unknown: ["o repositório (não consegui ler o endereço do GitHub)"] });
  });
});

describe("a session idle with its PR still open", () => {
  it("is picked after hours idle with a PR not merged or closed, once a day", () => {
    const now = 100 * 3_600_000;
    const make = (id: string, extra: object) => ({ id, title: id, repo: "/r", status: "idle", lastActivityAt: now - IDLE_WITH_PR_MS - 1, delivery: { slug: SLUG, prs: { "9314": { url: "u", number: 9314, state: "open" as const } } }, ...extra });
    const waiting = make("c01aae76", {});
    const merged = make("m", { delivery: { slug: SLUG, prs: { "9315": { url: "u", number: 9315, state: "merged" as const } } } });
    const busy = make("b", { status: "running" });
    const fresh = make("f", { lastActivityAt: now - 60_000 });
    const told = make("t", { idleReportedAt: now - 3_600_000 });
    expect(idleWithOpenPrs([waiting, merged, busy, fresh, told], now)).toEqual([{ session: waiting, prs: [9314] }]);
  });
});
