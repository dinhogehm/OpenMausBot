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
 * remover essas pastas manualmente") AND the run's table or list left, with
 * what it says of them; when it names none, every folder it left. A folder
 * named only in a sentence ("a 9374 está com sessão ativa") is never taken
 * (INSP-R12F F1). Whether one is in use is checked on the Mac (folderInUse). */
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
  const chosen = named.length ? left.filter((folder) => named.includes(folder.name)) : left;
  return chosen.filter((folder) => !notForOwner(folder.reason));
}

/** What the server found on the Mac about one folder (index.ts openDiskDecision). */
export interface FolderFacts {
  /** Why it is in use (a session, a live process, touched within the day, unknown activity), or null. */
  inUse: string | null;
  /** Changes not committed; null when git could not tell. */
  dirty: boolean | null;
  /** HEAD on no remote branch; null when git could not tell. */
  unpushed: boolean | null;
  /** Ignored files that only live here and matter (not build output), secrets apart. */
  ignored?: string[];
  /** Ignored secrets (.dev.vars, .env, keys): never junk; a removal must have them copied first. */
  secrets?: string[];
}

// Secrets, by name: never junk, wherever they are (INSP-R12F r3 R3-1).
const SECRET = /(?:^|\/)(?:\.dev\.vars[^/]*|\.env(?!\.example$|\.sample$|\.template$)(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx|jks|keystore)|credentials[^/]*|[^/]*service[-_]account[^/]*\.json|id_(?:rsa|ed25519|ecdsa)[^/]*|\.npmrc|\.netrc|\.pgpass)$/i;

// What an ignored path may be without being anyone's work: build output,
// caches and what the tools regenerate. Read off the real nuria-platform
// worktrees (`git status --porcelain --ignored`, 05/10): smart-deploy's
// .deploy-*, graft's index, husky's _/, the .ignore graft writes, nested
// release worktrees, the ci:local receipts, the inspection outputs, the
// lighthouse reports and the widget's _generated bundle; and the root
// .claude/, which a worktree gets as a copy of the main checkout's (the same
// CLAUDE.md, rules, settings.local.json and plan.md, compared on 05/10).
const JUNK = new RegExp([
  "(?:^|/)(?:node_modules|dist|build|out|\\.next|\\.turbo|coverage|\\.cache|\\.local-ci|\\.wrangler|target|\\.vite|\\.parcel-cache|\\.svelte-kit|\\.nuxt|\\.output|storybook-static|\\.vercel|\\.lighthouse|_generated)(?:/|$)",
  "(?:^|/)(?:\\.deploy-history|graft|\\.worktrees|\\.audit-out)(?:/|$)",
  "^\\.husky/_(?:/|$)",
  "^\\.claude(?:/|$)",
  "(?:^|/)(?:\\.deploy-metrics\\.json|\\.deploy-report\\.[a-z]+|\\.ignore|\\.DS_Store|\\.eslintcache)$",
  "\\.(?:log|tsbuildinfo)$",
].join("|"));

/** From `git status --porcelain --ignored`: whether anything is changed or
 * untracked; the ignored secrets; and the other ignored paths that are not
 * junk — they exist only on this Mac, and removing the folder loses them
 * (INSP-R12F r2 R2-2, r3 R3-1). */
export function porcelainState(output: string): { dirty: boolean; ignored: string[]; secrets: string[] } {
  const lines = output.split("\n").filter((line) => line.trim());
  const paths = lines.filter((line) => line.startsWith("!! ")).map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
  const bare = (path: string) => path.replace(/\/$/, "");
  const secrets = paths.filter((path) => SECRET.test(bare(path)));
  const ignored = paths.filter((path) => !SECRET.test(bare(path)) && !JUNK.test(bare(path)));
  return { dirty: lines.some((line) => !line.startsWith("!! ")), ignored, secrets };
}

/** A folder is in use when a session or an agent's conversation works in it
 * (or inside it), a live process has its cwd there, or it changed in the
 * last 24 h — or its activity cannot be read. A folder at or above the
 * worktrees' root (an app session in "/" or the home) holds none of them. */
export function folderInUse(path: string, input: { used: readonly string[]; processCwds: readonly string[] | null; activity: number | null; now: number; root: string; home: string; sessionOf?: (path: string) => string | null }): string | null {
  const inside = (a: string, b: string) => a === b || a.startsWith(`${b}/`);
  const above = (each: string) => each === "/" || each === input.home || inside(input.root, each);
  const session = input.sessionOf?.(path);
  if (session) return `sessão «${session}» nela`;
  if (input.used.filter((each) => !above(each)).some((each) => inside(each, path) || inside(path, each))) return "uma conversa ou sessão trabalha nela";
  if (input.processCwds === null) return "não consegui ler os processos vivos";
  if (input.processCwds.filter((each) => !above(each)).some((each) => inside(each, path))) return "há um processo vivo dentro dela";
  if (input.activity === null) return "não consegui medir a última mudança";
  if (input.now - input.activity < 24 * 3_600_000) return "mudou nas últimas 24 h";
  return null;
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

/** In a key, after the folders: those offered for removal. */
const CLEAN_MARK = "|limpas:";
/** The folders an item asks about, from its key. */
export const keyFolders = (key: string) => key.slice(DISK_DECISION_KEY_PREFIX.length).split(CLEAN_MARK)[0]!.split(",");

/** An open item checked again on the Mac (each routine run, and when the
 * owner picks a removal): kept when nothing changed; replaced by what holds
 * now when a folder came into use or is no longer clean ({A,B} → {A} once B
 * is used, R2-1); closed, with why, when none is left to decide. `fresh` is
 * diskDecisionItem over the item's own folders with the facts read now. */
export function diskDecisionRecheck(openKey: string, fresh: NonNullable<ReturnType<typeof diskDecisionItem>> | null, busy: string): { action: "keep" } | { action: "replace"; item: NonNullable<ReturnType<typeof diskDecisionItem>> } | { action: "close"; note: string } {
  if (!fresh) return { action: "close", note: `nenhuma pasta sobrou para decidir: ${busy || "todas em uso"}` };
  return fresh.key === openKey ? { action: "keep" } : { action: "replace", item: fresh };
}

/** Why the folders are in use, for a closing note: "B (sessão «x» nela)". */
export function busyNote(folders: readonly string[], facts: ReadonlyMap<string, FolderFacts>): string {
  return folders.map((name) => [name, facts.get(name)?.inUse ?? (facts.has(name) ? null : "não conferida")] as const).filter(([, why]) => why).map(([name, why]) => `${name} (${why})`).join("; ");
}

/** An open item's folders with the sizes its steps said ("Veja X (3,0G; …)"). */
export function openItemFolders(item: { key?: string; steps?: ReadonlyArray<{ text: string }> }): LeftFolder[] {
  if (!item.key?.startsWith(DISK_DECISION_KEY_PREFIX)) return [];
  return keyFolders(item.key).map((name) => {
    const size = item.steps?.map((step) => new RegExp(`^Veja ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(([^;]+);`).exec(step.text)?.[1]).find(Boolean);
    return { name, size: size ?? "?", reason: "do item aberto" };
  });
}

/** What to do with a new list: open (or refresh) its item, and which other
 * disk items it replaces. Nothing when an open item already asks about all
 * of these folders (13:38 asked about 8204 and 9052, already in 11:38's), or
 * when the OWNER settled them less than a week ago — they resolved it, or
 * the bot did after the owner answered it. An item the server replaced with
 * a newer list was decided by nobody (INSP-R12F F2). */
export function diskDecisionPlan(
  key: string,
  open: ReadonlyArray<{ key?: string }>,
  settled: ReadonlyArray<{ key?: string; resolvedAt: number; resolvedBy?: string; history?: readonly unknown[] }>,
  now: number,
): { add: boolean; replace: string[] } {
  const names = keyFolders(key);
  const covers = (other: string) => names.every((name) => keyFolders(other).includes(name));
  const disk = (each: { key?: string }): each is { key: string } => Boolean(each.key?.startsWith(DISK_DECISION_KEY_PREFIX));
  const byOwner = (each: { resolvedBy?: string; history?: readonly unknown[] }) => each.resolvedBy === "owner" || (each.resolvedBy === "bot" && Boolean(each.history?.length));
  if (settled.some((each) => disk(each) && byOwner(each) && covers(each.key) && now - each.resolvedAt < DISK_DECISION_SETTLED_MS)) return { add: false, replace: [] };
  const openDisk = open.filter(disk);
  // an open item asking about more folders keeps them (it is checked again on its own); the same folders with other offers are replaced
  const same = (other: string) => keyFolders(other).length === names.length && covers(other);
  if (openDisk.some((each) => each.key !== key && covers(each.key) && !same(each.key))) return { add: false, replace: [] };
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

/** A path as one shell word (as nested-worktrees.ts quotes its commands). */
const shellQuote = (value: string) => (/^[\w./@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** One folder's state, in words ("commits em nenhuma branch remota, segredos ignorados: .dev.vars"). */
export function folderState(fact: FolderFacts): string {
  const said = [
    fact.dirty === true ? "alterações não commitadas" : fact.dirty === null ? "estado do git desconhecido" : "",
    fact.unpushed === true ? "commits em nenhuma branch remota" : fact.unpushed === null ? "push desconhecido" : "",
    fact.secrets?.length ? `segredos ignorados: ${fact.secrets.join(", ")}` : "",
    fact.ignored?.length ? `arquivos ignorados que só existem aqui: ${fact.ignored.slice(0, 4).join(", ")}${fact.ignored.length > 4 ? ", …" : ""}` : "",
  ].filter(Boolean);
  return said.length ? said.join(", ") : "limpa e no GitHub";
}

/** What the Chief reads under any answer to a disk item (an option or free
 * text): each folder as the server found it just now, and to check again
 * before removing — the turn may run minutes later (INSP-R12F r3 R3-2). */
export function diskStateLine(folders: readonly string[], facts: ReadonlyMap<string, FolderFacts>, at: number): string {
  const when = new Date(at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const each = folders.map((name) => {
    const fact = facts.get(name);
    return `${name}: ${!fact ? "não conferida" : fact.inUse ? `em uso (${fact.inUse})` : folderState(fact)}`;
  });
  return `[Servidor: conferido no Mac em ${when} — ${each.join("; ")}. Reconfira no Mac antes de remover qualquer pasta: o estado pode mudar até você executar. Segredos ignorados são apagados pela remoção; copie-os antes.]`;
}

const RECHECK ="Antes de remover qualquer uma, reconfira que nenhuma tem sessão, processo vivo dentro ou mudança nas últimas 24 h; pule as que tiverem e me diga quais.";

/** The one item for the owner, keyed by the folders it asks about. Folders
 * in use stay out of it (said in its why, "não mexer"); one with work only on
 * this Mac (changes, commits on no remote branch, or git could not tell) is
 * offered only "Push e remover"; only a folder proved clean and pushed is
 * offered for removal, and never with --force (INSP-R12F F1). Null when no
 * folder is left to decide. */
export function diskDecisionItem(folders: readonly LeftFolder[], facts: ReadonlyMap<string, FolderFacts>, root: string, text: string): {
  key: string;
  title: string;
  why: string;
  steps: Array<{ text: string; command?: string }>;
  options: Array<{ label: string; reply: string; recommended?: true; why?: string }>;
} | null {
  const busy = folders.flatMap((folder) => {
    const reason = facts.get(folder.name)?.inUse ?? (facts.has(folder.name) ? null : "não conferida");
    return reason ? [{ ...folder, busy: reason }] : [];
  });
  const asked = folders.filter((folder) => !busy.some((each) => each.name === folder.name));
  if (!asked.length) return null;
  const clean = asked.filter((folder) => facts.get(folder.name)?.dirty === false && facts.get(folder.name)?.unpushed === false && !facts.get(folder.name)?.ignored?.length && !facts.get(folder.name)?.secrets?.length);
  const pending = asked.filter((folder) => !clean.includes(folder));
  const names = asked.map((folder) => folder.name).sort();
  const total = totalSize(asked);
  const free = /\*{0,2}(\d+(?:,\d+)?) GiB livres/i.exec(text)?.[1];
  const path = (name: string) => shellQuote(`${root}/${name}`);
  const words = (list: readonly LeftFolder[]) => list.map((folder) => folder.name).sort().join(" ");
  const shown = asked.slice(0, STEPS_FOLDERS_MAX);
  const what = (folder: LeftFolder) => folderState(facts.get(folder.name)!);
  // what a removal loses that git does not keep: named in every option that removes (INSP-R12F r3 R3-1)
  const copyFirst = (list: readonly LeftFolder[]) => {
    const secrets = list.flatMap((folder) => (facts.get(folder.name)?.secrets ?? []).map((each) => `${folder.name}/${each}`));
    const others = list.flatMap((folder) => (facts.get(folder.name)?.ignored ?? []).map((each) => `${folder.name}/${each}`));
    return [
      secrets.length ? `Antes de remover, copie para fora e me confirme estes segredos ignorados, que a remoção apaga: ${secrets.join(", ")}.` : "",
      others.length ? `Também só existem nela e somem com a remoção: ${others.slice(0, 6).join(", ")}${others.length > 6 ? ", …" : ""}.` : "",
    ].filter(Boolean).join(" ");
  };
  const removing = (list: readonly LeftFolder[]) => [copyFirst(list), RECHECK].filter(Boolean).join(" ");
  const kept = busy.length ? ` Não mexer (fora deste item): ${busy.map((each) => `${each.name} (${each.busy})`).join("; ")}.` : "";
  return {
    // the folders, and which are offered for removal: a change in either is another item (INSP-R12F r2 R2-1)
    key: `${DISK_DECISION_KEY_PREFIX}${names.join(",")}${clean.length ? `${CLEAN_MARK}${words(clean).replace(/ /g, ",")}` : ""}`,
    title: `Decidir o destino de ${asked.length} worktree${asked.length === 1 ? "" : "s"} parada${asked.length === 1 ? "" : "s"} (${total}): ${names.join(", ")}`.slice(0, 200),
    why: `A rotina de disco não pode removê-las sozinha. Juntas ocupam ${total}${free ? `; o disco está com ${free} GiB livres e o release exige 8` : ""}.${pending.length ? ` ${pending.length} ${pending.length === 1 ? "tem" : "têm"} trabalho que só existe neste Mac.` : ""}${kept}`.slice(0, 400),
    steps: [
      { text: RECHECK },
      ...shown.map((folder) => ({
        text: `Veja ${folder.name} (${folder.size}; ${what(folder)})`.slice(0, 300),
        command: `git -C ${path(folder.name)} status --short && git -C ${path(folder.name)} log --oneline origin/main..HEAD`,
      })),
      ...(asked.length > shown.length ? [{ text: `E mais ${asked.length - shown.length}: ${names.filter((name) => !shown.some((folder) => folder.name === name)).join(", ")}`.slice(0, 300) }] : []),
    ].slice(0, 8),
    options: [
      ...(clean.length ? [{ label: "Remover as limpas", reply: `Remova as worktrees ${words(clean)} com git worktree remove, sem --force. ${removing(clean)}` }] : []),
      ...(pending.length ? [{ label: "Push e remover", reply: `Para as worktrees ${words(pending)}: faça push da branch de cada uma (sem force). Se houver alterações não commitadas, pare e me mostre; não descarte nada. Só com o push confirmado no GitHub, remova sem --force. ${removing(pending)}` }] : []),
      // as long as the server holds a settled list (DISK_DECISION_SETTLED_MS): it says so (INSP-R12F F7)
      { label: "Manter por 7 dias", reply: `Mantenha as worktrees ${words(asked)} e não as remova. Elas só voltam a ser perguntadas daqui a 7 dias, se ainda estiverem no disco.` },
    ],
  };
}
