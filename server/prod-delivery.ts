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
}

export interface CcDelivery {
  /** "owner/repo" of the session's origin, once known. */
  slug?: string;
  prs: Record<string, DeliveryPr>;
  /** Numbers a report named as PRs that GitHub says are not PRs (issues). */
  notPrs?: number[];
}

interface DeliverySession {
  id: string;
  title: string;
  repo: string;
  status: string;
  lastReport?: string;
  delivery?: CcDelivery;
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
    for (const link of prLinks(session.lastReport ?? "", delivery.slug)) {
      if (delivery.prs[String(link.number)] || delivery.notPrs?.includes(link.number)) continue;
      delivery.prs[String(link.number)] = { ...link };
      added = true;
    }
    if (added) deps.save();
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
      if (pr.state !== "merged") {
        if (pr.checkedAt !== undefined && now - pr.checkedAt < DELIVERY_CHECK_MS) continue;
        pr.checkedAt = now;
        try {
          const view = JSON.parse(await gh(["pr", "view", String(pr.number), "--repo", delivery.slug, "--json", "state,mergeCommit"])) as { state?: string; mergeCommit?: { oid?: string } | null };
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
        if (pr.state !== "merged") continue;
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
  for (const link of prLinks(session.lastReport ?? "", slug)) if (!numbers.has(link.number) && !session.delivery?.notPrs?.includes(link.number)) numbers.set(link.number, undefined);
  let tagSha: string | null | undefined;
  for (const [number, known] of [...numbers].slice(0, 6)) {
    if (known?.reportedAt !== undefined || known?.state === "closed") continue;
    let state = known?.state === "merged" ? "MERGED" : "";
    let mergeSha = known?.mergeSha;
    if (!state) {
      try {
        const view = JSON.parse(await deps.gh(["pr", "view", String(number), "--repo", slug, "--json", "state,mergeCommit"])) as { state?: string; mergeCommit?: { oid?: string } | null };
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

/** The PRs a session may have left behind: those it delivered and are not
 * merged or closed, and those its last report names. Only candidates: a
 * number may still be an issue ("Could not resolve to a PullRequest"), and
 * the PRs only GitHub knows (by its issue, by its branch) are looked up by
 * the caller (archived-outside.ts). */
export function prsOfSession(session: Pick<DeliverySession, "delivery"> & { lastReport?: string }, slug: string | null): number[] {
  return [...new Set([
    ...Object.values(session.delivery?.prs ?? {}).filter((pr) => pr.state !== "merged" && pr.state !== "closed").map((pr) => pr.number),
    ...(slug ? prLinks(session.lastReport ?? "", slug).map((link) => link.number) : []),
  ])];
}

/** Sessions idle past IDLE_WITH_PR_MS with known PRs not yet merged or
 * closed, not reported in the last day, oldest first. */
export function idleWithOpenPrs<T extends DeliverySession & { lastActivityAt: number; idleReportedAt?: number }>(sessions: readonly T[], now: number): Array<{ session: T; prs: number[] }> {
  return sessions
    .filter((session) => session.status === "idle" && now - session.lastActivityAt >= IDLE_WITH_PR_MS)
    .filter((session) => session.idleReportedAt === undefined || now - session.idleReportedAt >= IDLE_REPORT_EVERY_MS)
    .map((session) => ({ session, prs: Object.values(session.delivery?.prs ?? {}).filter((pr) => pr.state !== "merged" && pr.state !== "closed").map((pr) => pr.number) }))
    .filter((item) => item.prs.length > 0 && item.session.delivery?.slug)
    .sort((a, b) => a.session.lastActivityAt - b.session.lastActivityAt);
}
