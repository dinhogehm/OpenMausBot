import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveCleanupNote, codexRolloutFolders, conversationFolders, diskAlertText, folderActivity, isDisposableIgnored, nestedWorktrees, parseWorktreeList, planArchivedWorktree, planNestedWorktrees, planReleasedWorktrees, RELEASED_MIN_IDLE_MS,
  releasedPlanLine, releasedScopeLine, scanTaskWorkspaces, sizeLabel, staleFoldersLogLine, staleFoldersReport, staleTaskWorkspaces, unquoteGit, worktreeLastActivity, type ReleasedPlanDeps,
} from "./nested-worktrees.ts";
import { liveRecordFolders } from "./claude-desktop.ts";

const parent = "/r/nuria-platform/.claude/worktrees/9286-lote";
const porcelain = [
  "worktree /r/nuria-platform\nHEAD aaa\nbranch refs/heads/main",
  `worktree ${parent}\nHEAD bbb\nbranch refs/heads/claude/9286-lote`,
  `worktree ${parent}/g9278\nHEAD c78\nbranch refs/heads/hotfix/9278`,
  `worktree ${parent}/c9322\nHEAD c22\nbranch refs/heads/chore/carrier-9322`,
  `worktree ${parent}/wt9278\nHEAD w78\nbranch refs/heads/fix/9278-eng\nlocked`,
  `worktree ${parent}/g9330\nHEAD c30\nbranch refs/heads/fix/9330`,
  `worktree ${parent}-other\nHEAD ddd\nbranch refs/heads/x`,
].join("\n\n");

describe("worktrees a session left inside its own", () => {
  it("reads the porcelain list and finds only the nested ones", () => {
    const entries = parseWorktreeList(porcelain);
    expect(entries).toHaveLength(7);
    expect(entries[4]).toEqual({ path: `${parent}/wt9278`, head: "w78", branch: "fix/9278-eng", locked: true });
    expect(nestedWorktrees(entries, parent).map((entry) => entry.path.split("/").pop())).toEqual(["g9278", "c9322", "wt9278", "g9330"]);
  });

  it("plans, on archive, the merged ones with nothing to lose and names the rest — it removes nothing (G12)", async () => {
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") return porcelain;
      if (args[0] === "merge-base" && args[2] === "c30") throw new Error("not ancestor");
      if (args[0] === "for-each-ref") return "refs/heads/x\n";
      if (args[0] === "-C" && args[1]!.endsWith("/c9322") && args.includes("status")) return "?? novo.txt\n";
      return "";
    };
    const result = await planNestedWorktrees(parent, { repo: "/r/nuria-platform", git, processCwds: [], processCommands: [] });
    expect(result.candidates).toEqual([{ path: `${parent}/g9278`, command: `git -C /r/nuria-platform worktree remove ${parent}/g9278` }]);
    // deepest (longest path) first
    expect(result.kept).toEqual([
      { path: `${parent}/wt9278`, why: "bloqueada (sem motivo)" },
      { path: `${parent}/c9322`, why: "tem mudanças locais" },
      { path: `${parent}/g9330`, why: "não está em origin/main" },
    ]);
    const note = archiveCleanupNote(parent, result);
    expect(note.chip).toBe("Worktrees que podem ser removidas: g9278. Mantidas: wt9278 (bloqueada (sem motivo)), c9322 (tem mudanças locais), g9330 (não está em origin/main).");
    expect(note.report).toContain(`Para remover (sem --force; confira antes):\ngit -C /r/nuria-platform worktree remove ${parent}/g9278`);
    expect(note.report).toContain("O servidor não remove worktrees.");
    expect(onlyReads(calls)).toBe(true);
  });

  it("says nothing when there are none, or git cannot list them", async () => {
    const deps = (git: (args: string[]) => Promise<string>) => ({ repo: "/r/nuria-platform", git, processCwds: [], processCommands: [] });
    expect(await planNestedWorktrees(parent, deps(async () => "worktree /r/nuria-platform\nHEAD aaa"))).toEqual({ candidates: [], kept: [] });
    expect(await planNestedWorktrees(parent, deps(async () => { throw new Error("not a repo"); }))).toEqual({ candidates: [], kept: [] });
    expect(archiveCleanupNote(parent, { candidates: [], kept: [] })).toEqual({ chip: "", report: "" });
  });

  it("keeps a lock's reason", () => {
    expect(parseWorktreeList("worktree /r/p\nHEAD a\n\nworktree /r/p/w\nHEAD b\ndetached\nlocked gate #9278 em andamento (Eng PRODEV)")[1])
      .toEqual({ path: "/r/p/w", head: "b", locked: true, lockReason: "gate #9278 em andamento (Eng PRODEV)" });
  });
});

// ── R8 G3: worktrees already in production, a report for a person ──────
const NOW = Date.UTC(2026, 9, 1, 19, 0);
const DAY = 24 * 3_600_000;
const PROD = "c88f99d62956379b6759b3f5f5a4fefde6a35a1f";
const repoPath = "/Users/owner/Projetos/nuria-platform";
const wt = (name: string) => `${repoPath}/${name}`;
/** The shape of the nuria-platform list the inspector read on 01/10 (names
 * made generic): two parents already in production hold a nested worktree
 * that is not; one worktree was made from main this morning. */
const realShape = [
  `worktree ${repoPath}\nHEAD ${PROD}\nbranch refs/heads/main`,
  `worktree ${wt(".claude/worktrees/8891-503-diag")}\nHEAD 1bbd5c2a\ndetached`,
  `worktree ${wt(".claude/worktrees/atendimento-reaberto-bugs-496989")}\nHEAD ${PROD}\ndetached`,
  `worktree ${wt(".claude/worktrees/fix-9298-stage-time-rule-572720")}\nHEAD 1bbd5c2a\nbranch refs/heads/fix/9298`,
  `worktree ${wt(".worktrees/9052-tempo-reabertura")}\nHEAD 1bbd5c2a\nbranch refs/heads/feat/9052`,
  `worktree ${wt(".claude/worktrees/8891-503-rodada-2-5f41b1")}\nHEAD 1bbd5c2a\ndetached`,
  `worktree ${wt(".claude/worktrees/8891-503-rodada-2-5f41b1/.worktrees/fix-9333")}\nHEAD f9333000\nbranch refs/heads/fix/9333`,
  `worktree ${wt(".claude/worktrees/9326-f4-2-gate-da-pr-9330-29da94")}\nHEAD 1bbd5c2a\ndetached`,
  `worktree ${wt(".claude/worktrees/9326-f4-2-gate-da-pr-9330-29da94/.worktrees/9326")}\nHEAD f9326000\nbranch refs/heads/fix/9326`,
  `worktree ${wt(".claude/worktrees/live-9331")}\nHEAD 1bbd5c2a\nbranch refs/heads/fix/9331`,
  `worktree ${wt(".claude/worktrees/live-9331/.worktrees/g9278")}\nHEAD 1bbd5c2a\nbranch refs/heads/hotfix/9278`,
  `worktree ${wt(".claude/worktrees/merge-deploy")}\nHEAD ${PROD}\ndetached`,
  `worktree ${wt(".worktrees/wt9278")}\nHEAD w9278000\nbranch refs/heads/fix/9278\nlocked`,
  `worktree ${wt(".claude/worktrees/gone")}\nHEAD 1bbd5c2a\ndetached\nprunable gitdir file points to non-existent location`,
].join("\n\n");
const inProd = new Set([PROD, "1bbd5c2a"]);

function fakeGit(list: string, opts: { status?: Record<string, string>; ignored?: Record<string, string>; delayMs?: number; fail?: Record<string, string> } = {}) {
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    if (args[0] === "worktree" && args[1] === "list") return list;
    if (args[0] === "merge-base") {
      if (!inProd.has(args[2]!)) throw Object.assign(new Error("exit 1"), { stderr: "" });
      return "";
    }
    if (args[0] === "-C") {
      const path = args[1]!;
      if (opts.fail?.[path]) throw Object.assign(new Error("Command failed"), { stderr: opts.fail[path] });
      if (args.includes("status")) return opts.status?.[path] ?? "";
      if (args.includes("ls-files")) return opts.ignored?.[path] ?? "";
    }
    return "";
  };
  return { git, calls };
}

const baseDeps = (git: ReleasedPlanDeps["git"], over: Partial<ReleasedPlanDeps> = {}): ReleasedPlanDeps => ({
  git,
  inUse: [],
  processCwds: [],
  processCommands: [],
  lastActivity: (path) => (path.includes("9052") ? NOW - 2 * 3_600_000 : NOW - 3 * DAY),
  now: NOW,
  ...over,
});
/** The server never removes, prunes or forces: only reads. */
const onlyReads = (calls: string[][]) => calls.every((args) => !args.some((arg) => /^(?:remove|prune|--force|-f|add|move|lock|unlock|repair)$/.test(arg)));

describe("worktrees already in production (R8 G3): a plan a person runs", () => {
  it("on the 01/10 shape: never a parent holding a nested worktree, never one just made, never one an agent or a process uses", async () => {
    const { git, calls } = fakeGit(realShape, {
      ignored: {
        [wt(".claude/worktrees/atendimento-reaberto-bugs-496989")]: "node_modules/\napps/web/node_modules/\n.deploy-history/\n.deploy-report.json\n",
        [wt(".claude/worktrees/fix-9298-stage-time-rule-572720")]: "node_modules/\napps/web/dist/\n.turbo/\n",
      },
    });
    const plan = await planReleasedWorktrees(repoPath, PROD, baseDeps(git, {
      // the session folders the inspector found in use: the main checkout, a folder above it, "/", and a live session deep inside its worktree
      inUse: [repoPath, "/Users/owner/Projetos", "/", wt(".claude/worktrees/live-9331/apps/web")],
      processCwds: ["/Users/owner", wt(".claude/worktrees/merge-deploy/apps/api")],
      processCommands: ["/bin/zsh -il", "node /usr/local/bin/vitest"],
    }));
    expect(plan.candidates).toEqual([
      { path: wt(".claude/worktrees/8891-503-diag"), command: `git -C ${repoPath} worktree remove ${wt(".claude/worktrees/8891-503-diag")}` },
      { path: wt(".claude/worktrees/fix-9298-stage-time-rule-572720"), command: `git -C ${repoPath} worktree remove ${wt(".claude/worktrees/fix-9298-stage-time-rule-572720")}` },
    ]);
    expect(plan.kept).toEqual([
      `${wt(".claude/worktrees/atendimento-reaberto-bugs-496989")} (tem arquivos ignorados: .deploy-history/, .deploy-report.json)`,
      `${wt(".worktrees/9052-tempo-reabertura")} (usada há menos de 24 h)`,
      `${wt(".claude/worktrees/8891-503-rodada-2-5f41b1")} (contém outra worktree)`,
      `${wt(".claude/worktrees/9326-f4-2-gate-da-pr-9330-29da94")} (contém outra worktree)`,
      `${wt(".claude/worktrees/merge-deploy")} (em uso por processo)`,
      `${wt(".claude/worktrees/gone")} (pasta já não existe)`,
    ]);
    // the live session protects its worktree and the one nested in it, and nothing else
    expect(JSON.stringify(plan)).not.toContain("live-9331");
    // nested ones not in production are never even looked at
    expect(JSON.stringify(plan)).not.toMatch(/fix-9333|\/9326"|wt9278/);
    expect(onlyReads(calls)).toBe(true);
  });

  it("maps each folder in use to the deepest worktree holding it (INSP-G r1 item 2)", async () => {
    const list = [
      "worktree /r/nuria-platform\nHEAD aaa",
      "worktree /r/nuria-platform/.claude/worktrees/fix-9298\nHEAD 1bbd5c2a",
      "worktree /r/nuria-platform/.claude/worktrees/live-9331\nHEAD 1bbd5c2a",
      "worktree /r/nuria-platform/.claude/worktrees/live-9331/.worktrees/x\nHEAD 1bbd5c2a",
    ].join("\n\n");
    const { git } = fakeGit(list);
    const plan = await planReleasedWorktrees("/r/nuria-platform", PROD, baseDeps(git, { inUse: ["/r/nuria-platform", "/r", "/", "/r/nuria-platform/.claude/worktrees/live-9331"] }));
    expect(plan.candidates.map((candidate) => candidate.path)).toEqual(["/r/nuria-platform/.claude/worktrees/fix-9298"]);
    expect(plan.kept).toEqual([]);
  });

  it("keeps one with a process inside, one touched today, one whose activity is unknown; offers one idle for 2 days (item 3)", async () => {
    const list = ["worktree /r/p\nHEAD aaa", "worktree /r/p/w/busy\nHEAD 1bbd5c2a", "worktree /r/p/w/argv\nHEAD 1bbd5c2a", "worktree /r/p/w/new\nHEAD 1bbd5c2a", "worktree /r/p/w/unknown\nHEAD 1bbd5c2a", "worktree /r/p/w/old\nHEAD 1bbd5c2a"].join("\n\n");
    const { git } = fakeGit(list);
    const plan = await planReleasedWorktrees("/r/p", PROD, baseDeps(git, {
      processCwds: ["/r/p/w/busy"],
      processCommands: ["node /r/p/w/argv/node_modules/.bin/vitest run"],
      lastActivity: (path) => (path === "/r/p/w/new" ? NOW - 60_000 : path === "/r/p/w/unknown" ? null : NOW - 2 * DAY),
    }));
    expect(plan.candidates.map((candidate) => candidate.path)).toEqual(["/r/p/w/old"]);
    expect(plan.kept).toEqual(["/r/p/w/busy (em uso por processo)", "/r/p/w/argv (em uso por processo)", "/r/p/w/new (usada há menos de 24 h)", "/r/p/w/unknown (atividade desconhecida)"]);
    expect(RELEASED_MIN_IDLE_MS).toBe(DAY);
  });

  it("runs git without blocking: a timer fires while a slow git is still answering (item 4)", async () => {
    const { git } = fakeGit(["worktree /r/p\nHEAD aaa", "worktree /r/p/w/old\nHEAD 1bbd5c2a"].join("\n\n"), { delayMs: 500 });
    let fired = false;
    const timer = setTimeout(() => { fired = true; }, 100);
    const pending = planReleasedWorktrees("/r/p", PROD, baseDeps(git));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fired).toBe(true);
    clearTimeout(timer);
    expect((await pending).candidates).toHaveLength(1);
  });

  it("names a git failure by git's stderr, not as local changes; tells the Chief only what changed (item 5)", async () => {
    const list = ["worktree /r/p\nHEAD aaa", "worktree /r/p/w/odd\nHEAD 1bbd5c2a", "worktree /r/p/w/dirty\nHEAD 1bbd5c2a"].join("\n\n");
    const { git } = fakeGit(list, { fail: { "/r/p/w/odd": "fatal: '/r/p/w/odd' is a main working tree" }, status: { "/r/p/w/dirty": " M a.txt\n?? novo.txt\n" } });
    const plan = await planReleasedWorktrees("/r/p", PROD, baseDeps(git));
    expect(plan.kept).toEqual(["/r/p/w/odd (não conferida: '/r/p/w/odd' is a main working tree)", "/r/p/w/dirty (tem mudanças locais)"]);
    const first = releasedPlanLine("nuria-platform", plan, undefined);
    expect(first.line).toBe("nuria-platform: nenhuma das contidas na tag pode ser removida; mantidas: odd (não conferida: '/r/p/w/odd' is a main working tree), dirty (tem mudanças locais)");
    // the same pass 6 h later: nothing to say
    expect(releasedPlanLine("nuria-platform", plan, first.key).line).toBeNull();
    // the same paths with other reasons (the real fix-9298 flipped between passes): nothing to say (INSP-G r2 item 6)
    const flipped = { ...plan, kept: ["/r/p/w/odd (em uso por processo)", "/r/p/w/dirty (usada há menos de 24 h)"] };
    expect(releasedPlanLine("nuria-platform", flipped, first.key).line).toBeNull();
    // a path that leaves the kept list: said again
    expect(releasedPlanLine("nuria-platform", { ...plan, kept: [plan.kept[0]!] }, first.key).line).not.toBeNull();
    // a new candidate: said again
    expect(releasedPlanLine("nuria-platform", { ...plan, candidates: [{ path: "/r/p/w/old", command: "x" }] }, first.key).line).toContain("1 das contidas na tag pode(m) ser removida(s) (old)");
  });

  // R10-resilience D, 02/10 (redacted paths, real names and ages): the boot
  // report judged the 5 worktrees in the tag and said "0 may be removed"; the
  // Chief told the owner twice that "nenhuma pode ser removida" while ~17 GB
  // sat idle for 4–5 days outside the tag, in worktrees and task-workspaces.
  it("says it judged only those in the tag, and lists — as information, with the command — the ones idle >72 h outside it", async () => {
    const T = (iso: string) => Date.parse(iso);
    const now = T("2026-10-02T16:39:20Z");
    const root = "/Users/owner/Projetos/nuria-platform";
    const w = (name: string) => `${root}/.claude/worktrees/${name}`;
    const list = [
      `worktree ${root}\nHEAD aaa`,
      `worktree ${w("transfer-n2-sem-agente-824837")}\nHEAD 0001`,
      `worktree ${w("nur-12-d1-overload-02e53e")}\nHEAD 0002`,
      `worktree ${w("n2-ticket-distribution-bug-78843c")}\nHEAD 0003`,
      `worktree ${w("9347-release-travado")}\nHEAD 0004`, // a live session: never listed
      `worktree ${w("8204-sidebar")}\nHEAD 0005`, // outside the tag, touched today
      `worktree ${w("fix-9298-in-tag")}\nHEAD 1bbd5c2a`,
    ].join("\n\n");
    const { git, calls } = fakeGit(list);
    const idle: Record<string, number> = {
      [w("transfer-n2-sem-agente-824837")]: T("2026-09-27T20:00:00Z"),
      [w("nur-12-d1-overload-02e53e")]: T("2026-09-28T13:00:00Z"),
      [w("n2-ticket-distribution-bug-78843c")]: T("2026-09-28T15:00:00Z"),
      [w("9347-release-travado")]: T("2026-09-26T10:00:00Z"),
      [w("8204-sidebar")]: now - 3_600_000,
      [w("fix-9298-in-tag")]: now - 3 * DAY,
    };
    const plan = await planReleasedWorktrees(root, PROD, baseDeps(git, { now, inUse: [w("9347-release-travado")], lastActivity: (path) => idle[path] ?? null }));
    expect(plan.scope).toEqual({ total: 6, inTag: 1 });
    expect(plan.candidates.map((each) => each.path)).toEqual([w("fix-9298-in-tag")]);
    expect(plan.stale?.map((each) => each.path)).toEqual([w("transfer-n2-sem-agente-824837"), w("nur-12-d1-overload-02e53e"), w("n2-ticket-distribution-bug-78843c")]);
    expect(plan.stale?.[0]).toMatchObject({ kind: "worktree", command: `git -C ${root} worktree remove ${w("transfer-n2-sem-agente-824837")}` });
    expect(releasedScopeLine("nuria-platform", plan, "nuria-production-deployed")).toBe("nuria-platform: avaliei para remoção só as worktrees já contidas na tag nuria-production-deployed (1 de 6); as outras 5 não foram avaliadas para remoção.");
    expect(onlyReads(calls)).toBe(true);

    // the task-workspaces: conversations no longer open, idle for days; an open one and a session's are never listed
    const tw = (bot: string, thread: string) => `/Users/owner/.openmausbot/task-workspaces/${bot}/${thread}`;
    // INSP-J r1 #7a: the real 54118a8a (closed by the Lead on 29/09) and the quiet open ones
    // come with whose they were; the server leaves them out of "in use" for this report only
    const workspaces = staleTaskWorkspaces([
      { path: tw("82feff85", "a1"), lastActivity: T("2026-09-28T12:00:00Z"), note: "conversa \"Lead PRODEV\" fechada" },
      { path: tw("82feff85", "a2"), lastActivity: T("2026-09-29T09:00:00Z"), note: "conversa \"Revisão\" aberta, parada desde 29/09" },
      { path: tw("e9ba01c7", "70fa6c86"), lastActivity: T("2026-09-29T11:00:00Z") },
      { path: tw("82feff85", "open"), lastActivity: T("2026-09-20T00:00:00Z") },
      { path: tw("82feff85", "session"), lastActivity: T("2026-09-20T00:00:00Z") },
      { path: tw("82feff85", "recent"), lastActivity: now - 3_600_000 },
      { path: tw("82feff85", "unknown"), lastActivity: null },
    ], { inUse: [tw("82feff85", "open"), `${tw("82feff85", "session")}/repo/.claude/worktrees/x`], now });
    expect(workspaces.map((each) => each.path)).toEqual([tw("82feff85", "a1"), tw("82feff85", "a2"), tw("e9ba01c7", "70fa6c86")]);
    expect(workspaces[0]!.command).toBe(`mv ${tw("82feff85", "a1")} ~/.Trash/`);

    // measured in disk order (the 2,1 GB last), told biggest first; small ones counted, not listed (#7b, #7c)
    const sizesGb = [3.0, 2.8, 2.8, 2.2, 2.2, 2.1];
    const sized = [...[...plan.stale!, ...workspaces].map((each, i) => ({ ...each, sizeKb: sizesGb[i]! * 1024 * 1024 })), { path: tw("82feff85", "tiny"), kind: "task-workspace" as const, idleSince: T("2026-09-28T00:00:00Z"), command: "mv x ~/.Trash/", sizeKb: 900 }].reverse();
    const told = staleFoldersReport(sized)!;
    expect(told.chip).toBe("Disco: 6 pasta(s) parada(s) há mais de 72 h fora da tag, ~15,1 GB — informação para o dono, nada foi removido");
    expect(told.report).toContain("Só informação: o servidor não removeu nada");
    expect(told.report).toContain("(e mais 1 pequena(s), abaixo de 200 MB, não listada(s))");
    // the Trash gives the space back only when emptied (#7d)
    expect(told.report).toContain("o espaço só volta ao esvaziar a Lixeira");
    const listed = told.report.split("\n").filter((each) => each.startsWith("- "));
    expect(listed[0]).toBe(`- worktree ${w("transfer-n2-sem-agente-824837")} (3,0 GB, sem mudança desde 27/09): git -C ${root} worktree remove ${w("transfer-n2-sem-agente-824837")}`);
    expect(listed.at(-1)).toBe(`- task-workspace ${tw("e9ba01c7", "70fa6c86")} (2,1 GB, sem mudança desde 29/09): mv ${tw("e9ba01c7", "70fa6c86")} ~/.Trash/`);
    expect(told.report).toContain(`- task-workspace (conversa "Lead PRODEV" fechada) ${tw("82feff85", "a1")} (2,2 GB`);
    expect(told.report).not.toContain("tiny");
    for (const line of told.report.split("\n").filter((each) => each.startsWith("- "))) expect(line).not.toMatch(/--force|\brm\b/);
    expect(sizeLabel(640 * 1024)).toBe("640 MB");
    expect(staleFoldersReport([])).toBeNull();
  });

  it("treats as work every ignored file that cannot be rebuilt", () => {
    for (const path of ["node_modules/", "apps/web/node_modules/", "dist/", "apps/nuria/dist/x.js", ".turbo/", "coverage/", ".local-ci/", "debug.log", "tsconfig.tsbuildinfo", ".DS_Store", "test-results/"]) expect(isDisposableIgnored(path), path).toBe(true);
    for (const path of [".env.local", ".env.production.local", ".dev.vars", ".deploy-history/", ".deploy-report.json", ".worktrees/", ".worktrees/x/node_modules/", ".claude/settings.local.json", ".claude/worktrees/", "backups/", "shot.png", "agent-team/", "notes.md", "dist"]) expect(isDisposableIgnored(path), path).toBe(false);
  });

  it("reads a Codex session's folders from its rollout, whole or cut", () => {
    expect(codexRolloutFolders(`${JSON.stringify({ type: "session_meta", payload: { cwd: "/Users/owner/Projetos/nuria-platform/.worktrees/x", runtime_workspace_roots: ["/Users/owner/Projetos/nuria-platform/.worktrees/x"] } })}\n{"type":"event"}`))
      .toEqual(["/Users/owner/Projetos/nuria-platform/.worktrees/x", "/Users/owner/Projetos/nuria-platform/.worktrees/x"]);
    expect(codexRolloutFolders(`{"type":"session_meta","payload":{"id":"1","cwd":"/Users/owner/w","base_instructions":"long and cut`)).toEqual(["/Users/owner/w"]);
    expect(codexRolloutFolders(`{"type":"response_item","payload":{"cwd":"/x"}}`)).toEqual([]);
  });
});

// ── the same with real git, in a temporary folder (never the real worktrees) ──
const run = (cwd: string, ...args: string[]) => String(execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } })).trim();
const realGit = (repo: string, calls: string[][]): ReleasedPlanDeps["git"] => (args) => new Promise((resolve, reject) => {
  calls.push(args);
  execFile("git", ["-C", repo, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(String(stdout))));
});
const realFs = { readFile: (path: string) => readFileSync(path, "utf8"), mtime: (path: string) => { try { return statSync(path).mtimeMs; } catch { return null; } } };
/** Back-dates a worktree's folder and git admin files by two days. */
function age(path: string): void {
  const admin = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(path, ".git"), "utf8"))![1]!.trim();
  const then = new Date(Date.now() - 2 * DAY);
  for (const file of [join(admin, "HEAD"), join(admin, "index"), join(admin, "logs", "HEAD"), path]) if (existsSync(file)) utimesSync(file, then, then);
}

describe("worktrees already in production, with real git", () => {
  it("never offers a parent whose ignored .worktrees/ hides a worktree with uncommitted work — which git itself would delete", async () => {
    // mkdtemp under tmpdir(): on macOS /var/folders… is a symlink to /private/var/folders…, as real session folders can be
    const root = mkdtempSync(join(tmpdir(), "omb-g3-"));
    const repo = join(root, "nuria-platform");
    const busyProc: { kill?: () => void } = {};
    try {
      mkdirSync(repo);
      run(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, ".gitignore"), ".worktrees/\n.claude/*\nnode_modules/\n.env.local\n");
      writeFileSync(join(repo, "a.txt"), "a\n");
      run(repo, "add", ".");
      run(repo, "commit", "-q", "-m", "a");
      const tag = run(repo, "rev-parse", "HEAD");
      const add = (path: string) => { run(repo, "worktree", "add", "-q", "--detach", path, tag); return path; };
      const w = (name: string) => join(repo, ".claude", "worktrees", name);

      const clean = add(w("old-clean"));
      mkdirSync(join(clean, "node_modules"), { recursive: true });
      writeFileSync(join(clean, "node_modules", "x.js"), "x\n");
      const parentWt = add(w("parent"));
      writeFileSync(join(parentWt, ".env.local"), "TOKEN=placeholder\n");
      const child = add(join(parentWt, ".worktrees", "child"));
      writeFileSync(join(child, "novo.txt"), "trabalho não commitado\n");
      const env = add(w("env"));
      writeFileSync(join(env, ".env.local"), "TOKEN=placeholder\n");
      const dirty = add(w("dirty"));
      writeFileSync(join(dirty, "a.txt"), "changed\n");
      const busy = add(w("busy"));
      const live = add(w("live"));
      mkdirSync(join(live, "sub"));
      const fresh = add(join(repo, ".worktrees", "fresh"));
      const ahead = add(w("ahead"));
      writeFileSync(join(ahead, "b.txt"), "b\n");
      run(ahead, "add", "b.txt");
      run(ahead, "commit", "-q", "-m", "b");
      for (const path of [clean, parentWt, child, env, dirty, busy, live, ahead]) age(path);

      // a real process working in `busy`, its cwd read by the real lsof
      const sleeper = spawn("sleep", ["60"], { cwd: busy, stdio: "ignore" });
      busyProc.kill = () => sleeper.kill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const lsof = String(execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", String(sleeper.pid)]));
      const processCwds = lsof.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
      expect(processCwds).toEqual([realpathSync(busy)]);

      const calls: string[][] = [];
      const plan = await planReleasedWorktrees(repo, tag, {
        git: realGit(repo, calls),
        // the main checkout (as the non-canonical tmp path), the folder above it, "/", and a live session deep in `live`
        inUse: [repo, dirname(repo), "/", join(live, "sub")],
        processCwds,
        processCommands: [],
        lastActivity: (path) => worktreeLastActivity(path, realFs),
        now: Date.now(),
        canon: (path) => { try { return realpathSync(path); } catch { return path; } },
      });
      const name = (item: string) => item.replace(/^.*\/(?=[^/]+(?: \(|$))/, "");
      expect(plan.candidates.map((candidate) => name(candidate.path))).toEqual(["old-clean"]);
      expect(plan.kept.map(name).sort()).toEqual([
        "busy (em uso por processo)",
        "child (tem mudanças locais)",
        "dirty (tem mudanças locais)",
        "env (tem arquivos ignorados: .env.local)",
        "fresh (usada há menos de 24 h)",
        "parent (contém outra worktree)",
      ]);
      expect(onlyReads(calls)).toBe(true);
      expect(existsSync(clean)).toBe(true); // planning removed nothing

      // a person runs the offered command: only old-clean goes, everything else is intact
      for (const candidate of plan.candidates) execFileSync("/bin/sh", ["-c", candidate.command], { stdio: "pipe" });
      expect(existsSync(clean)).toBe(false);
      expect(readFileSync(join(child, "novo.txt"), "utf8")).toBe("trabalho não commitado\n");
      expect(existsSync(join(parentWt, ".env.local"))).toBe(true);
      expect(existsSync(join(env, ".env.local"))).toBe(true);
      expect(existsSync(join(live, "sub"))).toBe(true);
      expect([fresh, busy, dirty, ahead].every((path) => existsSync(path))).toBe(true);

      // why the parent is never offered: git removes it, without --force, nested worktree and uncommitted work included
      execFileSync("git", ["-C", repo, "worktree", "remove", parentWt], { stdio: "pipe" });
      expect(existsSync(join(child, "novo.txt"))).toBe(false);
    } finally {
      busyProc.kill?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("on archive removes NOTHING: it offers only what has nothing to lose — not a detached HEAD's own commits, not another agent's lock (G12, INSP-G r2 1–3)", async () => {
    // canonical paths (as git records them), so the commands can be compared whole
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-g12-")));
    const repo = join(root, "nuria-platform");
    const busyProc: { kill?: () => void } = {};
    try {
      mkdirSync(repo);
      run(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, ".gitignore"), ".worktrees/\n.claude/*\nnode_modules/\n.env.local\n");
      writeFileSync(join(repo, "a.txt"), "a\n");
      run(repo, "add", ".");
      run(repo, "commit", "-q", "-m", "a");
      const head = run(repo, "rev-parse", "HEAD");
      const add = (path: string) => { run(repo, "worktree", "add", "-q", "--detach", path, head); return path; };
      const session = add(join(repo, ".claude", "worktrees", "session"));
      const n = (name: string) => join(session, ".worktrees", name);
      const clean = add(n("merged-clean"));
      mkdirSync(join(clean, "node_modules"));
      writeFileSync(join(clean, "node_modules", "x.js"), "x\n");
      const env = add(n("merged-env"));
      writeFileSync(join(env, ".env.local"), "TOKEN=placeholder\n");
      const dirty = add(n("merged-dirty"));
      writeFileSync(join(dirty, "novo.txt"), "trabalho\n");
      const parentWt = add(n("merged-parent"));
      const grandchild = add(join(parentWt, ".worktrees", "grandchild"));
      writeFileSync(join(grandchild, "novo.txt"), "trabalho não commitado\n");
      const busy = add(n("merged-busy"));
      const used = add(n("merged-used"));
      mkdirSync(join(used, "sub"));
      const ahead = add(n("unmerged"));
      writeFileSync(join(ahead, "b.txt"), "b\n");
      run(ahead, "add", "b.txt");
      run(ahead, "commit", "-q", "-m", "b");

      const sleeper = spawn("sleep", ["60"], { cwd: busy, stdio: "ignore" });
      busyProc.kill = () => sleeper.kill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const lsof = String(execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", String(sleeper.pid)]));
      const calls: string[][] = [];
      const deps = {
        repo,
        git: realGit(repo, calls),
        processCwds: lsof.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1)),
        processCommands: [],
        foldersInUse: [join(used, "sub"), repo, "/"],
        canon: (path: string) => { try { return realpathSync(path); } catch { return path; } },
      };
      // the session's own worktrees of the inspector's r2 cases
      const own = (name: string) => add(join(repo, ".claude", "worktrees", name));
      const detached = own("detached-commit");
      writeFileSync(join(detached, "c.txt"), "c\n");
      run(detached, "add", "c.txt");
      run(detached, "commit", "-q", "-m", "c (só nesta HEAD destacada)");
      const orphan = run(detached, "rev-parse", "HEAD");
      const otherLock = own("other-lock");
      run(repo, "worktree", "lock", "--reason", "gate #9278 em andamento (Eng PRODEV)", otherLock);
      const ownLock = own("own-lock");
      run(repo, "worktree", "lock", "--reason", "claude session cc-1a2b3c4d", ownLock);
      const envOnly = own("env-only");
      writeFileSync(join(envOnly, ".env.local"), "TOKEN=placeholder\n");

      const snapshot = () => [run(repo, "worktree", "list", "--porcelain"), run(repo, "for-each-ref")].join("\n--\n");
      const before = snapshot();
      const archiveDeps = { ...deps, ownLockMarkers: ["cc-1a2b3c4d"] };
      const nested = await planNestedWorktrees(session, archiveDeps, "main");
      const name = (path: string) => path.split("/").pop();
      expect(nested.candidates).toEqual([{ path: clean, command: `git -C ${repo} worktree remove ${clean}` }]);
      expect(Object.fromEntries(nested.kept.map((item) => [name(item.path), item.why]))).toEqual({
        "grandchild": "tem mudanças locais",
        "merged-parent": "contém outra worktree",
        "merged-env": "tem arquivos ignorados: .env.local",
        "merged-dirty": "tem mudanças locais",
        "merged-busy": "em uso por processo",
        "merged-used": "em uso por outra sessão",
        "unmerged": "não está em main",
      });
      const plan = async (folder: string, users: string[] = []) => planArchivedWorktree(folder, archiveDeps, users);
      // the session's own worktree still holds nested worktrees
      expect(await plan(session)).toEqual({ candidates: [], kept: [{ path: session, why: "contém outra worktree" }] });
      // r2 case 1: a detached HEAD whose commit is in no ref stays, with the command that saves it
      expect(await plan(detached)).toEqual({ candidates: [], kept: [{ path: detached, why: "commits fora de qualquer branch", command: `git -C ${detached} branch salvo/detached-commit HEAD` }] });
      // r2 case 2: another agent's lock stays, with no command
      expect(await plan(otherLock)).toEqual({ candidates: [], kept: [{ path: otherLock, why: "bloqueada: gate #9278 em andamento (Eng PRODEV)" }] });
      // a lock this session set: offered, the unlock in the person's command
      expect(await plan(ownLock)).toEqual({ candidates: [{ path: ownLock, command: `git -C ${repo} worktree unlock ${ownLock} && git -C ${repo} worktree remove ${ownLock}` }], kept: [] });
      expect((await plan(envOnly)).kept[0]!.why).toBe("tem arquivos ignorados: .env.local");
      expect((await plan(envOnly, ["\"#9331\" (app)"])).kept[0]!.why).toBe("em uso por \"#9331\" (app)");

      // NOTHING was removed, unlocked or pruned, and every ref is as it was
      expect(snapshot()).toBe(before);
      expect(onlyReads(calls)).toBe(true);
      for (const path of [clean, join(grandchild, "novo.txt"), join(env, ".env.local"), join(dirty, "novo.txt"), busy, join(used, "sub"), ahead, detached, otherLock, ownLock, join(envOnly, ".env.local")]) expect(existsSync(path), path).toBe(true);
      expect(run(repo, "worktree", "list", "--porcelain")).toContain(`locked gate #9278 em andamento (Eng PRODEV)`);
      expect(run(repo, "cat-file", "-t", orphan)).toBe("commit");

      // the person saves the detached commits with the command given: then the worktree may go
      const save = (await plan(detached)).kept[0]!.command!;
      execFileSync("/bin/sh", ["-c", save], { stdio: "pipe" });
      expect((await plan(detached)).candidates.map((item) => item.path)).toEqual([detached]);
      expect(run(repo, "branch", "--contains", orphan)).toContain("salvo/detached-commit");
    } finally {
      busyProc.kill?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("shows a lock's accented reason as text, and never chains unlock to the remove of a worktree with submodules (INSP-G r3 notes)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-g12s-")));
    try {
      const sub = join(root, "lib");
      mkdirSync(sub);
      run(sub, "init", "-q", "-b", "main");
      writeFileSync(join(sub, "l.txt"), "l\n");
      run(sub, "add", ".");
      run(sub, "commit", "-q", "-m", "l");
      const repo = join(root, "nuria-platform");
      mkdirSync(repo);
      run(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, ".gitignore"), ".claude/*\n");
      writeFileSync(join(repo, "a.txt"), "a\n");
      run(repo, "add", ".");
      run(repo, "commit", "-q", "-m", "a");
      run(repo, "checkout", "-q", "-b", "with-sub");
      run(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "lib");
      run(repo, "commit", "-q", "-m", "submódulo");
      run(repo, "checkout", "-q", "main");
      const withSub = join(repo, ".claude", "worktrees", "with-sub");
      run(repo, "worktree", "add", "-q", withSub, "with-sub");
      run(repo, "worktree", "lock", "--reason", "sessão cc-1a2b3c4d", withSub);
      const accented = join(repo, ".claude", "worktrees", "accented");
      run(repo, "worktree", "add", "-q", "--detach", accented, "main");
      run(repo, "worktree", "lock", "--reason", "gate da sessão de revisão (Eng)", accented);
      // git C-quotes it in the porcelain list
      expect(run(repo, "worktree", "list", "--porcelain")).toContain("\\303\\243");

      const calls: string[][] = [];
      const deps = { repo, git: realGit(repo, calls), processCwds: [], processCommands: [], ownLockMarkers: ["cc-1a2b3c4d"] };
      const before = run(repo, "worktree", "list", "--porcelain");
      expect(await planArchivedWorktree(accented, deps, [])).toEqual({ candidates: [], kept: [{ path: accented, why: "bloqueada: gate da sessão de revisão (Eng)" }] });
      // with submodules it stays among the KEPT (INSP-G r4 note 2), with the plain remove for after checking — never the unlock
      const plan = await planArchivedWorktree(withSub, deps, []);
      expect(plan).toEqual({ candidates: [], kept: [{ path: withSub, why: "contém submódulos: o git recusa remover assim; confira à mão (e não tire o lock antes)", command: `git -C ${repo} worktree remove ${withSub}` }] });
      const report = archiveCleanupNote(repo, plan).report;
      expect(report).not.toContain("unlock");
      expect(report).not.toContain("Para remover (sem --force");
      expect(run(repo, "worktree", "list", "--porcelain")).toBe(before);
      expect(onlyReads(calls)).toBe(true);
      // the person's command, run as given: git refuses, and the lock is still there
      expect(() => execFileSync("/bin/sh", ["-c", plan.kept[0]!.command!], { stdio: "pipe" })).toThrow();
      expect(run(repo, "worktree", "list", "--porcelain")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("decodes git's C-quoting", () => {
    expect(unquoteGit("\"sess\\303\\243o \\\"x\\\"\\tok\"")).toBe("sessão \"x\"\tok");
    expect(unquoteGit("gate #9278 em andamento")).toBe("gate #9278 em andamento");
  });
});

describe("the low-disk alert (R10-resilience D)", () => {
  const GB = 1024 * 1024;
  const at = Date.UTC(2026, 9, 2, 16, 39);
  const drop = { freeGiB: 6.3, path: "/Users/o/Projetos", band: 10 };
  // the real idle folders of 02/10 (du), plus a small one
  const stale = [
    { path: "/r/.claude/worktrees/nur-12-d1-overload-02e53e", kind: "worktree" as const, idleSince: at - 4 * 86_400_000, command: "git -C /r worktree remove /r/.claude/worktrees/nur-12-d1-overload-02e53e", sizeKb: 2.8 * GB },
    { path: "/r/.claude/worktrees/transfer-n2-sem-agente-824837", kind: "worktree" as const, idleSince: at - 5 * 86_400_000, command: "git -C /r worktree remove /r/.claude/worktrees/transfer-n2-sem-agente-824837", sizeKb: 3.0 * GB },
    { path: "/t/82feff85/54118a8a", kind: "task-workspace" as const, idleSince: at - 3.5 * 86_400_000, command: "mv /t/82feff85/54118a8a ~/.Trash/", sizeKb: 2.2 * GB },
    { path: "/t/x/small", kind: "task-workspace" as const, idleSince: at - 5 * 86_400_000, command: "mv /t/x/small ~/.Trash/", sizeKb: 1024 },
  ];

  it("names the idle folders the server measured, biggest first, and tells the bot to remove nothing on its own", () => {
    const alert = diskAlertText(drop, { at, folders: stale });
    expect(alert.chip).toBe("Pouco espaço em disco: 6,3 GiB livres em /Users/o/Projetos (abaixo de 10 GiB) — ~8,0 GB em 3 pasta(s) parada(s) fora da tag, para o dono decidir");
    const lines = alert.report.split("\n");
    expect(lines[0]).toContain("Não remova nada por conta própria, nem node_modules");
    expect(lines[0]).toContain("Medido pelo servidor em 02/10, 13:39: 3 pasta(s)");
    expect(lines[0]).toContain("\"nenhuma worktree pode ser removida\" vale só para as contidas na tag, não para estas");
    expect(lines.slice(1, 4)).toEqual([
      "- worktree /r/.claude/worktrees/transfer-n2-sem-agente-824837 (3,0 GB): git -C /r worktree remove /r/.claude/worktrees/transfer-n2-sem-agente-824837",
      "- worktree /r/.claude/worktrees/nur-12-d1-overload-02e53e (2,8 GB): git -C /r worktree remove /r/.claude/worktrees/nur-12-d1-overload-02e53e",
      "- task-workspace /t/82feff85/54118a8a (2,2 GB): mv /t/82feff85/54118a8a ~/.Trash/",
    ]);
    expect(alert.report).toContain("o espaço só volta ao esvaziar a Lixeira");
    expect(alert.report).not.toContain("/t/x/small");
    // the old order to the bot is gone
    expect(alert.report).not.toMatch(/Libere espaço/);
  });

  it("without a measurement, it never lets 'nothing can be removed' stand", () => {
    const none = diskAlertText(drop, null);
    expect(none.report).toContain("O servidor ainda não mediu as pastas paradas fora da tag");
    expect(none.report).toContain("não diga ao dono que nada pode ser removido");
    expect(none.report).toContain("Não remova nada por conta própria");
    const empty = diskAlertText(drop, { at, folders: [stale[3]!] });
    expect(empty.report).toContain("não havia pasta grande parada");
    expect(empty.chip).toBe("Pouco espaço em disco: 6,3 GiB livres em /Users/o/Projetos (abaixo de 10 GiB). Worktrees, CI local e builds podem falhar, e em zero o servidor para de gravar.");
  });

  // INSP-U r1 U2: a quiet OPEN conversation's workspace is in the list; the alert must say so,
  // or the owner approves a mv of a live conversation's folder to the Trash
  it("keeps the note of an open conversation's workspace, and claims nobody is in a folder only when none has a note", () => {
    const open = { ...stale[2]!, note: "conversa \"Revisão\" aberta, parada desde 29/09" };
    const alert = diskAlertText(drop, { at, folders: [stale[0]!, open] });
    expect(alert.report).toContain(`- task-workspace (conversa "Revisão" aberta, parada desde 29/09) /t/82feff85/54118a8a (2,2 GB): mv /t/82feff85/54118a8a ~/.Trash/`);
    expect(alert.report).not.toContain("sem ninguém nelas");
    expect(alert.report).toContain("fora da tag e sem processo nelas");
    expect(alert.report).toContain("uma conversa ainda aberta está marcada");
    // the report the Chief gets every 6 h says the same
    const told = staleFoldersReport([stale[0]!, open])!;
    expect(told.report).not.toContain("sem ninguém nelas");
    expect(told.report).toContain("fora da tag e sem processo nelas");
    // without a note, nothing changes
    expect(diskAlertText(drop, { at, folders: stale }).report).toContain("fora da tag e sem ninguém nelas");
    expect(staleFoldersReport(stale)!.report).toContain("fora da tag e sem ninguém nelas");
  });

  it("idle folders it could not measure are not 'no big folder'", () => {
    const unsized = stale.slice(0, 2).map(({ sizeKb: _sizeKb, ...each }) => each);
    const alert = diskAlertText(drop, { at, folders: unsized });
    expect(alert.report).not.toContain("não havia pasta grande parada");
    expect(alert.report).toContain("2 pasta(s) parada(s) há mais de 72 h fora da tag cujo tamanho não consegui medir");
    expect(alert.report).toContain("/r/.claude/worktrees/nur-12-d1-overload-02e53e");
    expect(alert.report).toContain("não diga ao dono que nada pode ser removido");
  });

  it("lists at most five and counts the rest", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...stale[0]!, path: `/w/${i}`, command: `git worktree remove /w/${i}`, sizeKb: (i + 1) * GB }));
    const alert = diskAlertText(drop, { at, folders: many });
    expect(alert.report.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(5);
    expect(alert.report).toContain("As maiores (e mais 2):");
    expect(alert.report).toContain("- worktree /w/6 (7,0 GB)");
  });
});

// R12-resilience D3: three old sessions of the Claude app (Feb.) kept cwd "/", and
// isInside(workspace, "/") holds for every path: every task-workspace was "in use",
// so D2 had no effect live. A folder above the task-workspaces root ("/", the home,
// ~/.openmausbot) never holds one, as in planReleasedWorktrees ("or above it").
describe("folders in use above the task-workspaces (R12-resilience D3)", () => {
  const now = Date.UTC(2026, 9, 5, 15, 0);
  const idle = Date.UTC(2026, 8, 29, 12, 0);
  const home = "/Users/o";
  const root = `${home}/.openmausbot/task-workspaces`;
  const folders = ["82feff85/54118a8a", "82feff85/fa9d2302", "e9ba01c7/70fa6c86"].map((each) => ({ path: `${root}/${each}`, lastActivity: idle }));

  it("'/', the home and ~/.openmausbot hold no task-workspace; the bot's folder, the conversation's or one inside it still do", () => {
    for (const above of ["/", home, `${home}/`, `${home}/.openmausbot`, root]) {
      expect(staleTaskWorkspaces(folders, { inUse: [above], now, root, home }).map((each) => each.path), above).toEqual(folders.map((each) => each.path));
    }
    expect(staleTaskWorkspaces(folders, { inUse: [`${root}/82feff85`], now, root, home }).map((each) => each.path)).toEqual([`${root}/e9ba01c7/70fa6c86`]);
    expect(staleTaskWorkspaces(folders, { inUse: [`${root}/e9ba01c7/70fa6c86/repo/.claude/worktrees/x`], now, root, home }).map((each) => each.path)).toEqual([`${root}/82feff85/54118a8a`, `${root}/82feff85/fa9d2302`]);
    // a project folder elsewhere holds nothing here
    expect(staleTaskWorkspaces(folders, { inUse: [`${home}/Projetos/nuria-platform`], now, root, home })).toHaveLength(3);
  });

  it("end to end: app sessions with cwd '/' and the home, the real three workspaces reach the report (~6,5 GB); a session inside one keeps it out", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "omb-d3-")));
    try {
      const tmpHome = join(base, "home");
      const tmpRoot = join(tmpHome, ".openmausbot", "task-workspaces");
      const real = ["82feff85/54118a8a", "82feff85/fa9d2302", "e9ba01c7/70fa6c86", "e9ba01c7/sessao-viva"];
      for (const each of real) {
        mkdirSync(join(tmpRoot, each), { recursive: true });
        utimesSync(join(tmpRoot, each), idle / 1000, idle / 1000);
      }
      // the Claude app's records (claude-code-sessions/<org>/<account>/local_*.json), not archived
      const sessions = join(base, "claude-code-sessions", "org", "account");
      mkdirSync(sessions, { recursive: true });
      const record = (id: string, cwd: string) => writeFileSync(join(sessions, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, cwd, isArchived: false, title: id }));
      record("afe017e2", "/");
      record("06bd2da9", "/");
      record("6521cda0", tmpHome);
      record("viva", join(tmpRoot, "e9ba01c7", "sessao-viva"));
      const day = (ms: number) => new Date(ms).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
      // what foldersInUse gathers: the app's live folders, then each open conversation
      const inUse = [...liveRecordFolders(join(base, "claude-code-sessions"))];
      const notes = new Map<string, string>();
      const conversations = [
        { workspace: join(tmpRoot, "82feff85", "54118a8a"), task: { closedBy: "lead", title: "@Lead PRODEV · parallel work", createdAt: idle, updatedAt: idle } },
        { workspace: join(tmpRoot, "82feff85", "fa9d2302"), task: { title: "@Delivery PRODEV", createdAt: idle, updatedAt: idle } },
        { workspace: join(tmpRoot, "e9ba01c7", "70fa6c86"), task: { title: "@Lead PRODEV", createdAt: idle, updatedAt: idle } },
      ];
      for (const { workspace, task } of conversations) {
        const own = conversationFolders({ ...task, cwd: workspace }, workspace, { forDisk: true, hasGoal: false, now, day });
        inUse.push(...own.inUse);
        if (own.quiet) notes.set(workspace, own.quiet);
      }
      expect(inUse).toEqual(expect.arrayContaining(["/", tmpHome]));
      const scanned = scanTaskWorkspaces(tmpRoot, { list: (dir) => readdirSync(dir), activity: (path) => statSync(path).mtimeMs, notes });
      const listed = staleTaskWorkspaces(scanned, { inUse, now, root: tmpRoot, home: tmpHome, canon: realpathSync });
      expect(listed.map((each) => [each.path.slice(tmpRoot.length + 1), each.note])).toEqual([
        ["82feff85/54118a8a", "conversa \"@Lead PRODEV · parallel work\" fechada"],
        ["82feff85/fa9d2302", "conversa \"@Delivery PRODEV\" aberta, parada desde 29/09"],
        ["e9ba01c7/70fa6c86", "conversa \"@Lead PRODEV\" aberta, parada desde 29/09"],
      ]);
      // as the report tells them, with the sizes du gave live (2,2 + 2,2 + 2,1 GB)
      const told = staleFoldersReport(listed.map((each, i) => ({ ...each, sizeKb: [2.2, 2.2, 2.1][i]! * 1024 * 1024 })))!;
      expect(told.chip).toContain("3 pasta(s) parada(s) há mais de 72 h fora da tag, ~6,5 GB");
      // not told where the root and the home are, the session in the home still holds them all
      expect(staleTaskWorkspaces(scanned, { inUse, now, canon: realpathSync })).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// INSP-R12a R12b-3: now that the report lists task-workspaces live, a manual claude or shell
// working inside one must hold it, and an edit in a subfolder must count as activity
describe("live processes and activity below the top of a task-workspace (INSP-R12a R12b-3)", () => {
  const now = Date.UTC(2026, 9, 5, 15, 0);
  const idle = Date.UTC(2026, 8, 29, 12, 0);
  const home = "/Users/o";
  const root = `${home}/.openmausbot/task-workspaces`;
  const folders = ["82feff85/54118a8a", "82feff85/fa9d2302"].map((each) => ({ path: `${root}/${each}`, lastActivity: idle }));

  it("a process working inside a task-workspace holds it; one in '/' or the home holds none", () => {
    const listed = (processCwds: string[]) => staleTaskWorkspaces(folders, { inUse: [], processCwds, now, root, home }).map((each) => each.path);
    expect(listed([`${root}/82feff85/54118a8a/repo/src`])).toEqual([`${root}/82feff85/fa9d2302`]);
    // every daemon runs in "/", a login shell in the home
    expect(listed(["/", home, "/usr/libexec"])).toEqual(folders.map((each) => each.path));
  });

  // INSP-R12a-r2 R2-3: one level was not enough (an edit in repo/src/a.ts changes no folder
  // above it), and a cut at 200 entries could leave the newest out and call the folder idle
  const stat = (path: string) => { try { const each = statSync(path); return { mtimeMs: each.mtimeMs, dir: each.isDirectory() }; } catch { return null; } };
  const fsDeps = { list: (dir: string) => readdirSync(dir), stat };

  it("the activity of a folder is its newest entry down to 3 levels below: a new file in repo/src counts", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "omb-r12b3-")));
    try {
      const ws = join(base, "54118a8a");
      mkdirSync(join(ws, "repo", "src"), { recursive: true });
      mkdirSync(join(ws, "repo", "node_modules", "x"), { recursive: true });
      writeFileSync(join(ws, "notes.md"), "x");
      writeFileSync(join(ws, "repo", "src", "a.ts"), "old");
      writeFileSync(join(ws, "repo", "node_modules", "x", "index.js"), "x");
      const recent = Date.UTC(2026, 9, 5, 9, 0);
      const newer = Date.UTC(2026, 9, 5, 10, 0);
      const old = (path: string) => utimesSync(path, idle / 1000, idle / 1000);
      // a file written today at the third level; every folder above it stays old
      writeFileSync(join(ws, "repo", "src", "b.ts"), "new");
      utimesSync(join(ws, "repo", "src", "b.ts"), recent / 1000, recent / 1000);
      for (const each of ["repo/src/a.ts", "repo/src", "repo/node_modules", "repo/node_modules/x", "repo", "notes.md", "."]) old(join(ws, each));
      // what is skipped (node_modules, .git, builds) never counts, however new
      utimesSync(join(ws, "repo", "node_modules", "x", "index.js"), newer / 1000, newer / 1000);
      expect(stat(ws)!.mtimeMs).toBe(idle);
      expect(stat(join(ws, "repo"))!.mtimeMs).toBe(idle);
      expect(folderActivity(ws, fsDeps)).toBe(recent);
      // so it is not told as idle since 29/09
      expect(staleTaskWorkspaces([{ path: ws, lastActivity: folderActivity(ws, fsDeps) }], { inUse: [], now, root: base, home })).toEqual([]);
      // all old: its newest time, the folder is told
      old(join(ws, "repo", "src", "b.ts"));
      expect(folderActivity(ws, fsDeps)).toBe(idle);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("past its budget of stat calls the activity is unknown, and a folder of unknown activity is never told as idle", () => {
    let stats = 0;
    const many = Array.from({ length: 5_000 }, (_, i) => `f${i}`);
    const deps = { list: (dir: string) => (dir === "/w" ? many : []), stat: (path: string) => { stats += 1; return { mtimeMs: path === "/w/f4999" ? 5 : 1, dir: false }; } };
    // the newest may be past the cut (readdir is in no order of date): no guess
    expect(folderActivity("/w", deps, 2_000)).toBeNull();
    expect(stats).toBeLessThanOrEqual(2_001);
    expect(staleTaskWorkspaces([{ path: "/w", lastActivity: folderActivity("/w", deps, 2_000) }], { inUse: [], now, root: "/", home })).toEqual([]);
    // within the budget, the newest wherever it is
    stats = 0;
    expect(folderActivity("/w", deps, 6_000)).toBe(5);
    // unreadable below: the top's own time; the top unreadable: unknown
    expect(folderActivity("/w", { list: () => { throw new Error("EACCES"); }, stat: () => ({ mtimeMs: 3, dir: true }) })).toBe(3);
    expect(folderActivity("/w", { list: () => [], stat: () => null })).toBeNull();
  });
});

// R11-resilience D2: a bot conversation's own folder IS its task-workspace
// (task.cwd = the workspace), and it was pushed as "in use" before the
// closed/quiet check — so the real 82feff85/54118a8a (closed), 82feff85/fa9d2302
// and e9ba01c7/70fa6c86 (open, quiet since 29/09), ~6,5 GB, never reached the report.
describe("a conversation's folders for the disk report (R11-resilience D2)", () => {
  const now = Date.UTC(2026, 9, 4, 23, 0);
  const T = "/Users/o/.openmausbot/task-workspaces";
  const ws = (bot: string, thread: string) => `${T}/${bot}/${thread}`;
  const day = (ms: number) => new Date(ms).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
  const quietSince = Date.UTC(2026, 8, 29, 12, 0);
  const forDisk = { forDisk: true, hasGoal: false, now, day };
  const conversations = [
    { workspace: ws("82feff85", "54118a8a"), task: { cwd: ws("82feff85", "54118a8a"), closedBy: "lead", title: "@Lead PRODEV · parallel work", createdAt: quietSince, updatedAt: quietSince } },
    { workspace: ws("82feff85", "fa9d2302"), task: { cwd: ws("82feff85", "fa9d2302"), title: "@Delivery PRODEV", createdAt: quietSince, updatedAt: quietSince } },
    { workspace: ws("e9ba01c7", "busy"), task: { cwd: ws("e9ba01c7", "busy"), busy: true, title: "@Lead PRODEV", createdAt: quietSince, updatedAt: quietSince } },
  ];

  it("a closed or quiet conversation's own folder is not 'in use' for the disk report; a busy one is", () => {
    const [closed, quiet, busy] = conversations.map(({ task, workspace }) => conversationFolders(task, workspace, forDisk));
    expect(closed).toEqual({ inUse: [], quiet: "conversa \"@Lead PRODEV · parallel work\" fechada" });
    expect(quiet).toEqual({ inUse: [], quiet: "conversa \"@Delivery PRODEV\" aberta, parada desde 29/09" });
    expect(busy).toEqual({ inUse: [ws("e9ba01c7", "busy"), ws("e9ba01c7", "busy")] });
    // a project folder the conversation works in stays in use, quiet or not
    expect(conversationFolders({ ...conversations[1]!.task, cwd: "/Users/o/Projetos/nuria-platform" }, conversations[1]!.workspace, forDisk))
      .toEqual({ inUse: ["/Users/o/Projetos/nuria-platform"], quiet: "conversa \"@Delivery PRODEV\" aberta, parada desde 29/09" });
    // a conversation working toward a goal is not quiet
    expect(conversationFolders(conversations[1]!.task, conversations[1]!.workspace, { ...forDisk, hasGoal: true }).quiet).toBeUndefined();
    // for anything but the disk report, everything a conversation has is in use
    expect(conversationFolders(conversations[0]!.task, conversations[0]!.workspace, { ...forDisk, forDisk: false })).toEqual({ inUse: [ws("82feff85", "54118a8a"), ws("82feff85", "54118a8a")] });
  });

  it("end to end: the closed and the quiet workspaces reach the report, the busy one does not", () => {
    const inUse: string[] = [];
    const notes = new Map<string, string>();
    for (const { task, workspace } of conversations) {
      const folders = conversationFolders(task, workspace, forDisk);
      inUse.push(...folders.inUse);
      if (folders.quiet) notes.set(workspace, folders.quiet);
    }
    const listed = staleTaskWorkspaces(conversations.map(({ workspace }) => ({ path: workspace, lastActivity: quietSince, ...(notes.has(workspace) ? { note: notes.get(workspace)! } : {}) })), { inUse, now });
    expect(listed.map((each) => [each.path, each.note])).toEqual([
      [ws("82feff85", "54118a8a"), "conversa \"@Lead PRODEV · parallel work\" fechada"],
      [ws("82feff85", "fa9d2302"), "conversa \"@Delivery PRODEV\" aberta, parada desde 29/09"],
    ]);
    // nothing is removed: each is a command a person runs
    expect(listed.every((each) => each.command.startsWith("mv ") && each.command.endsWith(" ~/.Trash/"))).toBe(true);
  });
});

// R13-followup #5: on 06/10 23:10 the chip said "1 pasta(s) … ~271 MB" and the log listed ~190 task-workspaces, nearly all "(? KB)":
// du gives 0 KB for an empty one, which read as unmeasured. The log tells what the chip tells.
describe("the stale folders' log line (R13-followup #5)", () => {
  it("counts the small and the unmeasured, and lists only what the chip counts", () => {
    const tw = (id: string) => `/Users/osvaldo/.openmausbot/task-workspaces/82feff85-aab2-4cb7-9f70-8969ec976979/${id}`;
    const stale = [
      { path: tw("b427dc32"), kind: "task-workspace" as const, idleSince: 0, command: "mv", sizeKb: 277_540 },
      ...Array.from({ length: 188 }, (_, i) => ({ path: tw(`empty-${i}`), kind: "task-workspace" as const, idleSince: 0, command: "mv", sizeKb: i % 3 ? 0 : 8 })),
      { path: tw("timeout"), kind: "task-workspace" as const, idleSince: 0, command: "mv", sizeKb: null },
    ];
    const told = staleFoldersReport(stale)!;
    expect(told.chip).toBe("Disco: 1 pasta(s) parada(s) há mais de 72 h fora da tag, ~271 MB — informação para o dono, nada foi removido");
    expect(told.report).toContain("(e mais 188 pequena(s), abaixo de 200 MB, não listada(s)) (e 1 cujo tamanho não consegui medir)");
    const line = staleFoldersLogLine(stale);
    expect(line).toBe(`1 folder(s) of 200 MB or more, ~271 MB: ${tw("b427dc32")} (271 MB); 188 smaller, not listed; 1 not measured: ${tw("timeout")}`);
    expect(line).not.toContain("? KB");
  });
});
