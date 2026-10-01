// A session archived in the Claude app by someone, not by an order of the
// server (desktop-work.ts marks it archivedOutsideAt): the PRs it still had
// open are left without anyone working on them. This finds them and tells
// the owner, once per session (INSP-F F1: ffd6ee1a / #9328).
//
// Where the PRs come from, because a session rarely writes "PR #N":
//   1. its delivered PRs and the "PR #N" its last report names (prsOfSession);
//   2. the open PRs GitHub finds by its issue (`gh pr list --search <issue>`):
//      ffd6ee1a's report only says "o ci:local da #9328", and its issue 9319
//      finds #9328 in one call — kept only when the PR's title or branch
//      names the issue (the search also finds PRs that merely cite it);
//   3. the open PRs whose head is its worktree's branch.
// A PR another session still alive carries on (its PRs, or the same issue)
// is not "left without a session": the owner hears it goes on with it.
// Sessions archived by the person after they failed are checked too (their
// gate may have stopped halfway), worded as such, not as "behind the back".
// A number that is not a PR ("Could not resolve to a PullRequest": an issue
// quoted in a report) is dropped for good, never retried. A check that could
// not reach GitHub is retried with a growing pause, at most
// ARCHIVED_OUTSIDE_MAX_TRIES times, and then settled as "não consegui
// conferir"; sessions are taken least-recently-tried first, so a few that
// keep failing never hold back the others.
import type { CcSession } from "./cc-sessions.ts";
import { issueNumber } from "./desktop-work.ts";
import { notAPullRequest, prsOfSession } from "./prod-delivery.ts";

export { notAPullRequest };

export const ARCHIVED_OUTSIDE_MAX_TRIES = 6;
/** Sessions looked at per pass (each costs a few gh calls). */
export const ARCHIVED_OUTSIDE_PER_PASS = 3;
/** Pause before the next try after one that could not reach GitHub, times the tries so far. */
export const ARCHIVED_OUTSIDE_RETRY_MS = 2 * 60_000;
/** Numbers looked at one by one per session. */
const MAX_CANDIDATES = 6;

export type PrState = "OPEN" | "CLOSED" | "MERGED" | "NOT_PR";

export interface OwnerPendingItem { title: string; link?: string; key: string }

/** An open PR as `gh pr list --json number,title,headRefName` gives it. */
export interface FoundPr { number: number; title?: string; headRefName?: string }

export interface ArchivedOutsideDeps {
  now(): number;
  save(): void;
  /** "owner/repo" of the session's repository; null when not on GitHub. Throws when it cannot tell. */
  slugOf(session: CcSession): Promise<string | null>;
  /** The state of #number; "NOT_PR" when GitHub says it is no pull request. Throws when it cannot tell. */
  prState(number: number, slug: string): Promise<PrState>;
  /** Open PRs found by an issue number (`--search`) or by a head branch. Throws when it cannot tell. */
  openPrs(by: { issue: string } | { branch: string }, slug: string): Promise<FoundPr[]>;
  /** The branch checked out in a folder; null when the folder is gone or detached. */
  branchOf(cwd: string): Promise<string | null>;
  chip(session: CcSession, text: string, ok: boolean): void;
  report(session: CcSession, text: string): void;
  /** A "Precisa de você" item; the caller puts it in a conversation still open. */
  ownerPending(session: CcSession, item: OwnerPendingItem): void;
}

/** The GitHub and git lookups, over a runner that works like the server's
 * execCc (execFile: resolves stdout, rejects with the error execFile gives,
 * whose message and `stderr` carry gh's own words). */
export function githubLookups(exec: (file: string, args: string[], cwd?: string) => Promise<string>): Pick<ArchivedOutsideDeps, "prState" | "openPrs" | "branchOf"> {
  return {
    prState: async (number, slug) => {
      let out: string;
      try {
        out = await exec("gh", ["pr", "view", String(number), "--repo", slug, "--json", "state"]);
      } catch (error) {
        if (notAPullRequest(error)) return "NOT_PR";
        throw error;
      }
      const state = (JSON.parse(out) as { state?: string }).state;
      if (state === "OPEN" || state === "CLOSED" || state === "MERGED") return state;
      throw new Error(`gh pr view ${number}: unexpected state ${JSON.stringify(state)}`); // not a guess: tried again
    },
    openPrs: async (by, slug) => {
      const filter = "issue" in by ? ["--search", by.issue] : ["--head", by.branch];
      const list = JSON.parse(await exec("gh", ["pr", "list", "--repo", slug, "--state", "open", ...filter, "--json", "number,title,headRefName", "--limit", "20"])) as FoundPr[];
      return list.filter((pr) => typeof pr?.number === "number");
    },
    branchOf: async (cwd) => {
      const branch = (await exec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
      return branch || null;
    },
  };
}

/** Sessions still to check, the ones tried least recently first; those
 * waiting out their pause after a failed try are left for later. */
export function archivedOutsideDue(sessions: readonly CcSession[], now: number): CcSession[] {
  return sessions
    .filter((session) => session.archivedOutsideAt !== undefined && session.archivedOutsideCheckedAt === undefined)
    .filter((session) => session.archivedOutsideTriedAt === undefined || now - session.archivedOutsideTriedAt >= ARCHIVED_OUTSIDE_RETRY_MS * (session.archivedOutsideTries ?? 1))
    .sort((a, b) => (a.archivedOutsideTriedAt ?? 0) - (b.archivedOutsideTriedAt ?? 0) || a.archivedOutsideAt! - b.archivedOutsideAt!);
}

const MAIN_BRANCHES = new Set(["main", "master", "develop", "HEAD"]);

/** A PR found by searching an issue's number is that issue's only when its
 * title or its branch names the number: `gh pr list --search 9307` also
 * finds the PR of #9052 that merely cites 9307 in its body. */
export function prOfIssue(pr: FoundPr, issue: string): boolean {
  const named = new RegExp(`(?<!\\d)${issue}(?!\\d)`);
  return pr.number !== Number(issue) && (named.test(pr.title ?? "") || named.test(pr.headRefName ?? ""));
}

/** The live session (not archived) that carries a PR on: one whose
 * delivered or reported PRs include it, or — for a PR found by the issue —
 * one working on the same issue in the same repository. Archiving and
 * reopening a session for an issue is the common case. */
export function liveOwnerOf(number: number, viaIssue: string | null, session: CcSession, sessions: readonly CcSession[], slug: string): CcSession | null {
  // only a session that may still work counts: stopped, failed or archived ones carry nothing on
  return sessions.find((other) => other.id !== session.id && LIVE.has(other.status) && other.repo === session.repo && (
    prsOfSession(other, slug).includes(number)
    // an app session knows its issue; a CLI one names it in its title
    || (viaIssue !== null && (other.desktop?.issue ?? issueNumber(other.title)) === viaIssue)
  )) ?? null;
}

const LIVE = new Set<string>(["running", "idle", "stalled"]);

/** One session: its open PRs (and how each was found), and the numbers GitHub could not answer for. */
async function openPrsOf(session: CcSession, slug: string, deps: ArchivedOutsideDeps): Promise<{ open: Map<number, string | null>; unknown: number[]; lookupFailed: boolean }> {
  // number → the issue it was found by (null: by its branch or its report)
  const open = new Map<number, string | null>();
  const unknown: number[] = [];
  let lookupFailed = false;
  const issue = session.desktop?.issue;
  if (issue) {
    try {
      for (const pr of await deps.openPrs({ issue }, slug)) if (prOfIssue(pr, issue)) open.set(pr.number, issue);
    } catch { lookupFailed = true; }
  }
  if (session.cwd) {
    const branch = await deps.branchOf(session.cwd).catch(() => null);
    if (branch && !MAIN_BRANCHES.has(branch)) {
      try {
        for (const pr of await deps.openPrs({ branch }, slug)) if (!open.has(pr.number)) open.set(pr.number, null);
      } catch { lookupFailed = true; }
    }
  }
  for (const number of prsOfSession(session, slug).filter((each) => !open.has(each)).slice(0, MAX_CANDIDATES)) {
    try {
      const state = await deps.prState(number, slug);
      if (state === "OPEN") open.set(number, null);
    } catch (error) {
      // an issue quoted in a report: settled, not a reason to try again
      if (!notAPullRequest(error)) unknown.push(number);
    }
  }
  return { open, unknown, lookupFailed };
}

/** Check up to ARCHIVED_OUTSIDE_PER_PASS sessions archived outside the server. */
export async function checkArchivedOutside(sessions: readonly CcSession[], deps: ArchivedOutsideDeps): Promise<void> {
  for (const session of archivedOutsideDue(sessions, deps.now()).slice(0, ARCHIVED_OUTSIDE_PER_PASS)) {
    let slug: string | null;
    let found: Awaited<ReturnType<typeof openPrsOf>>;
    try {
      slug = session.delivery?.slug ?? await deps.slugOf(session);
      found = slug ? await openPrsOf(session, slug, deps) : { open: new Map(), unknown: [], lookupFailed: false };
    } catch {
      slug = null;
      found = { open: new Map(), unknown: [], lookupFailed: true };
    }
    const failed = found.unknown.length > 0 || found.lookupFailed;
    if (failed) {
      session.archivedOutsideTries = (session.archivedOutsideTries ?? 0) + 1;
      session.archivedOutsideTriedAt = deps.now();
      if (session.archivedOutsideTries < ARCHIVED_OUTSIDE_MAX_TRIES) {
        deps.save();
        continue; // GitHub did not answer: later, after the others
      }
    }
    session.archivedOutsideCheckedAt = deps.now();
    deps.save();
    // a PR another live session carries on is not left without a session
    const orphans: number[] = [];
    const carried: Array<{ number: number; by: CcSession }> = [];
    for (const [number, viaIssue] of [...found.open].sort((a, b) => a[0] - b[0])) {
      const by = slug ? liveOwnerOf(number, viaIssue, session, sessions, slug) : null;
      if (by) carried.push({ number, by });
      else orphans.push(number);
    }
    tell(session, slug, orphans, carried, failed ? found.unknown : [], failed && found.lookupFailed, deps);
  }
}

function tell(session: CcSession, slug: string | null, open: number[], carried: Array<{ number: number; by: CcSession }>, unknown: number[], lookupFailed: boolean, deps: ArchivedOutsideDeps): void {
  const link = (number: number) => (slug ? `https://github.com/${slug}/pull/${number}` : `#${number}`);
  for (const { number, by } of carried) deps.chip(session, `a PR #${number} segue com a sessão "${by.title.slice(0, 60)}" (${by.id.slice(0, 8)})`, true);
  for (const number of open) deps.chip(session, `PR #${number} ficou sem sessão: ${link(number)}`, false);
  const notChecked = [...unknown.map((number) => `#${number}`), ...(lookupFailed ? ["as PRs da issue/branch"] : [])];
  if (notChecked.length) deps.chip(session, `não consegui conferir no GitHub: ${notChecked.join(", ")}`, false);
  if (!open.length && !notChecked.length) return;
  const prs = open.map((number) => `#${number}`).join(", ");
  // a failed session the person archived was not archived "behind the server's back"
  const how = session.archivedAfterFailure ? "foi arquivada no app Claude depois de falhar" : "foi arquivada no app Claude por alguém, sem pedido do OMB";
  deps.report(session, [
    open.length ? `PR ${prs} ficou sem sessão: "${session.title}" (${session.id}) ${how}. Open PR(s) with nobody working on them now: ${open.map(link).join(", ")}. Start a session for them (cc_session_start), hand them to someone, or close them — and tell the owner which.` : `"${session.title}" (${session.id}) ${how}.`,
    notChecked.length ? `GitHub did not answer after ${ARCHIVED_OUTSIDE_MAX_TRIES} tries for ${notChecked.join(", ")}: check by hand whether a PR of it is still open.` : "",
  ].filter(Boolean).join(" "));
  for (const number of open) {
    deps.ownerPending(session, { title: `PR #${number} ficou sem sessão ("${session.title}" ${session.archivedAfterFailure ? "falhou e foi arquivada no app" : "foi arquivada no app"}) — decida quem segue`, ...(slug ? { link: link(number) } : {}), key: `cc-orphan-pr:${session.id}:${number}` });
  }
}
