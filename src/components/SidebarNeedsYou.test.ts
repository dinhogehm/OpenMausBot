import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Task } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { AWAITING_MAX_MS, awaitingBot, needsYouItems, nextAwaitingChange, startNeedsYouClock, waitingAge } from "@/lib/needs-you";
import { resolverSelection } from "./NeedsYouResolver";
import { SidebarNeedsYou } from "./SidebarNeedsYou";

const now = Date.parse("2026-09-30T21:00:00Z");
const task = (threadId: string, title: string, extra: Partial<Task>): Task => ({ threadId, title, createdAt: now - 86_400_000, ...extra }) as Task;
const bot = (id: string, name: string, tasks: Task[], extra: Partial<Bot> = {}): Bot => ({ id, name, threadId: tasks[0]!.threadId, tasks, ...extra }) as unknown as Bot;

beforeEach(() => setLocale("pt-br"));
afterEach(() => setLocale("en"));

describe("what needs the person, from every bot", () => {
  const bots = [
    bot("chief", "Chief of Staff", [task("c0", "Main", {}), task("c1", "GO para o carrier #9278", { goalNeedsInput: true, goalNeedsInputSince: now - 3 * 3_600_000 })]),
    bot("monitor", "Monitor Chat", [task("m0", "Vigia do chat", { goalNeedsInput: true, goalNeedsInputSince: now - 20 * 60_000 }), task("m1", "Aprovar comando", { activity: "waiting-on-you", updatedAt: now - 5 * 60_000 })]),
    bot("hidden", "Hidden", [task("h0", "x", { goalNeedsInput: true, goalNeedsInputSince: now })], { hidden: true }),
    bot("lead", "Lead", [task("l0", "Rotina", { goalNeedsInput: true, routineRunId: "r" }), task("l1", "Arquivada", { goalNeedsInput: true, archivedAt: now })]),
  ];

  it("lists approvals and questions from all visible bots, oldest first, with how long they waited", () => {
    const items = needsYouItems(bots);
    expect(items.map((item) => item.threadId)).toEqual(["c1", "m0", "m1"]);
    expect(items.find((item) => item.threadId === "m1")?.approval).toBe(true);
    expect(waitingAge(now - 20 * 60_000, now)).toBe("20 min");
    expect(waitingAge(now - 3 * 3_600_000, now)).toBe("3 h");
    expect(waitingAge(now - 3 * 86_400_000, now)).toBe("3 d");
    expect(waitingAge(now, now)).toBe("agora");
  });

  it("renders one labelled block with a count, full titles in the label, and nothing when nothing waits", () => {
    const html = renderToStaticMarkup(createElement(SidebarNeedsYou, { items: needsYouItems(bots), density: "comfortable", now, onOpen: () => {} }));
    expect(html).toContain('aria-label="3 itens precisam de você"');
    expect(html).toContain(">Precisa de você<");
    expect(html).toContain('aria-label="Ver como resolver: GO para o carrier #9278 · Chief of Staff · esperando há 3 h"');
    expect(html.match(/data-needs-you-row=/g)).toHaveLength(3);
    expect(renderToStaticMarkup(createElement(SidebarNeedsYou, { items: [], density: "comfortable", now, onOpen: () => {} }))).toBe("");
    expect(renderToStaticMarkup(createElement(SidebarNeedsYou, { items: needsYouItems(bots), density: "icons", now, onOpen: () => {} }))).toBe("");
  });

  it("lists each owner_pending item with its deadline, and offers to mark it done", () => {
    const listed = [bot("chief", "Chief of Staff", [task("c0", "Main", { ownerPending: [{ id: "o1", title: "Aprovar o carrier da #9315", since: now - 2 * 3_600_000, due: "hoje 18h", link: "https://github.com/o/r/pull/9315" }] })])];
    const items = needsYouItems(listed);
    expect(items).toEqual([expect.objectContaining({ threadId: "c0", title: "Aprovar o carrier da #9315", pendingId: "o1", due: "hoje 18h" })]);
    const html = renderToStaticMarkup(createElement(SidebarNeedsYou, { items, density: "comfortable", now, onOpen: () => {}, onResolve: () => {} }));
    expect(html).toContain('aria-label="Ver como resolver: Aprovar o carrier da #9315 · Chief of Staff · esperando há 2 h · até hoje 18h"');
    expect(html).toContain('aria-label="Marcar como resolvido: Aprovar o carrier da #9315"');
  });

  it("gives an owner_pending item with a link a button that opens it, and the whole title on two lines (INSP-D A7)", () => {
    const link = "claude://code/continue?session=local_0a000006-aa11-4b2c-9d3e-0123456789ab";
    const title = 'Renomear no app: "Inbox 503 diagnóstico e recuperação" → "#8891 Inbox 503 diagnóstico e recuperação"';
    const listed = [bot("chief", "Chief of Staff", [task("c0", "Main", { ownerPending: [{ id: "o2", title, since: now - 60_000, link }, { id: "o3", title: "Sem link", since: now }] })])];
    const items = needsYouItems(listed);
    const opened: string[] = [];
    const element = SidebarNeedsYou({ items, density: "comfortable", now, onOpen: () => {}, onResolve: () => {}, onOpenLink: (url) => opened.push(url) });
    const html = renderToStaticMarkup(element!);
    expect(html).toContain(`data-needs-you-link="${link}"`);
    expect(html).toContain(`aria-label="Abrir: ${title.replaceAll('"', "&quot;")}"`);
    expect(html.match(/data-needs-you-link=/g)).toHaveLength(1);
    expect(html).toContain("line-clamp-2");
    // the button calls onOpenLink with the item's link
    const findButton = (node: unknown): { props: { onClick: () => void } } | null => {
      if (!node || typeof node !== "object") return null;
      const el = node as { props?: Record<string, unknown> };
      if (el.props?.["data-needs-you-link"] === link) return el as { props: { onClick: () => void } };
      const children = el.props?.children;
      for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
        const found = findButton(child);
        if (found) return found;
      }
      return null;
    };
    findButton(element)!.props.onClick();
    expect(opened).toEqual([link]);
  });

  it("gives the release-loop item a short title and a button that copies its exact command (INSP-H r1 #8)", () => {
    const command = "echo cb015584a35296ec89b2dbaf2c54373e6f93b826 > ~/.nuria/declined-production-release.sha";
    const title = "Recusar cb015584a (laço, 5×): copie o comando de recusa";
    const listed = [bot("chief", "Chief of Staff", [task("c0", "Main", { ownerPending: [{ id: "o9", title, since: now - 60_000, command }] })])];
    const items = needsYouItems(listed);
    expect(items).toEqual([expect.objectContaining({ pendingId: "o9", command })]);
    const copied: string[] = [];
    const element = SidebarNeedsYou({ items, density: "comfortable", now, onOpen: () => {}, onResolve: () => {}, onCopy: (text) => copied.push(text) });
    const html = renderToStaticMarkup(element!);
    const escaped = command.replaceAll(">", "&gt;");
    expect(html).toContain(`data-needs-you-copy="${escaped}"`);
    expect(html).toContain(`aria-label="Copiar o comando: ${escaped}"`);
    // the title, as shown, ends before the command: it fits the two lines
    expect(html).toContain(`>${title}</span>`);
    const findCopy = (node: unknown): { props: { onClick: () => void } } | null => {
      if (!node || typeof node !== "object") return null;
      const el = node as { props?: Record<string, unknown> };
      if (el.props?.["data-needs-you-copy"] === command) return el as { props: { onClick: () => void } };
      const children = el.props?.children;
      for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
        const found = findCopy(child);
        if (found) return found;
      }
      return null;
    };
    findCopy(element)!.props.onClick();
    expect(copied).toEqual([command]);
  });

  it("orders rows like the resolution screen (overdue first), clamps titles to two real lines, and opens the screen (INSP-I r1 #7/#8/#15)", () => {
    const listed = [bot("chief", "Chief of Staff", [task("c0", "Main", { ownerPending: [
      { id: "o1", title: "Antigo sem prazo", since: now - 9 * 3_600_000 },
      { id: "o2", title: "Vencido ontem", since: now - 60_000, due: "ontem 18h" },
      { id: "o3", title: "Para hoje à noite", since: now - 2 * 60_000, due: "hoje 23h" },
    ] })])];
    const opened: Array<string | null> = [];
    const element = SidebarNeedsYou({ items: needsYouItems(listed), density: "comfortable", now, onOpen: (item) => opened.push(item?.pendingId ?? null) });
    const html = renderToStaticMarkup(element!);
    expect([...html.matchAll(/class="line-clamp-2 break-words leading-snug">([^<]+)</g)].map((match) => match[1])).toEqual(["Vencido ontem", "Para hoje à noite", "Antigo sem prazo"]);
    // "block" would undo the clamp's -webkit-box
    expect(html).not.toMatch(/class="block line-clamp-2/);
    expect(html).toContain(">Resolver os 3<");
    expect(html).toMatch(/text-danger">ontem 18h</);
  });

  // INSP-J2 #2: what the person answered waits on its bot, not on them
  it("leaves out what the person answered while its bot has time, and brings it back after 2 h of silence", () => {
    const listed = [bot("monitor", "Monitor Chat", [task("m0", "Vigia", { ownerPending: [
      { id: "o1", title: "Liberar a planilha", since: now - 5 * 3_600_000, awaitingSince: now - 20 * 60_000 },
      { id: "o2", title: "Confirmar o teto", since: now - 4 * 3_600_000 },
      { id: "o3", title: "Aprovar o envio", since: now - 6 * 3_600_000, awaitingSince: now - 3 * 3_600_000 },
    ] })])];
    const html = renderToStaticMarkup(SidebarNeedsYou({ items: needsYouItems(listed), density: "comfortable", now, onOpen: () => {} })!);
    expect(html).toContain('aria-label="2 itens precisam de você"');
    expect(html).not.toContain("Liberar a planilha");
    expect(html).toContain("Monitor Chat não respondeu");
    // and the one waiting on its bot is a quiet line under the block, not in its count (r2 N2)
    expect(html.match(/data-needs-you-awaiting=""/g)).toHaveLength(1);
    expect(html).toContain(">Aguardando bots (1)<");
    // all answered and still in time: nothing waits on the person — no alert block, but the
    // way in to "Mudar resposta" or "Marcar como resolvido" stays (INSP-J2 r2 N2)
    const answered = [bot("monitor", "Monitor Chat", [task("m0", "Vigia", { ownerPending: [{ id: "o1", title: "Liberar a planilha", since: now - 60_000, awaitingSince: now - 60_000 }] })])];
    const opened: Array<string | null> = [];
    const quiet = SidebarNeedsYou({ items: needsYouItems(answered), density: "comfortable", now, onOpen: (item) => opened.push(item?.pendingId ?? null) })!;
    const quietHtml = renderToStaticMarkup(quiet);
    expect(quietHtml).not.toContain("sidebar-needs-you");
    expect(quietHtml).not.toContain("text-warning");
    expect(quietHtml).toContain('aria-label="Abrir o que aguarda os bots (1)"');
    (quiet.props as { onClick: () => void }).onClick();
    expect(opened).toEqual(["o1"]);
    expect(SidebarNeedsYou({ items: needsYouItems(answered), density: "icons", now, onOpen: () => {} })).toBeNull();
  });

  it("knows when the next answered item goes back to the person, so the sidebar re-renders right then (INSP-J2 r2 N3)", () => {
    const at = now - 30 * 60_000;
    expect(nextAwaitingChange([{ awaitingSince: at }, { awaitingSince: now - 5 * 3_600_000 }, {}], now)).toBe(at + AWAITING_MAX_MS);
    expect(nextAwaitingChange([{ awaitingSince: now - 5 * 3_600_000 }, {}], now)).toBeNull();
  });

  // INSP-J2 r3 R1: the app stays open all day — the sidebar's ages, deadlines and order must move
  it("runs its clock every minute and exactly at an answered item's 2 h, with the resolution screen's order", () => {
    vi.useFakeTimers();
    try {
      const mount = new Date(2026, 9, 2, 17, 30).getTime();
      vi.setSystemTime(mount);
      const listed = [bot("monitor", "Monitor Chat", [task("m0", "Vigia", { ownerPending: [
        // arrives a minute after the sidebar mounted
        { id: "o1", title: "Chegou agora", since: mount + 60_000 },
        { id: "o2", title: "Antigo", since: mount - 26 * 3_600_000 },
        { id: "o3", title: "Para hoje 18h", since: mount - 3_600_000, due: "hoje 18h" },
        { id: "o4", title: "Para hoje 19h", since: mount - 2 * 3_600_000, due: "hoje 19h" },
        // answered 1 h 59 min 30 s ago: back to the person in 30 s
        { id: "o5", title: "Respondido", since: mount - 5 * 3_600_000, awaitingSince: mount - 2 * 3_600_000 + 30_000 },
      ] })])];
      const items = needsYouItems(listed);
      let clock = Date.now();
      const ticks: number[] = [];
      const stop = startNeedsYouClock(() => items, (at) => { clock = at; ticks.push(at); });
      const render = () => renderToStaticMarkup(SidebarNeedsYou({ items, density: "comfortable", now: clock, onOpen: () => {} })!);
      const rows = (html: string) => [...html.matchAll(/class="line-clamp-2 break-words leading-snug">([^<]+)</g)].map((match) => match[1]);
      expect(render()).not.toContain("Respondido");
      // the 2 h run out at mount + 30 s: the tick comes then, not a minute later
      vi.advanceTimersByTime(30_001);
      expect(ticks).toEqual([mount + 30_001]);
      expect(render()).toContain("Respondido");
      // a minute later the new item's age moves off "agora"; after an hour, everything moved
      vi.advanceTimersByTime(60 * 60_000);
      expect(ticks.length).toBeGreaterThanOrEqual(60);
      const html = render();
      expect(html).toContain('aria-label="Ver como resolver: Chegou agora · Monitor Chat · esperando há 59 min"');
      expect(html).toContain("esperando há 27 h");
      // 18:30: "hoje 18h" is overdue now — in red — and "hoje 19h" is not
      expect(html).toMatch(/text-danger">hoje 18h</);
      expect(html).not.toMatch(/text-danger">hoje 19h</);
      // the same order the resolution screen shows at that clock
      const screen = resolverSelection({ items, botFilter: null, sort: "due", now: clock, selectedKey: null, fallbackIndex: 0 }).visible.filter((item) => !awaitingBot(item, clock));
      expect(rows(html)).toEqual(screen.map((item) => item.title).slice(0, 6));
      stop();
      const before = ticks.length;
      vi.advanceTimersByTime(10 * 60_000);
      expect(ticks).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
