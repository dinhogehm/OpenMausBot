import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
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
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify([reply, reply, reply]) });
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response.json() as Promise<any>;
  };
  let holder: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  let third: ChildProcess | undefined;
  const ledger = () => (existsSync(join(dataDir, "bot-autonomy.json")) ? JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")) : {});
  try {
    // the worktrees, where the server looks for them (the fixture's home is its data dir)
    const root = join(dataDir, "Projetos", "nuria-platform", ".claude", "worktrees");
    const threeDaysAgo = (Date.now() - 3 * 86_400_000) / 1000;
    for (const folder of folders) {
      mkdirSync(join(root, folder), { recursive: true });
      utimesSync(join(root, folder), threeDaysAgo, threeDaysAgo);
    }
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
    // not git repositories here: nothing is proved clean, so nothing is offered for removal
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
  } finally {
    holder?.kill();
    second?.kill();
    third?.kill();
    await fixture.close();
  }
}, 90_000);
