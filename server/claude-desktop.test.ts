import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDesktopSession,
  findDesktopSession,
  lastAssistantText,
  newMarker,
  parseOcr,
  readDesktopRecord,
  sendToDesktopSession,
  type DesktopDriver,
  type OcrLine,
} from "./claude-desktop.ts";

/** A fake Claude app: records what the automation did to the screen. */
function fakeApp(opts: { idle?: number; fronts?: string[]; screen?: string[] } = {}) {
  const actions: string[] = [];
  const fronts = [...(opts.fronts ?? [])];
  const screen: OcrLine[] = (opts.screen ?? []).map((text, i) => ({ x: 100, y: 800 + i * 20, w: 200, h: 16, text }));
  const driver: DesktopDriver = {
    idleSeconds: async () => opts.idle ?? 120,
    frontmost: async () => (fronts.length > 1 ? fronts.shift()! : fronts[0] ?? "Claude"),
    ocr: async () => screen,
    click: async (x, y) => { actions.push(`click ${x},${y}`); },
    key: async (code, command) => { actions.push(`key ${code}${command ? "+cmd" : ""}`); },
    paste: async (text, selectAll) => { actions.push(`paste${selectAll ? "(all)" : ""} ${text}`); },
    menuNewSession: async () => { actions.push("menu new session"); },
    openUrl: async (url) => { actions.push(`open ${url}`); },
    activateClaude: async () => { actions.push("activate"); },
    sleep: async () => {},
  };
  return { driver, actions };
}

const REPO_SCREEN = ["Local", "nuria-platform", "main", "worktree"];

describe("createDesktopSession", () => {
  it("opens a new session in the repository, pastes the brief and sends it", async () => {
    const app = fakeApp({ screen: REPO_SCREEN });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "[OMBX] brief" })).toEqual({ ok: true });
    expect(app.actions).toEqual(["activate", "menu new session", "paste(all) [OMBX] brief", "key 36"]);
  });

  it("waits while the person is using the Mac", async () => {
    const app = fakeApp({ idle: 12, screen: REPO_SCREEN });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: true });
    expect(app.actions).toEqual([]);
  });

  it("stops before any keystroke if another app takes the front", async () => {
    const app = fakeApp({ fronts: ["Claude", "Claude", "Claude", "Terminal"], screen: REPO_SCREEN });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: true, reason: expect.stringContaining("Terminal") });
    expect(app.actions.some((action) => action.startsWith("key"))).toBe(false);
  });

  it("refuses a new session opened in another folder", async () => {
    const app = fakeApp({ screen: ["Local", "soph-ia", "main", "worktree"] });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: false });
    expect(app.actions).toEqual(["activate", "menu new session"]);
  });
});

describe("sendToDesktopSession", () => {
  const localId = "local_6415ced5-d3d5-4055-9d33-58c585c87de3";
  it("reopens the session with the app's link and sends into its field", async () => {
    const app = fakeApp({ screen: ["Digite / para comandos"] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "follow-up" })).toEqual({ ok: true });
    expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`, "click 120,808", "paste follow-up", "key 36"]);
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
});

describe("helpers", () => {
  it("parses the helper's OCR lines and makes OCR-safe markers", () => {
    expect(parseOcr("996 794 457 38 | Confiar neste workspace?\nlixo\n")).toEqual([{ x: 996, y: 794, w: 457, h: 38, text: "Confiar neste workspace?" }]);
    expect(newMarker()).toMatch(/^OMB[A-HJ-NP-Z2-9]{7}$/);
  });
});
