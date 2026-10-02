// What an owner_pending title (or a bot's ask) says once the names it opens
// with are set aside: "@Chief of Staff, aprovar o deploy" says "aprovar o
// deploy"; "@Chief of Staff" alone says nothing to do. One rule for the
// server (which refuses a title that is only a mention) and the app (which
// never shows one).

/** A leading "@Chief of Staff," / "@Monitor Chat Atendimento:" — who, not what. */
export const LEADING_MENTIONS = /^(?:@[\p{L}\p{N}][\p{L}\p{N}_-]*(?:\s+(?:of|de|do|da|dos|das)\s+[\p{L}\p{N}]+|\s+\p{Lu}[\p{L}\p{N}]*)*[,:;–—-]?\s*)+/u;

/** The text after the mentions it opens with. Known names (longest first)
 * are taken off exactly first, so a capitalized word right after a name
 * ("@Monitor Chat Aprovar…") is kept; then any other leading mention. */
export function stripLeadingMentions(text: string, knownNames: readonly string[] = []): string {
  let rest = text.replace(/\s+/g, " ").trim();
  const names = [...knownNames].filter(Boolean).sort((a, b) => b.length - a.length);
  for (let changed = true; changed;) {
    changed = false;
    for (const name of names) {
      if (rest.toLowerCase().startsWith(`@${name.toLowerCase()}`) && !/[\p{L}\p{N}]/u.test(rest.charAt(name.length + 1))) {
        rest = rest.slice(name.length + 1).replace(/^[\s,:;–—-]+/, "");
        changed = true;
      }
    }
  }
  return rest.replace(LEADING_MENTIONS, "").trim();
}

/** Nothing to do is said: no word of three letters once the mentions are set aside. */
export function isMentionOnly(text: string, knownNames: readonly string[] = []): boolean {
  return !/\p{L}{3}/u.test(stripLeadingMentions(text, knownNames));
}
