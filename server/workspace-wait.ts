// What a turn says while it waits for the project folder another turn is
// working in.
//
// The folder is held for a whole turn on purpose: two engines editing one
// checkout at the same time overwrite each other's edits and leave a
// half-applied change nobody asked for. But "someone else is in there right
// now" is a queue position, not a failure — the folder frees when that turn
// ends, usually in seconds. So this reads like the computer wait it is
// modelled on: name the holder, say it continues on its own, and keep the
// same words on the chip and in the give-up notice.

/** Who holds the folder: a bot and, when the holder is one of its threads,
 * that thread's title; or a room's name. */
export interface FolderHolder {
  name: string;
  task?: string;
}

/** Whole minutes, or seconds under one minute, for the give-up notice. */
const minutes = (ms: number): string => ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;

const holderPhrase = (holder: FolderHolder): string =>
  holder.task ? `${holder.name} is running ${holder.task}` : `${holder.name} is working there`;

/** The chip a turn shows while it is queued behind another turn's folder. */
export function folderWaitingText(holder?: FolderHolder | null): string {
  if (!holder) return "Waiting for its turn in this project folder. Starts automatically when it is free.";
  return `Waiting for its turn in this project folder — ${holderPhrase(holder)}. Starts automatically when that finishes.`;
}

/** The same chip once the wait landed and this turn holds the folder. */
export function folderFreeText(): string {
  return "Project folder free — continuing";
}

/** The same chip when the wait ended without the folder: the turn was
 * stopped, or the claim was abandoned. */
export function folderWaitEndedText(): string {
  return "Stopped waiting for the project folder";
}

/** The error after the wait ceiling: still names who holds it, and says
 * what a person can do — stop that turn, or move this one elsewhere. */
export function folderStillBusyText(holder: FolderHolder | null | undefined, ceilingMs: number): string {
  const who = holder ? ` — ${holderPhrase(holder).replace(" is running ", " is still running ").replace(" is working there", " is still working there")}` : "";
  return `Another thread is still working in this project folder after ${minutes(ceilingMs)}${who}. Stop that turn, or choose a separate folder.`;
}

/** Would queueing behind `blockerThreadId` wait on a turn that is itself
 * waiting on `ownThreadId`?
 *
 * Two bots sharing a folder deadlock the moment one asks the other
 * synchronously: the asker holds the folder until its turn ends, the
 * answerer waits for the folder, and neither moves until a timeout fires.
 * `waitingOn` maps a parked thread to the thread it is parked on, and this
 * walks the chain — A→B→C is caught as well as A→B — so the folder claim
 * can refuse immediately instead of queueing into a stall. */
export function folderWaitWouldDeadlock(
  blockerThreadId: string,
  ownThreadId: string,
  waitingOn: ReadonlyMap<string, string>,
): boolean {
  const seen = new Set<string>();
  let at: string | undefined = blockerThreadId;
  while (at && !seen.has(at)) {
    if (at === ownThreadId) return true;
    seen.add(at);
    at = waitingOn.get(at);
  }
  return false;
}
