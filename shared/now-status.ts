// "Agora" (lot Y): the delivery line's state in one look — what runs in
// production and what went in today, the release on its way, the open PRs and
// their gate, the local CI, the release alerts and the day's throughput. Built
// by the server from what it already reads (the release log, the admission
// lease, `gh`, the productivity report), deterministically: no model, no cost,
// nothing guessed. Unknown is null on the wire and "—" on screen, never zero.
//
// What waits on the owner ("Precisa de você") and the sessions to resume are
// not here: the app already holds them live, and the panel reads them from the
// same place as the sidebar, so the two never disagree.

/** The server recomputes at most this often, and the screen asks again this often. */
export const NOW_TICK_MS = 60_000;

export type NowGate = "success" | "pending" | "failure" | "missing";

export interface NowPr { number: number; title: string | null; url: string }

export interface NowDelivery {
  sha: string;
  /** When the deploy finished (code live), ms. */
  at: number;
  /** PRs it carried (release carriers left out); null while its contents are not known. */
  prs: NowPr[] | null;
}

export interface NowProduction {
  /** The commit production runs: the last release whose tag advanced (or that went live without it). */
  sha: string | null;
  at: number | null;
  /** The tag on GitHub, as last read, and whether it agrees with `sha`. */
  tag: { sha: string | null; checkedAt: number | null; agrees: boolean | null };
  /** Today's deliveries (São Paulo), newest first; null when no release source covers today. */
  today: NowDelivery[] | null;
}

/** A step of the release, as the log names it ("tests", "smart-deploy"…) or a
 * moment the server recognizes ("queued", "review", "deploy", "purge",
 * "post-release", "tag"). */
export type NowReleasePhase = string;
export type NowReleaseProfile = "migrations" | "light";
/** Fewer comparable releases than this: no estimate ("—"). */
export const NOW_MIN_SAMPLES = 3;

export interface NowRelease {
  /** running: holds the machine or the deploy; queued: waits for the machine; idle: none on its way; unknown: the admission state could not be read. */
  state: "running" | "queued" | "idle" | "unknown";
  sha?: string;
  startedAt?: number | null;
  phase?: NowReleasePhase | null;
  /** When the phase started (the log's UTC clock, dated), when known. */
  phaseAt?: number | null;
  /** Steps of a phase that counts them: workers deployed (of how many), post-release samples (of 5). */
  progress?: { done: number; total: number | null } | null;
  /** PRs it carries (from git: production's commit → this one); null when unknown. */
  prs?: NowPr[] | null;
  /** With database migrations (~3 h) or without (~45 min): the two are never estimated together.
   * null until the run says which (its CI steps after smart-deploy, or the deploy's "Banco/migrations:"). */
  profile?: NowReleaseProfile | null;
  /** Median duration, first CI step → deploy finished, of the last releases of THIS profile; null below 3 of them. */
  estimateMs: number | null;
  /** Time left: the typical time from the current phase's anchor to the end, minus what already passed
   * since it in this run (negative: past the median); null without a comparable base. */
  remainingMs?: number | null;
  /** How many comparable releases the estimate stands on. */
  samples: number;
  /** Each profile's median and how many releases it stands on (shown when no release runs). */
  profiles?: Record<NowReleaseProfile, { ms: number | null; samples: number }>;
  /** The release may have hung: older than the admission's ceiling. */
  overdue?: boolean;
}

export interface NowOpenPr extends NowPr {
  /** GitHub's mergeStateStatus: BEHIND, BLOCKED, CLEAN, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN. */
  merge: string;
  /** The nuria/local-merge-gate status on the head: "success" is the gate's receipt. */
  gate: NowGate;
  draft: boolean;
  createdAt: number;
}

export interface NowPrs {
  /** Open PRs into main (drafts included, marked); null when never read. */
  list: NowOpenPr[] | null;
  checkedAt: number | null;
  /** The last read failed (the list, if any, is the one before). */
  error?: string;
}

export interface NowCiSession { sessionId: string; title: string; botId: string; threadId: string }

export interface NowCi {
  /** running: a ci:local holds the machine; queued: none runs but one waits; idle; unknown: unreadable. */
  state: "running" | "queued" | "idle" | "unknown";
  /** The lease's label (local-ci:<head12>) while one runs. */
  label?: string;
  since?: number | null;
  /** ci:local processes waiting for the machine; null when the process table could not be read. */
  queued: number | null;
  /** They wait behind a production release (lot W: a legitimate wait). */
  behindRelease?: boolean;
  /** The managed session whose ci:local runs, when known; "owner" when it is the owner's terminal. */
  session?: NowCiSession | "owner" | null;
}

export interface NowAlert {
  /** Stable across ticks, for "novo" and the notification dedupe. */
  key: string;
  at: number;
  /** As the Chief received it (pt-BR, the server's words). */
  text: string;
  /** Where it was said: the Chief's conversation (absent: read from the watcher's log, said nowhere). */
  botId?: string;
  threadId?: string;
  /** The commit it is about, and what settles it: "release" (a failing or halted commit: settled
   * when declined, released or in production) or "tag" (the tag stuck behind production:
   * settled when the tag reaches it). */
  sha?: string;
  kind?: "release" | "tag";
}

/** What a release alert is about, from the words release-watch uses. */
export function alertSubject(text: string): { sha?: string; kind: "release" | "tag" } {
  const sha = /\b([0-9a-f]{9,40})\b/.exec(text)?.[1];
  return { ...(sha ? { sha } : {}), kind: /tag de produção continua em|avançar a tag/i.test(text) ? "tag" : "release" };
}

export interface NowThroughput {
  /** Releases that reached production today; null without a release source. */
  deliveries: number | null;
  /** PRs merged into main today (carriers left out); null before the first GitHub sync. */
  mergedPrs: number | null;
  /** Issues closed today; null before the first GitHub sync. */
  closedIssues: number | null;
  /** Release runs that ran and failed today; null without a release source. */
  failedReleases: number | null;
  syncedAt: number | null;
}

export interface NowServerStatus {
  version: 1;
  generatedAt: number;
  /** False when this machine does not run the Nuria release (no ~/.nuria): nothing to show but the local part. */
  enabled: boolean;
  production: NowProduction;
  release: NowRelease;
  prs: NowPrs;
  ci: NowCi;
  /** Release alerts said since production last moved, newest first; null when unknown. */
  alerts: NowAlert[] | null;
  throughput: NowThroughput;
}

/** What the owner saw the last time the panel was open: when, and each line's fingerprint then. */
export interface NowSeen { at: number; keys: Record<string, string> }

export const PRODUCTION_REPO_URL = "https://github.com/dinhogehm/nuria-platform";
export const prUrl = (number: number): string => `${PRODUCTION_REPO_URL}/pull/${number}`;
export const commitUrl = (sha: string): string => `${PRODUCTION_REPO_URL}/commit/${sha}`;

/** A stable digest of what the server says, for "did anything change" (the clock is left out). */
export function nowFingerprint(status: NowServerStatus): string {
  const { generatedAt: _generatedAt, ...rest } = status;
  const text = JSON.stringify(rest);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Merge states that keep a PR from merging, in the order they need a hand. */
export const PR_ATTENTION = ["DIRTY", "BEHIND", "BLOCKED", "UNSTABLE"] as const;
