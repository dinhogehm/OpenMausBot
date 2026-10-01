// Starts of Claude Code sessions that found every slot taken (CC_MAX_RUNNING
// on this computer). They used to be refused, and the Chief had to remember
// to try again; now they wait here, P1/hotfix first, then a client's
// "Reprovado", then in order of arrival, and the server opens the next one
// as soon as a slot frees. Kept on disk so a restart does not lose them.
//
// The rules (INSP-F F3):
// - while anything waits here, a new start waits too: it never takes the
//   slot a queued P1 was waiting for (startGate); resuming existing work
//   leaves a slot to each queued P1 (slotFreeForWork);
// - a slot is taken by a session at work and by an app session on its way
//   in (a create or a message waiting for the Mac): those never age out of
//   the count, or a locked Mac at night would let the queue open everything
//   (CcSessionLedger.slotsTaken);
// - urgency comes from an explicit priority, else from the title — never
//   from the brief, where "não é hotfix" is common — and a negated word does
//   not count (startPriority);
// - the same start (bot + issue, or bot + title) queued twice keeps its one
//   place; a queued start can be cancelled by its bot; everyone sees the
//   whole queue (the slots are shared), the Chief with each item's bot;
// - nothing is dropped in silence: a broken file is kept aside and logged, a
//   start whose conversation is gone goes to the bot's main one, and one
//   that cannot open for a reason that may pass (the app's last folder)
//   stays in its place and the bot hears why — for up to START_RETRY_MAX_MS,
//   then it leaves the queue and the bot hears that too; while it waits to
//   retry it reserves no slot.
import { readFileSync, renameSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";

export interface QueuedStart {
  id: string;
  botId: string;
  threadId: string;
  replyThreadId?: string;
  /** The cc_session_start body as the bot sent it. */
  body: Record<string, unknown>;
  title: string;
  /** The issue it is about, when it names one: the same issue is one start. */
  issue?: string;
  /** 0 = P0/P1/hotfix, 1 = a client's "Reprovado", 2 = the rest. */
  priority: number;
  at: number;
  /** Tried and could not open for a reason that may pass: not before this. */
  retryAt?: number;
  /** Why it could not open the last time it was tried. */
  lastReason?: string;
  /** The first of the failures in a row (cleared when only a slot is missing). */
  failingSince?: number;
}

export const START_QUEUE_MAX = 30;
/** A start that could not open for a reason that may pass is tried again after this. */
export const START_RETRY_MS = 5 * 60_000;
/** A start still failing to open this long after it was queued leaves the queue (the bot hears it). */
export const START_RETRY_MAX_MS = 24 * 3_600_000;

const URGENT = /(?<![\p{L}\d])(?:P0|P1|hotfix|urgente?|urgent)(?![\p{L}\d])/iu;
const REJECTED = /(?<![\p{L}])reprovad[oa]s?(?![\p{L}])/iu;
/** "não é hotfix", "sem ser P1", "not urgent", "nada urgente": the word is there, the urgency is not. */
const NEGATED = /(?<![\p{L}])(?:n[ãa]o|not|sem|nada|nunca|no)(?:\s+(?:[ée]|ser|is|a|um|uma|o|do|da|de|como|tão|tao|muito|very|so))*\s+(?:P0|P1|hotfix|urgente?|urgent)(?![\p{L}\d])/giu;

/** How urgent a start is: the bot's explicit `priority` when it gave one,
 * else its title. The brief is never read for this. */
export function startPriority(title: string, explicit?: unknown): number {
  if (typeof explicit === "string" && explicit.trim()) {
    const value = explicit.trim();
    if (/^(?:P0|P1|hotfix|urgente?|urgent)$/i.test(value)) return 0;
    if (/^reprovad[oa]$/i.test(value)) return 1;
    if (/^(?:normal|P2|P3)$/i.test(value)) return 2;
  }
  const text = title.replace(NEGATED, " ");
  if (URGENT.test(text)) return 0;
  if (REJECTED.test(text)) return 1;
  return 2;
}

export const priorityLabel = (priority: number): string => (priority === 0 ? "P1" : priority === 1 ? "Reprovado" : "normal");

/** Whether a start may open now: one from the queue takes a free slot; a new
 * one waits while anything is queued (it never jumps a waiting P1) or every
 * slot is taken. */
export function startGate(input: { fromQueue: boolean; queued: number; taken: number; max: number }): "open" | "queue" | "busy" {
  if (input.fromQueue) return input.taken < input.max ? "open" : "busy";
  return input.queued > 0 || input.taken >= input.max ? "queue" : "open";
}

/** Existing work (a resumed session, a message that starts a turn) takes a
 * slot only when one stays free for each P1 waiting in the queue. */
export function slotFreeForWork(input: { taken: number; urgentQueued: number; max: number }): boolean {
  return input.taken + input.urgentQueued < input.max;
}

const sameTitle = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

export class CcStartQueue {
  private items: QueuedStart[] = [];
  private readonly path: string | null;
  /** Where an unreadable queue file was moved aside, to be reported once. */
  corruptPath: string | null = null;

  // plain field assignment, not a parameter property (node type-stripping)
  constructor(path: string | null, now = Date.now()) {
    this.path = path;
    if (!path) return;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") console.error(`[cc-start-queue] could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return; // first run
    }
    try {
      const raw = JSON.parse(text) as { items?: unknown };
      if (!Array.isArray(raw.items)) throw new Error("no items list");
      this.items = raw.items.filter((item): item is QueuedStart => Boolean(item) && typeof (item as QueuedStart).id === "string" && typeof (item as QueuedStart).botId === "string" && typeof (item as QueuedStart).threadId === "string");
      const dropped = raw.items.length - this.items.length;
      if (dropped) console.error(`[cc-start-queue] ${dropped} malformed item(s) in ${path} were left out`);
    } catch (error) {
      // never overwrite it: kept aside for whoever looks, and said so
      const aside = `${path}.corrupt-${now}`;
      try {
        renameSync(path, aside);
        this.corruptPath = aside;
      } catch (renameError) {
        console.error(`[cc-start-queue] could not move ${path} aside: ${renameError instanceof Error ? renameError.message : String(renameError)}`);
      }
      console.error(`[cc-start-queue] ${path} is not valid (${error instanceof Error ? error.message : String(error)}); kept as ${aside}, starting with an empty queue`);
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      writeFileAtomic(this.path, `${JSON.stringify({ items: this.items }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      console.error(`[cc-start-queue] could not save ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** In the order they will open: priority, then arrival. */
  ordered(): QueuedStart[] {
    return [...this.items].sort((a, b) => a.priority - b.priority || a.at - b.at);
  }

  /** P1s that could open now: each keeps a slot from work that is not in
   * the queue. One waiting out a retry (a carrier on battery, the app's last
   * folder) reserves nothing — it could not use the slot anyway. */
  urgentCount(now = Date.now()): number {
    return this.items.filter((item) => item.priority === 0 && (item.retryAt === undefined || item.retryAt <= now)).length;
  }

  /** Take out the starts that have been failing to open for longer than
   * START_RETRY_MAX_MS: they are not tried forever. */
  expire(now = Date.now()): QueuedStart[] {
    // counted from the first failure in a row, not from when it was queued:
    // a P1 that waited 23 h for a slot and then met the battery once stays
    const expired = this.items.filter((item) => item.failingSince !== undefined && now - item.failingSince > START_RETRY_MAX_MS);
    if (!expired.length) return [];
    this.items = this.items.filter((item) => !expired.includes(item));
    this.save();
    return expired;
  }

  /** Queue a start: its place (1 = next) and id. The same start already
   * queued (same bot, and same issue or title) keeps its place — raised to
   * the more urgent priority if this one is. Null when the queue is full. */
  add(item: QueuedStart): { position: number; id: string; duplicate: boolean } | null {
    const same = this.items.find((each) => each.botId === item.botId && ((item.issue && each.issue === item.issue) || sameTitle(each.title, item.title)));
    if (same) {
      if (item.priority < same.priority) {
        same.priority = item.priority;
        this.save();
      }
      return { position: this.position(same.id), id: same.id, duplicate: true };
    }
    if (this.items.length >= START_QUEUE_MAX) return null;
    this.items.push(item);
    this.save();
    return { position: this.position(item.id), id: item.id, duplicate: false };
  }

  position(id: string): number {
    return this.ordered().findIndex((each) => each.id === id) + 1;
  }

  /** Take the next one to open: not one in `skip`, nor one waiting out a retry. */
  take(now = Date.now(), skip: ReadonlySet<string> = new Set()): QueuedStart | null {
    const next = this.ordered().find((item) => !skip.has(item.id) && (item.retryAt === undefined || item.retryAt <= now));
    if (!next) return null;
    this.items = this.items.filter((item) => item.id !== next.id);
    this.save();
    return next;
  }

  /** Put one back at its place (it could not open after all). */
  restore(item: QueuedStart): void {
    this.items = [...this.items.filter((each) => each.id !== item.id), item];
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

/** The queue as cc_session_list shows it. The slots are shared, so every
 * bot sees every item in order; the Chief sees whose each one is and its
 * id, a bot the ids of its own (to cancel them). */
export function queueListing(queue: CcStartQueue, viewer: { id: string; chief: boolean }, botName: (botId: string) => string, max: number): string {
  const items = queue.ordered();
  if (!items.length) return "";
  const when = (at: number) => new Date(at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const lines = items.map((item, i) => {
    const mine = item.botId === viewer.id;
    const who = viewer.chief || !mine ? ` · de ${mine ? "você" : botName(item.botId)}` : "";
    const id = viewer.chief || mine ? ` · id ${item.id}` : "";
    return `${i + 1}. "${item.title}" · prioridade ${priorityLabel(item.priority)} · desde ${when(item.at)}${who}${id}${item.lastReason ? ` · esperando: ${item.lastReason.slice(0, 160)}` : ""}`;
  });
  return `\nFila de sessões (vagas: ${max} rodando no máximo, divididas entre todos os bots), nesta ordem:\n${lines.join("\n")}\nPara tirar um start seu da fila: cc_session_archive com o id dele.`;
}

export interface StartResult {
  status: number;
  body: { message?: unknown; error?: unknown };
  /** Every slot taken after all: back to its place, try on the next pass. */
  busy?: boolean;
  /** Could not open for a reason that may pass: stays queued, tried again later. */
  retry?: boolean;
}

export interface DrainDeps {
  now(): number;
  slotFree(): boolean;
  botExists(botId: string): boolean;
  threadOpen(botId: string, threadId: string): boolean;
  /** The bot's main conversation other than `except`, if any is open. */
  mainThread(botId: string, except: string): string | null;
  start(item: QueuedStart, threadId: string, replyThreadId: string): StartResult;
  chip(threadId: string, text: string, ok: boolean): void;
  report(botId: string, threadId: string, text: string): void;
  log(text: string): void;
}

/** Open queued starts while there are free slots; the bot hears how each went. */
export function drainStartQueue(queue: CcStartQueue, deps: DrainDeps): void {
  for (const gone of queue.expire(deps.now())) {
    const threadId = deps.threadOpen(gone.botId, gone.threadId) ? gone.threadId : deps.mainThread(gone.botId, gone.threadId);
    const hours = Math.round(START_RETRY_MAX_MS / 3_600_000);
    deps.log(`queued start "${gone.title}" (${gone.id}) of ${gone.botId} left the queue after ${hours} h failing to open: ${gone.lastReason}`);
    if (!threadId || !deps.botExists(gone.botId)) continue;
    deps.chip(threadId, `Fila de sessões: "${gone.title}" saiu da fila — não conseguiu abrir em ${hours} h (${(gone.lastReason ?? "").slice(0, 120)})`, false);
    deps.report(gone.botId, threadId, `[Fila de sessões do Claude Code] "${gone.title}" (queue id ${gone.id}) left the queue: it could not open for ${hours} h — last reason: ${gone.lastReason}. It will NOT open by itself. If it still applies, fix the reason (or tell the owner) and start it again with cc_session_start.`);
  }
  const tried = new Set<string>();
  while (deps.slotFree()) {
    const next = queue.take(deps.now(), tried);
    if (!next) return;
    tried.add(next.id);
    if (!deps.botExists(next.botId)) {
      deps.log(`queued start "${next.title}" (${next.id}) dropped: its bot ${next.botId} no longer exists`);
      continue;
    }
    let threadId = next.threadId;
    const moved = !deps.threadOpen(next.botId, threadId);
    if (moved) {
      const main = deps.mainThread(next.botId, threadId);
      if (!main) {
        // nowhere to tell the bot: keep it, and say so in the log
        queue.restore({ ...next, retryAt: deps.now() + START_RETRY_MS, lastReason: "a conversa de origem foi fechada e o bot não tem outra aberta", failingSince: next.failingSince ?? deps.now() });
        deps.log(`queued start "${next.title}" (${next.id}) kept: the conversation that queued it is gone and its bot has no open one`);
        continue;
      }
      threadId = main;
    }
    const reply = next.replyThreadId && deps.threadOpen(next.botId, next.replyThreadId) ? next.replyThreadId : threadId;
    const started = deps.start(next, threadId, reply);
    if (started.busy) {
      // the reason passed and only a slot is missing: no longer failing
      const { lastReason: _reason, retryAt: _retry, failingSince: _since, ...waiting } = next;
      queue.restore(waiting);
      return;
    }
    const said = String(started.body.message ?? started.body.error ?? "");
    const where = moved ? " (a conversa que pediu foi fechada; o aviso veio para cá)" : "";
    if (started.retry) {
      queue.restore({ ...next, retryAt: deps.now() + START_RETRY_MS, lastReason: said.slice(0, 300), failingSince: next.failingSince ?? deps.now() });
      if (next.lastReason !== said.slice(0, 300)) {
        deps.chip(threadId, `Fila de sessões: "${next.title}" ainda não abriu e segue na fila (#${queue.position(next.id)}): ${said.slice(0, 140)}`, false);
        deps.report(next.botId, threadId, `[Fila de sessões do Claude Code] A slot freed for "${next.title}" (queue id ${next.id}), but it could not open yet: ${said} It stays queued in its place and is tried again every ${START_RETRY_MS / 60_000} min; cancel it with cc_session_archive and its id if it no longer applies.${where}`);
      }
      continue;
    }
    deps.chip(threadId, started.status === 200 ? `Fila de sessões: "${next.title}" abriu${where}` : `Fila de sessões: "${next.title}" não abriu${where}`, started.status === 200);
    deps.report(next.botId, threadId, `[Fila de sessões do Claude Code] Uma vaga liberou para "${next.title}": ${started.status === 200 ? said : `não abri — ${said}`}${where}`);
  }
}
