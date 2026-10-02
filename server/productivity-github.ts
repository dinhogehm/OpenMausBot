// GitHub side of the productivity report (lot V): PRs, issues, the open PRs'
// merge gate, the production tag, the old production deployments and the
// commits between two releases — read-only, through the `gh` CLI the owner
// already signed in with. Never a write: every call is `gh api` GET or a
// GraphQL query (no mutation is ever built here).
//
// Incremental: PRs and issues are walked newest-updated first; the first pass
// goes to the bottom (resumable across rate limits by its cursor), later
// passes stop at the last watermark. A pass checks the GraphQL budget on
// every page and stops early when it runs low, leaving the cursor for the
// next sync. Nothing here blocks the server: every call is an async child.
import { execFile } from "node:child_process";
import { PRODUCTION_REPO, type IssuePriority, type IssueType } from "../shared/productivity.ts";
import { PRODUCTION_TAG } from "./prod-delivery.ts";

export type GhRunner = (args: string[]) => Promise<string>;

export const GATE_CONTEXT = "nuria/local-merge-gate";
/** Below this many GraphQL points (or REST calls) left, a sync stops and waits for the reset. */
export const RATE_FLOOR = 250;
const PAGE = 100;
/** Overlap kept under the watermark: an item updated while a page was read is read again, never missed. */
const WATERMARK_SLACK_MS = 10 * 60_000;
const COMPARES_PER_SYNC = 40;

export type GateState = "success" | "pending" | "failure" | "missing";

export interface GhPr {
  number: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
  closedAt: number | null;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  base: string;
  head: string;
  mergeSha: string | null;
  /** Issues the PR closes ("Closes #N", as GitHub resolves it). */
  closes: number[];
  labels: string[];
}

export interface GhIssue {
  number: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  state: "OPEN" | "CLOSED";
  /** COMPLETED, NOT_PLANNED, DUPLICATE, REOPENED or null. */
  stateReason: string | null;
  labels: string[];
}

export interface GhOpenPr { number: number; title: string; createdAt: number; draft: boolean; base: string; headSha: string | null; gate: GateState; gateAt: number | null }

export interface GhDeployment {
  id: number;
  sha: string;
  createdAt: number;
  successAt: number | null;
  /** The deployment ended in failure/error (never succeeded). */
  failedAt?: number | null;
  final: boolean;
}

export interface WalkState { watermark: number | null; cursor: string | null; complete: boolean; passStartedAt: number | null; newest: number | null }

export interface GhCache {
  version: 1;
  repo: string;
  prs: Record<string, GhPr>;
  issues: Record<string, GhIssue>;
  prWalk: WalkState;
  issueWalk: WalkState;
  openPrs: GhOpenPr[];
  openPrsAt: number | null;
  tag: { sha: string | null; checkedAt: number | null };
  deployments: GhDeployment[];
  deploymentsAt: number | null;
  /** "base...head" → the commits it adds (full shas), immutable once read. */
  compares: Record<string, string[]>;
  syncedAt: number | null;
}

export function emptyGhCache(repo = PRODUCTION_REPO): GhCache {
  const walk = (): WalkState => ({ watermark: null, cursor: null, complete: false, passStartedAt: null, newest: null });
  return { version: 1, repo, prs: {}, issues: {}, prWalk: walk(), issueWalk: walk(), openPrs: [], openPrsAt: null, tag: { sha: null, checkedAt: null }, deployments: [], deploymentsAt: null, compares: {}, syncedAt: null };
}

/** Run `gh` without a shell; output capped, a slow call cut at 90 s. */
export const execGh: GhRunner = (args) => new Promise((resolve, reject) => {
  execFile("gh", args, { timeout: 90_000, maxBuffer: 96 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (error, stdout, stderr) => {
    if (error) reject(new Error((String(stderr || "").trim() || error.message).slice(0, 400)));
    else resolve(String(stdout));
  });
});

// ── labels ──────────────────────────────────────────────────────────────────

/** type:bug and type:hotfix are bugs; type:improvement, type:feature; the rest "other". */
export function issueType(labels: readonly string[]): IssueType {
  const set = new Set(labels.map((label) => label.toLowerCase()));
  if (set.has("type:bug") || set.has("type:hotfix") || set.has("bug")) return "bug";
  if (set.has("type:improvement") || set.has("improvement") || set.has("enhancement")) return "improvement";
  if (set.has("type:feature") || set.has("feature")) return "feature";
  return "other";
}

/** priority:p0..p3; the older scale maps critical→P0, high→P1, medium→P2, low→P3. */
export function issuePriority(labels: readonly string[]): IssuePriority {
  const set = new Set(labels.map((label) => label.toLowerCase()));
  if (set.has("priority:p0") || set.has("priority:critical")) return "p0";
  if (set.has("priority:p1") || set.has("priority:high")) return "p1";
  if (set.has("priority:p2") || set.has("priority:medium")) return "p2";
  if (set.has("priority:p3") || set.has("priority:low")) return "p3";
  return "none";
}

/** A PR that only publishes others (scripts/release-carrier.sh): how the code ships, not new work. */
export const isCarrier = (pr: Pick<GhPr, "head" | "title">): boolean =>
  /(^|\/)release-carrier/i.test(pr.head) || /^chore\(release\):\s*carrier/i.test(pr.title);

/** Issue numbers a PR names in its branch (fix/9331-…, claude/x-9195): the
 * team's convention when the body has no "Closes #N". Only numbers that are
 * issues of the repo count (checked by the caller). */
export function branchIssueNumbers(head: string): number[] {
  // a zero-padded number is a migration id (fix/0608-tenant-…), never an issue
  return [...new Set([...head.matchAll(/(?:^|[/_-])([1-9]\d{2,5})(?=$|[/_-])/g)].map((match) => Number(match[1])))];
}

// ── GraphQL ─────────────────────────────────────────────────────────────────

const PR_FIELDS = "number title createdAt updatedAt mergedAt closedAt state isDraft baseRefName headRefName mergeCommit { oid } closingIssuesReferences(first: 10) { nodes { number } } labels(first: 20) { nodes { name } }";
const ISSUE_FIELDS = "number title createdAt updatedAt closedAt state stateReason labels(first: 20) { nodes { name } }";
const RATE = "rateLimit { remaining resetAt }";

export const PRS_QUERY = `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { pullRequests(first: ${PAGE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { ${PR_FIELDS} } } } ${RATE} }`;
export const ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { issues(first: ${PAGE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { ${ISSUE_FIELDS} } } } ${RATE} }`;
export const OPEN_PRS_QUERY = `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { pullRequests(first: ${PAGE}, after: $after, states: OPEN, orderBy: { field: CREATED_AT, direction: ASC }) { pageInfo { hasNextPage endCursor } nodes { number title createdAt isDraft baseRefName commits(last: 1) { nodes { commit { oid status { context(name: "${GATE_CONTEXT}") { state createdAt } } } } } } } } ${RATE} }`;

const ms = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

type Json = Record<string, any>;

export class RateLimited extends Error {
  readonly resetAt: number;
  constructor(resetAt: number) {
    super("GitHub rate limit low: waiting for the reset");
    this.resetAt = resetAt;
  }
}

async function graphql(gh: GhRunner, query: string, vars: Record<string, string | null>): Promise<Json> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  // -f: raw strings (-F would read a value starting with "@" as a file)
  for (const [key, value] of Object.entries(vars)) if (value !== null) args.push("-f", `${key}=${value}`);
  const out = JSON.parse(await gh(args)) as Json;
  if (Array.isArray(out.errors) && out.errors.length) throw new Error(`GitHub: ${String(out.errors[0]?.message ?? "query failed").slice(0, 300)}`);
  return out.data ?? {};
}

export function parsePr(node: Json): GhPr | null {
  if (!node || typeof node.number !== "number") return null;
  return {
    number: node.number,
    title: String(node.title ?? ""),
    createdAt: ms(node.createdAt) ?? 0,
    updatedAt: ms(node.updatedAt) ?? 0,
    mergedAt: ms(node.mergedAt),
    closedAt: ms(node.closedAt),
    state: node.state === "MERGED" ? "MERGED" : node.state === "CLOSED" ? "CLOSED" : "OPEN",
    draft: Boolean(node.isDraft),
    base: String(node.baseRefName ?? ""),
    head: String(node.headRefName ?? ""),
    mergeSha: typeof node.mergeCommit?.oid === "string" ? node.mergeCommit.oid : null,
    closes: (node.closingIssuesReferences?.nodes ?? []).map((issue: Json) => issue?.number).filter((n: unknown): n is number => typeof n === "number"),
    labels: (node.labels?.nodes ?? []).map((label: Json) => String(label?.name ?? "")).filter(Boolean),
  };
}

export function parseIssue(node: Json): GhIssue | null {
  if (!node || typeof node.number !== "number") return null;
  return {
    number: node.number,
    title: String(node.title ?? ""),
    createdAt: ms(node.createdAt) ?? 0,
    updatedAt: ms(node.updatedAt) ?? 0,
    closedAt: ms(node.closedAt),
    state: node.state === "CLOSED" ? "CLOSED" : "OPEN",
    stateReason: typeof node.stateReason === "string" ? node.stateReason : null,
    labels: (node.labels?.nodes ?? []).map((label: Json) => String(label?.name ?? "")).filter(Boolean),
  };
}

export function parseGate(node: Json): { headSha: string | null; gate: GateState; gateAt: number | null } {
  const commit = node?.commits?.nodes?.[0]?.commit;
  const context = commit?.status?.context;
  const state = typeof context?.state === "string" ? context.state.toUpperCase() : null;
  const gate: GateState = state === "SUCCESS" ? "success" : state === "PENDING" || state === "EXPECTED" ? "pending" : state === "FAILURE" || state === "ERROR" ? "failure" : "missing";
  return { headSha: typeof commit?.oid === "string" ? commit.oid : null, gate, gateAt: ms(context?.createdAt) };
}

export interface SyncProgress { phase: string; pages: number; rateRemaining: number | null; rateResetAt: number | null }

/** One walk over PRs or issues (see the header). Returns when caught up,
 * at the bottom, or out of budget (throws RateLimited after saving progress). */
async function walk<T extends { number: number; updatedAt: number }>(input: {
  gh: GhRunner; repo: string; query: string; field: "pullRequests" | "issues"; state: WalkState;
  parse: (node: Json) => T | null; store: Record<string, T>; progress: SyncProgress; maxPages: number;
}): Promise<void> {
  const [owner, name] = input.repo.split("/");
  const state = input.state;
  if (state.passStartedAt === null) { state.passStartedAt = Date.now(); state.newest = null; }
  const stopBelow = state.complete && state.watermark !== null ? state.watermark - WATERMARK_SLACK_MS : null;
  let pages = 0;
  for (;;) {
    const data = await graphql(input.gh, input.query, { owner: owner!, name: name!, after: state.cursor });
    input.progress.pages += 1;
    const rate = data.rateLimit as Json | undefined;
    if (rate && typeof rate.remaining === "number") {
      input.progress.rateRemaining = rate.remaining;
      input.progress.rateResetAt = ms(rate.resetAt);
    }
    const connection = data.repository?.[input.field] as Json | undefined;
    if (!connection) throw new Error(`GitHub returned no ${input.field} for ${input.repo}`);
    let reachedWatermark = false;
    for (const node of connection.nodes ?? []) {
      const item = input.parse(node);
      if (!item) continue;
      if (stopBelow !== null && item.updatedAt < stopBelow) { reachedWatermark = true; break; }
      input.store[String(item.number)] = item;
      state.newest = Math.max(state.newest ?? 0, item.updatedAt);
    }
    const more = Boolean(connection.pageInfo?.hasNextPage) && !reachedWatermark;
    state.cursor = more ? String(connection.pageInfo.endCursor) : null;
    if (!more) {
      // the pass is over: what it saw is the new watermark
      state.complete = true;
      state.watermark = Math.max(state.watermark ?? 0, state.newest ?? 0) || state.watermark;
      state.passStartedAt = null;
      return;
    }
    pages += 1;
    if ((input.progress.rateRemaining ?? Infinity) < RATE_FLOOR) throw new RateLimited(input.progress.rateResetAt ?? Date.now() + 15 * 60_000);
    if (pages >= input.maxPages) return; // continue next sync, from the cursor
  }
}

/** Open PRs and the state of the merge gate on each head. */
export async function readOpenPrs(gh: GhRunner, repo: string, progress: SyncProgress): Promise<GhOpenPr[]> {
  const [owner, name] = repo.split("/");
  const open: GhOpenPr[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const data = await graphql(gh, OPEN_PRS_QUERY, { owner: owner!, name: name!, after });
    progress.pages += 1;
    const rate = data.rateLimit as Json | undefined;
    if (rate && typeof rate.remaining === "number") { progress.rateRemaining = rate.remaining; progress.rateResetAt = ms(rate.resetAt); }
    const connection = data.repository?.pullRequests as Json | undefined;
    for (const node of connection?.nodes ?? []) {
      if (typeof node?.number !== "number") continue;
      open.push({ number: node.number, title: String(node.title ?? ""), createdAt: ms(node.createdAt) ?? 0, draft: Boolean(node.isDraft), base: String(node.baseRefName ?? ""), ...parseGate(node) });
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = String(connection.pageInfo.endCursor);
  }
  return open;
}

/** The production tag's commit on GitHub (a lightweight tag: the ref points at the commit). */
export async function readTagSha(gh: GhRunner, repo: string): Promise<string | null> {
  const out = JSON.parse(await gh(["api", `repos/${repo}/git/ref/tags/${PRODUCTION_TAG}`])) as Json;
  const object = out?.object as Json | undefined;
  if (typeof object?.sha !== "string") return null;
  if (object.type === "tag") {
    const tag = JSON.parse(await gh(["api", `repos/${repo}/git/tags/${object.sha}`])) as Json;
    return typeof tag?.object?.sha === "string" ? tag.object.sha : null;
  }
  return object.sha;
}

/** Production deployments GitHub recorded (the Actions era, before the local release). */
export async function readDeployments(gh: GhRunner, repo: string, known: readonly GhDeployment[]): Promise<GhDeployment[]> {
  const byId = new Map(known.map((deployment) => [deployment.id, deployment]));
  const out: GhDeployment[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const list = JSON.parse(await gh(["api", `repos/${repo}/deployments?environment=production&per_page=100&page=${page}`])) as Json[];
    if (!Array.isArray(list) || !list.length) break;
    for (const item of list) {
      if (typeof item?.id !== "number" || typeof item?.sha !== "string") continue;
      // a hosting integration's preview of one app (vercel[bot]) is not the platform's release
      if (String(item.creator?.login ?? "").endsWith("[bot]")) continue;
      const cached = byId.get(item.id);
      if (cached?.final) { out.push(cached); continue; }
      const statuses = JSON.parse(await gh(["api", `repos/${repo}/deployments/${item.id}/statuses?per_page=100`])) as Json[];
      const states = Array.isArray(statuses) ? statuses : [];
      const success = states.find((status) => status?.state === "success");
      const failure = states.find((status) => status?.state === "failure" || status?.state === "error");
      const final = states.some((status) => ["success", "failure", "error", "inactive"].includes(String(status?.state)));
      out.push({ id: item.id, sha: item.sha, createdAt: ms(item.created_at) ?? 0, successAt: success ? ms(success.created_at) : null, failedAt: !success && failure ? ms(failure.created_at) : null, final });
    }
    if (list.length < 100) break;
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** The commits `head` adds over `base` (full shas), every page. */
export async function readCompare(gh: GhRunner, repo: string, base: string, head: string): Promise<string[]> {
  const shas: string[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const out = JSON.parse(await gh(["api", `repos/${repo}/compare/${base}...${head}?per_page=100&page=${page}`])) as Json;
    const commits = Array.isArray(out?.commits) ? out.commits : [];
    for (const commit of commits) if (typeof commit?.sha === "string") shas.push(commit.sha);
    const total = typeof out?.total_commits === "number" ? out.total_commits : shas.length;
    if (!commits.length || shas.length >= total) break;
  }
  return shas;
}

/** REST budget left (the rate_limit call itself is free). */
export async function readRestBudget(gh: GhRunner): Promise<{ remaining: number; resetAt: number } | null> {
  try {
    const out = JSON.parse(await gh(["api", "rate_limit"])) as Json;
    const core = out?.resources?.core;
    if (typeof core?.remaining !== "number") return null;
    return { remaining: core.remaining, resetAt: (Number(core.reset) || 0) * 1000 };
  } catch {
    return null;
  }
}

/** One sync of everything GitHub holds for the report, except release
 * contents (syncCompares, once the deployments are known). Mutates `cache`
 * as it goes, so an interruption keeps what was read. */
export async function syncGithub(input: {
  gh: GhRunner; cache: GhCache; now: number;
  progress: SyncProgress; onPhase?: (phase: string) => void; maxPages?: number;
}): Promise<void> {
  const { gh, cache, progress } = input;
  const maxPages = input.maxPages ?? 120;
  const phase = (name: string) => { progress.phase = name; input.onPhase?.(name); };
  phase("pull-requests");
  await walk({ gh, repo: cache.repo, query: PRS_QUERY, field: "pullRequests", state: cache.prWalk, parse: parsePr, store: cache.prs, progress, maxPages });
  phase("issues");
  await walk({ gh, repo: cache.repo, query: ISSUES_QUERY, field: "issues", state: cache.issueWalk, parse: parseIssue, store: cache.issues, progress, maxPages });
  phase("open-pull-requests");
  cache.openPrs = await readOpenPrs(gh, cache.repo, progress);
  cache.openPrsAt = input.now;
  phase("tag");
  cache.tag = { sha: await readTagSha(gh, cache.repo), checkedAt: input.now };
  const budget = await readRestBudget(gh);
  if (budget && budget.remaining < RATE_FLOOR) throw new RateLimited(budget.resetAt);
  if (!cache.deploymentsAt || input.now - cache.deploymentsAt > 24 * 3_600_000) {
    phase("deployments");
    cache.deployments = await readDeployments(gh, cache.repo, cache.deployments);
    cache.deploymentsAt = input.now;
  }
  cache.syncedAt = input.now;
}

/** Read the commits of the release ranges still unknown, newest first, at
 * most COMPARES_PER_SYNC per sync. `pairs` are (base, head) shas. */
export async function syncCompares(input: { gh: GhRunner; cache: GhCache; pairs: ReadonlyArray<{ base: string; head: string }>; onPhase?: (phase: string) => void }): Promise<number> {
  input.onPhase?.("release-contents");
  let compared = 0;
  for (const pair of input.pairs) {
    const key = `${pair.base}...${pair.head}`;
    if (input.cache.compares[key]) continue;
    if (compared >= COMPARES_PER_SYNC) break;
    input.cache.compares[key] = await readCompare(input.gh, input.cache.repo, pair.base, pair.head);
    compared += 1;
  }
  return compared;
}
