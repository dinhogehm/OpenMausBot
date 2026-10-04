// The "Esteira" screen's reading of the board (lot Z): filters, the summary
// above the columns, each card's words in the reader's language, and the
// poll that sends the last ETag so an unchanged board costs a 304.
import { t } from "@/lib/i18n";
import { formatSpan } from "@/lib/productivity";
import type { LocaleKey } from "@/locales";
import { BOARD_STAGES, isStale, type BoardCard, type BoardReason, type BoardStage, type CardState, type PipelineBoard } from "../../shared/pipeline-board";
import { sessionErrorPt } from "../../shared/session-error-pt";

export { BOARD_STAGES, isStale };
export type { BoardCard, BoardReason, BoardStage, CardState, PipelineBoard };

export const BOARD_PATH = "/api/pipeline-board";

export type PriorityFilter = "all" | "p0" | "p1" | "p0p1";
export type OriginFilter = "all" | "client" | "internal";
/** "all", a bot's id, or "none" (cards no bot carries). */
export type BotFilter = string;
export type FocusFilter = "all" | "owner" | "stale";
export interface BoardFilters { bot: BotFilter; priority: PriorityFilter; origin: OriginFilter; focus: FocusFilter }

export const DEFAULT_FILTERS: BoardFilters = { bot: "all", priority: "all", origin: "all", focus: "all" };
const FILTERS_KEY = "omb-pipeline-filters";

export function loadFilters(): BoardFilters {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return DEFAULT_FILTERS;
    return {
      bot: typeof raw.bot === "string" && raw.bot ? raw.bot : "all",
      priority: ["all", "p0", "p1", "p0p1"].includes(raw.priority) ? raw.priority : "all",
      origin: ["all", "client", "internal"].includes(raw.origin) ? raw.origin : "all",
      focus: ["all", "owner", "stale"].includes(raw.focus) ? raw.focus : "all",
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveFilters(filters: BoardFilters): void {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    /* storage blocked: the choice lasts this visit */
  }
}

export function matchesFilters(card: BoardCard, filters: BoardFilters, now: number): boolean {
  if (filters.bot === "none" ? card.bot !== null : filters.bot !== "all" && card.bot?.id !== filters.bot) return false;
  if (filters.priority === "p0p1" ? card.priority !== "p0" && card.priority !== "p1" : filters.priority !== "all" && card.priority !== filters.priority) return false;
  if (filters.origin !== "all" && card.origin !== filters.origin) return false;
  if (filters.focus === "owner" && card.state !== "owner") return false;
  if (filters.focus === "stale" && !isStale(card, now)) return false;
  return true;
}

/** A column's cards after the filters: what waits on the person first, then what is stuck, then the board's order. */
export function visibleCards(cards: readonly BoardCard[], filters: BoardFilters, now: number, stage: BoardStage): BoardCard[] {
  const shown = cards.filter((card) => matchesFilters(card, filters, now));
  if (stage === "production") return shown;
  const rank = (card: BoardCard) => (card.state === "owner" ? 0 : isStale(card, now) ? 1 : 2);
  return shown.map((card, index) => ({ card, index })).sort((a, b) => rank(a.card) - rank(b.card) || a.index - b.index).map(({ card }) => card);
}

export interface BoardSummary { owner: number; stale: number; blocked: number; production: number | null }

/** The line above the columns, over every card (not the filtered ones). */
export function boardSummary(board: PipelineBoard, now: number): BoardSummary {
  const cards = board.columns.flatMap((column) => column.cards);
  const production = board.columns.find((column) => column.stage === "production");
  return {
    owner: cards.filter((card) => card.state === "owner").length,
    stale: cards.filter((card) => isStale(card, now)).length,
    blocked: cards.filter((card) => card.state === "blocked").length,
    production: production?.known ? production.total : null,
  };
}

/** "3 h", "2 d", or "—" when the data does not say. */
export function stageAge(card: Pick<BoardCard, "since">, now: number): string {
  return card.since === null ? "—" : formatSpan(Math.max(0, now - card.since));
}

export const STATE_KEY: Record<CardState, LocaleKey> = {
  running: "pipeline.state.running",
  queued: "pipeline.state.queued",
  blocked: "pipeline.state.blocked",
  owner: "pipeline.state.owner",
  idle: "pipeline.state.idle",
  done: "pipeline.state.done",
};

const SCREEN_KIND: Record<string, LocaleKey> = {
  create: "pipeline.screen.create",
  send: "pipeline.screen.send",
  rename: "pipeline.screen.rename",
  archive: "pipeline.screen.archive",
};

/** Why the card is where it is, in the reader's language (the session's
 * recorded error read in pt-BR when the screen is in Portuguese). */
export function reasonText(reason: BoardReason | null, lang: "pt-BR" | "en" = "pt-BR"): string | null {
  if (!reason) return null;
  const detail = reason.detail ?? "";
  switch (reason.code) {
    case "session-failed":
      return detail ? t("pipeline.reason.sessionFailedDetail", { detail: lang === "pt-BR" ? sessionErrorPt(detail) : detail }) : t("pipeline.reason.sessionFailed");
    case "session-blocked":
      return t("pipeline.reason.sessionBlocked", { detail: detail || "—" });
    case "screen-wait":
      return t("pipeline.reason.screenWait", { what: t(SCREEN_KIND[detail] ?? "pipeline.screen.create") });
    case "release-running":
      return detail ? t("pipeline.reason.releaseRunning", { sha: detail }) : t("pipeline.reason.releaseRunningUnknown");
    case "release-failed":
      return t("pipeline.reason.releaseFailed", { count: reason.count ?? 1, detail: detail || "—" });
    default:
      return t(`pipeline.reason.${camel(reason.code)}` as LocaleKey);
  }
}

const camel = (code: string) => code.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());

/** The poll: sends the ETag it holds; a 304 means the board did not change. */
export async function fetchBoard(etag: string | null, signal?: AbortSignal): Promise<{ changed: false } | { changed: true; board: PipelineBoard; etag: string | null }> {
  const res = await fetch(BOARD_PATH, { headers: etag ? { "if-none-match": etag } : {}, signal, cache: "no-store" });
  if (res.status === 304) return { changed: false };
  const body = await res.json().catch(() => null) as PipelineBoard | { error?: string } | null;
  if (!res.ok || !body || !("columns" in body)) throw new Error((body && "error" in body && body.error) || `${res.status} ${res.statusText}`);
  return { changed: true, board: body, etag: res.headers.get("etag") };
}

/** Open "Precisa de você" on one item: the sidebar owns that screen and listens for this. */
export const OPEN_NEEDS_YOU_EVENT = "omb:open-needs-you";
export function openNeedsYou(item: { botId: string; threadId: string; pendingId: string }): void {
  window.dispatchEvent(new CustomEvent(OPEN_NEEDS_YOU_EVENT, { detail: { key: `${item.botId}:${item.threadId}:${item.pendingId}` } }));
}
