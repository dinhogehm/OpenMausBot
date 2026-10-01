import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

/** The system's git, not a package manager's bin: the fixture's PATH is
 * sealed off this machine's CLIs, and watches and sessions run git. */
const GIT_DIR = ["/usr/bin", "/bin"].find((dir) => existsSync(join(dir, "git"))) ?? "";

/** One scripted bot on an isolated server, with minutes shrunk to 200 ms. */
async function fixture(test: (f: any) => Promise<void>, extraEnv: Record<string, string> = {}) {
  const session = await launchVerificationServer({
    ...process.env,
    OMB_TEST_GRANT_PATH: GIT_DIR,
    OMB_AUTONOMY_MINUTE_MS: "200",
    OMB_AUTONOMY_TICK_MS: "100",
    OMB_AUTONOMY_TURN_GAP_MS: "50",
    ...extraEnv,
  }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const bot = (await cli("new-bot", "--name", "Delivery")).bot;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const save = (plan: unknown) => writeFileSync(planPath, JSON.stringify({ [bot.id]: plan }));
    const turns = () => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter((turn: any) => turn.botId === bot.id)
      : [];
    const messages = async () => (await api(`/api/threads/${bot.activeTaskId}/messages`, undefined, "GET")).messages as any[];
    const chips = async () => (await messages()).filter((message: any) => message.kind === "activity").map((message: any) => String(message.tool?.name ?? ""));
    const send = (text: string) => cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
    const ledger = () => JSON.parse(readFileSync(join(session.info.dataDir, "bot-autonomy.json"), "utf8"));
    await test({ session, api, bot, save, turns, messages, chips, send, ledger });
  } finally { await session.close(); }
}

const toolResult = (turn: any, tool: string) =>
  turn.evidence.findLast((entry: any) => entry.step?.tool === tool)?.response?.result?.content?.[0]?.text as string;

it("wakes the bot in the same conversation with its own note", () => fixture(async f => {
  f.save({ turns: [
    { steps: [{ tool: "wake_me", arguments: { minutes: 1, reason: "CHECK_PR_9280 merged?" } }], reply: "I will check back" },
    // an autonomous turn carries the language section, and its machine-written
    // message ends with the reminder
    { expectSystemIncludes: ["Language: every message meant for people", "Brazilian Portuguese (pt-BR)"], expectContextIncludes: ["Wake-up you scheduled", "CHECK_PR_9280 merged?", "(Responda à pessoa em português do Brasil.)"], reply: "PR 9280 is merged" },
  ] });
  await f.send("Check PR 9280 in a minute.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  expect(toolResult(f.turns()[0], "wake_me")).toContain("Encerre o turno agora");
  await expect.poll(async () => (await f.messages()).some((message: any) => message.text === "PR 9280 is merged"), { timeout: 10_000 }).toBe(true);
  const chips = await f.chips();
  expect(chips.some((chip: string) => chip.startsWith("Despertador às"))).toBe(true);
  expect(chips.some((chip: string) => chip.startsWith("Acordou — CHECK_PR_9280"))).toBe(true);
  // Nobody typed the wake: no second user line appears in the transcript.
  expect((await f.messages()).filter((message: any) => message.role === "user")).toHaveLength(1);
  expect(f.ledger().wakes).toEqual([]);
}), 60_000);

it("tells the bot when a promise passes its deadline unkept, and never for a kept one", () => fixture(async f => {
  f.save({ turns: [
    { steps: [
      { tool: "wake_me", arguments: { promise: "resposta ao cliente ACME sobre o login", promise_minutes: 1 } },
      { tool: "wake_me", arguments: { promise: "planilha da ACME atualizada", promise_minutes: 2 } },
      { tool: "wake_me", arguments: { promise_kept: "p2" }, expectError: true },
      { tool: "wake_me", arguments: { promise_kept: "p2", promise_proof: "spaces/X/messages/abc.def" } },
    ], reply: "Prometido" },
    { expectContextIncludes: ["Promise overdue", "resposta ao cliente ACME sobre o login", "(p1)", "promise_kept"], reply: "Enviando agora" },
  ] });
  await f.send("Diga à ACME que respondemos em 1 minuto.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  expect(toolResult(f.turns()[0], "wake_me")).toContain("marcada como cumprida");
  const chips = await f.chips();
  expect(chips.some((chip: string) => chip.startsWith("Promessa p1 —"))).toBe(true);
  expect(chips.some((chip: string) => chip.startsWith("Promessa cumprida — planilha") && chip.includes("spaces/X/messages/abc.def"))).toBe(true);
  expect(chips.some((chip: string) => chip.startsWith("Promessa p1 passou do prazo"))).toBe(true);
  expect(chips.some((chip: string) => chip.includes("p2 passou do prazo"))).toBe(false);
}), 60_000);

it("carries what one conversation decided, and the owner's orders, into the bot's other conversations", () => fixture(async f => {
  f.save({ turns: [
    { reply: "Mergeei a PR #9313 pelo gate. Aguardo o carrier." },
    { expectSystemIncludes: ["Estado das suas outras conversas", "Mergeei a PR #9313 pelo gate.", "Ordens do dono em vigor", "Não rode ci:local enquanto houver release"], reply: "Entendido, sigo a ordem." },
  ] });
  await f.send("Não rode ci:local enquanto houver release. Faça o merge da #9313.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  const created = await f.api(`/api/bots/${f.bot.id}/tasks`, { title: "Outra conversa" });
  await runControlOmb(["send", "--bot", f.bot.id, "--task", created.task.threadId, "--text", "Qual o estado?"], { env: { OPENMAUSBOT_URL: f.session.info.url } });
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  expect(f.turns()[1].evidence?.some?.((entry: any) => entry.error)).toBeFalsy();
}), 60_000);

it("speaks to the owner in the one conversation they named, and shows there what was said to them elsewhere", () => fixture(async f => {
  f.save({ turns: [
    { reply: "Combinado: falo com você só por aqui." },
    { expectSystemIncludes: ["Conversa com o dono:", "Não fale com o dono aqui"], reply: "Preciso de uma decisão sua: publico o carrier agora?" },
  ] });
  await f.send("Use só esta conversa para falar comigo.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  const created = await f.api(`/api/bots/${f.bot.id}/tasks`, { title: "Outra conversa" });
  await runControlOmb(["send", "--bot", f.bot.id, "--task", created.task.threadId, "--text", "Qual o estado do carrier?"], { env: { OPENMAUSBOT_URL: f.session.info.url } });
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip.startsWith('Dito ao dono em "Outra conversa"') && chip.includes("publico o carrier agora?")), { timeout: 10_000 }).toBe(true);
}), 60_000);

it("says so when a new goal replaces one still open in the conversation", () => fixture(async f => {
  f.save({ turns: [
    { steps: [
      { tool: "goal_start", arguments: { goal: "Mergear a #9314 depois do lote", max_turns: 3 } },
      { tool: "goal_start", arguments: { goal: "Publicar o carrier #9325", max_turns: 3 } },
    ], reply: "Objetivo trocado" },
  ] });
  await f.send("Troque o objetivo.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  expect(toolResult(f.turns()[0], "goal_start")).toContain('O objetivo anterior desta conversa ("Mergear a #9314 depois do lote") foi substituído');
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip.startsWith("Objetivo anterior substituído") && chip.includes("#9314")), { timeout: 10_000 }).toBe(true);
}), 60_000);

it("keeps giving a goal turns until the bot ends it, then goes quiet", () => fixture(async f => {
  f.save({ turns: [
    { steps: [{ tool: "goal_start", arguments: { goal: "SHIP_9195 to production", max_turns: 5 } }], reply: "Goal accepted" },
    { expectContextIncludes: ["Goal mode — turn 1 of 5", "SHIP_9195 to production"], reply: "Merged the PR" },
    { expectContextIncludes: ["Goal mode — turn 2 of 5"], steps: [{ tool: "goal_end", arguments: { status: "completed", detail: "deployed and verified" } }], reply: "Shipped" },
  ] });
  await f.send("Ship 9195 and don't stop until it is in production.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(3);
  expect(toolResult(f.turns()[0], "goal_start")).toContain("Modo objetivo ligado");
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip === "Objetivo concluído após 2 turnos — deployed and verified"), { timeout: 10_000 }).toBe(true);
  // An ended goal starts nothing more (a fourth turn would have no plan and fail).
  await new Promise(resolve => setTimeout(resolve, 1_000));
  expect(f.turns()).toHaveLength(3);
  expect(f.ledger().goals[0]).toMatchObject({ status: "completed", turnCount: 2 });
}), 60_000);

it("stops a goal at its turn limit", () => fixture(async f => {
  f.save({ turns: [
    { steps: [{ tool: "goal_start", arguments: { goal: "LIMITED", max_turns: 1 } }], reply: "Goal accepted" },
    { reply: "Still working" },
  ] });
  await f.send("Work on it.");
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip.startsWith("Objetivo pausado no limite após 1 turno")), { timeout: 20_000 }).toBe(true);
  expect(f.turns()).toHaveLength(2);
}), 60_000);

it("pauses for the person on needs_input and resumes on their answer", () => fixture(async f => {
  f.save({ turns: [
    { steps: [{ tool: "goal_start", arguments: { goal: "DEPLOY", max_turns: 5 } }], reply: "Goal accepted" },
    { steps: [{ tool: "goal_end", arguments: { status: "needs_input", detail: "staging or production?" } }], reply: "Staging or production?" },
    { expectContextIncludes: ["production please"], reply: "Deploying to production" },
    { expectContextIncludes: ["Goal mode — turn 2 of 5"], steps: [{ tool: "goal_end", arguments: { status: "completed", detail: "in production" } }], reply: "Done" },
  ] });
  await f.send("Deploy it.");
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip.startsWith("Objetivo esperando você")), { timeout: 20_000 }).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(f.turns()).toHaveLength(2);
  await f.send("production please");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(4);
  await expect.poll(() => f.ledger().goals[0]?.status, { timeout: 10_000 }).toBe("completed");
}), 60_000);

it("refuses both tools in a room", () => fixture(async f => {
  const { group } = await f.api("/api/groups", {
    name: "Ops room", memberIds: [f.bot.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: f.bot.id } },
  });
  f.save({ turns: [{ steps: [
    { tool: "wake_me", arguments: { minutes: 1, reason: "x" }, expectError: true },
    { tool: "goal_start", arguments: { goal: "x" }, expectError: true },
  ], reply: "Refused as expected" }] });
  await runControlOmb(["send-channel", "--channel", group.id, "--text", "try it"], { env: { OPENMAUSBOT_URL: f.session.info.url } });
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  expect(toolResult(f.turns()[0], "wake_me")).toContain("not available in rooms");
}), 60_000);

it("drops the goal and the pending wake when the person presses Stop", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "hold");
  f.save({ turns: [
    { steps: [
      { tool: "goal_start", arguments: { goal: "LONG JOB", max_turns: 5 } },
      { tool: "wake_me", arguments: { minutes: 30, reason: "check later" } },
    ], gateFile: gate, reply: "never" },
  ] });
  await f.send("Start the long job.");
  await expect.poll(() => f.ledger().goals?.[0]?.status, { timeout: 20_000 }).toBe("active");
  await f.api(`/api/bots/${f.bot.id}/interrupt`, { threadId: f.bot.activeTaskId });
  await expect.poll(() => f.ledger().goals[0].status, { timeout: 10_000 }).toBe("stopped");
  expect(f.ledger().wakes).toEqual([]);
  writeFileSync(gate, "");
  await new Promise(resolve => setTimeout(resolve, 1_000));
  // The interrupted turn is killed before it records evidence; what matters
  // is that nothing resumed on its own afterwards.
  expect(f.turns()).toHaveLength(0);
  const chips = await f.chips();
  expect(chips).toContain("Despertador cancelado — parado por você");
  expect(chips.some((chip: string) => chip.startsWith("Objetivo parado"))).toBe(true);
  expect(chips.some((chip: string) => chip.startsWith("Objetivo continua") || chip.startsWith("Acordou"))).toBe(false);
}), 60_000);

it("retries a failing goal turn after a pause and blocks it after three failures", () => fixture(async f => {
  f.save({ turns: [
    { steps: [{ tool: "goal_start", arguments: { goal: "FLAKY", max_turns: 10 } }], reply: "Goal accepted" },
    { fail: true },
    { expectContextIncludes: ["The previous goal turn failed"], fail: true },
    { expectContextIncludes: ["The previous goal turn failed"], fail: true },
  ] });
  await f.send("Keep at it.");
  await expect.poll(() => f.ledger().goals?.[0]?.status, { timeout: 30_000 }).toBe("blocked");
  expect(f.turns()).toHaveLength(4);
  expect(f.ledger().goals[0].detail).toMatch(/3 turns in a row failed/);
  expect(f.ledger().wakes).toEqual([]);
}), 60_000);

it("watches a command without waking the bot until its output changes", () => fixture(async f => {
  const { execFileSync } = await import("node:child_process");
  const repo = join(f.session.info.dataDir, "watched-repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", repo]);
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first");
  const command = `git -C ${repo} log --format=%s -1`;
  f.save({ turns: [
    { steps: [
      { tool: "wake_when", arguments: { command: "rm -rf /", reason: "x" }, expectError: true },
      { tool: "wake_when", arguments: { command, reason: "WATCH_NOTE see what landed", every_minutes: 1, max_minutes: 60 } },
    ], reply: "Watching the repo" },
    { expectContextIncludes: ["its output changed", "second DONE", "WATCH_NOTE see what landed"], reply: "Saw the new commit" },
  ] });
  await f.send("Tell me when a new commit lands.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  expect(toolResult(f.turns()[0], "wake_when")).toContain("Vigiando. O servidor roda o comando");
  // Many cadences pass with no change: the command runs, the bot does not.
  await new Promise(resolve => setTimeout(resolve, 1_500));
  expect(f.turns()).toHaveLength(1);
  expect(f.ledger().wakes[0].watch.runs).toBeGreaterThan(2);
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "second DONE");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip.startsWith("Vigia disparou (mudou)")), { timeout: 10_000 }).toBe(true);
  expect(f.ledger().wakes).toEqual([]);
}), 60_000);

it("moves a watch to this conversation when asked, switching off the one elsewhere", () => fixture(async f => {
  const { execFileSync } = await import("node:child_process");
  const repo = join(f.session.info.dataDir, "moved-repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"]);
  const command = `git -C ${repo} log --format=%s -1`;
  f.save({ turns: [
    { steps: [{ tool: "wake_when", arguments: { command, reason: "prod", standing: true, label: "prod" } }], reply: "Armed in A" },
    { steps: [
      { tool: "wake_when", arguments: { command, reason: "prod", standing: true, label: "prod" }, expectError: true },
      { tool: "wake_when", arguments: { command, reason: "prod here", standing: true, label: "prod", move: true } },
    ], reply: "Moved to B" },
  ] });
  await f.send("Watch the repo.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  const threadA = f.bot.activeTaskId;
  const created = await f.api(`/api/bots/${f.bot.id}/tasks`, { title: "Esteira" });
  await runControlOmb(["send", "--bot", f.bot.id, "--task", created.task.threadId, "--text", "Bring the watch here."], { env: { OPENMAUSBOT_URL: f.session.info.url } });
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  expect(toolResult(f.turns()[1], "wake_when")).toContain('Movido de "');
  const wakes = f.ledger().wakes as any[];
  expect(wakes.filter((wake) => wake.watch?.label === "prod").map((wake) => wake.threadId)).toEqual([created.task.threadId]);
  expect(wakes.some((wake) => wake.threadId === threadA)).toBe(false);
}), 60_000);

it("keeps a standing watch armed: it fires on each change and a wake_me does not replace it", () => fixture(async f => {
  const { execFileSync } = await import("node:child_process");
  const repo = join(f.session.info.dataDir, "watched-repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const commit = (message: string) => git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", message);
  execFileSync("git", ["init", "-q", repo]);
  commit("first");
  const command = `git -C ${repo} log --format=%s -1`;
  f.save({ turns: [
    { steps: [{ tool: "wake_when", arguments: { command, reason: "INBOX answer what landed", every_minutes: 1, max_minutes: 60, standing: true } }], reply: "Standing watch on" },
    { expectContextIncludes: ["standing watch", "second ONE", "stays armed"], steps: [{ tool: "wake_me", arguments: { minutes: 30, reason: "unrelated timer" } }], reply: "Handled the first" },
    { expectContextIncludes: ["third TWO"], reply: "Handled the second" },
  ] });
  await f.send("Watch the repo for good.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  expect(toolResult(f.turns()[0], "wake_when")).toContain("Vigia permanente armado");
  commit("second ONE");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  await expect.poll(() => f.ledger().wakes.length, { timeout: 10_000 }).toBe(2);
  commit("third TWO");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(3);
  await expect.poll(() => f.ledger().wakes.find((wake: any) => wake.watch?.standing)?.watch?.fired, { timeout: 10_000 }).toBe(2);
  const standing = f.ledger().wakes.find((wake: any) => wake.watch?.standing);
  expect(standing.watch.trigger).toBeUndefined();
  expect(standing.watch.baseline).toContain("third TWO");
  expect(f.ledger().wakes.some((wake: any) => wake.reason === "unrelated timer")).toBe(true);
  expect((await f.chips()).filter((chip: string) => chip.startsWith("Vigia permanente disparou (mudou)"))).toHaveLength(2);
}), 60_000);

it("manages a Claude Code session: start, get its report, answer it, archive it", async () => {
  const { chmodSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  // A stand-in for `claude`: records each call and answers in stream-json.
  const tools = mkdtempSync(join(tmpdir(), "omb-fake-claude-"));
  const fake = join(tools, "fake-claude.mjs");
  const calls = join(tools, "calls.jsonl");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1];
let cwd = process.cwd();
const w = argv.indexOf("-w");
if (w >= 0) { cwd = join(cwd, ".claude", "worktrees", argv[w + 1]); mkdirSync(cwd, { recursive: true }); }
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const hold = /HOLD:(\\d+)/.exec(prompt);
if (hold) await new Promise(r => setTimeout(r, Number(hold[1])));
console.log(JSON.stringify({ type: "system", subtype: "init", cwd, session_id: "x" }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "did: " + prompt.split("\\n")[0].slice(0, 60), total_cost_usd: 0.01 }));
`);
  chmodSync(fake, 0o755);
  await fixture(async f => {
    const { execFileSync } = await import("node:child_process");
    const data = f.session.info.dataDir;
    const repo = join(data, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const ccLedger = () => JSON.parse(readFileSync(join(data, "cc-sessions.json"), "utf8")).sessions;
    const callLog = () => readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const startTurn = { steps: [{ tool: "cc_session_start", arguments: { title: "#9999 teste", brief: "BRIEF_ONE HOLD:2500", repo, surface: "cli" } }], reply: "Session started" };
    f.save({ turns: [startTurn] });
    await f.send("Open a Claude Code session for #9999.");
    await expect.poll(() => (existsSync(join(data, "cc-sessions.json")) ? ccLedger().length : 0), { timeout: 20_000 }).toBe(1);
    const id = ccLedger()[0].id;
    // Its report wakes the bot; it answers, then archives after the second report.
    f.save({ turns: [
      startTurn,
      { expectContextIncludes: ["finished its turn 1", "did: BRIEF_ONE"], steps: [{ tool: "cc_session_send", arguments: { session_id: id, message: "FOLLOWUP_TWO" } }], reply: "Answered it" },
      { expectContextIncludes: ["finished its turn 2", "did: FOLLOWUP_TWO"], steps: [{ tool: "cc_session_archive", arguments: { session_id: id } }], reply: "Archived it" },
    ] });
    await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(3);
    await expect.poll(() => ccLedger()[0].status, { timeout: 10_000 }).toBe("archived");
    const [first, second] = callLog();
    expect(first.argv.slice(0, 5)).toEqual(["-p", "--session-id", id, "-w", ccLedger()[0].worktree]);
    const { realpathSync } = await import("node:fs");
    expect(realpathSync(first.cwd)).toBe(realpathSync(repo));
    expect(second.argv.slice(0, 3)).toEqual(["-p", "--resume", id]);
    expect(realpathSync(second.cwd)).toBe(realpathSync(join(repo, ".claude", "worktrees", ccLedger()[0].worktree)));
    expect(ccLedger()[0]).toMatchObject({ turns: 2, costUsd: 0.02 });
    const chips = await f.chips();
    expect(chips.some((chip: string) => chip.includes("terminou o turno 1"))).toBe(true);
    expect(chips.some((chip: string) => chip.includes("arquivada"))).toBe(true);
  }, { OMB_CC_BIN: fake });
}, 90_000);

it("sends a session's next report to the conversation that gave the last order", async () => {
  const { chmodSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tools = mkdtempSync(join(tmpdir(), "omb-fake-claude-"));
  const fake = join(tools, "fake-claude.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1];
let cwd = process.cwd();
const w = argv.indexOf("-w");
if (w >= 0) { cwd = join(cwd, ".claude", "worktrees", argv[w + 1]); mkdirSync(cwd, { recursive: true }); }
console.log(JSON.stringify({ type: "system", subtype: "init", cwd, session_id: "x" }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "did: " + prompt.split("\\n")[0].slice(0, 60), total_cost_usd: 0.01 }));
`);
  chmodSync(fake, 0o755);
  await fixture(async f => {
    const { execFileSync } = await import("node:child_process");
    const data = f.session.info.dataDir;
    const repo = join(data, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const ccLedger = () => JSON.parse(readFileSync(join(data, "cc-sessions.json"), "utf8")).sessions;
    const startTurn = { steps: [{ tool: "cc_session_start", arguments: { title: "#9998 origem", brief: "BRIEF_A", repo, surface: "cli" } }], reply: "Session started" };
    f.save({ turns: [startTurn, { expectContextIncludes: ["did: BRIEF_A"], reply: "Report read in A" }] });
    await f.send("Open a Claude Code session for #9998.");
    await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(2);
    const id = ccLedger()[0].id;
    const threadA = f.bot.activeTaskId;
    const created = await f.api(`/api/bots/${f.bot.id}/tasks`, { title: "Chief desk" });
    const threadB = created.task.threadId as string;
    f.save({ turns: [
      startTurn,
      { expectContextIncludes: ["did: BRIEF_A"], reply: "Report read in A" },
      { steps: [{ tool: "cc_session_send", arguments: { session_id: id, message: "ORDER_FROM_B" } }], reply: "Sent from B" },
      { expectContextIncludes: ["did: ORDER_FROM_B"], reply: "Report read in B" },
    ] });
    await runControlOmb(["send", "--bot", f.bot.id, "--task", threadB, "--text", "Steer #9998 from here."], { env: { OPENMAUSBOT_URL: f.session.info.url } });
    await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(4);
    expect(ccLedger()[0].ownerThreadId).toBe(threadB);
    const inB = (await f.api(`/api/threads/${threadB}/messages`, undefined, "GET")).messages as any[];
    await expect.poll(async () => ((await f.api(`/api/threads/${threadB}/messages`, undefined, "GET")).messages as any[]).some((message: any) => message.text === "Report read in B"), { timeout: 10_000 }).toBe(true);
    expect(inB.length).toBeGreaterThan(0);
    const inA = (await f.api(`/api/threads/${threadA}/messages`, undefined, "GET")).messages as any[];
    expect(inA.some((message: any) => message.text === "Report read in B")).toBe(false);
    // Deleting B hands its session to the bot's main conversation, which is told.
    f.save({ turns: [
      startTurn,
      { expectContextIncludes: ["did: BRIEF_A"], reply: "Report read in A" },
      { steps: [{ tool: "cc_session_send", arguments: { session_id: id, message: "ORDER_FROM_B" } }], reply: "Sent from B" },
      { expectContextIncludes: ["did: ORDER_FROM_B"], reply: "Report read in B" },
      { expectContextIncludes: ["they report here from now on", "#9998 origem"], reply: "Taking #9998 over here" },
    ] });
    await f.api(`/api/bots/${f.bot.id}/tasks/${threadB}`, {}, "DELETE");
    expect(ccLedger()[0].ownerThreadId).toBe(threadA);
    await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(5);
    const chips = ((await f.api(`/api/threads/${threadA}/messages`, undefined, "GET")).messages as any[]).map((message: any) => String(message.tool?.name ?? ""));
    expect(chips.some((chip) => chip.includes("passaram para esta conversa"))).toBe(true);
  }, { OMB_CC_BIN: fake });
}, 90_000);

it("lists what waits on the person in \"Precisa de você\" until the bot or the person resolves it", () => fixture(async f => {
  f.save({ turns: [
    { steps: [
      { tool: "owner_pending", arguments: { action: "add", title: "Aprovar o carrier da #9315", due: "hoje 18h" } },
      { tool: "owner_pending", arguments: { action: "add", title: "Decidir sobre a volta da #9290" } },
      { tool: "owner_pending", arguments: { action: "resolve", id: "o2" } },
      { tool: "owner_pending", arguments: { action: "list" } },
    ], reply: "Anotado para você." },
  ] });
  await f.send("O que depende de mim?");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  expect(toolResult(f.turns()[0], "owner_pending")).toContain("o1: Aprovar o carrier da #9315 (até hoje 18h)");
  const pending = async () => ((await f.api("/api/bots", undefined, "GET")).bots.find((bot: any) => bot.id === f.bot.id).tasks ?? []).flatMap((task: any) => task.ownerPending ?? []);
  await expect.poll(async () => (await pending()).map((item: any) => item.title), { timeout: 10_000 }).toEqual(["Aprovar o carrier da #9315"]);
  await f.api(`/api/bots/${f.bot.id}/owner-pending/o1/resolve`, {});
  expect(await pending()).toEqual([]);
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip === "Resolvido pela pessoa: Aprovar o carrier da #9315"), { timeout: 10_000 }).toBe(true);
}), 60_000);
