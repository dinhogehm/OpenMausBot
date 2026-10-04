// The live side of "Esteira" (lot Z): what the productivity collector does
// not keep fresh enough for a board someone is looking at. The open PRs and
// the PRs merged lately (with GitHub's merge state — BEHIND, DIRTY — and the
// merge gate on each head) are read by one GraphQL query through `gh`, at
// most every LIVE_EVERY_MS and only when the board is asked for; the
// release log is re-read when its files changed; the ci:local receipts are
// read from the sessions' worktrees when their file changed. Read-only
// everywhere: a query, never a mutation; files, never written.
//
// A request never waits on GitHub: the board is built from what is held now,
// a refresh starts in the background, and the next poll sees it. Nothing is
// read while nobody asks for the board. It carries an ETag over its content,
// so a poll that finds nothing new is a 304.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BOARD_STAGES, type PipelineBoard } from "../shared/pipeline-board.ts";
import { PRODUCTION_REPO } from "../shared/productivity.ts";
import { buildPipelineBoard, parseReceipt, sessionPrs, type BoardInputs, type BoardOwnerPending, type BoardSession, type LivePr } from "./pipeline-board.ts";
import { execGh, explicitReferences, GATE_CONTEXT, parseGate, type GhCache, type GhRunner } from "./productivity-github.ts";
import type { ReleaseRun } from "./productivity-release-log.ts";

/** How often the open PRs are read again while someone looks at the board. */
export const LIVE_EVERY_MS = 2 * 60_000;
/** The release log is checked for changes at most this often. */
export const LOGS_EVERY_MS = 30_000;

const PR_FIELDS = `number title body createdAt updatedAt mergedAt state isDraft baseRefName headRefName mergeStateStatus mergeCommit { oid message } closingIssuesReferences(first: 10) { nodes { number } } labels(first: 20) { nodes { name } } commits(last: 1) { nodes { commit { oid status { context(name: "${GATE_CONTEXT}") { state createdAt } } } } }`;
export const BOARD_PRS_QUERY = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { open: pullRequests(first: 100, states: OPEN, orderBy: { field: CREATED_AT, direction: ASC }) { nodes { ${PR_FIELDS} } } merged: pullRequests(first: 50, states: MERGED, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } } } rateLimit { remaining resetAt } }`;

type Json = Record<string, any>;
const ms = (value: unknown): number | null => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);

/** One PR node of BOARD_PRS_QUERY; the body is read for its explicit references and dropped. */
export function parseLivePr(node: Json): LivePr | null {
  if (!node || typeof node.number !== "number") return null;
  const gate = parseGate(node);
  return {
    number: node.number,
    title: String(node.title ?? ""),
    createdAt: ms(node.createdAt) ?? 0,
    updatedAt: ms(node.updatedAt) ?? 0,
    mergedAt: ms(node.mergedAt),
    state: node.state === "MERGED" ? "MERGED" : node.state === "CLOSED" ? "CLOSED" : "OPEN",
    draft: Boolean(node.isDraft),
    base: String(node.baseRefName ?? ""),
    head: String(node.headRefName ?? ""),
    headSha: gate.headSha,
    mergeSha: typeof node.mergeCommit?.oid === "string" ? node.mergeCommit.oid : null,
    gate: gate.gate,
    gateAt: gate.gateAt,
    mergeState: typeof node.mergeStateStatus === "string" && node.mergeStateStatus !== "UNKNOWN" ? node.mergeStateStatus : null,
    closes: (node.closingIssuesReferences?.nodes ?? []).map((issue: Json) => issue?.number).filter((n: unknown): n is number => typeof n === "number"),
    refs: [...new Set([...explicitReferences(node.body), ...explicitReferences(node.mergeCommit?.message)])].filter((n) => n !== node.number),
    labels: (node.labels?.nodes ?? []).map((label: Json) => String(label?.name ?? "")).filter(Boolean),
  };
}

export async function readBoardPrs(gh: GhRunner, repo: string): Promise<{ open: LivePr[]; merged: LivePr[] }> {
  const [owner, name] = repo.split("/");
  const out = JSON.parse(await gh(["api", "graphql", "-f", `query=${BOARD_PRS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`])) as Json;
  if (Array.isArray(out.errors) && out.errors.length) throw new Error(`GitHub: ${String(out.errors[0]?.message ?? "query failed").slice(0, 300)}`);
  const repository = out.data?.repository as Json | undefined;
  if (!repository) throw new Error(`GitHub returned no repository ${repo}`);
  const parse = (nodes: unknown) => (Array.isArray(nodes) ? nodes : []).map(parseLivePr).filter((pr): pr is LivePr => pr !== null);
  return { open: parse(repository.open?.nodes), merged: parse(repository.merged?.nodes) };
}

export interface BoardSourceSnapshot {
  github: GhCache | null;
  runs: ReleaseRun[];
  logCoverage: { from: number | null; to: number | null };
}

export interface PipelineBoardDeps {
  enabled: boolean;
  repo?: string;
  gh?: GhRunner;
  now?: () => number;
  /** The productivity collector's cache, as it is now. */
  source: () => BoardSourceSnapshot;
  /** Re-read the release log if one of its files changed. */
  refreshLogs?: () => Promise<void>;
  sessions: () => readonly BoardSession[];
  ownerPending: () => readonly BoardOwnerPending[];
  botNames: () => ReadonlyMap<string, string>;
  releaseHold: () => string | null;
  admission: () => BoardInputs["admission"];
  /** A small file's text, or null (tests replace it). */
  readText?: (path: string) => { text: string; stamp: string } | null;
  log?: (line: string) => void;
}

const readText = (path: string): { text: string; stamp: string } | null => {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    return { text: readFileSync(path, "utf8"), stamp: `${stat.mtimeMs}:${stat.size}` };
  } catch {
    return null;
  }
};

export class PipelineBoardService {
  private readonly deps: PipelineBoardDeps;
  private readonly gh: GhRunner;
  private readonly now: () => number;
  private readonly repo: string;
  private live: BoardInputs["live"] = null;
  private liveError: string | null = null;
  private liveTriedAt = 0;
  private liveInflight: Promise<void> | null = null;
  private logsAt = 0;
  private logsInflight: Promise<void> | null = null;
  private readonly receipts = new Map<string, { stamp: string; value: { commit: string; finishedAt: number | null } | null }>();

  constructor(deps: PipelineBoardDeps) {
    this.deps = deps;
    this.gh = deps.gh ?? execGh;
    this.now = deps.now ?? Date.now;
    this.repo = deps.repo ?? PRODUCTION_REPO;
  }

  /** The board as the data stands now; starts the refreshes it is due. */
  board(): PipelineBoard {
    const now = this.now();
    if (!this.deps.enabled) return disabledBoard(now, this.repo);
    this.kick(now);
    const source = this.deps.source();
    const sessions = this.deps.sessions();
    return buildPipelineBoard({
      now, repo: this.repo,
      github: source.github,
      live: this.live,
      liveError: this.liveError,
      runs: source.runs, logCoverage: source.logCoverage,
      sessions, ownerPending: this.deps.ownerPending(), botNames: this.deps.botNames(),
      releaseHold: this.deps.releaseHold(),
      admission: safe(() => this.deps.admission(), { lease: null, intents: [] }),
      receipts: this.readReceipts(sessions),
    });
  }

  /** Wait for the refreshes in flight (tests, and a first board that should not be empty). */
  async settle(): Promise<void> {
    await Promise.all([this.liveInflight, this.logsInflight]);
  }

  private kick(now: number): void {
    if (this.deps.refreshLogs && !this.logsInflight && now - this.logsAt >= LOGS_EVERY_MS) {
      this.logsAt = now;
      this.logsInflight = this.deps.refreshLogs()
        .catch((error) => this.deps.log?.(`[pipeline-board] release log: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { this.logsInflight = null; });
    }
    if (!this.liveInflight && now - this.liveTriedAt >= LIVE_EVERY_MS) {
      this.liveTriedAt = now;
      this.liveInflight = readBoardPrs(this.gh, this.repo)
        .then((prs) => { this.live = { at: this.now(), ...prs }; this.liveError = null; })
        .catch((error) => {
          this.liveError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
          this.deps.log?.(`[pipeline-board] open PRs: ${this.liveError}`);
        })
        .finally(() => { this.liveInflight = null; });
    }
  }

  private readReceipts(sessions: readonly BoardSession[]): Record<string, { commit: string; finishedAt: number | null }> {
    const read = this.deps.readText ?? readText;
    const out: Record<string, { commit: string; finishedAt: number | null }> = {};
    for (const session of sessions) {
      if (!session.cwd || session.status === "archived" || !sessionPrs(session).length) continue;
      const file = read(join(session.cwd, ".local-ci", "last-success", "receipt.env"));
      if (!file) { this.receipts.delete(session.id); continue; }
      const known = this.receipts.get(session.id);
      const value = known && known.stamp === file.stamp ? known.value : parseReceipt(file.text);
      this.receipts.set(session.id, { stamp: file.stamp, value });
      if (value) out[session.id] = value;
    }
    return out;
  }
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function disabledBoard(now: number, repo: string): PipelineBoard {
  return {
    version: 1, enabled: false, generatedAt: now, repo,
    columns: BOARD_STAGES.map((stage) => ({ stage, known: false, total: null, cards: [], hidden: 0 })),
    bots: [],
    sources: { githubSyncedAt: null, livePrsAt: null, livePrsError: null, releaseLogTo: null, releaseHold: null },
  };
}

/** The board's content without the moment it was built: what a poll compares. */
export function boardEtag(board: PipelineBoard): string {
  return `"${createHash("sha1").update(JSON.stringify({ ...board, generatedAt: 0 })).digest("base64url")}"`;
}
