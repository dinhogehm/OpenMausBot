// What a turn writes between its tool calls ("Now the orphans: inspect.",
// "Fits the authorized routine…") is narration, not a reply. The language
// prompt asks for it in the owner's language, but models still slip into
// English mid-turn; in the owner's channel those lines read as messages to
// the owner (R11-followup #4, R12-followup #4). When the turn's own reply
// is in Portuguese, the English lines before it become activity: a work note
// that keeps its whole text (in the message, for search and recall, and in
// the chip's expandable output) — never lost (INSP-R12F F3). Only a short
// line of prose is narration: code, logs, quotes, e-mails and drafts stay as
// they were, whatever their language.
import { readsAsEnglish } from "./reply-language.ts";

/** Enough of a message for the choice. */
export interface NarrationCandidate {
  id: string;
  role: string;
  kind: string;
  text?: string;
  turnId?: string;
}

/** Narration is short: the real slips were one to three sentences, under 250 characters. */
export const NARRATION_MAX = 400;

/** A line of narration, by its shape: short, at most three lines, no code
 * block, no quote, no log line, no e-mail or letter. */
export function narrationShaped(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > NARRATION_MAX || trimmed.split("\n").filter((line) => line.trim()).length > 3) return false;
  if (/```|~~~/.test(trimmed)) return false;
  if (/^\s*>/m.test(trimmed)) return false;
  // a log or stack line: "Error: …", "WARN …", "at x (file:1:2)", a timestamp, "Traceback"
  if (/^\s*(?:error|warn(?:ing)?|info|debug|fatal|exception|traceback)\b|^\s*at \S+ \(|\b\w+Error\b|^\s*\[?\d{4}-\d\d-\d\d[ T]\d\d:\d\d/im.test(trimmed)) return false;
  // a letter or an e-mail: "Dear …", "Hi John,", "Subject:", "Best regards"
  if (/^\s*(?:dear|hi|hello|hey)\b[^.!?\n]{0,40},|^\s*subject:|\b(?:best|kind)? ?regards\b|\bsincerely\b|\bthank you for your\b/im.test(trimmed)) return false;
  return true;
}

/** The turn's text messages that are English narration: every one but its
 * reply (`terminalId`), and none at all when that reply is itself English
 * (the person wrote in English, or the bot answered in it: then English is
 * the conversation's language, and hiding lines would hide the answer). */
export function englishNarration<T extends NarrationCandidate>(messages: readonly T[], turnId: string, terminalId: string): T[] {
  const texts = messages.filter((message) => message.role === "bot" && message.kind === "text" && message.turnId === turnId && Boolean(message.text?.trim()));
  const reply = texts.find((message) => message.id === terminalId);
  if (!reply || readsAsEnglish(reply.text ?? "")) return [];
  return texts.filter((message) => message.id !== terminalId && narrationShaped(message.text ?? "") && readsAsEnglish(message.text ?? ""));
}

/** The chip's name (pt-BR, like the server's other chips); the text itself goes whole in its output. */
export const NARRATION_NOTE = "Nota de trabalho do bot, em inglês (não é mensagem para você)";

/** The patch that turns a narration into a work note: the text stays, whole. */
export function narrationPatch(text: string): { kind: "activity"; text: string; tool: { name: string; ok: true; output: string } } {
  return { kind: "activity", text, tool: { name: NARRATION_NOTE, ok: true, output: text } };
}
