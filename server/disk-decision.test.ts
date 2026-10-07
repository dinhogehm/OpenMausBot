import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nestedWorktrees, parseWorktreeList } from "./nested-worktrees.ts";
import * as d from "./disk-decision.ts";
import {
  asksOwnerToDecide,
  diskChangedText,
  DISK_REPLACED_NOTE,
  goneDiskItem,
  NOT_WALKED,
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
    expect(filesBelow("/w/.claude", (dir) => { if (!tree[dir]) throw new Error("no"); return tree[dir]!; })).toEqual({ files: ["a.md", "worktrees/", "hooks/x.cjs"], truncated: false });
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

  // INSP-R12F r5 #1: the 409 said "responda de novo" for an item the pass before had closed
  it("an answer to an item the pass before settled says what became of it", () => {
    expect(goneDiskItem(DISK_REPLACED_NOTE)).toEqual({ outcome: "replace", line: "" });
    expect(diskChangedText(goneDiskItem(DISK_REPLACED_NOTE))).toBe("Conferi agora no Mac: alguma pasta passou a ser usada ou não está mais limpa. O item foi trocado por um novo, com o que vale agora; responda nele.");
    const closed = goneDiskItem("nenhuma pasta sobrou para decidir: atendimento-reaberto-bugs-496989 (há um processo vivo dentro dela)");
    expect(closed.outcome).toBe("close");
    expect(diskChangedText(closed)).toBe("Este item foi fechado: nenhuma pasta sobrou para decidir: atendimento-reaberto-bugs-496989 (há um processo vivo dentro dela). Não há mais o que responder nele.");
    expect(diskChangedText(closed)).not.toContain("responda de novo");
    expect(diskChangedText(goneDiskItem(undefined))).toBe("Este item foi fechado: fechado por outra conferência no Mac. Não há mais o que responder nele.");
  });

  // INSP-R12F r5 #2: a walk stopped at 2 000 entries cut silently, and a secret past it was missed
  it("secrets are sought by name first, and a walk cut at its limit says there may be more", () => {
    const tree: Record<string, Array<{ name: string; dir: boolean }>> = {
      "/w/.claude": [{ name: "commands", dir: true }, { name: "deep", dir: true }],
      "/w/.claude/commands": Array.from({ length: 30 }, (_, index) => ({ name: `c${index}.md`, dir: false })),
      "/w/.claude/deep": [{ name: ".dev.vars", dir: false }, { name: "node_modules", dir: true }],
    };
    const readdir = (dir: string) => { if (!tree[dir]) throw new Error("no"); return tree[dir]!; };
    // a cap of 10: the .dev.vars behind 30 command files is still found, and the cut is said
    const cut = filesBelow("/w/.claude", readdir, 10)!;
    expect(cut.files[0]).toBe("deep/.dev.vars");
    expect(cut.files).toHaveLength(10);
    expect(cut.truncated).toBe(true);
    expect(filesBelow("/w/.claude", readdir)!.truncated).toBe(false);
    // the secret search itself cut (visit budget): said too
    expect(filesBelow("/w/.claude", readdir, 2_000, 6, 5)!.truncated).toBe(true);
    const state = porcelainState("!! .claude/\n", () => cut);
    expect(state.secrets).toEqual([".claude/deep/.dev.vars", `.claude/… ${NOT_WALKED}`]);
    // and every removal says it
    const item = diskDecisionItem([{ name: "x-1", size: "1M", reason: "r" }], new Map([["x-1", { inUse: null, unpushed: false, ...state }]]), ROOT, "")!;
    expect(item.options[0]!.reply).toContain("pode haver mais segredos não listados; confira a pasta inteira antes de remover");
    expect(porcelainState("!! .claude/\n", () => filesBelow("/w/.claude", readdir)).secrets).toEqual([".claude/deep/.dev.vars"]);
  });
});

// R13-followup #2 and #4, with the texts of 06/10: the Chief's own o28 (updated at
// 18:39), the owner's "Pode remover todos" at 18:53, and the reply of 23:10.
describe("a bot's own disk item and a reply that leaves worktrees (R13-followup)", () => {
  const names = [
    "9378-supervisor-papel-base-gerente-2d197f", "9382-mesclar-tickets-retorna-500-1137fe", "9386-9337-sobrecarga-d1-envio-do-agente-b2d01a",
    "9384-hook-v2-7-c2b-append-atendimento-b-1d2b3f", "9392-ticket-sem-e-mail-do-contato-vincul-9a6bc4", "hook-v2-4-corredores-de-operacao-61af7a",
    "9386-9337-sobrecarga-d1-envio-do-agen", "9386-9337-sobrecarga-d1-envio-do-agen-4b3994", "9392-ticket-sem-e-mail-do-contato-vin",
    "9337-sobrecarga-d1-no-envio-do-agente-2f6a57", "keen-agnesi-80191d", "503-atendimento-helpdesk-2785c8", "merge-deploy-open-prs-00664b",
    "agent-a492b70af0b5210db", "chat-wait-time-issue-21f481", "9032-equipe-em-massa-tickets-n1", "9032-equipe-em-massa-tickets-n1-7d8a26",
  ];
  // the owner_pending update the Chief sent at 18:39:42 (messages.db e8d06dd1)
  const o28 = {
    title: "Decidir o destino de 15 worktrees paradas",
    why: "Há 23 GiB livres em /Users/osvaldo/Projetos (meta: 25 GiB). Nada foi removido. Nenhuma worktree cumpre todos os critérios para remoção segura agora (limpa, parada há mais de 24 h, HEAD no GitHub e fora de sessão ativa).",
    steps: [
      { text: "Sessão ativa (manter): 9378-…-2d197f 2,8G limpa; 9382-…-1137fe 2,7G limpa; 9386-…-b2d01a 2,8G limpa, HEAD só local; 9384-…-1d2b3f 850M c/ alteração; 9392-…-9a6bc4 851M c/ alteração; hook-v2-4-…-61af7a 848M c/ alteração (03/10)" },
      { text: "Limpas, mas mexidas hoje (06/10), com HEAD na main (sem sessão): 9386-9337-sobrecarga-d1-envio-do-agen 2,2G; 9386-…-4b3994 2,2G; 9392-ticket-sem-e-mail-do-contato-vin 2,2G. Viram candidatas após 24 h." },
      { text: "9337-sobrecarga-d1-no-envio-do-agente-2f6a57: 2,9G, limpa, 06/10, sem sessão ativa, mas o HEAD NÃO está no GitHub (commits só locais)." },
      { text: "keen-agnesi-80191d: 2,2G, limpa, em uso agora (lsof), HEAD na main." },
      { text: "Com alterações não commitadas, paradas há dias: 503-atendimento-helpdesk-2785c8 848M (02/10, HEAD só local); merge-deploy-open-prs-00664b 592M (02/10, HEAD só local); agent-a492b70af0b5210db 2,5G (03/10); chat-wait-time-issue-21f481 8K (22/09)." },
      { text: "Cache do turbo na raiz (.turbo): 39M." },
      { text: "Para remover uma worktree que você decidir descartar (sem --force; falha se houver alteração)", command: "git -C /Users/osvaldo/Projetos/nuria-platform worktree remove <caminho>" },
    ],
  };
  // what the Mac says: the six with a session are in use; the three touched today too; the rest free
  const busy = new Set([names[0], names[1], names[2], names[3], names[4], names[6], names[7], names[8]]);
  const fact = (name: string): import("./disk-decision.ts").FolderFacts => {
    if (busy.has(name)) return { inUse: name.includes("9386-9337-sobrecarga-d1-envio-do-agen") || name.endsWith("-vin") ? "mudou nas últimas 24 h" : "uma conversa ou sessão trabalha nela", dirty: false, unpushed: false };
    if (name === "9337-sobrecarga-d1-no-envio-do-agente-2f6a57") return { inUse: null, dirty: false, unpushed: true };
    if (name === "agent-a492b70af0b5210db") return { inUse: null, dirty: true, unpushed: false, secrets: [".dev.vars"] };
    // the Mac does not see the app's lsof on keen-agnesi, nor the archived-to-be hook-v2-4's session
    return { inUse: null, dirty: ["503-atendimento-helpdesk-2785c8", "merge-deploy-open-prs-00664b", "chat-wait-time-issue-21f481", "hook-v2-4-corredores-de-operacao-61af7a"].includes(name), unpushed: false };
  };

  it("reads o28 as an item about removing worktrees, with what it says of each folder", () => {
    const folders = d.botDiskItemFolders(o28, names);
    expect(folders.map((each) => each.name).sort()).toEqual(names.filter((name) => !name.startsWith("9032")).sort());
    const by = (name: string) => folders.find((each) => each.name === name)!;
    expect(by("keen-agnesi-80191d")).toMatchObject({ size: "2,2G", reason: "keen-agnesi-80191d: 2,2G, limpa, em uso agora (lsof), HEAD na main." });
    expect(by("hook-v2-4-corredores-de-operacao-61af7a")).toMatchObject({ size: "848M", reason: "Sessão ativa (manter): hook-v2-4-…-61af7a 848M c/ alteração (03/10)" });
    expect(by("9386-9337-sobrecarga-d1-envio-do-agen-4b3994").size).toBe("2,2G");
    // a title without folders, about the N1 tickets, is not a disk item
    expect(d.botDiskItemFolders({ title: "Decidir a alteração em massa da equipe dos tickets do N1 (#9032, pedido da Marluce)", why: "A Marluce pediu.", steps: [{ text: "Leia o ensaio da #9032" }] }, names)).toEqual([]);
    // a worktree named, but nothing about removing it, is not either
    expect(d.botDiskItemFolders({ title: "Abrir no app a sessão da keen-agnesi-80191d", why: "Destrava o app.", steps: [{ text: "Abra o app" }] }, names)).toEqual([]);
  });

  it("keeps out what the Mac or the bot itself says is in use, and offers no --force", () => {
    const folders = d.botDiskItemFolders(o28, names);
    const facts = d.withBotKeeps(folders, new Map(folders.map((each) => [each.name, fact(each.name)])));
    // the bot's own words hold keen-agnesi and hook-v2-4; "sem sessão ativa" does not hold 9337
    expect(facts.get("keen-agnesi-80191d")!.inUse).toBe("o próprio item dizia: «keen-agnesi-80191d: 2,2G, limpa, em uso agora (lsof), HEAD na main.»");
    expect(facts.get("hook-v2-4-corredores-de-operacao-61af7a")!.inUse).toContain("Sessão ativa (manter)");
    expect(facts.get("9337-sobrecarga-d1-no-envio-do-agente-2f6a57")!.inUse).toBeNull();
    const item = d.diskDecisionItem(folders, facts, ROOT, [o28.title, o28.why, ...o28.steps.map((step) => step.text)].join("\n"), { who: "Chief of Staff não remove worktrees sem você; o servidor conferiu cada uma no Mac." })!;
    expect(item.key).toBe(`${DISK_DECISION_KEY_PREFIX}503-atendimento-helpdesk-2785c8,9337-sobrecarga-d1-no-envio-do-agente-2f6a57,agent-a492b70af0b5210db,chat-wait-time-issue-21f481,merge-deploy-open-prs-00664b`);
    expect(item.why.startsWith("Chief of Staff não remove worktrees sem você; o servidor conferiu cada uma no Mac.")).toBe(true);
    expect(item.why).toContain("keen-agnesi-80191d (o próprio item dizia: «keen-agnesi-80191d: 2,2G, limpa, em uso agora (lsof), HEAD na main.»)");
    expect(item.why).toContain("hook-v2-4-corredores-de-operacao-61af7a (o próprio item dizia:");
    expect(item.why).toContain("Não mexer sem copiar antes os segredos: agent-a492b70af0b5210db (.dev.vars).");
    expect(item.diskKept.join("; ")).toContain("keen-agnesi-80191d");
    expect(item.diskKept.join("; ")).not.toContain("agent-a492");
    for (const option of item.options) expect(option.reply).not.toMatch(/--force(?!\.)(?! )|remove --force/);
    expect(JSON.stringify(item.options)).not.toContain("keen-agnesi");
  });

  it("answers the owner's \"Pode remover todos\" of 06/10 18:53 with no authorization; \"Push e remover\" with push first and every other folder forbidden", () => {
    const folders = d.botDiskItemFolders(o28, names);
    const facts = d.withBotKeeps(folders, new Map(folders.map((each) => [each.name, { ...fact(each.name), ...(each.name.startsWith("9337") ? { branch: "fix/9337-sobrecarga" } : {}) }])));
    const item = d.diskDecisionItem(folders, facts, ROOT, "")!;
    const asked = d.keyFolders(item.key);
    // free text, the very words of 18:53: nothing may go (INSP-R13fol R4-2)
    expect(d.diskAnswerLine(asked, facts, { kind: "text", text: "Pode remover todos" }, item.diskKept)).toBe(d.DISK_NOT_AUTHORIZED);
    // the button: push first, never --force, the folders the item kept out forbidden by name
    const push = item.options.find((option) => option.label === d.DISK_PUSH_LABEL)!;
    const line = d.diskAnswerLine(asked, facts, { kind: "option", label: d.DISK_PUSH_LABEL, text: push.reply }, item.diskKept)!;
    expect(line).toContain("9337-sobrecarga-d1-no-envio-do-agente-2f6a57 (branch fix/9337-sobrecarga)");
    expect(line).toContain("PROIBIDO remover qualquer outra pasta, inclusive as que o item manteve: ");
    expect(line).toContain("keen-agnesi-80191d (o próprio item dizia:");
    expect(line).not.toContain("com --force");
  });
});

// INSP-R13fol #1-#3, #7: the owner's words authorize only what they say.
describe("what an answer to a disk item authorizes (INSP-R13fol)", () => {
  const A = "503-atendimento-helpdesk-2785c8";
  const B = "9337-sobrecarga-d1-no-envio-do-agente-2f6a57";
  const C = "chat-wait-time-issue-21f481";
  const facts = new Map<string, d.FolderFacts>([[A, { inUse: null, dirty: true, unpushed: true, branch: "claude/503-atendimento" }], [B, { inUse: null, dirty: false, unpushed: true, branch: "fix/9337" }], [C, { inUse: null, dirty: null, unpushed: null }]]);
  const all = [A, B, C];

  it("free text never authorizes a removal, whatever it says; only the item's buttons do (INSP-R13fol R4-2)", () => {
    const texts = [
      // what used to authorize: "todas", folders named, force, "sem push"
      "Pode remover todos", "Pode remover todas", "Pode remover só a 503", "Pode remover a 503 e a 9337", "Pode forçar a remoção da 503, sem push", "Pode remover todas com force",
      // R4-2: exceptions with a verb no list knew
      "Remova a 503 e a 9337; a chat-wait segura", `Pode remover a 503, a 9337 e pula a ${C}`, `Pode remover a 503 e a 9337, sem a ${C}`, `Pode remover a 503 e a 9337; a ${C} espera`,
      `Pode remover a 503 e a 9337 (a ${C} por enquanto segue)`, `Remove 503 and 9337 but keep ${C}`,
      // R3-1: the 13 exceptions
      "Pode remover todas, a 503 fica", "Pode remover todas, deixa a 503", "Pode remover todas, fora a 503", "Pode remover todas, tirando a 503",
      "Pode remover todas, com exceção da 503", "Pode remover todas, só não a 503", "Pode remover todas: a 503 não", "Pode remover todas, a 503 é minha",
      "Pode remover todas, mas a 503 eu quero ver antes", "Pode remover todas (a 503 deixa pra lá)", "Remova todas. Obs: a 9337 é do Roberto, cuidado",
      "Pode remover todas — menos a 503", `Pode remover todas – exceto a ${C}`,
      // R4-3 and R4-4: the safe misses and qualifiers are moot now
      "pode remover, não uso mais", "Pode remover todas as limpas", "Pode remover todas que estão no GitHub",
      "Não remova nada", "Não remova nada ainda. O que tem na 503?", "Qual delas é a do Roberto?", "Pode remover?", "Vou ver depois.", "Pode remover todas menos a 503", "Mantenha todas", "Se der, pode remover a 503",
      // R2-1: short assents, a condition, and the owner's real answer of 06/10 11:47 to "Decidir o destino de 16 worktrees paradas"
      "sim", "ok", "👍", "Pode", "Pode sim", "Pode remover todas, se estiverem limpas", "pode decidir por mim e fazer o que é necessario",
      // R2-2: someone else's words quoted, a doubt, irony
      "O Chief sugeriu 'pode remover todas'; vou pensar", "O Chief sugeriu «pode remover todas»", "Talvez pode remover todas", "Acho que pode remover todas", "Claro, pode remover todas e apagar meu trabalho também 🙄",
    ];
    for (const text of texts) {
      expect(d.answerRemoves({ kind: "text", text } as { kind: string }), text).toBe(false);
      expect(d.diskAnswerLine(all, facts, { kind: "text", text }, []), text).toBe(d.DISK_NOT_AUTHORIZED);
    }
    expect(d.DISK_NOT_AUTHORIZED).toBe("[Servidor: texto livre não autoriza remover nenhuma pasta. Não remova nada; para remover, o dono usa os botões do item («Remover as limpas», «Push e remover», «Criar branch e push»).]");
    // the owner hears which buttons remove; words that read like a removal get the item's own removing buttons named
    const labels = [d.DISK_PUSH_LABEL, d.DISK_KEEP_LABEL];
    expect(d.diskTextNotice("sim", all, labels)).toBe("Texto não autoriza remoção. Para remover, use os botões do item.");
    expect(d.diskTextNotice("Pode remover todas", all, labels)).toBe("Texto não autoriza remoção. Para remover, use os botões do item. Talvez você quisesse «Push e remover».");
    expect(d.diskTextNotice("Pode remover todas", all, [d.DISK_KEEP_LABEL])).toBe("Texto não autoriza remoção. Para remover, use os botões do item.");
    // only the removing buttons remove; "Manter" does not
    for (const label of [d.DISK_CLEAN_LABEL, d.DISK_PUSH_LABEL, d.DISK_BRANCH_LABEL]) expect(d.answerRemoves({ kind: "option", label })).toBe(true);
    expect(d.answerRemoves({ kind: "option", label: d.DISK_KEEP_LABEL })).toBe(false);
    expect(d.keepsFolders({ kind: "option", label: d.DISK_KEEP_LABEL })).toBe(true);
  });

  it("\"Push e remover\" is push first and the commit on the remote before any removal", () => {
    const item = d.diskDecisionItem([A, B].map((name) => ({ name, size: "1G", reason: "" })), facts, ROOT, "")!;
    const push = item.options.find((option) => option.label === d.DISK_PUSH_LABEL)!;
    expect(push.reply).toContain("push da branch de cada uma e o commit confirmado no remoto ANTES de remover, sem force.");
    expect(push.reply).toContain("Sem push confirmado, não remova.");
    const line = d.diskAnswerLine([A, B], facts, { kind: "option", label: d.DISK_PUSH_LABEL, text: push.reply }, [])!;
    expect(line).toContain(`faça push da branch dela (sem force) e confirme que o commit está no remoto — git -C <pasta> branch -r --contains HEAD não vazio — ANTES de remover: ${A} (branch claude/503-atendimento); ${B} (branch fix/9337).`);
    expect(line).toContain("nenhum commit que só existe neste Mac pode se perder");
    expect(line).not.toMatch(/autorizou remover agora|perde: commits/);
    expect(d.answerRemoves({ kind: "option", label: d.DISK_KEEP_LABEL })).toBe(false);
  });

  it("a decision covers the folders it names by their exact name, never by a part of another (9032-…-n1 and 9032-…-n1-7d8a26)", () => {
    const n1 = "9032-equipe-em-massa-tickets-n1";
    const n1b = "9032-equipe-em-massa-tickets-n1-7d8a26";
    const clean = new Map<string, d.FolderFacts>([[n1, { inUse: null, dirty: false, unpushed: false }], [n1b, { inUse: null, dirty: false, unpushed: false }]]);
    const line = d.diskAnswerLine([n1, n1b], clean, { kind: "option", label: d.DISK_CLEAN_LABEL, text: `Remova as worktrees ${n1b} com git worktree remove, sem --force.` }, [])!;
    expect(line).toContain(`remova só estas, sem --force: ${n1b}.`);
    expect(line).not.toContain(`${n1},`);
    expect(line).not.toMatch(new RegExp(`${n1}(?!-7d8a26)`));
    expect(d.namedFolders(`Remova ${n1b}.`, [n1, n1b])).toEqual([n1b]);
    expect(d.namedFolders(`git worktree remove /x/.claude/worktrees/${n1}`, [n1, n1b])).toEqual([n1]);
  });
});

// INSP-R13fol #4, #5, #9, with the real items of 03 to 05/10 (messages.db).
describe("which bot items become the server's disk item (INSP-R13fol)", () => {
  const folders = ["merge-deploy-open-prs-00664b", "release-sqlite-warning", "n2-ticket-distribution-bug-78843c", "chat-wait-time-issue-21f481", "keen-agnesi-80191d"];
  // o1 of 05/10 18:01Z, "URGENTE": its ask is a rm -rf of task-workspaces; the worktree is optional
  const urgent = {
    title: "URGENTE: liberar disco, 4 GiB livres com release de produção rodando",
    why: "O disco caiu para 4 GiB durante o release da #9374. Se zerar, o deploy falha no meio e o servidor para de gravar. As pastas paradas do Eng e do QA liberam ~6,5 GB sem tocar em trabalho ativo.",
    steps: [
      { text: "Apagar as 3 pastas de trabalho paradas do Eng e do QA (2,2 + 2,2 + 2,1 GB, sem uso desde 28-29/09)", command: "rm -rf ~/.openmausbot/task-workspaces/82feff85*/fa9d2302* ~/.openmausbot/task-workspaces/82feff85*/54118a8a* ~/.openmausbot/task-workspaces/e9ba01c7*/70fa6c86*" },
      { text: "Opcional: remover a worktree merge-deploy (592 MB, PR #9126 fechada sem merge)", command: "git -C /Users/osvaldo/Projetos/nuria-platform worktree remove /Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/merge-deploy-open-prs-00664b" },
      { text: "Não remover a release-sqlite-warning: tem o commit ac0697762 sem PR" },
    ],
    options: [{ label: "Apaguei as duas", reply: "Apaguei as pastas paradas e a worktree merge-deploy, confira o disco." }, { label: "Só as pastas", reply: "Apaguei só as pastas paradas; mantenha a worktree merge-deploy." }],
  };
  // o3 of 04/10 14:28Z: saving 3 orphan worktrees, push barred
  const orphans = {
    title: "Decidir como salvar as 3 worktrees órfãs (o Jev barrou o push)",
    why: "O cache antigo de CI já foi apagado e o disco subiu para 8 GiB livres. As três órfãs (8,6 GB) não saíram: o Jev barrou o push da branch com risco de 87%, e o guarda barrou mexer nas pastas .claude delas.",
    steps: [
      { text: "Push barrado (o Chief não tentou de novo):", command: "git push origin claude/n2-ticket-distribution-bug-78843c" },
      { text: "Para remover você mesmo no terminal, preservando as branches locais:", command: "cd ~/Projetos/nuria-platform && for w in transfer-n2-sem-agente-824837 n2-ticket-distribution-bug-78843c nur-12-d1-overload-02e53e; do git -C .claude/worktrees/$w checkout -- .gitignore; git worktree remove --force .claude/worktrees/$w; done" },
    ],
    options: [{ label: "Eu removo", reply: "removi as órfãs no terminal" }, { label: "Pode dar push", reply: "pode dar push das 3 branches órfãs" }, { label: "Deixar como está", reply: "deixa as órfãs como estão" }],
  };
  const pushItem = { title: "Aprovar o push da PR #9392", why: "O Jev barrou o push; a sessão roda na worktree 9392.", steps: [{ text: "No terminal", command: "git -C ~/Projetos/nuria-platform/.claude/worktrees/chat-wait-time-issue-21f481 push -u origin HEAD" }] };
  const ciItem = { title: "Rodar o ci:local da PR #9393", why: "A sessão parou.", steps: [{ text: "Na worktree chat-wait-time-issue-21f481, rode o ci:local para liberar o gate" }] };
  const archive = { title: "Arquivar no app a sessão Gerenciador OpenMausBot", why: "Ela aponta para a worktree keen-agnesi-80191d, que já foi removida; limpe a lista do app.", steps: [{ text: "No app, arquive a sessão" }] };

  it("only an item whose ask is removing worktrees, and nothing else, is converted", () => {
    expect(d.botItemAsk(urgent)).toBe("mixed");
    expect(d.botItemAsk(orphans)).toBe("mixed");
    expect(d.botItemAsk(pushItem)).toBe("other");
    expect(d.botItemAsk(ciItem)).toBe("other");
    expect(d.botItemAsk(archive)).toBe("other");
    for (const item of [urgent, orphans, pushItem, ciItem, archive]) expect(d.botDiskItemFolders(item, folders), item.title).toEqual([]);
    expect(d.botItemAsk({ title: "Decidir o destino de 15 worktrees paradas", steps: [{ text: "Para remover (sem --force)", command: "git -C /Users/osvaldo/Projetos/nuria-platform worktree remove <caminho>" }, { text: "Veja", command: "git -C /x status --short && git -C /x log --oneline origin/main..HEAD" }] })).toBe("remove");
    // R2-3: a word is not a command — "o HEAD já está no GitHub", a label copied from the server's "Push e remover"
    const words = { title: "Decidir o destino da worktree chat-wait-time-issue-21f481", steps: [{ text: "Remover", command: "git -C /r worktree remove /r/.claude/worktrees/chat-wait-time-issue-21f481" }], options: [{ label: "Pode remover", reply: "Pode remover; o HEAD já está no GitHub." }, { label: "Push e remover", reply: "Faça push e remova." }] };
    expect(d.botItemAsk(words)).toBe("remove");
    expect(d.botDiskItemFolders(words, folders).map((each) => each.name)).toEqual(["chat-wait-time-issue-21f481"]);
  });

  it("a mixed item keeps its other asks; its removal goes to the server's item beside it, its removal commands out (R2-3)", () => {
    // o1 URGENTE: the rm -rf stays the bot's; merge-deploy goes to the server's item
    const urgentSplit = d.splitMixedRemoval(urgent, folders)!;
    expect(urgentSplit.folders).toEqual([{ name: "merge-deploy-open-prs-00664b", size: "592M", reason: "Opcional: remover a worktree merge-deploy (592 MB, PR #9126 fechada sem merge)" }]);
    expect(urgentSplit.steps[0]).toEqual(urgent.steps[0]);
    expect(urgentSplit.steps[1]!.command).toBeUndefined();
    expect(urgentSplit.steps[1]!.text).toBe("Opcional: remover a worktree merge-deploy (592 MB, PR #9126 fechada sem merge) (o comando de remoção saiu deste item: a remoção vai pelo item de disco do servidor, conferido no Mac)");
    expect(urgentSplit.steps[2]).toEqual(urgent.steps[2]);
    // o3: the push stays; the folders named in the loop go to the server's item (here, the one that exists)
    const orphanSplit = d.splitMixedRemoval(orphans, folders)!;
    expect(orphanSplit.folders.map((each) => each.name)).toEqual(["n2-ticket-distribution-bug-78843c"]);
    expect(orphanSplit.steps[0]!.command).toBe("git push origin claude/n2-ticket-distribution-bug-78843c");
    expect(orphanSplit.steps[1]!.command).toBeUndefined();
    // its loop (cd, checkout, remove --force) left whole, said so (R4-1)
    expect(orphanSplit.steps[1]!.text).toContain("(comando retirado: misturava remoção de worktree com outros passos; peça ao bot para separar.");
    expect(orphanSplit.mixedCommands).toBe(1);
    expect(urgentSplit.mixedCommands).toBe(0);
    // the item of the #9378 (05/10): the restore and the cache stay; the plain removal goes to the server
    const w9378 = "9378-supervisor-do-atendimento-2fd161";
    const item9378 = {
      title: "Decidir o destino da worktree da #9378, já em produção (2,8G)",
      steps: [
        { text: "Descartar a linha que o graft adicionou ao .gitignore", command: `git -C /Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/${w9378} restore .gitignore` },
        { text: "Remover a worktree (sem --force)", command: `git -C /Users/osvaldo/Projetos/nuria-platform worktree remove /Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/${w9378}` },
        { text: "Opcional: apagar o cache do graft que a sessão tirou da pasta (regenerável)", command: "rm -rf /tmp/graft-9378-aside" },
      ],
    };
    const split9378 = d.splitMixedRemoval(item9378, [...folders, w9378])!;
    expect(split9378.folders.map((each) => each.name)).toEqual([w9378]);
    expect(split9378.steps.map((step) => step.command)).toEqual([item9378.steps[0]!.command, undefined, "rm -rf /tmp/graft-9378-aside"]);
    expect(split9378.mixedCommands).toBe(0);
    // the item of 05/10 16:31: its rm -rf stays; the plain removal goes
    const free = { ...urgent, title: "Liberar espaço em disco: 9 GiB livres (abaixo de 10)", steps: [urgent.steps[0]!, urgent.steps[1]!, { text: "Me responder aqui; eu confiro o df" }] };
    const splitFree = d.splitMixedRemoval(free, folders)!;
    expect(splitFree.steps.map((step) => step.command)).toEqual([urgent.steps[0]!.command, undefined, undefined]);
    // not mixed, or no worktree named: nothing to split
    expect(d.splitMixedRemoval(pushItem, folders)).toBeNull();
    expect(d.splitMixedRemoval({ ...urgent, steps: [urgent.steps[0]!, { text: "x", command: "git worktree remove .worktrees/lot-t-release" }] }, folders)).toBeNull();
  });

  it("a command with a removal and anything else leaves WHOLE, never rewritten into an unconditional one (R4-1); a decision that removes points to the server's item (R3-3)", () => {
    const M = "/r/.claude/worktrees/merge-deploy-open-prs-00664b";
    // the eight lines of the report, and the two the lead named: all mixed, none rewritten
    const mixed = [
      `git worktree remove ${M} || rm -rf ${M}`,
      `git worktree remove ${M} && git branch -D fix/merge-deploy`,
      `git worktree remove --force ${M} && git worktree prune`,
      `bash -c "git worktree remove ${M} && rm -rf /tmp/c"`,
      `(cd /r && git worktree remove ${M}) && rm -rf /tmp/a`,
      `if test -d ${M}; then git worktree remove ${M}; fi`,
      `for w in a-1 b-2; do rm -rf /tmp/$w; git worktree remove $w; done`,
      `cat <<EOF\ngit worktree remove ${M} && echo ok\nEOF`,
      `rm -rf /tmp/d && git worktree remove ${M} || echo falhou`,
      `git worktree remove ${M} | tee /tmp/log`,
    ];
    for (const command of mixed) expect(d.onlyRemoval(command), command).toBe(false);
    for (const command of [`git worktree remove ${M}`, `git -C /r worktree remove ${M}`, `git -C /r worktree remove --force ${M}`]) expect(d.onlyRemoval(command), command).toBe(true);
    for (const command of mixed) {
      const split = d.splitMixedRemoval({ title: "Liberar disco", steps: [{ text: "Limpe o cache", command: "rm -rf /tmp/cache" }, { text: "Remova a merge-deploy", command }] }, folders);
      if (!split) continue; // a loop over $w names no folder here
      expect(split.steps[1]!.command, command).toBeUndefined();
      expect(split.steps[1]!.text, command).toContain("(comando retirado: misturava remoção de worktree com outros passos; peça ao bot para separar.");
      expect(split.steps[0]!.command).toBe("rm -rf /tmp/cache");
      expect(split.mixedCommands).toBe(1);
    }
    const both = {
      title: "Apague o cache e a merge-deploy",
      steps: [{ text: "Apague o cache e remova a merge-deploy", command: "rm -rf /Users/osvaldo/Projetos/nuria-platform/.turbo && git -C /r worktree remove /r/.claude/worktrees/merge-deploy-open-prs-00664b" }],
      options: [{ label: "Rode você", reply: "Rode git worktree remove /r/.claude/worktrees/chat-wait-time-issue-21f481 por mim" }, { label: "Só o cache", reply: "Apague só o cache." }],
    };
    const split = d.splitMixedRemoval(both, folders)!;
    expect(split.folders.map((each) => each.name)).toEqual(["merge-deploy-open-prs-00664b", "chat-wait-time-issue-21f481"]);
    // "rm -rf .turbo && git worktree remove …": out whole, said so; the bot rewrites the cache part on its own
    expect(split.steps[0]!.command).toBeUndefined();
    expect(split.mixedCommands).toBe(1);
    expect(split.options![0]).toEqual({ label: "Rode você", reply: "Rode você: a remoção de worktree vai pelo item de disco do servidor, conferido no Mac; por este item, não remova nenhuma worktree." });
    expect(split.options![1]).toEqual(both.options[1]);
  });

  it("the size of a split folder is the one said right after its name (R3-5, item of 03/10 13:32)", () => {
    const names = ["release-lote-p", "8891-503-diag", "8891-inbox-503"];
    const item = {
      title: "Liberar mais espaço em disco (13 GiB livres, 97% cheio)",
      steps: [
        { text: "Cache do turbo na raiz, 4,1 GB.", command: "rm -rf /Users/osvaldo/Projetos/nuria-platform/.turbo" },
        { text: "Worktrees limpas, de trabalho antigo: release-lote-p (2,2 GB), 8891-503-diag e 8891-inbox-503 (215 MB cada).", command: "cd /Users/osvaldo/Projetos/nuria-platform && for w in release-lote-p 8891-503-diag 8891-inbox-503; do git worktree remove .claude/worktrees/$w; done" },
      ],
    };
    const split = d.splitMixedRemoval(item, names)!;
    expect(split.folders.map((each) => `${each.name}[${each.size}]`)).toEqual(["release-lote-p[2,2G]", "8891-503-diag[215M]", "8891-inbox-503[215M]"]);
    expect(split.steps[0]!.command).toBe("rm -rf /Users/osvaldo/Projetos/nuria-platform/.turbo");
    expect(split.steps[1]!.command).toBeUndefined();
  });

  it("a folder with HEAD detached is offered \"Criar branch e push\", never \"Push e remover\" (R2-4)", () => {
    const facts = new Map<string, d.FolderFacts>([["merge-deploy-open-prs-00664b", { inUse: null, dirty: false, unpushed: true, detached: true }], ["release-sqlite-warning", { inUse: null, dirty: false, unpushed: true, branch: "fix/sqlite" }]]);
    const item = d.diskDecisionItem(["merge-deploy-open-prs-00664b", "release-sqlite-warning"].map((name) => ({ name, size: "1G", reason: "" })), facts, ROOT, "")!;
    expect(item.options.map((option) => option.label)).toEqual([d.DISK_PUSH_LABEL, d.DISK_BRANCH_LABEL, d.DISK_KEEP_LABEL]);
    expect(item.options[0]!.reply).toContain("Para as worktrees release-sqlite-warning:");
    expect(item.options[1]!.reply).toContain("Para as worktrees merge-deploy-open-prs-00664b (HEAD destacado): crie a branch salva/<pasta> no HEAD, faça push dela e confirme o commit no remoto ANTES de remover");
    const line = d.diskAnswerLine(["merge-deploy-open-prs-00664b"], facts, { kind: "option", label: d.DISK_BRANCH_LABEL, text: item.options[1]!.reply }, [])!;
    expect(line).toContain("crie a branch salva/<pasta> no HEAD (git -C <pasta> switch -c salva/<pasta>), faça push dela (sem force)");
    expect(line).toContain("merge-deploy-open-prs-00664b (HEAD destacado: crie antes a branch salva/merge-deploy-open-prs-00664b)");
    expect(d.answerRemoves({ kind: "option", label: d.DISK_BRANCH_LABEL })).toBe(true);
  });

  it("the bot's \"não remover\", \"não mexer\", \"preservar\" and a session pointing at it hold a folder", () => {
    for (const said of ["Não remover a release-sqlite-warning: tem o commit ac0697762 sem PR", "release-sqlite-warning: não mexer, trabalho do dono", "release-sqlite-warning: preservar (commit sem PR)", "keen-agnesi-80191d: a sessão do app Gerenciador ainda aponta para ela"]) {
      const found = d.botDiskItemFolders({ title: "Decidir o destino de 2 worktrees paradas", why: "Liberar disco.", steps: [{ text: said }, { text: "Para remover", command: "git -C /r worktree remove <caminho>" }] }, folders);
      const held = d.withBotKeeps(found, new Map(found.map((each) => [each.name, { inUse: null, dirty: false, unpushed: true }])));
      expect(found.length, said).toBe(1);
      expect(held.get(found[0]!.name)!.inUse, said).toContain("o próprio item dizia");
    }
  });

  it("a command the same sentence forbids opens nothing", () => {
    const reply = "Osvaldo, a worktree chat-wait-time-issue-21f481 precisa de você? Não: eu já a conferi. Nunca rode `git worktree remove ~/Projetos/nuria-platform/.claude/worktrees/chat-wait-time-issue-21f481` nela, ela guarda o rascunho.";
    expect(d.commandFolders(reply, folders)).toEqual([]);
    expect(diskDecisionFolders(reply, folders)).toEqual([]);
  });

  it("the folders kept out are a list on the item, whatever their reasons say", () => {
    const facts = new Map<string, d.FolderFacts>([["merge-deploy-open-prs-00664b", { inUse: null, dirty: true, unpushed: false }], ["keen-agnesi-80191d", { inUse: "o próprio item dizia: «keen-agnesi-80191d: 2,2G. Em uso agora (lsof)»", dirty: false, unpushed: false }], ["release-sqlite-warning", { inUse: "sessão «Fix v0.1.98. Then retry» nela", dirty: false, unpushed: false }]]);
    const item = d.diskDecisionItem(["merge-deploy-open-prs-00664b", "keen-agnesi-80191d", "release-sqlite-warning"].map((name) => ({ name, size: "1G", reason: "" })), facts, ROOT, "")!;
    expect(item.diskKept).toEqual(["keen-agnesi-80191d (o próprio item dizia: «keen-agnesi-80191d: 2,2G. Em uso agora (lsof)»)", "release-sqlite-warning (sessão «Fix v0.1.98. Then retry» nela)"]);
    expect(d.keptOutOf(item)).toEqual(item.diskKept);
  });
});

describe("a reply that leaves worktrees to the owner (R13-followup #4)", () => {
  const names = ["9032-equipe-em-massa-tickets-n1", "9032-equipe-em-massa-tickets-n1-7d8a26", "chat-wait-time-issue-21f481"];

  it("turns the 23:10 reply — \"vazias\", the removal with the owner, two commands — into an item with the real size", () => {
    const reply = [
      "O servidor mandou o relatório de disco e pastas de trabalho. Não removi nada. O disco tem 29 GiB livres e a meta é 25 GiB, então nada precisa sair agora.",
      "",
      "- **Pastas já em produção:** o servidor avaliou só uma, a `omb-seed`, e ela não pode sair porque está bloqueada. As outras 9 ele não avaliou.",
      "- **Duas pastas da #9032 sem uso** (`9032-equipe-em-massa-tickets-n1` e `9032-equipe-em-massa-tickets-n1-7d8a26`): são das duas sessões que não abriram no app e que eu já arquivei. Eu tinha pedido que o arquivamento removesse as pastas, mas elas ficaram, provavelmente porque as sessões nunca abriram. As duas estão vazias e não guardam trabalho nenhum. Pela sua regra, a remoção fica com você. Se quiser apagá-las:",
      "  - `git -C /Users/osvaldo/Projetos/nuria-platform worktree remove /Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/9032-equipe-em-massa-tickets-n1`",
      "  - `git -C /Users/osvaldo/Projetos/nuria-platform worktree remove /Users/osvaldo/Projetos/nuria-platform/.claude/worktrees/9032-equipe-em-massa-tickets-n1-7d8a26`",
      "- **Pasta antiga do Lead PRODEV:** ocupa 271 MB e está parada desde 29/09. Ocupa pouco espaço, então não abro item para ela enquanto o disco estiver acima da meta.",
    ].join("\n");
    // why it opened nothing at 23:10: not a routine's run, no ask the server knew, no table with sizes
    expect(d.replyLeavesDiskToOwner(reply)).toBe(true);
    expect(d.commandFolders(reply, names)).toEqual(["9032-equipe-em-massa-tickets-n1", "9032-equipe-em-massa-tickets-n1-7d8a26"]);
    const folders = diskDecisionFolders(reply, names);
    expect(folders).toEqual([
      { name: "9032-equipe-em-massa-tickets-n1", size: "?", reason: "comando de remoção deixado no texto" },
      { name: "9032-equipe-em-massa-tickets-n1-7d8a26", size: "?", reason: "comando de remoção deixado no texto" },
    ]);
    // the server measures them (du): 2,2G each, not "vazias"
    for (const folder of folders) folder.size = d.duSize(2.2 * 1024 * 1024);
    const clean = { inUse: null, dirty: false, unpushed: false };
    const item = diskDecisionItem(folders, new Map(folders.map((each) => [each.name, clean])), ROOT, reply, { who: "A remoção dessas worktrees é sua; o servidor conferiu cada uma no Mac." })!;
    expect(item.title).toBe("Decidir o destino de 2 worktrees paradas (~4,4 GiB): 9032-equipe-em-massa-tickets-n1, 9032-equipe-em-massa-tickets-n1-7d8a26");
    expect(item.steps[1]!.text).toBe("Veja 9032-equipe-em-massa-tickets-n1 (2,2G; limpa e no GitHub)");
    expect(item.options[0]!.label).toBe("Remover as limpas");
    // a reply that only reports, or says nothing to the owner about worktrees, opens nothing
    expect(d.replyLeavesDiskToOwner("Osvaldo, removi 10 das 15 worktrees do o28. Agora há 29 GiB livres.")).toBe(false);
    expect(d.replyLeavesDiskToOwner("A sessão da #9390 está parada de propósito, esperando a vez no gate.")).toBe(false);
  });

  it("measures sizes as a routine writes them", () => {
    expect([d.duSize(0), d.duSize(8), d.duSize(271 * 1024), d.duSize(2.2 * 1024 * 1024)]).toEqual(["0K", "8K", "271M", "2,2G"]);
  });
});

describe("an item checked again keeps what it kept out (R13-followup #2)", () => {
  it("says again the folders the bot held, and its origin", () => {
    const A = "503-atendimento-helpdesk-2785c8";
    const B = "9337-sobrecarga-d1-no-envio-do-agente-2f6a57";
    const kept = "keen-agnesi-80191d (o próprio item dizia: «keen-agnesi-80191d: 2,2G, limpa, em uso agora (lsof), HEAD na main.»)";
    const folders = [{ name: A, size: "848M", reason: "" }, { name: B, size: "2,9G", reason: "" }];
    const facts = new Map<string, d.FolderFacts>([[A, { inUse: null, dirty: true, unpushed: false }], [B, { inUse: "há um processo vivo dentro dela", dirty: false, unpushed: true }]]);
    const item = diskDecisionItem(folders, facts, ROOT, "", { who: "Chief of Staff não remove worktrees sem você; o servidor conferiu cada uma no Mac.", kept: [kept, `${B} (mudou nas últimas 24 h)`] })!;
    expect(item.key).toBe(`${DISK_DECISION_KEY_PREFIX}${A}`);
    expect(item.why).toBe(`Chief of Staff não remove worktrees sem você; o servidor conferiu cada uma no Mac. Juntas ocupam ~848 MB. 1 tem trabalho que só existe neste Mac. Não mexer (fora deste item): ${B} (há um processo vivo dentro dela); ${kept}.`);
    expect(item.diskKept).toEqual([`${B} (há um processo vivo dentro dela)`, kept]);
    // an item saved before the list: read from its why
    expect(d.keptOutOf({ why: item.why })).toEqual(item.diskKept);
  });
});
