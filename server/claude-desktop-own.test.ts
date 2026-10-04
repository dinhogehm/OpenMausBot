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
