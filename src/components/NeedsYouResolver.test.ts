import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Task } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { dueAt, needsYouItems, needsYouKey, needsYouTitle, sortNeedsYou } from "@/lib/needs-you";
import { linkLabel, NeedsYouResolverView, resolverKeyAction, type NeedsYouResolverViewProps } from "./NeedsYouResolver";

// Invented bots and items: no client data.
const now = new Date(2026, 9, 2, 15, 40).getTime();
const task = (threadId: string, title: string, extra: Partial<Task>): Task => ({ threadId, title, createdAt: now - 86_400_000, ...extra }) as Task;
const bot = (id: string, name: string, tasks: Task[]): Bot => ({ id, name, threadId: tasks[0]!.threadId, tasks }) as unknown as Bot;
const options = [{ label: "Aprovar", reply: "Aprovado: pode fazer o merge da #12." }, { label: "Recusar", reply: "Recusado." }];
const bots = [
  bot("chief", "Chief of Staff", [
    task("c1", "Lote de limites", { ownerPending: [
      { id: "o1", title: "#9052 / PR #12: confirmar o padrão 'sem limite' e decidir o teto", since: now - 3 * 3_600_000, due: "hoje 18h", link: "https://github.com/acme/app/pull/12",
        why: "O release depende dela.", steps: [{ text: "Abra a PR", link: "https://github.com/acme/app/pull/12" }, { text: "Rode o gate", command: "pnpm run ci:local" }], options },
      { id: "o2", title: "Recusar o release em laço de 4f2a9c81e", since: now - 5 * 3_600_000, due: "hoje 09h", command: "echo 4f2a9c81e > ~/.app/declined.sha" },
    ] }),
    task("c2", "@Monitor Chat", { goalNeedsInput: true, goalNeedsInputSince: now - 47 * 60_000, goalNeedsInputAsk: "Posso arquivar as 4 conversas antigas?" }),
  ]),
  bot("monitor", "Monitor Chat", [
    task("m1", "Vigia", { ownerPending: [
      { id: "o3", title: "Liberar a escrita na linha 97 da planilha", since: now - 26 * 3_600_000 },
      { id: "o4", title: "@Chief of Staff", since: now - 2 * 3_600_000, stepsRequestedAt: now - 4 * 60_000 },
    ] }),
  ]),
];

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node;
  // expand function components (the view's parts) so their buttons can be pressed
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}

function view(overrides: Partial<NeedsYouResolverViewProps> = {}) {
  const calls: string[] = [];
  const props: NeedsYouResolverViewProps = {
    items: needsYouItems(bots), now, selectedKey: null, fallbackIndex: 0, botFilter: null, sort: "due", pane: "detail",
    draft: "", resolveOnSend: false, busy: null, error: null, notice: null, copied: null,
    onSelect: (key) => calls.push(`select:${key}`), onFilter: (id) => calls.push(`filter:${id}`), onSort: (sort) => calls.push(`sort:${sort}`),
    onBack: () => calls.push("back"), onClose: () => calls.push("close"), onDraft: (text) => calls.push(`draft:${text}`),
    onResolveOnSend: (value) => calls.push(`resolveOnSend:${value}`), onCopy: (text) => calls.push(`copy:${text}`), onOpenLink: (url) => calls.push(`link:${url}`),
    onDecide: (item, n) => calls.push(`decide:${item.pendingId}:${n}`), onReply: (item) => calls.push(`reply:${item.pendingId ?? item.threadId}`),
    onAskSteps: (item) => calls.push(`steps:${item.pendingId}`), onResolve: (item) => calls.push(`resolve:${item.pendingId}`),
    onOpenConversation: (item) => calls.push(`conversation:${item.threadId}`), onDismissError: () => calls.push("dismiss"),
    ...overrides,
  };
  const element = NeedsYouResolverView(props);
  const tree = nodes(element);
  const html = renderToStaticMarkup(element);
  const press = (attribute: string, value?: unknown) => {
    const found = tree.find((node) => attribute in node.props && (value === undefined || node.props[attribute] === value));
    if (!found) throw new Error(`no element with ${attribute}`);
    (found.props.onClick as () => void)();
  };
  return { html, tree, calls, press };
}
const keyOf = (pendingId: string) => needsYouKey(needsYouItems(bots).find((item) => item.pendingId === pendingId)!);

beforeEach(() => setLocale("pt-br"));
afterEach(() => { setLocale("en"); vi.unstubAllGlobals(); });

describe("titles that say what to do (I3)", () => {
  it("never shows a title that is only a mention, and puts the action before the references", () => {
    const names = ["Chief of Staff", "Monitor Chat"];
    expect(needsYouTitle("@Chief of Staff", { botName: "Monitor Chat", botNames: names })).toBe("Responder ao Monitor Chat");
    expect(needsYouTitle("@Chief of Staff", { botName: "Monitor Chat", botNames: names, ask: "Posso arquivar?" })).toBe("Posso arquivar?");
    expect(needsYouTitle("@Monitor Chat confira a fila", { botName: "Chief of Staff", botNames: names })).toBe("Confira a fila");
    expect(needsYouTitle("#9052 / PR #9332: confirmar padrão 'sem limite'", { botName: "x" })).toBe("Confirmar padrão 'sem limite' (#9052 / PR #9332)");
    expect(needsYouTitle("Aprovar o carrier da #9315", { botName: "x" })).toBe("Aprovar o carrier da #9315");
    const items = needsYouItems(bots);
    expect(items.map((item) => item.title)).not.toContain("@Chief of Staff");
    expect(items.find((item) => item.threadId === "c2")?.title).toBe("Posso arquivar as 4 conversas antigas?");
    expect(items.find((item) => item.pendingId === "o4")).toMatchObject({ title: "Responder ao Monitor Chat", rawTitle: "@Chief of Staff" });
  });
});

describe("deadlines and order", () => {
  it("reads deadlines written as text, and sorts by what falls due first, or by waiting", () => {
    expect(dueAt("hoje 18h", now)).toBe(new Date(2026, 9, 2, 18, 0).getTime());
    expect(dueAt("antes de ~19:45 BRT", now)).toBe(new Date(2026, 9, 2, 19, 45).getTime());
    expect(dueAt("amanhã 9h30", now)).toBe(new Date(2026, 9, 3, 9, 30).getTime());
    expect(dueAt("2026-10-05", now)).toBe(new Date(2026, 9, 5, 23, 59).getTime());
    expect(dueAt("05/10", now)).toBe(new Date(2026, 9, 5, 23, 59).getTime());
    expect(dueAt("sexta", now)).toBe(new Date(2026, 9, 2, 23, 59).getTime()); // 02/10/2026 is a Friday
    expect(dueAt("quando der", now)).toBeNull();
    const items = needsYouItems(bots);
    expect(sortNeedsYou(items, "due", now).map((item) => item.pendingId ?? item.threadId)).toEqual(["o2", "o1", "o3", "o4", "c2"]);
    expect(sortNeedsYou(items, "age", now).map((item) => item.pendingId ?? item.threadId)).toEqual(["o3", "o2", "o1", "o4", "c2"]);
  });
});

describe("the resolution screen (I1)", () => {
  it("shows the whole item: full title, who asked and when, why, numbered steps with copy and link, the deadline, and the decisions", () => {
    const { html } = view({ selectedKey: keyOf("o1") });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="needs-you-resolver-title"');
    expect(html).toContain(">Confirmar o padrão &#x27;sem limite&#x27; e decidir o teto (#9052 / PR #12)</h2>");
    expect(html).toContain(">Chief of Staff</span> pediu há 3 h");
    expect(html).toContain("Por que importa");
    expect(html).toContain("O release depende dela.");
    expect(html).toContain("<ol");
    expect(html).toContain('<span class="sr-only">Passo 2: </span>Rode o gate');
    expect(html).toContain('data-resolver-copy="pnpm run ci:local"');
    expect(html).toContain("Abrir a PR #12");
    expect(html).toContain("Prazo: hoje 18h");
    expect(html).toContain('role="group" aria-label="Decisões que o Chief of Staff ofereceu"');
    expect(html).toContain("Envia: “Aprovado: pode fazer o merge da #12.”");
    expect(html).toContain("Abrir conversa");
    expect(html).toContain("Marcar como resolvido");
    expect(html).toContain("Responder ao Chief of Staff");
    expect(html).toContain("2 de 5");
  });

  it("lists every item — nothing hidden below — with a filter by bot and the sort, and marks an overdue deadline", () => {
    const { html, press, calls } = view({ selectedKey: keyOf("o2") });
    expect(html.match(/data-resolver-row=/g)).toHaveLength(5);
    expect(html).not.toContain("mais abaixo");
    expect(html).toContain("Todos os bots (5)");
    expect(html).toContain("Chief of Staff (3)");
    expect(html).toContain('role="radio" aria-checked="true" data-sort="due"');
    expect(html).toContain("Prazo vencido: hoje 09h");
    press("data-sort", "age");
    expect(calls).toEqual(["sort:age"]);
    const filtered = view({ botFilter: "monitor" });
    expect(filtered.html.match(/data-resolver-row=/g)).toHaveLength(2);
  });

  it("copies the step's command, opens links, and sends a decision to the bot (the decision is the bot's reply, not a shortcut)", () => {
    const { press, calls } = view({ selectedKey: keyOf("o1") });
    press("data-resolver-copy", "pnpm run ci:local");
    press("data-resolver-link", "https://github.com/acme/app/pull/12");
    press("data-resolver-option", 1);
    press("data-resolver-conversation");
    press("data-resolver-resolve");
    expect(calls).toEqual(["copy:pnpm run ci:local", "link:https://github.com/acme/app/pull/12", "decide:o1:1", "conversation:c1", "resolve:o1"]);
    expect(view({ selectedKey: keyOf("o1"), copied: "pnpm run ci:local" }).html).toContain("Copiado");
  });

  it("walks to the previous and next item, and a resolved item hands over to the one in its place", () => {
    const { press, calls } = view({ selectedKey: keyOf("o1") });
    press("data-resolver-prev");
    press("data-resolver-next");
    expect(calls).toEqual([`select:${keyOf("o2")}`, `select:${keyOf("o3")}`]);
    // o1 is gone (resolved): the item that took its position shows
    const after = view({ selectedKey: keyOf("o1"), fallbackIndex: 1, items: needsYouItems(bots).filter((item) => item.pendingId !== "o1") });
    expect(after.html).toContain(">Liberar a escrita na linha 97 da planilha</h2>");
    expect(view({ selectedKey: keyOf("o2") }).html).toMatch(/aria-label="Item anterior"[^>]*disabled/);
  });

  it("offers to ask the bot for the steps when an old item has none, and says it was asked", () => {
    const fresh = view({ selectedKey: keyOf("o3") });
    expect(fresh.html).toContain("O Monitor Chat ainda não escreveu como resolver isto.");
    expect(fresh.html).toContain("Pedir passo a passo ao Monitor Chat");
    fresh.press("data-resolver-ask-steps");
    expect(fresh.calls).toEqual(["steps:o3"]);
    const asked = view({ selectedKey: keyOf("o4") });
    expect(asked.html).toContain("Você pediu os passos ao Monitor Chat há 4 min.");
    expect(asked.html).toContain("Pedir de novo");
    expect(asked.html).toContain("O bot escreveu: @Chief of Staff");
  });

  it("answers in free text, and resolving on send is the person's choice", () => {
    const { press, calls, html } = view({ selectedKey: keyOf("o3"), draft: "Já liberei." });
    expect(html).toContain("Marcar como resolvido também");
    press("data-resolver-send");
    expect(calls).toEqual(["reply:o3"]);
    expect(view({ selectedKey: keyOf("o3") }).html).toMatch(/data-resolver-send=""[^>]*disabled/);
    // a question from the conversation: answer it, open it; nothing to "resolve" here
    const question = view({ selectedKey: needsYouKey(needsYouItems(bots).find((item) => item.threadId === "c2")!) });
    expect(question.html).toContain("O Chief of Staff está esperando a sua resposta para continuar.");
    expect(question.html).not.toContain("data-resolver-resolve");
    expect(question.html).not.toContain("O bot escreveu");
  });

  it("shows loading on the action in flight and disables the others; an error is announced and can be dismissed", () => {
    const busy = view({ selectedKey: keyOf("o1"), busy: "option:0" });
    expect(busy.html).toContain("animate-spin");
    expect(busy.html).toMatch(/data-resolver-option="1"[^>]*disabled/);
    expect(busy.html).toMatch(/data-resolver-resolve=""[^>]*disabled/);
    const failed = view({ selectedKey: keyOf("o1"), error: "Este item já foi resolvido." });
    expect(failed.html).toContain('role="alert"');
    expect(failed.html).toContain("Este item já foi resolvido.");
    const done = view({ selectedKey: keyOf("o1"), notice: "“Aprovar” enviado ao Chief of Staff. Item resolvido." });
    expect(done.html).toContain('aria-live="polite" class="text-[12.5px] text-success mb-2.5">“Aprovar” enviado');
  });

  it("says plainly when nothing waits, and when a filter leaves nothing", () => {
    const empty = view({ items: [] });
    expect(empty.html).toContain('data-testid="needs-you-empty"');
    expect(empty.html).toContain("Nada esperando você");
    expect(empty.html).not.toContain("data-resolver-row");
    const gone = view({ botFilter: "ghost" });
    expect(gone.html).toContain("Mostrar todos");
  });

  it("on a narrow window shows the list or the item, with a way back", () => {
    const list = view({ pane: "list" });
    expect(list.html).toMatch(/<nav aria-label="Itens esperando você" class="[^"]* flex"/);
    const detail = view({ pane: "detail", selectedKey: keyOf("o1") });
    expect(detail.html).toMatch(/<nav aria-label="Itens esperando você" class="[^"]* hidden"/);
    const back = detail.tree.find((node) => node.type === "button" && Children.toArray(node.props.children).includes("Itens"));
    (back!.props.onClick as () => void)();
    expect(detail.calls).toEqual(["back"]);
  });
});

describe("keys on the resolution screen", () => {
  it("walks items with arrows (or j/k), goes to the reply with r, closes with Escape, sends with ⌘/Ctrl+Enter — and has no decision shortcut", () => {
    expect(resolverKeyAction({ key: "ArrowDown", inField: false })).toBe("next");
    expect(resolverKeyAction({ key: "k", inField: false })).toBe("prev");
    expect(resolverKeyAction({ key: "r", inField: false })).toBe("focusReply");
    expect(resolverKeyAction({ key: "Escape", inField: true })).toBe("close");
    expect(resolverKeyAction({ key: "Enter", metaKey: true, inField: true })).toBe("send");
    expect(resolverKeyAction({ key: "Enter", inField: true })).toBeNull();
    expect(resolverKeyAction({ key: "ArrowDown", inField: true })).toBeNull();
    expect(resolverKeyAction({ key: "j", metaKey: true, inField: false })).toBeNull();
    for (const key of ["1", "2", "Enter", "a", "y"]) expect(resolverKeyAction({ key, inField: false })).toBeNull();
  });

  it("names links the way the person reads them", () => {
    expect(linkLabel("https://github.com/acme/app/pull/12")).toBe("a PR #12");
    expect(linkLabel("https://github.com/acme/app/issues/40#x")).toBe("a issue #40");
    expect(linkLabel("claude://code/continue?session=local_1")).toBe("a sessão no Claude");
    expect(linkLabel("https://www.docs.example.com/x")).toBe("docs.example.com");
  });
});
