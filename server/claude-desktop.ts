// Driving the Claude desktop app so the Claude Code sessions a bot manages
// live there, where the person follows them — the way a person would do it:
// File → New Session (the app's last folder, which must be the repository),
// paste the brief, Enter; later reopen the session with the app's own
// claude://code/continue?session=<id> link, paste the reply, Enter.
//
// Nothing here writes the app's storage. Sessions are found and followed by
// READING the app's session records and the Claude Code transcript they point
// to. Every step that touches the screen first checks that the person has
// been idle and that the Claude app is frontmost, and re-checks before each
// keystroke, so a person picking the Mac back up aborts the step instead of
// receiving it. A step that aborts is retried later; nothing is lost.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const DESKTOP_IDLE_SECONDS = 5;
export const DESKTOP_SESSIONS_DIR = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface OcrLine { x: number; y: number; w: number; h: number; text: string }

/** The native actions, behind an interface so tests can drive a fake app. */
export interface DesktopDriver {
  idleSeconds(): Promise<number>;
  frontmost(): Promise<string>;
  ocr(): Promise<OcrLine[]>;
  click(x: number, y: number): Promise<void>;
  rightClick(x: number, y: number): Promise<void>;
  key(code: number, command?: boolean): Promise<void>;
  /** Clipboard paste of `text`; `selectAll` first replaces what is in the field. */
  paste(text: string, selectAll: boolean): Promise<void>;
  menuNewSession(): Promise<void>;
  openUrl(url: string): Promise<void>;
  activateClaude(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type DesktopStep = { ok: true } | { ok: false; reason: string; retry: boolean };

const RETURN = 36;

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
  return lines.find((line) => (typeof needle === "string" ? line.text.toLowerCase().includes(needle.toLowerCase()) : needle.test(line.text)));
}

/** A short marker that transcripts carry intact: letters and digits only. */
export function newMarker(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "OMB";
  for (let i = 0; i < 7; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function guard(driver: DesktopDriver, step: string): Promise<DesktopStep | null> {
  const front = await driver.frontmost();
  if (front !== "Claude") return { ok: false, reason: `the Claude app lost focus at "${step}" (frontmost: ${front || "none"})`, retry: true };
  return null;
}

/** Wait for the person to leave the Mac alone before touching the screen. */
export async function readyForScreen(driver: DesktopDriver, idleSeconds = DESKTOP_IDLE_SECONDS): Promise<DesktopStep> {
  const idle = await driver.idleSeconds();
  if (idle < idleSeconds) return { ok: false, reason: `the Mac is in use (idle ${Math.round(idle)}s, need ${idleSeconds}s)`, retry: true };
  return { ok: true };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * New session in the Claude app for `repoName`, brief pasted and sent.
 * The app opens a new session in the last folder used; if that is not the
 * repository (or the worktree option is not there), stop.
 */
export async function createDesktopSession(driver: DesktopDriver, input: { repoName: string; text: string }): Promise<DesktopStep> {
  const ready = await readyForScreen(driver);
  if (!ready.ok) return ready;
  await driver.activateClaude();
  await driver.sleep(700);
  let stop = await guard(driver, "open");
  if (stop) return stop;
  await driver.menuNewSession();
  await driver.sleep(2_500);
  stop = await guard(driver, "new session");
  if (stop) return stop;
  const lines = await driver.ocr();
  if (!findLine(lines, new RegExp(`^${escapeRegExp(input.repoName)}$`))) {
    return { ok: false, reason: `the new session did not open in ${input.repoName} (the app reuses the last folder picked in it; open one session there by hand once)`, retry: false };
  }
  if (!findLine(lines, /worktree/i)) return { ok: false, reason: "the new session shows no worktree option", retry: true };
  stop = await guard(driver, "paste");
  if (stop) return stop;
  await driver.paste(input.text, true);
  await driver.sleep(500);
  stop = await guard(driver, "send");
  if (stop) return stop;
  await driver.key(RETURN);
  return { ok: true };
}

/** Reopen a session with the app's own link and send `text` into it. */
export async function sendToDesktopSession(driver: DesktopDriver, input: { localId: string; text: string }): Promise<DesktopStep> {
  if (!/^local_[0-9a-f-]{36}$/.test(input.localId)) return { ok: false, reason: "invalid desktop session id", retry: false };
  const ready = await readyForScreen(driver);
  if (!ready.ok) return ready;
  await driver.openUrl(`claude://code/continue?session=${input.localId}`);
  await driver.sleep(3_000);
  let stop = await guard(driver, "open session");
  if (stop) return stop;
  const field = findLine(await driver.ocr(), /Digite \/ para comandos|Type \/ for commands|Responder|Reply/i);
  if (!field) return { ok: false, reason: "the session's message field was not found", retry: true };
  await driver.click(field.x + 20, field.y + field.h / 2);
  await driver.sleep(300);
  stop = await guard(driver, "paste");
  if (stop) return stop;
  await driver.paste(input.text, false);
  await driver.sleep(500);
  stop = await guard(driver, "send");
  if (stop) return stop;
  await driver.key(RETURN);
  return { ok: true };
}

const ESCAPE = 53;
/** The sidebar sits on the left; menus open next to the click. */
const SIDEBAR_MAX_X = 450;

/** Normalised title prefix the sidebar shows (it truncates long titles). */
export function sidebarMatch(lineText: string, title: string): boolean {
  const norm = (text: string) => text.toLowerCase().replace(/[…\s]+/g, " ").trim();
  const shown = norm(lineText);
  const wanted = norm(title);
  if (shown.length < 6 || wanted.length < 6) return false;
  const prefix = wanted.slice(0, Math.min(24, wanted.length));
  return shown.startsWith(prefix) || (shown.length >= 12 && wanted.startsWith(shown));
}

/** Archive a session in the app: its sidebar entry → right click → "Arquivar". */
export async function archiveDesktopSession(driver: DesktopDriver, input: { localId: string; title: string }): Promise<DesktopStep> {
  if (!/^local_[0-9a-f-]{36}$/.test(input.localId)) return { ok: false, reason: "invalid desktop session id", retry: false };
  const ready = await readyForScreen(driver);
  if (!ready.ok) return ready;
  await driver.openUrl(`claude://code/continue?session=${input.localId}`);
  await driver.sleep(2_500);
  let stop = await guard(driver, "open session");
  if (stop) return stop;
  const entry = (await driver.ocr()).find((line) => line.x < SIDEBAR_MAX_X && sidebarMatch(line.text, input.title));
  if (!entry) return { ok: false, reason: `"${input.title}" is not visible in the app's sidebar`, retry: true };
  await driver.rightClick(entry.x + 30, entry.y + entry.h / 2);
  await driver.sleep(800);
  const item = (await driver.ocr()).find((line) => (line.text.trim() === "Arquivar" || line.text.trim() === "Archive") && Math.abs(line.y - entry.y) < 400);
  stop = await guard(driver, "archive menu");
  if (stop || !item) {
    await driver.key(ESCAPE);
    return stop ?? { ok: false, reason: "the session menu showed no Archive item", retry: true };
  }
  await driver.click(item.x + item.w / 2, item.y + item.h / 2);
  await driver.sleep(1_000);
  return { ok: true };
}

// ── reading the app's session records (never written) ────────────────────

export interface DesktopRecord {
  sessionId: string;
  cliSessionId: string;
  cwd?: string;
  title?: string;
  createdAt?: number;
  lastActivityAt?: number;
  completedTurns?: number;
  isArchived?: boolean;
  prUrl?: string;
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
    return typeof record.sessionId === "string" && typeof record.cliSessionId === "string" ? record : null;
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
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
