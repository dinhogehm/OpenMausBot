import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveDesktopSession,
  CLAUDE_BUNDLE_ID,
  lastAppRepo,
  recordsUsingFolder,
  renameDesktopSession,
  transcriptOpenQuestion,
  createDesktopSession,
  DESKTOP_BRIEF_NOTE,
  DESKTOP_MESSAGE_NOTE,
  findDesktopSession,
  headerNames,
  lastAssistantText,
  newMarker,
  parseOcr,
  readDesktopRecord,
  recordBlocked,
  recordInWorktree,
  sendToDesktopSession,
  showsFolder,
  sidebarMatch,
  summaryIsCurrent,
  transcriptMentions,
  transcriptTurnEnded,
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
    typeText: async (text) => { actions.push(`type ${text}`); },
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
/** The session that was open before New Session: another screen entirely. */
const OPEN_SESSION = [{ text: "• Automação inatividade não dispara v (nuria-platform", y: 60 }, { text: "Os represados saem sozinhos depois do deploy?", y: 150 }];
const TERMINAL = "com.apple.Terminal";

describe("createDesktopSession", () => {
  it("opens a new session in the repository, pastes the brief with a note of its own and sends it", async () => {
    const app = fakeApp({ screens: [OPEN_SESSION, REPO_SCREEN] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "[OMBX] brief" })).toEqual({ ok: true });
    expect(app.actions).toEqual(["activate", "menu new session", "paste(all) [OMBX] brief", `type  ${DESKTOP_BRIEF_NOTE}`, "key 36"]);
  });

  it("waits while the person is using the Mac", async () => {
    const app = fakeApp({ idle: 2, screens: [OPEN_SESSION, REPO_SCREEN] });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: true });
    expect(app.actions).toEqual([]);
  });

  it("waits while the screen is locked or asleep, without touching it", async () => {
    const app = fakeApp({ locked: true, screens: [OPEN_SESSION, REPO_SCREEN] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" })).toMatchObject({ ok: false, retry: true, reason: expect.stringContaining("locked") });
    expect(app.actions).toEqual([]);
  });

  it("stops before any keystroke if another app takes the front, and does not steal it back", async () => {
    const app = fakeApp({ fronts: [TERMINAL, CLAUDE_BUNDLE_ID, CLAUDE_BUNDLE_ID, TERMINAL], screens: [OPEN_SESSION, REPO_SCREEN] });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: true, touched: true, reason: expect.stringContaining(TERMINAL) });
    expect(app.actions.some((action) => action.startsWith("key") || action.startsWith("paste"))).toBe(false);
    expect(app.actions.some((action) => action.startsWith("restore"))).toBe(false);
  });

  it("aborts when the person touches the Mac mid-step (input newer than our own)", async () => {
    // idle: ready check, step start, then a fresh input (0.1s) at the paste guard
    const app = fakeApp({ idle: [120, 120, 120, 120, 0.1], screens: [OPEN_SESSION, REPO_SCREEN] });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: true, human: true });
    expect(app.actions).toEqual(["activate", "menu new session"]);
  });

  it("gives the front back to the app the person had open", async () => {
    const app = fakeApp({ fronts: [TERMINAL, CLAUDE_BUNDLE_ID], screens: [OPEN_SESSION, REPO_SCREEN] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" })).toEqual({ ok: true });
    expect(app.actions.at(-1)).toBe(`restore ${TERMINAL}`);
  });

  it("treats a new session opened in another folder as a miss to retry, not a failure", async () => {
    const app = fakeApp({ screens: [OPEN_SESSION, [{ text: "Local", x: 100 }, "soph-ia", "main", "worktree"]] });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: true, miss: true });
    expect(app.actions).toEqual(["activate", "menu new session"]);
  });

  it("never pastes when New Session did not open (the open session's screen stays)", async () => {
    const app = fakeApp({ screens: [[...OPEN_SESSION, { text: "nuria-platform main", y: 815 }, { text: "worktree", x: 700, y: 815 }]] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "brief" })).toMatchObject({ ok: false, miss: true, reason: expect.stringContaining("did not open") });
    expect(app.actions.some((action) => action.startsWith("paste") || action.startsWith("key"))).toBe(false);
  });

  it("goes on in the empty new session an earlier try already opened, without New Session again", async () => {
    const empty = [{ text: "Bem-vindo de volta, Osvaldo", y: 120 }, { text: "Local", y: 720 }, { text: "nuria-platform", x: 900, y: 720 }, { text: "main", x: 1_100, y: 720 }, { text: "worktree", x: 1_200, y: 720 }, { text: "Descreva uma tarefa ou faça uma pergunta", y: 780 }];
    const app = fakeApp({ screens: [empty] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "#9311 brief" })).toEqual({ ok: true });
    expect(app.actions).toEqual(["activate", "click 620,788", "paste(all) #9311 brief", `type  ${DESKTOP_BRIEF_NOTE}`, "key 36"]);
    // an empty session in another folder is not ours to fill
    const other = fakeApp({ screens: [empty.map((line) => line.text === "nuria-platform" ? { ...line, text: "soph-ia" } : line), REPO_SCREEN] });
    await createDesktopSession(other.driver, { repoName: "nuria-platform", text: "x" });
    expect(other.actions[1]).toBe("menu new session");
  });

  it("does not take the repository name from the sidebar", async () => {
    const app = fakeApp({ screens: [OPEN_SESSION, [{ text: "nuria-platform", x: 100 }, "soph-ia", "worktree"]] });
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

  it("adds a line of its own after a message the app may wrap as pasted content", async () => {
    const long = `Long steer ${"x".repeat(250)}`;
    const app = fakeApp({ screens: [[open, field], [open, { text: "Long steer xxxx", y: 820 }], [open, field]] });
    expect(await sendToDesktopSession(app.driver, { localId, text: long, title: open.text })).toEqual({ ok: true });
    expect(app.actions).toContain(`type  ${DESKTOP_MESSAGE_NOTE}`);
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

  it("tells whether the last turn ended, and reads a blocked summary only when it is this turn's", () => {
    transcript("cli-e", [
      { type: "user", message: { content: "brief" } },
      { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "parei" }] } },
      { type: "system", subtype: "stop_hook_summary" },
    ]);
    expect(transcriptTurnEnded(join(projects, "-repo-wt", "cli-e.jsonl"))).toBe(true);
    transcript("cli-o", [{ type: "user", message: { content: "brief" } }, { type: "assistant", message: { stop_reason: "tool_use", content: [] } }]);
    expect(transcriptTurnEnded(join(projects, "-repo-wt", "cli-o.jsonl"))).toBe(false);
    expect(transcriptTurnEnded(join(projects, "nope.jsonl"))).toBe(false);
    const blocked = { status_category: "blocked", needs_action: "GO", summarizes_uuid: "u1" };
    expect(recordBlocked({ postTurnSummary: blocked, lastAssistantUuid: "u1" })).toBe("GO");
    expect(recordBlocked({ postTurnSummary: blocked, lastAssistantUuid: "u2" })).toBeNull();
    expect(summaryIsCurrent({ postTurnSummary: blocked })).toBe(true);
  });

  it("tells whether a message reached the transcript after it was sent, and when it was last written", () => {
    const sentAt = Date.parse("2026-09-30T01:04:32Z");
    transcript("cli-m", [
      { type: "user", timestamp: "2026-09-29T22:40:00Z", message: { content: "Chief of Staff aqui. Faça X." } },
      { type: "assistant", timestamp: "2026-09-30T01:04:40Z", message: { content: [{ type: "text", text: "Chief of Staff aqui. Faça Y." }] } },
      { type: "user", timestamp: "2026-09-30T01:04:35Z", message: { content: "Conferi o c445f4459 na branch local\nFique parada" } },
    ]);
    const path = join(projects, "-repo-wt", "cli-m.jsonl");
    expect(transcriptMentions(path, "Conferi o c445f4459 na branch local\nFique parada", sentAt)).toBe(true);
    expect(transcriptMentions(path, "Outra mensagem", sentAt)).toBe(false);
    // the same opening sent earlier, or said by the assistant, is not our message arriving
    expect(transcriptMentions(path, "Chief of Staff aqui. Faça X.", sentAt)).toBe(false);
    expect(transcriptMentions(path, "Chief of Staff aqui. Faça Y.", sentAt)).toBe(false);
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

  it("refuses to pick one of several sidebar entries with the same title", async () => {
    const nightly = { text: "Relatorio nightly nuria", x: 100 };
    const app = fakeApp({ screen: [nightly, { ...nightly }, { text: "Arquivar", x: 100 }] });
    expect(await archiveDesktopSession(app.driver, { localId, title: "Relatorio nightly nuria" })).toMatchObject({ ok: false, retry: false, reason: expect.stringContaining("2 sessions") });
    expect(app.actions.some((action) => action.startsWith("rclick") || action.startsWith("click"))).toBe(false);
  });

  it("takes the one exact title among entries that only share a prefix", async () => {
    const app = fakeApp({ screen: [{ text: "Valida inatividade widget piperun 2", x: 100 }, { text: "Valida inatividade widget piperun", x: 100, y: 700 }, { text: "Arquivar", x: 100, y: 720 }] });
    expect(await archiveDesktopSession(app.driver, { localId, title: "Valida inatividade widget piperun" })).toEqual({ ok: true });
    expect(app.actions).toContain("rclick 130,708");
  });

  it("does not press Escape into another app when Claude lost the front", async () => {
    // fronts: step start, open-session guard, menu guard, archive-menu guard (Terminal)
    const app = fakeApp({ fronts: [CLAUDE_BUNDLE_ID, CLAUDE_BUNDLE_ID, CLAUDE_BUNDLE_ID, TERMINAL], screen: [{ text: "Teste modo app", x: 100 }] });
    expect(await archiveDesktopSession(app.driver, { localId, title: "Teste modo app" })).toMatchObject({ ok: false, retry: true });
    expect(app.actions).not.toContain("key 53");
  });

  it("matches truncated sidebar titles, not unrelated ones", () => {
    expect(sidebarMatch("Automação inatividade não disp…", "Automação inatividade não dispara")).toBe(true);
    expect(sidebarMatch("Teste modo app", "Teste modo app")).toBe(true);
    expect(sidebarMatch("Teste", "Teste modo app")).toBe(false);
    expect(sidebarMatch("Transfer N2 sem agente", "Teste modo app")).toBe(false);
  });
});

// What the Claude app's window really showed (OCR of a capture, 30/09): a
// status dot before each sidebar title and the header's, an icon read as a
// letter, the folder chip and branch on one line, the header's dropdown and
// folder after the title.
describe("the app's real screen (OCR fixture)", () => {
  const localId = "local_63607854-a958-43e0-b2bc-ac77b4a92b4d";
  const sidebar = [
    { text: "i Merge e deploy de PRs abertos", x: 21, y: 172 },
    { text: "• Atendimento reaberto bugs", x: 24, y: 304 },
    { text: "• Chat ticket agent/client labels bug", x: 24, y: 338 },
    { text: "• Fila errada ao criar ticket", x: 24, y: 411 },
    { text: "• Automação inatividade não dispara", x: 24, y: 447 },
  ];
  const header = { text: "• Chat ticket agent/client labels bug v (nuria-platform", x: 500, y: 57 };
  const chip = { text: "nuria-platform fix/9311-chat-labels", x: 547, y: 815 };
  const field = { text: "Digite / para comandos", x: 547, y: 875 };

  it("matches titles behind a status dot or an icon, and the header with its folder after it", () => {
    expect(sidebarMatch("• Fila errada ao criar ticket", "Fila errada ao criar ticket")).toBe(true);
    expect(sidebarMatch("i Merge e deploy de PRs abertos", "Merge e deploy de PRs abertos")).toBe(true);
    expect(sidebarMatch(header.text, "Chat ticket agent/client labels bug")).toBe(true);
    expect(sidebarMatch("• Atendimento reaberto bugs", "Fila errada ao criar ticket")).toBe(false);
  });

  it("finds the folder as a word of the chip line", () => {
    const at = (text: string) => [{ x: 547, y: 815, w: 200, h: 16, text }];
    expect(showsFolder(at(chip.text), "nuria-platform")).toBe(true);
    expect(showsFolder(at("• Título v (nuria-platform"), "nuria-platform")).toBe(true);
    expect(showsFolder(at("nuria-platform-old main"), "nuria-platform")).toBe(false);
    expect(showsFolder(at("OpenMausBot main"), "nuria-platform")).toBe(false);
  });

  it("knows the session from the header the app really draws: cut short, behind a dot or icon, with its repo after it", () => {
    const at = (text: string) => [{ x: 500, y: 57, w: 400, h: 16, text }];
    expect(headerNames(at("• Chat ticket agent/cli… v (nuria-platform"), "Chat ticket agent/client labels bug")).toBe(true);
    expect(headerNames(at("oG 9311 Chat no ticket mostra Agente e… v (nuria-platform"), "9311 Chat no ticket mostra Agente e Cliente trocados")).toBe(true);
    expect(headerNames(at("• Fila errada ao criar ticket v (nuria-platform"), "Chat ticket agent/client labels bug")).toBe(false);
    expect(headerNames(at("• Atendimento reaberto bugs"), "Automação inatividade não dispara")).toBe(false);
  });

  it("says what the header showed when the session on screen is another one", async () => {
    const other = { text: "• Fila errada ao criar ticket v (nuria-platform", x: 500, y: 57 };
    const app = fakeApp({ screens: [[other, chip, field]] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "x", title: "Chat ticket agent/client labels bug" })).toMatchObject({ ok: false, miss: true, seen: expect.stringContaining("Fila errada") });
    const noField = fakeApp({ screens: [[header, chip]] });
    expect(await sendToDesktopSession(noField.driver, { localId, text: "x", title: "Chat ticket agent/client labels bug" })).toMatchObject({ ok: false, seen: expect.stringContaining("fix/9311") });
  });

  it("sends into the session whose header carries a status dot (8378b26a)", async () => {
    const typed = { ...field, text: "Siga com o PR" };
    const app = fakeApp({ screens: [[...sidebar, header, chip, field], [...sidebar, header, chip, typed], [...sidebar, header, chip, field]] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "Siga com o PR", title: "Chat ticket agent/client labels bug" })).toEqual({ ok: true });
  });

  it("archives the sidebar entry behind its status dot (28963e07)", async () => {
    const app = fakeApp({ screen: [...sidebar, header, { text: "Arquivar", x: 60, y: 440 }] });
    expect(await archiveDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket" })).toEqual({ ok: true });
    expect(app.actions).toContain("rclick 54,419");
  });

  it("opens a new session whose folder chip reads with its branch (c30a1f34)", async () => {
    const app = fakeApp({ screens: [[header, { text: "Texto da conversa anterior", x: 547, y: 300 }], [{ text: "nuria-platform main", x: 547, y: 815 }, { text: "worktree", x: 700, y: 815 }]] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "#9307 brief" })).toEqual({ ok: true });
  });

  it("says what the screen showed when the folder is another one", async () => {
    const app = fakeApp({ screens: [[header, { text: "Texto da conversa anterior", x: 547, y: 300 }], [{ text: "nuria-platform main", x: 547, y: 815 }, { text: "worktree", x: 700, y: 815 }]] });
    expect(await createDesktopSession(app.driver, { repoName: "OpenMausBot", text: "brief" })).toMatchObject({ ok: false, miss: true, seen: expect.stringContaining("nuria-platform main") });
  });
});

describe("the session's own menu, in its header", () => {
  const localId = "local_afeb24d3-d5d4-4d9b-8040-1d7f52a094bc";
  const header = { text: "• Fila errada ao criar ticket v (nuria-platform", x: 500, y: 57 };

  it("archives from the header's menu without needing the sidebar entry (only ~20 of 130 show)", async () => {
    const app = fakeApp({ screens: [[header], [header, { text: "Renomear", x: 520, y: 110 }, { text: "Arquivar", x: 520, y: 140 }]] });
    expect(await archiveDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket" })).toEqual({ ok: true });
    expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`, "click 520,65", "click 620,148"]);
  });

  const composer = { text: "Digite / para comandos", x: 547, y: 875 };
  const field = { text: "Fila errada ao criar ticket", x: 520, y: 57 };
  const renamed = { text: "#9305 Fila errada ao criar ticket", x: 520, y: 57 };

  it("renames it \"#NNNN …\" from the same menu once the field is open, and confirms only what shows there", async () => {
    const app = fakeApp({ screens: [[header, composer], [header, { text: "Renomear", x: 520, y: 110 }, composer], [field, composer], [renamed, composer]] });
    expect(await renameDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket", newTitle: "#9305 Fila errada ao criar ticket" })).toEqual({ ok: true });
    expect(app.actions.slice(-3)).toEqual(["click 620,118", "paste(all) #9305 Fila errada ao criar ticket", "key 36"]);
  });

  it("types nothing when the rename field did not open (the menu stays, or the title is gone)", async () => {
    const menu = [header, { text: "Renomear", x: 520, y: 110 }, composer];
    for (const after of [menu, [composer], [header]]) {
      const app = fakeApp({ screens: [[header, composer], menu, after] });
      expect(await renameDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket", newTitle: "#9305 x" })).toMatchObject({ ok: false, retry: false, reason: expect.stringContaining("did not open") });
      expect(app.actions.some((action) => action.startsWith("paste") || action === "key 36")).toBe(false);
    }
  });

  it("never sends the title as a message: pasted into the message field, it is cleared, and Return is never pressed", async () => {
    const intoComposer = [header, { text: "#9305 Fila errada ao criar ticket", x: 547, y: 875 }];
    const app = fakeApp({ screens: [[header, composer], [header, { text: "Renomear", x: 520, y: 110 }, composer], [field, composer], intoComposer] });
    expect(await renameDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket", newTitle: "#9305 Fila errada ao criar ticket" })).toMatchObject({ ok: false, retry: false, reason: expect.stringContaining("cleared and not sent") });
    expect(app.actions).not.toContain("key 36");
    expect(app.actions.slice(-2)).toEqual(["key 0+cmd", "key 51"]);
  });

  it("falls back to the sidebar when the header menu has no such item", async () => {
    const app = fakeApp({ screens: [[header, { text: "• Fila errada ao criar ticket", x: 24, y: 411 }], [header, { text: "Copiar link", x: 520, y: 110 }], [{ text: "Arquivar", x: 60, y: 440 }]] });
    expect(await archiveDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket" })).toEqual({ ok: true });
    expect(app.actions).toContain("key 53");
    expect(app.actions).toContain("rclick 54,419");
  });
});

describe("questions, folders and reused worktrees in the app's records", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "omb-q-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds a question asked in the app that nobody answered", () => {
    const file = join(root, "t.jsonl");
    const ask = { type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "AskUserQuestion", input: { questions: [{ question: "O hook Jev bloqueou o gh issue comment. Posso publicá-lo?", options: [{ label: "Sim, publicar" }, { label: "Não publicar" }] }] } }] } };
    writeFileSync(file, [JSON.stringify({ type: "user", message: { content: "brief" } }), JSON.stringify(ask)].join("\n"));
    expect(transcriptOpenQuestion(file)).toEqual({ id: "tu1", text: "O hook Jev bloqueou o gh issue comment. Posso publicá-lo? [opções: Sim, publicar / Não publicar]" });
    writeFileSync(file, [JSON.stringify(ask), JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "Sim" }] } })].join("\n"));
    expect(transcriptOpenQuestion(file)).toBeNull();
  });

  it("knows the app's last folder and who else works in a worktree", () => {
    const records = join(root, "org", "acct");
    mkdirSync(records, { recursive: true });
    const write = (id: string, extra: object) => writeFileSync(join(records, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: `c-${id}`, ...extra }));
    write("local_a", { createdAt: 1, cwd: "/Users/o/Projetos/OpenMausBot" });
    write("local_b", { createdAt: 5, cwd: "/Users/o/Projetos/nuria-platform/.claude/worktrees/teste-modo-app-70ca2f" });
    write("local_c", { createdAt: 3, cwd: "/Users/o/Projetos/nuria-platform/.claude/worktrees/teste-modo-app-70ca2f", isArchived: true });
    expect(lastAppRepo(root)).toBe("/Users/o/Projetos/nuria-platform");
    // a scheduled run and a scratch session opened later do not move the folder New Session uses
    write("local_d", { createdAt: 7, cwd: "/Users/o/Projetos/OpenMausBot", scheduledTaskId: "relatorio-nightly" });
    write("local_e", { createdAt: 8, cwd: "/Users/o/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-09-29-80c636" });
    expect(lastAppRepo(root)).toBe("/Users/o/Projetos/nuria-platform");
    expect(recordsUsingFolder("/Users/o/Projetos/nuria-platform/.claude/worktrees/teste-modo-app-70ca2f", "local_c", root).map((record) => record.sessionId)).toEqual(["local_b"]);
    expect(recordsUsingFolder("/Users/o/Projetos/nuria-platform/.claude/worktrees/teste-modo-app-70ca2f", "local_b", root)).toEqual([]);
    expect(recordsUsingFolder("/Users/o/Projetos/nuria-platform/.claude/worktrees/teste-modo-app-70ca2f", "local_b", root, true).map((record) => record.sessionId)).toEqual(["local_c"]);
  });
});
