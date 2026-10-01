// The Mac runs releases and gates on battery too: on 01/10 it fell to 24%
// with a production release running, and the app kept it awake until the
// battery would have died mid-deploy (R8-resilience BAT). The server reads
// `pmset -g batt` and tells the Chief (and the person, in "Precisa de
// você") when the Mac has been on battery for a while or is running low,
// and it does not start a release carrier on battery.

export interface PowerState {
  onBattery: boolean;
  /** Charge, 0–100; null when there is no battery (a desktop Mac). */
  percent: number | null;
}

/** `pmset -g batt`: "Now drawing from 'Battery Power'" and " -InternalBattery-0 (id=…)	53%; discharging; …".
 * A no-break (UPS) counts as battery: "drawing from 'UPS Power'" means the
 * wall is out, on a desktop Mac too. With a UPS line and the Mac's own
 * battery, the charge is the Mac's (-InternalBattery-), not the UPS's. */
export function parsePmsetBatt(output: string): PowerState {
  const onBattery = /drawing from '(?:Battery|UPS) Power'/i.test(output);
  const internal = /^\s*-InternalBattery-[^\n]*?\b(\d{1,3})%/m.exec(output);
  const charge = internal ?? /\b(\d{1,3})%/.exec(output);
  return { onBattery, percent: charge ? Math.min(100, Number(charge[1])) : null };
}

// A release process, told by its executable and script, never by free text:
// a `claude -p` carries its whole prompt in argv, and on 01/10 one said
// "… depois ./scripts/release-carrier.sh --check e PARE" with no release
// running (INSP-G r1 G1-a; the same anchoring as release-priority in lot R).
const RELEASE_SCRIPT = String.raw`\S*(?:scripts/(?:\S+/)?(?:local-release|release-carrier|release-production)|watch-production-release)[\w.-]*`;
/** The script run directly (`/x/scripts/local-release.sh …`). */
const RELEASE_DIRECT = new RegExp(`^${RELEASE_SCRIPT}(?:\\s|$)`);
/** The script run by a shell or node (`bash ./scripts/release-carrier.sh --execute`, `/bin/bash -e scripts/macos/release-production.sh`). */
const RELEASE_VIA = new RegExp(`^(?:\\S*/)?(?:(?:ba|z|da)?sh|node)(?:\\s+-\\S+)*\\s+${RELEASE_SCRIPT}(?:\\s|$)`);
/** `npm run release:local` (the title npm sets). */
const RELEASE_NPM = /^(?:\S*\/)?npm(?:\s+-\S+)*\s+run(?:-script)?\s+release(?::\S*)?(?:\s|$)/;
/** Claude Code: `claude …`, or node running its entry point. */
const CLAUDE = /^(?:\S*\/)?claude(?:\s|$)|^(?:\S*\/)?node\s+\S*(?:\/@anthropic-ai\/claude-code\/|\/claude(?:\s|$))/;

/** A process of a production release (or of a carrier), from `ps -o command`. */
export function isReleaseProcess(command: string): boolean {
  const cmd = command.trim();
  if (CLAUDE.test(cmd)) return false;
  return RELEASE_DIRECT.test(cmd) || RELEASE_VIA.test(cmd) || RELEASE_NPM.test(cmd);
}

/** On battery this long, or below LOW_PERCENT, the Chief hears it. */
export const ON_BATTERY_ALERT_MS = 20 * 60_000;
export const LOW_PERCENT = 30;
/** Below this, with a release or a gate running, the advice is to stop. */
export const CRITICAL_PERCENT = 15;

/** What to tell, once per level of a discharge ("battery", "low", "critical"), or null. */
export function batteryAlert(input: { power: PowerState; onBatterySince: number | null; now: number; releaseRunning: boolean; told: ReadonlySet<string> }): { level: string; text: string } | null {
  const { power } = input;
  if (!power.onBattery) return null;
  const percent = power.percent ?? 100;
  const long = input.onBatterySince !== null && input.now - input.onBatterySince >= ON_BATTERY_ALERT_MS;
  const running = input.releaseRunning ? ", com release de produção em curso" : "";
  const charge = power.percent === null ? "" : ` (${power.percent}%)`;
  if (percent < CRITICAL_PERCENT && !input.told.has("critical")) {
    return { level: "critical", text: `O Mac está na bateria e quase sem carga${charge}${running}. Se ele desligar no meio de um deploy, a produção fica pela metade: ligue na tomada já, ou peça PARAR antes de começar outro carrier.` };
  }
  if (percent < LOW_PERCENT && !input.told.has("low")) {
    return { level: "low", text: `O Mac está na bateria com carga baixa${charge}${running}. Ligue na tomada; nenhum carrier novo começa na bateria.` };
  }
  if (long && !input.told.has("battery")) {
    return { level: "battery", text: `O Mac está na bateria há ${Math.round((input.now - input.onBatterySince!) / 60_000)} min${charge}${running}. Ligue na tomada; nenhum carrier novo começa na bateria.` };
  }
  return null;
}

/** What the server remembers of the current discharge (kept on disk, so a
 * restart on battery neither repeats a level nor restarts the 20 min). */
export interface PowerWatchState {
  onBatterySince: number | null;
  told: string[];
}
export const POWER_PENDING_KEY = "power:battery";
export const emptyPowerWatch = (): PowerWatchState => ({ onBatterySince: null, told: [] });

/** A saved PowerWatchState, or an empty one when it is missing or unreadable. */
export function readPowerWatch(json: string | null): PowerWatchState {
  try {
    const value = JSON.parse(json ?? "") as Partial<PowerWatchState>;
    return {
      onBatterySince: typeof value.onBatterySince === "number" ? value.onBatterySince : null,
      told: Array.isArray(value.told) ? value.told.filter((level): level is string => typeof level === "string") : [],
    };
  } catch {
    return emptyPowerWatch();
  }
}

/** One reading of `pmset`: the next state, whether the "Ligue o Mac na
 * tomada" item must be resolved, and the alert to give, if any. On AC the
 * item is always resolved — after a restart the memory of the discharge may
 * be gone while the item, saved, is still there (INSP-G r1 G1-b). */
export function powerStep(watch: PowerWatchState, power: PowerState, now: number, releaseRunning: boolean): {
  watch: PowerWatchState;
  changed: boolean;
  resolvePending: boolean;
  alert: { level: string; text: string; log: string; pendingTitle: string } | null;
} {
  if (!power.onBattery) {
    const changed = watch.onBatterySince !== null || watch.told.length > 0;
    return { watch: emptyPowerWatch(), changed, resolvePending: true, alert: null };
  }
  const onBatterySince = watch.onBatterySince ?? now;
  const found = batteryAlert({ power, onBatterySince, now, releaseRunning, told: new Set(watch.told) });
  const next = { onBatterySince, told: found ? [...watch.told, found.level] : watch.told };
  const changed = watch.onBatterySince !== onBatterySince || next.told.length !== watch.told.length;
  if (!found) return { watch: next, changed, resolvePending: false, alert: null };
  const pendingTitle = `Ligue o Mac na tomada${power.percent !== null ? ` (${power.percent}%)` : ""}${releaseRunning ? " — release em curso" : ""}`;
  return { watch: next, changed, resolvePending: false, alert: { ...found, log: `[power] ${found.text}`, pendingTitle } };
}

/** A message or brief that starts a release carrier. */
export function startsCarrier(text: string): boolean {
  return /release-carrier(?:\.sh)?\s+--execute|\b(?:rode|rodar|execute|executar|publique|publicar|inicie|iniciar|solte|soltar|run|start|publish)\b[^.?!\n]{0,40}\bcarrier\b/i.test(text);
}
