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

export interface OwnerOrder {
  threadId: string;
  at: number;
  text: string;
  /** For a channel order: the conversation it names, when the caller
   * resolved it (a short id like "dbb9f1cf" against all the bot's
   * conversations); else resolved here against the ones on record. */
  channelThreadId?: string;
  /** That conversation's title, when the caller knows it. */
  channelTitle?: string;
}

/** The one conversation the person wants to be spoken to in. */
export interface OwnerThread { threadId: string; title: string; at: number }

interface BotState { threads: ThreadState[]; orders: OwnerOrder[]; ownerThread?: OwnerThread }

/** A person's message that sets a rule rather than asks for one task. */
export function isOwnerOrder(text: string): boolean {
  return isOwnerChannelOrder(text) || /\b(n[ãa]o (?:rode|fa[çc]a|mexa|use|envie|mande|publique|mergeie|arquive|abra)|nunca|sempre|pare\b|parar\b|PARAR|proibido|regra|a partir de agora|de agora em diante|daqui pra frente|at[ée] segunda ordem|s[óo] (?:com|depois|quando))/i.test(text);
}

// ── the owner's channel order ────────────────────────────────────────────
// How the owner really says it (01/10 09:49, dbb9f1cf): "a partir de agora
// esta conversa (dbb9f1cf) é o único canal comigo. Não fale comigo na
// 6477b3f4 nem na ade82a65". The build of 21:05 knew only "use/fale … só …
// conversa/aqui", missed that order, and the Chief's desk fell to wherever
// the owner had written last (R9-followup #1). Accented words have no \b
// around them in JS regexes: the edges are spelled out.
const EDGE_BEFORE = "(?<![\\p{L}\\p{N}])";
const EDGE_AFTER = "(?![\\p{L}\\p{N}])";
const word = (alternatives: string) => `${EDGE_BEFORE}(?:${alternatives})${EDGE_AFTER}`;
/** A conversation as people name it: its id's first 8 hex characters, or the whole id. */
const THREAD_REF = "[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?";
const THREAD_REF_IN = new RegExp(`${EDGE_BEFORE}(${THREAD_REF})${EDGE_AFTER}`, "giu");
// Every form must have the OWNER as the one spoken to, in the same clause
// ("comigo", "me …", "com você", "com o dono"): "Mande só o link da PR
// aqui", "Fique só aqui esperando o CI", "Use só a conversa do Monitor para
// os alertas" and "o único canal de atendimento do cliente" are requests or
// facts, not where the owner is spoken to (INSP-H r1 #2).
const ONLY = new RegExp(word("s[óo]|somente|apenas|exclusivamente"), "iu");
const PLACE = new RegExp(`${word("aqui|daqui|conversa|thread|neste chat")}|${EDGE_BEFORE}${THREAD_REF}${EDGE_AFTER}`, "iu");
const SPEAK = "fale|falem|fala|falar|converse|conversem|conversar|escreva|escrevam|escrever|use|usa|usem|usar|mande|mandem|mandar|avise|avisem|avisar|chame|chamar|procure|procurar|responda|responder|encontre|fique";
/** The owner as the one spoken to: "comigo", "com você", "com o dono", or "me" with a verb of speaking. */
const OWNER_ADDRESSED = new RegExp(`${word("comigo|com voc[êe]|com o dono")}|${word("me")}\\s+(?:${SPEAK})${EDGE_AFTER}|${EDGE_BEFORE}(?:${SPEAK})-me${EDGE_AFTER}`, "iu");
const SPEAKING = new RegExp(word(SPEAK), "iu");
/** This conversation, said of itself ("esta conversa", "aqui", "nesta"). */
const HERE = word("esta conversa|essa conversa|nesta conversa|nessa conversa|desta conversa|por esta|por aqui|aqui|nesta|nessa|neste chat");
/** "o único canal comigo", "a única conversa com o dono". */
const ONLY_CHANNEL = new RegExp(word("[úu]nico canal|canal [úu]nico|canal exclusivo|[úu]nica conversa|conversa [úu]nica"), "iu");
/** "esta conversa é o canal comigo", "a dbb9f1cf passa a ser o canal com o dono". */
const IS_THE_CHANNEL = new RegExp(`(?:${HERE}|${EDGE_BEFORE}${THREAD_REF}${EDGE_AFTER})[^,;]{0,30}${word("[ée]|ser[áa]|fica|passa a ser|vira")}\\s+(?:o|a|meu|minha)\\s+${word("canal|conversa")}`, "iu");
/** "Use só esta conversa." — the bare form, with nothing after but "para falar comigo". */
const BARE_HERE = /^(?:a partir de agora\s+|daqui (?:pra|para a) frente\s+)?(?:use|usa|usem)\s+(?:s[óo]|somente|apenas)\s+(?:esta|essa)\s+conversa(?:\s+para\s+(?:falar|conversar)\s+comigo)?[\s.!]*$/iu;
/** "Não fale comigo na 6477b3f4", "não me escreva nas outras conversas": the
 * owner spoken to, and a conversation named by its id or as the other ones —
 * "na thread do release, só quando terminar" is about timing, not the channel. */
const NEGATIVE = new RegExp(`${word("n[ãa]o|nunca|jamais")}\\s+(?:me\\s+(?:${SPEAK})|(?:${SPEAK})\\s+comigo)${EDGE_AFTER}\\s+(?:mais\\s+)?(?:nada\\s+)?(?:n[ao]s?|em|pel[ao]s?|por)\\s+(?:(?:outras?|antigas?)\\s+${word("conversas?|threads?")}|${word("conversas?|threads?")}\\s+(?:antigas?|anteriores)|${EDGE_BEFORE}${THREAD_REF}${EDGE_AFTER})`, "iu");

/** A clause that names where the owner is spoken to. */
function positiveClause(clause: string): boolean {
  if (/^\s*(?:n[ãa]o|nunca|jamais)(?![\p{L}])/iu.test(clause)) return false;
  if (BARE_HERE.test(clause)) return true;
  if (!OWNER_ADDRESSED.test(clause)) return false;
  if (ONLY_CHANNEL.test(clause) || IS_THE_CHANNEL.test(clause)) return true;
  return ONLY.test(clause) && PLACE.test(clause) && SPEAKING.test(clause);
}

/** The clauses of a message that set the owner's channel: `positive` ones
 * name where to speak to them, `negative` ones where not to. A question is
 * not an order. A clause ends at a sentence end, a ";" or a ","
 * ("Esse ticket é a única conversa com o cliente, comigo não"). */
function channelSentences(text: string): { positive: string[]; negative: string[] } {
  const sentences = text.replace(/<\/?pasted-text[^>]*>/g, " ").split(/(?<=[.!?\n])\s*/).map((sentence) => sentence.trim()).filter((sentence) => sentence && !sentence.endsWith("?"));
  const clauses = sentences.flatMap((sentence) => sentence.split(/;\s*|,\s+/)).map((clause) => clause.trim()).filter(Boolean);
  return {
    positive: clauses.filter(positiveClause),
    negative: clauses.filter((clause) => NEGATIVE.test(clause)),
  };
}

/** "Esta conversa (X) é o único canal comigo", "não fale comigo na X",
 * "fale comigo só aqui/nesta conversa", "use só esta conversa": the person
 * names the one conversation they are spoken to in. */
export function isOwnerChannelOrder(text: string): boolean {
  const { positive, negative } = channelSentences(text);
  return positive.length > 0 || negative.length > 0;
}

/** The conversation a channel order makes the owner's, given in `here`:
 * the one a positive sentence names by id (resolved by `resolve`, a short
 * id against the bot's conversations), else `here` when the sentence speaks
 * of itself or names nothing ("use só esta conversa"); an order that only
 * forbids others ("não fale comigo na 6477b3f4") makes `here` the one —
 * unless it forbids `here` itself. Null when it names a conversation that
 * cannot be resolved, or is no channel order. */
export function channelOrderTarget(text: string, here: string, resolve: (ref: string) => string | null): string | null {
  const { positive, negative } = channelSentences(text);
  // the conversations a sentence names, apart from those it rules out ("não na X", "nem na Y", "exceto X")
  const refsOf = (sentence: string) => {
    const allowed: string[] = [];
    const forbidden: string[] = [];
    for (const match of sentence.matchAll(THREAD_REF_IN)) {
      const before = sentence.slice(Math.max(0, match.index! - 30), match.index!);
      (/(?<![\p{L}])(?:n[ãa]o|nem|exceto|menos|fora)(?![\p{L}])[^.!?;]*$/iu.test(before) ? forbidden : allowed).push(match[1]!.toLowerCase());
    }
    return { allowed, forbidden };
  };
  const isHere = (ref: string) => here.toLowerCase().startsWith(ref) || ref.startsWith(here.toLowerCase());
  for (const sentence of positive) {
    const { allowed } = refsOf(sentence);
    if (!allowed.length) return here;
    const named = allowed.map((ref) => (isHere(ref) ? here : resolve(ref))).find((threadId): threadId is string => Boolean(threadId));
    if (named) return named;
    // "esta conversa (abc12345) é o canal": an id that does not resolve, said of itself
    if (new RegExp(HERE, "iu").test(sentence)) return here;
  }
  if (!negative.length) return null;
  return negative.some((sentence) => [...sentence.matchAll(THREAD_REF_IN)].some((match) => isHere(match[1]!.toLowerCase()))) ? null : here;
}

/** Words every channel order has one of: the history is read through them. */
export const CHANNEL_ORDER_WORDS = ["comigo", "canal", "conversa", "aqui", "thread"] as const;

/** The owner's newest channel order among `messages` (theirs only, any
 * order) and the conversation it makes theirs. Only the newest counts: an
 * older order is never revived because the newest names a conversation
 * that cannot be resolved (null then). */
export function lastChannelOrder(messages: ReadonlyArray<{ threadId: string; at: number; text: string }>, resolve: (ref: string) => string | null): { order: OwnerOrder; target: string } | null {
  const newest = [...messages].sort((a, b) => b.at - a.at).find((message) => isOwnerChannelOrder(message.text));
  if (!newest) return null;
  const target = channelOrderTarget(newest.text, newest.threadId, resolve);
  return target ? { order: { threadId: newest.threadId, at: newest.at, text: newest.text, channelThreadId: target }, target } : null;
}

/** A conversation named by the start of its id ("dbb9f1cf"): the one of
 * `threadIds` it opens, when exactly one does. */
export function threadByRef(threadIds: readonly string[], ref: string): string | null {
  const matches = threadIds.filter((threadId) => threadId.toLowerCase().startsWith(ref.toLowerCase()));
  return matches.length === 1 ? matches[0]! : null;
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
      this.keepOrder(state, order);
      // the channel is read from the whole message: the id it names may sit past the 240 kept
      const target = order.channelThreadId ?? (isOwnerChannelOrder(order.text) ? channelOrderTarget(order.text, order.threadId, (ref) => threadByRef(state.threads.map((known) => known.threadId), ref)) : null);
      if (target && (!state.ownerThread || state.ownerThread.at <= order.at)) {
        state.ownerThread = { threadId: target, title: thread.threadId === target ? thread.title : order.channelTitle ?? state.threads.find((known) => known.threadId === target)?.title ?? target.slice(0, 8), at: order.at };
      }
    }
    this.save(botId, now);
  }

  /** An order in the list, one line; a newer order on the same thing
   * replaces the older, wherever it was given. */
  private keepOrder(state: BotState, order: OwnerOrder): void {
    const text = oneLine(order.text.replace(/<\/?pasted-text[^>]*>/g, " "), 240);
    const topic = orderTopic(text);
    const older = state.orders.find((known) => known.text === text || orderTopic(known.text) === topic);
    if (older && older.at > order.at) return;
    state.orders = [{ threadId: order.threadId, at: order.at, text }, ...state.orders.filter((known) => known !== older && known.text !== text)].slice(0, ORDERS_MAX);
  }

  /** The owner's last channel order, read back from the history at boot
   * (an order given before this build, or older than the last turns a
   * record reads): `target` becomes the conversation with the owner unless
   * a newer one is already on record. The order joins the standing orders.
   * True when the conversation with the owner changed. */
  adoptChannelOrder(botId: string, order: OwnerOrder, target: { threadId: string; title: string }, now = Date.now()): boolean {
    const state = this.state(botId);
    if (state.ownerThread && state.ownerThread.at >= order.at) return false;
    this.keepOrder(state, order);
    const changed = state.ownerThread?.threadId !== target.threadId;
    state.ownerThread = { threadId: target.threadId, title: target.title, at: order.at };
    this.save(botId, now);
    return changed;
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
