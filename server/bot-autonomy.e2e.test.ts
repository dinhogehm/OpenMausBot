import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

/** One scripted bot on an isolated server, with minutes shrunk to 200 ms. */
async function fixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({
    ...process.env,
    OMB_AUTONOMY_MINUTE_MS: "200",
    OMB_AUTONOMY_TICK_MS: "100",
    OMB_AUTONOMY_TURN_GAP_MS: "50",
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
    { expectContextIncludes: ["Wake-up you scheduled", "CHECK_PR_9280 merged?"], reply: "PR 9280 is merged" },
  ] });
  await f.send("Check PR 9280 in a minute.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  expect(toolResult(f.turns()[0], "wake_me")).toContain("End your turn now");
  await expect.poll(async () => (await f.messages()).some((message: any) => message.text === "PR 9280 is merged"), { timeout: 10_000 }).toBe(true);
  const chips = await f.chips();
  expect(chips.some((chip: string) => chip.startsWith("Wake-up set for"))).toBe(true);
  expect(chips.some((chip: string) => chip.startsWith("Woke up — CHECK_PR_9280"))).toBe(true);
  // Nobody typed the wake: no second user line appears in the transcript.
  expect((await f.messages()).filter((message: any) => message.role === "user")).toHaveLength(1);
  expect(f.ledger().wakes).toEqual([]);
}), 60_000);

it("keeps giving a goal turns until the bot ends it, then goes quiet", () => fixture(async f => {
  f.save({ turns: [
    { steps: [{ tool: "goal_start", arguments: { goal: "SHIP_9195 to production", max_turns: 5 } }], reply: "Goal accepted" },
    { expectContextIncludes: ["Goal mode — turn 1 of 5", "SHIP_9195 to production"], reply: "Merged the PR" },
    { expectContextIncludes: ["Goal mode — turn 2 of 5"], steps: [{ tool: "goal_end", arguments: { status: "completed", detail: "deployed and verified" } }], reply: "Shipped" },
  ] });
  await f.send("Ship 9195 and don't stop until it is in production.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(3);
  expect(toolResult(f.turns()[0], "goal_start")).toContain("Goal mode is on");
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip === "Goal completed after 2 turns — deployed and verified"), { timeout: 10_000 }).toBe(true);
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
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip.startsWith("Goal paused at its limit after 1 turn")), { timeout: 20_000 }).toBe(true);
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
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip.startsWith("Goal waiting for you")), { timeout: 20_000 }).toBe(true);
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
  expect(chips).toContain("Wake-up cancelled — stopped by you");
  expect(chips.some((chip: string) => chip.startsWith("Goal stopped"))).toBe(true);
  expect(chips.some((chip: string) => chip.startsWith("Goal continues") || chip.startsWith("Woke up"))).toBe(false);
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
  expect(toolResult(f.turns()[0], "wake_when")).toContain("Watching. The server re-runs it");
  // Many cadences pass with no change: the command runs, the bot does not.
  await new Promise(resolve => setTimeout(resolve, 1_500));
  expect(f.turns()).toHaveLength(1);
  expect(f.ledger().wakes[0].watch.runs).toBeGreaterThan(2);
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "second DONE");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(2);
  await expect.poll(async () => (await f.chips()).some((chip: string) => chip.startsWith("Watch fired (changed)")), { timeout: 10_000 }).toBe(true);
  expect(f.ledger().wakes).toEqual([]);
}), 60_000);
