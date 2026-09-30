// The work digest's tooltip, in the reader's language. The stored digest
// text (server/digest.ts renderDigest) stays English: it is what the model
// and the search index read.
import type { TurnDigest } from "../../shared/digest";
import { t } from "@/lib/i18n";

export function digestTooltip(digest: Pick<TurnDigest, "tools" | "toolsDropped" | "files" | "memory" | "memoryDropped" | "reply" | "hookCoverage">): string {
  const lines: string[] = [];
  if (digest.tools.length) {
    const tools = digest.tools.map((tool) => (tool.failed ? t("chat.digestToolFailed", { name: tool.name, count: tool.count, failed: tool.failed }) : `${tool.name} ×${tool.count}`)).join(", ");
    lines.push(t("chat.digestTools", { tools: `${tools}${digest.toolsDropped ? ` ${t("chat.digestToolsMore", { count: digest.toolsDropped })}` : ""}` }));
  } else {
    lines.push(digest.hookCoverage === "none" ? t("chat.digestNoActivity") : t("chat.digestNoTools"));
  }
  if (digest.files) {
    const parts = [
      digest.files.changed.length ? t("chat.digestChanged", { paths: digest.files.changed.join(", ") }) : "",
      digest.files.added.length ? t("chat.digestAdded", { paths: digest.files.added.join(", ") }) : "",
      digest.files.deleted.length ? t("chat.digestDeleted", { paths: digest.files.deleted.join(", ") }) : "",
      digest.files.truncated ? t("chat.digestMorePaths", { count: digest.files.truncated }) : "",
    ].filter(Boolean);
    lines.push(parts.length ? t("chat.digestFiles", { files: parts.join("; ") }) : t("chat.digestNoFiles"));
  }
  if (digest.memory?.length) lines.push(t("chat.digestMemory", { items: `${digest.memory.map((item) => item.path).join(", ")}${digest.memoryDropped ? ` +${digest.memoryDropped}` : ""}` }));
  if (digest.reply) lines.push(t("chat.digestReply", { reply: digest.reply }));
  return lines.join("\n");
}
