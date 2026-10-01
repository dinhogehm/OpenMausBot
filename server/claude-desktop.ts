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
export type DesktopStep = { ok: true; suggestion?: string } | DesktopStop;
/** `draft`: text nobody sent sits in the field (never typed over);
 * `leftProbe`: the probe "." stayed at its end (the person came back first). */
export type DesktopStop = { ok: false; reason: string; retry: boolean; miss?: boolean; touched?: boolean; human?: boolean; seen?: string; draft?: string; leftProbe?: boolean };

const RETURN = 36;
const ESCAPE = 53;
/** The sidebar sits on the left; menus open next to the click. */
const SIDEBAR_MAX_X = 450;
/** A person's input newer than our own last action by more than this is theirs. */
const HUMAN_SLACK_MS = 500;
/** The empty message field's placeholder: its exact text as the whole OCR
 * line ("Responder…", never "Responder ao cliente…"), and only where the
 * field is (see findComposer) — a line of the conversation is not it. */
const COMPOSER_PLACEHOLDER = /^(Digite \/ para comandos|Type \/ for commands|Responder|Reply)(?:\s*(?:…|\.{3}))?$/i;
/** The field of a new, empty session ("Descreva uma tarefa ou faça uma pergunta"). */
const NEW_SESSION_PLACEHOLDER = /^(Descreva uma tarefa|Describe a task)\b/i;
const BACKSPACE = 51;
/** The one character typed to tell an app suggestion from a draft. */
const SUGGESTION_PROBE = ".";
/** The probe character as OCR may read it alone in a field ("." "·" "," …): ours, never the person's. */
const PROBE_LEFTOVER = /^[.·,'`]$/;
const KEY_A = 0;
/** With Command: to the end of the text, whatever line the click landed on. */
const DOWN_ARROW = 125;

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

async function guard(screen: Screen, step: string): Promise<DesktopStop | null> {
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

/** The new session's chip names a session's own branch ("claude/…", or a
 * live session's worktree): the app is about to reuse that worktree, and
 * the brief would start work in another session's folder. */
export function reusedWorktreeChip(lines: OcrLine[], liveNames: readonly string[] = []): string | null {
  const names = new Set(liveNames.map((name) => name.toLowerCase()).filter((name) => name.length >= 6));
  for (const line of lines) {
    for (const raw of line.text.split(/\s+/)) {
      const word = raw.replace(/^[([•·"']+|[)\],;:"'•·]+$/g, "");
      const lower = word.toLowerCase();
      if (/^claude\/[\w.-]+$/.test(lower) || names.has(lower) || names.has(lower.split("/").pop() ?? "")) return word;
    }
  }
  return null;
}

/** The new session's row of chips — "• Local | nuria-platform | gº main |
 * v worktree" on the real screen (R8, 01/10), all within a few points of
 * the same y — found by its worktree option. Nothing else on the screen
 * (the "Sessões" list, a date, a conversation) is a chip. */
export function chipRow(lines: OcrLine[]): OcrLine[] {
  const option = lines.filter((line) => /\bworktree\b/i.test(line.text)).sort((a, b) => b.y - a.y)[0];
  return option ? lines.filter((line) => Math.abs(line.y - option.y) <= 12) : [];
}

/** Why the new session's chips do not show the repository's own root (its
 * base branch): a branch of other work ("fix/9326-…", "claude/…"), a
 * detached HEAD (a bare sha, "HEAD") or no base branch at all. null when the
 * branch chip shows the base ("main", "origin/main").
 *
 * What this does NOT cover: the branch chip is the base the new worktree
 * starts from, not the folder's checkout — on 01/10 the root of
 * nuria-platform was on a detached HEAD and the chip still read "main"
 * (R8-visual-claude-1). No capture exists of a new session in a reused
 * folder, so it may well read "main" there too. The guards that count for
 * folder reuse are the server's 409 (lastAppWorktreeFolder) before the
 * screen is touched, and reusedWorktree when the session is adopted. */
export function notRepoRoot(lines: OcrLine[], baseBranch = "main"): string | null {
  const words = chipRow(lines).flatMap((line) => line.text.split(/\s+/)).map((raw) => raw.replace(/^[([•·"']+|[)\],;:"'•·…]+$/g, "")).filter(Boolean);
  const base = baseBranch.toLowerCase();
  const isBase = (lower: string) => lower === base || lower === `origin/${base}`;
  const other = words.find((word) => {
    const lower = word.toLowerCase();
    if (isBase(lower) || /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(lower)) return false;
    return /^[\w.-]+\/[\w./-]+$/.test(lower) || (/^[0-9a-f]{7,40}$/.test(lower) && /\d/.test(lower)) || lower === "head" || lower.startsWith("detached");
  });
  if (other) return `it shows ${other}, not ${baseBranch}`;
  if (!words.some((word) => isBase(word.toLowerCase()))) return `it does not show the base branch ${baseBranch}`;
  return null;
}

/** The new session's own screen still up: its placeholder, or its row of
 * chips (Local or the folder, with the worktree option). */
function newSessionScreen(lines: OcrLine[], repoName: string): boolean {
  if (lines.some((line) => NEW_SESSION_PLACEHOLDER.test(line.text.trim()))) return true;
  const row = chipRow(lines);
  return row.length >= 2 && (row.some((line) => /^\W*Local$/i.test(line.text.trim())) || showsFolder(row, repoName));
}

/**
 * New session in the Claude app for `repoName`, brief pasted and sent.
 * The app opens a new session in the last folder used; if that is not the
 * repository (or the worktree option is not there), stop and retry later.
 */
export async function createDesktopSession(driver: DesktopDriver, input: { repoName: string; text: string; liveWorktrees?: readonly string[]; baseBranch?: string }): Promise<DesktopStep> {
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
    const reused = (lines: OcrLine[]) => {
      const bottom = lines.filter((line) => line.y > size.h * 0.55);
      const chip = reusedWorktreeChip(chipRow(bottom), input.liveWorktrees);
      const why = chip ? `it shows ${chip}, another session's worktree` : notRepoRoot(bottom, input.baseBranch);
      return why ? { ok: false as const, reason: `the new session is not in the root of ${input.repoName} (${why}); nothing was typed. ${ROOT_SESSION_HOWTO(input.repoName, input.baseBranch ?? "main")}`, retry: true, miss: true, touched: true, seen: seenText(bottom.slice(-8)) } : null;
    };
    if (open) {
      const refusal = reused(before);
      if (refusal) return refusal;
      stop = await guard(screen, "empty session field");
      if (stop) return stop;
      await act(screen, () => driver.click(open.x + 20, open.y + open.h / 2));
      await driver.sleep(300);
      return typeBrief(screen, input.text, size, input.repoName);
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
    const refusal = reused(lines);
    if (refusal) return refusal;
    return typeBrief(screen, input.text, size, input.repoName);
  });
}

/** What the person does so New Session opens in the repository's root
 * again. A session must SEND something to exist: of the app's 390 records
 * on 01/10 none is of a session closed without a message (every one has a
 * title, which the app takes from the first message), so "open one and
 * close it" leaves the app's last folder where it was. */
export const ROOT_SESSION_HOWTO = (repoName: string, baseBranch: string) =>
  `In the Claude app, start one new session in ${repoName} itself (folder ${repoName}, branch ${baseBranch}, worktree on) and send it a short message — the app records a session only once something is sent; it may be archived afterwards. Then this create runs`;

/** Paste the brief into the new session's field, type the note, send. */
async function typeBrief(screen: Screen, text: string, size: { h: number }, repoName: string): Promise<DesktopStep> {
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
  // Sent only on positive proof that the new-session screen is gone: no
  // placeholder and no row of chips (Local | repo | worktree), with the
  // composer's bar read (an empty or half-drawn OCR proves nothing). The
  // brief's own words are not looked for: the app may fold a long brief
  // into a pasted block that does not show them. On 01/10 one "create ok"
  // lost its brief and nothing said so for 5 minutes (R8-dispatch D5).
  await driver.sleep(1_500);
  const after = mainArea(await driver.ocr()).filter((line) => line.y > size.h * 0.55);
  if (newSessionScreen(after, repoName)) {
    return { ok: false, reason: "the brief did not leave the new session's screen after Return (its field or chips are still there)", retry: true, touched: true, seen: seenText(after.slice(-8)) };
  }
  if (!after.some((line) => COMPOSER_MODE.test(line.text.trim()) || COMPOSER_MODEL.test(line.text.trim())) && !placeholderShown(after, size, repoName)) {
    return { ok: false, reason: "could not read the screen after Return to confirm the brief left the new session's field", retry: true, touched: true, seen: seenText(after.slice(-8)) };
  }
  return { ok: true };
}

/**
 * Reopen a session with the app's own link and send `text` into it. The
 * session's title must be on screen, the text must show up in its field,
 * and the field must empty after Return; otherwise the step is retried.
 */
export async function sendToDesktopSession(driver: DesktopDriver, input: { localId: string; text: string; title?: string; repoName?: string }): Promise<DesktopStep> {
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
    const composer = findComposer(lines, size, input.repoName);
    if (!composer) return { ok: false, reason: "the session's message field was not found", retry: true, miss: true, touched: true, seen: seenText(lines.filter((line) => line.y > size.h / 2).slice(-8)) };
    const field = composer.line;
    // What is near the field (it grows upwards as text goes in).
    const nearField = (all: OcrLine[]) => mainArea(all).filter((line) => line.y > Math.max(size.h / 2, field.y - 200));
    stop = await guard(screen, "click field");
    if (stop) return stop;
    await act(screen, () => driver.click(field.x + 20, field.y + field.h / 2));
    await driver.sleep(300);
    // A lone "." (or how OCR reads it alone: "·", ",") is the probe of an earlier try that stopped right after it
    // (the suggestion had given way): ours to replace. Any other text is
    // probed — a draft is never typed over (see probeField).
    if (composer.text !== null && !PROBE_LEFTOVER.test(composer.text)) {
      const probe = await probeField(screen, { ...composer, text: composer.text }, lines, size, input.repoName);
      if (probe.kind !== "suggestion") return probe.step;
    }
    stop = await guard(screen, "paste");
    if (stop) return composer.text !== null ? { ...stop, reason: `${stop.reason}; the app's suggestion had given way to a "." in the field` } : stop;
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
    if (!showsPrefix(typed, prefix) && placeholderShown(typed, size, input.repoName)) {
      return { ok: false, reason: "the message did not appear in the session's field", retry: true, touched: true };
    }
    stop = await guard(screen, "send");
    if (stop) return stop;
    await act(screen, () => driver.key(RETURN));
    await driver.sleep(1_500);
    const after = nearField(await driver.ocr());
    // the placeholder counts only where the field is: a "Responder…" of the conversation proves nothing
    if (!placeholderShown(after, size, input.repoName) && showsPrefix(after, prefix)) {
      return { ok: false, reason: "the message stayed in the field after Return", retry: true, touched: true };
    }
    return composer.text !== null && !PROBE_LEFTOVER.test(composer.text) ? { ok: true, suggestion: composer.text.slice(0, 300) } : { ok: true };
  });
}

/** The mode under the message field, as the whole OCR line: at most three
 * short icon tokens before it ("+ O v Ignorar permissões", "+ Q v
 * Automático" — the real bar), never a sentence that ends in "plan". */
export const COMPOSER_MODE = /^(?:\+\s*)?(?:\S{1,2}\s+){0,3}(Automático|Automatic|Auto|Pedir aprova[çc][ãa]o|Ask|Plan|Planejar|Ignorar permiss[õo]es|Bypass permissions|Aceitar edi[çc][õo]es|Accept edits)$/i;
/** The model on the right of that bar ("Opus 5.5", cut to "Opus" at times). */
const COMPOSER_MODEL = /^(Opus|Sonnet|Haiku|Fable)(\s*\d[\d.]*)?$/i;
/** The field's text starts where the mode bar starts (x 547 against 543 on
 * the real screen); the branch strip and the diff/CI chips do not. */
const COMPOSER_COLUMN_SLACK = 40;
/** Buttons and chips of the PR strip above the field: never a field to click. */
const STRIP_OR_BUTTON = /^(?:(?:Criar|Create|Ver|View|Abrir|Open|Revisar|Review) PR|Mesclar(?: PR)?|Merge(?: PR)?)$|^\S{0,2}\s*#\d+$|[+]\d+\s*-\s*\d+|^\W*CI\b|^[Xx×]$/;

/** The PR strip's "repo branch" line ("nuria-platform fix/9326-…"): it names the repository. */
function stripLine(text: string, repoName?: string): boolean {
  if (STRIP_OR_BUTTON.test(text)) return true;
  return Boolean(repoName) && /\S\/\S/.test(text) && showsFolder([{ x: 0, y: 0, w: 0, h: 0, text }], repoName!);
}

/** The session's message field, found as a person would: the line right
 * above the mode bar, in its column (±40 pt, up to 90 pt above it) — its
 * placeholder when it is empty, else where an unsent draft sits ("pode
 * reescrever o corpo…"), never overwritten. A placeholder-like line
 * anywhere else ("Responder ao cliente…" in the conversation) is not the
 * field (INSP-D D1). When that closest line is a button or the PR strip
 * ("Criar PR", "+114 - 4") there is no field to click: null. `text` is what
 * was in it then (null when it showed the placeholder); `bar` is the mode line. */
export function findComposer(lines: OcrLine[], size: { h: number }, repoName?: string): { line: OcrLine; text: string | null; bar: OcrLine } | null {
  const lower = lines.filter((line) => line.y > size.h / 2);
  // the lowest mode line: the composer is at the bottom, the conversation above it
  const bar = lower.filter((line) => COMPOSER_MODE.test(line.text.trim())).sort((a, b) => b.y - a.y)[0];
  if (!bar) return null;
  const above = lower
    .filter((line) => line.y < bar.y - 4 && bar.y - line.y <= 90 && line.text.trim() && Math.abs(line.x - bar.x) <= COMPOSER_COLUMN_SLACK)
    .sort((a, b) => b.y - a.y)[0];
  if (!above) return null;
  if (COMPOSER_PLACEHOLDER.test(above.text.trim())) return { line: above, text: null, bar };
  if (stripLine(above.text.trim(), repoName)) return null;
  return { line: above, text: above.text.trim(), bar };
}

/** The field shows its placeholder, read where the field is. */
function placeholderShown(lines: OcrLine[], size: { h: number }, repoName?: string): boolean {
  return findComposer(lines, size, repoName)?.text === null;
}

/** The field emptied while the rest of the composer stayed put: the mode bar
 * where it was, nothing in the field's column above it, and the other lower
 * lines still there (a screen being redrawn is not an empty field). */
function fieldEmptied(before: OcrLine[], after: OcrLine[], field: OcrLine, bar: OcrLine, size: { h: number }): boolean {
  const lower = (lines: OcrLine[]) => lines.filter((line) => line.y > size.h / 2);
  const barNow = lower(after).find((line) => COMPOSER_MODE.test(line.text.trim()) && Math.abs(line.y - bar.y) <= 6);
  if (!barNow) return false;
  const inField = lower(after).some((line) => line.y < barNow.y - 4 && barNow.y - line.y <= 90 && line.text.trim() && Math.abs(line.x - barNow.x) <= COMPOSER_COLUMN_SLACK && !stripLine(line.text.trim()));
  if (inField) return false;
  const rest = lower(before).filter((line) => line !== field);
  const seen = new Set(lower(after).map((line) => normalize(line.text)));
  return rest.length > 0 && rest.filter((line) => seen.has(normalize(line.text))).length / rest.length >= 0.8;
}

/** `probed`: the probe key was typed (and is in the field now). */
type Probe = { kind: "suggestion"; probed: boolean } |{ kind: "draft"; step: DesktopStep } | { kind: "stop"; step: DesktopStep };

/**
 * Text in the field is either the app's suggested reply (shown there until
 * the first keystroke) or the person's own unsent draft. OCR sees no colour,
 * so one character tells them apart — with the cursor at the END of the
 * text first (a click lands a few letters in, and a probe there would split
 * a word: "po.de reescrever…"). It is a suggestion only on positive proof:
 * the field, read again, shows just the probe character, or the placeholder,
 * or is visibly empty with the composer otherwise unchanged. Anything else —
 * the text still there, changed, unreadable — is a draft: the character is
 * taken back, and if the person comes back before that, the draft is
 * returned saying a "." was left at its end.
 *
 * Absence of the text is evidence only when it is stable: the field must
 * read the same text twice before the key, and BOTH readings after it
 * (300 ms apart) must show it gave way. One OCR that skipped the draft's
 * line would otherwise let the paste replace the draft (INSP-D B2).
 */
async function probeField(screen: Screen, composer: { line: OcrLine; text: string; bar?: OcrLine }, before: OcrLine[], size: { h: number }, repoName?: string): Promise<Probe> {
  const { driver } = screen;
  const draftStep = (reason: string): DesktopStop => ({ ok: false, reason, retry: true, touched: true, draft: composer.text.slice(0, 500) });
  // the field's text, read a second time before anything is typed
  const again = findComposer(mainArea(await driver.ocr()), size, repoName);
  // The app hid its suggestion once the field took focus: the placeholder
  // shows, the field is empty, nothing of the person's is there — no probe
  // key, the message goes as into any empty field (INSP-D C1).
  if (again !== null && again.text === null) return { kind: "suggestion", probed: false };
  if (again?.text !== composer.text) {
    return { kind: "stop", step: { ok: false, reason: `the message field read differently twice ("${composer.text.slice(0, 40)}…", then "${(again?.text ?? "nothing").slice(0, 40)}"); nothing was typed`, retry: true, miss: true, touched: true } };
  }
  let stop = await guard(screen, "cursor to end");
  if (stop) return { kind: "stop", step: stop };
  await act(screen, () => driver.key(DOWN_ARROW, true));
  stop = await guard(screen, "probe field");
  if (stop) return { kind: "stop", step: stop };
  await act(screen, () => driver.typeText(SUGGESTION_PROBE));
  const gaveWayIn = (probed: OcrLine[]) => {
    const now = findComposer(probed, size, repoName);
    return (now !== null && (now.text === null || PROBE_LEFTOVER.test(now.text)))
      || (now === null && composer.bar !== undefined && fieldEmptied(before, probed, composer.line, composer.bar, size));
  };
  await driver.sleep(400);
  const first = gaveWayIn(mainArea(await driver.ocr()));
  await driver.sleep(300);
  const second = gaveWayIn(mainArea(await driver.ocr()));
  if (first && second) return { kind: "suggestion", probed: true };
  stop = await guard(screen, "undo probe");
  if (stop) {
    return { kind: "draft", step: { ...draftStep(`${stop.reason}; há texto não enviado no campo desta sessão ("${composer.text.slice(0, 40)}…") e deixei um "." no fim dele, que não consegui apagar`), human: stop.human, leftProbe: true } };
  }
  await act(screen, () => driver.key(BACKSPACE));
  return { kind: "draft", step: draftStep(`há texto não enviado no campo desta sessão ("${composer.text.slice(0, 40)}…"): é rascunho (não cedeu a uma tecla no fim dele); não sobrescrevi`) };
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
  // OCR can eat the first letter after the status dot: "nbox 503 diagnóstico
  // e recuperação v (nuria-platform" for "Inbox 503 …" (01/10 14:30Z)
  const sameStart = (seen: string, word: string) => seen === word || word.startsWith(seen) || (seen.length >= 3 && word.endsWith(seen));
  return header.some((line) => {
    const shown = words(line.text);
    // the last word shown may be cut ("labe…"): a prefix of the wanted one counts
    const hits = wanted.filter((word, i) => shown.some((seen) => seen === word || (seen.length >= 3 && word.startsWith(seen)) || (i === 0 && sameStart(seen, word))));
    return hits.length >= Math.min(wanted.length, Math.max(2, Math.ceil(wanted.length * 0.6))) && shown.slice(0, 2).some((seen) => sameStart(seen, wanted[0]!));
  });
}

/** The same title, dot and icon aside (for telling duplicates apart). */
function sameTitle(lineText: string, title: string): boolean {
  const wanted = titleForms(title)[0]!;
  return titleForms(lineText).some((shown) => shown === wanted || shown.startsWith(`${wanted} v `) || shown.startsWith(`${wanted} (`));
}

/** A session header: the title's start, or enough of its words, followed by
 * the app's dropdown and folder ("… v (nuria-platform"). */
export function isHeaderOf(line: OcrLine, title: string): boolean {
  const text = line.text.trim();
  if (!/\sv\s*\(|\(\s*[\w.-]+\s*$/.test(text) && !sidebarMatch(text, title)) return false;
  return sidebarMatch(text, title) || headerNames([line], title);
}

type MenuItems = readonly string[];
/** A menu item is a short line ("Renomear sessão")... */
const MENU_ITEM_MAX_CHARS = 30;
/** ...that opens next to the click that opened the menu. */
const MENU_ITEM_MAX_DX = 250;
const ARCHIVE_ITEMS: MenuItems = ["Arquivar", "Archive"];
const RENAME_ITEMS: MenuItems = ["Renomear", "Rename", "Editar título", "Edit title", "Editar nome", "Edit name"];

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
  then?: (screen: Screen, isItem: (line: OcrLine) => boolean) => Promise<DesktopStep | null>,
  /** Runs on the opened session before its menu: a step to stop with, or
   * whether it touched the screen (then the screen is read again). */
  before?: (screen: Screen, lines: OcrLine[]) => Promise<{ stop: DesktopStep } | { touched: boolean }>,
): Promise<DesktopStep> {
  if (!/^local_[0-9a-f-]{36}$/.test(input.localId)) return { ok: false, reason: "invalid desktop session id", retry: false };
  // the item as the app words it now ("Renomear", "Renomear sessão", "Rename
  // chat"…): a short line next to where the menu was opened — never a line of
  // the conversation that happens to start with "Renomear a sessão para…"
  let clickedX = 0;
  const isItem = (line: OcrLine) => {
    const text = line.text.trim();
    return text.length <= MENU_ITEM_MAX_CHARS && Math.abs(line.x - clickedX) <= MENU_ITEM_MAX_DX && items.some((item) => text === item || text.startsWith(`${item} `));
  };
  return withScreen(driver, async (screen) => {
    await act(screen, () => driver.openUrl(`claude://code/continue?session=${input.localId}`));
    await driver.sleep(2_500);
    let stop = await guard(screen, "open session");
    if (stop) return stop;
    let screenLines = await driver.ocr();
    // The session was opened by its own id: its header is the line at the
    // top that names it — matched by the start of the title or its words, at
    // any x (with the app's sidebar folded the header starts at the left
    // edge). On 01/10 "• Inbox 503 diagnóstico e recuperação v (nuria-platform"
    // was on screen and the rename still said the session was not.
    const headerIn = (lines: OcrLine[]) => lines.find((line) => line.y < 140 && isHeaderOf(line, input.title));
    let header = headerIn(screenLines);
    if (before) {
      // A step that clicks or types in the session's field (the rename's
      // probe) runs only once the header says this IS the session: a stale
      // link or a slow app leaves another one on screen (INSP-D B3).
      const notOnScreen = (lines: OcrLine[]): DesktopStep => ({ ok: false, reason: `the session "${input.title}" is not the one on screen (its header is not there); nothing was clicked or typed`, retry: true, miss: true, touched: true, seen: seenText(lines.filter((line) => line.y < 140)) });
      if (!header) return notOnScreen(screenLines);
      const early = await before(screen, screenLines);
      if ("stop" in early) return early.stop;
      if (early.touched) {
        screenLines = await driver.ocr();
        header = headerIn(screenLines);
        if (!header) return notOnScreen(screenLines);
      }
    }
    const finish = async (): Promise<DesktopStep> => {
      const after = then ? await then(screen, isItem) : null;
      if (after) return after;
      await driver.sleep(1_000);
      return { ok: true };
    };
    // what the menus showed, for a reason that says which items the app offers now
    let menuSeen = "";
    if (header) {
      stop = await guard(screen, "header menu");
      if (stop) return stop;
      clickedX = header.x + 20;
      await act(screen, () => driver.click(clickedX, header.y + header.h / 2));
      await driver.sleep(800);
      const menu = (await driver.ocr()).filter((line) => line.y > header.y && line.y - header.y < 400);
      const item = menu.find(isItem);
      stop = await guard(screen, `${verb} menu`);
      if (stop) return stop;
      if (item) {
        await act(screen, () => driver.click(item.x + item.w / 2, item.y + item.h / 2));
        return finish();
      }
      menuSeen = seenText(menu, 10);
      await act(screen, () => driver.key(ESCAPE));
      await driver.sleep(300);
    }
    // Fallback: the sidebar entry. Titles repeat there ("Relatorio nightly"
    // fifteen times): act only on one unambiguous entry.
    // (the header itself is not a sidebar entry, even with the sidebar folded)
    const sidebar = screenLines.filter((line) => line.x < SIDEBAR_MAX_X && line !== header);
    const matches = sidebar.filter((line) => sidebarMatch(line.text, input.title));
    if (!matches.length) {
      const where = header ? `its header menu showed no ${items[1]} item${menuSeen ? ` (it showed: ${menuSeen})` : ""}` : "it is not in the open session's header";
      return { ok: false, reason: `"${input.title}": ${where}, and it is not visible in the app's sidebar`, retry: true, miss: true, touched: true, seen: seenText([...screenLines.filter((line) => line.y < 140), ...sidebar]) };
    }
    const exact = matches.filter((line) => sameTitle(line.text, input.title));
    const entry = matches.length === 1 ? matches[0]! : exact.length === 1 ? exact[0]! : null;
    if (!entry) {
      return { ok: false, reason: `${matches.length} sessions in the app's sidebar match "${input.title}", so it cannot tell which to ${verb}; ${verb} it by hand in the Claude app`, retry: false, touched: true };
    }
    stop = await guard(screen, "session menu");
    if (stop) return stop;
    clickedX = entry.x + 30;
    await act(screen, () => driver.rightClick(clickedX, entry.y + entry.h / 2));
    await driver.sleep(800);
    const menu = (await driver.ocr()).filter((line) => Math.abs(line.y - entry.y) < 400);
    const item = menu.find(isItem);
    stop = await guard(screen, `${verb} menu`);
    if (stop) return stop; // the Claude app is not in front (or the person is back): no Escape into their app
    if (!item) {
      await act(screen, () => driver.key(ESCAPE));
      return { ok: false, reason: `the session menu showed no ${items[1]} item`, retry: true, miss: true, touched: true, seen: seenText(menu, 10) };
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
export async function renameDesktopSession(driver: DesktopDriver, input: { localId: string; title: string; newTitle: string; repoName?: string }): Promise<DesktopStep> {
  // The app's suggested reply in the message field is not a draft: proved
  // with the same probe as a send (before the menu opens), the suggestion
  // does not stop the rename. Only a proven draft does.
  let suggestion: string | null = null;
  const probeFirst = async (screen: Screen, lines: OcrLine[]): Promise<{ stop: DesktopStep } | { touched: boolean }> => {
    const size = await driver.screenSize();
    const main = mainArea(lines);
    const composer = findComposer(main, size, input.repoName);
    if (!composer || composer.text === null) return { touched: false };
    let stop = await guard(screen, "click field");
    if (stop) return { stop };
    await act(screen, () => driver.click(composer.line.x + 20, composer.line.y + composer.line.h / 2));
    await driver.sleep(300);
    let typed = true;
    if (!PROBE_LEFTOVER.test(composer.text)) {
      const probe = await probeField(screen, { ...composer, text: composer.text }, main, size, input.repoName);
      if (probe.kind !== "suggestion") return { stop: probe.step };
      typed = probe.probed;
    }
    suggestion = composer.text;
    // the suggestion hid on focus: no probe key was typed, nothing to take back
    if (!typed) return { touched: true };
    // take the probe back: the field is empty (or shows the suggestion again)
    stop = await guard(screen, "undo probe");
    if (stop) return { stop };
    await act(screen, () => driver.key(BACKSPACE));
    await driver.sleep(300);
    return { touched: true };
  };
  return sessionMenuAction(driver, input, RENAME_ITEMS, "rename", async (screen, isItem) => {
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
      const composer = findComposer(main, size, input.repoName);
      return composer ? { text: composer.text } : null;
    };
    const opened = await driver.ocr();
    const fieldBefore = fieldOf(opened);
    const composerEmpty = (lines: OcrLine[]) => {
      const now = fieldOf(lines);
      return Boolean(now && fieldBefore && now.text === fieldBefore.text);
    };
    // Text in the message field that the probe did not prove to be the
    // app's suggestion (it showed up after the probe): a title pasted by
    // mistake would land on it. Wait, without asking the person about a
    // draft nobody proved.
    if (fieldBefore?.text && fieldBefore.text !== suggestion) {
      await act(screen, () => driver.key(ESCAPE));
      // a miss: three of these and the person is asked to rename it by hand (INSP-D B5)
      return { ok: false, reason: "the message field holds text that was not there before the menu opened; nothing was typed, the rename waits", retry: true, miss: true, touched: true, seen: fieldBefore.text.slice(0, 40) };
    }
    const menuOpen = opened.some(isItem);
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
  }, probeFirst);
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

/** The app is reusing worktrees: its newest work session opened in a
 * worktree folder that an OLDER session (archived ones included) had used
 * already — the app's last picked folder is that worktree, and New Session
 * would open there again. null when the newest session is in a repository
 * root or in a worktree of its own (no one used the folder before it).
 *
 * `worktreeName` says nothing here: the app drops it when a session is
 * archived (163 of 179 archived worktree sessions on 01/10 have it null,
 * the ones it created right included), and a reused folder can carry it
 * (local_0a000005 in the folder of local_0a000004). */
export function lastAppWorktreeFolder(dir = DESKTOP_SESSIONS_DIR): { folder: string; title?: string; earlier: string[] } | null {
  const records: DesktopRecord[] = [];
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (record) records.push(record);
  }
  const newest = records.filter((record) => !notPickedFolder(record)).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  const folder = newest ? newest.worktreePath ?? newest.cwd : undefined;
  if (!newest || !folder || !/\/\.(?:claude\/)?worktrees\//.test(folder)) return null;
  const earlier = records.filter((record) => record.sessionId !== newest.sessionId && (record.cwd === folder || record.worktreePath === folder) && (record.createdAt ?? 0) < (newest.createdAt ?? 0));
  if (!earlier.length) return null;
  return { folder, ...(newest.title ? { title: newest.title } : {}), earlier: earlier.map((record) => record.title ?? record.sessionId) };
}

/** Folders the app's sessions not archived work in (their cwd and worktree). */
export function liveRecordFolders(dir = DESKTOP_SESSIONS_DIR): string[] {
  const folders = new Set<string>();
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (!record || record.isArchived) continue;
    if (record.cwd) folders.add(record.cwd);
    if (record.worktreePath) folders.add(record.worktreePath);
  }
  return [...folders];
}

/** What cc_session_start answers (409) while the app is reusing worktrees.
 * `fromQueue`: the start waited in the session queue and is dropped here —
 * the bot must start it again once the person fixed the app's folder. */
export function reusedFolderRefusal(last: { folder: string; title?: string; earlier: string[] }, repoName: string, fromQueue = false): string {
  const earlier = [...new Set(last.earlier)].slice(0, 3).map((title) => `"${title}"`).join(", ");
  return [
    `não abri: a sessão mais recente do app Claude${last.title ? ` ("${last.title}")` : ""} abriu em ${last.folder}, pasta que já era de ${earlier}. O app está reaproveitando worktrees e abriria a sessão nova lá também.`,
    `Peça ao dono para iniciar no app uma sessão nova na raiz de ${repoName} (pasta ${repoName}, worktree ligada) e enviar nela uma mensagem curta: o app só grava a sessão depois do primeiro envio, então abrir e fechar sem enviar não muda nada. Depois ela pode ser arquivada.`,
    fromQueue
      ? `Este pedido saiu da fila de sessões e foi descartado (não volta para a fila): quando o dono confirmar, chame cc_session_start de novo. Se não der para esperar, use surface "cli" com cli_reason.`
      : `Então tente de novo. Se não der para esperar, use surface "cli" com cli_reason.`,
  ].join(" ");
}

/** Worktree names of the app's sessions (archived ones too with `includeArchived`:
 * the app reopens the folder of an archived session as well). */
export function liveWorktreeNames(dir = DESKTOP_SESSIONS_DIR, includeArchived = false): string[] {
  const names: string[] = [];
  for (const file of recordFiles(dir)) {
    const record = readRecord(file);
    if (!record || (record.isArchived && !includeArchived)) continue;
    const name = record.worktreeName ?? (record.worktreePath ?? record.cwd ?? "").split("/.claude/worktrees/")[1];
    if (name) names.push(name);
  }
  return names;
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
