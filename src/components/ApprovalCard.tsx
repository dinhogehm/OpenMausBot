// The approval box: what the bot wants to do, and three ways to answer.
//
// Deliberately not the lettered A/B/C list the onboarding card uses — an
// approval is a decision about one concrete action, so it shows the tool
// and the actual command/path in monospace, and the choices carry their
// own behavior instead of being matched by their label text.
import { Check, ShieldCheck, X } from "lucide-react";
import { type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t, tFromServer } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";

interface ToolLabels {
  [tool: string]: LocaleKey;
}

const ROUTINE_SETTLED_LABEL = {
  create: "approval.status.routineScheduled",
  update: "approval.status.routineUpdated",
  pause: "approval.status.routinePaused",
  resume: "approval.status.routineResumed",
  run_now: "approval.status.routineRunQueued",
  delete: "approval.status.routineDeleted",
} as const;

const SKILL_SETTLED_LABEL = {
  create: "approval.status.skillEnabled",
  update: "approval.status.skillUpdated",
} as const;

/** The tool's own name is noise to a human: mcp__ogb__computer_batch is
 * "computer batch", Bash is "run a command". */
function toolLabel(tool?: string): string {
  if (!tool) return t("approval.tool.action");
  const bare = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  const nice: ToolLabels = {
    Bash: "approval.tool.runCommand",
    Read: "approval.tool.readFile",
    Write: "approval.tool.writeFile",
    Edit: "approval.tool.editFile",
    WebFetch: "approval.tool.fetchWebPage",
    WebSearch: "approval.tool.searchWeb",
    schedule_routine: "approval.tool.scheduleRoutine",
    manage_routine: "approval.tool.changeRoutine",
    stage_skill: "approval.tool.enableSkill",
    update_skill: "approval.tool.updateSkill",
    update_profile: "approval.tool.updateProfile",
    workflow_approval: "approval.tool.workflowApproval",
  };
  const key = nice[tool];
  return key ? t(key) : bare;
}

/** The one card that decides in place: a workflow gate never takes over
 * the composer (it can wait for days), so its two answers live here. The
 * caller binds the thread — a bot's chat or a room — and the action is the
 * same `decideRequest` the composer sends for every other card. */
export type ApprovalCardDecision = (behavior: "allow" | "deny") => void;

/** How the workflow itself signs a card it posts into a room — the same
 * author a notify node's post carries, never a member of the room. */
export const WORKFLOW_AUTHOR_BOT_ID = "workflow";

export function ApprovalCard({
  bot,
  message,
  onDecide,
}: {
  /** who is asking, for the "Name wants to …" line */
  bot?: Bot;
  message: Message;
  /** Present where a workflow gate can be decided from this card; absent,
   * a pending gate card only says it is waiting (a transcript export). */
  onDecide?: ApprovalCardDecision;
}) {
  const card = message.card;
  if (!card) return null;
  const settled = card.answered;
  const isRoutineRequest = Boolean(card.routineRequest);
  const isSkillRequest = Boolean(card.skillRequest);
  const isProfileRequest = Boolean(card.profileRequest);
  const isWorkflowGate = Boolean(card.workflowApproval);
  const routineAction = card.routineRequest?.operation.action;
  const skillAction = card.skillRequest?.action;
  const heldNote = tFromServer(card.heldCode, card.held);
  const routineSettledLabel = routineAction ? t(ROUTINE_SETTLED_LABEL[routineAction]) : undefined;
  const skillSettledLabel = skillAction ? t(SKILL_SETTLED_LABEL[skillAction]) : undefined;
  const displayTool = isRoutineRequest
    ? routineAction === "create" ? "schedule_routine" : "manage_routine"
    : isSkillRequest
      ? skillAction === "update" ? "update_skill" : "stage_skill"
    : isProfileRequest
      ? "update_profile"
    : isWorkflowGate
      ? "workflow_approval"
    : card.tool;
  // A cross-bot profile card is shown in the PROPOSER's thread, so
  // "wants to update its profile" (fine for a bot editing itself) would
  // silently claim the proposer's own profile is changing. Name the actual
  // target whenever it differs from the proposer.
  // A gate is not the bot wanting anything: a workflow is waiting on the
  // person, and the card's own title already names the workflow and node.
  // In a room the card is signed by the workflow, not by any member, so
  // the header names the workflow rather than "someone".
  const workflowHeader = isWorkflowGate
    ? message.from?.botId === WORKFLOW_AUTHOR_BOT_ID || !bot
      ? t("approval.card.workflowGateUnowned")
      : t("approval.card.workflowGate", { name: bot.name })
    : undefined;
  const profileHeader = isProfileRequest && card.profileRequest
    ? card.profileRequest.targetBotId === card.profileRequest.botId
      ? t("approval.card.profileWantsToOwn", { name: bot?.name ?? t("approval.someone") })
      : t("approval.card.profileWantsToOther", {
          name: bot?.name ?? t("approval.someone"),
          target: card.profileRequest.targetName,
        })
    : undefined;

  return (
    <div
      className={cn(
        "w-full max-w-[840px] rounded-2xl border bg-card p-4",
        settled ? "border-hairline/30 opacity-70" : "border-accent/40",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-semibold text-ink">
          {workflowHeader ?? profileHeader ?? (
            <>
              {bot
                ? t("approval.card.namedWantsTo", { name: bot.name, action: toolLabel(displayTool) })
                : t("approval.card.wantsTo", { action: toolLabel(displayTool) })}
            </>
          )}
        </div>
        {displayTool && <span className="shrink-0 font-mono text-[11px] text-ink-secondary">{displayTool}</span>}
      </div>

      {/* what, exactly */}
      <pre
        tabIndex={0}
        aria-label={
          isRoutineRequest
            ? t("approval.aria.routineDetails")
            : isSkillRequest
              ? t("approval.aria.skillDetails")
              : isProfileRequest
                ? t("approval.aria.profileChange")
                : t("approval.aria.details")
        }
        className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink"
      >
        {card.subtitle}
      </pre>

      {card.skillRequest && <SkillRequestPreview request={card.skillRequest} />}

      {heldNote && (
        <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          {heldNote}
        </div>
      )}

      {/* A gate decides HERE, not in the composer: the card may stay open
          for days, and the chat must keep working around it. */}
      {isWorkflowGate && !settled && onDecide && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onDecide("deny")}
            className="rounded-full border border-danger/40 px-3.5 py-1.5 text-[13.5px] text-danger transition-colors hover:bg-danger/10"
          >
            {t("approval.action.reject")}
          </button>
          <button
            type="button"
            onClick={() => onDecide("allow")}
            className="rounded-full bg-accent px-3.5 py-1.5 text-[13.5px] font-medium text-white transition-colors hover:brightness-110"
          >
            {t("approval.action.approve")}
          </button>
        </div>
      )}

      {/* The decision lives in the composer (one place to answer, and it
          can't be scrolled past); here we only record what happened. */}
      <div className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-secondary">
        {settled === "allow" ? (
          <>
            <Check size={14} className="text-success" />
            {skillSettledLabel ??
              routineSettledLabel ??
              (isWorkflowGate
                ? t("approval.status.workflowApproved")
                : isProfileRequest
                  ? t("approval.status.profileUpdated")
                  : isRoutineRequest
                    ? t("approval.status.routineConfirmed")
                    : isSkillRequest
                      ? t("approval.status.skillConfirmed")
                      : t("approval.status.allowed"))}
          </>
        ) : settled ? (
          <>
            <X size={14} /> {isWorkflowGate
              ? settled === "unavailable"
                ? t("approval.status.workflowClosed")
                : t("approval.status.workflowRejected")
              : isRoutineRequest || isSkillRequest || isProfileRequest
                ? t("approval.status.cancelled")
                : t("approval.status.denied")}
          </>
        ) : (
          <>
            <ShieldCheck size={14} className="text-accent" />
            {isWorkflowGate
              ? t("approval.status.waitingDecision")
              : isRoutineRequest || isSkillRequest || isProfileRequest
                ? t("approval.status.waitingConfirmation")
                : t("approval.status.waitingAnswer")}
          </>
        )}
      </div>
    </div>
  );
}
