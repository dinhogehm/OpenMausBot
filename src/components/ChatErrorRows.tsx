// The rows a failed turn leaves in a conversation: the error, the failed place or trial credit, and the retry.
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { useStore, type InstanceInfo, type Message } from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { CHATGPT_USAGE_URL, ManageUsageLink } from "./ChatGptPlanStatus";
import { CODEX_USAGE_URL, codexUsageLimitReached } from "../../shared/codex-usage-limit";
import { ClaudeUpdatePrompt } from "./ClaudeUpdatePrompt";
import { MacCuaRecoveryActions } from "./MacCuaRecoveryActions";
import { macCuaPermissionMessage, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { failedTurnCause, signedOutEngine } from "@/lib/failed-turn";
import { plainErrorLine } from "@/lib/plain-error";
import { openPlaceAction, placeRowViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import type { PlaceRow } from "../../shared/place-view";
import { trialCreditKind, type TrialCreditRefusal } from "../../shared/trial-credit";
import { TrialCreditNotice } from "./TrialCreditNotice";
import type { LocaleKey } from "@/locales";
import { isProviderSafetyBlock, PROVIDER_SAFETY_GUIDANCE, PROVIDER_SAFETY_HELP_URL } from "../../shared/provider-safety";
import { useLimitResetContinue } from "./LimitResetContinue";
import { t } from "@/lib/i18n";

export function ErrorRow({
  message,
  headline: plainHeadline,
  onRetry,
  action,
  setupInstance,
  claudeUpdateInstance,
}: {
  message: string;
  headline?: string;
  onRetry?: () => void;
  action?: { label: string; onClick: () => void } | null;
  setupInstance?: InstanceInfo;
  claudeUpdateInstance?: InstanceInfo;
}) {
  const { capabilities, ready } = useDesktopCapabilities();
  const failedPermissions = missingMacCuaPermissions(message);
  const currentPermissions = missingMacCuaPermissions(capabilities.localComputer.message);
  const macCuaReason = ready && capabilities.host.platform === "darwin" &&
    capabilities.localComputer.available === false && capabilities.localComputer.reasonCode !== "remote-server" &&
    message.startsWith("CUA Driver is not ready for this computer — ") &&
    failedPermissions.length > 0 && failedPermissions.join(",") === currentPermissions.join(",")
    ? macCuaPermissionMessage(currentPermissions)
    : null;
  const headline = macCuaReason ?? plainHeadline ?? message;
  const usageUrl = action ? null : message.includes("subscription_sharing_usage_limit_exceeded") ? CHATGPT_USAGE_URL : codexUsageLimitReached(message) ? CODEX_USAGE_URL : null;
  return (
    <div className="flex justify-start">
      <div className="w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{headline}</span>
        </div>
        {headline !== message && <details className="mt-2 text-[12px] text-ink-secondary"><summary className="cursor-pointer">{macCuaReason ? t("computer.mac.permission.driverDetail") : t("chat.error.details")}</summary><p className="mt-1 break-words">{message}</p></details>}
        {macCuaReason &&
          <MacCuaRecoveryActions reason={message} />}
        {usageUrl ? (
          <ManageUsageLink href={usageUrl} className="ui-button ui-button-md mt-2 border-transparent bg-ink text-app hover:brightness-110" />
        ) : claudeUpdateInstance ? (
          <ClaudeUpdatePrompt instance={claudeUpdateInstance} onRetry={onRetry} />
        ) : isProviderSafetyBlock(message) ? (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
            {PROVIDER_SAFETY_GUIDANCE}{" "}
            <a href={PROVIDER_SAFETY_HELP_URL} target="_blank" rel="noreferrer" className="underline">About provider safety checks</a>
          </p>
        ) : setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : action !== undefined ? (
          action && (
            <button
              type="button"
              onClick={action.onClick}
              className="ui-button ui-button-md mt-1.5 rounded-full border-danger/30 bg-transparent text-danger hover:bg-danger/15"
            >
              {action.label}
            </button>
          )
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="ui-button ui-button-md mt-1.5 rounded-full border-danger/30 bg-transparent text-danger hover:bg-danger/15"
            >
              <RefreshCw size={12} /> {t("chat.retry")}
            </button>
          )
        )}
      </div>
    </div>
  );
}

export function PlaceFailedRow({ place, botId, threadId, onRetry }: {
  place: PlaceRow;
  botId: string;
  threadId?: string;
  onRetry?: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const seat = usePlaceSeat(state.config, capabilities.host.platform);
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const view = placeRowViewFor(place, seat, worksOnSimpleLabel(bot?.computer, capabilities.host.platform));
  const id = view.action?.id;
  const onClick = !id ? undefined
    : id === "try-again" ? onRetry
    : () => { openPlaceAction(id, { botId, threadId }, dispatch); };
  return <ErrorRow message={view.line} action={view.action && onClick ? { label: view.action.label, onClick } : null} />;
}

export const TRIAL_CREDIT_LINE: Record<"paused" | "too_low", LocaleKey> = { paused: "engines.trialCreditPaused", too_low: "engines.trialCreditTooLow" };

export function TrialCreditFailedRow({ kind, onRetry }: { kind: TrialCreditRefusal; onRetry?: () => void }) {
  const { dispatch } = useStore();
  if (kind === "used_up" || kind === "ended") return <TrialCreditNotice kind={kind} />;
  if (kind === "paused") return <ErrorRow message={t(TRIAL_CREDIT_LINE[kind])} onRetry={onRetry} />;
  return <ErrorRow message={t(TRIAL_CREDIT_LINE[kind])} action={{ label: t("chat.error.connectOwnAi"), onClick: () => dispatch({ type: "toggleAppSettings", open: true, section: "engines" }) }} />;
}

export function claudeUpdateTarget(engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return engine?.driverKind === "claudeAgent" && !engine.readOnly ? engine : undefined;
}

export function FailedTurnRow({ tool, engine, onRetry, botId, threadId }: {
  tool: NonNullable<Message["tool"]>;
  engine: InstanceInfo | undefined;
  onRetry?: () => void;
  botId?: string;
  threadId?: string;
}) {
  const resume = useLimitResetContinue(botId, threadId, tool.limitResetsAt);
  if (tool.place && botId) return <PlaceFailedRow place={tool.place} botId={botId} threadId={threadId} onRetry={onRetry} />;
  const credit = trialCreditKind(failedTurnCause(tool.name) ?? "");
  if (credit) return <TrialCreditFailedRow kind={credit} onRetry={onRetry} />;
  const signedOut = signedOutEngine(tool, engine);
  const cause = failedTurnCause(tool.name) ?? tool.name;
  return (
    <ErrorRow
      message={cause}
      headline={signedOut ? t("chat.error.signedOut", { name: signedOut.displayName }) : plainErrorLine(cause)}
      onRetry={onRetry}
      action={resume}
      setupInstance={tool.setup ? engine : undefined}
      claudeUpdateInstance={tool.claudeUpdate ? claudeUpdateTarget(engine) : undefined}
    />
  );
}
