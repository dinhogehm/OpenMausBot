import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft, BellRing, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Clock, Copy, ExternalLink, Inbox,
  ListChecks, ListTodo, Loader2, MessageSquare, Send, ShieldQuestion, Sparkles, X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  answerNotDelivered, answerStuck, answerTime, awaitingBot, botSilent, chosenOption, decisionsInOrder, dueAt, waitingOnYou, needsYouBots, needsYouKey, needsYouSteps, negativeDecision, sortNeedsYou, waitingAge,
  type NeedsYouItem, type NeedsYouSort,
} from "@/lib/needs-you";

/** What a key press does on the resolution screen. Text fields keep their
 * keys: ⌘/Ctrl+Enter sends and Escape only leaves the field. Elsewhere ↑/↓
 * (or k/j) walk the items, r goes to the reply, Escape closes. Decisions
 * have no shortcut on purpose: one stray key must never answer a bot. */
export type ResolverKeyAction = "close" | "leaveField" | "prev" | "next" | "send" | "focusReply" | null;
export function resolverKeyAction(event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; inField: boolean }): ResolverKeyAction {
  if (event.key === "Escape") return event.inField ? "leaveField" : "close";
  if (event.inField) return event.key === "Enter" && (event.metaKey || event.ctrlKey) ? "send" : null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === "ArrowDown" || key === "j") return "next";
  if (key === "ArrowUp" || key === "k") return "prev";
  if (key === "r") return "focusReply";
  return null;
}

/** What a link opens, said plainly: "a PR #12", "a issue #40", "a sessão no Claude", or the host. */
export function linkLabel(url: string): string {
  const github = /github\.com\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)/i.exec(url);
  if (github) return t(github[1]!.toLowerCase() === "pull" ? "needsYou.link.pr" : "needsYou.link.issue", { number: github[2]! });
  if (/^claude:\/\//i.test(url)) return t("needsYou.link.claude");
  try {
    return t("needsYou.link.host", { host: new URL(url).host.replace(/^www\./, "") });
  } catch {
    return t("needsYou.link.other");
  }
}

export type ResolverBusy = null | "reply" | "resolve" | "steps" | "recommend" | "remind" | `option:${number}`;

export interface NeedsYouResolverViewProps {
  items: NeedsYouItem[];
  now: number;
  selectedKey: string | null;
  /** Where the selection was, so a resolved item hands over to the next one. */
  fallbackIndex: number;
  botFilter: string | null;
  sort: NeedsYouSort;
  /** Below md the screen shows the list or the item, not both. */
  pane: "list" | "detail";
  draft: string;
  resolveOnSend: boolean;
  busy: ResolverBusy;
  error: string | null;
  /** What was just done, naming its item (the screen may show another one by now). */
  notice: string | null;
  /** How the notice reads: done (default) or neutral news (INSP-J2 r5 B4). */
  noticeTone?: "success" | "info";
  copied: string | null;
  replyRef?: RefObject<HTMLTextAreaElement | null>;
  closeRef?: RefObject<HTMLButtonElement | null>;
  onSelect: (key: string) => void;
  onFilter: (botId: string | null) => void;
  onSort: (sort: NeedsYouSort) => void;
  onBack: () => void;
  onClose: () => void;
  onDraft: (text: string) => void;
  onResolveOnSend: (value: boolean) => void;
  onCopy: (text: string) => void;
  onOpenLink: (url: string) => void;
  onDecide: (item: NeedsYouItem, option: number) => void;
  onReply: (item: NeedsYouItem) => void;
  onAskSteps: (item: NeedsYouItem) => void;
  onAskRecommend: (item: NeedsYouItem) => void;
  /** "Lembrar <bot>": an answered item its bot let go silent (INSP-J2 r2 N3). */
  onRemind: (item: NeedsYouItem) => void;
  /** Another decision than the one already chosen: asked to confirm first (J18). */
  switching?: { key: string; option: number } | null;
  onAskSwitch: (item: NeedsYouItem, option: number) => void;
  onCancelSwitch: () => void;
  /** The answered item whose decisions the person opened again ("Mudar resposta"). */
  changingAnswer?: string | null;
  onChangeAnswer: (item: NeedsYouItem) => void;
  onResolve: (item: NeedsYouItem) => void;
  onOpenConversation: (item: NeedsYouItem) => void;
  onDismissError: () => void;
  onDismissNotice?: () => void;
}

/** The visible list (filtered by bot, sorted) and the item on screen. */
export function resolverSelection(props: Pick<NeedsYouResolverViewProps, "items" | "botFilter" | "sort" | "now" | "selectedKey" | "fallbackIndex">) {
  const filtered = props.botFilter ? props.items.filter((item) => item.botId === props.botFilter) : props.items;
  const sorted = sortNeedsYou(filtered, props.sort, props.now);
  // what waits on the person first; what waits on a bot after, in the same order (INSP-J2 #2)
  const visible = [...sorted.filter((each) => !awaitingBot(each, props.now)), ...sorted.filter((each) => awaitingBot(each, props.now))];
  const found = visible.findIndex((item) => needsYouKey(item) === props.selectedKey);
  const index = found >= 0 ? found : Math.min(Math.max(props.fallbackIndex, 0), visible.length - 1);
  return { visible, index, item: visible[index] ?? null };
}

/** The row's DOM id, for focus to follow the selection. */
export const resolverRowId = (key: string) => `needs-you-row-${key.replace(/[^\w-]/g, "-")}`;

const iconButton = "flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary outline-none hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-35";
const quietButton = "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] text-ink-secondary outline-none hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40";
// the app's primary button: the skin's accent and its ink (every skin clears
// 4.5:1 there — pnpm check:contrast; Midnight's accent was fixed for it)
const strongButton = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:pointer-events-none disabled:opacity-40";
// overdue: the danger color on the panel itself, ringed — a tint under it
// drops below 4.5:1 on a selected (raised) row (INSP-I r1 #12)
const OVERDUE = "border-danger/50 bg-panel font-semibold text-danger";
const sectionHeading ="text-[11.5px] font-semibold uppercase tracking-wide text-ink-secondary";
/** Where the decisions sit: in the fixed footer on a roomy window; on a short
 * or narrow one, in the scrolling item after the steps (INSP-I r1 #5). */
const ROOMY = "max-sm:hidden [@media(max-height:760px)]:hidden";
const CRAMPED = "sm:[@media(min-height:761px)]:hidden";
/** More than two decisions take a third of a laptop screen (1366×768): below
 * 900px of height they go into the item too (INSP-I r2 #4). */
const ROOMY_MANY = "max-sm:hidden [@media(max-height:899px)]:hidden";
const CRAMPED_MANY = "sm:[@media(min-height:900px)]:hidden";
const placement = (options: number) => (options > 2 ? { roomy: ROOMY_MANY, cramped: CRAMPED_MANY } : { roomy: ROOMY, cramped: CRAMPED });

/** "Ver as N decisões": scroll only the item (never the dialog or the page)
 * to the decisions, and put focus on the first one (INSP-I r2 #2). */
function jumpToDecisions() {
  const scroller = document.getElementById("needs-you-item-scroll");
  const target = document.getElementById("needs-you-decide-inline");
  if (!scroller || !target) return;
  const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8;
  scroller.scrollTo({ top, behavior: "smooth" });
  scroller.querySelector<HTMLElement>("[data-placement='inline'][data-resolver-option='0']")?.focus({ preventScroll: true });
}

/** The resolution screen itself, without portal, focus or key handling —
 * every value and handler comes in as props, so it renders to static markup
 * in tests and its buttons can be pressed there. */
export function NeedsYouResolverView(props: NeedsYouResolverViewProps) {
  const { items, now, pane } = props;
  const { visible, index, item } = resolverSelection(props);
  const bots = needsYouBots(items);
  const yours = waitingOnYou(items, now).length;
  const filterName = bots.find((bot) => bot.botId === props.botFilter)?.botName;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="needs-you-resolver-title"
      data-testid="needs-you-resolver"
      tabIndex={-1}
      className="relative flex h-[min(760px,calc(100dvh-1rem))] w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel text-ink shadow-2xl outline-none"
    >
      <header className="flex items-center gap-2.5 border-b border-hairline/50 px-4 py-2.5 sm:px-5 sm:py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning/12 text-warning" aria-hidden="true">
          <CircleAlert size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 id="needs-you-resolver-title" className="text-[15px] font-semibold leading-tight">{t("needsYou.title")}</h1>
          <p className="truncate text-[12px] text-ink-secondary">
            {/* what waits on the person only: the answered ones wait on a bot (INSP-J2 #2) */}
            {yours ? t(yours === 1 ? "needsYou.screen.countOne" : "needsYou.screen.count", { count: yours }) : t("needsYou.screen.countNone")}
          </p>
        </div>
        <button ref={props.closeRef} type="button" aria-label={t("needsYou.screen.close")} title={t("needsYou.screen.closeHint")} onClick={props.onClose} className={iconButton}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      {!items.length ? (
        <EmptyState />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* the list: every item, filtered and sorted — nothing hidden "below" */}
          <nav
            aria-label={t("needsYou.screen.listAria")}
            className={cn("min-h-0 w-full flex-col border-hairline/50 md:flex md:w-[320px] md:shrink-0 md:border-r lg:w-[340px]", pane === "list" ? "flex" : "hidden")}
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-hairline/40 px-3 py-2.5">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">{t("needsYou.screen.filterLabel")}</span>
                <select
                  value={props.botFilter ?? ""}
                  onChange={(event) => props.onFilter(event.target.value || null)}
                  className="w-full appearance-none truncate rounded-lg border border-hairline/60 bg-inset py-1.5 pl-2.5 pr-7 text-[12.5px] text-ink outline-none focus-visible:border-focus focus-visible:ring-1 focus-visible:ring-focus"
                >
                  <option value="">{t("needsYou.screen.allBots", { count: items.length })}</option>
                  {bots.map((bot) => <option key={bot.botId} value={bot.botId}>{`${bot.botName} (${bot.count})`}</option>)}
                </select>
                <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-secondary" />
              </label>
              {/* two toggle buttons, not a radio group: Tab reaches each, Enter/Space picks (INSP-I r1 #11a) */}
              <div role="group" aria-label={t("needsYou.screen.sortLabel")} className="flex shrink-0 rounded-lg border border-hairline/60 bg-inset p-0.5">
                {(["due", "age"] as const).map((sort) => (
                  <button
                    key={sort}
                    type="button"
                    aria-pressed={props.sort === sort}
                    data-sort={sort}
                    onClick={() => props.onSort(sort)}
                    className={cn("rounded-md px-2.5 py-1 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-focus", props.sort === sort ? "bg-raised font-medium text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}
                  >
                    {t(sort === "due" ? "needsYou.screen.sortDue" : "needsYou.screen.sortAge")}
                  </button>
                ))}
              </div>
            </div>
            {visible.length ? (
              <ul className="min-h-0 flex-1 overflow-y-auto py-1.5">
                {visible.map((each, position) => {
                  const key = needsYouKey(each);
                  const selected = position === index;
                  const overdue = isOverdue(each, now);
                  const Icon = each.approval ? ShieldQuestion : each.options?.length ? ListChecks : each.pendingId ? ListTodo : CircleAlert;
                  // the answered ones come last, under their own heading and count (INSP-J2 #2)
                  const firstAwaiting = awaitingBot(each, now) && (position === 0 || !awaitingBot(visible[position - 1]!, now));
                  return (
                    <li key={key} className="px-1.5">
                      {firstAwaiting && (
                        <p data-resolver-awaiting-section="" className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
                          {t("needsYou.screen.awaitingSection", { count: visible.filter((other) => awaitingBot(other, now)).length })}
                        </p>
                      )}
                      <button
                        type="button"
                        id={resolverRowId(key)}
                        data-resolver-row={key}
                        aria-current={selected ? "true" : undefined}
                        // one tab stop for the whole list: the selected row; arrows walk the rest (INSP-I r1 #11c)
                        tabIndex={selected ? 0 : -1}
                        onClick={() => props.onSelect(key)}
                        className={cn(
                          "relative flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
                          selected ? "bg-raised" : "hover:bg-raised/50",
                        )}
                      >
                        {selected && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-accent" />}
                        <Icon size={15} aria-hidden="true" className={cn("mt-0.5 shrink-0", each.approval || !each.pendingId ? "text-warning" : "text-ink-secondary")} />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 break-words text-[13px] leading-snug text-ink">{each.title}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
                            <span className="min-w-0 truncate">{each.botName}</span>
                            <span aria-hidden="true">·</span>
                            <span className="shrink-0 tabular-nums">{waitingAge(each.since, now)}</span>
                          </span>
                          {/* answered: now it waits on the bot, not on the person (J18) */}
                          {awaitingBot(each, now) && (
                            <span data-resolver-awaiting="" className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full border border-hairline/70 px-1.5 py-px text-[11px] font-medium text-ink-secondary">
                              <Clock size={11} aria-hidden="true" />
                              <span className="truncate">{t("needsYou.screen.awaiting", { name: each.botName })}</span>
                            </span>
                          )}
                          {/* the bot did nothing for 2 h: back with the person, said so (INSP-J2 #2) */}
                          {botSilent(each, now) && (
                            <span data-resolver-silent-row="" className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full border border-warning/60 px-1.5 py-px text-[11px] font-medium text-ink">
                              <CircleAlert size={11} aria-hidden="true" className="text-warning" />
                              <span className="truncate">{t("needsYou.screen.botSilentShort", { name: each.botName })}</span>
                            </span>
                          )}
                          {/* the answer sat in the queue for 2 h: back with the person (INSP-J2 r4 A1) */}
                          {answerStuck(each, now) && (
                            <span data-resolver-stuck-row="" className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full border border-warning/60 px-1.5 py-px text-[11px] font-medium text-ink">
                              <Clock size={11} aria-hidden="true" className="text-warning" />
                              <span className="truncate">{t("needsYou.screen.stuckShort", { age: waitingAge(each.awaitingSince!, now) })}</span>
                            </span>
                          )}
                        </span>
                        {each.due && (
                          <span className={cn("mt-0.5 max-w-[96px] shrink-0 truncate rounded-full border px-1.5 py-px text-[11px]", overdue ? OVERDUE : "border-transparent bg-inset font-medium text-ink-secondary")}>
                            {each.due}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <p className="text-[13px] text-ink-secondary">{t("needsYou.screen.filterEmpty", { name: filterName ?? "" })}</p>
                <button type="button" onClick={() => props.onFilter(null)} className={quietButton}>{t("needsYou.screen.showAll")}</button>
              </div>
            )}
            <p className="hidden border-t border-hairline/40 px-3 py-2 text-[11px] text-ink-secondary md:block">{t("needsYou.screen.keys")}</p>
          </nav>

          {/* the item on screen */}
          <section
            aria-labelledby="needs-you-item-title"
            className={cn("min-h-0 min-w-0 flex-1 flex-col md:flex", pane === "detail" ? "flex" : "hidden")}
          >
            {item ? (
              <ItemDetail
                {...props}
                item={item}
                position={index}
                total={visible.length}
                prevKey={index > 0 ? needsYouKey(visible[index - 1]!) : null}
                nextKey={index < visible.length - 1 ? needsYouKey(visible[index + 1]!) : null}
              />
            ) : null}
          </section>
        </div>
      )}

      {/* nothing left on screen to anchor to: the last notice sits under the empty state */}
      {!items.length && <div className="px-4 pb-4"><Notice {...props} /></div>}
    </div>
  );
}

/** What was just done, naming its item (which may have left the screen —
 * INSP-I r1 #9). In the flow of the item's footer, above its buttons: it
 * never covers a control or the next title, and takes at most two lines,
 * the whole text in its tooltip (INSP-I r2 #3). The live region is always
 * there, so a screen reader hears each notice. */
function Notice(props: Pick<NeedsYouResolverViewProps, "notice" | "noticeTone" | "onDismissNotice">) {
  // "info": news that is neither a success nor a failure ("ainda está na fila") — neutral (INSP-J2 r5 B4)
  const info = props.noticeTone === "info";
  return (
    <div role="status" aria-live="polite">
      {props.notice ? (
        <p data-resolver-notice="" data-tone={info ? "info" : "success"} title={props.notice} className={cn("mb-2.5 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-snug text-ink", info ? "border-hairline bg-panel" : "border-success/30 bg-success/8")}>
          {info
            ? <Clock size={14} aria-hidden="true" className="mt-px shrink-0 text-ink-secondary" />
            : <CircleCheck size={14} aria-hidden="true" className="mt-px shrink-0 text-success" />}
          <span className="line-clamp-2 min-w-0 flex-1 break-words">{props.notice}</span>
          {props.onDismissNotice && (
            <button type="button" aria-label={t("needsYou.screen.dismissNotice")} onClick={props.onDismissNotice} className="-mr-1 shrink-0 rounded p-0.5 text-ink-secondary hover:text-ink">
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </p>
      ) : null}
    </div>
  );
}

function isOverdue(item: NeedsYouItem, now: number): boolean {
  const at = dueAt(item.due, now);
  return at !== null && at < now;
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center" data-testid="needs-you-empty">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-success/12 text-success" aria-hidden="true">
        <Inbox size={22} />
      </span>
      <p className="text-[15px] font-semibold">{t("needsYou.screen.emptyTitle")}</p>
      <p className="max-w-[360px] text-[13px] leading-relaxed text-ink-secondary">{t("needsYou.screen.emptyBody")}</p>
    </div>
  );
}

const sameText = (a: string, b: string) => a.replace(/\W+/g, " ").trim().toLowerCase() === b.replace(/\W+/g, " ").trim().toLowerCase();

function ItemDetail(props: NeedsYouResolverViewProps & { item: NeedsYouItem; position: number; total: number; prevKey: string | null; nextKey: string | null }) {
  const { item, now, busy, position, total, prevKey, nextKey } = props;
  const steps = needsYouSteps(item);
  const overdue = isOverdue(item, now);
  const pending = Boolean(item.pendingId);
  // a real reason only: no filler, and never the title said twice (INSP-I r1 #2/#18)
  const why = item.why && !sameText(item.why, item.title) ? item.why : item.approval ? t("needsYou.why.approval", { name: item.botName }) : "";
  const working = busy !== null;
  const layout = placement(item.options?.length ?? 0);
  const replyId = `needs-you-reply-${needsYouKey(item).replace(/[^\w-]/g, "-")}`;
  const awaiting = awaitingBot(item, now);
  const silent = botSilent(item, now);
  const stuck = answerStuck(item, now);
  const notDelivered = notDeliveredLine(item, now);
  // answered and waiting on the bot: the decisions fold behind "Mudar resposta" (INSP-J2 #2)
  const decisionsOpen = Boolean(item.options?.length) && (!awaiting || props.changingAnswer === needsYouKey(item));
  return (
    <>
      <div className="flex items-center gap-1 border-b border-hairline/40 px-2 py-1.5 sm:px-3">
        <button type="button" onClick={props.onBack} className={cn(quietButton, "px-2 md:hidden")}>
          <ArrowLeft size={15} aria-hidden="true" />
          {t("needsYou.screen.back")}
        </button>
        <span className="flex-1" />
        <span className="px-1 text-[12px] tabular-nums text-ink-secondary">{t("needsYou.screen.position", { position: position + 1, total })}</span>
        <button type="button" aria-label={t("needsYou.screen.prev")} title={t("needsYou.screen.prev")} data-resolver-prev="" disabled={!prevKey} onClick={() => prevKey && props.onSelect(prevKey)} className={iconButton}>
          <ChevronLeft size={17} aria-hidden="true" />
        </button>
        <button type="button" aria-label={t("needsYou.screen.next")} title={t("needsYou.screen.next")} data-resolver-next="" disabled={!nextKey} onClick={() => nextKey && props.onSelect(nextKey)} className={iconButton}>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>

      <div id="needs-you-item-scroll" className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4 sm:px-7 sm:pt-5">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-ink-secondary">
          <span><span className="font-medium text-ink">{item.botName}</span> {t("needsYou.screen.askedAgo", { age: waitingAge(item.since, now) })}</span>
          {item.threadTitle && (item.threadTitle !== item.title || item.threadKind) && (
            // the separator travels with what it introduces: never alone at a line's end (INSP-I r1 #19);
            // a routine's run or an archived conversation is said: "Abrir conversa" opens it all the same
            <span data-resolver-thread-kind={item.threadKind} className="min-w-0 max-w-full truncate"><span aria-hidden="true">· </span>{t(item.threadKind === "routine" ? "needsYou.screen.inRoutineThread" : item.threadKind === "archived" ? "needsYou.screen.inArchivedThread" : "needsYou.screen.inThread", { title: item.threadTitle })}</span>
          )}
        </p>
        <h2 id="needs-you-item-title" className="mt-1.5 break-words text-[18px] font-semibold leading-snug text-ink sm:mt-2 sm:text-[21px]">{item.title}</h2>
        {/* the panel reworded the title (a mention set aside, references moved): what the bot wrote, as written */}
        {pending && item.rawTitle && (
          <p className="mt-1 break-words text-[12px] text-ink-secondary">{t("needsYou.screen.botWrote", { title: item.rawTitle })}</p>
        )}
        {(item.due || item.link) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {item.due && (
              <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]", overdue ? OVERDUE : "border-transparent bg-inset font-medium text-ink-secondary")}>
                <Clock size={13} aria-hidden="true" />
                {t(overdue ? "needsYou.screen.overdue" : "needsYou.screen.due", { due: item.due })}
              </span>
            )}
            {item.link && (
              <button type="button" data-resolver-link={item.link} onClick={() => props.onOpenLink(item.link!)} title={item.link} className="inline-flex items-center gap-1.5 rounded-full border border-hairline/60 px-2.5 py-1 text-[12px] text-accent-text outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus">
                <ExternalLink size={13} aria-hidden="true" />
                {t("needsYou.screen.open", { what: linkLabel(item.link) })}
              </button>
            )}
          </div>
        )}

        {awaiting && (
          // the person answered: the ball is with the bot — said with what was answered (INSP-J2 #9)
          <p role="status" data-resolver-awaiting-detail="" className="mt-3 flex items-start gap-2 rounded-lg border border-accent/40 bg-panel px-3 py-2 text-[13px] text-ink">
            <Clock size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text" />
            <span>{awaitingLine(item, now)}</span>
          </p>
        )}
        {silent && (
          // the bot did nothing for 2 h: the item is the person's again (INSP-J2 #2)
          <div data-resolver-silent="" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning/60 bg-panel px-3 py-2 text-[13px] text-ink">
            <p role="status" className="flex min-w-0 flex-1 basis-60 items-start gap-2">
              <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
              <span>{t("needsYou.screen.botSilent", { name: item.botName, age: waitingAge(item.awaitingSince!, now) })}</span>
            </p>
            {/* the obvious next step: remind the bot — as the server, never in the person's words (INSP-J2 r2 N3) */}
            {pending && (
              <button type="button" data-resolver-remind="" disabled={working} onClick={() => props.onRemind(item)} className={cn(strongButton, "py-1.5 text-[12.5px]")}>
                {busy === "remind" ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <BellRing size={14} aria-hidden="true" />}
                {t("needsYou.screen.remind", { name: item.botName })}
              </button>
            )}
          </div>
        )}
        {stuck && (
          // the answer sat in the queue for 2 h: the person's again, with the conversation as the way in — no reminder, it would not pass the queue (INSP-J2 r4 A1)
          <div data-resolver-stuck="" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning/60 bg-panel px-3 py-2 text-[13px] text-ink">
            <p role="status" className="flex min-w-0 flex-1 basis-60 items-start gap-2">
              <Clock size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
              <span>{stuckLine(item, now)}</span>
            </p>
            <button type="button" data-resolver-stuck-conversation="" onClick={() => props.onOpenConversation(item)} className={cn(strongButton, "py-1.5 text-[12.5px]")}>
              <MessageSquare size={14} aria-hidden="true" />
              {t("needsYou.screen.openConversation")}
            </button>
          </div>
        )}
        {notDelivered && (
          // the answer never reached the bot (cancelled, failed, lost in a restart): the item is the person's again (INSP-J2 r3 R2)
          <p role="status" data-resolver-not-delivered="" className="mt-3 flex items-start gap-2 rounded-lg border border-danger/40 bg-panel px-3 py-2 text-[13px] text-ink">
            <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-danger" />
            <span>{notDelivered}</span>
          </p>
        )}
        {/* what was answered comes first: it is what the person looks for when they come back (INSP-J2 #8) */}
        {item.history?.length ? <History item={item} now={now} /> : null}

        {why && (
          <section className="mt-5 sm:mt-6" aria-labelledby="needs-you-why">
            <h3 id="needs-you-why" className={sectionHeading}>{t("needsYou.screen.why")}</h3>
            <p className="mt-1.5 max-w-[68ch] text-[14px] leading-relaxed text-ink">{why}</p>
          </section>
        )}

        <section className="mt-5 sm:mt-6" aria-labelledby="needs-you-steps">
          <h3 id="needs-you-steps" className={sectionHeading}>{t("needsYou.screen.steps")}</h3>
          {steps.length ? (
            <ol className="mt-2.5 flex flex-col gap-3">
              {steps.map((step, n) => (
                <li key={n} className="flex gap-3">
                  <span aria-hidden="true" className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[12px] font-semibold tabular-nums text-accent-text">{n + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] leading-relaxed text-ink"><span className="sr-only">{t("needsYou.screen.stepNumber", { number: n + 1 })} </span>{step.text}</p>
                    {step.command && (
                      <div className="mt-2 flex items-start gap-2 rounded-lg border border-hairline/60 bg-inset py-2 pl-3 pr-1.5">
                        <code className="min-w-0 flex-1 whitespace-pre-wrap py-0.5 font-mono text-[12.5px] leading-relaxed text-ink [overflow-wrap:anywhere]">{step.command}</code>
                        <button
                          type="button"
                          data-resolver-copy={step.command}
                          aria-label={t("needsYou.screen.copyStep", { number: n + 1 })}
                          onClick={() => props.onCopy(step.command!)}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary outline-none hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          {props.copied === step.command ? <Check size={13} aria-hidden="true" className="text-success" /> : <Copy size={13} aria-hidden="true" />}
                          <span aria-hidden="true">{props.copied === step.command ? t("needsYou.screen.copied") : t("needsYou.screen.copy")}</span>
                        </button>
                      </div>
                    )}
                    {step.link && (
                      <button type="button" data-resolver-link={step.link} aria-label={t("needsYou.screen.openStep", { what: linkLabel(step.link), number: n + 1 })} onClick={() => props.onOpenLink(step.link!)} title={step.link} className="-ml-1.5 mt-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] text-accent-text outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus">
                        <ExternalLink size={13} aria-hidden="true" />
                        {t("needsYou.screen.open", { what: linkLabel(step.link) })}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <NoSteps {...props} />
          )}
        </section>

        {decisionsOpen ? (
          <div className={cn("mt-6", layout.cramped)}>
            <Decisions {...props} placement="inline" />
          </div>
        ) : null}

        <section className="mt-6 sm:mt-7" aria-labelledby={`${replyId}-label`}>
          <label id={`${replyId}-label`} htmlFor={replyId} className={sectionHeading}>
            {t("needsYou.screen.replyLabel")}
          </label>
          <div className="mt-2 rounded-xl border border-hairline/60 bg-inset focus-within:border-focus focus-within:ring-1 focus-within:ring-focus">
            <textarea
              id={replyId}
              ref={props.replyRef}
              value={props.draft}
              rows={3}
              disabled={working}
              onChange={(event) => props.onDraft(event.target.value)}
              placeholder={t("needsYou.screen.replyPlaceholder", { name: item.botName })}
              className="block w-full resize-none bg-transparent px-3 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline/40 px-2 py-1.5">
              {pending ? (
                <label className="inline-flex cursor-pointer items-center gap-2 px-1 text-[12px] text-ink-secondary">
                  <input type="checkbox" checked={props.resolveOnSend} onChange={(event) => props.onResolveOnSend(event.target.checked)} className="size-3.5 accent-[var(--color-accent)]" />
                  {t("needsYou.screen.resolveOnSend")}
                </label>
              ) : <span />}
              <button type="button" data-resolver-send="" disabled={working || !props.draft.trim()} onClick={() => props.onReply(item)} className={cn(strongButton, "py-1.5")} title={t("needsYou.screen.sendHint")}>
                {busy === "reply" ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <Send size={14} aria-hidden="true" />}
                {busy === "reply" ? t("needsYou.screen.sending") : t("needsYou.screen.send")}
              </button>
            </div>
          </div>
        </section>
        {/* there is more below the fold: a fade at the scroll's edge, never a line cut at the footer (INSP-J2 #8) */}
        <div aria-hidden="true" data-resolver-fade="" className="pointer-events-none sticky -bottom-6 -mx-4 -mb-6 h-8 bg-gradient-to-t from-panel to-transparent sm:-mx-7" />
      </div>

      <footer className="border-t border-hairline/50 bg-panel px-4 py-2.5 sm:px-5 sm:py-3">
        <Notice {...props} />
        {props.error && (
          <div role="alert" className="mb-2.5 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[12.5px] text-danger">
            <CircleAlert size={14} aria-hidden="true" className="mt-px shrink-0" />
            {/* a server diagnosis comes in lines (the app's flip, INSP-S r2 S2-1) */}
            <span className="min-w-0 flex-1 whitespace-pre-line">{props.error}</span>
            <button type="button" onClick={props.onDismissError} className="shrink-0 rounded px-1 text-[12px] underline-offset-2 hover:underline">{t("needsYou.screen.dismiss")}</button>
          </div>
        )}
        {decisionsOpen ? (
          // compact: at most ~40% of the window, scrolling inside (INSP-J2 #8); the
          // padding keeps the rings (chosen, focus: 2 px + 2 px offset) inside the clip (r2 N1)
          <div className={cn("-mx-1 -mt-1 mb-2 max-h-[40vh] overflow-y-auto p-1", layout.roomy)}>
            <Decisions {...props} placement="footer" />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {awaiting && item.options?.length && !decisionsOpen ? (
            // answered: the decisions fold away; changing the answer is one click (INSP-J2 #2)
            <button type="button" data-resolver-change-answer="" onClick={() => props.onChangeAnswer(item)} className={cn(quietButton, "mr-auto")}>
              <ListChecks size={14} aria-hidden="true" />
              {t("needsYou.screen.changeAnswer")}
            </button>
          ) : null}
          {awaiting && decisionsOpen && props.switching?.key !== needsYouKey(item) ? (
            // hidden while the switch question is open: one "Manter" on screen at a time (INSP-J2 r3 R4)
            // opened to change it: folding back is one click too (Escape does the same)
            <button type="button" data-resolver-keep-answer="" onClick={() => props.onChangeAnswer(item)} className={cn(quietButton, "mr-auto")}>
              <X size={14} aria-hidden="true" />
              {t("needsYou.screen.keepAnswer")}
            </button>
          ) : null}
          {decisionsOpen ? (
            // short or narrow window: the decisions are in the item, after the steps — one tap away
            <button
              type="button"
              data-resolver-jump=""
              onClick={jumpToDecisions}
              className={cn(strongButton, "mr-auto py-1.5", layout.cramped)}
            >
              <ListChecks size={14} aria-hidden="true" />
              {t("needsYou.screen.jumpToDecisions", { count: item.options?.length ?? 0 })}
            </button>
          ) : null}
          {/* the stuck banner carries "Abrir conversa" as the way in: one on screen (INSP-J2 r5 B2) */}
          {!stuck && <button type="button" data-resolver-conversation="" onClick={() => props.onOpenConversation(item)} className={quietButton}>
            <MessageSquare size={14} aria-hidden="true" />
            {t("needsYou.screen.openConversation")}
          </button>}
          {pending && (
            <button type="button" data-resolver-resolve="" disabled={working} onClick={() => props.onResolve(item)} className={cn(item.options?.length || !steps.length ? quietButton : strongButton)}>
              {busy === "resolve" ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <Check size={14} aria-hidden="true" />}
              {t("needsYou.screen.markResolved")}
            </button>
          )}
        </div>
      </footer>
    </>
  );
}

/** What the screen says after a decision (INSP-J2 r2 N4): a server item the
 * choice closed is resolved — never "aguardando" a bot that waits on nothing. */
export function decisionNotice(item: Pick<NeedsYouItem, "options" | "botName" | "title">, option: number, result: unknown): string {
  const values = { label: item.options?.[option]?.label ?? "", name: item.botName, title: item.title };
  const resolved = Number((result as { resolved?: unknown } | undefined)?.resolved ?? 0) > 0;
  return t(resolved ? "needsYou.screen.decided" : "needsYou.screen.decidedWaiting", values);
}

/** What the screen says after "Lembrar": sent, already on its way, or — in
 * the neutral notice, never the red alert — why there was nothing to remind (INSP-J2 r5 B4). */
export function remindNotice(item: Pick<NeedsYouItem, "botName" | "title">, result: unknown): string {
  const { deduped, info } = (result ?? {}) as { deduped?: boolean; info?: string };
  if (info) return info;
  return t(deduped ? "needsYou.screen.remindDeduped" : "needsYou.screen.reminded", { name: item.botName, title: item.title });
}

/** What Escape undoes, innermost first (INSP-J2 #10): a switch being
 * confirmed, then a "Mudar resposta" left open, then (narrow window) the item
 * back to the list — and only then the screen closes. */
export function resolverEscape(state: { switching: boolean; changingAnswer: boolean; narrowDetail: boolean }): "cancelSwitch" | "foldAnswer" | "list" | "close" {
  if (state.switching) return "cancelSwitch";
  if (state.changingAnswer) return "foldAnswer";
  return state.narrowDetail ? "list" : "close";
}

/** The "aguardando" line, with what the person actually did last (INSP-J2 #9)
 * — what was asked, when it was a request (r2 N8) — and, when it still waits
 * its turn, that it is queued (r2 N9). */
export function awaitingLine(item: Pick<NeedsYouItem, "history" | "awaitingSince" | "botName">, now: number): string {
  const last = item.history?.findLast((each) => each.delivered || each.queued);
  const time = answerTime(last?.at ?? item.awaitingSince!, now);
  const name = item.botName;
  const line = last?.kind === "option" ? t("needsYou.screen.awaitingChose", { label: last.label ?? "", time, name })
    : last?.kind === "ask" ? t(last.label === "recommend" ? "needsYou.screen.awaitingAskedRecommend" : last.label === "remind" ? "needsYou.screen.awaitingReminded" : "needsYou.screen.awaitingAskedSteps", { name, time })
      : t("needsYou.screen.awaitingAnswered", { name, time });
  if (!last?.queued) return line;
  // what is queued, said by its name: never two "respostas" meaning opposite things (INSP-J2 r3 R4)
  return `${line} ${t(last.kind === "option" ? "needsYou.screen.awaitingQueuedChoice" : last.kind === "ask" ? "needsYou.screen.awaitingQueuedRequest" : "needsYou.screen.awaitingQueuedMessage", { name })}`;
}

/** The answer has waited its turn for 2 h: what is queued, for how long, and that the bot is busy elsewhere (INSP-J2 r4 A1). */
export function stuckLine(item: Pick<NeedsYouItem, "history" | "awaitingSince" | "botName">, now: number): string {
  const last = item.history?.findLast((each) => each.delivered || each.queued);
  const values = { age: waitingAge(item.awaitingSince ?? now, now), name: item.botName };
  return t(last?.kind === "option" ? "needsYou.screen.stuckChoice" : last?.kind === "ask" ? "needsYou.screen.stuckRequest" : "needsYou.screen.stuckMessage", values);
}

/** The person's last answer never reached the bot: said, with why — the item is theirs again (INSP-J2 r3 R2). */
export function notDeliveredLine(item: Pick<NeedsYouItem, "history" | "awaitingSince" | "botName">, now: number): string | null {
  const failed = answerNotDelivered(item);
  if (!failed) return null;
  const values = { label: failed.label ?? "", time: answerTime(failed.at, now), name: item.botName, error: failed.error ?? "" };
  return t(failed.kind === "option" ? "needsYou.screen.notDeliveredChoice" : failed.kind === "ask" ? "needsYou.screen.notDeliveredRequest" : "needsYou.screen.notDeliveredMessage", values);
}

/** What the person answered, oldest first, and whether it reached the bot (J18). */
function History({ item, now }: { item: NeedsYouItem; now: number }) {
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
const DECISION_BASE = "group/decision relative flex min-w-0 cursor-pointer items-start gap-2.5 rounded-xl border-2 px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow,transform] focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50";
const DECISION_LOOK: Record<DecisionLook, { button: string; label: string; sends: string; icon: string }> = {
  primary: { button: "border-accent bg-accent text-accent-ink shadow-sm hover:brightness-110 hover:shadow-md", label: "text-accent-ink", sends: "text-accent-ink", icon: "text-accent-ink" },
  secondary: { button: "border-accent bg-accent/8 hover:bg-accent/14 hover:shadow-sm", label: "text-accent-text", sends: "text-ink-secondary", icon: "text-accent-text" },
  neutral: { button: "border-hairline bg-panel hover:border-ink-secondary hover:bg-raised", label: "text-ink", sends: "text-ink-secondary", icon: "text-ink-secondary" },
};

/** The bot's decisions, each a button saying what it sends; the recommended
 * one first, with its badge and why (J16). In the footer the reply is
 * clipped to two lines (the button's title has it whole); inline it is
 * shown whole. Each keeps its index in the item: the server checks it. */
function Decisions(props: NeedsYouResolverViewProps & { item: NeedsYouItem; placement: "footer" | "inline" }) {
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

function NoSteps(props: NeedsYouResolverViewProps & { item: NeedsYouItem }) {
  const { item, busy, now } = props;
  if (!item.pendingId) {
    return (
      <p className="mt-2 max-w-[68ch] text-[14px] leading-relaxed text-ink">
        {t(item.approval ? "needsYou.steps.approval" : "needsYou.steps.question", { name: item.botName })}
      </p>
    );
  }
  const asked = item.stepsRequestedAt;
  // asked (by the person, or by the server on its own — J17): the bot is
  // writing them; the button comes back only if it has not answered by then
  if (asked && now - asked < STEPS_ASK_AGAIN_AFTER_MS) {
    return (
      <div className="mt-2.5 rounded-xl border border-dashed border-hairline/80 px-4 py-3.5" data-resolver-steps-asking="">
        <p role="status" className="flex items-start gap-2 text-[13.5px] leading-relaxed text-ink">
          <Loader2 size={15} aria-hidden="true" className="mt-0.5 shrink-0 animate-spin text-accent-text motion-reduce:animate-none" />
          <span>{t("needsYou.steps.asking", { name: item.botName })}</span>
        </p>
      </div>
    );
  }
  return (
    <div className="mt-2.5 rounded-xl border border-dashed border-hairline/80 px-4 py-3.5">
      <p className="flex items-start gap-2 text-[13.5px] leading-relaxed text-ink">
        <Sparkles size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text" />
        <span>{asked ? t("needsYou.steps.noAnswer", { name: item.botName, age: waitingAge(asked, now) }) : t("needsYou.steps.none", { name: item.botName })}</span>
      </p>
      <button type="button" data-resolver-ask-steps="" disabled={busy !== null} onClick={() => props.onAskSteps(item)} className={cn(asked ? quietButton : strongButton, "mt-3")}>
        {busy === "steps" ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <ListChecks size={14} aria-hidden="true" />}
        {t(asked ? "needsYou.steps.askAgain" : "needsYou.steps.ask")}
      </button>
    </div>
  );
}

/** How long the screen shows "pedindo o passo a passo…" before offering to ask again. */
export const STEPS_ASK_AGAIN_AFTER_MS = 15 * 60_000;

/** The resolution screen: portalled over the app, focus held inside and
 * given back on close, keys handled, every action awaited with its own
 * loading and error state. */
export function NeedsYouResolver({ open, items, initialKey, now: fixedNow, onClose, onOpenConversation, onOpenLink, onCopy, onDecide, onReply, onAskSteps, onAskRecommend, onRemind, onResolve }: {
  open: boolean;
  items: NeedsYouItem[];
  initialKey?: string | null;
  now?: number;
  onClose: () => void;
  onOpenConversation: (item: NeedsYouItem) => void;
  onOpenLink: (url: string) => void;
  onCopy: (text: string) => Promise<void> | void;
  onDecide: (item: NeedsYouItem, option: number) => Promise<unknown>;
  onReply: (item: NeedsYouItem, text: string, resolve: boolean) => Promise<unknown>;
  onAskSteps: (item: NeedsYouItem) => Promise<unknown>;
  /** Asks the bot which decision it recommends (an item with 2+ decisions and none marked). */
  onAskRecommend?: (item: NeedsYouItem) => Promise<unknown>;
  /** Reminds the bot of an answered item it let go silent; `deduped` when one is already on its way. */
  onRemind?: (item: NeedsYouItem) => Promise<{ deduped: boolean; info?: string }>;
  onResolve: (item: NeedsYouItem) => Promise<unknown>;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(initialKey ?? null);
  const [fallbackIndex, setFallbackIndex] = useState(0);
  const [botFilter, setBotFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<NeedsYouSort>("due");
  const [pane, setPane] = useState<"list" | "detail">(initialKey ? "detail" : "list");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [resolveOnSend, setResolveOnSend] = useState(false);
  const [busy, setBusy] = useState<ResolverBusy>(null);
  const [switching, setSwitching] = useState<{ key: string; option: number } | null>(null);
  const [changingAnswer, setChangingAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<"success" | "info">("success");
  const [copied, setCopied] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const dialogRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  /** The arrows moved the selection while focus was in the list: focus follows it. */
  const followFocus = useRef(false);
  const now = fixedNow ?? tick;

  // opening on an item selects it; every open starts clean
  useEffect(() => {
    if (!open) return;
    setSelectedKey(initialKey ?? null);
    setPane(initialKey ? "detail" : "list");
    setError(null);
    setNotice(null);
    setSwitching(null);
    setChangingAnswer(null);
  }, [open, initialKey]);

  // ages stay true while the screen is open
  useEffect(() => {
    if (!open || fixedNow !== undefined) return;
    const timer = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open, fixedNow]);

  // a notice says its piece and goes
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const selection = resolverSelection({ items, botFilter, sort, now, selectedKey, fallbackIndex });
  const current = selection.item;
  const currentKey = current ? needsYouKey(current) : null;
  const draft = currentKey ? drafts[currentKey] ?? "" : "";

  // the focused row follows the selection the arrows moved (INSP-I r1 #11b)
  useEffect(() => {
    if (!followFocus.current || !currentKey) return;
    followFocus.current = false;
    document.getElementById(resolverRowId(currentKey))?.focus();
  }, [currentKey]);

  const select = (key: string) => {
    const position = selection.visible.findIndex((item) => needsYouKey(item) === key);
    setSelectedKey(key);
    setFallbackIndex(Math.max(position, 0));
    setPane("detail");
    setError(null);
    setResolveOnSend(false);
    // a question or an open "Mudar resposta" belongs to the item it was asked on (INSP-J2 #10)
    setSwitching(null);
    setChangingAnswer(null);
  };
  const step = (delta: number) => {
    const next = selection.visible[selection.index + delta];
    if (next) select(needsYouKey(next));
  };

  const run = async (kind: Exclude<ResolverBusy, null>, action: () => Promise<unknown>, done: string | ((result: unknown) => string)) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    setFallbackIndex(selection.index);
    try {
      const result = await action();
      setNotice(typeof done === "function" ? done(result) : done);
      // news, not a result: "ainda está na fila" (INSP-J2 r5 B4)
      setNoticeTone((result as { info?: unknown } | undefined)?.info ? "info" : "success");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("needsYou.screen.failed"));
    } finally {
      setBusy(null);
    }
  };
  const reply = (item: NeedsYouItem) => {
    const key = needsYouKey(item);
    const text = (drafts[key] ?? "").trim();
    if (!text) return;
    const resolve = Boolean(item.pendingId) && resolveOnSend;
    void run("reply", async () => {
      await onReply(item, text, resolve);
      // the draft goes only once the bot has it: a failed send keeps it
      setDrafts((all) => ({ ...all, [key]: "" }));
    }, t(resolve ? "needsYou.screen.sentResolved" : "needsYou.screen.sent", { name: item.botName, title: item.title }));
  };

  // focus: into the screen on open, kept inside while open, back to the opener on close
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // the selected row when the list shows, else the close button (narrow screen, item open)
    const row = dialogRef.current?.querySelector<HTMLElement>("[aria-current='true']");
    (row && row.offsetParent !== null ? row : closeRef.current)?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  const close = () => {
    // a send in flight is seen through: closing now would hide its outcome
    if (!busy) onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const inField = target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT";
    if (event.key === "Tab") {
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]):not([tabindex='-1']), textarea:not([disabled]), select, input:not([disabled])") ?? [])].filter((each) => each.offsetParent !== null);
      if (!controls.length) return;
      const firstControl = controls[0]!;
      const lastControl = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === firstControl) { event.preventDefault(); lastControl.focus(); }
      else if (!event.shiftKey && document.activeElement === lastControl) { event.preventDefault(); firstControl.focus(); }
      return;
    }
    const action = resolverKeyAction({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, inField });
    if (!action) return;
    event.preventDefault();
    if (action === "leaveField") {
      // first Escape leaves the field (the draft stays); the next one closes (INSP-I r1 #11d).
      // Focus lands somewhere it shows: the selected row, else Close (INSP-I r2 #5)
      const row = dialogRef.current?.querySelector<HTMLElement>("[data-resolver-row][aria-current='true']");
      (row && row.offsetParent !== null ? row : closeRef.current)?.focus();
    } else if (action === "close") {
      const undo = resolverEscape({ switching: Boolean(switching), changingAnswer: Boolean(changingAnswer), narrowDetail: pane === "detail" && Boolean(window.matchMedia?.("(max-width: 767px)").matches) });
      if (undo === "cancelSwitch") setSwitching(null);
      else if (undo === "foldAnswer") setChangingAnswer(null);
      else if (undo === "list") setPane("list");
      else close();
    } else if (action === "next" || action === "prev") {
      followFocus.current = Boolean(target.closest?.("[data-resolver-row]"));
      step(action === "next" ? 1 : -1);
    } else if (action === "focusReply") replyRef.current?.focus();
    else if (action === "send" && current) reply(current);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-2 animate-workspace-in sm:p-4"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div ref={dialogRef} onKeyDown={onKeyDown} className="flex w-full justify-center">
        <NeedsYouResolverView
          items={items}
          now={now}
          selectedKey={selectedKey}
          fallbackIndex={fallbackIndex}
          botFilter={botFilter}
          sort={sort}
          pane={pane}
          draft={draft}
          resolveOnSend={resolveOnSend}
          busy={busy}
          error={error}
          notice={notice}
          noticeTone={noticeTone}
          copied={copied}
          replyRef={replyRef}
          closeRef={closeRef}
          onSelect={select}
          onFilter={(botId) => { setBotFilter(botId); setFallbackIndex(0); }}
          onSort={setSort}
          onBack={() => setPane("list")}
          onClose={close}
          onDraft={(text) => currentKey && setDrafts((all) => ({ ...all, [currentKey]: text }))}
          onResolveOnSend={setResolveOnSend}
          onCopy={(text) => {
            void Promise.resolve(onCopy(text)).then(() => {
              setCopied(text);
              setTimeout(() => setCopied((value) => (value === text ? null : value)), 1_800);
            }, () => setError(t("needsYou.screen.copyFailed")));
          }}
          onOpenLink={onOpenLink}
          onDecide={(item, option) => { setSwitching(null); setChangingAnswer(null); void run(`option:${option}`, () => onDecide(item, option), (result) => decisionNotice(item, option, result)); }}
          switching={switching}
          changingAnswer={changingAnswer}
          onChangeAnswer={(item) => { const key = needsYouKey(item); setSwitching(null); setChangingAnswer((open) => (open === key ? null : key)); }}
          onAskSwitch={(item, option) => setSwitching({ key: needsYouKey(item), option })}
          onCancelSwitch={() => setSwitching(null)}
          onReply={reply}
          onAskSteps={(item) => void run("steps", () => onAskSteps(item), t("needsYou.screen.askedSteps", { name: item.botName, title: item.title }))}
          onAskRecommend={(item) => void run("recommend", () => (onAskRecommend ?? (async () => undefined))(item), t("needsYou.screen.askedRecommend", { name: item.botName, title: item.title }))}
          onResolve={(item) => void run("resolve", () => onResolve(item), t("needsYou.screen.resolved", { title: item.title }))}
          onRemind={(item) => void run("remind", () => (onRemind ?? (async () => ({ deduped: false })))(item), (result) => remindNotice(item, result))}
          onOpenConversation={onOpenConversation}
          onDismissError={() => setError(null)}
          onDismissNotice={() => setNotice(null)}
        />
      </div>
    </div>,
    document.body,
  );
}
