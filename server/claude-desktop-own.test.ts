import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_BUNDLE_ID,
  DESKTOP_BRIEF_NOTE,
  findDesktopSession,
  lastAppRepo,
  lastAppWorktreeFolder,
  lastServerSessionInRoot,
  newSessionInFolderUrl,
  openDesktopSessionIn,
  readDesktopRecord,
  recordsUsingFolder,
  showsFolderName,
  worktreeOption,
  editDistance,
  notRepoRoot,
  rootFolderRefusal,
  trustPrompt,
  createDesktopSession,
  type DesktopDriver,
  type OcrLine,
} from "./claude-desktop.ts";

// Lote X on the screen: a new app session opened by the app's own link in
// the folder the server made, and the app's records of it read back as the
// worktree itself, whatever alias the app was handed.

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });

const FOLDER = "9353-comprar-assentos";
const LINK = `/Users/o/Projetos/.omb-worktree-links/nuria-platform/${FOLDER}`;

/** A fake app: each OCR shows the next screen (the last one stays). */
function fakeApp(screens: string[][], opts: { idle?: number; front?: string } = {}) {
  const actions: string[] = [];
  const queue = screens.map((lines) => lines.map((text, i): OcrLine => ({ x: 600, y: 700 + i * 30, w: 200, h: 16, text })));
  const driver: DesktopDriver = {
    idleSeconds: async () => opts.idle ?? 120,
    frontmost: async () => opts.front ?? CLAUDE_BUNDLE_ID,
    locked: async () => false,
    screenSize: async () => ({ w: 1_470, h: 923 }),
    ocr: async () => (queue.length > 1 ? queue.shift()! : queue[0]!),
    click: async (x, y) => { actions.push(`click ${x},${y}`); },
    rightClick: async () => {},
    key: async (code) => { actions.push(`key ${code}`); },
    paste: async (text) => { actions.push(`paste ${text.slice(0, 20)}`); },
    typeText: async (text) => { actions.push(`type ${text}`); },
    menuNewSession: async () => { actions.push("menu new session"); },
    openUrl: async (url) => { actions.push(`open ${url}`); },
    activateClaude: async () => { actions.push("activate"); },
    activate: async () => {},
    sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); },
  };
  return { driver, actions };
}

// the worktree option OFF, as OCR read the box on 03/10 ("|O worktree")
const NEW_IN_FOLDER = ["• Local", FOLDER, "gº omb/9353-comprar-assentos", "|O worktree", "Descreva uma tarefa ou faça uma pergunta", "+ O v Ignorar permissões"];
const SENT = ["Vou começar pelo Passo 0.", "Responder…", "+ O v Ignorar permissões"];

// The 20 screens the old barrier stopped on, 03/10 12Z–14Z (server.log, "the
// screen showed: …", lines joined by " | "), with how many times each.
const REAL_0310: Array<[string, number]> = [
  ["• Local | nuria-platform | g9 - |O worktree | G | Descreva uma tarefa ou faça uma pergunta | + O v Ignorar permissões | Opus 5.5 | Médio", 17],
  ["q9 - | | worktree | Terminal | Descreva uma tarefa ou faca uma pergunta | * | Opus 5.5 | Médio | C", 1],
  ["nuria-platform | g9 - |O worktree | G | Descreva uma tarefa ou faça uma pergunta | + O v Ignorar permissões | Opus 5.5 | Médio | C", 1],
  ["• Local | • nuria-platform | q - |П worktree | Descreva uma tarefa ou faça uma pergunta | + O v Ignorar permissões | G | Opus 5.5 | Médio", 1],
];
/** One screen as OCR lines: the chips on one row (y 788), the field and the bar below. */
const screenOf = (seen: string): OcrLine[] => seen.split(" | ").map((text, i, all) => {
  const chips = all.findIndex((each) => /worktree/i.test(each));
  return { x: 540 + i * 60, y: i <= chips ? 788 : 840 + i * 10, w: 60, h: 16, text };
});

describe("the 20 real readings of 03/10 (R12-1, R11-2)", () => {
  it("are 20 screens", () => {
    expect(REAL_0310.reduce((sum, [, count]) => sum + count, 0)).toBe(20);
  });

  it("read the worktree box as OFF in all 20 — \"|O\", the Cyrillic \"П\" and the bare edges \"| |\"", () => {
    for (const [seen, count] of REAL_0310) {
      const option = worktreeOption(screenOf(seen).filter((line) => line.y === 788));
      expect({ seen, option }).toEqual({ seen, option: "off" });
      expect(count).toBeGreaterThan(0);
    }
    const line = (text: string): OcrLine => ({ x: 885, y: 788, w: 92, h: 15, text });
    expect(worktreeOption([line("| | worktree")])).toBe("off");
    expect(worktreeOption([line("|п worktree")])).toBe("off");
    expect(worktreeOption([line("q - worktree")])).toBe("unknown");
  });

  it("take the unreadable branch chip (\"g9 -\", \"q9 -\", \"q -\") as the base only when git says the root is on it", () => {
    for (const [seen] of REAL_0310) {
      const lines = screenOf(seen);
      expect(notRepoRoot(lines, "main", { rootBranch: "main", branches: ["main", "fix/9326-x"] })).toBeNull();
      expect(notRepoRoot(lines, "main", { rootBranch: "HEAD" })).toMatch(/^it does not show the base branch main: its branch chip could not be read \(it shows "[gq]9? -"\) and the repository root is on HEAD$/);
    }
    // before R11-2 every one of them was refused
    expect(notRepoRoot(screenOf(REAL_0310[0]![0]), "main")).toContain("could not be read");
  });

  it("read the branch word with one OCR slip as the base, never another branch of the repository", () => {
    const chips = (branch: string) => [{ x: 540, y: 788, w: 60, h: 16, text: "• Local" }, { x: 660, y: 788, w: 60, h: 16, text: "nuria-platform" }, { x: 801, y: 788, w: 60, h: 16, text: `gº ${branch}` }, { x: 885, y: 788, w: 92, h: 15, text: "|O worktree" }];
    expect(notRepoRoot(chips("main"), "main")).toBeNull();
    expect(notRepoRoot(chips("maln"), "main")).toBeNull();
    expect(notRepoRoot(chips("mai"), "main")).toBeNull();
    // a branch the repository has, one slip from the base too: it is that branch, not the base
    expect(notRepoRoot(chips("mail"), "main", { branches: ["main", "mail"] })).toBe("it shows mail, not main");
    expect(notRepoRoot(chips("develop"), "main", { rootBranch: "main" })).toBe("it shows develop, not main");
    expect(notRepoRoot(chips("fix/9326-x"), "main", { rootBranch: "main" })).toBe("it shows fix/9326-x, not main");
    expect(editDistance("g9", "main")).toBe(4);
    expect(editDistance("maln", "main")).toBe(1);
  });
});

describe("the old way's texts where the server makes the worktrees (R12-1)", () => {
  it("never ask to turn the worktree option on", () => {
    const refusal = rootFolderRefusal({ folder: "/r/nuria-platform", title: "9311 x" }, "nuria-platform", false, true);
    expect(refusal).not.toMatch(/LIGAR|LIGUE|ligue/);
    expect(refusal).toContain("a opção worktree tem de ficar DESLIGADA: não peça ao dono para ligá-la");
    // without the server's worktrees the old gesture stays as it was
    expect(rootFolderRefusal({ folder: "/r/nuria-platform" }, "nuria-platform")).toContain("LIGAR a opção worktree");
  });
});

// #9378, 05/10 12:59–13:03 (R12-visual N20): the screen the app showed for
// the server's first real create through its own worktree, as the log has it.
const REAL_9378 = "Confiar no workspace | • Local | • 9378-supervisor-do-ate…. | 2º omb/9378-supervisor-do-aten... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Ignorar permissões | Opus 5.5 | Médio";
const FOLDER_9378 = "9378-supervisor-do-atendimento";
/** The real line as OCR lines: the prompt on top, the chips on one row, the field and the bar below. */
const screen9378 = (withPrompt = true): string[] => REAL_9378.split(" | ").filter((text) => withPrompt || !text.startsWith("Confiar"));

describe("the real screen of #9378 (R12-visual N20)", () => {
  const line = (text: string): OcrLine => ({ x: 600, y: 800, w: 200, h: 16, text });
  it("reads the folder chip cut short with a stray dot after the ellipsis, and the box \"1O\" as off", () => {
    expect(showsFolderName([line("• 9378-supervisor-do-ate….")], FOLDER_9378)).toBe(true);
    expect(showsFolderName([line("9378-supervisor-do-ate…,")], FOLDER_9378)).toBe(true);
    expect(showsFolderName([line("9378-supervisor-do-ate...")], FOLDER_9378)).toBe(true);
    // a cut that does not start the folder's name is not it
    expect(showsFolderName([line("9379-supervisor-do-ate….")], FOLDER_9378)).toBe(false);
    expect(worktreeOption([line("2º omb/9378-supervisor-do-aten... 1O worktree")])).toBe("off");
    expect(trustPrompt(REAL_9378.split(" | ").map(line))?.text).toBe("Confiar no workspace");
  });

  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  /** The server's worktree of #9378 and the alias the app is given, for real (the trust check reads real paths). */
  const ownFolder = () => {
    const root = mkdtempSync(join(tmpdir(), "omb-trust-"));
    dirs.push(root);
    const worktree = join(root, "nuria-platform", ".claude", "worktrees", FOLDER_9378);
    mkdirSync(worktree, { recursive: true });
    const alias = join(root, ".omb-worktree-links", "nuria-platform", FOLDER_9378);
    mkdirSync(join(alias, ".."), { recursive: true });
    symlinkSync(worktree, alias);
    return { worktree, alias };
  };

  it("trusts the workspace by clicking its prompt only because the folder is the server's own worktree, then pastes", async () => {
    const { worktree, alias } = ownFolder();
    const app = fakeApp([screen9378(true), screen9378(false), SENT]);
    const step = await openDesktopSessionIn(app.driver, { folder: alias, folderName: FOLDER_9378, text: "9378 Supervisor\n[OMBX]\n\nPasso 0…", expected: worktree });
    expect(step).toEqual({ ok: true });
    // the prompt (1st line, y 700) clicked, then the field, then the paste
    expect(app.actions[1]).toBe("click 700,708");
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(true);
  });

  it("clicks nothing in a folder that is not the server's worktree: the person is asked (trustNeeded)", async () => {
    const { alias } = ownFolder();
    for (const expected of [undefined, "/Users/o/Projetos/outro"]) {
      const app = fakeApp([screen9378(true)]);
      const step = await openDesktopSessionIn(app.driver, { folder: alias, folderName: FOLDER_9378, text: "brief", ...(expected ? { expected } : {}) });
      expect(step).toMatchObject({ ok: false, retry: true, trustNeeded: alias });
      expect(app.actions.some((action) => action.startsWith("click") || action.startsWith("paste"))).toBe(false);
    }
  });

  it("stops without typing when the prompt stays after the click (a miss)", async () => {
    const { worktree, alias } = ownFolder();
    const app = fakeApp([screen9378(true)]);
    const step = await openDesktopSessionIn(app.driver, { folder: alias, folderName: FOLDER_9378, text: "brief", expected: worktree });
    expect(step).toMatchObject({ ok: false, miss: true });
    expect(!step.ok && step.reason).toContain("still asks to trust the workspace");
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
  });

  it("never trusts in the old way (New Session in the repository): the person is asked", async () => {
    const app = fakeApp([["Sessão antiga v (nuria-platform"], ["Confiar no workspace", "• Local", "nuria-platform", "gº main", "|O worktree", "Descreva uma tarefa ou faça uma pergunta"]]);
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "brief" });
    expect(step).toMatchObject({ ok: false, trustNeeded: "nuria-platform" });
    expect(app.actions.some((action) => action.startsWith("click") || action.startsWith("paste"))).toBe(false);
  });
});

describe("a new session in the server's own folder", () => {
  it("is opened by the app's link with the alias, and the brief goes in once the empty field and the folder's chip show", async () => {
    const app = fakeApp([NEW_IN_FOLDER, SENT]);
    const step = await openDesktopSessionIn(app.driver, { folder: LINK, folderName: FOLDER, text: "9353 Comprar assentos\n[OMBX]\n\nPasso 0…" });
    expect(step).toEqual({ ok: true });
    expect(app.actions[0]).toBe(`open claude://code/new?folder=${encodeURIComponent(LINK)}`);
    expect(newSessionInFolderUrl("/a b/c")).toBe("claude://code/new?folder=%2Fa%20b%2Fc");
    // never New Session from the menu, never the root session anchor
    expect(app.actions).not.toContain("menu new session");
    expect(app.actions.filter((action) => action.startsWith("open "))).toHaveLength(1);
    expect(app.actions).toContain(`type  ${DESKTOP_BRIEF_NOTE}`);
    expect(app.actions.at(-1)).toBe("key 36");
  });

  it("types nothing when the link did not open a new session (no empty task field): a miss", async () => {
    const app = fakeApp([["Sessão antiga v (nuria-platform", "Responder…", "+ O v Ignorar permissões"]]);
    const step = await openDesktopSessionIn(app.driver, { folder: LINK, folderName: FOLDER, text: "brief" });
    expect(step).toMatchObject({ ok: false, retry: true, miss: true, touched: true });
    expect(!step.ok && step.reason).toContain("did not open a new session for 9353-comprar-assentos");
    expect(app.actions.some((action) => action.startsWith("paste") || action.startsWith("click"))).toBe(false);
  });

  it("types nothing when the new session shows another folder (the app mapped the link to the root): a miss", async () => {
    const root = ["• Local", "nuria-platform", "gº main", "v worktree", "Descreva uma tarefa ou faça uma pergunta", "+ O v Ignorar permissões"];
    const app = fakeApp([root]);
    const step = await openDesktopSessionIn(app.driver, { folder: LINK, folderName: FOLDER, text: "brief" });
    expect(step).toMatchObject({ ok: false, miss: true });
    expect(!step.ok && step.reason).toContain("does not show the folder 9353-comprar-assentos");
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
  });

  it.each([
    ["ON (the tick, as on R8-visual-claude-1: \"v worktree\")", "v worktree", "has the worktree option ON"],
    ["unreadable", "? worktree", "could not read whether the new session's worktree option is on or off"],
  ])("pastes nothing when the worktree option is %s: a miss, before the brief goes in (R11-1)", async (_name, chip, said) => {
    const app = fakeApp([NEW_IN_FOLDER.map((line) => (line === "|O worktree" ? chip : line))]);
    const step = await openDesktopSessionIn(app.driver, { folder: LINK, folderName: FOLDER, text: "brief" });
    expect(step).toMatchObject({ ok: false, retry: true, miss: true, touched: true });
    expect(!step.ok && step.reason).toContain(said);
    expect(!step.ok && step.reason).toContain("nothing was typed");
    expect(app.actions.some((action) => action.startsWith("paste") || action.startsWith("click") || action.startsWith("type"))).toBe(false);
  });

  it("goes on when the new session shows no worktree option at all (nothing the app could make)", async () => {
    const app = fakeApp([NEW_IN_FOLDER.filter((line) => line !== "|O worktree"), SENT]);
    expect(await openDesktopSessionIn(app.driver, { folder: LINK, folderName: FOLDER, text: "brief" })).toEqual({ ok: true });
  });

  it("reads the worktree option's box as OCR draws it", () => {
    const line = (text: string): OcrLine => ({ x: 885, y: 788, w: 92, h: 15, text });
    expect(worktreeOption([line("v worktree")])).toBe("on");
    expect(worktreeOption([line("✓ worktree")])).toBe("on");
    expect(worktreeOption([line("|O worktree")])).toBe("off");
    expect(worktreeOption([line("□ worktree")])).toBe("off");
    expect(worktreeOption([line("worktree")])).toBe("unknown");
    expect(worktreeOption([line("nuria-platform")])).toBeNull();
  });

  it("stops before touching anything when the person is using the Mac", async () => {
    const app = fakeApp([NEW_IN_FOLDER], { idle: 1 });
    const step = await openDesktopSessionIn(app.driver, { folder: LINK, folderName: FOLDER, text: "brief" });
    expect(step).toMatchObject({ ok: false, retry: true });
    expect(app.actions).toEqual([]);
  });

  it("refuses a folder that is not a path", async () => {
    const app = fakeApp([NEW_IN_FOLDER]);
    expect(await openDesktopSessionIn(app.driver, { folder: "relative/x", folderName: FOLDER, text: "b" })).toMatchObject({ ok: false, retry: false });
    expect(app.actions).toEqual([]);
  });

  it("reads the folder's name in the chips, also cut short by the app", () => {
    const line = (text: string): OcrLine => ({ x: 600, y: 800, w: 100, h: 16, text });
    expect(showsFolderName([line(`(${FOLDER}`)], FOLDER)).toBe(true);
    expect(showsFolderName([line("9353-comprar-assen…")], FOLDER)).toBe(true);
    expect(showsFolderName([line("9353-co…")], FOLDER)).toBe(false);
    expect(showsFolderName([line("nuria-platform")], FOLDER)).toBe(false);
  });
});

describe("the app's records of a session opened through the alias", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("name the worktree itself, so adoption, reuse, root and repository checks see the real folder", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-own-rec-"));
    dirs.push(home);
    const repo = join(home, "Projetos", "nuria-platform");
    const worktree = join(repo, ".claude", "worktrees", FOLDER);
    mkdirSync(worktree, { recursive: true });
    const link = join(home, "Projetos", ".omb-worktree-links", "nuria-platform", FOLDER);
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(worktree, link);
    const sessions = join(home, "sessions");
    const projects = join(home, "projects");
    mkdirSync(join(sessions, "org", "acct"), { recursive: true });
    mkdirSync(join(projects, "p"), { recursive: true });
    const local = "local_0a000009-0000-4000-8000-000000000000";
    writeFileSync(join(sessions, "org", "acct", `${local}.json`), JSON.stringify({ sessionId: local, cliSessionId: "cli-9", cwd: link, originCwd: link, createdAt: Date.parse("2026-10-04T13:00:00Z"), title: "9353 Comprar assentos" }));
    writeFileSync(join(projects, "p", "cli-9.jsonl"), `${JSON.stringify({ type: "user", message: { content: "[OMBMARK123]" } })}\n`);

    expect(readDesktopRecord(local, sessions)?.cwd).toBe(worktree);
    expect(findDesktopSession("OMBMARK123", 0, sessions, projects)?.cwd).toBe(worktree);
    expect(lastAppRepo(sessions)).toBe(repo);
    // a worktree nobody used before: no reuse, and it is not the root
    expect(lastAppWorktreeFolder(sessions)).toBeNull();
    expect(lastServerSessionInRoot(new Set([local]), sessions)).toBeNull();
    expect(recordsUsingFolder(worktree, undefined, sessions, true).map((record) => record.sessionId)).toEqual([local]);
  });
});
