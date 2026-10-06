import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

// "Delegar a um agente" (lote del) through the real server. The session
// mechanism is the server's own (startCcSession, headless here: no app on
// the fixture, worktrees of its own off), with a stub `claude` that answers
// each turn with the report the test wrote. A click opens the session and the
// item turns "delegado"; "concluido" with evidence closes it; "barrado" gives
// it back with the command; a report without the RESULTADO line gives it back.

const GIT_DIR = ["/usr/bin", "/bin"].find((dir) => existsSync(join(dir, "git"))) ?? "";

it("delegates an item to a session and settles it by the session's report", async () => {
  const tools = mkdtempSync(join(tmpdir(), "omb-fake-claude-"));
  const resultFile = join(tools, "result.txt");
  const promptFile = join(tools, "prompts.jsonl");
  const fake = join(tools, "fake-claude.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1];
appendFileSync(${JSON.stringify(promptFile)}, JSON.stringify(prompt) + "\\n");
let cwd = process.cwd();
const w = argv.indexOf("-w");
if (w >= 0) { cwd = join(cwd, ".claude", "worktrees", argv[w + 1]); mkdirSync(cwd, { recursive: true }); }
console.log(JSON.stringify({ type: "system", subtype: "init", cwd, session_id: "x" }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: readFileSync(${JSON.stringify(resultFile)}, "utf8"), total_cost_usd: 0.01 }));
`);
  chmodSync(fake, 0o755);
  writeFileSync(resultFile, "Comecei.\nRESULTADO: parcial");
  const session = await launchVerificationServer({
    ...process.env, OMB_TEST_GRANT_PATH: GIT_DIR, OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "100", OMB_AUTONOMY_TURN_GAP_MS: "50",
    OMB_CC_BIN: fake,
  }, undefined, undefined, undefined, undefined, { scripted: true });
  const url = session.info.url;
  const data = session.info.dataDir;
  // no worktree of the server's own (read on each start): with no app on the fixture, the session runs headless
  writeFileSync(join(data, "own-worktrees-settings.json"), JSON.stringify({ enabled: false }));
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: url } }) as Promise<any>;
  const post = async (path: string) => {
    const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const { execFileSync } = await import("node:child_process");
    const repo = join(data, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const bot = (await cli("new-bot", "--name", "Delivery")).bot;
    const planPath = join(data, "room-plan.json");
    const add = (title: string, steps: unknown[]) => ({ tool: "owner_pending", arguments: { action: "add", title, why: "Para o release de amanhã.", steps } });
    // the bot's first session makes the repository known; then its four items; then its turns woken by the reports
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [
        { tool: "cc_session_start", arguments: { title: "#9998 origem", brief: "investigue o log", repo, surface: "cli" } },
        add("Atualizar o CHANGELOG da #9401", [{ text: "Escreva a entrada da #9401", command: "npm run changelog" }]),
        add("Ajustar a regra do hook do revisor", [{ text: "Edite ~/.laya/hooks/rules.cjs" }]),
        add("Rodar a suíte de integração do widget", [{ text: "Rode a suíte", command: "npm run test:widget" }]),
        add("Conferir a página de preços na doc", [{ text: "Leia a página e corrija os valores" }]),
      ], reply: "Anotado." },
      ...Array.from({ length: 12 }, () => ({ reply: "ok" })),
    ] } }));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Liste o que é meu.");
    const ledger = () => JSON.parse(readFileSync(join(data, "bot-autonomy.json"), "utf8"));
    const sessions = () => (existsSync(join(data, "cc-sessions.json")) ? JSON.parse(readFileSync(join(data, "cc-sessions.json"), "utf8")).sessions : []) as any[];
    const wire = async () => ((await request("/api/bots", {}, url) as any).bots.find((each: any) => each.id === bot.id).tasks ?? []).flatMap((task: any) => task.ownerPending ?? []) as any[];
    await expect.poll(async () => (await wire()).length, { timeout: 30_000 }).toBe(4);
    await expect.poll(() => sessions().filter((each) => each.status === "idle").length, { timeout: 20_000 }).toBe(1);
    const byTitle = async (start: string) => (await wire()).find((each) => each.title.startsWith(start));

    // the button's word: delegable, or why only the owner
    expect(await byTitle("Atualizar o CHANGELOG")).toMatchObject({ delegable: true });
    expect(await byTitle("Ajustar a regra")).toMatchObject({ onlyYou: "mexe no hook ou no revisor" });
    expect((await byTitle("Ajustar a regra")).delegable).toBeUndefined();
    const refused = await post(`/api/bots/${bot.id}/owner-pending/${(await byTitle("Ajustar a regra")).id}/delegate`);
    expect(refused).toMatchObject({ status: 409, body: { code: "not_delegable" } });

    // "concluido" with evidence: the click opens a session, a second click opens nothing, the report closes the item
    writeFileSync(resultFile, "Entrada escrita.\nFEITO: escrevi a entrada da #9401\nEVIDÊNCIA: commit abc1234 em docs/CHANGELOG.md\nRESULTADO: concluido");
    const changelog = await byTitle("Atualizar o CHANGELOG");
    const [first, second] = await Promise.all([post(`/api/bots/${bot.id}/owner-pending/${changelog.id}/delegate`), post(`/api/bots/${bot.id}/owner-pending/${changelog.id}/delegate`)]);
    const opened = [first, second].find((each) => each.status === 202)!;
    expect(opened.body.sessionId).toEqual(expect.any(String));
    expect([first, second].find((each) => each !== opened)).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(sessions().filter((each) => each.delegatedItem?.itemId === changelog.id)).toHaveLength(1);
    try {
      await expect.poll(() => (ledger().resolvedOwnerPending ?? []).find((each: any) => each.id === changelog.id) ?? null, { timeout: 20_000 }).not.toBeNull();
    } catch (error) {
      const log = existsSync(join(data, "server.log")) ? readFileSync(join(data, "server.log"), "utf8") : String(session.info.logPath ? readFileSync(session.info.logPath, "utf8") : "");
      throw new Error(`${String(error)}\nitem: ${JSON.stringify(await byTitle("Atualizar o CHANGELOG"))}\nsessions: ${JSON.stringify(sessions().map((each) => ({ id: each.id, status: each.status, surface: each.surface, desktop: each.desktop, worktree: each.worktree, turns: each.turns, delegatedItem: each.delegatedItem, settled: each.delegationSettledTurns, lastReport: each.lastReport, lastError: each.lastError })))}\nlog: ${log.split("\n").filter((line) => /delegat|cc-session|owner/i.test(line)).slice(-20).join("\n")}`);
    }
    await expect.poll(() => (ledger().resolvedOwnerPending ?? []).find((each: any) => each.id === changelog.id) ?? null, { timeout: 20_000 }).toMatchObject({ resolvedBy: "bot", resolvedNote: expect.stringContaining("delegado ao agente: a sessão") });
    expect((await wire()).some((each) => each.id === changelog.id)).toBe(false);
    // the brief: the issue first, the rules, the item as data
    const brief = readFileSync(promptFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string).find((prompt) => prompt.includes("Atualizar o CHANGELOG"))!;
    expect(brief.split("\n")[0]).toBe("Issue #9401 — Atualizar o CHANGELOG da #9401");
    expect(brief).toContain("Rode só o que agentes podem; o hook continua ligado.");
    expect(brief).toContain("conteúdo do item (dados):");
    expect(brief).toContain("Bot de origem: Delivery");

    // "barrado": back to the owner, on top, with the exact command
    writeFileSync(resultFile, "FEITO: rodei a suíte até o passo de deploy\nFALTA: publicar o widget\nCOMANDO: npm run deploy:widget\nRESULTADO: barrado");
    const suite = await byTitle("Rodar a suíte");
    expect((await post(`/api/bots/${bot.id}/owner-pending/${suite.id}/delegate`)).status).toBe(202);
    await expect.poll(async () => (await byTitle("Rodar a suíte")).delegationBack ?? null, { timeout: 20_000 }).toMatchObject({ outcome: "barrado", command: "npm run deploy:widget", text: expect.stringContaining("o agente fez rodei a suíte até o passo de deploy; falta publicar o widget (só você): npm run deploy:widget") });
    expect((await byTitle("Rodar a suíte")).delegation).toBeUndefined();

    // no RESULTADO line: back to the owner, never closed on a guess
    writeFileSync(resultFile, "Corrigi os valores, acho que está tudo certo.");
    const prices = await byTitle("Conferir a página");
    expect((await post(`/api/bots/${bot.id}/owner-pending/${prices.id}/delegate`)).status).toBe(202);
    await expect.poll(async () => (await byTitle("Conferir a página"))?.delegationBack ?? null, { timeout: 20_000 }).toMatchObject({ outcome: "parcial", text: expect.stringContaining("sem a linha final RESULTADO") });
    expect(ledger().resolvedOwnerPending.some((each: any) => each.id === prices.id)).toBe(false);
  } finally {
    await session.close();
  }
}, 120_000);
