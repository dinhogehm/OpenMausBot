import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveCleanupNote, codexRolloutFolders, isDisposableIgnored, removeArchivedWorktree, nestedWorktrees, parseWorktreeList, planReleasedWorktrees, RELEASED_MIN_IDLE_MS,
  releasedPlanLine, removeNestedWorktrees, worktreeLastActivity, type ReleasedPlanDeps,
} from "./nested-worktrees.ts";

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

  it("removes the merged ones with nothing to lose and names the rest, with the command (G12)", async () => {
    const calls: string[] = [];
    const git = async (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "worktree" && args[1] === "list") return porcelain;
      if (args[0] === "merge-base" && args[2] === "c30") throw new Error("not ancestor");
      if (args[0] === "-C" && args[1]!.endsWith("/c9322") && args.includes("status")) return "?? novo.txt\n";
      return "";
    };
    const result = await removeNestedWorktrees(parent, { repo: "/r/nuria-platform", git, processCwds: [], processCommands: [] });
    expect(result.removed).toEqual([`${parent}/g9278`]);
    // deepest (longest path) first
    expect(result.kept).toEqual([
      { path: `${parent}/wt9278`, why: "bloqueada" },
      { path: `${parent}/c9322`, why: "tem mudanças locais", command: `git -C /r/nuria-platform worktree remove ${parent}/c9322` },
      { path: `${parent}/g9330`, why: "não está em origin/main" },
    ]);
    expect(archiveCleanupNote(parent, result).chip).toBe("Worktrees removidas: g9278. Mantidas: wt9278 (bloqueada), c9322 (tem mudanças locais), g9330 (não está em origin/main).");
    expect(archiveCleanupNote(parent, result).report).toContain(`git -C /r/nuria-platform worktree remove ${parent}/c9322`);
    // never forced, never the session's own worktree
    expect(calls.some((call) => call.includes("--force"))).toBe(false);
    expect(calls).not.toContain(`worktree remove ${parent}`);
  });

  it("says nothing when there are none, or git cannot list them", async () => {
    const deps = (git: (args: string[]) => Promise<string>) => ({ repo: "/r/nuria-platform", git, processCwds: [], processCommands: [] });
    expect(await removeNestedWorktrees(parent, deps(async () => "worktree /r/nuria-platform\nHEAD aaa"))).toEqual({ removed: [], kept: [] });
    expect(await removeNestedWorktrees(parent, deps(async () => { throw new Error("not a repo"); }))).toEqual({ removed: [], kept: [] });
    expect(archiveCleanupNote(parent, { removed: [], kept: [] })).toEqual({ chip: "", report: "" });
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
    expect(first.line).toBe("nuria-platform: nenhuma pode ser removida; mantidas: odd (não conferida: '/r/p/w/odd' is a main working tree), dirty (tem mudanças locais)");
    // the same pass 6 h later: nothing to say
    expect(releasedPlanLine("nuria-platform", plan, first.key).line).toBeNull();
    // a new candidate: said again
    expect(releasedPlanLine("nuria-platform", { ...plan, candidates: [{ path: "/r/p/w/old", command: "x" }] }, first.key).line).toContain("1 pode(m) ser removida(s) (old)");
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

  it("on archive removes only what has nothing to lose, and never the session's worktree with work inside (G12)", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-g12-"));
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
      const nested = await removeNestedWorktrees(session, deps, "main");
      const name = (path: string) => path.split("/").pop();
      expect(nested.removed.map(name)).toEqual(["merged-clean"]);
      expect(Object.fromEntries(nested.kept.map((item) => [name(item.path), item.why]))).toEqual({
        "grandchild": "tem mudanças locais",
        "merged-parent": "contém outra worktree",
        "merged-env": "tem arquivos ignorados: .env.local",
        "merged-dirty": "tem mudanças locais",
        "merged-busy": "em uso por processo",
        "merged-used": "em uso por outra sessão",
        "unmerged": "não está em main",
      });
      // the session's own worktree still holds nested worktrees: it stays, with the command
      const own = await removeArchivedWorktree(session, deps, []);
      expect(own).toEqual({ removed: [], kept: [{ path: session, why: "contém outra worktree", command: `git -C ${repo} worktree remove ${session}` }] });
      expect(calls.some((args) => args.includes("--force"))).toBe(false);
      for (const path of [join(grandchild, "novo.txt"), join(env, ".env.local"), join(dirty, "novo.txt"), busy, join(used, "sub"), ahead]) expect(existsSync(path), path).toBe(true);
      expect(existsSync(clean)).toBe(false);

      // a session worktree with only a .env.local stays; a clean, locked one goes (its lock lifted only then)
      const envOnly = add(join(repo, ".claude", "worktrees", "env-only"));
      writeFileSync(join(envOnly, ".env.local"), "TOKEN=placeholder\n");
      expect((await removeArchivedWorktree(envOnly, deps, [])).kept[0]!.why).toBe("tem arquivos ignorados: .env.local");
      expect(existsSync(join(envOnly, ".env.local"))).toBe(true);
      const lockedClean = add(join(repo, ".claude", "worktrees", "locked-clean"));
      run(repo, "worktree", "lock", lockedClean);
      expect((await removeArchivedWorktree(lockedClean, deps, [])).removed).toEqual([lockedClean]);
      expect(existsSync(lockedClean)).toBe(false);
      // another live session in it: kept without asking git anything
      expect((await removeArchivedWorktree(envOnly, deps, ["\"#9331\" (app)"])).kept[0]!.why).toBe("em uso por \"#9331\" (app)");
    } finally {
      busyProc.kill?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
