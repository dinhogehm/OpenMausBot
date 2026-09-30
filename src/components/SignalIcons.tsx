import { AlertTriangle, Eye } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ccAlertSummary, watchSummary } from "@/lib/thread-signals";

/** The eye (watches) and the triangle (Claude Code sessions) a thread row
 * shows, reused where a folded bot or its activity rows stand for it. */
export function SignalIcons({ watch, cc, size = 11 }: { watch: ReturnType<typeof watchSummary>; cc: ReturnType<typeof ccAlertSummary>; size?: number }) {
  return <>
    {watch && <Eye size={size} data-thread-watches className={cn("shrink-0", watch.failing ? "text-danger" : "text-ink-secondary")} aria-label={watch.text} role="img"><title>{watch.text}</title></Eye>}
    {cc && <AlertTriangle size={size} data-thread-cc-alert className={cn("shrink-0", cc.severe ? "text-danger" : "text-warning")} aria-label={cc.text} role="img"><title>{cc.text}</title></AlertTriangle>}
  </>;
}
