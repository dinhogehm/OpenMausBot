import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nestedWorktrees, parseWorktreeList } from "./nested-worktrees.ts";
import {
  asksOwnerToDecide,
  diskStateLine,
  filesBelow,
  keepsFolders,
  DISK_DECISION_KEY_PREFIX,
  DISK_DECISION_SETTLED_MS,
  diskDecisionFolders,
  diskDecisionItem,
  diskDecisionPlan,
  diskRoutine,
  folderInUse,
  busyNote,
  diskDecisionRecheck,
  keyFolders,
  openItemFolders,
  porcelainState,
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
    expect(item.options.map((option) => option.label)).toEqual(["Push e remover", "Manter por 7 dias"]);
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
    expect(item.key).toBe(`${DISK_DECISION_KEY_PREFIX}8204-reprovado-sidebar-da-fila-nao-refle-9b50cd,atendimento-reaberto-bugs-496989|limpas:atendimento-reaberto-bugs-496989`);
    expect(item.why).toContain("Não mexer (fora deste item): 9052-tempo-de-reabertura-configuravel-35787b (sessão «9052 Tempo de reabertura» nela)");
    const remove = item.options.find((option) => option.label === "Remover as limpas")!;
    expect(remove.reply).toContain("Remova as worktrees atendimento-reaberto-bugs-496989 com git worktree remove, sem --force.");
    expect(remove.reply).not.toContain("8204");
    expect(item.options.find((option) => option.label === "Push e remover")!.reply).toContain("8204-reprovado-sidebar-da-fila-nao-refle-9b50cd");
    // git could not tell: not clean
    facts.set("atendimento-reaberto-bugs-496989", { inUse: null, dirty: null, unpushed: false });
    expect(diskDecisionItem(folders, facts, ROOT, RUN_1138)!.options.map((option) => option.label)).toEqual(["Push e remover", "Manter por 7 dias"]);
    // a folder not checked counts as in use; all in use: no item
    expect(diskDecisionItem(folders, new Map(), ROOT, RUN_1138)).toBeNull();
  });

  // INSP-R12F F7, F8: "Manter" promised "never again" while the server asks again after 7 days; paths unquoted
  it("says how long 'Manter' holds, as the server keeps it, and quotes every path in its commands", () => {
    const folders = [{ name: "8204 com espaço's", size: "3,0G", reason: "commits só locais" }];
    const item = diskDecisionItem(folders, idle(folders), "/Users/osvaldo/Projetos/nuria-platform/.claude/worktrees", RUN_1138)!;
    const keep = item.options.find((option) => option.label === "Manter por 7 dias")!;
    expect(DISK_DECISION_SETTLED_MS).toBe(7 * 86_400_000);
    expect(keep.reply).toContain("só voltam a ser perguntadas daqui a 7 dias");
    expect(keep.reply).not.toContain("nem volte a me perguntar");
    expect(item.steps[1]!.command).toBe(`git -C '/Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/8204 com espaço'\\''s' status --short && git -C '/Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/8204 com espaço'\\''s' log --oneline origin/main..HEAD`);
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

  // INSP-R12F r2 R2-1: the open {A,B} still offered "Remover as limpas: A B" after B came into use
  it("an open item checked again: {A,B} with B now in use becomes {A}; none left closes it; nothing changed keeps it", () => {
    const A = "8204-reprovado-sidebar-da-fila-nao-refle-9b50cd";
    const B = "atendimento-reaberto-bugs-496989";
    const folders = [{ name: A, size: "3,0G", reason: "commits só locais" }, { name: B, size: "263M", reason: "commits só locais" }];
    const clean = new Map<string, FolderFacts>([[A, { inUse: null, dirty: false, unpushed: false }], [B, { inUse: null, dirty: false, unpushed: false }]]);
    const open = diskDecisionItem(folders, clean, ROOT, RUN_1138)!;
    expect(open.options[0]).toMatchObject({ label: "Remover as limpas" });
    expect(open.options[0]!.reply).toContain(`Remova as worktrees ${A} ${B} com git worktree remove`);
    // read back from the open item: its folders and the sizes its steps said
    const back = openItemFolders(open);
    expect(back.map((each) => [each.name, each.size])).toEqual([[A, "3,0G"], [B, "263M"]]);
    // nothing changed: kept
    expect(diskDecisionRecheck(open.key, diskDecisionItem(back, clean, ROOT, ""), "")).toEqual({ action: "keep" });
    // B came into use: the item is A alone, and B is "não mexer"
    const used = new Map(clean).set(B, { inUse: "sessão «9378 Supervisor» nela", dirty: false, unpushed: false });
    const after = diskDecisionRecheck(open.key, diskDecisionItem(back, used, ROOT, ""), busyNote([A, B], used));
    expect(after.action).toBe("replace");
    const item = (after as { item: NonNullable<ReturnType<typeof diskDecisionItem>> }).item;
    expect(keyFolders(item.key)).toEqual([A]);
    expect(item.options[0]!.reply).toContain(`Remova as worktrees ${A} com git worktree remove`);
    expect(item.options.map((option) => option.reply).join(" ")).not.toContain(`${B} com`);
    expect(item.why).toContain(`Não mexer (fora deste item): ${B} (sessão «9378 Supervisor» nela)`);
    // B no longer clean (an ignored .dev.vars appeared): same folders, other offers → another key
    const notClean = new Map(clean).set(B, { inUse: null, dirty: false, unpushed: false, ignored: [".dev.vars"] });
    expect(diskDecisionRecheck(open.key, diskDecisionItem(back, notClean, ROOT, ""), "").action).toBe("replace");
    expect(diskDecisionPlan(diskDecisionItem(back, notClean, ROOT, "")!.key, [{ key: open.key }], [], Date.now())).toEqual({ add: true, replace: [open.key] });
    // both in use: closed, with why
    const both = new Map(used).set(A, { inUse: "há um processo vivo dentro dela", dirty: false, unpushed: false });
    expect(diskDecisionRecheck(open.key, diskDecisionItem(back, both, ROOT, ""), busyNote([A, B], both))).toEqual({
      action: "close",
      note: `nenhuma pasta sobrou para decidir: ${A} (há um processo vivo dentro dela); ${B} (sessão «9378 Supervisor» nela)`,
    });
  });

  // INSP-R12F r2 R2-2: "clean" ignored the ignored files; a .dev.vars lives only on this Mac
  it("an ignored file that matters keeps a folder from being clean, past build junk", () => {
    const state = porcelainState("!! node_modules/\n!! apps/web/.next/\n!! .turbo/\n!! dist/\n!! debug.log\n!! notes/rascunho.md\n!! apps/api/.local-ops/\n");
    expect(state).toEqual({ dirty: false, ignored: ["notes/rascunho.md", "apps/api/.local-ops/"], secrets: [] });
    expect(porcelainState("!! node_modules/\n!! coverage/\n")).toEqual({ dirty: false, ignored: [], secrets: [] });
    expect(porcelainState(" M src/a.ts\n!! node_modules/\n").dirty).toBe(true);
    const folders = [{ name: "atendimento-reaberto-bugs-496989", size: "263M", reason: "commits só locais" }];
    const facts = new Map<string, FolderFacts>([["atendimento-reaberto-bugs-496989", { inUse: null, dirty: false, unpushed: false, ignored: state.ignored }]]);
    const item = diskDecisionItem(folders, facts, ROOT, "")!;
    expect(item.options.map((option) => option.label)).toEqual(["Push e remover", "Manter por 7 dias"]);
    expect(item.steps[1]!.text).toContain("arquivos ignorados que só existem aqui: notes/rascunho.md, apps/api/.local-ops/");
    // and the removal names them
    expect(item.options[0]!.reply).toContain("Também só existem nela e somem com a remoção: atendimento-reaberto-bugs-496989/notes/rascunho.md");
    // R2-3: one folder "tem", several "têm"
    expect(item.why).toContain(" 1 tem trabalho que só existe neste Mac.");
    expect(diskDecisionItem(diskDecisionFolders(RUN_1138, FOLDERS), idle(FOLDERS), ROOT, RUN_1138)!.why).toContain(" 3 têm trabalho que só existe neste Mac.");
  });

  // INSP-R12F r3 R3-1: with the old list the real 8204 and atendimento-reaberto had 11 and 7 "ignored that matter", all generated
  // r3 R3-1, corrected by r4: the generated nuria files are junk; .worktrees/ and .claude/ never are
  it("the real ignored lists of 8204 and atendimento-reaberto: generated files are junk, .worktrees/ and .claude/ are not", () => {
    const real = (name: string) => readFileSync(new URL(`./testing/disk-decision/st-${name}.txt`, import.meta.url), "utf8");
    const s8204 = real("8204-reprovado-sidebar-da-fila-nao-refle-9b50cd");
    expect(s8204.split("\n").filter((line) => line.startsWith("!! ")).length).toBeGreaterThan(130);
    // .deploy-*, graft/, .husky/_/, .ignore, .local-ci/, node_modules, .turbo, dist, .lighthouse: junk; the nested worktrees' folder: not
    expect(porcelainState(s8204)).toEqual({ dirty: false, ignored: [".worktrees/"], secrets: [] });
    // atendimento-reaberto's .claude/, walked: its settings.local.json is a secret, the rest only lives here
    const claude = ["CLAUDE.md", "settings.local.json", "plan.md", "hooks/synapse-engine.cjs", ".DS_Store"];
    expect(porcelainState(real("atendimento-reaberto-bugs-496989"), (dir) => (dir === ".claude" ? claude : null))).toEqual({
      dirty: false, ignored: [".claude/CLAUDE.md", ".claude/plan.md", ".claude/hooks/synapse-engine.cjs"], secrets: [".claude/settings.local.json"],
    });
    // unreadable: the folder itself, never dropped
    expect(porcelainState(real("atendimento-reaberto-bugs-496989")).ignored).toEqual([".claude/"]);
  });

  // INSP-R12F r4 R4-1: a nested worktree hidden in .worktrees/ was deleted with its parent, uncommitted work and all
  it("a folder holding another worktree is in use, never offered — proved with a real repository", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omb-nested-"));
    try {
      const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();
      const main = join(tmp, "main");
      mkdirSync(main);
      git(main, "init", "-q", "-b", "main");
      writeFileSync(join(main, ".gitignore"), ".worktrees/\n");
      git(main, "add", ".");
      git(main, "commit", "-q", "-m", "init");
      const parent = join(main, ".claude", "worktrees", "p");
      git(main, "worktree", "add", "-q", "-b", "p", parent);
      const nested = join(parent, ".worktrees", "n");
      git(parent, "worktree", "add", "-q", "-b", "n", nested);
      writeFileSync(join(nested, "trabalho.txt"), "não commitado\n");
      // what the parent's own status shows: only the folded folder
      const status = git(parent, "status", "--porcelain", "--ignored");
      expect(status.trim()).toBe("!! .worktrees/");
      const state = porcelainState(status);
      expect(state.ignored).toEqual([".worktrees/"]);
      // the repository's worktrees name the nested one: the parent is in use
      const canon = realpathSync(parent);
      const inside = nestedWorktrees(parseWorktreeList(git(parent, "worktree", "list", "--porcelain")).map((entry) => ({ ...entry, path: realpathSync(entry.path) })), canon).map((entry) => entry.path);
      const base = { used: [], processCwds: [], activity: 0, now: 3 * 86_400_000, root: realpathSync(join(main, ".claude", "worktrees")), home: "/nowhere" };
      const why = folderInUse(canon, { ...base, nested: inside });
      expect(why).toBe("contém a worktree aninhada .worktrees/n");
      // unreadable worktree list: in use as well
      expect(folderInUse(canon, { ...base, nested: null })).toBe("não consegui ler as worktrees do repositório");
      // a stray folder, not a worktree (chat-wait-time-issue-21f481 on 05/10): git answered for the main checkout
      expect(folderInUse(canon, { ...base, nested: [], registered: false })).toBe("não é uma worktree do repositório");
      expect(folderInUse(canon, { ...base, nested: [], registered: true })).toBeNull();
      const item = diskDecisionItem([{ name: "p", size: "1M", reason: "commits só locais" }], new Map([["p", { inUse: why, dirty: false, unpushed: true, ignored: state.ignored }]]), join(main, ".claude", "worktrees"), "");
      expect(item).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    // the real 8204: its .worktrees/release-sqlite-warning (git worktree list --porcelain, 05/10)
    const root = "/Users/osvaldo/Projetos/nuria-platform/.claude/worktrees";
    const list = `worktree /Users/osvaldo/Projetos/nuria-platform\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${root}/8204-reprovado-sidebar-da-fila-nao-refle-9b50cd\nHEAD 61377d01b96499696662caba36e5db86fef354c6\nbranch refs/heads/worktree-8204-reprovado-sidebar-da-fila-nao-refle-9b50cd\n\nworktree ${root}/8204-reprovado-sidebar-da-fila-nao-refle-9b50cd/.worktrees/release-sqlite-warning\nHEAD ac06977627d4e5a3e1ce3a6c36102827d8ed2c96\nbranch refs/heads/fix/release-reconciler-sqlite-warning\n\nworktree ${root}/9052-tempo-de-reabertura-configuravel-35787b\nHEAD bbb\nbranch refs/heads/x\n`;
    const p8204 = `${root}/8204-reprovado-sidebar-da-fila-nao-refle-9b50cd`;
    const nested8204 = nestedWorktrees(parseWorktreeList(list), p8204).map((entry) => entry.path);
    expect(folderInUse(p8204, { used: [], processCwds: [], activity: 0, now: 3 * 86_400_000, root, home: "/Users/osvaldo", nested: nested8204 })).toBe("contém a worktree aninhada .worktrees/release-sqlite-warning");
    expect(nestedWorktrees(parseWorktreeList(list), `${root}/9052-tempo-de-reabertura-configuravel-35787b`)).toEqual([]);
  });

  // INSP-R12F r4 R4-2: .claude/ differs per worktree (merge-deploy's settings.local.json; 503's settings.json, helpers/)
  it("merge-deploy's and 503's .claude/: settings.local.json is a secret, the rest only lives there", () => {
    const status = "!! .claude/.DS_Store\n!! .claude/CLAUDE.md\n!! .claude/commands/\n!! .claude/helpers/\n!! .claude/hooks/\n!! .claude/launch.json\n!! .claude/plan.md\n!! .claude/rules/\n!! .claude/settings.local.json\n!! .claude/settings.local.json.bak-20260910-143136\n!! .claude/skills/\n";
    const inside: Record<string, string[]> = { ".claude/hooks": ["synapse-engine.cjs", "README.md"], ".claude/helpers": ["graft.cjs"], ".claude/skills": ["graft/SKILL.md"], ".claude/rules": ["mcp-usage.md"], ".claude/commands": ["greet.md", ".DS_Store"] };
    const state = porcelainState(status, (dir) => inside[dir] ?? null);
    expect(state.secrets).toEqual([".claude/settings.local.json", ".claude/settings.local.json.bak-20260910-143136"]);
    expect(state.ignored).toEqual([
      ".claude/CLAUDE.md", ".claude/commands/greet.md", ".claude/helpers/graft.cjs", ".claude/hooks/synapse-engine.cjs", ".claude/hooks/README.md",
      ".claude/launch.json", ".claude/plan.md", ".claude/rules/mcp-usage.md", ".claude/skills/graft/SKILL.md",
    ]);
    // a folder with them is never clean, and every removal says to copy the secret first
    const item = diskDecisionItem([{ name: "merge-deploy-open-prs-00664b", size: "592M", reason: "alterações" }], new Map([["merge-deploy-open-prs-00664b", { inUse: null, unpushed: false, ...state }]]), ROOT, "")!;
    expect(item.options.map((option) => option.label)).toEqual(["Push e remover", "Manter por 7 dias"]);
    expect(item.options[0]!.reply).toContain("merge-deploy-open-prs-00664b/.claude/settings.local.json");
    // walking a folder: a folder of worktrees is named, never walked
    const tree: Record<string, Array<{ name: string; dir: boolean }>> = { "/w/.claude": [{ name: "worktrees", dir: true }, { name: "a.md", dir: false }, { name: "hooks", dir: true }], "/w/.claude/hooks": [{ name: "x.cjs", dir: false }] };
    expect(filesBelow("/w/.claude", (dir) => { if (!tree[dir]) throw new Error("no"); return tree[dir]!; })).toEqual(["a.md", "worktrees/", "hooks/x.cjs"]);
    expect(filesBelow("/w/nada", () => { throw new Error("no"); })).toBeNull();
    // atendimento-reaberto's real case: settings.local.json behind 40+ command files is still found, the rest counted
    const many = [...Array.from({ length: 50 }, (_, index) => `commands/AIOX/agents/a${index}.md`), "settings.local.json"];
    const big = porcelainState("!! .claude/\n", () => many);
    expect(big.secrets).toEqual([".claude/settings.local.json"]);
    expect(big.ignored).toHaveLength(41);
    expect(big.ignored.at(-1)).toBe(".claude/… (+10)");
    // a folder of worktrees folded by git is named, never walked
    expect(porcelainState("!! .worktrees/\n", () => ["n/trabalho.txt"]).ignored).toEqual([".worktrees/"]);
  });

  // INSP-R12F r4 R4-3, R4-4
  it("more secrets by name or folder, and .audit-out/, .wrangler/, out/ are not junk", () => {
    const state = porcelainState(["secrets/", ".secrets/", "config/secrets.json", "token.json", "apps/x/token-prod.json", "AuthKey_ABC.p8", ".aws/", ".envrc", ".gcloud/", "infra/prod.tfvars", ".audit-out/", ".wrangler/", "out/", "target/"].map((path) => `!! ${path}`).join("\n"));
    expect(state.secrets).toEqual(["secrets/", ".secrets/", "config/secrets.json", "token.json", "apps/x/token-prod.json", "AuthKey_ABC.p8", ".aws/", ".envrc", ".gcloud/", "infra/prod.tfvars"]);
    expect(state.ignored).toEqual([".audit-out/", ".wrangler/", "out/", "target/"]);
    // inside a folded secrets folder, walked: still secrets
    expect(porcelainState("!! secrets/\n", () => ["db.txt"]).secrets).toEqual(["secrets/"]);
  });

  // INSP-R12F r4: "Manter" removes nothing — not checked on the Mac, never refused
  it("only an answer that may remove is checked: 'Manter por 7 dias' is not", () => {
    expect(keepsFolders({ kind: "option", label: "Manter por 7 dias" })).toBe(true);
    expect(keepsFolders({ kind: "option", label: "Push e remover" })).toBe(false);
    expect(keepsFolders({ kind: "option", label: "Remover as limpas" })).toBe(false);
    expect(keepsFolders({ kind: "text", label: "Manter por 7 dias" })).toBe(false);
    const item = diskDecisionItem([{ name: "x-1", size: "1M", reason: "r" }], new Map([["x-1", { inUse: null, dirty: false, unpushed: true }]]), ROOT, "")!;
    expect(item.options.at(-1)!.label).toBe("Manter por 7 dias");
  });

  it("a secret is never junk, and every option that removes its folder names it and asks to copy it first", () => {
    const state = porcelainState("!! node_modules/\n!! .dev.vars\n!! apps/api/.dev.vars.production\n!! web/.env.local\n!! .env.example\n!! certs/server.pem\n!! apps/migrator/credentials/\n!! graft/\n!! .deploy-history/\n");
    expect(state).toEqual({ dirty: false, ignored: [".env.example"], secrets: [".dev.vars", "apps/api/.dev.vars.production", "web/.env.local", "certs/server.pem", "apps/migrator/credentials/"] });
    // a secret inside what would be junk is still a secret
    expect(porcelainState("!! graft/.env\n").secrets).toEqual(["graft/.env"]);
    const A = "8204-reprovado-sidebar-da-fila-nao-refle-9b50cd";
    const B = "atendimento-reaberto-bugs-496989";
    const folders = [{ name: A, size: "3,0G", reason: "commits só locais" }, { name: B, size: "263M", reason: "commits só locais" }];
    // A pushed and clean but with a .dev.vars; B with commits on no remote and a .env
    const facts = new Map<string, FolderFacts>([
      [A, { inUse: null, dirty: false, unpushed: false, secrets: [".dev.vars"] }],
      [B, { inUse: null, dirty: false, unpushed: true, secrets: ["web/.env.local"] }],
    ]);
    const item = diskDecisionItem(folders, facts, ROOT, "")!;
    // a folder with a secret is never "limpa"
    expect(item.options.map((option) => option.label)).toEqual(["Push e remover", "Manter por 7 dias"]);
    for (const option of item.options.filter((each) => /remov/i.test(each.label))) {
      expect(option.reply).toContain(`Antes de remover, copie para fora e me confirme estes segredos ignorados, que a remoção apaga: ${A}/.dev.vars, ${B}/web/.env.local.`);
    }
    expect(item.steps[1]!.text).toContain("segredos ignorados: .dev.vars");
    // and with only clean-and-pushed folders bar a secret, "Remover as limpas" never takes it
    const one = diskDecisionItem([folders[0]!], new Map([[A, { inUse: null, dirty: false, unpushed: false, secrets: [".dev.vars"] }]]), ROOT, "")!;
    expect(one.options[0]).toMatchObject({ label: "Push e remover" });
    expect(one.options[0]!.reply).toContain(`${A}/.dev.vars`);
  });

  // INSP-R12F r3 R3-2: what the Chief reads under any answer to a disk item
  it("the state line under an answer says what was found now and to check again before removing", () => {
    const A = "8204-reprovado-sidebar-da-fila-nao-refle-9b50cd";
    const B = "atendimento-reaberto-bugs-496989";
    const facts = new Map<string, FolderFacts>([
      [A, { inUse: null, dirty: false, unpushed: false, secrets: [".dev.vars"] }],
      [B, { inUse: "há um processo vivo dentro dela", dirty: false, unpushed: true }],
    ]);
    const line = diskStateLine([A, B, "sumiu-123"], facts, Date.parse("2026-10-05T19:40:00Z"));
    expect(line).toBe(`[Servidor: conferido no Mac em 05/10, 16:40 — ${A}: segredos ignorados: .dev.vars; ${B}: em uso (há um processo vivo dentro dela); sumiu-123: não conferida. Reconfira no Mac antes de remover qualquer pasta: o estado pode mudar até você executar. Segredos ignorados são apagados pela remoção; copie-os antes.]`);
  });
});
