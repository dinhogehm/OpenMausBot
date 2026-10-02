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
    await waitForExit(fixture.child, { signal: "SIGTERM" });

    const at = Date.now() - 3_600_000;
    const db = new DatabaseSync(join(dataDir, "messages.db"));
    const insert = db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const write = (threadId: string, id: string, when: number, role: string, text: string) => insert.run(threadId, id, when, role, "text", text, JSON.stringify({ id, role, kind: "text", text, at: when }));
    for (const [threadId, reply] of [
      [echo, "Fiz o que dava. O pedido continua na sua lista 'Precisa de você' (o15)."],
      [empty, "Preciso de você"],
      [withItem, "O release d5bb1f70b segue em laço. Recusa o commit? O comando está no item."],
      [real, "Renata, a sessão da #9058 está pronta, mas o timeout do pre-push depende de uma decisão sua: 10 min ou sem limite?"],
    ] as const) {
      write(threadId, `${threadId}-u`, at, "user", "Como está?");
      write(threadId, `${threadId}-b`, at + 1_000, "bot", reply);
    }
    db.close();
    writeFileSync(join(dataDir, "bot-autonomy.json"), JSON.stringify({ wakes: [], goals: [], reports: [], inFlight: [], ownerPending: [
      { id: "o14", botId: chief.id, threadId: withItem, title: "Recusar d5bb1f70b (laço, 10×): copie o comando de recusa", key: "release-loop:d5bb1f70b", aliases: ["o15"], createdAt: at },
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
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
