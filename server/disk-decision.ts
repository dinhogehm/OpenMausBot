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
// manualmente" (11:38), "Posso conferir isso PR por PR e remover…" (13:38);
// "a remoção fica com você. Se quiser apagá-las:" (06/10 23:10, R13-followup #4)
const ASKS = /para voc[eê] decidir|decis[aã]o sua|sua decis[aã]o|sua escolha|sua autoriza[cç][aã]o|cabe a voc[eê]|algu[eé]m (?:pode|precisa) remov|manualmente|precisa(?:m)? de voc[eê]|posso (?:conferir|remover|apagar)|quer que eu (?:remova|apague)|(?:remo[cç][aã]o|decis[aã]o) fica com voc[eê]|se quiser (?:apag|remov)/i;

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
  // a removal command left to the owner names its folder, table or not ("Se quiser apagá-las:
  // git … worktree remove …/9032-…", 06/10 23:10): its size is measured on the Mac (R13-followup #4)
  for (const name of commandFolders(text, folders)) if (!chosen.some((folder) => folder.name === name)) chosen.push({ name, size: "?", reason: "comando de remoção deixado no texto" });
  return chosen.filter((folder) => !notForOwner(folder.reason));
}

/** The folders a `git … worktree remove <path>` in the text points to. */
export function commandFolders(text: string, folders: readonly string[]): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/worktree\s+remove\s+(?:--force\s+|-f\s+)*['"`]?([^\s'"`]+)/g)) {
    const name = resolveFolder(match[1]!.replace(/\/+$/, "").split("/").at(-1) ?? "", folders);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** A bot's own "Precisa de você" item about removing worktrees (06/10: the
 * Chief kept o28, "Decidir o destino de 15 worktrees paradas", by itself,
 * and the server's check never ran — R13-followup #2): what it is about, by
 * its content (worktree paths, "worktree remove", removing or deciding the
 * fate of worktrees), and the folders it names with what it says of each —
 * size and words, so "em uso agora (lsof)" or "Sessão ativa (manter)" keeps
 * a folder out whatever the Mac says. Empty when it is not such an item. */
export function botDiskItemFolders(input: { title: string; why?: string; command?: string; steps?: ReadonlyArray<{ text: string; command?: string }>; options?: ReadonlyArray<{ label: string; reply: string }> }, folders: readonly string[]): LeftFolder[] {
  const lines = [input.title, input.why ?? "", input.command ?? "", ...(input.steps ?? []).flatMap((step) => [step.text, step.command ?? ""]), ...(input.options ?? []).flatMap((option) => [option.label, option.reply])].filter(Boolean);
  const all = lines.join("\n");
  const about = /worktree\s+remove|\.claude\/worktrees\/|\.worktrees\//i.test(all) || (/\bworktrees?\b/i.test(all) && /remov|apag|descart|destino|limp|liber/i.test(all));
  if (!about) return [];
  const out = new Map<string, LeftFolder>();
  for (const line of lines) {
    // "Sessão ativa (manter): A 2,8G limpa; B 2,7G limpa" — the head is said of every folder after it
    const head = /^([^:;]{3,80}):\s/.exec(line)?.[1] ?? "";
    for (const segment of line.split(/;|\n/)) {
      // a folder's name has a hyphen: "#9378" or "2,2G" never names one
      for (const match of segment.matchAll(/[A-Za-z0-9][\w.…-]{2,}/g)) {
        if (!match[0].includes("-")) continue;
        const name = resolveFolder(match[0], folders);
        if (!name) continue;
        const size = /(\d+(?:,\d+)?\s?[KMGT])\b/.exec(segment.slice(match.index! + match[0].length))?.[1] ?? "";
        const said = `${head && !segment.startsWith(head) ? `${head}: ` : ""}${segment}`.replace(/\s+/g, " ").trim();
        const known = out.get(name);
        if (!known) out.set(name, { name, size: size.replace(/\s+/g, "") || "?", reason: said });
        else if (known.size === "?" && size) known.size = size.replace(/\s+/g, "");
        // what the item says against removing it, wherever it says it
        if (known && botKeeps(said) && !botKeeps(known.reason)) known.reason = said;
      }
    }
  }
  return [...out.values()];
}

/** The bot's own words keep a folder: a session on it, in use, or "manter". */
const botKeeps = (said: string) => {
  // "sem sessão ativa" (9337-…-2f6a57 on o28) is the opposite
  const plain = said.replace(/\b(?:sem|fora de|nenhuma)\s+sess[aã]o\s+(?:ativa|que est[aá])/gi, "");
  return notForOwner(plain) || /\bmanter\b|\blsof\b/i.test(plain);
};

/** The facts, with a folder the bot itself said is in use or to keep held
 * as in use — the Mac may not see what the bot saw (o28: "keen-agnesi: em
 * uso agora (lsof)"; "hook-v2-4" under "Sessão ativa (manter)"). */
export function withBotKeeps(folders: readonly LeftFolder[], facts: ReadonlyMap<string, FolderFacts>): Map<string, FolderFacts> {
  const out = new Map(facts);
  for (const folder of folders) {
    const fact = out.get(folder.name);
    if (!fact || fact.inUse || !botKeeps(folder.reason)) continue;
    out.set(folder.name, { ...fact, inUse: `o próprio item dizia: «${folder.reason.slice(0, 90)}»` });
  }
  return out;
}

/** A size from `du -sk`, as a routine writes it ("2,2G", "263M", "8K"). */
export function duSize(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1).replace(".", ",")}G`;
  if (kb >= 1024) return `${Math.round(kb / 1024)}M`;
  return `${kb}K`;
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

// Secrets, by name: never junk, wherever they are (INSP-R12F r3 R3-1, r4
// R4-3): a file by its name, or anything inside a secrets folder.
const SECRET_FILE = /(?:^|\/)(?:\.dev\.vars[^/]*|\.env(?!\.example$|\.sample$|\.template$)(?:\.[^/]*)?|\.envrc|[^/]*\.(?:pem|key|p8|p12|pfx|jks|keystore|tfvars)|credentials[^/]*|secrets?\.[a-z]+|token[^/]*\.json|[^/]*service[-_]account[^/]*\.json|id_(?:rsa|ed25519|ecdsa)[^/]*|\.npmrc|\.netrc|\.pgpass|settings\.local\.json[^/]*)$/i;
const SECRET_DIR = /(?:^|\/)(?:\.?secrets|\.aws|\.gcloud|\.ssh|\.gnupg)(?:\/|$)/i;
const isSecret = (path: string) => SECRET_FILE.test(path) || SECRET_DIR.test(path);

// What an ignored path may be without being anyone's work. When in doubt it
// is NOT junk (INSP-R12F r4). Junk is what an install, a build or a test
// run makes again — the set nested-worktrees.ts calls disposable — and what
// the nuria tools regenerate, read off the real worktrees on 05/10:
// smart-deploy's .deploy-history/ and .deploy-*, graft's graft/ and .ignore,
// husky's .husky/_/, lighthouse's reports, the widget's _generated bundle.
// Never junk: .worktrees/ and .claude/ (a nested worktree lives there, and
// removing the parent deletes it, R4-1), .claude/ itself (settings.local.json
// and the like differ per worktree, R4-2), .audit-out/ (inspection work, R4-4),
// .wrangler/ (a local D1 may hold data made by hand), out/ and target/.
const JUNK = new RegExp([
  "(?:^|/)(?:node_modules|\\.pnpm-store|dist|build|\\.next|\\.turbo|\\.vite|\\.cache|coverage|playwright-report|test-results|blob-report|\\.local-ci|\\.deploy-cache|\\.lighthouse|_generated)(?:/|$)",
  "^(?:\\.deploy-history|graft)(?:/|$)",
  "^\\.husky/_(?:/|$)",
  "^(?:\\.deploy-metrics\\.json|\\.deploy-report\\.[a-z]+|\\.ignore)$",
  "(?:^|/)(?:\\.DS_Store|\\.eslintcache)$",
  "\\.(?:log|tsbuildinfo)$",
].join("|"));
/** Nothing under a folder of worktrees is junk: a worktree is never build output. */
const NEVER_JUNK = /(?:^|\/)\.?worktrees(?:\/|$)/;

/** Past this many files listed inside one folder, the rest are counted. */
const EXPAND_MAX = 40;

/** The files below `dir`, relative to it ("hooks/a.cjs"), for porcelainState:
 * at most `max` and `depth` levels; a folder of worktrees is named, never
 * walked (its worktrees are judged as worktrees). Null when unreadable. */
export function filesBelow(dir: string, readdir: (dir: string) => Array<{ name: string; dir: boolean }>, max = 2_000, depth = 6, visitMax = 20_000): { files: string[]; truncated: boolean } | null {
  let truncated = false;
  // first, the secrets by name, over a larger walk: a .dev.vars is never past the cap (INSP-R12F r5 #2)
  const secrets: string[] = [];
  let visited = 0;
  const seek = (at: string, prefix: string, level: number): boolean => {
    let entries: Array<{ name: string; dir: boolean }>;
    try { entries = readdir(at); } catch { return level > 0; }
    for (const entry of entries) {
      if (++visited > visitMax) { truncated = true; return true; }
      const rel = `${prefix}${entry.name}`;
      if (isSecret(entry.dir ? `${rel}/` : rel)) { secrets.push(entry.dir ? `${rel}/` : rel); continue; }
      if (!entry.dir || /^\.?worktrees$/.test(entry.name) || JUNK.test(rel)) continue;
      if (level + 1 >= depth) { truncated = true; continue; }
      seek(`${at}/${entry.name}`, `${rel}/`, level + 1);
    }
    return true;
  };
  if (!seek(dir, "", 0)) return null;
  const out: string[] = [...secrets];
  const taken = new Set(secrets);
  const walk = (at: string, prefix: string, level: number): void => {
    let entries: Array<{ name: string; dir: boolean }>;
    // a level's own files first
    try { entries = [...readdir(at)].sort((a, b) => Number(a.dir) - Number(b.dir)); } catch { return; }
    for (const entry of entries) {
      if (out.length >= max) { truncated = true; return; }
      const rel = `${prefix}${entry.name}`;
      if (taken.has(rel) || taken.has(`${rel}/`)) continue;
      if (!entry.dir) { out.push(rel); continue; }
      if (/^\.?worktrees$/.test(entry.name) || level + 1 >= depth) { out.push(`${rel}/`); continue; }
      walk(`${at}/${entry.name}`, `${rel}/`, level + 1);
    }
  };
  walk(dir, "", 0);
  return { files: out, truncated };
}

/** Said, as a secret, of a folder the walk could not finish. */
export const NOT_WALKED = "(não percorrida inteira: pode haver mais segredos não listados; confira a pasta inteira antes de remover)";

/** From `git status --porcelain --ignored`: whether anything is changed or
 * untracked; the ignored secrets; and the other ignored paths that are not
 * junk — they exist only on this Mac, and removing the folder loses them
 * (INSP-R12F r2 R2-2, r3 R3-1). git folds an ignored folder into one line
 * ("!! .claude/"): such a folder that is not junk is listed file by file
 * (`list`, relative paths below it), so a settings.local.json inside is
 * seen as a secret and the rest by name (r4 R4-2). */
export function porcelainState(output: string, list?: (dir: string) => string[] | { files: string[]; truncated: boolean } | null): { dirty: boolean; ignored: string[]; secrets: string[] } {
  const lines = output.split("\n").filter((line) => line.trim());
  const folded = lines.filter((line) => line.startsWith("!! ")).map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
  const junk = (path: string) => !NEVER_JUNK.test(path) && JUNK.test(path);
  const cut: string[] = [];
  const paths = folded.flatMap((path) => {
    // a folder of worktrees is named, never walked: its worktrees are judged as worktrees
    if (!path.endsWith("/") || isSecret(path) || junk(path.replace(/\/$/, "")) || NEVER_JUNK.test(path) || !list) return [path];
    const listed = list(path.replace(/\/$/, ""));
    const inside = Array.isArray(listed) ? listed : listed?.files;
    if (!inside?.length) return [path];
    // a walk cut at its limit is said, as a secret: there may be more (INSP-R12F r5 #2)
    if (!Array.isArray(listed) && listed?.truncated) cut.push(`${path}… ${NOT_WALKED}`);
    // every secret is kept; past EXPAND_MAX the other files of this folder are counted
    const all = inside.map((each) => `${path}${each}`);
    const others = all.filter((each) => !isSecret(each.replace(/\/$/, "")) && !junk(each.replace(/\/$/, "")));
    const shown = new Set(others.slice(0, EXPAND_MAX));
    return [
      ...all.filter((each) => isSecret(each.replace(/\/$/, "")) || shown.has(each)),
      ...(others.length > EXPAND_MAX ? [`${path}… (+${others.length - EXPAND_MAX})`] : []),
    ];
  });
  const bare = (path: string) => path.replace(/\/$/, "");
  const secrets = [...paths.filter((path) => isSecret(bare(path))), ...cut];
  const ignored = paths.filter((path) => !isSecret(bare(path)) && !junk(bare(path)));
  return { dirty: lines.some((line) => !line.startsWith("!! ")), ignored, secrets };
}

/** A folder is in use when a session or an agent's conversation works in it
 * (or inside it), a live process has its cwd there, or it changed in the
 * last 24 h — or its activity cannot be read. A folder at or above the
 * worktrees' root (an app session in "/" or the home) holds none of them. */
export function folderInUse(path: string, input: { used: readonly string[]; processCwds: readonly string[] | null; activity: number | null; now: number; root: string; home: string; sessionOf?: (path: string) => string | null; nested?: readonly string[] | null; registered?: boolean }): string | null {
  const inside = (a: string, b: string) => a === b || a.startsWith(`${b}/`);
  const above = (each: string) => each === "/" || each === input.home || inside(input.root, each);
  // removing a parent deletes a worktree inside it, uncommitted work and all (nested-worktrees.ts, INSP-R12F r4 R4-1)
  if (input.nested === null) return "não consegui ler as worktrees do repositório";
  // not a worktree of the repository (a stray folder): git would answer for the checkout above it
  if (input.registered === false) return "não é uma worktree do repositório";
  if (input.nested?.length) return `contém a worktree aninhada ${input.nested.map((each) => each.slice(path.length + 1)).join(", ")}`;
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

/** How the server settles an item it replaced with what holds now. */
export const DISK_REPLACED_NOTE = "atualizado: conferido de novo no Mac";

/** An answered item that the pass before already settled: replaced (by
 * DISK_REPLACED_NOTE) or closed, with that pass's own words (INSP-R12F r5 #1). */
export function goneDiskItem(resolvedNote: string | undefined): { outcome: "replace" | "close"; line: string; note?: string } {
  return resolvedNote === DISK_REPLACED_NOTE ? { outcome: "replace", line: "" } : { outcome: "close", line: "", note: resolvedNote ?? "fechado por outra conferência no Mac" };
}

/** The 409 the person reads when an answer finds its disk item changed: a
 * replaced item has a new one to answer; a closed one has nothing left to answer. */
export function diskChangedText(check: { outcome: "replace" | "close" | "keep"; note?: string }): string {
  return check.outcome === "replace"
    ? "Conferi agora no Mac: alguma pasta passou a ser usada ou não está mais limpa. O item foi trocado por um novo, com o que vale agora; responda nele."
    : `Este item foi fechado: ${check.note ?? "nenhuma das pastas pode ser removida agora"}. Não há mais o que responder nele.`;
}

/** The label of the decision that keeps the folders. */
export const DISK_KEEP_LABEL = "Manter por 7 dias";

/** An answer that only keeps the folders ("Manter por 7 dias"): nothing to check on the Mac before it. */
export function keepsFolders(answer: { kind: string; label?: string }): boolean {
  return answer.kind === "option" && answer.label === DISK_KEEP_LABEL;
}

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

/** What the bot may remove after the owner's answer to a disk item, and
 * nothing else (R13-followup #2: on 06/10 18:53 "Pode remover todos" had the
 * Chief run `git worktree remove --force` on 10 folders, among them one the
 * item said was in use and one under "manter"). The folders free now — of
 * the option's own folders when the answer is a decision — with what each
 * loses; those with secrets only once copied; every other folder forbidden,
 * naming the ones the item kept out. */
export function diskAllowedLine(folders: readonly string[], facts: ReadonlyMap<string, FolderFacts>, answer: { kind: string; text?: string }, kept: string): string {
  const scope = answer.kind === "option" && answer.text ? folders.filter((name) => answer.text!.includes(name)) : [...folders];
  const free = scope.filter((name) => facts.get(name) && !facts.get(name)!.inUse);
  const plain = free.filter((name) => !facts.get(name)!.secrets?.length);
  const secret = free.filter((name) => facts.get(name)!.secrets?.length);
  const loses = (name: string) => {
    const fact = facts.get(name)!;
    const lost = [fact.dirty !== false ? "alterações não commitadas ou estado desconhecido" : "", fact.unpushed !== false ? "commits que não estão no GitHub" : ""].filter(Boolean);
    return lost.length ? `${name} (a remoção perde: ${lost.join(" e ")})` : name;
  };
  // a decision says how (push first, never discard); only the owner's own words for the whole list allow --force on known changes
  const forced = answer.kind === "option" ? [] : plain.filter((name) => facts.get(name)!.dirty !== false);
  return [
    plain.length ? `[Servidor: o dono autorizou remover agora, e só estas: ${plain.map(loses).join("; ")}.` : "[Servidor: nenhuma pasta deste item pode ser removida com esta resposta.",
    secret.length ? `Só depois de copiar os segredos para fora e o dono confirmar a cópia: ${secret.map((name) => `${name} (${facts.get(name)!.secrets!.join(", ")})`).join("; ")}.` : "",
    `PROIBIDO remover qualquer pasta fora desta lista${kept ? `, inclusive as que o item manteve: ${kept}` : ""}; um «todos» vale só para a lista.`,
    forced.length ? `--force só em ${forced.join(", ")}, as que têm alteração conhecida e o dono autorizou; nas outras, sem --force.` : "Sem --force.",
    "Antes de cada remoção, reconfira lsof e segredos na hora; se mudou, pare e me diga.]",
  ].filter(Boolean).join(" ");
}

/** The folders an item kept out, as its why says them ("Não mexer (fora deste item): A (…); B (…)."). */
export function keptOutOf(why: string | undefined): string {
  return /Não mexer \(fora deste item\): (.+?)(?:\.(?:\s|$)|$)/.exec(why ?? "")?.[1] ?? "";
}

const RECHECK ="Antes de remover qualquer uma, reconfira que nenhuma tem sessão, processo vivo dentro ou mudança nas últimas 24 h; pule as que tiverem e me diga quais.";

/** The one item for the owner, keyed by the folders it asks about. Folders
 * in use stay out of it (said in its why, "não mexer"); one with work only on
 * this Mac (changes, commits on no remote branch, or git could not tell) is
 * offered only "Push e remover"; only a folder proved clean and pushed is
 * offered for removal, and never with --force (INSP-R12F F1). Null when no
 * folder is left to decide. */
export function diskDecisionItem(folders: readonly LeftFolder[], facts: ReadonlyMap<string, FolderFacts>, root: string, text: string, opts: { who?: string; kept?: string } = {}): {
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
  // what an item checked again had kept out stays said: the folders the bot itself held, above all (R13-followup #2)
  const before = (opts.kept ? opts.kept.split("; ") : []).filter((entry) => !folders.some((folder) => entry.startsWith(`${folder.name} (`)));
  const keptList = [...busy.map((each) => `${each.name} (${each.busy})`), ...before];
  const kept = keptList.length ? ` Não mexer (fora deste item): ${keptList.join("; ")}.` : "";
  // a "todos" never covers a folder with secrets: they are copied first (R13-followup #2)
  const withSecrets = asked.filter((folder) => facts.get(folder.name)?.secrets?.length);
  const secretNote = withSecrets.length ? ` Não mexer sem copiar antes os segredos: ${withSecrets.map((folder) => `${folder.name} (${facts.get(folder.name)!.secrets!.slice(0, 3).join(", ")})`).join("; ")}.` : "";
  return {
    // the folders, and which are offered for removal: a change in either is another item (INSP-R12F r2 R2-1)
    key: `${DISK_DECISION_KEY_PREFIX}${names.join(",")}${clean.length ? `${CLEAN_MARK}${words(clean).replace(/ /g, ",")}` : ""}`,
    title: `Decidir o destino de ${asked.length} worktree${asked.length === 1 ? "" : "s"} parada${asked.length === 1 ? "" : "s"} (${total}): ${names.join(", ")}`.slice(0, 200),
    why: `${opts.who ?? "A rotina de disco não pode removê-las sozinha."} Juntas ocupam ${total}${free ? `; o disco está com ${free} GiB livres e o release exige 8` : ""}.${pending.length ? ` ${pending.length} ${pending.length === 1 ? "tem" : "têm"} trabalho que só existe neste Mac.` : ""}${kept}${secretNote}`.slice(0, 1_500),
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
      { label: DISK_KEEP_LABEL, reply: `Mantenha as worktrees ${words(asked)} e não as remova. Elas só voltam a ser perguntadas daqui a 7 dias, se ainda estiverem no disco.` },
    ],
  };
}

/** A bot's reply that leaves worktrees to the owner ("a remoção fica com
 * você. Se quiser apagá-las:" and the commands, 06/10 23:10): an item, as a
 * disk routine's run would open (R13-followup #4). */
export function replyLeavesDiskToOwner(text: string): boolean {
  return /\bworktrees?\b/i.test(text) && asksOwnerToDecide(text);
}
