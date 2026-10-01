import { AlertTriangle, Eye, SquareTerminal } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ccAlertSummary, ccSessionsSummary, watchSummary } from "@/lib/thread-signals";

/** The eye (watches), the terminal (its Claude Code sessions, amber when one
 * runs headless, out of the Claude app) and the triangle (sessions in
 * trouble) a thread row shows, reused where a folded bot or its activity
 * rows stand for it. */
export function SignalIcons({ watch, cc, sessions, size = 11 }: { watch: ReturnType<typeof watchSummary>; cc: ReturnType<typeof ccAlertSummary>; sessions?: ReturnType<typeof ccSessionsSummary>; size?: number }) {
  return <>
    {watch && <Eye size={size} data-thread-watches className={cn("shrink-0", watch.failing ? "text-danger" : "text-ink-secondary")} aria-label={watch.text} role="img"><title>{watch.text}</title></Eye>}
    {sessions && <SquareTerminal size={size} data-thread-cc-sessions data-cli={sessions.cli || undefined} className={cn("shrink-0", sessions.cli ? "text-warning" : "text-ink-secondary")} aria-label={sessions.text} role="img"><title>{sessions.text}</title></SquareTerminal>}
    {cc && <AlertTriangle size={size} data-thread-cc-alert className={cn("shrink-0", cc.severe ? "text-danger" : "text-warning")} aria-label={cc.text} role="img"><title>{cc.text}</title></AlertTriangle>}
  </>;
}
