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

/** `pmset -g batt`: "Now drawing from 'Battery Power'" and " -InternalBattery-0 (id=…)	53%; discharging; …". */
export function parsePmsetBatt(output: string): PowerState {
  const onBattery = /drawing from 'Battery Power'/i.test(output);
  const charge = /\b(\d{1,3})%/.exec(output);
  return { onBattery, percent: charge ? Math.min(100, Number(charge[1])) : null };
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

/** A message or brief that starts a release carrier. */
export function startsCarrier(text: string): boolean {
  return /release-carrier(?:\.sh)?\s+--execute|\b(?:rode|rodar|execute|executar|publique|publicar|inicie|iniciar|solte|soltar|run|start|publish)\b[^.?!\n]{0,40}\bcarrier\b/i.test(text);
}
