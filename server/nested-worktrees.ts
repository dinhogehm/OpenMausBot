// A batch session makes worktrees of its own inside its folder (g9278,
// c9322…) and leaves them behind when it is archived: dozens of GiB of
// merged branches nobody will open again. Archiving a session removes the
// ones that are safe to remove: merged into origin/main, not locked, and
// clean (`git worktree remove` without --force refuses a dirty one). Any
// other is kept and named.

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  locked: boolean;
}

/** `git worktree list --porcelain`, one entry per blank-line block. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length);
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//, "");
    entries.push({ path, ...(head ? { head } : {}), ...(branch ? { branch } : {}), locked: lines.some((line) => line === "locked" || line.startsWith("locked ")) });
  }
  return entries;
}

/** Worktrees inside `parent` (not `parent` itself). */
export function nestedWorktrees(entries: readonly WorktreeEntry[], parent: string): WorktreeEntry[] {
  const prefix = `${parent.replace(/\/+$/, "")}/`;
  return entries.filter((entry) => entry.path.startsWith(prefix));
}

/** Worktrees of `repo` whose work is already in production: their HEAD is
 * contained in `releasedSha` (the production tag). Never the main checkout,
 * never one in use (`inUse`: live sessions, the app's sessions), never a
 * locked or dirty one, never --force. What it removed, and what it kept and why. */
export function removeReleasedWorktrees(repo: string, releasedSha: string, git: (args: string[]) => string, inUse: ReadonlySet<string>): { removed: string[]; kept: string[] } {
  let entries: WorktreeEntry[];
  try {
    entries = parseWorktreeList(git(["worktree", "list", "--porcelain"]));
  } catch {
    return { removed: [], kept: [] };
  }
  const main = repo.replace(/\/+$/, "");
  const removed: string[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    if (entry.path === main || !entry.head) continue;
    // under a path in use (a session's folder, or a worktree inside it)
    if ([...inUse].some((path) => entry.path === path || entry.path.startsWith(`${path}/`) || path.startsWith(`${entry.path}/`))) continue;
    try {
      git(["merge-base", "--is-ancestor", entry.head, releasedSha]);
    } catch {
      continue; // not in production yet (or not known here)
    }
    if (entry.locked) { kept.push(`${entry.path} (bloqueada)`); continue; }
    try {
      git(["worktree", "remove", entry.path]);
      removed.push(entry.path);
    } catch {
      kept.push(`${entry.path} (tem mudanças locais)`);
    }
  }
  return { removed, kept };
}

/** Remove the merged, unlocked, clean worktrees nested in `parent`; a pt-BR
 * note of what was removed and what was kept, or "" when there were none. */
export function removeNestedWorktrees(parent: string, git: (args: string[]) => string, mainRef = "origin/main"): string {
  let entries: WorktreeEntry[];
  try {
    entries = nestedWorktrees(parseWorktreeList(git(["worktree", "list", "--porcelain"])), parent);
  } catch {
    return "";
  }
  if (!entries.length) return "";
  const removed: string[] = [];
  const kept: string[] = [];
  const name = (entry: WorktreeEntry) => entry.path.slice(parent.length + 1);
  for (const entry of entries) {
    if (entry.locked) { kept.push(`${name(entry)} (bloqueada)`); continue; }
    if (!entry.head) { kept.push(`${name(entry)} (sem commit)`); continue; }
    try {
      git(["merge-base", "--is-ancestor", entry.head, mainRef]);
    } catch {
      kept.push(`${name(entry)} (não está em ${mainRef})`);
      continue;
    }
    try {
      git(["worktree", "remove", entry.path]);
      removed.push(name(entry));
    } catch {
      kept.push(`${name(entry)} (tem mudanças locais)`);
    }
  }
  return [
    removed.length ? `Worktrees internas removidas (já mergeadas): ${removed.join(", ")}.` : "",
    kept.length ? `Mantidas: ${kept.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}
