// "Esteira" (lot Z): the delivery pipeline as a board — one column per stage,
// one card per piece of work (an issue with its sessions and PRs), moving
// from Entrada to Produção. Shared by the server, which builds it from the
// productivity collector's cache and the live state, and the screen.
//
// Everything a card says comes from data: its stage, how long it has been
// there (`since`, null when unknown — shown "—", never zero), its state and
// the reason it does not move. Whether it is past its stage's limit is the
// screen's arithmetic (now − since > limitMs), so the board itself does not
// change by the minute and a poll that finds nothing new costs a 304.

export const BOARD_STAGES = ["entry", "session", "pr", "gate", "release", "production"] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

/** running: someone or something is working on it now; queued: waiting its
 * turn (a release, the Mac, the machine); blocked: it will not move without
 * someone (the reason says what); owner: an item in "Precisa de você" waits
 * on the person; idle: nothing moves it and nothing blocks it; done: in production. */
export type CardState = "running" | "queued" | "blocked" | "owner" | "idle" | "done";

/** Why a card is where it is, from the data. */
export type BoardReasonCode =
  // entry
  | "no-session"
  // session
  | "session-running" | "session-stalled" | "session-failed" | "session-blocked" | "session-idle" | "screen-wait" | "parked-release"
  // pr / gate
  | "draft" | "behind" | "conflict" | "repo-blocked" | "no-gate" | "ci-running" | "ci-queued" | "gate-pending" | "gate-failed" | "receipt-only" | "awaiting-merge"
  // release
  | "release-running" | "release-wait" | "release-failed" | "release-declined";

export interface BoardReason {
  code: BoardReasonCode;
  /** The data behind it, short and already free of client names: a failing
   * step, a session's recorded error or block, a release's short sha. */
  detail?: string;
  /** How many times (failed tries of the same release). */
  count?: number;
}

export type BoardPriority = "p0" | "p1" | "p2" | "p3";
export type BoardOrigin = "client" | "internal";
export type BoardGateStatus = "success" | "pending" | "failure" | "missing" | "unknown";

export interface BoardOwnerItem {
  botId: string;
  threadId: string;
  pendingId: string;
  since: number;
  /** More items cite the same card. */
  more: number;
}

export interface BoardCard {
  /** "issue:9052", "pr:9368" or "session:<id>": stable while the work lives. */
  key: string;
  stage: BoardStage;
  /** Short, without the requester's or the client's name. */
  title: string;
  /** The issue the card is about, and every issue it carries. */
  issue: number | null;
  issues: number[];
  prs: number[];
  priority: BoardPriority | null;
  origin: BoardOrigin;
  /** The Atendimento spreadsheet row its title or its owner item names. */
  sheetRow: number | null;
  /** Who carries it: the session's bot and the session, or the bot whose item waits on the person. */
  bot: { id: string; name: string | null } | null;
  session: { id: string; title: string; status: string } | null;
  /** When it entered this stage; null when no source says (shown "—"). */
  since: number | null;
  /** The stage's limit for this card (by priority); null: no limit (production). */
  limitMs: number | null;
  state: CardState;
  reason: BoardReason | null;
  owner: BoardOwnerItem | null;
  links: {
    issue: string | null;
    pr: string | null;
    /** The session's conversation: the Claude app's own, or the bot's thread for a headless one. */
    session: { kind: "app"; url: string } | { kind: "thread"; botId: string; threadId: string } | null;
  };
  gate: { status: BoardGateStatus; receipt: "head" | "other" | null; at: number | null } | null;
  release: { sha: string; state: "running" | "queued" | "failed" | "released"; at: number | null; inferred?: true } | null;
}

export interface BoardColumn {
  stage: BoardStage;
  /** False when the source this column needs was never read: its count is "—". */
  known: boolean;
  total: number | null;
  cards: BoardCard[];
  /** Cards past the column's cap (Entrada only), counted in `total`. */
  hidden: number;
}

export interface PipelineBoard {
  version: 1;
  enabled: boolean;
  generatedAt: number;
  repo: string;
  columns: BoardColumn[];
  /** The bots that carry at least one card, for the filter. */
  bots: Array<{ id: string; name: string }>;
  sources: {
    /** The productivity collector's last GitHub sync (issues, merged PRs). */
    githubSyncedAt: number | null;
    /** The board's own read of the open and recently merged PRs. */
    livePrsAt: number | null;
    livePrsError: string | null;
    /** How far the release log was read. */
    releaseLogTo: number | null;
    /** A production release on its way on this Mac (lease or intent), as the server reads it. */
    releaseHold: string | null;
  };
}

const HOUR = 3_600_000;

/** How long a card may sit in a stage before it is flagged. Entrada depends
 * on the priority: a P0 waits for a session 2 h, a P1 8 h, the rest 3 days. */
export function stageLimitMs(stage: BoardStage, priority: BoardPriority | null): number | null {
  switch (stage) {
    case "entry": return priority === "p0" ? 2 * HOUR : priority === "p1" ? 8 * HOUR : 72 * HOUR;
    case "session": return priority === "p0" ? 4 * HOUR : 8 * HOUR;
    case "pr": return 4 * HOUR;
    case "gate": return 4 * HOUR;
    case "release": return 6 * HOUR;
    case "production": return null;
  }
}

/** Produção shows what reached production in the last 7 days. */
export const PRODUCTION_WINDOW_MS = 7 * 24 * HOUR;
/** Entrada shows at most this many cards (most urgent first); the rest are counted. */
export const ENTRY_CAP = 40;

/** Past its stage's limit now. Unknown time is never "stale". */
export function isStale(card: Pick<BoardCard, "since" | "limitMs" | "state">, now: number): boolean {
  return card.state !== "done" && card.since !== null && card.limitMs !== null && now - card.since > card.limitMs;
}
