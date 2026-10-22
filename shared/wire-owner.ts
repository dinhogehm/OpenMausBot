// What the client sees of Claude Code sessions and of the items waiting on the person.

export interface WireCcAlert {
  sessionId: string;
  title: string;
  state: "failed" | "stalled" | "question";
  detail?: string;
}

/** A Claude Code session this conversation runs, for its row: where it runs and how it is. */
export interface WireCcSession {
  sessionId: string;
  title: string;
  status: "running" | "idle" | "stalled" | "failed" | "stopped";
  /** cli: headless, not visible in the Claude app. */
  surface: "app" | "cli";
  /** A step on the Claude app's screen waiting for the Mac (R8-dispatch D6):
   * what, since when, and what holds it ("locked" screen, Mac "inUse", the
   * app's "screen" not as expected, a "draft" in the field nobody sent, or
   * "queued" — not tried yet). */
  screenWait?: { kind: "create" | "send" | "rename" | "archive"; since: number; waitingFor: "locked" | "inUse" | "screen" | "draft" | "queued" };
  /** Failed or idle for 2 h+ with a PR of its own still open: someone must
   * resume it or say what blocks it (S-retomar). `why` is the bots' pt-BR;
   * a row says `kind` in the reader's language, with `detail` (the error or
   * the block, as recorded). */
  resume?: { since: number; prs: number[]; why: string; kind?: "failed" | "blocked" | "idle"; detail?: string;
    /** On hold, not to resume now: "parked" behind a release by the server,
     * or a "release" on its way on this Mac (the bots are not told meanwhile). */
    held?: "parked" | "release" };
}

/** One thing that waits on the person (owner_pending), for "Precisa de você". */
export interface WireOwnerPending {
  id: string;
  title: string;
  since: number;
  due?: string;
  link?: string;
  /** A command the person runs to act on it (copied with one click, never run). */
  command?: string;
  /** Why it matters, in one or two sentences. */
  why?: string;
  /** What to do, in order; a step may carry its exact command or a link. */
  steps?: Array<{ text: string; command?: string; link?: string }>;
  /** A choice: each option's label is a button, its reply what the bot receives. */
  options?: Array<{ label: string; reply: string; recommended?: true; why?: string }>;
  /** The person asked the bot for the steps, and the bot has not rewritten it yet. */
  stepsRequestedAt?: number;
  /** The person asked the bot which decision it recommends, and it has not answered with an update yet. */
  recommendRequestedAt?: number;
  /** What the person answered, in order (J18). */
  /** `queued`: waiting its turn in a busy conversation — neither delivered nor failed yet (INSP-J2 r2 N9). */
  history?: Array<{ at: number; kind: "option" | "text" | "ask"; label?: string; text: string; delivered: boolean; queued?: true; error?: string }>;
  /** The person's last answer reached the bot; it has not updated nor resolved the item since. */
  awaitingSince?: number;
  /** When the bot last rewrote it (owner_pending update). */
  updatedAt?: number;
  /** A routine's item said once and let go: under "Talvez já resolvido", out of the count and the chip. */
  demotedAt?: number;
  /** "Delegar a um agente" (lote del): the server would open a Claude Code session for it. */
  delegable?: true;
  /** Not delegable: why only the person can do it ("mexe no hook ou no revisor"). */
  onlyYou?: string;
  /** Delegated, while its session runs (or waits for a slot): out of the count. */
  delegation?: { at: number; state: "queued" | "running"; option?: string; sessionId?: string; sessionTitle?: string; link?: string };
  /** Back from a delegation (partial, stopped by the hook, never opened): on top, with why. */
  delegationBack?: { at: number; outcome: "parcial" | "barrado" | "falhou"; text: string; command?: string };
  /** Another item said this one's commands must not run (R13-intake #1): decisions and commands off, with by which ("o1 do Monitor"). */
  superseded?: { by: string; at: number; text: string };
  /** Its commands write a fixed sheet row and are older than 6 h: the row may have changed (what the server read, when it could). */
  rowWarning?: string;
}
