import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

/** The system's git: the fixture's PATH is sealed off this machine's CLIs. */
const GIT_DIR = ["/usr/bin", "/bin"].find((dir) => existsSync(join(dir, "git"))) ?? "";

const toolResult = (turn: any, tool: string) =>
  turn.evidence.findLast((entry: any) => entry.step?.tool === tool)?.response?.result?.content?.[0]?.text as string;

// R13-followup #2 and #4, as on 06/10. At 18:39 the Chief kept its own item,
// o28 "Decidir o destino de 15 worktrees paradas", saying keen-agnesi was "em
// uso agora (lsof)"; the server's check never ran, and at 18:53 "Pode remover
// todos" had it run `git worktree remove --force` on it too. At 23:10 it left
// two worktrees in its reply, "vazias" (2,2G each), with the commands, and no
// item. A real server: the bot's item becomes the server's, checked on the Mac;
// the owner's answer reaches the bot with the exact folders that may go; a
// folder used since refuses the answer (409); the reply opens its item.
it("a bot's own disk item is the server's, checked on the Mac, and the owner's answer carries the exact folders", async () => {
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
  const reply2310 = [
    "O servidor mandou o relatório de disco e pastas de trabalho. Não removi nada.",
    "",
    `- **Duas pastas da #9032 sem uso** (\`${n1}\` e \`${n1b}\`): as duas estão vazias e não guardam trabalho nenhum. Pela sua regra, a remoção fica com você. Se quiser apagá-las:`,
    `  - \`git -C /Users/osvaldo/Projetos/nuria-platform worktree remove /Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/${n1}\``,
    `  - \`git -C /Users/osvaldo/Projetos/nuria-platform worktree remove /Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/${n1b}\``,
  ].join("\n");
  const session = await launchVerificationServer({ ...process.env, OMB_TEST_GRANT_PATH: GIT_DIR }, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = session.info;
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  const answer = (botId: string, id: string, text: string) => fetch(`${url}/api/bots/${botId}/owner-pending/${id}/reply`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ text }) });
  const ledger = () => (existsSync(join(dataDir, "bot-autonomy.json")) ? JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")) : {});
  const holders: ChildProcess[] = [];
  try {
    // real worktrees of a real repository, where the server looks (the fixture's home is its data dir)
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
    // three days old, everywhere the server looks for the last change
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
    // a live process inside merge-deploy: in use, whatever the item says
    holders.push(spawn("sleep", ["120"], { cwd: join(root, held), stdio: "ignore" }));
    const bot = (await cli("new-bot", "--name", "Chief of Staff")).bot;
    const planPath = join(dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "owner_pending", arguments: o28 }], reply: "Atualizei o item de disco." },
      { expectContextIncludes: ["Pode remover todos", "o dono autorizou remover agora, e só estas:", "PROIBIDO remover qualquer pasta fora desta lista", keen], reply: "Removo só as da lista." },
      { reply: reply2310 },
    ] } }));
    const turns = () => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((turn: any) => turn.botId === bot.id)
      : [];
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Atualize o item de disco.");
    await expect.poll(() => turns().length, { timeout: 30_000 }).toBe(1);
    // the bot's item is the server's: keyed by the folders, checked on the Mac
    expect(toolResult(turns()[0], "owner_pending")).toContain("abriu o item de disco dele no lugar do seu");
    await expect.poll(() => (ledger().ownerPending ?? []).map((each: any) => each.key), { timeout: 10_000 }).toEqual([`disk-decision:${dirty},${local}`]);
    const [item] = ledger().ownerPending;
    expect(item.why).toContain(`${held} (há um processo vivo dentro dela)`);
    expect(item.why).toContain(`${keen} (o próprio item dizia: «${keen}: 2,2G, limpa, em uso agora (lsof), HEAD na main.»)`);
    expect(JSON.stringify(item.options)).not.toContain(keen);
    expect(item.options.map((option: any) => option.label)).toEqual(["Push e remover", "Manter por 7 dias"]);
    // a process starts in 9337 before the owner answers: the answer is refused, the item replaced — keen still kept out
    holders.push(spawn("sleep", ["120"], { cwd: join(root, local), stdio: "ignore" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refused = await answer(bot.id, item.id, "Pode remover todos");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "disk_item_changed" });
    expect(ledger().ownerPending.map((each: any) => each.key)).toEqual([`disk-decision:${dirty}`]);
    const current = ledger().ownerPending[0];
    expect(current.why).toContain(`${keen} (o próprio item dizia:`);
    expect(current.why).toContain(`${local} (há um processo vivo dentro dela)`);
    // "Pode remover todos": the bot reads the exact list, and every other folder forbidden
    const taken = await answer(bot.id, current.id, "Pode remover todos");
    expect(taken.status, await taken.clone().text()).toBeLessThan(300);
    await expect.poll(() => turns().length, { timeout: 30_000 }).toBe(2);
    const said = ((await api(`/api/threads/${bot.activeTaskId}/messages?limit=100`, undefined, "GET")).messages as any[]).find((message) => message.role === "user" && String(message.text ?? "").includes("Pode remover todos"));
    expect(said.text).toContain(`o dono autorizou remover agora, e só estas: ${dirty} (a remoção perde: alterações não commitadas ou estado desconhecido e commits que não estão no GitHub).`);
    expect(said.text).toContain(`PROIBIDO remover qualquer pasta fora desta lista, inclusive as que o item manteve: ${local} (há um processo vivo dentro dela); ${keen} (o próprio item dizia:`);
    expect(said.text).toContain(`--force só em ${dirty}`);
    expect(said.text).not.toMatch(new RegExp(`só estas:[^.]*${keen}`));
    // 23:10: a reply that leaves two worktrees to the owner, "vazias", with the commands — an item, with the size measured
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Relatório de disco.");
    await expect.poll(() => turns().length, { timeout: 30_000 }).toBe(3);
    // their branches are on no remote here: not proved clean, so the key has no "limpas"
    await expect.poll(() => (ledger().ownerPending ?? []).map((each: any) => each.key), { timeout: 15_000 }).toContain(`disk-decision:${n1},${n1b}`);
    const n1Item = ledger().ownerPending.find((each: any) => each.key?.startsWith(`disk-decision:${n1},${n1b}`));
    expect(n1Item.title).toMatch(new RegExp(`^Decidir o destino de 2 worktrees paradas \\(~\\d+ (?:MB|KB)\\): ${n1}, ${n1b}$`));
    expect(n1Item.why.startsWith("A remoção dessas worktrees é sua; o servidor conferiu cada uma no Mac.")).toBe(true);
    expect(n1Item.steps[1].text).toMatch(new RegExp(`^Veja ${n1} \\(\\d+[KMG];`));
  } finally {
    for (const holder of holders) holder.kill();
    await session.close();
  }
}, 120_000);
