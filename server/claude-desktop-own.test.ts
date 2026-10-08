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
  glyphForm,
  notRepoRoot,
  rootFolderRefusal,
  trustPrompt,
  trustPromptFolder,
  trustPromptFor,
  folderChip,
  parseTrustLog,
  createDesktopSession,
  rootAnchorSession,
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

/** How many clicks of `actions` landed on a line of `screen` (as fakeApp lays it out) matching `what`. */
function clicksOn(actions: readonly string[], screen: readonly string[], what: RegExp): number {
  return actions.filter((action) => {
    const at = /^click ([\d.]+),([\d.]+)$/.exec(action);
    if (!at) return false;
    const [x, y] = [Number(at[1]), Number(at[2])];
    return screen.some((text, i) => what.test(text) && x >= 600 && x <= 800 && y >= 700 + i * 30 && y <= 716 + i * 30);
  }).length;
}

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
    // 19 of the 20 are certainly an empty box ("|O" ×18, "|П" ×1)
    for (const [seen, count] of REAL_0310.filter(([seen]) => !seen.startsWith("q9 - | |"))) {
      expect({ seen, option: worktreeOption(screenOf(seen).filter((line) => line.y === 788)) }).toEqual({ seen, option: "off" });
      expect(count).toBeGreaterThan(0);
    }
    // the 20th, "q9 - | | worktree", is ambiguous as logged (lines are joined by " | "):
    // read as one line, two edges with nothing between: off; read as "| worktree", one lone edge: unknown — never pasted on
    const line = (text: string): OcrLine => ({ x: 885, y: 788, w: 92, h: 15, text });
    expect(worktreeOption([line("q9 - | | worktree")])).toBe("off");
    expect(worktreeOption(screenOf(REAL_0310[1]![0]).filter((each) => each.y === 788))).toBe("unknown");
  });

  // Every reading the box can give (INSP-R12a X3-1): "off" only for a box proved empty, any mark "on", any doubt "unknown".
  it.each([
    // proved empty
    ["|O worktree", "off"], ["|П worktree", "off"], ["|п worktree", "off"], ["1O worktree", "off"], ["lO worktree", "off"], ["O worktree", "off"],
    ["□ worktree", "off"], ["| | worktree", "off"], ["|| worktree", "off"], ["[] worktree", "off"], ["2º omb/9378-supervisor-do-aten... 1O worktree", "off"],
    // a mark, with or without its edges
    ["v worktree", "on"], ["✓ worktree", "on"], ["|v| worktree", "on"], ["|✓| worktree", "on"], ["|x| worktree", "on"], ["[✓]| worktree", "on"], ["[✓] worktree", "on"], ["|V worktree", "on"], ["☑ worktree", "on"],
    // a doubt: never off
    ["| worktree", "unknown"], ["• pasta | worktree", "unknown"], ["| | | worktree", "unknown"], ["q9 - | | | worktree", "unknown"], ["worktree", "unknown"], ["q - worktree", "unknown"], ["|? worktree", "unknown"], ["|OO worktree", "unknown"], ["|1 worktree", "unknown"],
  ])("reads %s as %s", (text, want) => {
    expect(worktreeOption([{ x: 885, y: 788, w: 92, h: 15, text }])).toBe(want);
  });

  it("take the unreadable branch chip (\"g9 -\", \"q9 -\", \"q -\") as the base only for a ROOT session on the base: root HEAD on it, opened from the root session when there is one", () => {
    for (const [seen] of REAL_0310) {
      const lines = screenOf(seen);
      // the 03/10 screens: root on main, New Session from the root session (or no root session at all)
      expect(notRepoRoot(lines, "main", { rootHead: "main", fromRoot: true, branches: ["main", "fix/9326-x"] })).toBeNull();
      // no root session seen (none, R3-1): refused, saying so
      expect(notRepoRoot(lines, "main", { rootHead: "main" })).toContain("the app has no root session to open New Session from");
      // the root elsewhere, detached, or unknown: refused, with the owner's step (R3-2)
      expect(notRepoRoot(lines, "main", { rootHead: "HEAD", fromRoot: true })).toMatch(/^it does not show the base branch main: its branch chip could not be read \(it shows "[gq]9? -"\) and the repository root is on a detached HEAD — a raiz do repositório está em HEAD solto: volte-a para main \(git switch main na raiz\), e o caminho antigo volta a abrir sessões$/);
      expect(notRepoRoot(lines, "main", { rootHead: "fix/9326-x", fromRoot: true })).toContain("a raiz do repositório está em fix/9326-x, não em main: volte-a para main");
      expect(notRepoRoot(lines, "main", { fromRoot: true })).toContain("the repository root is on no known branch");
      // a root session exists but New Session did not open from it: no confirmation, refused
      expect(notRepoRoot(lines, "main", { rootHead: "main", fromRoot: false })).toContain("New Session was not opened from the app's root session");
    }
  });

  describe("with the app's records as they really are (INSP-R12a-r2 R2-1)", () => {
    // worktree sessions carry sourceBranch (197 of 197); root sessions never do (0 of 204)
    const ROOT = "/Users/o/Projetos/nuria-platform";
    const rootRecord = { sessionId: "local_0a0000a1-0000-4000-8000-000000000000", cliSessionId: "c-root", cwd: ROOT, originCwd: ROOT, title: "Sessão raiz do gerente OpenMausBot", createdAt: Date.parse("2026-10-03T12:00:00Z") };
    const worktreeRecord = { sessionId: "local_0a0000a2-0000-4000-8000-000000000000", cliSessionId: "c-wt", cwd: `${ROOT}/.claude/worktrees/9195-x`, worktreePath: `${ROOT}/.claude/worktrees/9195-x`, worktreeName: "9195-x", sourceBranch: "main", branch: "claude/9195-x", originCwd: ROOT, title: "9195 Filtros", createdAt: Date.parse("2026-10-03T13:00:00Z") };
    const recordsDir: string[] = [];
    afterEach(() => { for (const dir of recordsDir.splice(0)) rmSync(dir, { recursive: true, force: true }); });
    const withRecords = (records: object[]) => {
      const dir = mkdtempSync(join(tmpdir(), "omb-recs-"));
      recordsDir.push(dir);
      mkdirSync(join(dir, "org", "acct"), { recursive: true });
      for (const record of records) writeFileSync(join(dir, "org", "acct", `${(record as { sessionId: string }).sessionId}.json`), JSON.stringify(record));
      return dir;
    };
    // a 03/10 screen after New Session ("g9 -"), the root session before it, then the brief gone
    const G9 = ["• Local", "nuria-platform", "g9 - |O worktree", "Descreva uma tarefa ou faça uma pergunta", "+ O v Ignorar permissões"];
    const run = async (anchor: { localId: string; title?: string } | null, rootHead: string | null, anchorShows = true) => {
      const anchorScreen = anchorShows ? ["Sessão raiz do gerente OpenMausBot v (nuria-platform", "Responder…", "+ O v Ignorar permissões"] : ["Outra coisa v (nuria-platform", "Responder…", "+ O v Ignorar permissões"];
      // (no root session: no screen for it — New Session comes right after the first look)
      const app = fakeApp(anchor ? [["tela qualquer"], anchorScreen, G9, SENT] : [["tela qualquer"], G9, SENT]);
      const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "brief", anchor, rootHead });
      return { step, pasted: app.actions.some((action) => action.startsWith("paste")) };
    };

    it("a root session on record, root on main, New Session from it: the unreadable chip passes — the newer worktree session's sourceBranch is not looked at", async () => {
      const anchor = rootAnchorSession(ROOT, withRecords([rootRecord, worktreeRecord]));
      expect(anchor).toEqual({ localId: rootRecord.sessionId, title: rootRecord.title });
      const ok = await run(anchor, "main");
      expect(ok.pasted).toBe(true);
      // the root session did not show: no confirmation, refused
      const unconfirmed = await run(anchor, "main", false);
      expect(unconfirmed.pasted).toBe(false);
      expect(!unconfirmed.step.ok && unconfirmed.step.reason).toContain("New Session was not opened from the app's root session");
      // the root detached: refused, whatever the worktree session recorded
      const detached = await run(anchor, "HEAD");
      expect(detached.pasted).toBe(false);
      // R3-2: the detached root said as what to do
      expect(!detached.step.ok && detached.step.reason).toContain("a raiz do repositório está em HEAD solto: volte-a para main (git switch main na raiz)");
    });

    it("only worktree sessions on record (sourceBranch main): no root session to open New Session from, so the unreadable chip is refused even with the root on main (INSP-R12a-r3 R3-1)", async () => {
      expect(rootAnchorSession(ROOT, withRecords([worktreeRecord]))).toBeNull();
      const noAnchor = await run(null, "main");
      expect(noAnchor.pasted).toBe(false);
      expect(!noAnchor.step.ok && noAnchor.step.reason).toContain("the app has no root session to open New Session from — abra no app uma sessão na raiz");
      const detached = await run(null, "HEAD");
      expect(detached.pasted).toBe(false);
      expect(!detached.step.ok && detached.step.reason).toContain("a raiz do repositório está em HEAD solto");
    });

    it("a root session with no title is never counted as seen (INSP-R12a-r3 R3-3)", async () => {
      const untitled = { ...rootRecord, title: undefined };
      const anchor = rootAnchorSession(ROOT, withRecords([untitled]));
      expect(anchor).toEqual({ localId: rootRecord.sessionId });
      const step = await run(anchor, "main");
      expect(step.pasted).toBe(false);
      expect(!step.step.ok && step.step.reason).toContain("New Session was not opened from the app's root session");
    });
  });

  it("read the branch word as the base only with look-alike glyphs, same length, and no other branch reading the same", () => {
    const chips = (branch: string) => [{ x: 540, y: 788, w: 60, h: 16, text: "• Local" }, { x: 660, y: 788, w: 60, h: 16, text: "nuria-platform" }, { x: 801, y: 788, w: 60, h: 16, text: `gº ${branch}` }, { x: 885, y: 788, w: 92, h: 15, text: "|O worktree" }];
    for (const word of ["main", "maln", "ma1n", "rnain", "MAIN"]) expect({ word, why: notRepoRoot(chips(word), "main") }).toEqual({ word, why: null });
    for (const word of ["rain", "mai", "mainx", "man", "maim"]) expect({ word, why: notRepoRoot(chips(word), "main") }).toEqual({ word, why: `it shows ${word}, not main` });
    // another branch of the repository that reads the same: refused
    expect(notRepoRoot(chips("maln"), "main", { branches: ["main", "maln"] })).toBe("it shows maln, not main");
    expect(notRepoRoot(chips("develop"), "main", { rootHead: "main" })).toBe("it shows develop, not main");
    expect(notRepoRoot(chips("fix/9326-x"), "main", { rootHead: "main" })).toBe("it shows fix/9326-x, not main");
    // the icon is "g"/"q" with "º", "°" or "9" — never a word like "go" ("go mainx")
    const go = [{ x: 801, y: 788, w: 60, h: 16, text: "go mainx" }, { x: 885, y: 788, w: 92, h: 15, text: "|O worktree" }];
    expect(notRepoRoot(go, "main", { rootHead: "main" })).toBe("it does not show the base branch main");
    expect(glyphForm("rnaln")).toBe("main");
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

  it("trusts the workspace only once the screen shows our folder's new session, and the folder is a worktree git lists — and pastes nothing on that screen: the link is opened again first (R13-3)", async () => {
    const { worktree, alias } = ownFolder();
    const app = fakeApp([screen9378(true), screen9378(false), SENT]);
    const step = await openDesktopSessionIn(app.driver, { folder: alias, folderName: FOLDER_9378, text: "9378 Supervisor\n[OMBX]\n\nPasso 0…", expected: worktree, registered: () => ["/elsewhere", worktree] });
    expect(step).toMatchObject({ ok: false, retry: true, touched: true, trusted: true });
    expect((step as { miss?: boolean }).miss).toBeUndefined();
    expect(!step.ok && step.reason).toContain("the app's link is opened again and the folder checked before the brief goes in");
    // the prompt (1st line, y 700) clicked, and nothing else
    expect(app.actions[1]).toBe("click 700,708");
    expect(app.actions.filter((action) => action.startsWith("click"))).toHaveLength(1);
    expect(app.actions.some((action) => action.startsWith("paste") || action.startsWith("type") || action.startsWith("key"))).toBe(false);
  });

  // ~/Library/Logs/Claude/main.log, 06/10 (BRT): both clicks the server made.
  //   11:06:05 saveTrust …/9378-supervisor-papel-base-gerente-b23900 → 11:06:15 createScratchWorkspace,
  //            Starting local session local_8279164e… in …/scratch-2026-10-06-c55113 (b23900b6: the brief in a scratch)
  //   12:01:25 saveTrust …/9384-hook-v2-7-c2b-append-atendimento-b7fcd0 → 12:01:28 prewarmLocal in …/scratch-2026-10-06-f4fcb5
  // server.log has the chips still ours a second after the click, and the brief pasted there.
  it("the 11:06 and 12:01 sequences of 06/10: click, then the link opened again with the folder trusted, checked, and only then the paste", async () => {
    for (const folder of ["9378-supervisor-papel-base-gerente-b23900", "9384-hook-v2-7-c2b-append-atendimento-b7fcd0"]) {
      const root = mkdtempSync(join(tmpdir(), "omb-trust-"));
      dirs.push(root);
      const worktree = join(root, "nuria-platform", ".claude", "worktrees", folder);
      mkdirSync(worktree, { recursive: true });
      const alias = join(root, ".omb-worktree-links", "nuria-platform", folder);
      mkdirSync(join(alias, ".."), { recursive: true });
      symlinkSync(worktree, alias);
      const cut = `${folder.slice(0, 22)}…`;
      const prompt = ["Confiar no workspace", "• Local", `• ${cut}`, `2º omb/${folder.slice(0, 20)}... 1O worktree`, "Descreva uma tarefa ou faça uma pergunta", "+ O v Automático"];
      const after = prompt.slice(1);
      const input = { folder: alias, folderName: folder, text: `${folder.slice(0, 4)} brief\n[OMBX]`, expected: worktree, registered: () => [worktree] };
      // the try with the prompt: the click, our chip a second later — and no paste (the app was about to move it to a scratch)
      const first = fakeApp([prompt, after]);
      expect(await openDesktopSessionIn(first.driver, input)).toMatchObject({ ok: false, trusted: true });
      expect(first.actions.some((action) => action.startsWith("paste"))).toBe(false);
      // the next try: the link again, no prompt now, our folder checked from the start, then the brief
      const second = fakeApp([after, SENT]);
      expect(await openDesktopSessionIn(second.driver, input)).toEqual({ ok: true });
      expect(second.actions[0]).toBe(`open claude://code/new?folder=${encodeURIComponent(alias)}`);
      expect(second.actions.some((action) => action.startsWith("paste"))).toBe(true);
      // and should the reopened link show the scratch the app made, nothing goes in
      const scratch = fakeApp([[...after.slice(0, 2), "scratch-2026-10-06-c55113", ...after.slice(2)]]);
      const refused = await openDesktopSessionIn(scratch.driver, input);
      expect(refused).toMatchObject({ ok: false, miss: true });
      expect(!refused.ok && refused.reason).toContain("scratch folder");
      expect(scratch.actions.some((action) => action.startsWith("paste") || action.startsWith("click"))).toBe(false);
    }
  });

  it("clicks nothing when the folder is not a worktree git lists for the repository, or is not ours: the person is asked (trustNeeded)", async () => {
    const { worktree, alias } = ownFolder();
    for (const input of [{}, { expected: "/Users/o/Projetos/outro", registered: () => ["/Users/o/Projetos/outro"] }, { expected: worktree }, { expected: worktree, registered: () => ["/Users/o/Projetos/outro"] }]) {
      const app = fakeApp([screen9378(true)]);
      const step = await openDesktopSessionIn(app.driver, { folder: alias, folderName: FOLDER_9378, text: "brief", ...input });
      expect(step).toMatchObject({ ok: false, retry: true, trustNeeded: alias });
      expect(app.actions.some((action) => action.startsWith("click") || action.startsWith("paste"))).toBe(false);
    }
  });

  it("clicks nothing when the screen with the prompt does not show our folder (the link opened something else): a miss (INSP-R12a X3-2)", async () => {
    const { worktree, alias } = ownFolder();
    const other = ["Confiar no workspace", "• Local", "• outra-pasta", "|O worktree", "Descreva uma tarefa ou faça uma pergunta", "+ O v Ignorar permissões"];
    const noField = ["Confiar no workspace", "• Local", `• ${FOLDER_9378}`, "|O worktree"];
    for (const screenLines of [other, noField]) {
      const app = fakeApp([screenLines]);
      // git's list is not even read when the screen is not ours (INSP-R12a-r2 R2-5)
      let listed = 0;
      const step = await openDesktopSessionIn(app.driver, { folder: alias, folderName: FOLDER_9378, text: "brief", expected: worktree, registered: () => { listed += 1; return [worktree]; } });
      expect(listed).toBe(0);
      expect(step).toMatchObject({ ok: false, miss: true });
      // o73: the other folder's chip is tried in the folder picker (it opens nothing here); "Confiar" never
      expect(!step.ok && step.reason).toContain(screenLines === other ? "nothing was typed; tried on screen first: clicked the folder chip" : "nothing was clicked or typed");
      expect(clicksOn(app.actions, screenLines, /^Confiar/)).toBe(0);
      expect(app.actions.filter((action) => action.startsWith("click"))).toHaveLength(screenLines === other ? 1 : 0);
      expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
    }
  });

  it("stops without typing when the prompt stays after the click (a miss)", async () => {
    const { worktree, alias } = ownFolder();
    const app = fakeApp([screen9378(true)]);
    const step = await openDesktopSessionIn(app.driver, { folder: alias, folderName: FOLDER_9378, text: "brief", expected: worktree, registered: () => [worktree] });
    expect(step).toMatchObject({ ok: false, miss: true });
    expect(!step.ok && step.reason).toContain("still asks to trust the workspace");
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
  });

  it("takes only a whole prompt line or a bare button as the prompt, never a sentence (INSP-R12a X3-3)", () => {
    const at = (text: string): OcrLine[] => [{ x: 600, y: 800, w: 200, h: 16, text }];
    for (const text of ["Confiar no workspace", "• Confiar no workspace", "Confiar neste workspace", "Trust this workspace", "Trust the folder", "Confiar", "Trust"]) expect({ text, found: trustPrompt(at(text)) !== null }).toEqual({ text, found: true });
    for (const text of ["Confiar no workspace do cliente é arriscado", "Trust the folder before running", "Confiar?", "Confiar em quem?", "Não confiar no workspace"]) expect({ text, found: trustPrompt(at(text)) !== null }).toEqual({ text, found: false });
  });

  it("never trusts in the old way (New Session in the repository): the person is asked", async () => {
    const app = fakeApp([["Sessão antiga v (nuria-platform"], ["Confiar no workspace", "• Local", "nuria-platform", "gº main", "|O worktree", "Descreva uma tarefa ou faça uma pergunta"]]);
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "brief" });
    expect(step).toMatchObject({ ok: false, trustNeeded: "nuria-platform" });
    expect(app.actions.some((action) => action.startsWith("click") || action.startsWith("paste"))).toBe(false);
  });

  it("in the old way, a conversation that says those words above the composer, before New Session opened, is not a prompt", async () => {
    // the anchor's conversation on screen (upper half), New Session does not change the screen: a miss, not a trust question
    const convo = [{ text: "Confiar no workspace", x: 600, y: 200 }, { text: "Sessão antiga v (nuria-platform", x: 600, y: 100 }];
    const app = fakeApp([convo.map((each) => each.text)]);
    const step = await createDesktopSession(app.driver, { repoName: "nuria-platform", text: "brief" });
    expect(step).toMatchObject({ ok: false });
    expect((step as { trustNeeded?: string }).trustNeeded).toBeUndefined();
  });
});

// The 16 creates of 05–06/10 that stopped at "does not show the folder" with
// the trust prompt on screen (server.log: time, session, the folder asked
// for, what the screen showed). INSP-R13dis 1/2/7: main.log follows the
// composer, not the button (06/10 03:31:25 checkTrust of …/9337-…-2f6a57, the
// chip's folder, 4 s before e712f070's screen) — so with the chips on another
// folder, or cut short to a start another worktree shares, nothing is ever
// clicked, whatever the log says, and the create goes to the cli.
const REAL_TRUST_16: Array<[string, string, string, string]> = [
  ["2026-10-05T16:00:50Z", "472b5524", "9378-supervisor-do-atendimento", "Confiar no workspace | • Local | • 9378-supervisor-do-ate…. | 2º omb/9378-supervisor-do-aten... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.,5 | Médio"],
  ["2026-10-05T16:02:00Z", "472b5524", "9378-supervisor-do-atendimento", "Confiar no workspace | • Local | • 9378-supervisor-do-ate…. | 2º omb/9378-supervisor-do-aten... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.,5 | Médio"],
  ["2026-10-05T16:04:10Z", "472b5524", "9378-supervisor-do-atendimento", "Confiar no workspace | • Local | • 9378-supervisor-do-ate…. | 2º omb/9378-supervisor-do-aten... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.,5 | Médio"],
  ["2026-10-05T18:37:31Z", "035161dc", "9378-supervisor-do-atendimento-035161", "Confiar no workspace | • Local | • 9378-supervisor-do-ate…. | 2º omb/9378-supervisor-do-aten... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.5 | Médio"],
  ["2026-10-05T18:38:20Z", "035161dc", "9378-supervisor-do-atendimento-035161", "Confiar no workspace | • Local | • 9378-supervisor-do-ate…. | 2º omb/9378-supervisor-do-aten... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.5 | Médio"],
  ["2026-10-05T18:41:50Z", "2f2ec068", "9337-sobrecarga-d1-no-envio-do-agente", "Confiar no workspace | • Local | • 9378-supervisor-do-ate…. | 2º omb/9378-supervisor-do-aten... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.,5 | Médio"],
  ["2026-10-05T19:45:39Z", "035161dc", "9378-supervisor-do-atendimento-035161", "Confiar no workspace | • Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.5 | Médio"],
  ["2026-10-05T19:56:12Z", "2f2ec068", "9337-sobrecarga-d1-no-envio-do-agente", "Confiar no workspace | • Local | • 9337-sobrecarga-d1-no-….. | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.5 | Médio"],
  ["2026-10-06T03:31:29Z", "e712f070", "9378-supervisor-papel-base-gerente", "Confiar no workspace | • Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.5 | Médio"],
  ["2026-10-06T03:32:09Z", "e712f070", "9378-supervisor-papel-base-gerente", "Confiar no workspace | • Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.5 | Médio"],
  ["2026-10-06T03:33:19Z", "e712f070", "9378-supervisor-papel-base-gerente", "Confiar no workspace | • Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.5 | Médio"],
  ["2026-10-06T03:43:48Z", "e0d7126a", "9378-supervisor-papel-base-gerente-e0d712", "Confiar no workspace | • Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.5 | Médio"],
  ["2026-10-06T03:44:29Z", "e0d7126a", "9378-supervisor-papel-base-gerente-e0d712", "Confiar no workspace | • Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.5 | Médio"],
  ["2026-10-06T03:45:39Z", "e0d7126a", "9378-supervisor-papel-base-gerente-e0d712", "Confiar no workspace | • Local | • 9337-sobrecarga-d1-no-... | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.5 | Médio"],
  ["2026-10-06T14:02:55Z", "b23900b6", "9378-supervisor-papel-base-gerente-b23900", "Confiar no workspace | • Local | • 9337-sobrecarga-d1-no-….. | 2º omb/9337-sobrecarga-d1-no-e... 1O worktree | Descreva uma tarefa ou faça uma pergunta | + O v Automático | Opus 5.5 | Médio"],
  ["2026-10-06T14:52:35Z", "b7fcd057", "9384-hook-v2-7-c2b-append-atendimento-b7fcd0", "Confiar no workspace | • Local | • nuria-platform | gº main |O worktree | Descreva uma tarefa ou faça uma pergunta | + o v Ignorar permissões | Opus 5.5 | Médio"],
];

describe("\"Confiar\" never with the chip on another folder, nor on an ambiguous cut: the cli instead (INSP-R13dis 1, 2, 4, 5)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  /** The worktrees git listed at `at` (the 16's folders made by then, and 2f6a57's from 05/10 23:56Z), for real: by real path. */
  const world = (folder: string, at = "2026-10-07T00:00:00Z") => {
    const root = mkdtempSync(join(tmpdir(), "omb-trust16-"));
    dirs.push(root);
    const make = (name: string) => {
      const worktree = join(root, "nuria-platform", ".claude", "worktrees", name);
      mkdirSync(worktree, { recursive: true });
      const alias = join(root, ".omb-worktree-links", "nuria-platform", name);
      mkdirSync(join(alias, ".."), { recursive: true });
      try { symlinkSync(worktree, alias); } catch { /* made already */ }
      return { worktree, alias };
    };
    const before = make("9337-sobrecarga-d1-no-envio-do-agente-2f6a57");
    const listed = [...new Set(REAL_TRUST_16.filter(([when]) => when <= at).map(([, , name]) => name))].map((name) => make(name).worktree);
    if (at > "2026-10-05T23:56:00Z") listed.push(before.worktree);
    const ours = make(folder);
    if (!listed.includes(ours.worktree)) listed.push(ours.worktree);
    return { ours, before, listed };
  };
  /** A line of main.log as the app writes it: local time, to the second. */
  const logLine = (at: number, text: string) => {
    const d = new Date(at);
    const two = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} [info] ${text}`;
  };
  const screenFrom = (seen: string) => seen.split(" | ");
  const ocr = (seen: string) => screenFrom(seen).map((text, i) => ({ x: 600, y: 700 + i * 30, w: 200, h: 16, text }));
  const names = (paths: readonly string[]) => paths.map((path) => path.split("/").pop()!);
  // with the branch the server gives each worktree (omb/<folder>): the branch chip corroborates a cut (R2-3)
  const chipOf = ([at, , folder, seen]: [string, string, string, string]) => folderChip(ocr(seen), folder, () => names(world(folder, at).listed), `omb/${folder}`);

  it("are 16: in 4 the chip is ours (cut, and no other worktree starts so), in 2 the cut is ambiguous (035161dc with 472b5524's worktree there), in 10 another folder", () => {
    expect(REAL_TRUST_16).toHaveLength(16);
    expect(REAL_TRUST_16.every(([, , , seen]) => trustPrompt(ocr(seen))?.text === "Confiar no workspace")).toBe(true);
    const read = REAL_TRUST_16.map((row) => `${row[1]} ${row[0].slice(11, 16)} ${chipOf(row)}`);
    expect(read).toEqual([
      "472b5524 16:00 cut", "472b5524 16:02 cut", "472b5524 16:04 cut",
      "035161dc 18:37 ambiguous", "035161dc 18:38 ambiguous",
      "2f2ec068 18:41 none", "035161dc 19:45 none", "2f2ec068 19:56 cut",
      "e712f070 03:31 none", "e712f070 03:32 none", "e712f070 03:33 none",
      "e0d7126a 03:43 none", "e0d7126a 03:44 none", "e0d7126a 03:45 none",
      "b23900b6 14:02 none", "b7fcd057 14:52 none",
    ]);
  });

  const notOurs = REAL_TRUST_16.filter((row) => chipOf(row) === "none" || chipOf(row) === "ambiguous");
  it.each(notOurs)("%s %s (%s): no click whatever main.log says — even a check of OUR worktree after the link — and the step sends the create to the cli (previousFolder)", async (at, _session, folder, seen) => {
    const { ours, listed } = world(folder, at);
    vi.setSystemTime(Date.parse(at) - 4_000);
    const opened = Date.now();
    const log = [logLine(opened - 60_000, "LocalSessions.checkTrust: cwd=/Users/o/Projetos/nuria-platform"), logLine(opened + 1_000, `LocalSessions.checkTrust: cwd=${ours.alias}`)].join("\n");
    const app = fakeApp([screenFrom(seen)]);
    const step = await openDesktopSessionIn(app.driver, { folder: ours.alias, folderName: folder, text: "brief", expected: ours.worktree, registered: () => listed, trustLog: () => log });
    expect(step).toMatchObject({ ok: false, miss: true, retry: true, previousFolder: true });
    // o73: the folder picker is tried first — here the chip opens nothing — and "Confiar" is never clicked
    expect(!step.ok && step.reason).toContain("nothing was typed; tried on screen first: clicked the folder chip");
    expect(app.actions.some((action) => action.startsWith("paste") || action.startsWith("type"))).toBe(false);
    expect(app.actions.filter((action) => action.startsWith("click"))).toHaveLength(1);
    expect(clicksOn(app.actions, screenFrom(seen), /^Confiar/)).toBe(0);
  });

  it("the real pair of 05/10: 035161dc's cut chip is ours only while no other worktree starts so (472b5524's there: ambiguous, no click, even with nothing in the log)", async () => {
    const [at, , folder, seen] = REAL_TRUST_16[3]!;
    expect(folder).toBe("9378-supervisor-do-atendimento-035161");
    const { ours, listed } = world(folder, at);
    expect(names(listed)).toContain("9378-supervisor-do-atendimento");
    expect(folderChip(ocr(seen), folder, () => names(listed))).toBe("ambiguous");
    expect(folderChip(ocr(seen), folder, () => [folder])).toBe("cut");
    vi.setSystemTime(Date.parse(at) - 4_000);
    const app = fakeApp([screenFrom(seen)]);
    const step = await openDesktopSessionIn(app.driver, { folder: ours.alias, folderName: folder, text: "b", expected: ours.worktree, registered: () => listed, trustLog: () => "" });
    expect(step).toMatchObject({ ok: false, previousFolder: true });
    expect(!step.ok && step.reason).toContain("cut short to a start that another worktree of the repository shares");
    expect(clicksOn(app.actions, screenFrom(seen), /^Confiar/)).toBe(0);
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
    // and 2f2ec068 at 18:41, asking for 9337, read the same chip: the folder before
    const [at2, , folder2, seen2] = REAL_TRUST_16[5]!;
    expect(seen2).toContain("9378-supervisor-do-ate");
    expect(folderChip(ocr(seen2), folder2, () => names(world(folder2, at2).listed))).toBe("none");
  });

  it("no folder chip read at all (OCR, or not drawn yet) is not \"another folder\": a plain miss to try again — no cli, no breaker; the 16 keep their way (R2-2)", async () => {
    // the 16: each had a folder chip read, so none of them is "unread" (the table above stands)
    expect(REAL_TRUST_16.map((row) => chipOf(row)).filter((chip) => chip === "unread")).toEqual([]);
    const [at, , folder] = REAL_TRUST_16[8]!;
    const { ours, listed } = world(folder, at);
    for (const blind of [
      ["Confiar no workspace", "• Local", "2º omb/9337-sobrecarga-d1-no-e... 1O worktree", "Descreva uma tarefa ou faça uma pergunta", "+ O v Automático"],
      ["• Local", "|O worktree", "Descreva uma tarefa ou faça uma pergunta", "Médio"],
      ["Descreva uma tarefa ou faça uma pergunta", "• nuria-platform"],
    ]) {
      expect(folderChip(blind.map((text, i) => ({ x: 600, y: 700 + i * 30, w: 200, h: 16, text })), folder, () => names(listed))).toBe("unread");
      const app = fakeApp([blind]);
      const step = await openDesktopSessionIn(app.driver, { folder: ours.alias, folderName: folder, text: "b", expected: ours.worktree, registered: () => listed });
      expect(step).toMatchObject({ ok: false, miss: true, retry: true });
      expect((step as { previousFolder?: boolean }).previousFolder).toBeUndefined();
      expect((step as { cliNow?: boolean }).cliNow).toBeUndefined();
      expect(!step.ok && step.reason).toContain("could not read the new session's folder chip");
      expect(app.actions.some((action) => action.startsWith("click") || action.startsWith("paste"))).toBe(false);
    }
  });

  it("the branch chip corroborates a cut: the 4 real cuts fit their omb/ branch, and a cut whose branch chip is another one is ambiguous (R2-3)", () => {
    const [at, , folder, seen] = REAL_TRUST_16[0]!;
    const listed = names(world(folder, at).listed);
    expect(folderChip(ocr(seen), folder, () => listed, `omb/${folder}`)).toBe("cut");
    expect(folderChip(ocr(seen.replace("omb/9378-supervisor-do-aten...", "omb/9378-supervisor-papel-b...")), folder, () => listed, `omb/${folder}`)).toBe("ambiguous");
    expect(folderChip(ocr(seen.replace("omb/9378-supervisor-do-aten...", "omb/9378-supervisor-do-atendimento-x")), folder, () => listed, `omb/${folder}`)).toBe("ambiguous");
    // no branch chip read: the cut stands on the worktree list alone
    expect(folderChip(ocr(seen.replace("2º omb/9378-supervisor-do-aten... ", "")), folder, () => listed, `omb/${folder}`)).toBe("cut");
  });

  it("our chip (472b5524, 16:00): the log or the prompt naming ANOTHER folder since the link — no click, named; the X3-2 git check still asked", async () => {
    const [at, , folder, seen] = REAL_TRUST_16[0]!;
    const { ours, before, listed } = world(folder, at);
    vi.setSystemTime(Date.parse(at) - 4_000);
    const other = fakeApp([screenFrom(seen)]);
    const step = await openDesktopSessionIn(other.driver, { folder: ours.alias, folderName: folder, text: "brief", expected: ours.worktree, registered: () => listed, trustLog: () => logLine(Date.now() + 1_000, `LocalSessions.checkTrust: cwd=${before.alias}`) });
    expect(step).toMatchObject({ ok: false, miss: true });
    expect(!step.ok && step.reason).toContain(`trust the workspace ${before.alias}, not ${folder}`);
    expect(other.actions.some((action) => action.startsWith("click"))).toBe(false);
    const named = (path: string) => screenFrom(seen).map((line) => (line === "Confiar no workspace" ? `Confiar em ${path} e iniciar uma sessão de código?` : line)).concat("Confiar");
    expect(trustPromptFolder([{ x: 0, y: 0, w: 0, h: 0, text: `Confiar em ${ours.alias} e iniciar uma sessão de código?` }])).toBe(ours.alias);
    const no = fakeApp([named(before.alias)]);
    expect(await openDesktopSessionIn(no.driver, { folder: ours.alias, folderName: folder, text: "b", expected: ours.worktree, registered: () => listed, trustLog: () => "" })).toMatchObject({ ok: false, miss: true });
    expect(no.actions.some((action) => action.startsWith("click"))).toBe(false);
    const yes = fakeApp([named(ours.alias), screenFrom(seen).slice(1)]);
    expect(await openDesktopSessionIn(yes.driver, { folder: ours.alias, folderName: folder, text: "b", expected: ours.worktree, registered: () => listed, trustLog: () => "" })).toMatchObject({ trusted: true });
    // ours by every reading, but git does not list it: the person decides (X3-2)
    const notGits = fakeApp([named(ours.alias)]);
    expect(await openDesktopSessionIn(notGits.driver, { folder: ours.alias, folderName: folder, text: "b", expected: ours.worktree, registered: () => ["/elsewhere"], trustLog: () => "" })).toMatchObject({ ok: false, trustNeeded: ours.alias });
    expect(notGits.actions.some((action) => action.startsWith("click"))).toBe(false);
  });

  it("one click per create: after it, the prompt again or a scratch is no second click — the cli (cliNow)", async () => {
    const [at, , folder, seen] = REAL_TRUST_16[0]!;
    const { ours, listed } = world(folder, at);
    vi.setSystemTime(Date.parse(at));
    const again = fakeApp([screenFrom(seen)]);
    const step = await openDesktopSessionIn(again.driver, { folder: ours.alias, folderName: folder, text: "b", expected: ours.worktree, registered: () => listed, trustClicks: 1 });
    expect(step).toMatchObject({ ok: false, cliNow: true });
    expect(!step.ok && step.reason).toContain("no second click");
    expect(again.actions.some((action) => action.startsWith("click"))).toBe(false);
    const scratch = fakeApp([[...screenFrom(seen).slice(1, 3), "scratch-2026-10-06-c55113", ...screenFrom(seen).slice(3)]]);
    expect(await openDesktopSessionIn(scratch.driver, { folder: ours.alias, folderName: folder, text: "b", expected: ours.worktree, registered: () => listed, trustClicks: 1 })).toMatchObject({ ok: false, cliNow: true });
    expect(scratch.actions.some((action) => action.startsWith("click") || action.startsWith("paste"))).toBe(false);
  });

  it("ties by the newest line, never one of up to 999 ms before the link, and two folders in the newest second tie to none", () => {
    const { ours, before } = world("9378-supervisor-do-atendimento", "2026-10-05T16:00:50Z");
    const opened = new Date(2026, 9, 5, 13, 0, 6, 500).getTime();
    const line = (second: number, folder: string) => ({ at: new Date(2026, 9, 5, 13, 0, second).getTime(), kind: "check" as const, folder });
    // the second the link was opened in: not "after" it
    expect(trustPromptFor([], [line(6, ours.alias)], opened, ours.worktree)).toEqual({ is: "none" });
    expect(trustPromptFor([], [line(7, ours.alias)], opened, ours.worktree)).toEqual({ is: "ours" });
    // the newest second wins over an older one, whatever the file order
    expect(trustPromptFor([], [line(9, before.alias), line(8, ours.alias)], opened, ours.worktree)).toEqual({ is: "other", folder: before.alias });
    // two folders in the newest second: nothing ties it (no first-in-file win)
    expect(trustPromptFor([], [line(8, ours.alias), line(8, before.alias)], opened, ours.worktree)).toEqual({ is: "none" });
    expect(trustPromptFor([], [line(8, ours.alias), line(8, ours.worktree)], opened, ours.worktree)).toEqual({ is: "ours" });
  });

  it("after the click, the app saving the trust for another folder is a miss, said", async () => {
    const [at, , folder, seen] = REAL_TRUST_16[0]!;
    const { ours, before, listed } = world(folder, at);
    vi.setSystemTime(Date.parse(at));
    const opened = Date.now();
    let reads = 0;
    const log = () => (reads++ === 0 ? logLine(opened, `LocalSessions.checkTrust: cwd=${ours.alias}`) : `${logLine(opened, `LocalSessions.checkTrust: cwd=${ours.alias}`)}\n${logLine(Date.now(), `Saved workspace trust for ${before.alias}`)}`);
    const app = fakeApp([screenFrom(seen), screenFrom(seen).slice(1)]);
    const step = await openDesktopSessionIn(app.driver, { folder: ours.alias, folderName: folder, text: "b", expected: ours.worktree, registered: () => listed, trustLog: log });
    expect(step).toMatchObject({ ok: false, miss: true });
    expect(!step.ok && step.reason).toContain(`the app saved the trust for ${before.alias}`);
  });

  it("reads main.log's trust lines as the app writes them (06/10 11:04:44 BRT)", () => {
    const lines = parseTrustLog([
      "2026-10-06 11:04:41 [info] LocalSessions.getPrChecks: cwd=/x, prNumber=9386",
      "2026-10-06 11:04:44 [info] LocalSessions.saveTrust: cwd=/Users/osvaldo/Projetos/.omb-worktree-links/nuria-platform/9378-supervisor-papel-base-gerente-b23900",
      "2026-10-06 11:04:44 [info] Saved workspace trust for /Users/osvaldo/Projetos/.omb-worktree-links/nuria-platform/9378-supervisor-papel-base-gerente-b23900",
      "2026-10-06 11:06:15 [info] LocalSessions.checkTrust: cwd=/Users/osvaldo/Library/Application Support/Claude/scratch-workspaces/x/scratch-2026-10-06-c55113",
    ].join("\n"));
    expect(lines.map((each) => [each.kind, each.folder.split("/").pop()])).toEqual([["save", "9378-supervisor-papel-base-gerente-b23900"], ["save", "9378-supervisor-papel-base-gerente-b23900"], ["check", "scratch-2026-10-06-c55113"]]);
    expect(lines[0]!.at).toBe(new Date(2026, 9, 6, 11, 4, 44).getTime());
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

  it("takes the new-session field the app draws today in either of its two texts (2.26454.0, ion-dist i18n) — R13-dispatch", async () => {
    for (const field of ["Descreva uma tarefa ou faça uma pergunta", "Descreva algo para criar, alterar ou corrigir", "Describe a task or ask a question", "Describe something to build, change, or fix"]) {
      const app = fakeApp([NEW_IN_FOLDER.map((line) => (line.startsWith("Descreva uma tarefa") ? field : line)), SENT]);
      expect({ field, step: await openDesktopSessionIn(app.driver, { folder: LINK, folderName: FOLDER, text: "brief" }) }).toEqual({ field, step: { ok: true } });
    }
    // the composer of a session already open is no new session's field
    const open = fakeApp([NEW_IN_FOLDER.map((line) => (line.startsWith("Descreva uma tarefa") ? "Digite / para comandos" : line))]);
    expect(await openDesktopSessionIn(open.driver, { folder: LINK, folderName: FOLDER, text: "brief" })).toMatchObject({ ok: false, miss: true });
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
    expect(step).toMatchObject({ ok: false, miss: true, previousFolder: true });
    expect(!step.ok && step.reason).toContain("shows another folder in its chips (the folder before), not 9353-comprar-assentos");
    expect(app.actions.some((action) => action.startsWith("paste"))).toBe(false);
  });

  it.each([
    // o73: ON is clicked off (twice at most); an unreadable box is only read again — the fake app never changes, so both stop
    ["ON (the tick, as on R8-visual-claude-1: \"v worktree\")", "v worktree", "has the worktree option ON", 2, "clicked the worktree option (\"v\") to turn it off"],
    ["unreadable", "? worktree", "could not read whether the new session's worktree option is on or off", 0, "read the screen again"],
  ])("pastes nothing when the worktree option is %s: a miss, before the brief goes in (R11-1)", async (_name, chip, said, clicks, tried) => {
    const app = fakeApp([NEW_IN_FOLDER.map((line) => (line === "|O worktree" ? chip : line))]);
    const step = await openDesktopSessionIn(app.driver, { folder: LINK, folderName: FOLDER, text: "brief" });
    expect(step).toMatchObject({ ok: false, retry: true, miss: true, touched: true });
    expect(!step.ok && step.reason).toContain(said);
    expect(!step.ok && step.reason).toContain("nothing was typed");
    expect(!step.ok && step.reason).toContain(`tried on screen first: ${tried}`);
    expect(step).toMatchObject({ worktreeOption: chip.startsWith("v") ? "on" : "unknown" });
    expect(app.actions.some((action) => action.startsWith("paste") || action.startsWith("type"))).toBe(false);
    expect(app.actions.filter((action) => action.startsWith("click"))).toHaveLength(clicks);
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
