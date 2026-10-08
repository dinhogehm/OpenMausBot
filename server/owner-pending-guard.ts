// Two items for the same row of the sheet, from two bots (R13-intake #1).
// On 05/10 20:57Z the Chief opened o2, "Aprovar a criação da linha 190…",
// with five `gog sheets update 'Atendimento!B190'…` commands for the owner's
// terminal. On 06/10 13:08Z the client herself typed her request in row 190;
// at 13:10Z the Monitor rewrote ITS item o1: "Os comandos antigos para a
// linha 190 apagariam a linha dela: não rode esses." The Chief's o2 kept
// offering them; the owner ran them at ~14:00Z and her row was gone for 9 h.
//
// Now: (1) a bot that says, in its own item, that another item's COMMANDS
// must not run — citing its id, or the row they write — marks that sibling
// item superseded: its decisions and commands are off, and it says by which
// item of which bot. Never a server's item, and the owner can lift the mark.
// (2) An item whose commands write a fixed row of the sheet
// (`Atendimento!X190`) says, after 6 h, that the row may have changed — and,
// when the server could read the row, what it holds now. The command is
// never rewritten.

/** Words that say commands must not run, or are wrong, old or superseded.
 * Approvals and order ("não aprove a #N antes do QA") are not about commands
 * (INSP-R13fol #14). Accented letters count as letters. */
const SUPERSEDES = /(?<![\p{L}])(?:n[aã]o\s+(?:rode|execute|cole)|obsolet[oa]s?|substitu[ií]d[oa]s?|superad[oa]s?|comandos?\s+(?:antigos?|velhos?)|est[aã]o\s+errad[oa]s|s[aã]o\s+errad[oa]s|apagariam|sobrescreveriam)(?![\p{L}])/iu;
/** The sentence speaks of commands (or steps): needed when the target is a row or an issue. */
const COMMANDS = /(?<![\p{L}])(?:comandos?|passos?)(?![\p{L}])/iu;
/** What comes after "substituída por/pela" is the NEW thing, never a target ("Fechar a PR #9332 (substituída pela #9371)"). */
const REPLACEMENT = /substitu[ií]d[oa]s?\s+(?:por|pel[oa]s?)\s+(?:a\s+|o\s+)?(?:PR\s+|issue\s+|item\s+)?(?:#\d{3,6}|o\d{1,4}|linha\s+\d{1,5})/giu;

/** What a superseding sentence points at. */
export interface SupersedeRefs {
  ids: string[];
  rows: number[];
  issues: number[];
  /** A bot named in it ("o2 do Chief"), by its first name, lowercased. */
  bots: string[];
  /** The sentence itself, for the notice. */
  text: string;
}

/** The sentences of an item (title, why, steps) that say another item's
 * commands must not run, with what they point at (INSP-R13fol #14): an id
 * "oN"; a row, when the sentence speaks of commands; an issue only as
 * "comandos da #N". Nothing after "substituída por/pela". */
export function supersedeRefs(item: { title: string; why?: string; steps?: ReadonlyArray<{ text: string }> }, botNames: readonly string[] = []): SupersedeRefs[] {
  const texts = [item.title, item.why ?? "", ...(item.steps ?? []).map((step) => step.text)];
  const out: SupersedeRefs[] = [];
  for (const text of texts) {
    // a sentence ends at . ! ? — not at ":" ("…apagariam a linha dela: não rode esses.")
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if (!SUPERSEDES.test(sentence)) continue;
      const target = sentence.replace(REPLACEMENT, " ");
      const commands = COMMANDS.test(target);
      const ids = [...target.matchAll(/(?<![\p{L}\p{N}])(o\d{1,4})(?![\p{L}\p{N}])/gu)].map((match) => match[1]!);
      const rows = commands ? [...new Set([...target.matchAll(/(?<![\p{L}])linhas?\s+(\d{1,5})(?!\d)/giu), ...target.matchAll(/![A-Z]{1,3}(\d{1,5})(?!\d)/g)].map((match) => Number(match[1])))] : [];
      const issues = [...new Set([...target.matchAll(/comandos?\s+(?:da|do|de|para\s+a|para\s+o)\s+(?:PR\s+|issue\s+)?#(\d{3,6})(?!\d)/giu)].map((match) => Number(match[1])))];
      const bots = botNames.map((name) => name.split(/\s+/)[0]!.toLowerCase()).filter((first) => first && new RegExp(`(?<![\\p{L}])${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").test(sentence));
      if (ids.length || rows.length || issues.length) out.push({ ids, rows, issues, bots, text: sentence.trim().slice(0, 240) });
    }
  }
  return out;
}

/** One cell range a command writes in a sheet, by its fixed row. */
export interface RowWrite {
  sheetId: string;
  tab: string;
  row: number;
  /** Column letter → the value the command writes there ("" when it clears or is unknown). */
  cells: Record<string, string>;
  account?: string;
}

const colIndex = (letters: string) => [...letters.toUpperCase()].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
const colLetters = (index: number): string => (index < 26 ? String.fromCharCode(65 + index) : colLetters(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26)));

/** The fixed rows a `gog sheets update|clear` command writes ("'Atendimento!B190:C190' --values-json '[["Matheus","Osvaldo"]]'"),
 * a tab with spaces quoted ("'Base de Dados!B5'", INSP-R13fol #17). An append never has a fixed row. */
export function rowWrites(command: string): RowWrite[] {
  const match = /\bgog\b.*?\bsheets\s+(update|clear)\s+['"]?([\w-]{20,})['"]?\s+(?:'([^'!]+)!|"([^"!]+)!|([^\s'"!]+)!)\$?([A-Z]{1,3})\$?(\d{1,5})(?::\$?([A-Z]{1,3})\$?(\d{1,5}))?/.exec(command);
  if (!match) return [];
  const [, action, sheetId, quoted, doubled, bare, fromCol, fromRow, toCol, toRow] = match;
  const tab = (quoted ?? doubled ?? bare)!;
  const first = Number(fromRow);
  const last = toRow ? Number(toRow) : first;
  let values: unknown[][] = [];
  const json = /--values-json[= ]'((?:[^'\\]|\\.)*)'/.exec(command)?.[1];
  if (action === "update" && json) { try { const parsed = JSON.parse(json); if (Array.isArray(parsed)) values = parsed.map((row) => (Array.isArray(row) ? row : [row])); } catch { /* unknown values */ } }
  const account = /--account[= ]['"]?([^\s'"]+)/.exec(command)?.[1];
  const start = colIndex(fromCol!);
  const end = toCol ? colIndex(toCol) : start;
  const out: RowWrite[] = [];
  for (let row = first; row <= last && row - first < 50; row++) {
    const cells: Record<string, string> = {};
    for (let col = start; col <= end; col++) {
      const value = values[row - first]?.[col - start];
      cells[colLetters(col)] = value === undefined || value === null ? "" : String(value);
    }
    out.push({ sheetId: sheetId!, tab, row, cells, ...(account ? { account } : {}) });
  }
  return out;
}

/** Every fixed row an item's commands write. */
export function itemRowWrites(item: { command?: string; steps?: ReadonlyArray<{ command?: string }> }): RowWrite[] {
  return [item.command ?? "", ...(item.steps ?? []).map((step) => step.command ?? "")].flatMap((command) => (command ? rowWrites(command) : []));
}

/** Each row an item writes, once, with every cell its commands write there. */
export function itemRows(item: { command?: string; steps?: ReadonlyArray<{ command?: string }> }): RowWrite[] {
  const rows = new Map<string, RowWrite>();
  for (const write of itemRowWrites(item)) {
    const key = `${write.sheetId}\u0000${write.tab}\u0000${write.row}`;
    const known = rows.get(key);
    if (known) Object.assign(known.cells, write.cells);
    else rows.set(key, { ...write, cells: { ...write.cells } });
  }
  return [...rows.values()];
}

/** Past this, a fixed row in an item's commands may be someone else's by now. */
export const FIXED_ROW_STALE_MS = 6 * 3_600_000;

/** What the server read of one row, kept on the item. */
export interface RowCheck {
  at: number;
  tab: string;
  row: number;
  /** "desconhecida": the read failed or could not be understood — never taken as empty (INSP-R13fol #12). */
  verdict: "vazia" | "igual" | "parcial" | "ocupada" | "desconhecida";
  /** In "ocupada": what the cells the commands write hold now ("B «Marluce»"). */
  holds?: string[];
}

/** The row as read now against what the commands write: empty where they
 * write, already those values, or holding something else they would overwrite. */
export function rowVerdict(write: RowWrite, cells: readonly string[]): "vazia" | "igual" | "parcial" | { verdict: "ocupada"; holds: string[] } {
  const now = (col: string) => (cells[colIndex(col)] ?? "").trim();
  const cols = Object.keys(write.cells);
  if (cols.every((col) => !now(col))) return "vazia";
  if (cols.every((col) => now(col) === write.cells[col]!.trim())) return "igual";
  const holds = cols.filter((col) => now(col) && now(col) !== write.cells[col]!.trim()).map((col) => `${col} «${now(col).replace(/\s+/g, " ").slice(0, 60)}»`);
  // some of its values there already, the rest empty: nothing would be overwritten
  return holds.length ? { verdict: "ocupada", holds } : "parcial";
}

/** The rows of `gog sheets get <id> '<tab>!A<from>:Z<to>' --json`, from
 * column A: `{"range": "Atendimento!A120:K120", "values": [[…]]}` (the real
 * output of gog v0.9.0, server/fixtures). A row past the last filled one, or
 * an empty range (no "values"), is empty — as the Sheets API says it. Null
 * when the output is not that: the row was not read (INSP-R13fol #12; the
 * `--plain` output aligns columns with spaces and splits a cell's line
 * breaks, and cannot be read back). */
export function jsonRows(output: string, from: number, to: number): Map<number, string[]> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { range?: unknown }).range !== "string") return null;
  const values = (parsed as { values?: unknown }).values;
  if (values !== undefined && (!Array.isArray(values) || values.some((row) => !Array.isArray(row)))) return null;
  const rows = new Map<number, string[]>();
  for (let row = from; row <= to; row++) {
    const cells = (values as unknown[][] | undefined)?.[row - from] ?? [];
    rows.set(row, cells.map((cell) => (cell === null || cell === undefined ? "" : String(cell))));
  }
  return rows;
}

/** The notice of an item with fixed-row sheet commands older than 6 h
 * (since it was written or last rewritten), with what the server read of
 * each row when it could; null when it has none or is recent. */
export function fixedRowWarning(item: { createdAt: number; updatedAt?: number; command?: string; steps?: ReadonlyArray<{ command?: string }>; rowChecks?: readonly RowCheck[] }, now: number): string | null {
  const writes = itemRows(item);
  if (!writes.length) return null;
  const since = item.updatedAt ?? item.createdAt;
  if (now - since <= FIXED_ROW_STALE_MS) return null;
  const rows = [...new Set(writes.map((write) => write.row))];
  const head = `${rows.length === 1 ? `A linha ${rows[0]}` : `As linhas ${rows.join(", ")}`} pode${rows.length === 1 ? "" : "m"} ter mudado desde que estes comandos foram escritos: confira antes de rodar.`;
  const read = rows.flatMap((row) => {
    const check = item.rowChecks?.find((each) => each.row === row);
    if (!check) return [];
    const when = new Date(check.at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
    if (check.verdict === "desconhecida") return [`Às ${when} não consegui conferir a linha ${row}.`];
    const said = check.verdict === "vazia" ? "está vazia onde os comandos escrevem"
      : check.verdict === "igual" ? "já tem esses valores; não precisa rodar de novo"
      : check.verdict === "parcial" ? "já tem parte desses valores e o resto vazio; nada seria sobrescrito"
      : `já tem ${check.holds?.join(", ") || "outro conteúdo"}: os comandos sobrescreveriam isso`;
    return [`Lida às ${when}: a linha ${row} ${said}.`];
  });
  return [head, ...read].join(" ");
}

/** How a superseded item reads: by which item of which bot, and why. */
export interface Superseded {
  botId: string;
  botName: string;
  id: string;
  at: number;
  text: string;
}

/** The open items a bot's item supersedes (INSP-R13fol #13, #14, #17): never
 * itself, never a server's item (one with a key: the disk, power, release,
 * the app, a routine's ask); another item named by id — of the same bot, or
 * of the bot the sentence names — or whose commands write the row named.
 * Only items older than the statement, not already superseded by it. */
export function supersededItems<T extends { botId: string; id: string; title: string; key?: string; link?: string; createdAt: number; command?: string; steps?: ReadonlyArray<{ text: string; command?: string }>; supersededBy?: { botId: string; id: string } }>(
  by: { botId: string; id: string; at: number },
  refs: readonly SupersedeRefs[],
  open: readonly T[],
  botFirstName: (botId: string) => string,
): Array<{ item: T; text: string }> {
  const out: Array<{ item: T; text: string }> = [];
  for (const item of open) {
    if (item.key || (item.botId === by.botId && item.id === by.id)) continue;
    if (item.createdAt > by.at || (item.supersededBy?.botId === by.botId && item.supersededBy.id === by.id)) continue;
    const commands = [item.command ?? "", ...(item.steps ?? []).map((step) => step.command ?? "")].filter(Boolean);
    const rows = new Set(itemRowWrites(item).map((write) => write.row));
    const about = `${item.title} ${item.link ?? ""}`;
    const owner = botFirstName(item.botId).toLowerCase();
    const ref = refs.find((each) =>
      // an id: the bot the sentence names, or — none named — the bot that says it (its own name counts too)
      (each.ids.includes(item.id) && (each.bots.length ? each.bots.includes(owner) : item.botId === by.botId))
      || each.rows.some((row) => rows.has(row))
      || (commands.length > 0 && each.issues.some((issue) => new RegExp(`#${issue}(?!\\d)|/(?:issues|pull)/${issue}(?!\\d)`).test(about))));
    if (ref) out.push({ item, text: ref.text });
  }
  return out;
}

/** The notice on a superseded item. */
export function supersededLine(superseded: Superseded): string {
  return `Superado pelo item ${superseded.id} do ${superseded.botName}: «${superseded.text}». Não rode os comandos deste item; veja o ${superseded.id}.`;
}

/** When to read a row again after a failed read: 1 min, doubling, at most 30
 * min (INSP-R13fol #15: a failing gog was asked every 10 s); a good read
 * waits 30 min. One log line per change of state. */
export const ROW_CHECK_EVERY_MS = 30 * 60_000;
const ROW_CHECK_FIRST_RETRY_MS = 60_000;

export class RowCheckBackoff {
  private state = new Map<string, { nextAt: number; failures: number; ok: boolean | null }>();

  /** May the row of this item be read now? */
  due(key: string, now: number): boolean {
    return (this.state.get(key)?.nextAt ?? 0) <= now;
  }

  /** A read ended: when the next one may be, and the log line when the state changed (else null). */
  done(key: string, now: number, ok: boolean, why = ""): string | null {
    const before = this.state.get(key);
    const failures = ok ? 0 : (before?.failures ?? 0) + 1;
    const wait = ok ? ROW_CHECK_EVERY_MS : Math.min(ROW_CHECK_EVERY_MS, ROW_CHECK_FIRST_RETRY_MS * 2 ** (failures - 1));
    this.state.set(key, { nextAt: now + wait, failures, ok });
    if (before?.ok === ok) return null;
    return ok ? `[owner-pending] ${key}: the row is read again` : `[owner-pending] ${key}: the row could not be read (${why || "gog failed"}); next try in ${Math.round(wait / 60_000)} min, at most every 30 min`;
  }

  /** Forget items no longer open. */
  keep(keys: ReadonlySet<string>): void {
    for (const key of [...this.state.keys()]) if (!keys.has(key)) this.state.delete(key);
  }
}

type RowItem = { botId: string; id: string; createdAt: number; updatedAt?: number; supersededBy?: unknown; command?: string; steps?: ReadonlyArray<{ command?: string }> };

/** One pass over the open items whose commands write fixed rows older than
 * 6 h: each sheet tab read once (`gog sheets get … --json`, every row the
 * item writes), as the backoff allows. A failed or unreadable read is
 * "desconhecida" for its rows, never "vazia" (INSP-R13fol #12, #15, #17). */
export async function checkItemRows(items: readonly RowItem[], deps: {
  now: number;
  backoff: RowCheckBackoff;
  /** Runs gog with these arguments: its stdout, or null with why it failed. */
  gog: (args: string[]) => Promise<{ out: string | null; error?: string }>;
  save: (item: RowItem, checks: RowCheck[]) => void;
  log: (line: string) => void;
}): Promise<void> {
  const open = new Set<string>();
  for (const item of items) {
    const key = `${item.botId}/${item.id}`;
    open.add(key);
    if (item.supersededBy || deps.now - (item.updatedAt ?? item.createdAt) <= FIXED_ROW_STALE_MS || !deps.backoff.due(key, deps.now)) continue;
    const rows = itemRows(item);
    if (!rows.length) continue;
    const checks: RowCheck[] = [];
    let failed = "";
    // one read per sheet and tab, from the first row to the last the item writes
    const groups = new Map<string, RowWrite[]>();
    for (const row of rows) groups.set(`${row.sheetId}\u0000${row.tab}`, [...(groups.get(`${row.sheetId}\u0000${row.tab}`) ?? []), row]);
    for (const group of groups.values()) {
      const from = Math.min(...group.map((each) => each.row));
      const to = Math.max(...group.map((each) => each.row));
      const account = group.find((each) => each.account)?.account;
      const result = await deps.gog(["sheets", "get", group[0]!.sheetId, `${group[0]!.tab}!A${from}:Z${to}`, "--json", "--no-input", ...(account ? ["--account", account] : [])]);
      const read = result.out === null ? null : jsonRows(result.out, from, to);
      if (!read) failed = result.error ?? "saída do gog ilegível";
      for (const write of group) {
        const cells = read?.get(write.row);
        const verdict = cells ? rowVerdict(write, cells) : "desconhecida";
        checks.push(typeof verdict === "string" ? { at: deps.now, tab: write.tab, row: write.row, verdict } : { at: deps.now, tab: write.tab, row: write.row, ...verdict });
      }
    }
    deps.save(item, checks);
    const line = deps.backoff.done(key, deps.now, !failed, failed);
    if (line) deps.log(line);
    for (const check of checks) if (check.verdict === "ocupada") deps.log(`[owner-pending] ${key}: row ${check.row} of ${check.tab} holds ${check.holds?.join(", ")} — its commands would overwrite it`);
  }
  deps.backoff.keep(open);
}
