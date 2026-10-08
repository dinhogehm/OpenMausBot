import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
    // the shared state is volatile: it rides the launch message, not the system prompt
    { expectContextIncludes: ["Estado das suas outras conversas", "Mergeei a PR #9313 pelo gate.", "Ordens do dono em vigor", "Não rode ci:local enquanto houver release"], reply: "Entendido, sigo a ordem." },
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
    { expectContextIncludes: ["Conversa com o dono:", "Não fale com o dono aqui"], reply: "Preciso de uma decisão sua: publico o carrier agora?" },
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
  // Stop only once the wake is armed too: under load, a Stop between goal_start
  // and wake_me killed the turn before the wake existed, and no "Despertador
  // cancelado" chip could ever come (the flaky case of 04/10, base and lot U alike)
  await expect.poll(() => f.ledger().wakes?.length ?? 0, { timeout: 20_000 }).toBe(1);
  await f.api(`/api/bots/${f.bot.id}/interrupt`, { threadId: f.bot.activeTaskId });
  await expect.poll(() => f.ledger().goals[0].status, { timeout: 10_000 }).toBe("stopped");
  expect(f.ledger().wakes).toEqual([]);
  writeFileSync(gate, "");
  await new Promise(resolve => setTimeout(resolve, 1_000));
  // The interrupted turn is killed before it records evidence; what matters
  // is that nothing resumed on its own afterwards.
  expect(f.turns()).toHaveLength(0);
  // the chips land as the stop settles: waited for, not read once after a fixed second (INSP-J r1 #13: flaky under load)
  await expect.poll(async () => (await f.chips()).includes("Despertador cancelado — parado por você"), { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip.startsWith("Objetivo parado")), { timeout: 15_000 }).toBe(true);
  const chips = await f.chips();
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
    const startTurn = { steps: [{ tool: "cc_session_start", arguments: { title: "#9999 teste", brief: "BRIEF_ONE HOLD:4000", repo, surface: "cli" } }], reply: "Session started" };
    f.save({ turns: [startTurn] });
    await f.send("Open a Claude Code session for #9999.");
    await expect.poll(() => (existsSync(join(data, "cc-sessions.json")) ? ccLedger().length : 0), { timeout: 20_000 }).toBe(1);
    const id = ccLedger()[0].id;
    // Its report wakes the bot; it answers, then archives after the second report.
    f.save({ turns: [
      startTurn,
      { expectContextIncludes: ["terminou o turno 1", "did: BRIEF_ONE"], steps: [{ tool: "cc_session_send", arguments: { session_id: id, message: "FOLLOWUP_TWO" } }], reply: "Answered it" },
      { expectContextIncludes: ["terminou o turno 2", "did: FOLLOWUP_TWO"], steps: [{ tool: "cc_session_archive", arguments: { session_id: id } }], reply: "Archived it" },
    ] });
    // while it works, its conversation's row says it runs headless, out of the Claude app
    const rowSessions = async () => ((await f.api("/api/bots", undefined, "GET")).bots.find((bot: any) => bot.id === f.bot.id).tasks ?? []).flatMap((task: any) => task.ccSessions ?? []);
    // the bot typed "#9999 teste": the session is titled the owner's way, without "#" (H7)
    await expect.poll(rowSessions, { timeout: 10_000 }).toEqual([expect.objectContaining({ sessionId: id, title: "9999 teste", surface: "cli" })]);
    // the running turn's claude is on the ledger with its start time (a restart can tell if it survived)
    await expect.poll(() => ccLedger()[0].proc?.lstart ?? "", { timeout: 3_000 }).toMatch(/\d{4}$/);
    await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(3);
    await expect.poll(() => ccLedger()[0].status, { timeout: 10_000 }).toBe("archived");
    expect(await rowSessions()).toEqual([]);
    const [first, second] = callLog();
    expect(first.argv.slice(0, 5)).toEqual(["-p", "--session-id", id, "-w", ccLedger()[0].worktree]);
    const { realpathSync } = await import("node:fs");
    expect(realpathSync(first.cwd)).toBe(realpathSync(repo));
    expect(second.argv.slice(0, 3)).toEqual(["-p", "--resume", id]);
    expect(realpathSync(second.cwd)).toBe(realpathSync(join(repo, ".claude", "worktrees", ccLedger()[0].worktree)));
    expect(ccLedger()[0]).toMatchObject({ turns: 2, costUsd: 0.02 });
    expect(ccLedger()[0].proc).toBeUndefined();
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
      { expectContextIncludes: ["they report here from now on", "9998 origem"], reply: "Taking #9998 over here" },
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
      { tool: "owner_pending", arguments: { action: "add", title: "Aprovar o carrier da #9315", due: "hoje 18h", why: "O release das 18h depende dele.", steps: [{ text: "Abra o carrier e confira o diff" }] } },
      { tool: "owner_pending", arguments: { action: "add", title: "Decidir sobre a volta da #9290", why: "A cliente espera a resposta.", steps: [{ text: "Leia o resumo na conversa" }] } },
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

// Lot I: an item opens as a screen with steps and the bot's decisions. The
// person's click goes to the bot in the conversation the item came from,
// and closes the item; an old item without steps is rewritten by the bot
// (owner_pending update) when the person asks for the steps.
it("sends the person's decision to the bot that asked, in its conversation, and resolves the item (lot I)", () => fixture(async f => {
  const steps = [{ text: "Abra a PR e confira o diff", link: "https://github.com/acme/app/pull/12" }, { text: "Rode o gate local", command: "pnpm run ci:local" }];
  // INSP-J2 #7: with 2+ decisions one is recommended, or the call is refused
  const options = [{ label: "Aprovar", reply: "Aprovado: pode fazer o merge da #12.", recommended: true, why: "O gate passou e o QA aprovou." }, { label: "Recusar", reply: "Recusado: não faça o merge." }];
  f.save({ turns: [
    { steps: [
      { tool: "owner_pending", arguments: { action: "add", title: "Aprovar o merge da PR #12", why: "O release de hoje depende dela.", steps, options } },
      // J17: no item without why and steps — refused, saying what is missing
      { tool: "owner_pending", arguments: { action: "add", title: "Liberar a escrita na linha 97 da planilha" }, expectError: true },
      // INSP-J2 #7: two decisions, none recommended — refused too
      { tool: "owner_pending", arguments: { action: "add", title: "Escolher o teto", why: "x", steps: [{ text: "y" }], options: [{ label: "A", reply: "a" }, { label: "B", reply: "b" }] }, expectError: true },
      { tool: "owner_pending", arguments: { action: "add", title: "Liberar a escrita na linha 97 da planilha", why: "O relatório usa a linha 97.", steps: [{ text: "Peça o acesso à planilha" }] } },
      { tool: "owner_pending", arguments: { action: "add", title: "Passos inválidos", steps: [{ text: "Abrir", link: "javascript:alert(1)" }] }, expectError: true },
      // a title that only names someone says nothing to do (INSP-I r1 #2)
      { tool: "owner_pending", arguments: { action: "add", title: "@Chief of Staff", why: "Sem isso o relatório sai errado." }, expectError: true },
    ], reply: "Anotei duas pendências." },
    // while the screen is open, the bot rewrites o1 with its options in the other order
    { expectContextIncludes: ["(o1): Pode inverter a ordem das opções."], steps: [
      { tool: "owner_pending", arguments: { action: "update", id: "o1", options: [...options].reverse() } },
      { tool: "owner_pending", arguments: { action: "update", id: "o1", title: "@Chief of Staff" }, expectError: true },
    ], reply: "Invertidas." },
    // the decision arrives as the person's message, naming the item (the
    // context is JSON: quotes inside it are escaped, so match around them)
    // J18: a decision keeps the item, waiting on the bot, which is told so
    { expectContextIncludes: ["Aprovar o merge da PR #12", "(o1): Aprovado: pode fazer o merge da #12.", "pendência o1 continua em", "aguardando você", "não escrita pela pessoa"], reply: "Fazendo o merge." },
    // asked for the steps, the bot rewrites o2 in place: the ask reaches it as a note
    { expectContextIncludes: ["Me mostre como resolver «Liberar a escrita na linha 97 da planilha», passo a passo.", "não escrita pela pessoa", "owner_pending update, id o2"], steps: [
      { tool: "owner_pending", arguments: { action: "update", id: "o2", why: "Sem a escrita, o relatório de amanhã sai vazio.", steps: [{ text: "Abra a planilha e libere a linha 97", link: "https://docs.example.com/sheet" }], options: [{ label: "Liberei", reply: "Liberei a linha 97." }] } },
    ], reply: "Reescrevi com o passo a passo." },
    { expectContextIncludes: ["(o2): Ainda não consegui, falta acesso."], reply: "Entendido, aguardo." },
  ] });
  await f.send("O que depende de mim?");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  const firstTools = JSON.stringify(f.turns()[0].evidence.map((entry: any) => entry.response?.result?.content?.[0]?.text ?? ""));
  expect(firstTools).toContain("o passo 1 deve começar com https://");
  expect(firstTools).toContain("title só com menção");
  expect(firstTools).toContain("owner_pending recusado: falta why e steps");
  expect(firstTools).toContain("owner_pending recusado: falta a recomendada");
  const pending = async () => ((await f.api("/api/bots", undefined, "GET")).bots.find((bot: any) => bot.id === f.bot.id).tasks ?? []).flatMap((task: any) => task.ownerPending ?? []);
  await expect.poll(async () => (await pending()).map((item: any) => item.id), { timeout: 10_000 }).toEqual(["o1", "o2"]);
  expect((await pending())[0]).toMatchObject({ why: "O release de hoje depende dela.", steps, options });
  const userLines = async () => (await f.messages()).filter((message: any) => message.role === "user").map((message: any) => message.text as string);

  // the screen shows "Aprovar" first; the bot then reverses the options
  await f.api(`/api/bots/${f.bot.id}/owner-pending/o1/reply`, { text: "Pode inverter a ordem das opções." });
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  expect(JSON.stringify(f.turns()[1].evidence.map((entry: any) => entry.response?.result?.content?.[0]?.text ?? ""))).toContain("title só com menção");
  await expect.poll(async () => (await pending())[0]?.options?.[0]?.label, { timeout: 10_000 }).toBe("Recusar");
  // the rewrite is dated on the wire: the screen drops an older "não foi entregue" by it (INSP-J2 r4 A2)
  expect((await pending())[0].updatedAt).toBeGreaterThan((await pending())[0].since);
  expect((await pending())[1].updatedAt).toBeUndefined();
  const before = (await userLines()).length;
  // the click on "Aprovar" (position 0 when it was seen) is refused: position 0 is now "Recusar"
  await expect(f.api(`/api/bots/${f.bot.id}/owner-pending/o1/reply`, { option: 0, label: "Aprovar" })).rejects.toThrow(/reescreveu as opções/);
  await expect(f.api(`/api/bots/${f.bot.id}/owner-pending/o1/reply`, { option: 5, label: "Aprovar" })).rejects.toThrow(/decisão não existe/);
  await expect(f.api(`/api/bots/${f.bot.id}/owner-pending/o1/reply`, { option: 1 })).rejects.toThrow(/reescreveu as opções/);
  expect((await userLines()).length).toBe(before);
  expect((await pending()).map((item: any) => item.id)).toEqual(["o1", "o2"]);
  // the person picks "Aprovar" where it is now
  const decided = await f.api(`/api/bots/${f.bot.id}/owner-pending/o1/reply`, { option: 1, label: "Aprovar" });
  expect(decided.resolved).toBe(0);
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(3);
  // J18: the item stays, waiting on the bot, with the choice in its history (delivered)
  const o1 = (await pending()).find((item: any) => item.id === "o1");
  expect(o1.awaitingSince).toBeGreaterThan(0);
  expect(o1.history).toEqual([
    expect.objectContaining({ kind: "text", text: "Pode inverter a ordem das opções.", delivered: true }),
    expect.objectContaining({ kind: "option", label: "Aprovar", text: "Aprovado: pode fazer o merge da #12.", delivered: true }),
  ]);
  expect((await userLines()).at(-1)).toContain("Aprovado: pode fazer o merge da #12.");
  // INSP-J2 #3: nothing addressed to the bot in the person's balloon
  expect((await userLines()).join("\n")).not.toMatch(/aguardando você|resolva-o|owner_pending/);
  // the person settles it: kept for audit with its history
  await f.api(`/api/bots/${f.bot.id}/owner-pending/o1/resolve`, {});
  expect((await pending()).map((item: any) => item.id)).toEqual(["o2"]);
  const audit = f.ledger().resolvedOwnerPending.find((item: any) => item.id === "o1");
  expect(audit).toMatchObject({ resolvedBy: "owner", history: [expect.objectContaining({ kind: "text" }), expect.objectContaining({ kind: "option", label: "Aprovar" })] });

  // the person asks the bot for (better) steps, in plain words
  await f.api(`/api/bots/${f.bot.id}/owner-pending/o2/reply`, { ask: "steps" });
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(4);
  expect((await userLines()).at(-1)).toBe("Me mostre como resolver «Liberar a escrita na linha 97 da planilha», passo a passo.");
  expect((await userLines()).join("\n")).not.toContain("owner_pending");
  expect(toolResult(f.turns()[3], "owner_pending")).toContain("Atualizado em \"Precisa de você\": o2");
  await expect.poll(async () => (await pending())[0]?.steps?.[0]?.text, { timeout: 10_000 }).toBe("Abra a planilha e libere a linha 97");
  expect((await pending())[0]).not.toHaveProperty("stepsRequestedAt");
  expect((await pending())[0].options).toEqual([{ label: "Liberei", reply: "Liberei a linha 97." }]);

  // free text answers without closing the item
  await f.api(`/api/bots/${f.bot.id}/owner-pending/o2/reply`, { text: "Ainda não consegui, falta acesso." });
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(5);
  expect((await pending()).map((item: any) => item.id)).toEqual(["o2"]);
  await expect(f.api(`/api/bots/${f.bot.id}/owner-pending/o9/reply`, { text: "x" })).rejects.toThrow(/já foi resolvido/);
}), 90_000);

// Lot J2 bug 2 (04/10): "A decisão de produto da #9356 continua com você…"
// sat 13 h in "Precisa de você" as a bare title. The server asks the bot,
// once and as itself, to register its question as an item with why, steps
// and options; never with ~/.nuria/stop; the item then takes the question's place.
it("asks the bot once to register its bare question as an item, never with ~/.nuria/stop, and the item replaces the question (lot J2)", () => fixture(async f => {
  const stop = join(f.session.info.dataDir, ".nuria", "stop");
  mkdirSync(join(f.session.info.dataDir, ".nuria"), { recursive: true });
  writeFileSync(stop, "");
  const options = [{ label: "Opção A", reply: "Siga com a opção A.", recommended: true, why: "Mantém o fluxo atual do cliente." }, { label: "Opção B", reply: "Siga com a opção B." }];
  const asking = { reply: "A decisão de produto da #9356 continua com você, sem registro novo na issue. Sigo com a opção A ou B?" };
  f.save({ turns: [asking] });
  const task = async () => ((await f.api("/api/bots", undefined, "GET")).bots.find((bot: any) => bot.id === f.bot.id).tasks ?? []).find((each: any) => each.threadId === f.bot.activeTaskId);
  await f.send("Como está a #9356?");
  await expect.poll(async () => (await task())?.goalNeedsInput, { timeout: 20_000 }).toBe(true);
  // the bot answers the request with its Ref (INSP-J2b #1: only that link replaces the question); a wrong one is refused
  const ref = `${f.bot.activeTaskId}@${(await task()).goalNeedsInputSince}`;
  const item = { action: "add", title: "Decidir a opção de produto da #9356", why: "A cliente espera a resposta para seguir.", steps: [{ text: "Leia o resumo da #9356", link: "https://github.com/acme/app/issues/9356" }], options };
  f.save({ turns: [asking, { expectContextIncludes: ["[Servidor: pergunta sem passo a passo]", "Sigo com a opção A ou B?", `owner_pending add: replacesAsk \\"${ref}\\"`], steps: [
    { tool: "owner_pending", arguments: { ...item, replacesAsk: `${f.bot.activeTaskId}@1` }, expectError: true },
    { tool: "owner_pending", arguments: { ...item, replacesAsk: "não é um ref" }, expectError: true },
    { tool: "owner_pending", arguments: { ...item, replacesAsk: ref } },
  ], reply: "Registrado." }] });
  // with ~/.nuria/stop: nothing is asked, and "Pedir de novo" is refused saying why
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(existsSync(join(f.session.info.dataDir, "bot-autonomy.json")) ? f.ledger().askPromotions ?? [] : []).toEqual([]);
  expect((await task()).goalNeedsInputStepsAskedAt).toBeUndefined();
  await expect(f.api(`/api/bots/${f.bot.id}/tasks/${f.bot.activeTaskId}/ask-steps`, {})).rejects.toThrow(/nuria\/stop está ativo/);
  expect(f.turns()).toHaveLength(1);
  // without it: one request, as the server, and the bot's item takes the question's place
  rmSync(stop);
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  await expect.poll(async () => (await task())?.goalNeedsInput, { timeout: 10_000 }).toBeUndefined();
  expect((await task()).ownerPending).toEqual([expect.objectContaining({ id: "o1", title: "Decidir a opção de produto da #9356", why: "A cliente espera a resposta para seguir.", options })]);
  // one request, remembered (a restart does not ask again), linked to the item the bot opened with its Ref
  expect(f.ledger().askPromotions).toEqual([expect.objectContaining({ threadId: f.bot.activeTaskId, reportThreadId: f.bot.activeTaskId, text: "Sigo com a opção A ou B?", itemId: "o1" })]);
  expect(toolResult(f.turns()[1], "owner_pending")).toContain("Ele substitui a sua pergunta");
  // never in the person's voice
  expect((await f.messages()).filter((message: any) => message.role === "user").map((message: any) => message.text)).toEqual(["Como está a #9356?"]);
  // the question is gone: "Pedir de novo" has nothing to ask, and nothing is asked again
  await expect(f.api(`/api/bots/${f.bot.id}/tasks/${f.bot.activeTaskId}/ask-steps`, {})).rejects.toThrow(/não espera mais uma resposta sua/);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(f.turns()).toHaveLength(2);
  // INSP-J2b r3: the owner answers in the conversation; the server settles o1 and tells the bot, which may reopen it
  f.save({ turns: [asking, { reply: "Registrado." }, { reply: "Certo, sigo com a B." }, {
    expectContextIncludes: ["[Servidor: pendência fechada]", "O item o1", `reabra o item com owner_pending add replacesAsk \\"${ref}\\"`],
    steps: [{ tool: "owner_pending", arguments: { ...item, replacesAsk: ref } }], reply: "Reabri o item.",
  }] });
  await f.send("Siga com a opção B.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(4);
  expect(f.ledger().resolvedOwnerPending).toEqual([expect.objectContaining({ id: "o1", resolvedBy: "owner", resolvedNote: "respondida na conversa" })]);
  expect(toolResult(f.turns()[3], "owner_pending")).toContain("Ele substitui a sua pergunta");
  const reopened = (await task()).ownerPending;
  expect(reopened).toEqual([expect.objectContaining({ title: "Decidir a opção de produto da #9356" })]);
  expect(f.ledger().askPromotions[0].itemId).toBe(reopened[0].id);
}, { OMB_OWNER_STEPS_ASK_AFTER_MS: "0", OMB_QUESTION_STEPS_ASK_AFTER_MS: "0" }), 90_000);

// The app's records (under the fixture's HOME) decide: with the app able to
// open the repository, a client's issue headless is refused whatever the
// cli_reason says; with the app opening another repository, it runs, and
// the chip records the server's own reason (INSP-H r1 #6).
it.runIf(process.platform === "darwin")("decides a headless session of a client's issue by the app's state, not by the cli_reason (R9-dispatch R9-3)", () => fixture(async f => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  const data = f.session.info.dataDir;
  const repo = join(data, "client-repo");
  const other = join(data, "other-repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["init", "-q", other]);
  // New Session the old way: with worktrees the server makes (lote X, on by
  // default) the app's last folder no longer matters — own-worktrees tests
  writeFileSync(join(data, "own-worktrees-settings.json"), JSON.stringify({ enabled: false }));
  const records = join(data, "Library", "Application Support", "Claude", "claude-code-sessions", "org", "acct");
  mkdirSync(records, { recursive: true });
  const newest = (cwd: string) => writeFileSync(join(records, "local_root.json"), JSON.stringify({ sessionId: "local_root", cliSessionId: "c-root", createdAt: Date.now(), cwd, title: "raiz" }));
  newest(repo);
  // permission_mode "auto" (the CLI's own default) frees nothing (INSP-H r2 #1)
  const start = (path: string, cli_reason: string) => ({ tool: "cc_session_start", arguments: { title: "9058 Chat entra com aviso no Widget", brief: "Issue do cliente (planilha Atendimento, linha 97): investigue e relate. HOLD:100", repo: path, surface: "cli", cli_reason, permission_mode: "auto" }, expectError: path === repo });
  f.save({ turns: [
    { steps: [start(repo, "Sessões no terminal nunca falham por tela bloqueada nem por 409")], reply: "Recusado." },
    { steps: [start(other, "Esteira 24/7 gerida pelo Chief")], reply: "Aberta." },
    ...Array.from({ length: 5 }, () => ({ reply: "ok" })),
  ] });
  await f.send("Abra a sessão da 9058.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  expect(toolResult(f.turns()[0], "cc_session_start")).toContain("cli_reason recusado");
  expect(toolResult(f.turns()[0], "cc_session_start")).toContain("não houve falha no app nas últimas 2 h");
  expect(existsSync(join(data, "cc-sessions.json")) ? JSON.parse(readFileSync(join(data, "cc-sessions.json"), "utf8")).sessions : []).toEqual([]);
  await f.send("Tente no outro repositório.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  expect(toolResult(f.turns()[1], "cc_session_start")).toContain("iniciada na própria worktree");
  expect(await f.chips()).toContain("Sessão 9058 no terminal, fora do app: o app Claude não abre sessão neste repositório agora (outra pasta, ou sem app neste Mac) (o bot disse: Esteira 24/7 gerida pelo Chief)");
}, { OMB_CC_BIN: "/usr/bin/true" }), 60_000);

// The app's own records (under the fixture's HOME) say it reuses a worktree:
// the newest session opened in a folder an older one had (the 409 of 01/10).
it.runIf(process.platform === "darwin")("asks the owner ONCE to unblock the app while it reuses a worktree, whatever hits the 409 (R9-dispatch R9-2)", () => fixture(async f => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  const data = f.session.info.dataDir;
  const repo = join(data, "platform");
  execFileSync("git", ["init", "-q", repo]);
  // New Session the old way: with worktrees the server makes (lote X, on by
  // default) the reused folder no longer blocks — own-worktrees tests
  writeFileSync(join(data, "own-worktrees-settings.json"), JSON.stringify({ enabled: false }));
  const records = join(data, "Library", "Application Support", "Claude", "claude-code-sessions", "org", "acct");
  mkdirSync(records, { recursive: true });
  const folder = join(repo, ".claude", "worktrees", "reabertura-496989");
  const record = (id: string, at: string, title: string) => writeFileSync(join(records, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: `c-${id}`, createdAt: Date.parse(at), cwd: folder, title, isArchived: true }));
  record("local_old", "2026-10-01T12:00:00Z", "Reabertura com defeitos");
  record("local_new", "2026-10-01T16:00:00Z", "Guarda de release");
  const clientStart = { tool: "cc_session_start", arguments: { title: "9058 Chat entra com aviso no Widget", brief: "Issue do cliente (planilha Atendimento, linha 97): investigue.", repo, surface: "cli" } };
  const appStart = (title: string) => ({ tool: "cc_session_start", arguments: { title, brief: "liste as pastas antigas", repo }, expectError: true });
  f.save({ turns: [
    { steps: [clientStart, appStart("9300 limpeza"), appStart("9301 limpeza"), { tool: "owner_pending", arguments: { action: "list" } }], reply: "Bloqueado." },
    ...Array.from({ length: 5 }, () => ({ reply: "ok" })),
  ] });
  await f.send("Abra a sessão da 9058.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBeGreaterThan(0);
  const results = f.turns()[0].evidence.filter((entry: any) => entry.step?.tool).map((entry: any) => String(entry.response?.result?.content?.[0]?.text ?? entry.response?.error?.message ?? ""));
  expect(results).toHaveLength(4);
  // the client's issue: the app is blocked, so it runs headless — the server knows why, and the owner was asked
  expect(results[0]).toContain("iniciada na própria worktree");
  expect(await f.chips()).toContain("Sessão 9058 no terminal, fora do app: o app Claude está reaproveitando worktrees (409 de pasta reaproveitada)");
  // the app path: the 409, pointing at the one item
  expect(results[1]).toContain("não abri: a sessão mais recente do app Claude");
  expect(results[2]).toContain('O pedido ao dono já está em "Precisa de você" (o1)');
  // three starts, one item
  // the gesture the records prove: root, worktree off (INSP-J r1 #8)
  expect(results[3].trim().split("\n")).toEqual([expect.stringMatching(/^o1: Abrir no app uma sessão na raiz de platform, com a worktree desligada, e enviar uma mensagem curta \(destrava o app/)]);
}, { OMB_CC_BIN: "/usr/bin/true" }), 60_000);

it("keeps one \"Precisa de você\" item for one action, whichever conversation asks again (R9-followup #3)", () => fixture(async f => {
  f.save({ turns: [
    { steps: [{ tool: "owner_pending", arguments: { action: "add", title: "Parar o laço do release no cb015584a: echo <sha> > ~/.nuria/declined-production-release.sha", why: "O laço segura a fila.", steps: [{ text: "Grave a recusa", command: "echo <sha> > ~/.nuria/declined-production-release.sha" }] } }], reply: "Anotado." },
    { steps: [{ tool: "owner_pending", arguments: { action: "add", title: "Autorizar pausar o watcher no cb015584a (arquivo halted)", link: "https://github.com/o/r/pull/9341", why: "O laço segura a fila.", steps: [{ text: "Autorize a pausa" }] } }], reply: "Já estava." },
  ] });
  await f.send("O release está em laço.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  const other = await f.api(`/api/bots/${f.bot.id}/tasks`, { title: "Outra conversa" });
  await runControlOmb(["send", "--bot", f.bot.id, "--task", other.task.threadId, "--text", "E o laço?"], { env: { OPENMAUSBOT_URL: f.session.info.url } });
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  expect(toolResult(f.turns()[1], "owner_pending")).toContain("Já existe em \"Precisa de você\" um item para isso: o1: Parar o laço do release no cb015584a");
  expect(toolResult(f.turns()[1], "owner_pending")).toContain(`[conversa ${f.bot.activeTaskId}]`);
  const pending = ((await f.api("/api/bots", undefined, "GET")).bots.find((bot: any) => bot.id === f.bot.id).tasks ?? []).flatMap((task: any) => task.ownerPending ?? []);
  expect(pending.map((item: any) => item.id)).toEqual(["o1"]);
}), 60_000);

it("renews a standing watch whose time limit ran out with nothing seen, without a turn, and takes a new note in place", () => fixture(async f => {
  const { execFileSync } = await import("node:child_process");
  const repo = join(f.session.info.dataDir, "renewed-repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"]);
  const command = `git -C ${repo} log --format=%s -1`;
  f.save({ turns: [
    { steps: [
      { tool: "wake_when", arguments: { command, reason: "OLD note", every_minutes: 1, max_minutes: 5, standing: true, label: "repo" } },
      { tool: "wake_when", arguments: { reason: "NEW note", update_reason: true, label: "repo" } },
    ], reply: "Watching" },
  ] });
  await f.send("Watch the repo.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  expect(toolResult(f.turns()[0], "wake_when")).toContain("atualizado");
  const standing = () => f.ledger().wakes.find((wake: any) => wake.watch?.label === "repo");
  const firstDue = standing().dueAt;
  // five "minutes" (1 s) pass with nothing new: renewed, no turn
  await expect.poll(() => standing()?.dueAt > firstDue, { timeout: 10_000 }).toBe(true);
  expect(f.turns()).toHaveLength(1);
  expect(standing().reason).toBe("NEW note");
  expect(standing().watch.fired ?? 0).toBe(0);
}), 60_000);

// R10-followup #5: the Chief's 'prod' note still asked to close #9327 a day
// after it merged. A fake gh answers GitHub's issues API: #4242 merged, #4243 open.
const refsBin = mkdtempSync(join(tmpdir(), "omb-refs-gh-"));
writeFileSync(join(refsBin, "gh"), [
  "#!/bin/sh",
  "case \"$2\" in",
  "  */issues/4242) printf 'closed\\ttrue\\t2026-10-01T21:02:11Z\\n' ;;",
  "  */issues/4243) printf 'open\\ttrue\\t\\n' ;;",
  "  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;",
  "esac",
].join("\n"));
chmodSync(join(refsBin, "gh"), 0o755);

it("tells the bot, under an hour-old note, which PRs it names are no longer open (R10-followup #5)", () => fixture(async f => {
  const { execFileSync } = await import("node:child_process");
  const repo = join(f.session.info.dataDir, "refs-repo");
  const commit = (message: string) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", message]);
  execFileSync("git", ["init", "-q", repo]);
  commit("first");
  const command = `git -C ${repo} log --format=%s -1`;
  f.save({ turns: [
    { steps: [{ tool: "wake_when", arguments: { command, reason: "Tag andou: fechar carrier #4242 e liberar gate da #4243 em https://github.com/acme/web", every_minutes: 1, max_minutes: 600, standing: true, label: "prod" } }], reply: "Watching" },
    { expectContextIncludes: ["no longer open: PR #4242 merged.", "check before redoing it", "update_reason"], reply: "Checked" },
  ] });
  await f.send("Watch the tag.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  // an "hour" (60 shrunk minutes = 12 s) passes, then the watched output changes
  await new Promise((resolve) => setTimeout(resolve, 13_000));
  commit("second");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  const context = JSON.stringify(f.turns()[1]);
  // the open PR is not said: it is what the note expects
  expect(context).not.toContain("PR #4243");
  await expect.poll(async () => (await f.messages()).some((message: any) => message.text === "Checked"), { timeout: 10_000 }).toBe(true);
}, { OMB_TEST_GRANT_PATH: `${refsBin}${delimiter}${GIT_DIR}` }), 60_000);

// INSP-U r1 U1: the look-up runs between "the intake lock is free" and taking it.
// This gh says it was called, then takes 5 s to answer.
const slowRefsBin = mkdtempSync(join(tmpdir(), "omb-refs-slow-gh-"));
const slowRefsCalled = join(slowRefsBin, "called");
writeFileSync(join(slowRefsBin, "gh"), [
  "#!/bin/sh",
  // the fixture's PATH is sealed: sleep by its full path
  `: > ${JSON.stringify(slowRefsCalled)}`,
  "/bin/sleep 5",
  "case \"$2\" in",
  "  */issues/4242) printf 'closed\\ttrue\\t2026-10-01T21:02:11Z\\n' ;;",
  "  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;",
  "esac",
].join("\n"));
chmodSync(join(slowRefsBin, "gh"), 0o755);

it("a routine that takes the intake lock while the watch looks its note up on GitHub runs alone; the watch waits for it (INSP-U r1 U1)", () => fixture(async f => {
  const { execFileSync } = await import("node:child_process");
  const repo = join(f.session.info.dataDir, "refs-repo");
  const commit = (message: string) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", message]);
  execFileSync("git", ["init", "-q", repo]);
  commit("first");
  const gate = join(f.session.info.dataDir, "routine.gate");
  f.save({ turns: [
    { steps: [{ tool: "wake_when", arguments: { command: `git -C ${repo} log --format=%s -1`, reason: "Tag andou: fechar carrier #4242 em https://github.com/acme/web", every_minutes: 1, max_minutes: 600, standing: true, label: "prod" } }], reply: "Watching" },
    // the routine's intake turn, held open until the test says
    { expectContextIncludes: ["ROUTINE_U1 read the Chat"], gateFile: gate, reply: "Routine read" },
    { expectContextIncludes: ["no longer open: PR #4242 merged."], reply: "Checked" },
  ] });
  const { routine } = await f.api("/api/routines", {
    name: "Intake", prompt: "ROUTINE_U1 read the Chat", botId: f.bot.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
  });
  await f.send("Watch the tag.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  // an "hour" (12 s) passes, the watched output changes: the watch fires and asks gh
  await new Promise((resolve) => setTimeout(resolve, 13_000));
  commit("second");
  await expect.poll(() => existsSync(slowRefsCalled), { timeout: 20_000 }).toBe(true);
  // while gh sleeps, the same bot's routine sees the lock free and takes it
  const { run } = await f.api(`/api/routines/${routine.id}/run`, {});
  await expect.poll(async () => (await f.api("/api/routines", undefined, "GET")).runs.find((each: any) => each.id === run.id)?.status, { timeout: 15_000 }).toBe("running");
  // gh answers; the watch must not start next to the routine
  await new Promise((resolve) => setTimeout(resolve, 7_000));
  const log = () => readFileSync(f.session.info.logPath, "utf8");
  expect(log()).toMatch(/\[intake\] wake prod in \S+ of \S+ waits behind \S+ \(the bot's other intake turn\)/);
  expect((await f.chips()).some((chip: string) => chip.startsWith('Vigia permanente "prod" disparou'))).toBe(false);
  writeFileSync(gate, "open");
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(3);
  const turns = f.turns();
  // one intake turn after the other: each read its own step of the plan
  expect(turns.map((turn: any) => turn.turnIndex)).toEqual([0, 1, 2]);
  expect(turns[1].threadId).not.toBe(f.bot.activeTaskId);
  expect(turns[2].threadId).toBe(f.bot.activeTaskId);
  expect(log()).toContain(`waits behind ${turns[1].threadId}`);
  await expect.poll(async () => (await f.messages()).some((message: any) => message.text === "Checked"), { timeout: 10_000 }).toBe(true);
}, { OMB_TEST_GRANT_PATH: `${slowRefsBin}${delimiter}${GIT_DIR}` }), 90_000);

/** A fake claude that behaves as Claude Code does with a gate run in the
 * background: GATE starts a "ci:local" in a group of its own in the worktree,
 * which ends when the file RELEASE:<path> exists; the turn ends when the gate
 * does (the claude hears its result); on SIGTERM it kills that background
 * gate before exiting, as Claude Code kills its background shells. */
async function gateFake() {
  const { chmodSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tools = mkdtempSync(join(tmpdir(), "omb-fake-claude-gate-"));
  const fake = join(tools, "fake-claude.mjs");
  const calls = join(tools, "calls.jsonl");
  const gatePid = join(tools, "gate.pid");
  const gateScript = join(tools, "local-ci.cjs");
  writeFileSync(gateScript, `const { existsSync } = require("node:fs"); const release = process.argv[2]; setInterval(() => { if (existsSync(release)) process.exit(0); }, 100); setTimeout(() => process.exit(0), 120000);\n`);
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1];
let cwd = process.cwd();
const w = argv.indexOf("-w");
if (w >= 0) { cwd = join(cwd, ".claude", "worktrees", argv[w + 1]); mkdirSync(cwd, { recursive: true }); }
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv }) + "\\n");
// SLOWINIT: says its init (its cwd) only past the turn limit, as a claude slow to start under load
const slow = /SLOWINIT/.test(prompt);
if (!slow) console.log(JSON.stringify({ type: "system", subtype: "init", cwd, session_id: "x" }));
const release = /RELEASE:(\\S+)/.exec(prompt);
if (release) {
  // node running the gate's script, as npm → local-ci does
  const gate = spawn(process.execPath, [${JSON.stringify(gateScript)}, release[1]], { cwd, detached: true, stdio: "ignore" });
  writeFileSync(${JSON.stringify(gatePid)}, String(gate.pid));
  if (slow) setTimeout(() => console.log(JSON.stringify({ type: "system", subtype: "init", cwd, session_id: "x" })), 8000);
  process.on("SIGTERM", () => { try { process.kill(-gate.pid, "SIGKILL"); } catch {} process.exit(143); });
  await new Promise((resolve) => gate.on("exit", resolve));
}
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "gate verde no head", total_cost_usd: 0.01 }));
`);
  chmodSync(fake, 0o755);
  return {
    fake, tools,
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length : 0),
    gatePid: () => (existsSync(gatePid) ? Number(readFileSync(gatePid, "utf8")) : 0),
  };
}

// R8-resilience TO, INSP-R13res A1: on a cut Claude Code kills its background
// gate, so a turn past its limit while its gate runs is not cut: the cut
// waits, the gate ends, the claude hears it and ends its turn as usual.
it("does not cut a turn past its limit while its gate runs: the turn hears the gate's end and finishes (R8-resilience TO, INSP-R13res A1)", async () => {
  const { fake, tools, calls, gatePid } = await gateFake();
  const release = join(tools, "release");
  await fixture(async f => {
    const { execFileSync } = await import("node:child_process");
    const data = f.session.info.dataDir;
    const repo = join(data, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const ccLedger = () => JSON.parse(readFileSync(join(data, "cc-sessions.json"), "utf8")).sessions;
    f.save({ turns: [
      // its init comes after the first check: the gate is found in the worktree a first turn makes
      { steps: [{ tool: "cc_session_start", arguments: { title: "#9998 gate longo", brief: `RELEASE:${release} SLOWINIT`, repo, surface: "cli" } }], reply: "Started" },
      { reply: "Done" },
      { reply: "spare" },
    ] });
    await f.send("Run the long gate.");
    // past the limit with its gate running: the cut waits, nothing is killed
    try {
      await expect.poll(async () => (await f.chips()).some((chip: string) => chip.includes("mas o gate (ci:local) da sessão ainda roda; o corte espera o gate terminar (até 10 min de turno)")), { timeout: 20_000 }).toBe(true);
    } catch (error) {
      // the server's own account of the turn says why
      throw new Error(`${String(error)}\nledger: ${JSON.stringify(ccLedger()[0])}\ngate pid ${gatePid()}\n${readFileSync(f.session.info.logPath, "utf8").split("\n").filter((line) => line.includes("[cc-sessions]")).join("\n")}`);
    }
    expect(ccLedger()[0].status).toBe("running");
    expect(() => process.kill(gatePid(), 0)).not.toThrow();
    // the gate ends: the turn ends by itself, not cut, nothing to follow
    writeFileSync(release, "");
    await expect.poll(() => ccLedger()[0].status, { timeout: 20_000 }).toBe("idle");
    expect(ccLedger()[0]).toMatchObject({ lastReport: "gate verde no head" });
    expect(ccLedger()[0].bgJob).toBeUndefined();
    expect((await f.chips()).some((chip: string) => chip.includes("turno cortado"))).toBe(false);
    expect(calls()).toBe(1);
  }, { OMB_CC_BIN: fake, OMB_CC_TURN_TIMEOUT_MS: "3000", OMB_CC_GATE_WAIT_MAX_MS: "600000" });
}, 90_000);

// INSP-R13res A1: past the gate's ceiling the turn is cut, and since the cut
// kills its background gate, it says so — no background job, no resumption
// telling the session its gate "finished".
it("cuts a turn whose gate runs past the ceiling, and says the gate was stopped with no result (INSP-R13res A1)", async () => {
  const { fake, tools, calls, gatePid } = await gateFake();
  const release = join(tools, "release");
  await fixture(async f => {
    const { execFileSync } = await import("node:child_process");
    const data = f.session.info.dataDir;
    const repo = join(data, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const ccLedger = () => JSON.parse(readFileSync(join(data, "cc-sessions.json"), "utf8")).sessions;
    f.save({ turns: [
      { steps: [{ tool: "cc_session_start", arguments: { title: "#9995 gate travado", brief: `RELEASE:${release}`, repo, surface: "cli" } }], reply: "Started" },
      { reply: "Cut" },
      { reply: "spare" },
    ] });
    await f.send("Run the stuck gate.");
    await expect.poll(async () => (await f.chips()).some((chip: string) => chip.includes("o corte espera o gate terminar")), { timeout: 20_000 }).toBe(true);
    // the ceiling passes: cut, its gate killed with it
    await expect.poll(() => ccLedger()[0].status, { timeout: 30_000 }).toBe("failed");
    // said in the cut's own write, with how long the cut really waited (R2 B1, B7)
    // on a failure, the server's own gate checks say why
    const gateLog = () => readFileSync(f.session.info.logPath, "utf8").split("\n").filter((line) => line.includes("gate check")).join("\n");
    expect(ccLedger()[0].lastError, gateLog()).toMatch(/it was cut while its gate \(ci:local\) still ran, after waiting \d+ min for it/);
    await expect.poll(async () => (await f.chips()).some((chip: string) => /turno cortado com 1 min de turno, depois de esperar \d+ min pelo gate \(ci:local\) — gate interrompido pelo corte, sem resultado/.test(chip)), { timeout: 15_000 }).toBe(true);
    // killed by its claude on the cut (reaped by launchd a moment later)
    await expect.poll(() => { try { process.kill(gatePid(), 0); return true; } catch { return false; } }, { timeout: 5_000 }).toBe(false);
    expect(ccLedger()[0].bgJob).toBeUndefined();
    expect((await f.chips()).some((chip: string) => chip.includes("o servidor retoma a sessão"))).toBe(false);
    expect(calls()).toBe(1);
  }, { OMB_CC_BIN: fake, OMB_CC_TURN_TIMEOUT_MS: "3000", OMB_CC_GATE_WAIT_MAX_MS: "8000" });
}, 90_000);

it("queues starts once the 4 slots are taken, opens the P1 first when they free, and lets the bot cancel one (INSP-F F3)", async () => {
  const { chmodSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tools = mkdtempSync(join(tmpdir(), "omb-fake-claude-queue-"));
  const fake = join(tools, "fake-claude.mjs");
  const calls = join(tools, "calls.jsonl");
  // HOLD:<ms> keeps the session's turn (and its slot) that long
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1];
let cwd = process.cwd();
const w = argv.indexOf("-w");
if (w >= 0) { cwd = join(cwd, ".claude", "worktrees", argv[w + 1]); mkdirSync(cwd, { recursive: true }); }
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ first: prompt.split("\\n")[0] }) + "\\n");
console.log(JSON.stringify({ type: "system", subtype: "init", cwd, session_id: "x" }));
const hold = /HOLD:(\\d+)/.exec(prompt);
if (hold) await new Promise(r => setTimeout(r, Number(hold[1])));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01 }));
`);
  chmodSync(fake, 0o755);
  await fixture(async f => {
    const { execFileSync } = await import("node:child_process");
    const data = f.session.info.dataDir;
    const repo = join(data, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const start = (title: string, hold: number, extra: object = {}) => ({ tool: "cc_session_start", arguments: { title, brief: `${title} HOLD:${hold}`, repo, surface: "cli", ...extra } });
    f.save({ turns: [
      { steps: [
        start("#9901 um", 6000), start("#9902 dois", 6000), start("#9903 três", 6000), start("#9904 quatro", 6000),
        // the brief says "hotfix" in passing: not urgent, the title decides
        { tool: "cc_session_start", arguments: { title: "#9905 limpeza", brief: "não use os scripts de hotfix HOLD:100", repo, surface: "cli" } },
        start("#9906 queda do login", 100, { priority: "P1" }),
        start("#9907 a cancelar", 100),
        // the same start twice keeps its one place
        start("#9907 a cancelar", 100),
        { tool: "cc_session_list", arguments: {} },
      ], reply: "Queued" },
      ...Array.from({ length: 20 }, () => ({ reply: "ok" })),
    ] });
    await f.send("Abra as sete sessões.");
    await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBeGreaterThan(0);
    const results = f.turns()[0].evidence.filter((entry: any) => entry.step?.tool).map((entry: any) => String(entry.response?.result?.content?.[0]?.text ?? ""));
    expect(results.slice(0, 4).every((text: string) => text.includes("iniciada na própria worktree"))).toBe(true);
    expect(results[4]).toContain("entrou na fila de sessões (#1, prioridade normal");
    expect(results[5]).toContain("entrou na fila de sessões (#1, prioridade P1");
    expect(results[6]).toContain("entrou na fila de sessões (#3, prioridade normal");
    const queueId = /id ([0-9a-f]{8})\)/.exec(results[6])![1];
    expect(results[7]).toContain(`já estava na fila de sessões (#3, id ${queueId})`);
    // titled the owner's way, without "#" (H7), whatever the bot typed
    expect(results[8]).toContain('1. "9906 queda do login" · prioridade P1');
    expect(results[8]).toContain(`3. "9907 a cancelar" · prioridade normal`);
    const chips = await f.chips();
    expect(chips).toContain('Fila de sessões: "9906 queda do login" é a #1 (prioridade P1); abre sozinha quando uma vaga liberar');
    // the bot takes one out of the queue with its id, in its next turn (the
    // four sessions hold their slots for 6 s, so nothing else wakes it before)
    expect(f.turns()).toHaveLength(1);
    f.save({ turns: [
      { reply: "Queued" },
      { steps: [{ tool: "cc_session_archive", arguments: { session_id: queueId } }], reply: "Cancelled" },
      ...Array.from({ length: 20 }, () => ({ reply: "ok" })),
    ] });
    await f.send("Tire a #9907 da fila.");
    await expect.poll(async () => (await f.chips()).includes('Fila de sessões: "9907 a cancelar" saiu da fila (cancelado)'), { timeout: 20_000 }).toBe(true);
    // the four free their slots: the P1 opens before the one that came first
    await expect.poll(() => readFileSync(calls, "utf8").trim().split("\n").length, { timeout: 30_000 }).toBe(6);
    const opened = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line).first as string);
    // (a CLI session's first line is its brief)
    expect(opened.slice(4)).toEqual(["#9906 queda do login HOLD:100", "não use os scripts de hotfix HOLD:100"]);
    const after = await f.chips();
    expect(after.indexOf('Fila de sessões: "9906 queda do login" abriu')).toBeGreaterThan(-1);
    expect(after.indexOf('Fila de sessões: "9906 queda do login" abriu')).toBeLessThan(after.indexOf('Fila de sessões: "9905 limpeza" abriu'));
    expect(after.some((chip: string) => chip.includes('"9907 a cancelar" abriu'))).toBe(false);
  }, { OMB_CC_BIN: fake });
}, 120_000);

it("forgets the conversation the owner named when it is archived, and the next one says the warnings come there now (INSP-F F2-b)", () => fixture(async f => {
  f.save({ turns: [{ reply: "Oi" }, { reply: "Combinado, falo com você só aqui" }] });
  const threadA = f.bot.activeTaskId;
  await f.send("Oi, tudo certo por aqui?");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(1);
  const created = await f.api(`/api/bots/${f.bot.id}/tasks`, { title: "Esteira" });
  const threadB = created.task.threadId as string;
  await runControlOmb(["send", "--bot", f.bot.id, "--task", threadB, "--text", "Use só a conversa da esteira para falar comigo."], { env: { OPENMAUSBOT_URL: f.session.info.url } });
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  const sharedState = () => JSON.parse(readFileSync(join(f.session.info.dataDir, "bots", f.bot.id, "shared-state.json"), "utf8"));
  await expect.poll(() => sharedState().ownerThread?.threadId, { timeout: 10_000 }).toBe(threadB);
  await f.api(`/api/bots/${f.bot.id}/tasks/${threadB}`, { archivedAt: Date.now() }, "PATCH");
  const chipsOf = async (threadId: string) => ((await f.api(`/api/threads/${threadId}/messages`, undefined, "GET")).messages as any[]).filter((message: any) => message.kind === "activity").map((message: any) => String(message.tool?.name ?? ""));
  await expect.poll(() => chipsOf(threadA), { timeout: 10_000 }).toContain('a conversa com o dono ("Esteira") foi arquivada; os avisos vêm para cá');
  expect(sharedState().ownerThread).toBeUndefined();
}), 60_000);

/** A fake claude for the cut tests: the first prompt's GATE:<ms> (a job in a
 * group of its own that outlives the cut, as one started with nohup does; not
 * a gate, which the cut would wait for — see gateFake), MCP (a child in the claude's own group, working in
 * the worktree, that dies 2 s after the claude) and HOLD:<ms> (outlasting the
 * limit) are kept in a file and apply to every turn, the resumption too. */
async function cutFake() {
  const { chmodSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tools = mkdtempSync(join(tmpdir(), "omb-fake-claude-cut2-"));
  const fake = join(tools, "fake-claude.mjs");
  const calls = join(tools, "calls.jsonl");
  const directives = join(tools, "directives.txt");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1];
let cwd = process.cwd();
const w = argv.indexOf("-w");
if (w >= 0) { cwd = join(cwd, ".claude", "worktrees", argv[w + 1]); mkdirSync(cwd, { recursive: true }); }
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv }) + "\\n");
if (!existsSync(${JSON.stringify(directives)})) writeFileSync(${JSON.stringify(directives)}, prompt.split("\\n")[0]);
const said = readFileSync(${JSON.stringify(directives)}, "utf8");
if (/\\bMCP\\b/.test(said)) spawn(process.execPath, ["-e", "const p = process.ppid; setInterval(() => { try { process.kill(p, 0); } catch { setTimeout(() => process.exit(0), 2000); } }, 100)", "mcp-server"], { cwd, stdio: "ignore" }).unref();
const gate = /GATE:(\\d+)/.exec(said);
if (gate) spawn(process.execPath, ["-e", "setTimeout(() => {}, " + gate[1] + ")", "long-job"], { cwd, detached: true, stdio: "ignore" }).unref();
console.log(JSON.stringify({ type: "system", subtype: "init", cwd, session_id: "x" }));
const hold = /HOLD:(\\d+)/.exec(said);
if (hold) await new Promise(r => setTimeout(r, Number(hold[1])));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "did: " + prompt.split("\\n")[0].slice(0, 60), total_cost_usd: 0.01 }));
`);
  chmodSync(fake, 0o755);
  return { fake, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length : 0) };
}

it("after a cut, the claude's own group (an MCP server dying with it) is not a background job (INSP-G r1 item 10)", async () => {
  const { fake, calls } = await cutFake();
  await fixture(async f => {
    const { execFileSync } = await import("node:child_process");
    const data = f.session.info.dataDir;
    const repo = join(data, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const ccLedger = () => JSON.parse(readFileSync(join(data, "cc-sessions.json"), "utf8")).sessions;
    f.save({ turns: [
      { steps: [{ tool: "cc_session_start", arguments: { title: "#9997 trava com MCP", brief: "MCP HOLD:30000", repo, surface: "cli" } }], reply: "Started" },
      { reply: "Cut" },
    ] });
    await f.send("Run it.");
    await expect.poll(() => (existsSync(join(data, "cc-sessions.json")) ? ccLedger()[0]?.status : undefined), { timeout: 20_000 }).toBe("failed");
    // the MCP child outlives the claude by 2 s: long enough to be seen, never followed
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(ccLedger()[0].bgJob).toBeUndefined();
    expect((await f.chips()).some((chip: string) => chip.includes("turno cortado em"))).toBe(false);
    expect(calls()).toBe(1);
  }, { OMB_CC_BIN: fake, OMB_CC_TURN_TIMEOUT_MS: "3000" });
}, 60_000);

it("resumes a cut turn once: cut again right after, it is not resumed a second time (INSP-G r1 item 10)", async () => {
  const { fake, calls } = await cutFake();
  await fixture(async f => {
    const { execFileSync } = await import("node:child_process");
    const data = f.session.info.dataDir;
    const repo = join(data, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const ccLedger = () => JSON.parse(readFileSync(join(data, "cc-sessions.json"), "utf8")).sessions;
    f.save({ turns: [
      { steps: [{ tool: "cc_session_start", arguments: { title: "#9996 trava estrutural", brief: "GATE:6000 HOLD:30000", repo, surface: "cli" } }], reply: "Started" },
      { reply: "Cut once" },
      { reply: "Cut twice" },
      { reply: "spare" },
    ] });
    await f.send("Run the gate.");
    // first cut: its gate (own group) is followed, the session resumed when it ends
    await expect.poll(() => (existsSync(join(data, "cc-sessions.json")) ? ccLedger()[0]?.bgJob?.afterCut ?? false : false), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => calls(), { timeout: 40_000 }).toBe(2);
    // the resumption is cut too, leaving another gate: no second resumption
    await expect.poll(async () => (await f.chips()).some((chip: string) => chip.includes("duas vezes seguidas")), { timeout: 20_000 }).toBe(true);
    expect(ccLedger()[0].bgJob).toBeUndefined();
    expect(ccLedger()[0].resumedAfterCut).toBeUndefined();
    // well past the second gate's end: still two turns
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    expect(calls()).toBe(2);
    expect(ccLedger()[0].bgJob).toBeUndefined();
  }, { OMB_CC_BIN: fake, OMB_CC_TURN_TIMEOUT_MS: "3000" });
}, 120_000);
