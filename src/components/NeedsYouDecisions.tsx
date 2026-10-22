// An item's history and its decisions, as the resolver shows them.
import { quietButton, sectionHeading, strongButton } from "./needsYouStyles";
import type { NeedsYouResolverViewProps } from "./NeedsYouResolver";
import { Check, CircleAlert, Clock, Loader2, Repeat, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { CHOICE_REPLACED } from "../../shared/owner-pending-title";
import { answerNotDelivered, answerTime, chosenOption, decisionsInOrder, needsYouKey, negativeDecision, waitingAge, type NeedsYouItem } from "@/lib/needs-you";

/** What the person answered, oldest first, and whether it reached the bot (J18). */
export function History({ item, now }: { item: NeedsYouItem; now: number }) {
  // the failure the banner above already explains; any other keeps its reason in view (INSP-J2 r5 B5)
  const explained = answerNotDelivered(item);
  return (
    <section className="mt-6 sm:mt-7" aria-labelledby="needs-you-history" data-resolver-history="">
      <h3 id="needs-you-history" className={sectionHeading}>{t("needsYou.screen.history")}</h3>
      <ol className="mt-2 flex flex-col gap-1.5">
        {item.history!.map((entry, n) => {
          const time = answerTime(entry.at, now);
          const what = entry.kind === "option"
            ? t("needsYou.history.option", { label: entry.label ?? "", time })
            : entry.kind === "text"
              ? t("needsYou.history.text", { text: entry.text.length > 140 ? `${entry.text.slice(0, 139)}…` : entry.text, time })
              : t(entry.label === "recommend" ? "needsYou.history.askRecommend" : entry.label === "remind" ? "needsYou.history.remind" : "needsYou.history.askSteps", { time, name: item.botName });
          // sent: a check, said to a screen reader and on hover — not repeated in every line (r2 N8);
          // waiting its turn: "na fila" (r2 N9); not sent: said in full
          const sent = t("needsYou.history.delivered", { name: item.botName });
          if (!entry.delivered && !entry.queued && entry.error === CHOICE_REPLACED) {
            const next = item.history!.slice(n + 1).find((each) => each.kind === "option");
            return (
              <li key={`${entry.at}-${n}`} data-history-state="replaced" className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-secondary">
                <Repeat size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">{what}{" — "}{next?.label ? t("needsYou.history.replacedBy", { label: next.label }) : t("needsYou.history.replaced")}</span>
              </li>
            );
          }
          return (
            <li key={`${entry.at}-${n}`} data-history-state={entry.delivered ? "delivered" : entry.queued ? "queued" : "failed"} title={entry.delivered ? sent : undefined} className="flex items-start gap-2 text-[13px] leading-relaxed text-ink">
              {entry.delivered
                ? <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
                : entry.queued
                  ? <Clock size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-secondary" />
                  : <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-danger" />}
              <span className="min-w-0 break-words">
                {what}
                {entry.delivered
                  ? <span className="sr-only">{` — ${sent}`}</span>
                  : (
                    <span className={entry.queued ? "text-ink-secondary" : "font-medium text-danger"}>
                      {/* the banner's own failure is not said twice (r4 A3); an older one shows its reason,
                          readable on touch and by a screen reader, not only on hover (r5 B5) */}
                      {" — "}{entry.queued ? t("needsYou.history.queued", { name: item.botName }) : <span title={entry.error}>{t("needsYou.history.notDelivered")}</span>}
                    </span>
                  )}
                {!entry.delivered && !entry.queued && entry.error && entry !== explained && (
                  <span data-history-reason="" className="block text-[12px] text-ink-secondary">{entry.error}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** How a decision is drawn (J15): the recommended one — or the first, when
 * the bot recommended none — filled with the accent; the others outlined in
 * the accent over a light wash of it; a decline or postponement outlined in
 * neutral. All read as buttons: an action icon, a pointer, hover, press and
 * a focus ring. The text pairs are measured in every skin by
 * scripts/check-skin-contrast.mjs (the "decisions" block). */
export type DecisionLook = "primary" | "secondary" | "neutral";

export function decisionLook(option: { label: string; recommended?: true }, _index: number, _options: ReadonlyArray<{ recommended?: true }>): DecisionLook {
  // only the bot's own recommendation is filled — never the first by its
  // position (INSP-J2 #1, INSP-I r1 #16) and never a refusal
  if (negativeDecision(option.label)) return "neutral";
  return option.recommended ? "primary" : "secondary";
}

export const DECISION_BASE = "group/decision relative flex min-w-0 cursor-pointer items-start gap-2.5 rounded-xl border-2 px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow,transform] focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50";

export const DECISION_LOOK: Record<DecisionLook, { button: string; label: string; sends: string; icon: string }> = {
  primary: { button: "border-accent bg-accent text-accent-ink shadow-sm hover:brightness-110 hover:shadow-md", label: "text-accent-ink", sends: "text-accent-ink", icon: "text-accent-ink" },
  secondary: { button: "border-accent bg-accent/8 hover:bg-accent/14 hover:shadow-sm", label: "text-accent-text", sends: "text-ink-secondary", icon: "text-accent-text" },
  neutral: { button: "border-hairline bg-panel hover:border-ink-secondary hover:bg-raised", label: "text-ink", sends: "text-ink-secondary", icon: "text-ink-secondary" },
};

/** The bot's decisions, each a button saying what it sends; the recommended
 * one first, with its badge and why (J16). In the footer the reply is
 * clipped to two lines (the button's title has it whole); inline it is
 * shown whole. Each keeps its index in the item: the server checks it. */
export function Decisions(props: NeedsYouResolverViewProps & { item: NeedsYouItem; placement: "footer" | "inline" }) {
  const { item, busy, placement, now } = props;
  const inline = placement === "inline";
  const options = item.options!;
  const recommended = options.some((option) => option.recommended);
  // what the person already chose (J18): marked, and another choice asks first
  const chosen = chosenOption(item);
  const switching = props.switching && props.switching.key === needsYouKey(item) ? options[props.switching.option] : undefined;
  return (
    <div role="group" aria-labelledby={`needs-you-decide-${placement}`}>
      <p id={`needs-you-decide-${placement}`} className={cn(sectionHeading, "mb-1.5")}>{t("needsYou.screen.decide")}</p>
      {switching && chosen && (
        <div role="alertdialog" aria-labelledby={`needs-you-switch-${placement}`} data-resolver-switch="" className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-warning/50 bg-panel px-3 py-2">
          <p id={`needs-you-switch-${placement}`} className="min-w-0 flex-1 text-[13px] text-ink">{t("needsYou.screen.switchAsk", { from: chosen, to: switching.label })}</p>
          {/* the question takes the focus (INSP-J2 #10) on the safe answer: an Enter by mistake
              keeps the choice; "Trocar" is one Tab away (r2 N5). Esc cancels it, not the whole screen */}
          <button type="button" data-resolver-switch-yes="" disabled={busy !== null} onClick={() => props.onDecide(item, props.switching!.option)} className={cn(strongButton, "py-1.5")}>{t("needsYou.screen.switchYes")}</button>
          {/* oxlint-disable-next-line jsx-a11y/no-autofocus */}
          <button type="button" autoFocus data-resolver-switch-no="" onClick={props.onCancelSwitch} className={quietButton}>{t("needsYou.screen.switchNo", { from: chosen })}</button>
        </div>
      )}
      {/* the footer: a compact 2-column grid (INSP-J2 #8); inline: one column, everything whole */}
      <div className={cn("grid gap-2", inline ? "grid-cols-1" : "grid-cols-2")}>
        {decisionsInOrder(options).map(({ option, index: n }) => {
          const look = DECISION_LOOK[decisionLook(option, n, options)];
          const isChosen = chosen === option.label;
          const name = [option.label, option.recommended ? t("needsYou.screen.recommendedWord") : "", isChosen ? t("needsYou.screen.chosenWord") : ""].filter(Boolean).join(", ");
          return (
            <button
              key={option.label}
              type="button"
              data-resolver-option={n}
              data-placement={placement}
              data-look={decisionLook(option, n, options)}
              {...(option.recommended ? { "data-recommended": "" } : {})}
              {...(isChosen ? { "data-chosen": "" } : {})}
              {...(chosen ? { "aria-pressed": isChosen } : {})}
              disabled={busy !== null}
              aria-label={name}
              aria-describedby={`needs-you-option-${placement}-${n}`}
              title={t("needsYou.screen.sends", { reply: option.reply })}
              // the chosen one again does nothing: it was sent already (INSP-J2 #4); another one asks first
              onClick={() => (isChosen ? undefined : chosen ? props.onAskSwitch(item, n) : props.onDecide(item, n))}
              // the chosen one: ringed in the ink and badged "Escolhido" — distinct from the recommended fill
              className={cn(DECISION_BASE, look.button, isChosen && "ring-2 ring-ink ring-offset-2 ring-offset-panel")}
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={cn("text-[14px] font-semibold leading-snug", look.label)}>{option.label}</span>
                  {option.recommended && (
                    <span aria-hidden="true" className="inline-flex items-center gap-1 rounded-full border border-current px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-accent-ink">
                      <Sparkles size={10} aria-hidden="true" />
                      {t("needsYou.screen.recommended")}
                    </span>
                  )}
                  {isChosen && (
                    <span aria-hidden="true" data-resolver-chosen-badge="" className={cn("inline-flex items-center gap-1 rounded-full border border-current px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide", look.label)}>
                      <Check size={10} aria-hidden="true" />
                      {t("needsYou.screen.chosen")}
                    </span>
                  )}
                </span>
                {option.recommended && option.why && (
                  <span className={cn("mt-0.5 block text-[12.5px] font-medium leading-snug", look.sends, !inline && "line-clamp-2")}>{option.why}</span>
                )}
                <span id={`needs-you-option-${placement}-${n}`} className={cn("mt-0.5 block text-[12px] leading-snug", look.sends, inline ? "break-words" : "line-clamp-2")}>
                  {option.recommended && option.why ? <span className="sr-only">{option.why}. </span> : null}
                  {t("needsYou.screen.sends", { reply: option.reply })}
                </span>
              </span>
              <span aria-hidden="true" className={cn("mt-0.5 shrink-0 transition-transform group-hover/decision:translate-x-0.5", look.icon)}>
                {busy === `option:${n}` ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </span>
            </button>
          );
        })}
      </div>
      {!recommended && options.length >= 2 && item.pendingId && (
        // an older item without the bot's pick: asking for it is the highlighted action (J16c, INSP-J2 #1)
        <button type="button" data-resolver-ask-recommend="" disabled={busy !== null} onClick={() => props.onAskRecommend(item)} className={cn(item.recommendRequestedAt ? quietButton : strongButton, "mt-2 py-1.5 text-[12.5px]", item.recommendRequestedAt && "-ml-1 px-2 text-accent-text")}>
          {busy === "recommend" ? <Loader2 size={13} aria-hidden="true" className="animate-spin" /> : <Sparkles size={13} aria-hidden="true" />}
          {item.recommendRequestedAt ? t("needsYou.screen.recommendAsked", { age: waitingAge(item.recommendRequestedAt, now) }) : t("needsYou.screen.askRecommend", { name: item.botName })}
        </button>
      )}
    </div>
  );
}
