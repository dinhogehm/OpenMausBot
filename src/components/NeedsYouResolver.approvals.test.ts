// "Precisa de você" on an approval (or a provider question) a conversation
// stopped on: the panel shows the pending action, offers the chat card's own
// decisions, answers through the same decideRequest (POST /respond), and the
// item leaves once the card is settled — here or in the chat.
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, Bot, Message, Task } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { needsYouItems, needsYouKey, type NeedsYouItem } from "@/lib/needs-you";
import { answerRequest } from "@/lib/needs-you-actions";
import { NeedsYouResolverView, requestNotice, type NeedsYouResolverViewProps } from "./NeedsYouResolver";

// Invented bots and cards: no client data.
const now = new Date(2026, 9, 15, 20, 30).getTime();
const card = (extra: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id: "card-1", at: now - 5 * 60_000, role: "bot", kind: "options",
  card: { title: "Approval needed", subtitle: "type_text: \"Olá, tudo bem?\"", options: ["Allow", "Deny"], tool: "mcp__computer__type_text", requestId: "req-1", allowSession: true, ...extra },
});
const task = (threadId: string, title: string, extra: Partial<Task>): Task => ({ threadId, title, createdAt: now - 86_400_000, ...extra }) as Task;
const bot = (tasks: Task[], extra: Partial<Bot> = {}): Bot => ({ id: "monitor", name: "Monitor Chat", threadId: "other", tasks, messages: [], ...extra }) as unknown as Bot;
const waiting = (pendingRequests?: Message[]) => task("t1", "@Monitor Chat", { activity: "waiting-on-you", ...(pendingRequests ? { pendingRequests } : {}) });

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function view(items: NeedsYouItem[], overrides: Partial<NeedsYouResolverViewProps> = {}) {
  const calls: unknown[] = [];
  const noop = () => undefined;
  const props: NeedsYouResolverViewProps = {
    items, now, selectedKey: items[0] ? needsYouKey(items[0]) : null, fallbackIndex: 0, botFilter: null, sort: "due", pane: "detail",
    draft: "", resolveOnSend: false, busy: null, error: null, notice: null, copied: null,
    onSelect: noop, onFilter: noop, onSort: noop, onBack: noop, onClose: noop, onDraft: noop, onResolveOnSend: noop, onCopy: noop, onOpenLink: noop,
    onDecide: noop, onReply: (item) => calls.push(["reply", item.threadId]), onAskSteps: noop, onAskRecommend: noop, onResolve: noop,
    onAskSwitch: noop, onCancelSwitch: noop, onChangeAnswer: noop, onRemind: noop, onOpenConversation: noop, onDismissError: noop,
    onRequest: (item, request, choice, label) => calls.push(["request", item.threadId, request.card?.requestId, choice, label]),
    ownerOrAdmin: false,
    ...overrides,
  };
  const element = NeedsYouResolverView(props);
  const tree = nodes(element);
  const html = renderToStaticMarkup(element);
  const choice = (key: string) => tree.find((node) => node.props["data-resolver-request-choice"] === key);
  const choices = tree.filter((node) => "data-resolver-request-choice" in node.props).map((node) => String(node.props["data-resolver-request-choice"]));
  return { html, tree, calls, choice, choices };
}

beforeEach(() => setLocale("pt-br"));
afterEach(() => { setLocale("en"); vi.unstubAllGlobals(); });

describe("an approval item shows the pending action and the card's own options", () => {
  it("says what the bot wants to run, with the tool and the exact detail, not the generic text", () => {
    const items = needsYouItems([bot([waiting([card()])])]);
    expect(items).toHaveLength(1);
    expect(items[0]!.approval).toBe(true);
    expect(items[0]!.title).toBe("Monitor Chat quer type text");
    expect(items[0]!.since).toBe(now - 5 * 60_000);
    const shown = view(items);
    expect(shown.html).toContain("O que Monitor Chat quer fazer");
    expect(shown.html).toContain("mcp__computer__type_text");
    expect(shown.html).toContain("type_text: &quot;Olá, tudo bem?&quot;");
    // the steps say how to answer here, never "abra a conversa… escolha lá"
    expect(shown.html).toContain("Escolha uma das opções abaixo");
    expect(shown.html).not.toContain("escolha Aprovar ou Negar lá");
  });

  it("offers exactly the chat composer's decisions, in its order", () => {
    const shown = view(needsYouItems([bot([waiting([card()])])]));
    expect(shown.choices).toEqual(["cancelTurn", "deny", "alwaysAllowSession", "allow"]);
    expect(shown.html).toContain("Permitir uma vez");
    expect(shown.html).toContain("Negar");
    expect(shown.html).toContain("Sempre permitir nesta sessão");
    // a harness-native grant: "Sempre permitir", remembered against the bot that asked
    const native = view(needsYouItems([bot([waiting([card({ allowKey: "computer:type_text", allowSession: undefined })])])]));
    expect(native.choices).toEqual(["cancelTurn", "deny", "alwaysAllow", "allow"]);
    // an exact command an owner may remember
    const command = card({ tool: "Bash", allowSession: true, commandAllowlist: { command: "git status", cwd: "/w", providerInstanceId: "claude" } });
    expect(view(needsYouItems([bot([waiting([command])])]), { ownerOrAdmin: true }).choices).toEqual(["cancelTurn", "deny", "rememberCommand", "allow"]);
  });

  it("says how many more cards wait in the same conversation", () => {
    const second = { ...card({ requestId: "req-2" }), id: "card-2", at: now };
    expect(view(needsYouItems([bot([waiting([card(), second])])])).html).toContain("Mais 1 esperando nesta conversa depois desta.");
  });
});

describe("choosing an option answers the card the way the chat does, and the item leaves", () => {
  it("presses into onRequest with the card and the choice", () => {
    const shown = view(needsYouItems([bot([waiting([card()])])]));
    (shown.choice("allow")!.props.onClick as () => void)();
    (shown.choice("deny")!.props.onClick as () => void)();
    expect(shown.calls).toEqual([
      ["request", "t1", "req-1", { approval: "allow" }, "Permitir uma vez"],
      ["request", "t1", "req-1", { approval: "deny" }, "Negar"],
    ]);
  });

  it("dispatches the composer's decideRequest (POST /respond) and settles when the server took it", async () => {
    const [item] = needsYouItems([bot([waiting([card()])])]);
    const sent: Action[] = [];
    const dispatch = (action: Action) => {
      sent.push(action);
      if (action.type === "decideRequest") action.onDone?.();
    };
    await answerRequest(item!, item!.requests![0]!, { approval: "allow" }, dispatch);
    await answerRequest(item!, item!.requests![0]!, { approval: "deny" }, dispatch);
    await answerRequest(item!, item!.requests![0]!, { approval: "alwaysAllowSession" }, dispatch);
    expect(sent).toEqual([
      expect.objectContaining({ type: "decideRequest", threadId: "t1", requestId: "req-1", behavior: "allow", always: undefined, rememberCommand: undefined }),
      expect.objectContaining({ type: "decideRequest", threadId: "t1", requestId: "req-1", behavior: "deny", message: "Denied by the user." }),
      expect.objectContaining({ type: "decideRequest", threadId: "t1", requestId: "req-1", behavior: "allow", always: true }),
    ]);
    // "Cancelar execução" stops the turn, as in the chat — it answers nothing
    sent.length = 0;
    await answerRequest(item!, item!.requests![0]!, { approval: "cancelTurn" }, dispatch);
    expect(sent).toEqual([{ type: "interrupt", botId: "monitor", threadId: "t1" }]);
  });

  it("a refused answer is an error on the screen, not a silent success", async () => {
    const [item] = needsYouItems([bot([waiting([card()])])]);
    const dispatch = (action: Action) => { if (action.type === "decideRequest") action.onError?.("Request expired"); };
    await expect(answerRequest(item!, item!.requests![0]!, { approval: "allow" }, dispatch)).rejects.toThrow("Request expired");
  });

  it("leaves the list once the server settles the card (the conversation stops waiting)", () => {
    expect(needsYouItems([bot([task("t1", "@Monitor Chat", { activity: "working", pendingRequests: [card()] })])])).toEqual([]);
    expect(needsYouItems([bot([waiting([])])])).toEqual([]);
    expect(needsYouItems([bot([waiting([card({ answered: "allow" })])])])).toEqual([]);
    expect(needsYouItems([bot([waiting([card({ expired: true })])])])).toEqual([]);
  });

  it("says what was sent", () => {
    const [item] = needsYouItems([bot([waiting([card()])])]);
    expect(requestNotice(item!, item!.requests![0]!, { approval: "allow" }, "Permitir uma vez")).toBe("“Permitir uma vez” enviado a Monitor Chat. O item sai da lista assim que Monitor Chat receber.");
    expect(requestNotice(item!, item!.requests![0]!, { approval: "cancelTurn" }, "Cancelar execução")).toBe("A execução de Monitor Chat foi cancelada.");
  });
});

describe("an approval answered in the chat leaves the panel", () => {
  it("the open conversation's own card settles it, before the server's next frame", () => {
    const answered = card({ answered: "allow" });
    // the server's list still has it open; the chat already answered it
    const items = needsYouItems([bot([waiting([card()])], { threadId: "t1", messages: [answered] })]);
    expect(items).toEqual([]);
  });

  it("a card the chat holds open is shown even before the server lists it", () => {
    const items = needsYouItems([bot([waiting([])], { threadId: "t1", messages: [card()] })]);
    expect(items).toHaveLength(1);
    expect(items[0]!.requests?.[0]?.card?.requestId).toBe("req-1");
  });
});

describe("questions and older servers keep working", () => {
  it("a provider question offers its answers, sent as the answer", () => {
    const question = card({ tool: undefined, title: "Qual planilha uso?", subtitle: "", options: ["Atendimento", "Vendas"], requestType: "question", allowSession: undefined });
    const items = needsYouItems([bot([waiting([question])])]);
    expect(items[0]!.title).toBe("Qual planilha uso?");
    const shown = view(items);
    expect(shown.html).toContain("O que Monitor Chat pergunta");
    expect(shown.choices).toEqual(["answer-0", "answer-1"]);
    (shown.choice("answer-1")!.props.onClick as () => void)();
    expect(shown.calls).toEqual([["request", "t1", "req-1", { answer: "Vendas" }, "Vendas"]]);
  });

  it("a free question (goal mode) is still answered in words, with no card decisions", () => {
    const items = needsYouItems([bot([task("t2", "Vigia", { goalNeedsInput: true, goalNeedsInputSince: now - 60_000, goalNeedsInputAsk: "Posso arquivar as 4 conversas antigas?" })])]);
    expect(items).toHaveLength(1);
    expect(items[0]!.requests).toBeUndefined();
    const shown = view(items, { draft: "Pode." });
    expect(shown.choices).toEqual([]);
    (shown.tree.find((node) => "data-resolver-send" in node.props)!.props.onClick as () => void)();
    expect(shown.calls).toEqual([["reply", "t2"]]);
  });

  it("a server that does not list the cards keeps the item and the way to the conversation", () => {
    const items = needsYouItems([bot([waiting()])]);
    expect(items).toHaveLength(1);
    expect(items[0]!.requests).toBeUndefined();
    const shown = view(items);
    expect(shown.choices).toEqual([]);
    expect(shown.html).toContain("escolha Aprovar ou Negar lá");
  });
});
