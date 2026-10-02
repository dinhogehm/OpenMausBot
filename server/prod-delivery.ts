// "Delivered in production" closes a piece of work: the PR a Claude Code
// session opened was merged, and later a release moved the production tag
// past its merge commit. Nothing tells the owning bot when that happens, so
// the cycle (tell the requester, update the spreadsheet and the issue,
// archive the session) waits on someone remembering to look. The server
// looks instead: every DELIVERY_CHECK_MS it reads the PRs a session has
// reported, asks GitHub for their merge commit, reads the production tag
// with `git ls-remote` and, when the tag contains the merge (compare API),
// reports to the owner once: "em produção desde <hora>".
//
// State lives on the session (CcSession.delivery); lookups are cached and
// capped per pass so a ledger full of sessions stays within API limits.

/** The tag the release watcher moves when a release reaches production. */
export const PRODUCTION_TAG = "nuria-production-deployed";
/** How often one PR (or one repository's tag) is looked at again. */
export const DELIVERY_CHECK_MS = 10 * 60_000;
/** GitHub calls one pass may make, across all sessions. */
export const DELIVERY_MAX_CALLS = 8;

export interface DeliveryPr {
  url: string;
  number: number;
  state?: "open" | "merged" | "closed";
  mergeSha?: string;
  checkedAt?: number;
  /** When the production tag was seen containing it, and the tag's commit time. */
  inProductionAt?: number;
  productionSince?: string;
  reportedAt?: number;
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
  /** PRs the session was told to take over ("assuma a PR #9328"). */
  claimedPrs?: number[];
}

// ── whose PR it is ───────────────────────────────────────────────────────
// 01/10: the session of #9052 wrote "a trava … está na PR #9328, que ainda
// não está em main", and #9328 (another session's) became its PR: its
// archiving was held by it, its "em produção" would have gone to the wrong
// conversation, and liveOwnerOf would have named it #9328's live owner
// (R9-followup #2). A PR is a session's only by its head branch (the
// worktree's branch or the branch it pushed to) or by an explicit hand-over.

const NOT_A_WORK_BRANCH = new Set(["main", "master", "develop", "HEAD", ""]);

/** The branches a session works on — its worktree's checkout and the branch
 * it pushed to (`git push -u origin HEAD:fix/…` sets the upstream) — and its
 * HEAD commit. Null when its worktree cannot be read (none yet, or gone). */
/** The PRs handed to a session by the orders it was given before claimedPrs
 * existed, read from the bots' tool calls in the history (cc_session_send
 * to its id, or the cc_session_start that opened it, by its title): the
 * real "assuma a PR #9328" of 18:13 to the 29da943f (INSP-H r1 #1). */
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
 *   the 29da943f sat on a detached HEAD and worked on #9328 and #9341 in
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
  // the worktree was made for this very PR ("9330-gate-…" gating #9330)
  if (branches.folderNumber === pr.number) return "branch";
  return null;
}

/** The PRs an order HANDS to the session it is sent to: an imperative to
 * it ("assuma a PR #9328", "assuma as PRs #9328 e #9341", "você assume a PR
 * órfã https://…/pull/9289", "fique com a #9314") or "a PR #9328 é sua".
 * Not under a negation ("não assuma"), not about someone else ("a 29da943f
 * assume a PR #9328"), not a question ("a PR #9328 é sua?") (INSP-H r1 #7). */
export function claimedPrNumbers(text: string): number[] {
  const found = new Set<number>();
  const numbersIn = (span: string) => [...span.matchAll(/(?<!issue\s{0,3})#(\d{2,6})\b|\/pull\/(\d{1,7})\b/giu)].map((match) => Number(match[1] ?? match[2]));
  // sentences (a URL's dots are not an end), then clauses
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (sentence.trim().endsWith("?")) continue;
    for (const clause of sentence.split(/;\s*/)) {
      const take = /(?<![\p{L}])(?:(?:voc[êe]s?\s+)?(?:assuma|assumam)|voc[êe] assume|voc[êe]s assumem|pode assumir|fique com|fiquem com|pegue|toma conta d[ao]|take over|take ownership of)(?![\p{L}])/iu.exec(clause);
      if (take && !/(?<![\p{L}])(?:n[ãa]o|nunca|jamais)\s+(?:\S+\s+){0,1}$/iu.test(clause.slice(0, take.index))) {
        // what it takes: the list right after the verb ("#9328 e a #9341"), not "… e rode o gate da #9330"
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
  // sessions often report a PR only as "PR #9315", or a list after the
  // plural: "PRs #9329 e #9330", "PRs #1, #2 and #3". A bare "#N" may be an
  // issue, so only the number right after a singular "PR" counts ("PR #9328,
  // #9319 (issue)", "PR #9328/#9319" name an issue second), and a number in
  // a list tagged as an issue right after it ("#9319 (issue)", "#9319 é a
  // issue") leaves it. An issue named elsewhere in the sentence ("PRs #9329 e
  // #9330 fecham a issue #9326") does not cut the list: these are candidates,
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
 * right after it ("#9319 (issue)", "#9319 é a issue") leaves it. */
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

/** For the owner, once per session and pass: these PRs reached production. */
export function deliveryReport(session: Pick<DeliverySession, "id" | "title">, prs: DeliveryPr[], tagSha: string): string {
  return [
    `[Claude Code session ${session.id} ("${session.title}"): delivered in production — em produção desde ${prs.map((pr) => pr.productionSince ?? "?").sort()[0]}.]`,
    ...prs.map((pr) => `- PR #${pr.number} (${pr.url}): merge ${pr.mergeSha?.slice(0, 8)} is contained in ${PRODUCTION_TAG} (${tagSha.slice(0, 8)}), em produção desde ${pr.productionSince ?? "?"}.`),
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
  /** A line for the server log (what changed and why). */
  log?(line: string): void;
}

/** Lookups shared across passes: a repository's tag, a compare, a commit time. */
export interface DeliveryCache {
  tags: Map<string, { sha: string | null; at: number }>;
  contains: Map<string, boolean>;
  commitTimes: Map<string, string>;
}

export function newDeliveryCache(): DeliveryCache {
  return { tags: new Map(), contains: new Map(), commitTimes: new Map() };
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
  for (const session of sessions) {
    if (session.status === "archived") continue;
    if (!session.delivery) {
      // "PRs #9329 e #9330" too: a plural report used to start no delivery at all
      if (!/\/pull\/|\b(?:PRs?|pull requests?)\s*#\d/i.test(session.lastReport ?? "")) continue;
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
    for (const link of [...prLinks(session.lastReport ?? "", delivery.slug), ...(session.claimedPrs ?? []).map((number) => ({ number, url: `https://github.com/${delivery.slug}/pull/${number}` }))]) {
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
    // the real #9328 stayed the 9052 session's that way, holding its archive
    // and due to announce "em produção" in its conversations (R10-followup
    // #3). Each one is checked once by its head branch against the session's
    // branches, worktrees and reflog; without that proof (or a hand-over) it
    // is not the session's. GitHub unavailable: asked again next time.
    for (const pr of Object.values(delivery.prs).filter((each) => each.owned === "legacy" || (each.owned === undefined && each.state === "merged"))) {
      if (!budget()) break;
      try {
        const view = JSON.parse(await gh(["pr", "view", String(pr.number), "--repo", delivery.slug, "--json", "headRefName,headRefOid"])) as { headRefName?: string; headRefOid?: string };
        branches ??= await sessionBranches(session, deps.git);
        const owner = prOwnership({ number: pr.number, ...view }, branches, session.claimedPrs);
        if (owner) pr.owned = owner;
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
    const waiting = Object.values(delivery.prs).filter((pr) => pr.state !== "closed" && pr.reportedAt === undefined);
    if (!waiting.length) continue;
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
    const delivered: DeliveryPr[] = [];
    for (const pr of waiting) {
      if (!budget()) break;
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
      const key = `${delivery.slug}:${pr.mergeSha}...${tag.sha}`;
      let contained = cache.contains.get(key);
      if (contained === undefined) {
        if (!budget()) break;
        try {
          const status = (await gh(["api", `repos/${delivery.slug}/compare/${pr.mergeSha}...${tag.sha}`, "--jq", ".status"])).trim();
          contained = status === "ahead" || status === "identical";
          cache.contains.set(key, contained);
        } catch { continue; }
      }
      if (!contained) continue;
      let since = cache.commitTimes.get(tag.sha);
      if (since === undefined && budget()) {
        try {
          since = productionTime((await gh(["api", `repos/${delivery.slug}/commits/${tag.sha}`, "--jq", ".commit.committer.date"])).trim());
          cache.commitTimes.set(tag.sha, since);
        } catch { /* the time is a nicety */ }
      }
      pr.inProductionAt = now;
      pr.productionSince = since ?? productionTime(new Date(now).toISOString());
      pr.reportedAt = now;
      delivered.push(pr);
    }
    if (!delivered.length) continue;
    deps.save();
    deps.chip(session, `em produção desde ${delivered[0]!.productionSince} (${delivered.map((pr) => `PR #${pr.number}`).join(", ")})`);
    deps.report(session, deliveryReport(session, delivered, tag.sha));
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
        // an issue named in the report ("fecham a issue #9326"): nothing to hold
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
    } catch {
      unknown.push(`PR #${number} (produção)`);
    }
  }
  return { blockers, unknown };
}

/** A session idle this long with a PR of it still open may be waiting for
 * a word nobody sends ("fico parado até o seu aviso"). */
export const IDLE_WITH_PR_MS = 6 * 3_600_000;
const IDLE_REPORT_EVERY_MS = 24 * 3_600_000;

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

/** Sessions idle past IDLE_WITH_PR_MS with their own PRs not yet merged or
 * closed, not reported in the last day, oldest first. */
export function idleWithOpenPrs<T extends DeliverySession & { lastActivityAt: number; idleReportedAt?: number }>(sessions: readonly T[], now: number): Array<{ session: T; prs: number[] }> {
  return sessions
    .filter((session) => session.status === "idle" && now - session.lastActivityAt >= IDLE_WITH_PR_MS)
    .filter((session) => session.idleReportedAt === undefined || now - session.idleReportedAt >= IDLE_REPORT_EVERY_MS)
    .map((session) => ({ session, prs: ownPrs(session).map((pr) => pr.number) }))
    .filter((item) => item.prs.length > 0 && item.session.delivery?.slug)
    .sort((a, b) => a.session.lastActivityAt - b.session.lastActivityAt);
}
