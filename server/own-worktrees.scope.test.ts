import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { userInfo } from "node:os";
import path, { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { appLinkFolder, ownLinkPath } from "./own-worktrees.ts";

// Where the alias may live, checked against the two programs that decide it,
// as installed on this Mac — both only READ, never run, never edited:
// - the Claude app's own rule for claude://code/new?folder=… (its vIn, read
//   out of app.asar): the alias must be a folder the link keeps;
// - the review hook (~/.laya/hooks/dual-review.cjs): a cwd the app reports
//   through the alias must still be in its scope (~/Projetos), or Jev/Laya
//   would not review the session's commands (INSP-X r1 X1-2).

// the person's real home (the tests' HOME is a temporary one: server/testing/setup.ts)
const HOME = userInfo().homedir;
const REPO = join(HOME, "Projetos", "nuria-platform");
const WORKTREE = join(REPO, ".claude", "worktrees", "9353-comprar-assentos");
const ALIAS = ownLinkPath(REPO, "9353-comprar-assentos");
const OLD_ALIAS = join(HOME, ".openmausbot", "worktree-links", "nuria-platform", "9353-comprar-assentos");

/** One file out of an asar archive (header: pickle sizes, then the JSON index; files after it). */
function asarFiles(archive: string): Array<{ name: string; read: () => string }> {
  const fd = openSync(archive, "r");
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const json = Buffer.alloc(head.readUInt32LE(12));
  readSync(fd, json, 0, json.length, 16);
  const index = JSON.parse(json.toString("utf8")) as { files: Record<string, unknown> };
  const base = 8 + headerSize;
  const out: Array<{ name: string; read: () => string }> = [];
  const walk = (files: Record<string, any>, prefix: string) => {
    for (const [name, entry] of Object.entries(files)) {
      if (entry.files) walk(entry.files, `${prefix}${name}/`);
      else if (!entry.unpacked && typeof entry.offset === "string") {
        out.push({ name: `${prefix}${name}`, read: () => {
          const data = Buffer.alloc(entry.size);
          const at = openSync(archive, "r");
          try { readSync(at, data, 0, entry.size, base + Number(entry.offset)); } finally { closeSync(at); }
          return data.toString("utf8");
        } });
      }
    }
  };
  walk(index.files, "");
  closeSync(fd);
  return out;
}

/** The installed app's rule, as it is in its bundle: `function X(e){…".claude"…"worktrees"…}`. */
function installedAppRule(): ((folder: string) => string | undefined) | null {
  const archive = "/Applications/Claude.app/Contents/Resources/app.asar";
  if (!existsSync(archive)) return null;
  const pattern = /function \w+\(e\)\{if\(!\(0,(\w+)\.isAbsolute\)\(e\)\)return;let t=\(0,\1\.resolve\)\(e\)\.split\(\1\.sep\);for\(let e=1;e\+2<t\.length;e\+\+\)if\((\w+)\(t\[e\]\)==="\.claude"&&\2\(t\[e\+1\]\)==="worktrees"\)return t\.slice\(0,e\)\.join\(\1\.sep\)\|\|\1\.sep\}/;
  for (const file of asarFiles(archive).filter((each) => each.name.startsWith(".vite/build/") && each.name.endsWith(".js"))) {
    const text = file.read();
    const found = pattern.exec(text);
    if (!found) continue;
    // its case fold (`oE`) is taken as lowercasing: the strictest reading for us
    const body = found[0].replace(/^function \w+/, "function rule");
    return runInNewContext(`${body}; rule`, { [found[1]!]: path, [found[2]!]: (value: string) => value.toLowerCase() }) as (folder: string) => string | undefined;
  }
  return null;
}

describe("the alias and the Claude app's link", () => {
  const rule = installedAppRule();
  it.runIf(rule !== null)("the installed app maps the worktree's own path back to the root, and keeps the alias (read from its bundle)", () => {
    expect(rule!(WORKTREE)).toBe(REPO);
    expect(rule!(ALIAS)).toBeUndefined(); // undefined: the link keeps the folder as given (`vIn(e)??e`)
    // our copy of the rule says the same
    expect(appLinkFolder(WORKTREE)).toBe(REPO);
    expect(appLinkFolder(ALIAS)).toBe(ALIAS);
  });
});

/** The installed hook's own scope rule, run on a cwd: its CODE_ROOT and inCode lines, as written there. */
function installedScope(): ((cwd: string) => boolean) | null {
  const hook = join(HOME, ".laya", "hooks", "dual-review.cjs");
  if (!existsSync(hook)) return null;
  const source = readFileSync(hook, "utf8");
  const root = /^const CODE_ROOT = .+;$/m.exec(source)?.[0];
  const inCode = /^\s*const inCode = (.+);$/m.exec(source)?.[1];
  if (!root || !inCode) return null;
  return (cwd: string) => runInNewContext(`${root}\n(${inCode})`, { path, os: { homedir: () => HOME }, cwd }) as boolean;
}

describe("the alias and the review hook's scope", () => {
  const inScope = installedScope();
  it.runIf(inScope !== null)("both the worktree and the alias the app may report are reviewed by Jev/Laya (~/Projetos); the old alias in the data dir was not", () => {
    expect(inScope!(WORKTREE)).toBe(true);
    expect(inScope!(ALIAS)).toBe(true);
    expect(inScope!(`${ALIAS}/web`)).toBe(true);
    // why it moved: under ~/.openmausbot it would have been "pass by scope" (INSP-X r1 X1-2)
    expect(inScope!(OLD_ALIAS)).toBe(false);
  });
});
