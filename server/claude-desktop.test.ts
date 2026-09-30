import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveDesktopSession,
  CLAUDE_BUNDLE_ID,
  createDesktopSession,
  DESKTOP_BRIEF_NOTE,
  DESKTOP_MESSAGE_NOTE,
  findDesktopSession,
  lastAssistantText,
  newMarker,
  parseOcr,
  readDesktopRecord,
  recordBlocked,
  recordInWorktree,
  sendToDesktopSession,
  sidebarMatch,
  transcriptMentions,
  transcriptWrittenAt,
  type DesktopDriver,
  type OcrLine,
} from "./claude-desktop.ts";

// Fake clock: the screen steps compare the person's input with their own.
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });

type ScreenLine = string | { text: string; x?: number; y?: number };

/** A fake Claude app: records what the automation did to the screen. Each
 * OCR call shows the next screen (the last one stays); a plain string is a
 * line of the main area, `{ x }` places it (x < 450 is the sidebar). */
function fakeApp(opts: { idle?: number | number[]; fronts?: string[]; screen?: ScreenLine[]; screens?: ScreenLine[][]; locked?: boolean } = {}) {
  const actions: string[] = [];
  const fronts = [...(opts.fronts ?? [])];
  const idles = Array.isArray(opts.idle) ? [...opts.idle] : [opts.idle ?? 120];
  const toLines = (screen: ScreenLine[]): OcrLine[] => screen.map((line, i) => {
    const spec = typeof line === "string" ? { text: line } : line;
    return { x: spec.x ?? 600, y: spec.y ?? 500 + i * 20, w: 200, h: 16, text: spec.text };
  });
  const screens = (opts.screens ?? [opts.screen ?? []]).map(toLines);
  const driver: DesktopDriver = {
    idleSeconds: async () => (idles.length > 1 ? idles.shift()! : idles[0]!),
    frontmost: async () => (fronts.length > 1 ? fronts.shift()! : fronts[0] ?? CLAUDE_BUNDLE_ID),
    locked: async () => opts.locked ?? false,
    screenSize: async () => ({ w: 1_440, h: 900 }),
    ocr: async () => (screens.length > 1 ? screens.shift()! : screens[0]!),
    click: async (x, y) => { actions.push(`click ${x},${y}`); },
    rightClick: async (x, y) => { actions.push(`rclick ${x},${y}`); },
    key: async (code, command) => { actions.push(`key ${code}${command ? "+cmd" : ""}`); },
    paste: async (text, selectAll) => { actions.push(`paste${selectAll ? "(all)" : ""} ${text}`); },
    menuNewSession: async () => { actions.push("menu new session"); },
    openUrl: async (url) => { actions.push(`open ${url}`); },
    activateClaude: async () => { actions.push("activate"); },
    activate: async (bundleId) => { actions.push(`restore ${bundleId}`); },
    // Time passes while the automation waits, as it does on a real Mac.
    sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); },
  };
  return { driver, actions };
}

const REPO_SCREEN = [{ text: "Local", x: 100 }, "nuria-platform", "main", "worktree"];
const TERMINAL = "com.apple.Terminal";

describe("createDesktopSession", () => {
  it("opens a new session in the repository, pastes the brief with a note of its own and sends it", async () => {
    const app = fakeApp({ screen: REPO_SCREEN });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "[OMBX] brief" })).toEqual({ ok: true });
    expect(app.actions).toEqual(["activate", "menu new session", "paste(all) [OMBX] brief", `paste  ${DESKTOP_BRIEF_NOTE}`, "key 36"]);
  });

  it("waits while the person is using the Mac", async () => {
    const app = fakeApp({ idle: 2, screen: REPO_SCREEN });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: true });
    expect(app.actions).toEqual([]);
  });

  it("waits while the screen is locked or asleep, without touching it", async () => {
    const app = fakeApp({ locked: true, screen: REPO_SCREEN });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" })).toMatchObject({ ok: false, retry: true, reason: expect.stringContaining("locked") });
    expect(app.actions).toEqual([]);
  });

  it("stops before any keystroke if another app takes the front, and does not steal it back", async () => {
    const app = fakeApp({ fronts: [TERMINAL, CLAUDE_BUNDLE_ID, CLAUDE_BUNDLE_ID, TERMINAL], screen: REPO_SCREEN });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: true, touched: true, reason: expect.stringContaining(TERMINAL) });
    expect(app.actions.some((action) => action.startsWith("key") || action.startsWith("paste"))).toBe(false);
    expect(app.actions.some((action) => action.startsWith("restore"))).toBe(false);
  });

  it("aborts when the person touches the Mac mid-step (input newer than our own)", async () => {
    // idle: ready check, step start, then a fresh input (0.1s) at the paste guard
    const app = fakeApp({ idle: [120, 120, 120, 120, 0.1], screen: REPO_SCREEN });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: true, human: true });
    expect(app.actions).toEqual(["activate", "menu new session"]);
  });

  it("gives the front back to the app the person had open", async () => {
    const app = fakeApp({ fronts: [TERMINAL, CLAUDE_BUNDLE_ID], screen: REPO_SCREEN });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" })).toEqual({ ok: true });
    expect(app.actions.at(-1)).toBe(`restore ${TERMINAL}`);
  });

  it("treats a new session opened in another folder as a miss to retry, not a failure", async () => {
    const app = fakeApp({ screen: [{ text: "Local", x: 100 }, "soph-ia", "main", "worktree"] });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: true, miss: true });
    expect(app.actions).toEqual(["activate", "menu new session"]);
  });

  it("does not take the repository name from the sidebar", async () => {
    const app = fakeApp({ screen: [{ text: "nuria-platform", x: 100 }, "soph-ia", "worktree"] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" })).toMatchObject({ ok: false, miss: true });
  });
});

describe("sendToDesktopSession", () => {
  const localId = "local_6415ced5-d3d5-4055-9d33-58c585c87de3";
  const open = { text: "Automação inatividade não dispara", y: 60 };
  const field = { text: "Responder...", y: 820 };

  it("reopens the session, checks its title, types into its field and sees the field empty again", async () => {
    const app = fakeApp({ screens: [[open, field], [open, { text: "follow-up now", y: 820 }], [open, { text: "follow-up now", y: 400 }, field]] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "follow-up now", title: "Automação inatividade não dispara" })).toEqual({ ok: true });
    expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`, "click 620,828", "paste(all) follow-up now", "key 36"]);
  });

  it("does not type into another session", async () => {
    const app = fakeApp({ screen: [{ text: "Teste modo app", y: 60 }, field] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "y", title: "Automação inatividade não dispara" })).toMatchObject({ ok: false, retry: true, miss: true });
    expect(app.actions.some((action) => action.startsWith("paste") || action.startsWith("key") || action.startsWith("click"))).toBe(false);
  });

  it("ignores reply-like words in the conversation or the sidebar", async () => {
    const app = fakeApp({ screen: [open, { text: "Reply to the customer in the thread", y: 300 }, { text: "Responder", x: 100, y: 850 }] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "y", title: open.text })).toMatchObject({ ok: false, retry: true });
    expect(app.actions.some((action) => action.startsWith("paste") || action.startsWith("key"))).toBe(false);
  });

  it("does not press Return when the text did not reach the field", async () => {
    const app = fakeApp({ screens: [[open, field], [open, field]] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "follow-up now", title: open.text })).toMatchObject({ ok: false, retry: true });
    expect(app.actions.some((action) => action.startsWith("key"))).toBe(false);
  });

  it("retries when the text is still in the field after Return", async () => {
    const typed = { text: "follow-up now", y: 820 };
    const app = fakeApp({ screens: [[open, field], [open, typed], [open, typed]] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "follow-up now", title: open.text })).toMatchObject({ ok: false, retry: true, reason: expect.stringContaining("stayed") });
  });

  it("adds a line of its own after a long message", async () => {
    const long = `Long steer ${"x".repeat(900)}`;
    const app = fakeApp({ screens: [[open, field], [open, { text: "Long steer xxxx", y: 820 }], [open, field]] });
    expect(await sendToDesktopSession(app.driver, { localId, text: long, title: open.text })).toEqual({ ok: true });
    expect(app.actions).toContain(`paste  ${DESKTOP_MESSAGE_NOTE}`);
  });

  it("refuses an id that is not the app's", async () => {
    const app = fakeApp();
    expect(await sendToDesktopSession(app.driver, { localId: "../../x", text: "y" })).toMatchObject({ ok: false, retry: false });
    expect(app.actions).toEqual([]);
  });

  it("does not type anywhere when the field is not on screen", async () => {
    const app = fakeApp({ screen: ["Bem-vindo de volta"] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "y" })).toMatchObject({ ok: false, retry: true });
    expect(app.actions.some((action) => action.startsWith("paste") || action.startsWith("key"))).toBe(false);
  });
});

describe("reading the app's records", () => {
  let root: string;
  let records: string;
  let projects: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-desktop-"));
    records = join(root, "sessions", "org", "account");
    projects = join(root, "projects");
    mkdirSync(records, { recursive: true });
    mkdirSync(join(projects, "-repo-wt"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (id: string, cli: string, createdAt: number, extra: object = {}) =>
    writeFileSync(join(records, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: cli, createdAt, cwd: "/repo/wt", ...extra }));
  const transcript = (cli: string, lines: object[]) =>
    writeFileSync(join(projects, "-repo-wt", `${cli}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

  it("finds the session carrying the marker, only among new ones", () => {
    const marker = newMarker();
    write("local_old", "cli-old", 1_000);
    transcript("cli-old", [{ type: "user", message: { content: `[${marker}] old` } }]);
    write("local_new", "cli-new", 5_000);
    transcript("cli-new", [{ type: "user", message: { content: `[${marker}] brief` } }]);
    expect(findDesktopSession(marker, 4_000, join(root, "sessions"), projects)?.sessionId).toBe("local_new");
    expect(findDesktopSession("OMBNOPE", 0, join(root, "sessions"), projects)).toBeNull();
    expect(readDesktopRecord("local_new", join(root, "sessions"))?.cliSessionId).toBe("cli-new");
  });

  it("reads the session's last reply", () => {
    transcript("cli", [
      { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
      { type: "user", message: { content: "more" } },
      { type: "assistant", message: { content: [{ type: "text", text: "PR #9286 open" }, { type: "tool_use" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use" }] } },
    ]);
    expect(lastAssistantText(join(projects, "-repo-wt", "cli.jsonl"))).toBe("PR #9286 open");
  });

  it("reads the fields that follow a session: mode, worktree, last user message, blocked turn", () => {
    write("local_rich", "cli-rich", 5_000, {
      createdAt: "2026-09-29T19:34:57.000Z",
      latestUserFrameAt: 1_790_000_000,
      permissionMode: "bypassPermissions",
      worktreePath: "/repo/.claude/worktrees/x",
      postTurnSummary: { status_category: "blocked", needs_action: "approve gh issue comment" },
    });
    const record = readDesktopRecord("local_rich", join(root, "sessions"))!;
    expect(record.createdAt).toBe(Date.parse("2026-09-29T19:34:57.000Z"));
    expect(record.latestUserFrameAt).toBe(1_790_000_000_000);
    expect(record.permissionMode).toBe("bypassPermissions");
    expect(recordBlocked(record)).toBe("approve gh issue comment");
    expect(recordInWorktree(record)).toBe(true);
    expect(recordInWorktree({ cwd: "/Users/o/Projetos/nuria-platform" })).toBe(false);
    expect(recordInWorktree({ cwd: "/Users/o/Projetos/nuria-platform/.claude/worktrees/fix-1" })).toBe(true);
    expect(recordBlocked({ postTurnSummary: { status_category: "done" } })).toBeNull();
  });

  it("tells whether a message reached the transcript, and when it was last written", () => {
    transcript("cli-m", [{ type: "user", message: { content: "Conferi o c445f4459 na branch local\nFique parada" } }]);
    const path = join(projects, "-repo-wt", "cli-m.jsonl");
    expect(transcriptMentions(path, "Conferi o c445f4459 na branch local\nFique parada")).toBe(true);
    expect(transcriptMentions(path, "Outra mensagem")).toBe(false);
    expect(transcriptWrittenAt(path)).toBeGreaterThan(0);
    expect(transcriptWrittenAt(join(projects, "nope.jsonl"))).toBeNull();
  });

});

describe("helpers", () => {
  it("parses the helper's OCR lines and makes OCR-safe markers", () => {
    expect(parseOcr("996 794 457 38 | Confiar neste workspace?\nlixo\n")).toEqual([{ x: 996, y: 794, w: 457, h: 38, text: "Confiar neste workspace?" }]);
    expect(newMarker()).toMatch(/^OMB[A-HJ-NP-Z2-9]{7}$/);
  });
});

describe("archiveDesktopSession", () => {
  const localId = "local_cdf10d09-8c6a-493d-9ceb-5f50fc2e2e5b";
  it("opens the session, right-clicks its sidebar entry and picks Arquivar", async () => {
    const app = fakeApp({ screen: [{ text: "Automação inatividade não disp…", x: 100 }, { text: "Fixar", x: 100 }, { text: "Arquivar", x: 100 }] });
    expect(await archiveDesktopSession(app.driver, { localId, title: "Automação inatividade não dispara" })).toEqual({ ok: true });
    expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`, "rclick 130,508", "click 200,548"]);
  });

  it("closes the menu instead of clicking blind when Arquivar is missing", async () => {
    const app = fakeApp({ screen: [{ text: "Teste modo app", x: 100 }, { text: "Fixar", x: 100 }] });
    expect(await archiveDesktopSession(app.driver, { localId, title: "Teste modo app" })).toMatchObject({ ok: false, retry: true });
    expect(app.actions.at(-1)).toBe("key 53");
  });

  it("matches truncated sidebar titles, not unrelated ones", () => {
    expect(sidebarMatch("Automação inatividade não disp…", "Automação inatividade não dispara")).toBe(true);
    expect(sidebarMatch("Teste modo app", "Teste modo app")).toBe(true);
    expect(sidebarMatch("Teste", "Teste modo app")).toBe(false);
    expect(sidebarMatch("Transfer N2 sem agente", "Teste modo app")).toBe(false);
  });
});
