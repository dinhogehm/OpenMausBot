// A production release that fails does not move the production tag, so the
// watches on the tag never see it: the P1 just stays out of production. The
// release watcher (nuria-platform's watch-production-release.sh) writes
// "Release production failed for <sha> (exit N)" to its err log and the
// last released sha to a state file. The server reads both and, when the
// same commit failed twice or more and was not released since, tells the
// Chief — once per new failure.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { ownerPendingAction } from "./bot-autonomy.ts";

export const RELEASE_ERR_LOG = join(homedir(), ".nuria", "logs", "production-release.err.log");
export const RELEASE_OUT_LOG = join(homedir(), ".nuria", "logs", "production-release.out.log");
export const RELEASED_SHA_FILE = join(homedir(), ".nuria", "last-production-release.sha");
/** Failures of one commit before the Chief hears about it. */
export const RELEASE_FAILURES_ALERT = 2;

/** The commit that failed last, and how many times it failed, unless it was
 * released since. Only failures of the release itself count: since lot P
 * the watcher marks a failure of the MACHINE ("…(exit N), before or without
 * a CI verdict: retried next poll" — git/ssh, npm ci, a lock, a signal),
 * which says nothing about the commit and must never lead to "refuse the
 * commit" (INSP-H r1 #4); production-release-attention.json tells it. */
export function releaseFailures(errLog: string, releasedSha: string): { sha: string; count: number } | null {
  const shas = [...errLog.matchAll(/^.*?Release production failed for ([0-9a-f]{7,40}) \(exit \d+\)(.*)$/gm)].filter((match) => !/before or without a CI verdict|halted/i.test(match[2]!)).map((match) => match[1]!);
  const last = shas.at(-1);
  if (!last) return null;
  const released = releasedSha.trim();
  if (released && (released.startsWith(last) || last.startsWith(released))) return null;
  return { sha: last, count: shas.filter((sha) => sha === last).length };
}

/** The last line saying why (the local CI lane that failed), from the out log's tail. */
// ESC [ … m, built from a string so no control character sits in a regex literal
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function releaseFailureCause(outTail: string): string | null {
  // ANSI colours out; a workspace's test noise (@nuria/web:test: …) is never the cause
  const lines = outTail.split("\n").map((line) => line.replace(ANSI_COLOUR, "").trim()).filter((line) => line && !/@[\w.-]+\/[\w.-]+:test:/.test(line));
  // the release's own verdict: the first [ERROR] of the block that ends in "Release abortado"
  const abort = lines.findLastIndex((line) => /Release abortado|Release aborted/i.test(line));
  if (abort >= 0) {
    let start = abort;
    while (start > 0 && /\[ERROR\]/.test(lines[start - 1]!)) start -= 1;
    if (start < abort) return lines[start]!.replace(/^\[ERROR\]\s*/, "").slice(0, 300);
  }
  const named = lines.findLast((line) => /Release snapshot changed|ADMISSION_TIMEOUT|Local CI failed at/.test(line))
    ?? lines.findLast((line) => /\[ERROR\]/.test(line));
  return named ? named.replace(/^\[ERROR\]\s*/, "").slice(0, 300) : null;
}

/** A cause as compared across tries: what failed, without what changes on
 * every try — the log path ("Logs: /private/var/folders/…/nuria-smart-deploy.5RILoB/…"),
 * any absolute path, time stamps, mktemp suffixes, pids. On 02/10 one failure
 * (script-contracts) was kept as 5 "different" causes, so the loop was never
 * one and the Chief was woken on every try (INSP-J r1 #1). */
export function releaseCauseKey(cause: string): string {
  return cause
    .replace(/\s*\b(?:Logs?|Log file|See|Veja)\s*:\s*\S+/gi, "")
    .replace(/(?:^|\s)(?:\/[\w.@+-]+)+\/?/g, " ")
    .replace(/\b\d{8}T\d{6}Z?\b|\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "")
    .replace(/\bpids?[ =:]+\d+\b/gi, "")
    .replace(/\b[0-9a-f]{12,40}\b/g, "")
    .replace(/[\s.,;:-]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function readTail(path: string, bytes: number): string {
  if (!existsSync(path)) return "";
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ── a release that fails the same way on the same commit ─────────────────
// On 01/10 the watcher retried cb015584a (a carrier with nothing to publish)
// five times in ~3 h: each try is a whole validation (~41 min), and the next
// starts right after the last fails — the LaunchAgent calls it every 2 min
// only while it is not running. The server said "tenta de novo a cada 2 min",
// and the Chief opened three items with three remedies, one of them the
// "halted" file (R9-release #1, #7; R9-resilience LOOP).

export interface ReleaseLoopSeen {
  firstCount: number;
  firstAt: number;
  count: number;
  at: number;
  /** The distinct causes read when each new count was seen (the out log's
   * tail only holds the last try's: ~42 k lines each). */
  causes?: string[];
}

/** The same commit failed `RELEASE_LOOP_PENDING_AT` times or more, and every
 * cause seen for it is the same: a loop, not bad luck. */
export function releaseLoopDue(seen: ReleaseLoopSeen | undefined, count: number): boolean {
  return count >= RELEASE_LOOP_PENDING_AT && (seen?.causes?.length ?? 0) <= 1;
}

/** One try of a looping release, from two counts seen: null until then. */
export function releaseLoopCycleMs(seen: ReleaseLoopSeen | undefined): number | null {
  if (!seen || seen.count <= seen.firstCount || seen.at <= seen.firstAt) return null;
  return (seen.at - seen.firstAt) / (seen.count - seen.firstCount);
}

/** Failures of one commit before the owner gets the one item to refuse it. */
export const RELEASE_LOOP_PENDING_AT = 3;
/** The one file the installed watcher reads to stop offering a tip
 * (watch-production-release.sh: DECLINED_FILE, compared with the full sha
 * of origin/main). The "halted" file is the post-deploy health check's own
 * stop: written by hand it makes the server report a halt that never happened. */
export const DECLINED_SHA_FILE = join(homedir(), ".nuria", "declined-production-release.sha");

/** The cause says there is nothing to publish (a carrier of scripts only):
 * the try can never succeed, whatever is retried. */
export function nothingToPublish(cause: string | null): boolean {
  return Boolean(cause && /sem alvo de runtime|n[ãa]o publica nada|nothing to (?:publish|release)|no runtime target/i.test(cause));
}

/** The full sha of a failed short one, from the release's own admission
 * line in the out log ("label=release:production:<40 hex>"). */
export function fullReleaseSha(outTail: string, short: string): string | null {
  const found = [...outTail.matchAll(/label=release:production:([0-9a-f]{40})\b/g)].map((match) => match[1]!).findLast((sha) => sha.startsWith(short));
  return found ?? null;
}

/** How the watcher retries, said right: never "every 2 min", and never "no limit" — since
 * lot P (nuria-platform #9342) the installed watcher halts a commit by itself on the 2nd
 * identical failure after the CI (lot T: same step and same failing tests), and on the
 * 1st tenant-drift failure; a different failure is tried again. */
export function releaseRetryText(input: { halted: boolean; cycleMs: number | null; nothingToPublish: boolean }): string {
  if (input.halted) return "O watcher PAROU de tentar este commit (halt): ele não tenta de novo este commit, e o próximo commit da main entra sozinho.";
  const cycle = input.cycleMs !== null
    ? `cada volta leva ~${Math.max(1, Math.round(input.cycleMs / 60_000))} min (medido aqui)`
    : "cada volta é uma validação completa (dezenas de minutos)";
  const why = input.nothingToPublish ? " Não há nada para publicar neste commit: nenhuma volta vai dar certo." : "";
  return `O watcher recomeça este commit depois de uma falha e para sozinho (halt) quando a mesma falha se repete depois da CI (mesmo step, mesmos testes); falhas diferentes continuam sendo tentadas. ${cycle[0]!.toUpperCase()}${cycle.slice(1)}, e enquanto roda ele segura o lease de release, o que faz os gates das sessões esperarem.${why}`;
}

/** Production as it is right now, read in the same check that writes the alert (`git
 * ls-remote` of the tag): the Chief told the owner twice on 02/10 that the tag was at
 * a9e4b93ca and #9295 was not live, from memory, hours after the tag had moved to 09d832f4b
 * and the clients had been told (R10-release #3). Null tag: not readable now — said so. */
export function productionStateLine(tagSha: string | null): string {
  return tagSha
    ? `Produção agora (git ls-remote da tag nuria-production-deployed, lido neste alerta): ${tagSha.slice(0, 9)}. Ao falar ao dono ou a cliente sobre o que está em produção, use este sha ou releia a tag no mesmo turno; nunca de memória.`
    : "Produção agora: a tag nuria-production-deployed não pôde ser lida neste alerta. Antes de dizer ao dono ou a cliente o que está em produção, leia a tag com git ls-remote no mesmo turno.";
}

/** The owner's one item for a release in a loop: the exact command the
 * installed watcher respects (OWNER_PENDING_TITLE_MAX = 200), why it matters
 * and the steps, so the resolution screen is never just a title (R10-visual
 * N13). The title carries the count and the measured cycle: a new failure
 * only refreshes it (R10-followup #4). */
export function releaseLoopPending(input: { short: string; full: string | null; count: number; cycleMs?: number | null }): { title: string; key: string; command: string; why: string; steps: Array<{ text: string; command?: string }>; options: Array<{ label: string; reply: string; recommended?: true; why?: string }> } {
  const short = input.short.slice(0, 9);
  const command = input.full
    ? `echo ${input.full} > ~/.nuria/declined-production-release.sha`
    : `git -C ~/Projetos/nuria-platform rev-parse ${input.short} > ~/.nuria/declined-production-release.sha`;
  const cycle = input.cycleMs ? `, volta de ~${Math.max(1, Math.round(input.cycleMs / 60_000))} min` : "";
  // the title is what shows in two lines of "Precisa de você"; the command is copied with its own button (INSP-H r1 #8)
  // the commit and the verb first: the person sees which commit before copying (INSP-H r2 #6)
  return {
    title: `Recusar ${short} (laço, ${input.count}×${cycle}): copie o comando de recusa`,
    key: `release-loop:${short}`,
    command,
    why: `O release de produção do ${short} falhou ${input.count}× seguidas pelo mesmo motivo e o watcher recomeça sozinho a cada falha: enquanto isso ele segura a fila de CI (os gates das sessões esperam) e as correções que vêm depois dele não chegam à produção.`,
    steps: [
      { text: "No Terminal deste Mac, grave a recusa deste commit (o watcher para de oferecê-lo):", command },
      { text: "Pronto: o servidor vê o arquivo, fecha este item e o próximo commit da main entra no lugar. Nada mais a fazer." },
    ],
    options: [
      { label: "Já gravei a recusa", reply: `Gravei a recusa do ${short} (declined-production-release.sha). Confira que o watcher passou ao próximo commit.`, recommended: true as const, why: "Falhou várias vezes pela mesma causa: recusar libera a fila e deixa o próximo commit, com a correção, entrar." },
      { label: "Deixar tentar", reply: `Não recuse o ${short}: deixe o watcher tentar. Só me avise de novo se a causa da falha mudar.` },
    ],
  };
}

/** Why a release must not take a session's CI from it: its commit is in a
 * loop (≥ RELEASE_FAILURES_ALERT failures with one cause), the owner has the
 * item to refuse it open, or already refused it. Stopping a session's gate
 * for it only feeds the loop — and the gate may be the very fix (R10-release
 * #1: the CI of #9348 killed for d5bb1f70b, then failing for the 5th time).
 * Null when it is a release that may still go through. */
export function releaseInLoop(input: { sha: string; failures: { sha: string; count: number } | null; seen: ReleaseLoopSeen | undefined; itemOpen: boolean; declined: string }): string | null {
  const sha = input.sha.trim();
  if (!COMMIT_SHA.test(sha)) return null;
  const declined = input.declined.trim();
  if (COMMIT_SHA.test(declined) && sameCommit(declined, sha)) return `o dono recusou o ${sha.slice(0, 9)} (declined-production-release.sha)`;
  const count = input.failures && sameCommit(input.failures.sha, sha) ? input.failures.count : 0;
  const causes = input.seen?.causes ?? [];
  const same = count >= RELEASE_FAILURES_ALERT && causes.length <= 1;
  const why = causes[0] ? releaseCausePt(causes[0]) : "";
  if (same) return `o ${sha.slice(0, 9)} já falhou ${count}× seguidas pela mesma causa${why ? ` (${why})` : ""}`;
  if (input.itemOpen) return `o dono tem aberto o item para recusar o ${sha.slice(0, 9)} (release em laço)`;
  return null;
}

/** The owner's items about refusing a looping release (the server's, keyed,
 * and a bot's that ask the same — the real o7 "pausar o watcher… (arquivo
 * halted)" has no key) whose commit is no longer the one looping:
 * refused, halted, released, or main moved on (INSP-H r1 #5a). */
export function releaseLoopItemsToClose<T extends { id: string; title: string; key?: string }>(items: readonly T[], looping: string | null): T[] {
  return items.filter((item) => {
    const action = ownerPendingAction(item);
    if (action?.kind !== "release-loop" || !action.sha) return false;
    return !looping || !(looping.startsWith(action.sha) || action.sha.startsWith(looping));
  });
}

/** What one check does about a commit that keeps failing: whether it is a
 * loop the owner should refuse, and whether the one item is created now.
 * - a failure of the machine (attention.json for this very commit) is no
 *   reason to refuse the commit (INSP-H r1 #4);
 * - the item is created once per commit: resolved by the owner or a bot, it
 *   is not created again on the next check (INSP-H r1 #5b); still open, it
 *   is refreshed when a new failure is told;
 * - `report`: whether the Chief hears this failure. With the owner's item
 *   already open and the loop the same, a new failure only refreshes the item
 *   (count and cycle in its title): the Chief is not woken, so the owner does
 *   not get "falhou pela N-ésima vez" again (R10-followup #4: 8 messages in
 *   6 h, all asking for the same o14). A new cause is no longer a loop and
 *   is told. */
export function releaseLoopPlan(input: {
  sha: string;
  count: number;
  halted: boolean;
  declined: boolean;
  /** attention.json is about this commit and still news */
  machine: boolean;
  told: boolean;
  itemOpen: boolean;
  state: Pick<ReleaseWatchState, "seenOf" | "once">;
}): { loop: boolean; upsert: "create" | "refresh" | null; report: boolean } {
  const loop = !input.halted && !input.declined && !input.machine && releaseLoopDue(input.state.seenOf(input.sha), input.count);
  if (!loop) return { loop, upsert: null, report: input.told };
  if (input.itemOpen) return { loop, upsert: input.told ? "refresh" : null, report: false };
  // the item was the owner's already and they closed it without refusing ("deixar tentar"): the same loop is not news
  const created = input.state.once(`loop-item:${input.sha.slice(0, 9)}`);
  return { loop, upsert: created ? "create" : null, report: created && input.told };
}

/** Failures already told, per commit, kept across restarts. */
export class ReleaseWatchState {
  private readonly path: string;
  private alerted: Record<string, number> = {};
  /** Alerts told (stuck tags, halts): few, and each must never repeat. */
  private told: string[] = [];
  /** release-priority's decisions (`<label>#<pid>`): many, in a list of their
   * own so they never push a halt or a tag out of `told`. */
  private decided: string[] = [];
  /** When each failure count of a commit was first seen here: the loop's real cycle. */
  private seen: Record<string, ReleaseLoopSeen> = {};

  constructor(path: string) {
    this.path = path;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { alerted?: Record<string, number>; told?: string[]; decided?: string[]; seen?: Record<string, ReleaseLoopSeen> };
      this.alerted = raw.alerted ?? {};
      // causes saved by an earlier build kept the log path: the same failure read as many
      this.seen = Object.fromEntries(Object.entries(raw.seen ?? {}).map(([sha, seen]) => {
        const causes = [...new Set((seen.causes ?? []).map(releaseCauseKey).filter(Boolean))];
        const { causes: _old, ...rest } = seen;
        return [sha, causes.length ? { ...rest, causes } : rest];
      }));
      // decisions written to `told` by an earlier build move to their own list
      this.told = (raw.told ?? []).filter((key) => !key.startsWith("preempt:"));
      this.decided = [...(raw.decided ?? []), ...(raw.told ?? []).filter((key) => key.startsWith("preempt:")).map((key) => key.slice("preempt:".length))];
    } catch { /* first run */ }
  }

  private save(): void {
    writeFileAtomic(this.path, `${JSON.stringify({ alerted: this.alerted, told: this.told, decided: this.decided, seen: this.seen }, null, 2)}\n`, { mode: 0o600 });
  }

  /** Each check: the failure count of `sha` at `now`. Records when a new
   * count is first seen (the server reads the log every 2 min, so a cycle is
   * known to within that). */
  observe(sha: string, count: number, now: number, cause: string | null = null): void {
    const known = this.seen[sha];
    if (known && count <= known.count) return;
    const key = cause ? releaseCauseKey(cause) : "";
    const causes = [...new Set([...(known?.causes ?? []), ...(key ? [key] : [])])];
    const next: ReleaseLoopSeen = known ? { ...known, count, at: now } : { firstCount: count, firstAt: now, count, at: now };
    if (causes.length) next.causes = causes.slice(-5);
    this.seen = { ...Object.fromEntries(Object.entries(this.seen).filter(([key]) => key !== sha).slice(-10)), [sha]: next };
    this.save();
  }

  /** What was seen of `sha`'s failures here. */
  seenOf(sha: string): ReleaseLoopSeen | undefined {
    return this.seen[sha];
  }

  /** How long one try of `sha` takes, measured here; null until two counts were seen. */
  cycleMs(sha: string): number | null {
    return releaseLoopCycleMs(this.seen[sha]);
  }

  /** Whether release-priority already decided `key`. */
  isDecided(key: string): boolean {
    return this.decided.includes(key);
  }

  /** Records a release-priority decision (the last 200 are kept). */
  decide(key: string): void {
    if (this.decided.includes(key)) return;
    this.decided = [...this.decided.slice(-199), key];
    this.save();
  }

  /** Whether `count` failures of `sha` are news. Records them if so. */
  take(sha: string, count: number): boolean {
    if (count < RELEASE_FAILURES_ALERT || count <= (this.alerted[sha] ?? 0)) return false;
    this.alerted = { ...Object.fromEntries(Object.entries(this.alerted).slice(-20)), [sha]: count };
    this.save();
    return true;
  }

  /** Whether `key` (a stuck tag, a halt) was told already. */
  wasTold(key: string): boolean {
    return this.told.includes(key);
  }

  /** Whether `key` (a stuck tag, a halt) is news. Records it if so. */
  once(key: string): boolean {
    if (this.told.includes(key)) return false;
    this.told = [...this.told.slice(-40), key];
    this.save();
    return true;
  }
}

// ── after a release: the tag, and the watcher's own halt ────────────────
// A release can reach production and still leave the certification tag
// where it was (01/10: GH013, a ruleset blocked the watcher's push): every
// watch on the tag goes blind and no client hears the delivery. And the
// watcher can halt a tip for good (nuria-platform #9328: after N content
// failures it writes ~/.nuria/halted-production-release.{sha,reason} and
// ~/.nuria/escalations/production-release-halted.json); from then on it does
// NOT retry, and saying "it retries every 2 min" would be false.

export const HALTED_SHA_FILE = join(homedir(), ".nuria", "halted-production-release.sha");
export const HALTED_REASON_FILE = join(homedir(), ".nuria", "halted-production-release.reason");
export const HALT_ESCALATION_FILE = join(homedir(), ".nuria", "escalations", "production-release-halted.json");
/** The watcher's memory of the last failure (lot P): removed together with the halt, or the same failure halts again. */
export const LAST_FAILURE_FILE = join(homedir(), ".nuria", "last-failure-production-release");
/** How long production may run ahead of the tag before the Chief hears it. */
export const TAG_STUCK_AFTER_MS = 15 * 60_000;

const TAG_NOT_ADVANCED = /production is live at ([0-9a-f]{7,40}) but the certification tag was NOT advanced/i;
const TAG_REFUSAL = /GH013|protected ref|Cannot update this protected/i;
/** Lines that close one release's output in the err log: nothing before them is this release's. */
const RELEASE_BOUNDARY = /production is live at [0-9a-f]{7,40}|Release production failed for [0-9a-f]{7,40}|Certification tag (?:nuria-production-deployed advanced|unchanged)/i;
/** How far above its warning a release's push refusal may sit. */
const TAG_CAUSE_WINDOW = 40;

/** Why the tag did not move for `releasedSha`, from the err log's tail
 * (local-release.sh writes both to stderr): that release's own warning
 * ("production is live at <releasedSha> but the certification tag was NOT
 * advanced") and GitHub's refusal of its push, which comes just before it —
 * never a refusal from an earlier release (01/10: the GH013 of 1bbd5c2a7
 * stays in the tail for days). Null when this release left no warning. */
export function tagStuckCause(errTail: string, releasedSha: string): string | null {
  const found = releaseWarning(errTail, releasedSha);
  if (!found) return null;
  const { lines, at } = found;
  // the whole window up to the previous release's end: GitHub prints GH013
  // first and "- Cannot update this protected ref." closer to the warning
  const refusals: string[] = [];
  for (let i = at - 1; i >= 0 && at - i <= TAG_CAUSE_WINDOW && !RELEASE_BOUNDARY.test(lines[i]!); i -= 1) {
    if (TAG_REFUSAL.test(lines[i]!)) refusals.push(lines[i]!);
  }
  const exit = /\(exit (\d+)\)/.exec(lines[at]!)?.[1];
  const parts = [`o release avisou que a tag não avançou${exit ? ` (exit ${exit})` : ""}`];
  if (refusals.length) parts.push(`o GitHub recusou o push da tag (${refusals.some((line) => /GH013/.test(line)) ? "GH013: regra de proteção do repositório" : "ref protegida"})`);
  return parts.join("; ");
}

/** The released sha's "production is live at … NOT advanced" warning in the err log's tail, if any. */
function releaseWarning(errTail: string, releasedSha: string): { lines: string[]; at: number } | null {
  const released = releasedSha.trim();
  if (!released) return null;
  const lines = errTail.split("\n").map((line) => line.replace(ANSI_COLOUR, "").trim()).filter(Boolean);
  const at = lines.findLastIndex((line) => {
    const sha = TAG_NOT_ADVANCED.exec(line)?.[1];
    return Boolean(sha && (sha.startsWith(released) || released.startsWith(sha)));
  });
  return at < 0 ? null : { lines, at };
}

/** The manual advance the release printed after its warning ("Advance it
 * manually:" + `git tag -f … && git push --force-with-lease …`). A force push
 * past the ruleset: the OWNER's action (or whoever holds the bypass), never a
 * bot's — it goes to the server log and to the owner's pending list, never
 * into a report a bot acts on. */
export function tagManualAdvance(errTail: string, releasedSha: string): string | null {
  const found = releaseWarning(errTail, releasedSha);
  if (!found) return null;
  return found.lines.slice(found.at + 1, found.at + 4).find((line) => /^git tag -f nuria-production-deployed [0-9a-f]{7,40}\b/.test(line))?.slice(0, 400) ?? null;
}

/** The Chief's report for a stuck tag: what happened and who acts — no command to run. */
export function tagStuckReport(text: string, manualAdvancePrinted: boolean): string {
  return `[Alerta do servidor: tag de produção parada] ${text}\nAvançar a tag é ação do dono (ou de quem tem bypass do ruleset do repositório); bots não executam esse avanço nem force-push.${manualAdvancePrinted ? " O release deixou o comando exato no log do servidor e na pendência do dono." : ""} Avise o dono; até a tag andar, confirme entregas a clientes pelo commit em produção, não pela tag.`;
}

/** The owner's "advance the tag" items to close: once the tag contains their
 * commit (advanced by hand, or by a later release), following them would move
 * the production tag BACK. `contained` says, per sha, whether the tag contains
 * it (null = not verifiable: kept open). A sha equal to the tag's is contained. */
export function tagAdvanceToResolve(openKeys: readonly string[], tagSha: string | null, contained: (sha: string) => boolean | null): string[] {
  if (!tagSha) return [];
  return openKeys.filter((key) => {
    const sha = /^tag-advance:([0-9a-f]{7,40})$/.exec(key)?.[1];
    if (!sha) return false;
    return sameCommit(sha, tagSha) || contained(sha) === true;
  });
}

/** The owner's pending item for a stuck tag (OWNER_PENDING_TITLE_MAX = 200). */
export function tagAdvancePendingTitle(releasedSha: string, commandInItem = false): string {
  // where the command is: in the item's first step when the release printed it (INSP-J r1 #11)
  return `Avançar a tag de produção para ${releasedSha.trim().slice(0, 9)} (barrada pelo ruleset; só o dono ou quem tem bypass, comando ${commandInItem ? "no passo 1" : "no log do servidor"})`;
}

/** The whole item for a stuck tag, born practical (R10-visual N13): why it
 * matters, the manual advance the release printed (the owner's, never a
 * bot's: it is a force push past the ruleset) and that it closes itself. */
export function tagAdvancePending(releasedSha: string, manual: string | null): { title: string; key: string; why: string; steps: Array<{ text: string; command?: string }>; options: Array<{ label: string; reply: string; recommended?: true; why?: string }>; command?: string } {
  const sha = releasedSha.trim();
  return {
    title: tagAdvancePendingTitle(sha, Boolean(manual)),
    key: `tag-advance:${sha}`,
    why: `Produção já roda o ${sha.slice(0, 9)}, mas a tag nuria-production-deployed não andou: os vigias da tag não veem a entrega e nenhum cliente é avisado até ela andar.`,
    steps: [
      manual
        ? { text: "No Terminal, dentro do clone de nuria-platform e com uma conta que tem bypass do ruleset, rode o avanço que o release imprimiu:", command: manual }
        : { text: `Com uma conta que tem bypass do ruleset, avance a tag nuria-production-deployed para ${sha.slice(0, 9)} (o comando exato está no log do servidor, linha [release] … manual advance).` },
      { text: "Pronto: o servidor vê a tag contendo o commit e fecha este item sozinho; os vigias avisam as entregas." },
    ],
    options: [
      { label: "Avancei a tag", reply: `Avancei a tag nuria-production-deployed para ${sha.slice(0, 9)}. Confira e siga com os avisos de entrega.`, recommended: true, why: "Sem a tag no commit em produção, nenhum cliente é avisado da entrega." },
      { label: "Não tenho o bypass", reply: `Não tenho bypass do ruleset para avançar a tag para ${sha.slice(0, 9)}: diga quem tem e o que pedir.` },
    ],
    ...(manual ? { command: manual } : {}),
  };
}

/** Whether the tag contains the release, as far as this clone can verify:
 * `git ls-remote` does not fetch, so the tag's commit (or the released one)
 * may be missing here, and then `merge-base` cannot tell — null, never a
 * guess from sha prefixes (a tag ahead of the release would read "stuck"). */
export function tagContainsRelease(input: { releasedKnown: boolean; tagKnown: boolean; isAncestor: boolean | null }): boolean | null {
  return input.releasedKnown && input.tagKnown ? input.isAncestor : null;
}

/** Production runs `releasedSha` (released at `releasedAt`) and the tag is
 * verifiably not at it (nor past it) after TAG_STUCK_AFTER_MS: what to tell,
 * else null. `tagContainsRelease: null` (not verified) tells nothing. */
export function tagStuck(input: { releasedSha: string; releasedAt: number; tagSha: string | null; tagContainsRelease: boolean | null; now: number; cause: string | null }): string | null {
  const released = input.releasedSha.trim();
  if (!released || !input.tagSha || input.tagContainsRelease !== false || input.now - input.releasedAt < TAG_STUCK_AFTER_MS) return null;
  const minutes = Math.round((input.now - input.releasedAt) / 60_000);
  return `Produção está no ar em ${released.slice(0, 9)} há ${minutes} min, mas a tag de produção continua em ${input.tagSha.slice(0, 9)}${input.cause ? ` (${input.cause})` : ""}: os vigias da tag não veem a entrega e nenhum cliente é avisado. O dono (ou quem tem bypass do ruleset) precisa avançar a tag, ou corrigir o que a barrou.`;
}

const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** Whether a halt is still news: the .sha stays on disk until someone deletes
 * it, even after a newer tip shipped (the watcher only compares it with the
 * remote tip). It is superseded only by a LATER release that went through:
 * the released sha contains the halted one, or last-production-release.sha
 * (written only on success) is newer than the halt and holds another commit.
 * main moving is no evidence: on exit 21 (bad health, no automatic way back)
 * production runs the halted commit and nothing was released after it.
 * Unknowns (null) keep the alert: a halt is never hidden on a guess. */
export function haltStillMatters(input: { haltedSha: string; releasedSha: string; releasedContainsHalt: boolean | null; releasedAtMs: number | null; haltedAtMs: number | null }): boolean {
  if (input.releasedContainsHalt === true) return false;
  const released = input.releasedSha.trim();
  // a later release went through: the watcher writes last-production-release.sha only on success
  if (COMMIT_SHA.test(released) && !sameCommit(released, input.haltedSha) && input.releasedAtMs !== null && input.haltedAtMs !== null && input.releasedAtMs > input.haltedAtMs) return false;
  return true;
}
// ── a release that needs attention without being halted ─────────────────
// nuria-platform lot P (watch-production-release.sh, escalate_to_chief): a
// release that fails before its CI or without a verdict from it (git/ssh,
// npm ci, a stale lock), or is killed by a signal, is not halted — the next
// poll retries it — but the watcher writes, once per failure signature,
// ~/.nuria/escalations/production-release-attention.json:
// {"to":"chief","kind":"production-release-attention","reason":"fast-failure"|"signal",
//  "sha":"<40 hex>","failures":1,"limit":0,"last_failure":"<text>","at":"<ISO Z>"}
// A new signature rewrites it (another `at`), so `at` tells one write from the next.

export const ATTENTION_ESCALATION_FILE = join(homedir(), ".nuria", "escalations", "production-release-attention.json");
/** Larger than this, the file is not what the watcher writes (one line of JSON): ignored. */
export const ATTENTION_FILE_MAX_BYTES = 16 * 1024;
/** An escalation older than this is history, not news (a first boot after days). */
export const ATTENTION_MAX_AGE_MS = 24 * 3_600_000;

const ATTENTION_REASONS: Record<string, string> = {
  "fast-failure": "falhou antes da CI ou sem veredito dela (git/ssh, npm ci, lock de admissão): é a máquina, não o commit",
  signal: "foi morto por um sinal (reinício, falta de memória ou alguém parou o processo): é a máquina, não o commit",
};

// control characters, built from a string so none sits in a regex literal
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`, "g");

export interface ReleaseAttention { key: string; sha: string; reason: string; reasonPt: string; lastFailure: string | null; at: string | null; atMs: number | null }

/** The watcher's "needs attention" escalation, or null when the file is
 * missing, empty, corrupt, too large or of another kind. Free text from the
 * release is cut and stripped of control characters. */
export function releaseAttention(json: string): ReleaseAttention | null {
  if (!json.trim() || Buffer.byteLength(json) > ATTENTION_FILE_MAX_BYTES) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw.kind !== "production-release-attention" || typeof raw.sha !== "string" || !COMMIT_SHA.test(raw.sha)) return null;
  const clean = (value: unknown, max: number) => (typeof value === "string" ? value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
  const reason = clean(raw.reason, 60) || "unknown";
  const lastFailure = clean(raw.last_failure, 300) || null;
  const at = clean(raw.at, 40) || null;
  const atMs = at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : null;
  // one alert per write: the watcher writes once per failure signature, each with its own time
  const stamp = at ?? `${lastFailure ?? ""}`.slice(0, 80);
  return { key: `attention:${raw.sha.slice(0, 12)}:${reason}:${stamp}`, sha: raw.sha, reason, reasonPt: ATTENTION_REASONS[reason] ?? `pediu atenção (${reason})`, lastFailure, at, atMs };
}

/** Whether an escalation is news: not older than ATTENTION_MAX_AGE_MS, not of
 * a commit already released (the released sha is it). */
export function releaseAttentionDue(attention: ReleaseAttention, input: { now: number; releasedSha: string }): boolean {
  if (attention.atMs !== null && input.now - attention.atMs > ATTENTION_MAX_AGE_MS) return false;
  const released = input.releasedSha.trim();
  return !(released && sameCommit(released, attention.sha));
}

/** A machine failure in two words, from the release's last error. */
function machineHint(lastFailure: string): string {
  if (/publickey|ssh|git@|could not read from remote|permission denied/i.test(lastFailure)) return "ssh/git";
  if (/npm (?:ci|install)|EINTEGRITY|ENOTFOUND|registry/i.test(lastFailure)) return "npm";
  if (/lock|admission|ADMISSION/i.test(lastFailure)) return "lock preso";
  if (/disk|ENOSPC|no space/i.test(lastFailure)) return "disco cheio";
  return "";
}

/** A release that keeps failing on one commit, as the chip opens: which, how often, why in short. */
/** The release's own cause, said short and in pt-BR for a chip (the full one goes in the report). */
export function releaseCausePt(cause: string | null): string {
  if (!cause) return "";
  if (nothingToPublish(cause)) return "sem alvo de runtime";
  if (/Release snapshot changed/i.test(cause)) return "snapshot mudou durante o release";
  if (/ADMISSION_TIMEOUT/.test(cause)) return "tempo de espera na fila esgotou";
  const step = /Local CI failed at\s+(\S+)/i.exec(cause)?.[1];
  if (step) return `CI local falhou em ${step}`;
  if (/migration/i.test(cause)) return "migration reprovou";
  return cause.replace(/\s+/g, " ").slice(0, 60);
}

export function releaseFailedText(sha: string, count: number, cause: string | null): string {
  const why = releaseCausePt(cause);
  return `Release ${sha.slice(0, 9)} falhou ${count}× seguidas${why ? ` (${why})` : ""} — não está em produção; a tag de produção não andou.`;
}

/** The chip and the Chief's report for an escalation, in pt-BR: why, and what to do. */
export function releaseAttentionAlert(attention: ReleaseAttention, logs: { err: string }): { text: string; report: string } {
  const short = attention.sha.slice(0, 9);
  const last = attention.lastFailure?.slice(0, 160).replace(/[.\s]+$/, "");
  // what the owner sees first (a chip shows ~55 characters): whose fault, and that it retries (INSP-H r1 #8)
  const hint = attention.reason === "signal" ? "processo morto por sinal" : machineHint(attention.lastFailure ?? "");
  const text = `Release ${short}: falha da máquina${hint ? ` (${hint})` : ""}, não do commit — o watcher tenta de novo. O release ${attention.reasonPt}${last ? `; último erro: ${last}` : ""}.`;
  const todo = attention.reason === "signal"
    ? "descubra o que matou o processo (reinício do Mac, falta de memória, alguém parou o release)"
    : "corrija a máquina (chave ssh/acesso ao git, npm ci, um lock de admissão preso)";
  return {
    text,
    report: `[Alerta do servidor: release de produção pede atenção] ${text}\nO que fazer: veja ${logs.err}${attention.at ? ` perto de ${attention.at}` : ""} e ${todo}. O commit não está em causa: não proponha recusá-lo nem o arquivo halted por isso. O watcher não para este commit e tenta de novo no próximo ciclo; se a mesma falha voltar, ele avisa de novo só com outra assinatura. Avise o dono só se a correção depender dele. Arquivo: ${ATTENTION_ESCALATION_FILE}.`,
  };
}

/** The watcher's reason codes, said in pt-BR (unknown codes are kept as they are). */
const HALT_REASONS: Record<string, string> = {
  "content-failure-limit": "limite de falhas de conteúdo atingido",
  // nuria-platform #9319 (watch-production-release.sh): the post-deploy health halt
  "post-release-health": "checagem de saúde pós-deploy",
  // lot P (#9342): the same failure twice after the CI
  "repeated-failure": "a mesma falha 2× seguidas depois da CI",
};

/** The Chief's report for a watcher halt: what stopped, why, and the way out for THAT
 * reason. A repeated failure is undone only by removing both files — the halt alone makes
 * the same failure halt again at once (watch-production-release.sh, lot P); a fix that lands
 * on main is released by itself, the halt holds only this commit. */
export function haltReport(halted: { sha: string; reasonCode: string; reason: string; failures?: number; lastFailure?: string }, files: { halted: string; escalation: string; lastFailure: string }): { text: string; report: string } {
  const short = halted.sha.slice(0, 9);
  const text = `O watcher de produção PAROU de tentar o commit ${short} (${halted.reason}${halted.failures ? `, ${halted.failures} falhas` : ""}): ele não tenta de novo este commit sozinho.`;
  const way = halted.reasonCode === "repeated-failure"
    ? `Falhou igual duas vezes (mesmo step e mesmos testes): é falha do conteúdo, não da máquina. A saída é a correção entrar na main com um carrier novo: o watcher publica o próximo commit da main sozinho, sem ninguém tocar em arquivos. Só para repetir ESTE commit (depois de corrigir a máquina, se a causa for ela) é preciso apagar os dois arquivos: rm ${files.halted} ${files.lastFailure} — apagando só o primeiro, a mesma falha para o commit de novo na hora. Apagar é decisão do dono, não de bot.`
    : halted.reasonCode === "content-failure-limit"
      ? `Drift de tenant: corrija o tenant (DBA) ou a migration; depois, para repetir este commit, o dono apaga ${files.halted}. Um commit novo na main é publicado sozinho.`
      : `Descubra a causa (saúde pós-deploy), corrija ou decida com o dono; para tentar de novo o mesmo commit, o dono apaga ${files.halted}.`;
  return {
    text,
    report: `[Alerta do servidor: release de produção parado] ${text}${halted.lastFailure ? ` Última falha: ${halted.lastFailure}.` : ""}\n${way} Não peça ao dono para gravar declined-production-release.sha para este commit: o halt já o tirou da fila. Arquivos: ${files.escalation}, ${files.halted}.`,
  };
}

/** The watcher's halt of a tip, or null when none. The halt exists if and
 * only if halted-production-release.sha holds a commit sha: that is the one
 * file the watcher reads to decide (watch-production-release.sh), and the one
 * the alert tells to remove for a retry — the escalation JSON stays behind
 * after that `rm`, so it never makes a halt by itself; it only adds the
 * failure count and the last failure when its sha is the same commit.
 * Without a .reason (the post-deploy halts, exit 20/21/23, write none) the
 * reason is the post-deploy check. */
export function haltedRelease(input: { escalationJson: string; haltedSha: string; haltedReason: string }): { sha: string; reasonCode: string; reason: string; failures?: number; lastFailure?: string } | null {
  const sha = input.haltedSha.trim();
  if (!COMMIT_SHA.test(sha)) return null;
  let escalation: { reason?: string; failures?: number; lastFailure?: string } = {};
  try {
    const raw = JSON.parse(input.escalationJson) as { kind?: unknown; sha?: unknown; reason?: unknown; failures?: unknown; last_failure?: unknown };
    if (raw.kind === "production-release-halted" && typeof raw.sha === "string" && COMMIT_SHA.test(raw.sha) && (raw.sha.startsWith(sha) || sha.startsWith(raw.sha))) {
      escalation = {
        ...(typeof raw.reason === "string" && raw.reason.trim() ? { reason: raw.reason.trim() } : {}),
        ...(typeof raw.failures === "number" ? { failures: raw.failures } : {}),
        ...(typeof raw.last_failure === "string" && raw.last_failure.trim() ? { lastFailure: raw.last_failure.trim().slice(0, 300) } : {}),
      };
    }
  } catch { /* no escalation file, or not readable as one */ }
  const code = input.haltedReason.trim().split("\n")[0]!.trim().slice(0, 200) || escalation.reason || "";
  return {
    sha,
    reasonCode: code || "post-release-health",
    reason: code ? HALT_REASONS[code] ?? code : "checagem pós-deploy",
    ...(escalation.failures !== undefined ? { failures: escalation.failures } : {}),
    ...(escalation.lastFailure ? { lastFailure: escalation.lastFailure } : {}),
  };
}
