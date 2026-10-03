import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { APP_FLAPPING_CHECK_LABEL, APP_UNBLOCK_CHECK_LABEL, appUnblockPending } from "./owner-chips.ts";
import { waitForExit } from "./testing/cleanup.ts";

// R10-dispatch R10-2, through the real server: the owner's "destravar o app"
// item is checked against the Claude app's records (the fixture's HOME
// holds them, as on 02/10 10:07: the owner's session from the root landed
// in a folder four sessions had used). Only BLOCKED states are exercised:
// with the app free a start would drive the real screen of this Mac, and a
// test never does that — no session is started here at all.
const REPO = "/Users/o/Projetos/nuria-platform";
const F = `${REPO}/.claude/worktrees/atendimento-reaberto-bugs-496989`;

function writeRecords(home: string, records: Array<Record<string, unknown>>): void {
  const dir = join(home, "Library", "Application Support", "Claude", "claude-code-sessions", "org", "acct");
  mkdirSync(dir, { recursive: true });
  for (const record of records) writeFileSync(join(dir, `${String(record.sessionId)}.json`), JSON.stringify({ cliSessionId: `c-${String(record.sessionId)}`, originCwd: REPO, ...record }));
}

it.runIf(process.platform === "darwin")("'Feito, conferir' while the app still reuses a folder: 409 with what the records show, the item stays, nothing reaches the bot; a legacy title-only item is rewritten in place", async () => {
  const env = { ...process.env, OMB_AUTONOMY_TICK_MS: "200" };
  const fixture = await launchVerificationServer(env);
  const { url, dataDir, logPath } = fixture.info;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  const raw = (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let restarted: ChildProcess | undefined;
  const items = () => (JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")).ownerPending ?? []) as any[];
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief of Staff", "--url", url]) as any).bot;
    const thread = chief.activeTaskId ?? chief.threadId;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    writeRecords(dataDir, [
      { sessionId: "local_e1", createdAt: Date.parse("2026-09-30T14:56:00Z"), cwd: F, isArchived: true, title: "Atendimento reaberto bugs" },
      { sessionId: "local_e2", createdAt: Date.parse("2026-10-01T14:12:00Z"), cwd: F, isArchived: true, title: "Tempo de reabertura configurável" },
      { sessionId: "local_c6d395b2", createdAt: Date.parse("2026-10-02T13:07:29Z"), cwd: F, worktreePath: F, worktreeName: "atendimento-reaberto-bugs-496989", title: "Aumentar usuários Piperun para 50" },
    ]);
    const at = Date.now() - 3_600_000;
    writeFileSync(join(dataDir, "bot-autonomy.json"), JSON.stringify({ wakes: [], goals: [], reports: [], inFlight: [], ownerPending: [
      // the real o8 of 02/10: a title and its key, nothing else
      { id: "o8", botId: chief.id, threadId: thread, title: "Destravar o app Claude (pasta reaproveitada): abra no app uma sessão nova na raiz de nuria-platform", key: "app-reused-folder:nuria-platform", createdAt: at, stepsAutoAskedAt: at },
    ] }));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(env, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);

    // the legacy item now asks the gesture, with why, steps and the two answers
    const want = appUnblockPending("nuria-platform");
    await expect.poll(() => items().find((item) => item.id === "o8")?.why, { timeout: 20_000, interval: 200 }).toBe(want.why);
    const o8 = items().find((item) => item.id === "o8");
    expect(o8).toMatchObject({ title: want.title, key: "app-reused-folder:nuria-platform", createdAt: at });
    expect(o8.steps.map((step: any) => step.text)).toEqual(want.steps.map((step) => step.text));
    expect(o8.options.map((option: any) => option.label)).toEqual([APP_UNBLOCK_CHECK_LABEL, "Seguir no terminal"]);
    expect(readFileSync(logPath, "utf8")).toContain('the owner\'s "destravar o app" item o8 now asks the gesture for "reused"');

    const before = ((await api(`/api/threads/${thread}/messages`, undefined, "GET")).messages ?? []).length;
    // "Feito, conferir" with the 5th-time folder still the newest session: refused, with why
    const answer = await raw(`/api/bots/${chief.id}/owner-pending/o8/reply`, { option: 0, label: APP_UNBLOCK_CHECK_LABEL });
    expect(answer.status).toBe(409);
    const body = await answer.json() as { error: string; code: string };
    expect(body.code).toBe("app_still_blocked");
    expect(body.error).toContain(`Ainda não destravou: a sessão mais recente do app ("Aumentar usuários Piperun para 50") está em ${F}`);
    expect(body.error).toContain("refaça com ela desligada, na raiz de nuria-platform");
    // the item stays open; nothing went to the bot
    expect(items().map((item) => item.id)).toEqual(["o8"]);
    expect(((await api(`/api/threads/${thread}/messages`, undefined, "GET")).messages ?? []).length).toBe(before);

    // the owner tried with the worktree ON again (the 10:07 gesture): a 6th session in F — still refused
    writeRecords(dataDir, [{ sessionId: "local_again", createdAt: Date.now() - 5_000, cwd: F, worktreePath: F, title: "ok" }]);
    const again = await raw(`/api/bots/${chief.id}/owner-pending/o8/reply`, { option: 0, label: APP_UNBLOCK_CHECK_LABEL });
    expect(again.status).toBe(409);
    expect((await again.json() as { error: string }).error).toContain('a sessão mais recente do app ("ok")');
    expect(items().map((item) => item.id)).toEqual(["o8"]);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);

// INSP-S r1 S-3, through the real server: the two blocks take turns — a
// reused folder; the gesture (root, worktree off) frees it, then a create of
// ours falls in the root; "worktree ON" frees that, then lands in a reused
// folder again. On that 2nd switch the server stops asking gestures: the one
// item becomes the diagnosis + guided test, and stays so across a restart.
// "Rodei o teste, conferir" counts from zero and checks the records again.
// Again only BLOCKED states: no session is started.
it.runIf(process.platform === "darwin")("the app flapping between 'reused' and 'root': on the 2nd switch, no third gesture — one item with the diagnosis and the guided test", async () => {
  const env = { ...process.env, OMB_AUTONOMY_TICK_MS: "200" };
  const fixture = await launchVerificationServer(env);
  const { url, dataDir, logPath } = fixture.info;
  const raw = (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let restarted: ChildProcess | undefined;
  const items = () => (JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")).ownerPending ?? []) as any[];
  const boot = async () => {
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment(env, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(url + "/api/health").then((r) => r.ok).catch(() => false), { timeout: 15_000, interval: 150 }).toBe(true);
  };
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief of Staff", "--url", url]) as any).bot;
    const thread = chief.activeTaskId ?? chief.threadId;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const t = Date.now() - 3 * 3_600_000;
    writeRecords(dataDir, [
      { sessionId: "local_e1", createdAt: t - 86_400_000, cwd: F, isArchived: true, title: "Atendimento reaberto bugs" },
      { sessionId: "local_c6d395b2", createdAt: t, cwd: F, worktreePath: F, title: "Aumentar usuários Piperun para 50" },
    ]);
    // the create of ours that will fall in the root, as the ledger adopted it
    writeFileSync(join(dataDir, "cc-sessions.json"), JSON.stringify({ sessions: [
      { id: "s9311", ownerBotId: chief.id, ownerThreadId: thread, title: "9311 Chat no ticket", repo: REPO, worktree: "", permissionMode: "auto", surface: "app", status: "failed", turns: 0, costUsd: 0, queued: [], createdAt: t, lastActivityAt: t, failedAt: t,
        desktop: { marker: "OMBFLAP01", turnsSeen: 0, localId: "local_srv1", wrongFolder: REPO } },
    ] }));
    writeFileSync(join(dataDir, "bot-autonomy.json"), JSON.stringify({ wakes: [], goals: [], reports: [], inFlight: [], ownerPending: [
      { id: "o8", botId: chief.id, threadId: thread, ...appUnblockPending("nuria-platform"), key: "app-reused-folder:nuria-platform", createdAt: t, stepsAutoAskedAt: t },
    ] }));
    await boot();
    // the click as the owner makes it: the label they saw (the server may rewrite the item meanwhile)
    const check = async (label = APP_UNBLOCK_CHECK_LABEL) => {
      const answer = await raw(`/api/bots/${chief.id}/owner-pending/o8/reply`, { option: 0, label });
      return { status: answer.status, ...(await answer.json() as { error?: string; code?: string }) };
    };

    // 1. reused: the gesture asked is root + worktree off
    expect(await check()).toMatchObject({ status: 409, code: "app_still_blocked", error: expect.stringContaining("refaça com ela desligada") });
    // 2. the owner's gesture in the root freed it; then our create fell in the root: 1st switch, the gesture flips to "worktree ON"
    writeRecords(dataDir, [{ sessionId: "local_0a0000aa-0000-4000-8000-000000000000", createdAt: t + 60_000, cwd: REPO, title: "Sessão raiz do gerente OpenMausBot" }]);
    writeRecords(dataDir, [{ sessionId: "local_srv1", createdAt: t + 120_000, cwd: REPO, title: "9311 Chat no ticket" }]);
    expect(await check()).toMatchObject({ status: 409, error: expect.stringContaining("confira se a opção worktree estava ligada") });
    expect(items().find((item) => item.id === "o8").title).toMatch(/com a worktree LIGADA/);
    // 3. "worktree ON" landed in a reused folder again: 2nd switch — stop
    writeRecords(dataDir, [{ sessionId: "local_again", createdAt: t + 180_000, cwd: F, worktreePath: F, title: "ok" }]);
    // whether the server's own tick rewrote the item first (the race of INSP-S r2 S2-1) or the click
    // found the flip itself, the owner reads the diagnosis — never "o bot reescreveu"
    const stopped = await check();
    expect(stopped.status).toBe(409);
    expect(["app_still_blocked", "item_changed"]).toContain(stopped.code);
    expect(stopped.error).toContain("O servidor parou de pedir gestos de destravar: cada um trouxe o outro bloqueio (2 trocas).");
    expect(stopped.error).not.toMatch(/o bot/i);
    // the click again, on the label that is gone: what the item is now, with the diagnosis
    const late = await check();
    expect(late).toMatchObject({ status: 409, code: "item_changed" });
    expect(late.error).toContain("O item mudou enquanto você o lia: \"Feito, conferir\" não vale mais. Agora ele diz: O app Claude alterna");
    expect(late.error).toContain("(2 trocas)");
    const item = items().find((each) => each.id === "o8");
    expect(item.title).toBe("O app Claude alterna entre reaproveitar worktree e cair na raiz: as sessões de nuria-platform seguem no terminal até você rodar o teste guiado");
    expect(item.why).toContain("(2 trocas)");
    expect(item.why).toContain('a sessão do servidor "9311 Chat no ticket" caiu na raiz, sem worktree');
    expect(item.options.map((option: any) => option.label)).toEqual([APP_FLAPPING_CHECK_LABEL, "Seguir no terminal"]);
    expect(items()).toHaveLength(1);
    expect(readFileSync(logPath, "utf8")).toContain("[claude-desktop] the app flipped reused → root → reused: no more gestures asked");

    // a restart keeps it stopped: still the one item, never a gesture again
    await waitForExit(restarted, { signal: "SIGTERM" });
    await boot();
    expect(JSON.parse(readFileSync(join(dataDir, "app-folder-blocks.json"), "utf8")).stoppedAt).toEqual(expect.any(Number));
    // 4. "Rodei o teste, conferir": counted from zero, and the records still show a reused folder — said, with that gesture
    expect(await check(APP_FLAPPING_CHECK_LABEL)).toMatchObject({ status: 409, error: expect.stringContaining("refaça com ela desligada") });
    expect(JSON.parse(readFileSync(join(dataDir, "app-folder-blocks.json"), "utf8"))).toEqual({ seen: [expect.objectContaining({ kind: "reused", folder: F })] });
    expect(readFileSync(logPath, "utf8")).toContain("the owner ran the guided test: the app's folder blocks are counted from zero");
    expect(items().map((each) => each.id)).toEqual(["o8"]);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
