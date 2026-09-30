// Thread titles the server makes up itself ("New thread", "Team incidents",
// "<title> · parallel work") are stored in English, the one language the
// server writes. Shown here in the person's language; a title a person or
// a bot wrote stays exactly as written.
import { t } from "@/lib/i18n";

const PARALLEL_SUFFIX = " · parallel work";

export function displayThreadTitle(title: string): string {
  if (title === "New thread") return t("task.newShort");
  if (title === "Team incidents") return t("task.title.incidents");
  if (title.endsWith(PARALLEL_SUFFIX)) return `${title.slice(0, -PARALLEL_SUFFIX.length)} · ${t("task.title.parallelWork")}`;
  return title;
}
