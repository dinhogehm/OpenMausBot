// The language bots write to people in. The owner's default is Brazilian
// Portuguese; a language picked in the app (cfg.language) wins. Two pieces:
// a system-prompt paragraph, and a one-line reminder at the END of the
// texts the harness itself writes as a turn's "user" message (wake notes,
// reports, goal continuations, recalled passages). Those are English machine
// text, and a model mirrors the language of the latest message it reads —
// the reminder is what it reads last.

const PT = { name: "Brazilian Portuguese (pt-BR)", reminder: "(Responda à pessoa em português do Brasil.)" };

function target(language?: string): { name: string; reminder: string } {
  const code = (language ?? "").trim().toLowerCase();
  if (!code || code === "pt" || code.startsWith("pt-")) return PT;
  let name = code;
  try {
    name = new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch { /* keep the code */ }
  return { name, reminder: `(Reply to the person in ${name}.)` };
}

/** System-prompt paragraph: every message meant for people in the reply language. */
export function languagePrompt(language?: string): string {
  const { name } = target(language);
  return `\n\nLanguage: every message meant for people — replies, reports, status updates, requests for approval or a GO, posts made on the user's behalf — is written in ${name}, unless the person's own latest message is clearly in another language; then use that one. Wake-up notes, report headers, recalled passages, reports from other agents or sessions and tool results are machine text: they do not set the language. If your earlier replies in this conversation were in another language, switch now. Every sentence people can see is in ${name} too — including the short lines you write between tool calls while you work ("Let me check…", "Now I'll…"): never narrate your steps in English. Notes to yourself (plans, reminders such as "Re-schedule." or "Waiting on CI") never go into what you post: people only see finished sentences meant for them. Keep code, commands, identifiers, links and quoted text exactly as they are.\n`;
}

/** The line that closes a harness-written turn message. */
export function languageReminder(language?: string): string {
  return target(language).reminder;
}

/** The owner's language is Portuguese (the default, or a "pt-…" picked in the app). */
export function isPortugueseLanguage(language?: string): boolean {
  return target(language) === PT;
}

// Function words only one of the two languages uses ("no", "a", "as", "do",
// "se" are both, so neither list has them). Code, commands, links and #refs
// are taken out first: "git push", "PR #9376" or "merge" read as neither.
const ENGLISH_WORDS = new Set([
  "the", "and", "is", "are", "was", "were", "be", "it", "it's", "its", "this", "that", "these", "those", "of", "to", "in", "on", "with", "without", "for", "from", "by",
  "now", "then", "only", "just", "will", "i'll", "i'm", "let", "let's", "me", "them", "they", "both", "one", "ones", "has", "have", "not", "but", "or", "all", "any",
  "check", "quickly", "via", "here", "there", "what", "which", "when", "after", "before", "still", "leave", "remove", "next", "done",
]);
const PORTUGUESE_WORDS = new Set([
  "o", "os", "um", "uma", "de", "da", "das", "dos", "na", "nas", "nos", "em", "para", "pra", "com", "sem", "que", "e", "é", "não", "já", "mais", "foi", "está", "estão",
  "vou", "eu", "você", "ele", "ela", "isso", "esse", "essa", "este", "esta", "por", "pelo", "pela", "agora", "depois", "ainda", "também", "só", "aqui", "quando", "como", "sua", "seu",
]);

/** A line the bot wrote reads as English (and not Portuguese): two or more
 * English-only function words, at least twice the Portuguese ones, and no
 * Portuguese accents (R12-followup #4: "Published (tag ahead of merge),
 * only graft change… Fits the authorized routine." in the owner's channel). */
export function readsAsEnglish(text: string): boolean {
  const prose = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/(?:https?|claude):\/\/\S+/g, " ")
    .replace(/(?:^|\s)--?[\w-]+/g, " ")
    .replace(/#\d+/g, " ");
  if (/[ãõçáéíóúâêôà]/i.test(prose)) return false;
  const words = prose.toLowerCase().replace(/’/g, "'").match(/[a-z']+/g) ?? [];
  const english = words.filter((word) => ENGLISH_WORDS.has(word)).length;
  const portuguese = words.filter((word) => PORTUGUESE_WORDS.has(word)).length;
  return english >= 2 && english >= 2 * portuguese;
}
