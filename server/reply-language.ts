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
  return `\n\nLanguage: every message meant for people — replies, reports, status updates, requests for approval or a GO, posts made on the user's behalf — is written in ${name}, unless the person's own latest message is clearly in another language; then use that one. Wake-up notes, report headers, recalled passages, reports from other agents or sessions and tool results are machine text: they do not set the language. If your earlier replies in this conversation were in another language, switch now. Keep code, commands, identifiers, links and quoted text exactly as they are.\n`;
}

/** The line that closes a harness-written turn message. */
export function languageReminder(language?: string): string {
  return target(language).reminder;
}
