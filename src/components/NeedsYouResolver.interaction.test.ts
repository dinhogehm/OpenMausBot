// The resolution screen's container, driven like the person drives it: keys,
// a decision that succeeds, one that fails. Hooks run on a fixture (no DOM in
// this suite), the portal renders in place.
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Task } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { needsYouItems, needsYouKey, type NeedsYouItem } from "@/lib/needs-you";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, refs: [] as Array<{ current: unknown }>, refIndex: 0 }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(fixture.values[index]) : next; }];
  },
  useEffect: () => {},
  useRef: (initial: unknown) => {
    const index = fixture.refIndex++;
    fixture.refs[index] ??= { current: initial };
    return fixture.refs[index];
  },
}));
vi.mock("react-dom", async (original) => ({ ...await original<typeof import("react-dom")>(), createPortal: (children: ReactNode) => children }));
import { NeedsYouResolver } from "./NeedsYouResolver";

const now = new Date(2026, 9, 2, 15, 40).getTime();
const task = (threadId: string, title: string, extra: Partial<Task>): Task => ({ threadId, title, createdAt: now - 86_400_000, ...extra }) as Task;
const bots = [{ id: "chief", name: "Chief of Staff", threadId: "c1", tasks: [task("c1", "Lote", { ownerPending: [
  { id: "o1", title: "Aprovar o merge da PR #12", since: now - 3_600_000, due: "hoje 18h", options: [{ label: "Aprovar", reply: "Aprovado." }, { label: "Recusar", reply: "Recusado." }] },
  { id: "o2", title: "Liberar a linha 97", since: now - 7_200_000 },
] })] }] as unknown as Bot[];
const items = needsYouItems(bots);

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

type Handlers = {
  onDecide: ReturnType<typeof vi.fn<(item: NeedsYouItem, option: number) => Promise<unknown>>>;
  onClose: ReturnType<typeof vi.fn<() => void>>;
  onReply: ReturnType<typeof vi.fn<(item: NeedsYouItem, text: string, resolve: boolean) => Promise<unknown>>>;
};
let handlers: Handlers;
function render(open = true) {
  fixture.index = 0;
  fixture.refIndex = 0;
  const tree = NeedsYouResolver({ open, items, initialKey: needsYouKey(items[1]!), now, onOpenConversation: vi.fn(), onOpenLink: vi.fn(), onCopy: vi.fn(), onAskSteps: vi.fn(), onResolve: vi.fn(), ...handlers });
  const all = nodes(tree);
  const dialog = all.find((node) => node.props.role === "dialog");
  const heading = all.find((node) => node.type === "h2");
  const keyHost = all.find((node) => typeof node.props.onKeyDown === "function");
  const key = (key: string, extra: Record<string, unknown> = {}) => (keyHost!.props.onKeyDown as (event: unknown) => void)({ key, target: { tagName: "DIV" }, preventDefault: () => {}, ...extra });
  return { all, dialog, title: heading ? Children.toArray(heading.props.children).join("") : null, key };
}

beforeEach(() => {
  fixture.values = []; fixture.refs = [];
  handlers = {
    onDecide: vi.fn<(item: NeedsYouItem, option: number) => Promise<unknown>>(async () => {}),
    onClose: vi.fn<() => void>(),
    onReply: vi.fn<(item: NeedsYouItem, text: string, resolve: boolean) => Promise<unknown>>(async () => {}),
  };
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("document", { body: {}, activeElement: null });
  setLocale("pt-br");
});
afterEach(() => { setLocale("en"); vi.unstubAllGlobals(); });

describe("the resolution screen, driven by keys and clicks", () => {
  it("is absent closed, opens on the item clicked, and walks items with the arrows", () => {
    expect(render(false).dialog).toBeUndefined();
    const first = render();
    expect(first.title).toBe("Aprovar o merge da PR #12");
    first.key("ArrowDown");
    expect(render().title).toBe("Liberar a linha 97");
    render().key("k");
    expect(render().title).toBe("Aprovar o merge da PR #12");
    // arrows typed in the reply stay in the reply
    render().key("ArrowDown", { target: { tagName: "TEXTAREA" } });
    expect(render().title).toBe("Aprovar o merge da PR #12");
    // Escape in the reply leaves the field; it does not close (INSP-I r1 #11d)
    render().key("Escape", { target: { tagName: "TEXTAREA" } });
    expect(handlers.onClose).not.toHaveBeenCalled();
    // an upper-case R goes to the reply too (the hint says "R")
    expect(() => render().key("R")).not.toThrow();
    render().key("Escape");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  const press = (option: number) => (render().all.find((node) => node.props["data-resolver-option"] === option && node.props["data-placement"] === "footer")!.props.onClick as () => void)();
  const notice = () => JSON.stringify(render().all.find((node) => "data-resolver-notice" in node.props)?.props.children ?? null);

  it("sends a decision once and says which item it went to; a failure is an alert, never 'sent'", async () => {
    press(0);
    await flush();
    expect(handlers.onDecide).toHaveBeenCalledWith(expect.objectContaining({ pendingId: "o1" } satisfies Partial<NeedsYouItem>), 0);
    // J18: a decision no longer closes the item — it waits on the bot
    expect(notice()).toContain("Enviado «Aprovar» para Chief of Staff — Aprovar o merge da PR #12. Aguardando Chief of Staff.");
    handlers.onDecide.mockRejectedValueOnce(new Error("O bot reescreveu as opções deste item."));
    press(1);
    await flush();
    const alert = render().all.find((node) => node.props.role === "alert");
    expect(JSON.stringify(alert?.props.children)).toContain("O bot reescreveu as opções deste item.");
    expect(notice()).toBe("null");
  });

  it("does not close while a send is in flight, and a failed reply keeps the draft", async () => {
    let finish!: () => void;
    handlers.onDecide.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    press(0);
    await flush();
    render().key("Escape");
    expect(handlers.onClose).not.toHaveBeenCalled();
    finish();
    await flush();
    const textarea = render().all.find((node) => node.type === "textarea")!;
    (textarea.props.onChange as (event: unknown) => void)({ target: { value: "Pode seguir." } });
    handlers.onReply.mockRejectedValueOnce(new Error("Não deu certo. Tente de novo."));
    render().key("Enter", { ctrlKey: true, target: { tagName: "TEXTAREA" } });
    await flush();
    expect(render().all.find((node) => node.type === "textarea")!.props.value).toBe("Pode seguir.");
    expect(notice()).toBe("null");
  });

  it("sends the reply with ⌘/Ctrl+Enter from the reply field", async () => {
    const view = render();
    const textarea = view.all.find((node) => node.type === "textarea")!;
    (textarea.props.onChange as (event: unknown) => void)({ target: { value: "Pode seguir." } });
    render().key("Enter", { metaKey: true, target: { tagName: "TEXTAREA" } });
    await flush();
    expect(handlers.onReply).toHaveBeenCalledWith(expect.objectContaining({ pendingId: "o1" }), "Pode seguir.", false);
  });
});
