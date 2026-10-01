// What a bot's conversations need to know about each other. Each finished
// turn leaves a short record for its conversation — the last decision, what
// is pending with the person, the person's standing orders — and every turn
// of the same bot, in any conversation, reads the others' records as one
// block of its system prompt ("Estado das suas outras conversas"). So an
// order the owner gave in one conversation ("não rode X") holds in all of
// them, and no conversation redoes or contradicts another. Deterministic:
// no model is involved in writing it. Kept per bot under
// <dataDir>/bots/<id>/shared-state.json, with a readable shared-state.md.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

/** The block in the prompt stays under this. */
export const SHARED_STATE_MAX_BYTES = 2_048;
const ORDERS_MAX = 8;
const THREADS_MAX = 12;

export interface ThreadState {
  threadId: string;
  title: string;
  at: number;
  /** First sentence of the bot's last reply there. */
  decision?: string;
  /** What that conversation waits on the person for. */
  pending?: string;
}

export interface OwnerOrder { threadId: string; at: number; text: string }

/** The one conversation the person wants to be spoken to in. */
export interface OwnerThread { threadId: string; title: string; at: number }

interface BotState { threads: ThreadState[]; orders: OwnerOrder[]; ownerThread?: OwnerThread }

/** A person's message that sets a rule rather than asks for one task. */
export function isOwnerOrder(text: string): boolean {
  return isOwnerChannelOrder(text) || /\b(n[ãa]o (?:rode|fa[çc]a|mexa|use|envie|mande|publique|mergeie|arquive|abra)|nunca|sempre|pare\b|parar\b|PARAR|proibido|regra|a partir de agora|de agora em diante|daqui pra frente|at[ée] segunda ordem|s[óo] (?:com|depois|quando))/i.test(text);
}

/** "Use só a conversa da esteira para falar comigo", "fale comigo só por aqui":
 * the person names the one conversation they are spoken to in. */
export function isOwnerChannelOrder(text: string): boolean {
  // accented words have no \b around them in JS regexes: spell the edges out
  const only = "(?<![\\p{L}])(?:s[óo]|somente|apenas)(?![\\p{L}])";
  return new RegExp(`(?<![\\p{L}])(?:use|usa|fale|falem|fala|escreva|me avise|me chame)(?![\\p{L}])[^.!?\\n]{0,40}${only}[^.!?\\n]{0,40}(?<![\\p{L}])(?:conversa|thread|aqui)(?![\\p{L}])|${only}\\s+(?:nesta|por esta|aqui|nessa)(?![\\p{L}])[^.!?\\n]{0,30}(?<![\\p{L}])(?:fale|falar|comigo)(?![\\p{L}])`, "iu").test(text);
}

/** What an order is about: the PRs/issues it names, else its first words.
 * A newer order on the same thing replaces the older one. */
export function orderTopic(text: string): string {
  const numbers = [...text.matchAll(/#(\d{2,6})\b/g)].map((match) => match[1]).sort();
  if (numbers.length) return `#${[...new Set(numbers)].join(",")}`;
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((word) => word.length > 2).slice(0, 4).join(" ");
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** Markdown marks out, "#9311" kept: only a heading's leading #s go. */
const plain = (text: string) => text.replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/[*_`>]+/g, "").replace(/\s+/g, " ").trim();

export function firstSentence(text: string, max = 160): string {
  const flat = plain(text);
  const end = flat.search(/[.!?](\s|$)/);
  return oneLine(end === -1 ? flat : flat.slice(0, end + 1), max);
}

/** The decision a reply records: its last sentence that says what was done
 * or decided ("mergeei", "vou", "fica", "decidi"…), else its first sentence
 * without a leading "Osvaldo," — never just a greeting. */
export function decisionOf(text: string, max = 200): string {
  const flat = plain(text);
  const sentences = flat.split(/(?<=[.!?])\s+/).filter(Boolean);
  const decided = sentences.filter((sentence) => /\b(decid\w*|vou\b|vamos\b|fica\b|ficou\b|fiz\b|feito|mergeei|mergeada|publiquei|publicad\w*|arquivei|abri\b|respondi|avisei|n[ãa]o vou|combinad\w*|aprovad\w*|cancelei|parei)\b/i.test(sentence)).at(-1);
  const chosen = (decided ?? sentences[0] ?? "").replace(/^[A-ZÀ-Ú][\wÀ-ú]+,\s+/, "");
  return oneLine(chosen, max);
}

export class SharedState {
  private readonly dir: string | null;
  private readonly bots = new Map<string, BotState>();

  // plain field assignment, not a parameter property (node type-stripping)
  constructor(dir: string | null) {
    this.dir = dir;
  }

  private state(botId: string): BotState {
    let state = this.bots.get(botId);
    if (!state) {
      state = { threads: [], orders: [] };
      if (this.dir) {
        try {
          const raw = JSON.parse(readFileSync(join(this.dir, botId, "shared-state.json"), "utf8")) as Partial<BotState>;
          state = { threads: Array.isArray(raw.threads) ? raw.threads : [], orders: Array.isArray(raw.orders) ? raw.orders : [], ...(raw.ownerThread?.threadId ? { ownerThread: raw.ownerThread } : {}) };
        } catch { /* first turn */ }
      }
      this.bots.set(botId, state);
    }
    return state;
  }

  /** A turn of `botId` in `thread` finished: its record, and any orders the person gave there. */
  record(botId: string, thread: ThreadState, orders: OwnerOrder[] = [], now = Date.now()): void {
    const state = this.state(botId);
    state.threads = [thread, ...state.threads.filter((known) => known.threadId !== thread.threadId)].slice(0, THREADS_MAX);
    for (const order of [...orders].sort((a, b) => a.at - b.at)) {
      const text = oneLine(order.text, 240);
      // a newer order on the same thing replaces the older, wherever it was given
      const topic = orderTopic(text);
      const older = state.orders.find((known) => known.text === text || orderTopic(known.text) === topic);
      if (older && older.at > order.at) continue;
      state.orders = [{ ...order, text }, ...state.orders.filter((known) => known !== older && known.text !== text)].slice(0, ORDERS_MAX);
      if (isOwnerChannelOrder(text) && (!state.ownerThread || state.ownerThread.at <= order.at)) {
        state.ownerThread = { threadId: order.threadId, title: thread.threadId === order.threadId ? thread.title : state.threads.find((known) => known.threadId === order.threadId)?.title ?? thread.title, at: order.at };
      }
    }
    this.save(botId, now);
  }

  /** The conversation the person wants to be spoken to in, if they named one. */
  ownerThread(botId: string): OwnerThread | null {
    return this.state(botId).ownerThread ?? null;
  }

  /** A conversation was deleted: its record goes, and it stops being the
   * conversation with the owner. True when it was that one (the caller
   * tells the owner where they are spoken to now). */
  forgetThread(botId: string, threadId: string): boolean {
    const state = this.state(botId);
    const before = state.threads.length;
    state.threads = state.threads.filter((known) => known.threadId !== threadId);
    const wasOwner = this.dropOwnerThread(state, threadId);
    if (state.threads.length !== before || wasOwner) this.save(botId, Date.now());
    return wasOwner;
  }

  /** The conversation with the owner was closed or archived (its record
   * stays): it is no longer where they are spoken to. True when it was. */
  forgetOwnerThread(botId: string, threadId: string): boolean {
    const state = this.state(botId);
    const wasOwner = this.dropOwnerThread(state, threadId);
    if (wasOwner) this.save(botId, Date.now());
    return wasOwner;
  }

  private dropOwnerThread(state: BotState, threadId: string): boolean {
    if (state.ownerThread?.threadId !== threadId) return false;
    delete state.ownerThread;
    return true;
  }

  /** The prompt block for a turn in `threadId`: the other conversations'
   * records and the person's orders (all of them), newest first, cut to
   * SHARED_STATE_MAX_BYTES. `work` lines (sessions, PRs) come from the caller;
   * `include`, when given, keeps only the conversations (and their orders) it accepts. */
  render(botId: string, threadId: string, now: number, work: string[] = [], include?: (threadId: string) => boolean): string {
    const state = this.state(botId);
    const others = state.threads.filter((known) => known.threadId !== threadId && (!include || include(known.threadId)));
    const orders = include ? state.orders.filter((order) => include(order.threadId)) : state.orders;
    const owner = state.ownerThread && (!include || include(state.ownerThread.threadId)) ? state.ownerThread : null;
    if (!others.length && !orders.length && !work.length && !owner) return "";
    const when = (at: number) => new Date(at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const newest = Math.max(0, ...others.map((known) => known.at), ...orders.map((order) => order.at));
    const head = `\n\nEstado das suas outras conversas (atualizado ${when(newest || now)}). The same bot speaks in all of them: what was decided or ordered in one holds in the others.\n`;
    const lines: string[] = [];
    if (owner) {
      lines.push(owner.threadId === threadId
        ? "Esta é a conversa com o dono: é aqui que você fala com ele (decisões, perguntas, avisos)."
        : `Conversa com o dono: "${oneLine(owner.title, 60)}" (definida por ele em ${when(owner.at)}). Não fale com o dono aqui: decisões, perguntas e avisos vão para lá; aqui, registre e siga — o servidor mostra lá o que você disser a ele aqui.`);
    }
    if (orders.length) {
      lines.push("Ordens do dono em vigor (valem em todas as conversas; quando duas se contradizem, vale a mais recente):");
      for (const order of orders) lines.push(`- ${order.text} (${when(order.at)})`);
    }
    if (work.length) {
      lines.push("Trabalho em andamento:");
      for (const line of work) lines.push(`- ${line}`);
    }
    if (others.length) {
      lines.push("Outras conversas:");
      for (const known of others) {
        lines.push(`- "${oneLine(known.title, 60)}" (${when(known.at)})${known.decision ? `: ${known.decision}` : ""}${known.pending ? ` — esperando o dono: ${known.pending}` : ""}`);
      }
    }
    let text = head;
    for (const line of lines) {
      if (Buffer.byteLength(text + line + "\n") > SHARED_STATE_MAX_BYTES) break;
      text += `${line}\n`;
    }
    return text;
  }

  private save(botId: string, now: number): void {
    if (!this.dir) return;
    const state = this.state(botId);
    const folder = join(this.dir, botId);
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileAtomic(join(folder, "shared-state.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      writeFileAtomic(join(folder, "shared-state.md"), this.render(botId, "", now).trimStart(), { mode: 0o600 });
    } catch (error) {
      console.error(`[shared-state] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
