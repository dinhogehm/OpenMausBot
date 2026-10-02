import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock, Copy, ExternalLink, Inbox,
  ListChecks, Loader2, MessageSquare, Send, ShieldQuestion, Sparkles, X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  dueAt, needsYouBots, needsYouKey, needsYouSteps, sortNeedsYou, waitingAge,
  type NeedsYouItem, type NeedsYouSort,
} from "@/lib/needs-you";

/** What a key press does on the resolution screen. Text fields keep their
 * keys (only ⌘/Ctrl+Enter sends); elsewhere ↑/↓ (or k/j) walk the items, r
 * goes to the reply, Escape closes. Decisions have no shortcut on purpose:
 * one stray key must never answer a bot. */
export type ResolverKeyAction = "close" | "prev" | "next" | "send" | "focusReply" | null;
export function resolverKeyAction(event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; inField: boolean }): ResolverKeyAction {
  if (event.key === "Escape") return "close";
  if (event.inField) return event.key === "Enter" && (event.metaKey || event.ctrlKey) ? "send" : null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "ArrowDown" || event.key === "j") return "next";
  if (event.key === "ArrowUp" || event.key === "k") return "prev";
  if (event.key === "r") return "focusReply";
  return null;
}

/** What a link opens, said plainly: "PR #12", "issue #40", "sessão no Claude", or the host. */
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

export type ResolverBusy = null | "reply" | "resolve" | "steps" | `option:${number}`;

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
  notice: string | null;
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
  onResolve: (item: NeedsYouItem) => void;
  onOpenConversation: (item: NeedsYouItem) => void;
  onDismissError: () => void;
}

/** The visible list (filtered by bot, sorted) and the item on screen. */
export function resolverSelection(props: Pick<NeedsYouResolverViewProps, "items" | "botFilter" | "sort" | "now" | "selectedKey" | "fallbackIndex">) {
  const filtered = props.botFilter ? props.items.filter((item) => item.botId === props.botFilter) : props.items;
  const visible = sortNeedsYou(filtered, props.sort, props.now);
  const found = visible.findIndex((item) => needsYouKey(item) === props.selectedKey);
  const index = found >= 0 ? found : Math.min(Math.max(props.fallbackIndex, 0), visible.length - 1);
  return { visible, index, item: visible[index] ?? null };
}

const iconButton = "flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary outline-none hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-35";
const quietButton = "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] text-ink-secondary outline-none hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40";
const strongButton = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:pointer-events-none disabled:opacity-40";

/** The resolution screen itself, without portal, focus or key handling —
 * every value and handler comes in as props, so it renders to static markup
 * in tests and its buttons can be pressed there. */
export function NeedsYouResolverView(props: NeedsYouResolverViewProps) {
  const { items, now, pane } = props;
  const { visible, index, item } = resolverSelection(props);
  const bots = needsYouBots(items);
  const filterName = bots.find((bot) => bot.botId === props.botFilter)?.botName;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="needs-you-resolver-title"
      data-testid="needs-you-resolver"
      tabIndex={-1}
      className="flex h-[min(760px,calc(100dvh-2rem))] w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel text-ink shadow-2xl outline-none"
    >
      <header className="flex items-center gap-2.5 border-b border-hairline/50 px-4 py-3 sm:px-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning/12 text-warning" aria-hidden="true">
          <CircleAlert size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 id="needs-you-resolver-title" className="text-[15px] font-semibold leading-tight">{t("needsYou.title")}</h1>
          <p className="truncate text-[12px] text-ink-secondary">
            {items.length ? t(items.length === 1 ? "needsYou.screen.countOne" : "needsYou.screen.count", { count: items.length }) : t("needsYou.screen.countNone")}
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
              <div role="radiogroup" aria-label={t("needsYou.screen.sortLabel")} className="flex shrink-0 rounded-lg border border-hairline/60 bg-inset p-0.5">
                {(["due", "age"] as const).map((sort) => (
                  <button
                    key={sort}
                    type="button"
                    role="radio"
                    aria-checked={props.sort === sort}
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
                  const Icon = each.approval ? ShieldQuestion : each.options?.length ? ListChecks : each.pendingId ? MessageSquare : CircleAlert;
                  return (
                    <li key={key} className="px-1.5">
                      <button
                        type="button"
                        data-resolver-row={key}
                        aria-current={selected ? "true" : undefined}
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
                        </span>
                        {each.due && (
                          <span className={cn("mt-0.5 max-w-[92px] shrink-0 truncate rounded-full px-1.5 py-px text-[10.5px] font-medium", overdue ? "bg-danger/12 text-danger" : "bg-inset text-ink-secondary")}>
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
            <p className="hidden border-t border-hairline/40 px-3 py-2 text-[11px] text-ink-tertiary md:block">{t("needsYou.screen.keys")}</p>
          </nav>

          {/* the item on screen */}
          <section
            aria-label={item ? item.title : t("needsYou.title")}
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

function ItemDetail(props: NeedsYouResolverViewProps & { item: NeedsYouItem; position: number; total: number; prevKey: string | null; nextKey: string | null }) {
  const { item, now, busy, position, total, prevKey, nextKey } = props;
  const steps = needsYouSteps(item);
  const overdue = isOverdue(item, now);
  const pending = Boolean(item.pendingId);
  const why = item.why ?? (item.approval ? t("needsYou.why.approval", { name: item.botName }) : !pending ? t("needsYou.why.question", { name: item.botName }) : "");
  const working = busy !== null;
  const replyId = `needs-you-reply-${needsYouKey(item).replace(/[^\w-]/g, "-")}`;
  return (
    <>
      <div className="flex items-center gap-1 border-b border-hairline/40 px-2 py-1.5 sm:px-3">
        <button type="button" onClick={props.onBack} className={cn(quietButton, "px-2 md:hidden")}>
          <ArrowLeft size={15} aria-hidden="true" />
          {t("needsYou.screen.back")}
        </button>
        <span className="flex-1" />
        <span className="px-1 text-[12px] tabular-nums text-ink-secondary" aria-live="polite">{t("needsYou.screen.position", { position: position + 1, total })}</span>
        <button type="button" aria-label={t("needsYou.screen.prev")} title={t("needsYou.screen.prev")} data-resolver-prev="" disabled={!prevKey} onClick={() => prevKey && props.onSelect(prevKey)} className={iconButton}>
          <ChevronLeft size={17} aria-hidden="true" />
        </button>
        <button type="button" aria-label={t("needsYou.screen.next")} title={t("needsYou.screen.next")} data-resolver-next="" disabled={!nextKey} onClick={() => nextKey && props.onSelect(nextKey)} className={iconButton}>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-5 sm:px-7">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
          <span><span className="font-medium text-ink">{item.botName}</span> {t("needsYou.screen.askedAgo", { age: waitingAge(item.since, now) })}</span>
          {item.threadTitle && item.threadTitle !== item.title && (
            <>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 max-w-full truncate">{t("needsYou.screen.inThread", { title: item.threadTitle })}</span>
            </>
          )}
        </p>
        <h2 className="mt-2 break-words text-[19px] font-semibold leading-snug text-ink sm:text-[21px]">{item.title}</h2>
        {/* a title that only named who was rewritten from the ask: say what the bot wrote */}
        {pending && item.rawTitle?.trim().startsWith("@") && (
          <p className="mt-1 break-words text-[12px] text-ink-tertiary">{t("needsYou.screen.botWrote", { title: item.rawTitle })}</p>
        )}
        {(item.due || item.link) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {item.due && (
              <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium", overdue ? "bg-danger/12 text-danger" : "bg-inset text-ink-secondary")}>
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

        {why && (
          <section className="mt-6" aria-labelledby="needs-you-why">
            <h3 id="needs-you-why" className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-tertiary">{t("needsYou.screen.why")}</h3>
            <p className="mt-1.5 max-w-[68ch] text-[14px] leading-relaxed text-ink">{why}</p>
          </section>
        )}

        <section className="mt-6" aria-labelledby="needs-you-steps">
          <h3 id="needs-you-steps" className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-tertiary">{t("needsYou.screen.steps")}</h3>
          {steps.length ? (
            <ol className="mt-2.5 flex flex-col gap-3">
              {steps.map((step, n) => (
                <li key={n} className="flex gap-3">
                  <span aria-hidden="true" className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[12px] font-semibold tabular-nums text-accent-text">{n + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] leading-relaxed text-ink"><span className="sr-only">{t("needsYou.screen.stepNumber", { number: n + 1 })} </span>{step.text}</p>
                    {step.command && (
                      <div className="mt-2 flex items-start gap-2 rounded-lg border border-hairline/60 bg-inset py-2 pl-3 pr-1.5">
                        <code className="min-w-0 flex-1 whitespace-pre-wrap py-0.5 [overflow-wrap:anywhere] font-mono text-[12.5px] leading-relaxed text-ink">{step.command}</code>
                        <button
                          type="button"
                          data-resolver-copy={step.command}
                          aria-label={t("needsYou.copy", { command: step.command })}
                          onClick={() => props.onCopy(step.command!)}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary outline-none hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          {props.copied === step.command ? <Check size={13} aria-hidden="true" className="text-success" /> : <Copy size={13} aria-hidden="true" />}
                          {props.copied === step.command ? t("needsYou.screen.copied") : t("needsYou.screen.copy")}
                        </button>
                      </div>
                    )}
                    {step.link && (
                      <button type="button" data-resolver-link={step.link} onClick={() => props.onOpenLink(step.link!)} title={step.link} className="mt-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -ml-1.5 text-[13px] text-accent-text outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus">
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

        <section className="mt-7" aria-labelledby={`${replyId}-label`}>
          <label id={`${replyId}-label`} htmlFor={replyId} className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-tertiary">
            {t("needsYou.screen.replyLabel", { name: item.botName })}
          </label>
          <div className="mt-2 rounded-xl border border-hairline/60 bg-inset focus-within:border-focus focus-within:ring-1 focus-within:ring-focus">
            <textarea
              id={replyId}
              ref={props.replyRef}
              value={props.draft}
              rows={3}
              disabled={working}
              onChange={(event) => props.onDraft(event.target.value)}
              placeholder={t("needsYou.screen.replyPlaceholder")}
              className="block w-full resize-none bg-transparent px-3 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary"
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
      </div>

      <footer className="border-t border-hairline/50 bg-panel px-4 py-3 sm:px-5">
        {props.error && (
          <div role="alert" className="mb-2.5 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[12.5px] text-danger">
            <CircleAlert size={14} aria-hidden="true" className="mt-px shrink-0" />
            <span className="min-w-0 flex-1">{props.error}</span>
            <button type="button" onClick={props.onDismissError} className="shrink-0 rounded px-1 text-[12px] underline-offset-2 hover:underline">{t("needsYou.screen.dismiss")}</button>
          </div>
        )}
        <p aria-live="polite" className={cn("text-[12.5px] text-success", props.notice ? "mb-2.5" : "sr-only")}>{props.notice ?? ""}</p>
        {item.options?.length ? (
          <div role="group" aria-label={t("needsYou.screen.decisions", { name: item.botName })} className="mb-3">
            <p className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-tertiary">{t("needsYou.screen.decide")}</p>
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))] sm:[grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
              {item.options.map((option, n) => (
                <button
                  key={option.label}
                  type="button"
                  data-resolver-option={n}
                  disabled={working}
                  aria-describedby={`needs-you-option-${n}`}
                  title={t("needsYou.screen.sends", { reply: option.reply })}
                  onClick={() => props.onDecide(item, n)}
                  className={cn(
                    "group flex min-w-0 flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50",
                    n === 0 ? "border-accent/50 bg-accent/10 hover:bg-accent/15" : "border-hairline/60 hover:bg-raised",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
                    {busy === `option:${n}` && <Loader2 size={14} aria-hidden="true" className="animate-spin" />}
                    {option.label}
                  </span>
                  <span id={`needs-you-option-${n}`} className="hidden text-[11.5px] leading-snug text-ink-secondary sm:line-clamp-2">{t("needsYou.screen.sends", { reply: option.reply })}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <button type="button" data-resolver-conversation="" onClick={() => props.onOpenConversation(item)} className={quietButton}>
            <MessageSquare size={14} aria-hidden="true" />
            {t("needsYou.screen.openConversation")}
          </button>
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
  return (
    <div className="mt-2.5 rounded-xl border border-dashed border-hairline/80 px-4 py-3.5">
      <p className="flex items-start gap-2 text-[13.5px] leading-relaxed text-ink">
        <Sparkles size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text" />
        <span>{asked ? t("needsYou.steps.asked", { name: item.botName, age: waitingAge(asked, now) }) : t("needsYou.steps.none", { name: item.botName })}</span>
      </p>
      <button type="button" data-resolver-ask-steps="" disabled={busy !== null} onClick={() => props.onAskSteps(item)} className={cn(asked ? quietButton : strongButton, "mt-3")}>
        {busy === "steps" ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <ListChecks size={14} aria-hidden="true" />}
        {t(asked ? "needsYou.steps.askAgain" : "needsYou.steps.ask", { name: item.botName })}
      </button>
    </div>
  );
}

/** The resolution screen: portalled over the app, focus held inside and
 * given back on close, keys handled, every action awaited with its own
 * loading and error state. */
export function NeedsYouResolver({ open, items, initialKey, now: fixedNow, onClose, onOpenConversation, onOpenLink, onCopy, onDecide, onReply, onAskSteps, onResolve }: {
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const dialogRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const now = fixedNow ?? tick;

  // opening on an item selects it; every open starts clean
  useEffect(() => {
    if (!open) return;
    setSelectedKey(initialKey ?? null);
    setPane(initialKey ? "detail" : "list");
    setError(null);
    setNotice(null);
  }, [open, initialKey]);

  // ages stay true while the screen is open
  useEffect(() => {
    if (!open || fixedNow !== undefined) return;
    const timer = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open, fixedNow]);

  const selection = resolverSelection({ items, botFilter, sort, now, selectedKey, fallbackIndex });
  const current = selection.item;
  const currentKey = current ? needsYouKey(current) : null;
  const draft = currentKey ? drafts[currentKey] ?? "" : "";

  const select = (key: string) => {
    const position = selection.visible.findIndex((item) => needsYouKey(item) === key);
    setSelectedKey(key);
    setFallbackIndex(Math.max(position, 0));
    setPane("detail");
    setError(null);
    setNotice(null);
    setResolveOnSend(false);
  };
  const step = (delta: number) => {
    const next = selection.visible[selection.index + delta];
    if (next) select(needsYouKey(next));
  };

  const run = async (kind: Exclude<ResolverBusy, null>, action: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    setFallbackIndex(selection.index);
    try {
      await action();
      setNotice(done);
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
      setDrafts((all) => ({ ...all, [key]: "" }));
    }, t(resolve ? "needsYou.screen.sentResolved" : "needsYou.screen.sent", { name: item.botName }));
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

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const inField = target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT";
    const action = resolverKeyAction({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, inField });
    if (event.key === "Tab") {
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), textarea:not([disabled]), select, input:not([disabled])") ?? [])].filter((each) => each.offsetParent !== null);
      if (!controls.length) return;
      const firstControl = controls[0]!;
      const lastControl = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === firstControl) { event.preventDefault(); lastControl.focus(); }
      else if (!event.shiftKey && document.activeElement === lastControl) { event.preventDefault(); firstControl.focus(); }
      return;
    }
    if (!action) return;
    event.preventDefault();
    if (action === "close") {
      // narrow screen: Escape steps back to the list first
      if (pane === "detail" && window.matchMedia?.("(max-width: 767px)").matches) setPane("list");
      else onClose();
    } else if (action === "next") step(1);
    else if (action === "prev") step(-1);
    else if (action === "focusReply") replyRef.current?.focus();
    else if (action === "send" && current) reply(current);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-2 animate-workspace-in sm:p-4"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
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
          copied={copied}
          replyRef={replyRef}
          closeRef={closeRef}
          onSelect={select}
          onFilter={(botId) => { setBotFilter(botId); setFallbackIndex(0); }}
          onSort={setSort}
          onBack={() => setPane("list")}
          onClose={onClose}
          onDraft={(text) => currentKey && setDrafts((all) => ({ ...all, [currentKey]: text }))}
          onResolveOnSend={setResolveOnSend}
          onCopy={(text) => {
            void Promise.resolve(onCopy(text)).then(() => {
              setCopied(text);
              setTimeout(() => setCopied((value) => (value === text ? null : value)), 1_800);
            }, () => setError(t("needsYou.screen.copyFailed")));
          }}
          onOpenLink={onOpenLink}
          onDecide={(item, option) => void run(`option:${option}`, () => onDecide(item, option), t("needsYou.screen.decided", { label: item.options?.[option]?.label ?? "", name: item.botName }))}
          onReply={reply}
          onAskSteps={(item) => void run("steps", () => onAskSteps(item), t("needsYou.screen.askedSteps", { name: item.botName }))}
          onResolve={(item) => void run("resolve", () => onResolve(item), t("needsYou.screen.resolved"))}
          onOpenConversation={onOpenConversation}
          onDismissError={() => setError(null)}
        />
      </div>
    </div>,
    document.body,
  );
}
