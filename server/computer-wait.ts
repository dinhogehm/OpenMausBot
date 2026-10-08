// What a turn says while it waits for a computer another turn is using.
//
// The chip used to read "Waiting for computer — X / Y is using it; will
// continue automatically", which people read as an error about a machine
// they could not see. It is a queue position: this turn sits behind a named
// turn on one desktop — and every turn queued ahead of it — and starts on
// its own when they finish. Say that, name the holder as a bot running a
// thread, and keep the same words on every surface (chat chip, room chip,
// the gate's refusal) so a person who has read it once recognises it everywhere.
//
// Chips are read by people, in the owner's language: Brazilian Portuguese
// by default, English when another language is picked in the app
// (R11/R12-followup #4: "Waiting for its turn…" reached the owner in English).

import { isPortugueseLanguage } from "./reply-language.ts";

/** Who holds the computer this turn is waiting for: a bot and, when the
 * holder is one of its threads, that thread's title; or a room's name. */
export interface ComputerHolder {
  name: string;
  task?: string;
}

/** Whole minutes, or seconds under one minute, singular at exactly one. */
const minutes = (ms: number, language?: string): string => {
  const value = ms >= 60_000 ? Math.round(ms / 60_000) : Math.round(ms / 1000);
  if (isPortugueseLanguage(language)) return `${value} ${ms >= 60_000 ? "minuto" : "segundo"}${value === 1 ? "" : "s"}`;
  const unit = ms >= 60_000 ? "minute" : "second";
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
};

/** How long a wait lasted, for the resolution line: waits under a second
 * are honest about being over in a blink instead of claiming "0 seconds".
 * English unless a language is given. */
export function computerWaitDuration(ms: number, language = "en"): string {
  return waitDuration(ms, language);
}

/** The same, in the owner's language when none is given (as the chips). */
const waitDuration = (ms: number, language?: string): string => {
  if (ms < 1_000) return isPortugueseLanguage(language) ? "menos de um segundo" : "under a second";
  return minutes(ms, language);
};

const holderPhrase = (holder: ComputerHolder, language?: string): string => {
  if (isPortugueseLanguage(language)) return holder.task ? `${holder.name} está rodando «${holder.task}»` : `${holder.name} está usando o computador`;
  return holder.task ? `${holder.name} is running ${holder.task}` : `${holder.name} is using it`;
};

/** Where this turn sits in the wait, and how long waits here have been
 * taking, as known when the chip was written (#1652). The estimate is
 * undefined until the resource has wait history; the chip then simply omits
 * it — an honest blank beats a made-up number. */
export interface WaitQueueFact {
  position?: number;
  estimateMs?: number;
}

const ordinal = (position: number): string => {
  const mod100 = position % 100;
  const mod10 = position % 10;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : mod10 === 1 ? "st" : mod10 === 2 ? "nd" : mod10 === 3 ? "rd" : "th";
  return `${position}${suffix}`;
};

/** The chip a turn shows while it is queued behind another turn's desktop:
 * its stable queue position, the holder, and — only once waits here have
 * history — about how long they have been taking. */
export function computerWaitingText(holder?: ComputerHolder | null, queue?: WaitQueueFact, language?: string): string {
  const position = queue?.position && queue.position > 0 ? queue.position : undefined;
  if (isPortugueseLanguage(language)) {
    const place = position ? ` — ${position}º na fila` : "";
    const estimate = queue?.estimateMs !== undefined ? `; as esperas recentes aqui levaram ${waitDuration(queue.estimateMs, language)}` : "";
    const starts = position && position > 1
      ? "Começa sozinho quando os turnos à frente terminarem"
      : holder
        ? "Começa sozinho quando isso terminar"
        : "Começa sozinho quando ele ficar livre";
    if (!holder) return `Aguardando a vez neste computador${place}. ${starts}${estimate}.`;
    return `Aguardando a vez neste computador${place} — ${holderPhrase(holder, language)}. ${starts}${estimate}.`;
  }
  const place = position ? ` — ${ordinal(position)} in queue` : "";
  const estimate = queue?.estimateMs !== undefined ? `; recent waits here have taken ${computerWaitDuration(queue.estimateMs)}` : "";
  // Behind more than the holder, that turn ending is not this turn's start:
  // the released seat goes to the front waiter first, so this turn starts
  // only once every turn ahead of it has finished (#1652).
  const starts = position && position > 1
    ? "Starts automatically when the turns ahead finish"
    : holder
      ? "Starts automatically when that finishes"
      : "Starts automatically when it is free";
  if (!holder) return `Waiting for its turn on this computer${place}. ${starts}${estimate}.`;
  return `Waiting for its turn on this computer${place} — ${holderPhrase(holder, language)}. ${starts}${estimate}.`;
}

/** The resolution appended once the wait landed and this turn holds the
 * desktop: how long it waited, and who held it. The waiting chip stays as
 * written — this line is the history beside it, not its replacement. */
export function computerFreeAfterText(holder: ComputerHolder | null | undefined, waitedMs: number, language?: string): string {
  const held = holder ? (holder.task ? `${holder.name} · ${holder.task}` : holder.name) : "";
  if (isPortugueseLanguage(language)) return `Computador livre — seguindo depois de esperar ${waitDuration(waitedMs, language)}${held ? ` (estava com ${held})` : ""}`;
  return `Computer free — continuing after waiting ${waitDuration(waitedMs, language)}${held ? ` (${held} held it)` : ""}`;
}

/** The resolution appended when the wait ended because the turn was stopped
 * or its claim was cancelled. */
export function computerStoppedWaitingText(holder: ComputerHolder | null | undefined, waitedMs: number, language?: string): string {
  const who = holder ? ` — ${holderPhrase(holder, language)}` : "";
  if (isPortugueseLanguage(language)) return `Parou de esperar pelo computador depois de ${waitDuration(waitedMs, language)}${who}.`;
  return `Stopped waiting for the computer after ${waitDuration(waitedMs, language)}${who}.`;
}

/** The resolution appended when the wait ceiling parks the turn (#1651):
 * still names who holds it, but the work is not lost — the turn settled and
 * resumes on its own when the desktop frees, so nobody has to fix it. */
export function computerParkedText(holder: ComputerHolder | null | undefined, ceilingMs: number, language?: string): string {
  if (isPortugueseLanguage(language)) {
    const who = holder ? ` — ${holderPhrase(holder, language).replace(" está rodando ", " ainda está rodando ").replace(" está usando ", " ainda está usando ")}` : "";
    return `O computador continua ocupado depois de ${minutes(ceilingMs, language)}${who}. Em espera — continua sozinho quando o computador ficar livre.`;
  }
  const who = holder ? ` — ${holderPhrase(holder, language).replace(" is running ", " is still running ").replace(" is using it", " is still using it")}` : "";
  return `Computer still busy after ${minutes(ceilingMs, language)}${who}. Parked — it continues automatically when the computer is free.`;
}
