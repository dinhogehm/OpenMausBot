// A routine that ends saying something waits on the owner ("A conversa do
// widget continua com você: às 8:39 você disse que ia falar direto com o
// Luis Rossi.") reached nobody: "Precisa de você" skips a routine's run, and
// the bare-question promotion skips it too (R12-visual N22: the Monitor said
// it at 09:00 of 05/10 and nothing showed it). The owner decided it counts.
// The server reads the run's reply with the same detector as a conversation
// (asksOwnerSentence: by clause, never under a denial), and opens ONE item
// per subject — the person, issue or conversation the sentence names — keyed
// by it: the hourly repetition refreshes that item (same id, no new
// notification). It closes when the owner answers it, or when the bot says
// it is resolved; never by silence.
import { asksOwnerSentence, echoAsk, ownerAskText, type OwnerPending, type OwnerPendingOption, type OwnerPendingStep, type ResolvedOwnerPending } from "./bot-autonomy.ts";

export const ROUTINE_ASK_KEY_PREFIX = "routine-ask:";
/** An item the owner answered is not reopened by a routine repeating itself for this long (the bot may not have read the answer yet). */
export const ROUTINE_ASK_SETTLED_MS = 24 * 3_600_000;
export const ROUTINE_ASK_RESOLVED_NOTE = "o bot disse que resolveu";

/** One thing a routine's reply leaves with the owner. */
export interface RoutineAsk {
  /** The sentence, as the bot wrote it (with the items of its list, when it ends in ":"). */
  sentence: string;
  /** What is left with the owner, without the ask that leads it ("Uma decisão fica com você: se…" → "se…"), when the sentence says it after a colon. */
  what?: string;
  /** The ask leads with a decision ("decisão", "decidir"). */
  decide: boolean;
  /** What it is about: a person, an issue, a ticket, a conversation, else the words. */
  subject: { kind: "pessoa" | "issue" | "ticket" | "conversa" | "frase"; id: string; label: string };
  /** The person as the bot named them, with the article it used ("o", "a"), for the title. */
  person?: { name: string; article: "o" | "a" | null };
  /** The conversation it names ("widget"), shown in the title. */
  context?: string;
  link?: string;
}

export interface RoutineAskContext {
  /** The owner's first name ("Osvaldo"): "aguardando o Osvaldo" asks too. */
  ownerName?: string | null;
  /** Bot names: never a person the ask is about. */
  knownNames?: readonly string[];
  /** Ids (and aliases) of the bot's open items: a sentence that only points at one is an echo. */
  itemIds?: readonly string[];
}

const strip = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");
const slug = (text: string) => strip(text).toLowerCase().replace(/[^a-z0-9#]+/g, "-").replace(/^-+|-+$/g, "");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Capitalized words that are not people: tools, places, the app's own words. */
const NOT_PEOPLE = new Set(["chat", "chief", "staff", "github", "nuria", "claude", "google", "gmail", "slack", "precisa", "monitor", "atendimento", "helpdesk", "planilha", "widget", "mac", "app", "pr", "issue", "issues", "você", "voce", "bot", "sheets", "drive", "brt", "codex", "openmausbot", "omb", "space", "meet", "whatsapp"]);
const STOP_WORDS = new Set(["para", "pela", "pelo", "como", "mais", "ainda", "esta", "essa", "este", "esse", "isso", "isto", "voce", "você", "sobre", "quando", "depois", "antes", "porque", "entre", "fica", "continua", "preciso", "precisa", "decisao", "decisão", "sua", "seu", "suas", "seus", "dela", "dele", "aqui", "agora", "hoje", "também", "tambem", "nada", "tudo", "cada", "qual", "quais", "duas", "dois", "coisas", "coisa", "depende", "aguardando", "aguardo", "esperando", "disse", "foram", "seria", "está", "estao", "estão", "isso"]);

/** The sentences of a reply: a quote ("…", “…”, «…», a "> " line) and code are not the bot speaking, so they never ask. */
function sentencesOf(text: string): string[] {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~]+/g, "");
  return plain.split(/(?<=[.!?…])\s+|\n+/).map((each) => each.trim()).filter((each) => /\p{L}{3}/u.test(each));
}
/** The sentence with quoted speech blanked: an ask inside quotes is someone else's words. */
const unquoted = (sentence: string) => sentence.replace(/["“«„][^"”»“]{0,400}["”»]/g, "«…»");

/** The owner by name asks too ("aguardando o Osvaldo", "fica com o Osvaldo", "depende do Osvaldo"). */
function ownerByName(name: string | null | undefined): { asks: RegExp; denies: RegExp } | null {
  const first = name?.trim().split(/\s+/)[0];
  if (!first) return null;
  const who = `(?:(?:pel|d)?[oa]\\s+)?${escape(first)}(?![\\p{L}])`;
  return {
    asks: new RegExp(`(?<![\\p{L}])(?:(?:aguard|esper)\\p{L}*\\s+(?:por\\s+)?${who}|depende(?:m)?\\s+${who}|(?:continua|fica|est[áa])(?:m)?\\s+com\\s+${who}|decis[ãa]o\\s+d[oa]\\s+${escape(first)}(?![\\p{L}]))`, "iu"),
    denies: new RegExp(`(?<![\\p{L}])n[ãa]o\\s+(?:depende|precisa|requer|exige|pede|est[áa]\\s+(?:aguardando|esperando)|aguarda|espera)(?![\\p{L}])[^.!?]*?${escape(first)}(?![\\p{L}])`, "iu"),
  };
}

const PERSON = /(?<![\p{L}])(com|ao|à|para|pra|pelo|pela|do|da|o|a)\s+(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){0,2})(?![\p{L}])/gu;
function personIn(sentence: string, exclude: ReadonlySet<string>): RoutineAsk["person"] | undefined {
  for (const match of sentence.matchAll(PERSON)) {
    const words = match[2]!.split(/\s+/);
    // a name stops at the first word that is not one ("Luis Rossi Hoje" → "Luis Rossi")
    const kept: string[] = [];
    for (const word of words) {
      if (NOT_PEOPLE.has(word.toLowerCase()) || exclude.has(word.toLowerCase())) break;
      kept.push(word);
    }
    if (!kept.length) continue;
    const article = ["o", "ao", "pelo", "do"].includes(match[1]!) ? "o" : ["a", "à", "pela", "da"].includes(match[1]!) ? "a" : null;
    return { name: kept.join(" "), article };
  }
  return undefined;
}

/** Content words two texts share, `except` (a name) aside. */
function sharedWords(a: string, b: string, except: readonly string[] = []): number {
  const two = contentWords(b);
  return [...contentWords(a)].filter((word) => two.has(word) && !except.includes(word)).length;
}
const contentWords = (text: string) => new Set(strip(text).toLowerCase().split(/[^a-z0-9#]+/).filter((word) => word.length >= 4 && !STOP_WORDS.has(word)));
function overlap(a: string, b: string): number {
  const one = contentWords(a);
  const two = contentWords(b);
  if (!one.size || !two.size) return 0;
  let shared = 0;
  for (const word of one) if (two.has(word)) shared += 1;
  return shared / Math.min(one.size, two.size);
}

/** What the routine's reply leaves with the owner: one ask per subject,
 * never a denial ("não depende de você"), a quote, an echo of an item the
 * owner already has, nor a sentence that only says the item exists. */
export function routineOwnerAsks(text: string, context: RoutineAskContext = {}): RoutineAsk[] {
  const owner = ownerByName(context.ownerName);
  const exclude = new Set([...(context.knownNames ?? []).flatMap((name) => name.toLowerCase().split(/\s+/)), ...(context.ownerName ? [context.ownerName.trim().split(/\s+/)[0]!.toLowerCase()] : [])]);
  const sentences = sentencesOf(text);
  const found: RoutineAsk[] = [];
  sentences.forEach((original, index) => {
    const sentence = unquoted(original);
    if (!asksOwnerSentence(sentence, owner?.asks)) return;
    // the owner by name, denied ("não depende do Osvaldo"), with nothing else asking
    if (owner?.denies.test(sentence) && !asksOwnerSentence(sentence)) return;
    if (echoAsk(original, context.itemIds ?? [])) return;
    // "Preciso da sua decisão em duas coisas:" — the list that follows is the ask (up to 3 of its items)
    const list = /:\s*$/.test(original) ? sentences.slice(index + 1, index + 4) : [];
    const whole = [original, ...list].join(" ");
    // "Ainda dependem do Osvaldo: a abertura da issue…" — what is left, after the ask that leads it
    const colon = sentence.indexOf(":");
    const lead = colon > 0 && colon < 80 && asksOwnerSentence(sentence.slice(0, colon), owner?.asks) ? sentence.slice(0, colon) : null;
    const what = list[0] ?? (lead !== null && sentence.slice(colon + 1).trim().length > 8 ? sentence.slice(colon + 1).trim() : undefined);
    const about = list.length ? `${sentence} ${list.join(" ")}` : sentence;
    const person = personIn(lead !== null ? sentence.slice(colon + 1) : sentence, exclude) ?? personIn(sentence, exclude);
    const issue = /(?<![\w/])#(\d{3,6})(?!\d)/.exec(about)?.[1];
    const ticket = /(?<![\w-])([A-Z]{2,6}-\d{4,8}-\d{2,6})(?![\w-])/.exec(about)?.[1];
    const context_ = /(?<![\p{L}])conversa\s+(?:d[oa]|no|na|com\s+[oa])\s+(\p{Ll}[\p{L}\d.-]*)/u.exec(sentence)?.[1]?.replace(/[.,;:]+$/, "");
    const subject: RoutineAsk["subject"] = person
      ? { kind: "pessoa", id: slug(person.name), label: person.name }
      : ticket ? { kind: "ticket", id: slug(ticket), label: ticket }
        : issue ? { kind: "issue", id: issue, label: `#${issue}` }
          : context_ ? { kind: "conversa", id: slug(context_), label: context_ }
            : { kind: "frase", id: [...contentWords(about)].slice(0, 4).join("-") || "pendencia", label: "" };
    const link = /https?:\/\/[^\s)>\]]+/.exec(whole)?.[0]?.replace(/[.,;:]+$/, "");
    const ask: RoutineAsk = { sentence: whole, ...(what ? { what } : {}), decide: DECIDE.test(lead ?? sentence), subject, ...(person ? { person } : {}), ...(context_ ? { context: context_ } : {}), ...(link ? { link } : {}) };
    // the same subject said twice in the reply is one ask; asks with no subject in one reply are one too,
    // told by the one that lists what it asks ("Preciso da sua decisão em duas coisas: 1. … 2. …")
    const same = found.findIndex((each) => each.subject.kind === subject.kind && (subject.kind === "frase" || each.subject.id === subject.id));
    if (same < 0) found.push(ask);
    else if (subject.kind === "frase" && list.length && !found[same]!.what) found[same] = ask;
  });
  return found;
}

/** The key that makes the same ask the same item, run after run. */
export const routineAskKey = (ask: Pick<RoutineAsk, "subject">) => `${ROUTINE_ASK_KEY_PREFIX}${ask.subject.kind}:${ask.subject.id}`;

const TALK = /(?<![\p{L}])(?:conversa|respond\p{L}*|resposta|retorno|fala[rn]?|mensagem|contato|ligar|liga[çc][ãa]o)(?![\p{L}])/iu;
const DECIDE = /(?<![\p{L}])decis[ãa]o|decid\p{L}*/iu;

/** A short title, plain pt-BR: "Responder ao Luis Rossi (widget)", else the ask itself. */
export function routineAskTitle(ask: RoutineAsk): string {
  if (ask.person && TALK.test(ask.sentence)) {
    const to = ask.person.article === "o" ? "ao " : ask.person.article === "a" ? "à " : "a ";
    return `Responder ${to}${ask.person.name}${ask.context ? ` (${ask.context})` : ""}`;
  }
  // "Uma decisão fica com você: se …" → "Decidir: se …"; "Ainda dependem do Osvaldo: a abertura…" → "A abertura…"
  if (ask.what) {
    const said = ownerAskText(ask.what, 90);
    if (said) return ask.decide ? `Decidir: ${said.charAt(0).toLocaleLowerCase("pt-BR")}${said.slice(1)}` : said;
  }
  return ownerAskText(ask.sentence, 90) || "Pendência deixada por uma rotina";
}

const when = (ms: number) => {
  const at = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(at.getHours())}:${two(at.getMinutes())} de ${two(at.getDate())}/${two(at.getMonth() + 1)}`;
};
const clipQuote = (text: string, max = 280) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);

/** The item: why (the bot's sentence, and since when it repeats), steps and the one decision. */
export function routineAskItem(ask: RoutineAsk, origin: { botName: string; routineName: string; conversationTitle?: string; firstAt: number; lastAt: number }): { title: string; key: string; why: string; steps: OwnerPendingStep[]; options: OwnerPendingOption[]; link?: string } {
  const title = routineAskTitle(ask);
  const since = origin.lastAt - origin.firstAt >= 60_000
    ? `Repete isso desde as ${when(origin.firstAt)}; a última vez foi às ${when(origin.lastAt)}.`
    : `Disse isso às ${when(origin.lastAt)}.`;
  const why = `${origin.botName}, na rotina "${origin.routineName}", escreveu: "${clipQuote(ask.sentence)}" ${since}`;
  const steps: OwnerPendingStep[] = [
    { text: `Veja o contexto na conversa${origin.conversationTitle ? ` "${origin.conversationTitle}"` : ""} de ${origin.botName}.`, ...(ask.link ? { link: ask.link } : {}) },
    { text: ask.person ? `Resolva com ${ask.person.article === "o" ? "o " : ask.person.article === "a" ? "a " : ""}${ask.person.name} o que ficou com você.` : "Resolva o que o bot deixou com você." },
    { text: "Responda aqui o que fez ou decidiu: o item fecha com a sua resposta, ou quando o bot disser que resolveu." },
  ];
  const options: OwnerPendingOption[] = [{ label: "Já resolvi", reply: `Já resolvi: ${title}.` }];
  return { title, key: routineAskKey(ask), why, steps, options, ...(ask.link ? { link: ask.link } : {}) };
}

// the bot's own word for done; never "a Marluce respondeu" or "resolveu em uma linha" — someone acting is no resolution (real, 01/10)
const RESOLVED = /(?<![\p{L}])(?:resolvid[oa]s?|resolvi|respondid[oa]s?|respondi|encerrad[oa]s?|encerrei|fechad[oa]s?|conclu[íi]d[oa]s?|j[áa] (?:foi |est[áa] )?tratad[oa]s?)(?![\p{L}])/iu;
/** What the ask was for, done: "a abertura da issue" → "abertas às 09:36" (the 0042 of 01/10, opened as #9364 on 03/10). */
const ACTION_DONE: ReadonlyArray<[RegExp, RegExp]> = [
  [/(?<![\p{L}])abertura(?![\p{L}])/iu, /(?<![\p{L}])abert[oa]s?(?![\p{L}])/iu],
  [/(?<![\p{L}])cria[çc][ãa]o(?![\p{L}])/iu, /(?<![\p{L}])criad[oa]s?(?![\p{L}])/iu],
  [/(?<![\p{L}])envio(?![\p{L}])/iu, /(?<![\p{L}])enviad[oa]s?(?![\p{L}])/iu],
  [/(?<![\p{L}])registro(?![\p{L}])/iu, /(?<![\p{L}])registrad[oa]s?(?![\p{L}])/iu],
  [/(?<![\p{L}])aprova[çc][ãa]o(?![\p{L}])/iu, /(?<![\p{L}])aprovad[oa]s?(?![\p{L}])/iu],
  [/(?<![\p{L}])(?:merge|mesclagem)(?![\p{L}])/iu, /(?<![\p{L}])mesclad[oa]s?(?![\p{L}])/iu],
];
const NO_LONGER_YOURS = /(?<![\p{L}])n[ãa]o (?:est[áa]|fica|continua) mais com voc[êe]|saiu da sua lista/iu;
// "não foi resolvido", "sem ser respondido"; and "tinha respondido": someone else did it, before
const negatedAt = (sentence: string, at: number) => /(?<![\p{L}])(?:n[ãa]o|nem|sem|ainda n[ãa]o|tinha|tinham|havia|haviam)\s+(?:\S+\s+){0,2}$/iu.test(sentence.slice(0, at));

/** The bot says, in `text`, that the item's subject is resolved ("A conversa com o Luis Rossi foi resolvida"), never under a negation, never while asking again. */
export function saysRoutineAskResolved(item: Pick<OwnerPending, "key" | "why" | "title">, text: string): boolean {
  const key = item.key ?? "";
  if (!key.startsWith(ROUTINE_ASK_KEY_PREFIX)) return false;
  const [kind, ...rest] = key.slice(ROUTINE_ASK_KEY_PREFIX.length).split(":");
  const id = rest.join(":");
  const asked = quotedOf(item);
  // the conversation the title names ("Responder ao Luis Rossi (widget)")
  const where = /\(([^()]+)\)$/.exec(item.title)?.[1] ? slug(/\(([^()]+)\)$/.exec(item.title)![1]!) : null;
  const done = ACTION_DONE.filter(([noun]) => noun.test(asked)).map(([, participle]) => participle);
  // what someone else said, quoted, is not the bot saying it is resolved
  // a table row ("| #9311, fechada | Marluce |") puts words side by side, it says nothing of the ask (real, 01/10)
  return sentencesOf(text).filter((sentence) => !/^\|.*\|/.test(sentence)).map(unquoted).some((sentence) => {
    // a person is named all day in a support routine: the sentence must also be about what was asked
    // (its conversation, or two words of it) — "a Marluce Oliveira tinha respondido só 'sim'" is not (real, 01/10)
    const about = kind === "pessoa" ? `-${slug(sentence)}-`.includes(`-${id}-`) && (sharedWords(sentence, asked, id.split("-")) >= 2 || Boolean(where && `-${slug(sentence)}-`.includes(`-${where}-`)))
      : kind === "ticket" || kind === "conversa" ? `-${slug(sentence)}-`.includes(`-${id}-`)
      : kind === "issue" ? new RegExp(`#${id}(?!\\d)`).test(sentence)
        : overlap(sentence, quotedOf(item)) >= 0.5;
    if (!about) return false;
    if (NO_LONGER_YOURS.test(sentence)) return true;
    // still asking ("continua com você; o resto foi resolvido") is no resolution
    if (asksOwnerSentence(sentence)) return false;
    const match = [RESOLVED, ...done].map((each) => each.exec(sentence)).find(Boolean);
    // "só muda quando a Marluce confirmar que o ajuste resolveu" is a condition, not a fact (real, 30/09)
    return Boolean(match && !negatedAt(sentence, match.index) && !CONDITION.test(sentence.slice(0, match.index)));
  });
}
const CONDITION = /(?<![\p{L}])(?:quando|se|caso|assim que|at[ée]|depois que|confirm\p{L}* que|saber se|ver se)(?![\p{L}])/iu;

/** The bot's sentence an item quotes in its why (routineAskItem), else its title. */
function quotedOf(item: Pick<OwnerPending, "why" | "title">): string {
  return /escreveu: "([\s\S]*)" (?:Repete|Disse)/.exec(item.why ?? "")?.[1] ?? item.title;
}

/** The run's reply: its last text of its own — a narration turned into a work note (activity) and another bot's words are no reply. */
export function routineReplyText(messages: ReadonlyArray<{ role: string; kind: string; text?: string; from?: unknown }>): string | undefined {
  return [...messages].reverse().find((message) => message.role === "bot" && message.kind === "text" && !message.from && message.text?.trim())?.text;
}

/** What applyRoutineAsks needs of the ledger (BotAutonomy). */
export interface RoutineAskLedger {
  ownerPendingOf(botId: string): OwnerPending[];
  resolvedOwnerPendingOf(botId?: string): ResolvedOwnerPending[];
  addOwnerPending(botId: string, threadId: string, input: { title: string; key: string; link?: string; why: string; steps: OwnerPendingStep[]; options: OwnerPendingOption[] }): OwnerPending;
  resolveOwnerPending(match: { botId?: string; key?: string; by?: ResolvedOwnerPending["resolvedBy"]; note?: string }): OwnerPending[];
}

/** The open routine items the bot's `text` says are resolved: closed, by the bot. */
export function settleRoutineAsks(ledger: RoutineAskLedger, botId: string, text: string): OwnerPending[] {
  const done: OwnerPending[] = [];
  for (const item of ledger.ownerPendingOf(botId)) {
    if (!item.key?.startsWith(ROUTINE_ASK_KEY_PREFIX) || !saysRoutineAskResolved(item, text)) continue;
    done.push(...ledger.resolveOwnerPending({ botId, key: item.key, by: "bot", note: ROUTINE_ASK_RESOLVED_NOTE }));
  }
  return done;
}

/** A routine's run ended with `text`: what it says is resolved closes, and
 * each thing it leaves with the owner is ONE item in `threadId` (the
 * routine's conversation), opened or refreshed by its key. */
export function applyRoutineAsks(ledger: RoutineAskLedger, run: { botId: string; botName: string; routineName: string; threadId: string; conversationTitle?: string; text: string; at: number } & Pick<RoutineAskContext, "ownerName" | "knownNames">): { opened: OwnerPending[]; refreshed: OwnerPending[]; resolved: OwnerPending[] } {
  const resolved = settleRoutineAsks(ledger, run.botId, run.text);
  const open = ledger.ownerPendingOf(run.botId);
  const itemIds = open.flatMap((item) => [item.id, ...(item.aliases ?? [])]);
  const opened: OwnerPending[] = [];
  const refreshed: OwnerPending[] = [];
  for (const ask of routineOwnerAsks(run.text, { ownerName: run.ownerName, knownNames: run.knownNames, itemIds })) {
    // the bot's own item on the same subject already asks it (it names the person or issue)
    const label = ask.subject.label && slug(ask.subject.label);
    if (label && open.some((item) => !item.key && `-${slug(`${item.title} ${item.why ?? ""}`)}-`.includes(`-${label}-`))) continue;
    // a subject-less ask that reads like an open one is that one, said in other words
    const similar = ask.subject.kind === "frase" ? open.find((item) => item.key?.startsWith(`${ROUTINE_ASK_KEY_PREFIX}frase:`) && overlap(ask.sentence, quotedOf(item)) >= 0.5) : undefined;
    const key = similar?.key ?? routineAskKey(ask);
    const existing = open.find((item) => item.key === key);
    // answered by the owner a moment ago: the routine is only repeating what it read before
    if (!existing && ledger.resolvedOwnerPendingOf(run.botId).some((item) => item.key === key && item.resolvedBy === "owner" && run.at - item.resolvedAt < ROUTINE_ASK_SETTLED_MS)) continue;
    const want = routineAskItem(ask, { botName: run.botName, routineName: run.routineName, conversationTitle: run.conversationTitle, firstAt: existing?.createdAt ?? run.at, lastAt: run.at });
    // the same item keeps its title: a reworded repetition never renames what the owner reads
    const item = ledger.addOwnerPending(run.botId, existing?.threadId ?? run.threadId, { ...want, key, ...(existing ? { title: existing.title } : {}) });
    (existing ? refreshed : opened).push(item);
  }
  return { opened, refreshed, resolved };
}
