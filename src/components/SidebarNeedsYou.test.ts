import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bot, Task } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { needsYouItems, waitingAge } from "@/lib/needs-you";
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
    const html = renderToStaticMarkup(createElement(SidebarNeedsYou, { items: needsYouItems(bots), density: "comfortable", now, onJump: () => {} }));
    expect(html).toContain('aria-label="3 itens precisam de você"');
    expect(html).toContain(">Precisa de você<");
    expect(html).toContain('aria-label="GO para o carrier #9278 · Chief of Staff · esperando há 3 h"');
    expect(html.match(/data-needs-you-row=/g)).toHaveLength(3);
    expect(renderToStaticMarkup(createElement(SidebarNeedsYou, { items: [], density: "comfortable", now, onJump: () => {} }))).toBe("");
    expect(renderToStaticMarkup(createElement(SidebarNeedsYou, { items: needsYouItems(bots), density: "icons", now, onJump: () => {} }))).toBe("");
  });
});
