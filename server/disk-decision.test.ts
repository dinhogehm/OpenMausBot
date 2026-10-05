import { describe, expect, it } from "vitest";
import {
  asksOwnerToDecide,
  DISK_DECISION_KEY_PREFIX,
  DISK_DECISION_SETTLED_MS,
  diskDecisionFolders,
  diskDecisionItem,
  diskDecisionPlan,
  diskRoutine,
  folderInUse,
  resolveFolder,
  totalSize,
  type FolderFacts,
} from "./disk-decision.ts";
import { parseOwnerPendingDetails } from "./bot-autonomy.ts";

const ROOT = "/Users/osvaldo/Projetos/nuria-platform/.claude/worktrees";
// ls ~/Projetos/nuria-platform/.claude/worktrees on 05/10
const FOLDERS = [
  "8204-reprovado-sidebar-da-fila-nao-refle-9b50cd",
  "agent-a492b70af0b5210db",
  "9052-tempo-de-reabertura-configuravel-35787b",
  "9378-supervisor-do-atendimento",
  "9334-9331-inatividade-do-chat-c38a86",
  "503-atendimento-helpdesk-2785c8",
  "9326-f4-2-gate-da-pr-9330-29da94",
  "hook-v2-4-corredores-de-operacao-61af7a",
  "merge-deploy-open-prs-00664b",
  "atendimento-reaberto-bugs-496989",
  "chat-wait-time-issue-21f481",
];
const NAME = "Limpeza automática de disco (nuria-platform)";
/** As checked on the Mac: nobody in them, commits on no remote branch. */
const idle = (folders: ReadonlyArray<string | { name: string }>) => new Map<string, FolderFacts>(folders.map((each) => [typeof each === "string" ? each : each.name, { inUse: null, dirty: false, unpushed: true }]));

// The routine's run of 05/10 11:38 in the owner's channel (the "5,5 GiB" one)
const RUN_1138 = `**Alerta de disco:** só restam **9 GiB livres**, abaixo do limite de 10 GiB. Nesta rodada não apaguei nada, então o espaço ficou igual antes e depois.

- **Worktrees:** nenhuma pode ser removida pela regra. As três que não têm alterações guardam commits que não estão no GitHub, e todas as outras têm alterações não salvas.

Worktrees que ficaram:

| Worktree | Tamanho | Motivo |
|---|---|---|
| 8204-reprovado-sidebar-da-fila-nao-refle-9b50cd | 3,0G | commits só locais |
| agent-a492b70af0b5210db | 2,5G | alterações não salvas |
| 9052-tempo-de-reabertura-configuravel-35787b | 2,2G | commits só locais |
| 9334-9331-inatividade-do-chat-c38a86 | 901M | alterações não salvas, commits só locais; sessão ativa |
| 503-atendimento-helpdesk-2785c8 | 848M | alterações não salvas, commits só locais |
| 9326-f4-2-gate-da-pr-9330-29da94 | 848M | alterações não salvas |
| hook-v2-4-corredores-de-operacao-61af7a | 848M | alterações não salvas; sessão ativa |
| merge-deploy-open-prs-00664b | 592M | alterações não salvas, commits só locais |
| atendimento-reaberto-bugs-496989 | 263M | commits só locais |
| chat-wait-time-issue-21f481 | 8K | alterações não salvas |

**Onde dá para liberar mais espaço:** as três worktrees com commits só locais e sem alterações (8204, 9052 e atendimento-reaberto) somam cerca de 5,5 GiB. Se esse trabalho já entrou na main por squash, alguém pode remover essas pastas manualmente; a rotina não pode removê-las.`;

// 13:38: the same folders, a subset offered
const RUN_1338 = `Osvaldo, a limpeza rodou mas não apagou nada, e o disco está com **8 GiB livres**, abaixo do limite de 10 GiB.

| Worktree | Tamanho | Por que ficou |
|---|---|---|
| 8204-reprovado-sidebar-da-fila-nao-refle-9b50cd | 3,0G | commits só locais |
| 9052-tempo-de-reabertura-configuravel-35787b | 2,2G | commits só locais |
| 9378-supervisor-do-atendimento | 2,2G | alterada há menos de 24 h |
| atendimento-reaberto-bugs-496989 | 263M | commits só locais |

As que mais liberariam espaço são a 8204 e a 9052. É provável que o trabalho delas já esteja na main depois de um squash-merge; a 9052, por exemplo, teve a PR #9332. Posso conferir isso PR por PR e remover as que já estiverem na main.`;

// 12:38: the inline form, and no ask ("não avisei ninguém")
const RUN_1238 = `Rodei a limpeza, mas não apaguei nada: o disco continua com **12 GiB livres**. Isso está abaixo da meta de 25 GiB e acima do limite de alerta de 10 GiB, então não avisei ninguém e só registrei no log de hoje.

  | Situação | Worktrees (tamanho) |
  |---|---|
  | Limpas, mas com commits só locais | 8204-9b50cd (3,0G), 9052-35787b (2,2G), 9334-c38a86 (908M), atendimento-reaberto-496989 (263M) |
  | Com alterações locais | agent-a492b70 (2,5G), 503-2785c8 (848M), merge-deploy-00664b (592M) |`;

describe("a disk routine that leaves folders to the owner (R12-followup #5)", () => {
  it("knows a disk routine and when its run asks the owner", () => {
    expect(diskRoutine(NAME, RUN_1238)).toBe(true);
    expect(diskRoutine("Atendimento: Chat, planilha e issues", "Nenhum cliente escreveu nada novo.")).toBe(false);
    expect(asksOwnerToDecide(RUN_1138)).toBe(true);
    expect(asksOwnerToDecide(RUN_1338)).toBe(true);
    expect(asksOwnerToDecide("Osvaldo, das três worktrees… removi duas e deixei uma para você decidir.")).toBe(true);
    expect(asksOwnerToDecide(RUN_1238)).toBe(false);
  });

  it("resolves the routine's names, long and short, to the real folders — never a bare word", () => {
    expect(resolveFolder("8204", FOLDERS)).toBe("8204-reprovado-sidebar-da-fila-nao-refle-9b50cd");
    expect(resolveFolder("8204-9b50cd", FOLDERS)).toBe("8204-reprovado-sidebar-da-fila-nao-refle-9b50cd");
    expect(resolveFolder("atendimento-reaberto", FOLDERS)).toBe("atendimento-reaberto-bugs-496989");
    expect(resolveFolder("`merge-deploy-open-prs-00664b`", FOLDERS)).toBe("merge-deploy-open-prs-00664b");
    expect(resolveFolder("agent-a492b70", FOLDERS)).toBe("agent-a492b70af0b5210db");
    expect(resolveFolder("merge", FOLDERS)).toBeNull();
    expect(resolveFolder("main", FOLDERS)).toBeNull();
    expect(resolveFolder("93", FOLDERS)).toBeNull(); // 9378, 9334, 9326: not one
  });

  it("11:38 becomes one item: the three folders it named (~5,5 GiB), with why, steps and decisions", () => {
    const folders = diskDecisionFolders(RUN_1138, FOLDERS);
    expect(folders).toEqual([
      { name: "8204-reprovado-sidebar-da-fila-nao-refle-9b50cd", size: "3,0G", reason: "commits só locais" },
      { name: "9052-tempo-de-reabertura-configuravel-35787b", size: "2,2G", reason: "commits só locais" },
      { name: "atendimento-reaberto-bugs-496989", size: "263M", reason: "commits só locais" },
    ]);
    expect(totalSize(folders)).toBe("~5,5 GiB");
    const item = diskDecisionItem(folders, idle(folders), ROOT, RUN_1138)!;
    expect(item.key).toBe(`${DISK_DECISION_KEY_PREFIX}8204-reprovado-sidebar-da-fila-nao-refle-9b50cd,9052-tempo-de-reabertura-configuravel-35787b,atendimento-reaberto-bugs-496989`);
    expect(item.title).toBe("Decidir o destino de 3 worktrees paradas (~5,5 GiB): 8204-reprovado-sidebar-da-fila-nao-refle-9b50cd, 9052-tempo-de-reabertura-configuravel-35787b, atendimento-reaberto-bugs-496989");
    expect(item.why).toContain("o disco está com 9 GiB livres e o release exige 8");
    expect(item.why).toContain("3 têm trabalho que só existe neste Mac");
    // first, check again on the Mac; then look at each one
    expect(item.steps[0]!.text).toContain("reconfira que nenhuma tem sessão, processo vivo dentro ou mudança nas últimas 24 h");
    expect(item.steps[1]!.text).toBe("Veja 8204-reprovado-sidebar-da-fila-nao-refle-9b50cd (3,0G; commits em nenhuma branch remota)");
    // work only on this Mac: "Push e remover", never a removal — and never --force
    expect(item.options.map((option) => option.label)).toEqual(["Push e remover", "Manter"]);
    expect(item.options.map((option) => option.reply).join(" ")).not.toContain("--force)");
    expect(item.options[0]!.reply).toContain("Se houver alterações não commitadas, pare e me mostre; não descarte nada");
    // it passes the same rules a bot's item does, nothing cut
    expect(parseOwnerPendingDetails({ why: item.why, steps: item.steps, options: item.options })).toMatchObject({ ok: true });
    for (const option of item.options) expect(option.reply.length).toBeLessThanOrEqual(500);
  });

  // INSP-R12F F1: "a 9374 está com sessão ativa" put the session's worktree in "Remover todas (--force)"
  it("never offers a folder in use, and offers removal only for a folder proved clean and pushed", () => {
    const folders9374 = [...FOLDERS, "9374-pausa-inatividade-no-clique-c38a86"];
    const said = `${RUN_1138.replace(/\*\*Onde dá[\s\S]*$/, "")}\n\n8204 tem commits só locais, e a 9374 está com sessão ativa; alguém pode remover essas pastas manualmente.`;
    // named only in the sentence, not in the run's table: never taken
    expect(diskDecisionFolders(said, folders9374).map((each) => each.name)).toEqual(["8204-reprovado-sidebar-da-fila-nao-refle-9b50cd"]);
    // in use on the Mac (a session, a process, a change today): out of the item, said as "não mexer"
    const folders = diskDecisionFolders(RUN_1138, FOLDERS);
    const facts = idle(folders);
    facts.set("9052-tempo-de-reabertura-configuravel-35787b", { inUse: "sessão «9052 Tempo de reabertura» nela", dirty: false, unpushed: true });
    facts.set("atendimento-reaberto-bugs-496989", { inUse: null, dirty: false, unpushed: false });
    const item = diskDecisionItem(folders, facts, ROOT, RUN_1138)!;
    expect(item.key).toBe(`${DISK_DECISION_KEY_PREFIX}8204-reprovado-sidebar-da-fila-nao-refle-9b50cd,atendimento-reaberto-bugs-496989`);
    expect(item.why).toContain("Não mexer (fora deste item): 9052-tempo-de-reabertura-configuravel-35787b (sessão «9052 Tempo de reabertura» nela)");
    const remove = item.options.find((option) => option.label === "Remover as limpas")!;
    expect(remove.reply).toContain("Remova as worktrees atendimento-reaberto-bugs-496989 com git worktree remove, sem --force.");
    expect(remove.reply).not.toContain("8204");
    expect(item.options.find((option) => option.label === "Push e remover")!.reply).toContain("8204-reprovado-sidebar-da-fila-nao-refle-9b50cd");
    // git could not tell: not clean
    facts.set("atendimento-reaberto-bugs-496989", { inUse: null, dirty: null, unpushed: false });
    expect(diskDecisionItem(folders, facts, ROOT, RUN_1138)!.options.map((option) => option.label)).toEqual(["Push e remover", "Manter"]);
    // a folder not checked counts as in use; all in use: no item
    expect(diskDecisionItem(folders, new Map(), ROOT, RUN_1138)).toBeNull();
  });

  it("knows a folder in use: a session, a conversation, a live process inside, a change in the last day, or unknown", () => {
    const path = `${ROOT}/8204-reprovado-sidebar-da-fila-nao-refle-9b50cd`;
    const now = Date.parse("2026-10-05T16:38:37Z");
    const base = { used: [], processCwds: [], activity: now - 3 * 86_400_000, now, root: ROOT, home: "/Users/osvaldo" };
    expect(folderInUse(path, base)).toBeNull();
    expect(folderInUse(path, { ...base, sessionOf: () => "8204 Sidebar da fila" })).toBe("sessão «8204 Sidebar da fila» nela");
    expect(folderInUse(path, { ...base, used: [`${path}/apps/web`] })).toBe("uma conversa ou sessão trabalha nela");
    expect(folderInUse(path, { ...base, processCwds: [`${path}/apps/web`] })).toBe("há um processo vivo dentro dela");
    expect(folderInUse(path, { ...base, processCwds: null })).toBe("não consegui ler os processos vivos");
    expect(folderInUse(path, { ...base, activity: now - 3_600_000 })).toBe("mudou nas últimas 24 h");
    expect(folderInUse(path, { ...base, activity: null })).toBe("não consegui medir a última mudança");
    // an app session in "/" or the home, or a process in the worktrees' root, holds none of them
    expect(folderInUse(path, { ...base, used: ["/", "/Users/osvaldo", ROOT], processCwds: ["/", ROOT] })).toBeNull();
  });

  it("with no folder named, every folder left to the owner — never one with a session on it or touched today", () => {
    const folders = diskDecisionFolders(RUN_1138.replace(/\*\*Onde dá[\s\S]*$/, "Precisa de você para decidir o destino delas."), FOLDERS).map((each) => each.name);
    expect(folders).toContain("merge-deploy-open-prs-00664b");
    expect(folders).not.toContain("9334-9331-inatividade-do-chat-c38a86");
    expect(folders).not.toContain("hook-v2-4-corredores-de-operacao-61af7a");
    const short = diskDecisionFolders(`${RUN_1238}\n\nPrecisa de você para decidir.`, FOLDERS).map((each) => each.name);
    expect(short).toContain("8204-reprovado-sidebar-da-fila-nao-refle-9b50cd");
    expect(short).toContain("agent-a492b70af0b5210db");
  });

  it("one item per list: 13:38's subset is already asked, the same list is refreshed, a settled one is not reopened for a week", () => {
    const now = Date.parse("2026-10-05T16:38:37Z");
    const first = diskDecisionItem(diskDecisionFolders(RUN_1138, FOLDERS), idle(FOLDERS), ROOT, RUN_1138)!;
    expect(diskDecisionPlan(first.key, [], [], now)).toEqual({ add: true, replace: [] });
    // the hourly run says it again: refreshed in place
    expect(diskDecisionPlan(first.key, [{ key: first.key }], [], now)).toEqual({ add: true, replace: [] });
    // 13:38 names 8204 and 9052, both in the open item: nothing new
    const subset = diskDecisionItem(diskDecisionFolders(RUN_1338, FOLDERS), idle(FOLDERS), ROOT, RUN_1338)!;
    expect(subset.key).toBe(`${DISK_DECISION_KEY_PREFIX}8204-reprovado-sidebar-da-fila-nao-refle-9b50cd,9052-tempo-de-reabertura-configuravel-35787b`);
    expect(diskDecisionPlan(subset.key, [{ key: first.key }, { key: "release-loop:abc" }], [], now)).toEqual({ add: false, replace: [] });
    // a list with a folder more replaces the open one
    const bigger = `${DISK_DECISION_KEY_PREFIX}8204-reprovado-sidebar-da-fila-nao-refle-9b50cd,9052-tempo-de-reabertura-configuravel-35787b,atendimento-reaberto-bugs-496989,merge-deploy-open-prs-00664b`;
    expect(diskDecisionPlan(bigger, [{ key: first.key }], [], now)).toEqual({ add: true, replace: [first.key] });
    // the owner chose "Manter" an hour ago: not asked again, nor for a part of it
    const owner = { key: first.key, resolvedAt: now - 3_600_000, resolvedBy: "owner" };
    expect(diskDecisionPlan(first.key, [], [owner], now)).toEqual({ add: false, replace: [] });
    expect(diskDecisionPlan(subset.key, [], [owner], now).add).toBe(false);
    // the bot closed it after the owner answered: the owner's decision too
    expect(diskDecisionPlan(first.key, [], [{ ...owner, resolvedBy: "bot", history: [{ kind: "option", label: "Manter" }] }], now).add).toBe(false);
    expect(diskDecisionPlan(first.key, [], [{ ...owner, resolvedAt: now - DISK_DECISION_SETTLED_MS - 1 }], now).add).toBe(true);
  });

  // INSP-R12F F2: {A,B,C} at 11:38, {D} at 12:38 (the server replaced the first), {A,B} at 13:38
  it("an item the server replaced was decided by nobody: the list comes back at once", () => {
    const now = Date.parse("2026-10-05T16:38:37Z");
    const key = (...names: string[]) => `${DISK_DECISION_KEY_PREFIX}${names.join(",")}`;
    const abc = key("A", "B", "C");
    // 12:38: {D} replaces the open {A,B,C}, which the server settles
    expect(diskDecisionPlan(key("D"), [{ key: abc }], [], now - 3_600_000)).toEqual({ add: true, replace: [abc] });
    const replaced = { key: abc, resolvedAt: now - 3_600_000, resolvedBy: "server" };
    // 13:38: {A,B} is asked again, and replaces {D}
    expect(diskDecisionPlan(key("A", "B"), [{ key: key("D") }], [replaced], now)).toEqual({ add: true, replace: [key("D")] });
    // a bot closing it without the owner's answer is not the owner's decision either
    expect(diskDecisionPlan(key("A", "B"), [], [{ ...replaced, resolvedBy: "bot" }], now).add).toBe(true);
  });
});
