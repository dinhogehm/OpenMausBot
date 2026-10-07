// Two items for the same row of the sheet, from two bots (R13-intake #1).
// On 05/10 20:57Z the Chief opened o2, "Aprovar a criação da linha 190…",
// with five `gog sheets update 'Atendimento!B190'…` commands for the owner's
// terminal. On 06/10 13:08Z the client herself typed her request in row 190;
// at 13:10Z the Monitor rewrote ITS item o1: "Os comandos antigos para a
// linha 190 apagariam a linha dela: não rode esses." The Chief's o2 kept
// offering them; the owner ran them at ~14:00Z and her row was gone for 9 h.
//
// Now: (1) a bot that says, in its own item, that another item's commands
// are wrong or superseded — citing its id or what it is about (the row, the
// issue) — marks that sibling item superseded: its decisions and commands are
// off, and it says by which item of which bot. (2) An item whose commands
// write a fixed row of the sheet (`Atendimento!X190`) says, after 6 h, that
// the row may have changed — and, when the server could read the row, what
// it holds now. The command is never rewritten.

/** Words that say another item's commands must not run. */
const SUPERSEDES = /n[aã]o rode|n[aã]o (?:execute|aprove|use|cole)\b|obsolet[oa]s?\b|substitu[ií]d[oa]s?\s+(?:por|pel[oa])|superad[oa]s?\b|comandos?\s+(?:antigos?|velhos?)|est[aã]o\s+errad[oa]s|apagariam|sobrescreveriam/i;

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
 * commands must not run, with what they point at; none when no sentence
 * both says so and names an id, a row or an issue. */
export function supersedeRefs(item: { title: string; why?: string; steps?: ReadonlyArray<{ text: string }> }, botNames: readonly string[] = []): SupersedeRefs[] {
  const texts = [item.title, item.why ?? "", ...(item.steps ?? []).map((step) => step.text)];
  const out: SupersedeRefs[] = [];
  for (const text of texts) {
    // a sentence ends at . ! ? — not at ":" ("…apagariam a linha dela: não rode esses.")
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if (!SUPERSEDES.test(sentence)) continue;
      const ids = [...sentence.matchAll(/\b(o\d{1,4})\b/g)].map((match) => match[1]!);
      const rows = [...new Set([...sentence.matchAll(/\blinhas?\s+(\d{1,5})\b/gi), ...sentence.matchAll(/![A-Z]{1,3}(\d{1,5})\b/g)].map((match) => Number(match[1])))];
      const issues = [...new Set([...sentence.matchAll(/#(\d{3,6})\b/g)].map((match) => Number(match[1])))];
      const bots = botNames.map((name) => name.split(/\s+/)[0]!.toLowerCase()).filter((first) => first && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(sentence));
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

/** The fixed rows a `gog sheets update|clear` command writes ("'Atendimento!B190:C190' --values-json '[["Matheus","Osvaldo"]]'"). An append never has a fixed row. */
export function rowWrites(command: string): RowWrite[] {
  const match = /\bgog\b.*?\bsheets\s+(update|clear)\s+['"]?([\w-]{20,})['"]?\s+['"]?([^'"!\s]+)!\$?([A-Z]{1,3})\$?(\d{1,5})(?::\$?([A-Z]{1,3})\$?(\d{1,5}))?['"]?/.exec(command);
  if (!match) return [];
  const [, action, sheetId, tab, fromCol, fromRow, toCol, toRow] = match;
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
    out.push({ sheetId: sheetId!, tab: tab!, row, cells, ...(account ? { account } : {}) });
  }
  return out;
}

/** Every fixed row an item's commands write. */
export function itemRowWrites(item: { command?: string; steps?: ReadonlyArray<{ command?: string }> }): RowWrite[] {
  return [item.command ?? "", ...(item.steps ?? []).map((step) => step.command ?? "")].flatMap((command) => (command ? rowWrites(command) : []));
}

/** Past this, a fixed row in an item's commands may be someone else's by now. */
export const FIXED_ROW_STALE_MS = 6 * 3_600_000;

/** What the server read of a row, kept on the item. */
export interface RowCheck {
  at: number;
  tab: string;
  row: number;
  verdict: "vazia" | "igual" | "ocupada";
  /** In "ocupada": what the cells the commands write hold now ("B «Marluce»"). */
  holds?: string[];
}

/** The row as read now against what the commands write: empty where they
 * write, already those values, or holding something else they would overwrite. */
export function rowVerdict(write: RowWrite, cells: readonly string[]): RowCheck["verdict"] | { verdict: "ocupada"; holds: string[] } {
  const now = (col: string) => (cells[colIndex(col)] ?? "").trim();
  const cols = Object.keys(write.cells);
  if (cols.every((col) => !now(col))) return "vazia";
  if (cols.every((col) => now(col) === write.cells[col]!.trim())) return "igual";
  return { verdict: "ocupada", holds: cols.filter((col) => now(col) && now(col) !== write.cells[col]!.trim()).map((col) => `${col} «${now(col).slice(0, 60)}»`) };
}

/** The first line of `gog sheets get … --plain` (TSV): the row's cells from column A. */
export function plainRowCells(output: string): string[] {
  const line = output.split("\n").find((each) => each.length) ?? "";
  return line.split("\t");
}

/** The notice of an item with fixed-row sheet commands older than 6 h
 * (since it was written or last rewritten), with what the server read of
 * the row when it could; null when it has none or is recent. */
export function fixedRowWarning(item: { createdAt: number; updatedAt?: number; command?: string; steps?: ReadonlyArray<{ command?: string }>; rowCheck?: RowCheck }, now: number): string | null {
  const writes = itemRowWrites(item);
  if (!writes.length) return null;
  const since = item.updatedAt ?? item.createdAt;
  if (now - since <= FIXED_ROW_STALE_MS) return null;
  const rows = [...new Set(writes.map((write) => write.row))];
  const head = `${rows.length === 1 ? `A linha ${rows[0]}` : `As linhas ${rows.join(", ")}`} pode${rows.length === 1 ? "" : "m"} ter mudado desde que estes comandos foram escritos: confira antes de rodar.`;
  const check = item.rowCheck && rows.includes(item.rowCheck.row) ? item.rowCheck : null;
  if (!check) return head;
  const when = new Date(check.at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const said = check.verdict === "vazia" ? "está vazia onde os comandos escrevem"
    : check.verdict === "igual" ? "já tem esses valores; não precisa rodar de novo"
    : `já tem ${check.holds?.join(", ") || "outro conteúdo"}: os comandos sobrescreveriam isso`;
  return `${head} Lida às ${when}: a linha ${check.row} ${said}.`;
}

/** How a superseded item reads: by which item of which bot, and why. */
export interface Superseded {
  botId: string;
  botName: string;
  id: string;
  at: number;
  text: string;
}

/** The open items a bot's item supersedes: never itself; another item named
 * by id (of the same bot, or of the bot the sentence names), or with commands
 * on the row it names, or about the issue it names while carrying commands.
 * Only items older than the statement, not already superseded by it. */
export function supersededItems<T extends { botId: string; id: string; title: string; link?: string; createdAt: number; command?: string; steps?: ReadonlyArray<{ text: string; command?: string }>; supersededBy?: { botId: string; id: string } }>(
  by: { botId: string; id: string; at: number },
  refs: readonly SupersedeRefs[],
  open: readonly T[],
  botFirstName: (botId: string) => string,
): Array<{ item: T; text: string }> {
  const out: Array<{ item: T; text: string }> = [];
  for (const item of open) {
    if (item.botId === by.botId && item.id === by.id) continue;
    if (item.createdAt > by.at || (item.supersededBy?.botId === by.botId && item.supersededBy.id === by.id)) continue;
    const commands = [item.command ?? "", ...(item.steps ?? []).map((step) => step.command ?? "")].filter(Boolean);
    const rows = new Set(itemRowWrites(item).map((write) => write.row));
    const about = `${item.title} ${item.link ?? ""}`;
    const ref = refs.find((each) =>
      each.ids.includes(item.id) && (item.botId === by.botId ? !each.bots.length : each.bots.includes(botFirstName(item.botId).toLowerCase()))
      || each.rows.some((row) => rows.has(row))
      || (commands.length > 0 && each.issues.some((issue) => new RegExp(`#${issue}\\b|/(?:issues|pull)/${issue}\\b`).test(about))));
    if (ref) out.push({ item, text: ref.text });
  }
  return out;
}

/** The notice on a superseded item. */
export function supersededLine(superseded: Superseded): string {
  return `Superado pelo ${superseded.id} do ${superseded.botName}: «${superseded.text}». Não rode os comandos deste item; veja o ${superseded.id}.`;
}
