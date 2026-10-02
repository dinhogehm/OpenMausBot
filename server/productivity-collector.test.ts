// The productivity collector (lot V): the release history survives the log's
// rotation, the "Precisa de você" log keeps ids and times only, a sync that
// fails or hits the rate limit says so without losing the cache, a report is
// built from the cache while GitHub is still being read, and manual refreshes
// are throttled.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { presetPeriod } from "../shared/productivity.ts";
import { MANUAL_SYNC_MIN_MS, oldestUsageAt, ProductivityCollector } from "./productivity-collector.ts";
import type { GhRunner } from "./productivity-github.ts";
import { mergeNeedsYou, ownerResponseMs, emptyNeedsYouLog } from "./productivity-local.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { brt } from "./testing/productivity-fixture.ts";

const temp = mkdtempSync(join(tmpdir(), "omb-productivity-"));
afterAll(() => removeTempDir(temp));
let dirCount = 0;
const freshDir = () => {
  const dir = join(temp, `case-${dirCount++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const RUN = (sha: string, pid: number, data: string, released = true) => [
  `ADMISSION_INTENT kind=release label=release:production:${sha} pid=${pid}`,
  `  ${data.replace("Z", ".000Z")} LH:status Generating results...`,
  `**Data:** ${data} | **Branch:**  | **Commit:** ${sha.slice(0, 9)} | **Duracao:** 300s`,
  "[OK] Concluido! (900s)",
  ...(released ? [`Certification tag nuria-production-deployed advanced to ${sha}`] : ["[ERROR] Release abortado"]),
  `ADMISSION_RELEASED kind=release pid=${pid}`,
].join("\n");

/** A gh that answers an empty repository, or fails / runs out of budget on demand. */
function quietGh(mode: { fail?: string; lowBudget?: boolean; delayMs?: number } = {}): GhRunner & { calls: number } {
  const runner = (async (args: string[]) => {
    runner.calls += 1;
    if (mode.delayMs) await new Promise((resolve) => setTimeout(resolve, mode.delayMs));
    if (mode.fail) throw new Error(mode.fail);
    if (args[1] === "graphql") {
      const connection = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
      return JSON.stringify({ data: { repository: { pullRequests: connection, issues: connection }, rateLimit: { remaining: mode.lowBudget ? 10 : 4000, resetAt: "2026-10-02T20:00:00Z" } } });
    }
    // REST resets at the same moment as GraphQL here (2026-10-02T20:00Z, in seconds)
    if (args[1] === "rate_limit") return JSON.stringify({ resources: { core: { remaining: mode.lowBudget ? 10 : 4000, reset: 1_790_971_200 } } });
    if (args[1]!.includes("/git/ref/tags/")) return JSON.stringify({ object: { sha: "a".repeat(40), type: "commit" } });
    if (args[1]!.includes("/deployments")) return "[]";
    if (args[1]!.includes("/compare/")) return JSON.stringify({ total_commits: 0, commits: [] });
    throw new Error(`unexpected ${args.join(" ")}`);
  }) as GhRunner & { calls: number };
  runner.calls = 0;
  return runner;
}

function collector(dir: string, gh: GhRunner, open: Array<{ id: string; botId: string; createdAt: number }> = [], now = () => brt("2026-10-02T12:00:00")) {
  return new ProductivityCollector({
    dataDir: dir, gh, now,
    logs: { gz: join(dir, "logs", "out.log.1.gz"), out: join(dir, "logs", "out.log") },
    ownerPending: () => ({ open, resolved: [] }),
    botNames: () => new Map([["chief", "Chief of Staff"]]),
    usage: () => [],
    digests: () => [],
    oldestDigestAt: () => null,
    usageFrom: () => null,
  });
}

describe("needs-you log", () => {
  it("keeps ids and times, closes what vanished, and measures the owner's response", () => {
    const now = brt("2026-10-02T12:00:00");
    let log = mergeNeedsYou(emptyNeedsYouLog(), {
      now,
      open: [
        { id: "o1", botId: "chief", createdAt: brt("2026-10-02T09:00:00"), history: [{ at: brt("2026-10-02T09:20:00"), by: "owner" }], title: "Cliente Acme" } as never,
        { id: "o2", botId: "chief", createdAt: brt("2026-10-02T10:00:00") },
      ],
      resolved: [{ id: "o0", botId: "lead", createdAt: brt("2026-10-01T10:00:00"), resolvedAt: brt("2026-10-01T11:00:00"), resolvedBy: "owner" }],
    });
    expect(JSON.stringify(log)).not.toContain("Acme");
    expect(log.items["chief:o1"]).toEqual({ id: "o1", botId: "chief", createdAt: brt("2026-10-02T09:00:00"), resolvedAt: null, resolvedBy: null, ownerFirstAnswerAt: brt("2026-10-02T09:20:00") });
    expect(ownerResponseMs(log.items["chief:o1"]!)).toBe(20 * 60_000);
    expect(ownerResponseMs(log.items["lead:o0"]!)).toBe(3_600_000);
    expect(ownerResponseMs(log.items["chief:o2"]!)).toBeNull();
    // o2 is gone without a settled record: closed when it was found missing
    log = mergeNeedsYou(log, { now: now + 60_000, open: [{ id: "o1", botId: "chief", createdAt: brt("2026-10-02T09:00:00") }], resolved: [] });
    expect(log.items["chief:o2"]).toMatchObject({ resolvedAt: now + 60_000, resolvedBy: "unknown" });
    // the first answer is kept even when a later look no longer has the history
    expect(log.items["chief:o1"]!.ownerFirstAnswerAt).toBe(brt("2026-10-02T09:20:00"));
    expect(log.startedAt).toBe(now);
  });
});

describe("collector", () => {
  it("keeps the release history across a rotation and replays the live log on the rotated one", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, "logs"));
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    writeFileSync(join(dir, "logs", "out.log"), RUN(a, 1, "2026-10-01T10:00:00Z"));
    const first = collector(dir, quietGh());
    await first.refresh();
    expect(first.report("month", presetPeriod("month", 1, brt("2026-10-02T12:00:00"))).kpis.deliveries).toBe(1);
    // rotation: the old text is gone from both files, a new release arrives
    writeFileSync(join(dir, "logs", "out.log.1.gz"), gzipSync(RUN(b, 2, "2026-10-02T10:00:00Z")));
    writeFileSync(join(dir, "logs", "out.log"), "No new origin/main tip (already released: bbbbbbbbb)\n");
    const second = collector(dir, quietGh()); // a restart, reading the saved history
    await second.refresh();
    const report = second.report("month", presetPeriod("month", 1, brt("2026-10-02T12:00:00")));
    expect(report.kpis.deliveries).toBe(2);
    expect(report.releases.map((row) => row.sha[0])).toEqual(["b", "a"]);
    const saved = JSON.parse(readFileSync(join(dir, "productivity", "releases.json"), "utf8"));
    expect(Object.keys(saved.runs).sort()).toEqual([`${a}:1`, `${b}:2`]);
  });

  it("reads the err log for deploys that went live without the tag, and remembers them after the err log is cleared", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, "logs"));
    const sha = "c".repeat(40);
    writeFileSync(join(dir, "logs", "out.log"), RUN(sha, 7, "2026-10-01T13:01:27Z", false));
    writeFileSync(join(dir, "logs", "err.log"), `WARNING: production is live at ${sha} but the certification tag was NOT advanced (exit 1)\n`);
    const make = () => new ProductivityCollector({
      dataDir: dir, gh: quietGh(), now: () => brt("2026-10-02T12:00:00"),
      logs: { gz: join(dir, "logs", "out.log.1.gz"), out: join(dir, "logs", "out.log"), err: join(dir, "logs", "err.log") },
      ownerPending: () => ({ open: [], resolved: [] }), botNames: () => new Map(), usage: () => [], digests: () => [], oldestDigestAt: () => null, usageFrom: () => null,
    });
    const first = make();
    await first.refreshLogs();
    const period = presetPeriod("month", 1, brt("2026-10-02T12:00:00"));
    expect(first.report("month", period).kpis).toMatchObject({ deliveries: 1, failedReleases: 0 });
    expect(first.report("month", period).releases[0]).toMatchObject({ outcome: "released", tagNotAdvanced: true });
    writeFileSync(join(dir, "logs", "err.log"), "");
    const second = make();
    await second.refreshLogs();
    expect(second.report("month", period).kpis.deliveries).toBe(1);
  });

  it("a failed sync says why and keeps what it had", async () => {
    const dir = freshDir();
    const broken = collector(dir, quietGh({ fail: "gh: To get started with GitHub CLI, please run: gh auth login" }));
    await broken.refresh();
    expect(broken.state()).toMatchObject({ state: "error", error: "gh: To get started with GitHub CLI, please run: gh auth login" });
    expect(broken.report("day", presetPeriod("day", 30, brt("2026-10-02T12:00:00"))).sync.state).toBe("error");
  });

  it("stops before the rate limit and waits for the reset", async () => {
    const dir = freshDir();
    const limited = collector(dir, quietGh({ lowBudget: true }));
    await limited.refresh();
    expect(limited.state()).toMatchObject({ state: "rate-limited", rateLimit: { resetAt: Date.parse("2026-10-02T20:00:00Z") } });
    expect(limited.state().nextSyncAt).toBe(Date.parse("2026-10-02T20:00:00Z"));
  });

  it("answers a report while GitHub is still being read, and throttles manual refreshes", async () => {
    const dir = freshDir();
    let clock = brt("2026-10-02T12:00:00");
    const gh = quietGh({ delayMs: 30 });
    const slow = collector(dir, gh, [{ id: "o1", botId: "chief", createdAt: brt("2026-10-02T11:00:00") }], () => clock);
    expect(slow.requestSync()).toBe(true);
    // the sync is running: the report comes from the cache right away
    const report = slow.report("hour", presetPeriod("hour", 48, clock));
    expect(report.sync.state).toBe("syncing");
    expect(slow.requestSync()).toBe(false); // one at a time
    await slow.refresh();
    expect(slow.state().state).toBe("idle");
    expect(slow.requestSync()).toBe(false); // too soon after the last one
    clock += MANUAL_SYNC_MIN_MS + 1;
    expect(slow.requestSync()).toBe(true);
    await slow.refresh();
    // the item seen open is in the log
    expect(slow.report("hour", presetPeriod("hour", 48, clock)).kpis.needsYouOpened).toBe(1);
  });

  it("finds the oldest turn of the usage ledger", () => {
    const dir = freshDir();
    mkdirSync(join(dir, "usage"));
    writeFileSync(join(dir, "usage", "2026-09.jsonl"), `{"at":"2026-09-28T23:14:47.458Z"}\n{"at":"2026-09-29T10:00:00.000Z"}\n`);
    writeFileSync(join(dir, "usage", "2026-10.jsonl"), `{"at":"2026-10-01T00:00:00.000Z"}\n`);
    expect(oldestUsageAt(dir)).toBe(Date.parse("2026-09-28T23:14:47.458Z"));
    expect(oldestUsageAt(freshDir())).toBeNull();
  });
});
