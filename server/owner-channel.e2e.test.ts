import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

// R9-followup #1, as it happened on 01/10: at 09:49 the owner told the Chief
// in one conversation "esta conversa é o único canal comigo; não fale comigo
// na …". The build installed at 21:05 did not know that order, kept no
// conversation with the owner, and its desk fell to the conversation where
// the owner had last written (a bug report at 19:53): the release alert and
// the Chief's answer to it went there. Here the order sits in the history of
// a server that never recorded it; on boot the server reads it back, the
// conversation it names gets the boot report and the sessions' reports, and
// the later bug report elsewhere does not take its place.
it("reads the owner's channel order back at boot and sends the boot report and the sessions there, not where the owner wrote last", async () => {
  const parentEnv = { ...process.env, OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "100", OMB_AUTONOMY_TURN_GAP_MS: "50" };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief", "--url", url]) as any).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true }, "PATCH");
    const esteira = (await api(`/api/bots/${chief.id}/tasks`, { title: "Esteira" })).task.threadId as string;
    const billing = (await api(`/api/bots/${chief.id}/tasks`, { title: "Prioridade máxima" })).task.threadId as string;
    const other = (await api(`/api/bots/${chief.id}/tasks`, { title: "Antiga" })).task.threadId as string;
    await waitForExit(fixture.child, { signal: "SIGTERM" });

    // The history: the channel order in "Esteira" (the 09:49 wording, redacted),
    // then a one-off bug report in another conversation, later.
    const at = Date.now() - 12 * 3_600_000;
    const order = `<pasted-text index="1">\nChief, a partir de agora esta conversa (${esteira.slice(0, 8)}) é o único canal comigo. Não fale comigo na ${other.slice(0, 8)}; mova para cá os vigias main e prod. Faça hoje, nesta ordem, e me reporte aqui em uma linha por item:\n\n1. Ponha a #NNNN de volta na fila.\n</pasted-text>`;
    const db = new DatabaseSync(join(dataDir, "messages.db"));
    const insert = db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const write = (threadId: string, id: string, when: number, text: string) => insert.run(threadId, id, when, "user", "text", text, JSON.stringify({ id, role: "user", kind: "text", text, at: when }));
    write(esteira, "order-0949", at, order);
    write(billing, "bug-1953", at + 10 * 3_600_000, "Prioridade máxima: destravar a esteira. O cliente não consegue trocar de plano.");
    db.close();
    // a server that never recorded the order (the 21:05 build): no conversation with the owner on record
    rmSync(join(dataDir, "bots", chief.id, "shared-state.json"), { force: true });
    // the Chief's sessions, started from the bug report's conversation; one was cut off mid-turn
    const session = (id: string, status: string) => ({
      id, ownerBotId: chief.id, ownerThreadId: billing, title: `9052 ${id}`, repo: dataDir, worktree: `9052-${id}`,
      permissionMode: "auto", status, surface: "cli", createdAt: at, lastActivityAt: at, turns: 1, costUsd: 0, queued: [],
    });
    writeFileSync(join(dataDir, "cc-sessions.json"), JSON.stringify({ sessions: [session("cc-idle", "idle"), session("cc-cut", "running")] }));

    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      if (restarted?.exitCode !== null) throw new Error(readFileSync(logPath, "utf8"));
      return fetch(url + "/api/health").then((r) => r.ok).catch(() => false);
    }, { timeout: 15_000, interval: 150 }).toBe(true);

    const chips = async (threadId: string) => ((await api(`/api/threads/${threadId}/messages`, undefined, "GET")).messages as any[])
      .filter((message) => message.kind === "activity").map((message) => String(message.tool?.name ?? ""));
    // the order, read back: "Esteira" is the conversation with the owner
    const stateFile = join(dataDir, "bots", chief.id, "shared-state.json");
    await expect.poll(() => existsSync(stateFile) && JSON.parse(readFileSync(stateFile, "utf8")).ownerThread?.threadId, { timeout: 15_000 }).toBe(esteira);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.orders.map((each: any) => each.text).join("\n")).toContain("é o único canal comigo");
    expect(readFileSync(logPath, "utf8")).toContain(`the conversation with the owner is ${esteira}`);
    await expect.poll(async () => (await chips(esteira)).some((chip) => chip.startsWith("Canal do dono: esta conversa (ordem de ")), { timeout: 10_000 }).toBe(true);
    // the boot report goes there, not to where the owner wrote last
    await expect.poll(async () => (await chips(esteira)).some((chip) => chip.startsWith("Servidor reiniciado:")), { timeout: 10_000 }).toBe(true);
    expect((await chips(billing)).some((chip) => chip.startsWith("Servidor reiniciado:"))).toBe(false);
    // the sessions report there from now on, and the conversation they came from is told
    const sessions = JSON.parse(readFileSync(join(dataDir, "cc-sessions.json"), "utf8")).sessions as any[];
    expect(sessions.map((each) => [each.id, each.ownerThreadId])).toEqual([["cc-idle", esteira], ["cc-cut", esteira]]);
    expect((await chips(esteira)).some((chip) => chip.startsWith("2 sessões passam a relatar aqui (ordem do dono de "))).toBe(true);
    expect((await chips(billing)).filter((chip) => chip.endsWith("os relatórios agora vão para o canal do dono"))).toHaveLength(2);

    // a second boot reads the same order and changes nothing
    await waitForExit(restarted, { signal: "SIGTERM" });
    const again = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)), stdio: ["ignore", again, again],
    });
    closeSync(again);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await chips(esteira)).filter((chip) => chip.startsWith("Canal do dono: esta conversa"))).toHaveLength(1);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);

// INSP-H r1 #2: "Mande só o link da PR aqui." in a side conversation is a
// request, not the owner's channel: nothing is recorded as the conversation
// with the owner, and no session moves.
it("does not take a request with \"só … aqui\" for the owner's channel, nor move the sessions", async () => {
  const fixture = await launchVerificationServer({ ...process.env, OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "100", OMB_AUTONOMY_TURN_GAP_MS: "50" });
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief", "--url", url]) as any).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true }, "PATCH");
    const side = (await api(`/api/bots/${chief.id}/tasks`, { title: "Lateral" })).task.threadId as string;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const at = Date.now() - 60_000;
    writeFileSync(join(dataDir, "cc-sessions.json"), JSON.stringify({ sessions: [{
      id: "cc-main", ownerBotId: chief.id, ownerThreadId: chief.activeTaskId, title: "9052 sessão", repo: dataDir, worktree: "9052-x",
      permissionMode: "auto", status: "idle", surface: "cli", createdAt: at, lastActivityAt: at, turns: 1, costUsd: 0, queued: [],
    }] }));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment({ ...process.env }, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
    await runControlOmb(["send", "--bot", chief.id, "--task", side, "--text", "Mande só o link da PR aqui."], { env: { OPENMAUSBOT_URL: url } });
    // the turn ran and its record was written: the request is on record, no channel
    const stateFile = join(dataDir, "bots", chief.id, "shared-state.json");
    await expect.poll(() => existsSync(stateFile) && JSON.parse(readFileSync(stateFile, "utf8")).threads?.some((thread: any) => thread.threadId === side), { timeout: 20_000 }).toBe(true);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).ownerThread).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dataDir, "cc-sessions.json"), "utf8")).sessions[0].ownerThreadId).toBe(chief.activeTaskId);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
