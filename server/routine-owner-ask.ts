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
// when the owner answers it from "Precisa de você" (any affirmative or
// action: they are answering that item, INSP-N22 r5 T2), or when the bot
// says, in the past and of the same pendency, that it is resolved; never by
// silence — an item the routine stopped repeating says so after 24 h (A8),
// and one said once and let go is folded under "Talvez já resolvido" (r2
// F2). The owner's words in a conversation with the bot only fold it there
// too, with a note to confirm (r5 T1): which item they mean is a guess.
//
// Residual risk, accepted (INSP-N22 r5 T3, T4): telling what a routine's
// sentence or the owner's words are about is heuristic and will not match
// every pt-BR phrasing. "Named" (citesItem) still takes 3 generic words of
// an item of words, or a person with the channel of the title, as naming
// it, and keeps such an item on top; the owner's words in a conversation
// may fold the wrong item. Both err on the visible side: nothing is closed
// by a guess. Measure on real use before tuning further: items the owner
// closes by hand, items brought back by a mention, items folded by the
// owner's words.
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
  /** What the bot wrote: the asking sentence, or the list's lead and this item of it; a pronoun it opens with is
   * swapped for what it points back to ("Ela" → "A linha da Marluce (#9389)"). */
  sentence: string;
  /** The bot's own words for the why when `sentence` swapped a pronoun: the sentence before, and this one. */
  quoted?: string;
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
  /** Every bot's open items, with their titles: what a reply pointing at one is about (INSP-R13VIS F1). */
  items?: ReadonlyArray<{ id: string; title: string }>;
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

/** The sheet rows a text names, all of them: "linha 192", "L192", "linhas 76, 98 e 106" (INSP-R13VIS H1), and a cell
 * of the sheet ("H192", "B185, C185 e E185", "Atendimento!B190") — a cell only where a sheet is said ("aba!",
 * "célula", "coluna", "planilha") or beside another cell, never "o modelo A100" (G2, H2). */
function rowsIn(text: string): string[] {
  const rows: string[] = [];
  // "linhas 100 a 200": one range, one id ("100-200"), never its first row alone
  const ranged = text.replace(/(?<![\p{L}])linhas\s+(\d{1,5})\s+(?:a|at[ée])\s+(\d{1,5})(?!\d)/giu, (_all, from: string, to: string) => { rows.push(`${from}-${to}`); return " "; });
  for (const match of ranged.matchAll(/(?<![\p{L}])(?:linhas?|L)\s?(\d{1,5}(?:\s*(?:,|e)\s*(?:a\s+)?\d{1,5}(?!\d))*)(?!\d)/gu)) rows.push(...match[1]!.match(/\d+/g)!);
  const cells = [...ranged.matchAll(/(?:(?<![\p{L}\d])|!)([A-K])(\d{2,4})(?![\p{L}\d])/gu)];
  // a sheet's cell said as one: "Aba!X192", "a célula/coluna H192", a column's name ("as Observações da H192"), its
  // range, or another cell beside it — "planilha" alone is no cell ("A planilha tem 120 linhas; o modelo A100…", INSP-R13VIS)
  const sheet = /!|(?<![\p{L}])(?:c[ée]lulas?|colunas?|range|observa[çc][õo]es|solicitante|respons[áa]vel|valida[çc][ãa]o)(?![\p{L}])/iu.test(ranged) || cells.length > 1;
  if (sheet) rows.push(...cells.map((match) => match[2]!));
  return [...new Set(rows)];
}
/** The ids a text names: tickets, issues and sheet rows — another one is another pendency. */
function idsIn(text: string): { ticket: string[]; issue: string[]; linha: string[] } {
  return {
    ticket: [...text.matchAll(/(?<![\w-])([A-Z]{2,6}-\d{4,8}-\d{2,6})(?![\w-])/g)].map((match) => slug(match[1]!)),
    // "#9400", and "PR 9400", "PR #9400", "issue 9400" (INSP-R13VIS G2)
    issue: [...text.matchAll(/(?<![\w/])#(\d{3,6})(?!\d)|(?<![\p{L}])(?:PR|pull\s+request|issue)\s+#?(\d{3,6})(?!\d)/giu)].map((match) => (match[1] ?? match[2])!),
    linha: rowsIn(text),
  };
}

// "como você decidiu às 11:05" tells a decision taken, never one asked (R13-visual N26, real o16 of 06/10)
const DECIDE = /(?<![\p{L}])(?:decis[ãa]o|decid(?!(?:i|iu|imos|iram|ido|ida|idos|idas)(?![\p{L}]))\p{L}*)/iu;
/** A decision already taken, said of the whole sentence: "como você decidiu", "como combinado", "conforme você pediu". */
const PAST_DECISION = /(?<![\p{L}])(?:voc[êe]\s+(?:j[áa]\s+)?(?:decidiu|escolheu|aprovou)|(?:como|conforme)\s+(?:voc[êe]\s+)?(?:decidiu|pediu|combinamos|combinado|definiu)|j[áa]\s+decidid[oa])(?![\p{L}])/iu;
/** Someone agreed, and what they agreed to follows: "O Chief concordou: …", "o Filipe concordou que …" — never
 * "concordou com o plano, e a decisão … fica com você", another clause (INSP-R13VIS A2). */
// "concordou com você: …" and "concordou, e a #9389 fica com você" too (INSP-R13VIS B1)
const AGREED_TO = /(?<![\p{L}])concord(?:ou|aram)(?:\s+com\s+(?:voc[êe]|\S+))?(?:\s*[:,]|\s+que(?![\p{L}]))/iu;
/** A decision said as still to be made: "decidir", "decisão", "escolha" — not one already made ("foi decisão sua",
 * "a decisão … foi sua", "decisão tomada", "já resolvida"). */
const DECISION_TAKEN = /(?<![\p{L}])(?:foi|foram|ficou|ficaram|era|tinha\s+sido|tomad[oa]s?|registrad[oa]s?|j[áa])(?![\p{L}])/iu;
const decisionAsked = (clause: string) => (DECIDE.test(clause) || /(?<![\p{L}])escolh(?:a|er)(?![\p{L}])/iu.test(clause)) && !DECISION_TAKEN.test(clause);
/** The sentence reports a decision taken: said of it all, or an agreement whose content holds the ask — not one
 * followed by another clause that leaves a decision with the owner ("concordou, e a decisão da #9389 fica com você",
 * "…, e decidir a #9389 fica com você"; INSP-R13VIS D2); "concordou, e a #9389 fica com você" stays a report (B1). */
function reportsDecision(sentence: string, owner: ReturnType<typeof ownerByName>): boolean {
  if (PAST_DECISION.test(sentence)) return true;
  const agreed = AGREED_TO.exec(sentence);
  if (!agreed || agreed.index >= askIndex(sentence, owner)) return false;
  const after = sentence.slice(agreed.index + agreed[0].length);
  // or an action left to the owner ("…, e cabe a você aprovar a #9389")
  return !(/^\s*(?:e|mas|por[ée]m|s[óo]\s+que)\s/iu.test(after) && (decisionAsked(after) || /(?<![\p{L}])cabe\s+a\s+voc[êe]\s+\p{L}+(?:ar|er|ir)(?![\p{L}])/iu.test(after)));
}
/** What follows an ask in its clause and takes it back, and only that: the owner did it ("…que você já mandou às
 * 11:10"), the thing asked is done, said without anyone named ("…e isso já está registrado", "…a #9400, já
 * resolvida"), or it holds only under a condition ("…apenas se mudar algo"). Someone else having done something
 * ("…que o Lead já aprovou", "…o Jev já liberou o push"), a cause ("porque …", "já que …") or "já com", "já pode",
 * "que já passou no gate" tell why it is asked, and never take it back (INSP-R13VIS B2, C1, D1). An item too many
 * costs the owner one click; an ask lost costs the ask. */
const YOU_DID = /(?<![\p{L}])voc[êe]\s+j[áa]\s+(?:mandou|enviou|respondeu|aprovou|resolveu|deu|fez|registrou|liberou|gravou|decidiu|escolheu|confirmou)(?![\p{L}])/iu;
const DONE_PASSIVE = /(?<![\p{L}])j[áa]\s+(?:(?:foi|foram|est[áa]|est[ãa]o|ficou|ficaram)\s+)?(?:enviad|aprovad|registrad|resolvid|respondid|feit|dad|atendid|liberad|encaminhad|gravad|decidid|confirmad)[oa]s?(?![\p{L}])/iu;
const ONLY_IF = /(?<![\p{L}])(?:s[óo]|apenas|somente)\s+se(?![\p{L}])/iu;
function takesBack(clause: string): boolean {
  if (YOU_DID.test(clause) || ONLY_IF.test(clause)) return true;
  const passive = DONE_PASSIVE.exec(clause);
  if (!passive) return false;
  const before = clause.slice(0, passive.index);
  // "porque a Marluce já…", "que o Lead já…": a cause, or someone named who did it
  return !/(?<![\p{L}])(?:porque|pois|j[áa]\s+que)(?![\p{L}])/iu.test(before) && !/(?:^|\s)(?:[OoAa]s?\s+)?\p{Lu}[\p{L}]+\s+$/u.test(before);
}
/** An imperative or a question: asked whatever follows it. */
const NEVER_TAKEN_BACK = /^(?:decida|confirme|responda|aprove|escolha|libere|me\s+(?:diga|avise|confirme|responda|passe)|\?)$/iu;
/** A decision named as the ask ("decisão sua", "sua decisão"): asked only while it is not said to be taken already. */
const DECISION_NOUN = /^(?:decis[ãa]o|(?:a\s+)?sua\s+decis[ãa]o)/iu;
/** The owner is asked for something in so many words, and the clause does not take it back. */
function explicitAsk(text: string): boolean {
  for (const match of text.matchAll(new RegExp(EXPLICIT_REQUEST.source, "giu"))) {
    if (NEVER_TAKEN_BACK.test(match[0])) return true;
    const rest = text.slice(match.index! + match[0].length);
    const clause = rest.slice(0, rest.search(/[;.!]|$/));
    // "a escala foi decisão sua", "a decisão sobre o prazo foi sua, ontem" (INSP-R13VIS D3)
    if (DECISION_NOUN.test(match[0])) {
      const whole = text.slice(Math.max(0, text.lastIndexOf(";", match.index!) + 1), match.index! + match[0].length) + clause;
      if (DECISION_TAKEN.test(whole)) continue;
    }
    if (!takesBack(clause)) return true;
  }
  return false;
}
/** The routine left it alone because it is the owner's: "continua com você, então não mexi". */
const LEFT_ALONE = /(?<![\p{L}])(?:continua|continuam|fica|ficam|segue|seguem)\s+com\s+voc[êe](?![\p{L}])[^.!?]*?(?<![\p{L}])(?:n[ãa]o\s+(?:mexi|mexo|mexerei|vou\s+mexer|toquei|toco|alterei|altero)|deixei\s+como\s+est(?:á|a|ava))(?![\p{L}])/iu;
/** The owner asked for something in so many words: an imperative, "preciso que", "preciso do seu GO", "aguardo seu
 * OK", "falta o seu GO", "falta você aprovar", "depende de você", a question (INSP-R13VIS A2). */
const EXPLICIT_REQUEST = /(?<![\p{L}])(?:preciso\s+que|precisamos\s+que|(?:preciso|precisamos|precisa|precisam)\s+d[oa]\s+(?:seu|sua)|aguardo\s+(?:o\s+|a\s+)?(?:seu|sua)|falta(?:m)?\s+(?:o\s+seu|a\s+sua|voc[êe])|depende(?:m)?\s+(?:s[óo]\s+)?(?:de\s+voc[êe]|d[ao]\s+(?:sua|seu))|decis[ãa]o\s+(?:sua|sobre|de\s+voc[êe])|(?:a\s+)?sua\s+decis[ãa]o|decida|confirme|responda|aprove|escolha|libere|me\s+(?:diga|avise|confirme|responda|passe)|pode\s+(?:me\s+)?(?:confirmar|dizer|decidir|aprovar|responder|liberar))(?![\p{L}])|\?/iu;
/** A pronoun and nothing else ("ela", "Isso"). */
const BARE_PRONOUN = /^\s*(?:el[ae]s?|isso|isto|aquilo|ess[ae]s?|est[ae]s?)\s*$/iu;
/** A sentence whose subject is a pronoun ("Ela continua com você, então não mexi."): what it is about was said before it. */
const PRONOUN_START = /^\s*(?:el[ae]s?|isso|isto|aquilo|(?:ess|est)[ae]s?(?=\s+(?:continua|fica|segue|depende|est[áa]|precisa|aguarda|espera)))(?![\p{L}])/iu;
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
  // "linhas 76, 98 e 106": one pendency about the three rows, by its key and its label (INSP-R13VIS H1)
  if (ids.linha.length > 1) return { subject: { kind: "linha", id: ids.linha.join("+"), label: `linhas ${ids.linha.slice(0, -1).join(", ")} e ${ids.linha.at(-1)}` }, ...extra };
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
/** Where the sentence asks the owner (the conversation detector's reading); -1 when it does not. */
const askIndex = (sentence: string, owner: ReturnType<typeof ownerByName>) => ownerAskIndex(sentence, owner?.asks);
function asks(sentence: string, next: string | undefined, owner: ReturnType<typeof ownerByName>): boolean {
  const at = askIndex(sentence, owner);
  if (at < 0) return false;
  if (underCondition(sentence, at)) return false;
  // reported: "X disse que … depende de você" — the ask is in what X said (the clause of the ask, before it)
  if (REPORTED.test(sentence.slice(0, at).slice(sentence.slice(0, at).lastIndexOf(";") + 1))) return false;
  // the owner by name, denied ("Nada está aguardando o Osvaldo"), with nothing else asking
  if (owner?.denies.test(sentence) && !asksOwnerSentence(sentence)) return false;
  if (/\?\s*$/.test(sentence) && next && /^n[ãa]o\b/iu.test(next)) return false;
  return true;
}

/** What a pronoun that opens `sentence` points back to, in its paragraph (a list's item is a paragraph of its own):
 * the subject of the sentence right before it — an article and what it names, up to the id it carries ("A linha da
 * Marluce (#9389)", "a Daiane", "o Redator KB Nuria") — when it agrees with the pronoun (ela/a, ele/o; isso, any);
 * else the subject of the one before that; else nothing, and the sentence stays as the bot said it. A fact the bot
 * tells of itself ("Fechei a #9403", "Abri então uma sessão…", "Pedido: …") has no such subject (INSP-R13VIS A3). */
function antecedentSubject(sentence: string, before: readonly string[], line: string, linesBefore: readonly string[], exclude: ReadonlySet<string>): { label: string; antecedent: string } | null {
  const candidates = [...before].reverse();
  // the sentence opens a line that is no list's item: the lines before it, up to a blank line or a list
  if (!before.length && !LIST_ITEM.test(line)) {
    for (let at = linesBefore.length - 1; at >= 0 && linesBefore[at]!.trim() && !LIST_ITEM.test(linesBefore[at]!); at--) {
      candidates.push(...splitSentences(plainLine(linesBefore[at]!)).reverse());
    }
  }
  const pronoun = PRONOUN_START.exec(sentence)![0].trim().toLowerCase();
  const gender = /^el[ae]s?$/.test(pronoun) ? (pronoun.startsWith("ela") ? "a" : "o") : /^(?:ess|est)[ae]s?$/.test(pronoun) ? (pronoun.endsWith("a") || pronoun.endsWith("as") ? "a" : "o") : null;
  for (const candidate of candidates.slice(0, 2)) {
    // "Osvaldo, o Redator…": the vocative is not the subject
    const said = unquoted(candidate).replace(new RegExp(`^(?:${[...exclude].map(escape).join("|") || "\\b\\B"})\\s*,\\s*`, "iu"), "").replace(/^\p{Lu}\p{Ll}+,\s+/u, "");
    const label = subjectLabel(said);
    // "isso" points at a thing the bot named by its id, never at a name ("O Chat ficou quieto. Isso…" is not the Chat)
    if (label && (gender ? label.article === gender : label.id)) return { label: label.text, antecedent: candidate };
  }
  return null;
}
/** The subject a sentence opens with, when it names something: an article, and either the id it carries within a
 * few words ("A linha da Marluce (#9389)", "a #9400", "o ticket ATD-202610-0042") or a name ("a Daiane", "o Redator KB Nuria"). */
function subjectLabel(sentence: string): { text: string; article: "o" | "a"; id: boolean } | null {
  const opening = /^([OoAa])s?\s+/u.exec(sentence);
  if (!opening) return null;
  const article = opening[1]!.toLowerCase() as "o" | "a";
  const id = /^[OoAa]s?\s+[^.,;:!?]{0,50}?(?:#\d{3,6}|(?:linha|L)\s?\d{1,5}|[A-Z]{2,6}-\d{4,8}-\d{2,6})(?:\s*\([^)]{0,80}\))?\)?/u.exec(sentence)?.[0];
  // "A Marluce pediu a #9400" opens with who did something, not with the thing
  if (id && !/(?<![\p{L}])(?:\p{Ll}+(?:ou|eu|iu|aram|eram|iram)|que)\s/u.test(id)) return { text: id.replace(/\s*\(https?:\/\/[^)\s]+\)/g, ""), article, id: true };
  const name = new RegExp(`^[OoAa]s?\\s+(${NAME}(?:\\s+(?:[A-Z]{2,}|\\p{Lu}\\p{Ll}+)){0,2})`, "u").exec(sentence);
  return name ? { text: `${opening[0]}${name[1]}`.trim(), article, id: false } : null;
}
/** The bot's own colon, never one inside a quote ('no item o1 de "Precisa de você": ajustar…'); -1 when none. */
function colonOutsideQuotes(text: string): number {
  let quote: string | null = null;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (quote) { if (char === quote || (quote === "“" && char === "”") || (quote === "«" && char === "»")) quote = null; continue; }
    if (char === "\"" || char === "“" || char === "«") quote = char;
    else if (char === ":") return at;
  }
  return -1;
}

/** The bot says, in so many words, that it opened no item ("Não abri item para essas pastas"). */
const NO_ITEM_OPENED = /(?<![\p{L}])n[ãa]o\s+(?:abri|criei)\s+(?:o\s+|um\s+|nenhum\s+|novo\s+)?(?:item|pend[êe]ncia)(?![\p{L}])/iu;
/** The bot points at an item that holds the ask: one it names by id ("já está no item o1", "a pendência é a o15",
 * "no o20 falta…") — only when that item is open, any bot's — or one it says is where the owner decides ("é lá que
 * você decide", "use o item em Precisa de você"). */
const ITEM_BY_ID = /(?:(?<![\p{L}])(?:no\s+item|no|na\s+pend[êe]ncia|(?:a\s+)?pend[êe]ncia\s+é\s+a|j[áa]\s+est[áa]\s+no\s+item|item)\s+|\()(o\d+)(?![\p{L}\d])/giu;
const ITEM_WHERE_DECIDED = /(?<![\p{L}])(?:é\s+l[áa]\s+que\s+voc[êe]\s+decide|use\s+o\s+item\s+(?:em|no)\s+["“]?Precisa de voc[êe])/iu;
/** Around the ask of `index`: the lines that lead it, when it is a list's item (less indented, above it in its
 * paragraph), and the rest of what it is said in — its own line for a list's item, else the paragraph's lines that
 * are no list's items. Another item of the same list is never around it. */
function askSurroundings(lines: readonly string[], index: number): { leads: string; paragraph: string } {
  let start = index;
  while (start > 0 && lines[start - 1]!.trim()) start--;
  let end = index;
  while (end + 1 < lines.length && lines[end + 1]!.trim()) end++;
  const indent = (line: string) => /^\s*/.exec(line)![0].length;
  const join = (each: readonly string[]) => unquoted(each.map(plainLine).join(" "));
  if (!LIST_ITEM.test(lines[index]!)) return { leads: "", paragraph: join(lines.slice(start, end + 1).filter((each) => !LIST_ITEM.test(each))) };
  const leads: string[] = [];
  let depth = indent(lines[index]!);
  for (let at = index - 1; at >= start && depth >= 0; at--) {
    const each = lines[at]!;
    if (!LIST_ITEM.test(each)) { leads.unshift(each); depth = -1; } else if (indent(each) < depth) { leads.unshift(each); depth = indent(each); }
  }
  return { leads: join(leads), paragraph: join([lines[index]!]) };
}
const IDS_OF = (text: string) => { const ids = idsIn(text); return new Set([...ids.ticket, ...ids.issue.map((id) => `#${id}`), ...ids.linha.map((id) => `L${id}`)]); };
/** The ask already has its item, or the bot opened none for it — an echo, never an item of its own (INSP-R13VIS
 * E2, F1). The mark counts where the ask is said: its own sentence, or the label that leads its list — "**Decisão sua
 * (item o4):** - …", "Precisa de você (o11): feche a #9326", "Continua com você o item o1: …" — unless the ask names a
 * ticket, issue or row the item does not ("Decisão sua (item o3): aprovar o merge da #9400", the o3 about the #9374).
 * A neighbour sentence ("Atualizei o item o1…", "Está no item o5") makes an echo only of an ask with no subject of its
 * own — no id and no noun beyond pronouns and the words every ask has: "Continua com você", "Isso depende de você".
 * An ask that says what it is about opens its item whatever item the paragraph names: comparing it with the item's
 * title failed four rounds running (G1, H1, I1); at worst it is a duplicate the owner closes with one click (I1).
 * "Não abri item" and "é lá que você decide" count in the ask's own sentence only, for an ask that names nothing,
 * and never across a "mas" ("Não abri item novo, mas preciso que você aprove…"). */
function echoesItem(ask: string, same: string, neighbours: string, items: ReadonlyMap<string, string>): boolean {
  const asked = IDS_OF(ask);
  const near = (id: string) => {
    if (!items.has(id)) return false;
    const held = IDS_OF(items.get(id)!);
    return !asked.size || [...asked].some((each) => held.has(each)) || !held.size;
  };
  if ([...same.matchAll(ITEM_BY_ID)].some((match) => near(match[1]!.toLowerCase()))) return true;
  const subjectless = !asked.size && !subjectNouns(ask).size;
  if (subjectless && !/(?<![\p{L}])(?:mas|por[ée]m|s[óo]\s+que)(?![\p{L}])/iu.test(same) && (NO_ITEM_OPENED.test(same) || ITEM_WHERE_DECIDED.test(same))) return true;
  return subjectless && [...neighbours.matchAll(ITEM_BY_ID)].some((match) => items.has(match[1]!.toLowerCase()));
}
/** The nouns that say what an ask is about — content words, names ("o Matheus", "o Chat") and acronyms ("o OK", "o
 * MCP") — not a verb, a pronoun, nor the words every ask has: an ask with none ("Continua com você", "Isso depende de
 * você") is about whatever the paragraph points at. */
function subjectNouns(text: string): Set<string> {
  const acronyms = [...text.matchAll(/(?<![\p{L}\d])([A-Z][A-Z\d]{1,4})(?![\p{L}\d])/gu)].map((match) => match[1]!.toLowerCase());
  return new Set([...[...contentWords(text)].filter((word) => !/(?:ar|er|ir)$/.test(word)), ...acronyms].filter((word) => !ASK_WORDS.has(word) && !/^\d+$/.test(word)));
}
/** Words any ask says, whatever it is about. */
const ASK_WORDS = new Set(["depende", "dependem", "dependendo", "precisa", "precisam", "preciso", "decidir", "decisao", "aprovar", "falta", "item", "itens", "voce", "osvaldo", "pendencia", "pedido", "comando", "comandos", "passo", "agora", "ainda", "issue", "issues", "continua", "continuam", "fica", "ficam", "segue", "seguem", "dois", "duas", "tres"]);

/** What the routine's reply leaves with the owner: one ask per pendency —
 * one per item of a list it leads ("Ainda dependem de você: - abrir… -
 * responder… - aprovar…") — never a denial, a condition, a quote, an echo
 * of an item the owner already has, nor a sentence that only says the item
 * exists. */
export function routineOwnerAsks(text: string, context: RoutineAskContext = {}): RoutineAsk[] {
  const owner = ownerByName(context.ownerName);
  const exclude = new Set([...(context.knownNames ?? []).flatMap((name) => name.toLowerCase().split(/\s+/)), ...(context.ownerName ? [context.ownerName.trim().split(/\s+/)[0]!.toLowerCase()] : [])]);
  // every bot's open items, by id, with what they are about (their title)
  const openItems = new Map<string, string>([...(context.itemIds ?? []).map((id) => [id.toLowerCase(), ""] as const), ...(context.items ?? []).map((item) => [item.id.toLowerCase(), item.title] as const)]);
  const lines = linesOf(text);
  const found: Array<RoutineAsk & { listed: boolean }> = [];
  const first = context.ownerName?.trim().split(/\s+/)[0];
  // "O Osvaldo precisa decidir isso": the verb is the owner's action; "isso" points at the sentence before (INSP-N22 r2 F6)
  const ownerTask = first ? new RegExp(`(?<![\\p{L}])${escape(first)}\\s+precisa\\s+(decidir|responder|aprovar|confirmar|liberar|escolher)\\s*(.*?)[.!]?$`, "iu") : null;
  const add = (sentence: string, what: string | undefined, lead: string | null, listed: boolean, before?: string, resolved?: { label: string; antecedent: string } | null) => {
    if (echoAsk(sentence, context.itemIds ?? []) && (!what || echoAsk(what, context.itemIds ?? []))) return;
    const task = !what && ownerTask ? ownerTask.exec(sentence) : null;
    // "Ela continua com você": only the subject is inherited, the pronoun swapped for it ("A linha da Marluce (#9389)
    // continua com você"); the ask is still this sentence, and the why quotes the one before too (INSP-R13VIS A3)
    let quoted: string | undefined;
    if (!task && resolved) {
      quoted = `${resolved.antecedent} ${sentence}`;
      sentence = sentence.replace(PRONOUN_START, resolved.label);
    }
    if (task) {
      // "isso": what the sentence before says, to decide; else the owner's own verb and its object ("Decidir isso", "Aprovar a PR")
      if (/^(?:isso|isto|aquilo|essa|esse|esta|este|a respeito)?$/iu.test(task[2]!.trim()) && before) {
        what = before;
        if (/^decid/i.test(task[1]!)) lead = lead ?? task[0];
      } else what = `${task[1]} ${task[2]}`.trim();
    }
    // a list's item is its own pendency; a sentence is about all it says (its lead names the conversation: "A conversa do widget continua com você: …")
    const about = unquoted(listed && what ? what : sentence);
    let subject = subjectOf(about, exclude);
    // "Fechei a #9400, e a #9401 depende de você": the id of the clause that asks, not the first one told
    if (!listed && (subject.subject.kind === "ticket" || subject.subject.kind === "issue" || subject.subject.kind === "linha")) {
      const at = askIndex(about, owner);
      const before = at > 0 ? about.slice(0, at) : "";
      const cut = Math.max(before.lastIndexOf(";"), before.search(/,\s+(?:e|mas)\s+(?![\s\S]*,\s+(?:e|mas)\s+)/u));
      if (cut > 0 && toldFact(about.slice(0, cut))) {
        const own = subjectOf(about.slice(cut), exclude);
        if (own.subject.kind !== "frase") subject = { ...subject, subject: own.subject };
      }
    }
    // the person it is owed to, said only in the lead ("A conversa do widget continua com você: … falar com o Luis Rossi")
    const people = subject.people ?? peopleIn(unquoted(sentence), exclude);
    const link = /https?:\/\/[^\s)>\]]+/.exec(sentence)?.[0]?.replace(/[.,;:]+$/, "");
    found.push({ sentence, ...(quoted ? { quoted } : {}), ...(what ? { what } : {}), decide: DECIDE.test(lead ?? sentence) || /(?<![\p{L}])a\s+escolha\s+d[aeo]s?\s/iu.test(lead ?? sentence), ...subject, ...(people ? { people } : {}), ...(link ? { link } : {}), listed });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = plainLine(lines[index]!);
    const sentences = splitSentences(line);
    const around = askSurroundings(lines, index);
    sentences.forEach((original, at) => {
      const sentence = unquoted(original);
      if (!asks(sentence, sentences[at + 1], owner)) return;
      // a list it leads: each of its items is a pendency of its own (INSP-N22 A9) — listed, it is asked in so many
      // words, whatever the lead adds ("Como combinado, ainda dependem de você: - …", INSP-R13VIS A1)
      if (/:\s*$/.test(original) && at === sentences.length - 1) {
        const items: string[] = [];
        let next = index + 1;
        while (next < lines.length && !lines[next]!.trim()) next++;
        while (next < lines.length && LIST_ITEM.test(lines[next]!)) items.push(plainLine(lines[next++]!));
        if (items.length) {
          // an item the label of its list points at an open item for ("**Decisão sua (item o4):** - …") is an echo
          for (const item of items) if (!echoesItem(unquoted(item), `${around.leads} ${sentence} ${unquoted(item)}`, "", openItems)) add(`${original} ${item}`, item, original, true);
          index = next - 1;
          return;
        }
        // a paragraph after it: its first sentence is the ask
        const after = lines.slice(index + 1).map(plainLine).find((each) => each);
        const first = after ? splitSentences(after)[0] ?? after : undefined;
        if (first && !echoesItem(unquoted(first), `${around.leads} ${sentence} ${unquoted(first)}`, "", openItems)) add(`${original} ${first}`, first, original, false);
        return;
      }
      // a report, not an ask: a decision already taken ("como você decidiu às 11:05", "O Chief concordou: …"), or what
      // the routine left alone because it is the owner's ("continua com você, então não mexi") — unless the owner is
      // asked for something in so many words (R13-followup 1: o16 and o17 of 06/10; INSP-R13VIS A2)
      if (reportsDecision(sentence, owner) && !explicitAsk(sentence)) return;
      if (LEFT_ALONE.test(sentence) && !explicitAsk(unquoted(line))) return;
      // "Ainda dependem do Osvaldo: a abertura da issue…" — what is left, after the ask that leads it; the colon is
      // the bot's own, never one inside a quote ('no item o1 de "Precisa de você": ajustar…', INSP-R13VIS A3)
      const colon = colonOutsideQuotes(original);
      const lead = colon > 0 && colon < 80 && asksOwnerSentence(unquoted(original.slice(0, colon)), owner?.asks) ? original.slice(0, colon) : null;
      const what = lead !== null && original.slice(colon + 1).trim().length > 8 ? original.slice(colon + 1).trim() : undefined;
      // the ask already has its item, or the bot opened none for it (INSP-R13VIS E2, F1)
      if (echoesItem(unquoted(what ?? original), `${around.leads} ${sentence}`, around.paragraph.replace(sentence, " "), openItems)) return;
      const resolved = PRONOUN_START.test(sentence) ? antecedentSubject(sentence, sentences.slice(0, at), lines[index]!, lines.slice(0, index), exclude) : null;
      add(original, what, lead, false, sentences[at - 1] ?? lines.slice(0, index).map(plainLine).filter(Boolean).at(-1), resolved);
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
  // a link's target is no title ("a linha da Marluce (#9389 (https://…))" → "(#9389)"), nor the sentence's full stop
  const plain = text.replace(/\s*\(https?:\/\/[^\s)]+\)/g, "");
  // "a #9400" has no word ownerAskText keeps: the text itself, then
  const said = (ownerAskText(plain, max) || plain.trim()).replace(/(?<!\.)\.$/, "");
  if (!said.endsWith("…")) return said;
  return `${said.slice(0, -1).replace(/(?:\s+(?:de|da|do|das|dos|a|o|as|os|e|ou|em|no|na|com|para|pra|por|que|se|um|uma|ao|à))+$/iu, "").replace(/[\s,;:–—-]+$/, "")}…`;
}
const toPerson = (person: { name: string; article: "o" | "a" | null }) => `${person.article === "o" ? "ao " : person.article === "a" ? "à " : ""}${person.name}`;
const withPerson = (person: { name: string; article: "o" | "a" | null }) => `${person.article === "o" ? "o " : person.article === "a" ? "a " : ""}${person.name}`;
const lower = (text: string) => text.charAt(0).toLocaleLowerCase("pt-BR") + text.slice(1);

/** A short title, plain pt-BR: "Responder ao Luis Rossi (widget)", "Decidir: …", else what is left with the owner —
 * and the ticket, issue or row it is about, when the words kept do not name it ("Ver: falta o seu GO (#9400)"). */
export function routineAskTitle(ask: RoutineAsk): string {
  const title = askTitle(ask);
  const { kind, label } = ask.subject;
  // "o merge da PR 9400" names the #9400 already
  // "o merge da PR 9400" names the #9400 already, "a linha 12 e a 13" the rows 12 and 13
  const said = (number: string) => new RegExp(`(?<!\\d)${number}(?!\\d)`).test(title);
  if (!label || !(kind === "ticket" || kind === "issue" || kind === "linha") || slug(title).includes(slug(label)) || (kind === "issue" && said(ask.subject.id)) || (kind === "linha" && ask.subject.id.split(/[+-]/).every(said))) return title;
  return `${title.replace(/…$/, "").replace(/[\s,;:–—-]+$/, "")}${title.endsWith("…") ? "…" : ""} (${label})`;
}
function askTitle(ask: RoutineAsk): string {
  const people = ask.people ?? [];
  if (!ask.decide && people.length && TALK.test(ask.what ?? ask.sentence)) {
    const names = people.map(toPerson).join(" e ");
    // no article said ("falar com Filipe"): no preposition guessed either
    return `${people.every((each) => each.article) ? `Responder ${names}` : `Falar com ${people.map((each) => each.name).join(" e ")}`}${ask.context ? ` (${ask.context})` : ""}`;
  }
  // the clause that asks, not what the sentence adds after a ";" ("…; hoje de manhã falei com o Filipe sobre outra coisa")
  const clause = ask.what ?? ask.sentence.split(/;\s*/).find((each) => asksOwnerSentence(each)) ?? ask.sentence;
  // "Fica com você decidir a escala" → "decidir a escala"
  let said = /^\s*(?:fica|ficam|continua|continuam)\s+com\s+voc[êe]\s+(\p{L}+(?:ar|er|ir)(?![\p{L}]).*)$/iu.exec(clause)?.[1] ?? clause;
  // "Osvaldo, a #9314 travou…": the vocative is who, not what
  said = said.replace(/^\s*\p{Lu}\p{Ll}+,\s+(?=[oa]s?\s|#)/u, "");
  // "Não abri item novo, mas preciso…", "Não abri item novo: o merge…": what the bot did not do is not the title (INSP-R13VIS F1)
  said = said.replace(/^\s*n[ãa]o\s+(?:abri|criei)\s+[^,:;]*?(?:,\s*(?:mas|por[ée]m|s[óo]\s+que)\s+|:\s*)/iu, "");
  // "O Chief concordou, e cabe a você aprovar a #9389" → "Aprovar a #9389" (INSP-R13VIS E3)
  said = said.replace(/^\s*(?:[^,.;:]{1,60},\s*(?:e\s+)?)?cabe\s+a\s+voc[êe]\s+(?=\p{L}+(?:ar|er|ir)(?![\p{L}]))/iu, "");
  // "Essa decisão de produto é sua" → "a decisão de produto" (INSP-R13VIS E3)
  said = said.replace(/^\s*(?:essa|esta)\s+(decis[ãa]o\s+(?:de|do|da|dos|das)\s+[^,.;:]+?)\s+é\s+sua(?![\p{L}])[.!]?\s*$/iu, "a $1");
  // "Como combinado, aguardo seu OK…": the decision taken is how it was said, not what is asked
  said = said.replace(/^\s*(?:como|conforme)\s+(?:voc[êe]\s+)?(?:combinado|combinamos|pediu|decidiu|definiu)[^,]{0,30},\s*/iu, "");
  // "O Chief concordou: a linha da Marluce (#9389) fica com você" — a fact told before the colon is no label: what follows is the subject (R13-visual N26, real o16)
  const told = /^([^:]{3,70}):\s+(\S.*)$/su.exec(said);
  if (told && PAST_CLAUSE.test(told[1]!)) said = told[2]!;
  // a fact told in the past is no title: the subject it names, if any (INSP-R13VIS A4); else routineAskItem says whose message it is
  // with the article the bot used ("Ver: a #9314", INSP-R13VIS C3)
  if (toldFact(said) && ask.subject.label) {
    // the article right before the id, wherever it is ("concordou que a #9400 precisa…" → "a #9400")
    // "da #9389", "na #9389": the article inside the contraction
    const article = new RegExp(`(?<![\\p{L}])(?:[dn]|pel)?([oa]s?)\\s+${escape(ask.subject.label)}(?![\\p{L}\\d])`, "iu").exec(said)?.[1];
    return `${ask.decide ? "Decidir" : "Ver"}: ${article ? `${article.toLowerCase()} ` : ""}${ask.subject.label}`;
  }
  // a one-word tag before the colon is no subject ("o17: a worktree da #9378…", "Jev: liberar push…"): what follows
  // is, with the tag after it — never an item's own id, which the owner sees beside it already (INSP-R13VIS B5)
  const tag = /^\s*([\p{L}\d#_-]{1,12}):\s+(\S.*)$/su.exec(said);
  const itemId = Boolean(tag && /^o\d+$/iu.test(tag[1]!));
  if (tag && tag[2]!.trim().length > 8 && (itemId || (/\p{L}/u.test(tag[1]!) && ACTION_START.test(tag[2]!) && !STATEMENT_START.test(tag[2]!)))) {
    // the words that leave it with the owner are not the action ("liberar push da #9295 depende de você", INSP-R13VIS C2)
    const action = withoutAsk(tag[2]!.trim()) || tag[2]!.trim();
    const rest = askTitle({ ...ask, what: action, sentence: action });
    // the bot's own voice ("Recomendo:", "Sugiro:") names nothing; a cut title keeps its "…" last
    const voice = /^(?:recomendo|sugiro|proponho|prefiro|acho|ou|e)$/iu.test(tag[1]!);
    return itemId || voice || rest.endsWith("…") || slug(rest).includes(slug(tag[1]!)) ? rest : `${rest.replace(/\.$/, "")} (${tag[1]})`;
  }
  // "A decisão sobre a escala do Lead ficou com você: ele cobre 24/7…?" → "Decidir: a escala do Lead" (INSP-R13VIS E3)
  // — "a decisão de produto da #9356" keeps its words: only "sobre" gives way to what it is about
  const leftDecision = /^\s*(?:a|essa|esta)\s+decis[ãa]o\s+sobre\s+(.+?)\s+(?:fica|ficou|continua|segue|é)\s+(?:com\s+voc[êe]|sua)(?![\p{L}])/iu.exec(said);
  if (leftDecision) return `Decidir: ${lower(clipTitle(leftDecision[1]!, 90))}`;
  // already an action for the owner: a question to decide ("Posso escrever…?"), or a verb ("Abrir a issue…", "Aprovar a #9370")
  if (ask.decide && (ask.what || /\?\s*$/.test(said)) && !/^\s*decid/iu.test(said)) return `Decidir: ${lower(clipTitle(said, 100))}`;
  if (ACTION_START.test(said) && !STATEMENT_START.test(said)) return clipTitle(said.charAt(0).toLocaleUpperCase("pt-BR") + said.slice(1));
  // "Três vigias permanentes (…): não posso armar…" — a label, then the bot's own statement: the label is what to look at
  const label = /^([^:]{3,70}):\s+\S/.exec(said)?.[1];
  if (label && !asksOwnerSentence(label)) return `${ask.decide ? "Decidir" : "Ver"}: ${lower(clipTitle(label, 90))}`;
  // a statement: what it is about, without the words that leave it with the owner
  // ("O comentário na #9331 está aguardando o Osvaldo" → "Ver: o comentário na #9331")
  // "O cliente se queixou de novo e a resposta depende de você": the owner's action is the answer
  // "A Daiane precisa da sua decisão sobre o reembolso": what to decide, then whose ("Decidir: o reembolso (a Daiane)")
  // — not a list that only ends on it ("Continuam com você a sessão … e a decisão sobre o Lead")
  const about = ask.decide && !/^\s*(?:continua|continuam|fica|ficam|segue|seguem)\s/iu.test(said) ? /(?<![\p{L}])decis[ãa]o\s+(?:sobre|quanto\s+(?:a|ao|à)|a\s+respeito\s+d[aeo])\s+(.+?)\.?$/iu.exec(said) : null;
  if (about) {
    const whose = withoutAsk(said);
    const what = withoutAsk(about[1]!) || about[1]!;
    // a pronoun nothing before it agreed with says nobody: "Decidir: o reembolso", never "(ela)" (INSP-R13VIS B3)
    const named = whose && whose !== said && !DECIDE.test(whose) && !BARE_PRONOUN.test(whose) && whose.split(/\s+/).length <= 5;
    return `Decidir: ${lower(clipTitle(what, 70))}${named ? ` (${lower(whose)})` : ""}`;
  }
  const answer = /^(.+?),?\s+(?:e|ent[ãa]o|mas)\s+a\s+resposta$/iu.exec(withoutAsk(said));
  if (answer && !ask.decide) return `Responder: ${lower(clipTitle(answer[1]!, 90))}`;
  let subject = (withoutAsk(said) || said).replace(/,?\s*(?:ent[ãa]o|e|mas)?\s*(?:a|o)\s+(?:decis[ãa]o|resposta|escolha)\s*$/iu, "").trim();
  // nothing left but "a decisão": what the sentence says before it ("A Marluce pediu que a escala se mantenha; a decisão fica com você")
  if (![...contentWords(subject)].some((word) => !["decisao", "resposta", "escolha"].includes(word))) subject = ask.sentence.split(/;\s*/)[0]!.trim();
  else if (withoutAsk(said) !== said) subject = askedNoun(subject);
  return `${ask.decide ? "Decidir" : "Ver"}: ${lower(clipTitle(subject, 90))}`;
}
/** What the ask is about, first: the noun right before the words that left it with the owner ("… e a resposta depende
 * de você" → "a resposta"), with what led to it after, in parentheses; an opening adverb ("Até agora,", "Desde
 * ontem,") dropped (INSP-N22 r3 R5). */
function askedNoun(text: string): string {
  // split outside parentheses only: "a o2 (linha 105, #9058)" is one noun (INSP-R13VIS B5)
  const parts = splitOutsideParens(text).map((each) => each.trim()).filter(Boolean);
  const kept = parts.filter((each, at) => !(at < parts.length - 1 && (/^(?:at[ée]|desde|hoje|ontem|agora|ainda|tamb[ée]m|por enquanto|nesta|neste|de novo|mais uma vez)(?![\p{L}])/iu.test(each)
    // another thing, said to be done ("a o12 segue resolvida e a o2 …"), is not what is asked
    || RESOLVED.test(each)
    // someone's agreement told before it ("o Chief concordou com tudo, e a escala do Lead…") is how, not what
    || /(?<![\p{L}])concord(?:ou|aram)(?![\p{L}])/iu.test(each))));
  const main = kept.at(-1) ?? text;
  const lead = kept.slice(0, -1).join(", ");
  // a short noun phrase leads; a long one is the whole thing already
  if (!lead || main.split(/\s+/).length > 6) return kept.join(", ");
  return `${main} (${lead.charAt(0).toLocaleLowerCase("pt-BR")}${lead.slice(1)})`;
}
/** The text split at ", " and " e ", never inside parentheses. */
function splitOutsideParens(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (depth) continue;
    // ", e a escala…" is one cut, never one that leaves the "e" leading a part
    // never between numbers: "as linhas 185 e 186", "76, 98 e 106" are one noun
    if (/\d/.test(text[at - 1] ?? "") && /^(?:,\s+|\s+e\s+)(?:[ao]s?\s+)?\d/.test(text.slice(at))) continue;
    const cut = /^(?:,\s+e\s+(?=[oa]s?\s)|,\s+|\s+e\s+)/u.exec(text.slice(at));
    if (cut) { parts.push(text.slice(start, at)); at += cut[0].length - 1; start = at + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}
/** A short clause told in the past ("O Chief concordou", "Ele confirmou", "A Marluce respondeu"). */
const PAST_CLAUSE = /^\s*(?:\p{L}+\s+){0,3}\p{Ll}+(?:ou|eu|iu|aram|eram|iram)\s*$/u;
/** A fact told in the past, with or without a colon after it: the bot's own ("Fechei a #9403", "Abri então uma
 * sessão…") or someone's ("o Redator KB Nuria mandou o levantamento", "a #9386 (hotfix) entrou na main") — what
 * happened, never what is left with the owner (INSP-R13VIS A4). */
function toldFact(text: string): boolean {
  return /^\s*(?:(?:eu|j[áa]|hoje|ontem)\s+)?(?:\p{Ll}+ei|abri|pedi|respondi|escrevi|subi|corrigi|fiz)(?![\p{L}])/iu.test(text)
    || /^\s*[OoAa]s?\s+(?:(?:\p{Lu}[\p{L}]*|#\d{3,6}|\([^)]{0,80}\))\s+){1,4}(?:j[áa]\s+)?\p{Ll}+(?:ou|eu|iu|aram|eram|iram)(?![\p{L}])/u.test(text);
}
/** An infinitive opens it: an action ("Abrir a issue", "Responder ao Filipe", "Revisar a planilha"). */
const ACTION_START = /^\s*\p{L}+(?:ar|er|ir|or)(?![\p{L}])/iu;
/** Words that end like an infinitive but open a statement. */
const STATEMENT_START = /^\s*(?:lugar|par|mar|bar|ser|ter|ir|vir|estar|haver|poder|dever|querer|saber|cor|dor|valor|favor|amor|melhor|pior|maior|menor|anterior|posterior|superior|inferior|interior|exterior)(?![\p{L}])/iu;
/** The sentence without the ask that leaves it with the owner ("… continua com você", "… depende de você", "… está aguardando o Osvaldo"). */
function withoutAsk(text: string): string {
  return text
    .replace(/,?\s*(?:que\s+)?(?:ainda\s+|também\s+|tamb[ée]m\s+)?(?:continua|continuam|fica|ficam|est[áa]|est[ãa]o|segue|seguem)\s+(?:(?:aguardando|esperando)\s+(?:por\s+)?|com\s+)(?:(?:o|a)\s+)?(?:voc[êe]|\p{Lu}\p{Ll}+)(?![\p{L}]).*$/u, "")
    .replace(/,?\s*(?:(?:isso|isto)\s+)?(?:ainda\s+|tamb[ée]m\s+|s[óo]\s+)?(?:depende|dependem|precisa|precisam)\s+(?:de\s+voc[êe]|d[ao]\s+(?:sua|seu)\s+\p{L}+|d[oa]\s+\p{Lu}\p{Ll}+).*$/u, "")
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
  const said = routineAskTitle(ask);
  // still no subject ("Ver: ela continua com você" with nothing before it): say whose message it is, never a pronoun nobody can place (R13-visual N26)
  const body = said.replace(/^(?:Ver|Decidir|Responder):\s*/u, "");
  // a question is its own subject ("Decidir: ele publica direto ou deixa em rascunho?")
  // an item's id or an issue is a subject too ("Ver: o o1 também continua com você")
  const subjectless = (PRONOUN_START.test(body) && !body.endsWith("?")) || toldFact(body) || (![...contentWords(body)].length && !/(?<![\p{L}\d])(?:o\d+|#\d{3,6})(?![\p{L}\d])/u.test(body));
  // a fact the bot told of an item it names by title ('atualizei o item o19 ("Decidir o destino de 17 worktrees")'): that title
  const named = subjectless && toldFact(body) ? /["“]([^"”]{8,90})["”]/u.exec(ask.sentence)?.[1] : undefined;
  const title = named ? (ACTION_START.test(named) ? named : `Ver: ${lower(named)}`) : subjectless ? `Ver o recado do ${origin.botName} na rotina "${origin.routineName}"` : said;
  const why = `O bot ${origin.botName}, na rotina "${origin.routineName}", escreveu: "${clipQuote(ask.quoted ?? ask.sentence)}" ${saidLine(origin.firstAt, origin.lastAt)}`;
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
  // "linhas 76, 98 e 106" (one key, "76+98+106"): any of its rows names it
  if (kind === "linha") return id.split("+").some((row) => ids.linha.includes(row));
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
  const plain = strip(sentence).toLowerCase();
  return actionMatches(facts, plain).some(({ match, verb }) => {
    // a "not" before it in its own clause ("ainda não abri"), not one of another clause ("…, não precisa mais") (INSP-N22 r4 S2)
    if (negatedBefore(plain, match.index, match[0].length)) return false;
    // and what it was asked for: a word of the ask beyond its subject, the routine's and the verb's — "Abri o ATD-0042
    // pra ver o histórico" is not "a abertura da issue" (INSP-N22 r4 S3)
    // (a ticket's, issue's, row's or person's id is the subject; an item of words is its words — those are what it asks)
    const except = [...(facts.kind === "frase" ? facts.routineWords : facts.subjectTokens), ...facts.askedIds.ticket, ...facts.askedIds.issue, verb, match[0], "abertura", "linha"];
    return sharedWords(sentence, asked, except) >= 1;
  });
}
/** The ask's own action in the owner's words (accents off): the infinitive the bot used, and the one its noun stands for
 * ("a abertura da issue" → abrir) — as an order ("arme", "abra"), a past ("armei", "abri", "armou"), a done ("aberta",
 * "escrito") or "pode escrever". */
function actionMatches(facts: NonNullable<ReturnType<typeof itemFacts>>, plain: string): Array<{ match: RegExpExecArray; verb: string }> {
  const verbs = [...new Set([...contentWords(facts.asked)].filter((word) => /^[a-z]{3,}(?:ar|er|ir)$/.test(word) && !COMMON_VERBS.has(word)).concat(NOUN_VERBS.filter(([noun]) => noun.test(facts.asked)).map(([, verb]) => verb)))];
  return verbs.flatMap((verb) => {
    const stem = verb.slice(0, -2);
    const forms = verb.endsWith("ar")
      ? [`${stem}e`, `${stem}ei`, `${stem}ou`, `${stem}em`, `${stem}ad[oa]s?`]
      : [`${stem}a`, `${stem}i`, `${stem}eu`, `${stem}iu`, `${stem}am`, `${stem}id[oa]s?`, ...(IRREGULAR_DONE[verb] ? [IRREGULAR_DONE[verb]!] : [])];
    const match = new RegExp(`(?<![a-z])(?:pode\\s+${verb}|${forms.join("|")})(?![a-z])`).exec(plain);
    return match ? [{ match, verb }] : [];
  });
}
const actionMatch = (facts: NonNullable<ReturnType<typeof itemFacts>>, plain: string) => actionMatches(facts, plain)[0];
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
/** The owner's answer from "Precisa de você", to THIS item: no object nor subject needed — they are answering it. Any
 * affirmative or action ("Pode escrever na linha 110.", "Abri a #9364…", "Conversei com o Luis Rossi…, tudo certo")
 * closes it; a question, a "not" before the verb, a wait or a part ("vai", "vou", "aguardo", "metade", "falta") keeps it
 * open and goes to the bot (INSP-N22 r5 T2). */
export function ownerAnswersItem(item: Pick<OwnerPending, "key" | "why" | "title">, text: string): boolean {
  // what only reinforces the ending is no reservation: "não precisa (mais)", "nem precisa", "sem problema", "sem pressa",
  // "ainda hoje", and the subject corrected ("é ajuste de grade, não mudança de regra"; "não é X, é Y") — INSP-N22 r7 V1
  const said = text.trim().replace(REINFORCING, " ").replace(/\s+([.,;:!])/g, "$1").trim();
  if (!said || answerWithReservation(said) || /(?<![\p{L}])depois(?!\s+d[aeo]s?(?![\p{L}]))(?![\p{L}])/iu.test(said)) return false;
  if (/(?<![\p{L}])pront[oa]\s+(?:para|pra)(?![\p{L}])/iu.test(said)) return false;
  const plain = strip(said).toLowerCase();
  const facts = itemFacts(item);
  // "sim"/"ok" alone or opening the answer; a done or the ask's own action anywhere
  const yes = /^(?:sim|ok)(?![a-z])/.exec(plain) ?? PANEL_YES.exec(plain) ?? (facts ? actionMatch(facts, plain)?.match ?? null : null);
  return Boolean(yes && !negatedBefore(plain, yes.index, yes[0].length));
}
const REINFORCING = new RegExp([
  "(?<![\\p{L}])n[ãa]o\\s+precisa(?:\\s+mais)?(?:\\s+(?!mas(?![\\p{L}]))\\p{L}+){0,4}",
  "(?<![\\p{L}])nem\\s+precisa(?:\\s+\\p{L}+){0,4}",
  "(?<![\\p{L}])(?:n[ãa]o\\s+tem|sem)\\s+(?:problema|pressa)",
  "(?<![\\p{L}])ainda\\s+hoje(?:\\s+cedo)?",
  // "é ajuste de grade, não mudança de regra" — the subject corrected after an "é …"
  "(?<=(?:^|[\\s:])[ée]\\s[^,;.!?]{1,60}),\\s*n[ãa]o\\s+[^,;.!?]{1,50}",
  // "não é mudança de regra, é ajuste de grade"
  "(?<![\\p{L}])n[ãa]o\\s+[ée]\\s+[^,;.!?]{1,50}(?=,\\s*[ée]\\s)",
].join("|"), "giu");
/** A reservation anywhere keeps the panel answer open — it goes to the bot, the item stays (INSP-N22 r6 U1): "Tentei…,
 * mas ele não atendeu", "Mandei mensagem, sem resposta", "Sim, mas ainda não falei", "Ok, deixa comigo", "Pode deixar
 * que eu cuido", "…, ele vê". */
const PANEL_RESERVATION = /(?<![\p{L}])(?:mas|por[ée]m|n[ãa]o|nem|sem|ainda|deixa comigo|pode deixar|eu cuido|eu vejo|(?:ele|ela) v[êe])(?![\p{L}])/iu;
/** The words of a panel answer that kept, or would have kept, it open: a closed item answered with one of them never
 * holds the routine back from asking it again (INSP-N22 r6 U1). */
export function answerWithReservation(text: string): boolean {
  return PANEL_OPEN.test(text) || PANEL_RESERVATION.test(text);
}
/** What keeps a panel answer open wherever it is. */
const PANEL_OPEN = /\?|(?<![\p{L}])(?:vai|vou|aguardo|aguardando|esperar|esperando|metade|parte|parcial\p{L}*|falta|faltam|faltando|amanh[ãa]|talvez|pediu|errado|errada|ignora|ignore|segunda)(?![\p{L}])/iu;
/** A done, accents off: the explicit forms ("feito", "resolvido", "aberta", "decidido", "tudo certo", "pode escrever")
 * and the verbs of an ending ("falei com", "conversei com", "respondi", "abri", "registrei", "decidi") — never any past
 * in -ei: "Liguei e ele não atendeu", "Tentei…" end nothing (INSP-N22 r6 U1). */
const PANEL_YES = /(?<![a-z])(?:feit[oa]|pront[oa]|resolvid[oa]|decidid[oa]|liberad[oa]|abert[oa]|conclu[ií]d[oa]|fechad[oa]|tudo certo|esta ok|pode [a-z]{3,}|(?:falei|conversei)(?: direto)? com|resolvi|respondi|abri|escrevi|registrei|criei|decidi|liberei|aprovei|tratei|fiz|pus)(?![a-z])/;

export function ownerEndsRoutineAsk(item: Pick<OwnerPending, "key" | "why" | "title">, text: string): boolean {
  const facts = itemFacts(item);
  if (!facts) return ownerAnswerCloses(text);
  if (facts.kind === "ticket" || facts.kind === "issue") return ownerActs(facts, text) || explicitlyClosed(text);
  return ownerAnswerCloses(text) || ownerActs(facts, text);
}

/** The owner wrote, in a conversation of the bot after the item was opened, about the same pendency (by its key), in
 * words that end it or doing what it asked: the item closes as the owner's (INSP-N22 r2 F2). */
export function ownerSettlesRoutineAsks(ledger: RoutineAskLedger, botId: string, messages: ReadonlyArray<{ at: number; text?: string }>): OwnerPending[] {
  // read in a conversation, the owner's words are a guess about which item they mean: the item is never closed by them,
  // only moved under "Talvez já resolvido" with a note — still in sight, closed by one click on "Já resolvi" (INSP-N22 r5 T1)
  const moved: OwnerPending[] = [];
  for (const item of ledger.ownerPendingOf(botId)) {
    const facts = isRoutineItem(item) && item.demotedAt === undefined ? itemFacts(item) : null;
    if (!facts) continue;
    // only what the owner wrote after the item last changed hands: opened, said again, kept ("Ainda vale") or folded —
    // an old message never undoes the owner's "Ainda vale" at the next turn's end (INSP-N22 r6 U2)
    const since = Math.max(item.createdAt, item.keptAt ?? 0, item.lastSaidAt ?? 0, item.demotedAt ?? 0);
    const said = messages.find((message) => message.at > since && sentencesOf(message.text ?? "").map(unquoted).some((sentence) =>
      isAbout(facts, sentence, "owner") && ownerEndsRoutineAsk(item, sentence)));
    if (!said) continue;
    const down = ledger.patchOwnerPending(botId, item.id, {
      demotedAt: said.at,
      options: [...doneOption(), { label: ROUTINE_ASK_KEEP_LABEL, reply: "Ainda vale: essa pendência continua comigo." }],
      ...(item.why ? { why: `${withoutNotes(item.why)} ${OWNER_THREAD_MARK} às ${when(said.at)}; confirme)` } : {}),
    });
    if (down) moved.push(down);
  }
  return moved;
}
/** The note an item moved by the owner's words in a conversation carries (INSP-N22 r5 T1). */
const OWNER_THREAD_MARK = "(você tratou disso na conversa";

/** The run's reply: its last text of its own — a narration turned into a work note (activity) and another bot's words are no reply. */
export function routineReplyText(messages: ReadonlyArray<{ role: string; kind: string; text?: string; from?: unknown }>): string | undefined {
  return [...messages].reverse().find((message) => message.role === "bot" && message.kind === "text" && !message.from && message.text?.trim())?.text;
}

/** What applyRoutineAsks needs of the ledger (BotAutonomy). */
export interface RoutineAskLedger {
  ownerPendingOf(botId: string): OwnerPending[];
  /** Every bot's open items: a routine pointing at another bot's item ("a pendência é a o15, e quem a abriu foi o
   * Chief") echoes it (INSP-R13VIS E2). */
  allOwnerPending?(): OwnerPending[];
  resolvedOwnerPendingOf(botId?: string): ResolvedOwnerPending[];
  addOwnerPending(botId: string, threadId: string, input: { title: string; key: string; link?: string; why: string; steps?: OwnerPendingStep[]; options?: OwnerPendingOption[]; lastSaidAt?: number; routineId?: string }): OwnerPending;
  resolveOwnerPending(match: { botId?: string; key?: string; by?: ResolvedOwnerPending["resolvedBy"]; note?: string }): OwnerPending[];
  /** `key`: the rows of a sheet item grown by an ask about more of them ("linha:185" → "linha:185+186", INSP-R13VIS I2). */
  patchOwnerPending(botId: string, id: string, patch: Partial<Pick<OwnerPending, "why" | "options" | "quietRuns" | "demotedAt" | "keptAt" | "lastSaidAt" | "routineId" | "key">>): OwnerPending | null;
}

const isRoutineItem = (item: Pick<OwnerPending, "key">) => Boolean(item.key?.startsWith(ROUTINE_ASK_KEY_PREFIX));
/** An item's key, without the mark that tells a second pendency of the same subject apart. */
const baseKey = (key: string) => key.split("~")[0]!;
/** The owner closed it with words that keep a reservation (their last answer in its history). */
const closedWithReservation = (item: Pick<ResolvedOwnerPending, "history">) => {
  const last = item.history?.findLast((each) => each.kind === "text");
  return Boolean(last && answerWithReservation(last.text));
};
/** The item says the same pendency as `ask`: the same subject, and what it asks beyond it reads alike. */
/** The rows of a sheet item's key ("routine-ask:linha:185+186" → 185, 186); null for any other key. */
const rowsOfKey = (key: string | undefined) => (key ? /^routine-ask:linha:([\d+-]+)$/.exec(baseKey(key))?.[1]?.split("+") ?? null : null);
const rowsKey = (rows: readonly string[]) => `${ROUTINE_ASK_KEY_PREFIX}linha:${rows.join("+")}`;
const rowsLabel = (rows: readonly string[]) => (rows.length > 1 ? `linhas ${rows.slice(0, -1).join(", ")} e ${rows.at(-1)}` : `linha ${rows[0]}`);
function itemIsAsk(item: Pick<OwnerPending, "key" | "why" | "title">, ask: RoutineAsk): boolean {
  // a sheet item is the ask about any of its rows: "linha:185" and "linhas 185 e 186" are one pendency, grown (INSP-R13VIS I2)
  const itemRows = rowsOfKey(item.key);
  const askRows = rowsOfKey(routineAskKey(ask));
  if (itemRows && askRows) { if (!itemRows.some((row) => askRows.includes(row))) return false; } else if (!item.key || baseKey(item.key) !== routineAskKey(ask)) return false;
  // "a linha 185" and "as linhas 185 e 186" say the row, not what is asked of it
  const except = [...subjectWords(ask), ...(itemRows ? [...itemRows, "linha", "linhas", "dependem"] : [])];
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
  // the ids of every bot's open items, not only its own: "no item o15" is an echo whoever opened the o15 (INSP-R13VIS E2)
  const everyOpen = ledger.allOwnerPending?.() ?? open;
  const itemIds = everyOpen.flatMap((item) => [item.id, ...(item.aliases ?? [])]);
  const items = everyOpen.flatMap((item) => [item.id, ...(item.aliases ?? [])].map((id) => ({ id, title: item.title })));
  for (let ask of routineOwnerAsks(run.text, { ownerName: run.ownerName, knownNames: run.knownNames, itemIds, items })) {
    const mine = ledger.ownerPendingOf(run.botId);
    // the bot's own item already asks it: it names the subject, or reads like it
    const label = ask.subject.label && slug(ask.subject.label);
    if (mine.some((item) => !item.key && ((label && has(`${item.title} ${item.why ?? ""}`, label)) || overlap(ask.what ?? ask.sentence, `${item.title} ${item.why ?? ""}`) >= 0.6))) continue;
    let existing = mine.find((item) => isRoutineItem(item) && itemIsAsk(item, ask));
    // answered by the owner a moment ago, the SAME pendency: the routine is only repeating what it read before (INSP-N22 A2)
    // — not when the owner's closing words carried a reservation: that answer must not hold it back (INSP-N22 r6 U1)
    if (!existing) {
      const answered = ledger.resolvedOwnerPendingOf(run.botId).filter((item) => item.resolvedBy === "owner" && run.at - item.resolvedAt < ROUTINE_ASK_SETTLED_MS && itemIsAsk(item, ask) && !closedWithReservation(item));
      // rows the owner answered stay answered; only the rows the ask adds are asked ("linhas 185 e 186" after the 185, INSP-R13VIS I2)
      const askRows = rowsOfKey(routineAskKey(ask));
      const left = askRows?.filter((row) => !answered.some((item) => rowsOfKey(item.key)?.includes(row)));
      if (answered.length && !left?.length) continue;
      if (answered.length && left && left.length < askRows!.length) {
        ask = { ...ask, subject: { kind: "linha", id: left.join("+"), label: rowsLabel(left) } };
        existing = mine.find((item) => isRoutineItem(item) && itemIsAsk(item, ask));
      }
    }
    // an open sheet item about some of these rows takes the others: one item, its key grown (INSP-R13VIS I2)
    const grown = existing ? rowsOfKey(existing.key) : null;
    const wanted = rowsOfKey(routineAskKey(ask));
    if (existing && grown && wanted && wanted.some((row) => !grown.includes(row)) && existing.key === baseKey(existing.key!)) {
      const rows = [...grown, ...wanted.filter((row) => !grown.includes(row))];
      existing = ledger.patchOwnerPending(run.botId, existing.id, { key: rowsKey(rows) }) ?? existing;
    }
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
      // the owner dealt with it in a conversation: the routine naming it (often to report just that) does not bring it
      // back — asking it again does (a refresh); the owner's "Ainda vale" does
      if (item.demotedAt !== undefined && item.why?.includes(OWNER_THREAD_MARK)) {
        ledger.patchOwnerPending(run.botId, item.id, { quietRuns: undefined, lastSaidAt: run.at });
        continue;
      }
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
const withoutNotes = (why: string) => why.replace(/\s*\((?:o bot não repete desde|você confirmou que ainda vale|você tratou disso na conversa)[^)]*\)/g, "");

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
