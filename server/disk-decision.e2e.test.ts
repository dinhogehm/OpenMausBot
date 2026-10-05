import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

// R12-followup #5, as on 05/10 at 11:38: the Chief's hourly disk routine ends
// with "8204, 9052 e atendimento-reaberto somam cerca de 5,5 GiB… alguém pode
// remover essas pastas manualmente" after a long table — past the 2 000
// characters a run's output keeps. A real server running the routine twice
// opens ONE item in "Precisa de você" for those three folders.
it("a disk routine that leaves folders to the owner opens one item with why, steps and decisions, once", async () => {
  const folders = ["8204-reprovado-sidebar-da-fila-nao-refle-9b50cd", "9052-tempo-de-reabertura-configuravel-35787b", "atendimento-reaberto-bugs-496989", "9334-9331-inatividade-do-chat-c38a86", "merge-deploy-open-prs-00664b"];
  const rows = [
    "| 8204-reprovado-sidebar-da-fila-nao-refle-9b50cd | 3,0G | commits só locais |",
    "| 9052-tempo-de-reabertura-configuravel-35787b | 2,2G | commits só locais |",
    "| 9334-9331-inatividade-do-chat-c38a86 | 901M | alterações não salvas, commits só locais; sessão ativa |",
    "| merge-deploy-open-prs-00664b | 592M | alterações não salvas, commits só locais |",
    "| atendimento-reaberto-bugs-496989 | 263M | commits só locais |",
  ];
  const reply = [
    "**Alerta de disco:** só restam **9 GiB livres**, abaixo do limite de 10 GiB. Nesta rodada não apaguei nada, então o espaço ficou igual antes e depois.",
    "",
    `- **Verificação das 24 h:** ${"essa checagem falhou nesta rodada porque o `find` do Mac não aceitou o formato de data. ".repeat(14)}`,
    "",
    "| Worktree | Tamanho | Motivo |",
    "|---|---|---|",
    ...rows,
    "",
    "**Onde dá para liberar mais espaço:** as três worktrees com commits só locais e sem alterações (8204, 9052 e atendimento-reaberto) somam cerca de 5,5 GiB, e a merge-deploy-open-prs-00664b mais 592M. Se esse trabalho já entrou na main por squash, alguém pode remover essas pastas manualmente; a rotina não pode removê-las.",
  ].join("\n");
  expect(reply.length).toBeGreaterThan(2_000);
  // the sealed fixture PATH has no git: granted by name
  const gitDir = dirname(execFileSync("/usr/bin/which", ["git"]).toString().trim());
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify([reply, reply, reply, reply]), OMB_TEST_GRANT_PATH: gitDir });
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response.json() as Promise<any>;
  };
  let holder: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  let third: ChildProcess | undefined;
  let fourth: ChildProcess | undefined;
  const ledger = () => (existsSync(join(dataDir, "bot-autonomy.json")) ? JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")) : {});
  try {
    // the worktrees, where the server looks for them (the fixture's home is its data dir)
    // real git worktrees of a real repository: the server reads their status and the repository's worktree list
    const main = join(dataDir, "Projetos", "nuria-platform");
    const root = join(main, ".claude", "worktrees");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    mkdirSync(main, { recursive: true });
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, ".gitignore"), ".claude/\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "init");
    for (const folder of folders) git(main, "worktree", "add", "-q", "-b", folder, join(root, folder));
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
    // a live process working inside merge-deploy: in use, whatever the routine says (INSP-R12F F1)
    holder = spawn("sleep", ["120"], { cwd: join(root, "merge-deploy-open-prs-00664b"), stdio: "ignore" });
    const { bot } = await runControlOmb(["new-bot", "--name", "Chief of Staff", "--url", url]) as any;
    const { routine } = await api("POST", "/api/routines", {
      name: "Limpeza automática de disco (nuria-platform)", prompt: "Rotina de limpeza de disco.", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const runOnce = async () => {
      const { run } = await api("POST", `/api/routines/${routine.id}/run`);
      await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((each: any) => each.id === run.id)?.status, { timeout: 20_000 }).toBe("completed");
      return (await api("GET", "/api/routines")).runs.find((each: any) => each.id === run.id);
    };
    const first = await runOnce();
    // the card keeps 2 000 characters: the ask is past them
    expect(first.output.length).toBeLessThanOrEqual(2_000);
    expect(first.output).not.toContain("alguém pode remover");
    await expect.poll(() => (ledger().ownerPending ?? []).length, { timeout: 10_000 }).toBe(1);
    const [item] = ledger().ownerPending;
    expect(item).toMatchObject({
      botId: bot.id,
      threadId: first.resultsThreadId,
      key: "disk-decision:8204-reprovado-sidebar-da-fila-nao-refle-9b50cd,9052-tempo-de-reabertura-configuravel-35787b,atendimento-reaberto-bugs-496989",
      title: "Decidir o destino de 3 worktrees paradas (~5,5 GiB): 8204-reprovado-sidebar-da-fila-nao-refle-9b50cd, 9052-tempo-de-reabertura-configuravel-35787b, atendimento-reaberto-bugs-496989",
    });
    expect(item.why).toContain("o disco está com 9 GiB livres");
    expect(item.why).toContain("Não mexer (fora deste item): merge-deploy-open-prs-00664b (há um processo vivo dentro dela)");
    expect(item.steps).toHaveLength(4);
    expect(item.steps[0].text).toContain("reconfira que nenhuma tem sessão, processo vivo dentro ou mudança nas últimas 24 h");
    expect(item.steps[1].command).toContain(`git -C ${root}/8204-reprovado-sidebar-da-fila-nao-refle-9b50cd status --short`);
    // their commits are on no remote: nothing is proved clean, so nothing is offered for plain removal
    expect(item.options.map((option: any) => option.label)).toEqual(["Push e remover", "Manter por 7 dias"]);
    // the hour after, the same words: the same item, no second one
    await runOnce();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ledger().ownerPending.map((each: any) => each.id)).toEqual([item.id]);
    const chips = ((await api("GET", `/api/threads/${first.resultsThreadId}/messages?limit=100`)).messages as any[])
      .filter((message) => message.kind === "activity" && String(message.tool?.name ?? "").startsWith(`Em "Precisa de você" (${item.id})`));
    expect(chips).toHaveLength(1);
    // INSP-R12F r2 R2-1: a process starts working in 8204 while the item is open — the next run checks the open item again
    second = spawn("sleep", ["120"], { cwd: join(root, "8204-reprovado-sidebar-da-fila-nao-refle-9b50cd"), stdio: "ignore" });
    await runOnce();
    await expect.poll(() => ledger().ownerPending.map((each: any) => each.key), { timeout: 15_000 })
      .toEqual(["disk-decision:9052-tempo-de-reabertura-configuravel-35787b,atendimento-reaberto-bugs-496989"]);
    const [current] = ledger().ownerPending;
    expect(current.why).toContain("8204-reprovado-sidebar-da-fila-nao-refle-9b50cd (há um processo vivo dentro dela)");
    expect(JSON.stringify(current.options)).not.toContain("8204");
    expect(ledger().resolvedOwnerPending.find((each: any) => each.id === item.id)).toMatchObject({ resolvedBy: "server", resolvedNote: "atualizado: conferido de novo no Mac" });
    // and at the click: 9052 comes into use, the owner picks the removal — checked first, refused, the item updated
    third = spawn("sleep", ["120"], { cwd: join(root, "9052-tempo-de-reabertura-configuravel-35787b"), stdio: "ignore" });
    const response = await fetch(`${url}/api/bots/${bot.id}/owner-pending/${current.id}/reply`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ option: 0, label: current.options[0].label }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "disk_item_changed" });
    expect(ledger().ownerPending.map((each: any) => each.key)).toEqual(["disk-decision:atendimento-reaberto-bugs-496989"]);
    expect(ledger().ownerPending[0].history ?? []).toEqual([]);
    // INSP-R12F r3 R3-2: a free-text answer is checked too, and reaches the Chief with the state found now
    const last = ledger().ownerPending[0];
    const free = await fetch(`${url}/api/bots/${bot.id}/owner-pending/${last.id}/reply`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ text: "pode remover todas" }),
    });
    expect(free.status, await free.clone().text()).toBeLessThan(300);
    await expect.poll(async () => JSON.stringify((await api("GET", `/api/threads/${last.threadId}/messages?limit=100`)).messages), { timeout: 10_000 })
      .toContain("[Servidor: conferido no Mac em ");
    const said = ((await api("GET", `/api/threads/${last.threadId}/messages?limit=100`)).messages as any[]).find((message) => String(message.text ?? "").includes("pode remover todas"));
    expect(said.text).toContain("atendimento-reaberto-bugs-496989: ");
    expect(said.text).toContain("Reconfira no Mac antes de remover qualquer pasta");
    // INSP-R12F r5 #3: the app gave up and the owner sent it again — taken once
    const repeat = await fetch(`${url}/api/bots/${bot.id}/owner-pending/${last.id}/reply`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ text: "pode remover todas" }),
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ duplicate: true, message: expect.stringMatching(/^Essa mesma resposta já foi enviada há \d+ s; não mandei de novo\.$/) });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const sent = ((await api("GET", `/api/threads/${last.threadId}/messages?limit=100`)).messages as any[]).filter((message) => message.role === "user" && String(message.text ?? "").includes("pode remover todas"));
    expect(sent).toHaveLength(1);
    expect(ledger().ownerPending[0].history.filter((each: any) => each.text === "pode remover todas")).toHaveLength(1);
    // INSP-R12F r6 D1: the app aborts while the server still checks the Mac, then the owner sends again — still once
    const abort = new AbortController();
    const aborted = fetch(`${url}/api/bots/${bot.id}/owner-pending/${last.id}/reply`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ text: "pode remover sim" }), signal: abort.signal,
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort();
    await aborted;
    const resent = await fetch(`${url}/api/bots/${bot.id}/owner-pending/${last.id}/reply`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ text: "pode remover sim" }),
    });
    expect(resent.status).toBe(200);
    expect(await resent.json()).toMatchObject({ duplicate: true });
    await expect.poll(() => ledger().ownerPending[0].history.filter((each: any) => each.text === "pode remover sim").length, { timeout: 10_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(((await api("GET", `/api/threads/${last.threadId}/messages?limit=200`)).messages as any[]).filter((message) => message.role === "user" && String(message.text ?? "").includes("pode remover sim"))).toHaveLength(1);
    // and a free-text answer after a folder came into use: refused, the item updated
    fourth = spawn("sleep", ["120"], { cwd: join(root, "atendimento-reaberto-bugs-496989"), stdio: "ignore" });
    const late = await fetch(`${url}/api/bots/${bot.id}/owner-pending/${last.id}/reply`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ text: "pode remover" }),
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: "disk_item_changed" });
    expect(ledger().ownerPending ?? []).toEqual([]);
    // INSP-R12F r4: "Manter por 7 dias" removes nothing — not checked, never refused, even with the folder in use
    fourth.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await runOnce();
    await expect.poll(() => (ledger().ownerPending ?? []).map((each: any) => each.key), { timeout: 15_000 }).toEqual(["disk-decision:atendimento-reaberto-bugs-496989"]);
    const again = ledger().ownerPending[0];
    fourth = spawn("sleep", ["120"], { cwd: join(root, "atendimento-reaberto-bugs-496989"), stdio: "ignore" });
    const keep = again.options.findIndex((option: any) => option.label === "Manter por 7 dias");
    const kept = await fetch(`${url}/api/bots/${bot.id}/owner-pending/${again.id}/reply`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ option: keep, label: "Manter por 7 dias" }),
    });
    expect(kept.status, await kept.clone().text()).toBeLessThan(300);
    const settled = ledger().resolvedOwnerPending.find((each: any) => each.id === again.id);
    expect(settled.resolvedBy).toBe("owner");
    expect(settled.history.at(-1)).toMatchObject({ kind: "option", label: "Manter por 7 dias" });
  } finally {
    holder?.kill();
    second?.kill();
    third?.kill();
    fourth?.kill();
    await fixture.close();
  }
}, 90_000);
