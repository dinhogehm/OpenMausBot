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
  // sessions often report a PR only as "PR #9315" (a bare "#N" may be an issue, so it is not taken)
  for (const match of text.matchAll(/\b(?:PR|pull request)\s*#(\d{2,6})\b/gi)) {
    const number = Number(match[1]);
    if (!found.has(number)) found.set(number, `https://github.com/${slug}/pull/${number}`);
  }
  return [...found].map(([number, url]) => ({ url, number }));
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
      if (!/\/pull\/|\b(?:PR|pull request)\s*#\d/i.test(session.lastReport ?? "")) continue;
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
      if (delivery.prs[String(link.number)]) continue;
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
        } catch { /* gh unavailable: next time */ }
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
  for (const link of prLinks(session.lastReport ?? "", slug)) if (!numbers.has(link.number)) numbers.set(link.number, undefined);
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
      } catch {
        unknown.push(`PR #${number}`);
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
