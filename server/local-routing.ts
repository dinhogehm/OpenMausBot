/** Hosts whose desktop the app can drive itself: macOS and Windows ship the
 * CUA driver and keep "This computer" selectable in the UI; Linux is a beta
 * behind an explicit per-bot choice. */
const HOSTS_WITH_LOCAL_CONTROL = new Set<NodeJS.Platform>(["darwin", "win32", "linux"]);
/** Hosts where Auto may land on the person's own desktop unasked. */
const HOSTS_WITH_AUTO_LOCAL = new Set<NodeJS.Platform>(["darwin", "win32"]);

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
  if (requested === "local") return HOSTS_WITH_LOCAL_CONTROL.has(hostPlatform);
  // Auto is a convenience for a person sitting at this Mac, not a decision
  // anyone made about a bot. A turn nobody started must not silently inherit
  // it: mounting the host tags EVERY approval in that turn as local-computer
  // scope, which no remembered grant may answer — so an unattended run would
  // not merely gain the desktop it never asked for, it would lose the narrow
  // grants it needs and stall on the first card with nobody there to click.
  if (unattended) return false;
  // Preserve the established macOS Auto behavior, which Windows shares.
  // Linux local control is a beta and can only be selected explicitly per bot.
  return requested === undefined && HOSTS_WITH_AUTO_LOCAL.has(hostPlatform);
}

