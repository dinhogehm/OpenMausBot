import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

// R12-followup #1, as on the night of 04/10: the queue of open PRs is empty,
// no release runs, and #8675 and #9058 (P1) have nobody on them. A real
// server with a stand-in `gh` wakes the Chief once, in its desk, with the
// list — not while ~/.nuria/stop exists, and not twice for the same issues.
it("an empty queue with no release wakes the Chief once with the P1 nobody is on, and ~/.nuria/stop holds it", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-pipeline-idle-"));
  const issues = [
    { number: 9058, title: "Chats distribuídos mesmo com agentes offline e aviso no Widget", createdAt: "2026-09-21T14:21:23Z", labels: [{ name: "priority:p1" }] },
    { number: 8675, title: "GET/POST de mensagens em /conversations/:id validam só o workspace", createdAt: "2026-08-25T21:05:23Z", labels: [{ name: "priority:p1" }] },
  ];
  // the stand-in gh: no open PR, the two P1, and every call written down
  const calls = join(scratch, "gh-calls.txt");
  writeFileSync(join(scratch, "gh"), [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    `require("node:fs").appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");`,
    `if (args[0] === "pr" && args[1] === "list") process.stdout.write("[]");`,
    `else if (args[0] === "issue" && args[1] === "list") process.stdout.write(${JSON.stringify(JSON.stringify(issues))});`,
    "else process.exit(1);",
    "",
  ].join("\n"));
  chmodSync(join(scratch, "gh"), 0o755);
  const prompts = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({
    ...process.env,
    OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "100", OMB_AUTONOMY_TURN_GAP_MS: "50",
    OMB_PIPELINE_IDLE: "1", OMB_PIPELINE_IDLE_EVERY_MS: "300",
    OMB_TEST_GRANT_PATH: scratch,
    FAKE_CLAUDE_REPLIES: JSON.stringify(Array.from({ length: 6 }, () => "Osvaldo, peguei a #8675 primeiro; a #9058 vem depois.")),
    FAKE_CLAUDE_PROMPTS: prompts,
  });
  const { url, dataDir } = fixture.info;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  const said = () => (existsSync(prompts) ? readFileSync(prompts, "utf8") : "");
  try {
    // ~/.nuria/stop (the fixture's home is its data dir) before there is a Chief
    mkdirSync(join(dataDir, ".nuria"), { recursive: true });
    writeFileSync(join(dataDir, ".nuria", "stop"), "");
    const chief = (await runControlOmb(["new-bot", "--name", "Chief of Staff", "--url", url]) as any).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true }, "PATCH");
    const desk = ((await api("/api/bots?messages=0", undefined, "GET")).bots as any[]).find((bot) => bot.id === chief.id).threadId as string;
    const chips = async () => ((await api(`/api/threads/${desk}/messages`, undefined, "GET")).messages as any[])
      .filter((message) => message.kind === "activity").map((message) => String(message.tool?.name ?? ""));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    // stopped: GitHub is not even asked, and nothing reaches the Chief
    expect(existsSync(calls)).toBe(false);
    expect((await chips()).some((chip) => chip.startsWith("Esteira parada"))).toBe(false);
    expect(said()).not.toContain("[Servidor: esteira parada]");

    rmSync(join(dataDir, ".nuria", "stop"));
    await expect.poll(said, { timeout: 15_000 }).toContain("[Servidor: esteira parada]");
    const report = said();
    expect(report).toContain("- #8675 (P1, aberta em 25/08; sem sessão): GET/POST de mensagens");
    expect(report.indexOf("#8675 (P1")).toBeLessThan(report.indexOf("#9058 (P1"));
    expect((await chips()).filter((chip) => chip.startsWith("Esteira parada: fila de PRs vazia, sem release, 2 P0/P1 sem ninguém nelas (#8675, #9058)"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dataDir, "pipeline-idle.json"), "utf8")).lastNumbers).toEqual([8675, 9058]);
    // the server keeps looking, and says it once
    const looks = () => readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith("pr list")).length;
    const before = looks();
    await expect.poll(looks, { timeout: 10_000 }).toBeGreaterThan(before + 2);
    expect((await chips()).filter((chip) => chip.startsWith("Esteira parada"))).toHaveLength(1);
    expect(said().split("[Servidor: esteira parada]").length - 1).toBe(1);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);
