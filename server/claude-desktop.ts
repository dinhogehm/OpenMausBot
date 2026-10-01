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
/** Messages longer than this may be wrapped as pasted content by the app (seen at 360); they get the note too. */
const DESKTOP_NOTE_AFTER_CHARS = 200;

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
  /** Type `text` as keystrokes: the app keeps it as the user's own words. */
  typeText(text: string): Promise<void>;
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
export type DesktopStep = { ok: true } | { ok: false; reason: string; retry: boolean; miss?: boolean; touched?: boolean; human?: boolean; seen?: string; draft?: string };

const RETURN = 36;
const ESCAPE = 53;
/** The sidebar sits on the left; menus open next to the click. */
const SIDEBAR_MAX_X = 450;
/** A person's input newer than our own last action by more than this is theirs. */
const HUMAN_SLACK_MS = 500;
/** The empty message field's placeholder, the whole OCR line and nothing else. */
const COMPOSER_PLACEHOLDER = /^(Digite \/ para comandos|Type \/ for commands|Responder\b.*|Reply\b.*)$/i;
/** The field of a new, empty session ("Descreva uma tarefa ou faça uma pergunta"). */
const NEW_SESSION_PLACEHOLDER = /^(Descreva uma tarefa|Describe a task)\b/i;
const BACKSPACE = 51;
const KEY_A = 0;

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

const normalize = (text: string) => text.toLowerCase().replace(/[…\s]+/g, " ").trim();

/** How a title may read once OCR'd: the app puts a status dot ("•") or an
 * icon read as a letter ("i", "oG") before it, and a dropdown and folder
 * chip after it in the header ("… v (nuria-platform"). Forms to compare. */
function titleForms(text: string): string[] {
  const base = normalize(text).replace(/^[^\p{L}\p{N}#]+/u, "").trim();
  const icon = /^[\p{L}]{1,2} (.+)$/u.exec(base);
  return icon ? [base, icon[1]!] : [base];
}

/** Two OCR readings of the main area that are (nearly) the same screen. */
function sameScreen(before: OcrLine[], after: OcrLine[]): boolean {
  if (!before.length || !after.length) return false;
  const seen = new Set(before.map((line) => normalize(line.text)));
  const kept = after.filter((line) => seen.has(normalize(line.text))).length;
  return kept / Math.max(before.length, after.length) >= 0.8;
}

/** A short trace of what the screen showed, for the error a person reads. */
function seenText(lines: OcrLine[], max = 8): string {
  return lines.slice(0, max).map((line) => line.text.trim()).filter(Boolean).join(" | ").slice(0, 300);
}

/** The folder chip (or header) names the repository: a word of a main-area
 * line, not the whole line — OCR reads "nuria-platform main" as one line. */
export function showsFolder(lines: OcrLine[], repoName: string): boolean {
  const wanted = repoName.toLowerCase();
  return lines.some((line) => line.text.toLowerCase().split(/\s+/).some((word) => word.replace(/^[([•·"']+|[)\],;:"'•·]+$/g, "") === wanted));
}

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

/** An empty new session in `repoName` already on screen (a create that
 * stopped right after New Session): its own field, the folder chip and the
 * worktree option near the bottom, and no conversation above. */
export function emptyNewSession(lines: OcrLine[], size: { h: number }, repoName: string): OcrLine | null {
  const bottom = lines.filter((line) => line.y > size.h * 0.55);
  const field = bottom.find((line) => NEW_SESSION_PLACEHOLDER.test(line.text.trim()));
  if (!field || !showsFolder(bottom, repoName) || !findLine(bottom, /worktree/i)) return null;
  return field;
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
    const size = await driver.screenSize();
    const before = mainArea(await driver.ocr());
    // An earlier try already opened the new session and stopped there: go
    // on in it (New Session again would leave the same screen, read as a miss).
    const open = emptyNewSession(before, size, input.repoName);
    if (open) {
      stop = await guard(screen, "empty session field");
      if (stop) return stop;
      await act(screen, () => driver.click(open.x + 20, open.y + open.h / 2));
      await driver.sleep(300);
      return typeBrief(screen, input.text);
    }
    await act(screen, () => driver.menuNewSession());
    await driver.sleep(2_500);
    stop = await guard(screen, "new session");
    if (stop) return stop;
    const lines = mainArea(await driver.ocr());
    // A session that is already open shows the same folder and a "worktree"
    // word too: pasting there would send the brief into it. Require that
    // the screen changed (New Session opened) and read the folder and the
    // worktree option only near the composer, where a new session shows them.
    if (sameScreen(before, lines)) {
      return { ok: false, reason: "New Session did not open (the screen did not change)", retry: true, miss: true, touched: true, seen: seenText(lines.slice(-8)) };
    }
    const bottom = lines.filter((line) => line.y > size.h * 0.55);
    if (!showsFolder(bottom, input.repoName)) {
      return { ok: false, reason: `the new session did not open in ${input.repoName} (the app reuses the last folder picked in it; open one session there by hand once)`, retry: true, miss: true, touched: true, seen: seenText(bottom.slice(-8)) };
    }
    if (!findLine(bottom, /worktree/i)) return { ok: false, reason: "the new session shows no worktree option", retry: true, miss: true, touched: true, seen: seenText(bottom.slice(-8)) };
    return typeBrief(screen, input.text);
  });
}

/** Paste the brief into the new session's field, type the note, send. */
async function typeBrief(screen: Screen, text: string): Promise<DesktopStep> {
  const { driver } = screen;
  let stop = await guard(screen, "paste");
  if (stop) return stop;
  await act(screen, () => driver.paste(text, true));
  await driver.sleep(500);
  stop = await guard(screen, "note");
  if (stop) return stop;
  // Typed, not pasted: the app folds consecutive pastes into one pasted
  // block, and the session must see these words as the user's own.
  await act(screen, () => driver.typeText(` ${DESKTOP_BRIEF_NOTE}`));
  await driver.sleep(300);
  stop = await guard(screen, "send");
  if (stop) return stop;
  await act(screen, () => driver.key(RETURN));
  return { ok: true };
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
    if (input.title && !lines.some((line) => sidebarMatch(line.text, input.title!)) && !headerNames(lines.filter((line) => line.y < 140), input.title)) {
      return { ok: false, reason: `the session "${input.title}" is not the one on screen`, retry: true, miss: true, touched: true, seen: seenText(lines.filter((line) => line.y < 140)) };
    }
    const composer = findComposer(lines, size);
    if (!composer) return { ok: false, reason: "the session's message field was not found", retry: true, miss: true, touched: true, seen: seenText(lines.filter((line) => line.y > size.h / 2).slice(-8)) };
    const field = composer.line;
    // Text in the field may be the person's own unsent draft: it is never
    // overwritten. OCR cannot tell an app suggestion from a draft safely
    // (same place, colour lost), so any text there stops the send; the
    // caller asks the person and tries again later.
    if (composer.text !== null) {
      return { ok: false, reason: `há texto não enviado no campo desta sessão ("${composer.text.slice(0, 120)}"); não sobrescrevi`, retry: true, touched: true, draft: composer.text.slice(0, 500) };
    }
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
      await act(screen, () => driver.typeText(` ${DESKTOP_MESSAGE_NOTE}`));
      await driver.sleep(300);
    }
    const prefix = textPrefix(input.text);
    const typed = nearField(await driver.ocr());
    // In the field: its first words show, or at least the placeholder (or the
    // text that was there) gave way.
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

/** The bar under the message field: the mode ("Automático") and the model ("Opus 5.5"). */
const COMPOSER_BAR = /^(Automático|Automatic|Auto|Pedir aprova[çc][ãa]o|Ask|Plan|Planejar|Bypass\b.*|Aceitar edi[çc][õo]es|Accept edits)$|\b(Opus|Sonnet|Haiku|Fable)\s*\d/i;

/** The session's message field, found as a person would: its placeholder
 * when it is empty, else the line right above the mode/model bar — where an
 * unsent draft sits ("pode reescrever o corpo…"), never overwritten.
 * `text` is what was in it then (null when it showed the placeholder). */
export function findComposer(lines: OcrLine[], size: { h: number }): { line: OcrLine; text: string | null } | null {
  const lower = lines.filter((line) => line.y > size.h / 2);
  const empty = lower.find((line) => COMPOSER_PLACEHOLDER.test(line.text.trim()));
  if (empty) return { line: empty, text: null };
  const bar = lower.filter((line) => COMPOSER_BAR.test(line.text.trim())).sort((a, b) => a.y - b.y)[0];
  if (!bar) return null;
  const above = lower
    .filter((line) => line.y < bar.y - 4 && bar.y - line.y <= 90 && line.text.trim())
    // the PR/branch strip above the field is not the field
    .filter((line) => !/^#\d+\b|[+]\d+\s*-\d+|\bCI\b/.test(line.text.trim()))
    .sort((a, b) => b.y - a.y)[0];
  return above ? { line: above, text: above.text.trim() } : null;
}

/** Normalised title prefix the sidebar shows (it truncates long titles). */
export function sidebarMatch(lineText: string, title: string): boolean {
  const wanted = titleForms(title)[0]!;
  if (wanted.length < 6) return false;
  const prefix = wanted.slice(0, Math.min(24, wanted.length));
  return titleForms(lineText).some((shown) => shown.length >= 6 && (shown.startsWith(prefix) || (shown.length >= 12 && wanted.startsWith(shown))));
}

const words = (text: string) => normalize(text).split(/[^\p{L}\p{N}#]+/u).filter((word) => word.length >= 3);

/** The session's header, as the app really draws it: the title cut short
 * ("Chat ticket agent/cli…"), a status dot or icon before it, the dropdown
 * and "(repo)" after it. Enough of the title's leading words must be there,
 * in a header line, for it to count. */
export function headerNames(header: OcrLine[], title: string): boolean {
  const wanted = words(title).slice(0, 6);
  if (wanted.length < 2) return false;
  return header.some((line) => {
    const shown = words(line.text);
    // the last word shown may be cut ("labe…"): a prefix of the wanted one counts
    const hits = wanted.filter((word) => shown.some((seen) => seen === word || (seen.length >= 3 && word.startsWith(seen))));
    return hits.length >= Math.min(wanted.length, Math.max(2, Math.ceil(wanted.length * 0.6))) && shown.slice(0, 2).some((seen) => wanted[0]!.startsWith(seen) || seen === wanted[0]);
  });
}

/** The same title, dot and icon aside (for telling duplicates apart). */
function sameTitle(lineText: string, title: string): boolean {
  const wanted = titleForms(title)[0]!;
  return titleForms(lineText).some((shown) => shown === wanted || shown.startsWith(`${wanted} v `) || shown.startsWith(`${wanted} (`));
}

type MenuItems = readonly string[];
const ARCHIVE_ITEMS: MenuItems = ["Arquivar", "Archive"];
const RENAME_ITEMS: MenuItems = ["Renomear", "Rename"];

/**
 * One item of a session's menu. The session is opened by its own link and
 * checked by its title in the header; the header's dropdown is tried first
 * (it is always on screen, while the sidebar shows only ~20 of 130+
 * sessions), the sidebar entry's right-click menu only as a fallback.
 * `then` runs after the item was clicked (rename types the new name).
 */
async function sessionMenuAction(
  driver: DesktopDriver,
  input: { localId: string; title: string },
  items: MenuItems,
  verb: string,
  then?: (screen: Screen) => Promise<DesktopStep | null>,
): Promise<DesktopStep> {
  if (!/^local_[0-9a-f-]{36}$/.test(input.localId)) return { ok: false, reason: "invalid desktop session id", retry: false };
  const isItem = (line: OcrLine) => items.includes(line.text.trim());
  return withScreen(driver, async (screen) => {
    await act(screen, () => driver.openUrl(`claude://code/continue?session=${input.localId}`));
    await driver.sleep(2_500);
    let stop = await guard(screen, "open session");
    if (stop) return stop;
    const screenLines = await driver.ocr();
    const header = mainArea(screenLines).find((line) => line.y < 140 && sidebarMatch(line.text, input.title));
    const finish = async (): Promise<DesktopStep> => {
      const after = then ? await then(screen) : null;
      if (after) return after;
      await driver.sleep(1_000);
      return { ok: true };
    };
    if (header) {
      stop = await guard(screen, "header menu");
      if (stop) return stop;
      await act(screen, () => driver.click(header.x + 20, header.y + header.h / 2));
      await driver.sleep(800);
      const item = (await driver.ocr()).find((line) => isItem(line) && line.y > header.y && line.y - header.y < 400);
      stop = await guard(screen, `${verb} menu`);
      if (stop) return stop;
      if (item) {
        await act(screen, () => driver.click(item.x + item.w / 2, item.y + item.h / 2));
        return finish();
      }
      await act(screen, () => driver.key(ESCAPE));
      await driver.sleep(300);
    }
    // Fallback: the sidebar entry. Titles repeat there ("Relatorio nightly"
    // fifteen times): act only on one unambiguous entry.
    const sidebar = screenLines.filter((line) => line.x < SIDEBAR_MAX_X);
    const matches = sidebar.filter((line) => sidebarMatch(line.text, input.title));
    if (!matches.length) {
      return { ok: false, reason: `"${input.title}" is neither in the open session's header menu nor visible in the app's sidebar`, retry: true, miss: true, touched: true, seen: seenText([...mainArea(screenLines).filter((line) => line.y < 140), ...sidebar]) };
    }
    const exact = matches.filter((line) => sameTitle(line.text, input.title));
    const entry = matches.length === 1 ? matches[0]! : exact.length === 1 ? exact[0]! : null;
    if (!entry) {
      return { ok: false, reason: `${matches.length} sessions in the app's sidebar match "${input.title}", so it cannot tell which to ${verb}; ${verb} it by hand in the Claude app`, retry: false, touched: true };
    }
    stop = await guard(screen, "session menu");
    if (stop) return stop;
    await act(screen, () => driver.rightClick(entry.x + 30, entry.y + entry.h / 2));
    await driver.sleep(800);
    const item = (await driver.ocr()).find((line) => isItem(line) && Math.abs(line.y - entry.y) < 400);
    stop = await guard(screen, `${verb} menu`);
    if (stop) return stop; // the Claude app is not in front (or the person is back): no Escape into their app
    if (!item) {
      await act(screen, () => driver.key(ESCAPE));
      return { ok: false, reason: `the session menu showed no ${items[1]} item`, retry: true, miss: true, touched: true };
    }
    await act(screen, () => driver.click(item.x + item.w / 2, item.y + item.h / 2));
    return finish();
  });
}

/** Archive a session in the app, from its own menu. */
export async function archiveDesktopSession(driver: DesktopDriver, input: { localId: string; title: string }): Promise<DesktopStep> {
  return sessionMenuAction(driver, input, ARCHIVE_ITEMS, "archive");
}

/** Rename a session in the app ("#9311 Chat no ticket…"), from its own menu.
 * Nothing is pasted unless the menu closed and the title is still on show
 * in the upper half (the edit field) with the message field untouched below;
 * Return is pressed only when the new title shows up there and the message
 * field is still empty — otherwise the title would go to the session as a
 * message. What was pasted where it should not be is cleared, and the step
 * is not retried. Success here is only a click: the caller re-reads the
 * app's record for the new title. */
export async function renameDesktopSession(driver: DesktopDriver, input: { localId: string; title: string; newTitle: string }): Promise<DesktopStep> {
  return sessionMenuAction(driver, input, RENAME_ITEMS, "rename", async (screen) => {
    await driver.sleep(500);
    let stop = await guard(screen, "rename field");
    if (stop) return stop;
    const size = await driver.screenSize();
    const upper = (lines: OcrLine[]) => lines.filter((line) => line.y < size.h / 2);
    // The message field as it was before anything was pasted: empty, or
    // holding a suggestion/draft. Unchanged afterwards = nothing went into it.
    const fieldOf = (lines: OcrLine[]) => {
      const main = mainArea(lines);
      if (main.some((line) => line.y > size.h / 2 && NEW_SESSION_PLACEHOLDER.test(line.text.trim()))) return { text: null as string | null };
      const composer = findComposer(main, size);
      return composer ? { text: composer.text } : null;
    };
    const opened = await driver.ocr();
    const fieldBefore = fieldOf(opened);
    const composerEmpty = (lines: OcrLine[]) => {
      const now = fieldOf(lines);
      return Boolean(now && fieldBefore && now.text === fieldBefore.text);
    };
    // a draft in the message field: a title pasted by mistake would land
    // on it, and clearing that would take the draft too
    if (fieldBefore?.text) {
      await act(screen, () => driver.key(ESCAPE));
      return { ok: false, reason: `há texto não enviado no campo desta sessão ("${fieldBefore.text.slice(0, 120)}"); não renomeei para não arriscar o rascunho`, retry: true, touched: true, draft: fieldBefore.text.slice(0, 500) };
    }
    const menuOpen = opened.some((line) => RENAME_ITEMS.includes(line.text.trim()));
    if (menuOpen || !upper(opened).some((line) => sidebarMatch(line.text, input.title)) || !composerEmpty(opened)) {
      await act(screen, () => driver.key(ESCAPE));
      return { ok: false, reason: "the rename field did not open (nothing was typed)", retry: false, touched: true, seen: seenText(upper(opened)) };
    }
    await act(screen, () => driver.paste(input.newTitle, true));
    await driver.sleep(400);
    stop = await guard(screen, "rename confirm");
    if (stop) return stop;
    const typed = await driver.ocr();
    const prefix = textPrefix(input.newTitle);
    if (!composerEmpty(typed)) {
      // it went into the message field: take it out again, never send it
      await act(screen, () => driver.key(KEY_A, true));
      await act(screen, () => driver.key(BACKSPACE));
      return { ok: false, reason: "the new title went into the message field instead of a rename field; it was cleared and not sent", retry: false, touched: true };
    }
    if (!showsPrefix(upper(typed), prefix)) {
      await act(screen, () => driver.key(ESCAPE));
      return { ok: false, reason: "the new title did not show in a rename field; nothing was confirmed", retry: false, touched: true, seen: seenText(upper(typed)) };
    }
    await act(screen, () => driver.key(RETURN));
    return null;
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
  /** The app's own summary of a turn: status_category "blocked" means it waits
   * on someone. It is written after the turn, and summarizes_uuid names the
   * assistant message it is about. */
  postTurnSummary?: { status_category?: string; needs_action?: unknown; summarizes_uuid?: string; [key: string]: unknown };
  /** The session's latest assistant message. */
  lastAssistantUuid?: string;
  /** Set on runs of the app's scheduled tasks (routines). */
  scheduledTaskId?: string;
}

/** Is the app's summary about the latest turn (and not still the previous one's)? */
export function summaryIsCurrent(record: Pick<DesktopRecord, "postTurnSummary" | "lastAssistantUuid">): boolean {
  const about = record.postTurnSummary?.summarizes_uuid;
  return !about || !record.lastAssistantUuid || about === record.lastAssistantUuid;
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
export function recordBlocked(record: Pick<DesktopRecord, "postTurnSummary" | "lastAssistantUuid">): string | null {
  const summary = record.postTurnSummary;
  // A summary of an earlier turn says nothing about this one.
  if (!summary || summary.status_category !== "blocked" || !summaryIsCurrent(record)) return null;
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

/** The repository a session's folder belongs to (a worktree's parent repo). */
export function repoOf(record: Pick<DesktopRecord, "cwd" | "worktreePath">): string | undefined {
  const folder = record.worktreePath ?? record.cwd;
  if (!folder) return undefined;
  const at = folder.indexOf("/.claude/worktrees/");
  return at >= 0 ? folder.slice(0, at) : folder;
}

/** A session whose folder was not picked for work: a run of a scheduled
 * task (it opens in its own folder) or a scratch workspace. */
export function notPickedFolder(record: Pick<DesktopRecord, "scheduledTaskId" | "cwd">): boolean {
  return Boolean(record.scheduledTaskId) || Boolean(record.cwd?.includes("/scratch-workspaces/"));
}

/** The repository of the app's most recent work session: New Session opens
 * in the last folder picked, whatever we would like. Scheduled runs and
 * scratch sessions do not move that folder, so they are skipped. */
export function lastAppRepo(dir = DESKTOP_SESSIONS_DIR): string | undefined {
  let newest: DesktopRecord | null = null;
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (record && !notPickedFolder(record) && (record.createdAt ?? 0) > (newest?.createdAt ?? -1)) newest = record;
  }
  return newest ? repoOf(newest) : undefined;
}

/** App sessions, not archived (or archived too), working in `folder` (the app reuses worktrees). */
export function recordsUsingFolder(folder: string, exceptLocalId?: string, dir = DESKTOP_SESSIONS_DIR, includeArchived = false): DesktopRecord[] {
  const found: DesktopRecord[] = [];
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (!record || (record.isArchived && !includeArchived) || record.sessionId === exceptLocalId) continue;
    if (record.cwd === folder || record.worktreePath === folder) found.push(record);
  }
  return found;
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

/** Did our message reach the session? A user event written after `since`
 * (5 s of clock slack) carries its first line. Older messages and the
 * assistant's own words do not count: openings like "Chief aqui." repeat. */
export function transcriptMentions(transcript: string, text: string, since = 0): boolean {
  const first = text.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 60);
  if (!first) return false;
  const needle = JSON.stringify(first).slice(1, -1);
  let raw = "";
  try {
    raw = readFileSync(transcript, "utf8").slice(-2_000_000);
  } catch {
    return false;
  }
  const lines = raw.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"user"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; timestamp?: string; message?: { content?: unknown } };
      if (event.type !== "user") continue;
      const at = event.timestamp ? Date.parse(event.timestamp) : NaN;
      if (Number.isFinite(at) && at < since - 5_000) return false;
      if (JSON.stringify(event.message?.content ?? "").includes(needle)) return true;
    } catch { /* partial line */ }
  }
  return false;
}

/** Did the session's last turn end? Its transcript's latest event closes a
 * turn (the stop hook's summary, or an assistant message that ended the turn). */
export function transcriptTurnEnded(transcript: string): boolean {
  let raw = "";
  try {
    raw = readFileSync(transcript, "utf8").slice(-400_000);
  } catch {
    return false;
  }
  const lines = raw.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as { type?: string; subtype?: string; message?: { stop_reason?: string } };
      if (event.type === "system" && (event.subtype === "stop_hook_summary" || event.subtype === "turn_duration")) return true;
      if (event.type === "assistant") return event.message?.stop_reason === "end_turn";
      if (event.type === "user") return false;
      // other system/meta lines: look further back
    } catch { /* partial line */ }
  }
  return false;
}

/** A question the session asked in the app (AskUserQuestion) that nobody
 * has answered: its tool_use has no tool_result after it. The session is
 * stopped on it and reads nothing else until someone answers in the app. */
export function transcriptOpenQuestion(transcript: string): { id: string; text: string } | null {
  let raw = "";
  try {
    raw = readFileSync(transcript, "utf8").slice(-1_000_000);
  } catch {
    return null;
  }
  const answered = new Set<string>();
  const lines = raw.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as { type?: string; message?: { content?: unknown } };
      const content = Array.isArray(event.message?.content) ? event.message!.content as Array<Record<string, unknown>> : [];
      if (event.type === "user") {
        for (const part of content) if (part?.type === "tool_result" && typeof part.tool_use_id === "string") answered.add(part.tool_use_id);
        continue;
      }
      if (event.type !== "assistant") continue;
      const ask = content.find((part) => part?.type === "tool_use" && part.name === "AskUserQuestion");
      if (!ask) continue;
      const id = String(ask.id ?? "");
      if (answered.has(id)) return null;
      return { id, text: questionText(ask.input) };
    } catch { /* partial line */ }
  }
  return null;
}

function questionText(input: unknown): string {
  const questions = (input as { questions?: Array<{ question?: unknown; options?: Array<{ label?: unknown }> }> } | undefined)?.questions;
  if (!Array.isArray(questions) || !questions.length) return JSON.stringify(input ?? "").slice(0, 1_000);
  return questions.map((item) => {
    const options = Array.isArray(item.options) ? item.options.map((option) => String(option?.label ?? "")).filter(Boolean) : [];
    return `${String(item.question ?? "").trim()}${options.length ? ` [opções: ${options.join(" / ")}]` : ""}`;
  }).join("\n").slice(0, 2_000);
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
    async typeText(text) {
      const file = join(tmpdir(), `omb-desktop-type-${process.pid}-${Date.now()}.txt`);
      writeFileSync(file, text, { mode: 0o600 });
      try {
        await run(helper, ["type", file], env);
      } finally {
        rmSync(file, { force: true });
      }
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
