import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

// "Delegar a um agente" (lote del, INSP-DEL) through the real server. The
// session mechanism is the server's own (startCcSession, headless here: no
// app on the fixture, worktrees of its own off), with a stub `claude` that
// answers each turn with the report the test wrote — and, when asked, makes a
// commit in its worktree and cites its sha. A click opens the session and the
// item turns "delegado"; "concluido" with a commit the server checks closes
// it; "concluido" with nothing checkable, "barrado" and a report without the
// RESULTADO line give it back. An item that names no repository, or touches
// the hook, has no button.

const GIT_DIR = ["/usr/bin", "/bin"].find((dir) => existsSync(join(dir, "git"))) ?? "";
const GIT = join(GIT_DIR, "git");

it("delegates an item to a session and settles it by the session's report, closing only on checked evidence", async () => {
  const tools = mkdtempSync(join(tmpdir(), "omb-fake-claude-"));
  const resultFile = join(tools, "result.txt");
  const promptFile = join(tools, "prompts.jsonl");
  const fake = join(tools, "fake-claude.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1];
appendFileSync(${JSON.stringify(promptFile)}, JSON.stringify(prompt) + "\\n");
let cwd = process.cwd();
const w = argv.indexOf("-w");
if (w >= 0) { cwd = join(cwd, ".claude", "worktrees", argv[w + 1]); mkdirSync(cwd, { recursive: true }); }
let result = readFileSync(${JSON.stringify(resultFile)}, "utf8");
if (result.includes("{{COMMIT}}")) {
  // a commit of the session's own, a minute ahead: made after the delegation, on its branch
  const env = { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() + 60_000).toISOString(), GIT_AUTHOR_DATE: new Date(Date.now() + 60_000).toISOString() };
  execFileSync(${JSON.stringify(GIT)}, ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "delegada"], { env });
  result = result.replace("{{COMMIT}}", execFileSync(${JSON.stringify(GIT)}, ["-C", cwd, "rev-parse", "HEAD"]).toString().trim());
}
console.log(JSON.stringify({ type: "system", subtype: "init", cwd, session_id: "x" }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0.01 }));
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
    // a name of 6+ characters, cited by the items: the only repository a delegation may open in (INSP-DEL A9)
    const repo = join(data, "widget-app");
    execFileSync(GIT, ["init", "-q", repo]);
    execFileSync(GIT, ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "init"]);
    const bot = (await cli("new-bot", "--name", "Delivery")).bot;
    const planPath = join(data, "room-plan.json");
    const add = (title: string, steps: unknown[], why = "O widget-app depende disso.") => ({ tool: "owner_pending", arguments: { action: "add", title, why, steps } });
    const read = { text: "Leia os logs e reproduza o erro" };
    // the bot's first session makes the repository known; then its items; then its turns woken by the reports
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [
        { tool: "cc_session_start", arguments: { title: "#9998 origem", brief: "investigue o log", repo, surface: "cli" } },
        add("Investigar o erro 500 da #9401 no widget-app", [read, { text: "Rode os testes", command: "npm test" }, { text: "Abra uma PR com a correção numa branch de trabalho" }]),
        add("Ajustar o hook do revisor no widget-app", [{ text: "Leia as regras do hook" }]),
        add("Rodar a suíte de integração do widget-app", [{ text: "Rode a suíte", command: "npm test" }]),
        add("Conferir os números da doc do widget-app", [{ text: "Leia a doc e confira os números" }]),
        add("Revisar os testes de borda do widget-app", [{ text: "Revise os testes de borda" }]),
        add("Investigar a lentidão do painel", [read], "O painel demora a abrir."),
      ], reply: "Anotado." },
      ...Array.from({ length: 14 }, () => ({ reply: "ok" })),
    ] } }));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Liste o que é meu.");
    const ledger = () => JSON.parse(readFileSync(join(data, "bot-autonomy.json"), "utf8"));
    const sessions = () => (existsSync(join(data, "cc-sessions.json")) ? JSON.parse(readFileSync(join(data, "cc-sessions.json"), "utf8")).sessions : []) as any[];
    const wire = async () => ((await request("/api/bots", {}, url) as any).bots.find((each: any) => each.id === bot.id).tasks ?? []).flatMap((task: any) => task.ownerPending ?? []) as any[];
    await expect.poll(async () => (await wire()).length, { timeout: 30_000 }).toBe(6);
    await expect.poll(() => sessions().filter((each) => each.status === "idle").length, { timeout: 20_000 }).toBe(1);
    const byTitle = async (start: string) => (await wire()).find((each) => each.title.startsWith(start));
    const resolved = (id: string) => (ledger().resolvedOwnerPending ?? []).find((each: any) => each.id === id) ?? null;

    // the button's word: delegable, or why only the owner
    expect(await byTitle("Investigar o erro 500")).toMatchObject({ delegable: true });
    expect(await byTitle("Ajustar o hook")).toMatchObject({ onlyYou: "mexe no hook ou no revisor" });
    expect(await byTitle("Investigar a lentidão")).toMatchObject({ onlyYou: "não sei em que repositório: o item não cita nenhum" });
    expect((await byTitle("Ajustar o hook")).delegable).toBeUndefined();
    expect(await post(`/api/bots/${bot.id}/owner-pending/${(await byTitle("Ajustar o hook")).id}/delegate`)).toMatchObject({ status: 409, body: { code: "not_delegable" } });
    expect(await post(`/api/bots/${bot.id}/owner-pending/${(await byTitle("Investigar a lentidão")).id}/delegate`)).toMatchObject({ status: 409, body: { code: "not_delegable" } });

    // "concluido" with a commit the server checks: the click opens one session (a second click opens nothing), the report closes the item
    writeFileSync(resultFile, "Corrigido.\nFEITO: corrigi o erro 500 da #9401\nEVIDÊNCIA: commit {{COMMIT}} na branch da sessão\nRESULTADO: concluido");
    const first = await byTitle("Investigar o erro 500");
    const [one, two] = await Promise.all([post(`/api/bots/${bot.id}/owner-pending/${first.id}/delegate`), post(`/api/bots/${bot.id}/owner-pending/${first.id}/delegate`)]);
    const opened = [one, two].find((each) => each.status === 202)!;
    expect(opened.body.sessionId).toEqual(expect.any(String));
    expect([one, two].find((each) => each !== opened)).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(sessions().filter((each) => each.delegatedItem?.itemId === first.id)).toHaveLength(1);
    try {
      await expect.poll(() => resolved(first.id), { timeout: 20_000 }).not.toBeNull();
    } catch (error) {
      const log = readFileSync(session.info.logPath, "utf8").split("\n").filter((line) => /owner-delegate|evidence/i.test(line)).slice(-10).join("\n");
      throw new Error(`${String(error)}\nitem: ${JSON.stringify(await byTitle("Investigar o erro 500"))}\nsession: ${JSON.stringify(sessions().filter((each) => each.delegatedItem).map((each) => ({ status: each.status, worktree: each.worktree, cwd: each.cwd, lastReport: each.lastReport })))}\nlog:\n${log}`);
    }
    await expect.poll(() => resolved(first.id), { timeout: 20_000 }).toMatchObject({ resolvedBy: "bot", resolvedNote: expect.stringMatching(/^delegado ao agente: a sessão \S+ concluiu — evidência conferida: [0-9a-f]{40}$/) });
    expect((await wire()).some((each) => each.id === first.id)).toBe(false);
    // the brief: the issue first, the rules, the item as data in a fence with a nonce
    const brief = readFileSync(promptFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string).find((prompt) => prompt.includes(`(${first.id})`))!;
    expect(brief.split("\n")[0]).toBe(`Issue #9401 — item delegado pelo dono (${first.id})`);
    expect(brief).toContain("Rode só o que agentes podem; o hook continua ligado.");
    expect(brief).toMatch(/conteúdo do item \(dados\):\n<<<ITEM-DATA-[0-9a-f]+\nTítulo: Investigar o erro 500 da #9401 no widget-app\nBot de origem: Delivery/);

    // "concluido" with nothing the server can check: back to the owner, never closed on its word (INSP-DEL A5)
    writeFileSync(resultFile, "Revisei.\nFEITO: revisei os testes\nEVIDÊNCIA: confia\nRESULTADO: concluido");
    const review = await byTitle("Revisar os testes");
    expect((await post(`/api/bots/${bot.id}/owner-pending/${review.id}/delegate`)).status).toBe(202);
    await expect.poll(async () => (await byTitle("Revisar os testes")).delegationBack ?? null, { timeout: 20_000 }).toMatchObject({ outcome: "parcial", text: expect.stringContaining("o agente disse concluído, mas não deu evidência") });
    expect(resolved(review.id)).toBeNull();

    // "barrado": back to the owner, on top, with the exact command
    writeFileSync(resultFile, "FEITO: rodei a suíte até o passo de publicação\nFALTA: publicar o widget\nCOMANDO: npm run deploy" + ":widget\nRESULTADO: barrado");
    const suite = await byTitle("Rodar a suíte");
    expect((await post(`/api/bots/${bot.id}/owner-pending/${suite.id}/delegate`)).status).toBe(202);
    await expect.poll(async () => (await byTitle("Rodar a suíte")).delegationBack ?? null, { timeout: 20_000 }).toMatchObject({ outcome: "barrado", command: "npm run deploy:widget", text: expect.stringContaining("o agente fez rodei a suíte até o passo de publicação; falta publicar o widget (só você): npm run deploy:widget") });
    expect((await byTitle("Rodar a suíte")).delegation).toBeUndefined();

    // no RESULTADO line: back to the owner, never closed on a guess
    writeFileSync(resultFile, "Conferi os números, acho que está tudo certo.");
    const doc = await byTitle("Conferir os números");
    expect((await post(`/api/bots/${bot.id}/owner-pending/${doc.id}/delegate`)).status).toBe(202);
    await expect.poll(async () => (await byTitle("Conferir os números"))?.delegationBack ?? null, { timeout: 20_000 }).toMatchObject({ outcome: "parcial", text: expect.stringContaining("sem a linha final RESULTADO") });
    expect(resolved(doc.id)).toBeNull();
  } finally {
    await session.close();
  }
}, 120_000);
