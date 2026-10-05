// The Chief's hourly disk routine may remove only clean, pushed, idle
// worktrees; for the rest it can only say so. On 05/10 it said, every hour,
// that 8204, 9052 and atendimento-reaberto (~5,5 GiB, commits only on this
// Mac) were left "para você decidir" or that "alguém pode remover essas
// pastas manualmente" — and no item ever reached "Precisa de você"
// (R11-followup #5, R12-followup #5). When a disk routine's run ends asking
// the owner to decide, the server opens ONE item for it: why, the steps to
// look at each folder, and the decisions — keyed by the folders, so the
// same list is refreshed, never doubled, and not reopened once decided.

/** A folder the routine left, as it named it (resolved to the real folder name). */
export interface LeftFolder {
  name: string;
  size: string;
  reason: string;
}

export const DISK_DECISION_KEY_PREFIX = "disk-decision:";
/** Once the owner settled the item for a list, the same list is not asked again for this long. */
export const DISK_DECISION_SETTLED_MS = 7 * 24 * 3_600_000;
const STEPS_FOLDERS_MAX = 6;

/** A routine about the disk and its worktrees (by its name or what it said). */
export function diskRoutine(name: string, text: string): boolean {
  return /disco|disk/i.test(name) || (/\bdf -g\b|GiB livres/i.test(text) && /worktree/i.test(text));
}

// "deixei uma para você decidir" (08:22), "alguém pode remover essas pastas
// manualmente" (11:38), "Posso conferir isso PR por PR e remover…" (13:38)
const ASKS = /para voc[eê] decidir|decis[aã]o sua|sua decis[aã]o|sua escolha|sua autoriza[cç][aã]o|cabe a voc[eê]|algu[eé]m (?:pode|precisa) remov|manualmente|precisa(?:m)? de voc[eê]|posso (?:conferir|remover|apagar)|quer que eu (?:remova|apague)/i;

/** The run's words leave a choice to the owner: remove folders, or decide. */
export function asksOwnerToDecide(text: string): boolean {
  return ASKS.test(text);
}

/** A folder the routine must not count as the owner's call: a session on it, or touched within the day. */
const notForOwner = (reason: string) => /sess[aã]o (?:ativa|que est[aá])|menos de 24 ?h|em uso|usada agora/i.test(reason);

/** The real folder a routine's name points to: the name itself, or its
 * short form "8204-9b50cd" (first word and last hash of the folder). */
export function resolveFolder(token: string, folders: readonly string[]): string | null {
  const clean = token.replace(/[`*]/g, "").replace(/(?:-?\.\.\.|…)$/, "").trim();
  if (!clean) return null;
  if (folders.includes(clean)) return clean;
  // a bare word ("merge", "main") never names a folder: a short name has a digit or a hyphen
  if (!/\d|-/.test(clean)) return null;
  const parts = clean.split("-");
  const matches = folders.filter((folder) => (parts.length > 1 && folder.startsWith(`${parts[0]}-`) && folder.endsWith(`-${parts.at(-1)}`)) || folder.startsWith(`${clean}-`) || folder.startsWith(clean));
  return matches.length === 1 ? matches[0]! : null;
}

/** The folders the owner is asked about: those the asking paragraph names
 * ("8204, 9052 e atendimento-reaberto somam cerca de 5,5 GiB… alguém pode
 * remover essas pastas manualmente"), with what the run's table says of
 * them; when it names none, every folder the run left for the owner. */
export function diskDecisionFolders(text: string, folders: readonly string[]): LeftFolder[] {
  const left = leftFolders(text, folders, true);
  const named: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (!ASKS.test(paragraph) || paragraph.trim().startsWith("|")) continue;
    for (const match of paragraph.matchAll(/[A-Za-z0-9][\w.-]{2,}/g)) {
      const name = resolveFolder(match[0], folders);
      if (name && !named.includes(name)) named.push(name);
    }
  }
  const chosen = named.length
    ? named.map((name) => left.find((folder) => folder.name === name) ?? { name, size: "?", reason: "citada pela rotina" })
    : left;
  return chosen.filter((folder) => !notForOwner(folder.reason));
}

/** The folders a run's text says were left, with size and why: from its
 * table ("| 8204-… | 3,0G | commits só locais |") or its list
 * ("8204-9b50cd (3,0G), 9052-35787b (2,2G)" under "commits só locais").
 * Only folders that exist; never one with a live session or touched today. */
export function leftFolders(text: string, folders: readonly string[], keepBusy = false): LeftFolder[] {
  const out = new Map<string, LeftFolder>();
  const add = (token: string, size: string, reason: string) => {
    const name = resolveFolder(token, folders);
    if (!name || out.has(name) || (!keepBusy && notForOwner(reason))) return;
    out.set(name, { name, size: size.replace(/\s+/g, ""), reason: reason.replace(/\s+/g, " ").trim() });
  };
  for (const line of text.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim()).filter((_, index, all) => index > 0 && index < all.length - 1);
    if (cells.length >= 3 && /^[\d.,]+\s*[KMGT]i?B?$/i.test(cells[1]!)) {
      add(cells[0]!, cells[1]!, cells.slice(2).join(" "));
      continue;
    }
    // "| Limpas, mas com commits só locais | 8204-9b50cd (3,0G), 9052-35787b (2,2G) |"
    if (cells.length === 2) {
      for (const match of cells[1]!.matchAll(/`?([\w.-]{3,})`?\s*\(([\d.,]+\s*[KMGT]i?B?)\)/gi)) add(match[1]!, match[2]!, cells[0]!);
    }
  }
  return [...out.values()];
}

const keyFolders = (key: string) => key.slice(DISK_DECISION_KEY_PREFIX.length).split(",");

/** What to do with a new list: open (or refresh) its item, and which other
 * disk items it replaces. Nothing when an open item already asks about all
 * of these folders (13:38 asked about 8204 and 9052, already in 11:38's), or
 * when the owner settled them less than a week ago. */
export function diskDecisionPlan(
  key: string,
  open: ReadonlyArray<{ key?: string }>,
  settled: ReadonlyArray<{ key?: string; resolvedAt: number }>,
  now: number,
): { add: boolean; replace: string[] } {
  const names = keyFolders(key);
  const covers = (other: string) => names.every((name) => keyFolders(other).includes(name));
  const disk = (each: { key?: string }): each is { key: string } => Boolean(each.key?.startsWith(DISK_DECISION_KEY_PREFIX));
  if (settled.some((each) => disk(each) && covers(each.key) && now - each.resolvedAt < DISK_DECISION_SETTLED_MS)) return { add: false, replace: [] };
  const openDisk = open.filter(disk);
  if (openDisk.some((each) => each.key !== key && covers(each.key))) return { add: false, replace: [] };
  return { add: true, replace: openDisk.filter((each) => each.key !== key).map((each) => each.key) };
}

/** "3,0G" + "2,2G" + "263M" → "~5,5 GiB". */
export function totalSize(folders: readonly LeftFolder[]): string {
  const bytes = folders.reduce((sum, folder) => {
    const match = /^([\d.,]+)\s*([KMGT])/i.exec(folder.size);
    if (!match) return sum;
    const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match[2]!.toUpperCase() as "K" | "M" | "G" | "T"];
    return sum + Number(match[1]!.replace(",", ".")) * unit;
  }, 0);
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `~${gib.toFixed(1).replace(".", ",")} GiB` : `~${Math.round(bytes / 1024 ** 2)} MB`;
}

/** The one item for the owner: keyed by the folders. */
export function diskDecisionItem(folders: readonly LeftFolder[], root: string, text: string): {
  key: string;
  title: string;
  why: string;
  steps: Array<{ text: string; command?: string }>;
  options: Array<{ label: string; reply: string; recommended?: true; why?: string }>;
} {
  const names = folders.map((folder) => folder.name).sort();
  const total = totalSize(folders);
  const free = /\*{0,2}(\d+(?:,\d+)?) GiB livres/i.exec(text)?.[1];
  const path = (name: string) => `${root}/${name}`;
  const list = names.join(" ");
  const shown = folders.slice(0, STEPS_FOLDERS_MAX);
  return {
    key: `${DISK_DECISION_KEY_PREFIX}${names.join(",")}`,
    title: `Decidir o destino de ${folders.length} worktree${folders.length === 1 ? "" : "s"} parada${folders.length === 1 ? "" : "s"} (${total}): ${names.join(", ")}`.slice(0, 200),
    why: `A rotina de disco não pode removê-las: têm commits ou alterações que só existem neste Mac. Juntas ocupam ${total}${free ? `; o disco está com ${free} GiB livres e o release exige 8` : ""}. Enquanto ninguém decide, a rotina repete o aviso a cada hora.`.slice(0, 400),
    steps: [
      ...shown.map((folder) => ({
        text: `Veja o que só existe em ${folder.name} (${folder.size}, ${folder.reason})`.slice(0, 300),
        command: `git -C ${path(folder.name)} status --short && git -C ${path(folder.name)} log --oneline origin/main..HEAD`,
      })),
      ...(folders.length > shown.length ? [{ text: `E mais ${folders.length - shown.length}: ${names.filter((name) => !shown.some((folder) => folder.name === name)).join(", ")}`.slice(0, 300) }] : []),
      { text: "Escolha abaixo; o Chief executa a escolha e confirma no canal." },
    ].slice(0, 8),
    options: [
      { label: "Remover todas", reply: `Pode remover as worktrees ${list} (git worktree remove --force). O que só existe nelas pode ser descartado.` },
      { label: "Push e remover", reply: `Faça push das branches das worktrees ${list} (sem force) e, com o push confirmado no GitHub, remova-as sem --force.` },
      { label: "Manter", reply: `Mantenha as worktrees ${list}. Não remova nem volte a me perguntar por elas.` },
    ],
  };
}
