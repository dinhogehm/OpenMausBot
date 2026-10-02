import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// J17 (the owner, 02/10): "Planilha linha 169 (#9295)" and other older items
// had no steps, and he does not want to click "Pedir o passo a passo". The
// server asks the bot once per item — a report, so it waits for the
// conversation to be free — never with ~/.nuria/stop, never twice.
it("asks the bot once for an older item's steps, one item per bot at a time, never twice nor with ~/.nuria/stop", async () => {
  const prompts = join(tmpdir(), `omb-steps-ask-${process.pid}-${Date.now()}.jsonl`);
  const env = { ...process.env, OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "100", OMB_AUTONOMY_TURN_GAP_MS: "50", OMB_OWNER_STEPS_ASK_AFTER_MS: "0", FAKE_CLAUDE_PROMPTS: prompts };
  const fixture = await launchVerificationServer(env);
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  const boot = async (stop = false) => {
    if (stop) { mkdirSync(join(dataDir, ".nuria"), { recursive: true }); writeFileSync(join(dataDir, ".nuria", "stop"), ""); }
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(env, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
  };
  const ledger = () => JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8"));
  try {
    const monitor = (await runControlOmb(["new-bot", "--name", "Monitor Chat", "--url", url]) as any).bot;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const at = Date.now() - 20 * 3_600_000;
    const thread = monitor.activeTaskId ?? monitor.threadId;
    // a steps request queued before the stop (INSP-J2 #6: the stop is checked at dispatch too)
    const queuedBefore = `[Servidor: pendências sem passo a passo] Itens: o9. O dono quer cada pendência com o passo a passo.\n- o9 («Planilha linha 169»): falta why e steps`;
    writeFileSync(join(dataDir, "bot-autonomy.json"), JSON.stringify({ wakes: [], goals: [], reports: [{ botId: monitor.id, threadId: thread, items: [queuedBefore] }], inFlight: [], ownerPending: [
      { id: "o9", botId: monitor.id, threadId: thread, title: "Planilha linha 169 (#NNNN): atualizar o status", createdAt: at, stepsAutoAskedAt: at, stepsRequestedAt: at },
      { id: "o10", botId: monitor.id, threadId: thread, title: "Liberar a escrita na linha 97 da planilha", createdAt: at + 60_000, why: "x", steps: [{ text: "y" }], options: [{ label: "Liberei", reply: "a" }, { label: "Ainda não", reply: "b" }] },
      { id: "o11", botId: monitor.id, threadId: thread, title: "Aprovar o aviso", createdAt: at, why: "x", steps: [{ text: "Leia o aviso" }] },
      // a server item saved bare by an older build: the server completes it, never its bot (INSP-J2 #5)
      { id: "o8", botId: monitor.id, threadId: thread, title: "Avançar a tag de produção para d5bb1f70b", key: "tag-advance:d5bb1f70bea397bdd937d02148c685e406985ba0", createdAt: at },
    ] }));
    // with ~/.nuria/stop: the queued request is not sent (and o9 may be asked again later); nothing new is asked
    await boot(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(ledger().ownerPending.filter((item: any) => item.stepsAutoAskedAt)).toEqual([]);
    expect(ledger().reports ?? []).toEqual([]);
    expect(existsSync(prompts) ? readFileSync(prompts, "utf8") : "").not.toContain("pendências sem passo a passo");
    await waitForExit(restarted, { signal: "SIGTERM" });
    rmSync(join(dataDir, ".nuria", "stop"));
    // without it: ONE report for the bot, each item with what it lacks; the server item completed by the server
    await boot();
    await expect.poll(() => ledger().ownerPending.filter((item: any) => item.stepsAutoAskedAt).map((item: any) => item.id).sort(), { timeout: 10_000 }).toEqual(["o10", "o9"]);
    await expect.poll(() => (existsSync(prompts) ? readFileSync(prompts, "utf8") : ""), { timeout: 20_000 }).toContain("[Servidor: pendências sem passo a passo] Itens: o9, o10.");
    const prompt = readFileSync(prompts, "utf8");
    expect(prompt).toContain("- o9 («Planilha linha 169 (#NNNN): atualizar o status»): falta why e steps");
    expect(prompt).toContain("- o10 («Liberar a escrita na linha 97 da planilha»): falta a recomendada");
    expect(prompt).not.toMatch(/o8 \(/);
    const o8 = ledger().ownerPending.find((item: any) => item.id === "o8");
    expect(o8.steps.length).toBeGreaterThan(0);
    expect(o8.why).toContain("a tag nuria-production-deployed não andou");
    expect(o8.options.filter((option: any) => option.recommended)).toHaveLength(1);
    expect(o8.stepsAutoAskedAt).toBeUndefined();
    const messages = (await api(`/api/threads/${thread}/messages`, undefined, "GET")).messages as any[];
    expect(messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([]);
    // the screen shows it asked
    const wire = ((await api("/api/bots", undefined, "GET")).bots as any[]).find((each) => each.id === monitor.id).tasks.flatMap((task: any) => task.ownerPending ?? []);
    expect(wire.find((item: any) => item.id === "o9").stepsRequestedAt).toBeGreaterThan(0);
    // a restart does not ask o9 again
    const askedAt = ledger().ownerPending.find((item: any) => item.id === "o9").stepsAutoAskedAt;
    await waitForExit(restarted, { signal: "SIGTERM" });
    await boot();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(ledger().ownerPending.find((item: any) => item.id === "o9").stepsAutoAskedAt).toBe(askedAt);
    expect(readFileSync(prompts, "utf8").split("Itens: o9, o10.").length - 1).toBe(1);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);

// INSP-J r1 #8: "Deixar no terminal" answered "não precisa me lembrar disso
// de novo", and the next blocked start recreated the item. The server now
// keeps the choice for 24 h.
it("keeps the owner's 'seguir no terminal' on the unblock-the-app item for 24 h", async () => {
  const fixture = await launchVerificationServer({ ...process.env });
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief of Staff", "--url", url]) as any).bot;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const item = { id: "o8", botId: chief.id, threadId: chief.activeTaskId ?? chief.threadId, title: "Abrir no app uma sessão na raiz de nuria-platform", key: "app-reused-folder:nuria-platform", createdAt: Date.now() - 3_600_000,
      options: [{ label: "Feito, conferir", reply: "Abri." }, { label: "Seguir no terminal", reply: "Não vou destravar o app agora." }] };
    // a server item whose non-recommended choice used to close it (INSP-J2 #2): closes again
    const tag = { id: "o7", botId: chief.id, threadId: item.threadId, title: "Avançar a tag de produção para d5bb1f70b", key: "tag-advance:d5bb1f70b", createdAt: Date.now() - 3_600_000, why: "w", steps: [{ text: "s" }],
      options: [{ label: "Avancei a tag", reply: "Avancei.", recommended: true, why: "x" }, { label: "Não tenho o bypass", reply: "Não tenho bypass." }] };
    writeFileSync(join(dataDir, "bot-autonomy.json"), JSON.stringify({ wakes: [], goals: [], reports: [], inFlight: [], ownerPending: [item, tag] }));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment({ ...process.env }, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
    const before = Date.now();
    // J16c: first ask the bot which one it recommends — the item stays, marked as asked
    const asked = await api(`/api/bots/${chief.id}/owner-pending/o8/reply`, { ask: "recommend" });
    expect(asked).toMatchObject({ ok: true, resolved: 0 });
    await expect.poll(() => JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")).ownerPending?.[0]?.recommendRequestedAt ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(before);
    const wire = ((await api("/api/bots", undefined, "GET")).bots as any[]).find((each) => each.id === chief.id).tasks.flatMap((task: any) => task.ownerPending ?? []);
    expect(wire[0].recommendRequestedAt).toBeGreaterThanOrEqual(before);
    const answer = await api(`/api/bots/${chief.id}/owner-pending/o8/reply`, { option: 1, label: "Seguir no terminal" });
    expect(answer.resolved).toBe(1);
    const declines = JSON.parse(readFileSync(join(dataDir, "owner-declines.json"), "utf8"));
    expect(declines["app-reused-folder:nuria-platform"]).toBeGreaterThanOrEqual(before + 24 * 3_600_000 - 5_000);
    expect((await api(`/api/bots/${chief.id}/owner-pending/o7/reply`, { option: 1, label: "Não tenho o bypass" })).resolved).toBe(1);
    // the audit trail, reachable (INSP-J2 #12): newest first, with the person's answers
    const audit = (await api(`/api/bots/${chief.id}/owner-pending-resolved`, undefined, "GET")).resolved as any[];
    expect(audit.map((each) => [each.id, each.resolvedBy])).toEqual([["o7", "owner"], ["o8", "owner"]]);
    expect(audit[1].history.map((each: any) => [each.kind, each.label])).toEqual([["ask", "recommend"], ["option", "Seguir no terminal"]]);
    expect(audit[0]).not.toHaveProperty("steps");
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
