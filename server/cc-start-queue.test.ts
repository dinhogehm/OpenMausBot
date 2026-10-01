import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CcSessionLedger } from "./cc-sessions.ts";
import { CcStartQueue, drainStartQueue, priorityLabel, queueListing, slotFreeForWork, START_QUEUE_MAX, START_RETRY_MS, startGate, startPriority, type DrainDeps, type QueuedStart, type StartResult } from "./cc-start-queue.ts";

const item = (id: string, title: string, at: number, botId = "chief", extra: Partial<QueuedStart> = {}): QueuedStart =>
  ({ id, botId, threadId: "t", body: { title }, title, priority: startPriority(title), at, ...extra });

const MAX = 4;

/** A queue, a ledger of sessions, and a fake start that opens a CLI session in the ledger. */
function world() {
  let now = Date.parse("2026-10-01T22:00:00Z");
  const ledger = new CcSessionLedger({ path: null, now: () => now });
  const queue = new CcStartQueue(null);
  const opened: string[] = [];
  const chips: Array<{ threadId: string; text: string; ok: boolean }> = [];
  const reports: Array<{ botId: string; threadId: string; text: string }> = [];
  const logs: string[] = [];
  const open = new Set(["t", "main-chief", "main-lead"]);
  let startResult: (item: QueuedStart) => StartResult | null = () => null;
  const deps: DrainDeps = {
    now: () => now,
    slotFree: () => ledger.slotsTaken() < MAX,
    botExists: (botId) => botId !== "gone",
    threadOpen: (_botId, threadId) => open.has(threadId),
    mainThread: (botId, except) => [`main-${botId}`].find((thread) => thread !== except && open.has(thread)) ?? null,
    start: (queued, threadId) => {
      const scripted = startResult(queued);
      if (scripted) return scripted;
      const session = ledger.create({ id: `s-${queued.id}`, ownerBotId: queued.botId, ownerThreadId: threadId, title: queued.title, repo: "/r", permissionMode: "auto", surface: "cli" });
      ledger.markRunning(session);
      opened.push(queued.id);
      return { status: 200, body: { message: `aberta ${session.id}` } };
    },
    chip: (threadId, text, ok) => { chips.push({ threadId, text, ok }); },
    report: (botId, threadId, text) => { reports.push({ botId, threadId, text }); },
    log: (text) => { logs.push(text); },
  };
  /** Sessions taking `count` slots. */
  const busy = (count: number) => {
    for (let i = 0; i < count; i += 1) ledger.markRunning(ledger.create({ id: `busy-${i}-${ledger.all().length}`, ownerBotId: "lead", ownerThreadId: "x", title: `busy ${i}`, repo: "/r", permissionMode: "auto", surface: "cli" }));
  };
  /** The server's start: the gate first, then the queue or the fake start. */
  const directStart = (queued: QueuedStart): string => {
    const gate = startGate({ fromQueue: false, queued: queue.ordered().length, taken: ledger.slotsTaken(), max: MAX });
    if (gate === "queue") {
      const placed = queue.add(queued)!;
      return `#${placed.position} na fila`;
    }
    deps.start(queued, queued.threadId, queued.threadId);
    return "aberta";
  };
  return { ledger, queue, opened, chips, reports, logs, open, deps, busy, directStart, advance: (ms: number) => { now += ms; }, script: (fn: typeof startResult) => { startResult = fn; }, get now() { return now; } };
}

describe("the priority of a queued start (INSP-F F3-d)", () => {
  it("ranks P1/hotfix first, then a client's Reprovado, then arrival — from the title", () => {
    expect(startPriority("#9331 hotfix 503 no inbox")).toBe(0);
    expect(startPriority("P1: #9326 PREVIOUS_COMMIT vazio")).toBe(0);
    expect(startPriority("#9295 Reprovado pelo cliente")).toBe(1);
    expect(startPriority("#9052 limpeza")).toBe(2);
    expect(priorityLabel(0)).toBe("P1");
  });

  it("never reads the brief, and a negated word does not raise it", () => {
    // the start's brief ("não use os scripts de hotfix") is not passed at all: the title decides
    expect(startPriority("#9052 limpeza")).toBe(2);
    expect(startPriority("#9330 ajuste de texto (não é hotfix)")).toBe(2);
    expect(startPriority("#9330 sem ser P1: renomear coluna")).toBe(2);
    expect(startPriority("#9330 nada urgente")).toBe(2);
    expect(startPriority("#9330 not urgent")).toBe(2);
    expect(startPriority("#9330 não é hotfix, mas o P1 do login depende")).toBe(0);
  });

  it("takes the bot's explicit priority over the title", () => {
    expect(startPriority("#9052 limpeza", "P1")).toBe(0);
    expect(startPriority("#9331 hotfix", "normal")).toBe(2);
    expect(startPriority("#9052 limpeza", "Reprovado")).toBe(1);
    expect(startPriority("#9331 hotfix", "whatever")).toBe(0);
  });
});

describe("the queue of session starts", () => {
  it("opens the most urgent first, keeps order within a priority, and survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-startq-"));
    try {
      const path = join(dir, "cc-start-queue.json");
      const queue = new CcStartQueue(path);
      expect(queue.add(item("a", "#9052 limpeza", 1))?.position).toBe(1);
      expect(queue.add(item("b", "#9295 Reprovado", 2))?.position).toBe(1);
      expect(queue.add(item("c", "#9331 hotfix", 3))?.position).toBe(1);
      expect(queue.add(item("d", "#9060 outra", 4, "lead"))?.position).toBe(4);
      expect(new CcStartQueue(path).ordered().map((each) => each.id)).toEqual(["c", "b", "a", "d"]);
      expect(queue.of("chief").map((each) => each.id)).toEqual(["c", "b", "a"]);
      const next = queue.take()!;
      expect(next.id).toBe("c");
      // it could not open after all: back in its place
      queue.restore(next);
      expect(queue.take()!.id).toBe("c");
      expect(queue.remove("chief", "a")?.id).toBe("a");
      expect(queue.remove("lead", "b")).toBeNull();
      expect(new CcStartQueue(path).ordered().map((each) => each.id)).toEqual(["b", "d"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses once full", () => {
    const queue = new CcStartQueue(null);
    for (let i = 0; i < START_QUEUE_MAX; i += 1) queue.add(item(`x${i}`, `x${i}`, i));
    expect(queue.add(item("over", "over", 99))).toBeNull();
  });

  it("keeps one place for the same start queued twice, by issue or by title (INSP-F F3-g)", () => {
    const queue = new CcStartQueue(null);
    expect(queue.add(item("a", "#9052 limpeza", 1, "chief", { issue: "9052" }))).toEqual({ position: 1, id: "a", duplicate: false });
    expect(queue.add(item("b", "#9060 outra", 2))).toEqual({ position: 2, id: "b", duplicate: false });
    expect(queue.add(item("c", "9052 limpeza de novo", 3, "chief", { issue: "9052" }))).toEqual({ position: 1, id: "a", duplicate: true });
    expect(queue.add(item("d", "  #9060   OUTRA ", 4))).toEqual({ position: 2, id: "b", duplicate: true });
    // another bot's start for the same issue is its own
    expect(queue.add(item("e", "#9052 limpeza", 5, "lead", { issue: "9052" }))?.duplicate).toBe(false);
    // asked again as P1: the one place goes up
    expect(queue.add(item("f", "#9060 outra", 6, "chief", { priority: 0 }))).toEqual({ position: 1, id: "b", duplicate: true });
    expect(queue.ordered().map((each) => each.id)).toEqual(["b", "a", "e"]);
  });

  describe("a broken queue file (INSP-F F3-f)", () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-startq-bad-")); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

    it("is kept aside with a suffix and logged, never overwritten", () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "cc-start-queue.json");
      writeFileSync(path, '{"items": [{"id": "a", "botId": "chief", "thr');
      const queue = new CcStartQueue(path, 1790880000000);
      expect(queue.ordered()).toEqual([]);
      expect(queue.corruptPath).toBe(`${path}.corrupt-1790880000000`);
      expect(readFileSync(`${path}.corrupt-1790880000000`, "utf8")).toBe('{"items": [{"id": "a", "botId": "chief", "thr');
      expect(errors.mock.calls.some(([text]) => String(text).includes("is not valid") && String(text).includes(".corrupt-1790880000000"))).toBe(true);
      // the next save writes a fresh file; the broken one stays
      queue.add(item("b", "#9060 outra", 1));
      expect(readdirSync(dir).sort()).toEqual(["cc-start-queue.json", "cc-start-queue.json.corrupt-1790880000000"]);
      expect(JSON.parse(readFileSync(path, "utf8")).items.map((each: QueuedStart) => each.id)).toEqual(["b"]);
    });

    it("says nothing on a first run (no file)", () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const queue = new CcStartQueue(join(dir, "missing.json"));
      expect(queue.corruptPath).toBeNull();
      expect(errors).not.toHaveBeenCalled();
      expect(existsSync(join(dir, "missing.json"))).toBe(false);
    });
  });
});

describe("opening queued starts", () => {
  it("does not let a new start take the slot a queued P1 waits for (INSP-F F3-a)", () => {
    const w = world();
    w.busy(MAX);
    expect(w.directStart(item("p1", "#9331 hotfix 503", 1))).toBe("#1 na fila");
    // a slot frees between two ticks, and a normal start arrives first
    w.ledger.all()[0]!.status = "idle";
    expect(w.ledger.slotsTaken()).toBe(MAX - 1);
    expect(w.directStart(item("normal", "#9052 limpeza", 2))).toBe("#2 na fila");
    // the tick: the P1 opens, the normal one waits for the next slot
    drainStartQueue(w.queue, w.deps);
    expect(w.opened).toEqual(["p1"]);
    expect(w.queue.ordered().map((each) => each.id)).toEqual(["normal"]);
    // existing work (a resumed session, a send) leaves a slot to each queued P1
    expect(slotFreeForWork({ taken: 3, urgentQueued: 1, max: MAX })).toBe(false);
    expect(slotFreeForWork({ taken: 3, urgentQueued: 0, max: MAX })).toBe(true);
    expect(startGate({ fromQueue: false, queued: 0, taken: 3, max: MAX })).toBe("open");
    expect(startGate({ fromQueue: true, queued: 1, taken: MAX, max: MAX })).toBe("busy");
  });

  it("counts app sessions still waiting for the Mac as taken slots, however old (INSP-F F3-b)", () => {
    const w = world();
    for (const id of ["c1", "c2", "c3", "c4"]) {
      const session = w.ledger.create({ id, ownerBotId: "chief", ownerThreadId: "t", title: `#${id}`, repo: "/r", permissionMode: "auto", surface: "app", desktop: { marker: `OMB${id}`, turnsSeen: 0, pending: { kind: "create", text: "brief", since: w.now, attempts: 0 } } });
      session.status = "running";
      session.lastActivityAt = w.now;
    }
    w.queue.add(item("q", "#9052 limpeza", 1));
    w.advance(2 * 3_600_000); // the Mac stayed locked for 2 h
    expect(w.ledger.runningCount()).toBe(0); // no progress: the old count freed every slot
    expect(w.ledger.slotsTaken()).toBe(4);
    drainStartQueue(w.queue, w.deps);
    expect(w.opened).toEqual([]);
    expect(w.queue.ordered().map((each) => each.id)).toEqual(["q"]);
  });

  it("lets the bot cancel a queued start, and then nothing opens (INSP-F F3-c)", () => {
    const w = world();
    w.queue.add(item("q", "#9052 limpeza", 1));
    expect(w.queue.remove("lead", "q")).toBeNull(); // not another bot's
    expect(w.queue.remove("chief", "q")?.title).toBe("#9052 limpeza");
    drainStartQueue(w.queue, w.deps);
    expect(w.opened).toEqual([]);
  });

  it("shows the whole queue to the Chief, with each item's bot, and the shared order to every bot (INSP-F F3-e)", () => {
    const w = world();
    w.queue.add(item("q1", "#9331 hotfix", Date.parse("2026-10-01T21:00:00Z"), "lead"));
    w.queue.add(item("q2", "#9052 limpeza", Date.parse("2026-10-01T21:05:00Z"), "chief"));
    const names = (botId: string) => ({ lead: "Lead", chief: "Chief" })[botId] ?? botId;
    const chief = queueListing(w.queue, { id: "chief", chief: true }, names, MAX);
    expect(chief).toContain('1. "#9331 hotfix" · prioridade P1 · desde 18:00 · de Lead · id q1');
    expect(chief).toContain('2. "#9052 limpeza" · prioridade normal · desde 18:05 · de você · id q2');
    const qa = queueListing(w.queue, { id: "qa", chief: false }, names, MAX);
    expect(qa).toContain('1. "#9331 hotfix" · prioridade P1 · desde 18:00 · de Lead');
    expect(qa).not.toContain("id q1");
    expect(queueListing(new CcStartQueue(null), { id: "chief", chief: true }, names, MAX)).toBe("");
  });

  it("sends a start whose conversation was closed to the bot's main one, never drops it in silence (INSP-F F3-e)", () => {
    const w = world();
    w.queue.add(item("q", "#9052 limpeza", 1, "chief", { threadId: "closed" }));
    drainStartQueue(w.queue, w.deps);
    expect(w.opened).toEqual(["q"]);
    expect(w.ledger.get("s-q")!.ownerThreadId).toBe("main-chief");
    expect(w.chips).toEqual([{ threadId: "main-chief", text: 'Fila de sessões: "#9052 limpeza" abriu (a conversa que pediu foi fechada; o aviso veio para cá)', ok: true }]);
    expect(w.reports[0]).toMatchObject({ botId: "chief", threadId: "main-chief" });
    // no open conversation at all: kept, and logged
    w.open.delete("main-lead");
    w.queue.add(item("r", "#9060 outra", 2, "lead", { threadId: "closed" }));
    drainStartQueue(w.queue, w.deps);
    expect(w.queue.ordered().map((each) => each.id)).toEqual(["r"]);
    expect(w.logs.at(-1)).toContain('"#9060 outra" (r) kept');
    // its bot was deleted: logged
    w.queue.add(item("g", "#9070 órfão", 3, "gone"));
    w.advance(START_RETRY_MS);
    drainStartQueue(w.queue, w.deps);
    expect(w.logs.some((line) => line.includes('"#9070 órfão" (g) dropped: its bot gone no longer exists'))).toBe(true);
  });

  it("keeps a start that cannot open for a reason that may pass in its place, and tells the bot once (INSP-F F3-g)", () => {
    const w = world();
    w.queue.add(item("app", "#9052 limpeza", 1));
    w.queue.add(item("cli", "#9060 outra", 2));
    w.script((queued) => (queued.id === "app" ? { status: 409, body: { error: "a última pasta usada no app Claude é a worktree de outra sessão" }, retry: true } : null));
    drainStartQueue(w.queue, w.deps);
    // the one behind it is not held back
    expect(w.opened).toEqual(["cli"]);
    expect(w.queue.ordered().map((each) => each.id)).toEqual(["app"]);
    expect(w.chips[0]).toEqual({ threadId: "t", text: 'Fila de sessões: "#9052 limpeza" ainda não abriu e segue na fila (#1): a última pasta usada no app Claude é a worktree de outra sessão', ok: false });
    // not tried again before START_RETRY_MS, and the same reason is not said twice
    drainStartQueue(w.queue, w.deps);
    w.advance(START_RETRY_MS);
    drainStartQueue(w.queue, w.deps);
    expect(w.chips.filter((chip) => chip.text.includes("ainda não abriu"))).toHaveLength(1);
    // the person fixed it: it opens
    w.script(() => null);
    w.advance(START_RETRY_MS);
    drainStartQueue(w.queue, w.deps);
    expect(w.opened).toEqual(["cli", "app"]);
  });
});
