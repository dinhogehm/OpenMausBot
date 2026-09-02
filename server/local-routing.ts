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
