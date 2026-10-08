import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveDesktopSession,
  CLAUDE_BUNDLE_ID,
  lastAppRepo,
  liveWorktreeNames,
  recordsUsingFolder,
  renameDesktopSession,
  transcriptOpenQuestion,
  createDesktopSession,
  reusedWorktreeChip,
  notRepoRoot,
  lastAppWorktreeFolder,
  lastServerSessionInRoot,
  reusedFolderRefusal,
  rootAnchorSession,
  rootFolderRefusal,
  ROOT_SESSION_HOWTO,
  COMPOSER_MODE,
  isHeaderOf,
  DESKTOP_BRIEF_NOTE,
  DESKTOP_MESSAGE_NOTE,
  findDesktopSession,
  findComposer,
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

type ScreenLine = string | { text: string; x?: number; y?: number; w?: number; h?: number };

/** A fake Claude app: records what the automation did to the screen. Each
 * OCR call shows the next screen (the last one stays); a plain string is a
 * line of the main area, `{ x }` places it (x < 450 is the sidebar). */
function fakeApp(opts: { idle?: number | number[]; fronts?: string[]; screen?: ScreenLine[]; screens?: ScreenLine[][]; locked?: boolean; size?: { w: number; h: number } } = {}) {
  const actions: string[] = [];
  const fronts = [...(opts.fronts ?? [])];
  const idles = Array.isArray(opts.idle) ? [...opts.idle] : [opts.idle ?? 120];
  const toLines = (screen: ScreenLine[]): OcrLine[] => screen.map((line, i) => {
    const spec = typeof line === "string" ? { text: line } : line;
    return { x: spec.x ?? 600, y: spec.y ?? 500 + i * 20, w: spec.w ?? 200, h: spec.h ?? 16, text: spec.text };
  });
  const screens = (opts.screens ?? [opts.screen ?? []]).map(toLines);
  const driver: DesktopDriver = {
    idleSeconds: async () => (idles.length > 1 ? idles.shift()! : idles[0]!),
    frontmost: async () => (fronts.length > 1 ? fronts.shift()! : fronts[0] ?? CLAUDE_BUNDLE_ID),
    locked: async () => opts.locked ?? false,
    // the captures' screen (the real fixtures' coordinates are in it)
    screenSize: async () => opts.size ?? { w: 1_470, h: 923 },
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

// ── Real screens ─────────────────────────────────────────────────────────
// What the helper's OCR reads on the audit captures: the same Vision call
// (accurate, pt-BR + en-US) run on the PNG, coordinates in points (2940×1846
// px captures of a 1470×923-point screen). Main area only (x > 450). Nothing
// below is retyped or tidied: "gº main" is the branch icon read as "gº",
// "v worktree" the checkbox read as "v", "+ Q v Automático" the bar's icons.
type Real = { x: number; y: number; w: number; h: number; text: string };
const REAL_SIZE = { w: 1_470, h: 923 };

/** R8-visual-claude-1.png (01/10): a new session in the root of
 * nuria-platform — whose checkout was a detached HEAD while the
 * branch chip read "main". */
const R8_NEW_SESSION: Real[] = [
  { x: 1355, y: 25, w: 88, h: 16, text: "Novidades" },
  { x: 566, y: 75, w: 348, h: 30, text: "Bem-vindo de volta, Fulano" },
  { x: 530, y: 171, w: 66, h: 15, text: "Sessões" },
  { x: 543, y: 218, w: 797, h: 22, text: "• Requer entrada Organizar o catálogo de serviços inter... W... exemplo/nuria-platform há 5 meses" },
  { x: 540, y: 788, w: 71, h: 16, text: "• Local" },
  { x: 660, y: 788, w: 118, h: 17, text: "nuria-platform" },
  { x: 801, y: 786, w: 68, h: 17, text: "gº main" },
  { x: 885, y: 788, w: 92, h: 15, text: "v worktree" },
  { x: 547, y: 839, w: 366, h: 25, text: "Descreva uma tarefa ou faça uma pergunta" },
  { x: 545, y: 889, w: 222, h: 17, text: "+ O v Ignorar permissões" },
  { x: 1231, y: 888, w: 66, h: 18, text: "Opus 5.5" },
  { x: 1314, y: 889, w: 49, h: 17, text: "Médio" },
];

/** R7-dispatch-claude-1.png: the session "Automação inatividade não
 * dispara", the app's suggested reply in its field, the PR strip above it. */
const R7_SESSION: Real[] = [
  { x: 502, y: 23, w: 466, h: 21, text: "• Automação inatividade não dispara v (nuria-platform" },
  { x: 1346, y: 26, w: 17, h: 17, text: "E" },
  { x: 547, y: 60, w: 865, h: 19, text: "1. Falta a seção de riscos. Não há menção aos =30 avisos e =7 fechamentos no ambiente A, nem à" },
  { x: 575, y: 85, w: 677, h: 19, text: "revisão única em todos os ambientes com 200 itens por regra por execução." },
  { x: 545, y: 109, w: 831, h: 33, text: "2. Ela contradiz os números de risco. Diz que \"os itens parados já foram zerados à mão pela" },
  { x: 575, y: 141, w: 823, h: 24, text: "equipe\". Se for verdade, o disparo de =30/=7 no primeiro minuto não acontece mais no ambiente A. A" },
  { x: 575, y: 169, w: 812, h: 21, text: "revisão continua valendo para os outros ambientes. Não conferi essa afirmação em produção." },
  { x: 547, y: 198, w: 842, h: 24, text: "3. A descrição do teste está errada. Diz \"casos novos para item antigo com e sem data_de_entrada" },
  { x: 577, y: 224, w: 814, h: 21, text: "em cada modo\". O que existe é um teste com banco real só para a regra de tempo na etapa, com" },
  { x: 575, y: 252, w: 797, h: 24, text: "três itens: antigo movido há 10 dias dispara, antigo sem data_de_entrada não dispara," },
  { x: 575, y: 278, w: 825, h: 24, text: "antigo movido há 1 dia ainda não dispara. Há também uma asserção a mais num teste de horário" },
  { x: 577, y: 303, w: 840, h: 22, text: "comercial que já existia. O modo decorrido contado da entrada na etapa não é testado diretamente." },
  { x: 547, y: 335, w: 863, h: 19, text: "4. A validação registrada é menor que a real. Cita só o pre-push (4 arquivos, 57 testes). Localmente," },
  { x: 577, y: 361, w: 812, h: 21, text: "depois do merge com main, a suíte inteira do módulo passou (332 arquivos, 3728 testes), com" },
  { x: 581, y: 389, w: 188, h: 17, text: "tsc e eslint limpos." },
  { x: 545, y: 417, w: 786, h: 24, text: "5. Usa \"Closes #1234\" em vez de \"Fixes #1234\". O efeito é o mesmo, a issue fecha no merge." },
  { x: 530, y: 472, w: 427, h: 20, text: "Decisão para você: posso reescrever o corpo com" },
  { x: 961, y: 474, w: 30, h: 19, text: "gh" },
  { x: 994, y: 472, w: 412, h: 22, text: "pr edit 1234, acrescentando a seção de riscos" },
  { x: 528, y: 498, w: 889, h: 24, text: "e corrigindo a descrição do teste. Antes preciso saber se a informação de que a equipe já zerou os itens" },
  { x: 530, y: 523, w: 831, h: 19, text: "à mão vale. Ela define se o risco no ambiente A fica \"~30 avisos e =7 fechamentos\" ou \"nenhum" },
  { x: 528, y: 551, w: 786, h: 24, text: "parado; só a revisão nos demais ambientes\". Não mexi no texto de uma PR que não abri." },
  { x: 530, y: 592, w: 171, h: 15, text: "Não rodei ci: local" },
  { x: 709, y: 594, w: 38, h: 13, text: "nem" },
  { x: 754, y: 592, w: 647, h: 19, text: "pr: merge, não fiz merge, e o revisor não negou nenhum comando nesta rodada." },
  { x: 1429, y: 26, w: 11, h: 15, text: ":" },
  { x: 538, y: 782, w: 83, h: 20, text: "8 #9317" },
  { x: 652, y: 782, w: 487, h: 19, text: "nuria-platform fix/9298-regra-tempo-etapa-migrados" },
  { x: 547, y: 842, w: 453, h: 21, text: "pode reescrever o corpo da PR com a seção de riscos" },
  { x: 543, y: 889, w: 169, h: 19, text: "+ Q v Automático" },
  { x: 1207, y: 782, w: 71, h: 15, text: "+196 - 5" },
  { x: 1303, y: 782, w: 53, h: 15, text: "• CI V" },
  { x: 1382, y: 784, w: 13, h: 13, text: "X" },
  { x: 1231, y: 891, w: 66, h: 15, text: "Opus 5.5" },
  { x: 1316, y: 891, w: 47, h: 13, text: "Médio" },
];
const R7_FIELD = "pode reescrever o corpo da PR com a seção de riscos";

/** The same screen with some lines' text changed (null drops the line):
 * how the server.log's real readings ("the screen showed: …", which keep the
 * text and order but not the coordinates) are put back on the real layout. */
function swap(screen: Real[], changes: Record<string, string | null>): Real[] {
  return screen.flatMap((line) => (line.text in changes ? (changes[line.text] === null ? [] : [{ ...line, text: changes[line.text]! }]) : [line]));
}

/** server.log 01/10, sends to 36300f35 ("Guarda de release sem commit
 * anterior"), "field not found" 4 times: "nuria-platform
 * fix/9326-guard-previous-commit | qual o status do gate da #9330? | + O v
 * Ignorar permissões | +114 - 4 | • CI | X | Opus 5.5 | Médio" — the last 8
 * lower lines, in the very order and layout of R7 (whose last 8 are the same
 * kinds of line). The header is the app's title for that session. */
const S36300F35 = swap(R7_SESSION, {
  "• Automação inatividade não dispara v (nuria-platform": "• Guarda de release sem commit anterior v (nuria-platform",
  "8 #9317": null,
  "nuria-platform fix/9298-regra-tempo-etapa-migrados": "nuria-platform fix/9326-guard-previous-commit",
  [R7_FIELD]: "qual o status do gate da #9330?",
  "+ Q v Automático": "+ O v Ignorar permissões",
  "+196 - 5": "+114 - 4",
  "• CI V": "• CI",
});

const REPO_SCREEN = R8_NEW_SESSION;
/** The session that was open before New Session: another screen entirely. */
const OPEN_SESSION = R7_SESSION;
/** A session's screen once the brief went in (the composer's bar, no new-session chips). */
const AFTER_SEND = R7_SESSION;
const TERMINAL = "com.apple.Terminal";

describe("createDesktopSession", () => {
  it("opens a new session in the repository, pastes the brief with a note of its own and sends it", async () => {
    const app = fakeApp({ screens: [OPEN_SESSION, REPO_SCREEN, AFTER_SEND] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "[OMBX] brief" })).toEqual({ ok: true });
    expect(app.actions).toEqual(["activate", "menu new session", "paste(all) [OMBX] brief", `type  ${DESKTOP_BRIEF_NOTE}`, "key 36"]);
  });

  // R9-dispatch R9-1b / R10-dispatch R10-1b: New Session from a session in
  // the repository root, never from the worktree session on screen
  const ANCHOR_ID = "local_0a0000aa-0000-4000-8000-000000000000";
  const ANCHOR_TITLE = "Sessão raiz do gerente OpenMausBot";
  const ANCHOR_SCREEN = swap(R7_SESSION, { "• Automação inatividade não dispara v (nuria-platform": `• ${ANCHOR_TITLE} v (nuria-platform` });

  it("opens the repository's root session first, then New Session, and says so", async () => {
    const app = fakeApp({ screens: [OPEN_SESSION, ANCHOR_SCREEN, REPO_SCREEN, AFTER_SEND] });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "[OMBX] brief", anchor: { localId: ANCHOR_ID, title: ANCHOR_TITLE } });
    expect(step).toEqual({ ok: true, note: `New Session from the root session ${ANCHOR_ID}` });
    expect(app.actions).toEqual(["activate", `open claude://code/continue?session=${ANCHOR_ID}`, "menu new session", "paste(all) [OMBX] brief", `type  ${DESKTOP_BRIEF_NOTE}`, "key 36"]);
  });

  it("goes on as before when the root session does not show, and says that too", async () => {
    const app = fakeApp({ screens: [OPEN_SESSION, OPEN_SESSION, REPO_SCREEN, AFTER_SEND] });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x", anchor: { localId: ANCHOR_ID, title: ANCHOR_TITLE } });
    expect(step).toEqual({ ok: true, note: `the root session ${ANCHOR_ID} ("${ANCHOR_TITLE}") did not show; New Session from whatever was on screen` });
    expect(app.actions.slice(0, 3)).toEqual(["activate", `open claude://code/continue?session=${ANCHOR_ID}`, "menu new session"]);
  });

  it("never opens an anchor that is not an app session id, and stops for the person at the anchor too", async () => {
    const bad = fakeApp({ screens: [OPEN_SESSION, REPO_SCREEN, AFTER_SEND] });
    expect(await createDesktopSession(bad.driver, { repoName: "nuria-platform", text: "x", anchor: { localId: "local_x; rm -rf ~" } })).toEqual({ ok: true });
    expect(bad.actions.some((action) => action.startsWith("open"))).toBe(false);
    // a fresh input right after the anchor opened: nothing more is done
    const app = fakeApp({ idle: [120, 120, 120, 0.1], screens: [OPEN_SESSION, ANCHOR_SCREEN] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x", anchor: { localId: ANCHOR_ID, title: ANCHOR_TITLE } })).toMatchObject({ ok: false, human: true });
    expect(app.actions).toEqual(["activate", `open claude://code/continue?session=${ANCHOR_ID}`]);
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
    const app = fakeApp({ fronts: [TERMINAL, CLAUDE_BUNDLE_ID], screens: [OPEN_SESSION, REPO_SCREEN, AFTER_SEND] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" })).toEqual({ ok: true });
    expect(app.actions.at(-1)).toBe(`restore ${TERMINAL}`);
  });

  it("types nothing when the new session's chip shows another session's branch (the app would reuse its worktree)", async () => {
    for (const chip of ["claude/fix-9298-stage-time-rule-572720", "fix-9298-stage-time-rule-572720"]) {
      const app = fakeApp({ screens: [OPEN_SESSION, swap(R8_NEW_SESSION, { "gº main": `gº ${chip}` })] });
      const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x", liveWorktrees: ["fix-9298-stage-time-rule-572720"] });
      expect(step).toMatchObject({ ok: false, retry: true, miss: true, reason: expect.stringContaining("another session's worktree") });
      // o73: the option is on, so the branch picker is tried first — it opened nothing here: one click, nothing typed
      expect(step).toMatchObject({ reason: expect.stringContaining("tried on screen first: clicked the branch chip") });
      expect(app.actions.filter((action) => !action.startsWith("click"))).toEqual(["activate", "menu new session"]);
      expect(app.actions.filter((action) => action.startsWith("click"))).toHaveLength(1);
    }
    // "main" is the repository's own branch: it goes on
    expect(reusedWorktreeChip([{ text: "nuria-platform main", x: 0, y: 800, w: 100, h: 16 }], ["fix-9298-stage-time-rule-572720"])).toBeNull();
  });

  it("types nothing when the branch chip shows other work: a detached sha, a fix/… branch, HEAD, another base", async () => {
    // the chips this guard refuses (a reused folder MAY show them; the one
    // real capture of a new session shows "main" even on a detached root,
    // so the 409 and the adoption check are what stop folder reuse)
    for (const chip of ["gº 1bbd5c2a7", "gº fix/9326-guard-previous-commit", "gº HEAD", "gº develop"]) {
      const app = fakeApp({ screens: [OPEN_SESSION, swap(R8_NEW_SESSION, { "gº main": chip })] });
      const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x", baseBranch: "main" });
      expect(step).toMatchObject({ ok: false, retry: true, miss: true, reason: expect.stringContaining("not in the root of nuria-platform") });
      expect(step).toMatchObject({ reason: expect.stringContaining("send it a short message") });
      expect(step).toMatchObject({ reason: expect.stringContaining("tried on screen first: clicked the branch chip") });
      expect(app.actions.filter((action) => !action.startsWith("click"))).toEqual(["activate", "menu new session"]);
      expect(app.actions.filter((action) => action.startsWith("click"))).toHaveLength(1);
    }
  });

  it("reads the branch only in the row of chips: the real root screen passes, and the Sessões list, dates and origin/main never refuse it (INSP-D A3)", () => {
    expect(notRepoRoot(R8_NEW_SESSION, "main")).toBeNull();
    // the Sessões list grows down into the lower half when there are many sessions
    const listLow = [...R8_NEW_SESSION, { x: 543, y: 600, w: 797, h: 22, text: "• Requer entrada Organizar o catálogo de serviços inter... W... exemplo/nuria-platform há 5 meses" }];
    expect(notRepoRoot(listLow, "main")).toBeNull();
    expect(notRepoRoot([...R8_NEW_SESSION, { x: 1100, y: 600, w: 60, h: 16, text: "01/10 e/ou acabada" }], "main")).toBeNull();
    expect(notRepoRoot(swap(R8_NEW_SESSION, { "gº main": "gº origin/main" }), "main")).toBeNull();
    // the chip row itself still counts
    expect(notRepoRoot(swap(R8_NEW_SESSION, { "gº main": "gº 1bbd5c2a7" }), "main")).toBe("it shows 1bbd5c2a7, not main");
    expect(notRepoRoot(swap(R8_NEW_SESSION, { "gº main": "gº" }), "main")).toContain("does not show the base branch");
  });

  it("counts a create only on proof that the new session's screen is gone after Return", async () => {
    // the brief still in the field, the chips still there
    const stuck = swap(R8_NEW_SESSION, { "Descreva uma tarefa ou faça uma pergunta": "[OMBX] brief da #9319" });
    const app = fakeApp({ screens: [OPEN_SESSION, REPO_SCREEN, stuck] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "[OMBX] brief da #9319" }))
      .toMatchObject({ ok: false, retry: true, reason: expect.stringContaining("did not leave the new session's screen") });
    expect(app.actions.at(-1)).toBe("key 36");
    // a long brief the app folded into a pasted block: its words are not on
    // screen, the chips are — still not sent (INSP-D A8)
    const folded = swap(R8_NEW_SESSION, { "Descreva uma tarefa ou faça uma pergunta": "Texto colado" });
    const foldedApp = fakeApp({ screens: [OPEN_SESSION, REPO_SCREEN, folded] });
    expect(await createDesktopSession(foldedApp.driver, { repoName: "nuria-platform", text: `[OMBX] brief ${"x".repeat(2_000)}` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("did not leave the new session's screen") });
    // an OCR that read nothing proves nothing
    const blind = fakeApp({ screens: [OPEN_SESSION, REPO_SCREEN, []] });
    expect(await createDesktopSession(blind.driver, { repoName: "nuria-platform", text: "brief" }))
      .toMatchObject({ ok: false, retry: true, reason: expect.stringContaining("could not read the screen after Return") });
  });

  it("treats a new session opened in another folder as a miss to retry, not a failure", async () => {
    const app = fakeApp({ screens: [OPEN_SESSION, swap(R8_NEW_SESSION, { "nuria-platform": "soph-ia" })] });
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "x" });
    expect(step).toMatchObject({ ok: false, retry: true, miss: true });
    // o73: the folder picker is tried first (it opened nothing here): one click on the folder chip, nothing typed
    expect(step).toMatchObject({ reason: expect.stringContaining('tried on screen first: clicked the folder chip ("soph-ia"): nothing opened') });
    expect(app.actions.filter((action) => !action.startsWith("click"))).toEqual(["activate", "menu new session"]);
    expect(app.actions.filter((action) => action.startsWith("click"))).toHaveLength(1);
  });

  it("tells no new-session screen at all apart from a new session in another folder: only the latter asks for a session by hand (R13-dispatch R13-2c)", async () => {
    // 06/10 from 15:10Z: after New Session the screen showed a conversation — the corridor's lines of a brief — and no field, no chips
    const convo = ["Never skip, bypass or fake the gate; never push to main, never force.", "Order of a batch: hotfix/PO/P1 first, ahead of any Cl or infrastructure PR, and released on its", "own. PRs that change release scripts (scripts/*release*, watch-production-release, release-", "carrier) ship in a separate carrier "].map((text, i) => ({ text, y: 600 + i * 30 }));
    const none = fakeApp({ screens: [OPEN_SESSION, convo] });
    const step = await createDesktopSession(none.driver, { repoName: "nuria-platform", text: "brief" });
    expect(step).toMatchObject({ ok: false, retry: true, miss: true });
    expect(!step.ok && step.reason).toContain("New Session did not show a new session's screen (no empty task field and no folder chips");
    expect(!step.ok && step.reason).not.toContain("by hand");
    expect(none.actions.some((action) => action.startsWith("paste") || action.startsWith("key"))).toBe(false);
    // 06/10 14:36Z: a new session, in the folder of the session before (b3a17a95)
    const previous = fakeApp({ screens: [OPEN_SESSION, swap(R8_NEW_SESSION, { "nuria-platform": "9378-supervisor-papel-..." })] });
    const other = await createDesktopSession(previous.driver, { repoName: "nuria-platform", text: "brief" });
    expect(!other.ok && other.reason).toContain("it shows another folder in its chips");
    expect(!other.ok && other.reason).toContain("open one session there by hand once");
  });

  it("never pastes when New Session did not open (the open session's screen stays)", async () => {
    const app = fakeApp({ screens: [[...OPEN_SESSION, { text: "nuria-platform main", y: 815 }, { text: "worktree", x: 700, y: 815 }]] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "brief" })).toMatchObject({ ok: false, miss: true, reason: expect.stringContaining("did not open") });
    expect(app.actions.some((action) => action.startsWith("paste") || action.startsWith("key"))).toBe(false);
  });

  it("goes on in the empty new session an earlier try already opened, without New Session again", async () => {
    const app = fakeApp({ screens: [R8_NEW_SESSION, AFTER_SEND] });
    expect(await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "#9311 brief" })).toEqual({ ok: true });
    expect(app.actions).toEqual(["activate", "click 567,851.5", "paste(all) #9311 brief", `type  ${DESKTOP_BRIEF_NOTE}`, "key 36"]);
    // an empty session in another folder is not ours to fill
    const other = fakeApp({ screens: [swap(R8_NEW_SESSION, { "nuria-platform": "soph-ia" }), REPO_SCREEN] });
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
  // the mode bar under the field, in its column: the field is only ever read there
  const bar = { text: "+ O v Automático", y: 866 };

  it("reopens the session, checks its title, types into its field and sees the field empty again", async () => {
    const app = fakeApp({ screens: [[open, field, bar], [open, { text: "follow-up now", y: 820 }, bar], [open, { text: "follow-up now", y: 400 }, field, bar]] });
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
    const app = fakeApp({ screens: [[open, field, bar], [open, field, bar]] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "follow-up now", title: open.text })).toMatchObject({ ok: false, retry: true });
    expect(app.actions.some((action) => action.startsWith("key"))).toBe(false);
  });

  it("retries when the text is still in the field after Return", async () => {
    const typed = { text: "follow-up now", y: 820 };
    const app = fakeApp({ screens: [[open, field, bar], [open, typed, bar], [open, typed, bar]] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "follow-up now", title: open.text })).toMatchObject({ ok: false, retry: true, reason: expect.stringContaining("stayed") });
  });

  it("adds a line of its own after a message the app may wrap as pasted content", async () => {
    const long = `Long steer ${"x".repeat(250)}`;
    const app = fakeApp({ screens: [[open, field, bar], [open, { text: "Long steer xxxx", y: 820 }, bar], [open, field, bar]] });
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

  it("finds the opened session by the header the OCR really read, first letter eaten included (01/10 14:22Z and 14:30Z), and the item as the app words it", async () => {
    // server.log: "• Inbox 503 diagnóstico e recuperação v (nuria-platform" (14:12, 14:22)
    // and "nbox 503 diagnóstico e recuperação v (nuria-platform" (14:30: the "I" eaten).
    // The log keeps no coordinates: the header goes where the R7 capture has
    // the header (x 502, y 23). Where the app opens the menu is not known
    // (its real menu was never captured): the item goes under the header.
    for (const text of ["• Inbox 503 diagnóstico e recuperação v (nuria-platform", "nbox 503 diagnóstico e recuperação v (nuria-platform"]) {
      const top = { text, x: 502, y: 23, w: 466, h: 21 };
      expect(isHeaderOf(top, "Inbox 503 diagnóstico e recuperação")).toBe(true);
      const app = fakeApp({ screens: [[top], [top, { text: "Arquivar sessão", x: 520, y: 60, w: 120, h: 16 }]] });
      expect(await archiveDesktopSession(app.driver, { localId, title: "Inbox 503 diagnóstico e recuperação" })).toEqual({ ok: true });
      expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`, "click 522,33.5", "click 580,68"]);
    }
    // a header of another session that only shares the tail of a word is not this one
    expect(isHeaderOf({ text: "• Sandbox 503 erro de deploy v (nuria-platform", x: 502, y: 23, w: 466, h: 21 }, "Inbox 503 diagnóstico e recuperação")).toBe(false);
  });

  it("clicks a menu item only on a short line next to the click: never a conversation line that starts with \"Renomear\" (INSP-D A5)", async () => {
    const top = { text: "• Inbox 503 diagnóstico e recuperação v (nuria-platform", x: 502, y: 23, w: 466, h: 21 };
    // the Chief's words in the conversation, right under the header, and no real menu item
    const said = { text: "Renomear a sessão para #8891 Inbox 503 diagnóstico e recuperação", x: 530, y: 120, w: 600, h: 19 };
    const app = fakeApp({ screens: [[top], [top, said], [top, said]] });
    const step = await renameDesktopSession(app.driver, { localId, title: "Inbox 503 diagnóstico e recuperação", newTitle: "#8891 Inbox 503 diagnóstico e recuperação" });
    expect(step).toMatchObject({ ok: false, miss: true });
    expect(app.actions).not.toContain("click 830,129.5");
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
    // a short item far from the click (another window's menu) is not it either
    const far = fakeApp({ screens: [[top], [top, { text: "Renomear", x: 1_200, y: 60, w: 80, h: 16 }], [top]] });
    expect(await renameDesktopSession(far.driver, { localId, title: "Inbox 503 diagnóstico e recuperação", newTitle: "#8891 x" })).toMatchObject({ ok: false });
    expect(far.actions).not.toContain("click 1240,68");
  });

  it("matches the truncated sidebar entry, and says which items a menu without the wanted one showed", async () => {
    const entry = { text: "• Inbox 503 diagnós", x: 24, y: 411 };
    const app = fakeApp({ screens: [[entry], [entry, { text: "Fixar", x: 60, y: 440 }, { text: "Renomear", x: 60, y: 470 }]] });
    const step = await archiveDesktopSession(app.driver, { localId, title: "Inbox 503 diagnóstico e recuperação" });
    expect(step).toMatchObject({ ok: false, retry: true, miss: true, reason: "the session menu showed no Archive item", seen: expect.stringContaining("Fixar | Renomear") });
    expect(app.actions).toContain("rclick 54,419");
    expect(app.actions.at(-1)).toBe("key 53");
    // a rename never goes by the sidebar alone: without the session's header
    // on screen it neither clicks nor types (INSP-D B3)
    const rename = fakeApp({ screens: [[entry]] });
    expect(await renameDesktopSession(rename.driver, { localId, title: "Inbox 503 diagnóstico e recuperação", newTitle: "#8891 Inbox 503 diagnóstico" })).toMatchObject({ ok: false, miss: true });
    expect(rename.actions).toEqual([`open claude://code/continue?session=${localId}`]);
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
  const localId = "local_0a000008-a958-43e0-b2bc-ac77b4a92b4d";
  const sidebar = [
    { text: "i Merge e deploy de PRs abertos", x: 21, y: 172 },
    { text: "• Reabertura com defeitos", x: 24, y: 304 },
    { text: "• Chat ticket agent/client labels bug", x: 24, y: 338 },
    { text: "• Fila errada ao criar ticket", x: 24, y: 411 },
    { text: "• Automação inatividade não dispara", x: 24, y: 447 },
  ];
  const header = { text: "• Chat ticket agent/client labels bug v (nuria-platform", x: 500, y: 57 };
  const chip = { text: "nuria-platform fix/9311-chat-labels", x: 547, y: 815 };
  const field = { text: "Digite / para comandos", x: 547, y: 842 };
  const bar = { text: "+ Q v Automático", x: 543, y: 889 };

  it("matches titles behind a status dot or an icon, and the header with its folder after it", () => {
    expect(sidebarMatch("• Fila errada ao criar ticket", "Fila errada ao criar ticket")).toBe(true);
    expect(sidebarMatch("i Merge e deploy de PRs abertos", "Merge e deploy de PRs abertos")).toBe(true);
    expect(sidebarMatch(header.text, "Chat ticket agent/client labels bug")).toBe(true);
    expect(sidebarMatch("• Reabertura com defeitos", "Fila errada ao criar ticket")).toBe(false);
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
    expect(headerNames(at("• Reabertura com defeitos"), "Automação inatividade não dispara")).toBe(false);
  });

  it("says what the header showed when the session on screen is another one", async () => {
    const other = { text: "• Fila errada ao criar ticket v (nuria-platform", x: 500, y: 57 };
    const app = fakeApp({ screens: [[other, chip, field]] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "x", title: "Chat ticket agent/client labels bug" })).toMatchObject({ ok: false, miss: true, seen: expect.stringContaining("Fila errada") });
    const noField = fakeApp({ screens: [[header, chip]] });
    expect(await sendToDesktopSession(noField.driver, { localId, text: "x", title: "Chat ticket agent/client labels bug" })).toMatchObject({ ok: false, seen: expect.stringContaining("fix/9311") });
  });

  it("finds the field above the mode bar, in its column, on the real screen (R7 capture)", () => {
    expect(findComposer(R7_SESSION, REAL_SIZE, "nuria-platform")).toMatchObject({ text: R7_FIELD, line: { x: 547, y: 842 }, bar: { text: "+ Q v Automático" } });
    expect(findComposer(S36300F35, REAL_SIZE, "nuria-platform")).toMatchObject({ text: "qual o status do gate da #9330?" });
    expect(findComposer(swap(R7_SESSION, { [R7_FIELD]: "Digite / para comandos" }), REAL_SIZE)).toMatchObject({ text: null, line: { y: 842 } });
    // a placeholder with no mode bar under it is not a field
    expect(findComposer([{ x: 547, y: 875, w: 200, h: 16, text: "Digite / para comandos" }], REAL_SIZE)).toBeNull();
    expect(findComposer([{ x: 547, y: 300, w: 200, h: 16, text: "conversation text" }], REAL_SIZE)).toBeNull();
  });

  it("takes the placeholder only where the field is: \"Responder ao cliente…\" in the conversation is not an empty field (INSP-D D1)", async () => {
    const draft = "pode reescrever o corpo da PR";
    const said = { x: 530, y: 594, w: 600, h: 19, text: "Responder ao cliente com o novo prazo e fechar o ticket" };
    const screen = [...swap(R7_SESSION, { [R7_FIELD]: draft }), said];
    expect(findComposer(screen, REAL_SIZE, "nuria-platform")).toMatchObject({ text: draft });
    // even the bare word, far from the field's slot, is conversation
    expect(findComposer([...swap(R7_SESSION, { [R7_FIELD]: draft }), { ...said, text: "Responder…" }], REAL_SIZE, "nuria-platform")).toMatchObject({ text: draft });
    // the send goes through the probe on the draft and pastes nothing
    const probed = [...swap(R7_SESSION, { [R7_FIELD]: `${draft}.` }), said];
    const app = fakeApp({ screens: [screen, screen, probed] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "Pode sim", title: "Automação inatividade não dispara", repoName: "nuria-platform" })).toMatchObject({ ok: false, draft });
    expect(app.actions).toContain("type .");
    expect(app.actions.at(-1)).toBe("key 51");
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
    // after Return the same rule: the message still in the field and a "Responder…" in the conversation is not "sent"
    const empty = swap(R7_SESSION, { [R7_FIELD]: "Responder…" });
    const stuck = [...swap(R7_SESSION, { [R7_FIELD]: "Siga com o prazo novo" }), { ...said, text: "Responder…" }];
    const sent = fakeApp({ screens: [empty, stuck, stuck] });
    expect(await sendToDesktopSession(sent.driver, { localId, text: "Siga com o prazo novo", title: "Automação inatividade não dispara", repoName: "nuria-platform" }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("stayed in the field") });
  });

  it("reads the real mode bar \"+ O v Ignorar permissões\" (3 of 4 sessions on 01/10), and no sentence of the conversation as a bar (INSP-D A4)", () => {
    expect(COMPOSER_MODE.test("+ O v Ignorar permissões")).toBe(true);
    expect(COMPOSER_MODE.test("+ Q v Automático")).toBe(true);
    expect(COMPOSER_MODE.test("+ Q • Automático")).toBe(true);
    expect(COMPOSER_MODE.test("Automático")).toBe(true);
    expect(COMPOSER_MODE.test("Rodei com o modo Bypass permissions para rodar")).toBe(false);
    expect(COMPOSER_MODE.test("segue o plan")).toBe(false);
    expect(COMPOSER_MODE.test("pode deixar no auto")).toBe(false);
    // a conversation line ending like a mode, below the text, is not the bar:
    // the field stays the line right above the real bar
    const tricky = [...R7_SESSION.filter((line) => line.y < 700), { x: 530, y: 700, w: 600, h: 19, text: "Rodei tudo com o modo Bypass permissions" }, ...R7_SESSION.filter((line) => line.y >= 700)];
    expect(findComposer(tricky, REAL_SIZE, "nuria-platform")).toMatchObject({ text: R7_FIELD });
    // server.log 01/10 (ffd6ee1a… "Pode implementar o item 1 no front | + O v Ignorar permissões | Opus"):
    // before, no bar was found ("field not found"); now the field is
    const logged = swap(R7_SESSION, { [R7_FIELD]: "Pode implementar o item 1 no front", "+ Q v Automático": "+ O v Ignorar permissões", "Opus 5.5": "Opus" });
    expect(findComposer(logged, REAL_SIZE, "nuria-platform")).toMatchObject({ text: "Pode implementar o item 1 no front" });
  });

  it("never takes a button or the PR strip for the field: the real \"Criar PR\" screen clicks nothing (INSP-D A1/A4)", async () => {
    // server.log 01/10: "+114 - 4 | Criar PR | +114 - 4 | • CI | X | X | Opus 5.5 | Médio" — no field, no mode bar
    const criarPr = [
      ...S36300F35.filter((line) => line.y < 700),
      { x: 1207, y: 782, w: 71, h: 15, text: "+114 - 4" },
      { x: 1100, y: 782, w: 70, h: 15, text: "Criar PR" },
      { x: 1207, y: 782, w: 71, h: 15, text: "+114 - 4" },
      { x: 1303, y: 782, w: 53, h: 15, text: "• CI" },
      { x: 1382, y: 784, w: 13, h: 13, text: "X" },
      { x: 1395, y: 784, w: 13, h: 13, text: "X" },
      { x: 1231, y: 891, w: 66, h: 15, text: "Opus 5.5" },
      { x: 1316, y: 891, w: 47, h: 13, text: "Médio" },
    ];
    const app = fakeApp({ screen: criarPr });
    expect(await sendToDesktopSession(app.driver, { localId, text: "Siga", title: "Guarda de release sem commit anterior" })).toMatchObject({ ok: false, miss: true, reason: expect.stringContaining("field was not found") });
    expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`]);
    // even right above the mode bar, in the field's column, a button is not a field
    const buttonInColumn = swap(S36300F35, { "qual o status do gate da #9330?": "Criar PR" });
    expect(findComposer(buttonInColumn, REAL_SIZE, "nuria-platform")).toBeNull();
    // the strip's chips, read with spaces ("+114 - 4") or without ("+114-4"), never
    for (const chip of ["+114 - 4", "+114-4", "• CI", "8 #9317", "nuria-platform fix/9326-guard-previous-commit"]) {
      expect(findComposer(swap(S36300F35, { "qual o status do gate da #9330?": chip }), REAL_SIZE, "nuria-platform")).toBeNull();
    }
    // but a short draft with a path is the person's text, still the field
    expect(findComposer(swap(S36300F35, { "qual o status do gate da #9330?": "veja server/index.ts" }), REAL_SIZE, "nuria-platform")).toMatchObject({ text: "veja server/index.ts" });
  });

  it("keeps the person's draft: cursor to the end, one probe key, the draft stays, the key is taken back and nothing is sent", async () => {
    const probed = swap(R7_SESSION, { [R7_FIELD]: `${R7_FIELD}.` });
    // reads: opened, the field again before the key, then after it (the last screen stays)
    const app = fakeApp({ screens: [R7_SESSION, R7_SESSION, probed] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "Pode sim, reescreva o corpo", title: "Automação inatividade não dispara", repoName: "nuria-platform" }))
      .toMatchObject({ ok: false, retry: true, draft: R7_FIELD, reason: expect.stringContaining("rascunho") });
    expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`, "click 567,852.5", "key 125+cmd", "type .", "key 51"]);
  });

  it("calls it a draft unless the field positively gave way: probe mid-word, or an unreadable screen, never overwrite it (INSP-D A1)", async () => {
    // the cursor did not reach the end and the "." split a word ("po.de…"):
    // the old check (its first 24 letters gone, so "a suggestion") would have pasted over the draft
    for (const after of [swap(R7_SESSION, { [R7_FIELD]: "po.de reescrever o corpo da PR com a seção de riscos" }), [], R7_SESSION.filter((line) => line.y < 700)]) {
      const app = fakeApp({ screens: [R7_SESSION, R7_SESSION, after] });
      expect(await sendToDesktopSession(app.driver, { localId, text: "Pode sim", title: "Automação inatividade não dispara", repoName: "nuria-platform" }))
        .toMatchObject({ ok: false, draft: R7_FIELD });
      expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
      expect(app.actions.at(-1)).toBe("key 51");
    }
  });

  it("owns up to a \".\" left in the draft when it must stop before taking it back (INSP-D A1)", async () => {
    // fronts: step start, open, click field, cursor, probe, then another app at "undo probe"
    const probed = swap(R7_SESSION, { [R7_FIELD]: `${R7_FIELD}.` });
    const app = fakeApp({ screens: [R7_SESSION, R7_SESSION, probed], fronts: [CLAUDE_BUNDLE_ID, CLAUDE_BUNDLE_ID, CLAUDE_BUNDLE_ID, CLAUDE_BUNDLE_ID, CLAUDE_BUNDLE_ID, TERMINAL] });
    const step = await sendToDesktopSession(app.driver, { localId, text: "Pode sim", title: "Automação inatividade não dispara", repoName: "nuria-platform" });
    expect(step).toMatchObject({ ok: false, retry: true, draft: R7_FIELD, leftProbe: true, reason: expect.stringContaining('deixei um "." no fim dele') });
    expect(app.actions).not.toContain("key 51");
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
  });

  it("sends over the app's suggested reply once it gave way to the probe key (36300f35: \"qual o status do gate da #9330?\")", async () => {
    const title = "Guarda de release sem commit anterior";
    const field = "qual o status do gate da #9330?";
    // reads: opened, again before the key, two after it, the typed message, after Return
    const app = fakeApp({ screens: [S36300F35, S36300F35, swap(S36300F35, { [field]: "." }), swap(S36300F35, { [field]: "." }), swap(S36300F35, { [field]: "Siga com o gate da #9330 agora" }), swap(S36300F35, { [field]: "Responder…" })] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "Siga com o gate da #9330 agora", title, repoName: "nuria-platform" }))
      .toEqual({ ok: true, suggestion: field });
    expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`, "click 567,852.5", "key 125+cmd", "type .", "paste(all) Siga com o gate da #9330 agora", "key 36"]);
    // Vision may not read a lone "." at all: an empty field, the rest of the composer unchanged, is the same proof
    const unread = fakeApp({ screens: [S36300F35, S36300F35, swap(S36300F35, { [field]: null }), swap(S36300F35, { [field]: null }), swap(S36300F35, { [field]: "Siga" }), swap(S36300F35, { [field]: "Responder…" })] });
    expect(await sendToDesktopSession(unread.driver, { localId, text: "Siga", title, repoName: "nuria-platform" })).toEqual({ ok: true, suggestion: field });
    // the probe read alone as "·" is the same proof
    const dot = fakeApp({ screens: [S36300F35, S36300F35, swap(S36300F35, { [field]: "·" }), swap(S36300F35, { [field]: "·" }), swap(S36300F35, { [field]: "Siga" }), swap(S36300F35, { [field]: "Responder…" })] });
    expect(await sendToDesktopSession(dot.driver, { localId, text: "Siga", title, repoName: "nuria-platform" })).toEqual({ ok: true, suggestion: field });
  });

  it("sends straight away when the suggestion hid as the field took focus: the placeholder shows, no probe key (INSP-D C1)", async () => {
    const title = "Automação inatividade não dispara";
    const focused = swap(R7_SESSION, { [R7_FIELD]: "Responder…" });
    const app = fakeApp({ screens: [R7_SESSION, focused, swap(R7_SESSION, { [R7_FIELD]: "Pode sim, reescreva o corpo" }), focused] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "Pode sim, reescreva o corpo", title, repoName: "nuria-platform" }))
      .toEqual({ ok: true, suggestion: R7_FIELD });
    expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`, "click 567,852.5", "paste(all) Pode sim, reescreva o corpo", "key 36"]);
    expect(app.actions.some((action) => action.startsWith("type"))).toBe(false);
    // any other text on the second reading still stops (it is not the placeholder)
    const changed = fakeApp({ screens: [R7_SESSION, swap(R7_SESSION, { [R7_FIELD]: "outro texto no campo" })] });
    expect(await sendToDesktopSession(changed.driver, { localId, text: "Pode sim", title, repoName: "nuria-platform" })).toMatchObject({ ok: false, miss: true });
    expect(changed.actions.some((action) => action.startsWith("paste") || action.startsWith("type"))).toBe(false);
  });

  it("takes an empty field for proof only when two readings after the key agree, and the field read the same twice before it (INSP-D B2)", async () => {
    const title = "Automação inatividade não dispara";
    const without = swap(R7_SESSION, { [R7_FIELD]: null });
    const withDot = swap(R7_SESSION, { [R7_FIELD]: `${R7_FIELD}.` });
    // one reading skipped the draft's line, the next shows it: a draft, never pasted over
    for (const after of [[without, withDot], [withDot, without]]) {
      const app = fakeApp({ screens: [R7_SESSION, R7_SESSION, ...after, withDot] });
      expect(await sendToDesktopSession(app.driver, { localId, text: "Pode sim", title, repoName: "nuria-platform" })).toMatchObject({ ok: false, draft: R7_FIELD });
      expect(app.actions.at(-1)).toBe("key 51");
      expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
    }
    // the field read differently before the key: nothing is typed at all
    const unsteady = fakeApp({ screens: [R7_SESSION, swap(R7_SESSION, { [R7_FIELD]: "pode reescrever o corpo da PR" })] });
    expect(await sendToDesktopSession(unsteady.driver, { localId, text: "Pode sim", title, repoName: "nuria-platform" })).toMatchObject({ ok: false, miss: true, reason: expect.stringContaining("read differently twice") });
    expect(unsteady.actions.some((action) => action.startsWith("type") || action.startsWith("key") || action.startsWith("paste"))).toBe(false);
  });

  it("sends into the session whose header carries a status dot (8378b26a)", async () => {
    const typed = { ...field, text: "Siga com o PR" };
    const app = fakeApp({ screens: [[...sidebar, header, chip, field, bar], [...sidebar, header, chip, typed, bar], [...sidebar, header, chip, field, bar]] });
    expect(await sendToDesktopSession(app.driver, { localId, text: "Siga com o PR", title: "Chat ticket agent/client labels bug" })).toEqual({ ok: true });
  });

  it("archives the sidebar entry behind its status dot (28963e07)", async () => {
    const app = fakeApp({ screen: [...sidebar, header, { text: "Arquivar", x: 60, y: 440 }] });
    expect(await archiveDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket" })).toEqual({ ok: true });
    expect(app.actions).toContain("rclick 54,419");
  });

  it("opens a new session whose folder chip reads with its branch (c30a1f34)", async () => {
    const app = fakeApp({ screens: [[header, { text: "Texto da conversa anterior", x: 547, y: 300 }], [{ text: "nuria-platform main", x: 547, y: 815 }, { text: "worktree", x: 700, y: 815 }], AFTER_SEND] });
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

  const composer = { text: "Digite / para comandos", x: 547, y: 842 };
  // the mode bar under it (R7 geometry): the message field is read only above it
  const modeBar = { text: "+ O v Automático", x: 543, y: 889 };
  const field = { text: "Fila errada ao criar ticket", x: 520, y: 57 };
  const renamed = { text: "#9305 Fila errada ao criar ticket", x: 520, y: 57 };

  it("renames it \"#NNNN …\" from the same menu once the field is open, and confirms only what shows there", async () => {
    const app = fakeApp({ screens: [[header, composer, modeBar], [header, { text: "Renomear", x: 520, y: 110 }, composer, modeBar], [field, composer, modeBar], [renamed, composer, modeBar]] });
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
    const intoComposer = [header, { text: "#9305 Fila errada ao criar ticket", x: 547, y: 842 }, modeBar];
    const app = fakeApp({ screens: [[header, composer, modeBar], [header, { text: "Renomear", x: 520, y: 110 }, composer, modeBar], [field, composer, modeBar], intoComposer] });
    expect(await renameDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket", newTitle: "#9305 Fila errada ao criar ticket" })).toMatchObject({ ok: false, retry: false, reason: expect.stringContaining("cleared and not sent") });
    expect(app.actions).not.toContain("key 36");
    expect(app.actions.slice(-2)).toEqual(["key 0+cmd", "key 51"]);
  });

  // the composer of the R7 capture under this session's header
  const composerOf = (text: string | null) => swap(R7_SESSION.filter((line) => line.y > 700), { [R7_FIELD]: text });

  it("does not rename while the message field holds a proven draft: a mistaken paste would land on it", async () => {
    const app = fakeApp({ screens: [[header, ...composerOf(R7_FIELD)], [header, ...composerOf(R7_FIELD)], [header, ...composerOf(`${R7_FIELD}.`)]] });
    expect(await renameDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket", newTitle: "#9305 Fila errada ao criar ticket", repoName: "nuria-platform" }))
      .toMatchObject({ ok: false, retry: true, draft: R7_FIELD });
    // the probe key was taken back; no menu, no paste, no Return
    expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`, "click 567,852.5", "key 125+cmd", "type .", "key 51"]);
  });

  it("renames over the app's suggestion: it is proved with the probe, taken back, and asks the person nothing (INSP-D A5)", async () => {
    const suggestion = composerOf(R7_FIELD);
    const app = fakeApp({
      screens: [
        [header, ...suggestion], // opened
        [header, ...suggestion], // the field read again before the key
        [header, ...composerOf(".")], // the suggestion gave way to the probe…
        [header, ...composerOf(".")], // …in both readings
        [header, ...suggestion], // after taking the probe back the app shows its suggestion again
        [header, { text: "Renomear", x: 520, y: 110 }, ...suggestion], // the header's menu
        [field, ...suggestion], // the rename field
        [renamed, ...suggestion],
      ],
    });
    const step = await renameDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket", newTitle: "#9305 Fila errada ao criar ticket", repoName: "nuria-platform" });
    expect(step).toEqual({ ok: true });
    expect(app.actions).toEqual([
      `open claude://code/continue?session=${localId}`, "click 567,852.5", "key 125+cmd", "type .", "key 51",
      "click 520,65", "click 620,118", "paste(all) #9305 Fila errada ao criar ticket", "key 36",
    ]);
  });

  it("renames when the suggestion hid as the field took focus, with no probe key and nothing to take back (INSP-D C1)", async () => {
    const suggestion = composerOf(R7_FIELD);
    const focused = composerOf("Responder…");
    const app = fakeApp({ screens: [[header, ...suggestion], [header, ...focused], [header, ...focused], [header, { text: "Renomear", x: 520, y: 110 }, ...focused], [field, ...focused], [renamed, ...focused]] });
    expect(await renameDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket", newTitle: "#9305 Fila errada ao criar ticket", repoName: "nuria-platform" })).toEqual({ ok: true });
    expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`, "click 567,852.5", "click 520,65", "click 620,118", "paste(all) #9305 Fila errada ao criar ticket", "key 36"]);
  });

  it("checks the header before touching the field: another session on screen gets no click and no key (INSP-D B3)", async () => {
    // a stale link left another session open, with the app's suggestion in its field
    const other = { text: "• Automação inatividade não dispara v (nuria-platform", x: 502, y: 23, w: 466, h: 21 };
    const app = fakeApp({ screens: [[other, ...composerOf(R7_FIELD)]] });
    expect(await renameDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket", newTitle: "#9305 Fila errada ao criar ticket", repoName: "nuria-platform" }))
      .toMatchObject({ ok: false, miss: true, reason: expect.stringContaining("is not the one on screen"), seen: expect.stringContaining("Automação inatividade") });
    expect(app.actions).toEqual([`open claude://code/continue?session=${localId}`]);
  });

  it("counts text that showed up after the menu opened as a miss, so three of them reach the person (INSP-D B5)", async () => {
    const app = fakeApp({ screens: [[header, composer], [header, { text: "Renomear", x: 520, y: 110 }, composer], [field, ...composerOf("texto que apareceu depois")]] });
    expect(await renameDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket", newTitle: "#9305 x", repoName: "nuria-platform" }))
      .toMatchObject({ ok: false, retry: true, miss: true, reason: expect.stringContaining("was not there before the menu opened") });
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
  });

  it("sees a rename menu still open by the same rule as its items (\"Renomear sessão\"), and types nothing (INSP-D A5)", async () => {
    const menu = [header, { text: "Renomear sessão", x: 520, y: 110 }, composer];
    const app = fakeApp({ screens: [[header, composer], menu, menu] });
    expect(await renameDesktopSession(app.driver, { localId, title: "Fila errada ao criar ticket", newTitle: "#9305 x" })).toMatchObject({ ok: false, retry: false, reason: expect.stringContaining("did not open") });
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
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
    // the live sessions' worktrees (an archived one does not count)
    expect(liveWorktreeNames(root)).toEqual(["teste-modo-app-70ca2f"]);
    expect(liveWorktreeNames(root, true)).toEqual(["teste-modo-app-70ca2f", "teste-modo-app-70ca2f"]);
  });

  it("answers the start with the 409 that says what the person does, each earlier session once, and what happens to a queued start (INSP-D B1/B6)", () => {
    // what lastAppWorktreeFolder() returned on the real records (01/10 ~16h)
    const real = {
      folder: "/Users/o/Projetos/nuria-platform/.claude/worktrees/reabertura-defeitos-496989",
      title: "Guarda de release sem commit anterior",
      earlier: ["Prazo de reabertura ajustável", "Prazo de reabertura ajustável", "Reabertura com defeitos"],
    };
    const direct = reusedFolderRefusal(real, "nuria-platform");
    expect(direct).toContain('pasta que já era de "Prazo de reabertura ajustável", "Reabertura com defeitos".');
    expect(direct.match(/Prazo de reabertura/g)).toHaveLength(1);
    expect(direct).toContain("enviar nela uma mensagem curta");
    expect(direct).not.toMatch(/6 de 7|sem enviar;|fechá-la/);
    expect(direct).toContain("Então tente de novo.");
    // the start that waited in the queue stays there (retry: fromQueue) and is tried again
    const queued = reusedFolderRefusal(real, "nuria-platform", true);
    expect(queued).toContain("veio da fila de sessões e continua nela");
    expect(queued).not.toMatch(/descartado|chame cc_session_start de novo/);
    // both ways in (the tool call and the queue) go through startCcSession with this text
    const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(index).toContain("reusedFolderRefusal(block.last, basename(input.repo), fromQueue)");
    expect(index).toContain("startCcSession(bot, threadId, replyThreadId, item.body, true, item.delegation)");
    expect(index).not.toMatch(/6 de 7 creates|fechá-la sem enviar/);
  });

  it("knows the app is reusing worktrees only when the newest session's folder was used before it — worktreeName says nothing (INSP-D A2)", () => {
    const records = join(root, "org", "acct");
    mkdirSync(records, { recursive: true });
    const write = (id: string, extra: object) => writeFileSync(join(records, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: `c-${id}`, ...extra }));
    const wt = (name: string) => `/Users/o/Projetos/nuria-platform/.claude/worktrees/${name}`;
    write("local_a", { createdAt: Date.parse("2026-09-30T10:00:00Z"), cwd: "/Users/o/Projetos/nuria-platform" });
    expect(lastAppWorktreeFolder(root)).toBeNull();
    // as the app's records really are: a session the app gave a worktree of
    // its own, ARCHIVED — the app drops worktreeName on archive (folder =
    // branch name, worktreeName null, like local_0a000001): no 409
    write("local_0a000001", { createdAt: Date.parse("2026-09-30T11:00:00Z"), cwd: wt("suporte-indisponivel-deb42b"), worktreeName: null, isArchived: true, title: "Suporte indisponível" });
    expect(lastAppWorktreeFolder(root)).toBeNull();
    // the same, live, with its name: no 409
    write("local_b", { createdAt: Date.parse("2026-09-30T12:00:00Z"), cwd: wt("x-1a2b3c"), worktreeName: "x-1a2b3c" });
    expect(lastAppWorktreeFolder(root)).toBeNull();
    // 01/10 12:53Z: local_0a000003 opened in the folder local_0a000002 (archived) had: 409
    write("local_0a000002", { createdAt: Date.parse("2026-09-30T15:45:29Z"), cwd: wt("fix-9298-stage-time-rule-572720"), worktreeName: null, isArchived: true, title: "Automação inatividade não dispara" });
    write("local_0a000003", { createdAt: Date.parse("2026-10-01T12:53:23Z"), cwd: wt("fix-9298-stage-time-rule-572720"), worktreeName: null, isArchived: true, title: "Contrato de esquema unificado" });
    expect(lastAppWorktreeFolder(root)).toEqual({ folder: wt("fix-9298-stage-time-rule-572720"), title: "Contrato de esquema unificado", earlier: ["Automação inatividade não dispara"] });
    // reuse WITH worktreeName filled (local_0a000005 in the folder of local_0a000004): caught too
    write("local_0a000004", { createdAt: Date.parse("2026-09-29T22:35:00Z"), cwd: wt("suporte-inatividade-f30521"), isArchived: true, title: "Inatividade do suporte" });
    write("local_0a000005", { createdAt: Date.parse("2026-10-01T12:54:03Z"), cwd: wt("suporte-inatividade-f30521"), worktreeName: "suporte-inatividade-f30521", title: "Gerenciador OpenMausBot" });
    expect(lastAppWorktreeFolder(root)).toMatchObject({ title: "Gerenciador OpenMausBot", earlier: ["Inatividade do suporte"] });
    // a newest session in a worktree of its own (fresh folder): unblocked, archived or not
    write("local_root", { createdAt: Date.parse("2026-10-01T15:00:00Z"), cwd: wt("tarefa-nova-9a8b7c"), worktreeName: null, isArchived: true, title: "ok" });
    expect(lastAppWorktreeFolder(root)).toBeNull();
  });

  // R10-dispatch R10-1, the real 02/10 10:07 (redacted): the owner's own
  // session, started from the ROOT with the worktree on, landed in a folder
  // four earlier sessions had used — the 5th time. The 409 must stay on, say
  // which folder was picked (originCwd), and ask the gesture that does end it
  // (root, worktree OFF); that gesture's record then frees the app and is the
  // root session the server starts new ones from.
  it("10:07: the owner's root+worktree-on session in a 5th-time folder keeps the 409, which names the picked folder; root+worktree-off frees it", () => {
    const records = join(root, "org", "acct");
    mkdirSync(records, { recursive: true });
    const write = (id: string, extra: object) => writeFileSync(join(records, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: `c-${id}`, originCwd: REPO, ...extra }));
    const REPO = "/Users/o/Projetos/nuria-platform";
    const F = `${REPO}/.claude/worktrees/atendimento-reaberto-bugs-496989`;
    write("local_e1", { createdAt: Date.parse("2026-09-30T14:56:00Z"), cwd: F, isArchived: true, title: "Atendimento reaberto bugs" });
    write("local_e2", { createdAt: Date.parse("2026-10-01T14:12:00Z"), cwd: F, isArchived: true, title: "Tempo de reabertura configurável" });
    write("local_e3", { createdAt: Date.parse("2026-10-01T14:19:00Z"), cwd: F, isArchived: true, title: "Tempo de reabertura configurável" });
    write("local_e4", { createdAt: Date.parse("2026-10-01T14:45:00Z"), cwd: F, isArchived: true, title: "Post-release-guard PREVIOUS_COMMIT vazio" });
    // the owner's session of 10:07 BRT (13:07Z): picked the root, landed in F
    write("local_c6d395b2", { createdAt: Date.parse("2026-10-02T13:07:29Z"), cwd: F, worktreePath: F, worktreeName: "atendimento-reaberto-bugs-496989", title: "Aumentar usuários Piperun para 50" });
    const last = lastAppWorktreeFolder(root);
    expect(last).toMatchObject({ folder: F, title: "Aumentar usuários Piperun para 50", origin: REPO });
    expect(last!.earlier).toHaveLength(4);
    const refusal = reusedFolderRefusal(last!, "nuria-platform");
    expect(refusal).toContain(`, embora a pasta escolhida ao abri-la fosse ${REPO}.`);
    expect(refusal).toContain("com a worktree DESLIGADA");
    expect(refusal).not.toMatch(/worktree ligada/i);
    expect(refusal).toContain("o servidor parte dela para abrir as sessões novas");
    // no root session yet that is alive: nothing to start from
    expect(rootAnchorSession(REPO, root)).toBeNull();
    // the gesture: a new session in the root, worktree off, one message sent
    write("local_0a0000aa-0000-4000-8000-000000000000", { createdAt: Date.parse("2026-10-02T13:30:00Z"), cwd: REPO, title: "Sessão raiz do gerente OpenMausBot" });
    expect(lastAppWorktreeFolder(root)).toBeNull();
    expect(rootAnchorSession(REPO, root)).toEqual({ localId: "local_0a0000aa-0000-4000-8000-000000000000", title: "Sessão raiz do gerente OpenMausBot" });
    // and the owner's session (by hand, in the root) is not the server's own landing in the root
    expect(lastServerSessionInRoot(new Set(["local_server1"]), root)).toBeNull();
  });

  it("picks the newest live root session as the anchor: never an archived one, a worktree, a scheduled run, scratch or another repository", () => {
    const records = join(root, "org", "acct");
    mkdirSync(records, { recursive: true });
    const REPO = "/Users/o/Projetos/nuria-platform";
    const id = (n: number) => `local_0a0000${String(n).padStart(2, "0")}-0000-4000-8000-000000000000`;
    const write = (n: number, extra: object) => writeFileSync(join(records, `${id(n)}.json`), JSON.stringify({ sessionId: id(n), cliSessionId: `c-${n}`, ...extra }));
    write(1, { createdAt: 1_000, cwd: REPO, title: "Raiz antiga" });
    write(2, { createdAt: 2_000, cwd: REPO, isArchived: true, title: "Raiz arquivada" });
    write(3, { createdAt: 3_000, cwd: `${REPO}/.claude/worktrees/x-1a2b3c`, title: "Worktree" });
    write(4, { createdAt: 4_000, cwd: REPO, scheduledTaskId: "routine", title: "Rotina" });
    write(5, { createdAt: 5_000, cwd: "/Users/o/Projetos/OpenMausBot", title: "Outro repo" });
    write(6, { createdAt: 6_000, cwd: REPO, worktreePath: `${REPO}/.claude/worktrees/y-9z8y7x`, title: "Raiz com worktree" });
    writeFileSync(join(records, "local_bad.json"), JSON.stringify({ sessionId: "local_bad", cliSessionId: "c-bad", createdAt: 9_000, cwd: REPO }));
    expect(rootAnchorSession(REPO, root)).toEqual({ localId: id(1), title: "Raiz antiga" });
  });

  // INSP-S r1 S-3: a create of ours fell in the root (wrongFolder, failed and
  // left unarchived — the bot is only asked to archive it); it is the newest
  // root session, and anchoring on it would inherit the root it fell into.
  it("never anchors on a session the server opened, the failed one in the root included: only the person's own", () => {
    const records = join(root, "org", "acct");
    mkdirSync(records, { recursive: true });
    const REPO = "/Users/o/Projetos/nuria-platform";
    const id = (n: number) => `local_0a0000${String(n).padStart(2, "0")}-0000-4000-8000-000000000000`;
    const write = (n: number, extra: object) => writeFileSync(join(records, `${id(n)}.json`), JSON.stringify({ sessionId: id(n), cliSessionId: `c-${n}`, ...extra }));
    write(1, { createdAt: 1_000, cwd: REPO, title: "Sessão raiz do gerente OpenMausBot" });
    write(2, { createdAt: 2_000, cwd: REPO, title: "9311 Chat no ticket" });
    // without knowing which are ours, the newest wins: the failed server session
    expect(rootAnchorSession(REPO, root)?.localId).toBe(id(2));
    expect(rootAnchorSession(REPO, root, new Set([id(2)]))).toEqual({ localId: id(1), title: "Sessão raiz do gerente OpenMausBot" });
    // only ours in the root: no anchor (the create goes as before; the Passo 0 still guards it)
    expect(rootAnchorSession(REPO, root, new Set([id(1), id(2)]))).toBeNull();
  });

  it("blocks when the server's own last session landed in the root (the worktree option left off), and says the remedy", () => {
    const records = join(root, "org", "acct");
    mkdirSync(records, { recursive: true });
    const REPO = "/Users/o/Projetos/nuria-platform";
    const write = (id: string, extra: object) => writeFileSync(join(records, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: `c-${id}`, ...extra }));
    write("local_owner", { createdAt: 1_000, cwd: REPO, title: "Sessão raiz do gerente OpenMausBot" });
    write("local_ours", { createdAt: 2_000, cwd: REPO, title: "9298 Regra de tempo" });
    const ours = new Set(["local_ours"]);
    expect(lastServerSessionInRoot(ours, root)).toEqual({ folder: REPO, title: "9298 Regra de tempo" });
    // a scheduled run after it does not count as the newest work session
    write("local_routine", { createdAt: 3_000, cwd: REPO, scheduledTaskId: "r1" });
    expect(lastServerSessionInRoot(ours, root)).not.toBeNull();
    const text = rootFolderRefusal(lastServerSessionInRoot(ours, root)!, "nuria-platform");
    expect(text).toContain('a última sessão que o servidor abriu no app Claude ("9298 Regra de tempo") caiu na raiz');
    expect(text).toContain("LIGAR a opção worktree");
    expect(text).toContain("Então tente de novo.");
    expect(rootFolderRefusal({ folder: REPO }, "nuria-platform", true)).toContain("continua nela");
    // the owner's session in a fresh worktree after it: free again
    write("local_owner2", { createdAt: 4_000, cwd: `${REPO}/.claude/worktrees/nova-1a2b3c`, worktreeName: "nova-1a2b3c" });
    expect(lastServerSessionInRoot(ours, root)).toBeNull();
    expect(lastAppWorktreeFolder(root)).toBeNull();
  });

  it("asks the same gesture wherever it is said: 409, create refusal and the owner's item", () => {
    expect(ROOT_SESSION_HOWTO("nuria-platform", "main")).toContain("worktree OFF");
    expect(ROOT_SESSION_HOWTO("nuria-platform", "main")).not.toMatch(/worktree on\b/);
  });
});
