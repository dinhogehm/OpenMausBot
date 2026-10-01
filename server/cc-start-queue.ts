// Starts of Claude Code sessions that found every slot taken (CC_MAX_RUNNING
// on this computer). They used to be refused, and the Chief had to remember
// to try again; now they wait here, P1/hotfix first, then a client's
// "Reprovado", then in order of arrival, and the server opens the next one
// as soon as a slot frees. Kept on disk so a restart does not lose them.
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";

export interface QueuedStart {
  id: string;
  botId: string;
  threadId: string;
  replyThreadId?: string;
  /** The cc_session_start body as the bot sent it. */
  body: Record<string, unknown>;
  title: string;
  /** 0 = P0/P1/hotfix, 1 = a client's "Reprovado", 2 = the rest. */
  priority: number;
  at: number;
}

export const START_QUEUE_MAX = 30;

/** How urgent a start is, from its title and brief. */
export function startPriority(text: string): number {
  if (/\b(?:P0|P1|hotfix|urgente?|urgent)\b/i.test(text)) return 0;
  if (/\breprovad[oa]s?\b/i.test(text)) return 1;
  return 2;
}

export const priorityLabel = (priority: number): string => (priority === 0 ? "P1" : priority === 1 ? "Reprovado" : "normal");

export class CcStartQueue {
  private items: QueuedStart[] = [];
  private readonly path: string | null;

  // plain field assignment, not a parameter property (node type-stripping)
  constructor(path: string | null) {
    this.path = path;
    if (!path) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { items?: QueuedStart[] };
      this.items = (raw.items ?? []).filter((item) => item && typeof item.id === "string" && typeof item.botId === "string");
    } catch { /* first run */ }
  }

  private save(): void {
    if (this.path) writeFileAtomic(this.path, `${JSON.stringify({ items: this.items }, null, 2)}\n`, { mode: 0o600 });
  }

  /** In the order they will open: priority, then arrival. */
  ordered(): QueuedStart[] {
    return [...this.items].sort((a, b) => a.priority - b.priority || a.at - b.at);
  }

  /** Queue a start; its position (1 = next), or null when the queue is full. */
  add(item: QueuedStart): number | null {
    if (this.items.length >= START_QUEUE_MAX) return null;
    this.items.push(item);
    this.save();
    return this.ordered().findIndex((each) => each.id === item.id) + 1;
  }

  /** Take the next one to open. */
  take(): QueuedStart | null {
    const next = this.ordered()[0];
    if (!next) return null;
    this.items = this.items.filter((item) => item.id !== next.id);
    this.save();
    return next;
  }

  /** Put one back at its place (it could not open after all). */
  restore(item: QueuedStart): void {
    if (this.items.some((each) => each.id === item.id)) return;
    this.items.push(item);
    this.save();
  }

  of(botId: string): QueuedStart[] {
    return this.ordered().filter((item) => item.botId === botId);
  }

  /** Drop a bot's queued start by id. */
  remove(botId: string, id: string): QueuedStart | null {
    const found = this.items.find((item) => item.botId === botId && item.id === id) ?? null;
    if (found) {
      this.items = this.items.filter((item) => item !== found);
      this.save();
    }
    return found;
  }
}
