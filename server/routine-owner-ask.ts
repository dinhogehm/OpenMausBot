// A routine that ends saying something waits on the owner ("A conversa do
// widget continua com você: às 8:39 você disse que ia falar direto com o
// Luis Rossi.") reached nobody: "Precisa de você" skips a routine's run, and
// the bare-question promotion skips it too (R12-visual N22: the Monitor said
// it at 09:00 of 05/10 and nothing showed it). The owner decided it counts.
// The server reads the run's reply with the same detector as a conversation
// (asksOwnerSentence: by clause, never under a denial nor a condition), and
// opens ONE item per pendency: one per item of a list it leads, keyed by
// what it is about (a ticket, an issue, a sheet row, a conversation, the
// person it is owed to) AND by what it asks — the hourly repetition of the
// same pendency refreshes that item (same id, no new notification), another
// pendency about the same subject is another item (INSP-N22 A1). It closes
// when the owner says it is done, or when the bot says, in the past and of
// the same pendency, that it is resolved; never by silence — an item the
// routine stopped repeating says so after 24 h (INSP-N22 A8).
import { asksOwnerSentence, echoAsk, ownerAskIndex, ownerAskText, type OwnerPending, type OwnerPendingOption, type OwnerPendingStep, type ResolvedOwnerPending } from "./bot-autonomy.ts";

export const ROUTINE_ASK_KEY_PREFIX = "routine-ask:";
/** An item the owner answered is not reopened by the routine repeating the same pendency for this long (it may not have read the answer yet). */
export const ROUTINE_ASK_SETTLED_MS = 24 * 3_600_000;
/** An item the routine stopped repeating this long says so in its why. */
export const ROUTINE_ASK_STALE_MS = 24 * 3_600_000;
export const ROUTINE_ASK_RESOLVED_NOTE = "o bot disse que resolveu";
export const ROUTINE_ASK_DONE_LABEL = "Já resolvi";

type SubjectKind = "ticket" | "issue" | "linha" | "conversa" | "pessoa" | "frase";
/** One thing a routine's reply leaves with the owner. */
export interface RoutineAsk {
  /** What the bot wrote: the asking sentence, or the list's lead and this item of it. */
  sentence: string;
  /** What is left with the owner, without the ask that leads it ("Uma decisão fica com você: se…" → "se…"; a list's item). */
  what?: string;
  /** The ask is a decision ("decisão", "decidir"). */
  decide: boolean;
  /** What it is about: a ticket, an issue, a sheet row, a conversation, the person it is owed to, else its words. */
  subject: { kind: SubjectKind; id: string; label: string };
  /** The people it is owed to ("responder ao Filipe e à Marluce"), with the article the bot used, for the title. */
  people?: Array<{ name: string; article: "o" | "a" | null }>;
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
const has = (sentence: string, id: string) => `-${slug(sentence)}-`.includes(`-${id}-`);

/** Capitalized words that are not people: tools, places, the app's own words. */
const NOT_PEOPLE = new Set(["chat", "chief", "staff", "github", "nuria", "claude", "google", "gmail", "slack", "precisa", "monitor", "atendimento", "helpdesk", "planilha", "widget", "mac", "app", "pr", "issue", "issues", "você", "voce", "bot", "sheets", "drive", "brt", "codex", "openmausbot", "omb", "space", "meet", "whatsapp", "observações", "observacoes", "status", "jev", "laya"]);
const STOP_WORDS = new Set(["para", "pela", "pelo", "como", "mais", "ainda", "esta", "essa", "este", "esse", "isso", "isto", "voce", "sobre", "quando", "depois", "antes", "porque", "entre", "fica", "continua", "continuam", "preciso", "precisa", "decisao", "sua", "seu", "suas", "seus", "dela", "dele", "aqui", "agora", "hoje", "tambem", "nada", "tudo", "cada", "qual", "quais", "duas", "dois", "coisas", "coisa", "depende", "dependem", "aguardando", "aguardo", "esperando", "disse", "foram", "seria", "estao", "novo", "nova", "passada", "novidade", "dito", "ficou", "segue", "seguem", "deixei", "deixar", "preferi",
  // in every sentence of its kind: never a word two pendencies share (INSP-N22 r2 F1)
  "conversa", "conversas", "nesta", "neste", "nessa", "nesse"]);

/** Lines of a reply as the bot speaks them: code and quoted blocks are not the bot speaking. */
function linesOf(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .split("\n");
}
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;
/** One line, plain: markdown off, links as their text and target. */
const plainLine = (line: string) => line
  .replace(LIST_ITEM, "")
  .replace(/^\s{0,3}#{1,6}\s+/, "")
  .replace(/`([^`]*)`/g, "$1")
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
  .replace(/[*_~]+/g, "")
  .trim();
const splitSentences = (text: string) => text.split(/(?<=[.!?…])\s+/).map((each) => each.trim()).filter((each) => /\p{L}{3}/u.test(each));
/** The sentences of a reply (for the bot saying it is done). */
function sentencesOf(text: string): string[] {
  return linesOf(text).flatMap((line) => splitSentences(plainLine(line)));
}
/** The sentence with quoted speech blanked: an ask, or a "resolvido", inside quotes is someone else's words. */
const unquoted = (sentence: string) => sentence.replace(/["“«„][^"”»“]{0,400}["”»]/g, "«…»");

/** The owner by name asks too ("aguardando o Osvaldo", "fica com o Osvaldo", "depende do Osvaldo", "o Osvaldo precisa decidir"). */
function ownerByName(name: string | null | undefined): { asks: RegExp; denies: RegExp } | null {
  const first = name?.trim().split(/\s+/)[0];
  if (!first) return null;
  const who = `(?:(?:pel|d)?[oa]\\s+)?${escape(first)}(?![\\p{L}])`;
  return {
    asks: new RegExp(`(?<![\\p{L}])(?:(?:aguard|esper)\\p{L}*\\s+(?:por\\s+)?${who}|depende(?:m)?\\s+${who}|(?:continua|fica|est[áa])(?:m)?\\s+com\\s+${who}|decis[ãa]o\\s+d[oa]\\s+${escape(first)}(?![\\p{L}])|${escape(first)}\\s+precisa\\s+(?:decidir|responder|aprovar|confirmar|liberar|escolher))`, "iu"),
    denies: new RegExp(`(?<![\\p{L}])(?:n[ãa]o\\s+(?:depende|precisa|requer|exige|pede|est[áa]\\s+(?:aguardando|esperando)|aguarda|espera)|nada|nenhum\\p{L}*)(?![\\p{L}])[^.!?]*?${escape(first)}(?![\\p{L}])`, "iu"),
  };
}

/** An ask said under a condition is no ask yet: "Se a checagem estourar, trago o que depende de você", "Caso o Filipe não responda, a decisão fica com você" (INSP-N22 A5).
 * Only the conjunction that opens a conditional clause before the ask, in the ask's own clause: "se", "caso" or "quando"
 * starting it, or "se"/"caso" after a comma — never the pronoun ("o cliente se queixou", "trata-se"), a relative
 * ("o ticket que abriu quando o chat caiu") nor a "se" of another clause ("que a escala se mantenha; a decisão…") (INSP-N22 r2 F4). */
function underCondition(sentence: string, at: number): boolean {
  const before = sentence.slice(0, at);
  // the ask's clause: from the last ";" (or a sentence's start) to the ask
  const clause = before.slice(before.lastIndexOf(";") + 1);
  return /^\s*(?:se|caso|quando|assim que|a menos que)(?![\p{L}-])/iu.test(clause) || /,\s*(?:se|caso)\s+(?!\p{L}+-se)(?!(?:queix|mant|torn|esquec|lembr|preocup)\p{L}*)/iu.test(clause);
}
/** Someone else's words, reported: "A Marluce disse que a resposta depende de você" — theirs, not the bot's ask (INSP-N22 r2). */
const REPORTED = /(?<![\p{L}])(?:disse|diz|dizem|disseram|escreveu|escreveram|falou|comentou|contou|avisou|perguntou|acha|achou)\s+que(?![\p{L}])/iu;

const NAME = "\\p{Lu}\\p{Ll}+(?:\\s+\\p{Lu}\\p{Ll}+){0,2}";
/** The person the pendency is owed to: the one to answer or talk to ("responder ao Filipe e à Marluce", "falar direto com o Luis Rossi", "conversa nova com o Filipe"), or the one who waits or asked ("a Marluce espera"). Named in passing is not it (INSP-N22 A6). */
const OWED_TO = new RegExp(`(?<![\\p{L}])(?:respond\\p{L}*|responda|falar|fale|retornar|retorno|avisar|avise|ligar|escrever|mandar|cobrar|conversar|conversa(?:\\s+\\p{Ll}+){0,2})\\s+(?:direto\\s+|diretamente\\s+)?(?:com\\s+|para\\s+|pra\\s+)?(?:(ao|à|o|a)\\s+)?(${NAME})(?:\\s*(?:,|e)\\s+(?:(ao|à|o|a)\\s+)?(${NAME}))?`, "u");
const WAITS = new RegExp(`(?<![\\p{L}])(?:(o|a)\\s+)?(${NAME})\\s+(?:espera|aguarda|pediu|quer|perguntou|cobrou|cobra)(?![\\p{L}])`, "u");
function peopleIn(sentence: string, exclude: ReadonlySet<string>): RoutineAsk["people"] {
  const clean = (name: string | undefined) => {
    if (!name) return null;
    const kept: string[] = [];
    // a name stops at the first word that is not one ("Filipe Migon Hoje" → "Filipe Migon")
    for (const word of name.split(/\s+/)) {
      if (NOT_PEOPLE.has(word.toLowerCase()) || exclude.has(word.toLowerCase())) break;
      kept.push(word);
    }
    return kept.length ? kept.join(" ") : null;
  };
  const article = (said: string | undefined): "o" | "a" | null => (said === "o" || said === "ao" ? "o" : said === "a" || said === "à" ? "a" : null);
  const owed = OWED_TO.exec(sentence);
  if (owed) {
    const people = [[owed[1], owed[2]], [owed[3], owed[4]]].flatMap(([said, name]) => { const kept = clean(name); return kept ? [{ name: kept, article: article(said) }] : []; });
    if (people.length) return people;
  }
  const waits = WAITS.exec(sentence);
  const kept = clean(waits?.[2]);
  return kept ? [{ name: kept, article: article(waits![1]) }] : undefined;
}

const contentWords = (text: string) => new Set(strip(text).toLowerCase().split(/[^a-z0-9#]+/).filter((word) => word.length >= 4 && !STOP_WORDS.has(strip(word))));
/** Words two texts share over the smaller of them (1 = one says nothing the other does not), `except` aside. */
function overlap(a: string, b: string, except: readonly string[] = []): number {
  const one = [...contentWords(a)].filter((word) => !except.includes(word));
  const two = new Set([...contentWords(b)].filter((word) => !except.includes(word)));
  if (!one.length || !two.size) return 0;
  return one.filter((word) => two.has(word)).length / Math.min(one.length, two.size);
}
function sharedWords(a: string, b: string, except: readonly string[] = []): number {
  const two = contentWords(b);
  return [...contentWords(a)].filter((word) => two.has(word) && !except.includes(word)).length;
}

/** The ids a text names: tickets, issues and sheet rows — another one is another pendency. */
function idsIn(text: string): { ticket: string[]; issue: string[]; linha: string[] } {
  return {
    ticket: [...text.matchAll(/(?<![\w-])([A-Z]{2,6}-\d{4,8}-\d{2,6})(?![\w-])/g)].map((match) => slug(match[1]!)),
    issue: [...text.matchAll(/(?<![\w/])#(\d{3,6})(?!\d)/g)].map((match) => match[1]!),
    linha: [...text.matchAll(/(?<![\p{L}])(?:linha|L)\s?(\d{1,5})(?!\d)/gu)].map((match) => match[1]!),
  };
}

const DECIDE = /(?<![\p{L}])(?:decis[ãa]o|decid\p{L}*)/iu;
/** What it is about: a ticket, an issue, a sheet row, a conversation, the person it is owed to, else its words. */
function subjectOf(text: string, exclude: ReadonlySet<string>): Pick<RoutineAsk, "subject" | "people" | "context"> {
  const ids = idsIn(text);
  const people = peopleIn(text, exclude);
  // a channel named ("conversa do widget") is shown in the title, never the key: many conversations run in it (INSP-N22 r2 F1)
  const context = /(?<![\p{L}])conversa\s+(?:d[oa]|no|na)\s+(\p{Ll}[\p{L}\d.-]*)/u.exec(text)?.[1]?.replace(/[.,;:]+$/, "");
  const extra = { ...(people ? { people } : {}), ...(context ? { context } : {}) };
  // an identified conversation: a Chat thread or message id, as a link or bare ("threads/f3Kp6uZ37Xg", "conversa `dGFX5l60z8U`")
  const conversation = /(?:threads|messages)\/([\w-]{8,})/.exec(text)?.[1] ?? /(?<![\p{L}])(?:conversa|fio)\s+(?:\p{Ll}+\s+)?`?([A-Za-z0-9_-]{9,})`?(?![\w-])/u.exec(text)?.[1];
  if (ids.ticket[0]) return { subject: { kind: "ticket", id: ids.ticket[0], label: ids.ticket[0].toUpperCase() }, ...extra };
  if (ids.issue[0]) return { subject: { kind: "issue", id: ids.issue[0], label: `#${ids.issue[0]}` }, ...extra };
  if (ids.linha[0]) return { subject: { kind: "linha", id: ids.linha[0], label: `linha ${ids.linha[0]}` }, ...extra };
  if (conversation && /\d|[A-Z]/.test(conversation)) return { subject: { kind: "conversa", id: conversation.toLowerCase(), label: conversation }, ...extra };
  if (people) return { subject: { kind: "pessoa", id: people.map((each) => slug(each.name)).join("+"), label: people.map((each) => each.name).join(" e ") }, ...extra };
  return { subject: { kind: "frase", id: [...contentWords(text)].slice(0, 4).join("-") || "pendencia", label: "" }, ...extra };
}
/** The words of the subject itself: what the ask says beyond them tells two pendencies apart. */
const subjectWords = (ask: Pick<RoutineAsk, "subject" | "people" | "context">) => [
  ...ask.subject.id.split(/[-+]/), ...(ask.people ?? []).flatMap((each) => slug(each.name).split("-")), ...(ask.context ? [slug(ask.context)] : []),
];

/** The sentence asks the owner — not under a condition, a denial, nor as a question it answers itself ("Algo depende de você? Não."). */
function asks(sentence: string, next: string | undefined, owner: ReturnType<typeof ownerByName>): boolean {
  const at = ownerAskIndex(sentence, owner?.asks);
  if (at < 0) return false;
  if (underCondition(sentence, at)) return false;
  // reported: "X disse que … depende de você" — the ask is in what X said (the clause of the ask, before it)
  if (REPORTED.test(sentence.slice(0, at).slice(sentence.slice(0, at).lastIndexOf(";") + 1))) return false;
  // the owner by name, denied ("Nada está aguardando o Osvaldo"), with nothing else asking
  if (owner?.denies.test(sentence) && !asksOwnerSentence(sentence)) return false;
  if (/\?\s*$/.test(sentence) && next && /^n[ãa]o\b/iu.test(next)) return false;
  return true;
}

/** What the routine's reply leaves with the owner: one ask per pendency —
 * one per item of a list it leads ("Ainda dependem de você: - abrir… -
 * responder… - aprovar…") — never a denial, a condition, a quote, an echo
 * of an item the owner already has, nor a sentence that only says the item
 * exists. */
export function routineOwnerAsks(text: string, context: RoutineAskContext = {}): RoutineAsk[] {
  const owner = ownerByName(context.ownerName);
  const exclude = new Set([...(context.knownNames ?? []).flatMap((name) => name.toLowerCase().split(/\s+/)), ...(context.ownerName ? [context.ownerName.trim().split(/\s+/)[0]!.toLowerCase()] : [])]);
  const lines = linesOf(text);
  const found: Array<RoutineAsk & { listed: boolean }> = [];
  const first = context.ownerName?.trim().split(/\s+/)[0];
  // "O Osvaldo precisa decidir isso": the verb is the owner's action; "isso" points at the sentence before (INSP-N22 r2 F6)
  const ownerTask = first ? new RegExp(`(?<![\\p{L}])${escape(first)}\\s+precisa\\s+(decidir|responder|aprovar|confirmar|liberar|escolher)\\s*(.*?)[.!]?$`, "iu") : null;
  const add = (sentence: string, what: string | undefined, lead: string | null, listed: boolean, before?: string) => {
    if (echoAsk(sentence, context.itemIds ?? []) && (!what || echoAsk(what, context.itemIds ?? []))) return;
    const task = !what && ownerTask ? ownerTask.exec(sentence) : null;
    if (task) {
      // "isso": what the sentence before says, to decide; else the owner's own verb and its object ("Decidir isso", "Aprovar a PR")
      if (/^(?:isso|isto|aquilo|essa|esse|esta|este|a respeito)?$/iu.test(task[2]!.trim()) && before) {
        what = before;
        if (/^decid/i.test(task[1]!)) lead = lead ?? task[0];
      } else what = `${task[1]} ${task[2]}`.trim();
    }
    // a list's item is its own pendency; a sentence is about all it says (its lead names the conversation: "A conversa do widget continua com você: …")
    const about = unquoted(listed && what ? what : sentence);
    const subject = subjectOf(about, exclude);
    // the person it is owed to, said only in the lead ("A conversa do widget continua com você: … falar com o Luis Rossi")
    const people = subject.people ?? peopleIn(unquoted(sentence), exclude);
    const link = /https?:\/\/[^\s)>\]]+/.exec(sentence)?.[0]?.replace(/[.,;:]+$/, "");
    found.push({ sentence, ...(what ? { what } : {}), decide: DECIDE.test(lead ?? sentence), ...subject, ...(people ? { people } : {}), ...(link ? { link } : {}), listed });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = plainLine(lines[index]!);
    const sentences = splitSentences(line);
    sentences.forEach((original, at) => {
      const sentence = unquoted(original);
      if (!asks(sentence, sentences[at + 1], owner)) return;
      // a list it leads: each of its items is a pendency of its own (INSP-N22 A9)
      if (/:\s*$/.test(original) && at === sentences.length - 1) {
        const items: string[] = [];
        let next = index + 1;
        while (next < lines.length && !lines[next]!.trim()) next++;
        while (next < lines.length && LIST_ITEM.test(lines[next]!)) items.push(plainLine(lines[next++]!));
        if (items.length) {
          for (const item of items) add(`${original} ${item}`, item, original, true);
          index = next - 1;
          return;
        }
        // a paragraph after it: its first sentence is the ask
        const after = lines.slice(index + 1).map(plainLine).find((each) => each);
        if (after) add(`${original} ${splitSentences(after)[0] ?? after}`, splitSentences(after)[0] ?? after, original, false);
        return;
      }
      // "Ainda dependem do Osvaldo: a abertura da issue…" — what is left, after the ask that leads it
      const colon = sentence.indexOf(":");
      const lead = colon > 0 && colon < 80 && asksOwnerSentence(sentence.slice(0, colon), owner?.asks) ? original.slice(0, colon) : null;
      const what = lead !== null && original.slice(colon + 1).trim().length > 8 ? original.slice(colon + 1).trim() : undefined;
      add(original, what, lead, false, sentences[at - 1] ?? lines.slice(0, index).map(plainLine).filter(Boolean).at(-1));
    });
  }
  // the same pendency said twice in the reply is one; a loose sentence that reads like a listed one is that one
  const kept: Array<RoutineAsk & { listed: boolean }> = [];
  for (const ask of found) {
    const twin = kept.find((each) => samePendency(each, ask) || (each.listed && !ask.listed && ask.subject.kind === "frase" && overlap(ask.sentence, each.what ?? each.sentence) >= 0.5));
    if (twin) continue;
    const loose = kept.findIndex((each) => !each.listed && each.subject.kind === "frase" && ask.listed && overlap(each.sentence, ask.what ?? ask.sentence) >= 0.5);
    if (loose >= 0) kept.splice(loose, 1);
    kept.push(ask);
  }
  return kept.map(({ listed: _listed, ...ask }) => ask);
}

/** Two asks are the same pendency: the same subject, and what they ask beyond it reads alike. */
function samePendency(a: RoutineAsk, b: RoutineAsk): boolean {
  if (routineAskKey(a) !== routineAskKey(b)) return false;
  const except = [...subjectWords(a), ...subjectWords(b)];
  const one = a.what ?? a.sentence;
  const two = b.what ?? b.sentence;
  // nothing beyond the subject on either side: the subject is the pendency
  if (![...contentWords(one)].some((word) => !except.includes(word)) || ![...contentWords(two)].some((word) => !except.includes(word))) return true;
  return overlap(one, two, except) >= 0.5;
}

/** The subject's key; a second pendency about it gets its own (routineAskKeyFor). */
export const routineAskKey = (ask: Pick<RoutineAsk, "subject">) => `${ROUTINE_ASK_KEY_PREFIX}${ask.subject.kind}:${ask.subject.id}`;

const TALK = /(?<![\p{L}])(?:conversa|respond\p{L}*|responda|resposta|retorno|retornar|fala[rn]?|fale|mensagem|contato|ligar|liga[çc][ãa]o|avisar|avise)(?![\p{L}])/iu;
/** A title cut at a word, never ending on "de", "a", "com"… */
function clipTitle(text: string, max = 90): string {
  const said = ownerAskText(text, max);
  if (!said.endsWith("…")) return said;
  return `${said.slice(0, -1).replace(/(?:\s+(?:de|da|do|das|dos|a|o|as|os|e|ou|em|no|na|com|para|pra|por|que|se|um|uma|ao|à))+$/iu, "").replace(/[\s,;:–—-]+$/, "")}…`;
}
const toPerson = (person: { name: string; article: "o" | "a" | null }) => `${person.article === "o" ? "ao " : person.article === "a" ? "à " : ""}${person.name}`;
const withPerson = (person: { name: string; article: "o" | "a" | null }) => `${person.article === "o" ? "o " : person.article === "a" ? "a " : ""}${person.name}`;
const lower = (text: string) => text.charAt(0).toLocaleLowerCase("pt-BR") + text.slice(1);

/** A short title, plain pt-BR: "Responder ao Luis Rossi (widget)", "Decidir: …", else what is left with the owner. */
export function routineAskTitle(ask: RoutineAsk): string {
  const people = ask.people ?? [];
  if (!ask.decide && people.length && TALK.test(ask.what ?? ask.sentence)) {
    const names = people.map(toPerson).join(" e ");
    // no article said ("falar com Filipe"): no preposition guessed either
    return `${people.every((each) => each.article) ? `Responder ${names}` : `Falar com ${people.map((each) => each.name).join(" e ")}`}${ask.context ? ` (${ask.context})` : ""}`;
  }
  // the clause that asks, not what the sentence adds after a ";" ("…; hoje de manhã falei com o Filipe sobre outra coisa")
  const clause = ask.what ?? ask.sentence.split(/;\s*/).find((each) => asksOwnerSentence(each)) ?? ask.sentence;
  // "Fica com você decidir a escala" → "decidir a escala"
  const said = /^\s*(?:fica|ficam|continua|continuam)\s+com\s+voc[êe]\s+(\p{L}+(?:ar|er|ir)(?![\p{L}]).*)$/iu.exec(clause)?.[1] ?? clause;
  // already an action for the owner: a question to decide ("Posso escrever…?"), or a verb ("Abrir a issue…", "Aprovar a #9370")
  if (ask.decide && (ask.what || /\?\s*$/.test(said)) && !/^\s*decid/iu.test(said)) return `Decidir: ${lower(clipTitle(said, 100))}`;
  if (ACTION_START.test(said) && !STATEMENT_START.test(said)) return clipTitle(said.charAt(0).toLocaleUpperCase("pt-BR") + said.slice(1));
  // "Três vigias permanentes (…): não posso armar…" — a label, then the bot's own statement: the label is what to look at
  const label = /^([^:]{3,70}):\s+\S/.exec(said)?.[1];
  if (label && !asksOwnerSentence(label)) return `${ask.decide ? "Decidir" : "Ver"}: ${lower(clipTitle(label, 90))}`;
  // a statement: what it is about, without the words that leave it with the owner
  // ("O comentário na #9331 está aguardando o Osvaldo" → "Ver: o comentário na #9331")
  // "O cliente se queixou de novo e a resposta depende de você": the owner's action is the answer
  const answer = /^(.+?),?\s+(?:e|ent[ãa]o|mas)\s+a\s+resposta$/iu.exec(withoutAsk(said));
  if (answer && !ask.decide) return `Responder: ${lower(clipTitle(answer[1]!, 90))}`;
  let subject = (withoutAsk(said) || said).replace(/,?\s*(?:ent[ãa]o|e|mas)?\s*(?:a|o)\s+(?:decis[ãa]o|resposta|escolha)\s*$/iu, "").trim();
  // nothing left but "a decisão": what the sentence says before it ("A Marluce pediu que a escala se mantenha; a decisão fica com você")
  if (![...contentWords(subject)].some((word) => !["decisao", "resposta", "escolha"].includes(word))) subject = ask.sentence.split(/;\s*/)[0]!.trim();
  else if (withoutAsk(said) !== said) subject = askedNoun(subject);
  return `${ask.decide ? "Decidir" : "Ver"}: ${lower(clipTitle(subject, 90))}` || "Pendência deixada por uma rotina";
}
/** What the ask is about, first: the noun right before the words that left it with the owner ("… e a resposta depende
 * de você" → "a resposta"), with what led to it after, in parentheses; an opening adverb ("Até agora,", "Desde
 * ontem,") dropped (INSP-N22 r3 R5). */
function askedNoun(text: string): string {
  const parts = text.split(/,\s+|\s+e\s+/).map((each) => each.trim()).filter(Boolean);
  const kept = parts.filter((each, at) => !(at < parts.length - 1 && /^(?:at[ée]|desde|hoje|ontem|agora|ainda|tamb[ée]m|por enquanto|nesta|neste|de novo|mais uma vez)(?![\p{L}])/iu.test(each)));
  const main = kept.at(-1) ?? text;
  const lead = kept.slice(0, -1).join(", ");
  // a short noun phrase leads; a long one is the whole thing already
  if (!lead || main.split(/\s+/).length > 6) return kept.join(", ");
  return `${main} (${lead.charAt(0).toLocaleLowerCase("pt-BR")}${lead.slice(1)})`;
}
/** An infinitive opens it: an action ("Abrir a issue", "Responder ao Filipe", "Revisar a planilha"). */
const ACTION_START = /^\s*\p{L}+(?:ar|er|ir|or)(?![\p{L}])/iu;
/** Words that end like an infinitive but open a statement. */
const STATEMENT_START = /^\s*(?:lugar|par|mar|bar|ser|ter|ir|vir|estar|haver|poder|dever|querer|saber|cor|dor|valor|favor|amor|melhor|pior|maior|menor|anterior|posterior|superior|inferior|interior|exterior)(?![\p{L}])/iu;
/** The sentence without the ask that leaves it with the owner ("… continua com você", "… depende de você", "… está aguardando o Osvaldo"). */
function withoutAsk(text: string): string {
  return text
    .replace(/,?\s*(?:que\s+)?(?:ainda\s+|também\s+|tamb[ée]m\s+)?(?:continua|continuam|fica|ficam|est[áa]|est[ãa]o|segue|seguem)\s+(?:(?:aguardando|esperando)\s+(?:por\s+)?|com\s+)(?:(?:o|a)\s+)?(?:voc[êe]|\p{Lu}\p{Ll}+)(?![\p{L}]).*$/u, "")
    .replace(/,?\s*(?:ainda\s+|tamb[ée]m\s+|s[óo]\s+)?(?:depende|dependem|precisa|precisam)\s+(?:de\s+voc[êe]|d[ao]\s+(?:sua|seu)\s+\p{L}+|d[oa]\s+\p{Lu}\p{Ll}+).*$/u, "")
    .replace(/[\s,;:–—-]+$/, "")
    .trim();
}

const when = (ms: number) => {
  const at = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(at.getHours())}:${two(at.getMinutes())} de ${two(at.getDate())}/${two(at.getMonth() + 1)}`;
};
const day = (ms: number) => { const at = new Date(ms); return `${String(at.getDate()).padStart(2, "0")}/${String(at.getMonth() + 1).padStart(2, "0")}`; };
const clipQuote = (text: string, max = 280) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);
const STALE_NOTE = (lastAt: number) => ` (o bot não repete desde ${day(lastAt)}; confirme se ainda vale)`;

/** When it was said: since when it repeats, and the last time — said once, the last time is the only one. */
function saidLine(firstAt: number, lastAt: number): string {
  return lastAt - firstAt >= 60_000
    ? `Repete isso desde as ${when(firstAt)}; última vez dita às ${when(lastAt)}.`
    : `Última vez dita às ${when(lastAt)}.`;
}

/** The item: why (the bot's words, and when it said them), steps and the one decision. */
export function routineAskItem(ask: RoutineAsk, origin: { botName: string; routineName: string; conversationTitle?: string; firstAt: number; lastAt: number }): { title: string; key: string; why: string; steps: OwnerPendingStep[]; options: OwnerPendingOption[]; link?: string; lastSaidAt: number } {
  const title = routineAskTitle(ask);
  const why = `O bot ${origin.botName}, na rotina "${origin.routineName}", escreveu: "${clipQuote(ask.sentence)}" ${saidLine(origin.firstAt, origin.lastAt)}`;
  const people = ask.people ?? [];
  const todo = ask.decide
    ? "Decida e responda aqui o que escolheu."
    : people.length && TALK.test(ask.what ?? ask.sentence)
      ? `Resolva com ${people.map(withPerson).join(" e ")} o que ficou com você.`
      : "Resolva o que o bot deixou com você.";
  const steps: OwnerPendingStep[] = [
    { text: `Veja o contexto na conversa${origin.conversationTitle ? ` "${origin.conversationTitle}"` : ""} do bot ${origin.botName}.`, ...(ask.link ? { link: ask.link } : {}) },
    { text: todo },
    { text: `Quando terminar, escolha "${ROUTINE_ASK_DONE_LABEL}" ou diga aqui o que fez. Uma pergunta ou um recado vai para o bot e o item continua aberto.` },
  ];
  const options: OwnerPendingOption[] = [{ label: ROUTINE_ASK_DONE_LABEL, reply: "Já resolvi essa pendência." }];
  return { title, key: routineAskKey(ask), why, steps, options, ...(ask.link ? { link: ask.link } : {}), lastSaidAt: origin.lastAt };
}

// the bot's own word for done; never "a Marluce respondeu" or "resolveu em uma linha" — someone acting is no resolution (real, 01/10)
const RESOLVED = /(?<![\p{L}])(?:resolvid[oa]s?|resolvi|respondid[oa]s?|respondi|encerrad[oa]s?|encerrei|fechad[oa]s?|conclu[íi]d[oa]s?|j[áa] (?:foi |est[áa] )?tratad[oa]s?)(?![\p{L}])/iu;
/** What the ask was for, done: "a abertura da issue" / "abrir a issue" → "abertas às 09:36" (the 0042 of 01/10, opened as #9364 on 03/10). */
const ACTION_DONE: ReadonlyArray<[RegExp, RegExp]> = [
  [/(?<![\p{L}])(?:abertura|abrir|abra)(?![\p{L}])/iu, /(?<![\p{L}])abert[oa]s?(?![\p{L}])/iu],
  [/(?<![\p{L}])(?:cria[çc][ãa]o|criar)(?![\p{L}])/iu, /(?<![\p{L}])criad[oa]s?(?![\p{L}])/iu],
  [/(?<![\p{L}])(?:envio|enviar)(?![\p{L}])/iu, /(?<![\p{L}])enviad[oa]s?(?![\p{L}])/iu],
  [/(?<![\p{L}])(?:registro|registrar)(?![\p{L}])/iu, /(?<![\p{L}])registrad[oa]s?(?![\p{L}])/iu],
  [/(?<![\p{L}])(?:aprova[çc][ãa]o|aprovar)(?![\p{L}])/iu, /(?<![\p{L}])aprovad[oa]s?(?![\p{L}])/iu],
  [/(?<![\p{L}])(?:merge|mesclagem|mesclar)(?![\p{L}])/iu, /(?<![\p{L}])mesclad[oa]s?(?![\p{L}])/iu],
  [/(?<![\p{L}])(?:responder|resposta)(?![\p{L}])/iu, /(?<![\p{L}])respondid[oa]s?(?![\p{L}])/iu],
];
const NO_LONGER_YOURS = /(?<![\p{L}])n[ãa]o (?:est[áa]|fica|continua) mais com voc[êe]|saiu da sua lista/iu;
/** Not the past, affirmative and whole: a future ("será resolvida", "vai ser", "amanhã"), a part ("metade", "falta"), someone else's word ("disse que"). */
const NOT_DONE_YET = /(?<![\p{L}])(?:ser[áa]|ser[ãa]o|vai ser|v[ãa]o ser|vai ficar|deve ser|devem ser|amanh[ãa]|depois|logo mais|metade|parte|parcial\p{L}*|um dos|uma das|falta|faltam|disse que|diz que|dizem que|segundo [oa])(?![\p{L}])/iu;
const CONDITION = /(?<![\p{L}])(?:quando|se|caso|assim que|at[ée]|depois que|confirm\p{L}* que|saber se|ver se)(?![\p{L}])/iu;
const NEGATION = /(?<![\p{L}])(?:n[ãa]o|nem|sem|nunca|jamais)(?![\p{L}])|(?<![\p{L}])(?:tinha|tinham|havia|haviam)\s+(?:\S+\s+){0,1}$/iu;

/** The bot's sentence an item quotes in its why (routineAskItem), else its title. */
function quotedOf(item: Pick<OwnerPending, "why" | "title">): string {
  return /escreveu: "([\s\S]*)" (?:Repete|Última)/.exec(item.why ?? "")?.[1] ?? item.title;
}

/** The bot says, in `text`, that THIS pendency is resolved: the same subject
 * (by its key), nothing else named instead (another ticket, issue or row),
 * and said in the past, affirmative and whole — never a question, a future,
 * a part, a condition, a negation, a quote or a table row (INSP-N22 A4). */
export function saysRoutineAskResolved(item: Pick<OwnerPending, "key" | "why" | "title">, text: string): boolean {
  const facts = itemFacts(item);
  if (!facts) return false;
  const { kind, asked, askedIds, done, routineWords, subjectTokens } = facts;
  return sentencesOf(text).filter((sentence) => !/^\|.*\|/.test(sentence)).map(unquoted).some((sentence) => {
    if (/\?\s*$/.test(sentence)) return false;
    if (!isAbout(facts, sentence, "bot")) return false;
    if (NO_LONGER_YOURS.test(sentence)) return true;
    // still asking ("continua com você; o resto foi resolvido") is no resolution
    if (asksOwnerSentence(sentence) || NOT_DONE_YET.test(sentence)) return false;
    // the pendency's own action, done ("abertas"), or the bot's word for done about what was asked (two of its words)
    const action = done.map((each) => each.exec(sentence)).find(Boolean);
    const word = RESOLVED.exec(sentence);
    const match = action ?? ((kind === "ticket" || kind === "issue" || kind === "linha") ? (word && sharedWords(sentence, asked, [...subjectTokens, ...askedIds.ticket, ...askedIds.issue]) >= 2 ? word : null) : word);
    if (!match) return false;
    const before = sentence.slice(0, match.index);
    if (NEGATION.test(before) || CONDITION.test(before)) return false;
    // a "not" after it, about what was asked: "a linha 110 foi fechada …; o número da issue ainda não foi escrito" (INSP-N22 r2 F5)
    const after = sentence.slice(match.index + match[0].length);
    return !(NEGATED_AFTER.test(after) && sharedWords(after, asked, routineWords) >= 1);
  });
}
const NEGATED_AFTER = /(?<![\p{L}])(?:n[ãa]o|nem|nunca|jamais)(?![\p{L}])/iu;

/** What an item asked, read back from its key and why: its subject, the bot's words, the ids it named, the action it was for. */
function itemFacts(item: Pick<OwnerPending, "key" | "why" | "title">) {
  const key = item.key ?? "";
  if (!key.startsWith(ROUTINE_ASK_KEY_PREFIX)) return null;
  const [kind, ...rest] = key.slice(ROUTINE_ASK_KEY_PREFIX.length).split(":");
  const id = rest.join(":").split("~")[0]!;
  const asked = quotedOf(item);
  // the routine's own words ("Chat, planilha e issues") are in every run: they never tell what was asked (real, 01/10:
  // "Passada das 13h concluída: li o Chat… a planilha e as issues" is not the three watches being armed)
  const routineWords = [...contentWords(/na rotina "([^"]+)"/.exec(item.why ?? "")?.[1] ?? "")];
  return {
    kind: kind as SubjectKind, id, asked, askedIds: idsIn(asked), routineWords,
    done: ACTION_DONE.filter(([noun]) => noun.test(asked)).map(([, participle]) => participle),
    where: /\(([^()]+)\)$/.exec(item.title)?.[1],
    subjectTokens: [...id.split(/[-+]/), ...routineWords],
    routineName: /na rotina "([^"]+)"/.exec(item.why ?? "")?.[1] ?? null,
  };
}

/** The sentence is about THIS pendency, by its key: the same ticket, issue, row or conversation; the person it is owed
 * to, by name, with what was asked; else two of its words — and nothing else named instead (another ticket, issue or row).
 * `who`: the owner talks about it in fewer words than a report ("arme os três vigias"). */
function isAbout(facts: NonNullable<ReturnType<typeof itemFacts>>, sentence: string, who: "bot" | "owner"): boolean {
  const { kind, id, asked, askedIds, where, routineWords, subjectTokens } = facts;
  const ids = idsIn(sentence);
  // another ticket, issue or row of the same kind than the one asked is another pendency (linha 112 is not linha 110)
  for (const each of ["ticket", "issue", "linha"] as const) {
    if (askedIds[each].length && ids[each].length && !ids[each].some((one) => askedIds[each].includes(one))) return false;
  }
  // a person or words alone: a ticket or issue the ask never named is something else ("o bug do widget foi resolvido na #9370")
  if (kind !== "ticket" && kind !== "issue" && [...ids.ticket, ...ids.issue].some((one) => !askedIds.ticket.includes(one) && !askedIds.issue.includes(one))) return false;
  if (kind === "linha") return ids.linha.includes(id);
  if (kind === "issue") return ids.issue.includes(id);
  if (kind === "ticket") return ids.ticket.includes(id);
  if (kind === "conversa") return has(sentence, id);
  // the person it is owed to, by name; and what was asked (two of its words) or the channel the title names ("(widget)")
  if (kind === "pessoa") return id.split("+").every((each) => has(sentence, each)) && (sharedWords(sentence, asked, subjectTokens) >= 2 || Boolean(where && has(sentence, slug(where))));
  // words alone: two of what was asked — and, from a report, most of what the sentence says
  return sharedWords(sentence, asked, routineWords) >= 2 && (who === "owner" || overlap(sentence, asked, routineWords) >= 0.5);
}

/** The routine names the item, strictly: by its key when it has one (the ticket, issue, row or person, as the bot's word
 * for done needs it), else 3 words of what was asked beyond the bots' names and the routine's own words. */
function citesItem(facts: NonNullable<ReturnType<typeof itemFacts>>, sentence: string, botWords: readonly string[]): boolean {
  if (facts.kind !== "frase") return isAbout(facts, sentence, "bot");
  return sharedWords(sentence, facts.asked, [...facts.routineWords, ...botWords]) >= 3;
}

/** The owner's own words end the pendency ("Já falei com ele", "resolvido", "pode fechar"): never a question, a "not
 * yet", a doubt, a part ("metade", "falta o Filipe"), a wait ("aguardo", "ele pediu mais um dia", "vai pensar"), a
 * correction ("errado, ignora") or another ask ("abre outro") — those go to the bot and keep the item open (INSP-N22 A3, r2 F3). */
export function ownerAnswerCloses(text: string): boolean {
  const said = text.trim();
  if (!said || stillOpen(said)) return false;
  // "pronto" ends it only said alone ("Pronto." / "Pronto, feito") — "pronto para revisar" is ready to start
  if (/(?<![\p{L}])pront[oa]\s+(?:para|pra)(?![\p{L}])/iu.test(said)) return false;
  const close = OWNER_CLOSE.exec(said);
  return Boolean(close && !negatedBefore(said, close.index, close[0].length) && (!/^pode (?:fechar|encerrar)/iu.test(close[0]) || closesTheItem(said, close.index + close[0].length)));
}
const OWNER_CLOSE = /(?<![\p{L}])(?:j[áa] (?:resolvi|falei|respondi|tratei|cuidei|decidi|fiz|liberei|abri|aprovei)|resolvi|resolvido|resolvida|feito|feita|pronto|pronta|falei com|respondi|tratei|cuidei|decidi|pode fechar|pode encerrar|encerrad[oa]|conclu[íi]d[oa]|fechad[oa]|ok,? resolvido)(?![\p{L}])/iu;
/** Words that keep the owner's message open wherever they are: a question, a part ("metade", "falta o Filipe"), a wait
 * ("aguardo", "ele pediu mais um dia", "vai pensar"), a later ("amanhã", "na segunda", "escreva depois" — not "depois do
 * texto", a place), a correction ("errado, ignora"), another ask ("abre outro"), a doubt (INSP-N22 r4 S2, S3). */
function stillOpen(said: string): boolean {
  if (/\?/.test(said)) return true;
  if (/(?<![\p{L}])(?:amanh[ãa]|vou|vamos|vai|v[ãa]o|talvez|acho|qual|metade|parte|parcial\p{L}*|falta|faltam|faltando|aguardo|aguardando|esperando|esperar|pediu|pedi|errado|errada|ignora|ignore|desconsider\p{L}*|outro|outra|abre|abra|segunda|semana)(?![\p{L}])/iu.test(said)) return true;
  // "depois" as a time ("escreva depois", "depois eu vejo"), never as a place ("depois do texto do Filipe")
  return /(?<![\p{L}])depois(?!\s+d[aeo]s?(?![\p{L}]))(?![\p{L}])/iu.test(said);
}
/** A "not" before the word, in its own clause ("ainda não falei", "não escreva"), or right after it ("Concluído não, só
 * começado") — never one of another clause ("Escrevi o número, não precisa mais"; "é ajuste de grade, não mudança"). */
function negatedBefore(said: string, at: number, length: number): boolean {
  const before = said.slice(0, at);
  const clause = before.slice(Math.max(before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf(":"), before.lastIndexOf("."), -1) + 1);
  if (/(?<![\p{L}])(?:n[ãa]o|nem|nunca|jamais|ainda)(?![\p{L}])/iu.test(clause)) return true;
  return /^\s*(?:n[ãa]o|nem|nunca)(?![\p{L}])/iu.test(said.slice(at + length));
}
/** "Pode fechar" closes the item when it is the item it closes: alone, or "esse/este/isso/o item…/essa pendência" — never
 * another thing ("Pode fechar o ticket ATD-… no helpdesk", INSP-N22 r4 S3). */
function closesTheItem(said: string, from: number): boolean {
  const rest = said.slice(from).replace(/^\s+/, "");
  return !rest || /^[.,;:!—–-]/.test(rest) || /^(?:esse|este|isso|isto|ess[ae] (?:item|pend[êe]ncia)|est[ae] (?:item|pend[êe]ncia)|o item|a pend[êe]ncia)(?![\p{L}])/iu.test(rest);
}

/** The owner, in a conversation with the bot, did or ordered the very thing the item asked: "Monitor, arme AGORA, nesta
 * conversa, três vigias permanentes…" for "Três vigias permanentes: não posso armar numa execução de rotina. Se quiser,
 * peça na minha conversa principal" (real, 30/09 16:12) — the infinitive the bot used, said as an order or done. */
function ownerActs(facts: NonNullable<ReturnType<typeof itemFacts>>, sentence: string): boolean {
  const { asked } = facts;
  // "Não escreva nada na linha 110 ainda", "o Filipe vai mandar": an order not to, a not yet, a later end nothing (INSP-N22 r3 R2, r4 S3)
  if (stillOpen(sentence)) return false;
  // the infinitive the bot used, and the one its noun stands for ("a abertura da issue" → abrir)
  const verbs = [...new Set([...contentWords(asked)].filter((word) => /^[a-z]{3,}(?:ar|er|ir)$/.test(word) && !COMMON_VERBS.has(word)).concat(NOUN_VERBS.filter(([noun]) => noun.test(asked)).map(([, verb]) => verb)))];
  if (!verbs.length) return false;
  const plain = strip(sentence).toLowerCase();
  const done = verbs.flatMap((verb) => {
    const stem = verb.slice(0, -2);
    const ending = verb.slice(-2);
    // the order ("arme", "abra"), the past ("armei", "abri", "armou"), the done ("aberta", "escrito") and "pode escrever"
    const forms = ending === "ar"
      ? [`${stem}e`, `${stem}ei`, `${stem}ou`, `${stem}em`, `${stem}ad[oa]s?`]
      : [`${stem}a`, `${stem}i`, `${stem}eu`, `${stem}iu`, `${stem}am`, `${stem}id[oa]s?`, ...(IRREGULAR_DONE[verb] ? [IRREGULAR_DONE[verb]!] : [])];
    const match = new RegExp(`(?<![a-z])(?:pode\\s+${verb}|${forms.join("|")})(?![a-z])`).exec(plain);
    return match ? [{ match, verb }] : [];
  });
  return done.some(({ match, verb }) => {
    // a "not" before it in its own clause ("ainda não abri"), not one of another clause ("…, não precisa mais") (INSP-N22 r4 S2)
    if (negatedBefore(plain, match.index, match[0].length)) return false;
    // and what it was asked for: a word of the ask beyond its subject, the routine's and the verb's — "Abri o ATD-0042
    // pra ver o histórico" is not "a abertura da issue" (INSP-N22 r4 S3)
    // (a ticket's, issue's, row's or person's id is the subject; an item of words is its words — those are what it asks)
    const except = [...(facts.kind === "frase" ? facts.routineWords : facts.subjectTokens), ...facts.askedIds.ticket, ...facts.askedIds.issue, verb, match[0], "abertura", "linha"];
    return sharedWords(sentence, asked, except) >= 1;
  });
}
/** The done of a verb that does not end in -ido. */
const IRREGULAR_DONE: Record<string, string> = { abrir: "abert[oa]s?", escrever: "escrit[oa]s?", fazer: "feit[oa]s?", pôr: "post[oa]s?" };
const COMMON_VERBS = new Set(["estar", "ficar", "deixar", "poder", "fazer", "dizer", "quiser", "querer", "saber", "haver", "olhar", "achar", "passar", "chegar", "falar", "tratar", "mandar", "pedir"]);
/** The verb a noun of the ask stands for. */
const NOUN_VERBS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![\p{L}])abertura(?![\p{L}])/iu, "abrir"],
  [/(?<![\p{L}])cria[çc][ãa]o(?![\p{L}])/iu, "criar"],
  [/(?<![\p{L}])envio(?![\p{L}])/iu, "enviar"],
  [/(?<![\p{L}])registro(?![\p{L}])/iu, "registrar"],
  [/(?<![\p{L}])aprova[çc][ãa]o(?![\p{L}])/iu, "aprovar"],
  [/(?<![\p{L}])(?:merge|mesclagem)(?![\p{L}])/iu, "mesclar"],
];
/** The owner closes the item in so many words ("pode fechar", "já resolvi isso"): what a ticket's item needs when the
 * action itself is not named — "Respondi a cliente do ATD-…, resolvido" is not the issue opened (INSP-N22 r3 R6). */
const EXPLICIT_CLOSE = /(?<![\p{L}])(?:pode (?:fechar|encerrar|tirar)|j[áa] resolvi (?:isso|essa|esse|este|esta)|resolvi (?:isso|essa pend[êe]ncia|esse item)|isso (?:j[áa] )?(?:est[áa] )?resolvid[oa]|esse item (?:j[áa] )?(?:est[áa] )?resolvido|j[áa] resolvi essa pend[êe]ncia)(?![\p{L}])/iu;
/** The item closed in so many words: "pode fechar" only when what it closes is the item (alone, "esse", "isso", "o item",
 * "essa pendência") — "Pode fechar o ticket ATD-… no helpdesk" is another thing (INSP-N22 r4 S3). */
function explicitlyClosed(text: string): boolean {
  if (stillOpen(text)) return false;
  const close = EXPLICIT_CLOSE.exec(text);
  if (!close || negatedBefore(text, close.index, close[0].length)) return false;
  return !/^pode /iu.test(close[0]) || closesTheItem(text, close.index + close[0].length);
}

/** The owner's words end THIS item: for a ticket or issue, its action named with what it was for, or the item closed in
 * so many words; else the words that end anything, or the action done or ordered — never under a "not" of its own
 * clause, a "not yet", a later or a question. */
export function ownerEndsRoutineAsk(item: Pick<OwnerPending, "key" | "why" | "title">, text: string): boolean {
  const facts = itemFacts(item);
  if (!facts) return ownerAnswerCloses(text);
  if (facts.kind === "ticket" || facts.kind === "issue") return ownerActs(facts, text) || explicitlyClosed(text);
  return ownerAnswerCloses(text) || ownerActs(facts, text);
}

/** The owner wrote, in a conversation of the bot after the item was opened, about the same pendency (by its key), in
 * words that end it or doing what it asked: the item closes as the owner's (INSP-N22 r2 F2). */
export function ownerSettlesRoutineAsks(ledger: RoutineAskLedger, botId: string, messages: ReadonlyArray<{ at: number; text?: string }>): OwnerPending[] {
  const done: OwnerPending[] = [];
  for (const item of ledger.ownerPendingOf(botId)) {
    const facts = isRoutineItem(item) ? itemFacts(item) : null;
    if (!facts) continue;
    const settled = messages.some((message) => message.at > item.createdAt && sentencesOf(message.text ?? "").map(unquoted).some((sentence) =>
      isAbout(facts, sentence, "owner") && ownerEndsRoutineAsk(item, sentence)));
    if (settled) done.push(...ledger.resolveOwnerPending({ botId, key: item.key, by: "owner", note: ROUTINE_ASK_OWNER_THREAD_NOTE }));
  }
  return done;
}
export const ROUTINE_ASK_OWNER_THREAD_NOTE = "owner-thread: o dono tratou disso na conversa com o bot";

/** The run's reply: its last text of its own — a narration turned into a work note (activity) and another bot's words are no reply. */
export function routineReplyText(messages: ReadonlyArray<{ role: string; kind: string; text?: string; from?: unknown }>): string | undefined {
  return [...messages].reverse().find((message) => message.role === "bot" && message.kind === "text" && !message.from && message.text?.trim())?.text;
}

/** What applyRoutineAsks needs of the ledger (BotAutonomy). */
export interface RoutineAskLedger {
  ownerPendingOf(botId: string): OwnerPending[];
  resolvedOwnerPendingOf(botId?: string): ResolvedOwnerPending[];
  addOwnerPending(botId: string, threadId: string, input: { title: string; key: string; link?: string; why: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[]; lastSaidAt?: number; routineId?: string }): OwnerPending;
  resolveOwnerPending(match: { botId?: string; key?: string; by?: ResolvedOwnerPending["resolvedBy"]; note?: string }): OwnerPending[];
  patchOwnerPending(botId: string, id: string, patch: Partial<Pick<OwnerPending, "why" | "options" | "quietRuns" | "demotedAt" | "keptAt" | "lastSaidAt" | "routineId">>): OwnerPending | null;
}

const isRoutineItem = (item: Pick<OwnerPending, "key">) => Boolean(item.key?.startsWith(ROUTINE_ASK_KEY_PREFIX));
/** An item's key, without the mark that tells a second pendency of the same subject apart. */
const baseKey = (key: string) => key.split("~")[0]!;
/** The item says the same pendency as `ask`: the same subject, and what it asks beyond it reads alike. */
function itemIsAsk(item: Pick<OwnerPending, "key" | "why" | "title">, ask: RoutineAsk): boolean {
  if (!item.key || baseKey(item.key) !== routineAskKey(ask)) return false;
  const except = subjectWords(ask);
  const asked = quotedOf(item);
  const said = ask.what ?? ask.sentence;
  const beyond = (text: string) => [...contentWords(text)].some((word) => !except.includes(word));
  if (!beyond(asked) || !beyond(said)) return true;
  return overlap(said, asked, except) >= 0.5 || overlap(ask.sentence, asked, except) >= 0.5;
}

/** The open routine items the bot's `text` says are resolved: closed, by the bot. */
export function settleRoutineAsks(ledger: RoutineAskLedger, botId: string, text: string): OwnerPending[] {
  const done: OwnerPending[] = [];
  for (const item of ledger.ownerPendingOf(botId)) {
    if (!isRoutineItem(item) || !saysRoutineAskResolved(item, text)) continue;
    done.push(...ledger.resolveOwnerPending({ botId, key: item.key, by: "bot", note: ROUTINE_ASK_RESOLVED_NOTE }));
  }
  return done;
}

/** A routine's run ended with `text`: what it says is resolved closes, and
 * each pendency it leaves with the owner is ONE item in `threadId` (the
 * routine's conversation): the same pendency refreshes its item, another
 * one about the same subject opens its own. */
export function applyRoutineAsks(ledger: RoutineAskLedger, run: { botId: string; botName: string; routineName: string; routineId?: string; threadId: string; conversationTitle?: string; text: string; at: number } & Pick<RoutineAskContext, "ownerName" | "knownNames">): { opened: OwnerPending[]; refreshed: OwnerPending[]; resolved: OwnerPending[]; demoted: OwnerPending[]; promoted: OwnerPending[] } {
  const resolved = settleRoutineAsks(ledger, run.botId, run.text);
  const opened: OwnerPending[] = [];
  const refreshed: OwnerPending[] = [];
  const demoted: OwnerPending[] = [];
  const promoted: OwnerPending[] = [];
  const open = ledger.ownerPendingOf(run.botId);
  const itemIds = open.flatMap((item) => [item.id, ...(item.aliases ?? [])]);
  for (const ask of routineOwnerAsks(run.text, { ownerName: run.ownerName, knownNames: run.knownNames, itemIds })) {
    const mine = ledger.ownerPendingOf(run.botId);
    // the bot's own item already asks it: it names the subject, or reads like it
    const label = ask.subject.label && slug(ask.subject.label);
    if (mine.some((item) => !item.key && ((label && has(`${item.title} ${item.why ?? ""}`, label)) || overlap(ask.what ?? ask.sentence, `${item.title} ${item.why ?? ""}`) >= 0.6))) continue;
    const existing = mine.find((item) => isRoutineItem(item) && itemIsAsk(item, ask));
    // answered by the owner a moment ago, the SAME pendency: the routine is only repeating what it read before (INSP-N22 A2)
    if (!existing && ledger.resolvedOwnerPendingOf(run.botId).some((item) => item.resolvedBy === "owner" && run.at - item.resolvedAt < ROUTINE_ASK_SETTLED_MS && itemIsAsk(item, ask))) continue;
    // another pendency about a subject that already has one: its own key
    const base = routineAskKey(ask);
    const taken = new Set([...mine, ...ledger.resolvedOwnerPendingOf(run.botId)].flatMap((item) => (item.key ? [item.key] : [])));
    let key = existing?.key ?? base;
    if (!existing && taken.has(key)) {
      const words = [...contentWords(ask.what ?? ask.sentence)].filter((word) => !subjectWords(ask).includes(word)).slice(0, 3).join("-") || "outra";
      key = `${base}~${words}`;
      for (let n = 2; taken.has(key); n++) key = `${base}~${words}-${n}`;
    }
    const want = routineAskItem(ask, { botName: run.botName, routineName: run.routineName, conversationTitle: run.conversationTitle, firstAt: existing?.createdAt ?? run.at, lastAt: run.at });
    // asked again, under "Talvez já resolvido": the refresh brings it back on top (read before: the refresh replaces it)
    const wasDown = existing?.demotedAt !== undefined;
    // the same item keeps its title: a reworded repetition never renames what the owner reads
    const item = ledger.addOwnerPending(run.botId, existing?.threadId ?? run.threadId, { ...want, key, ...(existing ? { title: existing.title } : {}), ...(run.routineId ? { routineId: run.routineId } : {}) });
    (existing ? refreshed : opened).push(item);
    if (wasDown) promoted.push(item);
  }
  // the routine's other items: named again (in passing) → back on top; not named → one more quiet run (INSP-N22 r2 F2)
  const touched = new Set([...opened, ...refreshed, ...resolved].map((item) => item.id));
  const botWords = [...contentWords((run.knownNames ?? []).join(" "))];
  for (const item of ledger.ownerPendingOf(run.botId)) {
    const facts = isRoutineItem(item) && !touched.has(item.id) ? itemFacts(item) : null;
    // its routine by id (a renamed routine is the same one, INSP-N22 r3 R3); an older item without one, by the name its why quotes
    if (!facts || (item.routineId ? item.routineId !== run.routineId : facts.routineName !== run.routineName)) continue;
    // an older item matched by its routine's name keeps the id from now on (INSP-N22 r4 S4)
    if (!item.routineId && run.routineId) ledger.patchOwnerPending(run.botId, item.id, { routineId: run.routineId });
    // named, strictly: its key (ticket, issue, row, person), or 3 of its words that are not a bot's name nor the
    // routine's — "O Chief of Staff respondeu…" never keeps the rules of 30/09 alive (INSP-N22 r4 S1, real 30/09-02/10)
    const cited = sentencesOf(run.text).map(unquoted).some((sentence) => citesItem(facts, sentence, botWords));
    if (cited) {
      // read before the patch: the ledger hands its own object, and the patch changes it in place
      const wasDown = item.demotedAt !== undefined;
      // named: alive — the 48 h and the 2 runs count again from this run (INSP-N22 r3 R1), and the "não repete" note goes
      const back = ledger.patchOwnerPending(run.botId, item.id, { quietRuns: undefined, demotedAt: undefined, lastSaidAt: run.at, ...(wasDown ? { options: doneOption() } : {}), ...(item.why?.includes(STALE_MARK) ? { why: withoutNotes(item.why) } : {}) });
      if (back && wasDown) promoted.push(back);
      continue;
    }
    const quiet = ledger.patchOwnerPending(run.botId, item.id, { quietRuns: (item.quietRuns ?? 0) + 1 });
    const down = quiet ? demoteIfLetGo(ledger, quiet, run.at) : null;
    if (down) demoted.push(down);
  }
  return { opened, refreshed, resolved, demoted, promoted };
}

/** Said once and let go: 48 h without the routine saying it again AND 2 runs of it since that did not name it. */
export const ROUTINE_ASK_LET_GO_MS = 48 * 3_600_000;
export const ROUTINE_ASK_LET_GO_RUNS = 2;
export const ROUTINE_ASK_KEEP_LABEL = "Ainda vale";
const doneOption = (): OwnerPendingOption[] => [{ label: ROUTINE_ASK_DONE_LABEL, reply: "Já resolvi essa pendência." }];

/** The item goes under "Talvez já resolvido" — out of the count and the chip, never closed: it keeps "Já resolvi", and "Ainda vale" brings it back. */
function demoteIfLetGo(ledger: RoutineAskLedger, item: OwnerPending, now: number): OwnerPending | null {
  if (item.demotedAt !== undefined || (item.quietRuns ?? 0) < ROUTINE_ASK_LET_GO_RUNS) return null;
  if (now - Math.max(item.lastSaidAt ?? item.createdAt, item.keptAt ?? 0) < ROUTINE_ASK_LET_GO_MS) return null;
  return ledger.patchOwnerPending(item.botId, item.id, {
    demotedAt: now,
    options: [...doneOption(), { label: ROUTINE_ASK_KEEP_LABEL, reply: "Ainda vale: essa pendência continua comigo." }],
  });
}

/** "Ainda vale": back on top; the 48 h and the 2 runs count again from now, and the why stops asking to confirm it —
 * it says the owner did (INSP-N22 r3 R5). */
export function keepRoutineAsk(ledger: RoutineAskLedger, botId: string, id: string, now: number): OwnerPending | null {
  const why = ledger.ownerPendingOf(botId).find((each) => each.id === id)?.why;
  return ledger.patchOwnerPending(botId, id, {
    demotedAt: undefined, quietRuns: undefined, keptAt: now, options: doneOption(),
    ...(why ? { why: `${withoutNotes(why)} (você confirmou que ainda vale às ${when(now)})` } : {}),
  });
}
const STALE_MARK = "(o bot não repete desde";
/** The why without the notes the server added after it ("não repete desde…", "você confirmou…"). */
const withoutNotes = (why: string) => why.replace(/\s*\((?:o bot não repete desde|você confirmou que ainda vale)[^)]*\)/g, "");

/** The minute pass over the routine items: the one the routine stopped repeating 24 h ago says so ("(o bot não repete
 * desde 05/10; confirme se ainda vale)", INSP-N22 A8), and the one let go goes under "Talvez já resolvido" (r2 F2) —
 * still open, never closed by silence. The items changed. */
export function markStaleRoutineAsks(ledger: RoutineAskLedger & { allOwnerPending(): OwnerPending[] }, now: number): OwnerPending[] {
  const changed: OwnerPending[] = [];
  for (const item of ledger.allOwnerPending()) {
    if (!isRoutineItem(item) || !item.why) continue;
    const lastAt = item.lastSaidAt ?? item.createdAt;
    let current: OwnerPending | null = item;
    // a day after it was last said — or after the owner said it still holds
    if (now - Math.max(lastAt, item.keptAt ?? 0) >= ROUTINE_ASK_STALE_MS && !item.why.includes(STALE_MARK)) {
      current = ledger.patchOwnerPending(item.botId, item.id, { why: `${item.why}${STALE_NOTE(lastAt)}` });
      if (current) changed.push(current);
    }
    const down = current ? demoteIfLetGo(ledger, current, now) : null;
    if (down && !changed.includes(down)) changed.push(down);
  }
  return changed;
}
