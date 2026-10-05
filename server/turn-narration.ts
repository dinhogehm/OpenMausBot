// What a turn writes between its tool calls ("Now the orphans: inspect.",
// "Fits the authorized routine…") is narration, not a reply. The language
// prompt asks for it in the owner's language, but models still slip into
// English mid-turn; in the owner's channel those lines read as messages to
// the owner (R11-followup #4, R12-followup #4). When the turn's own reply
// is in Portuguese, the English lines before it become activity: kept in the
// conversation as a work note, never as text to the person.
import { readsAsEnglish } from "./reply-language.ts";

/** Enough of a message for the choice. */
export interface NarrationCandidate {
  id: string;
  role: string;
  kind: string;
  text?: string;
  turnId?: string;
}

/** The turn's text messages that are English narration: every one but its
 * reply (`terminalId`), and none at all when that reply is itself English
 * (the person wrote in English, or the bot answered in it: then English is
 * the conversation's language, and hiding lines would hide the answer). */
export function englishNarration<T extends NarrationCandidate>(messages: readonly T[], turnId: string, terminalId: string): T[] {
  const texts = messages.filter((message) => message.role === "bot" && message.kind === "text" && message.turnId === turnId && Boolean(message.text?.trim()));
  const reply = texts.find((message) => message.id === terminalId);
  if (!reply || readsAsEnglish(reply.text ?? "")) return [];
  return texts.filter((message) => message.id !== terminalId && readsAsEnglish(message.text ?? ""));
}

/** The activity line a demoted narration becomes (pt-BR, like the server's other chips). */
export function narrationNoteText(text: string): string {
  return `Nota de trabalho do bot, em inglês (não é mensagem para você): ${text.replace(/\s+/g, " ").trim()}`;
}
