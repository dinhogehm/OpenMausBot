// Driving the Claude desktop app so the Claude Code sessions a bot manages
// live there, where the person follows them — the way a person would do it:
// File → New Session (the app's last folder, which must be the repository),
// paste the brief, Enter; later reopen the session with the app's own
// claude://code/continue?session=<id> link, paste the reply, Enter.
//
// Nothing here writes the app's storage. Sessions are found and followed by
// READING the app's session records and the Claude Code transcript they point
// to. Every step that touches the screen first checks that the person has
// been idle, that the screen is unlocked and awake, and — before each click,
// paste and keystroke — that the Claude app (by bundle id) is frontmost and
// nobody touched the Mac since our own last action, so a person picking it
// back up aborts the step instead of receiving it. A step that aborts is
// retried later, backing off; nothing is lost.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const DESKTOP_IDLE_SECONDS = 5;
export const DESKTOP_SESSIONS_DIR = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
/** The Claude app, by bundle id: a window title or localized name can lie. */
export const CLAUDE_BUNDLE_ID = "com.anthropic.claudefordesktop";
/** Typed after a pasted brief: the app wraps pastes as pasted content, and a
 * session follows pasted instructions only when its user's own words ask it to. */
export const DESKTOP_BRIEF_NOTE = "Esta é a sua tarefa, enviada pelo gerente OpenMausBot: siga o conteúdo colado acima.";
export const DESKTOP_MESSAGE_NOTE = "Mensagem do seu gerente OpenMausBot: siga o conteúdo colado acima.";
/** Messages longer than this are pasted as content by the app; they get the note too. */
const DESKTOP_NOTE_AFTER_CHARS = 800;

export interface OcrLine { x: number; y: number; w: number; h: number; text: string }

/** The native actions, behind an interface so tests can drive a fake app. */
export interface DesktopDriver {
  idleSeconds(): Promise<number>;
  /** Bundle id of the frontmost application. */
  frontmost(): Promise<string>;
  /** The screen is locked, or the main display is asleep: nothing to see or type into. */
  locked(): Promise<boolean>;
  /** Main display size in points; OCR coordinates use the same space. */
  screenSize(): Promise<{ w: number; h: number }>;
  ocr(): Promise<OcrLine[]>;
  click(x: number, y: number): Promise<void>;
  rightClick(x: number, y: number): Promise<void>;
  key(code: number, command?: boolean): Promise<void>;
  /** Clipboard paste of `text`; `selectAll` first replaces what is in the field. */
  paste(text: string, selectAll: boolean): Promise<void>;
  menuNewSession(): Promise<void>;
  openUrl(url: string): Promise<void>;
  activateClaude(): Promise<void>;
  /** Bring back the app (by bundle id) that was in front before a step. */
  activate(bundleId: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** `miss`: the screen did not show what was expected (folder, worktree,
 * session) although it was unlocked and Claude was in front. `touched`: the
 * step acted on the screen before stopping, so a retry should back off. */
export type DesktopStep = { ok: true } | { ok: false; reason: string; retry: boolean; miss?: boolean; touched?: boolean; human?: boolean };

const RETURN = 36;
const ESCAPE = 53;
/** The sidebar sits on the left; menus open next to the click. */
const SIDEBAR_MAX_X = 450;
/** A person's input newer than our own last action by more than this is theirs. */
const HUMAN_SLACK_MS = 500;
/** The empty message field's placeholder, the whole OCR line and nothing else. */
const COMPOSER_PLACEHOLDER = /^(Digite \/ para comandos|Type \/ for commands|Responder\b.*|Reply\b.*)$/i;

export function parseOcr(text: string): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const raw of text.split("\n")) {
    const at = raw.indexOf(" | ");
    if (at < 0) continue;
    const [x, y, w, h] = raw.slice(0, at).trim().split(/\s+/).map(Number);
    if ([x, y, w, h].some((n) => !Number.isFinite(n))) continue;
    lines.push({ x: x!, y: y!, w: w!, h: h!, text: raw.slice(at + 3) });
  }
  return lines;
}

export function findLine(lines: OcrLine[], needle: string | RegExp): OcrLine | undefined {
  return lines.find((line) => (typeof needle === "string" ? line.text.toLowerCase().includes(needle.toLowerCase()) : needle.test(line.text.trim())));
}

/** Lines of the main area (right of the sidebar). */
const mainArea = (lines: OcrLine[]) => lines.filter((line) => line.x > SIDEBAR_MAX_X);

/** A short marker that transcripts carry intact: letters and digits only. */
export function newMarker(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "OMB";
  for (let i = 0; i < 7; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** Wait for the person to leave the Mac alone, awake and unlocked, before touching the screen. */
export async function readyForScreen(driver: DesktopDriver, idleSeconds = DESKTOP_IDLE_SECONDS): Promise<DesktopStep> {
  if (await driver.locked()) return { ok: false, reason: "the screen is locked or the display is asleep", retry: true };
  const idle = await driver.idleSeconds();
  if (idle < idleSeconds) return { ok: false, reason: `the Mac is in use (idle ${Math.round(idle)}s, need ${idleSeconds}s)`, retry: true };
  return { ok: true };
}

/** One step on the screen. Every synthetic action goes through `act`, which
 * remembers when our own input last happened; input newer than that can only
 * be the person's, and `guard` stops the step for it. */
interface Screen {
  driver: DesktopDriver;
  /** Latest input we can account for: the person's before the step, then ours. */
  quietSince: number;
  previousFront: string;
  touched: boolean;
}

async function act(screen: Screen, action: () => Promise<void>): Promise<void> {
  await action();
  screen.touched = true;
  screen.quietSince = Date.now();
}

async function guard(screen: Screen, step: string): Promise<DesktopStep | null> {
  const before = Date.now();
  const idle = await screen.driver.idleSeconds();
  if (before - idle * 1_000 > screen.quietSince + HUMAN_SLACK_MS) {
    return { ok: false, reason: `the person picked the Mac back up at "${step}"`, retry: true, touched: screen.touched, human: true };
  }
  const front = await screen.driver.frontmost();
  if (front !== CLAUDE_BUNDLE_ID) return { ok: false, reason: `the Claude app lost focus at "${step}" (frontmost: ${front || "none"})`, retry: true, touched: screen.touched };
  return null;
}

/** Run `body` as one screen step: wait for an idle, unlocked Mac first, and
 * afterwards give the front back to the app that had it — unless the person
 * came back, in which case the screen is theirs and nothing more is touched. */
async function withScreen(driver: DesktopDriver, body: (screen: Screen) => Promise<DesktopStep>): Promise<DesktopStep> {
  const ready = await readyForScreen(driver);
  if (!ready.ok) return ready;
  const before = Date.now();
  const idle = await driver.idleSeconds();
  const screen: Screen = { driver, quietSince: before - idle * 1_000, previousFront: await driver.frontmost(), touched: false };
  let result: DesktopStep | null = null;
  try {
    result = await body(screen);
    return result;
  } finally {
    const human = result !== null && !result.ok && result.human === true;
    if (screen.touched && !human && screen.previousFront && screen.previousFront !== CLAUDE_BUNDLE_ID) {
      try {
        if ((await driver.frontmost()) === CLAUDE_BUNDLE_ID) await driver.activate(screen.previousFront);
      } catch { /* best effort */ }
    }
  }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalize = (text: string) => text.toLowerCase().replace(/[…\s]+/g, " ").trim();

/** What OCR should show of `text` once it is in the field: its first words. */
export function textPrefix(text: string): string {
  const first = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return normalize(first).slice(0, 24);
}

function showsPrefix(lines: OcrLine[], prefix: string): boolean {
  if (!prefix) return false;
  return lines.some((line) => {
    const shown = normalize(line.text);
    return shown.includes(prefix) || (shown.length >= 12 && prefix.startsWith(shown));
  });
}

/**
 * New session in the Claude app for `repoName`, brief pasted and sent.
 * The app opens a new session in the last folder used; if that is not the
 * repository (or the worktree option is not there), stop and retry later.
 */
export async function createDesktopSession(driver: DesktopDriver, input: { repoName: string; text: string }): Promise<DesktopStep> {
  return withScreen(driver, async (screen) => {
    await act(screen, () => driver.activateClaude());
    await driver.sleep(700);
    let stop = await guard(screen, "open");
    if (stop) return stop;
    await act(screen, () => driver.menuNewSession());
    await driver.sleep(2_500);
    stop = await guard(screen, "new session");
    if (stop) return stop;
    const lines = mainArea(await driver.ocr());
    if (!findLine(lines, new RegExp(`^${escapeRegExp(input.repoName)}$`))) {
      return { ok: false, reason: `the new session did not open in ${input.repoName} (the app reuses the last folder picked in it; open one session there by hand once)`, retry: true, miss: true, touched: true };
    }
    if (!findLine(lines, /worktree/i)) return { ok: false, reason: "the new session shows no worktree option", retry: true, miss: true, touched: true };
    stop = await guard(screen, "paste");
    if (stop) return stop;
    await act(screen, () => driver.paste(input.text, true));
    await driver.sleep(500);
    stop = await guard(screen, "note");
    if (stop) return stop;
    await act(screen, () => driver.paste(` ${DESKTOP_BRIEF_NOTE}`, false));
    await driver.sleep(300);
    stop = await guard(screen, "send");
    if (stop) return stop;
    await act(screen, () => driver.key(RETURN));
    return { ok: true };
  });
}

/**
 * Reopen a session with the app's own link and send `text` into it. The
 * session's title must be on screen, the text must show up in its field,
 * and the field must empty after Return; otherwise the step is retried.
 */
export async function sendToDesktopSession(driver: DesktopDriver, input: { localId: string; text: string; title?: string }): Promise<DesktopStep> {
  if (!/^local_[0-9a-f-]{36}$/.test(input.localId)) return { ok: false, reason: "invalid desktop session id", retry: false };
  return withScreen(driver, async (screen) => {
    await act(screen, () => driver.openUrl(`claude://code/continue?session=${input.localId}`));
    await driver.sleep(3_000);
    let stop = await guard(screen, "open session");
    if (stop) return stop;
    const size = await driver.screenSize();
    const lines = mainArea(await driver.ocr());
    if (input.title && !lines.some((line) => sidebarMatch(line.text, input.title!))) {
      return { ok: false, reason: `the session "${input.title}" is not the one on screen`, retry: true, miss: true, touched: true };
    }
    const field = lines.find((line) => line.y > size.h / 2 && COMPOSER_PLACEHOLDER.test(line.text.trim()));
    if (!field) return { ok: false, reason: "the session's message field was not found", retry: true, miss: true, touched: true };
    // What is near the field (it grows upwards as text goes in).
    const nearField = (all: OcrLine[]) => mainArea(all).filter((line) => line.y > Math.max(size.h / 2, field.y - 200));
    stop = await guard(screen, "click field");
    if (stop) return stop;
    await act(screen, () => driver.click(field.x + 20, field.y + field.h / 2));
    await driver.sleep(300);
    stop = await guard(screen, "paste");
    if (stop) return stop;
    await act(screen, () => driver.paste(input.text, true));
    await driver.sleep(500);
    if (input.text.length > DESKTOP_NOTE_AFTER_CHARS) {
      stop = await guard(screen, "note");
      if (stop) return stop;
      await act(screen, () => driver.paste(` ${DESKTOP_MESSAGE_NOTE}`, false));
      await driver.sleep(300);
    }
    const prefix = textPrefix(input.text);
    const typed = nearField(await driver.ocr());
    // In the field: its first words show, or at least the placeholder gave way.
    if (!showsPrefix(typed, prefix) && typed.some((line) => COMPOSER_PLACEHOLDER.test(line.text.trim()))) {
      return { ok: false, reason: "the message did not appear in the session's field", retry: true, touched: true };
    }
    stop = await guard(screen, "send");
    if (stop) return stop;
    await act(screen, () => driver.key(RETURN));
    await driver.sleep(1_500);
    const after = nearField(await driver.ocr());
    if (!after.some((line) => COMPOSER_PLACEHOLDER.test(line.text.trim())) && showsPrefix(after, prefix)) {
      return { ok: false, reason: "the message stayed in the field after Return", retry: true, touched: true };
    }
    return { ok: true };
  });
}

/** Normalised title prefix the sidebar shows (it truncates long titles). */
export function sidebarMatch(lineText: string, title: string): boolean {
  const shown = normalize(lineText);
  const wanted = normalize(title);
  if (shown.length < 6 || wanted.length < 6) return false;
  const prefix = wanted.slice(0, Math.min(24, wanted.length));
  return shown.startsWith(prefix) || (shown.length >= 12 && wanted.startsWith(shown));
}

/** Archive a session in the app: its sidebar entry → right click → "Arquivar". */
export async function archiveDesktopSession(driver: DesktopDriver, input: { localId: string; title: string }): Promise<DesktopStep> {
  if (!/^local_[0-9a-f-]{36}$/.test(input.localId)) return { ok: false, reason: "invalid desktop session id", retry: false };
  return withScreen(driver, async (screen) => {
    await act(screen, () => driver.openUrl(`claude://code/continue?session=${input.localId}`));
    await driver.sleep(2_500);
    let stop = await guard(screen, "open session");
    if (stop) return stop;
    // Titles repeat in the sidebar ("Relatorio nightly" fifteen times): act
    // only on one unambiguous entry, never on the first of several.
    const matches = (await driver.ocr()).filter((line) => line.x < SIDEBAR_MAX_X && sidebarMatch(line.text, input.title));
    if (!matches.length) return { ok: false, reason: `"${input.title}" is not visible in the app's sidebar`, retry: true, miss: true, touched: true };
    const exact = matches.filter((line) => normalize(line.text) === normalize(input.title));
    const entry = matches.length === 1 ? matches[0]! : exact.length === 1 ? exact[0]! : null;
    if (!entry) {
      return { ok: false, reason: `${matches.length} sessions in the app's sidebar match "${input.title}", so it cannot tell which to archive; archive it by hand in the Claude app`, retry: false, touched: true };
    }
    stop = await guard(screen, "session menu");
    if (stop) return stop;
    await act(screen, () => driver.rightClick(entry.x + 30, entry.y + entry.h / 2));
    await driver.sleep(800);
    const item = (await driver.ocr()).find((line) => (line.text.trim() === "Arquivar" || line.text.trim() === "Archive") && Math.abs(line.y - entry.y) < 400);
    stop = await guard(screen, "archive menu");
    if (stop) return stop; // the Claude app is not in front (or the person is back): no Escape into their app
    if (!item) {
      await act(screen, () => driver.key(ESCAPE));
      return { ok: false, reason: "the session menu showed no Archive item", retry: true, miss: true, touched: true };
    }
    await act(screen, () => driver.click(item.x + item.w / 2, item.y + item.h / 2));
    await driver.sleep(1_000);
    return { ok: true };
  });
}

// ── reading the app's session records (never written) ────────────────────

export interface DesktopRecord {
  sessionId: string;
  cliSessionId: string;
  cwd?: string;
  title?: string;
  /** Timestamps are normalised to epoch milliseconds when read. */
  createdAt?: number;
  lastActivityAt?: number;
  /** When the session last received a message from its user (us). */
  latestUserFrameAt?: number;
  completedTurns?: number;
  isArchived?: boolean;
  prUrl?: string;
  /** The mode the app really runs it in (the person may pick bypass there). */
  permissionMode?: string;
  worktreePath?: string;
  worktreeName?: string;
  /** The app's own summary of the last turn: status_category "blocked" means it waits on someone. */
  postTurnSummary?: { status_category?: string; needs_action?: unknown; [key: string]: unknown };
}

const toMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1_000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

/** Why the session says it cannot go on, when its last turn ended blocked. */
export function recordBlocked(record: Pick<DesktopRecord, "postTurnSummary">): string | null {
  const summary = record.postTurnSummary;
  if (!summary || summary.status_category !== "blocked") return null;
  const need = summary.needs_action;
  const text = typeof need === "string" ? need : Array.isArray(need) ? need.map(String).join("; ") : need ? JSON.stringify(need) : "";
  return text.trim().slice(0, 1_000) || "it did not say what it needs";
}

/** The session works in a git worktree of its own, not in the main checkout. */
export function recordInWorktree(record: Pick<DesktopRecord, "cwd" | "worktreePath">): boolean {
  return Boolean(record.worktreePath) || Boolean(record.cwd?.includes("/.claude/worktrees/"));
}

function* recordFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const org of readdirSync(dir)) {
    const orgDir = join(dir, org);
    if (!statSync(orgDir).isDirectory()) continue;
    for (const account of readdirSync(orgDir)) {
      const accountDir = join(orgDir, account);
      if (!statSync(accountDir).isDirectory()) continue;
      for (const file of readdirSync(accountDir)) if (/^local_.+\.json$/.test(file)) yield join(accountDir, file);
    }
  }
}

function readRecord(file: string): DesktopRecord | null {
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as DesktopRecord;
    if (typeof record.sessionId !== "string" || typeof record.cliSessionId !== "string") return null;
    for (const key of ["createdAt", "lastActivityAt", "latestUserFrameAt"] as const) {
      const value = toMs(record[key]);
      if (value === undefined) delete record[key];
      else record[key] = value;
    }
    return record;
  } catch {
    return null;
  }
}

export function readDesktopRecord(localId: string, dir = DESKTOP_SESSIONS_DIR): DesktopRecord | null {
  for (const file of recordFiles(dir)) if (file.endsWith(`/${localId}.json`)) return readRecord(file);
  return null;
}

export function transcriptPath(record: Pick<DesktopRecord, "cliSessionId">, projects = CLAUDE_PROJECTS_DIR): string | null {
  if (!existsSync(projects)) return null;
  for (const project of readdirSync(projects)) {
    const candidate = join(projects, project, `${record.cliSessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The session created from our brief: newer than `since`, marker in its transcript. */
export function findDesktopSession(marker: string, since: number, dir = DESKTOP_SESSIONS_DIR, projects = CLAUDE_PROJECTS_DIR): DesktopRecord | null {
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (!record || (record.createdAt ?? 0) < since) continue;
    const transcript = transcriptPath(record, projects);
    if (!transcript) continue;
    try {
      if (readFileSync(transcript, "utf8").slice(0, 400_000).includes(marker)) return record;
    } catch { /* being written; next tick */ }
  }
  return null;
}

/** The last thing the session said, from its transcript. */
export function lastAssistantText(transcript: string, max = 6_000): string {
  let raw = "";
  try {
    raw = readFileSync(transcript, "utf8");
  } catch {
    return "";
  }
  const lines = raw.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as { type?: string; message?: { content?: unknown } };
      if (event.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
      const text = (event.message!.content as Array<{ type?: string; text?: string }>)
        .filter((part) => part?.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      if (text) return text.slice(0, max);
    } catch { /* partial line */ }
  }
  return "";
}

/** Did our message reach the session? Its first line shows in the transcript. */
export function transcriptMentions(transcript: string, text: string): boolean {
  const first = text.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 60);
  if (!first) return false;
  try {
    const raw = readFileSync(transcript, "utf8");
    return raw.slice(-2_000_000).includes(JSON.stringify(first).slice(1, -1));
  } catch {
    return false;
  }
}

/** When the transcript was last written, or null. */
export function transcriptWrittenAt(transcript: string): number | null {
  try {
    return statSync(transcript).mtimeMs;
  } catch {
    return null;
  }
}

// ── the real driver ──────────────────────────────────────────────────────

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file.split("/").pop()} ${args[0] ?? ""}: ${String(stderr || error.message).trim().slice(0, 300)}`));
      else resolve(String(stdout));
    });
  });
}

/** Compile the Swift helper once per source version into dataDir/bin. */
export async function ensureHelper(dataDir: string, source: string, env: NodeJS.ProcessEnv): Promise<string> {
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const binDir = join(dataDir, "bin");
  const bin = join(binDir, `omb-desktop-${hash}`);
  if (existsSync(bin)) return bin;
  mkdirSync(binDir, { recursive: true });
  const src = join(tmpdir(), `omb-desktop-${hash}.swift`);
  writeFileSync(src, source);
  await run("/usr/bin/xcrun", ["swiftc", "-O", src, "-o", bin], env, 240_000);
  return bin;
}

export function macDesktopDriver(helper: string, env: NodeJS.ProcessEnv): DesktopDriver {
  const osa = (script: string) => run("/usr/bin/osascript", ["-e", script], env);
  return {
    async idleSeconds() {
      return Number(await run(helper, ["idle"], env)) || 0;
    },
    async frontmost() {
      return (await run(helper, ["front"], env)).trim();
    },
    async locked() {
      return (await run(helper, ["locked"], env)).trim() === "1";
    },
    async screenSize() {
      const [w, h] = (await run(helper, ["screen"], env)).trim().split(/\s+/).map(Number);
      return { w: w || 1_440, h: h || 900 };
    },
    async ocr() {
      return parseOcr(await run(helper, ["ocr"], env, 60_000));
    },
    async click(x, y) {
      await run(helper, ["click", String(Math.round(x)), String(Math.round(y))], env);
    },
    async rightClick(x, y) {
      await run(helper, ["rclick", String(Math.round(x)), String(Math.round(y))], env);
    },
    async key(code, command) {
      await run(helper, ["key", String(code), ...(command ? ["cmd"] : [])], env);
    },
    async paste(text, selectAll) {
      const file = join(tmpdir(), `omb-desktop-paste-${process.pid}-${Date.now()}.txt`);
      writeFileSync(file, text, { mode: 0o600 });
      try {
        await run(helper, ["paste", file, ...(selectAll ? ["all"] : [])], env);
      } finally {
        rmSync(file, { force: true });
      }
    },
    async menuNewSession() {
      // File → first item ("Nova sessão" / "New Session"), by position so the UI language does not matter.
      await osa('tell application "System Events" to tell process "Claude" to click menu item 1 of menu 1 of menu bar item 3 of menu bar 1');
    },
    async openUrl(url) {
      await run("/usr/bin/open", [url], env);
    },
    async activateClaude() {
      await osa('tell application "Claude" to activate');
    },
    async activate(bundleId) {
      await run(helper, ["activate", bundleId], env);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
