import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { HANDOFF_RESULT_CONTRACT, ROUTINE_RESULT_CONTRACT } from "./result-contract.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { ownTurnText } from "./testing/room-handoff-agent.ts";

// The desktop app runs with the result contract on (server/result-contract.ts):
// a routine run that ends without a proved RESULTADO is not completed.
it("with the result contract on, a routine run completes only on a declared, proved RESULTADO", async () => {
  const state = join(mkdtempSync(join(tmpdir(), "omb-result-contract-")), "replies");
  const fixture = await launchVerificationServer({
    ...process.env,
    OMB_RESULT_CONTRACT: "1",
    FAKE_CLAUDE_REPLY_STATE: state,
    FAKE_CLAUDE_REPLIES: JSON.stringify([
      "Terminei a revisão do Sentry.",
      "Revisei o Sentry.\nRESULTADO: feito — comentei https://github.com/o/r/issues/1#issuecomment-2",
    ]),
  });
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const runState = async (id: string) => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === id);
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Contrato", "--url", fixture.info.url]) as any;
    const { routine } = await api("POST", "/api/routines", {
      name: "Revisão do Sentry", prompt: "Revise o Sentry.", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    const first = (await api("POST", `/api/routines/${routine.id}/run`, undefined, 201)).run;
    await expect.poll(async () => (await runState(first.id))?.status, { timeout: 20_000 }).toBe("failed");
    expect((await runState(first.id)).error).toBe("Resultado não verificado: a resposta não terminou com a linha RESULTADO");
    // the run's prompt asked for the line
    expect(JSON.stringify(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt)).toContain("RESULTADO: feito");
    const second = (await api("POST", `/api/routines/${routine.id}/run`, undefined, 201)).run;
    await expect.poll(async () => (await runState(second.id))?.status, { timeout: 20_000 }).toBe("completed");
  } finally {
    await fixture.close();
  }
}, 90_000);

// ── hand-offs under the contract (this fork) ────────────────────────────

/** Every resume of a requester opens with this (runtime/envelope.ts composeResume). */
const SETTLED = "Your downstream room requests have settled.";
/** The report envelope's opening for the teammate's result (composeReport). */
const REPORT_FROM_PEER = "[OpenMausBot report from @Peer";
/** A line only the routine's contract has, and one only a teammate's request has. */
const ROUTINE_CONTRACT_LINE = ROUTINE_RESULT_CONTRACT.split("\n").at(-1)!;
const HANDOFF_CONTRACT_LINE = HANDOFF_RESULT_CONTRACT.split("\n").at(-1)!;

const jsonl = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

/** The real server with the contract on and the scripted fake Claude
 * (server/testing/room-handoff-agent.ts) as every engine: an owner and a
 * peer of one team (each can reach the other), each turn picked from a plan
 * by what it was asked, graded on the runtime's rows (DATA_DIR/runtime.db),
 * the routine receipts, the chats and what each turn was told. */
async function scripted(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({ ...process.env, OMB_RESULT_CONTRACT: "1" }, undefined, undefined, undefined, undefined, { scripted: true });
  const url = session.info.url;
  const dataDir = session.info.dataDir;
  const planPath = join(dataDir, "room-plan.json");
  /** Every scripted turn a fake Claude bot ran, in order. */
  const turns = (botId?: string): any[] => jsonl(`${planPath}.evidence.jsonl`).filter((turn) => !botId || turn.botId === botId);
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
      const value = await response.json() as any;
      expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
      return value;
    };
    const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
    const owner = (await cli("new-bot", "--name", "Owner", "--section", "Ops")).bot;
    const peer = (await cli("new-bot", "--name", "Peer", "--section", "Ops")).bot;
    const plan: Record<string, { script: unknown[] }> = { [owner.id]: { script: [] }, [peer.id]: { script: [] } };
    const script = (botId: string, ...entries: unknown[]) => {
      (plan[botId] ??= { script: [] }).script.push(...entries);
      writeFileSync(planPath, JSON.stringify(plan));
    };
    writeFileSync(planPath, JSON.stringify(plan));
    const turn = (key: string) => turns().find((candidate) => candidate.planKey === key);
    /** What a turn itself was asked, after any replayed history. */
    const own = (key: string): string => ownTurnText(turn(key)?.prompt);
    const gate = (name: string) => join(dataDir, `${name}.gate`);
    const ready = (name: string) => join(dataDir, `${name}.ready`);
    const open = (name: string) => writeFileSync(gate(name), "open");
    const say = (threadId: string, text: string) => api("POST", `/api/bots/${owner.id}/messages`, { text, threadId });
    const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=300`)).messages ?? [];
    const runState = async (runId: string) => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === runId);
    /** A manual run of a fresh routine on the owner. */
    const startRoutine = async (name: string, prompt: string) => {
      const { routine } = await api("POST", "/api/routines", { name, prompt, botId: owner.id, enabled: false,
        schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
      return (await api("POST", `/api/routines/${routine.id}/run`)).run;
    };
    const children = () => readHandoffs(dataDir).filter((row) => row.parentId);
    try {
      await test({ owner, peer, script, turns, turn, own, gate, ready, open, say, messages, runState, startRoutine, children });
    } catch (error) {
      console.error(`result contract fixture state:\n${JSON.stringify({
        turns: turns().map((record) => ({ botId: record.botId, planKey: record.planKey, unplanned: record.unplanned, own: ownTurnText(record.prompt).slice(0, 600) })),
        assignments: readHandoffs(dataDir).map(({ id, parentId, botId, status, outcome, executions, result }) => ({ id, parentId, botId, status, outcome, executions, result: result.slice(0, 200) })),
        runs: await fetch(`${url}/api/routines`, { headers: { origin: url } }).then((response) => response.json()).then((body: any) => body.runs).catch(() => null),
      }, null, 1)}`);
      throw error;
    }
    // No bot ran a turn its script did not plan.
    expect(turns().filter((record) => record.unplanned).map((record) => ownTurnText(record.prompt).slice(0, 300))).toEqual([]);
  } finally {
    await session.close();
  }
}

// A routine run that delegates waits, unjudged, while its hand-off is out;
// the turn that resumes it with the teammate's result carries the routine's
// own contract (index.ts routineResultContract), never a teammate's, and its
// RESULTADO line settles the run: proved, it completes; missing, it fails as
// not verified. Without the contract the resume carries none (R1 in
// runtime-paths.e2e.test.ts).
it("resumes a routine run that delegated with the routine's contract, and settles the run by the resume's RESULTADO line", () => scripted(async (f) => {
  f.script(f.owner.id,
    // the resumes first: their text also quotes the run's request
    { key: "A1", match: [SETTLED, REPORT_FROM_PEER, "RC-A-RESULT"], reply: "Relatório pronto: 42 linhas.\nRESULTADO: feito — https://example.com/relatorios/42" },
    { key: "B1", match: [SETTLED, REPORT_FROM_PEER, "RC-B-RESULT"], reply: "Relatório pronto, confira." },
    { key: "A0", match: ["RC-A-ROUTINE"], steps: [{ arguments: { bot_ids: [f.peer.id], message: "RC-A-BRIEF: conte as linhas do relatório." } }], reply: "Pedi ao Peer." },
    { key: "B0", match: ["RC-B-ROUTINE"], steps: [{ arguments: { bot_ids: [f.peer.id], message: "RC-B-BRIEF: conte as linhas do relatório." } }], reply: "Pedi ao Peer." });
  f.script(f.peer.id,
    { key: "PA", match: ["RC-A-BRIEF"], readyFile: f.ready("rc-a"), gateFile: f.gate("rc-a"), reply: "RC-A-RESULT: 42 linhas.\nRESULTADO: feito — `wc -l relatorio.csv` deu 42" },
    { key: "PB", match: ["RC-B-BRIEF"], readyFile: f.ready("rc-b"), gateFile: f.gate("rc-b"), reply: "RC-B-RESULT: 42 linhas.\nRESULTADO: feito — `wc -l relatorio.csv` deu 42" });

  const proved = await f.startRoutine("Relatório A", "RC-A-ROUTINE: peça ao Peer a contagem de linhas e relate.");
  await expect.poll(() => existsSync(f.ready("rc-a")), { timeout: 30_000 }).toBe(true);
  // the run's own turn handed work out and ended without the line: it waits, not judged
  await expect.poll(async () => (await f.runState(proved.id))?.status, { timeout: 30_000 }).toBe("waiting");
  expect(f.own("A0")).toContain(ROUTINE_CONTRACT_LINE);
  f.open("rc-a");
  await expect.poll(async () => (await f.runState(proved.id))?.status, { timeout: 45_000 }).toBe("completed");
  // the teammate's request carried the teammate's contract (its evidence is written as its turn ends)
  expect(f.own("PA")).toContain(HANDOFF_CONTRACT_LINE);
  // the resume carried the routine's contract after the teammate's report
  // (the request it quotes first is the run's turn, which had it already),
  // and not a teammate's
  const resume = f.own("A1");
  expect(resume.lastIndexOf(REPORT_FROM_PEER), resume.slice(0, 300)).toBeGreaterThan(resume.indexOf(SETTLED));
  expect(resume.indexOf(SETTLED)).toBeGreaterThanOrEqual(0);
  expect(resume.slice(resume.lastIndexOf(REPORT_FROM_PEER))).toContain(ROUTINE_CONTRACT_LINE);
  expect(resume).not.toContain(HANDOFF_CONTRACT_LINE);
  expect((await f.runState(proved.id)).output).toContain("RESULTADO: feito — https://example.com/relatorios/42");

  const missing = await f.startRoutine("Relatório B", "RC-B-ROUTINE: peça ao Peer a contagem de linhas e relate.");
  await expect.poll(() => existsSync(f.ready("rc-b")), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await f.runState(missing.id))?.status, { timeout: 30_000 }).toBe("waiting");
  f.open("rc-b");
  await expect.poll(async () => (await f.runState(missing.id))?.status, { timeout: 45_000 }).toBe("failed");
  expect((await f.runState(missing.id)).error).toBe("Resultado não verificado: a resposta não terminou com a linha RESULTADO");
  const unproved = f.own("B1");
  expect(unproved.lastIndexOf(REPORT_FROM_PEER)).toBeGreaterThan(0);
  expect(unproved.slice(unproved.lastIndexOf(REPORT_FROM_PEER))).toContain(ROUTINE_CONTRACT_LINE);
  expect(f.turns(f.owner.id).map((record: any) => record.planKey)).toEqual(["A0", "A1", "B0", "B1"]);
}), 150_000);

// The host hands the runtime a teammate's whole answer (index.ts
// turn.completed no longer cuts it at 12 000 characters): its RESULTADO line
// is read before the runtime keeps the first 12 000, so a "não feito" past
// that mark still fails the request, with the reason as the result's first
// line, and the requester hears it as a failure.
it("fails a teammate's request on a \"não feito\" line past 12 000 characters, with the reason first", () => scripted(async (f) => {
  const long = `${"y".repeat(13_000)}\nRESULTADO: não feito — o Jev barrou a escrita`;
  f.script(f.owner.id,
    { key: "C1", match: [SETTLED, REPORT_FROM_PEER], reply: "O Peer não conseguiu gravar; sigo sem a escrita." },
    { key: "C0", match: ["LT-JOB"], steps: [{ arguments: { bot_ids: [f.peer.id], message: "LT-BRIEF: grave o arquivo de exportação." } }], reply: "Pedi ao Peer." });
  f.script(f.peer.id, { key: "P1", match: ["LT-BRIEF"], reply: long });
  const thread = f.owner.activeTaskId;
  await f.say(thread, "LT-JOB: peça ao Peer para gravar o arquivo de exportação.");
  await expect.poll(() => f.children()[0]?.status, { timeout: 45_000 }).toBe("failed");
  const child = f.children()[0];
  expect(child).toMatchObject({ botId: f.peer.id, status: "failed", outcome: "provider_error" });
  expect(child.result.startsWith("Resultado não feito: o Jev barrou a escrita\n\nyyy"), child.result.slice(0, 200)).toBe(true);
  expect(child.result.length).toBeLessThanOrEqual(12_000);
  // the requester's chip leads with the reason; its own resume is not judged
  await expect.poll(async () => (await f.messages(thread)).some((message: any) => message.kind === "activity"
    && message.tool?.name === "Peer — failed: Resultado não feito: o Jev barrou a escrita"), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => f.turns(f.owner.id).map((record: any) => record.planKey), { timeout: 30_000 }).toEqual(["C0", "C1"]);
  expect(f.own("C1")).toContain("Resultado não feito: o Jev barrou a escrita");
}), 90_000);
