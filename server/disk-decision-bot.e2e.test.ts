import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

/** The system's git: the fixture's PATH is sealed off this machine's CLIs. */
const GIT_DIR = ["/usr/bin", "/bin"].find((dir) => existsSync(join(dir, "git"))) ?? "";

const toolResult = (turn: any, tool: string) =>
  turn.evidence.findLast((entry: any) => entry.step?.tool === tool)?.response?.result?.content?.[0]?.text as string;

const keen = "keen-agnesi-80191d";
const dirty = "503-atendimento-helpdesk-2785c8";
const local = "9337-sobrecarga-d1-no-envio-do-agente-2f6a57";
const held = "merge-deploy-open-prs-00664b";
const n1 = "9032-equipe-em-massa-tickets-n1";
const n1b = "9032-equipe-em-massa-tickets-n1-7d8a26";
const o28 = {
  action: "add",
  title: "Decidir o destino de 4 worktrees paradas",
  why: "Há 23 GiB livres em /Users/osvaldo/Projetos (meta: 25 GiB). Nada foi removido.",
  steps: [
    { text: `${local}: 2,9G, limpa, sem sessão ativa, mas o HEAD NÃO está no GitHub (commits só locais).` },
    { text: `${keen}: 2,2G, limpa, em uso agora (lsof), HEAD na main.` },
    { text: `Com alterações não commitadas, paradas há dias: ${dirty} 848M (02/10, HEAD só local); ${held} 592M (02/10, HEAD só local)` },
    { text: "Para remover uma worktree que você decidir descartar (sem --force; falha se houver alteração)", command: "git -C /Users/osvaldo/Projetos/nuria-platform worktree remove <caminho>" },
  ],
};

/** An isolated scripted server with a real repository and its worktrees, three days old, where the server looks. */
async function diskFixture(test: (f: any) => Promise<void>, extraEnv: Record<string, string> = {}) {
  const session = await launchVerificationServer({ ...process.env, OMB_TEST_GRANT_PATH: GIT_DIR, ...extraEnv }, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = session.info;
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  const reply = (botId: string, id: string, body: unknown) => fetch(`${url}/api/bots/${botId}/owner-pending/${id}/reply`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(body) });
  const ledger = () => (existsSync(join(dataDir, "bot-autonomy.json")) ? JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")) : {});
  const holders: ChildProcess[] = [];
  try {
    const main = join(dataDir, "Projetos", "nuria-platform");
    const root = join(main, ".claude", "worktrees");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    mkdirSync(main, { recursive: true });
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, ".gitignore"), ".claude/\n");
    writeFileSync(join(main, "README.md"), "nuria\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "init");
    for (const folder of [keen, dirty, local, held, n1, n1b]) git(main, "worktree", "add", "-q", "-b", folder, join(root, folder));
    writeFileSync(join(root, dirty, "rascunho.md"), "work only here\n");
    const threeDaysAgo = (Date.now() - 3 * 86_400_000) / 1000;
    const age = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) age(path);
        utimesSync(path, threeDaysAgo, threeDaysAgo);
      }
      utimesSync(dir, threeDaysAgo, threeDaysAgo);
    };
    age(main);
    /** A process working inside a folder, seen by lsof before the test goes on (no fixed sleep). */
    const hold = async (folder: string) => {
      const child = spawn("sleep", ["120"], { cwd: join(root, folder), stdio: "ignore" });
      holders.push(child);
      await expect.poll(() => { try { return execFileSync("/usr/sbin/lsof", ["-a", "-p", String(child.pid), "-d", "cwd", "-Fn"]).toString(); } catch { return ""; } }, { timeout: 10_000 }).toContain(folder);
    };
    await hold(held);
    const bot = (await cli("new-bot", "--name", "Chief of Staff")).bot;
    const planPath = join(dataDir, "room-plan.json");
    const plan = (turns: unknown[]) => writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns } }));
    const turns = () => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((turn: any) => turn.botId === bot.id)
      : [];
    const said = async (words: string) => ((await api(`/api/threads/${bot.activeTaskId}/messages?limit=200`, undefined, "GET")).messages as any[]).find((message) => message.role === "user" && String(message.text ?? "").includes(words));
    await test({ url, dataDir, cli, api, reply, ledger, hold, bot, plan, turns, said, root });
  } finally {
    for (const holder of holders) holder.kill();
    await session.close();
  }
}

// R13-followup #2 and #4 and INSP-R13fol #1, #2, as on 06/10. At 18:39 the
// Chief kept its own item o28, saying keen-agnesi was "em uso agora (lsof)";
// at 18:53 "Pode remover todos" had it run `git worktree remove --force` on it
// too. A real server: the bot's item becomes the server's, checked on the
// Mac; a folder used since refuses the answer (409); "Não remova nada" reaches
// the bot as written; "Pode remover todos" allows no --force and pushes the
// commits only on this Mac first; "Push e remover" is checked on the remote
// after the bot's turn; the 23:10 reply opens its item.
it("a bot's own disk item is the server's; the owner's answer allows only what it says", () => diskFixture(async (f) => {
  const reply2310 = [
    "O servidor mandou o relatório de disco e pastas de trabalho. Não removi nada.",
    "",
    `- **Duas pastas da #9032 sem uso** (\`${n1}\` e \`${n1b}\`): as duas estão vazias e não guardam trabalho nenhum. Pela sua regra, a remoção fica com você. Se quiser apagá-las:`,
    `  - \`git -C /Users/osvaldo/Projetos/nuria-platform worktree remove /Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/${n1}\``,
    `  - \`git -C /Users/osvaldo/Projetos/nuria-platform worktree remove /Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/${n1b}\``,
  ].join("\n");
  f.plan([
    { steps: [{ tool: "owner_pending", arguments: o28 }], reply: "Atualizei o item de disco." },
    { expectContextIncludes: ["Não remova nada ainda.", "[Servidor: conferido no Mac em ", "este texto não autoriza remover nenhuma pasta"], reply: "Certo, não removo." },
    { expectContextIncludes: ["pode decidir por mim", "este texto não autoriza remover nenhuma pasta"], reply: "Não removo: preciso que você escolha." },
    { expectContextIncludes: ["Pode remover todos", "Push primeiro", "PROIBIDO remover qualquer outra pasta", keen], reply: "Faço o push primeiro." },
    // the turn that carried "Pode remover todos" ended with the commit still only here: said once, after THAT turn
    { expectContextIncludes: ["[Servidor: push conferido no remoto]", dirty], reply: "O push ainda não foi; não removo." },
    { expectContextIncludes: ["Push e remover", "ANTES de remover"], reply: "Vou fazer o push." },
    { expectContextIncludes: ["[Servidor: push conferido no remoto]", dirty], reply: "O push ainda não foi; não removo." },
    { reply: reply2310 },
  ]);
  await f.cli("send", "--bot", f.bot.id, "--task", f.bot.activeTaskId, "--text", "Atualize o item de disco.");
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(1);
  expect(toolResult(f.turns()[0], "owner_pending")).toContain("abriu o item de disco dele no lugar do seu");
  await expect.poll(() => (f.ledger().ownerPending ?? []).map((each: any) => each.key), { timeout: 10_000 }).toEqual([`disk-decision:${dirty},${local}`]);
  const [item] = f.ledger().ownerPending;
  expect(item.why).toContain(`${held} (há um processo vivo dentro dela)`);
  expect([...item.diskKept].sort()).toEqual([`${keen} (o próprio item dizia: «${keen}: 2,2G, limpa, em uso agora (lsof), HEAD na main.»)`, `${held} (há um processo vivo dentro dela)`]);
  expect(item.options.map((option: any) => option.label)).toEqual(["Push e remover", "Manter por 7 dias"]);
  // a process starts in 9337 before the owner answers: the answer is refused, the item replaced — what it kept out still said
  await f.hold(local);
  const refused = await f.reply(f.bot.id, item.id, { text: "Pode remover todos" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "disk_item_changed" });
  expect(f.ledger().ownerPending.map((each: any) => each.key)).toEqual([`disk-decision:${dirty}`]);
  const current = f.ledger().ownerPending[0];
  expect(current.diskKept).toEqual(expect.arrayContaining([`${local} (há um processo vivo dentro dela)`, expect.stringMatching(new RegExp(`^${keen} \\(o próprio item dizia:`))]));
  // R2-1: "Não remova nada ainda." and the owner's real answer of 06/10 11:47 are checked on the Mac, carry the state,
  // and say to the bot that they authorize nothing — and to the owner that they were not read as an authorization
  const no = await f.reply(f.bot.id, current.id, { text: "Não remova nada ainda." });
  expect(no.status, await no.clone().text()).toBeLessThan(300);
  expect(await no.json()).toMatchObject({ notice: "O servidor não leu isto como autorização de remoção; para remover, use uma decisão ou cite as pastas." });
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(2);
  const noText = (await f.said("Não remova nada ainda.")).text as string;
  expect(noText).toContain("[Servidor: conferido no Mac em ");
  expect(noText).toContain("[Servidor: este texto não autoriza remover nenhuma pasta. Não remova nada; se o dono quis autorizar, peça a ele que escolha uma decisão ou escreva quais pastas.]");
  const real = await f.reply(f.bot.id, current.id, { text: "pode decidir por mim e fazer o que é necessario" });
  expect(await real.json()).toMatchObject({ notice: expect.stringContaining("não leu isto como autorização") });
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(3);
  // "Pode remover todos": no --force, the commits only here pushed first, every other folder forbidden
  const all = await f.reply(f.bot.id, current.id, { text: "Pode remover todos" });
  expect(all.status, await all.clone().text()).toBeLessThan(300);
  expect((await all.json()).notice).toBeUndefined();
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(5);
  expect(f.ledger().diskPushChecks ?? []).toEqual([]);
  const text = (await f.said("Pode remover todos")).text as string;
  expect(text).toContain(`Push primeiro: faça push da branch e confirme o commit no remoto ANTES de remover; sem isso, não remova (o dono não escreveu que os commits locais podem se perder): ${dirty} (branch ${dirty}).`);
  expect(text).toMatch(new RegExp(`PROIBIDO remover qualquer outra pasta, inclusive as que o item manteve: .*${local} \\(há um processo vivo dentro dela\\).*${keen} \\(o próprio item dizia:`));
  expect(text).not.toContain("com --force");
  expect(text).not.toContain("autorizou remover agora");
  // "Push e remover": push first; after the bot's turn the server looks at the remote and tells it the commit is not there
  const decided = await f.reply(f.bot.id, current.id, { option: 0, label: "Push e remover" });
  expect(decided.status, await decided.clone().text()).toBeLessThan(300);
  // kept in the ledger until the turn that carries the answer ends
  expect(f.ledger().diskPushChecks).toEqual([expect.objectContaining({ botId: f.bot.id, threadId: f.bot.activeTaskId, folders: [expect.objectContaining({ name: dirty, branch: dirty })] })]);
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(7);
  expect(f.ledger().diskPushChecks ?? []).toEqual([]);
  expect((await f.said("Push e remover") ?? await f.said("push da branch")).text).toContain("ANTES de remover");
  const chips = ((await f.api(`/api/threads/${f.bot.activeTaskId}/messages?limit=200`, undefined, "GET")).messages as any[]).map((message) => String(message.tool?.name ?? ""));
  expect(chips).toContain(`Disco: push ainda não está no remoto — ${dirty}`);
  // 23:10: a reply that leaves two worktrees to the owner, "vazias", with the commands — an item, with the size measured
  await f.cli("send", "--bot", f.bot.id, "--task", f.bot.activeTaskId, "--text", "Relatório de disco.");
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(8);
  await expect.poll(() => (f.ledger().ownerPending ?? []).map((each: any) => each.key), { timeout: 15_000 }).toContain(`disk-decision:${n1},${n1b}`);
  const n1Item = f.ledger().ownerPending.find((each: any) => each.key?.startsWith(`disk-decision:${n1},${n1b}`));
  expect(n1Item.title).toMatch(new RegExp(`^Decidir o destino de 2 worktrees paradas \\(~\\d+ (?:MB|KB)\\): ${n1}, ${n1b}$`));
  expect(n1Item.why.startsWith("A remoção dessas worktrees é sua; o servidor conferiu cada uma no Mac.")).toBe(true);
}), 150_000);

// INSP-R13fol R2-3, as the o1 URGENTE of 05/10: a rm -rf of task-workspaces and,
// beside it, a `git worktree remove`. The bot's item keeps its rm -rf; the
// removal goes to the server's disk item, and its command leaves the bot's item.
it("a mixed item keeps its other ask; its worktree removal goes to the server's item beside it", () => diskFixture(async (f) => {
  f.plan([{ steps: [{ tool: "owner_pending", arguments: {
    action: "add", title: "URGENTE: liberar disco, 4 GiB livres com release de produção rodando", why: "O disco caiu para 4 GiB durante o release.",
    steps: [
      { text: "Apagar as pastas de trabalho paradas do Eng (2,2 GB)", command: "rm -rf ~/.openmausbot/task-workspaces/82feff85*/fa9d2302*" },
      { text: `Opcional: remover a worktree ${dirty} (848 MB)`, command: `git -C /Users/osvaldo/Projetos/nuria-platform worktree remove /Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/${dirty}` },
    ],
    options: [{ label: "Apaguei as duas", reply: "Apaguei as pastas paradas e a worktree, confira o disco.", recommended: true, why: "Volta a ~11 GiB livres." }, { label: "Só as pastas", reply: "Apaguei só as pastas paradas." }],
  } }], reply: "Abri o item." }]);
  await f.cli("send", "--bot", f.bot.id, "--task", f.bot.activeTaskId, "--text", "O disco está acabando.");
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(1);
  expect(toolResult(f.turns()[0], "owner_pending")).toContain("A remoção de worktrees deste item vai pelo item de disco do servidor, conferido no Mac");
  const open = f.ledger().ownerPending as any[];
  const own = open.find((each) => !each.key);
  const disk = open.find((each) => each.key?.startsWith("disk-decision:"));
  expect(own.title).toBe("URGENTE: liberar disco, 4 GiB livres com release de produção rodando");
  expect(own.steps[0].command).toBe("rm -rf ~/.openmausbot/task-workspaces/82feff85*/fa9d2302*");
  expect(own.steps[1].command).toBeUndefined();
  expect(own.steps[1].text).toContain("a remoção vai pelo item de disco do servidor");
  expect(disk.key).toBe(`disk-decision:${dirty}`);
}), 120_000);

// INSP-R13fol R3-4: a push check whose turn is never seen (the answer edited,
// the removal done elsewhere) is not dropped silently: when it expires the
// server looks at the remote anyway and says what is still only on this Mac.
it("a push check that expires still looks at the remote and says so", () => diskFixture(async (f) => {
  f.plan([
    { steps: [{ tool: "owner_pending", arguments: o28 }], reply: "Atualizei o item de disco." },
    { reply: "Vou fazer o push." },
    { expectContextIncludes: ["[Servidor: push conferido no remoto, 24 h depois da resposta]", dirty], reply: "Faço o push agora." },
  ]);
  await f.cli("send", "--bot", f.bot.id, "--task", f.bot.activeTaskId, "--text", "Atualize o item de disco.");
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(1);
  const item = f.ledger().ownerPending.find((each: any) => each.key?.startsWith("disk-decision:"));
  const decided = await f.reply(f.bot.id, item.id, { option: 0, label: "Push e remover" });
  expect(decided.status, await decided.clone().text()).toBeLessThan(300);
  await expect.poll(async () => ((await f.api(`/api/threads/${f.bot.activeTaskId}/messages?limit=200`, undefined, "GET")).messages as any[]).map((message) => String(message.tool?.name ?? message.text ?? "")).join("\n"), { timeout: 30_000 }).toContain("(24 h depois)");
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(3);
  expect(f.ledger().diskPushChecks ?? []).toEqual([]);
  const chips = ((await f.api(`/api/threads/${f.bot.activeTaskId}/messages?limit=200`, undefined, "GET")).messages as any[]).map((message) => String(message.tool?.name ?? ""));
  expect(chips.some((chip) => chip.startsWith(`Disco: push ainda não está no remoto (24 h depois) — `) && chip.includes(dirty))).toBe(true);
}, { OMB_DISK_PUSH_CHECK_MS: "1" }), 120_000);

// INSP-R13fol #6: a bot that asks "Quer que eu remova…?" is asked by the
// server to open the item with replacesAsk — that item is the server's disk
// item too, linked to the question, and only one item is open.
it("an item that takes a question's place (replacesAsk) is the server's disk item too", () => diskFixture(async (f) => {
  // ~/.nuria/stop holds the server's request until the plan knows the question's Ref
  const stop = join(f.dataDir, ".nuria", "stop");
  mkdirSync(join(f.dataDir, ".nuria"), { recursive: true });
  writeFileSync(stop, "");
  const asking = { reply: `As worktrees ${dirty} e ${local} estão paradas há 3 dias. Quer que eu remova as duas?` };
  f.plan([asking]);
  await f.cli("send", "--bot", f.bot.id, "--task", f.bot.activeTaskId, "--text", "Como está o disco?");
  const task = async () => ((await f.api("/api/bots", undefined, "GET")).bots.find((bot: any) => bot.id === f.bot.id).tasks ?? []).find((each: any) => each.threadId === f.bot.activeTaskId);
  await expect.poll(async () => (await task())?.goalNeedsInput, { timeout: 20_000 }).toBe(true);
  const ref = `${f.bot.activeTaskId}@${(await task()).goalNeedsInputSince}`;
  f.plan([asking, { expectContextIncludes: ["[Servidor: pergunta sem passo a passo]"], steps: [{ tool: "owner_pending", arguments: {
    action: "add", replacesAsk: ref, title: "Decidir o destino de 2 worktrees paradas",
    why: "Estão paradas há 3 dias.", steps: [{ text: `${dirty} e ${local}`, command: `git -C /Users/osvaldo/Projetos/nuria-platform worktree remove .claude/worktrees/${dirty}` }],
  } }], reply: "Abri o item." }]);
  rmSync(stop);
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(2);
  expect(toolResult(f.turns()[1], "owner_pending")).toContain("abriu o item de disco dele no lugar do seu");
  expect(toolResult(f.turns()[1], "owner_pending")).toContain("Ele substitui a sua pergunta");
  await expect.poll(() => (f.ledger().ownerPending ?? []).map((each: any) => each.key), { timeout: 10_000 }).toEqual([`disk-decision:${dirty},${local}`]);
  const [item] = f.ledger().ownerPending;
  expect(f.ledger().askPromotions).toEqual([expect.objectContaining({ threadId: f.bot.activeTaskId, itemId: item.id })]);
}, { OMB_AUTONOMY_MINUTE_MS: "200", OMB_AUTONOMY_TICK_MS: "100", OMB_AUTONOMY_TURN_GAP_MS: "50", OMB_OWNER_STEPS_ASK_AFTER_MS: "0", OMB_QUESTION_STEPS_ASK_AFTER_MS: "0" }), 120_000);
