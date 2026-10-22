// A standing watch's note is written once and read on every firing, days
// later. On 02/10 the Chief's 'prod' watch still said "fechar carrier #9327,
// avisar sessões 9295 (#9314), 8891 (#9329), 9326 (#9330) e liberar gate da
// #9328" when every one of them was merged, closed or archived since the day
// before, and the bot acted on it at 03:33 without update_reason
// (R10-followup #5, R9 #4). The generic "check it still holds" was not
// enough: on firing, the server now looks up what the note names and says
// which of them are already done.

/** What a note names: numbers written as "#N" (PRs and issues) and numbers
 * named as sessions ("sessão 9295", "sessões 9295 (#9314), 8891 (#9329)"). */
export interface CitedRefs {
  numbers: number[];
  sessions: number[];
}

/** At most this many look-ups per firing: a note is a sentence, not a list. */
export const CITED_REFS_MAX = 8;

/** Where a note says where things STOOD — the base it compares from, merged on
 * purpose: "estava em 3c04d7c3d (carrier #9370: PR #9280 da #9195 …)", the
 * Monitor's real 'tag' note of 04/10. Those refs are not work to redo, and
 * naming them as "no longer open" on every firing is noise (INSP-U r1 U5). */
const BASELINE = /\b(?:estava|estavam|esteve|era|eram|was|were|base(?:line)?)\b[^()\n.;]{0,40}\([^)]*\)?|\((?:estava|era|was|base(?:line)?)\b[^)]*\)?/gi;

export function citedRefs(reason: string): CitedRefs {
  reason = reason.replace(BASELINE, " ");
  const numbers = new Set<number>();
  for (const match of reason.matchAll(/#(\d{2,7})\b/g)) numbers.add(Number(match[1]));
  for (const match of reason.matchAll(/\b(?:PRs?|issues?|carriers?)\s+(?:n[º°.]\s*)?(\d{3,7})\b/gi)) numbers.add(Number(match[1]));
  const sessions = new Set<number>();
  // "sessão 9295", "sessões 9295 (#9314), 8891 (#9329) e 9326": the bare
  // numbers that follow, up to the end of the clause
  for (const match of reason.matchAll(/\b(?:sess(?:ão|ao|ões|oes)|sessions?)\b([^.;:\n]{0,120})/gi)) {
    for (const each of match[1]!.matchAll(/(?<![#\d])\b(\d{3,7})\b/g)) sessions.add(Number(each[1]));
  }
  return { numbers: [...numbers].slice(0, CITED_REFS_MAX), sessions: [...sessions].slice(0, CITED_REFS_MAX) };
}

/** The GitHub repository a watch looks at, from its command or its note:
 * "repos/<owner>/<repo>/…", "-R <owner>/<repo>", "--repo <owner>/<repo>" or
 * a github.com URL. */
export function watchSlug(argv: readonly string[], reason: string): string | null {
  const text = [...argv, reason].join(" ");
  const match = /\brepos\/([\w.-]+)\/([\w.-]+)/.exec(text)
    ?? /(?:^|\s)(?:-R|--repo)[\s=]+([\w.-]+)\/([\w.-]+)/.exec(text)
    ?? /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/\s]|$)/.exec(text);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** GitHub's answer for one number: a PR (open, merged or closed without
 * merge) or an issue (open or closed). */
export interface RefState {
  number: number;
  kind: "pr" | "issue";
  state: "open" | "closed" | "merged";
  /** A merged PR the server saw in the production tag (prod-delivery). */
  inProduction?: boolean;
}

/** `gh api repos/<slug>/issues/<n> --jq '[.state, (.pull_request != null), (.pull_request.merged_at // "")] | @tsv'`. */
export function refStateArgs(slug: string, number: number): string[] {
  return ["api", `repos/${slug}/issues/${number}`, "--jq", "[.state, (.pull_request != null), (.pull_request.merged_at // \"\")] | @tsv"];
}

export function parseRefState(number: number, output: string): RefState | null {
  const [state, isPr, mergedAt] = output.trim().split("\t");
  if (state !== "open" && state !== "closed") return null;
  if (isPr === "true") return { number, kind: "pr", state: mergedAt ? "merged" : state };
  return { number, kind: "issue", state };
}

/** GitHub's answers, kept `ttlMs` — a failure too (a 404, no network): a
 * 1-minute watch whose note names a wrong number would otherwise ask gh 8
 * times a minute (INSP-U r1 U5). A look-up still running is shared. */
export class RefLookups {
  private readonly known = new Map<string, { at: number; state: RefState | null }>();
  private readonly running = new Map<string, Promise<RefState | null>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  // plain field assignments, not parameter properties (node type-stripping)
  constructor(ttlMs: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  lookup(key: string, ask: () => Promise<RefState | null>): Promise<RefState | null> {
    const known = this.known.get(key);
    if (known && this.now() - known.at < this.ttlMs) return Promise.resolve(known.state);
    const running = this.running.get(key);
    if (running) return running;
    const asked = ask().catch(() => null).then((state) => {
      this.running.delete(key);
      if (this.known.size >= 500) for (const [each, value] of this.known) if (this.now() - value.at >= this.ttlMs) this.known.delete(each);
      this.known.set(key, { at: this.now(), state });
      return state;
    });
    this.running.set(key, asked);
    return asked;
  }
}

/** A session the note names, as the server's ledger has it. */
export interface CitedSession {
  number: number;
  title: string;
  archived: boolean;
}

/** The session a bare number names: the one whose title starts with it
 * ("9295 Tempo de reabertura…", "9334 9331 Inatividade do chat") or says
 * "#N"; the most recent one when several do. */
export function sessionForNumber<T extends { title: string; createdAt?: number }>(sessions: readonly T[], number: number): T | null {
  const own = sessions.filter((session) => new RegExp(`^\\s*(?:#?\\d+\\s+)*#?${number}\\b|#${number}\\b`).test(session.title));
  return own.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
}

/** The line the bot reads under its note, or null when nothing it names is
 * done. Only what is done is said — an open PR is what the note expects. */
export function staleRefsLine(refs: readonly (RefState | null)[], sessions: readonly CitedSession[]): string | null {
  const done: string[] = [];
  for (const ref of refs) {
    if (!ref || ref.state === "open") continue;
    const what = ref.kind === "pr" ? `PR #${ref.number}` : `issue #${ref.number}`;
    const state = ref.kind === "pr"
      ? ref.state === "merged" ? (ref.inProduction ? "merged and already in production" : "merged") : "closed without merge"
      : "closed";
    done.push(`${what} ${state}`);
  }
  for (const session of sessions) {
    if (session.archived) done.push(`session ${session.number} ("${session.title.slice(0, 60)}") archived`);
  }
  if (!done.length) return null;
  // "merged" is not "in production": the line says the state, not that the
  // note's step is done — the bot checks before redoing it
  return `Checked by the server just now — of what your note names, these are no longer open: ${done.join("; ")}. What the note asks about them may already be done: check before redoing it, act on what is still open, then give the note a current text with wake_when update_reason (same label).`;
}
