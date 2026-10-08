import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_BUNDLE_ID,
  SETUP_MAX_TRIES,
  chipTargets,
  createDesktopSession,
  newLines,
  openDesktopSessionIn,
  pickerItem,
  wordsAt,
  type DesktopDriver,
  type OcrLine,
} from "./claude-desktop.ts";

// o73: the new session is set up on screen before the brief — the folder
// picker, the worktree option, the branch picker — and the brief goes in only
// once the screen reads right. A fake app that ANSWERS the clicks: its chips,
// its pickers and the system's folder panel change as a person would see them.

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });

const RETURN = 36;
const ESCAPE = 53;
const KEY_A = 0;
const BACKSPACE = 51;
const SIZE = { w: 1_470, h: 923 };
const FIELD = "Descreva uma tarefa ou faça uma pergunta";
const OURS = "9353-comprar-assentos";
const LINK = `/Users/o/Projetos/.omb-worktree-links/nuria-platform/${OURS}`;

interface AppState {
  folder: string;
  branch: string;
  option: "on" | "off";
  /** The option ignores clicks (a box that does not take). */
  stuckOption?: boolean;
  /** Folders the folder picker lists; `searchOnly`: only once something is typed in its search. */
  folders: string[];
  searchOnly?: boolean;
  /** The picker offers a search field / an "open folder" item. */
  search?: boolean;
  openFolder?: boolean;
  branches: string[];
  /** A trust prompt over the chips. */
  trust?: boolean;
  /** Picking a folder leaves a conversation on screen instead of the new session. */
  pickLeavesConversation?: boolean;
  /** Typing into the search goes into the session's field instead. */
  searchTypesInField?: boolean;
  /** A conversation is on screen until New Session opens the new one. */
  conversationFirst?: boolean;
}

type Line = OcrLine & { id: string };

/** A fake Claude app with the R8 layout (the real capture's coordinates). */
function liveApp(initial: AppState) {
  const state = { ...initial };
  const actions: string[] = [];
  let picker: "folder" | "branch" | null = null;
  let searched = "";
  let field = "";
  let sent = false;
  let opened = !initial.conversationFirst;
  let panel: null | { goto: boolean; path: string; navigated: boolean } = null;
  const at = (id: string, x: number, y: number, w: number, text: string, h = 16): Line => ({ id, x, y, w, h, text });
  const render = (): Line[] => {
    if (!opened) return [at("header", 600, 60, 400, "Sessão antiga v (nuria-platform"), at("said", 547, 400, 300, "Texto da conversa anterior"), at("reply", 547, 839, 100, "Responder…"), at("bar", 545, 889, 222, "+ O v Ignorar permissões")];
    if (sent) return [at("said", 547, 700, 300, "Vou começar pelo Passo 0."), at("reply", 547, 839, 100, "Responder…"), at("bar", 545, 889, 222, "+ O v Ignorar permissões")];
    const lines: Line[] = [at("hello", 566, 75, 348, "Bem-vindo de volta, Fulano", 30)];
    if (state.trust) lines.push(at("trust", 540, 750, 180, "Confiar no workspace"));
    lines.push(
      at("local", 540, 788, 71, "• Local"),
      at("folder", 660, 788, 118, state.folder),
      at("branch", 801, 786, 68, `gº ${state.branch}`),
      at("worktree", 885, 788, 92, `${state.option === "on" ? "v" : "|O"} worktree`, 15),
      at("field", 547, 839, 366, field || FIELD, 25),
      at("bar", 545, 889, 222, "+ O v Ignorar permissões"),
    );
    if (picker === "folder") {
      let y = 520;
      if (state.search) { lines.push(at("search", 660, y, 200, searched || "Pesquisar pastas")); y += 30; }
      const shown = state.searchOnly && !searched ? [] : state.folders.filter((name) => !searched || name.includes(searched));
      for (const name of shown) { lines.push(at(`item:${name}`, 660, y, 220, `~/Projetos/${name}`)); y += 30; }
      if (state.openFolder) lines.push(at("browse", 660, y, 140, "Abrir pasta…"));
    }
    if (picker === "branch") state.branches.forEach((name, i) => lines.push(at(`branch:${name}`, 801, 560 + i * 30, 160, name)));
    if (panel) {
      lines.push(at("cancel", 900, 600, 70, "Cancelar"), at("open", 1000, 600, 50, "Abrir"));
      if (panel.goto) lines.push(at("goto", 700, 300, 400, panel.path || "/"));
    }
    return lines;
  };
  const hit = (x: number, y: number) => render().filter((line) => x >= line.x && x <= line.x + line.w && y >= line.y && y <= line.y + line.h).at(-1);
  const driver: DesktopDriver = {
    idleSeconds: async () => 120,
    frontmost: async () => CLAUDE_BUNDLE_ID,
    locked: async () => false,
    screenSize: async () => SIZE,
    ocr: async () => render().map(({ id: _id, ...line }) => line),
    click: async (x, y) => {
      const line = hit(x, y);
      actions.push(`click ${line?.id ?? "nothing"}`);
      if (!line) return;
      if (panel) {
        if (line.id === "open" && panel.navigated) { state.folder = panel.path.split("/").filter(Boolean).pop()!; panel = null; }
        if (line.id === "cancel") panel = null;
        return;
      }
      if (line.id === "folder") picker = "folder";
      else if (line.id === "branch") picker = "branch";
      else if (line.id === "worktree" && !state.stuckOption) state.option = state.option === "on" ? "off" : "on";
      else if (line.id.startsWith("item:")) {
        state.folder = line.id.slice(5);
        picker = null;
        searched = "";
        if (state.pickLeavesConversation) sent = true;
      } else if (line.id.startsWith("branch:")) { state.branch = line.id.slice(7); picker = null; }
      else if (line.id === "browse") { picker = null; panel = { goto: false, path: "", navigated: false }; }
    },
    rightClick: async () => {},
    key: async (code, command) => {
      actions.push(`key ${code}${command ? "+cmd" : ""}`);
      if (code === ESCAPE) { if (panel?.goto) panel.goto = false; else if (panel) panel = null; else picker = null; searched = ""; }
      if (code === RETURN && panel?.goto) { panel.navigated = true; panel.goto = false; }
      else if (code === RETURN && !panel && !picker && field) sent = true;
      if (code === BACKSPACE && !picker && !panel) field = "";
      void KEY_A;
    },
    paste: async (text) => {
      actions.push(`paste ${text.slice(0, 40)}`);
      if (panel?.goto) panel.path = text;
      else if (!picker && !panel) field = text;
    },
    typeText: async (text) => {
      actions.push(`type ${text}`);
      if (panel && text === "/") panel.goto = true;
      else if (picker === "folder" && state.search && !state.searchTypesInField) searched += text;
      else if (!panel) field += text;
    },
    menuNewSession: async () => { actions.push("menu new session"); opened = true; },
    openUrl: async (url) => { actions.push(`open ${url}`); },
    activateClaude: async () => { actions.push("activate"); },
    activate: async () => {},
    sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); },
  };
  return { driver, actions, state, field: () => field, sent: () => sent };
}

const own = (state: Partial<AppState> = {}) => liveApp({ folder: "nuria-platform", branch: `omb/${OURS}`, option: "off", folders: ["nuria-platform", OURS, "soph-ia"], branches: [], ...state });
const openOurs = (driver: DesktopDriver, extra: { registered?: () => readonly string[] } = {}) => openDesktopSessionIn(driver, { folder: LINK, folderName: OURS, text: "brief da 9353", ...extra });

describe("the server's own folder: set on screen before the brief (o73)", () => {
  it("picks our folder in the folder picker when the chip shows the folder before, reads it again, then pastes", async () => {
    const app = own();
    const step = await openOurs(app.driver);
    expect(step).toMatchObject({ ok: true, note: expect.stringContaining(`picked "~/Projetos/${OURS}" in its list`) });
    expect(app.state.folder).toBe(OURS);
    // the chip, the item, then the empty field — and only then the brief
    expect(app.actions.filter((action) => action.startsWith("click"))).toEqual(["click folder", `click item:${OURS}`, "click field"]);
    expect(app.actions.indexOf(`click item:${OURS}`)).toBeLessThan(app.actions.findIndex((action) => action.startsWith("paste")));
    expect(app.sent()).toBe(true);
  });

  it("types the folder's name in the picker's search when the list does not show it", async () => {
    const app = own({ search: true, searchOnly: true });
    const step = await openOurs(app.driver);
    expect(step).toMatchObject({ ok: true, note: expect.stringContaining("after searching it") });
    expect(app.actions).toContain(`type ${OURS}`);
    expect(app.state.folder).toBe(OURS);
  });

  it("goes through the system's folder panel when the picker offers only \"Abrir pasta…\", the path shown before Return", async () => {
    const app = own({ folders: ["soph-ia"], openFolder: true });
    const step = await openOurs(app.driver);
    expect(step).toMatchObject({ ok: true, note: expect.stringContaining(`opened ${LINK} in the folder panel`) });
    const panel = app.actions.slice(app.actions.indexOf("click browse"));
    expect(panel.slice(0, 5)).toEqual(["click browse", "type /", `paste ${LINK.slice(0, 40)}`, `key ${RETURN}`, "click open"]);
    expect(app.state.folder).toBe(OURS);
  });

  it("closes a picker that shows no single item for our folder and stops as before: nothing typed, the reason says what was tried", async () => {
    const app = own({ folders: ["soph-ia", "nuria-platform"] });
    const step = await openOurs(app.driver);
    expect(step).toMatchObject({ ok: false, miss: true, previousFolder: true });
    expect(!step.ok && step.reason).toContain(`tried on screen first: clicked the folder chip ("nuria-platform"): its picker showed no single "${OURS}"`);
    expect(!step.ok && step.reason).toContain("nothing was typed");
    expect(app.actions).toContain(`key ${ESCAPE}`);
    expect(app.actions.some((action) => action.startsWith("paste") || action.startsWith("type"))).toBe(false);
  });

  it("never clicks a cut item another worktree of the repository also starts with", async () => {
    const cut: OcrLine[] = [{ x: 660, y: 520, w: 200, h: 16, text: "9378-supervisor-do-ate…" }];
    expect(pickerItem(cut, "9378-supervisor-do-atendimento-035161", { others: () => ["9378-supervisor-do-atendimento"] })).toBeNull();
    expect(pickerItem(cut, "9378-supervisor-do-atendimento-035161", { others: () => ["9337-sobrecarga"] })).toBe(cut[0]);
    // with no list of the others to check it against, a cut is never taken
    expect(pickerItem(cut, "9378-supervisor-do-atendimento-035161")).toBeNull();
  });

  it("switches the worktree option off when it reads ON, and pastes once it reads off", async () => {
    const app = own({ folder: OURS, option: "on" });
    const step = await openOurs(app.driver);
    expect(step).toMatchObject({ ok: true, note: expect.stringContaining('clicked the worktree option ("v") to turn it off') });
    expect(app.state.option).toBe("off");
  });

  it(`stops after ${SETUP_MAX_TRIES} clicks on an option that does not take: the old stop (worktreeOption on), nothing typed`, async () => {
    const app = own({ folder: OURS, option: "on", stuckOption: true });
    const step = await openOurs(app.driver);
    expect(step).toMatchObject({ ok: false, miss: true, worktreeOption: "on" });
    expect(app.actions.filter((action) => action === "click worktree")).toHaveLength(SETUP_MAX_TRIES);
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
  });

  it("sets the folder and then the option in one create", async () => {
    const app = own({ option: "on" });
    expect(await openOurs(app.driver)).toMatchObject({ ok: true });
    expect(app.state).toMatchObject({ folder: OURS, option: "off" });
  });

  it("never clicks \"Confiar\": a prompt left after our folder is picked goes to the person as before", async () => {
    const app = own({ trust: true });
    const step = await openOurs(app.driver);
    expect(app.state.folder).toBe(OURS);
    // no `expected`/`registered`: not provably a worktree the server made
    expect(step).toMatchObject({ ok: false, trustNeeded: LINK });
    expect(app.actions).not.toContain("click trust");
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
  });

  it("clears its own text and stops when the search's name went into the session's field", async () => {
    const app = own({ search: true, searchOnly: true, searchTypesInField: true });
    const step = await openOurs(app.driver);
    expect(step).toMatchObject({ ok: false, previousFolder: true });
    expect(!step.ok && step.reason).toContain("in its search, which did not show it");
    expect(app.actions).toEqual(expect.arrayContaining([`key ${KEY_A}+cmd`, `key ${BACKSPACE}`]));
    expect(app.field()).toBe("");
    expect(app.sent()).toBe(false);
  });
});

const root = (state: Partial<AppState> = {}) => liveApp({ folder: "nuria-platform", branch: "main", option: "on", folders: ["nuria-platform", "soph-ia"], branches: ["main", "develop"], conversationFirst: true, ...state });
const createIn = (driver: DesktopDriver, extra: Partial<Parameters<typeof createDesktopSession>[1]> = {}) =>
  createDesktopSession(driver, { repoName: "nuria-platform", repoPath: "/Users/o/Projetos/nuria-platform", text: "brief", baseBranch: "main", branches: ["main", "develop"], ...extra });

describe("New Session in the repository root: set on screen before the brief (o73)", () => {
  it("picks the repository in the folder picker when New Session opened in another folder, then clicks the empty field and pastes", async () => {
    const app = root({ folder: "soph-ia" });
    const step = await createIn(app.driver);
    expect(step).toMatchObject({ ok: true, note: expect.stringContaining('picked "~/Projetos/nuria-platform"') });
    expect(app.actions.filter((action) => action.startsWith("click"))).toEqual(["click folder", "click item:nuria-platform", "click field"]);
  });

  it("switches the worktree option on when the old way asks it, and leaves it as it is otherwise", async () => {
    const asked = root({ option: "off" });
    expect(await createIn(asked.driver, { worktree: "on" })).toMatchObject({ ok: true, note: expect.stringContaining("to turn it on") });
    expect(asked.state.option).toBe("on");
    const left = root({ option: "off" });
    expect(await createIn(left.driver)).toEqual({ ok: true });
    expect(left.state.option).toBe("off");
    expect(left.actions).not.toContain("click worktree");
  });

  it("sets the base branch in the branch picker, with the option on", async () => {
    const app = root({ branch: "develop" });
    const step = await createIn(app.driver);
    expect(step).toMatchObject({ ok: true, note: expect.stringContaining('picked "main"') });
    expect(app.state.branch).toBe("main");
  });

  it("never touches the branch with the option off (it would be the root's own checkout): the old stop", async () => {
    const app = root({ branch: "develop", option: "off" });
    const step = await createIn(app.driver);
    expect(step).toMatchObject({ ok: false, miss: true, reason: expect.stringContaining("it shows develop, not main") });
    expect(app.actions.filter((action) => action.startsWith("click"))).toEqual([]);
  });

  it("never pastes into a conversation: a pick that leaves no empty field stops", async () => {
    const app = root({ folder: "soph-ia", pickLeavesConversation: true });
    const step = await createIn(app.driver);
    expect(step).toMatchObject({ ok: false, miss: true });
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
  });
});

describe("reading the chips and the pickers (o73)", () => {
  // R8-visual-claude-1 (01/10), as OCR read it
  const R8: OcrLine[] = [
    { x: 540, y: 788, w: 71, h: 16, text: "• Local" },
    { x: 660, y: 788, w: 118, h: 17, text: "nuria-platform" },
    { x: 801, y: 786, w: 68, h: 17, text: "gº main" },
    { x: 885, y: 788, w: 92, h: 15, text: "v worktree" },
    { x: 547, y: 839, w: 366, h: 25, text: FIELD },
  ];

  it("finds the folder chip, the branch word and the option's box on the real row", () => {
    const targets = chipTargets(R8);
    expect(targets.folder).toMatchObject({ text: "nuria-platform", x: 719 });
    expect(targets.branch?.text).toBe("main");
    expect(targets.worktree?.text).toBe("v");
    for (const target of [targets.folder!, targets.branch!, targets.worktree!]) {
      expect(R8.some((line) => target.x >= line.x && target.x <= line.x + line.w && Math.abs(target.y - (line.y + line.h / 2)) <= 2)).toBe(true);
    }
  });

  it("finds them in a row OCR read as one line, and the folder chip on its own line above the field", () => {
    const one = chipTargets([{ x: 540, y: 788, w: 440, h: 16, text: "• Local nuria-platform g9 - |O worktree" }]);
    expect(one.folder?.text).toBe("nuria-platform");
    expect(one.branch?.text).toBe("g9");
    expect(one.worktree?.text).toBe("|O");
    const apart = chipTargets([{ x: 600, y: 730, w: 200, h: 16, text: "• outra-pasta" }, { x: 600, y: 790, w: 200, h: 16, text: "|O worktree" }, { x: 600, y: 820, w: 300, h: 16, text: FIELD }]);
    expect(apart.folder?.text).toBe("• outra-pasta");
    expect(apart.branch).toBeNull();
  });

  it("places each word of a line where it is", () => {
    const [first, second] = wordsAt([{ x: 100, y: 10, w: 100, h: 10, text: "abcd efgh" }]);
    expect(first!.x).toBeLessThan(150);
    expect(second!.x).toBeGreaterThan(150);
  });

  it("takes as opened only the lines a click added", () => {
    const before: OcrLine[] = [{ x: 600, y: 788, w: 100, h: 16, text: "nuria-platform" }];
    const after: OcrLine[] = [...before, { x: 660, y: 520, w: 100, h: 16, text: "~/Projetos/soph-ia" }];
    expect(newLines(before, after).map((line) => line.text)).toEqual(["~/Projetos/soph-ia"]);
  });

  it("picks only one item that names the folder: by word, by path, never a near name", () => {
    const line = (text: string, y = 0): OcrLine => ({ x: 660, y, w: 200, h: 16, text });
    expect(pickerItem([line("~/Projetos/nuria-platform-old"), line("soph-ia", 30)], "nuria-platform")).toBeNull();
    expect(pickerItem([line("~/Projetos/nuria-platform")], "nuria-platform")?.text).toBe("~/Projetos/nuria-platform");
    // the same name in two places: the one under the expected path
    const two = [line("~/Clientes/nuria-platform"), line("~/Projetos/nuria-platform", 30)];
    expect(pickerItem(two, "nuria-platform", { path: "/Users/o/Projetos/nuria-platform" })?.y).toBe(30);
    expect(pickerItem(two, "nuria-platform")).toBeNull();
    // a branch named like the folder is not a path to it
    expect(pickerItem([line(`omb/${OURS}`)], OURS)).toBeNull();
  });
});
