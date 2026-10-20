// What a bot reads and the person sees of its wakes, watches and goals: prompts, acks and chips.
import type { BotGoal, BotPromise, BotWake, GoalStatus, OwnerPending, PendingReports } from "./bot-autonomy.ts";
import { leadingVocative } from "./owner-channel.ts";
import { languageReminder } from "./reply-language.ts";
import { stripLeadingMentions } from "../shared/owner-pending-title.ts";

const WATCH_PROMPT_OUTPUT_MAX = 1_500;

export const minutesLabel = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

export const GOAL_RULES = [
  "Keep going without waiting for the person. Do the next concrete step now: run the command, open the PR, check the deploy, fix what failed.",
  "When you are waiting on something outside this conversation (CI, a deploy, a review), call wake_when with a read-only command that shows its state — it costs nothing until that state changes — or wake_me for a plain timer, and end the turn instead of polling in a loop.",
  "When teammates you delegated to are still working, just end the turn: their results wake you here.",
  "Call goal_end with status completed only when the deliverable is verifiably done, blocked when you cannot proceed, or needs_input when only the person can decide. Never claim completion you have not checked.",
];

export function goalStartedAck(goal: BotGoal): string {
  return [
    `Modo objetivo ligado nesta conversa: até ${goal.maxTurns} turnos ou ${minutesLabel(goal.deadlineAt - goal.startedAt)}. Quando este turno terminar, você recebe o próximo automaticamente.`,
    "Quando estiver esperando algo fora desta conversa (CI, deploy, revisão), use wake_when com um comando só de leitura que mostre o estado — não custa nada até o estado mudar — ou wake_me para um despertador simples, e encerre o turno em vez de ficar consultando.",
    "Quando colegas a quem você delegou ainda estiverem trabalhando, apenas encerre o turno: os resultados deles te acordam aqui.",
    "Chame goal_end com status completed só quando a entrega estiver comprovadamente feita, blocked quando não puder seguir, ou needs_input quando só a pessoa puder decidir. Nunca declare conclusão que você não conferiu.",
  ].join(" ");
}

// Each harness-written turn message ends with the reply-language reminder
// (server/reply-language.ts): it is machine English, and what the model
// reads last sets the language it answers people in.
export function goalContinuationPrompt(goal: BotGoal, now: number, reminder = languageReminder()): string {
  return [
    `[Goal mode — turn ${goal.turnCount} of ${goal.maxTurns}, ${minutesLabel(goal.deadlineAt - now)} left. Nobody typed this; the harness continues your goal.]`,
    `Goal: ${goal.goal}`,
    "Use this conversation as your progress ledger: check what is already done before repeating anything.",
    ...GOAL_RULES,
    reminder,
  ].join("\n");
}

export const clipOutput = (text: string | undefined): string => {
  const value = (text ?? "").trim();
  if (!value) return "(empty)";
  return value.length > WATCH_PROMPT_OUTPUT_MAX ? `${value.slice(0, WATCH_PROMPT_OUTPUT_MAX)}\n… (truncated)` : value;
};

export function watchLines(wake: BotWake): string[] {
  const watch = wake.watch;
  if (!watch) return [];
  const why = watch.trigger === "matched"
    ? `its output now matches "${watch.until}"`
    : watch.trigger === "changed"
      ? "its output changed"
      : watch.trigger === "failing"
        ? `the command failed ${watch.failures} times in a row — fix or replace it`
        : "the time limit ran out before anything changed";
  return [
    `Your ${watch.standing ? "standing " : ""}watch \`${watch.command}\` ran ${watch.runs} time(s); you are woken because ${why}.`,
    ...(watch.standing ? ["It stays armed: the server re-arms it on this output after this turn, so do not call wake_when again for it."] : []),
    `${watch.standing ? "Output it last compared against" : "Output when you set it"}:\n${clipOutput(watch.baseline)}`,
    ...(watch.lastOutput !== undefined && watch.lastOutput !== watch.baseline ? [`Latest output:\n${clipOutput(watch.lastOutput)}`] : []),
    // the output is cut: what changed may be past the cut, so say it here
    ...(watch.truncated && watch.newLines?.length ? [`The output is longer than what is shown above. Lines new or changed since the run before (${watch.newLines.length}):\n${watch.newLines.join("\n")}`] : []),
    ...(watch.truncated && !watch.newLines?.length ? ["The output is longer than what is shown above: fetch it again if you need the rest."] : []),
  ];
}

/** Lines, whole, up to `max` characters in all. */
export function clipLines(lines: string[], max: number): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > max) break;
    kept.push(line);
    size += line.length + 1;
  }
  return kept;
}

export function wakePrompt(wake: BotWake, goal: BotGoal | null, now: number, reminder = languageReminder()): string {
  return [
    `[${wake.watch ? "Watch" : "Wake-up"} you scheduled ${minutesLabel(now - wake.createdAt)} ago. Nobody typed this.]`,
    ...watchLines(wake),
    // a standing watch's note was written when it was set: it can be stale by now
    wake.watch?.standing && wake.watch.reasonAt !== undefined && now - wake.watch.reasonAt >= 3_600_000
      ? `Your note for this moment, written ${minutesLabel(now - wake.watch.reasonAt)} ago — check it still holds before acting on it; if not, give it a current one with wake_when update_reason (same label): ${wake.reason}`
      : `Your note for this moment: ${wake.reason}`,
    ...(goal && goal.status === "active"
      ? [`You are in goal mode (turn ${goal.turnCount} of ${goal.maxTurns}). Goal: ${goal.goal}`, ...GOAL_RULES]
      : ["Do what the note says. If it still is not ready, call wake_when or wake_me again; if it is, report the result here."]),
    reminder,
  ].join("\n");
}

/** `text` on one line, without backticks, cut at a word boundary with "…". */
export function chipText(text: string, max: number): string {
  const clean = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.(—-]+$/, "")}…`;
}

/** A short name for what a watch looks at: "PR #K", "Chat", a host. */
export function watchLabel(command: string): string {
  const words = command.trim().split(/\s+/).map((word) => word.replace(/^['"]|['"]$/g, ""));
  const [program, group] = words;
  // a number right after a flag is its value (--limit 30, -L 30), not an item
  const number = words.find((word, i) => i > 1 && /^#?\d+$/.test(word) && !words[i - 1]!.startsWith("-"))?.replace("#", "");
  if (program === "gh") {
    if (group === "pr") return number ? `PR #${number}` : "PRs";
    if (group === "issue") return number ? `issue #${number}` : "issues";
    if (group === "run" || group === "workflow") return number ? `execução #${number} do CI` : "execuções do CI";
    if (group === "release") return "releases";
    if (group === "api") {
      const pull = /pulls\/(\d+)/.exec(command) ?? /issues\/(\d+)/.exec(command);
      return pull ? `#${pull[1]} no GitHub` : "GitHub";
    }
    return "GitHub";
  }
  if (program === "gog") return words.includes("sheets") ? "Planilha" : words.includes("chat") ? "Chat" : "Google";
  if (program === "git") {
    const tag = words.find((word) => word.startsWith("refs/tags/"));
    return tag ? `tag ${tag.slice("refs/tags/".length)}` : words.includes("ls-remote") ? "repositório remoto" : "repositório";
  }
  if (program === "curl") {
    const url = words.find((word) => /^https?:\/\//i.test(word));
    try {
      if (url) return new URL(url).host;
    } catch { /* fall through */ }
  }
  return chipText(words.slice(0, 3).join(" "), 40);
}

export const hhmm = (ms: number): string => {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

export function wakeChip(wake: BotWake): string {
  const reason = chipText(wake.reason, 100);
  if (wake.watch) {
    const every = Math.round(wake.watch.everyMs / 60_000) || 1;
    const label = watchLabel(wake.watch.command);
    if (wake.watch.standing) return `Vigia permanente${wake.watch.label ? ` "${wake.watch.label}"` : ""} em ${label} a cada ${every} min — ${reason}`;
    return `Vigiando ${label} a cada ${every} min até ${hhmm(wake.dueAt)} — ${reason}`;
  }
  return `Despertador às ${hhmm(wake.dueAt)} — ${chipText(wake.reason, 120)}`;
}

/** The chip for a wake that fires: what woke the bot, in a few words. */
export function wakeFiredChip(wake: BotWake): string {
  if (!wake.watch) return `Acordou — ${chipText(wake.reason, 140)}`;
  const why = { changed: "mudou", matched: "condição atingida", failing: "comando falhando" }[wake.watch.trigger ?? "changed"];
  return `${wake.watch.standing ? `Vigia permanente${wake.watch.label ? ` "${wake.watch.label}"` : ""}` : "Vigia"} disparou (${wake.watch.trigger ? why : "tempo esgotado"}) em ${watchLabel(wake.watch.command)} — ${chipText(wake.reason, 110)}`;
}

export function goalEndChip(goal: BotGoal): string {
  const label = {
    completed: "Objetivo concluído",
    blocked: "Objetivo bloqueado",
    "needs-input": "Objetivo esperando você",
    stopped: "Objetivo parado",
    limit: "Objetivo pausado no limite",
  }[goal.status as Exclude<GoalStatus, "active">];
  return `${label} após ${goal.turnCount} turno${goal.turnCount === 1 ? "" : "s"}${goal.detail ? ` — ${chipText(goal.detail, 160)}` : ""}`;
}

export function reportsPrompt(pending: PendingReports, goal: BotGoal | null, reminder = languageReminder()): string {
  return [
    `[${pending.items.length === 1 ? "A report arrived" : `${pending.items.length} reports arrived`} — from Claude Code sessions you manage or from the harness. Nobody typed this.]`,
    ...pending.items,
    ...(goal && goal.status === "active" ? [`You are in goal mode (turn ${goal.turnCount} of ${goal.maxTurns}). Goal: ${goal.goal}`] : []),
    reminder,
  ].join("\n\n---\n\n");
}

/** For the bot (and its Chief) when a promise passed its time unkept. */
export function promiseOverdueReport(promise: BotPromise, botName: string, now: number): string {
  return [
    `[Promise overdue by ${minutesLabel(now - promise.dueAt)}: ${botName} promised "${promise.text}" (${promise.id}), due ${minutesLabel(now - promise.createdAt)} after it was made, and it was not marked kept.]`,
    "Send what was promised now, or tell the person when it will come and why — then mark it kept with wake_me promise_kept and promise_proof (the sent message's ID). If it was already sent, mark it kept with that message's ID; without an ID it was not sent.",
  ].join("\n");
}

/** The PRs a goal's question cites: links (owner/repo) and "PR #N" / "#N". */
export function prsCited(text: string): Array<{ number: number; slug?: string }> {
  const found = new Map<number, string | undefined>();
  for (const match of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) found.set(Number(match[2]), match[1]);
  for (const match of text.matchAll(/\b(?:PR|pull request)\s*#?(\d{2,6})\b/gi)) if (!found.has(Number(match[1]))) found.set(Number(match[1]), undefined);
  return [...found].map(([number, slug]) => ({ number, ...(slug ? { slug } : {}) }));
}

/** A goal left waiting on the person this long is not "needs you" any more:
 * it is shown as stopped, and the question as unanswered. */
export const NEEDS_INPUT_EXPIRE_MS = 12 * 3_600_000;

/** A bot's own reply that ends by asking the person something ("Posso
 * trocar?"): its time, or null. Only the conversation's last text counts,
 * and only as an answer to the person: a greeting a new bot opens with
 * ("What would you like me to do?") has no message of theirs before it. */
export function lastQuestionAt(messages: ReadonlyArray<{ role: string; kind: string; text?: string; at: number }>, now: number, maxAgeMs = 24 * 3_600_000): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.kind !== "text") continue;
    if (message.role !== "bot") return null;
    const text = (message.text ?? "").replace(/[\s*_`)\]\p{Extended_Pictographic}\uFE0F]+$/u, "");
    const answersPerson = messages.slice(0, i).some((earlier) => earlier.role === "user" && earlier.kind === "text");
    return answersPerson && text.endsWith("?") && now - message.at < maxAgeMs ? message.at : null;
  }
  return null;
}

/** "Preciso de você", "Continuam com você", "Decisão para você"…: the bot
 * asks the person for something in plain words, not only with a "?". */
export const OWNER_ASK = /\b(preciso (?:que voc[êe]|de voc[êe]|da sua|do seu|de uma decis[ãa]o)|precisa de voc[êe]|continua(?:m)? com voc[êe]|fica(?:m)? com voc[êe]|decis[ãa]o (?:para voc[êe]|sua)|pend[êe]ncias? (?:com voc[êe]|do dono|suas)|aguardo (?:a sua|o seu|sua|seu)|s[óo] voc[êe] pode|need (?:you|your)|waiting (?:on|for) you)/i;

/** Since when the bot has been waiting on the person: the first of its
 * replies, after the person's last message, that asks them something (a
 * question at its end, or an explicit ask anywhere in it). It holds until the
 * person writes again, however many replies come after. null when none, or
 * older than `maxAgeMs`. */
export function ownerAskAt(messages: ReadonlyArray<{ role: string; kind: string; text?: string; at: number; peerAsk?: unknown; from?: unknown }>, now: number, maxAgeMs = 48 * 3_600_000): number | null {
  const fromPerson = (message: { role: string; kind: string; peerAsk?: unknown; from?: unknown }) => message.role === "user" && message.kind === "text" && !message.peerAsk && !message.from;
  const lastPerson = messages.findLastIndex(fromPerson);
  if (lastPerson < 0) return null; // a greeting nobody answered yet asks nothing of anyone
  for (const message of messages.slice(lastPerson + 1)) {
    // once another bot speaks to it, what it asks is for that bot
    if (message.role === "user" && message.peerAsk) break;
    if (message.role !== "bot" || message.kind !== "text" || message.from) continue;
    const text = (message.text ?? "").replace(/[\s*_`)\]\p{Extended_Pictographic}\uFE0F]+$/u, "");
    if ((text.endsWith("?") || OWNER_ASK.test(text)) && now - message.at < maxAgeMs) return message.at;
  }
  return null;
}

/** What the bot asked, in one sentence the person can read in "Precisa de
 * você" instead of the conversation's title ("@Chief of Staff" says who, not
 * what): the last question of its reply, else the sentence that asks for
 * the person, else its first sentence. Markdown and a leading mention are
 * dropped; at most `max` characters, cut at a word. "" when nothing reads. */
export function ownerAskText(text: string, max = 200, knownNames: readonly string[] = []): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~>]+/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "");
  const sentences = plain
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((each) => stripLeadingMentions(each, knownNames))
    .filter((each) => /\p{L}{3}/u.test(each));
  const at = sentences.findLastIndex((each) => each.endsWith("?"));
  const found = at >= 0
    // a short question carries the sentence before it ("A #P passou no gate. Mesclo?": INSP-J r1 #4)
    ? (usefulWords(sentences[at]!) < 2 && at > 0 ? `${sentences[at - 1]} ${sentences[at]}` : sentences[at]!)
    : sentences.find((each) => OWNER_ASK.test(each)) ?? sentences[0] ?? "";
  // the vocative is who, not what ("Osvaldo, a sessão da #Q…": R10-visual N12c)
  const vocative = leadingVocative(found);
  const said = vocative ? found.replace(/^[\s*_>"'“-]*[^,]+,\s*/u, "") : found;
  // a sentence that followed the mention starts lower-case ("@Chief, preciso…"): a title starts upper-case
  const pick = said.charAt(0).toLocaleUpperCase("pt-BR") + said.slice(1);
  if (pick.length <= max) return pick;
  const cut = pick.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, "")}…`;
}

/** The ask behind ownerAskAt: the bot's reply that waits on the person, as one sentence. */
export function ownerAsk(messages: ReadonlyArray<{ role: string; kind: string; text?: string; at: number; peerAsk?: unknown; from?: unknown }>, now: number, maxAgeMs = 48 * 3_600_000, knownNames: readonly string[] = []): string | null {
  const at = ownerAskAt(messages, now, maxAgeMs);
  if (at === null) return null;
  const message = messages.find((each) => each.at === at && each.role === "bot" && each.kind === "text" && !each.from);
  return message?.text ? ownerAskText(message.text, 200, knownNames) || null : null;
}

/** Words that ask for the person without saying for what. */
export const ASK_FILLER = new Set(["preciso", "precisa", "precisamos", "você", "voce", "vocês", "sua", "seu", "suas", "seus", "ajuda", "favor", "por", "uma", "um", "agora", "aqui", "isso", "olhar", "ver", "atenção", "atencao", "urgente", "dono"]);

/** A bot's ask that says nothing of its own, so its own line in "Precisa de
 * você" would only be noise (R10-visual N12: 4 of 17 rows): it points at the
 * panel itself ("O pedido continua na sua lista 'Precisa de você' (o15)"),
 * at another item ("O Monitor abriu a pendência o6"), or asks with no
 * content ("Preciso de você"). `itemIds`: the ids and aliases of the open
 * items — an id among them means the item says it. */
export function echoAsk(text: string, itemIds: readonly string[] = []): boolean {
  const plain = text.replace(/[*_`~]+/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return true;
  // the panel by its name, as a place: quoted, or "na sua lista / no painel / em Precisa de você"
  if (/["'“«‘]\s*Precisa de voc[êe]\s*["'”»’]/i.test(plain) || /\b(?:lista|painel|tela|aba|em|no seu|na sua|no)\s+Precisa de voc[êe]\b/i.test(plain)) return true;
  // a question asks something of its own, even short ("Mesclo?", "Confirma?")
  // or naming an item ("Quer que eu responda à cliente agora (o4)?"): never an echo (INSP-J r1 #4)
  if (/\?\s*\)?\s*$/.test(plain)) return false;
  // another item by its id, said and nothing asked ("O Monitor abriu a pendência o6.")
  if (/\b(?:pend[êe]ncias?|itens?|pedidos?)\s+o\d+\b/i.test(plain) || /\(o\d+\)/.test(plain)) return true;
  const ids = new Set(itemIds.map((id) => id.toLowerCase()));
  if ((plain.match(/\bo\d+\b/gi) ?? []).some((id) => ids.has(id.toLowerCase()))) return true;
  // nothing asked: under two words that say something
  return usefulWords(plain) < 2;
}

/** Words of an ask that say something (a vocative, "preciso de você" aside). */
export function usefulWords(text: string): number {
  return text.toLowerCase().replace(/^[^,]{1,30},\s*/u, "").split(/[^\p{L}\p{N}#]+/u).filter((word) => word.length >= 3 && !ASK_FILLER.has(word)).length;
}

/** The ask is the very request of an item the person already has: it only
 * echoes one (echoAsk), or the bot opened an item in this conversation in
 * the same breath (a bot item, not the server's — those live in the
 * owner's channel beside any new question). A conversation holding an
 * unrelated item still shows its new question (INSP-J r1 #3). */
export function askCoveredByItem(ask: { text: string; at: number }, items: ReadonlyArray<Pick<OwnerPending, "id" | "threadId" | "createdAt" | "key" | "aliases">>, threadId: string, windowMs = 10 * 60_000): boolean {
  const ids = items.flatMap((item) => [item.id, ...(item.aliases ?? [])]);
  if (echoAsk(ask.text, ids)) return true;
  return items.some((item) => item.threadId === threadId && !item.key && Math.abs(item.createdAt - ask.at) <= windowMs);
}

/** What the bot reads, in the item's conversation, when the person answers
 * an item from "Precisa de você": which item, and the answer — a decision
 * the bot offered, or the person's own words. `resolved` says the item is
 * closed already, so the bot does not open it again. */
export function ownerPendingReplyText(item: Pick<OwnerPending, "id" | "title">, reply: string, resolved: boolean): string {
  // only facts in the person's voice: what to do next goes in ownerPendingAwaitNote, which only the bot reads (INSP-J2 #3)
  return `Sobre "${item.title}" (${item.id}): ${reply.trim()}${resolved ? `\n\n(Marquei ${item.id} como resolvido em "Precisa de você".)` : ""}`;
}

/** What only the bot reads with an answer that keeps the item open (the
 * turn's prompt, never the transcript): it waits on the bot now (J18). */
export function ownerPendingAwaitNote(item: Pick<OwnerPending, "id">): string {
  return `[Nota do OpenMausBot, não escrita pela pessoa] A pendência ${item.id} continua em "Precisa de você", aguardando você: quando estiver feito, resolva-a com owner_pending resolve id ${item.id}; se faltar algo, reescreva-a com owner_pending update id ${item.id}. Sem uma das duas em 2 h, ela volta para a pessoa como "o bot não respondeu".`;
}

/** The person's request, from "Precisa de você", to rewrite an item that has
 * no steps — the words shown in the conversation as theirs (INSP-I r1 #6:
 * plain, no tool names). */
export function ownerPendingStepsRequestText(item: Pick<OwnerPending, "title">): string {
  return `Me mostre como resolver «${item.title}», passo a passo.`;
}

/** What only the bot reads with that request (the turn's prompt, never the
 * transcript): the exact tool call it answers with. */
export function ownerPendingStepsRequestNote(item: Pick<OwnerPending, "id">): string {
  return `[Nota do OpenMausBot, não escrita pela pessoa] A pessoa abriu a pendência ${item.id} em "Precisa de você" e pediu o passo a passo. Reescreva-a com owner_pending update, id ${item.id}: why (1–2 frases: por que importa e o que acontece se esperar), steps (passos numerados e práticos, cada um com o comando exato em command ou o link em link quando houver) e options (as decisões, se for uma escolha: label curto como "Aprovar" e reply com a resposta que você deve receber). Não abra outra pendência; responda à pessoa em uma frase.`;
}
