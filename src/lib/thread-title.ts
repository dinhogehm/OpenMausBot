// Thread titles the server makes up itself ("New thread", "Team incidents",
// "<title> · parallel work", "@<bot> · work" for a teammate's handoff) are
// stored in English, the one language the server writes. Shown here in the
// person's language, and never opening with a mention (R11-visual N9): who
// asked goes after what. A title a person or a bot wrote otherwise stays
// exactly as written.
import { t } from "@/lib/i18n";
import { isMentionOnly, stripLeadingMentions } from "../../shared/owner-pending-title";

const PARALLEL_SUFFIX = " · parallel work";
/** A teammate's handoff: "@<sender> · <label>", label "work" when none was given. */
const HANDOFF = /^@([^·]+?) · (.+)$/;

/** A teammate's handoff title, which displayThreadTitle rewrites whole. */
export const isHandoffTitle = (title: string): boolean => HANDOFF.test(title);

const capitalized = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

/** A conversation's title as shown, with the bot that opened it as the name its "@" may carry. */
export const shownTaskTitle = (task: { title: string; openedBy?: { name: string } | null }): string =>
  displayThreadTitle(task.title, task.openedBy?.name ? [task.openedBy.name] : []);

/** A search finds a conversation by the title as stored or as shown ("@Chief
 * of Staff · work" and "Pedido de Chief of Staff" alike; R12-visual N21).
 * `needle` is already lower-cased. */
export const titleMatches = (task: { title: string; openedBy?: { name: string } | null }, needle: string): boolean =>
  task.title.toLowerCase().includes(needle) || shownTaskTitle(task).toLowerCase().includes(needle);

/** `knownNames`: names a leading "@" may carry (the bot that opened it, the team). */
export function displayThreadTitle(title: string, knownNames: readonly string[] = []): string {
  if (title === "New thread") return t("task.newShort");
  if (title === "Team incidents") return t("task.title.incidents");
  const handoff = HANDOFF.exec(title);
  if (handoff) {
    const name = handoff[1]!.trim();
    const label = handoff[2]!;
    if (label === "work") return t("task.title.requestFrom", { name });
    if (label === "parallel work") return t("task.title.parallelFrom", { name });
    return t("task.title.labelFrom", { label: capitalized(displayThreadTitle(label, knownNames)), name });
  }
  if (title.endsWith(PARALLEL_SUFFIX)) return `${displayThreadTitle(title.slice(0, -PARALLEL_SUFFIX.length), knownNames)} · ${t("task.title.parallelWork")}`;
  if (title.startsWith("@")) {
    if (isMentionOnly(title, knownNames)) return t("task.title.requestFrom", { name: title.slice(1).trim() });
    return capitalized(stripLeadingMentions(title, knownNames));
  }
  return title;
}
