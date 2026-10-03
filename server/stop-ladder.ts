// One ladder for a session that stopped (failed, or idle after its turn):
// what its bot (and the Chief) hear about that stop, and when — once per
// step, never two voices on the same stop (INSP-S r1 S-2: RETOMAR at 2 h,
// "esperando um aviso?" at 6 h and every day after, "sugiro arquivar" at
// 24 h, none of them knowing the others).
//
//   2 h   with an open PR of its own → RETOMAR: resume it, or report the block
//  24 h   no progress since, PR still open → the exact block to the owner;
//         NEVER "archive" while the PR is open. Last word on this stop.
//  24 h   failed with no open PR → "sugiro arquivar". Last word on this stop.
//
// A stop is its `since` (failedAt, else the last activity): any progress
// starts a new stop and the ladder over. Nothing is said while the server
// itself holds the session behind a release, or a release is on its way
// (prod-delivery.ts resumeNeeded). At most STOP_NOTICES_PER_HOUR notices in
// any hour, counted from the ledger, so a restart does not reset it
// (INSP-S r1 S-9: "3 per pass" ran every tick).
import { type CcSession, resumeLine } from "./cc-sessions.ts";
import { openPrsOfSession, type ResumeNeed, resumeNeeded } from "./prod-delivery.ts";

export const STOP_ESCALATE_MS = 24 * 3_600_000;
export const STOP_NOTICES_PER_HOUR = 3;

export type StopStep =
  | { stage: "resume"; since: number; need: ResumeNeed }
  | { stage: "escalate"; since: number; need: ResumeNeed; resumed: boolean }
  | { stage: "archive"; since: number; prs: number[] };

/** When this stop began, or null when the session is not stopped. */
export function stopSince(session: Pick<CcSession, "status" | "failedAt" | "lastActivityAt">): number | null {
  if (session.status === "failed") return session.failedAt ?? session.lastActivityAt;
  return session.status === "idle" ? session.lastActivityAt : null;
}

const after = (at: number | undefined, since: number) => at !== undefined && at >= since;

/** The step due now on this session's stop, or null (nothing to say, or
 * already said). `release`: a release on its way (resumeNeeded's hold). */
export function stopStep(session: CcSession, now: number, release: string | null = null): StopStep | null {
  const since = stopSince(session);
  if (since === null) return null;
  // the last word on this stop was said (failedAgingReportedAt: the old 24 h notice)
  if (after(session.stopEscalatedAt, since) || (session.status === "failed" && after(session.failedAgingReportedAt, since))) return null;
  // told to resume on this stop (idleReportedAt: the old 6 h notice)
  const resumed = after(session.resumeReportedAt, since) || after(session.idleReportedAt, since);
  const need = resumeNeeded(session, now, { release });
  if (now - since >= STOP_ESCALATE_MS) {
    if (need) return { stage: "escalate", since, need, resumed };
    // held (parked, a release on its way): its open PR still forbids "archive"; said once free
    if (session.status !== "failed" || resumeNeeded(session, now) !== null || session.resumeAfterTag) return null;
    // the PRs a session cannot take (wrong folder, never opened) are said with it
    return { stage: "archive", since, prs: openPrsOfSession(session) };
  }
  return need && !resumed ? { stage: "resume", since, need } : null;
}

export interface StopLadderDeps {
  ledger: { all(): CcSession[]; save(): void };
  now: () => number;
  /** A release on its way on this Mac (pt-BR), "?" when undecided, null when none. */
  release: () => string | null;
  /** GitHub's word on the PRs before they are said open: the ones still
   * open, or null when GitHub cannot be asked (the record stands). */
  confirmOpen?: (session: CcSession, prs: number[]) => Promise<number[] | null>;
  /** What the session's bot hears, and the chip on its conversation. */
  report: (session: CcSession, text: string) => void;
  chip: (session: CcSession, text: string, ok?: boolean) => void;
  /** What the Chief hears (another bot's session), with the owner's name. */
  chief?: (session: CcSession, text: string) => void;
  ownerName?: (session: CcSession) => string;
  /** An open owner item ("Precisa de você") that already carries this
   * session's block — its title — or null (ownerItemCiting). */
  ownerItem?: (session: CcSession, prs: number[]) => string | null;
}

/** The open owner item that already names this session or one of its PRs
 * (the bot did report the exact block): the ladder neither starts over on
 * a new stop nor repeats it while it is open (INSP-S r2 S2-5). Its title, or null. */
export function ownerItemCiting(items: ReadonlyArray<{ title: string; why?: string; link?: string; command?: string; steps?: ReadonlyArray<{ text: string; link?: string; command?: string }> }>, session: Pick<CcSession, "id">, prs: readonly number[]): string | null {
  const cites = (text: string) => text.includes(session.id) || prs.some((n) => new RegExp(`(?:#|\\bPRs?\\s*#?|/pull/)${n}(?!\\d)`, "i").test(text));
  const found = items.find((item) => cites([item.title, item.why, item.link, item.command, ...(item.steps ?? []).flatMap((step) => [step.text, step.link, step.command])].filter(Boolean).join("\n")));
  return found?.title ?? null;
}

const prList = (prs: readonly number[]) => prs.map((n) => `PR #${n}`).join(", ");
const hoursSince = (since: number, now: number) => Math.floor((now - since) / 3_600_000);

/** What each side hears for a step. */
export function stopTexts(session: CcSession, step: StopStep, now: number, owner = "o bot dono"): { bot: string; chief: string | null; chip: string | null } {
  const head = `Claude Code session "${session.title}" (${session.id})`;
  if (step.stage === "resume") {
    const bot = `[Sessão para retomar] ${head} — ${resumeLine(session, step.need, now)}.`;
    return { bot, chief: `${bot.replace(/Retome com cc_session_send \(session_id [^)]+\)/, `Cobre de ${owner} a retomada (cc_session_send na sessão ${session.id})`)} Ela é de ${owner}.`, chip: null };
  }
  if (step.stage === "escalate") {
    const open = `${prList(step.need.prs)} ${step.need.prs.length > 1 ? "abertas" : "aberta"}`;
    const bot = `[Sessão parada há ${hoursSince(step.since, now)} h] ${head} — sem progresso há ${hoursSince(step.since, now)} h com ${open}, ${step.need.why}.${step.resumed ? " O aviso de RETOMAR não a moveu." : ""} Não arquive: a PR está aberta. Reporte agora ao dono o bloqueio exato — o comando, a aprovação ou a decisão que falta — num item de "Precisa de você"; ou, se a PR não vale mais, feche-a e então arquive a sessão. Este é o último aviso sobre esta parada.`;
    return {
      bot,
      chief: `[Sessão parada há ${hoursSince(step.since, now)} h] ${head}, de ${owner} — sem progresso com ${open}, ${step.need.why}. Cobre de ${owner} o bloqueio exato para o dono (não arquivar: a PR está aberta).`,
      chip: `parada há ${hoursSince(step.since, now)} h com ${open} — o bot deve reportar ao dono o bloqueio exato`,
    };
  }
  const many = step.prs.length > 1;
  const prs = step.prs.length ? ` Its ${many ? "PRs" : "PR"} ${step.prs.map((n) => `#${n}`).join(", ")} ${many ? "are" : "is"} still open and this session cannot take ${many ? "them" : "it"}: start a new session for ${many ? "them" : "it"} (cc_session_start) before archiving this one.` : "";
  return {
    bot: `Claude Code session "${session.title}" (${session.id}) has been failed for over 24 h with nobody acting on it (${(session.lastError ?? "no error recorded").slice(0, 200)}). If its work is done elsewhere or no longer needed, archive it with cc_session_archive${session.turns === 0 ? " (it never ran a turn)" : ""}; if not, start a new session for the work.${prs} It no longer shows as an alert.`,
    chief: null,
    chip: step.prs.length ? `falhou há mais de 24 h sem ação — ${prList(step.prs)} sem sessão: abrir outra antes de arquivar` : "falhou há mais de 24 h sem ação — sugiro arquivar",
  };
}

/** Says the steps due now, oldest stop first, within the hourly budget. */
export async function climbStopLadder(deps: StopLadderDeps): Promise<Array<{ session: CcSession; stage: StopStep["stage"] }>> {
  const now = deps.now();
  const release = deps.release();
  const sessions = deps.ledger.all();
  const recent = sessions.filter((session) => [session.resumeReportedAt, session.stopEscalatedAt].some((at) => at !== undefined && at <= now && now - at < 3_600_000)).length;
  let budget = STOP_NOTICES_PER_HOUR - recent;
  const due = sessions.flatMap((session) => {
    const step = stopStep(session, now, release);
    return step ? [{ session, step }] : [];
  }).sort((a, b) => a.step.since - b.step.since);
  const said: Array<{ session: CcSession; stage: StopStep["stage"] }> = [];
  for (const { session, step: planned } of due) {
    if (budget <= 0) break;
    let step = planned;
    // the block is already with the owner: nothing to add on this stop, nor on the next while it is open
    if (step.stage !== "archive" && deps.ownerItem?.(session, step.need.prs)) continue;
    if (step.stage !== "archive" && deps.confirmOpen) {
      const open = await deps.confirmOpen(session, step.need.prs);
      if (open && !open.length) continue; // merged or closed meanwhile: nothing holds the line
      if (open) step = { ...step, need: { ...step.need, prs: step.need.prs.filter((n) => open.includes(n)) } };
      // re-read: the session may have moved while GitHub answered
      const again = stopStep(session, deps.now(), deps.release());
      if (!again || again.stage !== step.stage) continue;
    }
    const texts = stopTexts(session, step, now, deps.ownerName?.(session));
    if (step.stage === "resume") session.resumeReportedAt = now;
    else {
      session.stopEscalatedAt = now;
      if (session.status === "failed") session.failedAgingReportedAt = now;
    }
    deps.ledger.save();
    budget -= 1;
    deps.report(session, texts.bot);
    if (texts.chip) deps.chip(session, texts.chip, false);
    if (texts.chief) deps.chief?.(session, texts.chief);
    said.push({ session, stage: step.stage });
  }
  return said;
}
