// The one conversation the owner named for talking to them (shared-state's
// ownerThread). Once it exists, what wakes the bot on the owner's behalf runs
// THERE: a session's report (sessionReportThread), a standing watch firing,
// an answer the owner gave from "Precisa de você". Otherwise the bot answers
// the owner where it was woken, and the owner — who reads only the channel,
// as they ordered — never sees it (R10-followup #1: after the order, 26
// messages of the Chief in another conversation, 25 of them "Osvaldo, …",
// and only one mirrored, because the mirror keyed on a profile name that was
// empty on that Mac).

/** Where a turn the owner did not start in person runs: the owner's channel
 * when there is one, unless that turn's own conversation runs an active goal
 * (the goal waits for it there). */
export function channelTurnThread(input: { channel: string | null; from: string; goalActive: boolean }): string {
  if (!input.channel || input.channel === input.from || input.goalActive) return input.from;
  return input.channel;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The note a standing watch's turn carries when it is woken in the channel:
 * which conversation holds the watch, and where the bot answers. */
export function routedWakeNote(input: { fromTitle: string; fromThread: string; label?: string }): string {
  const watch = input.label ? `o vigia permanente "${oneLine(input.label).slice(0, 60)}"` : "um vigia permanente";
  // never "arm it again here": a standing watch is keyed by conversation and
  // label, so that would make two of it, each waking the bot (INSP-J r1 #5)
  return `[Nota do OpenMausBot] Quem disparou foi ${watch} da conversa "${oneLine(input.fromTitle).slice(0, 80)}" (${input.fromThread.slice(0, 8)}). Você foi acordado aqui porque esta é a conversa que o dono definiu para falar com ele: responda aqui. O vigia continua naquela conversa e é lá que se muda o motivo dele ou se desliga; não arme outro igual aqui.`;
}

/** A watch over what clients send (a Chat space, the spreadsheet, the
 * issues): its turn is intake work, done where it lives — never in the
 * owner's channel, where "responda aqui" would answer clients there. */
export function intakeWatch(argv: readonly string[]): boolean {
  const [program, ...args] = argv;
  const line = argv.join(" ");
  if (program === "gog" && (args.includes("chat") || args.includes("sheets"))) return true;
  if (/docs\.google\.com\/spreadsheets|sheets\.googleapis\.com|chat\.googleapis\.com/.test(line)) return true;
  return program === "gh" && (args[0] === "issue" || /\/issues\b|\bissues\b/.test(args.slice(1).join(" ")));
}

/** A standing watch fires in the owner's channel only when it is the
 * owner's kind of news (main, the production tag…) and its conversation
 * is not an intake one (no Chat, spreadsheet or issues watch beside it):
 * the Monitor's 'tag' watch lives with its Chat watch and tells clients
 * (INSP-J r1 #6). */
export function routesToChannel(argv: readonly string[], siblings: ReadonlyArray<readonly string[]>): boolean {
  return !intakeWatch(argv) && !siblings.some(intakeWatch);
}

/** The person's answer from "Precisa de você", taken to the channel: it says
 * which item and which conversation it came from. */
export function routedReplyText(text: string, item: { id: string; threadId: string }, fromTitle: string): string {
  return `${text}\n\n(Pendência ${item.id}, aberta na conversa "${oneLine(fromTitle).slice(0, 80)}" (${item.threadId.slice(0, 8)}); respondida pela tela "Precisa de você".)`;
}

// ── who "the owner" is, by name ─────────────────────────────────────────
// The mirror "Dito ao dono" must know a message is to the owner. The profile
// name is one source; on this Mac it was empty. The bots know the name: they
// open what they write to the owner with it ("Osvaldo, o release…"), in the
// one conversation where only the owner reads them.

/** Words that open a sentence with a comma and are not a name. */
const NOT_A_NAME = new Set([
  "pronto", "feito", "ok", "certo", "bom", "boa", "sim", "não", "nao", "oi", "olá", "ola", "atualização", "atualizacao", "resumo",
  "importante", "atenção", "atencao", "obs", "nota", "ótimo", "otimo", "beleza", "entendido", "combinado", "perfeito", "agora", "hoje",
  "ontem", "amanhã", "amanha", "também", "tambem", "então", "entao", "enfim", "aliás", "alias", "claro", "desculpe", "opa", "ah", "bem",
  "isso", "aqui", "lá", "la", "primeiro", "segundo", "depois", "antes", "porém", "porem", "mas", "e", "ou", "resultado", "status",
  "done", "yes", "no", "hi", "hello", "update", "note", "well", "so", "now", "today", "first", "also",
]);

/** The name a text opens with as a vocative ("Osvaldo, …", "**Osvaldo**, …"), or null. */
export function leadingVocative(text: string): string | null {
  const name = /^[\s*_>"'“-]*([A-ZÀ-Ý][a-zà-ÿ]{1,30})[*_]*,\s/u.exec(text)?.[1];
  return name && !NOT_A_NAME.has(name.toLowerCase()) ? name : null;
}

/** The owner's first name: the profile's; else the vocative the bot opens
 * its messages with in the channel (where only the owner reads) — seen twice,
 * or once and named in what the bots learned about the owner (aboutMe). A
 * bot's own name is never it. Null when nothing says it. */
export function ownerFirstName(input: { profileName?: string | null; aboutMe?: string | null; channelReplies: readonly string[]; botNames: readonly string[] }): string | null {
  const profile = input.profileName?.trim().split(/\s+/)[0];
  if (profile) return profile;
  const bots = new Set(input.botNames.map((name) => name.trim().split(/\s+/)[0]!.toLowerCase()));
  const counts = new Map<string, number>();
  for (const reply of input.channelReplies) {
    const name = leadingVocative(reply);
    if (name && !bots.has(name.toLowerCase())) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const about = input.aboutMe ?? "";
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const found = ranked.find(([name, count]) => count >= 2 || new RegExp(`\\b${name}\\b`, "u").test(about));
  return found?.[0] ?? null;
}

/** A bot's end-of-turn text is to the owner: it asked them, it says the
 * decision is theirs, or it opens with their name. */
export function saidToOwner(text: string, input: { asked: boolean; ownerName: string | null }): boolean {
  if (input.asked) return true;
  if (/\b(decis[ãa]o (?:sua|para voc[êe])|preciso (?:de )?(?:uma )?(?:decis[ãa]o|resposta)|continua(?:m)? com voc[êe])\b/i.test(text)) return true;
  const name = input.ownerName?.trim();
  return Boolean(name && new RegExp(`^\\W*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(text));
}
