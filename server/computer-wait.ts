// What a turn says while it waits for a computer another turn is using.
//
// The chip used to read "Waiting for computer — X / Y is using it; will
// continue automatically", which people read as an error about a machine
// they could not see. It is a queue position: this turn is behind one named
// turn on one desktop, and it starts on its own when that turn ends. Say
// that, name the holder as a bot running a thread, and keep the same words
// on every surface (chat chip, room chip, the gate's refusal) so a person
// who has read it once recognises it everywhere.
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
 * English unless a language is given (cloud-overflow's lines are English). */
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

/** The chip a turn shows while it is queued behind another turn's desktop. */
export function computerWaitingText(holder?: ComputerHolder | null, language?: string): string {
  if (isPortugueseLanguage(language)) {
    if (!holder) return "Aguardando a vez neste computador. Começa sozinho quando ele ficar livre.";
    return `Aguardando a vez neste computador — ${holderPhrase(holder, language)}. Começa sozinho quando isso terminar.`;
  }
  if (!holder) return "Waiting for its turn on this computer. Starts automatically when it is free.";
  return `Waiting for its turn on this computer — ${holderPhrase(holder, language)}. Starts automatically when that finishes.`;
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

/** The error after the wait ceiling: still names who holds it, and says
 * what a person can do — stop that turn, or move this one. */
export function computerStillBusyText(holder: ComputerHolder | null | undefined, ceilingMs: number, language?: string): string {
  if (isPortugueseLanguage(language)) {
    const who = holder ? ` — ${holderPhrase(holder, language).replace(" está rodando ", " ainda está rodando ").replace(" está usando ", " ainda está usando ")}` : "";
    return `O computador continua ocupado depois de ${minutes(ceilingMs, language)}${who}. Pare aquele turno ou rode este em outro computador.`;
  }
  const who = holder ? ` — ${holderPhrase(holder, language).replace(" is running ", " is still running ").replace(" is using it", " is still using it")}` : "";
  return `Computer is still busy after ${minutes(ceilingMs, language)}${who}. Stop that turn, or run this on another computer.`;
}
