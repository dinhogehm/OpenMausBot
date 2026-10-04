// What an owner_pending title (or a bot's ask) says once the names it opens
// with are set aside: "@Chief of Staff, aprovar o deploy" says "aprovar o
// deploy"; "@Chief of Staff" alone says nothing to do. One rule for the
// server (which refuses a title that is only a mention) and the app (which
// never shows one).
//
// A name of several words is only taken as a name when it is KNOWN (a bot's
// name) or when the text shows where it ends: "@Chief of Staff, …" (a
// connector right after the handle), "@Monitor Chat Atendimento: …" (closing
// punctuation). Anything else keeps its words: in "@Osvaldo Aprovar o deploy"
// the verb is the title's first word, never part of a name (INSP-I r2 #1).

/** Why an earlier choice was not sent: the person switched it while it
 * waited in the queue. The server writes it; the screen draws it neutral. */
export const CHOICE_REPLACED = "substituída pela nova escolha";

const HANDLE =/^@[\p{L}\p{N}][\p{L}\p{N}_.-]*/u;
const AFTER = /^[\s,:;–—-]*/u;
const CONNECTED = /^\s+(?:of|de|do|da|dos|das)\s+[\p{L}\p{N}]+/u;
/** One or two capitalized words a "," ":" or ";" closes: the rest of a name
 * ("@Monitor Chat Atendimento:"). Never a verb in the infinitive — the
 * title's first word ("@Osvaldo Aprovar, por favor, …" — INSP-I r3 #3). */
const CAPITALIZED_RUN = /^(?:\s+(?!\p{Lu}\p{Ll}*[aei]r\b)\p{Lu}[\p{L}\p{N}]*){1,2}(?=\s*[,:;])/u;

/** The text after the mentions it opens with. Known names (longest first)
 * are taken off exactly; an unknown "@handle" takes only itself, plus a
 * "of Staff" right after it, plus capitalized words that a ",", ":" or ";"
 * closes. */
export function stripLeadingMentions(text: string, knownNames: readonly string[] = []): string {
  let rest = text.replace(/\s+/g, " ").trim();
  const names = [...knownNames].filter(Boolean).sort((a, b) => b.length - a.length);
  for (;;) {
    const known = names.find((name) => rest.toLowerCase().startsWith(`@${name.toLowerCase()}`) && !/[\p{L}\p{N}]/u.test(rest.charAt(name.length + 1)));
    if (known) {
      rest = rest.slice(known.length + 1).replace(AFTER, "");
      continue;
    }
    const handle = HANDLE.exec(rest);
    if (!handle) break;
    rest = rest.slice(handle[0].length);
    const connected = CONNECTED.exec(rest);
    if (connected) rest = rest.slice(connected[0].length);
    const run = CAPITALIZED_RUN.exec(rest);
    if (run) rest = rest.slice(run[0].length);
    rest = rest.replace(AFTER, "");
  }
  return rest.trim();
}

/** Nothing to do is said once the mentions are set aside: no word of three
 * letters, or only the rest of a person's name — one or two capitalized
 * words and nothing else ("@Osvaldo Silva", INSP-I r3 #3). Three words or a
 * lower-case one say something ("@time Financeiro Conferir NF"). */
export function isMentionOnly(text: string, knownNames: readonly string[] = []): boolean {
  const rest = stripLeadingMentions(text, knownNames);
  if (!/\p{L}{3}/u.test(rest)) return true;
  // the name rule reads only what follows a mention: "Deploy" alone is a title
  if (rest === text.replace(/\s+/g, " ").trim()) return false;
  const words = rest.split(/\s+/).filter(Boolean);
  return words.length <= 2 && words.every((word) => /^\p{Lu}[\p{L}'’-]*[.!]?$/u.test(word)) && !words.some((word) => /^\p{Lu}\p{Ll}*[aei]r$/u.test(word));
}
