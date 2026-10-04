// "Esteira" (lot Z): where each piece of work stands, from Entrada to
// Produção — the map of the delivery pipeline that otherwise lives only in
// the owner's head. A strip of the six stages on top (the map: counts, what
// is stuck, what waits on the person; on a phone it is the tabs), then one
// column per stage with a card per piece of work: its short title, who
// carries it, how long it has sat in the stage, its state and why, and the
// way to the issue, the PR, the session's conversation and "Precisa de
// você". Filters by bot, priority and client-or-internal. It refreshes by
// itself; what the data does not know is "—", never zero.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle, ArrowUpRight, Bot, CheckCircle2, CircleAlert, CircleDot, Clock, GitMerge, GitPullRequest, Hourglass, Inbox, Loader2, MessageSquare,
  OctagonAlert, PauseCircle, RefreshCw, Rocket, ShieldCheck, SquareTerminal, Workflow, X,
} from "lucide-react";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import {
  BOARD_STAGES, DEFAULT_FILTERS, STATE_KEY, boardSummary, fetchBoard, isStale, loadFilters, openNeedsYou, reasonText, saveFilters, stageAge, visibleCards,
  type BoardCard, type BoardFilters, type BoardStage, type CardState, type PipelineBoard,
} from "@/lib/pipeline-board";
import { formatCount, formatSpan, formatWhen } from "@/lib/productivity";
import type { LocaleKey } from "@/locales";
import { useStore } from "@/state/store";

const POLL_MS = 15_000;
const CLOCK_MS = 30_000;

const STAGE_ICON: Record<BoardStage, typeof Inbox> = {
  entry: Inbox, session: SquareTerminal, pr: GitPullRequest, gate: ShieldCheck, release: GitMerge, production: Rocket,
};

const STATE_ICON: Record<CardState, typeof Inbox> = {
  running: Loader2, queued: Hourglass, blocked: OctagonAlert, owner: CircleAlert, idle: PauseCircle, done: CheckCircle2,
};

/** The icon's colour carries the state; the words stay in ink (contrast holds on every skin). */
const STATE_TONE: Record<CardState, string> = {
  running: "text-accent", queued: "text-ink-secondary", blocked: "text-danger", owner: "text-warning", idle: "text-ink-secondary", done: "text-success",
};

const STATE_EDGE: Record<CardState, string> = {
  running: "border-l-accent", queued: "border-l-hairline", blocked: "border-l-danger", owner: "border-l-warning", idle: "border-l-hairline", done: "border-l-success",
};

/** "34 h" that never breaks between the number and its unit. */
const span = (ms: number) => formatSpan(ms).replace(" ", " ");

const lang = (): "pt-BR" | "en" => (activeLocale().toLowerCase().startsWith("pt") ? "pt-BR" : "en");

function useNarrow(): boolean {
  const query = "(max-width: 767px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const change = () => setNarrow(list.matches);
    change();
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return narrow;
}

// ── a card ─────────────────────────────────────────────────────────────────

export interface CardActions {
  onOpenLink: (url: string) => void;
  onOpenThread: (botId: string, threadId: string) => void;
  onOpenNeedsYou: (owner: NonNullable<BoardCard["owner"]>) => void;
}

const SESSION_STATUS: Record<string, LocaleKey> = {
  running: "pipeline.card.sessionStatus.running",
  stalled: "pipeline.card.sessionStatus.stalled",
  idle: "pipeline.card.sessionStatus.idle",
  failed: "pipeline.card.sessionStatus.failed",
  archived: "pipeline.card.sessionStatus.archived",
};

const GATE_STATUS: Record<string, LocaleKey> = {
  success: "pipeline.card.gateStatus.success",
  pending: "pipeline.card.gateStatus.pending",
  failure: "pipeline.card.gateStatus.failure",
  missing: "pipeline.card.gateStatus.missing",
  unknown: "pipeline.card.gateStatus.unknown",
};

function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-medium leading-4", className ?? "border-hairline/70 text-ink-secondary")}>{children}</span>;
}

export function BoardCardView({ card, now, actions }: { card: BoardCard; now: number; actions: CardActions }) {
  const titleId = useId();
  const stale = isStale(card, now);
  const reason = reasonText(card.reason, lang());
  const StateIcon = STATE_ICON[card.state];
  const age = stageAge(card, now);
  const tone = stale && card.state !== "owner" ? "border-l-danger" : STATE_EDGE[card.state];
  const sessionLink = card.links.session;
  return (
    <article aria-labelledby={titleId} data-card={card.key} data-state={card.state} data-stale={stale ? "" : undefined}
      className={cn(
        "group relative rounded-xl border border-l-[3px] border-hairline/50 bg-card px-3 py-2.5 shadow-sm transition-colors",
        tone,
        card.state === "owner" && "ring-1 ring-warning/55",
        stale && card.state !== "owner" && "ring-1 ring-danger/40",
      )}>
      {/* who it is: priority, issue, origin, spreadsheet row — and how long it has sat here */}
      <div className="flex items-center gap-1.5">
        {card.priority === "p0" || card.priority === "p1"
          ? <Chip className={card.priority === "p0" ? "border-danger/60 text-danger" : "border-warning/60 text-warning"}>{card.priority.toUpperCase()}</Chip>
          : card.priority ? <Chip>{card.priority.toUpperCase()}</Chip> : null}
        {card.issue !== null && card.links.issue && (
          <button type="button" onClick={() => actions.onOpenLink(card.links.issue!)} aria-label={t("pipeline.card.openIssue", { number: card.issue })}
            className="shrink-0 rounded text-[12px] font-semibold tabular-nums text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70">
            #{card.issue}
          </button>
        )}
        <Chip>{t(card.origin === "client" ? "pipeline.card.client" : "pipeline.card.internal")}</Chip>
        {card.sheetRow !== null && <Chip title={t("pipeline.card.rowTitle", { row: card.sheetRow })}>{t("pipeline.card.row", { row: card.sheetRow })}</Chip>}
        <span className={cn("ml-auto flex shrink-0 items-center gap-1 text-[11.5px] tabular-nums", stale ? "font-semibold text-danger" : "text-ink-secondary")}
          title={card.since === null ? t("pipeline.card.ageUnknown") : t("pipeline.card.since", { when: formatWhen(card.since) })}>
          <Clock size={12} aria-hidden />
          <span className="sr-only">{card.since === null ? t("pipeline.card.ageUnknown") : t("pipeline.card.age", { age })}</span>
          <span aria-hidden>{age}</span>
        </span>
      </div>

      <h3 id={titleId} className="mt-1.5 line-clamp-2 text-[13.5px] font-medium leading-snug text-ink" title={card.title}>{card.title}</h3>

      {/* where it stands */}
      <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-ink">
        <StateIcon size={14} aria-hidden className={cn("mt-px shrink-0", STATE_TONE[card.state], card.state === "running" && "motion-safe:animate-spin [animation-duration:2.4s]")} />
        <span className="min-w-0">
          <span className="font-semibold">{t(STATE_KEY[card.state])}</span>
          {reason && <span className="text-ink-secondary"> — {reason}</span>}
        </span>
      </p>
      {stale && card.limitMs !== null && card.since !== null && (
        <p className="mt-1 flex items-center gap-1.5 text-[11.5px] font-medium text-danger">
          <AlertTriangle size={12} aria-hidden className="shrink-0" />
          {t("pipeline.card.stale", { age: span(now - card.since), limit: span(card.limitMs) })}
        </p>
      )}

      {/* the stage's own facts */}
      {card.gate && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[11.5px] text-ink-secondary">
          <Chip><ShieldCheck size={11} aria-hidden className={cn("shrink-0", card.gate.status === "success" ? "text-success" : card.gate.status === "failure" ? "text-danger" : "text-ink-secondary")} />
            {t("pipeline.card.gate", { status: t(GATE_STATUS[card.gate.status] ?? "pipeline.card.gateStatus.unknown") })}</Chip>
          <Chip>{t(card.gate.receipt === "head" ? "pipeline.card.receiptHead" : card.gate.receipt === "other" ? "pipeline.card.receiptOther" : "pipeline.card.receiptNone")}</Chip>
        </p>
      )}
      {card.release && card.stage === "production" && (
        <p className="mt-1.5 text-[11.5px] text-ink-secondary" title={card.release.inferred ? t("pipeline.card.inferred") : undefined}>
          <Rocket size={12} aria-hidden className="mr-1 inline align-[-2px] text-success" />
          {card.release.at !== null ? t("pipeline.card.deliveredAt", { when: formatWhen(card.release.at), sha: card.release.sha }) : t("pipeline.card.release", { sha: card.release.sha })}
          {card.release.inferred && <span className="block pl-[18px]">{t("pipeline.card.inferred")}</span>}
        </p>
      )}

      {/* who carries it */}
      <p className="relative mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-ink-secondary">
        <Bot size={12} aria-hidden className="shrink-0" />
        <span className="sr-only">{t("pipeline.card.carriedBy")}</span>
        <span className="text-ink">{card.bot ? card.bot.name ?? card.bot.id.slice(0, 8) : "—"}</span>
        {card.session && (
          <span className="whitespace-nowrap" title={card.session.title}><span aria-hidden>· </span>{t("pipeline.card.session", { status: t(SESSION_STATUS[card.session.status] ?? "pipeline.card.sessionStatus.idle") })}</span>
        )}
      </p>

      {/* the way to it */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {card.owner && (
          <button type="button" onClick={() => actions.onOpenNeedsYou(card.owner!)} aria-label={t("pipeline.card.needsYouAria")}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-warning/70 bg-card px-2 text-[12px] font-semibold text-warning hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70">
            <CircleAlert size={13} aria-hidden />{t("pipeline.card.needsYou")}{card.owner.more > 0 && <span className="tabular-nums">+{card.owner.more}</span>}
          </button>
        )}
        {card.prs.length > 0 && card.links.pr && (
          <button type="button" onClick={() => actions.onOpenLink(card.links.pr!)} aria-label={t("pipeline.card.openPr", { number: Number(card.links.pr.split("/").at(-1)) })}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-hairline/70 px-2 text-[12px] font-medium text-ink hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70">
            <GitPullRequest size={12} aria-hidden className="text-ink-secondary" />PR #{card.links.pr.split("/").at(-1)}<ArrowUpRight size={11} aria-hidden className="text-ink-secondary" />
          </button>
        )}
        {sessionLink && (
          <button type="button"
            onClick={() => (sessionLink.kind === "app" ? actions.onOpenLink(sessionLink.url) : actions.onOpenThread(sessionLink.botId, sessionLink.threadId))}
            aria-label={t(sessionLink.kind === "app" ? "pipeline.card.conversationApp" : "pipeline.card.conversationThread")}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-hairline/70 px-2 text-[12px] font-medium text-ink hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70">
            <MessageSquare size={12} aria-hidden className="text-ink-secondary" />{t("pipeline.card.conversation")}
          </button>
        )}
        {card.prs.length > 1 && <span className="text-[11px] text-ink-secondary">{t("pipeline.card.prs", { list: card.prs.map((n) => `#${n}`).join(" ") })}</span>}
      </div>
    </article>
  );
}

// ── a column ───────────────────────────────────────────────────────────────

const UNKNOWN_WHY: Partial<Record<BoardStage, LocaleKey>> = { production: "pipeline.column.unknownRelease" };

export function BoardColumnView({ board, stage, cards, now, actions, filtered, labelledBy, id, role }: {
  board: PipelineBoard; stage: BoardStage; cards: BoardCard[]; now: number; actions: CardActions; filtered: boolean;
  labelledBy?: string; id?: string; role?: "tabpanel";
}) {
  const column = board.columns.find((each) => each.stage === stage)!;
  const headingId = useId();
  const Icon = STAGE_ICON[stage];
  const count = !column.known ? "—" : filtered ? t("pipeline.count.filtered", { shown: formatCount(cards.length), total: formatCount(column.total ?? 0) }) : formatCount(column.total ?? 0);
  return (
    <section id={id} role={role} aria-labelledby={labelledBy ?? headingId} tabIndex={role ? 0 : undefined} data-stage={stage}
      className="flex min-h-0 min-w-0 flex-col rounded-2xl border border-hairline/40 bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
      <header className="flex items-start gap-2 px-3 pb-2 pt-3">
        <Icon size={16} aria-hidden className="mt-0.5 shrink-0 text-ink-secondary" />
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="flex items-baseline gap-2 text-[13.5px] font-semibold text-ink">
            {t(`pipeline.stage.${stage}` as LocaleKey)}
            <span className="text-[12px] font-medium tabular-nums text-ink-secondary" aria-label={column.known ? undefined : t("pipeline.count.unknown")}>{count}</span>
          </h2>
          <p className="text-[11.5px] text-ink-secondary">{t(`pipeline.stageHint.${stage}` as LocaleKey)}</p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!column.known ? (
          <p className="m-1 rounded-xl border border-dashed border-hairline/70 px-3 py-4 text-center text-[12px] text-ink-secondary">
            {t("pipeline.column.unknown", { why: t(UNKNOWN_WHY[stage] && board.sources.githubSyncedAt !== null ? UNKNOWN_WHY[stage]! : "pipeline.column.unknownGithub") })}
          </p>
        ) : cards.length === 0 ? (
          <p className="m-1 rounded-xl border border-dashed border-hairline/70 px-3 py-4 text-center text-[12px] text-ink-secondary">
            {t(filtered && (column.total ?? 0) > 0 ? "pipeline.column.emptyFiltered" : "pipeline.column.empty")}
          </p>
        ) : (
          <ol className="space-y-2">
            {cards.map((card) => <li key={card.key}><BoardCardView card={card} now={now} actions={actions} /></li>)}
          </ol>
        )}
        {column.known && column.hidden > 0 && <p className="px-2 pt-2 text-[11.5px] text-ink-secondary">{t("pipeline.column.hidden", { count: formatCount(column.hidden) })}</p>}
        {column.dormant !== null && column.dormant > 0 && <p className="px-2 pt-1.5 text-[11.5px] text-ink-secondary">{t("pipeline.column.dormant", { count: formatCount(column.dormant) })}</p>}
      </div>
    </section>
  );
}

// ── the map: six stages, what is in each, what is stuck, what waits on you ──

export function StageMap({ board, now, filters, current, onPick, tabs, panelId, tabId }: {
  board: PipelineBoard; now: number; filters: BoardFilters; current: BoardStage | null; onPick: (stage: BoardStage) => void;
  /** On a phone the map is the tab list. */
  tabs: boolean; panelId?: (stage: BoardStage) => string; tabId?: (stage: BoardStage) => string;
}) {
  const refs = useRef(new Map<BoardStage, HTMLButtonElement>());
  const onKey = (event: ReactKeyboardEvent, index: number) => {
    if (!tabs) return;
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? BOARD_STAGES.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const stage = BOARD_STAGES[(next + BOARD_STAGES.length) % BOARD_STAGES.length]!;
    onPick(stage);
    refs.current.get(stage)?.focus();
  };
  return (
    <nav aria-label={tabs ? undefined : t("pipeline.map.aria")} className="min-w-0 max-w-full">
      <ol role={tabs ? "tablist" : undefined} aria-label={tabs ? t("pipeline.tabs.aria") : undefined}
        className={cn("flex items-stretch", tabs ? "gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]" : "gap-0")}>
        {BOARD_STAGES.map((stage, index) => {
          const column = board.columns.find((each) => each.stage === stage)!;
          const cards = visibleCards(column.cards, filters, now, stage);
          const owner = cards.filter((card) => card.state === "owner").length;
          const stale = cards.filter((card) => isStale(card, now)).length;
          const Icon = STAGE_ICON[stage];
          const selected = current === stage;
          const filtered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);
          const count = column.known ? formatCount(filtered ? cards.length : column.total ?? 0) : "—";
          return (
            <li key={stage} role={tabs ? "presentation" : undefined} className={cn("flex items-center", tabs ? "shrink-0" : "min-w-0 flex-1")}>
              <button type="button" ref={(node) => { if (node) refs.current.set(stage, node); }}
                role={tabs ? "tab" : undefined} id={tabId?.(stage)} aria-selected={tabs ? selected : undefined} aria-controls={tabs ? panelId?.(stage) : undefined}
                tabIndex={tabs ? (selected ? 0 : -1) : undefined}
                onClick={() => onPick(stage)} onKeyDown={(event) => onKey(event, index)}
                className={cn(
                  // relative: its sr-only words stay inside the scrolling strip, not past the page's edge
                  "group relative flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                  tabs ? "shrink-0" : "w-full",
                  selected ? "border-accent/70 bg-raised" : "border-hairline/50 bg-card hover:bg-raised",
                )}>
                <Icon size={16} aria-hidden className={cn("shrink-0", selected ? "text-accent" : "text-ink-secondary")} />
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-medium text-ink">{t(`pipeline.stage.${stage}` as LocaleKey)}</span>
                  <span className="flex items-center gap-1.5 text-[11.5px] tabular-nums text-ink-secondary">
                    <span className="text-[15px] font-semibold leading-5 text-ink">{count}</span>
                    {owner > 0 && <span className="inline-flex items-center gap-0.5 text-warning" title={t("pipeline.map.owner", { count: owner })}><CircleAlert size={11} aria-hidden /><span className="sr-only">{t("pipeline.map.owner", { count: owner })}</span><span aria-hidden>{owner}</span></span>}
                    {stale > 0 && <span className="inline-flex items-center gap-0.5 text-danger" title={t("pipeline.map.stale", { count: stale })}><AlertTriangle size={11} aria-hidden /><span className="sr-only">{t("pipeline.map.stale", { count: stale })}</span><span aria-hidden>{stale}</span></span>}
                  </span>
                </span>
              </button>
              {!tabs && index < BOARD_STAGES.length - 1 && <span aria-hidden className="mx-1 h-px w-3 shrink-0 bg-hairline lg:w-5" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ── filters and summary ─────────────────────────────────────────────────────

function Segmented<T extends string>({ legend, value, options, onChange }: { legend: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="mb-1 text-[11.5px] font-medium text-ink-secondary">{legend}</legend>
      <div className="flex rounded-lg border border-hairline/60 bg-panel p-0.5">
        {options.map((option) => (
          <label key={option.value} className={cn(
            "cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1 text-[12.5px] transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/70",
            value === option.value ? "bg-raised font-medium text-ink" : "text-ink-secondary hover:text-ink",
          )}>
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className="sr-only" />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function BoardFiltersBar({ board, filters, onChange }: { board: PipelineBoard; filters: BoardFilters; onChange: (filters: BoardFilters) => void }) {
  const botId = useId();
  const active = JSON.stringify({ ...filters, focus: "all" }) !== JSON.stringify({ ...DEFAULT_FILTERS, focus: "all" });
  return (
    <section aria-label={t("pipeline.filter.aria")} className="flex flex-wrap items-end gap-x-4 gap-y-2">
      <div className="flex flex-col gap-1">
        <label htmlFor={botId} className="text-[11.5px] font-medium text-ink-secondary">{t("pipeline.filter.bot")}</label>
        <select id={botId} value={filters.bot} onChange={(event) => onChange({ ...filters, bot: event.target.value })}
          className="h-8 max-w-[14rem] rounded-lg border border-hairline/60 bg-panel px-2 text-[12.5px] text-ink">
          <option value="all">{t("pipeline.filter.botAll")}</option>
          {board.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          <option value="none">{t("pipeline.filter.botNone")}</option>
        </select>
      </div>
      <Segmented legend={t("pipeline.filter.priority")} value={filters.priority} onChange={(priority) => onChange({ ...filters, priority })}
        options={[{ value: "all", label: t("pipeline.filter.priorityAll") }, { value: "p0", label: "P0" }, { value: "p1", label: "P1" }, { value: "p0p1", label: t("pipeline.filter.p0p1") }]} />
      <Segmented legend={t("pipeline.filter.origin")} value={filters.origin} onChange={(origin) => onChange({ ...filters, origin })}
        options={[{ value: "all", label: t("pipeline.filter.originAll") }, { value: "client", label: t("pipeline.filter.client") }, { value: "internal", label: t("pipeline.filter.internal") }]} />
      {active && (
        <button type="button" onClick={() => onChange({ ...DEFAULT_FILTERS, focus: filters.focus })}
          className="flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70">
          <X size={13} aria-hidden />{t("pipeline.filter.clear")}
        </button>
      )}
    </section>
  );
}

export function SummaryBar({ board, now, filters, onFocus }: { board: PipelineBoard; now: number; filters: BoardFilters; onFocus: (focus: BoardFilters["focus"]) => void }) {
  const summary = boardSummary(board, now);
  const toggle = (focus: "owner" | "stale") => onFocus(filters.focus === focus ? "all" : focus);
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={t("pipeline.summary.aria")} role="group">
      <button type="button" aria-pressed={filters.focus === "owner"} onClick={() => toggle("owner")} disabled={summary.owner === 0 && filters.focus !== "owner"}
        className={cn("inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:cursor-default disabled:opacity-60",
          filters.focus === "owner" ? "border-warning bg-raised text-warning" : "border-warning/60 bg-card text-warning hover:bg-raised")}>
        <CircleAlert size={14} aria-hidden />{t("pipeline.summary.owner", { count: formatCount(summary.owner) })}
      </button>
      <button type="button" aria-pressed={filters.focus === "stale"} onClick={() => toggle("stale")} disabled={summary.stale === 0 && filters.focus !== "stale"}
        className={cn("inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:cursor-default disabled:opacity-60",
          filters.focus === "stale" ? "border-danger bg-raised text-danger" : "border-danger/50 bg-card text-danger hover:bg-raised")}>
        <AlertTriangle size={14} aria-hidden />{t("pipeline.summary.stale", { count: formatCount(summary.stale) })}
      </button>
      <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-hairline/60 bg-card px-3 text-[12.5px] text-ink">
        <OctagonAlert size={14} aria-hidden className="text-danger" />{t("pipeline.summary.blocked", { count: formatCount(summary.blocked) })}
      </span>
      <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-hairline/60 bg-card px-3 text-[12.5px] text-ink">
        <Rocket size={14} aria-hidden className="text-success" />
        {summary.production === null ? t("pipeline.summary.productionUnknown") : t("pipeline.summary.production", { count: formatCount(summary.production) })}
      </span>
    </div>
  );
}

function Freshness({ board, busy }: { board: PipelineBoard | null; busy: boolean }) {
  if (busy) return <span role="status" className="flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={13} className="animate-spin" aria-hidden />{t("pipeline.updating")}</span>;
  if (!board) return null;
  const now = Date.now();
  const live = board.sources.livePrsAt;
  const github = board.sources.githubSyncedAt;
  return (
    <span role="status" className="flex min-w-0 flex-col items-end text-right text-[11.5px] leading-tight text-ink-secondary">
      <span>{live === null ? t("pipeline.fresh.liveNever") : t("pipeline.fresh.live", { age: formatSpan(Math.max(0, now - live)) })}{" · "}{github === null ? t("pipeline.fresh.githubNever") : t("pipeline.fresh.github", { age: formatSpan(Math.max(0, now - github)) })}</span>
      {board.sources.livePrsError && <span className="flex max-w-[420px] items-center gap-1 truncate text-ink" title={board.sources.livePrsError}><AlertTriangle size={12} aria-hidden className="shrink-0 text-warning" />{t("pipeline.fresh.liveError", { error: board.sources.livePrsError })}</span>}
    </span>
  );
}

export function ReleaseHoldNote({ hold }: { hold: string | null }) {
  if (!hold) return null;
  const sha = /([0-9a-f]{9,40})/.exec(hold)?.[1]?.slice(0, 9);
  const text = hold === "?" ? t("pipeline.releaseHoldUnknown") : sha ? t("pipeline.releaseHoldSha", { sha }) : t("pipeline.releaseHoldAny");
  return (
    <p className="flex items-center gap-1.5 text-[12px] text-ink">
      <CircleDot size={13} aria-hidden className={cn("shrink-0", hold === "?" ? "text-warning" : "text-accent motion-safe:animate-pulse")} />{text}
    </p>
  );
}

// ── the screen ──────────────────────────────────────────────────────────────

/** The board, filtered: the map, the summary, the filters and the columns (or, on a phone, the tabs). */
export function BoardView({ board, now, filters, onFilters, actions, narrow, tab, onTab }: {
  board: PipelineBoard; now: number; filters: BoardFilters; onFilters: (filters: BoardFilters) => void; actions: CardActions;
  narrow: boolean; tab: BoardStage; onTab: (stage: BoardStage) => void;
}) {
  const base = useId();
  const filtered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);
  const columnsRef = useRef<HTMLDivElement>(null);
  const cardsOf = (stage: BoardStage) => visibleCards(board.columns.find((each) => each.stage === stage)!.cards, filters, now, stage);
  const panelId = (stage: BoardStage) => `${base}-panel-${stage}`;
  const tabId = (stage: BoardStage) => `${base}-tab-${stage}`;
  const pick = (stage: BoardStage) => {
    onTab(stage);
    if (!narrow) columnsRef.current?.querySelector<HTMLElement>(`[data-stage="${stage}"]`)?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <StageMap board={board} now={now} filters={filters} current={narrow ? tab : null} onPick={pick} tabs={narrow} panelId={panelId} tabId={tabId} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <SummaryBar board={board} now={now} filters={filters} onFocus={(focus) => onFilters({ ...filters, focus })} />
        <ReleaseHoldNote hold={board.sources.releaseHold} />
      </div>
      {narrow ? (
        <details className="rounded-xl border border-hairline/50 bg-card px-3 py-2">
          <summary className="cursor-pointer text-[12.5px] font-medium text-ink">{t("pipeline.filter.toggle", { count: [filters.bot !== "all", filters.priority !== "all", filters.origin !== "all"].filter(Boolean).length })}</summary>
          <div className="pt-2"><BoardFiltersBar board={board} filters={filters} onChange={onFilters} /></div>
        </details>
      ) : <BoardFiltersBar board={board} filters={filters} onChange={onFilters} />}
      {narrow ? (
        <BoardColumnView board={board} stage={tab} cards={cardsOf(tab)} now={now} actions={actions} filtered={filtered} role="tabpanel" id={panelId(tab)} labelledBy={tabId(tab)} />
      ) : (
        // the six side by side whenever they fit at a readable width; scrolled sideways (snapping) when not
        <div ref={columnsRef} className="-mx-1 grid min-h-0 flex-1 snap-x auto-cols-[minmax(13.5rem,1fr)] grid-flow-col gap-2.5 overflow-x-auto px-1 pb-2">
          {BOARD_STAGES.map((stage) => (
            <div key={stage} className="flex min-h-0 snap-start flex-col">
              <BoardColumnView board={board} stage={stage} cards={cardsOf(stage)} now={now} actions={actions} filtered={filtered} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-hidden className="flex gap-3 overflow-hidden">
      {BOARD_STAGES.map((stage) => (
        <div key={stage} className="w-[17.5rem] shrink-0 space-y-2 rounded-2xl border border-hairline/40 bg-panel p-3">
          <div className="h-4 w-24 animate-pulse rounded bg-card" />
          {Array.from({ length: 3 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-xl bg-card" />)}
        </div>
      ))}
    </div>
  );
}

export function PipelineBoardPage() {
  const { dispatch } = useStore();
  const actions = useMemo<CardActions>(() => ({
    onOpenLink: (url) => void openExternalLink(url),
    onOpenThread: (botId, threadId) => dispatch({ type: "switchTask", botId, threadId }),
    onOpenNeedsYou: (owner) => openNeedsYou(owner),
  }), [dispatch]);
  return <PipelineBoardScreen actions={actions} />;
}

/** The screen itself: loads the board, polls it with its ETag, keeps the clock and the filters. */
export function PipelineBoardScreen({ actions }: { actions: CardActions }) {
  const [board, setBoard] = useState<PipelineBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<BoardFilters>(loadFilters);
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState<BoardStage>("entry");
  const narrow = useNarrow();
  const etag = useRef<string | null>(null);
  const inflight = useRef(false);

  const load = useCallback(async (manual = false) => {
    if (inflight.current) return;
    inflight.current = true;
    if (manual) setBusy(true);
    try {
      const result = await fetchBoard(manual ? null : etag.current, AbortSignal.timeout(20_000));
      if (result.changed) {
        etag.current = result.etag;
        setBoard(result.board);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inflight.current = false;
      setLoading(false);
      setBusy(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(poll); window.clearInterval(clock); document.removeEventListener("visibilitychange", visible); };
  }, [load]);

  // a phone opens on the first column that has something to say
  const tabChosen = useRef(false);
  useEffect(() => {
    if (!board || tabChosen.current) return;
    tabChosen.current = true;
    const first = BOARD_STAGES.find((stage) => board.columns.find((each) => each.stage === stage)!.cards.some((card) => card.state === "owner" || isStale(card, Date.now())))
      ?? BOARD_STAGES.find((stage) => (board.columns.find((each) => each.stage === stage)!.total ?? 0) > 0);
    if (first) setTab(first);
  }, [board]);

  const change =(next: BoardFilters) => { saveFilters(next); setFilters(next); };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink" aria-labelledby="pipeline-title" aria-busy={loading}>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline/40 px-6 py-4 max-md:pl-12">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <Workflow size={18} className="text-ink-secondary" aria-hidden />
            <h1 id="pipeline-title" className="text-[17px] font-semibold">{t("pipeline.title")}</h1>
          </div>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("pipeline.subtitle", { repo: board?.repo ?? "dinhogehm/nuria-platform" })}</p>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <Freshness board={board} busy={busy} />
          <button type="button" onClick={() => void load(true)} disabled={busy || board?.enabled === false}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-hairline/60 bg-panel px-3 text-[13px] font-medium text-ink hover:bg-control disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70">
            <RefreshCw size={14} className={cn(busy && "animate-spin")} aria-hidden />{t("pipeline.refresh")}
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 sm:px-6 md:overflow-hidden">
        {error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/40 bg-card px-4 py-2.5 text-[13px] text-ink">
            <span className="flex items-center gap-1.5"><AlertTriangle size={15} aria-hidden className="shrink-0 text-danger" />{t("pipeline.error", { error })}</span>
            <button type="button" onClick={() => void load(true)} className="rounded-md px-2 py-1 font-medium hover:bg-raised">{t("pipeline.retry")}</button>
          </div>
        )}
        {loading && !board ? <Skeleton /> : board ? (
          board.enabled === false ? (
            <section className="rounded-xl border border-hairline/40 bg-card p-6 text-center">
              <h2 className="text-[15px] font-semibold text-ink">{t("pipeline.disabled.title")}</h2>
              <p className="mx-auto mt-1 max-w-xl text-[13px] text-ink-secondary">{t("pipeline.disabled.body")}</p>
            </section>
          ) : <BoardView board={board} now={now} filters={filters} onFilters={change} actions={actions} narrow={narrow} tab={tab} onTab={setTab} />
        ) : null}
      </div>
    </main>
  );
}
