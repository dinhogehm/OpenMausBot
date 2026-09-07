export function shouldMountLocalComputer({
  requested,
  hostPlatform = process.platform,
  providerSupportsLocal,
  unattended = false,
}: {
  requested: "cloud" | "local" | "off" | undefined;
  hostPlatform?: NodeJS.Platform;
  providerSupportsLocal: boolean;
  /** nobody started this turn: a webhook, a schedule, a workflow node */
  unattended?: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (requested === "local") return hostPlatform === "darwin" || hostPlatform === "linux";
  // Auto is a convenience for a person sitting at this Mac, not a decision
  // anyone made about a bot. A turn nobody started must not silently inherit
  // it: mounting the host tags EVERY approval in that turn as local-computer
  // scope, which no remembered grant may answer — so an unattended run would
  // not merely gain the desktop it never asked for, it would lose the narrow
  // grants it needs and stall on the first card with nobody there to click.
  if (unattended) return false;
  // Preserve the established macOS Auto behavior. Linux local control is a
  // beta and can only be selected explicitly per bot.
  return requested === undefined && hostPlatform === "darwin";
}

/** Whether a direct turn runs with nobody at the keyboard, for the Auto
 * fallback above — judged from the DISPATCH's own record first and the
 * bot's unattended mark second.
 *
 * The bot mark is a mutable per-bot flag: every dispatch rewrites it, a
 * person's message clears it, and it ages out after an idle half hour. A
 * live run showed a workflow node's third attempt — a re-dispatch after
 * two timeouts — opening every card with local-computer scope, which no
 * grant may answer unattended; whatever the bot mark said by then, the
 * dispatch itself had been told `unattended: true`. So the record that
 * cannot drift decides, and the mark can only ever add caution: a turn a
 * workflow, a webhook or a schedule started never lands on the desktop
 * because of what happened to that flag in the meantime. */
export function turnRunsUnattended(
  turn: { unattended?: boolean; automationSource?: string | undefined },
  botMarkedUnattended: boolean,
): boolean {
  return turn.unattended === true || turn.automationSource !== undefined || botMarkedUnattended;
}
