// "Delivered in production" closes a piece of work: the PR a Claude Code
// session opened was merged, and later a release moved the production tag
// past its merge commit. Nothing tells the owning bot when that happens, so
// the cycle (tell the requester, update the spreadsheet and the issue,
// archive the session) waits on someone remembering to look. The server
// looks instead: every DELIVERY_CHECK_MS it reads the PRs a session has
// reported, asks GitHub for their merge commit, reads the production tag
// with `git ls-remote` and, when the tag contains the merge (compare API)
// AND the release corridor recorded a healthy release of the tag's commit
// (releaseRecord), reports to the owner once: "em produção desde <hora>".
//
// The tag alone is not proof (09/10: it was moved outside the corridor and
// #9483 was announced; 12/10: #9528 changed an app the release had no target
// for and was announced ~8 h before it was published). The time is the
// receipt's DEPLOYED_AT, never the tag commit's date (wrong in 23 of 23
// deliveries, by a median of ~4 h); without it the time is said unknown.
// A tag that moves back past a merge reopens that delivery.
//
// State lives on the session (CcSession.delivery); lookups are cached and
// capped per pass so a ledger full of sessions stays within API limits.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionErrorPt } from "../shared/session-error-pt.ts";

/** The tag the release watcher moves when a release reaches production. */
export const PRODUCTION_TAG = "nuria-production-deployed";
/** How often one PR (or one repository's tag) is looked at again. */
export const DELIVERY_CHECK_MS = 10 * 60_000;
/** GitHub calls one pass may make, across all sessions. */
export const DELIVERY_MAX_CALLS = 8;
/** How long after "em produção" the tag is still read for a rollback past
 * the merge: a day, so a session left unarchived does not keep the server
 * reading the remote tag every 10 min for good. */
export const ROLLBACK_WATCH_MS = 24 * 3_600_000;

export interface DeliveryPr {
  url: string;
  number: number;
  state?: "open" | "merged" | "closed";
  mergeSha?: string;
  checkedAt?: number;
  /** When the production tag was seen containing it, and when the release
   * that published it went live (the receipt's DEPLOYED_AT, in pt-BR); unset
   * when the corridor's record has no time for it. */
  inProductionAt?: number;
  productionSince?: string;
  reportedAt?: number;
  /** The tag commit it was announced under: a later tag that no longer
   * contains the merge reopens the delivery. */
  productionTag?: string;
  /** Why it is held back (no record, a result the corridor does not certify,
   * an app with no publish target…), as a key: the bot is told once per
   * reason, not at every tag that still holds it. */
  heldAt?: string;
  /** That reason in pt-BR, for archiving and the owner. */
  heldWhy?: string;
  /** What proved it live: the corridor's record, or (where no corridor
   * runs) only the tag. */
  proof?: "corridor" | "tag";
  /** The files the merged PR changed (read once: a merged PR does not change). */
  paths?: string[];
  /** Why it is this session's: its head branch is the session's ("branch"),
   * or the session was told to take it over ("explicit"). Unset: only named
   * in a report — a candidate, not yet the session's (R9-followup #2).
   * "legacy": recorded and found MERGED by a build before ownership existed
   * — kept, so its delivery to production is still followed (INSP-H r1 #1). */
  owned?: "branch" | "explicit" | "legacy";
}

export interface CcDelivery {
  /** "owner/repo" of the session's origin, once known. */
  slug?: string;
  prs: Record<string, DeliveryPr>;
  /** Numbers a report named as PRs that GitHub says are not PRs (issues). */
  notPrs?: number[];
  /** PRs a report named that are another session's (head on another branch). */
  notOwned?: number[];
}

interface DeliverySession {
  id: string;
  title: string;
  repo: string;
  status: string;
  /** Its worktree: whose branch says which PRs are its own. */
  cwd?: string;
  lastReport?: string;
  delivery?: CcDelivery;
  /** PRs the session was told to take over ("assuma a PR #N"). */
  claimedPrs?: number[];
}

// ── whose PR it is ───────────────────────────────────────────────────────
// 01/10: the session of #M wrote "a trava … está na PR #N, que ainda
// não está em main", and #N (another session's) became its PR: its
// archiving was held by it, its "em produção" would have gone to the wrong
// conversation, and liveOwnerOf would have named it #N's live owner
// (R9-followup #2). A PR is a session's only by its head branch (the
// worktree's branch or the branch it pushed to) or by an explicit hand-over.

const NOT_A_WORK_BRANCH = new Set(["main", "master", "develop", "HEAD", ""]);

/** The branches a session works on — its worktree's checkout and the branch
 * it pushed to (`git push -u origin HEAD:fix/…` sets the upstream) — and its
 * HEAD commit. Null when its worktree cannot be read (none yet, or gone). */
/** The PRs handed to a session by the orders it was given before claimedPrs
 * existed, read from the bots' tool calls in the history (cc_session_send
 * to its id, or the cc_session_start that opened it, by its title): the
 * real "assuma a PR #N" of 18:13 to the 29da943f (INSP-H r1 #1). */
export function claimsInToolCalls(calls: ReadonlyArray<{ tool: string; input: string }>, sessionId: string, startedAs: (title: string) => boolean): number[] {
  const found = new Set<number>();
  for (const call of calls) {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(call.input) as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = call.tool.endsWith("cc_session_send") && input.session_id === sessionId && typeof input.message === "string"
      ? input.message
      : call.tool.endsWith("cc_session_start") && typeof input.title === "string" && startedAs(input.title) && typeof input.brief === "string"
        ? input.brief
        : null;
    if (text) for (const number of claimedPrNumbers(text)) found.add(number);
  }
  return [...found];
}

export interface SessionBranches {
  names: string[];
  heads: string[];
  /** The number the session's worktree folder opens with ("9330-gate-2a8f5c"):
   * the issue or the PR it was opened for. GitHub numbers issues and PRs in
   * one sequence, so a PR with that number is the one it was opened for. */
  folderNumber?: number;
}

/** `git worktree list --porcelain`: each worktree's path, branch and HEAD. */
export function parseWorktreeList(output: string): Array<{ path: string; branch: string | null; head: string | null }> {
  return output.split(/\n\s*\n/).map((block) => ({
    path: /^worktree (.+)$/m.exec(block)?.[1]?.trim() ?? "",
    branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? null,
    head: /^HEAD ([0-9a-f]{40})$/m.exec(block)?.[1] ?? null,
  })).filter((tree) => tree.path);
}

/** The branches checked out in a HEAD's reflog ("checkout: moving from A to B"). */
export function reflogBranches(output: string): string[] {
  return [...output.matchAll(/checkout: moving from (\S+) to (\S+)/g)].flatMap((match) => [match[1]!, match[2]!]).filter((name) => !/^[0-9a-f]{7,40}$/.test(name));
}

/** The branches a session works on and the commits at their heads:
 * - its worktree's checkout and the branch it pushed to (`git push -u
 *   origin HEAD:fix/…` sets the upstream);
 * - the worktrees nested INSIDE its folder (`git worktree list`): on 01/10
 *   the 29da943f sat on a detached HEAD and worked on #N and #K in
 *   `.worktrees/9328` and `.worktrees/9340` (INSP-H r1 #1);
 * - the branches its HEAD checked out (reflog).
 * Null when its worktree cannot be read (none yet, or gone). */
export async function sessionBranches(session: Pick<DeliverySession, "cwd">, git: DeliveryDeps["git"]): Promise<SessionBranches | null> {
  if (!session.cwd) return null;
  const cwd = session.cwd.replace(/\/+$/, "");
  const read = (args: string[]) => git(cwd, args).then((out) => out.trim(), () => null);
  const [local, upstream, head, trees, reflog] = await Promise.all([
    read(["rev-parse", "--abbrev-ref", "HEAD"]),
    read(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    read(["rev-parse", "HEAD"]),
    read(["worktree", "list", "--porcelain"]),
    read(["reflog", "show", "--format=%gs", "-n", "200", "HEAD"]),
  ]);
  if (local === null && head === null) return null;
  const nested = parseWorktreeList(trees ?? "").filter((tree) => tree.path.startsWith(`${cwd}/`));
  const pushed = upstream ? upstream.replace(/^[^/]+\//, "") : null;
  const names = [...new Set([local, pushed, ...nested.map((tree) => tree.branch), ...reflogBranches(reflog ?? "")]
    .filter((name): name is string => name !== null && !NOT_A_WORK_BRANCH.has(name)))];
  const heads = [...new Set([head, ...nested.map((tree) => tree.head)].filter((sha): sha is string => sha !== null && /^[0-9a-f]{40}$/.test(sha)))];
  const folder = /^(\d{2,7})(?:\D|$)/.exec(cwd.split("/").at(-1) ?? "")?.[1];
  return { names, heads, ...(folder ? { folderNumber: Number(folder) } : {}) };
}

/** Whether a PR is the session's, and why: told to take it over, or its
 * head is one of the session's branches (by name, or by its very commit).
 * A mention in a report is never enough. */
export function prOwnership(pr: { number: number; headRefName?: string; headRefOid?: string }, branches: SessionBranches | null, claimed: readonly number[] = []): "branch" | "explicit" | null {
  if (claimed.includes(pr.number)) return "explicit";
  if (!branches) return null;
  if (pr.headRefName && branches.names.includes(pr.headRefName)) return "branch";
  if (pr.headRefOid && branches.heads.includes(pr.headRefOid)) return "branch";
  // the worktree was made for this very PR ("P-gate-…" gating #P)
  if (branches.folderNumber === pr.number) return "branch";
  return null;
}

/** The PRs an order HANDS to the session it is sent to: an imperative to
 * it ("assuma a PR #N", "assuma as PRs #N e #K", "você assume a PR
 * órfã https://…/pull/9289", "fique com a #Q") or "a PR #N é sua".
 * Not under a negation ("não assuma"), not about someone else ("a 29da943f
 * assume a PR #N"), not a question ("a PR #N é sua?") (INSP-H r1 #7). */
export function claimedPrNumbers(text: string): number[] {
  const found = new Set<number>();
  const numbersIn = (span: string) => [...span.matchAll(/(?<!issue\s{0,3})#(\d{2,6})\b|\/pull\/(\d{1,7})\b/giu)].map((match) => Number(match[1] ?? match[2]));
  // sentences (a URL's dots are not an end), then clauses
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (sentence.trim().endsWith("?")) continue;
    for (const clause of sentence.split(/;\s*/)) {
      const take = /(?<![\p{L}])(?:(?:voc[êe]s?\s+)?(?:assuma|assumam)|voc[êe] assume|voc[êe]s assumem|pode assumir|fique com|fiquem com|pegue|toma conta d[ao]|take over|take ownership of)(?![\p{L}])/iu.exec(clause);
      if (take && !/(?<![\p{L}])(?:n[ãa]o|nunca|jamais)\s+(?:\S+\s+){0,1}$/iu.test(clause.slice(0, take.index))) {
        // what it takes: the list right after the verb ("#N e a #K"), not "… e rode o gate da #P"
        const span = clause.slice(take.index).split(/,\s+|\s+e\s+(?!(?:a|as|o|os|the)?\s*(?:PRs?\s*)?(?:#|https?:))/iu)[0]!;
        for (const number of numbersIn(span)) found.add(number);
      }
      for (const match of clause.matchAll(/(?<![\p{L}])(?:PR|pull request)\s*#(\d{2,6})\s+(?:é|e|fica)\s+(?:sua|com voc[êe])(?![\p{L}])/giu)) {
        if (!/(?<![\p{L}])(?:n[ãa]o|nunca)\s+$/iu.test(clause.slice(0, match.index).slice(-12))) found.add(Number(match[1]));
      }
    }
  }
  return [...found];
}

/** PR links of `slug` ("owner/repo") in a text, by number. */
export function prLinks(text: string, slug: string): Array<{ url: string; number: number }> {
  const found = new Map<number, string>();
  const pattern = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1]!.toLowerCase() !== slug.toLowerCase()) continue;
    const number = Number(match[2]);
    if (!found.has(number)) found.set(number, `https://github.com/${match[1]}/pull/${number}`);
  }
  // sessions often report a PR only as "PR #R", or a list after the
  // plural: "PRs #S e #P", "PRs #1, #2 and #3". A bare "#N" may be an
  // issue, so only the number right after a singular "PR" counts ("PR #N,
  // #T (issue)", "PR #N/#9319" name an issue second), and a number in
  // a list tagged as an issue right after it ("#T (issue)", "#T é a
  // issue") leaves it. An issue named elsewhere in the sentence ("PRs #S e
  // #P fecham a issue #U") does not cut the list: these are candidates,
  // and whoever uses them asks GitHub — a number that is no PR answers "Could
  // not resolve to a PullRequest" (notAPullRequest) and is dropped there.
  // Missing a PR is worse than checking one too many: archiveBlockers would
  // let a session with an open PR be archived.
  for (const match of text.matchAll(/\b(?:(PRs|pull requests)\s*(#\d{2,6}(?:\s*(?:,|&|\be\b|\band\b)\s*#\d{2,6})*)|(?:PR|pull request)\s*#(\d{2,6}))\b/gi)) {
    const numbers = match[3] ? [Number(match[3])] : listedPrs(match[2]!, text.slice(match.index! + match[0].length));
    for (const number of numbers) {
      if (!found.has(number)) found.set(number, `https://github.com/${slug}/pull/${number}`);
    }
  }
  return [...found].map(([number, url]) => ({ url, number }));
}

/** The PR numbers of a list that followed "PRs": a number tagged as an issue
 * right after it ("#T (issue)", "#T é a issue") leaves it. */
function listedPrs(list: string, after: string): number[] {
  const numbers = [...list.matchAll(/#(\d{2,6})/g)].map((each) => Number(each[1]));
  const issueTagged = (rest: string) => /^\s*(?:\(\s*(?:a\s+|the\s+)?issue\s*\)|(?:é|e|is)\s+(?:a\s+|the\s+|uma\s+|an\s+)?issue\b)/i.test(rest);
  // only the last one can carry a tag: inside the list a separator follows
  return numbers.filter((_, i) => i < numbers.length - 1 || !issueTagged(after));
}

/** gh's answer for a number that is an issue (or nothing), not a PR: `gh pr
 * view N` exits 1 with "GraphQL: Could not resolve to a PullRequest with the
 * number of N." on stderr, which execFile puts in the error's message and
 * in its `stderr`. Settled — never a reason to try again. */
export function notAPullRequest(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${String((error as { stderr?: unknown }).stderr ?? "")}` : String(error);
  return /Could not resolve to a PullRequest|no pull requests? found/i.test(text);
}

/** `origin`'s "owner/repo" from its URL; null when not GitHub. Every form
 * git accepts: https://github.com/o/r(.git), git@github.com:o/r(.git),
 * ssh://git@github.com/o/r and the port-443 route
 * ssh://git@ssh.github.com:443/o/r.git (nuria-platform's origin). */
export function githubSlug(remoteUrl: string): string | null {
  const match = /(?:^|[@/])(?:ssh\.)?github\.com(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The commit a tag points at, from `git ls-remote origin <tag> <tag>^{}`
 * (the peeled line wins for an annotated tag). */
export function parseLsRemoteTag(output: string, tag: string): string | null {
  let direct: string | null = null;
  for (const line of output.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    if (ref === `refs/tags/${tag}^{}`) return sha;
    if (ref === `refs/tags/${tag}`) direct = sha;
  }
  return direct;
}

/** GitHub's mergeStateStatus, said in pt-BR for a chip the owner reads;
 * "" when there is nothing to say (UNKNOWN: GitHub has not computed it yet). */
export function mergeStatePt(status: string | undefined): string {
  switch ((status ?? "").toUpperCase()) {
    case "CLEAN": return "pronta para merge";
    case "HAS_HOOKS": return "pronta para merge";
    case "BLOCKED": return "bloqueada pelas regras do repositório";
    case "BEHIND": return "atrás da main";
    case "DIRTY": return "com conflito";
    case "UNSTABLE": return "com checks falhando";
    case "DRAFT": return "rascunho";
    default: return "";
  }
}

/** "30/09 16:40" in the owner's time zone. */
export function productionTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "");
}

/** "em produção desde 30/09 16:40", or that the time is unknown. */
export function productionSinceText(since: string | undefined): string {
  return since ? `em produção desde ${since}` : "em produção, horário do deploy indisponível";
}

/** For the owner, once per session and pass: these PRs reached production. */
export function deliveryReport(session: Pick<DeliverySession, "id" | "title">, prs: DeliveryPr[], tagSha: string): string {
  const known = prs.map((pr) => pr.productionSince).filter((since): since is string => since !== undefined).sort();
  return [
    `[Claude Code session ${session.id} ("${session.title}"): delivered in production — ${productionSinceText(known[0])}.]`,
    ...prs.map((pr) => `- PR #${pr.number} (${pr.url}): merge ${pr.mergeSha?.slice(0, 8)} is contained in ${PRODUCTION_TAG} (${tagSha.slice(0, 8)}), ${pr.proof === "corridor" ? "and the release corridor recorded that commit as released and healthy" : "seen only by the tag (no release corridor record on this machine)"} — ${productionSinceText(pr.productionSince)}.`),
    ...(known.length < prs.length ? ["The release time is unknown for some of them: say so to the requester instead of guessing one (never the commit's date)."] : []),
    "Close the cycle now: tell the requester it is live (in their channel), update the spreadsheet row and the issue, then archive the session with cc_session_archive once nothing else is pending in it.",
    "The requester counts as told only with the ID of the message you sent (what the send command returned): write that ID in the issue and the spreadsheet. No ID, no notice — never report it as done without one.",
  ].join("\n");
}

export interface DeliveryDeps {
  now(): number;
  /** `gh <args>` stdout; throws on failure. */
  gh(args: string[]): Promise<string>;
  /** `git -C repo <args>` stdout; throws on failure. */
  git(repo: string, args: string[]): Promise<string>;
  report(session: DeliverySession, text: string): void;
  chip(session: DeliverySession, text: string): void;
  save(): void;
  /** What the release corridor recorded for a production commit (where the
   * Nuria release runs on this Mac): null when it recorded nothing for it,
   * "unavailable" when its records cannot be read here. Without this dep the
   * tag is the only proof, the time is unknown, and the report says so. */
  releaseRecord?(sha: string): Promise<ReleaseRecord | null | "unavailable">;
  /** A line for the server log (what changed and why). */
  log?(line: string): void;
}

/** Lookups shared across passes: a repository's tag, a compare, the
 * corridor's record of a commit (none yet is asked again later). */
export interface DeliveryCache {
  tags: Map<string, { sha: string | null; at: number }>;
  contains: Map<string, boolean>;
  records: Map<string, { record: ReleaseRecord | null | "unavailable"; at: number }>;
}

export function newDeliveryCache(): DeliveryCache {
  return { tags: new Map(), contains: new Map(), records: new Map() };
}

// ── what the release corridor recorded ───────────────────────────────────
// nuria-platform's release writes, in the clone it runs from
// (NURIA_PLATFORM_ROOT of its LaunchAgent), .deploy-history/post-release/
// <sha>/result.env (COMMIT, PREVIOUS_COMMIT, RESULT) for every commit it
// released, and .deploy-history/deploy-receipt-production.env (COMMIT,
// DEPLOYED_AT, REMOTE_TARGETS) for the last one; the next release keeps the
// receipt it replaced as post-release/<next>/previous-receipt.env. The tag
// only advances after the receipt and a certified post-release result.

/** The post-release results the corridor certifies (post-release-guard.mjs
 * exits EXIT.HEALTHY with these): the tag advances only after one of them. */
export const CERTIFIED_RESULTS = new Set(["healthy", "healthy_with_preexisting_failures"]);
/** A receipt of the commit but no post-release result: published, health not verified. */
export const NO_POST_RELEASE = "sem-verificacao";

export interface ReleaseRecord {
  /** The post-release verdict (healthy, rolled_back, …), or NO_POST_RELEASE. */
  result: string;
  /** The commit production ran before this release (result.env PREVIOUS_COMMIT). */
  previousCommit?: string;
  /** When its post-release check finished (ISO): the release was live by then. */
  finishedAt?: string;
  /** When it went live (ISO), when the receipt is this commit's. */
  deployedAt?: string;
  /** What it published ("worker:agenda", "pages:nuria-kb-pages"), when the receipt is this commit's. */
  targets?: string[];
}

/** KEY=value lines (the corridor's .env records). */
export function parseEnvRecord(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) out[match[1]!] = match[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/** The corridor's record of `sha`, from its post-release result and its
 * receipt (each counts only if it is that very commit's); null when it
 * recorded neither. */
export function releaseRecordFrom(resultEnv: string | null, receiptEnv: string | null, sha: string): ReleaseRecord | null {
  const parsedResult = resultEnv ? parseEnvRecord(resultEnv) : null;
  const result = parsedResult?.COMMIT === sha && parsedResult.RESULT ? parsedResult : null;
  const parsedReceipt = receiptEnv ? parseEnvRecord(receiptEnv) : null;
  const receipt = parsedReceipt?.COMMIT === sha ? parsedReceipt : null;
  if (!result && !receipt) return null;
  const deployedAt = receipt?.DEPLOYED_AT && !Number.isNaN(Date.parse(receipt.DEPLOYED_AT)) ? receipt.DEPLOYED_AT : undefined;
  const targets = receipt?.REMOTE_TARGETS ? [...new Set(receipt.REMOTE_TARGETS.split(",").map((each) => each.trim().split(":").slice(0, 2).join(":")).filter((each) => each.includes(":")))] : undefined;
  const previous = result?.PREVIOUS_COMMIT && /^[0-9a-f]{40}$/.test(result.PREVIOUS_COMMIT) ? result.PREVIOUS_COMMIT : undefined;
  const finishedAt = result?.FINISHED_AT && !Number.isNaN(Date.parse(result.FINISHED_AT)) ? result.FINISHED_AT : undefined;
  return { result: result?.RESULT ?? NO_POST_RELEASE, ...(finishedAt ? { finishedAt } : {}), ...(previous ? { previousCommit: previous } : {}), ...(deployedAt ? { deployedAt } : {}), ...(targets?.length ? { targets } : {}) };
}

/** The corridor's record of `sha` in its .deploy-history `dir`: the commit's
 * post-release result, and its receipt — the current one, or the one the
 * next release kept (post-release/<next>/previous-receipt.env). */
export async function readReleaseRecord(dir: string, sha: string): Promise<ReleaseRecord | null> {
  const read = (path: string) => readFile(path, "utf8").catch(() => null);
  const result = await read(join(dir, "post-release", sha, "result.env"));
  let receipt = await read(join(dir, "deploy-receipt-production.env"));
  if (!receipt || parseEnvRecord(receipt).COMMIT !== sha) {
    receipt = null;
    const later = await readdir(join(dir, "post-release")).catch(() => [] as string[]);
    for (const name of later) {
      if (!/^[0-9a-f]{40}$/.test(name) || name === sha) continue;
      const kept = await read(join(dir, "post-release", name, "previous-receipt.env"));
      if (kept && parseEnvRecord(kept).COMMIT === sha) { receipt = kept; break; }
    }
  }
  return releaseRecordFrom(result, receipt, sha);
}

/** The apps a PR changed: apps/<name>/… and web/… (as "web"). */
export function runtimeApps(paths: readonly string[]): string[] {
  const apps = new Set<string>();
  for (const path of paths) {
    const app = /^apps\/([^/]+)\//.exec(path)?.[1] ?? (path.startsWith("web/") ? "web" : null);
    if (app) apps.add(app);
  }
  return [...apps];
}

/** The apps a PR changed (apps/<name>/…, web/… as "web") that the release
 * published no target for. Scripts, docs and shared packages have none of
 * their own, so they are never "unpublished". */
export function unpublishedApps(paths: readonly string[], targets: readonly string[]): string[] {
  const names = targets.map((target) => target.slice(target.indexOf(":") + 1));
  const published = (app: string) => names.some((name) => name === app || name === `nuria-${app}` || name.startsWith(`${app}-`) || name.startsWith(`nuria-${app}-`));
  return runtimeApps(paths).filter((app) => !published(app));
}

/** For the owner, once per tag: a merged PR the tag contains that is not
 * announced, and why. */
export function heldReport(session: Pick<DeliverySession, "id" | "title">, pr: DeliveryPr, tagSha: string, why: string): string {
  return [
    `[Claude Code session ${session.id} ("${session.title}"): PR #${pr.number} (${pr.url}) is in ${PRODUCTION_TAG} (${tagSha.slice(0, 8)}) but is NOT announced as in production — ${why}.]`,
    "Do not tell the requester it is live, nor write it in the issue or the spreadsheet. Find out how the tag got there or how this change gets published; the server announces it once the corridor's record proves it.",
  ].join("\n");
}

/** One pass over the sessions. Sessions without PRs, repositories without
 * the production tag and PRs already reported cost nothing. */
export async function watchProductionDelivery(sessions: readonly DeliverySession[], deps: DeliveryDeps, cache: DeliveryCache): Promise<void> {
  const now = deps.now();
  let calls = 0;
  const budget = () => calls < DELIVERY_MAX_CALLS;
  const gh = async (args: string[]) => {
    calls += 1;
    return deps.gh(args);
  };
  const recentlyAnnounced = (pr: DeliveryPr) => pr.reportedAt !== undefined && now - pr.reportedAt < ROLLBACK_WATCH_MS && pr.productionTag !== undefined && pr.mergeSha !== undefined;
  for (const session of sessions) {
    // archived (as the announcement asks): only a rollback within the day is still followed
    const archived = session.status === "archived";
    if (archived && !(session.delivery?.slug && Object.values(session.delivery.prs).some(recentlyAnnounced))) continue;
    if (!session.delivery) {
      // "PRs #9329 e #9330" too: a plural report used to start no delivery at all; a PR
      // handed over to the session (claimedPrs) is followed even when its report names none
      if (!session.claimedPrs?.length && !/\/pull\/|\b(?:PRs?|pull requests?)\s*#\d/i.test(session.lastReport ?? "")) continue;
      session.delivery = { prs: {} };
    }
    const delivery = session.delivery;
    if (!delivery.slug) {
      try {
        delivery.slug = githubSlug(await deps.git(session.repo, ["remote", "get-url", "origin"])) ?? undefined;
      } catch { /* not a repository any more */ }
      if (!delivery.slug) continue;
      deps.save();
    }
    let added = false;
    // what the report names is a candidate; a PR handed over is the session's
    if (!archived) for (const link of [...prLinks(session.lastReport ?? "", delivery.slug), ...(session.claimedPrs ?? []).map((number) => ({ number, url: `https://github.com/${delivery.slug}/pull/${number}` }))]) {
      const known = delivery.prs[String(link.number)];
      const claimed = session.claimedPrs?.includes(link.number) === true;
      if (known) {
        if (claimed && !known.owned) { known.owned = "explicit"; added = true; }
        continue;
      }
      if (delivery.notPrs?.includes(link.number) || (delivery.notOwned?.includes(link.number) && !claimed)) continue;
      delivery.prs[String(link.number)] = { ...link, ...(claimed ? { owned: "explicit" as const } : {}) };
      added = true;
    }
    if (added) deps.save();
    let branches: Awaited<ReturnType<typeof sessionBranches>> | undefined;
    // "legacy" (recorded merged before ownership existed) is proof of nothing:
    // the real #N stayed the M session's that way, holding its archive
    // and due to announce "em produção" in its conversations (R10-followup
    // #3). Each one is checked once by its head branch against the session's
    // branches, worktrees and reflog; without that proof (or a hand-over) it
    // is not the session's. GitHub unavailable: asked again next time.
    for (const pr of archived ? [] : Object.values(delivery.prs).filter((each) => each.owned === "legacy" || (each.owned === undefined && each.state === "merged"))) {
      if (!budget()) break;
      try {
        const view = JSON.parse(await gh(["pr", "view", String(pr.number), "--repo", delivery.slug, "--json", "headRefName,headRefOid"])) as { headRefName?: string; headRefOid?: string };
        branches ??= await sessionBranches(session, deps.git);
        const owner = prOwnership({ number: pr.number, ...view }, branches, session.claimedPrs);
        if (owner) pr.owned = owner;
        // its worktree cannot be read now (gone, unmounted): nothing is decided, asked again next pass (INSP-J r1 #9)
        else if (!branches) continue;
        else {
          delete delivery.prs[String(pr.number)];
          delivery.notOwned = [...new Set([...(delivery.notOwned ?? []), pr.number])];
          deps.log?.(`[delivery] session ${session.id}: PR #${pr.number} (head ${view.headRefName ?? "?"}) was "legacy" and is not its own (${branches ? `branches: ${branches.names.join(", ") || "none"}` : "its worktree cannot be read"}): no longer followed for it`);
        }
        deps.save();
      } catch (error) {
        if (notAPullRequest(error)) {
          delete delivery.prs[String(pr.number)];
          delivery.notPrs = [...new Set([...(delivery.notPrs ?? []), pr.number])];
          deps.save();
        }
      }
    }
    // announced in the last day: a rollback would show as the tag moving back past it
    const announced = Object.values(delivery.prs).filter(recentlyAnnounced);
    if (!announced.length && (archived || !Object.values(delivery.prs).some((pr) => pr.state !== "closed" && pr.reportedAt === undefined))) continue;
    // The production tag, read at most once per DELIVERY_CHECK_MS per repository.
    let tag = cache.tags.get(session.repo);
    if (!tag || now - tag.at >= DELIVERY_CHECK_MS) {
      let sha: string | null = null;
      try {
        sha = parseLsRemoteTag(await deps.git(session.repo, ["ls-remote", "origin", `refs/tags/${PRODUCTION_TAG}`, `refs/tags/${PRODUCTION_TAG}^{}`]), PRODUCTION_TAG);
      } catch { /* offline: try again next time */ }
      tag = { sha, at: now };
      cache.tags.set(session.repo, tag);
    }
    if (!tag.sha) continue;
    const tagSha = tag.sha;
    // whether `sha` contains the PR's merge: null when it cannot be told now (no budget, GitHub down)
    const containsIn = async (pr: DeliveryPr, sha: string): Promise<boolean | null> => {
      const key = `${delivery.slug}:${pr.mergeSha}...${sha}`;
      const known = cache.contains.get(key);
      if (known !== undefined) return known;
      if (!budget()) return null;
      try {
        const status = (await gh(["api", `repos/${delivery.slug}/compare/${pr.mergeSha}...${sha}`, "--jq", ".status"])).trim();
        const contained = status === "ahead" || status === "identical";
        cache.contains.set(key, contained);
        return contained;
      } catch { return null; }
    };
    const containsMerge = (pr: DeliveryPr) => containsIn(pr, tagSha);
    // a tag that moved back past a merge already announced: that delivery is reopened
    for (const pr of announced) {
      if (pr.productionTag === tagSha) continue;
      const contained = await containsMerge(pr);
      if (contained === null) continue;
      if (contained) { pr.productionTag = tagSha; deps.save(); continue; }
      const was = pr.productionTag!;
      delete pr.reportedAt;
      delete pr.inProductionAt;
      delete pr.productionSince;
      delete pr.productionTag;
      deps.save();
      deps.chip(session, `saiu de produção: ${PRODUCTION_TAG} recuou para ${tagSha.slice(0, 8)}, sem o merge da PR #${pr.number}`);
      deps.report(session, `[Claude Code session ${session.id} ("${session.title}"): PR #${pr.number} saiu de produção — ${PRODUCTION_TAG} moved from ${was.slice(0, 8)} back to ${tagSha.slice(0, 8)}, which no longer contains its merge ${pr.mergeSha!.slice(0, 8)} (a rollback?).]\nTell whoever was told it is live, and correct the issue and the spreadsheet row. The server announces it again once a release brings it back.`);
    }
    const record = async (): Promise<ReleaseRecord | null | "unavailable" | undefined> => {
      if (!deps.releaseRecord) return undefined;
      const cached = cache.records.get(tagSha);
      // a record found stays found; none (or unreadable) is asked again every DELIVERY_CHECK_MS
      if (cached && ((cached.record !== null && cached.record !== "unavailable") || now - cached.at < DELIVERY_CHECK_MS)) return cached.record;
      let found: ReleaseRecord | null | "unavailable" = "unavailable";
      try { found = await deps.releaseRecord(tagSha); } catch { /* unreadable now: asked again later */ }
      cache.records.set(tagSha, { record: found, at: now });
      return found;
    };
    // held back: the bot hears it once per reason, a later tag with the same reason only logs
    const hold = (pr: DeliveryPr, key: string, chip: string, whyPt: string, why: string) => {
      if (pr.heldAt === key) { deps.log?.(`[delivery] session ${session.id}: PR #${pr.number} still held at ${tagSha.slice(0, 8)} (${key})`); return; }
      pr.heldAt = key;
      pr.heldWhy = whyPt;
      deps.save();
      deps.chip(session, chip);
      deps.report(session, heldReport(session, pr, tagSha, why));
    };
    const waiting = archived ? [] : Object.values(delivery.prs).filter((pr) => pr.state !== "closed" && pr.reportedAt === undefined);
    const delivered: DeliveryPr[] = [];
    for (const pr of waiting) {
      if (!budget()) break;
      // not yet proved the session's: neither followed nor announced until it is
      if (pr.owned === "legacy") continue;
      if (pr.state !== "merged" || pr.owned === undefined) {
        if (pr.checkedAt !== undefined && now - pr.checkedAt < DELIVERY_CHECK_MS) continue;
        pr.checkedAt = now;
        try {
          const view = JSON.parse(await gh(["pr", "view", String(pr.number), "--repo", delivery.slug, "--json", "state,mergeCommit,headRefName,headRefOid"])) as { state?: string; mergeCommit?: { oid?: string } | null; headRefName?: string; headRefOid?: string };
          if (pr.owned === undefined) {
            branches ??= await sessionBranches(session, deps.git);
            const owner = prOwnership({ number: pr.number, ...view }, branches, session.claimedPrs);
            if (!owner) {
              // named in its report, but another branch's: never this session's (unless handed over later)
              if (branches) {
                delete delivery.prs[String(pr.number)];
                delivery.notOwned = [...new Set([...(delivery.notOwned ?? []), pr.number])];
              }
              // its worktree cannot be read now: a candidate still, looked at again later
              deps.save();
              continue;
            }
            pr.owned = owner;
          }
          if (view.state === "MERGED" && view.mergeCommit?.oid) {
            pr.state = "merged";
            pr.mergeSha = view.mergeCommit.oid;
          } else {
            pr.state = view.state === "CLOSED" ? "closed" : "open";
          }
        } catch (error) {
          // an issue the report named next to its PRs: not a PR, for good
          if (notAPullRequest(error)) {
            delete delivery.prs[String(pr.number)];
            delivery.notPrs = [...new Set([...(delivery.notPrs ?? []), pr.number])];
          }
          /* else gh unavailable: next time */
        }
        deps.save();
        if (pr.state !== "merged" || pr.owned === undefined) continue;
      }
      const contained = await containsMerge(pr);
      if (!contained) continue;
      const proof = await record();
      const short = tagSha.slice(0, 8);
      if (proof === "unavailable") {
        hold(pr, "unavailable", `PR #${pr.number} na tag, mas não anunciada: não consegui ler os registros do corredor de release nesta máquina`, "registros do corredor ilegíveis nesta máquina", "the release corridor's records cannot be read on this machine (its LaunchAgent or .deploy-history), so nothing proves the release; this is the server's problem to fix, not a sign the tag was moved");
        continue;
      }
      if (proof === null) {
        hold(pr, "no-record", `PR #${pr.number} na tag, mas não anunciada: sem release registrado pelo corredor para ${short}`, `sem release registrado pelo corredor para ${short}`, `sem release registrado pelo corredor para ${short}: neither a receipt nor a post-release result of that commit, so the tag may have been moved outside the release`);
        continue;
      }
      if (proof && !CERTIFIED_RESULTS.has(proof.result)) {
        const noCheck = proof.result === NO_POST_RELEASE;
        hold(pr, `result:${proof.result}`, `PR #${pr.number} na tag, mas não anunciada: ${noCheck ? "sem verificação pós-release" : `pós-release ${proof.result}`} para ${short}`, noCheck ? `publicado sem verificação pós-release (${short})` : `pós-release ${proof.result} (${short})`, noCheck ? `the corridor published ${short} (receipt) but recorded no post-release health check of it` : `the corridor recorded the release of ${short} as ${proof.result}, which it does not certify`);
        continue;
      }
      if (proof) {
        // what the PR changed decides whether it needs a publish target: read before any announcement, never skipped
        if (pr.paths === undefined) {
          if (!budget()) break;
          try {
            pr.paths = (await gh(["pr", "view", String(pr.number), "--repo", delivery.slug, "--json", "files", "--jq", ".files[].path"])).split("\n").map((path) => path.trim()).filter(Boolean);
            deps.save();
          } catch { continue; /* unread now: asked again next pass, never announced unchecked */ }
        }
        const apps = runtimeApps(pr.paths);
        if (apps.length && !proof.targets) {
          hold(pr, "no-receipt", `PR #${pr.number} na tag, mas não anunciada: sem recibo de ${short} para conferir os alvos de ${apps.join(", ")}`, `sem recibo de ${short} para conferir os alvos de publicação`, `the corridor kept no receipt of ${short}, so the publish targets of ${apps.map((app) => `apps/${app}`).join(", ")} cannot be checked`);
          continue;
        }
        const missing = proof.targets ? unpublishedApps(pr.paths, proof.targets) : [];
        if (missing.length) {
          hold(pr, `unpublished:${missing.join(",")}`, `PR #${pr.number} mergeada, mas sem caminho de publicação para ${missing.join(", ")}: não anunciada`, `sem caminho de publicação para ${missing.join(", ")}`, `sem caminho de publicação: the release published no target for ${missing.map((app) => `apps/${app}`).join(", ")}, so the change is merged but not live`);
          continue;
        }
      }
      // the receipt's time is this release's; a merge production already ran before it went live earlier, at a time not known here
      let since: string | undefined;
      if (proof?.deployedAt) {
        const earlier = proof.previousCommit ? await containsIn(pr, proof.previousCommit) : false;
        if (earlier === null && !budget()) break;
        since = earlier === false ? productionTime(proof.deployedAt) : undefined;
      }
      pr.inProductionAt = now;
      if (since) pr.productionSince = since;
      else delete pr.productionSince;
      pr.productionTag = tagSha;
      pr.proof = proof ? "corridor" : "tag";
      delete pr.heldAt;
      delete pr.heldWhy;
      pr.reportedAt = now;
      delivered.push(pr);
    }
    if (!delivered.length) continue;
    deps.save();
    deps.chip(session, `${productionSinceText(delivered[0]!.productionSince)} (${delivered.map((pr) => `PR #${pr.number}`).join(", ")})`);
    deps.report(session, deliveryReport(session, delivered, tagSha));
  }
}

/** Why a session should not be archived yet: a PR of it still open, or
 * merged but not yet in the production tag. [] when nothing holds it, or
 * when GitHub cannot be asked (then `unknown` says so). */
export async function archiveBlockers(session: DeliverySession, deps: Pick<DeliveryDeps, "gh" | "git">): Promise<{ blockers: string[]; unknown: string[] }> {
  const blockers: string[] = [];
  const unknown: string[] = [];
  let slug = session.delivery?.slug;
  if (!slug) {
    try {
      slug = githubSlug(await deps.git(session.repo, ["remote", "get-url", "origin"])) ?? undefined;
    } catch { /* not a repository any more */ }
  }
  // a repository whose GitHub address cannot be read is not "nothing holds it"
  if (!slug) return { blockers, unknown: ["o repositório (não consegui ler o endereço do GitHub)"] };
  const numbers = new Map<number, DeliveryPr | undefined>();
  for (const pr of Object.values(session.delivery?.prs ?? {})) numbers.set(pr.number, pr);
  for (const number of session.claimedPrs ?? []) if (!numbers.has(number)) numbers.set(number, undefined);
  for (const link of prLinks(session.lastReport ?? "", slug)) if (!numbers.has(link.number) && !session.delivery?.notPrs?.includes(link.number) && !session.delivery?.notOwned?.includes(link.number)) numbers.set(link.number, undefined);
  let tagSha: string | null | undefined;
  let branches: Awaited<ReturnType<typeof sessionBranches>> | undefined;
  for (const [number, known] of [...numbers].slice(0, 6)) {
    if (known?.reportedAt !== undefined || known?.state === "closed") continue;
    // in the tag but not proved live: archiving would drop its announcement for good
    if (known?.heldAt !== undefined) {
      blockers.push(`a PR #${number} está na tag, mas não foi comprovada em produção (${known.heldWhy ?? known.heldAt})`);
      continue;
    }
    // "legacy" proves nothing (R10-followup #3): checked by branch like any named PR
    const owned = (known?.owned === "legacy" ? undefined : known?.owned) ?? (session.claimedPrs?.includes(number) ? "explicit" : undefined);
    let state = known?.state === "merged" && owned ? "MERGED" : "";
    let mergeSha = known?.mergeSha;
    if (!state) {
      try {
        const view = JSON.parse(await deps.gh(["pr", "view", String(number), "--repo", slug, "--json", "state,mergeCommit,headRefName,headRefOid"])) as { state?: string; mergeCommit?: { oid?: string } | null; headRefName?: string; headRefOid?: string };
        // only the session's own PRs hold it: one its report merely names is another's (R9-followup #2)
        if (!owned) {
          branches ??= await sessionBranches(session, deps.git);
          if (!prOwnership({ number, ...view }, branches)) {
            if (!branches && view.state !== "CLOSED") unknown.push(`PR #${number} (sem a worktree da sessão para conferir se é dela)`);
            continue;
          }
        }
        state = view.state ?? "";
        mergeSha = view.mergeCommit?.oid ?? undefined;
      } catch (error) {
        // an issue named in the report ("fecham a issue #U"): nothing to hold
        if (!notAPullRequest(error)) unknown.push(`PR #${number}`);
        continue;
      }
    }
    if (state === "OPEN") {
      blockers.push(`a PR #${number} ainda está aberta`);
      continue;
    }
    if (state !== "MERGED" || !mergeSha) continue;
    if (tagSha === undefined) {
      try {
        tagSha = parseLsRemoteTag(await deps.git(session.repo, ["ls-remote", "origin", `refs/tags/${PRODUCTION_TAG}`, `refs/tags/${PRODUCTION_TAG}^{}`]), PRODUCTION_TAG);
      } catch { tagSha = null; }
    }
    if (!tagSha) continue; // a repository without the production tag
    try {
      const status = (await deps.gh(["api", `repos/${slug}/compare/${mergeSha}...${tagSha}`, "--jq", ".status"])).trim();
      if (status !== "ahead" && status !== "identical") blockers.push(`a PR #${number} foi mergeada mas ainda não está em ${PRODUCTION_TAG}`);
      // in the tag but not announced yet (announced ones were skipped above): archived now, the
      // announcement would never come (14/10: #9555 archived ~5 min after the tag, before the pass).
      // Only a PR the delivery pass follows is promised one; another keeps the old rule.
      else if (known) blockers.push(`a PR #${number} está em ${PRODUCTION_TAG}, mas o servidor ainda não a anunciou em produção (o anúncio sai na próxima passada, a cada 10 min)`);
    } catch {
      unknown.push(`PR #${number} (produção)`);
    }
  }
  return { blockers, unknown };
}

/** A session failed or idle this long with a PR of its own open holds the
 * line (02/10: 9052/#9332 failed, 8204/#9350 and 9195/#9280 idle): it is
 * shown to its bot and to the Chief as one to resume (S-retomar). */
export const RESUME_AFTER_MS = 2 * 3_600_000;

/** A session to resume: since when it stopped, its open PRs, and why it
 * stopped — `why` in pt-BR for the bots, `kind` (and `detail`, the error or
 * the block as recorded) for a row in the reader's language. */
export interface ResumeNeed { since: number; prs: number[]; why: string; kind: "failed" | "blocked" | "idle"; detail?: string }

/** Why a session must be resumed now, or null: failed or idle for
 * RESUME_AFTER_MS with an own or handed-over PR not known merged or
 * closed. Never one the app opened in a wrong folder (a new one is
 * started), nor a create that never opened (the send refuses it: "comece
 * outra" — INSP-S r1 S-5), nor one archived or stopped. Nor, while the
 * server itself holds it, one parked behind a release (`resumeAfterTag`:
 * the server resumes it when the tag moves, at most RESUME_AFTER_MAX_MS
 * later), nor any while a production release is on its way on this Mac
 * (`hold.release`): resumed now, its ci:local would run against the
 * release (INSP-S r1 S-1, 8204/#9350 parked on 02/10). */
export function resumeNeeded(
  session: Pick<DeliverySession, "status" | "delivery" | "claimedPrs"> & { lastActivityAt: number; failedAt?: number; lastError?: string; blockedOn?: string; surface?: string; resumeAfterTag?: object; desktop?: { wrongFolder?: string; localId?: string } },
  now: number,
  hold: { release?: string | null } = {},
): ResumeNeed | null {
  if ((session.status !== "failed" && session.status !== "idle") || session.desktop?.wrongFolder) return null;
  if (session.surface === "app" && !session.desktop?.localId) return null;
  if (session.resumeAfterTag || hold.release) return null;
  const since = session.status === "failed" ? session.failedAt ?? session.lastActivityAt : session.lastActivityAt;
  if (now - since < RESUME_AFTER_MS) return null;
  const prs = openPrsOfSession(session);
  if (!prs.length) return null;
  const kind = session.status === "failed" ? "failed" : session.blockedOn ? "blocked" : "idle";
  const detail = kind === "failed" ? session.lastError : kind === "blocked" ? session.blockedOn : undefined;
  const why = kind === "failed"
    ? `falhou: ${sessionErrorPt(session.lastError ?? "sem motivo registrado")}`
    : kind === "blocked" ? `parada, bloqueada: ${session.blockedOn}` : "parada: o último turno terminou e nada a retomou";
  return { since, prs, why: why.replace(/\s+/g, " ").slice(0, 240), kind, ...(detail ? { detail: detail.replace(/\s+/g, " ").slice(0, 200) } : {}) };
}

/** A session's PRs (own or handed over) not known merged or closed, in order. */
export function openPrsOfSession(session: Pick<DeliverySession, "delivery" | "claimedPrs">): number[] {
  const done = new Set(Object.values(session.delivery?.prs ?? {}).filter((pr) => pr.state === "merged" || pr.state === "closed").map((pr) => pr.number));
  return prsOfSession(session).filter((number) => !done.has(number)).sort((a, b) => a - b);
}

/** A session's own PRs (by its branch, or handed to it), not merged or closed. */
export function ownPrs(session: Pick<DeliverySession, "delivery">): DeliveryPr[] {
  return Object.values(session.delivery?.prs ?? {}).filter((pr) => pr.owned !== undefined && pr.state !== "merged" && pr.state !== "closed");
}

/** The PRs a session may have left behind: its own (by branch, or handed
 * over) not merged or closed. A PR its report only names is not one of
 * them: "segue com a sessão X" for a PR X merely cited was the false
 * comfort of R9-followup #2. The PRs only GitHub knows (by its issue, by its
 * branch) are looked up by the caller (archived-outside.ts). */
export function prsOfSession(session: Pick<DeliverySession, "delivery" | "claimedPrs">): number[] {
  return [...new Set([...ownPrs(session).map((pr) => pr.number), ...(session.claimedPrs ?? [])])];
}
