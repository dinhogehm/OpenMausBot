import { AlertTriangle, Eye, Hourglass, SquareTerminal, StepForward } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ccAlertSummary, ccSessionsSummary, watchSummary } from "@/lib/thread-signals";

/** The eye (watches), the terminal (its Claude Code sessions, amber when one
 * runs headless, out of the Claude app), the hourglass (steps in the Claude
 * app not done yet, with their count when more than one — R8-dispatch D6),
 * the step-forward mark (sessions to resume: they hold an open PR —
 * S-retomar; not a turn-back arrow, which read as "reload/undo" next to the
 * amber terminal — INSP-S r1 S-7), with their count too, and the triangle
 * (sessions in trouble) a thread row shows, reused where a folded bot or its
 * activity rows stand for it. */
export function SignalIcons({ watch, cc, sessions, size = 11 }: { watch: ReturnType<typeof watchSummary>; cc: ReturnType<typeof ccAlertSummary>; sessions?: ReturnType<typeof ccSessionsSummary>; size?: number }) {
  return <>
    {watch && <Eye size={size} data-thread-watches className={cn("shrink-0", watch.failing ? "text-danger" : "text-ink-secondary")} aria-label={watch.text} role="img"><title>{watch.text}</title></Eye>}
    {sessions && <SquareTerminal size={size} data-thread-cc-sessions data-cli={sessions.cli || undefined} className={cn("shrink-0", sessions.cli ? "text-warning" : "text-ink-secondary")} aria-label={sessions.text} role="img"><title>{sessions.text}</title></SquareTerminal>}
    {sessions?.waiting && (
      <span data-thread-cc-waiting={sessions.waiting.count} role="img" aria-label={sessions.waiting.text} title={sessions.waiting.text} className="inline-flex shrink-0 items-center gap-px text-ink-secondary">
        <Hourglass size={size} aria-hidden="true" />
        {sessions.waiting.count > 1 && <span aria-hidden="true" className="text-[10px] leading-none tabular-nums">{sessions.waiting.count}</span>}
      </span>
    )}
    {sessions?.resume && (
      // amber to act on; the secondary ink, "on hold", while a release holds every one of them
      <span data-thread-cc-resume={sessions.resume.count} data-held={sessions.resume.held || undefined} role="img" aria-label={sessions.resume.text} title={sessions.resume.text} className={cn("inline-flex shrink-0 items-center gap-px", sessions.resume.held ? "text-ink-secondary" : "text-warning")}>
        <StepForward size={size} aria-hidden="true" />
        {sessions.resume.count > 1 && <span aria-hidden="true" className="text-[10px] leading-none tabular-nums">{sessions.resume.count}</span>}
      </span>
    )}
    {cc && <AlertTriangle size={size} data-thread-cc-alert className={cn("shrink-0", cc.severe ? "text-danger" : "text-warning")} aria-label={cc.text} role="img"><title>{cc.text}</title></AlertTriangle>}
  </>;
}
