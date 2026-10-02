// The release log as the productivity report reads it (lot V): runs dated from
// the review report + deploy durations, failures with their own verdict,
// refusals, the run still in progress — on an excerpt of the real watcher log
// (paths and branch names anonymized), plain and gzipped, whole and in pieces.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyLiveWithoutTag, clockAfter, clockNear, emptyReleaseLogState, liveWithoutTagShas, feedReleaseLogFile, finishReleaseLog, parseReleaseLogText, pushReleaseLogLine,
} from "./productivity-release-log.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fixtures", "productivity", "production-release.out.log");
const text = readFileSync(FIXTURE, "utf8");
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const temp = mkdtempSync(join(tmpdir(), "omb-release-log-"));
afterAll(() => removeTempDir(temp));

describe("release log runs (real excerpt)", () => {
  const result = parseReleaseLogText(text, { endOfStream: true });
  const runs = result.runs.map((run) => ({ sha: run.sha.slice(0, 9), pid: run.pid, outcome: run.outcome, timeSource: run.timeSource, startedAt: iso(run.startedAt), endedAt: iso(run.endedAt), cause: run.cause, carrierPr: run.carrierPr }));

  it("reads every attempt in order, with its carrier PR", () => {
    expect(runs.map((run) => `${run.sha}:${run.pid}:${run.outcome}:${run.carrierPr}`)).toEqual([
      "f50b70a3d:83261:failed:8983",
      "f50b70a3d:76716:failed:8983",
      "f50b70a3d:86574:released:8983",
      "3f99428bf:6552:failed:8989",
      "a76a5aa0c:51819:released:8990",
      "cb015584a:91010:failed:9339",
      "9dbb1dcdd:56366:running:9360",
    ]);
  });

  it("dates a release by the deploy's end: review date − its duration + the deploy's total", () => {
    // 12:13:10 − 306 s + 4751 s; 14:59:34 − 320 s + 4919 s
    expect(runs[2]).toMatchObject({ timeSource: "log", startedAt: "2026-09-17T11:45:09.000Z", endedAt: "2026-09-17T13:27:15.000Z" });
    expect(runs[4]).toMatchObject({ timeSource: "log", startedAt: "2026-09-17T14:16:03.000Z", endedAt: "2026-09-17T16:16:13.000Z" });
  });

  it("dates a run with only CI clocks by its neighbours, and one with nothing by the run before it", () => {
    expect(runs[0]).toMatchObject({ timeSource: "log-clock", startedAt: "2026-09-17T01:33:57.000Z", endedAt: "2026-09-17T01:52:31.000Z" });
    expect(runs[1]).toMatchObject({ timeSource: "neighbor", startedAt: "2026-09-17T01:52:31.000Z", endedAt: "2026-09-17T01:52:31.000Z" });
    // after the 22:02 failure, a 23:40 clock is the same evening
    expect(runs[6]).toMatchObject({ timeSource: "log-clock", startedAt: "2026-09-17T23:40:02.000Z" });
  });

  it("keeps each failure's own verdict without paths, hashes or times", () => {
    expect(runs[0]!.cause).toBe("Local CI failed at smart-deploy");
    expect(runs[1]!.cause).toBe("Nao foi possivel inicializar smart-deploy");
    expect(runs[3]!.cause).toBe("Integridade do snapshot Git: drift detectado em imediatamente antes da mutacao remota de deploy");
    expect(runs[5]!.cause).toBe("Release de producao sem alvo de runtime: nenhum Worker, web ou widget mudou desde o recibo");
    expect(runs[5]!.endedAt).toBe("2026-09-17T22:02:49.000Z");
  });

  it("ignores the workspaces' test output (its fixed clocks are not the release's)", () => {
    expect(result.runs.every((run) => (run.startedAt ?? 0) >= Date.parse("2026-09-17T00:00:00Z"))).toBe(true);
  });

  it("counts a refusal once per commit, at the time it was logged", () => {
    expect(result.declines).toEqual([{ sha: "cb015584a", at: Date.parse("2026-09-17T22:02:49Z"), timeSource: "neighbor" }]);
  });

  it("says which span of time the text covers", () => {
    expect(iso(result.from)).toBe("2026-09-17T01:33:57.000Z");
    expect(iso(result.to)).toBe("2026-09-17T23:41:30.000Z");
  });
});

describe("release log, edge cases", () => {
  it("a run cut off by the next one is a failure, marked interrupted; the last open run is running only at the end of the stream", () => {
    const lines = [
      "ADMISSION_INTENT kind=release label=release:production:1111111111111111111111111111111111111111 pid=1",
      "[10:00:00] build",
      "ADMISSION_INTENT kind=release label=release:production:2222222222222222222222222222222222222222 pid=2",
      "[10:30:00] build",
    ].join("\n");
    const closedStream = parseReleaseLogText(lines);
    expect(closedStream.runs.map((run) => [run.pid, run.outcome, run.interrupted ?? false])).toEqual([[1, "failed", true], [2, "failed", true]]);
    const live = parseReleaseLogText(lines, { endOfStream: true });
    expect(live.runs.map((run) => [run.pid, run.outcome])).toEqual([[1, "failed"], [2, "running"]]);
  });

  it("a no-op release (nothing to publish) is neither a delivery nor a failure", () => {
    const result = parseReleaseLogText([
      "ADMISSION_INTENT kind=release label=release:production:3333333333333333333333333333333333333333 pid=3",
      "  2026-10-02T10:00:00.000Z LH:status Generating results...",
      "ADMISSION_RELEASED kind=release pid=3",
      "Release of 333333333 is a no-op: no runtime target differs from the deployed receipt; nothing published",
    ].join("\n"));
    expect(result.runs[0]!.outcome).toBe("noop");
  });

  it("strips terminal colours before reading a line", () => {
    const esc = String.fromCharCode(27);
    const state = emptyReleaseLogState();
    pushReleaseLogLine(state, "ADMISSION_INTENT kind=release label=release:production:4444444444444444444444444444444444444444 pid=4");
    pushReleaseLogLine(state, `${esc}[0;32m[OK]${esc}[0m Concluido! (100s)`);
    pushReleaseLogLine(state, `**Data:** 2026-10-02T10:00:00Z | **Branch:**  | **Commit:** 444444444 | **Duracao:** 50s`);
    pushReleaseLogLine(state, "Certification tag nuria-production-deployed advanced to 4444444444444444444444444444444444444444");
    pushReleaseLogLine(state, "ADMISSION_RELEASED kind=release pid=4");
    const [run] = finishReleaseLog(state).runs;
    expect(run).toMatchObject({ outcome: "released", timeSource: "log", endedAt: Date.parse("2026-10-02T10:00:50Z") });
  });

  it("a deploy that went live while the tag push was refused is a delivery, dated by its deploy (real case 1bbd5c2a7)", () => {
    const sha = "1bbd5c2a72a2ed67bc5a6a0d163f3ac2df576e44";
    const parsed = parseReleaseLogText([
      `ADMISSION_INTENT kind=release label=release:production:${sha} pid=19470`,
      "[12:19:27] build",
      `**Data:** 2026-10-01T13:01:27Z | **Branch:**  | **Commit:** 1bbd5c2a7 | **Duracao:** 300s`,
      "[OK] Concluido! (10568s)",
      "ADMISSION_RELEASED kind=release pid=19470",
    ].join("\n"));
    expect(parsed.runs[0]).toMatchObject({ outcome: "failed", deployedAt: Date.parse("2026-10-01T13:01:27Z") - 300_000 + 10_568_000 });
    const err = [
      " ! [remote rejected]     nuria-production-deployed -> nuria-production-deployed (push declined due to repository rule violations)",
      `WARNING: production is live at ${sha} but the certification tag was NOT advanced (exit 1)`,
    ].join("\n");
    expect(liveWithoutTagShas(err)).toEqual([sha]);
    const [run] = applyLiveWithoutTag(parsed.runs, liveWithoutTagShas(err));
    expect(run).toMatchObject({ outcome: "released", tagNotAdvanced: true, endedAt: parsed.runs[0]!.deployedAt });
    expect(run!.cause).toBeUndefined();
    // a run that never finished its deploy stays a failure
    const unfinished = parseReleaseLogText(`ADMISSION_INTENT kind=release label=release:production:${sha} pid=1\nADMISSION_RELEASED kind=release pid=1`);
    expect(applyLiveWithoutTag(unfinished.runs, [sha])[0]!.outcome).toBe("failed");
  });

  it("a certification for another commit does not release this run", () => {
    const result = parseReleaseLogText([
      "ADMISSION_INTENT kind=release label=release:production:5555555555555555555555555555555555555555 pid=5",
      "Certification tag nuria-production-deployed advanced to 6666666666666666666666666666666666666666",
      "ADMISSION_RELEASED kind=release pid=5",
    ].join("\n"));
    expect(result.runs[0]!.outcome).toBe("failed");
  });

  it("clock readings land on the nearest day, or the first one after a bound", () => {
    const noon = Date.parse("2026-10-01T12:00:00Z");
    expect(iso(clockNear(23 * 3600 + 50 * 60, Date.parse("2026-10-02T00:10:00Z")))).toBe("2026-10-01T23:50:00.000Z");
    expect(iso(clockNear(10 * 3600, noon))).toBe("2026-10-01T10:00:00.000Z");
    expect(iso(clockAfter(1 * 3600, Date.parse("2026-10-01T23:00:00Z")))).toBe("2026-10-02T01:00:00.000Z");
    // a few minutes "behind" the bound is the same moment seen late
    expect(iso(clockAfter(11 * 3600 + 58 * 60, noon))).toBe("2026-10-01T11:58:00.000Z");
  });
});

describe("release log files", () => {
  it("reads a gzipped rotation and the live file on top of it, as one stream", async () => {
    const lines = text.split("\n");
    const cut = lines.findIndex((line) => line.includes("pid=6552")); // mid-stream, between two runs
    const gz = join(temp, "production-release.out.log.1.gz");
    const live = join(temp, "production-release.out.log");
    writeFileSync(gz, gzipSync(lines.slice(0, cut).join("\n")));
    writeFileSync(live, lines.slice(cut).join("\n"));
    const state = emptyReleaseLogState();
    await feedReleaseLogFile(state, gz);
    const snapshot = structuredClone(state);
    await feedReleaseLogFile(state, live);
    const split = finishReleaseLog(state, { endOfStream: true });
    const whole = parseReleaseLogText(text, { endOfStream: true });
    expect(split.runs).toEqual(whole.runs);
    // the state after the .gz is plain data: replaying the live file on a copy gives the same answer
    await feedReleaseLogFile(snapshot, live);
    expect(finishReleaseLog(snapshot, { endOfStream: true }).runs).toEqual(whole.runs);
  });
});
