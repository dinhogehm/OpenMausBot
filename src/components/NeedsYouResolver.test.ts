import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Task } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { answerTime, dueAt, needsYouItems, needsYouKey, needsYouTitle, sortNeedsYou } from "@/lib/needs-you";
import { decisionReply } from "@/lib/needs-you-actions";
import { awaitingLine, decisionNotice, linkLabel, NeedsYouResolverView, resolverEscape, resolverKeyAction, type NeedsYouResolverViewProps } from "./NeedsYouResolver";

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
      { id: "o4", title: "@Chief of Staff", since: now - 2 * 3_600_000, stepsRequestedAt: now - 4 * 60_000, why: "Sem isso o relatório semanal sai com os números de agosto." },
      { id: "o5", title: "@Osvaldo aprovar o deploy da versão 2.14 em produção", since: now - 60 * 60_000, due: "ontem 18h" },
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
    onAskSteps: (item) => calls.push(`steps:${item.pendingId}`), onAskRecommend: (item) => calls.push(`recommend:${item.pendingId}`), onResolve: (item) => calls.push(`resolve:${item.pendingId}`),
    onAskSwitch: (item, n) => calls.push(`switch:${item.pendingId}:${n}`), onCancelSwitch: () => calls.push("cancelSwitch"),
    onChangeAnswer: (item) => calls.push(`changeAnswer:${item.pendingId}`), onRemind: (item) => calls.push(`remind:${item.pendingId}`),
    onOpenConversation: (item) => calls.push(`conversation:${item.threadId}`), onDismissError: () => calls.push("dismiss"),
    ...overrides,
  };
  const element = NeedsYouResolverView(props);
  const tree = nodes(element);
  const html = renderToStaticMarkup(element);
  const find = (attribute: string, value?: unknown) => tree.find((node) => attribute in node.props && (value === undefined || node.props[attribute] === value));
  const press = (attribute: string, value?: unknown) => {
    const found = find(attribute, value);
    if (!found) throw new Error(`no element with ${attribute}`);
    (found.props.onClick as () => void)();
  };
  const h2 = () => tree.find((node) => node.type === "h2");
  const text = (node: Node | undefined) => (node ? Children.toArray(node.props.children).join("") : "");
  return { html, tree, calls, press, find, title: text(h2()) };
}
const items = needsYouItems(bots);
const keyOf = (id: string) => needsYouKey(items.find((item) => item.pendingId === id || (!item.pendingId && item.threadId === id))!);

beforeEach(() => setLocale("pt-br"));
afterEach(() => { setLocale("en"); vi.unstubAllGlobals(); });

describe("titles that say what to do (I3, INSP-I r1 #1/#2)", () => {
  const names = ["Chief of Staff", "Monitor Chat"];
  it("sets leading mentions aside by the server's rule, and never lets a mention swallow the essential", () => {
    expect(needsYouTitle("@Osvaldo aprovar o deploy da versão 2.14 em produção", { botName: "Monitor Chat", botNames: names })).toBe("Aprovar o deploy da versão 2.14 em produção");
    expect(needsYouTitle("@Monitor Chat confira a fila", { botName: "Chief of Staff", botNames: names })).toBe("Confira a fila");
    expect(needsYouTitle("@Monitor Chat Aprovar a fila", { botName: "Chief of Staff", botNames: names })).toBe("Aprovar a fila");
    expect(needsYouTitle("@Osvaldo Aprovar o deploy da versão 2.14", { botName: "x", botNames: names })).toBe("Aprovar o deploy da versão 2.14");
    expect(needsYouTitle("@Ana Revisar o contrato de Maria", { botName: "x", botNames: names })).toBe("Revisar o contrato de Maria");
    expect(needsYouTitle("@time Financeiro Conferir NF 4471", { botName: "x", botNames: names })).toBe("Financeiro Conferir NF 4471");
    expect(needsYouTitle("#9052 / PR #9332: confirmar padrão 'sem limite'", { botName: "x" })).toBe("Confirmar padrão 'sem limite' (#9052 / PR #9332)");
    expect(needsYouTitle("Aprovar o carrier da #9315", { botName: "x" })).toBe("Aprovar o carrier da #9315");
  });

  it("a title that is only a mention becomes the bot's question, else who waits — never the item's why", () => {
    expect(needsYouTitle("@Chief of Staff", { botName: "Monitor Chat", botNames: names })).toBe("Monitor Chat precisa de uma resposta sua");
    expect(needsYouTitle("@Chief of Staff", { botName: "Monitor Chat", botNames: names, ask: "Posso arquivar?" })).toBe("Posso arquivar?");
    const items = needsYouItems(bots); // in pt-BR, the locale of this test
    expect(items.map((item) => item.title)).not.toContain("@Chief of Staff");
    const o4 = items.find((item) => item.pendingId === "o4")!;
    expect(o4).toMatchObject({ title: "Monitor Chat precisa de uma resposta sua", rawTitle: "@Chief of Staff" });
    expect(o4.title).not.toBe(o4.why);
    // reworded titles always keep what the bot wrote one line away (INSP-I r2 #1)
    expect(items.find((item) => item.pendingId === "o5")).toMatchObject({ title: "Aprovar o deploy da versão 2.14 em produção", rawTitle: "@Osvaldo aprovar o deploy da versão 2.14 em produção" });
    expect(items.find((item) => item.pendingId === "o3")).not.toHaveProperty("rawTitle");
    // references moved to the end, a capital letter: nothing removed, no repeat (INSP-I r3 #2)
    expect(items.find((item) => item.pendingId === "o1")).not.toHaveProperty("rawTitle");
    expect(view({ selectedKey: keyOf("o1") }).html).not.toContain("O bot escreveu");
    expect(needsYouTitle("@Osvaldo Silva", { botName: "Monitor Chat", botNames: names })).toBe("Monitor Chat precisa de uma resposta sua");
    expect(view({ selectedKey: keyOf("o5") }).html).toContain("O bot escreveu: @Osvaldo aprovar o deploy");
    expect(items.find((item) => item.threadId === "c2")?.title).toBe("Posso arquivar as 4 conversas antigas?");
    const shown = view({ selectedKey: keyOf("o4") });
    expect(shown.title).toBe("Monitor Chat precisa de uma resposta sua");
    expect(shown.html).toContain("O bot escreveu: @Chief of Staff");
    expect(shown.html).toContain("Sem isso o relatório semanal sai com os números de agosto.");
  });
});

describe("deadlines and order", () => {
  it("reads deadlines written as text — yesterday's are overdue — and sorts by what falls due first, or by waiting", () => {
    expect(dueAt("hoje 18h", now)).toBe(new Date(2026, 9, 2, 18, 0).getTime());
    expect(dueAt("antes de ~19:45 BRT", now)).toBe(new Date(2026, 9, 2, 19, 45).getTime());
    expect(dueAt("amanhã 9h30", now)).toBe(new Date(2026, 9, 3, 9, 30).getTime());
    expect(dueAt("ontem 18h", now)).toBe(new Date(2026, 9, 1, 18, 0).getTime());
    expect(dueAt("ontem 18h", now)! < now).toBe(true);
    expect(dueAt("anteontem", now)).toBe(new Date(2026, 8, 30, 23, 59).getTime());
    expect(dueAt("2026-10-05", now)).toBe(new Date(2026, 9, 5, 23, 59).getTime());
    expect(dueAt("05/10", now)).toBe(new Date(2026, 9, 5, 23, 59).getTime());
    expect(dueAt("sexta", now)).toBe(new Date(2026, 9, 2, 23, 59).getTime()); // 02/10/2026 is a Friday
    expect(dueAt("quando der", now)).toBeNull();
    expect(sortNeedsYou(items, "due", now).map((item) => item.pendingId ?? item.threadId)).toEqual(["o5", "o2", "o1", "o3", "o4", "c2"]);
    expect(sortNeedsYou(items, "age", now).map((item) => item.pendingId ?? item.threadId)).toEqual(["o3", "o2", "o1", "o4", "o5", "c2"]);
    expect(view({ selectedKey: keyOf("o5") }).html).toContain("Prazo vencido: ontem 18h");
  });
});

describe("the resolution screen (I1)", () => {
  it("shows the whole item: full title, who asked and when, why, numbered steps with copy and link, the deadline, and the decisions", () => {
    const { html, title } = view({ selectedKey: keyOf("o1") });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="needs-you-resolver-title"');
    expect(title).toBe("Confirmar o padrão 'sem limite' e decidir o teto (#9052 / PR #12)");
    // the item's region is named by its heading, so two regions never share a name (INSP-I r1 #13)
    expect(html).toContain('<section aria-labelledby="needs-you-item-title"');
    expect(html).toContain(">Chief of Staff</span> pediu há 3 h");
    expect(html).toContain('<span aria-hidden="true">· </span>em “Lote de limites”');
    expect(html).toContain("Por que importa");
    expect(html).toContain("O release depende dela.");
    expect(html).toContain('<span class="sr-only">Passo 2: </span>Rode o gate');
    expect(html).toContain('data-resolver-copy="pnpm run ci:local"');
    expect(html).toContain('aria-label="Copiar o comando do passo 2"');
    expect(html).toContain('aria-label="Abrir a PR #12 (passo 1)"');
    expect(html).toContain("Prazo: hoje 18h");
    expect(html).toContain("Sua decisão");
    expect(html).toContain("Envia: “Aprovado: pode fazer o merge da #12.”");
    expect(html).toContain("Abrir conversa");
    expect(html).toContain("Marcar como resolvido");
    expect(html).toContain("Sua resposta");
    expect(html).toContain("3 de 6");
  });

  it("puts the decisions in the scrolling item on a short or narrow window, each with what it sends — and none pushed by its position (INSP-I r1 #5/#16)", () => {
    const { tree } = view({ selectedKey: keyOf("o1") });
    const decisions = tree.filter((node) => "data-resolver-option" in node.props);
    expect(decisions.map((node) => `${node.props["data-placement"]}:${node.props["data-resolver-option"]}`)).toEqual(["inline:0", "inline:1", "footer:0", "footer:1"]);
    // the two places are complementary: footer on a roomy window, inline otherwise
    const holders = tree.filter((node) => node.type === "div" && typeof node.props.className === "string" && /\[@media\((?:max|min)-height:76[01]px\)\]:hidden/.test(node.props.className as string));
    // INSP-J2 #8: the footer is compact — at most 40% of the window, scrolling inside, in 2 columns;
    // r2 N1: padded by the rings' reach (2 px ring + 2 px offset = p-1), so the clip never cuts them
    expect(holders.map((node) => node.props.className)).toEqual(["mt-6 sm:[@media(min-height:761px)]:hidden", "-mx-1 -mt-1 mb-2 max-h-[40vh] overflow-y-auto p-1 max-sm:hidden [@media(max-height:760px)]:hidden"]);
    for (const node of decisions) expect(String(node.props.className)).toMatch(/focus-visible:ring-2 .*focus-visible:ring-offset-2/);
    // r2 N6: what a footer decision sends shows in up to 2 lines (whole inline)
    expect(String(tree.find((node) => node.props.id === "needs-you-option-footer-0")!.props.className)).toContain("line-clamp-2");
    const grids = tree.filter((node) => node.type === "div" && typeof node.props.className === "string" && (node.props.className as string).startsWith("grid gap-2 "));
    expect(grids.map((node) => node.props.className)).toEqual(["grid gap-2 grid-cols-1", "grid gap-2 grid-cols-2"]);
    // and what scrolls under it fades instead of being cut mid-line
    expect(tree.find((node) => "data-resolver-fade" in node.props)?.props.className).toContain("bg-gradient-to-t from-panel");
    // on a cramped window the footer offers to jump to them
    const jump = tree.find((node) => "data-resolver-jump" in node.props)!;
    expect(String(jump.props.className)).toContain("sm:[@media(min-height:761px)]:hidden");
    expect(Children.toArray(jump.props.children).join("")).toContain("Ver as 2 decisões");
    // decisions look like buttons (J15), but with no recommendation none is
    // filled — all colored as buttons, the refusal neutral (INSP-J2 #1) —
    // and each says what it sends (whole, inline)
    expect(decisions.map((node) => node.props["data-look"])).toEqual(["secondary", "neutral", "secondary", "neutral"]);
    const inlineReply = tree.find((node) => node.props.id === "needs-you-option-inline-0")!;
    expect(String(inlineReply.props.className)).toContain("break-words");
    expect(String(inlineReply.props.className)).not.toContain("hidden");
    // ids stay unique across both places
    const ids = tree.map((node) => node.props.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists every item — nothing hidden below — filters by bot, sorts with toggle buttons, and is one tab stop (roving)", () => {
    const { html, press, calls, tree } = view({ selectedKey: keyOf("o2") });
    expect(html.match(/data-resolver-row=/g)).toHaveLength(6);
    expect(html).not.toContain("mais abaixo");
    expect(html).toContain("Todos os bots (6)");
    expect(html).toContain("Monitor Chat (3)");
    expect(html).toContain('aria-pressed="true" data-sort="due"');
    expect(html).not.toContain('role="radio"');
    expect(html).toContain("Prazo vencido: hoje 09h");
    const rows = tree.filter((node) => "data-resolver-row" in node.props);
    expect(rows.map((row) => row.props.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1]);
    expect(rows[1]!.props["aria-current"]).toBe("true");
    press("data-sort", "age");
    expect(calls).toEqual(["sort:age"]);
    expect(view({ botFilter: "monitor" }).html.match(/data-resolver-row=/g)).toHaveLength(3);
  });

  it("copies the step's command, opens links, and sends a decision (by position and label) to the bot", () => {
    const { press, calls } = view({ selectedKey: keyOf("o1") });
    press("data-resolver-copy", "pnpm run ci:local");
    press("data-resolver-link", "https://github.com/acme/app/pull/12");
    press("data-resolver-option", 1);
    press("data-resolver-conversation");
    press("data-resolver-resolve");
    expect(calls).toEqual(["copy:pnpm run ci:local", "link:https://github.com/acme/app/pull/12", "decide:o1:1", "conversation:c1", "resolve:o1"]);
    expect(decisionReply(items.find((item) => item.pendingId === "o1")!, 1)).toEqual({ option: 1, label: "Recusar" });
    expect(view({ selectedKey: keyOf("o1"), copied: "pnpm run ci:local" }).html).toContain("Copiado");
  });

  it("walks to the previous and next item, and a resolved item hands over to the one in its place", () => {
    const { press, calls } = view({ selectedKey: keyOf("o1") });
    press("data-resolver-prev");
    press("data-resolver-next");
    expect(calls).toEqual([`select:${keyOf("o2")}`, `select:${keyOf("o3")}`]);
    const after = view({ selectedKey: keyOf("o1"), fallbackIndex: 2, items: items.filter((item) => item.pendingId !== "o1") });
    expect(after.title).toBe("Liberar a escrita na linha 97 da planilha");
    expect(view({ selectedKey: keyOf("o5") }).html).toMatch(/aria-label="Item anterior"[^>]*disabled/);
  });

  it("offers to ask for the steps when an old item has none — without the bot's name in every label — and says it was asked", () => {
    const fresh = view({ selectedKey: keyOf("o3") });
    expect(fresh.html).toContain("Monitor Chat ainda não escreveu como resolver isto.");
    expect(fresh.html).toContain("Pedir o passo a passo");
    fresh.press("data-resolver-ask-steps");
    expect(fresh.calls).toEqual(["steps:o3"]);
    // J17: asked 4 min ago (by the person or by the server on its own): "pedindo…", no button
    const asked = view({ selectedKey: keyOf("o4") });
    expect(asked.html).toContain("Pedindo o passo a passo para Monitor Chat…");
    expect(asked.html).not.toContain("data-resolver-ask-steps");
    expect(asked.find("data-resolver-steps-asking")).toBeDefined();
    // no answer after 15 min: the button comes back as "Pedir de novo"
    const late = view({ selectedKey: keyOf("o4"), now: now + 12 * 60_000 });
    // INSP-J2 #11: "para {name}", never "ao {name}" (a bot's name is not always masculine)
    expect(late.html).toContain("O passo a passo foi pedido para Monitor Chat há 16 min e ainda não chegou.");
    expect(late.html).toContain("Pedir de novo");
    late.press("data-resolver-ask-steps");
    expect(late.calls).toEqual(["steps:o4"]);
  });

  it("answers in free text, resolving on send is the person's choice, and a question gets no filler 'why'", () => {
    const { press, calls, html } = view({ selectedKey: keyOf("o3"), draft: "Já liberei." });
    expect(html).toContain("Marcar como resolvido também");
    press("data-resolver-send");
    expect(calls).toEqual(["reply:o3"]);
    expect(view({ selectedKey: keyOf("o3") }).html).toMatch(/data-resolver-send=""[^>]*disabled/);
    const question = view({ selectedKey: keyOf("c2") });
    expect(question.html).not.toContain("Por que importa");
    expect(question.html).not.toContain("data-resolver-resolve");
    expect(question.html).not.toContain("O bot escreveu");
  });

  it("shows loading on the action in flight and disables the others; errors are alerts; a notice names its item, apart from the item on screen", () => {
    const busy = view({ selectedKey: keyOf("o1"), busy: "option:0" });
    expect(busy.html).toContain("animate-spin");
    expect(busy.html).toMatch(/data-resolver-option="1"[^>]*disabled/);
    expect(busy.html).toMatch(/data-resolver-resolve=""[^>]*disabled/);
    const failed = view({ selectedKey: keyOf("o1"), error: "Este item já foi resolvido." });
    expect(failed.html).toContain('role="alert"');
    expect(failed.html).toContain("Este item já foi resolvido.");
    const done = view({ selectedKey: keyOf("o3"), notice: "Enviado «Aprovar» para Chief of Staff — Confirmar o padrão. Item resolvido." });
    expect(done.html).toMatch(/role="status" aria-live="polite"[^>]*><p data-resolver-notice=""[^>]*>.*Enviado «Aprovar» para Chief of Staff — Confirmar o padrão/);
    expect(view({ selectedKey: keyOf("o3") }).html).not.toContain("data-resolver-notice");
  });

  it("says plainly when nothing waits, and when a filter leaves nothing", () => {
    const empty = view({ items: [] });
    expect(empty.html).toContain('data-testid="needs-you-empty"');
    expect(empty.html).toContain("Nada esperando você");
    expect(empty.html).not.toContain("data-resolver-row");
    expect(view({ botFilter: "ghost" }).html).toContain("Mostrar todos");
  });

  it("on a narrow window shows the list or the item, with a way back", () => {
    expect(view({ pane: "list" }).html).toMatch(/<nav aria-label="Itens esperando você" class="[^"]* flex"/);
    const detail = view({ pane: "detail", selectedKey: keyOf("o1") });
    expect(detail.html).toMatch(/<nav aria-label="Itens esperando você" class="[^"]* hidden"/);
    const back = detail.tree.find((node) => node.type === "button" && Children.toArray(node.props.children).includes("Itens"));
    (back!.props.onClick as () => void)();
    expect(detail.calls).toEqual(["back"]);
  });
});

describe("keys on the resolution screen", () => {
  it("walks items with arrows or j/k (any case), R goes to the reply, Escape leaves a field before it closes, ⌘/Ctrl+Enter sends — no decision shortcut", () => {
    expect(resolverKeyAction({ key: "ArrowDown", inField: false })).toBe("next");
    expect(resolverKeyAction({ key: "k", inField: false })).toBe("prev");
    expect(resolverKeyAction({ key: "J", inField: false })).toBe("next");
    expect(resolverKeyAction({ key: "r", inField: false })).toBe("focusReply");
    expect(resolverKeyAction({ key: "R", inField: false })).toBe("focusReply");
    expect(resolverKeyAction({ key: "Escape", inField: true })).toBe("leaveField");
    expect(resolverKeyAction({ key: "Escape", inField: false })).toBe("close");
    expect(resolverKeyAction({ key: "Enter", metaKey: true, inField: true })).toBe("send");
    expect(resolverKeyAction({ key: "Enter", inField: true })).toBeNull();
    expect(resolverKeyAction({ key: "ArrowDown", inField: true })).toBeNull();
    expect(resolverKeyAction({ key: "j", metaKey: true, inField: false })).toBeNull();
    for (const key of ["1", "2", "Enter", "a", "y"]) expect(resolverKeyAction({ key, inField: false })).toBeNull();
  });

  // J15 (the owner, 02/10): the decision cards did not read as buttons.
  // J16: four options ("Sem limite + esperar / + update-branch / + timeout
  // maior / Outro prazo padrão") and nothing said which was best. Redacted.
  it("draws decisions as buttons and puts the bot's recommendation first, filled, with its badge and why", () => {
    const four = [
      { label: "Sem limite + esperar", reply: "Sem limite; espere o gate." },
      { label: "Sem limite + update-branch", reply: "Sem limite; atualize a branch.", recommended: true as const, why: "Destrava o gate hoje sem mexer no limite de ninguém." },
      { label: "Sem limite + timeout maior", reply: "Sem limite; aumente o timeout." },
      { label: "Outro prazo padrão", reply: "Use outro prazo padrão." },
    ];
    const pick = needsYouItems([bot("chief", "Chief of Staff", [task("c9", "Limites", { ownerPending: [{ id: "o9", title: "Confirmar o padrão sem limite", since: now - 3_600_000, options: four }] })])]);
    const { tree, html, press, calls } = view({ items: pick, selectedKey: needsYouKey(pick[0]!) });
    const inline = tree.filter((node) => node.props["data-placement"] === "inline" && "data-resolver-option" in node.props);
    // the recommended first, keeping its index in the item (what the server checks)
    expect(inline.map((node) => node.props["data-resolver-option"])).toEqual([1, 0, 2, 3]);
    expect(inline.map((node) => node.props["data-look"])).toEqual(["primary", "secondary", "secondary", "secondary"]);
    expect(inline[0]!.props["aria-label"]).toBe("Sem limite + update-branch, recomendada");
    expect(String(inline[0]!.props.className)).toMatch(/bg-accent .*text-accent-ink|text-accent-ink.*bg-accent /);
    expect(String(inline[1]!.props.className)).toContain("border-accent bg-accent/8");
    for (const node of inline) expect(String(node.props.className)).toMatch(/cursor-pointer.*focus-visible:ring-2|focus-visible:ring-2.*cursor-pointer/);
    // the badge agrees with "opção/decisão" (INSP-J2 #11)
    expect(html).toContain("Recomendada");
    expect(html).not.toContain("Recomendado");
    expect(html).toContain("Destrava o gate hoje sem mexer no limite de ninguém.");
    // its "Envia" still reads, and the why reaches a screen reader with it
    const described = tree.find((node) => node.props.id === "needs-you-option-inline-1")!;
    expect(renderToStaticMarkup(described as ReactElement)).toMatch(/Destrava o gate hoje.*Envia: “Sem limite; atualize a branch.”/);
    press("data-resolver-option", 1);
    expect(calls).toContain("decide:o9:1");
    // with a recommendation there is nothing to ask
    expect(tree.find((node) => "data-resolver-ask-recommend" in node.props)).toBeUndefined();
  });

  it("an older item with 2+ decisions and none recommended: none filled, a refusal neutral, and a strong button asks the bot", () => {
    const { tree, press, calls, html } = view({ selectedKey: keyOf("o1") });
    // INSP-J2 #1: no recommendation, no fill — not the first by its position, never the refusal
    const inline = tree.filter((node) => node.props["data-placement"] === "inline");
    expect(inline.map((node) => node.props["data-look"])).toEqual(["secondary", "neutral"]);
    for (const node of inline) expect(String(node.props.className)).not.toMatch(/(^| )bg-accent( |$)/);
    expect(html).toContain("Pedir a recomendação de Chief of Staff");
    // with nothing filled, asking is the way forward: it is the strong button
    expect(String(tree.find((node) => "data-resolver-ask-recommend" in node.props)!.props.className)).toContain("bg-accent");
    press("data-resolver-ask-recommend");
    expect(calls).toContain("recommend:o1");
    // asked already: said with how long ago, and the button goes quiet
    const asked = needsYouItems(bots).map((item) => (item.pendingId === "o1" ? { ...item, recommendRequestedAt: now - 3 * 60_000 } : item));
    const again = view({ items: asked, selectedKey: keyOf("o1") });
    expect(again.html).toContain("Recomendação pedida há 3 min");
    expect(String(again.find("data-resolver-ask-recommend")?.props.className ?? "")).not.toContain("bg-accent ");
  });

  // J18 (the owner, 02/10): after choosing "Já colei" on o12 the screen
  // showed nothing of it. Redacted: issue numbers, times.
  it("shows what the person chose and answered, marks the chosen decision, waits on the bot, and asks before switching", () => {
    const at = now - 33 * 60_000;
    const options = [{ label: "Já colei", reply: "Já colei os comentários; pode resolver." }, { label: "Cole você", reply: "Tente colar de novo." }];
    const answered = needsYouItems([bot("monitor", "Monitor Chat Atendimento", [task("dc", "Atendimento", { ownerPending: [{
      id: "o12", title: "Colar os dois comentários dos avisos nas issues #NNNN e #MMMM", since: now - 3 * 3_600_000, why: "O Jev barrou.", steps: [{ text: "Cole os comentários" }], options,
      awaitingSince: at, history: [
        { at: at - 6 * 60_000, kind: "text", text: "Autorizo repetir os comentários.", delivered: true },
        { at, kind: "option", label: "Já colei", text: "Já colei os comentários; pode resolver.", delivered: true },
        { at: at + 60_000, kind: "text", text: "E a planilha?", delivered: false, error: "o bot está ocupado" },
      ],
    }] })])]);
    const key = needsYouKey(answered[0]!);
    const { html, tree, press, calls } = view({ items: answered, selectedKey: key });
    // in the list and in the item: it waits on the bot now
    expect(tree.find((node) => "data-resolver-awaiting" in node.props)).toBeDefined();
    expect(html).toContain("Aguardando Monitor Chat Atendimento");
    // INSP-J2 #9: the banner says what was answered, set apart from the page
    const banner = tree.find((node) => "data-resolver-awaiting-detail" in node.props)!;
    expect(renderToStaticMarkup(banner as ReactElement)).toMatch(/Você escolheu “Já colei” às \d{2}:\d{2}: aguardando Monitor Chat Atendimento\./);
    expect(String(banner.props.className)).toContain("border-accent/40");
    // the history, with what reached the bot and what did not — above the why and the steps (INSP-J2 #8)
    expect(html).toContain("Histórico");
    expect(html.indexOf("Histórico")).toBeLessThan(html.indexOf("Por que importa"));
    // sent: a check, the words for a screen reader and on hover only — not repeated in every line (r2 N8)
    expect(html).toMatch(/title="enviado para Monitor Chat Atendimento"[^>]*>.*Você escolheu “Já colei” às \d{2}:\d{2}<span class="sr-only"> — enviado para Monitor Chat Atendimento/);
    expect(html).toContain("— não enviado: o bot está ocupado");
    // INSP-J2 #2: answered, the decisions fold behind "Mudar resposta"
    expect(tree.find((node) => "data-resolver-option" in node.props)).toBeUndefined();
    press("data-resolver-change-answer");
    expect(calls).toEqual(["changeAnswer:o12"]);
    const open = view({ items: answered, selectedKey: key, changingAnswer: key });
    expect(open.find("data-resolver-change-answer")).toBeUndefined();
    // and folding back is one click (the container toggles it)
    expect(open.html).toContain("Manter a resposta");
    open.press("data-resolver-keep-answer");
    expect(open.calls).toEqual(["changeAnswer:o12"]);
    open.calls.length = 0;
    // the chosen decision is pressed and badged, distinct from a recommendation
    const inline = open.tree.filter((node) => node.props["data-placement"] === "inline" && "data-resolver-option" in node.props);
    expect(inline.map((node) => node.props["aria-pressed"])).toEqual([true, false]);
    expect(inline[0]!.props["aria-label"]).toBe("Já colei, escolhida");
    expect(String(inline[0]!.props.className)).toContain("ring-ink");
    expect(open.html).toContain("Escolhida");
    expect(open.html).not.toContain("Escolhido");
    // INSP-J2 #4: the chosen one again sends nothing; another one asks first
    open.press("data-resolver-option", 0);
    open.press("data-resolver-option", 1);
    expect(open.calls).toEqual(["switch:o12:1"]);
    const confirm = view({ items: answered, selectedKey: key, changingAnswer: key, switching: { key, option: 1 } });
    expect(confirm.html).toContain("Você já escolheu “Já colei”. Trocar para “Cole você”?");
    // INSP-J2 #10: the question takes the focus — on the safe answer, "Manter" (r2 N5)
    expect(confirm.find("data-resolver-switch-no")!.props.autoFocus).toBe(true);
    expect(confirm.find("data-resolver-switch-yes")!.props.autoFocus).toBeUndefined();
    confirm.press("data-resolver-switch-yes");
    confirm.press("data-resolver-switch-no");
    expect(confirm.calls).toEqual(["decide:o12:1", "cancelSwitch"]);
  });

  // INSP-J2 #2 (the owner, 02/10): an answered item stayed in "esperando
  // você" though the ball was with the bot. Redacted.
  it("puts answered items in 'Aguardando bots', out of the count, and back to the person after 2 h of silence", () => {
    const options = [{ label: "Sim", reply: "Sim." }, { label: "Não", reply: "Não." }];
    const list = needsYouItems([bot("monitor", "Monitor Chat", [task("m1", "Vigia", { ownerPending: [
      { id: "o20", title: "Liberar a planilha de agosto", since: now - 5 * 3_600_000, options, awaitingSince: now - 30 * 60_000, history: [{ at: now - 30 * 60_000, kind: "option", label: "Sim", text: "Sim.", delivered: true }] },
      { id: "o21", title: "Confirmar o teto do lote", since: now - 4 * 3_600_000, why: "Trava o release." },
      { id: "o22", title: "Aprovar o envio do relatório", since: now - 6 * 3_600_000, awaitingSince: now - 3 * 3_600_000, history: [{ at: now - 3 * 3_600_000, kind: "text", text: "Pode enviar.", delivered: true }] },
    ] })])]);
    const key = (id: string) => needsYouKey(list.find((item) => item.pendingId === id)!);
    const { html, tree, title } = view({ items: list, selectedKey: key("o21") });
    expect(title).toBe("Confirmar o teto do lote");
    // the header counts what waits on the person: o21 and o22 (silent), not o20
    expect(html).toContain("2 itens esperando você");
    // the awaiting one is last, under its own heading with its own count
    const rows = tree.filter((node) => "data-resolver-row" in node.props).map((node) => node.props["data-resolver-row"]);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toBe(key("o20"));
    expect(html).toContain("Aguardando bots (1)");
    expect(html.indexOf("Aguardando bots (1)")).toBeLessThan(html.indexOf("Liberar a planilha de agosto"));
    // silent for 2 h+: the person's again, said so in the list and in the item
    expect(tree.find((node) => "data-resolver-silent-row" in node.props)).toBeDefined();
    const silent = view({ items: list, selectedKey: key("o22") });
    expect(silent.html).toContain("Sem resposta de Monitor Chat há 3 h: o item voltou para você.");
    expect(silent.find("data-resolver-awaiting-detail")).toBeUndefined();
  });

  it("Escape undoes the innermost thing first: the switch question, then 'Mudar resposta', then the narrow item, then the screen (INSP-J2 #10)", () => {
    expect(resolverEscape({ switching: true, changingAnswer: true, narrowDetail: true })).toBe("cancelSwitch");
    expect(resolverEscape({ switching: false, changingAnswer: true, narrowDetail: true })).toBe("foldAnswer");
    expect(resolverEscape({ switching: false, changingAnswer: false, narrowDetail: true })).toBe("list");
    expect(resolverEscape({ switching: false, changingAnswer: false, narrowDetail: false })).toBe("close");
  });

  // INSP-J2 r2 (the owner's items of 02/10, redacted)
  it("offers 'Lembrar <bot>' on an item its bot let go silent, and only there (N3)", () => {
    const options = [{ label: "Sim", reply: "Sim." }, { label: "Não", reply: "Não." }];
    const list = needsYouItems([bot("monitor", "Monitor Chat", [task("m1", "Vigia", { ownerPending: [
      { id: "o22", title: "Aprovar o envio do relatório", since: now - 6 * 3_600_000, options, awaitingSince: now - 3 * 3_600_000, history: [{ at: now - 3 * 3_600_000, kind: "text", text: "Pode enviar.", delivered: true }] },
      { id: "o20", title: "Liberar a planilha de agosto", since: now - 5 * 3_600_000, awaitingSince: now - 30 * 60_000, history: [{ at: now - 30 * 60_000, kind: "text", text: "Liberei.", delivered: true }] },
    ] })])]);
    const key = (id: string) => needsYouKey(list.find((item) => item.pendingId === id)!);
    const silent = view({ items: list, selectedKey: key("o22") });
    expect(silent.html).toContain("Lembrar Monitor Chat");
    silent.press("data-resolver-remind");
    expect(silent.calls).toEqual(["remind:o22"]);
    expect(view({ items: list, selectedKey: key("o22"), busy: "remind" }).html).toMatch(/data-resolver-remind=""[^>]*disabled/);
    expect(view({ items: list, selectedKey: key("o20") }).find("data-resolver-remind")).toBeUndefined();
  });

  it("says a server item the choice closed is resolved, never 'aguardando' (N4)", () => {
    const item = { botName: "Chief of Staff", title: "Ligue o Mac na tomada", options: [{ label: "Vou deixar na bateria", reply: "Vou deixar." }] };
    expect(decisionNotice(item, 0, { resolved: 1 })).toBe("Enviado «Vou deixar na bateria» para Chief of Staff — Ligue o Mac na tomada. Item resolvido.");
    expect(decisionNotice(item, 0, { resolved: 0 })).toBe("Enviado «Vou deixar na bateria» para Chief of Staff — Ligue o Mac na tomada. Aguardando Chief of Staff.");
    expect(decisionNotice(item, 0, undefined)).toContain("Aguardando Chief of Staff.");
  });

  it("says what was asked, and 'na fila' apart from 'enviado' (N8, N9)", () => {
    const at = new Date(2026, 9, 2, 15, 10).getTime();
    const base = { botName: "Monitor Chat", awaitingSince: at };
    expect(awaitingLine({ ...base, history: [{ at, kind: "ask", label: "steps", text: "x", delivered: true }] }, now)).toBe("Você pediu o passo a passo para Monitor Chat às 15:10: aguardando a resposta.");
    expect(awaitingLine({ ...base, history: [{ at, kind: "ask", label: "recommend", text: "x", delivered: true }] }, now)).toBe("Você pediu a recomendação para Monitor Chat às 15:10: aguardando a resposta.");
    expect(awaitingLine({ ...base, history: [{ at, kind: "ask", label: "remind", text: "x", delivered: true }] }, now)).toBe("Você lembrou Monitor Chat às 15:10: aguardando a resposta.");
    expect(awaitingLine({ ...base, history: [{ at, kind: "option", label: "Sim", text: "Sim.", delivered: false, queued: true }] }, now))
      .toBe("Você escolheu “Sim” às 15:10: aguardando Monitor Chat. O item se atualiza quando houver resposta. A resposta está na fila: Monitor Chat a recebe assim que terminar o que está fazendo.");
    // in the history: a clock and "na fila para", not a check and "enviado"
    const list = needsYouItems([bot("monitor", "Monitor Chat", [task("m1", "Vigia", { ownerPending: [
      { id: "o30", title: "Confirmar o teto do lote", since: now - 3_600_000, options: [{ label: "Sim", reply: "Sim." }, { label: "Não", reply: "Não." }], awaitingSince: at,
        history: [{ at, kind: "option", label: "Sim", text: "Sim.", delivered: false, queued: true }, { at: at + 60_000, kind: "ask", label: "remind", text: "x", delivered: true }] },
    ] })])]);
    const { html, tree } = view({ items: list, selectedKey: needsYouKey(list[0]!), changingAnswer: needsYouKey(list[0]!) });
    expect(tree.filter((node) => "data-history-state" in node.props).map((node) => node.props["data-history-state"])).toEqual(["queued", "delivered"]);
    expect(html).toContain("Você escolheu “Sim” às 15:10<span class=\"text-ink-secondary\"> — na fila para Monitor Chat</span>");
    expect(html).toContain("Você lembrou o bot às 15:11");
    // a queued choice is still the person's choice: marked, and choosing it again sends nothing
    expect(tree.find((node) => node.props["data-placement"] === "inline" && node.props["data-resolver-option"] === 0)!.props["aria-pressed"]).toBe(true);
  });

  it("says when: 'às HH:MM' today, 'em DD/MM às HH:MM' another day, with the year in another one (INSP-J2 #11)", () => {
    const today = new Date(2026, 9, 2, 16, 7).getTime();
    expect(answerTime(new Date(2026, 9, 2, 9, 5).getTime(), today)).toBe("às 09:05");
    expect(answerTime(new Date(2026, 8, 30, 16, 7).getTime(), today)).toBe("em 30/09 às 16:07");
    expect(answerTime(new Date(2025, 11, 31, 23, 59).getTime(), today)).toBe("em 31/12/2025 às 23:59");
  });

  it("names links the way the person reads them", () => {
    expect(linkLabel("https://github.com/acme/app/pull/12")).toBe("a PR #12");
    expect(linkLabel("https://github.com/acme/app/issues/40#x")).toBe("a issue #40");
    expect(linkLabel("claude://code/continue?session=local_1")).toBe("a sessão no Claude");
    expect(linkLabel("https://www.docs.example.com/x")).toBe("docs.example.com");
  });
});
