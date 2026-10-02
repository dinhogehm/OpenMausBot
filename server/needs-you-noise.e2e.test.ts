import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

// R10-visual N12, as the panel showed it on 02/10 (redacted): conversations
// whose last reply waits on the person, but only echoes the panel or another
// item, or holds a structured item already. Each line the server sends must
// say something of its own; the counter matches the distinct asks.
it("sends no conversation line for an echo, an empty ask or a conversation that already holds an item; a real ask stays", async () => {
  const fixture = await launchVerificationServer({ ...process.env });
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief of Staff", "--url", url]) as any).bot;
    const thread = async (title: string) => (await api(`/api/bots/${chief.id}/tasks`, { title })).task.threadId as string;
    const echo = await thread("@Monitor parallel work");
    const empty = await thread("@Chief of Staff");
    const withItem = await thread("Release em laço");
    const real = await thread("Sessão da 9058");
    const channel = await thread("Canal com o dono");
    await waitForExit(fixture.child, { signal: "SIGTERM" });

    const at = Date.now() - 3_600_000;
    const db = new DatabaseSync(join(dataDir, "messages.db"));
    const insert = db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const write = (threadId: string, id: string, when: number, role: string, text: string) => insert.run(threadId, id, when, role, "text", text, JSON.stringify({ id, role, kind: "text", text, at: when }));
    for (const [threadId, reply] of [
      [echo, "Fiz o que dava. O pedido continua na sua lista 'Precisa de você' (o15)."],
      [empty, "Preciso de você"],
      [withItem, "Abri um item para você decidir o timeout. Fica 10 min ou sem limite?"],
      [real, "Renata, a sessão da #9058 está pronta, mas o timeout do pre-push depende de uma decisão sua: 10 min ou sem limite?"],
      [channel, "Renata, a #9350 passou no gate e o QA aprovou. Mesclo?"],
    ] as const) {
      write(threadId, `${threadId}-u`, at, "user", "Como está?");
      write(threadId, `${threadId}-b`, at + 1_000, "bot", reply);
    }
    db.close();
    writeFileSync(join(dataDir, "bot-autonomy.json"), JSON.stringify({ wakes: [], goals: [], reports: [], inFlight: [], ownerPending: [
      // the bot's item opened with its question, in the same turn
      { id: "o14", botId: chief.id, threadId: withItem, title: "Decidir o timeout do pre-push", aliases: ["o15"], createdAt: at + 900 },
      // the server's item in the channel since yesterday: unrelated to a new question there
      { id: "o8", botId: chief.id, threadId: channel, title: "Abrir no app uma sessão na raiz de nuria-platform", key: "app-reused-folder:nuria-platform", createdAt: at - 16 * 3_600_000 },
    ] }));

    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment({ ...process.env }, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      if (restarted?.exitCode !== null) throw new Error(readFileSync(logPath, "utf8"));
      return fetch(url + "/api/health").then((r) => r.ok).catch(() => false);
    }, { timeout: 15_000, interval: 150 }).toBe(true);

    const bots = (await api("/api/bots", undefined, "GET")).bots as any[];
    const tasks = new Map<string, any>(bots.find((bot) => bot.id === chief.id).tasks.map((task: any) => [task.threadId, task]));
    expect(tasks.get(echo).goalNeedsInput).toBeUndefined();
    expect(tasks.get(empty).goalNeedsInput).toBeUndefined();
    // the item is the ask: one row, not two
    expect(tasks.get(withItem).goalNeedsInput).toBeUndefined();
    expect(tasks.get(withItem).ownerPending.map((item: any) => item.id)).toEqual(["o14"]);
    // the real one stays, its title without the vocative
    expect(tasks.get(real)).toMatchObject({ goalNeedsInput: true, goalNeedsInputAsk: "A sessão da #9058 está pronta, mas o timeout do pre-push depende de uma decisão sua: 10 min ou sem limite?" });
    // the channel holds the server's o8, and its new short question still shows, with its context (INSP-J r1 #3/#4)
    expect(tasks.get(channel)).toMatchObject({ goalNeedsInput: true, goalNeedsInputAsk: "A #9350 passou no gate e o QA aprovou. Mesclo?" });
    expect(tasks.get(channel).ownerPending.map((item: any) => item.id)).toEqual(["o8"]);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
