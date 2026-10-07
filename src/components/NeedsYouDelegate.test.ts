import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bot, Task } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { awaitingBot, needsYouItems, needsYouKey, sortNeedsYou, waitingOnYou } from "@/lib/needs-you";
import { delegatedLine, delegateNotice, NeedsYouResolverView, type NeedsYouResolverViewProps } from "./NeedsYouResolver";

// "Delegar a um agente" (lote del) on the resolution screen. Invented bots and items: no client data.
const now = new Date(2026, 9, 6, 15, 40).getTime();
const at = new Date(2026, 9, 6, 14, 5).getTime();
const task = (threadId: string, title: string, extra: Partial<Task>): Task => ({ threadId, title, createdAt: now - 86_400_000, ...extra }) as Task;
const bots = [{
  id: "eng", name: "Eng", threadId: "e1",
  tasks: [task("e1", "Release", { ownerPending: [
    { id: "o1", title: "Atualizar o CHANGELOG da #9401", since: now - 3 * 3_600_000, steps: [{ text: "Escreva a entrada", command: "npm run changelog" }], delegable: true },
    { id: "o2", title: "Ajustar a regra do hook", since: now - 2 * 3_600_000, steps: [{ text: "Edite as regras" }], onlyYou: "mexe no hook ou no revisor" },
    { id: "o3", title: "Rodar a suíte do widget", since: now - 5 * 3_600_000, steps: [{ text: "Rode a suíte" }],
      options: [{ label: "Rodar", reply: "Rode." }, { label: "Pular", reply: "Pule." }],
      delegation: { at, state: "running", option: "Rodar", sessionId: "s1", sessionTitle: "9401 Delegado pelo dono: Rodar a suíte", link: "claude://code/continue?session=local_1" } },
    { id: "o4", title: "Conferir a página de preços", since: now - 26 * 3_600_000, steps: [{ text: "Leia a página" }], delegable: true,
      delegationBack: { at, outcome: "barrado", text: "o agente fez rodei a suíte; falta publicar (só você): npm run deploy:widget. Motivo: o hook ou o classificador barrou.", command: "npm run deploy:widget" } },
  ] })],
}] as unknown as Bot[];

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}

const items = needsYouItems(bots);
const keyOf = (id: string) => needsYouKey(items.find((item) => item.pendingId === id)!);

function view(selected: string, overrides: Partial<NeedsYouResolverViewProps> = {}) {
  const calls: string[] = [];
  const noop = () => {};
  const props: NeedsYouResolverViewProps = {
    items, now, selectedKey: keyOf(selected), fallbackIndex: 0, botFilter: null, sort: "due", pane: "detail",
    draft: "", resolveOnSend: false, busy: null, error: null, notice: null, copied: null,
    onSelect: noop, onFilter: noop, onSort: noop, onBack: noop, onClose: noop, onDraft: noop, onResolveOnSend: noop,
    onCopy: (text) => calls.push(`copy:${text}`), onOpenLink: (url) => calls.push(`link:${url}`),
    onDecide: (item, n) => calls.push(`decide:${item.pendingId}:${n}`), onReply: noop, onAskSteps: noop, onAskRecommend: noop,
    onResolve: (item) => calls.push(`resolve:${item.pendingId}`), onAskSwitch: noop, onCancelSwitch: noop, onChangeAnswer: noop, onRemind: noop,
    onOpenConversation: noop, onDismissError: noop,
    onDelegate: (item) => calls.push(`delegate:${item.pendingId}`),
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
  return { html, calls, find, press };
}

beforeEach(() => setLocale("pt-br"));
afterEach(() => setLocale("en"));

describe("the button (lote del)", () => {
  it("shows on a delegable item, beside \"Marcar como resolvido\", and delegates that item", () => {
    const shown = view("o1");
    expect(shown.html).toContain("Delegar a um agente");
    expect(shown.find("data-resolver-resolve")).toBeTruthy();
    expect(shown.find("data-resolver-only-you")).toBeUndefined();
    shown.press("data-resolver-delegate");
    expect(shown.calls).toEqual(["delegate:o1"]);
  });

  it("gives way to \"Só você: <motivo>\" on an item only the owner can do", () => {
    const shown = view("o2");
    expect(shown.find("data-resolver-delegate")).toBeUndefined();
    expect(shown.html).toContain("Só você: mexe no hook ou no revisor");
  });

  it("is not there without the screen's handler, nor while it delegates", () => {
    expect(view("o1", { onDelegate: undefined }).find("data-resolver-delegate")).toBeUndefined();
    expect(view("o1", { busy: "delegate" }).find("data-resolver-delegate")?.props.disabled).toBe(true);
  });
});

describe("the delegated item (lote del)", () => {
  it("says \"delegado ao agente às HH:MM\" with the session and its link, and leaves the count", () => {
    const shown = view("o3");
    expect(shown.html).toContain("Delegado ao agente às 14:05.");
    expect(shown.html).toContain("Decisão: «Rodar».");
    expect(shown.html).toContain("Sessão: 9401 Delegado pelo dono: Rodar a suíte.");
    shown.press("data-resolver-delegated-link");
    expect(shown.calls).toEqual(["link:claude://code/continue?session=local_1"]);
    // no second delegation, no decisions to pick meanwhile; resolving stays possible
    expect(shown.find("data-resolver-delegate")).toBeUndefined();
    expect(shown.find("data-resolver-decision")).toBeUndefined();
    expect(shown.find("data-resolver-resolve")).toBeTruthy();
    // its row: the chip, under the waiting heading; out of "Precisa de você" like the answered ones
    expect(shown.find("data-resolver-delegated-row")).toBeTruthy();
    const o3 = items.find((item) => item.pendingId === "o3")!;
    expect(awaitingBot(o3, now)).toBe(true);
    expect(waitingOnYou(items, now).map((item) => item.pendingId)).toEqual(expect.not.arrayContaining(["o3"]));
    expect(waitingOnYou(items, now)).toHaveLength(3);
    expect(shown.html).toContain("3 itens esperando você");
    expect(shown.html).toContain("Aguardando bots (1)");
  });

  it("reads queued before the session opens", () => {
    expect(delegatedLine({ delegation: { at, state: "queued" } }, now)).toBe("Delegado ao agente às 14:05. Aguardando uma vaga na fila de sessões.");
    expect(delegateNotice({ title: "X" }, { queued: true })).toBe("Delegado: \"X\" aguarda uma vaga na fila de sessões.");
    expect(delegateNotice({ title: "X" }, { info: "Este item já foi delegado; não abri outra sessão." })).toBe("Este item já foi delegado; não abri outra sessão.");
  });
});

describe("the item back from the agent (lote del)", () => {
  it("comes first, says what the agent did and what is left, with the command to copy", () => {
    expect(sortNeedsYou(items, "due", now)[0]!.pendingId).toBe("o4");
    expect(sortNeedsYou(items, "age", now)[0]!.pendingId).toBe("o4");
    const shown = view("o4");
    expect(shown.html).toContain("O hook barrou o agente às 14:05: o agente fez rodei a suíte; falta publicar (só você): npm run deploy:widget.");
    shown.press("data-resolver-copy", "npm run deploy:widget");
    expect(shown.calls).toEqual(["copy:npm run deploy:widget"]);
    // it may be delegated again
    expect(shown.find("data-resolver-delegate")).toBeTruthy();
    expect(shown.find("data-resolver-back-row")).toBeTruthy();
  });
});
