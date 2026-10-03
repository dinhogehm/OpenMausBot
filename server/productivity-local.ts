// The bots' side of the productivity report (lot V), from this machine only:
// the usage ledger (turns, tokens, cost), the turn digests (how long each turn
// ran) and the "Precisa de você" items (opened, resolved, how fast the owner
// answered). The items' own record keeps only the last 300 settled ones, so
// the report keeps its own log of ids and times — never titles or answers.

export interface NeedsYouRecord {
  id: string;
  botId: string;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: "owner" | "bot" | "server" | "unknown" | null;
  /** The owner's first answer from the screen (J18 history), or null. */
  ownerFirstAnswerAt: number | null;
}

export interface NeedsYouLog { version: 1; startedAt: number | null; items: Record<string, NeedsYouRecord> }

export const emptyNeedsYouLog = (): NeedsYouLog => ({ version: 1, startedAt: null, items: {} });

interface PendingLike {
  id: string;
  botId: string;
  createdAt: number;
  history?: Array<{ at: number; by?: string }>;
}
interface ResolvedLike extends PendingLike { resolvedAt: number; resolvedBy: "owner" | "bot" | "server" }

const keyOf = (item: { botId: string; id: string }) => `${item.botId}:${item.id}`;
const firstOwnerAnswer = (item: PendingLike): number | null => {
  const answers = (item.history ?? []).filter((entry) => entry && entry.by === "owner" && Number.isFinite(entry.at)).map((entry) => entry.at);
  return answers.length ? Math.min(...answers) : null;
};

/** Fold what is open and what was settled now into the log. An item that
 * vanished without a settled record was resolved between two looks: it is
 * closed at the time it was found missing, by "unknown". Returns the new log. */
export function mergeNeedsYou(log: NeedsYouLog, input: { open: readonly PendingLike[]; resolved: readonly ResolvedLike[]; now: number }): NeedsYouLog {
  const items: Record<string, NeedsYouRecord> = { ...log.items };
  const openKeys = new Set<string>();
  for (const item of input.open) {
    if (!item || typeof item.id !== "string" || !Number.isFinite(item.createdAt)) continue;
    const key = keyOf(item);
    openKeys.add(key);
    const known = items[key];
    items[key] = {
      id: item.id, botId: item.botId, createdAt: Math.min(item.createdAt, known?.createdAt ?? Infinity),
      resolvedAt: null, resolvedBy: null,
      ownerFirstAnswerAt: firstOwnerAnswer(item) ?? known?.ownerFirstAnswerAt ?? null,
    };
  }
  for (const item of input.resolved) {
    if (!item || typeof item.id !== "string" || !Number.isFinite(item.resolvedAt)) continue;
    const key = keyOf(item);
    if (openKeys.has(key)) continue;
    const known = items[key];
    items[key] = {
      id: item.id, botId: item.botId, createdAt: Math.min(item.createdAt, known?.createdAt ?? Infinity),
      resolvedAt: item.resolvedAt, resolvedBy: item.resolvedBy,
      ownerFirstAnswerAt: firstOwnerAnswer(item) ?? known?.ownerFirstAnswerAt ?? null,
    };
  }
  for (const [key, record] of Object.entries(items)) {
    if (record.resolvedAt === null && !openKeys.has(key)) items[key] = { ...record, resolvedAt: input.now, resolvedBy: "unknown" };
  }
  return { version: 1, startedAt: log.startedAt ?? input.now, items };
}

/** How long the owner took on an item: to the first answer, or to resolving it himself. */
export function ownerResponseMs(record: NeedsYouRecord): number | null {
  const at = record.ownerFirstAnswerAt ?? (record.resolvedBy === "owner" ? record.resolvedAt : null);
  return at === null ? null : Math.max(0, at - record.createdAt);
}
